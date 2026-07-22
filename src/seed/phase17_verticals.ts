import { q, q1, val, insert, run, js } from '../lib/db.ts';
import { id } from '../lib/ids.ts';
import { nowIso, addDays } from '../lib/dates.ts';
import { sysCtx } from '../lib/auth.ts';
import {
  academicCalendar, assignBed, ROOMMATE_QUESTIONS, startCert, checkCertItem, completeCert,
  addToWaitlist, waitlistAction, CERT_CHECKLIST, rentLimit,
} from '../modules/m18_verticals/service.ts';
import type { SeedCtx } from './seed.ts';
import { log } from './seed.ts';

/** Phase 17 seed: Cardinal Commons goes fully by-the-bed for fall (pacing
 * story + roommate questionnaires + parent guarantors), and Foundry gets a
 * LIHTC set-aside — rent limits, complete/overdue certifications, and an
 * audit-safe waitlist. */

const FIRST = ['Ava', 'Liam', 'Noah', 'Mia', 'Zoe', 'Eli', 'Ivy', 'Max', 'Ruby', 'Leo', 'Nora', 'Finn', 'Isla', 'Owen', 'Luna', 'Jude', 'Sage', 'Remy', 'Wren', 'Kai'];
const LAST = ['Okafor', 'Lindqvist', 'Marsh', 'Delgado', 'Beck', 'Osei', 'Tran', 'Kowalski', 'Reyes', 'Ng', 'Abbott', 'Foster', 'Iverson', 'Pham', 'Sato', 'Klein', 'Vega', 'Moss', 'Ortiz', 'Blake'];

