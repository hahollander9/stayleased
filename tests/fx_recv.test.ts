import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert, val } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso, addDays } from '../src/lib/dates.ts';
import { hashPassword, sysCtx } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { accountBalance, runInvariants } from '../src/modules/m9_accounting/service.ts';
import { createCharge, leaseBalance, agingRows, leaseLedger } from '../src/modules/m8_receivables/service.ts';
import {
  recordPayment, PaymentRejected, settleDuePayments, openCharges, lateFeeCandidates, assessLateFees,
  waiveLateFee, runPaymentPlans, finalizeDeposit, depositHeld, pendingDepositRefund, receivablesStats,
  unappliedCredits,
} from '../src/modules/m8_receivables/payments.ts';
import { sodaPdf } from '../src/modules/m8_receivables/statements.ts';
import { startTestServer, loginAs, get, post } from './harness.ts';

/** Receivables as a REAL (live) company uses them — one test per defect from
 * the 2026-11 walkthrough. Every test ends on the books: the household's
 * balance and the general ledger, both bases where both are posted. Each
 * lease gets its own property so a GL assertion sees that lease alone. */

const BD = '2026-08-10';
const MK = '2026-08';
const sfx = id('x').slice(-6);

let base: string;
let close: () => void;
let liveOrg: string;
let demoOrg: string;
let adminLive: string;
let otherOrgAdmin: string;
let cookie: string;

function mkOrg(kind: 'demo' | 'live'): { org: string; email: string } {
  const org = id('org');
  insert('orgs', { id: org, name: `Recv ${kind} ${sfx}`, slug: `recv-${kind}-${sfx}`, kind, business_date: BD, created_at: nowIso() });
  ensureCoa(org);
  const uid = id('usr');
  const email = `admin-recv-${kind}-${sfx}@example.test`;
  insert('users', { id: uid, org_id: org, email, name: `Admin ${kind}`, kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso() });
  insert('role_assignments', { id: id('ra'), org_id: org, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  return { org, email };
}

interface Fx { lease: string; prop: string; unit: string; resident: string }

function mkLease(org: string, opts: { status?: string; deposit?: number; moveOut?: string | null } = {}): Fx {
  const n = id('n').slice(-6);
  const prop = id('prp');
  insert('properties', { id: prop, org_id: org, name: `Recv prop ${n}`, slug: `recv-prop-${n}`, type: 'multifamily', address1: '1 Test St', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso() });
  const unit = id('unt');
  insert('units', { id: unit, org_id: org, property_id: prop, unit_number: `R-${n}`, floor: 1, sqft: 800, status: 'occupied', market_rent_cents: 160000, amenities: '[]', created_at: nowIso() });
  const lease = id('lse');
  insert('leases', {
    id: lease, org_id: org, property_id: prop, unit_id: unit, household_name: `Recv ${n}`,
    status: opts.status || 'active', start_date: '2026-01-01', end_date: '2026-12-31', move_in_date: '2026-01-01',
    move_out_date: opts.moveOut ?? null, rent_cents: 160000, deposit_cents: opts.deposit ?? 0, term_months: 12, created_at: nowIso(),
  });
  const resident = id('res');
  insert('residents', { id: resident, org_id: org, property_id: prop, first_name: 'Pat', last_name: n, email: `pat-${n}@example.test`, kind: 'adult', created_at: nowIso() });
  insert('household_members', { id: id('hm'), org_id: org, lease_id: lease, resident_id: resident, role: 'primary', created_at: nowIso() });
  return { lease, prop, unit, resident };
}

const live = (date = BD) => sysCtx(liveOrg, date);
/** GL balance for one property: debits positive (so a liability reads negative) */
const gl = (org: string, fx: Fx, code: string, basis: 'accrual' | 'cash' = 'accrual'): number =>
  accountBalance(sysCtx(org, BD), code, { propertyId: fx.prop, basis });
const rent = (fx: Fx, cents = 160000): string =>
  createCharge(live(), { leaseId: fx.lease, kind: 'rent', label: 'Rent', amountCents: cents, date: '2026-08-01', dueDate: '2026-08-01', monthKey: MK, source: 'recurring' });
const paymentsOn = (fx: Fx): any[] => q<any>(`SELECT * FROM payments WHERE lease_id=? AND NOT (method='credit' AND amount_cents=0) ORDER BY created_at`, fx.lease);

async function pdf(path: string, ck = cookie): Promise<{ status: number; type: string; head: string; bytes: number }> {
  const resp = await fetch(base + path, { headers: { cookie: ck }, redirect: 'manual' });
  const buf = Buffer.from(await resp.arrayBuffer());
  return { status: resp.status, type: resp.headers.get('content-type') || '', head: buf.subarray(0, 5).toString('latin1'), bytes: buf.length };
}

before(async () => {
  db();
  const l = mkOrg('live');
  const d = mkOrg('demo');
  liveOrg = l.org; adminLive = l.email;
  demoOrg = d.org; otherOrgAdmin = d.email;
  const s = await startTestServer();
  base = s.base; close = s.close;
  cookie = await loginAs(base, adminLive);
});
after(() => close());

// ---------- 10. one-off charge ----------

test('10: a one-off charge can be posted from the lease page, and bad input is refused without a crash', async () => {
  const fx = mkLease(liveOrg);
  const page = await get(base, `/leases/${fx.lease}`, cookie);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('Add charge or credit'), 'the lease page offers the charge form');
  assert.ok(page.text.includes(`action="/leases/${fx.lease}/charges"`));

  const ok = await post(base, `/leases/${fx.lease}/charges`, { kind: 'utility', label: 'Water — July', amount: '75.00' }, cookie);
  assert.equal(ok.status, 303);
  const c = q<any>('SELECT * FROM charges WHERE lease_id=?', fx.lease);
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, 'utility');
  assert.equal(c[0].amount_cents, 7500);
  assert.equal(c[0].label, 'Water — July');
  assert.equal(leaseBalance(live(), fx.lease), 7500);
  assert.equal(gl(liveOrg, fx, '1100'), 7500, 'receivable is on the books');
  assert.equal(gl(liveOrg, fx, '4030'), -7500, 'utility income credited');
  assert.ok(q1(`SELECT id FROM audit_events WHERE entity='charge' AND entity_id=? AND action='charge_posted'`, c[0].id), 'audited');

  for (const bad of [
    { kind: 'other', label: 'Nothing', amount: '0' },
    { kind: 'other', label: 'Backwards', amount: '-50.00' },
    { kind: 'other', label: 'Garbage', amount: 'abc' },
    { kind: 'other', label: '', amount: '20.00' },
    { kind: 'not_a_kind', label: 'x', amount: '20.00' },
  ]) {
    const r = await post(base, `/leases/${fx.lease}/charges`, bad, cookie);
    assert.equal(r.status, 303, `${JSON.stringify(bad)} answers with a redirect, not an error page`);
  }
  assert.equal(val<number>('SELECT COUNT(*) FROM charges WHERE lease_id=?', fx.lease), 1, 'nothing else posted');
  assert.equal(leaseBalance(live(), fx.lease), 7500);
  assert.equal(gl(liveOrg, fx, '1100'), 7500);
});

