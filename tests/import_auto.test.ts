import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q1, val, insert, j } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { startTestServer, loginAs, get } from './harness.ts';

/** Drop a file, get an answer.
 *
 * The operator picks nothing. The upload route identifies the document, routes
 * it to the lane that can build something, and the review screen leads with
 * what was read rather than a column-mapping table. A report we recognise but
 * cannot import is kept and explained — never forced into a lane, because a
 * wrong lane writes garbage into a real book. */

const AS_OF = '2026-08-19';
let orgId: string;

before(() => {
  db();
  const existing = q1<{ id: string }>('SELECT id FROM orgs WHERE slug=?', 'auto-test');
  if (existing) { orgId = existing.id; return; }
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'Auto Import Co', slug: 'auto-test', business_date: AS_OF, kind: 'live', created_at: nowIso() });
  const uid = id('usr');
  insert('users', {
    id: uid, org_id: orgId, email: 'admin@auto.test', name: 'Auto Admin',
    kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
  });
  insert('role_assignments', { id: id('ra'), org_id: orgId, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  ensureCoa(orgId);
});

/** Upload with no `kind` at all — exactly what the single dropzone sends. */
async function drop(base: string, cookie: string, filename: string, csv: string): Promise<{ status: number; location: string | null }> {
  const fd = new FormData();
  fd.set('kind', 'auto');
  fd.set('prop_mode', 'detect');
  fd.set('as_of', AS_OF);
  fd.set('file', new File([csv], filename, { type: 'text/csv' }));
  const resp = await fetch(`${base}/setup/import/upload`, {
    method: 'POST', headers: { origin: base, cookie }, body: fd, redirect: 'manual',
  });
  return { status: resp.status, location: resp.headers.get('location') };
}

const batchOf = (loc: string | null): string => /\/setup\/import\/b\/(imp\w+)/.exec(loc || '')?.[1] || '';

const RENT_ROLL = [
  'Rent Roll with Lease Charges',
  'Orchard East (1042)',
  'Unit,Tenant,Rent,Deposit,Balance,Lease From,Lease To',
  '101,Ana Ramos,1500.00,1500.00,0,2026-01-01,2026-12-31',
  '102,Chi Okafor,1450.00,1450.00,250.00,2026-02-01,2027-01-31',
].join('\n');

const DIRECTORY = [
  'Resident Directory',
  'Orchard East',
  'Name,Email,Phone,Unit',
  'Ana Ramos,ana@auto.test,555-0100,101',
].join('\n');

const BOX_SCORE = [
  'Box Score Summary',
  'Orchard East',
  'Period,Move Ins,Move Outs,Occupancy',
  'Aug 2026,4,3,94.2%',
].join('\n');

test('a rent roll routes itself — the operator picked no lane', async () => {
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@auto.test');
    const up = await drop(base, cookie, 'orchard-east.csv', RENT_ROLL);
    assert.equal(up.status, 303);
    const batchId = batchOf(up.location);
    assert.ok(batchId, 'landed on a review page');

    const batch = q1<{ kind: string; mapping: string }>('SELECT kind, mapping FROM import_batches WHERE id=?', batchId)!;
    assert.equal(batch.kind, 'rent_roll', 'routed to the lane that can build a portfolio');
    const cls = j<any>(batch.mapping, {}).classification;
    assert.equal(cls.report, 'Rent Roll with Lease Charges', 'and recorded what it decided it was');
    assert.equal(cls.supported, true);

    const review = await get(base, `/setup/import/b/${batchId}`, cookie);
    assert.equal(review.status, 200);
    // the screen leads with what it read, not with spreadsheet columns
    assert.match(review.text, /What StayLeased read/);
    assert.match(review.text, /Rent Roll with Lease Charges/);
    assert.match(review.text, /2 data rows/);
    assert.match(review.text, /Show how the columns were matched/, 'mapping is available, not the interface');
    assert.doesNotMatch(review.text, /1 · Column mapping/);
  } finally { close(); }
});

test('a resident directory routes to its own lane from the same dropzone', async () => {
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@auto.test');
    const up = await drop(base, cookie, 'directory.csv', DIRECTORY);
    const batchId = batchOf(up.location);
    assert.equal(q1<{ kind: string }>('SELECT kind FROM import_batches WHERE id=?', batchId)!.kind, 'residents');
  } finally { close(); }
});

test('a report with no tenancy data is kept and explained, never forced into a lane', async () => {
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@auto.test');
    const up = await drop(base, cookie, 'box-score.csv', BOX_SCORE);
    assert.equal(up.status, 303);
    const batchId = batchOf(up.location);
    const batch = q1<{ kind: string; status: string; source_file_id: string | null; rows: string }>(
      'SELECT kind, status, source_file_id, rows FROM import_batches WHERE id=?', batchId)!;
    assert.equal(batch.kind, 'unknown');
    assert.equal(batch.rows, '[]', 'nothing was read in as data');
    assert.ok(batch.source_file_id, 'the file itself is kept');

    const page = await get(base, `/setup/import/b/${batchId}`, cookie);
    assert.equal(page.status, 200);
    assert.match(page.text, /Box Score Summary/, 'it is named');
    assert.match(page.text, /Nothing was imported from this file/, 'plainly');
    assert.match(page.text, /What to send instead/, 'and it says what would work');
    assert.match(page.text, /Open the original file/, 'with the upload still openable');

    // nothing was built
    assert.equal(val<number>('SELECT COUNT(*) FROM properties WHERE org_id=?', orgId), 0);
    assert.equal(val<number>('SELECT COUNT(*) FROM units WHERE org_id=?', orgId), 0);
  } finally { close(); }
});

test('an explicit lane still wins — auto-detection is the default, not a cage', async () => {
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@auto.test');
    const fd = new FormData();
    fd.set('kind', 'residents'); // deliberately not what the document says
    fd.set('prop_mode', 'detect');
    fd.set('file', new File([RENT_ROLL], 'orchard-east.csv', { type: 'text/csv' }));
    const resp = await fetch(`${base}/setup/import/upload`, {
      method: 'POST', headers: { origin: base, cookie }, body: fd, redirect: 'manual',
    });
    const batchId = batchOf(resp.headers.get('location'));
    assert.equal(q1<{ kind: string }>('SELECT kind FROM import_batches WHERE id=?', batchId)!.kind, 'residents');
  } finally { close(); }
});

test('the hub offers one dropzone that takes anything, with the lanes tucked behind it', async () => {
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@auto.test');
    const hub = await get(base, '/setup', cookie);
    assert.equal(hub.status, 200);
    assert.match(hub.text, /Upload anything from your old system/);
    assert.match(hub.text, /No column mapping, no template/);
    // the type control exists but defaults to letting the document decide, and
    // it is tucked inside a disclosure rather than being the first question
    assert.match(hub.text, /Work it out from the document/, 'the default asks the operator for no type');
    assert.match(hub.text, /It is a specific type and I want to say so/, 'overriding is possible, and demoted');
    assert.equal((hub.text.match(/input type="file" name="file"/g) || []).length, 1, 'exactly one uploader on the page');
  } finally { close(); }
});
