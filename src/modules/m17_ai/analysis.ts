import { q, q1, val, insert, run, js } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, addDays } from '../../lib/dates.ts';
import { sysCtx, type Ctx } from '../../lib/auth.ts';
import { registerJob } from '../../lib/jobs.ts';
import { llm } from '../../lib/sim/llm.ts';
import { propose } from './framework.ts';

/** M17.5 ELI Call Analysis: transcripts → summary, sentiment, intent tags,
 * action items (real follow-up tasks), coaching notes, missed-opportunity
 * flags. Always autonomous, always audited. */

const POS = /(great|love|perfect|thanks|thank you|awesome|excited|interested|helpful|wonderful)/gi;
const NEG = /(frustrat|upset|angry|terrible|cancel|disappoint|unacceptable|worst|annoyed|leak still|again)/gi;
const INTENTS: [RegExp, string][] = [
  [/(price|pricing|rent|cost|how much|special)/i, 'pricing'],
  [/(tour|visit|see the|come by|showing)/i, 'tour'],
  [/(maintenance|repair|broken|leak|fix)/i, 'maintenance'],
  [/(renew|lease end|extend)/i, 'renewal'],
  [/(pay|balance|late|fee|autopay)/i, 'payments'],
  [/(pet|dog|cat)/i, 'pets'],
  [/(complain|manager|unhappy|issue)/i, 'complaint'],
];

export interface CallAnalysis {
  summary: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  tags: string[];
  actionItems: string[];
  coaching: string | null;
  missedOpportunity: boolean;
}

export function analyzeTranscript(transcript: string, meta: { direction: string; duration: number; hasTourBooked: boolean }): CallAnalysis {
  const pos = (transcript.match(POS) || []).length;
  const neg = (transcript.match(NEG) || []).length;
  const sentiment = pos > neg + 1 ? 'positive' : neg > pos ? 'negative' : 'neutral';
  const tags = INTENTS.filter(([re]) => re.test(transcript)).map(([, t]) => t);
  const firstLine = transcript.replace(/\s+/g, ' ').trim().slice(0, 150);
  const mins = Math.max(1, Math.round(meta.duration / 60));
  const summary = `${meta.direction === 'in' ? 'Inbound' : 'Outbound'} ${mins}-min call — ${tags.length ? tags.join(', ') : 'general'}. "${firstLine}${transcript.length > 150 ? '…' : ''}"`;

  const actionItems: string[] = [];
  if (/call (me )?back|follow up|get back to me/i.test(transcript)) actionItems.push('Call back requested — schedule follow-up');
  if (/send (me )?(the )?(application|quote|pricing|floor ?plan)/i.test(transcript)) actionItems.push('Send the materials discussed (quote / floorplan / application link)');
  if (tags.includes('tour') && !meta.hasTourBooked) actionItems.push('Wants a tour — none booked yet, reach out with slots');
  if (tags.includes('maintenance')) actionItems.push('Verify a work order exists for the reported issue');

  const missedOpportunity = tags.includes('pricing') && !meta.hasTourBooked && !tags.includes('tour');
  const coaching = missedOpportunity
    ? 'Caller asked about pricing but was never offered a tour — always bridge pricing questions to a tour invite.'
    : neg > pos
      ? 'Tense call: acknowledge first ("you\'re right to be frustrated"), then commit to a specific next step with a time.'
      : null;
  return { summary, sentiment, tags, actionItems, coaching, missedOpportunity };
}

