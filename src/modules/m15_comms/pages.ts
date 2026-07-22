import { html, when, join, type Child } from '../../lib/html.ts';
import { notFound, redirect, htmlRes, type Router } from '../../lib/http.ts';
import { requirePerm, requireResident, can, propFilter, type Ctx } from '../../lib/auth.ts';
import { q, q1, val, j, insert, run } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, fmtDate, fmtTs, addDays } from '../../lib/dates.ts';
import { usd, parseUsd } from '../../lib/money.ts';
import { getSetting, setSetting } from '../../lib/settings.ts';
import { shell, card, tbl, dl, statusBadge, field, select, input, textarea, checkbox, registerNav, kpis, tabs, emptyState, doc } from '../../ui/ui.ts';
import { sendEmail, sendSms } from '../../lib/sim/messaging.ts';
import { TEMPLATES } from '../../lib/templates.ts';
import {
  ensureThread, resolvePerson, inboundMessage, commPrefs, setOptout, inQuietHours,
  upsertCustomTemplate, segmentRecipients, renderMerge, scheduleMass, runMassMessages,
  postAnnouncement, automationAudit, type SegmentFilters,
} from './service.ts';

/** M15 screens: unified inbox + threads, template library, mass comms with
 * live segment preview, automations audit, announcements, portal preferences,
 * public unsubscribe. */

registerNav('Residents', { href: '/inbox', label: 'Inbox', perm: 'comms:view', match: ['/inbox'] });
registerNav('Residents', { href: '/comms', label: 'Communications', perm: 'comms:mass', match: ['/comms'] });

function filtersFromQuery(rq: any): SegmentFilters {
  const g = (k: string): string => String(rq.query.get(k) || '');
  return {
    propertyId: g('property') || null,
    balanceOverCents: g('balance_over') ? parseUsd(g('balance_over')) : null,
    expiringDays: g('expiring') ? Number(g('expiring')) : null,
    hasPet: g('has_pet') === '1',
    autopay: (g('autopay') as 'on' | 'off') || null,
  };
}

