import { q } from '../../lib/db.ts';
import { propFilter, type Ctx } from '../../lib/auth.ts';
import { parseUsd } from '../../lib/money.ts';
import type { ReportResult, ReportCol, ColKind } from './engine.ts';

/** M14.3 custom report builder: pick a base dataset, choose columns, filters,
 * grouping and sort. Column expressions live HERE (never user input) — user
 * choices only select from them, so the SQL surface stays closed. */

export interface DatasetCol {
  key: string;
  label: string;
  kind: ColKind;
  expr: string; // SQL expression, safe, defined in code
  filter?: 'text' | 'num' | 'date' | 'select';
  options?: string[]; // for select filters
}

export interface Dataset {
  key: string;
  name: string;
  describe: string;
  from: string; // FROM ... JOIN ... (aliases fixed)
  orgCol: string; // column carrying org_id
  propCol: string | null; // column for property scoping
  defaultCols: string[];
  cols: DatasetCol[];
}

export const DATASETS: Dataset[] = [
  {
    key: 'residents',
    name: 'Residents',
    describe: 'People on leases with their unit, lease state and live balance.',
    from: `residents r
      JOIN household_members hm ON hm.resident_id=r.id
      JOIN leases l ON l.id=hm.lease_id
      JOIN units u ON u.id=l.unit_id
      JOIN properties p ON p.id=r.property_id`,
    orgCol: 'r.org_id',
    propCol: 'r.property_id',
    defaultCols: ['name', 'unit', 'property', 'lease_status', 'balance'],
    cols: [
      { key: 'name', label: 'Resident', kind: 'text', expr: "r.first_name || ' ' || r.last_name", filter: 'text' },
      { key: 'email', label: 'Email', kind: 'text', expr: 'r.email', filter: 'text' },
      { key: 'phone', label: 'Phone', kind: 'text', expr: 'r.phone' },
      { key: 'role', label: 'Household role', kind: 'badge', expr: 'hm.role', filter: 'select', options: ['primary', 'roommate', 'occupant', 'guarantor'] },
      { key: 'unit', label: 'Unit', kind: 'text', expr: 'u.unit_number', filter: 'text' },
      { key: 'property', label: 'Property', kind: 'text', expr: 'p.name' },
      { key: 'lease_status', label: 'Lease status', kind: 'badge', expr: 'l.status', filter: 'select', options: ['active', 'month_to_month', 'notice', 'ended', 'renewed'] },
      { key: 'lease_end', label: 'Lease ends', kind: 'date', expr: 'l.end_date', filter: 'date' },
      { key: 'rent', label: 'Rent', kind: 'money', expr: 'l.rent_cents', filter: 'num' },
      {
        key: 'balance', label: 'Balance', kind: 'money', filter: 'num',
        expr: `(SELECT COALESCE(SUM(amount_cents),0) FROM charges WHERE lease_id=l.id AND status='active')
             - (SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE lease_id=l.id AND status IN ('pending','settled'))`,
      },
      { key: 'autopay', label: 'Autopay', kind: 'badge', expr: "CASE WHEN EXISTS (SELECT 1 FROM autopay_enrollments ae WHERE ae.lease_id=l.id AND ae.status='active') THEN 'on' ELSE 'off' END", filter: 'select', options: ['on', 'off'] },
    ],
  },
  {
    key: 'leases',
    name: 'Leases',
    describe: 'Lease terms, dates, rent and deposits.',
    from: `leases l JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=l.property_id`,
    orgCol: 'l.org_id',
    propCol: 'l.property_id',
    defaultCols: ['household', 'unit', 'property', 'status', 'start', 'end', 'rent'],
    cols: [
      { key: 'household', label: 'Household', kind: 'text', expr: 'l.household_name', filter: 'text' },
      { key: 'unit', label: 'Unit', kind: 'text', expr: 'u.unit_number', filter: 'text' },
      { key: 'property', label: 'Property', kind: 'text', expr: 'p.name' },
      { key: 'status', label: 'Status', kind: 'badge', expr: 'l.status', filter: 'select', options: ['active', 'month_to_month', 'notice', 'ended', 'renewed', 'draft'] },
      { key: 'start', label: 'Start', kind: 'date', expr: 'l.start_date', filter: 'date' },
      { key: 'end', label: 'End', kind: 'date', expr: 'l.end_date', filter: 'date' },
      { key: 'term', label: 'Term (months)', kind: 'num', expr: 'l.term_months', filter: 'num' },
      { key: 'rent', label: 'Rent', kind: 'money', expr: 'l.rent_cents', filter: 'num' },
      { key: 'deposit', label: 'Deposit', kind: 'money', expr: 'l.deposit_cents', filter: 'num' },
      { key: 'dep_alt', label: 'Deposit alternative', kind: 'badge', expr: "CASE WHEN l.deposit_alternative=1 THEN 'yes' ELSE 'no' END", filter: 'select', options: ['yes', 'no'] },
      { key: 'renewal', label: 'Is renewal', kind: 'badge', expr: "CASE WHEN l.renewal_of_lease_id IS NULL THEN 'no' ELSE 'yes' END", filter: 'select', options: ['yes', 'no'] },
    ],
  },
  {
    key: 'units',
    name: 'Units',
    describe: 'The unit board: status, plan, asking rent.',
    from: `units u LEFT JOIN floorplans f ON f.id=u.floorplan_id JOIN properties p ON p.id=u.property_id`,
    orgCol: 'u.org_id',
    propCol: 'u.property_id',
    defaultCols: ['unit', 'property', 'floorplan', 'status', 'market_rent'],
    cols: [
      { key: 'unit', label: 'Unit', kind: 'text', expr: 'u.unit_number', filter: 'text' },
      { key: 'property', label: 'Property', kind: 'text', expr: 'p.name' },
      { key: 'floorplan', label: 'Plan', kind: 'text', expr: 'f.name' },
      { key: 'beds', label: 'Beds', kind: 'num', expr: 'f.beds', filter: 'num' },
      { key: 'sqft', label: 'Sqft', kind: 'num', expr: 'u.sqft', filter: 'num' },
      { key: 'status', label: 'Status', kind: 'badge', expr: 'u.status', filter: 'select', options: ['occupied', 'vacant_ready', 'vacant_not_ready', 'model', 'down'] },
      { key: 'market_rent', label: 'Asking rent', kind: 'money', expr: 'u.market_rent_cents', filter: 'num' },
    ],
  },
  {
    key: 'work_orders',
    name: 'Work orders',
    describe: 'Maintenance requests with lifecycle and cost.',
    from: `work_orders wo LEFT JOIN units u ON u.id=wo.unit_id JOIN properties p ON p.id=wo.property_id`,
    orgCol: 'wo.org_id',
    propCol: 'wo.property_id',
    defaultCols: ['summary', 'unit', 'category', 'priority', 'status', 'created'],
    cols: [
      { key: 'summary', label: 'Summary', kind: 'text', expr: 'wo.summary', filter: 'text' },
      { key: 'unit', label: 'Unit', kind: 'text', expr: 'u.unit_number', filter: 'text' },
      { key: 'property', label: 'Property', kind: 'text', expr: 'p.name' },
      { key: 'category', label: 'Category', kind: 'badge', expr: 'wo.category', filter: 'select', options: ['plumbing', 'electrical', 'hvac', 'appliance', 'doors_locks', 'pest', 'grounds', 'safety', 'turn', 'pm', 'other'] },
      { key: 'priority', label: 'Priority', kind: 'badge', expr: 'wo.priority', filter: 'select', options: ['emergency', 'high', 'normal', 'low'] },
      { key: 'status', label: 'Status', kind: 'badge', expr: 'wo.status', filter: 'select', options: ['new', 'triaged', 'assigned', 'scheduled', 'in_progress', 'on_hold', 'completed', 'canceled'] },
      { key: 'source', label: 'Source', kind: 'badge', expr: 'wo.source', filter: 'select', options: ['portal', 'staff', 'phone', 'pm', 'turn', 'inspection'] },
      { key: 'created', label: 'Created', kind: 'date', expr: 'wo.created_date', filter: 'date' },
      { key: 'completed', label: 'Completed', kind: 'date', expr: 'wo.completed_date', filter: 'date' },
      { key: 'rating', label: 'Rating', kind: 'num', expr: 'wo.rating', filter: 'num' },
    ],
  },
  {
    key: 'leads',
    name: 'Leads',
    describe: 'The leasing funnel: source, status, budget.',
    from: `leads ld JOIN properties p ON p.id=ld.property_id`,
    orgCol: 'ld.org_id',
    propCol: 'ld.property_id',
    defaultCols: ['name', 'property', 'source', 'status', 'created'],
    cols: [
      { key: 'name', label: 'Lead', kind: 'text', expr: "ld.first_name || ' ' || ld.last_name", filter: 'text' },
      { key: 'property', label: 'Property', kind: 'text', expr: 'p.name' },
      { key: 'source', label: 'Source', kind: 'badge', expr: 'ld.source', filter: 'text' },
      { key: 'status', label: 'Status', kind: 'badge', expr: 'ld.status', filter: 'select', options: ['new', 'contacted', 'toured', 'applied', 'leased', 'lost'] },
      { key: 'beds', label: 'Wants beds', kind: 'num', expr: 'ld.beds', filter: 'num' },
      { key: 'budget', label: 'Budget', kind: 'money', expr: 'ld.budget_cents', filter: 'num' },
      { key: 'created', label: 'Created', kind: 'date', expr: 'ld.created_date', filter: 'date' },
    ],
  },
  {
    key: 'charges',
    name: 'Ledger charges',
    describe: 'Every resident charge by kind and month.',
    from: `charges c JOIN leases l ON l.id=c.lease_id JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=c.property_id`,
    orgCol: 'c.org_id',
    propCol: 'c.property_id',
    defaultCols: ['date', 'kind', 'label', 'household', 'amount'],
    cols: [
      { key: 'date', label: 'Date', kind: 'date', expr: 'c.date', filter: 'date' },
      { key: 'month', label: 'Month', kind: 'month', expr: 'c.month_key', filter: 'text' },
      { key: 'kind', label: 'Kind', kind: 'badge', expr: 'c.kind', filter: 'select', options: ['rent', 'late_fee', 'utility', 'deposit', 'pet_rent', 'concession', 'nsf_fee', 'writeoff', 'other'] },
      { key: 'label', label: 'Label', kind: 'text', expr: 'c.label', filter: 'text' },
      { key: 'household', label: 'Household', kind: 'text', expr: 'l.household_name', filter: 'text' },
      { key: 'unit', label: 'Unit', kind: 'text', expr: 'u.unit_number', filter: 'text' },
      { key: 'property', label: 'Property', kind: 'text', expr: 'p.name' },
      { key: 'amount', label: 'Amount', kind: 'money', expr: 'c.amount_cents', filter: 'num' },
      { key: 'status', label: 'Status', kind: 'badge', expr: 'c.status', filter: 'select', options: ['active', 'void'] },
    ],
  },
  {
    key: 'payments',
    name: 'Payments',
    describe: 'Every payment with method and settlement state.',
    from: `payments py JOIN leases l ON l.id=py.lease_id JOIN properties p ON p.id=py.property_id`,
    orgCol: 'py.org_id',
    propCol: 'py.property_id',
    defaultCols: ['received', 'household', 'method', 'status', 'amount'],
    cols: [
      { key: 'received', label: 'Received', kind: 'date', expr: 'py.received_date', filter: 'date' },
      { key: 'household', label: 'Household', kind: 'text', expr: 'l.household_name', filter: 'text' },
      { key: 'property', label: 'Property', kind: 'text', expr: 'p.name' },
      { key: 'method', label: 'Method', kind: 'badge', expr: 'py.method', filter: 'select', options: ['ach', 'card', 'check', 'money_order', 'cash_equivalent', 'lockbox'] },
      { key: 'status', label: 'Status', kind: 'badge', expr: 'py.status', filter: 'select', options: ['pending', 'settled', 'nsf', 'chargeback', 'failed'] },
      { key: 'autopay', label: 'Autopay', kind: 'badge', expr: "CASE WHEN py.autopay=1 THEN 'yes' ELSE 'no' END", filter: 'select', options: ['yes', 'no'] },
      { key: 'amount', label: 'Amount', kind: 'money', expr: 'py.amount_cents', filter: 'num' },
    ],
  },
  {
    key: 'vendor_invoices',
    name: 'Vendor invoices',
    describe: 'AP invoices with vendor and lifecycle.',
    from: `vendor_invoices vi JOIN vendors v ON v.id=vi.vendor_id JOIN properties p ON p.id=vi.property_id`,
    orgCol: 'vi.org_id',
    propCol: 'vi.property_id',
    defaultCols: ['invoice_date', 'vendor', 'property', 'status', 'total'],
    cols: [
      { key: 'invoice_date', label: 'Invoice date', kind: 'date', expr: 'vi.invoice_date', filter: 'date' },
      { key: 'due', label: 'Due', kind: 'date', expr: 'vi.due_date', filter: 'date' },
      { key: 'vendor', label: 'Vendor', kind: 'text', expr: 'v.name', filter: 'text' },
      { key: 'number', label: 'Invoice #', kind: 'text', expr: 'vi.invoice_number', filter: 'text' },
      { key: 'property', label: 'Property', kind: 'text', expr: 'p.name' },
      { key: 'status', label: 'Status', kind: 'badge', expr: 'vi.status', filter: 'select', options: ['draft', 'pending_approval', 'approved', 'paid', 'void'] },
      { key: 'total', label: 'Total', kind: 'money', expr: 'vi.total_cents', filter: 'num' },
    ],
  },
  {
    key: 'gl_lines',
    name: 'GL journal lines',
    describe: 'Raw journal lines with account and source.',
    from: `journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id`,
    orgCol: 'jl.org_id',
    propCol: 'jl.property_id',
    defaultCols: ['date', 'account', 'memo', 'debit', 'credit'],
    cols: [
      { key: 'date', label: 'Date', kind: 'date', expr: 'je.date', filter: 'date' },
      { key: 'account', label: 'Account', kind: 'text', expr: 'jl.account_code', filter: 'text' },
      { key: 'basis', label: 'Basis', kind: 'badge', expr: 'je.basis', filter: 'select', options: ['accrual', 'cash'] },
      { key: 'source', label: 'Source', kind: 'badge', expr: 'je.source_kind', filter: 'text' },
      { key: 'memo', label: 'Memo', kind: 'text', expr: 'COALESCE(jl.memo, je.memo)', filter: 'text' },
      { key: 'debit', label: 'Debit', kind: 'money', expr: 'jl.debit_cents', filter: 'num' },
      { key: 'credit', label: 'Credit', kind: 'money', expr: 'jl.credit_cents', filter: 'num' },
    ],
  },
];

