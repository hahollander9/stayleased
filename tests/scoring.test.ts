import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureFinance, type FinanceFx } from './harness.ts';
import { sysCtx, hashPassword } from '../src/lib/auth.ts';
import { q, q1, insert, val, run, db, j } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso, addDays } from '../src/lib/dates.ts';
import { jobDefs } from '../src/lib/jobs.ts';
import { draftCollectionsOutreach, draftRenewalOutreach } from '../src/modules/m17_ai/agents.ts';
import { executeAction } from '../src/modules/m17_ai/framework.ts';
import { createRenewalOffer } from '../src/modules/m6_leases/service.ts';
import { intakeLead } from '../src/modules/m3_crm/service.ts';
import { startTestServer, loginAs, get } from './harness.ts';
import { getSetting, setSetting } from '../src/lib/settings.ts';
import { detectLeadIntent } from '../src/lib/lead_intent.ts';
import { assessDelinquency, computeDelinquencyInputs, latestAssessment, assessLeadHeat, computeLeadInputs, latestLeadAssessment, type DelinqInputs, type LeadHeatInputs } from '../src/modules/m19_scoring/service.ts';

/** M19 agent scoring — scorer #1: delinquency. Deterministic rules score,
 * models phrase, humans decide the regulated moments. Shadow mode default. */

let fx: FinanceFx;
const D = '2026-07-26';

before(() => {
  fx = fixtureFinance();
});

// ---------- Task 1: schema + setting ----------

