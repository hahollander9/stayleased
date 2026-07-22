import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert, run, val, j } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { sysCtx, hashPassword, buildCtx } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { postJE, accountBalance, runInvariants, ClosedPeriod } from '../src/modules/m9_accounting/service.ts';
import { createInvoice, submitInvoice, approveInvoice, createPaymentRun, voidApPayment, apAging } from '../src/modules/m9_accounting/ap.ts';
import { ensureBankAccounts, importAllFeeds, createRecon, autoMatch, postAdjustment, completeRecon, unmatchedTotal, reconSummary } from '../src/modules/m9_accounting/banking.ts';
import { closeChecklist, closePeriod, reopenPeriod, submitManualJe, decidePendingJe, createRecurringJe, runRecurringJes } from '../src/modules/m9_accounting/close.ts';
import { spread, createBudget, setBudgetLine, approveBudget, budgetVsActual, seedFromActuals } from '../src/modules/m9_accounting/budgets.ts';
import { balanceSheet, incomeStatement, t12, cashFlow } from '../src/modules/m9_accounting/statements.ts';

/** Phase 10 units: AP lifecycle + intercompany, bank feed & reconciliation,
 * period close, recurring/manual JEs, budgets, statement tie-outs. */

let orgId: string;
let propA: string; // pays centrally
let propB: string;
let vendorId: string;
const BD = '2026-07-26';

function mkProp(name: string, slug: string): string {
  const pid = id('prp');
  insert('properties', {
    id: pid, org_id: orgId, name, slug, type: 'multifamily',
    address1: '1 Acct St', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso(),
  });
  return pid;
}

before(() => {
  db();
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'Acct Test Org', slug: 'acct-' + orgId.slice(-6), business_date: BD, created_at: nowIso() });
  ensureCoa(orgId);
  propA = mkProp('Alpha Court', 'alpha-court-' + orgId.slice(-4));
  propB = mkProp('Beta Flats', 'beta-flats-' + orgId.slice(-4));
  vendorId = id('vnd');
  insert('vendors', {
    id: vendorId, org_id: orgId, name: 'Test Trades LLC', category: 'general',
    email: 'ap@testtrades.demo', w9_on_file: 1, is_1099: 1, diversity_tags: '[]', approved_property_ids: '[]', active: 1, created_at: nowIso(),
  });
  // opening cash so the feed has an anchor
  const ctx = sysCtx(orgId);
  for (const p of [propA, propB]) {
    for (const basis of ['accrual', 'cash'] as const) {
      postJE(ctx, {
        propertyId: p, date: '2026-06-30', basis, memo: 'Opening cash', sourceKind: 'opening',
        lines: [{ account: '1010', debit: 5000000 }, { account: '3020', credit: 5000000 }],
      });
    }
  }
  ensureBankAccounts(orgId);
});

test('AP: split invoice under threshold auto-approves and posts a balanced accrual', () => {
  const ctx = sysCtx(orgId);
  const invId = createInvoice(ctx, {
    vendorId, propertyId: propA, invoiceNumber: 'T-1001', invoiceDate: '2026-07-05',
    lines: [
      { glAccount: '5010', description: 'repairs', amountCents: 90000 },
      { glAccount: '5910', description: 'materials', amountCents: 30000 },
    ],
  });
  assert.equal(submitInvoice(ctx, invId), 'approved'); // 1,200 < 2,500 threshold, sysCtx can approve
  const inv = q1<any>('SELECT * FROM vendor_invoices WHERE id=?', invId);
  assert.equal(inv.status, 'approved');
  const je = q1<any>(`SELECT * FROM journal_entries WHERE source_kind='invoice' AND source_id=?`, invId);
  assert.ok(je);
  const lines = q<any>('SELECT * FROM journal_lines WHERE entry_id=?', je.id);
  assert.equal(lines.reduce((s, l) => s + l.debit_cents - l.credit_cents, 0), 0);
  assert.equal(lines.find((l) => l.account_code === '2010')?.credit_cents, 120000);
});

