import { html, type Raw, type Child } from '../../lib/html.ts';
import { field, input, select, checkbox, moneyInput } from '../../ui/ui.ts';
import { parseUsd } from '../../lib/money.ts';
import { SETTING_DEFAULTS } from '../../lib/settings.ts';

/** The typed face of org settings.
 *
 * Every key in SETTING_DEFAULTS is described here once — its group, its label,
 * what changing it actually does, and the control it deserves — and that one
 * description drives both the form and the parse. The page used to render each
 * key as raw JSON in a text box, which put `bah_table` at the same visual
 * weight as the late fee and made a typo in `late_fee_policy` a silent change
 * to what every resident is charged. Money is entered in dollars, days as
 * days, percentages as percentages, and nothing here accepts hand-written JSON.
 *
 * Adding a setting: add it to SETTING_DEFAULTS and add a spec here. The group
 * must be a member of GROUPS — the Group type is derived from that array, so
 * an unrenderable group is a type error. `specCoverage()` is asserted by the
 * unit suite for the rest: a key with no spec, and a spec naming a key that no
 * longer exists, both fail the build rather than going unnoticed. */

export type Ctl =
  | { t: 'money' }
  | { t: 'int'; unit?: string; min?: number; max?: number }
  | { t: 'pct' }
  | { t: 'num'; step?: string; unit?: string }
  | { t: 'bool'; on: string }
  | { t: 'select'; options: [string, string][] }
  | { t: 'time' }
  | { t: 'date' }
  | { t: 'text'; placeholder?: string }
  | { t: 'weekdays' }
  | { t: 'ints'; unit?: string }
  | { t: 'rank'; options: [string, string][] };

export interface Sub { path: string; label: string; ctl: Ctl; hint?: string }

export interface SettingSpec {
  key: string;
  /** stored and readable, but no code acts on it yet — say so rather than let
   * a label promise behavior the product does not have */
  pending?: boolean;
  group: Group;
  label: string;
  /** what changes in the product when this changes — in the operator's terms */
  help: string;
  ctl?: Ctl;
  subs?: Sub[];
  /** money-grade paths whose object keys are data, not schema (BAH ranks) */
  matrix?: { addLabel: string; cols: Sub[] };
  /** object paths carried through a save untouched (schema versions etc.) */
  preserve?: string[];
}

const AUTONOMY: [string, string][] = [
  ['draft', 'Draft only — staff send'],
  ['approve', 'Draft, staff approves'],
  ['auto', 'Send automatically'],
];
const SCORER: [string, string][] = [
  ['shadow', 'Shadow — score and show, change nothing'],
  ['active', 'Active — let agents act on the score'],
];

export const GROUPS = [
  'Rent, fees and payments',
  'Deposits and move-out',
  'Leasing and screening',
  'Renewals and pricing',
  'Communications',
  'Pets',
  'Insurance',
  'AI and automation',
  'Approval thresholds',
  'Specialty housing',
] as const;

/** The page renders group by group, so a spec's group must BE one of these —
 * derived from the array rather than declared beside it, because a union and a
 * list maintained separately drift, and a spec in a group the page never
 * iterates renders nowhere while typechecking cleanly. */
export type Group = (typeof GROUPS)[number];

