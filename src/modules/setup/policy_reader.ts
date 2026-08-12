import { parseUsd } from '../../lib/money.ts';

/** Reading policy out of the documents an operator already uploaded.
 *
 * A residential lease states most of what the settings page asks for: the late
 * charge and its grace period, the returned-payment fee, pet rent and deposit,
 * how much notice a resident must give, the renters-insurance minimum. Asking
 * an operator to type those into a form is asking them to transcribe their own
 * contract — and to be right, when the contract is the thing that governs.
 *
 * So this reads them and PROPOSES; nothing here writes a setting. Every finding
 * carries the sentence it came from so the operator confirms against the source
 * rather than trusting a number that appeared.
 *
 * Deterministic by design (regex over sentences, no model call), for the same
 * reason the scorers are: a policy value that decides what a resident is
 * charged must be reproducible and explainable. The AI lane may fill gaps this
 * cannot reach, but it can never be the only reader — and lease text is
 * UNTRUSTED input, so an AI pass must keep the injection fence the lease
 * extractor already uses.
 *
 * What this deliberately never reads: screening thresholds (fair-housing
 * sensitive, and an operator must author them deliberately), AI autonomy and
 * approval thresholds (those are the leash, and a document does not set the
 * leash). */

export interface PolicyFinding {
  /** settings key this speaks to */
  key: string;
  /** sub-field within an object setting; absent for a scalar setting */
  path?: string;
  /** the proposed value, already in the setting's own units (cents, days, %) */
  value: number;
  /** the sentence it was read from, for the operator to check against */
  quote: string;
}

interface Rule {
  key: string;
  path?: string;
  /** how to turn the captured text into the setting's units */
  kind: 'money' | 'int' | 'pct';
  /** which sentence is on this topic — the quote is that whole sentence */
  topic: RegExp;
  /** extracted from within the topic sentence, first match wins */
  value: RegExp[];
  /** a sentence matching this is not about the topic after all */
  not?: RegExp;
}

/** "five (5) days" → 5, "thirty (30)" → 30, "5th" → 5. Leases spell numbers
 * out and then repeat them in digits; the digits are the reliable half. */
function intFrom(raw: string): number | null {
  const paren = /\((\d{1,3})\)/.exec(raw);
  const n = parseInt(paren ? paren[1]! : (/(\d{1,3})/.exec(raw)?.[1] ?? ''), 10);
  return Number.isInteger(n) ? n : null;
}

function moneyFrom(raw: string): number | null {
  try {
    const cents = parseUsd(raw.replace(/[^\d.,]/g, ''));
    return cents > 0 ? cents : null;
  } catch { return null; }
}