test('AP: large invoice routes to approval; payment run relieves AP on both bases', () => {
  const ctx = sysCtx(orgId);
  const invId = createInvoice(ctx, {
    vendorId, propertyId: propA, invoiceNumber: 'T-1002', invoiceDate: '2026-07-06',
    lines: [{ glAccount: '5020', description: 'full corridor repaint', amountCents: 800000 }],
  });
  assert.equal(submitInvoice(ctx, invId), 'pending_approval'); // 8,000 > 2,500
  approveInvoice(ctx, invId);

  const ap0 = accountBalance(ctx, '2010', { propertyId: propA, basis: 'accrual' }); // credit-negative
  createPaymentRun(ctx, { runDate: '2026-07-10', method: 'check', invoiceIds: [invId] });
  const ap1 = accountBalance(ctx, '2010', { propertyId: propA, basis: 'accrual' });
  assert.equal(ap1 - ap0, 800000, 'AP relieved');
  const pay = q1<any>('SELECT * FROM ap_payments WHERE invoice_id=?', invId);
  assert.ok(Number(pay.check_number) > 5000);
  // cash basis recognized the expense at payment
  const cashExp = accountBalance(ctx, '5020', { propertyId: propA, basis: 'cash' });
  assert.equal(cashExp >= 800000, true);
});

test('AP: void + reissue reverses the payment and cuts a new check', () => {
  const ctx = sysCtx(orgId);
  const invId = createInvoice(ctx, {
    vendorId, propertyId: propA, invoiceNumber: 'T-1003', invoiceDate: '2026-07-07',
    lines: [{ glAccount: '5030', description: 'grounds', amountCents: 50000 }],
  });
  approveInvoice(ctx, invId);
  createPaymentRun(ctx, { runDate: '2026-07-11', method: 'check', invoiceIds: [invId] });
  const pay = q1<any>('SELECT * FROM ap_payments WHERE invoice_id=? ORDER BY created_at DESC', invId);
  const cash0 = accountBalance(ctx, '1010', { propertyId: propA, basis: 'accrual' });
  voidApPayment(ctx, pay.id, 'printer jammed', true);
  const voided = q1<any>('SELECT * FROM ap_payments WHERE id=?', pay.id);
  assert.equal(voided.status, 'void');
  assert.ok(voided.reissued_payment_id);
  const reissued = q1<any>('SELECT * FROM ap_payments WHERE id=?', voided.reissued_payment_id);
  assert.equal(reissued.status, 'issued');
  assert.notEqual(reissued.check_number, voided.check_number);
  // net cash effect of void+reissue is zero (reversal + new payment)
  const cash1 = accountBalance(ctx, '1010', { propertyId: propA, basis: 'accrual' });
  assert.equal(cash1, cash0);
  assert.equal(q1<any>('SELECT status FROM vendor_invoices WHERE id=?', invId).status, 'paid');
});

test('AP: intercompany payment builds due-to/due-from automatically', () => {
  const ctx = sysCtx(orgId);
  const invId = createInvoice(ctx, {
    vendorId, propertyId: propB, invoiceNumber: 'T-2001', invoiceDate: '2026-07-08',
    lines: [{ glAccount: '5010', description: 'mitigation', amountCents: 250000 }],
  });
  approveInvoice(ctx, invId);
  createPaymentRun(ctx, { runDate: '2026-07-12', method: 'check', invoiceIds: [invId], payFromPropertyId: propA });
  const dueFromA = accountBalance(ctx, '1300', { propertyId: propA, basis: 'accrual' });
  const dueToB = -accountBalance(ctx, '2300', { propertyId: propB, basis: 'accrual' });
  assert.equal(dueFromA, 250000);
  assert.equal(dueToB, 250000);
  // B's AP relieved without B paying cash
  assert.equal(accountBalance(ctx, '2010', { propertyId: propB, basis: 'accrual' }), 0);
});

