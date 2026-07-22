import { q, q1, val, insert, run, j, js, tx } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, addDays, addMonths, monthKey, fmtDate, diffDays } from '../../lib/dates.ts';
import { usd } from '../../lib/money.ts';
import { assertPerm, type Ctx } from '../../lib/auth.ts';
import { getSetting } from '../../lib/settings.ts';
import { audit } from '../../lib/audit.ts';
import { emit } from '../../lib/events.ts';
import { registerJob } from '../../lib/jobs.ts';
import { hashPassword } from '../../lib/auth.ts';
import { sendEmail } from '../../lib/sim/messaging.ts';

/** M18 — vertical modes as conditional behavior on Property.type. One
 * codebase: student (by-the-bed on Cardinal), affordable (LIHTC set-asides
 * with certification gating), military (PCS breaks, BAH schedule),
 * commercial (CAM reconciliation worksheet), manufactured (lot/home split
 * fields). Stretch gaps are logged in STATE.md + docs/parity.md. */

// ---------- STUDENT (M18.1) ----------

export const BED_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];

export function academicCalendar(ctx: Ctx): { fallStart: string; fallEnd: string } {
  return getSetting(ctx, 'academic_calendar');
}

export interface BedSlot {
  bedLabel: string;
  current: any | null; // lease in possession today (joint leases occupy all beds)
  fall: any | null; // upcoming academic-year lease for this bed
}

export interface UnitRoster {
  unit: any;
  beds: number;
  slots: BedSlot[];
  jointCurrent: any | null;
}

/** the by-the-bed roster: current occupancy + fall assignments per bed */
export function bedRoster(ctx: Ctx, propertyId: string): UnitRoster[] {
  const cal = academicCalendar(ctx);
  const units = q<any>(
    `SELECT u.*, f.beds AS fp_beds, f.name AS fp FROM units u LEFT JOIN floorplans f ON f.id=u.floorplan_id
     WHERE u.property_id=? ORDER BY u.unit_number`,
    propertyId,
  );
  return units.map((unit) => {
    const beds = unit.fp_beds || 1;
    const leases = q<any>(
      `SELECT l.*, (SELECT r.first_name || ' ' || r.last_name FROM household_members hm JOIN residents r ON r.id=hm.resident_id
         WHERE hm.lease_id=l.id AND hm.role='primary' LIMIT 1) AS who
       FROM leases l WHERE l.unit_id=? AND l.status NOT IN ('canceled','ended','renewed') ORDER BY l.start_date`,
      unit.id,
    );
    const jointCurrent = leases.find((l) => !l.bed_label && ['active', 'month_to_month', 'notice'].includes(l.status)) || null;
    const slots: BedSlot[] = BED_LABELS.slice(0, beds).map((bedLabel) => ({
      bedLabel,
      current: leases.find((l) => l.bed_label === bedLabel && ['active', 'month_to_month', 'notice'].includes(l.status)) || jointCurrent,
      fall: leases.find((l) => l.bed_label === bedLabel && l.start_date >= cal.fallStart && ['draft', 'out_for_signature', 'partially_signed', 'fully_executed'].includes(l.status))
        || leases.find((l) => l.bed_label === bedLabel && l.start_date >= cal.fallStart && l.status === 'active') || null,
    }));
    return { unit, beds, slots, jointCurrent };
  });
}

