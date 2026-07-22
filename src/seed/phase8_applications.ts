import { q, q1, insert, run, val, update } from '../lib/db.ts';
import { id, token } from '../lib/ids.ts';
import { nowIso, addDays } from '../lib/dates.ts';
import { sysCtx } from '../lib/auth.ts';
import {
  createApplication, inviteApplicant, collectFees, submitApplication, completeScreenings, decideApplication,
} from '../modules/m5_screening/service.ts';
import { FIRST, LAST, EMPLOYERS } from './names.ts';
import type { SeedCtx } from './seed.ts';
import { log } from './seed.ts';

/** Phase 8 seed (§8): applications in every state — drafts, screening,
 * review (mixed results incl. a fraud-flag duplicate-SSN case and a thin
 * file), approved w/ holds, conditions, declined w/ adverse letters. */

export function seedApplications(s: SeedCtx): void {
  const rng = s.rng.fork(888);
  const props = q<any>('SELECT * FROM properties WHERE org_id=? ORDER BY created_at', s.orgId);

  const vacantUnits = (propId: string): any[] =>
    q<any>(`SELECT * FROM units WHERE property_id=? AND status='vacant_ready' ORDER BY unit_number`, propId);

  interface Spec {
    prop: any;
    fate: 'draft' | 'screening' | 'review' | 'approved' | 'conditions' | 'declined' | 'fraud' | 'thin';
    daysAgo: number;
  }
  const specs: Spec[] = [
    { prop: props[0], fate: 'draft', daysAgo: 1 },
    { prop: props[1], fate: 'draft', daysAgo: 3 },
    { prop: props[0], fate: 'screening', daysAgo: 0 },
    { prop: props[1], fate: 'screening', daysAgo: 1 },
    { prop: props[0], fate: 'review', daysAgo: 2 },
    { prop: props[1], fate: 'review', daysAgo: 2 },
    { prop: props[0], fate: 'thin', daysAgo: 3 },
    { prop: props[0], fate: 'fraud', daysAgo: 2 },
    { prop: props[0], fate: 'approved', daysAgo: 4 },
    { prop: props[1], fate: 'approved', daysAgo: 3 },
    { prop: props[2], fate: 'approved', daysAgo: 5 },
    { prop: props[0], fate: 'conditions', daysAgo: 5 },
    { prop: props[1], fate: 'conditions', daysAgo: 6 },
    { prop: props[0], fate: 'declined', daysAgo: 7 },
    { prop: props[1], fate: 'declined', daysAgo: 8 },
  ];

  const usedUnits = new Set<string>();
  let made = 0;
  const dupSsn = String(rng.int(1000, 9999));

  for (const spec of specs) {
    if (!spec.prop) continue;
    const units = vacantUnits(spec.prop.id).filter((u) => !usedUnits.has(u.id));
    const unit = units[0];
    if (!unit) continue;
    usedUnits.add(unit.id);
    const created = addDays(s.businessDate, -spec.daysAgo);
    const ctx = sysCtx(s.orgId, created);
    const first = rng.pick(FIRST);
    const last = rng.pick(LAST);
    // deterministic screening identities steer the outcome
    const email =
      spec.fate === 'declined' ? `decline.test+${made}@screening.demo`
      : spec.fate === 'conditions' ? `conditions.test+${made}@screening.demo`
      : spec.fate === 'thin' ? `thinfile.test+${made}@screening.demo`
      : `${first}.${last}${rng.int(1, 99)}@apply.demo`.toLowerCase();

    const { applicationId } = createApplication(ctx, {
      propertyId: spec.prop.id, unitId: unit.id,
      moveIn: addDays(s.businessDate, rng.int(12, 40)),
      primary: { firstName: first, lastName: last, email },
    });
    made++;
    const primary = q1<any>(`SELECT * FROM applicants WHERE application_id=? AND kind='primary'`, applicationId);
    const income = Math.round((unit.market_rent_cents * (spec.fate === 'conditions' ? 2.1 : spec.fate === 'declined' ? 1.4 : 3.4)) / 1000) * 1000;
    update('applicants', primary.id, {
      first_name: first, last_name: last, phone: `(555) ${rng.int(200, 989)}-${rng.int(1000, 9999)}`,
      ssn_last4: spec.fate === 'fraud' ? dupSsn : String(rng.int(1000, 9999)),
      current_address: `${rng.int(100, 999)} Previous Ln`, employer: rng.pick(EMPLOYERS),
      income_monthly_cents: income, status: spec.fate === 'draft' ? 'started' : 'complete',
      step: spec.fate === 'draft' ? rng.int(1, 3) : 4,
    });
    if (spec.fate === 'fraud' && made > 1) {
      // a second person on ANOTHER application shares the SSN — duplicate-SSN flag
      const other = q1<any>(`SELECT id FROM applicants WHERE org_id=? AND application_id != ? AND kind='primary' LIMIT 1`, s.orgId, applicationId);
      if (other) run('UPDATE applicants SET ssn_last4=? WHERE id=?', dupSsn, other.id);
    }
    // co-applicant on some
    if (['review', 'approved', 'conditions'].includes(spec.fate) && rng.chance(0.6)) {
      const coId = inviteApplicant(ctx, applicationId, 'co', `${rng.pick(FIRST)}.${last}co@apply.demo`.toLowerCase(), 'http://localhost:3000');
      update('applicants', coId, {
        first_name: rng.pick(FIRST), last_name: last, ssn_last4: String(rng.int(1000, 9999)),
        income_monthly_cents: Math.round((unit.market_rent_cents * 1.2) / 1000) * 1000,
        employer: rng.pick(EMPLOYERS), status: 'complete', step: 4,
      });
    }
    if (spec.fate === 'draft') continue;

    collectFees(ctx, applicationId);
    submitApplication(ctx, applicationId);
    if (spec.fate === 'screening') continue; // bureau still pending

    completeScreenings(sysCtx(s.orgId, addDays(created, 1)), applicationId);
    if (['review', 'fraud', 'thin'].includes(spec.fate)) continue; // awaiting decision

    const decideCtx = sysCtx(s.orgId, addDays(created, 1));
    const app = q1<any>('SELECT * FROM applications WHERE id=?', applicationId);
    const action = spec.fate === 'approved' ? 'approved' : spec.fate === 'conditions' ? 'approved_conditions' : 'declined';
    const expected = app.recommendation === 'approve' ? 'approved' : app.recommendation === 'conditions' ? 'approved_conditions' : 'declined';
    decideApplication(decideCtx, applicationId, action as any, {
      reason: action !== expected ? 'Manager review: verified employment and rental history offset the score.' : undefined,
    });
  }

  const counts = q<any>(`SELECT status, COUNT(*) n FROM applications WHERE org_id=? GROUP BY status ORDER BY n DESC`, s.orgId);
  log(`applications: ${made} seeded — ${counts.map((c) => `${c.n} ${c.status}`).join(', ')}`);
}
