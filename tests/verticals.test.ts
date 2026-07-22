import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert, run, val, j } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso, addDays } from '../src/lib/dates.ts';
import { sysCtx } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import {
  assignBed, academicCalendar, bedRoster, preLeasePacing, matchScore, suggestGroups,
  startCert, checkCertItem, completeCert, CERT_CHECKLIST, maxTenantRent,
  addToWaitlist, waitlistAction, pcsBreak,
} from '../src/modules/m18_verticals/service.ts';
import { activateLease, renewalMatrix } from '../src/modules/m6_leases/service.ts';
import { createCharge, leaseBalance } from '../src/modules/m8_receivables/service.ts';

/** Phase 17 units: by-the-bed individual liability, pacing math, roommate
 * matching, affordable cert gating + rent limits, audit-safe waitlist
 * ordering, fee-free PCS breaks. */

const BD = '2026-07-26';
let orgId: string;
let studentProp: string;
let affordableProp: string;
let studentUnit: string;
let programUnit: string;
let marketLease: string;

before(() => {
  db();
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'Vertical Test Org', slug: 'vrt-' + orgId.slice(-6), business_date: BD, created_at: nowIso() });
  ensureCoa(orgId);
  studentProp = id('prp');
  insert('properties', {
    id: studentProp, org_id: orgId, name: 'Campus Test Hall', slug: 'campus-' + orgId.slice(-6), type: 'student',
    address1: '1 Quad', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso(),
  });
  const sfp = id('fpl');
  insert('floorplans', { id: sfp, org_id: orgId, property_id: studentProp, name: '4x4', beds: 4, baths: 4, sqft: 1400, market_rent_cents: 360000, created_at: nowIso() });
  studentUnit = id('unt');
  insert('units', {
    id: studentUnit, org_id: orgId, property_id: studentProp, floorplan_id: sfp, unit_number: 'T-101',
    floor: 1, sqft: 1400, status: 'vacant_ready', market_rent_cents: 360000, amenities: '[]', created_at: nowIso(),
  });

  affordableProp = id('prp');
  insert('properties', {
    id: affordableProp, org_id: orgId, name: 'Harbor Test Flats', slug: 'harbor-' + orgId.slice(-6), type: 'multifamily',
    address1: '2 Pier', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso(),
  });
  const afp = id('fpl');
  insert('floorplans', { id: afp, org_id: orgId, property_id: affordableProp, name: 'A1', beds: 1, baths: 1, sqft: 640, market_rent_cents: 175000, created_at: nowIso() });
  programUnit = id('unt');
  insert('units', {
    id: programUnit, org_id: orgId, property_id: affordableProp, floorplan_id: afp, unit_number: 'H-101',
    floor: 1, sqft: 640, status: 'vacant_ready', market_rent_cents: 175000, amenities: '[]',
    program: 'lihtc', ami_pct: 60, utility_allowance_cents: 10000, created_at: nowIso(),
  });
  insert('rent_limits', { id: id('rlm'), org_id: orgId, ami_pct: 60, beds: 1, max_rent_cents: 170500 });

  // a market lease for the PCS test
  const mu = id('unt');
  insert('units', {
    id: mu, org_id: orgId, property_id: affordableProp, floorplan_id: afp, unit_number: 'H-102',
    floor: 1, sqft: 640, status: 'occupied', market_rent_cents: 175000, amenities: '[]', created_at: nowIso(),
  });
  marketLease = id('lse');
  insert('leases', {
    id: marketLease, org_id: orgId, property_id: affordableProp, unit_id: mu, household_name: 'Sgt Rivera household',
    status: 'active', start_date: '2026-02-01', end_date: '2027-01-31', move_in_date: '2026-02-01',
    rent_cents: 168000, deposit_cents: 168000, deposit_alternative: 0, term_months: 12, created_at: nowIso(),
  });
  const rid = id('res');
  insert('residents', { id: rid, org_id: orgId, property_id: affordableProp, first_name: 'Ana', last_name: 'Rivera', email: 'ana.rivera@test.demo', kind: 'adult', created_at: nowIso() });
  insert('household_members', { id: id('hm'), org_id: orgId, lease_id: marketLease, resident_id: rid, role: 'primary', created_at: nowIso() });
});

