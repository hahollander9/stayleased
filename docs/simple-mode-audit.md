# Simple mode — audit and proposal

**Status: proposal. No code written.** Awaiting approval before implementation on branch `simple-mode`.

Target reader: an owner of 5–100 units who has never used property-management software,
who wants five answers in under ten seconds:

1. How much did I make this month?
2. How much cash will I have at month-end?
3. Who owes me?
4. Which units cost me money?
5. What needs attention today?

---

## Part 1 — What is there now

**437 routes** (186 GET, 251 POST). Of the GETs, 8 are resident-portal and 13 are
marketing, leaving **165 staff screens**. The chrome exposes **56 registered nav items**
plus **5 module hubs**, grouped into **8 top tabs** (`Dashboard · Leasing · Residents ·
Financials · Property · Operations · Messages · Reports`) and a gear to `/setup`.

Every row below carries the screen's *own* title or subtitle where it has one — the jargon
column is quoted from the product, not invented.

### Dashboard

| Route | Purpose | Jargon it uses | Main action | Where the owner stalls |
|---|---|---|---|---|
| `/` | Portfolio overview: 5 KPI tiles + per-property comparison table | Occupancy · **Exposure** · **Pre-leased** · Vacant ready · Avg market rent | Click into a property | **Not one of the five questions is on it.** Nothing about money made, cash, or who owes. "Exposure 7%" means nothing to an owner. |
| `/hub/{leasing,residents,financials,property,operations}` | Section landing pages with widgets | "Revenue intelligence", "funnel" | Click a page in the section | A second navigation layer that duplicates the tab dropdown |
| `/myday` | Technician's day list | — | Mark a job done | Correct for a tech; an owner isn't a tech |
| `/map` | Properties on a map | — | Click a pin | Fine. Rarely the thing they came for |

### Financials — 14 screens, the owner's real destination, and the most hostile tab

| Route | Purpose | Jargon it uses | Main action | Where the owner stalls |
|---|---|---|---|---|
| `/receivables` | "Collections & payment analytics" | **Aging**, 1–30/31–60/61–90/90+, allocation | Record a payment | "Receivables" is not a word an owner uses. The aging buckets are a report, not an answer to "who owes me". |
| `/delinquency` | "Delinquency **workbench**" | Delinquency, workbench, notice stage | Start a collections step | "Workbench" is software jargon for a screen |
| `/deposits` | "Deposit accountability" | Accountability, disposition, SODA | Finalize a disposition | They want "deposits I'm holding", one number |
| `/ap` | "Enter vendor invoice" | **AP**, payables, invoice coding, approval threshold | Enter a bill | `/ap` is an abbreviation of an accounting term. It means *bills*. |
| `/gl` | "General ledger — **Trial balance** · accrual basis" | GL, trial balance, accrual, debit/credit | Read it | Unusable without bookkeeping training, and correctly so |
| `/banking` | "BankFeed accounts, statement matching and reconciliation history" | Reconciliation, statement matching | Reconcile | Real work, real jargon |
| `/statements` | Balance sheet / income statement / cash flow / T12 | **NOI**, basis, **T12**, retained earnings | Pick a period, export | This holds the answer to question 1 — behind three words the owner doesn't know |
| `/budgets` | "Annual budgets per property with monthly spreads and variance tracking" | Spread, variance | Enter a budget | Enterprise practice; a 20-unit owner has no budget document |
| `/periods` | "Month-end close — closed periods block postings" | Close, posting, period | Close a month | "Close" sounds destructive |
| `/reserves` | "Designated reserve cash (**GL 1030**) — funded monthly by plan, released by approved draw" | Reserve, draw, GL 1030 | Fund or draw | A GL code in a subtitle |
| `/owners` | "Ownership percentages per property drive per-owner **equity-income statements**" | Equity-income statement, distribution | Set splits | Only matters with co-investors |
| `/utilities` | "**RUBS** billing runs" | RUBS, ratio utility billing | Run a billing cycle | RUBS is an industry acronym, unexplained |
| `/approvals` | POs, vendor invoices, large JEs, deposit deadlines ≤10 days | PO, **JE**, threshold | Approve | **Name collision: this is the *money* approvals queue. `/ai` is the *AI* approvals queue.** Two different things called approvals. |
| `/admin/billing` | What the operator pays StayLeased | Meter, per-unit | Read / subscribe | Correctly placed under the gear |

### Leasing — 7 screens

