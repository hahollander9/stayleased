import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert, run, val } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { sysCtx } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { runInvariants } from '../src/modules/m9_accounting/service.ts';
import { createCharge, leaseBalance } from '../src/modules/m8_receivables/service.ts';
import { finalizeDeposit } from '../src/modules/m8_receivables/payments.ts';
import { generateReads } from '../src/lib/sim/submeter.ts';
import { verifyPolicy } from '../src/lib/sim/insurance.ts';
import {
  ensurePropertyMeters, ingestMonth, estimateRead, recordProviderInvoice,
  rubsPreview, saveRubsRun, postRubsRun,
} from '../src/modules/m11_utilities/service.ts';
import {
  submitPolicy, enrollMaster, complianceSweep, leaseCompliance,
  enrollDepositAlternative, settleAlternativeClaim,
} from '../src/modules/m12_insurance/service.ts';
import '../src/modules/m12_insurance/service.ts'; // registers the deposit-alt hook

/** Phase 11 units: RUBS math (proration, vacancy, admin fees, idempotency),
 * submeter determinism + estimation, insurance verification/lapse/auto-enroll,
 * deposit-alternative claims through disposition. */

let orgId: string;
let propId: string;
let vendorId: string;
const units: string[] = [];
const leases: string[] = [];
const BD = '2026-07-26';

before(() => {
  db();
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'Util Test Org', slug: 'util-' + orgId.slice(-6), business_date: BD, created_at: nowIso() });
  ensureCoa(orgId);
  propId = id('prp');
  insert('properties', {
    id: propId, org_id: orgId, name: 'Metered Manor', slug: 'metered-' + orgId.slice(-6), type: 'multifamily',
    address1: '3 Meter Ln', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso(),
  });
  vendorId = id('vnd');
  insert('vendors', {
    id: vendorId, org_id: orgId, name: 'Metro Water (test)', category: 'general',
    w9_on_file: 1, is_1099: 0, diversity_tags: '[]', approved_property_ids: '[]', active: 1, created_at: nowIso(),
  });
  // 3 units: A occupied all June; B moves out June 15; C vacant all month
  const specs = [
    { n: 'U-1', sqft: 800, lease: { start: '2026-01-01', end: '2026-12-31', status: 'active', moveOut: null } },
    { n: 'U-2', sqft: 800, lease: { start: '2025-08-01', end: '2026-07-31', status: 'ended', moveOut: '2026-06-15' } },
    { n: 'U-3', sqft: 800, lease: null },
  ];
  for (const s of specs) {
    const uid = id('unt');
    insert('units', {
      id: uid, org_id: orgId, property_id: propId, unit_number: s.n, floor: 1, sqft: s.sqft,
      status: s.lease?.status === 'active' ? 'occupied' : 'vacant_ready', market_rent_cents: 140000, amenities: '[]', created_at: nowIso(),
    });
    units.push(uid);
    if (s.lease) {
      const lid = id('lse');
      insert('leases', {
        id: lid, org_id: orgId, property_id: propId, unit_id: uid, household_name: `${s.n} household`,
        status: s.lease.status, start_date: s.lease.start, end_date: s.lease.end,
        move_in_date: s.lease.start, move_out_date: s.lease.moveOut,
        rent_cents: 140000, deposit_cents: 140000, deposit_alternative: 0, term_months: 12, created_at: nowIso(),
      });
      leases.push(lid);
      const rid = id('res');
      insert('residents', {
        id: rid, org_id: orgId, property_id: propId, first_name: s.n, last_name: 'Tester',
        email: `${s.n.toLowerCase()}@util.test`, kind: 'adult', created_at: nowIso(),
      });
      insert('household_members', { id: id('hm'), org_id: orgId, lease_id: lid, resident_id: rid, role: 'primary', created_at: nowIso() });
    }
  }
  insert('rubs_configs', {
    id: id('rcf'), org_id: orgId, property_id: propId, service: 'water', method: 'sqft',
    flat_fee_cents: 0, admin_fee_cents: 300, common_deduct_pct: 10, bill_vacant: 0, active: 1,
  });
});