// ---------- 11. credit / concession ----------

test('11: a credit closes the charge it covers, so a household that pays the rest is not billed a late fee', async () => {
  const fx = mkLease(liveOrg);
  const rentId = rent(fx);
  const r = await post(base, `/leases/${fx.lease}/charges`, { kind: 'concession', label: 'Move-in special', amount: '100.00' }, cookie);
  assert.equal(r.status, 303);
  const credit = q1<any>(`SELECT * FROM charges WHERE lease_id=? AND kind='concession'`, fx.lease);
  assert.equal(credit.amount_cents, -10000, 'typed as a plain amount, posted as a reduction');
  assert.equal(leaseBalance(live(), fx.lease), 150000);
  const open = openCharges(live(), fx.lease);
  assert.equal(open.length, 1);
  assert.equal(open[0]!.id, rentId);
  assert.equal(open[0]!.amount_cents - open[0]!.applied, 150000, 'the rent charge is open by what is actually owed');
  assert.equal(unappliedCredits(live(), fx.lease).length, 0);

  recordPayment(live(), { leaseId: fx.lease, amountCents: 150000, method: 'check', reference: '2201', receivedDate: BD, suppressReceipt: true });
  assert.equal(leaseBalance(live(), fx.lease), 0);
  assert.equal(openCharges(live(), fx.lease).length, 0, 'nothing is left open');
  assert.equal(lateFeeCandidates(live(), BD).filter((c) => c.leaseId === fx.lease).length, 0);
  assessLateFees(live(), BD);
  assert.equal(val<number>(`SELECT COUNT(*) FROM charges WHERE lease_id=? AND kind='late_fee'`, fx.lease), 0, 'no late fee on a paid-up household');
  assert.equal(agingRows(live(), { propertyId: fx.prop }).length, 0, 'not in aging');
  assert.equal(leaseBalance(live(), fx.lease), 0);

  assert.equal(gl(liveOrg, fx, '1100'), 0, 'receivable cleared');
  assert.equal(gl(liveOrg, fx, '4010'), -160000, 'accrual: full rent billed');
  assert.equal(gl(liveOrg, fx, '4900'), 10000, 'accrual: concession as contra-income');
  assert.equal(gl(liveOrg, fx, '4010', 'cash'), -150000, 'cash: only the money received');
  assert.equal(gl(liveOrg, fx, '4020'), 0);
  assert.equal(gl(liveOrg, fx, '1050', 'cash'), 150000);
  // the credit shows once on the ledger — its carrier is not a second line
  assert.equal(leaseLedger(live(), fx.lease).length, 3);
});