test('by-the-bed: individual liability leases per bed with separate ledgers + guarantor portal', () => {
  const ctx = { ...sysCtx(orgId), userName: 'Test PM' };
  const cal = academicCalendar(ctx);
  const a = assignBed(ctx, {
    unitId: studentUnit, bedLabel: 'A', firstName: 'Riley', lastName: 'North', email: 'riley.north@student.test',
    rentCents: 93900, guarantor: { name: 'Sam North', email: 'sam.north@family.test' },
  });
  const b = assignBed(ctx, {
    unitId: studentUnit, bedLabel: 'B', firstName: 'Devon', lastName: 'Cruz', email: 'devon.cruz@student.test',
    rentCents: 89900, startDate: BD, // immediate mid-summer move-in
  });
  // same unit, two leases, individual beds
  const leases = q<any>('SELECT * FROM leases WHERE unit_id=? ORDER BY bed_label', studentUnit);
  assert.equal(leases.length, 2);
  assert.deepEqual(leases.map((l) => l.bed_label), ['A', 'B']);
  assert.equal(leases[0]!.end_date, cal.fallEnd, 'academic-year term');
  // double-booking a bed is blocked
  assert.throws(() => assignBed(ctx, { unitId: studentUnit, bedLabel: 'A', firstName: 'X', lastName: 'Y', email: 'x@y.test', rentCents: 90000 }), /already has a lease/);
  // non-student property refuses bed leases
  assert.throws(() => assignBed(ctx, { unitId: programUnit, bedLabel: 'A', firstName: 'X', lastName: 'Y', email: 'x2@y.test', rentCents: 90000 }), /student-property mode/);
  // separate ledgers: charge bed B only
  activateLease(ctx, b);
  createCharge(ctx, { leaseId: b, kind: 'rent', label: 'Prorated July (bed B)', amountCents: 17400, date: BD, dueDate: BD, source: 'move_in' });
  assert.equal(leaseBalance(ctx, b), 17400);
  assert.equal(leaseBalance(ctx, a), 0, 'bed A owes nothing — individual liability');
  // guarantor got a portal login tied to the lease
  const gUser = q1<any>(`SELECT u.id FROM users u WHERE u.email='sam.north@family.test'`);
  assert.ok(gUser, 'guarantor user exists');
  const gMember = q1<any>(
    `SELECT hm.role FROM household_members hm JOIN residents r ON r.id=hm.resident_id WHERE r.user_id=? AND hm.lease_id=?`,
    gUser.id, a,
  );
  assert.equal(gMember.role, 'guarantor');
  // roster shows both beds + two open ones
  const roster = bedRoster(ctx, studentProp);
  const unit = roster.find((r) => r.unit.id === studentUnit)!;
  assert.equal(unit.slots.filter((s) => s.fall || s.current?.bed_label).length, 2);
  const pacing = preLeasePacing(ctx, studentProp);
  assert.equal(pacing.totalBeds, 4);
  assert.equal(pacing.preleased >= 1, true, 'fall bed counts toward pacing');
});

test('roommate matching: similarity scores and suggested groupings', () => {
  const ctx = sysCtx(orgId);
  const mk = (name: string, answers: Record<string, string>): void => {
    insert('roommate_profiles', { id: id('rmp'), org_id: orgId, property_id: studentProp, application_id: null, person_name: name, answers: JSON.stringify(answers), created_at: nowIso() });
  };
  const night = { sleep: 'night owl', clean: 'very tidy', study: 'quiet at home', guests: 'rarely', smoke: 'no' };
  const early = { sleep: 'early bird', clean: 'relaxed', study: 'library/out', guests: 'often', smoke: 'no' };
  mk('N One', night); mk('N Two', night); mk('E One', early); mk('E Two', early);
  assert.equal(matchScore(night, night), 100);
  assert.equal(matchScore(night, early), 20, 'only smoking matches');
  const groups = suggestGroups(ctx, studentProp, 2);
  const g1 = groups.find((g) => g.members.some((m) => m.person_name === 'N One'))!;
  assert.equal(g1.members.length, 2);
  assert.ok(g1.members.every((m) => m.person_name.startsWith('N')), 'night owls grouped together');
  assert.equal(g1.avgScore, 100);
});