export function dataset(key: string): Dataset | undefined {
  return DATASETS.find((d) => d.key === key);
}

export interface BuilderFilter {
  col: string;
  op: 'contains' | 'eq' | 'gte' | 'lte';
  value: string;
}

export interface BuilderConfig {
  dataset: string;
  cols: string[];
  filters: BuilderFilter[];
  group?: string | null;
  sort?: string | null;
  dir?: 'asc' | 'desc';
}

const OPS: Record<string, string> = { contains: 'LIKE', eq: '=', gte: '>=', lte: '<=' };

/** run a builder config → the same ReportResult shape the canned engine uses */
export function runCustom(ctx: Ctx, cfg: BuilderConfig): ReportResult {
  const ds = dataset(cfg.dataset);
  if (!ds) throw new Error('unknown dataset');
  const chosen = cfg.cols.map((k) => ds.cols.find((c) => c.key === k)).filter((c): c is DatasetCol => !!c);
  if (!chosen.length) throw new Error('pick at least one column');

  const where: string[] = [`${ds.orgCol}=?`];
  const params: unknown[] = [ctx.orgId];
  if (ds.propCol) {
    const pf = propFilter(ctx, ds.propCol);
    if (pf.sql) where.push(pf.sql.replace(/^ AND /, ''));
    params.push(...pf.params);
  }
  for (const f of cfg.filters) {
    const col = ds.cols.find((c) => c.key === f.col);
    const op = OPS[f.op];
    if (!col || !op || f.value === '') continue;
    let v: unknown = f.value;
    if (col.kind === 'money') {
      try { v = parseUsd(f.value); } catch { continue; }
    } else if (col.kind === 'num') {
      v = Number(f.value);
      if (Number.isNaN(v)) continue;
    } else if (f.op === 'contains') {
      v = `%${f.value}%`;
    }
    where.push(`(${col.expr}) ${op} ?`);
    params.push(v);
  }

  if (cfg.group) {
    const gcol = ds.cols.find((c) => c.key === cfg.group);
    if (!gcol) throw new Error('unknown group column');
    const moneyCols = chosen.filter((c) => c.kind === 'money' && c.key !== gcol.key);
    const numCols = chosen.filter((c) => c.kind === 'num' && c.key !== gcol.key);
    const selects = [
      `(${gcol.expr}) AS g`,
      'COUNT(*) AS n',
      ...moneyCols.map((c, i) => `SUM(${c.expr}) AS m${i}`),
      ...numCols.map((c, i) => `AVG(${c.expr}) AS a${i}`),
    ];
    const rows = q<any>(
      `SELECT ${selects.join(', ')} FROM ${ds.from} WHERE ${where.join(' AND ')} GROUP BY g ORDER BY n DESC LIMIT 500`,
      ...params,
    );
    const cols: ReportCol[] = [
      { key: 'g', label: gcol.label, kind: gcol.kind === 'money' ? 'money' : gcol.kind },
      { key: 'n', label: 'Count', kind: 'num', total: true },
      ...moneyCols.map((c, i) => ({ key: `m${i}`, label: `Σ ${c.label}`, kind: 'money' as ColKind, total: true })),
      ...numCols.map((c, i) => ({ key: `a${i}`, label: `avg ${c.label}`, kind: 'num' as ColKind })),
    ];
    return { cols, rows, note: `Grouped by ${gcol.label}.` };
  }

  const selects = chosen.map((c, i) => `(${c.expr}) AS c${i}`);
  const sortCol = cfg.sort ? chosen.findIndex((c) => c.key === cfg.sort) : -1;
  const rows = q<any>(
    `SELECT ${selects.join(', ')} FROM ${ds.from} WHERE ${where.join(' AND ')}
     ${sortCol >= 0 ? `ORDER BY c${sortCol} ${cfg.dir === 'desc' ? 'DESC' : 'ASC'}` : ''} LIMIT 2000`,
    ...params,
  ).map((r) => {
    const out: Record<string, unknown> = {};
    chosen.forEach((c, i) => { out[c.key] = r[`c${i}`]; });
    return out;
  });
  return {
    cols: chosen.map((c) => ({ key: c.key, label: c.label, kind: c.kind, total: c.kind === 'money' })),
    rows,
  };
}

/** parse builder config from query params (the builder UI is fully linkable) */
export function configFromQuery(raw: URLSearchParams): BuilderConfig {
  const cols = raw.getAll('col');
  const filters: BuilderFilter[] = [];
  for (let i = 0; i < 4; i++) {
    const col = raw.get(`f${i}_col`);
    const op = raw.get(`f${i}_op`) as BuilderFilter['op'];
    const value = raw.get(`f${i}_val`) || '';
    if (col && op && value !== '') filters.push({ col, op, value });
  }
  return {
    dataset: raw.get('dataset') || 'residents',
    cols,
    filters,
    group: raw.get('group') || null,
    sort: raw.get('sort_col') || null,
    dir: raw.get('dir') === 'desc' ? 'desc' : 'asc',
  };
}
