/** Marketing site styles v2 — "Obsidian" brand language, shared with the app.
 * Deep blue-black canvas, aurora gradients, glass chrome, Space Grotesk
 * display type, electric-blue → violet signature gradient. All class names
 * are unchanged from v1 (tests + templates pin them); only the visual
 * language moved. */

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
  --ink: #eef2fa; --ink2: #c3cddf; --mut: #8b98ad; --faint: #5d6b82;
  --blue: #3b82f6; --blue-d: #2f6ded; --sky: #60a5fa; --sky-ink: #9cc3ff;
  --violet: #8b5cf6; --cyan: #22d3ee;
  --line: rgba(154, 170, 196, .15); --line-2: rgba(154, 170, 196, .08);
  --bg: #05070d; --bg2: rgba(255, 255, 255, .025);
  --card: #0d1322; --card-up: linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,0) 55%);
  --grad: linear-gradient(135deg, #2563eb 0%, #4f46e5 100%);
  --grad-wide: linear-gradient(90deg, #38bdf8, #2563eb 50%, #4f46e5);
  --display: 'Space Grotesk', 'InterVar', ui-sans-serif, system-ui, sans-serif;
  --ease: cubic-bezier(.16,1,.3,1);
}
* { box-sizing: border-box; margin: 0; }
html { color-scheme: dark; }

/* ---------- light theme (html[data-theme="light"]) ---------- */
html[data-theme="light"] { color-scheme: light;
  --ink: #0e1524; --ink2: #333f54; --mut: #5c6a81; --faint: #93a0b5;
  --line: rgba(13, 25, 48, .13); --line-2: rgba(13, 25, 48, .07);
  --bg: #f5f7fb; --bg2: rgba(13, 25, 48, .03);
  --card: #ffffff; --card-up: linear-gradient(180deg, rgba(255,255,255,0), rgba(255,255,255,0));
  --sky-ink: #1d4ed8;
}
[data-theme="light"] .mk-nav { background: rgba(255, 255, 255, .78); }
[data-theme="light"] .mk-nav.scrolled { background: rgba(255, 255, 255, .92); box-shadow: 0 10px 30px rgba(16, 24, 40, .08); }
[data-theme="light"] .mk-item-btn:hover, [data-theme="light"] .mk-item-link:hover, [data-theme="light"] .mk-item.open .mk-item-btn { background: rgba(13, 25, 48, .05); color: var(--ink); }
[data-theme="light"] .mk-drop { background: rgba(255, 255, 255, .99); box-shadow: 0 26px 60px rgba(16, 24, 40, .18); }
[data-theme="light"] .mk-drop-grid a:hover, [data-theme="light"] .mk-drop-grid a:focus-visible { background: rgba(37, 99, 235, .07); }
[data-theme="light"] .mk-mobile { background: rgba(255, 255, 255, .99); }
[data-theme="light"] .mk-mm-links a:hover, [data-theme="light"] .mk-mm-link:hover { background: rgba(13, 25, 48, .05); color: var(--ink); }
[data-theme="light"] .mk-burger span { background: var(--ink); }
[data-theme="light"] .mk-btn-line { background: #fff; border-color: rgba(13, 25, 48, .22); color: var(--ink); }
[data-theme="light"] .mk-btn-line:hover { border-color: #2563eb; color: #1d4ed8; background: rgba(37, 99, 235, .05); }
[data-theme="light"] .mk-btn-ghost { color: var(--ink2); }
[data-theme="light"] .mk-btn-ghost:hover { color: var(--ink); background: rgba(13, 25, 48, .05); }
[data-theme="light"] .mk-hero::before {
  background:
    radial-gradient(760px 420px at 72% 18%, rgba(59, 130, 246, .12), transparent 62%),
    radial-gradient(560px 360px at 14% 4%, rgba(124, 92, 255, .08), transparent 60%),
    radial-gradient(500px 320px at 92% 60%, rgba(34, 211, 238, .06), transparent 60%);
}
[data-theme="light"] .mk-hero::after { opacity: .4; background-image: linear-gradient(rgba(13, 25, 48, .07) 1px, transparent 1px), linear-gradient(90deg, rgba(13, 25, 48, .07) 1px, transparent 1px); }
[data-theme="light"] .mk-hero h1, [data-theme="light"] .mkp-hero h1 { background: linear-gradient(96deg, #0e1524 30%, #24437c 66%, #5b3fc4 95%); -webkit-background-clip: text; background-clip: text; }
[data-theme="light"] .mk-h2, [data-theme="light"] .mk-plat h3, [data-theme="light"] .mk-card h3, [data-theme="light"] .mk-gov h4,
[data-theme="light"] .mk-step-head b, [data-theme="light"] .mk-level-head, [data-theme="light"] .mk-price-big,
[data-theme="light"] .mk-askbox-id b, [data-theme="light"] .mk-form-card h3, [data-theme="light"] .mk-thanks b,
[data-theme="light"] .mkp-stat b, [data-theme="light"] .mkp-faq summary, [data-theme="light"] .slpop-name { color: var(--ink); }
[data-theme="light"] .mk-frame { background: rgba(255, 255, 255, .96); border-color: rgba(13, 25, 48, .14); box-shadow: 0 40px 90px rgba(16, 24, 40, .18), inset 0 1px 0 rgba(255, 255, 255, .8); }
[data-theme="light"] .mk-frame-bar { background: rgba(13, 25, 48, .03); }
[data-theme="light"] .mk-frame-kpis div { background: rgba(13, 25, 48, .025); }
[data-theme="light"] .mk-frame-feed { background: rgba(13, 25, 48, .02); }
[data-theme="light"] .mk-hero-visual::before { background: radial-gradient(60% 60% at 50% 55%, rgba(59, 130, 246, .16), transparent 70%); }
[data-theme="light"] .mk-marquee { background: rgba(13, 25, 48, .025); }
[data-theme="light"] .mk-band-alt { background: rgba(13, 25, 48, .025); }
[data-theme="light"] .mk-step-n { background: rgba(37, 99, 235, .1); color: #1d4ed8; }
[data-theme="light"] .mk-nta-card, [data-theme="light"] .mk-askbox, [data-theme="light"] .mk-form-card { background: #ffffff; border-color: rgba(13, 25, 48, .14); box-shadow: 0 24px 60px rgba(16, 24, 40, .14); }
[data-theme="light"] .mk-nta-time { background: rgba(13, 25, 48, .06); }
[data-theme="light"] .mk-nta-draft { background: rgba(37, 99, 235, .06); }
[data-theme="light"] .mk-nta-draft p { color: var(--ink); }
[data-theme="light"] .mk-nta-edit { background: #fff; }
[data-theme="light"] .mk-askbox-head { background: rgba(13, 25, 48, .02); }
[data-theme="light"] .mk-msg.agent { background: rgba(13, 25, 48, .05); color: var(--ink); }
[data-theme="light"] .mk-ask-chip { background: #fff; }
[data-theme="light"] .mk-ask-chip:hover { color: #1d4ed8; }
[data-theme="light"] .mk-ask-form, [data-theme="light"] .mk-chat-form { background: rgba(13, 25, 48, .02); }
[data-theme="light"] .mk-ask-form input, [data-theme="light"] .mk-chat-form input, [data-theme="light"] .mk-form-card input, [data-theme="light"] .mk-form-card select { background: #fff; color: var(--ink); }
[data-theme="light"] .mk-form-card select option { background: #fff; }
[data-theme="light"] .mk-chat-panel { background: rgba(255, 255, 255, .99); }
[data-theme="light"] .mk-chat-msgs .mk-msg.agent { background: rgba(13, 25, 48, .05); }
[data-theme="light"] .mk-checks li:hover { color: var(--ink); }
[data-theme="light"] .mk-gov { background: rgba(13, 25, 48, .03); }
[data-theme="light"] .mk-gov:hover { background: rgba(37, 99, 235, .06); }
[data-theme="light"] .mk-mq-item { color: var(--mut); }
/* the governance band + footer intentionally stay dark in light mode (designed contrast) */
[data-theme="light"] .mk-dark { background: radial-gradient(900px 460px at 80% -10%, rgba(59, 130, 246, .16), transparent 60%), #0b1120; }
[data-theme="light"] .mk-dark .mk-h2 { color: #fff; }
[data-theme="light"] .mk-dark .mk-lead, [data-theme="light"] .mk-dark .mk-checks li { color: #c3cddf; }
[data-theme="light"] .mk-dark .mk-gov { background: rgba(255, 255, 255, .04); }
[data-theme="light"] .mk-dark .mk-gov h4 { color: #fff; }
[data-theme="light"] .mk-dark .mk-gov p { color: #8b98ad; }
[data-theme="light"] .mkp-cta .mk-btn-line { background: transparent; color: #fff; border-color: rgba(255, 255, 255, .35); }
[data-theme="light"] .mkp-hero::before { background: radial-gradient(640px 340px at 80% 0%, rgba(59, 130, 246, .1), transparent 62%), radial-gradient(480px 300px at 10% 10%, rgba(124, 92, 255, .07), transparent 60%); }

/* theme toggle button (marketing nav) */
.mk-theme {
  display: inline-flex; align-items: center; justify-content: center; width: 38px; height: 38px;
  border-radius: 10px; border: 1px solid var(--line); background: transparent; color: var(--ink2); cursor: pointer;
  transition: background .15s ease, color .15s ease, border-color .15s ease;
}
.mk-theme:hover { color: var(--ink); background: rgba(154, 170, 196, .1); border-color: rgba(154, 170, 196, .35); }
body.mk {
  font: 16px/1.6 'InterVar', -apple-system, "Segoe UI", Roboto, Inter, sans-serif;
  color: var(--ink); background: var(--bg);
  -webkit-font-smoothing: antialiased; scroll-behavior: smooth; overflow-x: hidden;
}
body.mk ::selection { background: rgba(96,165,250,.32); color: #fff; }
.mk-wrap { max-width: 1160px; margin: 0 auto; padding: 0 22px; }
a { color: inherit; text-decoration: none; }
h1, h2, h3, h4 { font-family: var(--display); }

/* scroll progress bar */
#mkprog { position: fixed; top: 0; left: 0; right: 0; height: 2.5px; z-index: 90; background: var(--grad-wide); box-shadow: 0 0 14px rgba(96,165,250,.65); transform: scaleX(0); transform-origin: 0 50%; transition: transform .08s linear; }

/* nav */
.mk-nav { position: sticky; top: 0; z-index: 60; background: rgba(5, 7, 13, .7); backdrop-filter: blur(18px) saturate(1.4); -webkit-backdrop-filter: blur(18px) saturate(1.4); border-bottom: 1px solid transparent; transition: box-shadow .25s ease, border-color .25s ease, background .25s ease; }
.mk-nav.scrolled { border-bottom-color: var(--line-2); box-shadow: 0 10px 34px rgba(0,0,0,.45); background: rgba(5, 7, 13, .86); }
.mk-nav-in { display: flex; align-items: center; gap: 26px; height: 66px; transition: height .25s ease; }
.mk-nav.scrolled .mk-nav-in { height: 58px; }
.mk-logo { display: flex; align-items: center; gap: 9px; font-size: 19px; font-weight: 500; font-family: var(--display); transition: transform .2s var(--ease); }
.mk-logo:hover { transform: scale(1.03); }
.mk-logo svg { filter: drop-shadow(0 0 8px rgba(96,165,250,.55)); }
.mk-logo b { font-weight: 700; background: var(--grad-wide); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
.mk-menu { display: flex; align-items: center; gap: 4px; flex: 1; }
.mk-item { position: relative; }
.mk-item-btn { display: flex; align-items: center; gap: 5px; background: none; border: 0; font: inherit; font-weight: 600; font-size: 14.5px; color: var(--ink2); padding: 9px 12px; border-radius: 9px; cursor: pointer; transition: background .15s ease, color .15s ease; }
.mk-item-btn svg { transition: transform .2s var(--ease); opacity: .6; }
.mk-item.open .mk-item-btn svg { transform: rotate(180deg); }
.mk-item.open .mk-item-btn { background: rgba(255,255,255,.06); color: #fff; }
.mk-item-link { font-weight: 600; font-size: 14.5px; color: var(--ink2); padding: 9px 12px; border-radius: 9px; transition: background .15s ease, color .15s ease; }
.mk-item-btn:hover, .mk-item-link:hover { background: rgba(255,255,255,.06); color: #fff; }
.mk-drop { position: absolute; left: 0; top: calc(100% + 8px); background: rgba(13, 19, 34, .97); border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 30px 70px rgba(0,0,0,.6); backdrop-filter: blur(22px); -webkit-backdrop-filter: blur(22px); padding: 10px; display: none; max-width: calc(100vw - 32px); }
.mk-drop::before { content: ''; position: absolute; left: 0; right: 0; top: -9px; height: 9px; }
.mk-item-end .mk-drop { left: auto; right: 0; }
.mk-item.open .mk-drop { display: block; animation: mkDropIn .2s var(--ease); }
.mk-drop-grid { display: grid; grid-template-columns: repeat(2, 280px); gap: 2px; }
.mk-drop-grid a { display: flex; flex-direction: column; gap: 1px; padding: 9px 11px; border-radius: 10px; transition: background .14s ease, transform .14s ease; }
.mk-drop-grid a:hover, .mk-drop-grid a:focus-visible { background: rgba(96,165,250,.1); transform: translateX(3px); }
.mk-drop-grid b { font-size: 13.5px; color: var(--ink); }
.mk-drop-grid span { font-size: 12px; color: var(--mut); }
.mk-drop-all { display: block; margin: 8px 3px 1px; padding: 9px 11px; border-top: 1px solid var(--line-2); font-size: 12.5px; font-weight: 700; color: var(--sky-ink); }
.mk-drop-all:hover { background: rgba(96,165,250,.08); border-radius: 0 0 10px 10px; }
.mk-nav-cta { display: flex; gap: 9px; align-items: center; }

/* burger + mobile menu */
.mk-burger { display: none; flex-direction: column; justify-content: center; gap: 5px; width: 42px; height: 42px; padding: 10px; background: none; border: 0; border-radius: 10px; cursor: pointer; }
.mk-burger span { display: block; height: 2.4px; border-radius: 2px; background: var(--ink); transition: transform .22s var(--ease), opacity .18s ease; }
.mk-burger.active span:nth-child(1) { transform: translateY(7.4px) rotate(45deg); }
.mk-burger.active span:nth-child(2) { opacity: 0; }
.mk-burger.active span:nth-child(3) { transform: translateY(-7.4px) rotate(-45deg); }
.mk-mobile { display: none; position: fixed; inset: 0; z-index: 59; background: rgba(5,7,13,.98); overflow-y: auto; }
.mk-mobile.open { display: block; animation: mkFade .18s ease; }
body.mk-mm-open { overflow: hidden; }
.mk-mm-in { padding: 78px 22px 40px; }
.mk-mm-group { border-bottom: 1px solid var(--line-2); }
.mk-mm-group summary { display: flex; align-items: center; justify-content: space-between; padding: 15px 2px; font-weight: 700; font-size: 16px; cursor: pointer; list-style: none; }
.mk-mm-group summary::-webkit-details-marker { display: none; }
.mk-mm-group[open] summary svg { transform: rotate(180deg); }
.mk-mm-group summary svg { transition: transform .2s var(--ease); color: var(--mut); }
.mk-mm-links { display: grid; padding: 0 2px 14px; }
.mk-mm-links a { padding: 8px 10px; font-size: 14.5px; color: var(--ink2); border-radius: 8px; }
.mk-mm-links a:hover { background: rgba(255,255,255,.06); color: #fff; }
.mk-mm-links .mk-mm-all { font-weight: 700; color: var(--sky-ink); }
.mk-mm-link { display: block; padding: 15px 2px; font-weight: 700; font-size: 16px; border-bottom: 1px solid var(--line-2); }
.mk-mm-cta { display: grid; gap: 10px; padding: 20px 2px 0; }

/* buttons */
.mk-btn { position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 7px; font-weight: 700; font-size: 14.5px; border-radius: 11px; padding: 10px 17px; border: 0; cursor: pointer; overflow: hidden; transition: transform .18s var(--ease), box-shadow .18s var(--ease), background .18s ease, border-color .18s ease, color .18s ease; }
.mk-btn-lg { padding: 13px 24px; font-size: 15.5px; border-radius: 13px; }
.mk-btn-solid { background: var(--grad); color: #fff; box-shadow: 0 5px 18px rgba(37,99,235,.3), inset 0 1px 0 rgba(255,255,255,.18); }
.mk-btn-solid::after { content: ''; position: absolute; top: 0; left: -60%; width: 40%; height: 100%; background: linear-gradient(100deg, transparent, rgba(255,255,255,.35), transparent); transform: skewX(-20deg); transition: left .55s var(--ease); }
.mk-btn-solid:hover { transform: translateY(-2px); box-shadow: 0 12px 30px rgba(79,70,229,.4), inset 0 1px 0 rgba(255,255,255,.18); filter: brightness(1.08); }
.mk-btn-solid:hover::after { left: 120%; }
.mk-btn-solid:active { transform: translateY(0); }
.mk-btn-line { border: 1.5px solid rgba(154,170,196,.3); color: var(--ink); background: rgba(255,255,255,.03); }
.mk-btn-line:hover { border-color: var(--sky); color: #fff; transform: translateY(-2px); box-shadow: 0 10px 28px rgba(59,130,246,.2); background: rgba(96,165,250,.08); }
.mk-btn-ghost { color: var(--ink2); background: transparent; }
.mk-btn-ghost:hover { color: #fff; background: rgba(255,255,255,.06); }

/* hero */
.mk-hero { position: relative; border-bottom: 1px solid var(--line-2); overflow: hidden; }
.mk-hero::before {
  content: ''; position: absolute; inset: -30% -10% auto -10%; height: 820px; pointer-events: none;
  background:
    radial-gradient(760px 420px at 72% 18%, rgba(37,99,235,.22), transparent 62%),
    radial-gradient(560px 360px at 14% 4%, rgba(79,70,229,.15), transparent 60%),
    radial-gradient(500px 320px at 92% 60%, rgba(56,189,248,.08), transparent 60%);
  animation: mkDrift 16s ease-in-out infinite alternate;
}
.mk-hero::after {
  content: ''; position: absolute; inset: 0; pointer-events: none; opacity: .55;
  background-image: linear-gradient(rgba(154,170,196,.08) 1px, transparent 1px), linear-gradient(90deg, rgba(154,170,196,.08) 1px, transparent 1px);
  background-size: 56px 56px;
  mask-image: radial-gradient(900px 480px at 60% -10%, #000 20%, transparent 78%);
  -webkit-mask-image: radial-gradient(900px 480px at 60% -10%, #000 20%, transparent 78%);
}
.mk-hero-in { position: relative; z-index: 1; display: grid; grid-template-columns: 1.02fr .98fr; gap: 48px; align-items: center; padding: 84px 22px 92px; }
.mk-kicker { display: inline-flex; align-items: center; gap: 8px; font-size: 11.5px; font-weight: 700; letter-spacing: 1.4px; text-transform: uppercase; color: var(--sky-ink); background: rgba(96,165,250,.1); border: 1px solid rgba(96,165,250,.28); padding: 6px 13px; border-radius: 99px; margin-bottom: 20px; animation: mkKicker 3.2s ease-in-out infinite; }
.mk-hero h1 {
  font-size: clamp(40px, 5.4vw, 66px); line-height: 1.02; letter-spacing: -.03em; font-weight: 700;
  background: linear-gradient(96deg, #fff 32%, #c7d8f8 68%, #93b4f0 100%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
}
.mk-sub { font-size: 18.5px; color: var(--ink2); margin: 20px 0 28px; max-width: 30em; }
.mk-cta-row { display: flex; gap: 12px; flex-wrap: wrap; }
.mk-hero-note { margin-top: 18px; font-size: 13.5px; color: var(--mut); }

/* hero product mock */
.mk-hero-visual { perspective: 1100px; animation: mkFloat 7s ease-in-out infinite; position: relative; }
.mk-hero-visual::before { content: ''; position: absolute; inset: 8% -6% -10% -6%; background: radial-gradient(60% 60% at 50% 55%, rgba(59,130,246,.3), transparent 70%); filter: blur(30px); pointer-events: none; }
.mk-frame { position: relative; background: rgba(13, 19, 34, .92); border: 1px solid rgba(154,170,196,.2); border-radius: 18px; box-shadow: 0 50px 110px rgba(0,0,0,.65), inset 0 1px 0 rgba(255,255,255,.08); overflow: hidden; transform: translateY(var(--pz, 0px)) rotateY(var(--tx,0deg)) rotateX(var(--ty,0deg)); transition: transform .3s var(--ease); backdrop-filter: blur(10px); }
.mk-frame-bar { display: flex; gap: 6px; padding: 12px 14px; border-bottom: 1px solid var(--line-2); background: rgba(255,255,255,.02); }
.mk-frame-bar span { width: 10px; height: 10px; border-radius: 99px; background: rgba(154,170,196,.25); }
.mk-frame-bar span:first-child { background: #f87171aa; }
.mk-frame-bar span:nth-child(2) { background: #fbbf24aa; }
.mk-frame-bar span:nth-child(3) { background: #34d399aa; }
.mk-frame-kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; padding: 14px; }
.mk-frame-kpis div { border: 1px solid var(--line); border-radius: 11px; padding: 10px 12px; background: rgba(255,255,255,.025); transition: transform .2s var(--ease), box-shadow .2s var(--ease), border-color .2s ease; }
.mk-frame-kpis div:hover { transform: translateY(-3px); box-shadow: 0 10px 26px rgba(59,130,246,.22); border-color: rgba(96,165,250,.45); }
.mk-frame-kpis b { display: block; font-size: 19px; letter-spacing: -.4px; color: #fff; font-family: var(--display); font-weight: 700; }
.mk-frame-kpis div:nth-child(1) b { color: #34d399; text-shadow: 0 0 18px rgba(52,211,153,.4); }
.mk-frame-kpis div:nth-child(2) b { color: #60a5fa; text-shadow: 0 0 18px rgba(96,165,250,.4); }
.mk-frame-kpis div:nth-child(3) b { color: #a78bfa; text-shadow: 0 0 18px rgba(167,139,250,.4); }
.mk-frame-kpis div:nth-child(4) b { color: #22d3ee; text-shadow: 0 0 18px rgba(34,211,238,.4); }
.mk-frame-kpis i { font-style: normal; font-size: 11px; color: var(--mut); }
.mk-frame-chart { display: flex; align-items: flex-end; gap: 7px; height: 110px; padding: 4px 16px 12px; }
.mk-frame-chart i { flex: 1; background: linear-gradient(180deg, #60a5fa, #3b82f6 60%, #2b57b8); border-radius: 5px 5px 2px 2px; min-height: 12%; transform: scaleY(0); transform-origin: bottom; transition: transform .7s var(--ease); box-shadow: 0 0 14px rgba(59,130,246,.25); }
.mk-frame-chart i.grown { transform: scaleY(1); }
.mk-frame-chart i:last-child { background: linear-gradient(180deg, #22d3ee, #3b82f6); box-shadow: 0 0 20px rgba(34,211,238,.45); }
.mk-frame-aihead { display: flex; align-items: center; justify-content: space-between; padding: 9px 16px; border-top: 1px solid var(--line-2); background: rgba(37,99,235,.06); }
.mk-frame-aihead span { font-size: 10.5px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; color: var(--sky-ink); }
.mk-frame-aihead span::before { content: '✦ '; }
.mk-frame-aihead i { font-style: normal; font-size: 11px; font-weight: 700; color: #fcd34d; background: rgba(251,191,36,.1); border: 1px solid rgba(251,191,36,.3); border-radius: 99px; padding: 2px 9px; }
[data-theme="light"] .mk-frame-aihead i { color: #b45309; background: rgba(180,83,9,.08); border-color: rgba(180,83,9,.3); }
.mk-frame-feed { border-top: 1px solid var(--line-2); padding: 11px 16px 14px; display: grid; gap: 7px; font-size: 12.5px; color: var(--ink2); background: rgba(255,255,255,.015); }
.mk-frame-feed div { position: relative; padding-left: 14px; }
.mk-frame-feed div::before { content: ''; position: absolute; left: 0; top: 7px; width: 6px; height: 6px; border-radius: 99px; background: #34d399; box-shadow: 0 0 0 0 rgba(52,211,153,.5); animation: mkPing 2.4s ease-out infinite; }
.mk-frame-feed div:nth-child(2)::before { animation-delay: .8s; }
.mk-frame-feed div:nth-child(3)::before { animation-delay: 1.6s; background: #fbbf24; }
.mk-frame-feed em { font-style: normal; font-weight: 700; color: var(--sky-ink); }

/* capability marquee */
.mk-marquee { position: relative; overflow: hidden; border-top: 1px solid var(--line-2); border-bottom: 1px solid var(--line-2); background: rgba(255,255,255,.015); padding: 13px 0; }
.mk-marquee::before, .mk-marquee::after { content: ''; position: absolute; top: 0; bottom: 0; width: 120px; z-index: 1; pointer-events: none; }
.mk-marquee::before { left: 0; background: linear-gradient(90deg, var(--bg), transparent); }
.mk-marquee::after { right: 0; background: linear-gradient(270deg, var(--bg), transparent); }
.mk-marquee-track { display: flex; gap: 34px; width: max-content; animation: mkMarquee 36s linear infinite; }
.mk-marquee:hover .mk-marquee-track { animation-play-state: paused; }
.mk-mq-item { display: inline-flex; align-items: center; gap: 9px; font-size: 13px; font-weight: 600; color: var(--mut); white-space: nowrap; }
.mk-mq-item::before { content: ''; width: 5px; height: 5px; border-radius: 99px; background: var(--grad-wide); box-shadow: 0 0 8px rgba(96,165,250,.7); }
@keyframes mkMarquee { to { transform: translateX(-50%); } }

/* sections */
.mk-band { position: relative; padding: 88px 0; }
.mk-band-alt { background: rgba(255,255,255,.018); border-top: 1px solid var(--line-2); border-bottom: 1px solid var(--line-2); }
.mk-h2 { font-size: clamp(28px, 3.4vw, 42px); letter-spacing: -.025em; line-height: 1.08; font-weight: 700; max-width: 22em; color: #fff; }
.mk-lead { font-size: 17px; color: var(--ink2); margin: 14px 0 36px; max-width: 42em; }
.mk-two { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.mk-plat { position: relative; border: 1px solid var(--line); background: var(--card-up), var(--card); border-radius: 18px; padding: 30px; overflow: hidden; transition: box-shadow .22s var(--ease), transform .22s var(--ease), border-color .22s ease; }
.mk-plat::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 2px; background: var(--grad-wide); transform: scaleX(0); transform-origin: 0 50%; transition: transform .3s var(--ease); }
.mk-plat:hover { box-shadow: 0 26px 60px rgba(0,0,0,.5); transform: translateY(-4px); border-color: rgba(96,165,250,.4); }
.mk-plat:hover::before { transform: scaleX(1); }
.mk-plat-tag { font-size: 11.5px; font-weight: 800; letter-spacing: 1.2px; text-transform: uppercase; color: var(--sky-ink); margin-bottom: 10px; }
.mk-plat h3 { font-size: 22px; letter-spacing: -.02em; margin-bottom: 8px; color: #fff; }
.mk-plat p { color: var(--ink2); font-size: 15px; }
.mk-more { display: inline-block; margin-top: 14px; font-weight: 700; color: var(--sky-ink); font-size: 14px; transition: transform .2s var(--ease); }
.mk-plat:hover .mk-more { transform: translateX(5px); }

/* first-week steps */
.mk-steps { display: grid; gap: 12px; max-width: 860px; }
.mk-step { display: flex; gap: 18px; background: var(--card-up), var(--card); border: 1px solid var(--line); border-radius: 15px; padding: 18px 20px; transition: transform .18s var(--ease), box-shadow .18s var(--ease), border-color .18s ease; }
.mk-step:hover { transform: translateX(6px); box-shadow: 0 16px 40px rgba(0,0,0,.45); border-color: rgba(96,165,250,.4); }
.mk-step-n { flex: none; width: 34px; height: 34px; border-radius: 11px; background: rgba(96,165,250,.13); color: var(--sky-ink); font-weight: 800; font-family: var(--display); display: flex; align-items: center; justify-content: center; transition: background .2s ease, color .2s ease, transform .2s var(--ease), box-shadow .2s ease; }
.mk-step:hover .mk-step-n { background: var(--grad); color: #fff; transform: scale(1.08); box-shadow: 0 6px 18px rgba(59,130,246,.45); }
.mk-step-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; }
.mk-step-head b { font-size: 16.5px; color: #fff; }
.mk-step-tag { font-size: 11.5px; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; color: var(--mut); }
.mk-step p { color: var(--ink2); font-size: 14.5px; }

/* never-used-AI example card */
.mk-nta-card { position: relative; background: rgba(13,19,34,.95); border: 1px solid rgba(154,170,196,.22); border-radius: 20px; box-shadow: 0 34px 80px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.07); padding: 22px; display: grid; gap: 14px; }
.mk-nta-card::before { content: ''; position: absolute; inset: -1px; border-radius: 20px; padding: 1px; background: linear-gradient(135deg, rgba(96,165,250,.5), transparent 40%, transparent 65%, rgba(139,92,246,.4)); -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); -webkit-mask-composite: xor; mask-composite: exclude; pointer-events: none; }
.mk-nta-row { font-size: 14px; color: var(--ink2); }
.mk-nta-row i { color: #fff; font-style: normal; font-weight: 600; }
.mk-nta-time { display: inline-block; font-size: 11px; font-weight: 800; letter-spacing: .8px; color: var(--mut); background: rgba(255,255,255,.06); border-radius: 99px; padding: 2px 9px; margin-right: 6px; }
.mk-nta-draft { border: 1.5px solid rgba(96,165,250,.4); background: rgba(59,130,246,.08); border-radius: 14px; padding: 15px 16px; }
.mk-nta-draft-tag { font-size: 11px; font-weight: 800; letter-spacing: .9px; text-transform: uppercase; color: var(--sky-ink); margin-bottom: 7px; }
.mk-nta-draft p { font-size: 14px; color: var(--ink); }
.mk-nta-actions { display: flex; gap: 8px; margin-top: 12px; }
.mk-nta-actions span { font-size: 12.5px; font-weight: 700; border-radius: 9px; padding: 6px 12px; }
.mk-nta-ok { background: var(--grad); color: #fff; box-shadow: 0 6px 18px rgba(59,130,246,.4); }
.mk-nta-edit { border: 1.4px solid rgba(154,170,196,.3); color: var(--ink2); background: rgba(255,255,255,.03); }
.mk-nta-skip { color: var(--mut); }
.mk-nta-note { font-size: 12.5px; color: var(--mut); border-top: 1px dashed var(--line); padding-top: 12px; }

/* automation levels */
.mk-levels { position: relative; display: grid; gap: 12px; max-width: 860px; }
.mk-levels::before { content: ''; position: absolute; left: 27px; top: 18px; bottom: 18px; width: 2px; background: linear-gradient(180deg, #22d3ee, #3b82f6, rgba(139,92,246,.2)); box-shadow: 0 0 12px rgba(59,130,246,.4); transform: scaleY(0); transform-origin: top; transition: transform .9s var(--ease) .15s; }
.vis .mk-levels::before { transform: scaleY(1); }
.mk-level { position: relative; display: flex; gap: 18px; background: var(--card-up), var(--card); border: 1px solid var(--line); border-radius: 15px; padding: 17px 20px; transition: transform .18s var(--ease), box-shadow .18s var(--ease), border-color .18s ease; }
.mk-level:hover { transform: translateX(6px); box-shadow: 0 16px 40px rgba(0,0,0,.45); border-color: rgba(96,165,250,.4); }
.mk-level-cube { flex: none; width: 30px; transition: transform .3s var(--ease); filter: drop-shadow(0 0 10px rgba(96,165,250,.3)); }
.mk-level:hover .mk-level-cube { transform: rotate(-8deg) scale(1.12); }
.mk-level-head { font-size: 15.5px; margin-bottom: 3px; color: #fff; }
.mk-level-head b { color: var(--sky-ink); }
.mk-level p { color: var(--ink2); font-size: 14.5px; }

/* cards */
.mk-grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.mk-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.mk-card { position: relative; border: 1px solid var(--line); background: var(--card-up), var(--card); border-radius: 16px; padding: 24px; overflow: hidden; transition: transform .2s var(--ease), box-shadow .2s var(--ease), border-color .2s ease; }
.mk-card::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: var(--grad-wide); transform: scaleY(0); transform-origin: 50% 0; transition: transform .28s var(--ease); }
.mk-card:hover { transform: translateY(-4px); box-shadow: 0 20px 48px rgba(0,0,0,.5); border-color: rgba(96,165,250,.35); }
.mk-card:hover::before { transform: scaleY(1); }
.mk-card h3 { font-size: 17px; margin-bottom: 7px; color: #fff; }
.mk-card p { color: var(--ink2); font-size: 14.5px; }
.mk-card .mk-more { margin-top: 10px; }
.mk-inline-cta { margin-top: 28px; }

/* governance (the "control" band) */
.mk-dark { position: relative; background: radial-gradient(900px 460px at 80% -10%, rgba(59,130,246,.16), transparent 60%), radial-gradient(700px 400px at 6% 110%, rgba(139,92,246,.13), transparent 60%), rgba(255,255,255,.015); color: var(--ink); overflow: hidden; border-top: 1px solid var(--line-2); border-bottom: 1px solid var(--line-2); }
.mk-dark .mk-wrap { position: relative; }
.mk-dark .mk-h2 { color: #fff; }
.mk-dark .mk-lead { color: var(--ink2); }
.mk-checks { display: grid; grid-template-columns: repeat(2, minmax(240px, 1fr)); gap: 9px 26px; list-style: none; padding: 0; margin: 0 0 34px; max-width: 780px; }
.mk-checks li { padding-left: 28px; position: relative; font-size: 15px; color: var(--ink2); transition: color .18s ease, transform .18s var(--ease); }
.mk-checks li:hover { color: #fff; transform: translateX(3px); }
.mk-checks li::before { content: '✓'; position: absolute; left: 0; top: 0; width: 19px; height: 19px; border-radius: 99px; background: rgba(96,165,250,.16); color: var(--sky-ink); font-size: 12px; font-weight: 800; display: flex; align-items: center; justify-content: center; transition: background .18s ease, color .18s ease, box-shadow .18s ease; }
.mk-checks li:hover::before { background: var(--grad); color: #fff; box-shadow: 0 0 14px rgba(59,130,246,.5); }
.mk-grid5 { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
.mk-gov { border: 1px solid var(--line); border-radius: 13px; padding: 16px; background: rgba(255,255,255,.025); transition: transform .2s var(--ease), background .2s ease, border-color .2s ease, box-shadow .2s ease; }
.mk-gov:hover { transform: translateY(-4px); background: rgba(96,165,250,.07); border-color: rgba(96,165,250,.45); box-shadow: 0 14px 34px rgba(0,0,0,.4); }
.mk-gov h4 { font-size: 14px; margin-bottom: 6px; color: #fff; }
.mk-gov p { font-size: 12.5px; color: var(--mut); }

/* pricing */
.mk-price-row { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; max-width: 860px; }
.mk-price { position: relative; background: var(--card-up), var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 28px; overflow: hidden; transition: transform .2s var(--ease), box-shadow .2s var(--ease), border-color .2s ease; }
.mk-price:first-child { border-color: rgba(96,165,250,.45); box-shadow: 0 16px 50px rgba(59,130,246,.16); }
.mk-price:first-child::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 2px; background: var(--grad-wide); box-shadow: 0 0 16px rgba(96,165,250,.6); }
.mk-price:hover { transform: translateY(-4px); box-shadow: 0 22px 54px rgba(0,0,0,.5); }
.mk-price-tag { font-size: 11.5px; font-weight: 800; letter-spacing: 1.2px; text-transform: uppercase; color: var(--sky-ink); margin-bottom: 8px; }
.mk-price-big { font-size: 42px; font-weight: 700; letter-spacing: -.03em; margin-bottom: 8px; font-family: var(--display); color: #fff; }
.mk-price-big span { font-size: 16px; font-weight: 600; color: var(--mut); font-family: 'InterVar', sans-serif; }
.mk-price p { color: var(--ink2); font-size: 14.5px; margin-bottom: 14px; }
@media (max-width: 980px) { .mk-price-row { grid-template-columns: 1fr; } }

/* walkthrough */
.mk-two-col { display: grid; grid-template-columns: 1.1fr .9fr; gap: 40px; align-items: start; }
.mk-form-card { background: rgba(13,19,34,.95); border: 1px solid var(--line); border-radius: 18px; padding: 26px; box-shadow: 0 26px 64px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.06); transition: box-shadow .25s var(--ease), border-color .25s ease; }
.mk-form-card:hover { box-shadow: 0 32px 76px rgba(0,0,0,.65), inset 0 1px 0 rgba(255,255,255,.06); border-color: rgba(96,165,250,.3); }
.mk-form-card h3 { margin-bottom: 14px; color: #fff; }
.mk-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
.mk-form-card label { display: flex; flex-direction: column; gap: 5px; font-size: 12.5px; font-weight: 700; color: var(--ink2); }
.mk-form-card input, .mk-form-card select { font: inherit; font-weight: 400; padding: 10px 12px; border: 1.4px solid rgba(154,170,196,.25); border-radius: 10px; background: rgba(5,7,13,.6); color: var(--ink); transition: border-color .16s ease, box-shadow .16s ease; }
.mk-form-card select option { background: #0d1322; }
.mk-form-card input:focus, .mk-form-card select:focus { outline: none; border-color: var(--sky); box-shadow: 0 0 0 3px rgba(96,165,250,.18); }
.mk-form-full { margin-bottom: 14px; }
.mk-thanks { font-size: 15.5px; color: var(--ink2); }
.mk-thanks b { color: #fff; }

/* footer */
.mk-foot { position: relative; background: #04060b; color: var(--mut); padding: 56px 0 26px; border-top: 1px solid var(--line-2); }
.mk-foot::before { content: ''; position: absolute; top: -1px; left: 0; right: 0; height: 1px; background: linear-gradient(90deg, transparent, rgba(96,165,250,.5), rgba(139,92,246,.5), transparent); }
.mk-foot-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 24px; padding-bottom: 32px; border-bottom: 1px solid var(--line-2); }
.mk-foot-head { font-size: 12px; font-weight: 800; letter-spacing: 1.1px; text-transform: uppercase; color: var(--ink); margin-bottom: 12px; }
.mk-foot-grid a { display: block; font-size: 13px; padding: 3.5px 0; color: var(--mut); transition: color .15s ease, transform .15s var(--ease); }
.mk-foot-grid a:hover { color: #fff; transform: translateX(3px); }
.mk-foot-base { display: flex; justify-content: space-between; gap: 14px; flex-wrap: wrap; padding-top: 20px; font-size: 13px; align-items: center; }

/* reveal + stagger — pronounced scroll choreography */
.mk-reveal { opacity: 0; transform: translateY(48px) scale(.985); filter: blur(8px); transition: opacity .95s var(--ease), transform .95s var(--ease), filter .95s var(--ease); }
.mk-reveal.vis { opacity: 1; transform: none; filter: none; }
.mk-stag { opacity: 0; transform: translateY(42px) scale(.96); filter: blur(6px); transition: opacity .8s var(--ease), transform .8s var(--ease), filter .8s var(--ease); }
.vis .mk-stag, .mk-stag.vis { opacity: 1; transform: none; filter: none; }
/* directional variety: paired grids slide in from opposite sides, steps sweep from the left */
.mk-ask-grid > .mk-stag:first-child, .mk-two > .mk-stag:first-child { transform: translateX(-46px) scale(.98); }
.mk-ask-grid > .mk-stag:last-child, .mk-two > .mk-stag:last-child { transform: translateX(46px) scale(.98); }
.mk-steps > .mk-stag { transform: translateX(-52px); }
.mk-price-row > .mk-stag:first-child { transform: translateX(-40px) scale(.97); }
.mk-price-row > .mk-stag:last-child { transform: translateX(40px) scale(.97); }
/* headline underline sweeps in as its section reveals */
.mk-h2 { position: relative; padding-bottom: 16px; }
.mk-h2::after { content: ''; position: absolute; left: 2px; bottom: 0; width: 68px; height: 3px; border-radius: 99px; background: var(--grad-wide); box-shadow: 0 0 16px rgba(96, 165, 250, .55); transform: scaleX(0); transform-origin: 0 50%; transition: transform .8s var(--ease) .3s; }
.mk-reveal.vis .mk-h2::after, .vis .mk-h2::after { transform: scaleX(1); }

/* ask stayleased section */
.mk-kicker-ai { display: inline-flex; align-items: center; gap: 7px; }
.mk-ask-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 44px; align-items: center; }
.mk-ask-copy .mk-h2 { margin-bottom: 0; }
.mk-ask-points { list-style: none; padding: 0; margin: 18px 0 24px; display: grid; gap: 9px; }
.mk-ask-points li { position: relative; padding-left: 26px; font-size: 14.5px; color: var(--ink2); }
.mk-ask-points li::before { content: ''; position: absolute; left: 0; top: 6px; width: 15px; height: 15px; border-radius: 99px; background: rgba(96,165,250,.16); }
.mk-ask-points li::after { content: ''; position: absolute; left: 5px; top: 11px; width: 5px; height: 5px; border-radius: 99px; background: var(--sky); box-shadow: 0 0 8px rgba(96,165,250,.8); }
.mk-askbox { background: rgba(13,19,34,.95); border: 1px solid rgba(154,170,196,.22); border-radius: 20px; box-shadow: 0 34px 80px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.07); overflow: hidden; display: flex; flex-direction: column; min-height: 420px; }
.mk-askbox-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; background: rgba(255,255,255,.02); border-bottom: 1px solid var(--line-2); }
.mk-askbox-id { display: flex; align-items: center; gap: 10px; }
.mk-askbox-av { width: 34px; height: 34px; border-radius: 11px; background: var(--grad); color: #fff; font-size: 12px; font-weight: 800; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 14px rgba(59,130,246,.4); }
.mk-askbox-id b { font-size: 14px; display: block; color: #fff; }
.mk-askbox-id span { font-size: 11.5px; color: var(--mut); }
.mk-live { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 800; letter-spacing: .8px; color: #6ee7b7; background: rgba(52,211,153,.12); border: 1px solid rgba(52,211,153,.3); border-radius: 99px; padding: 3px 9px; }
.mk-live i { width: 7px; height: 7px; border-radius: 99px; background: #34d399; box-shadow: 0 0 10px rgba(52,211,153,.8); animation: mkPulse 1.8s ease-in-out infinite; }
.mk-ask-msgs, .mk-chat-msgs { flex: 1; padding: 16px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
.mk-ask-msgs { min-height: 210px; max-height: 300px; }
.mk-msg { max-width: 85%; padding: 10px 13px; border-radius: 14px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; animation: mkMsgIn .3s var(--ease); }
.mk-msg.you { align-self: flex-end; background: var(--grad); color: #fff; border-bottom-right-radius: 5px; box-shadow: 0 4px 16px rgba(59,130,246,.3); }
.mk-msg.agent { align-self: flex-start; background: rgba(255,255,255,.045); color: var(--ink); border-bottom-left-radius: 5px; border: 1px solid var(--line-2); }
.mk-typing { display: inline-flex; gap: 4px; padding: 2px 0; }
.mk-typing i { width: 6px; height: 6px; border-radius: 99px; background: var(--mut); animation: mkBlink 1.2s infinite ease-in-out; }
.mk-typing i:nth-child(2) { animation-delay: .18s; }
.mk-typing i:nth-child(3) { animation-delay: .36s; }
.mk-ask-chips, .mk-chat-chips { display: flex; flex-wrap: wrap; gap: 7px; padding: 0 16px 12px; }
.mk-ask-chip.active { border-color: transparent; background: var(--grad); color: #fff; box-shadow: 0 6px 18px rgba(59,130,246,.4); }
.mk-ask-chip { font: inherit; font-size: 12.5px; font-weight: 600; color: var(--ink2); background: rgba(255,255,255,.03); border: 1px solid rgba(154,170,196,.25); border-radius: 99px; padding: 6px 12px; cursor: pointer; transition: border-color .15s ease, color .15s ease, background .15s ease, transform .15s var(--ease); }
.mk-ask-chip:hover { border-color: var(--sky); color: #fff; background: rgba(96,165,250,.1); transform: translateY(-1px); }
.mk-ask-form, .mk-chat-form { display: flex; gap: 8px; padding: 12px 14px; border-top: 1px solid var(--line-2); background: rgba(255,255,255,.015); }
.mk-ask-form input, .mk-chat-form input { flex: 1; font: inherit; font-size: 14px; padding: 10px 13px; border: 1.4px solid rgba(154,170,196,.25); border-radius: 11px; background: rgba(5,7,13,.6); color: var(--ink); }
.mk-ask-form input::placeholder, .mk-chat-form input::placeholder { color: var(--faint); }
.mk-ask-form input:focus, .mk-chat-form input:focus { outline: none; border-color: var(--sky); box-shadow: 0 0 0 3px rgba(96,165,250,.18); }
.mk-ask-form button, .mk-chat-form button { flex: none; width: 42px; border: 0; border-radius: 11px; background: var(--grad); color: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 14px rgba(59,130,246,.35); transition: filter .16s ease, transform .16s var(--ease); }
.mk-ask-form button:hover, .mk-chat-form button:hover { filter: brightness(1.1); transform: translateY(-1px); }

/* floating chat widget */
.mk-chat { position: fixed; right: 22px; bottom: 22px; z-index: 80; }
.mk-chat-launch { display: inline-flex; align-items: center; gap: 9px; font: inherit; font-weight: 700; font-size: 14.5px; color: #fff; background: var(--grad); border: 0; border-radius: 99px; padding: 12px 18px 12px 15px; cursor: pointer; box-shadow: 0 14px 38px rgba(59,130,246,.5); transition: transform .2s var(--ease), box-shadow .2s var(--ease), filter .2s ease; }
.mk-chat-launch:hover { transform: translateY(-2px); box-shadow: 0 18px 46px rgba(99,102,241,.6); filter: brightness(1.07); }
.mk-chat.open .mk-chat-launch { transform: scale(.9); opacity: 0; pointer-events: none; }
.mk-chat-panel { position: absolute; right: 0; bottom: 0; width: min(380px, calc(100vw - 32px)); height: min(560px, calc(100vh - 110px)); background: rgba(13,19,34,.98); border: 1px solid rgba(154,170,196,.25); border-radius: 20px; box-shadow: 0 40px 90px rgba(0,0,0,.7); backdrop-filter: blur(20px); display: flex; flex-direction: column; overflow: hidden; opacity: 0; transform: translateY(20px) scale(.96); transform-origin: bottom right; pointer-events: none; transition: opacity .24s var(--ease), transform .24s var(--ease); }
.mk-chat.open .mk-chat-panel { opacity: 1; transform: none; pointer-events: auto; }
.mk-chat-head { display: flex; align-items: center; justify-content: space-between; padding: 13px 15px; background: var(--grad); color: #fff; }
.mk-chat-id { display: flex; align-items: center; gap: 10px; }
.mk-chat-av { width: 32px; height: 32px; border-radius: 10px; background: rgba(255,255,255,.2); color: #fff; font-size: 12px; font-weight: 800; display: flex; align-items: center; justify-content: center; }
.mk-chat-id b { font-size: 14px; display: block; }
.mk-chat-id span { font-size: 11px; opacity: .85; }
.mk-chat-close { background: rgba(255,255,255,.16); border: 0; color: #fff; width: 28px; height: 28px; border-radius: 8px; cursor: pointer; font-size: 14px; transition: background .15s ease; }
.mk-chat-close:hover { background: rgba(255,255,255,.28); }
.mk-chat-msgs { background: transparent; }
.mk-chat-chips { padding-top: 10px; background: transparent; }
body.mk-chat-open #mktop { opacity: 0; pointer-events: none; }

/* ---------- feature pages ---------- */
.mkp-hero { position: relative; border-bottom: 1px solid var(--line-2); overflow: hidden; }
.mkp-hero::before { content: ''; position: absolute; inset: -30% -10% auto -10%; height: 560px; background: radial-gradient(640px 340px at 80% 0%, rgba(59,130,246,.22), transparent 62%), radial-gradient(480px 300px at 10% 10%, rgba(124,92,255,.14), transparent 60%); pointer-events: none; }
.mkp-hero-in { position: relative; display: grid; grid-template-columns: 1.08fr .92fr; gap: 44px; align-items: center; padding: 64px 22px 70px; }
.mkp-crumb { font-size: 12.5px; font-weight: 700; color: var(--mut); margin-bottom: 14px; }
.mkp-crumb a { color: var(--sky-ink); }
.mkp-crumb a:hover { text-decoration: underline; }
.mkp-hero h1 { font-size: clamp(32px, 4vw, 50px); line-height: 1.05; letter-spacing: -.025em; font-weight: 700; background: linear-gradient(96deg, #fff 36%, #c7d8f8 74%, #93b4f0); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
.mkp-sub { font-size: 17.5px; color: var(--ink2); margin: 16px 0 22px; max-width: 36em; }
.mkp-points { list-style: none; padding: 0; margin: 0 0 26px; display: grid; gap: 9px; }
.mkp-points li { position: relative; padding-left: 27px; font-size: 15px; color: var(--ink2); }
.mkp-points li::before { content: '✓'; position: absolute; left: 0; top: 2px; width: 18px; height: 18px; border-radius: 99px; background: rgba(96,165,250,.15); color: var(--sky-ink); font-size: 11px; font-weight: 800; display: flex; align-items: center; justify-content: center; }
.mkp-chip { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 700; border-radius: 99px; padding: 5px 12px; margin: 0 0 20px; }
.mkp-chip::before { content: ''; width: 7px; height: 7px; border-radius: 99px; background: currentColor; box-shadow: 0 0 8px currentColor; }
.mkp-chip.live { color: #6ee7b7; background: rgba(52,211,153,.1); border: 1px solid rgba(52,211,153,.3); }
.mkp-chip.soon { color: #fcd34d; background: rgba(251,191,36,.1); border: 1px solid rgba(251,191,36,.3); }
.mkp-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin: 34px 0 0; }
.mkp-stat { border: 1px solid var(--line); border-radius: 14px; background: var(--card-up), var(--card); padding: 16px 18px; transition: transform .2s var(--ease), box-shadow .2s var(--ease), border-color .2s ease; }
.mkp-stat:hover { transform: translateY(-3px); box-shadow: 0 14px 32px rgba(0,0,0,.4); border-color: rgba(96,165,250,.35); }
.mkp-stat b { display: block; font-size: 15.5px; margin-bottom: 3px; color: #fff; }
.mkp-stat span { font-size: 13.5px; color: var(--mut); }
.mkp-faq { max-width: 860px; display: grid; gap: 8px; }
.mkp-faq details { border: 1px solid var(--line); border-radius: 13px; background: var(--card); transition: border-color .2s ease; }
.mkp-faq summary { padding: 14px 18px; font-weight: 700; font-size: 15px; cursor: pointer; list-style: none; display: flex; justify-content: space-between; align-items: center; gap: 12px; color: var(--ink); }
.mkp-faq summary::-webkit-details-marker { display: none; }
.mkp-faq summary::after { content: '+'; font-size: 19px; font-weight: 600; color: var(--mut); transition: transform .2s var(--ease); }
.mkp-faq details[open] summary::after { transform: rotate(45deg); }
.mkp-faq details[open] { border-color: rgba(96,165,250,.45); }
.mkp-faq .mkp-a { padding: 0 18px 15px; color: var(--ink2); font-size: 14.5px; max-width: 52em; }
.mkp-related { display: flex; flex-wrap: wrap; gap: 10px; }
.mkp-related a { display: inline-flex; align-items: center; gap: 7px; border: 1px solid rgba(154,170,196,.25); background: rgba(255,255,255,.03); border-radius: 99px; padding: 8px 15px; font-size: 13.5px; font-weight: 600; color: var(--ink2); transition: border-color .16s ease, color .16s ease, transform .16s var(--ease), box-shadow .16s var(--ease), background .16s ease; }
.mkp-related a:hover { border-color: var(--sky); color: #fff; background: rgba(96,165,250,.1); transform: translateY(-2px); box-shadow: 0 8px 22px rgba(59,130,246,.18); }
.mkp-cta { position: relative; background: radial-gradient(700px 340px at 50% -20%, rgba(59,130,246,.25), transparent 65%), #04060b; color: #fff; text-align: center; padding: 72px 0; overflow: hidden; border-top: 1px solid var(--line-2); }
.mkp-cta h2 { font-size: clamp(26px, 3.2vw, 38px); letter-spacing: -.02em; font-weight: 700; margin-bottom: 10px; }
.mkp-cta p { color: var(--ink2); margin-bottom: 24px; }
.mkp-cta .mk-cta-row { justify-content: center; }
.mkp-cta .mk-btn-line { background: transparent; color: #fff; border-color: rgba(255,255,255,.3); }
.mkp-cta .mk-btn-line:hover { border-color: #fff; color: #fff; }
.mkp-hub-lead { padding-top: 56px; }
.mkp-prose { max-width: 760px; padding: 56px 22px 72px; margin: 0 auto; }
.mkp-prose h1 { font-size: clamp(28px, 3.4vw, 40px); letter-spacing: -.02em; margin-bottom: 6px; color: #fff; }
.mkp-prose .mkp-date { color: var(--mut); font-size: 13.5px; margin-bottom: 26px; }
.mkp-prose h2 { font-size: 20px; letter-spacing: -.01em; margin: 30px 0 8px; color: #fff; }
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
@keyframes mkPing { 0% { box-shadow: 0 0 0 0 rgba(52,211,153,.45); } 70%,100% { box-shadow: 0 0 0 7px rgba(52,211,153,0); } }
@keyframes mkKicker { 0%,100% { box-shadow: 0 0 0 0 rgba(96,165,250,0); } 50% { box-shadow: 0 0 0 6px rgba(96,165,250,.09); } }

/* hero entrance + display sheen */
.mk-hero-copy > * { animation: mkUp .7s var(--ease) both; }
.mk-hero-copy > *:nth-child(1) { animation-delay: .04s; }
.mk-hero-copy > *:nth-child(2) { animation-delay: .12s; }
.mk-hero-copy > *:nth-child(3) { animation-delay: .2s; }
.mk-hero-copy > *:nth-child(4) { animation-delay: .3s; }
.mk-hero-copy > *:nth-child(5) { animation-delay: .4s; }
.mk-hero-in .mk-hero-visual { animation: mkVis .9s var(--ease) both, mkFloat 7s ease-in-out 1s infinite; }
.mk-hero h1 { background-size: 200% 100%; animation: mkSheen 10s ease-in-out infinite alternate; }
.mkp-hero h1 { background-size: 200% 100%; animation: mkSheen 10s ease-in-out infinite alternate; }
@keyframes mkUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }
@keyframes mkVis { from { opacity: 0; transform: translateY(22px) scale(.98); } to { opacity: 1; transform: none; } }
@keyframes mkSheen { 0% { background-position: 0% 50%; } 100% { background-position: 100% 50%; } }

/* back-to-top */
#mktop { position: fixed; right: 22px; bottom: 22px; z-index: 70; width: 46px; height: 46px; border-radius: 50%; border: 0; background: var(--grad); color: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 12px 32px rgba(59,130,246,.5); opacity: 0; transform: translateY(16px) scale(.9); pointer-events: none; transition: opacity .28s var(--ease), transform .28s var(--ease), filter .2s ease; }
#mktop.show { opacity: 1; transform: none; pointer-events: auto; }
#mktop:hover { filter: brightness(1.08); transform: translateY(-3px); box-shadow: 0 16px 40px rgba(99,102,241,.6); }
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
  .mk-reveal, .mk-stag { opacity: 1 !important; transform: none !important; filter: none !important; transition: none; }
  .mk-h2::after { transform: scaleX(1); transition: none; }
  .mk-hero::before, .mk-dark::before, .mk-hero-visual, .mk-frame-feed div::before, .mk-kicker { animation: none !important; }
  .mk-marquee-track { animation: none; }
  .mk-frame-chart i { transform: scaleY(1); }
  .mk-levels::before { transform: none !important; }
  .mk-btn-solid::after { display: none; }
  #mktop { transition: opacity .2s ease; }
  .mk-live i, .mk-typing i { animation: none !important; }
  .mk-msg { animation: none; }
  .mk-item.open .mk-drop, .mk-mobile.open { animation: none; }
  .mk-hero-copy > *, .mk-hero-in .mk-hero-visual, .mk-hero h1, .mkp-hero h1 { animation: none !important; }
}
`;
