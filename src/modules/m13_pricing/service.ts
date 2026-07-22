import { q, q1, insert, run, val, tx, j, js } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, addDays, addMonths, monthKey, diffDays, fmtMonth } from '../../lib/dates.ts';
import type { Ctx } from '../../lib/auth.ts';
import { emit } from '../../lib/events.ts';
import { audit } from '../../lib/audit.ts';
import { getSetting } from '../../lib/settings.ts';
import { registerJob } from '../../lib/jobs.ts';
import { GLOBAL_SEED } from '../../lib/rng.ts';
import { usd } from '../../lib/money.ts';
import { maxTenantRent } from '../m18_verticals/service.ts';

/** M13 — revenue intelligence: a transparent rules+heuristics pricing engine.
 * Every recommendation carries its factor breakdown; nothing is a black box. */

function strSeed(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(0 + i)) >>> 0;
  return (h ^ GLOBAL_SEED) >>> 0;
}

// ---------- comp market simulator (M13.2) ----------

export const COMP_NAMES: Record<string, [string, number][]> = {
  'summit-ridge': [['The Overlook at Bear Creek', 0.6], ['Alta Prairie Flats', 1.2], ['Sagebrush Commons', 1.8]],
  'foundry-lofts': [['The Steelyard Lofts', 0.4], ['Riverline Modern', 0.9], ['Union Junction Apts', 1.5]],
  'cardinal-commons': [['Campus Pointe West', 0.3], ['The Quad at 5th', 0.7], ['ScholarHouse', 1.1]],
};

export function ensureCompSets(orgId: string): void {
  if (q1('SELECT id FROM comp_sets WHERE org_id=? LIMIT 1', orgId)) return;
  for (const p of q<any>('SELECT id, slug FROM properties WHERE org_id=?', orgId)) {
    for (const [name, miles] of COMP_NAMES[p.slug] || [['Nearby Community A', 0.8], ['Nearby Community B', 1.4]]) {
      insert('comp_sets', {
        id: id('cmp'), org_id: orgId, property_id: p.id, name, distance_miles: miles,
        year_built: 2000 + (strSeed(name) % 22), notes: null, active: 1, created_at: nowIso(),
      });
    }
  }
}

/** deterministic monthly comp observations with realistic drift */
export function generateCompObservations(orgId: string, month: string): number {
  let added = 0;
  const comps = q<any>(
    `SELECT c.*, p.slug FROM comp_sets c JOIN properties p ON p.id=c.property_id WHERE c.org_id=? AND c.active=1`,
    orgId,
  );
  for (const c of comps) {
    // reference: our own avg market rent per bed count at that property
    for (const beds of q<any>('SELECT DISTINCT beds FROM floorplans WHERE property_id=?', c.property_id).map((x) => x.beds)) {
      if (q1('SELECT id FROM comp_observations WHERE comp_id=? AND month_key=? AND beds=?', c.id, month, beds)) continue;
      const ourAvg = val<number>('SELECT AVG(market_rent_cents) FROM floorplans WHERE property_id=? AND beds=?', c.property_id, beds) || 150000;
      const compBias = ((strSeed(c.id) % 17) - 8) / 100; // each comp sits ±8% around us, stable
      const m = Number(month.slice(5, 7));
      const season = 1 + (m >= 5 && m <= 8 ? 0.015 : m === 12 || m <= 2 ? -0.012 : 0);
      const yearDrift = 1 + (Number(month.slice(0, 4)) - 2025) * 0.032; // ~3.2%/yr market growth
      const wobble = 1 + (((strSeed(c.id + month + beds) % 30) - 15) / 1000);
      const rent = Math.round((ourAvg * (1 + compBias) * season * yearDrift * wobble) / 500) * 500;
      insert('comp_observations', {
        id: id('cob'), org_id: orgId, comp_id: c.id, month_key: month, beds,
        rent_cents: rent, concession_note: strSeed(c.id + month) % 7 === 0 ? '1/2 month free on 13+ mo' : null,
        source: 'market_sim', created_at: nowIso(),
      });
      added++;
    }
  }
  return added;
}

export function compAverage(orgId: string, propertyId: string, beds: number, month: string): number | null {
  return val<number>(
    `SELECT AVG(o.rent_cents) FROM comp_observations o JOIN comp_sets c ON c.id=o.comp_id
     WHERE c.property_id=? AND o.beds=? AND o.month_key=?`,
    propertyId, beds, month,
  ) || null;
}

