import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert, val, run } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso, addDays, addMonths, monthKey, daysInMonth, parts } from '../src/lib/dates.ts';
import { hashPassword, sysCtx } from '../src/lib/auth.ts';
import { putFile } from '../src/lib/files.ts';
import { runJob } from '../src/lib/jobs.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { accountBalance } from '../src/modules/m9_accounting/service.ts';
import { leaseBalance } from '../src/modules/m8_receivables/service.ts';
import { depositHeld } from '../src/modules/m8_receivables/payments.ts';
import { activateLease, createLeaseManual, recordMoveOut } from '../src/modules/m6_leases/service.ts';
import { createApplication, consumerReportNotice } from '../src/modules/m5_screening/service.ts';
import { marketingOf } from '../src/modules/m4_marketing/public.ts';
import { startTestServer, loginAs, get, post } from './harness.ts';

/** A real (live, non-demo) company working its leases by hand: create a lease
 * for a vacant unit, have it activate and bill, record notice and move-out,
 * edit the household, take an application at the office. Every test asserts
 * what is in the database afterwards. Own org fixture. */

let base: string;
let close: () => void;
let org: string;
let prop: string;
let slug: string;
let admin: string;
let cookie: string;
const sfx = id('x').slice(-6);
const units: Record<string, string> = {};

const bd = (): string => q1<{ business_date: string }>('SELECT business_date FROM orgs WHERE id=?', org)!.business_date;
const ctx = (date?: string) => sysCtx(org, date);
const lease = (leaseId: string): any => q1<any>('SELECT * FROM leases WHERE id=?', leaseId);
const unit = (u: string): any => q1<any>('SELECT * FROM units WHERE id=?', units[u]!);
const leaseIdFrom = (location: string | null): string => /\/leases\/([a-z0-9_]+)/i.exec(location || '')![1]!;

/** POST, then read the one-shot flash message the redirect set */
async function postFlash(path: string, body: Record<string, string>, ck: string): Promise<{ status: number; location: string | null; flash: string }> {
  const resp = await fetch(base + path, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, cookie: ck },
    body: new URLSearchParams(body).toString(),
  });
  const m = /sl_fl=([^;]+)/.exec(resp.headers.get('set-cookie') || '');
  return { status: resp.status, location: resp.headers.get('location'), flash: m ? decodeURIComponent(m[1]!) : '' };
}

function newLeaseBody(u: string, over: Record<string, string> = {}): Record<string, string> {
  const today = bd();
  return {
    unit_id: units[u]!, p0_first: 'Dana', p0_last: `Okafor${u}`, p0_email: `dana-${u}-${sfx}@example.test`, p0_phone: '303-555-0100',
    start_date: today, end_date: addDays(addMonths(today, 12), -1), rent: '1,500.00', deposit: '1000', deposit_on_hand: 'no', signed: 'yes',
    ...over,
  };
}

/** a portal login for one resident on a lease */
function portalUser(leaseId: string, role = 'primary'): { email: string; residentId: string; userId: string } {
  const res = q1<any>(`SELECT r.* FROM household_members hm JOIN residents r ON r.id=hm.resident_id WHERE hm.lease_id=? AND hm.role=?`, leaseId, role);
  const uid = id('usr');
  const email = `portal-${uid.slice(-6)}@example.test`;
  insert('users', { id: uid, org_id: org, email, name: `${res.first_name} ${res.last_name}`, kind: 'resident', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso() });
  run('UPDATE residents SET user_id=?, email=? WHERE id=?', uid, email, res.id);
  return { email, residentId: res.id, userId: uid };
}

