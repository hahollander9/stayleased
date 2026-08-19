import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q1, insert, val } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword, sysCtx } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { trialBalance } from '../src/modules/m9_accounting/service.ts';
import { autoMap } from '../src/modules/setup/mapping.ts';
import { applyRentRoll, type BatchRow } from '../src/modules/setup/import_apply.ts';
import { clearOrgData, deleteProperty } from '../src/modules/m2_portfolio/service.ts';
import { putFile } from '../src/lib/files.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/lib/db.ts';
import { startTestServer, loginAs, get, post } from './harness.ts';

/** Org-level "clear all portfolio data" — the onboarding loop's reset. Every
 * property and everything under it goes, plus the org-level residue a property
 * delete leaves standing (vendors, uploads). The org, its staff, the chart of
 * accounts and the audit trail survive. Typed org-name confirm on the route,
 * and demo orgs are refused outright. */

const AS_OF = '2026-07-23';
const RR_HEADERS = ['Unit', 'Tenant', 'Email', 'Rent', 'Deposit', 'Balance', 'Lease From', 'Lease To'];

let orgId: string;
let demoOrgId: string;

before(() => {
  db();
  const existing = q1<{ id: string }>('SELECT id FROM orgs WHERE slug=?', 'orgclear-test');
  if (existing) {
    orgId = existing.id;
    demoOrgId = q1<{ id: string }>('SELECT id FROM orgs WHERE slug=?', 'orgclear-demo')!.id;
    return;
  }
  const mkOrg = (name: string, slug: string, kind: string): string => {
    const oid = id('org');
    insert('orgs', { id: oid, name, slug, business_date: AS_OF, kind, created_at: nowIso() });
    const uid = id('usr');
    insert('users', {
      id: uid, org_id: oid, email: `admin@${slug}.test`, name: 'Clear Admin',
      kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
    });
    insert('role_assignments', { id: id('ra'), org_id: oid, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
    ensureCoa(oid);
    return oid;
  };
  orgId = mkOrg('Clear Test Co', 'orgclear-test', 'live');
  demoOrgId = mkOrg('Demo World Co', 'orgclear-demo', 'demo');
});

function importProperty(name: string, rows: string[][]): string {
  const bid = id('imp');
  insert('import_batches', {
    id: bid, org_id: orgId, kind: 'rent_roll', filename: `${name}.xlsx`,
    property_id: null, new_property_name: name, preset: null,
    headers: JSON.stringify(RR_HEADERS), mapping: JSON.stringify(autoMap(RR_HEADERS, 'rent_roll')),
    rows: JSON.stringify(rows), staged: '[]', as_of: AS_OF, status: 'staged',
    summary: null, created_by: 'test', created_at: nowIso(), applied_at: null,
  });
  applyRentRoll(sysCtx(orgId, AS_OF), { id: bid, org_id: orgId, kind: 'rent_roll', filename: null, property_id: null, new_property_name: name, preset: null, headers: JSON.stringify(RR_HEADERS), mapping: JSON.stringify(autoMap(RR_HEADERS, 'rent_roll')), rows: JSON.stringify(rows), staged: '[]', as_of: AS_OF, status: 'staged', created_by: 'test' } as BatchRow);
  return q1<{ id: string }>('SELECT id FROM properties WHERE org_id=? AND name=?', orgId, name)!.id;
}

test('clearing wipes every property and the org-level residue, and keeps the org standing', () => {
  const a = importProperty('Alpha Court', [['A1', 'Ann Alpha', 'ann@orgclear.test', '1500', '1500', '250.00', '2026-01-01', '2026-12-31']]);
  const b = importProperty('Beta Court', [['B1', 'Bo Beta', 'bo@orgclear.test', '1400', '1400', '0', '2026-01-01', '2026-12-31']]);
  insert('vendors', { id: id('ven'), org_id: orgId, name: 'Rooter Bros', category: 'plumbing', email: null, phone: null, active: 1, created_at: nowIso() });
  // a payment: the per-property delete refuses these, the org reset clears them
  const lease = q1<{ id: string }>('SELECT id FROM leases WHERE property_id=?', a)!;
  insert('payments', {
    id: id('pay'), org_id: orgId, property_id: a, lease_id: lease.id, payer_resident_id: null,
    method: 'ach', amount_cents: 25000, status: 'settled', received_date: AS_OF,
    reference: 'test', memo: null, created_by: 'test', created_at: nowIso(),
  });
  assert.ok(trialBalance(sysCtx(orgId, AS_OF), { basis: 'accrual' }).length > 0, 'books exist before');

  const { counts } = clearOrgData(sysCtx(orgId, AS_OF));

  assert.equal(counts.properties, 2, 'both properties removed');
  assert.equal(counts.vendors, 1, 'org-level vendors removed');
  assert.ok((counts.import_batches || 0) >= 2, 'the uploads went too');
  for (const [table, where] of [
    ['properties', 'org_id'], ['units', 'org_id'], ['leases', 'org_id'], ['residents', 'org_id'],
    ['journal_entries', 'org_id'], ['journal_lines', 'org_id'], ['charges', 'org_id'],
    ['payments', 'org_id'], ['vendors', 'org_id'], ['import_batches', 'org_id'],
  ] as [string, string][]) {
    assert.equal(val<number>(`SELECT COUNT(*) FROM ${table} WHERE ${where}=?`, orgId), 0, `${table} cleared`);
  }
  assert.equal(b && val<number>('SELECT COUNT(*) FROM properties WHERE id=?', b), 0);

  // what must survive: the org, its staff, the chart of accounts, the trail
  assert.ok(q1('SELECT id FROM orgs WHERE id=?', orgId), 'the organization stays');
  assert.equal(val<number>(`SELECT COUNT(*) FROM users WHERE org_id=? AND kind='staff'`, orgId), 1, 'staff accounts stay');
  assert.equal(val<number>('SELECT COUNT(*) FROM role_assignments WHERE org_id=?', orgId), 1, 'their roles stay');
  assert.ok((val<number>('SELECT COUNT(*) FROM gl_accounts WHERE org_id=?', orgId) || 0) > 0, 'chart of accounts stays');
  assert.ok(
    q1(`SELECT id FROM audit_events WHERE org_id=? AND action='clear_portfolio_data'`, orgId),
    'the clear is on the audit trail, which outlives the data it describes',
  );
  assert.equal(trialBalance(sysCtx(orgId, AS_OF), { basis: 'accrual' }).length, 0, 'the books are empty, not unbalanced');
});

test('the route needs the typed org name, and refuses the demo org outright', async () => {
  importProperty('Gamma Court', [['G1', 'Gil Gamma', 'gil@orgclear.test', '1500', '1500', '0', '2026-01-01', '2026-12-31']]);
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@orgclear-test.test');
    const page = await get(base, '/admin/settings', cookie);
    assert.equal(page.status, 200);
    assert.match(page.text, /Danger zone/);
    assert.match(page.text, /Clear all portfolio data/);
    assert.match(page.text, /Clear Test Co/, 'the confirm names the organization');

    const bad = await post(base, '/admin/settings/clear-data', { confirm_name: 'Wrong Co' }, cookie);
    assert.equal(bad.status, 303);
    assert.equal(bad.location, '/admin/settings');
    assert.ok((val<number>('SELECT COUNT(*) FROM properties WHERE org_id=?', orgId) || 0) > 0, 'a mismatch clears nothing');

    const ok = await post(base, '/admin/settings/clear-data', { confirm_name: 'Clear Test Co' }, cookie);
    assert.equal(ok.status, 303);
    assert.equal(ok.location, '/setup#upload', 'lands where the next import starts');
    assert.equal(val<number>('SELECT COUNT(*) FROM properties WHERE org_id=?', orgId), 0, 'cleared');

    // the demo org keeps its seeded world even with the name typed correctly
    const demoCookie = await loginAs(base, 'admin@orgclear-demo.test');
    const demoPage = await get(base, '/admin/settings', demoCookie);
    // NB: match a phrase that cannot straddle a template line break
    assert.match(demoPage.text, /Clearing the portfolio is disabled/);
    const refused = await post(base, '/admin/settings/clear-data', { confirm_name: 'Demo World Co' }, demoCookie);
    assert.equal(refused.status, 303);
    assert.equal(refused.location, '/admin/settings');
  } finally {
    close();
  }
});

test('clearing purges stored bytes too — not just the rows pointing at them', () => {
  const pid = importProperty('Blob Court', [['C1', 'Cy Blob', 'cy@orgclear.test', '1500', '1500', '0', '2026-01-01', '2026-12-31']]);
  const ctx = sysCtx(orgId, AS_OF);
  const lease = q1<{ id: string }>('SELECT id FROM leases WHERE property_id=?', pid)!;
  // a signed lease attached to the property, and a Migration Center upload
  const signed = putFile(ctx, Buffer.from('%PDF-1.4 signed lease'), { name: 'signed.pdf', mime: 'application/pdf', entity: 'lease', entityId: lease.id });
  const upload = putFile(ctx, Buffer.from('%PDF-1.4 uploaded'), { name: 'upload.pdf', mime: 'application/pdf', entity: 'import' });
  const blob = (fid: string): string => join(ROOT, 'data', 'files', fid + '.bin');
  assert.ok(existsSync(blob(signed.id)) && existsSync(blob(upload.id)));

  clearOrgData(ctx);

  // deleteProperty removes files ROWS with raw SQL and cannot reach the disk,
  // so without the sweep the signed lease would survive as unreachable bytes
  assert.equal(q1('SELECT id FROM files WHERE id=?', signed.id), undefined, 'lease file row gone');
  assert.equal(existsSync(blob(signed.id)), false, 'and so are its bytes');
  assert.equal(q1('SELECT id FROM files WHERE id=?', upload.id), undefined, 'upload row gone');
  assert.equal(existsSync(blob(upload.id)), false, 'and so are its bytes');
});

test('a property-scoped admin cannot clear the whole organization', async () => {
  importProperty('Scoped Court', [['S1', 'Sam Scope', 'sam@orgclear.test', '1500', '1500', '0', '2026-01-01', '2026-12-31']]);
  const onlyProp = q1<{ id: string }>('SELECT id FROM properties WHERE org_id=? LIMIT 1', orgId)!.id;
  const uid = id('usr');
  insert('users', {
    id: uid, org_id: orgId, email: 'scoped@orgclear-test.test', name: 'Scoped Admin',
    kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
  });
  insert('role_assignments', {
    id: id('ra'), org_id: orgId, user_id: uid, role: 'ORG_ADMIN',
    scope_type: 'property', property_ids: JSON.stringify([onlyProp]), created_at: nowIso(),
  });

  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'scoped@orgclear-test.test');
    const res = await post(base, '/admin/settings/clear-data', { confirm_name: 'Clear Test Co' }, cookie);
    assert.equal(res.status, 403, 'deleting every property needs whole-organization access');
    assert.ok((val<number>('SELECT COUNT(*) FROM properties WHERE org_id=?', orgId) || 0) > 0, 'nothing was cleared');
  } finally {
    close();
  }
});

