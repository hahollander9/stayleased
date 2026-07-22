import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, q1, db } from '../src/lib/db.ts';
import { boot, login, newPage } from './lib.ts';

/** resolve @PLACEHOLDER tokens in shot paths against the seeded db */
function resolvePath(p: string): string {
  db();
  const lookup: Record<string, () => string | undefined> = {
    '@SR': () => q1<{ id: string }>("SELECT id FROM properties WHERE slug='summit-ridge'")?.id,
    '@FL': () => q1<{ id: string }>("SELECT id FROM properties WHERE slug='foundry-lofts'")?.id,
    '@CC': () => q1<{ id: string }>("SELECT id FROM properties WHERE slug='cardinal-commons'")?.id,
    '@UNIT': () => q1<{ id: string }>("SELECT u.id FROM units u JOIN properties p ON p.id=u.property_id WHERE p.slug='summit-ridge' AND u.status='occupied' LIMIT 1")?.id
      || q1<{ id: string }>('SELECT id FROM units LIMIT 1')?.id,
    '@LEASE': () => q1<{ id: string }>("SELECT id FROM leases WHERE household_name LIKE 'Torres%' AND status='active' LIMIT 1")?.id
      || q1<{ id: string }>("SELECT id FROM leases WHERE status='active' LIMIT 1")?.id,
    '@DERRICK': () => q1<{ id: string }>("SELECT hm.lease_id AS id FROM residents r JOIN household_members hm ON hm.resident_id=r.id WHERE r.email='derrick.cole@mail.demo' LIMIT 1")?.id,
    '@ALICIA': () => q1<{ id: string }>("SELECT id FROM leads WHERE email='alicia.nguyen@inbox.demo' LIMIT 1")?.id,
    '@APPREVIEW': () => q1<{ id: string }>("SELECT id FROM applications WHERE status='review' LIMIT 1")?.id,
    '@SIGNLEASE': () => q1<{ id: string }>("SELECT id FROM leases WHERE status='partially_signed' LIMIT 1")?.id
      || q1<{ id: string }>("SELECT id FROM leases WHERE status='out_for_signature' LIMIT 1")?.id,
    '@SIGNTOKEN': () => q1<{ token: string }>("SELECT token FROM signature_signers WHERE status='pending' ORDER BY order_idx DESC LIMIT 1")?.token as string | undefined,
    '@BANKSR': () => q1<{ id: string }>("SELECT b.id FROM bank_accounts b JOIN properties p ON p.id=b.property_id WHERE p.slug='summit-ridge'")?.id,
    '@MAYATHREAD': () => q1<{ id: string }>("SELECT t.id FROM threads t JOIN residents r ON r.id=t.person_id WHERE r.email='maya.torres@mail.demo'")?.id,
    '@MASS': () => q1<{ id: string }>("SELECT id FROM mass_messages ORDER BY created_at DESC LIMIT 1")?.id,
    '@POPART': () => q1<{ id: string }>("SELECT id FROM purchase_orders WHERE status='partially_received' LIMIT 1")?.id
      || q1<{ id: string }>('SELECT id FROM purchase_orders LIMIT 1')?.id,
    '@RUBSRUN': () => q1<{ id: string }>("SELECT id FROM rubs_runs WHERE status='preview' LIMIT 1")?.id
      || q1<{ id: string }>("SELECT id FROM rubs_runs ORDER BY usage_month DESC LIMIT 1")?.id,
    '@BUDGETSR': () => q1<{ id: string }>("SELECT b.id FROM budgets b JOIN properties p ON p.id=b.property_id WHERE p.slug='summit-ridge' AND b.status='approved' ORDER BY b.year DESC LIMIT 1")?.id,
  };
  let out = p;
  for (const [token, fn] of Object.entries(lookup)) {
    if (out.includes(token)) out = out.replace(token, fn() || 'missing');
  }
  return out;
}

/** Capture per-phase screenshots into docs/screenshots/phase-N/.
 * Usage: npm run shots -- <phase> (defaults to all registered). */

interface Shot {
  name: string;
  path: string;
  persona: string;
  mobile?: boolean;
  fullPage?: boolean;
}

