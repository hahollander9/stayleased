import { q, val } from '../../lib/db.ts';
import type { Ctx } from '../../lib/auth.ts';

/** Effective-dated facts (M14.2): operational truth reproducible for ANY
 * historical date. Leases carry start/end/move-in/move-out dates, charges and
 * payments carry business dates — so "as of D" is a query shape, not a
 * snapshot lookup. docs/metrics.md defines each rule. */

/** leases in possession at date D (physical occupancy) */
const IN_POSSESSION = `
  l.org_id=? AND l.status NOT IN ('draft','out_for_signature','partially_signed','fully_executed','canceled')
  AND COALESCE(l.move_in_date, l.start_date) <= :d
  AND (
    CASE
      WHEN l.status IN ('ended') THEN COALESCE(l.move_out_date, l.end_date) >= :d
      WHEN l.status IN ('renewed') THEN l.end_date >= :d
      ELSE 1=1  -- active/month_to_month/notice: still in possession today
    END
  )`;

function posSql(alias = 'l'): string {
  return IN_POSSESSION.replaceAll('l.', `${alias}.`);
}

export interface RentRollRow {
  lease_id: string;
  unit_id: string;
  unit_number: string;
  floorplan: string | null;
  property_id: string;
  property_name: string;
  household_name: string;
  status_at: string;
  start_date: string;
  end_date: string;
  rent_cents: number;
  deposit_cents: number;
  balance_cents: number;
}

/** the rent roll as of date D — one row per lease in possession at D */
export function rentRollAsOf(ctx: Ctx, propertyId: string | null, d: string): RentRollRow[] {
  // :d occurs 3× in posSql and binds before the optional property filter
  const params: unknown[] = [ctx.orgId, d, d, d];
  let pSql = '';
  if (propertyId) { pSql = ' AND l.property_id=?'; params.push(propertyId); }
  const leases = q<any>(
    `SELECT l.*, u.unit_number, p.name AS property_name, f.name AS floorplan
     FROM leases l JOIN units u ON u.id=l.unit_id
     LEFT JOIN floorplans f ON f.id=u.floorplan_id
     JOIN properties p ON p.id=l.property_id
     WHERE ${posSql()}${pSql}
     ORDER BY p.name, u.unit_number`.replaceAll(':d', '?'),
    ...params,
  );
  return leases.map((l) => ({
    lease_id: l.id,
    unit_id: l.unit_id,
    unit_number: l.unit_number,
    floorplan: l.floorplan,
    property_id: l.property_id,
    property_name: l.property_name,
    household_name: l.household_name,
    status_at: statusAt(l, d),
    start_date: l.start_date,
    end_date: l.end_date,
    rent_cents: l.rent_cents,
    deposit_cents: l.deposit_alternative ? 0 : l.deposit_cents,
    balance_cents: leaseBalanceAsOf(ctx, l.id, d),
  }));
}

/** what the lease's status WAS at date D, derived from effective dates */
export function statusAt(l: any, d: string): string {
  if (l.end_date < d) {
    if (l.status === 'month_to_month' || (l.mtm_since && l.mtm_since <= d)) return 'month_to_month';
    if (['active', 'notice'].includes(l.status)) return 'month_to_month'; // holdover window before status caught up
    return l.status; // ended/renewed
  }
  if (l.notice_date && l.notice_date <= d) return 'notice';
  return 'active';
}

/** payments that were good AS OF d: received by then, and not yet NSF'd by then */
const GOOD_PAYMENT_AT = `p.received_date <= :d AND (p.status IN ('pending','settled') OR (p.status='nsf' AND COALESCE(p.nsf_date,'9999') > :d))`;

/** open balance as of D: active charges dated ≤ D minus good payments received ≤ D */
export function leaseBalanceAsOf(ctx: Ctx, leaseId: string, d: string): number {
  const charges = val<number>(
    `SELECT COALESCE(SUM(amount_cents),0) FROM charges WHERE org_id=? AND lease_id=? AND status='active' AND date <= ?`,
    ctx.orgId, leaseId, d,
  ) || 0;
  const payments = val<number>(
    `SELECT COALESCE(SUM(p.amount_cents),0) FROM payments p WHERE p.org_id=? AND p.lease_id=? AND ${GOOD_PAYMENT_AT}`.replaceAll(':d', '?'),
    ctx.orgId, leaseId, d, d, // GOOD_PAYMENT_AT binds :d twice
  ) || 0;
  return charges - payments;
}

export interface OccupancyAt {
  rentable: number;
  occupied: number;
  notice: number;
  vacant: number;
  occupancyPct: number;
  exposurePct: number; // vacant + on-notice not yet re-leased
}

