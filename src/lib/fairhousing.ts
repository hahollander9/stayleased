/**
 * Deterministic fair-housing guardrail (§ governance).
 *
 * ANY prospect- or resident-facing AI text is screened here BEFORE it can be
 * shown or sent. The screen is a fixed rule set — no model in the loop — so it
 * is reproducible and unit-testable. Flagged phrases are replaced with approved
 * neutral wording; the caller gets both the flags (for audit) and a `safe`
 * rewrite. This mirrors the protected classes under the federal Fair Housing
 * Act plus commonly-protected source-of-income, and the classic "steering"
 * phrases HUD guidance calls out.
 */

export type FhCategory =
  | 'familial-status'
  | 'race-national-origin'
  | 'religion'
  | 'disability'
  | 'sex'
  | 'source-of-income'
  | 'age'
  | 'steering';

export interface FhFlag {
  category: FhCategory;
  phrase: string;
  why: string;
}

interface Rule {
  re: RegExp;
  category: FhCategory;
  why: string;
  /** neutral replacement (a plain string; capture groups are dropped) */
  replace: string;
}

// Ordered, case-insensitive. `\b` boundaries keep matches word-scoped.
const RULES: Rule[] = [
  // familial status
  { re: /\bno (kids|children)\b/gi, category: 'familial-status', why: 'excludes families with children', replace: '' },
  { re: /\b(adults?[- ]only|adult community|adult living)\b/gi, category: 'familial-status', why: 'excludes families with children', replace: '' },
  { re: /\bno (families|strollers)\b/gi, category: 'familial-status', why: 'excludes families with children', replace: '' },
  { re: /\b(empty[- ]nesters?)\b/gi, category: 'familial-status', why: 'steers by household composition', replace: 'residents' },
  { re: /\bperfect for (a )?(single|singles|couples?|bachelors?)\b/gi, category: 'familial-status', why: 'steers by household composition', replace: 'a great fit' },
  { re: /\b(young )?professionals?( only)?\b/gi, category: 'familial-status', why: '"young professionals" steers by age/household', replace: 'residents' },
  // race / national origin
  { re: /\bno (blacks?|whites?|asians?|hispanics?|latinos?|africans?)\b/gi, category: 'race-national-origin', why: 'excludes by race or national origin', replace: '' },
  { re: /\benglish[- ]only\b/gi, category: 'race-national-origin', why: 'excludes by national origin', replace: '' },
  // religion
  { re: /\b(christian|catholic|jewish|muslim|hindu)[- ]?(community|building|only|preferred)\b/gi, category: 'religion', why: 'excludes or prefers by religion', replace: '' },
  // disability
  { re: /\bable[- ]bodied\b/gi, category: 'disability', why: 'excludes people with disabilities', replace: '' },
  { re: /\bno wheelchairs?\b/gi, category: 'disability', why: 'excludes people with disabilities', replace: '' },
  { re: /\bmust be able to (walk|climb|stand|see|hear)\b/gi, category: 'disability', why: 'excludes people with disabilities', replace: '' },
  { re: /\bnot (suitable|appropriate) for (the )?(disabled|handicapped)\b/gi, category: 'disability', why: 'excludes people with disabilities', replace: '' },
  { re: /\bhandicapped?\b/gi, category: 'disability', why: 'outdated/derogatory disability term', replace: 'accessible' },
  // sex
  { re: /\b(male|female|men|women|ladies|gentlemen)[- ]only\b/gi, category: 'sex', why: 'excludes by sex', replace: '' },
  { re: /\bbachelor pad\b/gi, category: 'sex', why: 'steers by sex/household', replace: 'home' },
  // source of income
  { re: /\bno (section[- ]?8|vouchers?|housing assistance)\b/gi, category: 'source-of-income', why: 'excludes by source of income', replace: '' },
  // age
  { re: /\bno (seniors?|elderly)\b/gi, category: 'age', why: 'excludes by age', replace: '' },
  { re: /\bmature (adults?|residents?|tenants?)\b/gi, category: 'age', why: 'steers by age', replace: 'residents' },
  // steering (location/quality)
  { re: /\bsafe (neighborhood|community|area|building)\b/gi, category: 'steering', why: '"safe" can imply steering by protected class', replace: 'convenient $1' },
  { re: /\bexclusive (community|building|neighborhood)\b/gi, category: 'steering', why: '"exclusive" can imply steering', replace: 'welcoming $1' },
];

function tidy(s: string): string {
  return s.replace(/\s{2,}/g, ' ').replace(/\s+([.,!?;:])/g, '$1').replace(/\(\s*\)/g, '').trim();
}

export interface FhResult {
  ok: boolean;
  flags: FhFlag[];
  safe: string;
}

/** Screen any prospect/resident-facing text. Returns flags + a neutral rewrite. */
export function screenFairHousing(text: string): FhResult {
  const flags: FhFlag[] = [];
  let safe = text;
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    const matches = text.match(rule.re);
    if (matches) {
      for (const m of matches) flags.push({ category: rule.category, phrase: m.trim(), why: rule.why });
      safe = safe.replace(rule.re, rule.replace);
    }
  }
  return { ok: flags.length === 0, flags, safe: tidy(safe) };
}

/** Convenience: true when the text is clean. */
export function isFairHousingSafe(text: string): boolean {
  return screenFairHousing(text).ok;
}

/**
 * Approved neutral scripts — inherently fair-housing-safe wording used as the
 * default for public-site auto-replies (live-LLM replies are opt-in and are
 * themselves passed back through screenFairHousing before sending).
 */
export const NEUTRAL_SCRIPTS = {
  greeting: (name: string, community: string): string =>
    `Hi ${name || 'there'} — thanks for your interest in ${community}! We'd love to help you find a home. All applicants are welcome and considered under equal-housing standards.`,
  availability: (community: string): string =>
    `${community} has homes available now. Pricing and availability update in real time on our site, and we'd be glad to schedule a tour at a time that works for you.`,
  tour: (community: string): string =>
    `You can book a tour of ${community} online in a couple of taps, or reply here and we'll set one up. We look forward to showing you around.`,
  followUp: (community: string): string =>
    `Just following up from ${community} — happy to answer any questions about floor plans, pricing, or the application. Reply any time.`,
} as const;

/** Standard label appended to AI-generated, resident/prospect-facing copy. */
export const AI_LABEL = 'Drafted by StayLeased AI · reviewed under fair-housing guardrails';
