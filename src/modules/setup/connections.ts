import { html, raw, when, type Raw } from '../../lib/html.ts';
import { redirect, type Router } from '../../lib/http.ts';
import { requireStaff, type Ctx } from '../../lib/auth.ts';
import { audit } from '../../lib/audit.ts';
import { getSetting, setSetting } from '../../lib/settings.ts';
import { llmStatus } from '../../lib/sim/llm.ts';
import { env } from '../../lib/env.ts';
import { dbPath } from '../../lib/db.ts';
import { isAbsolute } from 'node:path';
import { shell, card, statusBadge, dl } from '../../ui/ui.ts';

/** Connections — one honest page about every external rail.
 * What's live is labeled live; what's simulated says so in plain words; what
 * needs a real-world integration (Stripe, Plaid, ILS feeds, competitor APIs)
 * is a request-access card, not a fake toggle. Trust is the product. */

interface Rail {
  key: string;
  name: string;
  desc: string;
  status: 'live' | 'simulated' | 'waitlist';
  href?: string;
  note?: string;
}

function rails(ctx: Ctx): Rail[] {
  const ai = llmStatus();
  const live = ctx.orgKind === 'live';
  return [
    {
      key: 'ai', name: 'AI brain (Anthropic Claude)',
      desc: ai.live
        ? `Live — model ${ai.model}. Powers lease-PDF reading, import mapping assist, and every AI agent.`
        : 'Running the deterministic demo brain. Set ANTHROPIC_API_KEY on the server to go live — document extraction, agent replies and mapping assist switch to real AI.',
      status: ai.live ? 'live' : 'simulated', href: '/ai',
    },
    {
      key: 'imports', name: 'File import (Excel · CSV · lease PDFs)',
      desc: 'Rent rolls, vendor lists, balances and signed leases — auto-mapped and reviewed in the Migration Center.',
      status: 'live', href: '/setup/import',
    },
    {
      key: 'api', name: 'API & webhooks',
      desc: 'Org-scoped API keys and webhook endpoints for your own integrations.',
      status: 'live', href: '/admin/api',
    },
    {
      key: 'payments', name: 'Payments (ACH & cards)',
      desc: live
        ? 'Real money movement (Stripe) is not connected yet — payment screens run on the built-in simulator. Join the waitlist and we\'ll onboard your accounts as the rail opens.'
        : 'Running on the deterministic payments simulator — settlements, NSFs and deposits all behave like the real rail, with no real money.',
      status: live ? 'waitlist' : 'simulated',
      note: live ? 'Never treat simulated receipts as real funds.' : undefined,
    },
    {
      key: 'bank', name: 'Bank feeds (Plaid)',
      desc: live
        ? 'Automatic bank-transaction feeds are coming. Today: post your opening balance in the Migration Center and reconcile manually.'
        : 'The demo org uses a simulated bank feed for reconciliation.',
      status: live ? 'waitlist' : 'simulated',
    },
    {
      key: 'screening', name: 'Tenant screening bureau',
      desc: live
        ? 'Credit/criminal/eviction screening runs on the built-in simulator until a bureau reseller agreement is in place.'
        : 'Simulated bureau — deterministic reports for the demo cast.',
      status: live ? 'waitlist' : 'simulated',
    },
    {
      key: 'ils', name: 'Listing syndication (Zillow · Apartments.com)',
      desc: live
        ? 'Publishing to ILS networks needs feed partnerships — on the roadmap. Your public property sites and inquiry forms are live already.'
        : 'Simulated ILS: demo leads arrive daily as if from Zillow/Apartments.com.',
      status: live ? 'waitlist' : 'simulated',
    },
    {
      key: 'messaging', name: 'Email & SMS delivery',
      desc: live
        ? 'Messages compose, thread and audit fully, but outbound delivery to real phones/inboxes awaits the delivery rail (Twilio/for-email). Residents see everything in their portal today.'
        : 'Outbox simulator — messages are recorded and visible, not delivered externally.',
      status: live ? 'waitlist' : 'simulated',
    },
    {
      key: 'pms_sync', name: 'Buildium · AppFolio · Yardi live sync',
      desc: 'A connected two-way sync is on the roadmap. Today their exports import in minutes through the Migration Center — most portfolios move in one sitting.',
      status: 'waitlist', href: '/setup/import',
    },
  ];
}

const BADGE: Record<Rail['status'], Raw> = {
  live: statusBadge('ok', 'Live'),
  simulated: statusBadge('pending', 'Simulated'),
  waitlist: statusBadge('draft', 'Coming — join waitlist'),
};