export const SPECS: SettingSpec[] = [
  // ---------- Rent, fees and payments ----------
  {
    key: 'late_fee_policy', group: 'Rent, fees and payments', label: 'Late fee policy',
    help: 'When rent is late and what it costs. The grace period runs from the day rent is due; the daily charge stops once it reaches the cap.',
    subs: [
      { path: 'graceDays', label: 'Grace period', ctl: { t: 'int', unit: 'days', min: 0, max: 31 }, hint: 'No late fee before this many days past due.' },
      // these three are exactly what lateFeeCandidates implements — adding an
      // option the engine has no branch for silently assesses nothing at all
      { path: 'type', label: 'Structure', ctl: { t: 'select', options: [['flat', 'Flat fee only'], ['flat_plus_daily', 'Flat fee, then daily'], ['percent', 'Percentage of unpaid rent']] } },
      { path: 'flatCents', label: 'Flat fee', ctl: { t: 'money' }, hint: 'Used by both flat structures.' },
      { path: 'percent', label: 'Percentage', ctl: { t: 'pct' }, hint: 'Used only by the percentage structure.' },
      { path: 'dailyCents', label: 'Daily fee', ctl: { t: 'money' } },
      { path: 'dailyCapCents', label: 'Daily fee stops at', ctl: { t: 'money' }, hint: 'Total daily charges never exceed this.' },
      { path: 'minBalanceCents', label: 'Only charge above', ctl: { t: 'money' }, hint: 'Balances under this are never charged a late fee.' },
    ],
  },
  {
    key: 'nsf_fee_cents', group: 'Rent, fees and payments', label: 'Returned payment fee',
    help: 'Charged to the resident when a payment is returned unpaid by their bank.',
    ctl: { t: 'money' },
  },
  {
    key: 'prorate_method', group: 'Rent, fees and payments', label: 'Proration method',
    help: 'How a partial first or last month of rent is calculated.',
    ctl: { t: 'select', options: [['actual_days', 'Actual days in the month'], ['thirty_day', 'Thirty-day month']] },
  },
  {
    key: 'payment_methods', pending: true, group: 'Rent, fees and payments', label: 'Accepted payment methods',
    help: 'What residents can pay with in the portal.',
    subs: [
      { path: 'ach', label: 'Bank transfer (ACH)', ctl: { t: 'bool', on: 'Accepted' } },
      { path: 'card', label: 'Card', ctl: { t: 'bool', on: 'Accepted' } },
      { path: 'cash_equivalent', label: 'Cash equivalent (money order, certified funds)', ctl: { t: 'bool', on: 'Accepted' } },
    ],
  },
  {
    key: 'convenience_fee', group: 'Rent, fees and payments', label: 'Convenience fees',
    help: 'What the resident pays on top for the convenience of each method. Check your state’s rules before charging one.',
    subs: [
      { path: 'achCents', label: 'Bank transfer fee', ctl: { t: 'money' } },
      { path: 'cardPct', label: 'Card fee', ctl: { t: 'pct' } },
    ],
  },
  {
    key: 'partial_payments', group: 'Rent, fees and payments', label: 'Partial payments',
    help: 'Whether a resident can pay less than the full balance.',
    subs: [
      { path: 'allow', label: 'Accept partial payments', ctl: { t: 'bool', on: 'Allowed' } },
      { path: 'blockWhenEvictionFiled', label: 'Stop accepting once eviction is filed', ctl: { t: 'bool', on: 'Blocked after filing' }, hint: 'In many states accepting rent after filing restarts the process.' },
    ],
  },
  {
    key: 'payment_application_order', group: 'Rent, fees and payments', label: 'Payment application order',
    help: 'When a payment does not cover everything owed, this is the order it pays down. Number them 1 first to 5 last.',
    ctl: { t: 'rank', options: [['deposit', 'Deposit'], ['rent', 'Rent'], ['utility', 'Utilities'], ['fee', 'Fees'], ['other', 'Other']] },
  },
  {
    key: 'autopay_day', pending: true, group: 'Rent, fees and payments', label: 'Autopay draft day',
    help: 'Day of the month enrolled residents are drafted.',
    ctl: { t: 'int', unit: 'of the month', min: 1, max: 28 },
  },

  // ---------- Deposits and move-out ----------
  {
    key: 'deposit_interest_pct', group: 'Deposits and move-out', label: 'Deposit interest',
    help: 'Annual interest credited on held deposits. Required in some states; leave at zero where it is not.',
    ctl: { t: 'pct' },
  },
  {
    key: 'deposit_disposition_days', group: 'Deposits and move-out', label: 'Deposit return deadline',
    help: 'Days after move-out to send the itemized statement and refund. This is set by state law — match your statute.',
    ctl: { t: 'int', unit: 'days after move-out', min: 1, max: 120 },
  },
  {
    key: 'notice_period_days', group: 'Deposits and move-out', label: 'Notice period',
    help: 'How much notice a resident must give before moving out. Also drives renewal timing and move-out checklists.',
    ctl: { t: 'int', unit: 'days', min: 0, max: 180 },
  },

  // ---------- Leasing and screening ----------
  {
    key: 'application_fee_cents', group: 'Leasing and screening', label: 'Application fee',
    help: 'Charged per applicant when they apply. Several states cap this.',
    ctl: { t: 'money' },
  },
  {
    key: 'admin_fee_cents', pending: true, group: 'Leasing and screening', label: 'Administrative fee',
    help: 'One-time fee charged at lease signing.',
    ctl: { t: 'money' },
  },
  {
    key: 'hold_window_days', group: 'Leasing and screening', label: 'Unit hold window',
    help: 'How long an approved applicant’s unit is held before it returns to market.',
    ctl: { t: 'int', unit: 'days', min: 1, max: 60 },
  },
  {
    key: 'screening_criteria', group: 'Leasing and screening', label: 'Screening criteria',
    help: 'The thresholds screening decisions are measured against. These are applied identically to every applicant — that consistency is what makes them defensible.',
    preserve: ['version'],
    subs: [
      { path: 'incomeMultiple', label: 'Income multiple', ctl: { t: 'num', step: '0.1', unit: '× monthly rent' }, hint: 'Monthly income must be at least this many times the rent.' },
      { path: 'minCreditScore', label: 'Minimum credit score', ctl: { t: 'int', min: 300, max: 850 } },
      { path: 'conditionalCreditScore', label: 'Conditional approval score', ctl: { t: 'int', min: 300, max: 850 }, hint: 'Between this and the minimum, approve with a higher deposit.' },
      { path: 'conditionalDepositMultiplier', label: 'Conditional deposit', ctl: { t: 'num', step: '0.1', unit: '× standard deposit' } },
      { path: 'evictionLookbackYears', label: 'Eviction lookback', ctl: { t: 'int', unit: 'years', min: 0, max: 20 } },
      { path: 'felonyLookbackYears', label: 'Criminal lookback', ctl: { t: 'int', unit: 'years', min: 0, max: 20 } },
    ],
  },
  {
    key: 'tour_hours', group: 'Leasing and screening', label: 'Tour hours',
    help: 'When prospects can book a tour. Slots are offered inside this window on the selected days.',
    subs: [
      { path: 'start', label: 'First slot', ctl: { t: 'time' } },
      { path: 'end', label: 'Last slot', ctl: { t: 'time' } },
      { path: 'slotMinutes', label: 'Slot length', ctl: { t: 'int', unit: 'minutes', min: 10, max: 240 } },
      { path: 'days', label: 'Days', ctl: { t: 'weekdays' } },
    ],
  },
  {
    key: 'followup_cadence_days', group: 'Leasing and screening', label: 'Lead follow-up cadence',
    help: 'Days after an inquiry that a follow-up is queued. 0 means same day.',
    ctl: { t: 'ints', unit: 'days after the inquiry' },
  },

  // ---------- Renewals and pricing ----------
  {
    key: 'mtm_premium_pct', group: 'Renewals and pricing', label: 'Month-to-month premium',
    help: 'Rent increase applied when a lease rolls to month-to-month instead of renewing.',
    ctl: { t: 'pct' },
  },
  {
    key: 'renewal_max_increase_pct', group: 'Renewals and pricing', label: 'Maximum renewal increase',
    help: 'A renewal offer can never raise rent by more than this, whatever pricing suggests. Check local rent-cap rules.',
    ctl: { t: 'pct' },
  },
  {
    key: 'renewal_offer_lead_days', pending: true, group: 'Renewals and pricing', label: 'Renewal offer lead time',
    help: 'How far before lease end the renewal offer goes out.',
    ctl: { t: 'int', unit: 'days before lease end', min: 15, max: 240 },
  },

  // ---------- Communications ----------
  {
    key: 'quiet_hours', group: 'Communications', label: 'Quiet hours',
    help: 'No message is sent to a resident inside this window. Anything queued waits for morning.',
    subs: [
      { path: 'start', label: 'Quiet from', ctl: { t: 'time' } },
      { path: 'end', label: 'Quiet until', ctl: { t: 'time' } },
    ],
  },
  {
    key: 'business_hours', group: 'Communications', label: 'Business hours',
    help: 'Your office hours. Used for response-time expectations and for deciding what waits until morning.',
    subs: [
      { path: 'start', label: 'Open', ctl: { t: 'time' } },
      { path: 'end', label: 'Close', ctl: { t: 'time' } },
      { path: 'days', label: 'Open days', ctl: { t: 'weekdays' } },
    ],
  },

  // ---------- Pets ----------
  {
    key: 'pet_policy', group: 'Pets', label: 'Pet policy',
    help: 'Applies to pets only. Assistance animals are never pets: no limit, no rent, no deposit.',
    subs: [
      { path: 'maxPets', label: 'Pets per home', ctl: { t: 'int', unit: 'maximum', min: 0, max: 10 } },
      { path: 'petRentCents', label: 'Pet rent', ctl: { t: 'money' }, hint: 'Per month, per home.' },
      { path: 'depositCents', label: 'Pet deposit', ctl: { t: 'money' } },
      { path: 'restricted', label: 'Restrictions', ctl: { t: 'text', placeholder: 'per city ordinance list' } },
    ],
  },

  // ---------- Insurance ----------
  {
    key: 'master_policy_fee_cents', group: 'Insurance', label: 'Master policy fee',
    help: 'Monthly charge when a resident is covered by your master policy instead of their own.',
    ctl: { t: 'money' },
  },
  {
    key: 'required_liability_cents', group: 'Insurance', label: 'Required liability coverage',
    help: 'Minimum liability a resident’s own renters policy must carry.',
    ctl: { t: 'money' },
  },
  {
    key: 'auto_enroll_on_lapse', group: 'Insurance', label: 'Auto-enroll on lapse',
    help: 'When a resident’s policy lapses, put them on the master policy automatically rather than waiting for staff.',
    ctl: { t: 'bool', on: 'Enroll automatically' },
  },

  // ---------- AI and automation ----------
  {
    key: 'ai_enabled', group: 'AI and automation', label: 'AI agents',
    help: 'The org-wide switch. Off pauses every agent immediately — nothing is drafted, nothing is queued, nothing is sent.',
    ctl: { t: 'bool', on: 'Agents running' },
  },
  {
    key: 'ai_first_touch', group: 'AI and automation', label: 'First touch on new leads',
    help: 'Draft a reply the moment a website or listing lead arrives, instead of waiting for the next agent run. What happens to that draft is still set by the autonomy level below.',
    ctl: { t: 'bool', on: 'Draft immediately' },
  },
  {
    key: 'ai_autonomy', group: 'AI and automation', label: 'Autonomy by area',
    help: 'How far each agent goes on its own. "Draft only" writes and stops; "staff approves" puts it in the approval queue; "automatically" sends without a human. Escalations and adverse-action moments never send automatically, whatever this says.',
    subs: [
      { path: 'leasing', label: 'Leasing', ctl: { t: 'select', options: AUTONOMY } },
      { path: 'maintenance', label: 'Maintenance', ctl: { t: 'select', options: AUTONOMY } },
      { path: 'payments', label: 'Payments and collections', ctl: { t: 'select', options: AUTONOMY } },
      { path: 'renewals', label: 'Renewals', ctl: { t: 'select', options: AUTONOMY } },
    ],
  },
  {
    key: 'ai_plan_bounds', group: 'AI and automation', label: 'Payment plan limits',
    help: 'The widest payment plan an agent may offer without a human deciding.',
    subs: [
      { path: 'maxInstallments', label: 'Maximum installments', ctl: { t: 'int', min: 1, max: 12 } },
      { path: 'minInstallmentCents', label: 'Smallest installment', ctl: { t: 'money' } },
    ],
  },
  {
    key: 'ai_renewal_max_discount_pct', group: 'AI and automation', label: 'Renewal discount ceiling',
    help: 'The most an agent may discount a renewal on its own.',
    ctl: { t: 'pct' },
  },
  {
    key: 'delinquency_scoring', group: 'AI and automation', label: 'Delinquency scoring',
    help: 'Scores every open balance daily into clear, watch, engage or escalate. Shadow shows the score and changes nothing — watch the chips for a few weeks before switching to active.',
    subs: [
      { path: 'mode', label: 'Mode', ctl: { t: 'select', options: SCORER } },
      { path: 'noticeThresholdDays', label: 'Escalation threshold', ctl: { t: 'int', unit: 'days past due', min: 15, max: 120 }, hint: 'Past this, the agent stops writing to the resident and assembles a staff packet instead.' },
    ],
  },
  {
    key: 'lead_scoring', group: 'AI and automation', label: 'Lead heat scoring',
    help: 'Scores open leads hot, warm or cold from behavior and availability. Shadow shows the chips; active also orders the Leasing Center hot-first and queues a call for a silent hot lead.',
    subs: [{ path: 'mode', label: 'Mode', ctl: { t: 'select', options: SCORER } }],
  },

  // ---------- Approval thresholds ----------
  {
    key: 'je_approval_threshold_cents', group: 'Approval thresholds', label: 'Journal entry approval',
    help: 'Manual entries at or above this need a second person to approve.',
    ctl: { t: 'money' },
  },
  {
    key: 'invoice_approval_threshold_cents', group: 'Approval thresholds', label: 'Vendor invoice approval',
    help: 'Invoices at or above this need approval before payment.',
    ctl: { t: 'money' },
  },
  {
    key: 'po_approval_threshold_cents', group: 'Approval thresholds', label: 'Purchase order approval',
    help: 'Purchase orders at or above this need approval before they are issued.',
    ctl: { t: 'money' },
  },
  {
    key: 'match_price_tolerance_pct', group: 'Approval thresholds', label: 'Invoice match tolerance',
    help: 'How far an invoice price may drift from the purchase order before the match fails and a human looks.',
    ctl: { t: 'pct' },
  },
  {
    key: 'writeoff_approval_threshold_cents', group: 'Approval thresholds', label: 'Write-off approval',
    help: 'Write-offs at or above this need approval.',
    ctl: { t: 'money' },
  },

  // ---------- Specialty housing ----------
  {
    key: 'academic_calendar', group: 'Specialty housing', label: 'Academic calendar',
    help: 'Student housing: the lease year by-the-bed terms are written against.',
    subs: [
      { path: 'fallStart', label: 'Term starts', ctl: { t: 'date' } },
      { path: 'fallEnd', label: 'Term ends', ctl: { t: 'date' } },
    ],
  },
  {
    key: 'bah_table', group: 'Specialty housing', label: 'BAH rates by pay grade',
    help: 'Military housing: the Basic Allowance for Housing used to size affordability by rank. Update these when the annual rates publish.',
    matrix: {
      addLabel: 'Add a pay grade',
      cols: [
        { path: 'with_deps', label: 'With dependents', ctl: { t: 'money' } },
        { path: 'without_deps', label: 'Without dependents', ctl: { t: 'money' } },
      ],
    },
  },
];