test('submeter reads are deterministic and idempotent; estimation uses the trailing average', () => {
  const ctx = sysCtx(orgId);
  ensurePropertyMeters(orgId, propId, ['water']);
  for (const m of ['2026-03', '2026-04', '2026-05']) ingestMonth(ctx, m);
  const first = q<any>(`SELECT meter_id, usage_qty FROM meter_reads WHERE org_id=? AND month_key='2026-05' ORDER BY meter_id`, orgId);
  assert.equal(ingestMonth(ctx, '2026-05').added, 0, 'idempotent per month');
  run(`DELETE FROM meter_reads WHERE org_id=? AND month_key='2026-05'`, orgId);
  generateReads(orgId, '2026-05');
  const second = q<any>(`SELECT meter_id, usage_qty FROM meter_reads WHERE org_id=? AND month_key='2026-05' ORDER BY meter_id`, orgId);
  assert.deepEqual(first, second, 'regeneration reproduces identical reads');

  // estimation: force a review read and estimate from the 3-month average
  const meter = q1<any>(`SELECT id FROM meters WHERE property_id=? AND unit_id IS NOT NULL LIMIT 1`, propId);
  run(`UPDATE meter_reads SET status='review', anomaly='spike', usage_qty=99999 WHERE meter_id=? AND month_key='2026-05'`, meter.id);
  const cleanAvg = val<number>(
    `SELECT AVG(usage_qty) FROM (SELECT usage_qty FROM meter_reads WHERE meter_id=? AND status IN ('ok','estimated') AND month_key<'2026-05' ORDER BY month_key DESC LIMIT 3)`,
    meter.id,
  )!;
  estimateRead(ctx, q1<any>(`SELECT id FROM meter_reads WHERE meter_id=? AND month_key='2026-05'`, meter.id).id);
  const est = q1<any>(`SELECT * FROM meter_reads WHERE meter_id=? AND month_key='2026-05'`, meter.id);
  assert.equal(est.status, 'estimated');
  assert.equal(Math.abs(est.usage_qty - cleanAvg) < 1, true, `estimate ${est.usage_qty} ≈ trailing avg ${cleanAvg}`);
});

test('RUBS: sqft allocation prorates occupancy to the day and tracks vacant share', () => {
  const ctx = sysCtx(orgId);
  ingestMonth(ctx, '2026-06');
  recordProviderInvoice(ctx, {
    propertyId: propId, service: 'water', vendorId, usageMonth: '2026-06', totalCents: 90000, usageQty: 8600,
  });
  const p = rubsPreview(ctx, propId, 'water', '2026-06');
  assert.equal(p.commonCents, 9000, '10% common deduction');
  assert.equal(p.billableCents, 81000);
  // equal sqft → equal gross shares (~27000 each); U-1 full month, U-2 half, U-3 none
  const u1 = p.lines.find((l) => l.unitNumber === 'U-1' && l.leaseId);
  const u2 = p.lines.find((l) => l.unitNumber === 'U-2' && l.leaseId);
  const u2vac = p.lines.find((l) => l.unitNumber === 'U-2' && !l.leaseId);
  const u3vac = p.lines.find((l) => l.unitNumber === 'U-3' && !l.leaseId);
  assert.ok(u1 && u2 && u2vac && u3vac, 'lines for occupied, prorated and vacant units');
  assert.equal(u1!.occupiedDays, 30);
  assert.equal(u2!.occupiedDays, 15, 'move-out June 15 → 15 occupied days');
  assert.equal(u2!.amountCents + u2vac!.amountCents >= 26000, true, 'U-2 gross splits between lease and vacancy');
  assert.equal(Math.abs(u2!.amountCents - u2vac!.amountCents) <= 100, true, 'half-month split is ~even');
  assert.equal(p.recoveredCents + p.vacantCents, p.billableCents, 'every billable cent is either recovered or absorbed');
  assert.equal(u1!.adminFeeCents, 300, 'billing fee on resident lines');
  assert.equal(u3vac!.adminFeeCents, 0, 'no fee on vacant shares');
});

test('RUBS: posting creates converged charges once and only once', () => {
  const ctx = sysCtx(orgId);
  const runId = saveRubsRun(ctx, propId, 'water', '2026-06');
  const res = postRubsRun(ctx, runId, '2026-07-01');
  assert.equal(res.charges, 2, 'two occupied lines → two charges');
  const charges = q<any>(`SELECT * FROM charges WHERE org_id=? AND kind='utility'`, orgId);
  assert.equal(charges.length, 2);
  assert.match(charges[0].label, /Water \(RUBS\) — Jun 2026/);
  assert.throws(() => postRubsRun(ctx, runId), /already posted/);
  // month-key idempotency guards double posting even via a fresh run row
  for (const inv of runInvariants(ctx)) assert.equal(inv.ok, true, inv.name);
});

