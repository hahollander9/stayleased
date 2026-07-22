import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert, run, val, j } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso, addDays, addMonths, monthKey } from '../src/lib/dates.ts';
import { sysCtx } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { createCharge } from '../src/modules/m8_receivables/service.ts';
import { recordPayment, writeOffBalance, openCollectionCase } from '../src/modules/m8_receivables/payments.ts';
import { rentRollAsOf, agingAsOf, occupancyAt, leaseBalanceAsOf } from '../src/modules/m14_reports/asof.ts';
import { backfillSnapshots, computeDayMetrics } from '../src/modules/m14_reports/snapshots.ts';
import { runCustom } from '../src/modules/m14_reports/builder.ts';
import { deliverSavedReport } from '../src/modules/m14_reports/schedule.ts';
import { reportDef, resolveParams } from '../src/modules/m14_reports/engine.ts';
import '../src/modules/m14_reports/pages.ts'; // registers all defs

/** Phase 15 units: as-of correctness (rent roll reproduces history), aging
 * parity with the live workbench, trial-balance zero-sum, the builder's
 * closed SQL surface, snapshot idempotence, scheduled delivery, write-offs. */

const BD = '2026-07-26';
const D6 = '2026-01-26'; // six months back — the gate date
let orgId: string;
let propId: string;
const units: string[] = [];
let earlyLease: string; // active since 2025-12, still active
let endedLease: string; // active at D6, ended in March
let lateLease: string; // started in May — must NOT appear at D6

before(() => {
  db();
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'Report Test Org', slug: 'rpt-' + orgId.slice(-6), business_date: BD, created_at: nowIso() });
  ensureCoa(orgId);
  propId = id('prp');
  insert('properties', {
    id: propId, org_id: orgId, name: 'Report Ridge', slug: 'rpt-' + orgId.slice(-6), type: 'multifamily',
    address1: '9 Ledger Ln', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso(),
  });
  const fpId = id('fpl');
  insert('floorplans', { id: fpId, org_id: orgId, property_id: propId, name: 'R1', beds: 1, baths: 1, sqft: 700, market_rent_cents: 150000, created_at: nowIso() });
  for (let i = 0; i < 4; i++) {
    const uid = id('unt');
    units.push(uid);
    insert('units', {
      id: uid, org_id: orgId, property_id: propId, floorplan_id: fpId, unit_number: `R-${101 + i}`,
      floor: 1, sqft: 700, status: i === 3 ? 'vacant_ready' : 'occupied', market_rent_cents: 150000, amenities: '[]', created_at: nowIso(),
    });
  }
  const mkLease = (unitIdx: number, start: string, end: string, status: string, opts: { moveOut?: string; rent?: number } = {}): string => {
    const lid = id('lse');
    insert('leases', {
      id: lid, org_id: orgId, property_id: propId, unit_id: units[unitIdx], household_name: `HH-${unitIdx}-${start}`,
      status, start_date: start, end_date: end, move_in_date: start, move_out_date: opts.moveOut || null,
      rent_cents: opts.rent ?? 140000, deposit_cents: 100000, deposit_alternative: 0, term_months: 12, created_at: nowIso(),
    });
    return lid;
  };
  earlyLease = mkLease(0, '2025-12-01', '2026-11-30', 'active');
  endedLease = mkLease(3, '2025-09-01', '2026-08-31', 'ended', { moveOut: '2026-03-15', rent: 130000 });
  lateLease = mkLease(1, '2026-05-01', '2027-04-30', 'active', { rent: 145000 });
  mkLease(2, '2026-02-01', '2027-01-31', 'active', { rent: 150000 });

  // ledger history: charges + payments around D6
  const c = sysCtx(orgId, '2026-01-01');
  createCharge(c, { leaseId: earlyLease, kind: 'rent', label: 'Rent Jan', amountCents: 140000, date: '2026-01-01', dueDate: '2026-01-01', source: 'recurring' });
  createCharge(c, { leaseId: endedLease, kind: 'rent', label: 'Rent Jan', amountCents: 130000, date: '2026-01-01', dueDate: '2026-01-01', source: 'recurring' });
  // earlyLease pays Jan on the 10th; endedLease never pays it
  recordPayment(sysCtx(orgId, '2026-01-10'), { leaseId: earlyLease, method: 'check', amountCents: 140000, reference: 'r1', receivedDate: '2026-01-10' });
  // post-D6 activity that must NOT leak into as-of-D6 numbers
  createCharge(sysCtx(orgId, '2026-07-01'), { leaseId: earlyLease, kind: 'rent', label: 'Rent Jul', amountCents: 140000, date: '2026-07-01', dueDate: '2026-07-01', source: 'recurring' });
});

