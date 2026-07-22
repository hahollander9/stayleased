import { GLOBAL_SEED } from '../rng.ts';

/** LlmProvider (§3.4): the AI layer's brain. MockLlm is the default — fully
 * deterministic, template-based, grounded ONLY in the structured facts the
 * calling agent passes in — so every AI feature demos offline and tests
 * reproducibly. AnthropicLlm is an optional adapter picked up when
 * ORIEL_LLM_KEY is set; nothing in the product requires it. */

export interface LlmProvider {
  name: string;
  /** deterministic completion for a named task over structured facts */
  complete(task: string, facts: Record<string, unknown>): string;
}

function h(s: string): number {
  let x = 5381;
  for (let i = 0; i < s.length; i++) x = (Math.imul(x, 33) ^ s.charCodeAt(i)) >>> 0;
  return (x ^ GLOBAL_SEED) >>> 0;
}

/** stable pick keyed on content so phrasing varies believably but replays identically */
function pick<T>(key: string, options: T[]): T {
  return options[h(key) % options.length]!;
}

const s = (v: unknown): string => String(v ?? '');

export const MockLlm: LlmProvider = {
  name: 'MockLlm (deterministic)',
  complete(task, f): string {
    switch (task) {
      // ---------- leasing ----------
      case 'lead_reply': {
        const opener = pick(s(f.leadName) + s(f.message), [
          `Hi ${s(f.leadName)} — great to hear from you!`,
          `Hi ${s(f.leadName)}, thanks for reaching out!`,
          `Hello ${s(f.leadName)} — happy to help.`,
        ]);
        const parts: string[] = [`<p>${opener}</p>`];
        if (f.units) parts.push(`<p>${s(f.units)}</p>`);
        if (f.pricing) parts.push(`<p>${s(f.pricing)}</p>`);
        if (f.petPolicy) parts.push(`<p>${s(f.petPolicy)}</p>`);
        if (f.tourLine) parts.push(`<p>${s(f.tourLine)}</p>`);
        parts.push(`<p>${pick(s(f.leadId), [
          'Anything else you want to know — just reply here.',
          'Reply with any other questions; I read every message.',
          'Happy to answer anything else!',
        ])}</p><p>— ${s(f.propertyName)} leasing team</p>`);
        return parts.join('');
      }
      // ---------- maintenance ----------
      case 'triage_note':
        return `AI triage: classified as ${s(f.category)} / ${s(f.priority)}${f.emergency ? ' — EMERGENCY keywords detected (' + s(f.keywords) + '), escalated per policy' : ''}. ${s(f.reason)}`;
      case 'troubleshoot_tip':
        return `<p>Hi ${s(f.name)} — before we dispatch a tech, this often fixes itself:</p><p><b>${s(f.tip)}</b></p><p>If that doesn't do it, reply here and we'll get someone out — your request stays open either way.</p>`;
      case 'clarifying_question':
        return `<p>Hi ${s(f.name)} — quick question so we send the right tech with the right parts: ${s(f.question)}</p>`;
      // ---------- payments ----------
      case 'collections_outreach': {
        const tone = s(f.tone);
        const open = tone === 'friendly'
          ? `<p>Hi ${s(f.name)},</p><p>Just a friendly note — your account shows <b>${s(f.balance)}</b> open. If you've already paid, thank you (posting can take a day)!</p>`
          : tone === 'firm'
            ? `<p>Hi ${s(f.name)},</p><p>Your balance of <b>${s(f.balance)}</b> is now ${s(f.days)} days past due. We'd like to get this resolved together this week.</p>`
            : `<p>Hi ${s(f.name)},</p><p>Your account balance of <b>${s(f.balance)}</b> remains open after several notices. Please contact the office so we can settle this before further steps are required by your lease.</p>`;
        const plan = f.planLine ? `<p>${s(f.planLine)}</p>` : '';
        // compliance guardrails are HARD-CODED: dispute path always present, never threats
        return `${open}${plan}<p>You can pay or set up a plan in your resident portal. If you believe this balance is incorrect, reply here or call the office and we will review it with you — you always have the right to dispute.</p><p>— ${s(f.propertyName)}</p>`;
      }
      // ---------- renewals ----------
      case 'renewal_outreach': {
        const streak = Number(f.onTimeStreak) >= 6
          ? `You've paid on time ${s(f.onTimeStreak)} months running — residents like you are exactly who we build for.`
          : 'We hope this year has felt like home.';
        const wo = f.avgRating ? ` Thanks too for the kind ${s(f.avgRating)}★ feedback on our maintenance visits.` : '';
        return `<p>Hi ${s(f.name)},</p><p>${streak}${wo}</p><p>Your lease at ${s(f.propertyName)} ends ${s(f.endDate)}. Your renewal options:</p>${s(f.optionsHtml)}<p>Accept in your portal in one tap, or reply with questions — we'd love to keep you.</p>`;
      }
      case 'counter_assessment':
        return f.withinBounds
          ? `Counter of ${s(f.counter)} on the ${s(f.term)}-month option (offered ${s(f.offered)}) is within the approved band (max ${s(f.maxDiscountPct)}% below matrix). Recommend ACCEPT — retention beats a ${s(f.turnCost)} turn.`
          : `Counter of ${s(f.counter)} is below the approved band for the ${s(f.term)}-month option (offered ${s(f.offered)}, floor ${s(f.floor)}). Escalating to the property manager — do not commit without approval.`;
      // ---------- call analysis ----------
      case 'call_summary':
        return s(f.summary);
      case 'coaching_note':
        return s(f.note);
      // ---------- content ----------
      case 'listing_description':
        return `${pick(s(f.property), ['Sun-splashed', 'Thoughtfully designed', 'Quietly stylish'])} ${s(f.beds)} home at ${s(f.property)} — ${s(f.sqft)} sq ft of ${pick(s(f.plan), ['smart, livable space', 'room to breathe', 'space that works as hard as you do'])}. ${s(f.amenityLine)} Steps from ${s(f.neighborhood)}. From ${s(f.price)}/mo with flexible terms${s(f.special) ? ` — ${s(f.special)}` : ''}. Live pricing and self-scheduled tours online.`;
      case 'review_response':
        return Number(f.stars) >= 4
          ? `Thank you, ${s(f.reviewer)}! ${pick(s(f.reviewer), ['Making this feel like home is the whole job', 'This made our team\'s week', 'We\'ll keep earning it'])} — and we've shared your note with ${s(f.mention) || 'the whole crew'}. See you around the community!`
          : `${s(f.reviewer)}, thank you for the straight talk — this isn't the experience we want anyone to have. I'd like to make it right personally: please reach out to the office and ask for the community manager. We've already flagged ${s(f.mention) || 'the issue you raised'} for follow-up this week.`;
      case 'template_draft':
        return `<p>Hi {{first_name}},</p><p>${s(f.body)}</p><p>— {{property}}</p>`;
      case 'alt_text':
        return `${s(f.subject)} at ${s(f.property)} — ${s(f.detail)}`;
      default:
        return `[MockLlm has no template for task "${task}"]`;
    }
  },
};

/** Optional real adapter (never required; demos run fully offline). */
export function makeAnthropicLlm(apiKey: string): LlmProvider {
  return {
    name: 'AnthropicLlm',
    complete(task, facts): string {
      // The product treats LLM calls as synchronous template fills; a real
      // adapter would call the API here. We keep the deterministic fallback
      // so a missing/failed key can never break a workflow.
      void apiKey;
      return MockLlm.complete(task, facts);
    },
  };
}

let provider: LlmProvider = MockLlm;
if (process.env.ORIEL_LLM_KEY) provider = makeAnthropicLlm(process.env.ORIEL_LLM_KEY);

export function llm(): LlmProvider {
  return provider;
}
