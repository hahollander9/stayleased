import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { db, q1, insert, val, run, ROOT } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword, sysCtx } from '../src/lib/auth.ts';
import { putFile } from '../src/lib/files.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { autoMap } from '../src/modules/setup/mapping.ts';
import { applyRentRoll, type BatchRow } from '../src/modules/setup/import_apply.ts';
import { startTestServer, loginAs, get, post } from './harness.ts';

/** Removing an upload from the Migration Center: the batch row (which holds
 * the whole grid — every name, email and balance the file carried) and the
 * lease lane's stored PDFs go for good, while everything an applied upload
 * IMPORTED stays. Typed-name confirm on applied uploads, audit metadata
 * without contents, and org isolation on the route. */

const AS_OF = '2026-07-23';
const RR_HEADERS = ['Unit', 'Tenant', 'Email', 'Rent', 'Deposit', 'Balance', 'Lease From', 'Lease To'];

let orgId: string;
let otherOrgId: string;

before(() => {
  db();
  const existing = q1<{ id: string }>('SELECT id FROM orgs WHERE slug=?', 'imprm-test');
  if (existing) {
    orgId = existing.id;
    otherOrgId = q1<{ id: string }>('SELECT id FROM orgs WHERE slug=?', 'imprm-other')!.id;
    return;
  }
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'Import Remove Co', slug: 'imprm-test', business_date: AS_OF, kind: 'live', created_at: nowIso() });
  const uid = id('usr');
  insert('users', {
    id: uid, org_id: orgId, email: 'admin@imprm.test', name: 'Rm Admin',
    kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
  });
  insert('role_assignments', { id: id('ra'), org_id: orgId, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  ensureCoa(orgId);

  // a second org whose uploads must be invisible to the first
  otherOrgId = id('org');
  insert('orgs', { id: otherOrgId, name: 'Other Co', slug: 'imprm-other', business_date: AS_OF, kind: 'live', created_at: nowIso() });
  ensureCoa(otherOrgId);
});

function mkBatch(over: Partial<BatchRow> & { org_id?: string }): BatchRow {
  const b = {
    id: id('imp'), org_id: orgId, kind: 'rent_roll', filename: 'rentroll.xlsx',
    property_id: null, new_property_name: null, preset: null,
    headers: '[]', mapping: '{}', rows: '[]', staged: '[]',
    as_of: AS_OF, status: 'staged', created_by: 'test',
    ...over,
  } as BatchRow;
  insert('import_batches', { ...b, summary: null, created_at: nowIso(), applied_at: null } as unknown as Record<string, unknown>);
  return b;
}

function mkRentRoll(over: Partial<BatchRow>, rows: string[][]): BatchRow {
  return mkBatch({
    headers: JSON.stringify(RR_HEADERS), mapping: JSON.stringify(autoMap(RR_HEADERS, 'rent_roll')),
    rows: JSON.stringify(rows), ...over,
  });
}

const exists = (batchId: string): boolean => !!q1('SELECT id FROM import_batches WHERE id=?', batchId);
const removeAudit = (batchId: string): { changes: string | null } | undefined =>
  q1<{ changes: string | null }>(`SELECT changes FROM audit_events WHERE entity='import_batch' AND entity_id=? AND action='remove'`, batchId);

test('a staged upload is removed outright — no typed confirm, row and grid gone, audit keeps metadata only', async () => {
  const batch = mkRentRoll({ filename: 'staged.xlsx' }, [
    ['101', 'Sana Staged', 'sana@imprm.test', '1500', '1500', '0', '2026-01-01', '2026-12-31'],
  ]);
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@imprm.test');

    // the confirm screen states what goes, and asks for no typed name
    const confirm = await get(base, `/setup/import/b/${batch.id}/remove`, cookie);
    assert.equal(confirm.status, 200);
    assert.match(confirm.text, /Remove this upload/);
    assert.match(confirm.text, /1 data row read from the file/);
    assert.match(confirm.text, /Nothing was ever written from this upload/);
    assert.doesNotMatch(confirm.text, /confirm_name/, 'no typed confirm for an upload that wrote nothing');

    const done = await post(base, `/setup/import/b/${batch.id}/remove`, {}, cookie);
    assert.equal(done.status, 303);
    assert.equal(done.location, '/setup/import');
    assert.equal(exists(batch.id), false, 'batch row deleted');

    const audited = removeAudit(batch.id);
    assert.ok(audited, 'removal is on the audit trail');
    assert.match(audited!.changes || '', /staged\.xlsx/, 'audit keeps the file name');
    assert.doesNotMatch(audited!.changes || '', /Sana Staged|sana@imprm\.test/, 'audit never carries the file contents');
  } finally {
    close();
  }
});

