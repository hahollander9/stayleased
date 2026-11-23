// The public tour form and the leasing emails, with the real email rail ON.
// Environment is set BEFORE anything reads it; node:test runs each file in its
// own process, so none of this leaks to other suites.
process.env.STAYLEASED_EMAIL_PROVIDER = 'postmark';
process.env.STAYLEASED_EMAIL_API_KEY = 'test-key-not-real';
process.env.STAYLEASED_EMAIL_FROM = 'office@mail.stayleased-fixture.com';
process.env.STAYLEASED_EMAIL_WEBHOOK_SECRET = 'whsec-fixture-0123456789';
process.env.STAYLEASED_EMAIL_DAILY_CAP_PER_ORG = '500';

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert, val } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword, sysCtx } from '../src/lib/auth.ts';
import { setSetting } from '../src/lib/settings.ts';
import { runJob } from '../src/lib/jobs.ts';
import { setEmailTransport, deliverEmailQueue, emailLive, type OutgoingEmail } from '../src/lib/email.ts';
import { intakeLead, bookTour, buildQuote, messageLead } from '../src/modules/m3_crm/service.ts';
import { startTestServer, loginAs } from './harness.ts';

/** Nothing here touches the network: every hand-off lands in `sent`, a fake
 * transport, and each test asserts what is in the database afterwards. */

const BD = '2026-08-10'; // a Monday
const TOUR_DAY = '2026-08-12';
const DAY_BEFORE = '2026-08-11';
const sfx = id('x').slice(-6);
const sent: OutgoingEmail[] = [];

interface Fx { org: string; email: string; uid: string; prop: string; slug: string; unit: string }
let base: string;
let close: () => void;
let live: Fx;
let liveOff: Fx;
let cookieLive: string;
let cookieOff: string;

function mkOrg(tag: string, on: boolean): Fx {
  const org = id('org');
  insert('orgs', { id: org, name: `Pub ${tag} ${sfx}`, slug: `fxp-${tag}-${sfx}`, kind: 'live', business_date: BD, created_at: nowIso() });
  const uid = id('usr');
  const email = `admin-pub-${tag}-${sfx}@fixture-mail.com`;
  insert('users', { id: uid, org_id: org, email, name: `Admin ${tag}`, kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso() });
  insert('role_assignments', { id: id('ra'), org_id: org, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  if (on) setSetting(sysCtx(org), 'email_delivery', true);
  const prop = id('prp');
  const slug = `fxp-prop-${tag}-${sfx}`;
  insert('properties', {
    id: prop, org_id: org, name: `Pub prop ${tag}`, slug, type: 'multifamily', address1: '1 Test St', city: 'Denver', state: 'CO', zip: '80202',
    timezone: 'America/Denver', marketing: JSON.stringify({ published: true }), created_at: nowIso(),
  });
  const unit = id('unt');
  insert('units', { id: unit, org_id: org, property_id: prop, unit_number: `P-${sfx}`, floor: 1, sqft: 800, status: 'vacant_ready', market_rent_cents: 160000, amenities: '[]', created_at: nowIso() });
  return { org, email, uid, prop, slug, unit };
}
const ctxOf = (f: Fx) => ({ ...sysCtx(f.org, BD), userId: f.uid, kind: 'staff' } as ReturnType<typeof sysCtx>);
const drain = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 5)); await deliverEmailQueue(); };
const mailFor = (org: string, to: string): any[] => q<any>('SELECT * FROM outbox_messages WHERE org_id=? AND to_addr=? ORDER BY created_at', org, to);
const leadByEmail = (org: string, email: string): any => q1<any>('SELECT * FROM leads WHERE org_id=? AND email=?', org, email);

async function postFlash(path: string, body: Record<string, string>, ck?: string): Promise<{ status: number; flash: string }> {
  const resp = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, ...(ck ? { cookie: ck } : {}) },
    body: new URLSearchParams(body).toString(), redirect: 'manual',
  });
  const m = /sl_fl=([^;]+)/.exec(resp.headers.get('set-cookie') || '');
  return { status: resp.status, flash: m ? decodeURIComponent(m[1]!) : '' };
}

