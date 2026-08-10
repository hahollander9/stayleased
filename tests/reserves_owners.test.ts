import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert, val } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { sysCtx } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { postJE, accountBalance } from '../src/modules/m9_accounting/service.ts';
import {
  upsertReservePlan, fundReservePeriod, fundDueReserves, requestReserveDraw, decideReserveDraw, reserveBalance,
} from '../src/modules/m9_accounting/reserves.ts';
import { createOwner, setOwnershipShare, ownerStatement } from '../src/modules/m9_accounting/owners.ts';
import { createPacket, listPackets, packetCsv, deletePacket } from '../src/modules/m9_accounting/packets.ts';
import {
  ensureCatalog, createPo, upsertPriceAgreement, agreedPrice, endPriceAgreement,
} from '../src/modules/m16_procurement/service.ts';

/** Phase 19 units (accountant feedback): replacement reserves (plans, idempotent
 * funding, target caps, approval-gated draws, closed-period skips), owner
 * statements (share guardrails + equity-income math), statement packets, and
 * vendor price agreements enforced on PO creation. */

let orgId: string;
let propA: string;
let propB: string;
let vendorId: string;
const BD = '2026-07-26';

function mkProp(name: string, slug: string): string {
  const pid = id('prp');
  insert('properties', {
    id: pid, org_id: orgId, name, slug, type: 'multifamily',
    address1: '1 Reserve Way', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso(),
  });
  return pid;
}

before(() => {
  db();
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'Reserve Test Org', slug: 'rsv-' + orgId.slice(-6), business_date: BD, created_at: nowIso() });
  ensureCoa(orgId);
  propA = mkProp('Alder Point', 'alder-point-' + orgId.slice(-4));
  propB = mkProp('Birch Row', 'birch-row-' + orgId.slice(-4));
  vendorId = id('vnd');
  insert('vendors', {
    id: vendorId, org_id: orgId, name: 'Agreement Trades LLC', category: 'hvac',
    email: 'ap@agreementtrades.demo', w9_on_file: 1, is_1099: 1, diversity_tags: '[]', approved_property_ids: '[]', active: 1, created_at: nowIso(),
  });
  const ctx = sysCtx(orgId);
  for (const p of [propA, propB]) {
    for (const basis of ['accrual', 'cash'] as const) {
      postJE(ctx, {
        propertyId: p, date: '2026-04-30', basis, memo: 'Opening cash', sourceKind: 'opening',
        lines: [{ account: '1010', debit: 5000000 }, { account: '3020', credit: 5000000 }],
      });
    }
  }
});

test('reserve funding is idempotent per month and posts on both bases', () => {
  const ctx = sysCtx(orgId);
  upsertReservePlan(ctx, { propertyId: propA, monthlyCents: 100000, startPeriod: '2026-05' });
  const first = fundDueReserves(ctx, BD);
  assert.equal(first, 3, 'May, June, July funded');
  const second = fundDueReserves(ctx, BD);
  assert.equal(second, 0, 'second pass posts nothing new');
  assert.equal(reserveBalance(ctx, propA), 300000);
  assert.equal(accountBalance(ctx, '1030', { propertyId: propA, basis: 'cash', asOf: BD }), 300000, 'cash basis mirrors');
  const jeCount = val<number>(
    `SELECT COUNT(*) FROM journal_entries WHERE org_id=? AND source_kind='reserve_funding' AND property_id=?`, orgId, propA,
  );
  assert.equal(jeCount, 6, '3 months × 2 bases');
});

test('funding respects the target cap', () => {
  const ctx = sysCtx(orgId);
  upsertReservePlan(ctx, { propertyId: propB, monthlyCents: 100000, targetCents: 250000, startPeriod: '2026-05' });
  fundDueReserves(ctx, BD);
  assert.equal(reserveBalance(ctx, propB), 250000, 'July tops up to the target, not past it');
  const plan = q1<any>('SELECT id FROM reserve_plans WHERE org_id=? AND property_id=?', orgId, propB);
  assert.equal(fundReservePeriod(ctx, plan.id, '2026-08'), 'capped');
});

