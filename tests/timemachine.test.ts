import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q1, insert } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso, addDays } from '../src/lib/dates.ts';
import { advanceBusinessDate, liveToday } from '../src/lib/jobs.ts';

/** Time-machine guardrail: the shared public demo world can be advanced a
 * little (rent cycles, renewals) but never years — one visitor must not be
 * able to wreck the org every later sales call demos from. */

let demoOrg: string;

before(() => {
  db();
  demoOrg = id('org');
  insert('orgs', {
    id: demoOrg, name: 'Clock Test Org', slug: 'clk-' + demoOrg.slice(-6),
    business_date: liveToday(), created_at: nowIso(),
  });
});

test('demo clock advances inside the two-month window', () => {
  const target = addDays(liveToday(), 3);
  const r = advanceBusinessDate(demoOrg, target);
  assert.equal(r.days, 3);
  assert.equal(q1<any>('SELECT business_date FROM orgs WHERE id=?', demoOrg)!.business_date, target);
});

test('demo clock refuses to jump past the two-month ceiling', () => {
  assert.throws(
    () => advanceBusinessDate(demoOrg, addDays(liveToday(), 200)),
    /two months past today/,
  );
});
