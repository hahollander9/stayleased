import { html, raw, when } from '../../lib/html.ts';
import { htmlRes, redirect, textRes, type Router, type Rq, type Res } from '../../lib/http.ts';
import { rateLimit } from '../../lib/auth.ts';
import { q1, insert } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso } from '../../lib/dates.ts';
import { askRoutes } from './ask.ts';
import { llmStatus } from '../../lib/sim/llm.ts';
import { mkHeader, mkFooter, mkChromeScript, mkSignupOpen, mkSeoHead, orgLd, ldJson, gaSnippet, siteOrigin, MARKETING_CSS } from './chrome.ts';
import { THEME_BOOT_JS } from '../../ui/ui.ts';

/** The platform marketing homepage — the front door for logged-out visitors.
 * Architecture v3 (2026-08-05, per the differentiation strategy): the page is
 * an argument, not a platform tour. v4 control-first order (2026-08-10,
 * for AI-skeptical buyers): Hero (segment + labor + governance) →
 * approval model FIRST (the leash before the claims; 9:04 pm draft card) →
 * segment evidence band (the staffing dead zone, sourced market data) →
 * AI agents, function-labeled → the system of record as the mechanism that
 * grounds them → architecture comparison (books + bills rows, point-solution
 * column shaped by the EliseAI cluster, no vendor named) → first-week steps →
 * Ask demo → autonomy levels → governance (dark anchor band) →
 * verification band (radical verifiability) → who-it's-for → pricing →
 * walkthrough form → mega-footer. "Everything in one place" was retired as a
 * headline 2026-08-05 — it is the literal hero copy of every incumbent — and
 * demoted from benefit to mechanism. Copy doctrine (2026-08-03): terse
 * noun-phrase headlines, no "you" headlines, information compressed never
 * deleted. Every market figure on the page is sourced (Terner, RHFS, MRI,
 * RentEngine); no usage stats are implied — there are no customers yet.
 * Sales motion (2026-08-10, Henry): demo-led. "Book a live demo" is the
 * primary CTA everywhere; the self-guided demo stays open but demoted to
 * secondary links. The demo itself is NOT gated in this build (that ships
 * later); the verification band's "open to anyone" claim therefore stays.
 * Nav, footer, styles, menus, AND the reveal/stagger motion engine live in
 * chrome.ts, shared with the /platform, /agents, /for, and /legal pages. */

const SUITES: { name: string; href: string; caps: string[] }[] = [
  { name: 'Leasing & Marketing', href: '/platform/leasing-crm', caps: ['Property sites & live pricing', 'Lead CRM & follow-up', 'Applications & screening', 'Leases & e-signature'] },
  { name: 'Payments & Receivables', href: '/platform/rent-collection', caps: ['Automatic monthly billing', 'Autopay & online payment', 'Late-fee policy engine', 'Delinquency workflow'] },
  { name: 'Accounting & Finance', href: '/platform/accounting', caps: ['True double-entry ledger', 'Bank reconciliation & AP', 'Budgets & month-end close', 'Financial statements & reports'] },
  { name: 'Facilities & Maintenance', href: '/platform/maintenance', caps: ['Work orders & triage', 'Vendor dispatch & turns', 'Preventive schedules', 'Emergency escalation'] },
  { name: 'Resident Services', href: '/platform/resident-portal', caps: ['Rent online with autopay', 'Requests with photos', 'Documents & history', 'Announcements'] },
  { name: 'Reporting & Analytics', href: '/platform/reports', caps: ['50 standard reports', 'Custom report builder', 'Scheduled delivery', 'CSV & PDF export'] },
];

const STEPS: { n: string; name: string; tag: string; body: string }[] = [
  { n: '1', name: 'Import the portfolio', tag: 'About an hour', body: 'A rent roll from Buildium, AppFolio, or a spreadsheet builds the system.' },
  { n: '2', name: 'Review and approve drafts', tag: 'Week one', body: 'Every draft waits in the approval queue. Nothing sends without sign-off.' },
  { n: '3', name: 'Delegate proven work', tag: 'When ready', body: 'Authorize what is consistently approved to run autonomously. Reversible anytime.' },
];

const MODES: { l: string; name: string; body: string }[] = [
  { l: '1', name: 'Draft for approval', body: 'The default — every action waits for sign-off.' },
  { l: '2', name: 'Autonomous within limits', body: 'Routine work runs in bounds; the unusual escalates.' },
  { l: '3', name: 'Fully autonomous, audited', body: 'Delegated work runs end to end, every action logged.' },
];

/** The staffing dead zone, in checkable numbers. Sources stay on the page —
 * market data only, never implied usage stats (there are no customers yet). */
const EVIDENCE: { n: string; body: string; src: string }[] = [
  { n: '17%', body: 'of U.S. rental housing sits in buildings of 5–49 units', src: 'Terner Center, UC Berkeley' },
  { n: '~70%', body: 'of rental properties are owned by individual investors', src: 'HUD / Census RHFS 2021' },
  { n: '5–10%', body: 'of collected rent for full-service management, plus ½–1 month’s rent per new lease', src: 'MRI Software fee survey' },
  { n: '56.8%', body: 'of rental inquiries arrive outside office hours', src: 'RentEngine industry analysis' },
];

