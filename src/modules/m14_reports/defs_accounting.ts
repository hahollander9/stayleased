import { q, q1, val, j } from '../../lib/db.ts';
import { addMonths, monthKey, fmtMonth } from '../../lib/dates.ts';
import { registerReport, propScope, type ReportResult, type ReportCol } from './engine.ts';
import { balanceSheet, incomeStatement, t12, cashFlow } from '../m9_accounting/statements.ts';
import { closeChecklist } from '../m9_accounting/close.ts';
import { budgetVsActual } from '../m9_accounting/budgets.ts';
import { ten99Summary, projectCommitments } from '../m16_procurement/service.ts';
import { COA } from '../m9_accounting/coa.ts';

/** §10 Accounting: Trial Balance, Balance Sheet, Income Statement (period +
 * T-12, cash & accrual), GL Detail, Cash Flow, Budget vs Actual, AP Aging,
 * Vendor Payment Register, 1099 Summary, Bank Rec Summary, Job Cost,
 * Month-End Close Status. */

const PROP = { key: 'property', kind: 'property' as const };
const BASIS = { key: 'basis', kind: 'basis' as const };

registerReport({
  key: 'trial_balance',
  name: 'Trial Balance',
  category: 'Accounting',
  describe: 'Every account with debit/credit balance — always sums to zero.',
  params: [{ ...PROP, allowAll: true }, { key: 'date', kind: 'date' }, BASIS],
  perm: 'gl:view',
  run(ctx, p): ReportResult {
    const params: unknown[] = [ctx.orgId, p.basis, p.date];
    let where = `jl.org_id=? AND je.basis=? AND je.date <= ?`;
    if (p.property !== 'all') { where += ' AND jl.property_id=?'; params.push(p.property); }
    const nets = new Map<string, number>(q<any>(
      `SELECT jl.account_code AS code, SUM(jl.debit_cents - jl.credit_cents) AS net
       FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE ${where} GROUP BY code`,
      ...params,
    ).map((r) => [r.code as string, Number(r.net)]));
    const rows = COA.filter(([code]) => nets.get(code)).map(([code, name, type]) => {
      const net = nets.get(code) || 0;
      return {
        code, account: name, type,
        debit: net > 0 ? net : 0,
        credit: net < 0 ? -net : 0,
        __href: `/gl?account=${code}`,
      };
    });
    return {
      cols: [
        { key: 'code', label: 'Code' },
        { key: 'account', label: 'Account' },
        { key: 'type', label: 'Type', kind: 'badge' },
        { key: 'debit', label: 'Debit', kind: 'money', total: true },
        { key: 'credit', label: 'Credit', kind: 'money', total: true },
      ],
      rows,
      note: `Through ${p.date}, ${p.basis} basis. Debits equal credits by construction — the §9 invariants test this continuously.`,
    };
  },
});

registerReport({
  key: 'balance_sheet',
  name: 'Balance Sheet',
  category: 'Accounting',
  describe: 'Assets, liabilities and equity with earnings roll-forward — both bases.',
  params: [{ ...PROP, allowAll: true }, { key: 'date', kind: 'date' }, BASIS],
  perm: 'gl:view',
  defaultGroup: 'section',
  run(ctx, p): ReportResult {
    const bs = balanceSheet(ctx, { propertyId: p.property === 'all' ? null : p.property, asOf: p.date!, basis: p.basis as any });
    const rows = [
      ...bs.assets.map((l) => ({ section: 'Assets', code: l.code, account: l.name, amount: l.amount, __href: `/gl?account=${l.code}` })),
      ...bs.liabilities.map((l) => ({ section: 'Liabilities', code: l.code, account: l.name, amount: l.amount, __href: `/gl?account=${l.code}` })),
      ...bs.equity.map((l) => ({ section: 'Equity', code: l.code, account: l.name, amount: l.amount })),
    ];
    return {
      cols: [
        { key: 'section', label: 'Section' },
        { key: 'code', label: 'Code' },
        { key: 'account', label: 'Account' },
        { key: 'amount', label: 'Balance', kind: 'money', total: true },
      ],
      rows,
      note: `As of ${p.date} (${p.basis}). Assets ${fmtM(bs.totals.assets)} = Liabilities ${fmtM(bs.totals.liabilities)} + Equity ${fmtM(bs.totals.equity)} — ${bs.balanced ? 'BALANCED ✓' : 'OUT OF BALANCE ✗'}.`,
    };
  },
});

