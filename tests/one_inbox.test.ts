import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchSender, classify, unwrapForward, suggestReply, parseRoster, subjectKey, phonesIn,
  type Contact, type MailIn,
} from '../src/modules/m23_oneinbox/engine.ts';
import {
  ingest, contacts, replaceRoster, fileTo, purge, counts, message, inboxAddress, resolveInboxAddress,
} from '../src/modules/m23_oneinbox/service.ts';
import { SAMPLE_ROSTER, SAMPLE_MAIL } from '../src/modules/m23_oneinbox/sample.ts';
import { toCsv } from '../src/lib/csv.ts';
import { q1 } from '../src/lib/db.ts';
import { fixtureTwoOrgs, startTestServer, loginAs, get, post } from './harness.ts';

/** One Inbox files an email to a person automatically only on strong
 * evidence. The failure that matters is a WRONG filing — it puts one
 * household's business in front of another and drafts a reply to the wrong
 * person — so most of this file is about what must NOT match. */

const C = (id: string, name: string, over: Partial<Contact> = {}): Contact => ({
  id, name, emails: [], phones: [], property: 'Oakwood Terrace', unit: '1', kind: 'tenant', ...over,
});
const M = (over: Partial<MailIn>): MailIn => ({ fromEmail: 'x@example.net', fromName: '', to: [], subject: '', text: '', ...over });

const LIST: Contact[] = [
  C('denise', 'Denise Harper', { emails: ['denise@example.com'], phones: ['2025550101'] }),
  C('tanya', 'Tanya Brooks', { unit: '3', phones: ['2025550103'] }),
  C('james1', 'James Brown', { property: 'Hillcrest Four', unit: '2', emails: ['jb@example.com'] }),
  C('james2', 'James Brown', { property: 'Riverside Commons', unit: '204' }),
  C('cw-a', 'P. Okafor', { kind: 'agency', emails: ['po@agency.example.org'], unit: '3' }),
  C('cw-b', 'P. Okafor', { kind: 'agency', emails: ['po@agency.example.org'], property: 'Riverside Commons', unit: '102' }),
  C('house', 'Gloria Nash', { property: 'Sycamore House', unit: 'Main' }),
];

// ---------- matching ----------

test('a known address files itself', () => {
  const r = matchSender(M({ fromEmail: 'denise@example.com' }), LIST);
  assert.equal(r.status, 'matched');
  assert.equal(r.contactId, 'denise');
});

test('an unknown address is never filed on nothing', () => {
  const r = matchSender(M({ subject: 'water', text: 'water is coming through my ceiling' }), LIST);
  assert.equal(r.status, 'unsorted');
  assert.equal(r.contactId, null);
});

test('a new address that gives its phone number, or its property and unit, is filed', () => {
  assert.equal(matchSender(M({ text: 'Call me at (202) 555-0103 please' }), LIST).contactId, 'tanya');
  assert.equal(matchSender(M({ text: 'This is unit 3 at Oakwood Terrace, no heat' }), LIST).contactId, 'tanya');
});

test('property alone is a suggestion, not a filing — except a single-family house', () => {
  const r = matchSender(M({ text: 'I live at Oakwood Terrace and the hallway light is out' }), LIST);
  assert.equal(r.status, 'ambiguous');
  assert.equal(matchSender(M({ text: 'The gutter at Sycamore House is hanging off' }), LIST).contactId, 'house');
});

test('unit numbers match whole labels only: unit 20 is not unit 204', () => {
  const r = matchSender(M({ text: 'Riverside Commons unit 20 has a leak' }), LIST);
  assert.notEqual(r.contactId, 'james2');
  assert.equal(matchSender(M({ text: 'Riverside Commons unit 204 has a leak' }), LIST).contactId, 'james2');
});

