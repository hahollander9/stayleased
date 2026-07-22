import { q, q1, insert, val, run, update, tx } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, addDays, fmtDate, diffDays, dowIdx } from '../../lib/dates.ts';
import type { Ctx } from '../../lib/auth.ts';
import { emit } from '../../lib/events.ts';
import { getSetting } from '../../lib/settings.ts';
import { registerJob } from '../../lib/jobs.ts';
import { getDials } from '../../lib/sim/dials.ts';
import { sendEmail, sendSms } from '../../lib/sim/messaging.ts';
import { Rng } from '../../lib/rng.ts';
import { FIRST, LAST } from '../../seed/names.ts';
import { unitStats } from '../m2_portfolio/service.ts';

/** M3 services: lead intake with dedupe, cadences, tours, quotes, the IlsFeed
 * simulator, funnel analytics, Leasing Center round-robin. */

export const LEAD_SOURCES = ['zillow', 'apartments_com', 'facebook', 'craigslist', 'google', 'website', 'walk_in', 'phone', 'referral'] as const;

export interface LeadIntake {
  propertyId: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  source: string;
  channel?: string;
  desiredMoveIn?: string | null;
  beds?: number | null;
  budgetCents?: number | null;
  message?: string | null;
}

/** intake with automatic dedupe by email/phone (M3.1) */
export function intakeLead(ctx: Ctx, input: LeadIntake): { leadId: string; deduped: boolean } {
  const existing = q1<any>(
    `SELECT * FROM leads WHERE org_id=? AND (
       (email IS NOT NULL AND email != '' AND email = ?) OR
       (phone IS NOT NULL AND phone != '' AND phone = ?)
     ) ORDER BY created_at DESC LIMIT 1`,
    ctx.orgId, (input.email || '').toLowerCase(), input.phone || '',
  );
  if (existing) {
    leadEvent(ctx, existing.id, 'inquiry', `New ${input.source} inquiry${input.message ? `: “${input.message.slice(0, 140)}”` : ''} (deduped into this guest card)`);
    update('leads', existing.id, {
      last_activity_at: nowIso(),
      desired_move_in: input.desiredMoveIn || existing.desired_move_in,
      beds: input.beds ?? existing.beds,
      budget_cents: input.budgetCents ?? existing.budget_cents,
      status: ['lost', 'leased'].includes(existing.status) ? 'new' : existing.status,
    });
    ensureCadence(ctx, existing.id, existing.property_id);
    emit(ctx, 'lead.inquiry', 'lead', existing.id, { deduped: true, source: input.source });
    return { leadId: existing.id, deduped: true };
  }
  const leadId = id('led');
  insert('leads', {
    id: leadId, org_id: ctx.orgId, property_id: input.propertyId,
    first_name: input.firstName, last_name: input.lastName,
    email: (input.email || '').toLowerCase() || null, phone: input.phone || null,
    source: input.source, channel: input.channel || 'email', status: 'new',
    desired_move_in: input.desiredMoveIn || null, beds: input.beds ?? null,
    budget_cents: input.budgetCents ?? null, message: input.message || null,
    last_activity_at: nowIso(), created_date: ctx.businessDate, created_at: nowIso(),
  });
  leadEvent(ctx, leadId, 'inquiry', `${sourceLabel(input.source)} inquiry${input.message ? `: “${input.message.slice(0, 140)}”` : ''}`);
  ensureCadence(ctx, leadId, input.propertyId);
  emit(ctx, 'lead.created', 'lead', leadId, { source: input.source, propertyId: input.propertyId });
  return { leadId, deduped: false };
}

export function leadEvent(ctx: Ctx, leadId: string, kind: string, body: string): void {
  insert('lead_events', {
    id: id('lev'), org_id: ctx.orgId, lead_id: leadId, kind, body,
    actor: ctx.userName, at: nowIso(), business_date: ctx.businessDate,
  });
  run('UPDATE leads SET last_activity_at=? WHERE id=?', nowIso(), leadId);
}

