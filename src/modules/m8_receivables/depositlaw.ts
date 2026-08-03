import { q1, insert } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, addDays, diffDays } from '../../lib/dates.ts';
import { getSetting } from '../../lib/settings.ts';
import type { Ctx } from '../../lib/auth.ts';
import { postBothBases } from '../m9_accounting/service.ts';
import { depositHeld } from './payments.ts';
import { audit } from '../../lib/audit.ts';

/** Security-deposit return law, by US jurisdiction. `days` = days after
 * move-out/termination to return the deposit or deliver the itemized
 * statement (the tightest commonly-applicable deadline when a state has
 * several); `interest` = whether interest on held deposits is commonly
 * required (many states condition it on portfolio size, holding period,
 * or locality — the note carries the condition). These are PRESETS to
 * keep operators ahead of the clock, not legal advice: the UI carries a
 * verify-with-counsel disclaimer, and `deposit_disposition_days` can be
 * overridden per property in Settings where a lease or locality differs.
 * An itemized statement is required in effectively every jurisdiction
 * when any portion is withheld — the SODA covers that. */
export interface DepositRule { days: number; interest: boolean; note?: string }

export const DEPOSIT_RULES: Record<string, DepositRule> = {
  AL: { days: 60, interest: false },
  AK: { days: 14, interest: false, note: '14 days with proper notice; 30 if none or wear deductions' },
  AZ: { days: 14, interest: false, note: 'business days' },
  AR: { days: 60, interest: false },
  CA: { days: 21, interest: false, note: 'some cities require interest' },
  CO: { days: 30, interest: false, note: 'up to 60 if the lease says so' },
  CT: { days: 30, interest: true, note: 'interest at the deposit index rate' },
  DE: { days: 20, interest: false },
  DC: { days: 45, interest: true, note: 'interest required; itemized notice within 45 days' },
  FL: { days: 15, interest: false, note: '15 days no claim; 30-day written claim to deduct' },
  GA: { days: 30, interest: false },
  HI: { days: 14, interest: false },
  ID: { days: 21, interest: false, note: 'up to 30 if agreed in writing' },
  IL: { days: 45, interest: true, note: '30 days itemized / 45 return; interest at 25+ units' },
  IN: { days: 45, interest: false },
  IA: { days: 30, interest: false, note: 'interest on deposits held 5+ years' },
  KS: { days: 30, interest: false },
  KY: { days: 60, interest: false },
  LA: { days: 30, interest: false, note: 'one month' },
  ME: { days: 30, interest: false, note: '21 days for tenancy at will' },
  MD: { days: 45, interest: true, note: 'interest required on deposits held 6+ months' },
  MA: { days: 30, interest: true, note: '5% or bank rate; strict escrow rules' },
  MI: { days: 30, interest: false },
  MN: { days: 21, interest: true, note: 'simple interest 1%' },
  MS: { days: 45, interest: false },
  MO: { days: 30, interest: false },
  MT: { days: 30, interest: false, note: '10 days when no deductions' },
  NE: { days: 14, interest: false },
  NV: { days: 30, interest: false },
  NH: { days: 30, interest: true, note: 'interest when held 1+ year' },
  NJ: { days: 30, interest: true, note: 'interest required; annual notice' },
  NM: { days: 30, interest: false, note: 'interest when deposit exceeds 1 month on 1yr+ lease' },
  NY: { days: 14, interest: true, note: 'interest at 6+ unit buildings' },
  NC: { days: 30, interest: false, note: 'interim within 30; final within 60 when damages pend' },
  ND: { days: 30, interest: true, note: 'interest when held 9+ months' },
  OH: { days: 30, interest: false, note: 'interest on large deposits held 6+ months' },
  OK: { days: 45, interest: false },
  OR: { days: 31, interest: false },
  PA: { days: 30, interest: true, note: 'interest after the second year of holding' },
  RI: { days: 20, interest: false },
  SC: { days: 30, interest: false },
  SD: { days: 45, interest: false, note: '14 days to return; 45 with itemized statement' },
  TN: { days: 30, interest: false },
  TX: { days: 30, interest: false },
  UT: { days: 30, interest: false },
  VT: { days: 14, interest: false, note: 'some towns require interest' },
  VA: { days: 45, interest: false },
  WA: { days: 30, interest: false },
  WV: { days: 60, interest: false, note: '45 days after next re-rental in some cases' },
  WI: { days: 21, interest: false },
  WY: { days: 30, interest: false, note: '60 with deductions; +30 if utility charges pend' },
};

