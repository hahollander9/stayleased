# Oriel metric definitions (M14.5)

One definition per metric, used consistently everywhere — dashboards, reports,
statements and module screens all call the same code paths listed here.
Sources of truth: `src/modules/m14_reports/asof.ts` (effective-dated facts),
`src/modules/m14_reports/snapshots.ts` (MetricSnapshot rollups),
`src/modules/m9_accounting/statements.ts` (GL-derived statements).

## Occupancy & exposure

**Rentable units** — units whose status is not `model` or `down`. The unit
inventory is treated as constant across history (units are neither created nor
destroyed by operations).

**In possession at date D** — a lease counts toward occupancy at D when
`COALESCE(move_in_date, start_date) ≤ D` and it had not ended by D
(`ended` leases end possession at `COALESCE(move_out_date, end_date)`,
`renewed` leases at `end_date`; `active`/`month_to_month`/`notice` leases are
still in possession today). Query shape in `asof.ts:IN_POSSESSION` — the same
predicate drives the rent roll, occupancy trend, and snapshots.

**Physical occupancy** — `occupied ÷ rentable` where occupied = distinct units
with a lease in possession at D.

**Exposure** — `(vacant + on notice, not re-leased) ÷ rentable`. A noticed
unit leaves exposure the moment a future lease exists for it. The pricing
engine (M13) uses the same definition per floorplan with a 7% target.

**Economic occupancy** — `total cash collected in month ÷ gross potential
rent`, where GPR = the sum of today's asking rents across rentable units.
Collections include utilities and fees, so strong collection months can exceed
100% — the report notes this. (Chosen over billed-basis economic occupancy so
delinquency drags the number, which is what executives want it to show.)

**Occupancy trend** — month-end MetricSnapshot rows (`metric_snapshots`),
written nightly by the `metric_snapshots` job and backfilled by seed. A
snapshot is a cache of the effective-dated computation above, never a second
definition.

## Rent & revenue

**In-place rent** — average `rent_cents` of leases in possession (MTM premium
bills as a separate charge and is not part of in-place rent).

**Asking (market) rent** — `units.market_rent_cents`, which only the M13
pricing decisions (accept/override) and unit management change. Every change
is a `price_changes` row.

**Loss to lease** — `(avg asking − avg in-place) ÷ avg asking` across a
property.

**Trade-out** — rent change between consecutive leases on the same unit:
new-lease trade-outs compare to the prior tenancy, renewal trade-outs compare
to the lease being renewed.

**Effective rent trend** — average active `rent` charge amount by month
(concessions post as negative charges and therefore lower it).

**Gross potential rent (GPR)** — sum of asking rents over rentable units, at
today's asking. Used by economic occupancy.

## Receivables

**Balance (live)** — active charges minus good payments
(`pending`+`settled`). NSF'd and charged-back payments do not count.

**Balance as of D** — same, date-bounded: charges dated ≤ D minus payments
received ≤ D that had not bounced *by D* (`nsf_date > D` still counts at D).

**Aging** — the open balance is applied FIFO against unpaid charges by due
date, using actual `payment_applications` rows (date-bounded for as-of runs).
Buckets: current (≤0 days past due), 1–30, 31–60, 61–90, 90+. A receivable
outlives possession: ended leases with balances stay in aging until paid or
written off.

**Collection rate** — cash collected in month ÷ net charges billed that month
(`receivablesStats`). **On-time %** — share of rent collected by the grace
deadline. **NSF rate** — returned payments ÷ payments received.

**Prepaids & credits** — leases with negative live balance; ties to GL 2150.

**Deposit accountability** — per-lease held deposit (deposit charges paid
minus applied/refunded, `depositHeld`) vs GL 2100; escrow cash sits in 1020.

**Bad debt** — `writeoff` charges: negative AR charges posting DR 5610 / CR
1100, requiring a written reason, gated above the org threshold
(`writeoff_approval_threshold_cents`) by `gl:post`. Open collection cases are
exposure, not expense, until written off.

## Accounting

**Basis** — every JE posts twice (accrual + cash where applicable); statement
queries filter on `je.basis`. **Trial balance** — SUM(debit−credit) per
account; must net to zero (invariant-tested). **NOI** — income minus expenses
(4xxx − 5xxx natural signs) for the period. **Balance sheet** — assets =
liabilities + equity with prior-year earnings rolled into retained earnings
and current-FY net income shown separately. **Budget variance** — actual vs
approved budget through the month, flagging expenses over / income under by
10%+.

## Operations & facilities

**Box score** — counts within a date range: leads created, tours completed,
applications submitted (by `submitted_at`), approvals (decision `approve`),
executed leases (by `start_date`), renewal acceptances (`decided_at`),
move-ins/notices/move-outs (their lease dates), plus the occupancy block at
the range end.

**Turn days** — move-out date → turn completed date. **SLA hit** — work order
completed before `sla_due`. **PM compliance** — completed ÷ generated PM work
orders per schedule. **Maintenance cost per unit** — materials + labor logged
in month ÷ unit count.

**Retention** — of leases reaching their end month: `renewed + went MTM` ÷
all. **Satisfaction** — average resident rating on completed work orders.

## Utilities & risk

**Recovery rate** — resident RUBS billings ÷ provider invoice for the same
service-month. Vacant and common-area shares stay property expense by design
and appear in the vacant-recovery report.

**Insurance compliance** — every active lease classified: third-party
verified / master policy / lapsing (≤14 days) / lapsed / none on file.

## Reporting conventions

Money is integer cents end-to-end and formats as USD only at render. CSV
exports emit dollars with two decimals. As-of reports never read live status
flags when an effective date exists — `docs/metrics.md` definitions are
implemented once in `asof.ts` and reused. All §10 reports run through one
engine (`engine.ts`): shared parameter panel, sorting, grouping with
subtotals, totals row, drill-through, CSV and PDF.
