/** Marketing site styles v6 — Entrata-grade theme (Space Grotesk display,
 * cream/white bands, pill buttons, elevated cards, floating hero
 * vignettes) + choreographed one-shot motion. Motion doctrine (permanent):
 * NOTHING is scroll-scrubbed — each element animates once on first entry
 * (typed direction + stagger via the --sd var set in chrome.ts) and then
 * holds still; the only continuous motion is the hero vignettes' slow
 * float, which is time-based, never scroll-linked. Light-first with a
 * dark variant for the system theme. All class names are unchanged from
 * v2 (tests + templates pin them); only visuals and motion move. */

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
  --ink: #131519; --ink2: #454A54; --mut: #737884; --faint: #A6AAB4;
  --line: #E7E4DD; --line-2: #EFEDE7;
  --accent: #1D4ED8; --accent-2: #1638A8;
  --btn-bg: #1D4ED8; --btn-ink: #FFFFFF;
  --display: 'Space Grotesk', 'InterVar', ui-sans-serif, system-ui, sans-serif;
  --ease: cubic-bezier(.16,1,.3,1);
  --spring: cubic-bezier(.34,1.5,.64,1);
  /* legacy token aliases (components reference these) */
  --bg: var(--paper); --sky: var(--accent); --sky-ink: var(--accent);
}
* { box-sizing: border-box; margin: 0; }
html { color-scheme: light; }