/** follow-up cadence (M3.4): first-response today + day-N tasks */
function ensureCadence(ctx: Ctx, leadId: string, propertyId: string): void {
  const open = val<number>(`SELECT COUNT(*) FROM followup_tasks WHERE lead_id=? AND status='open'`, leadId) || 0;
  if (open > 0) return;
  const days = getSetting<number[]>(ctx, 'followup_cadence_days', propertyId);
  const labels = ['first_response', 'day_1', 'day_3', 'day_7', 'day_14'];
  days.forEach((d, i) => {
    insert('followup_tasks', {
      id: id('fut'), org_id: ctx.orgId, property_id: propertyId, lead_id: leadId,
      kind: labels[i] || `day_${d}`, due_date: addDays(ctx.businessDate, d), status: 'open', created_at: nowIso(),
    });
  });
}

/** an outbound touch completes the earliest open cadence task */
export function completeNextTask(ctx: Ctx, leadId: string): void {
  const task = q1<any>(`SELECT * FROM followup_tasks WHERE lead_id=? AND status='open' ORDER BY due_date LIMIT 1`, leadId);
  if (task) run(`UPDATE followup_tasks SET status='done', done_at=? WHERE id=?`, nowIso(), task.id);
}

export function setLeadStatus(ctx: Ctx, leadId: string, status: string, reason?: string): void {
  const lead = q1<any>('SELECT * FROM leads WHERE id=? AND org_id=?', leadId, ctx.orgId);
  if (!lead) throw new Error('lead not found');
  update('leads', leadId, { status, lost_reason: status === 'lost' ? reason || 'no reason given' : null });
  leadEvent(ctx, leadId, 'status', `Status → ${status}${reason ? ` (${reason})` : ''}`);
  if (['leased', 'lost'].includes(status)) {
    run(`UPDATE followup_tasks SET status='skipped' WHERE lead_id=? AND status='open'`, leadId);
  }
  emit(ctx, `lead.${status}`, 'lead', leadId, {});
}

/** outbound message from the guest card */
export function messageLead(ctx: Ctx, leadId: string, channel: 'email' | 'sms', subject: string, body: string): void {
  const lead = q1<any>('SELECT * FROM leads WHERE id=? AND org_id=?', leadId, ctx.orgId);
  if (!lead) throw new Error('lead not found');
  if (channel === 'email' && lead.email) {
    sendEmail(ctx, {
      to: lead.email, toName: `${lead.first_name} ${lead.last_name}`, subject,
      body: `<p>${body.replaceAll('\n', '<br/>')}</p>`, propertyId: lead.property_id,
      entity: 'lead', entityId: leadId, personId: leadId,
    });
  } else if (channel === 'sms' && lead.phone) {
    sendSms(ctx, {
      to: lead.phone, toName: `${lead.first_name} ${lead.last_name}`, body,
      propertyId: lead.property_id, entity: 'lead', entityId: leadId, personId: leadId,
    });
  } else {
    throw new Error(`lead has no ${channel} on file`);
  }
  leadEvent(ctx, leadId, channel === 'email' ? 'email_out' : 'sms_out', `${subject ? subject + ' — ' : ''}${body.slice(0, 120)}`);
  completeNextTask(ctx, leadId);
  if (lead.status === 'new') update('leads', leadId, { status: 'contacted' });
}

// ---------- tours (M3.3) ----------

export function tourSlots(ctx: Ctx, propertyId: string, date: string): string[] {
  const hours = getSetting<{ start: string; end: string; days: number[]; slotMinutes: number }>(ctx, 'tour_hours', propertyId);
  if (!hours.days.includes(dowIdx(date))) return [];
  const out: string[] = [];
  const [sh, sm] = hours.start.split(':').map(Number);
  const [eh, em] = hours.end.split(':').map(Number);
  let t = sh! * 60 + (sm || 0);
  const end = eh! * 60 + (em || 0);
  const taken = new Set(q<any>(`SELECT start_time FROM tours WHERE property_id=? AND date=? AND status='scheduled'`, propertyId, date).map((x) => x.start_time));
  while (t + hours.slotMinutes <= end) {
    const hhmm = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    if (!taken.has(hhmm)) out.push(hhmm);
    t += hours.slotMinutes;
  }
  return out;
}

