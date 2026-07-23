import { q, q1, insert, val, tx, run } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, addDays, monthKey, diffDays, fmtDate, firstOfMonth, fmtMonth } from '../../lib/dates.ts';
import { usd, splitCents } from '../../lib/money.ts';
import { assertPerm, type Ctx } from '../../lib/auth.ts';
import { emit, on } from '../../lib/events.ts';
import { getSetting } from '../../lib/settings.ts';
import { registerJob } from '../../lib/jobs.ts';
import { notify } from '../../lib/templates.ts';
import { audit } from '../../lib/audit.ts';
import { postJE } from '../m9_accounting/service.ts';
import { CHARGE_CREDIT } from '../m9_accounting/coa.ts';
import { createCharge, leaseBalance } from './service.ts';
import { authorizeCard, achWillBounce, settleDaysFor, processorFeeCents } from '../../lib/sim/payments.ts';

/** M8.2–8.7: payment lifecycle, late fees, autopay, payment plans, deposit
 * disposition, collections. Every money movement posts through M9. */

// ---------- helpers ----------

export function primaryContact(ctx: Ctx, leaseId: string): {
  residentId: string | null; name: string; email: string | null; phone: string | null; userId: string | null; propertyId: string; unit: string; propertyName: string; first: string;
} {
  const row = q1<any>(
    `SELECT r.id AS resident_id, r.first_name, r.last_name, r.email, r.phone, r.user_id,
            l.property_id, u.unit_number, p.name AS property_name
     FROM leases l JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=l.property_id
     LEFT JOIN household_members hm ON hm.lease_id=l.id AND hm.role='primary'
     LEFT JOIN residents r ON r.id=hm.resident_id
     WHERE l.id=? AND l.org_id=?`,
    leaseId, ctx.orgId,
  );
  return {
    residentId: row?.resident_id || null,
    name: row ? `${row.first_name || ''} ${row.last_name || ''}`.trim() : '',
    first: row?.first_name || 'resident',
    email: row?.email || null,
    phone: row?.phone || null,
    userId: row?.user_id || null,
    propertyId: row?.property_id || '',
    unit: row?.unit_number || '',
    propertyName: row?.property_name || '',
  };
}

const KIND_CATEGORY: Record<string, string> = {
  deposit: 'deposit',
  rent: 'rent', mtm_premium: 'rent',
  utility: 'utility', utility_flat: 'utility',
  late_fee: 'fee', nsf_fee: 'fee', application_fee: 'fee', admin_fee: 'fee',
};
function categoryOf(kind: string): string {
  return KIND_CATEGORY[kind] || 'other';
}

interface OpenCharge {
  id: string;
  kind: string;
  due_date: string;
  amount_cents: number;
  applied: number;
}

export function openCharges(ctx: Ctx, leaseId: string): OpenCharge[] {
  return q<OpenCharge>(
    `SELECT c.id, c.kind, c.due_date, c.amount_cents,
      (SELECT COALESCE(SUM(pa.amount_cents),0) FROM payment_applications pa
        JOIN payments p ON p.id=pa.payment_id AND p.status IN ('pending','settled')
        WHERE pa.charge_id=c.id) AS applied
     FROM charges c WHERE c.org_id=? AND c.lease_id=? AND c.status='active' AND c.amount_cents>0
     ORDER BY c.due_date, c.created_at`,
    ctx.orgId, leaseId,
  ).filter((c) => c.amount_cents - c.applied > 0);
}

/** allocate an amount across open charges per the property application order */
function allocate(ctx: Ctx, leaseId: string, propertyId: string, amountCents: number): { chargeId: string; kind: string; amount: number }[] {
  const order = getSetting<string[]>(ctx, 'payment_application_order', propertyId);
  const open = openCharges(ctx, leaseId);
  const ranked = open
    .map((c) => ({ c, rank: order.indexOf(categoryOf(c.kind)) === -1 ? order.length : order.indexOf(categoryOf(c.kind)) }))
    .sort((a, b) => a.rank - b.rank || (a.c.due_date < b.c.due_date ? -1 : 1));
  const out: { chargeId: string; kind: string; amount: number }[] = [];
  let left = amountCents;
  for (const { c } of ranked) {
    if (left <= 0) break;
    const take = Math.min(left, c.amount_cents - c.applied);
    if (take > 0) {
      out.push({ chargeId: c.id, kind: c.kind, amount: take });
      left -= take;
    }
  }
  return out;
}

// ---------- record payment ----------

export interface PaymentInput {
  leaseId: string;
  amountCents: number;
  method: 'ach' | 'card' | 'check' | 'money_order' | 'cash_equivalent' | 'lockbox' | 'credit';
  methodTokenId?: string | null;
  reference?: string | null;
  receivedDate: string;
  autopay?: boolean;
  payerResidentId?: string | null;
  memo?: string;
  /** 'credit' payments fund from a liability account: 2100 (security deposit
   * application at move-out) or 2200 (application holding deposit applied at
   * lease activation). Default 2100. */
  creditFunding?: '2100' | '2200' | '4110';
  suppressReceipt?: boolean;
}

export class PaymentRejected extends Error {}

