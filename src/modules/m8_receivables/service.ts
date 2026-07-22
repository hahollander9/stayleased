import { q, q1, insert, val, tx, run, update } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import {
  nowIso, monthKey, firstOfMonth, lastOfMonth, daysInMonth, parts, addDays, diffDays, minDate, maxDate, cmp,
} from '../../lib/dates.ts';
import { propFilter, type Ctx } from '../../lib/auth.ts';
import { emit } from '../../lib/events.ts';
import { getSetting } from '../../lib/settings.ts';
import { registerJob } from '../../lib/jobs.ts';
import { postJE } from '../m9_accounting/service.ts';
import { CHARGE_CREDIT } from '../m9_accounting/coa.ts';

/** M8.1 charge engine: recurring rent/fee posting from lease charge schedules,
 * prorations, one-off charges — everything accrues through the GL (accrual
 * basis; cash basis posts at payment application, Phase 3). */

export interface ChargeInput {
  leaseId: string;
  kind: string;
  label: string;
  amountCents: number;
  date: string;
  dueDate?: string;
  monthKey?: string | null;
  leaseChargeId?: string | null;
  source?: string;
  memo?: string;
}

export function createCharge(ctx: Ctx, input: ChargeInput): string {
  const lease = q1<any>('SELECT * FROM leases WHERE id=? AND org_id=?', input.leaseId, ctx.orgId);
  if (!lease) throw new Error('lease not found');
  const creditAccount = CHARGE_CREDIT[input.kind] || CHARGE_CREDIT['other']!;
  const chargeId = id('chg');
  tx(() => {
    // concessions/credits post as negative charges: DR income (reduce), CR AR
    const amt = input.amountCents;
    const jeId = postJE(ctx, {
      propertyId: lease.property_id,
      date: input.date,
      basis: 'accrual',
      memo: input.memo || `${input.label} — ${lease.household_name}`,
      sourceKind: 'charge',
      sourceId: chargeId,
      lines:
        amt >= 0
          ? [
              { account: '1100', debit: amt, memo: input.label },
              { account: creditAccount, credit: amt, memo: input.label },
            ]
          : [
              { account: creditAccount, debit: -amt, memo: input.label },
              { account: '1100', credit: -amt, memo: input.label },
            ],
    });
    insert('charges', {
      id: chargeId, org_id: ctx.orgId, property_id: lease.property_id, lease_id: lease.id,
      kind: input.kind, label: input.label, amount_cents: amt, date: input.date,
      due_date: input.dueDate || input.date, month_key: input.monthKey ?? null,
      lease_charge_id: input.leaseChargeId ?? null, source: input.source || 'oneoff',
      status: 'active', je_id: jeId, created_at: nowIso(),
    });
  });
  emit(ctx, 'charge.created', 'charge', chargeId, {
    leaseId: lease.id, propertyId: lease.property_id, kind: input.kind, amountCents: input.amountCents, label: input.label,
  });
  return chargeId;
}

export function voidCharge(ctx: Ctx, chargeId: string, reason: string): void {
  const c = q1<any>('SELECT * FROM charges WHERE id=? AND org_id=?', chargeId, ctx.orgId);
  if (!c || c.status !== 'active') throw new Error('charge not found or not active');
  const applied = val<number>('SELECT COALESCE(SUM(amount_cents),0) FROM payment_applications WHERE charge_id=?', chargeId) || 0;
  if (applied > 0) throw new Error('cannot void a charge with payments applied — adjust instead');
  tx(() => {
    const creditAccount = CHARGE_CREDIT[c.kind] || CHARGE_CREDIT['other']!;
    postJE(ctx, {
      propertyId: c.property_id, date: ctx.businessDate, basis: 'accrual',
      memo: `VOID: ${c.label} (${reason})`, sourceKind: 'charge_void', sourceId: c.id,
      lines: c.amount_cents >= 0
        ? [
            { account: creditAccount, debit: c.amount_cents },
            { account: '1100', credit: c.amount_cents },
          ]
        : [
            { account: '1100', debit: -c.amount_cents },
            { account: creditAccount, credit: -c.amount_cents },
          ],
    });
    run("UPDATE charges SET status='voided' WHERE id=?", c.id);
  });
  emit(ctx, 'charge.voided', 'charge', c.id, { leaseId: c.lease_id, reason });
}

// ---------- ledger & balances ----------

export interface LedgerRow {
  date: string;
  kind: 'charge' | 'payment' | 'refund';
  label: string;
  charge_cents: number;
  credit_cents: number;
  balance: number;
  ref_id: string;
  status?: string;
}

