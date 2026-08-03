import { html, raw, when } from '../../lib/html.ts';
import { htmlRes, redirect, textRes, type Router, type Rq, type Res } from '../../lib/http.ts';
import { rateLimit } from '../../lib/auth.ts';
import { q1, insert } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso } from '../../lib/dates.ts';
import { askRoutes } from './ask.ts';
import { llmStatus } from '../../lib/sim/llm.ts';
import { mkHeader, mkFooter, mkChromeScript, mkSignupOpen, MARKETING_CSS, MK_NAV } from './chrome.ts';
import { THEME_BOOT_JS } from '../../ui/ui.ts';

/** The platform marketing homepage — the front door for logged-out visitors,
 * written for small operators (10–500 units), including ones who have never
 * used AI: hero → first-week walkthrough → everything-in-one-place → Ask
 * demo → never-used-AI reassurance → three autonomy modes → agent grid →
 * you-stay-in-control → who-it's-for → pricing → walkthrough form →
 * mega-footer. Entrata's enterprise framing (two platforms / ontology
 * layers / L1–L5 ladder) was deliberately retired 2026-07-28 — that
 * language sells to REITs, not landlords. Every claim maps to something
 * the product actually does; the demo login and /signup are one click away
 * everywhere. Nav, footer, styles, and menu behavior live in chrome.ts,
 * shared with the /platform, /agents, /for, and /legal pages. */

const STEPS: { n: string; name: string; tag: string; body: string }[] = [
  { n: '1', name: 'Upload what you have', tag: 'Day one · about an hour', body: 'Import your rent roll — a spreadsheet or an export from Buildium or AppFolio. The system builds your properties, units, residents, and balances for your review.' },
  { n: '2', name: 'Watch it draft, click approve', tag: 'Week one', body: 'Inquiries, delinquent balances, and maintenance requests each receive a drafted response in your approval queue. Nothing reaches a resident without your approval.' },
  { n: '3', name: 'Hand off what you trust', tag: 'When you are ready', body: 'When you find yourself approving certain drafts without edits, authorize them to send automatically — configured per property and reversible at any time.' },
];

const MODES: { l: string; name: string; body: string }[] = [
  { l: '1', name: 'It drafts, you approve', body: 'The default. Every proposed message waits in your queue for review, editing, and approval.' },
  { l: '2', name: 'It handles the routine, asks about the rest', body: 'Routine work is handled automatically within limits you define. Anything unusual or sensitive is escalated to you.' },
  { l: '3', name: 'It runs the job, you watch the log', body: 'For work you fully trust — such as after-hours lead responses — it completes the job, with every action recorded for review.' },
];

const AGENTS: { name: string; blurb: string }[] = [
  { name: 'Leasing', blurb: 'Every inquiry answered within seconds from live availability and pricing, with tours booked and after-hours coverage included.' },
  { name: 'Maintenance', blurb: 'Requests categorized and prioritized on arrival, with emergency escalation and guided troubleshooting.' },
  { name: 'Payments', blurb: 'Professional delinquency follow-up, with payment plans offered only within limits you define.' },
  { name: 'Renewals', blurb: 'Personalized renewal offers from resident history; counteroffers evaluated within your pricing bounds.' },
  { name: 'Call analysis', blurb: 'Summaries, sentiment, and coaching notes generated from every recorded call.' },
  { name: 'Ask StayLeased', blurb: 'Questions about your portfolio, answered directly from your live operating records.' },
];

const GOV_CARDS: { name: string; body: string }[] = [
  { name: 'Your rules', body: 'Late fees, screening criteria, and tour hours are set once and followed everywhere.' },
  { name: 'Your voice', body: 'It writes in your approved templates and tone — professional in every message.' },
  { name: 'On the record', body: 'Every human and AI action is recorded in a single log you can review.' },
  { name: 'Secure by design', body: 'Role-based access, isolated company records, and exports that remain yours.' },
  { name: 'You approve', body: 'Additional autonomy is granted by you — never assumed by the software.' },
];

const SOLUTIONS: { name: string; body: string }[] = [
  { name: 'Self-managing owners', body: 'You are the leasing agent, the maintenance coordinator, and the bookkeeper. The AI covers the hours you cannot.' },
  { name: 'Small management companies', body: 'Hundreds of doors on a small office — one system for every property, with owner-ready financials by default.' },
  { name: 'Growing portfolios', body: 'Institutional-grade accounting and reporting, so you can add buildings without adding headcount.' },
];

