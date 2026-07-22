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

**Fixed along the way:** e2e harness now clones the pristine seeded DB per test file (`ORIEL_E2E_ISOLATE`) — goldenpath's business-date advances were bleeding into later files' expectations; seed guarantees Maya Torres (portal demo cast) a renewal offer.

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

**Fixed along the way:** partial autonomy overrides originally shadowed the whole org object (a Cardinal `{leasing:'auto'}` implicitly reset payments/renewals) — autonomyFor now merges layers; intent detection missed plurals ("dogs"); event hooks stay dormant until the world is seeded so earlier phases can't trigger agents retroactively; Ask Oriel respects property scope per asker (a scoped manager asking about an out-of-scope property gets their own portfolio — by design, tested).

**Verified:** 112 unit + 99 e2e green, §9 invariants intact. Gate live end-to-end: Alicia's queue card quotes a unit the test proves is vacant-ready at her property with live pricing and pet policy; Approve sends the reply into the console AND books the M3 tour; a simulated inbound inquiry lands in the queue via the hook; "I smell gas near the stove" triages emergency with the never-optional guardrail and an audited WO note; 40/40 call transcripts carry summaries/sentiment/tags with real follow-up tasks; Ask Oriel's three cross-module answers equal DB truth to the cent; the AI Activity KPIs match ai_actions exactly, and draft-only approvals mark reviewed without sending.

**Next:** Phase 17 — vertical modes (M18).

## 2026-07-21 — Session 1 · Phase 17: Vertical modes ✅

**Built:** M18 complete (list in STATE.md). Design notes: every vertical is conditional behavior keyed on Property.type or unit flags — assignBed refuses non-student properties, assertAffordableCompliance no-ops on market units, the PCS action rides the existing lease-action registry — so the core modules never forked. The affordable gate is enforced where money becomes real (lease activation) rather than in UI validation, which means the API, jobs, imports and future flows all inherit it; renewal offers, batches, and the pricing engine each clamp/skip program units independently so no path can drift a regulated rent. The waitlist's compliance answer is structural: positions are immutable, out-of-order offers throw, and skips demand written reasons — the audit log always explains "why was #4 housed before #2".

**Fixed along the way:** the affordable seed originally selected only vacant units (rent NULL trivially "complied") — occupied-first selection with per-unit lowest-fitting AMI band made the set-aside real; seeded cert incomes now derive from each unit's band so income-qualification can't randomly fail; two vacant set-asides are reserved so the certification gate can be demoed live.

**Verified:** 117 unit + 104 e2e green, §9 invariants intact. Gate live: a bed assigned on the board becomes an individual-liability lease that activates on the next day's advance — the student's portal shows only their bed's ledger and the parent logs in with the guarantor banner; an over-limit lease refuses to activate with the exact limit math in the error, the 5-document certification completes in the browser (over-income households cannot certify) and activation unblocks; the waitlist refuses out-of-order offers; a PCS break sets notice with zero fee charges and a confirmation letter.

**Next:** Phase 18 — hardening, full regression, README tour, handoff.

## 2026-07-21 — Session 1 · Phase 18: Hardening & handoff ✅ — BUILD COMPLETE

**Done:** the final gate ran green from a fresh clone in one pass: seed 63s → strict typecheck → 123 unit/integration tests → 104 Playwright e2e (every phase gate re-verified). Performance: two hot-path indexes cut the +30-day time-machine advance from 51s to 38s; per-job costs profiled and documented; all hot pages < 500ms. Security: a dedicated sweep proves org isolation + permission guards on every surface added since Phase 10, including SQL-injection-shaped input to the report builder (closed expression surface + parameterization holds). A11y: automated 18-page scan; error pages gained lang + h1; everything else was already clean via the shared UI kit. The README now carries the scripted 15-minute demo tour, URL-verified per persona. parity.md maps every Entrata product to its Oriel module with honest gap notes.

**The numbers:** 19 phases, 18 modules + framework, ~120 tables, 50 canonical reports, 7 AI agents, 5 vertical modes, 23k+ journal entries over 14 months of deterministic history, 123 unit + 104 e2e tests, all §9 invariants continuously green, one `npm run seed` to rebuild the world byte-for-byte.

**Handoff:** README (tour) → STATE.md (full checklist) → docs/parity.md (fidelity + gaps) → docs/metrics.md (every number's definition) → DECISIONS.md (the judgment calls). Fin.

## 2026-07-21 — Session 1 · Post-handoff: zero-terminal local run

**Done:** the user wanted it running on their own computer with no terminal work, so the delivery zip is now "install Node, double-click." Added `Start-Oriel.command` (macOS/Linux) and `Start-Oriel.bat` (Windows): both verify Node ≥ 22.11, probe whether `--experimental-strip-types` is still needed (Node 24 LTS strips types by default; the flag may vanish in future majors), install/seed only when missing, hop ports if 3000 is busy (mac), open the browser, and keep the window open on errors. `scripts/noderun.mjs` gives the npm scripts the same version-adaptive flag logic. The zip additionally bundles `node_modules/pdf-lib` (the only runtime dep, vendored so first run needs no npm); the demo world builds on first launch (~1 min — a pre-built `data/` bundle proved too heavy for the 30 MiB delivery limit). HOW-TO-RUN.txt is the plain-language cover sheet. Verified end-to-end from a fresh copy: cold seed path, instant-boot path, and a curl login → dashboard flow.

**Observation for the log:** two same-commit seeds run minutes apart produced slightly different aggregate history (11,402 vs 11,557 charges; 655 vs 667 settlement batches) while the demo cast, invariants, and every tested fixture held identical — so "deterministic" holds at the entity/cast level the tests pin, but some wall-clock coupling (likely `nowIso()` ordering feeding batch cuts) jitters the long-tail aggregates. Shipped world = the launcher-built one whose counts match the final-gate run (23,441 JEs / 655 batches). Worth a dig if exact byte-level reproducibility ever matters.
