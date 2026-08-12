# BUILDLOG.md

## 2026-07-21 — Session 1 · Phase 0: Foundation ✅

**Built:** repo scaffold per §2.1; zero-dependency framework core — `http.ts` (router/middleware/multipart/CSRF), `html.ts` (escaping tagged templates), `db.ts` (node:sqlite, Postgres-compatible schema), auth (scrypt + hashed session tokens), RBAC catalog with 3-layer enforcement, audit log + History panels, domain events + HMAC webhooks with retry, jobs engine keyed to the simulated business date, settings hierarchy (org → property), file storage with per-record download auth. M1 screens: staff & roles (+ permission matrix UI and generated doc), settings editor, audit viewer, jobs dashboard, Simulator Console (time machine + dials), Message Console (browse + simulate inbound), API keys & webhook admin, `/developers` reference, org onboarding for platform admin, impersonation with banner + audit. Seed: Summit Ridge Management Co. + 11 staff personas + platform admin; `docs/demo-logins.md` generated.

**Verified:** `npm run check` green — tsc strict clean, 17 unit/integration tests including the cross-org isolation suite (which caught a real bug: property access checked role scope before org membership — fixed in `canAccessProperty`). `npm run e2e` green — 4 Playwright tests: every persona logs in, admin consoles render seeded data, permission matrix + API reference render, global search returns hits. Screenshots in docs/screenshots/phase-0/.

**Next:** Phase 1 — M2 portfolio/properties/units + the real property dashboard + §8 property seed.

## 2026-07-21 — Session 1 · Phase 1: Portfolio & units ✅

**Built:** M2 complete — property CRUD (type/timezone/fiscal), buildings, floorplans with base rents, 394 units with amenity premiums adjusting effective pricing, rentable-item inventory (parking/garage/storage), bookable amenity spaces, unit status board (kanban) + filterable list, unit detail with pricing breakdown + lease-history stub + History tab, property overview with tabs, property dashboard (occupancy/exposure KPIs, unit-mix donut, floorplan availability), portfolio roll-up with property comparison. Server-side SVG chart library (donut/bars/lines/sparkline/funnel). Seed: the three §8 properties + property-scoped staff grants. Dashboard "extras" registry so later phases contribute tiles without touching this module.

**Verified:** 20 unit/integration tests (occupancy/exposure math asserted exactly; org isolation extended to properties) + 5 Playwright e2e (roll-up, property switch → dashboard, board filters). Screenshots in docs/screenshots/phase-1/.

**Next:** Phase 2 — chart of accounts, balanced JEs + posting rules, charge engine, lease/resident seed (~93% occupancy), resident ledger.

## 2026-07-21 — Session 1 · Phase 2: Ledger spine ✅

**Built:** M9 items 1–2 minimal + M8 item 1. 40-account multifamily chart + default posting rules (auto-provisioned on org.created); `postJE` with zero-balance enforcement, integer-cents guard, closed-period blocking, savepoint transactions; charge engine posting through posting rules (concessions as negative charges), prorations (actual-days + 30-day), MTM premium, per-line/month idempotency; `rent_posting` job wired to the business-date scheduler; aging engine (FIFO application); resident ledger with running balance; staff Residents/Leases pages with lease detail tabs (extension registries for later phases); GL trial balance / journal / entry pages; live invariants page (/gl/invariants). Seed: 362 leases, 650 residents, households/pets/vehicles/rentable assignments, unit statuses derived from leases, July charges posted through the real engine (608 charges), named cast pinned (Maya Torres B-204, Derrick Cole C-311).

**Verified:** 30 unit/integration tests (unbalanced-JE rejection, proration math 15/31 days exact, MTM premium, idempotency, void reversal, closed-period block, org-wide posting on date advance, invariant suite) + 9 Playwright e2e (trial balance balanced, invariants all green, ledger running balance, GATE: +7d advance → August JEs). Screenshots in docs/screenshots/phase-2/. Found+fixed: ACCOUNTANT lacked leases:view.

**Next:** Phase 3 — payment rails simulator, late fees, delinquency workbench, deposit accounting, 14-month history seed.

## 2026-07-21 — Session 1 · Phase 3: Payments & receivables ✅

**Built:** the full M8 money engine (see STATE.md for the feature list). Notables: payment application order is category-ranked (deposit→rent→utility→fee→other) FIFO within category; cash-basis income posts per-application while accrual relieves AR — both books stay exact through NSF reversals and prepaid credits; deposit disposition reuses the payment pipeline as a 'credit' payment funded from 2100 so aging/ledgers/invariants need no special cases; settlement splits operating vs deposit escrow cash.

**Verified:** 41 unit/integration tests + 16 Playwright e2e. Bugs the tests caught: late fees keyed to the 1st even for mid-month move-ins (now per-charge due+grace); late-fee idempotency missing month key; seed double-paid deposits creating phantom credits (now pays exact open deposit; payments only cover charges dated as-of); NSF notifications need a household contact. History-seed realism tuned: 9% of households delinquent at varied depths, Derrick Cole shows in three aging buckets with $974 aged 61–90.

**Next:** Phase 4 — resident portal core (mobile-first), pay/autopay UX, maintenance intake, statements.

## 2026-07-21 — Session 1 · Phase 4: Resident portal core ✅

**Built:** M7 items 1–3/6/9 (details in STATE.md). PDF layer (`lib/pdf.ts` over preinstalled pdf-lib) with auto-paginating tables — statements + SODA now; leases/reports/1099s reuse it later. Portal nav is a registry so later phases (amenities, community, insurance, rewards) add tabs without touching the shell.

**Verified:** 41 unit tests + 24 Playwright e2e (all Phase 4 gates on a 390×844 viewport, plus emergency keyword flagging, NTV policy floor, roommate privacy). Screenshots in docs/screenshots/phase-4/.

**Next:** Phase 5 — facilities: WO lifecycle, tech My Day, dispatch, turns, inspections, PM, inventory, vendor gating, analytics + seed volume (35 open / ~600 historical WOs).

## 2026-07-21 — Session 1 · Phase 5: Facilities ✅

**Built:** M10 complete (feature list in STATE.md). Wiring highlights: `lease.notice` event → turn auto-creation; move-outs job ends leases + flips units on date advance; inventory usage posts dual-basis GL reclass; COI expiry checked at every dispatch path (WO assign, turn task vendor); emergency portal keywords escalate via SMS to supervisors.

**Verified:** 46 unit tests (state machine, COI gating, stock+GL, turn→vacant_ready, inspection damages→ledger) + 30 Playwright e2e including all four phase gates (tech My Day end-to-end with drawn signature on mobile; resident rates it; turn board advances to ready; PM generates on +7d advance). Screenshots in docs/screenshots/phase-5/.

**Next:** Phase 6 — CRM & centralized leasing (M3).

## 2026-07-21 — Session 1 · Phase 6: CRM & centralized leasing ✅

**Built:** M3 complete (feature list in STATE.md). 51 unit + 37 e2e green; gates verified live: dedupe on repeat inquiry, tour+quote from guest card, ILS leads on +1d advance, cross-property Leasing Center with round-robin, funnel analytics.

**Next:** Phase 7 — marketing websites & prospect portal (M4).

## 2026-07-21 — Session 1 · Phase 7: Marketing websites ✅

**Built:** M4 complete — see STATE.md. Original branding with gradient placeholder art (no scraped assets); pricing/availability rendered live from inventory at request time.

**Verified:** 43 e2e green incl. all gates: prospect inquiry lands in CRM (searchable, deduped), self-scheduled tour appears on /tours, CMS hero edit visible on the public page immediately, sitemap/meta/JSON-LD present, syndication toggles persist. Screenshots in docs/screenshots/phase-7/.

**Next:** Phase 8 — applications & screening (M5).

## 2026-07-21 — Session 1 · Phase 8: Applications & screening ✅

**Built:** M5 complete (list in STATE.md). OCR anomalies re-derive deterministically from stored document bytes at screening time, so results survive restarts; test identities (decline/conditions/approve/thinfile @screening.demo) steer demos exactly like processor test cards.

**Verified:** 57 unit + 49 e2e. Gates live: full wizard (mobile) with doc upload + co-applicant invite + fee math ×2 adults, async bureau → conditions scorecard, assistant blocked from override / manager blocked without reason / recorded with reason, unit vanishes from public apply while held and returns on release, adverse-action + invite emails in the console, fraud/thin-file flags visible in review.

**Next:** Phase 9 — lease generation, e-signature & renewals (M6): the golden path.

## 2026-07-21 — Session 1 · Phase 9: Leases, e-signature & renewals ✅

**Built:** M6 complete (list in STATE.md). Design notes: e-sign is fully in-house — hash-chained event trail where each event's SHA-256 covers the previous hash, so any edit breaks the chain; executed packet merges the original PDF + signature page + completion certificate via pdf-lib and is stored immutable/resident-visible. Renewal activation is *continuity-preserving*: open balance moves via an offsetting AR↔AR charge pair (GL untouched, invariants hold), autopay + open work orders re-point to the new lease, deposit is never re-charged, no move-in checklist.

**Fixed along the way:** e2e harness now clones the pristine seeded DB per test file (`STAYLEASED_E2E_ISOLATE`) — goldenpath's business-date advances were bleeding into later files' expectations; seed guarantees Maya Torres (portal demo cast) a renewal offer.

**Verified:** 62 unit + 54 e2e green, including the master-prompt golden path as one continuous e2e: lead→tour→quote→application→screening→approve→lease→sign(resident typed, PM countersign)→+30d advance→resident portal shows deposit + prorated rent + holding-deposit credit→renewal offered→accepted in portal→re-signed to fully executed. Screenshots in docs/screenshots/phase-9/.

**Next:** Phase 10 — accounting deep (M9 complete: AP, bank rec, periods & close, budgets, statements).