function cube(n: number): string {
  const hues = ['#22d3ee', '#60a5fa', '#a78bfa', '#8b5cf6', '#3b82f6'];
  const c = hues[n % hues.length]!;
  return `<svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3 29 10v12L16 29 3 22V10z" fill="${c}" opacity=".16"/><path d="M16 3 29 10 16 17 3 10z" fill="${c}" opacity=".55"/><path d="M16 17v12L3 22V10z" fill="${c}" opacity=".35"/><path d="M16 17v12l13-7V10z" fill="${c}"/></svg>`;
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
  <div class="mk-wrap mk-hero-in">
    <div class="mk-hero-copy">
      <div class="mk-kicker">Autonomous property management · Independent landlords &amp; small managers, 10–500 units</div>
      <h1>The property manager you could never afford <em>to hire.</em></h1>
      <p class="mk-sub">It answers your leads, collects your rent, coordinates maintenance, and maintains accurate books — with every action awaiting your approval.</p>
      <div class="mk-cta-row">
        <a class="mk-btn mk-btn-solid mk-btn-lg" href="/login">Explore the live demo</a>
        ${signupOpen ? html`<a class="mk-btn mk-btn-line mk-btn-lg" href="/signup">Create your company</a>` : html`<a class="mk-btn mk-btn-line mk-btn-lg" href="#walkthrough">Book a walkthrough</a>`}
      </div>
      <div class="mk-hero-note"><b>An afternoon,</b> not an implementation project — most portfolios import from Buildium, AppFolio, or spreadsheets in a single sitting. <b>Every AI draft</b> waits for your approval. <b>Real books,</b> true double-entry.</div>
    </div>
  </div>
</section>

<div class="mk-shotband">
  <div class="mk-wrap">
    <div class="mk-shot"><img src="/assets/mk/dashboard-light.png" alt="The StayLeased portfolio dashboard" width="2280" height="1425" loading="eager" /></div>
    <div class="mk-shot-cap"><span>The portfolio dashboard — live demonstration data, not a mockup</span><span>stayleased.com</span></div>
  </div>
</div>

<div class="mk-marquee" aria-hidden="true">
  <div class="mk-marquee-track">
    ${raw(Array.from({ length: 2 }, () => MK_NAV[0]!.items.map(([l]) => `<span class="mk-mq-item">${l}</span>`).join('')).join(''))}
  </div>
</div>

<section class="mk-band mk-band-alt" id="agents">
  <div class="mk-wrap">
    <h2 class="mk-h2">Purpose-built agents for every workflow.</h2>
    <p class="mk-lead">Not a chatbot attached to the side of your software — intelligence that works inside leasing, collections, maintenance, and renewals, drafting into your approval queue.</p>
    <div class="mk-grid3">
      ${AGENTS.map((a) => html`<div class="mk-card"><h3>${a.name}</h3><p>${a.blurb}</p></div>`)}
    </div>
    <div class="mk-inline-cta"><a class="mk-btn mk-btn-solid" href="/login">Watch the agents work in the demo</a></div>
  </div>
</section>

<section class="mk-band" id="how">
  <div class="mk-wrap">
    <h2 class="mk-h2">Operational in an afternoon.</h2>
    <p class="mk-lead">No implementation project and no onboarding team. The entire first week:</p>
    <div class="mk-steps">
      ${STEPS.map((st) => html`<div class="mk-step">
        <span class="mk-step-n">${st.n}</span>
        <div><div class="mk-step-head"><b>${st.name}</b><span class="mk-step-tag">${st.tag}</span></div><p>${st.body}</p></div>
      </div>`)}
    </div>
  </div>
</section>

<section class="mk-band mk-band-alt" id="platform">
  <div class="mk-wrap">
    <h2 class="mk-h2">Everything in one place.</h2>
    <p class="mk-lead">One system of record. A lead becomes a lease becomes rent in your general ledger — nothing is re-entered.</p>
    <div class="mk-two">
      <a class="mk-plat" href="/platform">
        <div class="mk-plat-tag">For you</div>
        <h3>Run the operation</h3>
        <p>Leasing, leases, rent collection, maintenance, vendors, true double-entry accounting, and the reports your owners and CPA expect.</p>
        <span class="mk-more">See everything included →</span>
      </a>
      <a class="mk-plat" href="/platform/resident-portal">
        <div class="mk-plat-tag">For your tenants</div>
        <h3>A portal residents use</h3>
        <p>Online payments with autopay, maintenance requests with photos, and lease documents — the routine calls, handled by the portal.</p>
        <span class="mk-more">How the portal works →</span>
      </a>
    </div>
    <div class="mkp-related" style="margin-top:22px">
      ${MK_NAV[0]!.items.map(([l, h]) => html`<a href="${h}">${l}</a>`)}
    </div>
  </div>
</section>

<section class="mk-band" id="ask">
  <div class="mk-wrap mk-ask-grid">
    <div class="mk-ask-copy">
      <div class="mk-kicker mk-kicker-ai">Ask StayLeased${aiLive ? ' · powered by Claude' : ''}</div>
      <h2 class="mk-h2">Ask anything. Get answers grounded in your data.</h2>
      <p class="mk-lead">Ask a question in plain English and receive a direct answer, drawn live from your occupancy, ledger, work orders, and leases.</p>
      <ul class="mk-ask-points">
        <li>Grounded in your actual figures — it does not invent numbers</li>
        <li>Answers about occupancy, collections, maintenance, and renewals</li>
        <li>${aiLive ? 'Powered by Anthropic’s Claude, live on this site' : 'Demonstration mode on this site; fully live in the product'}</li>
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

<section class="mk-band mk-band-alt" id="newtoai">
  <div class="mk-wrap mk-ask-grid">
    <div>
      <div class="mk-kicker">Never used AI before?</div>
      <h2 class="mk-h2">There is nothing to learn.</h2>
      <p class="mk-lead" style="margin-bottom:22px">No training and no prompts to write. The system reads what arrives, drafts what should go out, and waits for your approval.</p>
      <ul class="mkp-points">
        <li>Nothing is sent to a resident or prospect until you approve it — that is the default</li>
        <li>You review every word it writes, and you may edit before approving</li>
        <li>A single switch stops all AI activity immediately, at any time</li>
      </ul>
      <div class="mk-cta-row" style="margin-top:24px">
        <a class="mk-btn mk-btn-solid" href="/agents/new-to-ai">The plain-English tour</a>
        <a class="mk-btn mk-btn-line" href="/login">Watch it work in the demo</a>
      </div>
    </div>
    <div class="mk-nta-card" aria-hidden="true">
      <div class="mk-nta-row"><span class="mk-nta-time">9:04 pm</span> New lead from Zillow: <i>"Hi — is the 2 bedroom still available? Could I see it this weekend?"</i></div>
      <div class="mk-nta-draft">
        <div class="mk-nta-draft-tag">AI draft · waiting for your approval</div>
        <p>"Hi Sam — yes! The 2BR at Summit Ridge is available at $1,450, and Saturday works: I have 10:00, 11:30, or 2:00 open for a tour. Want me to hold one for you?"</p>
        <div class="mk-nta-actions"><span class="mk-nta-ok">✓ Approve</span><span class="mk-nta-edit">Edit</span><span class="mk-nta-skip">Reject</span></div>
      </div>
      <div class="mk-nta-note">Every price and time above came from the live system — it can't make things up. You approve it over coffee, or let after-hours replies send themselves once you trust it.</div>
    </div>
  </div>
</section>

<section class="mk-band" id="automation">
  <div class="mk-wrap">
    <h2 class="mk-h2">You set the level of autonomy.</h2>
    <p class="mk-lead">Three operating modes, configured per property and per function. The system earns autonomy the way an employee would — by demonstrating its work.</p>
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
    <h2 class="mk-h2">You stay in control. Always.</h2>
    <p class="mk-lead">The AI operates entirely within your rules, and every action is on the record.</p>
    <ul class="mk-checks">
      <li>Fair-housing guardrails on every prospect-facing reply — enforced in code</li>
      <li>Payment plans and concessions only inside limits you set</li>
      <li>An approval queue for everything you have not yet delegated</li>
      <li>Per-property settings for the level of autonomy</li>
      <li>A single control that stops all AI activity platform-wide</li>
      <li>A full log of every action — human and AI — you can read anytime</li>
    </ul>
    <div class="mk-grid5">
      ${GOV_CARDS.map((g) => html`<div class="mk-gov"><h4>${g.name}</h4><p>${g.body}</p></div>`)}
    </div>
  </div>
</section>

<section class="mk-band" id="solutions">
  <div class="mk-wrap">
    <h2 class="mk-h2">Built for independent operators.</h2>
    <p class="mk-lead">Enterprise platforms are designed for 20,000-unit institutions. StayLeased is designed for the independent owners and managers who operate most of America's rental housing.</p>
    <div class="mk-grid3">
      ${SOLUTIONS.map((s2) => html`<div class="mk-card"><h3>${s2.name}</h3><p>${s2.body}</p></div>`)}
    </div>
  </div>
</section>

<section class="mk-band mk-band-alt" id="pricing">
  <div class="mk-wrap">
    <h2 class="mk-h2">Straightforward pricing.</h2>
    <p class="mk-lead">No quote-only pricing and no implementation fees. Early-access partners run at no cost while the platform is built with them, and published per-unit pricing will appear on this page.</p>
    <div class="mk-price-row">
      <div class="mk-price">
        <div class="mk-price-tag">Early access</div>
        <div class="mk-price-big">Free</div>
        <p>The full platform. Import your portfolio, retain ownership of your records, and export at any time. An invitation code is required.</p>
        <a class="mk-btn mk-btn-solid" href="#walkthrough">Request an invite</a>
      </div>
      <div class="mk-price">
        <div class="mk-price-tag">What it replaces</div>
        <div class="mk-price-big">$300–800<span>/mo</span></div>
        <p>Typical monthly spend for a small portfolio on legacy software, before counting the hours spent each week on collections and bookkeeping.</p>
      </div>
    </div>
  </div>
</section>

<section class="mk-band mk-band-alt" id="walkthrough">
  <div class="mk-wrap mk-two-col">
    <div>
      <h2 class="mk-h2">See autonomous property management in action.</h2>
      <p class="mk-lead">Explore the fully populated demonstration company — every screen live, every agent at work. Or tell us about your portfolio and we will prepare your import.</p>
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
      <div class="mk-msg agent">Hello — I am the StayLeased assistant. I can answer questions about the product: pricing, migrating from your current software, what the AI agents do, and how to get started.</div>
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

  // scroll progress bar + back-to-top on scroll (condensed nav: chrome script)
  var prog = document.getElementById('mkprog');
  var toTop = document.getElementById('mktop');
  var heroFrame = document.querySelector('.mk-hero .mk-frame');
  function onScroll() {
    var h = document.documentElement;
    var y = window.pageYOffset || h.scrollTop;
    var max = (h.scrollHeight - h.clientHeight) || 1;
    var p = Math.min(1, Math.max(0, y / max));
    if (prog) prog.style.transform = 'scaleX(' + p + ')';
    if (toTop) toTop.classList.toggle('show', y > 560);
    if (heroFrame && !reduce) heroFrame.style.setProperty('--pz', Math.min(80, y * 0.09).toFixed(1) + 'px');
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
  ['.mk-two', '.mk-grid3', '.mk-grid5', '.mk-levels', '.mk-steps', '.mk-price-row', '.mk-checks', '.mk-foot-grid', '.mk-ask-grid', '.mk-two-col'].forEach(function (sel) {
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
<meta name="description" content="Property management software that does the work: answers your leads, collects rent, handles maintenance calls, and keeps real books. Built for independent landlords and small management companies, 10–500 units." />
<meta property="og:title" content="StayLeased — Autonomous Property Management" />
<meta property="og:description" content="The property manager you can't afford to hire. Upload your rent roll and be running in an afternoon — every AI draft waits for your approval." />
<meta property="og:type" content="website" /><meta property="og:site_name" content="StayLeased" />
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
${raw(`<script>${THEME_BOOT_JS}</script>`)}
<link rel="preload" href="/assets/fonts/inter-var.woff2" as="font" type="font/woff2" crossorigin />
<link rel="preload" href="/assets/fonts/fraunces-var.woff2" as="font" type="font/woff2" crossorigin />
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

