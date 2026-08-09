import { q, q1, insert, run } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, addMonths, monthKey } from '../../lib/dates.ts';
import type { Ctx } from '../../lib/auth.ts';
import { assertPerm } from '../../lib/auth.ts';
import { emit } from '../../lib/events.ts';
import { audit } from '../../lib/audit.ts';
import { registerJob } from '../../lib/jobs.ts';
import { postBothBases, accountBalance, isPeriodClosed } from './service.ts';
import { ensureAccount } from './coa.ts';

/** M9.9 — replacement reserves (accountant-feedback build).
 *
 * Reserve cash is a designated GL bucket (1030 Replacement Reserves — Cash),
 * not a second bank-fed account: funding and draws are 1010↔1030 transfers
 * posted on both bases, so the operating bank feed mirrors them as JE txns
 * and reconciliation still ties to zero. Draws are approval-gated
 * (reserves:approve); the capital spend itself still flows through
 * AP/projects like any other invoice. */

export const RESERVE_GL = '1030';

export interface ReservePlanInput {
  propertyId: string;
  monthlyCents: number;
  targetCents?: number | null;
  startPeriod?: string; // YYYY-MM; defaults to the current month
}

export function upsertReservePlan(ctx: Ctx, input: ReservePlanInput): string {
  assertPerm(ctx, 'reserves:manage');
  if (!Number.isInteger(input.monthlyCents) || input.monthlyCents <= 0) throw new Error('monthly funding must be a positive amount');
  ensureAccount(ctx.orgId, RESERVE_GL);
  const start = input.startPeriod || monthKey(ctx.businessDate);
  const existing = q1<any>('SELECT id FROM reserve_plans WHERE org_id=? AND property_id=?', ctx.orgId, input.propertyId);
  if (existing) {
    run('UPDATE reserve_plans SET monthly_cents=?, target_cents=?, active=1 WHERE id=?', input.monthlyCents, input.targetCents ?? null, existing.id);
    audit(ctx, 'reserve_plan', existing.id as string, 'update', null, { monthlyCents: input.monthlyCents, targetCents: input.targetCents ?? null });
    return existing.id as string;
  }
  const pid = id('rsp');
  insert('reserve_plans', {
    id: pid, org_id: ctx.orgId, property_id: input.propertyId, monthly_cents: input.monthlyCents,
    target_cents: input.targetCents ?? null, start_period: start, active: 1,
    created_by: ctx.userId || null, created_at: nowIso(),
  });
  emit(ctx, 'reserve.plan_created', 'reserve_plan', pid, { monthlyCents: input.monthlyCents });
  audit(ctx, 'reserve_plan', pid, 'create', null, { monthlyCents: input.monthlyCents, targetCents: input.targetCents ?? null, startPeriod: start });
  return pid;
}

export function setReservePlanActive(ctx: Ctx, planId: string, active: boolean): void {
  assertPerm(ctx, 'reserves:manage');
  const plan = q1<any>('SELECT id FROM reserve_plans WHERE id=? AND org_id=?', planId, ctx.orgId);
  if (!plan) throw new Error('reserve plan not found');
  run('UPDATE reserve_plans SET active=? WHERE id=?', active ? 1 : 0, planId);
  audit(ctx, 'reserve_plan', planId, active ? 'activate' : 'pause');
}

export function reserveBalance(ctx: Ctx, propertyId: string | null, asOf?: string): number {
  return accountBalance(ctx, RESERVE_GL, { propertyId, basis: 'accrual', asOf: asOf || ctx.businessDate });
}

export type FundResult = 'funded' | 'exists' | 'closed' | 'capped' | 'inactive';

/** Post one period's funding transfer. Idempotent per (plan, period); respects
 * the target cap; skips (never fails) when the period is already closed. */
export function fundReservePeriod(ctx: Ctx, planId: string, periodKey: string): FundResult {
  const plan = q1<any>('SELECT * FROM reserve_plans WHERE id=? AND org_id=?', planId, ctx.orgId);
  if (!plan) throw new Error('reserve plan not found');
  if (!plan.active) return 'inactive';
  const sourceId = `${planId}:${periodKey}`;
  if (q1(`SELECT id FROM journal_entries WHERE org_id=? AND source_kind='reserve_funding' AND source_id=? LIMIT 1`, ctx.orgId, sourceId)) return 'exists';
  if (isPeriodClosed(ctx.orgId, plan.property_id, periodKey)) return 'closed';
  let amount = plan.monthly_cents as number;
  if (plan.target_cents != null) {
    const bal = reserveBalance(ctx, plan.property_id);
    if (bal >= plan.target_cents) return 'capped';
    amount = Math.min(amount, (plan.target_cents as number) - bal);
  }
  ensureAccount(ctx.orgId, RESERVE_GL);
  postBothBases(ctx, {
    propertyId: plan.property_id, date: `${periodKey}-01`,
    memo: `Replacement reserve funding — ${periodKey}`,
    sourceKind: 'reserve_funding', sourceId,
    lines: [
      { account: RESERVE_GL, debit: amount, memo: 'monthly reserve funding' },
      { account: '1010', credit: amount, memo: 'transfer from operating' },
    ],
  });
  emit(ctx, 'reserve.funded', 'reserve_plan', planId, { periodKey, amountCents: amount });
  return 'funded';
}

