// The real email rail. Environment is set BEFORE anything reads it; node:test
// runs each file in its own process, so none of this leaks to other suites.
process.env.STAYLEASED_EMAIL_PROVIDER = 'postmark';
process.env.STAYLEASED_EMAIL_API_KEY = 'test-key-not-real';
process.env.STAYLEASED_EMAIL_FROM = 'office@mail.stayleased-fixture.com';
process.env.STAYLEASED_EMAIL_WEBHOOK_SECRET = 'whsec-fixture-0123456789';
process.env.STAYLEASED_EMAIL_DAILY_CAP_PER_ORG = '500';

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, q1, insert, run, val } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword, sysCtx } from '../src/lib/auth.ts';
import { setSetting } from '../src/lib/settings.ts';
import { sendEmail, sendSms, deliveryNote, deliveryLabel, RECORDED } from '../src/lib/sim/messaging.ts';
import {
  setEmailTransport, deliverEmailQueue, emailLive, emailConfigured, isDeliverableAddress, suppressed,
  htmlToText, parseProviderEvent, type OutgoingEmail, type TransportResult,
} from '../src/lib/email.ts';
import { ingest, sendReply, replyBlocker, message } from '../src/modules/m23_oneinbox/service.ts';
import { startTestServer, loginAs, get, post } from './harness.ts';

/** Nothing here touches the network: every hand-off goes to `sent`, a fake
 * transport, and each test asserts what is in the database afterwards. */

interface Fx { org: string; email: string; uid: string }
let base: string;
let close: () => void;
let live: Fx;
let liveOff: Fx;
let demo: Fx;
let cookieLive: string;
let cookieOff: string;
const sfx = id('x').slice(-6);
const sent: OutgoingEmail[] = [];
let answer: (m: OutgoingEmail) => TransportResult = () => ({ ok: true, providerId: id('pm') });

function mkOrg(kind: 'demo' | 'live', tag: string, on: boolean): Fx {
  const org = id('org');
  insert('orgs', { id: org, name: `Mail ${tag} ${sfx}`, slug: `fxe-${tag}-${sfx}`, kind, business_date: '2026-07-26', created_at: nowIso() });
  const uid = id('usr');
  const email = `admin-${tag}-${sfx}@fixture-mail.com`;
  insert('users', { id: uid, org_id: org, email, name: `Admin ${tag}`, kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso() });
  insert('role_assignments', { id: id('ra'), org_id: org, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  if (on) setSetting(sysCtx(org), 'email_delivery', true);
  return { org, email, uid };
}
const ctxOf = (f: Fx) => ({ ...sysCtx(f.org), orgKind: f === demo ? 'demo' : 'live', userId: f.uid } as ReturnType<typeof sysCtx>);
const row = (mid: string): any => q1<any>('SELECT * FROM outbox_messages WHERE id=?', mid);
const drain = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 5)); await deliverEmailQueue(); };

before(async () => {
  db();
  live = mkOrg('live', 'on', true);
  liveOff = mkOrg('live', 'off', false);
  demo = mkOrg('demo', 'demo', true); // the switch being on must not matter for a demo
  setEmailTransport(async (m) => { sent.push(m); return answer(m); });
  const s = await startTestServer();
  base = s.base; close = s.close;
  cookieLive = await loginAs(base, live.email);
  cookieOff = await loginAs(base, liveOff.email);
});
after(() => { setEmailTransport(null); close(); });
beforeEach(async () => { await drain(); sent.length = 0; answer = () => ({ ok: true, providerId: id('pm') }); });

test('the three gates: server configured, live organization, switch on', () => {
  assert.equal(emailConfigured(), true);
  assert.equal(emailLive(ctxOf(live)), true);
  assert.equal(emailLive(ctxOf(liveOff)), false);
  assert.equal(emailLive(ctxOf(demo)), false);
});

test('a demo organization never hands anything to the provider', async () => {
  const mid = sendEmail(ctxOf(demo), { to: 'someone@realdomain.com', subject: 'Hi', body: '<p>Hi</p>' });
  await drain();
  assert.equal(sent.length, 0);
  assert.notEqual(row(mid).status, 'queued');
  assert.equal(row(mid).provider_id, null);
});

test('a live organization with the switch off still only records', async () => {
  const mid = sendEmail(ctxOf(liveOff), { to: 'someone@realdomain.com', subject: 'Hi', body: '<p>Hi</p>' });
  await drain();
  assert.equal(sent.length, 0);
  assert.equal(row(mid).status, RECORDED);
});