/** unified resident (household) ledger with running balance */
export function leaseLedger(ctx: Ctx, leaseId: string): LedgerRow[] {
  const charges = q<any>(
    `SELECT id, date, label, kind, amount_cents, status, created_at FROM charges WHERE org_id=? AND lease_id=? AND status != 'voided' ORDER BY date, created_at`,
    ctx.orgId, leaseId,
  );
  const payments = q<any>(
    `SELECT id, received_date AS date, method, reference, amount_cents, status, autopay, created_at FROM payments WHERE org_id=? AND lease_id=? AND status NOT IN ('voided','failed') ORDER BY received_date, created_at`,
    ctx.orgId, leaseId,
  );
  const refunds = q<any>(
    `SELECT id, date, kind, amount_cents, method, created_at FROM refunds WHERE org_id=? AND lease_id=? AND kind != 'deposit' ORDER BY date, created_at`,
    ctx.orgId, leaseId,
  );
  const rows: (Omit<LedgerRow, 'balance'> & { created_at: string })[] = [
    ...charges.map((c) => ({
      date: c.date, kind: 'charge' as const,
      label: c.status === 'written_off' ? `${c.label} (written off)` : c.label,
      charge_cents: c.amount_cents, credit_cents: 0, ref_id: c.id, status: c.status, created_at: c.created_at,
    })),
    ...payments.map((p) => ({
      date: p.date, kind: 'payment' as const,
      label: `Payment — ${p.method.toUpperCase()}${p.autopay ? ' autopay' : ''}${p.reference ? ` #${p.reference}` : ''}${p.status === 'nsf' ? ' (NSF — reversed)' : p.status === 'chargeback' ? ' (chargeback)' : p.status === 'pending' ? ' (pending)' : ''}`,
      charge_cents: 0, credit_cents: p.status === 'nsf' || p.status === 'chargeback' ? 0 : p.amount_cents,
      ref_id: p.id, status: p.status, created_at: p.created_at,
    })),
    ...refunds.map((r) => ({
      date: r.date, kind: 'refund' as const, label: `Refund issued (${r.kind})`,
      charge_cents: r.amount_cents, credit_cents: 0, ref_id: r.id, status: 'issued', created_at: r.created_at,
    })),
  ];
  rows.sort((a, b) => cmp(a.date, b.date) || a.created_at.localeCompare(b.created_at));
  let bal = 0;
  return rows.map((r) => {
    bal += r.charge_cents - r.credit_cents;
    return { ...r, balance: bal };
  });
}

/** current balance for a lease (charges − good payments − refunds reversal) */
export function leaseBalance(ctx: Ctx, leaseId: string): number {
  const c = val<number>(
    `SELECT COALESCE(SUM(amount_cents),0) FROM charges WHERE org_id=? AND lease_id=? AND status='active'`,
    ctx.orgId, leaseId,
  ) || 0;
  const p = val<number>(
    `SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE org_id=? AND lease_id=? AND status IN ('pending','settled')`,
    ctx.orgId, leaseId,
  ) || 0;
  // deposit refunds return escrow funds, not ledger credit — only overpayment refunds hit the ledger
  const r = val<number>(
    `SELECT COALESCE(SUM(amount_cents),0) FROM refunds WHERE org_id=? AND lease_id=? AND kind != 'deposit'`, ctx.orgId, leaseId,
  ) || 0;
  return c - p + r;
}

// ---------- recurring charge posting (the rent run) ----------

/** Post the month's recurring charges for one lease (idempotent per line+month).
 * Prorates around move-in / move-out per property policy. Returns lines posted. */
export function postMonthlyChargesForLease(ctx: Ctx, lease: any, mk: string): number {
  if (!['active', 'month_to_month', 'notice'].includes(lease.status)) return 0;
  const monthStart = mk + '-01';
  const monthEnd = lastOfMonth(monthStart);
  const effectiveStart = lease.move_in_date || lease.start_date;
  if (effectiveStart > monthEnd) return 0;
  const stopDate = lease.move_out_date && lease.status !== 'month_to_month' ? lease.move_out_date : null;
  if (stopDate && stopDate < monthStart) return 0;

  const prorateMethod = getSetting<string>(ctx, 'prorate_method', lease.property_id);
  const dim = daysInMonth(parts(monthStart).y, parts(monthStart).m);
  const from = maxDate(monthStart, effectiveStart);
  const to = stopDate ? minDate(monthEnd, stopDate) : monthEnd;
  const daysOccupied = diffDays(to, from) + 1;
  if (daysOccupied <= 0) return 0;
  const frac = prorateMethod === 'thirty_day' ? Math.min(1, daysOccupied / 30) : daysOccupied / dim;
  const prorated = daysOccupied < dim;

  const lines = q<any>(
    `SELECT * FROM lease_charges WHERE org_id=? AND lease_id=? AND (start_date IS NULL OR start_date<=?) AND (end_date IS NULL OR end_date>=?)`,
    ctx.orgId, lease.id, monthEnd, monthStart,
  );
  let posted = 0;
  for (const lc of lines) {
    const exists = q1(
      'SELECT id FROM charges WHERE org_id=? AND lease_id=? AND lease_charge_id=? AND month_key=?',
      ctx.orgId, lease.id, lc.id, mk,
    );
    if (exists) continue;
    let amount = lc.amount_cents;
    if (prorated) amount = Math.round(amount * frac);
    if (amount === 0) continue;
    createCharge(ctx, {
      leaseId: lease.id, kind: lc.kind, label: prorated ? `${lc.label} (prorated ${daysOccupied}d)` : lc.label,
      amountCents: amount, date: maxDate(monthStart, from), dueDate: maxDate(monthStart, from),
      monthKey: mk, leaseChargeId: lc.id, source: 'recurring',
    });
    posted++;
  }

  // month-to-month premium
  if (lease.status === 'month_to_month') {
    const pct = getSetting<number>(ctx, 'mtm_premium_pct', lease.property_id);
    const exists = q1(
      "SELECT id FROM charges WHERE org_id=? AND lease_id=? AND kind='mtm_premium' AND month_key=?",
      ctx.orgId, lease.id, mk,
    );
    if (!exists && pct > 0) {
      const premium = Math.round((lease.rent_cents * pct) / 100);
      createCharge(ctx, {
        leaseId: lease.id, kind: 'mtm_premium', label: `Month-to-month premium (${pct}%)`,
        amountCents: prorated ? Math.round(premium * frac) : premium,
        date: from, dueDate: from, monthKey: mk, source: 'recurring',
      });
      posted++;
    }
  }
  return posted;
}

