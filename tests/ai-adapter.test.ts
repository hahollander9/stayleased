import { test } from 'node:test';
import assert from 'node:assert/strict';
import { llmGenerate, llmStatus, llm, MockLlm } from '../src/lib/sim/llm.ts';

/** Adapter contract (no network): with no ANTHROPIC_API_KEY the platform runs
 * in deterministic Demo mode — llmGenerate returns the caller's fallback and
 * never throws, so the demo and the public site can never break. */

test('llmStatus reports Demo mode when no key is configured', () => {
  const st = llmStatus();
  // The test/CI environment sets no ANTHROPIC_API_KEY.
  assert.equal(st.live, false);
  assert.equal(st.mode, 'Demo');
  assert.equal(st.model, 'MockLlm (deterministic)');
});

test('llmGenerate falls back to the deterministic text with no key', async () => {
  const r = await llmGenerate({ prompt: 'Write a haiku about rent.', fallback: 'FALLBACK-TEXT' });
  assert.equal(r.live, false);
  assert.equal(r.text, 'FALLBACK-TEXT');
});

test('the default provider is MockLlm and still fills templates deterministically', () => {
  assert.equal(llm(), MockLlm);
  const a = MockLlm.complete('alt_text', { subject: 'Pool', property: 'Summit Ridge', detail: 'sunny deck' });
  const b = MockLlm.complete('alt_text', { subject: 'Pool', property: 'Summit Ridge', detail: 'sunny deck' });
  assert.equal(a, b); // reproducible
});
