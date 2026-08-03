import { html, raw, when, type Raw } from '../../lib/html.ts';
import { htmlRes, type Res } from '../../lib/http.ts';
import { logo, THEME_BOOT_JS } from '../../ui/ui.ts';
import { env } from '../../lib/env.ts';
import { MARKETING_CSS } from './styles.ts';

/** Shared marketing chrome — the logged-out site's nav, footer, styles, and
 * menu behavior, used by the homepage (/), every feature page (/platform/*,
 * /resident/*, /agents/*, /for/*), and the legal pages. One source of truth
 * so the dropdowns behave identically everywhere.
 *
 * Dropdown design (the "finicky" fix): hover is managed in JS with a close
 * grace period (mirrors the in-app module bar) instead of pure CSS :hover —
 * the old 8px hover gap between button and panel made menus vanish mid-
 * travel. A ::before bridge covers the gap geometrically, a 240ms timer
 * forgives diagonal travel, the first click on a hover-opened menu confirms
 * it, aria-expanded tracks state, and Escape / outside-click / focus-out all
 * close. Touch and keyboard never depend on hover. */

export type MkNavItem = [label: string, href: string, sub: string];
export interface MkNavGroup {
  label: string;
  href: string; // the group hub page
  items: MkNavItem[];
}

export const MK_NAV: MkNavGroup[] = [
  {
    label: 'Platform',
    href: '/platform',
    items: [
      ['Rent collection', '/platform/rent-collection', 'Autopay, late-fee policy, and AI follow-up on every balance'],
      ['Leasing CRM', '/platform/leasing-crm', 'Every lead answered in seconds; tours booked while you sleep'],
      ['Maintenance & turns', '/platform/maintenance', 'Requests triaged 24/7, vendors dispatched with approval'],
      ['Accounting', '/platform/accounting', 'Real double-entry books, bank rec, owner-ready statements'],
      ['Leases & e-sign', '/platform/leases-esign', 'Templates, packets, renewals, and signatures'],
      ['Applications & screening', '/platform/applications-screening', 'Applicant portal, criteria, and decisioning'],
      ['Property sites & listings', '/platform/property-sites', 'A leasing website per property with live pricing'],
      ['Renewals & pricing', '/platform/renewals-pricing', 'Under-market flags and renewal offers in bounds'],
      ['Reports', '/platform/reports', '50-report catalog, custom builder, scheduled email'],
      ['Utilities & RUBS', '/platform/utilities-rubs', 'Bill utilities back fairly when you need to'],
      ['Resident portal', '/platform/resident-portal', 'Tenants pay online and send requests with photos'],
    ],
  },
  {
    label: 'AI',
    href: '/agents',
    items: [
      ['New to AI? Start here', '/agents/new-to-ai', 'What it does, what it never does, how you stay in charge'],
      ['Leasing AI', '/agents/leasing', 'Answers every prospect from live availability'],
      ['Maintenance AI', '/agents/maintenance', 'Triage, emergency escalation, troubleshooting'],
      ['Payments AI', '/agents/payments', 'Rent reminders in your tone, inside the law'],
      ['Renewals AI', '/agents/renewals', 'Personalized offers, counters within bounds'],
      ['Call analysis', '/agents/call-analysis', 'Summaries, sentiment, and coaching notes'],
      ['Ask StayLeased', '/agents/ask-stayleased', 'Questions answered from your own data'],
      ['Approvals & control', '/agents/governance', 'Approval queue, audit trail, and the off switch'],
    ],
  },
  {
    label: "Who it's for",
    href: '/for',
    items: [
      ['Self-managing owners', '/for/self-managing-owners', 'Your portfolio, professionally run around the clock'],
      ['Small management companies', '/for/small-management-companies', 'Hundreds of doors on a two-person office'],
      ['Growing portfolios', '/for/growing-portfolios', 'Institutional-grade books without the headcount'],
      ['Switching from Buildium / AppFolio', '/for/switching-from-buildium-appfolio', 'Your rent roll imports in one afternoon'],
      ['Switching from spreadsheets', '/for/switching-from-spreadsheets', 'Keep the spreadsheet — upload it, we build the rest'],
    ],
  },
];

