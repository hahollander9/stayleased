import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert, run, val, j } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso, addDays } from '../src/lib/dates.ts';
import { hashPassword, sysCtx } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { setSetting } from '../src/lib/settings.ts';
import { advanceBusinessDate, liveToday, runJob, jobDefs } from '../src/lib/jobs.ts';
import { createCharge, leaseBalance } from '../src/modules/m8_receivables/service.ts';
import { decideAction } from '../src/modules/m17_ai/framework.ts';
import {
  handleLeadInbound, draftCollectionsOutreach, draftRenewalOutreach, setAiHooksLive,
} from '../src/modules/m17_ai/agents.ts';
import { askSmart } from '../src/modules/m17_ai/ask.ts';
import { generateListing, generateTemplateDraft } from '../src/modules/m17_ai/content.ts';
import { llmStatus } from '../src/lib/sim/llm.ts';
import { startTestServer, loginAs, get, post } from './harness.ts';

/** The AI area walked as a REAL company (orgs.kind = 'live'), one test per
 * finding. Each asserts what is in the database afterwards, not what a page
 * says. No API key is configured here, which is itself the condition several
 * of these findings are about. */

delete process.env.ANTHROPIC_API_KEY;

const BD = liveToday();
const sfx = id('x').slice(-6);
let base: string;
let close: () => void;
let orgId: string;
let propId: string;
let admin: string;
let cookie: string;
let fpId: string;
let leadId: string;

function mkLease(unit: string, household: string, endDate: string, opts: { portal?: boolean } = {}): { leaseId: string; residentId: string } {
  const unitId = id('unt');
  insert('units', {
    id: unitId, org_id: orgId, property_id: propId, floorplan_id: fpId, unit_number: unit,
    floor: 1, sqft: 900, status: 'occupied', market_rent_cents: 150000, amenities: '[]', created_at: nowIso(),
  });
  const leaseId = id('lse');
  insert('leases', {
    id: leaseId, org_id: orgId, property_id: propId, unit_id: unitId, household_name: household,
    status: 'active', start_date: addDays(endDate, -364), end_date: endDate, move_in_date: addDays(endDate, -364),
    rent_cents: 150000, deposit_cents: 150000, deposit_alternative: 0, term_months: 12, created_at: nowIso(),
  });
  const residentId = id('res');
  const email = `${unit.toLowerCase()}-${sfx}@example.test`;
  let userId: string | null = null;
  if (opts.portal) {
    userId = id('usr');
    insert('users', { id: userId, org_id: orgId, email, name: household, kind: 'resident', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso() });
  }
  insert('residents', {
    id: residentId, org_id: orgId, property_id: propId, user_id: userId, first_name: household.split(' ')[0], last_name: 'Tester',
    email, phone: '5550100', kind: 'adult', created_at: nowIso(),
  });
  insert('household_members', { id: id('hm'), org_id: orgId, lease_id: leaseId, resident_id: residentId, role: 'primary', created_at: nowIso() });
  return { leaseId, residentId };
}

const action = (aid: string): any => {
  const row = q1<any>('SELECT * FROM ai_actions WHERE id=?', aid);
  return { ...row, out: j<any>(row.output, {}), inp: j<any>(row.input, {}) };
};

