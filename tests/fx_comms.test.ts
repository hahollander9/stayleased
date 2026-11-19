import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert, run, val } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword, sysCtx } from '../src/lib/auth.ts';
import { setSetting } from '../src/lib/settings.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { sendEmail, deliveryNote, deliveryLabel, RECORDED } from '../src/lib/sim/messaging.ts';
import { commPrefs, renderMerge, scheduleMass } from '../src/modules/m15_comms/service.ts';
import { submitPolicy, enrollMaster, complianceSweep, leaseCompliance } from '../src/modules/m12_insurance/service.ts';
import {
  ensureCompSets, generateCompObservations, compAverage, addCompSet, recordCompObservation, removeCompSet,
  runPricingEngine, revenueAnalytics,
} from '../src/modules/m13_pricing/service.ts';
import { reportDef, resolveParams, processResult, reportCsv } from '../src/modules/m14_reports/engine.ts';
import { startTestServer, loginAs, get, post } from './harness.ts';

/** Regression guards for the "walk it as a real company" findings in comms,
 * reports, pricing comps and insurance. Each test is one finding and asserts
 * what is in the database afterwards. Own live + demo fixture. */

interface Fx { org: string; email: string; uid: string; prop: string; unit: string; lease: string; resident: string; residentEmail: string }
let base: string;
let close: () => void;
let live: Fx;
let demo: Fx;
let cookieLive: string;
let cookieDemo: string;
const sfx = id('x').slice(-6);

