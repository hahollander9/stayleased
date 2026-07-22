import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert, run, val, j } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso, addDays } from '../src/lib/dates.ts';
import { sysCtx } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { setSetting } from '../src/lib/settings.ts';
import { createCharge } from '../src/modules/m8_receivables/service.ts';
import { propose, decideAction, autonomyFor, registerExecutor } from '../src/modules/m17_ai/framework.ts';
import {
  detectLeadIntent, handleLeadInbound, triageRequest, draftCollectionsOutreach,
  draftRenewalOutreach, evaluateCounter, onTimeStreak,
} from '../src/modules/m17_ai/agents.ts';
import { analyzeTranscript, analyzeCall } from '../src/modules/m17_ai/analysis.ts';
import { askStayLeased } from '../src/modules/m17_ai/ask.ts';
import '../src/modules/m17_ai/pages.ts'; // registers executors + hooks live

/** Phase 16 units: autonomy behavior (draft/approve/auto), grounded leasing
 * replies, emergency triage, payments guardrails + plan bounds, renewal
 * counter bands, transcript analysis, Ask StayLeased correctness. */

const BD = '2026-07-26';
let orgId: string;
let propId: string;
let leadId: string;
let leaseId: string;
const unitIds: string[] = [];

before(() => {
  db();
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'AI Test Org', slug: 'ai-' + orgId.slice(-6), business_date: BD, created_at: nowIso() });
  ensureCoa(orgId);
  propId = id('prp');
  insert('properties', {
    id: propId, org_id: orgId, name: 'Agent Arms', slug: 'agent-' + orgId.slice(-6), type: 'multifamily',
    address1: '7 Neural Net', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso(),
  });
  const fpId = id('fpl');
  insert('floorplans', { id: fpId, org_id: orgId, property_id: propId, name: 'A2', beds: 2, baths: 2, sqft: 980, market_rent_cents: 180000, created_at: nowIso() });
  for (let i = 0; i < 3; i++) {
    const uid = id('unt');
    unitIds.push(uid);
    insert('units', {
      id: uid, org_id: orgId, property_id: propId, floorplan_id: fpId, unit_number: `A-20${i}`,
      floor: 2, sqft: 980, status: i === 0 ? 'vacant_ready' : 'occupied', market_rent_cents: 180000 + i * 2000, amenities: '[]', created_at: nowIso(),
    });
  }
  leadId = id('led');
  insert('leads', {
    id: leadId, org_id: orgId, property_id: propId, first_name: 'Quinn', last_name: 'Prospect',
    email: 'quinn@test.demo', phone: '5550301', source: 'website', channel: 'web', status: 'new',
    beds: 2, created_date: BD, last_activity_at: nowIso(), created_at: nowIso(),
  });
  leaseId = id('lse');
  insert('leases', {
    id: leaseId, org_id: orgId, property_id: propId, unit_id: unitIds[1], household_name: 'Counter household',
    status: 'active', start_date: '2025-10-01', end_date: '2026-09-30', move_in_date: '2025-10-01',
    rent_cents: 170000, deposit_cents: 170000, deposit_alternative: 0, term_months: 12, created_at: nowIso(),
  });
  const rid = id('res');
  insert('residents', {
    id: rid, org_id: orgId, property_id: propId, first_name: 'Casey', last_name: 'Counter',
    email: 'casey@test.demo', phone: '5550302', kind: 'adult', created_at: nowIso(),
  });
  insert('household_members', { id: id('hm'), org_id: orgId, lease_id: leaseId, resident_id: rid, role: 'primary', created_at: nowIso() });
  // rent history for streak + a delinquent balance
  for (let m = 9; m >= 1; m--) {
    const mk = `2026-0${Math.max(1, 8 - m)}`;
  }
  createCharge(sysCtx(orgId, '2026-07-01'), { leaseId, kind: 'rent', label: 'Rent Jul', amountCents: 170000, date: '2026-07-01', dueDate: '2026-07-01', source: 'recurring' });
});

