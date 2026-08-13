import { q, q1, val, run, insert, js } from '../../lib/db.ts';
import { addDays, nowIso } from '../../lib/dates.ts';
import { sysCtx, type Ctx } from '../../lib/auth.ts';
import { id } from '../../lib/ids.ts';
import { registerJob } from '../../lib/jobs.ts';
import { on } from '../../lib/events.ts';
import { getSettingMerged, scorerMode } from '../../lib/settings.ts';
import { detectLeadIntent, type LeadIntent } from '../../lib/lead_intent.ts';
import { leaseBalance } from '../m8_receivables/service.ts';

/** M19 — Agent scoring. Scorer #1: delinquency.
 *
 * The architecture (see docs/superpowers/plans/2026-08-11-delinquency-scorer.md
 * and the project's agent-scoring spec): every agent's decision metric lives in
 * a deterministic scorer OUTSIDE the agent, persisted per entity per business
 * day, with a named rule and a human-readable reason. Agents read the latest
 * row as a fact; they compute nothing. Rules score, models phrase, humans
 * decide the regulated moments. No LLM call is permitted in this module.
 */

export type DelinqBucket = 'clear' | 'watch' | 'engage' | 'escalate';

export interface DelinqInputs {
  openBalanceCents: number;
  monthlyRentCents: number;
  daysPastDue: number;
  lateMonths12: number;
  nsf6mo: number;
  nsf60d: number;
  brokenPlan12mo: boolean;
  activePlan: boolean;
  clearedPlanInstallment: boolean;
  paidLast14dCents: number;
  graceDays: number;
  noticeThresholdDays: number;
}

export interface DelinqAssessment {
  bucket: DelinqBucket;
  ruleFired: string;
  reason: string;
  components: DelinqInputs & { exposure: number };
}

const RANK: Record<DelinqBucket, number> = { clear: 0, watch: 1, engage: 2, escalate: 3 };
const cap = (b: DelinqBucket): string => b[0]!.toUpperCase() + b.slice(1);

/** Deterministic reason sentence: the fired rule's clause first, then the
 * standard context clauses (exposure, age, pattern, NSF, plan) without
 * duplicating the lead clause. This exact string is what staff sees on the
 * workbench chip and the only severity fact an agent may quote. */
function reasonFor(bucket: DelinqBucket, rule: string, exposure: number, inp: DelinqInputs): string {
  const expClause = `balance ${exposure.toFixed(1)}× rent`;
  const ageClause = `${inp.daysPastDue} days past due`;
  const patClause = `${inp.lateMonths12} late months in 12`;
  const nsfClause = `${inp.nsf6mo} NSF in 6 months`;
  const planClause = 'payment plan broken';
  const lead: Record<string, string> = {
    past_grace: 'past grace',
    exposure_75: expClause, exposure_2x: expClause,
    age_15d: ageClause, age_notice_threshold: ageClause,
    pattern_3in12: patClause, chronic_late: patClause,
    nsf_one: nsfClause, nsf_repeat: nsfClause,
    plan_broken: planClause,
  };
  const clauses = [lead[rule] || rule];
  for (const c of [expClause, ageClause]) if (!clauses.includes(c)) clauses.push(c);
  if (inp.lateMonths12 > 0 && !clauses.includes(patClause)) clauses.push(patClause);
  if (inp.nsf6mo > 0 && !clauses.includes(nsfClause)) clauses.push(nsfClause);
  if (inp.brokenPlan12mo && !clauses.includes(planClause)) clauses.push(planClause);
  return `${cap(bucket)}: ${clauses.join('; ')}.`;
}

/** Scorer #1 rules. First match wins; upgrades jump, downgrades step one
 * level per assessment and require explicit recovery criteria; a settled
 * balance bypasses stepping entirely (paid in full is a fact, not an opinion). */
