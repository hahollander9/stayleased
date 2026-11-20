import { q, q1, val, insert, run, j, js, tx } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, addDays, monthKey, fmtDate, addMonths } from '../../lib/dates.ts';
import { usd } from '../../lib/money.ts';
import { sysCtx, type Ctx } from '../../lib/auth.ts';
import { on, emit } from '../../lib/events.ts';
import { getSetting, getSettingMerged, scorerMode, settingIsExplicit } from '../../lib/settings.ts';
import { getDials } from '../../lib/sim/dials.ts';
import { llm } from '../../lib/sim/llm.ts';
import { screenFairHousing } from '../../lib/fairhousing.ts';
import { sendEmail } from '../../lib/sim/messaging.ts';
import { audit } from '../../lib/audit.ts';
import { registerJob } from '../../lib/jobs.ts';
import { propose, registerExecutor, aiEnabled, type ActionOutput } from './framework.ts';
import { messageLead, bookTour, tourSlots, quotedRent } from '../m3_crm/service.ts';
import { triageWo, woEvent } from '../m10_facilities/service.ts';
import { createPaymentPlan, openCollectionCase } from '../m8_receivables/payments.ts';
import { leaseBalance } from '../m8_receivables/service.ts';
import { latestAssessment } from '../m19_scoring/service.ts';
import { renewalMatrix, renewalHeldForDelinquency } from '../m6_leases/service.ts';

/** M17 agents 1-4: Leasing, Maintenance, Payments, Renewals. Each grounds
 * itself in live service-layer data, formats prose through the LlmProvider,
 * and stages everything through the supervised action framework. */

// hooks stay dormant until the world is built (seed) or the server boots,
// so seeding earlier phases never triggers agents retroactively.
let live = false;
export function setAiHooksLive(v: boolean): void {
  live = v;
}

// ---------- 1. Leasing AI ----------

// LeadIntent + detectLeadIntent moved to src/lib/lead_intent.ts (the lead-heat
// scorer reads them too, and m19 importing m17 would cycle). Imported for
// local use and re-exported so existing importers keep working.
import { detectLeadIntent, type LeadIntent } from '../../lib/lead_intent.ts';
export { detectLeadIntent, type LeadIntent };

/** Office hours belong to the building, not the company — a portfolio can hold
 * one property staffed until 6 and another until 8. */
function afterHours(ctx: Ctx, propertyId?: string | null): boolean {
  const hours = getSettingMerged<{ start: string; end: string }>(ctx, 'business_hours', propertyId);
  const hour = getDials(ctx.orgId).clockHour;
  return hour < Number(hours.start.slice(0, 2)) || hour >= Number(hours.end.slice(0, 2));
}

/** Has the operator actually recorded this policy? A reply to a prospect may
 * state a term only when somebody at the company chose it. The code default
 * (two pets, $35 pet rent, a $250 deposit; tours 9 to 5:30 six days a week) is
 * a placeholder for the settings form, not a policy — in a real company,
 * quoting it is inventing terms on the operator's behalf. The demo company's
 * world IS the defaults, so it keeps them. */
function operatorSet(ctx: Ctx, key: string, propertyId?: string | null): boolean {
  return ctx.orgKind !== 'live' || settingIsExplicit(ctx, key, propertyId);
}

