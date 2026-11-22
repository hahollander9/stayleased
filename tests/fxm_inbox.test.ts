// One Inbox replies, the Outbox "send this email" action and the mass-message
// screens, with the real email rail switched on. Environment first: node:test
// runs each file in its own process, so none of this leaks to other suites.
process.env.STAYLEASED_EMAIL_PROVIDER = 'postmark';
process.env.STAYLEASED_EMAIL_API_KEY = 'test-key-not-real';
process.env.STAYLEASED_EMAIL_FROM = 'office@mail.stayleased-fixture.com';
process.env.STAYLEASED_EMAIL_WEBHOOK_SECRET = 'whsec-fixture-0123456789';
process.env.STAYLEASED_EMAIL_DAILY_CAP_PER_ORG = '500';

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, q1, insert, val } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword, sysCtx } from '../src/lib/auth.ts';
import { setSetting } from '../src/lib/settings.ts';
import { sendEmail, sendSms, RECORDED } from '../src/lib/sim/messaging.ts';
import { setEmailTransport, deliverEmailQueue, suppress, type OutgoingEmail, type TransportResult } from '../src/lib/email.ts';
import { ingest, sendReply, replyBlocker, message, addContact, fileTo } from '../src/modules/m23_oneinbox/service.ts';
import { startTestServer, loginAs, get, post } from './harness.ts';

/** Nothing here touches the network: every hand-off goes to `sent`, a fake
 * transport, and each test asserts what is in the database afterwards. */

interface Fx { org: string; email: string; uid: string; kind: 'demo' | 'live' }
let base: string;
let close: () => void;
let live: Fx;
let other: Fx; // a second live org, email also on: proves org scoping, not the switch
let demo: Fx;
let cookieLive: string;
let cookieOther: string;
let cookieDemo: string;
const sfx = id('x').slice(-6);
const sent: OutgoingEmail[] = [];
let answer: (m: OutgoingEmail) => TransportResult = () => ({ ok: true, providerId: id('pm') });

function mkUser(org: string, tag: string, role: string, props: string[] | null): { uid: string; email: string } {
  const uid = id('usr');
  const email = `${tag}-${sfx}@fixture-mail.com`;
  insert('users', { id: uid, org_id: org, email, name: `User ${tag}`, kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso() });
  insert('role_assignments', { id: id('ra'), org_id: org, user_id: uid, role, scope_type: props ? 'property' : 'org', property_ids: JSON.stringify(props || []), created_at: nowIso() });
  return { uid, email };
}
function mkOrg(kind: 'demo' | 'live', tag: string): Fx {
  const org = id('org');
  insert('orgs', { id: org, name: `Inbox ${tag} ${sfx}`, slug: `fxmi-${tag}-${sfx}`, kind, business_date: '2026-07-26', created_at: nowIso() });
  const u = mkUser(org, `admin-${tag}`, 'ORG_ADMIN', null);
  setSetting(sysCtx(org), 'email_delivery', true);
  return { org, kind, ...u };
}
function mkProp(org: string, tag: string): string {
  const prop = id('prp');
  insert('properties', { id: prop, org_id: org, name: `Elm Court ${tag}`, slug: `fxmi-prop-${tag}-${sfx}`, type: 'multifamily', address1: '1 Test St', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso() });
  return prop;
}
const ctxOf = (f: Fx, uid = f.uid) => ({ ...sysCtx(f.org), orgKind: f.kind, userId: uid } as ReturnType<typeof sysCtx>);
const row = (mid: string): any => q1<any>('SELECT * FROM outbox_messages WHERE id=?', mid);
const drain = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 5)); await deliverEmailQueue(); };
const mail = (from: string, subject: string) => ({ fromEmail: from, fromName: 'Pat Tenant', to: ['office@x.com'], subject, text: `About: ${subject}. Please advise.` } as any);
const redirected = (r: { status: number }): boolean => r.status === 302 || r.status === 303;

before(async () => {
  db();
  live = mkOrg('live', 'on');
  other = mkOrg('live', 'other');
  demo = mkOrg('demo', 'demo');
  setEmailTransport(async (m) => { sent.push(m); return answer(m); });
  const s = await startTestServer();
  base = s.base; close = s.close;
  cookieLive = await loginAs(base, live.email);
  cookieOther = await loginAs(base, other.email);
  cookieDemo = await loginAs(base, demo.email);
});
after(() => { setEmailTransport(null); close(); });
beforeEach(async () => { await drain(); sent.length = 0; answer = () => ({ ok: true, providerId: id('pm') }); });

