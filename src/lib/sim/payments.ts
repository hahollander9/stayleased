import { createHash } from 'node:crypto';
import { Rng } from '../rng.ts';
import { getDials } from './dials.ts';

/** PaymentProcessor simulator (§3.4): card + ACH rails. Deterministic — a
 * payment's fate derives from its id + the org dials, so demos and tests
 * reproduce exactly. Test instruments force outcomes (like Stripe test cards):
 * token behavior 'ok' | 'nsf' | 'declined'. */

export interface AuthResult {
  ok: boolean;
  reason?: string;
  processorRef: string;
}

function seededRng(paymentId: string): Rng {
  const h = createHash('sha256').update(paymentId).digest();
  return new Rng(((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0);
}

export function authorizeCard(orgId: string, paymentId: string, tokenBehavior: string): AuthResult {
  const ref = 'ch_' + paymentId.slice(-10);
  if (tokenBehavior === 'declined') return { ok: false, reason: 'card_declined', processorRef: ref };
  const dials = getDials(orgId);
  const rng = seededRng(paymentId);
  if (rng.chance(dials.cardDeclineRatePct / 100)) return { ok: false, reason: 'card_declined', processorRef: ref };
  return { ok: true, processorRef: ref };
}

/** ACH fate is decided at settlement time (returns can lag). */
export function achWillBounce(orgId: string, paymentId: string, tokenBehavior: string): boolean {
  if (tokenBehavior === 'nsf') return true;
  if (tokenBehavior === 'ok_always') return false;
  const dials = getDials(orgId);
  return seededRng(paymentId).chance(dials.nsfRatePct / 100);
}

export function achSettleDays(orgId: string): number {
  return getDials(orgId).achSettleDays;
}

export function settleDaysFor(orgId: string, method: string): number {
  switch (method) {
    case 'ach': return achSettleDays(orgId);
    case 'card': return 1;
    case 'check':
    case 'money_order':
    case 'lockbox': return 1;
    default: return 0;
  }
}

/** processor per-method fees (simulated economics for settlement batches) */
export function processorFeeCents(method: string, amountCents: number): number {
  switch (method) {
    case 'card': return Math.round(amountCents * 0.0265) + 30;
    case 'ach': return 55;
    default: return 0;
  }
}
