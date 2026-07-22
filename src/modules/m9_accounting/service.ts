import { q, q1, insert, val, tx, run } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, monthKey } from '../../lib/dates.ts';
import type { Ctx } from '../../lib/auth.ts';

/** M9 core: the ledger is law (§3.2.2). Every financial event flows through
 * postJE; entries must balance to zero; posting into a closed period is
 * blocked. Both accrual and cash books are posted (M9.1). */

export interface JELine {
  account: string;
  debit?: number;
  credit?: number;
  memo?: string;
}

export interface JEInput {
  propertyId: string;
  date: string;
  basis: 'accrual' | 'cash';
  memo?: string;
  sourceKind: string;
  sourceId?: string;
  lines: JELine[];
  createdBy?: string;
  approvedBy?: string;
  reversalOf?: string; // links a reversing entry to the original
  allowClosed?: boolean; // reopening flows only
}

export class UnbalancedEntry extends Error {}
export class ClosedPeriod extends Error {}

export function isPeriodClosed(orgId: string, propertyId: string, periodKey: string): boolean {
  const row = q1<{ status: string }>(
    'SELECT status FROM accounting_periods WHERE org_id=? AND property_id=? AND period_key=?',
    orgId, propertyId, periodKey,
  );
  return row?.status === 'closed';
}

export function postJE(ctx: Ctx, input: JEInput): string {
  const dr = input.lines.reduce((s, l) => s + (l.debit || 0), 0);
  const cr = input.lines.reduce((s, l) => s + (l.credit || 0), 0);
  if (dr !== cr) {
    throw new UnbalancedEntry(`JE does not balance: DR ${dr} != CR ${cr} (${input.memo || input.sourceKind})`);
  }
  if (dr === 0 && cr === 0) throw new UnbalancedEntry('JE has no amounts');
  for (const l of input.lines) {
    if ((l.debit || 0) < 0 || (l.credit || 0) < 0) throw new UnbalancedEntry('negative line amounts not allowed — use the opposite side');
    if (!Number.isInteger(l.debit || 0) || !Number.isInteger(l.credit || 0)) throw new UnbalancedEntry('non-integer cents');
  }
  const pk = monthKey(input.date);
  if (!input.allowClosed && isPeriodClosed(ctx.orgId, input.propertyId, pk)) {
    throw new ClosedPeriod(`period ${pk} is closed for this property`);
  }
  const jeId = id('je');
  return tx(() => {
    insert('journal_entries', {
      id: jeId, org_id: ctx.orgId, property_id: input.propertyId, date: input.date, period_key: pk,
      basis: input.basis, memo: input.memo || null, source_kind: input.sourceKind, source_id: input.sourceId || null,
      reversal_of: input.reversalOf || null,
      approved_by: input.approvedBy || null, created_by: input.createdBy || ctx.userId, posted_at: nowIso(),
    });
    for (const l of input.lines) {
      insert('journal_lines', {
        id: id('jl'), org_id: ctx.orgId, entry_id: jeId, account_code: l.account,
        debit_cents: l.debit || 0, credit_cents: l.credit || 0, property_id: input.propertyId, memo: l.memo || null,
      });
    }
    return jeId;
  });
}

/** post the same lines to both books */
export function postBothBases(ctx: Ctx, input: Omit<JEInput, 'basis'>): { accrual: string; cash: string } {
  return {
    accrual: postJE(ctx, { ...input, basis: 'accrual' }),
    cash: postJE(ctx, { ...input, basis: 'cash' }),
  };
}

/** account balance as of a date (inclusive). sign convention: debit-positive. */
export function accountBalance(
  ctx: Ctx,
  code: string,
  opts: { propertyId?: string | null; basis?: 'accrual' | 'cash'; asOf?: string; from?: string } = {},
): number {
  const basis = opts.basis || 'accrual';
  const params: unknown[] = [ctx.orgId, basis, code];
  let where = 'jl.org_id=? AND je.basis=? AND jl.account_code=?';
  if (opts.propertyId) { where += ' AND jl.property_id=?'; params.push(opts.propertyId); }
  if (opts.from) { where += ' AND je.date>=?'; params.push(opts.from); }
  if (opts.asOf) { where += ' AND je.date<=?'; params.push(opts.asOf); }
  return (
    val<number>(
      `SELECT COALESCE(SUM(jl.debit_cents - jl.credit_cents),0) FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE ${where}`,
      ...params,
    ) || 0
  );
}