/** Fund every open month from each active plan's start period through `through`. */
export function fundDueReserves(ctx: Ctx, through: string): number {
  let funded = 0;
  const last = monthKey(through);
  for (const plan of q<any>('SELECT * FROM reserve_plans WHERE org_id=? AND active=1', ctx.orgId)) {
    let pk = plan.start_period as string;
    while (pk <= last) {
      if (fundReservePeriod(ctx, plan.id, pk) === 'funded') funded++;
      pk = monthKey(addMonths(`${pk}-01`, 1));
    }
  }
  return funded;
}

export function requestReserveDraw(ctx: Ctx, input: { propertyId: string; amountCents: number; purpose: string }): string {
  assertPerm(ctx, 'reserves:manage');
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new Error('draw amount must be positive');
  if (!input.purpose.trim()) throw new Error('a draw needs a stated purpose');
  const bal = reserveBalance(ctx, input.propertyId);
  if (input.amountCents > bal) throw new Error('draw exceeds the current reserve balance');
  const did = id('rsd');
  insert('reserve_draws', {
    id: did, org_id: ctx.orgId, property_id: input.propertyId, amount_cents: input.amountCents,
    purpose: input.purpose.trim().slice(0, 200), status: 'pending_approval',
    requested_by: ctx.userName || null, decided_by: null, decided_at: null,
    je_accrual_id: null, je_cash_id: null, created_at: nowIso(),
  });
  emit(ctx, 'reserve.draw_requested', 'reserve_draw', did, { amountCents: input.amountCents });
  audit(ctx, 'reserve_draw', did, 'request', null, { amountCents: input.amountCents, purpose: input.purpose });
  return did;
}

export function decideReserveDraw(ctx: Ctx, drawId: string, approve: boolean): void {
  assertPerm(ctx, 'reserves:approve');
  const d = q1<any>('SELECT * FROM reserve_draws WHERE id=? AND org_id=?', drawId, ctx.orgId);
  if (!d) throw new Error('draw not found');
  if (d.status !== 'pending_approval') throw new Error('draw already decided');
  if (!approve) {
    run(`UPDATE reserve_draws SET status='denied', decided_by=?, decided_at=? WHERE id=?`, ctx.userName || null, nowIso(), drawId);
    emit(ctx, 'reserve.draw_denied', 'reserve_draw', drawId, {});
    audit(ctx, 'reserve_draw', drawId, 'deny');
    return;
  }
  const bal = reserveBalance(ctx, d.property_id);
  if (d.amount_cents > bal) throw new Error('draw exceeds the current reserve balance');
  const jes = postBothBases(ctx, {
    propertyId: d.property_id, date: ctx.businessDate,
    memo: `Reserve draw — ${d.purpose}`,
    sourceKind: 'reserve_draw', sourceId: drawId,
    lines: [
      { account: '1010', debit: d.amount_cents, memo: 'transfer to operating' },
      { account: RESERVE_GL, credit: d.amount_cents, memo: 'reserve draw' },
    ],
  });
  run(
    `UPDATE reserve_draws SET status='approved', decided_by=?, decided_at=?, je_accrual_id=?, je_cash_id=? WHERE id=?`,
    ctx.userName || null, nowIso(), jes.accrual, jes.cash, drawId,
  );
  emit(ctx, 'reserve.draw_approved', 'reserve_draw', drawId, { amountCents: d.amount_cents });
  audit(ctx, 'reserve_draw', drawId, 'approve', null, { amountCents: d.amount_cents });
}

export interface ReserveRow { property: any; plan: any | null; balance: number; pendingDraws: number; lastFunded: string | null }

export function reserveOverview(ctx: Ctx, props: any[]): ReserveRow[] {
  return props.map((p) => {
    const plan = q1<any>('SELECT * FROM reserve_plans WHERE org_id=? AND property_id=?', ctx.orgId, p.id) || null;
    const lastFunded = plan
      ? (q1<any>(
          `SELECT MAX(substr(source_id, length(?)+2)) AS pk FROM journal_entries
           WHERE org_id=? AND source_kind='reserve_funding' AND source_id LIKE ?`,
          plan.id, ctx.orgId, `${plan.id}:%`,
        )?.pk as string | null) || null
      : null;
    return {
      property: p,
      plan,
      balance: reserveBalance(ctx, p.id),
      pendingDraws: q<any>(`SELECT id FROM reserve_draws WHERE org_id=? AND property_id=? AND status='pending_approval'`, ctx.orgId, p.id).length,
      lastFunded,
    };
  });
}

registerJob({
  key: 'reserve_funding',
  name: 'Reserve funding',
  describe: 'Posts the monthly replacement-reserve transfer for every property with an active reserve plan (idempotent per month; skips closed periods).',
  run: (ctx, date) => {
    const n = fundDueReserves(ctx, date);
    return n ? `${n} reserve funding transfers posted` : 'reserves up to date';
  },
});
