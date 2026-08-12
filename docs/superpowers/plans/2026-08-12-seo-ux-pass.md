# Marketing SEO/UX Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the marketing site's SEO/UX gaps — social share image + full share meta, JSON-LD structured data, breadcrumbs, homepage FAQ, response-time promise, sticky mobile CTA, richer 404, env-gated GA4 — without touching a single homepage copy pin.

**Architecture:** All changes live in the marketing layer (`m4_marketing`) plus two surgical lib edits (`http.ts` 404 + CSP). New shared SEO helpers in `chrome.ts` (`SITE_ORIGIN`, `mkSeoHead`, `ldJson`, `gaSnippet`) are consumed by `mkDoc`, the homepage doc, and `/company`. GA4 and its CSP allowances activate only when `STAYLEASED_GA_ID` is set — zero behavior change until then (shadow-first, same ethos as scoring doctrine).

**Tech Stack:** TS server-rendered HTML (no framework), Playwright e2e, node:test unit; og-image rendered once via Playwright screenshot with repo brand fonts, committed as a static asset.

## Global Constraints

- Homepage pins stay green verbatim (`e2e/homepage.test.ts`): "Nothing reaches a resident without sign-off." · section order assertion · "AI agents for the work a small building can’t staff." · "Live demo, open to anyone" · curly apostrophes · "Everything in one place." stays absent.
- Copy doctrine: noun-phrase/declarative headlines, no "you" in headlines, formal register, honesty gate (no invented customers/metrics), demo-led CTAs, never "no sales call".
- Motion doctrine: one-shot entrances then stillness; sticky CTA appears once per scroll state like `#mktop`; reduced-motion stays visible+still; footer never animates.
- Skipped by decision (Henry, 2026-08-11): case studies + reviews (no real customers yet), maps/street address (areaServed schema only), GA runs env-gated with no ID yet. Response promise: "within one business day".
- Canonical origin: `https://stayleased.com` (bare domain, verified live), overridable via `STAYLEASED_SITE_ORIGIN`.
- Commit identity: Claude. Base: `a3d9cef`. Delinqscore build (pending, disjoint files) must apply cleanly around this — do not touch `m19`/agents/workbench.

---

### Task 1: og-image asset + shared SEO head (canonical, og:image, twitter)

**Files:**
- Create: `src/ui/mk-assets/og-image.png` (1200×630, brand emerald on dark, rendered from `scripts/og-image.html` via Playwright, then committed)
- Create: `scripts/og-image.html` (source of the render, kept for regeneration)
- Modify: `src/server/main.ts` STATIC map: add `/assets/mk/og-image.png`
- Modify: `src/modules/m4_marketing/chrome.ts`: add `SITE_ORIGIN`, `mkSeoHead(path, title, description)` returning canonical + og:url + og:image + og:image dimensions + twitter:card/title/description/image; `mkDoc` gains a `path` param and calls it
- Modify: `src/modules/m4_marketing/features.ts`, `homepage.ts`, `public.ts` (/company): pass paths; homepage + company get the same og:image/twitter/canonical block
- Test: `e2e/seo.test.ts` — every marketing URL serves exactly one `link rel=canonical` = `https://stayleased.com<path>`, `og:image` absolute URL that fetches 200 image/png, `twitter:card=summary_large_image`