export function runRentPosting(ctx: Ctx, date: string): string {
  const mk = monthKey(date);
  const leases = q<any>(
    `SELECT * FROM leases WHERE org_id=? AND status IN ('active','month_to_month','notice')`,
    ctx.orgId,
  );
  let charges = 0;
  let touched = 0;
  for (const lease of leases) {
    const n = postMonthlyChargesForLease(ctx, lease, mk);
    if (n > 0) touched++;
    charges += n;
  }
  return charges ? `${charges} charges posted across ${touched} leases for ${mk}` : `nothing to post for ${mk}`;
}

registerJob({
  key: 'rent_posting',
  name: 'Monthly charge posting',
  describe: 'Posts recurring lease charges (rent, items, fees, MTM premium) for the current month; prorates move-ins/outs. Idempotent daily.',
  run: (ctx, date) => runRentPosting(ctx, date),
});

// ---------- receivable aging ----------

export interface AgingRow {
  lease_id: string;
  household_name: string;
  unit_number: string;
  property_id: string;
  property_name: string;
  balance: number;
  current: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  d90p: number;
  oldest_due: string | null;
}

/** open balance aging by lease as of the business date (FIFO application) */
export function agingRows(ctx: Ctx, opts: { propertyId?: string | null; minBalance?: number } = {}): AgingRow[] {
  const params: unknown[] = [ctx.orgId];
  let propSql = '';
  if (opts.propertyId) {
    propSql = ' AND l.property_id=?';
    params.push(opts.propertyId);
  } else {
    // scope to the viewer's properties so every listed row is openable
    const pf = propFilter(ctx, 'l.property_id');
    propSql = pf.sql;
    params.push(...pf.params);
  }
  const leases = q<any>(
    `SELECT l.id, l.household_name, l.property_id, u.unit_number, p.name AS property_name
     FROM leases l JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=l.property_id
     WHERE l.org_id=? AND l.status IN ('active','month_to_month','notice','ended')${propSql}`,
    ...params,
  );
  const out: AgingRow[] = [];
  for (const l of leases) {
    const bal = leaseBalance(ctx, l.id);
    if (bal <= (opts.minBalance ?? 0)) continue;
    // age the open balance against unpaid charges oldest-first
    const openCharges = q<any>(
      `SELECT c.id, c.due_date, c.amount_cents,
        (SELECT COALESCE(SUM(pa.amount_cents),0) FROM payment_applications pa JOIN payments p ON p.id=pa.payment_id AND p.status IN ('pending','settled') WHERE pa.charge_id=c.id) AS applied
       FROM charges c WHERE c.org_id=? AND c.lease_id=? AND c.status='active' AND c.amount_cents>0 ORDER BY c.due_date`,
      ctx.orgId, l.id,
    );
    const row: AgingRow = {
      lease_id: l.id, household_name: l.household_name, unit_number: l.unit_number,
      property_id: l.property_id, property_name: l.property_name,
      balance: bal, current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90p: 0, oldest_due: null,
    };
    let remaining = bal;
    for (const c of openCharges) {
      if (remaining <= 0) break;
      const open = Math.min(c.amount_cents - c.applied, remaining);
      if (open <= 0) continue;
      remaining -= open;
      if (!row.oldest_due) row.oldest_due = c.due_date;
      const age = diffDays(ctx.businessDate, c.due_date);
      if (age <= 0) row.current += open;
      else if (age <= 30) row.d1_30 += open;
      else if (age <= 60) row.d31_60 += open;
      else if (age <= 90) row.d61_90 += open;
      else row.d90p += open;
    }
    if (remaining > 0) row.current += remaining; // unaged remainder (credits timing)
    out.push(row);
  }
  return out.sort((a, b) => b.balance - a.balance);
}