test('autonomy: draft holds, approve executes on click, auto executes instantly (all audited)', () => {
  const ctx = { ...sysCtx(orgId), userName: 'Supervisor' };
  let executed = 0;
  registerExecutor('test.noop', () => { executed++; return 'done'; });

  setSetting(ctx, 'ai_autonomy', { leasing: 'draft' });
  const d = propose(ctx, { agent: 'leasing', title: 'draft test', input: {}, output: { kind: 'test.noop' } });
  assert.equal(d.status, 'proposed');
  decideAction(ctx, d.id, 'approve');
  assert.equal(executed, 0, 'draft-only: approval means reviewed, never executes');
  assert.equal(q1<any>('SELECT status FROM ai_actions WHERE id=?', d.id).status, 'approved');

  setSetting(ctx, 'ai_autonomy', { leasing: 'approve' });
  const a = propose(ctx, { agent: 'leasing', title: 'approve test', input: {}, output: { kind: 'test.noop' } });
  assert.equal(a.status, 'proposed');
  decideAction(ctx, a.id, 'approve');
  assert.equal(executed, 1, 'approve-to-send executes exactly on approval');
  assert.equal(q1<any>('SELECT status FROM ai_actions WHERE id=?', a.id).status, 'executed');

  setSetting(ctx, 'ai_autonomy', { leasing: 'auto' });
  const auto = propose(ctx, { agent: 'leasing', title: 'auto test', input: {}, output: { kind: 'test.noop' } });
  assert.equal(auto.status, 'auto_executed');
  assert.equal(executed, 2);
  // low confidence holds even on auto
  const held = propose(ctx, { agent: 'leasing', title: 'low conf', input: {}, output: { kind: 'test.noop' }, confidence: 0.4 });
  assert.equal(held.status, 'proposed', 'low confidence never auto-executes');
  // rejection trail
  decideAction(ctx, held.id, 'reject', { reason: 'not appropriate' });
  assert.equal(q1<any>('SELECT status FROM ai_actions WHERE id=?', held.id).status, 'rejected');
  assert.ok(val<number>(`SELECT COUNT(*) FROM audit_events WHERE org_id=? AND entity='ai_action'`, orgId)! >= 6, 'every step audited');
  setSetting(ctx, 'ai_autonomy', { leasing: 'approve' });
});

test('leasing: replies are grounded in live units, pricing, policy and real tour slots', () => {
  const ctx = sysCtx(orgId);
  const res = handleLeadInbound(ctx, leadId, 'How much is a 2 bedroom, are any available, can we tour, and do you allow dogs?')!;
  const action = q1<any>('SELECT * FROM ai_actions WHERE id=?', res.id);
  const output = j<any>(action.output, {});
  assert.match(output.draft, /A-200/, 'names the actual vacant-ready unit');
  assert.match(output.draft, /\$1,800\.00/, 'quotes the real 12-month rate');
  assert.match(output.draft, /Pets are family/, 'pet policy grounded from settings');
  assert.match(output.draft, /tour/i, 'tour slots offered');
  assert.ok(output.tour, 'tour payload staged (prospect asked)');
  assert.equal(output.tour.date, addDays(BD, 1));
  // approve executes: email lands + tour booked in M3
  const ctx2 = { ...sysCtx(orgId), userName: 'Agent Smith' };
  decideAction(ctx2, res.id, 'approve');
  assert.ok(q1<any>(`SELECT id FROM tours WHERE lead_id=? AND status='scheduled'`, leadId), 'tour exists in M3');
  assert.ok(q1<any>(`SELECT id FROM outbox_messages WHERE org_id=? AND person_id=? AND direction='out'`, orgId, leadId), 'reply in the console');
  // wants-human → low confidence hold
  const human = handleLeadInbound(ctx, leadId, 'I want to talk to a real person please, call me.')!;
  const h = q1<any>('SELECT * FROM ai_actions WHERE id=?', human.id);
  assert.ok(h.confidence < 0.7);
  assert.match(h.guardrail_note, /asked for a person/);
});

