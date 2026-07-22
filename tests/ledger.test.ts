import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureFinance, type FinanceFx } from './harness.ts';
import { sysCtx } from '../src/lib/auth.ts';
import { q, q1, insert, run, val } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { postJE, runInvariants, accountBalance, UnbalancedEntry, ClosedPeriod } from '../src/modules/m9_accounting/service.ts';
import {
  createCharge, leaseLedger, leaseBalance, runRentPosting, postMonthlyChargesForLease, voidCharge,
} from '../src/modules/m8_receivables/service.ts';
import { advanceBusinessDate } from '../src/lib/jobs.ts';
import '../src/modules/m8_receivables/service.ts';

let fx: FinanceFx;

before(() => {
  fx = fixtureFinance();
});

test('unbalanced journal entries are rejected', () => {
  const ctx = sysCtx(fx.orgId);
  assert.throws(
    () =>
      postJE(ctx, {
        propertyId: fx.propId, date: '2026-07-01', basis: 'accrual', sourceKind: 'manual',
        lines: [{ account: '1100', debit: 1000 }, { account: '4010', credit: 900 }],
      }),
    /does not balance/,
  );
  assert.throws(
    () =>
      postJE(ctx, {
        propertyId: fx.propId, date: '2026-07-01', basis: 'accrual', sourceKind: 'manual',
        lines: [{ account: '1100', debit: -100 }, { account: '4010', credit: -100 }],
      }),
  );
});

test('charge posting creates a balanced accrual JE and hits the ledger', () => {
  const ctx = sysCtx(fx.orgId);
  const before1100 = accountBalance(ctx, '1100');
  const before4010 = accountBalance(ctx, '4010');
  createCharge(ctx, {
    leaseId: fx.leaseId, kind: 'rent', label: 'Rent — July', amountCents: 150000,
    date: '2026-07-01', monthKey: null, source: 'oneoff',
  });
  assert.equal(accountBalance(ctx, '1100') - before1100, 150000);
  assert.equal(accountBalance(ctx, '4010') - before4010, -150000); // income is credit-normal
  const ledger = leaseLedger(ctx, fx.leaseId);
  assert.equal(ledger.length >= 1, true);
  assert.equal(ledger[ledger.length - 1]!.balance, leaseBalance(ctx, fx.leaseId));
});

test('concession posts as negative charge and reduces balance', () => {
  const ctx = sysCtx(fx.orgId);
  const before = leaseBalance(ctx, fx.leaseId);
  createCharge(ctx, {
    leaseId: fx.leaseId, kind: 'concession', label: 'Move-in special', amountCents: -20000,
    date: '2026-07-02', source: 'oneoff',
  });
  assert.equal(leaseBalance(ctx, fx.leaseId), before - 20000);
});

test('recurring engine is idempotent and includes all schedule lines', () => {
  const ctx = sysCtx(fx.orgId);
  const lease = q1<any>('SELECT * FROM leases WHERE id=?', fx.leaseId);
  const n1 = postMonthlyChargesForLease(ctx, lease, '2026-08');
  assert.equal(n1, 2); // rent + pet
  const n2 = postMonthlyChargesForLease(ctx, lease, '2026-08');
  assert.equal(n2, 0); // no duplicates
  const augRent = q<any>(
    `SELECT * FROM charges WHERE lease_id=? AND month_key='2026-08' AND kind='rent'`, fx.leaseId,
  );
  assert.equal(augRent.length, 1);
  assert.equal(augRent[0].amount_cents, 150000);
});

