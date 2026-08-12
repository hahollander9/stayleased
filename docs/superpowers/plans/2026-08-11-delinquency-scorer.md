# Delinquency Scorer (m19_scoring) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scorer #1 of the agent-scoring architecture (`claude/agent-scoring-architecture.md` in the project): a deterministic daily delinquency scorer whose persisted bucket + reason the payments agent, renewals agent, and delinquency workbench consume — shadow mode by default, behavior changes only when the org flips the setting to active.

**Architecture:** New module `src/modules/m19_scoring/` with a pure rule function (`assessDelinquency`), a ledger-reading input assembler, and a `score_delinquency` job that upserts one `delinquency_assessments` row per lease per business day. Consumers read the latest row: `draftCollectionsOutreach` (tone/plan/escalation in active mode), `createRenewalOffer` + batch route + `draftRenewalOutreach` (suppression in active mode), `/delinquency` workbench (score chips in both modes).

**Tech Stack:** House rules — TypeScript on node:sqlite, zero new dependencies, additive schema, node:test.

## Global Constraints

- Schema is additive: `CREATE TABLE IF NOT EXISTS` appended to `src/db/schema.sql`; no new columns on existing tables (so no `MIGRATIONS` entry needed).
- Scorers are deterministic — no `llm()` call anywhere in m19_scoring.
- Shadow mode (`delinquency_scoring.mode='shadow'`, the default) changes ZERO behavior: drafts, tones, plans, renewals all identical to today. Only assessments are written and chips shown.
- The confidence floor: escalation-packet proposals carry confidence 0.6 so they can never auto-execute (framework auto-executes only ≥ 0.7).
- Buckets: `clear | watch | engage | escalate`. Upgrades may jump; downgrades step one level per day and require recovery criteria; raw `clear` (balance ≤ 0) bypasses stepping.
- Reason strings are deterministic sentences built from the fired rule + component values; they are what staff sees and what any agent may quote.
- Job ordering: `score_delinquency` registers AFTER m8 payments jobs (import order in `src/server/modules.ts`), so late fees/autopay/plans mutate first, scorer reads after, on the same business day.

## Deviations from the spec doc (record in DECISIONS.md)

1. The spec's B-trigger "no payment in 21 days with balance open" is dropped: at monthly-rent grain a 21-day payment gap is a normal cycle, and age ≥ 15d subsumes the real signal.
2. The spec's C-action "pause autopay retries" is a no-op here: `runAutopay` fires once per month per enrollment (`ae.day_of_month=?`) — there are no retries to pause.
3. Active-mode tone ladder retires `final`: the legacy >45d "final" band is exactly bucket `escalate`, which now produces a staff packet instead of resident-facing prose.

---

### Task 1: Schema + setting + module scaffold

**Files:**
- Modify: `src/db/schema.sql` (append table + index at end)
- Modify: `src/lib/settings.ts` (SETTING_DEFAULTS, after `ai_renewal_max_discount_pct`)
- Create: `src/modules/m19_scoring/service.ts`
- Modify: `src/server/modules.ts` (side-effect import after the m8 payments import, line 39)
- Test: `tests/scoring.test.ts`

**Interfaces produced:** table `delinquency_assessments(id, org_id, lease_id, as_of_date, bucket, prev_bucket, components, rule_fired, reason, created_at)` with `UNIQUE(lease_id, as_of_date)`; setting `delinquency_scoring = { mode: 'shadow', noticeThresholdDays: 45 }`.

- [ ] Failing test: `delinquency_assessments` exists in sqlite_master with the unique index; `getSetting(ctx,'delinquency_scoring').mode === 'shadow'`.
- [ ] Append to schema.sql:

