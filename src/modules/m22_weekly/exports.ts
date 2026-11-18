/** Reading report exports from another property-management system.
 *
 * The Weekly Action Report runs ALONGSIDE the operator's system of record
 * (AppFolio first, because the first design partner runs on it). Nothing here
 * writes to StayLeased's books: an export goes in, a list of what needs
 * attention comes out, and the files are never stored. That is a different
 * job from the Migration Center (setup/), which moves an operator OFF their
 * old system and is approval-gated for exactly that reason. Keeping the two
 * apart means this reader can be forgiving about layout without any risk of a
 * misread column landing in a ledger.
 *
 * What it tolerates, because report exports really look like this:
 *  - title rows above the header ("Delinquency", "Exported On: ...")
 *  - property section rows instead of a Property column ("-> Oakwood Terrace")
 *  - subtotal and grand-total rows (skipped, and the grand total is kept so
 *    the screen can say whether our sum ties to the file's own)
 *  - money as "$1,234.56", "(1,234.56)", "-" or blank; dates as MM/DD/YYYY,
 *    ISO, or an Excel serial
 *
 * Column names are matched against alias lists, not one fixed layout. The
 * aliases are our best reading of AppFolio's report columns and common
 * variants; until we have seen a design partner's real export, every column
 * we could not find is reported back on the screen rather than guessed at.
 */

import type { DateStr } from '../../lib/dates.ts';
import { serialToIso } from '../../lib/xlsx.ts';

export type Cents = number;

// ---------- cell parsing ----------

/** "$1,234.56" | "(1,234.56)" | "-1234.5" | "-" | "" → cents, or null when the
 * cell is blank. Throws on text that is not a number, so a mis-mapped column
 * surfaces as a warning instead of as a zero. */
export function cellCents(raw: string | undefined): Cents | null {
  const s0 = (raw ?? '').trim();
  if (s0 === '' || s0 === '-' || s0 === '—') return null;
  let s = s0.replace(/[$,\s]/g, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (!/^\d*(\.\d+)?$/.test(s) || s === '' || s === '.') throw new Error(`not an amount: ${s0}`);
  // round half-up at the cent: exports occasionally carry 3+ decimals
  const cents = Math.round(Number(s) * 100);
  return neg ? -cents : cents;
}

/** MM/DD/YYYY, M/D/YY, YYYY-MM-DD, or an Excel serial → YYYY-MM-DD; null if
 * blank or unreadable (dates are never load-bearing for money). */
export function cellDate(raw: string | undefined): DateStr | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) {
    const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${y}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
  }
  if (/^\d{5}(\.\d+)?$/.test(s)) return serialToIso(Number(s));
  return null;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9+]/g, '');