before(async () => {
  db();
  org = id('org');
  insert('orgs', { id: org, name: `Lease live ${sfx}`, slug: `lease-live-${sfx}`, kind: 'live', business_date: '2026-07-26', created_at: nowIso() });
  ensureCoa(org);
  const uid = id('usr');
  admin = `admin-lease-${sfx}@example.test`;
  insert('users', { id: uid, org_id: org, email: admin, name: 'Lease Admin', kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso() });
  insert('role_assignments', { id: id('ra'), org_id: org, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  prop = id('prp');
  slug = `lease-prop-${sfx}`;
  insert('properties', { id: prop, org_id: org, name: 'Maple Court', slug, type: 'multifamily', address1: '1 Test St', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso() });
  for (const n of ['101', '102', '103', '104', '105', '106', '107', '108', '109', '110']) {
    units[n] = id('unt');
    insert('units', { id: units[n], org_id: org, property_id: prop, unit_number: n, floor: 1, sqft: 800, status: 'vacant_ready', market_rent_cents: 150000, amenities: '[]', created_at: nowIso() });
  }
  const s = await startTestServer();
  base = s.base; close = s.close;
  cookie = await loginAs(base, admin);
});
after(() => close());

// ---------- items 9 + 37: a lease entered by hand ----------

test('9/37: a lease entered by hand activates, bills prorated rent, and records a deposit already held', async () => {
  const today = bd();
  const { y, m, day } = parts(today);
  const form = await get(base, '/leases/new', cookie);
  assert.equal(form.status, 200);
  assert.match(form.text, /Has the deposit been collected\?/);
  assert.match(form.text, /Maple Court · 101/);

  const r = await postFlash('/leases/new', newLeaseBody('101', {
    deposit_on_hand: 'yes', p1_first: 'Sam', p1_last: 'Okafor101', p1_role: 'co', p2_first: 'Kid', p2_last: 'Okafor101', p2_role: 'occupant',
  }), cookie);
  assert.equal(r.status, 303, r.flash);
  const leaseId = leaseIdFrom(r.location);
  const l = lease(leaseId);
  assert.equal(l.status, 'active');
  assert.equal(l.rent_cents, 150000);
  assert.equal(l.deposit_cents, 100000);
  assert.equal(l.deposit_on_hand, 1);
  assert.equal(l.household_name, 'Okafor101 household');
  assert.equal(unit('101').status, 'occupied');

  // people
  const hm = q<any>(`SELECT hm.role, r.first_name, r.kind FROM household_members hm JOIN residents r ON r.id=hm.resident_id WHERE hm.lease_id=? ORDER BY hm.role`, leaseId);
  assert.deepEqual(hm.map((x) => x.role).sort(), ['co', 'occupant', 'primary']);

  // rent billed by the rent-posting code from the start date: prorated first month
  const dim = daysInMonth(y, m);
  const expectRent = day === 1 ? 150000 : Math.round((150000 * (dim - day + 1)) / dim);
  const rent = q<any>(`SELECT * FROM charges WHERE lease_id=? AND kind='rent'`, leaseId);
  assert.equal(rent.length, 1);
  assert.equal(rent[0].amount_cents, expectRent);
  assert.equal(rent[0].month_key, monthKey(today));
  assert.equal(rent[0].source, 'recurring');

  // deposit already in the bank: held, not billed, liability on both books
  assert.equal(val<number>(`SELECT COUNT(*) FROM charges WHERE lease_id=? AND kind='deposit'`, leaseId), 0);
  assert.equal(leaseBalance(ctx(), leaseId), expectRent, 'the household owes rent only');
  assert.equal(depositHeld(ctx(), leaseId), 100000);
  for (const basis of ['accrual', 'cash'] as const) {
    assert.equal(accountBalance(ctx(), '2100', { propertyId: prop, basis }), -100000, `deposit liability (${basis})`);
    assert.equal(accountBalance(ctx(), '1020', { propertyId: prop, basis }), 100000, `deposit cash (${basis})`);
  }

  // it shows where an operator looks for it
  assert.match((await get(base, '/residents', cookie)).text, /Okafor101/);
  assert.match((await get(base, '/leases', cookie)).text, /Okafor101 household/);
  const ledger = await get(base, `/leases/${leaseId}?tab=ledger`, cookie);
  assert.match(ledger.text, /Rent — 101/);
  assert.match((await get(base, '/deposits', cookie)).text, /Okafor101 household/);

  // the unit is taken: a second lease on it is refused and nothing is written
  const before2 = val<number>('SELECT COUNT(*) FROM leases WHERE unit_id=?', units['101']!);
  const dup = await post(base, '/leases/new', newLeaseBody('101'), cookie);
  assert.equal(dup.status, 200);
  assert.match(dup.text, /Choose a unit|already has a current lease/);
  assert.equal(val<number>('SELECT COUNT(*) FROM leases WHERE unit_id=?', units['101']!), before2);

  // the daily rent run does not bill the month twice
  runJob(ctx(), 'rent_posting', today);
  assert.equal(val<number>(`SELECT COUNT(*) FROM charges WHERE lease_id=? AND kind='rent'`, leaseId), 1);
});

test('9: a deposit not yet collected is billed at move-in and becomes held when paid', async () => {
  const r = await postFlash('/leases/new', newLeaseBody('102'), cookie);
  const leaseId = leaseIdFrom(r.location);
  assert.equal(lease(leaseId).status, 'active');
  const dep = q<any>(`SELECT * FROM charges WHERE lease_id=? AND kind='deposit'`, leaseId);
  assert.equal(dep.length, 1);
  assert.equal(dep[0].amount_cents, 100000);
  assert.equal(lease(leaseId).deposit_on_hand, 0);
  assert.ok(leaseBalance(ctx(), leaseId) > 100000, 'rent and the deposit are both owed');
  assert.ok(q1(`SELECT id FROM move_checklists WHERE lease_id=? AND kind='move_in'`, leaseId), 'move-in checklist created');
});

test('9: a signed lease that starts later waits for its start date; a draft does not occupy the unit', async () => {
  const today = bd();
  const start = addDays(today, 10);
  const r = await postFlash('/leases/new', newLeaseBody('103', { start_date: start, end_date: addDays(addMonths(start, 12), -1) }), cookie);
  const leaseId = leaseIdFrom(r.location);
  assert.equal(lease(leaseId).status, 'fully_executed');
  assert.match(r.flash, /becomes active on/);
  assert.equal(unit('103').status, 'vacant_ready');
  assert.equal(val<number>('SELECT COUNT(*) FROM charges WHERE lease_id=?', leaseId), 0, 'nothing billed before the start');
  runJob(ctx(start), 'lease_activation', start);
  assert.equal(lease(leaseId).status, 'active');
  assert.equal(unit('103').status, 'occupied');
  assert.equal(val<number>(`SELECT COUNT(*) FROM charges WHERE lease_id=? AND kind='rent'`, leaseId), 1);

  const d = await postFlash('/leases/new', newLeaseBody('104', { signed: 'no' }), cookie);
  const draftId = leaseIdFrom(d.location);
  assert.equal(lease(draftId).status, 'draft');
  assert.equal(unit('104').status, 'vacant_ready');
  assert.match((await get(base, `/leases/${draftId}?tab=esign`, cookie)).text, /send for signature/i);
});

test('9: a household already living here is billed from the chosen month, with its balance carried in', async () => {
  const today = bd();
  const billFrom = today.slice(0, 8) + '01';
  const r = await postFlash('/leases/new', newLeaseBody('105', {
    start_date: addMonths(billFrom, -10), end_date: addDays(addMonths(billFrom, 2), -1),
    billing_start_date: billFrom, opening_balance: '250.00', deposit_on_hand: 'yes',
  }), cookie);
  assert.equal(r.status, 303, r.flash);
  const leaseId = leaseIdFrom(r.location);
  assert.equal(lease(leaseId).status, 'active');
  const charges = q<any>('SELECT kind, amount_cents, month_key FROM charges WHERE lease_id=? ORDER BY kind', leaseId);
  assert.deepEqual(charges.map((c) => [c.kind, c.amount_cents]), [['opening_balance', 25000], ['rent', 150000]]);
  assert.equal(charges[1]!.month_key, monthKey(today), 'only the current month — no history re-billed');
  assert.equal(leaseBalance(ctx(), leaseId), 175000);

  // without a billing start, a years-old lease is refused rather than re-billed
  const old = await post(base, '/leases/new', newLeaseBody('106', { start_date: addMonths(billFrom, -30), end_date: addMonths(billFrom, 6) }), cookie);
  assert.equal(old.status, 200);
  assert.match(old.text, /start billing from/i);
  assert.equal(val<number>('SELECT COUNT(*) FROM leases WHERE unit_id=?', units['106']!), 0);
});

// ---------- item 38: renewals ----------

test('38: a renewal cannot be activated before it starts, and a mid-month renewal bills no day twice', async () => {
  const today = bd();
  const { y, m } = parts(today);
  const dim = daysInMonth(y, m);
  const monthStart = today.slice(0, 8) + '01';
  // an existing tenancy whose term ends on the 14th of this month, billed in full on the 1st
  const first = createLeaseManual(ctx(monthStart), {
    unitId: units['107']!, people: [{ firstName: 'Rae', lastName: 'Renewer', role: 'primary', email: `rae-${sfx}@example.test` }],
    startDate: addMonths(monthStart, -6), endDate: today.slice(0, 8) + '14', rentCents: 120000, depositCents: 0, depositOnHand: false,
    billingStartDate: monthStart, signed: true,
  });
  assert.equal(val<number>(`SELECT amount_cents FROM charges WHERE lease_id=? AND kind='rent'`, first.leaseId), 120000);
  const renewalStart = today.slice(0, 8) + '15';
  const renewalId = id('lse');
  insert('leases', {
    id: renewalId, org_id: org, property_id: prop, unit_id: units['107']!, household_name: 'Rae Renewer', status: 'fully_executed',
    start_date: renewalStart, end_date: addDays(addMonths(renewalStart, 12), -1), move_in_date: addMonths(monthStart, -6),
    rent_cents: 130000, deposit_cents: 0, term_months: 12, renewal_of_lease_id: first.leaseId, created_at: nowIso(),
  });
  insert('lease_charges', { id: id('lc'), org_id: org, lease_id: renewalId, kind: 'rent', label: 'Rent — 107', amount_cents: 130000, created_at: nowIso() });

  // before its start date: refused, and neither lease moves
  run('UPDATE orgs SET business_date=? WHERE id=?', today.slice(0, 8) + '10', org);
  try {
    const page = await get(base, `/leases/${renewalId}?tab=esign`, cookie);
    assert.doesNotMatch(page.text, /Activate lease now/);
    const early = await postFlash(`/leases/${renewalId}/activate`, {}, cookie);
    assert.match(early.flash, /^err\|A renewal becomes active on its start date/);
    assert.equal(lease(renewalId).status, 'fully_executed');
    assert.equal(lease(first.leaseId).status, 'active');
    assert.equal(val<number>('SELECT COUNT(*) FROM charges WHERE lease_id=?', renewalId), 0);
  } finally {
    run('UPDATE orgs SET business_date=? WHERE id=?', today, org);
  }

  // on its start date
  activateLease(ctx(renewalStart), renewalId);
  assert.equal(lease(renewalId).status, 'active');
  assert.equal(lease(first.leaseId).status, 'renewed');
  const newRent = q<any>(`SELECT amount_cents, date FROM charges WHERE lease_id=? AND kind='rent' AND source='recurring'`, renewalId);
  assert.equal(newRent.length, 1);
  assert.equal(newRent[0].amount_cents, Math.round((130000 * (dim - 14)) / dim), 'renewal bills from its own start date');
  assert.equal(newRent[0].date, renewalStart);
  // the prior term keeps 14 days of rent; the rest is credited; the balance moves to the renewal
  const oldRentNet = val<number>(`SELECT SUM(amount_cents) FROM charges WHERE lease_id=? AND kind='rent' AND status='active'`, first.leaseId);
  assert.equal(oldRentNet, Math.round((120000 * 14) / dim));
  assert.equal(leaseBalance(ctx(renewalStart), first.leaseId), 0);
  assert.equal(leaseBalance(ctx(renewalStart), renewalId), Math.round((120000 * 14) / dim) + Math.round((130000 * (dim - 14)) / dim));
});

// ---------- item 39: the signed lease in the portal ----------

test('39: everyone on the household can open the signed lease; another household cannot', async () => {
  const mine = q1<any>(`SELECT id FROM leases WHERE unit_id=? AND status='active'`, units['101']!).id;
  const theirs = q1<any>(`SELECT id FROM leases WHERE unit_id=? AND status='active'`, units['102']!).id;
  const file = putFile(ctx(), new TextEncoder().encode('%PDF-1.4 signed lease'), {
    name: 'lease-executed.pdf', mime: 'application/pdf', entity: 'lease', entityId: mine, visibility: 'resident',
  });
  const primary = portalUser(mine, 'primary');
  const co = portalUser(mine, 'co');
  const stranger = portalUser(theirs, 'primary');
  for (const who of [primary, co]) {
    const ck = await loginAs(base, who.email);
    assert.equal((await get(base, `/f/${file.id}`, ck)).status, 200);
    assert.match((await get(base, '/portal/lease', ck)).text, /lease-executed\.pdf/);
  }
  assert.notEqual((await get(base, `/f/${file.id}`, await loginAs(base, stranger.email))).status, 200);
  assert.notEqual((await get(base, `/f/${file.id}`)).status, 200);
});

// ---------- items 40 + 56: notice and move-out, recorded by staff ----------

test('56/40: staff record notice (unit on notice, make-ready opened), withdraw it, and record the move-out', async () => {
  const today = bd();
  const leaseId = q1<any>(`SELECT id FROM leases WHERE unit_id=? AND status='active'`, units['102']!).id;
  const page = await get(base, `/leases/${leaseId}?tab=overview`, cookie);
  assert.match(page.text, /Record notice to vacate/);
  assert.match(page.text, /Record the move-out/);

  const planned = addDays(today, 30);
  let r = await postFlash(`/leases/${leaseId}/notice`, { notice_date: today, move_out: planned }, cookie);
  assert.match(r.flash, /^ok\|Notice recorded/);
  assert.equal(lease(leaseId).status, 'notice');
  assert.equal(lease(leaseId).move_out_date, planned);
  assert.equal(lease(leaseId).notice_date, today);
  assert.equal(unit('102').status, 'notice');
  const turn = q1<any>(`SELECT * FROM turns WHERE lease_id=?`, leaseId);
  assert.ok(turn, 'the notice opens the make-ready');
  assert.equal(turn.move_out_date, planned);

  r = await postFlash(`/leases/${leaseId}/notice/withdraw`, {}, cookie);
  assert.match(r.flash, /^ok\|/);
  assert.equal(lease(leaseId).status, 'active');
  assert.equal(lease(leaseId).move_out_date, null);
  assert.equal(unit('102').status, 'occupied');
  assert.equal(q1<any>('SELECT status FROM turns WHERE id=?', turn.id).status, 'canceled');

  // a move-out date in the future is notice, not a move-out
  r = await postFlash(`/leases/${leaseId}/move-out`, { move_out: addDays(today, 5) }, cookie);
  assert.match(r.flash, /^err\|/);
  assert.equal(lease(leaseId).status, 'active');

  // moved out today, with no notice on file
  r = await postFlash(`/leases/${leaseId}/move-out`, { move_out: today }, cookie);
  assert.match(r.flash, /^ok\|Move-out recorded/);
  assert.equal(lease(leaseId).status, 'ended');
  assert.equal(lease(leaseId).move_out_date, today);
  const u = unit('102');
  assert.equal(u.status, 'vacant_not_ready');
  assert.equal(u.vacant_since, today);
  assert.ok(q1(`SELECT id FROM turns WHERE lease_id=? AND status IN ('scheduled','in_progress')`, leaseId), 'a make-ready is open for the vacated unit');
  assert.ok(q1(`SELECT id FROM audit_events WHERE org_id=? AND entity_id=? AND action='move_out'`, org, leaseId), 'audited');
  // rent stops: the next month is not billed
  runJob(ctx(addMonths(today, 1)), 'rent_posting', addMonths(today, 1));
  assert.equal(val<number>(`SELECT COUNT(*) FROM charges WHERE lease_id=? AND month_key=?`, leaseId, monthKey(addMonths(today, 1))), 0);
  // and the unit can be leased again
  assert.match((await get(base, '/leases/new', cookie)).text, /Maple Court · 102/);
});

test('40: a lease on notice ends on its move-out day through the daily job, after a notice recorded by staff', async () => {
  const today = bd();
  const made = createLeaseManual(ctx(), {
    unitId: units['108']!, people: [{ firstName: 'Noor', lastName: 'Leaving', role: 'primary' }],
    startDate: today, endDate: addDays(addMonths(today, 12), -1), rentCents: 100000, depositCents: 50000, depositOnHand: true, signed: true,
  });
  const planned = addDays(today, 20);
  const r = await postFlash(`/leases/${made.leaseId}/notice`, { notice_date: today, move_out: planned }, cookie);
  assert.match(r.flash, /^ok\|/);
  runJob(ctx(planned), 'lease_moveouts', planned);
  assert.equal(lease(made.leaseId).status, 'ended');
  assert.equal(unit('108').status, 'vacant_not_ready', 'the unit leaves "notice" because the notice set it there');
  assert.equal(depositHeld(ctx(planned), made.leaseId), 50000, 'the deposit entered as held is there to settle');
  // recording a move-out twice is refused
  assert.throws(() => recordMoveOut(ctx(planned), made.leaseId, planned), /current lease/);
});

// ---------- item 42: editing residents and households ----------

test('42: staff correct a resident, add a person to the household, and remove one', async () => {
  const leaseId = q1<any>(`SELECT id FROM leases WHERE unit_id=? AND status='active'`, units['101']!).id;
  const primary = q1<any>(`SELECT r.* FROM household_members hm JOIN residents r ON r.id=hm.resident_id WHERE hm.lease_id=? AND hm.role='primary'`, leaseId);
  assert.ok(primary.user_id, 'has a portal login from the earlier test');
  const newEmail = `dana-new-${sfx}@example.test`;
  let r = await postFlash(`/residents/${primary.id}`, { first_name: 'Dana', last_name: 'Okafor-Reyes', email: newEmail, phone: '720-555-0199' }, cookie);
  assert.match(r.flash, /^ok\|/);
  const after1 = q1<any>('SELECT * FROM residents WHERE id=?', primary.id);
  assert.equal(after1.last_name, 'Okafor-Reyes');
  assert.equal(after1.email, newEmail);
  assert.equal(after1.phone, '720-555-0199');
  assert.equal(q1<any>('SELECT email FROM users WHERE id=?', primary.user_id).email, newEmail, 'the portal sign-in follows the email');
  assert.ok(q1(`SELECT id FROM audit_events WHERE org_id=? AND entity='resident' AND entity_id=? AND action='update'`, org, primary.id));

  r = await postFlash(`/residents/${primary.id}`, { first_name: 'Dana', last_name: 'Okafor-Reyes', email: 'not-an-email', phone: '' }, cookie);
  assert.match(r.flash, /^err\|/);
  assert.equal(q1<any>('SELECT email FROM residents WHERE id=?', primary.id).email, newEmail);

  r = await postFlash(`/leases/${leaseId}/household`, { first_name: 'Gus', last_name: 'Guarantor', email: `gus-${sfx}@example.test`, phone: '', role: 'guarantor' }, cookie);
  assert.match(r.flash, /^ok\|/);
  const gus = q1<any>(`SELECT r.id, r.kind, hm.role FROM household_members hm JOIN residents r ON r.id=hm.resident_id WHERE hm.lease_id=? AND r.first_name='Gus'`, leaseId);
  assert.equal(gus.role, 'guarantor');
  assert.equal(gus.kind, 'guarantor');

  r = await postFlash(`/leases/${leaseId}/household/${gus.id}/remove`, {}, cookie);
  assert.match(r.flash, /^ok\|/);
  assert.equal(val<number>('SELECT COUNT(*) FROM household_members WHERE lease_id=? AND resident_id=?', leaseId, gus.id), 0);
  assert.ok(q1('SELECT id FROM residents WHERE id=?', gus.id), 'the person record is kept');

  r = await postFlash(`/leases/${leaseId}/household/${primary.id}/remove`, {}, cookie);
  assert.match(r.flash, /^err\|The primary resident cannot be removed/);
  assert.equal(val<number>('SELECT COUNT(*) FROM household_members WHERE lease_id=? AND resident_id=?', leaseId, primary.id), 1);
});

// ---------- item 41: household change requests ----------

test('41: a pet or vehicle request is filed as the fields staff confirmed, with the pet rent they set', async () => {
  const leaseId = q1<any>(`SELECT id FROM leases WHERE unit_id=? AND status='active'`, units['101']!).id;
  const who = q1<any>(`SELECT u.email FROM household_members hm JOIN residents r ON r.id=hm.resident_id JOIN users u ON u.id=r.user_id WHERE hm.lease_id=? AND hm.role='primary'`, leaseId);
  const ck = await loginAs(base, who.email);
  assert.match((await get(base, '/portal/lease', ck)).text, /name="pet_name"/);

  await post(base, '/portal/lease/household-request', { kind: 'pet', pet_name: 'Miso', pet_species: 'cat', pet_breed: 'Domestic shorthair', pet_weight: '9' }, ck);
  await post(base, '/portal/lease/household-request', { kind: 'vehicle', veh_make: 'Subaru', veh_model: 'Outback', veh_color: 'Green', veh_plate: 'abc-123', veh_state: 'co' }, ck);
  await post(base, '/portal/lease/household-request', { kind: 'pet', pet_name: 'Rex', pet_species: 'dog' }, ck);
  const reqs = q<any>(`SELECT * FROM household_requests WHERE lease_id=? ORDER BY created_at`, leaseId);
  assert.equal(reqs.length, 3);
  assert.equal(JSON.parse(reqs[0].payload).name, 'Miso');

  const tab = await get(base, `/leases/${leaseId}?tab=portal-requests`, cookie);
  assert.match(tab.text, /name="pet_rent"/);
  assert.match(tab.text, /value="Miso"/);

  // staff correct the breed and set the pet rent
  let r = await postFlash(`/staff/household-requests/${reqs[0].id}/approve`, { pet_name: 'Miso', pet_species: 'cat', pet_breed: 'Siamese', pet_weight: '9', pet_rent: '25.00' }, cookie);
  assert.match(r.flash, /\$25\.00 monthly pet rent added/);
  const pet = q1<any>(`SELECT * FROM pets WHERE lease_id=? AND name='Miso'`, leaseId);
  assert.equal(pet.species, 'cat');
  assert.equal(pet.breed, 'Siamese');
  assert.equal(pet.weight_lbs, 9);
  const petRent = q<any>(`SELECT * FROM lease_charges WHERE lease_id=? AND kind='pet_rent'`, leaseId);
  assert.equal(petRent.length, 1);
  assert.equal(petRent[0].amount_cents, 2500);

  r = await postFlash(`/staff/household-requests/${reqs[1].id}/approve`, { veh_make: 'Subaru', veh_model: 'Outback', veh_plate: 'ABC-123', veh_state: 'CO' }, cookie);
  const veh = q1<any>(`SELECT * FROM vehicles WHERE lease_id=?`, leaseId);
  assert.equal(veh.make, 'Subaru');
  assert.equal(veh.model, 'Outback');
  assert.equal(veh.plate, 'ABC-123');

  // no pet rent entered in a live account: no charge is invented
  r = await postFlash(`/staff/household-requests/${reqs[2].id}/approve`, {}, cookie);
  assert.match(r.flash, /no pet rent added/);
  assert.equal(q1<any>(`SELECT name FROM pets WHERE lease_id=? AND name='Rex'`, leaseId).name, 'Rex');
  assert.equal(val<number>(`SELECT COUNT(*) FROM lease_charges WHERE lease_id=? AND kind='pet_rent'`, leaseId), 1);
});

// ---------- item 45: emergency requests ----------

test('45: the emergency notice shows the property’s own number and never claims anyone was paged', async () => {
  const leaseId = q1<any>(`SELECT id FROM leases WHERE unit_id=? AND status='active'`, units['101']!).id;
  const who = q1<any>(`SELECT u.email FROM household_members hm JOIN residents r ON r.id=hm.resident_id JOIN users u ON u.id=r.user_id WHERE hm.lease_id=? AND hm.role='primary'`, leaseId);
  const ck = await loginAs(base, who.email);
  let page = await get(base, '/portal/requests/new', ck);
  assert.doesNotMatch(page.text, /555\) 000-9111|24\/7 line/);
  assert.match(page.text, /call 911 first/);
  assert.match(page.text, /call your property office directly/);
  run('UPDATE properties SET phone=? WHERE id=?', '303-555-0142', prop);
  page = await get(base, '/portal/requests/new', ck);
  assert.match(page.text, /303-555-0142/);

  const r = await postFlash('/portal/requests/new', { category: 'plumbing', summary: 'Burst pipe flooding the kitchen', description: '' }, ck);
  assert.doesNotMatch(r.flash, /on-call team is notified/);
  assert.match(r.flash, /nobody is paged automatically/);
  assert.match(r.flash, /303-555-0142/);
  const wo = q1<any>(`SELECT priority FROM work_orders WHERE lease_id=? ORDER BY created_at DESC LIMIT 1`, leaseId);
  assert.equal(wo.priority, 'emergency', 'the flag itself is real');
});

// ---------- items 35 + 36 (+37 by application): the application taken at the office ----------

test('35/36/37: staff enter an application and its screening report, decide it, and the notice names the real agency', async () => {
  const c = ctx();
  // approved path
  const a1 = createApplication(c, { propertyId: prop, unitId: units['109']!, rentCents: 150000, primary: { firstName: 'Ana', lastName: 'Approved', email: '' } });
  assert.equal(q1<any>('SELECT status FROM applications WHERE id=?', a1.applicationId).status, 'draft');
  const page = await get(base, `/applications/${a1.applicationId}`, cookie);
  assert.match(page.text, /Enter the application/);
  assert.match(page.text, /not connected for this account/);
  const apl1 = q1<any>('SELECT id FROM applicants WHERE application_id=?', a1.applicationId).id;
  const cashBefore = accountBalance(c, '1010', { propertyId: prop, basis: 'cash' });

  // a score with no agency named is refused
  let r = await postFlash(`/applications/${a1.applicationId}/staff-submit`, { [`a_${apl1}_first`]: 'Ana', [`a_${apl1}_last`]: 'Approved', [`a_${apl1}_income`]: '6000', [`a_${apl1}_score`]: '760' }, cookie);
  assert.match(r.flash, /^err\|Name the screening agency/);
  assert.equal(q1<any>('SELECT status FROM applications WHERE id=?', a1.applicationId).status, 'draft');

  r = await postFlash(`/applications/${a1.applicationId}/staff-submit`, {
    [`a_${apl1}_first`]: 'Ana', [`a_${apl1}_last`]: 'Approved', [`a_${apl1}_email`]: `ana-${sfx}@example.test`, [`a_${apl1}_income`]: '6,000.00', [`a_${apl1}_score`]: '760',
    agency_name: 'Front Range Screening', agency_address: '10 Agency Way, Denver CO', agency_phone: '800-555-0111', fee_received: '50.00', fee_reference: 'check 1041',
  }, cookie);
  assert.match(r.flash, /^ok\|/);
  const app1 = q1<any>('SELECT * FROM applications WHERE id=?', a1.applicationId);
  assert.equal(app1.status, 'review');
  assert.equal(app1.recommendation, 'approve');
  assert.equal(app1.fees_paid, 1);
  assert.equal(app1.app_fee_cents, 5000);
  assert.equal(app1.hold_deposit_cents, 0, 'no holding deposit was received, so none exists to credit later');
  const rep = q1<any>('SELECT * FROM screening_reports WHERE application_id=?', a1.applicationId);
  assert.equal(rep.source, 'manual');
  assert.equal(rep.status, 'complete');
  assert.equal(rep.credit_score, 760);
  assert.equal(rep.agency_name, 'Front Range Screening');
  assert.equal(accountBalance(c, '1010', { propertyId: prop, basis: 'cash' }) - cashBefore, 5000, 'only the money actually received is booked');

  r = await postFlash(`/applications/${a1.applicationId}/decide`, { action: 'approved' }, cookie);
  assert.equal(q1<any>('SELECT status FROM applications WHERE id=?', a1.applicationId).status, 'approved');
  r = await postFlash(`/applications/${a1.applicationId}/generate-lease`, {}, cookie);
  const leaseId = leaseIdFrom(r.location);
  assert.equal(lease(leaseId).status, 'draft');
  assert.equal(lease(leaseId).application_id, a1.applicationId);

  // declined path: the notice names the agency and says nothing about a demo
  const a2 = createApplication(c, { propertyId: prop, unitId: units['110']!, rentCents: 150000, primary: { firstName: 'Del', lastName: 'Declined', email: '' } });
  const apl2 = q1<any>('SELECT id FROM applicants WHERE application_id=?', a2.applicationId).id;
  await postFlash(`/applications/${a2.applicationId}/staff-submit`, {
    [`a_${apl2}_first`]: 'Del', [`a_${apl2}_last`]: 'Declined', [`a_${apl2}_income`]: '6000', [`a_${apl2}_score`]: '480',
    agency_name: 'Front Range Screening', agency_address: '10 Agency Way, Denver CO', agency_phone: '800-555-0111',
  }, cookie);
  assert.equal(q1<any>('SELECT recommendation FROM applications WHERE id=?', a2.applicationId).recommendation, 'decline');
  r = await postFlash(`/applications/${a2.applicationId}/decide`, { action: 'declined' }, cookie);
  assert.match(r.flash, /print it or send it yourself/);
  assert.equal(q1<any>('SELECT status FROM applications WHERE id=?', a2.applicationId).status, 'declined');
  const notice = consumerReportNotice(c, a2.applicationId);
  assert.match(notice, /Front Range Screening \(10 Agency Way, Denver CO · 800-555-0111\)/);
  assert.doesNotMatch(notice, /simulated|demo/i);
  // the letter itself is filed on the application
  let letter: any = null;
  for (let i = 0; i < 40 && !letter; i++) {
    letter = q1<any>(`SELECT id FROM files WHERE entity='application' AND entity_id=? AND name LIKE 'adverse-action-%'`, a2.applicationId);
    if (!letter) await new Promise((res) => setTimeout(res, 50));
  }
  assert.ok(letter, 'adverse action notice filed');

  // an application with no report at all says so instead of citing an agency
  const a3 = createApplication(c, { propertyId: prop, unitId: units['110']!, rentCents: 150000, primary: { firstName: 'Nia', lastName: 'Noreport', email: '' } });
  assert.match(consumerReportNotice(c, a3.applicationId), /No consumer report was used/);
});

// ---------- item 33: the public property site ----------

test('33: a live property’s site publishes nothing its operator did not write', async () => {
  const p = q1<any>('SELECT * FROM properties WHERE id=?', prop);
  const mk = marketingOf(p);
  assert.deepEqual(mk.amenities, []);
  assert.deepEqual(mk.photos, []);
  assert.doesNotMatch(mk.about, /online payments/i);
  assert.equal(mk.published, false);

  run('UPDATE properties SET marketing=? WHERE id=?', JSON.stringify({ published: true, heroTitle: 'Maple Court' }), prop);
  let site = await get(base, `/p/${slug}`);
  assert.equal(site.status, 200);
  assert.doesNotMatch(site.text, /Fitness center|Pool deck|Online payments|Resident lounge/);
  assert.doesNotMatch(site.text, /id="amenities"|#amenities|id="gallery"/);

  run('UPDATE properties SET marketing=? WHERE id=?', JSON.stringify({ published: true, heroTitle: 'Maple Court', amenities: ['Covered parking'] }), prop);
  site = await get(base, `/p/${slug}`);
  assert.match(site.text, /id="amenities"/);
  assert.match(site.text, /Covered parking/);

  // the demo world keeps its sample content
  const demoOrg = id('org');
  insert('orgs', { id: demoOrg, name: `Lease demo ${sfx}`, slug: `lease-demo-${sfx}`, kind: 'demo', business_date: '2026-07-26', created_at: nowIso() });
  assert.ok(marketingOf({ org_id: demoOrg, marketing: null }).amenities.includes('Fitness center'));
});