export function routes(r: Router): void {
  // ============================== INBOX ==============================
  r.get('/inbox', requirePerm('comms:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const view = rq.query.get('view') || 'open';
    const pf = propFilter(ctx, 't.property_id');
    let where = `t.org_id=?${pf.sql}`;
    if (view === 'open') where += ` AND t.status='open'`;
    else if (view === 'needs_reply') where += ` AND t.needs_reply=1 AND t.status != 'closed'`;
    else if (view === 'mine') where += ` AND t.assigned_to=?`;
    else if (view === 'snoozed') where += ` AND t.status='snoozed'`;
    const params: unknown[] = [ctx.orgId, ...pf.params, ...(view === 'mine' ? [ctx.userId] : [])];
    const threads = q<any>(
      `SELECT t.*, p.name AS property FROM threads t LEFT JOIN properties p ON p.id=t.property_id
       WHERE ${where} ORDER BY t.needs_reply DESC, t.last_message_at DESC LIMIT 80`,
      ...params,
    );
    const needsReply = val<number>(`SELECT COUNT(*) FROM threads WHERE org_id=? AND needs_reply=1 AND status != 'closed'`, ctx.orgId) || 0;
    return shell(rq, {
      title: 'Inbox',
      active: '/inbox',
      subtitle: 'Every email, text, call and note with a person — one thread',
      content: html`
        ${tabs([
          { href: '/inbox?view=needs_reply', label: 'Needs reply', active: view === 'needs_reply', count: needsReply },
          { href: '/inbox?view=open', label: 'Open', active: view === 'open' },
          { href: '/inbox?view=mine', label: 'Assigned to me', active: view === 'mine' },
          { href: '/inbox?view=snoozed', label: 'Snoozed', active: view === 'snoozed' },
          { href: '/inbox?view=all', label: 'All', active: view === 'all' },
        ])}
        ${card(null, threads.length ? join(threads.map((t) => html`
          <a class="list-item" href="/inbox/${t.id}">
            <div class="li-main">
              <div class="li-title">${when(t.needs_reply, () => html`<span class="badge badge-warn">reply</span> `)}<b>${t.display_name}</b>
                <span class="muted small">· ${t.person_kind}${t.property ? ` · ${t.property}` : ''}</span></div>
              <div class="li-sub">${t.last_snippet || 'no messages yet'}</div>
            </div>
            <div class="small muted">${t.last_message_at ? fmtTs(t.last_message_at) : ''}${t.assigned_to ? html`<br>→ ${q1<any>('SELECT name FROM users WHERE id=?', t.assigned_to)?.name || ''}` : ''}</div>
          </a>`), '') : emptyState('No conversations here', 'Threads appear as messages go out or replies come in.'), { flush: true })}`,
    });
  });

  r.get('/inbox/:id', requirePerm('comms:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const t = q1<any>('SELECT * FROM threads WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!t) return notFound();
    const person = resolvePerson(ctx.orgId, t.person_kind, t.person_id);
    const prefs = commPrefs(ctx.orgId, t.person_kind, t.person_id);
    // unified timeline: outbox both directions + calls + internal notes
    const msgs = q<any>(
      `SELECT id, 'msg' AS kind, channel, direction, subject, body, template_key, created_at FROM outbox_messages WHERE org_id=? AND (thread_id=? OR person_id=?)`,
      ctx.orgId, t.id, t.person_id,
    );
    const calls = q<any>(
      `SELECT id, 'call' AS kind, direction, outcome, notes, transcript, duration_seconds, at AS created_at FROM call_logs
       WHERE org_id=? AND (resident_id=? OR lead_id=?)`,
      ctx.orgId, t.person_id, t.person_id,
    );
    const notes = q<any>(`SELECT id, 'note' AS kind, body, author, created_at FROM thread_notes WHERE thread_id=?`, t.id);
    const timeline = [...msgs, ...calls, ...notes].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const staff = q<any>(`SELECT id, name FROM users WHERE org_id=? AND kind='staff' AND active=1 ORDER BY name`, ctx.orgId);
    return shell(rq, {
      title: t.display_name,
      active: '/inbox',
      crumbs: [['Inbox', '/inbox']],
      subtitle: html`${t.person_kind} · ${person?.email || 'no email'} · ${person?.phone || 'no phone'} · ${statusBadge(t.status)}
        ${when(prefs.emailOptout, () => html` <span class="badge badge-warn">email opt-out</span>`)}
        ${when(prefs.smsOptout, () => html` <span class="badge badge-warn">SMS opt-out</span>`)}`,
      actions: html`
        <form method="post" action="/inbox/${t.id}/assign" class="toolbar" style="display:inline-flex">
          ${select('assigned_to', staff.map((s2: any): [string, string] => [s2.id, s2.name]), t.assigned_to || '', { blank: 'Unassigned' })}
          <button class="btn btn-ghost btn-sm">Assign</button>
        </form>
        <form method="post" action="/inbox/${t.id}/snooze" style="display:inline"><button class="btn btn-ghost btn-sm">${t.status === 'snoozed' ? 'Unsnooze' : 'Snooze 3d'}</button></form>
        <form method="post" action="/inbox/${t.id}/close" style="display:inline"><button class="btn btn-ghost btn-sm">${t.status === 'closed' ? 'Reopen' : 'Close'}</button></form>`,
      content: html`
        <div class="cols">
          <div>
            ${card('Conversation', html`
              ${timeline.length ? join(timeline.map((m) => {
                if (m.kind === 'note') {
                  return html`<div class="callout info" style="margin-bottom:8px"><b>Internal note — ${m.author}</b> <span class="muted small">${fmtTs(m.created_at)}</span><br>${m.body}</div>`;
                }
                if (m.kind === 'call') {
                  return html`<div class="list-item"><div class="li-main">
                    <div class="li-title">📞 ${m.direction} call · ${m.outcome || ''} ${m.duration_seconds ? `· ${Math.round(m.duration_seconds / 60)}m` : ''}</div>
                    <div class="li-sub">${m.notes || ''}${m.transcript ? html`<details><summary class="small">transcript</summary><div class="small mono" style="white-space:pre-wrap">${String(m.transcript).slice(0, 1200)}</div></details>` : ''}</div>
                  </div><div class="small muted">${fmtTs(m.created_at)}</div></div>`;
                }
                const inbound = m.direction === 'in';
                return html`<div class="list-item" style="${inbound ? 'background:var(--accent-soft);border-radius:8px' : ''}">
                  <div class="li-main">
                    <div class="li-title">${inbound ? '↩' : m.channel === 'sms' ? '💬' : '✉'} ${m.subject || (m.channel === 'sms' ? 'SMS' : 'Message')}
                      ${m.template_key ? html`<span class="badge">${m.template_key}</span>` : ''} ${m.kind === 'msg' && !inbound && m.channel === 'email' ? statusBadge(undefined, q1<any>('SELECT status FROM outbox_messages WHERE id=?', m.id)?.status) : ''}</div>
                    <div class="li-sub" style="white-space:pre-wrap">${String(m.body).replace(/<[^>]+>/g, ' ').slice(0, 400)}</div>
                  </div><div class="small muted">${fmtTs(m.created_at)}</div>
                </div>`;
              }), '') : html`<p class="muted small">Nothing yet.</p>`}`)}
            ${card('Reply', html`
              <form method="post" action="/inbox/${t.id}/reply">
                <div class="toolbar">
                  ${field('Channel', select('channel', [
                    ...(person?.email && !prefs.emailOptout ? [['email', 'Email'] as [string, string]] : []),
                    ...(person?.phone && !prefs.smsOptout ? [['sms', 'SMS'] as [string, string]] : []),
                  ], person?.email && !prefs.emailOptout ? 'email' : 'sms'))}
                  ${field('Subject (email)', input('subject', { placeholder: 'Re: your message' }))}
                </div>
                ${field('Message', textarea('body', { rows: 3, required: true, placeholder: 'Type your reply…' }))}
                <button class="btn">Send</button>
              </form>
              ${when(inQuietHours(ctx, t.property_id), () => html`<p class="small muted">🌙 It's quiet hours — SMS replies will note the send anyway (staff-initiated replies are allowed; automated sends defer).</p>`)}`)}
          </div>
          <div>
            ${card('Log a call', html`
              <form method="post" action="/inbox/${t.id}/call">
                <div class="grid2">
                  ${field('Direction', select('direction', [['outbound', 'Outbound'], ['inbound', 'Inbound']], 'outbound'))}
                  ${field('Outcome', select('outcome', [['answered', 'Answered'], ['voicemail', 'Voicemail'], ['missed', 'Missed']], 'answered'))}
                </div>
                ${field('Notes', textarea('notes', { rows: 2, required: true }))}
                <button class="btn btn-sm">Log call</button>
              </form>`)}
            ${card('Internal note', html`
              <form method="post" action="/inbox/${t.id}/note">
                ${field('Visible to staff only', textarea('body', { rows: 2, required: true }))}
                <button class="btn btn-sm btn-ghost">Add note</button>
              </form>`)}
            ${when(ctx.perms.has('dev:console'), () => card('Demo', html`
              <form method="post" action="/inbox/${t.id}/simulate-reply">
                ${field('Simulate an inbound reply', textarea('body', { rows: 2, value: 'Thanks — quick question about my balance?' }))}
                <button class="btn btn-sm btn-ghost">Receive reply</button>
              </form>`))}
          </div>
        </div>`,
    });
  });

  r.post('/inbox/:id/reply', requirePerm('comms:send'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const t = q1<any>('SELECT * FROM threads WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!t) return notFound();
    const person = resolvePerson(ctx.orgId, t.person_kind, t.person_id)!;
    const channel = String(rq.body?.channel || 'email');
    const body = String(rq.body?.body || '');
    if (channel === 'email' && person.email) {
      sendEmail(ctx, { to: person.email, toName: person.name, subject: String(rq.body?.subject || 'Message from the office'), body: `<p>${body}</p>`, propertyId: t.property_id, personId: person.id, entity: 'thread', entityId: t.id });
    } else if (person.phone) {
      sendSms(ctx, { to: person.phone, toName: person.name, body, propertyId: t.property_id, personId: person.id, entity: 'thread', entityId: t.id });
    }
    run('UPDATE threads SET needs_reply=0 WHERE id=?', t.id);
    return redirect(`/inbox/${t.id}`, 'Reply sent');
  });

  r.post('/inbox/:id/note', requirePerm('comms:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    insert('thread_notes', { id: id('tnn'), org_id: ctx.orgId, thread_id: rq.params.id!, body: String(rq.body?.body || ''), author: ctx.userName, created_at: nowIso() });
    return redirect(`/inbox/${rq.params.id}`, 'Note added');
  });

  r.post('/inbox/:id/call', requirePerm('comms:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const t = q1<any>('SELECT * FROM threads WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!t) return notFound();
    insert('call_logs', {
      id: id('cal'), org_id: ctx.orgId, property_id: t.property_id,
      lead_id: t.person_kind === 'lead' ? t.person_id : null, resident_id: t.person_kind === 'resident' ? t.person_id : null,
      direction: String(rq.body?.direction || 'outbound'), duration_seconds: 240,
      outcome: String(rq.body?.outcome || 'answered'), notes: String(rq.body?.notes || ''), at: nowIso(), business_date: ctx.businessDate,
    });
    run(`UPDATE threads SET last_message_at=?, last_snippet=? WHERE id=?`, nowIso(), `📞 ${rq.body?.outcome}: ${String(rq.body?.notes || '').slice(0, 80)}`, t.id);
    return redirect(`/inbox/${t.id}`, 'Call logged');
  });

  r.post('/inbox/:id/simulate-reply', requirePerm('dev:console'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const t = q1<any>('SELECT * FROM threads WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!t) return notFound();
    inboundMessage(ctx, { personKind: t.person_kind, personId: t.person_id, channel: 'email', body: String(rq.body?.body || 'Simulated reply') });
    return redirect(`/inbox/${t.id}`, 'Inbound reply received — thread flagged needs-reply');
  });

  r.post('/inbox/:id/assign', requirePerm('comms:view'), (rq) => {
    run('UPDATE threads SET assigned_to=? WHERE id=? AND org_id=?', String(rq.body?.assigned_to || '') || null, rq.params.id!, (rq.ctx as Ctx).orgId);
    return redirect(`/inbox/${rq.params.id}`, 'Assignment updated');
  });
  r.post('/inbox/:id/snooze', requirePerm('comms:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const t = q1<any>('SELECT status FROM threads WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (t?.status === 'snoozed') run(`UPDATE threads SET status='open', snooze_until=NULL WHERE id=?`, rq.params.id!);
    else run(`UPDATE threads SET status='snoozed', snooze_until=? WHERE id=?`, addDays(ctx.businessDate, 3), rq.params.id!);
    return redirect(`/inbox/${rq.params.id}`, t?.status === 'snoozed' ? 'Unsnoozed' : 'Snoozed for 3 days');
  });
  r.post('/inbox/:id/close', requirePerm('comms:view'), (rq) => {
    const t = q1<any>('SELECT status FROM threads WHERE id=?', rq.params.id!);
    run(`UPDATE threads SET status=? WHERE id=? AND org_id=?`, t?.status === 'closed' ? 'open' : 'closed', rq.params.id!, (rq.ctx as Ctx).orgId);
    return redirect(`/inbox/${rq.params.id}`, t?.status === 'closed' ? 'Reopened' : 'Closed');
  });

  // ============================== COMMS HUB ==============================
  r.get('/comms', requirePerm('comms:mass'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const masses = q<any>(
      `SELECT m.*, (SELECT COUNT(*) FROM mass_recipients mr WHERE mr.mass_id=m.id) AS recipients FROM mass_messages m
       WHERE m.org_id=? ORDER BY m.created_at DESC LIMIT 30`,
      ctx.orgId,
    );
    return shell(rq, {
      title: 'Communications',
      active: '/comms',
      subtitle: 'Mass messages, templates, announcements and the automation audit',
      actions: html`
        <a class="btn btn-ghost" href="/comms/templates">Template library</a>
        <a class="btn btn-ghost" href="/comms/automations">Automations</a>
        <a class="btn btn-ghost" href="/comms/announcements">Announcements</a>
        <a class="btn" href="/comms/mass/new">New mass message</a>`,
      content: card('Mass messages', tbl(
        [{ label: 'Subject' }, { label: 'Scheduled' }, { label: 'Channels' }, { label: 'Recipients' }, { label: 'Sent' }, { label: 'Skipped' }, { label: 'Status' }],
        masses.map((m) => ({
          href: `/comms/mass/${m.id}`,
          cells: [m.subject, fmtDate(m.scheduled_for), j<string[]>(m.channels, []).join(' + '), String(m.recipients), String(m.sent_count || 0), String(m.skipped_count || 0), statusBadge(m.status)],
        })),
        { empty: 'No mass messages yet.' },
      ), { flush: true }),
    });
  });

  r.get('/comms/mass/new', requirePerm('comms:mass'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const pf = propFilter(ctx, 'id');
    const props = q<any>(`SELECT id, name FROM properties WHERE org_id=?${pf.sql} ORDER BY name`, ctx.orgId, ...pf.params);
    const f = filtersFromQuery(rq);
    const recipients = rq.query.get('preview') ? segmentRecipients(ctx, f) : [];
    return shell(rq, {
      title: 'New mass message',
      active: '/comms',
      crumbs: [['Communications', '/comms']],
      content: html`
        ${card('1 · Build the audience from live filters', html`
          <form method="get" class="toolbar">
            <input type="hidden" name="preview" value="1">
            ${field('Property', select('property', props.map((p): [string, string] => [p.id, p.name]), f.propertyId || '', { blank: 'All properties' }))}
            ${field('Balance over $', input('balance_over', { value: f.balanceOverCents ? (f.balanceOverCents / 100).toFixed(2) : '' }))}
            ${field('Lease expiring ≤ days', input('expiring', { value: f.expiringDays ? String(f.expiringDays) : '' }))}
            ${field('Autopay', select('autopay', [['', 'Any'], ['on', 'On'], ['off', 'Off']], f.autopay || ''))}
            ${checkbox('has_pet', 'Has a pet', !!f.hasPet)}
            <button class="btn btn-ghost">Preview audience</button>
          </form>
          ${when(rq.query.get('preview'), () => html`
            <p><b>${recipients.length}</b> primary contacts match. First ${Math.min(recipients.length, 8)}:</p>
            ${tbl(
              [{ label: 'Resident' }, { label: 'Unit' }, { label: 'Email' }, { label: 'Balance', num: true }],
              recipients.slice(0, 8).map((r2) => ({ cells: [r2.name, r2.unit, r2.email || '—', usd(r2.balanceCents)] })),
            )}`)}`)}
        ${when(rq.query.get('preview') && recipients.length, () => card('2 · Compose & schedule', html`
          <form method="post" action="/comms/mass/new">
            <input type="hidden" name="filters" value="${JSON.stringify(f)}">
            ${field('Subject', input('subject', { required: true, value: 'A note from {{property}}' }))}
            ${field('Email body (merge fields: {{first_name}} {{unit}} {{balance}} {{property}})', textarea('body', { rows: 4, required: true, value: '<p>Hi {{first_name}},</p><p>…</p>' }))}
            ${field('SMS body (only if SMS channel on)', input('sms_body', { value: '{{property}}: …' }))}
            <div class="toolbar">
              ${checkbox('ch_email', 'Email', true)}
              ${checkbox('ch_sms', 'SMS (opted-in only)', false)}
              ${field('Send on', input('scheduled_for', { type: 'date', value: addDays(ctx.businessDate, 1), required: true }))}
            </div>
            <p class="small muted">Per-recipient preview uses each resident's own merge values. Opt-outs are skipped with the reason recorded; SMS defers during quiet hours (currently ${inQuietHours(ctx) ? '🌙 quiet' : 'daytime'}).</p>
            <button class="btn">Schedule</button>
          </form>`))}`,
    });
  });

  r.post('/comms/mass/new', requirePerm('comms:mass'), (rq) => {
    const ctx = rq.ctx as Ctx;
    try {
      const filters = JSON.parse(String(rq.body?.filters || '{}')) as SegmentFilters;
      const channels = [...(rq.body?.ch_email ? ['email'] : []), ...(rq.body?.ch_sms ? ['sms'] : [])];
      if (!channels.length) throw new Error('pick at least one channel');
      const mid = scheduleMass(ctx, {
        filters, subject: String(rq.body?.subject), body: String(rq.body?.body),
        smsBody: String(rq.body?.sms_body || '') || undefined, channels,
        scheduledFor: String(rq.body?.scheduled_for || ctx.businessDate),
      });
      return redirect(`/comms/mass/${mid}`, 'Scheduled — it sends with the day\'s scheduler run');
    } catch (e) {
      return redirect('/comms/mass/new', (e as Error).message, 'err');
    }
  });

  r.get('/comms/mass/:id', requirePerm('comms:mass'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const m = q1<any>('SELECT * FROM mass_messages WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!m) return notFound();
    const recipients = q<any>(
      `SELECT mr.*, r.first_name || ' ' || r.last_name AS name, u.unit_number FROM mass_recipients mr
       JOIN residents r ON r.id=mr.resident_id LEFT JOIN leases l ON l.id=mr.lease_id LEFT JOIN units u ON u.id=l.unit_id
       WHERE mr.mass_id=? ORDER BY mr.status, name LIMIT 300`,
      m.id,
    );
    return shell(rq, {
      title: m.subject,
      active: '/comms',
      crumbs: [['Communications', '/comms']],
      subtitle: html`${statusBadge(m.status)} · scheduled ${fmtDate(m.scheduled_for)} · ${j<string[]>(m.channels, []).join(' + ')}`,
      actions: when(m.status !== 'sent', () => html`<form method="post" action="/comms/mass/${m.id}/send-now"><button class="btn">Send now</button></form>`),
      content: html`
        ${kpis([
          { label: 'Recipients', value: String(recipients.length) },
          { label: 'Sent', value: String(recipients.filter((x) => x.status === 'sent').length), tone: 'ok' },
          { label: 'Skipped (opt-out / no address)', value: String(recipients.filter((x) => x.status.startsWith('skipped')).length), tone: 'warn' },
          { label: 'Deferred (quiet hours)', value: String(recipients.filter((x) => x.status === 'deferred_quiet').length) },
        ])}
        ${card('Recipients', tbl(
          [{ label: 'Resident' }, { label: 'Unit' }, { label: 'Channel' }, { label: 'Status' }, { label: 'Reason / sent' }],
          recipients.map((x) => ({
            cells: [x.name, x.unit_number || '—', x.channel, statusBadge(x.status === 'sent' ? 'ok' : x.status.startsWith('skipped') ? 'warn' : x.status, x.status), x.reason || (x.sent_at ? fmtTs(x.sent_at) : '')],
          })),
        ), { flush: true })}`,
    });
  });

  r.post('/comms/mass/:id/send-now', requirePerm('comms:mass'), (rq) => {
    const ctx = rq.ctx as Ctx;
    run(`UPDATE mass_messages SET scheduled_for=? WHERE id=? AND org_id=?`, ctx.businessDate, rq.params.id!, ctx.orgId);
    const r2 = runMassMessages(ctx, ctx.businessDate);
    return redirect(`/comms/mass/${rq.params.id}`, `${r2.sent} sent, ${r2.skipped} skipped, ${r2.deferred} deferred`);
  });

  // ---------- template library ----------
  r.get('/comms/templates', requirePerm('comms:mass'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const custom = q<any>('SELECT * FROM message_templates WHERE org_id=? AND active=1 ORDER BY category, name', ctx.orgId);
    const overridden = new Set(custom.map((c) => c.key));
    return shell(rq, {
      title: 'Template library',
      active: '/comms',
      crumbs: [['Communications', '/comms']],
      subtitle: 'Org templates override the built-ins; merge fields render per recipient',
      content: html`
        ${card('Custom & overridden templates', tbl(
          [{ label: 'Name' }, { label: 'Key' }, { label: 'Category' }, { label: 'Subject' }],
          custom.map((c) => ({ cells: [c.name, html`<span class="mono small">${c.key}</span>`, c.category, c.subject] })),
          { empty: 'No custom templates yet — create one below or override a built-in.' },
        ), { flush: true })}
        ${card('Create / override', html`
          <p class="small"><a class="btn btn-sm btn-ghost" href="/ai/essentials">✨ Draft with AI</a> <span class="muted">— Essentials writes the first pass, you keep the voice.</span></p>
          <form method="post" action="/comms/templates">
            <div class="grid2">
              ${field('Name', input('name', { required: true, placeholder: 'Pool closure notice' }))}
              ${field('Category', select('category', [['community', 'Community'], ['leasing', 'Leasing'], ['delinquency', 'Delinquency'], ['renewals', 'Renewals'], ['maintenance', 'Maintenance']], 'community'))}
              ${field('Override built-in key (optional)', select('key', Object.keys(TEMPLATES).map((k): [string, string] => [k, k]), '', { blank: 'custom (new)' }))}
            </div>
            ${field('Subject', input('subject', { required: true, value: '{{property}}: ' }))}
            ${field('Email body', textarea('body', { rows: 4, required: true }))}
            ${field('SMS variant', input('sms', { placeholder: 'optional short form' }))}
            <button class="btn">Save template</button>
          </form>`)}
        ${card('Built-in lifecycle templates', tbl(
          [{ label: 'Key' }, { label: 'Subject' }, { label: '' }],
          Object.entries(TEMPLATES).map(([k, t]) => ({
            cells: [html`<span class="mono small">${k}</span>`, t.subject, overridden.has(k) ? statusBadge('ok', 'overridden') : ''],
          })),
        ), { flush: true })}`,
    });
  });

  r.post('/comms/templates', requirePerm('comms:mass'), (rq) => {
    const ctx = rq.ctx as Ctx;
    upsertCustomTemplate(ctx, {
      key: String(rq.body?.key || '') || undefined, name: String(rq.body?.name), category: String(rq.body?.category || 'community'),
      subject: String(rq.body?.subject), body: String(rq.body?.body), sms: String(rq.body?.sms || '') || undefined,
    });
    return redirect('/comms/templates', 'Template saved');
  });

  // ---------- automations audit ----------
  r.get('/comms/automations', requirePerm('comms:mass'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const rows = automationAudit(ctx);
    const toggles = getSetting<Record<string, boolean>>(ctx, 'comms_toggles') || {};
    return shell(rq, {
      title: 'Automation audit',
      active: '/comms',
      crumbs: [['Communications', '/comms']],
      subtitle: 'Every automated message is traceable to its trigger entity; lifecycle templates can be toggled per org',
      content: card(null, tbl(
        [{ label: 'Template' }, { label: 'Sent' }, { label: 'Last' }, { label: 'Latest trigger' }, { label: 'Enabled' }],
        rows.map((r2) => ({
          cells: [
            html`<span class="mono small">${r2.key}</span>`, String(r2.count), fmtTs(r2.last),
            r2.sample?.entity ? html`<a href="/dev/messages?template=${r2.key}" class="small">${r2.sample.entity} · ${String(r2.sample.entity_id || '').slice(-6)}</a>` : '—',
            TEMPLATES[r2.key]
              ? html`<form method="post" action="/comms/automations/toggle" style="display:inline">
                  <input type="hidden" name="key" value="${r2.key}">
                  <button class="btn btn-sm ${toggles[r2.key] === false ? 'btn-ghost' : ''}">${toggles[r2.key] === false ? 'OFF — enable' : 'ON — disable'}</button>
                </form>`
              : html`<span class="muted small">manual/system</span>`,
          ],
        })),
        { empty: 'No automated messages yet.' },
      ), { flush: true }),
    });
  });

  r.post('/comms/automations/toggle', requirePerm('comms:mass'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const key = String(rq.body?.key || '');
    const toggles = { ...(getSetting<Record<string, boolean>>(ctx, 'comms_toggles') || {}) };
    toggles[key] = toggles[key] === false;
    setSetting(ctx, 'comms_toggles', toggles);
    return redirect('/comms/automations', `${key} ${toggles[key] === false ? 'disabled' : 'enabled'}`);
  });

  // ---------- announcements ----------
  r.get('/comms/announcements', requirePerm('comms:mass'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const pf = propFilter(ctx, 'id');
    const props = q<any>(`SELECT id, name FROM properties WHERE org_id=?${pf.sql} ORDER BY name`, ctx.orgId, ...pf.params);
    const anns = q<any>(
      `SELECT a.*, p.name AS property FROM announcements a LEFT JOIN properties p ON p.id=a.property_id
       WHERE a.org_id=? ORDER BY a.starts_date DESC LIMIT 30`,
      ctx.orgId,
    );
    return shell(rq, {
      title: 'Announcements',
      active: '/comms',
      crumbs: [['Communications', '/comms']],
      subtitle: 'Portal dashboard posts, optionally echoed to email/SMS through the consent-aware mass pipeline',
      content: html`
        ${card('Post an announcement', html`
          <form method="post" action="/comms/announcements">
            <div class="grid2">
              ${field('Property', select('property_id', props.map((p): [string, string] => [p.id, p.name]), '', { blank: 'All properties' }))}
              ${field('Title', input('title', { required: true, placeholder: 'Pool maintenance Tuesday' }))}
              ${field('Starts', input('starts_date', { type: 'date', value: ctx.businessDate, required: true }))}
              ${field('Ends', input('ends_date', { type: 'date' }))}
            </div>
            ${field('Body', textarea('body', { rows: 2, required: true }))}
            <div class="toolbar">${checkbox('echo_email', 'Echo to email', false)} ${checkbox('echo_sms', 'Echo to SMS (opted-in)', false)}</div>
            <button class="btn">Post</button>
          </form>`)}
        ${card('Recent', tbl(
          [{ label: 'Title' }, { label: 'Property' }, { label: 'Window' }, { label: 'Echo' }],
          anns.map((a) => ({
            cells: [a.title, a.property || 'All', `${fmtDate(a.starts_date)}${a.ends_date ? ` → ${fmtDate(a.ends_date)}` : ''}`,
              [a.echo_email ? 'email' : '', a.echo_sms ? 'sms' : ''].filter(Boolean).join(' + ') || 'portal only'],
          })),
          { empty: 'No announcements.' },
        ), { flush: true })}`,
    });
  });

  r.post('/comms/announcements', requirePerm('comms:mass'), (rq) => {
    const ctx = rq.ctx as Ctx;
    try {
      postAnnouncement(ctx, {
        propertyId: String(rq.body?.property_id || '') || null, title: String(rq.body?.title), body: String(rq.body?.body),
        startsDate: String(rq.body?.starts_date || ctx.businessDate), endsDate: String(rq.body?.ends_date || '') || null,
        echoEmail: rq.body?.echo_email === '1', echoSms: rq.body?.echo_sms === '1',
      });
      return redirect('/comms/announcements', 'Announcement posted' + (rq.body?.echo_email || rq.body?.echo_sms ? ' — echo scheduled through the mass pipeline' : ''));
    } catch (e) {
      return redirect('/comms/announcements', (e as Error).message, 'err');
    }
  });

  // ---------- public unsubscribe ----------
  r.get('/u/:token', (rq) => {
    const row = q1<any>('SELECT * FROM comm_prefs WHERE unsubscribe_token=?', rq.params.token!);
    if (!row) return notFound();
    run('UPDATE comm_prefs SET email_optout=1, updated_at=? WHERE id=?', nowIso(), row.id);
    return htmlRes(doc('Unsubscribed', html`
      <div style="max-width:480px;margin:80px auto;text-align:center;font-family:system-ui">
        <h1>You're unsubscribed ✓</h1>
        <p>You won't receive community emails anymore. Account notices you're entitled to (like payment receipts) still arrive.</p>
        <p class="small">Changed your mind? Update preferences any time in the resident portal.</p>
      </div>`));
  });
}

// ---------- portal preferences ----------

export function portalRoutes(r: Router): void {
  r.post('/portal/preferences', requireResident, (rq) => {
    const ctx = rq.ctx as Ctx;
    const resident = q1<any>('SELECT * FROM residents WHERE user_id=? AND org_id=?', ctx.userId, ctx.orgId);
    if (!resident) return notFound();
    setOptout(ctx, 'resident', resident.id, 'email', rq.body?.email_ok !== '1');
    setOptout(ctx, 'resident', resident.id, 'sms', rq.body?.sms_ok !== '1');
    return redirect('/portal/lease', 'Communication preferences saved');
  });
}

/** preferences card for the portal lease tab */
export function portalPrefsCard(ctx: Ctx, resident: any): Child {
  const prefs = commPrefs(ctx.orgId, 'resident', resident.id);
  return html`
    <div class="card">
      <h3>Communication preferences</h3>
      <form method="post" action="/portal/preferences">
        ${checkbox('email_ok', 'Community emails (events, announcements)', !prefs.emailOptout)}
        ${checkbox('sms_ok', 'Text messages (opted-in reminders)', !prefs.smsOptout)}
        <p class="small muted">Account notices required for your tenancy (receipts, legal notices) always arrive.</p>
        <button class="btn btn-sm">Save</button>
      </form>
    </div>`;
}
