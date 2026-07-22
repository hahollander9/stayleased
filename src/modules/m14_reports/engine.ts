import { q } from '../../lib/db.ts';
import { addDays, addMonths, monthKey, fmtDate, fmtMonth } from '../../lib/dates.ts';
import { usd } from '../../lib/money.ts';
import { propFilter, canAccessProperty, type Ctx } from '../../lib/auth.ts';
import { toCsv } from '../../lib/csv.ts';
import { Pdf, type PdfTableCol } from '../../lib/pdf.ts';

/** M14 report engine: one definition shape for the entire §10 catalog.
 * Every report gets the same parameter panel, sortable/groupable table,
 * totals, drill-through links, CSV + PDF export — definitions stay small. */

export type ParamKind = 'property' | 'date' | 'month' | 'from' | 'to' | 'basis' | 'year' | 'select';

export interface ReportParam {
  key: string;
  kind: ParamKind;
  label?: string;
  options?: [string, string][]; // for select
  default?: (ctx: Ctx) => string;
  allowAll?: boolean; // property param: allow "all properties"
}

export type ColKind = 'text' | 'money' | 'num' | 'pct' | 'date' | 'month' | 'badge';

export interface ReportCol {
  key: string;
  label: string;
  kind?: ColKind;
  total?: boolean; // include in totals row / group subtotals
}

export type ReportRow = Record<string, unknown> & { __href?: string };

export interface ReportResult {
  cols: ReportCol[];
  rows: ReportRow[];
  note?: string;
  /** optional pre-computed totals; otherwise summed from `total` cols */
  totals?: Record<string, unknown>;
}

export interface ReportDef {
  key: string;
  name: string;
  category: string;
  describe: string;
  params: ReportParam[];
  perm?: string; // defaults to reports:view
  defaultGroup?: string;
  defaultSort?: string;
  defaultDir?: 'asc' | 'desc';
  run: (ctx: Ctx, p: Record<string, string>) => ReportResult;
}

export const CATEGORY_ORDER = [
  'Operations',
  'Leasing & marketing',
  'Receivables',
  'Accounting',
  'Facilities',
  'Utilities, insurance & risk',
  'Portfolio & executive',
] as const;

const registry = new Map<string, ReportDef>();

export function registerReport(def: ReportDef): void {
  registry.set(def.key, def);
}
export function reportDefs(): ReportDef[] {
  return [...registry.values()];
}
export function reportDef(key: string): ReportDef | undefined {
  return registry.get(key);
}

// ---------- params ----------

export function accessibleProperties(ctx: Ctx): { id: string; name: string }[] {
  const pf = propFilter(ctx, 'id');
  return q<any>(`SELECT id, name FROM properties WHERE org_id=?${pf.sql} ORDER BY name`, ctx.orgId, ...pf.params);
}

/** resolve raw query params against a def: apply defaults + validate property access */
export function resolveParams(ctx: Ctx, def: ReportDef, raw: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of def.params) {
    let v = raw.get(p.key) || '';
    if (!v) {
      if (p.default) v = p.default(ctx);
      else if (p.kind === 'property') v = p.allowAll ? 'all' : (accessibleProperties(ctx)[0]?.id ?? '');
      else if (p.kind === 'date') v = ctx.businessDate;
      else if (p.kind === 'month') v = monthKey(ctx.businessDate);
      else if (p.kind === 'from') v = addMonths(ctx.businessDate, -1);
      else if (p.kind === 'to') v = ctx.businessDate;
      else if (p.kind === 'basis') v = 'accrual';
      else if (p.kind === 'year') v = ctx.businessDate.slice(0, 4);
      else if (p.kind === 'select') v = p.options?.[0]?.[0] ?? '';
    }
    if (p.kind === 'property' && v !== 'all' && v && !canAccessProperty(ctx, v)) {
      v = accessibleProperties(ctx)[0]?.id ?? '';
    }
    out[p.key] = v;
  }
  return out;
}

/** SQL fragment limiting to the chosen property (or the viewer's scope for 'all') */
export function propScope(ctx: Ctx, propertyId: string, col: string): { sql: string; params: string[] } {
  if (propertyId && propertyId !== 'all') return { sql: ` AND ${col}=?`, params: [propertyId] };
  const pf = propFilter(ctx, col);
  return { sql: pf.sql, params: pf.params };
}

// ---------- generic post-processing ----------

export interface RenderedReport {
  cols: ReportCol[];
  rows: ReportRow[];
  groups: { label: string; rows: ReportRow[]; subtotal: Record<string, unknown> | null }[] | null;
  totals: Record<string, unknown> | null;
  note?: string;
  truncated: boolean;
}

const MAX_ROWS = 2500;