test('switch on: queued, then sent with the provider id, reply-to and a text part', async () => {
  const mid = sendEmail(ctxOf(live), { to: 'ana@realdomain.com', toName: 'Ana', subject: 'Rent receipt', body: '<p>Thanks, <b>Ana</b>.</p><p>Paid in full.</p>', templateKey: 'payment_receipt' });
  assert.equal(row(mid).status, 'queued');
  await drain();
  const r = row(mid);
  assert.equal(r.status, 'sent');
  assert.ok(r.provider_id);
  assert.ok(r.delivered_at);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, 'ana@realdomain.com');
  assert.match(sent[0]!.from, /office@mail\.stayleased-fixture\.com/);
  assert.match(sent[0]!.text, /Thanks, Ana\.\s+Paid in full\./);
  assert.equal(sent[0]!.tag, 'payment_receipt');
  assert.match(deliveryNote(ctxOf(live)), /on its way/);
  assert.equal(deliveryLabel('queued'), 'Sending');
});

test('draining twice never sends a second copy', async () => {
  const mid = sendEmail(ctxOf(live), { to: 'once@realdomain.com', subject: 'Once', body: '<p>x</p>' });
  await Promise.all([deliverEmailQueue(), deliverEmailQueue(), drain()]);
  await drain();
  assert.equal(sent.filter((m) => m.messageId === mid).length, 1);
});

test('text messages are still only recorded', async () => {
  const mid = sendSms(ctxOf(live), { to: '+13035550101', body: 'Hello' });
  await drain();
  assert.equal(row(mid).status, RECORDED);
  assert.equal(sent.length, 0);
});

test('reserved and fixture addresses are refused before the provider sees them', async () => {
  for (const a of ['ana@oakline.demo', 'x@example.test', 'y@example.com', 'not-an-address', 'a@b.com\nBcc: c@d.com']) assert.equal(isDeliverableAddress(a), false, a);
  const mid = sendEmail(ctxOf(live), { to: 'resident@oakline.demo', subject: 'Hi', body: '<p>Hi</p>' });
  await drain();
  assert.equal(sent.length, 0);
  assert.equal(row(mid).status, 'failed');
  assert.match(row(mid).delivery_error, /not an address/);
});

test('a subject cannot carry a header into the message', async () => {
  const mid = sendEmail(ctxOf(live), { to: 'ana@realdomain.com', subject: 'Hello\r\nBcc: thief@evil.com', body: '<p>x</p>' });
  await drain();
  assert.equal(row(mid).status, 'sent');
  assert.doesNotMatch(sent[0]!.subject, /[\r\n]/);
});

test('a temporary failure is retried later; a permanent one stops', async () => {
  answer = () => ({ ok: false, error: 'provider 503', retry: true });
  const mid = sendEmail(ctxOf(live), { to: 'slow@realdomain.com', subject: 'Later', body: '<p>x</p>' });
  await drain();
  let r = row(mid);
  assert.equal(r.status, 'queued');
  assert.equal(r.attempts, 1);
  assert.ok(r.next_attempt_at > nowIso(), 'backs off into the future');
  await drain(); // not due yet
  assert.equal(sent.length, 1);
  run('UPDATE outbox_messages SET next_attempt_at=? WHERE id=?', '2000-01-01T00:00:00.000Z', mid);
  answer = () => ({ ok: true, providerId: 'pm-late' });
  await drain();
  r = row(mid);
  assert.equal(r.status, 'sent');
  assert.equal(r.provider_id, 'pm-late');

  answer = () => ({ ok: false, error: 'Inactive recipient', retry: false });
  const dead = sendEmail(ctxOf(live), { to: 'gone@realdomain.com', subject: 'No', body: '<p>x</p>' });
  await drain();
  assert.equal(row(dead).status, 'failed');
  assert.match(row(dead).delivery_error, /Inactive recipient/);
  assert.equal(deliveryLabel('failed'), 'Not delivered');
});

test('retries give up after five attempts', async () => {
  answer = () => ({ ok: false, error: 'provider 500', retry: true });
  const mid = sendEmail(ctxOf(live), { to: 'never@realdomain.com', subject: 'x', body: '<p>x</p>' });
  for (let i = 0; i < 6; i++) {
    await drain();
    run('UPDATE outbox_messages SET next_attempt_at=? WHERE id=? AND status=?', '2000-01-01T00:00:00.000Z', mid, 'queued');
  }
  assert.equal(row(mid).status, 'failed');
  assert.equal(row(mid).attempts, 5);
});

