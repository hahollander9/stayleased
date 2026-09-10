import { q, q1, insert, run } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, fmtDate } from '../../lib/dates.ts';
import { audit } from '../../lib/audit.ts';
import type { Ctx } from '../../lib/auth.ts';
import { getSettingMerged, setSetting } from '../../lib/settings.ts';
import { reportDefs, reportDef } from '../m14_reports/engine.ts';
import { AGENTS, autonomyFor, aiEnabled, type Autonomy, type AgentKey } from './framework.ts';
import { registerOp, Ambiguous, type OpArgs } from './ops.ts';

/** Standing behavior, set up by sentence.
 *
 * The operations in `ops_catalog.ts` each change one record once. These change
 * what happens from now on, which is the other half of "everything you could
 * do by hand": an operator does not only settle this deposit, they also decide
 * that the aged-receivables report arrives every Monday and that the Renewals
 * agent may send without asking.
 *
 * Deliberately NOT a new automation engine. StayLeased already has two, and a
 * third — a rules table Ask alone could write to — would be a second way for
 * recurring work to exist, invisible on the screens that own it and impossible
 * to reason about when the two disagree. So each operation here drives an
 * existing surface and shows up on it:
 *
 *   · `saved_reports.schedule`, run by the `report_delivery` day job
 *   · the per-agent autonomy dials at /ai?view=dials
 *   · the global AI kill switch
 *
 * Which means everything set up through Ask can be seen, edited and undone
 * from the screen that has always owned it, by someone who never used Ask. */

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

// ------------------------------------------------------- scheduled report ----

const CADENCE: Record<string, string> = {
  daily: 'every day',
  weekly: 'every Monday',
  monthly: 'on the 1st of each month',
};

/** The report a person named. Reports have long formal names ("Aged
 * receivables (A/R aging)"), and people say "the aging report", so this
 * matches on any word and refuses two matches rather than picking. */
function resolveReport(ctx: Ctx, term: string): { key: string; name: string } {
  const t = str(term).toLowerCase();
  if (!t) throw new Ambiguous('report', term, []);
  const defs = reportDefs().filter((d) => !d.perm || ctx.perms.has(d.perm));
  const exact = defs.filter((d) => d.key.toLowerCase() === t || d.name.toLowerCase() === t);
  if (exact.length === 1) return { key: exact[0]!.key, name: exact[0]!.name };
  const words = t.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3);
  const hits = defs.filter((d) => {
    const hay = `${d.key} ${d.name}`.toLowerCase();
    return words.length > 0 && words.every((w) => hay.includes(w));
  });
  if (hits.length === 1) return { key: hits[0]!.key, name: hits[0]!.name };
  throw new Ambiguous('report', term, hits.map((d) => ({ id: d.key, label: d.name })));
}

registerOp({
  key: 'report.schedule',
  name: 'Schedule a recurring report',
  describe: 'Have a report run on a cadence and arrive as a CSV in the message console. Choose when the operator says "every Monday", "each month", "daily" about a report.',
  perm: 'reports:view',
  risk: 'record',
  params: [
    { key: 'report', type: 'text', label: 'Report', required: true, hint: 'the report by name, e.g. "aged receivables"' },
    { key: 'cadence', type: 'enum', label: 'Cadence', required: true, values: ['daily', 'weekly', 'monthly'] },
  ],
  preview: (ctx, args) => {
    const blockers: string[] = [];
    const warnings: string[] = [];
    let name = str(args.report);
    let key = '';
    try {
      const r = resolveReport(ctx, str(args.report));
      name = r.name;
      key = r.key;
    } catch (e) {
      blockers.push((e as Error).message);
    }
    const cadence = str(args.cadence) || 'weekly';
    const existing = key ? savedFor(ctx, key) : null;
    const me = q1<{ email: string }>('SELECT email FROM users WHERE id=?', ctx.userId);
    if (!me?.email) warnings.push('Your user has no email address on file, so the CSV will be filed but not delivered.');
    if (existing?.schedule === cadence) {
      blockers.push(`${name} already runs ${CADENCE[cadence]}.`);
    }
    return {
      summary: blockers.length
        ? `Cannot schedule ${name}.`
        : `Runs ${name} ${CADENCE[cadence] || cadence} from now on and delivers the CSV to ${me?.email || 'your message console'}.`,
      changes: blockers.length ? [] : [
        { label: 'Report', value: name },
        { label: 'Runs', value: CADENCE[cadence] || cadence },
        { label: 'Delivered to', value: me?.email || 'message console' },
        { label: existing ? 'Existing schedule' : 'Saved report', value: existing ? (existing.schedule ? `${CADENCE[existing.schedule]} — replaced` : 'saved, not scheduled — now scheduled') : 'created' },
      ],
      blockers,
      warnings,
    };
  },
  apply: (ctx, args) => {
    const { key, name } = resolveReport(ctx, str(args.report));
    const cadence = str(args.cadence) || 'weekly';
    const existing = savedFor(ctx, key);
    if (existing) {
      run('UPDATE saved_reports SET schedule=? WHERE id=? AND org_id=?', cadence, existing.id, ctx.orgId);
      audit(ctx, 'saved_report', existing.id, 'schedule', { schedule: existing.schedule }, { schedule: cadence });
      return `${name} now runs ${CADENCE[cadence]}.`;
    }
    const sid = id('svr');
    insert('saved_reports', {
      id: sid, org_id: ctx.orgId, owner_user_id: ctx.userId, name,
      kind: 'canned', dataset: key, config: '{}', shared: 0,
      schedule: cadence, last_run_date: null, created_at: nowIso(),
    });
    audit(ctx, 'saved_report', sid, 'create', null, { name, dataset: key, schedule: cadence });
    return `${name} now runs ${CADENCE[cadence]} and lands in your message console.`;
  },
});