/* ---------- dark-ink variant (html[data-theme="dark"]) ---------- */
html[data-theme="dark"] { color-scheme: dark;
  --paper: #131418; --paper-2: #191B20; --card: #1D1F25;
  --ink: #EDEEF2; --ink2: #C2C5CD; --mut: #8B8F9A; --faint: #62666F;
  --line: #2B2E35; --line-2: #23252B;
  --accent: #7FA3F6; --accent-2: #A8C0F7;
  --btn-bg: #3B6BE8; --btn-ink: #FFFFFF;
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
body.mk ::selection { background: rgba(29,78,216,.18); }
.mk-wrap { max-width: 1180px; margin: 0 auto; padding: 0 40px; }
a { color: inherit; text-decoration: none; }
h1, h2, h3 { font-family: var(--display); }
h4 { font-family: 'InterVar', sans-serif; }

/* scroll progress bar */
#mkprog { position: fixed; top: 0; left: 0; right: 0; height: 2px; z-index: 90; background: var(--ink); transform: scaleX(0); transform-origin: 0 50%; transition: transform .08s linear; }

/* nav */
.mk-nav { position: sticky; top: 0; z-index: 60; background: var(--paper); border-bottom: 1px solid var(--line); transition: box-shadow .25s ease; }
.mk-nav.scrolled { box-shadow: 0 1px 0 var(--line), 0 8px 24px -18px rgba(20,18,14,.35); }
.mk-nav-in { display: flex; align-items: center; gap: 30px; height: 68px; transition: height .25s ease; }
.mk-nav.scrolled .mk-nav-in { height: 58px; }
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

/* buttons — confident pills, solid blue primary */
.mk-btn { position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 7px; font-weight: 600; font-size: 14.5px; border-radius: 999px; padding: 11px 22px; border: 0; cursor: pointer; transition: transform .16s var(--ease), background .16s ease, border-color .16s ease, color .16s ease, box-shadow .16s ease; }
.mk-btn-lg { padding: 14px 30px; font-size: 15.5px; }
.mk-btn-solid { background: var(--btn-bg); color: var(--btn-ink); }
.mk-btn-solid:hover { transform: translateY(-1px); background: var(--accent-2); box-shadow: 0 10px 24px -10px rgba(29,78,216,.55); }
.mk-btn-solid:active { transform: translateY(0); box-shadow: none; }
.mk-btn-line { border: 1.5px solid var(--ink); color: var(--ink); background: transparent; }
.mk-btn-line:hover { transform: translateY(-1px); background: var(--card); box-shadow: 0 8px 20px -12px rgba(20,18,14,.4); }
.mk-btn-ghost { color: var(--ink2); background: transparent; }
.mk-btn-ghost:hover { color: var(--ink); }

/* hero — centered statement over floating product vignettes */
.mk-hero { position: relative; overflow: hidden; }
.mk-hero-in { position: relative; padding: 84px 40px 0; }
.mk-hero-copy { max-width: 880px; margin: 0 auto; text-align: center; }
.mk-hero-copy .mk-cta-row { justify-content: center; }
.mk-hero-copy .mk-kicker { justify-content: center; }
.mk-kicker { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: var(--accent); margin-bottom: 22px; }
.mk-hero h1 {
  font-size: clamp(46px, 6vw, 84px); line-height: 1.0; letter-spacing: -.035em; font-weight: 640;
  color: var(--ink);
}
.mk-sub { font-size: 19px; color: var(--ink2); margin: 26px auto 34px; max-width: 40em; }
.mk-cta-row { display: flex; gap: 13px; flex-wrap: wrap; }
.mk-hero-note { margin-top: 26px; font-size: 14px; color: var(--mut); }
.mk-hero-note b { color: var(--ink); font-weight: 600; }

/* hero vignettes — stylized product cards, layered like a desk */
.mk-vigrow { display: grid; grid-template-columns: repeat(3, 1fr); gap: 22px; align-items: start; margin: 60px auto -78px; position: relative; z-index: 2; padding-bottom: 8px; }
.mk-hero + .mk-band { padding-top: 178px; }
.mk-vig { --vr: 0deg; --vy: 0px; background: var(--card); border: 1px solid var(--line-2); border-radius: 16px; box-shadow: 0 2px 4px rgba(19,21,25,.06), 0 32px 64px -24px rgba(19,21,25,.35); padding: 18px; font-size: 13px; transform: rotate(var(--vr)) translateY(var(--vy)); }
.mk-vig:first-child { --vr: -1.6deg; --vy: 14px; }
.mk-vig:last-child { --vr: 1.4deg; --vy: 10px; }
.mk-vig-head { display: flex; align-items: center; gap: 9px; padding-bottom: 12px; border-bottom: 1px solid var(--line-2); margin-bottom: 12px; }
.mk-vig-av { width: 30px; height: 30px; border-radius: 50%; background: var(--accent); color: #fff; font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex: none; }
.mk-vig-head b { font-size: 13px; color: var(--ink); display: block; line-height: 1.2; }
.mk-vig-head span { font-size: 11px; color: var(--mut); }
.mk-vig-live { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; font-size: 9.5px; font-weight: 700; letter-spacing: .08em; color: var(--accent); border: 1px solid var(--line); border-radius: 999px; padding: 3px 8px; flex: none; }
.mk-vig-live i { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); animation: mkPulse 1.8s ease-in-out infinite; }
.mk-vig-msg { border-radius: 12px; padding: 9px 12px; margin-bottom: 8px; line-height: 1.5; }
.mk-vig-msg.you { background: var(--btn-bg); color: #fff; border-bottom-right-radius: 4px; margin-left: 34px; }
.mk-vig-msg.agent { background: var(--paper-2); color: var(--ink); border-bottom-left-radius: 4px; margin-right: 20px; }
html[data-theme="dark"] .mk-vig-msg.agent { background: #23252B; }
.mk-vig-task { display: flex; align-items: center; gap: 9px; padding: 6px 0; color: var(--ink2); }
.mk-vig-task i { width: 16px; height: 16px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center; font-size: 9px; font-style: normal; font-weight: 800; background: rgba(29,78,216,.12); color: var(--accent); }
.mk-vig-task.hold i { background: rgba(180,110,10,.14); color: #A06508; }
html[data-theme="dark"] .mk-vig-task.hold i { color: #E3B341; }
.mk-vig-chip { display: inline-block; font-size: 10.5px; font-weight: 650; border: 1px solid var(--line); border-radius: 999px; padding: 2px 9px; color: var(--mut); margin-left: auto; flex: none; }
.mk-vig-chip.warn { color: #A06508; border-color: rgba(180,110,10,.35); }
html[data-theme="dark"] .mk-vig-chip.warn { color: #E3B341; border-color: rgba(227,179,65,.4); }
.mk-vig-actions { display: flex; gap: 7px; margin-top: 10px; }
.mk-vig-actions span { font-size: 11.5px; font-weight: 650; border-radius: 999px; padding: 5px 13px; }
.mk-vig-ok { background: var(--btn-bg); color: #fff; }
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
.mk-compare { border: 1px solid var(--line-2); border-radius: 16px; overflow-x: auto; background: var(--card); box-shadow: 0 1px 2px rgba(19,21,25,.05), 0 14px 34px -18px rgba(19,21,25,.22); }
.mk-compare table { width: 100%; border-collapse: collapse; font-size: 14px; min-width: 720px; }
.mk-compare th, .mk-compare td { padding: 14px 18px; text-align: left; border-bottom: 1px solid var(--line-2); }
.mk-compare tbody tr:last-child td { border-bottom: 0; }
.mk-compare thead th { font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--mut); border-bottom: 1px solid var(--line); }
.mk-compare td:first-child { color: var(--ink); font-weight: 550; max-width: 340px; }
.mk-compare td:not(:first-child), .mk-compare th:not(:first-child) { text-align: center; width: 17%; }
.mk-compare td:not(:first-child) { color: var(--mut); }
.mk-compare .mkc-us { color: var(--ink); font-weight: 620; background: rgba(29,78,216,.045); }
html[data-theme="dark"] .mk-compare .mkc-us { background: rgba(143,175,247,.07); }
.mk-compare thead th.mkc-us { color: var(--accent); }

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
.mk-nta-ok { background: var(--btn-bg); color: var(--btn-ink); }
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

/* governance — same paper as every other section, plain ruled checklist */
.mk-dark { position: relative; background: var(--paper); color: var(--ink); }
.mk-dark .mk-wrap { position: relative; }
.mk-dark .mk-h2 { color: var(--ink); }
.mk-dark .mk-lead { color: var(--ink2); }
.mk-dark .mk-kicker { color: var(--mut); }
.mk-checks { display: grid; grid-template-columns: repeat(2, minmax(240px, 1fr)); gap: 12px 40px; list-style: none; padding: 0; margin: 0; max-width: 860px; }
.mk-checks li { padding-left: 24px; position: relative; font-size: 15px; color: var(--ink2); }
.mk-checks li::before { content: '—'; position: absolute; left: 0; top: 0; color: var(--accent); font-weight: 600; }
.mk-checks li:hover { color: var(--ink); }
.mk-grid5 { display: grid; grid-template-columns: repeat(5, 1fr); gap: 16px; }
.mk-gov { padding: 20px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
.mk-gov h4 { font-size: 14px; margin-bottom: 6px; color: var(--ink); font-weight: 640; }
.mk-gov p { font-size: 12.5px; color: var(--mut); }

/* pricing */
.mk-price-row { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; max-width: 880px; }
.mk-price { position: relative; background: var(--card); border: 1px solid var(--line-2); border-radius: 16px; padding: 32px; box-shadow: 0 1px 2px rgba(19,21,25,.05), 0 14px 34px -18px rgba(19,21,25,.22); transition: transform .2s var(--ease), box-shadow .2s ease; }
.mk-price:first-child { border: 2px solid var(--accent); }
.mk-price:first-child::before { content: 'Early access'; position: absolute; top: -12px; left: 28px; font-size: 10.5px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: #fff; background: var(--accent); border-radius: 999px; padding: 4px 12px; }
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
.mk-form-card input:focus, .mk-form-card select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(29,78,216,.14); }
.mk-form-full { margin-bottom: 14px; }
.mk-thanks { font-size: 15.5px; color: var(--ink2); }
.mk-thanks b { color: var(--ink); }

/* footer — dark anchor band */
.mk-foot { position: relative; background: #101216; color: #8B8F9A; padding: 60px 0 28px; }
.mk-foot-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 24px; padding-bottom: 34px; border-bottom: 1px solid rgba(237,238,242,.12); }
.mk-foot-head { font-size: 11.5px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: #EDEEF2; margin-bottom: 12px; }
.mk-foot-grid a { display: block; font-size: 13.5px; padding: 3.5px 0; color: #8B8F9A; transition: color .15s ease; }
.mk-foot-grid a:hover { color: #FFFFFF; }
.mk-foot-base { display: flex; justify-content: space-between; gap: 14px; flex-wrap: wrap; padding-top: 20px; font-size: 13px; align-items: center; color: #6B6F7A; }

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
.mk-askbox-av { width: 34px; height: 34px; border-radius: 50%; background: var(--btn-bg); color: var(--btn-ink); font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
.mk-askbox-id b { font-size: 14px; display: block; color: var(--ink); }
.mk-askbox-id span { font-size: 11.5px; color: var(--mut); }
.mk-live { display: inline-flex; align-items: center; gap: 6px; font-size: 10.5px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); border: 1px solid var(--line); border-radius: 3px; padding: 3px 8px; }
.mk-live i { width: 6px; height: 6px; border-radius: 99px; background: currentColor; animation: mkPulse 1.8s ease-in-out infinite; }
.mk-ask-msgs, .mk-chat-msgs { flex: 1; padding: 16px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
.mk-ask-msgs { min-height: 210px; max-height: 300px; }
.mk-msg { max-width: 85%; padding: 10px 13px; border-radius: 8px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; animation: mkMsgIn .3s var(--ease); }
.mk-msg.you { align-self: flex-end; background: var(--btn-bg); color: var(--btn-ink); border-bottom-right-radius: 3px; }
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
.mk-ask-form input:focus, .mk-chat-form input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(29,78,216,.14); }
.mk-ask-form button, .mk-chat-form button { flex: none; width: 42px; border: 0; border-radius: 4px; background: var(--btn-bg); color: var(--btn-ink); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: opacity .16s ease; }
.mk-ask-form button:hover, .mk-chat-form button:hover { opacity: .85; }

/* floating chat widget */
.mk-chat { position: fixed; right: 22px; bottom: 22px; z-index: 80; }
.mk-chat-launch { display: inline-flex; align-items: center; gap: 9px; font: inherit; font-weight: 600; font-size: 14.5px; color: var(--btn-ink); background: var(--btn-bg); border: 0; border-radius: 999px; padding: 12px 18px 12px 15px; cursor: pointer; box-shadow: 0 14px 30px -14px rgba(20,18,14,.5); transition: transform .2s var(--ease), box-shadow .2s var(--ease); }
.mk-chat-launch:hover { transform: translateY(-2px); box-shadow: 0 18px 36px -14px rgba(20,18,14,.55); }
.mk-chat.open .mk-chat-launch { transform: scale(.9); opacity: 0; pointer-events: none; }
.mk-chat-panel { position: absolute; right: 0; bottom: 0; width: min(380px, calc(100vw - 32px)); height: min(560px, calc(100vh - 110px)); background: var(--card); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 40px 80px -40px rgba(20,18,14,.5); display: flex; flex-direction: column; overflow: hidden; opacity: 0; transform: translateY(20px) scale(.96); transform-origin: bottom right; pointer-events: none; transition: opacity .24s var(--ease), transform .24s var(--ease); }
.mk-chat.open .mk-chat-panel { opacity: 1; transform: none; pointer-events: auto; }
.mk-chat-head { display: flex; align-items: center; justify-content: space-between; padding: 13px 15px; background: var(--btn-bg); color: var(--btn-ink); }
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

/* hero entrance — plays once on load, then only the vignettes breathe.
 * The copy cascades down; the three vignette cards rise up into their
 * desk tilts with a spring; inside them the conversation/tasks play out
 * in order like live product activity; then each card floats on its own
 * slow phase (continuous but NOT scroll-linked — nothing ever vibrates). */
@media (prefers-reduced-motion: no-preference) {
  .mk-hero-copy > * { animation: mkUp .65s var(--ease) both; }
  .mk-hero-copy > *:nth-child(1) { animation-delay: .05s; }
  .mk-hero-copy > *:nth-child(2) { animation-delay: .14s; animation-duration: .8s; }
  .mk-hero-copy > *:nth-child(3) { animation-delay: .26s; }
  .mk-hero-copy > *:nth-child(4) { animation-delay: .38s; }
  .mk-hero-copy > *:nth-child(5) { animation-delay: .5s; }
  .mk-hero h1 { animation-name: mkH1; }
  .mk-vig { animation: mkVigIn .85s var(--ease) both, mkVigFloat 7s ease-in-out 3.4s infinite alternate; }
  .mk-vig:nth-child(1) { animation-delay: .72s, 3.4s; }
  .mk-vig:nth-child(2) { animation-delay: .58s, 2.9s; animation-duration: .85s, 8.2s; }
  .mk-vig:nth-child(3) { animation-delay: .86s, 3.9s; animation-duration: .85s, 7.4s; }
  .mk-vig > :not(.mk-vig-head) { animation: mkItemIn .5s var(--ease) both; }
  .mk-vig > :nth-child(2) { animation-delay: 1.5s; }
  .mk-vig > :nth-child(3) { animation-delay: 1.95s; }
  .mk-vig > :nth-child(4) { animation-delay: 2.4s; }
  .mk-vig > :nth-child(5) { animation-delay: 2.85s; }
  .mk-hero::before { animation: mkDrift 18s ease-in-out infinite alternate; }
}
@keyframes mkUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }
@keyframes mkH1 { from { opacity: 0; transform: translateY(22px); filter: blur(10px); } to { opacity: 1; transform: none; filter: none; } }
@keyframes mkVigIn { from { opacity: 0; transform: rotate(var(--vr)) translateY(calc(var(--vy) + 52px)) scale(.94); } to { opacity: 1; transform: rotate(var(--vr)) translateY(var(--vy)) scale(1); } }
@keyframes mkVigFloat { from { transform: rotate(var(--vr)) translateY(var(--vy)); } to { transform: rotate(var(--vr)) translateY(calc(var(--vy) - 9px)); } }
@keyframes mkItemIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@keyframes mkDrift { from { transform: translateX(-58%) translateY(0); } to { transform: translateX(-42%) translateY(26px); } }
/* soft brand wash behind the hero — static color, slow positional drift */
.mk-hero::before { content: ''; position: absolute; left: 50%; top: -240px; width: 980px; height: 680px; transform: translateX(-50%); border-radius: 50%; background: radial-gradient(closest-side, rgba(29,78,216,.08), transparent 72%); pointer-events: none; }
html[data-theme="dark"] .mk-hero::before { background: radial-gradient(closest-side, rgba(127,163,246,.07), transparent 72%); }

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
  .mk-msg { animation: none; }
  .mk-item.open .mk-drop, .mk-mobile.open { animation: none; }
}
`;