test('deleting a single property takes its stored bytes with it', () => {
  // deleteProperty removes files ROWS by raw SQL and cannot reach the store, so
  // before this every signed lease and ID scan under a deleted property was
  // left on disk as unreachable data — #35's forbidden state, reached by the
  // ordinary property danger zone rather than by the org reset.
  const pid = importProperty('Byte Court', [['D1', 'Dee Byte', 'dee@orgclear.test', '1500', '1500', '0', '2026-01-01', '2026-12-31']]);
  const ctx = sysCtx(orgId, AS_OF);
  const lease = q1<{ id: string }>('SELECT id FROM leases WHERE property_id=?', pid)!;
  const f = putFile(ctx, Buffer.from('%PDF-1.4 lease'), { name: 'lease.pdf', mime: 'application/pdf', entity: 'lease', entityId: lease.id });
  const blob = join(ROOT, 'data', 'files', f.id + '.bin');
  assert.ok(existsSync(blob));

  const { counts } = deleteProperty(ctx, pid);

  assert.equal(q1('SELECT id FROM files WHERE id=?', f.id), undefined, 'the row goes');
  assert.equal(existsSync(blob), false, 'and so do the bytes');
  assert.ok((counts.file_blobs || 0) >= 1, 'the count reports what was unlinked');
});