export function analyzeCall(ctx: Ctx, callId: string): CallAnalysis | null {
  const call = q1<any>('SELECT * FROM call_logs WHERE id=? AND org_id=?', callId, ctx.orgId);
  if (!call || !call.transcript) return null;
  const hasTourBooked = call.lead_id
    ? !!q1<any>(`SELECT id FROM tours WHERE lead_id=? AND status IN ('scheduled','completed')`, call.lead_id)
    : false;
  const a = analyzeTranscript(call.transcript, { direction: call.direction, duration: call.duration_seconds || 180, hasTourBooked });
  run(
    `UPDATE call_logs SET ai_summary=?, ai_sentiment=?, ai_tags=? WHERE id=?`,
    llm().complete('call_summary', { summary: a.summary }), a.sentiment, js(a.tags), callId,
  );
  // action items become real follow-up tasks on the lead
  if (call.lead_id) {
    for (const item of a.actionItems) {
      const exists = q1<any>(`SELECT id FROM followup_tasks WHERE lead_id=? AND kind=? AND status='open'`, call.lead_id, `ai: ${item.slice(0, 40)}`);
      if (!exists) {
        insert('followup_tasks', {
          id: id('fut'), org_id: ctx.orgId, property_id: call.property_id, lead_id: call.lead_id,
          kind: `ai: ${item.slice(0, 40)}`, due_date: addDays(ctx.businessDate, 1), status: 'open',
          assigned_to_user_id: call.handled_by || null, done_at: null, created_at: nowIso(),
        });
      }
    }
  }
  propose(ctx, {
    agent: 'call_analysis',
    propertyId: call.property_id,
    entity: 'call_log',
    entityId: callId,
    title: `Call analyzed: ${a.sentiment}, ${a.tags.join('/') || 'general'}${a.missedOpportunity ? ' — MISSED OPPORTUNITY' : ''}`,
    input: { duration: call.duration_seconds, direction: call.direction },
    output: {
      kind: 'noop.analysis',
      summary: a.summary, sentiment: a.sentiment, tags: a.tags,
      actionItems: a.actionItems, coaching: a.coaching ? llm().complete('coaching_note', { note: a.coaching }) : null,
    },
    confidence: 0.95,
  });
  return a;
}

// analysis actions are records, not pending work — noop executor
import { registerExecutor } from './framework.ts';
registerExecutor('noop.analysis', () => 'analysis recorded');

export function analyzeNewCalls(ctx: Ctx): number {
  const calls = q<any>(`SELECT id FROM call_logs WHERE org_id=? AND transcript IS NOT NULL AND ai_summary IS NULL`, ctx.orgId);
  for (const c of calls) analyzeCall(ctx, c.id);
  return calls.length;
}

registerJob({
  key: 'ai_call_analysis',
  name: 'ELI call analysis',
  describe: 'Summarizes new call transcripts — sentiment, intents, action items (as follow-up tasks), coaching notes.',
  run: (ctx) => {
    const n = analyzeNewCalls(ctx);
    return n ? `${n} calls analyzed` : 'no new transcripts';
  },
});

export function callRollup(ctx: Ctx, propertyId?: string | null): {
  total: number;
  analyzed: number;
  sentiment: Record<string, number>;
  topTags: [string, number][];
  missed: number;
} {
  const pf = propertyId ? ' AND property_id=?' : '';
  const params = propertyId ? [propertyId] : [];
  const calls = q<any>(`SELECT ai_sentiment, ai_tags FROM call_logs WHERE org_id=?${pf}`, ctx.orgId, ...params);
  const sentiment: Record<string, number> = { positive: 0, neutral: 0, negative: 0 };
  const tagCount = new Map<string, number>();
  for (const c of calls) {
    if (c.ai_sentiment) sentiment[c.ai_sentiment] = (sentiment[c.ai_sentiment] || 0) + 1;
    for (const t of JSON.parse(c.ai_tags || '[]') as string[]) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  }
  const missed = val<number>(
    `SELECT COUNT(*) FROM ai_actions WHERE org_id=? AND agent='call_analysis' AND title LIKE '%MISSED OPPORTUNITY%'${propertyId ? ' AND property_id=?' : ''}`,
    ctx.orgId, ...params,
  ) || 0;
  return {
    total: calls.length,
    analyzed: calls.filter((c) => c.ai_sentiment).length,
    sentiment,
    topTags: [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
    missed,
  };
}
