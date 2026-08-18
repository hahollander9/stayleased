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
import { trialBalance } from '../src/modules/m9_accounting/service.ts';
import { autoMap } from '../src/modules/setup/mapping.ts';
import { applyRentRoll, applyResidents, type BatchRow } from '../src/modules/setup/import_apply.ts';
import { startTestServer, loginAs, get, post } from './harness.ts';

/** Removing an upload from the Migration Center. Three things go: everything
 * the import wrote (found by the import_batch_id stamp, so exactly this
 * upload's rows and no others), the batch row itself (which holds the whole
 * grid — every name, email and balance the file carried), and the lease lane's
 * stored PDFs. Covers the typed-name confirm on applied uploads, the
 * payments rail that refuses rather than erase financial history, audit
 * metadata without contents, and org isolation on the route. */

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

test('an applied upload needs the typed file name — and removing it takes the whole import back', async () => {
  const batch = mkRentRoll({ filename: 'applied.xlsx', new_property_name: 'Removal Court' }, [
    ['201', 'Ada Applied', 'ada@imprm.test', '1600', '1600', '75.00', '2026-01-01', '2026-12-31'],
    ['202', 'Ben Booked', 'ben@imprm.test', '1550', '1550', '0', '2026-02-01', '2027-01-31'],
  ]);
  // a second property, imported separately, must survive untouched
  const keeper = mkRentRoll({ filename: 'keeper.xlsx', new_property_name: 'Keeper Court' }, [
    ['K1', 'Kay Keeper', 'kay@imprm.test', '1300', '1300', '40.00', '2026-01-01', '2026-12-31'],
  ]);
  applyRentRoll(sysCtx(orgId, AS_OF), batch);
  applyRentRoll(sysCtx(orgId, AS_OF), keeper);
  const pid = q1<{ id: string }>('SELECT id FROM properties WHERE org_id=? AND name=?', orgId, 'Removal Court')!.id;
  const keeperPid = q1<{ id: string }>('SELECT id FROM properties WHERE org_id=? AND name=?', orgId, 'Keeper Court')!.id;
  assert.equal(val<number>('SELECT COUNT(*) FROM units WHERE property_id=?', pid), 2, 'the import really did build it');
  assert.ok((val<number>('SELECT COUNT(*) FROM journal_entries WHERE org_id=? AND property_id=?', orgId, pid) || 0) > 0);
  assert.equal(val<number>(`SELECT COUNT(*) FROM users u JOIN residents r ON r.user_id=u.id WHERE r.property_id=?`, pid), 2, 'portal logins provisioned');

  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@imprm.test');

    // the confirm screen counts what will come back out
    const confirm = await get(base, `/setup/import/b/${batch.id}/remove`, cookie);
    assert.equal(confirm.status, 200);
    assert.match(confirm.text, /What it imported comes out with it/);
    assert.match(confirm.text, /1 property/);
    assert.match(confirm.text, /2 units/);
    assert.match(confirm.text, /2 leases/);
    assert.match(confirm.text, /confirm_name/);

    // wrong name → refused, nothing removed at all
    const bad = await post(base, `/setup/import/b/${batch.id}/remove`, { confirm_name: 'not-the-file.xlsx' }, cookie);
    assert.equal(bad.status, 303);
    assert.equal(exists(batch.id), true, 'a mismatch removes nothing');
    assert.ok(q1('SELECT id FROM properties WHERE id=?', pid), 'and leaves the import in place');

    // exact name → the upload and its import both go
    const ok = await post(base, `/setup/import/b/${batch.id}/remove`, { confirm_name: 'applied.xlsx' }, cookie);
    assert.equal(ok.status, 303);
    assert.equal(ok.location, '/setup/import');
    assert.equal(exists(batch.id), false, 'batch row deleted');
  } finally {
    close();
  }

  // everything the upload created is out of the system
  assert.equal(q1('SELECT id FROM properties WHERE id=?', pid), undefined, 'property removed');
  assert.equal(val<number>('SELECT COUNT(*) FROM units WHERE property_id=?', pid), 0);
  assert.equal(val<number>('SELECT COUNT(*) FROM leases WHERE property_id=?', pid), 0);
  assert.equal(val<number>('SELECT COUNT(*) FROM residents WHERE property_id=?', pid), 0);
  assert.equal(val<number>('SELECT COUNT(*) FROM journal_entries WHERE org_id=? AND property_id=?', orgId, pid), 0, 'conversion entries reversed out');
  assert.equal(
    val<number>('SELECT COUNT(*) FROM users WHERE org_id=? AND import_batch_id=?', orgId, batch.id), 0,
    'portal logins the import minted are gone too',
  );

  // …and the other upload's property is untouched, books included
  assert.ok(q1('SELECT id FROM properties WHERE id=?', keeperPid), 'the keeper property survives');
  assert.equal(val<number>('SELECT COUNT(*) FROM units WHERE property_id=?', keeperPid), 1);
  assert.ok(
    (val<number>('SELECT COUNT(*) FROM journal_entries WHERE org_id=? AND property_id=?', orgId, keeperPid) || 0) > 0,
    "the keeper import's books are still posted",
  );
  assert.ok(trialBalance(sysCtx(orgId, AS_OF), { basis: 'accrual' }).length > 0, 'the org still has books');
  assert.equal(removeAudit(batch.id)!.changes!.includes('1 property'), true, 'audit records what came back out');
});

