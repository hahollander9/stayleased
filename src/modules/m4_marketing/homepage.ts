import { html, raw, when } from '../../lib/html.ts';
import { htmlRes, redirect, textRes, type Router, type Rq, type Res } from '../../lib/http.ts';
import { rateLimit } from '../../lib/auth.ts';
import { q1, insert } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso } from '../../lib/dates.ts';
import { askRoutes } from './ask.ts';
import { llmStatus } from '../../lib/sim/llm.ts';
import { mkHeader, mkFooter, mkChromeScript, mkSignupOpen, MARKETING_CSS } from './chrome.ts';

/** The platform marketing homepage — the front door for logged-out visitors,
 * modeled section-for-section on entrata.com's architecture: sticky nav with
 * mega-dropdowns → hero → two-platforms → six-layer ontology stack
 * (expandable) → L1–L5 automation ladder → agent grid → resident products →
 * governance → property types → walkthrough form → mega-footer. Every claim
 * on this page maps to something the product actually does; the demo login
 * and /signup are one click away everywhere. Nav, footer, styles, and menu
 * behavior live in chrome.ts, shared with the /platform, /resident, /agents,
 * /for, and /legal pages. */

const LAYERS: { n: number; tag: string; name: string; body: string }[] = [
  { n: 6, tag: 'Autonomous Workflows', name: 'Workflow autonomy', body: 'AI capabilities that scale from workflow augmentation to fully autonomous operation — you choose the dial per agent, per property, and change it any time.' },
  { n: 5, tag: 'Agentic Layer', name: 'Where agents act', body: 'AI agents work inside the same systems as your team — drafting, deciding, and executing with a proposal-and-approval trail behind every action.' },
  { n: 4, tag: 'Operational Layer', name: 'System of action', body: 'The CRM, accounting, and property management screens your site and corporate teams work in every day — one login, one nav, no swivel-chair.' },
  { n: 3, tag: 'Ontology Layer', name: 'System of context', body: 'A purpose-built multifamily data model — property → unit → lease → resident → ledger — so people and agents always act on the right information at the right moment.' },
  { n: 2, tag: 'Unified Data Layer', name: 'System of record', body: 'An always-current foundation with resident, asset, property, and financial detail. One database: a lead becomes a lease becomes a ledger entry with no re-keying.' },
  { n: 1, tag: 'Infrastructure', name: 'Foundation', body: 'Multi-tenant cloud foundation with role-based security, org isolation, and a full audit log under everything.' },
];

const LEVELS: { l: string; name: string; body: string }[] = [
  { l: 'L5', name: 'Adaptive self-improvement', body: 'Outcomes from every property feed back so the system tightens the operation over time, not just in a single task.' },
  { l: 'L4', name: 'Interactive agents', body: 'The system initiates, adapts, and follows through with prospects and residents — with full context from leases, payments, and maintenance, plus the escalations you define.' },
  { l: 'L3', name: 'Scalable processing', body: 'High volume, messy inputs, and decisions that need expertise are handled at a scale and depth no operations team can sustain.' },
  { l: 'L2', name: 'Rules-based orchestration', body: 'Structured work runs in sequence: the same inputs, the same steps, the same output, without anyone touching it.' },
  { l: 'L1', name: 'Generative assistance', body: 'The platform answers questions, drafts, and explains using your data and your policies, with an audit trail behind every response.' },
];

const AGENTS: { name: string; blurb: string }[] = [
  { name: 'Leasing', blurb: 'Every inquiry answered in seconds from live availability and pricing. Tours booked, follow-ups run, after-hours covered.' },
  { name: 'Maintenance', blurb: 'Requests triaged on arrival — category, priority, emergency escalation, and troubleshooting before a truck rolls.' },
  { name: 'Payments', blurb: 'Delinquency outreach with tone that matches the balance and days late, payment plans inside your bounds, compliance hard-coded.' },
  { name: 'Renewals', blurb: 'Personalized offers from resident history. Counters evaluated inside your matrix; anything beyond escalates to a human.' },
  { name: 'Call analysis', blurb: 'Summaries, sentiment, intents, and coaching notes from every recorded call — always audited.' },
  { name: 'Ask StayLeased', blurb: 'Staff questions answered from your own operating data through governed service APIs — never raw database access.' },
];