/** physical occupancy + exposure at date D from effective-dated leases */
export function occupancyAt(ctx: Ctx, propertyId: string, d: string): OccupancyAt {
  const rentable = val<number>(
    `SELECT COUNT(*) FROM units WHERE property_id=? AND status NOT IN ('model','down')`, propertyId,
  ) || 0;
  const occupied = val<number>(
    `SELECT COUNT(DISTINCT l.unit_id) FROM leases l WHERE ${posSql()} AND l.property_id=?`.replaceAll(':d', '?'),
    ctx.orgId, d, d, d, propertyId, // posSql :d ×3, then property filter
  ) || 0;
  const notice = val<number>(
    `SELECT COUNT(DISTINCT l.unit_id) FROM leases l WHERE ${posSql()} AND l.property_id=? AND l.notice_date IS NOT NULL AND l.notice_date <= ?
       AND NOT EXISTS (SELECT 1 FROM leases n WHERE n.unit_id=l.unit_id AND n.id != l.id AND n.status NOT IN ('draft','canceled') AND n.start_date > ?)`.replaceAll(':d', '?'),
    ctx.orgId, d, d, d, propertyId, d, d, // posSql :d ×3, property, notice_date, start_date
  ) || 0;
  const vacant = Math.max(0, rentable - occupied);
  return {
    rentable, occupied, notice, vacant,
    occupancyPct: rentable ? Math.round((occupied / rentable) * 1000) / 10 : 0,
    exposurePct: rentable ? Math.round(((vacant + notice) / rentable) * 1000) / 10 : 0,
  };
}

export interface AgingAsOfRow {
  lease_id: string;
  household_name: string;
  unit_number: string;
  property_id: string;
  property_name: string;
  balance: number;
  current: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  d90p: number;
  latest_note: string | null;
}

/** delinquency aging as of D — FIFO application of good payments to charges by due date */
export function agingAsOf(ctx: Ctx, propertyId: string | null, d: string): AgingAsOfRow[] {
  // :d (as c.date) binds after org_id and before the optional property filter
  const params: unknown[] = [ctx.orgId, d];
  let pSql = '';
  if (propertyId) { pSql = ' AND l.property_id=?'; params.push(propertyId); }
  // a receivable outlives possession: include any lease that had activity by D
  // (matches the live workbench, which lists ended leases with balances)
  const leases = q<any>(
    `SELECT l.id, l.household_name, l.property_id, u.unit_number, p.name AS property_name
     FROM leases l JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=l.property_id
     WHERE l.org_id=? AND l.status IN ('active','month_to_month','notice','ended','renewed')
       AND EXISTS (SELECT 1 FROM charges c WHERE c.lease_id=l.id AND c.date <= ?)${pSql}`,
    ...params,
  );
  const out: AgingAsOfRow[] = [];
  for (const l of leases) {
    const bal = leaseBalanceAsOf(ctx, l.id, d);
    if (bal <= 0) continue;
    // per-charge applied amount as of D, from actual application rows (mirrors the live workbench, date-bounded)
    const openCharges = q<any>(
      `SELECT c.due_date, c.amount_cents,
        (SELECT COALESCE(SUM(pa.amount_cents),0) FROM payment_applications pa
          JOIN payments p ON p.id=pa.payment_id AND ${GOOD_PAYMENT_AT}
         WHERE pa.charge_id=c.id) AS applied
       FROM charges c
       WHERE c.org_id=? AND c.lease_id=? AND c.status='active' AND c.amount_cents>0 AND c.date <= ?
       ORDER BY c.due_date`.replaceAll(':d', '?'),
      d, d, ctx.orgId, l.id, d, // GOOD_PAYMENT_AT (:d ×2) is in the SELECT subquery, ahead of the WHERE binds
    );
    const row: AgingAsOfRow = {
      lease_id: l.id, household_name: l.household_name, unit_number: l.unit_number,
      property_id: l.property_id, property_name: l.property_name,
      balance: bal, current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90p: 0,
      latest_note: null,
    };
    let remaining = bal;
    for (const c of openCharges) {
      if (remaining <= 0) break;
      const open = Math.min(c.amount_cents - c.applied, remaining);
      if (open <= 0) continue;
      remaining -= open;
      const age = Math.round((Date.parse(d) - Date.parse(c.due_date)) / 86400000);
      if (age <= 0) row.current += open;
      else if (age <= 30) row.d1_30 += open;
      else if (age <= 60) row.d31_60 += open;
      else if (age <= 90) row.d61_90 += open;
      else row.d90p += open;
    }
    if (remaining > 0) row.current += remaining;
    row.latest_note = val<string>(
      `SELECT body FROM delinquency_notes WHERE lease_id=? ORDER BY created_at DESC LIMIT 1`, l.id,
    ) || null;
    out.push(row);
  }
  return out.sort((a, b) => b.balance - a.balance);
}
