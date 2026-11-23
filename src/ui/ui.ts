import { readFileSync } from 'node:fs';
import { join as pjoin } from 'node:path';
import { createHash } from 'node:crypto';
import { html, raw, esc, join, when, type Raw, type Child } from '../lib/html.ts';
import { htmlRes, takeFlash, cookie, type Rq, type Res } from '../lib/http.ts';
import { can, type Ctx } from '../lib/auth.ts';
import { q, ROOT } from '../lib/db.ts';
import { fmtDate } from '../lib/dates.ts';
import { uiMode, type UiMode } from '../lib/uimode.ts';

/** Content-hash version for static assets. Assets are served with
 * cache-control max-age=3600; without a version in the URL, a deploy can pair
 * fresh HTML with an hour-stale cached theme.css/app.js (which looks like a
 * broken site — dead menus, unstyled chrome). Hashing at module load keeps
 * URLs stable within a deploy and busts caches exactly when contents change. */
const ASSET_V: string = (() => {
  try {
    const h = createHash('sha1');
    for (const f of ['src/ui/theme.css', 'src/ui/app.js', 'src/ui/parts/oneinbox.css', 'src/ui/parts/find.css']) { try { h.update(readFileSync(pjoin(ROOT, f))); } catch { /* a part may not exist */ } }
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
  return html`<span class="wordmark ${onDark ? 'on-dark' : ''}">${logo(size, 'var(--accent)')}<span class="wm-text">Stay<span class="wm-accent">Leased</span></span></span>`;
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
const HREF_TO_TAB: Record<string, string> = { '/inbox': 'Messages', '/one-inbox': 'Messages', '/comms': 'Messages', '/outbox': 'Messages' };

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

// ---------- Standard mode navigation ----------
// Five tabs named for what an owner does — Home, Money, Units, People, Repairs
// — instead of the eight department names Advanced uses. Every entry is an
// href that a module has ALREADY registered, and resolves against that
// registration: permissions, demo-only flags, adaptive `show` predicates and
// active-state prefixes all come from the module, so Standard can never offer
// a page its user could not otherwise open. Only the label is Standard's own,
// taken from the approved copy map (docs/simple-mode-audit.md).
//
// Nothing is removed. Every page Standard leaves out is still at its URL, and
// one press of the switch puts the full navigation back.
type StdItem = [href: string, label: string];
interface StdTab { label: string; home?: true; groups: [heading: string | null, items: StdItem[]][] }
const STANDARD_TABS: StdTab[] = [
  { label: 'Home', home: true, groups: [] },
  { label: 'Money', groups: [
    ['Coming in', [['/receivables', 'Who owes me'], ['/delinquency', 'Seriously behind'], ['/deposits', 'Deposits I\u2019m holding'], ['/weekly-report', 'Weekly action report']]],
    ['Going out', [['/ap', 'Bills'], ['/approvals', 'Bills and spending to OK']]],
    ['Your books', [['/statements', 'Money in and out'], ['/banking', 'Bank accounts'], ['/reports', 'Reports']]],
  ] },
  { label: 'Units', groups: [
    [null, [['/properties', 'Properties'], ['/units', 'Units']]],
  ] },
  { label: 'People', groups: [
    // The two inboxes sat side by side as "Inbox" and "One Inbox" with nothing
    // to tell them apart, and the page that shows what was SENT lived under the
    // gear. Everything about messages is now one group, in the order of a day:
    // read, approve what was drafted, send to everyone, check what went out.
    ['Messages', [['/inbox', 'Inbox'], ['/one-inbox', 'Shared mailbox (One Inbox)'], ['/ai', 'Waiting for your OK'], ['/comms', 'Send a notice'], ['/outbox', 'Sent messages']]],
    ['Residents', [['/residents', 'Residents'], ['/leases', 'Leases'], ['/renewals', 'Leases ending soon']]],
    ['New renters', [['/leads', 'Inquiries'], ['/tours', 'Tours'], ['/applications', 'Applicants'], ['/placement-scorecard', 'Placement scorecard']]],
  ] },
  { label: 'Repairs', groups: [
    [null, [['/workorders', 'Repairs'], ['/myday', 'My day'], ['/turns', 'Getting units ready'], ['/vendors', 'Vendors']]],
  ] },
];

/** A few words under a menu label where the label alone leaves a question —
 * which of two inboxes, what "waiting" is waiting. Shown in the dropdown and
 * on the All pages index; never in the sub-nav row, which has no room. */
const NAV_HINTS: Record<string, string> = {
  '/inbox': 'conversations with residents',
  '/one-inbox': 'mail forwarded from your office address',
  '/ai': 'drafts written for you',
  '/comms': 'to a whole building at once',
  '/outbox': 'and whether each was delivered',
};

/** Advanced names its tabs for departments; these are the same five plain
 * headings Standard uses, so the All pages index and a search result say
 * "Money" in either mode. */
const TAB_TO_HEADING: Record<string, string> = {
  Dashboard: 'Home', Financials: 'Money', Property: 'Units', Residents: 'People', Leasing: 'People',
  Messages: 'People', Operations: 'Repairs', Reports: 'Reports', Setup: 'Setup and your company',
};
/** The Advanced menu names that differ from Standard's, for one page each:
 * the label a menu shows when the module's own would not say what it is. */
const ADVANCED_LABELS: Record<string, string> = { '/one-inbox': 'Shared mailbox (One Inbox)' };

/** One resolved Standard tab: the module's own NavItem, relabelled. */
interface StdResolved { label: string; home: boolean; groups: { heading: string | null; items: NavItem[] }[] }

function visible(ctx: Ctx, it: NavItem): boolean {
  if (it.perm && !can(ctx, it.perm)) return false;
  if (it.demoOnly && ctx.orgKind === 'live') return false;
  try {
    if (it.show && !it.show(ctx)) return false;
  } catch {
    return false; /* an adaptive predicate must never break the chrome */
  }
  return true;
}

function registeredByHref(): Map<string, NavItem> {
  const registered = new Map<string, NavItem>();
  for (const items of navSections.values()) for (const it of items) if (!registered.has(it.href)) registered.set(it.href, it);
  return registered;
}

function standardTabs(ctx: Ctx): StdResolved[] {
  const registered = registeredByHref();
  return STANDARD_TABS.map((t) => ({
    label: t.label,
    home: !!t.home,
    groups: t.groups.map(([heading, items]) => ({
      heading,
      items: items.flatMap(([href, label]) => {
        const it = registered.get(href);
        return it && visible(ctx, it) ? [{ ...it, label }] : [];
      }),
    })).filter((g) => g.items.length),
  })).filter((t) => t.home || t.groups.length);
}

const HOME_ACTIVE = (active: string): boolean => active === '/' || active === '/home';

/** Every href Standard's navigation names, and every href a module actually
 * registered. A Standard entry whose href no module registers renders as
 * nothing at all — a typo in the map above would silently delete a page from
 * Standard. The tests hold the first list inside the second. */
export function standardNavHrefs(): string[] {
  return STANDARD_TABS.flatMap((t) => t.groups.flatMap(([, items]) => items.map(([href]) => href)));
}
export function registeredNavHrefs(): Set<string> {
  return new Set([...navSections.values()].flatMap((items) => items.map((i) => i.href)));
}

function tabItems(ctx: Ctx): Map<string, NavItem[]> {
  const out = new Map<string, NavItem[]>();
  for (const [sec, items] of navSections) {
    for (const it of items) {
      if (!visible(ctx, it)) continue;
      const tab = HREF_TO_TAB[it.href] || SECTION_TO_TAB[sec] || 'Reports';
      const list = out.get(tab) || [];
      list.push(ADVANCED_LABELS[it.href] ? { ...it, label: ADVANCED_LABELS[it.href]! } : it);
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
  Home: TI('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>'),
};
// Standard's tabs reuse Advanced's drawings where the subject is the same, so
// switching modes changes the words and the grouping, never the iconography.
TAB_ICONS.Money = TAB_ICONS.Financials!;
TAB_ICONS.Units = TAB_ICONS.Property!;
TAB_ICONS.People = TAB_ICONS.Residents!;
TAB_ICONS.Repairs = TAB_ICONS.Operations!;

/** The Standard / Advanced switch.
 *
 * It sits at the end of the very bar it changes, and at the top of the mobile
 * drawer, because a mode a person cannot see is a mode they cannot get out
 * of. It is the same segmented control the Appearance picker uses, so it reads
 * as part of the product rather than a feature flag that leaked into the UI.
 *
 * A plain form post: it works without JavaScript, and it returns to the page
 * it was pressed on — switching is a change of view, not a change of place. */
function modeSwitch(r: Rq, mode: UiMode, where: 'bar' | 'drawer'): Raw {
  const back = r.url.pathname + r.url.search;
  return html`<form method="post" action="/mode" class="segbar modeswitch modeswitch-${where}" role="group" aria-label="Navigation mode">
    <input type="hidden" name="back" value="${back}" />
    <button class="seg" name="mode" value="standard" aria-pressed="${mode === 'standard' ? 'true' : 'false'}"
      title="Home, money, units, people and repairs \u2014 the everyday work, in plain words">Standard</button>
    <button class="seg" name="mode" value="advanced" aria-pressed="${mode === 'advanced' ? 'true' : 'false'}"
      title="Every screen, with the accounting and industry names for things">Advanced</button>
  </form>`;
}

/** One navigation, two renderings. The desktop bar and the phone drawer used
 * to be built separately, and drifted: the drawer named its sections after the
 * internal registry (Money, Intelligence, Admin) while the bar said Financials
 * and Reports, listed the inboxes under a different heading, and skipped the
 * adaptive `show` test, so it offered pages the bar hid. Both now read this. */
interface NavTab { label: string; home: boolean; groups: { heading: string | null; items: NavItem[] }[] }

function advancedTabs(ctx: Ctx): NavTab[] {
  const tabs = tabItems(ctx);
  const out: NavTab[] = [];
  for (const label of TAB_ORDER) {
    if (label === 'Dashboard') { out.push({ label, home: true, groups: [] }); continue; }
    let items = tabs.get(label) || [];
    if (!items.length) continue;
    // read first, sent last: the Outbox registers early (it is an admin page) but belongs at the end
    if (label === 'Messages') items = [...items.filter((i) => i.href !== '/outbox'), ...items.filter((i) => i.href === '/outbox')];
    const groups = TAB_GROUPS[label];
    if (!groups) { out.push({ label, home: false, groups: [{ heading: null, items }] }); continue; }
    const claimed = new Set<NavItem>();
    const buckets = groups.map(([g, prefixes]) => ({
      heading: g as string | null,
      items: items.filter((i) => {
        const hit = prefixes.some((p) => inGroup(i.href, p));
        if (hit) claimed.add(i);
        return hit;
      }),
    })).filter((x) => x.items.length);
    const head = items.filter((i) => !claimed.has(i));
    out.push({ label, home: false, groups: [...(head.length ? [{ heading: null, items: head }] : []), ...buckets] });
  }
  return out;
}

function navModel(ctx: Ctx, mode: UiMode): NavTab[] {
  return mode === 'standard' ? standardTabs(ctx) : advancedTabs(ctx);
}

/** What Standard leaves out of one tab, by name — the last line of each
 * Standard dropdown. Without it nothing in Standard says more pages exist, and
 * a person who cannot find Budgets concludes the product has no budgets. */
function moreInAdvanced(ctx: Ctx, tabLabel: string): string[] {
  const std = new Set(standardNavHrefs());
  const out: string[] = [];
  for (const [tab, items] of tabItems(ctx)) {
    if (TAB_TO_HEADING[tab] !== tabLabel) continue;
    for (const i of items) if (!std.has(i.href) && !i.href.startsWith('/hub/') && !out.includes(i.label)) out.push(i.label);
  }
  return out;
}

function moduleBar(ctx: Ctx, active: string, mode: UiMode, sw: Raw): Raw {
  const std = mode === 'standard';
  const link = (i: NavItem): Raw => {
    const hint = std ? NAV_HINTS[i.href] : undefined;
    return html`<a href="${i.href}" class="${itemActive(active, i) ? 'active' : ''}" ${itemActive(active, i) ? raw('aria-current="page"') : ''}>${i.label}${hint ? html`<span class="mhint">${hint}</span>` : ''}</a>`;
  };
  const homeLabel = std ? 'Home' : 'Dashboard';
  const homeActive = std ? HOME_ACTIVE(active) : active === '/';
  return html`<nav class="modulebar" data-mode="${mode}" aria-label="${std ? 'Navigation' : 'Modules'}">${join(navModel(ctx, mode).map((t, idx) => {
    if (t.home) {
      return html`<a class="mtab-btn ${homeActive ? 'active' : ''}" href="/">${TAB_ICONS[homeLabel]}${homeLabel}</a>`;
    }
    const all = t.groups.flatMap((g) => g.items);
    const act = all.some((i) => itemActive(active, i));
    // A tab with one page is a link, not a menu with one entry in it.
    if (std && all.length === 1) {
      return html`<a class="mtab-btn ${act ? 'active' : ''}" href="${all[0]!.href}">${TAB_ICONS[t.label]}${t.label}</a>`;
    }
    const body = t.groups.map((g) => html`${g.heading && (!std || t.groups.length > 1) ? html`<span class="mgroup" role="presentation">${g.heading}</span>` : raw('')}${g.items.map(link)}`);
    const more = std ? moreInAdvanced(ctx, t.label) : [];
    const moreLine = !std ? raw('') : html`<a class="mmore" href="/all-pages#${t.label.toLowerCase()}">${more.length
      ? html`<span class="mmore-what">More in Advanced: ${more.slice(0, 3).join(', ')}${more.length > 3 ? '…' : ''}</span>`
      : raw('')}<span class="mmore-go">All pages</span></a>`;
    return html`<div class="mtab ${act ? 'active' : ''}">
      <button class="mtab-btn" data-toggle="#${std ? 'st' : 'mt'}-${idx}" aria-haspopup="true">${TAB_ICONS[t.label]}${t.label}${CARET}</button>
      <div class="menu mmenu" id="${std ? 'st' : 'mt'}-${idx}">${body}${moreLine}</div>
    </div>`;
  }))}<div class="modulebar-end">${sw}</div></nav>`;
}

/** Entrata-style white second-row sub-nav: when the current page belongs to a
 * module tab, its sibling pages render as a horizontal row under the red bar
 * (the dropdowns remain for cross-module jumps). Dashboard and unmapped pages
 * (e.g. /setup) render no sub-nav.
 *
 * A long Standard tab (People has twelve pages) shows the active page's own
 * group — its messages, or its residents — rather than a row that scrolls off
 * the edge; the dropdown still holds the whole tab. */
function subNav(ctx: Ctx, active: string, mode: UiMode): Raw {
  for (const t of navModel(ctx, mode)) {
    if (t.home) continue;
    let items = t.groups.flatMap((g) => g.items);
    if (!items.some((i) => itemActive(active, i))) continue;
    if (mode === 'standard') {
      if (items.length < 2) return html``;
      if (items.length > 9) items = t.groups.find((g) => g.items.some((i) => itemActive(active, i)))!.items;
    }
    return html`<nav class="subnav" aria-label="${t.label} pages">
      ${items.map((i) => html`<a href="${i.href}" class="${itemActive(active, i) ? 'active' : ''}" ${itemActive(active, i) ? raw('aria-current="page"') : ''}>${i.label}</a>`)}
    </nav>`;
  }
  return html``;
}

/** The gear: everything that belongs to the organization rather than to the
 * day's work, grouped by what it is. It used to be three setup links, a rule,
 * and then every admin page in registration order — settings between lease
 * templates and the audit log, the simulator next to billing.
 *
 * Grouping is by href against the registry, like Standard's tabs, so the
 * module still owns the permission. Anything registered under Admin that no
 * group claims lands under System rather than vanishing: a page added later
 * must never become unreachable because this list was not updated. System is
 * Advanced's — scheduled jobs and integrations are plumbing an owner running
 * the everyday work has no reason to open. */
const GEAR_GROUPS: [heading: string, hrefs: string[], advancedOnly?: true][] = [
  ['Your organization', ['/admin/settings', '/setup/connections', '/admin/staff', '/admin/billing', '/admin/lease-templates']],
  ['Records', ['/outbox', '/admin/export', '/admin/audit']],
  ['System', ['/admin/jobs', '/admin/api', '/verticals'], true],
  ['Demo tools', ['/dev/sim']],
];
/** Gear pages no module registers as navigation: reached from the gear, from
 * the Setup page, and — now — from Find anything and the All pages index. */
const GEAR_EXTRA: NavItem[] = [
  { href: '/admin/billing', label: 'Billing', perm: 'admin:billing', match: ['/admin/billing'] },
  { href: '/setup/connections', label: 'Connections', perm: 'properties:manage', match: ['/setup/connections'] },
];
/** Labels the gear gives a page when the module's own is written for another
 * place: the Outbox is "Sent messages" wherever a person looks for sent mail. */
const GEAR_LABELS: Record<string, string> = { '/outbox': 'Sent messages', '/setup/connections': 'Connections (email, bank, payments)' };

/** The gear's contents for this person, grouped; `std` marks what Standard shows. */
function gearGroups(ctx: Ctx): { heading: string; items: NavItem[]; advOnly: boolean }[] {
  const tabs = tabItems(ctx);
  const admin = [...(tabs.get('Setup') || [])];
  // The Outbox sits under Messages in the Advanced bar; it stays in the gear too.
  for (const items of tabs.values()) for (const i of items) if (i.href === '/outbox' && !admin.includes(i)) admin.push(i);
  for (const x of GEAR_EXTRA) if (visible(ctx, x)) admin.push(x);
  const byHref = new Map(admin.map((i) => [i.href, i]));
  const claimed = new Set<string>();
  const groups = GEAR_GROUPS.map(([heading, hrefs, advOnly]) => {
    const items = hrefs.flatMap((h) => (byHref.has(h) ? [{ ...byHref.get(h)!, label: GEAR_LABELS[h] || byHref.get(h)!.label }] : []));
    items.forEach((i) => claimed.add(i.href));
    return { heading, items, advOnly: !!advOnly };
  });
  groups.find((g) => g.heading === 'System')!.items.push(...admin.filter((i) => !claimed.has(i.href)));
  return groups.filter((g) => g.items.length);
}

const isGearPath = (active: string): boolean => active.startsWith('/setup') || active.startsWith('/admin') || active === '/all-pages';

function setupMenu(ctx: Ctx, active: string, mode: UiMode): Raw {
  const groups = gearGroups(ctx);
  if (!groups.length && !can(ctx, 'properties:manage')) return html``;
  const shown = groups.filter((g) => mode === 'advanced' || !g.advOnly);
  const link = (i: NavItem): Raw => html`<a href="${i.href}" class="${itemActive(active, i) ? 'active' : ''}">${i.label}</a>`;
  return html`<div class="usermenu">
    <button class="icon-btn ${isGearPath(active) ? 'active' : ''}" data-toggle="#setup-pop" aria-label="Setup and administration" title="Setup &amp; administration">${GEAR}</button>
    <div class="menu gearmenu" id="setup-pop">
      <div class="menu-head">Setup &amp; administration</div>
      ${when(can(ctx, 'properties:manage'), () => html`<span class="mgroup" role="presentation">Your portfolio</span>
        <a href="/setup" class="${active === '/setup' ? 'active' : ''}">Setup</a>
        <a href="/setup#upload">Upload your data</a>
        <a href="/setup/wizard" class="${active === '/setup/wizard' ? 'active' : ''}">Add a property</a>`)}
      ${shown.map((g) => html`<span class="mgroup" role="presentation">${g.heading}</span>${g.items.map(link)}`)}
      <a class="mmore" href="/all-pages"><span class="mmore-go">All pages</span></a>
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
// ---------- find anything ----------
// The search box matched only the Advanced page names, by prefix. "payment",
// "late", "notice", "import", "email", "bills" and "sent" each returned nothing,
// and so did "who owes" — Standard's own menu words. It now knows three things
// about every destination: the name each mode gives it, the words people type
// when they want it, and the places that are in no menu at all.

/** The words people type, by href, strongest first. ONE map, here, rather than
 * a `keywords` field on forty registerNav calls in forty files: the vocabulary
 * is a single editorial decision and reads as one. An entry for an href nobody
 * registered is simply never used. */
const FIND_WORDS: Record<string, string[]> = {
  '/': ['home', 'dashboard', 'start', 'overview'],
  '/receivables': ['owes', 'late', 'rent', 'late rent', 'who owes', 'owe', 'owed', 'unpaid', 'balance', 'balances', 'collections', 'receivables', 'payments'],
  '/delinquency': ['behind', 'seriously behind', 'delinquent', 'delinquency', 'past due', 'overdue', 'eviction', 'payment plan', 'late'],
  '/deposits': ['deposit', 'deposits', 'security deposit', 'move out', 'refund'],
  '/weekly-report': ['weekly', 'action report', 'appfolio', 'follow up'],
  '/ap': ['bills', 'bill', 'invoices', 'invoice', 'payables', 'pay a vendor', 'checks'],
  '/approvals': ['approvals', 'sign off', 'spending', 'purchase approval', 'approve'],
  '/statements': ['profit', 'income', 'income statement', 'profit and loss', 'balance sheet', 'cash flow', 'statements', 'what i made'],
  '/banking': ['bank', 'bank accounts', 'reconcile', 'reconciliation', 'bank feed'],
  '/gl': ['accounting', 'books', 'ledger', 'journal', 'chart of accounts', 'general ledger'],
  '/periods': ['close the books', 'month end', 'close'],
  '/budgets': ['budget', 'budgets'],
  '/utilities': ['utilities', 'water', 'electric', 'gas', 'meters'],
  '/reserves': ['reserves', 'capital'],
  '/owners': ['owners', 'owner statement', 'distributions'],
  '/properties': ['properties', 'buildings', 'building', 'address'],
  '/units': ['units', 'apartments', 'vacant', 'vacancy', 'empty', 'rent roll'],
  '/map': ['map'],
  '/insurance': ['insurance', 'renters insurance', 'risk'],
  '/inbox': ['email', 'messages', 'message', 'conversations', 'reply', 'texts', 'text', 'mail', 'calls'],
  '/one-inbox': ['shared mailbox', 'one inbox', 'mailbox', 'office email', 'forwarded mail'],
  '/comms': ['notice', 'notices', 'announcement', 'announcements', 'mass message', 'everyone', 'whole building', 'templates', 'communications'],
  '/outbox': ['sent', 'sent messages', 'outbox', 'delivered', 'delivery', 'bounced', 'did it send'],
  '/residents': ['residents', 'tenants', 'tenant', 'renters', 'people', 'directory', 'phone number'],
  '/leases': ['leases', 'lease', 'households', 'household', 'move in'],
  '/renewals': ['renewals', 'renew', 'ending soon', 'expiring', 'lease end'],
  '/leads': ['inquiries', 'leads', 'prospects', 'guest cards'],
  '/tours': ['tours', 'showings', 'appointments'],
  '/leasing-center': ['leasing center', 'call center'],
  '/leasing/analytics': ['funnel', 'conversion'],
  '/applications': ['applicants', 'applications', 'screening', 'background check'],
  '/placement-scorecard': ['placement', 'scorecard', 'lead source'],
  '/marketing/sites': ['website', 'websites', 'property site'],
  '/marketing/syndication': ['listings', 'syndication', 'zillow'],
  '/workorders': ['repairs', 'repair', 'maintenance', 'work orders', 'work order', 'fix', 'broken', 'tickets'],
  '/myday': ['my day', 'my jobs', 'today'],
  '/dispatch': ['dispatch', 'assign'],
  '/turns': ['turns', 'make ready', 'getting units ready', 'turnover'],
  '/inspections': ['inspections', 'inspection'],
  '/pm': ['preventive', 'filters', 'recurring maintenance'],
  '/inventory': ['inventory', 'parts', 'supplies'],
  '/purchasing': ['purchasing', 'purchase orders', 'order'],
  '/vendors': ['vendors', 'vendor', 'contractors', 'contractor', 'plumber', 'electrician'],
  '/facilities': ['maintenance analytics'],
  '/reports': ['reports', 'report', 'rent roll report', 'export'],
  '/dashboards': ['my dashboard', 'charts'],
  '/pricing': ['pricing', 'rents', 'raise rent', 'comps', 'market rent'],
  '/ai': ['approve', 'drafts', 'draft', 'waiting', 'approval queue', 'ai', 'agents', 'needs my ok'],
  '/ask': ['ask', 'question', 'chat'],
  '/admin/settings': ['settings', 'late fees', 'fees', 'policies', 'rules', 'preferences'],
  '/admin/staff': ['staff', 'users', 'team', 'invite', 'roles', 'logins', 'add a user'],
  '/admin/audit': ['audit', 'who changed', 'history'],
  '/admin/export': ['export', 'download my data', 'backup', 'csv', 'leave'],
  '/admin/lease-templates': ['lease templates', 'lease form'],
  '/admin/jobs': ['scheduled jobs', 'automation'],
  '/admin/api': ['api', 'integrations', 'webhooks', 'api keys'],
  '/admin/billing': ['billing', 'subscription', 'my plan', 'what i pay'],
  '/setup/connections': ['connections', 'connect', 'email', 'turn on email', 'text messages', 'bank feed', 'payments'],
  '/verticals': ['student', 'affordable', 'military'],
  '/dev/sim': ['simulator', 'business date', 'time machine'],
};

/** Places and actions that are in no menu. Each was reachable only through a
 * card or a button two pages deep — which is exactly what a search box is for. */
interface ExtraDest { href: string; label: string; heading: string; kind: 'page' | 'action'; perm?: string; words: string[] }
const EXTRA_DESTS: ExtraDest[] = [
  { href: '/receivables/payment', label: 'Record a payment', heading: 'Money', kind: 'action', perm: 'payments:record', words: ['payment', 'record payment', 'record a payment', 'rent payment', 'check', 'cash', 'money order', 'paid'] },
  { href: '/comms/mass/new', label: 'Write a new notice', heading: 'People', kind: 'action', perm: 'comms:mass', words: ['send a notice', 'send notice', 'new notice', 'write a notice'] },
  { href: '/leases/new', label: 'New lease', heading: 'People', kind: 'action', perm: 'leases:manage', words: ['new lease', 'add lease', 'move in'] },
  { href: '/leases/new', label: 'Add a resident (new lease)', heading: 'People', kind: 'action', perm: 'leases:manage', words: ['add resident', 'add a resident', 'new resident', 'new tenant', 'add tenant'] },
  { href: '/vendors/new', label: 'Add a vendor', heading: 'Repairs', kind: 'action', perm: 'vendors:manage', words: ['add vendor', 'add a vendor', 'new vendor', 'new contractor'] },
  { href: '/workorders/new', label: 'New repair request', heading: 'Repairs', kind: 'action', perm: 'workorders:manage', words: ['new repair', 'new work order', 'report a repair'] },
  { href: '/setup', label: 'Setup', heading: 'Setup and your company', kind: 'page', words: ['setup', 'set up', 'checklist', 'getting set up'] },
  { href: '/setup#upload', label: 'Upload your data', heading: 'Setup and your company', kind: 'action', perm: 'properties:manage', words: ['import', 'upload', 'rent roll', 'spreadsheet', 'excel', 'csv', 'yardi', 'appfolio', 'buildium', 'lease pdf', 'move my data'] },
  { href: '/setup#import-history', label: 'Import history', heading: 'Setup and your company', kind: 'page', perm: 'properties:manage', words: ['import history', 'uploads', 'past imports', 'what i uploaded'] },
  { href: '/setup/wizard', label: 'Add a property', heading: 'Setup and your company', kind: 'action', perm: 'properties:manage', words: ['add property', 'add a property', 'new property', 'new building', 'add building'] },
  { href: '/welcome', label: 'Getting started', heading: 'Setup and your company', kind: 'page', perm: 'properties:manage', words: ['getting started', 'walkthrough', 'onboarding', 'first steps'] },
  { href: '/one-inbox/setup', label: 'Shared mailbox setup', heading: 'People', kind: 'page', perm: 'comms:view', words: ['one inbox setup', 'shared mailbox setup', 'forward my email', 'contact list'] },
  { href: '/admin/roles', label: 'What each role can do', heading: 'Setup and your company', kind: 'page', perm: 'admin:staff', words: ['permissions', 'permission matrix', 'what can a role do'] },
  { href: '/me', label: 'My profile and password', heading: 'Setup and your company', kind: 'page', words: ['my profile', 'password', 'change password', 'my account'] },
  { href: '/all-pages', label: 'All pages', heading: 'Setup and your company', kind: 'page', words: ['all pages', 'everything', 'site map', 'sitemap', 'help', 'where is'] },
];

/** One place a person can go. */
export interface Destination {
  href: string;
  /** the name this person's mode gives it */
  label: string;
  /** the other mode's name, when it differs */
  alias?: string;
  /** a few words that tell it from its neighbour */
  hint?: string;
  /** one of the plain headings: Home, Money, Units, People, Repairs, Reports, Setup and your company */
  heading: string;
  kind: 'page' | 'action';
  /** false = this person, in Standard, would have to switch to Advanced to see it in a menu */
  inStandard: boolean;
  /** false = it is in no menu in either mode */
  inMenus: boolean;
  words: string[];
}

export const DEST_HEADINGS = ['Home', 'Money', 'Units', 'People', 'Repairs', 'Reports', 'Setup and your company'];

/** Every destination this person may open, built from the nav registry, the
 * gear and the unregistered list above — never a hand-kept copy — so the All
 * pages index and Find anything cannot drift from the menus. */
export function destinations(ctx: Ctx, mode: UiMode = uiMode(ctx)): Destination[] {
  const out: Destination[] = [];
  const seen = new Set<string>();
  const stdLabel = new Map<string, string>();
  const stdHeading = new Map<string, string>();
  for (const t of STANDARD_TABS) for (const [, items] of t.groups) for (const [href, label] of items) { stdLabel.set(href, label); stdHeading.set(href, t.label); }
  const gear = gearGroups(ctx);
  const gearStd = new Set(gear.filter((g) => !g.advOnly).flatMap((g) => g.items.map((i) => i.href)));
  const add = (i: NavItem, tab: string): void => {
    if (seen.has(i.href)) return;
    seen.add(i.href);
    const isHub = i.href.startsWith('/hub/');
    const adv = isHub ? `${tab} overview` : i.href === '/' ? 'Dashboard' : (GEAR_LABELS[i.href] && tab === 'Setup' ? GEAR_LABELS[i.href]! : i.label);
    const std = i.href === '/' ? 'Home' : stdLabel.get(i.href) || GEAR_LABELS[i.href] || adv;
    const label = mode === 'standard' ? std : adv;
    const alias = mode === 'standard' ? adv : std;
    out.push({
      href: i.href, label, alias: alias !== label ? alias : undefined, hint: NAV_HINTS[i.href],
      heading: stdHeading.get(i.href) || TAB_TO_HEADING[tab] || 'Reports',
      kind: 'page', inMenus: true,
      inStandard: i.href === '/' || i.href === '/ask' || stdLabel.has(i.href) || gearStd.has(i.href),
      words: FIND_WORDS[i.href] || [],
    });
  };
  for (const [tab, items] of tabItems(ctx)) for (const i of items) add(i, tab);
  for (const g of gear) for (const i of g.items) add(i, 'Setup');
  for (const x of EXTRA_DESTS) {
    if (x.perm && !can(ctx, x.perm)) continue;
    out.push({ href: x.href, label: x.label, heading: x.heading, kind: x.kind, inMenus: false, inStandard: true, words: x.words });
  }
  return out;
}

const wordsOf = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** How well one destination answers a query; 0 = not at all. 81 and up means
 * the query IS a name or a listed word for it, which is what lets a page
 * outrank records ("rent" should open Who owes me, not six people named Trent). */
export function destScore(d: Destination, query: string): number {
  const needle = query.toLowerCase().trim().replace(/\s+/g, ' ');
  if (needle.length < 2) return 0;
  const names = [d.label, d.alias || ''].filter(Boolean).map((n) => n.toLowerCase());
  if (names.includes(needle)) return 100;
  const at = d.words.indexOf(needle);
  if (at >= 0) return Math.max(81, 99.5 - at);
  if (names.some((n) => n.startsWith(needle))) return 80;
  const kp = d.words.findIndex((w) => w.startsWith(needle));
  if (kp >= 0) return 70 - Math.min(kp, 9);
  // Word-start matches only. Substring matching turns every two-letter query
  // into a wall of pages.
  const nameWords = names.flatMap(wordsOf);
  const all = [...nameWords, ...d.words.flatMap(wordsOf)];
  const qw = wordsOf(needle);
  if (!qw.length) return 0;
  if (qw.every((w) => nameWords.some((x) => x.startsWith(w)))) return 60;
  if (qw.every((w) => all.some((x) => x.startsWith(w)))) return 50;
  return 0;
}

/** Destinations matching a query, best first. `sub` says where it lives, in
 * the words of the mode the person is in. */
function navHits(ctx: Ctx, query: string): { hit: SearchHit; score: number }[] {
  const mode = uiMode(ctx);
  const best = new Map<string, { hit: SearchHit; score: number }>();
  for (const d of destinations(ctx, mode)) {
    const score = destScore(d, query);
    if (!score) continue;
    const where = d.kind === 'action' ? d.heading : mode === 'standard' && !d.inStandard ? `${d.heading} · Advanced menus` : d.heading;
    const key = `${d.href}|${d.label}`;
    if (!best.has(key) || best.get(key)!.score < score) best.set(key, { hit: { kind: d.kind, label: d.label, sub: where, href: d.href }, score });
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.hit.label.length - b.hit.label.length).slice(0, 8);
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
  let pages: { hit: SearchHit; score: number }[] = [];
  try { pages = navHits(ctx, query); } catch { /* the registry must never break search */ }
  // A page whose name or listed word IS the query goes first; a looser match
  // stays below the records, where a resident named Parker still outranks the
  // parking page.
  const sure = pages.filter((p) => p.score > 80).map((p) => p.hit);
  const loose = pages.filter((p) => p.score <= 80).map((p) => p.hit);
  const records = out.slice(0, 40 - sure.length - Math.min(loose.length, 6));
  return [...sure, ...records, ...loose].slice(0, 40);
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

  const mode = uiMode(ctx);
  const showSwitch = !!ctx.orgId && (ctx.kind === 'staff' || ctx.kind === 'platform');
  const sw = showSwitch ? modeSwitch(r, mode, 'bar') : raw('');

  // The drawer is the phone's whole navigation, so it is the SAME navigation:
  // built from the model the bar renders, with the bar's tab names and its
  // group headings as small sub-heads, then the gear's pages, then All pages.
  const drawerLink = (i: NavItem): Raw => html`<a href="${i.href}" class="${itemActive(opts.active, i) ? 'active' : ''}" ${itemActive(opts.active, i) ? raw('aria-current="page"') : ''}><span class="dot"></span>${i.label}</a>`;
  const homeOn = mode === 'standard' ? HOME_ACTIVE(opts.active) : opts.active === '/';
  const gearForDrawer = gearGroups(ctx).filter((g) => mode === 'advanced' || !g.advOnly).flatMap((g) => g.items);
  const nav = html`${join(navModel(ctx, mode).map((t) => t.home
    ? html`<div class="nav-group"><a href="/" class="${homeOn ? 'active' : ''}"><span class="dot"></span>${mode === 'standard' ? 'Home' : 'Dashboard'}</a></div>`
    : html`<div class="nav-group"><div class="nav-head">${t.label}</div>${t.groups.map((g) => html`${g.heading && t.groups.length > 1 ? html`<div class="nav-sub">${g.heading}</div>` : raw('')}${g.items.map(drawerLink)}`)}</div>`))}
    <div class="nav-group nav-more">
      ${when(mode === 'advanced' && gearForDrawer.length, () => html`<div class="nav-sub">Setup and administration</div>${gearForDrawer.map(drawerLink)}`)}
      ${when(mode === 'standard' && (can(ctx, 'properties:manage') || gearForDrawer.length), () => html`<a href="/setup" class="${opts.active === '/setup' ? 'active' : ''}"><span class="dot"></span>Setup</a>`)}
      <a href="/all-pages" class="${opts.active === '/all-pages' ? 'active' : ''}"><span class="dot"></span>All pages</a>
    </div>`;

  const propSwitch = when(props.length > 0, () => html`<form method="post" action="/switch-property" class="prop-switch" data-autosubmit>
    <select name="property_id" aria-label="Property context">
      <option value="all" ${!ctx.currentPropertyId ? 'selected' : ''}>All properties</option>
      ${props.map((p) => html`<option value="${p.id}" ${ctx.currentPropertyId === p.id ? 'selected' : ''}>${p.name}</option>`)}
    </select>
  </form>`);

  // In Standard the menu says "Who owes me" and the page it opened said
  // "Receivables" — the plain words stopped one click in. The page a menu item
  // lands on now carries that item's own words as its heading. Only the exact
  // landing page: a lease or an invoice opened from it keeps its own title.
  let pageTitle: string = opts.title;
  if (mode === 'standard') {
    for (const t of standardTabs(ctx)) for (const g of t.groups) for (const i of g.items) if (i.href === r.path) pageTitle = i.label;
  }

  // A page reached by a link or by search, that the current menus do not show,
  // rendered with no highlighted tab, no sub-nav and no breadcrumb: nothing on
  // the screen said where it lived or how to get back. It now gets one line.
  let crumbs: [string, string?][] = opts.crumbs || [];
  let crumbNote: Raw | null = null;
  if (!crumbs.length && !opts.bareHead && ctx.orgId) {
    const inBar = navModel(ctx, mode).some((t) => t.groups.some((g) => g.items.some((i) => itemActive(opts.active, i))));
    if (!inBar && opts.active !== '/' && opts.active !== '/home') {
      const inGear = gearGroups(ctx).some((g) => g.items.some((i) => itemActive(opts.active, i))) || isGearPath(opts.active);
      if (inGear) {
        if (opts.active !== '/setup') crumbs = [['Setup and administration', can(ctx, 'properties:manage') ? '/setup' : undefined]];
      } else if (mode === 'standard') {
        for (const [tab, items] of tabItems(ctx)) {
          if (!items.some((i) => itemActive(opts.active, i))) continue;
          crumbs = [[TAB_TO_HEADING[tab] || tab]];
          crumbNote = html` · this page is in the Advanced menus · <a href="/all-pages">All pages</a>`;
          break;
        }
      }
    }
  }
  const mac = /Mac|iPhone|iPad/.test(String(r.raw?.headers?.['user-agent'] || ''));
  // The handful of places people ask for most, shown before anything is typed.
  const dests = ctx.orgId ? destinations(ctx, mode) : [];
  const starters = (['/receivables/payment', '/receivables', '/inbox', '/comms/mass/new', '/workorders', '/setup#upload', '/reports', '/all-pages']
    .map((h) => dests.find((d) => d.href === h))
    .filter(Boolean) as Destination[]);
  const body = html`<div class="app">
    <header class="topchrome">
      <div class="brandbar">
        <button class="menu-btn" data-toggle="#sidebar" aria-label="Menu">${raw('<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg>')}</button>
        <a class="brand brand-top" href="/">${logo(22, 'var(--brand)')} <span class="brand-name">Stay<span class="wm-accent">Leased</span></span></a>
        ${when(orgName && orgName !== 'Platform', () => html`<span class="org-chip" title="${orgName}">${orgName}</span>`)}
        ${when(ctx.orgKind === 'demo' && ctx.kind === 'staff', () => html`<span class="demo-pill" title="This is the shared demo world — simulated rails, demo data. Real customer companies run in live mode with real books.">DEMO</span>`)}
        <div class="spacer"></div>
        ${propSwitch}
        <button class="searchbtn" data-palette-open type="button" aria-label="Find anything" title="Find a person, a unit or a page"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><span class="stext">Find anything</span><kbd class="findkbd">${mac ? '\u2318K' : 'Ctrl K'}</kbd></button>
        ${when(can(ctx, 'ai:view'), () => html`<a class="askbtn" href="/ask" data-ask-open title="Ask StayLeased — plain-English answers from your own portfolio data">${raw('<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.9 2.6L22.5 18.5l-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9z"/></svg>')}<span class="stext">Ask StayLeased</span><kbd class="askkbd">⌘J</kbd></a>`)}
        ${ctx.orgKind === 'demo'
          ? html`<a class="bizdate" href="/dev/sim" title="Simulated business date — open Simulator Console"><span class="bd-label">Business date</span> ${fmtDate(ctx.businessDate)}</a>`
          : html`<span class="bizdate" title="Business date"><span class="bd-label">Business date</span> ${fmtDate(ctx.businessDate)}</span>`}
        ${setupMenu(ctx, opts.active, mode)}
        <div class="usermenu">
          <button class="avatar" data-toggle="#usermenu-pop" aria-label="Account menu">${initials(ctx.userName)}</button>
          <div class="menu" id="usermenu-pop">
            <div class="menu-head">${ctx.userName}<br /><span class="muted">${ctx.userEmail}</span></div>
            <hr />
            <a href="/me">My profile</a>
            <hr />
            ${APPEARANCE}
            <hr />
            <form method="post" action="/logout"><button type="submit">Sign out</button></form>
          </div>
        </div>
      </div>
      ${moduleBar(ctx, opts.active, mode, sw)}
      ${subNav(ctx, opts.active, mode)}
    </header>
    ${when(ctx.impersonatorId, () => html`<div class="impersonation">You are viewing StayLeased as <b>${ctx.userName}</b> (impersonation is audited). <a href="/unimpersonate">Return to my account</a></div>`)}
    <div class="main">
      <main class="content ${opts.wide ? 'wide' : ''}">
        ${when(flash, () => html`<div class="flash ${flash![0]}">${flash![1]}</div>`)}
        ${when(!opts.bareHead, () => html`<div class="page-head">
          <div class="titles">
            ${when(crumbs.length, () => html`<div class="crumbs">${join(crumbs.map(([label, href]) => (href ? html`<a href="${href}">${label}</a>` : html`<span>${label}</span>`)), raw(' / ').s)}${crumbNote}</div>`)}
            <h1>${pageTitle}</h1>
            ${when(opts.subtitle, () => html`<div class="subtitle">${opts.subtitle}</div>`)}
          </div>
          ${when(opts.actions, () => html`<div class="actions">${opts.actions}</div>`)}
        </div>`)}
        ${opts.content}
      </main>
    </div>
    <aside class="sidebar drawer" id="sidebar">
      <div class="brand">${logo(22, 'var(--brand)')} <span class="brand-name">Stay<span class="wm-accent">Leased</span><span class="org">${orgName}</span></span></div>
      ${when(showSwitch, () => html`<div class="drawer-mode">${modeSwitch(r, mode, 'drawer')}</div>`)}
      <nav class="nav">${nav}</nav>
    </aside>
  </div>
  <div class="palette-back" id="palette">
    <div class="palette" role="dialog" aria-label="Find anything">
      <input type="search" placeholder="Find a person, a unit or a page — try “late rent” or “export”" aria-label="Find a person, a unit or a page" id="palette-input" autocomplete="off" />
      <div class="results" id="palette-results"><div class="hintbar">Type at least 2 characters</div></div>
      ${when(starters.length, () => html`<div class="palette-start" aria-label="Common places">
        <div class="ps-head">Common places</div>
        ${starters.map((d) => html`<a href="${d.href}"><span class="kind">${d.kind}</span><span><b>${d.label}</b>${d.heading !== d.label ? html` <span class="muted">· ${d.heading}</span>` : ''}</span></a>`)}
      </div>`)}
      <div class="hintbar">↑↓ navigate · Enter open · Esc close</div>
    </div>
  </div>`;

  // The tab, the history entry and the bookmark carry the same words as the
  // menu item that opened the page: "Who owes me", not "Receivables".
  return htmlRes(doc(pageTitle, body, opts.head ?? null));
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
      html`<main class="auth-wrap"><div class="auth-card"><h1 class="sr-only">${title}</h1>${content}</div></main>`,
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
  /** Opt this column out of sorting. For columns that are not data — a row's
   * action buttons, a checkbox, an icon — where an ordering would mean nothing. */
  nosort?: boolean;
  /** Server-sorted tables only: where clicking this header goes. Setting it on
   * any column hands the whole table to the server and stands the in-page
   * sorter down, so a paginated list orders its FULL set rather than the page. */
  href?: string;
  /** Server-sorted tables only: the direction currently applied to this column. */
  sorted?: 'asc' | 'desc';
}
export interface TblRow {
  cells: Child[];
  href?: string;
}

/** The table.
 *
 * Every header sorts, everywhere, without its call site asking for it — there
 * are 163 of these and a feature the operator has to be granted table by table
 * is a feature most tables will never have. So sorting is the default and
 * `nosort` is the opt-out.
 *
 * Two mechanisms, and which one runs is a question about honesty rather than
 * taste. A table showing everything it has can be ordered in the page, and the
 * result is complete and correct. A table showing ONE PAGE of a longer list
 * cannot: sorting the fifty rows in front of you and presenting it as "sorted
 * by balance" is the same class of error as a column footer that does not sum
 * its column (#75) — it looks authoritative and is not. Such a list either
 * hands sorting to the server (`Col.href`, which orders the whole set, as the
 * residents roster does) or discloses the page scope — which `pager()` and the
 * in-page sorter arrange between themselves, so no call site has to remember. */
export function tbl(
  cols: Col[],
  rows: TblRow[],
  opts?: {
    empty?: string;
    foot?: Child[];
    density?: Density;
    /** false where row order IS the content and re-ordering would destroy it */
    sort?: false;
  },
): Raw {
  if (!rows.length) {
    return html`<div class="empty"><div class="e-title">${opts?.empty || 'Nothing here yet'}</div></div>`;
  }
  const server = cols.some((c) => c.href);
  const sortable = opts?.sort !== false && !server;
  // A column with no heading (the row-actions column) has nothing to sort by,
  // and a sort button with no text is a control with no name.
  const blank = (c: Col): boolean => html`${c.label}`.s.trim() === '';
  const head = (c: Col): Raw => {
    if (c.href) {
      const next = c.sorted === 'asc' ? 'descending' : 'ascending';
      return html`<a class="th-sort" href="${c.href}" aria-label="Sort by ${c.label} ${raw(next)}">${c.label}<span class="th-caret" aria-hidden="true"></span></a>`;
    }
    if (!sortable || c.nosort || blank(c)) return html`${c.label}`;
    // a button, not a bare click handler: it is reachable by keyboard and
    // announced as an control rather than as decoration
    return html`<button type="button" class="th-sort" data-sort>${c.label}<span class="th-caret" aria-hidden="true"></span></button>`;
  };
  // On a phone each row becomes a block of "label … value" lines (see .tbl[data-stack]),
  // so every cell after the first carries its column's heading as text.
  const labelText = (c: Col | undefined): string => (c ? html`${c.label}`.s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '');
  const dl = (i: number): Raw => {
    const t = i > 0 ? labelText(cols[i]) : '';
    return t ? raw(` data-label="${t.replaceAll('"', '&quot;')}"`) : raw('');
  };
  return html`<div class="tbl-wrap"><table class="tbl ${opts?.density === 'tight' ? 'tight' : ''}" data-stack
      ${sortable ? raw('data-sortable') : ''}>
    <thead><tr>${cols.map((c) => html`<th class="${c.num ? 'num' : ''}${c.href || (sortable && !c.nosort && !blank(c)) ? ' th-sortable' : ''}"
      ${c.sorted ? raw(`aria-sort="${c.sorted === 'asc' ? 'ascending' : 'descending'}"`) : ''}
      ${c.num ? raw('data-num') : ''}
      ${c.w ? raw(`style="width:${c.w}"`) : ''}>${head(c)}</th>`)}</tr></thead>
    <tbody>${rows.map(
      (row) =>
        html`<tr ${row.href ? raw(`data-href="${esc(row.href)}" tabindex="0"`) : ''}>${row.cells.map((cell, i) => html`<td class="${cols[i]?.num ? 'num' : ''}"${dl(i)}>${cell}</td>`)}</tr>`,
    )}</tbody>
    ${when(opts?.foot, () => html`<tfoot><tr>${(opts!.foot || []).map((cell, i) => html`<td class="${cols[i]?.num ? 'num' : ''}"${dl(i)}>${cell}</td>`)}</tr></tfoot>`)}
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

/** The pager, and the one thing that makes a sortable table honest.
 *
 * `data-pages` is read by the in-page sorter: a table that shows one page of a
 * longer list can only order the rows it was given, and saying so is the
 * difference between a useful control and a misleading one. A single-page
 * pager carries no marker, because there is nothing to disclaim. */
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
  return html`<div class="pager" ${raw(`data-pages="${pages}" data-total="${total}"`)}>${total} records · page ${nums} ${page < pages ? html`<a href="${link(page + 1)}">Next →</a>` : null}</div>`;
}

const STATUS_TONE: Record<string, string> = {
  // generic
  active: 'ok', ok: 'ok', paid: 'ok', settled: 'ok', completed: 'ok', complete: 'ok', approved: 'ok', signed: 'ok', executed: 'ok', fully_executed: 'ok', current: 'ok', covered: 'ok', reconciled: 'ok', ready: 'ok', published: 'ok', accepted: 'ok', open: 'info', matched: 'ok', received: 'ok', verified: 'ok', enrolled: 'ok', passed: 'ok', on: 'ok', yes: 'ok', posted: 'ok', acknowledged: 'ok',
  pending: 'warn', in_progress: 'info', scheduled: 'info', draft: '', submitted: 'info', screening: 'info', processing: 'info', partially_signed: 'warn', notice: 'warn', review: 'warn', conditional: 'warn', lapsing: 'warn', exception: 'warn', retrying: 'warn', hold: 'warn', waitlist: 'warn', partial: 'warn', 'approve-with-conditions': 'warn', month_to_month: 'warn', proposed: 'info', offered: 'info', quoted: 'info', toured: 'info', applied: 'violet', new: '', assigned: 'info', dispatched: 'info', in_transit: 'info',
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
    (t) => html`<a href="${t.href}" class="${t.active ? 'active' : ''}" ${t.active ? raw('aria-current="page"') : ''}>${t.label}${t.count !== undefined ? html` <span class="badge">${t.count}</span>` : null}</a>`,
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
  // A placeholder is the only name a bare input has (table-row inputs, filter
  // bars); field() drops this again when it pairs the control with its label.
  return html`<input id="${opts.id ?? ctrlId()}" name="${name}" type="${opts.type || 'text'}" value="${opts.value ?? ''}" placeholder="${opts.placeholder ?? ''}" ${opts.placeholder ? raw(`aria-label="${esc(opts.placeholder)}"`) : ''} ${opts.required ? 'required' : ''} ${opts.step ? raw(`step="${esc(opts.step)}"`) : ''} ${opts.min ? raw(`min="${esc(opts.min)}"`) : ''} ${opts.max ? raw(`max="${esc(opts.max)}"`) : ''} ${opts.list ? raw(`list="${esc(opts.list)}"`) : ''} ${opts.autofocus ? 'autofocus' : ''} />`;
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

/** A page that reports on one property, opened before any property exists.
 * These used to bind `undefined` into a query and answer with a 500. */
export function noProperties(r: Rq, title: string, active: string): Res {
  return shell(r, {
    title,
    active,
    content: card(null, emptyState(
      'No buildings yet',
      'This page reports on one property at a time, and none has been added. A rent roll brings in buildings, units, residents and leases together.',
      html`<a class="btn" href="/setup/import">Upload a rent roll</a> <a class="btn btn-ghost" href="/setup/wizard">Add a building by hand</a>`,
    )),
  });
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