export function handleLeadInbound(ctx: Ctx, leadId: string, message: string): { id: string; status: string } | null {
  const lead = q1<any>('SELECT l.*, p.name AS prop_name FROM leads l JOIN properties p ON p.id=l.property_id WHERE l.id=? AND l.org_id=?', leadId, ctx.orgId);
  if (!lead) return null;
  // things the prospect asked that the records cannot answer — each one holds
  // the reply for a person, whatever the dial says
  const unanswered: string[] = [];
  const intent = detectLeadIntent(message);
  const facts: Record<string, unknown> = { leadName: lead.first_name, leadId, message, propertyName: lead.prop_name };

  // grounding: live availability + pricing (12-month quoted rates)
  const units = q<any>(
    `SELECT u.*, f.name AS fp, f.beds FROM units u LEFT JOIN floorplans f ON f.id=u.floorplan_id
     WHERE u.property_id=? AND u.status='vacant_ready'${lead.beds !== null && lead.beds !== undefined ? ' AND f.beds=?' : ''}
     ORDER BY u.market_rent_cents LIMIT 3`,
    ...(lead.beds !== null && lead.beds !== undefined ? [lead.property_id, lead.beds] : [lead.property_id]),
  );
  if (intent.asksAvailability || intent.asksPrice || units.length) {
    facts.units = units.length
      ? `Right now we have ${units.length === 1 ? 'one home' : units.length + ' homes'} ready for you: ${units.map((u) => `<b>${u.unit_number}</b> (${u.fp}, ${u.sqft} sq ft)`).join(', ')}.`
      // no claim about how often homes come up — nobody recorded that
      : 'Nothing is move-in ready right now. Would you like me to add you to our first-look list, so you hear from us when a home opens up?';
  }
  if (intent.asksPrice && units.length) {
    facts.pricing = `On a 12-month lease those run ${units.map((u) => `${usd(quotedRent(ctx, u, 12))}/mo (${u.unit_number})`).join(', ')} — live pricing, no games.`;
  }
  if (intent.asksPets) {
    // the property's own policy: pet rent, deposit and the restricted-breed
    // list vary by building and by municipal ordinance, and this sentence is
    // sent to a prospect about ONE building
    if (operatorSet(ctx, 'pet_policy', lead.property_id)) {
      const pol = getSettingMerged<{ maxPets: number; petRentCents: number; depositCents: number; restricted: string }>(ctx, 'pet_policy', lead.property_id);
      facts.petPolicy = `Pets are family here: up to ${pol.maxPets} per home, ${usd(pol.petRentCents)}/mo pet rent and a ${usd(pol.depositCents)} deposit each. (Restricted breeds: ${pol.restricted}.)`;
    } else {
      facts.petPolicy = 'On pets: let me confirm our pet policy for this community and get back to you with the details.';
      unanswered.push('pet policy');
    }
  }
  // tour proposal: tomorrow's first open slots
  // Slots are offered only from tour hours the operator recorded; otherwise
  // the reply asks the prospect for times and a person confirms one.
  const tomorrow = addDays(ctx.businessDate, 1);
  const hoursSet = operatorSet(ctx, 'tour_hours', lead.property_id);
  const slots = hoursSet ? tourSlots(ctx, lead.property_id, tomorrow).slice(0, 3) : [];
  let tour: { date: string; startTime: string } | null = null;
  if (!hoursSet) {
    if (intent.wantsTour) {
      facts.tourLine = 'I would be glad to set up a tour. Tell me a couple of days and times that work for you and we will confirm one.';
      unanswered.push('tour hours');
    }
  } else if (intent.wantsTour && slots.length) {
    tour = { date: tomorrow, startTime: slots[0]! };
    facts.tourLine = `I can hold <b>${fmtDate(tomorrow)} at ${slots[0]}</b> for a tour${slots.length > 1 ? ` (or ${slots.slice(1).join(' / ')})` : ''} — say the word and it's yours.`;
  } else if (slots.length) {
    facts.tourLine = `If you'd like to see it in person, tomorrow has openings at ${slots.join(', ')} — I can book any of them for you.`;
  }

  const rawDraft = llm().complete('lead_reply', facts);
  // Fair-housing guardrail on prospect-facing text: rewrite any flagged phrase
  // to the approved neutral wording before it can be sent.
  const fh = screenFairHousing(rawDraft);
  const draft = fh.ok ? rawDraft : fh.safe;
  // 0.6 sits below the 0.7 auto floor: a reply that had to defer an answer is
  // read by a person before it goes, so they can fill in what the records lack
  const confidence = intent.wantsHuman ? 0.4 : unanswered.length ? 0.6 : 0.92;
  const oh = afterHours(ctx, lead.property_id);
  const notes = [
    intent.wantsHuman ? 'low confidence: prospect asked for a person — held for staff even on autonomous' : null,
    unanswered.length ? `held for staff: no ${unanswered.join(' or ')} is recorded in Settings for this property, so the reply promises a follow-up instead of stating terms` : null,
    fh.ok ? null : `fair-housing guardrail rewrote ${fh.flags.length} phrase(s): ${[...new Set(fh.flags.map((f) => f.category))].join(', ')}`,
  ].filter(Boolean);
  const askedFor = [
    intent.asksAvailability ? 'availability' : null, intent.asksPrice ? 'pricing' : null,
    intent.asksPets ? 'pet policy' : null, intent.wantsTour ? 'a tour' : null,
  ].filter(Boolean).join(', ') || 'a general question';
  const rationale = `Prospect asked about ${askedFor}; reply grounded in ${units.length ? `${units.length} vacant-ready unit${units.length === 1 ? '' : 's'} (${units.map((u) => u.unit_number).join(', ')}) with live 12-month quotes` : 'live availability (nothing move-in ready, first-look list offered)'}${tour ? `; tour slot held for ${fmtDate(tomorrow)} ${slots[0]} because openings existed` : ''}${oh ? '; handled after hours so the lead is not lost overnight' : ''}${intent.wantsHuman ? '; held for staff because the prospect asked for a person' : ''}${unanswered.length ? `; ${unanswered.join(' and ')} not recorded in Settings, so nothing was stated about ${unanswered.length === 1 ? 'it' : 'them'}` : ''}.`;
  return propose(ctx, {
    agent: 'leasing',
    propertyId: lead.property_id,
    entity: 'lead',
    entityId: leadId,
    title: `${oh ? 'After-hours reply' : 'Reply'} to ${lead.first_name} ${lead.last_name}${tour ? ' + book tour' : ''}${intent.wantsHuman ? ' — HUMAN REQUESTED' : ''}`,
    input: { message, intent, afterHours: oh, groundedUnits: units.map((u) => u.unit_number), fairHousingFlags: fh.flags, notRecorded: unanswered },
    rationale,
    output: {
      kind: 'leasing.send_reply',
      draft,
      subject: `Re: your ${lead.prop_name} inquiry`,
      leadId,
      tour,
    },
    confidence,
    guardrailNote: notes.length ? notes.join(' · ') : undefined,
  });
}

registerExecutor('leasing.send_reply', (ctx, action, output) => {
  const leadId = String(output.leadId);
  messageLead(ctx, leadId, 'email', String(output.subject || 'Your inquiry'), String(output.draft || ''));
  let note = 'reply sent';
  if (output.tour) {
    const t = output.tour as { date: string; startTime: string };
    const tourId = bookTour(ctx, { leadId, date: t.date, startTime: t.startTime });
    note = `reply sent + tour booked ${t.date} ${t.startTime} (${tourId.slice(-6)})`;
  }
  return note;
});

// ---------- 2. Maintenance AI ----------

const EMERGENCY = /(gas leak|smell gas|carbon monoxide|\bfire\b|flood|burst pipe|no heat|sewage|sparking|smoke)/i;
const CATEGORIES: [RegExp, string][] = [
  [/(toilet|sink|faucet|leak|drip|drain|water heater|no hot water|shower|clog)/i, 'plumbing'],
  [/(outlet|breaker|light|power|switch|electric|spark)/i, 'electrical'],
  [/(\ba\/?c\b|air condition|heat|furnace|thermostat|hvac|cold air|warm air)/i, 'hvac'],
  [/(fridge|refrigerator|stove|oven|dishwasher|washer|dryer|microwave|disposal|appliance)/i, 'appliance'],
  [/(lock|key|door|deadbolt|knob|latch)/i, 'doors_locks'],
  [/(roach|mice|mouse|rat|bug|ant|pest|wasp|bees)/i, 'pest'],
];
const TRIVIA: [RegExp, string][] = [
  [/disposal.*(hum|stuck|jammed|not spin)/i, 'Under the sink, press the red RESET button on the disposal base, then run cold water and try again.'],
  [/(outlet|plug).*(bathroom|kitchen|dead|not work)/i, 'Look for a GFCI outlet nearby (the one with TEST/RESET buttons) and press RESET — bathroom and kitchen outlets share those circuits.'],
  [/breaker|half the (power|lights)/i, 'Check your breaker panel (hall closet) for a switch sitting between ON and OFF — flip it fully OFF, then ON.'],
];