test('11: a credit posted before the charge it covers is applied when that charge arrives', () => {
  const fx = mkLease(liveOrg);
  createCharge(live(), { leaseId: fx.lease, kind: 'concession', label: 'Goodwill credit', amountCents: -20000, date: BD });
  assert.equal(leaseBalance(live(), fx.lease), -20000);
  assert.equal(unappliedCredits(live(), fx.lease)[0]!.remaining, 20000);
  rent(fx);
  const open = openCharges(live(), fx.lease);
  assert.equal(open[0]!.amount_cents - open[0]!.applied, 140000);
  assert.equal(leaseBalance(live(), fx.lease), 140000);
  assert.equal(gl(liveOrg, fx, '1100'), 140000);
});

// ---------- 12. card / ACH in a live org ----------

test('12: a live organization cannot record a simulated card or bank-draft payment — from the form or from code', async () => {
  const fx = mkLease(liveOrg);
  rent(fx);
  for (const method of ['card', 'ach'] as const) {
    let thrown: unknown = null;
    try {
      recordPayment(live(), { leaseId: fx.lease, amountCents: 50000, method, receivedDate: BD });
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof PaymentRejected && /not connected/.test(thrown.message), `${method} is refused where the payment is written`);
    const r = await post(base, `/leases/${fx.lease}/payments`, { amount: '500.00', method }, cookie);
    assert.equal(r.status, 303);
  }
  assert.equal(val<number>('SELECT COUNT(*) FROM payments WHERE lease_id=?', fx.lease), 0, 'no payment row, not even a failed one');
  assert.equal(leaseBalance(live(), fx.lease), 160000);
  assert.equal(gl(liveOrg, fx, '1050'), 0, 'nothing in clearing');
  assert.equal(gl(liveOrg, fx, '1010'), 0);
  assert.equal(gl(liveOrg, fx, '4080'), 0, 'no invented convenience fee');
  assert.equal(gl(liveOrg, fx, '1100'), 160000);

  const page = await get(base, `/leases/${fx.lease}`, cookie);
  assert.ok(!/simulated/i.test(page.text), 'no simulated method is offered');
  assert.ok(page.text.includes('Bank transfer received'));

  // money that really arrived can still be recorded
  const ok = await post(base, `/leases/${fx.lease}/payments`, { amount: '500.00', method: 'bank_transfer', reference: 'ZL-88' }, cookie);
  assert.equal(ok.status, 303);
  const p = paymentsOn(fx);
  assert.equal(p.length, 1);
  assert.equal(p[0].method, 'bank_transfer');
  assert.equal(p[0].fee_cents, 0);
  assert.equal(p[0].reference, 'ZL-88');
  assert.equal(leaseBalance(live(), fx.lease), 110000);
  assert.equal(gl(liveOrg, fx, '1100'), 110000);
  assert.equal(gl(liveOrg, fx, '1050'), 50000);
});

test('12: the demo organization keeps its simulated rails', () => {
  const fx = mkLease(demoOrg);
  const ctx = sysCtx(demoOrg, BD);
  createCharge(ctx, { leaseId: fx.lease, kind: 'rent', label: 'Rent', amountCents: 160000, date: '2026-08-01', monthKey: MK });
  const pid = recordPayment(ctx, { leaseId: fx.lease, amountCents: 160000, method: 'ach', receivedDate: BD, suppressReceipt: true });
  assert.equal(q1<any>('SELECT method, status FROM payments WHERE id=?', pid).status, 'pending');
  assert.equal(leaseBalance(ctx, fx.lease), 0);
  assert.equal(gl(demoOrg, fx, '1100'), 0);
});

// ---------- 13. void ----------