export function bookTour(
  ctx: Ctx,
  opts: { leadId: string; date: string; startTime: string; type?: string; unitId?: string | null; agentUserId?: string | null; skipConfirmation?: boolean },
): string {
  const lead = q1<any>('SELECT * FROM leads WHERE id=? AND org_id=?', opts.leadId, ctx.orgId);
  if (!lead) throw new Error('lead not found');
  const clash = q1<any>(
    `SELECT id FROM tours WHERE property_id=? AND date=? AND start_time=? AND status='scheduled'`,
    lead.property_id, opts.date, opts.startTime,
  );
  if (clash) throw new Error('that slot was just taken — pick another');
  const tourId = id('tur');
  insert('tours', {
    id: tourId, org_id: ctx.orgId, property_id: lead.property_id, lead_id: lead.id,
    unit_id: opts.unitId || null, type: opts.type || 'in_person', date: opts.date, start_time: opts.startTime,
    agent_user_id: opts.agentUserId || (ctx.kind === 'staff' ? ctx.userId : null), status: 'scheduled', created_at: nowIso(),
  });
  leadEvent(ctx, lead.id, 'tour_scheduled', `${(opts.type || 'in_person').replaceAll('_', ' ')} tour booked for ${fmtDate(opts.date)} ${opts.startTime}`);
  if (lead.status === 'new' || lead.status === 'contacted') update('leads', lead.id, { status: 'touring' });
  completeNextTask(ctx, lead.id);
  if (!opts.skipConfirmation && lead.email) {
    sendEmail(ctx, {
      to: lead.email, toName: `${lead.first_name} ${lead.last_name}`,
      subject: `Your tour is confirmed — ${fmtDate(opts.date)} at ${opts.startTime}`,
      body: `<p>Hi ${lead.first_name},</p><p>You're confirmed for a ${(opts.type || 'in-person').replaceAll('_', ' ')} tour on <b>${fmtDate(opts.date)} at ${opts.startTime}</b>. Reply to this message if you need to reschedule — see you soon!</p>`,
      propertyId: lead.property_id, entity: 'tour', entityId: tourId, personId: lead.id, templateKey: 'tour_confirmation',
    });
  }
  emit(ctx, 'tour.scheduled', 'tour', tourId, { leadId: lead.id, date: opts.date });
  return tourId;
}

export function completeTour(ctx: Ctx, tourId: string, outcome: 'completed' | 'no_show', notes?: string): void {
  const tour = q1<any>('SELECT * FROM tours WHERE id=? AND org_id=?', tourId, ctx.orgId);
  if (!tour) throw new Error('tour not found');
  update('tours', tourId, { status: outcome, notes: notes || tour.notes });
  leadEvent(ctx, tour.lead_id, outcome === 'completed' ? 'tour_completed' : 'tour_noshow', outcome === 'completed' ? `Tour completed${notes ? ` — ${notes}` : ''}` : 'No-show for tour');
  if (outcome === 'completed') run(`UPDATE leads SET status='toured' WHERE id=? AND status IN ('new','contacted','touring')`, tour.lead_id);
  else {
    // no-show → fresh follow-up task tomorrow
    insert('followup_tasks', {
      id: id('fut'), org_id: ctx.orgId, property_id: tour.property_id, lead_id: tour.lead_id,
      kind: 'custom', due_date: addDays(ctx.businessDate, 1), status: 'open', created_at: nowIso(),
    });
  }
  emit(ctx, `tour.${outcome}`, 'tour', tourId, { leadId: tour.lead_id });
}

// ---------- quotes (M3.5) ----------

