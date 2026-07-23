import { readFileSync } from 'node:fs';
import { join as pjoin } from 'node:path';
import { createHash } from 'node:crypto';
import { html, raw, esc, join, when, type Raw, type Child } from '../lib/html.ts';
import { htmlRes, takeFlash, type Rq, type Res } from '../lib/http.ts';
import { can, type Ctx } from '../lib/auth.ts';
import { q, ROOT } from '../lib/db.ts';
import { fmtDate } from '../lib/dates.ts';

/** Content-hash version for static assets. Assets are served with
 * cache-control max-age=3600; without a version in the URL, a deploy can pair
 * fresh HTML with an hour-stale cached theme.css/app.js (which looks like a
 * broken site — dead menus, unstyled chrome). Hashing at module load keeps
 * URLs stable within a deploy and busts caches exactly when contents change. */
const ASSET_V: string = (() => {
  try {
    const h = createHash('sha1');
    for (const f of ['src/ui/theme.css', 'src/ui/app.js']) h.update(readFileSync(pjoin(ROOT, f)));
    return h.digest('hex').slice(0, 8);
  } catch {
    return 'dev';
  }
})();

/** StayLeased UI kit: app shell, portal shell, and shared components.
 * Modules contribute nav items and search providers via registries so the
 * chrome grows as modules mount. */

// ---------- brand ----------

/** The StayLeased mark: a keyed doorway — home + access, the essence of
 * leasing. Stroke-based so it inherits color; scales cleanly to a favicon. */
export function logo(size = 22, color = 'currentColor'): Raw {
  return raw(
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V9.5a7 7 0 0 1 14 0V21"/><path d="M3.5 21h17"/><circle cx="12" cy="12" r="1.6"/><path d="M12 13.6V17"/></svg>`,
  );
}

/** Two-tone StayLeased wordmark (mark + name). onDark tints the mark + accent
 * for placement on the dark chrome; otherwise it uses the brand accent token. */
export function wordmark(size = 22, onDark = false): Raw {
  return html`<span class="wordmark ${onDark ? 'on-dark' : ''}">${logo(size, onDark ? '#7aa8ff' : 'var(--brand)')}<span class="wm-text">Stay<span class="wm-accent">Leased</span></span></span>`;
}

// ---------- nav registry ----------

export interface NavItem {
  href: string;
  label: string;
  perm?: string;
  /** also mark active for these prefixes */
  match?: string[];
  /** demo-world tooling (simulator etc.) — hidden inside live customer orgs */
  demoOnly?: boolean;
}
const SECTION_ORDER = [
  '',
  'Leasing',
  'Residents',
  'Operations',
  'Money',
  'Property',
  'Marketing',
  'Communications',
  'Intelligence',
  'Admin',
  'Developer',
];
const navSections = new Map<string, NavItem[]>();

export function registerNav(section: string, item: NavItem): void {
  const list = navSections.get(section) || [];
  if (!list.some((i) => i.href === item.href)) list.push(item);
  navSections.set(section, list);
}

// ---------- top module bar (Entrata-style) ----------
// The desktop chrome is a top module bar with dropdowns; the sidebar becomes a
// mobile-only drawer. Tabs group the same nav items modules already register,
// so nothing downstream changes. A gear → /setup holds administration.
const TAB_ORDER = ['Dashboard', 'Leasing', 'Residents', 'Financials', 'Property', 'Operations', 'Marketing', 'Messages', 'Reports'];
const SECTION_TO_TAB: Record<string, string> = {
  '': 'Dashboard', Leasing: 'Leasing', Residents: 'Residents', Money: 'Financials',
  Property: 'Property', Operations: 'Operations', Marketing: 'Marketing',
  Intelligence: 'Reports', Admin: 'Setup', Developer: 'Setup',
};
const HREF_TO_TAB: Record<string, string> = { '/inbox': 'Messages', '/comms': 'Messages' };

function tabItems(ctx: Ctx): Map<string, NavItem[]> {
  const out = new Map<string, NavItem[]>();
  for (const [sec, items] of navSections) {
    for (const it of items) {
      if (it.perm && !can(ctx, it.perm)) continue;
      if (it.demoOnly && ctx.orgKind === 'live') continue;
      const tab = HREF_TO_TAB[it.href] || SECTION_TO_TAB[sec] || 'Reports';
      const list = out.get(tab) || [];
      list.push(it);
      out.set(tab, list);
    }
  }
  return out;
}

