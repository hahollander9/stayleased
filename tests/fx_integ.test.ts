import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert, val, run } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword, sysCtx } from '../src/lib/auth.ts';
import { emit } from '../src/lib/events.ts';
import { getSetting, setSetting, SETTING_DEFAULTS } from '../src/lib/settings.ts';
import { runJob } from '../src/lib/jobs.ts';
import { TEMPLATES } from '../src/lib/templates.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { createCharge } from '../src/modules/m8_receivables/service.ts';
import { assessLateFees, waiveLateFee, depositHeld, lateFeeCandidates } from '../src/modules/m8_receivables/payments.ts';
import { intakeLead, messageLead } from '../src/modules/m3_crm/service.ts';
import { deleteProperty, clearOrgData } from '../src/modules/m2_portfolio/service.ts';
import { reverseImport } from '../src/modules/setup/import_reverse.ts';
import { portalInviteNote } from '../src/modules/setup/import.ts';
import { SPECS } from '../src/modules/m1_admin/settings_spec.ts';
import { startTestServer, loginAs, get } from './harness.ts';

/** Integration loose ends from the "run it as a real company" audit: a live
 * organization is never told something was delivered, never charged a fee it
 * did not choose, and can enter its own market comps. Every test ends on a
 * database row or on the words the operator reads. */

const BD = '2026-08-10';
const MK = '2026-08';
const sfx = id('x').slice(-6);

let base: string;
let close: () => void;
let liveOrg: string; let demoOrg: string; let otherOrg: string;
let adminLive: string; let adminDemo: string; let adminOther: string;
let cookie: string;

function mkOrg(kind: 'demo' | 'live', tag: string): { org: string; email: string } {
  const org = id('org');
  insert('orgs', { id: org, name: `Integ ${tag} ${sfx}`, slug: `integ-${tag}-${sfx}`, kind, business_date: BD, created_at: nowIso() });
  ensureCoa(org);
  const uid = id('usr');
  const email = `admin-integ-${tag}-${sfx}@example.test`;
  insert('users', { id: uid, org_id: org, email, name: `Admin ${tag}`, kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso() });
  insert('role_assignments', { id: id('ra'), org_id: org, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  return { org, email };
}

interface Fx { lease: string; prop: string; unit: string; slug: string }

function mkLease(org: string, extra: Record<string, unknown> = {}): Fx {
  const n = id('n').slice(-6);
  const prop = id('prp');
  const slug = `integ-prop-${n}`;
  insert('properties', { id: prop, org_id: org, name: `Integ prop ${n}`, slug, type: 'multifamily', address1: '1 Test St', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso() });
  const unit = id('unt');
  insert('units', { id: unit, org_id: org, property_id: prop, unit_number: `I-${n}`, floor: 1, sqft: 800, status: 'occupied', market_rent_cents: 160000, amenities: '[]', created_at: nowIso() });
  const lease = id('lse');
  insert('leases', {
    id: lease, org_id: org, property_id: prop, unit_id: unit, household_name: `Integ ${n}`,
    status: 'active', start_date: '2026-01-01', end_date: '2026-12-31', move_in_date: '2026-01-01',
    rent_cents: 160000, deposit_cents: 0, term_months: 12, created_at: nowIso(), ...extra,
  });
  const resident = id('res');
  insert('residents', { id: resident, org_id: org, property_id: prop, first_name: 'Pat', last_name: n, email: `pat-${n}@example.test`, kind: 'adult', created_at: nowIso() });
  insert('household_members', { id: id('hm'), org_id: org, lease_id: lease, resident_id: resident, role: 'primary', created_at: nowIso() });
  return { lease, prop, unit, slug };
}

const ctxOf = (org: string) => sysCtx(org, BD);
const rent = (org: string, fx: Fx): string =>
  createCharge(ctxOf(org), { leaseId: fx.lease, kind: 'rent', label: 'Rent', amountCents: 160000, date: '2026-08-01', dueDate: '2026-08-01', monthKey: MK, source: 'recurring' });
const lateFees = (fx: Fx): number => val<number>(`SELECT COUNT(*) FROM charges WHERE lease_id=? AND kind='late_fee'`, fx.lease) || 0;

/** POST a form and read the flash the redirect carries */
async function postFlash(path: string, body: Record<string, string>, ck?: string): Promise<{ status: number; location: string | null; flash: string }> {
  const resp = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, ...(ck ? { cookie: ck } : {}) },
    body: new URLSearchParams(body).toString(), redirect: 'manual',
  });
  const m = /sl_fl=([^;]+)/.exec(resp.headers.get('set-cookie') || '');
  return { status: resp.status, location: resp.headers.get('location'), flash: m ? decodeURIComponent(m[1]!) : '' };
}

