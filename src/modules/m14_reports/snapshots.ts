import { q, q1, insert, run, val, j, js } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, addMonths, monthKey } from '../../lib/dates.ts';
import { sysCtx, type Ctx } from '../../lib/auth.ts';
import { registerJob } from '../../lib/jobs.ts';
import { occupancyAt, agingAsOf } from './asof.ts';

/** MetricSnapshot nightly rollups (M14.2): one row per property per day with
 * the operational KPIs, so trend reports read a stable fact table. Historical
 * points can always be recomputed from effective-dated facts — the snapshot
 * is a cache with one definition (docs/metrics.md), not a second truth. */

export interface DayMetrics {
  rentable: number;
  occupied: number;
  notice: number;
  vacant: number;
  occupancy_pct: number;
  exposure_pct: number;
  delinquent_cents: number;
  delinquent_households: number;
  avg_inplace_rent_cents: number;
  avg_market_rent_cents: number;
  open_wos: number;
}

export function computeDayMetrics(ctx: Ctx, propertyId: string, d: string): DayMetrics {
  const occ = occupancyAt(ctx, propertyId, d);
  const aging = agingAsOf(ctx, propertyId, d);
  const dd = d.replaceAll("'", '');
  const inPlace = val<number>(
    `SELECT AVG(l.rent_cents) FROM leases l WHERE l.org_id=? AND l.property_id=?
       AND l.status NOT IN ('draft','out_for_signature','partially_signed','fully_executed','canceled')
       AND COALESCE(l.move_in_date, l.start_date) <= '${dd}'
       AND (CASE WHEN l.status='ended' THEN COALESCE(l.move_out_date, l.end_date) >= '${dd}'
                 WHEN l.status='renewed' THEN l.end_date >= '${dd}' ELSE 1=1 END)`,
    ctx.orgId, propertyId,
  ) || 0;
  const market = val<number>('SELECT AVG(market_rent_cents) FROM units WHERE property_id=?', propertyId) || 0;
  const openWos = val<number>(
    `SELECT COUNT(*) FROM work_orders WHERE property_id=? AND created_date <= ? AND (completed_date IS NULL OR completed_date > ?) AND status != 'canceled'`,
    propertyId, dd, dd,
  ) || 0;
  return {
    rentable: occ.rentable,
    occupied: occ.occupied,
    notice: occ.notice,
    vacant: occ.vacant,
    occupancy_pct: occ.occupancyPct,
    exposure_pct: occ.exposurePct,
    delinquent_cents: aging.reduce((s, a) => s + a.balance, 0),
    delinquent_households: aging.length,
    avg_inplace_rent_cents: Math.round(inPlace),
    avg_market_rent_cents: Math.round(market),
    open_wos: openWos,
  };
}

export function snapshotDay(ctx: Ctx, propertyId: string, d: string): void {
  const metrics = computeDayMetrics(ctx, propertyId, d);
  const existing = q1<any>('SELECT id FROM metric_snapshots WHERE property_id=? AND date=?', propertyId, d);
  if (existing) {
    run('UPDATE metric_snapshots SET metrics=? WHERE id=?', js(metrics), existing.id);
  } else {
    insert('metric_snapshots', {
      id: id('msn'), org_id: ctx.orgId, property_id: propertyId, date: d,
      metrics: js(metrics), created_at: nowIso(),
    });
  }
}

/** month-end snapshots for the trailing N months + today (seed backfill) */
export function backfillSnapshots(orgId: string, months = 15): number {
  const ctx = sysCtx(orgId);
  const props = q<any>('SELECT id FROM properties WHERE org_id=?', orgId);
  let n = 0;
  for (let i = months; i >= 1; i--) {
    // last day of each trailing month
    const eom = `${monthKey(addMonths(ctx.businessDate, -i + 1))}-01`;
    const d = new Date(Date.parse(eom) - 86400000).toISOString().slice(0, 10);
    for (const p of props) {
      snapshotDay(ctx, p.id, d);
      n++;
    }
  }
  for (const p of props) {
    snapshotDay(ctx, p.id, ctx.businessDate);
    n++;
  }
  return n;
}

/** trend series for reports: month-end snapshot per trailing month */
export function snapshotSeries(ctx: Ctx, propertyId: string, months: number): { date: string; m: DayMetrics }[] {
  const rows = q<any>(
    `SELECT date, metrics FROM metric_snapshots WHERE property_id=? ORDER BY date`,
    propertyId,
  );
  const byMonth = new Map<string, { date: string; m: DayMetrics }>();
  for (const r of rows) byMonth.set(monthKey(r.date), { date: r.date, m: j<DayMetrics>(r.metrics, {} as DayMetrics) });
  const out: { date: string; m: DayMetrics }[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const mk = monthKey(addMonths(ctx.businessDate, -i));
    const hit = byMonth.get(mk);
    if (hit) out.push(hit);
  }
  return out;
}

registerJob({
  key: 'metric_snapshots',
  name: 'Nightly metric snapshots',
  describe: 'Rolls up per-property operational KPIs (occupancy, exposure, delinquency, rents, open work) into the MetricSnapshot fact table reports read.',
  run: (ctx, date) => {
    const props = q<any>('SELECT id FROM properties WHERE org_id=?', ctx.orgId);
    for (const p of props) snapshotDay(ctx, p.id, date);
    return `${props.length} properties snapshotted`;
  },
});
