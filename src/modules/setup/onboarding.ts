import { html, raw, when, type Raw } from '../../lib/html.ts';
import { redirect, type Router, type Rq } from '../../lib/http.ts';
import { requireStaff, can, type Ctx } from '../../lib/auth.ts';
import { q1 } from '../../lib/db.ts';
import { getSetting, setSetting } from '../../lib/settings.ts';
import { shell, card } from '../../ui/ui.ts';

/** Guided go-live checklist for new (live) orgs. Progress is DETECTED from
 * the org's real data — import a rent roll and three steps complete at once.
 * The list deep-links every step into the fastest lane (Import Hub first,
 * manual forms second) and disappears once the org is running. */

interface Step {
  key: string;
  title: string;
  desc: string;
  done: boolean;
  optional?: boolean;
  links: [string, string][]; // [href, label] — first link is the primary CTA
}

function n(sql: string, ...params: unknown[]): number {
  return q1<{ n: number }>(sql, ...params)?.n ?? 0;
}

export function onboardingSteps(ctx: Ctx): Step[] {
  const props = n('SELECT COUNT(*) n FROM properties WHERE org_id=?', ctx.orgId);
  const units = n('SELECT COUNT(*) n FROM units WHERE org_id=?', ctx.orgId);
  const leases = n(`SELECT COUNT(*) n FROM leases WHERE org_id=? AND status IN ('active','month_to_month','notice')`, ctx.orgId);
  const residents = n('SELECT COUNT(*) n FROM residents WHERE org_id=?', ctx.orgId);
  const vendors = n('SELECT COUNT(*) n FROM vendors WHERE org_id=? AND active=1', ctx.orgId);
  const staff = n(`SELECT COUNT(*) n FROM users WHERE org_id=? AND kind='staff' AND active=1`, ctx.orgId);
  const conversionPosted = !!q1(`SELECT id FROM journal_entries WHERE org_id=? AND source_kind='conversion' LIMIT 1`, ctx.orgId)
    || !!q1(`SELECT id FROM charges WHERE org_id=? AND kind='opening_balance' LIMIT 1`, ctx.orgId);
  const skip = (k: string): boolean => getSetting<boolean>(ctx, k) === true;

  return [
    {
      key: 'company', title: 'Create your company', done: true,
      desc: 'Your organization, admin login, and standard chart of accounts are ready.',
      links: [['/admin/settings', 'Review org settings']],
    },
    {
      key: 'properties', title: 'Add your properties & units', done: units > 0,
      desc: props > 0 && units === 0
        ? 'Property created — now bring in its units (the rent roll import creates them automatically).'
        : 'Fastest: upload your rent roll (Excel/CSV from any system) — properties, units, residents and leases come in together. Or use the guided wizard.',
      links: [['/setup/import', 'Import your data'], ['/setup/wizard', 'Add one manually']],
    },
    {
      key: 'residents', title: 'Bring in residents & leases', done: leases > 0 && residents > 0,
      desc: 'From the same rent roll upload, or drop in your signed lease PDFs and let AI extract tenants, rents, dates and deposits for your review.',
      links: [['/setup/import?tab=rentroll', 'Upload rent roll'], ['/setup/import?tab=leases', 'Upload lease PDFs']],
    },
    {
      key: 'financials', title: 'Set financial opening balances', done: conversionPosted || skip('onb_skip_financials'),
      optional: true,
      desc: 'Carry over what residents owe, deposits you hold, and your bank balance as of your switch date — so day one here matches your old books to the penny.',
      links: [['/setup/import?tab=balances', 'Set opening balances']],
    },
    {
      key: 'vendors', title: 'Add your vendors', done: vendors > 0 || skip('onb_skip_vendors'),
      optional: true,
      desc: 'Plumbers, electricians, landscapers — imported from a spreadsheet or added as you go. Work orders and bills need someone to dispatch to.',
      links: [['/setup/import?tab=vendors', 'Import vendors'], ['/vendors', 'Add manually']],
    },
    {
      key: 'team', title: 'Invite your team', done: staff > 1 || skip('onb_skip_team'),
      optional: true,
      desc: 'Add managers, leasing agents, and maintenance techs with role-scoped access. Solo operator? Skip this — you already have full access.',
      links: [['/admin/staff', 'Add staff']],
    },
    {
      key: 'connections', title: 'Review connections & AI', done: skip('onb_skip_connections'),
      optional: true,
      desc: 'See what is connected (AI brain, API access) and join the waitlist for live payment, bank-feed and listing-syndication rails.',
      links: [['/setup/connections', 'Open connections']],
    },
  ];
}

export function onboardingProgress(ctx: Ctx): { done: number; total: number; required_done: boolean } {
  const steps = onboardingSteps(ctx);
  const done = steps.filter((s) => s.done).length;
  const required = steps.filter((s) => !s.optional);
  return { done, total: steps.length, required_done: required.every((s) => s.done) };
}

/** Slim dashboard banner while a live org is still onboarding. */
export function onboardingBanner(ctx: Ctx): Raw | null {
  if (ctx.orgKind !== 'live') return null;
  if (getSetting<boolean>(ctx, 'onboarding_dismissed') === true) return null;
  const p = onboardingProgress(ctx);
  if (p.done >= p.total) return null;
  return html`<a class="callout info" style="display:block;text-decoration:none;margin-bottom:14px" href="/welcome">
    <b>Getting set up:</b> ${p.done} of ${p.total} steps done — continue your guided setup →
  </a>`;
}

const CHECK = raw('<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>');

