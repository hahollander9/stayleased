import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert, val, j } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword, sysCtx } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { trialBalance, postJE } from '../src/modules/m9_accounting/service.ts';
import { autoMap } from '../src/modules/setup/mapping.ts';
import { applyRentRoll, type BatchRow } from '../src/modules/setup/import_apply.ts';
import { deleteProperty } from '../src/modules/m2_portfolio/service.ts';
import { startTestServer, loginAs, get, post } from './harness.ts';

/** Books-safe property delete (import recovery): full cascade incl. journal
 * entries + lines (trial balance returns to its pre-import state), orphan-only
 * resident/portal-user removal, typed-name confirm on the route, payments/
 * manual-JE safety rail with force override, and the audit trail. */

const AS_OF = '2026-07-23';

let orgId: string;

before(() => {
  db();
  const existing = q1<{ id: string }>('SELECT id FROM orgs WHERE slug=?', 'propdel-test');
  if (existing) {
    orgId = existing.id;
    return;
  }
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'Property Delete Co', slug: 'propdel-test', business_date: AS_OF, kind: 'live', created_at: nowIso() });
  const uid = id('usr');
  insert('users', {
    id: uid, org_id: orgId, email: 'admin@propdel.test', name: 'Del Admin',
    kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
  });
  insert('role_assignments', { id: id('ra'), org_id: orgId, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  ensureCoa(orgId);
});

function mkBatch(over: Partial<BatchRow>): BatchRow {
  const b: BatchRow = {
    id: id('imp'), org_id: orgId, kind: 'rent_roll', filename: 'test.xlsx',
    property_id: null, new_property_name: null, preset: null,
    headers: '[]', mapping: '{}', rows: '[]', staged: '[]',
    as_of: AS_OF, status: 'staged', created_by: 'test',
    ...over,
  } as BatchRow;
  insert('import_batches', { ...b, summary: null, created_at: nowIso(), applied_at: null } as unknown as Record<string, unknown>);
  return b;
}

/** Import a new property the way the Migration Center does — units, leases,
 * residents with portal invites, opening balances, and deposit JEs. */
function importProperty(name: string, rows: string[][]): string {
  const headers = ['Unit', 'Tenant', 'Email', 'Rent', 'Deposit', 'Balance', 'Lease From', 'Lease To'];
  const batch = mkBatch({
    new_property_name: name,
    headers: JSON.stringify(headers), mapping: JSON.stringify(autoMap(headers, 'rent_roll')), rows: JSON.stringify(rows),
  });
  applyRentRoll(sysCtx(orgId, AS_OF), batch);
  return q1<{ id: string }>('SELECT id FROM properties WHERE org_id=? AND name=? ORDER BY created_at DESC LIMIT 1', orgId, name)!.id;
}

const countFor = (sql: string, ...params: unknown[]): number => val<number>(sql, ...params) || 0;

let deletedPid = ''; // shared with the audit-event test below
let deletedCounts: Record<string, number> = {};

test('delete removes everything incl. JEs and lines; trial balance returns to its pre-import state', () => {
  const ctx = sysCtx(orgId, AS_OF);
  // a keeper property gives the org real books that must survive untouched
  importProperty('Keeper Court', [
    ['K1', 'Kay Keeper', 'kay@propdel.test', '1300', '1300', '120.00', '2026-01-01', '2026-12-31'],
  ]);
  const tbBefore = {
    accrual: trialBalance(ctx, { basis: 'accrual' }),
    cash: trialBalance(ctx, { basis: 'cash' }),
  };
  assert.ok(tbBefore.accrual.length > 0, 'keeper books exist before the doomed import');

  const pid = importProperty('Doomed Manor', [
    ['101', 'Dana Doomed', 'dana@propdel.test', '1500', '1500', '250.00', '2026-01-01', '2026-12-31'],
    ['102', 'Omar Only', 'omar@propdel.test', '1400', '1400', '(50.00)', '2026-02-01', '2027-01-31'],
  ]);
  // the import posted real books for this property: deposits (both bases) + opening balance charges
  assert.ok(countFor('SELECT COUNT(*) FROM journal_entries WHERE org_id=? AND property_id=?', orgId, pid) >= 3);
  assert.equal(countFor('SELECT COUNT(*) FROM units WHERE property_id=?', pid), 2);
  assert.equal(countFor(`SELECT COUNT(*) FROM users u JOIN residents r ON r.user_id=u.id WHERE r.property_id=?`, pid), 2, 'portal users provisioned by the import');

  const { counts } = deleteProperty(ctx, pid);
  deletedPid = pid;
  deletedCounts = counts;

  // property and everything under it is gone
  assert.equal(q1('SELECT id FROM properties WHERE id=?', pid), undefined);
  for (const [table, col] of [
    ['units', 'property_id'], ['floorplans', 'property_id'], ['leases', 'property_id'],
    ['charges', 'property_id'], ['journal_entries', 'property_id'], ['journal_lines', 'property_id'],
    ['bank_accounts', 'property_id'], ['outbox_messages', 'property_id'],
  ] as [string, string][]) {
    assert.equal(countFor(`SELECT COUNT(*) FROM ${table} WHERE ${col}=?`, pid), 0, `${table} fully cleared`);
  }
  assert.equal(countFor('SELECT COUNT(*) FROM residents WHERE property_id=?', pid), 0);
  assert.equal(
    countFor(`SELECT COUNT(*) FROM household_members hm WHERE hm.lease_id NOT IN (SELECT id FROM leases)`), 0,
    'no orphaned household_members anywhere',
  );

  // counts reflect what was removed
  assert.equal(counts.properties, 1);
  assert.equal(counts.units, 2);
  assert.equal(counts.leases, 2);
  assert.equal(counts.residents, 2);
  assert.equal(counts.users, 2, 'both portal logins removed');
  assert.ok((counts.journal_entries || 0) >= 3, 'deposit + opening-balance JEs deleted');
  assert.ok((counts.journal_lines || 0) >= (counts.journal_entries || 0) * 2 - 1, 'every deleted JE took its lines');

  // the books are exactly what they were before the doomed property existed
  assert.deepEqual(trialBalance(ctx, { basis: 'accrual' }), tbBefore.accrual, 'accrual trial balance unchanged');
  assert.deepEqual(trialBalance(ctx, { basis: 'cash' }), tbBefore.cash, 'cash trial balance unchanged');
});