| Route | Purpose | Jargon | Main action | Where the owner stalls |
|---|---|---|---|---|
| `/leads` | "Log a walk-in / phone lead" | Lead | Log an inquiry | Fine |
| `/tours` | "N upcoming · X% recent **no-show rate**" | No-show rate | Schedule a tour | Fine |
| `/applications` | Application pipeline with screening | **Screening criteria**, income multiple, conditional approval | Decide an application | Dense, but it's a real decision |
| `/leasing-center` | "Centralized cross-property queue — every lead needing a touch today" | Cross-property queue, touch | Work the queue | "Center" and "queue" read as a call-center tool |
| `/leasing/analytics` | "Leasing funnel — trailing N days" | Funnel, conversion | Read it | A report, not a task |
| `/marketing/sites` | "Studio-style CMS: section toggles, text and image slots" | CMS, section toggle, slot | Edit the property website | "CMS" |
| `/marketing/syndication` | Push vacancies to listing sites (simulated) | **Syndication** | Publish a listing | Industry term for "post it on the listing sites" |

### Residents & Messages — 7 screens

| Route | Purpose | Jargon | Main action | Where the owner stalls |
|---|---|---|---|---|
| `/residents` | Adults across all leases | Household, occupant vs. resident | Open a person | Residents vs. leases vs. households — three nouns for overlapping things |
| `/leases` | Every lease | Status: `month_to_month` / `notice` / `ended` / `renewed` | Open a lease | Reasonable |
| `/renewals` | "Expirations in 30/60/90-day buckets. Offers use the **revenue-intelligence pricing matrix**" | Pricing matrix, revenue intelligence | Send a renewal offer | The subtitle explains the machine, not the task |
| `/inbox` | "Every email, text, call and note with a person — one thread" | — | Reply | **The best-named screen in the app.** Keep it exactly. |
| `/comms` | "New mass message" | Mass message, segment | Send to many | Fine |
| `/insurance` | "Insurance compliance — verified, master-enrolled, or **force-placed** on lapse" | Force-placed, master policy, lapse | Chase a certificate | "Force-placed" is an insurance term |
| `/hub/residents` | Section landing | — | — | Redundant |

### Operations — 10 screens

| Route | Purpose | Jargon | Main action | Where the owner stalls |
|---|---|---|---|---|
| `/workorders` | "New work order" | **Work order**, SLA, triage | Open a repair request | "Work order" is the one piece of industry jargon an owner usually *has* met |
| `/dispatch` | "Drag a card onto a tech to reassign" | Dispatch | Assign | Only useful with staff techs |
| `/turns` | "**Make-ready** turn board — bottleneck stages highlighted" | Turn, make-ready, bottleneck stage | Advance a stage | "Turn board" is opaque; the thing is "getting an empty unit ready" |
| `/inspections` | Move-in / move-out / periodic inspections | — | Run an inspection | Fine |
| `/pm` | "Schedules auto-generate work orders on their due dates" | **PM**, schedule | Create a schedule | `/pm` is an acronym in the URL and the label |
| `/inventory` | "N stock items · $X on hand · usage posts to work orders and the GL" | Stock, usage posting | Receive stock | A 20-unit owner has no stockroom |
| `/facilities` | Maintenance analytics | Facilities | Read it | "Facilities" is a commercial-real-estate word |
| `/vendors` | "Insurance certificates gate dispatch — an expired **COI** blocks assignment" | COI, gate, dispatch | Add a vendor | COI unexplained |
| `/purchasing` | "New purchase order" | **PO**, approval threshold | Raise a PO | Two owners in a hundred will ever raise a PO |
| `/hub/operations` | Section landing | — | — | Redundant |

### Property — 6 screens

| Route | Purpose | Jargon | Main action | Where the owner stalls |
|---|---|---|---|---|
| `/properties` | Buildings | — | Add a property | Fine |
| `/units` | Every unit | Status: `vacant_ready` / `vacant_not_ready` / `notice` / `down` / `model`; **floorplan** | Open a unit | Five statuses in machine case; "floorplan" means "unit type" |
| `/student`, `/affordable` | Vertical modes (shown only when the portfolio has them) | LIHTC, AMI, by-the-bed | — | Correctly hidden when irrelevant |
| `/insurance` (shared) | see Residents | | | |
| `/hub/property` | Section landing | — | — | Redundant |

### Reports & AI — 5 screens

