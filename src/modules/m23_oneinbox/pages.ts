import { html, raw, when, join, type Child, type Raw } from '../../lib/html.ts';
import { notFound, redirect, type Router, type Rq, type Res } from '../../lib/http.ts';
import { requirePerm, can, type Ctx } from '../../lib/auth.ts';
import { deliveryNote, deliveryLabel } from '../../lib/sim/messaging.ts';
import { emailLive } from '../../lib/email.ts';
import { q } from '../../lib/db.ts';
import { fmtTs } from '../../lib/dates.ts';
import { parseCsv } from '../../lib/csv.ts';
import { parseSpreadsheet } from '../../lib/xlsx.ts';
import { shell, card, tbl, field, input, select, textarea, checkbox, tabs, emptyState, registerNav } from '../../ui/ui.ts';
import { inboundToken } from '../m3_crm/ils_email.ts';
import { parseRoster, suggestReply, emailsIn, phonesIn, type Category, type ContactKind, type RosterParse } from './engine.ts';
import {
  contacts, counts, ingest, message, fileTo, unfile, setDone, replaceRoster, addContact, purge, replyBlocker, replyDelivery, sendReply,
  inboxAddress, lastReceivedAt, type ContactRow, type MessageRow,
} from './service.ts';
import { SAMPLE_ROSTER, SAMPLE_MAIL } from './sample.ts';

/** /one-inbox — a shared mailbox, matched to people and sorted, alongside the
 * operator's own system. Named "One Inbox" (not "Inbox") because /inbox is the
 * resident-thread inbox for orgs whose residents live in StayLeased; this one
 * is for an operator whose residents live in AppFolio and who forwards a
 * mailbox here. Staff read and file; a reply is sent from this screen when
 * the organization's email delivery is on, and copied out otherwise. */

registerNav('Residents', { href: '/one-inbox', label: 'One Inbox', perm: 'comms:view', match: ['/one-inbox'] });

const TZ = 'America/New_York';
const ACCEPT = '.csv,.tsv,.txt,.xlsx,.xlsm,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const CAT: Record<Category, [string, string]> = {
  repair: ['Repair', 'info'],
  payment: ['Payment', 'violet'],
  agency: ['Agency', 'warn'],
  owner: ['Owner', ''],
  leasing: ['Leasing', 'ok'],
  other: ['Other', ''],
};

const badge = (label: string, tone: string): Raw => html`<span class="badge ${tone}">${label}</span>`;
const place = (c: { property: string; unit: string }): string =>
  [c.property, c.unit && c.unit.toLowerCase() !== 'main' ? `Unit ${c.unit}` : ''].filter(Boolean).join(' · ');
const who = (c: ContactRow): string => `${c.name}${place(c) ? ` — ${place(c)}` : ''}`;

function matchBadge(m: MessageRow): Raw {
  if (m.match_status === 'matched') return badge('Filed', 'ok');
  if (m.match_status === 'ambiguous') return badge('Pick who', 'warn');
  return badge('Unsorted', 'bad');
}

