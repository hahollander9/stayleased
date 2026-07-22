import { q1, run, insert, j, js } from './db.ts';
import { id } from './ids.ts';
import { nowIso } from './dates.ts';
import { audit } from './audit.ts';
import type { Ctx } from './auth.ts';

/** Settings hierarchy (M1.3): code defaults → org defaults → property
 * overrides. Values are JSON. */

export const SETTING_DEFAULTS: Record<string, any> = {
  // receivables / late fees
  late_fee_policy: { graceDays: 3, type: 'flat_plus_daily', flatCents: 5000, dailyCents: 1000, dailyCapCents: 15000, minBalanceCents: 5000 },
  nsf_fee_cents: 3500,
  prorate_method: 'actual_days', // actual_days | thirty_day
  payment_methods: { ach: true, card: true, cash_equivalent: true },
  convenience_fee: { achCents: 0, cardPct: 2.95 },
  partial_payments: { allow: true, blockWhenEvictionFiled: true },
  payment_application_order: ['deposit', 'rent', 'utility', 'fee', 'other'],
  autopay_day: 1,
  // deposits
  deposit_interest_pct: 0,
  deposit_disposition_days: 30,
  notice_period_days: 30,
  // leasing
  application_fee_cents: 5500,
  admin_fee_cents: 15000,
  hold_window_days: 5,
  screening_criteria: {
    version: 1,
    incomeMultiple: 2.5,
    minCreditScore: 620,
    conditionalCreditScore: 560,
    evictionLookbackYears: 5,
    felonyLookbackYears: 7,
    conditionalDepositMultiplier: 1.5,
  },
  tour_hours: { start: '09:00', end: '17:30', days: [1, 2, 3, 4, 5, 6], slotMinutes: 30 },
  followup_cadence_days: [0, 1, 3, 7, 14],
  // renewals & pricing
  mtm_premium_pct: 15,
  renewal_max_increase_pct: 8,
  renewal_offer_lead_days: 90,
  // comms
  quiet_hours: { start: '21:00', end: '08:00' },
  business_hours: { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] },
  // insurance
  master_policy_fee_cents: 1450,
  required_liability_cents: 10000000,
  auto_enroll_on_lapse: true,
  // verticals (M18)
  academic_calendar: { fallStart: '2026-08-20', fallEnd: '2027-07-31' },
  bah_table: {
    'E-4': { with_deps: 202500, without_deps: 168000 },
    'E-5': { with_deps: 214500, without_deps: 177000 },
    'E-6': { with_deps: 229500, without_deps: 189000 },
    'O-1': { with_deps: 217500, without_deps: 180000 },
    'O-3': { with_deps: 253500, without_deps: 214500 },
  },
  // AI layer (M17)
  ai_enabled: true, // global kill switch — false pauses every AI agent org-wide
  ai_autonomy: { leasing: 'approve', maintenance: 'approve', payments: 'draft', renewals: 'draft' },
  ai_plan_bounds: { maxInstallments: 4, minInstallmentCents: 15000 },
  ai_renewal_max_discount_pct: 2.5,
  pet_policy: { maxPets: 2, petRentCents: 3500, depositCents: 25000, restricted: 'per city ordinance list' },
  // approvals
  je_approval_threshold_cents: 500000,
  invoice_approval_threshold_cents: 250000,
  po_approval_threshold_cents: 100000,
  match_price_tolerance_pct: 2.5, // 3-way match variance tolerance
  writeoff_approval_threshold_cents: 50000,
};

export function getSetting<T = any>(ctx: Ctx, key: string, propertyId?: string | null): T {
  const def = SETTING_DEFAULTS[key];
  const orgRow = q1<{ value: string }>(
    "SELECT value FROM settings WHERE org_id=? AND property_id='' AND key=?",
    ctx.orgId,
    key,
  );
  let out = orgRow ? j(orgRow.value, def) : def;
  if (propertyId) {
    const propRow = q1<{ value: string }>(
      'SELECT value FROM settings WHERE org_id=? AND property_id=? AND key=?',
      ctx.orgId,
      propertyId,
      key,
    );
    if (propRow) out = j(propRow.value, out);
  }
  return out as T;
}

export function setSetting(ctx: Ctx, key: string, value: any, propertyId?: string | null): void {
  const pid = propertyId || '';
  const before = q1<{ id: string; value: string }>(
    'SELECT id, value FROM settings WHERE org_id=? AND property_id=? AND key=?',
    ctx.orgId,
    pid,
    key,
  );
  if (before) {
    run('UPDATE settings SET value=?, updated_at=? WHERE id=?', js(value), nowIso(), before.id);
  } else {
    insert('settings', { id: id('set'), org_id: ctx.orgId, property_id: pid, key, value: js(value), updated_at: nowIso() });
  }
  audit(ctx, 'setting', `${pid || 'org'}:${key}`, 'update', { value: before ? j(before.value, null) : null }, { value });
}

export function clearSetting(ctx: Ctx, key: string, propertyId?: string | null): void {
  run('DELETE FROM settings WHERE org_id=? AND property_id=? AND key=?', ctx.orgId, propertyId || '', key);
  audit(ctx, 'setting', `${propertyId || 'org'}:${key}`, 'clear');
}
