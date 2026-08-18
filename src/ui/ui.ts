import { readFileSync } from 'node:fs';
import { join as pjoin } from 'node:path';
import { createHash } from 'node:crypto';
import { html, raw, esc, join, when, type Raw, type Child } from '../lib/html.ts';
import { htmlRes, takeFlash, cookie, type Rq, type Res } from '../lib/http.ts';
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
  return html`<span class="wordmark ${onDark ? 'on-dark' : ''}">${logo(size, onDark ? '#34D399' : 'var(--brand)')}<span class="wm-text">Stay<span class="wm-accent">Leased</span></span></span>`;
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
  /** adaptive nav: render only when relevant to this org's portfolio
   * (e.g. Student housing only when a student property exists). Evaluated
   * per request server-side, so the chrome molds itself to the operator. */
  show?: (ctx: Ctx) => boolean;
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

export function registerNav(section: string, item: NavItem, opts?: { first?: boolean }): void {
  const list = navSections.get(section) || [];
  if (!list.some((i) => i.href === item.href)) {
    if (opts?.first) list.unshift(item);
    else list.push(item);
  }
  navSections.set(section, list);
}

/** Pages of one module tab (permission-filtered), for module overview hubs. */
export function tabNavItems(ctx: Ctx, tabLabel: string): NavItem[] {
  return tabItems(ctx).get(tabLabel) || [];
}

// ---------- top module bar (Entrata-style) ----------
// The desktop chrome is a top module bar with dropdowns; the sidebar becomes a
// mobile-only drawer. Tabs group the same nav items modules already register,
// so nothing downstream changes. A gear → /setup holds administration.
// Small-operator focus (40–60 unit target): Marketing's two pages live inside
// the Leasing dropdown rather than holding a top-level tab of their own, and
// vertical modules (student/affordable) only appear when the portfolio has
// them (NavItem.show) — eight enterprise tabs become a calmer seven.
const TAB_ORDER = ['Dashboard', 'Leasing', 'Residents', 'Financials', 'Property', 'Operations', 'Messages', 'Reports'];
const SECTION_TO_TAB: Record<string, string> = {
  '': 'Dashboard', Leasing: 'Leasing', Residents: 'Residents', Money: 'Financials',
  Property: 'Property', Operations: 'Operations', Marketing: 'Leasing',
  Intelligence: 'Reports', Admin: 'Setup', Developer: 'Setup',
};
const HREF_TO_TAB: Record<string, string> = { '/inbox': 'Messages', '/comms': 'Messages' };

/** Grouped dropdowns (nav consolidation pass): the big tabs organize their
 * many pages into labeled clusters instead of one flat column, so a menu
 * reads as a table of contents rather than a wall. Membership is by href
 * (exact, or prefix at a path boundary); items no group claims — module
 * Overview links, the conditional Approvals inbox — render first, ungrouped.
 * Tabs absent here (Residents, Messages) are short enough to stay flat. */
const TAB_GROUPS: Record<string, [string, string[]][]> = {
  Leasing: [
    ['Pipeline', ['/leads', '/tours', '/leasing-center', '/applications']],
    ['Marketing', ['/marketing', '/leasing/analytics']],
  ],
  Financials: [
    ['Collect', ['/receivables', '/delinquency', '/deposits', '/utilities']],
    ['Books', ['/ap', '/gl', '/banking', '/statements', '/budgets', '/periods']],
    ['Capital & owners', ['/reserves', '/owners']],
  ],
  Property: [
    ['Portfolio', ['/map', '/properties', '/units']],
    ['Risk & programs', ['/insurance', '/student', '/affordable']],
  ],
  Operations: [
    ['Maintenance', ['/workorders', '/myday', '/dispatch', '/turns', '/inspections', '/pm']],
    ['Purchasing & supply', ['/purchasing', '/inventory', '/vendors']],
    ['Insight', ['/facilities']],
  ],
  Reports: [
    ['Analytics', ['/reports', '/dashboards', '/pricing']],
    ['AI', ['/ai', '/ask']],
  ],
};