function listPage(rq: Rq): Res {
  const ctx = rq.ctx as Ctx;
  const view = rq.query.get('view') || 'open';
  const n = counts(ctx.orgId);
  let where = `m.org_id=?`;
  if (view === 'needs_filing') where += ` AND m.status='open' AND m.match_status != 'matched'`;
  else if (view === 'urgent') where += ` AND m.status='open' AND m.urgency='urgent'`;
  else if (view === 'done') where += ` AND m.status='done'`;
  else where += ` AND m.status='open'`;
  const rows = q<any>(
    `SELECT m.*, c.name AS c_name, c.property AS c_property, c.unit AS c_unit
     FROM oi_messages m LEFT JOIN oi_contacts c ON c.id=m.contact_id AND c.org_id=m.org_id
     WHERE ${where} ORDER BY (m.urgency='urgent') DESC, m.received_at DESC LIMIT 100`,
    ctx.orgId,
  );
  const last = lastReceivedAt(ctx.orgId);
  const quietHours = last ? (Date.now() - Date.parse(last)) / 3_600_000 : null;
  const empty = !n.contacts && !n.open && !n.done;

  return shell(rq, {
    title: 'One Inbox',
    active: '/one-inbox',
    subtitle: emailLive(ctx)
      ? 'A shared mailbox, matched to people and sorted. Replies can be sent from here by email.'
      : 'A shared mailbox, matched to people and sorted. Replies are sent from your own email.',
    actions: html`<a class="btn btn-ghost" href="/one-inbox/setup">Setup</a>`,
    content: html`
      ${when(n.sample > 0, () => html`<div class="callout info">Showing <b>sample data</b> (fictional people and emails).
        <form method="post" action="/one-inbox/purge" style="display:inline"><input type="hidden" name="scope" value="sample" /><button class="btn btn-sm btn-ghost" type="submit">Clear the sample</button></form></div>`)}
      ${when(quietHours !== null && quietHours > 48, () => html`<div class="callout warn">No forwarded email has arrived in ${Math.floor(quietHours! / 24)} days. If the mailbox is normally busy, check that the forwarding rule is still on. <a href="/one-inbox/setup">Setup</a></div>`)}
      ${empty
        ? emptyState('Nothing here yet', 'Upload a tenant list and forward a mailbox, or load a sample to see how it works.',
          html`<a class="btn" href="/one-inbox/setup">Set up One Inbox</a>`)
        : html`
          ${tabs([
            { href: '/one-inbox?view=needs_filing', label: 'Needs filing', active: view === 'needs_filing', count: n.needsFiling },
            { href: '/one-inbox?view=urgent', label: 'Urgent', active: view === 'urgent', count: n.urgent },
            { href: '/one-inbox?view=open', label: 'Open', active: view === 'open', count: n.open },
            { href: '/one-inbox?view=done', label: 'Done', active: view === 'done' },
          ])}
          ${card(null, rows.length ? join(rows.map((m) => html`
            <a class="list-item oi-row" href="/one-inbox/m/${m.id}">
              <div class="li-main">
                <div class="li-title">
                  ${when(m.urgency === 'urgent', () => html`${badge('Urgent', 'bad')} `)}${badge(CAT[m.category as Category][0], CAT[m.category as Category][1])} ${matchBadge(m)}
                  <b>${m.c_name || m.from_name || m.from_email}</b>
                  <span class="muted small">${m.c_name ? `· ${place({ property: m.c_property, unit: m.c_unit })}` : `· ${m.from_email}`}</span>
                </div>
                <div class="li-sub"><b>${m.subject || '(no subject)'}</b> — ${String(m.body).replace(/\s+/g, ' ').slice(0, 140)}</div>
              </div>
              <div class="small muted nowrap">${fmtTs(m.received_at, TZ)}</div>
            </a>`), '') : emptyState('Nothing in this view', view === 'needs_filing' ? 'Every open email has been matched to a person.' : undefined), { flush: true })}`}
    `,
  });
}

/** The reply banner states what the Outbox row says now, not what was hoped
 * for when the reply was written. */
function replyBanner(ctx: Ctx, m: MessageRow): Raw {
  const d = replyDelivery(ctx.orgId, m);
  const at = fmtTs(m.replied_at!, TZ);
  const link = when(d, () => html` <a href="/dev/messages/${m.reply_message_id}">Open it in the Outbox</a>.`);
  if (!d) return html`<div class="callout" style="margin:0 0 12px">A reply was written from StayLeased on ${at}. Its Outbox record is no longer available, so its delivery is not known.</div>`;
  if (d.status === 'failed' || d.status === 'bounced') {
    return html`<div class="callout warn" style="margin:0 0 12px"><b>${deliveryLabel(d.status)}.</b> The reply written on ${at} did not reach ${m.from_email}. ${d.error || 'The mail provider did not accept it.'}${link}</div>`;
  }
  if (d.status === 'queued') {
    return html`<div class="callout" style="margin:0 0 12px"><b>${deliveryLabel(d.status)}.</b> The reply written on ${at} is on its way to ${m.from_email}.${d.error ? ` The last attempt did not go through (${d.error}); it will be tried again shortly.` : ''}${link}</div>`;
  }
  if (d.status === 'recorded') {
    return html`<div class="callout warn" style="margin:0 0 12px"><b>${deliveryLabel(d.status)}.</b> The reply written on ${at} was saved to the Outbox and has not been emailed.${link}</div>`;
  }
  return html`<div class="callout" style="margin:0 0 12px"><b>${deliveryLabel(d.status)}.</b> The reply to ${m.from_email} was written on ${at}.${link}</div>`;
}

