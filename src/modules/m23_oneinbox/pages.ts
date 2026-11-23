import { html, raw, when, safeHtml, type Child, type Raw } from '../../lib/html.ts';
import { notFound, redirect, fileRes, cookie, type Router, type Rq, type Res } from '../../lib/http.ts';
import { requirePerm, can, type Ctx } from '../../lib/auth.ts';
import { deliveryNote, deliveryLabel } from '../../lib/sim/messaging.ts';
import { emailLive } from '../../lib/email.ts';
import { q } from '../../lib/db.ts';
import { fmtTs, fmtAge } from '../../lib/dates.ts';
import { parseCsv } from '../../lib/csv.ts';
import { parseSpreadsheet } from '../../lib/xlsx.ts';
import { shell, card, tbl, field, input, select, textarea, checkbox, tabs, emptyState, registerNav } from '../../ui/ui.ts';
import { inboundToken } from '../m3_crm/ils_email.ts';
import { parseRoster, suggestReply, emailsIn, phonesIn, type Category, type ContactKind, type RosterParse, type RosterRow } from './engine.ts';
import {
  contacts, contact, counts, ingest, message, fileTo, unfile, setDone, replaceRoster, addContact, updateContact, removeContact, openByContact,
  purge, replyBlocker, replyDelivery, sentReply, sendReply, inboxAddress, lastReceivedAt, listMessages, neighbors, nextInView, properties,
  orgNow, businessDaysSince, signerFor, CATEGORIES, PAGE_SIZE,
  type ContactRow, type MessageRow, type ListFilter, type ListRow, type View,
} from './service.ts';
import { SAMPLE_ROSTER, SAMPLE_MAIL } from './sample.ts';

/** /one-inbox — a shared mailbox, matched to people and sorted, alongside the
 * operator's own system. Named "One Inbox" (not "Inbox") because /inbox is the
 * resident-thread inbox for orgs whose residents live in StayLeased; this one
 * is for an operator whose residents live in AppFolio and who forwards a
 * mailbox here. Staff read and file; a reply is sent from this screen when
 * the organization's email delivery is on, and copied out otherwise.
 *
 * The screens are built around one loop: open an email, say who it is from if
 * the system could not, reply, mark it done, land on the next one. So every
 * link and form carries the view the person is working in (tab, search,
 * building, kind), and every state change can be undone from where it lands. */

registerNav('Residents', { href: '/one-inbox', label: 'One Inbox', perm: 'comms:view', match: ['/one-inbox'] });

const TZ = 'America/New_York';
const ACCEPT = '.csv,.tsv,.txt,.xlsx,.xlsm,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const CAT: Record<Category, string> = {
  repair: 'Repair', payment: 'Payment', agency: 'Agency', owner: 'Owner', leasing: 'Leasing', other: 'Other',
};
const KIND: Record<ContactKind, string> = {
  tenant: 'Resident', agency: 'Agency or case worker', owner: 'Owner', vendor: 'Vendor', other: 'Other',
};
const KIND_OPTIONS: [string, string][] = (Object.keys(KIND) as ContactKind[]).map((k) => [k, KIND[k]]);
const kindOf = (v: unknown): ContactKind => ((Object.keys(KIND) as string[]).includes(String(v)) ? String(v) as ContactKind : 'other');

const place = (c: { property: string | null; unit: string | null }): string =>
  [c.property || '', c.unit && c.unit.toLowerCase() !== 'main' ? `Unit ${c.unit}` : ''].filter(Boolean).join(' · ');
const who = (c: ContactRow): string => `${c.name}${place(c) ? ` — ${place(c)}` : ''}`;
const phone = (d: string): string => (/^\d{10}$/.test(d) ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** One label per person for the type-to-find box. Two people who would read
 * the same get a number, so each label still names exactly one record. */
function labels(all: ContactRow[]): Map<string, string> {
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  for (const c of all) {
    const base = who(c);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    out.set(c.id, n === 1 ? base : `${base} (${n})`);
  }
  return out;
}

// ---------- the view a person is working in ----------

const VIEWS: View[] = ['open', 'urgent', 'needs_filing', 'done', 'all'];

function filterOf(get: (k: string) => unknown): ListFilter {
  const s = (k: string): string => String(get(k) ?? '').trim();
  const text = s('q').slice(0, 120);
  const person = s('person').slice(0, 60);
  const v = s('view') as View;
  const cat = s('category') as Category;
  return {
    // a search with no tab picked looks through open and done together
    view: VIEWS.includes(v) ? v : text || person ? 'all' : 'open',
    q: text,
    property: s('property').slice(0, 120),
    category: CATEGORIES.includes(cat) ? cat : '',
    person,
  };
}
const fromQuery = (rq: Rq): ListFilter => filterOf((k) => rq.query.get(k));
const fromBody = (rq: Rq): ListFilter => filterOf((k) => rq.body[k]);

function qs(f: ListFilter, extra: Record<string, string | number | undefined> = {}): string {
  const p = new URLSearchParams();
  if (f.view !== (f.q || f.person ? 'all' : 'open')) p.set('view', f.view);
  if (f.q) p.set('q', f.q);
  if (f.property) p.set('property', f.property);
  if (f.category) p.set('category', f.category);
  if (f.person) p.set('person', f.person);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== '') p.set(k, String(v));
  const out = p.toString();
  return out ? `?${out}` : '';
}
const listUrl = (f: ListFilter, extra?: Record<string, string | number | undefined>): string => `/one-inbox${qs(f, extra)}`;
const msgUrl = (id: string, f: ListFilter, extra?: Record<string, string | number | undefined>): string => `/one-inbox/m/${id}${qs(f, extra)}`;

/** The view, as hidden fields, so a form's answer comes back to the same place. */
function carry(f: ListFilter): Raw {
  return html`<input type="hidden" name="view" value="${f.view}" />${when(f.q, () => html`<input type="hidden" name="q" value="${f.q}" />`)}${
    when(f.property, () => html`<input type="hidden" name="property" value="${f.property}" />`)}${
    when(f.category, () => html`<input type="hidden" name="category" value="${f.category}" />`)}${
    when(f.person, () => html`<input type="hidden" name="person" value="${f.person}" />`)}`;
}

/** "Marked done. Undo" — shown where the person lands after an action, with
 * the way back. Read from the address, checked against what is true now, so a
 * stale link shows nothing. */
