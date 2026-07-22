import { q1, insert, run, j, js } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso } from '../../lib/dates.ts';
import { getSetting, SETTING_DEFAULTS } from '../../lib/settings.ts';
import { audit } from '../../lib/audit.ts';
import { emit } from '../../lib/events.ts';
import type { Ctx } from '../../lib/auth.ts';

/** M17 agent framework: every AI action is an ai_actions row with the full
 * input/output and an approval trail. Autonomy is a per-agent, per-property
 * dial — draft-only (human sends), approve-to-send (one click executes), or
 * autonomous-with-audit (executes immediately, reviewable forever).
 * Supervision is a first-class feature, not an afterthought. */

export type Autonomy = 'draft' | 'approve' | 'auto';
export type AgentKey = 'leasing' | 'maintenance' | 'payments' | 'renewals' | 'call_analysis' | 'content' | 'ask';

export const AGENTS: { key: AgentKey; name: string; dial: boolean; describe: string }[] = [
  { key: 'leasing', name: 'Leasing AI', dial: true, describe: 'Answers prospect messages grounded in live availability/pricing/policy; books tours; after-hours coverage.' },
  { key: 'maintenance', name: 'Maintenance AI', dial: true, describe: 'Triage on portal requests — category, priority, emergency escalation, troubleshooting tips, clarifying questions.' },
  { key: 'payments', name: 'Payments AI', dial: true, describe: 'Delinquency outreach with tone grading and payment-plan proposals inside org bounds. Compliance guardrails hard-coded.' },
  { key: 'renewals', name: 'Renewals AI', dial: true, describe: 'Personalized renewal outreach from resident history; evaluates counters within matrix bounds, escalates beyond.' },
  { key: 'call_analysis', name: 'ELI Call Analysis', dial: false, describe: 'Summaries, sentiment, intents, action items and coaching notes from call transcripts. Always audited.' },
  { key: 'content', name: 'Essentials (content)', dial: false, describe: 'Listing descriptions, template drafts, review responses, alt text — generate buttons in the editors.' },
  { key: 'ask', name: 'Ask Oriel', dial: false, describe: 'Staff questions answered from the org\'s own data through service APIs — never raw SQL from the model.' },
];

export function autonomyFor(ctx: Ctx, agent: AgentKey, propertyId?: string | null): Autonomy {
  // layered: code default ← org setting ← property override (partial objects merge)
  const def = (SETTING_DEFAULTS.ai_autonomy || {}) as Record<string, Autonomy>;
  const orgRow = q1<any>(`SELECT value FROM settings WHERE org_id=? AND property_id='' AND key='ai_autonomy'`, ctx.orgId);
  const propRow = propertyId
    ? q1<any>(`SELECT value FROM settings WHERE org_id=? AND property_id=? AND key='ai_autonomy'`, ctx.orgId, propertyId)
    : null;
  const merged: Record<string, Autonomy> = {
    ...def,
    ...(orgRow ? j<Record<string, Autonomy>>(orgRow.value, {}) : {}),
    ...(propRow ? j<Record<string, Autonomy>>(propRow.value, {}) : {}),
  };
  return merged[agent] || 'approve';
}

export interface ActionOutput {
  kind: string; // executor key, e.g. leasing.send_reply
  draft?: string; // human-editable payload (email body etc.)
  subject?: string;
  [k: string]: unknown;
}

export interface Proposal {
  agent: AgentKey;
  propertyId?: string | null;
  entity?: string;
  entityId?: string;
  title: string;
  input: Record<string, unknown>;
  output: ActionOutput;
  confidence?: number; // 0..1
  guardrailNote?: string;
}

type Executor = (ctx: Ctx, action: any, output: ActionOutput) => string; // returns result note
const executors = new Map<string, Executor>();

export function registerExecutor(kind: string, fn: Executor): void {
  executors.set(kind, fn);
}

export function executeAction(ctx: Ctx, actionId: string): string {
  const action = q1<any>('SELECT * FROM ai_actions WHERE id=? AND org_id=?', actionId, ctx.orgId);
  if (!action) throw new Error('action not found');
  if (['executed', 'auto_executed', 'rejected'].includes(action.status)) throw new Error('action already settled');
  const output = j<ActionOutput>(action.output, { kind: 'noop' });
  const fn = executors.get(output.kind);
  if (!fn) throw new Error(`no executor for ${output.kind}`);
  const result = fn(ctx, action, output);
  run(
    `UPDATE ai_actions SET status=?, executed_at=?, result=? WHERE id=?`,
    action.status === 'proposed' && action.autonomy === 'auto' ? 'auto_executed' : 'executed',
    nowIso(), result, actionId,
  );
  audit(ctx, 'ai_action', actionId, 'execute', null, { kind: output.kind, result });
  emit(ctx, 'ai.executed', 'ai_action', actionId, { agent: action.agent, kind: output.kind });
  return result;
}

/** stage an agent proposal; autonomous dials execute immediately (with audit) */
export function propose(ctx: Ctx, p: Proposal): { id: string; status: string; autonomy: Autonomy } {
  const autonomy = AGENTS.find((a) => a.key === p.agent)?.dial ? autonomyFor(ctx, p.agent, p.propertyId) : 'auto';
  const aid = id('aia');
  insert('ai_actions', {
    id: aid, org_id: ctx.orgId, property_id: p.propertyId || null, agent: p.agent,
    entity: p.entity || null, entity_id: p.entityId || null, title: p.title,
    input: js(p.input), output: js(p.output), confidence: p.confidence ?? 0.9,
    autonomy, status: 'proposed', guardrail_note: p.guardrailNote || null,
    decided_by: null, decided_at: null, executed_at: null, result: null, created_at: nowIso(),
  });
  audit(ctx, 'ai_action', aid, 'propose', null, { agent: p.agent, title: p.title, autonomy });
  let status = 'proposed';
  if (autonomy === 'auto' && (p.confidence ?? 0.9) >= 0.7) {
    executeAction(ctx, aid);
    status = 'auto_executed';
  }
  return { id: aid, status, autonomy };
}

export function decideAction(ctx: Ctx, actionId: string, decision: 'approve' | 'reject', opts: { editedDraft?: string; reason?: string } = {}): void {
  const action = q1<any>('SELECT * FROM ai_actions WHERE id=? AND org_id=?', actionId, ctx.orgId);
  if (!action) throw new Error('action not found');
  if (action.status !== 'proposed') throw new Error('action already decided');
  if (decision === 'reject') {
    run(`UPDATE ai_actions SET status='rejected', decided_by=?, decided_at=?, result=? WHERE id=?`, ctx.userName, nowIso(), opts.reason || 'rejected', actionId);
    audit(ctx, 'ai_action', actionId, 'reject', null, { reason: opts.reason });
    return;
  }
  if (opts.editedDraft !== undefined && opts.editedDraft.trim() !== '') {
    const output = j<ActionOutput>(action.output, { kind: 'noop' });
    output.draft = opts.editedDraft;
    run('UPDATE ai_actions SET output=? WHERE id=?', js(output), actionId);
    audit(ctx, 'ai_action', actionId, 'edit_draft', null, {});
  }
  run(`UPDATE ai_actions SET status='approved', decided_by=?, decided_at=? WHERE id=?`, ctx.userName, nowIso(), actionId);
  audit(ctx, 'ai_action', actionId, 'approve', null, {});
  // draft-only dials stop here: the human uses the draft themselves.
  if (action.autonomy !== 'draft') executeAction(ctx, actionId);
}
