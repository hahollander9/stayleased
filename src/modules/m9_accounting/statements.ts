import { q } from '../../lib/db.ts';
import { addMonths, monthKey, lastOfMonth, firstOfMonth } from '../../lib/dates.ts';
import type { Ctx } from '../../lib/auth.ts';
import { COA } from './coa.ts';

/** M9.9 — financial statements (per §10): balance sheet, income statement
 * (period + trailing 12), cash flow; per property or consolidated; cash &
 * accrual. All figures derive from journal lines — nothing is memoized. */

export type Basis = 'accrual' | 'cash';

const TYPE: Record<string, string> = Object.fromEntries(COA.map(([code, , type]) => [code, type]));
const NAME: Record<string, string> = Object.fromEntries(COA.map(([code, name]) => [code, name]));

export interface StatementLine {
  code: string;
  name: string;
  amount: number; // natural sign (assets/expenses debit-positive; liab/equity/income credit-positive)
}

function balances(
  ctx: Ctx,
  opts: { propertyId?: string | null; basis: Basis; from?: string; to?: string },
): Map<string, number> {
  const params: unknown[] = [ctx.orgId, opts.basis];
  let where = 'jl.org_id=? AND je.basis=?';
  if (opts.propertyId) { where += ' AND jl.property_id=?'; params.push(opts.propertyId); }
  if (opts.from) { where += ' AND je.date>=?'; params.push(opts.from); }
  if (opts.to) { where += ' AND je.date<=?'; params.push(opts.to); }
  const rows = q<any>(
    `SELECT jl.account_code AS code, SUM(jl.debit_cents - jl.credit_cents) AS net
     FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE ${where} GROUP BY jl.account_code`,
    ...params,
  );
  return new Map(rows.map((r) => [r.code as string, Number(r.net)]));
}

function naturalize(code: string, net: number): number {
  const t = TYPE[code] || 'asset';
  return t === 'asset' || t === 'expense' ? net : -net;
}

// ---------- balance sheet ----------

export interface BalanceSheet {
  asOf: string;
  basis: Basis;
  assets: StatementLine[];
  liabilities: StatementLine[];
  equity: StatementLine[];
  totals: { assets: number; liabilities: number; equity: number };
  balanced: boolean;
}

export function balanceSheet(ctx: Ctx, opts: { propertyId?: string | null; asOf: string; basis: Basis }): BalanceSheet {
  const b = balances(ctx, { propertyId: opts.propertyId, basis: opts.basis, to: opts.asOf });
  const fyStart = `${opts.asOf.slice(0, 4)}-01-01`;
  const mk = (codes: string[]): StatementLine[] =>
    codes
      .map((code) => ({ code, name: NAME[code] || code, amount: naturalize(code, b.get(code) || 0) }))
      .filter((l) => l.amount !== 0);

  const assets = mk(COA.filter(([, , t]) => t === 'asset').map(([c]) => c));
  const liabilities = mk(COA.filter(([, , t]) => t === 'liability').map(([c]) => c));
  const equity = mk(COA.filter(([, , t]) => t === 'equity').map(([c]) => c));

  // earnings roll-forward: prior years → retained earnings; current FY → net income line
  let prior = 0;
  let currentFy = 0;
  const pnlCodes = new Set(COA.filter(([, , t]) => t === 'income' || t === 'expense').map(([c]) => c));
  const bPrior = balances(ctx, { propertyId: opts.propertyId, basis: opts.basis, to: `${Number(opts.asOf.slice(0, 4)) - 1}-12-31` });
  for (const code of pnlCodes) {
    prior += -(bPrior.get(code) || 0); // income credit-positive minus expenses
  }
  const bFy = balances(ctx, { propertyId: opts.propertyId, basis: opts.basis, from: fyStart, to: opts.asOf });
  for (const code of pnlCodes) currentFy += -(bFy.get(code) || 0);
  if (prior !== 0) equity.push({ code: '3900', name: 'Retained Earnings — Prior Years', amount: prior });
  if (currentFy !== 0) equity.push({ code: '3950', name: `Net Income — FY${opts.asOf.slice(0, 4)}`, amount: currentFy });

  const totals = {
    assets: assets.reduce((s, l) => s + l.amount, 0),
    liabilities: liabilities.reduce((s, l) => s + l.amount, 0),
    equity: equity.reduce((s, l) => s + l.amount, 0),
  };
  return { asOf: opts.asOf, basis: opts.basis, assets, liabilities, equity, totals, balanced: totals.assets === totals.liabilities + totals.equity };
}

