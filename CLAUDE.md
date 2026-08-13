# CLAUDE.md — StayLeased engineering operating manual

StayLeased is property-management software for 10–100-unit buildings: AI agents draft the
desk work (leasing replies, collections, maintenance triage, renewals), every draft lands in
an approval queue the operator controls, and everything posts to one system of record with
real double-entry books. TypeScript, server-rendered HTML (no framework), SQLite. The
marketing site and the product live in this one repo and deploy together.

**This file is the engineering memory.** Business strategy, GTM, prospect lists, and company
decisions live in the "StayLeased" Claude Project (Cowork), not here. When a session produces
a durable engineering fact, put it here or in `docs/`; when it produces a business fact, it
belongs in the project.

## Commands

```bash
npm install                       # deps (Playwright browsers come from the environment)
npx tsc --noEmit                  # strict typecheck — must be clean before any push
sh scripts/test.sh                # full unit suite (node:test) against a fresh data/test.db
sh scripts/e2e.sh                 # full Playwright e2e against a freshly seeded data/e2e.db
node --experimental-strip-types --no-warnings src/seed/seed.ts   # seed the demo database
node scripts/og-image.mjs         # regenerate the share image from scripts/og-image.html
```

Scoped e2e (faster; pick the batch that matches your change — see Gates):
```bash
export STAYLEASED_DB=data/e2e.db STAYLEASED_MODE=demo STAYLEASED_E2E_ISOLATE=1
node --experimental-strip-types --no-warnings src/seed/seed.ts --quiet
node --experimental-strip-types --no-warnings --test --test-concurrency=1 \
  --test-timeout=240000 e2e/<files>.test.ts
```

## Known flake — RESOLVED 2026-08-12, do not re-add a retry

The `tests/accounting.test.ts` "date-ordering flake" (`AP void/reissue`, `bank feed
reconcile`) was never a test problem. `voidApPayment` found the entries to reverse with
`posted_at >= (SELECT created_at FROM ap_payments …)` — two `nowIso()` calls taken on either
side of one insert. When the payment row's millisecond landed after its own journal entries',
the query matched nothing: **the void reversed nothing and the reissue still cut a check, so
the books showed the cash leaving twice.** A money bug, surfaced the first time CI ran the
suite on a different machine (it failed twice in a row there, which is what proved it was not
random). Fixed by selecting the generation nothing has reversed yet — no clock in it — with
two regression tests that force the losing race. There is no known flake; a red suite is real.

## Architecture map

- `src/lib/` — http (router, CSP nonce injection, errorPage), db (SQLite), env
  (`env('X')` → `STAYLEASED_X`, legacy `ORIEL_X` fallback), auth (sessions, perms, sysCtx),
  html (tagged template, escaping, `raw()`), jobs (poller + per-org clocks), audit, events,
  log, sim/ (simulated rails + LLM adapter; live when ANTHROPIC_API_KEY set).
- `src/modules/m1–m19` — admin, portfolio (+property delete), CRM/leasing, marketing site
  (m4), leases, portal, receivables, accounting, facilities, pricing, reports, comms,
  procurement, AI (m17: agents, Ask, LLM plumbing), scoring (m19: deterministic scorers,
  shadow-first). `src/modules/setup/` — the Migration Center import pipeline (see below).
- `src/modules/m4_marketing/` — homepage.ts (the argument, 01→12 bands), features.ts
  (page catalog + legal), chrome.ts (nav/footer/SEO helpers/GA), styles.ts, public.ts
  (property sites, robots, sitemap), ask.ts (public AI chat, separate token budget).
- `src/ui/` — app chrome, theme.css (app styles; marketing styles live in m4), mk-assets.
- `e2e/` — Playwright suites, in-process server (`boot()` in lib.ts). `tests/` — node:test.

## The import pipeline (hard-won; read before touching)

Upload → parse (`lib/xlsx`) → **AI reading plan** (`setup/ai_reader.ts`, whole-sheet plan:
header row, column map, skip rows, sections) competes with the **heuristic path**
(`setup/mapping.ts`: findHeaderRow, autoMap, presets) — higher `mappingScore` wins, AI wins
ties → **deterministic transforms run on the winner regardless of path**:
`mergeStackedHeader` (Yardi two-row headers; UNCONDITIONAL — model row-taxonomy must never
suppress it, that bug corrupted the first real import), `harvestSubRowCharges` (block-format
rent rolls: rent = the rent-CODE's amount, never the unit row's Amount cell; extras fold into
"Other monthly charges"), `detectDocumentProperty` → validate (`setup/import_apply.ts`,
computes the **reconciliation strip** + column mis-mapping warnings + the directory
mass-insert guard) → human review screen → transactional apply (opening balances as JEs,
deposits as liabilities, portal provisioning via `ensurePortalAccess`).