/** This user's saved copy of a catalog report, if they already have one — so
 * "email me the aging report every Monday" twice does not leave two of them. */
function savedFor(ctx: Ctx, reportKey: string): { id: string; schedule: string | null } | undefined {
  return q1(
    `SELECT id, schedule FROM saved_reports
      WHERE org_id=? AND owner_user_id=? AND kind='canned' AND dataset=? ORDER BY created_at LIMIT 1`,
    ctx.orgId, ctx.userId, reportKey,
  );
}

export function scheduledReportsFor(ctx: Ctx): { name: string; schedule: string }[] {
  return q<{ name: string; schedule: string }>(
    `SELECT name, schedule FROM saved_reports
      WHERE org_id=? AND owner_user_id=? AND schedule IS NOT NULL ORDER BY name`,
    ctx.orgId, ctx.userId,
  );
}

// -------------------------------------------------------- agent autonomy ----

const LEVEL: Record<Autonomy, string> = {
  draft: 'drafts only — a person sends',
  approve: 'drafts and waits for one-click approval',
  auto: 'acts on its own, with every action audited',
};

/** The words operators actually use for the three dials. */
const LEVEL_WORDS: [RegExp, Autonomy][] = [
  [/^(draft|drafts|draft.?only|off|manual|suggest)/i, 'draft'],
  [/^(approve|approval|review|ask|one.?click|supervis)/i, 'approve'],
  [/^(auto|autonomous|automatic|on its own|full|unattended)/i, 'auto'],
];

function resolveAgent(ctx: Ctx, term: string): { key: AgentKey; name: string } {
  const t = str(term).toLowerCase();
  const dialled = AGENTS.filter((a) => a.dial);
  const hits = dialled.filter((a) => a.key === t || a.name.toLowerCase().includes(t) || t.includes(a.key));
  if (hits.length === 1) return { key: hits[0]!.key, name: hits[0]!.name };
  throw new Ambiguous('agent', term, dialled.map((a) => ({ id: a.key, label: a.name })));
}

