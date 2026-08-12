# Lead-Heat Scorer (m19_scoring #2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scorer #2 of the agent-scoring architecture: a deterministic lead-heat scorer (hot/warm/cold) that allocates staff attention and after-hours autonomy scope — shadow-first, event-driven plus nightly decay.

**Architecture:** Extends `src/modules/m19_scoring/service.ts` with `assessLeadHeat` (pure rules), `computeLeadInputs` (reads leads/lead_events/tours/units/followup_tasks — never message text beyond deterministic intent flags), a `score_lead` nightly job plus event hooks (`lead.created`, `lead.inquiry`, `message.inbound` for lead threads), and `lead_assessments` rows consumed by the CRM lead list and Leasing Center (chips in shadow; hot-first ordering + hot-silence phone-call task in active).

**Tech Stack:** House rules — zero new deps, additive schema, node:test, no LLM anywhere in scoring.

## Global Constraints

- `detectLeadIntent` moves to `src/lib/lead_intent.ts` (m17 imports m19's `latestAssessment`, so m19 importing m17 would cycle; the regexes are deterministic and belong in a lib). m17 keeps working via the lib import — behavior unchanged.
- **Structural fair-housing guarantee:** `LeadHeatInputs` contains NO free text — only intent booleans, inventory fit, counts, and dates. Protected-topic content (vouchers/Section 8, disability, children) can never move a bucket because it never enters the inputs; a test proves a voucher-mentioning message scores identically. Buckets modulate effort, never truth: no reply-content change anywhere.
- `source` is recorded in components for analytics but does NOT enter bucket rules (behavioral + inventory only decide the bucket).
- Shadow (`lead_scoring.mode='shadow'`, default): assessments + chips only. Active: Leasing Center orders hot-first and a hot lead silent 24h after an outbound gets a phone-call task. Cadence pausing for cold leads is deliberately deferred (recorded in DECISIONS).
- Transition law: upgrades jump (any fresh engagement can go straight to hot); downgrades step one level per assessment day (hot→warm→cold — decay IS the recovery criterion here).
- Buckets: `hot | warm | cold`. Leads with status `leased|applied|lost` are not scored.

## Rules (first match wins)

- HOT — `hot_engaged_fit`: (wantsTour OR upcomingTour) AND fitNow AND hoursSinceInbound ≤ 72 · `hot_rapid_inbound`: inboundLast24h ≥ 2.
- COLD — `cold_no_fit`: !fitNow AND !fitComing · `cold_stale`: daysSinceInbound ≥ 14 · `cold_cadence_exhausted`: openCadenceTasks = 0 AND daysSinceInbound ≥ 7.
- WARM — `warm_engaged` (default).
- daysSinceInbound counts from max(last inbound event, created_date) so a brand-new unanswered lead is not "stale".
- fitNow: a `vacant_ready` unit at the property matching `leads.beds` (any beds when null). fitComing: same match on `status='notice'` units.
- Reasons: `Hot: asked to tour; fit now; last inbound 3h ago.` · `Cold: no 3-bed ready or on notice.` · `Warm held (step-down/day): was hot, engagement cooling.`

### Task 1: Move detectLeadIntent to a lib

**Files:** Create `src/lib/lead_intent.ts` (move `LeadIntent` type + `detectLeadIntent` verbatim from `src/modules/m17_ai/agents.ts:41`); Modify agents.ts to import from the lib (keep re-export for any other importers); Test: existing `tests/ai*.test.ts` stay green + one import test in `tests/scoring.test.ts`.

- [ ] Failing test: `import { detectLeadIntent } from '../src/lib/lead_intent.ts'` detects tour intent.
- [ ] Move code; agents.ts: `import { detectLeadIntent, type LeadIntent } from '../../lib/lead_intent.ts';` and `export { detectLeadIntent };` for compatibility.
- [ ] Green + full ai tests green; commit "refactor: detectLeadIntent → lib (m19 needs it without an m17 cycle)".

### Task 2: Schema + setting

**Files:** `src/db/schema.sql` append; `src/lib/settings.ts` (`lead_scoring: { mode: 'shadow' }` after delinquency_scoring); `tests/scoring.test.ts`.

```sql
CREATE TABLE IF NOT EXISTS lead_assessments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  as_of_date TEXT NOT NULL,
  bucket TEXT NOT NULL, -- hot|warm|cold
  prev_bucket TEXT,
  components TEXT NOT NULL,
  rule_fired TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_lead_assess ON lead_assessments(lead_id, as_of_date);
CREATE INDEX IF NOT EXISTS ix_lead_assess_org ON lead_assessments(org_id, as_of_date);
```

- [ ] Failing test (table + unique index + setting default) → implement → green → commit.

### Task 3: assessLeadHeat pure function

**Interface:**

```ts
export type HeatBucket = 'hot' | 'warm' | 'cold';
export interface LeadHeatInputs {
  wantsTour: boolean; asksPrice: boolean; asksAvailability: boolean; asksPets: boolean; wantsHuman: boolean;
  fitNow: boolean; fitComing: boolean; fitBeds: number | null; upcomingTour: boolean;
  inboundCount: number; inboundLast24h: number; hoursSinceInbound: number; daysSinceInbound: number;
  openCadenceTasks: number; ageDays: number; source: string;
}
export function assessLeadHeat(inp: LeadHeatInputs, prevBucket: HeatBucket | null): { bucket: HeatBucket; ruleFired: string; reason: string; components: LeadHeatInputs }
```

- [ ] Failing tests: each rule above; upgrade jump cold→hot on rapid inbound; step-down decay hot→warm (not hot→cold in one day) with `step_decay` rule; warm→cold next day; reason formats.
- [ ] Implement (RANK hot 2 / warm 1 / cold 0 — note INVERTED vs delinquency: "upgrade" = hotter; decay steps DOWN one per day) → green → commit.

### Task 4: computeLeadInputs

**Sources:** intent flags = OR of `detectLeadIntent` over `leads.message` + every `lead_events` body with kind `email_in|sms_in`; upcomingTour = EXISTS tours status='scheduled' with date ≥ businessDate; inbound counts/dates from lead_events; openCadenceTasks from followup_tasks status='open'; fitNow/fitComing per rules above; ageDays from created_date.

- [ ] Failing tests: seeded lead with tour-ask message + vacant-ready 2BR → wantsTour/fitNow true; **fair-housing invariance: two identical leads, one message appends "we have a Section 8 voucher" → identical inputs and identical bucket**; a lead with no inbound events → daysSinceInbound from created_date.
- [ ] Implement → green → commit.

### Task 5: score_lead job + event hooks

- Job `score_lead` (registered after score_delinquency): scores every lead with status IN ('new','contacted','touring','toured'); upsert per (lead_id, date) preserving first-write prev_bucket; summary `"N scored: H hot · W warm · C cold · T transitions"`.
- Hooks: `on('lead.created')` + `on('lead.inquiry')` rescore that lead immediately; `on('message.inbound')` → if the thread's person_kind='lead', rescore person_id. Hook rescores are same-day upserts through one shared `scoreOneLead(ctx, leadId)`.
- `latestLeadAssessment(ctx, leadId)` reader.

- [ ] Failing tests: job idempotency + transition tracking (mirror delinquency's); leased/lost leads never scored; `lead.inquiry` emit rescores same day (insert lead via `intakeLead`, assert assessment exists without running the job).
- [ ] Implement → green → commit.

### Task 6: chips (shadow) + ordering/escalation (active)

**Files:** `src/modules/m3_crm/pages.ts` (lead list + Leasing Center); `src/modules/m19_scoring/service.ts` (escalation task creation inside score_lead when active); `tests/scoring.test.ts`.

- Lead list + Leasing Center rows get a heat chip (hot→accent, warm→warn, cold→muted) with the reason tooltip; subtitle notes shadow mode (same phrasing as the workbench).
- Active mode only: Leasing Center query orders hot-first (bucket rank desc, then existing order); inside score_lead, a hot lead whose last lead_event is outbound ≥24h old with no inbound since gets ONE open `followup_tasks` row kind `ai:call_hot_lead` (dedupe on an existing open row of that kind).
- [ ] Failing tests: HTTP render shows chip + tooltip + shadow caption on /leads; active ordering puts a hot lead above an older warm lead in the Leasing Center; the phone-call task appears once and never duplicates; shadow ordering unchanged.
- [ ] Implement → green → commit.

### Task 7: Gates + package

- [ ] tsc clean · full `npm test` (rerun known accounting flake) · e2e: smoke, crm, ai, clientready, goldenpath, workingmodel.
- [ ] BUILDLOG (unique header) + DECISIONS (source-not-in-rules; cadence-pause deferred; structural no-text inputs) + deployment-doc update.
- [ ] format-patch + `leadheat-build-files.zip`; SendUserFile; project docs.

## Self-review

Spec §3 coverage: components ✓ (source recorded, excluded from rules — recorded deviation), buckets/cadence ✓ (compressed to ordering + call task v1; cadence pause + waitlist job deferred, recorded), fair-housing ✓ (structural + test), demand telemetry to pricing → deferred with waitlist (future scorer consumer work), shadow-first ✓. Types consistent: `HeatBucket`, `LeadHeatInputs`, `latestLeadAssessment`, `scoreOneLead`.