test('a name mentioned in the body never files the email to that person', () => {
  const r = matchSender(M({ fromName: 'Keisha', text: 'My neighbor Denise Harper is very loud at night.' }), LIST);
  assert.notEqual(r.status, 'matched');
  assert.deepEqual(r.candidates, ['denise']); // offered, for a human to accept or not
});

test('a display name files only when one person on the list has it', () => {
  assert.equal(matchSender(M({ fromName: 'Denise Harper' }), LIST).contactId, 'denise');
  const twins = matchSender(M({ fromName: 'James Brown', text: 'my dishwasher is broken' }), LIST);
  assert.equal(twins.status, 'ambiguous');
  assert.deepEqual([...twins.candidates].sort(), ['james1', 'james2']);
});

test('one address on file for several households asks, unless the email says which', () => {
  const vague = matchSender(M({ fromEmail: 'po@agency.example.org', text: 'Can you send the ledger for my client?' }), LIST);
  assert.equal(vague.status, 'ambiguous');
  assert.deepEqual([...vague.candidates].sort(), ['cw-a', 'cw-b']);
  const named = matchSender(M({ fromEmail: 'po@agency.example.org', text: 'Re-inspection for Riverside Commons, Unit 102 is Thursday.' }), LIST);
  assert.equal(named.contactId, 'cw-b');
});

test('an earlier thread is only ever a suggestion', () => {
  const r = matchSender(M({ subject: 'Re: Leak', text: 'still leaking' }), LIST, 'denise');
  assert.equal(r.status, 'ambiguous');
  assert.deepEqual(r.candidates, ['denise']);
});

// ---------- forwards, sorting, replies ----------

test('a manual forward is matched to the original sender, not the employee', () => {
  const { mail, forwardedBy } = unwrapForward(M({
    fromEmail: 'frontdesk@pm.example.com', subject: 'Fwd: Late fee',
    text: 'FYI\n\n---------- Forwarded message ---------\nFrom: Denise Harper <denise@example.com>\nSubject: Late fee\nTo: leasing@pm.example.com\n\nPlease remove the late fee.',
  }));
  assert.equal(mail.fromEmail, 'denise@example.com');
  assert.equal(mail.fromName, 'Denise Harper');
  assert.equal(mail.subject, 'Late fee');
  assert.equal(mail.text, 'Please remove the late fee.');
  assert.equal(forwardedBy, 'frontdesk@pm.example.com');
  // not a forward: untouched
  const plain = M({ subject: 'Late fee', text: 'From: nobody <a@b.co>\n\nhello' });
  assert.equal(unwrapForward(plain).mail, plain);
});

test('sorting: kind by best fit, urgency by danger words, mailbox as a last hint', () => {
  assert.deepEqual(classify(M({ subject: 'no heat', text: 'There is no heat' }), 'tenant'), { category: 'repair', urgency: 'urgent' });
  assert.deepEqual(classify(M({ text: 'I paid my rent but see a late fee on my balance' }), 'tenant'), { category: 'payment', urgency: 'normal' });
  assert.equal(classify(M({ text: 'I have a voucher. Is the 3 bedroom available for a tour?' }), null).category, 'leasing');
  assert.equal(classify(M({ text: 'hello' }), 'agency').category, 'agency');
  assert.equal(classify(M({ text: 'The unit failed inspection and payments will be abated.' }), 'agency').urgency, 'urgent');
  assert.equal(classify(M({ text: 'hello there', to: ['maintenance@pm.example.com'] }), null).category, 'repair');
  assert.equal(classify(M({ text: 'hello there' }), null).category, 'other');
});

test('no reply is suggested for an unidentified sender; replies promise a response, not an outcome', () => {
  assert.equal(suggestReply('repair', 'urgent', null), null);
  const r = suggestReply('repair', 'urgent', LIST[0]!)!;
  assert.match(r, /^Hi Denise,/);
  assert.match(r, /911/);
  assert.match(r, /Oakwood Terrace, Unit 1/);
  for (const cat of ['repair', 'payment', 'agency', 'owner', 'leasing', 'other'] as const) {
    assert.doesNotMatch(suggestReply(cat, 'normal', LIST[0]!)!, /waive|will be fixed by|you owe|\$\d/i);
  }
});