/** assign a bed: an individual-liability lease for one bedspace */
export function assignBed(
  ctx: Ctx,
  opts: {
    unitId: string;
    bedLabel: string;
    firstName: string;
    lastName: string;
    email: string;
    rentCents: number;
    startDate?: string; // default: fall start
    guarantor?: { name: string; email: string } | null;
  },
): string {
  assertPerm(ctx, 'leases:manage');
  const unit = q1<any>('SELECT u.*, f.beds AS fp_beds FROM units u LEFT JOIN floorplans f ON f.id=u.floorplan_id WHERE u.id=?', opts.unitId);
  if (!unit) throw new Error('unit not found');
  const prop = q1<any>('SELECT * FROM properties WHERE id=?', unit.property_id);
  if (prop.type !== 'student') throw new Error('by-the-bed leasing is a student-property mode');
  if (!BED_LABELS.slice(0, unit.fp_beds || 1).includes(opts.bedLabel)) throw new Error('no such bed in this unit');
  const cal = academicCalendar(ctx);
  const start = opts.startDate || cal.fallStart;
  const clash = q1<any>(
    `SELECT id FROM leases WHERE unit_id=? AND bed_label=? AND status NOT IN ('canceled','ended','renewed')
       AND start_date <= ? AND end_date >= ?`,
    opts.unitId, opts.bedLabel, cal.fallEnd, start,
  );
  if (clash) throw new Error(`bed ${opts.bedLabel} already has a lease covering that term`);

  const leaseId = id('lse');
  tx(() => {
    insert('leases', {
      id: leaseId, org_id: ctx.orgId, property_id: unit.property_id, unit_id: opts.unitId,
      household_name: `${opts.lastName}, ${opts.firstName} (Bed ${opts.bedLabel})`,
      status: 'fully_executed', // individual-liability packet countersigned; activates on move-in
      start_date: start, end_date: cal.fallEnd, move_in_date: start,
      rent_cents: opts.rentCents, deposit_cents: 0, deposit_alternative: 0,
      term_months: Math.max(1, Math.round(diffDays(cal.fallEnd, start) / 30)),
      bed_label: opts.bedLabel, created_at: nowIso(),
    });
    // the incoming student (portal activates with the lease)
    let userId = q1<any>('SELECT id FROM users WHERE email=?', opts.email)?.id as string | undefined;
    if (!userId) {
      userId = id('usr');
      insert('users', {
        id: userId, org_id: ctx.orgId, email: opts.email, name: `${opts.firstName} ${opts.lastName}`,
        kind: 'resident', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
      });
    }
    const rid = id('res');
    insert('residents', {
      id: rid, org_id: ctx.orgId, property_id: unit.property_id, first_name: opts.firstName, last_name: opts.lastName,
      email: opts.email, phone: null, kind: 'adult', user_id: userId, created_at: nowIso(),
    });
    insert('household_members', { id: id('hm'), org_id: ctx.orgId, lease_id: leaseId, resident_id: rid, role: 'primary', created_at: nowIso() });
    // parent/guarantor with portal access (individual liability still applies)
    if (opts.guarantor?.email) {
      let gUserId = q1<any>('SELECT id FROM users WHERE email=?', opts.guarantor.email)?.id as string | undefined;
      if (!gUserId) {
        gUserId = id('usr');
        insert('users', {
          id: gUserId, org_id: ctx.orgId, email: opts.guarantor.email, name: opts.guarantor.name,
          kind: 'resident', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
        });
      }
      const gid = id('res');
      insert('residents', {
        id: gid, org_id: ctx.orgId, property_id: unit.property_id,
        first_name: opts.guarantor.name.split(' ')[0] || 'Guarantor',
        last_name: opts.guarantor.name.split(' ').slice(1).join(' ') || opts.lastName,
        email: opts.guarantor.email, phone: null, kind: 'guarantor', user_id: gUserId, created_at: nowIso(),
      });
      insert('household_members', { id: id('hm'), org_id: ctx.orgId, lease_id: leaseId, resident_id: gid, role: 'guarantor', created_at: nowIso() });
    }
  });
  audit(ctx, 'lease', leaseId, 'bed_assigned', null, { unit: unit.unit_number, bed: opts.bedLabel, start, rent: opts.rentCents });
  emit(ctx, 'student.bed_assigned', 'lease', leaseId, { unitId: opts.unitId, bed: opts.bedLabel });
  return leaseId;
}

export interface PacingPoint {
  week: string;
  cumulative: number;
  target: number;
}