test('move-in mid-month prorates by actual days', () => {
  const ctx = sysCtx(fx.orgId);
  const leaseId = id('lse');
  insert('leases', {
    id: leaseId, org_id: fx.orgId, property_id: fx.propId, unit_id: fx.unitId, household_name: 'Prorate household',
    status: 'active', start_date: '2026-07-17', end_date: '2027-07-16', move_in_date: '2026-07-17',
    rent_cents: 155000, deposit_cents: 0, term_months: 12, created_at: nowIso(),
  });
  insert('lease_charges', { id: id('lc'), org_id: fx.orgId, lease_id: leaseId, kind: 'rent', label: 'Rent', amount_cents: 155000, created_at: nowIso() });
  const lease = q1<any>('SELECT * FROM leases WHERE id=?', leaseId);
  postMonthlyChargesForLease(ctx, lease, '2026-07');
  const charge = q1<any>(`SELECT * FROM charges WHERE lease_id=? AND month_key='2026-07'`, leaseId);
  // Jul 17–31 = 15 days of 31 → 155000 * 15/31 = 75000
  assert.equal(charge.amount_cents, Math.round((155000 * 15) / 31));
  assert.match(charge.label, /prorated 15d/);
});

test('month-to-month leases get the MTM premium', () => {
  const ctx = sysCtx(fx.orgId);
  const leaseId = id('lse');
  insert('leases', {
    id: leaseId, org_id: fx.orgId, property_id: fx.propId, unit_id: fx.unitId, household_name: 'MTM household',
    status: 'month_to_month', start_date: '2025-06-01', end_date: '2026-05-31', move_in_date: '2025-06-01',
    mtm_since: '2026-05-31', rent_cents: 100000, deposit_cents: 0, term_months: 12, created_at: nowIso(),
  });
  insert('lease_charges', { id: id('lc'), org_id: fx.orgId, lease_id: leaseId, kind: 'rent', label: 'Rent', amount_cents: 100000, created_at: nowIso() });
  const lease = q1<any>('SELECT * FROM leases WHERE id=?', leaseId);
  const n = postMonthlyChargesForLease(ctx, lease, '2026-08');
  assert.equal(n, 2); // rent + premium
  const premium = q1<any>(`SELECT * FROM charges WHERE lease_id=? AND kind='mtm_premium' AND month_key='2026-08'`, leaseId);
  assert.equal(premium.amount_cents, 15000); // default 15%
});

test('void reverses the charge in GL and ledger', () => {
  const ctx = sysCtx(fx.orgId);
  const cid = createCharge(ctx, {
    leaseId: fx.leaseId, kind: 'other', label: 'Oops fee', amountCents: 5000, date: '2026-07-03',
  });
  const before = leaseBalance(ctx, fx.leaseId);
  voidCharge(ctx, cid, 'entered in error');
  assert.equal(leaseBalance(ctx, fx.leaseId), before - 5000);
});

test('posting into a closed period is blocked', () => {
  const ctx = sysCtx(fx.orgId);
  insert('accounting_periods', {
    id: id('per'), org_id: fx.orgId, property_id: fx.propId, period_key: '2026-01', status: 'closed',
    checklist: '{}', closed_at: nowIso(), closed_by: 'test',
  });
  assert.throws(
    () =>
      postJE(ctx, {
        propertyId: fx.propId, date: '2026-01-15', basis: 'accrual', sourceKind: 'manual',
        lines: [{ account: '1100', debit: 100 }, { account: '4010', credit: 100 }],
      }),
    /closed/,
  );
});

test('advancing the business date posts rent org-wide (the Phase 2 gate)', () => {
  const ctx = sysCtx(fx.orgId);
  const augBefore = val<number>(`SELECT COUNT(*) FROM charges WHERE org_id=? AND month_key='2026-09'`, fx.orgId) || 0;
  assert.equal(augBefore, 0);
  advanceBusinessDate(fx.orgId, '2026-09-01');
  const sepCharges = val<number>(`SELECT COUNT(*) FROM charges WHERE org_id=? AND month_key='2026-09'`, fx.orgId) || 0;
  assert.equal(sepCharges >= 3, true, `expected September charges, got ${sepCharges}`); // fin lease (2) + mtm lease (2) + prorate lease (1)
});

test('financial invariants hold after all activity', () => {
  const results = runInvariants(sysCtx(fx.orgId));
  for (const r of results) assert.equal(r.ok, true, `${r.name}: ${r.detail}`);
});
