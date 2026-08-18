import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, insert } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword } from '../src/lib/auth.ts';
import { startTestServer, loginAs, get } from './harness.ts';

/** Residents table parity (import-integrity Task 5): server-side sort
 * (?sort=&dir=), rows-per-page (?per=), and a CSV export that mirrors the
 * table — same scope, same search filter, same sort, ALL pages. */

let base: string;
let close: () => void;
let cookie: string;
let orgId: string;

// crafted rows (searchable via q=Zortcase); name → resident id
const R: Record<string, string> = {};

function seedOrgAdmin(slug: string): { orgId: string; email: string } {
  const oid = id('org');
  insert('orgs', { id: oid, name: `Res Tbl ${slug}`, slug: `rtb-${slug}-${oid.slice(-6)}`, business_date: '2026-07-26', created_at: nowIso() });
  const uid = id('usr');
  const email = `admin@rtb-${slug}.test`;
  insert('users', {
    id: uid, org_id: oid, email, name: `Admin ${slug}`,
    kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
  });
  insert('role_assignments', { id: id('ra'), org_id: oid, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  return { orgId: oid, email };
}

function seedProperty(oid: string, name: string): string {
  const pid = id('prp');
  insert('properties', {
    id: pid, org_id: oid, name, slug: `${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}-${pid.slice(-6)}`, type: 'multifamily',
    address1: '1 Table St', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso(),
  });
  return pid;
}

/** one occupied unit + active lease + one primary adult; balanceCents lands as
 * an active rent charge, which is exactly what leaseBalance() sums */
function seedHousehold(oid: string, propId: string, unitNumber: string, first: string, last: string, balanceCents: number): string {
  const unitId = id('unt');
  insert('units', {
    id: unitId, org_id: oid, property_id: propId, unit_number: unitNumber, floor: 1, sqft: 700,
    status: 'occupied', market_rent_cents: 120000, amenities: '[]', created_at: nowIso(),
  });
  const leaseId = id('lse');
  insert('leases', {
    id: leaseId, org_id: oid, property_id: propId, unit_id: unitId, household_name: `${first} household`,
    status: 'active', start_date: '2026-01-01', end_date: '2026-12-31', move_in_date: '2026-01-01',
    rent_cents: 120000, deposit_cents: 0, term_months: 12, created_at: nowIso(),
  });
  const rid = id('res');
  insert('residents', {
    id: rid, org_id: oid, property_id: propId, user_id: null,
    first_name: first, last_name: last, email: null, phone: null, kind: 'adult',
    employer: null, monthly_income_cents: null, ssn_last4: null, created_at: nowIso(),
  });
  insert('household_members', { id: id('hm'), org_id: oid, lease_id: leaseId, resident_id: rid, role: 'primary', created_at: nowIso() });
  if (balanceCents) {
    insert('charges', {
      id: id('chg'), org_id: oid, property_id: propId, lease_id: leaseId, kind: 'rent', label: 'Rent',
      amount_cents: balanceCents, date: '2026-07-01', due_date: '2026-07-01', month_key: null,
      lease_charge_id: null, source: 'oneoff', status: 'active', je_id: null, created_at: nowIso(),
    });
  }
  return rid;
}

/** table rows appear as tr data-href="/residents/<id>" in render order */
function rowIds(htmlText: string): string[] {
  return [...htmlText.matchAll(/data-href="\/residents\/([^"]+)"/g)].map((m) => m[1]!);
}

before(async () => {
  db();
  const a = seedOrgAdmin('a');
  orgId = a.orgId;
  const propA = seedProperty(orgId, 'Sort Pines');

  // units chosen so natural order (77 < 90 < 201 < 1002) differs from
  // lexicographic (1002 < 201 < 77 < 90); balances (0, 5, 40, 300 dollars)
  // so numeric order differs from any string order of the amounts
  R.amy = seedHousehold(orgId, propA, '90', 'Amy', 'Zortcase', 500);        //   $5.00
  R.bea = seedHousehold(orgId, propA, '201', 'Bea', 'Zortcase', 30000);     // $300.00
  R.cal = seedHousehold(orgId, propA, '1002', 'Cal', 'Zortcase', 4000);     //  $40.00
  R.dee = seedHousehold(orgId, propA, '77', 'Dee', 'Zortcase, Jr.', 0);     //   $0.00 — comma name for CSV escaping

  // filler rows (second property) so the org holds 61 residents total —
  // enough to exercise per=25/50/all page sizing
  const propB = seedProperty(orgId, 'Bulk Arms');
  for (let i = 1; i <= 57; i++) {
    seedHousehold(orgId, propB, `B-${String(i).padStart(2, '0')}`, 'Fill', `Filler${String(i).padStart(2, '0')}`, 100 * i);
  }

  // a second org whose resident also matches q=Zortcase — must never leak
  const b = seedOrgAdmin('b');
  seedHousehold(b.orgId, seedProperty(b.orgId, 'Foreign Court'), 'X-1', 'Foreign', 'Zortcase', 99900);

  const srv = await startTestServer();
  base = srv.base;
  close = srv.close;
  cookie = await loginAs(base, a.email);
});

after(() => close());

test('sort=balance orders numerically, both directions, with aria-sort on the header', async () => {
  const asc = await get(base, '/residents?q=Zortcase&sort=balance&dir=asc', cookie);
  assert.equal(asc.status, 200);
  assert.deepEqual(rowIds(asc.text), [R.dee, R.amy, R.cal, R.bea], 'ascending by amount, not by string');
  assert.match(asc.text, /aria-sort="ascending"/);

  const desc = await get(base, '/residents?q=Zortcase&sort=balance&dir=desc', cookie);
  assert.deepEqual(rowIds(desc.text), [R.bea, R.cal, R.amy, R.dee]);
  assert.match(desc.text, /aria-sort="descending"/);
});

test('sort=unit is natural: 77 < 90 < 201 < 1002', async () => {
  const r = await get(base, '/residents?q=Zortcase&sort=unit&dir=asc', cookie);
  assert.equal(r.status, 200);
  assert.deepEqual(rowIds(r.text), [R.dee, R.amy, R.bea, R.cal]);
});

test('per= changes the page size; per=all returns everything', async () => {
  assert.equal(rowIds((await get(base, '/residents', cookie)).text).length, 50, 'default page size unchanged');
  assert.equal(rowIds((await get(base, '/residents?per=25', cookie)).text).length, 25);
  const p50 = await get(base, '/residents?per=50', cookie);
  assert.equal(rowIds(p50.text).length, 50);
  assert.equal(rowIds((await get(base, '/residents?per=50&page=2', cookie)).text).length, 11, 'pagination still works with per=');
  assert.equal(rowIds((await get(base, '/residents?per=all', cookie)).text).length, 61);
});

test('/residents.csv respects filter + sort: header row, right count/order, quoted commas, org-scoped', async () => {
  const resp = await fetch(`${base}/residents.csv?q=Zortcase&sort=balance&dir=desc`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(resp.status, 200);
  assert.match(resp.headers.get('content-type') || '', /text\/csv/);
  assert.match(resp.headers.get('content-disposition') || '', /attachment/);
  const body = await resp.text();
  const lines = body.split(/\r?\n/).filter((l) => l !== '');
  // The export carries the same labels the table does, and says which rows
  // count: a household's balance repeats for roommates, so a spreadsheet total
  // over the raw column would double it (2026-08-18).
  assert.equal(lines[0], 'Resident,Unit,Property,On the lease,Lease status,Household balance,Counts once', 'header row');
  assert.equal(lines.length, 1 + 4, 'filtered rows only — all pages, not 61, not the other org');
  assert.equal(lines[1], 'Bea Zortcase,201,Sort Pines,Primary,active,300.00,yes', 'sorted desc, money as plain 2-decimal number');
  // summing only the rows flagged 'yes' gives each household exactly once
  const counted = lines.slice(1).filter((l) => l.endsWith(',yes'));
  assert.equal(counted.length, new Set(lines.slice(1).map((l) => l.split(',').slice(-6, -4).join('|'))).size,
    'one counted row per unit/property — i.e. per household');
  assert.ok(body.includes('"Dee Zortcase, Jr."'), 'comma-bearing name is quoted');
  assert.ok(!body.includes('Foreign'), 'other org never leaks into the export');
});

test('/residents.csv requires login (same perm as the page)', async () => {
  const anon = await fetch(`${base}/residents.csv`, { redirect: 'manual' });
  assert.equal(anon.status, 303);
  assert.match(anon.headers.get('location') || '', /^\/login/);
});