function itemActive(active: string, i: NavItem): boolean {
  return active === i.href || (i.match || []).some((m) => active.startsWith(m));
}

const CARET = raw('<svg class="caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>');
const GEAR = raw('<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>');

const TI = (d: string): Raw => raw(`<svg class="ticon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`);
const TAB_ICONS: Record<string, Raw> = {
  Dashboard: TI('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
  Leasing: TI('<circle cx="8" cy="9" r="4"/><path d="M12 12l8 8m-3-3 2-2m-5-1 2-2"/>'),
  Residents: TI('<circle cx="9" cy="8" r="3.5"/><path d="M3.5 20c.6-3.4 2.8-5 5.5-5s4.9 1.6 5.5 5"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.6c2.4.2 4.3 1.6 5 4.4"/>'),
  Financials: TI('<circle cx="12" cy="12" r="9"/><path d="M15 8.5c-.6-1-1.7-1.5-3-1.5-1.8 0-3 1-3 2.3 0 3.4 6.2 1.6 6.2 4.9 0 1.4-1.4 2.3-3.2 2.3-1.5 0-2.7-.6-3.3-1.7M12 5.5v13"/>'),
  Property: TI('<path d="M4 21V5.5L12 3l8 2.5V21"/><path d="M2.5 21h19M9 8h1.5M13.5 8H15M9 12h1.5M13.5 12H15M9 16h1.5M13.5 16H15"/>'),
  Operations: TI('<path d="M14.7 6.3a4.5 4.5 0 0 0-6 6L3 18l3 3 5.7-5.7a4.5 4.5 0 0 0 6-6L14 13l-3-3 3.7-3.7z"/>'),
  Marketing: TI('<path d="M3 11v3l12 4V6L3 10z"/><path d="M15 8.5a3.5 3.5 0 0 1 0 7M7 14.5V20h3v-4.5"/>'),
  Messages: TI('<path d="M21 14a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  Reports: TI('<path d="M3 21h18M6 21V12m5 9V7m5 14v-6m5 6V4"/>'),
};

function moduleBar(ctx: Ctx, active: string): Raw {
  const tabs = tabItems(ctx);
  return html`<nav class="modulebar" aria-label="Modules">${join(TAB_ORDER.map((label, idx) => {
    if (label === 'Dashboard') {
      return html`<a class="mtab-btn ${active === '/' ? 'active' : ''}" href="/">${TAB_ICONS.Dashboard}Dashboard</a>`;
    }
    const items = tabs.get(label) || [];
    if (!items.length) return null;
    const act = items.some((i) => itemActive(active, i));
    return html`<div class="mtab ${act ? 'active' : ''}">
      <button class="mtab-btn" data-toggle="#mt-${idx}" aria-haspopup="true">${TAB_ICONS[label]}${label}${CARET}</button>
      <div class="menu mmenu" id="mt-${idx}">
        ${items.map((i) => html`<a href="${i.href}" class="${itemActive(active, i) ? 'active' : ''}">${i.label}</a>`)}
      </div>
    </div>`;
  }))}</nav>`;
}

/** Entrata-style white second-row sub-nav: when the current page belongs to a
 * module tab, its sibling pages render as a horizontal row under the red bar
 * (the dropdowns remain for cross-module jumps). Dashboard and unmapped pages
 * (e.g. /setup) render no sub-nav. */
function subNav(ctx: Ctx, active: string): Raw {
  const tabs = tabItems(ctx);
  for (const label of TAB_ORDER) {
    if (label === 'Dashboard') continue;
    const items = tabs.get(label) || [];
    if (items.length && items.some((i) => itemActive(active, i))) {
      return html`<nav class="subnav" aria-label="${label} pages">
        ${items.map((i) => html`<a href="${i.href}" class="${itemActive(active, i) ? 'active' : ''}">${i.label}</a>`)}
      </nav>`;
    }
  }
  return html``;
}

function setupMenu(ctx: Ctx, active: string): Raw {
  const setup = tabItems(ctx).get('Setup') || [];
  if (!setup.length && !can(ctx, 'properties:manage')) return html``;
  return html`<div class="usermenu">
    <button class="icon-btn ${active.startsWith('/setup') ? 'active' : ''}" data-toggle="#setup-pop" aria-label="Setup and administration" title="Setup &amp; administration">${GEAR}</button>
    <div class="menu" id="setup-pop">
      <div class="menu-head">Setup &amp; administration</div>
      <a href="/setup" class="${active === '/setup' ? 'active' : ''}">Setup hub</a>
      ${when(can(ctx, 'properties:manage'), () => html`<a href="/setup/wizard" class="${active === '/setup/wizard' ? 'active' : ''}">Add a property (wizard)</a>`)}
      ${when(can(ctx, 'properties:manage'), () => html`<a href="/setup/import" class="${active.startsWith('/setup/import') ? 'active' : ''}">Migration Center (CSV import)</a>`)}
      ${when(setup.length, () => html`<hr />${setup.map((i) => html`<a href="${i.href}" class="${itemActive(active, i) ? 'active' : ''}">${i.label}</a>`)}`)}
    </div>
  </div>`;
}

// ---------- search registry (⌘K) ----------

export interface SearchHit {
  kind: string;
  label: string;
  sub?: string;
  href: string;
}
type SearchProvider = (ctx: Ctx, query: string) => SearchHit[];
const searchProviders: SearchProvider[] = [];
export function registerSearch(fn: SearchProvider): void {
  searchProviders.push(fn);
}
export function runSearch(ctx: Ctx, query: string): SearchHit[] {
  const out: SearchHit[] = [];
  for (const fn of searchProviders) {
    try {
      out.push(...fn(ctx, query));
    } catch {
      /* provider failure never breaks search */
    }
    if (out.length > 40) break;
  }
  return out.slice(0, 40);
}

// ---------- shells ----------

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0] || '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export interface ShellOpts {
  title: string;
  active: string; // href of active nav item
  content: Child;
  actions?: Child;
  crumbs?: [string, string?][];
  subtitle?: Child;
  wide?: boolean;
}

