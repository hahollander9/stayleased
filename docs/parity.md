# Fidelity map — StayLeased vs the Entrata product suite (§11)

Functional-parity checklist, kept current per phase. Every module is original
work on deterministic simulators; names, copy and code are StayLeased's own.

| Entrata product | StayLeased module | Status |
| --- | --- | --- |
| Entrata Core / Accounting, Budgeting, Job Costing | M9 | ✅ Dual-basis GL, AP w/ approvals + payment runs, bank rec to $0, period close, budgets + variance, capital projects w/ commitments |
| LeadManager + Leasing Center | M3 | ✅ Guest cards, ILS feed sim, cadences, tours, quotes, round-robin center, funnel/ROI/agent analytics, call logs |
| LeaseExecution | M6 | ✅ Versioned templates + conditional addenda, packet PDFs, built-in e-sign (hash-chained), lifecycle + activation, renewals |
| ResidentPay | M8 | ✅ Processor sim (auth/NSF/chargeback), settlements + fees, late fees, autopay, plans, lockbox, deposits/dispositions, delinquency workbench |
| ProspectPortal + OXP Studio | M4 | ✅ Public sites w/ live pricing, tour booking, CMS studio, SEO/JSON-LD/sitemap, syndication manager, corporate search site |
| ResidentVerify | M5 | ✅ Tokenized multi-applicant app, screening bureau sim, OCR income verify, fraud flags, versioned criteria scorecards, adverse action, holds |
| ResidentPortal + RXP | M7 | ✅ Mobile portal: pay/autopay/statements, requests w/ photos + timeline, lease self-service, NTV, household changes, insurance, usage, comm prefs. Rewards/Homebody: not replicated (gap) |
| Facilities + SiteTablet | M10 | ✅ WO lifecycle w/ SLA + on-call, dispatch board, tech My Day, turns w/ COI gating, PM, inspections→damages, inventory, vendor portal |
| ResidentUtility + Utility Expense | M11 | ✅ Submeter sim + anomaly queue, provider invoices→AP, RUBS w/ day-level proration, vacant recovery, portal usage |
| Renters Insurance / Master Policy / Deposit Alt / Guaranty | M12 | ✅ Carrier sim verify, master-policy enroll + lapse auto-enroll, deposit alternative w/ claims, institutional guaranty rescue |
| Revenue Intelligence (+Student pacing) | M13 | ✅ Transparent factor engine, comp market sim, review queue w/ overrides, term-rate expiration smoothing, capped renewal batches, analytics; student pre-lease pacing lives on /student |
| Entrata BI + Reporting | M14 | ✅ Full §10 catalog (50 reports, one engine), as-of-date correctness + MetricSnapshots, custom builder, scheduled delivery, role dashboards, docs/metrics.md |
| Message Center | M15 | ✅ Unified threads, shared inbox, templates w/ org overrides, segments + mass w/ consent + quiet hours, announcements, automation audit |
| Procure to Pay + Bill Pay | M16 | ✅ Catalog POs w/ approval chains, vendor ack, receiving→inventory, OCR invoices, 2/3-way match + exceptions, early-pay terms, remittance, 1099 |
| ELI / ELI+ / Essentials | M17 | ✅ MockLlm agents (leasing/maintenance/payments/renewals) w/ autonomy dials + supervised queue, call analysis, content studio, Ask StayLeased |
| Vertical solutions | M18 | ✅ Student (full, on Cardinal) + Affordable (full, on Foundry set-aside); military/commercial/manufactured per-spec-depth — see gaps |
| Open API / integrations | M1.8 | ✅ REST v1 + API keys + HMAC webhooks + /developers reference |
| Access Connect (smart access) | M7.5 | Simulated at the amenity-reservation level only (gap: no lock hardware sim) |

## Vertical-mode depth (M18)

**Student — full.** By-the-bed individual liability leases (bed_label),
academic-year terms, assignment board, roommate questionnaire + suggested
groupings, parent/guarantor portal role, pre-lease pacing vs target curve.

**Affordable — full workflow.** LIHTC set-aside flags per unit with AMI bands,
deterministic rent-limit schedule, income certification (checklist + income
qualification) gating move-in at activation, annual recert job with due dates,
utility allowances reducing max tenant rent, audit-safe waitlist (immutable
positions, documented skips), compliance grid. *Gap:* no state-agency export
file formats (XML/NIFA-style) — the compliance grid + CSV stands in.

**Military — workflow depth.** PCS-orders lease break on any lease (30-day
gate, orders document on file, NO early-termination fee, audited, resident
confirmation), BAH reference schedule (simulated table), allotment-style
payments ride autopay. *Gaps:* no BAH-indexed rent schedules per unit; no
inspection cadence template pack.

**Commercial — worksheet depth.** CAM reconciliation worksheet: budgeted vs
actual OpEx allocated by leased sqft → per-suite true-up invoices/credits
(preview). *Gaps:* posting gated on a commercial property (none in the demo
portfolio); % rent on reported sales not implemented (stretch); no
CAM-estimate recurring charge line.

**Manufactured — schema depth.** Lot/home split flags, resident-owned-home
flag, title/serial fields on the unit record. *Gap:* no manufactured
community in the demo portfolio; behaviors surface when a property adopts the
type.

## Other logged gaps

- Rewards / renter credit reporting (Homebody/RXP extras): not replicated.
- Smart-home/access hardware: not simulated.
- Real payment/screening/email rails: intentionally simulator-only per spec.
- ELI voice (live call handling): call ANALYSIS only; no live voice agent.