function notice(rq: Rq, f: ListFilter): Child {
  const ctx = rq.ctx as Ctx;
  const did = rq.query.get('did');
  const was = rq.query.get('was');
  if (!was || (did !== 'done' && did !== 'filed')) return null;
  const m = message(ctx.orgId, was);
  if (!m) return null;
  const undo = can(ctx, 'comms:send');
  if (did === 'done') {
    if (m.status !== 'done') return null;
    return html`<div class="oi-note" role="status"><span>Marked done: <b>${m.subject || '(no subject)'}</b></span>
      ${when(undo, () => html`<form method="post" action="/one-inbox/m/${m.id}/reopen">${carry(f)}<button class="btn btn-sm btn-ghost" type="submit">Undo</button></form>`)}</div>`;
  }
  const c = m.contact_id ? contact(ctx.orgId, m.contact_id) : null;
  if (!c) return null;
  return html`<div class="oi-note" role="status"><span>Saved as <b>${c.name}</b>${place(c) ? `, ${place(c)}` : ''}.${
    when(rq.query.get('learned') === '1', () => html` Email from ${m.from_email} will go to them from now on.`)}</span>
    ${when(undo, () => html`<form method="post" action="/one-inbox/m/${m.id}/unfile">${carry(f)}${
      when(rq.query.get('learned') === '1', () => html`<input type="hidden" name="forget" value="1" />`)}<button class="btn btn-sm btn-ghost" type="submit">Undo</button></form>`)}</div>`;
}

/** "Nov 21" */
function shortDay(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

const when2 = (iso: string, now: Date): Raw => html`<time datetime="${iso}" title="${fmtTs(iso, TZ)}">${fmtAge(iso, now, TZ)}</time>`;

/** The words after the subject on a row. Colour is spent only on what needs
 * a person: red for urgent, amber for "we do not know who this is". */
function rowState(m: ListRow): { parts: Child[]; said: string[] } {
  const parts: Child[] = [];
  const said: string[] = [];
  if (m.urgency === 'urgent' && m.status === 'open') { parts.push(html`<span class="oi-urgent">Urgent</span>`); said.push('Urgent'); }
  parts.push(html`<span>${CAT[m.category]}</span>`);
  said.push(CAT[m.category]);
  if (m.match_status !== 'matched') {
    const n = (JSON.parse(m.candidates || '[]') as string[]).length;
    const label = m.match_status === 'ambiguous' && n > 0 ? plural(n, 'possible person', 'possible people') : 'Unknown sender';
    parts.push(html`<span class="badge warn">${label}</span>`);
    said.push(label);
  }
  if (m.replied_at) { parts.push(html`<span>Replied</span>`); said.push('Replied'); }
  if (m.status === 'done') {
    const label = `Done ${m.done_at ? shortDay(m.done_at) : ''}${m.done_by_name ? ` by ${m.done_by_name}` : ''}`.replace(/\s+/g, ' ').trim();
    parts.push(html`<span>${label}</span>`);
    said.push(label);
  }
  return { parts, said };
}

function row(m: ListRow, f: ListFilter, now: Date): Raw {
  const name = m.c_name || m.from_name || m.from_email;
  const where = m.c_name ? place({ property: m.c_property, unit: m.c_unit }) : m.from_name ? m.from_email : '';
  const subject = m.subject || '(no subject)';
  const st = rowState(m);
  const age = fmtAge(m.received_at, now, TZ);
  const open = m.status === 'open';
  const hours = (now.getTime() - Date.parse(m.received_at)) / 3_600_000;
  const late = open && m.urgency === 'urgent' && hours > 1 ? 'is-late' : open && businessDaysSince(m.received_at, now) > 2 ? 'is-old' : '';
  const label = [st.said.includes('Urgent') ? 'Urgent' : '', [name, where].filter(Boolean).join(', '), subject, ...st.said.filter((x) => x !== 'Urgent'), `received ${age}`]
    .filter(Boolean).join('. ');
  return html`<li><a class="oi-row${open && m.urgency === 'urgent' ? ' is-urgent' : ''}${open ? '' : ' is-done'}" href="${msgUrl(m.id, f)}" aria-label="${label}">
    <span class="oi-dot" aria-hidden="true"></span>
    <span class="oi-who"><b>${name}</b>${when(where, () => html`<span class="oi-place">${where}</span>`)}</span>
    <span class="oi-what"><b>${subject}</b><span class="oi-snip">${String(m.body).replace(/\s+/g, ' ').slice(0, 180)}</span></span>
    <span class="oi-state">${st.parts}</span>
    <span class="oi-age ${late}">${when2(m.received_at, now)}</span>
  </a></li>`;
}

const KEYS = (items: [string, string][]): Raw => html`<p class="oi-keys" aria-label="Keyboard shortcuts"><span>Keyboard</span>${
  items.map(([k, what]) => html`<span><kbd>${k}</kbd> ${what}</span>`)}</p>`;

function listPage(rq: Rq): Res {
  const ctx = rq.ctx as Ctx;
  const f = fromQuery(rq);
  const n = counts(ctx.orgId);
  const now = orgNow(ctx);
  const res = listMessages(ctx.orgId, f, Number(rq.query.get('page')) || 1);
  const canAct = can(ctx, 'comms:send');
  const last = lastReceivedAt(ctx.orgId);
  const quiet = last && rq.cookies['oi_quiet'] !== new Date().toISOString().slice(0, 10) && businessDaysSince(last) > 2 ? last : null;
  const empty = !n.contacts && !n.open && !n.done;
  const filtered = !!(f.q || f.property || f.category || f.person);
  const person = f.person ? contact(ctx.orgId, f.person) : null;
  const props = properties(ctx.orgId);
  const tab = (view: View, label: string, count?: number): { href: string; label: Child; active: boolean; count?: number } =>
    ({ href: listUrl({ ...f, view }), label, active: f.view === view, ...(filtered || count === undefined ? {} : { count }) });
  const first = (res.page - 1) * PAGE_SIZE + 1;
  const nothing = f.view === 'needs_filing' ? ['Nobody to identify', 'Every open email has been matched to a person.']
    : f.view === 'urgent' ? ['Nothing urgent', 'No open email is marked urgent.']
    : f.view === 'done' ? ['Nothing done yet', 'Emails marked done are kept here.']
    : ['Nothing open', 'Every email here has been marked done.'];

  return shell(rq, {
    title: 'One Inbox',
    active: '/one-inbox',
    subtitle: 'Email forwarded from your shared mailbox, sorted by who sent it.',
    actions: html`${when(!empty, () => html`<a class="btn btn-ghost" href="/one-inbox/people">People (${n.contacts})</a>`)}<a class="btn btn-ghost" href="/outbox">Sent messages</a><a class="btn btn-ghost" href="/one-inbox/setup">Setup</a>`,
    content: html`<div data-oi="list">
      ${when(n.sample > 0, () => html`<div class="oi-strip"><span>These are <b>sample emails</b> from fictional people.</span>
        ${when(canAct, () => html`<form method="post" action="/one-inbox/purge"><input type="hidden" name="scope" value="sample" /><button class="btn btn-sm btn-ghost" type="submit">Clear the sample</button></form>`)}</div>`)}
      ${when(quiet, () => html`<div class="callout warn oi-quiet"><span>No email has arrived since ${sinceWord(quiet!)}. Check that forwarding is still on.</span>
        <span class="oi-quiet-acts"><a class="btn btn-sm btn-ghost" href="/one-inbox/setup">Check forwarding</a>
        <form method="post" action="/one-inbox/quiet">${carry(f)}<button class="btn btn-sm btn-ghost" type="submit">Hide for today</button></form></span></div>`)}
      ${empty
        ? html`<div class="card"><div class="card-body oi-start">
            <h2>How One Inbox works</h2>
            <ol class="oi-steps">
              <li><b>Upload your resident list</b><span>Names, emails, phone numbers, building and unit.</span></li>
              <li><b>Forward your shared mailbox</b><span>For example maintenance@ or leasing@. Your own email keeps working as it does now.</span></li>
              <li><b>Emails arrive here, sorted</b><span>Each one matched to a person, urgent ones first, with a reply ready to edit.</span></li>
            </ol>
            <div class="btn-row">
              <a class="btn" href="/one-inbox/setup">Set up One Inbox</a>
              ${when(canAct, () => html`<form method="post" action="/one-inbox/sample"><button class="btn btn-ghost" type="submit">Try it with sample emails</button></form>`)}
            </div>
          </div></div>`
        : html`
          <form class="oi-find" method="get" action="/one-inbox" role="search">
            ${when(f.view !== 'open' && f.view !== 'all', () => html`<input type="hidden" name="view" value="${f.view}" />`)}
            ${when(f.person, () => html`<input type="hidden" name="person" value="${f.person}" />`)}
            <input type="search" name="q" id="oi-q" value="${f.q}" placeholder="Search name, unit, subject or text" aria-label="Search name, unit, subject or text" />
            ${when(props.length, () => html`<select name="property" aria-label="Building"><option value="">All buildings</option>${
              props.map((p) => html`<option value="${p}" ${f.property === p ? 'selected' : ''}>${p}</option>`)}</select>`)}
            <select name="category" aria-label="Kind of email"><option value="">All kinds</option>${
              CATEGORIES.map((c) => html`<option value="${c}" ${f.category === c ? 'selected' : ''}>${CAT[c]}</option>`)}</select>
            <button class="btn btn-ghost" type="submit">Search</button>
            ${when(filtered, () => html`<a class="oi-clear" href="${listUrl({ view: f.view === 'all' ? 'open' : f.view, q: '', property: '', category: '', person: '' })}">Clear</a>`)}
          </form>
          <div class="oi-tabs">${tabs([
            tab('open', 'Open', n.open),
            tab('urgent', 'Urgent', n.urgent),
            tab('needs_filing', 'Who is this?', n.needsFiling),
            tab('done', 'Done'),
          ])}</div>
          ${notice(rq, f)}
          ${when(filtered, () => html`<p class="oi-count">${plural(res.total, 'email')} ${res.total === 1 ? 'matches' : 'match'}${
            when(person, () => html` from <b>${person!.name}</b>`)}${f.view === 'all' ? ', open and done' : ''}.</p>`)}
          ${card(null, res.rows.length
            ? html`<ul class="oi-list">${res.rows.map((m) => row(m, f, now))}</ul>`
            : filtered
              ? emptyState('No emails match', html`Try fewer words, or <a href="${listUrl({ view: 'open', q: '', property: '', category: '', person: '' })}">clear the search</a>.`)
              : emptyState(nothing[0]!, nothing[1]), { flush: true })}
          ${when(res.total > PAGE_SIZE, () => html`<div class="oi-pager">
            <span>Showing ${first}–${first + res.rows.length - 1} of ${res.total}</span>
            ${when(res.page > 1, () => html`<a class="btn btn-sm btn-ghost" href="${listUrl(f, { page: res.page - 1 })}">Newer</a>`)}
            ${when(res.page < res.pages, () => html`<a class="btn btn-sm btn-ghost" href="${listUrl(f, { page: res.page + 1 })}">Older</a>`)}
          </div>`)}
          ${KEYS([['j', 'next'], ['k', 'previous'], ['Enter', 'open'], ['/', 'search']])}
          <p class="oi-foot">Messages residents send through the portal are in <a href="/inbox">Inbox</a>.</p>`}
    </div>`,
  });
}

function sinceWord(iso: string): string {
  const d = new Date(iso);
  const days = (Date.now() - d.getTime()) / 86_400_000;
  try {
    return days < 6.5
      ? new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long' }).format(d)
      : new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }).format(d);
  } catch {
    return iso.slice(0, 10);
  }
}