before(async () => {
  db();
  live = mkOrg('on', true);
  liveOff = mkOrg('off', false);
  setEmailTransport(async (m) => { sent.push(m); return { ok: true, providerId: id('pm') }; });
  const s = await startTestServer();
  base = s.base; close = s.close;
  cookieLive = await loginAs(base, live.email);
  cookieOff = await loginAs(base, liveOff.email);
});
after(() => { setEmailTransport(null); close(); });
beforeEach(async () => { await drain(); sent.length = 0; });

test('fixture: email really is on for one live organization and off for the other', () => {
  assert.equal(emailLive(ctxOf(live)), true);
  assert.equal(emailLive(ctxOf(liveOff)), false);
});

test('a stranger booking on the public site makes nothing leave: confirmation and reminder are held', async () => {
  const victim = `victim-${sfx}@realdomain.com`;
  const r = await postFlash(`/p/${live.slug}/tour`, { first_name: 'Vi', last_name: 'Sitor', email: victim, date: TOUR_DAY, start_time: '11:00', type: 'in_person' });
  assert.equal(r.status, 303);
  assert.match(r.flash, /^ok\|.*leasing office will be in touch/, r.flash);
  const lead = leadByEmail(live.org, victim);
  assert.ok(lead, 'the lead was captured');
  const tour = q1<any>('SELECT * FROM tours WHERE lead_id=?', lead.id);
  assert.ok(tour, 'the tour was booked');
  assert.equal(tour.agent_user_id, null);
  await drain();
  let rows = mailFor(live.org, victim);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].template_key, 'tour_confirmation');
  assert.equal(rows[0].status, 'recorded');
  assert.equal(sent.length, 0, 'nothing reached the provider');

  // the day-before reminder for the same tour is written, and held too
  const job = runJob(sysCtx(live.org, DAY_BEFORE), 'tour_reminders', DAY_BEFORE);
  assert.equal(job.status, 'ok');
  assert.match(job.summary, /1 held in the Outbox/, job.summary);
  await drain();
  rows = mailFor(live.org, victim);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].template_key, 'tour_reminder');
  assert.equal(rows[1].status, 'recorded');
  assert.equal(sent.length, 0, 'still nothing reached the provider');
});

test('a tour a staff member books IS emailed, with the lead’s name escaped; its reminder goes out too', async () => {
  const to = `markup-${sfx}@realdomain.com`;
  const { leadId } = intakeLead(sysCtx(live.org, BD), { propertyId: live.prop, firstName: '<img src=x onerror=alert(1)>', lastName: 'Markup', email: to, source: 'website' });
  const r = await postFlash(`/leads/${leadId}/tour`, { date: TOUR_DAY, start_time: '13:00', type: 'virtual' }, cookieLive);
  assert.match(r.flash, /^ok\|Tour booked\. Email is on its way/, r.flash);
  assert.doesNotMatch(r.flash, /not emailed|not connected/);
  await drain(); // the queue may already have been kicked by the request itself
  assert.equal(mailFor(live.org, to)[0].status, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, to);
  assert.doesNotMatch(sent[0]!.html, /<img/i);
  assert.match(sent[0]!.html, /Hi &lt;img src=x onerror=alert\(1\)&gt;,/);
  assert.match(sent[0]!.html, /a virtual tour/);
  assert.equal(q1<any>('SELECT agent_user_id FROM tours WHERE lead_id=?', leadId).agent_user_id, live.uid);

  sent.length = 0;
  const job = runJob(sysCtx(live.org, DAY_BEFORE), 'tour_reminders', DAY_BEFORE);
  assert.match(job.summary, /1 reminder queued for delivery/, job.summary);
  await drain();
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0]!.html, /<img/i);
  assert.match(sent[0]!.html, /&lt;img/);
});

