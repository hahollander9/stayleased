import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q1, val, insert, run } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { autoMap } from '../src/modules/setup/mapping.ts';
import type { BatchRow } from '../src/modules/setup/import_apply.ts';
import { startTestServer, loginAs, get, post } from './harness.ts';

/** The source document on the review screen.
 *
 * Reviewing an import means checking the reader's claims against the document
 * those claims are about, so the document has to be reachable from the screen
 * that asks for the check. Uploads made before originals were kept have none —
 * and the first build simply rendered nothing for them, so the promised button
 * was missing with no explanation. Every such upload can now be repaired in
 * place by attaching the file. */

const AS_OF = '2026-07-23';
const RR_HEADERS = ['Unit', 'Tenant', 'Email', 'Rent', 'Deposit', 'Balance', 'Lease From', 'Lease To'];
const CSV = 'Unit,Tenant,Email,Rent,Deposit,Balance,Lease From,Lease To\n101,Sam Source,sam@src.test,1500,1500,0,2026-01-01,2026-12-31\n';

let orgId: string;

before(() => {
  db();
  const existing = q1<{ id: string }>('SELECT id FROM orgs WHERE slug=?', 'impsrc-test');
  if (existing) { orgId = existing.id; return; }
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'Import Source Co', slug: 'impsrc-test', business_date: AS_OF, kind: 'live', created_at: nowIso() });
  const uid = id('usr');
  insert('users', {
    id: uid, org_id: orgId, email: 'admin@impsrc.test', name: 'Src Admin',
    kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
  });
  insert('role_assignments', { id: id('ra'), org_id: orgId, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  ensureCoa(orgId);
});

/** A batch as the pre-source-file builds left them: rows and mapping, no
 * document. This is what every already-uploaded import looks like. */
function legacyBatch(over: Partial<BatchRow> = {}): BatchRow {
  const b = {
    id: id('imp'), org_id: orgId, kind: 'rent_roll', filename: 'legacy-rentroll.xlsx',
    property_id: null, new_property_name: 'Source Court', preset: null,
    headers: JSON.stringify(RR_HEADERS), mapping: JSON.stringify(autoMap(RR_HEADERS, 'rent_roll')),
    rows: JSON.stringify([['101', 'Sam Source', 'sam@src.test', '1500', '1500', '0', '2026-01-01', '2026-12-31']]),
    staged: '[]', as_of: AS_OF, status: 'staged', created_by: 'test', source_file_id: null,
    ...over,
  } as BatchRow;
  insert('import_batches', { ...b, summary: null, created_at: nowIso(), applied_at: null } as unknown as Record<string, unknown>);
  return b;
}

async function attach(base: string, cookie: string, batchId: string, filename = 'legacy-rentroll.csv'): Promise<{ status: number; location: string | null }> {
  const fd = new FormData();
  fd.set('file', new File([CSV], filename, { type: 'text/csv' }));
  const resp = await fetch(`${base}/setup/import/b/${batchId}/source`, {
    method: 'POST', headers: { origin: base, cookie }, body: fd, redirect: 'manual',
  });
  return { status: resp.status, location: resp.headers.get('location') };
}

test('an upload with no original says so on the review screen and offers to take one', async () => {
  const batch = legacyBatch();
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@impsrc.test');
    const review = await get(base, `/setup/import/b/${batch.id}`, cookie);
    assert.equal(review.status, 200);
    assert.match(review.text, /Source document/, 'the screen names the document it is checking against');
    assert.match(review.text, /Not on file/, 'and states plainly that it does not have it');
    assert.match(review.text, /legacy-rentroll\.xlsx/, 'naming the file it was read from');
    assert.match(review.text, new RegExp(`/setup/import/b/${batch.id}/source`), 'with a way to attach it');
    assert.doesNotMatch(review.text, /Open the original file/, 'no button that cannot work');
  } finally { close(); }
});

