import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usd, parseUsd, splitCents, pctOf } from '../src/lib/money.ts';
import { addDays, addMonths, daysInMonth, diffDays, firstOfMonth, lastOfMonth } from '../src/lib/dates.ts';
import { html, esc, raw } from '../src/lib/html.ts';
import { v, VError } from '../src/lib/validate.ts';
import { Rng } from '../src/lib/rng.ts';
import { id } from '../src/lib/ids.ts';

test('money formatting and parsing', () => {
  assert.equal(usd(123456), '$1,234.56');
  assert.equal(usd(-50), '-$0.50');
  assert.equal(usd(-50, { paren: true }), '($0.50)');
  assert.equal(usd(0), '$0.00');
  assert.equal(parseUsd('$1,234.56'), 123456);
  assert.equal(parseUsd('1234'), 123400);
  assert.equal(parseUsd('-12.3'), -1230);
  assert.throws(() => parseUsd('abc'));
  assert.throws(() => usd(1.5 as unknown as number));
});

test('money split preserves total', () => {
  const parts = splitCents(10000, 3);
  assert.equal(parts.reduce((a, b) => a + b, 0), 10000);
  assert.equal(Math.max(...parts) - Math.min(...parts) <= 1, true);
  assert.equal(pctOf(100000, 500), 5000); // 5% of $1000
});

test('date math', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29'); // leap
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(diffDays('2026-07-26', '2026-07-01'), 25);
  assert.equal(firstOfMonth('2026-07-26'), '2026-07-01');
  assert.equal(lastOfMonth('2026-02-10'), '2026-02-28');
});

test('html escaping', () => {
  const evil = '<script>alert("x")</script>';
  const out = html`<div>${evil}</div>`.s;
  assert.equal(out.includes('<script>'), false);
  assert.equal(out.includes('&lt;script&gt;'), true);
  assert.equal(html`<b>${raw('<i>ok</i>')}</b>`.s, '<b><i>ok</i></b>');
  assert.equal(esc(`a"b'c`), 'a&quot;b&#39;c');
  // arrays and nesting
  const nested = html`<ul>${[1, 2].map((n) => html`<li>${n}</li>`)}</ul>`.s;
  assert.equal(nested, '<ul><li>1</li><li>2</li></ul>');
});

test('validation coerces and rejects', () => {
  const schema = v.object({
    email: v.email(),
    rent: v.cents({ min: 0 }),
    beds: v.int({ min: 0, max: 10 }),
    move: v.date(),
    kind: v.oneOf('a', 'b').default('a'),
  });
  const out = schema.parse({ email: ' X@Y.COM ', rent: '1,250.50', beds: '2', move: '2026-08-01', kind: '' });
  assert.deepEqual(out, { email: 'x@y.com', rent: 125050, beds: 2, move: '2026-08-01', kind: 'a' });
  assert.throws(() => schema.parse({ email: 'nope', rent: '1', beds: '2', move: '2026-08-01' }));
  const res = schema.safe({ email: 'nope', rent: 'x', beds: '99', move: 'bad' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.issues.length >= 3, true);
});

test('rng determinism', () => {
  const a = new Rng(42);
  const b = new Rng(42);
  for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next());
  const c = new Rng(42);
  assert.notEqual(c.fork(1).next(), c.fork(2).next());
});

test('ids are unique and prefixed', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const x = id('tst');
    assert.equal(x.startsWith('tst_'), true);
    assert.equal(seen.has(x), false);
    seen.add(x);
  }
});