test('bank feed mirrors the books and reconciles a month to zero', () => {
  const ctx = sysCtx(orgId);
  importAllFeeds(orgId, BD);
  const acct = q1<any>(`SELECT * FROM bank_accounts WHERE org_id=? AND property_id=?`, orgId, propA);
  // June: only the opening JE
  const juneRec = createRecon(ctx, acct.id, '2026-06');
  autoMatch(ctx, juneRec);
  // bank-only monthly items (interest/noise) get adjustment JEs — the real workflow
  for (const t of q<any>(`SELECT id FROM bank_txns WHERE bank_account_id=? AND substr(date,1,7)='2026-06' AND status='unmatched'`, acct.id)) {
    postAdjustment(ctx, t.id, juneRec);
  }
  assert.equal(unmatchedTotal(orgId, acct.id, '2026-06'), 0);
  completeRecon(ctx, juneRec);
  assert.equal(q1<any>('SELECT status FROM bank_recons WHERE id=?', juneRec).status, 'completed');

  // July: checks clear with a lag; JE mirror + CHK txns all auto-match by ref
  const julyRec = createRecon(ctx, acct.id, '2026-07');
  const res = autoMatch(ctx, julyRec);
  assert.equal(res.remaining, 0, 'every feed txn matches by stable ref');
  const summary = reconSummary(ctx, julyRec);
  // book vs bank ties modulo outstanding checks (issued, not yet cleared by BD)
  const explained = summary.bookClose - summary.outstanding.reduce((s, o) => s + o.amount, 0) + summary.inTransit.reduce((s, o) => s + o.amount, 0);
  assert.equal(summary.rec.statement_close_cents, explained);
});

test('bank-only items need an adjustment JE that trues the books', () => {
  const ctx = sysCtx(orgId);
  const acct = q1<any>(`SELECT * FROM bank_accounts WHERE org_id=? AND property_id=?`, orgId, propA);
  const feeTxnId = id('btx');
  insert('bank_txns', {
    id: feeTxnId, org_id: orgId, bank_account_id: acct.id, date: '2026-07-15',
    amount_cents: -4500, description: 'WIRE FEE', ref: 'TESTFEE-' + orgId.slice(-6), kind: 'fee',
    status: 'unmatched', imported_at: nowIso(),
  });
  const cash0 = accountBalance(ctx, '1010', { propertyId: propA, basis: 'accrual' });
  const jeId = postAdjustment(ctx, feeTxnId, null);
  assert.ok(jeId);
  const cash1 = accountBalance(ctx, '1010', { propertyId: propA, basis: 'accrual' });
  assert.equal(cash0 - cash1, 4500, 'books now reflect the bank fee');
  assert.equal(q1<any>('SELECT status FROM bank_txns WHERE id=?', feeTxnId).status, 'matched');
});

test('recurring JEs post monthly and catch up after long advances', () => {
  const ctx = sysCtx(orgId);
  createRecurringJe(ctx, {
    propertyId: propB, name: 'Test amortization', lines: [
      { account: '5410', debit: 10000 }, { account: '1200', credit: 10000 },
    ], dayOfMonth: 1, startMonth: '2026-05',
  });
  const posted = runRecurringJes(ctx, BD);
  assert.equal(posted, 3, 'May, June, July catch-up');
  assert.equal(runRecurringJes(ctx, BD), 0, 'idempotent');
  assert.equal(accountBalance(ctx, '5410', { propertyId: propB, basis: 'accrual' }), 30000);
});

test('close checklist gates the period; closed periods block postings; audited reopen', () => {
  const ctx = sysCtx(orgId);
  // June checklist requires the bank rec (done in the earlier test) — but propB has no recon yet
  const listB = closeChecklist(ctx, propB, '2026-06');
  assert.equal(listB.find((i) => i.key === 'bank_rec')?.ok, false);
  assert.throws(() => closePeriod(ctx, propB, '2026-06'), /checklist incomplete/);

  // propA: reconciled June + no pending AP/JEs → closes
  const listA = closeChecklist(ctx, propA, '2026-06');
  assert.equal(listA.every((i) => i.ok), true, JSON.stringify(listA.filter((i) => !i.ok)));
  closePeriod(ctx, propA, '2026-06');
  assert.throws(
    () => postJE(ctx, {
      propertyId: propA, date: '2026-06-20', basis: 'accrual', memo: 'late entry', sourceKind: 'manual',
      lines: [{ account: '5010', debit: 100 }, { account: '1010', credit: 100 }],
    }),
    /is closed/,
  );
  assert.throws(() => reopenPeriod(ctx, propA, '2026-06', ''), /reason/);
  reopenPeriod(ctx, propA, '2026-06', 'auditor requested a reclass');
  postJE(ctx, {
    propertyId: propA, date: '2026-06-20', basis: 'accrual', memo: 'reclass', sourceKind: 'manual',
    lines: [{ account: '5010', debit: 100 }, { account: '5020', credit: 100 }],
  });
});