const DAYS: [number, string][] = [[0, 'Sun'], [1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat']];

/** Every setting must be described exactly once, and every description must
 * name a real setting — checked at startup so a new key cannot slip in
 * unrendered and a renamed one cannot leave a dead control behind. */
export function specCoverage(): { missing: string[]; extra: string[]; strayGroups: string[] } {
  const specced = new Set(SPECS.map((s) => s.key));
  const real = new Set(Object.keys(SETTING_DEFAULTS));
  const known = new Set<string>(GROUPS);
  return {
    missing: [...real].filter((k) => !specced.has(k)),
    extra: [...specced].filter((k) => !real.has(k)),
    // a spec whose group the page never iterates renders nowhere at all
    strayGroups: [...new Set(SPECS.filter((sp) => !known.has(sp.group)).map((sp) => `${sp.key} → ${sp.group}`))],
  };
}

function at(value: unknown, path: string): unknown {
  return (value as Record<string, unknown> | null)?.[path];
}

function control(name: string, ctl: Ctl, value: unknown): Raw {
  switch (ctl.t) {
    case 'money':
      // null renders an empty box: an absent amount must not masquerade as $0.00
      return moneyInput(name, typeof value === 'number' ? value : null);
    case 'int':
      return input(name, { type: 'number', value: String(value ?? ''), step: '1', min: ctl.min === undefined ? undefined : String(ctl.min), max: ctl.max === undefined ? undefined : String(ctl.max) });
    case 'pct':
      return input(name, { type: 'number', value: String(value ?? ''), step: '0.01', min: '0', max: '100' });
    case 'num':
      return input(name, { type: 'number', value: String(value ?? ''), step: ctl.step || '0.1', min: '0' });
    case 'bool':
      return checkbox(name, ctl.on, value === true);
    case 'select':
      return select(name, ctl.options.map(([v, l]) => [v, l] as [string, Child]), String(value ?? ''));
    case 'time':
      return input(name, { type: 'time', value: String(value ?? '') });
    case 'date':
      return input(name, { type: 'date', value: String(value ?? '') });
    case 'text':
      return input(name, { value: String(value ?? ''), placeholder: ctl.placeholder });
    case 'weekdays': {
      const on = new Set(Array.isArray(value) ? (value as number[]) : []);
      return html`<div class="check-row">${DAYS.map(([n, l]) => checkbox(`${name}.${n}`, l, on.has(n)))}</div>`;
    }
    case 'ints':
      return input(name, { value: Array.isArray(value) ? (value as number[]).join(', ') : '', placeholder: '0, 1, 3, 7, 14' });
    case 'rank': {
      const order = Array.isArray(value) ? (value as string[]) : ctl.options.map(([v]) => v);
      return html`<div class="rank-row">${ctl.options.map(([v, l]) => {
        const pos = order.indexOf(v);
        return html`<label class="rank-item"><span>${l}</span>${input(`${name}.${v}`, { type: 'number', value: String(pos < 0 ? order.length + 1 : pos + 1), step: '1', min: '1', max: String(ctl.options.length) })}</label>`;
      })}</div>`;
    }
  }
}

function unitOf(ctl: Ctl): string {
  if (ctl.t === 'int' || ctl.t === 'num' || ctl.t === 'ints') return ctl.unit || '';
  if (ctl.t === 'pct') return '%';
  return '';
}

/** The editable form body for one setting. Field names are `f.<path>`, or
 * plain `f` for a scalar, which is what parseSetting reads back. */
export function renderSetting(spec: SettingSpec, value: unknown): Raw {
  if (spec.matrix) {
    const rows = Object.keys((value as Record<string, unknown>) || {}).sort();
    return html`
      <div class="matrix">
        ${rows.map((rank) => html`
          <div class="matrix-row">
            <b class="matrix-key">${rank}</b>
            ${spec.matrix!.cols.map((c) => field(c.label, control(`f.${rank}.${c.path}`, c.ctl, at(at(value, rank), c.path))))}
            ${checkbox(`drop.${rank}`, 'Remove', false)}
          </div>`)}
        <div class="matrix-row matrix-add">
          ${field(spec.matrix.addLabel, input('add.key', { placeholder: 'E-7' }))}
          ${spec.matrix.cols.map((c) => field(c.label, control(`add.${c.path}`, c.ctl, undefined)))}
        </div>
      </div>`;
  }
  if (spec.subs) {
    return html`<div class="form-grid">${spec.subs.map((s) => field(
      unitOf(s.ctl) ? html`${s.label} <span class="muted">${unitOf(s.ctl)}</span>` : s.label,
      control(`f.${s.path}`, s.ctl, at(value, s.path)),
      s.hint,
    ))}</div>`;
  }
  const ctl = spec.ctl!;
  return html`<div class="form-grid">${field(
    unitOf(ctl) ? html`Value <span class="muted">${unitOf(ctl)}</span>` : 'Value',
    control('f', ctl, value),
  )}</div>`;
}

/** Control types the form always submits. Checkbox-backed types are excluded:
 * an unchecked box sends nothing, so absence IS the value there. For every
 * other type a missing field means a truncated or stale submission, and
 * reading it as blank is how a text field gets cleared, or a follow-up cadence
 * emptied, by a request that never mentioned it. */
const ALWAYS_SUBMITTED = new Set<Ctl['t']>(['money', 'int', 'pct', 'num', 'select', 'time', 'date', 'text', 'ints']);

function readOne(ctl: Ctl, name: string, body: Record<string, unknown>, label: string): unknown {
  const raw = body[name];
  if (raw === undefined && ALWAYS_SUBMITTED.has(ctl.t)) {
    throw new Error(`${label}: the form did not include this field — reload the page and try again.`);
  }
  const str = raw === undefined || raw === null ? '' : String(raw);
  switch (ctl.t) {
    case 'money': {
      if (!str.trim()) throw new Error(`${label}: enter an amount.`);
      let cents: number;
      try { cents = parseUsd(str); } catch { throw new Error(`${label}: enter an amount like 1,250.00.`); }
      // every money setting here is a fee, a threshold or an allowance; a
      // negative one inverts the rule it configures rather than relaxing it
      if (cents < 0) throw new Error(`${label}: cannot be negative.`);
      // a fee or threshold this large is a misplaced decimal, and it posts to
      // the books as an integer-cents journal amount
      if (cents > 100_000_000_00) throw new Error(`${label}: that is larger than any real amount — check the decimal point.`);
      return cents;
    }
    case 'int': {
      // parseInt reads '0x10' as 0 and '12abc' as 12 — store only what was typed
      if (!/^-?\d+$/.test(str.trim())) throw new Error(`${label}: enter a whole number.`);
      const n = parseInt(str.trim(), 10);
      if (!Number.isInteger(n)) throw new Error(`${label}: enter a whole number.`);
      if (ctl.min !== undefined && n < ctl.min) throw new Error(`${label}: cannot be below ${ctl.min}.`);
      if (ctl.max !== undefined && n > ctl.max) throw new Error(`${label}: cannot be above ${ctl.max}.`);
      return n;
    }
    case 'pct': {
      if (!str.trim()) throw new Error(`${label}: enter a percentage.`);
      const n = Number(str);
      if (!Number.isFinite(n)) throw new Error(`${label}: enter a percentage.`);
      if (n < 0 || n > 100) throw new Error(`${label}: must be between 0 and 100.`);
      return n;
    }
    case 'num': {
      if (!str.trim()) throw new Error(`${label}: enter a number.`);
      const n = Number(str);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${label}: enter a positive number.`);
      if (n > 1000) throw new Error(`${label}: that is far outside a sensible range.`);
      return n;
    }
    case 'bool':
      return str === '1';
    case 'select':
      if (!ctl.options.some(([v]) => v === str)) throw new Error(`${label}: choose one of the listed options.`);
      return str;
    case 'time': {
      // m15's inQuietHours does parseInt(start.slice(0,2)) — '99:99' would make
      // the quiet window never open rather than failing here
      const t = /^(\d{2}):(\d{2})$/.exec(str);
      if (!t || Number(t[1]) > 23 || Number(t[2]) > 59) throw new Error(`${label}: enter a time like 09:00.`);
      return str;
    }
    case 'date': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(str) || Number.isNaN(Date.parse(`${str}T00:00:00Z`))) {
        throw new Error(`${label}: enter a date.`);
      }
      return str;
    }
    case 'text':
      return str;
    case 'weekdays': {
      const on = DAYS.filter(([n]) => String(body[`${name}.${n}`] || '') === '1').map(([n]) => n);
      if (!on.length) throw new Error(`${label}: choose at least one day.`);
      return on;
    }
    case 'ints': {
      const parts = str.split(',').map((p) => p.trim()).filter(Boolean);
      // an empty cadence switches lead follow-up off without saying so
      if (!parts.length) throw new Error(`${label}: enter at least one number — an empty list switches this off silently.`);
      if (parts.some((p) => !/^\d+$/.test(p))) throw new Error(`${label}: enter whole numbers separated by commas.`);
      return parts.map((p) => parseInt(p, 10));
    }
    case 'rank': {
      const seen = ctl.options.map(([v, l]) => ({ v, l, pos: parseInt(String(body[`${name}.${v}`] || ''), 10) }));
      if (seen.some((s) => !Number.isInteger(s.pos))) throw new Error(`${label}: number every row.`);
      const positions = new Set(seen.map((s) => s.pos));
      if (positions.size !== seen.length) throw new Error(`${label}: each position can only be used once.`);
      return seen.sort((a, b) => a.pos - b.pos).map((s) => s.v);
    }
  }
}

/** Rebuild a setting's value from a submitted form. Throws with a message
 * written for the person who typed it — the old page accepted any JSON and
 * silently changed how money worked. */
export function parseSetting(spec: SettingSpec, body: Record<string, unknown>, current: unknown): unknown {
  if (spec.matrix) {
    // null-prototype: a row keyed "__proto__" must become data, not a silent
    // no-op against Object.prototype's setter
    const out = Object.create(null) as Record<string, unknown>;
    const stored = (current as Record<string, unknown>) || {};
    // rows come from the SUBMITTED form, not from what is stored now: if
    // someone else added a pay grade since this page loaded, it is absent from
    // this body and must be left alone rather than read as blank and zeroed
    const marker = `.${spec.matrix.cols[0]!.path}`;
    const submitted = Object.keys(body)
      .filter((k) => k.startsWith('f.') && k.endsWith(marker))
      .map((k) => k.slice(2, k.length - marker.length))
      .filter((r) => r.length > 0);
    for (const rank of submitted) {
      if (String(body[`drop.${rank}`] || '') === '1') continue;
      const row: Record<string, unknown> = {};
      for (const c of spec.matrix.cols) row[c.path] = readOne(c.ctl, `f.${rank}.${c.path}`, body, `${rank} ${c.label}`);
      out[rank] = row;
    }
    // rows this form never saw stay exactly as they are
    for (const rank of Object.keys(stored)) {
      if (!submitted.includes(rank) && !(rank in out)) out[rank] = stored[rank];
    }
    const addKey = String(body['add.key'] || '').trim();
    const addFilled = spec.matrix.cols.some((c) => String(body[`add.${c.path}`] || '').trim() !== '');
    if (!addKey && addFilled) {
      throw new Error(`${spec.matrix.addLabel}: name the pay grade, or clear the amounts beside it.`);
    }
    if (addKey) {
      if (addKey in out) throw new Error(`${addKey} is already listed — edit the existing row instead.`);
      const row: Record<string, unknown> = {};
      for (const c of spec.matrix.cols) row[c.path] = readOne(c.ctl, `add.${c.path}`, body, `${addKey} ${c.label}`);
      out[addKey] = row;
    }
    return { ...out };
  }
  if (spec.subs) {
    const out: Record<string, unknown> = {};
    for (const p of spec.preserve || []) {
      const kept = at(current, p);
      if (kept !== undefined) out[p] = kept;
    }
    for (const s of spec.subs) out[s.path] = readOne(s.ctl, `f.${s.path}`, body, s.label);
    return out;
  }
  return readOne(spec.ctl!, 'f', body, spec.label);
}