test('a payment recorded against an imported lease blocks the removal', async () => {
  const batch = mkRentRoll({ filename: 'paid.xlsx', new_property_name: 'Paid Court' }, [
    ['301', 'Pat Payer', 'pat@imprm.test', '1500', '1500', '200.00', '2026-01-01', '2026-12-31'],
  ]);
  applyRentRoll(sysCtx(orgId, AS_OF), batch);
  const pid = q1<{ id: string }>('SELECT id FROM properties WHERE org_id=? AND name=?', orgId, 'Paid Court')!.id;
  const lease = q1<{ id: string }>('SELECT id FROM leases WHERE property_id=?', pid)!;
  insert('payments', {
    id: id('pay'), org_id: orgId, property_id: pid, lease_id: lease.id, payer_resident_id: null,
    method: 'ach', amount_cents: 20000, status: 'settled', received_date: AS_OF,
    reference: 'test', memo: null, created_by: 'test', created_at: nowIso(),
  });

  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@imprm.test');
    const blocked = await post(base, `/setup/import/b/${batch.id}/remove`, { confirm_name: 'paid.xlsx' }, cookie);
    assert.equal(blocked.status, 303);
    assert.match(blocked.location || '', /\/remove$/, 'sent back to the confirm screen with the reason');
    assert.equal(exists(batch.id), true, 'the upload survives');
    assert.ok(q1('SELECT id FROM properties WHERE id=?', pid), 'and so does everything it imported');
  } finally {
    close();
  }
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

test('removing a directory upload un-merges the contact info it filled in — and only that', async () => {
  // rent roll first: a primary with no email (the Yardi reality)
  const rr = mkRentRoll({ filename: 'dir-rr.xlsx', new_property_name: 'Merge Court' }, [
    ['701', 'Angel Beltran', '', '1500', '1500', '0', '2026-01-01', '2026-12-31'],
  ]);
  applyRentRoll(sysCtx(orgId, AS_OF), rr);
  const pid = q1<{ id: string }>('SELECT id FROM properties WHERE org_id=? AND name=?', orgId, 'Merge Court')!.id;

  const dirHeaders = ['Unit', 'Name', 'Email', 'Phone', 'Role'];
  const dir = mkBatch({
    kind: 'residents', filename: 'directory.csv', property_id: pid,
    headers: JSON.stringify(dirHeaders), mapping: JSON.stringify(autoMap(dirHeaders, 'residents')),
    rows: JSON.stringify([
      ['701', 'Beltran, Angel', 'angel@imprm.test', '(202) 555-0101', ''],
      ['701', 'Riley Beltran', '', '', 'occupant'],
    ]),
  });
  applyResidents(sysCtx(orgId, AS_OF), dir);

  const angelId = q1<{ id: string }>('SELECT id FROM residents WHERE org_id=? AND first_name=?', orgId, 'Angel')!.id;
  const merged = q1<{ email: string | null; phone: string | null; user_id: string | null }>('SELECT email, phone, user_id FROM residents WHERE id=?', angelId)!;
  assert.equal(merged.email, 'angel@imprm.test', 'the directory filled the blank email');
  assert.ok(merged.user_id, 'and provisioned a portal login off it');
  assert.equal(val<number>('SELECT COUNT(*) FROM residents WHERE property_id=?', pid), 2, 'Angel merged, Riley added');

  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@imprm.test');
    const confirm = await get(base, `/setup/import/b/${dir.id}/remove`, cookie);
    assert.match(confirm.text, /1 restored contact record/, 'the confirm screen counts the un-merge');
    assert.match(confirm.text, /1 resident record/, 'and the person it added');
    const ok = await post(base, `/setup/import/b/${dir.id}/remove`, { confirm_name: 'directory.csv' }, cookie);
    assert.equal(ok.status, 303);
  } finally {
    close();
  }

  // the merged fields are back to blank, and the login it minted is gone
  const after = q1<{ email: string | null; phone: string | null; user_id: string | null }>('SELECT email, phone, user_id FROM residents WHERE id=?', angelId)!;
  assert.equal(after.email, null, 'the imported email is un-merged');
  assert.equal(after.phone, null, 'and so is the phone');
  assert.equal(after.user_id, null, 'the unused portal login it created is gone');
  // but Angel herself — created by the RENT ROLL, not this upload — remains
  assert.ok(q1('SELECT id FROM residents WHERE id=?', angelId), 'the person stays; only what this upload wrote is undone');
  assert.equal(val<number>('SELECT COUNT(*) FROM residents WHERE property_id=?', pid), 1, 'the occupant this upload added is gone');
  assert.ok(q1('SELECT id FROM properties WHERE id=?', pid), 'the rent roll’s property is untouched');
});