export function recordPayment(ctx: Ctx, input: PaymentInput): string {
  const lease = q1<any>('SELECT * FROM leases WHERE id=? AND org_id=?', input.leaseId, ctx.orgId);
  if (!lease) throw new PaymentRejected('lease not found');
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new PaymentRejected('invalid amount');

  // policy: partial payments
  const policy = getSetting<{ allow: boolean; blockWhenEvictionFiled: boolean }>(ctx, 'partial_payments', lease.property_id);
  const balance = leaseBalance(ctx, input.leaseId);
  if (!policy.allow && input.amountCents < balance) {
    throw new PaymentRejected('partial payments are not accepted at this property');
  }

  const paymentId = id('pay');
  const tokenRow = input.methodTokenId ? q1<any>('SELECT * FROM payment_method_tokens WHERE id=?', input.methodTokenId) : undefined;

  // card auth happens immediately
  let reference = input.reference || null;
  if (input.method === 'card') {
    const auth = authorizeCard(ctx.orgId, paymentId, tokenRow?.behavior || 'ok');
    if (!auth.ok) {
      insert('payments', {
        id: paymentId, org_id: ctx.orgId, property_id: lease.property_id, lease_id: lease.id,
        payer_resident_id: input.payerResidentId || null, method: input.method, method_token_id: input.methodTokenId || null,
        reference: auth.processorRef, amount_cents: input.amountCents, fee_cents: 0, status: 'failed',
        received_date: input.receivedDate, autopay: input.autopay ? 1 : 0, memo: 'card declined',
        created_by: ctx.userId, created_at: nowIso(),
      });
      emit(ctx, 'payment.declined', 'payment', paymentId, { leaseId: lease.id, amountCents: input.amountCents });
      throw new PaymentRejected('Card was declined by the (simulated) processor.');
    }
    reference = auth.processorRef;
  }

  // convenience fee (card only, grossed up so the property nets the full amount)
  const feeCfg = getSetting<{ achCents: number; cardPct: number }>(ctx, 'convenience_fee', lease.property_id);
  const fee = input.method === 'card' ? Math.round((input.amountCents * feeCfg.cardPct) / 100) : input.method === 'ach' ? feeCfg.achCents : 0;

  const isCredit = input.method === 'credit';
  const settleDate = isCredit ? input.receivedDate : addDays(input.receivedDate, settleDaysFor(ctx.orgId, input.method));

  tx(() => {
    insert('payments', {
      id: paymentId, org_id: ctx.orgId, property_id: lease.property_id, lease_id: lease.id,
      payer_resident_id: input.payerResidentId || null, method: input.method, method_token_id: input.methodTokenId || null,
      reference, amount_cents: input.amountCents, fee_cents: fee,
      status: isCredit ? 'settled' : 'pending',
      received_date: input.receivedDate, settle_date: settleDate,
      autopay: input.autopay ? 1 : 0, memo: input.memo || null, created_by: ctx.userId, created_at: nowIso(),
    });

    // apply to charges
    const apps = allocate(ctx, lease.id, lease.property_id, input.amountCents);
    for (const a of apps) {
      insert('payment_applications', { id: id('pap'), org_id: ctx.orgId, payment_id: paymentId, charge_id: a.chargeId, amount_cents: a.amount, created_at: nowIso() });
    }
    const applied = apps.reduce((s, a) => s + a.amount, 0);
    const unapplied = input.amountCents - applied;

    const debitAccount = isCredit ? (input.creditFunding || '2100') : '1050';

    // accrual: DR clearing (amount+fee) / CR AR amount (+ CR fee income)
    const accrualLines = [
      { account: debitAccount, debit: input.amountCents + fee, memo: `payment ${input.method}` },
      { account: '1100', credit: input.amountCents, memo: 'receivable relief' },
    ];
    if (fee > 0) accrualLines.push({ account: '4080', credit: fee, memo: 'convenience fee' } as any);
    postJE(ctx, {
      propertyId: lease.property_id, date: input.receivedDate, basis: 'accrual',
      memo: `Payment ${usd(input.amountCents)} — ${lease.household_name}`, sourceKind: 'payment', sourceId: paymentId,
      lines: accrualLines,
    });

    // cash: DR clearing / CR income per application (+ prepaid for unapplied, + fee income)
    const cashLines: { account: string; debit?: number; credit?: number; memo?: string }[] = [
      { account: debitAccount, debit: input.amountCents + fee, memo: `payment ${input.method}` },
    ];
    const byAccount = new Map<string, number>();
    for (const a of apps) {
      const acct = CHARGE_CREDIT[a.kind] || CHARGE_CREDIT['other']!;
      byAccount.set(acct, (byAccount.get(acct) || 0) + a.amount);
    }
    for (const [acct, amt] of byAccount) cashLines.push({ account: acct, credit: amt });
    if (unapplied > 0) cashLines.push({ account: '2150', credit: unapplied, memo: 'prepayment' });
    if (fee > 0) cashLines.push({ account: '4080', credit: fee, memo: 'convenience fee' });
    postJE(ctx, {
      propertyId: lease.property_id, date: input.receivedDate, basis: 'cash',
      memo: `Payment ${usd(input.amountCents)} — ${lease.household_name}`, sourceKind: 'payment', sourceId: paymentId,
      lines: cashLines,
    });
  });

  emit(ctx, 'payment.received', 'payment', paymentId, {
    leaseId: lease.id, propertyId: lease.property_id, amountCents: input.amountCents, method: input.method, autopay: !!input.autopay,
  });

  if (!input.suppressReceipt && !isCredit) {
    const contact = primaryContact(ctx, lease.id);
    notify(ctx, 'payment_receipt', {
      email: contact.email, phone: contact.phone, name: contact.name, userId: contact.userId,
      personId: contact.residentId, propertyId: lease.property_id, entity: 'payment', entityId: paymentId,
    }, {
      first_name: contact.first, amount: usd(input.amountCents), unit: contact.unit, date: fmtDate(input.receivedDate),
      method: input.method.toUpperCase(), reference: reference || paymentId.slice(-8),
      balance: usd(leaseBalance(ctx, lease.id)), property: contact.propertyName,
    });
  }
  return paymentId;
}