const FALLBACK: DepositRule = { days: 30, interest: false, note: 'no state preset — 30-day default' };

export function depositRule(state: string | null | undefined): DepositRule {
  return DEPOSIT_RULES[String(state || '').toUpperCase().trim()] || FALLBACK;
}

/** Effective deadline for a lease's deposit disposition: the per-property
 * settings override wins when set (≠ the org default of the state rule),
 * else the state preset. */
export function depositDeadline(ctx: Ctx, propertyId: string, state: string | null | undefined, moveOut: string | null | undefined): { rule: DepositRule; days: number; due: string | null; daysLeft: number | null } {
  const rule = depositRule(state);
  const override = Number(getSetting(ctx, 'deposit_disposition_days', propertyId) || 0);
  // the org-level default is 30; treat a property-scoped value ≠ default as an explicit override
  const days = override && override !== 30 ? override : rule.days;
  const due = moveOut ? addDays(moveOut, days) : null;
  const daysLeft = due ? diffDays(due, ctx.businessDate) : null;
  return { rule, days, due, daysLeft };
}

/** Accrue simple interest on a held deposit up to the business date and
 * post it: DR 5720 Security Deposit Interest (expense) / CR 2100 held
 * liability, plus a deposit_activity row so depositHeld() reflects it.
 * Rate = deposit_interest_pct setting (percent per year). Accrues from
 * the later of move-in and the last interest posting. Returns cents. */
export function postDepositInterest(ctx: Ctx, leaseId: string): number {
  const lease = q1<any>('SELECT * FROM leases WHERE id=? AND org_id=?', leaseId, ctx.orgId);
  if (!lease) throw new Error('lease not found');
  const held = depositHeld(ctx, leaseId);
  if (held <= 0) throw new Error('no deposit held');
  const pct = Number(getSetting(ctx, 'deposit_interest_pct', lease.property_id) || 0);
  if (pct <= 0) throw new Error('deposit_interest_pct is 0 — set a rate in Settings first');
  const last = q1<any>("SELECT MAX(date) AS d FROM deposit_activity WHERE lease_id=? AND kind='interest'", leaseId);
  const from = (last && last.d) || lease.move_in_date || lease.billing_start_date;
  if (!from) throw new Error('no accrual start date on the lease');
  const days = diffDays(ctx.businessDate, from);
  if (days <= 0) throw new Error('interest is already accrued through today');
  const cents = Math.round((held * (pct / 100) * days) / 365);
  if (cents <= 0) throw new Error(`accrues to $0.00 over ${days} days at ${pct}%`);
  ensureAccount(ctx.orgId, '5720', 'Security Deposit Interest', 'expense');
  postBothBases(ctx, {
    propertyId: lease.property_id, date: ctx.businessDate,
    memo: `Deposit interest — ${lease.household_name} (${days} days @ ${pct}%)`,
    sourceKind: 'deposit', sourceId: leaseId, createdBy: ctx.userId || 'system',
    lines: [
      { account: '5720', debit: cents, memo: 'interest accrual' },
      { account: '2100', credit: cents, memo: 'added to held deposit' },
    ],
  });
  insert('deposit_activity', {
    id: id('da'), org_id: ctx.orgId, property_id: lease.property_id, lease_id: leaseId,
    kind: 'interest', amount_cents: cents, date: ctx.businessDate,
    memo: `${days} days @ ${pct}%/yr`, created_at: nowIso(),
  });
  audit(ctx, 'lease', leaseId, 'deposit_interest_posted');
  return cents;
}

function ensureAccount(orgId: string, code: string, name: string, type: string): void {
  if (q1('SELECT id FROM gl_accounts WHERE org_id=? AND code=?', orgId, code)) return;
  insert('gl_accounts', { id: id('acct'), org_id: orgId, code, name, type, is_control: null, active: 1, sort: 570 });
}
