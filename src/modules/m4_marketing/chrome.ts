import { html, raw, when, type Raw } from '../../lib/html.ts';
import { htmlRes, type Res } from '../../lib/http.ts';
import { logo } from '../../ui/ui.ts';
import { env } from '../../lib/env.ts';

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
      ['Self-managing owners', '/for/self-managing-owners', 'Your 10–100 doors, without the 11pm admin shift'],
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
    <a class="mk-logo" href="/">${logo(24, '#2563eb')}<span>Stay<b>Leased</b></span></a>
    <nav class="mk-menu" aria-label="Main">
      ${MK_NAV.map((m, gi) => html`<div class="mk-item${gi === MK_NAV.length - 1 ? ' mk-item-end' : ''}"><button class="mk-item-btn" type="button" aria-haspopup="true" aria-expanded="false">${m.label}<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg></button>
        <div class="mk-drop"><div class="mk-drop-grid">
          ${m.items.map(([label2, href, sub]) => html`<a href="${href}"><b>${label2}</b><span>${sub}</span></a>`)}
        </div><a class="mk-drop-all" href="${m.href}">Everything in ${m.label} <span aria-hidden="true">→</span></a></div>
      </div>`)}
      <a class="mk-item-link" href="/#how">How it works</a>
    </nav>
    <div class="mk-nav-cta">
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
    <span>${logo(18, '#94a3b8')} © 2026 StayLeased · Property management, run by AI</span>
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

  // ---------- condensed nav on scroll (shared) ----------
  var nav = document.querySelector('.mk-nav');
  function onScroll() {
    var y = window.pageYOffset || document.documentElement.scrollTop;
    if (nav) nav.classList.toggle('scrolled', y > 8);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ---------- reveal-on-scroll for pages that opt in via .mk-reveal ----------
  if (reduce) {
    document.querySelectorAll('.mk-reveal, .mk-stag').forEach(function (el) { el.classList.add('vis'); });
    return;
  }
  ['.mk-grid3', '.mk-grid2', '.mkp-stats', '.mk-foot-grid'].forEach(function (sel) {
    document.querySelectorAll(sel).forEach(function (grp) {
      Array.prototype.forEach.call(grp.children, function (child, i) {
        child.classList.add('mk-stag');
        child.style.transitionDelay = (0.05 + i * 0.06) + 's';
      });
    });
  });
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('vis'); io.unobserve(en.target); } });
    }, { threshold: 0.1, rootMargin: '0px 0px -7% 0px' });
    document.querySelectorAll('.mk-reveal').forEach(function (el) { io.observe(el); });
  } else {
    document.querySelectorAll('.mk-reveal, .mk-stag').forEach(function (el) { el.classList.add('vis'); });
  }
})();
`;

/** All marketing styles (homepage sections + feature pages + chrome). */
export const MARKETING_CSS = `
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
.mk-item.open .mk-item-btn { background: var(--bg2); color: var(--ink); }
.mk-item-link { font-weight: 600; font-size: 14.5px; color: var(--ink2); padding: 9px 12px; border-radius: 8px; transition: background .15s ease, color .15s ease; }
.mk-item-btn:hover, .mk-item-link:hover { background: var(--bg2); color: var(--ink); }
.mk-drop { position: absolute; left: 0; top: calc(100% + 8px); background: #fff; border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 22px 55px rgba(16,24,40,.16); padding: 10px; display: none; max-width: calc(100vw - 32px); }
.mk-drop::before { content: ''; position: absolute; left: 0; right: 0; top: -9px; height: 9px; }
.mk-item-end .mk-drop { left: auto; right: 0; }
.mk-item.open .mk-drop { display: block; animation: mkDropIn .2s var(--ease); }
.mk-drop-grid { display: grid; grid-template-columns: repeat(2, 280px); gap: 2px; }
.mk-drop-grid a { display: flex; flex-direction: column; gap: 1px; padding: 9px 11px; border-radius: 9px; transition: background .14s ease, transform .14s ease; }
.mk-drop-grid a:hover, .mk-drop-grid a:focus-visible { background: var(--bg2); transform: translateX(3px); }
.mk-drop-grid b { font-size: 13.5px; }
.mk-drop-grid span { font-size: 12px; color: var(--mut); }
.mk-drop-all { display: block; margin: 8px 3px 1px; padding: 8px 11px; border-top: 1px solid var(--line); font-size: 12.5px; font-weight: 700; color: var(--blue); border-radius: 0 0 9px 9px; }
.mk-drop-all:hover { background: var(--bg2); }
.mk-nav-cta { display: flex; gap: 9px; align-items: center; }

/* burger + mobile menu */
.mk-burger { display: none; flex-direction: column; justify-content: center; gap: 5px; width: 42px; height: 42px; padding: 10px; background: none; border: 0; border-radius: 10px; cursor: pointer; }
.mk-burger span { display: block; height: 2.4px; border-radius: 2px; background: var(--ink); transition: transform .22s var(--ease), opacity .18s ease; }
.mk-burger.active span:nth-child(1) { transform: translateY(7.4px) rotate(45deg); }
.mk-burger.active span:nth-child(2) { opacity: 0; }
.mk-burger.active span:nth-child(3) { transform: translateY(-7.4px) rotate(-45deg); }
.mk-mobile { display: none; position: fixed; inset: 0; z-index: 59; background: #fff; overflow-y: auto; }
.mk-mobile.open { display: block; animation: mkFade .18s ease; }
body.mk-mm-open { overflow: hidden; }
.mk-mm-in { padding: 78px 22px 40px; }
.mk-mm-group { border-bottom: 1px solid var(--line); }
.mk-mm-group summary { display: flex; align-items: center; justify-content: space-between; padding: 15px 2px; font-weight: 700; font-size: 16px; cursor: pointer; list-style: none; }
.mk-mm-group summary::-webkit-details-marker { display: none; }
.mk-mm-group[open] summary svg { transform: rotate(180deg); }
.mk-mm-group summary svg { transition: transform .2s var(--ease); color: var(--mut); }
.mk-mm-links { display: grid; padding: 0 2px 14px; }
.mk-mm-links a { padding: 8px 10px; font-size: 14.5px; color: var(--ink2); border-radius: 8px; }
.mk-mm-links a:hover { background: var(--bg2); color: var(--ink); }
.mk-mm-links .mk-mm-all { font-weight: 700; color: var(--blue); }
.mk-mm-link { display: block; padding: 15px 2px; font-weight: 700; font-size: 16px; border-bottom: 1px solid var(--line); }
.mk-mm-cta { display: grid; gap: 10px; padding: 20px 2px 0; }

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
.mk-kicker { display: inline-block; font-size: 12px; font-weight: 800; letter-spacing: 1.3px; text-transform: uppercase; color: var(--blue); background: rgba(37,99,235,.09); border: 1px solid rgba(37,99,235,.22); padding: 5px 12px; border-radius: 99px; margin-bottom: 18px; animation: mkKicker 3.2s ease-in-out infinite; }
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

/* first-week steps */
.mk-steps { display: grid; gap: 12px; max-width: 860px; }
.mk-step { display: flex; gap: 18px; background: #fff; border: 1px solid var(--line); border-radius: 13px; padding: 18px 20px; transition: transform .18s var(--ease), box-shadow .18s var(--ease), border-color .18s ease; }
.mk-step:hover { transform: translateX(6px); box-shadow: 0 14px 34px rgba(16,24,40,.11); border-color: rgba(37,99,235,.28); }
.mk-step-n { flex: none; width: 34px; height: 34px; border-radius: 10px; background: rgba(37,99,235,.1); color: var(--blue); font-weight: 800; display: flex; align-items: center; justify-content: center; transition: background .2s ease, transform .2s var(--ease); }
.mk-step:hover .mk-step-n { background: var(--blue); color: #fff; transform: scale(1.06); }
.mk-step-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; }
.mk-step-head b { font-size: 16.5px; }
.mk-step-tag { font-size: 11.5px; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; color: var(--mut); }
.mk-step p { color: var(--ink2); font-size: 14.5px; }

/* never-used-AI example card */
.mk-nta-card { background: #fff; border: 1px solid var(--line); border-radius: 18px; box-shadow: 0 30px 66px rgba(16,24,40,.14); padding: 20px; display: grid; gap: 14px; }
.mk-nta-row { font-size: 14px; color: var(--ink2); }
.mk-nta-row i { color: var(--ink); font-style: normal; font-weight: 600; }
.mk-nta-time { display: inline-block; font-size: 11px; font-weight: 800; letter-spacing: .8px; color: var(--mut); background: var(--bg2); border-radius: 99px; padding: 2px 9px; margin-right: 6px; }
.mk-nta-draft { border: 1.5px solid rgba(37,99,235,.35); background: #f7faff; border-radius: 13px; padding: 14px 15px; }
.mk-nta-draft-tag { font-size: 11px; font-weight: 800; letter-spacing: .9px; text-transform: uppercase; color: var(--blue); margin-bottom: 7px; }
.mk-nta-draft p { font-size: 14px; color: var(--ink); }
.mk-nta-actions { display: flex; gap: 8px; margin-top: 12px; }
.mk-nta-actions span { font-size: 12.5px; font-weight: 700; border-radius: 8px; padding: 6px 12px; }
.mk-nta-ok { background: var(--blue); color: #fff; box-shadow: 0 6px 14px rgba(37,99,235,.3); }
.mk-nta-edit { border: 1.4px solid #c9d4ea; color: var(--ink2); background: #fff; }
.mk-nta-skip { color: var(--mut); }
.mk-nta-note { font-size: 12.5px; color: var(--mut); border-top: 1px dashed var(--line); padding-top: 12px; }

/* automation levels */
.mk-levels { position: relative; display: grid; gap: 12px; max-width: 860px; }
.mk-levels::before { content: ''; position: absolute; left: 27px; top: 18px; bottom: 18px; width: 2px; background: linear-gradient(180deg, #2563eb, #dbe4f5); transform: scaleY(0); transform-origin: top; transition: transform .9s var(--ease) .15s; }
.vis .mk-levels::before { transform: scaleY(1); }
.mk-level { position: relative; display: flex; gap: 18px; background: #fff; border: 1px solid var(--line); border-radius: 13px; padding: 17px 20px; transition: transform .18s var(--ease), box-shadow .18s var(--ease), border-color .18s ease; }
.mk-level:hover { transform: translateX(6px); box-shadow: 0 14px 34px rgba(16,24,40,.11); border-color: rgba(37,99,235,.28); }
.mk-level-cube { flex: none; width: 30px; transition: transform .3s var(--ease); }
.mk-level:hover .mk-level-cube { transform: rotate(-8deg) scale(1.1); }
.mk-level-head { font-size: 15.5px; margin-bottom: 3px; }
.mk-level-head b { color: var(--blue); }
.mk-level p { color: var(--ink2); font-size: 14.5px; }

/* cards */
.mk-grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.mk-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.mk-card { position: relative; border: 1px solid var(--line); background: #fff; border-radius: 14px; padding: 22px; overflow: hidden; transition: transform .2s var(--ease), box-shadow .2s var(--ease), border-color .2s ease; }
.mk-card::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: linear-gradient(180deg, #2563eb, #22d3ee); transform: scaleY(0); transform-origin: 50% 0; transition: transform .28s var(--ease); }
.mk-card:hover { transform: translateY(-4px); box-shadow: 0 18px 40px rgba(16,24,40,.12); border-color: rgba(37,99,235,.24); }
.mk-card:hover::before { transform: scaleY(1); }
.mk-card h3 { font-size: 17px; margin-bottom: 7px; }
.mk-card p { color: var(--ink2); font-size: 14.5px; }
.mk-card .mk-more { margin-top: 10px; }
.mk-inline-cta { margin-top: 28px; }

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
.mk-foot-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 24px; padding-bottom: 32px; border-bottom: 1px solid rgba(148,163,184,.18); }
.mk-foot-head { font-size: 12px; font-weight: 800; letter-spacing: 1.1px; text-transform: uppercase; color: #e7edf7; margin-bottom: 12px; }
.mk-foot-grid a { display: block; font-size: 13px; padding: 3.5px 0; color: #aeb9cd; transition: color .15s ease, transform .15s var(--ease); }
.mk-foot-grid a:hover { color: #fff; transform: translateX(3px); }
.mk-foot-base { display: flex; justify-content: space-between; gap: 14px; flex-wrap: wrap; padding-top: 20px; font-size: 13px; align-items: center; }

/* reveal + stagger */
.mk-reveal { opacity: 0; transform: translateY(10px); transition: opacity .7s var(--ease), transform .7s var(--ease); }
.mk-reveal.vis { opacity: 1; transform: none; }
.mk-stag { opacity: 0; transform: translateY(26px); transition: opacity .6s var(--ease), transform .6s var(--ease); }
.vis .mk-stag, .mk-stag.vis { opacity: 1; transform: none; }

/* ask stayleased section */
.mk-kicker-ai { display: inline-flex; align-items: center; gap: 7px; }
.mk-ask-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 44px; align-items: center; }
.mk-ask-copy .mk-h2 { margin-bottom: 0; }
.mk-ask-points { list-style: none; padding: 0; margin: 18px 0 24px; display: grid; gap: 9px; }
.mk-ask-points li { position: relative; padding-left: 26px; font-size: 14.5px; color: var(--ink2); }
.mk-ask-points li::before { content: ''; position: absolute; left: 0; top: 6px; width: 15px; height: 15px; border-radius: 99px; background: rgba(37,99,235,.14); }
.mk-ask-points li::after { content: ''; position: absolute; left: 5px; top: 10px; width: 5px; height: 5px; border-radius: 99px; background: var(--blue); }
.mk-askbox { background: #fff; border: 1px solid var(--line); border-radius: 18px; box-shadow: 0 30px 66px rgba(16,24,40,.14); overflow: hidden; display: flex; flex-direction: column; min-height: 420px; }
.mk-askbox-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; background: linear-gradient(180deg, #f7f9ff, #fff); border-bottom: 1px solid var(--line); }
.mk-askbox-id { display: flex; align-items: center; gap: 10px; }
.mk-askbox-av { width: 34px; height: 34px; border-radius: 10px; background: linear-gradient(135deg, #2563eb, #22d3ee); color: #fff; font-size: 12px; font-weight: 800; display: flex; align-items: center; justify-content: center; }
.mk-askbox-id b { font-size: 14px; display: block; }
.mk-askbox-id span { font-size: 11.5px; color: var(--mut); }
.mk-live { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 800; letter-spacing: .8px; color: #15803d; background: #dcfce7; border-radius: 99px; padding: 3px 9px; }
.mk-live i { width: 7px; height: 7px; border-radius: 99px; background: #22c55e; animation: mkPulse 1.8s ease-in-out infinite; }
.mk-ask-msgs, .mk-chat-msgs { flex: 1; padding: 16px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
.mk-ask-msgs { min-height: 210px; max-height: 300px; }
.mk-msg { max-width: 85%; padding: 10px 13px; border-radius: 14px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; animation: mkMsgIn .3s var(--ease); }
.mk-msg.you { align-self: flex-end; background: var(--blue); color: #fff; border-bottom-right-radius: 5px; }
.mk-msg.agent { align-self: flex-start; background: var(--bg2); color: var(--ink); border-bottom-left-radius: 5px; border: 1px solid var(--line); }
.mk-typing { display: inline-flex; gap: 4px; padding: 2px 0; }
.mk-typing i { width: 6px; height: 6px; border-radius: 99px; background: #9aa6b8; animation: mkBlink 1.2s infinite ease-in-out; }
.mk-typing i:nth-child(2) { animation-delay: .18s; }
.mk-typing i:nth-child(3) { animation-delay: .36s; }
.mk-ask-chips, .mk-chat-chips { display: flex; flex-wrap: wrap; gap: 7px; padding: 0 16px 12px; }
.mk-ask-chip.active { border-color: var(--blue); background: var(--blue); color: #fff; box-shadow: 0 6px 16px rgba(37,99,235,.32); }
.mk-ask-chip { font: inherit; font-size: 12.5px; font-weight: 600; color: var(--ink2); background: #fff; border: 1px solid #d6dce8; border-radius: 99px; padding: 6px 12px; cursor: pointer; transition: border-color .15s ease, color .15s ease, background .15s ease, transform .15s var(--ease); }
.mk-ask-chip:hover { border-color: var(--blue); color: var(--blue); background: rgba(37,99,235,.05); transform: translateY(-1px); }
.mk-ask-form, .mk-chat-form { display: flex; gap: 8px; padding: 12px 14px; border-top: 1px solid var(--line); background: #fff; }
.mk-ask-form input, .mk-chat-form input { flex: 1; font: inherit; font-size: 14px; padding: 10px 13px; border: 1.4px solid #d6dce8; border-radius: 11px; background: #fff; }
.mk-ask-form input:focus, .mk-chat-form input:focus { outline: none; border-color: var(--blue); box-shadow: 0 0 0 3px rgba(37,99,235,.14); }
.mk-ask-form button, .mk-chat-form button { flex: none; width: 42px; border: 0; border-radius: 11px; background: var(--blue); color: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background .16s ease, transform .16s var(--ease); }
.mk-ask-form button:hover, .mk-chat-form button:hover { background: var(--blue-d); transform: translateY(-1px); }

/* floating chat widget */
.mk-chat { position: fixed; right: 22px; bottom: 22px; z-index: 80; }
.mk-chat-launch { display: inline-flex; align-items: center; gap: 9px; font: inherit; font-weight: 700; font-size: 14.5px; color: #fff; background: var(--blue); border: 0; border-radius: 99px; padding: 12px 18px 12px 15px; cursor: pointer; box-shadow: 0 14px 34px rgba(37,99,235,.45); transition: transform .2s var(--ease), box-shadow .2s var(--ease), background .2s ease; }
.mk-chat-launch:hover { transform: translateY(-2px); box-shadow: 0 18px 42px rgba(37,99,235,.55); background: var(--blue-d); }
.mk-chat.open .mk-chat-launch { transform: scale(.9); opacity: 0; pointer-events: none; }
.mk-chat-panel { position: absolute; right: 0; bottom: 0; width: min(380px, calc(100vw - 32px)); height: min(560px, calc(100vh - 110px)); background: #fff; border: 1px solid var(--line); border-radius: 18px; box-shadow: 0 34px 80px rgba(16,24,40,.28); display: flex; flex-direction: column; overflow: hidden; opacity: 0; transform: translateY(20px) scale(.96); transform-origin: bottom right; pointer-events: none; transition: opacity .24s var(--ease), transform .24s var(--ease); }
.mk-chat.open .mk-chat-panel { opacity: 1; transform: none; pointer-events: auto; }
.mk-chat-head { display: flex; align-items: center; justify-content: space-between; padding: 13px 15px; background: linear-gradient(135deg, #2563eb, #1d4ed8); color: #fff; }
.mk-chat-id { display: flex; align-items: center; gap: 10px; }
.mk-chat-av { width: 32px; height: 32px; border-radius: 9px; background: rgba(255,255,255,.2); color: #fff; font-size: 12px; font-weight: 800; display: flex; align-items: center; justify-content: center; }
.mk-chat-id b { font-size: 14px; display: block; }
.mk-chat-id span { font-size: 11px; opacity: .85; }
.mk-chat-close { background: rgba(255,255,255,.16); border: 0; color: #fff; width: 28px; height: 28px; border-radius: 8px; cursor: pointer; font-size: 14px; transition: background .15s ease; }
.mk-chat-close:hover { background: rgba(255,255,255,.28); }
.mk-chat-msgs { background: var(--bg2); }
.mk-chat-chips { padding-top: 10px; background: var(--bg2); }
body.mk-chat-open #mktop { opacity: 0; pointer-events: none; }

/* ---------- feature pages ---------- */
.mkp-hero { position: relative; background: linear-gradient(180deg, #f7faff, #fff 82%); border-bottom: 1px solid var(--line); overflow: hidden; }
.mkp-hero::before { content: ''; position: absolute; inset: -30% -10% auto -10%; height: 480px; background: radial-gradient(640px 340px at 80% 0%, rgba(37,99,235,.16), transparent 62%); pointer-events: none; }
.mkp-hero-in { position: relative; display: grid; grid-template-columns: 1.08fr .92fr; gap: 44px; align-items: center; padding: 64px 22px 70px; }
.mkp-crumb { font-size: 12.5px; font-weight: 700; color: var(--mut); margin-bottom: 14px; }
.mkp-crumb a { color: var(--blue); }
.mkp-crumb a:hover { text-decoration: underline; }
.mkp-hero h1 { font-size: clamp(30px, 3.8vw, 46px); line-height: 1.08; letter-spacing: -1.1px; font-weight: 800; }
.mkp-sub { font-size: 17.5px; color: var(--ink2); margin: 16px 0 22px; max-width: 36em; }
.mkp-points { list-style: none; padding: 0; margin: 0 0 26px; display: grid; gap: 9px; }
.mkp-points li { position: relative; padding-left: 27px; font-size: 15px; color: var(--ink2); }
.mkp-points li::before { content: '✓'; position: absolute; left: 0; top: 2px; width: 18px; height: 18px; border-radius: 99px; background: rgba(37,99,235,.12); color: var(--blue); font-size: 11px; font-weight: 800; display: flex; align-items: center; justify-content: center; }
.mkp-chip { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 700; border-radius: 99px; padding: 5px 12px; margin: 0 0 20px; }
.mkp-chip::before { content: ''; width: 7px; height: 7px; border-radius: 99px; background: currentColor; }
.mkp-chip.live { color: #15803d; background: #dcfce7; border: 1px solid #bbf7d0; }
.mkp-chip.soon { color: #92400e; background: #fef3c7; border: 1px solid #fde68a; }
.mkp-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin: 34px 0 0; }
.mkp-stat { border: 1px solid var(--line); border-radius: 13px; background: #fff; padding: 16px 18px; transition: transform .2s var(--ease), box-shadow .2s var(--ease), border-color .2s ease; }
.mkp-stat:hover { transform: translateY(-3px); box-shadow: 0 12px 26px rgba(16,24,40,.09); border-color: rgba(37,99,235,.3); }
.mkp-stat b { display: block; font-size: 15.5px; margin-bottom: 3px; }
.mkp-stat span { font-size: 13.5px; color: var(--mut); }
.mkp-faq { max-width: 860px; display: grid; gap: 8px; }
.mkp-faq details { border: 1px solid var(--line); border-radius: 12px; background: #fff; }
.mkp-faq summary { padding: 14px 18px; font-weight: 700; font-size: 15px; cursor: pointer; list-style: none; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.mkp-faq summary::-webkit-details-marker { display: none; }
.mkp-faq summary::after { content: '+'; font-size: 19px; font-weight: 600; color: var(--mut); transition: transform .2s var(--ease); }
.mkp-faq details[open] summary::after { transform: rotate(45deg); }
.mkp-faq details[open] { border-color: rgba(37,99,235,.4); }
.mkp-faq .mkp-a { padding: 0 18px 15px; color: var(--ink2); font-size: 14.5px; max-width: 52em; }
.mkp-related { display: flex; flex-wrap: wrap; gap: 10px; }
.mkp-related a { display: inline-flex; align-items: center; gap: 7px; border: 1px solid var(--line); background: #fff; border-radius: 99px; padding: 8px 15px; font-size: 13.5px; font-weight: 600; color: var(--ink2); transition: border-color .16s ease, color .16s ease, transform .16s var(--ease), box-shadow .16s var(--ease); }
.mkp-related a:hover { border-color: var(--blue); color: var(--blue); transform: translateY(-2px); box-shadow: 0 8px 20px rgba(37,99,235,.12); }
.mkp-cta { background: linear-gradient(180deg, #0b1220, #101b33); color: #fff; text-align: center; padding: 64px 0; }
.mkp-cta h2 { font-size: clamp(24px, 3vw, 34px); letter-spacing: -.7px; font-weight: 800; margin-bottom: 10px; }
.mkp-cta p { color: #b9c4d8; margin-bottom: 24px; }
.mkp-cta .mk-cta-row { justify-content: center; }
.mkp-cta .mk-btn-line { background: transparent; color: #fff; border-color: rgba(255,255,255,.35); }
.mkp-cta .mk-btn-line:hover { border-color: #fff; color: #fff; }
.mkp-hub-lead { padding-top: 56px; }
.mkp-prose { max-width: 760px; padding: 56px 22px 72px; margin: 0 auto; }
.mkp-prose h1 { font-size: clamp(28px, 3.4vw, 40px); letter-spacing: -.9px; margin-bottom: 6px; }
.mkp-prose .mkp-date { color: var(--mut); font-size: 13.5px; margin-bottom: 26px; }
.mkp-prose h2 { font-size: 20px; letter-spacing: -.3px; margin: 30px 0 8px; }
.mkp-prose p, .mkp-prose li { color: var(--ink2); font-size: 15px; }
.mkp-prose ul { padding-left: 22px; margin: 8px 0; }
.mkp-prose li { margin: 4px 0; }

/* keyframes */
@keyframes mkPulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
@keyframes mkBlink { 0%,80%,100% { transform: translateY(0); opacity: .5; } 40% { transform: translateY(-3px); opacity: 1; } }
@keyframes mkMsgIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes mkDropIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
@keyframes mkFade { from { opacity: 0; } to { opacity: 1; } }
@keyframes mkFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-12px); } }
@keyframes mkDrift { 0% { transform: translate3d(0,0,0) scale(1); } 100% { transform: translate3d(-4%,3%,0) scale(1.08); } }
@keyframes mkPing { 0% { box-shadow: 0 0 0 0 rgba(34,197,94,.45); } 70%,100% { box-shadow: 0 0 0 7px rgba(34,197,94,0); } }
@keyframes mkKicker { 0%,100% { box-shadow: 0 0 0 0 rgba(37,99,235,0); } 50% { box-shadow: 0 0 0 5px rgba(37,99,235,.08); } }

/* back-to-top */
#mktop { position: fixed; right: 22px; bottom: 22px; z-index: 70; width: 46px; height: 46px; border-radius: 50%; border: 0; background: var(--blue); color: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 12px 28px rgba(37,99,235,.42); opacity: 0; transform: translateY(16px) scale(.9); pointer-events: none; transition: opacity .28s var(--ease), transform .28s var(--ease), background .2s ease; }
#mktop.show { opacity: 1; transform: none; pointer-events: auto; }
#mktop:hover { background: var(--blue-d); transform: translateY(-3px); box-shadow: 0 16px 34px rgba(37,99,235,.5); }
#mktop:active { transform: translateY(0); }

/* responsive */
@media (max-width: 980px) {
  .mk-menu, .mk-nav-cta { display: none; }
  .mk-burger { display: flex; }
  .mk-hero-in, .mkp-hero-in { grid-template-columns: 1fr; padding: 46px 22px 54px; }
  .mk-hero-visual { animation: none; }
  .mk-two, .mk-two-col, .mk-ask-grid { grid-template-columns: 1fr; }
  .mk-grid3 { grid-template-columns: 1fr 1fr; }
  .mk-grid5 { grid-template-columns: 1fr 1fr; }
  .mk-grid2 { grid-template-columns: 1fr; }
  .mk-checks { grid-template-columns: 1fr; }
  .mkp-stats { grid-template-columns: 1fr; }
}
@media (max-width: 620px) { .mk-grid3, .mk-grid5, .mk-form-grid { grid-template-columns: 1fr; } .mk-foot-grid { grid-template-columns: 1fr 1fr; } }

@media (prefers-reduced-motion: reduce) {
  body.mk { scroll-behavior: auto; }
  .mk-reveal, .mk-stag { opacity: 1 !important; transform: none !important; transition: none; }
  .mk-hero::before, .mk-dark::before, .mk-hero-visual, .mk-frame-feed div::before, .mk-kicker { animation: none !important; }
  .mk-frame-chart i { transform: scaleY(1); }
  .mk-levels::before { transform: none !important; }
  .mk-btn-solid::after { display: none; }
  #mktop { transition: opacity .2s ease; }
  .mk-live i, .mk-typing i { animation: none !important; }
  .mk-msg { animation: none; }
  .mk-item.open .mk-drop, .mk-mobile.open { animation: none; }
}
`;