test('13: voiding a payment reinstates the balance and reverses both books, with no fee and no NSF', async () => {
  const fx = mkLease(liveOrg);
  rent(fx, 100000);
  recordPayment(live(), { leaseId: fx.lease, amountCents: 40000, method: 'check', reference: '501', receivedDate: BD, suppressReceipt: true });
  settleDuePayments(live(addDays(BD, 1)), addDays(BD, 1));
  const settled = paymentsOn(fx)[0];
  assert.equal(settled.status, 'settled');
  assert.equal(gl(liveOrg, fx, '1010'), 40000, 'deposited to operating');
  recordPayment(live(), { leaseId: fx.lease, amountCents: 10000, method: 'check', reference: '502', receivedDate: BD, suppressReceipt: true });
  const pending = paymentsOn(fx)[1];
  assert.equal(leaseBalance(live(), fx.lease), 50000);

  const tab = await get(base, `/leases/${fx.lease}?tab=payments`, cookie);
  assert.equal(tab.status, 200);
  assert.ok(tab.text.includes(`/payments/${settled.id}/void`) && tab.text.includes('Void payment'), 'each payment has a void control');

  const noReason = await post(base, `/payments/${settled.id}/void`, { reason: '  ' }, cookie);
  assert.equal(noReason.status, 303);
  assert.equal(q1<any>('SELECT status FROM payments WHERE id=?', settled.id).status, 'settled', 'a void needs a reason');

  for (const p of [settled, pending]) {
    const r = await post(base, `/payments/${p.id}/void`, { reason: 'posted to the wrong household' }, cookie);
    assert.equal(r.status, 303);
    assert.equal(q1<any>('SELECT status FROM payments WHERE id=?', p.id).status, 'voided');
  }
  assert.equal(leaseBalance(live(), fx.lease), 100000, 'the full balance is owed again');
  for (const basis of ['accrual', 'cash'] as const) {
    assert.equal(gl(liveOrg, fx, '1010', basis), 0, `${basis}: the settled payment came back out of operating`);
    assert.equal(gl(liveOrg, fx, '1050', basis), 0, `${basis}: nothing stranded in clearing`);
  }
  assert.equal(gl(liveOrg, fx, '1100'), 100000);
  assert.equal(gl(liveOrg, fx, '4010', 'cash'), 0, 'cash-basis income reversed');
  assert.equal(val<number>(`SELECT COUNT(*) FROM charges WHERE lease_id=? AND kind='nsf_fee'`, fx.lease), 0, 'no returned-payment fee');
  assert.equal(gl(liveOrg, fx, '4090'), 0);
  assert.equal(val<number>(`SELECT COUNT(*) FROM outbox_messages WHERE entity='payment' AND entity_id IN (?,?) AND template_key='payment_nsf'`, settled.id, pending.id), 0, 'no NSF notice');
  assert.ok(q1(`SELECT id FROM audit_events WHERE entity='payment' AND entity_id=? AND action='void'`, settled.id));
  assert.equal(openCharges(live(), fx.lease)[0]!.applied, 0, 'the rent charge is fully open again');

  const again = await post(base, `/payments/${settled.id}/void`, { reason: 'twice' }, cookie);
  assert.equal(again.status, 303);
  assert.equal(gl(liveOrg, fx, '1100'), 100000, 'a second void changes nothing');
});

// ---------- 14. NSF ----------

test('14: a returned check can be marked from the lease, and the NSF rate counts every payment method', async () => {
  const fx = mkLease(liveOrg);
  rent(fx, 100000);
  recordPayment(live(), { leaseId: fx.lease, amountCents: 60000, method: 'check', reference: '777', receivedDate: BD, suppressReceipt: true });
  recordPayment(live(), { leaseId: fx.lease, amountCents: 40000, method: 'money_order', reference: '778', receivedDate: BD, suppressReceipt: true });
  settleDuePayments(live(addDays(BD, 1)), addDays(BD, 1));
  const [check] = paymentsOn(fx);
  assert.equal(leaseBalance(live(), fx.lease), 0);

  const tab = await get(base, `/leases/${fx.lease}?tab=payments`, cookie);
  assert.ok(tab.text.includes(`/payments/${check.id}/reverse`) && tab.text.includes('Returned by the bank'));

  const r = await post(base, `/payments/${check.id}/reverse`, {}, cookie);
  assert.equal(r.status, 303);
  assert.equal(q1<any>('SELECT status FROM payments WHERE id=?', check.id).status, 'nsf');
  const fee = q1<any>(`SELECT * FROM charges WHERE lease_id=? AND kind='nsf_fee'`, fx.lease);
  assert.equal(fee.amount_cents, 3500);
  assert.equal(leaseBalance(live(), fx.lease), 63500, 'the returned amount plus the fee');
  assert.equal(gl(liveOrg, fx, '1100'), 63500);
  for (const basis of ['accrual', 'cash'] as const) {
    assert.equal(gl(liveOrg, fx, '1010', basis), 40000, `${basis}: only the good payment stays in the bank`);
    assert.equal(gl(liveOrg, fx, '1050', basis), 0);
  }
  assert.equal(gl(liveOrg, fx, '4090'), -3500);

  const stats = receivablesStats(live(), MK, fx.prop);
  assert.equal(stats.nsfCount, 1);
  assert.equal(stats.nsfRate, 50, 'one of two payments returned — not 0% because neither was ACH or card');

  const twice = await post(base, `/payments/${check.id}/reverse`, {}, cookie);
  assert.equal(twice.status, 303);
  assert.equal(val<number>(`SELECT COUNT(*) FROM charges WHERE lease_id=? AND kind='nsf_fee'`, fx.lease), 1, 'no second fee');
  assert.equal(leaseBalance(live(), fx.lease), 63500);
});

// ---------- 15. late fees ----------

/** a credit as the old code left it: on the books, applied to nothing */
function legacyCredit(fx: Fx, cents: number): void {
  createCharge(live(), { leaseId: fx.lease, kind: 'concession', label: 'Legacy credit', amountCents: -cents, date: '2026-08-02' });
  const carriers = q<{ id: string }>(`SELECT id FROM payments WHERE lease_id=? AND method='credit' AND amount_cents=0`, fx.lease);
  for (const c of carriers) {
    db().prepare('DELETE FROM payment_applications WHERE payment_id=?').run(c.id);
    db().prepare('DELETE FROM payments WHERE id=?').run(c.id);
  }
  assert.equal(unappliedCredits(live(), fx.lease)[0]!.remaining, cents);
}