function inGroup(href: string, prefix: string): boolean {
  return href === prefix || href.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

function tabItems(ctx: Ctx): Map<string, NavItem[]> {
  const out = new Map<string, NavItem[]>();
  for (const [sec, items] of navSections) {
    for (const it of items) {
      if (it.perm && !can(ctx, it.perm)) continue;
      if (it.demoOnly && ctx.orgKind === 'live') continue;
      if (it.show && !it.show(ctx)) continue;
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
    const link = (i: NavItem): Raw => html`<a href="${i.href}" class="${itemActive(active, i) ? 'active' : ''}">${i.label}</a>`;
    const groups = TAB_GROUPS[label];
    let menuBody: Raw;
    if (!groups) {
      menuBody = html`${items.map(link)}`;
    } else {
      const claimed = new Set<NavItem>();
      const buckets = groups.map(([g, prefixes]) => ({
        g,
        list: items.filter((i) => {
          const hit = prefixes.some((p) => inGroup(i.href, p));
          if (hit) claimed.add(i);
          return hit;
        }),
      })).filter((b) => b.list.length);
      const head = items.filter((i) => !claimed.has(i));
      menuBody = html`${head.map(link)}${buckets.map((b) => html`<span class="mgroup" role="presentation">${b.g}</span>${b.list.map(link)}`)}`;
    }
    return html`<div class="mtab ${act ? 'active' : ''}">
      <button class="mtab-btn" data-toggle="#mt-${idx}" aria-haspopup="true">${TAB_ICONS[label]}${label}${CARET}</button>
      <div class="menu mmenu" id="mt-${idx}">
        ${menuBody}
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

/** Appearance lives in the account menu, named and labelled, because that is
 * what it is: a personal preference, like the profile and the sign-out beside
 * it. It used to be a bare sun glyph in the top bar directly beside the setup
 * gear — two identical round icon buttons, one personal and one
 * administrative, which read as a pair and sent people looking for settings
 * into the theme. Three explicit choices also beat a toggle: "System" is a
 * real answer that a two-state switch cannot express, and the boot script has
 * always honoured it. */
const APPEARANCE = html`<div class="menu-sub">
  <div class="menu-label">Appearance</div>
  <div class="segbar" role="group" aria-label="Appearance">
    <button type="button" class="seg" data-theme-set="system">System</button>
    <button type="button" class="seg" data-theme-set="light">Light</button>
    <button type="button" class="seg" data-theme-set="dark">Dark</button>
  </div>
</div>`;

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
/** Every registered nav destination this user may open, matched by name. The
 * record providers answer "who is Maya Torres"; this answers "where is the
 * dispatch board" — which is the other half of what people type into a search
 * box, and previously returned nothing at all. Pages rank below records: a
 * resident named Parker outranks the parking page. */
function navHits(ctx: Ctx, query: string): SearchHit[] {
  const needle = query.toLowerCase();
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const [section, items] of navSections) {
    for (const item of items) {
      if (seen.has(item.href)) continue;
      if (item.perm && !ctx.perms.has(item.perm)) continue;
      if (item.demoOnly && ctx.orgKind !== 'demo') continue;
      try {
        if (item.show && !item.show(ctx)) continue;
      } catch {
        continue; /* an adaptive-nav predicate must never break search */
      }
      const label = item.label.toLowerCase();
      // Prefix and word-start matches only. Substring matching turns every
      // two-letter query into a wall of pages.
      const words = label.split(/[^a-z0-9]+/).filter(Boolean);
      if (!label.startsWith(needle) && !words.some((w) => w.startsWith(needle))) continue;
      seen.add(item.href);
      hits.push({ kind: 'page', label: item.label, sub: section || 'Dashboard', href: item.href });
    }
  }
  return hits.sort((a, b) => a.label.length - b.label.length).slice(0, 6);
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
  const records = out.slice(0, 34);
  return [...records, ...navHits(ctx, query)].slice(0, 40);
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
  /** page provides its own hero/h1 (e.g. dashboards) — skip the standard head */
  bareHead?: boolean;
  /** extra tags for <head> (stylesheets/scripts a page needs) */
  head?: Child;
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
        <button class="searchbtn" data-palette-open type="button"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><span class="stext">Search…</span></button>
        ${when(can(ctx, 'ai:view'), () => html`<a class="askbtn" href="/ask" data-ask-open title="Ask StayLeased — plain-English answers from your own portfolio data">${raw('<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.9 2.6L22.5 18.5l-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9z"/></svg>')}<span class="stext">Ask StayLeased</span></a>`)}
        ${ctx.orgKind === 'demo'
          ? html`<a class="bizdate" href="/dev/sim" title="Simulated business date — open Simulator Console"><span class="bd-label">Business date</span> ${fmtDate(ctx.businessDate)}</a>`
          : html`<span class="bizdate" title="Business date"><span class="bd-label">Business date</span> ${fmtDate(ctx.businessDate)}</span>`}
        ${setupMenu(ctx, opts.active)}
        <div class="usermenu">
          <button class="avatar" data-toggle="#usermenu-pop" aria-label="Account menu">${initials(ctx.userName)}</button>
          <div class="menu" id="usermenu-pop">
            <div class="menu-head">${ctx.userName}<br /><span class="muted">${ctx.userEmail}</span></div>
            <hr />
            ${when(can(ctx, 'admin:settings'), () => html`<a href="/admin/settings">Org settings</a>`)}
            <a href="/me">My profile</a>
            <hr />
            ${APPEARANCE}
            <hr />
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
        ${when(!opts.bareHead, () => html`<div class="page-head">
          <div class="titles">
            ${when(opts.crumbs?.length, () => html`<div class="crumbs">${join((opts.crumbs || []).map(([label, href]) => (href ? html`<a href="${href}">${label}</a>` : html`<span>${label}</span>`)), raw(' / ').s)}</div>`)}
            <h1>${opts.title}</h1>
            ${when(opts.subtitle, () => html`<div class="subtitle">${opts.subtitle}</div>`)}
          </div>
          ${when(opts.actions, () => html`<div class="actions">${opts.actions}</div>`)}
        </div>`)}
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

  return htmlRes(doc(opts.title, body, opts.head ?? null));
}

/** Theme boot: an explicit choice (sl_theme cookie, set by the toggle) wins;
 * otherwise the theme follows the visitor's system setting live, defaulting
 * to light when the system expresses no preference. Runs synchronously in
 * <head> so the first paint is already in the right theme. Shared with the
 * marketing chrome. */
export const THEME_BOOT_JS = `(function(){try{
var d=document.documentElement;
function cookie(){var m=document.cookie.match(/(?:^|; )sl_theme=(light|dark)/);return m&&m[1];}
var mq=window.matchMedia?window.matchMedia('(prefers-color-scheme: dark)'):null;
function sys(){return mq&&mq.matches?'dark':'light';}
d.setAttribute('data-theme',cookie()||sys());
if(mq&&mq.addEventListener)mq.addEventListener('change',function(){
if(cookie())return;var t=sys();d.setAttribute('data-theme',t);
try{document.dispatchEvent(new CustomEvent('sl-theme',{detail:t}))}catch(e){}
});
}catch(e){}})();`;

export function doc(title: string, body: Child, extraHead: Child = null): string {
  return (
    '<!doctype html>' +
    html`<html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} · StayLeased</title>
        ${raw(`<script>${THEME_BOOT_JS}</script>`)}
        <link rel="preload" href="/assets/fonts/inter-var.woff2" as="font" type="font/woff2" crossorigin />
        <link rel="preload" href="/assets/fonts/space-grotesk-var.woff2" as="font" type="font/woff2" crossorigin />
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
export function tbl(cols: Col[], rows: TblRow[], opts?: { empty?: string; foot?: Child[]; density?: Density }): Raw {
  if (!rows.length) {
    return html`<div class="empty"><div class="e-title">${opts?.empty || 'Nothing here yet'}</div></div>`;
  }
  return html`<div class="tbl-wrap"><table class="tbl ${opts?.density === 'tight' ? 'tight' : ''}">
    <thead><tr>${cols.map((c) => html`<th class="${c.num ? 'num' : ''}" ${c.w ? raw(`style="width:${c.w}"`) : ''}>${c.label}</th>`)}</tr></thead>
    <tbody>${rows.map(
      (row) =>
        html`<tr ${row.href ? raw(`data-href="${esc(row.href)}" tabindex="0"`) : ''}>${row.cells.map((cell, i) => html`<td class="${cols[i]?.num ? 'num' : ''}">${cell}</td>`)}</tr>`,
    )}</tbody>
    ${when(opts?.foot, () => html`<tfoot><tr>${(opts!.foot || []).map((cell, i) => html`<td class="${cols[i]?.num ? 'num' : ''}">${cell}</td>`)}</tr></tfoot>`)}
  </table></div>`;
}

// ---------- list views: how a long table is shown ----------

/** Row height. "Roomy" is the reading default; "Tight" fits roughly twice as
 * many rows on a screen, which is what someone working a 300-row delinquency
 * list actually wants. The choice follows the operator across every list and
 * every session (cookie), because it is a preference about their eyes, not
 * about the page they happen to be on. */
export type Density = 'roomy' | 'tight';
const DENSITY_COOKIE = 'sl_density';

export function density(r: Rq): Density {
  const fromUrl = r.query.get('density');
  if (fromUrl === 'roomy' || fromUrl === 'tight') return fromUrl;
  return r.cookies[DENSITY_COOKIE] === 'tight' ? 'tight' : 'roomy';
}

/** Call in a list route so a `?density=` in the URL is remembered next time. */
export function rememberDensity(r: Rq): Density {
  const d = density(r);
  if (r.query.get('density') && r.cookies[DENSITY_COOKIE] !== d) {
    r.setCookies.push(cookie(DENSITY_COOKIE, d, { maxAge: 365 * 86400, httpOnly: false }));
  }
  return d;
}

/** A segmented switch rendered as links, so it works with no JavaScript and
 * every other filter on the page survives the click. */
export function segLinks(
  r: Rq,
  param: string,
  choices: [value: string, label: string][],
  current: string,
  label: string,
): Raw {
  const href = (v: string): string => {
    const sp = new URLSearchParams(r.query);
    sp.set(param, v);
    sp.delete('page'); // a different shape of the list starts at the top
    return `${r.path}?${sp}`;
  };
  return html`<div class="segbar" role="group" aria-label="${label}">
    ${choices.map(([v, l]) => html`<a class="seg ${v === current ? 'on' : ''}" href="${href(v)}"
      ${v === current ? raw('aria-current="true"') : ''}>${l}</a>`)}
  </div>`;
}

/** The control strip that sits above a long list: how it is grouped, and how
 * tightly it is packed. Views are optional — a list with only one sensible
 * shape passes none and still gets the density control. */
export function viewBar(
  r: Rq,
  opts: { views?: { param?: string; current: string; choices: [string, string][]; label?: string }; density: Density; note?: Child },
): Raw {
  return html`<div class="viewbar">
    ${when(!!opts.views, () => html`<div class="vb-group">
      <span class="vb-label">${opts.views!.label || 'View'}</span>
      ${segLinks(r, opts.views!.param || 'view', opts.views!.choices, opts.views!.current, opts.views!.label || 'View')}
    </div>`)}
    <div class="vb-group">
      <span class="vb-label">Rows</span>
      ${segLinks(r, 'density', [['roomy', 'Roomy'], ['tight', 'Tight']], opts.density, 'Row height')}
    </div>
    ${when(opts.note, () => html`<div class="vb-note">${opts.note}</div>`)}
  </div>`;
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

/** Stable-per-document control ids so a `<label for>` can bind to its control.
 * A module counter is sufficient: ids only need to be unique within one
 * rendered response, and server rendering is synchronous per request. */
let CTRL_SEQ = 0;
function ctrlId(): string {
  return `f${++CTRL_SEQ}`;
}

/** A labeled form row. The control (already rendered by input()/select()/
 * textarea(), each of which auto-emits an `id`) is associated with its label
 * by reading that id back out and pointing `<label for>` at it — clicking the
 * label focuses the control and screen readers announce the pair (WCAG 1.3.1
 * / 4.1.2). When the control carries an auto `aria-label` (the bare-select
 * fallback) it is dropped here, since the visible label is now its accessible
 * name. DOM shape is otherwise unchanged, so all existing layout/CSS holds. */
export function field(label: Child, control: Child, hint?: Child): Raw {
  let cs = html`${control}`.s;
  const m = cs.match(/ id="([^"]*)"/);
  let ctrl: Child = control;
  let forAttr = '';
  if (m) {
    forAttr = ` for="${esc(m[1])}"`;
    if (cs.includes(' aria-label="')) {
      cs = cs.replace(/ aria-label="[^"]*"/, '');
      ctrl = raw(cs);
    }
  }
  return html`<div class="field"><label${raw(forAttr)}>${label}</label>${ctrl}${when(hint, () => html`<div class="hint">${hint}</div>`)}</div>`;
}
export function input(name: string, opts: { value?: Child; type?: string; placeholder?: string; required?: boolean; step?: string; min?: string; max?: string; list?: string; autofocus?: boolean; id?: string } = {}): Raw {
  return html`<input id="${opts.id ?? ctrlId()}" name="${name}" type="${opts.type || 'text'}" value="${opts.value ?? ''}" placeholder="${opts.placeholder ?? ''}" ${opts.required ? 'required' : ''} ${opts.step ? raw(`step="${esc(opts.step)}"`) : ''} ${opts.min ? raw(`min="${esc(opts.min)}"`) : ''} ${opts.max ? raw(`max="${esc(opts.max)}"`) : ''} ${opts.list ? raw(`list="${esc(opts.list)}"`) : ''} ${opts.autofocus ? 'autofocus' : ''} />`;
}
export function select(name: string, options: [string, Child][], value?: string | null, opts: { required?: boolean; blank?: string; id?: string; ariaLabel?: string } = {}): Raw {
  // Always carry an accessible name: field() strips this when it associates a
  // visible <label>, so it only survives on bare selects (no visible label),
  // where an aria-label derived from the field name is the accessible name.
  const aria = opts.ariaLabel ?? name.replaceAll('_', ' ');
  return html`<select id="${opts.id ?? ctrlId()}" name="${name}" aria-label="${aria}" ${opts.required ? 'required' : ''}>
    ${opts.blank !== undefined ? html`<option value="">${opts.blank}</option>` : null}
    ${options.map(([v, label]) => html`<option value="${v}" ${value === v ? 'selected' : ''}>${label}</option>`)}
  </select>`;
}
export function textarea(name: string, opts: { value?: string; placeholder?: string; required?: boolean; rows?: number; id?: string } = {}): Raw {
  return html`<textarea id="${opts.id ?? ctrlId()}" name="${name}" placeholder="${opts.placeholder ?? ''}" ${opts.required ? 'required' : ''} rows="${opts.rows || 4}">${opts.value ?? ''}</textarea>`;
}
export function checkbox(name: string, label: Child, checked?: boolean, value = '1'): Raw {
  return html`<label class="check"><input type="checkbox" name="${name}" value="${value}" ${checked ? 'checked' : ''} /> <span>${label}</span></label>`;
}
export function moneyInput(name: string, cents?: number | null, opts: { required?: boolean; placeholder?: string; id?: string } = {}): Raw {
  const val = cents === undefined || cents === null ? '' : (cents / 100).toFixed(2);
  return html`<input id="${opts.id ?? ctrlId()}" name="${name}" type="text" inputmode="decimal" value="${val}" placeholder="${opts.placeholder ?? '0.00'}" ${opts.required ? 'required' : ''} />`;
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