export function assessDelinquency(inp: DelinqInputs, prevBucket: DelinqBucket | null): DelinqAssessment {
  const ratio = inp.monthlyRentCents > 0 ? inp.openBalanceCents / inp.monthlyRentCents : 0;
  const exposure = Math.round(ratio * 100) / 100;
  const components = { ...inp, exposure };

  if (inp.openBalanceCents <= 0) {
    return { bucket: 'clear', ruleFired: 'balance_clear', reason: 'Clear: balance settled.', components };
  }
  if (inp.daysPastDue <= inp.graceDays) {
    return {
      bucket: 'clear', ruleFired: 'within_grace',
      reason: `Clear: within the ${inp.graceDays}-day grace window (${inp.daysPastDue} days past due).`, components,
    };
  }

  // raw bucket, first rule wins
  let bucket: DelinqBucket = 'watch';
  let rule = 'past_grace';
  if (ratio >= 2.0) { bucket = 'escalate'; rule = 'exposure_2x'; }
  else if (inp.daysPastDue >= inp.noticeThresholdDays) { bucket = 'escalate'; rule = 'age_notice_threshold'; }
  else if (inp.brokenPlan12mo) { bucket = 'escalate'; rule = 'plan_broken'; }
  else if (inp.nsf6mo >= 2) { bucket = 'escalate'; rule = 'nsf_repeat'; }
  else if (inp.lateMonths12 >= 5) { bucket = 'escalate'; rule = 'chronic_late'; }
  else if (ratio >= 0.75) { bucket = 'engage'; rule = 'exposure_75'; }
  else if (inp.daysPastDue >= 15) { bucket = 'engage'; rule = 'age_15d'; }
  else if (inp.lateMonths12 >= 3) { bucket = 'engage'; rule = 'pattern_3in12'; }
  else if (inp.nsf6mo >= 1) { bucket = 'engage'; rule = 'nsf_one'; }

  // trajectory modifier: actively paying down holds one level, never below watch
  let payingDown = false;
  if (RANK[bucket] > RANK.watch && inp.paidLast14dCents > 0 && inp.paidLast14dCents >= 0.25 * inp.openBalanceCents) {
    bucket = bucket === 'escalate' ? 'engage' : 'watch';
    rule = `${rule}+paying_down`;
    payingDown = true;
  }

  // transition law vs the previous bucket
  if (prevBucket && RANK[bucket] < RANK[prevBucket]) {
    if (prevBucket === 'escalate') {
      if (inp.activePlan && inp.clearedPlanInstallment) {
        return {
          bucket: 'engage', ruleFired: 'recovery_plan_started',
          reason: 'Engage: recovery — payment plan active with first installment cleared.', components,
        };
      }
      return {
        bucket: 'escalate', ruleFired: 'hold_recovery_pending',
        reason: 'Escalate held (recovery pending): needs an active payment plan with a cleared installment.', components,
      };
    }
    if (prevBucket === 'engage') {
      if (ratio < 0.25 && inp.nsf60d === 0) {
        return {
          bucket: 'watch', ruleFired: 'recovery_paid_down',
          reason: 'Watch: recovery — balance below 0.25× rent, no NSF in 60 days.', components,
        };
      }
      return {
        bucket: 'engage', ruleFired: 'hold_recovery_pending',
        reason: 'Engage held (recovery pending): needs balance below 0.25× rent and 60 NSF-free days.', components,
      };
    }
    // watch → clear happens only via the balance/grace paths above
  }

  let reason = reasonFor(bucket, rule.replace('+paying_down', ''), exposure, inp);
  if (payingDown) reason += ' Paying down: ≥25% of the balance in the last 14 days — held one level down.';
  return { bucket, ruleFired: rule, reason, components };
}

/** Assemble the scorer's inputs from the ledger. Every value is read from
 * data ordinary operations already keep true — nothing is entered for the
 * scorer's benefit. daysPastDue mirrors the payments agent's semantics
 * (oldest active positive charge whose applied pending/settled payments fall
 * short), so the scorer and the agent can never disagree about the clock. */