test('15: no late fee on a zero balance, and never figured on more than is owed', () => {
  // an account as it stood before credits were applied to charges: rent
  // billed, a credit for the same amount sitting unapplied
  const zero = mkLease(liveOrg);
  rent(zero);
  legacyCredit(zero, 160000);
  assert.equal(leaseBalance(live(), zero.lease), 0);
  // and one that owes $20 against a $1,600 rent line
  const small = mkLease(liveOrg);
  rent(small);
  legacyCredit(small, 158000);
  // control: genuinely unpaid rent
  const owes = mkLease(liveOrg);
  rent(owes);

  const cands = lateFeeCandidates(live(), BD);
  assert.equal(cands.some((c) => c.leaseId === zero.lease), false, 'a $0.00 balance is not late');
  assert.equal(cands.some((c) => c.leaseId === small.lease), false, '$20 owed is under the minimum balance');
  const c = cands.find((x) => x.leaseId === owes.lease)!;
  assert.ok(c, 'unpaid rent is still assessed');
  assert.equal(c.unpaidRent, 160000);

  assessLateFees(live(), BD);
  for (const fx of [zero, small]) {
    assert.equal(val<number>(`SELECT COUNT(*) FROM charges WHERE lease_id=? AND kind='late_fee'`, fx.lease), 0);
    assert.equal(gl(liveOrg, fx, '4020'), 0, 'no late-fee income');
  }
  assert.equal(leaseBalance(live(), zero.lease), 0);
  assert.equal(leaseBalance(live(), small.lease), 2000);
  assert.equal(leaseBalance(live(), owes.lease), 165000, 'rent plus the $50 fee');
  assert.equal(gl(liveOrg, owes, '1100'), 165000);
  assert.equal(gl(liveOrg, owes, '4020'), -5000);
});

// ---------- 16. waiver ----------

test('16: a late fee can be waived once, with a stated reason', async () => {
  const fx = mkLease(liveOrg);
  rent(fx);
  const feeId = createCharge(live(), { leaseId: fx.lease, kind: 'late_fee', label: 'Late fee', amountCents: 7500, date: BD, monthKey: MK, source: 'late_fee' });
  assert.equal(leaseBalance(live(), fx.lease), 167500);

  const page = await get(base, '/receivables/latefees', cookie);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes(`/receivables/latefees/${feeId}/waive`));
  assert.ok(!page.text.includes('value="goodwill"'), 'the reason is typed, not hard-coded');

  const blank = await post(base, `/receivables/latefees/${feeId}/waive`, { reason: '' }, cookie);
  assert.equal(blank.status, 303);
  assert.equal(val<number>('SELECT COUNT(*) FROM fee_waivers WHERE charge_id=?', feeId), 0, 'no reason, no waiver');

  const first = await post(base, `/receivables/latefees/${feeId}/waive`, { reason: 'bank error on their side' }, cookie);
  assert.equal(first.status, 303);
  const second = await post(base, `/receivables/latefees/${feeId}/waive`, { reason: 'again' }, cookie);
  assert.equal(second.status, 303);
  assert.throws(() => waiveLateFee(live(), feeId, 'a third time, from code'), /already waived/);

  const fees = q<any>(`SELECT amount_cents FROM charges WHERE lease_id=? AND kind='late_fee' ORDER BY amount_cents`, fx.lease);
  assert.deepEqual(fees.map((f) => f.amount_cents), [-7500, 7500], 'exactly one credit for the fee');
  const w = q1<any>('SELECT * FROM fee_waivers WHERE charge_id=?', feeId);
  assert.equal(w.reason, 'bank error on their side');
  assert.equal(leaseBalance(live(), fx.lease), 160000, 'the balance moved by the fee, once');
  assert.equal(gl(liveOrg, fx, '1100'), 160000);
  assert.equal(gl(liveOrg, fx, '4020'), 0, 'fee income nets to zero');
  const open = openCharges(live(), fx.lease);
  assert.equal(open.length, 1, 'the waiver closed the fee, not part of the rent');
  assert.equal(open[0]!.kind, 'rent');
  assert.equal(open[0]!.applied, 0);

  const after2 = await get(base, '/receivables/latefees', cookie);
  assert.ok(!after2.text.includes(`/receivables/latefees/${feeId}/waive`), 'no Waive button on a waived fee');
  assert.ok(after2.text.includes('bank error on their side'));
});

// ---------- 17. payment plan ----------