/** trial balance rows for a property/org */
export function trialBalance(
  ctx: Ctx,
  opts: { propertyId?: string | null; basis?: 'accrual' | 'cash'; asOf?: string },
): { code: string; name: string; type: string; debit: number; credit: number }[] {
  const basis = opts.basis || 'accrual';
  const params: unknown[] = [ctx.orgId, basis];
  let where = 'jl.org_id=? AND je.basis=?';
  if (opts.propertyId) { where += ' AND jl.property_id=?'; params.push(opts.propertyId); }
  if (opts.asOf) { where += ' AND je.date<=?'; params.push(opts.asOf); }
  const rows = q<any>(
    `SELECT jl.account_code AS code, a.name, a.type, SUM(jl.debit_cents) AS dr, SUM(jl.credit_cents) AS cr
     FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
     JOIN gl_accounts a ON a.org_id=jl.org_id AND a.code=jl.account_code
     WHERE ${where} GROUP BY jl.account_code ORDER BY jl.account_code`,
    ...params,
  );
  return rows.map((r) => {
    const net = Number(r.dr) - Number(r.cr);
    return { code: r.code, name: r.name, type: r.type, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
  });
}

// ---------- financial integrity invariants (§9) ----------

export interface InvariantResult {
  name: string;
  ok: boolean;
  detail: string;
}

export function runInvariants(ctx: Ctx): InvariantResult[] {
  const out: InvariantResult[] = [];

  // 1. every journal entry balances to zero
  const unbalanced = q<any>(
    `SELECT entry_id, SUM(debit_cents) d, SUM(credit_cents) c FROM journal_lines WHERE org_id=? GROUP BY entry_id HAVING d != c LIMIT 5`,
    ctx.orgId,
  );
  out.push({
    name: 'Every journal entry balances',
    ok: unbalanced.length === 0,
    detail: unbalanced.length ? `${unbalanced.length}+ unbalanced entries e.g. ${unbalanced[0].entry_id}` : 'all entries sum to zero',
  });

  // 2. AR control (accrual) equals open resident receivables (charges - applied payments)
  const arGl = accountBalance(ctx, '1100', { basis: 'accrual' });
  const chargeTotal = val<number>(
    `SELECT COALESCE(SUM(amount_cents),0) FROM charges WHERE org_id=? AND status='active'`, ctx.orgId,
  ) || 0;
  const paymentsToAr = arPaymentsTotal(ctx);
  const arSub = chargeTotal - paymentsToAr;
  out.push({
    name: 'AR control ties to resident subledger',
    ok: arGl === arSub,
    detail: `GL 1100 ${arGl} vs charges−receipts ${arSub}`,
  });

  // 3. deposits held liability equals held deposit subledger
  const depGl = -accountBalance(ctx, '2100', { basis: 'accrual' }); // credit balance positive
  const depSub = depositsHeldTotal(ctx);
  out.push({
    name: 'Deposit liability equals deposits held',
    ok: depGl === depSub,
    detail: `GL 2100 ${depGl} vs subledger ${depSub}`,
  });

  // 4. accounting equation per basis: assets = liabilities + equity + (income - expense)
  for (const basis of ['accrual', 'cash'] as const) {
    const sums = q<any>(
      `SELECT a.type, SUM(jl.debit_cents - jl.credit_cents) net
       FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
       JOIN gl_accounts a ON a.org_id=jl.org_id AND a.code=jl.account_code
       WHERE jl.org_id=? AND je.basis=? GROUP BY a.type`,
      ctx.orgId, basis,
    );
    const by: Record<string, number> = {};
    for (const r of sums) by[r.type] = Number(r.net);
    const assets = by['asset'] || 0;
    const rest = -((by['liability'] || 0) + (by['equity'] || 0) + (by['income'] || 0) + (by['expense'] || 0));
    out.push({
      name: `Accounting equation holds (${basis})`,
      ok: assets === rest,
      detail: `assets ${assets} vs L+E+NI ${rest}`,
    });
  }

  return out;
}

/** total receipts applied against AR (accrual receipt JEs credit 1100) — grows in Phase 3 */
function arPaymentsTotal(ctx: Ctx): number {
  return (
    val<number>(
      `SELECT COALESCE(SUM(jl.credit_cents - jl.debit_cents),0) FROM journal_lines jl
       JOIN journal_entries je ON je.id=jl.entry_id
       WHERE jl.org_id=? AND je.basis='accrual' AND jl.account_code='1100' AND je.source_kind IN ('payment','nsf','deposit_application','writeoff','refund')`,
      ctx.orgId,
    ) || 0
  );
}

/** deposit subledger truth: accrued deposit charges (active) + interest
 * − applications − refunds (signed rows in deposit_activity, Phase 3+). */
function depositsHeldTotal(ctx: Ctx): number {
  const accrued = val<number>(
    `SELECT COALESCE(SUM(amount_cents),0) FROM charges WHERE org_id=? AND kind='deposit' AND status='active'`,
    ctx.orgId,
  ) || 0;
  const activity = val<number>(
    `SELECT COALESCE(SUM(amount_cents),0) FROM deposit_activity WHERE org_id=? AND kind IN ('interest','apply','refund')`,
    ctx.orgId,
  ) || 0;
  return accrued + activity;
}