// ---------- One Inbox ----------

test('One Inbox: a sender on the do-not-email list blocks the reply, with a plain reason', async () => {
  const from = `bounced-${sfx}@realdomain.com`;
  const got = ingest(live.org, mail(from, 'Heat is out'), { via: 'manual' });
  const ctx = ctxOf(live);
  assert.equal(replyBlocker(ctx, message(live.org, got.id)!), null);
  suppress(live.org, from, 'bounced');
  const why = replyBlocker(ctx, message(live.org, got.id)!);
  assert.match(String(why), /do-not-email list \(bounced\)/);
  const before = val<number>('SELECT COUNT(*) c FROM outbox_messages WHERE org_id=?', live.org);
  const res = sendReply(ctx, got.id, { subject: 'Re: Heat is out', text: 'Someone is on the way.' });
  assert.equal(res.ok, false);
  assert.equal(val<number>('SELECT COUNT(*) c FROM outbox_messages WHERE org_id=?', live.org), before, 'nothing was written');
  assert.equal(message(live.org, got.id)!.replied_at, null);
  await drain();
  assert.equal(sent.length, 0);
  // the page offers no send form, says why, and does not point at email setup (email IS set up)
  const page = await get(base, `/one-inbox/m/${got.id}`, cookieLive);
  assert.doesNotMatch(page.text, /Send reply/);
  assert.match(page.text, /do-not-email list/);
  assert.doesNotMatch(page.text, /Set up email/);
  // the same address in another organization is not on that organization's list
  const theirs = ingest(other.org, mail(from, 'Heat is out'), { via: 'manual' });
  assert.equal(replyBlocker(ctxOf(other), message(other.org, theirs.id)!), null);
});

test('One Inbox: the reply banner reports the real outcome — Not delivered after a refusal, Sent after delivery', async () => {
  answer = () => ({ ok: false, error: 'Mailbox does not exist', retry: false });
  const bad = ingest(live.org, mail(`gone-${sfx}@realdomain.com`, 'Parking pass'), { via: 'manual' });
  const r = await post(base, `/one-inbox/m/${bad.id}/reply`, { subject: 'Re: Parking pass', text: 'It is at the front desk.' }, cookieLive);
  assert.ok(redirected(r));
  await drain();
  const m = message(live.org, bad.id)!;
  assert.equal(row(m.reply_message_id!).status, 'failed');
  const page = await get(base, `/one-inbox/m/${bad.id}`, cookieLive);
  assert.match(page.text, /<b>Not delivered\.<\/b>/);
  assert.match(page.text, /Mailbox does not exist/);
  assert.doesNotMatch(page.text, /A reply was sent from StayLeased/);

  answer = () => ({ ok: true, providerId: 'pm-ok' });
  const good = ingest(live.org, mail(`fine-${sfx}@realdomain.com`, 'Gym hours'), { via: 'manual' });
  assert.equal(sendReply(ctxOf(live), good.id, { subject: 'Re: Gym hours', text: 'Six to ten, every day.' }).ok, true);
  // before the provider answers, the banner says it is sending, not sent
  const mid = message(live.org, good.id)!.reply_message_id!;
  if (row(mid).status === 'queued') {
    const early = await get(base, `/one-inbox/m/${good.id}`, cookieLive);
    if (row(mid).status === 'queued') assert.match(early.text, /<b>Sending\.<\/b>/);
  }
  await drain();
  assert.equal(row(mid).status, 'sent');
  assert.match((await get(base, `/one-inbox/m/${good.id}`, cookieLive)).text, /<b>Sent\.<\/b>/);
});

