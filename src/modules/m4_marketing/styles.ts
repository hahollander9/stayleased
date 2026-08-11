/** Marketing site styles v9 — the differentiation build (2026-08-05) on the
 * ONE StayLeased color system, EMERALD (Henry's pick, 2026-08-03): marketing
 * and app share one brand system. Signature = the emerald gradient ramp
 * (#2DD4BF→#059669→#047857) on gradient buttons, kickers, avatars, and the
 * progress bar; teal #2DD4BF/#0D9488 is reserved for AI/LIVE signals; deep
 * emerald carries links/dashes/tints. Dark mode runs deep green-black
 * surfaces (#08120D/#0D1A13/#12231A). Light keeps the Entrata-grade
 * cream/paper structure. v9 adds: the hero clip fix (vignettes straddle the
 * band boundary un-cropped — the wash is clipped by its own layer, never the
 * cards), the sourced evidence band (.mk-stats), the agent staff-roster
 * cards (.mk-agent), the verification band (.mk-verify), the restored dark
 * governance anchor band (.mk-dark), SVG check glyphs in the comparison
 * table, and :focus-visible affordances. Motion doctrine (permanent):
 * NOTHING is scroll-scrubbed and nothing moves after its one-shot entrance
 * (typed stagger via --sd from chrome.ts); the only perpetual animation is
 * the 5px LIVE pulse + typing dots. All pre-v9 class names are unchanged
 * (tests + templates pin them); v9 only adds names. */

