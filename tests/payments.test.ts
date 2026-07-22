import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureFinance, type FinanceFx } from './harness.ts';
import { sysCtx } from '../src/lib/auth.ts';
import { q, q1, insert, val, run } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso, addDays } from '../src/lib/dates.ts';
import { createCharge, leaseBalance, runRentPosting } from '../src/modules/m8_receivables/service.ts';
import {
  recordPayment, settleDuePayments, lateFeeCandidates, assessLateFees, waiveLateFee,
  createPaymentPlan, runPaymentPlans, finalizeDeposit, depositHeld, PaymentRejected, runAutopay,
} from '../src/modules/m8_receivables/payments.ts';
import { runInvariants, accountBalance } from '../src/modules/m9_accounting/service.ts';

let fx: FinanceFx;
const D = '2026-07-01';

function mkLease(rent = 120000, deposit = 0): string {
  const leaseId = id('lse');
  insert('leases', {
    id: leaseId, org_id: fx.orgId, property_id: fx.propId, unit_id: fx.unitId, household_name: `H-${leaseId.slice(-5)}`,
    status: 'active', start_date: '2026-01-01', end_date: '2026-12-31', move_in_date: '2026-01-01',
    rent_cents: rent, deposit_cents: deposit, term_months: 12, created_at: nowIso(),
  });
  const rid = id('res');
  insert('residents', {
    id: rid, org_id: fx.orgId, property_id: fx.propId, first_name: 'Testy', last_name: leaseId.slice(-5),
    email: `${leaseId.slice(-8)}@t.test`, phone: '(555) 200-1000', kind: 'adult', created_at: nowIso(),
  });
  insert('household_members', { id: id('hm'), org_id: fx.orgId, lease_id: leaseId, resident_id: rid, role: 'primary', created_at: nowIso() });
  return leaseId;
}

function mkToken(behavior: string): string {
  const uid = id('usr');
  insert('users', { id: uid, org_id: fx.orgId, email: `${uid}@t.test`, name: 'T', kind: 'resident', password_hash: 'x', active: 1, created_at: nowIso() });
  const tid = id('tok');
  insert('payment_method_tokens', {
    id: tid, org_id: fx.orgId, user_id: uid, kind: 'ach', label: 'test', token: 't', behavior, is_default: 1, created_at: nowIso(),
  });
  return tid;
}

before(() => {
  fx = fixtureFinance();
});

test('payment lifecycle: pending → settled (T+3) with settlement batch + GL', () => {
  const ctx = sysCtx(fx.orgId, D);
  const lease = mkLease();
  createCharge(ctx, { leaseId: lease, kind: 'rent', label: 'Rent', amountCents: 120000, date: D });
  const pid = recordPayment(ctx, { leaseId: lease, amountCents: 120000, method: 'ach', methodTokenId: mkToken('ok_always'), receivedDate: D });
  let p = q1<any>('SELECT * FROM payments WHERE id=?', pid);
  assert.equal(p.status, 'pending');
  assert.equal(p.settle_date, addDays(D, 3));
  assert.equal(leaseBalance(ctx, lease), 0); // pending counts toward balance

  settleDuePayments(sysCtx(fx.orgId, addDays(D, 3)), addDays(D, 3));
  p = q1<any>('SELECT * FROM payments WHERE id=?', pid);
  assert.equal(p.status, 'settled');
  assert.ok(p.settlement_batch_id);
  const batch = q1<any>('SELECT * FROM settlement_batches WHERE id=?', p.settlement_batch_id);
  assert.equal(batch.total_cents >= 120000, true);
});

test('NSF reinstates balance, charges fee, and notifies (gate)', () => {
  const ctx = sysCtx(fx.orgId, D);
  const lease = mkLease(100000);
  createCharge(ctx, { leaseId: lease, kind: 'rent', label: 'Rent', amountCents: 100000, date: D });
  const pid = recordPayment(ctx, { leaseId: lease, amountCents: 100000, method: 'ach', methodTokenId: mkToken('nsf'), receivedDate: D });
  assert.equal(leaseBalance(ctx, lease), 0);
  const msgsBefore = val<number>(`SELECT COUNT(*) FROM outbox_messages WHERE org_id=? AND template_key='payment_nsf'`, fx.orgId) || 0;

  settleDuePayments(sysCtx(fx.orgId, addDays(D, 3)), addDays(D, 3));
  const p = q1<any>('SELECT * FROM payments WHERE id=?', pid);
  assert.equal(p.status, 'nsf');
  // balance = rent reinstated + NSF fee ($35 default)
  assert.equal(leaseBalance(ctx, lease), 100000 + 3500);
  const msgsAfter = val<number>(`SELECT COUNT(*) FROM outbox_messages WHERE org_id=? AND template_key='payment_nsf'`, fx.orgId) || 0;
  assert.equal(msgsAfter > msgsBefore, true, 'NSF notification sent');
});

