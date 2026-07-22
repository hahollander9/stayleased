import { q, val } from '../lib/db.ts';
import { addDays, addMonths, monthKey } from '../lib/dates.ts';
import { sysCtx } from '../lib/auth.ts';
import {
  ensureCompSets, generateCompObservations, runPricingEngine,
  decideRecommendation, runRenewalBatch,
} from '../modules/m13_pricing/service.ts';
import type { SeedCtx } from './seed.ts';
import { log } from './seed.ts';

/** Phase 14 seed: 14 months of comp-market observations, eight weekly pricing
 * reviews decided by the regional manager (accepts + a few overrides/rejects
 * → a real price_changes trail), today's live pending queue, and renewal
 * batches for two properties (Foundry is left unpriced so the demo can run
 * the batch live). */

export function seedPricing(s: SeedCtx): void {
  ensureCompSets(s.orgId);
  let obs = 0;
  for (let i = 13; i >= 0; i--) obs += generateCompObservations(s.orgId, monthKey(addMonths(s.businessDate, -i)));
  log(`pricing: ${obs} comp observations across 14 months`);

  // ---------- eight weekly reviews (history with human decisions) ----------
  let accepted = 0, overridden = 0, rejected = 0;
  for (let w = 8; w >= 1; w--) {
    const date = addDays(s.businessDate, -7 * w);
    const c = { ...sysCtx(s.orgId, date), userName: 'Marcus Bell' };
    runPricingEngine(c, date);
    const pend = q<any>(
      `SELECT id, recommended_rent_cents FROM price_recommendations
       WHERE org_id=? AND status='pending' AND term_months=12 ORDER BY unit_id`,
      s.orgId,
    );
    for (const [i, p] of pend.entries()) {
      if (i % 9 === 4) {
        decideRecommendation(c, p.id, 'override', {
          amountCents: p.recommended_rent_cents - 2500,
          reason: 'Backs the service alley — hold slightly under the engine number',
        });
        overridden++;
      } else if (i % 13 === 7) {
        decideRecommendation(c, p.id, 'reject', { reason: 'Renovation scope pending for this unit; hold pricing' });
        rejected++;
      } else {
        decideRecommendation(c, p.id, 'accept');
        accepted++;
      }
    }
  }
  log(`pricing: 8 weekly reviews — ${accepted} accepted, ${overridden} overridden, ${rejected} rejected`);

  // ---------- today's live queue ----------
  const today = sysCtx(s.orgId);
  const staged = runPricingEngine(today, s.businessDate);
  log(`pricing: ${staged} recommendations pending review today`);

  // ---------- renewal batches (Foundry left for the live demo) ----------
  const props = q<any>('SELECT id, name, slug FROM properties WHERE org_id=? ORDER BY name', s.orgId);
  let batchRows = 0;
  for (const p of props.filter((x) => x.slug !== 'foundry-lofts')) {
    batchRows += runRenewalBatch({ ...today, userName: 'Marcus Bell' }, p.id);
  }
  const changes = val<number>('SELECT COUNT(*) FROM price_changes WHERE org_id=?', s.orgId) || 0;
  log(`pricing: ${batchRows} renewal term rates staged (2 properties), ${changes} price changes on record`);
}