export function computeDelinquencyInputs(
  ctx: Ctx,
  lease: { id: string; rent_cents: number; property_id: string },
): DelinqInputs {
  const bd = ctx.businessDate;
  const openBalanceCents = leaseBalance(ctx, lease.id);
  const oldestDue = val<string>(
    `SELECT MIN(due_date) FROM charges WHERE lease_id=? AND status='active' AND amount_cents>0
       AND (SELECT COALESCE(SUM(pa.amount_cents),0) FROM payment_applications pa JOIN payments p ON p.id=pa.payment_id AND p.status IN ('pending','settled') WHERE pa.charge_id=charges.id) < amount_cents`,
    lease.id,
  );
  const daysPastDue = oldestDue ? Math.max(0, Math.round((Date.parse(bd) - Date.parse(oldestDue)) / 86400000)) : 0;
  const lateMonths12 = val<number>(
    `SELECT COUNT(DISTINCT month_key) FROM charges WHERE lease_id=? AND kind='late_fee' AND status='active' AND date>=?`,
    lease.id, addDays(bd, -365),
  ) || 0;
  const nsf6mo = val<number>(
    `SELECT COUNT(*) FROM payments WHERE lease_id=? AND status='nsf' AND nsf_date>=?`, lease.id, addDays(bd, -180),
  ) || 0;
  const nsf60d = val<number>(
    `SELECT COUNT(*) FROM payments WHERE lease_id=? AND status='nsf' AND nsf_date>=?`, lease.id, addDays(bd, -60),
  ) || 0;
  const brokenPlan12mo = !!q1<any>(
    `SELECT id FROM payment_plans WHERE lease_id=? AND status='defaulted' AND substr(created_at,1,10)>=?`,
    lease.id, addDays(bd, -365),
  );
  const active = q1<{ id: string }>(`SELECT id FROM payment_plans WHERE lease_id=? AND status='active'`, lease.id);
  const clearedPlanInstallment = active
    ? !!q1<any>(`SELECT id FROM payment_plan_installments WHERE plan_id=? AND status='paid'`, active.id)
    : false;
  const paidLast14dCents = val<number>(
    `SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE lease_id=? AND status IN ('pending','settled') AND received_date>=?`,
    lease.id, addDays(bd, -14),
  ) || 0;
  const lateFee = getSettingMerged<{ graceDays: number }>(ctx, 'late_fee_policy', lease.property_id);
  const scoring = getSettingMerged<{ noticeThresholdDays: number }>(ctx, 'delinquency_scoring', lease.property_id);
  return {
    openBalanceCents, monthlyRentCents: lease.rent_cents, daysPastDue,
    lateMonths12, nsf6mo, nsf60d, brokenPlan12mo,
    activePlan: !!active, clearedPlanInstallment, paidLast14dCents,
    graceDays: lateFee?.graceDays ?? 3, noticeThresholdDays: scoring?.noticeThresholdDays ?? 45,
  };
}

/** Latest assessment on or before the context's business date. Consumers
 * (payments agent, renewals, workbench) read this — they never compute. */
export function latestAssessment(
  ctx: Ctx, leaseId: string,
): { bucket: DelinqBucket; reason: string; rule_fired: string; as_of_date: string; prev_bucket: string | null } | null {
  return (
    q1<any>(
      `SELECT bucket, reason, rule_fired, as_of_date, prev_bucket FROM delinquency_assessments
        WHERE lease_id=? AND org_id=? AND as_of_date<=? ORDER BY as_of_date DESC LIMIT 1`,
      leaseId, ctx.orgId, ctx.businessDate,
    ) || null
  );
}

/** Daily scorer. Scores every active lease that has an open balance — or a
 * prior non-clear assessment (so recoveries get their final 'clear' row, then
 * drop out). Idempotent per (lease, business date): the poller re-runs the
 * day's jobs, so a same-day re-run refreshes the row in place and preserves
 * the first write's prev_bucket. Runs AFTER the m8 money jobs (registration
 * order), reading the day the mutators just wrote. */