export function triageRequest(ctx: Ctx, woId: string): { id: string; status: string } | null {
  const wo = q1<any>('SELECT wo.*, r.first_name FROM work_orders wo LEFT JOIN residents r ON r.id=wo.resident_id WHERE wo.id=?', woId);
  if (!wo) return null;
  const text = `${wo.summary} ${wo.description || ''}`;
  const emergency = EMERGENCY.test(text);
  const keywords = text.match(EMERGENCY)?.[0] || '';
  const category = CATEGORIES.find(([re]) => re.test(text))?.[1] || wo.category || 'other';
  const priority = emergency ? 'emergency' : /(no hot water|leak|won'?t lock|fridge|refrigerator)/i.test(text) ? 'high' : 'normal';
  const tip = TRIVIA.find(([re]) => re.test(text))?.[1];
  const vague = text.trim().length < 18 && !emergency;
  const question = vague ? 'what exactly is the issue, and in which room? A photo helps too.' : null;

  const note = llm().complete('triage_note', {
    category, priority, emergency, keywords,
    reason: tip ? 'Trivial-fix candidate — troubleshooting tip drafted.' : vague ? 'Description too thin — clarifying question drafted.' : `Keyed off: "${text.slice(0, 60)}".`,
  });
  return propose(ctx, {
    agent: 'maintenance',
    propertyId: wo.property_id,
    entity: 'work_order',
    entityId: woId,
    title: `Triage: ${wo.summary.slice(0, 40)} → ${category}/${priority}${emergency ? ' 🚨' : ''}`,
    input: { summary: wo.summary, description: wo.description, currentCategory: wo.category, currentPriority: wo.priority },
    rationale: `Keyed off “${text.trim().slice(0, 60)}” → category ${category}; priority ${priority} ${emergency ? `because emergency keywords matched (${keywords})` : priority === 'high' ? 'because the no-hot-water/leak/lockout rule matched' : 'because no urgency markers matched'}; ${tip ? 'known trivial-fix pattern, so a troubleshooting tip goes to the resident before a truck rolls' : question ? 'the description is too thin to dispatch, so a clarifying question goes out first' : 'dispatch-ready as written'}.`,
    output: {
      kind: 'maintenance.apply_triage',
      woId, category, priority, note,
      draft: tip
        ? llm().complete('troubleshoot_tip', { name: wo.first_name || 'there', tip })
        : question
          ? llm().complete('clarifying_question', { name: wo.first_name || 'there', question })
          : undefined,
      draftKind: tip ? 'tip' : question ? 'question' : null,
    },
    confidence: emergency ? 0.99 : vague ? 0.6 : 0.9,
    guardrailNote: emergency ? `emergency keywords (${keywords}) — escalation is never optional` : undefined,
  });
}

registerExecutor('maintenance.apply_triage', (ctx, action, output) => {
  const woId = String(output.woId);
  const wo = q1<any>('SELECT * FROM work_orders WHERE id=?', woId);
  if (!wo) return 'work order gone';
  triageWo(ctx, woId, { category: String(output.category), priority: String(output.priority) });
  woEvent(ctx, woId, 'note', String(output.note), { residentVisible: false });
  let note = `triaged ${output.category}/${output.priority}`;
  if (output.draft && wo.resident_id) {
    const res = q1<any>('SELECT * FROM residents WHERE id=?', wo.resident_id);
    if (res?.email) {
      sendEmail(ctx, {
        to: res.email, toName: `${res.first_name} ${res.last_name}`,
        subject: output.draftKind === 'tip' ? `Quick fix to try — ${wo.summary}` : `One question about your request`,
        body: String(output.draft), propertyId: wo.property_id, entity: 'work_order', entityId: woId,
        personId: res.id, templateKey: 'ai_maintenance',
      });
      note += output.draftKind === 'tip' ? ' + troubleshooting tip sent' : ' + clarifying question sent';
    }
  }
  return note;
});

// ---------- 3. Payments AI ----------

/** Global flag is REQUIRED: `String.replace` with a non-global regex rewrites
 * only the FIRST match, so a draft naming several banned terms was scrubbed
 * once and sent with the rest intact. This is the hard collections rail. */
const BANNED = /(evict|lawsuit|attorney|sue you|credit bureau|collections agency will|garnish|police)/gi;

export function draftCollectionsOutreach(ctx: Ctx, leaseId: string): { id: string; status: string } | null {
  const lease = q1<any>(
    `SELECT l.*, u.unit_number, p.name AS prop_name FROM leases l JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=l.property_id WHERE l.id=?`,
    leaseId,
  );
  if (!lease) return null;
  const bal = leaseBalance(ctx, leaseId);
  if (bal <= 0) return null;
  const oldestDue = val<string>(
    `SELECT MIN(due_date) FROM charges WHERE lease_id=? AND status='active' AND amount_cents>0
       AND (SELECT COALESCE(SUM(pa.amount_cents),0) FROM payment_applications pa JOIN payments p ON p.id=pa.payment_id AND p.status IN ('pending','settled') WHERE pa.charge_id=charges.id) < amount_cents`,
    leaseId,
  ) || ctx.businessDate;
  const days = Math.max(0, Math.round((Date.parse(ctx.businessDate) - Date.parse(oldestDue)) / 86400000));

  // M19 delinquency scorer (active mode only): the agent reads the bucket as a
  // fact and computes no severity of its own. Shadow mode (the default)
  // leaves everything below exactly as it always was. A stale 'clear' row
  // with money newly owed falls back to legacy — the assessment is an
  // authority on severity, never a reason to ignore a real balance.
  const scoringMode = scorerMode(ctx, 'delinquency_scoring');
  const assessRow = scoringMode === 'active' ? latestAssessment(ctx, leaseId) : null;
  const assess = assessRow && assessRow.bucket !== 'clear' ? assessRow : null;

  if (assess && assess.bucket === 'escalate') {
    // The regulated moment: no resident-facing prose past the notice
    // threshold. The AI assembles the packet; a human decides what happens.
    const lastPay = val<string>(
      `SELECT MAX(received_date) FROM payments WHERE lease_id=? AND status IN ('pending','settled')`, leaseId,
    );
    const planCount = val<number>(`SELECT COUNT(*) FROM payment_plans WHERE lease_id=?`, leaseId) || 0;
    const nsfCount = val<number>(`SELECT COUNT(*) FROM payments WHERE lease_id=? AND status='nsf'`, leaseId) || 0;
    const summary = `${assess.reason} Balance ${usd(bal)} at ${days} days past due; last payment ${lastPay ? fmtDate(lastPay) : 'none on record'}; payment plans to date: ${planCount}; NSF returns: ${nsfCount}. State notice requirements may apply — human review required; the AI sends nothing at this stage.`;
    return propose(ctx, {
      agent: 'payments',
      propertyId: lease.property_id,
      entity: 'lease',
      entityId: leaseId,
      title: `Escalation packet — ${lease.household_name} (${usd(bal)}, ${days}d)`,
      input: { balanceCents: bal, daysPastDue: days, bucket: assess.bucket, rule: assess.rule_fired },
      rationale: `Delinquency scorer: ${assess.reason} Escalations produce a staff packet, never resident-facing prose.`,
      output: { kind: 'payments.escalation_packet', leaseId, summary },
      confidence: 0.6,
      guardrailNote: `delinquency scorer escalate (${assess.rule_fired}) — resident-facing outreach suppressed; confidence pinned below the auto floor so this can never auto-execute`,
    });
  }

  const tone = assess ? (assess.bucket === 'engage' ? 'firm' : 'friendly') : days <= 15 ? 'friendly' : days <= 45 ? 'firm' : 'final';
  const contact = q1<any>(
    `SELECT r.* FROM household_members hm JOIN residents r ON r.id=hm.resident_id WHERE hm.lease_id=? AND hm.role='primary'`,
    leaseId,
  );
  const bounds = getSettingMerged<{ maxInstallments: number; minInstallmentCents: number }>(ctx, 'ai_plan_bounds', lease.property_id);
  const planEligible =
    bal >= bounds.minInstallmentCents * 2 &&
    !q1<any>(`SELECT id FROM payment_plans WHERE lease_id=? AND status='active'`, leaseId) &&
    (!assess || assess.bucket === 'engage'); // watch = a nudge, not plan pressure
  // ONE installment count, used by the message and by the plan proposed beside
  // it. They were computed separately (3 in the email, 4 in the plan).
  const n = Math.min(bounds.maxInstallments, Math.max(2, Math.ceil(bal / (bounds.minInstallmentCents * 2))));
  const planLine = planEligible
    ? `Money tight? We can split this into ${n} installments — no judgment, takes two minutes to set up.`
    : null;

  const draft = llm().complete('collections_outreach', {
    name: contact?.first_name || 'there', balance: usd(bal), days, tone, planLine, propertyName: lease.prop_name,
    // online payments are not open in a live organization (POST /portal/pay
    // turns residents away), so the message must not send them to the portal
    portalPay: ctx.orgKind !== 'live',
  });
  // Derive the flag from the scrub result rather than calling BANNED.test():
  // a /g regex carries `lastIndex` across calls, so a module-level regex used
  // with .test() would start mid-string on the next draft and miss matches.
  // String.replace resets lastIndex itself, so this path is stateless.
  const cleanDraft = draft.replace(BANNED, '[removed by compliance filter]');
  const banned = cleanDraft !== draft;

  const outreach = propose(ctx, {
    agent: 'payments',
    propertyId: lease.property_id,
    entity: 'lease',
    entityId: leaseId,
    title: `${tone[0]!.toUpperCase()}${tone.slice(1)} outreach — ${lease.household_name} (${usd(bal)}, ${days}d)`,
    input: { balanceCents: bal, daysPastDue: days, tone, ...(assess ? { bucket: assess.bucket, rule: assess.rule_fired } : {}) },
    rationale: `${usd(bal)} open at ${days} days past due → tone graded “${tone}” by ${assess ? `the delinquency scorer — ${assess.reason}` : 'the dunning ladder'}${planEligible ? '; an installment plan is offered because the balance clears the org plan bounds' : ''}; the dispute path is always embedded${banned ? '; the threat filter scrubbed a flagged phrase' : ''}.`,
    output: { kind: 'payments.send_outreach', draft: cleanDraft, subject: `About your ${lease.prop_name} account`, leaseId, residentId: contact?.id },
    confidence: 0.9,
    guardrailNote: `compliance: dispute path embedded; threat filter ${banned ? 'TRIGGERED and scrubbed' : 'clean'}; tone graded ${tone} at ${days} days`,
  });

  if (planEligible) {
    const per = Math.ceil(bal / n / 100) * 100;
    const installments = Array.from({ length: n }, (_, i) => ({
      dueDate: addDays(ctx.businessDate, 7 + i * 14),
      amountCents: i === n - 1 ? bal - per * (n - 1) : per,
    }));
    propose(ctx, {
      agent: 'payments',
      propertyId: lease.property_id,
      entity: 'lease',
      entityId: leaseId,
      title: `Plan proposal — ${lease.household_name}: ${n} × ~${usd(per)} biweekly`,
      input: { balanceCents: bal, bounds },
      rationale: `Splits ${usd(bal)} into ${n} biweekly installments of ~${usd(per)} — the gentlest schedule that stays inside org bounds (≤${bounds.maxInstallments} installments, each ≥ ${usd(bounds.minInstallmentCents)}).`,
      output: { kind: 'payments.create_plan', leaseId, installments, totalCents: bal, draft: `${n} biweekly installments of ~${usd(per)} starting ${fmtDate(installments[0]!.dueDate)}` },
      confidence: 0.85,
      guardrailNote: `within org bounds: ≤${bounds.maxInstallments} installments, each ≥ ${usd(bounds.minInstallmentCents)}`,
    });
  }
  return outreach;
}

registerExecutor('payments.send_outreach', (ctx, action, output) => {
  const lease = q1<any>('SELECT l.*, p.name AS prop FROM leases l JOIN properties p ON p.id=l.property_id WHERE l.id=?', String(output.leaseId));
  const res = output.residentId ? q1<any>('SELECT * FROM residents WHERE id=?', String(output.residentId)) : null;
  if (!res?.email) return 'no primary contact email';
  sendEmail(ctx, {
    to: res.email, toName: `${res.first_name} ${res.last_name}`, subject: String(output.subject),
    body: String(output.draft), propertyId: lease.property_id, entity: 'lease', entityId: lease.id,
    personId: res.id, templateKey: 'ai_collections',
  });
  return 'outreach sent';
});

registerExecutor('payments.create_plan', (ctx, action, output) => {
  const planId = createPaymentPlan(
    ctx, String(output.leaseId), Number(output.totalCents),
    output.installments as { dueDate: string; amountCents: number }[],
    'AI-proposed plan (approved by staff) within org bounds.',
  );
  return `plan ${planId.slice(-6)} created`;
});

/** Escalation packets never touch the resident. Approving one opens (or
 * joins) the collection case with the packet as its opening note — the
 * human handles every step from there. openCollectionCase is idempotent. */
registerExecutor('payments.escalation_packet', (ctx, _action, output) => {
  const caseId = openCollectionCase(ctx, String(output.leaseId), String(output.summary));
  return `collection case ${caseId.slice(-6)} open — human handles next steps`;
});

// ---------- 4. Renewals AI ----------

export function onTimeStreak(ctx: Ctx, leaseId: string): number {
  let streak = 0;
  for (let i = 1; i <= 14; i++) {
    const mk = monthKey(addMonths(ctx.businessDate, -i));
    const hadRent = q1<any>(`SELECT id FROM charges WHERE lease_id=? AND kind='rent' AND month_key=?`, leaseId, mk);
    if (!hadRent) break;
    const late = q1<any>(`SELECT id FROM charges WHERE lease_id=? AND kind='late_fee' AND month_key=? AND status='active'`, leaseId, mk);
    if (late) break;
    streak++;
  }
  return streak;
}

export function draftRenewalOutreach(ctx: Ctx, leaseId: string): { id: string; status: string } | null {
  const lease = q1<any>(
    `SELECT l.*, u.unit_number, p.name AS prop_name FROM leases l JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=l.property_id WHERE l.id=?`,
    leaseId,
  );
  if (!lease) return null;
  // M19 cross-guard (active mode): never draft renewal warmth at a household
  // whose delinquency is escalated — the collections side is already holding
  // it for a human.
  if (scorerMode(ctx, 'delinquency_scoring') === 'active' && latestAssessment(ctx, leaseId)?.bucket === 'escalate') {
    return null;
  }
  const contact = q1<any>(
    `SELECT r.* FROM household_members hm JOIN residents r ON r.id=hm.resident_id WHERE hm.lease_id=? AND hm.role='primary'`, leaseId,
  );
  const streak = onTimeStreak(ctx, leaseId);
  const rating = val<number>(`SELECT AVG(rating) FROM work_orders WHERE lease_id=? AND rating IS NOT NULL`, leaseId);
  // The message and the offer on file must say the same thing. If staff already
  // sent an offer, the outreach quotes THAT offer; otherwise it prices a new one
  // and the executor puts it on file in the same step as the send.
  const onFile = q1<any>(
    `SELECT * FROM renewal_offers WHERE lease_id=? AND org_id=? AND status IN ('sent','countered','accepted') ORDER BY created_at DESC LIMIT 1`,
    leaseId, ctx.orgId,
  );
  if (onFile?.status === 'accepted') return null; // already renewed
  const options: RenewalOption[] = onFile ? j<RenewalOption[]>(onFile.options, []) : renewalMatrix(ctx, lease);
  if (!options.length) return null;
  // "Accept in your portal" is only true for a resident who can sign in
  const portalAccept = !!contact?.user_id;
  const draft = llm().complete('renewal_outreach', {
    portalAccept,
    name: contact?.first_name || 'there', propertyName: lease.prop_name, endDate: fmtDate(lease.end_date),
    onTimeStreak: streak, avgRating: rating ? Math.round(rating * 10) / 10 : null,
    optionsHtml: `<ul>${options.map((o) => `<li><b>${o.term_months} months</b> — ${usd(o.rent_cents)}/mo</li>`).join('')}</ul>`,
  });
  return propose(ctx, {
    agent: 'renewals',
    propertyId: lease.property_id,
    entity: 'lease',
    entityId: leaseId,
    title: `Renewal outreach — ${lease.household_name} (ends ${lease.end_date}, ${streak}mo on-time streak)`,
    input: { streak, rating, options, portalAccept, existingOfferId: onFile?.id || null },
    rationale: `Lease ends ${fmtDate(lease.end_date)}; options priced from the renewal matrix; the message is personalized on the household's ${streak}-month on-time streak${rating ? ` and ${Math.round(rating * 10) / 10}★ maintenance feedback` : ''} because retention beats a turn.`,
    output: { kind: 'renewals.send_outreach', draft, subject: `Let's keep ${lease.unit_number} yours 🏡`, leaseId, residentId: contact?.id, options },
    confidence: 0.9,
  });
}

interface RenewalOption { term_months: number; rent_cents: number }

function readOptions(v: unknown): RenewalOption[] {
  return (Array.isArray(v) ? v : [])
    .map((o: any) => ({ term_months: Math.round(Number(o?.term_months)), rent_cents: Math.round(Number(o?.rent_cents)) }))
    .filter((o) => o.term_months > 0 && o.rent_cents > 0);
}
const sameOptions = (a: RenewalOption[], b: RenewalOption[]): boolean => {
  const key = (x: RenewalOption[]): string => x.map((o) => `${o.term_months}:${o.rent_cents}`).sort().join('|');
  return key(a) === key(b);
};

/** The message quotes renewal terms and tells the resident they can accept
 * them. That is only true if a renewal_offers row carrying those exact terms
 * is on file when the message goes out — the portal's accept form, and staff's
 * Renewals page, both read that row. So the offer is recorded and the message
 * sent in one transaction; if the offer cannot stand, nothing is sent. */
registerExecutor('renewals.send_outreach', (ctx, action, output) => {
  const lease = q1<any>('SELECT * FROM leases WHERE id=? AND org_id=?', String(output.leaseId), ctx.orgId);
  if (!lease) return 'lease not found — nothing sent';
  const res = output.residentId ? q1<any>('SELECT * FROM residents WHERE id=? AND org_id=?', String(output.residentId), ctx.orgId) : null;
  if (!res?.email) return 'no primary contact email — nothing sent';
  // actions drafted before the terms travelled with the output kept them in input
  const drafted = readOptions(output.options ?? j<{ options?: unknown }>(action.input, {}).options);
  if (!drafted.length) return 'no renewal terms on this draft — nothing sent';
  const prior = q1<any>(
    `SELECT * FROM renewal_offers WHERE lease_id=? AND org_id=? AND status IN ('sent','countered','accepted') ORDER BY created_at DESC LIMIT 1`,
    lease.id, ctx.orgId,
  );
  if (prior?.status === 'accepted') return 'this household has already accepted a renewal — nothing sent';
  if (prior && !sameOptions(readOptions(j<unknown>(prior.options, [])), drafted)) {
    return 'a renewal offer with different terms is already on file — nothing sent; draft the outreach again';
  }
  if (!prior && renewalHeldForDelinquency(ctx, lease.id)) {
    return 'renewal held: delinquency escalation — nothing sent';
  }
  return tx(() => {
    let offerId = prior?.id as string | undefined;
    if (!offerId) {
      offerId = id('rno');
      insert('renewal_offers', {
        id: offerId, org_id: ctx.orgId, property_id: lease.property_id, lease_id: lease.id,
        options: js(drafted), status: 'sent', expires_date: addDays(ctx.businessDate, 30), created_at: nowIso(),
      });
      emit(ctx, 'renewal.offered', 'renewal_offer', offerId, { leaseId: lease.id });
      audit(ctx, 'renewal_offer', offerId, 'create', null, { leaseId: lease.id, options: drafted.length, via: 'renewals_ai', actionId: action.id });
    }
    sendEmail(ctx, {
      to: res.email, toName: `${res.first_name} ${res.last_name}`, subject: String(output.subject),
      body: String(output.draft), propertyId: lease.property_id, entity: 'renewal_offer', entityId: offerId,
      personId: res.id, templateKey: 'ai_renewal',
    });
    return prior
      ? `renewal outreach queued for the offer already on file (${offerId.slice(-6)})`
      : `renewal offer ${offerId.slice(-6)} recorded + outreach queued`;
  });
});

/** counter-offer evaluation: within the approved band → accept path;
 * beyond → escalate to the PM. Never commits on its own. */
export function evaluateCounter(ctx: Ctx, leaseId: string, counterCents: number, termMonths = 12): { id: string; status: string } | null {
  const lease = q1<any>('SELECT l.*, u.unit_number FROM leases l JOIN units u ON u.id=l.unit_id WHERE l.id=?', leaseId);
  if (!lease) return null;
  const offer = q1<any>(
    `SELECT * FROM renewal_offers WHERE lease_id=? AND status IN ('sent','countered') ORDER BY created_at DESC LIMIT 1`, leaseId,
  );
  const options = offer ? j<{ term_months: number; rent_cents: number }[]>(offer.options, []) : renewalMatrix(ctx, lease);
  const offered = options.find((o) => o.term_months === termMonths)?.rent_cents
    ?? options[0]?.rent_cents ?? lease.rent_cents;
  const maxDiscountPct = getSetting<number>(ctx, 'ai_renewal_max_discount_pct', lease.property_id);
  const floor = Math.round((offered * (1 - maxDiscountPct / 100)) / 100) * 100;
  const withinBounds = counterCents >= floor && counterCents < offered;
  const turnCost = usd(350000);
  const assessment = llm().complete('counter_assessment', {
    counter: usd(counterCents), offered: usd(offered), term: termMonths,
    withinBounds, maxDiscountPct, floor: usd(floor), turnCost,
  });
  return propose(ctx, {
    agent: 'renewals',
    propertyId: lease.property_id,
    entity: 'renewal_offer',
    entityId: offer?.id || leaseId,
    title: withinBounds
      ? `Counter ${usd(counterCents)} on ${lease.unit_number} — WITHIN band, accept?`
      : `Counter ${usd(counterCents)} on ${lease.unit_number} — below floor ${usd(floor)}, escalate`,
    input: { counterCents, offered, floor, termMonths, maxDiscountPct },
    rationale: withinBounds
      ? `Counter ${usd(counterCents)} sits inside the delegated band — the floor is ${usd(floor)} (offered ${usd(offered)} minus the ${maxDiscountPct}% max discount) — and accepting beats an est. ${turnCost} turn.`
      : `Counter ${usd(counterCents)} is below the delegated floor of ${usd(floor)} (offered ${usd(offered)} minus ${maxDiscountPct}%), so policy routes it to the property manager instead of committing.`,
    output: withinBounds
      ? { kind: 'renewals.accept_counter', draft: assessment, leaseId, offerId: offer?.id, termMonths, counterCents }
      : { kind: 'renewals.escalate', draft: assessment, leaseId, offerId: offer?.id, counterCents },
    confidence: withinBounds ? 0.85 : 0.95,
    guardrailNote: `matrix band: floor ${usd(floor)} (${maxDiscountPct}% below offered ${usd(offered)}); AI never commits beyond the band`,
  });
}

registerExecutor('renewals.accept_counter', (ctx, action, output) => {
  const offer = output.offerId ? q1<any>('SELECT * FROM renewal_offers WHERE id=?', String(output.offerId)) : null;
  if (!offer) return 'offer missing — nothing committed';
  const options = j<{ term_months: number; rent_cents: number }[]>(offer.options, []).map((o) =>
    o.term_months === Number(output.termMonths) ? { ...o, rent_cents: Number(output.counterCents) } : o,
  );
  run(
    `UPDATE renewal_offers SET options=?, status='sent', counter_note=? WHERE id=?`,
    js(options), `AI-negotiated: ${usd(Number(output.counterCents))} on ${output.termMonths}mo accepted within band (approved)`, offer.id,
  );
  const lease = q1<any>('SELECT * FROM leases WHERE id=?', String(output.leaseId));
  const contact = q1<any>(
    `SELECT r.* FROM household_members hm JOIN residents r ON r.id=hm.resident_id WHERE hm.lease_id=? AND hm.role='primary'`, lease.id,
  );
  if (contact?.email) {
    sendEmail(ctx, {
      to: contact.email, toName: `${contact.first_name} ${contact.last_name}`,
      subject: 'Deal — your renewal offer is updated',
      body: `<p>Hi ${contact.first_name},</p><p>Good news: we can do <b>${usd(Number(output.counterCents))}/mo on the ${output.termMonths}-month term</b>. Your offer in the portal now reflects it — accept whenever you're ready.</p>`,
      propertyId: lease.property_id, entity: 'renewal_offer', entityId: offer.id, personId: contact.id, templateKey: 'ai_renewal',
    });
  }
  return `offer updated to ${usd(Number(output.counterCents))} @ ${output.termMonths}mo + resident notified`;
});

registerExecutor('renewals.escalate', (ctx, action, output) => {
  const lease = q1<any>('SELECT * FROM leases WHERE id=?', String(output.leaseId));
  const contact = q1<any>(
    `SELECT r.id FROM household_members hm JOIN residents r ON r.id=hm.resident_id WHERE hm.lease_id=? AND hm.role='primary'`, lease.id,
  );
  const pm = q1<any>(
    `SELECT u.id, u.name FROM users u JOIN role_assignments ra ON ra.user_id=u.id AND ra.role IN ('PROPERTY_MANAGER') WHERE u.org_id=? AND u.active=1 LIMIT 1`,
    ctx.orgId,
  );
  const thread = contact ? q1<any>(`SELECT id FROM threads WHERE org_id=? AND person_id=?`, ctx.orgId, contact.id) : null;
  if (thread && pm) {
    run(`UPDATE threads SET assigned_to=?, needs_reply=1, status='open' WHERE id=?`, pm.id, thread.id);
    insert('thread_notes', {
      id: id('tnn'), org_id: ctx.orgId, thread_id: thread.id,
      body: `Renewals AI: counter of ${usd(Number(output.counterCents))} is below the approved band — needs your call. ${String(output.draft).slice(0, 200)}`,
      author: 'Renewals AI', created_at: nowIso(),
    });
  }
  return pm ? `escalated to ${pm.name} with thread note` : 'no PM found to escalate to';
});

// ---------- the daily watch (dormant until setAiHooksLive) ----------

/** The approval queue tells the operator that agents check overdue balances
 * and upcoming lease ends once a day. These two jobs are what makes that true:
 * before them, a collections or renewal draft existed only if someone pressed
 * the button on that one household's page.
 *
 * Neither job judges severity. They decide only WHO gets looked at — a balance
 * past the property's own grace period; a lease inside the renewal window with
 * no offer out — and hand each household to the same drafting function the
 * button calls. Everything lands in the approval queue under the agent's dial.
 * A household is left alone while it has a draft waiting, a recent one (a week
 * for collections, a month for renewals), an active payment plan, or an open
 * collection case. */
const WATCH_LIMIT = 50; // per run; the rest are picked up on the next pass

function recentlyDrafted(ctx: Ctx, agent: 'payments' | 'renewals', leaseId: string, days: number): boolean {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return !!q1<any>(
    `SELECT id FROM ai_actions WHERE org_id=? AND agent=? AND entity_id=? AND (status='proposed' OR created_at>=?) LIMIT 1`,
    ctx.orgId, agent, leaseId, since,
  );
}

export function watchOverdueBalances(ctx: Ctx, date: string): number {
  const leases = q<any>(
    `SELECT l.id, l.property_id, MIN(c.due_date) AS first_due FROM leases l
       JOIN charges c ON c.lease_id=l.id AND c.status='active' AND c.amount_cents>0 AND c.due_date<?
      WHERE l.org_id=? AND l.status IN ('active','month_to_month','notice')
        AND NOT EXISTS (SELECT 1 FROM payment_plans pp WHERE pp.lease_id=l.id AND pp.status='active')
        AND NOT EXISTS (SELECT 1 FROM collection_cases cc WHERE cc.lease_id=l.id AND cc.status='open')
      GROUP BY l.id ORDER BY first_due`,
    date, ctx.orgId,
  );
  let drafted = 0;
  for (const l of leases) {
    if (drafted >= WATCH_LIMIT) break;
    if (leaseBalance(ctx, l.id) <= 0) continue;
    // the oldest charge still short of paid, and the property's own grace period
    const oldest = val<string>(
      `SELECT MIN(due_date) FROM charges WHERE lease_id=? AND status='active' AND amount_cents>0
         AND (SELECT COALESCE(SUM(pa.amount_cents),0) FROM payment_applications pa JOIN payments p ON p.id=pa.payment_id AND p.status IN ('pending','settled') WHERE pa.charge_id=charges.id) < amount_cents`,
      l.id,
    );
    if (!oldest) continue;
    const grace = Number(getSettingMerged<{ graceDays?: number }>(ctx, 'late_fee_policy', l.property_id)?.graceDays) || 0;
    if (date <= addDays(oldest, grace)) continue;
    if (recentlyDrafted(ctx, 'payments', l.id, 7)) continue;
    if (draftCollectionsOutreach(ctx, l.id)) drafted++;
  }
  return drafted;
}

export function watchLeaseEnds(ctx: Ctx, date: string): number {
  const leases = q<any>(
    `SELECT l.id FROM leases l WHERE l.org_id=? AND l.status='active' AND l.end_date BETWEEN ? AND ?
       AND NOT EXISTS (SELECT 1 FROM renewal_offers ro WHERE ro.lease_id=l.id AND ro.status IN ('sent','accepted','countered'))
     ORDER BY l.end_date`,
    ctx.orgId, addDays(date, 1), addDays(date, 90),
  );
  let drafted = 0;
  for (const l of leases) {
    if (drafted >= WATCH_LIMIT) break;
    if (recentlyDrafted(ctx, 'renewals', l.id, 30)) continue;
    if (draftRenewalOutreach(ctx, l.id)) drafted++;
  }
  return drafted;
}

registerJob({
  key: 'ai_collections_watch',
  name: 'Payments AI: overdue balances',
  describe: 'Once a day, drafts collections outreach (and a payment plan proposal when the balance qualifies) for households past the grace period. Drafts go to the AI approval queue; households with a recent draft, an active plan or an open collection case are left alone.',
  run: (ctx, date) => {
    if (!live) return 'agents not started';
    if (!aiEnabled(ctx)) return 'AI is paused — nothing drafted';
    const n = watchOverdueBalances(ctx, date);
    return n ? `${n} collections draft${n === 1 ? '' : 's'} added to the approval queue` : 'no new overdue balances to draft for';
  },
});

registerJob({
  key: 'ai_renewals_watch',
  name: 'Renewals AI: upcoming lease ends',
  describe: 'Once a day, drafts renewal outreach for leases ending in the next 90 days that have no renewal offer out. Drafts go to the AI approval queue; the offer is recorded when the outreach is approved.',
  run: (ctx, date) => {
    if (!live) return 'agents not started';
    if (!aiEnabled(ctx)) return 'AI is paused — nothing drafted';
    const n = watchLeaseEnds(ctx, date);
    return n ? `${n} renewal draft${n === 1 ? '' : 's'} added to the approval queue` : 'no upcoming lease ends to draft for';
  },
});

// ---------- event hooks (dormant until setAiHooksLive) ----------

on('message.inbound', (ctx, payload) => {
  if (!live) return;
  try {
    const thread = q1<any>('SELECT * FROM threads WHERE id=?', payload.entityId);
    if (!thread) return;
    const msg = q1<any>(
      `SELECT body FROM outbox_messages WHERE thread_id=? AND direction='in' ORDER BY created_at DESC LIMIT 1`, thread.id,
    );
    if (!msg) return;
    if (thread.person_kind === 'lead') {
      handleLeadInbound(sysCtx(ctx.orgId), thread.person_id, msg.body);
    } else if (thread.person_kind === 'resident' && /renew/i.test(msg.body)) {
      const money = /\$\s?([\d,]+)/.exec(msg.body);
      const term = /(\d{1,2})[- ]?month/.exec(msg.body);
      const lease = q1<any>(
        `SELECT l.id FROM leases l JOIN household_members hm ON hm.lease_id=l.id
         WHERE hm.resident_id=? AND l.status IN ('active','month_to_month') ORDER BY l.created_at DESC LIMIT 1`,
        thread.person_id,
      );
      if (money && lease) {
        evaluateCounter(sysCtx(ctx.orgId), lease.id, parseInt(money[1]!.replaceAll(',', ''), 10) * 100, term ? parseInt(term[1]!, 10) : 12);
      }
    }
  } catch {
    /* agents never break the inbox */
  }
});

on('maintenance.requested', (ctx, payload) => {
  if (!live) return;
  try {
    triageRequest(sysCtx(ctx.orgId), payload.entityId);
  } catch {
    /* agents never break intake */
  }
});

/** Instant first touch: the moment a website inquiry lands, the Leasing AI
 * drafts (or, on an `auto` dial, sends) the first reply — the five-minute
 * first-response window is where leases are won. ILS-email leads are NOT
 * handled here: their message arrives as a real inbound thread message, so
 * the message.inbound hook above already covers them. Sim-generated leads
 * (zillow/apartments_com from the demo job) are excluded so the demo queue
 * isn't flooded. Org/property-overridable via the ai_first_touch setting. */
on('lead.created', (ctx, payload) => {
  if (!live) return;
  try {
    if (payload.source !== 'website') return;
    if (getSetting<boolean>(sysCtx(ctx.orgId), 'ai_first_touch', payload.propertyId) === false) return;
    const lead = q1<any>('SELECT * FROM leads WHERE id=?', payload.entityId);
    if (!lead) return;
    handleLeadInbound(sysCtx(ctx.orgId), lead.id, lead.message || 'Hi — I found your listing and I would love more information and a tour.');
  } catch {
    /* agents never break intake */
  }
});
