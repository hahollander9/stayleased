import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q1, insert, run } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword, sysCtx } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { hasRealAddress, parseUsAddress, formatAddress, ADDRESS_PENDING } from '../src/lib/address.ts';
import { readinessItems } from '../src/modules/setup/readiness.ts';
import { startTestServer, loginAs, get, post } from './harness.ts';

/** Where a building actually is.
 *
 * A rent roll names buildings and almost never carries their street address,
 * so an imported property holds a placeholder. Three things follow: the
 * placeholder must never be published, the gap must be visible where the
 * operator looks for gaps, and a document that DOES state the address must be
 * able to close it. */

const AS_OF = '2026-07-23';
let orgId: string;
let pendingProp: string;
let realProp: string;

before(() => {
  db();
  const existing = q1<{ id: string }>('SELECT id FROM orgs WHERE slug=?', 'addr-test');
  if (existing) {
    orgId = existing.id;
    pendingProp = q1<{ id: string }>('SELECT id FROM properties WHERE org_id=? AND name=?', orgId, 'Pending Place')!.id;
    realProp = q1<{ id: string }>('SELECT id FROM properties WHERE org_id=? AND name=?', orgId, 'Known Court')!.id;
    return;
  }
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'Address Co', slug: 'addr-test', business_date: AS_OF, kind: 'live', created_at: nowIso() });
  const uid = id('usr');
  insert('users', {
    id: uid, org_id: orgId, email: 'admin@addr.test', name: 'Addr Admin',
    kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
  });
  insert('role_assignments', { id: id('ra'), org_id: orgId, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  ensureCoa(orgId);

  // exactly what applyRentRoll creates for a property the file only named
  pendingProp = id('prp');
  insert('properties', {
    id: pendingProp, org_id: orgId, name: 'Pending Place', slug: 'pending-place', type: 'multifamily',
    timezone: 'America/Denver', address1: ADDRESS_PENDING, city: '—', state: '--', zip: '00000',
    fiscal_year_start_month: 1, created_at: nowIso(),
  });
  realProp = id('prp');
  insert('properties', {
    id: realProp, org_id: orgId, name: 'Known Court', slug: 'known-court', type: 'multifamily',
    timezone: 'America/Denver', address1: '900 Larimer St', city: 'Denver', state: 'CO', zip: '80202',
    fiscal_year_start_month: 1, created_at: nowIso(),
  });
});

test('the import placeholder is not an address, and a real one is', () => {
  assert.equal(hasRealAddress({ address1: ADDRESS_PENDING, city: '—', state: '--', zip: '00000' }), false);
  assert.equal(hasRealAddress({ address1: '900 Larimer St', city: 'Denver', state: 'CO', zip: '80202' }), true);
  // a half-filled address is not mappable either
  assert.equal(hasRealAddress({ address1: '900 Larimer St', city: '', state: 'CO', zip: '80202' }), false);
  assert.equal(formatAddress({ address1: '900 Larimer St', city: 'Denver', state: 'co', zip: '80202' }), '900 Larimer St, Denver, CO 80202');
  assert.equal(formatAddress({ address1: ADDRESS_PENDING, city: '—', state: '--', zip: '00000' }), null);
});

test('an address is parsed only when the whole shape is there — never guessed', () => {
  assert.deepEqual(parseUsAddress('1200 Wynkoop Street, Denver, CO 80202'),
    { address1: '1200 Wynkoop Street', city: 'Denver', state: 'CO', zip: '80202' });
  assert.deepEqual(parseUsAddress('  1200 Wynkoop St., Colorado Springs, co 80903-1234  '),
    { address1: '1200 Wynkoop St.', city: 'Colorado Springs', state: 'CO', zip: '80903' },
    'the street line is kept as written — parsing refuses, it never rewrites');
  // refusals: no street number, no state, no zip, prose
  assert.equal(parseUsAddress('Wynkoop Street, Denver, CO 80202'), null, 'a street line has a number');
  assert.equal(parseUsAddress('1200 Wynkoop Street, Denver 80202'), null);
  assert.equal(parseUsAddress('1200 Wynkoop Street, Denver, CO'), null);
  assert.equal(parseUsAddress('the premises located in Denver'), null);
  assert.equal(parseUsAddress(''), null);
});

test('the public community page publishes no address rather than the placeholder', async () => {
  const { base, close } = await startTestServer();
  try {
    // publish both community sites (marketing is a JSON column on the property)
    for (const pid of [pendingProp, realProp]) {
      run('UPDATE properties SET marketing=? WHERE id=?', JSON.stringify({ published: true }), pid);
    }
    const pending = await get(base, '/p/pending-place');
    assert.equal(pending.status, 200);
    assert.doesNotMatch(pending.text, /address pending/i, 'the placeholder never reaches the open web');
    assert.doesNotMatch(pending.text, /00000/);
    assert.doesNotMatch(pending.text, /PostalAddress/, 'and the schema does not claim one either');

    const known = await get(base, '/p/known-court');
    assert.match(known.text, /900 Larimer St/, 'a real address is shown');
    assert.match(known.text, /PostalAddress/, 'and published as schema');
  } finally { close(); }
});

