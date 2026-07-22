import type { Router } from '../lib/http.ts';
import * as m2 from '../modules/m2_portfolio/pages.ts';
import * as people from '../modules/people/pages.ts';
import * as m9 from '../modules/m9_accounting/pages.ts';
import * as m8 from '../modules/m8_receivables/pages.ts';
import * as m7 from '../modules/m7_portal/pages.ts';
import * as m10 from '../modules/m10_facilities/pages.ts';
import * as m10tech from '../modules/m10_facilities/tech.ts';
import * as m3 from '../modules/m3_crm/pages.ts';
import '../modules/m3_crm/service.ts'; // registers ils_leads + tour_reminders jobs
import * as m4pub from '../modules/m4_marketing/public.ts';
import * as m4cms from '../modules/m4_marketing/cms.ts';
import * as m5apply from '../modules/m5_screening/apply.ts';
import * as m5 from '../modules/m5_screening/pages.ts';
import '../modules/m5_screening/service.ts'; // registers screening_results + hold_expiry jobs
import * as m6 from '../modules/m6_leases/pages.ts';
import '../modules/m6_leases/service.ts'; // registers lease_activation + lease_rollover jobs
import * as m9ap from '../modules/m9_accounting/pages_ap.ts';
import * as m9fin from '../modules/m9_accounting/pages_fin.ts'; // also registers bank_feed + recurring_jes jobs
import * as m11 from '../modules/m11_utilities/pages.ts'; // also registers utility_cycle job
import * as m12 from '../modules/m12_insurance/pages.ts'; // also registers insurance_compliance job + deposit-alt hook
import * as m16 from '../modules/m16_procurement/pages.ts';
import * as m15 from '../modules/m15_comms/pages.ts'; // also registers mass_comms job + send hook
import * as m13 from '../modules/m13_pricing/pages.ts'; // also registers pricing_engine job
import * as m14 from '../modules/m14_reports/pages.ts'; // also registers metric_snapshots + report_delivery jobs
import * as m17 from '../modules/m17_ai/pages.ts'; // also registers ai_call_analysis job + agent event hooks
import * as m18 from '../modules/m18_verticals/pages.ts'; // also registers affordable_recerts job + PCS lease action
import '../modules/m8_receivables/service.ts'; // registers rent_posting job
import '../modules/m8_receivables/payments.ts'; // registers settlement/late-fee/autopay/plan jobs

/** Phase modules mount here as they are built (Phase 1+). Keeping the list in
 * one place makes the build order visible. */
export function registerModules(r: Router): void {
  m2.routes(r); // Phase 1: portfolio & units + dashboards
  people.routes(r); // Phase 2: residents & leases (ledger)
  m9.routes(r); // Phase 2: GL browser + invariants
  m8.routes(r); // Phase 3: receivables, delinquency, deposits, late fees
  m7.routes(r); // Phase 4: resident portal core
  m7.staffRoutes(r); // Phase 4: household change approvals
  m10.routes(r); // Phase 5: facilities staff screens
  m10tech.routes(r); // Phase 5: tech My Day + vendor portal
  m3.routes(r); // Phase 6: CRM & centralized leasing
  m4pub.routes(r); // Phase 7: public marketing sites + prospect flows
  m4cms.routes(r); // Phase 7: CMS + syndication manager
  m5apply.routes(r); // Phase 8: applicant wizard (tokenized)
  m5.routes(r); // Phase 8: staff application pipeline + decisions
  m6.routes(r); // Phase 9: lease packets, e-sign, renewals, templates
  m6.portalRoutes(r); // Phase 9: portal renewal acceptance + checklist
  m9ap.routes(r); // Phase 10: accounts payable + payment runs
  m9fin.routes(r); // Phase 10: banking/recon, close, budgets, statements, projects
  m11.routes(r); // Phase 11: utilities — meters, RUBS, recovery
  m12.routes(r); // Phase 11: insurance compliance + risk
  m12.portalRoutes(r); // Phase 11: portal insurance upload/enroll
  m16.routes(r); // Phase 12: purchasing, exceptions, spend, 1099
  m16.vendorRoutes(r); // Phase 12: vendor PO ack + invoicing + remittance
  m15.routes(r); // Phase 13: inbox/threads, mass comms, templates, automations
  m15.portalRoutes(r); // Phase 13: portal communication preferences
  m13.routes(r); // Phase 14: pricing queue, comps, term rates, renewal batch, analytics
  m14.routes(r); // Phase 15: report library, custom builder, saved/scheduled, dashboards
  m17.routes(r); // Phase 16: AI activity/approvals, agents, call analysis, Ask Oriel, Essentials
  m18.routes(r); // Phase 17: student board, affordable compliance, military/CAM toolkits
}
