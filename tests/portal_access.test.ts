import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { sysCtx, verifyPassword } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { ensurePortalAccess } from '../src/modules/people/portal.ts';

/** Client-onboarding audit fix: residents who arrive via the Migration Center
 * must get portal access like everyone else — a real credential for live
 * orgs, delivered in an invite the staff can read in the Message Console.
 * Without this, "upload your documents and you're started" produced residents
 * who could never sign in. */

let liveOrg: string;
let demoOrg: string;
let livePropId: string;
let demoPropId: string;

function mkResident(orgId: string, propId: string, email: string | null, first = 'Pat'): string {
  const rid = id('res');
  insert('residents', {
    id: rid, org_id: orgId, property_id: propId, user_id: null,
    first_name: first, last_name: 'Portal', email, phone: null, kind: 'adult',
    employer: null, monthly_income_cents: null, ssn_last4: null, created_at: nowIso(),
  });
  return rid;
}

before(() => {
  db();
  liveOrg = id('org');
  insert('orgs', { id: liveOrg, name: 'Portal Live Co', slug: 'plv-' + liveOrg.slice(-6), business_date: '2026-07-26', kind: 'live', created_at: nowIso() });
  ensureCoa(liveOrg);
  demoOrg = id('org');
  insert('orgs', { id: demoOrg, name: 'Portal Demo Co', slug: 'pdm-' + demoOrg.slice(-6), business_date: '2026-07-26', kind: 'demo', created_at: nowIso() });
  ensureCoa(demoOrg);
  livePropId = id('prp');
  insert('properties', {
    id: livePropId, org_id: liveOrg, name: 'Portal Pines', slug: 'portal-pines-' + liveOrg.slice(-4), type: 'multifamily',
    address1: '9 Login Ln', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso(),
  });
  demoPropId = id('prp');
  insert('properties', {
    id: demoPropId, org_id: demoOrg, name: 'Demo Pines', slug: 'demo-pines-' + demoOrg.slice(-4), type: 'multifamily',
    address1: '9 Demo Ln', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso(),
  });
});

test('live org: portal access = real one-time credential, delivered in the invite', () => {
  const ctx = sysCtx(liveOrg);
  const rid = mkResident(liveOrg, livePropId, 'pat.portal@example.test');
  const r = ensurePortalAccess(ctx, rid);
  assert.ok(r.userId, 'user created');
  assert.equal(r.invited, true);
  const user = q1<any>('SELECT * FROM users WHERE id=?', r.userId)!;
  assert.equal(user.kind, 'resident');
  assert.equal(verifyPassword('demo1234', user.password_hash), false, 'live orgs never get demo passwords');
  assert.equal(q1<any>('SELECT user_id FROM residents WHERE id=?', rid)!.user_id, r.userId, 'resident linked');
  const invite = q1<any>(
    `SELECT * FROM outbox_messages WHERE org_id=? AND template_key='portal_invite' AND entity_id=?`, liveOrg, rid,
  )!;
  assert.ok(invite, 'invite email recorded');
  assert.match(invite.subject, /Your resident portal is ready — Portal Pines/);
  const otp = /temporary password: <b>(sl-[0-9a-f]+)<\/b>/.exec(invite.body)?.[1];
  assert.ok(otp, 'the one-time password is in the invite');
  assert.equal(verifyPassword(otp!, user.password_hash), true, 'the delivered credential actually works');
});

test('idempotent: second call links, never duplicates or re-invites', () => {
  const ctx = sysCtx(liveOrg);
  const rid = mkResident(liveOrg, livePropId, 'once.only@example.test', 'Once');
  const first = ensurePortalAccess(ctx, rid);
  const second = ensurePortalAccess(ctx, rid);
  assert.equal(second.invited, false);
  assert.equal(second.userId, first.userId);
  assert.equal(q<any>(`SELECT id FROM users WHERE email='once.only@example.test'`).length, 1);
  assert.equal(q<any>(`SELECT id FROM outbox_messages WHERE org_id=? AND template_key='portal_invite' AND entity_id=?`, liveOrg, rid).length, 1);
});

test('no email → graceful no-op; existing account by email → linked, not recreated', () => {
  const ctx = sysCtx(liveOrg);
  const noEmail = mkResident(liveOrg, livePropId, null, 'Silent');
  assert.deepEqual(ensurePortalAccess(ctx, noEmail), { userId: null, invited: false });

  const shared = mkResident(liveOrg, livePropId, 'pat.portal@example.test', 'Second');
  const linked = ensurePortalAccess(ctx, shared);
  assert.equal(linked.invited, false, 'existing account is linked, not re-invited');
  assert.ok(linked.userId);
  assert.equal(q<any>(`SELECT id FROM users WHERE email='pat.portal@example.test'`).length, 1);
});

test('demo org: portal password stays demo1234 (the demo world is enterable)', () => {
  const ctx = sysCtx(demoOrg);
  const rid = mkResident(demoOrg, demoPropId, 'demo.res@example.test', 'Demo');
  const r = ensurePortalAccess(ctx, rid);
  const user = q1<any>('SELECT * FROM users WHERE id=?', r.userId)!;
  assert.equal(verifyPassword('demo1234', user.password_hash), true);
});
