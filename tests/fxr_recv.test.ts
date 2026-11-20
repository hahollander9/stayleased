import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert, val } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword, sysCtx } from '../src/lib/auth.ts';
import { setSetting } from '../src/lib/settings.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { accountBalance, runInvariants } from '../src/modules/m9_accounting/service.ts';
import { createCharge, leaseBalance } from '../src/modules/m8_receivables/service.ts';
import {
  recordPayment, settleDuePayments, openCharges, finalizeDeposit, depositHeld, pendingDepositRefund,
  issueDepositRefund, unappliedCredits,
} from '../src/modules/m8_receivables/payments.ts';
import { enrollDepositAlternative, attachGuaranty } from '../src/modules/m12_insurance/service.ts';
import '../src/modules/m12_insurance/pages.ts';
import { startTestServer, loginAs, get, post } from './harness.ts';

/** Regression tests for the 2026-11-20 review of the receivables and
 * insurance code (review items 1, 2, 5, 17, 18). Each runs in its own live
 * company fixture and ends on the books: the household's position, the
 * general ledger on both bases, and the built-in integrity checks. Each lease
 * gets its own property so a GL assertion sees that lease alone. */

const BD = '2026-08-10';
const MK = '2026-08';
const sfx = id('x').slice(-6);

let base: string;
let close: () => void;
let liveOrg: string;
let demoOrg: string;
let adminLive: string;
let adminDemo: string;
let cookie: string;

function mkUser(org: string, tag: string, role: string, props: string[] | null): string {
  const uid = id('usr');
  const email = `${tag}-${id('u').slice(-6)}@example.test`;
  insert('users', { id: uid, org_id: org, email, name: tag, kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso() });
  insert('role_assignments', {
    id: id('ra'), org_id: org, user_id: uid, role, scope_type: props ? 'properties' : 'org',
    property_ids: JSON.stringify(props || []), created_at: nowIso(),
  });
  return email;
}

function mkOrg(kind: 'demo' | 'live'): { org: string; email: string } {
  const org = id('org');
  insert('orgs', { id: org, name: `Rrecv ${kind} ${sfx}`, slug: `rrecv-${kind}-${sfx}`, kind, business_date: BD, created_at: nowIso() });
  ensureCoa(org);
  return { org, email: mkUser(org, `admin-rrecv-${kind}`, 'ORG_ADMIN', null) };
}

interface Fx { lease: string; prop: string; unit: string; resident: string }

function mkLease(org: string, opts: { status?: string; deposit?: number; moveOut?: string | null; extra?: Record<string, unknown> } = {}): Fx {
  const n = id('n').slice(-6);
  const prop = id('prp');
  insert('properties', { id: prop, org_id: org, name: `Rrecv prop ${n}`, slug: `rrecv-prop-${n}`, type: 'multifamily', address1: '1 Test St', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso() });
  const unit = id('unt');
  insert('units', { id: unit, org_id: org, property_id: prop, unit_number: `R-${n}`, floor: 1, sqft: 800, status: 'occupied', market_rent_cents: 160000, amenities: '[]', created_at: nowIso() });
  const lease = id('lse');
  insert('leases', {
    id: lease, org_id: org, property_id: prop, unit_id: unit, household_name: `Rrecv ${n}`,
    status: opts.status || 'active', start_date: '2026-01-01', end_date: '2026-12-31', move_in_date: '2026-01-01',
    move_out_date: opts.moveOut ?? null, rent_cents: 160000, deposit_cents: opts.deposit ?? 0, term_months: 12, created_at: nowIso(),
    ...(opts.extra || {}),
  });
  const resident = id('res');
  insert('residents', { id: resident, org_id: org, property_id: prop, first_name: 'Pat', last_name: n, email: `pat-${n}@example.test`, kind: 'adult', created_at: nowIso() });
  insert('household_members', { id: id('hm'), org_id: org, lease_id: lease, resident_id: resident, role: 'primary', created_at: nowIso() });
  return { lease, prop, unit, resident };
}