/** The delivery line states what the Outbox row says now, not what was hoped
 * for when the reply was written. */
function replyBanner(ctx: Ctx, m: MessageRow): Raw {
  const d = replyDelivery(ctx.orgId, m);
  const at = fmtTs(m.replied_at!, TZ);
  const link = when(d, () => html` <a href="/dev/messages/${m.reply_message_id}">Open it in the Outbox</a>.`);
  if (!d) return html`<div class="callout oi-delivery">A reply was written from StayLeased on ${at}. Its Outbox record is no longer available, so its delivery is not known.</div>`;
  if (d.status === 'failed' || d.status === 'bounced') {
    return html`<div class="callout warn oi-delivery"><b>${deliveryLabel(d.status)}.</b> The reply written on ${at} did not reach ${m.from_email}. ${d.error || 'The mail provider did not accept it.'}${link}</div>`;
  }
  if (d.status === 'queued') {
    return html`<div class="callout oi-delivery"><b>${deliveryLabel(d.status)}.</b> The reply written on ${at} is on its way to ${m.from_email}.${d.error ? ` The last attempt did not go through (${d.error}); it will be tried again shortly.` : ''}${link}</div>`;
  }
  if (d.status === 'recorded') {
    return html`<div class="callout warn oi-delivery"><b>${deliveryLabel(d.status)}.</b> The reply written on ${at} was saved to the Outbox and has not been emailed.${link}</div>`;
  }
  return html`<div class="callout oi-delivery"><b>${deliveryLabel(d.status)}.</b> The reply to ${m.from_email} was written on ${at}.${link}</div>`;
}