test('the public form rejects a time, type or day the property does not offer, and writes nothing', async () => {
  const bad: [string, Record<string, string>, RegExp][] = [
    ['markup as a time', { start_time: '<b>noon</b>', type: 'in_person', date: TOUR_DAY }, /not open on that day/],
    ['a time outside tour hours', { start_time: '03:00', type: 'in_person', date: TOUR_DAY }, /not open on that day/],
    ['no time at all', { type: 'in_person', date: TOUR_DAY }, /not open on that day/],
    ['an invented tour type', { start_time: '14:00', type: '<script>alert(1)</script>', date: TOUR_DAY }, /tour type from the list/],
    ['a day in the past', { start_time: '14:00', type: 'in_person', date: '2026-08-05' }, /tour day from the list/],
    ['a day far in the future', { start_time: '14:00', type: 'in_person', date: '2027-08-11' }, /tour day from the list/],
    ['a day the office is closed', { start_time: '14:00', type: 'in_person', date: '2026-08-16' }, /not open on that day/],
  ];
  for (const [label, fields, want] of bad) {
    const email = `bad-${id('b').slice(-6)}@realdomain.com`;
    const r = await postFlash(`/p/${live.slug}/tour`, { first_name: 'Bad', last_name: 'Input', email, ...fields });
    assert.match(r.flash, /^err\|/, `${label}: ${r.flash}`);
    assert.match(r.flash, want, `${label}: ${r.flash}`);
    assert.equal(leadByEmail(live.org, email), undefined, `${label}: no lead written`);
    assert.equal(mailFor(live.org, email).length, 0, `${label}: no message written`);
  }
  await drain();
  assert.equal(sent.length, 0);
});

test('names on the public forms are capped', async () => {
  const long = 'A'.repeat(81);
  const e1 = `long-tour-${sfx}@realdomain.com`;
  const t = await postFlash(`/p/${live.slug}/tour`, { first_name: long, last_name: 'Name', email: e1, date: TOUR_DAY, start_time: '15:00', type: 'in_person' });
  assert.match(t.flash, /^err\|.*up to 80 characters/, t.flash);
  assert.equal(leadByEmail(live.org, e1), undefined);
  const e2 = `long-inq-${sfx}@realdomain.com`;
  const i = await postFlash(`/p/${live.slug}/inquire`, { first_name: 'Name', last_name: long, email: e2 });
  assert.match(i.flash, /^err\|.*up to 80 characters/, i.flash);
  assert.equal(leadByEmail(live.org, e2), undefined);
  // 80 is fine, and the inquiry's free text is cut rather than stored whole
  const e3 = `ok-inq-${sfx}@realdomain.com`;
  const ok = await postFlash(`/p/${live.slug}/inquire`, { first_name: 'A'.repeat(80), last_name: 'Fine', email: e3, message: 'm'.repeat(9000), beds: 'lots', move_in: 'soon', phone: '<b>call me</b>' });
  assert.match(ok.flash, /^ok\|/, ok.flash);
  const lead = leadByEmail(live.org, e3);
  assert.ok(lead);
  assert.ok(lead.message.length <= 2000);
  assert.equal(lead.beds, null);
  assert.equal(lead.desired_move_in, null);
  assert.equal(lead.phone, null);
  assert.equal(mailFor(live.org, e3).length, 0, 'an inquiry writes no email to the address typed');
});

test('bookTour itself refuses a time or type that is not one', () => {
  const { leadId } = intakeLead(sysCtx(live.org, BD), { propertyId: live.prop, firstName: 'Svc', lastName: 'Guard', email: `svc-${sfx}@realdomain.com`, source: 'walk_in' });
  assert.throws(() => bookTour(ctxOf(live), { leadId, date: TOUR_DAY, startTime: '10:00</b><a href=x>' }), /tour time/);
  assert.throws(() => bookTour(ctxOf(live), { leadId, date: TOUR_DAY, startTime: '10:00', type: 'in_person<script>' }), /tour type/);
  assert.equal(val<number>('SELECT COUNT(*) FROM tours WHERE lead_id=?', leadId), 0);
});

test('a quote email escapes the concession note and the lead’s name', async () => {
  const to = `quote-${sfx}@realdomain.com`;
  const { leadId } = intakeLead(sysCtx(live.org, BD), { propertyId: live.prop, firstName: 'Q<u>', lastName: 'Uote', email: to, source: 'walk_in' });
  buildQuote(ctxOf(live), { leadId, unitId: live.unit, termMonths: 12, moveIn: '2026-09-01', concessionNote: '<script>alert(1)</script> half off & more' });
  await drain();
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0]!.html, /<script/i);
  assert.match(sent[0]!.html, /Special: &lt;script&gt;alert\(1\)&lt;\/script&gt; half off &amp; more/);
  assert.match(sent[0]!.html, /Hi Q&lt;u&gt;,/);
});