registerJob({
  key: 'score_delinquency',
  name: 'Delinquency scoring',
  describe:
    'Scores each delinquent lease into watch/engage/escalate with a named rule and plain-language reason. Shadow mode informs; active mode grades agent tone, holds escalations for humans, and pauses renewal offers.',
  run: (ctx, date) => {
    const leases = q<{ id: string; rent_cents: number; property_id: string }>(
      `SELECT id, rent_cents, property_id FROM leases WHERE org_id=? AND status='active'`,
      ctx.orgId,
    );
    let scored = 0;
    let transitions = 0;
    const counts: Record<DelinqBucket, number> = { clear: 0, watch: 0, engage: 0, escalate: 0 };
    for (const lease of leases) {
      const prior = latestAssessment(ctx, lease.id);
      const balance = leaseBalance(ctx, lease.id);
      if (balance <= 0 && (!prior || prior.bucket === 'clear')) continue;
      const inp = computeDelinquencyInputs(ctx, lease);
      const prevBucket = prior && prior.as_of_date < date ? prior.bucket : ((prior?.prev_bucket as DelinqBucket | null) ?? null);
      const a = assessDelinquency(inp, prevBucket);
      const existing = q1<{ id: string }>(
        `SELECT id FROM delinquency_assessments WHERE lease_id=? AND as_of_date=?`, lease.id, date,
      );
      if (existing) {
        run(
          `UPDATE delinquency_assessments SET bucket=?, components=?, rule_fired=?, reason=? WHERE id=?`,
          a.bucket, js(a.components), a.ruleFired, a.reason, existing.id,
        );
      } else {
        insert('delinquency_assessments', {
          id: id('dqa'), org_id: ctx.orgId, lease_id: lease.id, as_of_date: date,
          bucket: a.bucket, prev_bucket: prevBucket, components: js(a.components),
          rule_fired: a.ruleFired, reason: a.reason, created_at: nowIso(),
        });
      }
      scored++;
      counts[a.bucket]++;
      if (prevBucket && prevBucket !== a.bucket) transitions++;
    }
    const parts = (['watch', 'engage', 'escalate', 'clear'] as DelinqBucket[])
      .filter((b) => counts[b] > 0)
      .map((b) => `${counts[b]} ${b}`);
    return `${scored} scored${parts.length ? ': ' + parts.join(' · ') : ''}${transitions ? ` · ${transitions} transitions` : ''}`;
  },
});

// ============================== Scorer #2: lead heat ==============================

export type HeatBucket = 'hot' | 'warm' | 'cold';

/** Structurally text-free: intent flags, inventory fit, counts, and dates.
 * Protected-topic content (vouchers, disability, children) can never move a
 * bucket because message text never enters this struct. `source` is recorded
 * for analytics but deliberately excluded from every bucket rule. */
export interface LeadHeatInputs {
  wantsTour: boolean;
  asksPrice: boolean;
  asksAvailability: boolean;
  asksPets: boolean;
  wantsHuman: boolean;
  fitNow: boolean;
  fitComing: boolean;
  fitBeds: number | null;
  upcomingTour: boolean;
  inboundCount: number;
  inboundLast24h: number;
  hoursSinceInbound: number;
  daysSinceInbound: number;
  openCadenceTasks: number;
  ageDays: number;
  source: string;
}

export interface LeadHeatAssessment {
  bucket: HeatBucket;
  ruleFired: string;
  reason: string;
  components: LeadHeatInputs;
}

const HEAT_RANK: Record<HeatBucket, number> = { cold: 0, warm: 1, hot: 2 };

function bedsWord(beds: number | null): string {
  return beds === null ? 'any home' : `${beds}-bed`;
}

/** Lead-heat rules. Hot allocates attention and (in active orgs) the
 * after-hours autonomy scope; cold stops the task treadmill. Upgrades jump —
 * any fresh engagement can go straight to hot; cooling steps one level per
 * assessment day (decay IS the recovery criterion in this domain). */
