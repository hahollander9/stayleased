import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert, val, j } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { sysCtx, hashPassword } from '../src/lib/auth.ts';
import { runInvariants } from '../src/modules/m9_accounting/service.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { createCharge, leaseBalance } from '../src/modules/m8_receivables/service.ts';
import { recordPayment } from '../src/modules/m8_receivables/payments.ts';
import {
  ensureLeaseTemplates, renewalMatrix, createRenewalOffer, acceptRenewal,
  activateLease, recordSignature,
} from '../src/modules/m6_leases/service.ts';

/** Phase 9 units: renewal pricing, offer lifecycle, tamper-evident e-sign,
 * and renewal activation (household + ledger + autopay continuity). */

let orgId: string;
let propId: string;
let unitId: string;
let oldLeaseId: string;
let userId: string;
const RENT = 150000;

before(() => {
  db();
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'Lease Test Org', slug: 'lease-' + orgId.slice(-6), business_date: '2026-07-26', created_at: nowIso() });
  ensureCoa(orgId);
  ensureLeaseTemplates(orgId);
  propId = id('prp');
  insert('properties', {
    id: propId, org_id: orgId, name: 'Renewal Prop', slug: 'renewal-prop-' + orgId.slice(-6), type: 'multifamily',
    address1: '2 Renewal Rd', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso(),
  });
  unitId = id('unt');
  insert('units', {
    id: unitId, org_id: orgId, property_id: propId, unit_number: 'R-101', floor: 1, sqft: 850,
    status: 'occupied', market_rent_cents: RENT, amenities: '[]', created_at: nowIso(),
  });
  oldLeaseId = id('lse');
  insert('leases', {
    id: oldLeaseId, org_id: orgId, property_id: propId, unit_id: unitId, household_name: 'Renewal household',
    status: 'active', start_date: '2025-09-01', end_date: '2026-08-31', move_in_date: '2025-09-01',
    rent_cents: RENT, deposit_cents: RENT, term_months: 12, created_at: nowIso(),
  });
  insert('lease_charges', { id: id('lc'), org_id: orgId, lease_id: oldLeaseId, kind: 'rent', label: 'Rent — R-101', amount_cents: RENT, created_at: nowIso() });
  // primary resident with a portal user (renewal e-sign needs an adult with email)
  userId = id('usr');
  insert('users', {
    id: userId, org_id: orgId, email: 'renewer@lease.test', name: 'Rena Newal',
    kind: 'resident', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
  });
  const rid = id('res');
  insert('residents', {
    id: rid, org_id: orgId, property_id: propId, user_id: userId, first_name: 'Rena', last_name: 'Newal',
    email: 'renewer@lease.test', kind: 'adult', created_at: nowIso(),
  });
  insert('household_members', { id: id('hm'), org_id: orgId, lease_id: oldLeaseId, resident_id: rid, role: 'primary', created_at: nowIso() });
  // a countersigning staff user
  const pmId = id('usr');
  insert('users', {
    id: pmId, org_id: orgId, email: 'pm@lease.test', name: 'Patty Manager',
    kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
  });
  insert('role_assignments', { id: id('ra'), org_id: orgId, user_id: pmId, role: 'PROPERTY_MANAGER', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
});

test('renewal matrix: longer terms priced gentler, all capped by policy', () => {
  const ctx = sysCtx(orgId);
  const lease = q1<any>('SELECT * FROM leases WHERE id=?', oldLeaseId);
  const matrix = renewalMatrix(ctx, lease);
  assert.equal(matrix.length, 4);
  const cap = RENT * 1.08; // default renewal_max_increase_pct = 8
  for (const opt of matrix) {
    assert.equal(opt.rent_cents >= RENT, true, 'renewal never below current rent here');
    assert.equal(opt.rent_cents <= cap, true, `capped: ${opt.rent_cents}`);
    assert.equal(opt.rent_cents % 100, 0, 'rounded to whole dollars');
  }
  const by = Object.fromEntries(matrix.map((m) => [m.term_months, m.rent_cents]));
  assert.equal(by[15]! <= by[12]!, true);
  assert.equal(by[12]! <= by[6]!, true);
});

test('renewal offers are idempotent per open lease', () => {
  const ctx = sysCtx(orgId);
  const a = createRenewalOffer(ctx, oldLeaseId);
  const b = createRenewalOffer(ctx, oldLeaseId);
  assert.equal(a, b);
  const offer = q1<any>('SELECT * FROM renewal_offers WHERE id=?', a);
  assert.equal(offer.status, 'sent');
  assert.equal(j<any[]>(offer.options, []).length, 4);
});

let newLeaseId: string;

test('accepting a renewal drafts the successor lease and sends it out to sign', async () => {
  const ctx = sysCtx(orgId);
  const offerId = createRenewalOffer(ctx, oldLeaseId);
  const offer = q1<any>('SELECT * FROM renewal_offers WHERE id=?', offerId);
  const opt12 = j<any[]>(offer.options, []).find((o) => o.term_months === 12)!;
  newLeaseId = acceptRenewal(ctx, offerId, 12, 'http://test.local');

  const nl = q1<any>('SELECT * FROM leases WHERE id=?', newLeaseId);
  assert.equal(nl.renewal_of_lease_id, oldLeaseId);
  assert.equal(nl.start_date, '2026-09-01'); // day after old end
  assert.equal(nl.end_date, '2027-08-31');
  assert.equal(nl.rent_cents, opt12.rent_cents);
  assert.equal(nl.deposit_cents, RENT, 'deposit carried on paper');
  const lines = q<any>('SELECT * FROM lease_charges WHERE lease_id=?', newLeaseId);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].amount_cents, opt12.rent_cents, 'rent line re-priced');
  assert.equal(q1<any>('SELECT status FROM renewal_offers WHERE id=?', offerId).status, 'accepted');

  // packet + signature request build async
  for (let i = 0; i < 40 && q1<any>('SELECT status FROM leases WHERE id=?', newLeaseId).status !== 'out_for_signature'; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const sent = q1<any>('SELECT * FROM leases WHERE id=?', newLeaseId);
  assert.equal(sent.status, 'out_for_signature');
  assert.ok(sent.esign_request_id);
  assert.ok(sent.packet_file_id);
});