test('the setup hub reports which properties still need an address', () => {
  const ctx = sysCtx(orgId, AS_OF);
  const addresses = readinessItems(ctx).find((i) => i.key === 'addresses')!;
  assert.equal(addresses.state, 'partial', 'one of two is addressed');
  assert.match(addresses.status, /1 of 2 have no street address/);
  assert.match(addresses.status, /Pending Place/, 'naming the building that needs it');
  assert.match(addresses.unlocks, /public/i);
  assert.match(addresses.links[0]![0], new RegExp(`/properties/${pendingProp}/edit`), 'and links straight to the fix');
});

test('a lease document supplies the address the hub says is missing', async () => {
  const batchId = id('imp');
  insert('import_batches', {
    id: batchId, org_id: orgId, kind: 'lease_pdf', filename: '2 lease PDFs',
    property_id: pendingProp, new_property_name: null, preset: null,
    headers: '[]', mapping: '{}', rows: '[]',
    staged: JSON.stringify([
      { filename: 'unit-1.pdf', fileId: null, include: true, fields: { unit: '1' }, confidence: {}, notes: [], source: 'ai',
        propertyAddress: '1200 Wynkoop Street, Denver, CO 80202' },
      { filename: 'unit-2.pdf', fileId: null, include: true, fields: { unit: '2' }, confidence: {}, notes: [], source: 'ai',
        propertyAddress: '1200 Wynkoop Street, Denver, CO 80202' },
    ]),
    as_of: AS_OF, status: 'staged', summary: null, created_by: 'test', created_at: nowIso(), applied_at: null,
    source_file_id: null,
  });

  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@addr.test');
    const review = await get(base, `/setup/import/leases/${batchId}`, cookie);
    assert.equal(review.status, 200);
    assert.match(review.text, /The address for this property/, 'the read is offered, not applied');
    assert.match(review.text, /1200 Wynkoop Street, Denver, CO 80202/);
    assert.match(review.text, /2 of these documents state/, 'and says how many documents agree');

    const accepted = await post(base, `/setup/import/leases/${batchId}/address`,
      { address: '1200 Wynkoop Street, Denver, CO 80202' }, cookie);
    assert.equal(accepted.status, 303);

    const p = q1<any>('SELECT * FROM properties WHERE id=?', pendingProp);
    assert.equal(p.address1, '1200 Wynkoop Street');
    assert.equal(p.city, 'Denver');
    assert.equal(p.state, 'CO');
    assert.equal(p.zip, '80202');
    assert.equal(hasRealAddress(p), true);

    // it is on the trail, with what it replaced
    const audited = q1<{ changes: string }>(
      `SELECT changes FROM audit_events WHERE entity='property' AND entity_id=? AND action='address_from_document'`, pendingProp);
    assert.ok(audited, 'accepting a document-read address is audited');

    // and a second attempt never silently overwrites what is now on file
    const again = await post(base, `/setup/import/leases/${batchId}/address`,
      { address: '999 Elsewhere Ave, Boulder, CO 80301' }, cookie);
    assert.equal(again.status, 303);
    assert.equal(q1<any>('SELECT address1 FROM properties WHERE id=?', pendingProp).address1, '1200 Wynkoop Street');

    // the offer is gone now that the gap is closed
    const after = await get(base, `/setup/import/leases/${batchId}`, cookie);
    assert.doesNotMatch(after.text, /The address for this property/);
  } finally {
    close();
    run('DELETE FROM import_batches WHERE id=?', batchId);
    run('UPDATE properties SET address1=?, city=?, state=?, zip=? WHERE id=?', ADDRESS_PENDING, '—', '--', '00000', pendingProp);
  }
});

test('an unreadable address is refused rather than half-written', async () => {
  const batchId = id('imp');
  insert('import_batches', {
    id: batchId, org_id: orgId, kind: 'lease_pdf', filename: 'one.pdf',
    property_id: pendingProp, new_property_name: null, preset: null,
    headers: '[]', mapping: '{}', rows: '[]', staged: '[]',
    as_of: AS_OF, status: 'staged', summary: null, created_by: 'test', created_at: nowIso(), applied_at: null,
    source_file_id: null,
  });
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@addr.test');
    const bad = await post(base, `/setup/import/leases/${batchId}/address`, { address: 'somewhere in Denver' }, cookie);
    assert.equal(bad.status, 303);
    assert.equal(q1<any>('SELECT address1 FROM properties WHERE id=?', pendingProp).address1, ADDRESS_PENDING);
  } finally {
    close();
    run('DELETE FROM import_batches WHERE id=?', batchId);
  }
});