test('an edited contact value is left alone — un-merge only reverts what is still the import’s', async () => {
  const rr = mkRentRoll({ filename: 'edit-rr.xlsx', new_property_name: 'Edited Court' }, [
    ['801', 'Casey Edit', '', '1500', '1500', '0', '2026-01-01', '2026-12-31'],
  ]);
  applyRentRoll(sysCtx(orgId, AS_OF), rr);
  const pid = q1<{ id: string }>('SELECT id FROM properties WHERE org_id=? AND name=?', orgId, 'Edited Court')!.id;
  const dirHeaders = ['Unit', 'Name', 'Email', 'Phone', 'Role'];
  const dir = mkBatch({
    kind: 'residents', filename: 'edited-dir.csv', property_id: pid,
    headers: JSON.stringify(dirHeaders), mapping: JSON.stringify(autoMap(dirHeaders, 'residents')),
    rows: JSON.stringify([['801', 'Edit, Casey', 'stale@imprm.test', '', '']]),
  });
  applyResidents(sysCtx(orgId, AS_OF), dir);
  const caseyId = q1<{ id: string }>('SELECT id FROM residents WHERE org_id=? AND first_name=?', orgId, 'Casey')!.id;

  // staff correct the address by hand after the import
  run('UPDATE residents SET email=? WHERE id=?', 'casey.corrected@imprm.test', caseyId);

  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@imprm.test');
    await post(base, `/setup/import/b/${dir.id}/remove`, { confirm_name: 'edited-dir.csv' }, cookie);
  } finally {
    close();
  }
  assert.equal(
    q1<{ email: string }>('SELECT email FROM residents WHERE id=?', caseyId)!.email, 'casey.corrected@imprm.test',
    'the hand-corrected address is the operator’s now — removal leaves it alone',
  );
});