export function assessLeadHeat(inp: LeadHeatInputs, prevBucket: HeatBucket | null): LeadHeatAssessment {
  const components = { ...inp };

  let bucket: HeatBucket;
  let rule: string;
  let reason: string;

  if ((inp.wantsTour || inp.upcomingTour) && inp.fitNow && inp.hoursSinceInbound <= 72) {
    bucket = 'hot'; rule = 'hot_engaged_fit';
    reason = `Hot: ${inp.upcomingTour ? 'tour on the calendar' : 'asked to tour'}; fit now (${bedsWord(inp.fitBeds)} ready); last inbound ${Math.round(inp.hoursSinceInbound)}h ago.`;
  } else if (inp.inboundLast24h >= 2) {
    bucket = 'hot'; rule = 'hot_rapid_inbound';
    reason = `Hot: ${inp.inboundLast24h} inbound messages in 24h — in-market right now.`;
  } else if (!inp.fitNow && !inp.fitComing) {
    bucket = 'cold'; rule = 'cold_no_fit';
    reason = `Cold: no ${bedsWord(inp.fitBeds)} ready or on notice — nothing to sell; offer the first-look list.`;
  } else if (inp.daysSinceInbound >= 14) {
    bucket = 'cold'; rule = 'cold_stale';
    reason = `Cold: ${inp.daysSinceInbound} days since last inbound.`;
  } else if (inp.openCadenceTasks === 0 && inp.daysSinceInbound >= 7) {
    bucket = 'cold'; rule = 'cold_cadence_exhausted';
    reason = `Cold: cadence exhausted; ${inp.daysSinceInbound} days quiet.`;
  } else {
    bucket = 'warm'; rule = 'warm_engaged';
    reason = `Warm: engaged${inp.fitNow ? `; fit now (${bedsWord(inp.fitBeds)} ready)` : inp.fitComing ? `; ${bedsWord(inp.fitBeds)} on notice soon` : ''}; awaiting a tour ask.`;
  }

  // transition law — upgrades jump; cooling steps one level per assessment
  if (prevBucket && HEAT_RANK[bucket] < HEAT_RANK[prevBucket] - 1) {
    bucket = prevBucket === 'hot' ? 'warm' : 'cold';
    rule = 'step_decay';
    reason = `${bucket === 'warm' ? 'Warm (cooling)' : 'Cold (cooling)'}: was ${prevBucket}; engagement cooling — stepped down one level.`;
  }

  return { bucket, ruleFired: rule, reason, components };
}

/** Assemble lead-heat inputs. Message text is reduced to deterministic intent
 * flags at this boundary and NEVER carried further — the structural
 * fair-housing guarantee. Day-granularity staleness uses business dates;
 * the 24h/72h recency windows use event timestamps. */
