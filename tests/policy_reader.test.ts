import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPolicyFromLease, sentences } from '../src/modules/setup/policy_reader.ts';

/** Reading settings out of a lease. The values here decide what residents are
 * charged, so the reader has to be right about what the document SAYS and
 * silent when it says nothing — a missing finding means "the lease did not
 * state this", which must never collapse into a zero. */

const LEASE = `
RESIDENTIAL LEASE AGREEMENT

3. RENT. Resident shall pay monthly rent of $1,450.00 due on the first day of each month.
If rent is not received by the 5th day of the month, Resident shall pay a late charge of
$75.00. Any payment returned by Resident's financial institution for non-sufficient funds
shall incur a returned payment fee of $35.00.

7. PETS. No more than two (2) pets are permitted without written consent. Pet rent of
$35.00 per month per pet shall be added to the monthly rent. A pet deposit of $250.00 is
required prior to occupancy. An assistance animal is not a pet and no pet rent, pet
deposit, or limit on number applies to it.

11. NOTICE. Resident shall provide sixty (60) days written notice of intent to vacate
prior to the end of the term.

14. INSURANCE. Resident shall maintain liability insurance in an amount not less than
$100,000.00 for the duration of the tenancy.

16. HOLDOVER. If Resident remains after expiration without a renewal, the tenancy becomes
month-to-month and rent increases by 15% for the holdover period.
`;

const byKey = (fs: ReturnType<typeof readPolicyFromLease>, key: string, path?: string): number | undefined =>
  fs.find((f) => f.key === key && f.path === path)?.value;

test('reads the money and the deadlines a lease actually states', () => {
  const found = readPolicyFromLease(LEASE);

  assert.equal(byKey(found, 'late_fee_policy', 'flatCents'), 7500, '$75.00 late charge');
  assert.equal(byKey(found, 'late_fee_policy', 'graceDays'), 5, 'grace runs to the 5th');
  assert.equal(byKey(found, 'nsf_fee_cents'), 3500);
  assert.equal(byKey(found, 'pet_policy', 'petRentCents'), 3500);
  assert.equal(byKey(found, 'pet_policy', 'depositCents'), 25000);
  assert.equal(byKey(found, 'pet_policy', 'maxPets'), 2, 'the digits in "two (2)" are the reliable half');
  assert.equal(byKey(found, 'notice_period_days'), 60);
  assert.equal(byKey(found, 'required_liability_cents'), 10000000, '$100,000.00 in cents');
  assert.equal(byKey(found, 'mtm_premium_pct'), 15);
});

test('every finding carries the sentence it was read from', () => {
  const found = readPolicyFromLease(LEASE);
  assert.ok(found.length >= 8);
  for (const f of found) {
    assert.ok(f.quote.length > 12, `${f.key} has a quote`);
    assert.ok(f.quote.length <= 300, 'quotes stay quotable');
  }
  const late = found.find((f) => f.key === 'late_fee_policy' && f.path === 'flatCents')!;
  assert.match(late.quote, /late charge/i, 'the quote is the sentence that says it');
  assert.match(late.quote, /\$75\.00/, 'and contains the number proposed');
});

test('a lease that says nothing about a policy produces no finding for it', () => {
  // silence is not zero: proposing $0 for an unstated fee would be inventing a
  // policy, and confirming it would change what residents are charged
  const quiet = 'RESIDENTIAL LEASE. Resident shall pay monthly rent of $1,200.00 on the first of the month. The premises are located at 12 Main Street.';
  const found = readPolicyFromLease(quiet);
  assert.equal(byKey(found, 'late_fee_policy', 'flatCents'), undefined);
  assert.equal(byKey(found, 'nsf_fee_cents'), undefined);
  assert.equal(byKey(found, 'pet_policy', 'depositCents'), undefined);
  assert.equal(readPolicyFromLease('').length, 0);
  assert.equal(readPolicyFromLease('short').length, 0);
});

test('a percentage late fee is read as a percentage, not as dollars', () => {
  const pct = `RENT. If rent is not received within five (5) days, Resident shall pay a late charge
    equal to 5% of the monthly rent then due.`;
  const found = readPolicyFromLease(pct);
  assert.equal(byKey(found, 'late_fee_policy', 'percent'), 5);
  assert.equal(byKey(found, 'late_fee_policy', 'graceDays'), 5, 'the grace period comes from the same sentence');
  assert.equal(byKey(found, 'late_fee_policy', 'flatCents'), undefined, 'no dollar amount was stated');
});

test('the grace period is read only from the late-fee sentence', () => {
  // "within ... days" is everywhere in a lease. Reading it from a cure or
  // notice clause would set the grace period from an unrelated paragraph.
  const decoys = `ENTRY. Landlord shall give twenty-four (24) hours notice before entry.
    DEFAULT. Resident shall have three (3) days to cure any non-monetary default.
    RENT. A late charge of $50.00 applies if rent is not received by the 7th day of the month.
    REPAIRS. Landlord shall complete repairs within fourteen (14) days of written request.`;
  const found = readPolicyFromLease(decoys);
  assert.equal(byKey(found, 'late_fee_policy', 'graceDays'), 7, 'from the late-fee clause, not the cure or repair clause');
  assert.equal(byKey(found, 'late_fee_policy', 'flatCents'), 5000);
});

test('an assistance-animal sentence never sets a pet limit', () => {
  // reading a pet cap off the fair-housing carve-out would be exactly backwards
  const text = `PETS. An assistance animal is not a pet, and no limit of two pets applies to it.`;
  const found = readPolicyFromLease(text);
  assert.equal(byKey(found, 'pet_policy', 'maxPets'), undefined);
});

test('sentence splitting survives the ragged whitespace pdf extraction produces', () => {
  const ragged = 'RENT.   Rent is due\n\n  on the first.   A late charge of $40.00\napplies after the 3rd day.';
  const s = sentences(ragged);
  assert.ok(s.some((x) => /late charge of \$40\.00 applies after the 3rd day/.test(x)), s.join(' | '));
});