| Route | Purpose | Jargon | Main action | Where the owner stalls |
|---|---|---|---|---|
| `/reports` | "N reports — parameters, drill-through, totals, CSV/PDF on every one" | Parameter, drill-through | Run a report | A library, not an answer. An owner doesn't know which report holds their question. |
| `/dashboards` | "My dashboard" — user-built widget board | Widget | Build a board | Configuration work before any payoff |
| `/pricing` | "**Comp market positioning** — deterministic market simulator" | Comp, positioning, market simulator | Accept a suggested rent | The best feature with the worst name |
| `/ai` | AI Activity — proposed/approved/executed actions | Autonomy, confidence, **proposed** | Approve or reject a draft | **This is where drafts wait for sign-off — the product's central promise — and it's called "AI Activity" under "Reports".** |
| `/ask` | Ask StayLeased | — | Ask a question | Good. Buried in the Reports dropdown. |

### Setup (gear) — 9 screens

`/admin/settings` · `/admin/staff` · `/admin/lease-templates` · `/admin/audit` ·
`/admin/jobs` · `/admin/api` · `/admin/billing` · `/verticals` · `/setup` (Migration Center),
plus `/dev/sim` and `/dev/messages` in demo. Correctly out of the main path.

### The four findings that matter most

1. **None of the five questions has a screen.** Every one of them is *derivable* — the
   ledger is good — but the owner has to know that question 1 lives in `/statements` under
   "NOI", question 2 in `/gl` under account 1010, question 3 in `/receivables` under
   "aging", and question 4 nowhere at all.
2. **"Approvals" names two different queues.** `/approvals` is money (POs, bills, journal
   entries, deposit deadlines). `/ai` is AI drafts awaiting sign-off. The governance promise
   the marketing site makes — *nothing reaches a resident without sign-off* — is honored at
   `/ai`, which is named "AI Activity" and filed under Reports.
3. **The jargon is not decoration, it is the label.** "Receivables", "Delinquency
   workbench", "Payables", "RUBS billing runs", "Make-ready turn board", "Comp market
   positioning", "Trial balance", "GL 1030" are the names in the navigation. An owner cannot
   guess what is behind any of them.
4. **Roughly a third of the screens are enterprise practice a 5–100-unit owner will never
   touch**: budgets with monthly spreads and variance, purchase orders with approval
   thresholds, inventory with usage posting, RUBS, owner equity-income splits, dispatch
   boards, facilities analytics, user-built dashboards. They should not be deleted — they
   should not be in the owner's way.

---

## Part 2 — Proposed navigation

Five items, a gear, and a toggle. Labels are the words an owner already uses.

| New tab | What it holds | Moved from |
|---|---|---|
| **Home** | The five answers, and the day's exceptions. Nothing else. | new |
| **Money** | Who owes me · Bills · Deposits I'm holding · Statements · Bank | Financials (9 of 14 screens) |
| **Units** | Properties · Units · Empty units · Rents | Property |
| **People** | Residents · Leases · Renewals · Applicants & inquiries · Inbox | Residents + Messages + Leasing |
| **Repairs** | Repair requests · Getting units ready · Vendors | Operations (3 of 10) |

- **Gear → Setup**, unchanged, plus Billing.
- **`/ai` is promoted out of Reports** and rendered *on Home* as "Waiting for your OK",
  with its own screen reachable from there. The approval queue is the product's promise; it
  cannot be a sub-item of a reporting menu.
- **`/ask` sits in the header**, next to the property switcher, on every screen. It is the
  escape hatch for everything the five tabs don't surface.
- **Advanced mode** (one switch, per user, in Setup) restores the current 8 tabs and all 56
  items verbatim. Nothing is removed from the app — 20 screens become reachable only in
  advanced mode: `/gl`, `/budgets`, `/periods`, `/reserves`, `/owners`, `/utilities`,
  `/purchasing`, `/inventory`, `/facilities`, `/dispatch`, `/pm`, `/inspections`,
  `/leasing-center`, `/leasing/analytics`, `/marketing/*`, `/pricing`, `/dashboards`,
  `/map`, `/hub/*`, `/insurance`. Every URL keeps working; only the menu changes.
- **The 5 hubs go away in simple mode.** A section landing page between a tab and its
  screens is one click with nothing in it.

Flag: `simple_mode` in `settings` (org-level, property override unused), default **on** for
new orgs, default **off** for existing ones so no live operator loses their chrome on deploy.
`SETTING_DEFAULTS` already supports this shape; no schema change needed.

---

## Part 3 — Copy map