test('e-sign: countersigner cannot jump the queue; chain is tamper-evident; executes', async () => {
  const ctx = sysCtx(orgId);
  const reqId = q1<any>('SELECT esign_request_id FROM leases WHERE id=?', newLeaseId).esign_request_id;
  const signers = q<any>(`SELECT * FROM signature_signers WHERE request_id=? ORDER BY order_idx`, reqId);
  assert.equal(signers.length, 2, 'resident + countersigner');
  const resident = signers.find((s) => s.role === 'resident')!;
  const counter = signers.find((s) => s.role === 'countersigner')!;

  assert.throws(
    () => recordSignature(ctx, counter.token, { kind: 'typed', text: counter.name, initials: 'PM' }),
    /residents must sign/,
  );

  const r1 = recordSignature(ctx, resident.token, { kind: 'typed', text: 'Rena Newal', initials: 'RN' });
  assert.equal(r1.complete, false);
  assert.equal(q1<any>('SELECT status FROM leases WHERE id=?', newLeaseId).status, 'partially_signed');
  // signing twice is a no-op
  assert.equal(recordSignature(ctx, resident.token, { kind: 'typed', text: 'Rena Newal', initials: 'RN' }).complete, false);

  const r2 = recordSignature(ctx, counter.token, { kind: 'typed', text: 'Patty Manager', initials: 'PM' });
  assert.equal(r2.complete, true);
  for (let i = 0; i < 40 && q1<any>('SELECT status FROM leases WHERE id=?', newLeaseId).status !== 'fully_executed'; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const done = q1<any>('SELECT * FROM leases WHERE id=?', newLeaseId);
  assert.equal(done.status, 'fully_executed');
  const req = q1<any>('SELECT * FROM signature_requests WHERE id=?', reqId);
  assert.equal(req.status, 'completed');
  assert.ok(req.signed_file_id, 'merged executed packet stored');

  // tamper-evident chain: every event carries a fresh hash
  const events = j<any[]>(req.events, []);
  assert.equal(events.length >= 4, true, 'created + 2 signatures + completed');
  const hashes = events.map((e) => e.hash).filter(Boolean);
  assert.equal(new Set(hashes).size, hashes.length, 'chain hashes unique');
  assert.equal(events[events.length - 1]!.action, 'completed');
});

test('renewal activation: retires prior term and carries balance, autopay, open requests', () => {
  const ctx = sysCtx(orgId);
  // give the old lease a real ledger: August rent, partly paid → $500 carries
  createCharge(ctx, { leaseId: oldLeaseId, kind: 'rent', label: 'Rent — August', amountCents: RENT, date: '2026-08-01', dueDate: '2026-08-01', source: 'recurring' });
  recordPayment(ctx, { leaseId: oldLeaseId, amountCents: RENT - 50000, method: 'ach', receivedDate: '2026-08-03', memo: 'partial', suppressReceipt: true });
  const carry = leaseBalance(ctx, oldLeaseId);
  assert.equal(carry, 50000);

  insert('autopay_enrollments', {
    id: id('ap'), org_id: orgId, lease_id: oldLeaseId, user_id: userId, method_token_id: 'tok_test',
    mode: 'full_balance', day_of_month: 1, start_date: '2026-01-01', active: 1, created_at: nowIso(),
  });
  const woId = id('wo');
  insert('work_orders', {
    id: woId, org_id: orgId, property_id: propId, unit_id: unitId, lease_id: oldLeaseId,
    category: 'appliance', priority: 'normal', status: 'scheduled', summary: 'Oven igniter clicking',
    source: 'portal', created_date: '2026-07-20', created_at: nowIso(),
  });

  activateLease(ctx, newLeaseId);

  assert.equal(q1<any>('SELECT status FROM leases WHERE id=?', oldLeaseId).status, 'renewed');
  assert.equal(q1<any>('SELECT status FROM leases WHERE id=?', newLeaseId).status, 'active');

  // ledger continuity: old zeroed, new = carry + first month at renewal rent
  assert.equal(leaseBalance(ctx, oldLeaseId), 0, 'old ledger zeroed by transfer');
  const newRent = q1<any>('SELECT rent_cents FROM leases WHERE id=?', newLeaseId).rent_cents;
  assert.equal(leaseBalance(ctx, newLeaseId), carry + newRent);
  assert.equal(
    val<number>(`SELECT COUNT(*) FROM charges WHERE lease_id=? AND kind='deposit'`, newLeaseId) || 0, 0,
    'renewals never re-charge the deposit',
  );

  // household + living state carried
  assert.equal(val<number>('SELECT COUNT(*) FROM household_members WHERE lease_id=?', newLeaseId), 1);
  assert.equal(q1<any>('SELECT lease_id FROM autopay_enrollments WHERE user_id=? AND active=1', userId).lease_id, newLeaseId);
  assert.equal(q1<any>('SELECT lease_id FROM work_orders WHERE id=?', woId).lease_id, newLeaseId);
  assert.equal(val<number>(`SELECT COUNT(*) FROM move_checklists WHERE lease_id=?`, newLeaseId) || 0, 0, 'no move-in checklist for a renewal');

  // the books stay perfect
  for (const inv of runInvariants(ctx)) assert.equal(inv.ok, true, `${inv.name}: ${inv.detail || ''}`);
});