test('manual JE over the threshold routes to a controller', () => {
  const ctx = sysCtx(orgId);
  // an accountant-persona ctx without close permission: simulate via a staff user with ACCOUNTANT? Simpler: sysCtx has all perms → posts immediately
  const small = submitManualJe(ctx, {
    propertyId: propB, date: BD, memo: 'accrue misc', basis: 'both',
    lines: [{ account: '5810', debit: 20000 }, { account: '2200', credit: 20000 }],
  });
  assert.equal(small.status, 'posted');
  // build a limited user (PROPERTY_MANAGER has gl:post? no — use direct insert of pending row via submit with a ctx lacking gl:close_period)
  const uid = id('usr');
  insert('users', { id: uid, org_id: orgId, email: `pm@acct-${orgId.slice(-4)}.test`, name: 'Penny Manager', kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso() });
  insert('role_assignments', { id: id('ra'), org_id: orgId, user_id: uid, role: 'PROPERTY_MANAGER', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  const pmCtx = buildCtx(q1<any>('SELECT * FROM users WHERE id=?', uid), null, null);
  const big = submitManualJe(pmCtx, {
    propertyId: propB, date: BD, memo: 'big accrual', basis: 'accrual',
    lines: [{ account: '5810', debit: 9000000 }, { account: '2200', credit: 9000000 }],
  });
  assert.equal(big.status, 'pending');
  const jeId = decidePendingJe(ctx, big.id, true);
  assert.ok(jeId);
  assert.equal(q1<any>('SELECT status FROM pending_jes WHERE id=?', big.id).status, 'posted');
});

test('budget spreads sum exactly; variance flags fire past the threshold', () => {
  const ctx = sysCtx(orgId);
  for (const curve of ['even', 'seasonal_summer', 'front', 'back'] as const) {
    const months = spread(1234567, curve);
    assert.equal(months.reduce((s, x) => s + x, 0), 1234567, curve);
  }
  const bid = createBudget(ctx, propA, 2026);
  setBudgetLine(ctx, bid, '5010', spread(120000, 'even')); // $100/mo budget
  approveBudget(ctx, bid);
  // actual 5010 spend on propA this year is way over $700 YTD (from AP tests)
  const { rows } = budgetVsActual(ctx, bid, 7);
  const r = rows.find((x) => x.code === '5010')!;
  assert.equal(r.flag, 'over');
  assert.equal(r.varianceCents > 0, true);
});

test('statements: BS balances both bases; IS ties to T-12; cash flow ties to GL', () => {
  const ctx = sysCtx(orgId);
  for (const basis of ['accrual', 'cash'] as const) {
    const bs = balanceSheet(ctx, { asOf: BD, basis });
    assert.equal(bs.balanced, true, `${basis} BS: A=${bs.totals.assets} L+E=${bs.totals.liabilities + bs.totals.equity}`);
  }
  const is = incomeStatement(ctx, { from: '2026-07-01', to: BD, basis: 'accrual' });
  const m = t12(ctx, { to: BD, basis: 'accrual' });
  const idx = m.months.indexOf('2026-07');
  assert.equal(is.noi, m.totals.noi[idx]);
  const cf = cashFlow(ctx, { from: '2026-01-01', to: BD, basis: 'accrual' });
  const glCash = accountBalance(ctx, '1010', { asOf: BD, basis: 'accrual' }) + accountBalance(ctx, '1020', { asOf: BD, basis: 'accrual' });
  assert.equal(cf.closing, glCash);
  // and the whole org's invariants stay green after everything this file did
  for (const inv of runInvariants(ctx)) assert.equal(inv.ok, true, inv.name + ': ' + inv.detail);
});