Every term, with its replacement. Advanced mode keeps the original word everywhere, because
a bookkeeper searching for "trial balance" must find "trial balance".

### Navigation and screen names

| Now | Simple mode |
|---|---|
| Receivables | **Who owes me** |
| Delinquency workbench | **Seriously behind** |
| Payables / AP / Enter vendor invoice | **Bills** / **Enter a bill** |
| Deposit accountability | **Deposits I'm holding** |
| General ledger · Trial balance | *(advanced only)* |
| Financial statements | **Money in and out** |
| Month-end close | **Lock the month** |
| Replacement reserves (GL 1030) | **Savings for big repairs** |
| RUBS billing runs | **Split utility bills to residents** |
| Owners · equity-income statements | **Owner splits** |
| Approvals *(money)* | **Bills and spending to OK** |
| AI Activity | **Waiting for your OK** |
| Work orders | **Repairs** |
| Make-ready turn board | **Getting units ready** |
| Preventive maintenance (PM) | **Scheduled upkeep** |
| Dispatch board | **Assign repairs** |
| Facilities analytics | **Repair costs over time** |
| Purchasing / PO | **Spending requests** |
| Comp market positioning | **What similar units rent for** |
| Syndication | **Post vacancies to listing sites** |
| Marketing websites (CMS) | **Your property website** |
| Leasing Center | **Inquiries to follow up** |
| Leasing funnel | **Where inquiries drop off** |
| Applications | **Applicants** |
| Renewals pipeline | **Leases ending soon** |
| Insurance compliance | **Renter's insurance** |
| Units | **Units** *(kept)* |
| Inbox | **Inbox** *(kept — already right)* |
| Reports · Report library | **Reports** |
| My dashboard | *(advanced only)* |

### Terms inside screens

| Now | Simple mode |
|---|---|
| NOI | **Money left after expenses** |
| Accrual basis | **Billed** |
| Cash basis | **Actually paid** |
| T12 | **Last 12 months** |
| Journal entry / JE | **Bookkeeping entry** |
| Aging · 1–30 / 31–60 / 61–90 / 90+ | **How late** · 1 month / 2 months / 3 months / over 3 months |
| Allocation / payment application | **Which charge this paid** |
| Exposure | **Likely to be empty soon** |
| Pre-leased | **Already rented, not moved in yet** |
| Occupancy 94% | **94% full** |
| `vacant_ready` | **Empty — ready to rent** |
| `vacant_not_ready` | **Empty — needs work** |
| `notice` | **Moving out** |
| `down` | **Out of service** |
| `model` | **Show unit** |
| Floorplan | **Unit type** |
| Household | **Resident** (one noun, not three) |
| Charge schedule | **What they're billed each month** |
| Autonomy: draft | **Write it, don't send it** |
| Autonomy: approve | **Ask me first** |
| Autonomy: auto | **Send it without asking** |
| Confidence 0.82 | **Fairly sure** / **Very sure** / **Not sure** |
| Proposed (AI action) | **Waiting for you** |
| Executed | **Sent** |
| COI | **Vendor's insurance certificate** |
| Force-placed | **Insurance we added because theirs lapsed** |
| SLA breach | **Overdue** |
| Simulated rail | **Demo only — nothing actually sent** *(disclosure wording unchanged in substance)* |

**Copy rules carried in from the marketing doctrine, applied to the app:** no headline reads
as "this replaces your staff" — the AI is help, and "every draft under your approval" is the
reassurance. Simulated rails (card/ACH, screening, syndication, carrier delivery) keep their
in-product disclosure verbatim; plain language is not permission to soften an honesty
disclosure.

---

## Part 4 — Home screen spec

One screen, five answers, in reading order. Every number carries its derivation, and every
number is a link to the screen that proves it.

**Period convention:** "this month" = `firstOfMonth(ctx.businessDate)` → `ctx.businessDate`.
**Basis convention:** **cash** everywhere on Home — the owner's intuition is "what hit the
bank". Accrual stays in advanced mode. The basis is stated on the screen, in the copy-map
words: *"counting money that actually came in and went out."*

### 1. "You made $X this month"

```
incomeStatement(ctx, { propertyId, from: firstOfMonth(bd), to: bd, basis: 'cash' }).noi
```
Shown as the subtraction, not the result alone: **`$collected − $paid out = $X`**, with
`totalIncome` and `totalExpenses` as the two visible terms. Against last month: a second
`incomeStatement` over the previous month's full window. A 12-bar strip from
`t12(ctx, { propertyId, to: bd, basis: 'cash' })`.
*Ties to:* `/statements` → income statement, cash basis. Same function, same arguments.