**Steps:**
- [x] Render og-image.png (Playwright, repo woff2 fonts, emerald ramp #2DD4BF→#059669→#047857 on #08120D, wordmark + "Autonomous property management" + approval-queue motif) → visually verify → commit asset
- [x] `mkSeoHead` + `mkDoc(title, description, body, path)` + call-site threading
- [x] e2e assertions (canonical/og:image/twitter on all `ALL_MARKETING_URLS`) fail → pass

### Task 2: JSON-LD structured data

**Files:**
- Modify: `src/modules/m4_marketing/chrome.ts`: `ldJson(obj)` helper (JSON.stringify + `<` → `<`), `ORG_LD` (Organization: name, url, logo `/assets/mk/og-image.png`… no street address, areaServed Washington–DC metro + US, email absent) + `WEBSITE_LD`
- Modify: `homepage.ts`: emit ORG_LD + WEBSITE_LD + SoftwareApplication (applicationCategory BusinessApplication, operatingSystem Web, offers price 0 USD "Early access — invitation required") + FAQPage (the 5 new homepage FAQs, Task 4)
- Modify: `features.ts` `featurePage`: emit BreadcrumbList (Home → group hub → page) + FAQPage from `p.faq`; `hubPage`: BreadcrumbList (Home → hub)
- Test: e2e/seo.test.ts parses every `application/ld+json` block on `/`, a feature page, a hub — JSON.parse succeeds, `@type`s present, no `streetAddress` anywhere

**Steps:**
- [x] Helper + org/website blocks in chrome.ts, consumed by mkDoc (all mk pages get Organization once)
- [x] Homepage SoftwareApplication + FAQPage; feature BreadcrumbList + FAQPage
- [x] e2e parse-and-shape assertions fail → pass

### Task 3: Visible breadcrumbs (Home / Group / Page)

**Files:**
- Modify: `features.ts` `featurePage` crumb → `<nav class="mkp-crumb" aria-label="Breadcrumb">` with Home + group links and `aria-current="page"` label; `hubPage` gets Home / Group
- Modify: `styles.ts` `.mkp-crumb` separators/hover
- Test: e2e/seo.test.ts — feature page shows 3-part trail, both links navigate (Home link resolves, group link resolves), matches BreadcrumbList items

**Steps:**
- [x] Markup + styles
- [x] e2e assertions fail → pass

### Task 4: Homepage FAQ band (5 questions) + response-time promise

**Files:**
- Modify: `homepage.ts`: new `HOME_FAQ` const (5 Q&A, exact copy in file; reuses only claims already made elsewhere on the site: approval default, real double-entry, afternoon import, early-access pricing, rollout honesty) + band with kicker 13 "Common questions" between #pricing and #walkthrough, `mkp-faq` details markup reused; form card gains `<p class="mk-form-note">Demo requests are answered within one business day.</p>`
- Test: `e2e/homepage.test.ts` additions — 5 `details` in the FAQ band, promise line present; FAQPage LD count = 5

**Steps:**
- [x] Copy + band + note (register per copy doctrine, no "you" in headlines)
- [x] e2e assertions fail → pass; existing pins re-run green

### Task 5: Sticky mobile CTA

**Files:**
- Modify: `chrome.ts`: `mkHeader` renders `<div class="mk-mcta" id="mk-mcta"><a … href="/#walkthrough">Book a live demo</a></div>`; CHROME_JS toggles `.show` (adds `mk-mcta-vis` on body) at y > 520, mirroring `#mktop`
- Modify: `styles.ts`: hidden ≥721px; fixed bottom, safe-area inset, border-top, backdrop blur; `body.mk-mcta-vis #mktop, body.mk-mcta-vis .mk-chat` lift above the bar on mobile; one-shot translate entrance, `prefers-reduced-motion` = no transition
- Test: e2e/seo.test.ts mobile viewport: hidden at top, `.show` after scroll, tap target ≥44px, absent on desktop viewport; homepage + feature page both

**Steps:**
- [x] Markup + JS + CSS
- [x] e2e assertions fail → pass

### Task 6: 404 upgrade

**Files:**
- Modify: `src/lib/http.ts` `errorPage`: status 404 adds a destinations row (Platform `/platform`, AI agents `/agents`, Book a live demo `/#walkthrough`) under the existing actions; other statuses unchanged; title becomes "Page not found · StayLeased" for 404
- Test: e2e/seo.test.ts — `/no-such-page` → 404, contains the three destination links, still branded (rebrand pin already covers branding)

**Steps:**
- [x] Edit + styles (reuse `.err-*` classes in theme.css if needed)
- [x] e2e assertions fail → pass

### Task 7: Env-gated GA4 + CSP + privacy disclosure

**Files:**
- Modify: `chrome.ts`: `gaSnippet()` returns `''` unless `env('GA_ID')`; else async gtag loader + config with `allow_google_signals:false, allow_ad_personalization_signals:false`; injected in `mkDoc` head + homepage head ONLY (marketing pages; never the app, portals, or `/p/` property sites)
- Modify: `src/lib/http.ts` `send()`: when `env('GA_ID')` set, CSP script-src += `https://www.googletagmanager.com`, adds `connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com`; unchanged otherwise
- Modify: `features.ts` PRIVACY: new "Marketing-site analytics" section + updated date
- Test: `tests/seo_unit.test.ts` — `gaSnippet('')` empty / with `setEnv('GA_ID','G-TEST')` contains id + privacy flags; e2e (no env) — no `googletagmanager` on `/`, CSP has no GA hosts

**Steps:**
- [x] Snippet + CSP + privacy copy
- [x] Unit + e2e assertions fail → pass

### Task 8: Verification + packaging

- [x] Verified-done sweep recorded in BUILDLOG: CTA above fold (hero), robots.txt+sitemap, unique titles, meta descriptions, internal links (nav/footer/related), alt text (decorative vignettes aria-hidden; only `<img>`s are app photos with alt)
- [x] `npx tsc --noEmit` clean · `sh scripts/test.sh` (accounting flake noted) · e2e batch: smoke, homepage, marketing, mkpages, navmenus, rebrand + new seo.test.ts
- [x] Mobile + desktop screenshots of FAQ band, sticky CTA, 404, breadcrumbs (impeccable pass)
- [x] BUILDLOG + DECISIONS entries; commit as Claude; format-patch vs `a3d9cef`; `seo-ux-build-files.zip`; update `claude/stayleased-deployment.md`