const live = (date = BD) => sysCtx(liveOrg, date);
/** GL balance for one property: debits positive (so a liability reads negative) */
const gl = (fx: Fx, code: string, basis: 'accrual' | 'cash' = 'accrual', org = liveOrg): number =>
  accountBalance(sysCtx(org, BD), code, { propertyId: fx.prop, basis });
const both = (fx: Fx, code: string): [number, number] => [gl(fx, code, 'accrual'), gl(fx, code, 'cash')];

/** every built-in integrity check passes for the live company */
function assertBooksTie(label: string): void {
  const bad = runInvariants(live()).filter((i) => !i.ok);
  assert.deepEqual(bad.map((i) => `${i.name}: ${i.detail}`), [], `integrity checks after ${label}`);
}

/** a lease on notice whose $1,000.00 deposit was billed at move-in, with `paid` of it collected and settled into escrow */
function leavingLease(paid: number, status = 'notice'): Fx {
  const fx = mkLease(liveOrg, { status, deposit: 100000, moveOut: status === 'notice' ? '2026-08-31' : null });
  createCharge(live('2026-01-01'), { leaseId: fx.lease, kind: 'deposit', label: 'Security deposit', amountCents: 100000, date: '2026-01-01', dueDate: '2026-01-01', source: 'move_in' });
  if (paid > 0) {
    recordPayment(live('2026-01-02'), { leaseId: fx.lease, amountCents: paid, method: 'check', reference: '1001', receivedDate: '2026-01-02', suppressReceipt: true });
    settleDuePayments(live('2026-01-20'), '2026-01-20');
    assert.equal(q1<any>('SELECT status FROM payments WHERE lease_id=?', fx.lease).status, 'settled');
    assert.deepEqual(both(fx, '1020'), [paid, paid], 'the collected deposit sits in escrow');
  }
  return fx;
}
const owe = (fx: Fx, cents: number, kind = 'rent', label = 'Rent'): string =>
  createCharge(live(), { leaseId: fx.lease, kind, label, amountCents: cents, date: '2026-08-01', dueDate: '2026-08-01', monthKey: kind === 'rent' ? MK : null, source: 'oneoff' });
const openOn = (fx: Fx): { kind: string; open: number }[] => openCharges(live(), fx.lease).map((c) => ({ kind: c.kind, open: c.amount_cents - c.applied }));
const pendingRefunds = (fx: Fx): any[] => q<any>(`SELECT * FROM refunds WHERE lease_id=? AND kind='deposit' AND status='pending'`, fx.lease);

before(async () => {
  db();
  const l = mkOrg('live');
  const d = mkOrg('demo');
  liveOrg = l.org; adminLive = l.email;
  demoOrg = d.org; adminDemo = d.email;
  const s = await startTestServer();
  base = s.base; close = s.close;
  cookie = await loginAs(base, adminLive);
});
after(() => close());

// ---------- item 2: an uncollected deposit is not money held ----------

test('2a: a deposit that was billed but never paid is written down at move-out — nothing is applied or swept', () => {
  const fx = leavingLease(0);
  owe(fx, 30000);
  assert.equal(leaseBalance(live(), fx.lease), 130000);

  const r = finalizeDeposit(live(), fx.lease, { date: BD });
  assert.equal(r.writtenDown, 100000);
  assert.equal(r.applied, 0, 'no deposit money exists to apply');
  assert.equal(r.refunded, 0);
  assert.equal(r.refundId, null);
  assert.equal(r.balanceDue, 30000, 'the rent is still owed');

  assert.equal(depositHeld(live(), fx.lease), 0);
  assert.equal(leaseBalance(live(), fx.lease), 30000);
  assert.deepEqual(openOn(fx), [{ kind: 'rent', open: 30000 }], 'the deposit charge is closed and the rent is the only open charge');
  assert.equal(unappliedCredits(live(), fx.lease).length, 0, 'the write-down is fully set against the deposit charge');
  assert.equal(val<number>(`SELECT COUNT(*) FROM deposit_activity WHERE lease_id=?`, fx.lease), 0);
  assert.equal(val<number>(`SELECT COUNT(*) FROM journal_entries WHERE org_id=? AND source_kind='deposit_sweep' AND source_id=?`, liveOrg, fx.lease), 0, 'no escrow sweep');

  assert.deepEqual(both(fx, '1010'), [0, 0], 'no phantom operating cash');
  assert.deepEqual(both(fx, '1020'), [0, 0], 'escrow never goes negative');
  assert.deepEqual(both(fx, '2100'), [0, 0], 'no deposit liability for money never collected');
  assert.equal(gl(fx, '1100'), 30000, 'the receivable is the rent alone');
  assertBooksTie('settling an unpaid deposit');
});

