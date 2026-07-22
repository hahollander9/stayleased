import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenFairHousing, isFairHousingSafe, NEUTRAL_SCRIPTS, type FhCategory } from '../src/lib/fairhousing.ts';

/** Fair-housing guardrail corpus. Each entry: text → whether it should be
 * flagged, and (for flagged ones) the expected category. The guardrail is
 * deterministic, so these assertions are exact. */

const FLAGGED: { text: string; category: FhCategory }[] = [
  { text: 'This quiet building is adults only, no kids.', category: 'familial-status' },
  { text: 'Perfect for a single professional — no families please.', category: 'familial-status' },
  { text: 'A great community for empty-nesters.', category: 'familial-status' },
  { text: 'Ideal for young professionals near downtown.', category: 'familial-status' },
  { text: 'No Section 8 or vouchers accepted.', category: 'source-of-income' },
  { text: 'We are an English-only building.', category: 'race-national-origin' },
  { text: 'A welcoming Christian community.', category: 'religion' },
  { text: 'Tenants must be able-bodied; no wheelchairs.', category: 'disability' },
  { text: 'This unit is not suitable for the disabled.', category: 'disability' },
  { text: 'Female-only housing available now.', category: 'sex' },
  { text: 'The perfect bachelor pad in the city.', category: 'sex' },
  { text: 'No seniors in this energetic building.', category: 'age' },
  { text: 'A safe neighborhood for the right resident.', category: 'steering' },
  { text: 'Join our exclusive community.', category: 'steering' },
];

const CLEAN: string[] = [
  'This spacious two-bedroom has a renovated kitchen and in-unit laundry.',
  'We offer flexible lease terms and online rent payments.',
  'All applicants are welcome and screened under the same criteria.',
  'The community features a fitness center, pool, and pet-friendly grounds.',
  'Tours are available daily — book online or reply to schedule one.',
  'Rent is $1,495/month with a $300 deposit; utilities are billed via RUBS.',
];

test('guardrail flags every problematic phrase with the right category', () => {
  for (const c of FLAGGED) {
    const r = screenFairHousing(c.text);
    assert.equal(r.ok, false, `should flag: ${c.text}`);
    assert.ok(
      r.flags.some((f) => f.category === c.category),
      `expected a ${c.category} flag for "${c.text}", got ${JSON.stringify(r.flags.map((f) => f.category))}`,
    );
  }
});

test('guardrail passes clean, compliant copy untouched', () => {
  for (const t of CLEAN) {
    const r = screenFairHousing(t);
    assert.equal(r.ok, true, `should be clean: ${t} (flags: ${JSON.stringify(r.flags)})`);
    assert.equal(r.safe, t, 'clean text should be returned unchanged');
  }
});

test('the neutral rewrite is itself fair-housing-safe (idempotent)', () => {
  for (const c of FLAGGED) {
    const r = screenFairHousing(c.text);
    assert.equal(isFairHousingSafe(r.safe), true, `rewrite still flagged: "${r.safe}"`);
  }
});

test('approved neutral scripts pass the guardrail', () => {
  assert.equal(isFairHousingSafe(NEUTRAL_SCRIPTS.greeting('Alex', 'Summit Ridge')), true);
  assert.equal(isFairHousingSafe(NEUTRAL_SCRIPTS.availability('Summit Ridge')), true);
  assert.equal(isFairHousingSafe(NEUTRAL_SCRIPTS.tour('Summit Ridge')), true);
  assert.equal(isFairHousingSafe(NEUTRAL_SCRIPTS.followUp('Summit Ridge')), true);
});