// ---------- the pricing engine (M13.1) ----------

export interface Factor {
  label: string;
  delta_cents: number;
}

export interface UnitRec {
  unitId: string;
  base: number;
  recommended: number;
  factors: Factor[];
}

/** exposure = (vacant + on-notice) / total for the unit's floorplan */
function floorplanExposure(propertyId: string, floorplanId: string): { pct: number; target: number } {
  const total = val<number>('SELECT COUNT(*) FROM units WHERE floorplan_id=?', floorplanId) || 1;
  const exposed = val<number>(
    `SELECT COUNT(*) FROM units u WHERE u.floorplan_id=? AND (u.status LIKE 'vacant%' OR EXISTS (
        SELECT 1 FROM leases l WHERE l.unit_id=u.id AND l.status='notice'))`,
    floorplanId,
  ) || 0;
  return { pct: Math.round((exposed / total) * 100), target: 7 };
}

export function priceUnit(ctx: Ctx, unit: any, date: string): UnitRec {
  const factors: Factor[] = [];
  const base = unit.market_rent_cents as number;

  // exposure vs target
  const { pct, target } = floorplanExposure(unit.property_id, unit.floorplan_id);
  if (pct > target + 8) {
    const cut = -Math.round((base * Math.min(0.06, (pct - target) * 0.004)) / 100) * 100;
    factors.push({ label: `exposure ${pct}% far above ${target}% target`, delta_cents: cut });
  } else if (pct > target) {
    const cut = -Math.round((base * 0.015) / 100) * 100;
    factors.push({ label: `exposure ${pct}% above ${target}% target`, delta_cents: cut });
  } else if (pct < Math.max(2, target - 4)) {
    const bump = Math.round((base * 0.02) / 100) * 100;
    factors.push({ label: `exposure ${pct}% below ${target}% target — demand headroom`, delta_cents: bump });
  }

  // days-vacant aging
  const lastEnd = val<string>(
    `SELECT MAX(COALESCE(move_out_date, end_date)) FROM leases WHERE unit_id=? AND status IN ('ended','renewed')`,
    unit.id,
  );
  if (unit.status?.startsWith('vacant') && lastEnd) {
    const daysVacant = Math.max(0, diffDays(date, lastEnd));
    if (daysVacant > 60) factors.push({ label: `vacant ${daysVacant} days`, delta_cents: -Math.round((base * 0.035) / 100) * 100 });
    else if (daysVacant > 30) factors.push({ label: `vacant ${daysVacant} days`, delta_cents: -Math.round((base * 0.02) / 100) * 100 });
  }

  // seasonality
  const m = Number(date.slice(5, 7));
  if (m >= 5 && m <= 8) factors.push({ label: 'peak leasing season', delta_cents: Math.round((base * 0.012) / 100) * 100 });
  else if (m === 12 || m <= 2) factors.push({ label: 'winter slow season', delta_cents: -Math.round((base * 0.012) / 100) * 100 });

  // comp positioning
  const fp = q1<any>('SELECT beds FROM floorplans WHERE id=?', unit.floorplan_id);
  const comp = compAverage(ctx.orgId, unit.property_id, fp?.beds ?? 1, monthKey(date))
    || compAverage(ctx.orgId, unit.property_id, fp?.beds ?? 1, monthKey(addMonths(date, -1)));
  if (comp) {
    const gap = (base - comp) / comp;
    if (gap > 0.05) factors.push({ label: `priced ${Math.round(gap * 100)}% above comp set avg ${usd(Math.round(comp))}`, delta_cents: -Math.round((base * Math.min(0.03, gap / 2)) / 100) * 100 });
    else if (gap < -0.05) factors.push({ label: `priced ${Math.round(-gap * 100)}% below comp set avg ${usd(Math.round(comp))}`, delta_cents: Math.round((base * Math.min(0.03, -gap / 2)) / 100) * 100 });
  }

  // guardrail: max daily move ±5%
  let delta = factors.reduce((s, f) => s + f.delta_cents, 0);
  const cap = Math.round((base * 0.05) / 100) * 100;
  if (Math.abs(delta) > cap) {
    factors.push({ label: 'guardrail: capped at ±5% per review', delta_cents: (delta > 0 ? cap : -cap) - delta });
    delta = delta > 0 ? cap : -cap;
  }
  const recommended = Math.round((base + delta) / 500) * 500;
  return { unitId: unit.id, base, recommended, factors };
}

