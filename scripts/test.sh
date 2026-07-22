#!/bin/sh
# Unit + integration tests on an isolated database.
set -e
export STAYLEASED_DB="data/test.db"
export STAYLEASED_MODE="test"
rm -f data/test.db data/test.db-wal data/test.db-shm
node --experimental-strip-types --no-warnings --test --test-concurrency=1 tests/*.test.ts