export function seedVerticals(s: SeedCtx): void {
  const ctx = { ...sysCtx(s.orgId), userName: 'Elena Ruiz' };
  const cal = academicCalendar(ctx);

  // ---------- STUDENT: Cardinal Commons fall pre-lease (by the bed) ----------
  const cardinal = q1<any>(`SELECT id FROM properties WHERE slug='cardinal-commons'`);
  const ccUnits = q<any>(
    `SELECT u.id, u.unit_number, f.beds FROM units u JOIN floorplans f ON f.id=u.floorplan_id
     WHERE u.property_id=? ORDER BY u.unit_number`,
    cardinal.id,
  );
  let bedLeases = 0;
  let guarantors = 0;
  let n = 0;
  for (const [ui, unit] of ccUnits.entries()) {
    for (let b = 0; b < unit.beds; b++) {
      // ~72% of beds pre-leased, deterministic pattern with gaps for the demo
      if ((ui * 4 + b) % 25 >= 18) continue;
      const first = FIRST[n % FIRST.length]!;
      const last = LAST[(n * 7 + 3) % LAST.length]!;
      const withGuarantor = n % 2 === 0;
      assignBed(ctx, {
        unitId: unit.id,
        bedLabel: ['A', 'B', 'C', 'D'][b]!,
        firstName: first,
        lastName: last,
        email: `${first.toLowerCase()}.${last.toLowerCase()}${n}@student.demo`,
        rentCents: 89900 + (b === 0 ? 4000 : 0), // bed A carries the window premium
        guarantor: withGuarantor ? { name: `Pat ${last}`, email: `pat.${last.toLowerCase()}${n}@family.demo` } : null,
      });
      bedLeases++;
      if (withGuarantor) guarantors++;
      n++;
    }
  }
  // spread creation dates across the pre-lease season so pacing has a curve
  const fallRows = q<any>(
    `SELECT id FROM leases WHERE property_id=? AND bed_label IS NOT NULL AND start_date=? ORDER BY id`,
    cardinal.id, cal.fallStart,
  );
  const seasonStart = `${cal.fallStart.slice(0, 4)}-02-01`;
  for (const [i, row] of fallRows.entries()) {
    const day = Math.floor((i / Math.max(1, fallRows.length)) * 160); // Feb → mid-July
    run('UPDATE leases SET created_at=? WHERE id=?', `${addDays(seasonStart, day)}T12:00:00.000Z`, row.id);
  }
  log(`student: ${bedLeases} fall bed leases at Cardinal (${Math.round((bedLeases / 96) * 100)}% pre-leased), ${guarantors} parent guarantors with portal access`);

  // roommate questionnaires: 8 unassigned prospects awaiting fall grouping
  for (let i = 0; i < 8; i++) {
    const answers: Record<string, string> = {};
    for (const [qi, qn] of ROOMMATE_QUESTIONS.entries()) {
      answers[qn.key] = qn.options[(i + qi) % 2 === 0 ? 0 : 1]!;
    }
    insert('roommate_profiles', {
      id: id('rmp'), org_id: s.orgId, property_id: cardinal.id, application_id: null,
      person_name: `${FIRST[(i * 3 + 1) % FIRST.length]} ${LAST[(i * 5 + 2) % LAST.length]}`,
      answers: js(answers), created_at: nowIso(),
    });
  }
  log('student: 8 roommate questionnaires awaiting grouping');

  // ---------- AFFORDABLE: Foundry LIHTC set-aside ----------
  const foundry = q1<any>(`SELECT id FROM properties WHERE slug='foundry-lofts'`);
  // deterministic rent-limit schedule (60% AMI Denver-flavored)
  const LIMITS: [number, number, number][] = [
    // [ami, beds, max_rent_cents]
    [50, 0, 132500], [50, 1, 142000], [50, 2, 170500], [50, 3, 197000],
    [60, 0, 159000], [60, 1, 170500], [60, 2, 204500], [60, 3, 236500],
    [80, 0, 212000], [80, 1, 227000], [80, 2, 272500], [80, 3, 315000],
  ];
  for (const [ami, beds, max] of LIMITS) {
    insert('rent_limits', { id: id('rlm'), org_id: s.orgId, ami_pct: ami, beds, max_rent_cents: max });
  }
  // pick 20 Foundry units whose CURRENT rents comply at 60% AMI net of allowance
  const candidates = q<any>(
    `SELECT u.id, u.unit_number, f.beds,
       (SELECT l.rent_cents FROM leases l WHERE l.unit_id=u.id AND l.status IN ('active','month_to_month','notice') LIMIT 1) AS rent
     FROM units u JOIN floorplans f ON f.id=u.floorplan_id
     WHERE u.property_id=? ORDER BY u.market_rent_cents`,
    foundry.id,
  );
  // occupied units first (their current rents must comply), then vacant fill;
  // each unit lands in the LOWEST AMI band its rent fits (mixed-band deal)
  const program: any[] = [];
  const bandFor = (u: any, allowance: number): number | null => {
    for (const ami of [50, 60, 80]) {
      const limit = LIMITS.find((l) => l[0] === ami && l[1] === Math.min(3, u.beds || 0))![2];
      if ((u.rent ?? 0) <= limit - allowance) return ami;
    }
    return null;
  };
  const occupied = candidates.filter((u) => u.rent).slice(0, 18); // leave room for 2 vacant set-asides
  const vacant = candidates.filter((u) => !u.rent);
  for (const u of [...occupied, ...vacant]) {
    if (program.length >= 20) break;
    const allowance = 7500 + (u.beds || 0) * 2500;
    const ami = bandFor(u, allowance);
    if (ami === null) continue;
    run('UPDATE units SET program=?, ami_pct=?, utility_allowance_cents=? WHERE id=?', 'lihtc', ami, allowance, u.id);
    program.push({ ...u, allowance, ami });
  }
  // initial certifications: complete for occupied program units (backdated through the year)
  let certs = 0;
  const LIMIT_100 = [7080000, 8090000, 9100000, 10110000, 10920000, 11730000];
  for (const [i, u] of program.entries()) {
    if (!u.rent) continue; // vacant program units certify at move-in
    const size = 1 + (i % 4);
    const certId = startCert(ctx, {
      unitId: u.id, kind: 'initial', householdSize: size,
      incomeCents: Math.round((LIMIT_100[size - 1]! * (u.ami - 12 - (i % 3) * 5)) / 100 / 100) * 100, // inside the unit's band
    });
    for (let k = 0; k < CERT_CHECKLIST.length; k++) checkCertItem(ctx, certId, k, true);
    completeCert(ctx, certId);
    // backdate completion so annual recerts stagger across the coming year
    run(
      `UPDATE income_certs SET completed_at=?, created_at=? WHERE id=?`,
      `${addDays(s.businessDate, -300 + i * 14)}T10:00:00.000Z`, `${addDays(s.businessDate, -330 + i * 14)}T10:00:00.000Z`, certId,
    );
    certs++;
  }
  // one annual recert overdue + one in progress (the live compliance story)
  const first2 = program.filter((u) => u.rent).slice(0, 2);
  for (const [i, u] of first2.entries()) {
    const certId = startCert(ctx, {
      unitId: u.id, kind: 'annual', householdSize: 2,
      incomeCents: 3600000, dueDate: addDays(s.businessDate, i === 0 ? -9 : 21),
    });
    if (i === 1) for (let k = 0; k < 3; k++) checkCertItem(ctx, certId, k, true);
  }
  log(`affordable: ${program.length} LIHTC units at Foundry, ${certs} initial certs complete, 1 recert OVERDUE + 1 in progress`);

  // waitlist with an audited skip
  const WL = [
    ['Dana Whitcomb', 2, 3100000, '1BR'], ['Rafael Suarez', 4, 4400000, '2BR'],
    ['Kim Nguyen-Ellis', 1, 2600000, 'studio or 1BR'], ['Jerome Watts', 3, 3900000, '2BR accessible'],
    ['Petra Ilic', 2, 3300000, '1BR'], ['Moses Adeyemi', 5, 5100000, '3BR'],
    ['Casey Sunday', 1, 2450000, 'studio'], ['Rosa Delacruz', 3, 4050000, '2BR'],
  ] as const;
  const wlIds: string[] = [];
  for (const [name, size, income, needs] of WL) {
    wlIds.push(addToWaitlist(ctx, {
      propertyId: foundry.id, name, email: `${name.toLowerCase().replaceAll(/[^a-z]+/g, '.')}@applicants.demo`,
      householdSize: size, incomeCents: income, preferences: { needs },
    }));
  }
  waitlistAction(ctx, wlIds[0]!, 'skip', 'Household needs a 1BR; only 3BR set-aside vacancy available this cycle');
  waitlistAction(ctx, wlIds[1]!, 'offer');
  log(`affordable: waitlist of ${WL.length} — position 1 skipped with documented reason, position 2 offered`);

  const totalFall = val<number>(`SELECT COUNT(*) FROM leases WHERE property_id=? AND bed_label IS NOT NULL`, cardinal.id) || 0;
  log(`verticals: student + affordable live (${totalFall} bed leases, ${program.length} program units)`);
}
