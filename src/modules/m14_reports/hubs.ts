import { html, raw, when } from '../../lib/html.ts';
import { type Router } from '../../lib/http.ts';
import { requirePerm, type Ctx } from '../../lib/auth.ts';
import { q, val } from '../../lib/db.ts';
import { fmtDate } from '../../lib/dates.ts';
import { shell, registerNav, tabNavItems, type NavItem } from '../../ui/ui.ts';
import { widget } from './dashboards.ts';

/** Module overview hubs — every top tab opens with an organized landing:
 * the module's key figures, what its AI agent is doing right now, and a
 * clear grid of everything inside the module. One config drives all five
 * hubs, and each hub registers as the FIRST item of its tab so it leads
 * both the dropdown and the sub-nav. */

interface HubDef {
  slug: string;
  tab: string; // module tab label (nav grouping)
  section: string; // registerNav section feeding that tab
  kicker: string;
  blurb: string;
  perm: string;
  widgets: string[]; // widget keys from the dashboard widget library
  agents: string[]; // ai_actions.agent values for the AI strip
  icon: string; // svg path d=
}

const HUBS: HubDef[] = [
  {
    slug: 'leasing', tab: 'Leasing', section: 'Leasing', perm: 'leasing:view',
    kicker: 'Leasing · Overview',
    blurb: 'From first inquiry to signed lease — every lead, tour, and application in one pipeline.',
    widgets: ['leasing_funnel', 'expirations_bar'],
    agents: ['leasing'],
    icon: 'M8 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 12l8 8m-3-3 2-2m-5-1 2-2',
  },
  {
    slug: 'residents', tab: 'Residents', section: 'Residents', perm: 'residents:view',
    kicker: 'Residents · Overview',
    blurb: 'The households you serve — leases, renewals, and every conversation in one place.',
    widgets: ['inbox_kpi', 'expirations_bar'],
    agents: ['renewals'],
    icon: 'M9 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM3.5 20c.6-3.4 2.8-5 5.5-5s4.9 1.6 5.5 5M17 6.5a2.5 2.5 0 1 0 0 5M15.5 14.6c2.4.2 4.3 1.6 5 4.4',
  },
  {
    slug: 'financials', tab: 'Financials', section: 'Money', perm: 'ledger:view',
    kicker: 'Financials · Overview',
    blurb: 'Rent in, bills out, real books — collections, delinquency, and the monthly close at a glance.',
    widgets: ['delinquency_kpi', 'collections_trend', 'noi_trend'],
    agents: ['payments'],
    icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM15 8.5c-.6-1-1.7-1.5-3-1.5-1.8 0-3 1-3 2.3 0 3.4 6.2 1.6 6.2 4.9 0 1.4-1.4 2.3-3.2 2.3-1.5 0-2.7-.6-3.3-1.7M12 5.5v13',
  },
  {
    slug: 'property', tab: 'Property', section: 'Property', perm: 'properties:view',
    kicker: 'Property · Overview',
    blurb: 'The physical portfolio — properties, units, availability, and where everything sits on the map.',
    widgets: ['occupancy_kpi', 'exposure_bar', 'occupancy_trend_chart'],
    agents: ['content'],
    icon: 'M4 21V5.5L12 3l8 2.5V21M2.5 21h19M9 8h1.5M13.5 8H15M9 12h1.5M13.5 12H15M9 16h1.5M13.5 16H15',
  },
  {
    slug: 'operations', tab: 'Operations', section: 'Operations', perm: 'workorders:view',
    kicker: 'Operations · Overview',
    blurb: 'Work orders, turns, vendors, and inspections — what needs doing and who is on it.',
    widgets: ['wo_sla_table', 'occupancy_kpi'],
    agents: ['maintenance'],
    icon: 'M14.7 6.3a4.5 4.5 0 0 0-6 6L3 18l3 3 5.7-5.7a4.5 4.5 0 0 0 6-6L14 13l-3-3 3.7-3.7z',
  },
];

const AGENT_LABEL: Record<string, string> = {
  leasing: 'Leasing AI', maintenance: 'Maintenance AI', payments: 'Payments AI', renewals: 'Renewals AI',
  call_analysis: 'Call analysis', content: 'Content AI', ask: 'Ask StayLeased',
};

for (const h of HUBS) {
  registerNav(h.section, { href: `/hub/${h.slug}`, label: 'Overview', perm: h.perm, match: [`/hub/${h.slug}`] }, { first: true });
}