### 2. "You have $X in the bank" + "$Y after this month's bills"

- **Now:** `balanceSheet(ctx, { asOf: bd, basis: 'cash' })`, assets line **`1010`**
  (Cash — Operating).
- **Correctness note — do not use `cashFlow().closing`.** Its `CASH_CODES` is
  `{1010, 1020, 1030}`, which folds in **deposit cash and reserve cash**. Deposit cash is
  other people's money (matched by liability `2100`, Security Deposits Held); reserve cash is
  earmarked. Presenting their sum as "your cash" would overstate spendable cash by the full
  deposit float — on the live Station U&O figures that is **$99,367**. Home shows `1010`
  alone, with `1020` on its own line labelled *"held for residents — not yours to spend"*.
- **After this month's bills:** shown as arithmetic, never as a forecast —
  **`$1010 balance − $bills due on or before lastOfMonth(bd) = $Y`**, where bills are
  `vendor_invoices` with `status IN ('approved','pending_approval')` and
  `due_date <= lastOfMonth(bd)`. Captioned *"before any more rent comes in."* No collection
  assumption is applied to it, because a collection assumption is not in the books.

### 3. "$X owed to you, by N residents"

```
agingRows(ctx, { propertyId, minBalance: 0 })
```
Sum of `balance`, count of rows, and the five largest by name, unit, amount, and
*"N days late"* from `oldest_due`. **With the tie printed on the screen:** the sum of lease
balances against GL **`1100`** (AR — Residents) on accrual basis. They should be equal; when
they are not, the screen says so (exception **E7**) rather than quietly showing the prettier
number.
*Ties to:* `/receivables`.

### 4. "What each unit brought in, and what was spent on it"

Deliberately **not** called profit per unit. Trailing 12 months, per unit:

- **In:** `charges` → `leases.unit_id`, `kind='rent'` and extras, with payments applied via
  `payment_applications`. Each `charges` row carries its own `je_id`, so every figure traces
  to a posted entry.
- **Out:** `vendor_invoice_lines` where `unit_id` is set; the parent `vendor_invoices`
  carries `je_id`. Plus work-order cost where the order carries a `unit_id`.
- **The honest remainder, shown as its own line:** total property expense from the income
  statement **minus** the sum of unit-coded invoice lines = *"building-wide costs not split
  per unit (roof, taxes, insurance, management)"*. That line is what makes the table tie.

**Why not simply group the ledger by unit:** `journal_lines` has `property_id` and **no
`unit_id`**. A per-unit P&L cannot be read from the ledger directly. It can be assembled
from the operational tables above, where every row carries the journal entry it posted — so
each number is traceable, and the uncoded remainder is computed rather than hidden. Any
presentation that implies the units' numbers sum to the building's P&L would be false; the
remainder line is what keeps it true.

### 5. "What needs attention today"

Three stacks, in this order, each already owning its own truth:

1. **Waiting for your OK** — `ai_actions` where `status='proposed'`. Each row: what the agent
   wants to do, to whom, in plain words, with its `rationale` and the copy-map confidence
   word. Approve / reject inline. **The governance doctrine is unchanged: nothing reaches a
   resident or vendor without approval unless the org has set autonomy for it; the queue, the
   audit trail and the kill switch stay exactly as they are.**
2. **Bills and spending to OK** — the existing `/approvals` contents verbatim (POs, vendor
   invoices, large journal entries, deposit deadlines ≤10 days). Not reimplemented; the same
   queries, rendered on Home.
3. **Things that look wrong** — the exception rules in Part 5.

### What Home does not do

No charts beyond the 12-bar money strip. No configuration. No empty-state widget
chooser. If a property switcher is set, every number above scopes to it via the
`propertyId` argument the accounting functions already take; with no property selected,
all figures are the consolidated org view.

---

## Part 5 — Exception rules ("Things that look wrong")

There is **no anomaly detection in the codebase today** — all nine rules are new. Each is
**deterministic** (no LLM, in keeping with the m19 scoring doctrine), each states its finding
in one plain sentence, each lists the exact rows it matched, and each offers exactly one
action. Each ships **shadow-first**: counted and logged before it is shown, so a noisy rule
is caught before it trains the owner to ignore the panel.

