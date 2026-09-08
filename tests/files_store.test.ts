import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import { dbPath, ROOT } from '../src/lib/db.ts';
import { filesDir } from '../src/lib/files.ts';
import { setEnv } from '../src/lib/env.ts';

/** Stored bytes belong on the same disk as the rows that point at them.
 *
 * This is a production data-loss regression, not a tidiness rule. The store
 * was `ROOT/data/files` — a path relative to the CODE — while production runs
 * `STAYLEASED_DB=/data/stayleased.db` on a Render persistent disk. Two
 * different filesystems: the database survived every deploy, the blobs did
 * not, because Render replaces the container image on each one.
 *
 * What made it invisible is the failure mode. `getFile` checks `existsSync`
 * and returns null, so a destroyed original renders as "Not on file" — exactly
 * what a batch uploaded before originals were kept renders as. The operator
 * sees a plausible empty state instead of a missing document, and the review
 * screen's whole safety argument ("check the read against the source") is
 * silently gone.
 *
 * So the invariant under test is not a literal path. It is: wherever the
 * database is, the bytes are beside it. */

test('the file store sits beside the database, on the same disk', () => {
  assert.equal(filesDir(), join(dirname(dbPath()), 'files'));
});

test('pointing the database at a mounted disk moves the bytes there too', () => {
  // exactly the production shape: STAYLEASED_DB on a Render persistent disk
  const prior = process.env.STAYLEASED_DB;
  try {
    setEnv('DB', '/data/stayleased.db');
    assert.equal(dbPath(), '/data/stayleased.db', 'an absolute path is used verbatim');
    assert.equal(
      join(dirname(dbPath()), 'files'), '/data/files',
      'the store follows the database onto the disk — never /app/data/files, which a deploy destroys',
    );
  } finally {
    if (prior === undefined) setEnv('DB', ''); else setEnv('DB', prior);
  }
});

test('a relative database path still resolves inside the checkout, as dev and CI expect', () => {
  const prior = process.env.STAYLEASED_DB;
  try {
    setEnv('DB', 'data/test.db');
    assert.equal(join(dirname(dbPath()), 'files'), join(ROOT, 'data', 'files'),
      'unchanged for local dev and the suites, whose databases already live in data/');
  } finally {
    if (prior === undefined) setEnv('DB', ''); else setEnv('DB', prior);
  }
});

test('the resolved directory is absolute and real', () => {
  const d = filesDir();
  assert.ok(isAbsolute(d), 'never a path that depends on the working directory');
  assert.ok(existsSync(d), 'filesDir() creates it on demand');
});
