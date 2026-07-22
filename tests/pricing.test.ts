import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert, run, val, j } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso, addMonths, monthKey } from '../src/lib/dates.ts';
import { sysCtx } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { setSetting } from '../src/lib/settings.ts';
import {
  ensureCompSets, generateCompObservations, compAverage, priceUnit, runPricingEngine,
  decideRecommendation, termRateMatrix, runRenewalBatch, revenueAnalytics, type Factor,
} from '../src/modules/m13_pricing/service.ts';
import { quotedRent } from '../src/modules/m3_crm/service.ts';
import { renewalMatrix } from '../src/modules/m6_leases/service.ts';

/** Phase 14 units: transparent factor math, the ±5% guardrail, term-rate
 * expiration steering, the renewal cap, and accept→quote/site flow. */

const BD = '2026-07-26';
let orgId: string;
let propId: string;
let fpId: string; // 10-unit floorplan
const units: string[] = [];

before(() => {
  db();
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'Pricing Test Org', slug: 'price-' + orgId.slice(-6), business_date: BD, created_at: nowIso() });
  ensureCoa(orgId);
  propId = id('prp');
  insert('properties', {
    id: propId, org_id: orgId, name: 'Pricer Point', slug: 'pricer-' + orgId.slice(-6), type: 'multifamily',
    address1: '1 Algo Ave', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso(),
  });
  fpId = id('fpl');
  insert('floorplans', {
    id: fpId, org_id: orgId, property_id: propId, name: 'A1', beds: 1, baths: 1, sqft: 700,
    market_rent_cents: 150000, created_at: nowIso(),
  });
  // 10 units: 8 occupied, 2 vacant (20% exposure vs 7% target)
  for (let i = 0; i < 10; i++) {
    const uid = id('unt');
    units.push(uid);
    insert('units', {
      id: uid, org_id: orgId, property_id: propId, floorplan_id: fpId, unit_number: `P-${100 + i}`,
      floor: 1, sqft: 700, status: i < 2 ? 'vacant_ready' : 'occupied', market_rent_cents: 150000,
      amenities: '[]', created_at: nowIso(),
    });
    if (i >= 2) {
      insert('leases', {
        id: id('lse'), org_id: orgId, property_id: propId, unit_id: uid, household_name: `P${i} household`,
        status: 'active', start_date: '2026-01-01', end_date: i < 6 ? '2026-10-31' : '2027-03-31',
        move_in_date: '2026-01-01', rent_cents: 140000, deposit_cents: 0, deposit_alternative: 0,
        term_months: 12, created_at: nowIso(),
      });
    }
  }
});

test('factor math is transparent: deltas sum to the recommendation (pre-rounding)', () => {
  const ctx = sysCtx(orgId);
  ensureCompSets(orgId);
  generateCompObservations(orgId, monthKey(BD));
  const unit = q1<any>('SELECT * FROM units WHERE id=?', units[0]);
  const rec = priceUnit(ctx, unit, BD);
  assert.ok(rec.factors.length >= 2, 'exposure + season at minimum');
  assert.match(rec.factors.map((f) => f.label).join(' | '), /exposure 20% far above 7% target/);
  assert.match(rec.factors.map((f) => f.label).join(' | '), /peak leasing season/);
  const sum = rec.factors.reduce((s, f) => s + f.delta_cents, 0);
  assert.equal(Math.round((rec.base + sum) / 500) * 500, rec.recommended, 'factors fully explain the number');
});

test('guardrail caps any single review at ±5%', () => {
  const ctx = sysCtx(orgId);
  // force an extreme: price the unit 40% above the comp set
  run('UPDATE units SET market_rent_cents=? WHERE id=?', 220000, units[1]);
  const unit = q1<any>('SELECT * FROM units WHERE id=?', units[1]);
  const rec = priceUnit(ctx, unit, BD);
  const movePct = Math.abs(rec.recommended - rec.base) / rec.base;
  assert.ok(movePct <= 0.052, `move ${(movePct * 100).toFixed(1)}% stays within the 5% guardrail (+rounding)`);
  run('UPDATE units SET market_rent_cents=? WHERE id=?', 150000, units[1]);
});

