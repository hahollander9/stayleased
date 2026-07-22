import { insert, q, q1, run, tx, js } from '../lib/db.ts';
import { id } from '../lib/ids.ts';
import { nowIso, addMonths, addDays, mkDate, parts, monthKey, diffDays } from '../lib/dates.ts';
import { hashPassword, sysCtx } from '../lib/auth.ts';
import { ensureCoa } from '../modules/m9_accounting/coa.ts';
import { runRentPosting } from '../modules/m8_receivables/service.ts';
import { FIRST, LAST, EMPLOYERS, PET_NAMES, DOG_BREEDS, CAT_BREEDS, CAR_MAKES } from './names.ts';
import type { SeedCtx } from './seed.ts';
import { log } from './seed.ts';

/** Phase 2 seed: households/leases at ~93% occupancy with realistic
 * distributions (§8), unit statuses derived from leases, recurring charge
 * schedules, rentable-item assignments, portal accounts, and the named demo
 * cast. Ends by running the real rent-posting job for the current month. */

export interface CastIds {
  mayaLeaseId: string;
  derrickLeaseId: string;
}

let sharedHash: string | null = null;
function demoHash(): string {
  if (!sharedHash) sharedHash = hashPassword('demo1234');
  return sharedHash;
}

export function seedResidents(s: SeedCtx): CastIds {
  ensureCoa(s.orgId);
  const cast: CastIds = { mayaLeaseId: '', derrickLeaseId: '' };
  const props = q<any>('SELECT * FROM properties WHERE org_id=? ORDER BY created_at', s.orgId);
  const usedEmails = new Set<string>();

  tx(() => {
    for (const prop of props) {
      const rng = s.rng.fork(prop.name.length * 7 + prop.slug.charCodeAt(0));
      const isStudent = prop.type === 'student';
      const units = q<any>('SELECT * FROM units WHERE property_id=? ORDER BY unit_number', prop.id);

      // designate down/model
      const downCount = prop.slug === 'summit-ridge' ? 2 : prop.slug === 'foundry-lofts' ? 1 : 0;
      const modelCount = isStudent ? 0 : 1;
      const shuffled = rng.shuffle(units);
      const downUnits = shuffled.slice(0, downCount);
      const modelUnits = shuffled.slice(downCount, downCount + modelCount);
      for (const u of downUnits) run("UPDATE units SET status='down' WHERE id=?", u.id);
      for (const u of modelUnits) run("UPDATE units SET status='model' WHERE id=?", u.id);

      const rentable = shuffled.slice(downCount + modelCount);
      const occupancy = isStudent ? 0.92 : 0.932;
      const occupiedCount = Math.round(rentable.length * occupancy);
      let occupiedUnits = rentable.slice(0, occupiedCount);
      const vacant = rentable.slice(occupiedCount);

      // named cast pinning: Maya Torres → SR B-204; Derrick Cole → SR C-311 (or nearest)
      if (prop.slug === 'summit-ridge') {
        const pin = (unitNumber: string): any => {
          const u = units.find((x) => x.unit_number === unitNumber) || occupiedUnits[0];
          if (!occupiedUnits.some((x) => x.id === u.id)) {
            occupiedUnits = [u, ...occupiedUnits.filter((x) => x.id !== u.id).slice(0, occupiedUnits.length - 1)];
          }
          return u;
        };
        pin('B-204');
        pin('C-311');
      }

      // notice + MTM counts
      const noticeCount = isStudent ? 1 : prop.slug === 'summit-ridge' ? 13 : 8;
      const mtmCount = isStudent ? 0 : prop.slug === 'summit-ridge' ? 4 : 2;

      occupiedUnits.forEach((unit, idx) => {
        const isMaya = prop.slug === 'summit-ridge' && unit.unit_number === 'B-204';
        const isDerrick = prop.slug === 'summit-ridge' && unit.unit_number === 'C-311';
        const isNotice = !isMaya && !isDerrick && idx < noticeCount;
        const isMtm = !isMaya && !isDerrick && !isNotice && idx < noticeCount + mtmCount;

        // term shaping: expirations hump in summer
        const term = isStudent ? 12 : rng.weighted([[12, 70], [6, 8], [9, 8], [15, 8], [24, 6]] as const);
        let endDate: string;
        let startDate: string;
        if (isMaya) {
          // stable cast: long tenure, expiring soon → renewal-offer candidate
          startDate = '2025-09-01';
          endDate = '2026-08-31';
        } else if (isDerrick) {
          // long enough tenure to age into the 61–90 bucket
          startDate = '2026-01-15';
          endDate = '2027-01-14';
        } else if (isStudent) {
          // academic year: Aug 15 → Jul 31
          const { y } = parts(s.businessDate);
          startDate = mkDate(y - 1, 8, 15);
          endDate = mkDate(y, 7, 31);
        } else if (isMtm) {
          const monthsAgo = rng.int(1, 4);
          endDate = addDays(addMonths(s.businessDate, -monthsAgo), -rng.int(0, 20));
          startDate = addMonths(endDate, -term);
        } else {
          const endMonth = rng.weighted([[1, 5], [2, 6], [3, 6], [4, 7], [5, 9], [6, 10], [7, 9], [8, 10], [9, 8], [10, 7], [11, 5], [12, 5]] as const);
          const { y, m } = parts(s.businessDate);
          let ey = y;
          if (endMonth < m || (endMonth === m && rng.chance(0.5))) ey = y + 1;
          endDate = mkDate(ey, endMonth, rng.int(1, 28));
          if (diffDays(endDate, s.businessDate) < 3) endDate = addDays(s.businessDate, rng.int(10, 40));
          startDate = addMonths(endDate, -term);
          if (startDate > s.businessDate) {
            startDate = addDays(s.businessDate, -rng.int(20, 200));
          }
        }
        const moveIn = startDate;
        const rentDrift = 1 + rng.around(0, 0.05);
        const rent = Math.round((unit.market_rent_cents * rentDrift) / 500) * 500;

        const depositAlt = !isStudent && rng.chance(0.15);
        const depositMult = rng.chance(0.85) ? 1 : 1.5;
        const deposit = depositAlt ? 0 : Math.round((rent * depositMult) / 500) * 500;

        const leaseId = id('lse');
        const status = isNotice ? 'notice' : isMtm ? 'month_to_month' : 'active';
        const noticeDate = isNotice ? addDays(s.businessDate, -rng.int(5, 30)) : null;
        const moveOut = isNotice ? addDays(s.businessDate, rng.int(4, 40)) : null;

        // household
        const primaryFirst = isMaya ? 'Maya' : isDerrick ? 'Derrick' : rng.pick(FIRST);
        const primaryLast = isMaya ? 'Torres' : isDerrick ? 'Cole' : rng.pick(LAST);
        const householdName = `${primaryLast} household`;

        insert('leases', {
          id: leaseId, org_id: s.orgId, property_id: prop.id, unit_id: unit.id,
          household_name: householdName, status, start_date: startDate, end_date: endDate,
          move_in_date: moveIn, move_out_date: moveOut, notice_date: noticeDate,
          mtm_since: isMtm ? endDate : null, rent_cents: rent, deposit_cents: deposit,
          deposit_alternative: depositAlt ? 1 : 0, term_months: term, created_at: nowIso(),
        });
        run('UPDATE units SET status=? WHERE id=?', isNotice ? 'notice' : 'occupied', unit.id);

        // people
        const mkResident = (first: string, last: string, kind: string, role: string, withUser: boolean, forcedEmail?: string): string => {
          let email = forcedEmail || `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '') + '@mail.demo';
          let n = 2;
          while (usedEmails.has(email)) email = email.replace('@', `${n++}@`);
          usedEmails.add(email);
          const rid = id('res');
          let userId: string | null = null;
          if (withUser) {
            userId = id('usr');
            insert('users', {
              id: userId, org_id: s.orgId, email, name: `${first} ${last}`, kind: 'resident',
              password_hash: demoHash(), active: 1, created_at: nowIso(),
            });
          }
          insert('residents', {
            id: rid, org_id: s.orgId, property_id: prop.id, user_id: userId,
            first_name: first, last_name: last, email,
            phone: `(555) ${String(rng.int(200, 989))}-${String(rng.int(1000, 9999))}`,
            kind, employer: kind === 'adult' ? rng.pick(EMPLOYERS) : null,
            monthly_income_cents: kind === 'adult' ? Math.round((rent * (2.4 + rng.next() * 2.1)) / 1000) * 1000 : null,
            ssn_last4: String(rng.int(1000, 9999)),
            created_at: nowIso(),
          });
          insert('household_members', { id: id('hm'), org_id: s.orgId, lease_id: leaseId, resident_id: rid, role, created_at: nowIso() });
          return rid;
        };

        mkResident(primaryFirst, primaryLast, 'adult', 'primary', true, isMaya ? 'maya.torres@mail.demo' : isDerrick ? 'derrick.cole@mail.demo' : undefined);
        if (isStudent) {
          // 4 students per unit, each with a guarantor parent
          for (let b = 0; b < 3; b++) mkResident(rng.pick(FIRST), rng.pick(LAST), 'adult', 'co', b === 0);
          mkResident(rng.pick(FIRST), primaryLast, 'guarantor', 'guarantor', false);
        } else {
          if (rng.chance(0.4)) mkResident(rng.pick(FIRST), rng.chance(0.6) ? primaryLast : rng.pick(LAST), 'adult', 'co', rng.chance(0.5));
          if (rng.chance(0.22)) mkResident(rng.pick(FIRST), primaryLast, 'occupant', 'occupant', false);
          if (rng.chance(0.06)) mkResident(rng.pick(FIRST), rng.pick(LAST), 'guarantor', 'guarantor', false);
        }

        // recurring schedule: rent line
        insert('lease_charges', {
          id: id('lc'), org_id: s.orgId, lease_id: leaseId, kind: 'rent',
          label: `Rent — ${unit.unit_number}`, amount_cents: rent, created_at: nowIso(),
        });

        // pets
        if (!isStudent && rng.chance(0.3)) {
          const species = rng.chance(0.65) ? 'dog' : 'cat';
          insert('pets', {
            id: id('pet'), org_id: s.orgId, lease_id: leaseId, name: rng.pick(PET_NAMES), species,
            breed: species === 'dog' ? rng.pick(DOG_BREEDS) : rng.pick(CAT_BREEDS),
            weight_lbs: species === 'dog' ? rng.int(9, 70) : rng.int(6, 16), created_at: nowIso(),
          });
          insert('lease_charges', {
            id: id('lc'), org_id: s.orgId, lease_id: leaseId, kind: 'pet_rent',
            label: 'Pet rent', amount_cents: 3500, created_at: nowIso(),
          });
        }

        // vehicles
        const vehicles = rng.chance(0.75) ? (rng.chance(0.3) ? 2 : 1) : 0;
        for (let vi = 0; vi < vehicles; vi++) {
          const [make, model] = rng.pick(CAR_MAKES);
          insert('vehicles', {
            id: id('veh'), org_id: s.orgId, lease_id: leaseId, make, model,
            plate: `${String.fromCharCode(65 + rng.int(0, 25))}${String.fromCharCode(65 + rng.int(0, 25))}${String.fromCharCode(65 + rng.int(0, 25))}-${rng.int(100, 999)}`,
            state: prop.state, created_at: nowIso(),
          });
        }

        // rentable item assignment
        const itemChance = prop.slug === 'foundry-lofts' ? 0.45 : prop.slug === 'summit-ridge' ? 0.32 : 0.5;
        if (rng.chance(itemChance)) {
          const item = q1<any>(
            `SELECT * FROM rentable_items WHERE property_id=? AND status='available' AND kind != 'pet' ORDER BY label LIMIT 1`,
            prop.id,
          );
          if (item) {
            run("UPDATE rentable_items SET status='assigned', assigned_lease_id=? WHERE id=?", leaseId, item.id);
            insert('lease_charges', {
              id: id('lc'), org_id: s.orgId, lease_id: leaseId, kind: item.kind,
              label: `${item.label}`, amount_cents: item.monthly_cents, rentable_item_id: item.id, created_at: nowIso(),
            });
          }
        }

        if (isMaya) cast.mayaLeaseId = leaseId;
        if (isDerrick) cast.derrickLeaseId = leaseId;
      });

      // vacant split ready/not-ready
      for (const u of vacant) {
        run('UPDATE units SET status=? WHERE id=?', rng.chance(0.6) ? 'vacant_ready' : 'vacant_not_ready', u.id);
      }
    }
  });

  // current-month charges through the real engine
  const ctx = sysCtx(s.orgId, s.businessDate);
  const summary = runRentPosting(ctx, s.businessDate);
  const leaseCount = q1<{ n: number }>('SELECT COUNT(*) n FROM leases WHERE org_id=?', s.orgId)?.n;
  const resCount = q1<{ n: number }>('SELECT COUNT(*) n FROM residents WHERE org_id=?', s.orgId)?.n;
  log(`${leaseCount} leases, ${resCount} residents · rent run: ${summary}`);
  s.demoLogins.push(['Resident (Maya Torres)', 'maya.torres@mail.demo', 'Summit Ridge B-204, autopay']);
  s.demoLogins.push(['Resident (Derrick Cole)', 'derrick.cole@mail.demo', 'delinquent 61d, payment-plan candidate']);
  return cast;
}