test('resident on another property survives with portal account; orphan resident and login are removed', () => {
  const ctx = sysCtx(orgId, AS_OF);
  const pidA = importProperty('Shared Alpha', [
    ['A1', 'Solo Person', 'solo@propdel.test', '1200', '1200', '', '2026-01-01', '2026-12-31'],
    ['A2', 'Shared Sam', 'shared@propdel.test', '1250', '1250', '', '2026-01-01', '2026-12-31'],
  ]);
  const shared = q1<any>(`SELECT * FROM residents WHERE property_id=? AND first_name='Shared'`, pidA)!;
  const solo = q1<any>(`SELECT * FROM residents WHERE property_id=? AND first_name='Solo'`, pidA)!;
  assert.ok(shared.user_id && solo.user_id, 'both residents got portal logins on import');

  // Shared Sam also holds a lease at a second property
  const pidB = id('prp');
  insert('properties', {
    id: pidB, org_id: orgId, name: 'Shared Beta', slug: `shared-beta-${pidB.slice(-6)}`, type: 'multifamily',
    address1: '2 Beta St', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso(),
  });
  const unitB = id('unt');
  insert('units', {
    id: unitB, org_id: orgId, property_id: pidB, unit_number: 'B1', floor: 1, sqft: 800,
    status: 'occupied', market_rent_cents: 140000, amenities: '[]', created_at: nowIso(),
  });
  const leaseB = id('lse');
  insert('leases', {
    id: leaseB, org_id: orgId, property_id: pidB, unit_id: unitB, household_name: 'Shared Sam',
    status: 'active', start_date: '2026-03-01', end_date: '2027-02-28', move_in_date: '2026-03-01',
    rent_cents: 140000, deposit_cents: 0, term_months: 12, created_at: nowIso(),
  });
  insert('household_members', { id: id('hm'), org_id: orgId, lease_id: leaseB, resident_id: shared.id, role: 'co', created_at: nowIso() });

  deleteProperty(ctx, pidA);

  // orphan is fully gone — resident row and portal login
  assert.equal(q1('SELECT id FROM residents WHERE id=?', solo.id), undefined, 'solo resident deleted');
  assert.equal(q1('SELECT id FROM users WHERE id=?', solo.user_id), undefined, 'solo portal login deleted');

  // the shared resident survives, keeps the login, and is re-homed to the surviving property
  const sharedAfter = q1<any>('SELECT * FROM residents WHERE id=?', shared.id)!;
  assert.ok(sharedAfter, 'shared resident survives');
  assert.equal(sharedAfter.property_id, pidB, 'shared resident re-homed to the property they still live at');
  assert.equal(sharedAfter.user_id, shared.user_id);
  assert.ok(q1('SELECT id FROM users WHERE id=?', shared.user_id), 'shared portal login survives');
  assert.ok(q1('SELECT id FROM household_members WHERE lease_id=? AND resident_id=?', leaseB, shared.id), 'other household intact');
});

