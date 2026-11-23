import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fmtAge } from '../src/lib/dates.ts';
import { q1 } from '../src/lib/db.ts';
import {
  ingest, contacts, contact, purge, message, listMessages, neighbors, nextInView, businessDaysSince, addContact, fileTo, PAGE_SIZE,
  type ListFilter,
} from '../src/modules/m23_oneinbox/service.ts';
import { SAMPLE_MAIL } from '../src/modules/m23_oneinbox/sample.ts';
import { fixtureTwoOrgs, startTestServer, loginAs, get, post } from './harness.ts';

/** The One Inbox triage loop: open an email, say who it is from, answer, mark
 * it done, land on the next one — in the view the person was working in, and
 * with a way back. Plus finding things (search, filters, paging) and the
 * People page. Every screen is checked from a second organization too. */

let base = '';
let close: () => void = () => {};
let cookieA = '';
let cookieB = '';
let fx: ReturnType<typeof fixtureTwoOrgs>;
const ctxOf = (org: string, uid: string): any => ({ orgId: org, userId: uid, userName: 'Tester' });
const F = (over: Partial<ListFilter> = {}): ListFilter => ({ view: 'open', q: '', property: '', category: '', person: '', ...over });
const bySubject = (subject: string): string => q1<any>('SELECT id FROM oi_messages WHERE org_id=? AND subject=?', fx.orgA, subject)!.id;
const moved = (r: { status: number }): boolean => r.status === 302 || r.status === 303;

before(async () => {
  fx = fixtureTwoOrgs();
  // other suites share these two organizations: start from nothing
  purge(ctxOf(fx.orgA, fx.userAId), 'all');
  purge(ctxOf(fx.orgB, fx.userBId), 'all');
  const s = await startTestServer();
  base = s.base;
  close = s.close;
  cookieA = await loginAs(base, fx.adminA);
  cookieB = await loginAs(base, fx.adminB);
});
after(() => close());

// ---------- helpers ----------

test('relative age: minutes, hours, Yesterday, then the date; the future is a date', () => {
  const now = new Date('2026-11-22T20:00:00Z'); // 3:00 PM in New York
  const tz = 'America/New_York';
  const ago = (min: number): string => new Date(now.getTime() - min * 60_000).toISOString();
  assert.equal(fmtAge(ago(0), now, tz), 'Just now');
  assert.equal(fmtAge(ago(20), now, tz), '20 min');
  assert.equal(fmtAge(ago(59), now, tz), '59 min');
  assert.equal(fmtAge(ago(60), now, tz), '1 h');
  assert.equal(fmtAge(ago(5 * 60), now, tz), '5 h');
  assert.equal(fmtAge(ago(20 * 60), now, tz), 'Yesterday'); // 7 PM the day before
  assert.equal(fmtAge('2026-11-22T03:30:00Z', new Date('2026-11-22T06:00:00Z'), tz), '2 h', 'late last night, read after midnight');
  assert.equal(fmtAge('2026-11-18T15:00:00Z', now, tz), 'Nov 18');
  assert.equal(fmtAge('2025-12-30T15:00:00Z', now, tz), 'Dec 30, 2025');
  assert.equal(fmtAge('2026-11-25T15:00:00Z', now, tz), 'Nov 25');
  assert.equal(fmtAge(null, now, tz), '—');
  assert.equal(fmtAge('not a date', now, tz), '—');
});

test('the quiet-mailbox warning counts business days: a weekend is not an outage', () => {
  // Friday evening to Monday morning is one business day
  assert.equal(businessDaysSince('2026-11-20T23:00:00Z', new Date('2026-11-23T14:00:00Z')), 1);
  assert.equal(businessDaysSince('2026-11-20T23:00:00Z', new Date('2026-11-22T14:00:00Z')), 0);
  // Thursday to the following Tuesday is three: that one is worth a warning
  assert.equal(businessDaysSince('2026-11-19T15:00:00Z', new Date('2026-11-24T15:00:00Z')), 3);
  assert.equal(businessDaysSince('2026-11-24T15:00:00Z', new Date('2026-11-23T15:00:00Z')), 0);
});

// ---------- first run, sample ----------