```sql
-- M19: agent scoring — behavioral delinquency assessments (scorer #1).
-- Distinct from GL aging buckets (agingRows): that is the accounting view.
CREATE TABLE IF NOT EXISTS delinquency_assessments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  lease_id TEXT NOT NULL REFERENCES leases(id),
  as_of_date TEXT NOT NULL,
  bucket TEXT NOT NULL, -- clear|watch|engage|escalate
  prev_bucket TEXT,
  components TEXT NOT NULL, -- JSON: every input the rules saw
  rule_fired TEXT NOT NULL, -- machine key, e.g. 'exposure_2x'
  reason TEXT NOT NULL, -- deterministic sentence: staff-visible, agent-quotable
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_delinq_assess ON delinquency_assessments(lease_id, as_of_date);
CREATE INDEX IF NOT EXISTS ix_delinq_assess_org ON delinquency_assessments(org_id, as_of_date);
```

- [ ] Setting default: `delinquency_scoring: { mode: 'shadow', noticeThresholdDays: 45 },`
- [ ] Scaffold service.ts with types only; wire `import '../modules/m19_scoring/service.ts'` in modules.ts.
- [ ] Verify green; commit "feat(m19): delinquency_assessments schema + delinquency_scoring setting".

### Task 2: assessDelinquency pure function

**Files:** Modify `src/modules/m19_scoring/service.ts`; Test `tests/scoring.test.ts`.

**Interface produced:**

```ts
export type DelinqBucket = 'clear' | 'watch' | 'engage' | 'escalate';
export interface DelinqInputs {
  openBalanceCents: number; monthlyRentCents: number; daysPastDue: number;
  lateMonths12: number; nsf6mo: number; nsf60d: number;
  brokenPlan12mo: boolean; activePlan: boolean; clearedPlanInstallment: boolean;
  paidLast14dCents: number; graceDays: number; noticeThresholdDays: number;
}
export interface DelinqAssessment { bucket: DelinqBucket; ruleFired: string; reason: string; components: DelinqInputs & { exposure: number }; }
export function assessDelinquency(inp: DelinqInputs, prevBucket: DelinqBucket | null): DelinqAssessment
```

Rule order (first match wins, deterministic):
- `clear`: openBalance ≤ 0 (`balance_clear`) — bypasses stepping — or daysPastDue ≤ graceDays with balance > 0 (`within_grace`).
- raw `escalate` on any of: exposure ≥ 2.0 (`exposure_2x`), daysPastDue ≥ noticeThresholdDays (`age_notice_threshold`), brokenPlan12mo (`plan_broken`), nsf6mo ≥ 2 (`nsf_repeat`), lateMonths12 ≥ 5 (`chronic_late`).
- raw `engage` on any of: exposure ≥ 0.75 (`exposure_75`), daysPastDue ≥ 15 (`age_15d`), lateMonths12 ≥ 3 (`pattern_3in12`), nsf6mo ≥ 1 (`nsf_one`).
- else raw `watch` (`past_grace`).
- Trajectory modifier: paidLast14dCents ≥ 0.25 × openBalanceCents demotes raw one level (escalate→engage, engage→watch), never below watch; rule key gets `+paying_down`.
- Transition law vs prevBucket (rank clear 0 < watch 1 < engage 2 < escalate 3): upgrades take the new bucket; downgrades step at most one level per assessment AND require recovery: escalate→engage needs activePlan && clearedPlanInstallment (`recovery_plan_started`); engage→watch needs exposure < 0.25 && nsf60d === 0 (`recovery_paid_down`); watch→clear only via raw clear. Failing criteria hold the previous bucket (`hold_recovery_pending`).
- Reason examples (exact format): `Engage: 3rd late month in 12; balance 1.4× rent; 22 days past due.` / `Escalate: balance 2.1× rent; 51 days past due; plan broken.` / `Watch held (recovery pending): paydown below 0.25× rent not reached.`

- [ ] Failing tests, one behavior each: every rule key above; modifier demotes escalate→engage; modifier never demotes below watch; upgrade jumps watch→escalate in one day; escalate→engage blocked without cleared installment; escalate→engage allowed with it; engage→watch blocked with recent NSF; downgrade never skips (escalate→watch impossible even when raw=watch); raw clear bypasses stepping from escalate; within-grace balance = clear; reason strings match expected format exactly.
- [ ] Implement minimal; verify green; commit "feat(m19): assessDelinquency rules, modifier, transition law".

### Task 3: computeDelinquencyInputs

