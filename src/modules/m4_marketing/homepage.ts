import { html, raw, when } from '../../lib/html.ts';
import { htmlRes, redirect, textRes, type Router, type Rq, type Res } from '../../lib/http.ts';
import { rateLimit } from '../../lib/auth.ts';
import { q1, insert } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso } from '../../lib/dates.ts';
import { logo } from '../../ui/ui.ts';
import { env } from '../../lib/env.ts';

/** The platform marketing homepage — the front door for logged-out visitors,
 * modeled section-for-section on entrata.com's architecture: sticky nav with
 * mega-dropdowns → hero → two-platforms → six-layer ontology stack
 * (expandable) → L1–L5 automation ladder → agent grid → resident products →
 * governance → property types → walkthrough form → mega-footer. Every claim
 * on this page maps to something the product actually does; the demo login
 * and /signup are one click away everywhere. */

const NAV: { label: string; items: [string, string, string][] }[] = [
  {
    label: 'Platform',
    items: [
      ['Rent collection', '#agents', 'Autopay, late-fee policy, and AI follow-up on every balance'],
      ['Leasing CRM', '#agents', 'Every lead answered in seconds; tours booked while you sleep'],
      ['Maintenance & turns', '#agents', 'Requests triaged 24/7, vendors dispatched with approval'],
      ['Accounting', '#platform', 'Real double-entry books, bank rec, owner-ready statements'],
      ['Leases & e-sign', '#platform', 'Templates, packets, renewals, and signatures'],
      ['Applications & screening', '#platform', 'Applicant portal, criteria, and decisioning'],
      ['Property sites & listings', '#platform', 'A leasing website per property with live pricing'],
      ['Renewals & pricing', '#platform', 'Under-market flags and renewal offers in bounds'],
      ['Reports', '#platform', '50-report catalog, custom builder, scheduled email'],
      ['Utilities & RUBS', '#platform', 'Bill utilities back fairly when you need to'],
    ],
  },
  {
    label: 'Residents',
    items: [
      ['Resident portal', '#residents', 'Balance, payments, documents, requests'],
      ['Autopay & payments', '#residents', 'ACH and card with receipts and plans'],
      ['Maintenance requests', '#residents', 'Photos, updates, and satisfaction ratings'],
      ['Renters insurance', '#residents', 'Compliance tracking and master policy'],
      ['Deposit alternative', '#residents', 'Lower move-in costs, covered risk'],
      ['Rent reporting', '#residents', 'On-time payments build resident credit'],
    ],
  },
  {
    label: 'AI',
    items: [
      ['Leasing AI', '#agents', 'Answers every prospect from live availability'],
      ['Maintenance AI', '#agents', 'Triage, emergency escalation, troubleshooting'],
      ['Payments AI', '#agents', 'Delinquency outreach inside compliance rails'],
      ['Renewals AI', '#agents', 'Personalized offers, counters within bounds'],
      ['Call analysis', '#agents', 'Summaries, sentiment, and coaching notes'],
      ['Ask StayLeased', '#agents', 'Questions answered from your own data'],
      ['Autonomy & governance', '#governance', 'Dials, approvals, and audit on every action'],
    ],
  },
  {
    label: 'Who it\'s for',
    items: [
      ['Self-managing owners', '#solutions', 'Your 10–100 doors, without the 11pm admin shift'],
      ['Small management companies', '#solutions', 'Hundreds of doors on a two-person office'],
      ['Growing portfolios', '#solutions', 'Institutional-grade books without the headcount'],
      ['Switching from Buildium / AppFolio', '#walkthrough', 'Your rent roll imports in one afternoon'],
      ['Switching from spreadsheets', '#walkthrough', 'Keep the spreadsheet — upload it, we build the rest'],
    ],
  },
];

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
  const signupOpen = !!env('SIGNUP_CODE');
  const thanks = rq.query.get('walkthrough') === 'thanks';
  const primaryCta = signupOpen
    ? html`<a class="mk-btn mk-btn-solid" href="/signup">Create your company</a>`
    : html`<a class="mk-btn mk-btn-solid" href="#walkthrough">Book a walkthrough</a>`;

  const body = html`
<div id="mkprog" aria-hidden="true"></div>
<header class="mk-nav">
  <div class="mk-wrap mk-nav-in">
    <a class="mk-logo" href="/">${logo(24, '#2563eb')}<span>Stay<b>Leased</b></span></a>
    <nav class="mk-menu" aria-label="Main">
      ${NAV.map((m) => html`<div class="mk-item"><button class="mk-item-btn" type="button">${m.label}<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg></button>
        <div class="mk-drop"><div class="mk-drop-grid">
          ${m.items.map(([label2, href, sub]) => html`<a href="${href}"><b>${label2}</b><span>${sub}</span></a>`)}
        </div></div>
      </div>`)}
      <a class="mk-item-link" href="#how">How it works</a>
    </nav>
    <div class="mk-nav-cta">
      <a class="mk-btn mk-btn-ghost" href="/login">Sign in</a>
      ${primaryCta}
    </div>
  </div>
</header>

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
        <p>A portal residents actually use: balance and autopay, maintenance with photos, documents, insurance, deposit alternatives, and rent reporting.</p>
        <span class="mk-more">See it in the demo →</span>
      </a>
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
    <p class="mk-lead">Fast answers at 2am, maintenance that responds in minutes, payments that take seconds — and rent that builds their credit.</p>
    <div class="mk-phones" aria-hidden="true">
      <div class="mk-phone"><div class="mk-ph-head">Rent</div><div class="mk-ph-big">$1,450</div><div class="mk-ph-line ok">Autopay on · due Aug 1</div><div class="mk-ph-btn">Pay now</div></div>
      <div class="mk-phone mk-phone-mid"><div class="mk-ph-head">Maintenance</div><div class="mk-ph-line">Leak under sink</div><div class="mk-ph-line ok">Tech scheduled · Tue 9–11</div><div class="mk-ph-line muted">“Shut the valve behind the cabinet — we're on the way.”</div></div>
      <div class="mk-phone"><div class="mk-ph-head">Perks</div><div class="mk-ph-line">Rent reporting: on</div><div class="mk-ph-line ok">Credit +18 pts this year</div><div class="mk-ph-line">Insurance: covered ✓</div></div>
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

<footer class="mk-foot">
  <div class="mk-wrap mk-foot-grid">
    <div><div class="mk-foot-head">Platform</div>${NAV[0]!.items.slice(0, 8).map(([l, h]) => html`<a href="${h}">${l}</a>`)}</div>
    <div><div class="mk-foot-head">Residents</div>${NAV[1]!.items.map(([l, h]) => html`<a href="${h}">${l}</a>`)}</div>
    <div><div class="mk-foot-head">Intelligence</div>${NAV[2]!.items.map(([l, h]) => html`<a href="${h}">${l}</a>`)}</div>
    <div><div class="mk-foot-head">Who it's for</div>${NAV[3]!.items.map(([l, h]) => html`<a href="${h}">${l}</a>`)}</div>
    <div><div class="mk-foot-head">Company</div>
      <a href="/login">Sign in</a>
      ${when(signupOpen, () => html`<a href="/signup">Create your company</a>`)}
      <a href="#walkthrough">Book a walkthrough</a>
      <a href="/company">Communities</a>
    </div>
  </div>
  <div class="mk-wrap mk-foot-base">
    <span>${logo(18, '#94a3b8')} © 2026 StayLeased · Property management, run by AI</span>
    <span>⌂ Equal Housing Opportunity</span>
  </div>
</footer>

<script>
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // nav dropdowns: click-exclusive (hover handled by CSS on desktop)
  document.querySelectorAll('.mk-item-btn').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      var item = btn.parentElement;
      var open = item.classList.contains('open');
      document.querySelectorAll('.mk-item.open').forEach(function (i) { i.classList.remove('open'); });
      if (!open) item.classList.add('open');
      e.stopPropagation();
    });
  });
  document.addEventListener('click', function () {
    document.querySelectorAll('.mk-item.open').forEach(function (i) { i.classList.remove('open'); });
  });

  // ontology stack: opening one layer closes the others (accordion)
  var layers = document.querySelectorAll('details.mk-layer');
  layers.forEach(function (d) {
    d.addEventListener('toggle', function () {
      if (d.open) layers.forEach(function (o) { if (o !== d) o.open = false; });
    });
  });

  // scroll progress bar + condensed nav on scroll
  var prog = document.getElementById('mkprog');
  var nav = document.querySelector('.mk-nav');
  function onScroll() {
    var h = document.documentElement;
    var max = (h.scrollHeight - h.clientHeight) || 1;
    var p = Math.min(1, Math.max(0, (window.pageYOffset || h.scrollTop) / max));
    if (prog) prog.style.transform = 'scaleX(' + p + ')';
    if (nav) nav.classList.toggle('scrolled', (window.pageYOffset || h.scrollTop) > 8);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

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
    document.querySelectorAll('.mk-band .mk-wrap, .mk-hero-in').forEach(function (el) { el.classList.add('mk-reveal'); io.observe(el); });
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
})();
</script>`;

  const CSS = MARKETING_CSS;
  return htmlRes(`<!doctype html>${html`<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>StayLeased — Autonomous Property Management</title>
<meta name="description" content="The agentic operating system for the places people live. AI workflows for leasing, operations, accounting — with human approval and a full audit trail." />
<meta property="og:title" content="StayLeased — Autonomous Property Management" />
<meta property="og:description" content="Purpose-built AI workflows for leasing, operations, and accounting. Import your portfolio in an afternoon." />
<meta property="og:type" content="website" /><meta property="og:site_name" content="StayLeased" />
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
<style>${raw(CSS)}</style>
</head><body class="mk">${body}</body></html>`.s}`);
}

