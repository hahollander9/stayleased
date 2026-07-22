import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, insert, run } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { sysCtx } from '../src/lib/auth.ts';
import { unitStats, effectiveMarketRent } from '../src/modules/m2_portfolio/service.ts';

let orgId: string;
let propId: string;

before(() => {
  db();
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'Stats Org', slug: 'stats-org', business_date: '2026-07-26', created_at: nowIso() });
  propId = id('prp');
  insert('properties', {
    id: propId, org_id: orgId, name: 'Stats Prop', slug: 'stats-prop', type: 'multifamily',
    address1: 'x', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso(),
  });
  const mk = (status: string, n: number, rent = 100000): void => {
    for (let i = 0; i < n; i++) {
      insert('units', {
        id: id('unt'), org_id: orgId, property_id: propId, unit_number: `${status}-${i}`,
        floor: 1, sqft: 800, status, market_rent_cents: rent, amenities: '[]', created_at: nowIso(),
      });
    }
  };
  mk('occupied', 84);
  mk('notice', 6);
  mk('vacant_ready', 5);
  mk('vacant_not_ready', 3);
  mk('down', 1);
  mk('model', 1);
});

test('occupancy and exposure math', () => {
  const s = unitStats(sysCtx(orgId), propId);
  assert.equal(s.total, 100);
  assert.equal(s.rentable, 98); // minus down + model
  assert.equal(s.occupied, 90); // occupied + notice
  assert.equal(s.notice, 6);
  assert.equal(s.occupancyPct, 91.8); // 90/98
  assert.equal(s.exposureCount, 14); // 5 + 3 + 6 (no preleases yet)
  assert.equal(s.exposurePct, 14.3);
});

test('effective market rent = base + amenity premiums', () => {
  assert.equal(effectiveMarketRent(150000, [{ name: 'View', premium_cents: 5000 }, { name: 'Reno', premium_cents: 8500 }]), 163500);
  assert.equal(effectiveMarketRent(150000, []), 150000);
});