before(async () => {
  db();
  orgId = id('org');
  insert('orgs', { id: orgId, name: `FxAi live ${sfx}`, slug: `fxai-${sfx}`, kind: 'live', business_date: BD, created_at: nowIso() });
  ensureCoa(orgId);
  const uid = id('usr');
  admin = `admin-fxai-${sfx}@example.test`;
  insert('users', { id: uid, org_id: orgId, email: admin, name: 'Avery Admin', kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso() });
  insert('role_assignments', { id: id('ra'), org_id: orgId, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  propId = id('prp');
  // an imported building: the source file had no address, so the city is the importer's placeholder
  insert('properties', {
    id: propId, org_id: orgId, name: 'Harbor Court', slug: `fxai-prop-${sfx}`, type: 'multifamily',
    address1: '—', city: '—', state: '—', zip: '', timezone: 'America/Denver', created_at: nowIso(),
  });
  fpId = id('fpl');
  insert('floorplans', { id: fpId, org_id: orgId, property_id: propId, name: 'B1', beds: 1, baths: 1, sqft: 0, market_rent_cents: 150000, created_at: nowIso() });
  leadId = id('led');
  insert('leads', {
    id: leadId, org_id: orgId, property_id: propId, first_name: 'Pat', last_name: 'Prospect',
    email: `pat-${sfx}@example.test`, phone: '5550301', source: 'website', channel: 'web', status: 'new',
    beds: 1, created_date: BD, last_activity_at: nowIso(), created_at: nowIso(),
  });
  const s = await startTestServer();
  base = s.base; close = s.close;
  setAiHooksLive(true);
  cookie = await loginAs(base, admin);
});
after(() => close());

// ---------- 61 ----------

test('61: a live company with no pet policy or tour hours on file gets no invented terms, and the reply is held for a person', () => {
  const ctx = sysCtx(orgId);
  assert.equal(ctx.orgKind, 'live');
  setSetting(ctx, 'ai_autonomy', { leasing: 'auto' }); // the worst case: an autonomous dial
  const res = handleLeadInbound(ctx, leadId, 'Do you allow dogs, is anything available, and can I tour tomorrow?')!;
  const a = action(res.id);
  assert.doesNotMatch(a.out.draft, /\$35|\$250|up to 2|ordinance|Pets are family/, 'no default pet terms');
  assert.match(a.out.draft, /confirm our pet policy/);
  assert.doesNotMatch(a.out.draft, /weekly/, 'no claim about how often homes open up');
  assert.match(a.out.draft, /first-look list/);
  assert.doesNotMatch(a.out.draft, /\d{2}:\d{2}/, 'no tour times from hours nobody set');
  assert.equal(a.out.tour, null, 'no tour is staged for booking');
  assert.ok(a.confidence < 0.7, 'below the auto floor');
  assert.equal(res.status, 'proposed', 'held even on an autonomous dial');
  assert.match(a.guardrail_note, /pet policy/);
  assert.equal(val<number>('SELECT COUNT(*) FROM tours WHERE lead_id=?', leadId), 0);
  assert.equal(val<number>(`SELECT COUNT(*) FROM outbox_messages WHERE org_id=? AND person_id=? AND direction='out'`, orgId, leadId), 0, 'nothing went out');

  // once the operator records both, the reply states them and stages the tour
  setSetting(ctx, 'ai_autonomy', { leasing: 'approve' });
  setSetting(ctx, 'pet_policy', { maxPets: 1, petRentCents: 4000, depositCents: 30000, restricted: 'none' }, propId);
  setSetting(ctx, 'tour_hours', { start: '10:00', end: '16:00', days: [0, 1, 2, 3, 4, 5, 6], slotMinutes: 30 });
  const b = action(handleLeadInbound(ctx, leadId, 'Do you allow dogs and can I tour?')!.id);
  assert.match(b.out.draft, /up to 1 per home, \$40\.00\/mo pet rent and a \$300\.00 deposit/);
  assert.deepEqual(b.out.tour, { date: addDays(BD, 1), startTime: '10:00' });
  assert.ok(b.confidence >= 0.7);
});

// ---------- 62 ----------

test('62: the outreach and the plan beside it name the same installment count, and a live company is not sent to a portal that cannot take payment', () => {
  const ctx = sysCtx(orgId);
  const { leaseId } = mkLease('C-101', 'Morgan household', addDays(BD, 200));
  createCharge(ctx, { leaseId, kind: 'rent', label: 'Rent', amountCents: 295050, date: addDays(BD, -20), dueDate: addDays(BD, -20), source: 'recurring' });
  const a = action(draftCollectionsOutreach(ctx, leaseId)!.id);
  const plan = q1<any>(`SELECT * FROM ai_actions WHERE org_id=? AND agent='payments' AND entity_id=? AND title LIKE 'Plan proposal%'`, orgId, leaseId);
  const n = (j<any>(plan.output, {}).installments as unknown[]).length;
  assert.equal(n, 4);
  assert.match(a.out.draft, new RegExp(`split this into ${n} installments`));
  assert.doesNotMatch(a.out.draft, /resident portal/, 'online payment is closed in a live organization');
  assert.match(a.out.draft, /reply here or call the office/);
  assert.match(a.out.draft, /right to dispute/);
});

test('62: the daily watch drafts for an overdue household without anyone pressing a button, once', () => {
  const ctx = sysCtx(orgId);
  assert.ok(jobDefs().some((d) => d.key === 'ai_collections_watch'));
  const late = mkLease('C-102', 'Riley household', addDays(BD, 200));
  const inGrace = mkLease('C-103', 'Sam household', addDays(BD, 200));
  createCharge(ctx, { leaseId: late.leaseId, kind: 'rent', label: 'Rent', amountCents: 150000, date: addDays(BD, -12), dueDate: addDays(BD, -12), source: 'recurring' });
  createCharge(ctx, { leaseId: inGrace.leaseId, kind: 'rent', label: 'Rent', amountCents: 150000, date: addDays(BD, -1), dueDate: addDays(BD, -1), source: 'recurring' });
  assert.ok(leaseBalance(ctx, late.leaseId) > 0);
  const count = (leaseId: string): number =>
    val<number>(`SELECT COUNT(*) FROM ai_actions WHERE org_id=? AND agent='payments' AND entity_id=? AND title NOT LIKE 'Plan proposal%'`, orgId, leaseId) || 0;

  const r1 = runJob(ctx, 'ai_collections_watch', BD);
  assert.equal(r1.status, 'ok', r1.summary);
  assert.equal(count(late.leaseId), 1, 'a draft is waiting in the queue');
  assert.equal(count(inGrace.leaseId), 0, 'inside the grace period — left alone');
  const queued = q1<any>(`SELECT status, autonomy FROM ai_actions WHERE org_id=? AND agent='payments' AND entity_id=?`, orgId, late.leaseId);
  assert.equal(queued.status, 'proposed', 'nothing is sent without approval');
  assert.equal(val<number>(`SELECT COUNT(*) FROM outbox_messages WHERE org_id=? AND person_id=?`, orgId, late.residentId), 0);

  runJob(ctx, 'ai_collections_watch', BD);
  assert.equal(count(late.leaseId), 1, 'the next pass does not draft again');

  // the kill switch stops the watch as well
  const other = mkLease('C-104', 'Toni household', addDays(BD, 200));
  createCharge(ctx, { leaseId: other.leaseId, kind: 'rent', label: 'Rent', amountCents: 150000, date: addDays(BD, -12), dueDate: addDays(BD, -12), source: 'recurring' });
  setSetting(ctx, 'ai_enabled', false);
  runJob(ctx, 'ai_collections_watch', BD);
  assert.equal(count(other.leaseId), 0);
  setSetting(ctx, 'ai_enabled', true);
});

// ---------- 63 ----------

test('63: approving renewal outreach puts the offer on file with the terms the message quotes', async () => {
  const ctx = sysCtx(orgId);
  setSetting(ctx, 'ai_autonomy', { renewals: 'approve' });
  const { leaseId, residentId } = mkLease('R-201', 'Jamie household', addDays(BD, 75), { portal: true });

  // drafted through the same route the Renewals page button posts to
  const d = await post(base, `/ai/renewals/${leaseId}/draft`, {}, cookie);
  assert.equal(d.status, 303);
  const row = q1<any>(`SELECT id FROM ai_actions WHERE org_id=? AND agent='renewals' AND entity_id=?`, orgId, leaseId);
  const a = action(row.id);
  assert.match(a.out.draft, /Accept in your resident portal/, 'this resident can sign in');
  assert.equal(val<number>('SELECT COUNT(*) FROM renewal_offers WHERE lease_id=?', leaseId), 0, 'drafting alone commits nothing');

  const ap = await post(base, `/ai/${row.id}/approve`, {}, cookie);
  assert.equal(ap.status, 303);
  const offer = q1<any>(`SELECT * FROM renewal_offers WHERE lease_id=? AND org_id=?`, leaseId, orgId);
  assert.ok(offer, 'the offer exists the moment the message goes out');
  assert.equal(offer.status, 'sent', 'the status the portal accept form looks for');
  assert.deepEqual(j<any>(offer.options, []), a.out.options, 'same terms as quoted');
  assert.equal(offer.expires_date, addDays(BD, 30));
  for (const o of a.out.options) assert.ok(a.out.draft.includes(`<b>${o.term_months} months</b>`));
  const msg = q1<any>(`SELECT * FROM outbox_messages WHERE org_id=? AND person_id=? AND template_key='ai_renewal'`, orgId, residentId);
  assert.ok(msg, 'the outreach is in the outbox');
  assert.equal(msg.entity_id, offer.id);
  assert.equal(action(row.id).status, 'executed');
  assert.ok(q1<any>(`SELECT id FROM audit_events WHERE org_id=? AND entity='renewal_offer' AND entity_id=?`, orgId, offer.id), 'audited');

  // a second approval path cannot stack a second offer
  assert.equal(draftRenewalOutreach(ctx, leaseId) !== null, true);
  const again = q1<any>(`SELECT id FROM ai_actions WHERE org_id=? AND agent='renewals' AND entity_id=? AND status='proposed'`, orgId, leaseId);
  decideAction({ ...ctx, userName: 'Avery Admin' }, again.id, 'approve');
  assert.equal(val<number>('SELECT COUNT(*) FROM renewal_offers WHERE lease_id=?', leaseId), 1);
});

test('63: a resident with no portal login is not told to accept in the portal, and different terms on file stop the send', () => {
  const ctx = { ...sysCtx(orgId), userName: 'Avery Admin' };
  const { leaseId, residentId } = mkLease('R-202', 'Kai household', addDays(BD, 80));
  const a = action(draftRenewalOutreach(ctx, leaseId)!.id);
  assert.doesNotMatch(a.out.draft, /portal/i);
  assert.match(a.out.draft, /Reply to this message with the term/);
  // staff send their own offer with other terms before the draft is approved
  insert('renewal_offers', {
    id: id('rno'), org_id: orgId, property_id: propId, lease_id: leaseId,
    options: JSON.stringify([{ term_months: 12, rent_cents: 199900 }]), status: 'sent', expires_date: addDays(BD, 30), created_at: nowIso(),
  });
  decideAction(ctx, a.id, 'approve');
  assert.match(action(a.id).result, /different terms.*nothing sent/);
  assert.equal(val<number>(`SELECT COUNT(*) FROM outbox_messages WHERE org_id=? AND person_id=?`, orgId, residentId), 0);
  assert.equal(val<number>('SELECT COUNT(*) FROM renewal_offers WHERE lease_id=?', leaseId), 1);
});

test('63: the daily watch drafts renewal outreach for a lease ending inside 90 days, once', () => {
  const ctx = sysCtx(orgId);
  const soon = mkLease('R-203', 'Lee household', addDays(BD, 45));
  const far = mkLease('R-204', 'Noor household', addDays(BD, 240));
  const count = (leaseId: string): number =>
    val<number>(`SELECT COUNT(*) FROM ai_actions WHERE org_id=? AND agent='renewals' AND entity_id=?`, orgId, leaseId) || 0;
  const r = runJob(ctx, 'ai_renewals_watch', BD);
  assert.equal(r.status, 'ok', r.summary);
  assert.equal(count(soon.leaseId), 1);
  assert.equal(count(far.leaseId), 0);
  runJob(ctx, 'ai_renewals_watch', BD);
  assert.equal(count(soon.leaseId), 1, 'not drafted twice');
  assert.equal(val<number>('SELECT COUNT(*) FROM renewal_offers WHERE lease_id=?', soon.leaseId), 0, 'no offer until a person approves');
});

// ---------- 64 ----------

test('64: with no model connected, an instruction is refused plainly and Ask does not offer to do things', async () => {
  assert.equal(llmStatus().live, false);
  const ctx = { ...sysCtx(orgId), userName: 'Avery Admin' };
  const before = val<number>('SELECT COUNT(*) FROM work_orders WHERE org_id=?', orgId) || 0;
  const ans = await askSmart(ctx, 'Open a work order for a leaking faucet in unit C-101');
  assert.equal(ans.matched, 'action.unavailable');
  assert.match(String(ans.summary), /nothing was changed|Nothing was changed/i);
  assert.equal(val<number>('SELECT COUNT(*) FROM work_orders WHERE org_id=?', orgId) || 0, before);

  const page = await get(base, '/ask', cookie);
  assert.equal(page.status, 200);
  assert.ok(!page.text.includes('I can also do things'));
  assert.ok(!page.text.includes('tell me to do something'));
});

// ---------- 65 ----------

test('65: a live company’s business date cannot be moved ahead of today, by Ask or by any other caller', async () => {
  const target = addDays(BD, 14);
  const r = await post(base, '/ask/act', { op: 'clock.advance', args: JSON.stringify({ to: target }), json: '1' }, cookie);
  assert.ok(!/"ok":true/.test(r.text), r.text);
  assert.equal(q1<any>('SELECT business_date FROM orgs WHERE id=?', orgId).business_date, BD);
  assert.throws(() => advanceBusinessDate(orgId, target), /real calendar/);
  assert.equal(q1<any>('SELECT business_date FROM orgs WHERE id=?', orgId).business_date, BD);
  assert.equal(val<number>(`SELECT COUNT(*) FROM charges WHERE org_id=? AND date>?`, orgId, BD), 0, 'no rent posted early');
});

// ---------- 66 ----------

test('66: a listing draft states only recorded facts, and a template starter leaves blanks instead of inventing details', () => {
  const ctx = sysCtx(orgId);
  const text = generateListing(ctx, propId, fpId);
  assert.match(text, /Harbor Court/);
  assert.doesNotMatch(text, /coffee|transit|trails|lounge|controlled access|on-site maintenance/i, 'no amenities or neighborhood nobody entered');
  assert.doesNotMatch(text, /sq ft/, 'no size for a floorplan without one');
  assert.doesNotMatch(text, /Located in|—'s/, 'the import placeholder is not a city');

  setSetting(ctx, 'marketing', { amenities: ['bike room'] }, propId);
  run('UPDATE properties SET city=?, state=? WHERE id=?', 'Tacoma', 'WA', propId);
  run('UPDATE floorplans SET sqft=640 WHERE id=?', fpId);
  const full = generateListing(ctx, propId, fpId);
  assert.match(full, /640 sq ft/);
  assert.match(full, /Amenities include bike room\./);
  assert.match(full, /Located in Tacoma, WA\./);

  const t = generateTemplateDraft(ctx, 'pool closure notice');
  assert.match(t.body, /\[dates and times\]/);
  assert.doesNotMatch(t.body, /following morning|COMMON AREA/);
  assert.equal(t.live, false);
  assert.equal(q<any>(`SELECT id FROM ai_actions WHERE org_id=? AND agent='content'`, orgId).length, 3, 'each draft is logged');
});