/** pre-lease pacing vs a linear target curve into fall (M13.7 hook) */
export function preLeasePacing(ctx: Ctx, propertyId: string): {
  totalBeds: number;
  preleased: number;
  pct: number;
  targetPct: number;
  curve: PacingPoint[];
} {
  const cal = academicCalendar(ctx);
  const totalBeds = val<number>(
    `SELECT COALESCE(SUM(f.beds),0) FROM units u JOIN floorplans f ON f.id=u.floorplan_id WHERE u.property_id=?`,
    propertyId,
  ) || 0;
  const fallLeases = q<any>(
    `SELECT created_at FROM leases WHERE property_id=? AND bed_label IS NOT NULL AND start_date >= ?
       AND status NOT IN ('canceled','ended','renewed') ORDER BY created_at`,
    propertyId, cal.fallStart,
  );
  const preleased = fallLeases.length;
  // season runs Feb 1 → fall start; target ramps linearly to 95%
  const seasonStart = `${cal.fallStart.slice(0, 4)}-02-01`;
  const seasonDays = Math.max(1, diffDays(cal.fallStart, seasonStart));
  const curve: PacingPoint[] = [];
  for (let d = 0; d <= seasonDays; d += 14) {
    const date = addDays(seasonStart, d);
    if (date > ctx.businessDate && curve.length && curve[curve.length - 1]!.week >= ctx.businessDate) break;
    const cum = fallLeases.filter((l) => l.created_at.slice(0, 10) <= date).length;
    curve.push({
      week: date,
      cumulative: totalBeds ? Math.round((cum / totalBeds) * 1000) / 10 : 0,
      target: Math.round(Math.min(95, (d / seasonDays) * 95) * 10) / 10,
    });
    if (date > ctx.businessDate) break;
  }
  const elapsed = Math.min(1, Math.max(0, diffDays(ctx.businessDate, seasonStart) / seasonDays));
  return {
    totalBeds,
    preleased,
    pct: totalBeds ? Math.round((preleased / totalBeds) * 1000) / 10 : 0,
    targetPct: Math.round(Math.min(95, elapsed * 95) * 10) / 10,
    curve,
  };
}

// ---------- roommate matching (M18.1) ----------

export const ROOMMATE_QUESTIONS: { key: string; label: string; options: string[] }[] = [
  { key: 'sleep', label: 'Sleep schedule', options: ['early bird', 'night owl'] },
  { key: 'clean', label: 'Cleanliness', options: ['very tidy', 'relaxed'] },
  { key: 'study', label: 'Study style', options: ['quiet at home', 'library/out'] },
  { key: 'guests', label: 'Guests over', options: ['often', 'rarely'] },
  { key: 'smoke', label: 'Smoking', options: ['no', 'yes'] },
];

export function matchScore(a: Record<string, string>, b: Record<string, string>): number {
  let hits = 0;
  for (const qn of ROOMMATE_QUESTIONS) if (a[qn.key] && a[qn.key] === b[qn.key]) hits++;
  return Math.round((hits / ROOMMATE_QUESTIONS.length) * 100);
}

/** greedy grouping of unassigned profiles into unit-sized groups by similarity */
export function suggestGroups(ctx: Ctx, propertyId: string, groupSize = 4): { members: any[]; avgScore: number }[] {
  const profiles = q<any>(
    `SELECT rp.* FROM roommate_profiles rp WHERE rp.org_id=? AND rp.property_id=?
       AND NOT EXISTS (SELECT 1 FROM leases l JOIN household_members hm ON hm.lease_id=l.id
         JOIN residents r ON r.id=hm.resident_id
         WHERE l.property_id=rp.property_id AND l.bed_label IS NOT NULL AND r.first_name || ' ' || r.last_name = rp.person_name
           AND l.status NOT IN ('canceled','ended','renewed'))
     ORDER BY rp.created_at`,
    ctx.orgId, propertyId,
  ).map((p) => ({ ...p, a: j<Record<string, string>>(p.answers, {}) }));
  const remaining = [...profiles];
  const groups: { members: any[]; avgScore: number }[] = [];
  while (remaining.length) {
    const seedP = remaining.shift()!;
    const scored = remaining.map((p) => ({ p, s: matchScore(seedP.a, p.a) })).sort((x, y) => y.s - x.s);
    const take = scored.slice(0, groupSize - 1);
    const members = [seedP, ...take.map((t) => t.p)];
    for (const t of take) remaining.splice(remaining.indexOf(t.p), 1);
    const scores: number[] = [];
    for (let i = 0; i < members.length; i++) {
      for (let k = i + 1; k < members.length; k++) scores.push(matchScore(members[i]!.a, members[k]!.a));
    }
    groups.push({ members, avgScore: scores.length ? Math.round(scores.reduce((s, x) => s + x, 0) / scores.length) : 100 });
  }
  return groups;
}

