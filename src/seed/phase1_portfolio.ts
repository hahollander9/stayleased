import { insert, run, q, q1, tx, js } from '../lib/db.ts';
import { id } from '../lib/ids.ts';
import { nowIso } from '../lib/dates.ts';
import type { SeedCtx } from './seed.ts';
import { log } from './seed.ts';

/** Phase 1 seed (§8): three properties with buildings, floorplans, units
 * (amenity premiums), rentable items, amenity spaces; property-scoped staff. */

export interface SeedProperty {
  id: string;
  name: string;
  slug: string;
  type: string;
}

export function seedPortfolio(s: SeedCtx): SeedProperty[] {
  const out: SeedProperty[] = [];

  const mkProperty = (row: Record<string, unknown>): string => {
    const pid = id('prp');
    insert('properties', { id: pid, org_id: s.orgId, created_at: nowIso(), ...row });
    return pid;
  };

  tx(() => {
    // ---------- Summit Ridge Apartments — Denver, garden-style ----------
    const sr = mkProperty({
      name: 'Summit Ridge Apartments', slug: 'summit-ridge', type: 'multifamily',
      address1: '4200 Larkspur Way', city: 'Denver', state: 'CO', zip: '80210',
      timezone: 'America/Denver', phone: '(303) 555-0142', email: 'hello@summitridgeliving.demo', year_built: 1998,
    });
    out.push({ id: sr, name: 'Summit Ridge Apartments', slug: 'summit-ridge', type: 'multifamily' });
    const srBldgs = ['A', 'B', 'C'].map((n) => {
      const bid = id('bld');
      insert('buildings', { id: bid, org_id: s.orgId, property_id: sr, name: `Building ${n}`, floors: 3, created_at: nowIso() });
      return bid;
    });
    const srPlans: [string, number, number, number, number, number][] = [
      // name, beds, baths, sqft, rent, count
      ['S1', 0, 1, 520, 119500, 24],
      ['A1', 1, 1, 710, 142500, 46],
      ['A2', 1, 1, 780, 149500, 30],
      ['B1', 2, 1, 950, 175000, 56],
      ['B2', 2, 2, 1080, 189500, 44],
      ['C1', 3, 2, 1280, 225000, 20],
    ];
    seedUnits(s, sr, srBldgs, srPlans, 'sr', [
      ['Renovated interior', 8500, 0.2],
      ['Mountain view', 5000, 0.15],
      ['Patio or balcony', 2000, 0.35],
      ['Corner unit', 3500, 0.12],
    ]);
    seedRentables(s, sr, [
      ['parking', 'Stall P-%N', 3500, 40],
      ['garage', 'Garage G-%N', 12500, 12],
      ['storage', 'Storage S-%N', 4000, 24],
    ]);
    seedSpaces(s, sr, [
      ['Clubhouse', 'Full kitchen, lounge and fireplace', 40, 15000, 6],
      ['Pool cabana', 'Poolside covered seating', 12, 0, 4],
      ['Fitness studio', 'Private studio room within the gym', 8, 0, 2],
    ]);

    // ---------- The Foundry Lofts — Austin, mid-rise ----------
    const fl = mkProperty({
      name: 'The Foundry Lofts', slug: 'foundry-lofts', type: 'multifamily',
      address1: '901 Ironwood Ave', city: 'Austin', state: 'TX', zip: '78702',
      timezone: 'America/Chicago', phone: '(512) 555-0177', email: 'leasing@foundrylofts.demo', year_built: 2019,
    });
    out.push({ id: fl, name: 'The Foundry Lofts', slug: 'foundry-lofts', type: 'multifamily' });
    const flB = id('bld');
    insert('buildings', { id: flB, org_id: s.orgId, property_id: fl, name: 'Main Tower', floors: 5, created_at: nowIso() });
    const flPlans: [string, number, number, number, number, number][] = [
      ['L-S', 0, 1, 560, 159500, 30],
      ['L-1', 1, 1, 730, 189500, 48],
      ['L-1D', 1, 1.5, 820, 209500, 24],
      ['L-2', 2, 2, 1090, 265000, 38],
      ['PH', 2, 2, 1250, 320000, 10],
    ];
    seedUnits(s, fl, [flB], flPlans, 'fl', [
      ['Skyline view', 10000, 0.2],
      ['Polished concrete + exposed brick', 4500, 0.3],
      ['Private terrace', 7500, 0.1],
    ]);
    seedRentables(s, fl, [
      ['garage', 'Garage Level %N', 8500, 60],
      ['storage', 'Storage B-%N', 5000, 20],
    ]);
    seedSpaces(s, fl, [
      ['Rooftop lounge', 'Downtown views, grills, firepits', 60, 20000, 5],
      ['Conference room', 'WFH meeting space', 10, 0, 3],
      ['Maker studio', 'Workbench + tools', 6, 2500, 4],
    ]);

    // ---------- Cardinal Commons — Columbus, student ----------
    const cc = mkProperty({
      name: 'Cardinal Commons', slug: 'cardinal-commons', type: 'student',
      address1: '77 Rowan St', city: 'Columbus', state: 'OH', zip: '43201',
      timezone: 'America/New_York', phone: '(614) 555-0119', email: 'live@cardinalcommons.demo', year_built: 2015,
    });
    out.push({ id: cc, name: 'Cardinal Commons', slug: 'cardinal-commons', type: 'student' });
    const ccBldgs = ['North', 'South'].map((n) => {
      const bid = id('bld');
      insert('buildings', { id: bid, org_id: s.orgId, property_id: cc, name: `${n} Hall`, floors: 3, created_at: nowIso() });
      return bid;
    });
    const ccPlans: [string, number, number, number, number, number][] = [
      ['4x4', 4, 4, 1400, 290000, 24], // by-the-bed pricing activates with M18
    ];
    seedUnits(s, cc, ccBldgs, ccPlans, 'cc', [
      ['Courtyard side', 2000, 0.3],
    ]);
    seedRentables(s, cc, [['parking', 'Permit Lot %N', 2500, 30]]);
    seedSpaces(s, cc, [['Study lounge', '24/7 access, whiteboards', 20, 0, 4]]);

    // ---------- property-scoped staff grants (§8) ----------
    const scope = (email: string, propertyIds: string[]): void => {
      const u = q1<{ id: string }>('SELECT id FROM users WHERE email=?', email);
      if (!u) return;
      run('UPDATE role_assignments SET scope_type=?, property_ids=? WHERE user_id=?', 'properties', js(propertyIds), u.id);
    };
    scope('manager@summitridge.demo', [sr, cc]);
    scope('manager2@summitridge.demo', [fl]);
    scope('assistant@summitridge.demo', [sr]);
    scope('agent@summitridge.demo', [sr]);
    scope('tech@summitridge.demo', [sr]);
  });

  const totals = q<{ n: number }>('SELECT COUNT(*) n FROM units WHERE org_id=?', s.orgId);
  log(`3 properties, ${totals[0]?.n} units, floorplans/amenities/rentables/spaces`);
  return out;
}

