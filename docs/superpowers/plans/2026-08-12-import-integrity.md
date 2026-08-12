# Import Integrity Build — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans / subagent-driven-development. Checkboxes track steps.

**Goal:** Make the live import flow trustworthy after the 2026-08-11 real-data run corrupted rents ($300 parking-as-rent ×4), deposits ($0 vs $99,367), balances ($14.50 uniform vs $331,028.41), and duplicated 247 residents — and give Henry the in-product tools to redo it (property delete, review-time reconciliation).

**Architecture:** Three layers. (1) Structural: the AI reading plan can no longer bypass the deterministic Yardi intelligence — stacked-header merge is attempted regardless of the plan's row classifications, and the winning read gets a re-merge pass; (2) Guardrails: review screen + record gain a computed reconciliation strip and mis-mapping warnings (all-zero money columns, uniform-value columns, mass-insert directory rows) that turn silent corruption into review-time stops; (3) Recovery: audited, typed-confirm, books-safe property delete surfaced on the property page and Migration Center, plus hub naming cleanup and Residents table parity (sort / page size / CSV). Root-cause replay fixes land when Henry's real files arrive.

**Tech stack:** existing TS server-rendered app; node:test unit; Playwright e2e (import scope: setup, clientready, workingmodel, goldenpath, smoke).

## Global Constraints

- Import doctrine: parser changes survive the Yardi fixture (#27) · rent = rent-code amount (#28) · imports approval-gated · applied imports read-only (#29) · directory rows MERGE before inserting.
- Every new destructive action lands on the audit trail; property delete requires typed property name + `properties:manage`.
- Books stay balanced: property delete removes the property's JEs (they carry property_id) and its residents/leases/units/files; org-level rows untouched.
- No regression to homepage pins or marketing scope (untouched files).
- Base: `7ed567c` (origin/main).

### Task 1 (main session): AI-path structural fixes
**Files:** `src/modules/setup/ai_reader.ts` (applyReadingPlan), `src/modules/setup/import.ts` (post-winner re-merge), `tests/import_ai_path.test.ts` (new)
- [ ] applyReadingPlan: try mergeStackedHeader(base, rows[header+1]) FIRST; if it merges, consume the row even when plan.sections or plan.skip_rows claimed it (a sub-label row is never a property section); note stays "Merged a stacked two-row header."
- [ ] import.ts after winner selection: if winner is AI and its headers didn't merge, run mergeStackedHeader on winner headers + first data row; if merged AND autoMap over merged headers maps strictly more fields → adopt merged headers, drop the consumed row, remap gaps (existing gap-fill continues to run after).
- [ ] Tests: plan-with-section-on-sublabel-row still merges; AI winner with unmerged stacked headers gets re-merged; harvest then folds sub-rows (grid with charge rows survives to harvest).

### Task 2 (main session): Review-time reconciliation + sanity warnings
**Files:** `src/modules/setup/import_apply.ts` (validateRentRoll additions), `src/modules/setup/import.ts` (review + record render), `tests/import_recon.test.ts` (new)
- [ ] Compute on validation: units, occupied, monthly rent total, extra-monthly total, deposits total, balances total, move-outs. Render as a strip on review ("Check these against the last page of the report you exported") and on the applied record.
- [ ] Warnings (level=warn rows + a banner): any mapped money column ≥90% zeros while column header suggests money ("Deposit column mapped from 'Other' — every value is $0"); any money column where ≥80% of non-zero values are identical ("98 of 102 balances are $14.50 — usually a mis-mapped column"); ≥3 rents equal to the same value ≤$500.
- [ ] Tests: fixture grids trigger each warning; clean grid triggers none.

### Task 3 (main session): Directory mass-insert guard
**Files:** `src/modules/setup/import_apply.ts` (validateResidents), `tests/import_recon.test.ts`
- [ ] When >50% of rows with found unit+lease would INSERT a new person, add blocker-grade banner: "N of M people don't match anyone on their unit's lease — applying would duplicate residents. This usually means a name-format mismatch between the files." Applying stays possible only after a new explicit confirm checkbox (`confirm_duplicates=1`).
- [ ] Tests: mass-insert grid trips the guard; matched/merge grid does not; confirm flag allows apply.

### Task 4 (subagent A, worktree): Property delete — books-safe, audited
**Files:** `src/modules/m2_portfolio/service.ts` (deleteProperty), `src/modules/m2_portfolio/pages.ts` (confirm UI on /properties/:id/edit + POST /properties/:id/delete), `src/modules/setup/import.ts` (Migration Center "Start over" card linking to it), `tests/property_delete.test.ts`
- [ ] deleteProperty(ctx, propertyId): single tx; delete rows where property_id=pid across leases/household_members-via-leases/units/floorplans/buildings/work orders/files/journal entries (+lines)/lease_charges/assessments/etc. (enumerate by schema grep); residents left with no remaining household_members anywhere are deleted (their portal user rows too); audit event `property.deleted` with counts; refuse when property has payments recorded after import (payments table rows with property's lease ids and source != import) unless `force`.
- [ ] UI: on property edit page, "Danger zone — Remove this property" typed-name confirm form; Migration Center gets a muted "Imported wrong? Remove the property and start over" link when a property exists that was created by an import batch.
- [ ] Tests: seeded property fully deleted; trial balance unchanged after delete of import-only property (JEs removed both sides); resident on two properties survives with one household; typed-name mismatch refuses; audit row written.

### Task 5 (subagent B, worktree): Residents table parity
**Files:** `src/modules/people/pages.ts`, `tests/residents_table.test.ts` or e2e assertion extension
- [ ] /residents: click-to-sort on Resident, Unit, Property, Role, Balance (server-side ?sort=&dir=, stable, indicator arrows a11y-labeled); rows-per-page selector (25/50/100/All → ?per=) wired to existing pagination; "CSV" export button (current filter+sort, all pages) matching the reports pattern.
- [ ] Tests: sort orders correctly incl. balance numeric; per= changes page size; CSV response has header + N rows and respects filter.

### Task 6 (main session): Hub naming clarity
**Files:** `src/modules/setup/import.ts` (labels/copy)
- [ ] Rename confusing surfaces: tab labels + lane titles reviewed against what they accept ("Rent roll" accepts xlsx/csv/pdf — say so); CSV template buttons named after the lane ("Blank rent-roll template (CSV)"); file-type chips consistent; "More residents" lane renamed "Resident directory" (matches Yardi's own export name) with sub "Emails, phones, and co-tenants for people already on leases — or brand-new residents."
- [ ] e2e copy pins for the renamed labels (update existing setup e2e selectors if they reference old names).

### Task 7: Root-cause replay (BLOCKED on Henry's files)
- [ ] Replay both files through parse → plan(sim/none) → merge → harvest → validate; diff against Yardi summary; fix exact failures; commit sanitized fixtures reproducing the shapes (no PII).
- [ ] PDF-lane: verify aiReadPdfTable prompt/plumbing against the real PDF (live key needed on prod; code-level checks + post-deploy live verification steps documented).

### Task 8: Gates + package + recovery runbook
- [ ] tsc · full unit · e2e setup/clientready/workingmodel/goldenpath/smoke (+ scoring untouched) · new tests green.
- [ ] Patch + zip vs `7ed567c`, doclog paste-in (#38+), deployment-doc update with the live-org recovery sequence: deploy → delete Station U&O → re-import rent roll (review strip must tie) → directory (expect contact updates, not inserts) → verify totals → OTP walk.