test('helpers: phones, subject keys', () => {
  assert.deepEqual(phonesIn('call 202.555.0103 or +1 (202) 555-0104, not 12025550105999'), ['2025550103', '2025550104']);
  assert.equal(subjectKey('RE: Fwd: re:  Leak in   kitchen '), 'leak in kitchen');
});

test('contact list: title rows, "Last, First", several emails, vacant rows, section rows', () => {
  const p = parseRoster([
    ['Tenant Directory'], ['As of 11/01/2026'], [],
    ['Unit', 'Tenant', 'Emails', 'Phone Numbers', 'Status'],
    ['-> Oakwood Terrace'],
    ['1', 'Harper, Denise', 'denise@example.com; D.Harper@Work.example.com', 'Mobile: (202) 555-0101', 'Current'],
    ['2', 'VACANT', '', '', ''],
    ['-> Hillcrest Four'],
    ['1', 'Keisha Grant', '', '202-555-0105 / 202-555-0199', 'Current'],
    ['Total', '2'],
  ]);
  assert.equal(p.rowsRead, 2);
  assert.deepEqual(p.rows[0], { name: 'Denise Harper', emails: ['denise@example.com', 'd.harper@work.example.com'], phones: ['2025550101'], property: 'Oakwood Terrace', unit: '1', kind: 'tenant' });
  assert.deepEqual(p.rows[1]!.phones, ['2025550105', '2025550199']);
  assert.equal(p.rows[1]!.property, 'Hillcrest Four');
  assert.equal(parseRoster([['Owner', 'Distribution'], ['A', '1']]).rows.length, 0);
});

// ---------- storage + screens ----------

let base = '';
let close: () => void = () => {};
let cookieA = '';
let cookieB = '';
let fx: ReturnType<typeof fixtureTwoOrgs>;
const ctxA = (): any => ({ orgId: fx.orgA, userId: fx.userAId, userName: 'Tester' });

before(async () => {
  fx = fixtureTwoOrgs();
  const s = await startTestServer();
  base = s.base;
  close = s.close;
  cookieA = await loginAs(base, fx.adminA);
  cookieB = await loginAs(base, fx.adminB);
});
after(() => close());

test('the sample lands in the right piles', async () => {
  const r = await post(base, '/one-inbox/sample', {}, cookieA);
  assert.ok(r.status === 302 || r.status === 303, `status ${r.status}`);
  const orgA = fx.orgA;
  const by = (subject: string): any => q1<any>('SELECT * FROM oi_messages WHERE org_id=? AND subject=?', orgA, subject);
  const nameOf = (m: any): string | null => (m.contact_id ? contacts(orgA).find((c) => c.id === m.contact_id)!.name : null);

  assert.equal(nameOf(by('Kitchen sink leaking')), 'Denise Harper');
  const heat = by('no heat');
  assert.equal(nameOf(heat), 'Tanya Brooks');
  assert.equal(heat.urgency, 'urgent');
  const fee = by('Late fee question'); // arrived as a staff forward
  assert.equal(nameOf(fee), 'Marcus Bell');
  assert.equal(fee.category, 'payment');
  assert.equal(fee.forwarded_by, 'frontdesk@sample-pm.example.com');
  const insp = by('Re-inspection scheduled: Riverside Commons Unit 102');
  assert.equal(insp.match_status, 'matched');
  assert.equal(insp.category, 'agency');
  assert.equal(insp.urgency, 'urgent');
  assert.equal(by('Quick question').match_status, 'ambiguous');
  assert.equal(by('Quick question').category, 'agency', 'unsure which household, sure it is an agency');
  assert.equal(by('Noise from upstairs').category, 'other', 'a conduct complaint is not a repair');
  assert.equal(by('Dishwasher broken').match_status, 'ambiguous');
  assert.equal(nameOf(by('Noise from upstairs')), 'Keisha Grant'); // not the neighbor she names
  const water = by('water');
  assert.equal(water.match_status, 'unsorted');
  assert.equal(water.urgency, 'urgent');
  assert.equal(by('Is the 3 bedroom still available?').category, 'leasing');
  assert.equal(counts(orgA).open, SAMPLE_MAIL.length);
});