before(async () => {
  db();
  ({ org: liveOrg, email: adminLive } = mkOrg('live', 'live'));
  ({ org: demoOrg, email: adminDemo } = mkOrg('demo', 'demo'));
  ({ org: otherOrg, email: adminOther } = mkOrg('live', 'other'));
  const s = await startTestServer(); base = s.base; close = s.close;
  // after boot: the modules that listen are loaded
  emit(sysCtx(liveOrg), 'org.created', 'org', liveOrg, { name: 'Integ live' });
  emit(sysCtx(demoOrg), 'org.created', 'org', demoOrg, { name: 'Integ demo' });
  cookie = await loginAs(base, adminLive);
});
after(() => close());

// ---------- A. honest flashes ----------

test('A: a dunning reminder in a live organization is saved, not "sent"', async () => {
  const fx = mkLease(liveOrg);
  rent(liveOrg, fx);
  const r = await postFlash(`/delinquency/${fx.lease}/dunning`, { template: 'dunning_friendly' }, cookie);
  assert.equal(r.status, 303);
  assert.match(r.flash, /Saved to the Outbox — email and text delivery are not connected yet/);
  assert.doesNotMatch(r.flash, /Reminder sent/);
  const msg = q1<any>(`SELECT status FROM outbox_messages WHERE org_id=? AND entity='lease' AND entity_id=? ORDER BY created_at DESC`, liveOrg, fx.lease);
  assert.equal(msg?.status, 'recorded');

  const d = mkLease(demoOrg);
  rent(demoOrg, d);
  const demo = await postFlash(`/delinquency/${d.lease}/dunning`, { template: 'dunning_friendly' }, await loginAs(base, adminDemo));
  assert.match(demo.flash, /^ok\|Reminder sent \(see Message console\)\.$/, 'the demo wording is unchanged');
});

test('A: the lockbox screen is not offered as a (simulated) lockbox in a live organization', async () => {
  const page = await get(base, '/receivables/lockbox', cookie);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /simulated/i);
  assert.match(page.text, /Record a batch of checks/);
  assert.match(page.text, /No bank lockbox is connected/);
  const demo = await get(base, '/receivables/lockbox', await loginAs(base, adminDemo));
  assert.match(demo.text, /Import a lockbox batch \(simulated\)/);
});

test('A: lead message, tour and quote flashes do not claim delivery in a live organization', async () => {
  const fx = mkLease(liveOrg);
  const { leadId } = intakeLead(ctxOf(liveOrg), { propertyId: fx.prop, firstName: 'Lee', lastName: 'Flash', email: `lee-${sfx}@example.test`, source: 'walk_in' });
  const m = await postFlash(`/leads/${leadId}/message`, { channel: 'email', subject: 'Hello', body: 'Following up' }, cookie);
  assert.match(m.flash, /^ok\|Saved to the Outbox — email and text delivery are not connected yet\.$/);
  const t = await postFlash(`/leads/${leadId}/tour`, { date: '2026-08-12', start_time: '10:00', type: 'in_person' }, cookie);
  assert.match(t.flash, /^ok\|Tour booked\. The confirmation was not emailed/, t.flash);
});

test('A: the public tour form tells a live organization’s prospect the office will be in touch', async () => {
  const fx = mkLease(liveOrg);
  run(`UPDATE properties SET marketing=? WHERE id=?`, JSON.stringify({ published: true }), fx.prop);
  const page = await get(base, `/p/${fx.slug}`);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /instant email confirmation/);
  assert.match(page.text, /leasing office will be in touch to confirm your tour/);
  const r = await postFlash(`/p/${fx.slug}/tour`, { first_name: 'Vi', last_name: 'Sitor', email: `vi-${sfx}@example.test`, date: '2026-08-12', start_time: '11:00', type: 'in_person' });
  assert.equal(r.status, 303);
  assert.doesNotMatch(r.flash, /for your confirmation/);
  assert.match(r.flash, /^ok\|.*leasing office will be in touch/, r.flash);
  assert.ok(q1('SELECT id FROM leads WHERE org_id=? AND email=?', liveOrg, `vi-${sfx}@example.test`), 'the lead was still captured');
});

test('A: import summaries say logins were created, not that invites were sent', () => {
  assert.equal(portalInviteNote(3, true), '3 portal logins created — invitations are saved in the Outbox, not emailed');
  assert.equal(portalInviteNote(1, true), '1 portal login created — invitations are saved in the Outbox, not emailed');
  assert.equal(portalInviteNote(3, false), '3 portal invites sent', 'the demo wording e2e pins');
});