export function buildQuote(
  ctx: Ctx,
  opts: { leadId: string; unitId: string; termMonths: number; moveIn: string; itemIds?: string[]; concessionNote?: string },
): string {
  const lead = q1<any>('SELECT * FROM leads WHERE id=? AND org_id=?', opts.leadId, ctx.orgId);
  const unit = q1<any>('SELECT * FROM units WHERE id=? AND org_id=?', opts.unitId, ctx.orgId);
  if (!lead || !unit) throw new Error('lead or unit not found');
  // Phase 14 swaps this for the pricing engine's recommended term rates
  const rent = quotedRent(ctx, unit, opts.termMonths);
  const items: { label: string; monthly_cents: number }[] = [];
  for (const itemId of opts.itemIds || []) {
    const item = q1<any>(`SELECT * FROM rentable_items WHERE id=? AND status='available'`, itemId);
    if (item) items.push({ label: item.label, monthly_cents: item.monthly_cents });
  }
  const total = rent + items.reduce((s, x) => s + x.monthly_cents, 0);
  const quoteId = id('qot');
  insert('quotes', {
    id: quoteId, org_id: ctx.orgId, property_id: unit.property_id, lead_id: lead.id, unit_id: unit.id,
    term_months: opts.termMonths, move_in: opts.moveIn, rent_cents: rent,
    items: JSON.stringify(items), concession_note: opts.concessionNote || null,
    total_monthly_cents: total, expires_date: addDays(ctx.businessDate, 14), status: 'sent',
    created_by: ctx.userId, created_at: nowIso(),
  });
  leadEvent(ctx, lead.id, 'quote', `Quote: unit ${unit.unit_number}, ${opts.termMonths} mo @ ${(total / 100).toFixed(0)}/mo, move-in ${fmtDate(opts.moveIn)}`);
  if (lead.email) {
    sendEmail(ctx, {
      to: lead.email, toName: `${lead.first_name} ${lead.last_name}`,
      subject: `Your personalized quote for unit ${unit.unit_number}`,
      body: `<p>Hi ${lead.first_name},</p><p>Here's your quote for <b>unit ${unit.unit_number}</b> (valid 14 days):</p><ul><li>Rent (${opts.termMonths}-month term): $${(rent / 100).toFixed(2)}/mo</li>${items.map((x) => `<li>${x.label}: $${(x.monthly_cents / 100).toFixed(2)}/mo</li>`).join('')}</ul><p><b>Total: $${(total / 100).toFixed(2)}/mo</b> · Move-in ${fmtDate(opts.moveIn)}${opts.concessionNote ? `<br/>Special: ${opts.concessionNote}` : ''}</p><p>Ready when you are — apply online any time.</p>`,
      propertyId: unit.property_id, entity: 'quote', entityId: quoteId, personId: lead.id, templateKey: 'quote',
    });
  }
  completeNextTask(ctx, lead.id);
  emit(ctx, 'quote.created', 'quote', quoteId, { leadId: lead.id, unitId: unit.id, totalMonthly: total });
  return quoteId;
}

/** static term pricing until M13: base rent, small premium for short terms, discount for long */
export function quotedRent(ctx: Ctx, unit: any, termMonths: number): number {
  const priced = q1<any>(
    `SELECT accepted_rent_cents FROM price_recommendations WHERE unit_id=? AND term_months=? AND status='accepted' ORDER BY date DESC LIMIT 1`,
    unit.id, termMonths,
  );
  if (priced?.accepted_rent_cents) return priced.accepted_rent_cents;
  const base = unit.market_rent_cents;
  if (termMonths <= 6) return Math.round((base * 1.08) / 100) * 100;
  if (termMonths <= 9) return Math.round((base * 1.04) / 100) * 100;
  if (termMonths >= 15) return Math.round((base * 0.98) / 100) * 100;
  return base;
}

// ---------- IlsFeed simulator (M3.1 / §3.4) ----------

const INQUIRY_POOL = [
  'Hi! Is the {plan} still available? What does move-in cost look like?',
  'Interested in touring this weekend if possible.',
  'Do you allow {pet}? Looking to move around {month}.',
  'What are current specials? Saw the listing on {source}.',
  'Is water/trash included in rent?',
  'How is parking handled? I have two cars.',
  'Looking for a quiet unit, top floor preferred. Anything open?',
];

registerJob({
  key: 'ils_leads',
  name: 'ILS lead feed (simulator)',
  describe: 'Zillow/Apartments.com-style inbound leads arrive per property per day (dial: leadsPerDay); ~10% are repeat inquiries that dedupe.',
  run: (ctx, date) => {
    const dials = getDials(ctx.orgId);
    const props = q<any>('SELECT * FROM properties WHERE org_id=?', ctx.orgId);
    const rng = new Rng(hashDate(date) ^ 77);
    let created = 0;
    let deduped = 0;
    for (const prop of props) {
      const n = Math.max(0, Math.round(rng.around(dials.leadsPerDay, dials.leadsPerDay * 0.7)));
      for (let i = 0; i < n; i++) {
        const source = rng.weighted([['zillow', 28], ['apartments_com', 24], ['google', 15], ['facebook', 12], ['craigslist', 8], ['referral', 7], ['phone', 6]] as const);
        // ~10% repeat inquiry from an existing lead
        const repeat = rng.chance(0.1) ? q1<any>(`SELECT * FROM leads WHERE property_id=? AND email IS NOT NULL ORDER BY created_at DESC LIMIT 1`, prop.id) : null;
        const first = repeat?.first_name || rng.pick(FIRST);
        const last = repeat?.last_name || rng.pick(LAST);
        const email = repeat?.email || `${first}.${last}${rng.int(2, 99)}@inbox.demo`.toLowerCase();
        const fp = q1<any>('SELECT * FROM floorplans WHERE property_id=? ORDER BY RANDOM() LIMIT 1', prop.id);
        const msg = rng.pick(INQUIRY_POOL)
          .replace('{plan}', fp?.name || 'one bedroom')
          .replace('{pet}', rng.chance(0.6) ? 'a small dog' : 'cats')
          .replace('{month}', ['next month', 'August', 'September', 'early fall'][rng.int(0, 3)]!)
          .replace('{source}', source);
        const res = intakeLead(ctx, {
          propertyId: prop.id, firstName: first, lastName: last, email,
          phone: rng.chance(0.7) ? `(555) ${rng.int(200, 989)}-${rng.int(1000, 9999)}` : null,
          source, channel: source === 'phone' ? 'phone' : 'email',
          desiredMoveIn: addDays(date, rng.int(10, 75)), beds: fp?.beds ?? rng.int(0, 3),
          budgetCents: fp ? Math.round((fp.market_rent_cents * (0.9 + rng.next() * 0.3)) / 5000) * 5000 : null,
          message: msg,
        });
        if (res.deduped) deduped++;
        else created++;
      }
    }
    return `${created} new leads, ${deduped} deduped`;
  },
});

