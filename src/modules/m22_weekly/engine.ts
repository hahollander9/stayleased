/** The Weekly Cash & Collections Action Report: from exports to a ranked list.
 *
 * Four questions, in the order a fee manager's principal asks them:
 *  1. Who owes what — and how much of it is the household's versus a housing
 *     agency's? ("profitable on paper is not cash")
 *  2. What should have come in this month and did not?
 *  3. What changed since last week?
 *  4. What do we do about it, in what order?
 * Plus, when a work-order export is supplied, the maintenance items that have
 * stalled.
 *
 * Deterministic by design (no LLM): every figure on the report is arithmetic
 * over the uploaded rows, and the screen shows that arithmetic. Where the data
 * cannot support a number — a balance with no subsidy column to split it, a
 * month with no receipts file — the report says "not split" or "add the
 * receipts export" instead of estimating. A collections list a property
 * manager acts on is not a place for a plausible guess.
 *
 * Nothing here contacts anyone. Suggested next steps are wording for a human
 * to act on; StayLeased's approval queue is where any message would be drafted
 * if the operator later turns that on.
 */

import { diffDays, firstOfMonth, type DateStr } from '../../lib/dates.ts';
import {
  propKey, unitKey,
  type Cents, type Parsed, type RentRollRow, type DelinquencyRow, type ReceiptRow, type WorkOrderRow, type FileReport,
} from './exports.ts';

export interface ReportInput {
  asOf: DateStr;
  rentRoll: Parsed<RentRollRow>;
  delinquency: Parsed<DelinquencyRow>;
  receipts?: Parsed<ReceiptRow> | null;
  workOrders?: Parsed<WorkOrderRow> | null;
  /** last week's delinquency export, for "what changed" */
  prior?: Parsed<DelinquencyRow> | null;
  /** agencies typically pay in the first business days; before this day of
   * the month a missing agency payment is "not due yet", not a flag */
  agencyGraceDay?: number;
  /** DC rent is late after the fifth; same rule for "nothing paid yet" */
  tenantGraceDay?: number;
}

export type Split = 'file' | 'market' | 'unknown';
export type Bucket = '0-30' | '30-60' | '60-90' | '90+';

export interface Household {
  key: string;
  property: string;
  unit: string;
  name: string;
  program: string | null;
  total: Cents;
  /** null when the split cannot be had from the data */
  tenantOwed: Cents | null;
  agencyOwed: Cents | null;
  split: Split;
  oldest: Bucket | null;
  /** agency balance ÷ monthly subsidy, one decimal; null when either is unknown */
  subsidyMonthsBehind: number | null;
  onPlan: boolean;
  lastPayment: DateStr | null;
  inRentRoll: boolean;
}

export type FlagKind =
  | 'agency_missing' | 'agency_short' | 'tenant_none' | 'tenant_short'
  | 'overpaid' | 'unmatched_receipt' | 'vacant_receipt';

export interface Flag {
  kind: FlagKind;
  property: string;
  unit: string;
  who: string;
  expected: Cents;
  received: Cents;
  detail: string;
}

export interface FollowUp {
  rank: number;
  kind: 'agency' | 'tenant' | 'confirm' | 'investigate';
  property: string;
  unit: string;
  who: string;
  amount: Cents;
  age: string;
  why: string;
  step: string;
  score: number;
}

export interface AgencyGroup {
  program: string;
  households: number;
  owed: Cents;
  noPaymentThisMonth: number;
  worstMonthsBehind: number | null;
  units: string[];
}

export interface Change {
  property: string;
  unit: string;
  name: string;
  before: Cents;
  after: Cents;
  kind: 'new' | 'grew' | 'shrank' | 'cured';
}

export interface MaintItem {
  number: string;
  property: string;
  unit: string;
  description: string;
  priority: WorkOrderRow['priority'];
  status: string;
  vendor: string;
  ageDays: number;
  idleDays: number | null;
  why: string;
}