test('screens: list, message, setup; an unidentified sender gets no draft', async () => {
  const list = await get(base, '/one-inbox?view=needs_filing', cookieA);
  assert.equal(list.status, 200);
  assert.match(list.text, /Quick question/);
  assert.doesNotMatch(list.text, /Kitchen sink leaking/);
  const water = q1<any>(`SELECT id FROM oi_messages WHERE subject='water' AND org_id=?`, fx.orgA)!.id;
  const page = await get(base, `/one-inbox/m/${water}`, cookieA);
  assert.match(page.text, /No reply is suggested until this email is filed/);
  const sink = q1<any>(`SELECT id FROM oi_messages WHERE subject='Kitchen sink leaking' AND org_id=?`, fx.orgA)!.id;
  assert.match((await get(base, `/one-inbox/m/${sink}`, cookieA)).text, /Hi Denise,/);
  assert.match((await get(base, '/one-inbox/setup', cookieA)).text, /inbox-[a-f0-9]{10}@/);
  assert.notEqual((await get(base, '/one-inbox', '')).status, 200);
});

test('another org cannot see or act on this org’s mail', async () => {
  const sink = q1<any>(`SELECT id FROM oi_messages WHERE subject='Kitchen sink leaking' AND org_id=?`, fx.orgA)!.id;
  assert.equal((await get(base, `/one-inbox/m/${sink}`, cookieB)).status, 404);
  assert.equal((await post(base, `/one-inbox/m/${sink}/done`, {}, cookieB)).status, 404);
  assert.doesNotMatch((await get(base, '/one-inbox?view=open', cookieB)).text, /Kitchen sink leaking/);
  assert.equal(q1<any>('SELECT status FROM oi_messages WHERE id=?', sink)!.status, 'open');
});

test('filing teaches the address: later mail from it files itself, and waiting mail is swept up', () => {
  const orgA = fx.orgA;
  const ctx = ctxA();
  const first = ingest(orgA, M({ fromEmail: 'newaddr@example.net', subject: 'hello', text: 'first one' }), { via: 'manual' });
  const second = ingest(orgA, M({ fromEmail: 'newaddr@example.net', subject: 'again', text: 'second one' }), { via: 'manual' });
  assert.equal(first.status, 'unsorted');
  const andre = contacts(orgA).find((c) => c.name === 'Andre Simmons')!;
  assert.ok(fileTo(ctx, first.id, andre.id, true));
  assert.equal(message(orgA, second.id)!.contact_id, andre.id, 'the waiting email from the same address is filed too');
  const third = ingest(orgA, M({ fromEmail: 'newaddr@example.net', subject: 'third', text: 'third one' }), { via: 'manual' });
  assert.equal(third.status, 'matched');
  // identical mail delivered twice (a provider retry) is one message
  assert.equal(ingest(orgA, M({ fromEmail: 'newaddr@example.net', subject: 'third', text: 'third one' }), { via: 'manual' }).duplicate, true);
});

test('re-uploading the list keeps learned addresses and filings; removed people unfile', () => {
  const orgA = fx.orgA;
  const ctx = ctxA();
  const andreBefore = contacts(orgA).find((c) => c.name === 'Andre Simmons')!;
  const sink = q1<any>(`SELECT id, contact_id FROM oi_messages WHERE org_id=? AND subject='Kitchen sink leaking'`, orgA)!;
  replaceRoster(ctx, SAMPLE_ROSTER.filter((r) => r.name !== 'Denise Harper'), { sample: true });
  const andreAfter = contacts(orgA).find((c) => c.name === 'Andre Simmons')!;
  assert.equal(andreAfter.id, andreBefore.id);
  assert.ok(andreAfter.emails.includes('newaddr@example.net'));
  const sinkAfter = message(orgA, sink.id)!;
  assert.equal(sinkAfter.contact_id, null);
  assert.equal(sinkAfter.match_status, 'unsorted');
});

