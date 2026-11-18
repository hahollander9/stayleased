/** Placement Scorecard: how do tenants turn out, by where they came from?
 *
 * An operator who places tenants through leasing agents and listing sites
 * rarely knows which of them bring households that stay and pay. This reads a
 * tenant export (with a leasing-agent and/or lead-source column) and,
 * optionally, a delinquency export, and compares outcomes by source. Like the
 * weekly action report (m22) it runs alongside the operator's system and keeps
 * nothing.
 *
 * FAIR HOUSING IS THE DESIGN CONSTRAINT, not a footnote:
 *
 *  - It scores SOURCES and PROCESSES, never people or kinds of people. The
 *    only things it will group by are the three in `DIMENSIONS`: leasing
 *    agent, lead source, screening decision. There is no "group by any
 *    column", and the reader does not even retain other columns. In
 *    particular it never groups by subsidy program: source of income is a
 *    protected trait in DC and many other places, and a table that ranks
 *    "voucher tenants" would be an instrument of exactly the discrimination
 *    the law forbids.
 *  - "Behind" means the HOUSEHOLD's share is behind. When the delinquency
 *    export separates what an agency owes, that part is excluded, so no agent
 *    or source is marked down because a housing authority paid late.
 *  - Small groups are not ranked. Under `MIN_GROUP` placements a rate is
 *    noise, and noise about a named leasing agent is how someone gets blamed
 *    for two bad months. The row says "too few to judge".
 *  - The output is a question to ask ("why do placements from this source
 *    fall behind twice as often?"), never a decision about an applicant.
 */

import { diffDays, type DateStr } from '../../lib/dates.ts';
import { cellCents, cellDate, propKey, unitKey, type Cents, type DelinquencyRow, type Parsed } from '../m22_weekly/exports.ts';

export const MIN_GROUP = 5;
/** owing less than this is a rounding balance, not "behind" */
export const BEHIND_FLOOR: Cents = 5000;

export const DIMENSIONS = [
  { key: 'agent', label: 'Leasing agent', aliases: ['leasing agent', 'agent', 'placed by', 'leased by', 'leasing consultant', 'broker', 'referring agent', 'rental agent'] },
  { key: 'source', label: 'Lead source', aliases: ['lead source', 'source', 'marketing source', 'how did you hear', 'how heard', 'referral source', 'listing site', 'advertising source'] },
  { key: 'screening', label: 'Screening decision', aliases: ['screening decision', 'screening result', 'screening', 'application decision', 'approval type', 'screening outcome'] },
] as const;
export type DimKey = typeof DIMENSIONS[number]['key'];

export interface Placement {
  property: string;
  unit: string;
  tenant: string;
  moveIn: DateStr | null;
  moveOut: DateStr | null;
  rent: Cents | null;
  dims: Partial<Record<DimKey, string>>;
}

export interface PlacementParse {
  rows: Placement[];
  rowsRead: number;
  skipped: number;
  dimsFound: DimKey[];
  missing: string[];
  warnings: string[];
}

const CORE = [
  { key: 'property', label: 'Property', aliases: ['property', 'property name', 'building'] },
  { key: 'unit', label: 'Unit', aliases: ['unit', 'unit name', 'unit #', 'unit number', 'apt'] },
  { key: 'tenant', label: 'Tenant', aliases: ['tenant', 'tenant name', 'name', 'resident', 'resident name'] },
  { key: 'moveIn', label: 'Move-in', aliases: ['move in', 'move-in', 'move in date', 'movein', 'lease from', 'lease start', 'occupancy date'] },
  { key: 'moveOut', label: 'Move-out', aliases: ['move out', 'move-out', 'move out date', 'moveout', 'vacated'] },
  { key: 'rent', label: 'Rent', aliases: ['rent', 'lease rent', 'monthly rent', 'contract rent', 'total rent'] },
  // preferred over Rent when both exist: months behind is measured against what the household pays
  { key: 'tenantRent', label: 'Tenant rent', aliases: ['tenant rent', 'tenant portion', 'tenant share', 'resident portion'] },
] as const;

const hnorm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();

/** A source label as typed, minus stray spacing; blank-ish values are no label.
 * ("zillow ", "Zillow" and "ZILLOW" are grouped together later, and shown the
 * way the export spelled it first.) */
function label(raw: string): string {
  const s = raw.replace(/\s+/g, ' ').trim();
  return !s || /^(n\/?a|none|unknown|-+)$/i.test(s) ? '' : s;
}