// ---------- settlement & NSF ----------

export function settleDuePayments(ctx: Ctx, date: string): string {
  const due = q<any>(
    `SELECT * FROM payments WHERE org_id=? AND status='pending' AND settle_date<=?`,
    ctx.orgId, date,
  );
  let settled = 0;
  let bounced = 0;
  for (const p of due) {
    const token = p.method_token_id ? q1<any>('SELECT * FROM payment_method_tokens WHERE id=?', p.method_token_id) : undefined;
    if (p.method === 'ach' && achWillBounce(ctx.orgId, p.id, token?.behavior || 'ok')) {
      reversePayment(ctx, p, date, 'nsf');
      bounced++;
      continue;
    }
    settlePayment(ctx, p, date);
    settled++;
  }
  return `${settled} settled, ${bounced} NSF`;
}

function settlePayment(ctx: Ctx, p: any, date: string): void {
  const methodGroup = p.method === 'ach' ? 'ach' : p.method === 'card' ? 'card' : 'check';
  tx(() => {
    let batch = q1<any>(
      `SELECT * FROM settlement_batches WHERE org_id=? AND property_id=? AND method_group=? AND batch_date=?`,
      ctx.orgId, p.property_id, methodGroup, date,
    );
    if (!batch) {
      const bid = id('bat');
      insert('settlement_batches', {
        id: bid, org_id: ctx.orgId, property_id: p.property_id, batch_date: date, method_group: methodGroup,
        total_cents: 0, fee_cents: 0, status: 'deposited', created_at: nowIso(),
      });
      batch = { id: bid };
    }
    const gross = p.amount_cents + p.fee_cents;
    const procFee = processorFeeCents(p.method, gross);
    run('UPDATE settlement_batches SET total_cents=total_cents+?, fee_cents=fee_cents+? WHERE id=?', gross, procFee, batch.id);
    run("UPDATE payments SET status='settled', settle_date=?, settlement_batch_id=? WHERE id=?", date, batch.id, p.id);

    // deposit-applied portion settles into the deposit escrow account
    const depositPortion = val<number>(
      `SELECT COALESCE(SUM(pa.amount_cents),0) FROM payment_applications pa JOIN charges c ON c.id=pa.charge_id
       WHERE pa.payment_id=? AND c.kind='deposit'`,
      p.id,
    ) || 0;
    const operating = gross - depositPortion;
    for (const basis of ['accrual', 'cash'] as const) {
      const lines = [] as { account: string; debit?: number; credit?: number }[];
      if (operating > 0) lines.push({ account: '1010', debit: operating });
      if (depositPortion > 0) lines.push({ account: '1020', debit: depositPortion });
      lines.push({ account: '1050', credit: gross });
      postJE(ctx, {
        propertyId: p.property_id, date, basis, memo: `Settlement ${p.method} ${usd(gross)}`,
        sourceKind: 'settlement', sourceId: p.id, lines,
      });
    }
  });
  emit(ctx, 'payment.settled', 'payment', p.id, { leaseId: p.lease_id, amountCents: p.amount_cents });
}

/** NSF / chargeback: reinstate balance + fee + notification (M8.3) */
export function reversePayment(ctx: Ctx, p: any, date: string, kind: 'nsf' | 'chargeback'): void {
  tx(() => {
    run(`UPDATE payments SET status=?, nsf_date=? WHERE id=?`, kind, date, p.id);
    const apps = q<any>(
      `SELECT pa.amount_cents, c.kind FROM payment_applications pa JOIN charges c ON c.id=pa.charge_id WHERE pa.payment_id=?`,
      p.id,
    );
    const applied = apps.reduce((s: number, a: any) => s + a.amount_cents, 0);
    const unapplied = p.amount_cents - applied;
    const gross = p.amount_cents + p.fee_cents;

    // accrual reversal: DR AR / CR clearing
    const accrualLines = [
      { account: '1100', debit: p.amount_cents, memo: `${kind} reversal` },
      { account: '1050', credit: gross },
    ] as { account: string; debit?: number; credit?: number; memo?: string }[];
    if (p.fee_cents > 0) accrualLines.splice(1, 0, { account: '4080', debit: p.fee_cents, memo: 'fee reversal' });
    postJE(ctx, {
      propertyId: p.property_id, date, basis: 'accrual', memo: `${kind.toUpperCase()} ${usd(p.amount_cents)}`,
      sourceKind: 'nsf', sourceId: p.id, lines: accrualLines,
    });

    // cash reversal: DR income (per application) + prepaid + fee / CR clearing
    const cashLines: { account: string; debit?: number; credit?: number; memo?: string }[] = [];
    const byAccount = new Map<string, number>();
    for (const a of apps) {
      const acct = CHARGE_CREDIT[a.kind] || CHARGE_CREDIT['other']!;
      byAccount.set(acct, (byAccount.get(acct) || 0) + a.amount_cents);
    }
    for (const [acct, amt] of byAccount) cashLines.push({ account: acct, debit: amt });
    if (unapplied > 0) cashLines.push({ account: '2150', debit: unapplied });
    if (p.fee_cents > 0) cashLines.push({ account: '4080', debit: p.fee_cents });
    cashLines.push({ account: '1050', credit: gross });
    postJE(ctx, {
      propertyId: p.property_id, date, basis: 'cash', memo: `${kind.toUpperCase()} ${usd(p.amount_cents)}`,
      sourceKind: 'nsf', sourceId: p.id, lines: cashLines,
    });

    // NSF fee charge
    const nsfFee = getSetting<number>(ctx, 'nsf_fee_cents', p.property_id);
    if (nsfFee > 0) {
      createCharge(ctx, {
        leaseId: p.lease_id, kind: 'nsf_fee', label: `Returned payment fee (${kind.toUpperCase()})`,
        amountCents: nsfFee, date, dueDate: date, source: 'nsf',
      });
    }
  });
  emit(ctx, `payment.${kind}`, 'payment', p.id, { leaseId: p.lease_id, amountCents: p.amount_cents });

  const contact = primaryContact(ctx, p.lease_id);
  const nsfFee = getSetting<number>(ctx, 'nsf_fee_cents', p.property_id);
  notify(ctx, 'payment_nsf', {
    email: contact.email, phone: contact.phone, name: contact.name, userId: contact.userId,
    personId: contact.residentId, propertyId: p.property_id, entity: 'payment', entityId: p.id,
  }, {
    first_name: contact.first, amount: usd(p.amount_cents), date: fmtDate(p.received_date),
    nsf_fee: usd(nsfFee), balance: usd(leaseBalance(ctx, p.lease_id)), property: contact.propertyName,
  });
}

