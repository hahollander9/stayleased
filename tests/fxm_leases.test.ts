// Invitations and signing links on the real email rail. Environment is set
// BEFORE anything reads it; node:test runs each file in its own process.
process.env.STAYLEASED_EMAIL_PROVIDER = 'postmark';
process.env.STAYLEASED_EMAIL_API_KEY = 'test-key-not-real';
process.env.STAYLEASED_EMAIL_FROM = 'office@mail.stayleased-fixture.com';
process.env.STAYLEASED_EMAIL_DAILY_CAP_PER_ORG = '500';
process.env.STAYLEASED_SITE_ORIGIN = 'https://app.stayleased-fixture.com/';

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { sysCtx } from '../src/lib/auth.ts';
import { setSetting } from '../src/lib/settings.ts';
import { RECORDED } from '../src/lib/sim/messaging.ts';
import { setEmailTransport, deliverEmailQueue, emailLive, type OutgoingEmail } from '../src/lib/email.ts';
import { ensurePortalAccess, sendPortalInvite } from '../src/modules/people/portal.ts';
import { portalAccessFor } from '../src/modules/setup/import_apply.ts';
import { startSignatureRequest, recordSignature } from '../src/modules/m6_leases/service.ts';

/** Nothing here touches the network: every hand-off lands in `sent`, a fake
 * transport. An import must never reach it; one invite sent by staff must. */

const ORIGIN = 'https://app.stayleased-fixture.com';
const sent: OutgoingEmail[] = [];
const sfx = id('x').slice(-6);
let live: string;
let demo: string;
let liveProp: string;
let demoProp: string;

function mkOrg(kind: 'demo' | 'live'): { org: string; prop: string } {
  const org = id('org');
  insert('orgs', { id: org, name: `Invite ${kind} ${sfx}`, slug: `fxm-${kind}-${sfx}`, kind, business_date: '2026-07-26', created_at: nowIso() });
  setSetting(sysCtx(org), 'email_delivery', true);
  const prop = id('prp');
  insert('properties', {
    id: prop, org_id: org, name: `Invite Court ${kind}`, slug: `invite-court-${kind}-${sfx}`, type: 'multifamily',
    address1: '1 Invite Ct', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso(),
  });
  return { org, prop };
}
function mkResident(org: string, prop: string, email: string, first = 'Pat'): string {
  const rid = id('res');
  insert('residents', {
    id: rid, org_id: org, property_id: prop, user_id: null,
    first_name: first, last_name: 'Invite', email, phone: null, kind: 'adult',
    employer: null, monthly_income_cents: null, ssn_last4: null, created_at: nowIso(),
  });
  return rid;
}
const ctxOf = (org: string) => ({ ...sysCtx(org), orgKind: org === demo ? 'demo' : 'live' } as ReturnType<typeof sysCtx>);
const invite = (rid: string): any => q1<any>(`SELECT * FROM outbox_messages WHERE entity='resident' AND entity_id=? AND template_key='portal_invite'`, rid);
const drain = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 5)); await deliverEmailQueue(); };

before(() => {
  db();
  ({ org: live, prop: liveProp } = mkOrg('live'));
  ({ org: demo, prop: demoProp } = mkOrg('demo'));
  setEmailTransport(async (m) => { sent.push(m); return { ok: true, providerId: id('pm') }; });
});
after(() => { setEmailTransport(null); });
beforeEach(async () => { await drain(); sent.length = 0; });

test('held portal access in a live org with email on: login created, invite recorded, nothing sent', async () => {
  const ctx = ctxOf(live);
  assert.equal(emailLive(ctx), true, 'the fixture really has email on');
  const rid = mkResident(live, liveProp, `held-${sfx}@realdomain.com`);
  const out = ensurePortalAccess(ctx, rid, { hold: true });
  assert.equal(out.invited, true);
  assert.ok(out.userId, 'the login exists');
  await drain();
  const m = invite(rid);
  assert.equal(m.status, RECORDED);
  assert.equal(m.provider_id, null);
  assert.equal(sent.length, 0, 'the provider never saw it');
});

test('an import provisions through the held path: a whole building, no mail', async () => {
  const ctx = ctxOf(live);
  const rids = Array.from({ length: 12 }, (_, i) => mkResident(live, liveProp, `roll-${i}-${sfx}@realdomain.com`, `Res${i}`));
  let invites = 0;
  for (const rid of rids) if (portalAccessFor(ctx, id('imp'), rid)) invites++;
  assert.equal(invites, 12);
  await drain();
  assert.equal(sent.length, 0, 'applying an import mails nobody');
  for (const rid of rids) assert.equal(invite(rid).status, RECORDED);
});

