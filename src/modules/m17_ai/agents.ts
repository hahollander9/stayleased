import { q, q1, val, insert, run, j, js } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, addDays, monthKey, fmtDate, addMonths } from '../../lib/dates.ts';
import { usd } from '../../lib/money.ts';
import { sysCtx, type Ctx } from '../../lib/auth.ts';
import { on, emit } from '../../lib/events.ts';
import { getSetting } from '../../lib/settings.ts';
import { getDials } from '../../lib/sim/dials.ts';
import { llm } from '../../lib/sim/llm.ts';
import { sendEmail } from '../../lib/sim/messaging.ts';
import { propose, registerExecutor, type ActionOutput } from './framework.ts';
import { messageLead, bookTour, tourSlots, quotedRent } from '../m3_crm/service.ts';
import { triageWo, woEvent } from '../m10_facilities/service.ts';
import { createPaymentPlan } from '../m8_receivables/payments.ts';
import { leaseBalance } from '../m8_receivables/service.ts';
import { renewalMatrix } from '../m6_leases/service.ts';

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

export interface LeadIntent {
  wantsTour: boolean;
  asksPets: boolean;
  asksPrice: boolean;
  asksAvailability: boolean;
  wantsHuman: boolean;
}

export function detectLeadIntent(message: string): LeadIntent {
  const m = message.toLowerCase();
  return {
    wantsTour: /\b(tour|visit|see (it|the place|the unit)|come by|look at|showing|stop by)\b/.test(m),
    asksPets: /\b(pets?|dogs?|cats?|puppy|puppies|kittens?|breeds?)\b/.test(m),
    asksPrice: /\b(price|pricing|rent|cost|how much|rate|special|deal)\b/.test(m),
    asksAvailability: /\b(available|availability|vacan|open|move.?in|when can)\b/.test(m),
    wantsHuman: /\b(human|real person|an agent|call me|speak to someone|talk to a person|manager)\b/.test(m),
  };
}

function afterHours(ctx: Ctx): boolean {
  const hours = getSetting<{ start: string; end: string }>(ctx, 'business_hours');
  const hour = getDials(ctx.orgId).clockHour;
  return hour < Number(hours.start.slice(0, 2)) || hour >= Number(hours.end.slice(0, 2));
}