export function processResult(res: ReportResult, opts: { sort?: string; dir?: string; group?: string }): RenderedReport {
  let rows = res.rows;
  const truncated = rows.length > MAX_ROWS;
  if (truncated) rows = rows.slice(0, MAX_ROWS);

  if (opts.sort && res.cols.some((c) => c.key === opts.sort)) {
    const kind = res.cols.find((c) => c.key === opts.sort)?.kind;
    const dir = opts.dir === 'desc' ? -1 : 1;
    rows = [...rows].sort((a, b) => {
      const av = a[opts.sort!], bv = b[opts.sort!];
      if (kind === 'money' || kind === 'num' || kind === 'pct') return (Number(av) - Number(bv)) * dir;
      return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
    });
  }

  const totalCols = res.cols.filter((c) => c.total);
  const sum = (rs: ReportRow[]): Record<string, unknown> | null => {
    if (!totalCols.length) return null;
    const t: Record<string, unknown> = {};
    for (const c of totalCols) t[c.key] = rs.reduce((s, r) => s + (Number(r[c.key]) || 0), 0);
    return t;
  };

  let groups: RenderedReport['groups'] = null;
  if (opts.group && res.cols.some((c) => c.key === opts.group)) {
    const gk = opts.group;
    const gkind = res.cols.find((c) => c.key === gk)?.kind;
    const map = new Map<string, ReportRow[]>();
    for (const r of rows) {
      const label = fmtCell(r[gk], gkind);
      map.set(label, [...(map.get(label) || []), r]);
    }
    groups = [...map.entries()].map(([label, rs]) => ({ label, rows: rs, subtotal: sum(rs) }));
  }

  return {
    cols: res.cols,
    rows,
    groups,
    totals: res.totals ?? sum(rows),
    note: res.note,
    truncated,
  };
}

// ---------- cell formatting (shared by HTML/CSV/PDF renderers) ----------

export function fmtCell(v: unknown, kind?: ColKind): string {
  if (v === null || v === undefined || v === '') return '—';
  switch (kind) {
    case 'money': return usd(Math.round(Number(v)));
    case 'pct': return `${Math.round(Number(v) * 10) / 10}%`;
    case 'num': return String(Math.round(Number(v) * 100) / 100);
    case 'date': return fmtDate(String(v));
    case 'month': return fmtMonth(String(v));
    default: return String(v);
  }
}

// ---------- exports ----------

export function reportCsv(rendered: RenderedReport): string {
  const cols = rendered.cols;
  const rows: (string | number | null)[][] = [];
  const push = (r: ReportRow): void => {
    rows.push(cols.map((c) => {
      const v = r[c.key];
      if (v === null || v === undefined) return '';
      if (c.kind === 'money') return (Number(v) / 100).toFixed(2);
      return typeof v === 'number' ? v : String(v);
    }));
  };
  if (rendered.groups) {
    for (const g of rendered.groups) {
      rows.push([`# ${g.label}`, ...cols.slice(1).map(() => '')]);
      g.rows.forEach(push);
    }
  } else {
    rendered.rows.forEach(push);
  }
  if (rendered.totals) {
    rows.push(cols.map((c, i) => (i === 0 ? 'TOTAL' : rendered.totals![c.key] !== undefined ? (c.kind === 'money' ? (Number(rendered.totals![c.key]) / 100).toFixed(2) : String(rendered.totals![c.key])) : '')));
  }
  return toCsv(cols.map((c) => c.label), rows);
}

export async function reportPdf(
  title: string,
  orgName: string,
  paramLine: string,
  rendered: RenderedReport,
): Promise<Uint8Array> {
  const pdf = await Pdf.create(title);
  pdf.brandHeader(orgName, [paramLine]);
  pdf.h1(title);
  const widths = pdfWidths(rendered.cols);
  const cols: PdfTableCol[] = rendered.cols.map((c, i) => ({
    label: c.label, w: widths[i]!, align: c.kind === 'money' || c.kind === 'num' || c.kind === 'pct' ? 'right' : 'left',
  }));
  const toCells = (r: ReportRow): string[] => rendered.cols.map((c) => fmtCell(r[c.key], c.kind).replace('—', '-'));
  const totalsRow = rendered.totals
    ? rendered.cols.map((c, i) => (i === 0 ? 'Total' : rendered.totals![c.key] !== undefined ? fmtCell(rendered.totals![c.key], c.kind) : ''))
    : undefined;
  if (rendered.groups) {
    for (const g of rendered.groups) {
      pdf.h2(g.label);
      pdf.table(cols, g.rows.map(toCells), {
        totals: g.subtotal ? rendered.cols.map((c, i) => (i === 0 ? 'Subtotal' : g.subtotal![c.key] !== undefined ? fmtCell(g.subtotal![c.key], c.kind) : '')) : undefined,
        zebra: true,
      });
    }
    if (totalsRow) pdf.table(cols, [], { totals: totalsRow });
  } else {
    pdf.table(cols, rendered.rows.map(toCells), { totals: totalsRow, zebra: true });
  }
  if (rendered.note) pdf.text(rendered.note, { muted: true, size: 8 });
  return pdf.bytes();
}

function pdfWidths(cols: ReportCol[]): number[] {
  const weights = cols.map((c) => (c.kind === 'money' || c.kind === 'num' || c.kind === 'pct' ? 0.8 : c.kind === 'date' || c.kind === 'month' ? 0.7 : 1.3));
  const total = weights.reduce((s, x) => s + x, 0);
  return weights.map((w) => w / total);
}

// ---------- shared date helpers for defs ----------

export function monthsBack(ctx: Ctx, n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(monthKey(addMonths(ctx.businessDate, -i)));
  return out;
}

export function rangeDays(from: string, to: string): number {
  return Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1);
}

export { addDays, addMonths, monthKey };