/** nightly: refresh recommendations for available units (queue is per day) */
export function runPricingEngine(ctx: Ctx, date: string): number {
  ensureCompSets(ctx.orgId);
  generateCompObservations(ctx.orgId, monthKey(date));
  const units = q<any>(
    `SELECT u.* FROM units u WHERE u.org_id=? AND u.program IS NULL AND (u.status LIKE 'vacant%' OR EXISTS (
       SELECT 1 FROM leases l WHERE l.unit_id=u.id AND l.status='notice'))`,
    ctx.orgId,
  ); // program (affordable) units are rent-limited by regulation, never engine-priced
  let created = 0;
  for (const unit of units) {
    const existing = q1<any>(
      `SELECT id FROM price_recommendations WHERE unit_id=? AND date=? AND term_months=12 AND status='pending'`,
      unit.id, date,
    );
    if (existing) continue;
    // expire stale pending recs for this unit
    run(`UPDATE price_recommendations SET status='expired' WHERE unit_id=? AND status='pending'`, unit.id);
    const rec = priceUnit(ctx, unit, date);
    if (rec.recommended === rec.base) continue; // nothing to review
    insert('price_recommendations', {
      id: id('prc'), org_id: ctx.orgId, property_id: unit.property_id, unit_id: unit.id,
      date, term_months: 12, current_rent_cents: rec.base, recommended_rent_cents: rec.recommended,
      factors: js(rec.factors), status: 'pending', created_at: nowIso(),
    });
    created++;
  }
  return created;
}

// ---------- term-rate matrix + expiration smoothing (M13.3) ----------

export function expirationLoad(ctx: Ctx, propertyId: string): Map<string, number> {
  const rows = q<any>(
    `SELECT substr(end_date, 1, 7) AS mk, COUNT(*) AS n FROM leases
     WHERE property_id=? AND status IN ('active','notice') GROUP BY mk`,
    propertyId,
  );
  return new Map(rows.map((r) => [r.mk as string, Number(r.n)]));
}

export interface TermRate {
  term: number;
  rent: number;
  expiresMonth: string;
  loadFactor: 'high' | 'normal' | 'low';
  adj: number;
}

/** vary rent by term to steer expirations away from over-loaded months */
export function termRateMatrix(ctx: Ctx, unit: any, date: string, baseRent?: number): TermRate[] {
  const base = baseRent ?? q1<any>(
    `SELECT accepted_rent_cents FROM price_recommendations WHERE unit_id=? AND term_months=12 AND status='accepted' ORDER BY date DESC LIMIT 1`,
    unit.id,
  )?.accepted_rent_cents ?? unit.market_rent_cents;
  const load = expirationLoad(ctx, unit.property_id);
  const counts = [...load.values()].sort((a, b) => a - b);
  const p75 = counts[Math.floor(counts.length * 0.75)] || 10;
  const p25 = counts[Math.floor(counts.length * 0.25)] || 2;
  const out: TermRate[] = [];
  for (let term = 2; term <= 14; term++) {
    const expires = monthKey(addMonths(date, term));
    const n = load.get(expires) || 0;
    // short terms carry a premium; long terms a small discount
    let adj = term <= 6 ? 0.07 - (term - 2) * 0.008 : term <= 11 ? 0.02 - (term - 7) * 0.005 : term === 12 ? 0 : -0.005;
    let loadFactor: TermRate['loadFactor'] = 'normal';
    if (n >= p75) {
      adj += 0.025; // discourage stacking more expirations here
      loadFactor = 'high';
    } else if (n <= p25) {
      adj -= 0.015; // steer into the light month
      loadFactor = 'low';
    }
    out.push({
      term, expiresMonth: expires, loadFactor, adj: Math.round(adj * 1000) / 10,
      rent: Math.round((base * (1 + adj)) / 500) * 500,
    });
  }
  return out;
}

// ---------- approval workflow (M13.4) ----------