test('One Inbox: a viewer without permission to send is told so, not sent to email setup', async () => {
  const tech = mkUser(live.org, 'viewer', 'MAINTENANCE_TECH', null);
  const cookie = await loginAs(base, tech.email);
  const got = ingest(live.org, mail(`asker-${sfx}@realdomain.com`, 'Kitchen sink leaking'), { via: 'manual' });
  const page = await get(base, `/one-inbox/m/${got.id}`, cookie);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /Send reply/);
  // filed to a person, so a reply is suggested: the fallback card explains why it cannot be sent from here
  const cid = addContact(ctxOf(live), { name: 'Pat Tenant', emails: [`asker-${sfx}@realdomain.com`], phones: [], property: 'Elm Court', unit: '4', kind: 'tenant' });
  assert.ok(fileTo(ctxOf(live), got.id, cid, false));
  const filed = await get(base, `/one-inbox/m/${got.id}`, cookie);
  assert.match(filed.text, /Copy this into your own email/);
  assert.match(filed.text, /does not have permission to send/);
  assert.doesNotMatch(filed.text, /Set up email/);
  assert.doesNotMatch(filed.text, /Send reply/);
  const r = await post(base, `/one-inbox/m/${got.id}/reply`, { subject: 'Re', text: 'Hello there' }, cookie);
  assert.ok(r.status === 403 || redirected(r));
  assert.equal(message(live.org, got.id)!.replied_at, null);
});

test('Outbox: building-scoped staff can open the property-less reply they sent, and nobody else’s', async () => {
  const prop = mkProp(live.org, 'scoped');
  const agent = mkUser(live.org, 'agent', 'LEASING_AGENT', [prop]);
  const cookie = await loginAs(base, agent.email);
  const got = ingest(live.org, mail(`lead-${sfx}@realdomain.com`, 'Tour on Friday'), { via: 'manual' });
  const mine = sendReply(ctxOf(live, agent.uid), got.id, { subject: 'Re: Tour on Friday', text: 'Friday at ten works.' });
  assert.ok(mine.ok);
  const theirs = sendEmail(ctxOf(live), { to: `owner-${sfx}@realdomain.com`, subject: `Owner statement ${sfx}`, body: '<p>Attached.</p>' });
  await drain();
  const mineId = (mine as { outboxId: string }).outboxId;
  assert.equal(row(mineId).property_id, null);
  assert.equal((await get(base, `/dev/messages/${mineId}`, cookie)).status, 200);
  assert.equal((await get(base, `/dev/messages/${theirs}`, cookie)).status, 404);
  const list = await get(base, '/dev/messages', cookie);
  assert.match(list.text, /Re: Tour on Friday/);
  assert.doesNotMatch(list.text, new RegExp(`Owner statement ${sfx}`));
  // an admin's property-less message cannot be retried or sent by the scoped user either
  assert.equal((await post(base, `/dev/messages/${theirs}/retry`, {}, cookie)).status, 404);
  assert.equal((await post(base, `/dev/messages/${theirs}/send`, {}, cookie)).status, 404);
});

// ---------- Outbox: send a saved email ----------

test('Outbox: a held, saved email can be sent by its own organization and not by another', async () => {
  const to = `invitee-${sfx}@realdomain.com`;
  const mid = sendEmail(ctxOf(live), { to, toName: 'Ira Invitee', subject: 'Your resident portal', body: '<p>Temporary password: <b>abc-123</b></p>', templateKey: 'portal_invite', hold: true });
  await drain();
  assert.equal(row(mid).status, RECORDED, 'held: saved, not handed to the provider');
  assert.equal(sent.length, 0);

  const page = await get(base, `/dev/messages/${mid}`, cookieLive);
  assert.match(page.text, /Send this email/);
  assert.match(page.text, /saved and has not been sent/);
  assert.doesNotMatch(page.text, /not connected yet/);

  // another live organization, with email on, cannot see or send it
  assert.equal((await get(base, `/dev/messages/${mid}`, cookieOther)).status, 404);
  assert.equal((await post(base, `/dev/messages/${mid}/send`, {}, cookieOther)).status, 404);
  assert.equal(row(mid).status, RECORDED);
  assert.equal(sent.length, 0);

  const res = await post(base, `/dev/messages/${mid}/send`, {}, cookieLive);
  assert.ok(redirected(res));
  const r = row(mid);
  assert.equal(r.status, 'sent');
  assert.ok(r.provider_id);
  assert.equal(sent.filter((m) => m.to === to).length, 1);
  // pressing it again does not send a second copy, and the button is gone
  await post(base, `/dev/messages/${mid}/send`, {}, cookieLive);
  await drain();
  assert.equal(sent.filter((m) => m.to === to).length, 1);
  assert.doesNotMatch((await get(base, `/dev/messages/${mid}`, cookieLive)).text, /Send this email/);
});