/** Agents labeled as AI software with plain function descriptors — the
 * humanlike role titles ("the collections clerk") were retired 2026-08-10:
 * in this industry "agent" reads as a human job, and the price story only
 * works because these are software. Names are pinned by e2e. */
const AGENTS: { role: string; name: string; blurb: string; ico: string }[] = [
  { role: 'AI · lead response & tours', name: 'Leasing Agent', blurb: 'Answers the 9:04 pm Zillow lead in seconds and books the Saturday tour.', ico: 'chat' },
  { role: 'AI · maintenance intake, 24/7', name: 'Maintenance Agent', blurb: 'Triages the 2 am call, dispatches within limits, and escalates every emergency to a human.', ico: 'wrench' },
  { role: 'AI · collections & delinquency', name: 'Payments Agent', blurb: 'Runs the delinquency sequence inside set limits, in the approved tone.', ico: 'bank' },
  { role: 'AI · renewals & expirations', name: 'Renewals Agent', blurb: 'Prepares offers inside approved pricing bounds, ahead of every expiration.', ico: 'refresh' },
  { role: 'AI · call summaries', name: 'Call Analysis', blurb: 'Summarizes every call and files the follow-ups.', ico: 'phone' },
  { role: 'AI · portfolio answers', name: 'Ask StayLeased', blurb: 'Answers operational questions from the live records.', ico: 'spark' },
];

const VERIFY: { head: string; body: string; href?: string }[] = [
  { head: 'Live demo, open to anyone', body: 'Fully populated — self-guided, or shown live on a demo call.', href: '/login' },
  { head: 'Pricing, published', body: 'On this page. No quotation process.', href: '#pricing' },
  { head: 'Build status, published in the product', body: 'Working now vs. coming soon — including what is still simulated.' },
  { head: 'Records, the operator’s property', body: 'Full export at any time, in open formats.' },
  { head: 'Every action on the audit trail', body: 'Human or AI — logged, attributed, reviewable.' },
];

const SOLUTIONS: { name: string; body: string }[] = [
  { name: 'Self-managing owners', body: 'Full operating coverage, every decision retained.' },
  { name: 'Small management companies', body: 'Every property in one system, owner-ready financials.' },
  { name: 'Growing portfolios', body: 'Add buildings without adding headcount.' },
];

/** Homepage FAQ (2026-08-12). Every answer restates claims already made and
 * pinned elsewhere on the site — approval default, real double-entry, the
 * afternoon import, early-access pricing, staged-rollout honesty — so the
 * FAQPage schema introduces no new claims to defend. Register: operator
 * language, no invented customers or metrics. */
const HOME_FAQ: { q: string; a: string }[] = [
  { q: 'What does the AI send without a human seeing it first?', a: 'Nothing, by default. Every agent drafts into an approval queue — Approve, Edit, or Reject — and autonomy is granted per task type, within set limits, only when the operator turns it up. It is reversible at any time, and every action lands on the audit trail either way.' },
  { q: 'Is the accounting real double-entry bookkeeping?', a: 'Yes. Every charge and payment posts as a balanced journal entry to a real general ledger — trial balance, bank reconciliation, and financial statements run from the same books as the 50-report catalog. Nothing on the screen is a display layer over a spreadsheet.' },
  { q: 'How long does getting started take?', a: 'About an afternoon. A rent roll from Buildium, AppFolio, or a spreadsheet builds the portfolio — units, leases, rents, and balances — with every import reviewed and approved before it applies. Balances carry over as opening entries, so collections start from truth.' },
  { q: 'What does StayLeased cost?', a: 'Early access is free, by invitation: the complete platform, with no quotation process and no implementation fees. Records remain the operator’s property, with full export at any time — including on the way out.' },
  { q: 'Which parts are still rolling out?', a: 'Card and ACH processing, screening-bureau data, listing syndication, and outbound carrier delivery are in staged rollout. The product labels what is live and what is coming on its Connections page, and every claim on this page is a working screen in the live demo.' },
];

function cube(n: number): string {
  const hues = ['#2DD4BF', '#34D399', '#6EE7B7', '#10B981', '#059669'];
  const c = hues[n % hues.length]!;
  return `<svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3 29 10v12L16 29 3 22V10z" fill="${c}" opacity=".16"/><path d="M16 3 29 10 16 17 3 10z" fill="${c}" opacity=".55"/><path d="M16 17v12L3 22V10z" fill="${c}" opacity=".35"/><path d="M16 17v12l13-7V10z" fill="${c}"/></svg>`;
}

/** Stroke icon set for the agent roster — same language as the logo mark
 * (stroke-based, inherits color). SVG only; no emoji-as-icon anywhere. */