export function decideRecommendation(
  ctx: Ctx,
  recId: string,
  action: 'accept' | 'override' | 'reject',
  opts: { amountCents?: number; reason?: string } = {},
): void {
  const rec = q1<any>('SELECT * FROM price_recommendations WHERE id=? AND org_id=?', recId, ctx.orgId);
  if (!rec || rec.status !== 'pending') throw new Error('recommendation is not pending');
  if (action === 'reject') {
    run(`UPDATE price_recommendations SET status='expired', decided_by=?, decided_at=?, override_reason=? WHERE id=?`, ctx.userName, nowIso(), opts.reason || 'rejected', recId);
    audit(ctx, 'price_recommendation', recId, 'reject', null, { reason: opts.reason });
    return;
  }
  const finalCents = action === 'accept' ? rec.recommended_rent_cents : opts.amountCents;
  if (!finalCents || finalCents <= 0) throw new Error('override needs an amount');
  if (action === 'override' && !(opts.reason || '').trim()) throw new Error('an override needs a written reason');
  tx(() => {
    run(
      `UPDATE price_recommendations SET status=?, accepted_rent_cents=?, decided_by=?, decided_at=?, override_reason=? WHERE id=?`,
      action === 'accept' ? 'accepted' : 'overridden', finalCents, ctx.userName, nowIso(), opts.reason || null, recId,
    );
    const unit = q1<any>('SELECT * FROM units WHERE id=?', rec.unit_id);
    if (unit && unit.market_rent_cents !== finalCents) {
      insert('price_changes', {
        id: id('pch'), org_id: ctx.orgId, property_id: rec.property_id, unit_id: rec.unit_id,
        date: ctx.businessDate, old_cents: unit.market_rent_cents, new_cents: finalCents,
        source: 'pricing_queue', recommendation_id: recId, reason: opts.reason || null,
        changed_by: ctx.userName, created_at: nowIso(),
      });
      run('UPDATE units SET market_rent_cents=? WHERE id=?', finalCents, rec.unit_id);
    }
  });
  emit(ctx, 'price.accepted', 'unit', rec.unit_id, { recId, cents: finalCents });
  audit(ctx, 'price_recommendation', recId, action, null, { cents: finalCents, reason: opts.reason });
}

export function acceptAll(ctx: Ctx, propertyId?: string | null): number {
  const pend = q<any>(
    `SELECT id FROM price_recommendations WHERE org_id=? AND status='pending' AND term_months=12${propertyId ? ' AND property_id=?' : ''}`,
    ...(propertyId ? [ctx.orgId, propertyId] : [ctx.orgId]),
  );
  for (const p of pend) decideRecommendation(ctx, p.id, 'accept');
  return pend.length;
}

// ---------- renewal batch pricing (M13.5) ----------

/** batch-generate accepted term-matrix recommendations for expiring leases —
 * capped by org policy; m6 renewal offers consume these directly */
export function runRenewalBatch(ctx: Ctx, propertyId: string, windowDays = 120): number {
  const leases = q<any>(
    `SELECT l.*, u.market_rent_cents AS unit_market, u.id AS uid FROM leases l JOIN units u ON u.id=l.unit_id
     WHERE l.org_id=? AND l.property_id=? AND l.status='active' AND l.end_date BETWEEN ? AND ?`,
    ctx.orgId, propertyId, ctx.businessDate, addDays(ctx.businessDate, windowDays),
  );
  const capPct = getSetting<number>(ctx, 'renewal_max_increase_pct', propertyId);
  let priced = 0;
  for (const l of leases) {
    const unit = q1<any>('SELECT * FROM units WHERE id=?', l.uid);
    const matrix = termRateMatrix(ctx, unit, ctx.businessDate);
    const affordableMax = maxTenantRent(ctx, unit); // null for market units
    for (const term of [15, 12, 9, 6]) {
      const t = matrix.find((x) => x.term === Math.min(14, term)) || matrix[matrix.length - 1]!;
      // renewal price: min(market-derived term rate, current rent + cap, program limit)
      let capped = Math.min(t.rent, Math.round((l.rent_cents * (1 + capPct / 100)) / 100) * 100);
      if (affordableMax !== null) capped = Math.min(capped, affordableMax);
      const final = Math.max(l.rent_cents, capped); // never below current here (loss-to-lease shows elsewhere)
      if (q1(`SELECT id FROM price_recommendations WHERE unit_id=? AND term_months=? AND date=? AND status='accepted'`, l.uid, term, ctx.businessDate)) continue;
      insert('price_recommendations', {
        id: id('prc'), org_id: ctx.orgId, property_id: propertyId, unit_id: l.uid,
        date: ctx.businessDate, term_months: term, current_rent_cents: l.rent_cents,
        recommended_rent_cents: final, accepted_rent_cents: final,
        factors: js([
          { label: `term-rate matrix (${t.loadFactor} expiration month ${fmtMonth(t.expiresMonth)})`, delta_cents: t.rent - l.rent_cents },
          ...(capped < t.rent ? [{ label: `org cap ${capPct}% applied`, delta_cents: capped - t.rent }] : []),
        ]),
        status: 'accepted', decided_by: 'renewal batch', decided_at: nowIso(), created_at: nowIso(),
      });
      priced++;
    }
  }
  audit(ctx, 'property', propertyId, 'renewal_batch_priced', null, { leases: leases.length, rows: priced });
  return priced;
}