function mkOrg(kind: 'demo' | 'live'): Fx {
  const org = id('org');
  insert('orgs', { id: org, name: `Comms ${kind} ${sfx}`, slug: `fxc-${kind}-${sfx}`, kind, business_date: '2026-07-26', created_at: nowIso() });
  ensureCoa(org);
  const uid = id('usr');
  const email = `admin-fxc-${kind}-${sfx}@example.test`;
  insert('users', { id: uid, org_id: org, email, name: `Admin ${kind}`, kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso() });
  insert('role_assignments', { id: id('ra'), org_id: org, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  const prop = id('prp');
  insert('properties', { id: prop, org_id: org, name: `Maple Court ${kind}`, slug: `fxc-prop-${kind}-${sfx}`, type: 'multifamily', address1: '1 Test St', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso() });
  const fp = id('fp');
  insert('floorplans', { id: fp, org_id: org, property_id: prop, name: 'A1', beds: 1, baths: 1, sqft: 700, market_rent_cents: 150000, created_at: nowIso() });
  const unit = id('unt');
  insert('units', { id: unit, org_id: org, property_id: prop, floorplan_id: fp, unit_number: '101', floor: 1, sqft: 700, status: 'occupied', market_rent_cents: 150000, amenities: '[]', created_at: nowIso() });
  // a second, vacant unit so the pricing engine has something to price
  insert('units', { id: id('unt'), org_id: org, property_id: prop, floorplan_id: fp, unit_number: '102', floor: 1, sqft: 700, status: 'vacant_ready', market_rent_cents: 150000, amenities: '[]', created_at: nowIso() });
  const lease = id('lse');
  insert('leases', { id: lease, org_id: org, property_id: prop, unit_id: unit, household_name: 'Rivera household', status: 'active', start_date: '2026-01-01', end_date: '2026-12-31', move_in_date: '2026-01-01', rent_cents: 150000, deposit_cents: 150000, term_months: 12, created_at: nowIso() });
  const resident = id('res');
  const residentEmail = `rivera-${kind}-${sfx}@example.test`;
  insert('residents', { id: resident, org_id: org, property_id: prop, first_name: 'Ana', last_name: 'Rivera', email: residentEmail, phone: '+13035550101', kind: 'adult', created_at: nowIso() });
  insert('household_members', { id: id('hm'), org_id: org, lease_id: lease, resident_id: resident, role: 'primary', created_at: nowIso() });
  return { org, email, uid, prop, unit, lease, resident, residentEmail };
}

before(async () => {
  db();
  live = mkOrg('live');
  demo = mkOrg('demo');
  const s = await startTestServer();
  base = s.base; close = s.close;
  cookieLive = await loginAs(base, live.email);
  cookieDemo = await loginAs(base, demo.email);
});
after(() => close());

const outbox = (org: string): any[] => q<any>('SELECT * FROM outbox_messages WHERE org_id=? ORDER BY created_at', org);

// ---------- items 2, 21, 34, 47, 58, 59, 73: delivery honesty ----------

test('a live org stores every outbound message as recorded — never sent or opened', () => {
  const ctx = sysCtx(live.org);
  for (let i = 0; i < 40; i++) {
    sendEmail(ctx, { to: live.residentEmail, toName: 'Ana Rivera', subject: `Notice ${i}`, body: '<p>Your balance is due.</p>', propertyId: live.prop, personId: live.resident, templateKey: 'late_notice' });
  }
  const rows = outbox(live.org).filter((m) => m.direction === 'out');
  assert.equal(rows.length, 40);
  assert.deepEqual([...new Set(rows.map((m) => m.status))], [RECORDED], 'no fabricated sent/opened receipts');
  assert.match(deliveryNote(ctx), /Saved to the Outbox/);
  assert.match(deliveryNote(ctx), /not connected/);
  assert.ok(!/\bsent\b/i.test(deliveryNote(ctx)));
  assert.equal(deliveryLabel(RECORDED), 'Saved — not delivered');
});

test('the demo keeps its simulated sent / opened statuses', () => {
  const ctx = sysCtx(demo.org);
  for (let i = 0; i < 40; i++) {
    sendEmail(ctx, { to: demo.residentEmail, toName: 'Ana Rivera', subject: `Notice ${i}`, body: '<p>Hello</p>', propertyId: demo.prop, personId: demo.resident });
  }
  const statuses = new Set(outbox(demo.org).map((m) => m.status));
  assert.ok(statuses.has('sent') || statuses.has('opened'));
  assert.ok(!statuses.has(RECORDED));
  assert.ok(statuses.has('opened'), 'the open simulation still runs for the demo');
  assert.match(deliveryNote(ctx), /^Sent/);
});

test('the Outbox says plainly that a live message was saved and not delivered', async () => {
  const list = await get(base, '/dev/messages', cookieLive);
  assert.equal(list.status, 200);
  assert.ok(list.text.includes('Saved — not delivered'), 'list labels the status');
  assert.ok(/not connected/i.test(list.text));
  const m = outbox(live.org)[0];
  const one = await get(base, `/dev/messages/${m.id}`, cookieLive);
  assert.equal(one.status, 200);
  assert.ok(one.text.includes('Saved — not delivered'));
  assert.ok(!one.text.includes('Simulate inbound reply'), 'no simulated-reply card for a live org');
});

test('a reply from the inbox in a live org is recorded, and the flash does not claim it was sent', async () => {
  const thread = q1<any>('SELECT id FROM threads WHERE org_id=? AND person_id=?', live.org, live.resident);
  assert.ok(thread, 'sending threaded the conversation');
  const before = outbox(live.org).length;
  const r = await post(base, `/inbox/${thread.id}/reply`, { channel: 'email', subject: 'Re: balance', body: 'We can set up a plan.' }, cookieLive);
  assert.equal(r.status, 303);
  const rows = outbox(live.org);
  assert.equal(rows.length, before + 1);
  assert.equal(rows.find((m) => m.subject === 'Re: balance')?.status, RECORDED);
  const page = await get(base, r.location!, cookieLive);
  assert.ok(!/Reply sent/.test(page.text));
});

// ---------- item 60: simulated inbound reply ----------

test('a live org cannot receive an invented inbound reply', async () => {
  const thread = q1<any>('SELECT id FROM threads WHERE org_id=? AND person_id=?', live.org, live.resident);
  const msg = outbox(live.org)[0];
  const a = await post(base, `/inbox/${thread.id}/simulate-reply`, { body: 'fake reply' }, cookieLive);
  const b = await post(base, `/dev/messages/${msg.id}/reply`, { body: 'fake reply' }, cookieLive);
  assert.ok(a.status >= 300 && b.status >= 300);
  assert.equal(val<number>(`SELECT COUNT(*) FROM outbox_messages WHERE org_id=? AND direction='in'`, live.org), 0);
  const page = await get(base, `/inbox/${thread.id}`, cookieLive);
  assert.equal(page.status, 200);
  assert.ok(!page.text.includes('simulate-reply'), 'the card is not offered');
});

// ---------- item 67: mass message ----------

test('a live mass message is recorded per recipient, texts need consent, links are absolute, money is formatted', async () => {
  const ctx = sysCtx(live.org);
  // a brand-new person in a live org starts opted OUT of texts
  const prefs = commPrefs(live.org, 'resident', live.resident);
  assert.equal(prefs.smsOptout, true);
  assert.equal(prefs.emailOptout, false);
  assert.equal(commPrefs(demo.org, 'resident', demo.resident).smsOptout, false, 'demo unchanged');

  const mid = scheduleMass(ctx, {
    filters: { propertyId: live.prop }, subject: 'Water shut-off Tuesday', body: '<p>Hi {{first_name}}, your balance is {{balance}}.</p>',
    smsBody: 'Water off Tuesday 9-11', channels: ['email', 'sms'], scheduledFor: '2026-07-30',
  });
  const r = await post(base, `/comms/mass/${mid}/send-now`, {}, cookieLive);
  assert.equal(r.status, 303);
  const recips = q<any>('SELECT * FROM mass_recipients WHERE mass_id=?', mid);
  const email = recips.find((x) => x.channel === 'email');
  const sms = recips.find((x) => x.channel === 'sms');
  assert.equal(email.status, RECORDED);
  assert.ok(String(sms.status).startsWith('skipped'), `text skipped without consent, got ${sms.status}`);
  assert.equal(q1<any>('SELECT status, sent_count FROM mass_messages WHERE id=?', mid)!.status, RECORDED);
  const ob = q1<any>('SELECT * FROM outbox_messages WHERE id=?', email.outbox_id);
  assert.equal(ob.status, RECORDED);
  assert.match(ob.body, /href="https?:\/\/[^"]+\/u\/[^"]+"/, 'unsubscribe link is absolute');
  const page = await get(base, r.location!, cookieLive);
  assert.ok(!/\b1 sent\b/.test(page.text));
  assert.ok(/not delivered/i.test(page.text));

  assert.equal(renderMerge(ctx, '{{balance}}', { leaseId: live.lease, residentId: live.resident, name: 'Ana Rivera', unit: '101', email: null, phone: null, propertyId: live.prop, balanceCents: 295050 } as any), '$2,950.50');

  // staff record consent on the thread → the person can be texted
  const thread = q1<any>('SELECT id FROM threads WHERE org_id=? AND person_id=?', live.org, live.resident);
  const c = await post(base, `/inbox/${thread.id}/consent`, { email_ok: '1', sms_ok: '1' }, cookieLive);
  assert.equal(c.status, 303);
  assert.equal(commPrefs(live.org, 'resident', live.resident).smsOptout, false);
  assert.ok(q1(`SELECT id FROM audit_log WHERE org_id=? AND entity='comm_prefs' AND action='consent'`, live.org), 'consent change is audited');
});

// ---------- item 68: scheduled report delivery ----------

test('running a saved report in a live org files it and says email is not connected', async () => {
  const s = await post(base, '/reports/rent_roll/save', { params: JSON.stringify({ property: live.prop }) }, cookieLive);
  assert.equal(s.status, 303);
  const saved = q1<any>('SELECT * FROM saved_reports WHERE org_id=? ORDER BY created_at DESC', live.org);
  const r = await post(base, `/reports/saved/${saved.id}/deliver`, {}, cookieLive);
  assert.equal(r.status, 303);
  const file = q1<any>(`SELECT * FROM files WHERE org_id=? AND entity='saved_report' AND entity_id=?`, live.org, saved.id);
  assert.ok(file, 'the CSV really was generated and stored');
  const ob = q1<any>(`SELECT * FROM outbox_messages WHERE org_id=? AND template_key='scheduled_report'`, live.org);
  assert.equal(ob.status, RECORDED);
  assert.match(ob.body, new RegExp(`href="https?://[^"]+/f/${file.id}"`), 'attachment link is absolute');
  const page = await get(base, r.location!, cookieLive);
  assert.ok(!/Delivered —/.test(page.text));
  assert.ok(/Email delivery is not connected/i.test(page.text));
  assert.ok(page.text.includes(`/f/${file.id}`), 'the filed run is downloadable from the saved report');
});

// ---------- item 69: balance sheet grand total ----------

test('the balance sheet has section subtotals and no summed grand total', async () => {
  const ctx = sysCtx(live.org);
  // assets 1,000 = liabilities 400 + equity 600
  const acct = (type: string): string => q1<any>('SELECT code FROM gl_accounts WHERE org_id=? AND type=? ORDER BY code LIMIT 1', live.org, type)!.code;
  const je = id('je');
  insert('journal_entries', { id: je, org_id: live.org, property_id: live.prop, date: '2026-07-01', basis: 'accrual', memo: 'opening', source: 'manual', created_by: 'test', posted_at: nowIso() } as any);
  const line = (code: string, d: number, c: number): void => { insert('journal_lines', { id: id('jl'), org_id: live.org, entry_id: je, property_id: live.prop, account_code: code, debit_cents: d, credit_cents: c } as any); };
  line(acct('asset'), 100000, 0); line(acct('liability'), 0, 40000); line(acct('equity'), 0, 60000);

  const def = reportDef('balance_sheet')!;
  const params = resolveParams(ctx, def, new URLSearchParams({ property: 'all' }));
  const rendered = processResult(def.run(ctx, params), { group: def.defaultGroup });
  assert.equal(rendered.totals, null, 'no assets + liabilities + equity grand total');
  assert.ok(rendered.groups && rendered.groups.length >= 2);
  assert.equal(rendered.groups!.find((g) => g.label === 'Assets')!.subtotal!.amount, 100000);
  assert.ok(!/^TOTAL/m.test(reportCsv(rendered)));
  const page = await get(base, '/reports/balance_sheet', cookieLive);
  assert.equal(page.status, 200);
  assert.ok(!/<td[^>]*>\s*Total\s*<\/td>/.test(page.text), 'no Total row on the page');
  assert.ok(/Subtotal/.test(page.text));
});

// ---------- item 71: report formatting ----------

test('CSV percentages are rounded like the page, and a property with no leases has no loss to lease', async () => {
  const csv = reportCsv({ cols: [{ key: 'p', label: 'Property' }, { key: 'occ', label: 'Occupancy', kind: 'pct', total: true }], rows: [{ p: 'A', occ: 12.17598378442235 }], groups: null, totals: { occ: 12.17598378442235 }, truncated: false });
  assert.ok(csv.includes('12.2'), csv);
  assert.ok(!csv.includes('12.1759'), csv);

  const empty = id('prp');
  insert('properties', { id: empty, org_id: live.org, name: 'Empty Arms', slug: `fxc-empty-${sfx}`, type: 'multifamily', address1: '2 Test St', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso() });
  insert('units', { id: id('unt'), org_id: live.org, property_id: empty, unit_number: '1', floor: 1, sqft: 600, status: 'vacant_ready', market_rent_cents: 120000, amenities: '[]', created_at: nowIso() });
  const a = revenueAnalytics(sysCtx(live.org), empty);
  assert.equal(a.lossToLease.gapPct, 0, 'not 100%');
  assert.equal(a.lossToLease.gapCents, 0);
  const def = reportDef('portfolio_rollup') || reportDef('portfolio_summary');
  if (def) {
    const ctx = sysCtx(live.org);
    const row = def.run(ctx, resolveParams(ctx, def, new URLSearchParams())).rows.find((r) => r.property === 'Empty Arms');
    if (row) assert.equal(row.loss_to_lease, null);
  }
  // PDF export still renders (header now carries the property name, not its id)
  const pdf = await get(base, `/reports/rent_roll?property=${live.prop}&format=pdf`, cookieLive);
  assert.equal(pdf.status, 200);
  assert.ok(pdf.text.startsWith('%PDF'));
  assert.ok(!pdf.text.includes(live.prop), 'the internal property id is not printed');
});

// ---------- item 72: saved views ----------

test('a saved view can be renamed, shared and exported — by its owner only', async () => {
  await post(base, '/reports/rent_roll/save', { params: JSON.stringify({ property: live.prop }) }, cookieLive);
  const saved = q1<any>('SELECT * FROM saved_reports WHERE org_id=? ORDER BY created_at DESC, rowid DESC', live.org);
  assert.equal(saved.shared, 0);
  const page = await get(base, `/reports/saved/${saved.id}`, cookieLive);
  assert.ok(page.text.includes(`/reports/saved/${saved.id}/update`), 'the name + visibility form is on the page');

  const blank = await post(base, `/reports/saved/${saved.id}/update`, { name: '   ', shared: '1' }, cookieLive);
  assert.equal(blank.status, 303);
  assert.equal(q1<any>('SELECT name FROM saved_reports WHERE id=?', saved.id)!.name, saved.name, 'blank name refused');

  const ok = await post(base, `/reports/saved/${saved.id}/update`, { name: 'Maple rent roll', shared: '1' }, cookieLive);
  assert.equal(ok.status, 303);
  const after = q1<any>('SELECT name, shared FROM saved_reports WHERE id=?', saved.id)!;
  assert.equal(after.name, 'Maple rent roll');
  assert.equal(after.shared, 1);
  assert.ok(q1(`SELECT id FROM audit_log WHERE org_id=? AND entity='saved_report' AND entity_id=? AND action='update'`, live.org, saved.id));

  // another company cannot rename it
  const other = await post(base, `/reports/saved/${saved.id}/update`, { name: 'hijacked', shared: '0' }, cookieDemo);
  assert.equal(other.status, 404);
  assert.equal(q1<any>('SELECT name FROM saved_reports WHERE id=?', saved.id)!.name, 'Maple rent roll');

  const csv = await get(base, `/reports/saved/${saved.id}?format=csv`, cookieLive);
  assert.equal(csv.status, 200);
  assert.ok(csv.text.split('\n')[0]!.includes('Unit'), csv.text.slice(0, 120));
  const pdf = await get(base, `/reports/saved/${saved.id}?format=pdf`, cookieLive);
  assert.equal(pdf.status, 200);
  assert.ok(pdf.text.startsWith('%PDF'));

  // a custom (builder) report exports too
  const sid = id('svr');
  insert('saved_reports', { id: sid, org_id: live.org, owner_user_id: live.uid, name: 'Custom residents', kind: 'custom', dataset: 'residents', config: JSON.stringify({ dataset: 'residents', cols: [], filters: [] }), shared: 0, schedule: null, last_run_date: null, created_at: nowIso() });
  const ccsv = await get(base, `/reports/saved/${sid}?format=csv`, cookieLive);
  assert.equal(ccsv.status, 200);
  assert.ok(!ccsv.text.startsWith('<!'), 'CSV, not an HTML page');
});

// ---------- item 74: comp market ----------

test('a live org gets no invented competitors, and prices only against comps its staff entered', async () => {
  const ctx = sysCtx(live.org);
  // simulator output that an earlier build wrote into this live org
  const fake = id('cmp');
  insert('comp_sets', { id: fake, org_id: live.org, property_id: live.prop, name: 'Nearby Community A', distance_miles: 0.8, year_built: 2010, notes: null, active: 1, created_at: nowIso() });
  insert('comp_observations', { id: id('cob'), org_id: live.org, comp_id: fake, month_key: '2026-07', beds: 1, rent_cents: 190000, concession_note: null, source: 'market_sim', created_at: nowIso() });

  const page = await get(base, '/pricing/comps', cookieLive);
  assert.equal(page.status, 200);
  ensureCompSets(live.org);
  assert.equal(generateCompObservations(live.org, '2026-07'), 0);
  runPricingEngine(ctx, '2026-07-26');
  assert.equal(val<number>('SELECT COUNT(*) FROM comp_sets WHERE org_id=?', live.org), 0, 'fabricated communities removed, none created');
  assert.equal(val<number>('SELECT COUNT(*) FROM comp_observations WHERE org_id=?', live.org), 0);
  assert.equal(compAverage(live.org, live.prop, 1, '2026-07'), null);
  const recs = q<any>('SELECT factors FROM price_recommendations WHERE org_id=?', live.org);
  assert.ok(recs.every((r) => !/comp set/.test(String(r.factors))), 'no recommendation cites a comp');

  // real, staff-entered comps
  const cid = addCompSet(ctx, { propertyId: live.prop, name: 'The Birches', distanceMiles: 0.5, yearBuilt: 2015 });
  assert.throws(() => addCompSet(ctx, { propertyId: live.prop, name: 'the birches' }), /already/);
  assert.throws(() => addCompSet(ctx, { propertyId: demo.prop, name: 'Other org' }), /not found/);
  recordCompObservation(ctx, { compId: cid, beds: 1, rentCents: 160000 });
  recordCompObservation(ctx, { compId: cid, beds: 1, rentCents: 165000, concessionNote: 'one month free' }); // correction, not a duplicate
  assert.throws(() => recordCompObservation(sysCtx(demo.org), { compId: cid, beds: 1, rentCents: 1 }), /not found/);
  assert.throws(() => recordCompObservation(ctx, { compId: cid, beds: 1, rentCents: 0 }), /rent/);
  const obs = q<any>('SELECT * FROM comp_observations WHERE org_id=?', live.org);
  assert.equal(obs.length, 1);
  assert.equal(obs[0].source, 'manual');
  assert.equal(obs[0].rent_cents, 165000);
  assert.equal(compAverage(live.org, live.prop, 1, '2026-07'), 165000);
  ensureCompSets(live.org); // the clean-up never touches staff-entered rows
  assert.equal(val<number>('SELECT COUNT(*) FROM comp_observations WHERE org_id=?', live.org), 1);
  removeCompSet(ctx, cid);
  assert.equal(compAverage(live.org, live.prop, 1, '2026-07'), null);

  // the demo keeps its simulator
  ensureCompSets(demo.org);
  assert.ok(generateCompObservations(demo.org, '2026-07') > 0);
});

// ---------- item 43: insurance verification ----------

test('a live resident upload waits for staff — nothing is verified by a simulator', async () => {
  const ctx = sysCtx(live.org);
  assert.throws(() => submitPolicy(ctx, { leaseId: live.lease, carrier: 'Real Mutual', policyNumber: 'RM-1', liabilityCents: 100, startDate: '2026-07-01', endDate: '2027-07-01' }), /liability/i);
  const res = submitPolicy(ctx, { leaseId: live.lease, carrier: 'Real Mutual', policyNumber: 'RM-123456', liabilityCents: 30000000, startDate: '2026-07-01', endDate: '2027-07-01' });
  assert.equal(res.outcome, 'pending');
  let p = q1<any>('SELECT * FROM insurance_policies WHERE id=?', res.policyId);
  assert.equal(p.status, 'pending_verification');
  assert.equal(p.verified_at, null);
  complianceSweep(ctx, '2026-07-27');
  assert.equal(q1<any>('SELECT status FROM insurance_policies WHERE id=?', res.policyId)!.status, 'pending_verification', 'the nightly sweep does not verify it either');
  assert.notEqual(leaseCompliance(ctx, live.lease).state, 'covered');

  const board = await get(base, '/insurance', cookieLive);
  assert.equal(board.status, 200);
  assert.ok(board.text.includes(`/insurance/policies/${res.policyId}/verify`), 'staff are offered the review');

  // another company cannot review it
  assert.equal((await post(base, `/insurance/policies/${res.policyId}/verify`, {}, cookieDemo)).status, 404);
  // a rejection needs a reason
  await post(base, `/insurance/policies/${res.policyId}/reject`, { reason: '' }, cookieLive);
  assert.equal(q1<any>('SELECT status FROM insurance_policies WHERE id=?', res.policyId)!.status, 'pending_verification');

  const v = await post(base, `/insurance/policies/${res.policyId}/verify`, {}, cookieLive);
  assert.equal(v.status, 303);
  p = q1<any>('SELECT * FROM insurance_policies WHERE id=?', res.policyId);
  assert.equal(p.status, 'active');
  assert.ok(p.verified_at);
  assert.equal(p.reviewed_by, 'Admin live');
  assert.equal(leaseCompliance(ctx, live.lease).state, 'covered');
  assert.ok(q1(`SELECT id FROM audit_log WHERE org_id=? AND entity='insurance_policy' AND entity_id=? AND action='verify'`, live.org, res.policyId));

  // reject path, with the reason kept for the resident
  const r2 = submitPolicy(ctx, { leaseId: live.lease, carrier: 'Other Mutual', policyNumber: 'OM-777', liabilityCents: 30000000, startDate: '2026-07-01', endDate: '2027-07-01' });
  await post(base, `/insurance/policies/${r2.policyId}/reject`, { reason: 'Name on the policy does not match the lease' }, cookieLive);
  const rej = q1<any>('SELECT * FROM insurance_policies WHERE id=?', r2.policyId);
  assert.equal(rej.status, 'rejected');
  assert.equal(rej.review_note, 'Name on the policy does not match the lease');
});

// ---------- item 44: master policy enrollment ----------

test('a live org cannot enroll or bill anyone in a master policy it does not hold', async () => {
  const ctx = sysCtx(live.org);
  run(`UPDATE insurance_policies SET status='lapsed' WHERE org_id=?`, live.org); // household is uncovered again
  const chargesBefore = val<number>(`SELECT COUNT(*) FROM charges WHERE org_id=? AND kind='insurance'`, live.org);
  assert.throws(() => enrollMaster(ctx, live.lease), /No master policy/);
  const r = await post(base, `/insurance/enroll/${live.lease}`, {}, cookieLive);
  assert.equal(r.status, 303);
  complianceSweep(ctx, '2026-07-28'); // auto-enroll on lapse must be fenced too
  assert.equal(val<number>(`SELECT COUNT(*) FROM insurance_policies WHERE org_id=? AND kind='master'`, live.org), 0);
  assert.equal(val<number>(`SELECT COUNT(*) FROM charges WHERE org_id=? AND kind='insurance'`, live.org), chargesBefore, 'no program fee billed');
  assert.equal(val<number>(`SELECT COUNT(*) FROM lease_charges WHERE org_id=? AND kind='insurance'`, live.org), 0);

  // once the operator records its real master policy, enrollment uses it
  setSetting(ctx, 'master_policy_carrier', 'Acme Casualty');
  setSetting(ctx, 'master_policy_number', 'MTL-0099');
  const r2 = await post(base, `/insurance/enroll/${live.lease}`, {}, cookieLive);
  assert.equal(r2.status, 303);
  const pol = q1<any>(`SELECT * FROM insurance_policies WHERE org_id=? AND kind='master' AND status='active'`, live.org);
  assert.ok(pol, 'enrolled');
  assert.equal(pol.carrier, 'Acme Casualty');
  assert.equal(pol.policy_number, 'MTL-0099');
  assert.ok(!/sim/i.test(pol.carrier));
  assert.equal(val<number>(`SELECT COUNT(*) FROM lease_charges WHERE org_id=? AND kind='insurance'`, live.org), 1);

  // the demo program is unchanged
  const dp = enrollMaster(sysCtx(demo.org), demo.lease);
  assert.match(q1<any>('SELECT carrier FROM insurance_policies WHERE id=?', dp)!.carrier, /\(sim\)/);
});
