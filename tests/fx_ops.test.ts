import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert, run, val } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword, sysCtx } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { runJob } from '../src/lib/jobs.ts';
import { setSetting } from '../src/lib/settings.ts';
import { createTurn, advanceTurnTask } from '../src/modules/m10_facilities/service.ts';
import { ensureCatalog, ten99Pdf, remittanceAdvice } from '../src/modules/m16_procurement/service.ts';
import { getFile } from '../src/lib/files.ts';
import { startTestServer, loginAs, get } from './harness.ts';

/** Operations walkthrough as a LIVE (non-demo) company: vendors, vendor portal,
 * purchasing, 3-way match, 1099, work-order labor, turns, tech notices and
 * utility bill-back. Each test is one confirmed defect, asserted on what is
 * actually in the database afterwards. Own fixture; own org. */

const BD = '2026-07-26';
const sfx = id('x').slice(-6);
let base: string;
let close: () => void;
let live: string; let liveProp: string; let liveAdmin: string; let liveAdminId: string; let liveCookie: string;
let demo: string; let demoProp: string; let demoAdminId: string; let demoCookie: string;
let techId: string;
const unit: Record<string, string> = {};
const lease: Record<string, string> = {};

/** POST that also returns the flash message the redirect carried. */
async function post(path: string, body: Record<string, string>, cookie: string): Promise<{ status: number; location: string | null; flash: string; kind: string; text: string }> {
  const resp = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, cookie },
    body: new URLSearchParams(body).toString(),
    redirect: 'manual',
  });
  const m = /sl_fl=([^;]+)/.exec(resp.headers.get('set-cookie') || '');
  const raw = m ? decodeURIComponent(m[1]!) : '';
  const i = raw.indexOf('|');
  return { status: resp.status, location: resp.headers.get('location'), kind: raw.slice(0, i), flash: raw.slice(i + 1), text: await resp.text() };
}