const SHOTS: Record<string, Shot[]> = {
  '17': [
    { name: 'student-bed-board', path: '/student', persona: 'manager@summitridge.demo', fullPage: true },
    { name: 'student-pacing', path: '/student?view=pacing', persona: 'manager@summitridge.demo', fullPage: true },
    { name: 'roommate-matching', path: '/student?view=matching', persona: 'manager@summitridge.demo', fullPage: true },
    { name: 'affordable-compliance', path: '/affordable', persona: 'manager2@summitridge.demo', fullPage: true },
    { name: 'affordable-certs', path: '/affordable?view=certs', persona: 'manager2@summitridge.demo', fullPage: true },
    { name: 'affordable-waitlist', path: '/affordable?view=waitlist', persona: 'manager2@summitridge.demo', fullPage: true },
    { name: 'verticals-hub', path: '/verticals', persona: 'admin@summitridge.demo', fullPage: true },
  ],
  '16': [
    { name: 'ai-approval-queue', path: '/ai', persona: 'manager@summitridge.demo', fullPage: true },
    { name: 'ai-audit-history', path: '/ai?view=history', persona: 'manager@summitridge.demo', fullPage: true },
    { name: 'ai-autonomy-dials', path: '/ai?view=dials', persona: 'admin@summitridge.demo', fullPage: true },
    { name: 'ai-call-analysis', path: '/ai/calls', persona: 'manager@summitridge.demo', fullPage: true },
    { name: 'ask-oriel', path: '/ask?q=delinquency%20over%20%24500%20at%20Summit%20Ridge', persona: 'regional@summitridge.demo', fullPage: true },
    { name: 'ai-essentials', path: '/ai/essentials', persona: 'marketing@summitridge.demo', fullPage: true },
  ],
  '15': [
    { name: 'report-library', path: '/reports', persona: 'regional@summitridge.demo', fullPage: true },
    { name: 'rent-roll-6mo-back', path: '/reports/rent_roll?property=@SR&date=2026-01-26', persona: 'regional@summitridge.demo', fullPage: false },
    { name: 'delinquency-aged-report', path: '/reports/delinquency_aged', persona: 'accountant@summitridge.demo', fullPage: true },
    { name: 'income-statement-t12', path: '/reports/income_statement?view=t12', persona: 'accountant@summitridge.demo', fullPage: false },
    { name: 'custom-builder', path: '/reports/builder?dataset=residents&col=name&col=unit&col=property&col=balance&col=autopay&f0_col=balance&f0_op=gte&f0_val=1.00', persona: 'manager@summitridge.demo', fullPage: true },
    { name: 'exec-dashboard', path: '/dashboards', persona: 'regional@summitridge.demo', fullPage: true },
    { name: 'box-score', path: '/reports/box_score?property=@SR', persona: 'manager@summitridge.demo', fullPage: true },
  ],
  '14': [
    { name: 'pricing-queue', path: '/pricing?property=@SR', persona: 'regional@summitridge.demo', fullPage: true },
    { name: 'term-rates-smoothing', path: '/pricing/terms?property=@FL', persona: 'regional@summitridge.demo', fullPage: true },
    { name: 'renewal-batch', path: '/pricing/renewals?property=@SR', persona: 'regional@summitridge.demo', fullPage: true },
    { name: 'comp-market', path: '/pricing/comps?property=@SR', persona: 'regional@summitridge.demo', fullPage: true },
    { name: 'revenue-analytics', path: '/pricing/analytics?property=@SR', persona: 'regional@summitridge.demo', fullPage: true },
    { name: 'price-change-history', path: '/pricing/changes', persona: 'regional@summitridge.demo', fullPage: true },
  ],
  '13': [
    { name: 'inbox', path: '/inbox?view=needs_reply', persona: 'manager@summitridge.demo', fullPage: true },
    { name: 'thread-maya', path: '/inbox/@MAYATHREAD', persona: 'manager@summitridge.demo', fullPage: true },
    { name: 'mass-new-preview', path: '/comms/mass/new?preview=1&property=@SR&balance_over=0.00', persona: 'manager@summitridge.demo', fullPage: true },
    { name: 'mass-detail', path: '/comms/mass/@MASS', persona: 'manager@summitridge.demo', fullPage: true },
    { name: 'template-library', path: '/comms/templates', persona: 'manager@summitridge.demo', fullPage: true },
    { name: 'automation-audit', path: '/comms/automations', persona: 'manager@summitridge.demo', fullPage: true },
  ],
  '12': [
    { name: 'purchasing-pipeline', path: '/purchasing?status=all', persona: 'manager@summitridge.demo', fullPage: true },
    { name: 'po-detail', path: '/purchasing/@POPART', persona: 'manager@summitridge.demo', fullPage: true },
    { name: 'match-exceptions', path: '/purchasing/exceptions', persona: 'accountant@summitridge.demo' },
    { name: 'spend-analytics', path: '/purchasing/spend', persona: 'accountant@summitridge.demo', fullPage: true },
    { name: 'ten99-summary', path: '/purchasing/1099', persona: 'accountant@summitridge.demo', fullPage: true },
    { name: 'vendor-portal-pos', path: '/vendor/pos', persona: 'vendor@summitridge.demo', mobile: true, fullPage: true },
  ],
  '11': [
    { name: 'utilities-dashboard', path: '/utilities', persona: 'accountant@summitridge.demo', fullPage: true },
    { name: 'rubs-run-math', path: '/utilities/rubs/@RUBSRUN', persona: 'accountant@summitridge.demo', fullPage: true },
    { name: 'vacant-recovery', path: '/utilities/recovery', persona: 'accountant@summitridge.demo', fullPage: true },
    { name: 'insurance-compliance', path: '/insurance?state=all', persona: 'manager@summitridge.demo', fullPage: true },
    { name: 'risk-incidents', path: '/risk', persona: 'admin@summitridge.demo', fullPage: true },
    { name: 'portal-coverage-usage', path: '/portal/lease', persona: 'maya.torres@mail.demo', mobile: true, fullPage: true },
  ],
  '10': [
    { name: 'banking', path: '/banking', persona: 'accountant@summitridge.demo', fullPage: true },
    { name: 'recon-workbench', path: '/banking/@BANKSR/reconcile?month=2026-07', persona: 'accountant@summitridge.demo', fullPage: true },
    { name: 'month-end-close', path: '/periods', persona: 'accountant@summitridge.demo', fullPage: true },
    { name: 'ap-invoices', path: '/ap', persona: 'accountant@summitridge.demo', fullPage: true },
    { name: 'payment-register', path: '/ap/runs', persona: 'accountant@summitridge.demo', fullPage: true },
    { name: 'balance-sheet', path: '/statements?kind=bs', persona: 'accountant@summitridge.demo', fullPage: true },
    { name: 't12', path: '/statements?kind=t12', persona: 'accountant@summitridge.demo', fullPage: true },
    { name: 'budget-variance', path: '/budgets/@BUDGETSR?view=variance', persona: 'accountant@summitridge.demo', fullPage: true },
    { name: 'capital-project', path: '/projects', persona: 'accountant@summitridge.demo' },
  ],
  '9': [
    { name: 'leases-list', path: '/leases', persona: 'manager@summitridge.demo', fullPage: true },
    { name: 'lease-esign-tab', path: '/leases/@SIGNLEASE?tab=esign', persona: 'manager@summitridge.demo', fullPage: true },
    { name: 'signing-ceremony', path: '/sign/@SIGNTOKEN', persona: '', mobile: true, fullPage: true },
    { name: 'renewals-board', path: '/renewals', persona: 'manager@summitridge.demo', fullPage: true },
    { name: 'lease-templates', path: '/admin/lease-templates', persona: 'admin@summitridge.demo', fullPage: true },
    { name: 'portal-renewal-offer', path: '/portal', persona: 'maya.torres@mail.demo', mobile: true, fullPage: true },
  ],
  '8': [
    { name: 'applications-pipeline', path: '/applications', persona: 'manager@summitridge.demo' },
    { name: 'application-review', path: '/applications/@APPREVIEW', persona: 'manager@summitridge.demo', fullPage: true },
    { name: 'apply-wizard', path: '/p/summit-ridge/apply', persona: '', mobile: true },
  ],
  '7': [
    { name: 'public-site-summit', path: '/p/summit-ridge', persona: '', fullPage: true },
    { name: 'public-site-foundry-mobile', path: '/p/foundry-lofts', persona: '', mobile: true, fullPage: true },
    { name: 'cms-editor', path: '/marketing/sites/@SR', persona: 'marketing@summitridge.demo', fullPage: true },
    { name: 'syndication', path: '/marketing/syndication', persona: 'marketing@summitridge.demo' },
    { name: 'corporate-site', path: '/company', persona: '', fullPage: true },
  ],
  '6': [
    { name: 'lead-inbox', path: '/leads', persona: 'agent@summitridge.demo', fullPage: true },
    { name: 'guest-card-alicia', path: '/leads/@ALICIA', persona: 'regional@summitridge.demo', fullPage: true },
    { name: 'leasing-center', path: '/leasing-center', persona: 'agent2@summitridge.demo' },
    { name: 'funnel-analytics', path: '/leasing/analytics', persona: 'regional@summitridge.demo', fullPage: true },
    { name: 'tours', path: '/tours', persona: 'agent@summitridge.demo' },
  ],
  '5': [
    { name: 'workorders', path: '/workorders', persona: 'maintsup@summitridge.demo', fullPage: true },
    { name: 'dispatch-board', path: '/dispatch', persona: 'maintsup@summitridge.demo' },
    { name: 'turn-board', path: '/turns', persona: 'manager@summitridge.demo' },
    { name: 'tech-myday', path: '/myday', persona: 'tech@summitridge.demo', mobile: true },
    { name: 'inspections', path: '/inspections', persona: 'maintsup@summitridge.demo' },
    { name: 'facilities-analytics', path: '/facilities', persona: 'regional@summitridge.demo', fullPage: true },
  ],
  '4': [
    { name: 'portal-home', path: '/portal', persona: 'maya.torres@mail.demo', mobile: true, fullPage: true },
    { name: 'portal-pay', path: '/portal/pay', persona: 'maya.torres@mail.demo', mobile: true, fullPage: true },
    { name: 'portal-requests', path: '/portal/requests', persona: 'maya.torres@mail.demo', mobile: true },
    { name: 'portal-lease', path: '/portal/lease', persona: 'maya.torres@mail.demo', mobile: true, fullPage: true },
  ],
  '3': [
    { name: 'receivables', path: '/receivables', persona: 'accountant@summitridge.demo', fullPage: true },
    { name: 'delinquency-workbench', path: '/delinquency', persona: 'manager@summitridge.demo' },
    { name: 'delinquency-derrick', path: '/delinquency/@DERRICK', persona: 'manager@summitridge.demo', fullPage: true },
    { name: 'latefee-run', path: '/receivables/latefees', persona: 'manager@summitridge.demo' },
    { name: 'deposits', path: '/deposits', persona: 'accountant@summitridge.demo' },
    { name: 'message-console', path: '/dev/messages', persona: 'admin@summitridge.demo' },
  ],
  '2': [
    { name: 'lease-ledger', path: '/leases/@LEASE', persona: 'accountant@summitridge.demo' },
    { name: 'trial-balance', path: '/gl', persona: 'accountant@summitridge.demo' },
    { name: 'journal', path: '/gl/journal', persona: 'accountant@summitridge.demo' },
    { name: 'invariants', path: '/gl/invariants', persona: 'accountant@summitridge.demo' },
    { name: 'residents', path: '/residents', persona: 'manager@summitridge.demo' },
    { name: 'dashboard-occupied', path: '/', persona: 'admin@summitridge.demo' },
  ],
  '1': [
    { name: 'portfolio-rollup', path: '/', persona: 'admin@summitridge.demo' },
    { name: 'properties', path: '/properties', persona: 'admin@summitridge.demo' },
    { name: 'property-overview', path: '/properties/@SR', persona: 'admin@summitridge.demo', fullPage: true },
    { name: 'unit-board', path: '/units', persona: 'admin@summitridge.demo' },
    { name: 'unit-detail', path: '/units/@UNIT', persona: 'admin@summitridge.demo' },
  ],
  '0': [
    { name: 'login', path: '/login?logout=1', persona: '' },
    { name: 'admin-staff', path: '/admin/staff', persona: 'admin@summitridge.demo' },
    { name: 'permission-matrix', path: '/admin/roles', persona: 'admin@summitridge.demo' },
    { name: 'simulator-console', path: '/dev/sim', persona: 'admin@summitridge.demo' },
    { name: 'jobs-dashboard', path: '/admin/jobs', persona: 'admin@summitridge.demo' },
    { name: 'api-reference', path: '/developers', persona: 'admin@summitridge.demo' },
  ],
};

