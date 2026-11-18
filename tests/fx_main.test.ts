import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, q1, insert } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword, sysCtx } from '../src/lib/auth.ts';
import { emit } from '../src/lib/events.ts';
import { getSetting } from '../src/lib/settings.ts';
import { readZip } from '../src/lib/zip.ts';
import { exportZip } from '../src/modules/m1_admin/export.ts';
import { startTestServer, loginAs, get, post } from './harness.ts';

/** The walkthrough's cross-cutting items: a real way out with the data, a
 * property address nobody has to fight for, and no fee a real company did not
 * choose. */

let base: string; let close: () => void;
let org: string; let email: string;
const sfx = id('x').slice(-6);

before(async () => {
  db();
  org = id('org');
  insert('orgs', { id: org, name: `Fx Main ${sfx}`, slug: `fx-main-${sfx}`, kind: 'live', business_date: '2026-07-26', created_at: nowIso() });
  email = `admin-fx-main-${sfx}@example.test`;
  insert('users', { id: id('usr'), org_id: org, email, name: 'Main Admin', kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso() });
  insert('role_assignments', { id: id('ra'), org_id: org, user_id: q1<{ id: string }>('SELECT id FROM users WHERE email=?', email)!.id, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  const s = await startTestServer(); base = s.base; close = s.close;
  emit(sysCtx(org), 'org.created', 'org', org, { name: 'Fx Main' }); // after boot: the modules that listen are loaded
});
after(() => close());

test('a new live organization starts with no month-to-month premium', () => {
  assert.equal(getSetting<number>(sysCtx(org), 'mtm_premium_pct'), 0);
});

test('the wizard makes a generated address unique instead of refusing the name', async () => {
  const cookie = await loginAs(base, email);
  const form = { name: `Twin Oaks ${sfx}`, slug: '', type: 'multifamily', address1: '1 Oak St', city: 'Boise', state: 'ID', zip: '83702', fp_name: 'A1', fp_beds: '1', fp_baths: '1', fp_sqft: '600', fp_rent: '1000', unit_count: '2', unit_start: '101' };
  const first = await post(base, '/setup/wizard', form, cookie);
  const second = await post(base, '/setup/wizard', form, cookie);
  const slugs = (await import('../src/lib/db.ts')).q<{ slug: string }>('SELECT slug FROM properties WHERE org_id=? ORDER BY created_at', org).map((p) => p.slug);
  assert.equal(slugs.length, 2, `both saved (${first.status}, ${second.status}): ${slugs.join(', ')}`);
  assert.notEqual(slugs[0], slugs[1]);
  assert.ok(slugs[1]!.startsWith(slugs[0]!), 'the second is the first with a suffix');
});

test('the whole organization downloads as CSV files, without secrets or anyone else’s rows', async () => {
  const cookie = await loginAs(base, email);
  const page = await get(base, '/admin/export', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Download everything/);
  const resp = await fetch(base + '/admin/export.zip', { headers: { cookie } });
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get('content-type'), 'application/zip');
  const entries = readZip(Buffer.from(await resp.arrayBuffer()));
  const names = entries.map((e) => e.name);
  assert.ok(names.includes('README.txt') && names.includes('properties.csv') && names.includes('users.csv'), names.join(', '));
  for (const banned of ['sessions.csv', 'api_keys.csv', 'webhook_endpoints.csv']) assert.ok(!names.includes(banned), banned);
  const users = entries.find((e) => e.name === 'users.csv')!.data.toString();
  assert.ok(!/password_hash|scrypt\$/.test(users), 'no password hashes');
  assert.ok(users.includes(email));
  const all = entries.map((e) => e.data.toString()).join('\n');
  assert.ok(!all.includes('@summitridge.demo') && !all.includes('iso-a'), 'only this organization’s rows');
  // the same bytes the route serves, straight from the function
  assert.ok(exportZip(sysCtx(org)).length > 200);
  assert.ok(q1(`SELECT id FROM audit_events WHERE org_id=? AND action='export'`, org), 'the download is in the audit log');
});

test('the export needs the settings permission', async () => {
  const uid = id('usr');
  const agent = `agent-fx-main-${sfx}@example.test`;
  insert('users', { id: uid, org_id: org, email: agent, name: 'Agent', kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso() });
  insert('role_assignments', { id: id('ra'), org_id: org, user_id: uid, role: 'LEASING_AGENT', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  const cookie = await loginAs(base, agent);
  assert.equal((await get(base, '/admin/export.zip', cookie)).status, 403);
});
