import { GLOBAL_SEED } from '../rng.ts';
import { env } from '../env.ts';

/** LlmProvider (§3.4): the AI layer's brain. MockLlm is the default — fully
 * deterministic, template-based, grounded ONLY in the structured facts the
 * calling agent passes in — so every AI feature demos offline and tests
 * reproducibly. AnthropicLlm is an optional adapter picked up when
 * ANTHROPIC_API_KEY is set; nothing in the product requires it. */

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

/** Optional real adapter (never required; demos run fully offline). The sync
 * `complete` still returns the deterministic MockLlm fill — a real API call is
 * asynchronous, so live generation goes through `llmGenerate` (below). */
export function makeAnthropicLlm(apiKey: string): LlmProvider {
  void apiKey;
  return { name: 'AnthropicLlm', complete: (task, facts) => MockLlm.complete(task, facts) };
}

// ------------------------------------------------------------------
// Live Anthropic adapter — raw HTTPS to api.anthropic.com (no SDK).
// Server-side only. If the key is absent or any call fails/times out we
// fall back to the caller-supplied deterministic text, so demo mode and the
// public site never break and the key/raw errors are never exposed to clients.
// ------------------------------------------------------------------

import { request as httpsRequest } from 'node:https';

const API_KEY = process.env.ANTHROPIC_API_KEY || env('LLM_KEY') || '';
export const AI_MODEL = process.env.STAYLEASED_AI_MODEL || 'claude-opus-4-8';
const TOKENS_PER_CALL_CAP = Math.max(64, parseInt(process.env.STAYLEASED_AI_MAX_TOKENS || '700', 10) || 700);
const DAILY_TOKEN_CAP = Math.max(0, parseInt(process.env.STAYLEASED_AI_DAILY_TOKEN_CAP || '250000', 10) || 250000);
const CALL_TIMEOUT_MS = 12000;

let provider: LlmProvider = MockLlm;
if (API_KEY) provider = makeAnthropicLlm(API_KEY);

export function llm(): LlmProvider {
  return provider;
}

/** Which brain is active — surfaced (never the key) in the AI console. */
export function llmStatus(): { live: boolean; mode: 'Live' | 'Demo'; model: string; spentToday: number; dailyCap: number } {
  return { live: !!API_KEY, mode: API_KEY ? 'Live' : 'Demo', model: API_KEY ? AI_MODEL : 'MockLlm (deterministic)', spentToday: spend.tokens, dailyCap: DAILY_TOKEN_CAP };
}

// daily spend accounting (wall-clock day; resets on date change)
const spend = { day: '', tokens: 0 };
function accountDay(): string {
  return new Date().toISOString().slice(0, 10);
}
function withinDailyCap(): boolean {
  const d = accountDay();
  if (spend.day !== d) { spend.day = d; spend.tokens = 0; }
  return DAILY_TOKEN_CAP === 0 || spend.tokens < DAILY_TOKEN_CAP;
}

// small response cache (bounded, in-process)
const cache = new Map<string, string>();
const CACHE_MAX = 500;
function cacheGet(k: string): string | undefined { return cache.get(k); }
function cachePut(k: string, v: string): void {
  if (cache.size >= CACHE_MAX) { const first = cache.keys().next().value; if (first !== undefined) cache.delete(first); }
  cache.set(k, v);
}

function anthropicCall(system: string | undefined, prompt: string, maxTokens: number): Promise<{ text: string; outTokens: number }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: AI_MODEL,
      max_tokens: Math.min(maxTokens, TOKENS_PER_CALL_CAP),
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
    });
    const req = httpsRequest(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
          'content-length': Buffer.byteLength(body),
        },
        timeout: CALL_TIMEOUT_MS,
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 400) { reject(new Error(`anthropic_status_${res.statusCode}`)); return; }
          try {
            const parsed = JSON.parse(buf) as { content?: { type: string; text?: string }[]; usage?: { output_tokens?: number }; stop_reason?: string };
            const text = (parsed.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('').trim();
            resolve({ text, outTokens: parsed.usage?.output_tokens ?? 0 });
          } catch { reject(new Error('anthropic_parse')); }
        });
      },
    );
    req.on('error', (e) => reject(e));
    req.on('timeout', () => req.destroy(new Error('anthropic_timeout')));
    req.write(body);
    req.end();
  });
}

export interface LlmResult { text: string; live: boolean; cached: boolean; }

/**
 * Live-or-fallback generation. `fallback` is the deterministic text used when
 * the key is absent, the daily cap is hit, or any call fails — so callers get a
 * useful answer no matter what, and the demo stays reproducible. Raw model
 * errors are swallowed; only the boolean `live` reaches the UI.
 */
export async function llmGenerate(opts: { system?: string; prompt: string; fallback: string; maxTokens?: number; cacheKey?: string }): Promise<LlmResult> {
  if (!API_KEY) return { text: opts.fallback, live: false, cached: false };
  const key = opts.cacheKey ?? String(h((opts.system || '') + ' ' + opts.prompt + ' ' + AI_MODEL));
  const hit = cacheGet(key);
  if (hit !== undefined) return { text: hit, live: true, cached: true };
  if (!withinDailyCap()) return { text: opts.fallback, live: false, cached: false };
  try {
    const { text, outTokens } = await anthropicCall(opts.system, opts.prompt, opts.maxTokens ?? TOKENS_PER_CALL_CAP);
    if (!text) return { text: opts.fallback, live: false, cached: false };
    spend.tokens += outTokens || Math.ceil(text.length / 4);
    cachePut(key, text);
    return { text, live: true, cached: false };
  } catch {
    return { text: opts.fallback, live: false, cached: false };
  }
}