export function mkSignupOpen(): boolean {
  return !!env('SIGNUP_CODE');
}

/** Sticky marketing header with dropdown nav, CTAs, and the mobile menu. */
export function mkHeader(): Raw {
  const signupOpen = mkSignupOpen();
  const primaryCta = signupOpen
    ? html`<a class="mk-btn mk-btn-solid" href="/signup">Create your company</a>`
    : html`<a class="mk-btn mk-btn-solid" href="/#walkthrough">Book a walkthrough</a>`;
  return html`<header class="mk-nav">
  <div class="mk-wrap mk-nav-in">
    <a class="mk-logo" href="/">${logo(24, '#60a5fa')}<span>Stay<b>Leased</b></span></a>
    <nav class="mk-menu" aria-label="Main">
      ${MK_NAV.map((m, gi) => html`<div class="mk-item${gi === MK_NAV.length - 1 ? ' mk-item-end' : ''}"><button class="mk-item-btn" type="button" aria-haspopup="true" aria-expanded="false">${m.label}<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg></button>
        <div class="mk-drop"><div class="mk-drop-grid">
          ${m.items.map(([label2, href, sub]) => html`<a href="${href}"><b>${label2}</b><span>${sub}</span></a>`)}
        </div><a class="mk-drop-all" href="${m.href}">Everything in ${m.label} <span aria-hidden="true">→</span></a></div>
      </div>`)}
      <a class="mk-item-link" href="/#how">How it works</a>
    </nav>
    <div class="mk-nav-cta">
      <button class="mk-theme" data-theme-toggle type="button" aria-label="Toggle light or dark theme" title="Light / dark theme">${raw('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2.5M12 19v2.5M4.3 4.3l1.8 1.8M17.9 17.9l1.8 1.8M2.5 12H5M19 12h2.5M4.3 19.7l1.8-1.8M17.9 6.1l1.8-1.8"/></svg>')}</button>
      <a class="mk-btn mk-btn-ghost" href="/login">Sign in</a>
      ${primaryCta}
    </div>
    <button class="mk-burger" id="mk-burger" type="button" aria-label="Menu" aria-expanded="false" aria-controls="mk-mobile"><span></span><span></span><span></span></button>
  </div>
</header>
<div class="mk-mobile" id="mk-mobile">
    <div class="mk-mm-in">
      ${MK_NAV.map((m) => html`<details class="mk-mm-group">
        <summary>${m.label}<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg></summary>
        <div class="mk-mm-links">${m.items.map(([label2, href]) => html`<a href="${href}">${label2}</a>`)}<a class="mk-mm-all" href="${m.href}">Everything in ${m.label} →</a></div>
      </details>`)}
      <a class="mk-mm-link" href="/#how">How it works</a>
      <div class="mk-mm-cta">
        <a class="mk-btn mk-btn-line" href="/login">Sign in</a>
        ${signupOpen ? html`<a class="mk-btn mk-btn-solid" href="/signup">Create your company</a>` : html`<a class="mk-btn mk-btn-solid" href="/#walkthrough">Book a walkthrough</a>`}
      </div>
    </div>
</div>`;
}

/** Marketing mega-footer, shared by every logged-out page. */
export function mkFooter(): Raw {
  const signupOpen = mkSignupOpen();
  return html`<footer class="mk-foot">
  <div class="mk-wrap mk-foot-grid">
    <div><div class="mk-foot-head">Platform</div>${MK_NAV[0]!.items.slice(0, 8).map(([l, h]) => html`<a href="${h}">${l}</a>`)}<a href="/platform">All platform →</a></div>
    <div><div class="mk-foot-head">AI</div>${MK_NAV[1]!.items.map(([l, h]) => html`<a href="${h}">${l}</a>`)}</div>
    <div><div class="mk-foot-head">Who it's for</div>${MK_NAV[2]!.items.map(([l, h]) => html`<a href="${h}">${l}</a>`)}</div>
    <div><div class="mk-foot-head">Company</div>
      <a href="/login">Sign in</a>
      ${when(signupOpen, () => html`<a href="/signup">Create your company</a>`)}
      <a href="/#walkthrough">Book a walkthrough</a>
      <a href="/company">Communities</a>
      <a href="/legal/privacy">Privacy</a>
      <a href="/legal/terms">Terms</a>
    </div>
  </div>
  <div class="mk-wrap mk-foot-base">
    <span>${logo(18, '#5d6b82')} © 2026 StayLeased · Property management, run by AI</span>
    <span>⌂ Equal Housing Opportunity</span>
  </div>
</footer>`;
}