test('Outbox: a refused send of a saved email says so and leaves it retryable', async () => {
  answer = () => ({ ok: false, error: 'Address rejected', retry: false });
  const mid = sendEmail(ctxOf(live), { to: `nope-${sfx}@realdomain.com`, subject: 'Held', body: '<p>x</p>', hold: true });
  const res = await post(base, `/dev/messages/${mid}/send`, {}, cookieLive);
  assert.ok(redirected(res));
  assert.equal(row(mid).status, 'failed');
  const page = await get(base, `/dev/messages/${mid}`, cookieLive);
  assert.match(page.text, /Not delivered/);
  assert.match(page.text, /Address rejected/);
  assert.match(page.text, /Try again/);
});

test('Outbox: text messages and demo organizations never get the send button', async () => {
  const sms = sendSms(ctxOf(live), { to: '+13035550144', toName: 'Tia Text', body: 'Water off Tuesday 9-11' });
  assert.equal(row(sms).status, RECORDED);
  const page = await get(base, `/dev/messages/${sms}`, cookieLive);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /Send this email/);
  assert.match(page.text, /Text messages are not connected yet/);
  assert.ok(redirected(await post(base, `/dev/messages/${sms}/send`, {}, cookieLive)));
  assert.equal(row(sms).status, RECORDED);

  // demo: the simulator's rows are 'sent'; force one to 'recorded' to prove the gate is the organization
  const dm = sendEmail(ctxOf(demo), { to: `demo-${sfx}@realdomain.com`, subject: 'Demo', body: '<p>x</p>' });
  db().prepare("UPDATE outbox_messages SET status='recorded' WHERE id=?").run(dm);
  assert.doesNotMatch((await get(base, `/dev/messages/${dm}`, cookieDemo)).text, /Send this email/);
  assert.ok(redirected(await post(base, `/dev/messages/${dm}/send`, {}, cookieDemo)));
  assert.equal(row(dm).status, RECORDED);

  // an inbound row is never sendable
  const inId = id('msg');
  insert('outbox_messages', { id: inId, org_id: live.org, channel: 'email', direction: 'in', to_addr: `in-${sfx}@realdomain.com`, subject: 'Inbound', body: 'hello', status: RECORDED, created_at: nowIso(), business_date: '2026-07-26' });
  assert.doesNotMatch((await get(base, `/dev/messages/${inId}`, cookieLive)).text, /Send this email/);
  await post(base, `/dev/messages/${inId}/send`, {}, cookieLive);
  assert.equal(row(inId).status, RECORDED);

  await drain();
  assert.equal(sent.length, 0);
});

// ---------- mass messages ----------

test('Mass message pages count real delivery outcomes when email is on', async () => {
  const prop = mkProp(live.org, 'mass');
  const mass = id('mm');
  insert('mass_messages', { id: mass, org_id: live.org, filters: '{}', subject: `Water shut-off ${sfx}`, body: '<p>x</p>', channels: '["email","sms"]', scheduled_for: '2026-07-26', status: 'sent', sent_at: nowIso(), sent_count: 0, skipped_count: 0, created_at: nowIso() });
  const add = (first: string, channel: string, status: string, error?: string): void => {
    const res = id('res');
    insert('residents', { id: res, org_id: live.org, property_id: prop, first_name: first, last_name: 'Mass', email: `${first.toLowerCase()}-${sfx}@realdomain.com`, phone: '+13035550101', kind: 'adult', created_at: nowIso() });
    const ob = id('msg');
    insert('outbox_messages', { id: ob, org_id: live.org, property_id: prop, channel, direction: 'out', to_addr: 'x@realdomain.com', subject: 's', body: 'b', template_key: 'mass', status, delivery_error: error || null, created_at: nowIso(), business_date: '2026-07-26' });
    insert('mass_recipients', { id: id('mr'), org_id: live.org, mass_id: mass, resident_id: res, channel, status, outbox_id: ob, sent_at: nowIso() });
  };
  add('Ada', 'email', 'sent'); add('Ben', 'email', 'sent'); add('Cy', 'email', 'queued');
  add('Dee', 'email', 'failed', 'Mailbox is full'); add('Eve', 'email', 'bounced', 'No such user'); add('Flo', 'sms', RECORDED);

  const page = await get(base, `/comms/mass/${mass}`, cookieLive);
  assert.equal(page.status, 200);
  const tile = (label: string): string => (new RegExp(`${label}[^<]*</div>\\s*<div class="k-value">(\\d+)<`).exec(page.text) || [])[1] || `no "${label}" tile`;
  assert.equal(tile('Delivered'), '2');
  assert.equal(tile('Sending'), '1');
  assert.equal(tile('Not delivered'), '2');
  assert.equal(tile('Saved to Outbox'), '1');
  assert.match(page.text, /Mailbox is full/);
  assert.match(page.text, /Text messages are not connected yet/);
  assert.doesNotMatch(page.text, /Email and text delivery are not connected yet/);
  assert.doesNotMatch(page.text, /nothing has reached a resident/);

  const list = await get(base, '/comms', cookieLive);
  assert.match(list.text, /2 delivered · 1 sending · 2 not delivered · 1 saved, not delivered/);
  assert.doesNotMatch(list.text, /Email and text delivery are not connected yet/);
});