const AGENT_ICONS: Record<string, string> = {
  chat: '<path d="M21 12.5a8.4 8.4 0 0 1-8.5 8.3 8.9 8.9 0 0 1-3.7-.8L3 21l1.1-5.4a8 8 0 0 1-1.1-4A8.4 8.4 0 0 1 11.5 3.3 8.4 8.4 0 0 1 21 12.5z"/><path d="M8.5 11.5h7M8.5 14.5h4.5"/>',
  wrench: '<path d="M14.7 6.3a4.6 4.6 0 0 0-6 5.9L3 18l3 3 5.8-5.7a4.6 4.6 0 0 0 5.9-6l-3.2 3.2-2.8-.7-.7-2.8z"/>',
  bank: '<path d="M3 9.5 12 4l9 5.5"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8"/><path d="M3 20h18"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.9-2.9"/><path d="M5 4v4.3h4.3"/><path d="M4 13a8 8 0 0 0 14.9 2.9"/><path d="M19 20v-4.3h-4.3"/>',
  phone: '<path d="M6.8 3.5c.5 0 1 .3 1.2.8l1.3 2.9c.2.5.1 1.1-.3 1.5l-1.2 1.2a13.5 13.5 0 0 0 6.3 6.3l1.2-1.2c.4-.4 1-.5 1.5-.3l2.9 1.3c.5.2.8.7.8 1.2v2.3c0 .8-.7 1.5-1.5 1.4C10.6 20.3 3.7 13.4 3.1 5c-.1-.8.6-1.5 1.4-1.5h2.3z"/>',
  spark: '<path d="M12 3.5 13.8 9l5.5 1.8-5.5 1.8L12 18l-1.8-5.4L4.7 10.8 10.2 9z"/><path d="M19 15.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z"/>',
};
function agentIcon(k: string): string {
  // pathLength=1 normalizes every stroke for the one-shot draw-in entrance
  const paths = (AGENT_ICONS[k] || AGENT_ICONS['spark'])!.replace(/<path /g, '<path pathLength="1" ');
  return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

/** Small check mark used in the comparison table's yes-cells. */
const CHECK = '<svg class="mk-ck" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Yes"><path d="M4.5 12.8 9.7 18 19.5 6.5"/></svg>';

/** Wrap the numeric runs of an evidence figure so the chrome script can
 * count them up once on entry (one-shot; final values are served in the
 * HTML, so no-JS, crawlers, and reduced-motion all see the real numbers).
 * Each run reserves its final width in ch so the count never shifts layout. */
function statNum(v: string) {
  return raw(v.replace(/(\d+(?:\.\d+)?)/g, (m) => `<i class="mk-n" data-count="${m}">${m}</i>`));
}

/** Numbered band kicker — the page reads as a guided argument, 01 → 12. */
function kick(n: string, label: string) {
  return raw(`<span class="mk-kn">${n}</span>${label}`);
}

export function marketingHome(rq: Rq): Res {
  const signupOpen = mkSignupOpen();
  const thanks = rq.query.get('walkthrough') === 'thanks';
  const aiLive = llmStatus().live;
  const ASK_CHIPS = ["What's my occupancy?", "How's rent collection this month?", 'Any urgent maintenance?', "Who's at risk of non-renewal?"];
  const SALES_CHIPS = ['What does it cost?', 'How do I switch from Buildium or AppFolio?', 'What does the AI do?'];

  const body = html`
<div id="mkprog" aria-hidden="true"></div>
${mkHeader()}

<section class="mk-hero" id="top">
  <div class="mk-hero-clip" aria-hidden="true"></div>
  <div class="mk-wrap mk-hero-in">
    <div class="mk-hero-copy">
      <div class="mk-kicker">Property management software for buildings of 10–100 units</div>
      <h1>Property management that does the work<span class="mk-dot">.</span></h1>
      <p class="mk-sub">AI agents staff the leasing desk, collections, maintenance intake, and the books — drafting into an approval queue the operator controls, on one system of record built for small multifamily.</p>
      <div class="mk-cta-row">
        <a class="mk-btn mk-btn-solid mk-btn-lg" href="#walkthrough">Book a live demo</a>
        ${signupOpen ? html`<a class="mk-btn mk-btn-line mk-btn-lg" href="/signup">Create your company</a>` : html`<a class="mk-btn mk-btn-line mk-btn-lg" href="/login">Explore the live demo</a>`}
      </div>
      <div class="mk-hero-note">Portfolios import from Buildium, AppFolio, or spreadsheets in a single afternoon.${when(signupOpen, () => html` <a href="/login">Self-guided demo →</a>`)}</div>
      <a class="mk-scrollcue" href="#segment" aria-label="Continue to the next section"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg></a>
    </div>
  </div>
  <div class="mk-wrap mk-vigrow" aria-hidden="true">
    <div class="mk-vig">
      <div class="mk-vig-head"><span class="mk-vig-av">SR</span><div><b>Ask StayLeased</b><span>AI portfolio assistant</span></div><span class="mk-vig-live"><i></i>DEMO</span></div>
      <div class="mk-vig-msg you">What's my occupancy?</div>
      <div class="mk-vig-msg agent">Occupancy is 93.1% — 362 of 389 units, with 15 vacant-ready and 8 in turnover averaging 6 days to ready.</div>
    </div>
    <div class="mk-vig">
      <div class="mk-vig-head"><span class="mk-vig-av">PA</span><div><b>Payments Agent</b><span>AI agent · demo portfolio</span></div><span class="mk-vig-live"><i></i>DEMO</span></div>
      <div class="mk-vig-task"><i>✓</i>3 residents past due on rent</div>
      <div class="mk-vig-task"><i>✓</i>Reminders drafted in the approved tone</div>
      <div class="mk-vig-task"><i>✓</i>Payment plan prepared — Keller household</div>
      <div class="mk-vig-task hold"><i>●</i>4 drafts queued<span class="mk-vig-chip warn">awaiting approval</span></div>
    </div>
    <div class="mk-vig">
      <div class="mk-vig-head"><span class="mk-vig-av">MA</span><div><b>Maintenance Agent</b><span>AI triage · 2:14 am</span></div><span class="mk-vig-live"><i></i>DEMO</span></div>
      <div class="mk-vig-msg you">"There's water pooling under my water heater."</div>
      <div class="mk-vig-task"><i>✓</i>Not an emergency — triaged routine</div>
      <div class="mk-vig-task hold"><i>●</i>Plumber dispatch drafted<span class="mk-vig-chip warn">awaiting approval</span></div>
    </div>
  </div>
</section>

<section class="mk-band mk-band-alt" id="newtoai">
  <div class="mk-wrap mk-ask-grid">
    <div>
      <div class="mk-kicker">${kick('01', 'The approval model')}</div>
      <h2 class="mk-h2">Nothing reaches a resident without sign-off.</h2>
      <p class="mk-lead" style="margin-bottom:22px">Agents read what arrives, draft the response, and queue it — Approve, Edit, or Reject. Every figure in every draft comes from the live system, and every action lands on the audit trail.</p>
      <div class="mk-cta-row" style="margin-top:24px">
        <a class="mk-btn mk-btn-solid" href="/agents/new-to-ai">How the AI operates</a>
        <a class="mk-btn mk-btn-line" href="/login">Observe it in the demo</a>
      </div>
    </div>
    <div class="mk-nta-card" aria-hidden="true">
      <div class="mk-nta-row"><span class="mk-nta-time">9:04 pm</span> New lead from Zillow: <i>"Hi — is the 2 bedroom still available? Could I see it this weekend?"</i></div>
      <div class="mk-nta-draft">
        <div class="mk-nta-draft-tag">AI draft · waiting for your approval</div>
        <p>"Hi Sam — yes! The 2BR at Summit Ridge is available at $1,450, and Saturday works: I have 10:00, 11:30, or 2:00 open for a tour. Want me to hold one for you?"</p>
        <div class="mk-nta-actions"><span class="mk-nta-ok">✓ Approve</span><span class="mk-nta-edit">Edit</span><span class="mk-nta-skip">Reject</span></div>
      </div>
      <div class="mk-nta-note">Availability, pricing, and tour times come from the live system at the moment of drafting.</div>
    </div>
  </div>
</section>

<section class="mk-band" id="segment">
  <div class="mk-wrap">
    <div class="mk-kicker">${kick('02', 'The staffing dead zone')}</div>
    <h2 class="mk-h2">Built for the middle of the market.</h2>
    <p class="mk-lead">A 50-unit building generates a full-time manager’s workload on a part-time manager’s budget. Enterprise platforms set unit minimums above it, landlord apps stop short of real accounting — so the middle mostly manages itself. StayLeased is built for exactly this segment.</p>
    <div class="mk-stats">
      ${EVIDENCE.map((e) => html`<div class="mk-stat"><b>${statNum(e.n)}</b><span>${e.body}</span><i>${e.src}</i></div>`)}
    </div>
  </div>
</section>

<section class="mk-band mk-band-alt" id="agents">
  <div class="mk-wrap">
    <div class="mk-kicker">${kick('03', 'The agents')}</div>
    <h2 class="mk-h2">AI agents for the work a small building can’t staff.</h2>
    <p class="mk-lead">Software, not staffing. Six AI agents, each with one job — every draft into the approval queue, every action within configured authority.</p>
    <div class="mk-grid3">
      ${AGENTS.map((a) => html`<div class="mk-card mk-agent">
        <span class="mk-agent-ico">${raw(agentIcon(a.ico))}</span>
        <div class="mk-agent-role">${a.role}</div>
        <h3>${a.name}</h3><p>${a.blurb}</p>
      </div>`)}
    </div>
    <div class="mk-inline-cta"><a class="mk-btn mk-btn-solid" href="#walkthrough">See the agents in a live demo</a></div>
  </div>
</section>

<section class="mk-band" id="platform">
  <div class="mk-wrap">
    <div class="mk-kicker">${kick('04', 'The system of record')}</div>
    <h2 class="mk-h2">Agents that work on the records, not beside them.</h2>
    <p class="mk-lead">An agent is only as reliable as the records under it. StayLeased agents read the live system — the vacancy, the price, the ledger balance, the work-order history — and their approved actions post straight back to it. No sync, no re-keying, no second bill for an AI layer.</p>
    <div class="mk-suites-label">The record the agents maintain</div>
    <div class="mk-suites">
      ${SUITES.map((s2) => html`<a class="mk-suite" href="${s2.href}">
        <h3>${s2.name}</h3>
        <ul>${s2.caps.map((c) => html`<li>${c}</li>`)}</ul>
        <span class="mk-more">Learn more →</span>
      </a>`)}
    </div>
  </div>
</section>

<section class="mk-band mk-band-alt" id="why">
  <div class="mk-wrap">
    <div class="mk-kicker">${kick('05', 'Architecture')}</div>
    <h2 class="mk-h2">A different architecture.</h2>
    <p class="mk-lead">Legacy platforms hold the records; the work stays manual. AI point tools automate one task and need a platform underneath. StayLeased is both layers in one system.</p>
    <div class="mk-compare">
      <table>
        <thead><tr><th scope="col"><span class="sr-only">Capability</span></th><th scope="col">Legacy platforms</th><th scope="col">AI point solutions</th><th scope="col" class="mkc-us">StayLeased</th></tr></thead>
        <tbody>
          <tr><td>Complete system of record</td><td>${raw(CHECK)}</td><td>—</td><td class="mkc-us">${raw(CHECK)}</td></tr>
          <tr><td>Agents that do the daily work</td><td>—</td><td>One function — leasing or maintenance</td><td class="mkc-us">Every function</td></tr>
          <tr><td>The books</td><td>Included</td><td>Not included — a PMS still required</td><td class="mkc-us">Included — true double-entry</td></tr>
          <tr><td>Bills to pay</td><td>One, plus AI add-ons</td><td>Two — the AI layer and the PMS under it</td><td class="mkc-us">One</td></tr>
          <tr><td>Approval-first governance &amp; audit trail</td><td>—</td><td>—</td><td class="mkc-us">${raw(CHECK)}</td></tr>
          <tr><td>Published pricing</td><td>Often quote-led; unit minimums common</td><td>Enterprise contracts</td><td class="mkc-us">Published</td></tr>
          <tr><td>Built for</td><td>Mid-size and larger portfolios</td><td>NMHC Top 50 operators</td><td class="mkc-us">10–100-unit buildings</td></tr>
          <tr><td>Implementation</td><td>Weeks</td><td>Integration project</td><td class="mkc-us">One afternoon</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</section>

<section class="mk-band" id="how">
  <div class="mk-wrap">
    <div class="mk-kicker">${kick('06', 'Getting started')}</div>
    <h2 class="mk-h2">Operational in an afternoon.</h2>
    <p class="mk-lead">Implementation is a data import, not a project.</p>
    <div class="mk-steps">
      ${STEPS.map((st) => html`<div class="mk-step">
        <span class="mk-step-n">${st.n}</span>
        <div><div class="mk-step-head"><b>${st.name}</b><span class="mk-step-tag">${st.tag}</span></div><p>${st.body}</p></div>
      </div>`)}
    </div>
  </div>
</section>

<section class="mk-band mk-band-alt" id="ask">
  <div class="mk-wrap mk-ask-grid">
    <div class="mk-ask-copy">
      <div class="mk-kicker mk-kicker-ai">${kick('07', 'Ask StayLeased')}${aiLive ? ' · powered by Claude' : ''}</div>
      <h2 class="mk-h2">Operational questions, answered from the records.</h2>
      <p class="mk-lead">Occupancy, delinquency, expirations, work orders, vendor spend — answered from live portfolio data, every response logged.</p>
      <div class="mk-cta-row"><a class="mk-btn mk-btn-solid" href="#walkthrough">Book a live demo</a></div>
    </div>
    <div class="mk-askbox" id="mk-askbox">
      <div class="mk-askbox-head">
        <div class="mk-askbox-id"><span class="mk-askbox-av">SR</span><div><b>Summit Ridge assistant</b><span>demo company · live data</span></div></div>
        <span class="mk-live"><i></i>${aiLive ? 'LIVE' : 'DEMO'}</span>
      </div>
      <div class="mk-ask-msgs" id="mk-ask-msgs" aria-live="polite"></div>
      <div class="mk-ask-chips" id="mk-ask-chips">
        ${ASK_CHIPS.map((c) => html`<button type="button" class="mk-ask-chip">${c}</button>`)}
      </div>
      <form class="mk-ask-form" id="mk-ask-form" autocomplete="off">
        <input id="mk-ask-input" name="q" placeholder="Ask anything…" maxlength="500" aria-label="Ask StayLeased" />
        <button type="submit" aria-label="Send"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>
      </form>
    </div>
  </div>
</section>

<section class="mk-band" id="automation">
  <div class="mk-wrap">
    <div class="mk-kicker">${kick('08', 'Autonomy')}</div>
    <h2 class="mk-h2">Three levels of autonomy.</h2>
    <p class="mk-lead">Set per property and per function; expanded only by explicit authorization.</p>
    <div class="mk-levels">
      ${MODES.map((lv, i) => html`<div class="mk-level">
        <div class="mk-level-cube">${raw(cube(i))}</div>
        <div><div class="mk-level-head"><b>${lv.l}</b> · ${lv.name}</div><p>${lv.body}</p></div>
      </div>`)}
    </div>
  </div>
</section>

<section class="mk-band mk-dark" id="governance">
  <div class="mk-wrap">
    <div class="mk-kicker">${kick('09', 'Governance')}</div>
    <h2 class="mk-h2">Governance and oversight.</h2>
    <p class="mk-lead">One governance framework for every agent. Every action — human or AI — on the record.</p>
    <ul class="mk-checks">
      <li>Fair-housing guardrails enforced in code</li>
      <li>Payment plans and concessions bounded by set limits</li>
      <li>Autonomy configured per property, per function</li>
      <li>One control halts all AI activity instantly</li>
      <li>Complete audit trail of every action</li>
      <li>Full data ownership — export anytime</li>
    </ul>
  </div>
</section>

<section class="mk-band" id="verification">
  <div class="mk-wrap">
    <div class="mk-kicker">${kick('10', 'Verification')}</div>
    <h2 class="mk-h2">Verification, not claims.</h2>
    <p class="mk-lead">Software that asks to run a building should not ask for faith. Everything on this page can be checked directly.</p>
    <div class="mk-verify">
      ${VERIFY.map((v) => v.href
        ? html`<a class="mk-vitem" href="${v.href}"><span class="mk-vck" aria-hidden="true"></span><span class="mk-vbody"><b>${v.head}</b><span>${v.body}</span></span><span class="mk-varrow" aria-hidden="true">→</span></a>`
        : html`<div class="mk-vitem"><span class="mk-vck" aria-hidden="true"></span><span class="mk-vbody"><b>${v.head}</b><span>${v.body}</span></span></div>`)}
    </div>
  </div>
</section>

<section class="mk-band mk-band-alt" id="solutions">
  <div class="mk-wrap">
    <div class="mk-kicker">${kick('11', 'Who it’s for')}</div>
    <h2 class="mk-h2">Built for independent operators.</h2>
    <p class="mk-lead">Enterprise software is built for institutions. StayLeased is built for the owners and small firms that run most of America’s rental housing.</p>
    <div class="mk-grid3">
      ${SOLUTIONS.map((s2) => html`<div class="mk-card"><h3>${s2.name}</h3><p>${s2.body}</p></div>`)}
    </div>
  </div>
</section>

<section class="mk-band" id="pricing">
  <div class="mk-wrap">
    <div class="mk-kicker">${kick('12', 'Pricing')}</div>
    <h2 class="mk-h2">Straightforward pricing.</h2>
    <p class="mk-lead">No quotation process and no implementation fees.</p>
    <div class="mk-price-row">
      <div class="mk-price">
        <div class="mk-price-tag">Early access</div>
        <div class="mk-price-big">Free</div>
        <p>The complete platform for early-access partners. Records remain the operator’s property — export anytime. Invitation required.</p>
        <a class="mk-btn mk-btn-solid" href="#walkthrough">Request an invitation</a>
      </div>
      <div class="mk-price">
        <div class="mk-price-tag">What it replaces</div>
        <div class="mk-price-big">$300–800<span>/mo</span></div>
        <p>Typical monthly software spend for a small portfolio on legacy platforms.</p>
        <ul class="mk-price-list">
          <li>Platform subscription, priced per unit</li>
          <li>Transaction and e-payment fees on top</li>
          <li>AI, if offered at all, as a separate contract</li>
        </ul>
      </div>
    </div>
  </div>
</section>

<section class="mk-band mk-band-alt" id="walkthrough">
  <div class="mk-wrap mk-two-col">
    <div>
      <h2 class="mk-h2">See it do the work in a live demo.</h2>
      <p class="mk-lead">A live demo runs in the working system — every screen live, every agent at work, on a fully populated portfolio. Describe the portfolio and we will set one up.</p>
      <div class="mk-cta-row">
        <a class="mk-btn mk-btn-line mk-btn-lg" href="/login">Explore the self-guided demo</a>
        ${when(signupOpen, () => html`<a class="mk-btn mk-btn-line mk-btn-lg" href="/signup">Create your company</a>`)}
      </div>
    </div>
    <div class="mk-form-card">
      ${thanks
        ? html`<div class="mk-thanks"><b>Got it — thank you.</b><br/>We'll reach out within one business day to set up your demo${signupOpen ? ' and invite code' : ''}.</div>`
        : html`<form method="post" action="/company/walkthrough">
            <h3>Book a live demo</h3>
            <div class="mk-form-grid">
              <label>Name<input name="name" required /></label>
              <label>Work email<input name="email" type="email" required /></label>
              <label>Company<input name="company" /></label>
              <label>Units managed<select name="units"><option>1–50</option><option>51–150</option><option>151–500</option><option>501–2,500</option><option>2,500+</option></select></label>
            </div>
            <label class="mk-form-full">Anything specific you want to see?<input name="note" placeholder="e.g. moving off AppFolio, ~120 units" /></label>
            <button class="mk-btn mk-btn-solid" type="submit">Request a demo</button>
            <p class="mk-form-note">Demo requests are answered within one business day.</p>
          </form>`}
    </div>
  </div>
</section>

<section class="mk-band" id="faq">
  <div class="mk-wrap">
    <div class="mk-kicker">Common questions</div>
    <h2 class="mk-h2">Direct answers.</h2>
    <p class="mk-lead">Every answer below is checkable in the live demo — and the assistant on this page answers anything else from the product itself.</p>
    <div class="mkp-faq" style="margin-top:26px">
      ${HOME_FAQ.map((f, i) => html`<details ${i === 0 ? 'open' : ''}><summary>${f.q}</summary><div class="mkp-a">${f.a}</div></details>`)}
    </div>
  </div>
</section>

${mkFooter()}

<button id="mktop" type="button" aria-label="Back to top" title="Back to top">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
</button>

<div id="mkchat" class="mk-chat">
  <div class="mk-chat-panel" id="mkchat-panel" role="dialog" aria-label="Ask StayLeased" aria-hidden="true">
    <div class="mk-chat-head">
      <div class="mk-chat-id"><span class="mk-chat-av">SL</span><div><b>Ask StayLeased</b><span>${aiLive ? 'AI · powered by Claude' : 'AI · product questions, answered'}</span></div></div>
      <button class="mk-chat-close" id="mkchat-close" type="button" aria-label="Close">✕</button>
    </div>
    <div class="mk-chat-msgs" id="mkchat-msgs" aria-live="polite">
      <div class="mk-msg agent">Hello — I am StayLeased’s AI assistant. I can answer questions about the product: pricing, migrating from your current software, what the AI agents do, and how to get started.</div>
    </div>
    <div class="mk-chat-chips" id="mkchat-chips">
      ${SALES_CHIPS.map((c) => html`<button type="button" class="mk-ask-chip">${c}</button>`)}
    </div>
    <form class="mk-chat-form" id="mkchat-form" autocomplete="off">
      <input id="mkchat-input" name="q" placeholder="Ask anything…" maxlength="500" aria-label="Ask StayLeased" />
      <button type="submit" aria-label="Send"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>
    </form>
  </div>
  <button class="mk-chat-launch" id="mkchat-launch" type="button" aria-label="Ask StayLeased">
    <svg class="mk-chat-ico-open" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
    <span>Ask StayLeased</span>
  </button>
</div>

<script>
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // nav dropdowns, mobile menu, and ALL reveal/stagger choreography live in
  // the shared chrome script — the homepage only adds its own widgets here.

  // scroll progress bar + back-to-top on scroll
  var prog = document.getElementById('mkprog');
  var toTop = document.getElementById('mktop');
  function onScroll() {
    var h = document.documentElement;
    var y = window.pageYOffset || h.scrollTop;
    var max = (h.scrollHeight - h.clientHeight) || 1;
    var p = Math.min(1, Math.max(0, y / max));
    if (prog) prog.style.transform = 'scaleX(' + p + ')';
    if (toTop) toTop.classList.toggle('show', y > 560);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  if (toTop) toTop.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  });

  // ---------- Ask StayLeased (in-page demo panel + floating sales widget) ----------
  function scrollDown(box) { box.scrollTop = box.scrollHeight; }

  function typeInto(el, text, box, done) {
    if (reduce) { el.textContent = text; scrollDown(box); if (done) done(); return; }
    var i = 0, n = text.length;
    // reveal a few chars per frame so long answers still feel quick
    var per = n > 240 ? 3 : n > 120 ? 2 : 1;
    function tick() {
      i = Math.min(n, i + per);
      el.textContent = text.slice(0, i);
      scrollDown(box);
      if (i < n) setTimeout(tick, 16); else if (done) done();
    }
    tick();
  }

  // per-box conversation memory → real multi-turn chat when Claude is live
  function hist(box) { if (!box._hist) box._hist = []; return box._hist; }

  function ask(question, box, mode, opts, done) {
    opts = opts || {};
    if (box._busy || !question) { if (done) done(false); return; }
    box._busy = true;
    if (opts.clear) { box.innerHTML = ''; box._hist = []; }
    var you = document.createElement('div'); you.className = 'mk-msg you'; you.textContent = question;
    box.appendChild(you);
    var agent = document.createElement('div'); agent.className = 'mk-msg agent';
    agent.innerHTML = '<span class="mk-typing"><i></i><i></i><i></i></span>';
    box.appendChild(agent); scrollDown(box);
    var h = hist(box).slice(-8);
    fetch('/company/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'origin': location.origin },
      body: 'q=' + encodeURIComponent(question) + '&mode=' + encodeURIComponent(mode || 'demo') + '&history=' + encodeURIComponent(JSON.stringify(h)),
    }).then(function (r) { return r.json(); }).then(function (data) {
      var answer = (data && data.answer) || 'Sorry — I could not reach the assistant just now.';
      hist(box).push({ role: 'you', text: question });
      hist(box).push({ role: 'agent', text: answer });
      agent.textContent = '';
      typeInto(agent, answer, box, function () { box._busy = false; if (done) done(true); });
    }).catch(function () {
      agent.textContent = 'Sorry — I could not reach the assistant just now. Try again in a moment.';
      box._busy = false; if (done) done(false);
    });
  }

  function wireAsk(formId, inputId, msgsId, chipsId, mode, onUser, onChip) {
    var form = document.getElementById(formId), input = document.getElementById(inputId), box = document.getElementById(msgsId);
    if (!form || !input || !box) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var q = input.value.trim(); if (!q) return;
      input.value = '';
      if (onUser) onUser();
      ask(q, box, mode);
    });
    var chips = chipsId && document.getElementById(chipsId);
    if (chips) chips.addEventListener('click', function (e) {
      var b = e.target.closest('.mk-ask-chip'); if (!b) return;
      if (onChip) { onChip(b); return; }
      if (onUser) onUser();
      ask(b.textContent.trim(), box, mode);
    });
  }

  // ---- in-page demo panel: auto-plays through the questions, chips jump ----
  var askMsgs = document.getElementById('mk-ask-msgs');
  var askChipsBox = document.getElementById('mk-ask-chips');
  var askChips = askChipsBox ? Array.prototype.slice.call(askChipsBox.querySelectorAll('.mk-ask-chip')) : [];
  var autoTimer = null, autoOn = false, autoIdx = 0;

  function markChip(i) {
    askChips.forEach(function (c, k) { c.classList.toggle('active', k === i); });
  }
  function stopAuto() {
    autoOn = false;
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
    markChip(-1);
  }
  function playCycle(i, first) {
    if (!autoOn || !askMsgs) return;
    autoIdx = i % askChips.length;
    markChip(autoIdx);
    ask(askChips[autoIdx].textContent.trim(), askMsgs, 'demo', { clear: !first ? true : askMsgs.childElementCount > 0 }, function (ok) {
      if (!autoOn) return;
      autoTimer = setTimeout(function () { playCycle(autoIdx + 1, false); }, reduce ? 4200 : 2600);
    });
  }
  function startAuto(fromIdx) {
    if (!askChips.length || !askMsgs) return;
    stopAuto(); autoOn = true;
    playCycle(fromIdx || 0, true);
  }

  wireAsk('mk-ask-form', 'mk-ask-input', 'mk-ask-msgs', 'mk-ask-chips', 'demo',
    function () { stopAuto(); }, // typing your own question takes over the panel
    function (chipBtn) { // clicking a chip jumps the cycle there and keeps playing
      var i = askChips.indexOf(chipBtn);
      stopAuto(); autoOn = true; playCycle(i < 0 ? 0 : i, false);
    });

  var askDemoed = false;
  if (askMsgs && 'IntersectionObserver' in window) {
    var aio = new IntersectionObserver(function (es) {
      es.forEach(function (en) {
        if (en.isIntersecting && !askDemoed) {
          askDemoed = true; aio.disconnect();
          setTimeout(function () { startAuto(0); }, 450);
        }
      });
    }, { threshold: 0.4 });
    aio.observe(document.getElementById('mk-askbox'));
  }

  // ---- floating widget: sales & product questions (real chat, with memory) ----
  wireAsk('mkchat-form', 'mkchat-input', 'mkchat-msgs', 'mkchat-chips', 'sales');

  // floating chat widget
  var chat = document.getElementById('mkchat');
  var launch = document.getElementById('mkchat-launch');
  var closeb = document.getElementById('mkchat-close');
  var panel = document.getElementById('mkchat-panel');
  function setChat(open) {
    if (!chat) return;
    chat.classList.toggle('open', open);
    document.body.classList.toggle('mk-chat-open', open);
    if (panel) panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open) { var inp = document.getElementById('mkchat-input'); if (inp) setTimeout(function () { inp.focus(); }, 120); }
  }
  if (launch) launch.addEventListener('click', function () { setChat(!chat.classList.contains('open')); });
  if (closeb) closeb.addEventListener('click', function () { setChat(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && chat && chat.classList.contains('open')) setChat(false); });
})();
</script>`;

  const TITLE = 'StayLeased — Property Management That Does the Work';
  const DESC = "Property management software that does the work: AI agents staff the leasing desk, collections, maintenance intake, and the books — every draft under the operator's approval. Built for buildings of 10–100 units.";
  const o = siteOrigin();
  const appLd = ldJson({
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'StayLeased',
    url: `${o}/`,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    description: DESC,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', description: 'Early access — the complete platform, by invitation.' },
    publisher: { '@id': `${o}/#org` },
  });
  const faqLd = ldJson({
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: HOME_FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  });
  return htmlRes(`<!doctype html>${html`<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${TITLE}</title>
<meta name="description" content="${DESC}" />
<meta property="og:title" content="${TITLE}" />
<meta property="og:description" content="AI agents staff the leasing desk, collections, maintenance intake, and the books — every draft queued for the operator's approval. Built for 10–100-unit buildings." />
<meta property="og:type" content="website" /><meta property="og:site_name" content="StayLeased" />
${mkSeoHead('/', TITLE, DESC)}
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
${raw(`<script>${THEME_BOOT_JS}</script>`)}
<link rel="preload" href="/assets/fonts/inter-var.woff2" as="font" type="font/woff2" crossorigin />
<link rel="preload" href="/assets/fonts/space-grotesk-var.woff2" as="font" type="font/woff2" crossorigin />
<style>${raw(MARKETING_CSS)}</style>
${orgLd()}${appLd}${faqLd}${gaSnippet()}
</head><body class="mk">${body}${mkChromeScript()}</body></html>`.s}`);
}

export function homepageRoutes(r: Router): void {
  askRoutes(r);
  r.post('/company/walkthrough', (rq) => {
    if (!rateLimit(`walkthrough:${rq.ip}`, 6, 60000)) return textRes('Too many requests', 429);
    const name = String(rq.body.name || '').trim().slice(0, 80);
    const email = String(rq.body.email || '').trim().toLowerCase().slice(0, 120);
    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return redirect('/#walkthrough');
    if (!q1('SELECT id FROM platform_leads WHERE email=?', email)) {
      insert('platform_leads', {
        id: id('pld'), name, email,
        company: String(rq.body.company || '').trim().slice(0, 120) || null,
        units: String(rq.body.units || '').slice(0, 20) || null,
        note: String(rq.body.note || '').trim().slice(0, 500) || null,
        source: 'homepage', created_at: nowIso(),
      });
    }
    return redirect('/?walkthrough=thanks#walkthrough');
  });
}