test('first run explains the three steps and offers both ways in; the sample is dated on the organization’s clock', async () => {
  const empty = await get(base, '/one-inbox', cookieA);
  assert.match(empty.text, /How One Inbox works/);
  assert.match(empty.text, /Upload your resident list/);
  assert.match(empty.text, /Set up One Inbox/);
  assert.match(empty.text, /<form method="post" action="\/one-inbox\/sample">/);
  assert.doesNotMatch(empty.text, /tenant list|Tenant directory/i);
  assert.doesNotMatch((await get(base, '/one-inbox/setup', cookieA)).text, /tenant list|Tenant directory/i);

  assert.ok(moved(await post(base, '/one-inbox/sample', {}, cookieA)));
  const all = listMessages(fx.orgA, F()).rows;
  assert.equal(all.length, SAMPLE_MAIL.length);
  // dated on the organization's own clock (other suites share this
  // organization and may have moved its date), never on today's
  const bd = String(q1<any>('SELECT business_date FROM orgs WHERE id=?', fx.orgA).business_date);
  const dayBefore = new Date(new Date(`${bd}T12:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
  for (const m of all) assert.ok(m.received_at.startsWith(bd) || m.received_at.startsWith(dayBefore), `${m.received_at} is not on ${bd}`);

  const list = await get(base, '/one-inbox', cookieA);
  assert.match(list.text, /Who is this\?/);
  assert.match(list.text, /Unknown sender/);
  assert.match(list.text, /2 possible people/);
  assert.match(list.text, /<time datetime="[^"]+" title="[^"]+">20 min<\/time>/);
  assert.match(list.text, /<ul class="oi-list">/);
  assert.match(list.text, /aria-label="Urgent\. [^"]*no heat/);
  // one vocabulary: the old words for the same state are gone
  assert.doesNotMatch(list.text, /Needs filing|Unsorted|Pick who|>Filed</);
  // an address with no name is printed once
  assert.equal(list.text.split('sunnyday4482@example.net').length - 1, 2, 'once in the row, once in its label');
});

test('drafts are signed by the person and the organization, never a placeholder', async () => {
  const page = await get(base, `/one-inbox/m/${bySubject('Kitchen sink leaking')}`, cookieA);
  assert.match(page.text, /Hi Denise,/);
  assert.match(page.text, /Thank you,\s+Admin iso-a\s+Org iso-a/);
  assert.doesNotMatch(page.text, /\[Your name\]/);
  // the person's phone is on the page as a link, and the role is a plain word
  assert.match(page.text, /href="tel:\+12025550101">\(202\) 555-0101</);
  assert.match(page.text, /Resident/);
  assert.match(page.text, /Not the right person\? Change/);
});

// ---------- the loop ----------

test('mark done goes to the next email in the same view, offers Undo, and ends on that view’s list', async () => {
  const f = F({ view: 'urgent' });
  const urgent = listMessages(fx.orgA, f).rows.map((m) => m.id);
  assert.ok(urgent.length >= 3, 'the sample has several urgent emails');
  assert.deepEqual(neighbors(fx.orgA, f, urgent[1]!), { index: 1, total: urgent.length, prev: urgent[0], next: urgent[2] });
  assert.equal(nextInView(fx.orgA, f, urgent[urgent.length - 1]!), urgent[urgent.length - 2], 'last in the view: the one above');

  // the page says where it is, and links either side
  const first = await get(base, `/one-inbox/m/${urgent[0]}?view=urgent`, cookieA);
  assert.match(first.text, new RegExp(`1 of ${urgent.length}`));
  assert.match(first.text, new RegExp(`href="/one-inbox/m/${urgent[1]}\\?view=urgent"[^>]*data-oi-next`));

  const done = await post(base, `/one-inbox/m/${urgent[0]}/done`, { view: 'urgent' }, cookieA);
  assert.ok(moved(done));
  assert.equal(done.location, `/one-inbox/m/${urgent[1]}?view=urgent&did=done&was=${urgent[0]}`);
  assert.equal(message(fx.orgA, urgent[0]!)!.status, 'done');
  const landed = await get(base, done.location!, cookieA);
  assert.match(landed.text, /Marked done: <b>/);
  assert.match(landed.text, new RegExp(`action="/one-inbox/m/${urgent[0]}/reopen"`));

  // undo: open again, back on that email, still in the Urgent view
  const undo = await post(base, `/one-inbox/m/${urgent[0]}/reopen`, { view: 'urgent' }, cookieA);
  assert.equal(undo.location, `/one-inbox/m/${urgent[0]}?view=urgent`);
  assert.equal(message(fx.orgA, urgent[0]!)!.status, 'open');
  assert.doesNotMatch((await get(base, done.location!, cookieA)).text, /Marked done: <b>/, 'a stale link claims nothing');

  // another organization can neither finish nor reopen it, and sees no notice
  assert.equal((await post(base, `/one-inbox/m/${urgent[0]}/done`, { view: 'urgent' }, cookieB)).status, 404);
  assert.equal(message(fx.orgA, urgent[0]!)!.status, 'open');
  assert.doesNotMatch((await get(base, `/one-inbox?did=done&was=${urgent[0]}`, cookieB)).text, /Marked done/);

  // work through the whole view: the last one lands on the Urgent list, not the default one
  let at = urgent[0]!;
  for (let i = 0; i < urgent.length; i++) {
    const r = await post(base, `/one-inbox/m/${at}/done`, { view: 'urgent' }, cookieA);
    if (i < urgent.length - 1) {
      at = /\/one-inbox\/m\/([^?]+)/.exec(r.location!)![1]!;
      assert.equal(message(fx.orgA, at)!.urgency, 'urgent');
    } else {
      assert.match(r.location!, /^\/one-inbox\?view=urgent&did=done&was=/);
    }
  }
  assert.equal(listMessages(fx.orgA, f).total, 0);
  const doneList = await get(base, '/one-inbox?view=done', cookieA);
  assert.match(doneList.text, /Done [A-Z][a-z]{2} \d+ by Admin iso-a/);
  for (const mid of urgent) await post(base, `/one-inbox/m/${mid}/reopen`, {}, cookieA);
});

test('saying who it is, by typing: moves to the next unknown sender; Undo forgets the address it learned', async () => {
  const f = F({ view: 'needs_filing' });
  const water = bySubject('water');
  const queue = listMessages(fx.orgA, f).rows.map((m) => m.id);
  assert.ok(queue.includes(water) && queue.length >= 2);
  const page = await get(base, `/one-inbox/m/${water}?view=needs_filing`, cookieA);
  assert.match(page.text, /<datalist id="oi-people">/);
  assert.match(page.text, /option value="Tanya Brooks — Oakwood Terrace · Unit 3"/);
  assert.doesNotMatch(page.text, /<select[^>]*name="contact_id"/, 'no giant drop-down');

  // a name two people share is not guessed at
  const vague = await post(base, `/one-inbox/m/${water}/file`, { view: 'needs_filing', contact_label: 'James Brown', remember: '1' }, cookieA);
  assert.equal(vague.location, `/one-inbox/m/${water}?view=needs_filing`);
  assert.equal(message(fx.orgA, water)!.match_status, 'unsorted');

  const expectNext = nextInView(fx.orgA, f, water);
  const filed = await post(base, `/one-inbox/m/${water}/file`, { view: 'needs_filing', contact_label: 'Tanya Brooks — Oakwood Terrace · Unit 3', remember: '1' }, cookieA);
  assert.equal(filed.location, `/one-inbox/m/${expectNext}?view=needs_filing&did=filed&was=${water}&learned=1`);
  const tanya = contacts(fx.orgA).find((c) => c.name === 'Tanya Brooks')!;
  assert.equal(message(fx.orgA, water)!.contact_id, tanya.id);
  assert.ok(tanya.emails.includes('sunnyday4482@example.net'));
  const landed = await get(base, filed.location!, cookieA);
  assert.match(landed.text, /Saved as <b>Tanya Brooks<\/b>/);
  assert.match(landed.text, /name="forget" value="1"/);

  const undo = await post(base, `/one-inbox/m/${water}/unfile`, { view: 'needs_filing', forget: '1' }, cookieA);
  assert.ok(moved(undo));
  assert.equal(message(fx.orgA, water)!.contact_id, null);
  assert.ok(!contact(fx.orgA, tanya.id)!.emails.includes('sunnyday4482@example.net'), 'the address is off her record again');
  // a partial name that fits one person is enough, and outside "Who is this?" the person stays on the email
  const loose = await post(base, `/one-inbox/m/${water}/file`, { view: 'open', contact_label: 'gloria' }, cookieA);
  assert.equal(loose.location, `/one-inbox/m/${water}?did=filed&was=${water}`);
  await post(base, `/one-inbox/m/${water}/unfile`, {}, cookieA);
});

// ---------- finding things ----------

test('search and filters: text, building, kind; done mail is searched too; tabs keep the search', async () => {
  const has = async (path: string, cookie = cookieA): Promise<string> => (await get(base, path, cookie)).text;
  const hit = await has('/one-inbox?q=dishwasher');
  assert.match(hit, /Dishwasher broken/);
  assert.doesNotMatch(hit, /Kitchen sink leaking/);
  assert.match(hit, /1 email matches/);
  assert.match(hit, /href="\/one-inbox\?view=urgent&amp;q=dishwasher"/, 'the tabs carry the search');
  // by unit and name on the contact list, not only words in the email
  assert.match(await has('/one-inbox?q=Denise'), /Kitchen sink leaking/);
  assert.match(await has('/one-inbox?q=sycamore'), /Payment plan/);

  const building = await has(`/one-inbox?property=${encodeURIComponent('Hillcrest Four')}`);
  assert.match(building, /Noise from upstairs/);
  assert.match(building, /October statement/);
  assert.doesNotMatch(building, /Kitchen sink leaking/);

  const kind = await has('/one-inbox?category=payment');
  assert.match(kind, /Payment plan/);
  assert.match(kind, /Late fee question/);
  assert.doesNotMatch(kind, /Kitchen sink leaking/);

  // a search with no tab picked covers done mail; a tab narrows it again
  const sink = bySubject('Kitchen sink leaking');
  await post(base, `/one-inbox/m/${sink}/done`, {}, cookieA);
  assert.match(await has('/one-inbox?q=kitchen+sink'), /Kitchen sink leaking/);
  assert.doesNotMatch(await has('/one-inbox?q=kitchen+sink&view=open'), /Kitchen sink leaking/);
  assert.match(await has('/one-inbox?q=kitchen+sink&view=done'), /Kitchen sink leaking/);
  await post(base, `/one-inbox/m/${sink}/reopen`, {}, cookieA);

  // wildcards are text, not patterns
  assert.match(await has('/one-inbox?q=%25'), /No emails match/);
  assert.match(await has('/one-inbox?q=zzzz-nothing'), /No emails match/);
  // and the search never reaches another organization's mail
  ingest(fx.orgB, { fromEmail: 'b@example.net', fromName: 'Bea', to: [], subject: 'Org B only', text: 'my dishwasher is fine' }, { via: 'manual' });
  assert.doesNotMatch(await has('/one-inbox?q=dishwasher'), /Org B only/);
  const theirs = await has('/one-inbox?q=dishwasher', cookieB);
  assert.match(theirs, /Org B only/);
  assert.doesNotMatch(theirs, /Dishwasher broken/);
});

test('a long list is paged, and says how much of it is showing', async () => {
  for (let i = 0; i < PAGE_SIZE + 5; i++) {
    ingest(fx.orgA, { fromEmail: `bulk${i}@example.net`, fromName: '', to: [], subject: `Bulk ${i}`, text: `bulk message number ${i}` }, { via: 'manual', receivedAt: new Date(Date.UTC(2026, 5, 1, 0, i)).toISOString() });
  }
  const total = listMessages(fx.orgA, F()).total;
  const p1 = await get(base, '/one-inbox', cookieA);
  assert.match(p1.text, new RegExp(`Showing 1–${PAGE_SIZE} of ${total}`));
  assert.match(p1.text, /href="\/one-inbox\?page=2"[^>]*>Older</);
  assert.doesNotMatch(p1.text, />Newer</);
  const p2 = await get(base, '/one-inbox?page=2', cookieA);
  assert.match(p2.text, new RegExp(`Showing ${PAGE_SIZE + 1}–${total} of ${total}`));
  assert.match(p2.text, />Newer</);
  assert.match(p2.text, /Bulk 0</);
  // "next" crosses the page boundary: position is counted over the whole view
  const ids = [...listMessages(fx.orgA, F(), 1).rows, ...listMessages(fx.orgA, F(), 2).rows].map((m) => m.id);
  assert.equal(neighbors(fx.orgA, F(), ids[PAGE_SIZE - 1]!).next, ids[PAGE_SIZE]);
  purge(ctxOf(fx.orgA, fx.userAId), 'all');
});

// ---------- people ----------

test('People: add, find, edit and remove, each only inside its own organization', async () => {
  assert.ok(moved(await post(base, '/one-inbox/people', { name: 'Rosa Diaz', kind: 'tenant', property: 'Elm Court', unit: '5', emails: 'Rosa@Example.com, rosa.d@work.example.com', phones: '(202) 555-0177' }, cookieA)));
  const rosa = contacts(fx.orgA).find((c) => c.name === 'Rosa Diaz')!;
  assert.deepEqual(rosa.emails, ['rosa@example.com', 'rosa.d@work.example.com']);
  assert.deepEqual(rosa.phones, ['2025550177']);
  assert.equal(rosa.source, 'manual');
  assert.equal(contacts(fx.orgB).some((c) => c.name === 'Rosa Diaz'), false);
  assert.ok(moved(await post(base, '/one-inbox/people', { name: '  ' }, cookieA)));
  assert.equal(contacts(fx.orgA).length, 1, 'a person needs a name');

  const mine = await get(base, '/one-inbox/people', cookieA);
  assert.match(mine.text, /Rosa Diaz/);
  assert.match(mine.text, /\(202\) 555-0177/);
  assert.match(mine.text, /By staff/);
  assert.doesNotMatch((await get(base, '/one-inbox/people', cookieB)).text, /Rosa Diaz/);
  assert.match((await get(base, '/one-inbox/people?q=0177', cookieA)).text, /Rosa Diaz/);
  assert.match((await get(base, '/one-inbox/people?q=nobody-here', cookieA)).text, /Nobody matches that search/);

  // the other organization cannot open, change or remove her
  assert.equal((await get(base, `/one-inbox/people/${rosa.id}`, cookieB)).status, 404);
  assert.equal((await post(base, `/one-inbox/people/${rosa.id}`, { name: 'Hijacked', kind: 'owner' }, cookieB)).status, 404);
  assert.equal((await post(base, `/one-inbox/people/${rosa.id}/remove`, {}, cookieB)).status, 404);
  assert.equal(contact(fx.orgA, rosa.id)!.name, 'Rosa Diaz');

  assert.equal((await get(base, `/one-inbox/people/${rosa.id}`, cookieA)).status, 200);
  assert.ok(moved(await post(base, `/one-inbox/people/${rosa.id}`, { name: 'Rosa Diaz', kind: 'tenant', property: 'Elm Court', unit: '6', emails: 'rosa@example.com', phones: '' }, cookieA)));
  const after = contact(fx.orgA, rosa.id)!;
  assert.equal(after.unit, '6');
  assert.deepEqual(after.emails, ['rosa@example.com']);
  assert.deepEqual(after.phones, []);

  // her email files itself; removing her keeps the email and asks "Who is this?" again
  const got = ingest(fx.orgA, { fromEmail: 'rosa@example.com', fromName: 'Rosa Diaz', to: [], subject: 'Mailbox key', text: 'I lost my mailbox key.' }, { via: 'manual' });
  assert.equal(got.status, 'matched');
  assert.match((await get(base, `/one-inbox?person=${rosa.id}`, cookieA)).text, /Mailbox key/);
  // a person from another organization cannot be attached to this organization's email
  const outsider = addContact(ctxOf(fx.orgB, fx.userBId), { name: 'Bea Outsider', emails: [], phones: [], property: '', unit: '', kind: 'tenant' });
  assert.equal(fileTo(ctxOf(fx.orgA, fx.userAId), got.id, outsider, true), false);
  assert.equal((await post(base, `/one-inbox/m/${got.id}/file`, { contact_id: outsider }, cookieA)).status, 404);
  assert.equal(message(fx.orgA, got.id)!.contact_id, rosa.id);

  const gone = await post(base, `/one-inbox/people/${rosa.id}/remove`, {}, cookieA);
  assert.ok(moved(gone));
  assert.equal(contact(fx.orgA, rosa.id), null);
  const m = message(fx.orgA, got.id)!;
  assert.equal(m.contact_id, null);
  assert.equal(m.match_status, 'unsorted');
  assert.equal(contact(fx.orgB, outsider)!.name, 'Bea Outsider', 'the other organization’s list is untouched');
  assert.match((await get(base, '/one-inbox/example.csv', cookieA)).text, /^Name,Email,Phone,Building,Unit,Type/);
});
