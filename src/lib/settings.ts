import { q1, run, insert, j, js } from './db.ts';
import { id } from './ids.ts';
import { nowIso } from './dates.ts';
import { audit } from './audit.ts';
import type { Ctx } from './auth.ts';

/** Settings hierarchy (M1.3): code defaults → org defaults → property
 * overrides. Values are JSON. */

export const SETTING_DEFAULTS: Record<string, any> = {
  // receivables / late fees
  // `percent` is explicit even though the default structure does not use it:
  // the engine reads `policy.percent || 5`, and a field the settings form
  // renders must have a value to render (an absent one makes the whole policy
  // unsavable until someone types into a box the hints call optional).
  late_fee_policy: { graceDays: 3, type: 'flat_plus_daily', flatCents: 5000, percent: 5, dailyCents: 1000, dailyCapCents: 15000, minBalanceCents: 5000 },
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
  ai_first_touch: true, // auto-engage the Leasing AI the moment a website/ILS lead arrives (dials still gate sending)
  ai_autonomy: { leasing: 'approve', maintenance: 'approve', payments: 'draft', renewals: 'draft' },
  ai_plan_bounds: { maxInstallments: 4, minInstallmentCents: 15000 },
  ai_renewal_max_discount_pct: 2.5,
  // M19 agent scoring — scorer #1 (delinquency). mode: 'shadow' writes
  // assessments + shows chips but changes NO behavior; 'active' lets the
  // payments agent grade tone by bucket, hold escalations for humans, and
  // hold renewal offers for escalated households.
  delinquency_scoring: { mode: 'shadow', noticeThresholdDays: 45 },
  // M19 scorer #2 (lead heat). shadow: assessments + chips only; active:
  // Leasing Center orders hot-first and silent hot leads get a call task.
  lead_scoring: { mode: 'shadow' },
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

/** Layer one settings level over another. Objects MERGE key-by-key; anything
 * else replaces. This is the rule `getSetting` does not apply — it swaps a
 * stored object wholesale — which is why callers holding partial overrides
 * (autonomyFor, the settings page) have to merge for themselves. Exported so
 * there is one implementation of the rule rather than one per caller. */
export function layerSetting(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  return plain(base) && plain(over) ? { ...base, ...over } : over;
}

/** getSetting, but levels merge instead of replace — the value a screen should
 * SHOW and edit, so saving it back cannot pin fields the property never set. */
export function getSettingMerged<T = any>(ctx: Ctx, key: string, propertyId?: string | null): T {
  const level = (pid: string): unknown => {
    const row = q1<{ value: string }>('SELECT value FROM settings WHERE org_id=? AND property_id=? AND key=?', ctx.orgId, pid, key);
    return row ? j<unknown>(row.value, undefined) : undefined;
  };
  let out = layerSetting(SETTING_DEFAULTS[key], level(''));
  if (propertyId) out = layerSetting(out, level(propertyId));
  return out as T;
}

/** What a property override should store: only the fields that differ from
 * what the organization already gives it. A full copy would turn "I changed one
 * dial here" into "this property stops following the organization for all of
 * these". Returns undefined when nothing differs — the override row should then
 * not exist at all. Open-ended key maps are exempt: a diff cannot express a
 * deleted key, so those are stored whole. */
export function narrowOverride(orgValue: unknown, next: unknown): unknown {
  const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!plain(orgValue) || !plain(next)) {
    return JSON.stringify(orgValue) === JSON.stringify(next) ? undefined : next;
  }
  const diff: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next)) {
    if (JSON.stringify(orgValue[k]) !== JSON.stringify(v)) diff[k] = v;
  }
  return Object.keys(diff).length ? diff : undefined;
}

/** Is this setting explicitly recorded — at the property, or failing that at
 * the organization — rather than merely arriving as the code default? Callers
 * that blend a setting with a non-settings source of truth (deposit law reads
 * the state statute unless the operator has actually chosen a number) need to
 * tell "the operator set this" from "nobody has touched it", and comparing the
 * value against the code default cannot: a property that deliberately picks
 * the same number as the default reads as untouched. */
export function settingIsExplicit(ctx: Ctx, key: string, propertyId?: string | null): boolean {
  const row = (pid: string): boolean =>
    !!q1<{ id: string }>('SELECT id FROM settings WHERE org_id=? AND property_id=? AND key=?', ctx.orgId, pid, key);
  return (!!propertyId && row(propertyId)) || row('');
}

/** A scorer's rollout mode is an ORGANIZATION decision — M19 doctrine is
 * shadow-first, opt-in per org — while the thresholds beside it in the same
 * settings key are per-property. Reading the mode through a named function
 * rather than an omitted argument makes that deliberate: queues like the aging
 * list and the Leasing Center span properties and have no single property to
 * resolve against, so a per-property mode would make ordering depend on which
 * building you happened to be looking at. */
export function scorerMode(ctx: Ctx, key: 'delinquency_scoring' | 'lead_scoring'): string {
  return getSetting<{ mode?: string }>(ctx, key)?.mode || 'shadow';
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

