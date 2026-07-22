import { html, raw, when, join } from '../../lib/html.ts';
import { redirect, notFound, type Router, type Rq } from '../../lib/http.ts';
import { requirePerm, propFilter, canAccessProperty, can, type Ctx } from '../../lib/auth.ts';
import { q, q1, val, run, insert, update, j } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, fmtDate, addDays, diffDays, fmtTs } from '../../lib/dates.ts';
import { usd } from '../../lib/money.ts';
import { v } from '../../lib/validate.ts';
import { audit } from '../../lib/audit.ts';
import {
  shell, card, tbl, kpis, dl, tabs, statusBadge, field, input, select, textarea, moneyInput,
  registerNav, registerSearch, pager, emptyState,
} from '../../ui/ui.ts';
import { funnel as funnelChart, bars } from '../../lib/charts.ts';
import {
  intakeLead, leadEvent, setLeadStatus, messageLead, tourSlots, bookTour, completeTour,
  buildQuote, quotedRent, funnelStats, roundRobinAssign, highExposureFloorplans, LEAD_SOURCES, completeNextTask,
} from './service.ts';
import { registerDashboardExtras } from '../m2_portfolio/pages.ts';

registerNav('Leasing', { href: '/leads', label: 'Leads', perm: 'leasing:view', match: ['/leads'] });
registerNav('Leasing', { href: '/tours', label: 'Tours', perm: 'leasing:view' });
registerNav('Leasing', { href: '/leasing-center', label: 'Leasing Center', perm: 'leasing:center' });
registerNav('Leasing', { href: '/leasing/analytics', label: 'Funnel analytics', perm: 'leasing:view' });

registerSearch((ctx, query) => {
  if (!ctx.perms.has('leasing:view')) return [];
  const like = `%${query}%`;
  const pf = propFilter(ctx, 'property_id');
  return q<any>(
    `SELECT id, first_name || ' ' || last_name AS name, email, status FROM leads
     WHERE org_id=? AND (first_name || ' ' || last_name LIKE ? OR email LIKE ?)${pf.sql} ORDER BY created_at DESC LIMIT 6`,
    ctx.orgId, like, like, ...pf.params,
  ).map((l) => ({ kind: 'lead', label: l.name, sub: `${l.status} · ${l.email || ''}`, href: `/leads/${l.id}` }));
});

registerDashboardExtras((ctx, propertyId) => {
  const propSql = propertyId ? ' AND property_id=?' : '';
  const p = propertyId ? [propertyId] : [];
  const week = val<number>(`SELECT COUNT(*) FROM leads WHERE org_id=? AND created_date>=?${propSql}`, ctx.orgId, addDays(ctx.businessDate, -7), ...p) || 0;
  const overdue = val<number>(
    `SELECT COUNT(*) FROM followup_tasks WHERE org_id=? AND status='open' AND due_date<?${propSql}`,
    ctx.orgId, ctx.businessDate, ...p,
  ) || 0;
  return {
    kpis: [
      { label: 'Leads (7d)', value: week, href: '/leads', tone: 'accent' },
      { label: 'Overdue follow-ups', value: overdue, tone: overdue ? 'warn' : 'ok', href: '/leads?filter=overdue' },
    ],
    panels: null,
  };
});

const LEAD_STATUSES = ['new', 'contacted', 'touring', 'toured', 'applied', 'leased', 'lost'];