/** The definitive "what to upload" panel: which documents, what each unlocks,
 * and what starts automating once they're in. Shown on /welcome and the
 * Import Hub so nobody has to guess what "ready" means. */
export function docsChecklist(compact = false): Raw {
  const ROWS: [string, string, string][] = [
    ['Rent roll (Excel, CSV, or PDF)', 'The one file that matters. Units, floorplans, tenants, rents, lease dates, deposits, balances owed.',
     'Unlocks: the whole portfolio — rent bills itself on the 1st, late fees follow your policy, delinquency outreach drafts automatically, occupancy and collections dashboards go live.'],
    ['Signed lease PDFs (optional)', 'Your executed leases — AI reads tenants, rent, dates, deposit from each.',
     'Unlocks: anything the rent roll missed, the source document attached to each lease, and renewal automation with real end dates.'],
    ['Vendor list (optional)', 'Names, trades, contact info — from a spreadsheet or added as you go.',
     'Unlocks: one-click dispatch on work orders and AI-drafted vendor messages in the approval queue.'],
    ['Operating bank balance (one number)', 'Your account balance on the switch date — typed into a form, no file needed.',
     'Unlocks: books that start from truth, so reconciliation and owner statements tie out from day one.'],
    ['Balances owed (if not in the rent roll)', 'Per-unit amounts residents owe as of the switch date.',
     'Unlocks: collections continuity — nobody\'s balance resets to zero, and the Payments AI picks up the follow-up.'],
  ];
  return card(compact ? null : 'What to have ready', html`
    ${when(!compact, () => html`<p class="muted" style="margin-top:0">Most operators are fully set up from the first row alone. Everything else deepens the automation.</p>`)}
    <div class="docs-list">
      ${ROWS.map(([name, what, unlocks], i) => html`<div class="docs-row">
        <div class="docs-n">${String(i + 1)}</div>
        <div><b>${name}</b><div class="muted small">${what}</div><div class="docs-unlock small">${unlocks}</div></div>
      </div>`)}
    </div>
    ${when(!compact, () => html`<p class="muted small" style="margin-bottom:0">After the upload: billing starts the month after your switch date (no double-charging), the scheduler runs your calendar — rent posting, late fees, lease rollovers, preventive maintenance — and every AI action lands in your approval queue until you dial up autonomy.</p>`)}
  `);
}

export function routes(r: Router): void {
  r.get('/welcome', requireStaff, (rq) => {
    const ctx = rq.ctx as Ctx;
    if (getSetting<boolean>(ctx, 'onboarding_dismissed') === true) return redirect('/');
    const steps = onboardingSteps(ctx);
    const p = onboardingProgress(ctx);
    const pct = Math.round((p.done / p.total) * 100);
    const manage = can(ctx, 'properties:manage');
    return shell(rq, {
      title: `Welcome to StayLeased`,
      active: '/welcome',
      subtitle: ctx.orgKind === 'live'
        ? 'Let’s move your portfolio in. Most companies are fully set up from a single rent-roll upload.'
        : 'This demo org is already fully set up — this page shows what a new customer sees.',
      content: html`
        <div class="card" style="margin-bottom:14px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
            <div><b>${p.done} of ${p.total}</b> <span class="muted">steps complete</span></div>
            <div style="flex:1;min-width:160px;max-width:420px;background:var(--line,#e5e7eb);border-radius:99px;height:8px;overflow:hidden">
              <div style="width:${pct}%;height:8px;background:#2563eb"></div>
            </div>
            ${when(p.required_done, () => html`<form method="post" action="/welcome/dismiss"><button class="btn btn-ghost">Finish setup — go to dashboard</button></form>`)}
          </div>
        </div>
        ${docsChecklist()}
        ${steps.map((s, i) => html`
          <div class="card" style="margin-bottom:10px;${s.done ? 'opacity:.72' : ''}">
            <div style="display:flex;gap:14px;align-items:flex-start">
              <div style="flex:none;width:30px;height:30px;border-radius:99px;display:flex;align-items:center;justify-content:center;${s.done ? 'background:#dcfce7;color:#15803d' : 'background:#eff6ff;color:#2563eb;font-weight:700'}">
                ${s.done ? CHECK : String(i + 1)}
              </div>
              <div style="flex:1">
                <div style="font-weight:600">${s.title}${s.optional ? html` <span class="muted small">(optional)</span>` : ''}</div>
                <div class="muted small" style="margin:4px 0 10px">${s.desc}</div>
                ${when(!s.done && manage, () => html`<div class="btn-row">
                  ${s.links.map(([href, label], li) => html`<a class="btn ${li > 0 ? 'btn-ghost' : ''}" href="${href}">${label}</a>`)}
                  ${when(!!s.optional, () => html`<form method="post" action="/welcome/skip" style="display:inline"><input type="hidden" name="step" value="${s.key}" /><button class="btn btn-ghost" type="submit">Skip for now</button></form>`)}
                </div>`)}
              </div>
            </div>
          </div>`)}
      `,
    });
  });

  r.post('/welcome/skip', requireStaff, (rq) => {
    const ctx = rq.ctx as Ctx;
    const step = String(rq.body.step || '');
    if (['financials', 'vendors', 'team', 'connections'].includes(step)) {
      setSetting(ctx, `onb_skip_${step}`, true);
    }
    return redirect('/welcome');
  });

  r.post('/welcome/dismiss', requireStaff, (rq) => {
    setSetting(rq.ctx as Ctx, 'onboarding_dismissed', true);
    return redirect('/', 'You’re set up. Welcome aboard!');
  });
}