export function handleLeadInbound(ctx: Ctx, leadId: string, message: string): { id: string; status: string } | null {
  const lead = q1<any>('SELECT l.*, p.name AS prop_name FROM leads l JOIN properties p ON p.id=l.property_id WHERE l.id=?', leadId);
  if (!lead) return null;
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
      : 'Nothing is move-in ready this second, but homes open up weekly — want me to put you on the first-look list?';
  }
  if (intent.asksPrice && units.length) {
    facts.pricing = `On a 12-month lease those run ${units.map((u) => `${usd(quotedRent(ctx, u, 12))}/mo (${u.unit_number})`).join(', ')} — live pricing, no games.`;
  }
  if (intent.asksPets) {
    const pol = getSetting<{ maxPets: number; petRentCents: number; depositCents: number; restricted: string }>(ctx, 'pet_policy');
    facts.petPolicy = `Pets are family here: up to ${pol.maxPets} per home, ${usd(pol.petRentCents)}/mo pet rent and a ${usd(pol.depositCents)} deposit each. (Restricted breeds: ${pol.restricted}.)`;
  }
  // tour proposal: tomorrow's first open slots
  const tomorrow = addDays(ctx.businessDate, 1);
  const slots = tourSlots(ctx, lead.property_id, tomorrow).slice(0, 3);
  let tour: { date: string; startTime: string } | null = null;
  if (intent.wantsTour && slots.length) {
    tour = { date: tomorrow, startTime: slots[0]! };
    facts.tourLine = `I can hold <b>${fmtDate(tomorrow)} at ${slots[0]}</b> for a tour${slots.length > 1 ? ` (or ${slots.slice(1).join(' / ')})` : ''} — say the word and it's yours.`;
  } else if (slots.length) {
    facts.tourLine = `If you'd like to see it in person, tomorrow has openings at ${slots.join(', ')} — I can book any of them for you.`;
  }

  const draft = llm().complete('lead_reply', facts);
  const confidence = intent.wantsHuman ? 0.4 : 0.92;
  const oh = afterHours(ctx);
  return propose(ctx, {
    agent: 'leasing',
    propertyId: lead.property_id,
    entity: 'lead',
    entityId: leadId,
    title: `${oh ? 'After-hours reply' : 'Reply'} to ${lead.first_name} ${lead.last_name}${tour ? ' + book tour' : ''}${intent.wantsHuman ? ' — HUMAN REQUESTED' : ''}`,
    input: { message, intent, afterHours: oh, groundedUnits: units.map((u) => u.unit_number) },
    output: {
      kind: 'leasing.send_reply',
      draft,
      subject: `Re: your ${lead.prop_name} inquiry`,
      leadId,
      tour,
    },
    confidence,
    guardrailNote: intent.wantsHuman ? 'low confidence: prospect asked for a person — held for staff even on autonomous' : undefined,
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

const BANNED = /(evict|lawsuit|attorney|sue you|credit bureau|collections agency will|garnish|police)/i;

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
  const tone = days <= 15 ? 'friendly' : days <= 45 ? 'firm' : 'final';
  const contact = q1<any>(
    `SELECT r.* FROM household_members hm JOIN residents r ON r.id=hm.resident_id WHERE hm.lease_id=? AND hm.role='primary'`,
    leaseId,
  );
  const bounds = getSetting<{ maxInstallments: number; minInstallmentCents: number }>(ctx, 'ai_plan_bounds');
  const planEligible = bal >= bounds.minInstallmentCents * 2 && !q1<any>(`SELECT id FROM payment_plans WHERE lease_id=? AND status='active'`, leaseId);
  const planLine = planEligible
    ? `Money tight? We can split this into ${Math.min(bounds.maxInstallments, 3)} installments — no judgment, takes two minutes to set up.`
    : null;

  const draft = llm().complete('collections_outreach', {
    name: contact?.first_name || 'there', balance: usd(bal), days, tone, planLine, propertyName: lease.prop_name,
  });
  const banned = BANNED.test(draft);
  const cleanDraft = banned ? draft.replace(BANNED, '[removed by compliance filter]') : draft;

  const outreach = propose(ctx, {
    agent: 'payments',
    propertyId: lease.property_id,
    entity: 'lease',
    entityId: leaseId,
    title: `${tone[0]!.toUpperCase()}${tone.slice(1)} outreach — ${lease.household_name} (${usd(bal)}, ${days}d)`,
    input: { balanceCents: bal, daysPastDue: days, tone },
    output: { kind: 'payments.send_outreach', draft: cleanDraft, subject: `About your ${lease.prop_name} account`, leaseId, residentId: contact?.id },
    confidence: 0.9,
    guardrailNote: `compliance: dispute path embedded; threat filter ${banned ? 'TRIGGERED and scrubbed' : 'clean'}; tone graded ${tone} at ${days} days`,
  });

  if (planEligible) {
    const n = Math.min(bounds.maxInstallments, Math.max(2, Math.ceil(bal / (bounds.minInstallmentCents * 2))));
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
  const contact = q1<any>(
    `SELECT r.* FROM household_members hm JOIN residents r ON r.id=hm.resident_id WHERE hm.lease_id=? AND hm.role='primary'`, leaseId,
  );
  const streak = onTimeStreak(ctx, leaseId);
  const rating = val<number>(`SELECT AVG(rating) FROM work_orders WHERE lease_id=? AND rating IS NOT NULL`, leaseId);
  const options = renewalMatrix(ctx, lease);
  const draft = llm().complete('renewal_outreach', {
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
    input: { streak, rating, options },
    output: { kind: 'renewals.send_outreach', draft, subject: `Let's keep ${lease.unit_number} yours 🏡`, leaseId, residentId: contact?.id },
    confidence: 0.9,
  });
}

registerExecutor('renewals.send_outreach', (ctx, action, output) => {
  const lease = q1<any>('SELECT * FROM leases WHERE id=?', String(output.leaseId));
  const res = output.residentId ? q1<any>('SELECT * FROM residents WHERE id=?', String(output.residentId)) : null;
  if (!res?.email) return 'no primary contact email';
  sendEmail(ctx, {
    to: res.email, toName: `${res.first_name} ${res.last_name}`, subject: String(output.subject),
    body: String(output.draft), propertyId: lease.property_id, entity: 'lease', entityId: lease.id,
    personId: res.id, templateKey: 'ai_renewal',
  });
  return 'renewal outreach sent';
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