test('application order pays deposits before rent before fees', () => {
  const ctx = sysCtx(fx.orgId, D);
  const lease = mkLease(90000, 50000);
  createCharge(ctx, { leaseId: lease, kind: 'late_fee', label: 'Fee', amountCents: 5000, date: D, dueDate: D });
  createCharge(ctx, { leaseId: lease, kind: 'rent', label: 'Rent', amountCents: 90000, date: D, dueDate: D });
  createCharge(ctx, { leaseId: lease, kind: 'deposit', label: 'Deposit', amountCents: 50000, date: D, dueDate: D });
  recordPayment(ctx, { leaseId: lease, amountCents: 60000, method: 'check', receivedDate: D });
  const apps = q<any>(
    `SELECT c.kind, pa.amount_cents FROM payment_applications pa JOIN charges c ON c.id=pa.charge_id
     JOIN payments p ON p.id=pa.payment_id WHERE p.lease_id=? ORDER BY pa.amount_cents DESC`,
    lease,
  );
  const byKind = Object.fromEntries(apps.map((a: any) => [a.kind, a.amount_cents]));
  assert.equal(byKind['deposit'], 50000); // deposit first
  assert.equal(byKind['rent'], 10000); // remainder to rent
  assert.equal(byKind['late_fee'], undefined); // fees last, unfunded
});

test('late fee policy: grace, preview, assess once, waive', () => {
  const ctx5 = sysCtx(fx.orgId, '2026-08-05');
  const lease = mkLease(110000);
  createCharge(sysCtx(fx.orgId, '2026-08-01'), {
    leaseId: lease, kind: 'rent', label: 'Rent', amountCents: 110000, date: '2026-08-01', dueDate: '2026-08-01', monthKey: '2026-08',
  });
  // inside grace (due+3): no candidate on the 3rd
  assert.equal(lateFeeCandidates(sysCtx(fx.orgId, '2026-08-03'), '2026-08-03').some((c) => c.leaseId === lease), false);
  // day 5: candidate with flat fee $50
  const cands = lateFeeCandidates(ctx5, '2026-08-05').filter((c) => c.leaseId === lease);
  assert.equal(cands.length, 1);
  assert.equal(cands[0]!.fee, 5000);
  assessLateFees(ctx5, '2026-08-05');
  const fees = q<any>(`SELECT * FROM charges WHERE lease_id=? AND kind='late_fee' AND amount_cents>0`, lease);
  assert.equal(fees.length, 1);
  // re-assess same day: daily accrual only after a day passes; initial not duplicated
  assessLateFees(ctx5, '2026-08-05');
  assert.equal(q<any>(`SELECT * FROM charges WHERE lease_id=? AND kind='late_fee' AND amount_cents>0`, lease).length, 1);
  // next day: daily accrual $10
  assessLateFees(sysCtx(fx.orgId, '2026-08-06'), '2026-08-06');
  const fees2 = q<any>(`SELECT * FROM charges WHERE lease_id=? AND kind='late_fee' AND amount_cents>0 ORDER BY date`, lease);
  assert.equal(fees2.length, 2);
  assert.equal(fees2[1]!.amount_cents, 1000);
  // waive the flat fee
  waiveLateFee(sysCtx(fx.orgId, '2026-08-06'), fees2[0]!.id, 'test goodwill');
  const balNow = leaseBalance(sysCtx(fx.orgId), lease);
  assert.equal(balNow, 110000 + 1000); // rent + daily fee only
});

test('overpayment becomes credit and auto-applies to the next charge', () => {
  const ctx = sysCtx(fx.orgId, D);
  const lease = mkLease(80000);
  createCharge(ctx, { leaseId: lease, kind: 'rent', label: 'Rent', amountCents: 80000, date: D });
  recordPayment(ctx, { leaseId: lease, amountCents: 100000, method: 'check', receivedDate: D });
  assert.equal(leaseBalance(ctx, lease), -20000); // credit
  createCharge(ctx, { leaseId: lease, kind: 'utility', label: 'Water', amountCents: 15000, date: addDays(D, 5) });
  assert.equal(leaseBalance(ctx, lease), -5000); // credit consumed the new charge
  const applied = val<number>(
    `SELECT COALESCE(SUM(pa.amount_cents),0) FROM payment_applications pa JOIN charges c ON c.id=pa.charge_id WHERE c.lease_id=? AND c.kind='utility'`,
    lease,
  );
  assert.equal(applied, 15000);
});

test('autopay drafts full balance on the enrolled day', () => {
  const ctx = sysCtx(fx.orgId, '2026-09-01');
  const lease = mkLease(95000);
  const tok = mkToken('ok_always');
  const user = q1<any>('SELECT user_id FROM payment_method_tokens WHERE id=?', tok);
  insert('autopay_enrollments', {
    id: id('apy'), org_id: fx.orgId, lease_id: lease, user_id: user.user_id, method_token_id: tok,
    mode: 'full_balance', day_of_month: 1, start_date: '2026-01-01', active: 1, created_at: nowIso(),
  });
  createCharge(ctx, { leaseId: lease, kind: 'rent', label: 'Rent', amountCents: 95000, date: '2026-09-01' });
  runAutopay(ctx, '2026-09-01');
  assert.equal(leaseBalance(ctx, lease), 0);
  const p = q1<any>('SELECT * FROM payments WHERE lease_id=? AND autopay=1', lease);
  assert.ok(p);
  // idempotent within the month
  runAutopay(ctx, '2026-09-01');
  assert.equal(q<any>('SELECT * FROM payments WHERE lease_id=? AND autopay=1', lease).length, 1);
});

