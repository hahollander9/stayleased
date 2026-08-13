# Property-scoped settings — make the override actually reach the product

*Plan, 2026-08-13. Trigger: "confirm it is possible to apply settings to one property at a
time, that each property can be edited distinctly, and that the settings reach all the
necessary parts of the site — and make the property picker explicit and refined."*

## What was already true

The hierarchy is sound and well-built. `settings` rows are keyed `(org_id, property_id, key)`
with `property_id=''` meaning the organization level. `/admin/settings?property=<id>` edits
one property at a time, `narrowOverride` stores only the fields that DIFFER (so editing one
autonomy dial does not pin the other three), clearing an override hands the setting back to
the organization, a property-scoped admin cannot write an org default, `canAccessProperty`
fences every read and write, and deleting a property drops its override rows only.

## What was not true

**A stored override does not reach the product in 20 places.** Two failure modes:

1. **No property argument.** `getSetting(ctx, key)` never looks at the property level, so an
   override recorded on the settings page is silently inert. 7 sites, each with a property id
   already in scope (`lead.property_id`, `lease.property_id`, …).
2. **Wrong resolver.** Overrides are stored as *partial diffs*, but `getSetting` REPLACES a
   stored object wholesale. So `{flatCents: 7500}` saved at a property makes every other
   field of `late_fee_policy` `undefined` at runtime. 13 sites. Three of them throw:
   `addDays(due, undefined)` → `RangeError: Invalid time value` kills the nightly late-fee job
   for the whole organization; `hours.days.includes(...)` 500s the **public** tour-booking
   page; `quiet.end.slice(...)` throws on the comms send path. Others compute money wrong
   (`NaN` convenience fees) or silently disable screening tests.

The mechanism was verified on whole-object saves only. Same standing lesson as the import
build: **verification must exercise the path production takes.**

## The fix, in order

1. **A lint the compiler can't give us** — `tests/settings_scope.test.ts` scans `src/` for
   every `getSetting`/`getSettingMerged` call with a literal key and asserts two rules:
   - an object-valued, non-matrix setting read WITH a property must use `getSettingMerged`;
   - a spec'd setting that is not declared `orgOnly` must be read WITH a property.
   This is the `specCoverage()` pattern: the class of bug fails the build, not just today's
   instances.
2. **Declare the genuinely org-wide settings** — `orgOnly` on the spec. `ai_enabled` (the kill
   switch), `lead_scoring` and `bah_table` are read once org-wide by design; the settings page
   now says so at property level instead of offering an override that does nothing.
   `delinquency_scoring.mode` is org-wide (M19 doctrine: shadow-first, opt-in per org) while
   `noticeThresholdDays` is per-property — the mode now reads through a named
   `scorerMode()` helper so the choice is legible rather than inferred from a missing argument.
3. **Fix the 20 sites** (resolver and/or property argument).
4. **Two adjacent bugs found while verifying**: `currentCriteriaVersion` reads criteria per
   property but writes the version row at `property_id=''` (the number printed on the
   adverse-action notice); `depositDeadline` detects "explicitly set" by comparing to the
   literal `30`, so a property that deliberately sets 30 days has its override discarded.
5. **The picker.** Rebuild the scope control as a real level switcher: organization vs
   property is unmistakable at a glance, each property carries its override count, the current
   level states what saving will do and to whom, and overridden settings can be isolated.

## Gates

`npx tsc --noEmit` · `sh scripts/test.sh` · seeded e2e: settings + smoke + crm + payments +
ai + clientready + goldenpath + workingmodel (the suites that exercise the fixed consumers).