function fmtM(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

registerReport({
  key: 'income_statement',
  name: 'Income Statement',
  category: 'Accounting',
  describe: 'Period P&L or the trailing-12 matrix, cash or accrual.',
  params: [
    { ...PROP, allowAll: true },
    { key: 'view', kind: 'select', label: 'View', options: [['period', 'Period'], ['t12', 'Trailing 12']] },
    { key: 'from', kind: 'from', default: (ctx) => `${monthKey(ctx.businessDate)}-01` },
    { key: 'to', kind: 'to' },
    BASIS,
  ],
  perm: 'gl:view',
  run(ctx, p): ReportResult {
    const propId = p.property === 'all' ? null : p.property;
    if (p.view === 't12') {
      const m = t12(ctx, { propertyId: propId, to: p.to!, basis: p.basis as any });
      const cols: ReportCol[] = [
        { key: 'account', label: 'Account' },
        ...m.months.map((mk) => ({ key: mk, label: fmtMonth(mk).slice(0, 3), kind: 'money' as const })),
        { key: 'total', label: 'T-12', kind: 'money', total: true },
      ];
      const rows = m.rows.map((r) => {
        const row: Record<string, unknown> = { account: `${r.code} ${r.name}`, total: r.total, __href: `/gl?account=${r.code}` };
        m.months.forEach((mk, i) => { row[mk] = r.cells[i]; });
        return row;
      });
      const noi: Record<string, unknown> = { account: 'NOI', total: m.totals.noi.reduce((s, x) => s + x, 0) };
      m.months.forEach((mk, i) => { noi[mk] = m.totals.noi[i]; });
      rows.push(noi);
      return { cols, rows, note: `Trailing 12 through ${fmtMonth(m.months[11]!)} (${p.basis}). NOI row = income − expenses.` };
    }
    const is = incomeStatement(ctx, { propertyId: propId, from: p.from!, to: p.to!, basis: p.basis as any });
    const rows = [
      ...is.income.map((l) => ({ section: 'Income', code: l.code, account: l.name, amount: l.amount, __href: `/gl?account=${l.code}` })),
      ...is.expenses.map((l) => ({ section: 'Expenses', code: l.code, account: l.name, amount: l.amount, __href: `/gl?account=${l.code}` })),
    ];
    return {
      cols: [
        { key: 'section', label: 'Section' },
        { key: 'code', label: 'Code' },
        { key: 'account', label: 'Account' },
        { key: 'amount', label: 'Amount', kind: 'money', total: true },
      ],
      rows,
      note: `${p.from} → ${p.to} (${p.basis}). Income ${fmtM(is.totalIncome)} − Expenses ${fmtM(is.totalExpenses)} = NOI ${fmtM(is.noi)}.`,
    };
  },
});

registerReport({
  key: 'gl_detail',
  name: 'General Ledger Detail',
  category: 'Accounting',
  describe: 'Every journal line for an account and range, with running balance.',
  params: [
    { ...PROP, allowAll: true },
    { key: 'account', kind: 'select', label: 'Account', options: COA.map(([c, n]) => [c, `${c} ${n}`] as [string, string]), default: () => '1100' },
    { key: 'from', kind: 'from', default: (ctx) => addMonths(ctx.businessDate, -1) },
    { key: 'to', kind: 'to' },
    BASIS,
  ],
  perm: 'gl:view',
  run(ctx, p): ReportResult {
    const params: unknown[] = [ctx.orgId, p.basis, p.account, p.from, p.to];
    let where = `jl.org_id=? AND je.basis=? AND jl.account_code=? AND je.date BETWEEN ? AND ?`;
    if (p.property !== 'all') { where += ' AND jl.property_id=?'; params.push(p.property); }
    const lines = q<any>(
      `SELECT jl.*, je.date, je.memo AS je_memo, je.source_kind FROM journal_lines jl
       JOIN journal_entries je ON je.id=jl.entry_id WHERE ${where}
       ORDER BY je.date, je.posted_at LIMIT 2400`,
      ...params,
    );
    let running = 0;
    const rows = lines.map((l) => {
      running += l.debit_cents - l.credit_cents;
      return {
        date: l.date,
        memo: (l.memo || l.je_memo || '').slice(0, 70),
        source: l.source_kind,
        debit: l.debit_cents || null,
        credit: l.credit_cents || null,
        running,
        __href: `/gl/journal?entry=${l.entry_id}`,
      };
    });
    return {
      cols: [
        { key: 'date', label: 'Date', kind: 'date' },
        { key: 'memo', label: 'Memo' },
        { key: 'source', label: 'Source', kind: 'badge' },
        { key: 'debit', label: 'Debit', kind: 'money', total: true },
        { key: 'credit', label: 'Credit', kind: 'money', total: true },
        { key: 'running', label: 'Running (period)', kind: 'money' },
      ],
      rows,
      note: `Account ${p.account}, ${p.basis} basis. Running balance is within the selected period.`,
    };
  },
});

registerReport({
  key: 'cash_flow',
  name: 'Cash Flow',
  category: 'Accounting',
  describe: 'Direct-method cash movements by bucket.',
  params: [{ ...PROP, allowAll: true }, { key: 'from', kind: 'from', default: (ctx) => `${monthKey(ctx.businessDate)}-01` }, { key: 'to', kind: 'to' }, BASIS],
  perm: 'gl:view',
  run(ctx, p): ReportResult {
    const cf = cashFlow(ctx, { propertyId: p.property === 'all' ? null : p.property, from: p.from!, to: p.to!, basis: p.basis as any });
    const rows = [
      ...cf.operating.map((l) => ({ activity: 'Operating', line: l.name, amount: l.amount })),
      ...cf.investing.map((l) => ({ activity: 'Investing', line: l.name, amount: l.amount })),
      ...cf.financing.map((l) => ({ activity: 'Financing', line: l.name, amount: l.amount })),
    ];
    return {
      cols: [
        { key: 'activity', label: 'Activity' },
        { key: 'line', label: 'Line' },
        { key: 'amount', label: 'Cash effect', kind: 'money', total: true },
      ],
      rows,
      note: `${p.from} → ${p.to}. Opening cash ${fmtM(cf.opening)} → closing ${fmtM(cf.closing)} (net ${fmtM(cf.netChange)}).`,
    };
  },
});

registerReport({
  key: 'budget_variance',
  name: 'Budget vs Actual with Variance Notes',
  category: 'Accounting',
  describe: 'YTD budget performance with over/under flags and line notes.',
  params: [PROP, { key: 'year', kind: 'year' }],
  perm: 'budgets:view',
  defaultSort: 'variance',
  defaultDir: 'desc',
  run(ctx, p): ReportResult {
    const budget = q1<any>(
      `SELECT * FROM budgets WHERE property_id=? AND year=? AND status='approved' ORDER BY version DESC LIMIT 1`,
      p.property, Number(p.year),
    );
    if (!budget) return { cols: [{ key: 'x', label: 'Status' }], rows: [{ x: `No approved FY${p.year} budget for this property.` }] };
    const through = monthKey(ctx.businessDate).startsWith(p.year!) ? Number(ctx.businessDate.slice(5, 7)) : 12;
    const { rows: bva } = budgetVsActual(ctx, budget.id, through);
    const rows = bva.map((r) => ({
      code: r.code,
      account: r.name,
      type: r.type,
      budget_ytd: r.budget.slice(0, through).reduce((s, x) => s + x, 0),
      actual_ytd: r.actual.slice(0, through).reduce((s, x) => s + x, 0),
      variance: r.varianceCents,
      variance_pct: r.variancePct,
      flag: r.flag,
      __href: `/budgets/${budget.id}?view=variance`,
    }));
    return {
      cols: [
        { key: 'code', label: 'Code' },
        { key: 'account', label: 'Account' },
        { key: 'type', label: 'Type', kind: 'badge' },
        { key: 'budget_ytd', label: 'Budget YTD', kind: 'money', total: true },
        { key: 'actual_ytd', label: 'Actual YTD', kind: 'money', total: true },
        { key: 'variance', label: 'Variance', kind: 'money', total: true },
        { key: 'variance_pct', label: 'Var %', kind: 'pct' },
        { key: 'flag', label: 'Flag', kind: 'badge' },
      ],
      rows,
      note: `FY${p.year} through month ${through}. Flags: expenses over / income under by 10%+.`,
    };
  },
});

registerReport({
  key: 'ap_aging',
  name: 'AP Aging',
  category: 'Accounting',
  describe: 'Unpaid vendor invoices bucketed by age, with approval state.',
  params: [{ ...PROP, allowAll: true }],
  perm: 'ap:view',
  defaultGroup: 'bucket',
  run(ctx, p): ReportResult {
    const { sql, params } = propScope(ctx, p.property!, 'vi.property_id');
    const rows = q<any>(
      `SELECT vi.*, v.name AS vendor FROM vendor_invoices vi JOIN vendors v ON v.id=vi.vendor_id
       WHERE vi.org_id=?${sql} AND vi.status IN ('draft','pending_approval','approved') ORDER BY vi.due_date`,
      ctx.orgId, ...params,
    ).map((vi) => {
      const age = Math.round((Date.parse(ctx.businessDate) - Date.parse(vi.due_date)) / 86400000);
      return {
        bucket: age <= 0 ? 'Current' : age <= 30 ? '1–30 past due' : age <= 60 ? '31–60' : '61+',
        vendor: vi.vendor,
        invoice: vi.invoice_number,
        invoice_date: vi.invoice_date,
        due: vi.due_date,
        status: vi.status,
        amount: vi.total_cents,
        __href: `/ap/${vi.id}`,
      };
    });
    return {
      cols: [
        { key: 'bucket', label: 'Bucket' },
        { key: 'vendor', label: 'Vendor' },
        { key: 'invoice', label: 'Invoice #' },
        { key: 'invoice_date', label: 'Invoice date', kind: 'date' },
        { key: 'due', label: 'Due', kind: 'date' },
        { key: 'status', label: 'Status', kind: 'badge' },
        { key: 'amount', label: 'Amount', kind: 'money', total: true },
      ],
      rows,
    };
  },
});

registerReport({
  key: 'vendor_payments',
  name: 'Vendor Payment Register',
  category: 'Accounting',
  describe: 'Every AP payment with method, check number and cleared status.',
  params: [{ ...PROP, allowAll: true }, { key: 'from', kind: 'from', default: (ctx) => addMonths(ctx.businessDate, -3) }, { key: 'to', kind: 'to' }],
  perm: 'ap:view',
  run(ctx, p): ReportResult {
    const { sql, params } = propScope(ctx, p.property!, 'ap.property_id');
    const rows = q<any>(
      `SELECT ap.*, v.name AS vendor, r.run_date, vi.invoice_number FROM ap_payments ap
       JOIN vendors v ON v.id=ap.vendor_id JOIN ap_payment_runs r ON r.id=ap.run_id
       LEFT JOIN vendor_invoices vi ON vi.id=ap.invoice_id
       WHERE ap.org_id=?${sql} AND r.run_date BETWEEN ? AND ? ORDER BY r.run_date DESC`,
      ctx.orgId, ...params, p.from, p.to,
    ).map((ap) => ({
      date: ap.run_date,
      vendor: ap.vendor,
      invoice: ap.invoice_number || '—',
      method: ap.method,
      check_no: ap.check_number || '—',
      status: ap.status,
      cleared: ap.cleared_date || '—',
      amount: ap.amount_cents,
      __href: `/ap/runs`,
    }));
    return {
      cols: [
        { key: 'date', label: 'Run date', kind: 'date' },
        { key: 'vendor', label: 'Vendor' },
        { key: 'invoice', label: 'Invoice #' },
        { key: 'method', label: 'Method' },
        { key: 'check_no', label: 'Check #' },
        { key: 'status', label: 'Status', kind: 'badge' },
        { key: 'cleared', label: 'Cleared' },
        { key: 'amount', label: 'Amount', kind: 'money', total: true },
      ],
      rows,
    };
  },
});

registerReport({
  key: 'ten99_summary',
  name: '1099 Summary',
  category: 'Accounting',
  describe: 'Reportable vendor payments for the tax year with W-9 exceptions.',
  params: [{ key: 'year', kind: 'year', default: (ctx) => String(Number(ctx.businessDate.slice(0, 4)) - 1) }],
  perm: 'ap:view',
  run(ctx, p): ReportResult {
    const s = ten99Summary(ctx, Number(p.year));
    const rows = s.rows.map((r) => ({
      vendor: r.vendor,
      tin: r.tin,
      w9: r.w9 ? 'on file' : 'MISSING',
      paid: r.paidCents,
      __href: '/purchasing/1099',
    }));
    return {
      cols: [
        { key: 'vendor', label: 'Vendor' },
        { key: 'tin', label: 'TIN' },
        { key: 'w9', label: 'W-9', kind: 'badge' },
        { key: 'paid', label: `Paid ${p.year}`, kind: 'money', total: true },
      ],
      rows,
      note: `1099-eligible vendors paid $600+ in ${p.year}. ${s.missingW9.length} missing W-9${s.missingW9.length === 1 ? '' : 's'}.`,
    };
  },
});

registerReport({
  key: 'bank_rec_summary',
  name: 'Bank Reconciliation Summary',
  category: 'Accounting',
  describe: 'Every account-month: statement balances, differences, completion.',
  params: [{ ...PROP, allowAll: true }],
  perm: 'banking:view',
  defaultSort: 'period',
  defaultDir: 'desc',
  run(ctx, p): ReportResult {
    const { sql, params } = propScope(ctx, p.property!, 'ba.property_id');
    const rows = q<any>(
      `SELECT br.*, ba.name AS account, p2.name AS prop FROM bank_recons br
       JOIN bank_accounts ba ON ba.id=br.bank_account_id JOIN properties p2 ON p2.id=ba.property_id
       WHERE br.org_id=?${sql} ORDER BY br.period_key DESC, p2.name LIMIT 120`,
      ctx.orgId, ...params,
    ).map((br) => ({
      period: br.period_key,
      property: br.prop,
      account: br.account,
      open: br.statement_open_cents,
      close: br.statement_close_cents,
      difference: br.difference_cents,
      status: br.status,
      completed_by: br.completed_by || '—',
      __href: `/banking/${br.bank_account_id}/reconcile?month=${br.period_key}`,
    }));
    return {
      cols: [
        { key: 'period', label: 'Month', kind: 'month' },
        { key: 'property', label: 'Property' },
        { key: 'account', label: 'Account' },
        { key: 'open', label: 'Statement open', kind: 'money' },
        { key: 'close', label: 'Statement close', kind: 'money' },
        { key: 'difference', label: 'Difference', kind: 'money' },
        { key: 'status', label: 'Status', kind: 'badge' },
        { key: 'completed_by', label: 'By' },
      ],
      rows,
      note: 'Completed reconciliations enforce a $0.00 difference; open months show live drift.',
    };
  },
});

registerReport({
  key: 'job_cost',
  name: 'Job Cost Detail',
  category: 'Accounting',
  describe: 'Capital projects: budget vs committed (open POs) vs actual (coded AP).',
  params: [{ ...PROP, allowAll: true }],
  perm: 'budgets:view',
  run(ctx, p): ReportResult {
    const { sql, params } = propScope(ctx, p.property!, 'cp.property_id');
    const rows = q<any>(
      `SELECT cp.*, p2.name AS prop FROM capital_projects cp JOIN properties p2 ON p2.id=cp.property_id
       WHERE cp.org_id=?${sql} ORDER BY cp.created_at DESC`,
      ctx.orgId, ...params,
    ).map((cp) => {
      const actual = val<number>(
        `SELECT COALESCE(SUM(vil.amount_cents),0) FROM vendor_invoice_lines vil
         JOIN vendor_invoices vi ON vi.id=vil.invoice_id AND vi.status IN ('approved','paid')
         WHERE vil.project_id=?`,
        cp.id,
      ) || 0;
      const committed = projectCommitments(ctx, cp.id);
      return {
        project: cp.name,
        property: cp.prop,
        status: cp.status,
        budget: cp.budget_cents,
        committed,
        actual,
        remaining: cp.budget_cents - committed - actual,
        __href: '/projects',
      };
    });
    return {
      cols: [
        { key: 'project', label: 'Project' },
        { key: 'property', label: 'Property' },
        { key: 'status', label: 'Status', kind: 'badge' },
        { key: 'budget', label: 'Budget', kind: 'money', total: true },
        { key: 'committed', label: 'Committed (open POs)', kind: 'money', total: true },
        { key: 'actual', label: 'Actual (coded AP)', kind: 'money', total: true },
        { key: 'remaining', label: 'Remaining', kind: 'money', total: true },
      ],
      rows,
    };
  },
});

registerReport({
  key: 'close_status',
  name: 'Month-End Close Status',
  category: 'Accounting',
  describe: 'Per property-month: period state and every checklist item.',
  params: [{ key: 'month', kind: 'month', default: (ctx) => monthKey(addMonths(ctx.businessDate, -1)) }],
  perm: 'gl:view',
  defaultGroup: 'property',
  run(ctx, p): ReportResult {
    const props = q<any>(`SELECT id, name FROM properties WHERE org_id=? ORDER BY name`, ctx.orgId);
    const rows: ReportResult['rows'] = [];
    for (const prop of props) {
      const period = q1<any>(`SELECT * FROM accounting_periods WHERE property_id=? AND period_key=?`, prop.id, p.month);
      const items = closeChecklist(ctx, prop.id, p.month!);
      for (const item of items) {
        rows.push({
          property: prop.name,
          period_status: period?.status || 'open',
          item: item.label,
          ok: item.ok ? '✓ clear' : 'blocking',
          detail: item.detail || '—',
          __href: '/periods',
        });
      }
    }
    return {
      cols: [
        { key: 'property', label: 'Property' },
        { key: 'period_status', label: 'Period', kind: 'badge' },
        { key: 'item', label: 'Checklist item' },
        { key: 'ok', label: 'State', kind: 'badge' },
        { key: 'detail', label: 'Detail' },
      ],
      rows,
      note: `Close checklist for ${fmtMonth(p.month!)} — a period closes only when every item clears.`,
    };
  },
});