// ---------- income statement ----------

export interface IncomeStatement {
  from: string;
  to: string;
  basis: Basis;
  income: StatementLine[];
  expenses: StatementLine[];
  totalIncome: number;
  totalExpenses: number;
  noi: number;
}

export function incomeStatement(ctx: Ctx, opts: { propertyId?: string | null; from: string; to: string; basis: Basis }): IncomeStatement {
  const b = balances(ctx, { propertyId: opts.propertyId, basis: opts.basis, from: opts.from, to: opts.to });
  const mk = (t: string): StatementLine[] =>
    COA.filter(([, , type]) => type === t)
      .map(([code]) => ({ code, name: NAME[code] || code, amount: naturalize(code, b.get(code) || 0) }))
      .filter((l) => l.amount !== 0);
  const income = mk('income');
  const expenses = mk('expense');
  const totalIncome = income.reduce((s, l) => s + l.amount, 0);
  const totalExpenses = expenses.reduce((s, l) => s + l.amount, 0);
  return { from: opts.from, to: opts.to, basis: opts.basis, income, expenses, totalIncome, totalExpenses, noi: totalIncome - totalExpenses };
}

/** trailing-12 matrix: rows = accounts, columns = last 12 months ending at `to` */
export interface T12 {
  months: string[]; // YYYY-MM ascending
  rows: { code: string; name: string; type: string; cells: number[]; total: number }[];
  totals: { income: number[]; expenses: number[]; noi: number[] };
}

export function t12(ctx: Ctx, opts: { propertyId?: string | null; to: string; basis: Basis }): T12 {
  const months: string[] = [];
  for (let i = 11; i >= 0; i--) months.push(monthKey(addMonths(opts.to, -i)));
  const params: unknown[] = [ctx.orgId, opts.basis, `${months[0]}-01`, lastOfMonth(`${months[11]}-15`)];
  let where = `jl.org_id=? AND je.basis=? AND je.date>=? AND je.date<=?`;
  if (opts.propertyId) { where += ' AND jl.property_id=?'; params.push(opts.propertyId); }
  const rows = q<any>(
    `SELECT jl.account_code AS code, substr(je.date,1,7) AS mk, SUM(jl.debit_cents - jl.credit_cents) AS net
     FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE ${where}
     GROUP BY jl.account_code, mk`,
    ...params,
  );
  const byAcct = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!byAcct.has(r.code)) byAcct.set(r.code, new Map());
    byAcct.get(r.code)!.set(r.mk, Number(r.net));
  }
  const out: T12['rows'] = [];
  for (const [code, name, type] of COA) {
    if (type !== 'income' && type !== 'expense') continue;
    const m = byAcct.get(code);
    if (!m) continue;
    const cells = months.map((mk) => naturalize(code, m.get(mk) || 0));
    const total = cells.reduce((s, c) => s + c, 0);
    if (total !== 0 || cells.some((c) => c !== 0)) out.push({ code, name, type, cells, total });
  }
  const incomeCells = months.map((_, i) => out.filter((r) => r.type === 'income').reduce((s, r) => s + r.cells[i]!, 0));
  const expenseCells = months.map((_, i) => out.filter((r) => r.type === 'expense').reduce((s, r) => s + r.cells[i]!, 0));
  return {
    months,
    rows: out,
    totals: { income: incomeCells, expenses: expenseCells, noi: months.map((_, i) => incomeCells[i]! - expenseCells[i]!) },
  };
}