test('one resident invited by staff is queued, sent, and carries an absolute https sign-in link', async () => {
  const ctx = ctxOf(live);
  const rid = mkResident(live, liveProp, `single-${sfx}@realdomain.com`);
  const out = ensurePortalAccess(ctx, rid);
  assert.equal(out.invited, true);
  assert.equal(invite(rid).status, 'queued');
  await drain();
  const m = invite(rid);
  assert.equal(m.status, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, `single-${sfx}@realdomain.com`);
  assert.ok(m.body.includes(`<a href="${ORIGIN}/login">${ORIGIN}/login</a>`), 'absolute sign-in link, trailing slash on the origin dropped');
  assert.ok(sent[0]!.html.includes(`${ORIGIN}/login`));
  assert.doesNotMatch(m.body, /href="\//, 'no relative link in an email body');
});

test('the first name is escaped in the invite body', () => {
  const ctx = ctxOf(live);
  const rid = mkResident(live, liveProp, `esc-${sfx}@realdomain.com`);
  sendPortalInvite(ctx, {
    residentId: rid, email: `esc-${sfx}@realdomain.com`, firstName: '<img src=x onerror=alert(1)>', name: 'X',
    propertyId: liveProp, oneTime: 'sl-000000000000',
  }, { hold: true });
  const m = invite(rid);
  assert.doesNotMatch(m.body, /<img/);
  assert.match(m.body, /&lt;img/);
  assert.equal(m.status, RECORDED);
});

test('demo: hold changes nothing, and with no origin configured the link stays relative', () => {
  const saved = process.env.STAYLEASED_SITE_ORIGIN;
  delete process.env.STAYLEASED_SITE_ORIGIN;
  try {
    const ctx = ctxOf(demo);
    const rid = mkResident(demo, demoProp, `demo-${sfx}@oakline.demo`);
    ensurePortalAccess(ctx, rid, { hold: true });
    const m = invite(rid);
    assert.equal(m.status, 'sent', 'the simulator keeps its own status');
    assert.ok(m.body.includes('<a href="/login">/login</a>'));
  } finally {
    process.env.STAYLEASED_SITE_ORIGIN = saved;
  }
  assert.equal(sent.length, 0);
});

test('e-signature: resident and countersigner emails carry absolute links, whatever base the request offered', async () => {
  const ctx = { ...ctxOf(live), userName: 'Olive Office' } as ReturnType<typeof sysCtx>;
  const unit = id('unt');
  insert('units', { id: unit, org_id: live, property_id: liveProp, unit_number: '101', floor: 1, sqft: 800, status: 'vacant_ready', market_rent_cents: 150000, amenities: '[]', created_at: nowIso() });
  const leaseId = id('lse');
  insert('leases', {
    id: leaseId, org_id: live, property_id: liveProp, unit_id: unit, household_name: 'Rhea Resident', status: 'draft',
    start_date: '2026-08-01', end_date: '2027-07-31', move_in_date: '2026-08-01',
    rent_cents: 150000, deposit_cents: 0, term_months: 12, created_at: nowIso(),
  });
  const reqId = startSignatureRequest(ctx, leaseId, 'lease', { fileId: id('fil'), sha256: 'a'.repeat(64) }, [
    { name: 'Rhea Resident', email: `rhea-${sfx}@realdomain.com`, role: 'resident' },
    { name: 'Olive Office', email: `olive-${sfx}@realdomain.com`, role: 'countersigner' },
  ], 'http://attacker.example:3000');
  const signers = q<any>('SELECT * FROM signature_signers WHERE request_id=? ORDER BY order_idx', reqId);
  const inviteMail = q1<any>(`SELECT * FROM outbox_messages WHERE entity_id=? AND template_key='esign_invite'`, reqId);
  assert.ok(inviteMail.body.includes(`href="${ORIGIN}/sign/${signers[0].token}"`));
  assert.doesNotMatch(inviteMail.body, /attacker\.example/, 'the Host header never reaches an email');

  const res = recordSignature(ctx, signers[0].token, { kind: 'typed', text: 'Rhea Resident', initials: 'RR' });
  assert.equal(res.complete, false);
  const counter = q1<any>(`SELECT * FROM outbox_messages WHERE entity_id=? AND template_key='esign_countersign'`, reqId);
  assert.ok(counter, 'the countersigner was told');
  assert.ok(counter.body.includes(`<a href="${ORIGIN}/sign/${signers[1].token}">${ORIGIN}/sign/${signers[1].token}</a>`));
  assert.doesNotMatch(counter.body, /href="\//);
  await drain();
  assert.ok(sent.some((m) => m.html.includes(`${ORIGIN}/sign/${signers[1].token}`)), 'and that is what the provider was handed');
});
