# Paste-in for BUILDLOG.md and DECISIONS.md (do NOT web-upload those two files)

Per the parallel-session rule, BUILDLOG.md and DECISIONS.md must never go through a
web-UI upload (whole-file replace deletes parallel entries). If you land this build via
the ZIP, append the entries below by hand — they are already inside the PATCH, so the
`git am` path needs nothing from this file.

The entries below claim BUILDLOG header "2026-08-13 — The 606-unit import: nothing real
discarded, nothing fake invented (Cowork audit session)" and DECISIONS #73–#77 against the
tail as of 99f07c8.

**Those numbers are stale, and this build has NOT landed.** DECISIONS #73–#77 are now
occupied by entirely different entries and the tail is #84; #71 and #72 above did merge and
are already in DECISIONS.md. Nothing else here reached either log — `606-unit`, `rtempcon`,
`Will not import` and `depositHeld` appear in neither file. Renumber to the CURRENT tail
before pasting, and drop the #71/#72 duplicates when you do.
collected, and a file stating no layout producing a floorplan that admits its bed/bath is a
placeholder and is not named after one.

## 2026-08-13 — The 606-unit import: nothing real discarded, nothing fake invented (Cowork audit session)

Henry's second real Yardi property — ABM (1018), 606 units, Section 18/RAD, voucher-heavy,
$1.58M of carried balances — went through the live rent-roll lane and read **539 of 606
units**. Every dropped row was a real tenancy: the 23 zero-charge households carrying the
portfolio's largest balances ($74k, $57k, $51k…), 41 occupied parking licenses, two employee
units billed a negative rtempcon concession, one inverted lease term with a $41k balance,
and eight negative/zero coded sub-rows that fell out of their blocks as "No unit number."
The strip caught the shortfall (9 lines off, $451k of balances missing) — and the green
Apply button offered to apply it anyway.

This build makes the same file tie **10 for 10, penny-exact** (606 units · 585 occupied ·
$1,284,987.20 rent · $1,049,181.10 subsidy · $-3,770.80 other · $140,081.02 deposits ·
$1,583,171.13 balances), and applies it whole: coded sub-rows attach whatever their sign,
concessions demote to negative recurring charges instead of negative rent, zero-rent
occupied rows import at $0 on evidence, end-before-start terms read as MTM holdovers,
sq ft 0 stays 0 (was: 750 invented on every unit), $0 market rent stays $0 (was: $1,000
invented on 39 units), and a "future" row whose move-in already passed never bills
backward (was: $8,894.69 of retroactive invented charges). The review screen now names
every row that will not import, the apply endpoint refuses a red strip without an explicit
acknowledgement, the dashboard's Delinquent tile means past due, the Collection tile reads
"billing starts Sep 1" on a migrated org, the deposits workbench sees migrated deposits
($140,081.02 read as $0.00 before), the units page stops capping at a silent 600, and a
file dropped anywhere on the import page lands in the dropzone instead of replacing the app.

Fixture: `tests/fixtures/audubon_block_roll.ts` (sanitized 13-unit roster carrying every
shape above). Gates: tsc clean · unit **399/399** · seeded e2e (setup, smoke, clientready,
workingmodel, goldenpath) **30/30** at concurrency 1 · real-file replay ties 10/10 and
applies clean end to end. Decisions #73–#77.

71. **A metric with no data says so, instead of computing zero** (the half of Bug 6 the first pass skipped): `receivablesStats` returned `collectionRate: billed ? collected / billed : 0`, so a portfolio whose first billing cycle has not run reported **0% collected** — arithmetically defensible and practically a lie, because on screen it is indistinguishable from a book nobody is paying. That is the same failure as the delinquency count in #69: a number that describes the platform's state being read as a fact about the customer's business. The stat now carries `billingStartsOn`, set only when nothing has been billed AND every lease's billing starts later, and the rate renders as an em dash with the date. The general rule, worth applying wherever a rate has a zero denominator: 0/0 is not 0%, and a metric that cannot be computed should name the reason rather than emit its most alarming legal value.
72. **What the source did not say is stored as a placeholder and labelled as one**: a rent roll that never mentions bedrooms produced floorplans asserting 1 bed / 1 bath, on units of 331 and 536 square feet. `floorplans.beds`/`baths` are NOT NULL and `beds = 0` already means Studio, so "unknown" has no representation in the schema and the placeholder has to stay — the fix is therefore not to invent a null but to stop the placeholder passing as a fact. The plan is no longer NAMED after the guess (it takes its size instead), and it carries a description saying the layout was not stated and asking the operator to correct it. Rejected: a sentinel value (-1 leaks into every display that does arithmetic on beds) and a parallel `beds_known` column (more schema for something the description already communicates to the only audience that can fix it).

