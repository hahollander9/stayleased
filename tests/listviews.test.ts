import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q1, insert } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword, sysCtx } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { createCharge } from '../src/modules/m8_receivables/service.ts';
import { readiness, readinessItems } from '../src/modules/setup/readiness.ts';
import { startTestServer, loginAs, get } from './harness.ts';

/** How the lists show their data, and whether what they show adds up.
 *
 * A lease's balance belongs to the LEASE. Printed once per adult it appears
 * twice for a couple, and a reader who sums the column gets double the money
 * the portfolio is actually owed. Both facts have to survive: the balance is
 * visible beside each person (that is why people open the list) and it is
 * counted once (that is what makes the total true). */

const AS_OF = '2026-07-23';
let orgId: string;
let propertyId: string;
let coupleLease: string;
let soloLease: string;

before(() => {
  db();
  const existing = q1<{ id: string }>('SELECT id FROM orgs WHERE slug=?', 'lists-test');
  if (existing) {
    orgId = existing.id;
    propertyId = q1<{ id: string }>('SELECT id FROM properties WHERE org_id=?', orgId)!.id;
    coupleLease = q1<{ id: string }>(`SELECT id FROM leases WHERE org_id=? AND household_name LIKE 'Ramos%'`, orgId)!.id;
    soloLease = q1<{ id: string }>(`SELECT id FROM leases WHERE org_id=? AND household_name LIKE 'Okafor%'`, orgId)!.id;
    return;
  }
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'List Views Co', slug: 'lists-test', business_date: AS_OF, kind: 'live', created_at: nowIso() });
  const uid = id('usr');
  insert('users', {
    id: uid, org_id: orgId, email: 'admin@lists.test', name: 'List Admin',
    kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
  });
  insert('role_assignments', { id: id('ra'), org_id: orgId, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  ensureCoa(orgId);

  propertyId = id('prp');
  insert('properties', {
    id: propertyId, org_id: orgId, name: 'List Court', slug: 'list-court', type: 'multifamily',
    timezone: 'America/Denver', address1: '1 List Way', city: 'Denver', state: 'CO', zip: '80202',
    fiscal_year_start_month: 1, created_at: nowIso(),
  });
  const fpl = id('fpl');
  insert('floorplans', {
    id: fpl, org_id: orgId, property_id: propertyId, name: 'A1', beds: 2, baths: 1, sqft: 800,
    market_rent_cents: 150000, created_at: nowIso(),
  });

  // two households: one couple (two adults on ONE lease) and one solo resident
  const mk = (unitNo: string, household: string, people: [string, string, string][]): string => {
    const unit = id('unt');
    insert('units', {
      id: unit, org_id: orgId, property_id: propertyId, building_id: null, floorplan_id: fpl,
      unit_number: unitNo, floor: 1, sqft: 800, status: 'occupied', market_rent_cents: 150000,
      amenities: '[]', notes: null, created_at: nowIso(),
    });
    const lease = id('lse');
    insert('leases', {
      id: lease, org_id: orgId, property_id: propertyId, unit_id: unit, household_name: household,
      status: 'active', start_date: '2026-01-01', end_date: '2026-12-31', rent_cents: 150000,
      deposit_cents: 150000, created_at: nowIso(),
    });
    for (const [first, last, role] of people) {
      const rid = id('res');
      insert('residents', {
        id: rid, org_id: orgId, property_id: propertyId, first_name: first, last_name: last,
        email: `${first.toLowerCase()}@lists.test`, phone: '555-0100', created_at: nowIso(),
      });
      insert('household_members', { id: id('hhm'), org_id: orgId, lease_id: lease, resident_id: rid, role, created_at: nowIso() });
    }
    return lease;
  };
  coupleLease = mk('201', 'Ramos household', [['Ana', 'Ramos', 'primary'], ['Beto', 'Ramos', 'co']]);
  soloLease = mk('202', 'Okafor household', [['Chi', 'Okafor', 'primary']]);

  // one unpaid charge on each household: $900 and $400
  const ctx = sysCtx(orgId, AS_OF);
  createCharge(ctx, { leaseId: coupleLease, kind: 'rent', label: 'Rent', amountCents: 90000, date: AS_OF, dueDate: AS_OF });
  createCharge(ctx, { leaseId: soloLease, kind: 'rent', label: 'Rent', amountCents: 40000, date: AS_OF, dueDate: AS_OF });
});