function messagePage(rq: Rq, m: MessageRow): Res {
  const ctx = rq.ctx as Ctx;
  const all = contacts(ctx.orgId);
  const c = m.contact_id ? all.find((x) => x.id === m.contact_id) || null : null;
  const candIds: string[] = JSON.parse(m.candidates || '[]');
  const cands = candIds.map((cid) => all.find((x) => x.id === cid)).filter((x): x is ContactRow => !!x);
  const draft = suggestReply(m.category, m.urgency, c);
  const blocker = replyBlocker(ctx, m);
  const canSend = !blocker && can(ctx, 'comms:send');
  const replyHome = inboundToken() ? 'here, to One Inbox' : 'to the reply address in Settings → Communications';
  const history = c
    ? q<any>(
      `SELECT m.id, m.received_at, m.subject, m.category, m.status FROM oi_messages m JOIN oi_contacts k ON k.id=m.contact_id AND k.org_id=m.org_id
       WHERE m.org_id=? AND k.property=? AND k.unit=? AND m.id != ? ORDER BY m.received_at DESC LIMIT 15`,
      ctx.orgId, c.property, c.unit, m.id)
    : [];
  const fileForm = (cid: string, label: Child, primary = false): Raw => html`
    <form method="post" action="/one-inbox/m/${m.id}/file" style="display:inline">
      <input type="hidden" name="contact_id" value="${cid}" /><input type="hidden" name="remember" value="1" />
      <button class="btn btn-sm ${primary ? '' : 'btn-ghost'}" type="submit">${label}</button>
    </form>`;

  return shell(rq, {
    title: m.subject || '(no subject)',
    active: '/one-inbox',
    crumbs: [['One Inbox', '/one-inbox']],
    subtitle: html`${when(m.urgency === 'urgent', () => html`${badge('Urgent', 'bad')} `)}${badge(CAT[m.category][0], CAT[m.category][1])} ${matchBadge(m)} · received ${fmtTs(m.received_at, TZ)}`,
    actions: html`<form method="post" action="/one-inbox/m/${m.id}/${m.status === 'done' ? 'reopen' : 'done'}" style="display:inline">
      <button class="btn ${m.status === 'done' ? 'btn-ghost' : ''}" type="submit">${m.status === 'done' ? 'Reopen' : 'Mark done'}</button></form>`,
    content: html`
      <div class="grid cols-2">
        <div>
          ${card('The email', html`
            <p class="small muted" style="margin:0 0 8px">From <b>${m.from_name || m.from_email}</b> &lt;${m.from_email}&gt;${m.mailbox ? html` · to ${m.mailbox}` : ''}${m.forwarded_by ? html` · forwarded by ${m.forwarded_by}` : ''}</p>
            <div style="white-space:pre-wrap;font-size:14px;line-height:1.55">${m.body}</div>`)}
          ${when(m.replied_at, () => replyBanner(ctx, m))}
          ${when(draft || canSend, () => card(canSend ? 'Reply' : 'Suggested reply', canSend
            ? html`
              <p class="small muted" style="margin:0 0 8px">${draft ? 'Edit the suggestion, then send.' : 'Write the reply, then send.'} It goes to <b>${m.from_email}</b> by email, and their answer comes back ${replyHome}.</p>
              <form method="post" action="/one-inbox/m/${m.id}/reply">
                ${field('Subject', input('subject', { value: `Re: ${m.subject || 'your message'}` }))}
                ${field('Message', textarea('text', { value: draft || '', rows: 10, required: true, id: 'oi-draft' }))}
                <div class="btn-row">
                  <button class="btn" type="submit">Send reply</button>
                  <button type="button" class="btn btn-ghost" data-copy="#oi-draft">Copy</button>
                </div>
              </form>`
            : html`
              <p class="small muted" style="margin:0 0 8px">Copy this into your own email, edit it, and send it from there. ${blocker
                ? html`${blocker}${when(!emailLive(ctx) && !m.is_sample, () => html` <a href="/setup/connections">Set up email</a>.`)}`
                : 'Your account does not have permission to send email from StayLeased; ask an administrator if it should.'}</p>
              ${textarea('draft', { value: draft!, rows: 9, id: 'oi-draft' })}
              <div class="btn-row"><button type="button" class="btn btn-sm" data-copy="#oi-draft">Copy reply</button>
                <a class="btn btn-sm btn-ghost" href="mailto:${m.from_email}?subject=${encodeURIComponent(`Re: ${m.subject}`)}&body=${encodeURIComponent(draft!)}">Open in my email</a></div>`))}
          ${when(!draft && !canSend, () => card('Suggested reply', html`<p class="small muted" style="margin:0">No reply is suggested until this email is filed to a person. A reply needs a known recipient.${when(blocker && emailLive(ctx) && !m.is_sample, () => html` ${blocker}`)}</p>`))}
        </div>
        <div>
          ${card('Who is this from?', html`
            ${c ? html`<p style="margin:0 0 4px"><b>${c.name}</b> ${badge(c.kind, '')}</p>
                <p class="small muted" style="margin:0 0 8px">${place(c) || 'No property on file'}</p>`
              : html`<p style="margin:0 0 8px"><b>Not filed yet.</b></p>`}
            <p class="small muted" style="margin:0 0 12px">${m.match_reason}</p>
            ${when(cands.length && !c, () => html`<p class="small" style="margin:0 0 6px"><b>Could be:</b></p>
              <div class="btn-row" style="flex-wrap:wrap;gap:6px;margin:0 0 12px">${cands.map((k) => fileForm(k.id, who(k), true))}</div>`)}
            ${when(all.length, () => html`
              <form method="post" action="/one-inbox/m/${m.id}/file">
                ${field(c ? 'File to someone else' : 'File to', select('contact_id', all.map((k) => [k.id, who(k)]), null, { blank: 'Choose a person…', required: true }))}
                ${checkbox('remember', html`Remember <b>${m.from_email}</b> for this person`, true)}
                <div class="btn-row"><button class="btn btn-sm btn-ghost" type="submit">File</button></div>
              </form>`)}
            ${when(c, () => html`<form method="post" action="/one-inbox/m/${m.id}/unfile" style="margin-top:8px"><button class="btn btn-sm btn-ghost" type="submit">This is the wrong person</button></form>`)}
            <details style="margin-top:14px"><summary class="small">Sender is not on the list: add them</summary>
              <form method="post" action="/one-inbox/m/${m.id}/add-contact" style="margin-top:8px">
                <div class="form-grid">
                  ${field('Name', input('name', { value: m.from_name, required: true }))}
                  ${field('Type', select('kind', [['tenant', 'Tenant'], ['agency', 'Agency / case worker'], ['owner', 'Owner'], ['vendor', 'Vendor'], ['other', 'Other']], m.category === 'agency' ? 'agency' : 'tenant'))}
                  ${field('Property', input('property', {}))}
                  ${field('Unit', input('unit', {}))}
                </div>
                <div class="btn-row"><button class="btn btn-sm btn-ghost" type="submit">Add and file</button></div>
              </form></details>`)}
          ${when(c, () => card('Earlier emails for this unit', history.length ? tbl(
            [{ label: 'When' }, { label: 'Subject' }, { label: 'Kind' }, { label: '' }],
            history.map((h) => ({
              cells: [html`<span class="nowrap small">${fmtTs(h.received_at, TZ)}</span>`, html`<a href="/one-inbox/m/${h.id}">${h.subject || '(no subject)'}</a>`,
                badge(CAT[h.category as Category][0], CAT[h.category as Category][1]), h.status === 'done' ? badge('Done', 'ok') : ''],
            })), { sort: false }) : html`<p class="small muted" style="margin:0">This is the first email on record for this unit.</p>`))}
        </div>
      </div>`,
  });
}