export function shell(r: Rq, opts: ShellOpts): Res {
  const ctx = r.ctx as Ctx;
  const flash = takeFlash(r);
  const props = ctx.orgId
    ? q<{ id: string; name: string }>(
        ctx.allProperties
          ? 'SELECT id, name FROM properties WHERE org_id=? ORDER BY name'
          : `SELECT id, name FROM properties WHERE org_id=? AND id IN (${ctx.propertyIds.map(() => '?').join(',') || "''"}) ORDER BY name`,
        ...(ctx.allProperties ? [ctx.orgId] : [ctx.orgId, ...ctx.propertyIds]),
      )
    : [];
  const orgName = ctx.orgId
    ? (q<{ name: string }>('SELECT name FROM orgs WHERE id=?', ctx.orgId)[0]?.name ?? '')
    : 'Platform';

  const nav = join(
    SECTION_ORDER.filter((s) => navSections.has(s)).map((sec) => {
      const items = (navSections.get(sec) || []).filter((i) => (!i.perm || can(ctx, i.perm)) && !(i.demoOnly && ctx.orgKind === 'live'));
      if (!items.length) return null;
      return html`<div class="nav-group">
        ${sec ? html`<div class="nav-head">${sec}</div>` : null}
        ${items.map((i) => {
          const active =
            opts.active === i.href || (i.match || []).some((m) => opts.active.startsWith(m));
          return html`<a href="${i.href}" class="${active ? 'active' : ''}"><span class="dot"></span>${i.label}</a>`;
        })}
      </div>`;
    }),
  );

  const propSwitch = when(props.length > 0, () => html`<form method="post" action="/switch-property" class="prop-switch" data-autosubmit>
    <select name="property_id" aria-label="Property context">
      <option value="all" ${!ctx.currentPropertyId ? 'selected' : ''}>All properties</option>
      ${props.map((p) => html`<option value="${p.id}" ${ctx.currentPropertyId === p.id ? 'selected' : ''}>${p.name}</option>`)}
    </select>
  </form>`);

  const body = html`<div class="app">
    <header class="topchrome">
      <div class="brandbar">
        <button class="menu-btn" data-toggle="#sidebar" aria-label="Menu">${raw('<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg>')}</button>
        <a class="brand brand-top" href="/">${logo(22, 'var(--brand)')} <span class="brand-name">Stay<span class="wm-accent">Leased</span></span></a>
        ${when(orgName && orgName !== 'Platform', () => html`<span class="org-chip" title="Your organization">${orgName}</span>`)}
        ${when(ctx.orgKind === 'demo' && ctx.kind === 'staff', () => html`<span class="demo-pill" title="This is the shared demo world — simulated rails, demo data. Real customer companies run in live mode with real books.">DEMO</span>`)}
        <div class="spacer"></div>
        ${propSwitch}
        <button class="searchbtn" data-palette-open type="button"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><span class="stext">Search…</span><kbd>⌘K</kbd></button>
        ${when(can(ctx, 'ai:view'), () => html`<a class="askbtn" href="/ask" title="Ask StayLeased — questions over your own data">✨<span class="stext">Ask StayLeased</span></a>`)}
        <a class="bizdate" href="/dev/sim" title="Simulated business date — open Simulator Console"><span class="bd-label">Business date</span> ${fmtDate(ctx.businessDate)}</a>
        ${setupMenu(ctx, opts.active)}
        <div class="usermenu">
          <button class="avatar" data-toggle="#usermenu-pop" aria-label="Account menu">${initials(ctx.userName)}</button>
          <div class="menu" id="usermenu-pop">
            <div class="menu-head">${ctx.userName}<br /><span class="muted">${ctx.userEmail}</span></div>
            <hr />
            ${when(can(ctx, 'admin:settings'), () => html`<a href="/admin/settings">Org settings</a>`)}
            <a href="/me">My profile</a>
            <form method="post" action="/logout"><button type="submit">Sign out</button></form>
          </div>
        </div>
      </div>
      ${moduleBar(ctx, opts.active)}
      ${subNav(ctx, opts.active)}
    </header>
    ${when(ctx.impersonatorId, () => html`<div class="impersonation">You are viewing StayLeased as <b>${ctx.userName}</b> (impersonation is audited). <a href="/unimpersonate">Return to my account</a></div>`)}
    <div class="main">
      <main class="content ${opts.wide ? 'wide' : ''}">
        ${when(flash, () => html`<div class="flash ${flash![0]}">${flash![1]}</div>`)}
        <div class="page-head">
          <div class="titles">
            ${when(opts.crumbs?.length, () => html`<div class="crumbs">${join((opts.crumbs || []).map(([label, href]) => (href ? html`<a href="${href}">${label}</a>` : html`<span>${label}</span>`)), raw(' / ').s)}</div>`)}
            <h1>${opts.title}</h1>
            ${when(opts.subtitle, () => html`<div class="subtitle">${opts.subtitle}</div>`)}
          </div>
          ${when(opts.actions, () => html`<div class="actions">${opts.actions}</div>`)}
        </div>
        ${opts.content}
      </main>
    </div>
    <aside class="sidebar drawer" id="sidebar">
      <div class="brand">${logo(22, 'var(--brand)')} <span class="brand-name">Stay<span class="wm-accent">Leased</span><span class="org">${orgName}</span></span></div>
      <nav class="nav">${nav}</nav>
    </aside>
  </div>
  <div class="palette-back" id="palette">
    <div class="palette" role="dialog" aria-label="Global search">
      <input type="search" placeholder="Search residents, units, leads, vendors, invoices…" id="palette-input" autocomplete="off" />
      <div class="results" id="palette-results"><div class="hintbar">Type at least 2 characters</div></div>
      <div class="hintbar">↑↓ navigate · Enter open · Esc close</div>
    </div>
  </div>`;

  return htmlRes(doc(opts.title, body));
}

