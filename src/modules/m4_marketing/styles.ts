/** Marketing site styles v3 — "Editorial" design language. Ink on paper,
 * Fraunces serif display, hairline rules, generous whitespace, ONE accent
 * (brand blue) used sparingly. No gradients, no glass, no glow — restraint
 * is the aesthetic. Light-first with a dark-ink variant for the system
 * theme. All class names are unchanged from v2 (tests + templates pin
 * them); only the visual language moved. */

export const MARKETING_CSS = `
@font-face {
  font-family: 'InterVar';
  src: url('/assets/fonts/inter-var.woff2') format('woff2-variations');
  font-weight: 100 900; font-style: normal; font-display: swap;
}
@font-face {
  font-family: 'Fraunces';
  src: url('/assets/fonts/fraunces-var.woff2') format('woff2-variations');
  font-weight: 100 900; font-style: normal; font-display: swap;
}
@font-face {
  font-family: 'Fraunces';
  src: url('/assets/fonts/fraunces-italic-var.woff2') format('woff2-variations');
  font-weight: 100 900; font-style: italic; font-display: swap;
}

:root {
  --paper: #FBFAF7; --paper-2: #F5F3EC; --card: #FFFFFF;
  --ink: #14120E; --ink2: #494639; --mut: #7A7668; --faint: #A9A597;
  --line: #E3E0D5; --line-2: #ECEAE1;
  --accent: #1D4ED8; --accent-2: #1E40AF;
  --btn-bg: #14120E; --btn-ink: #FBFAF7;
  --display: 'Fraunces', Georgia, 'Times New Roman', serif;
  --ease: cubic-bezier(.16,1,.3,1);
  /* legacy token aliases (components reference these) */
  --bg: var(--paper); --sky: var(--accent); --sky-ink: var(--accent);
}
* { box-sizing: border-box; margin: 0; }
html { color-scheme: light; }

/* ---------- dark-ink variant (html[data-theme="dark"]) ---------- */
html[data-theme="dark"] { color-scheme: dark;
  --paper: #141310; --paper-2: #191813; --card: #1C1B16;
  --ink: #F2EFE6; --ink2: #C9C5B6; --mut: #918D7E; --faint: #6C685C;
  --line: #2C2A23; --line-2: #24221C;
  --accent: #91B0F5; --accent-2: #A8C0F7;
  --btn-bg: #F2EFE6; --btn-ink: #14120E;
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

/* buttons — ink solids, hairline outlines; no gradients, no glow */
.mk-btn { position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 7px; font-weight: 570; font-size: 14.5px; border-radius: 4px; padding: 11px 20px; border: 0; cursor: pointer; transition: transform .16s var(--ease), background .16s ease, border-color .16s ease, color .16s ease, box-shadow .16s ease; }
.mk-btn-lg { padding: 14px 26px; font-size: 15.5px; }
.mk-btn-solid { background: var(--btn-bg); color: var(--btn-ink); }
.mk-btn-solid:hover { transform: translateY(-1px); box-shadow: 0 8px 20px -10px rgba(20,18,14,.5); }
.mk-btn-solid:active { transform: translateY(0); box-shadow: none; }
.mk-btn-line { border: 1px solid var(--ink); color: var(--ink); background: transparent; }
.mk-btn-line:hover { transform: translateY(-1px); background: var(--card); box-shadow: 0 8px 20px -12px rgba(20,18,14,.4); }
.mk-btn-ghost { color: var(--ink2); background: transparent; }
.mk-btn-ghost:hover { color: var(--ink); }

/* hero — editorial: type does the work */
.mk-hero { position: relative; }
.mk-hero-in { position: relative; padding: 92px 40px 64px; }
.mk-hero-copy { max-width: 900px; }
.mk-kicker { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 620; letter-spacing: .13em; text-transform: uppercase; color: var(--mut); margin-bottom: 30px; }
.mk-kicker::before { content: ''; width: 22px; height: 1px; background: var(--accent); }
.mk-hero h1 {
  font-size: clamp(44px, 5.6vw, 76px); line-height: 1.02; letter-spacing: -.022em; font-weight: 480;
  color: var(--ink); max-width: 14em;
}
.mk-hero h1 em, .mk-h2 em { font-style: italic; font-weight: 430; }
.mk-sub { font-size: 19px; color: var(--ink2); margin: 28px 0 34px; max-width: 36em; }
.mk-cta-row { display: flex; gap: 13px; flex-wrap: wrap; }
.mk-hero-note { margin-top: 40px; padding-top: 22px; border-top: 1px solid var(--line); font-size: 14px; color: var(--mut); max-width: 900px; }
.mk-hero-note b { color: var(--ink); font-weight: 600; }

/* the real product, full width under the hero */
.mk-shotband { padding: 26px 0 84px; }
.mk-shot { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--card); box-shadow: 0 1px 2px rgba(20,18,14,.05), 0 28px 56px -30px rgba(20,18,14,.25); }
.mk-shot img { display: block; width: 100%; }
.mk-shot-cap { display: flex; justify-content: space-between; gap: 14px; font-size: 13px; color: var(--mut); padding: 13px 4px 0; }

/* legacy product-frame (feature pages) — plain document card now */
.mk-hero-visual { position: relative; }
.mk-frame { position: relative; background: var(--card); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; box-shadow: 0 20px 44px -26px rgba(20,18,14,.3); }
.mk-frame-bar { display: flex; gap: 6px; padding: 11px 14px; border-bottom: 1px solid var(--line-2); }
.mk-frame-bar span { width: 9px; height: 9px; border-radius: 99px; background: var(--line); }
.mk-frame-kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; padding: 14px; }
.mk-frame-kpis div { border: 1px solid var(--line-2); border-radius: 6px; padding: 10px 12px; }
.mk-frame-kpis b { display: block; font-size: 19px; letter-spacing: -.02em; color: var(--ink); font-family: var(--display); font-weight: 560; }
.mk-frame-kpis i { font-style: normal; font-size: 11px; color: var(--mut); }
.mk-frame-chart { display: flex; align-items: flex-end; gap: 7px; height: 110px; padding: 4px 16px 12px; }
.mk-frame-chart i { flex: 1; background: var(--accent); opacity: .85; border-radius: 2px 2px 0 0; min-height: 12%; transform: scaleY(0); transform-origin: bottom; transition: transform .7s var(--ease); }
.mk-frame-chart i.grown { transform: scaleY(1); }
.mk-frame-aihead { display: flex; align-items: center; justify-content: space-between; padding: 9px 16px; border-top: 1px solid var(--line-2); }
.mk-frame-aihead span { font-size: 10.5px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--accent); }
.mk-frame-aihead i { font-style: normal; font-size: 11px; font-weight: 600; color: var(--ink2); border: 1px solid var(--line); border-radius: 3px; padding: 2px 8px; }
.mk-frame-feed { border-top: 1px solid var(--line-2); padding: 11px 16px 14px; display: grid; gap: 7px; font-size: 12.5px; color: var(--ink2); }
.mk-frame-feed div { position: relative; padding-left: 14px; }
.mk-frame-feed div::before { content: ''; position: absolute; left: 0; top: 8px; width: 5px; height: 5px; border-radius: 99px; background: var(--accent); }
.mk-frame-feed em { font-style: normal; font-weight: 650; color: var(--ink); }

/* capability ticker — a thin editorial rule line */
.mk-marquee { position: relative; overflow: hidden; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); padding: 13px 0; background: var(--paper); }
.mk-marquee::before, .mk-marquee::after { content: ''; position: absolute; top: 0; bottom: 0; width: 110px; z-index: 1; pointer-events: none; }
.mk-marquee::before { left: 0; background: linear-gradient(90deg, var(--paper), transparent); }
.mk-marquee::after { right: 0; background: linear-gradient(270deg, var(--paper), transparent); }
.mk-marquee-track { display: flex; gap: 38px; width: max-content; animation: mkMarquee 40s linear infinite; }
.mk-marquee:hover .mk-marquee-track { animation-play-state: paused; }
.mk-mq-item { display: inline-flex; align-items: center; gap: 10px; font-size: 12px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--mut); white-space: nowrap; }
.mk-mq-item::before { content: ''; width: 4px; height: 4px; border-radius: 99px; background: var(--faint); }
@keyframes mkMarquee { to { transform: translateX(-50%); } }

/* sections — hairline-separated bands on one paper */
.mk-band { position: relative; padding: 92px 0; border-top: 1px solid var(--line); }
.mk-band-alt { background: var(--paper-2); }
.mk-h2 { font-size: clamp(30px, 3.5vw, 44px); letter-spacing: -.015em; line-height: 1.1; font-weight: 500; max-width: 20em; color: var(--ink); }
.mk-lead { font-size: 17px; color: var(--ink2); margin: 16px 0 42px; max-width: 44em; }
.mk-band .mk-kicker { margin-bottom: 18px; }
.mk-two { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.mk-plat { position: relative; border: 1px solid var(--line); background: var(--card); border-radius: 8px; padding: 32px; transition: border-color .2s ease, box-shadow .2s ease, transform .2s var(--ease); }
.mk-plat:hover { border-color: var(--ink); transform: translateY(-2px); box-shadow: 0 16px 34px -22px rgba(20,18,14,.35); }
.mk-plat-tag { font-size: 11.5px; font-weight: 650; letter-spacing: .13em; text-transform: uppercase; color: var(--accent); margin-bottom: 12px; }
.mk-plat h3 { font-size: 24px; font-weight: 540; letter-spacing: -.01em; margin-bottom: 8px; color: var(--ink); }
.mk-plat p { color: var(--ink2); font-size: 15px; }
.mk-more { display: inline-block; margin-top: 16px; font-weight: 570; color: var(--ink); font-size: 14px; text-decoration: underline; text-underline-offset: 4px; text-decoration-color: var(--faint); transition: text-decoration-color .16s ease, color .16s ease; }
.mk-plat:hover .mk-more, .mk-more:hover { text-decoration-color: var(--accent); color: var(--accent); }

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
.mk-nta-card { position: relative; background: var(--card); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 24px 48px -30px rgba(20,18,14,.35); padding: 24px; display: grid; gap: 14px; }
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
.mk-card { position: relative; border: 1px solid var(--line); background: var(--card); border-radius: 8px; padding: 26px; transition: border-color .2s ease, transform .2s var(--ease), box-shadow .2s ease; }
.mk-card:hover { border-color: var(--ink); transform: translateY(-2px); box-shadow: 0 14px 30px -22px rgba(20,18,14,.35); }
.mk-card h3 { font-size: 19px; font-weight: 560; margin-bottom: 7px; color: var(--ink); letter-spacing: -.005em; }
.mk-card p { color: var(--ink2); font-size: 14.5px; }
.mk-card .mk-more { margin-top: 12px; }
.mk-inline-cta { margin-top: 30px; }

/* governance — the one ink band on the page */
.mk-dark { position: relative; background: #14120E; color: #F2EFE6; border-top: 1px solid #14120E; }
html[data-theme="dark"] .mk-dark { background: #0D0C09; border-top-color: var(--line); }
.mk-dark .mk-wrap { position: relative; }
.mk-dark .mk-h2 { color: #FBFAF7; }
.mk-dark .mk-lead { color: #C9C5B6; }
.mk-dark .mk-kicker { color: #918D7E; }
.mk-checks { display: grid; grid-template-columns: repeat(2, minmax(240px, 1fr)); gap: 10px 30px; list-style: none; padding: 0; margin: 0 0 38px; max-width: 800px; }
.mk-checks li { padding-left: 26px; position: relative; font-size: 15px; color: #C9C5B6; }
.mk-checks li::before { content: '—'; position: absolute; left: 0; top: 0; color: #91B0F5; font-weight: 600; }
.mk-checks li:hover { color: #FBFAF7; }
.mk-grid5 { display: grid; grid-template-columns: repeat(5, 1fr); gap: 1px; background: rgba(242,239,230,.14); border: 1px solid rgba(242,239,230,.14); }
.mk-gov { padding: 18px; background: #14120E; transition: background .2s ease; }
html[data-theme="dark"] .mk-gov { background: #0D0C09; }
.mk-gov:hover { background: #1C1A14; }
.mk-gov h4 { font-size: 14px; margin-bottom: 6px; color: #FBFAF7; font-weight: 640; }
.mk-gov p { font-size: 12.5px; color: #918D7E; }

/* pricing */
.mk-price-row { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; max-width: 880px; }
.mk-price { position: relative; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 32px; transition: border-color .2s ease, transform .2s var(--ease), box-shadow .2s ease; }
.mk-price:first-child { border-color: var(--ink); }
.mk-price:first-child::before { content: 'Recommended'; position: absolute; top: -9px; left: 28px; font-size: 10.5px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--accent); background: var(--card); padding: 0 8px; }
.mk-price:hover { transform: translateY(-2px); box-shadow: 0 16px 34px -22px rgba(20,18,14,.35); }
.mk-price-tag { font-size: 11.5px; font-weight: 650; letter-spacing: .13em; text-transform: uppercase; color: var(--mut); margin-bottom: 10px; }
.mk-price-big { font-size: 46px; font-weight: 500; letter-spacing: -.02em; margin-bottom: 8px; font-family: var(--display); color: var(--ink); }
.mk-price-big span { font-size: 15px; font-weight: 500; color: var(--mut); font-family: 'InterVar', sans-serif; }
.mk-price p { color: var(--ink2); font-size: 14.5px; margin-bottom: 14px; }
@media (max-width: 980px) { .mk-price-row { grid-template-columns: 1fr; } }

/* walkthrough */
.mk-two-col { display: grid; grid-template-columns: 1.1fr .9fr; gap: 48px; align-items: start; }
.mk-form-card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 28px; box-shadow: 0 24px 48px -32px rgba(20,18,14,.35); }
.mk-form-card h3 { margin-bottom: 16px; color: var(--ink); font-size: 22px; font-weight: 540; }
.mk-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
.mk-form-card label { display: flex; flex-direction: column; gap: 5px; font-size: 12.5px; font-weight: 620; color: var(--ink2); }
.mk-form-card input, .mk-form-card select { font: inherit; font-weight: 400; padding: 10px 12px; border: 1px solid var(--line); border-radius: 4px; background: var(--paper); color: var(--ink); transition: border-color .16s ease, box-shadow .16s ease; }
.mk-form-card select option { background: var(--card); }
.mk-form-card input:focus, .mk-form-card select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(29,78,216,.14); }
.mk-form-full { margin-bottom: 14px; }
.mk-thanks { font-size: 15.5px; color: var(--ink2); }
.mk-thanks b { color: var(--ink); }

/* footer */
.mk-foot { position: relative; background: var(--paper); color: var(--mut); padding: 60px 0 28px; border-top: 1px solid var(--line); }
.mk-foot-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 24px; padding-bottom: 34px; border-bottom: 1px solid var(--line); }
.mk-foot-head { font-size: 11.5px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--ink); margin-bottom: 12px; }
.mk-foot-grid a { display: block; font-size: 13.5px; padding: 3.5px 0; color: var(--mut); transition: color .15s ease; }
.mk-foot-grid a:hover { color: var(--accent); }
.mk-foot-base { display: flex; justify-content: space-between; gap: 14px; flex-wrap: wrap; padding-top: 20px; font-size: 13px; align-items: center; }

/* reveal + stagger — fallback for browsers without scroll timelines */
.mk-reveal { opacity: 0; transform: translateY(26px); transition: opacity .8s var(--ease), transform .8s var(--ease); }
.mk-reveal.vis { opacity: 1; transform: none; }
.mk-stag { opacity: 0; transform: translateY(22px); transition: opacity .7s var(--ease), transform .7s var(--ease); }
.vis .mk-stag, .mk-stag.vis { opacity: 1; transform: none; }
.mk-ask-grid > .mk-stag:first-child, .mk-two > .mk-stag:first-child { transform: translateX(-26px); }
.mk-ask-grid > .mk-stag:last-child, .mk-two > .mk-stag:last-child { transform: translateX(26px); }
.mk-steps > .mk-stag { transform: translateX(-26px); }
.mk-price-row > .mk-stag:first-child { transform: translateX(-22px); }
.mk-price-row > .mk-stag:last-child { transform: translateX(22px); }
/* headline rule draws in as its section reveals */
.mk-h2 { position: relative; padding-bottom: 18px; }
.mk-h2::after { content: ''; position: absolute; left: 2px; bottom: 0; width: 44px; height: 2px; background: var(--accent); transform: scaleX(0); transform-origin: 0 50%; transition: transform .7s var(--ease) .25s; }
.mk-reveal.vis .mk-h2::after, .vis .mk-h2::after { transform: scaleX(1); }
.mk-dark .mk-h2::after { background: #91B0F5; }

/* ---------- scroll-DRIVEN choreography (Chromium/Safari) ----------
 * Reveals track the scroll position — reversible, restrained: rows rise
 * and settle, paired panels converge, headlines wipe open, the product
 * shot straightens. Browsers without support keep the reveals above. */
@supports (animation-timeline: view()) {
  .mk-reveal, .mk-stag {
    opacity: 1; transform: none;
    transition: none;
    animation-name: mk-scrub-rise; animation-timing-function: linear; animation-fill-mode: both;
    animation-timeline: view(); animation-range: entry 0% cover 30%;
  }
  .mk-hero-in.mk-reveal { animation: none; }

  .mk-stag { animation-name: mk-scrub-up; animation-range: entry 0% cover 38%; }

  .mk-two > .mk-stag:first-child, .mk-ask-grid > .mk-stag:first-child, .mk-price-row > .mk-stag:first-child, .mk-two-col > .mk-stag:first-child { animation-name: mk-scrub-left; }
  .mk-two > .mk-stag:last-child, .mk-ask-grid > .mk-stag:last-child, .mk-price-row > .mk-stag:last-child, .mk-two-col > .mk-stag:last-child { animation-name: mk-scrub-right; }

  .mk-steps > .mk-stag, .mk-levels > .mk-stag { animation-name: mk-scrub-left; animation-range: entry 0% cover 34%; }
  .mk-steps .mk-step-n {
    animation-name: mk-scrub-num; animation-timing-function: linear; animation-fill-mode: both;
    animation-timeline: view(); animation-range: entry 16% cover 42%;
  }

  .mk-band .mk-h2 {
    animation-name: mk-scrub-wipe; animation-timing-function: linear; animation-fill-mode: both;
    animation-timeline: view(); animation-range: entry 0% cover 32%;
  }

  .mk-shotband .mk-shot, .mk-band .mk-frame {
    animation-name: mk-scrub-straighten; animation-timing-function: linear; animation-fill-mode: both;
    animation-timeline: view(); animation-range: entry 0% cover 46%;
  }

  .mk-band .mk-kicker {
    animation-name: mk-scrub-kicker; animation-timing-function: linear; animation-fill-mode: both;
    animation-timeline: view(); animation-range: entry 0% cover 24%;
  }
}
/* End keyframes are implicit (the element's own resting style) so filled
 * scroll animations never pin transform and hover states keep working. */
@keyframes mk-scrub-rise { from { opacity: 0; transform: translateY(24px); } }
@keyframes mk-scrub-up { from { opacity: 0; transform: translateY(34px); } }
@keyframes mk-scrub-left { from { opacity: 0; transform: translateX(-44px); } }
@keyframes mk-scrub-right { from { opacity: 0; transform: translateX(44px); } }
@keyframes mk-scrub-wipe { from { clip-path: inset(-20px 92% -20px -20px); opacity: .3; } to { clip-path: inset(-20px -4% -20px -20px); opacity: 1; } }
@keyframes mk-scrub-straighten { from { opacity: .35; transform: perspective(1400px) rotateX(7deg) translateY(30px) scale(.97); } }
@keyframes mk-scrub-num { from { opacity: 0; transform: translateY(12px); } }
@keyframes mk-scrub-kicker { from { opacity: 0; letter-spacing: .3em; } }

/* ask stayleased section */
.mk-kicker-ai { display: inline-flex; align-items: center; gap: 7px; }
.mk-ask-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 48px; align-items: center; }
.mk-ask-copy .mk-h2 { margin-bottom: 0; }
.mk-ask-points { list-style: none; padding: 0; margin: 18px 0 26px; display: grid; gap: 9px; }
.mk-ask-points li { position: relative; padding-left: 24px; font-size: 14.5px; color: var(--ink2); }
.mk-ask-points li::before { content: '—'; position: absolute; left: 0; top: 0; color: var(--accent); font-weight: 600; }
.mk-ask-points li::after { content: none; }
.mk-askbox { background: var(--card); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 24px 48px -30px rgba(20,18,14,.3); overflow: hidden; display: flex; flex-direction: column; min-height: 420px; }
.mk-askbox-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--line); }
.mk-askbox-id { display: flex; align-items: center; gap: 10px; }
.mk-askbox-av { width: 34px; height: 34px; border-radius: 50%; background: var(--btn-bg); color: var(--btn-ink); font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
.mk-askbox-id b { font-size: 14px; display: block; color: var(--ink); }
.mk-askbox-id span { font-size: 11.5px; color: var(--mut); }
.mk-live { display: inline-flex; align-items: center; gap: 6px; font-size: 10.5px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #1A7F4F; border: 1px solid rgba(26,127,79,.35); border-radius: 3px; padding: 3px 8px; }
html[data-theme="dark"] .mk-live { color: #6FCF9A; border-color: rgba(111,207,154,.35); }
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
.mkp-chip { display: inline-flex; align-items: center; gap: 7px; font-size: 11.5px; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; border-radius: 3px; padding: 4px 10px; margin: 0 0 20px; border: 1px solid; }
.mkp-chip::before { content: ''; width: 6px; height: 6px; border-radius: 99px; background: currentColor; }
.mkp-chip.live { color: #1A7F4F; border-color: rgba(26,127,79,.4); }
.mkp-chip.soon { color: #9A6A00; border-color: rgba(154,106,0,.4); }
html[data-theme="dark"] .mkp-chip.live { color: #6FCF9A; border-color: rgba(111,207,154,.4); }
html[data-theme="dark"] .mkp-chip.soon { color: #E3B341; border-color: rgba(227,179,65,.4); }
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
.mkp-cta { position: relative; background: #14120E; color: #FBFAF7; text-align: center; padding: 76px 0; border-top: 1px solid #14120E; }
html[data-theme="dark"] .mkp-cta { background: #0D0C09; border-top-color: var(--line); }
.mkp-cta h2 { font-size: clamp(28px, 3.4vw, 40px); letter-spacing: -.015em; font-weight: 500; margin-bottom: 10px; }
.mkp-cta p { color: #C9C5B6; margin-bottom: 26px; }
.mkp-cta .mk-cta-row { justify-content: center; }
.mkp-cta .mk-btn-solid { background: #FBFAF7; color: #14120E; }
.mkp-cta .mk-btn-line { background: transparent; color: #FBFAF7; border-color: rgba(251,250,247,.4); }
.mkp-cta .mk-btn-line:hover { border-color: #FBFAF7; }
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

/* hero entrance — a single quiet rise, then the page is still */
.mk-hero-copy > * { animation: mkUp .6s var(--ease) both; }
.mk-hero-copy > *:nth-child(1) { animation-delay: .03s; }
.mk-hero-copy > *:nth-child(2) { animation-delay: .1s; }
.mk-hero-copy > *:nth-child(3) { animation-delay: .17s; }
.mk-hero-copy > *:nth-child(4) { animation-delay: .25s; }
.mk-hero-copy > *:nth-child(5) { animation-delay: .33s; }
.mk-hero-in .mk-hero-visual { animation: mkUp .7s var(--ease) .2s both; }
@keyframes mkUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
@keyframes mkVis { from { opacity: 0; } to { opacity: 1; } }

/* back-to-top */
#mktop { position: fixed; right: 22px; bottom: 22px; z-index: 70; width: 44px; height: 44px; border-radius: 50%; border: 1px solid var(--line); background: var(--card); color: var(--ink); display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 12px 26px -14px rgba(20,18,14,.4); opacity: 0; transform: translateY(14px); pointer-events: none; transition: opacity .26s var(--ease), transform .26s var(--ease), border-color .16s ease; }
#mktop.show { opacity: 1; transform: none; pointer-events: auto; }
#mktop:hover { border-color: var(--ink); transform: translateY(-2px); }

/* responsive */
@media (max-width: 980px) {
  .mk-wrap { padding: 0 24px; }
  .mk-menu, .mk-nav-cta { display: none; }
  .mk-burger { display: flex; }
  .mk-hero-in { padding: 52px 24px 44px; }
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
  .mk-reveal, .mk-stag, .mk-band .mk-h2, .mk-band .mk-frame, .mk-band .mk-kicker, .mk-steps .mk-step-n, .mk-shotband .mk-shot { animation: none !important; }
  .mk-reveal, .mk-stag { opacity: 1 !important; transform: none !important; transition: none; }
  .mk-h2::after { transform: scaleX(1); transition: none; }
  .mk-marquee-track { animation: none; }
  .mk-frame-chart i { transform: scaleY(1); }
  #mktop { transition: opacity .2s ease; }
  .mk-live i, .mk-typing i { animation: none !important; }
  .mk-msg { animation: none; }
  .mk-item.open .mk-drop, .mk-mobile.open { animation: none; }
  .mk-hero-copy > *, .mk-hero-in .mk-hero-visual { animation: none !important; }
}
`;