// ---------- B. lead status ----------

test('B: a first email in a live organization does not mark the lead contacted', () => {
  const fx = mkLease(liveOrg);
  const { leadId } = intakeLead(ctxOf(liveOrg), { propertyId: fx.prop, firstName: 'Nia', lastName: 'New', email: `nia-${sfx}@example.test`, source: 'walk_in' });
  run(`UPDATE leads SET status='new' WHERE id=?`, leadId);
  messageLead(ctxOf(liveOrg), leadId, 'email', 'Hi', 'Welcome');
  assert.equal(q1<any>('SELECT status FROM leads WHERE id=?', leadId)!.status, 'new');
  assert.equal(q1<any>(`SELECT status FROM outbox_messages WHERE org_id=? AND entity='lead' AND entity_id=?`, liveOrg, leadId)!.status, 'recorded');

  const d = mkLease(demoOrg);
  const demoLead = intakeLead(ctxOf(demoOrg), { propertyId: d.prop, firstName: 'Dee', lastName: 'Demo', email: `dee-${sfx}@example.test`, source: 'walk_in' }).leadId;
  run(`UPDATE leads SET status='new' WHERE id=?`, demoLead);
  messageLead(ctxOf(demoOrg), demoLead, 'email', 'Hi', 'Welcome');
  assert.equal(q1<any>('SELECT status FROM leads WHERE id=?', demoLead)!.status, 'contacted', 'the demo still moves the stage');
});

// ---------- C. connections ----------

test('C: the connections page no longer says residents see messages in their portal', async () => {
  const page = await get(base, '/setup/connections', cookie);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /Residents see everything in their portal/);
  assert.match(page.text, /resident portal does not show messages yet/);
});

// ---------- D. manual comps ----------

test('D: a live organization adds a comparable, records its rent and removes it', async () => {
  const fx = mkLease(liveOrg);
  insert('floorplans', { id: id('fp'), org_id: liveOrg, property_id: fx.prop, name: 'A1', beds: 1, baths: 1, sqft: 700, market_rent_cents: 150000, created_at: nowIso() });
  const empty = await get(base, `/pricing/comps?property=${fx.prop}`, cookie);
  assert.equal(empty.status, 200);
  assert.doesNotMatch(empty.text, /market simulator/i);
  assert.match(empty.text, /No comparable communities yet/);
  assert.match(empty.text, /Add comparable/);
  assert.equal(val<number>('SELECT COUNT(*) FROM comp_sets WHERE org_id=?', liveOrg), 0, 'nothing was invented');

  const add = await postFlash('/pricing/comps', { property: fx.prop, name: 'Maple Court', distance_miles: '0.8', year_built: '1998', notes: '' }, cookie);
  assert.match(add.flash, /^ok\|/);
  const comp = q1<any>('SELECT * FROM comp_sets WHERE org_id=? AND property_id=?', liveOrg, fx.prop);
  assert.equal(comp?.name, 'Maple Court');
  assert.equal(comp.distance_miles, 0.8);
  assert.equal(comp.year_built, 1998);
  assert.ok(q1(`SELECT id FROM audit_events WHERE org_id=? AND entity='comp_set' AND entity_id=? AND action='create'`, liveOrg, comp.id), 'audited');
  const dup = await postFlash('/pricing/comps', { property: fx.prop, name: 'maple court' }, cookie);
  assert.match(dup.flash, /^err\|/);

  const obs = await postFlash(`/pricing/comps/${comp.id}/observe`, { beds: '1', rent: '1,575.00', concession_note: 'one month free' }, cookie);
  assert.match(obs.flash, /^ok\|Rent recorded for Maple Court/);
  const o = q1<any>('SELECT * FROM comp_observations WHERE org_id=? AND comp_id=?', liveOrg, comp.id);
  assert.equal(o.rent_cents, 157500);
  assert.equal(o.beds, 1);
  assert.equal(o.month_key, MK);
  assert.equal(o.source, 'manual');
  const bad = await postFlash(`/pricing/comps/${comp.id}/observe`, { beds: '1', rent: 'lots' }, cookie);
  assert.match(bad.flash, /^err\|Enter the monthly rent/);
  assert.equal(val<number>('SELECT COUNT(*) FROM comp_observations WHERE comp_id=?', comp.id), 1);

  const page = await get(base, `/pricing/comps?property=${fx.prop}&beds=1`, cookie);
  assert.match(page.text, /Maple Court/);
  assert.match(page.text, /\$1,575\.00/);

  // another organization can neither see nor change it
  const other = await loginAs(base, adminOther);
  assert.equal((await postFlash(`/pricing/comps/${comp.id}/observe`, { beds: '1', rent: '1.00' }, other)).status, 404);
  assert.equal((await postFlash(`/pricing/comps/${comp.id}/remove`, {}, other)).status, 404);
  assert.equal((await postFlash('/pricing/comps', { property: fx.prop, name: 'Intruder' }, other)).status, 404);
  assert.equal(q1<any>('SELECT rent_cents FROM comp_observations WHERE comp_id=?', comp.id)!.rent_cents, 157500);
  assert.equal(q1<any>('SELECT active FROM comp_sets WHERE id=?', comp.id)!.active, 1);

  const rm = await postFlash(`/pricing/comps/${comp.id}/remove`, {}, cookie);
  assert.match(rm.flash, /^ok\|/);
  assert.equal(q1<any>('SELECT active FROM comp_sets WHERE id=?', comp.id)!.active, 0);
});