registerJob({
  key: 'tour_reminders',
  name: 'Tour reminders',
  describe: 'Sends reminder email/SMS the day before each scheduled tour.',
  run: (ctx, date) => {
    const tomorrow = addDays(date, 1);
    const due = q<any>(
      `SELECT t.*, l.first_name, l.last_name, l.email, l.phone FROM tours t JOIN leads l ON l.id=t.lead_id
       WHERE t.org_id=? AND t.status='scheduled' AND t.date=? AND t.reminder_sent=0`,
      ctx.orgId, tomorrow,
    );
    for (const t of due) {
      if (t.email) {
        sendEmail(ctx, {
          to: t.email, toName: `${t.first_name} ${t.last_name}`, subject: `Reminder: your tour tomorrow at ${t.start_time}`,
          body: `<p>Hi ${t.first_name} — quick reminder about your tour tomorrow (${fmtDate(t.date)}) at <b>${t.start_time}</b>. Reply if you need to reschedule!</p>`,
          propertyId: t.property_id, entity: 'tour', entityId: t.id, personId: t.lead_id, templateKey: 'tour_reminder',
        });
      }
      run('UPDATE tours SET reminder_sent=1 WHERE id=?', t.id);
    }
    return due.length ? `${due.length} reminders sent` : 'no tours tomorrow';
  },
});

function hashDate(d: string): number {
  let h = 0;
  for (let i = 0; i < d.length; i++) h = (h * 31 + d.charCodeAt(i)) >>> 0;
  return h;
}

function sourceLabel(s: string): string {
  const map: Record<string, string> = {
    zillow: 'Zillow', apartments_com: 'Apartments.com', facebook: 'Facebook', craigslist: 'Craigslist',
    google: 'Google', website: 'Website', walk_in: 'Walk-in', phone: 'Phone', referral: 'Referral',
  };
  return map[s] || s;
}

// ---------- Leasing Center (M3.6) ----------

export function roundRobinAssign(ctx: Ctx): number {
  const agents = q<any>(
    `SELECT DISTINCT u.id FROM users u JOIN role_assignments ra ON ra.user_id=u.id
     WHERE u.org_id=? AND u.active=1 AND ra.role='LEASING_AGENT'`,
    ctx.orgId,
  );
  if (!agents.length) return 0;
  const unassigned = q<any>(
    `SELECT id FROM leads WHERE org_id=? AND assigned_to_user_id IS NULL AND status IN ('new','contacted','touring') ORDER BY created_at`,
    ctx.orgId,
  );
  unassigned.forEach((lead, i) => {
    run('UPDATE leads SET assigned_to_user_id=? WHERE id=?', agents[i % agents.length]!.id, lead.id);
  });
  return unassigned.length;
}

// ---------- funnel analytics (M3.7) ----------

export interface FunnelStats {
  inquiries: number;
  toured: number;
  applied: number;
  leased: number;
  bySource: { source: string; inquiries: number; tours: number; apps: number; leases: number; costCents: number }[];
  agents: { name: string; leads: number; tours: number; closes: number; avgResponseHours: number | null }[];
}