export function routes(r: Router): void {
  // ---------- lead inbox ----------
  r.get('/leads', requirePerm('leasing:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const status = rq.query.get('status') || 'active';
    const source = rq.query.get('source') || '';
    const filter = rq.query.get('filter') || '';
    const pf = propFilter(ctx, 'l.property_id');
    const params: unknown[] = [ctx.orgId, ...pf.params];
    let where = `l.org_id=?${pf.sql}`;
    if (status === 'active') where += ` AND l.status IN ('new','contacted','touring','toured')`;
    else if (status) { where += ' AND l.status=?'; params.push(status); }
    if (source) { where += ' AND l.source=?'; params.push(source); }
    if (filter === 'overdue') where += ` AND EXISTS (SELECT 1 FROM followup_tasks t WHERE t.lead_id=l.id AND t.status='open' AND t.due_date<'${ctx.businessDate}')`;
    const total = val<number>(`SELECT COUNT(*) FROM leads l WHERE ${where}`, ...params);
    const page = Math.max(1, parseInt(rq.query.get('page') || '1', 10) || 1);
    const rows = q<any>(
      `SELECT l.*, p.name AS prop_name,
        (SELECT MIN(due_date) FROM followup_tasks t WHERE t.lead_id=l.id AND t.status='open') AS next_task,
        (SELECT name FROM users u WHERE u.id=l.assigned_to_user_id) AS agent
       FROM leads l JOIN properties p ON p.id=l.property_id WHERE ${where}
       ORDER BY CASE WHEN l.status='new' THEN 0 ELSE 1 END, l.last_activity_at DESC LIMIT 50 OFFSET ?`,
      ...params, (page - 1) * 50,
    );
    const exposureByProp = new Map<string, Set<number>>();
    return shell(rq, {
      title: 'Lead inbox',
      active: '/leads',
      actions: html`<a class="btn" href="/leads/new">Log walk-in / call</a>`,
      subtitle: `Leads arrive from the ILS feed, website, phone and walk-ins — duplicates merge into one guest card.`,
      content: html`
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Status', select('status', [['active', 'Active pipeline'], ...LEAD_STATUSES.map((s): [string, string] => [s, s])], status))}
          ${field('Source', select('source', LEAD_SOURCES.map((s): [string, string] => [s, s.replaceAll('_', ' ')]), source, { blank: 'All sources' }))}
          ${field('Filter', select('filter', [['overdue', 'Overdue follow-ups']], filter, { blank: '—' }))}
        </form>
        ${card(null, html`${tbl(
          [{ label: 'Lead' }, { label: 'Property' }, { label: 'Looking for' }, { label: 'Source' }, { label: 'Status' }, { label: 'Next follow-up' }, { label: 'Agent' }],
          rows.map((l) => {
            if (!exposureByProp.has(l.property_id)) exposureByProp.set(l.property_id, highExposureFloorplans(ctx, l.property_id));
            const hot = l.beds !== null && exposureByProp.get(l.property_id)!.has(l.beds);
            const overdueTask = l.next_task && l.next_task < ctx.businessDate;
            return {
              href: `/leads/${l.id}`,
              cells: [
                html`<b>${l.first_name} ${l.last_name}</b>${hot ? html` <span class="badge warn" title="High-exposure floorplan — prioritize">high exposure</span>` : ''}<span class="sub">${l.email || l.phone || ''}</span>`,
                l.prop_name,
                html`<span class="small">${l.beds === null ? '—' : l.beds === 0 ? 'Studio' : `${l.beds} bd`}${l.budget_cents ? ` · ~${usd(l.budget_cents)}` : ''}${l.desired_move_in ? ` · ${fmtDate(l.desired_move_in)}` : ''}</span>`,
                statusBadge(undefined, l.source.replaceAll('_', ' ')),
                statusBadge(l.status),
                l.next_task ? html`<span class="${overdueTask ? 'neg' : ''}">${fmtDate(l.next_task)}${overdueTask ? ' ⚠' : ''}</span>` : '—',
                l.agent || html`<span class="muted">—</span>`,
              ],
            };
          }),
          { empty: 'No leads match. Advance the business date to let the ILS feed deliver more.' },
        )}${pager(rq, total)}`, { flush: true })}`,
    });
  });

  r.get('/leads/new', requirePerm('leasing:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const props = q<any>(`SELECT id, name FROM properties WHERE org_id=?${propFilter(ctx, 'id').sql} ORDER BY name`, ctx.orgId, ...propFilter(ctx, 'id').params);
    return shell(rq, {
      title: 'Log a walk-in / phone lead',
      active: '/leads',
      crumbs: [['Leads', '/leads']],
      content: card(null, html`<form method="post" action="/leads/new">
        <div class="form-grid">
          ${field('Property', select('property_id', props.map((p): [string, string] => [p.id, p.name]), ctx.currentPropertyId || props[0]?.id, { required: true }))}
          ${field('Source', select('source', [['walk_in', 'Walk-in'], ['phone', 'Phone'], ['referral', 'Referral'], ['website', 'Website']], 'walk_in'))}
          ${field('First name', input('first_name', { required: true }))}
          ${field('Last name', input('last_name', { required: true }))}
          ${field('Email', input('email', { type: 'email' }))}
          ${field('Phone', input('phone', { type: 'tel' }))}
          ${field('Desired move-in', input('desired_move_in', { type: 'date' }))}
          ${field('Beds', select('beds', [['0', 'Studio'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']], undefined, { blank: '—' }))}
          ${field('Budget / mo', moneyInput('budget'))}
        </div>
        ${field('Notes', textarea('message', { rows: 2 }))}
        <button class="btn">Create guest card</button>
      </form>`),
    });
  });

  r.post('/leads/new', requirePerm('leasing:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const res = intakeLead(ctx, {
      propertyId: String(rq.body.property_id), firstName: String(rq.body.first_name || '').trim(),
      lastName: String(rq.body.last_name || '').trim(), email: rq.body.email ? String(rq.body.email) : null,
      phone: rq.body.phone ? String(rq.body.phone) : null, source: String(rq.body.source || 'walk_in'),
      channel: 'in_person', desiredMoveIn: rq.body.desired_move_in || null,
      beds: rq.body.beds !== '' && rq.body.beds !== undefined ? parseInt(String(rq.body.beds), 10) : null,
      budgetCents: rq.body.budget ? v.cents().parse(rq.body.budget) : null,
      message: rq.body.message || null,
    });
    return redirect(`/leads/${res.leadId}`, res.deduped ? 'Matched an existing guest card — inquiry added to the timeline.' : 'Guest card created.');
  });

  // ---------- guest card ----------
  r.get('/leads/:id', requirePerm('leasing:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const l = q1<any>(
      `SELECT l.*, p.name AS prop_name, (SELECT name FROM users u WHERE u.id=l.assigned_to_user_id) AS agent
       FROM leads l JOIN properties p ON p.id=l.property_id WHERE l.id=? AND l.org_id=?`,
      rq.params.id!, ctx.orgId,
    );
    if (!l || !canAccessProperty(ctx, l.property_id)) return notFound('Lead not found');
    const events = q<any>('SELECT * FROM lead_events WHERE lead_id=? ORDER BY at DESC LIMIT 60', l.id);
    const tasks = q<any>(`SELECT * FROM followup_tasks WHERE lead_id=? ORDER BY due_date`, l.id);
    const toursRows = q<any>(`SELECT * FROM tours WHERE lead_id=? ORDER BY date DESC`, l.id);
    const quotesRows = q<any>(`SELECT qt.*, u.unit_number FROM quotes qt JOIN units u ON u.id=qt.unit_id WHERE qt.lead_id=? ORDER BY qt.created_at DESC`, l.id);
    const availUnits = q<any>(
      `SELECT u.*, f.name AS fp_name, f.beds FROM units u LEFT JOIN floorplans f ON f.id=u.floorplan_id
       WHERE u.property_id=? AND u.status='vacant_ready' ORDER BY u.market_rent_cents LIMIT 40`,
      l.property_id,
    );
    const agents = q<any>(
      `SELECT DISTINCT u.id, u.name FROM users u JOIN role_assignments ra ON ra.user_id=u.id WHERE u.org_id=? AND ra.role IN ('LEASING_AGENT','PROPERTY_MANAGER','ASSISTANT_MANAGER') AND u.active=1`,
      ctx.orgId,
    );
    const slotsToday = tourSlots(ctx, l.property_id, addDays(ctx.businessDate, 1));
    const openTasks = tasks.filter((t) => t.status === 'open');
    const kindIcon: Record<string, string> = {
      inquiry: '📥', email_out: '📧', sms_out: '💬', email_in: '📨', sms_in: '💬', call: '📞', note: '📝',
      tour_scheduled: '📅', tour_completed: '✅', tour_noshow: '🚫', quote: '💲', application: '📋', status: '🔁',
    };
    return shell(rq, {
      title: `${l.first_name} ${l.last_name}`,
      active: '/leads',
      crumbs: [['Leads', '/leads']],
      subtitle: html`${statusBadge(l.status)} · ${statusBadge(undefined, l.source.replaceAll('_', ' '))} · ${l.prop_name} · first contact ${fmtDate(l.created_date)}`,
      actions: html`
        ${when(can(ctx, 'ai:view'), () => html`<form method="post" action="/ai/leads/${l.id}/draft" style="display:inline">
          <button class="btn btn-ghost" title="Leasing AI drafts a grounded reply (availability, pricing, tour slots)">✨ Draft AI reply</button>
        </form>`)}
        <form method="post" action="/leads/${l.id}/status" class="toolbar" style="margin:0" data-autosubmit>
          ${select('status', LEAD_STATUSES.map((s): [string, string] => [s, `Status: ${s}`]), l.status)}
        </form>`,
      content: html`
        <div class="grid cols-2">
          <div>
            ${card('Guest card', dl([
              ['Email', l.email || '—'],
              ['Phone', l.phone || '—'],
              ['Looking for', `${l.beds === null ? 'any size' : l.beds === 0 ? 'Studio' : `${l.beds} bd`}${l.budget_cents ? ` · budget ${usd(l.budget_cents)}` : ''}`],
              ['Desired move-in', l.desired_move_in ? fmtDate(l.desired_move_in) : '—'],
              ['Assigned agent', html`<form method="post" action="/leads/${l.id}/assign" data-autosubmit style="display:inline-block">${select('agent', agents.map((a): [string, string] => [a.id, a.name]), l.assigned_to_user_id || '', { blank: 'Unassigned' })}</form>`],
              ['First message', l.message || '—'],
              ...(l.lost_reason ? [['Lost reason', l.lost_reason] as [any, any]] : []),
            ]))}
            ${card('Follow-up cadence', html`
              ${openTasks.length === 0 ? html`<p class="muted small">No open tasks.</p>` : join(openTasks.map((t) => html`<div class="list-item">
                <div class="li-main"><div class="li-title" style="font-weight:500">${t.kind.replaceAll('_', ' ')}</div><div class="li-sub ${t.due_date < ctx.businessDate ? 'neg' : ''}">due ${fmtDate(t.due_date)}${t.due_date < ctx.businessDate ? ' — overdue' : ''}</div></div>
                <form method="post" action="/leads/${l.id}/tasks/${t.id}/done"><button class="chip">Done</button></form>
              </div>`))}
              <p class="small muted" style="margin-top:6px">Outbound messages auto-complete the earliest task.</p>`)}
            ${card('Reach out', html`
              <form method="post" action="/leads/${l.id}/message">
                <div class="toolbar">
                  ${field('Channel', select('channel', [['email', 'Email'], ['sms', 'SMS']], l.email ? 'email' : 'sms'))}
                  ${field('Subject (email)', input('subject', { value: `Following up on ${l.prop_name}` }))}
                </div>
                ${field('Message', textarea('body', { rows: 3, required: true, placeholder: `Hi ${l.first_name}, thanks for reaching out about ${l.prop_name}…` }))}
                <div class="btn-row"><button class="btn btn-sm">Send</button></div>
              </form>
              <form method="post" action="/leads/${l.id}/call" class="toolbar" style="margin-top:6px">
                ${field('Log a call', input('notes', { placeholder: 'Spoke re: pricing, wants 2bd…' }))}
                ${field('Outcome', select('outcome', [['answered', 'Answered'], ['voicemail', 'Voicemail'], ['missed', 'Missed']], 'answered'))}
                <button class="btn btn-sm btn-ghost">Log call</button>
              </form>`)}
          </div>
          <div>
            ${card('Book a tour', html`<form method="post" action="/leads/${l.id}/tour">
              <div class="toolbar">
                ${field('Date', input('date', { type: 'date', value: addDays(ctx.businessDate, 1), required: true }))}
                ${field('Time', select('start_time', (slotsToday.length ? slotsToday : ['10:00', '11:00', '14:00']).map((s): [string, string] => [s, s]), slotsToday[0]))}
                ${field('Type', select('type', [['in_person', 'In person'], ['self_guided', 'Self-guided'], ['virtual', 'Virtual']], 'in_person'))}
              </div>
              <button class="btn btn-sm">Book tour + send confirmation</button>
              <p class="small muted">Slots honor property tour hours; a reminder goes out the day before.</p>
            </form>
            ${when(toursRows.length, () => tbl(
              [{ label: 'When' }, { label: 'Type' }, { label: 'Status' }, { label: '' }],
              toursRows.map((t) => ({
                cells: [
                  `${fmtDate(t.date)} ${t.start_time}`, t.type.replaceAll('_', ' '), statusBadge(t.status),
                  t.status === 'scheduled'
                    ? html`<div style="display:flex;gap:4px">
                        <form method="post" action="/tours/${t.id}/complete"><button class="btn btn-sm">Completed</button></form>
                        <form method="post" action="/tours/${t.id}/noshow"><button class="btn btn-sm btn-ghost">No-show</button></form>
                      </div>`
                    : '',
                ],
              })),
            ))}`)}
            ${card('Quote builder', html`<form method="post" action="/leads/${l.id}/quote">
              <div class="toolbar">
                ${field('Unit', select('unit_id', availUnits.map((u): [string, string] => [u.id, `${u.unit_number} · ${u.fp_name || ''} · ${usd(u.market_rent_cents)}`]), availUnits.find((u) => l.beds === null || u.beds === l.beds)?.id, { required: true }))}
                ${field('Term', select('term_months', [['6', '6 mo'], ['9', '9 mo'], ['12', '12 mo'], ['15', '15 mo']], '12'))}
                ${field('Move-in', input('move_in', { type: 'date', value: l.desired_move_in || addDays(ctx.businessDate, 21) }))}
              </div>
              ${field('Special / concession note', input('concession_note', { placeholder: 'e.g. Half off first month with 12+ mo term' }))}
              <button class="btn btn-sm">Build + email quote</button>
            </form>
            ${when(quotesRows.length, () => tbl(
              [{ label: 'Unit' }, { label: 'Term' }, { label: 'Monthly', num: true }, { label: 'Move-in' }, { label: 'Status' }, { label: '' }],
              quotesRows.map((qt) => ({
                cells: [
                  qt.unit_number, `${qt.term_months} mo`, usd(qt.total_monthly_cents), fmtDate(qt.move_in),
                  statusBadge(qt.expires_date < ctx.businessDate && qt.status === 'sent' ? 'expired' : qt.status),
                  qt.status === 'sent' && ctx.perms.has('applications:manage')
                    ? html`<form method="post" action="/quotes/${qt.id}/convert"><button class="btn btn-sm">Start application</button></form>`
                    : '',
                ],
              })),
            ))}`)}
            ${card('Activity timeline', html`<ul class="timeline">${events.map((e) => html`<li class="${['inquiry', 'tour_completed', 'quote'].includes(e.kind) ? 'hot' : ''}">
              <div>${kindIcon[e.kind] || '•'} <b>${e.body || e.kind}</b>${e.actor && e.actor !== 'System' ? html` <span class="muted small">· ${e.actor}</span>` : ''}</div>
              <div class="t-when">${fmtDate((e.business_date || e.at).slice(0, 10))}</div>
            </li>`)}</ul>`)}
          </div>
        </div>`,
    });
  });

  r.post('/leads/:id/status', requirePerm('leasing:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    setLeadStatus(ctx, rq.params.id!, String(rq.body.status || 'new'), rq.body.reason ? String(rq.body.reason) : undefined);
    return redirect(`/leads/${rq.params.id}`, 'Status updated.');
  });

  r.post('/leads/:id/assign', requirePerm('leasing:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    run('UPDATE leads SET assigned_to_user_id=? WHERE id=? AND org_id=?', rq.body.agent ? String(rq.body.agent) : null, rq.params.id!, ctx.orgId);
    return redirect(`/leads/${rq.params.id}`, 'Assignment saved.');
  });

  r.post('/leads/:id/message', requirePerm('comms:send'), (rq) => {
    const ctx = rq.ctx as Ctx;
    try {
      messageLead(ctx, rq.params.id!, String(rq.body.channel || 'email') as 'email' | 'sms', String(rq.body.subject || ''), String(rq.body.body || ''));
    } catch (e) {
      return redirect(`/leads/${rq.params.id}`, (e as Error).message, 'err');
    }
    return redirect(`/leads/${rq.params.id}`, 'Sent (see Message console).');
  });

  r.post('/leads/:id/call', requirePerm('leasing:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const l = q1<any>('SELECT * FROM leads WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!l) return notFound();
    insert('call_logs', {
      id: id('cal'), org_id: ctx.orgId, property_id: l.property_id, lead_id: l.id, direction: 'outbound',
      from_number: l.phone, duration_seconds: 0, outcome: String(rq.body.outcome || 'answered'),
      notes: rq.body.notes || null, handled_by: ctx.userName, at: nowIso(), business_date: ctx.businessDate,
    });
    leadEvent(ctx, l.id, 'call', `Call (${rq.body.outcome}): ${rq.body.notes || 'no notes'}`);
    completeNextTask(ctx, l.id);
    if (l.status === 'new') run(`UPDATE leads SET status='contacted' WHERE id=?`, l.id);
    return redirect(`/leads/${l.id}`, 'Call logged.');
  });

  r.post('/leads/:id/tasks/:taskId/done', requirePerm('leasing:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    run(`UPDATE followup_tasks SET status='done', done_at=? WHERE id=? AND org_id=?`, nowIso(), rq.params.taskId!, ctx.orgId);
    return redirect(`/leads/${rq.params.id}`, 'Task done.');
  });

  r.post('/leads/:id/tour', requirePerm('leasing:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    try {
      bookTour(ctx, {
        leadId: rq.params.id!, date: v.date().parse(rq.body.date), startTime: String(rq.body.start_time || '10:00'),
        type: String(rq.body.type || 'in_person'),
      });
    } catch (e) {
      return redirect(`/leads/${rq.params.id}`, (e as Error).message, 'err');
    }
    return redirect(`/leads/${rq.params.id}`, 'Tour booked — confirmation sent.');
  });

  r.post('/tours/:id/complete', requirePerm('leasing:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const t = q1<any>('SELECT * FROM tours WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!t) return notFound();
    completeTour(ctx, t.id, 'completed');
    return redirect(`/leads/${t.lead_id}`, 'Tour marked completed.');
  });

  r.post('/tours/:id/noshow', requirePerm('leasing:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const t = q1<any>('SELECT * FROM tours WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!t) return notFound();
    completeTour(ctx, t.id, 'no_show');
    return redirect(`/leads/${t.lead_id}`, 'Marked no-show; follow-up task created for tomorrow.');
  });

  r.post('/leads/:id/quote', requirePerm('leasing:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    try {
      buildQuote(ctx, {
        leadId: rq.params.id!, unitId: String(rq.body.unit_id), termMonths: parseInt(String(rq.body.term_months || '12'), 10),
        moveIn: v.date().parse(rq.body.move_in), concessionNote: rq.body.concession_note ? String(rq.body.concession_note) : undefined,
      });
    } catch (e) {
      return redirect(`/leads/${rq.params.id}`, (e as Error).message, 'err');
    }
    return redirect(`/leads/${rq.params.id}`, 'Quote built and emailed.');
  });

  // ---------- tours schedule ----------
  r.get('/tours', requirePerm('leasing:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const pf = propFilter(ctx, 't.property_id');
    const from = ctx.businessDate;
    const rows = q<any>(
      `SELECT t.*, l.first_name, l.last_name, p.name AS prop_name, (SELECT name FROM users u WHERE u.id=t.agent_user_id) AS agent
       FROM tours t JOIN leads l ON l.id=t.lead_id JOIN properties p ON p.id=t.property_id
       WHERE t.org_id=?${pf.sql} AND t.date>=? AND t.status='scheduled' ORDER BY t.date, t.start_time LIMIT 100`,
      ctx.orgId, ...pf.params, from,
    );
    const past = q<any>(
      `SELECT t.*, l.first_name, l.last_name, p.name AS prop_name FROM tours t JOIN leads l ON l.id=t.lead_id JOIN properties p ON p.id=t.property_id
       WHERE t.org_id=?${pf.sql} AND (t.date<? OR t.status != 'scheduled') ORDER BY t.date DESC LIMIT 20`,
      ctx.orgId, ...pf.params, from,
    );
    const noShowRate = (() => {
      const done = past.filter((t) => ['completed', 'no_show'].includes(t.status));
      const ns = done.filter((t) => t.status === 'no_show').length;
      return done.length ? Math.round((ns / done.length) * 100) : 0;
    })();
    const byDate = new Map<string, any[]>();
    for (const t of rows) {
      const list = byDate.get(t.date) || [];
      list.push(t);
      byDate.set(t.date, list);
    }
    return shell(rq, {
      title: 'Tours',
      active: '/tours',
      subtitle: `${rows.length} upcoming · ${noShowRate}% recent no-show rate`,
      content: html`
        ${[...byDate.entries()].map(([date, list]) => card(fmtDate(date), tbl(
          [{ label: 'Time' }, { label: 'Prospect' }, { label: 'Property' }, { label: 'Type' }, { label: 'Agent' }, { label: '' }],
          list.map((t) => ({
            href: `/leads/${t.lead_id}`,
            cells: [
              html`<b>${t.start_time}</b>`, `${t.first_name} ${t.last_name}`, t.prop_name, t.type.replaceAll('_', ' '), t.agent || '—',
              html`<div style="display:flex;gap:4px">
                <form method="post" action="/tours/${t.id}/complete"><button class="btn btn-sm">Done</button></form>
                <form method="post" action="/tours/${t.id}/noshow"><button class="btn btn-sm btn-ghost">No-show</button></form>
              </div>`,
            ],
          })),
        ), { flush: true }))}
        ${when(!rows.length, () => card(null, emptyState('No upcoming tours', 'Book tours from any guest card.')))}
        ${card('Recent outcomes', tbl(
          [{ label: 'When' }, { label: 'Prospect' }, { label: 'Property' }, { label: 'Status' }],
          past.map((t) => ({ href: `/leads/${t.lead_id}`, cells: [`${fmtDate(t.date)} ${t.start_time}`, `${t.first_name} ${t.last_name}`, t.prop_name, statusBadge(t.status)] })),
          { empty: 'No past tours yet.' },
        ), { flush: true })}`,
    });
  });

  // ---------- Leasing Center ----------
  r.get('/leasing-center', requirePerm('leasing:center'), (rq) => {
    const ctx = rq.ctx as Ctx;
    // cross-property by design: ignores the property switcher
    const needsResponse = q<any>(
      `SELECT l.*, p.name AS prop_name,
        (SELECT MIN(due_date) FROM followup_tasks t WHERE t.lead_id=l.id AND t.status='open') AS next_task,
        (SELECT name FROM users u WHERE u.id=l.assigned_to_user_id) AS agent
       FROM leads l JOIN properties p ON p.id=l.property_id
       WHERE l.org_id=? AND l.status IN ('new','contacted','touring','toured')
         AND EXISTS (SELECT 1 FROM followup_tasks t WHERE t.lead_id=l.id AND t.status='open' AND t.due_date<=?)
       ORDER BY CASE WHEN l.status='new' THEN 0 ELSE 1 END, l.created_at LIMIT 60`,
      ctx.orgId, ctx.businessDate,
    );
    const unassigned = val<number>(`SELECT COUNT(*) FROM leads WHERE org_id=? AND assigned_to_user_id IS NULL AND status IN ('new','contacted','touring')`, ctx.orgId) || 0;
    const inbound = q<any>(
      `SELECT m.*, l.first_name || ' ' || l.last_name AS lead_name, l.id AS lead_id FROM outbox_messages m
       JOIN leads l ON l.id=m.person_id
       WHERE m.org_id=? AND m.direction='in' ORDER BY m.created_at DESC LIMIT 12`,
      ctx.orgId,
    );
    return shell(rq, {
      title: 'Leasing Center',
      active: '/leasing-center',
      subtitle: 'Centralized cross-property queue — every lead needing a touch today, regardless of the property switcher.',
      actions: html`<form method="post" action="/leasing-center/round-robin"><button class="btn btn-ghost">Round-robin assign ${unassigned ? `(${unassigned} unassigned)` : ''}</button></form>`,
      content: html`
        ${card(html`Needs a touch today <span class="badge ${needsResponse.length ? 'warn' : 'ok'}">${needsResponse.length}</span>`, tbl(
          [{ label: 'Lead' }, { label: 'Property' }, { label: 'Status' }, { label: 'Due' }, { label: 'Agent' }, { label: '', w: '150px' }],
          needsResponse.map((l) => ({
            href: `/leads/${l.id}`,
            cells: [
              html`<b>${l.first_name} ${l.last_name}</b><span class="sub">${l.message ? l.message.slice(0, 60) : l.email || ''}</span>`,
              l.prop_name, statusBadge(l.status),
              html`<span class="${l.next_task < ctx.businessDate ? 'neg' : ''}">${fmtDate(l.next_task)}</span>`,
              l.agent || html`<span class="muted">—</span>`,
              html`<form method="post" action="/leasing-center/${l.id}/transfer"><button class="btn btn-sm btn-ghost">Transfer to onsite</button></form>`,
            ],
          })),
          { empty: 'Queue is clear across all properties. 🎉' },
        ), { flush: true })}
        ${card('Inbound replies (simulated via Message console)', tbl(
          [{ label: 'From' }, { label: 'Message' }, { label: 'When' }],
          inbound.map((m) => ({
            href: `/leads/${m.lead_id}`,
            cells: [m.lead_name, html`<span class="small">${(m.body || '').replace(/<[^>]+>/g, '').slice(0, 90)}</span>`, fmtTs(m.created_at)],
          })),
          { empty: 'No inbound replies yet — simulate one from the Message console.' },
        ), { flush: true })}`,
    });
  });

  r.post('/leasing-center/round-robin', requirePerm('leasing:center'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const n = roundRobinAssign(ctx);
    audit(ctx, 'leads', 'round-robin', 'round_robin_assign', null, { assigned: n });
    return redirect('/leasing-center', `${n} lead${n === 1 ? '' : 's'} distributed among leasing agents.`);
  });

  r.post('/leasing-center/:id/transfer', requirePerm('leasing:center'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const l = q1<any>('SELECT * FROM leads WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!l) return notFound();
    // assign to a property-scoped agent for that property
    const onsite = q1<any>(
      `SELECT u.id FROM users u JOIN role_assignments ra ON ra.user_id=u.id
       WHERE u.org_id=? AND ra.role='LEASING_AGENT' AND (ra.scope_type='org' OR ra.property_ids LIKE '%' || ? || '%') LIMIT 1`,
      ctx.orgId, l.property_id,
    );
    run('UPDATE leads SET assigned_to_user_id=? WHERE id=?', onsite?.id || null, l.id);
    leadEvent(ctx, l.id, 'note', 'Transferred from Leasing Center to onsite team');
    return redirect('/leasing-center', 'Transferred to the onsite team.');
  });

  // ---------- funnel analytics ----------
  r.get('/leasing/analytics', requirePerm('leasing:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const days = parseInt(rq.query.get('days') || '90', 10) || 90;
    const since = addDays(ctx.businessDate, -days);
    const stats = funnelStats(ctx, since, ctx.currentPropertyId);
    return shell(rq, {
      title: 'Leasing funnel',
      active: '/leasing/analytics',
      subtitle: `Trailing ${days} days${ctx.currentPropertyId ? '' : ' · all properties'}`,
      content: html`
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Window', select('days', [['30', '30 days'], ['60', '60 days'], ['90', '90 days'], ['180', '180 days']], String(days)))}
        </form>
        <div class="grid cols-2">
          ${card('Conversion funnel', funnelChart([
            { label: 'Inquiries', value: stats.inquiries },
            { label: 'Toured', value: stats.toured },
            { label: 'Applied', value: stats.applied },
            { label: 'Leased', value: stats.leased },
          ]))}
          ${card('Marketing source ROI', tbl(
            [{ label: 'Source' }, { label: 'Leads', num: true }, { label: 'Tours', num: true }, { label: 'Leases', num: true }, { label: 'Spend', num: true }, { label: 'Cost/lease', num: true }],
            stats.bySource.map((s) => ({
              cells: [
                s.source.replaceAll('_', ' '), s.inquiries, s.tours, s.leases,
                s.costCents ? usd(s.costCents) : '—',
                s.leases && s.costCents ? usd(Math.round(s.costCents / s.leases)) : '—',
              ],
            })),
            { empty: 'No leads in this window.' },
          ), { flush: true })}
        </div>
        ${card('Agent leaderboard', tbl(
          [{ label: 'Agent' }, { label: 'Leads', num: true }, { label: 'Tours', num: true }, { label: 'Closes', num: true }, { label: 'Avg first response', num: true }],
          stats.agents.map((a) => ({
            cells: [html`<b>${a.name}</b>`, a.leads, a.tours, a.closes, a.avgResponseHours !== null ? `${a.avgResponseHours}h` : '—'],
          })),
          { empty: 'No leasing agents yet.' },
        ), { flush: true })}
        ${card('Source spend inputs (per month)', html`
          <form method="post" action="/leasing/analytics/campaigns" class="toolbar">
            ${field('Source', select('source', LEAD_SOURCES.map((s): [string, string] => [s, s.replaceAll('_', ' ')])))}
            ${field('Monthly spend', moneyInput('cost', 50000))}
            <button class="btn btn-sm">Save</button>
          </form>
          <p class="small muted">Feeds cost-per-lease in the ROI table above.</p>`)}`,
    });
  });

  r.post('/leasing/analytics/campaigns', requirePerm('leasing:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const source = String(rq.body.source || 'zillow');
    const cost = v.cents({ min: 0 }).parse(rq.body.cost || 0);
    const existing = q1<any>('SELECT id FROM campaigns WHERE org_id=? AND source=? AND property_id IS NULL', ctx.orgId, source);
    if (existing) run('UPDATE campaigns SET monthly_cost_cents=? WHERE id=?', cost, existing.id);
    else insert('campaigns', { id: id('cmp'), org_id: ctx.orgId, property_id: null, source, monthly_cost_cents: cost, active: 1, created_at: nowIso() });
    return redirect('/leasing/analytics', `${source} spend saved.`);
  });
}
