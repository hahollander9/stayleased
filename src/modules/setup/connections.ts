import { html, when, type Raw } from '../../lib/html.ts';
import { redirect, type Router } from '../../lib/http.ts';
import { requireStaff, type Ctx } from '../../lib/auth.ts';
import { audit } from '../../lib/audit.ts';
import { getSetting, setSetting } from '../../lib/settings.ts';
import { llmStatus, llmGenerate } from '../../lib/sim/llm.ts';
import { env } from '../../lib/env.ts';
import { dbPath } from '../../lib/db.ts';
import { isAbsolute } from 'node:path';
import { shell, card, statusBadge, dl } from '../../ui/ui.ts';
import { ilsIntakeCard } from '../m3_crm/ils_email.ts';
import { emailRailStatus } from '../m15_comms/email_rail.ts';

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
  const mail = emailRailStatus(ctx);
  const ai = llmStatus();
  const live = ctx.orgKind === 'live';
  return [
    {
      key: 'ai', name: 'AI brain (Anthropic Claude)',
      desc: ai.live
        ? `Live — model ${ai.model}. Powers Ask StayLeased, lease-PDF reading, and import mapping assist. Agent drafts (leasing, collections, maintenance, renewals) run on the deterministic draft engine during early access — every draft grounded in your live records and queued for approval.`
        : 'Running the built-in demonstration intelligence. When the live AI connection is enabled on the server, Ask StayLeased, document extraction, and mapping assistance switch to live AI; agent drafts stay on the deterministic engine during early access.',
      status: ai.live ? 'live' : 'simulated', href: '/ai',
    },
    {
      key: 'imports', name: 'File import (Excel · CSV · lease PDFs)',
      desc: 'Rent rolls, vendor lists, balances and signed leases — auto-mapped and reviewed in Setup.',
      status: 'live', href: '/setup/import',
    },
    {
      key: 'api', name: 'Integrations',
      desc: 'Org-scoped API keys and webhook endpoints for your own integrations.',
      status: 'live', href: '/admin/api',
    },
    {
      key: 'payments', name: 'Resident payments (ACH & cards)',
      desc: live
        ? 'Real money movement is not connected yet — resident payment screens run on the built-in simulator. Join the waitlist and we\'ll onboard your accounts as the rail opens.'
        : 'Running on the deterministic payments simulator — settlements, NSFs and deposits all behave like the real rail, with no real money.',
      status: live ? 'waitlist' : 'simulated',
      // Named as RESIDENT payments, and the distinction spelled out, because
      // your own subscription IS charged through Stripe: without this line,
      // "Stripe is not connected" on this page and a Stripe-backed billing page
      // two clicks away read as a contradiction.
      note: live
        ? 'Never treat simulated receipts as real funds. Separately: your own StayLeased subscription is billed for real — see Billing.'
        : 'Your own StayLeased subscription is billed separately, and for real — see Billing.',
    },
    {
      key: 'bank', name: 'Bank feeds (Plaid)',
      desc: live
        ? 'Automatic bank-transaction feeds are coming. Today: post your opening balance in Setup and reconcile manually.'
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
      desc: live ? mail.line : 'Outbox simulator — messages are recorded and visible, not delivered externally.',
      status: live ? (mail.state === 'live' ? 'live' : 'waitlist') : 'simulated',
    },
    {
      key: 'pms_sync', name: 'Buildium · AppFolio · Yardi live sync',
      desc: 'A connected two-way sync is on the roadmap. Today their exports import in minutes through Setup — most portfolios move in one sitting.',
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
        ? html`${statusBadge('ok', 'Live')} <span class="muted small">${ai.model} · ${ai.spentToday.toLocaleString('en-US')} of ${ai.dailyCap.toLocaleString('en-US')} daily token budget used. Ask, document reading and mapping assist run on live Claude; agent drafts use the deterministic engine.</span>`
        : html`${statusBadge('pending', 'Demo brain')} <span class="muted small">Demonstration mode. Enable the live AI connection on the server to put Ask, document reading and mapping assist on live Claude.</span>`],
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

/** The six things an owner asks about, each answered in a word.
 *
 * The page used to open on "Platform status" — where the database file lives,
 * which environment variable opens signup — and reach email in the ninth card.
 * The person who came to turn on email is not the person who runs the server.
 * So: a plain list first, one line and one button each; everything about the
 * server folds away below under a heading that says who it is for. */
interface Line { key: string; name: string; state: 'on' | 'off' | 'practice'; says: string; action: Raw | null; extra?: Raw | null }

function statusLines(ctx: Ctx, requested: string[]): Line[] {
  const live = ctx.orgKind === 'live';
  const mail = emailRailStatus(ctx);
  const ai = llmStatus();
  const ask = (key: string): Raw => (requested.includes(key)
    ? html`<span class="pill">Requested ✓</span>`
    : html`<form method="post" action="/setup/connections/request"><input type="hidden" name="rail" value="${key}" /><button class="btn btn-ghost" type="submit">Tell me when it is ready</button></form>`);
  const practice = (says: string): Pick<Line, 'state' | 'says'> => ({ state: 'practice', says });
  return [
    {
      key: 'email', name: 'Email',
      ...(live
        ? { state: mail.state === 'live' ? 'on' as const : 'off' as const, says: mail.line }
        : practice('The practice company never sends real email. Messages are written and saved under Sent messages so you can see exactly what would go out.')),
      action: !live ? html`<a class="btn btn-ghost" href="/outbox">Sent messages</a>`
        : mail.state === 'off' ? ask('messaging')
          : html`<a class="btn${mail.state === 'live' ? ' btn-ghost' : ''}" href="/admin/settings?section=communications">${mail.state === 'live' ? 'Email settings' : 'Turn it on'}</a>`,
      // the test send works before the switch is on — that is its point
      extra: live && mail.state !== 'off'
        ? html`<form method="post" action="/setup/connections/test-email"><button class="btn btn-ghost" type="submit">Send me a test email</button></form>`
        : null,
    },
    {
      key: 'sms', name: 'Text messages',
      ...(live
        ? { state: 'off' as const, says: 'Texts are written and saved, and do not reach a phone yet. Open one under Sent messages to read it and pass it on yourself.' }
        : practice('Texts are written and saved, never sent to a phone.')),
      action: live ? ask('sms') : null,
    },
    {
      key: 'bank', name: 'Bank feed',
      ...(live
        ? { state: 'off' as const, says: 'Your bank does not send transactions here automatically yet. Enter your opening balance in Setup, then upload a statement file or match by hand under Bank accounts.' }
        : practice('The practice company has a pretend bank feed, so reconciling can be tried end to end.')),
      action: live ? ask('bank') : html`<a class="btn btn-ghost" href="/banking">Bank accounts</a>`,
    },
    {
      key: 'payments', name: 'Resident payments',
      ...(live
        ? { state: 'off' as const, says: 'Residents cannot pay by card or bank draft through StayLeased yet. Record the checks, cash and money orders you receive; your books stay right. Your own StayLeased subscription is billed separately, and for real — see Billing.' }
        : practice('Payments settle, bounce and deposit like the real thing, with no real money. Your own StayLeased subscription is billed separately, and for real — see Billing.')),
      action: live ? ask('payments') : null,
    },
    {
      key: 'ils', name: 'Listings',
      ...(live
        ? { state: 'off' as const, says: 'Vacancies are not pushed to Zillow or Apartments.com yet. Your own property websites and inquiry forms work now, and inquiries those sites email you can be read in automatically (below).' }
        : practice('Pretend inquiries arrive each day as if from Zillow and Apartments.com.')),
      action: live ? ask('ils') : null,
    },
    {
      key: 'ai', name: 'AI',
      state: ai.live ? 'on' : live ? 'off' : 'practice',
      says: ai.live
        ? 'On. It answers Ask StayLeased, reads lease PDFs and helps match columns when you upload a file. Drafts for residents always wait for your OK.'
        : 'The built-in practice version is answering. Drafts are still written from your own records and still wait for your OK; the live AI is switched on by whoever runs the server.',
      action: html`<form method="post" action="/setup/connections/test-ai"><button class="btn btn-ghost" type="submit">Test connection</button></form>`,
    },
  ];
}

const STATE_WORD: Record<Line['state'], string> = { on: 'On', off: 'Not connected', practice: 'Practice only' };

export function routes(r: Router): void {
  r.get('/setup/connections', requireStaff, (rq) => {
    const ctx = rq.ctx as Ctx;
    const requested = getSetting<string[]>(ctx, 'integration_interest') || [];
    // the six above have their own lines; these are everything else
    const inList = new Set(['ai', 'payments', 'bank', 'ils', 'messaging']);
    const list = rails(ctx).filter((x) => !inList.has(x.key));
    const working = list.filter((x) => x.status === 'live');
    const rest = list.filter((x) => x.status !== 'live');
    const railCard = (rail: Rail): Raw => html`
      <div class="conn-card">
        <div class="conn-head">${rail.name} ${BADGE[rail.status]}</div>
        <div class="muted small" style="flex:1">${rail.desc}</div>
        ${when(!!rail.note, () => html`<div class="callout bad" style="margin:8px 0 0">${rail.note}</div>`)}
        <div class="btn-row" style="margin-top:10px">
          ${when(rail.key === 'imports', () => html`<a class="btn" href="/setup/import">Try an import</a>`)}
          ${when(!!rail.href && rail.key !== 'imports', () => html`<a class="btn btn-ghost" href="${rail.href}">Open</a>`)}
          ${when(rail.status === 'waitlist', () =>
            requested.includes(rail.key)
              ? html`<span class="pill">Requested ✓</span>`
              : html`<form method="post" action="/setup/connections/request"><input type="hidden" name="rail" value="${rail.key}" /><button class="btn btn-ghost" type="submit">Request access</button></form>`)}
        </div>
      </div>`;
    const lines = statusLines(ctx, requested);
    const on = lines.filter((l) => l.state === 'on').length;
    return shell(rq, {
      title: 'Connections',
      active: '/setup/connections',
      crumbs: [['Setup', '/setup'], ['Connections']],
      subtitle: ctx.orgKind === 'live'
        ? `${on} of ${lines.length} connected. Anything not connected still works inside StayLeased — it just does not reach the outside world yet.`
        : 'This is the practice company: everything works, and nothing reaches a real inbox, phone or bank.',
      content: html`
        ${card('What is connected', html`<ul class="cx-list">
          ${lines.map((l) => html`<li class="cx-line">
            <div class="cx-name"><b>${l.name}</b><span class="cx-state ${l.state}">${STATE_WORD[l.state]}</span></div>
            <p class="cx-says">${l.says}</p>
            <div class="cx-act">${l.action}${l.extra || ''}</div>
          </li>`)}
        </ul>`, { flush: true })}
        ${ilsIntakeCard(ctx)}
        ${when(working.length, () => card('Working now', html`<div class="conn-grid">${working.map(railCard)}</div>`))}
        ${when(rest.length, () => card(ctx.orgKind === 'live' ? 'Coming soon — join the waitlist' : 'Simulated in the demo world', html`<div class="conn-grid">${rest.map(railCard)}</div>`))}
        <details class="cx-server">
          <summary>For whoever runs the server</summary>
          <p class="muted small">Where the data is kept, which AI model answers, and whether new companies can sign up. Nothing here needs changing to use StayLeased day to day.</p>
          ${platformStatusCard(ctx)}
        </details>
      `,
    });
  });

  // Proof, not promises: run one tiny round-trip through the configured brain
  // and report exactly what happened (model + latency, or the demo fallback).
  r.post('/setup/connections/test-ai', requireStaff, async (rq) => {
    const ctx = rq.ctx as Ctx;
    const started = Date.now();
    const res = await llmGenerate({
      system: 'Reply with exactly: OK',
      prompt: `Connection test from org ${ctx.orgId.slice(0, 12)} — reply OK.`,
      fallback: 'OK (demo brain)',
      maxTokens: 8,
      cacheKey: `conn-test:${ctx.orgId}:${Date.now() % 60000}`,
    });
    const ms = Date.now() - started;
    audit(ctx, 'org', ctx.orgId, 'ai_connection_test', null, { live: res.live, ms });
    return redirect('/setup/connections', res.live
      ? `Live round-trip confirmed: ${llmStatus().model} answered in ${ms}ms. Ask, document reading and mapping assist use this same connection.`
      : `The demonstration intelligence answered — the live AI connection is not configured, or the call fell back. Enable it on the server for live AI.`,
      res.live || ctx.orgKind !== 'live' ? undefined : 'err');
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