/** Wrap a marketing page body in the full document with chrome CSS + JS.
 * The homepage builds its own document (it carries extra scripts); feature
 * and legal pages use this. */
export function mkDoc(title: string, description: string, body: Raw): Res {
  return htmlRes(`<!doctype html>${html`<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<meta name="description" content="${description}" />
<meta property="og:title" content="${title}" />
<meta property="og:description" content="${description}" />
<meta property="og:type" content="website" /><meta property="og:site_name" content="StayLeased" />
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
${raw(`<script>${THEME_BOOT_JS}</script>`)}
<link rel="preload" href="/assets/fonts/inter-var.woff2" as="font" type="font/woff2" crossorigin />
<link rel="preload" href="/assets/fonts/space-grotesk-var.woff2" as="font" type="font/woff2" crossorigin />
<style>${raw(MARKETING_CSS)}</style>
</head><body class="mk">${body}${mkChromeScript()}</body></html>`.s}`);
}

/** The shared menu behavior (dropdowns + mobile panel + reveal-on-scroll +
 * condensed nav). One inline script tag; no framework, no backticks. */
export function mkChromeScript(): Raw {
  return raw(`<script>${CHROME_JS}</script>`);
}

const CHROME_JS = `
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- nav dropdowns: JS-managed hover intent + click + keyboard ----------
  var items = Array.prototype.slice.call(document.querySelectorAll('.mk-nav .mk-item'));
  var closeTimer = null;
  function cancelClose() { if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; } }
  function btnOf(it) { return it.querySelector('.mk-item-btn'); }
  function setOpen(it, on) {
    it.classList.toggle('open', on);
    var b = btnOf(it);
    if (b) b.setAttribute('aria-expanded', on ? 'true' : 'false');
    if (!on) delete it.dataset.hover;
  }
  function closeAll(except) { items.forEach(function (i) { if (i !== except) setOpen(i, false); }); }

  items.forEach(function (it) {
    var b = btnOf(it);
    if (!b) return;
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      // first click on a hover-opened menu confirms it; the next click toggles
      if (it.classList.contains('open') && it.dataset.hover) { delete it.dataset.hover; return; }
      var opening = !it.classList.contains('open');
      closeAll(null);
      setOpen(it, opening);
    });
    b.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!it.classList.contains('open')) { closeAll(null); setOpen(it, true); }
        var first = it.querySelector('.mk-drop a');
        if (first) first.focus();
      }
    });
    it.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      var links = Array.prototype.slice.call(it.querySelectorAll('.mk-drop a'));
      var idx = links.indexOf(document.activeElement);
      if (idx === -1) return;
      e.preventDefault();
      if (e.key === 'ArrowUp' && idx === 0) { b.focus(); return; }
      var next = e.key === 'ArrowDown' ? Math.min(links.length - 1, idx + 1) : idx - 1;
      links[next].focus();
    });
  });

  // hover open/close with a grace period — desktop pointer devices only;
  // click, touch, and keyboard never depend on this.
  if (window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    items.forEach(function (it) {
      it.addEventListener('mouseenter', function () {
        cancelClose();
        if (!it.classList.contains('open')) { closeAll(it); it.dataset.hover = '1'; setOpen(it, true); }
      });
      it.addEventListener('mouseleave', function () {
        cancelClose();
        closeTimer = setTimeout(function () { setOpen(it, false); }, 240);
      });
    });
  }

  document.addEventListener('click', function (e) {
    if (!e.target.closest('.mk-nav .mk-item')) closeAll(null);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var open = document.querySelector('.mk-nav .mk-item.open');
    if (open) {
      var b = btnOf(open);
      var hadFocus = open.contains(document.activeElement);
      closeAll(null);
      if (b && hadFocus) b.focus();
    }
  });
  // tabbing out of an open menu closes it (ignore hover-held menus)
  document.addEventListener('focusin', function (e) {
    items.forEach(function (it) {
      if (it.classList.contains('open') && !it.dataset.hover && !it.contains(e.target)) setOpen(it, false);
    });
  });

  // ---------- mobile menu ----------
  var burger = document.getElementById('mk-burger');
  var mm = document.getElementById('mk-mobile');
  function setMM(on) {
    if (!mm || !burger) return;
    mm.classList.toggle('open', on);
    burger.classList.toggle('active', on);
    burger.setAttribute('aria-expanded', on ? 'true' : 'false');
    document.body.classList.toggle('mk-mm-open', on);
  }
  if (burger && mm) {
    burger.addEventListener('click', function (e) { e.stopPropagation(); setMM(!mm.classList.contains('open')); });
    mm.addEventListener('click', function (e) { if (e.target.closest('a')) setMM(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setMM(false); });
    document.addEventListener('click', function (e) {
      if (mm.classList.contains('open') && !mm.contains(e.target) && e.target !== burger && !burger.contains(e.target)) setMM(false);
    });
  }

  // ---------- light / dark theme toggle ----------
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-theme-toggle]');
    if (!b) return;
    var el = document.documentElement;
    var next = el.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    el.setAttribute('data-theme', next);
    document.cookie = 'sl_theme=' + next + ';path=/;max-age=31536000;SameSite=Lax';
    document.dispatchEvent(new CustomEvent('sl-theme', { detail: next }));
  });

  // ---------- condensed nav on scroll (shared) ----------
  var nav = document.querySelector('.mk-nav');
  function onScroll() {
    var y = window.pageYOffset || document.documentElement.scrollTop;
    if (nav) nav.classList.toggle('scrolled', y > 8);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ---------- motion engine: choreographed ONE-SHOT reveals ----------
  // Doctrine: nothing is ever scrubbed by scroll position. Each section and
  // each staggered child animates exactly once on first entry, then holds
  // perfectly still. Direction, delay, and per-part choreography (step
  // numbers popping, table rows sliding, the draft card sequencing) all
  // live in CSS keyed off .vis + the --sd delay set here. The footer never
  // animates. Under prefers-reduced-motion nothing is hidden at all.
  if (reduce) {
    document.querySelectorAll('.mk-reveal, .mk-stag').forEach(function (el) { el.classList.add('vis'); });
    return;
  }
  var GROUPS = ['.mk-suites', '.mk-grid3', '.mk-grid2', '.mk-grid5', '.mkp-stats', '.mk-steps', '.mk-levels', '.mk-checks', '.mk-price-row', '.mk-ask-grid', '.mk-two-col', '.mk-two', '.mk-compare tbody'];
  GROUPS.forEach(function (sel) {
    document.querySelectorAll(sel).forEach(function (grp) {
      Array.prototype.forEach.call(grp.children, function (child, i) {
        child.classList.add('mk-stag');
        child.style.setProperty('--sd', (0.05 + Math.min(i, 9) * 0.08).toFixed(2) + 's');
      });
    });
  });
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('vis'); io.unobserve(en.target); } });
    }, { threshold: 0, rootMargin: '0px 0px -8% 0px' });
    // threshold 0: fires the moment the first pixel crosses the line 8%
    // above the viewport bottom — a fractional threshold can NEVER fire for
    // an element taller than that fraction allows (legal prose, long wraps)
    // every section wrap becomes a reveal trigger (headings + leads rise as
    // one; the hero and footer are excluded — hero animates on load, the
    // footer must be readable the instant it appears)
    document.querySelectorAll('.mk-band .mk-wrap, .mk-reveal').forEach(function (el) { el.classList.add('mk-reveal'); io.observe(el); });
    // staggered groups reveal on their own entry (their wrap may already be
    // visible when they scroll in, and some live outside .mk-band wraps)
    document.querySelectorAll(GROUPS.join(', ')).forEach(function (el) { io.observe(el); });
  } else {
    document.querySelectorAll('.mk-reveal, .mk-stag').forEach(function (el) { el.classList.add('vis'); });
  }
})();
`;

/** All marketing styles (homepage sections + feature pages + chrome) — v2
 * Obsidian dark design language; lives in styles.ts, re-exported here so
 * existing imports keep working. */
export { MARKETING_CSS };