// ---------- AFFORDABLE (M18.2) ----------

export function rentLimit(ctx: Ctx, amiPct: number, beds: number): number | null {
  return val<number>(`SELECT max_rent_cents FROM rent_limits WHERE org_id=? AND ami_pct=? AND beds=?`, ctx.orgId, amiPct, beds) ?? null;
}

/** max tenant-paid rent for a program unit: AMI limit minus utility allowance */
export function maxTenantRent(ctx: Ctx, unit: any): number | null {
  if (!unit.program) return null;
  const beds = val<number>('SELECT beds FROM floorplans WHERE id=?', unit.floorplan_id) ?? 1;
  const limit = rentLimit(ctx, unit.ami_pct || 60, beds);
  if (limit === null) return null;
  return limit - (unit.utility_allowance_cents || 0);
}

/** the hard gate: program units cannot lease above the limit, ever */
export function assertAffordableCompliance(ctx: Ctx, lease: any): void {
  const unit = q1<any>('SELECT * FROM units WHERE id=?', lease.unit_id);
  if (!unit?.program) return;
  const max = maxTenantRent(ctx, unit);
  if (max !== null && lease.rent_cents > max) {
    throw new Error(
      `${unit.program.toUpperCase()} unit ${unit.unit_number}: rent ${usd(lease.rent_cents)} exceeds the ${unit.ami_pct}% AMI limit ` +
      `(${usd(max)} after the ${usd(unit.utility_allowance_cents || 0)} utility allowance). Over-limit leases are blocked.`,
    );
  }
  const cert = q1<any>(
    `SELECT * FROM income_certs WHERE unit_id=? AND kind='initial' AND status='complete' AND (lease_id=? OR lease_id IS NULL)
     ORDER BY created_at DESC LIMIT 1`,
    lease.unit_id, lease.id,
  );
  if (!cert) {
    throw new Error(
      `${unit.program.toUpperCase()} unit ${unit.unit_number}: move-in is blocked until the household's initial income certification is complete.`,
    );
  }
}

export const CERT_CHECKLIST = [
  'Income questionnaire signed by all adults',
  'Pay stubs / employer verification (3rd-party)',
  'Bank statements & asset certification',
  'Student status verification (if applicable)',
  'Household composition affidavit',
];

export function startCert(ctx: Ctx, opts: { unitId: string; leaseId?: string | null; kind?: 'initial' | 'annual'; householdSize: number; incomeCents: number; dueDate?: string }): string {
  assertPerm(ctx, 'leases:manage');
  const unit = q1<any>('SELECT * FROM units WHERE id=?', opts.unitId);
  if (!unit?.program) throw new Error('not a program unit');
  const certId = id('crt');
  insert('income_certs', {
    id: certId, org_id: ctx.orgId, property_id: unit.property_id, unit_id: opts.unitId,
    lease_id: opts.leaseId || null, kind: opts.kind || 'initial', status: 'in_progress',
    due_date: opts.dueDate || addDays(ctx.businessDate, 30), household_size: opts.householdSize,
    household_income_cents: opts.incomeCents, ami_pct: null,
    checklist: js(CERT_CHECKLIST.map((item) => ({ item, done: false }))),
    completed_at: null, completed_by: null, created_at: nowIso(),
  });
  audit(ctx, 'income_cert', certId, 'start', null, { unit: unit.unit_number, kind: opts.kind || 'initial' });
  return certId;
}