test('2b: a half-paid deposit applies only what was collected, to the rent, and refunds the rest', () => {
  const fx = leavingLease(50000);
  owe(fx, 30000);
  assert.equal(leaseBalance(live(), fx.lease), 80000);

  const r = finalizeDeposit(live(), fx.lease, { date: BD });
  assert.equal(r.writtenDown, 50000);
  assert.equal(r.applied, 30000);
  assert.equal(r.refunded, 20000);
  assert.equal(r.refundStatus, 'pending');
  assert.equal(r.balanceDue, 0);

  assert.deepEqual(openOn(fx), [], 'the deposit credit paid the rent, not the unpaid deposit');
  const app = q<any>(
    `SELECT c.kind, pa.amount_cents FROM payment_applications pa JOIN payments p ON p.id=pa.payment_id JOIN charges c ON c.id=pa.charge_id
      WHERE p.lease_id=? AND p.memo='security deposit applied at move-out'`, fx.lease);
  assert.deepEqual(app.map((a) => [a.kind, a.amount_cents]), [['rent', 30000]]);

  assert.deepEqual(both(fx, '1010'), [30000, 30000], 'only the applied $300.00 moved to operating');
  assert.deepEqual(both(fx, '1020'), [20000, 20000], 'the refund owed is still in escrow');
  assert.deepEqual(both(fx, '2100'), [-20000, -20000]);
  assert.equal(gl(fx, '1100'), 0);
  assertBooksTie('settling a half-paid deposit');

  issueDepositRefund(live(), r.refundId!, { checkNumber: '2041', date: BD });
  assert.deepEqual(both(fx, '1020'), [0, 0], 'escrow is empty, not negative, once the check is recorded');
  assert.deepEqual(both(fx, '2100'), [0, 0]);
  assert.equal(depositHeld(live(), fx.lease), 0);
  assertBooksTie('recording the refund check');
});

// ---------- item 1: a pending refund can be settled again ----------