test('attaching the original makes it openable from the review screen from then on', async () => {
  const batch = legacyBatch({ filename: 'attachable.xlsx' });
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@impsrc.test');
    const done = await attach(base, cookie, batch.id);
    assert.equal(done.status, 303);
    assert.equal(done.location, `/setup/import/b/${batch.id}`);

    const fileId = q1<{ source_file_id: string | null }>('SELECT source_file_id FROM import_batches WHERE id=?', batch.id)?.source_file_id;
    assert.ok(fileId, 'the batch now points at a stored document');
    const row = q1<{ entity: string; entity_id: string; visibility: string }>('SELECT entity, entity_id, visibility FROM files WHERE id=?', fileId!);
    assert.equal(row?.entity, 'import_batch');
    assert.equal(row?.entity_id, batch.id);
    assert.equal(row?.visibility, 'staff');

    const review = await get(base, `/setup/import/b/${batch.id}`, cookie);
    assert.match(review.text, /Open the original file/);
    assert.ok(review.text.includes(`/f/${fileId}`));
    const served = await fetch(`${base}/f/${fileId}`, { headers: { cookie } });
    assert.equal(await served.text(), CSV, 'and it serves back the bytes that were attached');

    // the attachment is on the trail, without the contents
    const audited = q1<{ changes: string }>(
      `SELECT changes FROM audit_events WHERE entity='import_batch' AND entity_id=? AND action='attach_source'`, batch.id);
    assert.ok(audited, 'attaching a source document is audited');
    assert.doesNotMatch(audited!.changes || '', /Sam Source/, 'the audit never carries the file contents');
  } finally { close(); }
});

test('a document already on file is never silently replaced', async () => {
  const batch = legacyBatch({ filename: 'once-only.xlsx' });
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@impsrc.test');
    assert.equal((await attach(base, cookie, batch.id)).status, 303);
    const first = q1<{ source_file_id: string }>('SELECT source_file_id FROM import_batches WHERE id=?', batch.id)!.source_file_id;

    const second = await attach(base, cookie, batch.id, 'different-file.csv');
    assert.equal(second.status, 303);
    const after = q1<{ source_file_id: string }>('SELECT source_file_id FROM import_batches WHERE id=?', batch.id)!.source_file_id;
    assert.equal(after, first, 'the record keeps the document it was reviewed against');
    assert.equal(val<number>(`SELECT COUNT(*) FROM files WHERE entity='import_batch' AND entity_id=?`, batch.id), 1, 'and no orphan is stored');
  } finally { close(); }
});

test('the lease-PDF lane keeps its own documents and refuses a single original', async () => {
  const batch = legacyBatch({ kind: 'lease_pdf', filename: '2 lease PDFs', rows: '[]', staged: '[]' });
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@impsrc.test');
    const resp = await attach(base, cookie, batch.id, 'lease.pdf');
    assert.equal(resp.status, 303);
    assert.equal(resp.location, `/setup/import/leases/${batch.id}`);
    assert.equal(
      q1<{ source_file_id: string | null }>('SELECT source_file_id FROM import_batches WHERE id=?', batch.id)?.source_file_id,
      null, 'that lane stores a PDF per draft instead',
    );
  } finally { close(); }
});

test('an applied record keeps the document reachable — history is checkable later, not just at review time', async () => {
  const batch = legacyBatch({ filename: 'applied-record.xlsx' });
  run(`UPDATE import_batches SET status='applied', applied_at=? WHERE id=?`, nowIso(), batch.id);
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@impsrc.test');
    const record = await get(base, `/setup/import/b/${batch.id}`, cookie);
    assert.equal(record.status, 200);
    assert.match(record.text, /Source document/);
    assert.match(record.text, /Not on file/);

    assert.equal((await attach(base, cookie, batch.id)).status, 303);
    const after = await get(base, `/setup/import/b/${batch.id}`, cookie);
    assert.match(after.text, /Open the original file/);

    // and the Migration Center says which uploads have their document
    const hub = await get(base, '/setup/import', cookie);
    assert.match(hub.text, /Open the original/);
  } finally { close(); }
});

test('another org cannot attach a document to an upload it cannot see', async () => {
  const otherOrg = q1<{ id: string }>('SELECT id FROM orgs WHERE slug=?', 'impsrc-other')?.id
    ?? (() => {
      const oid = id('org');
      insert('orgs', { id: oid, name: 'Other Src Co', slug: 'impsrc-other', business_date: AS_OF, kind: 'live', created_at: nowIso() });
      ensureCoa(oid);
      return oid;
    })();
  const theirs = legacyBatch({ org_id: otherOrg, filename: 'theirs.xlsx' });
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@impsrc.test');
    const resp = await attach(base, cookie, theirs.id);
    assert.equal(resp.status, 404);
    assert.equal(
      q1<{ source_file_id: string | null }>('SELECT source_file_id FROM import_batches WHERE id=?', theirs.id)?.source_file_id,
      null, 'nothing was written to another org’s record',
    );
  } finally { close(); }
});
