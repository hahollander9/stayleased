import type { SeedCtx } from './seed.ts';
import { seedPortfolio } from './phase1_portfolio.ts';
import { seedResidents } from './phase2_residents.ts';
import { seedHistory } from './phase3_history.ts';
import { seedPortalCast } from './phase4_portal.ts';
import { seedFacilities } from './phase5_facilities.ts';
import { seedCrm } from './phase6_crm.ts';
import { seedMarketing } from './phase7_marketing.ts';
import { seedApplications } from './phase8_applications.ts';
import { seedLeases } from './phase9_leases.ts';
import { seedAccounting } from './phase10_accounting.ts';
import { setupUtilities, utilitiesMonthHook, markTurnoverAlternatives, finishInsuranceRisk } from './phase11_utilities.ts';
import { seedProcurement } from './phase12_procurement.ts';
import { seedComms } from './phase13_comms.ts';
import { seedPricing } from './phase14_pricing.ts';
import { seedReports } from './phase15_reports.ts';
import { seedAi } from './phase16_ai.ts';
import { seedVerticals } from './phase17_verticals.ts';

/** Per-phase seed extensions. Each phase appends its seeder here so the
 * single `npm run seed` always builds the complete world. */
export async function seedPhases(s: SeedCtx): Promise<void> {
  seedPortfolio(s); // Phase 1: properties/buildings/units
  const cast = seedResidents(s); // Phase 2: households, leases, unit statuses, rent run
  const { vendorFor } = setupUtilities(s); // Phase 11 setup: meters, RUBS formulas, insurance, deposit alternatives
  seedHistory(s, cast, { onMonth: utilitiesMonthHook(s, vendorFor), onTurnoverLeases: markTurnoverAlternatives(s) }); // Phase 3+11: 14 months of money + utility history through the real pipelines
  seedPortalCast(s, cast); // Phase 4: Maya's work orders
  seedFacilities(s); // Phase 5: vendors, WOs, turns, PM, inventory, inspections
  seedCrm(s); // Phase 6: leads/tours/quotes/campaigns/call logs
  seedMarketing(s); // Phase 7: site content + ILS publications
  seedApplications(s); // Phase 8: applications in every state
  await seedLeases(s); // Phase 9: packets, e-sign mid-flight, renewal offers
  finishInsuranceRisk(s); // Phase 11: lapse states, guaranty, incidents
  seedProcurement(s); // Phase 12: PO pipeline, 3-way matches, the exception queue (July only)
  seedComms(s); // Phase 13: threads, consent, templates, scheduled mass, announcement
  seedPricing(s); // Phase 14: comps, weekly pricing reviews, live queue, renewal batches
  seedReports(s); // Phase 15: metric snapshots, bad-debt story, saved/scheduled reports
  seedAi(s); // Phase 16: autonomy dials, call analysis, agent queue + history
  seedVerticals(s); // Phase 17: Cardinal by-the-bed fall, Foundry LIHTC set-aside
  await seedAccounting(s); // Phase 10: AP history, bank rec, closed periods, budgets (closes periods LAST)
}
