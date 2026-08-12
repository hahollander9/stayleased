import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/lib/db.ts';

/** The engineering log's own invariants.
 *
 * BUILDLOG.md and DECISIONS.md are append-only files that parallel Claude
 * sessions write to concurrently, and CLAUDE.md warns that they have collided
 * before: two builds each claim the next decision number against a tail they
 * cached before the other landed. Git surfaces that as a text conflict only
 * while the two appends touch the same lines — resolve it carelessly, or
 * append after a clean auto-merge, and the file ends up with two #38s and
 * nobody notices. These assertions turn that into a failing gate.
 *
 * They also protect the cross-references: a decision is cited by number from
 * BUILDLOG entries and from other decisions, so a renumber that misses a
 * citation silently points at the wrong judgment. */

const read = (name: string): string => readFileSync(join(ROOT, name), 'utf8');

test('DECISIONS.md is numbered 1..N with no duplicates and no gaps', () => {
  const nums = [...read('DECISIONS.md').matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
  assert.ok(nums.length > 0, 'decisions are numbered');

  const dupes = nums.filter((n, i) => nums.indexOf(n) !== i);
  assert.deepEqual(
    [...new Set(dupes)], [],
    'two sessions claimed the same decision number — renumber the later one against the CURRENT tail',
  );
  assert.deepEqual(
    nums, Array.from({ length: nums.length }, (_, i) => i + 1),
    'decision numbers must run 1..N in order (a gap usually means a lost entry from a parallel build)',
  );
});

test('every decision cited by number exists', () => {
  const decisions = read('DECISIONS.md');
  const highest = Math.max(...[...decisions.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1])));
  const cited = new Set<number>();
  for (const src of [decisions, read('BUILDLOG.md')]) {
    for (const m of src.matchAll(/#(\d{1,3})\b/g)) {
      const n = Number(m[1]);
      // PR/issue numbers and section refs are small; decision citations are
      // the ones inside the decision range
      if (n >= 1 && n <= highest) cited.add(n);
    }
  }
  const dangling = [...cited].filter((n) => !new RegExp(`^${n}\\. `, 'm').test(decisions));
  assert.deepEqual(dangling, [], 'these decision numbers are cited but do not exist');
});

test('BUILDLOG.md entry headers are unique', () => {
  const heads = [...read('BUILDLOG.md').matchAll(/^## (.+)$/gm)].map((m) => m[1]!.trim());
  assert.ok(heads.length > 0, 'the log has entries');
  const dupes = heads.filter((h, i) => heads.indexOf(h) !== i);
  assert.deepEqual(
    [...new Set(dupes)], [],
    'two builds shipped the same BUILDLOG header — headers are how an entry is found, so make it unique',
  );
});