/** Tall enough to show the whole draft, signature included. */
const rowsFor = (text: string): number => Math.max(8, Math.min(18, text.split('\n').reduce((n, line) => n + 1 + Math.floor(line.length / 85), 1)));

interface Compose { subject: string; text: string; error: string }

function messagePage(rq: Rq, m: MessageRow, f: ListFilter, compose?: Compose): Res {
  const ctx = rq.ctx as Ctx;
  const all = contacts(ctx.orgId);
  const c = m.contact_id ? all.find((x) => x.id === m.contact_id) || null : null;
  const candIds: string[] = JSON.parse(m.candidates || '[]');
  const cands = c ? [] : candIds.map((cid) => all.find((x) => x.id === cid)).filter((x): x is ContactRow => !!x);
  const draft = suggestReply(m.category, m.urgency, c, signerFor(ctx));
  const blocker = replyBlocker(ctx, m);
  const canAct = can(ctx, 'comms:send');
  const canSend = !blocker && canAct;
  const replyHome = inboundToken() ? 'here, to One Inbox' : 'to the reply address in Settings → Communications';
  const pos = neighbors(ctx.orgId, f, m.id);
  const done = m.status === 'done';
  const names = labels(all);
  const sender = c?.name || m.from_name || m.from_email;
  const history = c
    ? q<any>(
      c.unit
        ? `SELECT m.id, m.received_at, m.subject, m.category, m.status FROM oi_messages m JOIN oi_contacts k ON k.id=m.contact_id AND k.org_id=m.org_id
           WHERE m.org_id=? AND k.property=? AND k.unit=? AND m.id != ? ORDER BY m.received_at DESC LIMIT 15`
        : `SELECT m.id, m.received_at, m.subject, m.category, m.status FROM oi_messages m
           WHERE m.org_id=? AND m.contact_id=? AND m.id != ? ORDER BY m.received_at DESC LIMIT 15`,
      ...(c.unit ? [ctx.orgId, c.property, c.unit, m.id] : [ctx.orgId, c.id, m.id]))
    : [];
  const sent = m.replied_at ? sentReply(ctx.orgId, m) : null;

  const doneForm = (cls: string): Raw => html`<form method="post" action="/one-inbox/m/${m.id}/${done ? 'reopen' : 'done'}" class="${cls}" ${done ? '' : raw('data-oi-done')}>
    ${carry(f)}<button class="btn ${done ? 'btn-ghost' : ''}" type="submit">${done ? 'Reopen' : 'Mark done'}</button></form>`;
  const step = (id: string | null, label: string, attr: string): Raw => id
    ? html`<a class="btn btn-ghost btn-sm" href="${msgUrl(id, f)}" ${raw(attr)}>${label}</a>`
    : html`<span class="btn btn-ghost btn-sm disabled" aria-disabled="true">${label}</span>`;

  // ---- who is this ----
  const pickForm = (label: string): Child => when(all.length && canAct, () => html`
    <form method="post" action="/one-inbox/m/${m.id}/file" class="oi-pick">${carry(f)}
      ${field(label, input('contact_label', { list: 'oi-people', placeholder: 'Type a name, building or unit', required: true }))}
      <datalist id="oi-people">${all.map((k) => html`<option value="${names.get(k.id)!}"></option>`)}</datalist>
      ${checkbox('remember', html`Send future email from <b>${m.from_email}</b> to this person`, true)}
      <div class="btn-row"><button class="btn ${c || cands.length ? 'btn-ghost' : ''}" type="submit">${c ? 'Change to this person' : 'This is them'}</button></div>
    </form>`);
  const addForm: Child = when(canAct, () => html`<details class="oi-add"><summary>Not on the list? Add them</summary>
    <form method="post" action="/one-inbox/m/${m.id}/add-contact">${carry(f)}
      <div class="form-grid">
        ${field('Name', input('name', { value: m.from_name, required: true }))}
        ${field('Type', select('kind', KIND_OPTIONS, m.category === 'agency' ? 'agency' : m.category === 'owner' ? 'owner' : 'tenant'))}
        ${field('Building', input('property', { list: 'oi-buildings' }))}
        ${field('Unit', input('unit', {}))}
      </div>
      <datalist id="oi-buildings">${properties(ctx.orgId).map((p) => html`<option value="${p}"></option>`)}</datalist>
      <div class="btn-row"><button class="btn btn-ghost" type="submit">Add and save</button></div>
    </form></details>`);
  const identity = c
    ? card('Who sent this', html`
        <div class="oi-person">
          <p class="oi-person-name"><b>${c.name}</b> <span class="oi-role">${KIND[c.kind]}</span></p>
          <p class="oi-person-place">${place(c) || 'No building on file'}</p>
          ${when(c.phones.length || c.emails.length, () => html`<ul class="oi-lines">
            ${c.phones.map((p) => html`<li><span>Phone</span><a href="tel:+1${p}">${phone(p)}</a></li>`)}
            ${c.emails.map((e) => html`<li><span>Email</span><a href="mailto:${e}">${e}</a></li>`)}
          </ul>`)}
          <p class="oi-why">${m.match_reason}</p>
        </div>
        ${when(canAct, () => html`<details class="oi-change"><summary>Not the right person? Change</summary>
          ${pickForm('Who is it from?')}
          <form method="post" action="/one-inbox/m/${m.id}/unfile" class="oi-wrong">${carry(f)}<button class="btn btn-ghost" type="submit">This is the wrong person</button></form>
          ${addForm}
        </details>`)}`)
    : card('Who is this?', html`
        <p class="oi-unknown"><b>We could not tell who sent this.</b> ${m.match_reason}</p>
        ${when(cands.length && canAct, () => html`<p class="oi-could">Could be</p>
          <div class="oi-cands">${cands.map((k, i) => html`<form method="post" action="/one-inbox/m/${m.id}/file">${carry(f)}
            <input type="hidden" name="contact_id" value="${k.id}" /><input type="hidden" name="remember" value="1" />
            <button class="btn btn-ghost" type="submit" data-oi-pick>${when(i < 9, () => html`<kbd>${i + 1}</kbd>`)}<span><b>${k.name}</b>${when(place(k), () => html`<span class="oi-cand-place">${place(k)}</span>`)}</span></button>
          </form>`)}</div>`)}
        ${pickForm(cands.length ? 'Someone else on the list' : 'Find them on the list')}
        ${when(!all.length, () => html`<p class="oi-why">There is nobody on the list yet. <a href="/one-inbox/setup">Upload your resident list</a> so email can be matched.</p>`)}
        ${addForm}`);

  // ---- reply ----
  const again = !!m.replied_at && !compose;
  const sendForm = (): Raw => html`
    ${when(compose?.error, () => html`<div class="callout bad oi-delivery" role="alert"><b>Not sent.</b> ${compose!.error} What you wrote is still below.</div>`)}
    <p class="oi-help">${again ? 'Write the reply, then send.' : 'Edit the suggestion, then send.'} It goes to <b>${m.from_email}</b> by email, and their answer comes back ${replyHome}.${
      when(!c && !again, () => ' We do not know who this is yet, so the suggestion only asks who they are.')}</p>
    <form method="post" action="/one-inbox/m/${m.id}/reply">${carry(f)}
      ${field('Subject', input('subject', { value: compose?.subject ?? `Re: ${m.subject || 'your message'}` }))}
      ${field('Message', textarea('text', { value: compose?.text ?? (again ? '' : draft), rows: rowsFor(compose?.text ?? (again ? '' : draft)), required: true, id: 'oi-draft' }))}
      <div class="btn-row">
        <button class="btn" type="submit">Send reply</button>
        ${when(!done, () => html`<button class="btn btn-ghost" type="submit" name="after" value="done">Send and mark done</button>`)}
      </div>
    </form>`;
  const copyWhy: Child = m.is_sample
    ? 'Sample email. Nothing can be sent.'
    : blocker && !emailLive(ctx)
      ? html`Sending from here is off. Copy this into your own email, or connect email to send from here. <a class="btn btn-sm btn-ghost" href="/setup/connections">Connect email</a>`
      : blocker
        ? html`${blocker} The text is here if you need it.`
        : 'Copy this into your own email, edit it, and send it from there. Your account does not have permission to send email from StayLeased; ask an administrator if it should.';
  const reply = canSend
    ? again
      ? html`<details class="oi-again"><summary class="btn btn-ghost">Write another reply</summary>${card('Reply', sendForm())}</details>`
      : card('Reply', sendForm())
    : card('Suggested reply', html`
        <p class="oi-help">${copyWhy}</p>
        ${textarea('draft', { value: draft, rows: rowsFor(draft), id: 'oi-draft' })}
        <div class="btn-row"><button type="button" class="btn" data-copy="#oi-draft">Copy reply</button>
          ${when(!m.is_sample, () => html`<a class="btn btn-ghost" href="mailto:${m.from_email}?subject=${encodeURIComponent(`Re: ${m.subject}`)}&body=${encodeURIComponent(draft)}">Open in my email</a>`)}</div>`);

  const res = shell(rq, {
    title: m.subject || '(no subject)',
    active: '/one-inbox',
    crumbs: [['One Inbox', listUrl(f)]],
    subtitle: html`From <b>${sender}</b>${when(c && place(c), () => ` · ${place(c!)}`)} · received ${fmtTs(m.received_at, TZ)}
      <span class="oi-tags">${when(m.urgency === 'urgent', () => html`<span class="oi-urgent">Urgent</span>`)}<span>${CAT[m.category]}</span>${
        when(!c, () => html`<span class="badge warn">${cands.length ? plural(cands.length, 'possible person', 'possible people') : 'Unknown sender'}</span>`)}${
        when(m.replied_at, () => html`<span>Replied</span>`)}${when(done, () => html`<span>Done</span>`)}</span>`,
    actions: html`${when(pos.index >= 0, () => html`<nav class="oi-nav" aria-label="Emails in this view">
        ${step(pos.prev, 'Previous', 'data-oi-prev rel="prev"')}<span class="oi-pos">${pos.index + 1} of ${pos.total}</span>${step(pos.next, 'Next', 'data-oi-next rel="next"')}
      </nav>`)}${when(canAct, () => doneForm('oi-head-done'))}`,
    content: html`<div data-oi="message">
      ${notice(rq, f)}
      <div class="oi-msg${c ? '' : ' oi-unfiled'}">
        <div class="oi-main">
          ${card('The email', html`
            <p class="oi-from">From <b>${m.from_name || m.from_email}</b>${m.from_name ? html` &lt;${m.from_email}&gt;` : ''}${m.mailbox ? html` · to ${m.mailbox}` : ''}${m.forwarded_by ? html` · forwarded by ${m.forwarded_by}` : ''}</p>
            <div class="oi-body">${m.body}</div>`)}
          ${when(m.replied_at, () => card('Your reply', html`
            ${replyBanner(ctx, m)}
            ${when(sent, () => html`<p class="oi-from">${sent!.by ? html`<b>${sent!.by}</b> to ` : 'To '}${sent!.to} · ${fmtTs(sent!.at, TZ)}${sent!.subject ? html` · ${sent!.subject}` : ''}</p>
              <div class="oi-body oi-sent">${safeHtml(sent!.body)}</div>`)}`))}
          ${reply}
        </div>
        <div class="oi-side">
          ${identity}
          ${when(c, () => card(c!.unit ? 'Earlier emails from this unit' : `Earlier emails from ${c!.name}`, history.length ? tbl(
            [{ label: 'When' }, { label: 'Subject' }, { label: 'Kind' }, { label: '' }],
            history.map((h) => ({
              cells: [html`<span class="nowrap">${fmtTs(h.received_at, TZ)}</span>`, html`<a href="/one-inbox/m/${h.id}">${h.subject || '(no subject)'}</a>`,
                CAT[h.category as Category], h.status === 'done' ? 'Done' : 'Open'],
            })), { sort: false }) : html`<p class="oi-why">This is the first email on record ${c!.unit ? 'for this unit' : `from ${c!.name}`}.</p>`))}
        </div>
      </div>
      ${KEYS([['j', 'next'], ['k', 'previous'], ['e', 'mark done'], ['r', 'reply'], ...(cands.length ? [['1–9', 'pick a person'] as [string, string]] : [])])}
      ${when(canAct || pos.next, () => html`<div class="oi-bar">${when(canAct, () => doneForm('oi-bar-done'))}${
        when(pos.index >= 0, () => step(pos.next, 'Next', 'rel="next"'))}</div>`)}
    </div>`,
  });
  return compose ? { ...res, status: 422 } : res;
}