export function doc(title: string, body: Child, extraHead: Child = null): string {
  return (
    '<!doctype html>' +
    html`<html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} · StayLeased</title>
        <link rel="stylesheet" href="/assets/theme.css?v=${ASSET_V}" />
        <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
        ${extraHead}
      </head>
      <body>
        ${body}
        <script src="/assets/app.js?v=${ASSET_V}" defer></script>
      </body>
    </html>`.s
  );
}

export function authShell(title: string, content: Child): Res {
  return htmlRes(
    doc(
      title,
      html`<div class="auth-wrap"><div class="auth-card">${content}</div></div>`,
    ),
  );
}

// ---------- components ----------

export function card(title: Child, body: Child, opts?: { actions?: Child; flush?: boolean }): Raw {
  return html`<div class="card">
    ${when(title, () => html`<div class="card-head"><h2>${title}</h2>${opts?.actions}</div>`)}
    <div class="card-body ${opts?.flush ? 'flush' : ''}">${body}</div>
  </div>`;
}

export interface Kpi {
  label: string;
  value: Child;
  sub?: Child;
  tone?: 'ok' | 'warn' | 'bad' | 'accent';
  href?: string;
}
export function kpis(items: Kpi[]): Raw {
  return html`<div class="kpis">${items.map((k) => {
    const inner = html`<div class="k-label">${k.label}</div>
      <div class="k-value">${k.value}</div>
      ${when(k.sub, () => html`<div class="k-sub">${k.sub}</div>`)}`;
    return k.href
      ? html`<a class="kpi tone-${k.tone || 'none'}" href="${k.href}">${inner}</a>`
      : html`<div class="kpi tone-${k.tone || 'none'}">${inner}</div>`;
  })}</div>`;
}