test('1: a charge posted after a pending refund can still be taken from the deposit', async () => {
  const fx = leavingLease(100000);
  owe(fx, 30000);
  const first = await post(base, `/leases/${fx.lease}/deposit/finalize`, { to_collections: '0' }, cookie);
  assert.equal(first.status, 303);
  assert.equal(pendingDepositRefund(live(), fx.lease), 70000);
  assert.equal(depositHeld(live(), fx.lease), 0);
  const firstRefund = pendingRefunds(fx)[0].id;

  // the damage is found after the settlement
  owe(fx, 20000, 'damage', 'Carpet replacement');
  assert.equal(leaseBalance(live(), fx.lease), 20000);

  const tab = await get(base, `/leases/${fx.lease}?tab=deposit`, cookie);
  assert.equal(tab.status, 200);
  assert.ok(tab.text.includes('Settle the deposit again'), 'the deposit tab still offers the settlement');
  assert.ok(tab.text.includes(`action="/leases/${fx.lease}/deposit/finalize"`));

  const again = await post(base, `/leases/${fx.lease}/deposit/finalize`, { to_collections: '0' }, cookie);
  assert.equal(again.status, 303);
  assert.ok(!/no%20deposit%20held|no\+deposit\+held/i.test(again.location || ''), 'the second settlement is not refused');

  assert.equal(leaseBalance(live(), fx.lease), 0, 'the damage charge was paid from the deposit');
  const pend = pendingRefunds(fx);
  assert.equal(pend.length, 1, 'one refund owed, not two');
  assert.equal(pend[0].amount_cents, 50000);
  assert.equal(pend[0].id, firstRefund, 'the same refund record, now for the smaller amount');
  assert.ok(q1(`SELECT id FROM audit_events WHERE org_id=? AND entity_id=? AND action='revised'`, liveOrg, firstRefund), 'and the change is on the audit trail');
  assert.equal(val<number>(`SELECT SUM(amount_cents) FROM deposit_activity WHERE lease_id=? AND kind='apply'`, fx.lease), -50000);
  assert.equal(depositHeld(live(), fx.lease), 0);

  assert.deepEqual(both(fx, '1010'), [50000, 50000]);
  assert.deepEqual(both(fx, '1020'), [50000, 50000]);
  assert.deepEqual(both(fx, '2100'), [-50000, -50000]);
  assertBooksTie('settling again after a late charge');

  // once the check is recorded the refund is final: nothing is left to settle
  issueDepositRefund(live(), pend[0].id, { checkNumber: '2042', date: BD });
  assert.deepEqual(both(fx, '1020'), [0, 0]);
  assert.deepEqual(both(fx, '2100'), [0, 0]);
  const done = await post(base, `/leases/${fx.lease}/deposit/finalize`, {}, cookie);
  assert.equal(done.status, 303);
  assert.equal(q<any>(`SELECT id FROM refunds WHERE lease_id=?`, fx.lease).length, 1, 'an issued refund is never released');
  assert.deepEqual(both(fx, '1020'), [0, 0]);
  assertBooksTie('recording the refund check');
});

test('1+2: half-paid deposit, pending refund, then a late charge larger than the refund', () => {
  const fx = leavingLease(50000);
  owe(fx, 30000);
  const a = finalizeDeposit(live(), fx.lease, { date: BD });
  assert.deepEqual([a.writtenDown, a.applied, a.refunded], [50000, 30000, 20000]);

  owe(fx, 25000, 'damage', 'Door replacement');
  const b = finalizeDeposit(live(), fx.lease, { date: BD });
  assert.equal(b.writtenDown, 0, 'the deposit is written down once');
  assert.equal(b.applied, 20000, 'all the deposit still in escrow goes to the late charge');
  assert.equal(b.refunded, 0);
  assert.equal(b.balanceDue, 5000);

  assert.equal(pendingRefunds(fx).length, 0, 'no refund is owed any more');
  assert.ok(q1(`SELECT id FROM audit_events WHERE org_id=? AND entity_id=? AND action='released'`, liveOrg, a.refundId), 'the released refund is on the audit trail');
  assert.equal(depositHeld(live(), fx.lease), 0);
  assert.equal(val<number>(`SELECT COUNT(*) FROM charges WHERE lease_id=? AND kind='deposit' AND amount_cents<0`, fx.lease), 1);
  assert.deepEqual(openOn(fx), [{ kind: 'damage', open: 5000 }]);
  assert.deepEqual(both(fx, '1010'), [50000, 50000], 'every collected deposit dollar ended in operating');
  assert.deepEqual(both(fx, '1020'), [0, 0]);
  assert.deepEqual(both(fx, '2100'), [0, 0]);
  assert.equal(gl(fx, '1100'), 5000);
  assertBooksTie('the combined case');

  // a third run with nothing held changes nothing
  const before = val<number>(`SELECT COUNT(*) FROM journal_entries WHERE org_id=? AND property_id=?`, liveOrg, fx.prop);
  const c = finalizeDeposit(live(), fx.lease, { date: BD });
  assert.deepEqual([c.writtenDown, c.applied, c.refunded, c.balanceDue], [0, 0, 0, 5000]);
  assert.equal(val<number>(`SELECT COUNT(*) FROM journal_entries WHERE org_id=? AND property_id=?`, liveOrg, fx.prop), before);
});

// ---------- item 5 (receivables half): what counts as a deposit carried in ----------