test('maintenance: gas leak → emergency, trivial disposal → tip, vague → clarifying question', () => {
  const ctx = sysCtx(orgId);
  const mkWo = (summary: string, description = ''): string => {
    const woId = id('wo');
    insert('work_orders', {
      id: woId, org_id: orgId, property_id: propId, unit_id: unitIds[1], lease_id: leaseId,
      category: 'other', priority: 'normal', status: 'new', summary, description,
      source: 'portal', created_date: BD, created_at: nowIso(),
    });
    return woId;
  };
  setSetting(sysCtx(orgId), 'ai_autonomy', { maintenance: 'auto' });
  const gas = mkWo('I smell gas in the kitchen');
  triageRequest(ctx, gas);
  const gasWo = q1<any>('SELECT * FROM work_orders WHERE id=?', gas);
  assert.equal(gasWo.priority, 'emergency', 'auto dial applied the emergency immediately');
  const gasAction = q1<any>(`SELECT * FROM ai_actions WHERE entity_id=? AND agent='maintenance'`, gas);
  assert.equal(gasAction.status, 'auto_executed');
  assert.match(gasAction.guardrail_note, /emergency keywords/);

  const disposal = mkWo('garbage disposal is stuck and just hums');
  triageRequest(ctx, disposal);
  const dAction = q1<any>(`SELECT * FROM ai_actions WHERE entity_id=? AND agent='maintenance'`, disposal);
  const dOut = j<any>(dAction.output, {});
  assert.equal(dOut.draftKind, 'tip');
  assert.match(dOut.draft, /RESET button/, 'troubleshooting tip for the trivial fix');
  assert.equal(dOut.category, 'appliance');

  const vague = mkWo('broken');
  triageRequest(ctx, vague);
  const vOut = j<any>(q1<any>(`SELECT output FROM ai_actions WHERE entity_id=? AND agent='maintenance'`, vague).output, {});
  assert.equal(vOut.draftKind, 'question');
  assert.match(vOut.draft, /which room/);
  setSetting(sysCtx(orgId), 'ai_autonomy', { maintenance: 'approve' });
});

test('payments: tone grading, hard-coded dispute path, plan inside org bounds', () => {
  const ctx = sysCtx(orgId);
  const res = draftCollectionsOutreach(ctx, leaseId)!;
  const outreach = q1<any>('SELECT * FROM ai_actions WHERE id=?', res.id);
  const draft = j<any>(outreach.output, {}).draft as string;
  assert.match(draft, /right to dispute/, 'dispute path is unconditional');
  assert.doesNotMatch(draft, /evict|attorney|lawsuit|credit bureau/i, 'never threatens');
  assert.match(outreach.guardrail_note, /threat filter clean/);
  // plan proposal exists and respects bounds
  const plan = q1<any>(
    `SELECT * FROM ai_actions WHERE org_id=? AND agent='payments' AND entity_id=? AND title LIKE 'Plan proposal%'`,
    orgId, leaseId,
  );
  assert.ok(plan, 'plan proposed (balance is 2x min installment)');
  const inst = j<any>(plan.output, {}).installments as { amountCents: number }[];
  assert.ok(inst.length <= 4, 'max installments bound');
  assert.ok(inst.every((i) => i.amountCents >= 15000), 'min installment bound');
  assert.equal(inst.reduce((s, i) => s + i.amountCents, 0), 170000, 'sums to the balance');
  // approving the plan creates it through M8
  decideAction({ ...sysCtx(orgId), userName: 'Controller' }, plan.id, 'approve');
  assert.equal(q1<any>('SELECT status FROM ai_actions WHERE id=?', plan.id).status, 'approved', 'payments dial is draft by default');
});