function mkOrg(kind: 'demo' | 'live'): { org: string; prop: string; email: string; uid: string } {
  const org = id('org');
  insert('orgs', { id: org, name: `Ops ${kind} Realty ${sfx}`, slug: `ops-${kind}-${sfx}`, kind, business_date: BD, created_at: nowIso() });
  ensureCoa(org);
  ensureCatalog(org);
  const uid = id('usr');
  const email = `admin-ops-${kind}-${sfx}@example.test`;
  insert('users', { id: uid, org_id: org, email, name: `Admin ${kind}`, kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso() });
  insert('role_assignments', { id: id('ra'), org_id: org, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  const prop = id('prp');
  insert('properties', { id: prop, org_id: org, name: `Ops ${kind} Court`, slug: `ops-prop-${kind}-${sfx}`, type: 'multifamily', address1: '1 Test St', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso() });
  return { org, prop, email, uid };
}

function mkUnit(org: string, prop: string, n: string, status: string): string {
  const uid = id('unt');
  insert('units', { id: uid, org_id: org, property_id: prop, unit_number: n, floor: 1, sqft: 800, status, market_rent_cents: 150000, amenities: '[]', created_at: nowIso() });
  return uid;
}

function mkLease(org: string, prop: string, unitId: string, name: string, status: string, moveOut: string | null): string {
  const lid = id('lse');
  insert('leases', {
    id: lid, org_id: org, property_id: prop, unit_id: unitId, household_name: name, status,
    start_date: '2026-01-01', end_date: '2026-12-31', move_in_date: '2026-01-01', move_out_date: moveOut,
    rent_cents: 150000, deposit_cents: 150000, term_months: 12, created_at: nowIso(),
  });
  const rid = id('res');
  insert('residents', { id: rid, org_id: org, property_id: prop, first_name: name, last_name: 'Tester', email: `${name.toLowerCase()}-${sfx}@example.test`, kind: 'adult', created_at: nowIso() });
  insert('household_members', { id: id('hm'), org_id: org, lease_id: lid, resident_id: rid, role: 'primary', created_at: nowIso() });
  return lid;
}

function mkWo(org: string, prop: string, summary: string): string {
  const woId = id('wo');
  insert('work_orders', {
    id: woId, org_id: org, property_id: prop, unit_id: null, category: 'plumbing', priority: 'normal', status: 'triaged',
    summary, permission_to_enter: 1, pet_on_premises: 0, source: 'staff', created_date: BD, created_by: 'test', created_at: nowIso(),
  });
  return woId;
}

const vendorByName = (name: string): any => q1<any>('SELECT * FROM vendors WHERE org_id=? AND name=?', live, name);
const jeCount = (org: string): number => val<number>('SELECT COUNT(*) FROM journal_entries WHERE org_id=?', org) || 0;

before(async () => {
  db();
  const l = mkOrg('live');
  const d = mkOrg('demo');
  live = l.org; liveProp = l.prop; liveAdmin = l.email; liveAdminId = l.uid;
  demo = d.org; demoProp = d.prop; demoAdminId = d.uid;
  unit.a = mkUnit(live, liveProp, '101', 'occupied');
  unit.b = mkUnit(live, liveProp, '102', 'notice');
  unit.c = mkUnit(live, liveProp, '103', 'vacant_not_ready');
  lease.a = mkLease(live, liveProp, unit.a!, 'Alder', 'active', null);
  lease.b = mkLease(live, liveProp, unit.b!, 'Birch', 'notice', '2026-08-15');
  techId = id('usr');
  insert('users', { id: techId, org_id: live, email: `tech-ops-${sfx}@example.test`, name: 'Terry Tech', phone: '(303) 555-0101', kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso() });
  insert('role_assignments', { id: id('ra'), org_id: live, user_id: techId, role: 'MAINTENANCE_TECH', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  const s = await startTestServer();
  base = s.base; close = s.close;
  liveCookie = await loginAs(base, liveAdmin);
  demoCookie = await loginAs(base, d.email);
});
after(() => close());

// ---------- item 7 ----------
test('7: the staff reset-password confirmation does not promise demo1234 to a live company', async () => {
  const livePage = await get(base, `/admin/staff/${liveAdminId}`, liveCookie);
  assert.equal(livePage.status, 200);
  assert.ok(!livePage.text.includes('Reset password to demo1234'), 'live org is never told the password becomes demo1234');
  assert.match(livePage.text, /data-confirm="Reset this password\? A new one-time password is shown to you once/);
  const demoPage = await get(base, `/admin/staff/${demoAdminId}`, demoCookie);
  assert.match(demoPage.text, /data-confirm="Reset password to demo1234\?"/, 'the demo keeps its own wording');
});

// ---------- items 22 / 49 / 77 ----------
test('22/49/77: a vendor can be added by hand, with every field, and edited', async () => {
  const list = await get(base, '/vendors', liveCookie);
  assert.match(list.text, /href="\/vendors\/new"[^>]*>Add vendor</);
  const form = await get(base, '/vendors/new', liveCookie);
  assert.equal(form.status, 200);
  for (const label of ['Business name', 'Category', 'Contact person', 'Email', 'Phone', 'Mailing address', 'Insurance certificate expires', 'Taxpayer ID', 'W-9 on file']) {
    assert.ok(form.text.includes(label), `form has a visible "${label}" label`);
  }

  const r = await post('/vendors/new', {
    name: 'Rapid Rooter Plumbing', category: 'plumbing', contact_name: 'Dana Ortiz', email: 'Dispatch@RapidRooter.example',
    phone: '303-555-0142', address: '88 Pipe St, Denver CO 80205', coi_expiry: '2027-03-31',
    w9_on_file: '1', tin_last4: '4821', is_1099: '1', terms: 'net 30',
  }, liveCookie);
  assert.equal(r.status, 303);
  const v1 = vendorByName('Rapid Rooter Plumbing');
  assert.ok(v1, 'the vendor row exists');
  assert.equal(r.location, `/vendors/${v1.id}`);
  assert.deepEqual(
    [v1.category, v1.contact_name, v1.email, v1.phone, v1.address, v1.coi_expiry, v1.w9_on_file, v1.tin_last4, v1.is_1099, v1.active, v1.terms],
    ['plumbing', 'Dana Ortiz', 'dispatch@rapidrooter.example', '303-555-0142', '88 Pipe St, Denver CO 80205', '2027-03-31', 1, '4821', 1, 1, 'net 30'],
  );
  assert.ok(q1(`SELECT id FROM audit_events WHERE org_id=? AND entity='vendor' AND entity_id=? AND action='create'`, live, v1.id), 'creation is audited');

  // refusals leave nothing behind and say why
  const dup = await post('/vendors/new', { name: 'rapid rooter plumbing', category: 'plumbing' }, liveCookie);
  assert.equal(dup.status, 200);
  assert.match(dup.text, /already have a vendor named/);
  const badTin = await post('/vendors/new', { name: 'Bad Tin Co', category: 'general', tin_last4: '12' }, liveCookie);
  assert.match(badTin.text, /last four digits/);
  assert.ok(badTin.text.includes('value="Bad Tin Co"'), 'what was typed is kept');
  assert.equal(val<number>('SELECT COUNT(*) FROM vendors WHERE org_id=?', live), 1);

  // edit: correct the contact, drop 1099, mark inactive
  const e = await post(`/vendors/${v1.id}/edit`, {
    name: 'Rapid Rooter Plumbing LLC', category: 'plumbing', contact_name: 'Sam Lee', email: 'office@rapidrooter.example',
    phone: '303-555-0199', address: '90 Pipe St', coi_expiry: '2027-06-30', tin_last4: '9911', w9_on_file: '1', active: '1',
  }, liveCookie);
  assert.equal(e.status, 303);
  const v2 = q1<any>('SELECT * FROM vendors WHERE id=?', v1.id);
  assert.deepEqual(
    [v2.name, v2.contact_name, v2.email, v2.phone, v2.address, v2.coi_expiry, v2.tin_last4, v2.w9_on_file, v2.is_1099, v2.active],
    ['Rapid Rooter Plumbing LLC', 'Sam Lee', 'office@rapidrooter.example', '303-555-0199', '90 Pipe St', '2027-06-30', '9911', 1, 0, 1],
  );
  const aud = q1<any>(`SELECT changes FROM audit_events WHERE org_id=? AND entity='vendor' AND entity_id=? AND action='update'`, live, v1.id);
  assert.ok(aud && /Sam Lee/.test(aud.changes), 'the edit is audited with what changed');

  // another company cannot see or edit it
  assert.equal((await get(base, `/vendors/${v1.id}/edit`, demoCookie)).status, 404);
  const x = await post(`/vendors/${v1.id}/edit`, { name: 'Hijacked', category: 'general', active: '1' }, demoCookie);
  assert.equal(x.status, 404);
  assert.equal(q1<any>('SELECT name FROM vendors WHERE id=?', v1.id).name, 'Rapid Rooter Plumbing LLC');
});

// ---------- item 50 ----------
test('50: staff can give a vendor a portal sign-in, and the vendor can then use the portal', async () => {
  const noEmail = await post('/vendors/new', { name: 'No Email Electric', category: 'electrical', is_1099: '1' }, liveCookie);
  const ne = vendorByName('No Email Electric');
  assert.ok(ne && noEmail.status === 303);
  const refused = await post(`/vendors/${ne.id}/portal-invite`, {}, liveCookie);
  assert.equal(refused.kind, 'err');
  assert.equal(val<number>(`SELECT COUNT(*) FROM users WHERE org_id=? AND kind='vendor'`, live), 0);

  const v = vendorByName('Rapid Rooter Plumbing LLC');
  const inv = await post(`/vendors/${v.id}/portal-invite`, {}, liveCookie);
  assert.equal(inv.kind, 'ok');
  const u = q1<any>(`SELECT * FROM users WHERE org_id=? AND kind='vendor' AND vendor_id=?`, live, v.id);
  assert.ok(u, 'a vendor login exists');
  assert.equal(u.email, 'office@rapidrooter.example');
  assert.equal(u.active, 1);
  assert.equal(val<number>('SELECT COUNT(*) FROM role_assignments WHERE user_id=?', u.id), 0, 'a vendor login holds no staff role');
  const pw = /One-time password \(shown only now\): (\S+)/.exec(inv.flash)?.[1];
  assert.ok(pw && pw !== 'demo1234', 'a real one-time password, never the public demo one');
  assert.match(inv.flash, /nothing was emailed/i, 'no claim that an invite was sent');
  assert.equal(val<number>(`SELECT COUNT(*) FROM outbox_messages WHERE org_id=? AND to_addr=?`, live, u.email), 0);

  // the vendor signs in and sees their own job; staff pages stay closed
  const woId = mkWo(live, liveProp, 'Main stack leak in 101');
  run('UPDATE work_orders SET vendor_id=?, status=? WHERE id=?', v.id, 'assigned', woId);
  const vc = await loginAs(base, u.email, pw!);
  const home = await get(base, '/vendor', vc);
  assert.equal(home.status, 200);
  assert.match(home.text, /Main stack leak in 101/);
  assert.match(home.text, /href="\/vendor\/pos"/);
  assert.notEqual((await get(base, '/vendors', vc)).status, 200);
  const done = await post(`/vendor/wo/${woId}/complete`, { note: 'Replaced the coupling' }, vc);
  assert.equal(done.status, 303);
  assert.equal(q1<any>('SELECT status FROM work_orders WHERE id=?', woId).status, 'completed');

  // reset issues a new password and signs them out; turning access off locks them out
  const reset = await post(`/vendors/${v.id}/portal-reset`, {}, liveCookie);
  const pw2 = /One-time password \(shown only now\): (\S+)/.exec(reset.flash)?.[1];
  assert.ok(pw2 && pw2 !== pw);
  assert.notEqual((await get(base, '/vendor', vc)).status, 200, 'old session is gone');
  await loginAs(base, u.email, pw2!);
  const off = await post(`/vendors/${v.id}/portal-off`, {}, liveCookie);
  assert.equal(off.kind, 'ok');
  assert.equal(q1<any>('SELECT active FROM users WHERE id=?', u.id).active, 0);
  await assert.rejects(loginAs(base, u.email, pw2!));
  // back on for the purchasing tests below
  const again = await post(`/vendors/${v.id}/portal-invite`, {}, liveCookie);
  assert.equal(again.kind, 'ok');
  assert.equal(val<number>(`SELECT COUNT(*) FROM users WHERE kind='vendor' AND vendor_id=?`, v.id), 1, 're-enabling reuses the one login');
});

// ---------- item 46 ----------
test('46: assigning a tech in a live org says where the job is, not that anyone was texted', async () => {
  const woId = mkWo(live, liveProp, 'Disposal jammed');
  const r = await post(`/workorders/${woId}/assign`, { user_id: techId }, liveCookie);
  assert.equal(q1<any>('SELECT assigned_to_user_id FROM work_orders WHERE id=?', woId).assigned_to_user_id, techId, 'the assignment itself is real');
  assert.ok(!/has been notified/.test(r.flash), r.flash);
  assert.match(r.flash, /Terry Tech’s My day queue/);
  assert.match(r.flash, /not connected yet/);
  const msg = q1<any>(`SELECT status FROM outbox_messages WHERE org_id=? AND entity='work_order' AND entity_id=?`, live, woId);
  assert.ok(!msg || msg.status === 'recorded', 'nothing is marked sent');

  const board = await get(base, '/dispatch', liveCookie);
  assert.ok(!board.text.includes('Notify all techs'));
  assert.match(board.text, /Save board summary to Outbox/);
  const n = await post('/dispatch/notify', {}, liveCookie);
  assert.ok(!/Dispatch sent/.test(n.flash), n.flash);
  assert.match(n.flash, /Nothing was texted/);
  assert.equal(val<number>(`SELECT COUNT(*) FROM outbox_messages WHERE org_id=? AND status IN ('sent','opened')`, live), 0);
});

// ---------- item 48 ----------
test('48: labor is not priced at an invented $45/h in a live org', async () => {
  const woId = mkWo(live, liveProp, 'Rehang closet door');
  await post(`/workorders/${woId}/labor`, { user_id: techId, hours: '2' }, liveCookie);
  const first = q1<any>('SELECT * FROM wo_labor WHERE work_order_id=?', woId);
  assert.deepEqual([first.hours, first.rate_cents, first.total_cents], [2, 0, 0], 'hours recorded, no made-up cost');
  const page = await get(base, `/workorders/${woId}`, liveCookie);
  assert.match(page.text, /hours only/);
  assert.match(page.text, /No labor rate is set/);
  assert.match(page.text, /\/admin\/settings\?section=maintenance/);

  const settings = await get(base, '/admin/settings?section=maintenance', liveCookie);
  assert.match(settings.text, /In-house labor rate/);
  setSetting(sysCtx(live), 'maintenance_labor_rate_cents', 6200);
  await post(`/workorders/${woId}/labor`, { user_id: techId, hours: '1.5' }, liveCookie);
  const second = q1<any>('SELECT * FROM wo_labor WHERE work_order_id=? AND rate_cents>0', woId);
  assert.deepEqual([second.rate_cents, second.total_cents], [6200, 9300], 'the operator’s own rate prices the hours');

  // the demo keeps its illustrative rate
  const dWo = mkWo(demo, demoProp, 'Demo job');
  await post(`/workorders/${dWo}/labor`, { hours: '1' }, demoCookie);
  assert.equal(q1<any>('SELECT rate_cents FROM wo_labor WHERE work_order_id=?', dWo).rate_cents, 4500);
});

// ---------- items 54 / 55 ----------
test('54: make-ready tasks cannot be completed while the resident still lives there', async () => {
  const ctx = sysCtx(live);
  const turnId = createTurn(ctx, { unitId: unit.b!, leaseId: lease.b!, moveOut: '2026-08-15' });
  const tasks = q<any>('SELECT * FROM turn_tasks WHERE turn_id=? ORDER BY seq', turnId);
  const v = vendorByName('Rapid Rooter Plumbing LLC');

  const blocked = await post(`/turns/tasks/${tasks[0].id}`, { status: 'done' }, liveCookie);
  assert.equal(blocked.kind, 'err');
  assert.match(blocked.flash, /still occupied until/);
  assert.equal(q1<any>('SELECT status FROM turn_tasks WHERE id=?', tasks[0].id).status, 'pending');
  // planning is still allowed
  const plan = await post(`/turns/tasks/${tasks[1].id}`, { status: 'pending', vendor_id: v.id, actual_cost: '150.00' }, liveCookie);
  assert.equal(plan.kind, 'ok');
  assert.equal(q1<any>('SELECT vendor_id FROM turn_tasks WHERE id=?', tasks[1].id).vendor_id, v.id);
  // nor can the whole checklist be skipped past
  for (const t of tasks) assert.throws(() => advanceTurnTask(ctx, t.id, { status: 'skipped' }), /still occupied/);
  assert.equal(q1<any>('SELECT status FROM units WHERE id=?', unit.b).status, 'notice', 'an occupied home is never published as available');
  assert.match((await get(base, `/turns/${turnId}`, liveCookie)).text, /still occupied until/);

  // move-out day arrives: the job ends the lease and starts the vacancy clock
  const later = sysCtx(live, '2026-08-15');
  run("UPDATE orgs SET business_date='2026-08-15' WHERE id=?", live);
  runJob(later, 'lease_moveouts', '2026-08-15');
  const u1 = q1<any>('SELECT status, vacant_since FROM units WHERE id=?', unit.b);
  assert.deepEqual([u1.status, u1.vacant_since], ['vacant_not_ready', '2026-08-15']);
  for (const t of tasks) advanceTurnTask(later, t.id, { status: 'done' });
  assert.equal(q1<any>('SELECT status FROM turns WHERE id=?', turnId).status, 'ready');
  assert.equal(q1<any>('SELECT status FROM units WHERE id=?', unit.b).status, 'vacant_ready');
  run("UPDATE orgs SET business_date=? WHERE id=?", BD, live);
});

test('54: a unit wrongly marked ready before move-out still gets its vacancy clock at move-out', () => {
  const u = mkUnit(live, liveProp, '104', 'vacant_ready'); // legacy state from before the block
  mkLease(live, liveProp, u, 'Cedar', 'notice', '2026-07-20');
  runJob(sysCtx(live), 'lease_moveouts', BD);
  const row = q1<any>('SELECT status, vacant_since FROM units WHERE id=?', u);
  assert.deepEqual([row.status, row.vacant_since], ['vacant_ready', '2026-07-20']);
});

test('55: a turn task’s actual cost no longer posts a journal entry that AP would post again', async () => {
  const ctx = sysCtx(live);
  const turnId = createTurn(ctx, { unitId: unit.c!, moveOut: '2026-07-10' });
  const tasks = q<any>('SELECT * FROM turn_tasks WHERE turn_id=? ORDER BY seq', turnId);
  const before = jeCount(live);
  const r = await post(`/turns/tasks/${tasks[2].id}`, { status: 'done', actual_cost: '420.00' }, liveCookie);
  assert.equal(r.kind, 'ok');
  const t = q1<any>('SELECT status, actual_cost_cents FROM turn_tasks WHERE id=?', tasks[2].id);
  assert.deepEqual([t.status, t.actual_cost_cents], ['done', 42000], 'the operational figure is kept');
  assert.equal(jeCount(live), before, 'no journal entry is posted');
  assert.equal(val<number>(`SELECT COUNT(*) FROM journal_entries WHERE org_id=? AND source_kind='turn_cost'`, live), 0);
  assert.match((await get(base, `/turns/${turnId}`, liveCookie)).text, /do not post to the books/);
});

// ---------- items 25 / 51 / 26 ----------
let poId = '';
test('25/51: approving a PO in a live org does not claim it was sent, and the PO can be downloaded', async () => {
  const v = vendorByName('No Email Electric');
  run("UPDATE vendors SET email='shop@noemail.example' WHERE id=?", v.id); // has an email, no portal login
  const r = await post('/purchasing/new', {
    vendor_id: v.id, property_id: liveProp, memo: 'Hall lighting', desc_0: 'LED fixture', qty_0: '4', price_0: '50.00',
  }, liveCookie);
  assert.equal(r.status, 303);
  poId = r.location!.split('/').pop()!;
  const po = q1<any>('SELECT * FROM purchase_orders WHERE id=? AND org_id=?', poId, live);
  assert.deepEqual([po.status, po.total_cents], ['approved', 20000]);
  assert.ok(!/sent to the vendor/i.test(r.flash), r.flash);
  assert.match(r.flash, /Nothing was sent/);
  assert.match(r.flash, /Download the PO and send it to No Email Electric yourself/);

  const mail = q1<any>(`SELECT body, status FROM outbox_messages WHERE org_id=? AND entity='purchase_order' AND entity_id=?`, live, poId);
  assert.equal(mail.status, 'recorded', 'the outbox row is not marked sent');
  assert.ok(!/vendor portal/.test(mail.body), 'a vendor with no portal login is not told to use one');

  const page = await get(base, `/purchasing/${poId}`, liveCookie);
  assert.match(page.text, /This order has not been sent to anyone/);
  assert.ok(!page.text.includes('Approve &amp; send'));
  const pdf = await fetch(`${base}/purchasing/${poId}/po.pdf`, { headers: { cookie: liveCookie } });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.equal((await get(base, `/purchasing/${poId}/po.pdf`, demoCookie)).status, 404, 'another company cannot download it');

  // a vendor who really has a portal login is pointed at it — still no "sent"
  const pv = vendorByName('Rapid Rooter Plumbing LLC');
  const r2 = await post('/purchasing/new', { vendor_id: pv.id, property_id: liveProp, desc_0: 'Jetting service', qty_0: '1', price_0: '300.00' }, liveCookie);
  assert.match(r2.flash, /can acknowledge it in their vendor portal/);
  assert.match(r2.flash, /Nothing was emailed/);

  // the demo keeps the simulated send
  const dv = id('vnd');
  insert('vendors', { id: dv, org_id: demo, name: 'Demo Supply', category: 'general', email: 'd@demo.example', diversity_tags: '[]', approved_property_ids: '[]', active: 1, created_at: nowIso() });
  const d = await post('/purchasing/new', { vendor_id: dv, property_id: demoProp, desc_0: 'Widget', qty_0: '1', price_0: '10.00' }, demoCookie);
  assert.equal(d.flash, 'PO approved and sent to the vendor');
});

test('26: staff can enter the vendor’s invoice against a PO and it is 3-way matched', async () => {
  const line = q1<any>('SELECT * FROM purchase_order_lines WHERE po_id=?', poId);
  const form = await get(base, `/purchasing/${poId}/invoice`, liveCookie);
  assert.equal(form.status, 200);
  assert.match(form.text, /Nothing has been received against this order yet/);
  assert.ok(!/OCR/i.test(form.text), 'no pretend document reading');
  assert.ok(!/name="invoice_number"[^>]*value="[^"]/.test(form.text), 'no invented invoice number');

  // blank form is refused; nothing is created
  const empty = await post(`/purchasing/${poId}/invoice`, { invoice_number: 'E-1001', invoice_date: BD, desc_0: line.description }, liveCookie);
  assert.equal(empty.kind, 'err');
  assert.equal(val<number>('SELECT COUNT(*) FROM vendor_invoices WHERE org_id=? AND po_id=?', live, poId), 0);

  // receive everything, then an invoice that agrees with the order matches and reaches AP
  await post(`/purchasing/${poId}/receive`, { [`qty_${line.id}`]: '4' }, liveCookie);
  assert.equal(q1<any>('SELECT status FROM purchase_orders WHERE id=?', poId).status, 'received');
  const ok = await post(`/purchasing/${poId}/invoice`, { invoice_number: 'E-1001', invoice_date: BD, desc_0: line.description, qty_0: '4', price_0: '50.00' }, liveCookie);
  assert.equal(ok.kind, 'ok', ok.flash);
  const inv = q1<any>('SELECT * FROM vendor_invoices WHERE org_id=? AND po_id=? AND invoice_number=?', live, poId, 'E-1001');
  assert.ok(inv, 'the invoice exists in AP');
  assert.equal(inv.total_cents, 20000);
  assert.ok(['approved', 'pending_approval'].includes(inv.status), `routed into AP (${inv.status})`);
  assert.equal(q1<any>('SELECT status FROM invoice_matches WHERE invoice_id=?', inv.id).status, 'matched');

  // the same paper invoice cannot be keyed twice
  const twice = await post(`/purchasing/${poId}/invoice`, { invoice_number: 'e-1001', invoice_date: BD, desc_0: line.description, qty_0: '4', price_0: '50.00' }, liveCookie);
  assert.equal(twice.kind, 'err');
  assert.match(twice.flash, /already entered/);

  // an over-priced invoice is held in the exception queue, not sent on to be paid
  const over = await post(`/purchasing/${poId}/invoice`, { invoice_number: 'E-1002', invoice_date: BD, desc_0: line.description, qty_0: '4', price_0: '58.00' }, liveCookie);
  assert.equal(over.kind, 'err');
  assert.match(over.flash, /does not match/);
  const inv2 = q1<any>('SELECT * FROM vendor_invoices WHERE org_id=? AND invoice_number=?', live, 'E-1002');
  assert.equal(inv2.status, 'draft');
  assert.equal(q1<any>('SELECT status FROM invoice_matches WHERE invoice_id=?', inv2.id).status, 'exception');
  assert.match((await get(base, '/purchasing/exceptions', liveCookie)).text, /E-1002/);

  assert.equal((await post(`/purchasing/${poId}/invoice`, { invoice_number: 'X', invoice_date: BD }, demoCookie)).status, 404);
});

// ---------- item 32 ----------
test('32: the 1099 summary reflects W-9 data staff can now record, and names the right company', async () => {
  const v = vendorByName('No Email Electric');
  const inv = q1<any>(`SELECT * FROM vendor_invoices WHERE org_id=? AND invoice_number='E-1001'`, live);
  const runId = id('apr');
  insert('ap_payment_runs', { id: runId, org_id: live, run_date: BD, method: 'check', total_cents: 90000, created_by: 'test', created_at: nowIso() });
  const payId = id('app');
  insert('ap_payments', {
    id: payId, org_id: live, run_id: runId, invoice_id: inv.id, vendor_id: v.id, property_id: liveProp,
    amount_cents: 90000, method: 'check', check_number: '1001', status: 'issued', created_at: nowIso(),
  });

  const before = await get(base, '/purchasing/1099?year=2026', liveCookie);
  assert.match(before.text, /Missing W-9 — collect before filing/);
  assert.ok(!/1099-eligible rails/.test(before.text));
  assert.match(before.text, new RegExp(`/vendors/${v.id}/edit`), 'the missing W-9 links to where it is recorded');

  await post(`/vendors/${v.id}/edit`, {
    name: v.name, category: v.category, email: 'shop@noemail.example', address: '5 Volt Way', w9_on_file: '1', tin_last4: '7733', is_1099: '1', active: '1',
  }, liveCookie);
  const after = await get(base, '/purchasing/1099?year=2026', liveCookie);
  assert.ok(!/Missing W-9 — collect before filing/.test(after.text), 'recording the W-9 clears the warning');
  assert.match(after.text, /\*\*\*-\*\*-7733/);

  const pdf = await ten99Pdf(sysCtx(live), 2026);
  assert.equal(Buffer.from(pdf).subarray(0, 5).toString(), '%PDF-');
  const src = (await import('node:fs')).readFileSync(new URL('../src/modules/m16_procurement/service.ts', import.meta.url), 'utf8');
  assert.ok(!src.includes('Summit Ridge Management Co.'), 'no hard-coded demo company on a vendor document');
  assert.ok(!src.includes('Vendors paid $600+ on simulated rails'));
  const fileId = await remittanceAdvice(sysCtx(live), payId);
  assert.ok(getFile(fileId), 'remittance advice is generated for the live org');
});

// ---------- item 57 ----------
test('57: utilities work in a live org from typed-in readings and provider bills, through to resident ledgers', async () => {
  // nothing simulated is reachable
  assert.equal(runJob(sysCtx(live), 'utility_cycle', BD).status, 'skipped');
  assert.equal(val<number>('SELECT COUNT(*) FROM meter_reads WHERE org_id=?', live), 0);
  for (const path of ['/utilities', '/utilities/meters', '/utilities/invoices', '/utilities/rubs']) {
    const page = await get(base, path, liveCookie);
    assert.equal(page.status, 200, path);
    assert.ok(!/SubmeterNetwork|utility cycle job/.test(page.text), `${path} promises no automatic feed`);
  }

  // 1. formula: split water by meter reading — refused until meters exist
  const noMeters = await post('/utilities/rubs/config', { property_id: liveProp, service: 'water', method: 'submeter', common_deduct_pct: '10', admin_fee: '3.00', active: '1' }, liveCookie);
  assert.equal(noMeters.kind, 'err');
  assert.equal(val<number>('SELECT COUNT(*) FROM rubs_configs WHERE org_id=?', live), 0);

  // 2. meters, then readings typed in by staff
  const setup = await post('/utilities/meters/setup', { property_id: liveProp, svc_water: '1' }, liveCookie);
  assert.equal(setup.kind, 'ok', setup.flash);
  const unitCount = val<number>('SELECT COUNT(*) FROM units WHERE org_id=? AND property_id=?', live, liveProp)!;
  assert.equal(val<number>(`SELECT COUNT(*) FROM meters WHERE org_id=? AND service='water'`, live), unitCount + 1);
  const meterOf = (u: string): string => q1<any>(`SELECT id FROM meters WHERE unit_id=? AND service='water'`, u).id;
  const enter = await get(base, `/utilities/reads/enter?property=${liveProp}&service=water&month=2026-06`, liveCookie);
  assert.equal(enter.status, 200);
  assert.match(enter.text, /Unit 101/);
  const reads = await post('/utilities/reads/enter', {
    property_id: liveProp, service: 'water', month: '2026-06', [`read_${meterOf(unit.a!)}`]: '3000', [`read_${meterOf(unit.b!)}`]: '1000',
  }, liveCookie);
  assert.equal(reads.kind, 'ok', reads.flash);
  const rd = q<any>(`SELECT r.usage_qty, r.source, r.status FROM meter_reads r WHERE r.org_id=? AND r.month_key='2026-06' ORDER BY r.usage_qty`, live);
  assert.deepEqual(rd.map((x) => [x.usage_qty, x.source, x.status]), [[1000, 'manual', 'ok'], [3000, 'manual', 'ok']]);
  const future = await post('/utilities/reads/enter', { property_id: liveProp, service: 'water', month: '2027-01', [`read_${meterOf(unit.a!)}`]: '5' }, liveCookie);
  assert.equal(future.kind, 'err');

  const cfg = await post('/utilities/rubs/config', { property_id: liveProp, service: 'water', method: 'submeter', common_deduct_pct: '10', admin_fee: '3.00', active: '1' }, liveCookie);
  assert.equal(cfg.kind, 'ok', cfg.flash);
  const c = q1<any>(`SELECT * FROM rubs_configs WHERE org_id=? AND property_id=? AND service='water'`, live, liveProp);
  assert.deepEqual([c.method, c.common_deduct_pct, c.admin_fee_cents, c.active], ['submeter', 10, 300, 1]);

  // 3. staging before the bill exists explains what is missing
  const early = await post('/utilities/rubs/stage', { property_id: liveProp, service: 'water', usage_month: '2026-06' }, liveCookie);
  assert.equal(early.kind, 'err');
  assert.match(early.flash, /Enter the water provider bill for Jun 2026 first/);

  // 4. the provider's bill, keyed in — a real payable, routed through AP approval
  const pv = id('vnd');
  insert('vendors', { id: pv, org_id: live, name: 'City Water Dept', category: 'utility', is_1099: 0, diversity_tags: '[]', approved_property_ids: '[]', active: 1, created_at: nowIso() });
  const bill = await post('/utilities/invoices/new', {
    property_id: liveProp, service: 'water', vendor_id: pv, usage_month: '2026-06', total: '400.00', usage_qty: '4000', invoice_number: 'CW-0626', invoice_date: '2026-07-05',
  }, liveCookie);
  assert.equal(bill.kind, 'ok', bill.flash);
  const upi = q1<any>(`SELECT * FROM utility_provider_invoices WHERE org_id=? AND service='water' AND usage_month='2026-06'`, live);
  assert.deepEqual([upi.total_cents, upi.usage_qty, upi.vendor_id], [40000, 4000, pv]);
  const ap = q1<any>('SELECT * FROM vendor_invoices WHERE id=?', upi.vendor_invoice_id);
  assert.deepEqual([ap.invoice_number, ap.total_cents, ap.source, ap.vendor_id], ['CW-0626', 40000, 'utility', pv]);
  assert.ok(['approved', 'pending_approval'].includes(ap.status));
  const again = await post('/utilities/invoices/new', { property_id: liveProp, service: 'water', vendor_id: pv, usage_month: '2026-06', total: '400.00', invoice_date: '2026-07-05' }, liveCookie);
  assert.equal(again.kind, 'err');
  assert.equal(val<number>('SELECT COUNT(*) FROM utility_provider_invoices WHERE org_id=?', live), 1);

  // 5. stage: $400 less 10% common = $360, split 3000:1000 by reading
  const stage = await post('/utilities/rubs/stage', { property_id: liveProp, service: 'water', usage_month: '2026-06' }, liveCookie);
  assert.equal(stage.kind, 'ok', stage.flash);
  const runRow = q1<any>(`SELECT * FROM rubs_runs WHERE org_id=? AND service='water' AND usage_month='2026-06'`, live);
  assert.deepEqual([runRow.status, runRow.total_cents, runRow.common_cents, runRow.billable_cents], ['preview', 40000, 4000, 36000]);
  const share = (l: string): number => q1<any>('SELECT amount_cents FROM rubs_lines WHERE run_id=? AND lease_id=?', runRow.id, l).amount_cents;
  assert.equal(share(lease.a!), 27000);
  assert.equal(share(lease.b!), 9000);
  assert.equal(val<number>(`SELECT COUNT(*) FROM charges WHERE org_id=? AND kind='utility'`, live), 0, 'staging charges nobody');

  // 6. a wrong preview can be thrown away and staged again; then posted
  const disc = await post(`/utilities/rubs/${runRow.id}/discard`, {}, liveCookie);
  assert.equal(disc.kind, 'ok');
  assert.equal(val<number>('SELECT COUNT(*) FROM rubs_runs WHERE org_id=?', live), 0);
  await post('/utilities/rubs/stage', { property_id: liveProp, service: 'water', usage_month: '2026-06' }, liveCookie);
  const run2 = q1<any>(`SELECT * FROM rubs_runs WHERE org_id=? AND service='water' AND usage_month='2026-06'`, live);
  const posted = await post(`/utilities/rubs/${run2.id}/post`, {}, liveCookie);
  assert.equal(posted.kind, 'ok', posted.flash);
  const charges = q<any>(`SELECT lease_id, amount_cents FROM charges WHERE org_id=? AND kind='utility' ORDER BY amount_cents`, live);
  assert.deepEqual(charges.map((x) => [x.lease_id, x.amount_cents]), [[lease.b, 9300], [lease.a, 27300]], 'each household is charged its share plus the billing fee');
  assert.equal(q1<any>('SELECT status FROM rubs_runs WHERE id=?', run2.id).status, 'posted');
  // posted months are closed to edits and cannot be discarded
  assert.equal((await post(`/utilities/rubs/${run2.id}/discard`, {}, liveCookie)).kind, 'err');
  const late = await post('/utilities/reads/enter', { property_id: liveProp, service: 'water', month: '2026-06', [`read_${meterOf(unit.a!)}`]: '1' }, liveCookie);
  assert.equal(late.kind, 'err');
  assert.equal(q1<any>(`SELECT usage_qty FROM meter_reads WHERE meter_id=? AND month_key='2026-06'`, meterOf(unit.a!)).usage_qty, 3000);

  // another company cannot write into this property
  assert.equal((await post('/utilities/meters/setup', { property_id: liveProp, svc_gas: '1' }, demoCookie)).status, 404);
  assert.equal((await post('/utilities/invoices/new', { property_id: liveProp, service: 'gas', vendor_id: pv, usage_month: '2026-06', total: '1.00' }, demoCookie)).status, 404);
  assert.equal(val<number>(`SELECT COUNT(*) FROM meters WHERE org_id=? AND service='gas'`, live), 0);
});
