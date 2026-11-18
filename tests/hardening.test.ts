import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert, val } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword, sysCtx } from '../src/lib/auth.ts';
import { safeHtml, associateLabels } from '../src/lib/html.ts';
import { readZip, writeZip } from '../src/lib/zip.ts';
import { webhookUrlShape } from '../src/lib/events.ts';
import { runJob, runJobsForDay } from '../src/lib/jobs.ts';
import { Pdf } from '../src/lib/pdf.ts';
import { startTestServer, loginAs, get, post } from './harness.ts';

/** Regression guards for the 2026-11-18 production-readiness audit. Each test
 * is one finding: the request that used to work and must not, or the page that
 * used to crash and must answer. Own fixture, so it cannot disturb the shared
 * two-org harness. */

let base: string;
let close: () => void;
let liveOrg: string;
let liveProp: string;
let demoOrg: string;
let demoProp: string;
let demoProp2: string;
let adminLive: string;
let adminDemo: string;
let scoped: string;
const sfx = id('x').slice(-6);

function mkOrg(kind: 'demo' | 'live'): { org: string; email: string; prop: string; slug: string; uid: string } {
  const org = id('org');
  insert('orgs', { id: org, name: `Hard ${kind} ${sfx}`, slug: `hard-${kind}-${sfx}`, kind, business_date: '2026-07-26', created_at: nowIso() });
  const uid = id('usr');
  const email = `admin-hard-${kind}-${sfx}@example.test`;
  insert('users', { id: uid, org_id: org, email, name: `Admin ${kind}`, kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso() });
  insert('role_assignments', { id: id('ra'), org_id: org, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  const prop = id('prp');
  const slug = `hard-prop-${kind}-${sfx}`;
  insert('properties', { id: prop, org_id: org, name: `Prop ${kind}`, slug, type: 'multifamily', address1: '1 Test St', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso() });
  return { org, email, prop, slug, uid };
}

let liveSlug: string;
let demoSlug: string;
before(async () => {
  db();
  const live = mkOrg('live');
  const demo = mkOrg('demo');
  liveOrg = live.org; liveProp = live.prop; liveSlug = live.slug; adminLive = live.email;
  demoOrg = demo.org; demoProp = demo.prop; demoSlug = demo.slug; adminDemo = demo.email;
  demoProp2 = id('prp');
  insert('properties', { id: demoProp2, org_id: demoOrg, name: 'Second', slug: `hard-second-${sfx}`, type: 'multifamily', address1: '2 Test St', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso() });
  // an accountant scoped to the first demo property only
  const uid = id('usr');
  scoped = `scoped-hard-${sfx}@example.test`;
  insert('users', { id: uid, org_id: demoOrg, email: scoped, name: 'Scoped', kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso() });
  insert('role_assignments', { id: id('ra'), org_id: demoOrg, user_id: uid, role: 'ACCOUNTANT', scope_type: 'properties', property_ids: JSON.stringify([demoProp]), created_at: nowIso() });
  const s = await startTestServer();
  base = s.base; close = s.close;
});
after(() => close());

test('healthz answers without a session and says the database is reachable', async () => {
  const r = await get(base, '/healthz');
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text);
  assert.equal(body.ok, true);
  assert.equal(body.db, 'ok');
  assert.ok(['ok', 'degraded'].includes(body.status));
  assert.ok(!/org|user|email/i.test(r.text), 'health output carries nothing about who is in the database');
});

test('stored rich text cannot carry script into a staff page', () => {
  const out = safeHtml('<p>Hi <script>alert(1)</script><img src=x onerror=alert(1)> — <b>welcome</b></p><a href="javascript:alert(1)">x</a><a href="https://ok.example/a?b=1&c=2">ok</a>').s;
  assert.ok(!/<script|<img|javascript:[^&]*">/i.test(out.replace(/&lt;[^&]*&gt;/g, '')), out);
  assert.ok(out.includes('&lt;script&gt;'), 'the attempt stays visible as text');
  assert.ok(out.includes('<b>welcome</b>') && out.startsWith('<p>'), 'formatting survives');
  assert.ok(out.includes('<a href="https://ok.example/a?b=1&amp;c=2" rel="noopener noreferrer">ok</a>'));
  assert.ok(!out.includes('<a href="javascript'));
  // entities written by the drafting code do not double up
  assert.equal(safeHtml('<p>Tom &amp; Ann</p>').s, '<p>Tom &amp; Ann</p>');
});

test('a public inquiry with markup in the name reaches the AI queue as text', async () => {
  const r = await post(base, `/p/${demoSlug}/inquire`, { first_name: '<script>window.pwn=1</script>', last_name: 'Tester', email: `lead-${sfx}@example.test`, message: 'hello' });
  assert.ok(r.status < 400, `inquiry accepted (${r.status})`);
  const cookie = await loginAs(base, adminDemo);
  for (const path of ['/ai', '/leads', '/admin/outbox']) {
    const page = await get(base, path, cookie);
    if (page.status !== 200) continue;
    assert.ok(!page.text.includes('<script>window.pwn=1</script>') && !/<script nonce="[^"]+">window\.pwn/.test(page.text), `${path} must not render the injected script`);
  }
});

test('a live property is not public until its operator publishes it, forms included', async () => {
  assert.equal((await get(base, `/p/${liveSlug}`)).status, 404);
  assert.equal((await get(base, `/p/${liveSlug}/inquire`)).status, 404);
  assert.equal((await get(base, `/p/${liveSlug}/apply`)).status, 404);
  const before = val<number>('SELECT COUNT(*) FROM leads WHERE org_id=?', liveOrg) || 0;
  const r = await post(base, `/p/${liveSlug}/inquire`, { first_name: 'A', last_name: 'B', email: 'a@example.test' });
  assert.equal(r.status, 404);
  assert.equal(val<number>('SELECT COUNT(*) FROM leads WHERE org_id=?', liveOrg) || 0, before, 'no lead was created');
  // the demo world still publishes by default
  assert.equal((await get(base, `/p/${demoSlug}`)).status, 200);
});

test('the public application never books simulated cash into a live ledger', async () => {
  // publish the live property explicitly; the application must still be closed
  const { run } = await import('../src/lib/db.ts');
  run('UPDATE properties SET marketing=? WHERE id=?', JSON.stringify({ published: true }), liveProp);
  const page = await get(base, `/p/${liveSlug}/apply`);
  assert.equal(page.status, 200);
  assert.match(page.text, /not open for this community yet/);
  const jes = val<number>('SELECT COUNT(*) FROM journal_entries WHERE org_id=?', liveOrg) || 0;
  await post(base, `/p/${liveSlug}/apply`, { unit_id: 'x', first_name: 'A', last_name: 'B', email: 'a@example.test' });
  assert.equal(val<number>('SELECT COUNT(*) FROM applications WHERE org_id=?', liveOrg) || 0, 0);
  assert.equal(val<number>('SELECT COUNT(*) FROM journal_entries WHERE org_id=?', liveOrg) || 0, jes);
  run('UPDATE properties SET marketing=? WHERE id=?', '{}', liveProp);
});

test('an org admin cannot grant themselves the platform role', async () => {
  const cookie = await loginAs(base, adminDemo);
  const me = q1<{ id: string }>('SELECT id FROM users WHERE email=?', adminDemo)!.id;
  await post(base, `/admin/staff/${me}`, { name: 'Admin demo', role: 'PLATFORM_ADMIN', scope_type: 'org' }, cookie);
  assert.equal(val<number>(`SELECT COUNT(*) FROM role_assignments WHERE user_id=? AND role='PLATFORM_ADMIN'`, me) || 0, 0);
  assert.equal((await get(base, '/admin/orgs', cookie)).status, 403);
});

test('a property named in the URL must be inside the reader’s scope and organization', async () => {
  const cookie = await loginAs(base, scoped);
  assert.equal((await get(base, `/gl?property=${demoProp}`, cookie)).status, 200);
  assert.equal((await get(base, `/gl?property=${demoProp2}`, cookie)).status, 404, 'another property in the same org');
  assert.equal((await get(base, `/gl?property=${liveProp}`, cookie)).status, 404, 'a property in another org');
});

test('simulator jobs refuse to run in a live organization, even by hand', () => {
  const leads = val<number>('SELECT COUNT(*) FROM leads WHERE org_id=?', liveOrg) || 0;
  const out = runJob(sysCtx(liveOrg), 'ils_leads', '2026-07-26', { manual: true });
  assert.equal(out.status, 'skipped');
  assert.equal(val<number>('SELECT COUNT(*) FROM leads WHERE org_id=?', liveOrg) || 0, leads);
});

test('a job that repeats with nothing to do does not write a history row each time', () => {
  runJobsForDay(demoOrg, '2026-07-26'); // first pass of the day: logged
  runJobsForDay(demoOrg, '2026-07-26'); // settles anything the first pass created
  const n1 = val<number>('SELECT COUNT(*) FROM job_runs WHERE org_id=?', demoOrg) || 0;
  assert.ok(n1 > 0, 'the first run of the day is in the history');
  for (let i = 0; i < 5; i++) runJobsForDay(demoOrg, '2026-07-26');
  const n2 = val<number>('SELECT COUNT(*) FROM job_runs WHERE org_id=?', demoOrg) || 0;
  const jobs = val<number>('SELECT COUNT(*) FROM jobs WHERE org_id=? AND enabled=1', demoOrg) || 1;
  assert.ok(n2 - n1 <= 2, `five idle passes over ${jobs} jobs wrote ${n2 - n1} rows`);
});

test('pages that report on one property answer before any property exists', async () => {
  const org = id('org');
  insert('orgs', { id: org, name: `Empty ${sfx}`, slug: `hard-empty-${sfx}`, kind: 'live', business_date: '2026-07-26', created_at: nowIso() });
  const uid = id('usr');
  const email = `admin-empty-${sfx}@example.test`;
  insert('users', { id: uid, org_id: org, email, name: 'Empty Admin', kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso() });
  insert('role_assignments', { id: id('ra'), org_id: org, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  const cookie = await loginAs(base, email);
  for (const path of ['/periods', '/utilities', '/utilities/recovery', '/pricing/terms', '/pricing/renewals', '/pricing/comps', '/pricing/analytics']) {
    const r = await get(base, path, cookie);
    assert.equal(r.status, 200, `${path} → ${r.status}`);
    assert.match(r.text, /No buildings yet/, path);
  }
  const home = await get(base, '/home', cookie);
  assert.equal(home.status, 200);
  assert.match(home.text, /One file to start/);
  assert.match(home.text, /Upload a rent roll/);
});

test('a rejected amount is the person’s mistake (400 or a flash), never a 500', async () => {
  const cookie = await loginAs(base, adminDemo);
  const r = await post(base, '/admin/staff/does-not-matter', { role: 'PLATFORM_ADMIN' }, cookie);
  assert.notEqual(r.status, 500);
});

test('report PDFs survive characters the built-in fonts cannot draw', async () => {
  const pdf = await Pdf.create('Balance sheet');
  pdf.text('Assets → Liabilities ✓ net − 5 ≤ 10 · Zoë Ångström 日本');
  pdf.table([{ label: 'A → B', w: 1 }], [['✓ tied'], ['− 4.00']]);
  const bytes = await pdf.bytes();
  assert.ok(bytes.length > 500);
});

test('a zip that inflates past the ceiling is refused, an ordinary one is read', () => {
  const ok = readZip(writeZip([{ name: 'a.txt', data: Buffer.from('hello') }]));
  assert.equal(ok[0]!.data.toString(), 'hello');
  const bomb = writeZip([{ name: 'big.bin', data: Buffer.alloc(130 * 1024 * 1024) }]);
  assert.ok(bomb.length < 2 * 1024 * 1024, 'the archive itself is small');
  assert.throws(() => readZip(bomb), /too large/);
});

test('webhook destinations: https only on a deployment, never the private network', () => {
  assert.equal(webhookUrlShape('https://hooks.example.com/x'), null);
  assert.ok(webhookUrlShape('not a url'));
  assert.ok(webhookUrlShape('ftp://example.com/x'));
  assert.ok(webhookUrlShape('https://user:pw@example.com/x'));
  const prev = process.env.RENDER;
  process.env.RENDER = 'true';
  try {
    assert.ok(webhookUrlShape('http://example.com/x'), 'plain http refused on a deployment');
    for (const u of ['https://169.254.169.254/latest', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://192.168.1.1/x', 'https://localhost/x', 'https://db.internal/x', 'https://[::1]/x']) {
      assert.ok(webhookUrlShape(u), `${u} must be refused`);
    }
  } finally { if (prev === undefined) delete process.env.RENDER; else process.env.RENDER = prev; }
});

test('a bare label is paired with its control; a paired or wrapping one is left alone', () => {
  const out = associateLabels('<div class="field"><label>Email</label><input name="email" type="email" required /></div>');
  const m = /<label for="([^"]+)">Email<\/label><input id="([^"]+)" name="email"/.exec(out);
  assert.ok(m && m[1] === m[2], out);
  const withId = associateLabels('<label>City</label>\n<select id="c9" name="city"></select>');
  assert.ok(withId.includes('<label for="c9">City</label>') && !withId.includes('id="lf-'), withId);
  const wrapped = '<label class="check"><input type="checkbox" name="a" /> <span>Agree</span></label>';
  assert.equal(associateLabels(wrapped), wrapped);
  const already = '<label for="x">Name</label><input id="x" name="n" />';
  assert.equal(associateLabels(already), already);
});

test('changing a password needs the current one, and signs the account out elsewhere', async () => {
  const email = adminLive;
  const uid = q1<{ id: string }>('SELECT id FROM users WHERE email=?', email)!.id;
  const other = await loginAs(base, email);
  const cookie = await loginAs(base, email);
  await post(base, '/me/password', { current: 'wrong-one', password: 'a-much-longer-one', password2: 'a-much-longer-one' }, cookie);
  assert.equal((await loginAs(base, email).catch(() => '')) !== '', true, 'the old password still works after a failed change');
  await post(base, '/me/password', { current: 'demo1234', password: 'a-much-longer-one', password2: 'a-much-longer-one' }, cookie);
  assert.equal((await get(base, '/me', cookie)).status, 200, 'this session stays signed in');
  const stale = await get(base, '/me', other);
  assert.notEqual(stale.status, 200, 'the other session was signed out');
  assert.ok((val<number>('SELECT COUNT(*) FROM sessions WHERE user_id=?', uid) || 0) >= 1);
  const again = await loginAs(base, email, 'a-much-longer-one');
  assert.equal((await get(base, '/me', again)).status, 200);
});

test('the shared demo sign-ins cannot have their password changed', async () => {
  const email = `cast-${sfx}@summitridge.demo`;
  const uid = id('usr');
  insert('users', { id: uid, org_id: demoOrg, email, name: 'Cast', kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso() });
  insert('role_assignments', { id: id('ra'), org_id: demoOrg, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  const cookie = await loginAs(base, email);
  const r = await post(base, '/me/password', { current: 'demo1234', password: 'a-much-longer-one', password2: 'a-much-longer-one' }, cookie);
  assert.equal(r.status, 403);
  assert.ok((await loginAs(base, email)) !== '');
});