export function computeLeadInputs(
  ctx: Ctx,
  lead: {
    id: string; property_id: string; beds: number | null; message: string | null;
    created_date: string; source: string;
  },
): LeadHeatInputs {
  const bd = ctx.businessDate;

  // intents accumulate across the original inquiry and every inbound message
  const inboundBodies = q<{ body: string | null }>(
    `SELECT body FROM lead_events WHERE lead_id=? AND kind IN ('email_in','sms_in') ORDER BY at`, lead.id,
  );
  const texts = [lead.message || '', ...inboundBodies.map((b) => b.body || '')];
  const intents = texts.map((t) => detectLeadIntent(t));
  const flag = (k: keyof LeadIntent): boolean => intents.some((i) => i[k]);

  const hasBeds = lead.beds !== null && lead.beds !== undefined;
  const fitNow = !!q1<any>(
    `SELECT u.id FROM units u LEFT JOIN floorplans f ON f.id=u.floorplan_id
      WHERE u.property_id=? AND u.status='vacant_ready'${hasBeds ? ' AND f.beds=?' : ''} LIMIT 1`,
    ...(hasBeds ? [lead.property_id, lead.beds] : [lead.property_id]),
  );
  const fitComing = !!q1<any>(
    `SELECT u.id FROM units u LEFT JOIN floorplans f ON f.id=u.floorplan_id
      WHERE u.property_id=? AND u.status='notice'${hasBeds ? ' AND f.beds=?' : ''} LIMIT 1`,
    ...(hasBeds ? [lead.property_id, lead.beds] : [lead.property_id]),
  );
  const upcomingTour = !!q1<any>(
    `SELECT id FROM tours WHERE lead_id=? AND status='scheduled' AND date>=? LIMIT 1`, lead.id, bd,
  );

  const inboundCount = val<number>(
    `SELECT COUNT(*) FROM lead_events WHERE lead_id=? AND kind IN ('email_in','sms_in')`, lead.id,
  ) || 0;
  const lastInboundAt = val<string>(
    `SELECT MAX(at) FROM lead_events WHERE lead_id=? AND kind IN ('email_in','sms_in')`, lead.id,
  );
  const dayMs = 86400000;
  const nowMs = Date.now();
  const inboundLast24h = val<number>(
    `SELECT COUNT(*) FROM lead_events WHERE lead_id=? AND kind IN ('email_in','sms_in') AND at>=?`,
    lead.id, new Date(nowMs - dayMs).toISOString(),
  ) || 0;
  const hoursSinceInbound = lastInboundAt
    ? Math.max(0, (nowMs - Date.parse(lastInboundAt)) / 3600_000)
    : Math.max(0, (Date.parse(bd) - Date.parse(lead.created_date)) / dayMs) * 24;
  const lastInboundDate = lastInboundAt ? lastInboundAt.slice(0, 10) : lead.created_date;
  const daysSinceInbound = Math.max(
    0,
    Math.round((Date.parse(bd) - Date.parse(lastInboundDate > lead.created_date ? lastInboundDate : lead.created_date)) / dayMs),
  );
  const openCadenceTasks = val<number>(
    `SELECT COUNT(*) FROM followup_tasks WHERE lead_id=? AND status='open'`, lead.id,
  ) || 0;
  const ageDays = Math.max(0, Math.round((Date.parse(bd) - Date.parse(lead.created_date)) / dayMs));

  return {
    wantsTour: flag('wantsTour'), asksPrice: flag('asksPrice'), asksAvailability: flag('asksAvailability'),
    asksPets: flag('asksPets'), wantsHuman: flag('wantsHuman'),
    fitNow, fitComing, fitBeds: hasBeds ? lead.beds : null, upcomingTour,
    inboundCount, inboundLast24h, hoursSinceInbound, daysSinceInbound,
    openCadenceTasks, ageDays, source: lead.source,
  };
}

/** Latest lead-heat assessment on or before the business date. */
export function latestLeadAssessment(
  ctx: Ctx, leadId: string,
): { bucket: HeatBucket; reason: string; rule_fired: string; as_of_date: string; prev_bucket: string | null } | null {
  return (
    q1<any>(
      `SELECT bucket, reason, rule_fired, as_of_date, prev_bucket FROM lead_assessments
        WHERE lead_id=? AND org_id=? AND as_of_date<=? ORDER BY as_of_date DESC LIMIT 1`,
      leadId, ctx.orgId, ctx.businessDate,
    ) || null
  );
}

/** Score one lead now (shared by the nightly sweep and the event hooks).
 * Same-day re-scores refresh the row and keep the first write's prev_bucket. */