test('route: typed-name mismatch refuses; exact name deletes; Migration Center shows the start-over link', async () => {
  const pid = importProperty('Typed Confirm Court', [
    ['T1', 'Tess Typed', 'tess@propdel.test', '1100', '1100', '', '2026-01-01', '2026-12-31'],
  ]);
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@propdel.test');

    // the edit page carries the Danger zone with the typed-name form
    const edit = await get(base, `/properties/${pid}/edit`, cookie);
    assert.equal(edit.status, 200);
    assert.match(edit.text, /Danger zone/);
    assert.match(edit.text, new RegExp(`/properties/${pid}/delete`));
    assert.match(edit.text, /confirm_name/);

    // Migration Center: muted start-over line once the org has properties
    const hub = await get(base, '/setup/import', cookie);
    assert.equal(hub.status, 200);
    assert.match(hub.text, /Imported into the wrong place\?/);
    assert.match(hub.text, /Remove the property and start over/);
    assert.match(hub.text, /href="\/properties"/);

    // wrong name → refused, nothing deleted
    const bad = await post(base, `/properties/${pid}/delete`, { confirm_name: 'Wrong Name Court' }, cookie);
    assert.equal(bad.status, 303);
    assert.equal(bad.location, `/properties/${pid}/edit`);
    assert.ok(q1('SELECT id FROM properties WHERE id=?', pid), 'property survives a mismatch');

    // exact name → deleted, redirected to the properties list
    const ok = await post(base, `/properties/${pid}/delete`, { confirm_name: 'Typed Confirm Court' }, cookie);
    assert.equal(ok.status, 303);
    assert.equal(ok.location, '/properties');
    assert.equal(q1('SELECT id FROM properties WHERE id=?', pid), undefined, 'property removed');
  } finally {
    close();
  }
});

test('safety rail: recorded payments or manual JEs refuse the delete; force overrides', () => {
  const ctx = sysCtx(orgId, AS_OF);

  // a real payment recorded after the import blocks deletion
  const pidPay = importProperty('Paid Up Palace', [
    ['P1', 'Pat Payer', 'pat@propdel.test', '1600', '1600', '100.00', '2026-01-01', '2026-12-31'],
  ]);
  const lease = q1<{ id: string }>('SELECT id FROM leases WHERE property_id=?', pidPay)!;
  insert('payments', {
    id: id('pay'), org_id: orgId, property_id: pidPay, lease_id: lease.id, payer_resident_id: null,
    method: 'check', method_token_id: null, reference: 'chk 1001', amount_cents: 50000, fee_cents: 0,
    status: 'settled', received_date: AS_OF, settle_date: AS_OF, autopay: 0, memo: null,
    created_by: 'test', created_at: nowIso(),
  });
  assert.throws(() => deleteProperty(ctx, pidPay), /recorded payment/);
  assert.ok(q1('SELECT id FROM properties WHERE id=?', pidPay), 'refusal leaves the property intact');
  deleteProperty(ctx, pidPay, { force: true });
  assert.equal(q1('SELECT id FROM properties WHERE id=?', pidPay), undefined, 'force overrides the payment rail');

  // a manually posted JE blocks deletion the same way
  const pidJe = importProperty('Manual Books Manor', [
    ['M1', 'Mia Manual', 'mia@propdel.test', '1700', '1700', '', '2026-01-01', '2026-12-31'],
  ]);
  postJE(ctx, {
    propertyId: pidJe, date: AS_OF, basis: 'accrual', sourceKind: 'manual', memo: 'hand-posted adjustment',
    lines: [{ account: '1010', debit: 1000 }, { account: '3030', credit: 1000 }],
  });
  assert.throws(() => deleteProperty(ctx, pidJe), /manually posted journal/);
  deleteProperty(ctx, pidJe, { force: true });
  assert.equal(q1('SELECT id FROM properties WHERE id=?', pidJe), undefined, 'force overrides the manual-JE rail');
});

test('audit event and domain event record the delete with counts', () => {
  assert.ok(deletedPid, 'a delete ran earlier in this file');
  const aud = q<any>(
    `SELECT * FROM audit_events WHERE org_id=? AND entity='property' AND entity_id=? AND action='delete'`,
    orgId, deletedPid,
  );
  assert.equal(aud.length, 1, 'exactly one audit row for the delete');
  const changes = j<any>(aud[0]!.changes, {});
  assert.ok(changes.counts, 'audit row carries the counts diff');
  assert.equal(changes.counts.to.units, deletedCounts.units);
  assert.equal(changes.counts.to.leases, deletedCounts.leases);
  assert.equal(changes.counts.to.properties, 1);

  const evt = q<any>(
    `SELECT * FROM domain_events WHERE org_id=? AND type='property.deleted' AND entity_id=?`,
    orgId, deletedPid,
  );
  assert.equal(evt.length, 1, 'property.deleted domain event emitted');
  const payload = j<any>(evt[0]!.payload, {});
  assert.equal(payload.counts.units, deletedCounts.units);
  assert.equal(payload.name, 'Doomed Manor');
});