test('5: an imported lease that has not started holds no deposit; one marked on hand does', () => {
  // fixture rows with no journal entries: kept in the other company so the live one's checks stay meaningful
  const demo = sysCtx(demoOrg, BD);
  const future = mkLease(demoOrg, { status: 'fully_executed', deposit: 150000, extra: { import_batch_id: 'imp_future' } });
  assert.equal(depositHeld(demo, future.lease), 0, 'a future resident from an import has paid nothing yet');
  for (const status of ['draft', 'out_for_signature', 'partially_signed']) {
    const fx = mkLease(demoOrg, { status, deposit: 150000, extra: { import_batch_id: 'imp_future' } });
    assert.equal(depositHeld(demo, fx.lease), 0, status);
  }
  const current = mkLease(demoOrg, { status: 'active', deposit: 150000, extra: { import_batch_id: 'imp_current' } });
  assert.equal(depositHeld(demo, current.lease), 150000, 'a current imported lease carries its deposit in');
  const onHand = mkLease(demoOrg, { status: 'draft', deposit: 150000, extra: { deposit_on_hand: 1 } });
  assert.equal(depositHeld(demo, onHand.lease), 150000, 'a lease entered with the deposit already in the bank counts in any status');
  const plain = mkLease(demoOrg, { status: 'active', deposit: 150000 });
  assert.equal(depositHeld(demo, plain.lease), 0, 'a contract amount alone is not money held');
});

// ---------- item 17: simulated programs are fenced from a live company ----------

test('17: the deposit alternative and the guaranty cannot be written for a live company', async () => {
  const fx = mkLease(liveOrg, { status: 'draft', deposit: 150000 });
  assert.throws(() => enrollDepositAlternative(live(), fx.lease, 'monthly'), /simulated program/);
  const page = await get(base, `/leases/${fx.lease}`, cookie);
  assert.equal(page.status, 200);
  assert.ok(!page.text.includes('Offer deposit alternative'), 'the offer is hidden');
  const res = await post(base, `/leases/${fx.lease}/deposit-alternative`, { mode: 'monthly' }, cookie);
  assert.equal(res.status, 303);
  assert.equal(q<any>('SELECT id FROM deposit_alternatives WHERE lease_id=?', fx.lease).length, 0);
  assert.equal(q<any>('SELECT id FROM lease_charges WHERE lease_id=?', fx.lease).length, 0, 'no program fee line');
  assert.equal(q1<any>('SELECT deposit_alternative FROM leases WHERE id=?', fx.lease).deposit_alternative, 0);

  // guaranty
  const appId = id('app');
  insert('applications', { id: appId, org_id: liveOrg, property_id: fx.prop, unit_id: fx.unit, status: 'review', move_in: '2026-09-01', rent_cents: 150000, created_at: nowIso() });
  assert.throws(() => attachGuaranty(live(), appId), /simulated program/);
  const g = await post(base, `/applications/${appId}/guaranty`, {}, cookie);
  assert.equal(g.status, 303);
  assert.equal(q<any>('SELECT id FROM guaranty_contracts WHERE application_id=?', appId).length, 0);

  // a live lease that already carries the flag gets no invented surety payout at move-out
  const old = mkLease(liveOrg, { status: 'notice', deposit: 150000, moveOut: '2026-08-31', extra: { deposit_alternative: 1 } });
  insert('deposit_alternatives', { id: id('dal'), org_id: liveOrg, property_id: old.prop, lease_id: old.lease, mode: 'monthly', fee_cents: 2300, coverage_cents: 150000, status: 'active', enrolled_date: '2026-01-01', created_at: nowIso() });
  owe(old, 90000);
  const r = finalizeDeposit(live(), old.lease, { date: BD });
  assert.equal(r.applied, 0);
  assert.equal(r.balanceDue, 90000, 'the household still owes the balance');
  assert.equal(leaseBalance(live(), old.lease), 90000);
  assert.equal(gl(old, '4110'), 0, 'no surety income posted');
  assert.equal(q1<any>('SELECT status FROM deposit_alternatives WHERE lease_id=?', old.lease).status, 'active', 'no claim recorded');
  assert.equal(q<any>(`SELECT id FROM payments WHERE lease_id=?`, old.lease).length, 0);
  assertBooksTie('a live move-out on a lease flagged deposit alternative');
});

