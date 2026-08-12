import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q1, insert, js } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword, sysCtx } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { applyReadingPlan, type ReadingPlan } from '../src/modules/setup/ai_reader.ts';
import {
  validateRentRoll, applyRentRoll, validateResidents, applyResidents, type BatchRow,
} from '../src/modules/setup/import_apply.ts';

/** Import integrity gate (2026-08-12) — the guardrails born from the first
 * real-data run: (1) the AI reading plan can no longer suppress the stacked-
 * header merge by mislabeling the sub-label row as a section; (2) the rent-
 * roll validation computes a reconciliation strip + column-level mis-mapping
 * warnings (all-zero deposits, uniform balances, parking-as-rent); (3) the
 * resident-directory lane refuses a mass insert (247 duplicates on live)
 * unless the operator explicitly confirms. */

const AS_OF = '2026-07-23';
let orgId: string;

before(() => {
  db();
  const existing = q1<{ id: string }>('SELECT id FROM orgs WHERE slug=?', 'recon-test');
  if (existing) { orgId = existing.id; return; }
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'Recon Test Co', slug: 'recon-test', business_date: AS_OF, kind: 'live', created_at: nowIso() });
  const uid = id('usr');
  insert('users', {
    id: uid, org_id: orgId, email: 'admin@recon-test.test', name: 'Recon Admin',
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

// ---------- 1 · reading-plan structural fixes ----------

test('applyReadingPlan merges a stacked header even when the plan calls the sub-label row a section', () => {
  const rows = [
    ['Station U & O (1022)', '', '', '', ''],
    ['Unit', 'Unit', 'Name', 'Amount', 'Lease'],
    ['', 'Sq Ft', '', '', 'Expiration'],
    ['201', '750', 'Beltran, Angel', '1696.00', '3/28/2025'],
    ['202', '640', 'Karamoko, Melo', '1318.00', '10/3/2025'],
  ];
  const plan: ReadingPlan = {
    header_row: 1,
    cols: { 0: 'unit', 2: 'tenant', 3: 'rent' },
    skip_rows: [0],
    sections: [{ row: 2, property: 'Sq Ft' }], // the live failure: sub-labels misread as a section
  };
  const out = applyReadingPlan(rows, plan, 'rent_roll');
  assert.ok(out.headers[1]!.includes('Sq Ft'), `header merged (got "${out.headers[1]}")`);
  assert.ok(out.headers[4]!.includes('Expiration'), 'Lease Expiration merged');
  assert.equal(out.dataRows.length, 2, 'sub-label row consumed, real rows kept');
  assert.ok(!out.headers.includes('Property'), 'bogus section did not inject a property column');
  assert.ok(out.notes.some((n) => /stacked two-row header/i.test(n)), 'merge noted');
});

test('applyReadingPlan still honors real property sections deeper in the sheet', () => {
  const rows = [
    ['Unit', 'Name', 'Rent'],
    ['Maple Court', '', ''],
    ['101', 'A Person', '1000.00'],
    ['Birch Yard', '', ''],
    ['201', 'B Person', '1100.00'],
  ];
  const plan: ReadingPlan = {
    header_row: 0, cols: { 0: 'unit', 1: 'tenant', 2: 'rent' }, skip_rows: [],
    sections: [{ row: 1, property: 'Maple Court' }, { row: 3, property: 'Birch Yard' }],
  };
  const out = applyReadingPlan(rows, plan, 'rent_roll');
  assert.equal(out.headers[0], 'Property', 'synthetic property column injected');
  assert.deepEqual(out.dataRows.map((r) => r[0]), ['Maple Court', 'Birch Yard']);
});

// ---------- 2 · reconciliation strip + column warnings ----------

const RR_HEADERS = ['Unit', 'Name', 'Rent', 'Deposit', 'Balance'];
const RR_MAPPING = js({ cols: { 0: 'unit', 1: 'tenant', 2: 'rent', 3: 'deposit', 4: 'balance' }, preset: null, aiAssisted: [] });

function rrRows(mut: (i: number) => [string, string, string], n = 12): string[][] {
  return Array.from({ length: n }, (_, i) => {
    const [rent, dep, bal] = mut(i);
    return [`${101 + i}`, `Tenant ${String.fromCharCode(65 + i)}`, rent, dep, bal];
  });
}

test('recon strip totals tie out and stay warning-free on clean data', () => {
  const batch = mkBatch({
    new_property_name: 'Clean Prop', headers: js(RR_HEADERS), mapping: RR_MAPPING,
    rows: js(rrRows((i) => [`${1400 + i}.00`, '500.00', i < 3 ? `${100 + i}.25` : '0'])),
  });
  const v = validateRentRoll(sysCtx(orgId, AS_OF), batch);
  assert.ok(v.recon, 'recon computed');
  assert.equal(v.recon!.units, 12);
  assert.equal(v.recon!.occupied, 12);
  assert.equal(v.recon!.rentCents, Array.from({ length: 12 }, (_, i) => (1400 + i) * 100).reduce((a, b) => a + b));
  assert.equal(v.recon!.depositCents, 12 * 50000);
  assert.equal(v.recon!.balanceCents, 10025 + 10125 + 10225);
  assert.deepEqual(v.recon!.columnWarnings, [], 'no false-positive warnings');
});

test('an all-zero deposit column raises a mis-mapping warning naming the source header', () => {
  const batch = mkBatch({
    new_property_name: 'Zero Dep Prop', headers: js(['Unit', 'Name', 'Rent', 'Other', 'Balance']),
    mapping: RR_MAPPING, rows: js(rrRows((i) => [`${1400 + i}.00`, '0', `${50 + i}.00`])),
  });
  const v = validateRentRoll(sysCtx(orgId, AS_OF), batch);
  const w = v.recon!.columnWarnings.find((x) => /deposit/i.test(x) && /\$0 on every row/.test(x));
  assert.ok(w, `deposit warning present (${js(v.recon!.columnWarnings)})`);
  assert.ok(w!.includes('“Other”'), 'names the mis-mapped source column');
});

test('a uniform balance value raises the identical-values warning', () => {
  const batch = mkBatch({
    new_property_name: 'Uniform Bal Prop', headers: js(RR_HEADERS), mapping: RR_MAPPING,
    rows: js(rrRows(() => ['1500.00', '750.00', '14.50'])),
  });
  const v = validateRentRoll(sysCtx(orgId, AS_OF), batch);
  assert.ok(v.recon!.columnWarnings.some((x) => /identical \(\$14\.50\)/.test(x)), 'uniform balance flagged');
});

test('several occupied units sharing a small rent raises the parking-as-rent warning', () => {
  const batch = mkBatch({
    new_property_name: 'Parking Rent Prop', headers: js(RR_HEADERS), mapping: RR_MAPPING,
    rows: js(rrRows((i) => [i < 3 ? '300.00' : `${1400 + i}.00`, '600.00', `${20 + i}.00`])),
  });
  const v = validateRentRoll(sysCtx(orgId, AS_OF), batch);
  assert.ok(v.recon!.columnWarnings.some((x) => /3 occupied units .*\$300\.00/.test(x) && /parking/i.test(x)), 'parking-as-rent flagged');
});

// ---------- 3 · resident-directory mass-insert guard ----------

test('a directory that matches nobody is blocked from applying until explicitly confirmed', () => {
  const ctx = sysCtx(orgId, AS_OF);
  // real leases first: a clean 12-unit rent roll builds the property
  const rr = mkBatch({
    new_property_name: 'Guard Prop', headers: js(RR_HEADERS), mapping: RR_MAPPING,
    rows: js(rrRows((i) => [`${1400 + i}.00`, '0', '0'])),
  });
  applyRentRoll(ctx, rr);
  const prop = q1<{ id: string }>('SELECT id FROM properties WHERE org_id=? AND name=?', orgId, 'Guard Prop')!;

  // a directory naming 12 strangers on those same units
  const dirRows = Array.from({ length: 12 }, (_, i) => [`${101 + i}`, `Stranger, Completely ${i}`, `s${i}@x.test`]);
  const dir = mkBatch({
    kind: 'residents', property_id: prop.id,
    headers: js(['Unit', 'Resident', 'Email']),
    mapping: js({ cols: { 0: 'unit', 1: 'tenant', 2: 'email' }, preset: null, aiAssisted: [] }),
    rows: js(dirRows),
  });

  const v = validateResidents(ctx, dir);
  assert.ok(v.duplicateGuard, 'guard tripped');
  assert.equal(v.duplicateGuard!.inserts, 12);
  assert.equal(v.duplicateGuard!.matched, 0);
  assert.throws(() => applyResidents(ctx, dir), /match anyone/);

  // confirmed: the same batch applies, as new residents
  const s = applyResidents(ctx, dir, { confirmDuplicates: true });
  assert.equal(s.residents, 12, 'confirmed apply inserts the new people');
});

test('a directory that matches the rent roll by name merges without tripping the guard', () => {
  const ctx = sysCtx(orgId, AS_OF);
  const rr = mkBatch({
    new_property_name: 'Merge Prop', headers: js(RR_HEADERS), mapping: RR_MAPPING,
    rows: js(rrRows((i) => [`${1400 + i}.00`, '0', '0'])),
  });
  applyRentRoll(ctx, rr);
  const prop = q1<{ id: string }>('SELECT id FROM properties WHERE org_id=? AND name=?', orgId, 'Merge Prop')!;

  // same people, directory-style "Last, First" ordering ("Tenant A" → "A, Tenant")
  const dirRows = Array.from({ length: 12 }, (_, i) => [`${101 + i}`, `${String.fromCharCode(65 + i)}, Tenant`, `t${i}@merge.test`]);
  const dir = mkBatch({
    kind: 'residents', property_id: prop.id,
    headers: js(['Unit', 'Resident', 'Email']),
    mapping: js({ cols: { 0: 'unit', 1: 'tenant', 2: 'email' }, preset: null, aiAssisted: [] }),
    rows: js(dirRows),
  });
  const v = validateResidents(ctx, dir);
  assert.equal(v.duplicateGuard, undefined, 'no guard on a matching directory');
  const s = applyResidents(ctx, dir);
  assert.equal(s.contactUpdates, 12, 'all 12 merged as contact updates');
  assert.equal(s.residents, 0, 'nobody duplicated');
});