## 2026-07-21 — Session 1 · Phase 10: Accounting deep ✅

**Built:** M9 complete (list in STATE.md). Design notes: the BankFeed simulator derives the statement from the books (batch deposits net of escrow split, checks with clearing lag, a JE mirror for other cash events) then layers on bank-only reality — monthly processor fees billed in arrears, interest, deterministic noise — so every month *can* reconcile to zero but only through the real workflow (auto-match + adjustment JEs). Reconciliation reports walk book→bank via outstanding checks/deposits-in-transit. Close checklist is auto-evaluated, not a to-do list: it queries the actual state of bank rec, AP queue, JE approvals, recurring postings, invariants and settlements. Intercompany payments post due-to/due-from on both books automatically.

**Verified:** 73 unit + 60 e2e green. Gate live in UI as Priya (accountant): July reconciles to $0 (auto-match "0 still open" → Complete), closed June rejects a manual JE then reopens with audited reason and re-closes, balance sheet balanced on both bases, IS July NOI appears in the T-12 column, AR aging ties to control, Summit Ridge budget shows over/under flags, AP invoice approved → payment run → check voided + reissued on the positive-pay register. Screenshots in docs/screenshots/phase-10/.

**Next:** Phase 11 — utilities (M11) + insurance & risk (M12).

## 2026-07-21 — Session 1 · Phase 11: Utilities + Insurance & risk ✅

**Built:** M11 + M12 complete (list in STATE.md). Design notes: utility history is woven *into* the money history via a seed month-hook — reads ingest, provider invoices land in AP, and RUBS charges post before anyone pays that month, so 14 months of convergent billing exists with every invariant green. RUBS proration is day-accurate around move-in/out; vacant shares never bill and feed the recovery report. Insurance master-policy fees bill through the same recurring engine as rent. The deposit-alternative claim path hooks into deposit disposition via a registered hook (no module cycle), capping at coverage and funding from 4110 so the GL stays clean.

**Fixed along the way:** `diffDays` argument-order bugs (RUBS occupancy + lapse windows); a +30-day advance had crept to ~34s — set-based late-fee prefilter, set-based insurance sweep, and an incremental high-water floor on the BankFeed mirror cut job cost ~40%, and the golden-path advance click now allows 120s.