Import doctrine: parser changes must survive the Yardi fixture · imports are approval-gated
· applied imports are read-only records · directory rows MERGE onto lease households by
name (`nameKey`) before inserting · the reconciliation strip must tie to the source report's
own summary page.

## Doctrines (violations get reverted)

- **Copy**: noun-phrase/declarative headlines, no "you" in headlines, formal register,
  compress-don't-delete, honesty gate (no invented customers/metrics/testimonials — none
  exist), demo-led CTAs, never "no sales call". **Replacement-anxiety test (2026-08-12,
  Henry): no copy may read as "this replaces your staff/job"** — the AI is additive help or
  the work is the subject; "every draft under the operator's approval" is the reassurance.
  h1 is "Property management that does the work." — "Autonomous property management" was
  retired as too futuristic for the mainstream buyer.
- **Motion**: nothing scroll-scrubbed; one-shot entrances then stillness; only perpetual
  motion = LIVE pulse + typing dots; reduced-motion = visible + still; footer never animates.
- **Scoring (m19)**: scorers are deterministic (no LLM calls, ever); agents read persisted
  assessments and compute no severity themselves; every scorer ships shadow-first, behavior
  opt-in per org; escalation actions pin confidence below the 0.7 auto floor; lead-heat
  inputs are structurally text-free and `source` never enters rules; shadow never reorders
  queues.