test('a lease-PDF upload reverses too — leases, units and the deposit entries it posted', async () => {
  // the PDF lane always imports INTO a property that already exists, so the
  // property must survive while everything the upload added comes out
  const rr = mkRentRoll({ filename: 'pdf-host.xlsx', new_property_name: 'PDF Host Court' }, [
    ['901', 'Hazel Host', 'hazel@imprm.test', '1500', '1500', '0', '2026-01-01', '2026-12-31'],
  ]);
  applyRentRoll(sysCtx(orgId, AS_OF), rr);
  const pid = q1<{ id: string }>('SELECT id FROM properties WHERE org_id=? AND name=?', orgId, 'PDF Host Court')!.id;
  const jesBefore = val<number>('SELECT COUNT(*) FROM journal_entries WHERE org_id=? AND property_id=?', orgId, pid) || 0;

  const pdf = Buffer.from('%PDF-1.4\nlease\n%%EOF\n');
  const f = putFile(sysCtx(orgId, AS_OF), pdf, { name: 'unit-902.pdf', mime: 'application/pdf', entity: 'import', visibility: 'staff' });
  const batch = mkBatch({
    kind: 'lease_pdf', filename: 'unit-902.pdf', property_id: pid,
    staged: JSON.stringify([{
      filename: 'unit-902.pdf', fileId: f.id, include: true, source: 'text', confidence: {}, notes: [],
      fields: { unit: '902', tenants: 'Pat Pdf', email: 'pat@imprm.test', phone: '', rent: '1450', deposit: '1450', start: '2026-02-01', end: '2027-01-31' },
    }]),
  });

  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@imprm.test');
    // apply it through the real route so the lane's own apply path runs
    const applied = await post(base, `/setup/import/leases/${batch.id}/apply`, {
      inc_0: 'on', f_0_unit: '902', f_0_tenants: 'Pat Pdf', f_0_email: 'pat@imprm.test', f_0_phone: '',
      f_0_rent: '1450', f_0_deposit: '1450', f_0_start: '2026-02-01', f_0_end: '2027-01-31',
    }, cookie);
    assert.equal(applied.status, 303, 'lease PDF applied');
    assert.equal(val<number>('SELECT COUNT(*) FROM units WHERE property_id=? AND unit_number=?', pid, '902'), 1, 'unit created');
    const jesAfter = val<number>('SELECT COUNT(*) FROM journal_entries WHERE org_id=? AND property_id=?', orgId, pid) || 0;
    assert.ok(jesAfter > jesBefore, 'the deposit posted conversion entries on both bases');

    const confirm = await get(base, `/setup/import/b/${batch.id}/remove`, cookie);
    assert.match(confirm.text, /PDF Host Court/, 'the confirm screen names the property');
    assert.match(confirm.text, /stays/, 'and says it survives — the upload did not create it');
    assert.doesNotMatch(confirm.text, /created by this upload/, 'no property is being removed here');

    const ok = await post(base, `/setup/import/b/${batch.id}/remove`, { confirm_name: 'unit-902.pdf' }, cookie);
    assert.equal(ok.status, 303);
  } finally {
    close();
  }

  // what the PDF added is gone — including its deposit entries (the bug this
  // test was written for: the PDF lane never stamped them)
  assert.equal(val<number>('SELECT COUNT(*) FROM units WHERE property_id=? AND unit_number=?', pid, '902'), 0, 'unit removed');
  assert.equal(val<number>(`SELECT COUNT(*) FROM leases WHERE property_id=? AND household_name LIKE '%Pdf%'`, pid), 0, 'lease removed');
  assert.equal(
    val<number>('SELECT COUNT(*) FROM journal_entries WHERE org_id=? AND property_id=?', orgId, pid), jesBefore,
    'the deposit entries it posted came off the books — no deposits held for a lease that no longer exists',
  );
  assert.equal(q1('SELECT id FROM files WHERE id=?', f.id), undefined, 'the stored PDF is gone');
  // …and the property the rent roll built is untouched
  assert.ok(q1('SELECT id FROM properties WHERE id=?', pid), 'the property stays');
  assert.equal(val<number>('SELECT COUNT(*) FROM units WHERE property_id=? AND unit_number=?', pid, '901'), 1, "the rent roll's unit stays");
});

test('a rent roll imported INTO an existing property removes its rows, not the building', async () => {
  const first = mkRentRoll({ filename: 'first.xlsx', new_property_name: 'Shared Court' }, [
    ['A1', 'Ann First', 'ann@imprm.test', '1200', '1200', '0', '2026-01-01', '2026-12-31'],
  ]);
  applyRentRoll(sysCtx(orgId, AS_OF), first);
  const pid = q1<{ id: string }>('SELECT id FROM properties WHERE org_id=? AND name=?', orgId, 'Shared Court')!.id;

  // a second rent roll adding more units to the SAME property
  const second = mkRentRoll({ filename: 'second.xlsx', property_id: pid }, [
    ['B1', 'Bob Second', 'bob@imprm.test', '1300', '1300', '0', '2026-01-01', '2026-12-31'],
  ]);
  applyRentRoll(sysCtx(orgId, AS_OF), second);
  assert.equal(val<number>('SELECT COUNT(*) FROM units WHERE property_id=?', pid), 2);

  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@imprm.test');
    const confirm = await get(base, `/setup/import/b/${second.id}/remove`, cookie);
    assert.match(confirm.text, /Shared Court/);
    assert.match(confirm.text, /stays/, 'the building it was imported into survives');
    await post(base, `/setup/import/b/${second.id}/remove`, { confirm_name: 'second.xlsx' }, cookie);
  } finally {
    close();
  }
  assert.ok(q1('SELECT id FROM properties WHERE id=?', pid), 'the property stays');
  assert.equal(val<number>('SELECT COUNT(*) FROM units WHERE property_id=?', pid), 1, 'only the second upload’s unit went');
  assert.equal(val<number>('SELECT COUNT(*) FROM units WHERE property_id=? AND unit_number=?', pid, 'A1'), 1, "the first upload's unit stays");
});