function setupPage(rq: Rq): Res {
  const ctx = rq.ctx as Ctx;
  const n = counts(ctx.orgId);
  const live = !!inboundToken();
  const addr = inboxAddress(ctx.orgId);
  const last = lastReceivedAt(ctx.orgId);
  const canAct = can(ctx, 'comms:send');
  const sampleOff = n.contacts > 0 && !n.sample;
  const done = (text: Child): Raw => html`<p class="oi-step-done"><span>Done</span> ${text}</p>`;
  return shell(rq, {
    title: 'One Inbox setup',
    active: '/one-inbox',
    crumbs: [['One Inbox', '/one-inbox']],
    content: html`
      <div class="oi-setup">
        ${card('1. Upload your resident list', html`
          ${when(n.contacts > 0, () => done(html`${plural(n.contacts, 'person', 'people')} on the list${n.sample ? ' (sample)' : ''}. <a href="/one-inbox/people">View people</a>`))}
          <p class="oi-help">An Excel or CSV file with name, email, phone, building and unit. Email is matched against this list. Uploading again replaces it and keeps the addresses staff have taught the system.</p>
          <form method="post" action="/one-inbox/roster" enctype="multipart/form-data">
            ${field('Resident list', raw(`<input type="file" name="roster" id="oi-roster" accept="${ACCEPT}" required />`))}
            <div class="btn-row"><button class="btn" type="submit">Upload list</button>
              <a class="btn btn-ghost" href="/one-inbox/example.csv">Download an example</a></div>
          </form>`)}
        ${card('2. Forward your shared mailbox', html`
          ${when(last, () => done(html`Last email arrived ${when2(last!, new Date())}.`))}
          <p class="oi-help">Your forwarding address</p>
          <p class="oi-addr"><code id="oi-addr">${addr}</code> <button type="button" class="btn btn-sm btn-ghost" data-copy="#oi-addr">Copy</button></p>
          ${live
            ? html`<p class="oi-help">Ask your email administrator to forward a shared mailbox (for example maintenance@) to this address at the company level, not as one person’s rule.${last ? '' : ' No forwarded email has arrived yet.'}</p>`
            : html`<div class="callout warn">Forwarding is not switched on for this StayLeased server yet, so mail sent to this address will not arrive. Until it is, add emails by hand below.</div>`}
          <details class="oi-add"${live ? '' : raw(' open')}><summary>Add an email by hand</summary>
            <form method="post" action="/one-inbox/add">
              <div class="form-grid">
                ${field('From (email)', input('from_email', { type: 'email', required: true }))}
                ${field('From (name)', input('from_name', {}))}
              </div>
              ${field('Subject', input('subject', {}))}
              ${field('Message', textarea('text', { rows: 6, required: true }))}
              <div class="btn-row"><button class="btn btn-ghost" type="submit">Add email</button></div>
            </form></details>`)}
      </div>
      <div class="oi-strip">
        <span>${sampleOff
          ? 'Sample emails are not available once a real resident list is uploaded, so sample people never mix with real ones.'
          : html`<b>Want to see it first?</b> Load ${SAMPLE_MAIL.length} fictional emails and a sample resident list. Clear them any time.`}</span>
        ${when(canAct && !sampleOff, () => html`<form method="post" action="/one-inbox/sample"><button class="btn btn-sm btn-ghost" type="submit">${n.sample ? 'Reload the sample' : 'Try it with sample emails'}</button></form>`)}
      </div>
      ${when(canAct, () => html`<details class="oi-danger"><summary>Delete One Inbox data</summary>
        <p class="oi-help">One Inbox keeps the emails it receives and the list you upload, for this account only. This deletes all of it: ${plural(n.open + n.done, 'email')} and ${plural(n.contacts, 'person', 'people')}. It cannot be undone. The forwarding address stays the same.</p>
        <form method="post" action="/one-inbox/purge">
          <input type="hidden" name="scope" value="all" />
          ${field('Type DELETE to confirm', input('confirm', { placeholder: 'DELETE' }))}
          <div class="btn-row"><button class="btn btn-danger" type="submit">Delete all One Inbox data</button></div>
        </form></details>`)}`,
  });
}