test('funding skips a closed period instead of failing', () => {
  const ctx = sysCtx(orgId);
  insert('accounting_periods', {
    id: id('prd'), org_id: orgId, property_id: propA, period_key: '2026-04', status: 'closed',
    checklist: '[]', closed_at: nowIso(), closed_by: 'test',
  });
  const plan = q1<any>('SELECT id FROM reserve_plans WHERE org_id=? AND property_id=?', orgId, propA);
  assert.equal(fundReservePeriod(ctx, plan.id, '2026-04'), 'closed');
});

test('draws are balance-checked and approval-gated', () => {
  const ctx = sysCtx(orgId);
  assert.throws(() => requestReserveDraw(ctx, { propertyId: propA, amountCents: 600000, purpose: 'too big' }), /exceeds/);
  const drawId = requestReserveDraw(ctx, { propertyId: propA, amountCents: 200000, purpose: 'Roof section replacement' });
  assert.equal(reserveBalance(ctx, propA), 300000, 'request alone moves no money');
  const opBefore = accountBalance(ctx, '1010', { propertyId: propA, basis: 'accrual', asOf: BD });
  decideReserveDraw(ctx, drawId, true);
  assert.equal(reserveBalance(ctx, propA), 100000);
  const opAfter = accountBalance(ctx, '1010', { propertyId: propA, basis: 'accrual', asOf: BD });
  assert.equal(opAfter - opBefore, 200000, 'approved draw returns cash to operating');
  const d = q1<any>('SELECT * FROM reserve_draws WHERE id=?', drawId);
  assert.equal(d.status, 'approved');
  assert.ok(d.je_accrual_id && d.je_cash_id, 'JEs linked on both bases');
  const denyId = requestReserveDraw(ctx, { propertyId: propA, amountCents: 10000, purpose: 'denied test' });
  decideReserveDraw(ctx, denyId, false);
  assert.equal(reserveBalance(ctx, propA), 100000, 'denied draw moves nothing');
  assert.throws(() => decideReserveDraw(ctx, denyId, true), /already decided/);
});

test('ownership shares can never exceed 100% of a property', () => {
  const ctx = sysCtx(orgId);
  const o1 = createOwner(ctx, { name: 'Cedar Capital LLC', kind: 'entity' });
  const o2 = createOwner(ctx, { name: 'Jamie Field' });
  setOwnershipShare(ctx, { ownerId: o1, propertyId: propA, pct: 60 });
  assert.throws(() => setOwnershipShare(ctx, { ownerId: o2, propertyId: propA, pct: 41 }), /exceed 100%/);
  setOwnershipShare(ctx, { ownerId: o2, propertyId: propA, pct: 40 });
  setOwnershipShare(ctx, { ownerId: o1, propertyId: propA, pct: 55 });
  setOwnershipShare(ctx, { ownerId: o2, propertyId: propA, pct: 0 });
  assert.equal(q<any>('SELECT * FROM property_owners WHERE property_id=?', propA).length, 1, 'zero pct removes the share');
});