const RULES: Rule[] = [
  // ---- late fee: amount, percentage, and the grace period ----
  {
    key: 'late_fee_policy', path: 'flatCents', kind: 'money',
    topic: /late (?:charge|fee|payment charge)/i,
    value: [/\$\s*([\d,]+(?:\.\d{1,2})?)/],
  },
  {
    key: 'late_fee_policy', path: 'percent', kind: 'pct',
    topic: /late (?:charge|fee)/i,
    value: [/([\d]+(?:\.\d+)?)\s*(?:%|percent)/i],
  },
  {
    // read only from the late-fee sentence: "within five (5) days" appears in
    // notice and cure clauses too, and grabbing it from there would set the
    // grace period from an unrelated paragraph
    key: 'late_fee_policy', path: 'graceDays', kind: 'int',
    topic: /late (?:charge|fee)/i,
    value: [
      /(?:by|before|on or before) the\s+(\d{1,2})(?:st|nd|rd|th)/i,
      /after the\s+(\d{1,2})(?:st|nd|rd|th)/i,
      /within\s+([a-z]+\s*\(\d{1,2}\)|\d{1,2})\s*(?:calendar\s+)?days/i,
      /(\d{1,2})[- ]day grace/i,
    ],
  },
  // ---- returned payments ----
  {
    key: 'nsf_fee_cents', kind: 'money',
    topic: /returned (?:check|payment|item)|non-?sufficient funds|\bNSF\b/i,
    value: [/\$\s*([\d,]+(?:\.\d{1,2})?)/],
  },
  // ---- pets ----
  {
    key: 'pet_policy', path: 'petRentCents', kind: 'money',
    topic: /pet rent|monthly pet/i,
    value: [/\$\s*([\d,]+(?:\.\d{1,2})?)/],
  },
  {
    key: 'pet_policy', path: 'depositCents', kind: 'money',
    topic: /pet deposit|deposit for (?:each |any )?pet/i,
    value: [/\$\s*([\d,]+(?:\.\d{1,2})?)/],
  },
  {
    key: 'pet_policy', path: 'maxPets', kind: 'int',
    topic: /(?:no more than|maximum of|limit of|up to)[^.]{0,30}pets?/i,
    value: [/(?:no more than|maximum of|limit of|up to)\s+([a-z]+\s*\(\d{1,2}\)|\d{1,2})/i],
    // an assistance animal is never a pet and never counts against a limit
    not: /assistance|service animal|emotional support/i,
  },
  // ---- notice to vacate ----
  {
    key: 'notice_period_days', kind: 'int',
    topic: /notice (?:to vacate|of intent to vacate|of termination)|written notice[^.]{0,40}vacate/i,
    value: [/([a-z]+\s*\(\d{1,3}\)|\d{1,3})\s*(?:calendar\s+)?days/i],
  },
  // ---- renters insurance ----
  {
    key: 'required_liability_cents', kind: 'money',
    topic: /liability (?:insurance|coverage)|renters?'? insurance/i,
    value: [/\$\s*([\d,]+(?:\.\d{1,2})?)/],
  },
  // ---- one-time fees ----
  {
    key: 'admin_fee_cents', kind: 'money',
    topic: /administrat(?:ive|ion) fee/i,
    value: [/\$\s*([\d,]+(?:\.\d{1,2})?)/],
  },
  {
    key: 'application_fee_cents', kind: 'money',
    topic: /application fee/i,
    value: [/\$\s*([\d,]+(?:\.\d{1,2})?)/],
  },
  // ---- holdover / month-to-month ----
  {
    key: 'mtm_premium_pct', kind: 'pct',
    topic: /month-?to-?month|holdover/i,
    value: [/(?:increase[sd]?|premium|additional)[^.]{0,30}?([\d]+(?:\.\d+)?)\s*(?:%|percent)/i],
  },
];

/** Split into sentences without losing the text a quote needs. Lease PDFs come
 * out of extraction with ragged whitespace, so normalize first. */
export function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.;])\s+(?=[A-Z(“"']|\d)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12);
}

/** Read every policy value this document states. Silent about anything it
 * cannot find: a missing finding means "the lease did not say", which is very
 * different from a zero. */
export function readPolicyFromLease(text: string): PolicyFinding[] {
  if (!text || text.length < 40) return [];
  const out: PolicyFinding[] = [];
  const lines = sentences(text);
  for (const rule of RULES) {
    for (const sentence of lines) {
      if (!rule.topic.test(sentence)) continue;
      if (rule.not && rule.not.test(sentence)) continue;
      let captured: string | null = null;
      for (const re of rule.value) {
        const m = re.exec(sentence);
        if (m && m[1]) { captured = m[1]; break; }
      }
      if (!captured) continue;
      const value = rule.kind === 'money' ? moneyFrom(captured)
        : rule.kind === 'pct' ? (Number.isFinite(Number(captured)) ? Number(captured) : null)
        : intFrom(captured);
      if (value === null || value < 0) continue;
      if (rule.kind === 'pct' && value > 100) continue;
      out.push({ key: rule.key, path: rule.path, value, quote: sentence.slice(0, 300) });
      break; // first sentence on this topic wins; later ones are usually cross-references
    }
  }
  return out;
}