test('an applied upload needs the typed file name — and removing it leaves everything it imported', async () => {
  const batch = mkRentRoll({ filename: 'applied.xlsx', new_property_name: 'Removal Court' }, [
    ['201', 'Ada Applied', 'ada@imprm.test', '1600', '1600', '75.00', '2026-01-01', '2026-12-31'],
    ['202', 'Ben Booked', 'ben@imprm.test', '1550', '1550', '0', '2026-02-01', '2027-01-31'],
  ]);
  applyRentRoll(sysCtx(orgId, AS_OF), batch);
  const pid = q1<{ id: string }>('SELECT id FROM properties WHERE org_id=? AND name=?', orgId, 'Removal Court')!.id;
  const before = {
    units: val<number>('SELECT COUNT(*) FROM units WHERE property_id=?', pid) || 0,
    leases: val<number>('SELECT COUNT(*) FROM leases WHERE property_id=?', pid) || 0,
    residents: val<number>('SELECT COUNT(*) FROM residents WHERE property_id=?', pid) || 0,
    jes: val<number>('SELECT COUNT(*) FROM journal_entries WHERE org_id=? AND property_id=?', orgId, pid) || 0,
  };
  assert.equal(before.units, 2, 'the import really did build the property');
  assert.ok(before.jes > 0, 'the import really did post books');

  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@imprm.test');

    // the confirm screen promises the imported records stay, and asks for the name
    const confirm = await get(base, `/setup/import/b/${batch.id}/remove`, cookie);
    assert.equal(confirm.status, 200);
    assert.match(confirm.text, /What it imported stays/);
    assert.match(confirm.text, /confirm_name/);

    // wrong name → refused, upload survives
    const bad = await post(base, `/setup/import/b/${batch.id}/remove`, { confirm_name: 'not-the-file.xlsx' }, cookie);
    assert.equal(bad.status, 303);
    assert.equal(bad.location, `/setup/import/b/${batch.id}/remove`);
    assert.equal(exists(batch.id), true, 'a mismatch removes nothing');

    // exact name → removed
    const ok = await post(base, `/setup/import/b/${batch.id}/remove`, { confirm_name: 'applied.xlsx' }, cookie);
    assert.equal(ok.status, 303);
    assert.equal(ok.location, '/setup/import');
    assert.equal(exists(batch.id), false, 'batch row deleted');
  } finally {
    close();
  }

  // the portfolio the upload built is untouched — it is the portfolio now, not the file
  assert.ok(q1('SELECT id FROM properties WHERE id=?', pid), 'property survives');
  assert.equal(val<number>('SELECT COUNT(*) FROM units WHERE property_id=?', pid), before.units);
  assert.equal(val<number>('SELECT COUNT(*) FROM leases WHERE property_id=?', pid), before.leases);
  assert.equal(val<number>('SELECT COUNT(*) FROM residents WHERE property_id=?', pid), before.residents);
  assert.equal(val<number>('SELECT COUNT(*) FROM journal_entries WHERE org_id=? AND property_id=?', orgId, pid), before.jes);
});

test('removing a lease-PDF upload deletes the stored PDFs — rows and bytes', async () => {
  const ctx = sysCtx(orgId, AS_OF);
  const pdf = Buffer.from('%PDF-1.4\nfake lease\n%%EOF\n');
  const a = putFile(ctx, pdf, { name: 'lease-a.pdf', mime: 'application/pdf', entity: 'import', visibility: 'staff' });
  const b = putFile(ctx, pdf, { name: 'lease-b.pdf', mime: 'application/pdf', entity: 'import', visibility: 'staff' });
  const blob = (fid: string): string => join(ROOT, 'data', 'files', fid + '.bin');
  assert.ok(existsSync(blob(a.id)) && existsSync(blob(b.id)), 'blobs written by putFile');

  const batch = mkBatch({
    kind: 'lease_pdf', filename: '2 lease PDFs',
    staged: JSON.stringify([
      { filename: 'lease-a.pdf', fileId: a.id, include: true, fields: {}, confidence: {}, notes: [], source: 'ai' },
      { filename: 'lease-b.pdf', fileId: b.id, include: true, fields: {}, confidence: {}, notes: [], source: 'ai' },
    ]),
  });

  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@imprm.test');
    const confirm = await get(base, `/setup/import/b/${batch.id}/remove`, cookie);
    assert.equal(confirm.status, 200);
    assert.match(confirm.text, /2 stored PDFs/, 'the confirm screen counts the stored documents');

    const done = await post(base, `/setup/import/b/${batch.id}/remove`, {}, cookie);
    assert.equal(done.status, 303);
  } finally {
    close();
  }

  assert.equal(exists(batch.id), false, 'batch row deleted');
  for (const f of [a, b]) {
    assert.equal(q1('SELECT id FROM files WHERE id=?', f.id), undefined, 'file row deleted');
    assert.equal(existsSync(blob(f.id)), false, 'blob deleted from disk');
  }
  assert.match(removeAudit(batch.id)!.changes || '', /"files":\{"from":null,"to":2\}/, 'audit records how many documents went');
});

test('the hub lists a Remove action per upload, and another org cannot reach one', async () => {
  const mine = mkRentRoll({ filename: 'mine.xlsx' }, [['301', 'Mia Mine', 'mia@imprm.test', '1400', '1400', '0', '2026-01-01', '2026-12-31']]);
  const theirs = mkBatch({ org_id: otherOrgId, filename: 'theirs.xlsx' });

  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@imprm.test');
    const hub = await get(base, '/setup/import', cookie);
    assert.equal(hub.status, 200);
    assert.match(hub.text, /Import history/);
    assert.match(hub.text, new RegExp(`/setup/import/b/${mine.id}/remove`), 'the upload carries a Remove action');
    assert.doesNotMatch(hub.text, /theirs\.xlsx/, "another org's uploads are not listed");

    // the route itself is org-scoped, not just the listing
    assert.equal((await get(base, `/setup/import/b/${theirs.id}/remove`, cookie)).status, 404);
    const post404 = await post(base, `/setup/import/b/${theirs.id}/remove`, {}, cookie);
    assert.equal(post404.status, 404);
    assert.equal(exists(theirs.id), true, "another org's upload survives");
  } finally {
    close();
  }
  run('DELETE FROM import_batches WHERE id=?', theirs.id);
});