test('owner statement scales operating results and capital activity by share', () => {
  const ctx = sysCtx(orgId);
  const owner = createOwner(ctx, { name: 'Halvorsen Family Trust', kind: 'entity' });
  setOwnershipShare(ctx, { ownerId: owner, propertyId: propB, pct: 50 });
  postJE(ctx, {
    propertyId: propB, date: '2026-07-05', basis: 'accrual', memo: 'July rent', sourceKind: 'charge',
    lines: [{ account: '1100', debit: 2000000 }, { account: '4010', credit: 2000000 }],
  });
  postJE(ctx, {
    propertyId: propB, date: '2026-07-10', basis: 'accrual', memo: 'Plumbing repair', sourceKind: 'invoice',
    lines: [{ account: '5010', debit: 500000 }, { account: '2010', credit: 500000 }],
  });
  postJE(ctx, {
    propertyId: propB, date: '2026-07-12', basis: 'accrual', memo: 'Owner contribution', sourceKind: 'manual',
    lines: [{ account: '1010', debit: 100000 }, { account: '3020', credit: 100000 }],
  });
  const st = ownerStatement(ctx, owner, { to: BD, basis: 'accrual' });
  assert.equal(st.rows.length, 1);
  const row = st.rows[0]!;
  assert.equal(row.income, 1000000, '50% of $20,000 rent');
  assert.equal(row.expenses, 250000, '50% of $5,000 repair');
  assert.equal(row.equityIncome, 750000, '50% of net operating result');
  // capital window (trailing 12) includes the fixture's 2026-04-30 opening
  // contribution (5,000,000) plus the July contribution (100,000)
  assert.equal(row.capitalShare, 2550000, '50% of all 3020 activity in the window');
  assert.equal(row.reserveShare, 125000, '50% of the $2,500 reserve balance');
  assert.equal(st.totals.equityIncome, 750000);
});

test('statement packets: saved pull renders a multi-statement CSV; deletion guarded', () => {
  const ctx = sysCtx(orgId);
  const pid = createPacket(ctx, { name: 'Board packet — consolidated', propertyId: null, basis: 'accrual' });
  assert.ok(listPackets(ctx).some((p) => p.id === pid));
  const csv = packetCsv(ctx, q1<any>('SELECT * FROM statement_packets WHERE id=?', pid), BD);
  assert.match(csv, /INCOME STATEMENT — TRAILING 12 MONTHS/);
  assert.match(csv, /BALANCE SHEET — AS OF 2026-07-26/);
  assert.match(csv, /CASH FLOW — TRAILING 12 MONTHS/);
  assert.match(csv, /TRAILING 12 BY MONTH/);
  assert.match(csv, /Rent Income/);
  deletePacket(ctx, pid);
  assert.equal(q1<any>('SELECT id FROM statement_packets WHERE id=?', pid), undefined);
});

test('vendor price agreements: effective-window lookups and PO enforcement', () => {
  const ctx = sysCtx(orgId);
  ensureCatalog(orgId);
  const filter = q1<any>(`SELECT * FROM catalog_items WHERE org_id=? AND name LIKE 'HVAC filter%'`, orgId);
  assert.ok(filter, 'catalog seeded');
  upsertPriceAgreement(ctx, { vendorId, catalogItemId: filter.id, priceCents: 4321, effectiveDate: '2026-07-01' });
  assert.equal(agreedPrice(orgId, vendorId, filter.id, BD), 4321);
  assert.equal(agreedPrice(orgId, vendorId, filter.id, '2026-06-30'), null, 'not yet effective');
  const poId = createPo(ctx, {
    propertyId: propA, vendorId, memo: 'agreement test',
    lines: [{ catalogItemId: filter.id, description: filter.name, qty: 10, unitPriceCents: filter.unit_price_cents, glAccount: filter.gl_account }],
  });
  const line = q1<any>('SELECT * FROM purchase_order_lines WHERE po_id=?', poId);
  assert.equal(line.unit_price_cents, 4321, 'agreed price overrides catalog');
  assert.equal(q1<any>('SELECT total_cents FROM purchase_orders WHERE id=?', poId).total_cents, 43210);
  upsertPriceAgreement(ctx, { vendorId, catalogItemId: filter.id, priceCents: 4321, effectiveDate: '2026-07-01', expiresDate: '2026-07-10' });
  assert.equal(agreedPrice(orgId, vendorId, filter.id, BD), null, 'expired agreement is ignored');
  upsertPriceAgreement(ctx, { vendorId, catalogItemId: filter.id, priceCents: 4444, effectiveDate: '2026-07-01' });
  endPriceAgreement(ctx, q1<any>('SELECT id FROM vendor_price_agreements WHERE vendor_id=?', vendorId).id);
  assert.equal(agreedPrice(orgId, vendorId, filter.id, BD), null, 'ended agreement no longer applies');
});