// ---------- late fees ----------

export interface LateFeeCandidate {
  leaseId: string;
  householdName: string;
  unit: string;
  propertyId: string;
  propertyName: string;
  unpaidRent: number;
  fee: number;
  kind: 'initial' | 'daily';
  daysLate: number;
}

/** who would be assessed if the run happened on `date` */
export function lateFeeCandidates(ctx: Ctx, date: string, propertyId?: string | null): LateFeeCandidate[] {
  const mk = monthKey(date);
  const params: unknown[] = [ctx.orgId];
  let propSql = '';
  if (propertyId) { propSql = ' AND l.property_id=?'; params.push(propertyId); }
  // set-based prefilter: only leases with a rent/MTM charge older than the
  // minimum grace floor (3 days — every policy uses ≥3) and not fully applied
  // can possibly owe a fee; the exact per-property grace applies below.
  // Keeps the daily sweep off the other ~95% of leases.
  const leases = q<any>(
    `SELECT DISTINCT l.*, u.unit_number, p.name AS property_name FROM leases l
     JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=l.property_id
     JOIN charges c ON c.lease_id=l.id AND c.status='active' AND c.month_key=? AND c.kind IN ('rent','mtm_premium') AND date(c.due_date, '+3 days') < ?
     WHERE l.org_id=? AND l.status IN ('active','month_to_month','notice')${propSql}
       AND c.amount_cents > (SELECT COALESCE(SUM(pa.amount_cents),0) FROM payment_applications pa
                             JOIN payments p2 ON p2.id=pa.payment_id AND p2.status IN ('pending','settled')
                             WHERE pa.charge_id=c.id)`,
    mk, date, ...params,
  );
  const out: LateFeeCandidate[] = [];
  const policyCache = new Map<string, any>();
  for (const l of leases) {
    let policy = policyCache.get(l.property_id);
    if (!policy) {
      policy = getSetting<any>(ctx, 'late_fee_policy', l.property_id);
      policyCache.set(l.property_id, policy);
    }
    // each rent charge is late once ITS OWN due date + grace has passed (mid-month
    // move-ins prorate with a mid-month due date and must not be assessed early)
    const unpaid = q<any>(
      `SELECT c.id, c.amount_cents, c.due_date,
        (SELECT COALESCE(SUM(pa.amount_cents),0) FROM payment_applications pa JOIN payments p2 ON p2.id=pa.payment_id AND p2.status IN ('pending','settled') WHERE pa.charge_id=c.id) AS applied
       FROM charges c WHERE c.org_id=? AND c.lease_id=? AND c.status='active' AND c.month_key=? AND c.kind IN ('rent','mtm_premium')`,
      ctx.orgId, l.id, mk,
    );
    const overdue = unpaid.filter((c: any) => date > addDays(c.due_date, policy.graceDays));
    if (!overdue.length) continue;
    const graceEnd = addDays(overdue[0]!.due_date, policy.graceDays);
    const unpaidRent = overdue.reduce((s: number, c: any) => s + Math.max(0, c.amount_cents - c.applied), 0);
    if (unpaidRent < (policy.minBalanceCents || 0)) continue;
    const existing = q<any>(
      `SELECT id, date FROM charges WHERE org_id=? AND lease_id=? AND kind='late_fee' AND month_key=? AND status='active' AND amount_cents>0 ORDER BY date`,
      ctx.orgId, l.id, mk,
    );
    const daysLate = diffDays(date, graceEnd);
    if (!existing.length) {
      let fee = 0;
      if (policy.type === 'flat' || policy.type === 'flat_plus_daily') fee = policy.flatCents || 0;
      else if (policy.type === 'percent') fee = Math.round((unpaidRent * (policy.percent || 5)) / 100);
      if (fee > 0) {
        out.push({ leaseId: l.id, householdName: l.household_name, unit: l.unit_number, propertyId: l.property_id, propertyName: l.property_name, unpaidRent, fee, kind: 'initial', daysLate });
      }
    } else if (policy.type === 'flat_plus_daily' && policy.dailyCents > 0) {
      const assessedDaily = (existing.length - 1) * policy.dailyCents;
      const lastDate = existing[existing.length - 1]!.date;
      if (lastDate < date && assessedDaily + policy.dailyCents <= (policy.dailyCapCents || Infinity)) {
        out.push({ leaseId: l.id, householdName: l.household_name, unit: l.unit_number, propertyId: l.property_id, propertyName: l.property_name, unpaidRent, fee: policy.dailyCents, kind: 'daily', daysLate });
      }
    }
  }
  return out;
}