test('delinquency_assessments table exists with unique (lease_id, as_of_date) index', () => {
  db();
  const table = q1<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='delinquency_assessments'`);
  assert.ok(table, 'table missing');
  const idx = q1<any>(`SELECT name FROM sqlite_master WHERE type='index' AND name='ux_delinq_assess'`);
  assert.ok(idx, 'unique index missing');
  // uniqueness is enforced, not advisory
  const ctx = sysCtx(fx.orgId, D);
  const row = {
    id: id('dqa'), org_id: ctx.orgId, lease_id: fx.leaseId, as_of_date: '1999-01-01', bucket: 'watch',
    prev_bucket: null, components: '{}', rule_fired: 'past_grace', reason: 'test', created_at: nowIso(),
  };
  insert('delinquency_assessments', row);
  assert.throws(() => insert('delinquency_assessments', { ...row, id: id('dqa') }));
  run('DELETE FROM delinquency_assessments WHERE lease_id=? AND as_of_date=?', fx.leaseId, '1999-01-01');
});

test('delinquency_scoring setting defaults to shadow mode with a 45-day notice threshold', () => {
  const ctx = sysCtx(fx.orgId, D);
  const s = getSetting<{ mode: string; noticeThresholdDays: number }>(ctx, 'delinquency_scoring');
  assert.ok(s, 'setting default missing');
  assert.equal(s.mode, 'shadow');
  assert.equal(s.noticeThresholdDays, 45);
});

// ---------- Task 2: assessDelinquency rules ----------

function inputs(over: Partial<DelinqInputs> = {}): DelinqInputs {
  return {
    openBalanceCents: 50000, monthlyRentCents: 150000, daysPastDue: 5,
    lateMonths12: 0, nsf6mo: 0, nsf60d: 0,
    brokenPlan12mo: false, activePlan: false, clearedPlanInstallment: false,
    paidLast14dCents: 0, graceDays: 3, noticeThresholdDays: 45,
    ...over,
  };
}

test('settled balance is clear and bypasses stepping even from escalate', () => {
  const a = assessDelinquency(inputs({ openBalanceCents: 0 }), 'escalate');
  assert.equal(a.bucket, 'clear');
  assert.equal(a.ruleFired, 'balance_clear');
  assert.equal(a.reason, 'Clear: balance settled.');
});

test('open balance inside the grace window is clear (not yet delinquent)', () => {
  const a = assessDelinquency(inputs({ daysPastDue: 2 }), null);
  assert.equal(a.bucket, 'clear');
  assert.equal(a.ruleFired, 'within_grace');
});

test('past grace with nothing else firing is watch', () => {
  const a = assessDelinquency(inputs(), null);
  assert.equal(a.bucket, 'watch');
  assert.equal(a.ruleFired, 'past_grace');
  assert.ok(a.reason.startsWith('Watch: past grace; balance 0.3× rent; 5 days past due.'), a.reason);
});

test('engage triggers: exposure ≥ 0.75×', () => {
  const a = assessDelinquency(inputs({ openBalanceCents: 120000 }), null);
  assert.equal(a.bucket, 'engage');
  assert.equal(a.ruleFired, 'exposure_75');
  assert.equal(a.reason, 'Engage: balance 0.8× rent; 5 days past due.');
});

test('engage triggers: age ≥ 15 days', () => {
  const a = assessDelinquency(inputs({ daysPastDue: 16 }), null);
  assert.equal(a.bucket, 'engage');
  assert.equal(a.ruleFired, 'age_15d');
});

test('engage triggers: 3 late months in trailing 12', () => {
  const a = assessDelinquency(inputs({ lateMonths12: 3 }), null);
  assert.equal(a.bucket, 'engage');
  assert.equal(a.ruleFired, 'pattern_3in12');
  assert.ok(a.reason.includes('3 late months in 12'), a.reason);
});

test('engage triggers: a single NSF in 6 months', () => {
  const a = assessDelinquency(inputs({ nsf6mo: 1 }), null);
  assert.equal(a.bucket, 'engage');
  assert.equal(a.ruleFired, 'nsf_one');
});

test('escalate triggers: exposure ≥ 2×', () => {
  const a = assessDelinquency(inputs({ openBalanceCents: 320000 }), null);
  assert.equal(a.bucket, 'escalate');
  assert.equal(a.ruleFired, 'exposure_2x');
});

test('escalate triggers: age past the notice threshold', () => {
  const a = assessDelinquency(inputs({ daysPastDue: 46 }), null);
  assert.equal(a.bucket, 'escalate');
  assert.equal(a.ruleFired, 'age_notice_threshold');
});

test('escalate triggers: broken plan, repeat NSF, chronic lateness', () => {
  assert.equal(assessDelinquency(inputs({ brokenPlan12mo: true }), null).ruleFired, 'plan_broken');
  assert.equal(assessDelinquency(inputs({ nsf6mo: 2 }), null).ruleFired, 'nsf_repeat');
  assert.equal(assessDelinquency(inputs({ lateMonths12: 5 }), null).ruleFired, 'chronic_late');
});

test('paying down ≥25% of the balance in 14 days holds the bucket one level down', () => {
  const a = assessDelinquency(inputs({ openBalanceCents: 320000, paidLast14dCents: 90000 }), null);
  assert.equal(a.bucket, 'engage');
  assert.equal(a.ruleFired, 'exposure_2x+paying_down');
  assert.ok(a.reason.includes('held one level down'), a.reason);
});

test('the paydown modifier never demotes below watch', () => {
  const a = assessDelinquency(inputs({ paidLast14dCents: 40000 }), null);
  assert.equal(a.bucket, 'watch');
});

test('upgrades jump levels in a single day', () => {
  const a = assessDelinquency(inputs({ openBalanceCents: 320000, daysPastDue: 50 }), 'watch');
  assert.equal(a.bucket, 'escalate');
});

test('escalate holds without a plan even when raw score recovers', () => {
  const a = assessDelinquency(inputs(), 'escalate'); // raw watch
  assert.equal(a.bucket, 'escalate');
  assert.equal(a.ruleFired, 'hold_recovery_pending');
  assert.ok(a.reason.startsWith('Escalate held (recovery pending)'), a.reason);
});

test('escalate steps down exactly one level once a plan is active with a cleared installment', () => {
  const a = assessDelinquency(inputs({ activePlan: true, clearedPlanInstallment: true }), 'escalate'); // raw watch
  assert.equal(a.bucket, 'engage'); // never skips to watch
  assert.equal(a.ruleFired, 'recovery_plan_started');
});

test('engage steps down to watch only below 0.25× rent with 60 NSF-free days', () => {
  const ok = assessDelinquency(inputs({ openBalanceCents: 30000 }), 'engage');
  assert.equal(ok.bucket, 'watch');
  assert.equal(ok.ruleFired, 'recovery_paid_down');
  const blocked = assessDelinquency(inputs({ openBalanceCents: 30000, nsf60d: 1 }), 'engage');
  assert.equal(blocked.bucket, 'engage');
  assert.equal(blocked.ruleFired, 'hold_recovery_pending');
});

test('components record every input plus computed exposure', () => {
  const a = assessDelinquency(inputs({ openBalanceCents: 120000 }), null);
  assert.equal(a.components.exposure, 0.8);
  assert.equal(a.components.graceDays, 3);
});

// ---------- Task 3: input assembly from the ledger ----------

function mkScoringLease(rent = 150000): { id: string; rent_cents: number; property_id: string } {
  const leaseId = id('lse');
  insert('leases', {
    id: leaseId, org_id: fx.orgId, property_id: fx.propId, unit_id: fx.unitId, household_name: `Score-${leaseId.slice(-5)}`,
    status: 'active', start_date: '2026-01-01', end_date: '2026-12-31', move_in_date: '2026-01-01',
    rent_cents: rent, deposit_cents: 0, term_months: 12, created_at: nowIso(),
  });
  const rid = id('res');
  insert('residents', {
    id: rid, org_id: fx.orgId, property_id: fx.propId, first_name: 'Score', last_name: leaseId.slice(-5),
    email: `${leaseId.slice(-8)}@score.test`, phone: '(555) 300-1000', kind: 'adult', created_at: nowIso(),
  });
  insert('household_members', { id: id('hm'), org_id: fx.orgId, lease_id: leaseId, resident_id: rid, role: 'primary', created_at: nowIso() });
  return { id: leaseId, rent_cents: rent, property_id: fx.propId };
}

function rawCharge(leaseId: string, kind: string, amount: number, due: string, monthKey?: string | null): void {
  insert('charges', {
    id: id('chg'), org_id: fx.orgId, property_id: fx.propId, lease_id: leaseId, kind, label: kind,
    amount_cents: amount, date: due, due_date: due, month_key: monthKey ?? null, source: 'oneoff', status: 'active', created_at: nowIso(),
  });
}

function rawPayment(leaseId: string, amount: number, status: string, received: string, nsfDate?: string): void {
  insert('payments', {
    id: id('pay'), org_id: fx.orgId, property_id: fx.propId, lease_id: leaseId, method: 'ach',
    amount_cents: amount, fee_cents: 0, status, received_date: received, nsf_date: nsfDate ?? null,
    autopay: 0, created_at: nowIso(),
  });
}

test('computeDelinquencyInputs reads balance, age, pattern, NSF, and paydown from the ledger', () => {
  const ctx = sysCtx(fx.orgId, D); // 2026-07-26
  const lease = mkScoringLease();
  rawCharge(lease.id, 'rent', 150000, '2026-06-01', '2026-06');
  rawCharge(lease.id, 'rent', 150000, '2026-07-01', '2026-07');
  rawCharge(lease.id, 'late_fee', 5000, '2026-06-05', '2026-04');
  rawCharge(lease.id, 'late_fee', 5000, '2026-06-05', '2026-05');
  rawCharge(lease.id, 'late_fee', 5000, '2026-06-05', '2026-06');
  rawPayment(lease.id, 100000, 'nsf', '2026-07-08', '2026-07-10');
  rawPayment(lease.id, 30000, 'settled', '2026-07-20');

  const inp = computeDelinquencyInputs(ctx, lease);
  assert.equal(inp.openBalanceCents, 315000 - 30000);
  assert.equal(inp.daysPastDue, 55); // oldest underpaid due date 2026-06-01
  assert.equal(inp.lateMonths12, 3); // distinct late-fee month_keys
  assert.equal(inp.nsf6mo, 1);
  assert.equal(inp.nsf60d, 1);
  assert.equal(inp.paidLast14dCents, 30000); // NSF money never counts
  assert.equal(inp.brokenPlan12mo, false);
  assert.equal(inp.activePlan, false);
  assert.equal(inp.graceDays, 3);
  assert.equal(inp.noticeThresholdDays, 45);
});

test('a current lease produces zeroed inputs', () => {
  const ctx = sysCtx(fx.orgId, D);
  const lease = mkScoringLease();
  const inp = computeDelinquencyInputs(ctx, lease);
  assert.equal(inp.openBalanceCents, 0);
  assert.equal(inp.daysPastDue, 0);
  assert.equal(inp.lateMonths12, 0);
});

// ---------- Task 4: score_delinquency job ----------

test('score_delinquency job scores delinquent leases idempotently and tracks transitions', () => {
  const ctx = sysCtx(fx.orgId, D);
  const def = jobDefs().find((d) => d.key === 'score_delinquency');
  assert.ok(def, 'job not registered');

  const engageLease = mkScoringLease();
  rawCharge(engageLease.id, 'rent', 150000, '2026-07-01', '2026-07'); // 25d past due, 1.0× rent

  const summary1 = def!.run(ctx, D) as string;
  assert.ok(summary1.includes('engage'), summary1);
  const rows1 = q<any>(`SELECT * FROM delinquency_assessments WHERE lease_id=? AND as_of_date=?`, engageLease.id, D);
  assert.equal(rows1.length, 1);
  assert.equal(rows1[0].bucket, 'engage');
  assert.equal(rows1[0].prev_bucket, null);

  // idempotent: same day re-run refreshes, never duplicates
  def!.run(ctx, D);
  assert.equal(q<any>(`SELECT * FROM delinquency_assessments WHERE lease_id=? AND as_of_date=?`, engageLease.id, D).length, 1);

  // next business day records the transition source
  const D2 = addDays(D, 1);
  def!.run(sysCtx(fx.orgId, D2), D2);
  const row2 = q1<any>(`SELECT * FROM delinquency_assessments WHERE lease_id=? AND as_of_date=?`, engageLease.id, D2);
  assert.equal(row2.prev_bucket, 'engage');
  assert.equal(latestAssessment(sysCtx(fx.orgId, D2), engageLease.id)!.as_of_date, D2);

  // paid in full → a final clear row, then the lease drops out of scoring
  rawPayment(engageLease.id, 150000, 'settled', D2);
  const D3 = addDays(D, 2);
  def!.run(sysCtx(fx.orgId, D3), D3);
  const row3 = q1<any>(`SELECT * FROM delinquency_assessments WHERE lease_id=? AND as_of_date=?`, engageLease.id, D3);
  assert.equal(row3.bucket, 'clear');
  const D4 = addDays(D, 3);
  def!.run(sysCtx(fx.orgId, D4), D4);
  assert.equal(q1<any>(`SELECT * FROM delinquency_assessments WHERE lease_id=? AND as_of_date=?`, engageLease.id, D4), undefined);
});

test('current leases with no history are never scored', () => {
  const ctx = sysCtx(fx.orgId, D);
  const cleanLease = mkScoringLease();
  const creditLease = mkScoringLease();
  rawPayment(creditLease.id, 20000, 'settled', D); // credit balance, no history
  jobDefs().find((d) => d.key === 'score_delinquency')!.run(ctx, D);
  assert.equal(q1<any>(`SELECT * FROM delinquency_assessments WHERE lease_id=?`, cleanLease.id), undefined);
  assert.equal(q1<any>(`SELECT * FROM delinquency_assessments WHERE lease_id=?`, creditLease.id), undefined);
});

// ---------- Task 5: payments agent consumes the scorer (active mode only) ----------

function actionsFor(leaseId: string): any[] {
  return q<any>(`SELECT * FROM ai_actions WHERE entity_id=? AND agent='payments' ORDER BY created_at`, leaseId)
    .map((a) => ({ ...a, out: j<any>(a.output, {}) }));
}
const scoreJob = () => jobDefs().find((d) => d.key === 'score_delinquency')!;

test('shadow mode leaves the collections draft byte-for-byte legacy', () => {
  const ctx = sysCtx(fx.orgId, D);
  const lease = mkScoringLease();
  rawCharge(lease.id, 'rent', 150000, '2026-06-01', '2026-06');
  rawCharge(lease.id, 'rent', 180000, '2026-07-01', '2026-07'); // 2.2× rent, 55d — escalate territory
  scoreJob().run(ctx, D);
  assert.equal(latestAssessment(ctx, lease.id)!.bucket, 'escalate');

  const r = draftCollectionsOutreach(ctx, lease.id);
  assert.ok(r);
  const acts = actionsFor(lease.id);
  const kinds = acts.map((a) => a.out.kind);
  assert.ok(kinds.includes('payments.send_outreach'), 'legacy outreach missing');
  assert.ok(kinds.includes('payments.create_plan'), 'legacy plan missing');
  assert.ok(!kinds.includes('payments.escalation_packet'), 'shadow must not escalate');
  const outreach = acts.find((a) => a.out.kind === 'payments.send_outreach');
  assert.ok(outreach.title.startsWith('Final'), outreach.title); // legacy dunning ladder untouched
});

test('active mode: watch drafts friendly and never pressures with a plan', () => {
  const ctx = sysCtx(fx.orgId, D);
  setSetting(ctx, 'delinquency_scoring', { mode: 'active', noticeThresholdDays: 45 });
  try {
    const lease = mkScoringLease();
    rawCharge(lease.id, 'other', 50000, addDays(D, -10)); // 10d past grace, 0.3× — watch
    scoreJob().run(ctx, D);
    assert.equal(latestAssessment(ctx, lease.id)!.bucket, 'watch');
    draftCollectionsOutreach(ctx, lease.id);
    const acts = actionsFor(lease.id);
    const outreach = acts.find((a) => a.out.kind === 'payments.send_outreach');
    assert.ok(outreach.title.startsWith('Friendly'), outreach.title);
    assert.ok(outreach.rationale.includes('delinquency scorer'), outreach.rationale);
    assert.equal(acts.filter((a) => a.out.kind === 'payments.create_plan').length, 0, 'watch must not offer a plan');
  } finally {
    setSetting(ctx, 'delinquency_scoring', { mode: 'shadow', noticeThresholdDays: 45 });
  }
});

test('active mode: engage drafts firm with the plan offer', () => {
  const ctx = sysCtx(fx.orgId, D);
  setSetting(ctx, 'delinquency_scoring', { mode: 'active', noticeThresholdDays: 45 });
  try {
    const lease = mkScoringLease();
    rawCharge(lease.id, 'rent', 150000, addDays(D, -20), '2026-07'); // 20d, 1.0× — engage
    scoreJob().run(ctx, D);
    assert.equal(latestAssessment(ctx, lease.id)!.bucket, 'engage');
    draftCollectionsOutreach(ctx, lease.id);
    const acts = actionsFor(lease.id);
    assert.ok(acts.find((a) => a.out.kind === 'payments.send_outreach').title.startsWith('Firm'));
    assert.equal(acts.filter((a) => a.out.kind === 'payments.create_plan').length, 1);
  } finally {
    setSetting(ctx, 'delinquency_scoring', { mode: 'shadow', noticeThresholdDays: 45 });
  }
});

test('active mode: escalate suppresses all resident-facing prose and packets for a human', () => {
  const ctx = sysCtx(fx.orgId, D);
  setSetting(ctx, 'delinquency_scoring', { mode: 'active', noticeThresholdDays: 45 });
  setSetting(ctx, 'ai_autonomy', { leasing: 'approve', maintenance: 'approve', payments: 'auto', renewals: 'draft' });
  try {
    const lease = mkScoringLease();
    rawCharge(lease.id, 'rent', 150000, '2026-06-01', '2026-06');
    rawCharge(lease.id, 'rent', 180000, '2026-07-01', '2026-07');
    scoreJob().run(ctx, D);
    assert.equal(latestAssessment(ctx, lease.id)!.bucket, 'escalate');
    draftCollectionsOutreach(ctx, lease.id);
    const acts = actionsFor(lease.id);
    assert.equal(acts.filter((a) => a.out.kind === 'payments.send_outreach').length, 0, 'no resident-facing prose');
    assert.equal(acts.filter((a) => a.out.kind === 'payments.create_plan').length, 0);
    const packet = acts.find((a) => a.out.kind === 'payments.escalation_packet');
    assert.ok(packet, 'packet missing');
    assert.equal(packet.confidence, 0.6);
    assert.equal(packet.status, 'proposed'); // pinned below the 0.7 auto floor even on an auto dial
    assert.ok(packet.out.summary.includes('human review'), packet.out.summary);

    executeAction(ctx, packet.id);
    const cases = q<any>(`SELECT * FROM collection_cases WHERE lease_id=? AND status='open'`, lease.id);
    assert.equal(cases.length, 1);
  } finally {
    setSetting(ctx, 'delinquency_scoring', { mode: 'shadow', noticeThresholdDays: 45 });
    setSetting(ctx, 'ai_autonomy', { leasing: 'approve', maintenance: 'approve', payments: 'draft', renewals: 'draft' });
  }
});

// ---------- Task 6: renewal offers held for escalated delinquency ----------

test('active mode holds renewal offers for escalated households; shadow does not', () => {
  const ctx = sysCtx(fx.orgId, D);
  const mkEscalated = () => {
    const lease = mkScoringLease();
    rawCharge(lease.id, 'rent', 150000, '2026-06-01', '2026-06');
    rawCharge(lease.id, 'rent', 180000, '2026-07-01', '2026-07');
    scoreJob().run(ctx, D);
    assert.equal(latestAssessment(ctx, lease.id)!.bucket, 'escalate');
    return lease;
  };

  // shadow: exactly today's behavior
  const shadowLease = mkEscalated();
  const offerId = createRenewalOffer(ctx, shadowLease.id);
  assert.ok(offerId);
  assert.ok(draftRenewalOutreach(ctx, shadowLease.id));

  // active: held
  setSetting(ctx, 'delinquency_scoring', { mode: 'active', noticeThresholdDays: 45 });
  try {
    const heldLease = mkEscalated();
    assert.throws(() => createRenewalOffer(ctx, heldLease.id), /renewal held/);
    assert.equal(draftRenewalOutreach(ctx, heldLease.id), null);
    assert.equal(q1<any>(`SELECT id FROM renewal_offers WHERE lease_id=?`, heldLease.id), undefined);

    // engage does NOT hold the offer
    const engageLease = mkScoringLease();
    rawCharge(engageLease.id, 'rent', 150000, addDays(D, -20), '2026-07');
    scoreJob().run(ctx, D);
    assert.equal(latestAssessment(ctx, engageLease.id)!.bucket, 'engage');
    assert.ok(createRenewalOffer(ctx, engageLease.id));
  } finally {
    setSetting(ctx, 'delinquency_scoring', { mode: 'shadow', noticeThresholdDays: 45 });
  }
});

// ---------- Task 7: workbench score chips ----------

test('the delinquency workbench shows score chips in plain English, with the reason behind them', async () => {
  const ctx = sysCtx(fx.orgId, D);
  // an escalated household to render
  const lease = mkScoringLease();
  rawCharge(lease.id, 'rent', 150000, '2026-06-01', '2026-06');
  rawCharge(lease.id, 'rent', 180000, '2026-07-01', '2026-07');
  scoreJob().run(ctx, D);

  const uid = id('usr');
  const email = `admin-scoring-${uid.slice(-6)}@test.demo`;
  insert('users', {
    id: uid, org_id: fx.orgId, email, name: 'Scoring Admin', kind: 'staff',
    password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
  });
  insert('role_assignments', { id: id('ra'), org_id: fx.orgId, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });

  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, email);
    const page = await get(base, '/delinquency', cookie);
    assert.equal(page.status, 200);
    assert.match(page.text, /class="badge bad" title="Escalate/, 'escalate chip with reason tooltip missing');
    // The chip says what to DO, not which internal bucket the scorer picked.
    // The mode the scorer runs in is a setting, not a caption on the operator's
    // workbench (2026-08-18: no developer state in the product).
    assert.match(page.text, />Needs a call</, 'the chip reads as an instruction, not a bucket name');
    assert.doesNotMatch(page.text, /scoring: shadow/, 'internal scorer mode must not be reported in the product');
    assert.doesNotMatch(page.text, /chips inform|behavior unchanged/);
  } finally {
    close();
  }
});

// ========== Scorer #2: lead heat ==========

function mkLead(over: Record<string, any> = {}): string {
  const lid = id('led');
  insert('leads', {
    id: lid, org_id: fx.orgId, property_id: fx.propId, first_name: 'Heat', last_name: lid.slice(-5),
    email: `${lid.slice(-8)}@lead.test`, phone: null, source: 'website', channel: 'web', status: 'new',
    desired_move_in: null, beds: 2, budget_cents: null, message: 'Hi, is a 2 bedroom available?',
    assigned_to_user_id: null, application_id: null, lease_id: null, lost_reason: null,
    last_activity_at: nowIso(), created_date: D, created_at: nowIso(), ...over,
  });
  return lid;
}

test('detectLeadIntent lives in the lib and still reads intents', () => {
  const i = detectLeadIntent('Could we tour the unit tomorrow? What is the rent?');
  assert.equal(i.wantsTour, true);
  assert.equal(i.asksPrice, true);
  assert.equal(i.wantsHuman, false);
});

test('lead_assessments table exists with unique (lead_id, as_of_date) index', () => {
  const lid = mkLead();
  const row = {
    id: id('lqa'), org_id: fx.orgId, lead_id: lid, as_of_date: '1999-01-01', bucket: 'warm',
    prev_bucket: null, components: '{}', rule_fired: 'warm_engaged', reason: 'test', created_at: nowIso(),
  };
  insert('lead_assessments', row);
  assert.throws(() => insert('lead_assessments', { ...row, id: id('lqa') }));
  run('DELETE FROM lead_assessments WHERE lead_id=?', lid);
});

test('lead_scoring setting defaults to shadow mode', () => {
  const ctx = sysCtx(fx.orgId, D);
  assert.equal(getSetting<{ mode: string }>(ctx, 'lead_scoring').mode, 'shadow');
});

// ---------- assessLeadHeat rules ----------

function heatInputs(over: Partial<LeadHeatInputs> = {}): LeadHeatInputs {
  return {
    wantsTour: false, asksPrice: false, asksAvailability: true, asksPets: false, wantsHuman: false,
    fitNow: true, fitComing: false, fitBeds: 2, upcomingTour: false,
    inboundCount: 1, inboundLast24h: 0, hoursSinceInbound: 5, daysSinceInbound: 0,
    openCadenceTasks: 4, ageDays: 0, source: 'website',
    ...over,
  };
}

test('tour intent + inventory fit + recent inbound is hot', () => {
  const a = assessLeadHeat(heatInputs({ wantsTour: true }), null);
  assert.equal(a.bucket, 'hot');
  assert.equal(a.ruleFired, 'hot_engaged_fit');
  assert.ok(a.reason.startsWith('Hot: asked to tour; fit now'), a.reason);
});

test('a booked upcoming tour counts as hot even without a fresh tour ask', () => {
  const a = assessLeadHeat(heatInputs({ upcomingTour: true }), null);
  assert.equal(a.bucket, 'hot');
  assert.equal(a.ruleFired, 'hot_engaged_fit');
});

test('two inbound messages in 24h are hot regardless of fit', () => {
  const a = assessLeadHeat(heatInputs({ inboundLast24h: 2, fitNow: false, fitComing: true }), null);
  assert.equal(a.bucket, 'hot');
  assert.equal(a.ruleFired, 'hot_rapid_inbound');
});

test('no fit now and none coming is cold', () => {
  const a = assessLeadHeat(heatInputs({ fitNow: false, fitComing: false }), null);
  assert.equal(a.bucket, 'cold');
  assert.equal(a.ruleFired, 'cold_no_fit');
  assert.ok(a.reason.includes('no 2-bed ready or on notice'), a.reason);
});

test('14 days of silence is cold; exhausted cadence at 7 days is cold', () => {
  assert.equal(assessLeadHeat(heatInputs({ daysSinceInbound: 14, hoursSinceInbound: 336 }), null).ruleFired, 'cold_stale');
  assert.equal(assessLeadHeat(heatInputs({ openCadenceTasks: 0, daysSinceInbound: 7, hoursSinceInbound: 168 }), null).ruleFired, 'cold_cadence_exhausted');
});

test('engaged with fit but no tour ask is warm', () => {
  const a = assessLeadHeat(heatInputs(), null);
  assert.equal(a.bucket, 'warm');
  assert.equal(a.ruleFired, 'warm_engaged');
});

test('tour ask with stale engagement is not hot (recency gate)', () => {
  const a = assessLeadHeat(heatInputs({ wantsTour: true, hoursSinceInbound: 100, daysSinceInbound: 4 }), null);
  assert.equal(a.bucket, 'warm');
});

test('upgrades jump: cold yesterday, rapid inbound today goes straight to hot', () => {
  const a = assessLeadHeat(heatInputs({ inboundLast24h: 2 }), 'cold');
  assert.equal(a.bucket, 'hot');
});

test('decay steps one level per day: hot cools to warm, never straight to cold', () => {
  const a = assessLeadHeat(heatInputs({ fitNow: false, fitComing: false, daysSinceInbound: 20, hoursSinceInbound: 480 }), 'hot');
  assert.equal(a.bucket, 'warm');
  assert.equal(a.ruleFired, 'step_decay');
  assert.ok(a.reason.startsWith('Warm (cooling)'), a.reason);
  const b = assessLeadHeat(heatInputs({ fitNow: false, fitComing: false, daysSinceInbound: 21, hoursSinceInbound: 504 }), 'warm');
  assert.equal(b.bucket, 'cold');
});

// ---------- computeLeadInputs + fair-housing invariance ----------

function mkFitUnit(beds = 2): void {
  const fpId = id('flp');
  insert('floorplans', {
    id: fpId, org_id: fx.orgId, property_id: fx.propId, name: `B${beds}`, beds, baths: 1,
    sqft: 900, market_rent_cents: 150000, created_at: nowIso(),
  });
  insert('units', {
    id: id('unt'), org_id: fx.orgId, property_id: fx.propId, floorplan_id: fpId, unit_number: `H-${id('x').slice(-4)}`,
    floor: 1, sqft: 900, status: 'vacant_ready', market_rent_cents: 150000, amenities: '[]', created_at: nowIso(),
  });
}

test('computeLeadInputs reads intents, fit, engagement, and cadence from operational data', () => {
  const ctx = sysCtx(fx.orgId, D);
  mkFitUnit(2);
  const lid = mkLead({ message: 'Hi! Could we tour a 2 bedroom this week? What is the rent?' });
  insert('lead_events', {
    id: id('lev'), org_id: fx.orgId, lead_id: lid, kind: 'email_in', body: 'Also — is parking available?',
    actor: 'lead', at: new Date(Date.now() - 3 * 3600_000).toISOString(), business_date: D,
  });
  insert('followup_tasks', {
    id: id('flt'), org_id: fx.orgId, property_id: fx.propId, lead_id: lid, kind: 'day_1',
    due_date: addDays(D, 1), status: 'open', created_at: nowIso(),
  });
  const inp = computeLeadInputs(ctx, q1<any>('SELECT * FROM leads WHERE id=?', lid));
  assert.equal(inp.wantsTour, true);
  assert.equal(inp.asksPrice, true);
  assert.equal(inp.fitNow, true);
  assert.equal(inp.fitBeds, 2);
  assert.equal(inp.inboundCount, 1);
  assert.equal(inp.inboundLast24h, 1);
  assert.ok(inp.hoursSinceInbound >= 2 && inp.hoursSinceInbound <= 4, String(inp.hoursSinceInbound));
  assert.equal(inp.openCadenceTasks, 1);
  assert.equal(inp.source, 'website');
});

test('FAIR HOUSING: a voucher mention changes nothing — inputs and bucket are identical', () => {
  const ctx = sysCtx(fx.orgId, D);
  const base = 'Could we tour a 2 bedroom tomorrow?';
  const a = mkLead({ message: base });
  const b = mkLead({ message: base + ' We have a Section 8 housing voucher.' });
  const ia = computeLeadInputs(ctx, q1<any>('SELECT * FROM leads WHERE id=?', a));
  const ib = computeLeadInputs(ctx, q1<any>('SELECT * FROM leads WHERE id=?', b));
  assert.deepEqual(ia, ib, 'voucher mention must not change a single input');
  assert.equal(assessLeadHeat(ia, null).bucket, assessLeadHeat(ib, null).bucket);
  assert.ok(!JSON.stringify(ia).toLowerCase().includes('voucher'), 'no message text may enter the components');
});

test('a lead with no inbound events measures silence from its creation date', () => {
  const ctx = sysCtx(fx.orgId, addDays(D, 5));
  const lid = mkLead({ created_date: D, message: 'thinking about moving' });
  const inp = computeLeadInputs(ctx, q1<any>('SELECT * FROM leads WHERE id=?', lid));
  assert.equal(inp.daysSinceInbound, 5);
  assert.equal(inp.inboundCount, 0);
});

test('an upcoming scheduled tour is visible to the scorer', () => {
  const ctx = sysCtx(fx.orgId, D);
  const lid = mkLead();
  insert('tours', {
    id: id('tur'), org_id: fx.orgId, property_id: fx.propId, lead_id: lid, unit_id: null,
    type: 'in_person', date: addDays(D, 1), start_time: '09:00', status: 'scheduled', created_at: nowIso(),
  });
  assert.equal(computeLeadInputs(ctx, q1<any>('SELECT * FROM leads WHERE id=?', lid)).upcomingTour, true);
});

// ---------- score_lead job + event-driven rescoring ----------

test('score_lead job scores open-pipeline leads idempotently and skips leased/lost', () => {
  const ctx = sysCtx(fx.orgId, D);
  const def = jobDefs().find((d) => d.key === 'score_lead');
  assert.ok(def, 'job not registered');
  const open = mkLead({ message: 'Could we tour a 2 bedroom?' });
  const done = mkLead({ status: 'leased' });
  const summary = def!.run(ctx, D) as string;
  assert.ok(summary.includes('hot') || summary.includes('warm') || summary.includes('cold'), summary);
  def!.run(ctx, D);
  assert.equal(q<any>(`SELECT * FROM lead_assessments WHERE lead_id=? AND as_of_date=?`, open, D).length, 1);
  assert.equal(q1<any>(`SELECT * FROM lead_assessments WHERE lead_id=?`, done), undefined);
  assert.ok(latestLeadAssessment(ctx, open));
});

test('a new inquiry is scored the moment it arrives (event-driven, no job run)', () => {
  const ctx = sysCtx(fx.orgId, D);
  const { leadId } = intakeLead(ctx, {
    propertyId: fx.propId, firstName: 'Event', lastName: 'Driven', email: `evt-${id('x').slice(-6)}@lead.test`,
    source: 'website', channel: 'web', message: 'Can I tour a 2 bedroom tomorrow morning?', beds: 2,
  });
  const row = q1<any>(`SELECT * FROM lead_assessments WHERE lead_id=?`, leadId);
  assert.ok(row, 'lead.created hook did not score');
  assert.equal(row.as_of_date, D);
});

// ---------- chips (shadow) + ordering/call task (active) ----------

function mkStaff(): string {
  const uid = id('usr');
  const email = `admin-heat-${uid.slice(-6)}@test.demo`;
  insert('users', {
    id: uid, org_id: fx.orgId, email, name: 'Heat Admin', kind: 'staff',
    password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
  });
  insert('role_assignments', { id: id('ra'), org_id: fx.orgId, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  return email;
}

test('lead inbox shows heat chips with reasons, in words a leasing agent uses', async () => {
  const ctx = sysCtx(fx.orgId, D);
  mkFitUnit(2);
  const hot = mkLead({ message: 'Can we tour a 2 bedroom this week?' });
  insert('lead_events', {
    id: id('lev'), org_id: fx.orgId, lead_id: hot, kind: 'email_in', body: 'still interested in the tour!',
    actor: 'lead', at: new Date(Date.now() - 2 * 3600_000).toISOString(), business_date: D,
  });
  jobDefs().find((d) => d.key === 'score_lead')!.run(ctx, D);
  assert.equal(latestLeadAssessment(ctx, hot)!.bucket, 'hot');

  const email = mkStaff();
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, email);
    const page = await get(base, '/leads', cookie);
    assert.equal(page.status, 200);
    assert.match(page.text, /class="badge accent" title="Hot/, 'hot chip with reason missing');
    assert.match(page.text, />Hot lead</, 'the chip is labelled, not a raw bucket');
    assert.doesNotMatch(page.text, /scoring: shadow/, 'internal scorer mode must not be reported in the product');
  } finally {
    close();
  }
});

test('active mode orders the Leasing Center hot-first and opens one call task for silent hot leads', async () => {
  const ctx = sysCtx(fx.orgId, D);
  setSetting(ctx, 'lead_scoring', { mode: 'active' });
  try {
    mkFitUnit(2);
    const warmLead = mkLead({ first_name: 'Warmly', message: 'what is the rent on a 2 bedroom?' });
    const hotLead = mkLead({ first_name: 'Hotly', message: 'I want to tour a 2 bedroom!' });
    // silence setup: inbound 30h ago, our outbound 28h ago, nothing since
    insert('lead_events', {
      id: id('lev'), org_id: fx.orgId, lead_id: hotLead, kind: 'email_in', body: 'tour please',
      actor: 'lead', at: new Date(Date.now() - 30 * 3600_000).toISOString(), business_date: D,
    });
    insert('lead_events', {
      id: id('lev'), org_id: fx.orgId, lead_id: hotLead, kind: 'email_out', body: 'sure — when works?',
      actor: 'staff', at: new Date(Date.now() - 28 * 3600_000).toISOString(), business_date: D,
    });
    for (const lid of [warmLead, hotLead]) {
      insert('followup_tasks', {
        id: id('flt'), org_id: fx.orgId, property_id: fx.propId, lead_id: lid, kind: 'day_1',
        due_date: D, status: 'open', created_at: nowIso(),
      });
    }
    const def = jobDefs().find((d) => d.key === 'score_lead')!;
    def.run(ctx, D);
    assert.equal(latestLeadAssessment(ctx, hotLead)!.bucket, 'hot');
    assert.equal(latestLeadAssessment(ctx, warmLead)!.bucket, 'warm');

    // exactly one call task, idempotent across re-runs
    def.run(ctx, D);
    const callTasks = q<any>(`SELECT * FROM followup_tasks WHERE lead_id=? AND kind='ai:call_hot_lead' AND status='open'`, hotLead);
    assert.equal(callTasks.length, 1, 'expected exactly one call task');

    const email = mkStaff();
    const { base, close } = await startTestServer();
    try {
      const cookie = await loginAs(base, email);
      const page = await get(base, '/leasing-center', cookie);
      assert.equal(page.status, 200);
      const iHot = page.text.indexOf('Hotly');
      const iWarm = page.text.indexOf('Warmly');
      assert.ok(iHot > -1 && iWarm > -1, 'both leads should be in the queue');
      assert.ok(iHot < iWarm, 'hot lead must sort above warm in active mode');
    } finally {
      close();
    }
  } finally {
    setSetting(ctx, 'lead_scoring', { mode: 'shadow' });
  }
});

test('shadow mode never creates call tasks', () => {
  const ctx = sysCtx(fx.orgId, D);
  mkFitUnit(2);
  const lid = mkLead({ message: 'tour a 2 bedroom please' });
  insert('lead_events', {
    id: id('lev'), org_id: fx.orgId, lead_id: lid, kind: 'email_in', body: 'hello?',
    actor: 'lead', at: new Date(Date.now() - 30 * 3600_000).toISOString(), business_date: D,
  });
  insert('lead_events', {
    id: id('lev'), org_id: fx.orgId, lead_id: lid, kind: 'email_out', body: 'hi!',
    actor: 'staff', at: new Date(Date.now() - 28 * 3600_000).toISOString(), business_date: D,
  });
  jobDefs().find((d) => d.key === 'score_lead')!.run(ctx, D);
  assert.equal(q<any>(`SELECT * FROM followup_tasks WHERE lead_id=? AND kind='ai:call_hot_lead'`, lid).length, 0);
});
