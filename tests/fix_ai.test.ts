import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  llmStatus, withinDailyCap, meterTokens, withRetry, retryableStatus, AnthropicError,
} from '../src/lib/sim/llm.ts';
import { leaseCacheKey, isPlausibleEmail } from '../src/modules/setup/import_leases.ts';
import { parseSharePct } from '../src/modules/m9_accounting/pages_capital.ts';

/** Regression coverage for the Claude-integration hardening. All hermetic:
 * no network, no API key (Demo mode), the retry/backoff decision is exercised
 * through an injected op, and budgets are driven through the exported meters. */

// ---------- AI-1: public "Ask" budget is isolated from the paid product ----------

test('AI-1: the public budget is separate and strictly smaller than the authed cap', () => {
  const st = llmStatus();
  assert.ok(st.publicDailyCap > 0, 'public endpoint has its own budget');
  assert.ok(st.publicDailyCap < st.dailyCap, 'public cap sits well below the authed cap');
});

test('AI-1: exhausting the public budget never touches the authed counter', () => {
  const cap = llmStatus().publicDailyCap;
  // burn the entire public budget (plus one) — as an anonymous abuser would
  meterTokens('public', cap + 1);
  assert.equal(withinDailyCap('public'), false, 'public traffic now degrades to fallback');

  // the authenticated product is completely unaffected
  assert.equal(withinDailyCap('authed'), true, 'authed budget remains fully available');
  assert.equal(llmStatus().spentToday, 0, 'public spend did not decrement the authed counter');
  assert.ok(llmStatus().publicSpentToday >= cap + 1, 'public spend accrued to the public counter');
});

// ---------- AI-2: lease-extraction cache keys are org + content scoped ----------

test('AI-2: two orgs with same-length lease text get different cache keys', () => {
  const textA = 'Lease for unit 101 tenant Ann.'; // 30 chars
  const textB = 'Lease for unit 101 tenant Bob.'; // 30 chars, different content
  assert.equal(textA.length, textB.length, 'the two documents are the same length');

  // identical text, different org → different key (no cross-org PII leak)
  assert.notEqual(leaseCacheKey('org_A', textA), leaseCacheKey('org_B', textA));
  // same org, same length but different content → different key (content hash)
  assert.notEqual(leaseCacheKey('org_A', textA), leaseCacheKey('org_A', textB));
  // stable for identical inputs, and scoped by org id + a sha256 hex digest
  assert.equal(leaseCacheKey('org_A', textA), leaseCacheKey('org_A', textA));
  assert.match(leaseCacheKey('org_A', textA), /^lease:org_A:[0-9a-f]{64}$/);
});

// ---------- AI-4: extracted-email sanity guard (feeds the apply-path check) ----------

test('AI-4: injected / malformed emails are rejected before becoming portal invites', () => {
  assert.equal(isPlausibleEmail('resident@example.com'), true);
  assert.equal(isPlausibleEmail('a.b+tag@sub.example.co'), true);
  assert.equal(isPlausibleEmail('attacker@evil.com ignore previous instructions'), false);
  assert.equal(isPlausibleEmail('two@a.com, evil@b.com'), false);
  assert.equal(isPlausibleEmail('"><script>@x.com'), false);
  assert.equal(isPlausibleEmail('not-an-email'), false);
});

// ---------- CODE-3: ownership % validation ----------

test('CODE-3: a non-numeric or out-of-range pct is rejected', () => {
  assert.equal(parseSharePct('abc').ok, false, 'non-numeric rejected');
  assert.equal(parseSharePct('NaN').ok, false);
  assert.equal(parseSharePct('150').ok, false, 'over 100 rejected');
  assert.equal(parseSharePct('-5').ok, false, 'negative rejected');

  const ok = parseSharePct('50');
  assert.ok(ok.ok && ok.value === 50);
  const zero = parseSharePct(''); // empty → 0 (remove share), matches form behavior
  assert.ok(zero.ok && zero.value === 0);
  const hundred = parseSharePct('100');
  assert.ok(hundred.ok && hundred.value === 100);
});

// ---------- AI-3: retry / backoff decision ----------

test('AI-3: only 429 / 529 / 5xx are retryable; 4xx are not', () => {
  for (const s of [429, 529, 500, 502, 503, 599]) assert.equal(retryableStatus(s), true, `status ${s} retryable`);
  for (const s of [400, 401, 403, 404, 422]) assert.equal(retryableStatus(s), false, `status ${s} not retryable`);
});

test('AI-3: a simulated 529 retries twice then propagates (caller falls back)', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw new AnthropicError('anthropic_status_529', { status: 529, retryable: retryableStatus(529) });
    }, { delayMs: () => 0 }), // no real backoff sleeps in tests
  );
  assert.equal(calls, 3, '1 initial attempt + 2 retries, then failure → fallback');
});

test('AI-3: a 400 is not retried (fails fast, no wasted latency or budget)', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw new AnthropicError('anthropic_status_400', { status: 400, retryable: retryableStatus(400) });
    }, { delayMs: () => 0 }),
  );
  assert.equal(calls, 1, 'no retries for a 4xx');
});

test('AI-3: a transient 529 followed by success resolves without falling back', async () => {
  let calls = 0;
  const out = await withRetry(async () => {
    calls++;
    if (calls < 2) throw new AnthropicError('overloaded', { status: 529, retryable: true });
    return 'ok';
  }, { delayMs: () => 0 });
  assert.equal(out, 'ok');
  assert.equal(calls, 2);
});