export function registerShots(phase: string, shots: Shot[]): void {
  SHOTS[phase] = shots;
}

async function main(): Promise<void> {
  const phase = process.argv[2] || Object.keys(SHOTS).sort((a, b) => +a - +b).pop()!;
  const shots = SHOTS[phase];
  if (!shots) {
    console.error(`No shots registered for phase ${phase}`);
    process.exit(1);
  }
  const dir = join(ROOT, 'docs', 'screenshots', `phase-${phase}`);
  mkdirSync(dir, { recursive: true });
  const { base, browser, close } = await boot();
  const cache = new Map<string, Awaited<ReturnType<typeof newPage>>>();
  for (const shot of shots) {
    const key = `${shot.persona}|${shot.mobile ? 'm' : 'd'}`;
    let page = cache.get(key);
    if (!page) {
      page = await newPage(browser, { mobile: shot.mobile });
      if (shot.persona) await login(page, base, shot.persona);
      cache.set(key, page);
    }
    await page.goto(base + resolvePath(shot.path), { waitUntil: 'networkidle' });
    await page.screenshot({ path: join(dir, `${shot.name}.png`), fullPage: shot.fullPage ?? false });
    console.log(`  📸 ${shot.name}.png`);
  }
  await close();
  console.log(`Saved ${shots.length} screenshots to docs/screenshots/phase-${phase}/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