test('a failed email can be tried again from the Outbox', async () => {
  answer = () => ({ ok: false, error: 'refused', retry: false });
  const mid = sendEmail(ctxOf(live), { to: 'again@realdomain.com', subject: 'Again', body: '<p>x</p>' });
  await drain();
  assert.equal(row(mid).status, 'failed');
  const page = await get(base, `/dev/messages/${mid}`, cookieLive);
  assert.match(page.text, /Not delivered/);
  assert.match(page.text, /Try again/);
  answer = () => ({ ok: true, providerId: 'pm-retry' });
  const res = await post(base, `/dev/messages/${mid}/retry`, {}, cookieLive);
  assert.ok(res.status === 302 || res.status === 303);
  assert.equal(row(mid).status, 'sent');
  // and the other organization cannot retry it
  run("UPDATE outbox_messages SET status='failed' WHERE id=?", mid);
  const other = await post(base, `/dev/messages/${mid}/retry`, {}, cookieOff);
  assert.equal(other.status, 404);
  assert.equal(row(mid).status, 'failed');
});

test('the bounce webhook needs the secret, marks the message and stops further mail to that address', async () => {
  const mid = sendEmail(ctxOf(live), { to: 'bouncy@realdomain.com', subject: 'x', body: '<p>x</p>' });
  await drain();
  const pid = row(mid).provider_id;
  const hook = (key: string, body: unknown) => fetch(`${base}/webhooks/email${key ? `?key=${key}` : ''}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const evt = { RecordType: 'Bounce', Type: 'HardBounce', MessageID: pid, Email: 'bouncy@realdomain.com', Description: 'No such mailbox' };
  assert.equal((await hook('', evt)).status, 401);
  assert.equal((await hook('wrong-secret-0123456789xx', evt)).status, 401);
  assert.equal(row(mid).status, 'sent');
  // an id this server never sent touches nothing
  const stray = await hook('whsec-fixture-0123456789', { ...evt, MessageID: 'not-ours' });
  assert.equal((await stray.json() as any).applied, 0);
  const ok = await hook('whsec-fixture-0123456789', evt);
  assert.equal(ok.status, 200);
  assert.equal(row(mid).status, 'bounced');
  assert.ok(suppressed(live.org, 'bouncy@realdomain.com'));
  assert.equal(suppressed(liveOff.org, 'bouncy@realdomain.com'), null, 'suppression is per organization');
  const next = sendEmail(ctxOf(live), { to: 'Bouncy@RealDomain.com', subject: 'again', body: '<p>x</p>' });
  sent.length = 0;
  await drain();
  assert.equal(sent.length, 0);
  assert.equal(row(next).status, 'failed');
  assert.match(row(next).delivery_error, /do-not-email/);
});

test('provider events: soft bounces are ignored, Resend bodies are read', () => {
  assert.equal(parseProviderEvent({ RecordType: 'Bounce', Type: 'SoftBounce', MessageID: 'a', Email: 'x@y.com' }), null);
  assert.equal(parseProviderEvent({ RecordType: 'SpamComplaint', MessageID: 'a', Email: 'x@y.com' })?.kind, 'complained');
  assert.deepEqual(parseProviderEvent({ type: 'email.bounced', data: { email_id: 'r1', to: ['x@y.com'] } })?.providerId, 'r1');
  assert.equal(parseProviderEvent({ hello: 'world' }), null);
  assert.equal(parseProviderEvent(null), null);
});

test('the daily limit holds mail back instead of sending or failing it', async () => {
  process.env.STAYLEASED_EMAIL_DAILY_CAP_PER_ORG = '1';
  try {
    const capOrg = mkOrg('live', `cap${id('c').slice(-4)}`, true);
    const a = sendEmail(ctxOf(capOrg), { to: 'one@realdomain.com', subject: '1', body: '<p>1</p>' });
    await drain();
    const b = sendEmail(ctxOf(capOrg), { to: 'two@realdomain.com', subject: '2', body: '<p>2</p>' });
    await drain();
    assert.equal(row(a).status, 'sent');
    assert.equal(row(b).status, 'queued');
    assert.match(row(b).delivery_error, /daily sending limit/);
  } finally {
    process.env.STAYLEASED_EMAIL_DAILY_CAP_PER_ORG = '500';
  }
});

test('turning the switch off between writing and sending stops the message', async () => {
  const o = mkOrg('live', `tog${id('c').slice(-4)}`, true);
  const mid = sendEmail(ctxOf(o), { to: 'late@realdomain.com', subject: 'x', body: '<p>x</p>' });
  setSetting(sysCtx(o.org), 'email_delivery', false);
  await drain();
  assert.equal(sent.length, 0);
  assert.equal(row(mid).status, 'failed');
});

test('One Inbox: a reply is really sent, escaped, and marked on the message', async () => {
  const got = ingest(live.org, { fromEmail: 'tenant@realdomain.com', fromName: 'Pat Tenant', to: ['office@x.com'], subject: 'Leak under sink', text: 'There is a leak.' } as any, { via: 'manual' });
  const ctx = ctxOf(live);
  assert.equal(replyBlocker(ctx, message(live.org, got.id)!), null);
  const res = sendReply(ctx, got.id, { subject: 'Re: Leak under sink\r\nBcc: x@y.com', text: 'Hi Pat,\n\nA plumber is coming <b>today</b>.' });
  assert.equal(res.ok, true);
  await drain();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, 'tenant@realdomain.com');
  assert.doesNotMatch(sent[0]!.subject, /[\r\n]/);
  assert.match(sent[0]!.html, /&lt;b&gt;today&lt;\/b&gt;/);
  const m = message(live.org, got.id)!;
  assert.ok(m.replied_at);
  assert.equal(row(m.reply_message_id!).status, 'sent');

  // where sending is off, the reply is blocked and nothing is written
  const off = ingest(liveOff.org, { fromEmail: 'tenant@realdomain.com', fromName: 'Pat', to: [], subject: 'Hi', text: 'Hello there.' } as any, { via: 'manual' });
  const before = val<number>('SELECT COUNT(*) c FROM outbox_messages WHERE org_id=?', liveOff.org);
  const blocked = sendReply(ctxOf(liveOff), off.id, { subject: 'Re', text: 'Hello' });
  assert.equal(blocked.ok, false);
  assert.equal(val<number>('SELECT COUNT(*) c FROM outbox_messages WHERE org_id=?', liveOff.org), before);
});

test('One Inbox page: the reply form posts and sends', async () => {
  const got = ingest(live.org, { fromEmail: 'owner@realdomain.com', fromName: 'Olive Owner', to: [], subject: 'Statement question', text: 'Where is my statement?' } as any, { via: 'manual' });
  const page = await get(base, `/one-inbox/m/${got.id}`, cookieLive);
  assert.equal(page.status, 200);
  assert.match(page.text, /Send reply/);
  const res = await post(base, `/one-inbox/m/${got.id}/reply`, { subject: 'Re: Statement question', text: 'It is attached to your portal.' }, cookieLive);
  assert.ok(res.status === 302 || res.status === 303);
  await drain();
  assert.equal(sent.filter((m) => m.to === 'owner@realdomain.com').length, 1);
  // an organization with sending off sees no send button
  const o2 = ingest(liveOff.org, { fromEmail: 'owner@realdomain.com', fromName: 'O', to: [], subject: 'Q', text: 'A question here.' } as any, { via: 'manual' });
  const p2 = await get(base, `/one-inbox/m/${o2.id}`, cookieOff);
  assert.doesNotMatch(p2.text, /Send reply/);
});

test('Connections: the test email works before the switch is on, and says so', async () => {
  const page = await get(base, '/setup/connections', cookieOff);
  assert.match(page.text, /Send me a test email/);
  assert.match(page.text, /switched off for this organization/);
  const res = await post(base, '/setup/connections/test-email', {}, cookieOff);
  assert.ok(res.status === 302 || res.status === 303);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, liveOff.email);
  const t = q1<any>("SELECT * FROM outbox_messages WHERE org_id=? AND template_key='email_test'", liveOff.org);
  assert.equal(t.status, 'sent');
  const livePage = await get(base, '/setup/connections', cookieLive);
  assert.match(livePage.text, /delivered for real/);
});

test('htmlToText keeps the words and drops the markup', () => {
  const t = htmlToText('<p>Hello <a href="https://x.com/pay">pay here</a></p><style>p{}</style><ul><li>One</li><li>Two</li></ul>');
  assert.match(t, /Hello/);
  assert.match(t, /https:\/\/x\.com\/pay/);
  assert.doesNotMatch(t, /<|p\{\}/);
});