export function scoreOneLead(ctx: Ctx, leadId: string): HeatBucket | null {
  const lead = q1<any>(
    `SELECT * FROM leads WHERE id=? AND org_id=? AND status IN ('new','contacted','touring','toured')`,
    leadId, ctx.orgId,
  );
  if (!lead) return null;
  const date = ctx.businessDate;
  const prior = latestLeadAssessment(ctx, lead.id);
  const prevBucket = prior && prior.as_of_date < date ? prior.bucket : ((prior?.prev_bucket as HeatBucket | null) ?? null);
  const a = assessLeadHeat(computeLeadInputs(ctx, lead), prevBucket);
  const existing = q1<{ id: string }>(`SELECT id FROM lead_assessments WHERE lead_id=? AND as_of_date=?`, lead.id, date);
  if (existing) {
    run(
      `UPDATE lead_assessments SET bucket=?, components=?, rule_fired=?, reason=? WHERE id=?`,
      a.bucket, js(a.components), a.ruleFired, a.reason, existing.id,
    );
  } else {
    insert('lead_assessments', {
      id: id('lqa'), org_id: ctx.orgId, lead_id: lead.id, as_of_date: date,
      bucket: a.bucket, prev_bucket: prevBucket, components: js(a.components),
      rule_fired: a.ruleFired, reason: a.reason, created_at: nowIso(),
    });
  }

  // Active mode only: a hot lead we answered ≥24h ago with silence since
  // deserves a phone call, not another email. One open task, ever — the
  // dedupe makes the sweep and the event hooks collision-safe.
  if (a.bucket === 'hot' && scorerMode(ctx, 'lead_scoring') === 'active') {
    const lastOut = val<string>(
      `SELECT MAX(at) FROM lead_events WHERE lead_id=? AND kind IN ('email_out','sms_out')`, lead.id,
    );
    const lastIn = val<string>(
      `SELECT MAX(at) FROM lead_events WHERE lead_id=? AND kind IN ('email_in','sms_in')`, lead.id,
    );
    const silent = !!lastOut && (!lastIn || lastIn < lastOut) && Date.now() - Date.parse(lastOut) >= 24 * 3600_000;
    if (silent && !q1<any>(`SELECT id FROM followup_tasks WHERE lead_id=? AND kind='ai:call_hot_lead' AND status='open'`, lead.id)) {
      insert('followup_tasks', {
        id: id('flt'), org_id: ctx.orgId, property_id: lead.property_id, lead_id: lead.id,
        kind: 'ai:call_hot_lead', due_date: date, status: 'open', created_at: nowIso(),
      });
    }
  }
  return a.bucket;
}

/** Nightly sweep: decay needs no event, so every open-pipeline lead gets a
 * fresh row daily; the event hooks below keep the hot end current between
 * sweeps. Leased/applied/lost leads leave the scorer's world. */
registerJob({
  key: 'score_lead',
  name: 'Lead-heat scoring',
  describe:
    'Scores each open lead into hot/warm/cold with a named rule and plain-language reason. Shadow mode informs; active mode orders the Leasing Center hot-first and opens a call task for silent hot leads.',
  run: (ctx, date) => {
    const leads = q<{ id: string }>(
      `SELECT id FROM leads WHERE org_id=? AND status IN ('new','contacted','touring','toured')`,
      ctx.orgId,
    );
    let scored = 0;
    let transitions = 0;
    const counts: Record<HeatBucket, number> = { hot: 0, warm: 0, cold: 0 };
    for (const l of leads) {
      const prior = latestLeadAssessment(ctx, l.id);
      const b = scoreOneLead(ctx, l.id);
      if (!b) continue;
      scored++;
      counts[b]++;
      const prev = prior && prior.as_of_date < date ? prior.bucket : null;
      if (prev && prev !== b) transitions++;
    }
    const parts = (['hot', 'warm', 'cold'] as HeatBucket[]).filter((b) => counts[b] > 0).map((b) => `${counts[b]} ${b}`);
    return `${scored} scored${parts.length ? ': ' + parts.join(' · ') : ''}${transitions ? ` · ${transitions} transitions` : ''}`;
  },
});

// event-driven freshness: score at the moment of inquiry/inbound (never break intake)
on('lead.created', (ctx, payload) => {
  try { scoreOneLead(sysCtx(ctx.orgId), String(payload.entityId)); } catch { /* scoring never breaks intake */ }
});
on('lead.inquiry', (ctx, payload) => {
  try { scoreOneLead(sysCtx(ctx.orgId), String(payload.entityId)); } catch { /* ditto */ }
});
on('message.inbound', (ctx, payload) => {
  try {
    const t = q1<{ person_kind: string; person_id: string }>(
      `SELECT person_kind, person_id FROM threads WHERE id=?`, String(payload.entityId),
    );
    if (t?.person_kind === 'lead') scoreOneLead(sysCtx(ctx.orgId), t.person_id);
  } catch { /* ditto */ }
});
