import { q, q1, insert, run, val, tx, j, js } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso } from '../../lib/dates.ts';
import type { Ctx } from '../../lib/auth.ts';
import { audit } from '../../lib/audit.ts';
import { emit } from '../../lib/events.ts';
import { COA } from './coa.ts';

/** M9.7 — budgeting: annual per-property per-GL budgets with monthly spread
 * curves, draft→approved versioning, budget-vs-actual with variance flags,
 * and next-year seeding from actuals ± %. */

export type SpreadCurve = 'even' | 'seasonal_summer' | 'seasonal_winter' | 'front' | 'back';

/** split an annual amount into 12 monthly cents that sum exactly */
export function spread(annualCents: number, curve: SpreadCurve): number[] {
  const weights: Record<SpreadCurve, number[]> = {
    even: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    seasonal_summer: [0.7, 0.7, 0.8, 0.9, 1.1, 1.3, 1.4, 1.4, 1.2, 1.0, 0.8, 0.7],
    seasonal_winter: [1.4, 1.3, 1.1, 0.9, 0.7, 0.6, 0.6, 0.7, 0.9, 1.1, 1.3, 1.4],
    front: [1.6, 1.5, 1.4, 1.2, 1.0, 0.9, 0.8, 0.8, 0.7, 0.7, 0.7, 0.7],
    back: [0.7, 0.7, 0.7, 0.7, 0.8, 0.8, 0.9, 1.0, 1.2, 1.4, 1.5, 1.6],
  };
  const w = weights[curve];
  const total = w.reduce((s, x) => s + x, 0);
  const months = w.map((x) => Math.round((annualCents * x) / total / 100) * 100);
  const diff = annualCents - months.reduce((s, x) => s + x, 0);
  months[11] = months[11]! + diff; // keep the exact annual total
  return months;
}

export function createBudget(ctx: Ctx, propertyId: string, year: number): string {
  const version = (val<number>('SELECT COALESCE(MAX(version),0) FROM budgets WHERE org_id=? AND property_id=? AND year=?', ctx.orgId, propertyId, year) || 0) + 1;
  const bid = id('bud');
  insert('budgets', {
    id: bid, org_id: ctx.orgId, property_id: propertyId, year, version,
    status: 'draft', created_at: nowIso(),
  });
  audit(ctx, 'budget', bid, 'create', null, { propertyId, year, version });
  return bid;
}

export function setBudgetLine(ctx: Ctx, budgetId: string, glAccount: string, months: number[], note?: string): void {
  const b = q1<any>('SELECT * FROM budgets WHERE id=? AND org_id=?', budgetId, ctx.orgId);
  if (!b) throw new Error('budget not found');
  if (b.status === 'approved') throw new Error('approved budgets are immutable — create a new version');
  if (months.length !== 12 || months.some((m) => !Number.isInteger(m))) throw new Error('12 integer month values required');
  const existing = q1<any>('SELECT id FROM budget_lines WHERE budget_id=? AND gl_account=?', budgetId, glAccount);
  if (existing) run('UPDATE budget_lines SET months=?, note=? WHERE id=?', js(months), note || null, existing.id);
  else insert('budget_lines', { id: id('bl'), org_id: ctx.orgId, budget_id: budgetId, gl_account: glAccount, months: js(months), note: note || null });
}

export function approveBudget(ctx: Ctx, budgetId: string): void {
  const b = q1<any>('SELECT * FROM budgets WHERE id=? AND org_id=?', budgetId, ctx.orgId);
  if (!b || b.status !== 'draft') throw new Error('budget not in draft');
  run(`UPDATE budgets SET status='approved', approved_by=?, approved_at=? WHERE id=?`, ctx.userName, nowIso(), budgetId);
  emit(ctx, 'budget.approved', 'budget', budgetId, { propertyId: b.property_id, year: b.year });
  audit(ctx, 'budget', budgetId, 'approve');
}