registerOp({
  key: 'agent.autonomy',
  name: 'Set an AI agent’s autonomy',
  describe: 'Change how much an AI agent may do without a person: draft only, draft-and-approve, or act autonomously. Choose when told to let an agent send on its own, or to pull it back to drafts.',
  perm: 'ai:configure',
  risk: 'admin',
  params: [
    { key: 'agent', type: 'text', label: 'Agent', required: true, hint: 'leasing, maintenance, payments or renewals' },
    { key: 'level', type: 'text', label: 'Autonomy', required: true, hint: 'draft, approve, or auto' },
    { key: 'property', type: 'property', label: 'Property', hint: 'omit to set it org-wide' },
  ],
  preview: (ctx, args) => {
    const blockers: string[] = [];
    const warnings: string[] = [];
    let name = str(args.agent);
    let key: AgentKey | null = null;
    try {
      const a = resolveAgent(ctx, str(args.agent));
      name = a.name; key = a.key;
    } catch (e) {
      blockers.push((e as Error).message);
    }
    const raw = str(args.level);
    const level = LEVEL_WORDS.find(([re]) => re.test(raw))?.[1];
    if (!level) blockers.push(`“${raw}” is not one of: draft, approve, auto.`);
    const propId = str(args.property) || null;
    const prop = propId ? q1<{ name: string }>('SELECT name FROM properties WHERE id=? AND org_id=?', propId, ctx.orgId) : null;
    const now = key ? autonomyFor(ctx, key, propId) : null;
    if (level && now === level) {
      blockers.push(`${name} is already set to ${LEVEL[level]}${prop ? ` at ${prop.name}` : ''}.`);
    }
    if (level === 'auto') {
      warnings.push('Autonomous means it acts without waiting for you. Every action is still recorded in AI Activity and can be reviewed after the fact — but it will already have happened.');
    }
    if (!aiEnabled(ctx)) {
      warnings.push('AI is currently paused by the kill switch, so this dial takes effect only once it is switched back on.');
    }
    return {
      summary: blockers.length
        ? `Cannot change ${name}.`
        : `${name}${prop ? ` at ${prop.name}` : ' across the whole org'} ${LEVEL[level!]}.`,
      changes: blockers.length ? [] : [
        { label: 'Agent', value: name },
        { label: 'Scope', value: prop ? prop.name : 'Whole organization' },
        { label: 'From', value: now ? LEVEL[now] : '—' },
        { label: 'To', value: LEVEL[level!] },
      ],
      blockers,
      warnings,
    };
  },
  apply: (ctx, args) => {
    const { key, name } = resolveAgent(ctx, str(args.agent));
    const level = LEVEL_WORDS.find(([re]) => re.test(str(args.level)))?.[1];
    if (!level) throw new Error(`“${str(args.level)}” is not one of: draft, approve, auto.`);
    const propId = str(args.property) || null;
    // Written through the same merged setting the dials screen writes, so the
    // change shows up there rather than in a place only Ask can see.
    const conf = { ...getSettingMerged<Record<string, Autonomy>>(ctx, 'ai_autonomy', propId) };
    conf[key] = level;
    setSetting(ctx, 'ai_autonomy', conf, propId);
    audit(ctx, 'settings', `ai_autonomy${propId ? ':' + propId : ''}`, 'ai_dial_change', null, { agent: key, level, via: 'ask' });
    const prop = propId ? q1<{ name: string }>('SELECT name FROM properties WHERE id=?', propId) : null;
    return `${name}${prop ? ` at ${prop.name}` : ''} now ${LEVEL[level]}.`;
  },
});

// ---------------------------------------------------------- kill switch ----

registerOp({
  key: 'ai.pause',
  name: 'Pause or resume all AI',
  describe: 'The global kill switch. Paused, no agent may act and every proposal is held as a draft. Choose when told to stop, pause, halt, or restart the AI.',
  perm: 'ai:configure',
  risk: 'admin',
  params: [
    { key: 'paused', type: 'boolean', label: 'Paused', required: true, hint: 'true to pause everything, false to resume' },
  ],
  preview: (ctx, args) => {
    const want = args.paused === true;
    const now = !aiEnabled(ctx);
    if (want === now) {
      return {
        summary: `AI is already ${now ? 'paused' : 'running'}.`,
        changes: [], blockers: [`AI is already ${now ? 'paused' : 'running'}.`], warnings: [],
      };
    }
    return {
      summary: want
        ? 'Pauses every AI agent org-wide. Nothing already recorded is undone; work in flight is held in the approval queue as drafts.'
        : 'Resumes every AI agent at the autonomy each one is dialled to.',
      changes: [
        { label: 'From', value: now ? 'Paused' : 'Running' },
        { label: 'To', value: want ? 'Paused' : 'Running' },
        { label: 'Scope', value: 'Whole organization' },
      ],
      blockers: [],
      warnings: want ? [] : ['Agents dialled to autonomous will begin acting again immediately.'],
    };
  },
  apply: (ctx, args) => {
    const want = args.paused === true;
    setSetting(ctx, 'ai_enabled', !want);
    audit(ctx, 'settings', 'ai_enabled', want ? 'ai_pause' : 'ai_resume', null, { via: 'ask' });
    return want ? 'All AI is paused.' : 'AI is running again.';
  },
});
