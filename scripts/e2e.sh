#!/bin/sh
# End-to-end smoke tests with Playwright against a freshly seeded demo database.
set -e
export ORIEL_DB="data/e2e.db"
export ORIEL_MODE="demo"
export ORIEL_E2E_ISOLATE="1"
rm -f data/e2e.db data/e2e.db-wal data/e2e.db-shm data/e2e-run-*
node --experimental-strip-types --no-warnings src/seed/seed.ts --quiet
node --experimental-strip-types --no-warnings --test --test-concurrency=1 --test-timeout=240000 e2e/*.test.ts