export interface Report {
  asOf: DateStr;
  monthStart: DateStr;
  owed: { total: Cents; tenant: Cents; agency: Cents; unsplit: Cents; households: number };
  /** null when no receipts export was supplied */
  month: null | {
    expectedTenant: Cents; expectedAgency: Cents; expectedUnsplit: Cents;
    receivedTenant: Cents; receivedAgency: Cents;
  };
  vacancy: { units: number; monthlyRent: Cents; list: { property: string; unit: string; rent: Cents }[] };
  households: Household[];
  agencies: AgencyGroup[];
  flags: Flag[];
  followUps: FollowUp[];
  changes: Change[] | null;
  maintenance: null | { open: number; stalled: number; urgentOverdue: number; items: MaintItem[] };
  files: FileReport[];
  /** plain sentences on what the data could and could not support */
  limits: string[];
}

const key = (property: string, unit: string): string => `${propKey(property)}|${unitKey(unit)}`;

/** Joins rows from different exports on property + unit, falling back to the
 * unit alone when an export has no property and the unit label is unique. */
class UnitIndex<T> {
  private byKey = new Map<string, T>();
  private byUnit = new Map<string, { v: T; hasProp: boolean }[]>();
  add(property: string, unit: string, v: T): void {
    this.byKey.set(key(property, unit), v);
    const u = unitKey(unit);
    this.byUnit.set(u, [...(this.byUnit.get(u) || []), { v, hasProp: !!propKey(property) }]);
  }
  find(property: string, unit: string): T | undefined {
    if (propKey(property)) {
      const hit = this.byKey.get(key(property, unit));
      if (hit) return hit;
    }
    // The unit-only fallback is for when one side does not know the property.
    // When both sides do and they disagree, "Unit 2" at Oakwood is not "Unit 2"
    // at Hillcrest, however unique the label happens to be in the other file.
    const list = (this.byUnit.get(unitKey(unit)) || [])
      .filter((e) => !propKey(property) || !e.hasProp);
    return list.length === 1 ? list[0]!.v : undefined;
  }
}

function oldestBucket(d: DelinquencyRow): Bucket | null {
  if (!d.aging) return null;
  if (d.aging.d90 > 0) return '90+';
  if (d.aging.d60_90 > 0) return '60-90';
  if (d.aging.d30_60 > 0) return '30-60';
  if (d.aging.d0_30 > 0) return '0-30';
  return null;
}

const BUCKET_WEIGHT: Record<Bucket, number> = { '0-30': 1, '30-60': 2, '60-90': 3, '90+': 4 };

function monthsWeight(m: number | null): number {
  if (m === null) return 2;
  return m >= 3 ? 4 : m >= 2 ? 3 : m >= 1 ? 2 : 1;
}

const PLAN_RE = /payment plan|\bpp\b|repayment|promise to pay|\bptp\b/i;

/** The next step for a household's own balance, by how old it is. Wording is
 * deliberately conservative: DC is a tenant-protective jurisdiction and the
 * partner's practice is communication first. Legal steps are named only as
 * "management review", never recommended. */
function tenantStep(b: Bucket | null, onPlan: boolean): string {
  if (onPlan) return 'On a payment plan: check this month’s installment was kept.';
  switch (b) {
    case '0-30': return 'Friendly reminder to the household.';
    case '30-60': return 'Call the household; offer a payment plan.';
    case '60-90': return 'Set up a payment plan or connect them with rental assistance.';
    case '90+': return 'Management review: plan, assistance referral, or next formal step.';
    default: return 'Reach out to the household.';
  }
}