**Verified:** 79 unit + 67 e2e green. Gate live: Cardinal water RUBS preview (every unit's sqft math + vacant shares) posts converged charges that appear on the Torres ledger next to rent; vacant recovery report correct around seeded move-outs; 34 lapsed leases force-place into the master policy with notices on a day's advance; July utility cycle stages reads/invoices/previews on the 3rd; surety claims on /risk; guaranty rescues a conditions scorecard; Maya's portal shows verified coverage + usage-vs-community chart.

**Next:** Phase 12 — procure to pay (M16).

## 2026-07-21 — Session 1 · Phase 12: Procure to pay ✅

**Built:** M16 complete (list in STATE.md). Design notes: the DocOcr invoice extraction is deterministic and PO-aware — it mirrors receipted quantities with a stable price wobble, and the exception knob inflates 6-10% so a believable mis-priced invoice can be manufactured on demand. Match logic is 3-way by default: value received (not ordered) is the benchmark, so billing ahead of receipt is itself an exception. Receiving restocks M10 inventory by SKU and burns down capital-project commitments that /projects now shows next to actuals.

**Fixed along the way:** `parseUsd('')` threw on blank optional money inputs (PO + AP entry forms); pdf-lib WinAnsi choked on a ⚠ glyph in the 1099 PDF; the header property switcher shares `name=property_id` with form fields — e2e selectors must scope to the form (its autosubmit was silently wiping filled forms).

**Verified:** 86 unit + 75 e2e green. Gate live end-to-end: manager's PO auto-approves under the threshold while the roof-project PO routes to admin; Pinnacle acknowledges in the portal; receiving flips to received and restocks; the OCR-prefilled invoice 3-way matches and lands in AP; the seeded mis-priced invoice waits in the exception queue until the accountant overrides with a reason; a payment run pays everything; the vendor sees cleared payments with remittance-advice PDFs; the 1099 summary + PDF generate with SwiftTurn's missing W-9 flagged.

**Next:** Phase 13 — communications complete (M15).

## 2026-07-21 — Session 1 · Phase 13: Communications complete ✅

**Built:** M15 complete (list in STATE.md). Design notes: threading is a send-hook on the messaging simulator, so every message that has ever gone out threads automatically — the seed then backfills 14 months of history into ~500 conversations. Consent and quiet hours are enforced per recipient inside the mass pipeline with the outcome recorded on each recipient row (sent / skipped_optout with reason / deferred_quiet that drains next window). Quiet hours run off a new simulated clock-hour dial in the Simulator Console, keeping the whole thing deterministic. Automation toggles live in settings and are enforced at notify() so a disabled lifecycle template is skipped org-wide.

**Fixed along the way:** call_logs uses `at` not `created_at`; a hidden-input JSON payload was double-escaped by the html`` engine; "viewing a thread" no longer clears needs-reply (replying does); the Message Console gained template/search filters (which also fixed a payments e2e that relied on first-page contents).

**Verified:** 90 unit + 81 e2e green. Gate live: mass to "balance > $0 at Summit Ridge" previews the exact audience (UI count equals the live segment query), sends on the next day's scheduler into the console, records "resident opted out of email" skips, defers night SMS at clock-hour 22 and drains at 10, and Maya's simulated inbound reply threads into her conversation and reappears under needs-reply.

**Next:** Phase 14 — revenue intelligence (M13).

## 2026-07-21 — Session 1 · Phase 14: Revenue intelligence ✅

**Built:** M13 complete (list in STATE.md). Design notes: the engine is rules+heuristics, deliberately transparent — priceUnit returns a factor list whose dollar deltas sum exactly to the recommendation (a guardrail factor materializes whenever the ±5% cap bites), so the queue can show the full "why" for every number and the audit trail stays honest. The comp market is a deterministic simulator keyed off our own floorplan mix (stable per-comp bias, yearly drift, seasonality), which gives the positioning factor something believable to push against without any external data. Term rates start from a short-premium/long-discount curve and are then steered by expiration-calendar load (p75 heavy → +2.5%, p25 light → −1.5%) — the calendar and the matrix render side by side so the steering is visible. Renewal batch rows land pre-accepted with the org cap applied (and noted as a factor when it bites), which is exactly the shape m6's renewalMatrix already consumed — so offers, quotes (m3) and the public sites (m4, via live unit rents) all pick up decisions with zero extra wiring.

**Fixed along the way:** schema.sql had a dead speculative comp_sets/comp_observations block from an earlier phase that silently won over the Phase 14 definitions (CREATE IF NOT EXISTS is first-wins) — removed; and the Phase 14 e2e exposed a latent scoping bug: agingRows listed all-org delinquents while the detail page enforced property scope, 404ing scoped managers on out-of-scope rows — the workbench (and CSV export) now property-scope to the viewer.

**Verified:** 96 unit + 87 e2e green, all §9 invariants over the full history. Gate live: queue factors sum to the shown recommendation; overriding a rec (reason required) drops the public site's "from" price and a fresh CRM quote to the override amount immediately; accepting another rec moves the unit's asking rent; the Foundry renewal batch runs live and every term lands within the 8% org cap (checked in the UI percentages and again in SQL); the term matrix prices Aug-2026 (21 expirations, flagged red) at a premium while light months take a discount. Screenshots in docs/screenshots/phase-14/.

**Next:** Phase 15 — reporting & BI complete (M14).

## 2026-07-21 — Session 1 · Phase 15: Reporting & BI complete ✅

**Built:** M14 complete (list in STATE.md). Design notes: one `ReportDef` engine carries the entire §10 catalog — 50 definitions that stay 15-40 lines each because the parameter panel, sorting, group-by subtotals, totals, drill-through, CSV and PDF are all generic. As-of correctness lives in `asof.ts` as three effective-dated helpers (possession, balance, FIFO aging vs actual payment applications, all date-bounded — a payment that later NSF'd still counts on the days it was good); MetricSnapshot is deliberately a *cache* of those definitions (nightly job + 15-month backfill), never a second truth. The custom builder keeps the SQL surface closed: users select from code-defined column expressions, filters are op-whitelisted and parameterized, so "custom" never means "injectable". Scheduled reports ride the day scheduler and deliver CSVs into the Message Console as attachment links on real file rows. Dashboards are a 12-widget library with role defaults and per-user layouts.

**Fixed along the way:** the catalog exposed real world gaps — no concessions, no payment plans, no credit balances, no completed turns, no write-off flow anywhere. Added the bad-debt write-off flow to M8 (negative AR charge → DR 5610/CR 1100, reason required, threshold-gated by gl:post, closes the collections case; `writeoff` was silently missing from CHARGE_CREDIT and would have posted to amenity income) and enriched the seed: move-in concessions (credit balances now exist), Derrick's promised payment plan, completed historical turn boards, two collection skips at Foundry. Aged receivables now keep ended-with-balance leases on the books (a receivable outlives possession). PROPERTY_MANAGER gained reports:schedule. One e2e selector collision: the new "Reports" nav item matched accounting's `a:has-text("Report")` — scoped to `.content`.

**Verified:** 105 unit + 93 e2e green, §9 invariants over full history. Gate live: all 50 reports render non-empty and drill through; the rent roll for a date 6 months back reproduces the effective-dated truth exactly (row count + scheduled-rent total, including since-departed residents); a custom work-order report built in the browser schedules daily and arrives in the Message Console with a working CSV attachment after a day advance (next to the seeded daily delinquency snapshot); trial balance nets to zero; the exec dashboard renders from the widget library and customizes (add/remove/reset) with maintenance getting its ops default. docs/metrics.md defines every number once.

**Next:** Phase 16 — AI layer (M17 on MockLlm).

## 2026-07-21 — Session 1 · Phase 16: AI layer ✅

**Built:** M17 complete (list in STATE.md). Design notes: the LlmProvider boundary keeps every agent deterministic — agents gather grounded facts through the same service APIs the screens use (live units, quoted rents, tour slots, aging, matrix bands), and MockLlm only formats those facts, so nothing an agent says can drift from the database. The framework makes supervision structural: propose() writes the full input/output row first, the dial (layered code←org←property) decides whether execution needs a human, executors are a registry keyed by output.kind so approved actions replay exactly what was reviewed, and edit-before-send re-audits. Guardrails live in code, not configuration: threat-filter + dispute path on payments, matrix-band floor on renewals with forced PM escalation, unconditional emergency keywords on maintenance, human-request holds on leasing even at autonomous.

**Fixed along the way:** partial autonomy overrides originally shadowed the whole org object (a Cardinal `{leasing:'auto'}` implicitly reset payments/renewals) — autonomyFor now merges layers; intent detection missed plurals ("dogs"); event hooks stay dormant until the world is seeded so earlier phases can't trigger agents retroactively; Ask StayLeased respects property scope per asker (a scoped manager asking about an out-of-scope property gets their own portfolio — by design, tested).

**Verified:** 112 unit + 99 e2e green, §9 invariants intact. Gate live end-to-end: Alicia's queue card quotes a unit the test proves is vacant-ready at her property with live pricing and pet policy; Approve sends the reply into the console AND books the M3 tour; a simulated inbound inquiry lands in the queue via the hook; "I smell gas near the stove" triages emergency with the never-optional guardrail and an audited WO note; 40/40 call transcripts carry summaries/sentiment/tags with real follow-up tasks; Ask StayLeased's three cross-module answers equal DB truth to the cent; the AI Activity KPIs match ai_actions exactly, and draft-only approvals mark reviewed without sending.

**Next:** Phase 17 — vertical modes (M18).

## 2026-07-21 — Session 1 · Phase 17: Vertical modes ✅

**Built:** M18 complete (list in STATE.md). Design notes: every vertical is conditional behavior keyed on Property.type or unit flags — assignBed refuses non-student properties, assertAffordableCompliance no-ops on market units, the PCS action rides the existing lease-action registry — so the core modules never forked. The affordable gate is enforced where money becomes real (lease activation) rather than in UI validation, which means the API, jobs, imports and future flows all inherit it; renewal offers, batches, and the pricing engine each clamp/skip program units independently so no path can drift a regulated rent. The waitlist's compliance answer is structural: positions are immutable, out-of-order offers throw, and skips demand written reasons — the audit log always explains "why was #4 housed before #2".

**Fixed along the way:** the affordable seed originally selected only vacant units (rent NULL trivially "complied") — occupied-first selection with per-unit lowest-fitting AMI band made the set-aside real; seeded cert incomes now derive from each unit's band so income-qualification can't randomly fail; two vacant set-asides are reserved so the certification gate can be demoed live.

**Verified:** 117 unit + 104 e2e green, §9 invariants intact. Gate live: a bed assigned on the board becomes an individual-liability lease that activates on the next day's advance — the student's portal shows only their bed's ledger and the parent logs in with the guarantor banner; an over-limit lease refuses to activate with the exact limit math in the error, the 5-document certification completes in the browser (over-income households cannot certify) and activation unblocks; the waitlist refuses out-of-order offers; a PCS break sets notice with zero fee charges and a confirmation letter.

**Next:** Phase 18 — hardening, full regression, README tour, handoff.

## 2026-07-21 — Session 1 · Phase 18: Hardening & handoff ✅ — BUILD COMPLETE

**Done:** the final gate ran green from a fresh clone in one pass: seed 63s → strict typecheck → 123 unit/integration tests → 104 Playwright e2e (every phase gate re-verified). Performance: two hot-path indexes cut the +30-day time-machine advance from 51s to 38s; per-job costs profiled and documented; all hot pages < 500ms. Security: a dedicated sweep proves org isolation + permission guards on every surface added since Phase 10, including SQL-injection-shaped input to the report builder (closed expression surface + parameterization holds). A11y: automated 18-page scan; error pages gained lang + h1; everything else was already clean via the shared UI kit. The README now carries the scripted 15-minute demo tour, URL-verified per persona. parity.md maps every Entrata product to its StayLeased module with honest gap notes.

**The numbers:** 19 phases, 18 modules + framework, ~120 tables, 50 canonical reports, 7 AI agents, 5 vertical modes, 23k+ journal entries over 14 months of deterministic history, 123 unit + 104 e2e tests, all §9 invariants continuously green, one `npm run seed` to rebuild the world byte-for-byte.

**Handoff:** README (tour) → STATE.md (full checklist) → docs/parity.md (fidelity + gaps) → docs/metrics.md (every number's definition) → DECISIONS.md (the judgment calls). Fin.

## 2026-07-21 — Session 1 · Post-handoff: zero-terminal local run

**Done:** the user wanted it running on their own computer with no terminal work, so the delivery zip is now "install Node, double-click." Added `Start-StayLeased.command` (macOS/Linux) and `Start-StayLeased.bat` (Windows): both verify Node ≥ 22.11, probe whether `--experimental-strip-types` is still needed (Node 24 LTS strips types by default; the flag may vanish in future majors), install/seed only when missing, hop ports if 3000 is busy (mac), open the browser, and keep the window open on errors. `scripts/noderun.mjs` gives the npm scripts the same version-adaptive flag logic. The zip additionally bundles `node_modules/pdf-lib` (the only runtime dep, vendored so first run needs no npm); the demo world builds on first launch (~1 min — a pre-built `data/` bundle proved too heavy for the 30 MiB delivery limit). HOW-TO-RUN.txt is the plain-language cover sheet. Verified end-to-end from a fresh copy: cold seed path, instant-boot path, and a curl login → dashboard flow.

**Observation for the log:** two same-commit seeds run minutes apart produced slightly different aggregate history (11,402 vs 11,557 charges; 655 vs 667 settlement batches) while the demo cast, invariants, and every tested fixture held identical — so "deterministic" holds at the entity/cast level the tests pin, but some wall-clock coupling (likely `nowIso()` ordering feeding batch cuts) jitters the long-tail aggregates. Shipped world = the launcher-built one whose counts match the final-gate run (23,441 JEs / 655 batches). Worth a dig if exact byte-level reproducibility ever matters.

## 2026-07-28 — Marketing site build-out: 31 pages + dropdown overhaul

**Built:** every nav-dropdown item on the marketing homepage now has a real destination — 27 dedicated feature/audience pages + 4 hub pages (/platform, /resident, /agents, /for) rendered from a single catalog in `m4_marketing/features.ts`, sharing new extracted chrome (`m4_marketing/chrome.ts`). Dropdowns rebuilt from pure-CSS :hover to JS hover-intent (gap bridge + 240ms grace + click-confirm + aria + Escape), matching the in-app module bar's proven pattern. Mobile nav added (burger → accordion panel; below 980px the old page had no nav at all). Rent reporting removed everywhere (not a product feature); honest early-access status chips on pages whose external rails are still rolling out. /legal/privacy + /legal/terms. robots.txt un-hides the marketing site (was Disallow: / — the homepage was invisible to search engines); sitemap lists all pages; https-aware URLs.

**Verified:** tsc clean · 166/166 unit (7 new: catalog↔nav drift guard, completeness, honesty chips, rent-reporting keep-out) · 143/143 e2e (8 new: all pages render w/ chrome, 404s, homepage link sweep, hover-gap survival + grace-period close + exclusivity, hover-open click-confirm + Escape, mobile menu navigation, robots/sitemap). Existing homepage/nav e2e contracts unchanged and green.

**Gotcha for the log:** `backdrop-filter` on the sticky header makes it the containing block for `position:fixed` descendants — the mobile panel computed to zero height until it moved outside `<header>`.

## 2026-07-28 — Small-operator retarget v2: Residents pillar retired, homepage de-enterprised, new-to-AI lane

**Built:** per Henry — no resident-experience marketing yet, speak to small operators, include people who've never used AI. Residents nav group + 5 pages removed (portal folded into Platform as /platform/resident-portal, operator-voiced; old URLs redirect). Homepage rewritten in plain language: first-week walkthrough replaces the ontology stack, "Everything in one place" replaces the OXP/RXP two-platforms section, three plain autonomy modes replace the L1–L5 ladder, "You stay in control. Always." replaces governance-speak, and a "Never used AI before?" section (with a concrete 9pm-lead draft-approval card) plus a dedicated /agents/new-to-ai page carry the AI-newcomer story. AI nav leads with the newcomer page; "Autonomy & governance" renamed "Approvals & control".

**Verified:** tsc clean · 168/168 unit · 144/144 e2e. Homepage e2e now asserts the enterprise framing is ABSENT (ontology/OXP/RXP/agentic-OS regexes must not match) so it can't creep back; unit tests pin the retired Residents pillar and the new-to-ai lead position.

## 2026-08-08 — Accountant-feedback build: reserves, owner statements, statement packets, agreed vendor pricing

**Built:** from Henry's conversation with the Dantes Partners senior accountant. (1) **Replacement reserves** (`m9_accounting/reserves.ts` + `/reserves`): per-property funding plans (monthly amount, optional target cap), a daily-idempotent `reserve_funding` job posting 1010→1030 transfers on both bases, approval-gated draws (`reserves:approve`) that release funds back to operating, and a Recent-activity feed. (2) **Owner statements** (`owners.ts` + `/owners`): owner entities with per-property ownership percentages (100% cap enforced), consolidated trailing-12 equity-income statements per owner (income/expense/NOI shares + 3020 capital-activity share + reserve share) with CSV/PDF export. (3) **Statement packets** (`packets.ts` + `/statements`): the accountant's "save the settings" ask — a saved scope+basis pull that opens as one page (T-12 income statement + balance sheet + cash flow), with a combined CSV (incl. the month-by-month grid) and a PDF. (4) **Vendor price agreements** (`m16_procurement` + `/purchasing/agreements`): negotiated per-vendor catalog rates with effective windows, enforced automatically inside `createPo`. New perms `reserves:*`/`owners:*` wired to RM/PM/Accountant; two new report defs (Replacement Reserve Activity, Owner Equity Income); Money nav gains Reserves + Owners. Marketing: `/platform/accounting` refreshed (packets/reserves/owner-statement cards, close-lock language, stakeholder-pull FAQ), the Reports owner-package FAQ is now literally true, and a **new `/platform/purchasing` page** + nav item tell the procure-to-pay story. Seeds: 3 reserve plans → 42 funded months mirrored into the bank feed (all 42 account-months still reconcile to $0), an approved roof-project draw + a pending water-heater draw, 3 owners across 3 properties, 2 packets, 2 price agreements + a PO priced from one.

**Decisions:** #19–22 (reserve cash as designated GL bucket; owners as read-time dimensions; packets as saved pulls; agreements enforced at createPo).

**Verified:** tsc clean · unit 181/181 (8 new in `tests/reserves_owners.test.ts`) · e2e homepage+mkpages+marketing 25/25 · navmenus+rebrand+smoke 13/13 · NEW `e2e/finfeatures.test.ts` + accounting/finops/procurement 24/24 · full demo seed green in ~45s with recons and period closes intact · permission matrix + ERD regenerated.

**Next:** deploy (web-UI upload or on-computer push — cloud session cannot push); consider a reserve-funding line on the close checklist; owner read-only login remains roadmap (marketing still says so).

## 2026-08-10 — Nav consolidation + map/back hardening + demo-clock guardrail

**Built:** (1) **Grouped module dropdowns** (`ui.ts` TAB_GROUPS + `.mgroup` styles): the big tabs' flat columns become labeled clusters — Financials: Collect / Books / Capital & owners; Operations: Maintenance / Purchasing & supply / Insight; Leasing: Pipeline / Marketing; Property: Portfolio / Risk & programs; Reports: Analytics / AI. Overview + conditional Approvals stay first, ungrouped; short tabs (Residents, Messages) stay flat; membership is href-boundary-safe (`/ap` never claims `/approvals`). (2) **Map back-path hardening**: `/map/open/:id` with a stale/foreign property id (dead history entries after a demo rebuild, changed portfolios) now recovers to `/map` with a flash instead of a 403 dead end; e2e regression pinned in `e2e/map.test.ts`. (3) **Demo time-machine ceiling**: `advanceBusinessDate` refuses to push a demo org more than ~2 months past today — one public visitor can no longer fast-forward the shared demo world years ahead of every later sales call (`tests/timemachine.test.ts`).

**Investigated (live, in Henry's Chrome + sandbox):** the reported "map → back → error." No client or server error reproduces on that path — console clean, no 4xx/5xx. What does happen live: during deploy windows the public demo serves transitional/garbage KPIs (36% occupancy, ÷9 percentage tiles, delinquency swinging $34k→$381k between renders minutes apart), and the shared always-advancing demo world accumulates sim churn that makes revisited pages look "broken." Same-day job idempotency verified experimentally (3× rerun, zero new rows) — the poller is not compounding. Root remedy proposed (not built): scheduled pristine rebuild of the demo org in live deployments.

**Verified:** tsc clean · unit 183/183 (2 new; accounting flake reran green per runbook) · e2e map 3/3 (incl. new regression) · navmenus 5/5 · smoke+hubs+finfeatures 12/12 · grouped menus eyeballed via screenshot at 1440px (labels, hairlines, contrast).

**Next:** demo-org scheduled reset job (the real sales-call reliability fix — needs seed refactor for org-scoped rebuild); consider surfacing "viewing one property — back to all properties" affordance after /map/open sets scope.

## 2026-08-10 — AI reasoning everywhere: rationale on every action, causal answers in Ask, stage-move reasons

**Built:** (1) **`rationale` on every AI action** (schema + migration + framework): each propose() site now records the plain-language why — leasing replies (intent read + grounding units + tour logic), maintenance triage (keyword → category/priority rule that fired), payments outreach (dunning-ladder tone grading + plan-bounds reasoning), plan proposals (bounds math), renewal outreach (matrix + personalization), counter evaluation (band floor arithmetic), call analysis (signals → flags), and every Ask answer. The /ai review queue renders it as a bordered **Why:** line on each pending card; history rows carry a Why subline + full text on hover. (2) **Ask StayLeased reasoning lane**: analytical phrasing ("why…", "what's driving…", "should we…") no longer gets a snapshot dodge — deterministic explainers reconstruct the 30-day occupancy story (move-ins/outs vs notice pipeline, with the lever to pull) and the month-over-month collections story from point-in-time metrics and lease dates; the live model only rephrases (fallback = the analysis itself), numbers never invented; the receipts table stays attached (`matched: occupancy+why`). (3) **Stage moves carry reasons**: implicit lead transitions (new→contacted on first outreach, →touring on tour booking) now go through setLeadStatus with a reason, so the timeline reads "Status → touring (tour booked for Aug 11 10:00)" instead of silently flipping.

**Investigated first (live, in Henry's Chrome):** Ask verified WORKING on stayleased.com in both lanes — structured ("why is occupancy down" → occupancy handler table) and freeform ("what should i focus on today" → live-model answer grounded in FACTS, POST /ask.json 200). The reported "doesn't work" is answered by the reasoning lane (why-questions got table dodges) + the demo-world flapping documented 2026-08-10 (deploy-window transitional data).

**Verified:** tsc clean · unit 187/187 (4 new in `tests/ai_reasoning.test.ts`) · e2e ai+askdock+crm+smoke 21/21.

**Next:** rationale on the dashboard AI-at-work feed rows (currently links into the queue, which shows Why); demo-org scheduled reset (still the open sales-reliability fix).

## 2026-08-10 — Client-ready audit: imported residents get working portal logins, whole-workflow gate

**The audit (as a client would live it):** sign up with the partner code → upload a real-world rent roll (title row, `#`-prefixed units, currency strings, a two-tenant household, an expired term, a vacant) → is the org actually operational? Found one blocker and one dead end, plus a stale nav assertion. **The blocker:** residents created by every import lane (rent roll, residents sheet, lease PDFs) and even by lease activation had `user_id = NULL` — activation generated a temp password, hashed nothing anywhere reachable, and *discarded it*. A client who "uploads their documents and is started" had a portfolio full of residents who could never sign in, and no staff-visible credential to relay. **The dead end:** portal invites (with the one-time password) land in the Message Console, but `/dev/messages` was `devOnly` → live orgs got a 403 on the only place the credential exists.

**Built:** (1) **`ensurePortalAccess`/`sendPortalInvite`** (`src/modules/people/portal.ts`): idempotent, email-keyed portal provisioning — live orgs mint a real one-time credential (`sl-…`), demo orgs keep `demo1234`; the invite email (subject "Your resident portal is ready — {property}", body carries the temporary password) is recorded per resident. Wired into **all four entry paths**: rent-roll import (primary tenant), residents-sheet import (non-occupants), lease-PDF import (primary), and lease activation. Import flashes count them ("N portal invites sent"). (2) **Message Console opened to live orgs** (read-only: the two GET routes lose `devOnly`, keep `dev:console`; sim writes stay demo-only) with a live-aware subtitle explaining it's the outbox record until live rails ship. (3) **Staff controls on the resident page**: "Create portal access & send invite" and "Reset portal password" (flash shows the new one-time credential once) on the Contact card, with a hint when no email is on file. (4) Onboarding checklist copy now states invites happen automatically. (5) **`e2e/clientready.test.ts` — the audit as a permanent gate**, 5 walks: signup→upload→apply (3 leases, 4 residents, 3 invites), operational org (carried balances on /delinquency, Balanced ✓ books with conversion accounts, MTM rollover), vendors CSV→dispatchable list, **an imported resident actually signs in with the credential read from the Message Console and lands in the portal**, and a 57-screen empty-state sweep of a fresh live org (200 + no error page on every registered screen).

**Also fixed:** `e2e/setup.test.ts` module-bar assertion predating grouped dropdowns — it scanned all modulebar text so the "Marketing" *group header* inside Leasing tripped the "no top-level Marketing tab" check; now asserts on `.mtab-btn` labels only (the actual tabs).

**Decisions:** #23–24 (portal provisioning centralized + idempotent; Message Console readable by live orgs as the credential delivery record).

**Verified:** tsc clean · unit 191/191 (4 new in `tests/portal_access.test.ts`: live OTP verifies against the stored hash, idempotency, no-email no-op + email-linking, demo demo1234) · **full e2e board 167/167** (fresh run, ~8 min) including clientready 5/5 · walk-5 sweep covers every module screen for a data-empty live org.

**Next:** live email rail so invites actually send (console is the stopgap); demo-org scheduled reset (still the open sales-reliability fix); owner read-only login.

## 2026-08-10 — Demo-led sales motion + de-anthropomorphized agent roster (marketing)

**Built:** CTA retarget from self-serve demo to demo-led sales (Henry's call, 2026-08-10): "Book a live demo" is now the primary CTA in the header, mobile menu, footer, hero, agents band, Ask band, subpage `ctaRow`, and the booking form (h3 "Book a live demo", submit "Request a demo", thanks copy "your demo"); the self-guided demo stays open but demoted to secondary line-buttons and quiet links (hero secondary when signup is closed, hero-note link when open, approval band, verification band, final band, subpage CTA band, legal page). Agent roster de-anthropomorphized: the humanlike role titles ("The collections clerk", "The renewals desk") are retired for `AI · function` kickers; agents h2 → "AI agents for the work a small building can’t staff."; lead → "Software, not staffing…"; hero vignettes ("AI agent · demo portfolio", "AI draft · Zillow lead · 9:04 pm"), Ask vignette ("AI portfolio assistant"), and the floating sales chat ("StayLeased’s AI assistant", header "AI · …") now self-identify as AI. `ask.ts` sales prompt + canned answers invite demo bookings instead of demo sign-ins; in-page chat failure copy no longer points at the demo. Privacy-policy wording follows ("demo requests"). New CSS: quiet underlined link style for `.mk-hero-note a` / `.mkp-cta p a` only.

**Decisions:** #25.

**Verified:** tsc clean · unit 191/191 · marketing e2e scope 38/38 (homepage, mkpages, marketing, navmenus, rebrand, smoke) under the seeded env · desktop + mobile screenshots of hero, agents, and booking band inspected · impeccable detector run over changed files (all findings pre-existing brand-system patterns, untouched by doctrine).

**Next:** the real demo gate (private access code; Henry keeps a bookmarkable link) as its own build when Henry calls it; demo-org scheduled reset remains the open sales-reliability fix; e2e pin updated (`AI agents for the work a small building can’t staff.`).

## 2026-08-10 — v4 "Control-first, bolder" (marketing, on top of unmerged demoled)

**Built:** Superpowers-planned refinement for AI-skeptical buyers (Henry approved design 3-for-3). (1) **Control-first argument order:** the approval band moved from section 07 to 01 — first band after the hero is now "Nothing reaches a resident without sign-off." with the 9:04 pm draft card; kickers renumbered 01–07; band backgrounds re-alternated; hero sub leads with "an approval queue the operator controls"; hero's third vignette became the Maintenance Agent 2:14 am triage (the 9:04 pm lead now lives solely in the approval band — no adjacent duplication). (2) **Architecture table sharpened at the EliseAI-shaped cluster (unnamed):** point-solution cell "One function — leasing or maintenance"; NEW rows "The books" (Included / Not included — a PMS still required / Included — true double-entry) and "Bills to pay" (One, plus AI add-ons / Two — the AI layer and the PMS under it / One); every cell defensible from vendors' public sites. (3) **Bolder visuals, same system:** hero h1 to clamp(48px,6.4vw,92px); vignettes get emerald-tinted depth + top edge-light (dark variant too); dark governance band gains a second bottom ember + hairline top light; table gets row hover wash + pure-CSS scrolling edge shadows; **mobile table: sticky pinned label column (150px) + px-pinned data columns** so the StayLeased column is reachable without losing row meaning (auto-layout was dumping the min-width surplus into the label column — diagnosed via computed styles, not screenshots). ui-ux-pro-max consulted (trust-authority landing order, overflow-scroll table guidance); impeccable craft-floor + detector applied. Hub/switching copy inspected and left alone — already control-first ("Help that drafts, you approve").

**Decisions:** #26.

**Verified:** tsc clean · unit 191/191 · marketing e2e 38/38 (homepage incl. new order assertion + new approval-h2 pin, mkpages, marketing, navmenus, rebrand, smoke) · batched screenshot round desktop 1440 + mobile 390, light + dark (hero, approval, table, governance) with one fix batch (mobile table) + confirm · impeccable detector: only pre-existing brand patterns (gradient numerals, dark-kicker gradient, draft-rail border, Space Grotesk) — deliberately untouched.

**Next:** Henry uploads the cumulative controlfirst zip (supersedes demoled zip — includes it); demo gate + demo-org reset unchanged from prior entries.

## 2026-08-11 — Import first-contact fixes: the Yardi build (parser correctness + no data loss + verify-framed review)

**Built (driven by Henry's live Station U & O import test — real Voyager 7S "Rent Roll with Lease Charges"):**
1. **xlsx parser correctness (`lib/xlsx.ts`) — the root cause.** The cell/row regexes greedily consumed the `/` of self-closing tags (`<c r="A6" s="6"/>`), read them as OPEN tags, and swallowed the next real cell — inheriting the empty cell's column and dropping `t="s"`. Yardi styles every empty cell, so values shifted columns on most rows (deposits/balances/move-outs landing under the wrong headers) and shared-string indexes leaked as literals ("Sq Ft"→"16", "Total"→"27"). Fixed with lazy attr captures + self-closed-row handling + row padding by `r=`. Regression test hand-builds the exact Yardi shape.
2. **Stacked two-row headers** (`mergeStackedHeader`): "Resident/Deposit", "Unit/Sq Ft", "Lease/Expiration" merge before mapping, on both the AI-plan path (guarded against section rows) and the heuristic path (accepted only when it strictly increases mapped fields). With merged headers the **Yardi preset** now fires (its `resident→tenant` mapping removed — in Voyager exports Resident is the t-code column; value-shape tie-breaks prefer person-shaped samples for tenant and non-zero samples for money fields).
3. **Charge-code-aware sub-row harvest** (`harvestSubRowCharges`): block-based — each unit's charges are gathered (the unit row's own Amount is just one charge, often parking, NOT rent), the portfolio's rent code is inferred (modal across blocks, rnt*-prefix tie-break), rent is promoted from whichever row carries it, and every other code folds into a new "Other monthly charges" column → imported as a second `lease_charges` row (kind `other`) that the monthly billing job posts alongside rent, prorated and idempotent. Barriers: Total rows dropped; digit-less "units" (section labels, "Summary Groups") close the fold window and are error-skipped by the validator instead of becoming units.
4. **Move-out dates import** (the audit's `import_apply` `move_out_date: null` finding): mapped column → `leases.move_out_date`, status notice, billing stops at move-out; past-date move-outs warn.
5. **AI-read gap-fill**: after an AI plan wins, a free synonym pass over the merged headers fills columns the plan left unmapped. `amount` added to rent synonyms (a rent roll's bare Amount column is the charge amount).
6. **Review screen verify-framing**: "N of M columns mapped automatically" line, per-row provenance pills (AI / AI assist / preset / auto), "this screen is verification, not data entry" copy.

**Reconciliation against the real file (heuristic path, no live AI):** 110 unique units · rent **$149,365.00 exact** vs Yardi's rntnt summary · extras **$1,260.00 exact** vs tsprkg · 119 total rows dropped · 8 future/applicant duplicates error-skipped · 3 move-outs captured. Penny-perfect to the source system's own summary block.

**Decisions:** #27–28.

**Verified:** tsc clean · unit 201/201 (10 new: parser corruption fixture, stacked headers ×2, merged-Yardi mapping, money tie-break, harvest ×4, move-out+extra-charges apply/billing) · e2e setup+clientready+workingmodel+goldenpath+smoke 25/25 · real-file replay reconciles to the penny. Accounting flake fired twice mid-session (documented; passes on rerun).

**Next:** Henry re-imports Station U & O AFTER deploying (the applied import predates the parser fix — its rows are column-shifted; use a fresh property or org) · resident-directory import for emails → portal invites · PDF-lane extra_monthly support · Lease PDFs/vendors lanes still untested against Dantes data.

## 2026-08-11 — Migration Center UX: history, read-only records, declutter + live-org professionalism

**Built (Henry: "can't see what you uploaded in the past… so much text everywhere" + "looks demo, not production, we have actual clients"):** (1) **Import history** on the hub — every batch (staged/applied/discarded) with status chip, result summary from the stored apply summary ("2 properties · 110 units · 108 leases · $99,367 in deposits held · N skipped"), and Review/View actions; shared `summaryBits()` powers the flash, the history row, and the record. (2) **Read-only batch records**: applied/discarded batches render a record page (status, applied date, result, reader notes, the exact column mapping used) instead of redirecting away — "what did I upload and what did it do" now has an answer. (3) **Hub declutter** (Operate-mode scanability): one-line lane copy, source systems + template + AI pill compressed to a single muted line, the five-input checklist collapsed into a `<details>`, the preset tile grid and Live-connections tile removed, tab labels shortened, form hints tightened. (4) **Live-org professionalism**: "Message console" → **Outbox** (nav + title; live subtitle reframed as the delivery record, rolling-out language), AI chat "Demo brain" → "Built-in engine". Routes, tab keys, and button labels unchanged — e2e URL/selector compatible.

**Decisions:** #29.

**Verified:** tsc clean · unit 226/226 (flake reran green) · e2e clientready (extended: history presence, result summary in the row, read-only record renders, no Apply button on applied) + setup + goldenpath + smoke 18/18 · hub screenshot eyeballed (one card, one collapsed checklist — was ~5 blocks of prose). First selector draft hit Playwright `:has-text` substring matching ("View" ⊂ "Overview") — scoped to `a.btn-ghost[href*="/setup/import/b/"]`.

**Next:** the full production-readiness sweep Henry asked for (scope question pending — operational screens polish, portal surface, empty states/onboarding, speed feel).

## 2026-08-11 — Migration Center round 2: property auto-detection + dropzone (Henry live-feedback build)

**Built:** (1) **Property read from the file** — new default "Read it from the file" radio on the rent-roll lane: the AI plan's new `document_property` field (title banner, e.g. "Station U & O (1022)") with a deterministic fallback (`detectDocumentProperty`: pre-header banner scan, report/date lines skipped, trailing "(code)" stripped) resolves the target property — matched case-insensitively to an existing property or queued for creation, with the decision surfaced as a review-screen note; a mapped Property column always wins; manual existing/new modes unchanged. (2) **Dropzone uploader** (Migration Center + lease-PDF lane): drag-drop with drag-over state, chosen-file feedback, keyboard-accessible (`:focus-within` ring), ≥44px target per ui-ux-pro-max rules — replaces the native Choose-File button. Specificity lesson: `.field > label { display:block }` beat `.dropzone` — selector is `label.dropzone`. (3) Heuristic-path reader notes now render on review (was AI-callout-only).

**Decisions:** —.

**Verified:** tsc clean · unit 228/228 (2 new: banner detection incl. template-null case, plan document_property validation) · e2e clientready+workingmodel+setup+smoke 20/20 (explicit prop_mode flows untouched; dropzone keeps `input[name=file]` for setInputFiles) · hub screenshot with computed-style diag (display:flex confirmed) · impeccable detector: only pre-existing theme patterns (security build's), dropzone block clean.

**Next:** production-readiness sweep waves per `claude/production-readiness-sweep-plan.md` (Henry's scope: daily-work screens, onboarding/first-week, speed).

## 2026-08-11 — Residents lane learns to MERGE: tenant-directory contact info onto existing residents

**Built (Henry uploaded rent roll + tenant directory live; "not much is filled in"):** the Residents lane previously only INSERTED new people onto leases — a tenant-directory upload either errored rows or duplicated everyone, and the one thing it was needed for (emails onto the rent-roll-created primaries → portal invites) had no path. Now `validateResidents` matches each directory row against the unit's active-lease household by order-insensitive name (`nameKey`: "Beltran, Angel" ≡ "Angel Beltran"), and matched rows become MERGE plans: fill blank email/phone (never overwrite non-blank), audit `import_contact_merge`, and provision portal access + invite the moment an email lands on a non-occupant. Preview says exactly what will happen per row ("Matches Angel Beltran on the lease — email and phone will be added"); already-complete matches error-skip with a friendly note; genuinely new people still insert with their role. Apply flash + history gain "N contact updates" via `contactUpdates` on ApplySummary.

**Verified:** tsc clean · unit 229/229 (new gate: rent roll creates email-less primary → directory in "Last, First" format merges email+phone, no duplicate, `user_id` provisioned, portalInvites 1, only the new occupant counts as created) · e2e clientready+workingmodel+setup+smoke 20/20.

**Next:** Henry re-runs the tenant directory after deploying (his live attempt predates the merge — check Residents for duplicates; if duplicated, fresh-property redo is cleanest, now fast with property auto-detect).

## 2026-08-11 — Agent scoring #1: delinquency scorer (shadow-first) ✅

**Built:** `m19_scoring` — the first scorer of the agent-scoring architecture (`claude/agent-scoring-architecture.md`). `delinquency_assessments` table (one row per lease per business day, unique-indexed, idempotent under the poller); `assessDelinquency` pure rule engine — five components (exposure, age, pattern, hard events, trajectory) replace the single days-past-due signal; buckets clear/watch/engage/escalate assigned by NAMED rules with deterministic reason sentences; paydown modifier (≥25% in 14d holds one level down); transition law (upgrades jump, downgrades step one level with explicit recovery criteria; settled balance bypasses). `score_delinquency` job registered after the m8 money jobs. New setting `delinquency_scoring` — `{mode:'shadow'}` default writes assessments + workbench chips and changes NOTHING else; `mode:'active'` makes the payments agent read the bucket as a fact: watch=friendly nudge (no plan pressure), engage=firm+plan, escalate=NO resident-facing prose — an escalation-packet ai_action (confidence 0.6, pinned below the auto floor) whose approval opens the collection case. Cross-guard: active-mode escalation holds renewal offers (createRenewalOffer throws, batch route skips with "N held" flash, renewals agent returns null) — closing the audit gap where nothing stopped a renewal offer to a household 60 days behind. Delinquency workbench gains a Score column with reason tooltips and a shadow-mode caption.

**Verified:** tsc strict clean · unit 258/258 (full suite; the 2 first-run reds were the documented pre-existing accounting date-ordering flake, green solo and on re-run) · e2e 42/42 across smoke, payments, ai, pricing, clientready, goldenpath, workingmodel · 29 new tests in tests/scoring.test.ts covering every rule, both modes, the auto-floor pin, and the workbench render.

**Next:** ship → watch shadow chips on the live org for 2–4 weeks → flip `delinquency_scoring.mode` to 'active' per org when the chips read true. Scorer #2 per the spec: lead heat (event-driven + nightly decay). Note for the live org: the scorer needs no backfill — first job run scores every open balance from the imported ledger.

## 2026-08-11 — Agent scoring #2: lead-heat scorer (shadow-first) ✅

**Built:** Scorer #2 in `m19_scoring`. `lead_assessments` (one row per open-pipeline lead per business day) · `assessLeadHeat` — hot/warm/cold by named rules (tour intent or booked tour + verified fit + ≤72h engagement = hot; rapid inbound = hot; no fit now-or-coming / 14d silence / exhausted cadence = cold), upgrades jump, cooling steps one level per day · `computeLeadInputs` — **structurally text-free** (intent flags via the lib'd `detectLeadIntent`, inventory fit from unit status, counts and dates; message text never enters the struct, so protected-topic content cannot move a bucket — a test proves a Section 8 voucher mention changes nothing) · `score_lead` nightly job + event hooks on lead.created / lead.inquiry / message.inbound (lead threads) so the hot end is current the moment engagement happens · heat chips with reason tooltips on the Lead inbox and Leasing Center (shadow-safe) · active mode (`lead_scoring.mode='active'`): Leasing Center orders hot > warm > unscored > cold, and a hot lead answered ≥24h ago with silence since gets exactly one `ai:call_hot_lead` task — a phone call, not another email. `detectLeadIntent` moved to `src/lib/lead_intent.ts` (m17 imports m19, so m19 importing m17 would cycle); m17 re-exports.

**Verified:** tsc strict clean · unit 279/279 full suite (2 first-run reds were the documented pre-existing accounting flake, green on re-run) · e2e 36/36 across smoke, crm, ai, clientready, goldenpath, workingmodel · 21 new lead-heat tests (50 total in tests/scoring.test.ts) including the fair-housing invariance test and active/shadow behavior splits.

**Next:** deploy both scorers together (single combined package supersedes delinqscore) → shadow-watch chips → flip modes per org when chips read true. Scorer #3 per the spec: asset + vendor (maintenance). Deferred deliberately: cold-lead cadence pausing, waitlist job on unit-flip, hot-lead demand telemetry into the pricing queue — each recorded in the spec's consumer graph.

## 2026-08-12 — Migration Center: remove an upload (the document goes, the import stays)

**Built (Henry: "need a way in the migration center to remove the documents"):** the hub listed every
batch forever with no way to delete one — and a batch row is not a pointer to a document, it *is* the
document: `import_batches.rows` holds the entire grid the file carried (every resident name, email,
phone, deposit and balance), and the lease-PDF lane additionally stores the real PDFs via `putFile`.
Nothing in the app could remove either. Now: **Remove** on every Import-history row and on the
read-only record → a confirm screen (`GET/POST /setup/import/b/:id/remove`) that states exactly what
goes and what stays, in the house pattern for destructive acts — a server-rendered interstitial, no
script dialogs. Ceremony scales with consequence: **staged/discarded** uploads wrote nothing, so the
screen itself is the confirmation; an **applied** upload takes the typed file name, the same confirm
the property danger zone uses, and the screen promises in as many words that the properties, units,
leases and residents it created stay. `removeBatch` deletes the batch row and, on the PDF lane, every
stored file — in one tx — and audits `import_batch/remove` with metadata only (kind, filename, status,
row + file counts), never contents. New `deleteFiles(ids)` in `lib/files.ts` is the first path in the
codebase that deletes a stored file: blob AND row together, because a row without bytes is a dead
download link and bytes without a row are unreachable data that still holds resident PII. (`rmSync`
with `force:true` — the repo hand-declares `node:fs` and has no `unlinkSync`.)

**Decisions:** #35 (amends #29 — read the entry before touching applied-batch behavior).

**Doclog hazard, recorded:** #35 was claimed against the CURRENT tail (#34) per the parallel-session
rule. Note that the two builds shipped on 2026-08-12 (`7ed567c` SEO/UX pass, `ff0a7cb` import
integrity + headline) landed their CODE via web upload but **not** their BUILDLOG/DECISIONS entries —
the import-integrity plan expected to claim #38+, so ~#35–38 of judgment is unrecorded in this file
and those numbers are now taken. When those entries are reconstructed they need fresh numbers, not
their originals.

**Verified:** tsc strict clean · unit 307/307 (4 new in `tests/import_remove.test.ts`: staged removal
with no typed confirm + audit carries the file name and never the contents · applied removal refuses a
mismatched name then succeeds on the exact one, with units/leases/residents/JE counts asserted
unchanged afterwards · lease-PDF removal deletes both `files` rows and both `.bin` blobs · hub lists a
Remove action and the route is org-scoped on GET and POST) · e2e setup + clientready + workingmodel +
goldenpath + smoke. The clientready extension is deliberately arranged so walk 1 removes the applied
rent-roll upload and walk 2 — dashboard, delinquency balance, balanced books, leases — then proves the
portfolio survived it.

**Next:** unchanged — live-org recovery (this is the tool for cleaning up the corrupted Station U&O
uploads once the property is gone), then the Yardi root-cause replay when the files arrive.

## 2026-08-12 — Removing an upload takes the import back out with it (supersedes the morning's split)

**Built (Henry: "when a file is removed I think it should update the data live to remove it and not
keep it in there, cuz there are already gates you have to jump through to delete it"):** the removal
shipped earlier today deleted the document and deliberately left what it imported — two halves the
operator had to delete separately. Henry overruled it, correctly: the typed-name confirm IS the gate.

The blocker was that nothing recorded which rows came from which upload. So: **`import_batch_id` on
properties, floorplans, units, leases, lease_charges, residents, household_members, charges,
journal_entries, vendors and users** (additive migrations in `db.ts`), stamped at every insert across
all five apply paths — rent roll, vendors, resident directory, opening balances, lease PDFs. Charges
and their journal entries are stamped through `stampCharge` (createCharge posts with
`sourceKind='charge'`); the deposit conversion entries already posted with `sourceId = batch.id`;
portal logins go through a new `portalAccessFor` so only a login the import actually MINTED is
stamped (a pre-existing account merely gets linked, and is never claimed).

`import_reverse.ts` then takes an import back three ways, deliberately reusing what exists instead of
duplicating it: **(1)** properties the import created are handed to `deleteProperty` — the ~80-table
books-safe cascade with its own payments/manual-JE refusal; **(2)** rows added into properties that
already existed are deleted by stamp in dependency order, narrow by design, with `foreign_keys=ON` as
the backstop that turns "something downstream references this" into a refusal instead of an orphan;
**(3)** contact merges have no row to delete — the directory lane fills BLANK fields on existing
people — so the undo blanks them back, and only where the value is still the one the import wrote.
A payment against an imported lease refuses the whole removal.

The confirm screen now counts the footprint live ("1 property · 2 units · 2 leases · 1 restored
contact record") and leads with the real consequence. An import applied before the stamp existed has
no footprint, and the screen says exactly that rather than implying an undo it can't perform.

**Decisions:** #36 (supersedes the corollary in #35 — read both).

**Verified:** tsc strict clean · unit suite · e2e setup + clientready + workingmodel + goldenpath +
smoke. 7 tests in `tests/import_remove.test.ts`, 4 of them new or rewritten this build: an applied
rent roll comes back out whole (property, units, leases, residents, conversion JEs, minted portal
logins) while a SECOND import's property and books sit untouched beside it · a recorded payment
blocks the removal and leaves everything in place · a directory upload un-merges the email and phone
it filled and drops the unused login it minted, while the person themselves — created by the rent
roll, not that upload — stays · a hand-corrected email survives the un-merge. The clientready e2e
gained walk 6, which had to move to the END of the file: it now removes the rent-roll upload and
asserts the property, leases and books are gone, so it can no longer run before the walks that need
that org standing. It also asserts the vendors upload is untouched — the stamp scopes correctly.

**Next:** unchanged — live-org recovery (this now does it in one action: remove the corrupted Station
U&O uploads and the property goes with them, no separate delete), then the Yardi root-cause replay.

## 2026-08-12 — Import reversal: the lease-PDF deposit-entry gap, and saying which property goes

**Found by Henry asking the right question** ("I believe it is built in where if I remove PDF/source
documents in the future the property will remove — if not, make that the case"). Verifying instead of
answering from memory turned up a real gap in the reversal that shipped an hour earlier.

**The bug:** the lease-PDF lane posts its own security-deposit conversion entries
(`postBothBases`, `sourceKind='conversion'`, `sourceId=batch.id`) — but the `import_batch_id` stamp
for conversion entries was only applied in `applyRentRoll`. Removing a lease-PDF upload therefore took
out its leases, units and residents and **left the deposit entries on the books**: deposits held
against leases that no longer existed, on both bases. One line in the PDF lane's apply, and a test
that asserts the property's journal-entry count returns exactly to its pre-upload value.

**The answer to the question, made visible.** Removing an upload removes the property when the upload
CREATED it, and only then — the PDF lane always imports into a property that already exists, so it
owns its leases and units but not the building. That is correct (pulling one lease PDF must not delete
a 110-unit property) but invisible from outside, so the confirm screen now names both sides: which
property is being removed *because this upload created it*, and which one *stays* because it didn't.
`importFootprint` gained `propertyNames` / `keptPropertyNames` for it.

**Decisions:** #37.

**Verified:** tsc strict clean · unit suite · e2e setup + clientready + workingmodel + goldenpath +
smoke. `tests/import_remove.test.ts` is now 9 tests, 2 new: a lease-PDF upload applied through its own
route then removed — unit, lease and stored PDF gone, deposit entries back off the books, the host
property and the rent roll's own unit untouched · a second rent roll into an EXISTING property removes
its rows and leaves the building, with the first upload's unit still there.

**Next:** unchanged — the Station U&O recovery is a direct property delete (those uploads predate the
stamp and their confirm screen says so); Yardi root-cause replay when the files arrive.

## 2026-08-12 — graphify installed project-scoped: a queryable graph over the codebase

**What.** `Graphify-Labs/graphify` (PyPI `graphifyy`, CLI `graphify`, v0.9.41) installed **project-scoped**
rather than into a user profile: skill at `.claude/skills/graphify/` (SKILL.md + 8 reference docs),
`PreToolUse` hooks in `.claude/settings.json`, pointer in `.claude/CLAUDE.md`, doctrine section appended
to root `CLAUDE.md`. It builds a knowledge graph of the repo — tree-sitter AST parsing, Leiden community
detection — and answers `query` / `path` / `explain` against it instead of grepping. First build:
**2371 nodes, 12122 edges, 118 communities in 12s**, zero LLM calls.

**Three things changed from what the installer wrote**, each because this repo is not a single-machine repo:

1. **The hook command was `/root/.local/bin/graphify`** — an absolute path inside this ephemeral
   container. Committed as-is it would have fired a hook error on every Read/Grep/Glob/Bash for every
   parallel session and on Henry's machine. Rewritten to
   `command -v graphify >/dev/null 2>&1 && graphify hook-guard <mode> || true`: portable, and a silent
   no-op where the CLI isn't installed. Nothing in this install is required to work on the repo.
2. **`graphify-out/` is gitignored** — 14M of generated artifact (graph.json, graph.html, a wiki tree,
   a SHA256 cache) that `graphify update .` rebuilds in 12s from nothing. Each clone builds its own.
3. **The generated CLAUDE.md section asserted "This project has a knowledge graph at graphify-out/"** —
   false on a fresh clone, and this file is the engineering memory. Rewritten to say what is actually
   committed, what has to be built, and what costs an LLM call (`label` / `cluster-only` / full
   `/graphify .` do; `update` does not).

**One real gap found and closed.** The first build warned that `src/db/schema.sql` contributed nothing —
`tree_sitter_sql` ships as an extra, not a default. `uv tool install "graphifyy[sql]"` and a rebuild
brought the schema in: +137 nodes, +201 edges. The install line in CLAUDE.md carries the `[sql]` extra
so the next person doesn't silently lose the schema. (`hook-guard` is non-blocking without `--strict`,
which was deliberately not used — it would gate the first raw file read of every session behind a query.)

**Decisions:** #38.

**Verified:** tsc strict clean · unit suite 310/312 · `graphify explain "ensurePortalAccess"` resolves
`src/modules/people/portal.ts:L45` with its callers including `import_apply.ts`, matching this file's own
account of the import pipeline · `graphify query` returns a scoped subgraph over the setup lane. No
product source changed — `git diff origin/main -- src tests e2e scripts package.json` is empty, this
build is `.claude/`, `CLAUDE.md`, `.gitignore` and the logs, so no suite could be affected by it and
e2e was not run.

**Flake note, worth recording:** the two known accounting failures (`AP void/reissue`, `bank feed
reconcile`) went red on **both** full-suite runs today, not the documented ~1-in-3. They still pass
solo — one solo run red, the next green — so it is the same order/timing flake, but it is running much
hotter than CLAUDE.md's estimate on 2026-08-12. Pre-existing on main and out of scope here; flagged
because "re-run once before believing a red" may no longer be enough of a filter.

**Next:** unchanged — Station U&O recovery, then Yardi root-cause replay when the files arrive.

## 2026-08-12 — SessionStart hook: web containers arrive with deps and a current graph

**Why.** Claude Code on the web starts every session from a fresh clone: no `node_modules`, no
`graphify` CLI. Two consequences, both hit live in this session — `npx tsc --noEmit` reported five
phantom errors that were only a missing `pdf-lib`, and the graphify `PreToolUse` guards no-opped
because the binary they check for did not exist. `.claude/hooks/session-start.sh` closes both before
the session takes its first turn.

**What it does**, in order: `npm install` (not `ci` — warm containers are cached and skip the work) ·
`uv tool install "graphifyy[sql]"` when `graphify` is absent, falling back to pipx · `graphify update .`
· persists `PATH` through `$CLAUDE_ENV_FILE`.

**Three properties it holds.** (1) **Web only** — the `CLAUDE_CODE_REMOTE` guard means a local
machine gets a silent exit 0 and nothing is installed behind anyone's back. (2) **Never fatal** —
every step is `|| echo WARN`, because tooling that stops a session from starting is worse than the
tooling being absent. (3) **Cheap when warm** — SessionStart also fires on resume/clear/compact, so
the graph rebuild is skipped unless a file under `src`/`tests`/`e2e` is newer than `graph.json`.
That one condition took the warm re-run from **9.5s to 0.35s**; cold is 17.1s, and a real source
change still rebuilds in ~9s.

**Decisions:** #39.

**Verified** against a genuinely cold container (`rm -rf node_modules graphify-out` +
`uv tool uninstall graphifyy`): hook exit 0 in 17.1s · `npm run typecheck` clean · `tests/migration.test.ts`
29/29 · graph 2375 nodes / 12125 links with `src/db/schema.sql` present (403 refs) · remote guard
silently no-ops with `CLAUDE_CODE_REMOTE` unset and with it set to `false` · warm re-run 0.35s and
prints `graph current` · `touch src/lib/db.ts` triggers the rebuild as intended.

**Note for whoever restores CI:** this hook is the honest description of what a fresh container needs
to run the gates — `npm install` first, everything else after.

## 2026-08-12 — Clear all portfolio data: the onboarding loop's reset

**Built (Henry: "i just want it cleared so that there is no property or data in the account so i can
test other rent rolls and uploading documents"):** the Station U&O uploads predate the provenance
stamp, so removing them could not take their data back, and clearing an org by hand meant a property
delete per property plus the leftovers. `clearOrgData` in `m2_portfolio/service.ts` does it in one
action: every property through `deleteProperty` (once per property — the tested ~80-table cascade
stays the only code that knows that map) plus the org-level residue a property delete leaves standing
by design — vendors, vendor price agreements, and the Migration Center's uploads with their stored
files. Keeps the org, staff accounts and roles, the chart of accounts, settings, and the audit trail.

Surfaced as a **Danger zone on Admin → Settings**, matching the property danger zone's vocabulary
exactly (typed-name confirm, `btn-danger`, no script dialog) — Operate mode pays for consistency, not
invention. Typed confirm is the ORGANIZATION name. Demo orgs are refused outright and told why: the
seeded world runs the public demo, and no typed confirm should be able to take it down. Success lands
on the Migration Center, since the only reason to clear is to import again.

Unlike the per-property delete this passes `force` — see #38 for why that rail exists for one building
and not for the whole portfolio.

**Decisions:** #40.

**Verified:** tsc strict clean · unit suite (2 new in `tests/org_clear.test.ts`: two imported
properties + a vendor + a recorded payment all cleared, with the org, its staff, their roles, the
chart of accounts and an audit row surviving and the trial balance empty rather than unbalanced · the
route refuses a mismatched org name, lands on /setup/import on success, and refuses the demo org even
with its name typed correctly) · e2e setup + clientready + workingmodel + goldenpath + smoke ·
impeccable detector clean on the changed file.

**Test-writing note worth keeping:** an assertion on rendered copy must not span a line break in the
template — `/disabled on the demo organization/` failed against real output where the source wrapped
between "demo" and "organization". Match a phrase that cannot straddle the wrap. (Two sibling traps
from today: the removal flash names the file it removed, so a body-text check for the filename matches
itself; and the org "Cedar Yard Management" contains the property name "Cedar Yard", so matching a
property name hits the nav chrome on every page.)

**Next:** the org settings page itself — Henry flagged it as unpolished and full of raw JSON. Scope
question open with him: typed controls for the settings an operator actually sets, everything
structural behind an Advanced disclosure.

## 2026-08-12 — Org settings become a settings page (all 40 typed, no JSON)

**Built (Henry: "org settings are not polished and also are filled with code. what is the point of
that page and should it be editable?"):** the point is real — it is the org's policy layer, the
numbers that decide what residents are charged, when, and how much the AI does on its own, with
per-property overrides. It should absolutely be editable; the alternative is emailing support to
change a late fee. What it was, though, was a database console: every key rendered as raw JSON in a
text box, `bah_table` at the same visual weight as the late fee, no units, no bounds, no statement of
consequence, and a typo in `late_fee_policy` a silent change to what every resident is charged.

New `m1_admin/settings_spec.ts` describes each of the 40 keys once — group, plain-language label, what
changes in the product when it changes, and its control — and both the form and the parse are
generated from that single description, so a control and its validation cannot drift apart. Ten
groups (Rent/fees/payments · Deposits and move-out · Leasing and screening · Renewals and pricing ·
Communications · Pets · Insurance · AI and automation · Approval thresholds · Specialty housing).
Money in dollars, stored in cents through `parseUsd` (#13 unchanged); days as days; percentages as
percentages. Henry chose full typing over an Advanced JSON hatch, so nothing takes JSON:
`payment_application_order` is numbered positions with a duplicate-position error,
`tour_hours.days`/`business_hours.days` are weekday checkboxes, `followup_cadence_days` is a comma
list, and `bah_table` is a matrix with per-row edit, remove, and an add row. `screening_criteria.
version` is declared `preserve` — schema, not a control — and survives a save.

Page structure is one card per group with hairline-separated setting blocks inside (a card per
setting would nest cards, which the craft floor rules out) and a per-setting Save, keeping the
existing per-property override model: the override badge now reads "overridden here" and the clear
button reads "Use the organization default". Errors come back as a sentence about that setting.

**Decisions:** #41.

**Verified:** tsc strict clean · unit suite (6 new in `tests/settings_page.test.ts`: the coverage
assertion that every key has exactly one spec and no spec is dead · the page renders group headings
and labels with $50.00 in dollars and no `name="value"` JSON input anywhere · saves across scalar
money, mixed-type object, preserved schema field, unchecked-box booleans, weekdays, comma list and
ranked order · bad money, an out-of-range integer, a duplicated rank position and an unknown key all
refused with the stored value unchanged · the BAH matrix edits, removes and adds a pay grade · a
property override saves, is badged, and hands back to the org default) · e2e smoke + hubs +
clientready + goldenpath · impeccable detector: three findings, all pre-existing theme patterns
(timeline border-left, the app font, a legacy gradient), none in this diff.

**Next:** the settings page is the last of Henry's live-feedback items. Back to the standing queue:
Yardi root-cause replay when the files arrive, then the production-readiness sweep.

## 2026-08-12 — Code review of the settings + reset builds: 14 findings, all fixed

**Ran `/code-review` over the two builds above; it earned its keep.** The serious ones, in order of
what they would have cost:

1. **The late-fee control offered a structure the engine ignores, and dropped one it implements.**
   `lateFeeCandidates` branches on `flat | flat_plus_daily | percent`. The select offered a
   "daily only" option (no branch → no late fee ever assessed, silently) and omitted `percent`, so an
   org on a percentage policy would have been rewritten to `flat` with its `percent` field dropped on
   any unrelated save. Options now match the engine and `percent` is an editable field. (#40a)
2. **Partial property overrides rendered fabricated defaults.** `getSetting` replaces a stored object
   wholesale, and m17 writes `ai_autonomy` as a partial (`{leasing:'auto'}`), so the other three dials
   rendered as code defaults — and saving the screen would have pinned them, downgrading autonomy the
   org had set to `approve`. New `layerSetting`/`getSettingMerged` in `lib/settings.ts` hold the rule
   once; the page loads both levels in ONE query and layers them. (#40b)
3. **"Clear all portfolio data" left every non-import blob on disk.** `deleteProperty` deletes `files`
   ROWS by raw SQL and cannot reach the file store, so signed leases, ID scans and unit photos
   survived as unreachable bytes — the exact condition #35 forbids, in the one operation whose
   purpose is purging. New `sweepOrphanBlobs()` runs at the end of the reset.
4. **Scope holes.** The settings routes took any `property` id with no `canAccessProperty`, the
   property list ignored `propFilter`, and `/admin/settings/clear-data` had no scope check at all — a
   property-scoped ORG_ADMIN could rewrite every property's late-fee policy and wipe the portfolio.
   All four now check; the reset additionally requires `allProperties`.
5. **Blank ≠ zero.** `Number('')` is 0, so clearing the income-multiple box would have stored 0 and
   passed every applicant on income. Blank is now refused for `pct`/`num`/`money`; negative money is
   refused too (a negative approval threshold inverts the rule it configures).
6. **The BAH matrix parsed the STORED rows, not the submitted ones** — so a pay grade added by
   someone else after page load was read as blank and zeroed. It now parses the rows the form
   actually carried and leaves unseen rows alone; `__proto__` is stored as data (null-prototype
   accumulator) instead of silently vanishing, and amounts with no pay-grade name are an error rather
   than a silent drop.
7. **Honesty:** `payment_methods`, `autopay_day`, `admin_fee_cents` and `renewal_offer_lead_days` have
   no consumers in `src/`. Under the old JSON dump they were opaque keys; typed labels turned them
   into promises. They now carry a "not enforced yet" badge and say so in their help text.
8. Smaller: `specCoverage` now also catches a spec whose `group` the page never renders (the type is
   a union, not `string`); the doc comment no longer claims a page-level assertion that only exists
   in the suite; the matrix add row got its own grid template (three children in a four-column grid);
   dead imports and a dead `DAYS` export removed.

**Decisions:** #40.

**Verified:** tsc strict clean · unit suite · e2e. `tests/settings_page.test.ts` 10 tests (4 new for
the review fixes: engine-matched late-fee structures with a percent round-trip · blank and negative
refused across pct/num/money · the matrix leaving unseen rows alone and refusing nonsense keys · a
partial `ai_autonomy` override rendering the org's three dials rather than code defaults) ·
`tests/org_clear.test.ts` 4 tests (2 new: a signed lease's BYTES gone after a reset, and a
property-scoped admin refused with 403).

**Worth remembering:** finding 1 came from authoring a control off the default object's shape instead
of off the code that consumes it. Before shipping a control, read the consumer.

## 2026-08-12 — The DECISIONS collision happened again, and now fails the build

**Event, not a feature.** While this branch was in flight, a parallel session merged PR #4 (graphify +
SessionStart hook) claiming DECISIONS **#38 and #39**. This branch had claimed #38–#40 against a tail
cached before that landed — exactly the hazard CLAUDE.md's parallel-session rule warns about, and its
second occurrence. Rebased onto the new main and renumbered to **#40–#42**, updating the BUILDLOG
cross-references (`**Decisions:** #40/#41/#42`) and the review entry's own `#42a`/`#42b` citations in
the same pass. Both sessions' entries survive; the numbering is contiguous.

**The part worth keeping:** git only surfaces this as a conflict while the two appends touch the same
lines. Resolve it carelessly — or append after a clean auto-merge — and the file quietly carries two
#38s. `tests/doclog.test.ts` now asserts DECISIONS is numbered 1..N with no duplicates and no gaps,
that every `#N` cited from either log resolves to a decision that exists, and that BUILDLOG headers
are unique. A collision is now a red suite instead of a thing someone notices months later.

**Deliberately NOT done:** a `merge=union` driver in `.gitattributes` for these two files. It would
auto-resolve the text and thereby destroy the signal — two sessions claiming #38 would merge cleanly
into a file with two #38s. The conflict is the useful part; the test is the backstop.

**Verified:** tsc strict clean · unit 329/329 on the rebased tree · e2e re-run against the new base.