export function funnelStats(ctx: Ctx, sinceDate: string, propertyId?: string | null): FunnelStats {
  const propSql = propertyId ? ' AND l.property_id=?' : '';
  const p = propertyId ? [propertyId] : [];
  const leads = q<any>(`SELECT l.* FROM leads l WHERE l.org_id=? AND l.created_date>=?${propSql}`, ctx.orgId, sinceDate, ...p);
  const tourSet = new Set(q<any>(`SELECT DISTINCT lead_id FROM tours WHERE org_id=? AND status IN ('completed')`, ctx.orgId).map((x) => x.lead_id));
  const inquiries = leads.length;
  const toured = leads.filter((l) => tourSet.has(l.id) || ['toured', 'applied', 'leased'].includes(l.status)).length;
  const applied = leads.filter((l) => ['applied', 'leased'].includes(l.status)).length;
  const leased = leads.filter((l) => l.status === 'leased').length;
  const sources = new Map<string, { inquiries: number; tours: number; apps: number; leases: number }>();
  for (const l of leads) {
    const s = sources.get(l.source) || { inquiries: 0, tours: 0, apps: 0, leases: 0 };
    s.inquiries++;
    if (tourSet.has(l.id) || ['toured', 'applied', 'leased'].includes(l.status)) s.tours++;
    if (['applied', 'leased'].includes(l.status)) s.apps++;
    if (l.status === 'leased') s.leases++;
    sources.set(l.source, s);
  }
  const months = Math.max(1, Math.round(diffDays(ctx.businessDate, sinceDate) / 30));
  const bySource = [...sources.entries()].map(([source, x]) => ({
    source,
    ...x,
    costCents: (val<number>(
      `SELECT COALESCE(SUM(monthly_cost_cents),0) FROM campaigns WHERE org_id=? AND source=? AND active=1${propertyId ? ' AND (property_id=? OR property_id IS NULL)' : ''}`,
      ctx.orgId, source, ...(propertyId ? [propertyId] : []),
    ) || 0) * months,
  })).sort((a, b) => b.inquiries - a.inquiries);
  // agent leaderboard
  const agents = q<any>(
    `SELECT u.id, u.name FROM users u JOIN role_assignments ra ON ra.user_id=u.id WHERE u.org_id=? AND ra.role='LEASING_AGENT' AND u.active=1`,
    ctx.orgId,
  ).map((agent) => {
    const mine = leads.filter((l) => l.assigned_to_user_id === agent.id);
    const tours = val<number>(
      `SELECT COUNT(*) FROM tours WHERE org_id=? AND agent_user_id=? AND date>=?`,
      ctx.orgId, agent.id, sinceDate,
    ) || 0;
    const closes = mine.filter((l) => l.status === 'leased').length;
    // response time: first outbound event after creation
    const resp = q<any>(
      `SELECT l.created_at, (SELECT MIN(e.at) FROM lead_events e WHERE e.lead_id=l.id AND e.kind IN ('email_out','sms_out','call')) AS first_touch
       FROM leads l WHERE l.org_id=? AND l.assigned_to_user_id=? AND l.created_date>=?`,
      ctx.orgId, agent.id, sinceDate,
    ).filter((x) => x.first_touch);
    const avgResponseHours = resp.length
      ? Math.round((resp.reduce((s, x) => s + (new Date(x.first_touch).getTime() - new Date(x.created_at).getTime()), 0) / resp.length / 3600000) * 10) / 10
      : null;
    return { name: agent.name, leads: mine.length, tours, closes, avgResponseHours };
  }).sort((a, b) => b.closes - a.closes || b.tours - a.tours);
  return { inquiries, toured, applied, leased, bySource, agents };
}

/** high-exposure floorplan flag (M3.8) */
export function highExposureFloorplans(ctx: Ctx, propertyId: string): Set<number> {
  const fps = q<any>(
    `SELECT f.beds,
      (SELECT COUNT(*) FROM units u WHERE u.floorplan_id=f.id AND u.status IN ('vacant_ready','vacant_not_ready','notice')) AS exposed,
      (SELECT COUNT(*) FROM units u WHERE u.floorplan_id=f.id) AS total
     FROM floorplans f WHERE f.property_id=?`,
    propertyId,
  );
  const out = new Set<number>();
  for (const fp of fps) {
    if (fp.total > 0 && fp.exposed / fp.total >= 0.12) out.add(fp.beds);
  }
  return out;
}