export function parsePlacements(grid: string[][]): PlacementParse {
  const out: PlacementParse = { rows: [], rowsRead: 0, skipped: 0, dimsFound: [], missing: [], warnings: [] };
  const specs = [...CORE, ...DIMENSIONS];
  let headAt = -1;
  let map = new Map<string, number>();
  for (let r = 0; r < Math.min(grid.length, 25); r++) {
    const cells = grid[r]!.map(hnorm);
    const m = new Map<string, number>();
    const taken = new Set<number>();
    // exact header matches only, so "Tenant" never takes the "Tenant Rent" column
    for (const f of specs) {
      const i = cells.findIndex((c, idx) => !taken.has(idx) && (f.aliases as readonly string[]).includes(c));
      if (i >= 0) { m.set(f.key, i); taken.add(i); }
    }
    if (m.size > map.size && m.size >= 2) { map = m; headAt = r; }
  }
  if (headAt < 0 || !map.has('unit')) {
    out.warnings.push('Could not find a header row with a Unit column. Is this a tenant or rent roll export?');
    out.missing = ['Unit'];
    return out;
  }
  out.dimsFound = DIMENSIONS.filter((d) => map.has(d.key)).map((d) => d.key);
  out.missing = CORE.filter((f) => !map.has(f.key) && f.key !== 'moveOut' && f.key !== 'tenantRent').map((f) => f.label);
  if (!out.dimsFound.length) {
    out.warnings.push('No Leasing Agent, Lead Source or Screening Decision column was found, so there is nothing to compare by. Add one of those columns to the export.');
    return out;
  }
  let section = '';
  for (const row of grid.slice(headAt + 1)) {
    const filled = row.map((c) => (c || '').trim()).filter(Boolean);
    if (!filled.length) continue;
    const get = (k: string): string => { const i = map.get(k); return i === undefined ? '' : (row[i] || '').trim(); };
    if (!map.has('property') && filled.length === 1) { section = filled[0]!.replace(/^->\s*/, ''); continue; }
    if (/^(grand\s+)?totals?\b/i.test(filled[0]!)) { out.skipped++; continue; }
    const unit = get('unit');
    const tenant = get('tenant');
    if (!unit || /^vacant/i.test(tenant) || (map.has('tenant') && !tenant)) { out.skipped++; continue; }
    let rent: Cents | null = null;
    try { rent = cellCents(get('tenantRent')) ?? cellCents(get('rent')); } catch { rent = null; }
    const dims: Partial<Record<DimKey, string>> = {};
    for (const d of out.dimsFound) dims[d] = label(get(d));
    out.rows.push({
      property: (get('property') || section).replace(/^->\s*/, ''), unit, tenant,
      moveIn: cellDate(get('moveIn')), moveOut: cellDate(get('moveOut')), rent, dims,
    });
    out.rowsRead++;
  }
  return out;
}

// ---------- the scorecard ----------

export interface GroupStat {
  name: string;
  placements: number;
  /** null when no delinquency export was supplied */
  behind: number | null;
  behindRate: number | null; // 0..1
  owed: Cents | null;
  /** household balance ÷ monthly rent, averaged over those behind; null without rents */
  avgMonthsBehind: number | null;
  /** moved out within 12 months of moving in; null when the export has no dates */
  earlyMoveOuts: number | null;
  earlyRate: number | null;
  judged: boolean;
  /** percentage points above (+) or below (−) everyone else's behind rate */
  vsOthers: number | null;
}

export interface DimReport {
  key: DimKey;
  label: string;
  groups: GroupStat[];
  unlabeled: number;
}

export interface Scorecard {
  asOf: DateStr;
  placements: number;
  hasBalances: boolean;
  hasDates: boolean;
  splitByPayer: boolean;
  overall: { behind: number | null; behindRate: number | null; owed: Cents | null; earlyRate: number | null };
  dims: DimReport[];
  unmatchedBalances: number;
  notes: string[];
}

const pct = (n: number, d: number): number | null => (d ? n / d : null);

