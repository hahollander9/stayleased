# DECISIONS.md — append-only judgment log

Format: context → choice → why. One line each (details in linked docs where needed).

## Phase 0

1. **npm registry unreachable (all installs 403)** → build on Node 22 built-ins plus the sandbox's preinstalled global packages (typescript 6, playwright 1.56 + Chromium, pdf-lib), symlinked into `node_modules`; `package.json` still declares them so a normal `npm install` works outside the sandbox → §3.6 says never stall on tooling; this keeps the app runnable *anywhere* with zero installs.
2. **Next.js unavailable** → hand-rolled server-rendered framework on `node:http` (router, middleware, multipart parsing, cookies, CSRF origin-check) in `src/lib/http.ts` → equivalent capability, zero deps; pages are plain functions returning HTML.
3. **React/JSX unavailable for type-safe templates** → `html` tagged-template engine with auto-escaping (`src/lib/html.ts`) → safer-by-default than string concat, no build step, works with Node type-stripping.
4. **Prisma unavailable** → `node:sqlite` + `src/db/schema.sql` written Postgres-compatible + tiny typed query helpers (`db.ts`); `docs/production-port.md` will document the Postgres switch → keeps "SQLite dev default / Postgres-ready" spirit of §3.1.
5. **Auth.js unavailable** → session-cookie auth with scrypt password hashes, hashed session tokens, SameSite+Origin CSRF checks, login rate limiting → meets §9 security bar; RBAC per §4 implemented natively.
6. **Tailwind/shadcn unavailable** → single original design system in `src/ui/theme.css` (tokens: neutral surfaces, one indigo accent) + component kit in `src/ui/ui.ts` → §3.1 asked for a single original design system anyway.
7. **Vitest unavailable** → `node:test` runner; **Playwright IS available** (global install + matching Chromium) so real e2e and screenshots stay in scope.
8. **Zod unavailable** → mini-validator `src/lib/validate.ts` with the same parse/safe semantics used at every boundary.
9. **faker unavailable** → deterministic mulberry32 RNG seeded 42 (`src/lib/rng.ts`) + curated name banks in the seed → §8 requires reproducibility, which this guarantees exactly.
10. **ESLint/Prettier unavailable** → `tsc --strict` (with `erasableSyntaxOnly`) is the lint gate; consistent hand formatting → logged as tooling gap, revisit if registry access appears.
11. **Scheduling model**: all recurring behavior keys off the per-org simulated business date; every job runs once per business day and is internally idempotent; a wall-clock poller merely re-runs the current day → makes the Simulator Console time machine the single source of time, so demos are deterministic.
12. **Business rules in property-local time**: the org business date is the operative date for all properties; property IANA timezones are used for display and timestamp rendering → one clock keeps the demo coherent; per-property date offsets add complexity with no demo value (logged as a production consideration).
13. **Money**: INTEGER cents everywhere; `usd()`/`parseUsd()`/`v.cents()` are the only conversion points; no floats in services.
14. **Sensitive-data hygiene**: password/token/secret fields are excluded from audit diffs; only fake SSN last-4 is ever stored (per §5).
15. **CSRF**: same-origin Origin-header check on browser POSTs + SameSite=Lax cookies instead of per-form tokens → adequate for same-site forms, zero template overhead; API routes use keys not cookies.
16. **Impersonation**: implemented as a new session carrying `impersonator_user_id`, original admin session kept in a backup cookie; bannered in the shell and audited both ways.
17. **Org isolation**: `canAccessProperty` verifies the property's org against ctx before any scope logic (caught by the isolation test suite) → isolation is checked at the data layer, never inferred from role scope.
18. **Seed business date fixed to 2026-07-26** (26th of the demo month, per §8 "the 26th of the current month") rather than wall-clock-relative → deterministic seeds beat calendar-relative ones for reproducible demos; override with ORIEL_SEED_DATE.