export function assessLateFees(ctx: Ctx, date: string, propertyId?: string | null): string {
  const candidates = lateFeeCandidates(ctx, date, propertyId);
  for (const c of candidates) {
    createCharge(ctx, {
      leaseId: c.leaseId, kind: 'late_fee',
      label: c.kind === 'initial' ? 'Late fee' : `Daily late fee (day ${c.daysLate})`,
      amountCents: c.fee, date, dueDate: date, monthKey: monthKey(date), source: 'late_fee',
    });
    if (c.kind === 'initial') {
      const contact = primaryContact(ctx, c.leaseId);
      notify(ctx, 'late_fee_notice', {
        email: contact.email, phone: contact.phone, name: contact.name, userId: contact.userId,
        personId: contact.residentId, propertyId: c.propertyId, entity: 'lease', entityId: c.leaseId,
      }, {
        first_name: contact.first, month: fmtMonth(monthKey(date)), fee: usd(c.fee), date: fmtDate(date),
        balance: usd(leaseBalance(ctx, c.leaseId)), property: c.propertyName,
      });
      emit(ctx, 'latefee.assessed', 'lease', c.leaseId, { fee: c.fee });
    }
  }
  return candidates.length ? `${candidates.length} late fees assessed` : 'no late fees due';
}

export function waiveLateFee(ctx: Ctx, chargeId: string, reason: string): void {
  const c = q1<any>(`SELECT * FROM charges WHERE id=? AND org_id=? AND kind IN ('late_fee','nsf_fee')`, chargeId, ctx.orgId);
  if (!c || c.status !== 'active' || c.amount_cents <= 0) throw new Error('fee not found or not waivable');
  createCharge(ctx, {
    leaseId: c.lease_id, kind: c.kind, label: `Waiver: ${c.label} (${reason})`,
    amountCents: -c.amount_cents, date: ctx.businessDate, source: 'oneoff',
  });
  audit(ctx, 'charge', chargeId, 'fee_waived', null, { reason, amount: -c.amount_cents });
  emit(ctx, 'latefee.waived', 'charge', chargeId, { leaseId: c.lease_id, reason });
}

// ---------- autopay ----------

export function runAutopay(ctx: Ctx, date: string): string {
  const day = parseInt(date.slice(8, 10), 10);
  const enrollments = q<any>(
    `SELECT ae.*, l.status AS lease_status FROM autopay_enrollments ae JOIN leases l ON l.id=ae.lease_id
     WHERE ae.org_id=? AND ae.active=1 AND ae.day_of_month=? AND ae.start_date<=? AND (ae.end_date IS NULL OR ae.end_date>=?)`,
    ctx.orgId, day, date, date,
  );
  let count = 0;
  const mk = monthKey(date);
  for (const e of enrollments) {
    if (!['active', 'month_to_month', 'notice'].includes(e.lease_status)) continue;
    const already = q1<any>(
      `SELECT id FROM payments WHERE org_id=? AND lease_id=? AND autopay=1 AND received_date LIKE ? AND status NOT IN ('failed','voided')`,
      ctx.orgId, e.lease_id, mk + '%',
    );
    if (already) continue;
    const balance = leaseBalance(ctx, e.lease_id);
    const amount = e.mode === 'fixed' ? Math.min(e.fixed_amount_cents || 0, Math.max(balance, 0)) : balance;
    if (amount <= 0) continue;
    try {
      recordPayment(ctx, {
        leaseId: e.lease_id, amountCents: amount, method: 'ach', methodTokenId: e.method_token_id,
        receivedDate: date, autopay: true,
      });
      count++;
    } catch {
      /* declined — resident will see NSF/decline notification */
    }
  }
  return count ? `${count} autopay drafts initiated` : 'no autopay due';
}

// ---------- payment plans ----------

export function createPaymentPlan(ctx: Ctx, leaseId: string, totalCents: number, installments: { dueDate: string; amountCents: number }[], notes?: string): string {
  const lease = q1<any>('SELECT * FROM leases WHERE id=? AND org_id=?', leaseId, ctx.orgId);
  if (!lease) throw new Error('lease not found');
  const sum = installments.reduce((s, i) => s + i.amountCents, 0);
  if (sum !== totalCents) throw new Error(`installments (${sum}) must sum to plan total (${totalCents})`);
  const planId = id('pln');
  tx(() => {
    insert('payment_plans', {
      id: planId, org_id: ctx.orgId, property_id: lease.property_id, lease_id: leaseId,
      total_cents: totalCents, status: 'active', notes: notes || null, created_by: ctx.userId, created_at: nowIso(),
    });
    for (const inst of installments) {
      insert('payment_plan_installments', {
        id: id('pli'), org_id: ctx.orgId, plan_id: planId, due_date: inst.dueDate,
        amount_cents: inst.amountCents, status: 'scheduled', created_at: nowIso(),
      });
    }
  });
  const contact = primaryContact(ctx, leaseId);
  notify(ctx, 'payment_plan_confirmed', {
    email: contact.email, phone: contact.phone, name: contact.name, userId: contact.userId,
    personId: contact.residentId, propertyId: lease.property_id, entity: 'payment_plan', entityId: planId,
  }, {
    first_name: contact.first, total: usd(totalCents), n: installments.length,
    first_date: fmtDate(installments[0]?.dueDate || ctx.businessDate), property: contact.propertyName,
    schedule_html: `<ul>${installments.map((i) => `<li>${fmtDate(i.dueDate)} — ${usd(i.amountCents)}</li>`).join('')}</ul>`,
  });
  emit(ctx, 'payment_plan.created', 'payment_plan', planId, { leaseId, totalCents });
  audit(ctx, 'payment_plan', planId, 'create', null, { leaseId, totalCents, installments: installments.length });
  return planId;
}