// ---------- people ----------

function personFields(c: Partial<ContactRow>): Raw {
  return html`<div class="form-grid">
      ${field('Name', input('name', { value: c.name || '', required: true }))}
      ${field('Type', select('kind', KIND_OPTIONS, c.kind || 'tenant'))}
      ${field('Building', input('property', { value: c.property || '', list: 'oi-buildings' }))}
      ${field('Unit', input('unit', { value: c.unit || '' }))}
      ${field('Email', input('emails', { value: (c.emails || []).join(', ') }), 'More than one? Separate them with commas.')}
      ${field('Phone', input('phones', { value: (c.phones || []).map(phone).join(', ') }), 'Ten digits each.')}
    </div>`;
}

function personFrom(body: Record<string, any>): RosterRow {
  return {
    name: String(body.name || '').trim().slice(0, 120),
    emails: emailsIn(String(body.emails || '')),
    phones: phonesIn(String(body.phones || '')),
    property: String(body.property || '').trim().slice(0, 120),
    unit: String(body.unit || '').trim().slice(0, 40),
    kind: kindOf(body.kind),
  };
}

function peoplePage(rq: Rq): Res {
  const ctx = rq.ctx as Ctx;
  const all = contacts(ctx.orgId);
  const text = String(rq.query.get('q') || '').trim().slice(0, 120);
  const needle = text.toLowerCase();
  const digits = needle.replace(/\D/g, '');
  const shown = needle
    ? all.filter((c) => [c.name, c.property, c.unit, KIND[c.kind], ...c.emails].some((v) => v.toLowerCase().includes(needle))
      || (digits.length >= 3 && c.phones.some((p) => p.includes(digits))))
    : all;
  const open = openByContact(ctx.orgId);
  const canAct = can(ctx, 'comms:send');
  const buildings = properties(ctx.orgId);
  return shell(rq, {
    title: 'People',
    active: '/one-inbox',
    crumbs: [['One Inbox', '/one-inbox']],
    subtitle: 'Everyone One Inbox can match an email to. Uploading a new resident list replaces the uploaded people and keeps the ones added by hand.',
    actions: html`<a class="btn btn-ghost" href="/one-inbox/setup">Upload a list</a>`,
    content: html`<div data-oi="people">
      <datalist id="oi-buildings">${buildings.map((p) => html`<option value="${p}"></option>`)}</datalist>
      <form class="oi-find" method="get" action="/one-inbox/people" role="search">
        <input type="search" name="q" id="oi-q" value="${text}" placeholder="Search name, building, unit, email or phone" aria-label="Search name, building, unit, email or phone" />
        <button class="btn btn-ghost" type="submit">Search</button>
        ${when(text, () => html`<a class="oi-clear" href="/one-inbox/people">Clear</a>`)}
      </form>
      ${when(text, () => html`<p class="oi-count">${plural(shown.length, 'person', 'people')} of ${all.length} ${shown.length === 1 ? 'matches' : 'match'}.</p>`)}
      ${card(null, all.length ? html`<div class="oi-wide">${tbl(
        [{ label: 'Name' }, { label: 'Type' }, { label: 'Building' }, { label: 'Unit' }, { label: 'Email' }, { label: 'Phone' }, { label: 'Added' }, { label: 'Open emails' }, { label: '' }],
        shown.map((c) => ({
          cells: [
            html`<b>${c.name}</b>`, KIND[c.kind], c.property || '—', c.unit || '—',
            c.emails.length ? html`${c.emails.map((e) => html`<div>${e}</div>`)}` : '—',
            c.phones.length ? html`${c.phones.map((p) => html`<div class="nowrap"><a href="tel:+1${p}">${phone(p)}</a></div>`)}` : '—',
            c.isSample ? 'Sample' : c.source === 'manual' ? 'By staff' : 'Uploaded',
            open.get(c.id) ? html`<a href="/one-inbox?person=${c.id}&view=open">${open.get(c.id)!}</a>` : '0',
            canAct ? html`<a href="/one-inbox/people/${c.id}">Edit</a>` : '',
          ],
        })), { empty: 'Nobody matches that search' })}</div>`
        : emptyState('Nobody on the list yet', 'Upload your resident list, or add people one at a time below.', html`<a class="btn" href="/one-inbox/setup">Upload a list</a>`), { flush: true })}
      ${when(canAct, () => html`<details class="oi-add oi-add-person"${all.length ? '' : raw(' open')}><summary>Add a person</summary>
        <form method="post" action="/one-inbox/people">
          ${personFields({})}
          <div class="btn-row"><button class="btn" type="submit">Add person</button></div>
        </form></details>`)}
    </div>`,
  });
}

