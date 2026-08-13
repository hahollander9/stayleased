import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/lib/db.ts';

/** One invariant, learned the expensive way.
 *
 * e2e/lib.ts's newPage() is where the suite decides what kind of browser it is
 * driving: the viewport, the device scale, and — since DECISIONS #52 — reduced
 * motion, which is a mode the product PROMISES (visible + still) and which no
 * test exercised until the helper started asking for it.
 *
 * A test that calls browser.newPage() or browser.newContext() directly opts out
 * of all of it, silently and invisibly. That is not hypothetical: askdock's two
 * theme-preference pages did exactly that to pass colorScheme, so when the rest
 * of the suite moved to reduced motion those two kept the animated path — and
 * the theme toggle then failed Playwright's stability check on a 2-core CI
 * runner while passing on every developer machine. A gate that holds for 29 of
 * 31 files is not a gate.
 *
 * So: options a test needs to vary become parameters on the helper, and this
 * asserts the helper stays the only door. */
test('every e2e page comes from newPage() — no direct browser.newPage/newContext', () => {
  const dir = join(ROOT, 'e2e');
  const offenders: string[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && n !== 'lib.ts')) {
    const src = readFileSync(join(dir, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (/\bbrowser\s*\.\s*(newPage|newContext)\s*\(/.test(line)) offenders.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(
    offenders, [],
    'these bypass e2e/lib.ts newPage() and so skip reduced motion and the standard viewport — ' +
    'add the option you need to the helper instead',
  );
});
