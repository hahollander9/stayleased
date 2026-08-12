/** Deterministic lead-intent detection. Lives in lib (not m17) because both
 * the leasing agent (m17) and the lead-heat scorer (m19) read it, and m17
 * already imports m19 — the regexes are the shared, auditable ground truth
 * for "what did the prospect ask". No LLM: intent flags must be reproducible
 * and explainable, because scoring and fair-housing audits depend on them. */

export interface LeadIntent {
  wantsTour: boolean;
  asksPets: boolean;
  asksPrice: boolean;
  asksAvailability: boolean;
  wantsHuman: boolean;
}

export function detectLeadIntent(message: string): LeadIntent {
  const m = message.toLowerCase();
  return {
    wantsTour: /\b(tour|visit|see (it|the place|the unit)|come by|look at|showing|stop by)\b/.test(m),
    asksPets: /\b(pets?|dogs?|cats?|puppy|puppies|kittens?|breeds?)\b/.test(m),
    asksPrice: /\b(price|pricing|rent|cost|how much|rate|special|deal)\b/.test(m),
    asksAvailability: /\b(available|availability|vacan|open|move.?in|when can)\b/.test(m),
    wantsHuman: /\b(human|real person|an agent|call me|speak to someone|talk to a person|manager)\b/.test(m),
  };
}