test('D: adding a comparable needs the pricing approval permission', async () => {
  const fx = mkLease(liveOrg);
  const uid = id('usr');
  const agent = `agent-integ-${sfx}@example.test`;
  insert('users', { id: uid, org_id: liveOrg, email: agent, name: 'Agent', kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso() });
  insert('role_assignments', { id: id('ra'), org_id: liveOrg, user_id: uid, role: 'LEASING_AGENT', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  const r = await postFlash('/pricing/comps', { property: fx.prop, name: 'Nope Court' }, await loginAs(base, agent));
  assert.equal(r.status, 403);
  assert.equal(val<number>(`SELECT COUNT(*) FROM comp_sets WHERE org_id=? AND name='Nope Court'`, liveOrg), 0);
});

test('D: loss to lease shows a dash when no lease is in place', async () => {
  const n = id('n').slice(-6);
  const prop = id('prp');
  insert('properties', { id: prop, org_id: liveOrg, name: `Empty ${n}`, slug: `integ-empty-${n}`, type: 'multifamily', address1: '2 Test St', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso() });
  insert('floorplans', { id: id('fp'), org_id: liveOrg, property_id: prop, name: 'A1', beds: 1, baths: 1, sqft: 700, market_rent_cents: 150000, created_at: nowIso() });
  const page = await get(base, `/pricing/analytics?property=${prop}`, cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /needs leases in place to compare/);
  assert.doesNotMatch(page.text, /Loss to lease<\/[a-z]+>\s*<[^>]+>\s*0%/);
});

// ---------- E. payment plan template ----------

test('E: the payment plan confirmation does not promise an automatic charge', () => {
  const body = TEMPLATES.payment_plan_confirmed!.body;
  assert.doesNotMatch(body, /charged to your saved payment method/);
  assert.match(body, /Please make each payment by its due date\./);
});

// ---------- F. deposit on hand ----------

test('F: a hand-entered deposit on hand counts as held without the import marker', () => {
  const fx = mkLease(liveOrg, { deposit_cents: 120000, deposit_on_hand: 1 });
  assert.equal(q1<any>('SELECT import_batch_id FROM leases WHERE id=?', fx.lease)!.import_batch_id, null);
  assert.equal(depositHeld(ctxOf(liveOrg), fx.lease), 120000);
  const none = mkLease(liveOrg, { deposit_cents: 120000 });
  assert.equal(depositHeld(ctxOf(liveOrg), none.lease), 0, 'a deposit that was never collected is not held');
});

// ---------- G. fee_waivers cleanup ----------

function waivedFee(org: string, fx: Fx, batchId?: string): string {
  const fee = createCharge(ctxOf(org), { leaseId: fx.lease, kind: 'late_fee', label: 'Late fee', amountCents: 5000, date: BD, dueDate: BD, monthKey: MK, source: 'late_fee' });
  waiveLateFee(ctxOf(org), fee, 'first late payment');
  if (batchId) run('UPDATE charges SET import_batch_id=? WHERE lease_id=?', batchId, fx.lease);
  return fee;
}
const waivers = (org: string): number => val<number>('SELECT COUNT(*) FROM fee_waivers WHERE org_id=?', org) || 0;

test('G: deleting a property deletes the fee waivers on its charges', () => {
  const { org } = mkOrg('live', `g1${id('n').slice(-4)}`);
  const keep = mkLease(org); const gone = mkLease(org);
  const keptFee = waivedFee(org, keep); waivedFee(org, gone);
  assert.equal(waivers(org), 2);
  deleteProperty(ctxOf(org), gone.prop, { force: true });
  assert.equal(waivers(org), 1);
  assert.ok(q1('SELECT id FROM fee_waivers WHERE org_id=? AND charge_id=?', org, keptFee), 'the other property’s waiver stays');
});

test('G: removing an import deletes the fee waivers on the charges it removes', () => {
  const { org } = mkOrg('live', `g2${id('n').slice(-4)}`);
  const keep = mkLease(org); const imp = mkLease(org);
  const batch = id('imp');
  insert('import_batches', { id: batch, org_id: org, kind: 'balances', filename: 'b.csv', status: 'applied', created_by: 'test', created_at: nowIso(), applied_at: nowIso() });
  waivedFee(org, keep); waivedFee(org, imp, batch);
  assert.equal(waivers(org), 2);
  reverseImport(ctxOf(org), q1<any>('SELECT * FROM import_batches WHERE id=?', batch), { force: true });
  assert.equal(val<number>('SELECT COUNT(*) FROM charges WHERE org_id=? AND import_batch_id=?', org, batch), 0);
  assert.equal(waivers(org), 1);
  assert.equal(val<number>('SELECT COUNT(*) FROM fee_waivers fw WHERE fw.org_id=? AND NOT EXISTS (SELECT 1 FROM charges c WHERE c.id=fw.charge_id)', org), 0, 'no orphan');
});

test('G: clearing an organization leaves no fee waivers behind', () => {
  const { org } = mkOrg('live', `g3${id('n').slice(-4)}`);
  waivedFee(org, mkLease(org)); waivedFee(org, mkLease(org));
  const before = waivers(liveOrg);
  clearOrgData(ctxOf(org));
  assert.equal(waivers(org), 0);
  assert.equal(val<number>('SELECT COUNT(*) FROM charges WHERE org_id=?', org), 0);
  assert.equal(waivers(liveOrg), before, 'another organization is untouched');
});

// ---------- H. automatic late fees ----------

test('H: a new live organization starts with automatic late fees off; the demo default is on', () => {
  assert.equal(SETTING_DEFAULTS.late_fees_enabled, true);
  assert.equal(getSetting<boolean>(sysCtx(liveOrg), 'late_fees_enabled'), false);
  assert.equal(getSetting<boolean>(sysCtx(demoOrg), 'late_fees_enabled'), true);
  const spec = SPECS.find((s) => s.key === 'late_fees_enabled');
  assert.equal(spec?.label, 'Charge late fees automatically');
  assert.equal(spec?.group, SPECS.find((s) => s.key === 'late_fee_policy')!.group);
  assert.ok(spec!.help.length > 20);
});

test('H: the nightly job charges nothing while the switch is off, and staff can still assess by hand', async () => {
  const fx = mkLease(liveOrg);
  rent(liveOrg, fx);
  assert.ok(lateFeeCandidates(ctxOf(liveOrg), BD, fx.prop).length === 1, 'the household is late under the default policy');
  const off = runJob(ctxOf(liveOrg), 'late_fees', BD);
  assert.equal(off.status, 'ok');
  assert.match(off.summary, /automatic late fees are off/);
  assert.equal(lateFees(fx), 0);

  const page = await get(base, '/receivables/latefees', cookie);
  assert.match(page.text, /Automatic late fees are off/);
  assert.match(page.text, /href="\/admin\/settings\?section=rent-fees-and-payments"/);

  assessLateFees(ctxOf(liveOrg), BD, fx.prop);
  assert.equal(lateFees(fx), 1, 'manual assessment is not gated');

  const fx2 = mkLease(liveOrg);
  rent(liveOrg, fx2);
  setSetting(ctxOf(liveOrg), 'late_fees_enabled', true);
  try {
    runJob(ctxOf(liveOrg), 'late_fees', BD);
    assert.equal(lateFees(fx2), 1, 'on again, the job assesses');
    assert.doesNotMatch((await get(base, '/receivables/latefees', cookie)).text, /Automatic late fees are off/);
  } finally {
    setSetting(ctxOf(liveOrg), 'late_fees_enabled', false);
  }
});

test('H: the demo organization’s nightly job is unchanged', () => {
  const fx = mkLease(demoOrg);
  rent(demoOrg, fx);
  runJob(ctxOf(demoOrg), 'late_fees', BD);
  assert.equal(lateFees(fx), 1);
});

test('H: the settings page offers the switch in plain language', async () => {
  const page = await get(base, '/admin/settings?section=rent-fees-and-payments', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Charge late fees automatically/);
});