export interface Col {
  label: Child;
  num?: boolean;
  w?: string;
}
export interface TblRow {
  cells: Child[];
  href?: string;
}
export function tbl(cols: Col[], rows: TblRow[], opts?: { empty?: string; foot?: Child[] }): Raw {
  if (!rows.length) {
    return html`<div class="empty"><div class="e-title">${opts?.empty || 'Nothing here yet'}</div></div>`;
  }
  return html`<div class="tbl-wrap"><table class="tbl">
    <thead><tr>${cols.map((c) => html`<th class="${c.num ? 'num' : ''}" ${c.w ? raw(`style="width:${c.w}"`) : ''}>${c.label}</th>`)}</tr></thead>
    <tbody>${rows.map(
      (row) =>
        html`<tr ${row.href ? raw(`data-href="${esc(row.href)}" tabindex="0"`) : ''}>${row.cells.map((cell, i) => html`<td class="${cols[i]?.num ? 'num' : ''}">${cell}</td>`)}</tr>`,
    )}</tbody>
    ${when(opts?.foot, () => html`<tfoot><tr>${(opts!.foot || []).map((cell, i) => html`<td class="${cols[i]?.num ? 'num' : ''}">${cell}</td>`)}</tr></tfoot>`)}
  </table></div>`;
}

export function pager(r: Rq, total: number, perPage = 50): Raw {
  const page = Math.max(1, parseInt(r.query.get('page') || '1', 10) || 1);
  const pages = Math.max(1, Math.ceil(total / perPage));
  if (pages <= 1) return html`<div class="pager">${total} record${total === 1 ? '' : 's'}</div>`;
  const link = (p: number): string => {
    const sp = new URLSearchParams(r.query);
    sp.set('page', String(p));
    return `${r.path}?${sp}`;
  };
  const nums: Child[] = [];
  const window = [1, page - 1, page, page + 1, pages].filter((p, i, a) => p >= 1 && p <= pages && a.indexOf(p) === i).sort((a, b) => a - b);
  let prev = 0;
  for (const p of window) {
    if (prev && p - prev > 1) nums.push(html`<span>…</span>`);
    nums.push(p === page ? html`<span class="cur">${p}</span>` : html`<a href="${link(p)}">${p}</a>`);
    prev = p;
  }
  return html`<div class="pager">${total} records · page ${nums} ${page < pages ? html`<a href="${link(page + 1)}">Next →</a>` : null}</div>`;
}