// ---------- cash flow (direct method from the cash accounts) ----------

export interface CashFlow {
  from: string;
  to: string;
  basis: Basis;
  operating: StatementLine[];
  investing: StatementLine[];
  financing: StatementLine[];
  netChange: number;
  opening: number;
  closing: number;
}

const CASH_CODES = new Set(['1010', '1020']);

export function cashFlow(ctx: Ctx, opts: { propertyId?: string | null; from: string; to: string; basis: Basis }): CashFlow {
  // classify each JE touching cash by its counter-account mix
  const params: unknown[] = [ctx.orgId, opts.basis, opts.from, opts.to];
  let where = `je.org_id=? AND je.basis=? AND je.date>=? AND je.date<=?`;
  if (opts.propertyId) { where += ' AND je.property_id=?'; params.push(opts.propertyId); }
  const lines = q<any>(
    `SELECT jl.entry_id, jl.account_code, jl.debit_cents, jl.credit_cents
     FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
     WHERE ${where} AND jl.entry_id IN (
       SELECT jl2.entry_id FROM journal_lines jl2 JOIN journal_entries je2 ON je2.id=jl2.entry_id
       WHERE ${where.replace(/je\./g, 'je2.').replace(/jl\./g, 'jl2.')} AND jl2.account_code IN ('1010','1020')
     )`,
    ...params, ...params,
  );
  const byEntry = new Map<string, any[]>();
  for (const l of lines) byEntry.set(l.entry_id, [...(byEntry.get(l.entry_id) || []), l]);

  const buckets: Record<'operating' | 'investing' | 'financing', Map<string, number>> = {
    operating: new Map(), investing: new Map(), financing: new Map(),
  };
  let netChange = 0;
  for (const [, ls] of byEntry) {
    const cashNet = ls.filter((l) => CASH_CODES.has(l.account_code)).reduce((s, l) => s + l.debit_cents - l.credit_cents, 0);
    if (cashNet === 0) continue;
    netChange += cashNet;
    // attribute to the largest counter account
    const counters = ls.filter((l) => !CASH_CODES.has(l.account_code));
    const main = counters.sort((a, b) => Math.abs(b.debit_cents - b.credit_cents) - Math.abs(a.debit_cents - a.credit_cents))[0];
    const code = main?.account_code || '4080';
    const t = TYPE[code] || 'income';
    const bucket = code === '1500' ? 'investing' : t === 'equity' ? 'financing' : 'operating';
    buckets[bucket].set(code, (buckets[bucket].get(code) || 0) + cashNet);
  }
  const mk = (m: Map<string, number>): StatementLine[] =>
    [...m.entries()]
      .map(([code, amount]) => ({ code, name: NAME[code] || `Account ${code}`, amount }))
      .filter((l) => l.amount !== 0)
      .sort((a, b) => a.code.localeCompare(b.code));

  const openingParams: unknown[] = [ctx.orgId, opts.basis, opts.from];
  let ow = `jl.org_id=? AND je.basis=? AND je.date<? AND jl.account_code IN ('1010','1020')`;
  if (opts.propertyId) { ow += ' AND jl.property_id=?'; openingParams.push(opts.propertyId); }
  const opening = Number(q<any>(
    `SELECT COALESCE(SUM(jl.debit_cents - jl.credit_cents),0) AS n FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE ${ow}`,
    ...openingParams,
  )[0]?.n || 0);
  return {
    from: opts.from, to: opts.to, basis: opts.basis,
    operating: mk(buckets.operating), investing: mk(buckets.investing), financing: mk(buckets.financing),
    netChange, opening, closing: opening + netChange,
  };
}

// ---------- CSV helpers ----------

export function toCsv(rows: (string | number)[][]): string {
  return rows.map((r) => r.map((c) => (typeof c === 'string' && /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : String(c))).join(',')).join('\n');
}