73. **A row the reader cannot price is imported at $0 with its evidence named — never discarded**: the 606-unit file's validator skipped 66 occupied rows for "needs a rent amount," and they were precisely the households the product exists to manage — the rent-abated and eviction-hold units carrying the portfolio's largest balances, the occupied parking licenses, the superintendent's unit. On a migration, the unpriceable rows and the important rows are the same rows. The harvest now keeps a coded charge sub-row whatever its sign (a rnsvchr −1,619/rntnt +1,619 transfer pair is a payer split, not junk; a rntnt 0 row is a fully-voucher-paid household, not a fragment), a block of purely ancillary codes stops falling back to "first charge is rent" when the roster named a rent code (a $4.20 trash line was the rent on one unit, and the strip was off by $4.20 twice), and an occupied row netting $0 imports with a warning that names its evidence — a balance, a deposit, a move-in date, a subsidy — while a row with no money, no dates and no history still fails, because that shape is a mis-mapped column, not a household. An end date before its own start, both in the past, reads as a month-to-month holdover with a warning instead of a discard; the term is what's broken, not the tenancy.

74. **A negative charge is a concession and it stays on the schedule — as what it is**: the two employee units bill rtempcon −$3,322/mo in the source, every month, forever; their balances are the running proof (−$26,576 = 8 months of it). The old pipeline had three answers, all wrong: ride it through as negative rent, drop it as an invalid amount, or lose the sub-row entirely. Rent floors at $0 and the concession lands in "Other monthly charges" signed, bills monthly as a recurring credit exactly as the prior system scheduled it, and the strip's other-charges line ties at −$3,770.80 to the report's own code summary. The reconciliation strip is what forced the honest answer: any of the three wrong treatments broke a tie line.

75. **An apply the strip calls red needs the operator's signature, and every refused row is named where the button is**: the review screen said "9 lines do not tie — fix the mapping before applying" while an enabled green button said "Apply 539 rows," and the preview enumerated skips but capped at 60 notes with 75 skipped. The contradiction was load-bearing: one click built a portfolio 67 units short of the report the operator had just been told was the authority. The apply endpoint now refuses a rent-roll batch that skips rows or fails its tie-out unless an explicit acknowledgement box is ticked — server-side, not just chrome — and a "Will not import" card groups every failing row by reason, in full, above the mapping table. The strip, the card, and the button now tell one story.

76. **Migrated money is visible wherever an operator will look for it, and never marked worse than it is**: four screens read the same import four different ways. The deposits workbench showed "$0.00 held across 0 households" while the GL carried $140,081.02 — depositHeld() only summed deposit CHARGES, and a migrated deposit was never charged because the prior system already collected it; it now reads the lease's own record for imported leases, reversal-safe since removing the upload removes the lease. The dashboard tile branded $2,014,934.18 of carried balances "DELINQUENT · 330 households" on day one while the workbench itself said "current, not yet due" — the tile now means past due, like the workbench, and says "open balances, none past due" for the rest. The collection tile read 0% because opening balances counted as the month's billing; they are carried-in AR, and with them excluded the "billing starts Sep 1" branch built in #71 finally fires on the org it was built for. And the units page silently LIMIT-600'd a 606-unit portfolio while captioning the capped list as the total; the count is now the count, and a capped list says it is capped.

77. **A dropped file lands in the dropzone from anywhere on the page — and the drop is acknowledged where the eye is**: "drag and drop doesn't work" was three defects wearing one symptom. Nothing prevented the browser's default outside the 590×130 dashed target, so a drop that missed replaced the whole app with the spreadsheet; a drop that hit assigned the file but the confirmation line was display:none with no override, so nothing visibly changed; and nothing invited the drop from the rest of the page. A document-level guard now cancels file-drag defaults everywhere, a drop outside a zone routes to the nearest visible dropzone (with a highlight pulse and a scroll into view), and a successful drop replaces the zone's label with "✓ filename — ready to upload." The e2e proves all three from the page itself.