test('affordable: activation blocked without cert; over-limit rent blocked; cert unblocks', () => {
  const ctx = { ...sysCtx(orgId), userName: 'Compliance Tester' };
  // an over-limit lease on the program unit can never activate
  const over = id('lse');
  insert('leases', {
    id: over, org_id: orgId, property_id: affordableProp, unit_id: programUnit, household_name: 'Over household',
    status: 'fully_executed', start_date: BD, end_date: addDays(BD, 364), move_in_date: BD,
    rent_cents: 165000, deposit_cents: 0, deposit_alternative: 0, term_months: 12, created_at: nowIso(),
  });
  assert.throws(() => activateLease(ctx, over), /exceeds the 60% AMI limit/); // limit: 170500 − 10000 allowance = 160500
  run('UPDATE leases SET rent_cents=? WHERE id=?', 158000, over);
  // compliant rent still blocks without the certification
  assert.throws(() => activateLease(ctx, over), /income certification/);
  // certification: checklist gating + income qualification
  const certId = startCert(ctx, { unitId: programUnit, leaseId: over, householdSize: 2, incomeCents: 4400000 });
  assert.throws(() => completeCert(ctx, certId), /checklist incomplete/);
  for (let i = 0; i < CERT_CHECKLIST.length; i++) checkCertItem(ctx, certId, i, true);
  completeCert(ctx, certId);
  const cert = q1<any>('SELECT * FROM income_certs WHERE id=?', certId);
  assert.equal(cert.status, 'complete');
  assert.ok(cert.ami_pct <= 60, `qualified at ${cert.ami_pct}% AMI`);
  activateLease(ctx, over); // now clean
  assert.equal(q1<any>('SELECT status FROM leases WHERE id=?', over).status, 'active');
  // over-income household cannot certify
  const cert2 = startCert(ctx, { unitId: programUnit, householdSize: 1, incomeCents: 6500000 });
  for (let i = 0; i < CERT_CHECKLIST.length; i++) checkCertItem(ctx, cert2, i, true);
  assert.throws(() => completeCert(ctx, cert2), /above the unit's 60% set-aside/);
  // renewal matrix clamps at the limit for program units
  const lease = q1<any>('SELECT * FROM leases WHERE id=?', over);
  const options = renewalMatrix(ctx, lease);
  const max = maxTenantRent(ctx, q1<any>('SELECT * FROM units WHERE id=?', programUnit))!;
  assert.equal(max, 160500);
  assert.ok(options.every((o) => o.rent_cents <= max), 'every renewal option clamped to the program limit');
});

test('waitlist: immutable positions, offers in order, skips need documented reasons', () => {
  const ctx = { ...sysCtx(orgId), userName: 'Fair Housing Officer' };
  const w1 = addToWaitlist(ctx, { propertyId: affordableProp, name: 'First Family', householdSize: 3, incomeCents: 3900000 });
  const w2 = addToWaitlist(ctx, { propertyId: affordableProp, name: 'Second Family', householdSize: 1, incomeCents: 2500000 });
  // offering out of order is refused
  assert.throws(() => waitlistAction(ctx, w2, 'offer'), /ahead — offer in order/);
  // skipping without a reason is refused
  assert.throws(() => waitlistAction(ctx, w1, 'skip'), /requires a written reason/);
  waitlistAction(ctx, w1, 'skip', 'needs 3BR; none available this cycle');
  waitlistAction(ctx, w2, 'offer'); // now legal
  assert.equal(q1<any>('SELECT status, skip_reason FROM waitlist_entries WHERE id=?', w1).skip_reason, 'needs 3BR; none available this cycle');
  assert.equal(q1<any>('SELECT status FROM waitlist_entries WHERE id=?', w2).status, 'offered');
  const audits = val<number>(`SELECT COUNT(*) FROM audit_events WHERE org_id=? AND entity='waitlist'`, orgId) || 0;
  assert.ok(audits >= 4, 'every waitlist move audited');
});

test('military: PCS break is fee-free, documented, and 30-day gated', () => {
  const ctx = { ...sysCtx(orgId), userName: 'Test PM' };
  assert.throws(
    () => pcsBreak(ctx, { leaseId: marketLease, reportDate: BD, terminationDate: addDays(BD, 10) }),
    /at least 30 days/,
  );
  const chargesBefore = val<number>('SELECT COUNT(*) FROM charges WHERE lease_id=?', marketLease) || 0;
  pcsBreak(ctx, { leaseId: marketLease, reportDate: addDays(BD, -3), terminationDate: addDays(BD, 40) });
  const lease = q1<any>('SELECT * FROM leases WHERE id=?', marketLease);
  assert.equal(lease.status, 'notice');
  assert.equal(lease.move_out_date, addDays(BD, 40));
  assert.equal(val<number>('SELECT COUNT(*) FROM charges WHERE lease_id=?', marketLease), chargesBefore, 'NO early-termination fee posted');
  assert.ok(q1<any>('SELECT id FROM pcs_breaks WHERE lease_id=?', marketLease), 'PCS record on file');
  const confirm = q1<any>(`SELECT * FROM outbox_messages WHERE org_id=? AND template_key='pcs_confirmation'`, orgId);
  assert.match(confirm.body, /no early-termination fee/i);
});