test('the original document is kept on upload, openable from review and record, and removed with the upload', async () => {
  const csv = 'Vendor Name,Trade,Email,Phone\nAce Plumbing,Plumbing,ace@imprm.test,555-0101\nVolt Electric,Electrical,volt@imprm.test,555-0102\n';
  const blob = (fid: string): string => join(ROOT, 'data', 'files', fid + '.bin');

  const { base, close } = await startTestServer();
  let fileId = '';
  let batchId = '';
  try {
    const cookie = await loginAs(base, 'admin@imprm.test');

    // upload through the real route — multipart, exactly as the browser sends it
    const fd = new FormData();
    fd.set('kind', 'vendors');
    fd.set('file', new File([csv], 'vendors.csv', { type: 'text/csv' }));
    const up = await fetch(`${base}/setup/import/upload`, {
      method: 'POST', headers: { origin: base, cookie }, body: fd, redirect: 'manual',
    });
    assert.equal(up.status, 303, 'upload accepted');
    batchId = /\/setup\/import\/b\/(imp\w+)/.exec(up.headers.get('location') || '')?.[1] || '';
    assert.ok(batchId, 'landed on the review page');

    // the document itself was kept, tied to the batch, staff-visible
    const stored = q1<{ source_file_id: string | null }>('SELECT source_file_id FROM import_batches WHERE id=?', batchId);
    fileId = stored?.source_file_id || '';
    assert.ok(fileId, 'the batch records its source file');
    const fileRow = q1<{ entity: string; entity_id: string; name: string; visibility: string }>('SELECT entity, entity_id, name, visibility FROM files WHERE id=?', fileId);
    assert.equal(fileRow?.entity, 'import_batch');
    assert.equal(fileRow?.entity_id, batchId);
    assert.equal(fileRow?.name, 'vendors.csv');
    assert.equal(fileRow?.visibility, 'staff');

    // the review page links it, and the link serves the exact bytes uploaded
    const review = await get(base, `/setup/import/b/${batchId}`, cookie);
    assert.equal(review.status, 200);
    assert.match(review.text, /Open the original file/);
    assert.ok(review.text.includes(`/f/${fileId}`), 'the review page links the stored original');
    const served = await fetch(`${base}/f/${fileId}`, { headers: { cookie } });
    assert.equal(served.status, 200);
    assert.equal(await served.text(), csv, 'the original bytes come back unchanged');

    // the read-only record (discarded or applied) keeps the link — history can
    // always be checked against its source
    await post(base, `/setup/import/b/${batchId}/discard`, {}, cookie);
    const record = await get(base, `/setup/import/b/${batchId}`, cookie);
    assert.match(record.text, /Open the original file/);
    assert.ok(record.text.includes(`/f/${fileId}`), 'the record page links the stored original');

    // the confirm screen says the original goes too, and removing takes it
    const confirm = await get(base, `/setup/import/b/${batchId}/remove`, cookie);
    assert.match(confirm.text, /the original document/, 'the confirm screen names the original document');
    const done = await post(base, `/setup/import/b/${batchId}/remove`, {}, cookie);
    assert.equal(done.status, 303);

    const gone = await fetch(`${base}/f/${fileId}`, { headers: { cookie } });
    assert.equal(gone.status, 404, 'the original is unreachable after removal');
  } finally {
    close();
  }
  assert.equal(exists(batchId), false, 'batch row deleted');
  assert.equal(q1('SELECT id FROM files WHERE id=?', fileId), undefined, 'file row deleted');
  assert.equal(existsSync(blob(fileId)), false, 'blob deleted from disk');
});