export function checkCertItem(ctx: Ctx, certId: string, index: number, done: boolean): void {
  const cert = q1<any>('SELECT * FROM income_certs WHERE id=? AND org_id=?', certId, ctx.orgId);
  if (!cert || cert.status === 'complete') throw new Error('certification not open');
  const list = j<{ item: string; done: boolean }[]>(cert.checklist, []);
  if (!list[index]) throw new Error('no such item');
  list[index]!.done = done;
  run('UPDATE income_certs SET checklist=? WHERE id=?', js(list), certId);
}

/** income-qualify the household and complete the cert (blocks if docs missing or over-income) */
export function completeCert(ctx: Ctx, certId: string): void {
  assertPerm(ctx, 'leases:manage');
  const cert = q1<any>('SELECT * FROM income_certs WHERE id=? AND org_id=?', certId, ctx.orgId);
  if (!cert || cert.status === 'complete') throw new Error('certification not open');
  const list = j<{ item: string; done: boolean }[]>(cert.checklist, []);
  const missing = list.filter((x) => !x.done);
  if (missing.length) throw new Error(`checklist incomplete: ${missing.map((m) => m.item).join('; ')}`);
  const unit = q1<any>('SELECT * FROM units WHERE id=?', cert.unit_id);
  // deterministic AMI bands (Denver-metro flavored, per household size)
  const limit100 = [7080000, 8090000, 9100000, 10110000, 10920000, 11730000][Math.min(5, cert.household_size - 1)]!;
  const band = (cert.household_income_cents / limit100) * 100;
  const qualifies = band <= (unit.ami_pct || 60);
  if (!qualifies) {
    throw new Error(
      `household income ${usd(cert.household_income_cents)}/yr is ${Math.round(band)}% of AMI — above the unit's ${unit.ami_pct}% set-aside. Cannot certify.`,
    );
  }
  run(
    `UPDATE income_certs SET status='complete', ami_pct=?, completed_at=?, completed_by=? WHERE id=?`,
    Math.round(band), nowIso(), ctx.userName, certId,
  );
  audit(ctx, 'income_cert', certId, 'complete', null, { band: Math.round(band), unit: unit.unit_number });
  emit(ctx, 'affordable.certified', 'income_cert', certId, { unitId: cert.unit_id });
}

// ---------- waitlist (audit-safe ordering) ----------

export function addToWaitlist(ctx: Ctx, opts: { propertyId: string; name: string; email?: string; phone?: string; householdSize: number; incomeCents: number; preferences?: Record<string, unknown> }): string {
  const pos = (val<number>('SELECT MAX(position) FROM waitlist_entries WHERE property_id=?', opts.propertyId) || 0) + 1;
  const wid = id('wtl');
  insert('waitlist_entries', {
    id: wid, org_id: ctx.orgId, property_id: opts.propertyId, position: pos,
    name: opts.name, email: opts.email || null, phone: opts.phone || null,
    household_size: opts.householdSize, income_cents: opts.incomeCents,
    preferences: js(opts.preferences || {}), status: 'active', skip_reason: null, created_at: nowIso(),
  });
  audit(ctx, 'waitlist', wid, 'add', null, { position: pos, name: opts.name });
  return wid;
}