export function homepageRoutes(r: Router): void {
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

const MARKETING_CSS = `
:root { --ink:#0b1220; --ink2:#3c4657; --mut:#66707f; --blue:#2563eb; --blue-d:#1d4ed8; --line:#e5e9f0; --bg:#ffffff; --bg2:#f6f8fc; --ease:cubic-bezier(.16,1,.3,1); }
* { box-sizing: border-box; margin: 0; }
body.mk { font: 16px/1.6 -apple-system, "Segoe UI", Roboto, Inter, sans-serif; color: var(--ink); background: var(--bg); -webkit-font-smoothing: antialiased; scroll-behavior: smooth; overflow-x: hidden; }
.mk-wrap { max-width: 1160px; margin: 0 auto; padding: 0 22px; }
a { color: inherit; text-decoration: none; }

/* scroll progress bar */
#mkprog { position: fixed; top: 0; left: 0; right: 0; height: 3px; z-index: 90; background: linear-gradient(90deg, #2563eb, #22d3ee); transform: scaleX(0); transform-origin: 0 50%; transition: transform .08s linear; }

/* nav */
.mk-nav { position: sticky; top: 0; z-index: 60; background: rgba(255,255,255,.86); backdrop-filter: blur(12px); border-bottom: 1px solid transparent; transition: box-shadow .25s ease, border-color .25s ease, background .25s ease; }
.mk-nav.scrolled { border-bottom-color: var(--line); box-shadow: 0 6px 24px rgba(16,24,40,.06); background: rgba(255,255,255,.94); }
.mk-nav-in { display: flex; align-items: center; gap: 26px; height: 66px; transition: height .25s ease; }
.mk-nav.scrolled .mk-nav-in { height: 58px; }
.mk-logo { display: flex; align-items: center; gap: 8px; font-size: 19px; font-weight: 500; transition: transform .2s var(--ease); }
.mk-logo:hover { transform: scale(1.03); }
.mk-logo b { color: var(--blue); font-weight: 800; }
.mk-menu { display: flex; align-items: center; gap: 4px; flex: 1; }
.mk-item { position: relative; }
.mk-item-btn { display: flex; align-items: center; gap: 5px; background: none; border: 0; font: inherit; font-weight: 600; font-size: 14.5px; color: var(--ink2); padding: 9px 12px; border-radius: 8px; cursor: pointer; transition: background .15s ease, color .15s ease; }
.mk-item-btn svg { transition: transform .2s var(--ease); }
.mk-item.open .mk-item-btn svg { transform: rotate(180deg); }
.mk-item-link { font-weight: 600; font-size: 14.5px; color: var(--ink2); padding: 9px 12px; border-radius: 8px; transition: background .15s ease, color .15s ease; }
.mk-item-btn:hover, .mk-item-link:hover { background: var(--bg2); color: var(--ink); }
.mk-drop { position: absolute; left: 0; top: calc(100% + 8px); background: #fff; border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 22px 55px rgba(16,24,40,.16); padding: 10px; display: none; }
.mk-item.open .mk-drop { display: block; animation: mkDropIn .2s var(--ease); }
@media (hover: hover) { .mk-item:hover .mk-drop { display: block; animation: mkDropIn .2s var(--ease); } }
.mk-drop-grid { display: grid; grid-template-columns: repeat(2, 280px); gap: 2px; }
.mk-drop-grid a { display: flex; flex-direction: column; gap: 1px; padding: 9px 11px; border-radius: 9px; transition: background .14s ease, transform .14s ease; }
.mk-drop-grid a:hover { background: var(--bg2); transform: translateX(3px); }
.mk-drop-grid b { font-size: 13.5px; }
.mk-drop-grid span { font-size: 12px; color: var(--mut); }
.mk-nav-cta { display: flex; gap: 9px; align-items: center; }

/* buttons */
.mk-btn { position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 7px; font-weight: 700; font-size: 14.5px; border-radius: 10px; padding: 10px 17px; border: 0; cursor: pointer; overflow: hidden; transition: transform .18s var(--ease), box-shadow .18s var(--ease), background .18s ease, border-color .18s ease, color .18s ease; }
.mk-btn-lg { padding: 13px 22px; font-size: 15.5px; border-radius: 12px; }
.mk-btn-solid { background: var(--blue); color: #fff; box-shadow: 0 6px 18px rgba(37,99,235,.28); }
.mk-btn-solid::after { content: ''; position: absolute; top: 0; left: -60%; width: 40%; height: 100%; background: linear-gradient(100deg, transparent, rgba(255,255,255,.4), transparent); transform: skewX(-20deg); transition: left .55s var(--ease); }
.mk-btn-solid:hover { background: var(--blue-d); transform: translateY(-2px); box-shadow: 0 12px 30px rgba(37,99,235,.4); }
.mk-btn-solid:hover::after { left: 120%; }
.mk-btn-solid:active { transform: translateY(0); }
.mk-btn-line { border: 1.6px solid #c9d4ea; color: var(--ink); background: #fff; }
.mk-btn-line:hover { border-color: var(--blue); color: var(--blue); transform: translateY(-2px); box-shadow: 0 10px 24px rgba(37,99,235,.14); }
.mk-btn-ghost { color: var(--ink2); background: transparent; }
.mk-btn-ghost:hover { color: var(--ink); background: var(--bg2); }

/* hero */
.mk-hero { position: relative; background: linear-gradient(180deg, #f7faff, #fff 78%); border-bottom: 1px solid var(--line); overflow: hidden; }
.mk-hero::before { content: ''; position: absolute; inset: -20% -10% auto -10%; height: 640px; background: radial-gradient(720px 380px at 74% 8%, rgba(37,99,235,.20), transparent 62%), radial-gradient(560px 320px at 12% 0%, rgba(34,211,238,.14), transparent 60%); animation: mkDrift 16s ease-in-out infinite alternate; pointer-events: none; }
.mk-hero-in { position: relative; display: grid; grid-template-columns: 1.05fr .95fr; gap: 44px; align-items: center; padding: 78px 22px 84px; }
.mk-kicker { display: inline-block; font-size: 12px; font-weight: 800; letter-spacing: 1.3px; text-transform: uppercase; color: var(--blue); background: rgba(37,99,235,.09); border: 1px solid rgba(37,99,235,.22); padding: 5px 12px; border-radius: 99px; margin-bottom: 18px; }
.mk-hero h1 { font-size: clamp(34px, 4.7vw, 56px); line-height: 1.05; letter-spacing: -1.4px; font-weight: 800; background: linear-gradient(180deg, #0b1220, #22314e); -webkit-background-clip: text; background-clip: text; }
.mk-sub { font-size: 18.5px; color: var(--ink2); margin: 18px 0 26px; max-width: 34em; }
.mk-cta-row { display: flex; gap: 12px; flex-wrap: wrap; }
.mk-hero-note { margin-top: 18px; font-size: 13.5px; color: var(--mut); }

/* hero product mock */
.mk-hero-visual { perspective: 1100px; animation: mkFloat 7s ease-in-out infinite; }
.mk-frame { background: #fff; border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 40px 90px rgba(16,24,40,.20); overflow: hidden; transform: rotateY(var(--tx,0deg)) rotateX(var(--ty,0deg)); transition: transform .3s var(--ease); }
.mk-frame-bar { display: flex; gap: 6px; padding: 11px 14px; border-bottom: 1px solid var(--line); background: #f8fafc; }
.mk-frame-bar span { width: 10px; height: 10px; border-radius: 99px; background: #dbe2ec; }
.mk-frame-kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; padding: 14px; }
.mk-frame-kpis div { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; transition: transform .2s var(--ease), box-shadow .2s var(--ease), border-color .2s ease; }
.mk-frame-kpis div:hover { transform: translateY(-3px); box-shadow: 0 10px 22px rgba(37,99,235,.14); border-color: rgba(37,99,235,.4); }
.mk-frame-kpis b { display: block; font-size: 18px; letter-spacing: -.4px; color: var(--blue-d); }
.mk-frame-kpis i { font-style: normal; font-size: 11px; color: var(--mut); }
.mk-frame-chart { display: flex; align-items: flex-end; gap: 7px; height: 110px; padding: 4px 16px 12px; }
.mk-frame-chart i { flex: 1; background: linear-gradient(180deg, #6d8df3, #2563eb); border-radius: 4px 4px 2px 2px; min-height: 12%; transform: scaleY(0); transform-origin: bottom; transition: transform .7s var(--ease); }
.mk-frame-chart i.grown { transform: scaleY(1); }
.mk-frame-chart i:last-child { background: #1d4ed8; }
.mk-frame-feed { border-top: 1px solid var(--line); padding: 11px 16px 14px; display: grid; gap: 7px; font-size: 12.5px; color: var(--ink2); }
.mk-frame-feed div { position: relative; padding-left: 14px; }
.mk-frame-feed div::before { content: ''; position: absolute; left: 0; top: 7px; width: 6px; height: 6px; border-radius: 99px; background: #22c55e; box-shadow: 0 0 0 0 rgba(34,197,94,.5); animation: mkPing 2.4s ease-out infinite; }
.mk-frame-feed div:nth-child(2)::before { animation-delay: .8s; }
.mk-frame-feed div:nth-child(3)::before { animation-delay: 1.6s; background: #f59e0b; }
.mk-frame-feed em { font-style: normal; font-weight: 700; color: var(--blue); }

/* sections */
.mk-band { padding: 80px 0; }
.mk-band-alt { background: var(--bg2); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.mk-h2 { font-size: clamp(26px, 3.2vw, 38px); letter-spacing: -.8px; line-height: 1.12; font-weight: 800; max-width: 22em; }
.mk-lead { font-size: 17px; color: var(--ink2); margin: 14px 0 34px; max-width: 44em; }
.mk-two { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.mk-plat { position: relative; border: 1px solid var(--line); background: #fff; border-radius: 16px; padding: 28px; overflow: hidden; transition: box-shadow .22s var(--ease), transform .22s var(--ease), border-color .22s ease; }
.mk-plat::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 3px; background: linear-gradient(90deg, #2563eb, #22d3ee); transform: scaleX(0); transform-origin: 0 50%; transition: transform .3s var(--ease); }
.mk-plat:hover { box-shadow: 0 24px 54px rgba(16,24,40,.14); transform: translateY(-4px); border-color: rgba(37,99,235,.28); }
.mk-plat:hover::before { transform: scaleX(1); }
.mk-plat-tag { font-size: 11.5px; font-weight: 800; letter-spacing: 1.1px; text-transform: uppercase; color: var(--blue); margin-bottom: 10px; }
.mk-plat h3 { font-size: 22px; letter-spacing: -.4px; margin-bottom: 8px; }
.mk-plat p { color: var(--ink2); font-size: 15px; }
.mk-more { display: inline-block; margin-top: 14px; font-weight: 700; color: var(--blue); font-size: 14px; transition: transform .2s var(--ease); }
.mk-plat:hover .mk-more { transform: translateX(5px); }

/* ontology stack */
.mk-stack { display: grid; gap: 8px; max-width: 860px; }
.mk-layer { border: 1px solid var(--line); background: #fff; border-radius: 13px; overflow: hidden; transition: border-color .2s ease, box-shadow .2s ease, transform .2s var(--ease); }
.mk-layer:hover { transform: translateX(3px); box-shadow: 0 8px 22px rgba(16,24,40,.07); }
.mk-layer summary { display: flex; align-items: center; gap: 14px; padding: 15px 18px; cursor: pointer; list-style: none; }
.mk-layer summary::-webkit-details-marker { display: none; }
.mk-lnum { flex: none; width: 34px; height: 34px; border-radius: 10px; background: rgba(37,99,235,.1); color: var(--blue); font-weight: 800; display: flex; align-items: center; justify-content: center; transition: background .2s ease, transform .2s var(--ease); }
.mk-layer[open] .mk-lnum, .mk-layer:hover .mk-lnum { background: var(--blue); color: #fff; transform: scale(1.06); }
.mk-lname { font-weight: 700; font-size: 16px; }
.mk-ltag { margin-left: auto; font-size: 11.5px; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; color: var(--mut); }
.mk-plus { flex: none; width: 16px; height: 16px; position: relative; margin-left: 6px; }
.mk-plus::before, .mk-plus::after { content: ''; position: absolute; background: var(--mut); border-radius: 2px; transition: transform .2s var(--ease); }
.mk-plus::before { left: 0; right: 0; top: 7px; height: 2.4px; }
.mk-plus::after { top: 0; bottom: 0; left: 7px; width: 2.4px; }
.mk-layer[open] .mk-plus::after { transform: scaleY(0); }
.mk-layer[open] { border-color: rgba(37,99,235,.5); box-shadow: 0 10px 30px rgba(37,99,235,.10); }
.mk-lbody { padding: 0 18px 17px 66px; color: var(--ink2); font-size: 15px; animation: mkFade .3s var(--ease); }

/* automation levels */
.mk-levels { position: relative; display: grid; gap: 12px; max-width: 860px; }
.mk-levels::before { content: ''; position: absolute; left: 27px; top: 18px; bottom: 18px; width: 2px; background: linear-gradient(180deg, #2563eb, #dbe4f5); }
.mk-level { position: relative; display: flex; gap: 18px; background: #fff; border: 1px solid var(--line); border-radius: 13px; padding: 17px 20px; transition: transform .18s var(--ease), box-shadow .18s var(--ease), border-color .18s ease; }
.mk-level:hover { transform: translateX(6px); box-shadow: 0 14px 34px rgba(16,24,40,.11); border-color: rgba(37,99,235,.28); }
.mk-level-cube { flex: none; width: 30px; transition: transform .3s var(--ease); }
.mk-level:hover .mk-level-cube { transform: rotate(-8deg) scale(1.1); }
.mk-level-head { font-size: 15.5px; margin-bottom: 3px; }
.mk-level-head b { color: var(--blue); }
.mk-level p { color: var(--ink2); font-size: 14.5px; }

/* cards */
.mk-grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.mk-card { position: relative; border: 1px solid var(--line); background: #fff; border-radius: 14px; padding: 22px; overflow: hidden; transition: transform .2s var(--ease), box-shadow .2s var(--ease), border-color .2s ease; }
.mk-card::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: linear-gradient(180deg, #2563eb, #22d3ee); transform: scaleY(0); transform-origin: 50% 0; transition: transform .28s var(--ease); }
.mk-card:hover { transform: translateY(-4px); box-shadow: 0 18px 40px rgba(16,24,40,.12); border-color: rgba(37,99,235,.24); }
.mk-card:hover::before { transform: scaleY(1); }
.mk-card h3 { font-size: 17px; margin-bottom: 7px; }
.mk-card p { color: var(--ink2); font-size: 14.5px; }
.mk-inline-cta { margin-top: 28px; }

/* phones */
.mk-phones { display: flex; gap: 20px; justify-content: center; flex-wrap: wrap; }
.mk-phone { width: 250px; border: 1px solid var(--line); border-radius: 22px; background: #fff; box-shadow: 0 24px 50px rgba(16,24,40,.13); padding: 20px 18px 22px; transition: transform .25s var(--ease), box-shadow .25s var(--ease); }
.mk-phone:hover { transform: translateY(-8px) rotate(-1.5deg); box-shadow: 0 34px 66px rgba(16,24,40,.2); }
.mk-phone-mid { transform: translateY(-16px); }
.mk-phone-mid:hover { transform: translateY(-24px) rotate(1.5deg); }
.mk-ph-head { font-size: 11.5px; font-weight: 800; letter-spacing: 1.1px; text-transform: uppercase; color: var(--mut); margin-bottom: 10px; }
.mk-ph-big { font-size: 30px; font-weight: 800; letter-spacing: -.8px; margin-bottom: 6px; }
.mk-ph-line { font-size: 13.5px; padding: 7px 0; border-bottom: 1px dashed var(--line); }
.mk-ph-line.ok { color: #15803d; font-weight: 600; }
.mk-ph-line.muted { color: var(--mut); border-bottom: 0; }
.mk-ph-btn { margin-top: 12px; background: var(--blue); color: #fff; text-align: center; font-weight: 700; border-radius: 10px; padding: 10px; transition: background .18s ease; }
.mk-phone:hover .mk-ph-btn { background: var(--blue-d); }

/* governance */
.mk-dark { position: relative; background: linear-gradient(180deg, #0b1220, #101b33); color: #e7edf7; overflow: hidden; }
.mk-dark::before { content: ''; position: absolute; inset: -30% 30% auto -10%; height: 460px; background: radial-gradient(520px 300px at 20% 0%, rgba(37,99,235,.28), transparent 60%); animation: mkDrift 18s ease-in-out infinite alternate; pointer-events: none; }
.mk-dark .mk-wrap { position: relative; }
.mk-dark .mk-h2 { color: #fff; }
.mk-dark .mk-lead { color: #b9c4d8; }
.mk-checks { display: grid; grid-template-columns: repeat(2, minmax(240px, 1fr)); gap: 9px 26px; list-style: none; padding: 0; margin: 0 0 34px; max-width: 780px; }
.mk-checks li { padding-left: 28px; position: relative; font-size: 15px; color: #d6deec; transition: color .18s ease, transform .18s var(--ease); }
.mk-checks li:hover { color: #fff; transform: translateX(3px); }
.mk-checks li::before { content: '✓'; position: absolute; left: 0; top: 0; width: 19px; height: 19px; border-radius: 99px; background: rgba(59,130,246,.25); color: #93c5fd; font-size: 12px; font-weight: 800; display: flex; align-items: center; justify-content: center; transition: background .18s ease, color .18s ease; }
.mk-checks li:hover::before { background: #3b82f6; color: #fff; }
.mk-grid5 { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
.mk-gov { border: 1px solid rgba(148,163,184,.25); border-radius: 12px; padding: 16px; background: rgba(255,255,255,.04); transition: transform .2s var(--ease), background .2s ease, border-color .2s ease; }
.mk-gov:hover { transform: translateY(-4px); background: rgba(255,255,255,.09); border-color: rgba(59,130,246,.5); }
.mk-gov h4 { font-size: 14px; margin-bottom: 6px; color: #fff; }
.mk-gov p { font-size: 12.5px; color: #aeb9cd; }

/* pricing */
.mk-price-row { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; max-width: 860px; }
.mk-price { background: #fff; border: 1px solid var(--line); border-radius: 16px; padding: 26px; transition: transform .2s var(--ease), box-shadow .2s var(--ease), border-color .2s ease; }
.mk-price:first-child { border-color: rgba(37,99,235,.3); box-shadow: 0 10px 30px rgba(37,99,235,.08); }
.mk-price:hover { transform: translateY(-4px); box-shadow: 0 20px 46px rgba(16,24,40,.13); }
.mk-price-tag { font-size: 11.5px; font-weight: 800; letter-spacing: 1.1px; text-transform: uppercase; color: var(--blue); margin-bottom: 8px; }
.mk-price-big { font-size: 38px; font-weight: 800; letter-spacing: -1px; margin-bottom: 8px; }
.mk-price-big span { font-size: 16px; font-weight: 600; color: var(--mut); }
.mk-price p { color: var(--ink2); font-size: 14.5px; margin-bottom: 14px; }
@media (max-width: 980px) { .mk-price-row { grid-template-columns: 1fr; } }

/* walkthrough */
.mk-two-col { display: grid; grid-template-columns: 1.1fr .9fr; gap: 40px; align-items: start; }
.mk-form-card { background: #fff; border: 1px solid var(--line); border-radius: 16px; padding: 24px; box-shadow: 0 20px 48px rgba(16,24,40,.10); transition: box-shadow .25s var(--ease); }
.mk-form-card:hover { box-shadow: 0 28px 60px rgba(16,24,40,.16); }
.mk-form-card h3 { margin-bottom: 14px; }
.mk-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
.mk-form-card label { display: flex; flex-direction: column; gap: 5px; font-size: 12.5px; font-weight: 700; color: var(--ink2); }
.mk-form-card input, .mk-form-card select { font: inherit; font-weight: 400; padding: 9px 11px; border: 1.4px solid #d6dce8; border-radius: 9px; background: #fff; transition: border-color .16s ease, box-shadow .16s ease; }
.mk-form-card input:focus, .mk-form-card select:focus { outline: none; border-color: var(--blue); box-shadow: 0 0 0 3px rgba(37,99,235,.14); }
.mk-form-full { margin-bottom: 14px; }
.mk-thanks { font-size: 15.5px; color: var(--ink2); }

/* footer */
.mk-foot { background: #0b1220; color: #aeb9cd; padding: 54px 0 26px; }
.mk-foot-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 24px; padding-bottom: 32px; border-bottom: 1px solid rgba(148,163,184,.18); }
.mk-foot-head { font-size: 12px; font-weight: 800; letter-spacing: 1.1px; text-transform: uppercase; color: #e7edf7; margin-bottom: 12px; }
.mk-foot-grid a { display: block; font-size: 13px; padding: 3.5px 0; color: #aeb9cd; transition: color .15s ease, transform .15s var(--ease); }
.mk-foot-grid a:hover { color: #fff; transform: translateX(3px); }
.mk-foot-base { display: flex; justify-content: space-between; gap: 14px; flex-wrap: wrap; padding-top: 20px; font-size: 13px; align-items: center; }

/* reveal + stagger */
.mk-reveal { opacity: 0; transform: translateY(10px); transition: opacity .7s var(--ease), transform .7s var(--ease); }
.mk-reveal.vis { opacity: 1; transform: none; }
.mk-stag { opacity: 0; transform: translateY(26px); transition: opacity .6s var(--ease), transform .6s var(--ease); }
.vis .mk-stag, .mk-stag.vis { opacity: 1; transform: none; }

/* keyframes */
@keyframes mkDropIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
@keyframes mkFade { from { opacity: 0; } to { opacity: 1; } }
@keyframes mkFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-12px); } }
@keyframes mkDrift { 0% { transform: translate3d(0,0,0) scale(1); } 100% { transform: translate3d(-4%,3%,0) scale(1.08); } }
@keyframes mkPing { 0% { box-shadow: 0 0 0 0 rgba(34,197,94,.45); } 70%,100% { box-shadow: 0 0 0 7px rgba(34,197,94,0); } }

/* responsive */
@media (max-width: 980px) {
  .mk-menu { display: none; }
  .mk-hero-in { grid-template-columns: 1fr; padding: 46px 22px 54px; }
  .mk-hero-visual { animation: none; }
  .mk-two, .mk-two-col { grid-template-columns: 1fr; }
  .mk-grid3 { grid-template-columns: 1fr 1fr; }
  .mk-grid5 { grid-template-columns: 1fr 1fr; }
  .mk-checks { grid-template-columns: 1fr; }
  .mk-phone-mid { transform: none; }
}
@media (max-width: 620px) { .mk-grid3, .mk-grid5, .mk-form-grid { grid-template-columns: 1fr; } .mk-foot-grid { grid-template-columns: 1fr 1fr; } }

@media (prefers-reduced-motion: reduce) {
  body.mk { scroll-behavior: auto; }
  .mk-reveal, .mk-stag { opacity: 1 !important; transform: none !important; transition: none; }
  .mk-hero::before, .mk-dark::before, .mk-hero-visual, .mk-frame-feed div::before { animation: none !important; }
  .mk-frame-chart i { transform: scaleY(1); }
  .mk-btn-solid::after { display: none; }
}
`;