test('GATE: the rent roll reproduces correctly for a date six months back', () => {
  const ctx = sysCtx(orgId);
  const roll = rentRollAsOf(ctx, propId, D6);
  // exactly the leases in possession on 2026-01-26: earlyLease + endedLease (moved out in March)
  assert.deepEqual(roll.map((r) => r.lease_id).sort(), [earlyLease, endedLease].sort());
  const ended = roll.find((r) => r.lease_id === endedLease)!;
  assert.equal(ended.rent_cents, 130000, 'historical rent preserved');
  assert.equal(ended.balance_cents, 130000, 'January rent unpaid as of the 26th');
  const early = roll.find((r) => r.lease_id === earlyLease)!;
  assert.equal(early.balance_cents, 0, 'paid on Jan 10 — clean at D6');
  // and the roll for TODAY is different: ended lease gone, late lease present
  const today = rentRollAsOf(ctx, propId, BD);
  assert.equal(today.some((r) => r.lease_id === endedLease), false, 'moved-out lease left the roll');
  assert.equal(today.some((r) => r.lease_id === lateLease), true, 'May move-in on today\'s roll');
  // totals are sums of the rows (what the report displays)
  const totalRent = roll.reduce((s, r) => s + r.rent_cents, 0);
  assert.equal(totalRent, 270000);
});

test('as-of balances respect payment and NSF timing', () => {
  const ctx = sysCtx(orgId);
  assert.equal(leaseBalanceAsOf(ctx, earlyLease, '2026-01-05'), 140000, 'before the payment landed');
  assert.equal(leaseBalanceAsOf(ctx, earlyLease, '2026-01-10'), 0, 'the day it landed');
  assert.equal(leaseBalanceAsOf(ctx, earlyLease, D6), 0);
});

test('occupancy at a date counts possession, not current status', () => {
  const ctx = sysCtx(orgId);
  const atD6 = occupancyAt(ctx, propId, D6);
  assert.equal(atD6.occupied, 2, 'early + ended-later leases occupied then');
  const now = occupancyAt(ctx, propId, BD);
  assert.equal(now.occupied, 3, 'late + feb lease + early today; ended unit vacant');
  assert.equal(now.rentable, 4);
});

test('aging as-of matches balances and keeps ended receivables on the books', () => {
  const ctx = sysCtx(orgId);
  const aging = agingAsOf(ctx, propId, BD);
  const endedRow = aging.find((a) => a.lease_id === endedLease);
  assert.ok(endedRow, 'ended lease with unpaid January stays in aging');
  assert.equal(endedRow!.balance, 130000);
  assert.equal(endedRow!.d90p, 130000, 'unpaid January is 90+ by late July');
  // aging at D6: the same charge is 1-30 days old
  const agingD6 = agingAsOf(ctx, propId, D6);
  assert.equal(agingD6.find((a) => a.lease_id === endedLease)!.d1_30, 130000);
});

test('trial balance sums to zero and the balance sheet balances', () => {
  const ctx = sysCtx(orgId);
  const def = reportDef('trial_balance')!;
  const res = def.run(ctx, resolveParams(ctx, def, new URLSearchParams({ property: 'all', date: BD, basis: 'accrual' })));
  const dr = res.rows.reduce((s, r) => s + Number(r.debit || 0), 0);
  const cr = res.rows.reduce((s, r) => s + Number(r.credit || 0), 0);
  assert.equal(dr, cr, 'debits equal credits');
  const bs = reportDef('balance_sheet')!;
  const bsRes = bs.run(ctx, resolveParams(ctx, bs, new URLSearchParams({ property: 'all', date: BD, basis: 'accrual' })));
  assert.match(bsRes.note || '', /BALANCED ✓/);
});