test('a message to a lead keeps simple formatting and turns everything else into text', async () => {
  const to = `msg-${sfx}@realdomain.com`;
  const { leadId } = intakeLead(sysCtx(live.org, BD), { propertyId: live.prop, firstName: 'Mes', lastName: 'Sage', email: to, source: 'walk_in' });
  messageLead(ctxOf(live), leadId, 'email', 'Hello', 'Line one\n<b>bold</b> <script>alert(1)</script> <img src=x onerror=y> 2 < 3');
  await drain();
  assert.equal(sent.length, 1);
  const html = sent[0]!.html;
  assert.doesNotMatch(html, /<script|<img/i);
  assert.match(html, /<b>bold<\/b>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Line one<br\/?>/);
  assert.match(html, /2 &lt; 3/);
});

test('a first email that really goes out marks a live lead contacted; a text, or an email with delivery off, does not', async () => {
  const mk = (f: Fx, tag: string): string => intakeLead(sysCtx(f.org, BD), {
    propertyId: f.prop, firstName: 'Con', lastName: tag, email: `con-${tag}-${sfx}@realdomain.com`, phone: `(303) 555-${String(1000 + Math.floor(Math.random() * 8999))}`, source: 'walk_in',
  }).leadId;
  const status = (leadId: string): string => q1<any>('SELECT status FROM leads WHERE id=?', leadId).status;

  const emailed = mk(live, 'emailed');
  const m = await postFlash(`/leads/${emailed}/message`, { channel: 'email', subject: 'Hello', body: 'Following up' }, cookieLive);
  assert.match(m.flash, /^ok\|Email is on its way/, m.flash);
  assert.equal(status(emailed), 'contacted');

  const texted = mk(live, 'texted');
  const s = await postFlash(`/leads/${texted}/message`, { channel: 'sms', body: 'Following up' }, cookieLive);
  assert.match(s.flash, /^ok\|Saved to the Outbox — text messages are not connected yet/, s.flash);
  assert.equal(status(texted), 'new');

  const off = mk(liveOff, 'off');
  const o = await postFlash(`/leads/${off}/message`, { channel: 'email', subject: 'Hello', body: 'Following up' }, cookieOff);
  assert.match(o.flash, /^ok\|Saved to the Outbox — email and text delivery are not connected yet\.$/, o.flash);
  assert.equal(status(off), 'new');
  await drain();
  assert.equal(sent.length, 1, 'only the first of the three left');
});

test('tour and quote flashes follow what was written', async () => {
  // delivery off: saved, and said so
  const offLead = intakeLead(sysCtx(liveOff.org, BD), { propertyId: liveOff.prop, firstName: 'Off', lastName: 'Flash', email: `off-${sfx}@realdomain.com`, source: 'walk_in' }).leadId;
  const t = await postFlash(`/leads/${offLead}/tour`, { date: TOUR_DAY, start_time: '10:00', type: 'in_person' }, cookieOff);
  assert.match(t.flash, /^ok\|Tour booked\. The confirmation was not emailed/, t.flash);
  const qo = await postFlash(`/leads/${offLead}/quote`, { unit_id: liveOff.unit, term_months: '12', move_in: '2026-09-01' }, cookieOff);
  assert.match(qo.flash, /^ok\|Quote built\. It was not emailed/, qo.flash);

  // delivery on: the quote is on its way
  const onLead = intakeLead(sysCtx(live.org, BD), { propertyId: live.prop, firstName: 'On', lastName: 'Flash', email: `on-${sfx}@realdomain.com`, source: 'walk_in' }).leadId;
  const qn = await postFlash(`/leads/${onLead}/quote`, { unit_id: live.unit, term_months: '12', move_in: '2026-09-01' }, cookieLive);
  assert.match(qn.flash, /^ok\|Quote built\. Email is on its way/, qn.flash);

  // no address on file: nothing was written, and the flash does not pretend otherwise
  const noEmail = intakeLead(sysCtx(live.org, BD), { propertyId: live.prop, firstName: 'No', lastName: 'Email', phone: '(303) 555-0142', source: 'phone' }).leadId;
  const tn = await postFlash(`/leads/${noEmail}/tour`, { date: TOUR_DAY, start_time: '16:00', type: 'in_person' }, cookieLive);
  assert.match(tn.flash, /^ok\|Tour booked\. No confirmation was written/, tn.flash);
  await drain();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, `on-${sfx}@realdomain.com`);
});