test('17: the demo keeps both programs, and both routes respect the property scope', async () => {
  const demo = sysCtx(demoOrg, BD);
  const a = mkLease(demoOrg, { status: 'draft', deposit: 150000 });
  const b = mkLease(demoOrg, { status: 'draft', deposit: 150000 });
  const demoAdmin = await loginAs(base, adminDemo);
  const page = await get(base, `/leases/${a.lease}`, demoAdmin);
  assert.ok(page.text.includes('Offer deposit alternative'), 'the demo still offers it');

  const scoped = await loginAs(base, mkUser(demoOrg, 'pm-scoped-demo', 'PROPERTY_MANAGER', [a.prop]));
  const denied = await post(base, `/leases/${b.lease}/deposit-alternative`, { mode: 'monthly' }, scoped);
  assert.equal(denied.status, 404, 'a lease at another building is not found');
  assert.equal(q<any>('SELECT id FROM deposit_alternatives WHERE lease_id=?', b.lease).length, 0);
  const ok = await post(base, `/leases/${a.lease}/deposit-alternative`, { mode: 'monthly' }, scoped);
  assert.equal(ok.status, 303);
  const alt = q1<any>('SELECT * FROM deposit_alternatives WHERE lease_id=?', a.lease);
  assert.equal(alt.fee_cents, 2300, '1.5% of $1,500.00, to the dollar');
  assert.equal(q1<any>('SELECT deposit_alternative FROM leases WHERE id=?', a.lease).deposit_alternative, 1);

  const appB = id('app');
  insert('applications', { id: appB, org_id: demoOrg, property_id: b.prop, unit_id: b.unit, status: 'review', move_in: '2026-09-01', rent_cents: 150000, created_at: nowIso() });
  const gDenied = await post(base, `/applications/${appB}/guaranty`, {}, scoped);
  assert.equal(gDenied.status, 404);
  assert.equal(q<any>('SELECT id FROM guaranty_contracts WHERE application_id=?', appB).length, 0);
  const gid = attachGuaranty(demo, appB);
  assert.equal(q1<any>('SELECT fee_cents FROM guaranty_contracts WHERE id=?', gid).fee_cents, 136000, '85% of the $1,600.00 market rent');

  // a role that may only view screening can no longer attach one
  const viewer = await loginAs(base, mkUser(demoOrg, 'viewer-demo', 'ACCOUNTANT', null));
  const appA = id('app');
  insert('applications', { id: appA, org_id: demoOrg, property_id: a.prop, unit_id: a.unit, status: 'review', move_in: '2026-09-01', rent_cents: 150000, created_at: nowIso() });
  const gViewer = await post(base, `/applications/${appA}/guaranty`, {}, viewer);
  assert.notEqual(gViewer.status, 303);
  assert.equal(q<any>('SELECT id FROM guaranty_contracts WHERE application_id=?', appA).length, 0);
});

// ---------- item 18: delinquency and deposit actions respect the property scope ----------