const STATUS_TONE: Record<string, string> = {
  // generic
  active: 'ok', ok: 'ok', paid: 'ok', settled: 'ok', completed: 'ok', complete: 'ok', approved: 'ok', signed: 'ok', executed: 'ok', fully_executed: 'ok', current: 'ok', covered: 'ok', reconciled: 'ok', ready: 'ok', published: 'ok', accepted: 'ok', open: 'info', matched: 'ok', received: 'ok', verified: 'ok', enrolled: 'ok', passed: 'ok', on: 'ok', yes: 'ok', posted: 'ok', acknowledged: 'ok',
  pending: 'warn', in_progress: 'info', scheduled: 'info', draft: '', submitted: 'info', screening: 'info', processing: 'info', partially_signed: 'warn', notice: 'warn', review: 'warn', conditional: 'warn', lapsing: 'warn', exception: 'warn', retrying: 'warn', hold: 'warn', waitlist: 'warn', partial: 'warn', 'approve-with-conditions': 'warn', month_to_month: 'warn', proposed: 'info', offered: 'info', quoted: 'info', toured: 'info', applied: 'violet', new: 'accent', assigned: 'info', dispatched: 'info', in_transit: 'info',
  failed: 'bad', nsf: 'bad', declined: 'bad', denied: 'bad', overdue: 'bad', lapsed: 'bad', delinquent: 'bad', canceled: 'bad', cancelled: 'bad', void: 'bad', evicted: 'bad', emergency: 'bad', down: 'bad', blocked: 'bad', error: 'bad', chargeback: 'bad', off: '', no: '', ended: '', closed: '', inactive: '', lost: '', expired: 'bad', missed: 'bad', reopened: 'warn',
  vacant_ready: 'ok', vacant_not_ready: 'warn', occupied: 'info', model: 'violet', urgent: 'bad', high: 'warn', normal: 'info', low: '',
};
export function statusBadge(status: string | null | undefined, label?: string): Raw {
  const s = String(status ?? '—');
  const tone = STATUS_TONE[s] ?? '';
  return html`<span class="badge ${tone}">${(label ?? s).replaceAll('_', ' ')}</span>`;
}

export function dl(pairs: [Child, Child][]): Raw {
  return html`<dl class="dl">${pairs.map(([k, v]) => html`<dt>${k}</dt><dd>${v ?? '—'}</dd>`)}</dl>`;
}

export function tabs(items: { href: string; label: Child; active?: boolean; count?: number }[]): Raw {
  return html`<div class="tabs">${items.map(
    (t) => html`<a href="${t.href}" class="${t.active ? 'active' : ''}">${t.label}${t.count !== undefined ? html` <span class="badge">${t.count}</span>` : null}</a>`,
  )}</div>`;
}

export function emptyState(title: string, hint?: Child, cta?: Child): Raw {
  return html`<div class="empty"><div class="e-title">${title}</div>${when(hint, () => html`<div>${hint}</div>`)}${when(cta, () => html`<div style="margin-top:10px">${cta}</div>`)}</div>`;
}

// ---------- form helpers ----------

export function field(label: Child, control: Child, hint?: Child): Raw {
  return html`<div class="field"><label>${label}</label>${control}${when(hint, () => html`<div class="hint">${hint}</div>`)}</div>`;
}
export function input(name: string, opts: { value?: Child; type?: string; placeholder?: string; required?: boolean; step?: string; min?: string; max?: string; list?: string; autofocus?: boolean } = {}): Raw {
  return html`<input name="${name}" type="${opts.type || 'text'}" value="${opts.value ?? ''}" placeholder="${opts.placeholder ?? ''}" ${opts.required ? 'required' : ''} ${opts.step ? raw(`step="${esc(opts.step)}"`) : ''} ${opts.min ? raw(`min="${esc(opts.min)}"`) : ''} ${opts.max ? raw(`max="${esc(opts.max)}"`) : ''} ${opts.list ? raw(`list="${esc(opts.list)}"`) : ''} ${opts.autofocus ? 'autofocus' : ''} />`;
}
export function select(name: string, options: [string, Child][], value?: string | null, opts: { required?: boolean; blank?: string } = {}): Raw {
  return html`<select name="${name}" ${opts.required ? 'required' : ''}>
    ${opts.blank !== undefined ? html`<option value="">${opts.blank}</option>` : null}
    ${options.map(([v, label]) => html`<option value="${v}" ${value === v ? 'selected' : ''}>${label}</option>`)}
  </select>`;
}
export function textarea(name: string, opts: { value?: string; placeholder?: string; required?: boolean; rows?: number } = {}): Raw {
  return html`<textarea name="${name}" placeholder="${opts.placeholder ?? ''}" ${opts.required ? 'required' : ''} rows="${opts.rows || 4}">${opts.value ?? ''}</textarea>`;
}
export function checkbox(name: string, label: Child, checked?: boolean, value = '1'): Raw {
  return html`<label class="check"><input type="checkbox" name="${name}" value="${value}" ${checked ? 'checked' : ''} /> <span>${label}</span></label>`;
}
export function moneyInput(name: string, cents?: number | null, opts: { required?: boolean; placeholder?: string } = {}): Raw {
  const val = cents === undefined || cents === null ? '' : (cents / 100).toFixed(2);
  return html`<input name="${name}" type="text" inputmode="decimal" value="${val}" placeholder="${opts.placeholder ?? '0.00'}" ${opts.required ? 'required' : ''} />`;
}