test('the residents list totals households once, not once per adult', async () => {
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@lists.test');
    const people = await get(base, '/residents', cookie);
    assert.equal(people.status, 200);

    // three adults, two households — and $1,300.00 owed, NOT $2,200.00
    assert.match(people.text, /3 adults across 2 households/);
    assert.match(people.text, /\$1,300\.00 owed by 2 households/);
    assert.doesNotMatch(people.text, /\$2,200\.00/, 'the couple’s balance must not be counted twice');

    // the money is still visible beside each person, and named as the
    // household's so nobody reads it as an individual debt
    assert.match(people.text, /Household balance/);
    assert.match(people.text, /counted once in the total/);
    // and roles read as words a person would say
    assert.match(people.text, /Co-resident/);
    assert.doesNotMatch(people.text, />co</, 'raw enum values never reach the table');
  } finally { close(); }
});

test('the households view is one row per lease with a total that equals its column', async () => {
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@lists.test');
    const hh = await get(base, '/residents?view=households', cookie);
    assert.equal(hh.status, 200);
    assert.match(hh.text, /Ramos household/);
    assert.match(hh.text, /Ana Ramos, Beto Ramos/, 'the household names who is on it');
    assert.match(hh.text, /Total — all households/);
    assert.match(hh.text, /\$1,300\.00/);
    assert.doesNotMatch(hh.text, /\$2,200\.00/);
  } finally { close(); }
});

test('row height is a preference: chosen in the URL, remembered by cookie, applied to the table', async () => {
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@lists.test');
    const roomy = await get(base, '/residents', cookie);
    assert.doesNotMatch(roomy.text, /class="tbl tight"/);

    const tight = await fetch(`${base}/residents?density=tight`, { headers: { cookie }, redirect: 'manual' });
    const tightHtml = await tight.text();
    assert.match(tightHtml, /class="tbl tight"/, 'the table is packed');
    const setCookie = tight.headers.get('set-cookie') || '';
    assert.match(setCookie, /sl_density=tight/, 'and the choice follows the operator to the next list');

    // …which the next request honours with no query string at all
    const remembered = await get(base, '/residents', `${cookie}; sl_density=tight`);
    assert.match(remembered.text, /class="tbl tight"/);
  } finally { close(); }
});

test('the delinquency workbench speaks English, not scorer', async () => {
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@lists.test');
    const page = await get(base, '/delinquency', cookie);
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.text, /scoring: shadow/, 'no internal mode reporting in the product');
    assert.doesNotMatch(page.text, /chips inform/);
    assert.doesNotMatch(page.text, /behavior unchanged/);
    assert.match(page.text, /Totals — all households/, 'the footer says what it covers');
    assert.match(page.text, /By property/, 'and the list can be rolled up');
  } finally { close(); }
});

test('readiness reports what is on file and what would be gained by adding the rest', () => {
  const ctx = sysCtx(orgId, AS_OF);
  const items = readinessItems(ctx);
  const by = new Map(items.map((i) => [i.key, i]));

  assert.equal(by.get('portfolio')!.state, 'done', 'two units are on file');
  assert.equal(by.get('leases')!.state, 'done', 'both units are leased');
  assert.equal(by.get('contacts')!.state, 'done', 'everyone has an email');
  assert.equal(by.get('vendors')!.state, 'missing', 'no vendors have been added');
  assert.equal(by.get('documents')!.state, 'missing', 'no lease PDFs are attached');

  // every item explains itself in terms of what the operator gets
  for (const i of items) {
    assert.ok(i.unlocks.length > 20, `${i.key} says what it turns on`);
    assert.ok(i.links.length >= 1, `${i.key} offers a way to do it`);
    assert.doesNotMatch(i.title + i.status + i.unlocks, /shadow|scorer|enum|M19|schema/i, `${i.key} avoids developer language`);
  }

  const sum = readiness(ctx);
  assert.equal(sum.total, items.length);
  assert.equal(sum.done, items.filter((i) => i.state === 'done').length);
  assert.ok(sum.next.length > 0 && sum.next.length <= 3, 'a short, ranked list of what to do next');
  assert.equal(sum.operable, true, 'doors, leases and contacts are all present');
});

test('the setup hub leads with what the company still needs', async () => {
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@lists.test');
    const setup = await get(base, '/setup', cookie);
    assert.equal(setup.status, 200);
    assert.match(setup.text, /Your setup/);
    assert.match(setup.text, /Turns on/i, 'each line says what it unlocks');
    assert.match(setup.text, /Bring your portfolio in/, 'and the links are grouped by intent');
    assert.match(setup.text, /Run the company/);

    const hub = await get(base, '/setup/import', cookie);
    assert.match(hub.text, /What is still missing/, 'the Migration Center asks the same question');
  } finally { close(); }
});