const GOV_CARDS: { name: string; body: string }[] = [
  { name: 'Configurable', body: 'Policies set at the org or property level — late fees, screening criteria, tour hours, autonomy dials — inherited and overridable.' },
  { name: 'SOP-friendly', body: 'Agents operate the way you train your team: your templates, your bounds, your escalation paths.' },
  { name: 'Auditable', body: 'Who did what, when, and why — every human and AI action lands in one reviewable audit trail.' },
  { name: 'Secure', body: 'Role-based permissions, org isolation, and sessions built on modern hashing. No copy-paste of stale sensitive data.' },
  { name: 'Controlled', body: 'Human-in-the-loop by default. Approve, edit, or reject anything an agent proposes — autonomy is earned, not assumed.' },
];

const SOLUTIONS: { name: string; body: string }[] = [
  { name: 'Self-managing owners', body: 'You are the leasing agent, the maintenance coordinator, and the bookkeeper — usually after your day job. The AI takes the night shift: leads answered at 2am, rent chased politely, requests triaged before you wake up.' },
  { name: 'Small management companies', body: 'Run hundreds of doors on a two-person office. One system for every property, owner-ready financials by default, and agents that do the follow-up your team never has time for.' },
  { name: 'Growing portfolios', body: 'Institutional-grade double-entry books, bank reconciliation, and real reporting — without hiring the back office. Add buildings without adding headcount.' },
];

function cube(n: number): string {
  const hues = ['#4653e5', '#12a5a5', '#e8843a', '#8b5ce8', '#2563eb'];
  const c = hues[n % hues.length]!;
  return `<svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3 29 10v12L16 29 3 22V10z" fill="${c}" opacity=".16"/><path d="M16 3 29 10 16 17 3 10z" fill="${c}" opacity=".55"/><path d="M16 17v12L3 22V10z" fill="${c}" opacity=".35"/><path d="M16 17v12l13-7V10z" fill="${c}"/></svg>`;
}

