import { q, q1, val, j } from '../../lib/db.ts';
import { propFilter, type Ctx } from '../../lib/auth.ts';

/** M2 services: portfolio/unit math used by dashboards, quotes, pricing and
 * reports. KPI definitions live in docs/metrics.md (kept current):
 * rentable = units − down − model; physical occupancy = occupied+notice ÷ rentable;
 * exposure = (vacant + notice-not-preleased) ÷ rentable. */

export interface UnitStats {
  total: number;
  rentable: number;
  occupied: number; // includes notice (still physically occupied)
  notice: number;
  vacantReady: number;
  vacantNotReady: number;
  down: number;
  model: number;
  occupancyPct: number;
  exposureCount: number;
  exposurePct: number;
  avgMarketRentCents: number;
}

export function unitStats(ctx: Ctx, propertyId?: string | null): UnitStats {
  const pf = propertyId
    ? { sql: ' AND property_id = ?', params: [propertyId] }
    : propFilter(ctx);
  const rows = q<{ status: string; n: number; rent: number }>(
    `SELECT status, COUNT(*) AS n, AVG(market_rent_cents) AS rent FROM units WHERE org_id=?${pf.sql} GROUP BY status`,
    ctx.orgId,
    ...pf.params,
  );
  const by: Record<string, number> = {};
  for (const r of rows) by[r.status] = r.n;
  const total = rows.reduce((s, r) => s + r.n, 0);
  const down = by['down'] || 0;
  const model = by['model'] || 0;
  const notice = by['notice'] || 0;
  const occupiedOnly = by['occupied'] || 0;
  const vacantReady = by['vacant_ready'] || 0;
  const vacantNotReady = by['vacant_not_ready'] || 0;
  const rentable = total - down - model;
  const occupied = occupiedOnly + notice;
  // preleases (future leases on notice/vacant units) reduce exposure — wired in Phase 9
  const preleased = val<number>(
    `SELECT COUNT(DISTINCT l.unit_id) FROM leases l JOIN units u ON u.id=l.unit_id
     WHERE l.org_id=? AND l.status IN ('fully_executed','partially_signed','draft') AND u.status IN ('notice','vacant_ready','vacant_not_ready')${pf.sql.replaceAll('property_id', 'u.property_id')}`,
    ctx.orgId,
    ...pf.params,
  ) || 0;
  const exposureCount = Math.max(0, vacantReady + vacantNotReady + notice - preleased);
  const avg = val<number>(`SELECT AVG(market_rent_cents) FROM units WHERE org_id=?${pf.sql}`, ctx.orgId, ...pf.params) || 0;
  return {
    total, rentable, occupied, notice, vacantReady, vacantNotReady, down, model,
    occupancyPct: rentable ? Math.round((occupied / rentable) * 1000) / 10 : 0,
    exposureCount,
    exposurePct: rentable ? Math.round((exposureCount / rentable) * 1000) / 10 : 0,
    avgMarketRentCents: Math.round(avg),
  };
}

export interface FloorplanRow {
  id: string;
  name: string;
  beds: number;
  baths: number;
  sqft: number;
  market_rent_cents: number;
  units: number;
  available: number;
  occupied: number;
  exposure: number;
}

export function floorplanAvailability(ctx: Ctx, propertyId: string): FloorplanRow[] {
  return q<FloorplanRow>(
    `SELECT f.id, f.name, f.beds, f.baths, f.sqft, f.market_rent_cents,
      (SELECT COUNT(*) FROM units u WHERE u.floorplan_id=f.id) AS units,
      (SELECT COUNT(*) FROM units u WHERE u.floorplan_id=f.id AND u.status='vacant_ready') AS available,
      (SELECT COUNT(*) FROM units u WHERE u.floorplan_id=f.id AND u.status IN ('occupied','notice')) AS occupied,
      (SELECT COUNT(*) FROM units u WHERE u.floorplan_id=f.id AND u.status IN ('vacant_ready','vacant_not_ready','notice')) AS exposure
     FROM floorplans f WHERE f.org_id=? AND f.property_id=? ORDER BY f.market_rent_cents`,
    ctx.orgId,
    propertyId,
  );
}

export interface PropertySummary {
  id: string;
  name: string;
  slug: string;
  type: string;
  city: string;
  state: string;
  timezone: string;
  stats: UnitStats;
}

export function propertySummaries(ctx: Ctx): PropertySummary[] {
  const pf = propFilter(ctx, 'id');
  const props = q<any>(`SELECT * FROM properties WHERE org_id=?${pf.sql} ORDER BY name`, ctx.orgId, ...pf.params);
  return props.map((p) => ({ ...p, stats: unitStats(ctx, p.id) }));
}

/** effective market rent = floorplan base + unit amenity premiums */
export function effectiveMarketRent(fpRentCents: number, amenities: { name: string; premium_cents: number }[]): number {
  return fpRentCents + amenities.reduce((s, a) => s + (a.premium_cents || 0), 0);
}

export function unitAmenities(unit: { amenities: string }): { name: string; premium_cents: number }[] {
  return j<{ name: string; premium_cents: number }[]>(unit.amenities, []);
}

export const UNIT_STATUSES = ['vacant_ready', 'vacant_not_ready', 'occupied', 'notice', 'down', 'model'] as const;
export const UNIT_STATUS_LABELS: Record<string, string> = {
  vacant_ready: 'Vacant · ready',
  vacant_not_ready: 'Vacant · not ready',
  occupied: 'Occupied',
  notice: 'On notice',
  down: 'Down',
  model: 'Model',
};