test('17: plan installments are kept by ordinary payments, whatever the method', async () => {
  const fx = mkLease(liveOrg);
  createCharge(live(), { leaseId: fx.lease, kind: 'rent', label: 'Rent — June', amountCents: 90000, date: '2026-06-01', dueDate: '2026-06-01', monthKey: '2026-06' });
  // a saved method must never be charged in a live organization
  const uid = id('usr');
  insert('users', { id: uid, org_id: liveOrg, email: `res-${uid}@example.test`, name: 'Res', kind: 'resident', password_hash: 'x', active: 1, created_at: nowIso() });
  insert('payment_method_tokens', { id: id('pmt'), org_id: liveOrg, user_id: uid, lease_id: fx.lease, kind: 'ach', label: 'Checking 1234', token: 'tok_test', behavior: 'ok_always', is_default: 1, created_at: nowIso() });

  const first = addDays(BD, 7);
  const r = await post(base, `/delinquency/${fx.lease}/plan`, { total: '900.00', n: '3', every: 'weekly', first_due: first }, cookie);
  assert.equal(r.status, 303);
  const plan = q1<any>('SELECT * FROM payment_plans WHERE lease_id=?', fx.lease);
  assert.equal(plan.total_cents, 90000);
  const inst = (): any[] => q<any>('SELECT * FROM payment_plan_installments WHERE plan_id=? ORDER BY due_date', plan.id);
  assert.deepEqual(inst().map((i) => [i.due_date, i.amount_cents]), [[first, 30000], [addDays(first, 7), 30000], [addDays(first, 14), 30000]]);

  // installments 1 and 2 paid early, by check, through the staff form
  await post(base, `/leases/${fx.lease}/payments`, { amount: '300.00', method: 'check', reference: '9001' }, cookie);
  assert.deepEqual(inst().map((i) => i.status), ['paid', 'scheduled', 'scheduled'], 'recorded payment marks the installment paid at once');
  await post(base, `/leases/${fx.lease}/payments`, { amount: '300.00', method: 'money_order', reference: '9002' }, cookie);
  const pays = paymentsOn(fx);
  assert.deepEqual(inst().map((i) => [i.status, i.payment_id]), [['paid', pays[0].id], ['paid', pays[1].id], ['scheduled', null]]);

  // the nightly run after each due date: nothing missed, nothing charged
  for (const d of [addDays(first, 1), addDays(first, 8)]) runPaymentPlans(live(d), d);
  assert.deepEqual(inst().map((i) => i.status), ['paid', 'paid', 'scheduled']);
  assert.equal(q1<any>('SELECT status FROM payment_plans WHERE id=?', plan.id).status, 'active');
  assert.equal(paymentsOn(fx).length, 2, 'no automatic charge to the saved method');

  // the third goes unpaid past its due date, then is caught up
  runPaymentPlans(live(addDays(first, 15)), addDays(first, 15));
  assert.deepEqual(inst().map((i) => i.status), ['paid', 'paid', 'missed']);
  assert.equal(leaseBalance(live(), fx.lease), 30000);
  await post(base, `/leases/${fx.lease}/payments`, { amount: '300.00', method: 'check', reference: '9003' }, cookie);
  assert.deepEqual(inst().map((i) => i.status), ['paid', 'paid', 'paid']);
  assert.equal(q1<any>('SELECT status FROM payment_plans WHERE id=?', plan.id).status, 'completed');

  assert.equal(leaseBalance(live(), fx.lease), 0);
  assert.equal(gl(liveOrg, fx, '1100'), 0);
  assert.equal(gl(liveOrg, fx, '1050'), 90000, 'three checks in clearing');
  assert.equal(gl(liveOrg, fx, '4010', 'cash'), -90000);

  const page = await get(base, `/delinquency/${fx.lease}`, cookie);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('#9001'), 'the schedule shows which payment covered each installment');
  assert.ok(!/auto-charged to the household/.test(page.text));

  // a returned check re-opens the installment it had covered
  await post(base, `/payments/${paymentsOn(fx)[2].id}/void`, { reason: 'keyed twice' }, cookie);
  assert.deepEqual(inst().map((i) => i.status), ['paid', 'paid', 'scheduled']);
  assert.equal(q1<any>('SELECT status FROM payment_plans WHERE id=?', plan.id).status, 'active');
  assert.equal(leaseBalance(live(), fx.lease), 30000);
  assert.equal(gl(liveOrg, fx, '1100'), 30000);
});

// ---------- 18. deposit disposition ----------

function heldDeposit(status = 'active', moveOut: string | null = null): Fx {
  const fx = mkLease(liveOrg, { deposit: 150000, status, moveOut });
  createCharge(live(), { leaseId: fx.lease, kind: 'deposit', label: 'Security deposit', amountCents: 150000, date: '2026-01-01' });
  recordPayment(live('2026-01-01'), { leaseId: fx.lease, amountCents: 150000, method: 'check', reference: '100', receivedDate: '2026-01-01', suppressReceipt: true });
  settleDuePayments(live('2026-01-02'), '2026-01-02');
  return fx;
}