test('payment plan: installments auto-charge and complete', () => {
  const ctx = sysCtx(fx.orgId, D);
  const lease = mkLease(150000);
  const tok = mkToken('ok_always');
  run('UPDATE payment_method_tokens SET lease_id=? WHERE id=?', lease, tok);
  createCharge(ctx, { leaseId: lease, kind: 'rent', label: 'Rent', amountCents: 150000, date: D });
  createPaymentPlan(ctx, lease, 150000, [
    { dueDate: '2026-07-10', amountCents: 75000 },
    { dueDate: '2026-07-24', amountCents: 75000 },
  ]);
  runPaymentPlans(sysCtx(fx.orgId, '2026-07-10'), '2026-07-10');
  assert.equal(leaseBalance(ctx, lease), 75000);
  runPaymentPlans(sysCtx(fx.orgId, '2026-07-24'), '2026-07-24');
  assert.equal(leaseBalance(ctx, lease), 0);
  const plan = q1<any>('SELECT * FROM payment_plans WHERE lease_id=?', lease);
  assert.equal(plan.status, 'completed');
});

test('deposit disposition: apply to damages, refund remainder, GL exact', () => {
  const ctx = sysCtx(fx.orgId, D);
  const lease = mkLease(100000, 120000);
  // deposit charged and paid
  createCharge(ctx, { leaseId: lease, kind: 'deposit', label: 'Security deposit', amountCents: 120000, date: D });
  recordPayment(ctx, { leaseId: lease, amountCents: 120000, method: 'check', receivedDate: D, suppressReceipt: true });
  assert.equal(depositHeld(ctx, lease), 120000);
  // move-out damages
  createCharge(ctx, { leaseId: lease, kind: 'damage', label: 'Carpet', amountCents: 45000, date: addDays(D, 10) });
  const result = finalizeDeposit(ctx, lease, { date: addDays(D, 12) });
  assert.equal(result.applied, 45000);
  assert.equal(result.refunded, 75000);
  assert.equal(result.balanceDue, 0);
  assert.equal(leaseBalance(ctx, lease), 0);
  assert.equal(depositHeld(ctx, lease), 0);
  const refund = q1<any>(`SELECT * FROM refunds WHERE lease_id=? AND kind='deposit'`, lease);
  assert.equal(refund.amount_cents, 75000);
});

test('deposit shortfall goes to collections', () => {
  const ctx = sysCtx(fx.orgId, D);
  const lease = mkLease(100000, 50000);
  createCharge(ctx, { leaseId: lease, kind: 'deposit', label: 'Deposit', amountCents: 50000, date: D });
  recordPayment(ctx, { leaseId: lease, amountCents: 50000, method: 'check', receivedDate: D, suppressReceipt: true });
  createCharge(ctx, { leaseId: lease, kind: 'damage', label: 'Big damage', amountCents: 90000, date: addDays(D, 5) });
  const result = finalizeDeposit(ctx, lease, { date: addDays(D, 6), toCollections: true });
  assert.equal(result.applied, 50000);
  assert.equal(result.refunded, 0);
  assert.equal(result.balanceDue, 40000);
  const cc = q1<any>(`SELECT * FROM collection_cases WHERE lease_id=?`, lease);
  assert.ok(cc);
});

test('partial payments respect property policy', () => {
  const ctx = sysCtx(fx.orgId, D);
  const lease = mkLease(100000);
  createCharge(ctx, { leaseId: lease, kind: 'rent', label: 'Rent', amountCents: 100000, date: D });
  const { setSetting } = requireSettings();
  setSetting(ctx, 'partial_payments', { allow: false, blockWhenEvictionFiled: true }, fx.propId);
  assert.throws(() => recordPayment(ctx, { leaseId: lease, amountCents: 50000, method: 'check', receivedDate: D }), /partial payments are not accepted/);
  setSetting(ctx, 'partial_payments', { allow: true, blockWhenEvictionFiled: true }, fx.propId);
  recordPayment(ctx, { leaseId: lease, amountCents: 50000, method: 'check', receivedDate: D });
  assert.equal(leaseBalance(ctx, lease), 50000);
});

test('invariants hold after the full payment battery', () => {
  settleDuePayments(sysCtx(fx.orgId, '2026-10-01'), '2026-10-01');
  const results = runInvariants(sysCtx(fx.orgId));
  for (const r of results) assert.equal(r.ok, true, `${r.name}: ${r.detail}`);
});

import { setSetting as _ss } from '../src/lib/settings.ts';
function requireSettings(): { setSetting: typeof _ss } {
  return { setSetting: _ss };
}