function seedUnits(
  s: SeedCtx,
  propertyId: string,
  buildingIds: string[],
  plans: [string, number, number, number, number, number][],
  prefix: string,
  amenityDefs: [string, number, number][], // [name, premium, probability]
): void {
  const rng = s.rng.fork(propertyId.length + prefix.charCodeAt(0));
  // create floorplans
  const fpIds: { fpId: string; name: string; beds: number; baths: number; sqft: number; rent: number; count: number }[] = [];
  for (const [name, beds, baths, sqft, rent, count] of plans) {
    const fpId = id('fpl');
    insert('floorplans', {
      id: fpId, org_id: s.orgId, property_id: propertyId, name, beds, baths, sqft,
      market_rent_cents: rent,
      description: `${beds === 0 ? 'Studio' : `${beds} bedroom`} · ${baths} bath · ${sqft} sqft`,
      created_at: nowIso(),
    });
    fpIds.push({ fpId, name, beds, baths, sqft, rent, count });
  }
  // interleave plans across buildings/floors for realistic numbering
  const queue: { fp: (typeof fpIds)[number] }[] = [];
  for (const fp of fpIds) for (let i = 0; i < fp.count; i++) queue.push({ fp });
  const shuffled = rng.shuffle(queue);
  const perBuilding = Math.ceil(shuffled.length / buildingIds.length);
  let idx = 0;
  buildingIds.forEach((bid, b) => {
    const letter = String.fromCharCode(65 + b); // A, B, C…
    const slice = shuffled.slice(idx, idx + perBuilding);
    idx += perBuilding;
    const bldg = q1<{ floors: number }>('SELECT floors FROM buildings WHERE id=?', bid);
    const floors = bldg?.floors || 3;
    slice.forEach((item, i) => {
      const floor = (i % floors) + 1;
      const numOnFloor = Math.floor(i / floors) + 1;
      const unitNumber = `${letter}-${floor}${String(numOnFloor).padStart(2, '0')}`;
      const amenities: { name: string; premium_cents: number }[] = [];
      for (const [name, premium, prob] of amenityDefs) {
        if (rng.chance(prob)) amenities.push({ name, premium_cents: premium });
      }
      if (floor === floors && rng.chance(0.6)) amenities.push({ name: 'Top floor', premium_cents: 2500 });
      const rent = item.fp.rent + amenities.reduce((sum, a) => sum + a.premium_cents, 0);
      insert('units', {
        id: id('unt'), org_id: s.orgId, property_id: propertyId, building_id: bid, floorplan_id: item.fp.fpId,
        unit_number: unitNumber, floor, sqft: item.fp.sqft, status: 'vacant_ready',
        market_rent_cents: rent, amenities: js(amenities), created_at: nowIso(),
      });
    });
  });
}

function seedRentables(s: SeedCtx, propertyId: string, defs: [string, string, number, number][]): void {
  for (const [kind, pattern, monthly, count] of defs) {
    for (let i = 1; i <= count; i++) {
      insert('rentable_items', {
        id: id('rti'), org_id: s.orgId, property_id: propertyId, kind,
        label: pattern.replace('%N', String(i).padStart(2, '0')), monthly_cents: monthly,
        status: 'available', created_at: nowIso(),
      });
    }
  }
}

function seedSpaces(s: SeedCtx, propertyId: string, defs: [string, string, number, number, number][]): void {
  for (const [name, description, capacity, fee, maxHours] of defs) {
    insert('amenity_spaces', {
      id: id('spc'), org_id: s.orgId, property_id: propertyId, name, description,
      bookable: 1, capacity, fee_cents: fee, max_hours: maxHours, created_at: nowIso(),
    });
  }
}