export function buildReport(input: ReportInput): Report {
  const asOf = input.asOf;
  const monthStart = firstOfMonth(asOf);
  const dayOfMonth = Number(asOf.slice(8, 10));
  const agencyGrace = input.agencyGraceDay ?? 10;
  const tenantGrace = input.tenantGraceDay ?? 5;
  const limits: string[] = [];

  const rr = input.rentRoll.rows;
  const rrIndex = new UnitIndex<RentRollRow>();
  for (const r of rr) rrIndex.add(r.property, r.unit, r);
  const rrHasSplit = rr.some((r) => r.subsidyRent !== null || r.tenantRent !== null);
  const delHasSubsidy = input.delinquency.rows.some((d) => d.subsidy !== null);

  // ---- 1. who owes what ----
  const households: Household[] = [];
  for (const d of input.delinquency.rows) {
    if (d.total <= 0) continue;
    const lease = rrIndex.find(d.property, d.unit);
    const property = d.property || lease?.property || '';
    const program = lease?.program || null;
    let split: Split;
    let tenantOwed: Cents | null;
    let agencyOwed: Cents | null;
    if (d.subsidy !== null) {
      split = 'file';
      agencyOwed = d.subsidy;
      tenantOwed = d.total - d.subsidy;
    } else if (lease && rrHasSplit && !(lease.subsidyRent && lease.subsidyRent > 0) && !program) {
      // the rent roll carries subsidy columns and this lease has none: the
      // household is the only payer, so the whole balance is theirs
      split = 'market';
      agencyOwed = 0;
      tenantOwed = d.total;
    } else {
      split = 'unknown';
      agencyOwed = null;
      tenantOwed = null;
    }
    const sub = lease?.subsidyRent ?? null;
    households.push({
      key: key(property, d.unit), property, unit: d.unit, name: d.name || lease?.tenant || '',
      program, total: d.total, tenantOwed, agencyOwed, split,
      oldest: oldestBucket(d),
      subsidyMonthsBehind: agencyOwed !== null && agencyOwed > 0 && sub && sub > 0
        ? Math.round((agencyOwed / sub) * 10) / 10 : null,
      onPlan: PLAN_RE.test(d.notes),
      lastPayment: d.lastPayment,
      inRentRoll: !!lease,
    });
  }
  const sumOf = (f: (h: Household) => Cents | null): Cents => households.reduce((s, h) => s + (f(h) ?? 0), 0);
  const owed = {
    total: sumOf((h) => h.total),
    tenant: sumOf((h) => h.tenantOwed),
    agency: sumOf((h) => h.agencyOwed),
    unsplit: sumOf((h) => (h.split === 'unknown' ? h.total : 0)),
    households: households.length,
  };
  if (!delHasSubsidy && !rrHasSplit) {
    limits.push('Neither export has a subsidy column, so balances are shown whole rather than split between household and agency.');
  } else if (!delHasSubsidy) {
    limits.push('The delinquency export has no subsidy-balance column. Balances on subsidized leases are shown as “not split”; balances on leases with no subsidy are counted as the household’s.');
  }
  if (households.some((h) => h.split === 'file') && households.some((h) => h.oldest)) {
    limits.push('Aging buckets in the export cover each household’s whole balance, so the agency side is aged by months of subsidy unpaid instead.');
  }

  // ---- vacancy ----
  const vacantList = rr.filter((r) => r.vacant).map((r) => ({
    property: r.property, unit: r.unit, rent: r.marketRent ?? r.rent,
  }));
  const vacancy = { units: vacantList.length, monthlyRent: vacantList.reduce((s, v) => s + v.rent, 0), list: vacantList };

  // ---- 2. expected vs. received this month ----
  const flags: Flag[] = [];
  let month: Report['month'] = null;
  if (input.receipts) {
    const inMonth = input.receipts.rows.filter((p) => p.date >= monthStart && p.date <= asOf);
    const got = new Map<RentRollRow, { tenant: Cents; agency: Cents }>();
    let unmatched = 0;
    for (const p of inMonth) {
      const lease = rrIndex.find(p.property, p.unit);
      if (!lease) {
        unmatched++;
        flags.push({
          kind: 'unmatched_receipt', property: p.property, unit: p.unit, who: p.payer,
          expected: 0, received: p.amount,
          detail: 'Receipt for a unit that is not on the rent roll. Check it was applied to the right ledger.',
        });
        continue;
      }
      const g = got.get(lease) || { tenant: 0, agency: 0 };
      g[p.payerType] += p.amount;
      got.set(lease, g);
    }
    let eT = 0, eA = 0, eU = 0, rT = 0, rA = 0;
    for (const lease of rr) {
      const g = got.get(lease) || { tenant: 0, agency: 0 };
      rT += g.tenant;
      rA += g.agency;
      if (lease.vacant) {
        if (g.tenant + g.agency > 0) {
          flags.push({
            kind: 'vacant_receipt', property: lease.property, unit: lease.unit, who: '',
            expected: 0, received: g.tenant + g.agency,
            detail: 'Money came in on a unit the rent roll shows as vacant.',
          });
        }
        continue;
      }
      const sub = lease.subsidyRent ?? 0;
      const ten = lease.tenantRent ?? (rrHasSplit ? Math.max(lease.rent - sub, 0) : null);
      if (ten === null) { eU += lease.rent; continue; }
      eT += ten;
      eA += sub;
      const who = lease.tenant;
      if (sub > 0) {
        const prog = lease.program || 'the agency';
        if (g.agency === 0 && dayOfMonth >= agencyGrace) {
          flags.push({
            kind: 'agency_missing', property: lease.property, unit: lease.unit, who: prog,
            expected: sub, received: 0,
            detail: `No payment from ${prog} this month.`,
          });
        } else if (g.agency > 0 && g.agency < sub - 100) {
          flags.push({
            kind: 'agency_short', property: lease.property, unit: lease.unit, who: prog,
            expected: sub, received: g.agency,
            detail: `${prog} paid less than the subsidy on the lease. Possible abatement or a changed contract rent.`,
          });
        }
      }
      if (ten > 0) {
        if (g.tenant === 0 && dayOfMonth > tenantGrace) {
          flags.push({
            kind: 'tenant_none', property: lease.property, unit: lease.unit, who,
            expected: ten, received: 0, detail: 'No household payment yet this month.',
          });
        } else if (g.tenant > 0 && g.tenant < ten - 100) {
          flags.push({
            kind: 'tenant_short', property: lease.property, unit: lease.unit, who,
            expected: ten, received: g.tenant, detail: 'Partial household payment this month.',
          });
        }
      }
      const all = g.tenant + g.agency;
      if (all > ten + sub + 100) {
        flags.push({
          kind: 'overpaid', property: lease.property, unit: lease.unit, who,
          expected: ten + sub, received: all,
          detail: 'More came in than this month’s rent. Likely catching up; confirm it was applied to the oldest balance.',
        });
      }
    }
    month = { expectedTenant: eT, expectedAgency: eA, expectedUnsplit: eU, receivedTenant: rT, receivedAgency: rA };
    if (unmatched) limits.push(`${unmatched} receipt(s) this month did not match a unit on the rent roll.`);
    if (input.receipts.report.missing.includes('Payer Type') && input.receipts.rows.some((p) => p.payerType === 'agency')) {
      limits.push('The receipts export has no payer-type column, so agency payments were recognised by the payer’s name (housing authority, HAP, human services and the like).');
    }
    if (!input.receipts.rows.some((p) => p.payerType === 'agency')) {
      limits.push('No receipts were recognised as agency payments. If agencies pay this portfolio, add a Payer Type column to the receipts export.');
    }
    if (dayOfMonth < agencyGrace) {
      limits.push(`It is before the ${agencyGrace}th, so missing agency payments are not flagged yet.`);
    }
  } else {
    limits.push('No receipts export, so “expected vs. received this month” is not shown.');
  }

  // ---- agencies, grouped: one call covers every household on a program ----
  const agencyMap = new Map<string, AgencyGroup>();
  const touch = (program: string): AgencyGroup => {
    let g = agencyMap.get(program);
    if (!g) {
      g = { program, households: 0, owed: 0, noPaymentThisMonth: 0, worstMonthsBehind: null, units: [] };
      agencyMap.set(program, g);
    }
    return g;
  };
  for (const h of households) {
    if (!h.agencyOwed || h.agencyOwed <= 0) continue;
    const g = touch(h.program || 'Agency (program not on the rent roll)');
    g.households++;
    g.owed += h.agencyOwed;
    g.units.push(h.property ? `${h.property} ${h.unit}` : h.unit);
    if (h.subsidyMonthsBehind !== null) g.worstMonthsBehind = Math.max(g.worstMonthsBehind ?? 0, h.subsidyMonthsBehind);
  }
  for (const f of flags) if (f.kind === 'agency_missing') touch(f.who).noPaymentThisMonth++;
  const agencies = [...agencyMap.values()].sort((a, b) => b.owed - a.owed);

  // ---- 3. what changed ----
  let changes: Change[] | null = null;
  if (input.prior) {
    changes = [];
    const before = new UnitIndex<DelinquencyRow>();
    for (const p of input.prior.rows) before.add(p.property, p.unit, p);
    const seen = new Set<DelinquencyRow>();
    for (const d of input.delinquency.rows) {
      const p = before.find(d.property, d.unit);
      if (p) seen.add(p);
      const was = Math.max(p?.total ?? 0, 0);
      const now = Math.max(d.total, 0);
      const base = { property: d.property || p?.property || '', unit: d.unit, name: d.name, before: was, after: now };
      if (was === 0 && now > 0) changes.push({ ...base, kind: 'new' });
      else if (was > 0 && now === 0) changes.push({ ...base, kind: 'cured' });
      else if (now - was > 100) changes.push({ ...base, kind: 'grew' });
      else if (was - now > 100) changes.push({ ...base, kind: 'shrank' });
    }
    for (const p of input.prior.rows) {
      if (!seen.has(p) && p.total > 0) {
        changes.push({ property: p.property, unit: p.unit, name: p.name, before: p.total, after: 0, kind: 'cured' });
      }
    }
    const order = { new: 0, grew: 1, shrank: 2, cured: 3 };
    changes.sort((a, b) => order[a.kind] - order[b.kind] || Math.abs(b.after - b.before) - Math.abs(a.after - a.before));
  }

  // ---- 4. the ranked follow-up list ----
  const items: Omit<FollowUp, 'rank'>[] = [];
  for (const g of agencies) {
    const behind = g.worstMonthsBehind;
    items.push({
      kind: 'agency', property: '', unit: g.units.join(', '), who: g.program, amount: g.owed,
      age: behind !== null ? `up to ${behind} mo of subsidy` : '',
      why: `${g.households} household${g.households === 1 ? '' : 's'} with an agency balance` +
        (g.noPaymentThisMonth ? `; ${g.noPaymentThisMonth} with no agency payment this month` : ''),
      step: 'One call or email to the agency’s landlord line covering every unit listed; ask for payment status and any abatement or inspection hold.',
      score: g.owed * monthsWeight(behind),
    });
  }
  // missing agency payments on households with no balance yet still need the call
  const agencyNoBal = flags.filter((f) => f.kind === 'agency_missing' && !agencyMap.get(f.who)?.owed);
  for (const f of agencyNoBal) {
    items.push({
      kind: 'agency', property: f.property, unit: f.unit, who: f.who, amount: f.expected, age: 'this month',
      why: f.detail, step: 'Confirm with the agency the payment is scheduled.', score: f.expected,
    });
  }
  for (const h of households) {
    if (h.split === 'unknown') {
      items.push({
        kind: 'confirm', property: h.property, unit: h.unit, who: h.name, amount: h.total, age: h.oldest ?? '',
        why: 'Subsidized lease; the export does not say how much of this is the agency’s.',
        step: 'Confirm the split in AppFolio before contacting the household.',
        score: h.total * (h.oldest ? BUCKET_WEIGHT[h.oldest] : 2),
      });
      continue;
    }
    if (h.tenantOwed && h.tenantOwed > 0) {
      items.push({
        kind: 'tenant', property: h.property, unit: h.unit, who: h.name, amount: h.tenantOwed, age: h.oldest ?? '',
        why: h.onPlan ? 'Household balance; on a payment plan' : 'Household balance',
        step: tenantStep(h.oldest, h.onPlan),
        // a plan being kept is lower priority than an unaddressed balance
        score: h.tenantOwed * (h.oldest ? BUCKET_WEIGHT[h.oldest] : 2) * (h.onPlan ? 0.5 : 1),
      });
    }
  }
  for (const f of flags) {
    if (f.kind === 'agency_short' || f.kind === 'unmatched_receipt' || f.kind === 'vacant_receipt' || f.kind === 'overpaid') {
      const amount = f.kind === 'agency_short' ? f.expected - f.received : f.received;
      items.push({
        kind: 'investigate', property: f.property, unit: f.unit, who: f.who, amount, age: 'this month',
        why: f.detail,
        step: f.kind === 'agency_short' ? 'Check the agency’s remittance for an abatement or rent change.' : 'Check how it was posted in AppFolio.',
        score: amount * (f.kind === 'overpaid' ? 0.5 : 1.5),
      });
    }
  }
  items.sort((a, b) => b.score - a.score || a.unit.localeCompare(b.unit));
  const followUps = items.map((it, i) => ({ ...it, rank: i + 1 }));

  // ---- maintenance ----
  let maintenance: Report['maintenance'] = null;
  if (input.workOrders) {
    const closed = /complet|closed|cancel|done|resolved/i;
    const waiting = /wait|assigned|vendor|parts|scheduled/i;
    const open = input.workOrders.rows.filter((w) => !closed.test(w.status));
    const limit = { urgent: 1, normal: 7, low: 30 };
    const out: MaintItem[] = [];
    let stalled = 0, urgentOverdue = 0;
    for (const w of open) {
      const ageDays = diffDays(asOf, w.created);
      const idleDays = w.updated ? diffDays(asOf, w.updated) : null;
      const overdue = ageDays > limit[w.priority];
      const idle = (idleDays ?? ageDays) >= 7;
      const vendorQuiet = waiting.test(w.status) && (idleDays ?? ageDays) >= 3;
      if (idle) stalled++;
      if (overdue && w.priority === 'urgent') urgentOverdue++;
      if (!overdue && !idle && !vendorQuiet) continue;
      const why = [
        overdue ? (w.priority === 'urgent' ? 'Urgent and open more than a day' : `Open ${ageDays} days`) : '',
        vendorQuiet ? `${w.vendor || 'Vendor'}: no update in ${idleDays ?? ageDays} days` : idle ? `No activity in ${idleDays ?? ageDays} days` : '',
      ].filter(Boolean).join(' · ');
      out.push({ number: w.number, property: w.property, unit: w.unit, description: w.description, priority: w.priority, status: w.status, vendor: w.vendor, ageDays, idleDays, why });
    }
    const pr = { urgent: 0, normal: 1, low: 2 };
    out.sort((a, b) => pr[a.priority] - pr[b.priority] || b.ageDays - a.ageDays);
    maintenance = { open: open.length, stalled, urgentOverdue, items: out };
  }

  const files = [input.rentRoll.report, input.delinquency.report];
  if (input.receipts) files.push(input.receipts.report);
  if (input.prior) files.push(input.prior.report);
  if (input.workOrders) files.push(input.workOrders.report);
  const orphan = households.filter((h) => !h.inRentRoll).length;
  if (orphan) limits.push(`${orphan} balance(s) belong to units not on the rent roll (often former residents); they are listed but cannot be split.`);

  return {
    asOf, monthStart, owed, month, vacancy, households, agencies, flags, followUps, changes, maintenance, files, limits,
  };
}

/** One-paragraph summary for the top of the report and the email body. */
export function summarize(r: Report, usd: (c: Cents) => string): string {
  const parts: string[] = [];
  parts.push(`${usd(r.owed.total)} is owed across ${r.owed.households} household${r.owed.households === 1 ? '' : 's'}`);
  const split: string[] = [];
  if (r.owed.tenant) split.push(`${usd(r.owed.tenant)} by households`);
  if (r.owed.agency) split.push(`${usd(r.owed.agency)} by housing agencies`);
  if (r.owed.unsplit) split.push(`${usd(r.owed.unsplit)} not split`);
  let s = parts[0]! + (split.length ? ` (${split.join(', ')})` : '') + '.';
  if (r.month) {
    const exp = r.month.expectedTenant + r.month.expectedAgency + r.month.expectedUnsplit;
    const got = r.month.receivedTenant + r.month.receivedAgency;
    s += ` This month ${usd(got)} has come in against ${usd(exp)} expected.`;
  }
  const top = r.followUps.slice(0, 3).map((f) => f.kind === 'agency' ? f.who : `${f.property ? f.property + ' ' : ''}${f.unit}`);
  if (top.length) s += ` Start with: ${top.join('; ')}.`;
  return s;
}

