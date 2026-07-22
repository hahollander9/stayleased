import { GLOBAL_SEED } from '../rng.ts';

/** InsuranceCarrier simulator (§5): deterministic third-party policy
 * verification. Test hooks: policy numbers containing 'REJECT' verify as
 * rejected; 'SLOW' stays pending until re-checked next day; everything else
 * verifies by stable hash (96% pass). */

function strSeed(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return (h ^ GLOBAL_SEED) >>> 0;
}

export const CARRIERS = [
  'Lemonstand Insurance', 'State Farm & Ranch (sim)', 'Allgood Mutual', 'Progressive-ish (sim)', 'Renters Shield Co.',
];

export interface VerifyResult {
  outcome: 'verified' | 'rejected' | 'pending';
  note: string;
}

export function verifyPolicy(carrier: string, policyNumber: string, liabilityCents: number, requiredCents: number): VerifyResult {
  const pn = policyNumber.toUpperCase();
  if (pn.includes('REJECT')) return { outcome: 'rejected', note: 'carrier reports policy not in force' };
  if (pn.includes('SLOW')) return { outcome: 'pending', note: 'carrier verification queued — re-check tomorrow' };
  if (liabilityCents < requiredCents) {
    return { outcome: 'rejected', note: `liability below the required minimum (${(requiredCents / 100).toLocaleString()} required)` };
  }
  const roll = strSeed(carrier + ':' + pn) % 100;
  if (roll < 4) return { outcome: 'rejected', note: 'carrier could not locate this policy number' };
  return { outcome: 'verified', note: `verified with ${carrier}` };
}