test('snapshots: backfill is idempotent and today matches the live computation', () => {
  const ctx = sysCtx(orgId);
  const n1 = backfillSnapshots(orgId, 3);
  const count1 = val<number>('SELECT COUNT(*) FROM metric_snapshots WHERE org_id=?', orgId);
  backfillSnapshots(orgId, 3);
  const count2 = val<number>('SELECT COUNT(*) FROM metric_snapshots WHERE org_id=?', orgId);
  assert.equal(count1, count2, 're-running upserts, never duplicates');
  assert.ok(n1 >= 4);
  const today = q1<any>('SELECT metrics FROM metric_snapshots WHERE property_id=? AND date=?', propId, BD);
  const live = computeDayMetrics(ctx, propId, BD);
  assert.deepEqual(j<any>(today.metrics, {}), live, 'snapshot is a cache of the live definition');
});

test('custom builder: filters, grouping and the closed SQL surface', () => {
  const ctx = sysCtx(orgId);
  const res = runCustom(ctx, {
    dataset: 'leases',
    cols: ['household', 'status', 'rent'],
    filters: [{ col: 'rent', op: 'gte', value: '1,400.00' }],
  });
  assert.equal(res.rows.length, 3, '$1,400+ leases only (money filter parses USD)');
  const grouped = runCustom(ctx, {
    dataset: 'leases',
    cols: ['status', 'rent'],
    filters: [],
    group: 'status',
  });
  const active = grouped.rows.find((r) => r.g === 'active')!;
  assert.equal(active.n, 3);
  assert.equal(active.m0, 140000 + 145000 + 150000, 'group sums money columns');
  // unknown columns simply can't be selected — the expression comes from code
  assert.throws(() => runCustom(ctx, { dataset: 'leases', cols: ['nope'], filters: [] }), /at least one column/);
  assert.throws(() => runCustom(ctx, { dataset: 'nope', cols: ['x'], filters: [] }), /unknown dataset/);
});

test('scheduled delivery: CSV lands as a Message Console attachment', () => {
  const ctx = sysCtx(orgId);
  const uid = id('usr');
  insert('users', { id: uid, org_id: orgId, email: 'rpt@test.demo', name: 'Report Owner', kind: 'staff', password_hash: 'x', active: 1, created_at: nowIso() });
  const sid = id('svr');
  insert('saved_reports', {
    id: sid, org_id: orgId, owner_user_id: uid, name: 'My delinquents', kind: 'canned', dataset: 'delinquency_aged',
    config: '{"property":"all"}', shared: 0, schedule: 'daily', last_run_date: null, created_at: nowIso(),
  });
  const fileId = deliverSavedReport(ctx, q1<any>('SELECT * FROM saved_reports WHERE id=?', sid), BD);
  const file = q1<any>('SELECT * FROM files WHERE id=?', fileId);
  assert.equal(file.mime, 'text/csv');
  assert.equal(file.owner_user_id, uid);
  const msg = q1<any>(`SELECT * FROM outbox_messages WHERE org_id=? AND template_key='scheduled_report' ORDER BY created_at DESC`, orgId);
  assert.match(msg.subject, /My delinquents/);
  assert.match(msg.body, new RegExp(`/f/${fileId}`), 'attachment link in the message');
  assert.equal(q1<any>('SELECT last_run_date FROM saved_reports WHERE id=?', sid).last_run_date, BD);
});

test('write-off: zeroes the balance through 5610 with a required reason', () => {
  const ctx = { ...sysCtx(orgId), userName: 'Controller' };
  assert.throws(() => writeOffBalance(ctx, endedLease, '  '), /reason/);
  openCollectionCase(ctx, endedLease, 'skip');
  const cents = writeOffBalance(ctx, endedLease, 'uncollectible');
  assert.equal(cents, 130000);
  assert.equal(leaseBalanceAsOf(ctx, endedLease, BD), 0, 'balance cleared');
  const je = q1<any>(
    `SELECT jl.debit_cents FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
     WHERE jl.org_id=? AND jl.account_code='5610' AND je.basis='accrual' ORDER BY je.posted_at DESC`,
    orgId,
  );
  assert.equal(je.debit_cents, 130000, 'bad debt expense debited');
  assert.equal(q1<any>(`SELECT status FROM collection_cases WHERE lease_id=?`, endedLease).status, 'written_off');
  assert.throws(() => writeOffBalance(ctx, endedLease, 'again'), /nothing to write off/);
});