function setupPage(rq: Rq, note?: Child): Res {
  const ctx = rq.ctx as Ctx;
  const n = counts(ctx.orgId);
  const live = !!inboundToken();
  const addr = inboxAddress(ctx.orgId);
  const last = lastReceivedAt(ctx.orgId);
  return shell(rq, {
    title: 'One Inbox setup',
    active: '/one-inbox',
    crumbs: [['One Inbox', '/one-inbox']],
    content: html`
      ${note}
      <div class="grid cols-2">
        ${card('1 · Who are your people?', html`
          <p class="small muted" style="margin:0 0 10px">Upload a tenant directory (Excel or CSV) with name, email, phone, property and unit. Emails are matched against this list. Uploading again replaces it, and keeps any addresses staff have taught the system.</p>
          <p class="small" style="margin:0 0 10px">On the list now: <b>${n.contacts}</b> ${n.contacts === 1 ? 'person' : 'people'}.</p>
          <form method="post" action="/one-inbox/roster" enctype="multipart/form-data">
            ${field('Tenant directory', raw(`<input type="file" name="roster" accept="${ACCEPT}" required />`))}
            <div class="btn-row"><button class="btn" type="submit">Upload list</button></div>
          </form>`)}
        ${card('2 · How does email get here?', html`
          <p class="small" style="margin:0 0 6px">Your forwarding address:</p>
          <p style="margin:0 0 10px"><code>${addr}</code></p>
          ${live
            ? html`<p class="small muted" style="margin:0 0 8px">Ask your email administrator to forward a shared mailbox (for example maintenance@) to this address at the company level, not as one person’s rule. ${last ? html`Last email arrived ${fmtTs(last, TZ)}.` : 'No forwarded email has arrived yet.'}</p>`
            : html`<div class="callout warn" style="margin:0 0 8px">Forwarding is not switched on for this StayLeased server yet, so mail sent to this address will not arrive. Until it is, add emails by pasting them below.</div>`}
          <details${live ? '' : ' open'}><summary class="small">Add an email by pasting it</summary>
            <form method="post" action="/one-inbox/add" style="margin-top:8px">
              <div class="form-grid">
                ${field('From (email)', input('from_email', { type: 'email', required: true }))}
                ${field('From (name)', input('from_name', {}))}
              </div>
              ${field('Subject', input('subject', {}))}
              ${field('Message', textarea('text', { rows: 6, required: true }))}
              <div class="btn-row"><button class="btn btn-ghost" type="submit">Add email</button></div>
            </form></details>`)}
        ${card('See it with sample data', html`
          <p class="small muted" style="margin:0 0 10px">Loads a fictional contact list and eleven emails that show each case: a known sender, a new address that names its unit, a manual forward, a case worker with two households, two people with the same name, and an email nobody can place.</p>
          <form method="post" action="/one-inbox/sample"><button class="btn btn-ghost" type="submit"${n.contacts && !n.sample ? ' disabled' : ''}>Load the sample</button></form>
          ${when(n.contacts && !n.sample, () => html`<p class="small muted" style="margin:8px 0 0">Not available once a real contact list is uploaded, so sample people never mix with real ones.</p>`)}`)}
        ${card('Your data', html`
          <p class="small muted" style="margin:0 0 10px">One Inbox keeps the emails it receives and the contact list you upload, for this account only. You can delete all of it at any time. The forwarding address stays the same.</p>
          <form method="post" action="/one-inbox/purge">
            <input type="hidden" name="scope" value="all" />
            ${field('Type DELETE to confirm', input('confirm', { placeholder: 'DELETE' }))}
            <div class="btn-row"><button class="btn btn-ghost" type="submit">Delete all One Inbox data</button></div>
          </form>`)}
      </div>`,
  });
}