// ---------- One Inbox: the composer ----------

test('One Inbox: a reply that still says [Your name] is refused, and what was typed is not lost', async () => {
  const from = `signer-${sfx}@realdomain.com`;
  const got = ingest(live.org, mail(from, 'Laundry room'), { via: 'manual' });
  const ctx = ctxOf(live);
  const before = val<number>('SELECT COUNT(*) c FROM outbox_messages WHERE org_id=?', live.org);
  const refused = sendReply(ctx, got.id, { subject: 'Re: Laundry room', text: 'It reopens Monday.\n\nThank you,\n[Your name]' });
  assert.equal(refused.ok, false);
  assert.match((refused as { error: string }).error, /\[Your name\]/);
  assert.equal(val<number>('SELECT COUNT(*) c FROM outbox_messages WHERE org_id=?', live.org), before, 'nothing was written');

  // the suggestion itself never carries the placeholder; it is signed
  const page = await get(base, `/one-inbox/m/${got.id}`, cookieLive);
  assert.doesNotMatch(page.text, /\[Your name\]/);
  assert.match(page.text, /Thank you,\s+User admin-on\s+Inbox on /);
  assert.match(page.text, /Send and mark done/);

  // through the form: the page comes back with the typed text in it, not a redirect that drops it
  const typed = 'A one-of-a-kind sentence about the laundry room. [Your name]';
  const back = await post(base, `/one-inbox/m/${got.id}/reply`, { subject: 'Re: Laundry room (edited)', text: typed }, cookieLive);
  assert.equal(back.status, 422);
  assert.match(back.text, /<b>Not sent\.<\/b>/);
  assert.match(back.text, /A one-of-a-kind sentence about the laundry room\. \[Your name\]/);
  assert.match(back.text, /value="Re: Laundry room \(edited\)"/);
  assert.equal(message(live.org, got.id)!.replied_at, null);
  await drain();
  assert.equal(sent.length, 0);
});

test('One Inbox: “Send and mark done” sends, finishes the email and moves on; the sent reply shows under the email', async () => {
  const a = ingest(live.org, mail(`first-${sfx}@realdomain.com`, 'Bike room code'), { via: 'manual' });
  const r = await post(base, `/one-inbox/m/${a.id}/reply`, { subject: 'Re: Bike room code', text: 'The code is at the front desk.', after: 'done', view: 'open' }, cookieLive);
  assert.ok(redirected(r));
  assert.match(String(r.location), new RegExp(`did=done&was=${a.id}$`));
  assert.doesNotMatch(String(r.location), new RegExp(`/one-inbox/m/${a.id}`), 'it moved on from the email it finished');
  await drain();
  const m = message(live.org, a.id)!;
  assert.equal(m.status, 'done');
  assert.ok(m.replied_at);
  assert.equal(sent.filter((x) => x.to === `first-${sfx}@realdomain.com`).length, 1);

  // the reply is on the page as part of the thread, and the composer is folded away so it is not sent twice
  const page = await get(base, `/one-inbox/m/${a.id}`, cookieLive);
  assert.match(page.text, /<b>Sent\.<\/b>/);
  assert.match(page.text, /The code is at the front desk\./);
  assert.match(page.text, /Write another reply/);
  assert.doesNotMatch(page.text, /<textarea[^>]*id="oi-draft"[^>]*>[^<]*Thank you/, 'the second composer starts empty');
  // another organization cannot read that reply through this page
  assert.equal((await get(base, `/one-inbox/m/${a.id}`, cookieOther)).status, 404);
});