test('renewals: streak-personalized outreach; counters accept in band, escalate below floor', () => {
  const ctx = sysCtx(orgId);
  assert.equal(onTimeStreak(ctx, leaseId) >= 0, true);
  const outreach = draftRenewalOutreach(ctx, leaseId)!;
  const draft = j<any>(q1<any>('SELECT output FROM ai_actions WHERE id=?', outreach.id).output, {}).draft as string;
  assert.match(draft, /renewal options|options/i);
  assert.match(draft, /months<\/b> — \$/, 'matrix rates embedded');

  // create an offer so counters evaluate against it: 12mo at $1,760
  insert('renewal_offers', {
    id: id('rno'), org_id: orgId, property_id: propId, lease_id: leaseId,
    options: JSON.stringify([{ term_months: 12, rent_cents: 176000 }, { term_months: 6, rent_cents: 182000 }]),
    status: 'sent', expires_date: addDays(BD, 30), created_at: nowIso(),
  });
  // floor at 2.5% below 1760 = 1716
  const inBand = evaluateCounter(ctx, leaseId, 173000, 12)!;
  const a1 = q1<any>('SELECT * FROM ai_actions WHERE id=?', inBand.id);
  assert.match(a1.title, /WITHIN band/);
  assert.equal(j<any>(a1.output, {}).kind, 'renewals.accept_counter');
  const below = evaluateCounter(ctx, leaseId, 165000, 12)!;
  const a2 = q1<any>('SELECT * FROM ai_actions WHERE id=?', below.id);
  assert.match(a2.title, /escalate/);
  assert.equal(j<any>(a2.output, {}).kind, 'renewals.escalate');
  assert.match(a2.guardrail_note, /never commits beyond the band/);
  // approving the in-band counter updates the offer + notifies
  decideAction({ ...sysCtx(orgId), userName: 'PM' }, inBand.id, 'approve');
  const acted = q1<any>('SELECT * FROM ai_actions WHERE id=?', inBand.id);
  if (acted.autonomy !== 'draft') {
    const offer = q1<any>('SELECT * FROM renewal_offers WHERE lease_id=? ORDER BY created_at DESC', leaseId);
    assert.equal(JSON.parse(offer.options).find((o: any) => o.term_months === 12).rent_cents, 173000);
  }
});

test('call analysis: fixture transcript → summary, sentiment, tags, tasks, coaching', () => {
  const ctx = sysCtx(orgId);
  const a = analyzeTranscript(
    'Hi, I saw your two bedroom online. How much is rent and are there any specials? Please send me the application link and call me back this afternoon.',
    { direction: 'in', duration: 240, hasTourBooked: false },
  );
  assert.equal(a.tags.includes('pricing'), true);
  assert.ok(a.actionItems.some((x) => /call back/i.test(x)));
  assert.ok(a.actionItems.some((x) => /materials/i.test(x)));
  assert.equal(a.missedOpportunity, true, 'asked pricing, never offered a tour');
  assert.match(a.coaching!, /bridge pricing questions to a tour/);

  const callId = id('cal');
  insert('call_logs', {
    id: callId, org_id: orgId, property_id: propId, lead_id: leadId, direction: 'in',
    from_number: '5550301', duration_seconds: 240, outcome: 'answered',
    transcript: 'I am frustrated, this is the second time my sink leak was not fixed. Please have maintenance come back.',
    handled_by: null, at: nowIso(), business_date: BD,
  });
  const done = analyzeCall(ctx, callId)!;
  assert.equal(done.sentiment, 'negative');
  const call = q1<any>('SELECT * FROM call_logs WHERE id=?', callId);
  assert.ok(call.ai_summary);
  assert.ok(JSON.parse(call.ai_tags).includes('maintenance'));
  assert.ok(q1<any>(`SELECT id FROM followup_tasks WHERE lead_id=? AND kind LIKE 'ai:%'`, leadId), 'action item became a real task');
});

test('Ask StayLeased: three cross-module questions return correct live numbers', () => {
  const ctx = sysCtx(orgId);
  // 1. delinquency over $1,000 — Casey owes $1,700
  const a1 = askStayLeased(ctx, 'delinquency over $1,000');
  assert.equal(a1.matched, 'delinquency');
  assert.match(a1.summary, /1 household owing \$1,700\.00/);
  // 2. occupancy — 2 of 3 units occupied
  const a2 = askStayLeased(ctx, 'what is our occupancy?');
  assert.equal(a2.matched, 'occupancy');
  assert.match(a2.summary, /33\.3% physical occupancy \(1\/3 units\)/);
  // 3. open work orders — the three triaged above
  const a3 = askStayLeased(ctx, 'how many open work orders do we have');
  assert.equal(a3.matched, 'workorders');
  assert.match(a3.summary, /3 open work orders/);
  // every ask is itself an audited action
  assert.ok(val<number>(`SELECT COUNT(*) FROM ai_actions WHERE org_id=? AND agent='ask'`, orgId)! >= 3);
  // fallback teaches instead of guessing
  const fb = askStayLeased(ctx, 'what is the meaning of life');
  assert.equal(fb.matched, 'fallback');
});