**Files:** Modify `src/modules/m19_scoring/service.ts`; Test `tests/scoring.test.ts` (seeded org/lease per `tests/payments.test.ts` pattern).

**Interface produced:** `export function computeDelinquencyInputs(ctx: Ctx, lease: { id: string; rent_cents: number; property_id: string }): DelinqInputs`

Exact sources:
- openBalanceCents: `leaseBalance(ctx, lease.id)` (import from m8 service — the canonical balance).
- daysPastDue: same semantics as agents.ts:234 — `MIN(due_date)` over active positive charges whose applied (pending|settled) payment_applications sum < amount_cents; 0 when none.
- lateMonths12: `SELECT COUNT(DISTINCT month_key) FROM charges WHERE lease_id=? AND kind='late_fee' AND status='active' AND date >= <businessDate-365d>`.
- nsf6mo / nsf60d: `SELECT COUNT(*) FROM payments WHERE lease_id=? AND status='nsf' AND nsf_date >= <cutoff>`.
- brokenPlan12mo: EXISTS payment_plans status='defaulted' AND created_at ≥ businessDate−365d (compare on date prefix).
- activePlan / clearedPlanInstallment: EXISTS status='active'; EXISTS installment status='paid' joined to that plan.
- paidLast14dCents: SUM payments (pending|settled) with payment date ≥ businessDate−14d (use the payments table's date column; verify exact column name at implementation).
- graceDays: `getSetting('late_fee_policy', propertyId).graceDays`; noticeThresholdDays from `delinquency_scoring`.

- [ ] Failing test: seed lease with 2 months unpaid rent + a late fee in each of 3 months + 1 NSF payment → inputs assert exact values; a second clean lease → daysPastDue 0, balance ≤ 0.
- [ ] Implement; green; commit "feat(m19): ledger input assembly".

### Task 4: score_delinquency job

**Files:** Modify `src/modules/m19_scoring/service.ts`; Test `tests/scoring.test.ts`.

**Interface produced:** job key `score_delinquency`; helper `export function latestAssessment(ctx: Ctx, leaseId: string): { bucket: DelinqBucket; reason: string; rule_fired: string; as_of_date: string } | null` (latest row ≤ businessDate).

Job run: select active leases (status='active') where `leaseBalance` ≠ 0 OR a prior assessment with bucket != 'clear' exists; for each: prev = latest row with as_of_date < today; compute inputs → assess → upsert (`INSERT` new id or `UPDATE` same-day row: bucket/components/rule_fired/reason refresh, prev_bucket preserved from first write of the day). Summary: `"12 scored: 6 watch · 4 engage · 2 escalate · 3 transitions"`.

- [ ] Failing tests: running the job twice on one date leaves exactly one row per lease (idempotent); prev_bucket recorded across two business dates; a lease that pays to zero gets a final 'clear' row and then drops out of scoring the next day; registerJob('score_delinquency') present in jobDefs().
- [ ] Implement + `registerJob` at module load; green; commit "feat(m19): score_delinquency daily job".

### Task 5: payments agent active-mode wiring

**Files:** Modify `src/modules/m17_ai/agents.ts` (draftCollectionsOutreach + new executor); Modify `src/modules/m8_receivables/service.ts` ONLY if a collection-case helper is missing (check for an existing open-case function first); Test `tests/scoring.test.ts`.

Behavior in `draftCollectionsOutreach` after computing `bal`:
- `const scoring = getSetting<{mode:string}>(ctx,'delinquency_scoring'); const assess = scoring.mode === 'active' ? latestAssessment(ctx, leaseId) : null;`
- assess null (shadow/off or unscored) → EXACT legacy path (tone from days, plan per legacy eligibility).
- active + bucket 'watch' → tone 'friendly', planLine null, no plan proposal; rationale/guardrail append `bucket watch per delinquency scorer — ${assess.reason}`.
- active + bucket 'engage' → tone 'firm', plan proposal per legacy eligibility; same rationale append.
- active + bucket 'escalate' → NO outreach, NO plan. Instead one proposal: agent 'payments', title `Escalation packet — ${household} (${usd(bal)})`, confidence 0.6, output `{ kind: 'payments.escalation_packet', leaseId, summary }` where summary = reason + counts (open charges, last payment date, plans, NSFs) + "state notice requirements apply — human review required"; executor `payments.escalation_packet` opens a collection case if none open (reuse existing case-opening code path found in m8; else insert a `collection_cases` row matching its schema) and returns 'collection case opened/noted — human review'.
- `clear` → return null (nothing to send).

- [ ] Failing tests: shadow mode draft byte-identical tone/plan behavior to legacy for a 20d/1.4× lease; active watch → friendly, no plan action; active engage → firm + plan action; active escalate → zero send_outreach/create_plan actions, one escalation_packet at confidence 0.6 that did NOT auto-execute even with autonomy forced 'auto'; executing it opens a collection case exactly once (idempotent on re-run).
- [ ] Implement; green; commit "feat(m17+m19): bucket-driven collections in active mode; escalation packets replace 'final' prose".

### Task 6: renewal suppression guard

**Files:** Modify `src/modules/m6_leases/service.ts` (createRenewalOffer + draftRenewalOutreach guard), `src/modules/m6_leases/pages.ts` (batch route exclusion + flash count); Test `tests/scoring.test.ts`.

- createRenewalOffer: after lease load, if active mode and latest bucket 'escalate' → `throw new Error('renewal held: delinquency escalation — resolve the balance or override by clearing the escalation')`.
- Batch route: exclude those leases from the SELECT loop (per-lease check before create; count skipped; flash `…offers sent · N held (delinquency escalation)`).
- draftRenewalOutreach (m17_ai/agents.ts): same check → return null.

- [ ] Failing tests: active+escalate → createRenewalOffer throws, draftRenewalOutreach null; shadow+escalate → both behave exactly as today; active+engage → offer allowed.
- [ ] Implement; green; commit "feat(m6): renewal offers held for escalated delinquency (active mode)".

### Task 7: workbench score chips

**Files:** Modify `src/modules/m8_receivables/pages.ts` (/delinquency); Test `tests/scoring.test.ts` (HTTP render via tests/harness.ts startTestServer).

- Add a `Score` column after Household: latest assessment bucket as the house badge component (find `statusBadge`'s source and reuse; tone map watch→warn, engage→bad, escalate→bad+bold, clear/none→muted '—') with `title="${reason}"`.
- Subtitle suffix when mode='shadow' and any assessment exists: `· scoring: shadow (chips inform, behavior unchanged)`.

- [ ] Failing test: seeded delinquent lease + one job run → GET /delinquency contains the bucket label and the reason in a title attribute; shadow caption present.
- [ ] Implement; green; commit "feat(m8): delinquency workbench score chips".

### Task 8: gates + package

- [ ] `npx tsc --noEmit` clean.
- [ ] `npm test` — full suite; rerun the known accounting date-ordering flake solo if red.
- [ ] `npm run e2e` batches: smoke + the receivables/portal batch this page belongs to (check `e2e/` list; minimum smoke + clientready).
- [ ] BUILDLOG.md append (unique header: date + "Session · Agent scoring #1 — delinquency scorer") with Built/Verified/Next; DECISIONS.md append the three deviations above + "scorers are deterministic; shadow-first" principle.
- [ ] `git add`-by-file, commit; `git format-patch origin/main --stdout > delinqscore.patch`; zip changed files at repo paths as `delinqscore-build-files.zip`; SendUserFile both; update `claude/stayleased-deployment.md` (PENDING line) + project docs.

## Self-review

Spec coverage: schema/table ✓ (Task 1), rules+modifier+transition ✓ (2), inputs ✓ (3), job+ordering ✓ (4), C-stop+packet+A/B behavior ✓ (5), renewal guard ✓ (6), chips/shadow visibility ✓ (7), deviations recorded ✓ (header + Task 8). Consumers deferred by design: pricing/lead/asset/renewal scorers are later builds. Type names consistent (`DelinqBucket`, `DelinqInputs`, `latestAssessment`) across tasks 2/4/5/6/7.