// ---------- revenue analytics (M13.6) ----------

export function revenueAnalytics(ctx: Ctx, propertyId: string): {
  lossToLease: { inPlace: number; market: number; gapCents: number; gapPct: number };
  newTradeOuts: { unit: string; prior: number; next: number }[];
  renewalTradeOuts: { unit: string; prior: number; next: number }[];
  effectiveRentTrend: { month: string; cents: number }[];
  concessions: number;
} {
  const inPlace = val<number>(
    `SELECT AVG(l.rent_cents) FROM leases l WHERE l.property_id=? AND l.status IN ('active','notice','month_to_month')`,
    propertyId,
  ) || 0;
  const market = val<number>(`SELECT AVG(market_rent_cents) FROM units WHERE property_id=?`, propertyId) || 0;

  const newTradeOuts = q<any>(
    `SELECT u.unit_number AS unit, prior.rent_cents AS prior, next.rent_cents AS next
     FROM leases next JOIN units u ON u.id=next.unit_id
     JOIN leases prior ON prior.unit_id=next.unit_id AND prior.status IN ('ended')
       AND prior.end_date <= next.start_date AND prior.id != next.id
     WHERE next.property_id=? AND next.status IN ('active','notice') AND next.renewal_of_lease_id IS NULL
     GROUP BY next.id ORDER BY next.start_date DESC LIMIT 12`,
    propertyId,
  );
  const renewalTradeOuts = q<any>(
    `SELECT u.unit_number AS unit, prior.rent_cents AS prior, next.rent_cents AS next
     FROM leases next JOIN units u ON u.id=next.unit_id
     JOIN leases prior ON prior.id=next.renewal_of_lease_id
     WHERE next.property_id=? ORDER BY next.start_date DESC LIMIT 12`,
    propertyId,
  );
  const effectiveRentTrend = q<any>(
    `SELECT substr(c.date,1,7) AS month, CAST(AVG(c.amount_cents) AS INTEGER) AS cents
     FROM charges c JOIN leases l ON l.id=c.lease_id
     WHERE c.property_id=? AND c.kind='rent' AND c.status='active' AND c.amount_cents > 0
     GROUP BY month ORDER BY month DESC LIMIT 12`,
    propertyId,
  ).reverse();
  const concessions = val<number>(
    `SELECT COALESCE(SUM(-amount_cents),0) FROM charges WHERE property_id=? AND kind='concession' AND date >= ?`,
    propertyId, addMonths(ctx.businessDate, -12),
  ) || 0;
  return {
    lossToLease: {
      inPlace: Math.round(inPlace), market: Math.round(market),
      gapCents: Math.round(market - inPlace),
      gapPct: market ? Math.round(((market - inPlace) / market) * 1000) / 10 : 0,
    },
    newTradeOuts, renewalTradeOuts, effectiveRentTrend, concessions,
  };
}

registerJob({
  key: 'pricing_engine',
  name: 'Nightly pricing engine',
  describe: 'Refreshes comp observations and stages transparent per-unit price recommendations for the daily review queue.',
  run: (ctx, date) => {
    const n = runPricingEngine(ctx, date);
    return n ? `${n} recommendations staged for review` : 'no pricing moves suggested';
  },
});