function personPage(rq: Rq, c: ContactRow): Res {
  const ctx = rq.ctx as Ctx;
  const filed = q<{ n: number }>('SELECT COUNT(*) AS n FROM oi_messages WHERE org_id=? AND contact_id=?', ctx.orgId, c.id)[0]?.n || 0;
  return shell(rq, {
    title: c.name,
    active: '/one-inbox',
    crumbs: [['One Inbox', '/one-inbox'], ['People', '/one-inbox/people']],
    subtitle: `${KIND[c.kind]}${place(c) ? ` · ${place(c)}` : ''}`,
    content: html`<div class="oi-edit">
      <datalist id="oi-buildings">${properties(ctx.orgId).map((p) => html`<option value="${p}"></option>`)}</datalist>
      ${card('Details', html`
        <form method="post" action="/one-inbox/people/${c.id}">
          ${personFields(c)}
          <div class="btn-row"><button class="btn" type="submit">Save changes</button><a class="btn btn-ghost" href="/one-inbox/people">Cancel</a></div>
        </form>`)}
      <details class="oi-danger"><summary>Remove ${c.name} from the list</summary>
        <p class="oi-help">${filed
          ? `${plural(filed, 'email')} from them ${filed === 1 ? 'is' : 'are'} kept and ${filed === 1 ? 'goes' : 'go'} back to “Who is this?”.`
          : 'No emails are filed to them.'} Email from their addresses will stop being matched to them.</p>
        <form method="post" action="/one-inbox/people/${c.id}/remove"><button class="btn btn-danger" type="submit">Remove from the list</button></form>
      </details>
    </div>`,
  });
}

const EXAMPLE_CSV = [
  'Name,Email,Phone,Building,Unit,Type',
  'Denise Harper,denise.harper@example.com,(202) 555-0101,Oakwood Terrace,1,Resident',
  'Marcus Bell,mbell@example.com; marcus.bell@work.example.com,202-555-0102,Oakwood Terrace,2,Resident',
  'P. Okafor,p.okafor@housing-partners.example.org,202-555-0150,Oakwood Terrace,3,Case worker',
  'Eastgate Holdings LLC,owner@eastgate-holdings.example.com,202-555-0160,Hillcrest Four,,Owner',
  '',
].join('\r\n');

