import { q, q1, val } from '../lib/db.ts';
import { sysCtx } from '../lib/auth.ts';
import { setSetting } from '../lib/settings.ts';
import { setDials } from '../lib/sim/dials.ts';
import {
  handleLeadInbound, draftCollectionsOutreach, draftRenewalOutreach, evaluateCounter, triageRequest,
} from '../modules/m17_ai/agents.ts';
import { analyzeNewCalls } from '../modules/m17_ai/analysis.ts';
import { askOriel } from '../modules/m17_ai/ask.ts';
import { generateListing } from '../modules/m17_ai/content.ts';
import type { SeedCtx } from './seed.ts';
import { log } from './seed.ts';

/** Phase 16 seed: autonomy dials per property, every call transcript
 * analyzed, and a believable AI Activity screen — items waiting for
 * approval, an autonomous after-hours booking, drafts, and history. */

export function seedAi(s: SeedCtx): void {
  const ctx = sysCtx(s.orgId);
  const cardinal = q1<any>(`SELECT id FROM properties WHERE slug='cardinal-commons'`);
  const foundry = q1<any>(`SELECT id FROM properties WHERE slug='foundry-lofts'`);

  // dials: org default approve/draft; Cardinal leasing runs autonomous
  // (after-hours student traffic), Foundry maintenance triage is autonomous.
  setSetting(ctx, 'ai_autonomy', { leasing: 'auto' }, cardinal.id);
  setSetting(ctx, 'ai_autonomy', { maintenance: 'auto' }, foundry.id);
  log('ai: dials — org approve/draft defaults; Cardinal leasing + Foundry maintenance autonomous');

  // ---------- ELI call analysis over the whole call history ----------
  const analyzed = analyzeNewCalls(ctx);
  const tasks = val<number>(`SELECT COUNT(*) FROM followup_tasks WHERE org_id=? AND kind LIKE 'ai:%'`, s.orgId) || 0;
  log(`ai: ${analyzed} call transcripts analyzed → ${tasks} follow-up tasks`);

  // ---------- Leasing AI ----------
  // Alicia (mid-funnel demo lead) asked a grounded question — held for approval at Summit Ridge
  const alicia = q1<any>(`SELECT id FROM leads WHERE email='alicia.nguyen@inbox.demo'`);
  if (alicia) {
    handleLeadInbound(ctx, alicia.id, 'Hi! Is a 2 bedroom still available, how much is rent, and could I tour tomorrow afternoon? We have a small dog.');
  }
  // an after-hours inquiry at Cardinal books itself (autonomous + audited)
  setDials(s.orgId, { clockHour: 21 });
  const cardinalLead = q1<any>(
    `SELECT id FROM leads WHERE property_id=? AND status IN ('new','contacted') ORDER BY created_date DESC LIMIT 1`, cardinal.id,
  );
  if (cardinalLead) {
    handleLeadInbound(ctx, cardinalLead.id, 'Saw the listing online — can I tour tomorrow? What does rent run?');
  }
  setDials(s.orgId, { clockHour: 14 });
  // a prospect who wants a person — low confidence holds even on approve
  const srLead = q1<any>(
    `SELECT l.id FROM leads l JOIN properties p ON p.id=l.property_id AND p.slug='summit-ridge'
     WHERE l.status IN ('new','contacted') AND l.id != ? ORDER BY l.created_date DESC LIMIT 1`,
    alicia?.id || '',
  );
  if (srLead) {
    handleLeadInbound(ctx, srLead.id, 'Please have a real person call me about pricing — I do not want automated replies.');
  }

  // ---------- Maintenance AI ----------
  // triage two open portal requests at Summit Ridge (approve dial → queue)
  const srWos = q<any>(
    `SELECT wo.id FROM work_orders wo JOIN properties p ON p.id=wo.property_id AND p.slug='summit-ridge'
     WHERE wo.source='portal' AND wo.status IN ('new','triaged') ORDER BY wo.created_date DESC LIMIT 2`,
  );
  for (const wo of srWos) triageRequest(ctx, wo.id);
  // one Foundry request triages itself (autonomous dial)
  const flWo = q1<any>(
    `SELECT wo.id FROM work_orders wo WHERE wo.property_id=? AND wo.source='portal' AND wo.status IN ('new','triaged') ORDER BY wo.created_date DESC LIMIT 1`,
    foundry.id,
  );
  if (flWo) triageRequest(ctx, flWo.id);

  // ---------- Payments AI ----------
  // Derrick (has his plan already → outreach only) + the next-worst delinquent (gets outreach + plan proposal)
  const derrick = q1<any>(
    `SELECT hm.lease_id AS id FROM residents r JOIN household_members hm ON hm.resident_id=r.id WHERE r.email='derrick.cole@mail.demo'`,
  );
  if (derrick) draftCollectionsOutreach(ctx, derrick.id);
  const nextDelinquent = q<any>(
    `SELECT * FROM (
       SELECT l.id, (SELECT COALESCE(SUM(amount_cents),0) FROM charges WHERE lease_id=l.id AND status='active') -
         (SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE lease_id=l.id AND status IN ('pending','settled')) AS bal
       FROM leases l WHERE l.org_id=? AND l.status='active' AND l.id != ?
         AND NOT EXISTS (SELECT 1 FROM payment_plans pp WHERE pp.lease_id=l.id)
     ) WHERE bal > 60000 ORDER BY bal DESC LIMIT 1`,
    s.orgId, derrick?.id || '',
  )[0];
  if (nextDelinquent) draftCollectionsOutreach(ctx, nextDelinquent.id);

  // ---------- Renewals AI ----------
  // Maya's real counter from her thread: $1,395 on the 12-month
  const maya = q1<any>(
    `SELECT hm.lease_id AS id FROM residents r JOIN household_members hm ON hm.resident_id=r.id
     JOIN leases l ON l.id=hm.lease_id AND l.status='active' WHERE r.email='maya.torres@mail.demo'`,
  );
  if (maya) evaluateCounter(ctx, maya.id, 139500, 12);
  // personalized outreach draft for the next expiring lease without an offer
  const expiring = q1<any>(
    `SELECT l.id FROM leases l WHERE l.org_id=? AND l.status='active'
       AND l.end_date BETWEEN date(?, '+30 days') AND date(?, '+90 days')
       AND NOT EXISTS (SELECT 1 FROM renewal_offers ro WHERE ro.lease_id=l.id)
     ORDER BY l.end_date LIMIT 1`,
    s.orgId, s.businessDate, s.businessDate,
  );
  if (expiring) draftRenewalOutreach(ctx, expiring.id);

  // ---------- Essentials + Ask history ----------
  const srPlan = q1<any>(
    `SELECT f.id, f.property_id FROM floorplans f JOIN properties p ON p.id=f.property_id AND p.slug='summit-ridge' ORDER BY f.market_rent_cents LIMIT 1`,
  );
  if (srPlan) generateListing(ctx, srPlan.property_id, srPlan.id);
  askOriel({ ...ctx, userName: 'Marcus Bell' }, 'delinquency over $500 at Summit Ridge');
  askOriel({ ...ctx, userName: 'Elena Ruiz' }, 'which units turn this month');

  const total = val<number>('SELECT COUNT(*) FROM ai_actions WHERE org_id=?', s.orgId) || 0;
  const pending = val<number>(`SELECT COUNT(*) FROM ai_actions WHERE org_id=? AND status='proposed'`, s.orgId) || 0;
  const auto = val<number>(`SELECT COUNT(*) FROM ai_actions WHERE org_id=? AND status='auto_executed'`, s.orgId) || 0;
  log(`ai: ${total} actions on record — ${pending} awaiting approval, ${auto} autonomous`);
}