// ---------- history (audit) panel ----------

export function historyPanel(orgId: string, entity: string, entityId: string): Raw {
  const rows = q<any>(
    'SELECT * FROM audit_events WHERE org_id=? AND entity=? AND entity_id=? ORDER BY at DESC LIMIT 100',
    orgId,
    entity,
    entityId,
  );
  if (!rows.length) return emptyState('No history yet', 'Changes to this record will appear here.');
  return html`<ul class="timeline">${rows.map((a) => {
    let changes: Raw | null = null;
    if (a.changes) {
      try {
        const diff = JSON.parse(a.changes) as Record<string, { from: unknown; to: unknown }>;
        changes = html`<div class="small muted">${join(
          Object.entries(diff).slice(0, 8).map(([k, d]) => html`<div><b>${k}</b>: ${fmtVal(d.from)} → ${fmtVal(d.to)}</div>`),
        )}</div>`;
      } catch {
        /* ignore */
      }
    }
    return html`<li><div><b>${a.action.replaceAll('_', ' ')}</b> <span class="muted">by ${a.user_name || a.user_id}</span></div><div class="t-when">${a.at.slice(0, 16).replace('T', ' ')}</div>${changes}</li>`;
  })}</ul>`;
}
function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 60 ? s.slice(0, 60) + '…' : s;
}

// ---------- resident portal shell (mobile-first) ----------

export interface PortalNavItem {
  href: string;
  label: string;
  icon: string; // inline svg path d=
}
const PORTAL_NAV: PortalNavItem[] = [
  { href: '/portal', label: 'Home', icon: 'M3 10.5 12 3l9 7.5M5.5 9v11h13V9' },
  { href: '/portal/pay', label: 'Pay', icon: 'M3 7h18v11H3zM3 10h18M7 14h4' },
  { href: '/portal/requests', label: 'Requests', icon: 'M14 3l7 7-9.5 9.5H4V12z M4 21h16' },
  { href: '/portal/lease', label: 'Lease', icon: 'M6 3h9l4 4v14H6zM14 3v5h5M9 12h6M9 16h6' },
];
export function addPortalNav(item: PortalNavItem): void {
  if (!PORTAL_NAV.some((x) => x.href === item.href)) PORTAL_NAV.push(item);
}

export function portalShell(
  r: Rq,
  opts: { title: string; active: string; content: Child; propertyName?: string; back?: string },
): Res {
  const flash = takeFlash(r);
  const nav = PORTAL_NAV.map(
    (n) => html`<a href="${n.href}" class="${opts.active === n.href || (n.href !== '/portal' && opts.active.startsWith(n.href)) ? 'active' : ''}">
      ${raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${n.icon}"/></svg>`)}
      ${n.label}</a>`,
  );
  const body = html`<div class="portal">
    <div class="portal-top">
      <div class="pt-brand">${logo(20, 'var(--accent)')} ${opts.propertyName || 'StayLeased'}</div>
      <div class="spacer"></div>
      <form method="post" action="/logout"><button class="chip" type="submit">Sign out</button></form>
    </div>
    ${when(opts.back, () => html`<div style="margin-bottom:8px"><a href="${opts.back}" class="small">← Back</a></div>`)}
    ${when(flash, () => html`<div class="flash ${flash![0]}">${flash![1]}</div>`)}
    <h1 style="margin-bottom:12px">${opts.title}</h1>
    ${opts.content}
  </div>
  <nav class="portal-nav" aria-label="Portal">${nav}</nav>`;
  return htmlRes(doc(opts.title, body));
}