export function runPaymentPlans(ctx: Ctx, date: string): string {
  const due = q<any>(
    `SELECT i.*, pp.lease_id, pp.id AS plan_id FROM payment_plan_installments i
     JOIN payment_plans pp ON pp.id=i.plan_id AND pp.status='active'
     WHERE i.org_id=? AND i.status='scheduled' AND i.due_date<=?`,
    ctx.orgId, date,
  );
  let charged = 0;
  let missed = 0;
  for (const inst of due) {
    // use the lease's autopay method if present
    const method = q1<any>(
      `SELECT method_token_id FROM autopay_enrollments WHERE lease_id=? AND active=1
       UNION SELECT id AS method_token_id FROM payment_method_tokens WHERE lease_id=? AND is_default=1 LIMIT 1`,
      inst.lease_id, inst.lease_id,
    );
    if (method?.method_token_id) {
      try {
        const pid = recordPayment(ctx, {
          leaseId: inst.lease_id, amountCents: inst.amount_cents, method: 'ach',
          methodTokenId: method.method_token_id, receivedDate: date, memo: 'payment plan installment',
        });
        run("UPDATE payment_plan_installments SET status='paid', payment_id=? WHERE id=?", pid, inst.id);
        charged++;
        continue;
      } catch {
        /* fall through to missed */
      }
    }
    if (diffDays(date, inst.due_date) >= 1) {
      run("UPDATE payment_plan_installments SET status='missed' WHERE id=?", inst.id);
      missed++;
      const missCount = val<number>(`SELECT COUNT(*) FROM payment_plan_installments WHERE plan_id=? AND status='missed'`, inst.plan_id) || 0;
      if (missCount >= 2) run("UPDATE payment_plans SET status='defaulted' WHERE id=?", inst.plan_id);
    }
  }
  // complete finished plans
  run(
    `UPDATE payment_plans SET status='completed' WHERE org_id=? AND status='active'
     AND NOT EXISTS (SELECT 1 FROM payment_plan_installments i WHERE i.plan_id=payment_plans.id AND i.status IN ('scheduled','missed'))`,
    ctx.orgId,
  );
  return `${charged} installments charged, ${missed} missed`;
}

// ---------- deposits: interest + disposition (M8.6) ----------

export function depositHeld(ctx: Ctx, leaseId: string): number {
  const accrued = val<number>(
    `SELECT COALESCE(SUM(amount_cents),0) FROM charges WHERE org_id=? AND lease_id=? AND kind='deposit' AND status='active'`,
    ctx.orgId, leaseId,
  ) || 0;
  const activity = val<number>(
    `SELECT COALESCE(SUM(amount_cents),0) FROM deposit_activity WHERE org_id=? AND lease_id=? AND kind IN ('interest','apply','refund')`,
    ctx.orgId, leaseId,
  ) || 0;
  return accrued + activity;
}

export interface DispositionResult {
  applied: number;
  refunded: number;
  balanceDue: number;
}

/** deposit-alternative claim hook (M12 registers; avoids a module cycle) */
type AltClaimFn = (ctx: Ctx, leaseId: string, date: string) => number;
let altClaimHook: AltClaimFn | null = null;
export function registerDepositAlternativeHook(fn: AltClaimFn): void {
  altClaimHook = fn;
}

/** Move-out disposition: apply held deposit to the final balance, refund any
 * remainder, and hand the shortfall to collections when directed. On
 * deposit-alternative leases the surety claim covers the balance up to
 * coverage first. */
export function finalizeDeposit(ctx: Ctx, leaseId: string, opts: { date: string; toCollections?: boolean }): DispositionResult {
  const lease = q1<any>('SELECT * FROM leases WHERE id=? AND org_id=?', leaseId, ctx.orgId);
  if (!lease) throw new Error('lease not found');
  if (lease.deposit_alternative && altClaimHook) {
    altClaimHook(ctx, leaseId, opts.date);
  }
  const held = depositHeld(ctx, leaseId);
  const balance = leaseBalance(ctx, leaseId);
  const apply = Math.max(0, Math.min(held, balance));
  let refunded = 0;

  tx(() => {
    if (apply > 0) {
      // deposit application is a 'credit' payment funded from 2100
      recordPayment(ctx, {
        leaseId, amountCents: apply, method: 'credit', receivedDate: opts.date,
        memo: 'security deposit applied at move-out', creditFunding: '2100', suppressReceipt: true,
      });
      insert('deposit_activity', {
        id: id('dep'), org_id: ctx.orgId, property_id: lease.property_id, lease_id: leaseId,
        kind: 'apply', amount_cents: -apply, date: opts.date, memo: 'applied to final balance', created_at: nowIso(),
      });
    }
    const remaining = held - apply;
    if (remaining > 0) {
      refunded = remaining;
      const rid = id('rfd');
      insert('refunds', {
        id: rid, org_id: ctx.orgId, property_id: lease.property_id, lease_id: leaseId, kind: 'deposit',
        amount_cents: remaining, method: 'check', reference: `DEP-${rid.slice(-6).toUpperCase()}`,
        date: opts.date, status: 'issued', created_by: ctx.userId, created_at: nowIso(),
      });
      insert('deposit_activity', {
        id: id('dep'), org_id: ctx.orgId, property_id: lease.property_id, lease_id: leaseId,
        kind: 'refund', amount_cents: -remaining, date: opts.date, refund_id: rid, memo: 'refunded to resident', created_at: nowIso(),
      });
      for (const basis of ['accrual', 'cash'] as const) {
        postJE(ctx, {
          propertyId: lease.property_id, date: opts.date, basis,
          memo: `Deposit refund ${usd(remaining)} — ${lease.household_name}`, sourceKind: 'refund', sourceId: rid,
          lines: [
            { account: '2100', debit: remaining },
            { account: '1020', credit: remaining },
          ],
        });
      }
      // NOTE: refunds table also shows on the resident ledger as an offset to their credit — but
      // deposit refunds return escrow, not ledger credit, so exclude kind='deposit' from balance.
    }
  });

  const balanceAfter = leaseBalance(ctx, leaseId);
  if (balanceAfter > 0 && opts.toCollections) {
    openCollectionCase(ctx, leaseId, `move-out balance after deposit application`);
  }
  emit(ctx, 'deposit.disposed', 'lease', leaseId, { applied: apply, refunded, balanceDue: balanceAfter });
  audit(ctx, 'lease', leaseId, 'deposit_disposition', null, { applied: apply, refunded, balanceDue: balanceAfter });
  return { applied: apply, refunded, balanceDue: balanceAfter };
}