- **SEO**: schema mirrors the page (no JSON-LD content that isn't rendered); no street
  address until a real office exists (areaServed carries local); third-party scripts are
  env-gated + marketing-only + CSP-gated on the same env var; og-image regenerates via
  `scripts/og-image.mjs`, never hand-edited.
- **Security**: CSP is nonce-based (send() injects per-response); public Ask has its own
  token cap (`STAYLEASED_AI_PUBLIC_DAILY_TOKEN_CAP`); `DEBUG_ERRORS` stays unset in prod;
  uploads are magic-byte sniffed; org isolation on every query (`canAccessProperty`).

## Copy pins (grep before touching marketing copy)

`e2e/homepage.test.ts` pins, currently: "Property management that does the work" ·
"Nothing reaches a resident without sign-off." + its order before the segment band ·
"Built for the middle of the market." · "AI agents for the work a small building can’t
staff." · "Live demo, open to anyone" · curly apostrophes · "Everything in one place."
must stay ABSENT · suites/steps/modes lists. Changing copy = update the pin in the same
commit and note it in BUILDLOG. Sweep first:
`grep -rn "<the phrase>" e2e/ tests/`.

## Gates before any push (auto-deploy is ON — main = live at stayleased.com)

1. `git fetch` + rebase (parallel sessions are real; see below).
2. `npx tsc --noEmit` clean.
3. `sh scripts/test.sh` (re-run the accounting flake once before believing a red).
4. Scoped seeded e2e, concurrency 1 — by change area:
   - marketing: homepage, mkpages, marketing, navmenus, rebrand, smoke, seo
   - import: setup, clientready, workingmodel, goldenpath, smoke
   - scoring: smoke, crm, payments, ai, pricing, clientready, goldenpath, workingmodel
   - anything else: smoke + the area's own suite
5. Update BUILDLOG.md (append, unique header) and DECISIONS.md (append, next number) in the
   same commit — check both tails first; parallel builds have collided on numbering.

**Commit identity: Claude** (`user.name Claude`, `noreply@anthropic.com`) — never the owner.

## Deploy & environment

GitHub `hahollander9/stayleased` @ main → Render auto-deploy → https://stayleased.com
(bare domain is canonical; `STAYLEASED_SITE_ORIGIN` overrides). Prod env:
`STAYLEASED_DB=/data/stayleased.db`, `STAYLEASED_SIGNUP_CODE`, `ANTHROPIC_API_KEY`
(+`STAYLEASED_AI_MODEL`), optional `STAYLEASED_GA_ID` (GA4 — everything about it is OFF
until this is set). Live orgs are fenced from sim jobs; external rails are simulated and
disclosed in-product. `.github/workflows/ci.yml` was lost to a web-UI upload (dot-dirs don't
survive them) — restore on the next local push.

## Parallel-session rule

Multiple Claude sessions build on this repo concurrently. Before packaging any change:
fetch + rebase; after any upload: fetch + verify + union gates. BUILDLOG headers must be
unique; DECISIONS numbers must be claimed against the CURRENT tail, not a cached one. When
two pending builds both append to BUILDLOG/DECISIONS, ship one build's entries as a paste-in
file instead of patch hunks (precedent: 2026-08-12).

**Never send BUILDLOG.md or DECISIONS.md through a web-UI upload.** An upload is a whole-file
replace, not a merge, so it silently deletes whatever landed after the uploader last read the
file — on 2026-08-13 it took two BUILDLOG entries and decisions #50–51 (the AP money bug) and
every gate stayed green, because `doclog.test.ts` checks contiguity and uniqueness and an
overwrite satisfies both. Upload only files your own session authored end to end; these two
never qualify (DECISIONS #57).

## Current state & plan

- Live: security hardening, migration UX (Import history, Outbox), agent scoring #1+#2
  (shadow), full marketing SEO/UX pass. Pending in this build: import-integrity layer
  (reconciliation strip, mass-insert guard, unconditional header merge, property delete,
  residents table parity, "Resident directory" naming) + the headline change.
- Next engineering, in order: (1) live-org recovery after deploy — delete the corrupted
  Station U&O property (typed-confirm), re-import rent roll + directory, tie the strip to
  Yardi's summary (110 units · $149,365 rent · $1,260 extras · $99,367 deposits ·
  $331,028.41 balances · 3 move-outs); (2) root-cause replay of the two real Yardi files +
  penny-perfect fixtures + PDF-lane verification (files from Henry); (3) production-readiness
  sweep waves 1–3 (`claude/production-readiness-sweep-plan.md` in the project); (4) scorer #3
  asset/vendor per `claude/agent-scoring-architecture.md`; (5) demo access-code gate (rewrite
  the verification band's "open to anyone" in the same commit); (6) live email rail.
- Superpowers plans live in `docs/superpowers/plans/` — read the latest before starting
  related work.

## Recommended Claude Code skills for this repo (find-skills, 2026-08-12)

1. `security-review` (dan323/easier-life-skills) — OWASP/secret scans; this codebase handles
   rent, PII, and (eventually) money movement; the 2026-08-11 audit found 34 issues worth
   re-checking after each major build.
   `/plugin marketplace add dan323/easier-life-skills` → `/plugin install easier-life-skills/security-review`
2. `claude-api` (anthropics/skills) — the product is BUILT on the Claude API (m17_ai,
   ai_reader, sim/llm.ts); current API docs in-context prevent drift.
   `/plugin marketplace add anthropics/skills` → `/plugin install skills/claude-api`
3. `dependency-audit` (dan323) — no CI on main right now; periodic dep/vuln scans fill the gap.
4. `webapp-testing` (anthropics example-skills) — Playwright discipline is this repo's
   backbone; useful patterns for the e2e suites.
Checked, skipped: `docs` (BUILDLOG is hand-written; main's commit messages are web-upload
noise), `site-audit`/`frontend-design` (covered by the impeccable workflow), `brainstorm`/
`memplan` (superpowers + this file cover them).

## graphify (knowledge graph over this codebase)

Installed project-scoped: skill in `.claude/skills/graphify/`, `PreToolUse` hooks in
`.claude/settings.json`. The **graph itself is NOT committed** — `graphify-out/` is
gitignored, so each clone builds its own. The hooks are guarded by `command -v graphify`
and no-op silently when the CLI is absent; nothing here is required to work on the repo.

```bash
uv tool install "graphifyy[sql]"   # PyPI name is graphifyy, binary is graphify; [sql] is
                                   # required or src/db/schema.sql is silently omitted
graphify update .                  # build/refresh graphify-out/ — AST-only, no LLM, no cost
```

Rules, once `graphify-out/graph.json` exists:
- For codebase questions, run `graphify query "<question>"` first. `graphify path "<A>" "<B>"`
  for relationships, `graphify explain "<concept>"` for one concept. These return a scoped
  subgraph — usually far smaller than GRAPH_REPORT.md or raw grep output.
- `graphify-out/wiki/index.md`, when present, beats raw source browsing for broad navigation.
- Read `graphify-out/GRAPH_REPORT.md` only for architecture review, or when query/path/explain
  don't surface enough.
- After modifying code, `graphify update .` to keep the graph current.

Community labels and the wiki/report layer call an LLM (`graphify label`, `cluster-only`);
`update` does not. Full `/graphify .` runs the semantic pass over docs — budget for it.