test('18: a user scoped to one building cannot act on a lease at another', async () => {
  const mine = leavingLease(100000, 'active');
  const theirs = leavingLease(100000, 'active');
  owe(mine, 48000);
  owe(theirs, 48000);
  setSetting(live(), 'deposit_interest_pct', 2);
  const scoped = await loginAs(base, mkUser(liveOrg, 'pm-scoped-live', 'PROPERTY_MANAGER', [mine.prop]));

  const jeBefore = val<number>(`SELECT COUNT(*) FROM journal_entries WHERE org_id=? AND property_id=?`, liveOrg, theirs.prop);
  const outboxBefore = val<number>(`SELECT COUNT(*) FROM audit_events WHERE org_id=?`, liveOrg);
  const attempts: [string, Record<string, string>][] = [
    [`/delinquency/${theirs.lease}/note`, { kind: 'note', body: 'planted' }],
    [`/delinquency/${theirs.lease}/dunning`, { template: 'dunning_friendly' }],
    [`/delinquency/${theirs.lease}/collections`, {}],
    [`/delinquency/${theirs.lease}/writeoff`, { reason: 'not mine to write off' }],
    [`/leases/${theirs.lease}/deposit/interest`, {}],
  ];
  for (const [path, body] of attempts) {
    const res = await post(base, path, body, scoped);
    assert.equal(res.status, 404, `${path} is not found for a user scoped elsewhere`);
  }
  assert.equal(leaseBalance(live(), theirs.lease), 48000, 'nothing was written off');
  assert.equal(val<number>(`SELECT COUNT(*) FROM journal_entries WHERE org_id=? AND property_id=?`, liveOrg, theirs.prop), jeBefore, 'no entry posted on the other building');
  assert.equal(gl(theirs, '5610'), 0);
  assert.equal(gl(theirs, '5720'), 0);
  assert.equal(gl(theirs, '2100'), -100000, 'the deposit liability is untouched');
  assert.equal(q<any>('SELECT id FROM delinquency_notes WHERE lease_id=?', theirs.lease).length, 0);
  assert.equal(q<any>('SELECT id FROM collection_cases WHERE lease_id=?', theirs.lease).length, 0);
  assert.equal(q<any>(`SELECT id FROM deposit_activity WHERE lease_id=?`, theirs.lease).length, 0);
  assert.equal(val<number>(`SELECT COUNT(*) FROM audit_events WHERE org_id=?`, liveOrg), outboxBefore, 'nothing was recorded at all');

  // the same actions still work on the user's own building
  const note = await post(base, `/delinquency/${mine.lease}/note`, { kind: 'note', body: 'called, will pay Friday' }, scoped);
  assert.equal(note.status, 303);
  assert.equal(q<any>('SELECT id FROM delinquency_notes WHERE org_id=? AND lease_id=?', liveOrg, mine.lease).length, 1);
  const cc = await post(base, `/delinquency/${mine.lease}/collections`, {}, scoped);
  assert.equal(cc.status, 303);
  assert.equal(q<any>('SELECT id FROM collection_cases WHERE lease_id=?', mine.lease).length, 1);
  const wo = await post(base, `/delinquency/${mine.lease}/writeoff`, { reason: 'uncollectable' }, scoped);
  assert.equal(wo.status, 303);
  assert.equal(leaseBalance(live(), mine.lease), 0);
  assert.equal(gl(mine, '5610'), 48000);
  const interest = await post(base, `/leases/${mine.lease}/deposit/interest`, {}, scoped);
  assert.equal(interest.status, 303);
  assert.ok(gl(mine, '5720') > 0, 'interest accrued on the user’s own building');
});

test('18: a delinquency note cannot be written to, or read from, another company’s lease', async () => {
  const fx = mkLease(liveOrg);
  owe(fx, 48000);
  const outsider = await loginAs(base, adminDemo);
  const res = await post(base, `/delinquency/${fx.lease}/note`, { kind: 'note', body: 'cross-company note' }, outsider);
  assert.equal(res.status, 404);
  assert.equal(q<any>('SELECT id FROM delinquency_notes WHERE lease_id=?', fx.lease).length, 0);

  // a row planted before the fix no longer renders on the owner's page
  insert('delinquency_notes', { id: id('dnn'), org_id: demoOrg, lease_id: fx.lease, kind: 'note', body: 'PLANTED-BY-OTHER-COMPANY', created_by: null, created_at: nowIso() });
  insert('delinquency_notes', { id: id('dnn'), org_id: liveOrg, lease_id: fx.lease, kind: 'note', body: 'OWN-COMPANY-NOTE', created_by: null, created_at: nowIso() });
  const page = await get(base, `/delinquency/${fx.lease}`, cookie);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('OWN-COMPANY-NOTE'));
  assert.ok(!page.text.includes('PLANTED-BY-OTHER-COMPANY'));
});