/** Unit labels compared loosely: "Unit 2", "#2", "02" and "2" are one unit. */
export function unitKey(s: string): string {
  return norm(s.replace(/^(unit|apt|apartment|#)\s*/i, '')).replace(/^0+(?=\w)/, '');
}
export const propKey = (s: string): string => norm(s.replace(/^->\s*/, ''));

// ---------- header detection ----------

export interface FieldSpec {
  key: string;
  label: string;
  aliases: string[];
}

export interface FileReport {
  /** what the screen calls this file */
  title: string;
  rowsRead: number;
  rowsSkipped: number;
  found: string[];
  missing: string[];
  warnings: string[];
  /** the file's own grand total for its main amount column, if it has one */
  fileTotal: Cents | null;
  /** our sum of the same column over the rows we read */
  ourTotal: Cents | null;
}

export interface Parsed<T> {
  rows: T[];
  report: FileReport;
}

function locateHeader(grid: string[][], specs: FieldSpec[]): { at: number; map: Map<string, number> } | null {
  let best: { at: number; map: Map<string, number> } | null = null;
  for (let r = 0; r < Math.min(grid.length, 25); r++) {
    const cells = grid[r]!.map((c) => norm(c));
    const map = new Map<string, number>();
    const taken = new Set<number>();
    // exact alias matches first, so "Rent" never steals "Tenant Rent"
    for (const spec of specs) {
      const i = cells.findIndex((c, idx) => !taken.has(idx) && spec.aliases.some((a) => norm(a) === c));
      if (i >= 0) { map.set(spec.key, i); taken.add(i); }
    }
    // then containment, for long aliases only ("Delinquent Subsidy Amount (USD)")
    for (const spec of specs) {
      if (map.has(spec.key)) continue;
      const i = cells.findIndex((c, idx) => !taken.has(idx) && c.length > 0 &&
        spec.aliases.some((a) => norm(a).length >= 6 && c.includes(norm(a))));
      if (i >= 0) { map.set(spec.key, i); taken.add(i); }
    }
    if (map.size >= 2 && (!best || map.size > best.map.size)) best = { at: r, map };
  }
  return best;
}

const TOTAL_RE = /^(grand\s+)?totals?\b/i;

/** Walk an export's data rows. `onRow` gets a getter per field; section rows
 * (a property name alone in the first cell) set the current property, and
 * total rows are skipped with the last one's amount kept for the tie-out. */
function walk(
  title: string,
  grid: string[][],
  specs: FieldSpec[],
  required: string[],
  amountKey: string | null,
  onRow: (get: (key: string) => string, property: string, warn: (msg: string) => void) => Cents | null | 'skip',
): FileReport {
  const report: FileReport = {
    title, rowsRead: 0, rowsSkipped: 0, found: [], missing: [], warnings: [], fileTotal: null, ourTotal: null,
  };
  const head = locateHeader(grid, specs);
  if (!head) {
    report.missing = specs.map((s) => s.label);
    report.warnings.push('Could not find a header row. Is this the right report?');
    return report;
  }
  report.found = specs.filter((s) => head.map.has(s.key)).map((s) => s.label);
  report.missing = specs.filter((s) => !head.map.has(s.key)).map((s) => s.label);
  const lacking = required.filter((k) => !head.map.has(k));
  if (lacking.length) {
    report.warnings.push(`Missing required column(s): ${lacking.map((k) => specs.find((s) => s.key === k)!.label).join(', ')}.`);
    return report;
  }
  const hasProp = head.map.has('property');
  let section = '';
  let usedSections = false;
  let sum = 0;
  let summed = false;
  const shown = new Set<string>();
  const warn = (msg: string): void => {
    // one line per kind of problem, not one per row
    const kind = msg.replace(/\d[\d,.$()-]*/g, '#');
    if (shown.has(kind)) return;
    shown.add(kind);
    report.warnings.push(msg);
  };
  for (const row of grid.slice(head.at + 1)) {
    const filled = row.map((c) => c.trim()).filter(Boolean);
    if (!filled.length) continue;
    const first = (row.find((c) => c.trim()) || '').trim();
    if (TOTAL_RE.test(first) || TOTAL_RE.test((row[0] || '').trim()) || TOTAL_RE.test((row[1] || '').trim())) {
      if (amountKey) {
        try {
          const t = cellCents(row[head.map.get(amountKey)!]);
          if (t !== null) report.fileTotal = t; // the last total row is the grand total
        } catch { /* a label in the amount column — not a total we can use */ }
      }
      report.rowsSkipped++;
      continue;
    }
    if (!hasProp && filled.length === 1 && row[0]!.trim() === first) {
      section = first.replace(/^->\s*/, '');
      usedSections = true;
      continue;
    }
    const get = (key: string): string => {
      const i = head.map.get(key);
      return i === undefined ? '' : (row[i] ?? '').trim();
    };
    let amt: Cents | null | 'skip';
    try {
      amt = onRow(get, hasProp ? get('property').replace(/^->\s*/, '') : section, warn);
    } catch (e) {
      warn(`Skipped a row: ${(e as Error).message}.`);
      report.rowsSkipped++;
      continue;
    }
    if (amt === 'skip') { report.rowsSkipped++; continue; }
    report.rowsRead++;
    if (amt !== null) { sum += amt; summed = true; }
  }
  if (amountKey && summed) report.ourTotal = sum;
  // property section rows ARE the property column for this layout; listing
  // "Property" as not found would send someone looking for a problem that isn't one
  if (!hasProp && usedSections) report.missing = report.missing.filter((m) => m !== 'Property');
  return report;
}

// ---------- the four exports ----------

export interface RentRollRow {
  property: string;
  unit: string;
  tenant: string;
  vacant: boolean;
  /** total monthly rent on the lease */
  rent: Cents;
  marketRent: Cents | null;
  /** the household's share and the agency's share; null when the export has no such columns */
  tenantRent: Cents | null;
  subsidyRent: Cents | null;
  program: string | null;
  leaseTo: DateStr | null;
}

export const RENT_ROLL_FIELDS: FieldSpec[] = [
  { key: 'property', label: 'Property', aliases: ['Property', 'Property Name', 'Building'] },
  { key: 'unit', label: 'Unit', aliases: ['Unit', 'Unit Name', 'Unit #', 'Unit Number', 'Apt'] },
  { key: 'tenant', label: 'Tenant', aliases: ['Tenant', 'Tenant Name', 'Resident', 'Name', 'Occupant'] },
  { key: 'status', label: 'Status', aliases: ['Status', 'Tenant Status', 'Unit Status', 'Occupancy'] },
  { key: 'market', label: 'Market Rent', aliases: ['Market Rent', 'Market'] },
  { key: 'rent', label: 'Rent', aliases: ['Rent', 'Lease Rent', 'Contract Rent', 'Monthly Rent', 'Total Rent'] },
  { key: 'tenantRent', label: 'Tenant Rent', aliases: ['Tenant Rent', 'Tenant Portion', 'Tenant Responsibility', 'Resident Portion', 'Tenant Share', 'TTP'] },
  { key: 'subsidyRent', label: 'Subsidy Rent', aliases: ['Subsidy Rent', 'Subsidy', 'Subsidy Portion', 'HAP', 'HAP Amount', 'Housing Assistance', 'Agency Portion', 'Subsidy Amount'] },
  { key: 'program', label: 'Subsidy Program', aliases: ['Subsidy Program', 'Program', 'Voucher Program', 'Subsidy Type', 'Agency', 'Housing Program'] },
  { key: 'leaseTo', label: 'Lease To', aliases: ['Lease To', 'Lease End', 'Lease Expiration', 'Lease Expires'] },
];

export function parseRentRoll(grid: string[][]): Parsed<RentRollRow> {
  const rows: RentRollRow[] = [];
  const report = walk('Rent roll', grid, RENT_ROLL_FIELDS, ['unit', 'rent'], 'rent', (g, property) => {
    const unit = g('unit');
    if (!unit) return 'skip';
    const status = g('status').toLowerCase();
    const tenant = g('tenant');
    const vacant = /vacant/.test(status) || /^vacant/i.test(tenant) || (!tenant && !status);
    const rent = cellCents(g('rent')) ?? 0;
    rows.push({
      property, unit, tenant: vacant ? '' : tenant, vacant, rent,
      marketRent: cellCents(g('market')),
      tenantRent: cellCents(g('tenantRent')),
      subsidyRent: cellCents(g('subsidyRent')),
      program: g('program') || null,
      leaseTo: cellDate(g('leaseTo')),
    });
    return rent;
  });
  return { rows, report };
}

export interface DelinquencyRow {
  property: string;
  unit: string;
  name: string;
  total: Cents;
  /** the portion owed by a housing agency, when the export carries it */
  subsidy: Cents | null;
  aging: { d0_30: Cents; d30_60: Cents; d60_90: Cents; d90: Cents } | null;
  lastPayment: DateStr | null;
  notes: string;
}

export const DELINQUENCY_FIELDS: FieldSpec[] = [
  { key: 'property', label: 'Property', aliases: ['Property', 'Property Name', 'Building'] },
  { key: 'unit', label: 'Unit', aliases: ['Unit', 'Unit Name', 'Unit #', 'Unit Number', 'Apt'] },
  { key: 'name', label: 'Name', aliases: ['Name', 'Tenant', 'Tenant Name', 'Resident', 'Payer'] },
  { key: 'total', label: 'Amount Receivable', aliases: ['Amount Receivable', 'Balance', 'Total Due', 'Amount Due', 'Total', 'Total Balance', 'Delinquent Amount', 'Past Due'] },
  { key: 'subsidy', label: 'Delinquent Subsidy Amount', aliases: ['Delinquent Subsidy Amount', 'Subsidy Amount', 'Subsidy Balance', 'Subsidy Receivable', 'HAP Balance', 'Agency Balance', 'Agency Portion'] },
  { key: 'd0', label: '0-30', aliases: ['0-30', '00-30', '0 to 30', 'Current', '0-30 Days'] },
  { key: 'd30', label: '30-60', aliases: ['30-60', '31-60', '30 to 60', '30-60 Days', '31-60 Days'] },
  { key: 'd60', label: '60-90', aliases: ['60-90', '61-90', '60 to 90', '60-90 Days', '61-90 Days'] },
  { key: 'd90', label: '90+', aliases: ['90+', '90 +', 'Over 90', '90+ Days', '91+', 'Over 90 Days'] },
  { key: 'lastPayment', label: 'Last Payment', aliases: ['Last Payment', 'Last Payment Date', 'Last Paid'] },
  { key: 'notes', label: 'Notes', aliases: ['Delinquency Notes', 'Notes', 'Collection Notes', 'Comments'] },
];

export function parseDelinquency(grid: string[][], title = 'Delinquency'): Parsed<DelinquencyRow> {
  const rows: DelinquencyRow[] = [];
  let hasAging = false;
  const report = walk(title, grid, DELINQUENCY_FIELDS, ['unit', 'total'], 'total', (g, property, warn) => {
    const unit = g('unit');
    if (!unit) return 'skip';
    const total = cellCents(g('total')) ?? 0;
    let subsidy = cellCents(g('subsidy'));
    if (subsidy !== null && (subsidy < 0 || subsidy > Math.max(total, 0))) {
      warn(`Unit ${unit}: the subsidy amount is outside the balance, so that row's split was not used.`);
      subsidy = null;
    }
    const b = [g('d0'), g('d30'), g('d60'), g('d90')].map((c) => cellCents(c));
    const anyAging = b.some((x) => x !== null);
    hasAging ||= anyAging;
    const aging = anyAging
      ? { d0_30: b[0] ?? 0, d30_60: b[1] ?? 0, d60_90: b[2] ?? 0, d90: b[3] ?? 0 }
      : null;
    if (aging && aging.d0_30 + aging.d30_60 + aging.d60_90 + aging.d90 !== total) {
      warn(`Unit ${unit}: the aging buckets do not add up to the balance; the balance was used.`);
    }
    rows.push({ property, unit, name: g('name'), total, subsidy, aging, lastPayment: cellDate(g('lastPayment')), notes: g('notes') });
    return total;
  });
  return { rows, report };
}

export type PayerType = 'tenant' | 'agency';

export interface ReceiptRow {
  date: DateStr;
  property: string;
  unit: string;
  payer: string;
  payerType: PayerType;
  amount: Cents;
}

export const RECEIPT_FIELDS: FieldSpec[] = [
  { key: 'date', label: 'Date', aliases: ['Date', 'Receipt Date', 'Payment Date', 'Deposit Date', 'Date Received'] },
  { key: 'property', label: 'Property', aliases: ['Property', 'Property Name', 'Building'] },
  { key: 'unit', label: 'Unit', aliases: ['Unit', 'Unit Name', 'Unit #', 'Unit Number', 'Apt'] },
  { key: 'payer', label: 'Payer', aliases: ['Payer', 'Received From', 'Paid By', 'Payer Name', 'Name', 'Tenant'] },
  { key: 'payerType', label: 'Payer Type', aliases: ['Payer Type', 'Payment Source', 'Source'] },
  { key: 'amount', label: 'Amount', aliases: ['Amount', 'Receipt Amount', 'Payment Amount', 'Amount Received', 'Total'] },
];

/** A payer is an agency when the export says so, or when its name reads like
 * one. Name-reading is a fallback and is disclosed on screen as such. */
const AGENCY_RE = /housing authority|\bhap\b|\bhcvp?\b|\bvash\b|section ?8|\bhud\b|\bdhs\b|\bdhcd\b|department|dept\.?\b|\bagency\b|subsidy|voucher|rapid re-?housing|\bcity of\b|\bcounty\b/i;

export function parseReceipts(grid: string[][]): Parsed<ReceiptRow> {
  const rows: ReceiptRow[] = [];
  const report = walk('Receipts', grid, RECEIPT_FIELDS, ['unit', 'amount', 'date'], 'amount', (g, property) => {
    const unit = g('unit');
    const date = cellDate(g('date'));
    if (!unit || !date) return 'skip';
    const amount = cellCents(g('amount')) ?? 0;
    const payer = g('payer');
    const declared = g('payerType').toLowerCase();
    const payerType: PayerType = declared
      ? (/agency|subsidy|hap|housing|voucher|government|program/.test(declared) ? 'agency' : 'tenant')
      : (AGENCY_RE.test(payer) ? 'agency' : 'tenant');
    rows.push({ date, property, unit, payer, payerType, amount });
    return amount;
  });
  return { rows, report };
}

export interface WorkOrderRow {
  number: string;
  property: string;
  unit: string;
  status: string;
  priority: 'urgent' | 'normal' | 'low';
  created: DateStr;
  updated: DateStr | null;
  vendor: string;
  description: string;
}

export const WORK_ORDER_FIELDS: FieldSpec[] = [
  { key: 'number', label: 'Work Order Number', aliases: ['Work Order Number', 'Work Order #', 'WO #', 'Work Order', 'Number', 'ID'] },
  { key: 'property', label: 'Property', aliases: ['Property', 'Property Name', 'Building'] },
  { key: 'unit', label: 'Unit', aliases: ['Unit', 'Unit Name', 'Unit #', 'Apt'] },
  { key: 'status', label: 'Status', aliases: ['Status', 'Work Order Status'] },
  { key: 'priority', label: 'Priority', aliases: ['Priority', 'Urgency'] },
  { key: 'created', label: 'Created At', aliases: ['Created At', 'Created', 'Created On', 'Date Created', 'Opened', 'Submitted'] },
  { key: 'updated', label: 'Last Updated', aliases: ['Last Updated', 'Updated At', 'Last Activity', 'Last Activity Date', 'Status Updated'] },
  { key: 'vendor', label: 'Vendor', aliases: ['Vendor', 'Assigned To', 'Vendor Name', 'Technician'] },
  { key: 'description', label: 'Description', aliases: ['Description', 'Job Description', 'Issue', 'Summary', 'Request'] },
];

export function parseWorkOrders(grid: string[][]): Parsed<WorkOrderRow> {
  const rows: WorkOrderRow[] = [];
  const report = walk('Work orders', grid, WORK_ORDER_FIELDS, ['status', 'created'], null, (g, property) => {
    const created = cellDate(g('created'));
    if (!created) return 'skip';
    const p = g('priority').toLowerCase();
    const priority = /urgent|emergency|high|critical/.test(p) ? 'urgent' : /low/.test(p) ? 'low' : 'normal';
    rows.push({
      number: g('number'), property, unit: g('unit'), status: g('status'), priority,
      created, updated: cellDate(g('updated')), vendor: g('vendor'), description: g('description'),
    });
    return null;
  });
  return { rows, report };
}
