import { q, q1, insert, run, j, js } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso } from '../../lib/dates.ts';
import type { Ctx } from '../../lib/auth.ts';

/** What Ask StayLeased remembers, and where.
 *
 * The conversation used to live in the browser — a JS array on the /ask page,
 * `sessionStorage` in the dock — and it died at a moment the operator never
 * chose. A reload emptied it. Closing the panel deleted it on purpose. The
 * dock and the full page kept separate ones, so "Full page" threw away what
 * you had just said. And the /ask page's own GET handler answered a deep-
 * linked question with no history at all.
 *
 * None of that is a storage preference. An assistant that asks "which Bhatt —
 * unit 204 or unit 512?" and then cannot hear "the one in 204" is worse than
 * one that never asked, because the operator has already answered and believes
 * they are understood. The thread is therefore server-side, per user, and one
 * per user across every surface.
 *
 * A turn stores what it ESTABLISHED, not just what it said:
 *   · `entities` — the records this turn resolved, by type, so "charge them
 *     $50" has something to mean. Carried forward, never guessed at silently:
 *     what a pronoun resolved to is printed on the confirm card.
 *   · `pending` — a clarification still waiting on an answer, with the exact
 *     candidates offered and the instruction that was paused. This is what
 *     makes the next turn an ANSWER rather than a new question.
 *   · `table` — a digest of the rows that were shown, so "which of those owes
 *     the most" is answerable about the thing on screen.
 *
 * Memory expires the way a conversation does: a thread more than a few hours
 * cold is not the conversation you are having now, and quietly resolving
 * "them" against yesterday's household is exactly the failure this file
 * exists to prevent. */

/** A thread goes stale after this long without a turn. Long enough to survive
 * a meeting or a lunch; short enough that "them" never reaches back into a
 * conversation the operator has forgotten having. */
const THREAD_IDLE_MS = 6 * 60 * 60 * 1000;

/** What a turn established. Every field optional: most turns establish little. */
export interface TurnContext {
  /** resolved records by parameter type — { lease: {id,label}, unit: {...} } */
  entities?: Record<string, { id: string; label: string }>;
  /** a question Ask asked that this turn is still waiting on */
  pending?: PendingClarification;
  /** the rows that were on screen, compactly */
  table?: { cols: string[]; rows: string[][] };
  /** the property the answer was scoped to */
  scope?: { id: string; name: string } | null;
}

/** An instruction held mid-air because a reference matched more than one
 * record. It carries everything needed to finish the job once the operator
 * says which one — including the args already resolved, so answering a
 * clarification never re-runs the model or re-asks for the amount. */
export interface PendingClarification {
  kind: string;                 // 'lease' | 'unit' | 'vendor' | …
  paramKey: string;             // which parameter is unresolved
  opKey: string;                // the operation waiting on it
  args: Record<string, string | number | boolean | null>;
  candidates: { id: string; label: string }[];
  question: string;             // the instruction as originally typed
}

export interface AskTurn {
  id: string;
  role: 'you' | 'agent';
  text: string;
  matched: string | null;
  context: TurnContext;
  createdAt: string;
}

function rowToTurn(r: {
  id: string; role: string; text: string; matched: string | null; context: string; created_at: string;
}): AskTurn {
  return {
    id: r.id,
    role: r.role === 'you' ? 'you' : 'agent',
    text: r.text,
    matched: r.matched,
    context: j<TurnContext>(r.context, {}),
    createdAt: r.created_at,
  };
}

/** The thread this user is in right now, started if there isn't one.
 *
 * "Right now" is the load-bearing part: a thread that has gone cold is a
 * different conversation, and continuing it would let a pronoun resolve
 * against a household discussed this morning. */
export function currentThread(ctx: Ctx): string {
  const last = q1<{ thread_id: string; created_at: string }>(
    `SELECT thread_id, created_at FROM ask_turns
      WHERE org_id=? AND user_id=? ORDER BY created_at DESC LIMIT 1`,
    ctx.orgId, ctx.userId,
  );
  if (last) {
    const age = Date.now() - Date.parse(last.created_at);
    if (Number.isFinite(age) && age < THREAD_IDLE_MS) return last.thread_id;
  }
  return id('askt');
}

/** Start a fresh thread. The operator's explicit "new conversation" — the only
 * thing that forgets, now that closing a panel no longer does. */
export function newThread(): string {
  return id('askt');
}

export function remember(
  ctx: Ctx, threadId: string, role: 'you' | 'agent', text: string,
  matched?: string | null, context?: TurnContext,
): void {
  insert('ask_turns', {
    id: id('askm'), org_id: ctx.orgId, user_id: ctx.userId, thread_id: threadId,
    role, text: String(text || '').slice(0, 2000),
    matched: matched || null,
    context: js(context || {}),
    created_at: nowIso(),
  });
}

export function recall(ctx: Ctx, threadId: string, limit = 12): AskTurn[] {
  const rows = q<{ id: string; role: string; text: string; matched: string | null; context: string; created_at: string }>(
    `SELECT id, role, text, matched, context, created_at FROM ask_turns
      WHERE org_id=? AND user_id=? AND thread_id=? ORDER BY created_at DESC LIMIT ?`,
    ctx.orgId, ctx.userId, threadId, limit,
  );
  return rows.reverse().map(rowToTurn);
}

/** Everything the next turn may build on, flattened out of the thread.
 *
 * Later turns win: an entity named two questions ago is superseded by one
 * named in the last, which is what makes "and Foundry?" mean Foundry rather
 * than whatever was on screen first. */