export function routes(r: Router): void {
  const view = requirePerm('comms:view');
  const act = requirePerm('comms:send');

  r.get('/one-inbox', view, (rq) => listPage(rq));
  r.get('/one-inbox/setup', view, (rq) => setupPage(rq));
  r.get('/one-inbox/example.csv', view, () => fileRes(EXAMPLE_CSV, 'text/csv; charset=utf-8', { filename: 'one-inbox-resident-list-example.csv' }));

  r.get('/one-inbox/m/:id', view, (rq) => {
    const m = message((rq.ctx as Ctx).orgId, rq.params.id!);
    return m ? messagePage(rq, m, fromQuery(rq)) : notFound();
  });

  // ---- people ----
  r.get('/one-inbox/people', view, (rq) => peoplePage(rq));
  r.get('/one-inbox/people/:id', act, (rq) => {
    const c = contact((rq.ctx as Ctx).orgId, rq.params.id!);
    return c ? personPage(rq, c) : notFound();
  });
  r.post('/one-inbox/people', act, (rq) => {
    const row = personFrom(rq.body);
    if (!row.name) return redirect('/one-inbox/people', 'A name is needed.', 'err');
    addContact(rq.ctx as Ctx, row);
    return redirect('/one-inbox/people', `${row.name} added.`);
  });
  r.post('/one-inbox/people/:id', act, (rq) => {
    const ctx = rq.ctx as Ctx;
    if (!contact(ctx.orgId, rq.params.id!)) return notFound();
    const row = personFrom(rq.body);
    if (!row.name) return redirect(`/one-inbox/people/${rq.params.id}`, 'A name is needed.', 'err');
    updateContact(ctx, rq.params.id!, row);
    return redirect('/one-inbox/people', `${row.name} saved.`);
  });
  r.post('/one-inbox/people/:id/remove', act, (rq) => {
    const res = removeContact(rq.ctx as Ctx, rq.params.id!);
    if (!res) return notFound();
    return redirect('/one-inbox/people', `${res.name} removed.${res.unfiled ? ` ${plural(res.unfiled, 'email')} went back to “Who is this?”.` : ''}`);
  });

  // ---- setup ----
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
    }, { via: 'manual', receivedAt: orgNow(ctx).toISOString() });
    return redirect(`/one-inbox/m/${res.id}`, res.duplicate ? 'That email was already here.' : undefined);
  });

  r.post('/one-inbox/sample', act, (rq) => {
    const ctx = rq.ctx as Ctx;
    const n = counts(ctx.orgId);
    if (n.contacts && !n.sample) return redirect('/one-inbox/setup', 'The sample is not loaded once a real resident list exists.', 'err');
    if (n.sample) purge(ctx, 'sample');
    replaceRoster(ctx, SAMPLE_ROSTER, { sample: true });
    // dated on the organization's own clock, so "20 min ago" is true on the
    // day the demo says it is
    const now = orgNow(ctx).getTime();
    for (const s of SAMPLE_MAIL) {
      ingest(ctx.orgId, s.mail, { via: 'sample', receivedAt: new Date(now - s.minutesAgo * 60_000).toISOString() });
    }
    return redirect('/one-inbox', 'Sample loaded: fictional people and emails.');
  });

  r.post('/one-inbox/purge', act, (rq) => {
    const ctx = rq.ctx as Ctx;
    const scope = rq.body.scope === 'all' ? 'all' : 'sample';
    if (scope === 'all' && String(rq.body.confirm || '').trim() !== 'DELETE') {
      return redirect('/one-inbox/setup', 'Type DELETE to confirm deleting all One Inbox data.', 'err');
    }
    const res = purge(ctx, scope);
    return redirect(scope === 'all' ? '/one-inbox/setup' : '/one-inbox',
      `Deleted ${plural(res.messages, 'email')} and ${plural(res.contacts, 'person', 'people')}.`);
  });

  r.post('/one-inbox/quiet', view, (rq) => {
    rq.setCookies.push(cookie('oi_quiet', new Date().toISOString().slice(0, 10), { maxAge: 86_400, path: '/one-inbox' }));
    return redirect(listUrl(fromBody(rq)));
  });

  // ---- acting on one email ----

  /** After saying who an email is from: in "Who is this?" the next unknown
   * sender comes up; anywhere else the person stays on the email to answer it. */
  const afterFiling = (rq: Rq, mid: string, next: string | null, learned: boolean): Res => {
    const f = fromBody(rq);
    const extra = { did: 'filed', was: mid, learned: learned ? '1' : undefined };
    if (f.view !== 'needs_filing') return redirect(msgUrl(mid, f, extra));
    return redirect(next ? msgUrl(next, f, extra) : listUrl(f, extra));
  };

  r.post('/one-inbox/m/:id/file', act, (rq) => {
    const ctx = rq.ctx as Ctx;
    const m = message(ctx.orgId, rq.params.id!);
    if (!m) return notFound();
    const f = fromBody(rq);
    let cid = String(rq.body.contact_id || '');
    const typed = String(rq.body.contact_label || '').trim();
    if (!cid && typed) {
      const all = contacts(ctx.orgId);
      const names = labels(all);
      const exact = all.filter((c) => names.get(c.id)!.toLowerCase() === typed.toLowerCase());
      const loose = exact.length ? exact : all.filter((c) => names.get(c.id)!.toLowerCase().includes(typed.toLowerCase()));
      if (loose.length !== 1) {
        return redirect(msgUrl(m.id, f), loose.length
          ? `${loose.length} people match “${typed}”. Pick one from the list as you type.`
          : `Nobody on the list matches “${typed}”. Pick a person from the list, or add them.`, 'err');
      }
      cid = loose[0]!.id;
    }
    const c = cid ? contact(ctx.orgId, cid) : null;
    if (!c) return typed || !cid ? redirect(msgUrl(m.id, f), 'Choose a person first.', 'err') : notFound();
    const remember = !!rq.body.remember;
    const learned = remember && !!m.from_email && !c.emails.includes(m.from_email);
    const next = nextInView(ctx.orgId, f, m.id);
    return fileTo(ctx, m.id, c.id, remember) ? afterFiling(rq, m.id, next, learned) : notFound();
  });

  r.post('/one-inbox/m/:id/unfile', act, (rq) =>
    unfile(rq.ctx as Ctx, rq.params.id!, { forget: rq.body.forget === '1' })
      ? redirect(msgUrl(rq.params.id!, fromBody(rq)), 'Moved back to “Who is this?”.') : notFound());

  r.post('/one-inbox/m/:id/add-contact', act, (rq) => {
    const ctx = rq.ctx as Ctx;
    const m = message(ctx.orgId, rq.params.id!);
    if (!m) return notFound();
    const f = fromBody(rq);
    const name = String(rq.body.name || '').trim().slice(0, 120);
    if (!name) return redirect(msgUrl(m.id, f), 'A name is needed.', 'err');
    const cid = addContact(ctx, {
      name, emails: [m.from_email], phones: phonesIn(m.body).slice(0, 1),
      property: String(rq.body.property || '').trim().slice(0, 120), unit: String(rq.body.unit || '').trim().slice(0, 40), kind: kindOf(rq.body.kind),
    });
    const next = nextInView(ctx.orgId, f, m.id);
    fileTo(ctx, m.id, cid, true);
    return afterFiling(rq, m.id, next, false);
  });

  /** Mark done and move on: the next email in the same view, or the list when
   * that was the last one. Either way the page it lands on offers Undo. */
  const finish = (rq: Rq, mid: string, flash?: string): Res => {
    const ctx = rq.ctx as Ctx;
    const f = fromBody(rq);
    const next = nextInView(ctx.orgId, f, mid);
    if (!setDone(ctx, mid, true)) return notFound();
    const extra = { did: 'done', was: mid };
    return redirect(next ? msgUrl(next, f, extra) : listUrl(f, extra), flash);
  };

  r.post('/one-inbox/m/:id/reply', act, (rq) => {
    const ctx = rq.ctx as Ctx;
    const mid = rq.params.id!;
    const typed = { subject: String(rq.body.subject || ''), text: String(rq.body.text || '') };
    const res = sendReply(ctx, mid, typed);
    if (!res.ok) {
      // never lose what was typed: the same page again, with the text in it
      const m = message(ctx.orgId, mid);
      return m ? messagePage(rq, m, fromBody(rq), { ...typed, error: res.error }) : notFound();
    }
    const flash = `Reply written. ${deliveryNote(ctx, 'email')}.`;
    return rq.body.after === 'done' ? finish(rq, mid, flash) : redirect(msgUrl(mid, fromBody(rq)), flash);
  });

  r.post('/one-inbox/m/:id/done', act, (rq) => finish(rq, rq.params.id!));
  r.post('/one-inbox/m/:id/reopen', act, (rq) =>
    setDone(rq.ctx as Ctx, rq.params.id!, false) ? redirect(msgUrl(rq.params.id!, fromBody(rq)), 'Reopened.') : notFound());
}