test('insurance: carrier sim is deterministic; verified upload replaces master enrollment', () => {
  const ctx = sysCtx(orgId);
  assert.equal(verifyPolicy('Allgood Mutual', 'REJECT-1', 10000000, 10000000).outcome, 'rejected');
  assert.equal(verifyPolicy('Allgood Mutual', 'SLOW-9', 10000000, 10000000).outcome, 'pending');
  assert.equal(verifyPolicy('Allgood Mutual', 'RS-100', 5000000, 10000000).outcome, 'rejected', 'liability below minimum');

  const leaseId = leases[0]!;
  enrollMaster(ctx, leaseId, 'enroll');
  assert.ok(q1(`SELECT id FROM lease_charges WHERE lease_id=? AND kind='insurance'`, leaseId), 'program fee line added');
  assert.equal(leaseCompliance(ctx, leaseId).policy.kind, 'master');

  const res = submitPolicy(ctx, {
    leaseId, carrier: 'Renters Shield Co.', policyNumber: 'RS-7788001', liabilityCents: 10000000,
    startDate: BD, endDate: '2027-07-26',
  });
  assert.equal(res.outcome, 'verified');
  assert.equal(leaseCompliance(ctx, leaseId).policy.kind, 'third_party', 'own policy replaces master');
  assert.equal(q1<any>(`SELECT id FROM lease_charges WHERE lease_id=? AND kind='insurance'`, leaseId), undefined, 'program fee stops');
});

test('insurance: lapse → auto-enroll with notice; reminders stage up', () => {
  const ctx = sysCtx(orgId);
  const leaseId = leases[0]!;
  // shrink the policy window so it lapses tomorrow
  run(`UPDATE insurance_policies SET end_date='2026-07-27' WHERE lease_id=? AND status='active'`, leaseId);
  let sweep = complianceSweep(ctx, '2026-07-26');
  assert.equal(sweep.reminded >= 1, true, '1-day reminder fires');
  const pol = q1<any>(`SELECT * FROM insurance_policies WHERE lease_id=? AND kind='third_party' ORDER BY created_at DESC`, leaseId);
  assert.equal(pol.reminder_stage, 3);

  sweep = complianceSweep(ctx, '2026-07-28');
  assert.equal(sweep.lapsed >= 1, true, 'policy expires');
  assert.equal(sweep.enrolled >= 1, true, 'force-placed into master');
  const c = leaseCompliance({ ...ctx, businessDate: '2026-07-28' } as any, leaseId);
  assert.equal(c.state, 'covered');
  assert.equal(c.policy.kind, 'master');
  assert.equal(c.policy.source, 'auto_enroll');
  const notice = q1<any>(
    `SELECT id FROM outbox_messages WHERE org_id=? AND template_key='insurance_autoenroll'`, orgId,
  );
  assert.ok(notice, 'auto-enroll notice in the outbox');
});

test('deposit alternative: claim covers the final balance up to coverage at disposition', () => {
  const ctx = sysCtx(orgId);
  // fresh lease with an alternative instead of a deposit
  const uid = id('unt');
  insert('units', { id: uid, org_id: orgId, property_id: propId, unit_number: 'U-9', floor: 1, sqft: 850, status: 'occupied', market_rent_cents: 150000, amenities: '[]', created_at: nowIso() });
  const lid = id('lse');
  insert('leases', {
    id: lid, org_id: orgId, property_id: propId, unit_id: uid, household_name: 'Alt household',
    status: 'active', start_date: '2026-01-01', end_date: '2026-12-31', move_in_date: '2026-01-01',
    rent_cents: 150000, deposit_cents: 150000, deposit_alternative: 0, term_months: 12, created_at: nowIso(),
  });
  enrollDepositAlternative(ctx, lid, 'monthly');
  const alt = q1<any>('SELECT * FROM deposit_alternatives WHERE lease_id=?', lid);
  assert.equal(alt.coverage_cents, 150000);
  assert.ok(q1(`SELECT id FROM lease_charges WHERE lease_id=? AND kind='deposit_alternative'`, lid), 'monthly fee line');

  // move-out with damages beyond coverage: claim caps at coverage, remainder stays
  createCharge(ctx, { leaseId: lid, kind: 'damage', label: 'Flooring + repaint', amountCents: 180000, date: BD, dueDate: BD, source: 'damage' });
  assert.equal(leaseBalance(ctx, lid), 180000);
  const result = finalizeDeposit(ctx, lid, { date: BD });
  const altAfter = q1<any>('SELECT * FROM deposit_alternatives WHERE lease_id=?', lid);
  assert.equal(altAfter.status, 'claimed');
  assert.equal(altAfter.claim_cents, 150000, 'claim capped at coverage');
  assert.equal(leaseBalance(ctx, lid), 30000, 'remainder stays with the resident');
  assert.equal(result.refunded, 0, 'nothing held, nothing refunded');
  for (const inv of runInvariants(ctx)) assert.equal(inv.ok, true, inv.name + ': ' + inv.detail);
});