export function openCollectionCase(ctx: Ctx, leaseId: string, notes: string): string {
  const lease = q1<any>('SELECT * FROM leases WHERE id=? AND org_id=?', leaseId, ctx.orgId);
  if (!lease) throw new Error('lease not found');
  const existing = q1<any>(`SELECT id FROM collection_cases WHERE lease_id=? AND status='open'`, leaseId);
  if (existing) return existing.id as string;
  const cid = id('col');
  insert('collection_cases', {
    id: cid, org_id: ctx.orgId, property_id: lease.property_id, lease_id: leaseId,
    balance_cents: leaseBalance(ctx, leaseId), status: 'open', opened_date: ctx.businessDate,
    notes, created_at: nowIso(),
  });
  emit(ctx, 'collections.opened', 'collection_case', cid, { leaseId });
  audit(ctx, 'collection_case', cid, 'create', null, { leaseId, notes });
  return cid;
}

// ---------- prepaid credits auto-apply on new charges ----------

on('charge.created', (ctx, payload) => {
  const leaseId = payload.leaseId as string;
  if (!leaseId) return;
  // payments with unapplied remainder
  const credits = q<any>(
    `SELECT p.id, p.property_id, p.amount_cents,
       (SELECT COALESCE(SUM(a.amount_cents),0) FROM payment_applications a WHERE a.payment_id=p.id) AS applied
     FROM payments p WHERE p.org_id=? AND p.lease_id=? AND p.status IN ('pending','settled') AND p.method != 'credit'
       AND p.amount_cents > (SELECT COALESCE(SUM(a.amount_cents),0) FROM payment_applications a WHERE a.payment_id=p.id)`,
    ctx.orgId, leaseId,
  );
  if (!credits.length) return;
  const charge = q1<any>('SELECT * FROM charges WHERE id=? AND status=\'active\'', payload.entityId);
  if (!charge || charge.amount_cents <= 0) return;
  let openAmt = charge.amount_cents - (val<number>(
    `SELECT COALESCE(SUM(a.amount_cents),0) FROM payment_applications a JOIN payments p ON p.id=a.payment_id AND p.status IN ('pending','settled') WHERE a.charge_id=?`,
    charge.id,
  ) || 0);
  for (const cr of credits) {
    if (openAmt <= 0) break;
    const avail = cr.amount_cents - cr.applied;
    const take = Math.min(avail, openAmt);
    if (take <= 0) continue;
    insert('payment_applications', { id: id('pap'), org_id: ctx.orgId, payment_id: cr.id, charge_id: charge.id, amount_cents: take, created_at: nowIso() });
    openAmt -= take;
    // cash basis: move prepaid liability into income now that it has a home
    const acct = CHARGE_CREDIT[charge.kind] || CHARGE_CREDIT['other']!;
    postJE(ctx, {
      propertyId: charge.property_id, date: ctx.businessDate, basis: 'cash',
      memo: `Prepaid credit applied to ${charge.label}`, sourceKind: 'application', sourceId: cr.id,
      lines: [
        { account: '2150', debit: take },
        { account: acct, credit: take },
      ],
    });
  }
});

// ---------- receivables analytics (M8.7) ----------

export interface ReceivablesStats {
  billed: number;
  collected: number;
  collectionRate: number;
  onTimePct: number;
  nsfCount: number;
  nsfRate: number;
  autopayAdoption: number;
  delinquentHouseholds: number;
  delinquentTotal: number;
}