/** Answers "is this actually connected?" at a glance: where the data lives
 * (and whether it survives restarts), whether the AI brain is real, whether
 * signup is open, and what mode this org runs in. */
function platformStatusCard(ctx: Ctx): Raw {
  const ai = llmStatus();
  const persistent = isAbsolute(env('DB') || '');
  const signupOpen = !!env('SIGNUP_CODE');
  return card('Platform status', html`
    ${dl([
      ['Data storage', persistent
        ? html`${statusBadge('ok', 'Persistent')} <span class="muted small">${dbPath()} — customer data survives restarts and deploys.</span>`
        : html`${statusBadge('pending', 'Image-local')} <span class="muted small">The database lives inside the app image and resets on redeploy — fine for a demo, not for customers. Point STAYLEASED_DB at a mounted disk (e.g. /data/stayleased.db).</span>`],
      ['AI brain', ai.live
        ? html`${statusBadge('ok', 'Live')} <span class="muted small">${ai.model} · ${ai.spentToday.toLocaleString('en-US')} of ${ai.dailyCap.toLocaleString('en-US')} daily output tokens used. Document reading, mapping assist and agents are real.</span>`
        : html`${statusBadge('pending', 'Demo brain')} <span class="muted small">Deterministic MockLlm. Set ANTHROPIC_API_KEY to flip everything AI to live Claude.</span>`],
      ['Self-serve signup', signupOpen
        ? html`${statusBadge('ok', 'Open (invite code)')} <span class="muted small">/signup accepts new companies with your invite code.</span>`
        : html`${statusBadge('pending', 'Closed')} <span class="muted small">Set STAYLEASED_SIGNUP_CODE to open invite-code signup.</span>`],
      ['This organization', ctx.orgKind === 'live'
        ? html`${statusBadge('ok', 'Live company')} <span class="muted small">Real calendar, real books — no simulated data is ever generated here.</span>`
        : html`${statusBadge('pending', 'Demo world')} <span class="muted small">Shared demo company with simulated feeds and a time machine. Create a real company at /signup to test with your own documents.</span>`],
      ['Business date', html`<span class="small">${ctx.businessDate}</span>`],
    ])}
  `);
}

export function routes(r: Router): void {
  r.get('/setup/connections', requireStaff, (rq) => {
    const ctx = rq.ctx as Ctx;
    const requested = getSetting<string[]>(ctx, 'integration_interest') || [];
    const list = rails(ctx);
    return shell(rq, {
      title: 'Connections',
      active: '/setup/connections',
      crumbs: [['Setup', '/setup'], ['Connections']],
      subtitle: ctx.orgKind === 'live'
        ? 'What\'s live, what\'s simulated, and what\'s coming. No surprises — simulated rails are labeled, always.'
        : 'The demo org runs every external rail on deterministic simulators, so the whole product works offline.',
      content: html`
        ${platformStatusCard(ctx)}
        ${list.map((rail) => card(null, html`
          <div style="display:flex;gap:14px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap">
            <div style="flex:1;min-width:260px">
              <div style="font-weight:600">${rail.name} ${BADGE[rail.status]}</div>
              <div class="muted small" style="margin-top:4px">${rail.desc}</div>
              ${when(!!rail.note, () => html`<div class="callout bad" style="margin-top:8px">${rail.note}</div>`)}
            </div>
            <div class="btn-row">
              ${when(!!rail.href, () => html`<a class="btn btn-ghost" href="${rail.href}">Open</a>`)}
              ${when(rail.status === 'waitlist', () =>
                requested.includes(rail.key)
                  ? html`<span class="pill">Requested ✓</span>`
                  : html`<form method="post" action="/setup/connections/request"><input type="hidden" name="rail" value="${rail.key}" /><button class="btn btn-ghost" type="submit">Request access</button></form>`)}
            </div>
          </div>
        `))}
        ${when(ctx.orgKind === 'demo', () => raw('<p class="muted small">Tip: in a live customer org this page shows waitlists instead of simulators — nothing simulated ever poses as a real rail.</p>'))}
      `,
    });
  });

  r.post('/setup/connections/request', requireStaff, (rq) => {
    const ctx = rq.ctx as Ctx;
    const rail = String(rq.body.rail || '').slice(0, 30);
    if (rail) {
      const cur = getSetting<string[]>(ctx, 'integration_interest') || [];
      if (!cur.includes(rail)) setSetting(ctx, 'integration_interest', [...cur, rail]);
      audit(ctx, 'org', ctx.orgId, 'integration_interest', null, { rail, by: ctx.userEmail });
    }
    return redirect('/setup/connections', 'Noted — we\'ll reach out when this rail opens for your account.');
  });
}