test('the forwarding address resolves only to its own org; purge removes everything but the address', () => {
  const orgA = fx.orgA;
  const addr = inboxAddress(orgA);
  assert.equal(resolveInboxAddress(addr), orgA);
  assert.equal(resolveInboxAddress('inbox-0000000000@in.stayleased.com'), null);
  assert.equal(resolveInboxAddress('leads-x-abcdef@in.stayleased.com'), null);
  const ctx = ctxA();
  purge(ctx, 'all');
  assert.deepEqual({ ...counts(orgA) }, { needsFiling: 0, urgent: 0, open: 0, done: 0, contacts: 0, sample: 0 });
  assert.equal(inboxAddress(orgA), addr);
});

test('uploading a real list through the form; deleting everything needs the typed confirmation', async () => {
  const csv = toCsv(['Property', 'Unit', 'Tenant', 'Email', 'Phone'], [['Elm Court', '5', 'Rosa Diaz', 'rosa@example.com', '202-555-0177']]);
  const fd = new FormData();
  fd.append('roster', new Blob([csv], { type: 'text/csv' }), 'directory.csv');
  const up = await fetch(`${base}/one-inbox/roster`, { method: 'POST', body: fd, headers: { cookie: cookieA, origin: base }, redirect: 'manual' });
  assert.ok(up.status === 302 || up.status === 303);
  const orgA = fx.orgA;
  assert.equal(contacts(orgA).length, 1);
  await post(base, '/one-inbox/purge', { scope: 'all', confirm: 'yes' }, cookieA);
  assert.equal(contacts(orgA).length, 1, 'wrong confirmation deletes nothing');
  await post(base, '/one-inbox/purge', { scope: 'all', confirm: 'DELETE' }, cookieA);
  assert.equal(contacts(orgA).length, 0);
});

test('forwarded mail arrives through the inbound webhook: token-gated, loop-guarded, to the right org', async () => {
  process.env.STAYLEASED_INBOUND_TOKEN = 'test-inbound-token';
  const addr = inboxAddress(fx.orgB);
  const send = (token: string, body: Record<string, unknown>): Promise<Response> =>
    fetch(`${base}/hooks/inbound-email?token=${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const mail = { From: 'tenant@example.net', FromName: 'Pat Lee', To: `maintenance@pm.example.com, ${addr}`, Subject: 'Stove', TextBody: 'My stove burner will not light.' };

  assert.equal((await send('wrong', mail)).status, 403);
  const ok = await (await send('test-inbound-token', mail)).json() as any;
  assert.equal(ok.ok, true);
  const row = q1<any>('SELECT * FROM oi_messages WHERE id=?', ok.id)!;
  assert.equal(row.org_id, fx.orgB);
  assert.equal(row.via, 'forward');
  assert.equal(row.mailbox, 'maintenance@pm.example.com');
  assert.equal(row.category, 'repair');
  assert.ok(q1<any>('SELECT last_received_at FROM oi_config WHERE org_id=?', fx.orgB)!.last_received_at);
  // an out-of-office never becomes a message; an unknown address claims nothing
  const ooo = await (await send('test-inbound-token', { ...mail, Subject: 'Automatic reply: Stove' })).json() as any;
  assert.equal(ooo.ok, false);
  assert.equal((await send('test-inbound-token', { ...mail, To: 'inbox-0000000000@in.stayleased.com' })).status, 404);
  delete process.env.STAYLEASED_INBOUND_TOKEN;
});