export function receivablesStats(ctx: Ctx, mk: string, propertyId?: string | null): ReceivablesStats {
  const propParams: unknown[] = propertyId ? [propertyId] : [];
  const propSql = propertyId ? ' AND property_id=?' : '';
  // billed = everything posted in the month by DATE (recurring rent carries
  // month_key = its month, but one-off fees post with month_key NULL — counting
  // by date keeps them in the denominator so the rate can't overstate)
  const billed = val<number>(
    `SELECT COALESCE(SUM(amount_cents),0) FROM charges WHERE org_id=? AND date LIKE ? AND status='active' AND kind NOT IN ('deposit')${propSql}`,
    ctx.orgId, mk + '%', ...propParams,
  ) || 0;
  const collectedGross = val<number>(
    `SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE org_id=? AND received_date LIKE ? AND status IN ('pending','settled') AND method != 'credit'${propSql}`,
    ctx.orgId, mk + '%', ...propParams,
  ) || 0;
  // deposits are balance-sheet receipts, not rent collections — net them out
  const depositReceipts = val<number>(
    `SELECT COALESCE(SUM(pa.amount_cents),0) FROM payment_applications pa
     JOIN payments p ON p.id=pa.payment_id AND p.status IN ('pending','settled') AND p.method != 'credit'
     JOIN charges c ON c.id=pa.charge_id AND c.kind='deposit'
     WHERE pa.org_id=? AND p.received_date LIKE ?${propSql.replaceAll('property_id', 'p.property_id')}`,
    ctx.orgId, mk + '%', ...propParams,
  ) || 0;
  const collected = collectedGross - depositReceipts;
  const paymentsCount = val<number>(
    `SELECT COUNT(*) FROM payments WHERE org_id=? AND received_date LIKE ? AND method IN ('ach','card')${propSql}`,
    ctx.orgId, mk + '%', ...propParams,
  ) || 0;
  const nsfCount = val<number>(
    `SELECT COUNT(*) FROM payments WHERE org_id=? AND received_date LIKE ? AND status IN ('nsf','chargeback')${propSql}`,
    ctx.orgId, mk + '%', ...propParams,
  ) || 0;
  // on-time: rent charges for the month with payments covering them by due+grace
  const rentRows = q<any>(
    `SELECT c.id, c.lease_id, c.property_id, c.amount_cents, c.due_date,
      (SELECT COALESCE(SUM(pa.amount_cents),0) FROM payment_applications pa
        JOIN payments p ON p.id=pa.payment_id AND p.status IN ('pending','settled')
        WHERE pa.charge_id=c.id AND p.received_date <= date(c.due_date, '+' || ? || ' days')) AS paid_by_grace
     FROM charges c WHERE c.org_id=? AND c.month_key=? AND c.kind='rent' AND c.status='active'${propSql.replaceAll('property_id', 'c.property_id')}`,
    5, ctx.orgId, mk, ...propParams,
  );
  const onTime = rentRows.filter((r) => r.paid_by_grace >= r.amount_cents).length;
  const activeLeases = val<number>(
    `SELECT COUNT(*) FROM leases WHERE org_id=? AND status IN ('active','month_to_month','notice')${propSql}`,
    ctx.orgId, ...propParams,
  ) || 0;
  const autopay = val<number>(
    `SELECT COUNT(DISTINCT ae.lease_id) FROM autopay_enrollments ae JOIN leases l ON l.id=ae.lease_id
     WHERE ae.org_id=? AND ae.active=1 AND l.status IN ('active','month_to_month','notice')${propertyId ? ' AND l.property_id=?' : ''}`,
    ctx.orgId, ...(propertyId ? [propertyId] : []),
  ) || 0;
  return {
    billed, collected,
    collectionRate: billed ? Math.round((collected / billed) * 1000) / 10 : 0,
    onTimePct: rentRows.length ? Math.round((onTime / rentRows.length) * 1000) / 10 : 0,
    nsfCount,
    nsfRate: paymentsCount ? Math.round((nsfCount / paymentsCount) * 1000) / 10 : 0,
    autopayAdoption: activeLeases ? Math.round((autopay / activeLeases) * 1000) / 10 : 0,
    delinquentHouseholds: 0, // filled by caller via agingRows when needed
    delinquentTotal: 0,
  };
}

// ---------- jobs ----------

registerJob({
  key: 'payment_settlement',
  name: 'Payment settlement (ACH T+3, card T+1)',
  describe: 'Settles pending payments due today; ACH returns bounce here (NSF) and reinstate balances with a fee.',
  run: (ctx, date) => settleDuePayments(ctx, date),
});

registerJob({
  key: 'late_fees',
  name: 'Late fee assessment',
  describe: 'Assesses late fees per property policy (grace days, flat/percent/daily with caps) on unpaid rent.',
  run: (ctx, date) => assessLateFees(ctx, date),
});

registerJob({
  key: 'autopay',
  name: 'Autopay drafts',
  describe: 'Initiates ACH drafts for enrolled leases on their scheduled day (full-balance or fixed amount).',
  run: (ctx, date) => runAutopay(ctx, date),
});

registerJob({
  key: 'payment_plans',
  name: 'Payment plan installments',
  describe: 'Charges due installments to saved methods; marks missed installments and defaults plans after 2 misses.',
  run: (ctx, date) => runPaymentPlans(ctx, date),
});

// ---------- bad debt write-off (M8 → feeds the §10 Bad Debt report) ----------

/** Write the lease's open balance off to 5610 Bad Debt Expense (negative AR
 * charge, kind `writeoff`). Above the org threshold it needs a controller
 * (gl:post) on top of collections:manage. Closes any open collections case. */
export function writeOffBalance(ctx: Ctx, leaseId: string, reason: string): number {
  assertPerm(ctx, 'collections:manage');
  if (!reason.trim()) throw new Error('a write-off needs a written reason');
  const bal = leaseBalance(ctx, leaseId);
  if (bal <= 0) throw new Error('nothing to write off — the balance is not positive');
  const threshold = getSetting<number>(ctx, 'writeoff_approval_threshold_cents');
  if (bal > threshold) assertPerm(ctx, 'gl:post');
  createCharge(ctx, {
    leaseId, kind: 'writeoff', label: `Bad debt write-off — ${reason}`,
    amountCents: -bal, date: ctx.businessDate, dueDate: ctx.businessDate, source: 'writeoff',
  });
  run(`UPDATE collection_cases SET status='written_off' WHERE org_id=? AND lease_id=? AND status='open'`, ctx.orgId, leaseId);
  audit(ctx, 'lease', leaseId, 'bad_debt_writeoff', null, { cents: bal, reason });
  emit(ctx, 'ar.writeoff', 'lease', leaseId, { cents: bal, reason });
  return bal;
}
