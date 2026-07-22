import { createHash } from 'node:crypto';
import { Rng } from '../rng.ts';
import { getDials } from './dials.ts';

/** ScreeningBureau simulator (§3.4): credit / criminal / eviction with async
 * turnaround, deterministic per-applicant results (seeded by identity), thin-
 * file and fraud-flag cases. The mix dial shifts the score distribution. */

export interface BureauResult {
  creditScore: number | null;
  creditBand: string;
  criminalFlag: boolean;
  evictionFlag: boolean;
  evictionYearsAgo: number | null;
  thinFile: boolean;
}

function rngFor(identity: string): Rng {
  const h = createHash('sha256').update(identity.toLowerCase()).digest();
  return new Rng(((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0);
}

export function bureauResult(orgId: string, identity: string): BureauResult {
  const rng = rngFor(identity);
  const mix = getDials(orgId).screeningMix;
  const thinFile = rng.chance(0.07);
  if (thinFile) {
    return { creditScore: null, creditBand: 'thin_file', criminalFlag: rng.chance(0.04), evictionFlag: rng.chance(0.03), evictionYearsAgo: null, thinFile: true };
  }
  // base score distribution, shifted by the mix dial
  const shift = mix === 'strict' ? -40 : mix === 'rosy' ? 45 : 0;
  const base = rng.weighted([[770, 22], [710, 26], [655, 22], [605, 16], [550, 9], [500, 5]] as const);
  const score = Math.max(400, Math.min(850, Math.round(base + rng.around(0, 35) + shift)));
  const band = score >= 740 ? 'excellent' : score >= 670 ? 'good' : score >= 600 ? 'fair' : 'poor';
  const evictionFlag = rng.chance(score < 600 ? 0.16 : 0.03);
  return {
    creditScore: score,
    creditBand: band,
    criminalFlag: rng.chance(0.06),
    evictionFlag,
    evictionYearsAgo: evictionFlag ? rng.int(1, 9) : null,
    thinFile: false,
  };
}

/** deterministic test identities (like Stripe test cards) */
export const TEST_IDENTITIES: Record<string, Partial<BureauResult>> = {
  'decline.test@screening.demo': { creditScore: 505, creditBand: 'poor', evictionFlag: true, evictionYearsAgo: 2 },
  'conditions.test@screening.demo': { creditScore: 585, creditBand: 'poor', evictionFlag: false },
  'approve.test@screening.demo': { creditScore: 765, creditBand: 'excellent' },
  'thinfile.test@screening.demo': { creditScore: null, creditBand: 'thin_file', thinFile: true },
};

export function resultFor(orgId: string, email: string, ssnLast4: string | null): BureauResult {
  const test = TEST_IDENTITIES[email.toLowerCase()];
  const base = bureauResult(orgId, `${email}|${ssnLast4 || ''}`);
  return test ? { ...base, criminalFlag: false, evictionYearsAgo: null, evictionFlag: false, thinFile: false, ...test } as BureauResult : base;
}