export function routes(r: Router): void {
  const view = requirePerm('comms:view');
  const act = requirePerm('comms:send');

  r.get('/one-inbox', view, (rq) => listPage(rq));
  r.get('/one-inbox/setup', view, (rq) => setupPage(rq));

  r.get('/one-inbox/m/:id', view, (rq) => {
    const m = message((rq.ctx as Ctx).orgId, rq.params.id!);
    return m ? messagePage(rq, m) : notFound();
  });

  r.post('/one-inbox/roster', act, (rq) => {
    const ctx = rq.ctx as Ctx;
    const up = (rq.uploads || []).find((u) => u.field === 'roster' && u.data.length);
    if (!up) return redirect('/one-inbox/setup', 'Choose a file to upload.', 'err');
    let best = null as RosterParse | null;
    try {
      for (const s of parseSpreadsheet(up.filename, up.data, parseCsv)) {
        const p = parseRoster(s.rows.map((row: unknown[]) => row.map((c) => (c === null || c === undefined ? '' : String(c)))));
        if (!best || p.rowsRead > best.rowsRead) best = p;
      }
    } catch {
      return redirect('/one-inbox/setup', `${up.filename} could not be opened as a spreadsheet or CSV.`, 'err');
    }
    if (!best || !best.rows.length) {
      return redirect('/one-inbox/setup', `No people could be read from that file. ${best?.warnings.join(' ') || ''}`.trim(), 'err');
    }
    // a real list replaces the sample outright
    if (counts(ctx.orgId).sample) purge(ctx, 'sample');
    const res = replaceRoster(ctx, best.rows);
    const withEmail = best.rows.filter((x) => x.emails.length).length;
    return redirect('/one-inbox/setup',
      `${res.added} people loaded, ${withEmail} with an email address.${best.warnings.length ? ` ${best.warnings.join(' ')}` : ''}`);
  });

  r.post('/one-inbox/add', act, (rq) => {
    const ctx = rq.ctx as Ctx;
    const fromEmail = emailsIn(String(rq.body.from_email || ''))[0];
    const text = String(rq.body.text || '').slice(0, 50_000);
    if (!fromEmail || text.trim().length < 2) return redirect('/one-inbox/setup', 'An email needs a sender address and a message.', 'err');
    const res = ingest(ctx.orgId, {
      fromEmail, fromName: String(rq.body.from_name || '').slice(0, 120), to: [], subject: String(rq.body.subject || '').slice(0, 300), text,
    }, { via: 'manual' });
    return redirect(`/one-inbox/m/${res.id}`, res.duplicate ? 'That email was already here.' : undefined);
  });

  r.post('/one-inbox/sample', act, (rq) => {
    const ctx = rq.ctx as Ctx;
    const n = counts(ctx.orgId);
    if (n.contacts && !n.sample) return redirect('/one-inbox/setup', 'The sample is not loaded once a real contact list exists.', 'err');
    if (n.sample) purge(ctx, 'sample');
    replaceRoster(ctx, SAMPLE_ROSTER, { sample: true });
    const now = Date.now();
    for (const s of SAMPLE_MAIL) {
      ingest(ctx.orgId, s.mail, { via: 'sample', receivedAt: new Date(now - s.minutesAgo * 60_000).toISOString() });
    }
    return redirect('/one-inbox?view=open', 'Sample loaded: fictional people and emails.');
  });

  r.post('/one-inbox/purge', act, (rq) => {
    const ctx = rq.ctx as Ctx;
    const scope = rq.body.scope === 'all' ? 'all' : 'sample';
    if (scope === 'all' && String(rq.body.confirm || '').trim() !== 'DELETE') {
      return redirect('/one-inbox/setup', 'Type DELETE to confirm deleting all One Inbox data.', 'err');
    }
    const res = purge(ctx, scope);
    return redirect(scope === 'all' ? '/one-inbox/setup' : '/one-inbox',
      `Deleted ${res.messages} email${res.messages === 1 ? '' : 's'} and ${res.contacts} contact${res.contacts === 1 ? '' : 's'}.`);
  });

  r.post('/one-inbox/m/:id/file', act, (rq) => {
    const ok = fileTo(rq.ctx as Ctx, rq.params.id!, String(rq.body.contact_id || ''), !!rq.body.remember);
    return ok ? redirect(`/one-inbox/m/${rq.params.id}`, 'Filed.') : notFound();
  });

  r.post('/one-inbox/m/:id/unfile', act, (rq) =>
    unfile(rq.ctx as Ctx, rq.params.id!) ? redirect(`/one-inbox/m/${rq.params.id}`, 'Moved back to needs filing.') : notFound());

  r.post('/one-inbox/m/:id/add-contact', act, (rq) => {
    const ctx = rq.ctx as Ctx;
    const m = message(ctx.orgId, rq.params.id!);
    if (!m) return notFound();
    const name = String(rq.body.name || '').trim().slice(0, 120);
    if (!name) return redirect(`/one-inbox/m/${m.id}`, 'A name is needed.', 'err');
    const kinds: ContactKind[] = ['tenant', 'agency', 'owner', 'vendor', 'other'];
    const kind = kinds.includes(rq.body.kind) ? rq.body.kind as ContactKind : 'other';
    const cid = addContact(ctx, {
      name, emails: [m.from_email], phones: phonesIn(m.body).slice(0, 1),
      property: String(rq.body.property || '').trim().slice(0, 120), unit: String(rq.body.unit || '').trim().slice(0, 40), kind,
    });
    fileTo(ctx, m.id, cid, true);
    return redirect(`/one-inbox/m/${m.id}`, `${name} added and this email filed to them.`);
  });

  r.post('/one-inbox/m/:id/reply', act, (rq) => {
    const ctx = rq.ctx as Ctx;
    const mid = rq.params.id!;
    const res = sendReply(ctx, mid, { subject: String(rq.body.subject || ''), text: String(rq.body.text || '') });
    if (!res.ok) return redirect(`/one-inbox/m/${mid}`, res.error, 'err');
    return redirect(`/one-inbox/m/${mid}`, `Reply written. ${deliveryNote(ctx, 'email')}.`);
  });

  r.post('/one-inbox/m/:id/done', act, (rq) =>
    setDone(rq.ctx as Ctx, rq.params.id!, true) ? redirect('/one-inbox', 'Marked done.') : notFound());
  r.post('/one-inbox/m/:id/reopen', act, (rq) =>
    setDone(rq.ctx as Ctx, rq.params.id!, false) ? redirect(`/one-inbox/m/${rq.params.id}`, 'Reopened.') : notFound());
}