test('18: a deposit is settled only at move-out, and the refund is owed until the real check is recorded', async () => {
  const fx = heldDeposit();
  assert.equal(depositHeld(live(), fx.lease), 150000);
  assert.equal(gl(liveOrg, fx, '1020'), 150000);
  assert.equal(gl(liveOrg, fx, '2100'), -150000);
  const damageId = createCharge(live(), { leaseId: fx.lease, kind: 'damage', label: 'Carpet — bedroom', amountCents: 10000, date: BD, source: 'damage' });

  // an active lease with no move-out date: refused where it writes, and from the form
  assert.throws(() => finalizeDeposit(live(), fx.lease, { date: BD }), /move-out date/);
  const refused = await post(base, `/leases/${fx.lease}/deposit/finalize`, { to_collections: '1' }, cookie);
  assert.equal(refused.status, 303);
  assert.equal(val<number>('SELECT COUNT(*) FROM refunds WHERE lease_id=?', fx.lease), 0);
  assert.equal(depositHeld(live(), fx.lease), 150000);
  assert.equal(q1<any>('SELECT status FROM leases WHERE id=?', fx.lease).status, 'active');

  // with the move-out date: the lease goes on notice and the deposit is settled
  const moveOut = addDays(BD, 5);
  const done = await post(base, `/leases/${fx.lease}/deposit/finalize`, { to_collections: '1', move_out: moveOut }, cookie);
  assert.equal(done.status, 303);
  const lease = q1<any>('SELECT status, move_out_date FROM leases WHERE id=?', fx.lease);
  assert.equal(lease.status, 'notice');
  assert.equal(lease.move_out_date, moveOut);
  const refund = q1<any>('SELECT * FROM refunds WHERE lease_id=?', fx.lease);
  assert.equal(refund.amount_cents, 140000);
  assert.equal(refund.status, 'pending', 'owed, not paid');
  assert.equal(refund.reference, null, 'no invented check number');
  assert.equal(leaseBalance(live(), fx.lease), 0, 'the damage charge is paid from the deposit');
  assert.equal(depositHeld(live(), fx.lease), 0);
  assert.equal(pendingDepositRefund(live(), fx.lease), 140000);
  for (const basis of ['accrual', 'cash'] as const) {
    assert.equal(gl(liveOrg, fx, '2100', basis), -140000, `${basis}: the refund is still a liability`);
    assert.equal(gl(liveOrg, fx, '1020', basis), 140000, `${basis}: and its cash is still in escrow`);
    assert.equal(gl(liveOrg, fx, '1010', basis), 10000, `${basis}: the applied part swept to operating`);
  }
  assert.equal(gl(liveOrg, fx, '1100'), 0);
  // itemization: the deposit paid the damage charge, though it predates move-out
  const paidFromDeposit = q<any>(
    `SELECT pa.charge_id, pa.amount_cents FROM payment_applications pa JOIN payments p ON p.id=pa.payment_id
     WHERE p.lease_id=? AND p.method='credit' AND p.amount_cents>0`, fx.lease);
  assert.deepEqual(paidFromDeposit.map((x) => [x.charge_id, x.amount_cents]), [[damageId, 10000]]);

  // settling again does not create a second refund
  await post(base, `/leases/${fx.lease}/deposit/finalize`, {}, cookie);
  assert.equal(val<number>('SELECT COUNT(*) FROM refunds WHERE lease_id=?', fx.lease), 1);

  const list = await get(base, '/deposits', cookie);
  assert.equal(list.status, 200);
  assert.ok(list.text.includes('Refunds to pay') && list.text.includes(`/refunds/${refund.id}/issue`));
  const tab = await get(base, `/leases/${fx.lease}?tab=deposit`, cookie);
  assert.equal(tab.status, 200);
  assert.ok(tab.text.includes(`/refunds/${refund.id}/issue`) && tab.text.includes(`/leases/${fx.lease}/soda.pdf`));
  assert.ok(!tab.text.includes('Statements panel below'));

  // recording the check: needs a number; then the money leaves the books
  const noNumber = await post(base, `/refunds/${refund.id}/issue`, { check_number: ' ', date: moveOut }, cookie);
  assert.equal(noNumber.status, 303);
  assert.equal(q1<any>('SELECT status FROM refunds WHERE id=?', refund.id).status, 'pending');
  const issued = await post(base, `/refunds/${refund.id}/issue`, { check_number: '1042', date: moveOut, back: 'lease' }, cookie);
  assert.equal(issued.status, 303);
  const paid = q1<any>('SELECT * FROM refunds WHERE id=?', refund.id);
  assert.equal(paid.status, 'issued');
  assert.equal(paid.reference, '1042');
  assert.equal(paid.date, moveOut);
  for (const basis of ['accrual', 'cash'] as const) {
    assert.equal(gl(liveOrg, fx, '2100', basis), 0, `${basis}: liability cleared`);
    assert.equal(gl(liveOrg, fx, '1020', basis), 0, `${basis}: escrow paid out`);
  }
  assert.equal(depositHeld(live(), fx.lease), 0);
  assert.equal(pendingDepositRefund(live(), fx.lease), 0);
  assert.ok(q1(`SELECT id FROM deposit_activity WHERE lease_id=? AND kind='refund' AND refund_id=? AND amount_cents=-140000`, fx.lease, refund.id));
  const twice = await post(base, `/refunds/${refund.id}/issue`, { check_number: '1043', date: moveOut }, cookie);
  assert.equal(twice.status, 303);
  assert.equal(gl(liveOrg, fx, '1020'), 0, 'a refund is paid once');
  assert.equal(q1<any>('SELECT reference FROM refunds WHERE id=?', refund.id).reference, '1042');
  for (const inv of runInvariants(live())) assert.equal(inv.ok, true, `${inv.name}: ${inv.detail}`);
});