export function buildScorecard(input: {
  asOf: DateStr;
  placements: PlacementParse;
  delinquency?: Parsed<DelinquencyRow> | null;
}): Scorecard {
  const rows = input.placements.rows;
  const notes: string[] = [];
  const hasBalances = !!input.delinquency;
  const del = input.delinquency?.rows || [];
  const splitByPayer = del.some((d) => d.subsidy !== null);

  // household balance per unit (agency share removed when the export has it)
  const owedBy = new Map<string, Cents>();
  const unitOnly = new Map<string, Cents[]>();
  const k = (p: string, u: string): string => `${propKey(p)}|${unitKey(u)}`;
  for (const d of del) {
    const house = Math.max(d.total - (d.subsidy ?? 0), 0);
    owedBy.set(k(d.property, d.unit), house);
    unitOnly.set(unitKey(d.unit), [...(unitOnly.get(unitKey(d.unit)) || []), house]);
  }
  const used = new Set<string>();
  const owed = (p: Placement): Cents => {
    if (p.moveOut) return 0; // a former tenant's balance is a different question
    const key = k(p.property, p.unit);
    if (owedBy.has(key)) { used.add(key); return owedBy.get(key)!; }
    // an export with no property column: unit-only, when the label is unique
    if (!propKey(p.property)) {
      const list = unitOnly.get(unitKey(p.unit)) || [];
      if (list.length === 1) return list[0]!;
    }
    return 0;
  };

  const hasDates = rows.some((r) => r.moveIn);
  const early = (p: Placement): boolean | null => {
    if (!p.moveIn) return null;
    if (p.moveOut) return diffDays(p.moveOut, p.moveIn) < 365;
    // still here: only counts as "not early" once they have had a year to leave
    return diffDays(input.asOf, p.moveIn) >= 365 ? false : null;
  };

  const stat = (name: string, set: Placement[], others: Placement[]): GroupStat => {
    const current = set.filter((p) => !p.moveOut);
    const behindRows = current.filter((p) => owed(p) >= BEHIND_FLOOR);
    const owedSum = current.reduce((s, p) => s + owed(p), 0);
    const withRent = behindRows.filter((p) => p.rent && p.rent > 0);
    const known = set.map(early).filter((e): e is boolean => e !== null);
    const earlyN = known.filter(Boolean).length;
    const rate = hasBalances ? pct(behindRows.length, current.length) : null;
    const oc = others.filter((p) => !p.moveOut);
    const otherRate = hasBalances ? pct(oc.filter((p) => owed(p) >= BEHIND_FLOOR).length, oc.length) : null;
    const judged = set.length >= MIN_GROUP;
    return {
      name, placements: set.length,
      behind: hasBalances ? behindRows.length : null,
      behindRate: rate,
      owed: hasBalances ? owedSum : null,
      avgMonthsBehind: hasBalances && withRent.length
        ? Math.round((withRent.reduce((s, p) => s + owed(p) / p.rent!, 0) / withRent.length) * 10) / 10 : null,
      earlyMoveOuts: hasDates && known.length ? earlyN : null,
      earlyRate: hasDates ? pct(earlyN, known.length) : null,
      judged,
      vsOthers: judged && rate !== null && otherRate !== null && oc.length >= MIN_GROUP ? Math.round((rate - otherRate) * 100) : null,
    };
  };

  const dims: DimReport[] = [];
  for (const d of DIMENSIONS) {
    if (!input.placements.dimsFound.includes(d.key)) continue;
    const by = new Map<string, { name: string; set: Placement[] }>();
    let unlabeled = 0;
    const gk = (p: Placement): string => (p.dims[d.key] || '').toLowerCase();
    for (const p of rows) {
      const name = p.dims[d.key] || '';
      if (!name) { unlabeled++; continue; }
      const g = by.get(gk(p)) || { name, set: [] };
      g.set.push(p);
      by.set(gk(p), g);
    }
    const groups = [...by.entries()].map(([key, g]) => stat(g.name, g.set, rows.filter((p) => gk(p) && gk(p) !== key)));
    // judged groups first, worst behind-rate first; unjudged last, by size
    groups.sort((a, b) =>
      Number(b.judged) - Number(a.judged)
      || (b.behindRate ?? -1) - (a.behindRate ?? -1)
      || (b.earlyRate ?? -1) - (a.earlyRate ?? -1)
      || b.placements - a.placements
      || a.name.localeCompare(b.name));
    dims.push({ key: d.key, label: d.label, groups, unlabeled });
    if (unlabeled) notes.push(`${unlabeled} of ${rows.length} rows have no ${d.label.toLowerCase()} and are left out of that table.`);
    const small = groups.filter((g) => !g.judged).length;
    if (small) notes.push(`${small} ${d.label.toLowerCase()} group${small === 1 ? ' has' : 's have'} fewer than ${MIN_GROUP} placements and ${small === 1 ? 'is' : 'are'} listed but not compared.`);
  }

  const all = stat('All', rows, []);
  const unmatched = hasBalances ? [...owedBy.keys()].filter((key) => !used.has(key) && (owedBy.get(key) || 0) >= BEHIND_FLOOR).length : 0;
  if (!hasBalances) notes.push('No delinquency export, so “behind on rent” is not shown. Add one to see it.');
  else if (splitByPayer) notes.push('What a housing agency owes is left out: “behind” counts only the household’s own share.');
  else notes.push('The delinquency export has no subsidy column, so a balance an agency owes would count against the household. Add that column if agencies pay part of the rent.');
  if (!hasDates) notes.push('No move-in dates, so early move-outs are not shown.');
  else if (!rows.some((r) => r.moveOut)) notes.push('The export lists current tenants only, so early move-outs cannot be counted. A tenant export that includes past tenants fixes this.');
  if (unmatched) notes.push(`${unmatched} balance${unmatched === 1 ? '' : 's'} in the delinquency export did not match a tenant row (often former tenants).`);
  notes.push('A difference between groups is a question to look into, not a verdict: one agent may simply lease the harder buildings.');

  return {
    asOf: input.asOf, placements: rows.length, hasBalances, hasDates, splitByPayer,
    overall: { behind: all.behind, behindRate: all.behindRate, owed: all.owed, earlyRate: all.earlyRate },
    dims, unmatchedBalances: unmatched, notes,
  };
}