export function waitlistAction(ctx: Ctx, entryId: string, action: 'offer' | 'skip' | 'house' | 'remove', reason?: string): void {
  assertPerm(ctx, 'leasing:manage');
  const entry = q1<any>('SELECT * FROM waitlist_entries WHERE id=? AND org_id=?', entryId, ctx.orgId);
  if (!entry) throw new Error('entry not found');
  if (action === 'skip' && !(reason || '').trim()) throw new Error('skipping a position requires a written reason (fair-housing audit)');
  // ordering is immutable: offers must go to the lowest active position unless a documented skip exists
  if (action === 'offer') {
    const ahead = q<any>(
      `SELECT * FROM waitlist_entries WHERE property_id=? AND status='active' AND position < ? ORDER BY position`,
      entry.property_id, entry.position,
    );
    if (ahead.length) throw new Error(`position ${ahead[0].position} (${ahead[0].name}) is ahead — offer in order, or skip them with a documented reason first`);
  }
  const status = action === 'offer' ? 'offered' : action === 'skip' ? 'skipped' : action === 'house' ? 'housed' : 'removed';
  run('UPDATE waitlist_entries SET status=?, skip_reason=? WHERE id=?', status, action === 'skip' ? reason : entry.skip_reason, entryId);
  audit(ctx, 'waitlist', entryId, action, null, { position: entry.position, reason });
}

// annual recert sweep: create the next annual cert 12 months after completion
registerJob({
  key: 'affordable_recerts',
  name: 'Affordable recertifications',
  describe: 'Creates annual income recertifications when they come due (60-day window) and reminds on the way.',
  run: (ctx, date) => {
    const due = q<any>(
      `SELECT ic.* FROM income_certs ic WHERE ic.org_id=? AND ic.status='complete'
         AND date(ic.completed_at, '+305 days') <= ?
         AND NOT EXISTS (SELECT 1 FROM income_certs n WHERE n.unit_id=ic.unit_id AND n.kind='annual' AND n.created_at > ic.completed_at)`,
      ctx.orgId, date,
    );
    let created = 0;
    for (const cert of due) {
      insert('income_certs', {
        id: id('crt'), org_id: ctx.orgId, property_id: cert.property_id, unit_id: cert.unit_id,
        lease_id: cert.lease_id, kind: 'annual', status: 'in_progress',
        due_date: addDays(cert.completed_at.slice(0, 10), 365), household_size: cert.household_size,
        household_income_cents: cert.household_income_cents, ami_pct: null,
        checklist: js(CERT_CHECKLIST.map((item) => ({ item, done: false }))),
        completed_at: null, completed_by: null, created_at: nowIso(),
      });
      created++;
    }
    return created ? `${created} annual recertifications opened` : 'no recerts due';
  },
});

// ---------- MILITARY (M18.3) ----------

export function bahTable(ctx: Ctx): Record<string, { with_deps: number; without_deps: number }> {
  return getSetting(ctx, 'bah_table');
}

/** PCS-orders lease break: documented, fee-free, ≥30-day notice per SCRA-style policy */
export function pcsBreak(ctx: Ctx, opts: { leaseId: string; reportDate: string; terminationDate: string; ordersFileId?: string | null; note?: string }): string {
  assertPerm(ctx, 'leases:manage');
  const lease = q1<any>('SELECT * FROM leases WHERE id=? AND org_id=?', opts.leaseId, ctx.orgId);
  if (!lease || !['active', 'month_to_month', 'notice'].includes(lease.status)) throw new Error('lease is not active');
  if (diffDays(opts.terminationDate, ctx.businessDate) < 30) throw new Error('PCS termination requires at least 30 days from today');
  const pid = id('pcs');
  tx(() => {
    insert('pcs_breaks', {
      id: pid, org_id: ctx.orgId, property_id: lease.property_id, lease_id: lease.id,
      orders_file_id: opts.ordersFileId || null, report_date: opts.reportDate,
      termination_date: opts.terminationDate, note: opts.note || null,
      created_by: ctx.userName, created_at: nowIso(),
    });
    run(
      `UPDATE leases SET status='notice', notice_date=?, move_out_date=?, end_date=? WHERE id=?`,
      ctx.businessDate, opts.terminationDate, opts.terminationDate, lease.id,
    );
  });
  // NO early-termination fee — that is the whole point (documented + audited)
  audit(ctx, 'lease', lease.id, 'pcs_break', null, { terminationDate: opts.terminationDate, feeWaived: true });
  emit(ctx, 'lease.notice', 'lease', lease.id, { propertyId: lease.property_id, moveOut: opts.terminationDate, reason: 'pcs' });
  const contact = q1<any>(
    `SELECT r.* FROM household_members hm JOIN residents r ON r.id=hm.resident_id WHERE hm.lease_id=? AND hm.role='primary'`, lease.id,
  );
  if (contact?.email) {
    sendEmail(ctx, {
      to: contact.email, toName: `${contact.first_name} ${contact.last_name}`,
      subject: 'Your PCS lease termination is confirmed — thank you for your service',
      body: `<p>Hi ${contact.first_name},</p><p>Your permanent-change-of-station lease break is on file. Your lease ends <b>${fmtDate(opts.terminationDate)}</b> with <b>no early-termination fee</b>, per policy and your orders dated ${fmtDate(opts.reportDate)}.</p><p>We'll send move-out and deposit details as the date approaches.</p>`,
      propertyId: lease.property_id, entity: 'lease', entityId: lease.id, personId: contact.id, templateKey: 'pcs_confirmation',
    });
  }
  return pid;
}