export interface Recall {
  turns: AskTurn[];
  /** a clarification from the most recent agent turn, still unanswered */
  pending: PendingClarification | null;
  /** most recently resolved record of each type */
  entities: Record<string, { id: string; label: string }>;
  /** the last thing the operator asked, for splicing a follow-up onto */
  lastQuestion: string | null;
  /** which handler answered it, so a follow-up can tell topic from modifier */
  lastMatched: string | null;
  /** the rows last shown, for questions about what is on screen */
  table: { cols: string[]; rows: string[][] } | null;
}

export function recallContext(ctx: Ctx, threadId: string, limit = 12): Recall {
  const turns = recall(ctx, threadId, limit);
  const entities: Record<string, { id: string; label: string }> = {};
  let table: Recall['table'] = null;
  let lastQuestion: string | null = null;
  let lastMatched: string | null = null;
  for (const t of turns) {
    if (t.role === 'you') lastQuestion = t.text;
    else lastMatched = t.matched;
    Object.assign(entities, t.context.entities || {});
    if (t.context.table) table = t.context.table;
  }
  // Only the LAST agent turn can hold an open question. An older clarification
  // was either answered or abandoned, and re-applying it would attach this
  // sentence to an instruction the operator has moved on from.
  const lastAgent = [...turns].reverse().find((t) => t.role === 'agent');
  return {
    turns,
    pending: lastAgent?.context.pending || null,
    entities,
    lastQuestion,
    lastMatched,
    table,
  };
}

/** Wipe a thread. Used by the "new conversation" control and by org deletion. */
export function forgetThread(ctx: Ctx, threadId: string): void {
  run('DELETE FROM ask_turns WHERE org_id=? AND user_id=? AND thread_id=?', ctx.orgId, ctx.userId, threadId);
}

// ---------- reading a reply as an answer to a clarification ----------

const ORDINALS: [RegExp, number][] = [
  [/\b(?:the\s+)?(?:first|1st|top|former)\b/i, 0],
  [/\b(?:the\s+)?(?:second|2nd|latter|next one)\b/i, 1],
  [/\b(?:the\s+)?(?:third|3rd)\b/i, 2],
  [/\b(?:the\s+)?(?:fourth|4th)\b/i, 3],
];

/** Which candidate did they mean?
 *
 * Deterministic on purpose — no model runs here. The operator is answering a
 * question Ask itself asked, from a list Ask itself printed, so the match is
 * against that list and nothing else. Anything short of exactly one match
 * returns null and the clarification simply stands: asking twice is mildly
 * annoying, and settling the wrong household's deposit is not.
 *
 * Three ways people answer, in the order they are unambiguous:
 *   "unit 204" / "204"   → a distinguishing token from one label
 *   "the first one"      → an ordinal into the list as printed
 *   "Bhatt-Rao"          → a name fragment matching one label
 */
export function matchCandidate(
  reply: string, candidates: { id: string; label: string }[],
): { id: string; label: string } | null {
  const s = String(reply || '').trim().toLowerCase();
  if (!s || !candidates.length) return null;

  // A bare or embedded unit number is the sharpest signal, and the one people
  // reach for first, because it is what distinguishes the labels on screen.
  const unit = /(?:^|\bunit\s*|\b#\s*|\bin\s+)([0-9]{1,5}[a-z]?)\b/i.exec(s);
  if (unit) {
    const u = unit[1]!.toLowerCase();
    const hit = candidates.filter((c) => new RegExp(`unit ${u}\\b`, 'i').test(c.label));
    if (hit.length === 1) return hit[0]!;
  }

  for (const [re, idx] of ORDINALS) {
    if (re.test(s) && candidates[idx]) return candidates[idx]!;
  }

  // A name fragment: every word the operator used that is long enough to
  // distinguish, requiring exactly one candidate to carry it.
  const words = s.replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
  const scored = candidates.filter((c) => {
    const l = c.label.toLowerCase();
    return words.some((w) => l.includes(w));
  });
  if (scored.length === 1) return scored[0]!;

  return null;
}

// ---------- follow-ups ----------

/** Does this read like a continuation of the last question rather than a new
 * one? Short, or opening with a phrase that only makes sense after something.
 *
 * Used to decide whether to retry the data handlers against the last question
 * spliced with this one — "which units turn this month" + "what about next
 * month" matches the expirations handler and reads "next month" off the
 * combined string, which is the answer the operator expected the first time. */
const FOLLOW_UP = new RegExp(
  '^\\s*(?:and|what about|how about|same (?:for|at|thing)|now|then|also|ok(?:ay)?[,\\s]|' +
  'what if|of those|which of|any (?:at|for|in)|just|only|but)\\b',
  'i',
);

export function looksLikeFollowUp(question: string): boolean {
  const s = String(question || '').trim();
  if (!s) return false;
  if (FOLLOW_UP.test(s)) return true;
  // Very short questions are almost always continuations: "next month?",
  // "at Foundry?", "over $1,000?"
  return s.split(/\s+/).length <= 4 && /\?$/.test(s);
}

/** Splice a follow-up onto the question it continues.
 *
 * Concatenation rather than rewriting, because the handlers already read their
 * topic and their modifiers off the whole string: the old question supplies
 * "turn"/"delinquency", the new one supplies "next month"/"at Foundry", and
 * the handler resolves both without a rewrite step that could invent either. */
export function spliceFollowUp(lastQuestion: string, question: string): string {
  return `${lastQuestion.trim()} ${question.trim()}`.slice(0, 400);
}