function hubAiStrip(ctx: Ctx, hub: HubDef): ReturnType<typeof html> {
  if (!ctx.perms.has('ai:view')) return html``;
  const ph = hub.agents.map(() => '?').join(',');
  const rows = q<any>(
    `SELECT agent, title, status, created_at FROM ai_actions WHERE org_id=? AND agent IN (${ph}) ORDER BY (status='proposed') DESC, created_at DESC LIMIT 3`,
    ctx.orgId, ...hub.agents,
  );
  const pending = val<number>(
    `SELECT COUNT(*) FROM ai_actions WHERE org_id=? AND status='proposed' AND agent IN (${ph})`,
    ctx.orgId, ...hub.agents,
  ) || 0;
  return html`<div class="hub-ai">
    <div class="hub-ai-head">
      <span class="hai-title">✦ ${AGENT_LABEL[hub.agents[0]!] || 'AI'} in this module</span>
      ${when(pending > 0, () => html`<a class="badge warn" href="/ai?agent=${hub.agents[0]}">${pending} awaiting approval</a>`)}
      <a class="hai-link" href="/ai?agent=${hub.agents[0]}">Activity →</a>
    </div>
    ${rows.length
      ? rows.map((r) => html`<div class="hub-ai-row"><span class="har-title">${r.title}</span>${r.status === 'proposed' ? html`<span class="badge warn">awaiting approval</span>` : html`<span class="badge info">done</span>`}</div>`)
      : html`<div class="hub-ai-row"><span class="har-title af-quiet">Monitoring — nothing needs review right now</span></div>`}
  </div>`;
}

/** One-line descriptions for the link grid, keyed by nav label. */
const LINK_DESC: Record<string, string> = {
  'Leads': 'Every inquiry, scored and followed up',
  'Tours': 'Scheduled showings and their outcomes',
  'Leasing Center': 'Guided workspace for today’s leasing work',
  'Funnel analytics': 'Conversion from inquiry to signed lease',
  'Applications': 'Screening and approvals in progress',
  'Websites (CMS)': 'Property sites and listing pages',
  'Syndication': 'Listings pushed to advertising channels',
  'Residents': 'Directory of current households',
  'Leases': 'Active, upcoming, and past leases',
  'Renewals': 'Offers, responses, and expirations',
  'Inbox': 'Email and text with residents',
  'Communications': 'Announcements and broadcasts',
  'My day': 'Today’s schedule and follow-ups',
  'Statements': 'Owner and resident statements',
  'Receivables': 'Rent billed, collected, and outstanding',
  'Delinquency': 'Who owes what, and the next step',
  'Deposits': 'Security deposits held and returned',
  'Accounting': 'General ledger and journal entries',
  'Payables': 'Vendor bills and approvals',
  'Banking': 'Accounts and reconciliation',
  'Budgets': 'Plan versus actual by property',
  'Month-end close': 'Checklist to close the books',
  'Utilities': 'Utility billing and recovery',
  'Properties': 'Buildings, addresses, and settings',
  'Units': 'Every unit, its status, and market rent',
  'Portfolio map': 'Your portfolio on the map',
  'Insurance & risk': 'Policies, certificates, and expirations',
  'Work orders': 'Maintenance requests from intake to done',
  'Dispatch board': 'Assignments across technicians today',
  'Turn board': 'Make-ready progress unit by unit',
  'Preventive maintenance': 'Recurring service schedules',
  'Inspections': 'Move-in, move-out, and routine checks',
  'Vendors': 'Vendor directory, insurance, and performance',
  'Inventory': 'Parts and supplies on hand',
  'Purchasing': 'Purchase orders and approvals',
  'Facilities analytics': 'Response times and workload trends',
};

function hubLinks(ctx: Ctx, hub: HubDef, active: string): ReturnType<typeof html> {
  const items = tabNavItems(ctx, hub.tab).filter((i: NavItem) => i.href !== `/hub/${hub.slug}`);
  return html`<div class="hub-links">
    ${items.map((i: NavItem) => html`<a class="hub-link ${active === i.href ? 'active' : ''}" href="${i.href}">
      <span class="hl-text"><span class="hl-label">${i.label}</span>${when(LINK_DESC[i.label], () => html`<span class="hl-desc">${LINK_DESC[i.label]}</span>`)}</span>
      <span class="hl-arrow">→</span>
    </a>`)}
  </div>`;
}

export function routes(r: Router): void {
  for (const hub of HUBS) {
    r.get(`/hub/${hub.slug}`, requirePerm(hub.perm), (rq) => {
      const ctx = rq.ctx as Ctx;
      const kpiWidgets = hub.widgets.map((k) => widget(k)).filter((w) => w && w.kind === 'kpi');
      const bigWidgets = hub.widgets.map((k) => widget(k)).filter((w) => w && w.kind !== 'kpi');
      return shell(rq, {
        title: hub.tab,
        active: `/hub/${hub.slug}`,
        bareHead: true,
        content: html`
          <div class="hub-hero">
            <div class="hh-main">
              <div class="dh-kicker">${hub.kicker} · ${fmtDate(ctx.businessDate)}</div>
              <h1 class="dh-title">${hub.tab}</h1>
              <div class="dh-sub">${hub.blurb}</div>
            </div>
            <div class="hh-icon">${raw(`<svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${hub.icon}"/></svg>`)}</div>
          </div>
          ${hubAiStrip(ctx, hub)}
          ${hubLinks(ctx, hub, `/hub/${hub.slug}`)}
          ${kpiWidgets.map((w) => w!.render(ctx))}
          ${bigWidgets.length > 1
            ? html`<div class="grid cols-2">${bigWidgets.map((w) => html`<div>${w!.render(ctx)}</div>`)}</div>`
            : bigWidgets.map((w) => w!.render(ctx))}`,
      });
    });
  }
}