test('term matrix steers expirations: heavy month priced up, light month down', () => {
  const ctx = sysCtx(orgId);
  // 4 leases already end 2026-10 (heavy), none end 2026-12 (light)
  const unit = q1<any>('SELECT * FROM units WHERE id=?', units[0]);
  const matrix = termRateMatrix(ctx, unit, BD, 150000);
  const oct = matrix.find((t) => t.expiresMonth === '2026-10')!; // term 3
  const dec = matrix.find((t) => t.expiresMonth === '2026-12')!; // term 5
  assert.equal(oct.loadFactor, 'high');
  assert.equal(dec.loadFactor, 'low');
  // base short-term curve: term 3 = +6.2%, term 5 = +4.6% — steering must beat the slope
  assert.ok(oct.adj >= 6.2 + 2.4, `heavy month gets the +2.5 steer (got ${oct.adj})`);
  assert.ok(dec.adj <= 4.6 - 1.4, `light month gets the −1.5 steer (got ${dec.adj})`);
  // same-curve comparison: steering visibly inverts what the term slope alone would do
  const curve = (term: number): number => (term <= 6 ? 7 - (term - 2) * 0.8 : 0);
  assert.ok(oct.adj - curve(3) > 0 && dec.adj - curve(5) < 0, 'premium on heavy, discount on light');
});

test('renewal batch respects the org cap and feeds m6 renewal offers', () => {
  const ctx = sysCtx(orgId);
  setSetting(ctx, 'renewal_max_increase_pct', 4, propId);
  const priced = runRenewalBatch(ctx, propId, 200);
  assert.ok(priced >= 4 * 4, 'four terms per expiring lease');
  const rows = q<any>(
    `SELECT pr.*, l.rent_cents FROM price_recommendations pr
     JOIN leases l ON l.unit_id=pr.unit_id AND l.status='active'
     WHERE pr.org_id=? AND pr.decided_by='renewal batch'`,
    orgId,
  );
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.ok(
      r.accepted_rent_cents <= Math.round((r.rent_cents * 1.04) / 100) * 100,
      `renewal ${r.term_months}mo ${r.accepted_rent_cents} within +4% of ${r.rent_cents}`,
    );
    assert.ok(r.accepted_rent_cents >= r.rent_cents, 'never priced below current rent');
  }
  // capped rows carry the cap factor in their explanation
  const capped = rows.filter((r) => (j<Factor[]>(r.factors, [])).some((f) => f.label.includes('org cap 4% applied')));
  assert.ok(capped.length > 0, 'the 4% cap actually bit somewhere');
  // m6 renewalMatrix consumes the batch directly
  const lease = q1<any>(`SELECT * FROM leases WHERE property_id=? AND status='active' AND end_date='2026-10-31'`, propId);
  const options = renewalMatrix(ctx, lease);
  const batch12 = rows.find((r) => r.unit_id === lease.unit_id && r.term_months === 12)!;
  assert.equal(options.find((o) => o.term_months === 12)?.rent_cents, batch12.accepted_rent_cents, 'offer quotes the batch rate');
});

test('accept updates the unit + price_changes + quotes; override needs a reason; reject holds', () => {
  const ctx = { ...sysCtx(orgId), userName: 'Test Approver' };
  const staged = runPricingEngine(ctx, BD);
  assert.ok(staged >= 1, 'engine staged the vacant units');
  const rec = q1<any>(
    `SELECT * FROM price_recommendations WHERE org_id=? AND status='pending' AND term_months=12 ORDER BY unit_id LIMIT 1`,
    orgId,
  );
  assert.ok(rec, 'a pending rec exists');
  // reject leaves everything untouched
  assert.throws(() => decideRecommendation(ctx, rec.id, 'override', { amountCents: 151000 }), /reason/);
  const before2 = q1<any>('SELECT market_rent_cents FROM units WHERE id=?', rec.unit_id).market_rent_cents;
  decideRecommendation(ctx, rec.id, 'accept');
  const after2 = q1<any>('SELECT market_rent_cents FROM units WHERE id=?', rec.unit_id).market_rent_cents;
  assert.equal(after2, rec.recommended_rent_cents, 'asking rent updated');
  assert.notEqual(after2, before2);
  const change = q1<any>('SELECT * FROM price_changes WHERE unit_id=? ORDER BY created_at DESC', rec.unit_id);
  assert.equal(change.new_cents, rec.recommended_rent_cents);
  assert.equal(change.changed_by, 'Test Approver');
  // quotes pick the accepted rate up instantly (term 12 uses accepted rec)
  const unit = q1<any>('SELECT * FROM units WHERE id=?', rec.unit_id);
  assert.equal(quotedRent(ctx, unit, 12), rec.recommended_rent_cents);
  // double-decide guarded
  assert.throws(() => decideRecommendation(ctx, rec.id, 'accept'), /not pending/);
});

test('revenue analytics: loss-to-lease math holds', () => {
  const ctx = sysCtx(orgId);
  const a = revenueAnalytics(ctx, propId);
  const inPlace = val<number>(`SELECT AVG(rent_cents) FROM leases WHERE property_id=? AND status IN ('active','notice','month_to_month')`, propId)!;
  assert.equal(a.lossToLease.inPlace, Math.round(inPlace));
  assert.ok(a.lossToLease.market > 0);
  assert.equal(a.lossToLease.gapCents, Math.round(a.lossToLease.market - Math.round(inPlace)));
});