| # | Rule | Detection | Why it matters | Action offered |
|---|---|---|---|---|
| **E1** | **Rent wasn't billed** | An active lease with a `lease_charges` row of `kind='rent'` but no `charges` row with `kind='rent'`, `status='active'` and this month's `month_key` | The owner is short and doesn't know it | Bill it now |
| **E2** | **Someone may have paid twice** | Two `payments` for one lease, equal `amount_cents`, `received_date` within 3 days, both `status IN ('pending','settled')` | A duplicate payment is a refund the owner owes | Open both, void one |
| **E3** | **Money with nowhere to sit** | A `payment` whose `payment_applications` sum is less than its `amount_cents` | Unapplied cash makes every balance wrong | Apply it to a charge |
| **E4** | **Empty and earning nothing** | `units.status IN ('vacant_ready','vacant_not_ready')` with no lease starting within 30 days | Question 4, at the unit level: `market_rent_cents`/mo not being collected | List it / open the unit |
| **E5** | **A bill is due before the rent arrives** | Approved `vendor_invoices` with `due_date` before the next rent due date, totalling more than the current `1010` balance | The one surprise that bounces a payment | See the bills |
| **E6** | **A deposit refund is running out of time** | Already computed by `/approvals` (`depositDeadline`, ≤10 days, state law per property) | Statutory deadline, real penalties | Finalize the disposition |
| **E7** | **The books disagree with themselves** | `balanceSheet().balanced === false`, **or** `sum(agingRows().balance) ≠ GL 1100` | A trust rule. An owner who cannot see a disagreement meets it at tax time. | Open the ledger (advanced) / contact support |
| **E8** | **A resident who moved out is still being billed** | `charges` dated after the lease's `move_out_date` | Produces a collections letter to someone who left | Void the charge |
| **E9** | **A repair was assigned to a vendor with lapsed insurance** | Existing COI gate on `vendors` — surfaced, not newly computed | Liability | Chase the certificate |

**Rules deliberately not written:** anything requiring a judgement about a person (late-payer
risk, "problem resident"), anything reading resident message text, anything scoring a
household. The m19 doctrine holds — inputs stay structurally text-free, and no rule reorders
a queue.

---

## Part 6 — What cannot be tied to the books

Per the instruction that accounting correctness beats everything, these are flagged rather
than shipped as numbers:

1. **Days vacant, and rent lost so far.** `units` has **no vacancy timestamp** — only
   `status`. It can be derived from the last ended lease's `move_out_date` (falling back to
   `end_date`), but a unit that never had a lease — every unit of a fresh import, including
   the live Station U&O re-import — has **no derivable date at all**.
   *Recommendation:* ship "Empty — ready to rent" with no duration, and show lost rent only
   where a prior lease supplies the date. Separately, add a `vacant_since` column written on
   move-out and on status change; the number becomes real from the day it ships rather than
   being backfilled with a guess. **Not in this pass unless you want it.**
2. **Month-end cash.** Only honest as the shown subtraction in §4.2. Any version that
   assumes a collection rate is a forecast, not a ledger figure, and should not appear.
3. **Per-unit profit as a single number.** Assembled, traceable, and reconciled by the
   remainder line (§4.4) — but it is not a ledger grouping, and must never be labelled
   "profit per unit" or presented as summing to the building's P&L.
4. **Building-wide cost allocated to units.** No allocation basis exists in the schema (no
   sqft-share or unit-count allocation rule). Rather than invent one, the remainder stays an
   explicit, named line.

---

## Part 7 — Proposed implementation order

Separate commit per phase, on branch `simple-mode`, each phase green on its own gates.
Suites run one at a time, never concurrently.

| Phase | Content | Gates |
|---|---|---|
| **1** | Home screen + the five numbers + the ties (§4). No navigation change; reachable at `/home` behind the flag. | `tsc` · unit · e2e: smoke, goldenpath, clientready, workingmodel + new `homescreen` |
| **2** | Navigation: 5 tabs, advanced-mode switch, `simple_mode` setting, `/ai` promoted, `/ask` in the header. All 56 URLs keep working. | + e2e: navmenus, smoke |
| **3** | Copy map applied, advanced mode keeps original terms. | + the copy pins in `e2e/homepage.test.ts` swept first per CLAUDE.md |
| **4** | Exception rules, shadow-first, then shown. | + new `exceptions` suite |
| **5** | Usage tracking: which simple-mode screens get used, which advanced items get reached for. | + smoke |

A new accounting assertion belongs in `tests/` rather than e2e: each Home number re-derived
from the same exported function the screen calls, so a Home figure can never drift from
`/statements`.