// ---------- 19. SODA ----------

test('19: the itemized deposit statement downloads as a PDF, before and after the deposit is settled', async () => {
  const fx = heldDeposit('notice', addDays(BD, 3));
  createCharge(live(), { leaseId: fx.lease, kind: 'damage', label: 'Blinds', amountCents: 8000, date: BD, source: 'damage' });
  const draft = await pdf(`/leases/${fx.lease}/soda.pdf`);
  assert.equal(draft.status, 200);
  assert.match(draft.type, /application\/pdf/);
  assert.equal(draft.head, '%PDF-');
  assert.equal(val<number>('SELECT COUNT(*) FROM refunds WHERE lease_id=?', fx.lease), 0, 'previewing settles nothing');

  const r = finalizeDeposit(live(), fx.lease, { date: BD });
  assert.deepEqual([r.applied, r.refunded, r.balanceDue, r.refundStatus], [8000, 142000, 0, 'pending']);
  const final = await pdf(`/leases/${fx.lease}/soda.pdf`);
  assert.equal(final.status, 200);
  assert.match(final.type, /application\/pdf/);
  assert.equal(final.head, '%PDF-');
  assert.ok(final.bytes > 800);
  assert.equal((await sodaPdf(live(), fx.lease)).subarray(0, 4).toString(), '37,80,68,70');
  assert.equal(leaseBalance(live(), fx.lease), 0);
  assert.equal(gl(liveOrg, fx, '2100'), -142000);
  assert.equal(gl(liveOrg, fx, '1020'), 142000);

  // another organization's staff cannot fetch it
  const other = await loginAs(base, otherOrgAdmin);
  assert.equal((await pdf(`/leases/${fx.lease}/soda.pdf`, other)).status, 404);
});

// ---------- 20. staff statement / ledger ----------

test('20: staff can download a household statement PDF and the ledger CSV', async () => {
  const fx = mkLease(liveOrg);
  rent(fx);
  recordPayment(live(), { leaseId: fx.lease, amountCents: 100000, method: 'check', reference: '3100', receivedDate: BD, suppressReceipt: true });

  for (const path of [`/leases/${fx.lease}/statements/${MK}.pdf`, `/leases/${fx.lease}/statements/${MK}`, `/leases/${fx.lease}/statement.pdf?month=${MK}`, `/leases/${fx.lease}/statement.pdf`]) {
    const s = await pdf(path);
    assert.equal(s.status, 200, path);
    assert.match(s.type, /application\/pdf/, path);
    assert.equal(s.head, '%PDF-', path);
  }
  assert.equal((await pdf(`/leases/${fx.lease}/statements/2026-13.pdf`)).status, 400);
  assert.equal((await pdf(`/leases/${fx.lease}/statements/nonsense`)).status, 400);

  const csv = await get(base, `/leases/${fx.lease}/ledger.csv`, cookie);
  assert.equal(csv.status, 200);
  const lines = csv.text.trim().split(/\r?\n/);
  assert.equal(lines[0], 'date,description,charge,payment,balance');
  assert.equal(lines.length, 3);
  assert.ok(lines[1]!.startsWith('2026-08-01,Rent,1600,'));
  assert.ok(/#3100/.test(lines[2]!) && lines[2]!.endsWith(',1000,600'));
  assert.equal(leaseBalance(live(), fx.lease), 60000, 'the CSV closes on the ledger balance');
  assert.equal(gl(liveOrg, fx, '1100'), 60000);

  const page = await get(base, `/leases/${fx.lease}`, cookie);
  assert.ok(page.text.includes(`/leases/${fx.lease}/statement.pdf`) && page.text.includes(`/leases/${fx.lease}/ledger.csv`), 'linked from the lease page');

  const other = await loginAs(base, otherOrgAdmin);
  assert.equal((await pdf(`/leases/${fx.lease}/statements/${MK}.pdf`, other)).status, 404);
  assert.equal((await get(base, `/leases/${fx.lease}/ledger.csv`, other)).status, 404);
});