// ---------- COMMERCIAL (M18.4): CAM reconciliation worksheet ----------

export interface CamRow {
  leaseId: string;
  suite: string;
  tenant: string;
  sqft: number;
  sharePct: number;
  budgetedCam: number;
  actualShare: number;
  trueUp: number; // + = invoice, − = credit
}

/** budgeted vs actual operating expenses → per-suite true-up, allocated by sqft */
export function camReconciliation(ctx: Ctx, propertyId: string, year: number): {
  budgetedOpex: number;
  actualOpex: number;
  rows: CamRow[];
  postable: boolean;
} {
  const budget = q1<any>(`SELECT * FROM budgets WHERE property_id=? AND year=? AND status='approved' ORDER BY version DESC LIMIT 1`, propertyId, year);
  let budgetedOpex = 0;
  if (budget) {
    for (const line of q<any>('SELECT * FROM budget_lines WHERE budget_id=?', budget.id)) {
      if (String(line.gl_account).startsWith('5')) {
        budgetedOpex += (j<number[]>(line.months, []) as number[]).reduce((s, x) => s + x, 0);
      }
    }
  }
  const actualOpex = val<number>(
    `SELECT COALESCE(SUM(jl.debit_cents - jl.credit_cents),0) FROM journal_lines jl
     JOIN journal_entries je ON je.id=jl.entry_id
     WHERE jl.org_id=? AND jl.property_id=? AND je.basis='accrual' AND jl.account_code LIKE '5%'
       AND substr(je.date,1,4)=?`,
    ctx.orgId, propertyId, String(year),
  ) || 0;
  const leases = q<any>(
    `SELECT l.id, l.household_name, u.unit_number, u.sqft FROM leases l JOIN units u ON u.id=l.unit_id
     WHERE l.property_id=? AND l.status IN ('active','month_to_month','notice') ORDER BY u.unit_number`,
    propertyId,
  );
  const totalSqft = leases.reduce((s, l) => s + (l.sqft || 0), 0) || 1;
  const prop = q1<any>('SELECT type FROM properties WHERE id=?', propertyId);
  const rows: CamRow[] = leases.map((l) => {
    const share = (l.sqft || 0) / totalSqft;
    const budgetedCam = Math.round(budgetedOpex * share);
    const actualShare = Math.round(actualOpex * share);
    return {
      leaseId: l.id, suite: l.unit_number, tenant: l.household_name, sqft: l.sqft || 0,
      sharePct: Math.round(share * 1000) / 10, budgetedCam, actualShare, trueUp: actualShare - budgetedCam,
    };
  });
  return { budgetedOpex, actualOpex, rows, postable: prop?.type === 'commercial' };
}