export const MARKETING_CSS = `
@font-face {
  font-family: 'InterVar';
  src: url('/assets/fonts/inter-var.woff2') format('woff2-variations');
  font-weight: 100 900; font-style: normal; font-display: swap;
}
@font-face {
  font-family: 'Space Grotesk';
  src: url('/assets/fonts/space-grotesk-var.woff2') format('woff2-variations');
  font-weight: 300 700; font-style: normal; font-display: swap;
}

:root {
  --paper: #FFFFFF; --paper-2: #F6F2EB; --card: #FFFFFF;
  /* --mut darkened #737884 → #62676F (2026-08-05 a11y audit): small muted
   * labels (stat sources, role tags, step tags) now clear 4.5:1 on both
   * paper and cream. Dark theme's --mut was already compliant. */
  --ink: #131519; --ink2: #454A54; --mut: #62676F; --faint: #A6AAB4;
  --line: #E7E4DD; --line-2: #EFEDE7;
  /* the one StayLeased system — emerald ramp (mirrored in src/ui/theme.css) */
  --accent: #047857; --accent-2: #065F46;
  --ai: #0D9488;
  --grad: linear-gradient(135deg, #059669, #047857);
  --grad-wide: linear-gradient(90deg, #2DD4BF, #059669 50%, #047857);
  --glow: 0 10px 26px -8px rgba(5,150,105,.45);
  --btn-bg: #047857; --btn-ink: #FFFFFF;
  --display: 'Space Grotesk', 'InterVar', ui-sans-serif, system-ui, sans-serif;
  --ease: cubic-bezier(.16,1,.3,1);
  --spring: cubic-bezier(.34,1.5,.64,1);
  /* legacy token aliases (components reference these) */
  --bg: var(--paper); --sky: var(--accent); --sky-ink: var(--accent);
}
* { box-sizing: border-box; margin: 0; }
html { color-scheme: light; }

/* ---------- dark variant = the app's Obsidian surfaces ---------- */
html[data-theme="dark"] { color-scheme: dark;
  --paper: #08120D; --paper-2: #0D1A13; --card: #12231A;
  --ink: #E9F5EF; --ink2: #C4D6CD; --mut: #8CA396; --faint: #5C7266;
  --line: rgba(163,196,180,.18); --line-2: rgba(163,196,180,.09);
  --accent: #6EE7B7; --accent-2: #A7F3D0;
  --ai: #2DD4BF;
  --glow: 0 12px 30px -8px rgba(16,185,129,.4);
  --btn-bg: #059669; --btn-ink: #FFFFFF;
}

/* theme toggle button (marketing nav) */
.mk-theme {
  display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px;
  border-radius: 50%; border: 1px solid var(--line); background: transparent; color: var(--ink2); cursor: pointer;
  transition: color .15s ease, border-color .15s ease;
}
.mk-theme:hover { color: var(--ink); border-color: var(--ink); }

body.mk {
  font: 16px/1.6 'InterVar', -apple-system, "Segoe UI", Roboto, Inter, sans-serif;
  color: var(--ink); background: var(--paper);
  -webkit-font-smoothing: antialiased; scroll-behavior: smooth; overflow-x: hidden;
}
body.mk ::selection { background: rgba(4,120,87,.16); }
.mk-wrap { max-width: 1180px; margin: 0 auto; padding: 0 40px; }
a { color: inherit; text-decoration: none; }
h1, h2, h3 { font-family: var(--display); }
h4 { font-family: 'InterVar', sans-serif; }

/* scroll progress bar — NO transition: an eased bar lags the scroll and
 * keeps animating after the page stops, which reads as residual motion */
#mkprog { position: fixed; top: 0; left: 0; right: 0; height: 2px; z-index: 90; background: var(--grad-wide); transform: scaleX(0); transform-origin: 0 50%; }

/* nav */
/* nav — the scrolled state adds ONLY a shadow. It must never change
 * height: a shrinking sticky nav shifts the whole document 10px at the
 * scroll threshold and can oscillate there (part of the "jitter"). */
.mk-nav { position: sticky; top: 0; z-index: 60; background: var(--paper); border-bottom: 1px solid var(--line); transition: box-shadow .25s ease; }
.mk-nav.scrolled { box-shadow: 0 1px 0 var(--line), 0 8px 24px -18px rgba(20,18,14,.35); }
.mk-nav-in { display: flex; align-items: center; gap: 30px; height: 64px; }
.mk-logo { display: flex; align-items: center; gap: 9px; font-size: 20px; font-weight: 560; font-family: var(--display); letter-spacing: -.01em; }
.mk-logo b { font-weight: 640; }
.mk-menu { display: flex; align-items: center; gap: 2px; flex: 1; }
.mk-item { position: relative; }
.mk-item-btn { display: flex; align-items: center; gap: 5px; background: none; border: 0; font: inherit; font-weight: 520; font-size: 14.5px; color: var(--ink2); padding: 9px 12px; cursor: pointer; transition: color .15s ease; }
.mk-item-btn svg { transition: transform .2s var(--ease); opacity: .55; }
.mk-item.open .mk-item-btn svg { transform: rotate(180deg); }
.mk-item.open .mk-item-btn, .mk-item-btn:hover, .mk-item-link:hover { color: var(--ink); }
.mk-item-link { font-weight: 520; font-size: 14.5px; color: var(--ink2); padding: 9px 12px; transition: color .15s ease; }
.mk-drop { position: absolute; left: 0; top: calc(100% + 10px); background: var(--card); border: 1px solid var(--line); border-radius: 6px; box-shadow: 0 18px 44px -18px rgba(20,18,14,.3); padding: 10px; display: none; max-width: calc(100vw - 32px); }
.mk-drop::before { content: ''; position: absolute; left: 0; right: 0; top: -11px; height: 11px; }
.mk-item-end .mk-drop { left: auto; right: 0; }
.mk-item.open .mk-drop { display: block; animation: mkDropIn .18s var(--ease); }
.mk-drop-grid { display: grid; grid-template-columns: repeat(2, 280px); gap: 1px; }
.mk-drop-grid a { display: flex; flex-direction: column; gap: 1px; padding: 9px 11px; border-radius: 4px; transition: background .14s ease; }
.mk-drop-grid a:hover, .mk-drop-grid a:focus-visible { background: var(--paper-2); }
.mk-drop-grid b { font-size: 13.5px; color: var(--ink); font-weight: 600; }
.mk-drop-grid span { font-size: 12px; color: var(--mut); }
.mk-drop-all { display: block; margin: 8px 3px 1px; padding: 9px 11px; border-top: 1px solid var(--line-2); font-size: 12.5px; font-weight: 650; color: var(--accent); }
.mk-nav-cta { display: flex; gap: 14px; align-items: center; }

/* burger + mobile menu */
.mk-burger { display: none; flex-direction: column; justify-content: center; gap: 5px; width: 42px; height: 42px; padding: 10px; background: none; border: 0; cursor: pointer; }
.mk-burger span { display: block; height: 2px; border-radius: 2px; background: var(--ink); transition: transform .22s var(--ease), opacity .18s ease; }
.mk-burger.active span:nth-child(1) { transform: translateY(7px) rotate(45deg); }
.mk-burger.active span:nth-child(2) { opacity: 0; }
.mk-burger.active span:nth-child(3) { transform: translateY(-7px) rotate(-45deg); }
.mk-mobile { display: none; position: fixed; inset: 0; z-index: 59; background: var(--paper); overflow-y: auto; }
.mk-mobile.open { display: block; animation: mkFade .18s ease; }
body.mk-mm-open { overflow: hidden; }
.mk-mm-in { padding: 80px 24px 40px; }
.mk-mm-group { border-bottom: 1px solid var(--line); }
.mk-mm-group summary { display: flex; align-items: center; justify-content: space-between; padding: 15px 2px; font-weight: 650; font-size: 16px; cursor: pointer; list-style: none; }
.mk-mm-group summary::-webkit-details-marker { display: none; }
.mk-mm-group[open] summary svg { transform: rotate(180deg); }
.mk-mm-group summary svg { transition: transform .2s var(--ease); color: var(--mut); }
.mk-mm-links { display: grid; padding: 0 2px 14px; }
.mk-mm-links a { padding: 8px 10px; font-size: 14.5px; color: var(--ink2); }
.mk-mm-links a:hover { color: var(--ink); }
.mk-mm-links .mk-mm-all { font-weight: 650; color: var(--accent); }
.mk-mm-link { display: block; padding: 15px 2px; font-weight: 650; font-size: 16px; border-bottom: 1px solid var(--line); }
.mk-mm-cta { display: grid; gap: 10px; padding: 20px 2px 0; }

/* buttons — confident pills; primary carries the signature gradient */
.mk-btn { position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 7px; font-weight: 600; font-size: 14.5px; border-radius: 999px; padding: 11px 22px; border: 0; cursor: pointer; transition: transform .16s var(--ease), background .16s ease, border-color .16s ease, color .16s ease, box-shadow .16s ease, filter .16s ease; }
.mk-btn-lg { padding: 14px 30px; font-size: 15.5px; }
.mk-btn-solid { background: var(--grad); color: var(--btn-ink); }
.mk-btn-solid:hover { transform: translateY(-1px); box-shadow: var(--glow); filter: saturate(1.12) brightness(1.07); }
.mk-btn-solid:active { transform: translateY(0); box-shadow: none; filter: none; }
.mk-btn-line { border: 1.5px solid var(--ink); color: var(--ink); background: transparent; }
.mk-btn-line:hover { transform: translateY(-1px); background: var(--card); box-shadow: 0 8px 20px -12px rgba(20,18,14,.4); }
.mk-btn-ghost { color: var(--ink2); background: transparent; }
.mk-btn-ghost:hover { color: var(--ink); }

/* hero — centered statement over floating product vignettes.
 * overflow stays VISIBLE: the vignette row is pulled over the next band with
 * a negative margin, and an overflow:hidden here guillotines the cards at
 * the boundary (the v8 "clipped hero" bug). The brand wash gets its own
 * absolutely-positioned clip layer instead, so it can bleed past the band
 * edges without ever cropping content. */
.mk-hero { position: relative; }
.mk-hero-clip { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.mk-hero-in { position: relative; padding: 84px 40px 0; }
.mk-hero-copy { max-width: 880px; margin: 0 auto; text-align: center; }
.mk-hero-copy .mk-cta-row { justify-content: center; }
.mk-hero-copy .mk-kicker { justify-content: center; }
/* kickers: solid deep emerald since the 2026-08-05 a11y audit — the v8
 * gradient's teal start ran 1.7:1 on cream at 12px, far below AA. The
 * gradient signature lives on where text is large or non-text (buttons,
 * stat numerals, avatars, progress bar); the dark governance band keeps a
 * gradient kicker because its floor is ~10:1 on the dark surface. */
.mk-kicker { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: var(--accent); margin-bottom: 22px; }
.mk-hero h1 {
  font-size: clamp(48px, 6.4vw, 92px); line-height: 0.98; letter-spacing: -.037em; font-weight: 640;
  color: var(--ink);
}
.mk-sub { font-size: 19px; color: var(--ink2); margin: 26px auto 34px; max-width: 40em; }
.mk-cta-row { display: flex; gap: 13px; flex-wrap: wrap; }
.mk-hero-note { margin-top: 26px; font-size: 14px; color: var(--mut); }
.mk-hero-note b { color: var(--ink); font-weight: 600; }
.mk-hero-note a, .mkp-cta p a { color: var(--mut); text-decoration: underline; text-underline-offset: 3px; transition: color .15s ease; }
.mk-hero-note a:hover, .mkp-cta p a:hover { color: var(--ink); }

/* hero vignettes — stylized product cards, layered like a desk */
.mk-vigrow { display: grid; grid-template-columns: repeat(3, 1fr); gap: 22px; align-items: start; margin: 60px auto -78px; position: relative; z-index: 2; padding-bottom: 8px; }
.mk-hero + .mk-band { padding-top: 178px; }
.mk-vig { --vr: 0deg; --vy: 0px; background: var(--card); border: 1px solid var(--line-2); border-radius: 16px;
  /* v4: emerald-tinted depth + top edge-light — the cards read lit, not gray */
  box-shadow: inset 0 1px 0 rgba(255,255,255,.55), 0 2px 4px rgba(19,21,25,.06), 0 12px 24px -14px rgba(6,78,59,.18), 0 34px 68px -26px rgba(6,78,59,.32);
  padding: 18px; font-size: 13px; transform: rotate(var(--vr)) translateY(var(--vy)); }
html[data-theme="dark"] .mk-vig { box-shadow: inset 0 1px 0 rgba(163,196,180,.10), 0 2px 4px rgba(0,0,0,.3), 0 34px 68px -26px rgba(0,0,0,.55); }
.mk-vig:first-child { --vr: -1.6deg; --vy: 14px; }
.mk-vig:last-child { --vr: 1.4deg; --vy: 10px; }
.mk-vig-head { display: flex; align-items: center; gap: 9px; padding-bottom: 12px; border-bottom: 1px solid var(--line-2); margin-bottom: 12px; }
.mk-vig-av { width: 30px; height: 30px; border-radius: 50%; background: var(--grad); color: #fff; font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex: none; }
.mk-vig-head b { font-size: 13px; color: var(--ink); display: block; line-height: 1.2; }
.mk-vig-head span { font-size: 11px; color: var(--mut); }
.mk-vig-live { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; font-size: 9.5px; font-weight: 700; letter-spacing: .08em; color: var(--ai); border: 1px solid var(--line); border-radius: 999px; padding: 3px 8px; flex: none; }
.mk-vig-live i { width: 5px; height: 5px; border-radius: 50%; background: var(--ai); animation: mkPulse 1.8s ease-in-out infinite; }
.mk-vig-msg { border-radius: 12px; padding: 9px 12px; margin-bottom: 8px; line-height: 1.5; }
.mk-vig-msg.you { background: var(--grad); color: #fff; border-bottom-right-radius: 4px; margin-left: 34px; }
.mk-vig-msg.agent { background: var(--paper-2); color: var(--ink); border-bottom-left-radius: 4px; margin-right: 20px; }
html[data-theme="dark"] .mk-vig-msg.agent { background: #17281E; }
.mk-vig-task { display: flex; align-items: center; gap: 9px; padding: 6px 0; color: var(--ink2); }
.mk-vig-task i { width: 16px; height: 16px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center; font-size: 9px; font-style: normal; font-weight: 800; background: rgba(5,150,105,.12); color: var(--accent); }
.mk-vig-task.hold i { background: rgba(180,110,10,.14); color: #A06508; }
html[data-theme="dark"] .mk-vig-task.hold i { color: #E3B341; }
.mk-vig-chip { display: inline-block; font-size: 10.5px; font-weight: 650; border: 1px solid var(--line); border-radius: 999px; padding: 2px 9px; color: var(--mut); margin-left: auto; flex: none; }
.mk-vig-chip.warn { color: #A06508; border-color: rgba(180,110,10,.35); }
html[data-theme="dark"] .mk-vig-chip.warn { color: #E3B341; border-color: rgba(227,179,65,.4); }
.mk-vig-actions { display: flex; gap: 7px; margin-top: 10px; }
.mk-vig-actions span { font-size: 11.5px; font-weight: 650; border-radius: 999px; padding: 5px 13px; }
.mk-vig-ok { background: var(--grad); color: #fff; }
.mk-vig-ghost { border: 1px solid var(--line); color: var(--ink2); }
@media (max-width: 980px) {
  .mk-vigrow { grid-template-columns: 1fr; margin: 40px auto 0; }
  .mk-vig, .mk-vig:first-child, .mk-vig:last-child { --vr: 0deg; --vy: 0px; transform: none; }
  .mk-hero + .mk-band { padding-top: 96px; }
  .mk-vigrow { margin-bottom: 40px; }
}

/* product suites — the platform taxonomy, information-dense */
.mk-suites { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.mk-suite { display: flex; flex-direction: column; border: 1px solid var(--line-2); border-radius: 16px; background: var(--card); padding: 28px; box-shadow: 0 1px 2px rgba(19,21,25,.05), 0 14px 34px -18px rgba(19,21,25,.22); transition: transform .18s var(--ease), box-shadow .18s ease; }
.mk-suite:hover { transform: translateY(-3px); box-shadow: 0 2px 4px rgba(19,21,25,.05), 0 24px 48px -20px rgba(19,21,25,.28); }
.mk-suite h3 { font-family: var(--display); font-size: 21px; font-weight: 640; letter-spacing: -.015em; color: var(--ink); margin-bottom: 12px; }
.mk-suite ul { list-style: none; padding: 0; margin: 0 0 16px; display: grid; gap: 6px; flex: 1; }
.mk-suite li { position: relative; padding-left: 18px; font-size: 13.5px; color: var(--ink2); line-height: 1.5; }
.mk-suite li::before { content: ''; position: absolute; left: 0; top: 9px; width: 8px; height: 1.5px; background: var(--accent); }
.mk-suite .mk-more { margin-top: auto; }
@media (max-width: 980px) { .mk-suites { grid-template-columns: 1fr 1fr; } }
@media (max-width: 620px) { .mk-suites { grid-template-columns: 1fr; } }
.mk-suites-label { font-size: 11.5px; font-weight: 700; letter-spacing: .13em; text-transform: uppercase; color: var(--mut); margin: -18px 0 18px; }

/* ---------- v9: the evidence band — the staffing dead zone, in sourced,
 * checkable numbers. Market data only; every figure carries its source. */
.mk-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; border-top: 1px solid var(--line); margin-top: 46px; }
.mk-stat { display: flex; flex-direction: column; padding: 26px 26px 6px 0; }
.mk-stat + .mk-stat { border-left: 1px solid var(--line); padding-left: 26px; }
.mk-stat b { font-family: var(--display); font-size: clamp(40px, 3.6vw, 54px); font-weight: 620; letter-spacing: -.03em; line-height: 1; margin-bottom: 12px; color: var(--accent); }
@supports (-webkit-background-clip: text) {
  /* numerals are large text (40px+), so the AA bar is 3:1 — the text ramp
   * starts at #0D9488 (3.4:1 on cream) instead of grad-wide's #2DD4BF (1.7) */
  .mk-stat b { background: linear-gradient(90deg, #0D9488, #059669 45%, #047857); -webkit-background-clip: text; background-clip: text; color: transparent; }
}
html[data-theme="dark"] .mk-stat b { background: none; -webkit-background-clip: initial; background-clip: initial; color: var(--accent); }
.mk-stat span { font-size: 14px; color: var(--ink2); line-height: 1.5; flex: 1; }
.mk-stat > i { font-style: normal; font-size: 11.5px; font-weight: 600; letter-spacing: .04em; color: var(--mut); margin-top: 14px; padding-top: 10px; border-top: 1px dashed var(--line); }
@media (max-width: 980px) { .mk-stats { grid-template-columns: 1fr 1fr; border-top: 0; margin-top: 34px; gap: 0; }
  .mk-stat { border-top: 1px solid var(--line); padding: 22px 22px 6px 0; }
  .mk-stat + .mk-stat { border-left: 0; padding-left: 0; }
  .mk-stat:nth-child(even) { border-left: 1px solid var(--line); padding-left: 22px; } }
@media (max-width: 620px) { .mk-stats { grid-template-columns: 1fr; }
  .mk-stat:nth-child(even) { border-left: 0; padding-left: 0; } }

/* ---------- v9: agents as a staff roster — role tag over the agent name,
 * stroke icon in a tinted chip; the grid keeps .mk-card's lift behavior */
.mk-agent { display: flex; flex-direction: column; align-items: flex-start; }
.mk-agent-ico { display: inline-flex; align-items: center; justify-content: center; width: 42px; height: 42px; border-radius: 11px; color: var(--accent);
  background: rgba(5,150,105,.09); border: 1px solid rgba(5,150,105,.16); margin-bottom: 16px; transition: transform .3s var(--spring); }
html[data-theme="dark"] .mk-agent-ico { background: rgba(110,231,183,.08); border-color: rgba(110,231,183,.18); }
.mk-agent:hover .mk-agent-ico { transform: translateY(-2px) rotate(-4deg); }
.mk-agent-role { font-size: 11px; font-weight: 700; letter-spacing: .11em; text-transform: uppercase; color: var(--mut); margin-bottom: 6px; }
.mk-agent h3 { margin-bottom: 6px; }

/* ---------- v9: verification band — the radical-verifiability ledger.
 * Every row is a claim the visitor can check; linked rows carry an arrow. */
.mk-verify { max-width: 860px; border-top: 1px solid var(--line); }
.mk-vitem { display: flex; align-items: flex-start; gap: 16px; padding: 19px 8px 19px 4px; border-bottom: 1px solid var(--line); transition: background .16s ease; }
a.mk-vitem:hover, a.mk-vitem:focus-visible { background: var(--paper-2); }
.mk-vck { flex: none; width: 22px; height: 22px; margin-top: 1px; background: var(--accent);
  -webkit-mask: url('data:image/svg+xml;utf8,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2024%2024%22%20fill=%22none%22%20stroke=%22black%22%20stroke-width=%222%22%20stroke-linecap=%22round%22%20stroke-linejoin=%22round%22%3E%3Ccircle%20cx=%2212%22%20cy=%2212%22%20r=%229.2%22/%3E%3Cpath%20d=%22m8.2%2012.4%202.6%202.6%205-5.6%22/%3E%3C/svg%3E') center / contain no-repeat;
  mask: url('data:image/svg+xml;utf8,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2024%2024%22%20fill=%22none%22%20stroke=%22black%22%20stroke-width=%222%22%20stroke-linecap=%22round%22%20stroke-linejoin=%22round%22%3E%3Ccircle%20cx=%2212%22%20cy=%2212%22%20r=%229.2%22/%3E%3Cpath%20d=%22m8.2%2012.4%202.6%202.6%205-5.6%22/%3E%3C/svg%3E') center / contain no-repeat; }
.mk-vbody { flex: 1; }
.mk-vbody b { display: block; font-size: 15.5px; font-weight: 640; color: var(--ink); margin-bottom: 2px; }
.mk-vbody span { font-size: 13.5px; color: var(--mut); }
.mk-varrow { flex: none; align-self: center; font-size: 16px; color: var(--faint); transition: transform .25s var(--ease), color .16s ease; }
a.mk-vitem:hover .mk-varrow { transform: translateX(4px); color: var(--accent); }

/* ---------- v9: pricing context rows on the replaced-spend card */
.mk-price-list { list-style: none; padding: 12px 0 0; margin: 4px 0 0; border-top: 1px dashed var(--line); display: grid; gap: 7px; }
.mk-price-list li { position: relative; padding-left: 18px; font-size: 13px; color: var(--mut); }
.mk-price-list li::before { content: ''; position: absolute; left: 0; top: 9px; width: 8px; height: 1.5px; background: var(--accent); }

/* ---------- v9: accessibility affordances ---------- */
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
body.mk :where(a, button, summary, input, select):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
body.mk .mk-btn:focus-visible { outline-offset: 3px; }
h1, .mk-h2 { text-wrap: balance; }
.mk-lead { text-wrap: pretty; }
.mk-band[id], section[id] { scroll-margin-top: 76px; }

/* ---------- v10: the guided-argument layer (2026-08-05) ----------
 * Numbered kickers turn the page into a 01→12 tour; the evidence numerals
 * count up exactly once on entry; agent icons draw themselves in; check
 * glyphs pop with the row that carries them. Everything here is one-shot
 * and entry-triggered — nothing is scrubbed by scroll position, nothing
 * moves again after it lands (doctrine, permanent). */
.mk-kn { display: inline-flex; align-items: center; font-variant-numeric: tabular-nums; color: var(--faint); font-weight: 700; letter-spacing: .08em; padding-right: 10px; margin-right: 10px; border-right: 1px solid var(--line); }
.mk-dark .mk-kn { color: var(--mut); border-right-color: var(--line); }
.mk-dot { color: var(--accent); }

/* hero scroll cue — static affordance, springs only under the cursor */
.mk-scrollcue { display: inline-flex; align-items: center; justify-content: center; width: 42px; height: 42px; margin-top: 34px; border: 1px solid var(--line); border-radius: 50%; color: var(--mut); transition: color .16s ease, border-color .16s ease, transform .3s var(--spring); }
.mk-scrollcue:hover { color: var(--accent); border-color: var(--accent); transform: translateY(3px); }

/* glass nav — the premium sticky header: translucent + blurred where
 * supported, the solid paper fallback everywhere else. Height constant. */
@supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .mk-nav { background: rgba(255,255,255,.76); -webkit-backdrop-filter: blur(14px) saturate(1.5); backdrop-filter: blur(14px) saturate(1.5); }
  html[data-theme="dark"] .mk-nav { background: rgba(8,18,13,.72); }
  .mk-mobile { background: var(--paper); } /* the full-screen menu stays solid */
}

/* count-up numerals: width reserved per-run (inline ch), digits tabular */
.mk-stat b { font-variant-numeric: tabular-nums; }
.mk-n { display: inline-block; font: inherit; font-style: normal; color: inherit; }

/* agent icons draw themselves in once, just after their card lands */
.mk-stag .mk-agent-ico svg path { stroke-dasharray: 1 1; stroke-dashoffset: 1; transition: stroke-dashoffset .8s var(--ease) calc(var(--sd, 0s) + .3s); }
.vis .mk-stag .mk-agent-ico svg path, .mk-stag.vis .mk-agent-ico svg path { stroke-dashoffset: 0; }

/* check glyphs pop with their row (verification band + governance band) */
.mk-stag > .mk-vck { opacity: 0; transform: scale(.4); transition: opacity .35s ease calc(var(--sd, 0s) + .2s), transform .55s var(--spring) calc(var(--sd, 0s) + .2s); }
.vis .mk-stag > .mk-vck, .mk-stag.vis > .mk-vck { opacity: 1; transform: none; }
.mk-checks > .mk-stag::before { opacity: 0; transform: scale(.35); transition: opacity .35s ease calc(var(--sd, 0s) + .22s), transform .55s var(--spring) calc(var(--sd, 0s) + .22s); }
.mk-checks.vis > .mk-stag::before, .vis .mk-checks > .mk-stag::before { opacity: 1; transform: none; }

/* card sheen — a gradient border that answers the cursor (hover-only) */
.mk-card, .mk-suite, .mk-price { position: relative; }
.mk-card::after, .mk-suite::after, .mk-price::after { content: ''; position: absolute; inset: 0; border-radius: 16px; border: 1px solid transparent; pointer-events: none; opacity: 0; transition: opacity .25s ease;
  background: linear-gradient(125deg, rgba(45,212,191,.5), rgba(5,150,105,.45) 55%, rgba(4,120,87,.5)) border-box;
  -webkit-mask: linear-gradient(#fff 0 0) padding-box, linear-gradient(#fff 0 0); -webkit-mask-composite: xor;
  mask: linear-gradient(#fff 0 0) padding-box, linear-gradient(#fff 0 0); mask-composite: exclude; }
.mk-card:hover::after, .mk-suite:hover::after, .mk-price:hover::after { opacity: 1; }
html[data-theme="dark"] .mk-card::after, html[data-theme="dark"] .mk-suite::after, html[data-theme="dark"] .mk-price::after {
  background: linear-gradient(125deg, rgba(45,212,191,.55), rgba(110,231,183,.4) 55%, rgba(16,185,129,.55)) border-box; }

/* hero: a faint static dot grid under the wash, fading out radially */
.mk-hero-clip::after { content: ''; position: absolute; inset: 0;
  background-image: radial-gradient(circle at 1px 1px, rgba(4,120,87,.13) 1px, transparent 1.6px); background-size: 26px 26px;
  -webkit-mask: radial-gradient(58% 64% at 50% 38%, #000 30%, transparent 78%); mask: radial-gradient(58% 64% at 50% 38%, #000 30%, transparent 78%); }
html[data-theme="dark"] .mk-hero-clip::after { background-image: radial-gradient(circle at 1px 1px, rgba(110,231,183,.10) 1px, transparent 1.6px); }

/* hero primary CTA carries a quiet permanent emerald glow (static) */
.mk-hero .mk-btn-solid.mk-btn-lg { box-shadow: 0 18px 42px -18px rgba(5,150,105,.45); }

/* the comparison table's StayLeased column header gets its accent cap */
.mk-compare thead th.mkc-us { position: relative; }
.mk-compare thead th.mkc-us::after { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 2.5px; background: var(--grad-wide); }

/* legacy product-frame (feature pages) — plain document card now */
.mk-hero-visual { position: relative; }
.mk-frame { position: relative; background: var(--card); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; box-shadow: 0 20px 44px -26px rgba(20,18,14,.3); }
.mk-frame-bar { display: flex; gap: 6px; padding: 11px 14px; border-bottom: 1px solid var(--line-2); }
.mk-frame-bar span { width: 9px; height: 9px; border-radius: 99px; background: var(--line); }
.mk-frame-kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; padding: 14px; }
.mk-frame-kpis div { border: 1px solid var(--line-2); border-radius: 6px; padding: 10px 12px; }
.mk-frame-kpis b { display: block; font-size: 19px; letter-spacing: -.02em; color: var(--ink); font-family: var(--display); font-weight: 560; }
.mk-frame-kpis i { font-style: normal; font-size: 11px; color: var(--mut); }
.mk-frame-aihead { display: flex; align-items: center; justify-content: space-between; padding: 9px 16px; border-top: 1px solid var(--line-2); }
.mk-frame-aihead span { font-size: 10.5px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--accent); }
.mk-frame-aihead i { font-style: normal; font-size: 11px; font-weight: 600; color: var(--ink2); border: 1px solid var(--line); border-radius: 3px; padding: 2px 8px; }
.mk-frame-feed { border-top: 1px solid var(--line-2); padding: 11px 16px 14px; display: grid; gap: 7px; font-size: 12.5px; color: var(--ink2); }
.mk-frame-feed div { position: relative; padding-left: 14px; }
.mk-frame-feed div::before { content: ''; position: absolute; left: 0; top: 8px; width: 5px; height: 5px; border-radius: 99px; background: var(--accent); }
.mk-frame-feed em { font-style: normal; font-weight: 650; color: var(--ink); }

/* sections — hairline-separated bands on one paper */
.mk-band { position: relative; padding: 96px 0; }
.mk-band-alt { background: var(--paper-2); }
.mk-band + .mk-band:not(.mk-band-alt) { border-top: 1px solid var(--line-2); }
.mk-h2 { font-size: clamp(34px, 4vw, 54px); letter-spacing: -.03em; line-height: 1.04; font-weight: 640; max-width: 18em; color: var(--ink); }
.mk-lead { font-size: 17px; color: var(--ink2); margin: 16px 0 42px; max-width: 44em; }
.mk-band .mk-kicker { margin-bottom: 18px; }
.mk-two { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.mk-plat { position: relative; border: 1px solid var(--line-2); background: var(--card); border-radius: 16px; padding: 32px; box-shadow: 0 1px 2px rgba(19,21,25,.05), 0 14px 34px -18px rgba(19,21,25,.22); transition: box-shadow .2s ease, transform .2s var(--ease); }
.mk-plat:hover { transform: translateY(-3px); box-shadow: 0 2px 4px rgba(19,21,25,.05), 0 24px 48px -20px rgba(19,21,25,.28); }
.mk-plat-tag { font-size: 11.5px; font-weight: 650; letter-spacing: .13em; text-transform: uppercase; color: var(--accent); margin-bottom: 12px; }
.mk-plat h3 { font-size: 24px; font-weight: 540; letter-spacing: -.01em; margin-bottom: 8px; color: var(--ink); }
.mk-plat p { color: var(--ink2); font-size: 15px; }
.mk-more { display: inline-block; margin-top: 16px; font-weight: 570; color: var(--ink); font-size: 14px; text-decoration: underline; text-underline-offset: 4px; text-decoration-color: var(--faint); transition: text-decoration-color .16s ease, color .16s ease; }
.mk-plat:hover .mk-more, .mk-more:hover { text-decoration-color: var(--accent); color: var(--accent); }

/* architecture comparison — formal table, no competitor named */
.mk-compare { border: 1px solid var(--line-2); border-radius: 16px; overflow-x: auto; box-shadow: 0 1px 2px rgba(19,21,25,.05), 0 14px 34px -18px rgba(19,21,25,.22);
  /* v4: scrolling edge shadows (pure CSS, background-attachment trick) so the
   * mobile overflow is discoverable; the covers scroll with content, the
   * shadows stay pinned to the container edges. */
  background: linear-gradient(90deg, var(--card) 34%, rgba(255,255,255,0)) 0 0, linear-gradient(-90deg, var(--card) 34%, rgba(255,255,255,0)) 100% 0,
    radial-gradient(farthest-side at 0 50%, rgba(19,21,25,.16), transparent) 0 0, radial-gradient(farthest-side at 100% 50%, rgba(19,21,25,.16), transparent) 100% 0, var(--card);
  background-repeat: no-repeat; background-size: 56px 100%, 56px 100%, 16px 100%, 16px 100%, auto; background-attachment: local, local, scroll, scroll, local; }
.mk-compare tbody tr { transition: background .15s ease; }
.mk-compare tbody tr:hover { background: rgba(4,120,87,.035); }
html[data-theme="dark"] .mk-compare tbody tr:hover { background: rgba(110,231,183,.05); }
/* v4 mobile: the row labels stay pinned while the columns scroll, so the
 * StayLeased column is reachable without losing what each row means. */
@media (max-width: 760px) {
  /* pin the data columns to px so the surplus from the table's min-width
   * can't inflate the sticky label column (auto layout gives leftover
   * space to the widest column — which was the labels). */
  .mk-compare td:not(:first-child), .mk-compare th:not(:first-child) { width: 190px; min-width: 190px; }
  .mk-compare td:first-child, .mk-compare th:first-child { position: sticky; left: 0; z-index: 1; background: var(--card); width: 150px; max-width: 150px; font-size: 13px; box-shadow: 6px 0 10px -6px rgba(19,21,25,.14); }
  html[data-theme="dark"] .mk-compare td:first-child, html[data-theme="dark"] .mk-compare th:first-child { box-shadow: 6px 0 10px -6px rgba(0,0,0,.5); }
}
.mk-compare table { width: 100%; border-collapse: collapse; font-size: 14px; min-width: 720px; }
.mk-compare th, .mk-compare td { padding: 14px 18px; text-align: left; border-bottom: 1px solid var(--line-2); }
.mk-compare tbody tr:last-child td { border-bottom: 0; }
.mk-compare thead th { font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--mut); border-bottom: 1px solid var(--line); }
.mk-compare td:first-child { color: var(--ink); font-weight: 550; max-width: 340px; }
.mk-compare td:not(:first-child), .mk-compare th:not(:first-child) { text-align: center; width: 19%; }
.mk-compare td:not(:first-child) { color: var(--mut); }
.mk-compare .mkc-us { color: var(--ink); font-weight: 620; background: rgba(4,120,87,.055); }
html[data-theme="dark"] .mk-compare .mkc-us { background: rgba(110,231,183,.08); }
.mk-compare thead th.mkc-us { color: var(--accent); }
/* v9: SVG check glyphs — accent in the StayLeased column, muted elsewhere;
 * the us-column gets hairline flanks so it reads as one continuous rail */
.mk-compare .mk-ck { vertical-align: -2.5px; color: var(--mut); }
.mk-compare .mkc-us .mk-ck { color: var(--accent); }
.mk-compare td.mkc-us, .mk-compare th.mkc-us { border-left: 1px solid rgba(4,120,87,.16); }
html[data-theme="dark"] .mk-compare td.mkc-us, html[data-theme="dark"] .mk-compare th.mkc-us { border-left-color: rgba(110,231,183,.2); }

/* first-week steps — numbered editorial rows */
.mk-steps { max-width: 880px; border-top: 1px solid var(--line); }
.mk-step { display: flex; gap: 26px; padding: 26px 4px; border-bottom: 1px solid var(--line); transition: background .18s ease; }
.mk-step:hover { background: var(--card); }
.mk-step-n { flex: none; width: 44px; font-family: var(--display); font-size: 30px; font-weight: 460; color: var(--faint); line-height: 1.1; transition: color .2s ease; }
.mk-step:hover .mk-step-n { color: var(--accent); }
.mk-step-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; }
.mk-step-head b { font-size: 17px; color: var(--ink); font-weight: 640; }
.mk-step-tag { font-size: 11px; font-weight: 650; letter-spacing: .11em; text-transform: uppercase; color: var(--mut); }
.mk-step p { color: var(--ink2); font-size: 14.5px; max-width: 56em; }

/* never-used-AI example — a paper document */
.mk-nta-card { position: relative; background: var(--card); border: 1px solid var(--line-2); border-radius: 16px; box-shadow: 0 2px 4px rgba(19,21,25,.05), 0 28px 56px -26px rgba(19,21,25,.3); padding: 24px; display: grid; gap: 14px; }
.mk-nta-row { font-size: 14px; color: var(--ink2); }
.mk-nta-row i { color: var(--ink); font-style: normal; font-weight: 620; }
.mk-nta-time { display: inline-block; font-size: 11px; font-weight: 650; letter-spacing: .06em; color: var(--mut); border: 1px solid var(--line); border-radius: 3px; padding: 2px 8px; margin-right: 6px; }
.mk-nta-draft { border: 1px solid var(--line); border-left: 3px solid var(--accent); background: var(--paper); border-radius: 4px; padding: 15px 16px; }
.mk-nta-draft-tag { font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--accent); margin-bottom: 7px; }
.mk-nta-draft p { font-size: 14px; color: var(--ink); }
.mk-nta-actions { display: flex; gap: 8px; margin-top: 12px; align-items: center; }
.mk-nta-actions span { font-size: 12.5px; font-weight: 600; border-radius: 4px; padding: 6px 13px; }
.mk-nta-ok { background: var(--grad); color: var(--btn-ink); }
.mk-nta-edit { border: 1px solid var(--ink); color: var(--ink); }
.mk-nta-skip { color: var(--mut); }
.mk-nta-note { font-size: 12.5px; color: var(--mut); border-top: 1px dashed var(--line); padding-top: 12px; }

/* automation levels — numbered rows on a rule */
.mk-levels { position: relative; display: grid; max-width: 880px; border-top: 1px solid var(--line); }
.mk-levels::before { content: none; }
.mk-level { position: relative; display: flex; gap: 22px; padding: 24px 4px; border-bottom: 1px solid var(--line); transition: background .18s ease; }
.mk-level:hover { background: var(--card); }
.mk-level-cube { flex: none; width: 26px; opacity: .9; }
.mk-level-head { font-size: 16px; margin-bottom: 3px; color: var(--ink); }
.mk-level-head b { color: var(--ink); font-weight: 650; }
.mk-level p { color: var(--ink2); font-size: 14.5px; }

/* cards */
.mk-grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.mk-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.mk-card { position: relative; border: 1px solid var(--line-2); background: var(--card); border-radius: 16px; padding: 26px; box-shadow: 0 1px 2px rgba(19,21,25,.05), 0 14px 34px -18px rgba(19,21,25,.22); transition: transform .2s var(--ease), box-shadow .2s ease; }
.mk-card:hover { transform: translateY(-3px); box-shadow: 0 2px 4px rgba(19,21,25,.05), 0 24px 48px -20px rgba(19,21,25,.28); }
.mk-card h3 { font-size: 19px; font-weight: 640; margin-bottom: 7px; color: var(--ink); letter-spacing: -.012em; }
.mk-card p { color: var(--ink2); font-size: 14.5px; }
.mk-card .mk-more { margin-top: 12px; }
.mk-inline-cta { margin-top: 30px; }

/* governance — v9: the dark emerald anchor band, the page's gravity well.
 * The crown-jewel section (no competitor publishes oversight mechanics)
 * finally looks the part: deep green-black surface in BOTH themes, local
 * token overrides so every child inherits correct contrast, a static
 * emerald glow (no drift — doctrine), and check-circle glyphs. In dark
 * theme the band sits one surface up from the page so it still reads as
 * an anchor. */
.mk-dark { position: relative; background: #0A1A12; color: #E9F5EF; overflow: hidden;
  --ink: #E9F5EF; --ink2: #C4D6CD; --mut: #8CA396; --faint: #5C7266;
  --line: rgba(163,196,180,.17); --line-2: rgba(163,196,180,.09);
  --accent: #6EE7B7; --card: rgba(163,196,180,.05); }
html[data-theme="dark"] .mk-dark { background: #0D1A13; border-top: 1px solid rgba(163,196,180,.12); border-bottom: 1px solid rgba(163,196,180,.12); }
.mk-dark::before { content: ''; position: absolute; left: 50%; top: -320px; width: 1100px; height: 640px; transform: translateX(-50%); pointer-events: none;
  background: radial-gradient(50% 55% at 50% 50%, rgba(16,185,129,.13), transparent 70%); }
/* v4 depth: a second, lower ember + a hairline top light so the band reads
 * as a lit room rather than a flat fill. Static — no motion. */
.mk-dark::after { content: ''; position: absolute; right: -180px; bottom: -260px; width: 900px; height: 560px; pointer-events: none;
  background: radial-gradient(48% 52% at 60% 60%, rgba(45,212,191,.07), transparent 72%); }
.mk-dark { box-shadow: inset 0 1px 0 rgba(163,196,180,.08); }
.mk-dark .mk-wrap { position: relative; }
.mk-dark .mk-h2 { color: var(--ink); }
.mk-dark .mk-lead { color: var(--ink2); }
.mk-dark .mk-kicker { color: var(--accent); }
@supports (-webkit-background-clip: text) {
  .mk-dark .mk-kicker { background: linear-gradient(90deg, #2DD4BF, #6EE7B7); -webkit-background-clip: text; background-clip: text; color: transparent; }
}
.mk-checks { display: grid; grid-template-columns: repeat(2, minmax(240px, 1fr)); gap: 14px 44px; list-style: none; padding: 0; margin: 0; max-width: 880px; }
.mk-checks li { padding: 14px 4px 14px 34px; position: relative; font-size: 15px; color: var(--ink2); border-bottom: 1px solid var(--line-2); transition: color .16s ease; }
.mk-checks li::before { content: ''; position: absolute; left: 0; top: 15px; width: 20px; height: 20px; background: var(--accent);
  -webkit-mask: url('data:image/svg+xml;utf8,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2024%2024%22%20fill=%22none%22%20stroke=%22black%22%20stroke-width=%222%22%20stroke-linecap=%22round%22%20stroke-linejoin=%22round%22%3E%3Ccircle%20cx=%2212%22%20cy=%2212%22%20r=%229.2%22/%3E%3Cpath%20d=%22m8.2%2012.4%202.6%202.6%205-5.6%22/%3E%3C/svg%3E') center / contain no-repeat;
  mask: url('data:image/svg+xml;utf8,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2024%2024%22%20fill=%22none%22%20stroke=%22black%22%20stroke-width=%222%22%20stroke-linecap=%22round%22%20stroke-linejoin=%22round%22%3E%3Ccircle%20cx=%2212%22%20cy=%2212%22%20r=%229.2%22/%3E%3Cpath%20d=%22m8.2%2012.4%202.6%202.6%205-5.6%22/%3E%3C/svg%3E') center / contain no-repeat; }
.mk-checks li:hover { color: var(--ink); }
.mk-grid5 { display: grid; grid-template-columns: repeat(5, 1fr); gap: 16px; }
.mk-gov { padding: 20px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
.mk-gov h4 { font-size: 14px; margin-bottom: 6px; color: var(--ink); font-weight: 640; }
.mk-gov p { font-size: 12.5px; color: var(--mut); }

/* pricing */
.mk-price-row { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; max-width: 880px; }
.mk-price { position: relative; background: var(--card); border: 1px solid var(--line-2); border-radius: 16px; padding: 32px; box-shadow: 0 1px 2px rgba(19,21,25,.05), 0 14px 34px -18px rgba(19,21,25,.22); transition: transform .2s var(--ease), box-shadow .2s ease; }
.mk-price:first-child { border: 2px solid var(--accent); }
.mk-price:first-child::before { content: 'Early access'; position: absolute; top: -12px; left: 28px; font-size: 10.5px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: #fff; background: var(--grad); border-radius: 999px; padding: 4px 12px; }
.mk-price:hover { transform: translateY(-2px); box-shadow: 0 16px 34px -22px rgba(20,18,14,.35); }
.mk-price-tag { font-size: 11.5px; font-weight: 650; letter-spacing: .13em; text-transform: uppercase; color: var(--mut); margin-bottom: 10px; }
.mk-price-big { font-size: 46px; font-weight: 500; letter-spacing: -.02em; margin-bottom: 8px; font-family: var(--display); color: var(--ink); }
.mk-price-big span { font-size: 15px; font-weight: 500; color: var(--mut); font-family: 'InterVar', sans-serif; }
.mk-price p { color: var(--ink2); font-size: 14.5px; margin-bottom: 14px; }
@media (max-width: 980px) { .mk-price-row { grid-template-columns: 1fr; } }

/* walkthrough */
.mk-two-col { display: grid; grid-template-columns: 1.1fr .9fr; gap: 48px; align-items: start; }
.mk-form-card { background: var(--card); border: 1px solid var(--line-2); border-radius: 16px; padding: 28px; box-shadow: 0 2px 4px rgba(19,21,25,.05), 0 28px 56px -26px rgba(19,21,25,.3); }
.mk-form-card h3 { margin-bottom: 16px; color: var(--ink); font-size: 22px; font-weight: 540; }
.mk-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
.mk-form-card label { display: flex; flex-direction: column; gap: 5px; font-size: 12.5px; font-weight: 620; color: var(--ink2); }
.mk-form-card input, .mk-form-card select { font: inherit; font-weight: 400; padding: 10px 12px; border: 1px solid var(--line); border-radius: 4px; background: var(--paper); color: var(--ink); transition: border-color .16s ease, box-shadow .16s ease; }
.mk-form-card select option { background: var(--card); }
.mk-form-card input:focus, .mk-form-card select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(5,150,105,.15); }
.mk-form-full { margin-bottom: 14px; }
.mk-thanks { font-size: 15.5px; color: var(--ink2); }
.mk-thanks b { color: var(--ink); }

/* footer — dark anchor band */
.mk-foot { position: relative; background: #0A140E; color: #8CA396; padding: 60px 0 28px; }
.mk-foot-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 24px; padding-bottom: 34px; border-bottom: 1px solid rgba(237,238,242,.12); }
.mk-foot-head { font-size: 11.5px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: #E9F5EF; margin-bottom: 12px; }
.mk-foot-grid a { display: block; font-size: 13.5px; padding: 3.5px 0; color: #8CA396; transition: color .15s ease; }
.mk-foot-grid a:hover { color: #FFFFFF; }
.mk-foot-base { display: flex; justify-content: space-between; gap: 14px; flex-wrap: wrap; padding-top: 20px; font-size: 13px; align-items: center; color: #5C7266; }

/* ---------- icon micro-interactions ----------
 * Hover-only (never ambient): every interactive icon answers the cursor
 * with a springy, GPU-cheap transform. Sun spins, chevrons dip, send
 * arrows advance, the chat bubble tilts, list links step right. */
.mk-theme svg { transition: transform .45s var(--spring); }
.mk-theme:hover svg { transform: rotate(50deg) scale(1.12); }
.mk-item-btn svg { transition: transform .25s var(--ease), opacity .2s ease; }
.mk-item-btn:hover svg { opacity: 1; transform: translateY(2px); }
.mk-item.open .mk-item-btn svg { transform: rotate(180deg); opacity: 1; }
.mk-drop-grid a { transition: background .16s ease, transform .22s var(--ease); }
.mk-drop-grid a:hover, .mk-drop-grid a:focus-visible { transform: translateX(4px); }
.mk-drop-all { transition: letter-spacing .25s var(--ease); }
.mk-drop-all:hover { letter-spacing: .02em; }
.mk-chat-launch svg { transition: transform .45s var(--spring); }
.mk-chat-launch:hover svg { transform: rotate(-10deg) scale(1.15); }
#mktop svg { transition: transform .3s var(--spring); }
#mktop:hover svg { transform: translateY(-2.5px) scale(1.08); }
.mk-ask-form button svg, .mk-chat-form button svg { transition: transform .25s var(--spring); }
.mk-ask-form button:hover svg, .mk-chat-form button:hover svg { transform: translateX(3px); }
.mk-chat-close { transition: opacity .15s ease, transform .3s var(--spring); }
.mk-chat-close:hover { transform: rotate(90deg); }
.mk-foot-grid a { transition: color .15s ease, transform .2s var(--ease); }
.mk-foot-grid a:hover { transform: translateX(3px); }
.mk-suite .mk-more, .mk-card .mk-more, .mk-plat .mk-more { transition: text-decoration-color .16s ease, color .16s ease, letter-spacing .25s var(--ease); }
.mk-suite:hover .mk-more, .mk-card:hover .mk-more, .mk-plat:hover .mk-more { letter-spacing: .015em; }
.mk-burger span { transition: transform .3s var(--spring), opacity .18s ease; }
.mk-logo svg { transition: transform .45s var(--spring); }
.mk-logo:hover svg { transform: rotate(-6deg) scale(1.1); }

/* ---------- motion v6: choreographed ONE-SHOT reveals ----------
 * Doctrine (permanent): nothing on this site is scrubbed by scroll
 * position — scrubbing reads as vibration. Every element animates exactly
 * once on first entry, with direction, stagger, and spring chosen per
 * component, then holds perfectly still. The chrome script assigns
 * .mk-stag + a --sd delay to group children and .vis on entry; everything
 * below is pure CSS keyed off those. The footer never gets any of this. */
.mk-reveal { opacity: 0; transform: translateY(10px); transition: opacity .65s var(--ease), transform .65s var(--ease); }
.mk-reveal.vis { opacity: 1; transform: none; }
/* headings arrive as a focus-pull: rise + de-blur, lead follows a beat later */
.mk-reveal > .mk-h2, .mk-reveal .mk-ask-copy > .mk-h2 { opacity: 0; transform: translateY(26px); filter: blur(9px); transition: opacity .8s var(--ease), transform .8s var(--ease), filter .8s var(--ease); }
.mk-reveal > .mk-lead, .mk-reveal .mk-ask-copy > .mk-lead { opacity: 0; transform: translateY(20px); transition: opacity .7s var(--ease) .12s, transform .7s var(--ease) .12s; }
.mk-reveal.vis > .mk-h2, .mk-reveal.vis .mk-ask-copy > .mk-h2, .mk-reveal.vis > .mk-lead, .mk-reveal.vis .mk-ask-copy > .mk-lead { opacity: 1; transform: none; filter: none; }
/* staggered children: rise by default, typed direction per component.
 * Every typed override is :where()-wrapped (specificity 0,1,0) so the
 * .vis reset below (0,2,0) always wins — a bare ".mk-compare tbody >"
 * override once out-specified the reset and left rows stuck mid-slide. */
.mk-stag { opacity: 0; transform: translateY(26px); transition: opacity .6s var(--ease) var(--sd, 0s), transform .6s var(--ease) var(--sd, 0s); }
:where(.mk-suites, .mk-grid3, .mk-grid2, .mk-grid5, .mk-price-row) > .mk-stag { transform: translateY(30px) scale(.96); }
:where(.mk-steps, .mk-levels, .mk-checks) > .mk-stag { transform: translateX(-30px); }
:where(.mk-compare tbody) > .mk-stag { transform: none; } /* rows fade in place — slides get clipped by overflow-x */
:where(.mk-ask-grid, .mk-two-col) > .mk-stag:where(:first-child) { transform: translateX(-32px); }
:where(.mk-ask-grid, .mk-two-col) > .mk-stag:where(:last-child) { transform: translateX(32px); }
.vis .mk-stag, .mk-stag.vis { opacity: 1; transform: none; }
/* inner choreography: parts arrive just after their row, with a spring */
.mk-stag .mk-step-n { opacity: 0; transform: scale(.4); transition: opacity .45s var(--ease) calc(var(--sd, 0s) + .18s), transform .6s var(--spring) calc(var(--sd, 0s) + .18s); }
.mk-stag .mk-level-cube { opacity: 0; transform: scale(.35) rotate(-100deg); transition: opacity .45s var(--ease) calc(var(--sd, 0s) + .18s), transform .65s var(--spring) calc(var(--sd, 0s) + .18s); }
.vis .mk-stag .mk-step-n, .vis .mk-stag .mk-level-cube { opacity: 1; transform: none; }
/* the draft card plays out its own story: lead arrives → AI drafts → note */
.mk-stag .mk-nta-row, .mk-stag .mk-nta-draft, .mk-stag .mk-nta-note { opacity: 0; transform: translateY(12px); transition: opacity .55s var(--ease), transform .55s var(--ease); }
.mk-stag .mk-nta-row { transition-delay: calc(var(--sd, 0s) + .3s); }
.mk-stag .mk-nta-draft { transition-delay: calc(var(--sd, 0s) + .65s); }
.mk-stag .mk-nta-note { transition-delay: calc(var(--sd, 0s) + 1s); }
.vis .mk-stag .mk-nta-row, .vis .mk-stag .mk-nta-draft, .vis .mk-stag .mk-nta-note { opacity: 1; transform: none; }
.mk-h2 { padding-bottom: 4px; }

/* ask stayleased section */
.mk-kicker-ai { display: inline-flex; align-items: center; gap: 7px; }
.mk-ask-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 48px; align-items: center; }
.mk-ask-copy .mk-h2 { margin-bottom: 0; }
.mk-ask-points { list-style: none; padding: 0; margin: 18px 0 26px; display: grid; gap: 9px; }
.mk-ask-points li { position: relative; padding-left: 24px; font-size: 14.5px; color: var(--ink2); }
.mk-ask-points li::before { content: '—'; position: absolute; left: 0; top: 0; color: var(--accent); font-weight: 600; }
.mk-ask-points li::after { content: none; }
.mk-askbox { background: var(--card); border: 1px solid var(--line-2); border-radius: 16px; box-shadow: 0 2px 4px rgba(19,21,25,.05), 0 28px 56px -26px rgba(19,21,25,.3); overflow: hidden; display: flex; flex-direction: column; min-height: 420px; }
.mk-askbox-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--line); }
.mk-askbox-id { display: flex; align-items: center; gap: 10px; }
.mk-askbox-av { width: 34px; height: 34px; border-radius: 50%; background: var(--grad); color: var(--btn-ink); font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
.mk-askbox-id b { font-size: 14px; display: block; color: var(--ink); }
.mk-askbox-id span { font-size: 11.5px; color: var(--mut); }
.mk-live { display: inline-flex; align-items: center; gap: 6px; font-size: 10.5px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--ai); border: 1px solid var(--line); border-radius: 3px; padding: 3px 8px; }
.mk-live i { width: 6px; height: 6px; border-radius: 99px; background: currentColor; animation: mkPulse 1.8s ease-in-out infinite; }
.mk-ask-msgs, .mk-chat-msgs { flex: 1; padding: 16px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
.mk-ask-msgs { min-height: 210px; max-height: 300px; }
.mk-msg { max-width: 85%; padding: 10px 13px; border-radius: 8px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; animation: mkMsgIn .3s var(--ease); }
.mk-msg.you { align-self: flex-end; background: var(--grad); color: var(--btn-ink); border-bottom-right-radius: 3px; }
.mk-msg.agent { align-self: flex-start; background: var(--paper); color: var(--ink); border: 1px solid var(--line-2); border-bottom-left-radius: 3px; }
.mk-typing { display: inline-flex; gap: 4px; padding: 2px 0; }
.mk-typing i { width: 5px; height: 5px; border-radius: 99px; background: var(--mut); animation: mkBlink 1.2s infinite ease-in-out; }
.mk-typing i:nth-child(2) { animation-delay: .18s; }
.mk-typing i:nth-child(3) { animation-delay: .36s; }
.mk-ask-chips, .mk-chat-chips { display: flex; flex-wrap: wrap; gap: 7px; padding: 0 16px 12px; }
.mk-ask-chip { font: inherit; font-size: 12.5px; font-weight: 550; color: var(--ink2); background: transparent; border: 1px solid var(--line); border-radius: 4px; padding: 6px 12px; cursor: pointer; transition: border-color .15s ease, color .15s ease; }
.mk-ask-chip:hover { border-color: var(--ink); color: var(--ink); }
.mk-ask-chip.active { border-color: var(--btn-bg); background: var(--btn-bg); color: var(--btn-ink); }
.mk-ask-form, .mk-chat-form { display: flex; gap: 8px; padding: 12px 14px; border-top: 1px solid var(--line); }
.mk-ask-form input, .mk-chat-form input { flex: 1; font: inherit; font-size: 14px; padding: 10px 13px; border: 1px solid var(--line); border-radius: 4px; background: var(--paper); color: var(--ink); }
.mk-ask-form input::placeholder, .mk-chat-form input::placeholder { color: var(--faint); }
.mk-ask-form input:focus, .mk-chat-form input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(5,150,105,.15); }
.mk-ask-form button, .mk-chat-form button { flex: none; width: 42px; border: 0; border-radius: 4px; background: var(--btn-bg); color: var(--btn-ink); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: opacity .16s ease; }
.mk-ask-form button:hover, .mk-chat-form button:hover { opacity: .85; }

/* floating chat widget */
.mk-chat { position: fixed; right: 22px; bottom: 22px; z-index: 80; }
.mk-chat-launch { display: inline-flex; align-items: center; gap: 9px; font: inherit; font-weight: 600; font-size: 14.5px; color: var(--btn-ink); background: var(--grad); border: 0; border-radius: 999px; padding: 12px 18px 12px 15px; cursor: pointer; box-shadow: 0 14px 30px -14px rgba(20,18,14,.5); transition: transform .2s var(--ease), box-shadow .2s var(--ease); }
.mk-chat-launch:hover { transform: translateY(-2px); box-shadow: var(--glow); }
.mk-chat.open .mk-chat-launch { transform: scale(.9); opacity: 0; pointer-events: none; }
.mk-chat-panel { position: absolute; right: 0; bottom: 0; width: min(380px, calc(100vw - 32px)); height: min(560px, calc(100vh - 110px)); background: var(--card); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 40px 80px -40px rgba(20,18,14,.5); display: flex; flex-direction: column; overflow: hidden; opacity: 0; transform: translateY(20px) scale(.96); transform-origin: bottom right; pointer-events: none; transition: opacity .24s var(--ease), transform .24s var(--ease); }
.mk-chat.open .mk-chat-panel { opacity: 1; transform: none; pointer-events: auto; }
.mk-chat-head { display: flex; align-items: center; justify-content: space-between; padding: 13px 15px; background: var(--grad); color: var(--btn-ink); }
.mk-chat-id { display: flex; align-items: center; gap: 10px; }
.mk-chat-av { width: 32px; height: 32px; border-radius: 50%; background: rgba(255,255,255,.16); font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
html[data-theme="dark"] .mk-chat-av { background: rgba(20,18,14,.18); }
.mk-chat-id b { font-size: 14px; display: block; }
.mk-chat-id span { font-size: 11px; opacity: .8; }
.mk-chat-close { background: transparent; border: 1px solid currentColor; opacity: .7; color: inherit; width: 28px; height: 28px; border-radius: 6px; cursor: pointer; font-size: 14px; transition: opacity .15s ease; }
.mk-chat-close:hover { opacity: 1; }
.mk-chat-msgs { background: transparent; }
.mk-chat-chips { padding-top: 10px; background: transparent; }
body.mk-chat-open #mktop { opacity: 0; pointer-events: none; }

/* ---------- feature pages ---------- */
.mkp-hero { position: relative; border-bottom: 1px solid var(--line); }
.mkp-hero-in { position: relative; display: grid; grid-template-columns: 1.08fr .92fr; gap: 48px; align-items: center; padding: 68px 40px 72px; }
.mkp-crumb { font-size: 12px; font-weight: 620; letter-spacing: .1em; text-transform: uppercase; color: var(--mut); margin-bottom: 18px; }
.mkp-crumb a { color: var(--accent); }
.mkp-crumb a:hover { text-decoration: underline; text-underline-offset: 3px; }
.mkp-hero h1 { font-size: clamp(34px, 4.2vw, 54px); line-height: 1.05; letter-spacing: -.018em; font-weight: 490; color: var(--ink); }
.mkp-sub { font-size: 17.5px; color: var(--ink2); margin: 18px 0 24px; max-width: 36em; }
.mkp-points { list-style: none; padding: 0; margin: 0 0 28px; display: grid; gap: 9px; }
.mkp-points li { position: relative; padding-left: 24px; font-size: 15px; color: var(--ink2); }
.mkp-points li::before { content: '—'; position: absolute; left: 0; top: 0; color: var(--accent); font-weight: 600; }
.mkp-chip { display: inline-flex; align-items: center; gap: 7px; font-size: 11.5px; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; border-radius: 3px; padding: 4px 10px; margin: 0 0 20px; border: 1px solid var(--line); }
.mkp-chip::before { content: ''; width: 6px; height: 6px; border-radius: 99px; background: currentColor; }
.mkp-chip.live { color: var(--accent); }
.mkp-chip.soon { color: var(--mut); }
.mkp-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0; margin: 38px 0 0; border-top: 1px solid var(--line); }
.mkp-stat { padding: 18px 20px 4px 0; transition: none; }
.mkp-stat + .mkp-stat { border-left: 1px solid var(--line); padding-left: 20px; }
.mkp-stat b { display: block; font-size: 16px; margin-bottom: 3px; color: var(--ink); font-weight: 640; }
.mkp-stat span { font-size: 13.5px; color: var(--mut); }
.mkp-faq { max-width: 880px; display: grid; border-top: 1px solid var(--line); }
.mkp-faq details { border-bottom: 1px solid var(--line); }
.mkp-faq summary { padding: 17px 4px; font-weight: 600; font-size: 15.5px; cursor: pointer; list-style: none; display: flex; justify-content: space-between; align-items: center; gap: 12px; color: var(--ink); }
.mkp-faq summary::-webkit-details-marker { display: none; }
.mkp-faq summary::after { content: '+'; font-family: var(--display); font-size: 20px; font-weight: 400; color: var(--mut); transition: transform .2s var(--ease); }
.mkp-faq details[open] summary::after { transform: rotate(45deg); }
.mkp-faq .mkp-a { padding: 0 4px 17px; color: var(--ink2); font-size: 14.5px; max-width: 54em; }
.mkp-related { display: flex; flex-wrap: wrap; gap: 10px; }
.mkp-related a { display: inline-flex; align-items: center; gap: 7px; border: 1px solid var(--line); border-radius: 4px; padding: 8px 15px; font-size: 13.5px; font-weight: 550; color: var(--ink2); transition: border-color .16s ease, color .16s ease; }
.mkp-related a:hover { border-color: var(--ink); color: var(--ink); }
.mkp-cta { position: relative; background: var(--paper); color: var(--ink); text-align: center; padding: 76px 0; border-top: 1px solid var(--line); }
.mkp-cta h2 { font-size: clamp(28px, 3.4vw, 40px); letter-spacing: -.015em; font-weight: 500; margin-bottom: 10px; }
.mkp-cta p { color: var(--ink2); margin-bottom: 26px; }
.mkp-cta .mk-cta-row { justify-content: center; }
.mkp-hub-lead { padding-top: 56px; }
.mkp-prose { max-width: 760px; padding: 56px 40px 76px; margin: 0 auto; }
.mkp-prose h1 { font-size: clamp(30px, 3.6vw, 44px); letter-spacing: -.015em; margin-bottom: 6px; color: var(--ink); font-weight: 500; }
.mkp-prose .mkp-date { color: var(--mut); font-size: 13.5px; margin-bottom: 28px; }
.mkp-prose h2 { font-size: 22px; letter-spacing: -.01em; margin: 32px 0 8px; color: var(--ink); font-weight: 560; }
.mkp-prose p, .mkp-prose li { color: var(--ink2); font-size: 15px; }
.mkp-prose ul { padding-left: 22px; margin: 8px 0; }
.mkp-prose li { margin: 4px 0; }

/* keyframes */
@keyframes mkPulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
@keyframes mkBlink { 0%,80%,100% { transform: translateY(0); opacity: .5; } 40% { transform: translateY(-3px); opacity: 1; } }
@keyframes mkMsgIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes mkDropIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
@keyframes mkFade { from { opacity: 0; } to { opacity: 1; } }
@keyframes mkPing { 0% { opacity: 1; } 100% { opacity: 1; } }

/* hero entrance — plays once on load, then the page is PERFECTLY still.
 * The copy cascades down; the three vignette cards rise up into their
 * desk tilts; inside them the conversation/tasks play out in order like
 * live product activity — and then everything stops. Doctrine addendum
 * (2026-08-03, after "still jittering"): ZERO continuous transform
 * animation anywhere, especially on the rotated vignettes — translating
 * a rotated text-bearing card forces per-frame re-rasterization and the
 * text shimmers. The only things allowed to keep moving are the 5px
 * LIVE pulse dots and the typing indicator (tiny, opacity-only). */
@media (prefers-reduced-motion: no-preference) {
  .mk-hero-copy > * { animation: mkUp .65s var(--ease) both; }
  .mk-hero-copy > *:nth-child(1) { animation-delay: .05s; }
  .mk-hero-copy > *:nth-child(2) { animation-delay: .14s; animation-duration: .8s; }
  .mk-hero-copy > *:nth-child(3) { animation-delay: .26s; }
  .mk-hero-copy > *:nth-child(4) { animation-delay: .38s; }
  .mk-hero-copy > *:nth-child(5) { animation-delay: .5s; }
  .mk-hero-copy > *:nth-child(6) { animation-delay: .64s; }
  .mk-hero h1 { animation-name: mkH1; }
  .mk-vig { animation: mkVigIn .85s var(--ease) both; }
  .mk-vig:nth-child(1) { animation-delay: .72s; }
  .mk-vig:nth-child(2) { animation-delay: .58s; }
  .mk-vig:nth-child(3) { animation-delay: .86s; }
  .mk-vig > :not(.mk-vig-head) { animation: mkItemIn .5s var(--ease) both; }
  .mk-vig > :nth-child(2) { animation-delay: 1.5s; }
  .mk-vig > :nth-child(3) { animation-delay: 1.95s; }
  .mk-vig > :nth-child(4) { animation-delay: 2.4s; }
  .mk-vig > :nth-child(5) { animation-delay: 2.85s; }
}
@keyframes mkUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }
@keyframes mkH1 { from { opacity: 0; transform: translateY(22px); filter: blur(10px); } to { opacity: 1; transform: none; filter: none; } }
@keyframes mkVigIn { from { opacity: 0; transform: rotate(var(--vr)) translateY(calc(var(--vy) + 52px)) scale(.94); } to { opacity: 1; transform: rotate(var(--vr)) translateY(var(--vy)) scale(1); } }
@keyframes mkItemIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
/* soft brand wash behind the hero — static, no drift; the emerald ramp's
 * two ends as overlapping fields. Lives on the clip layer so it can never
 * crop the vignette cards. */
.mk-hero-clip::before { content: ''; position: absolute; left: 50%; top: -240px; width: 1080px; height: 700px; transform: translateX(-50%);
  background: radial-gradient(46% 52% at 36% 44%, rgba(45,212,191,.10), transparent 70%), radial-gradient(50% 56% at 64% 50%, rgba(5,150,105,.10), transparent 72%); }
html[data-theme="dark"] .mk-hero-clip::before { background: radial-gradient(46% 52% at 36% 44%, rgba(45,212,191,.08), transparent 70%), radial-gradient(50% 56% at 64% 50%, rgba(16,185,129,.11), transparent 72%); }

/* back-to-top */
#mktop { position: fixed; right: 22px; bottom: 22px; z-index: 70; width: 44px; height: 44px; border-radius: 50%; border: 1px solid var(--line); background: var(--card); color: var(--ink); display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 12px 26px -14px rgba(20,18,14,.4); opacity: 0; transform: translateY(14px); pointer-events: none; transition: opacity .26s var(--ease), transform .26s var(--ease), border-color .16s ease; }
#mktop.show { opacity: 1; transform: none; pointer-events: auto; }
#mktop:hover { border-color: var(--ink); transform: translateY(-2px); }

/* responsive */
@media (max-width: 980px) {
  .mk-wrap { padding: 0 24px; }
  .mk-menu, .mk-nav-cta { display: none; }
  .mk-burger { display: flex; }
  .mk-hero-in { grid-template-columns: 1fr; padding: 52px 24px 44px; gap: 32px; }
  .mkp-hero-in { grid-template-columns: 1fr; padding: 46px 24px 54px; }
  .mk-hero h1 { font-size: clamp(38px, 8vw, 54px); }
  .mk-two, .mk-two-col, .mk-ask-grid { grid-template-columns: 1fr; }
  .mk-grid3 { grid-template-columns: 1fr 1fr; }
  .mk-grid5 { grid-template-columns: 1fr 1fr; }
  .mk-grid2 { grid-template-columns: 1fr; }
  .mk-checks { grid-template-columns: 1fr; }
  .mkp-stats { grid-template-columns: 1fr; }
  .mkp-stat + .mkp-stat { border-left: 0; padding-left: 0; border-top: 1px solid var(--line-2); }
}
@media (max-width: 620px) { .mk-grid3, .mk-grid5, .mk-form-grid { grid-template-columns: 1fr; } .mk-foot-grid { grid-template-columns: 1fr 1fr; } }

/* Cross-page transitions — pages crossfade instead of hard-cutting. */
@view-transition { navigation: auto; }
::view-transition-old(root) { animation-duration: .16s; }
::view-transition-new(root) { animation-duration: .2s; }

@media (prefers-reduced-motion: reduce) {
  @view-transition { navigation: none; }
  body.mk { scroll-behavior: auto; }
  /* absolutely everything visible and still — the motion system is opt-in
   * (classes come from JS, hero keyframes live behind no-preference), and
   * this block is the belt-and-braces guarantee on top */
  .mk-reveal, .mk-stag, .mk-reveal > .mk-h2, .mk-reveal .mk-ask-copy > .mk-h2, .mk-reveal > .mk-lead, .mk-reveal .mk-ask-copy > .mk-lead,
  .mk-stag .mk-step-n, .mk-stag .mk-level-cube, .mk-stag .mk-nta-row, .mk-stag .mk-nta-draft, .mk-stag .mk-nta-note {
    opacity: 1 !important; transform: none !important; filter: none !important; transition: none !important;
  }
  #mktop { transition: opacity .2s ease; }
  .mk-live i, .mk-typing i { animation: none !important; }
  .mk-theme svg, .mk-chat-launch svg, #mktop svg, .mk-logo svg, .mk-drop-grid a, .mk-foot-grid a, .mk-chat-close, .mk-agent-ico, .mk-varrow, .mk-scrollcue { transition: none !important; transform: none !important; }
  /* v10 one-shot choreography: fully visible and still under reduce */
  .mk-stag .mk-agent-ico svg path { stroke-dasharray: none !important; stroke-dashoffset: 0 !important; transition: none !important; }
  .mk-stag > .mk-vck, .mk-checks > .mk-stag::before { opacity: 1 !important; transform: none !important; transition: none !important; }
  .mk-msg { animation: none; }
  .mk-item.open .mk-drop, .mk-mobile.open { animation: none; }
}
`;
