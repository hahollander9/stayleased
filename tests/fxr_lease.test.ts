import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert, val, run } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword, sysCtx } from '../src/lib/auth.ts';
import { runJob } from '../src/lib/jobs.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { accountBalance, runInvariants } from '../src/modules/m9_accounting/service.ts';
import { leaseBalance, postMonthlyChargesForLease } from '../src/modules/m8_receivables/service.ts';
import { depositHeld } from '../src/modules/m8_receivables/payments.ts';
import { activateLease, createLeaseManual, recordNotice, recordMoveOut, cancelPendingLease } from '../src/modules/m6_leases/service.ts';
import { startTestServer, loginAs, get } from './harness.ts';

/** What rent is billed when a lease ends, a notice changes, a renewal starts
 * late, billing is deferred, or a pending lease is canceled — in a live
 * organization, on $1,500 leases. Every test asserts the lease balance, GL
 * 1100 and the built-in integrity checks afterwards. Own org fixture; the
 * organization's business date is 2026-11-20. */

const TODAY = '2026-11-20';
let base: string;
let close: () => void;
let org: string;
let prop: string;
let admin: string;
let cookie: string;
const sfx = id('x').slice(-6);
const units: Record<string, string> = {};

const ctx = (date: string = TODAY) => sysCtx(org, date);
const lease = (leaseId: string): any => q1<any>('SELECT * FROM leases WHERE id=?', leaseId);
const ar = (): number => accountBalance(ctx(), '1100', { basis: 'accrual' });
const gl = (code: string, basis: 'accrual' | 'cash'): number => accountBalance(ctx(), code, { basis });
const billed = (leaseId: string, mk: string): number =>
  val<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM charges WHERE lease_id=? AND month_key=? AND status='active'`, leaseId, mk) || 0;
const invariantsHold = (): void =>
  assert.deepEqual(runInvariants(ctx()).filter((i) => !i.ok).map((i) => `${i.name}: ${i.detail}`), []);

async function postFlash(path: string, body: Record<string, string>): Promise<{ status: number; flash: string }> {
  const resp = await fetch(base + path, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, cookie },
    body: new URLSearchParams(body).toString(),
  });
  const m = /sl_fl=([^;]+)/.exec(resp.headers.get('set-cookie') || '');
  return { status: resp.status, flash: m ? decodeURIComponent(m[1]!) : '' };
}

function make(u: string, startDate: string, on: string, over: Record<string, unknown> = {}): string {
  return createLeaseManual(ctx(on), {
    unitId: units[u]!, people: [{ firstName: 'Riley', lastName: `Unit${u}`, role: 'primary' }],
    startDate, endDate: '2027-07-31', rentCents: 150000, depositCents: 0, depositOnHand: false, signed: true,
    ...over,
  } as any).leaseId;
}

before(async () => {
  db();
  org = id('org');
  insert('orgs', { id: org, name: `Rent rules ${sfx}`, slug: `rent-rules-${sfx}`, kind: 'live', business_date: TODAY, created_at: nowIso() });
  ensureCoa(org);
  const uid = id('usr');
  admin = `admin-rlease-${sfx}@example.test`;
  insert('users', { id: uid, org_id: org, email: admin, name: 'Lease Admin', kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso() });
  insert('role_assignments', { id: id('ra'), org_id: org, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  prop = id('prp');
  insert('properties', { id: prop, org_id: org, name: 'Birch Row', slug: `birch-row-${sfx}`, type: 'multifamily', address1: '1 Test St', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso() });
  for (const n of ['201', '202', '203', '204', '205', '206', '207', '208', '209', '210']) {
    units[n] = id('unt');
    insert('units', { id: units[n], org_id: org, property_id: prop, unit_number: n, floor: 2, sqft: 800, status: 'vacant_ready', market_rent_cents: 150000, amenities: '[]', created_at: nowIso() });
  }
  const s = await startTestServer();
  base = s.base; close = s.close;
  cookie = await loginAs(base, admin);
});
after(() => close());

// ---------- item 10 ----------

test('10: a move-out recorded after the month was billed credits the rent past the move-out day', async () => {
  const ar0 = ar();
  // $1,500 from Aug 1, entered Nov 20: Aug–Nov are on the ledger in full
  const a = make('201', '2026-08-01', TODAY);
  assert.equal(leaseBalance(ctx(), a), 600000);

  // they left Sep 15; staff record it on Nov 20
  const r = await postFlash(`/leases/${a}/move-out`, { move_out: '2026-09-15' });
  assert.match(r.flash, /^ok\|Move-out recorded/);
  assert.equal(lease(a).status, 'ended');
  // August in full + 15 of September's 30 days = $2,250; $3,750 comes back
  assert.equal(billed(a, '2026-08'), 150000);
  assert.equal(billed(a, '2026-09'), 75000);
  assert.equal(billed(a, '2026-10'), 0);
  assert.equal(billed(a, '2026-11'), 0);
  assert.equal(leaseBalance(ctx(), a), 225000);
  assert.equal(ar() - ar0, 225000, 'GL 1100 carries what is owed, not the phantom rent');
  const credits = q<any>(`SELECT label, amount_cents FROM charges WHERE lease_id=? AND amount_cents<0 ORDER BY month_key`, a);
  assert.deepEqual(credits.map((c) => c.amount_cents), [-75000, -150000, -150000]);
  assert.match(credits[0].label, /credit, moved out/);
  invariantsHold();

  // a notice given after the 1st for a date in the same month: the same answer
  // as a notice given before the month was billed
  const b = make('202', '2026-11-01', TODAY);
  assert.equal(leaseBalance(ctx(), b), 150000);
  const n = await postFlash(`/leases/${b}/notice`, { notice_date: TODAY, move_out: '2026-11-25' });
  assert.match(n.flash, /^ok\|/);
  assert.equal(billed(b, '2026-11'), 125000, '25 of 30 days');
  assert.equal(leaseBalance(ctx(), b), 125000);
  assert.equal(ar() - ar0, 225000 + 125000);
  // saving the same date again posts nothing more
  await postFlash(`/leases/${b}/notice`, { notice_date: TODAY, move_out: '2026-11-25' });
  assert.equal(leaseBalance(ctx(), b), 125000);
  invariantsHold();
});

// ---------- item 11 ----------

test('11: a month prorated to a move-out date is topped up when the notice is withdrawn or the date moves later', async () => {
  const ar0 = ar();
  // on notice for Nov 10 before November is billed: the rent run posts 10 days
  const a = make('203', '2026-10-01', '2026-10-20');
  recordNotice(ctx('2026-10-20'), a, '2026-11-10');
  assert.equal(postMonthlyChargesForLease(ctx('2026-11-01'), lease(a), '2026-11'), 1);
  assert.equal(billed(a, '2026-11'), 50000);
  assert.equal(leaseBalance(ctx(), a), 200000);

  // the household is staying
  const r = await postFlash(`/leases/${a}/notice/withdraw`, {});
  assert.match(r.flash, /^ok\|Notice withdrawn/);
  assert.equal(lease(a).status, 'active');
  assert.equal(billed(a, '2026-11'), 150000, 'November is owed in full again');
  assert.equal(leaseBalance(ctx(), a), 300000);
  assert.equal(ar() - ar0, 300000);
  const top = q1<any>(`SELECT * FROM charges WHERE lease_id=? AND month_key='2026-11' AND amount_cents=100000`, a);
  assert.match(top.label, /balance of month, notice withdrawn/);
  assert.equal(top.kind, 'rent');
  // the rent run still sees November as billed
  assert.equal(postMonthlyChargesForLease(ctx(), lease(a), '2026-11'), 0);
  invariantsHold();

  // the planned date moves later, then earlier again
  const b = make('204', '2026-10-01', '2026-10-20');
  recordNotice(ctx('2026-10-20'), b, '2026-11-10');
  postMonthlyChargesForLease(ctx('2026-11-01'), lease(b), '2026-11');
  assert.equal(billed(b, '2026-11'), 50000);
  let n = await postFlash(`/leases/${b}/notice`, { notice_date: '2026-10-20', move_out: '2026-11-30' });
  assert.match(n.flash, /^ok\|/);
  assert.equal(billed(b, '2026-11'), 150000);
  n = await postFlash(`/leases/${b}/notice`, { notice_date: '2026-10-20', move_out: '2026-11-24' });
  assert.match(n.flash, /^ok\|/);
  assert.equal(billed(b, '2026-11'), 120000, '24 of 30 days');
  assert.equal(leaseBalance(ctx(), b), 270000);

  // a notice whose date had passed a whole month: withdrawing bills the month it skipped
  const c = make('205', '2026-09-01', '2026-09-20');
  recordNotice(ctx('2026-09-20'), c, '2026-10-10');
  postMonthlyChargesForLease(ctx('2026-10-01'), lease(c), '2026-10');
  assert.equal(postMonthlyChargesForLease(ctx('2026-11-01'), lease(c), '2026-11'), 0, 'past the move-out date, nothing is billed');
  assert.equal(leaseBalance(ctx(), c), 150000 + 48387, 'September + 10 of October\'s 31 days');
  assert.match((await postFlash(`/leases/${c}/notice/withdraw`, {})).flash, /^ok\|/);
  assert.equal(billed(c, '2026-10'), 150000);
  assert.equal(billed(c, '2026-11'), 150000);
  assert.equal(leaseBalance(ctx(), c), 450000);
  assert.equal(ar() - ar0, 300000 + 270000 + 450000);
  invariantsHold();
});

// ---------- item 12 ----------

/** a signed renewal of `priorId` at $1,600, not yet active */
function renewalOf(priorId: string, startDate: string): string {
  const p = lease(priorId);
  const rid = id('lse');
  insert('leases', {
    id: rid, org_id: org, property_id: p.property_id, unit_id: p.unit_id, household_name: p.household_name,
    status: 'fully_executed', start_date: startDate, end_date: '2027-11-30', move_in_date: p.move_in_date,
    rent_cents: 160000, deposit_cents: 0, deposit_alternative: 0, term_months: 12, renewal_of_lease_id: priorId, created_at: nowIso(),
  });
  insert('lease_charges', { id: id('lc'), org_id: org, lease_id: rid, kind: 'rent', label: 'Rent — renewal', amount_cents: 160000, created_at: nowIso() });
  return rid;
}

test('12: a renewal signed after its start date does not bill the months the prior term already billed', () => {
  const ar0 = ar();
  // (a) renewal starts Dec 1, signatures complete Dec 5: the rent run on the
  // 1st has already billed December on the prior term
  const a = make('206', '2026-11-01', '2026-11-01', { endDate: '2026-11-30' });
  assert.equal(postMonthlyChargesForLease(ctx('2026-12-01'), lease(a), '2026-12'), 1);
  assert.equal(leaseBalance(ctx(), a), 300000);
  const ra = renewalOf(a, '2026-12-01');
  activateLease(ctx('2026-12-05'), ra);
  assert.equal(lease(a).status, 'renewed');
  assert.equal(billed(a, '2026-12'), 0, 'the prior term gives December back');
  assert.equal(leaseBalance(ctx(), a), 0);
  assert.equal(billed(ra, '2026-12'), 160000);
  // November still owed ($1,500, carried forward) + December once at the new rent
  assert.equal(leaseBalance(ctx(), ra), 150000 + 160000);
  assert.equal(ar() - ar0, 310000);

  // (b) renewal starts Nov 16, signed Dec 5
  const b = make('207', '2026-11-01', '2026-11-01', { endDate: '2026-11-15' });
  postMonthlyChargesForLease(ctx('2026-12-01'), lease(b), '2026-12');
  const rb = renewalOf(b, '2026-11-16');
  activateLease(ctx('2026-12-05'), rb);
  assert.equal(billed(b, '2026-11'), 75000, 'the prior term keeps Nov 1–15');
  assert.equal(billed(b, '2026-12'), 0);
  assert.equal(billed(rb, '2026-11'), 80000, 'the renewal bills Nov 16–30');
  assert.equal(billed(rb, '2026-12'), 160000);
  assert.equal(leaseBalance(ctx(), b), 0);
  assert.equal(leaseBalance(ctx(), rb), 75000 + 80000 + 160000);
  assert.equal(ar() - ar0, 310000 + 315000);
  invariantsHold();
});

// ---------- item 13 ----------

test('13: a unit already leased to the next household cannot have its notice withdrawn or pushed past that lease', async () => {
  const a = make('208', '2026-11-01', TODAY);
  assert.match((await postFlash(`/leases/${a}/notice`, { notice_date: TODAY, move_out: '2026-11-25' })).flash, /^ok\|/);
  const balance = leaseBalance(ctx(), a);
  // the next household signs for Nov 26
  const next = make('208', '2026-11-26', TODAY);
  assert.equal(lease(next).status, 'fully_executed');

  let r = await postFlash(`/leases/${a}/notice/withdraw`, {});
  assert.match(r.flash, /^err\|This unit is already leased to Riley Unit208/);
  assert.equal(lease(a).status, 'notice');
  assert.equal(lease(a).move_out_date, '2026-11-25');
  r = await postFlash(`/leases/${a}/notice`, { notice_date: TODAY, move_out: '2026-11-28' });
  assert.match(r.flash, /^err\|The next lease on this unit .* the move-out must be before it/);
  assert.equal(lease(a).move_out_date, '2026-11-25');
  assert.equal(leaseBalance(ctx(), a), balance, 'a refused change bills nothing');

  // backstop: even if the first lease were somehow current on the day, the
  // second does not activate on top of it — and the job carries on
  run(`UPDATE leases SET status='active', move_out_date=NULL, notice_date=NULL WHERE id=?`, a);
  const out = runJob(ctx('2026-11-26'), 'lease_activation', '2026-11-26');
  assert.equal(lease(next).status, 'fully_executed');
  assert.throws(() => activateLease(ctx('2026-11-26'), next), /still has a current lease/);
  assert.equal(val<number>(`SELECT COUNT(*) FROM leases WHERE unit_id=? AND status IN ('active','month_to_month','notice')`, units['208']!), 1);
  assert.equal(val<number>(`SELECT COUNT(*) FROM charges WHERE lease_id=?`, next), 0, 'the second household is not billed');
  assert.ok(out !== undefined);

  // once the first household is out, the second moves in
  run(`UPDATE leases SET status='notice', move_out_date='2026-11-25', notice_date=? WHERE id=?`, TODAY, a);
  recordMoveOut(ctx('2026-11-26'), a, '2026-11-25');
  activateLease(ctx('2026-11-26'), next);
  assert.equal(lease(next).status, 'active');
  invariantsHold();
});

// ---------- item 14 ----------

test('14: "start billing from" a future month bills nothing until that month arrives', () => {
  const ar0 = ar();
  const a = make('209', '2026-11-01', TODAY, { billingStartDate: '2027-01-01' });
  assert.equal(lease(a).status, 'active');
  assert.equal(val<number>(`SELECT COUNT(*) FROM charges WHERE lease_id=?`, a), 0, 'no rent dated in the future');
  assert.equal(leaseBalance(ctx(), a), 0);
  assert.equal(ar() - ar0, 0);
  // the rent run bills January when it comes, once
  assert.equal(postMonthlyChargesForLease(ctx('2026-12-01'), lease(a), '2026-12'), 0);
  assert.equal(postMonthlyChargesForLease(ctx('2027-01-01'), lease(a), '2027-01'), 1);
  assert.equal(postMonthlyChargesForLease(ctx('2027-01-02'), lease(a), '2027-01'), 0);
  assert.equal(leaseBalance(ctx(), a), 150000);
  assert.equal(ar() - ar0, 150000);
  invariantsHold();
  // and a billing start after the lease end is refused
  assert.throws(() => make('210', '2026-11-01', TODAY, { billingStartDate: '2027-08-15' }), /cannot be after the lease end/);
  assert.equal(val<number>(`SELECT COUNT(*) FROM leases WHERE unit_id=?`, units['210']!), 0);
});

// ---------- item 15 ----------

test('15: a pending lease with a deposit recorded as held can be canceled, and the deposit comes off both books', async () => {
  const before = { c1020: gl('1020', 'cash'), a1020: gl('1020', 'accrual'), c2100: gl('2100', 'cash'), a2100: gl('2100', 'accrual'), ar: ar() };
  const a = make('210', '2027-02-01', TODAY, { depositCents: 100000, depositOnHand: true, endDate: '2028-01-31' });
  assert.equal(lease(a).status, 'fully_executed');
  assert.equal(gl('1020', 'cash') - before.c1020, 100000);
  assert.equal(gl('2100', 'accrual') - before.a2100, -100000);
  assert.equal(depositHeld(ctx(), a), 100000);
  // the unit is blocked while the lease stands
  assert.throws(() => make('210', '2027-02-01', TODAY), /lease in progress/);

  const page = await get(base, `/leases/${a}?tab=overview`, cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Cancel this lease/);
  assert.match(page.text, /Return that money to the household yourself/);

  const r = await postFlash(`/leases/${a}/cancel`, {});
  assert.match(r.flash, /^ok\|Lease canceled\..*\$1,000\.00 deposit is no longer recorded as held/);
  assert.equal(lease(a).status, 'canceled');
  assert.equal(gl('1020', 'cash'), before.c1020);
  assert.equal(gl('1020', 'accrual'), before.a1020);
  assert.equal(gl('2100', 'cash'), before.c2100);
  assert.equal(gl('2100', 'accrual'), before.a2100);
  assert.equal(ar(), before.ar);
  assert.equal(depositHeld(ctx(), a), 0);
  assert.equal(leaseBalance(ctx(), a), 0);
  assert.ok(q1(`SELECT id FROM audit_events WHERE org_id=? AND entity_id=? AND action='cancel'`, org, a), 'audited');
  invariantsHold();

  // it never activates, cannot be canceled twice, and the unit is free again
  runJob(ctx('2027-02-01'), 'lease_activation', '2027-02-01');
  assert.equal(lease(a).status, 'canceled');
  assert.match((await postFlash(`/leases/${a}/cancel`, {})).flash, /^err\|Only a lease that has not started/);
  assert.match((await get(base, `/leases/${a}?tab=overview`, cookie)).text, /canceled before it started/);
  const b = make('210', '2027-02-01', TODAY);
  assert.equal(lease(b).status, 'fully_executed');
  // a current lease is not canceled — it is moved out
  const live = q1<any>(`SELECT id FROM leases WHERE org_id=? AND status='active' LIMIT 1`, org);
  assert.throws(() => cancelPendingLease(ctx(), live.id), /record the move-out/);
  // another organization's lease is not found
  const other = id('org');
  insert('orgs', { id: other, name: `Other ${sfx}`, slug: `other-rl-${sfx}`, kind: 'live', business_date: TODAY, created_at: nowIso() });
  assert.throws(() => cancelPendingLease(sysCtx(other, TODAY), b), /Lease not found/);
  assert.equal(lease(b).status, 'fully_executed');
});