export function marketingHome(rq: Rq): Res {
  const signupOpen = mkSignupOpen();
  const thanks = rq.query.get('walkthrough') === 'thanks';
  const aiLive = llmStatus().live;
  const ASK_CHIPS = ["What's my occupancy?", "How's rent collection this month?", 'Any urgent maintenance?', "Who's at risk of non-renewal?"];
  const SALES_CHIPS = ['What does it cost?', 'How do I switch from Buildium or AppFolio?', 'What does the AI actually do?'];

  const body = html`
<div id="mkprog" aria-hidden="true"></div>
${mkHeader()}

<section class="mk-hero" id="top">
  <div class="mk-wrap mk-hero-in">
    <div class="mk-hero-copy">
      <div class="mk-kicker">For independent multifamily operators · 10–500 units</div>
      <h1>Autonomous property management</h1>
      <p class="mk-sub">The property manager you can't afford to hire. Purpose-built AI workflows for leasing, rent collection, maintenance, and real accounting — sized for operators who do this without a corporate office.</p>
      <div class="mk-cta-row">
        <a class="mk-btn mk-btn-solid mk-btn-lg" href="/login">Explore the live demo</a>
        ${signupOpen ? html`<a class="mk-btn mk-btn-line mk-btn-lg" href="/signup">Create your company</a>` : html`<a class="mk-btn mk-btn-line mk-btn-lg" href="#walkthrough">Book a walkthrough</a>`}
      </div>
      <div class="mk-hero-note">Moving from Buildium, AppFolio, or a spreadsheet? Upload your rent roll and the system builds itself — one afternoon, no implementation team.</div>
    </div>
    <div class="mk-hero-visual" aria-hidden="true">
      <div class="mk-frame">
        <div class="mk-frame-bar"><span></span><span></span><span></span></div>
        <div class="mk-frame-kpis">
          <div><b>94.2%</b><i>Occupancy</i></div>
          <div><b>$412k</b><i>Collected MTD</i></div>
          <div><b>37</b><i>AI actions today</i></div>
          <div><b>1.8h</b><i>Lead response</i></div>
        </div>
        <div class="mk-frame-chart">${raw(Array.from({ length: 12 }, (_, i) => `<i style="height:${[52, 58, 49, 63, 70, 66, 74, 71, 79, 83, 78, 90][i]}%"></i>`).join(''))}</div>
        <div class="mk-frame-feed">
          <div><em>Leasing AI</em> replied to a Zillow lead · 41s</div>
          <div><em>Payments AI</em> drafted 6 friendly reminders · queued for approval</div>
          <div><em>Maintenance AI</em> escalated a water leak · Unit 204</div>
        </div>
      </div>
    </div>
  </div>
</section>

<section class="mk-band" id="how">
  <div class="mk-wrap">
    <h2 class="mk-h2">Two platforms. One operating system.</h2>
    <p class="mk-lead">Everything shares one database — a lead becomes a lease becomes a ledger entry becomes a renewal, with nothing re-keyed and nothing synced.</p>
    <div class="mk-two">
      <a class="mk-plat" href="/login">
        <div class="mk-plat-tag">For your team</div>
        <h3>Operations Experience</h3>
        <p>Leasing CRM, applications, e-sign, payments, dual-basis accounting, facilities, utilities, revenue intelligence, and BI — the whole desk in one login.</p>
        <span class="mk-more">See it in the demo →</span>
      </a>
      <a class="mk-plat" href="/login">
        <div class="mk-plat-tag">For your residents</div>
        <h3>Resident Experience</h3>
        <p>A portal residents actually use: balance and autopay, maintenance with photos, documents, renters insurance, and deposit alternatives.</p>
        <span class="mk-more">See it in the demo →</span>
      </a>
    </div>
  </div>
</section>

<section class="mk-band mk-band-alt" id="ask">
  <div class="mk-wrap mk-ask-grid">
    <div class="mk-ask-copy">
      <div class="mk-kicker mk-kicker-ai">Ask StayLeased${aiLive ? ' · powered by Claude' : ''}</div>
      <h2 class="mk-h2">Ask anything. Get answers grounded in your data.</h2>
      <p class="mk-lead">Ask StayLeased in plain English and get a straight answer — pulled live from your occupancy, ledger, work orders, and leases. No report builder, no exports, no waiting on the office.</p>
      <ul class="mk-ask-points">
        <li>Grounded in your real numbers — it never makes figures up</li>
        <li>Answers about occupancy, collections, maintenance, and renewals</li>
        <li>${aiLive ? 'Powered by Anthropic’s Claude, live on this site' : 'Runs on-device in the demo; add a Claude key to go fully live'}</li>
      </ul>
      <div class="mk-cta-row"><a class="mk-btn mk-btn-solid" href="/login">Try the full assistant in the demo</a></div>
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

<section class="mk-band mk-band-alt" id="platform">
  <div class="mk-wrap">
    <h2 class="mk-h2">Built for the way property management actually works.</h2>
    <p class="mk-lead">A purpose-built ontology across record, context, and action — so your people and your agents always have the right information at the right moment.</p>
    <div class="mk-stack">
      ${LAYERS.map((ly, i) => html`<details class="mk-layer" ${i === 0 ? 'open' : ''}>
        <summary><span class="mk-lnum">${String(ly.n)}</span><span class="mk-lname">${ly.name}</span><span class="mk-ltag">${ly.tag}</span><span class="mk-plus" aria-hidden="true"></span></summary>
        <div class="mk-lbody">${ly.body}</div>
      </details>`)}
    </div>
  </div>
</section>

<section class="mk-band" id="automation">
  <div class="mk-wrap">
    <h2 class="mk-h2">Automation that fits the way you operate.</h2>
    <p class="mk-lead">Five levels of autonomy, dialed per agent and per property — from drafting for your review to running the workflow end to end.</p>
    <div class="mk-levels">
      ${LEVELS.map((lv, i) => html`<div class="mk-level">
        <div class="mk-level-cube">${raw(cube(i))}</div>
        <div><div class="mk-level-head"><b>${lv.l}</b> · ${lv.name}</div><p>${lv.body}</p></div>
      </div>`)}
    </div>
  </div>
</section>

<section class="mk-band mk-band-alt" id="agents">
  <div class="mk-wrap">
    <h2 class="mk-h2">Functional agents embedded in every corner.</h2>
    <p class="mk-lead">Not a chatbot bolted on — agents that live inside leasing, maintenance, payments, and renewals, proposing real actions into a human approval queue.</p>
    <div class="mk-grid3">
      ${AGENTS.map((a) => html`<div class="mk-card"><h3>${a.name}</h3><p>${a.blurb}</p></div>`)}
    </div>
    <div class="mk-inline-cta"><a class="mk-btn mk-btn-solid" href="/login">Watch the agents work in the demo</a></div>
  </div>
</section>

<section class="mk-band" id="residents">
  <div class="mk-wrap">
    <h2 class="mk-h2">Residents feel it too.</h2>
    <p class="mk-lead">Fast answers at 2am, maintenance that responds in minutes, payments that take seconds — and move-in costs a deposit alternative can cut to a fraction.</p>
    <div class="mk-phones" aria-hidden="true">
      <div class="mk-phone"><div class="mk-ph-head">Rent</div><div class="mk-ph-big">$1,450</div><div class="mk-ph-line ok">Autopay on · due Aug 1</div><div class="mk-ph-btn">Pay now</div></div>
      <div class="mk-phone mk-phone-mid"><div class="mk-ph-head">Maintenance</div><div class="mk-ph-line">Leak under sink</div><div class="mk-ph-line ok">Tech scheduled · Tue 9–11</div><div class="mk-ph-line muted">“Shut the valve behind the cabinet — we're on the way.”</div></div>
      <div class="mk-phone"><div class="mk-ph-head">Perks</div><div class="mk-ph-line">Deposit alternative: active</div><div class="mk-ph-line ok">Move-in saved $1,050</div><div class="mk-ph-line">Insurance: covered ✓</div></div>
    </div>
  </div>
</section>

<section class="mk-band mk-dark" id="governance">
  <div class="mk-wrap">
    <h2 class="mk-h2">Autonomy that operates inside your rules.</h2>
    <p class="mk-lead">Every action runs through your policies. AI doesn't bypass governance — it executes within it.</p>
    <ul class="mk-checks">
      <li>Fair-housing guardrails on every prospect-facing reply</li>
      <li>Payment-plan and concession bounds you define</li>
      <li>Role-based permissions and approval workflows</li>
      <li>Per-agent, per-property autonomy dials</li>
      <li>A global AI kill switch, one click</li>
      <li>Full audit trail on every human and AI action</li>
    </ul>
    <div class="mk-grid5">
      ${GOV_CARDS.map((g) => html`<div class="mk-gov"><h4>${g.name}</h4><p>${g.body}</p></div>`)}
    </div>
  </div>
</section>

<section class="mk-band" id="solutions">
  <div class="mk-wrap">
    <h2 class="mk-h2">Built for operators like you.</h2>
    <p class="mk-lead">Enterprise platforms are built for 20,000-unit REITs with implementation teams. StayLeased is built for the people who actually own and run most of America's rentals.</p>
    <div class="mk-grid3">
      ${SOLUTIONS.map((s2) => html`<div class="mk-card"><h3>${s2.name}</h3><p>${s2.body}</p></div>`)}
    </div>
    <p class="muted" style="margin-top:18px;font-size:13.5px;color:#66707f">Student, affordable-program, or mixed units in your portfolio? They're supported — the platform handles by-the-bed leases and set-aside compliance when you need it.</p>
  </div>
</section>

<section class="mk-band mk-band-alt" id="pricing">
  <div class="mk-wrap">
    <h2 class="mk-h2">Simple, honest pricing.</h2>
    <p class="mk-lead">No quote-only games, no implementation fees, no sales gauntlet. Early-access partners run free while we build with them — and when pricing lands, it will be a per-unit price you can read on this page, an order of magnitude below the enterprise platforms.</p>
    <div class="mk-price-row">
      <div class="mk-price">
        <div class="mk-price-tag">Early access</div>
        <div class="mk-price-big">Free</div>
        <p>Full platform. Import your portfolio, run your operation, keep your data — export any time. Invite code required.</p>
        <a class="mk-btn mk-btn-solid" href="#walkthrough">Request an invite</a>
      </div>
      <div class="mk-price">
        <div class="mk-price-tag">What it replaces</div>
        <div class="mk-price-big">$300–800<span>/mo</span></div>
        <p>Typical spend for a small portfolio on legacy software plus the hours you donate every week — the late-night rent chasing, the 2am maintenance calls, the spreadsheet bookkeeping.</p>
      </div>
    </div>
  </div>
</section>

<section class="mk-band mk-band-alt" id="walkthrough">
  <div class="mk-wrap mk-two-col">
    <div>
      <h2 class="mk-h2">See autonomous property management in action.</h2>
      <p class="mk-lead">Explore the fully seeded demo company right now — every screen live, every agent mid-flight. Or tell us about your portfolio and we'll set you up to import it.</p>
      <div class="mk-cta-row">
        <a class="mk-btn mk-btn-solid mk-btn-lg" href="/login">Open the live demo</a>
        ${when(signupOpen, () => html`<a class="mk-btn mk-btn-line mk-btn-lg" href="/signup">Create your company</a>`)}
      </div>
    </div>
    <div class="mk-form-card">
      ${thanks
        ? html`<div class="mk-thanks"><b>Got it — thank you.</b><br/>We'll reach out shortly to set up your walkthrough${signupOpen ? ' and invite code' : ''}.</div>`
        : html`<form method="post" action="/company/walkthrough">
            <h3>Book a walkthrough</h3>
            <div class="mk-form-grid">
              <label>Name<input name="name" required /></label>
              <label>Work email<input name="email" type="email" required /></label>
              <label>Company<input name="company" /></label>
              <label>Units managed<select name="units"><option>1–50</option><option>51–150</option><option>151–500</option><option>501–2,500</option><option>2,500+</option></select></label>
            </div>
            <label class="mk-form-full">Anything specific you want to see?<input name="note" placeholder="e.g. moving off AppFolio, ~120 units" /></label>
            <button class="mk-btn mk-btn-solid" type="submit">Request walkthrough</button>
          </form>`}
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
      <div class="mk-chat-id"><span class="mk-chat-av">SL</span><div><b>Ask StayLeased</b><span>${aiLive ? 'powered by Claude' : 'product questions, answered'}</span></div></div>
      <button class="mk-chat-close" id="mkchat-close" type="button" aria-label="Close">✕</button>
    </div>
    <div class="mk-chat-msgs" id="mkchat-msgs" aria-live="polite">
      <div class="mk-msg agent">Hi! I’m the StayLeased assistant. Ask me anything about the product — pricing, switching from your current software, what the AI agents do, or how to get started.</div>
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
  // nav dropdown + mobile-menu behavior lives in the shared chrome script

  // ontology stack: opening one layer closes the others (accordion)
  var layers = document.querySelectorAll('details.mk-layer');
  layers.forEach(function (d) {
    d.addEventListener('toggle', function () {
      if (d.open) layers.forEach(function (o) { if (o !== d) o.open = false; });
    });
  });

  // scroll progress bar + back-to-top on scroll (condensed nav: chrome script)
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

  if (reduce) {
    document.querySelectorAll('.mk-reveal, .mk-stag, .mk-frame-chart i').forEach(function (el) { el.classList.add('vis'); el.classList.add('grown'); });
    return;
  }

  // stagger children within revealing groups (cards cascade in)
  ['.mk-two', '.mk-grid3', '.mk-grid5', '.mk-levels', '.mk-stack', '.mk-price-row', '.mk-phones', '.mk-checks', '.mk-foot-grid'].forEach(function (sel) {
    document.querySelectorAll(sel).forEach(function (grp) {
      Array.prototype.forEach.call(grp.children, function (child, i) {
        child.classList.add('mk-stag');
        child.style.transitionDelay = (0.05 + i * 0.07) + 's';
      });
    });
  });

  // reveal-on-scroll for sections
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('vis'); io.unobserve(en.target); } });
    }, { threshold: 0.1, rootMargin: '0px 0px -7% 0px' });
    document.querySelectorAll('.mk-band .mk-wrap, .mk-hero-in, .mk-foot .mk-wrap').forEach(function (el) { el.classList.add('mk-reveal'); io.observe(el); });
  } else {
    document.querySelectorAll('.mk-reveal, .mk-stag').forEach(function (el) { el.classList.add('vis'); });
  }

  // hero KPI count-up + chart bars growing in, once on load
  function countUp(el) {
    var m = /^(\\D*)([\\d.,]+)(.*)$/.exec((el.textContent || '').trim());
    if (!m) return;
    var prefix = m[1], rawNum = m[2].replace(/,/g, ''), suffix = m[3];
    var target = parseFloat(rawNum); if (isNaN(target)) return;
    var dec = (rawNum.split('.')[1] || '').length;
    var dur = 1200, t0 = null;
    function fmt(v) { return prefix + (dec ? v.toFixed(dec) : Math.round(v).toLocaleString('en-US')) + suffix; }
    function step(ts) {
      if (t0 === null) t0 = ts;
      var p = Math.min(1, (ts - t0) / dur);
      var e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(target * e);
      if (p < 1) requestAnimationFrame(step); else el.textContent = fmt(target);
    }
    requestAnimationFrame(step);
  }
  var kpisDone = false;
  function fireHero() {
    if (kpisDone) return;
    kpisDone = true;
    document.querySelectorAll('.mk-frame-kpis b').forEach(countUp);
    document.querySelectorAll('.mk-frame-chart i').forEach(function (bar, i) {
      bar.style.transitionDelay = (0.25 + i * 0.05) + 's';
      requestAnimationFrame(function () { bar.classList.add('grown'); });
    });
  }
  setTimeout(fireHero, 200);

  // gentle 3D tilt on the hero product mock following the cursor
  var visual = document.querySelector('.mk-hero-visual');
  if (visual && window.matchMedia('(hover: hover)').matches) {
    visual.addEventListener('mousemove', function (e) {
      var r = visual.getBoundingClientRect();
      var dx = (e.clientX - r.left) / r.width - 0.5;
      var dy = (e.clientY - r.top) / r.height - 0.5;
      visual.style.setProperty('--tx', (dx * 7).toFixed(2) + 'deg');
      visual.style.setProperty('--ty', (-dy * 7).toFixed(2) + 'deg');
    });
    visual.addEventListener('mouseleave', function () {
      visual.style.setProperty('--tx', '0deg');
      visual.style.setProperty('--ty', '0deg');
    });
  }

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
      agent.textContent = 'Sorry — I could not reach the assistant just now. Try the live demo.';
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
    ask(askChips[autoIdx].textContent.trim(), askMsgs, 'demo', { clear: !first ? true : askMsgs.childElementCount > 0 }, function () {
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

  return htmlRes(`<!doctype html>${html`<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>StayLeased — Autonomous Property Management</title>
<meta name="description" content="The agentic operating system for the places people live. AI workflows for leasing, operations, accounting — with human approval and a full audit trail." />
<meta property="og:title" content="StayLeased — Autonomous Property Management" />
<meta property="og:description" content="Purpose-built AI workflows for leasing, operations, and accounting. Import your portfolio in an afternoon." />
<meta property="og:type" content="website" /><meta property="og:site_name" content="StayLeased" />
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
<style>${raw(MARKETING_CSS)}</style>
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