/** actuals per account per month for a property + year (accrual) */
export function actualsMatrix(ctx: Ctx, propertyId: string, year: number): Map<string, number[]> {
  const rows = q<any>(
    `SELECT jl.account_code AS code, CAST(substr(je.date,6,2) AS INTEGER) AS m,
            SUM(jl.debit_cents - jl.credit_cents) AS net
     FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
     WHERE jl.org_id=? AND jl.property_id=? AND je.basis='accrual' AND substr(je.date,1,4)=?
     GROUP BY code, m`,
    ctx.orgId, propertyId, String(year),
  );
  const types: Record<string, string> = Object.fromEntries(COA.map(([c, , t]) => [c, t]));
  const out = new Map<string, number[]>();
  for (const r of rows) {
    if (!out.has(r.code)) out.set(r.code, Array(12).fill(0));
    const t = types[r.code];
    const natural = t === 'asset' || t === 'expense' ? Number(r.net) : -Number(r.net);
    out.get(r.code)![r.m - 1] = natural;
  }
  return out;
}

export interface BvaRow {
  code: string;
  name: string;
  type: string;
  budget: number[];
  actual: number[];
  varianceCents: number; // actual - budget, YTD
  variancePct: number | null;
  flag: 'over' | 'under' | 'ok';
}

/** budget vs actual through `throughMonth` (1-12); expenses over budget and
 * income under budget get flagged past the threshold. */
export function budgetVsActual(ctx: Ctx, budgetId: string, throughMonth: number, thresholdPct = 10): { rows: BvaRow[]; budget: any } {
  const b = q1<any>('SELECT * FROM budgets WHERE id=? AND org_id=?', budgetId, ctx.orgId);
  if (!b) throw new Error('budget not found');
  const lines = q<any>('SELECT * FROM budget_lines WHERE budget_id=? ORDER BY gl_account', budgetId);
  const actuals = actualsMatrix(ctx, b.property_id, b.year);
  const names: Record<string, string> = Object.fromEntries(COA.map(([c, n]) => [c, n]));
  const types: Record<string, string> = Object.fromEntries(COA.map(([c, , t]) => [c, t]));
  const rows: BvaRow[] = [];
  for (const l of lines) {
    const budget = j<number[]>(l.months, Array(12).fill(0));
    const actual = actuals.get(l.gl_account) || Array(12).fill(0);
    const bYtd = budget.slice(0, throughMonth).reduce((s, x) => s + x, 0);
    const aYtd = actual.slice(0, throughMonth).reduce((s, x) => s + x, 0);
    const varianceCents = aYtd - bYtd;
    const variancePct = bYtd !== 0 ? Math.round((varianceCents / Math.abs(bYtd)) * 1000) / 10 : null;
    const type = types[l.gl_account] || 'expense';
    let flag: BvaRow['flag'] = 'ok';
    if (variancePct !== null && Math.abs(variancePct) >= thresholdPct) {
      if (type === 'expense') flag = varianceCents > 0 ? 'over' : 'under';
      else flag = varianceCents < 0 ? 'under' : 'over';
    }
    rows.push({ code: l.gl_account, name: names[l.gl_account] || l.gl_account, type, budget, actual, varianceCents, variancePct, flag });
  }
  return { rows, budget: b };
}

/** M9.7 — seed a draft budget from another year's actuals ± pct */
export function seedFromActuals(ctx: Ctx, propertyId: string, fromYear: number, toYear: number, pctChange: number): string {
  const actuals = actualsMatrix(ctx, propertyId, fromYear);
  const budgetId = createBudget(ctx, propertyId, toYear);
  tx(() => {
    for (const [code, , type] of COA) {
      if (type !== 'income' && type !== 'expense') continue;
      const a = actuals.get(code);
      if (!a || a.every((x) => x === 0)) continue;
      const months = a.map((x) => Math.round((x * (1 + pctChange / 100)) / 100) * 100);
      setBudgetLine(ctx, budgetId, code, months, `seeded from FY${fromYear} actuals ${pctChange >= 0 ? '+' : ''}${pctChange}%`);
    }
  });
  audit(ctx, 'budget', budgetId, 'seed_from_actuals', null, { fromYear, pctChange });
  return budgetId;
}
