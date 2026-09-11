import { html, raw, when, join } from '../../lib/html.ts';
import { redirect, notFound, type Router , jsonRes } from '../../lib/http.ts';
import { requirePerm, can, type Ctx } from '../../lib/auth.ts';
import { q, q1, val, j, js } from '../../lib/db.ts';
import { fmtDate } from '../../lib/dates.ts';
import { setSetting, getSettingMerged } from '../../lib/settings.ts';
import { audit } from '../../lib/audit.ts';
import {
  shell, card, tbl, dl, statusBadge, field, select, input, textarea, registerNav, kpis, tabs, emptyState,
} from '../../ui/ui.ts';
import { donut, bars } from '../../lib/charts.ts';
import { llm, llmStatus } from '../../lib/sim/llm.ts';
import { AGENTS, decideAction, autonomyFor, aiEnabled, type AgentKey, type Autonomy } from './framework.ts';
import { handleLeadInbound, draftCollectionsOutreach, draftRenewalOutreach, evaluateCounter, triageRequest, setAiHooksLive } from './agents.ts';
import { analyzeNewCalls, callRollup } from './analysis.ts';
import { askStayLeased , askSmart , askPanelContext , type AskAnswer } from './ask.ts';
import { currentThread, newThread, recall, remember } from './memory.ts';
import { getOp } from './ops.ts';
import { propose } from './framework.ts';
import type { PendingAction } from './act.ts';
import './ops_catalog.ts';   // one-shot operations: money, leasing, maintenance
import './ops_workflows.ts'; // standing behavior: report cadences, agent dials
import { generateListing, generateTemplateDraft, generateReviewResponse } from './content.ts';

/** M17 screens: AI Activity (approval queue + full audit + autonomy dials),
 * call analysis rollup, Ask StayLeased, and the Essentials content studio. */

registerNav('Intelligence', { href: '/ai', label: 'AI Activity', perm: 'ai:view', match: ['/ai'] });
registerNav('Intelligence', { href: '/ask', label: 'Ask StayLeased', perm: 'ai:view' });

function agentBadge(agent: string): ReturnType<typeof html> {
  const names: Record<string, string> = {
    leasing: 'Leasing AI', maintenance: 'Maintenance AI', payments: 'Payments AI',
    renewals: 'Renewals AI', call_analysis: 'Call Analysis', content: 'Essentials', ask: 'Ask StayLeased',
  };
  return html`<span class="badge violet">${names[agent] || agent}</span>`;
}

/** The lifecycle of one AI action, as a visual pipeline. Every action moves
 * Detected → Drafted → Review → Executed; the stepper shows exactly where
 * this one stands and how it got through review (a person, or the
 * autonomous dial — both logged). */
function flowStepper(a: any, mini = false): ReturnType<typeof html> {
  const auto = a.status === 'auto_executed';
  const steps: { label: string; note: string; cls: string }[] = [
    { label: 'Detected', note: '', cls: 'done' },
    { label: 'Drafted', note: '', cls: 'done' },
    a.status === 'proposed'
      ? { label: 'Review', note: 'awaiting approval', cls: 'now' }
      : a.status === 'rejected'
        ? { label: 'Review', note: a.decided_by ? `rejected · ${a.decided_by}` : 'rejected', cls: 'stop' }
        : auto
          ? { label: 'Review', note: 'autonomous dial', cls: 'done' }
          : { label: 'Review', note: a.decided_by ? `approved · ${a.decided_by}` : 'approved', cls: 'done' },
    a.status === 'executed' || auto
      ? { label: 'Executed', note: auto ? 'ran + logged' : 'logged', cls: 'done' }
      : a.status === 'approved'
        ? { label: 'Executed', note: a.autonomy === 'draft' ? 'human sends' : 'in flight', cls: 'now' }
        : { label: 'Executed', note: '', cls: a.status === 'rejected' ? 'off' : 'next' },
  ];
  return html`<div class="aiflow${mini ? ' mini' : ''}" aria-label="Action workflow">${steps.map((s, i) => html`${when(i > 0, () => html`<span class="afc ${steps[i]!.cls === 'next' || steps[i]!.cls === 'off' ? '' : 'on'}"></span>`)}<span class="afs ${s.cls}" title="${s.label}${s.note ? ` — ${s.note}` : ''}">
    <i>${s.cls === 'done' ? '✓' : s.cls === 'stop' ? '✕' : ''}</i>
    ${when(!mini, () => html`<span class="afs-l">${s.label}${when(s.note, () => html`<small>${s.note}</small>`)}</span>`)}
  </span>`)}</div>`;
}

export function routes(r: Router): void {
  setAiHooksLive(true); // agents watch live events once the server mounts

  // ---------- AI Activity: queue + audit + dials ----------
  r.get('/ai', requirePerm('ai:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const view = rq.query.get('view') || 'queue';
    const agentF = rq.query.get('agent') || '';
    const pending = q<any>(
      `SELECT a.*, p.name AS prop FROM ai_actions a LEFT JOIN properties p ON p.id=a.property_id
       WHERE a.org_id=? AND a.status='proposed'${agentF ? ' AND a.agent=?' : ''} ORDER BY a.created_at DESC`,
      ...(agentF ? [ctx.orgId, agentF] : [ctx.orgId]),
    );
    const history = q<any>(
      `SELECT a.*, p.name AS prop FROM ai_actions a LEFT JOIN properties p ON p.id=a.property_id
       WHERE a.org_id=? AND a.status != 'proposed'${agentF ? ' AND a.agent=?' : ''} ORDER BY a.created_at DESC LIMIT 100`,
      ...(agentF ? [ctx.orgId, agentF] : [ctx.orgId]),
    );
    const counts = q<any>(`SELECT status, COUNT(*) n FROM ai_actions WHERE org_id=? GROUP BY status`, ctx.orgId);
    const cnt = (s: string): number => counts.find((x) => x.status === s)?.n || 0;
    const props = q<any>('SELECT id, name FROM properties WHERE org_id=? ORDER BY name', ctx.orgId);
    const canApprove = can(ctx, 'ai:approve');
    const canConfigure = can(ctx, 'ai:configure');
    const st = llmStatus();
    const on = aiEnabled(ctx);
    const brainBadge = html`<span class="badge ${st.live ? 'ok' : ''}" title="${st.live ? 'Live LLM active' : 'Deterministic demo brain'}">${st.mode} brain${st.live ? ` · ${st.model}` : ''}</span>`;
    return shell(rq, {
      title: 'AI Activity',
      active: '/ai',
      subtitle: html`Every agent action with its input, output and approval trail. Drafts come from the deterministic engine, grounded in live records${st.live ? html` — Ask and document reading run on <b>${st.model}</b>` : ''}. Supervision is the product. ${brainBadge}`,
      actions: html`${when(canConfigure, () => html`<form method="post" action="/ai/kill-switch" data-confirm="${on ? 'Pause ALL AI agents org-wide? Nothing will send until re-enabled.' : 'Re-enable AI agents?'}"><button class="btn ${on ? 'btn-danger' : ''}">${on ? '⏻ Kill switch' : '▶ Resume AI'}</button></form>`)}<a class="btn btn-ghost" href="/ai/calls">Call analysis</a><a class="btn btn-ghost" href="/ai/essentials">Content studio</a>`,
      content: html`
        ${when(!on, () => html`<div class="callout bad">🛑 <b>AI is paused by the global kill switch.</b> Agents keep recording proposals for audit, but nothing sends and nothing runs autonomously until an admin resumes.</div>`)}
        <div class="aiflow-legend">
          <div class="afl-step"><i>1</i><div><b>Watch</b><span>Agents monitor leads, payments, work orders and renewals as they happen</span></div></div>
          <span class="afl-arrow">→</span>
          <div class="afl-step"><i>2</i><div><b>Draft</b><span>The agent proposes an action, with confidence scored and guardrails applied</span></div></div>
          <span class="afl-arrow">→</span>
          <div class="afl-step"><i>3</i><div><b>Review</b><span>You approve, edit, or reject — unless the dial says it may run on its own</span></div></div>
          <span class="afl-arrow">→</span>
          <div class="afl-step"><i>4</i><div><b>Execute &amp; log</b><span>Every action lands in the audit trail, human-approved or autonomous</span></div></div>
        </div>
        ${kpis([
          { label: 'Awaiting approval', value: String(pending.length), tone: pending.length ? 'warn' : 'ok' },
          { label: 'Executed on approval', value: String(cnt('executed')) },
          { label: 'Autonomous (audited)', value: String(cnt('auto_executed')), tone: 'accent' },
          { label: 'Rejected', value: String(cnt('rejected')) },
        ])}
        ${tabs([
          { href: '/ai', label: 'Approval queue', active: view === 'queue', count: pending.length },
          { href: '/ai?view=history', label: 'Audit history', active: view === 'history' },
          { href: '/ai?view=dials', label: 'Autonomy dials', active: view === 'dials' },
        ])}
        <form method="get" class="toolbar" data-autosubmit>
          <input type="hidden" name="view" value="${view}" />
          ${field('Agent', select('agent', AGENTS.map((a): [string, string] => [a.key, a.name]), agentF, { blank: 'All agents' }))}
        </form>
        ${view === 'dials'
          // canConfigure, not canApprove: changing a dial is gated on
          // ai:configure by the POST route, so passing the approval permission
          // here handed a property manager controls that fail on click.
          ? dialsView(ctx, props, canConfigure)
          : view === 'history' ? historyView(history) : queueView(pending, canApprove)}`,
    });
  });

  function queueView(pending: any[], canApprove: boolean): ReturnType<typeof html> {
    if (!pending.length) return emptyState('Nothing waiting on a human', 'Agent proposals appear here when their dial is draft or approve-to-send.');
    return join(pending.map((a) => {
      const output = j<any>(a.output, {});
      const input = j<any>(a.input, {});
      return card(
        html`${agentBadge(a.agent)} ${a.title} <span class="muted small">· ${a.prop || 'org'} · ${a.created_at.slice(0, 16).replace('T', ' ')}</span>`,
        html`${flowStepper(a)}
        <div class="split" style="display:flex;gap:20px;flex-wrap:wrap">
          <div style="flex:1;min-width:280px">
            ${when(output.draft, () => html`<div class="small muted" style="margin-bottom:4px">Draft (${a.autonomy === 'draft' ? 'draft-only dial: approve = reviewed, human sends' : 'sends on approval'}):</div>
              <div style="border:1px solid var(--line-2);border-radius:10px;padding:10px;background:var(--surface-2);max-height:220px;overflow:auto">${raw(String(output.draft))}</div>`)}
            ${when(output.tour, () => html`<p class="small">📅 Will also book: <b>${(output.tour as any).date} at ${(output.tour as any).startTime}</b></p>`)}
            ${when(output.installments, () => html`<p class="small">Plan: ${(output.installments as any[]).map((i) => `${fmtDate(i.dueDate)} — $${(i.amountCents / 100).toFixed(2)}`).join(' · ')}</p>`)}
            ${when(a.rationale, () => html`<p class="small" style="border-left:2px solid var(--accent);padding-left:8px;margin:8px 0"><b>Why:</b> ${a.rationale}</p>`)}
            ${when(a.guardrail_note, () => html`<p class="small" style="color:var(--warn)">🛡 ${a.guardrail_note}</p>`)}
            <p class="small muted">Confidence ${Math.round(a.confidence * 100)}% · dial at proposal: ${a.autonomy} · saw: ${Object.keys(input).slice(0, 5).join(', ')}</p>
          </div>
          ${when(canApprove, () => html`<div style="min-width:260px">
            <form method="post" action="/ai/${a.id}/approve">
              ${when(output.draft, () => field('Edit before sending (optional)', textarea('edited', { rows: 3, placeholder: 'leave empty to use the draft as-is' })))}
              <div style="display:flex;gap:8px;margin-top:6px">
                <button class="btn">${a.autonomy === 'draft' ? 'Mark reviewed' : 'Approve & execute'}</button>
                <button class="btn btn-ghost" formaction="/ai/${a.id}/reject">Reject</button>
              </div>
            </form>
          </div>`)}
        </div>`,
      );
    }));
  }

  function historyView(history: any[]): ReturnType<typeof html> {
    return tbl(
      [{ label: 'When' }, { label: 'Agent' }, { label: 'Action' }, { label: 'Property' }, { label: 'Workflow' }, { label: 'Status' }, { label: 'Decided by' }, { label: 'Result' }],
      history.map((a) => ({
        cells: [
          a.created_at.slice(5, 16).replace('T', ' '), agentBadge(a.agent),
          html`<span title="${a.title}${a.rationale ? ` — Why: ${a.rationale}` : ''}">${a.title.slice(0, 60)}${when(a.rationale, () => html`<span class="small muted" style="display:block">Why: ${String(a.rationale).slice(0, 90)}${String(a.rationale).length > 90 ? '…' : ''}</span>`)}</span>`,
          a.prop || '—', flowStepper(a, true), statusBadge(a.status, a.status.replaceAll('_', ' ')),
          a.decided_by || (a.status === 'auto_executed' ? 'autonomous' : '—'),
          html`<span class="small muted">${(a.result || '—').slice(0, 50)}</span>`,
        ],
      })),
      { empty: 'No settled actions yet.' },
    );
  }

  /** The three settings, as a scale rather than a paragraph.
   *
   * This is the page where an operator decides how much the AI may do without
   * them, and the three answers form an ordered scale of delegation — which a
   * run-on sentence and a native <select> both flatten into "pick one of
   * three". So the modes are laid out in order, each carrying the one sentence
   * that actually distinguishes it: who sends. */
  const LADDER: { key: Autonomy; name: string; who: string; body: string }[] = [
    {
      key: 'draft', name: 'Draft only', who: 'You send',
      body: 'The agent writes it and stops. Approving marks it reviewed; a person still does the sending.',
    },
    {
      key: 'approve', name: 'Approve to send', who: 'You click, it sends',
      body: 'The draft waits in the queue. One click executes exactly what you read — nothing is rewritten after you approve it.',
    },
    {
      key: 'auto', name: 'Autonomous', who: 'It sends, you review after',
      body: 'Runs immediately, fully audited. Anything low-confidence still stops and waits, and the guardrails below hold regardless.',
    },
  ];

  function dialsView(ctx: Ctx, props: any[], canConfigure: boolean): ReturnType<typeof html> {
    const dialAgents = AGENTS.filter((a) => a.dial);
    // What is actually delegated right now, counted across every agent and
    // property. An operator's real question on this screen is "how much have I
    // given away", and a grid of controls answers it only if you read all of it.
    const cells = dialAgents.flatMap((a) => [null, ...props.map((p) => p.id)].map((pid) => autonomyFor(ctx, a.key, pid)));
    const autos = cells.filter((c) => c === 'auto').length;

    return html`
      <section class="ladder" aria-label="What the three settings mean">
        ${LADDER.map((m, i) => html`
          <div class="rung rung-${m.key}">
            <div class="rung-step" aria-hidden="true">${i + 1}</div>
            <div class="rung-body">
              <div class="rung-head"><b>${m.name}</b><span class="rung-who">${m.who}</span></div>
              <p>${m.body}</p>
            </div>
          </div>`)}
      </section>

      ${card(
        'Who may act without you',
        html`
          <p class="small muted dial-lede">Set per agent, and per property where a building needs to differ from the rest. Changes take effect on the next action and are themselves audited.</p>
          <div class="tbl-wrap"><table class="tbl dialgrid">
            <thead><tr>
              <th scope="col">Agent</th>
              <th scope="col">Org default</th>
              ${props.map((p) => html`<th scope="col">${p.name}</th>`)}
            </tr></thead>
            <tbody>${dialAgents.map((a) => html`<tr>
              <th scope="row"><b>${a.name}</b><span class="small muted">${a.describe}</span></th>
              <td>${dialCell(ctx, a.key, null, canConfigure)}</td>
              ${props.map((p) => html`<td>${dialCell(ctx, a.key, p.id, canConfigure)}</td>`)}
            </tr>`)}</tbody>
          </table></div>
          ${when(!canConfigure, () => html`<p class="small muted dial-foot">You can see every dial here; changing one needs <code>ai:configure</code>.</p>`)}`,
        {
          flush: true,
          actions: html`<span class="dial-count ${autos ? 'on' : ''}">${autos
            ? `${autos} of ${cells.length} set to autonomous`
            : 'Nothing runs autonomously'}</span>`,
        },
      )}

      ${card('What no dial can switch off', html`<ul class="guardrails">
        <li><b>Payments AI never threatens.</b> A banned-phrase filter scrubs every draft, and each message carries the dispute path.</li>
        <li><b>Renewals AI never commits below your matrix.</b> An out-of-band counter escalates to the manager instead of being accepted.</li>
        <li><b>Maintenance AI can never downgrade an emergency.</b> Keyword escalation is unconditional, on every setting.</li>
        <li><b>Leasing AI hands off on request.</b> A prospect asking for a person gets one, even on autonomous.</li>
        <li><b>Ask StayLeased shows you the change before it makes it.</b> It reads and acts within your own permissions, and every operation previews the exact figures and waits for your confirmation.</li>
      </ul>`)}`;
  }

  const DIAL_LABEL: Record<Autonomy, string> = { draft: 'Draft', approve: 'Approve', auto: 'Auto' };

  /** One dial.
   *
   * A segmented control rather than a <select>, because the three values are a
   * scale and not an arbitrary list: the position IS the information, and it
   * makes the grid scannable — you can see at a glance which buildings have
   * been handed autonomy instead of reading every dropdown. Radios in a form
   * that auto-submits, so it keeps working with no JavaScript. */
  function dialCell(ctx: Ctx, agent: AgentKey, propertyId: string | null, canConfigure: boolean): ReturnType<typeof html> {
    const current = autonomyFor(ctx, agent, propertyId);
    const name = `dial-${agent}-${propertyId || 'org'}`;
    if (!canConfigure) {
      return html`<span class="dial dial-ro lv-${current}">${DIAL_LABEL[current]}</span>`;
    }
    return html`<form method="post" action="/ai/dials" data-autosubmit class="dial-form">
      <input type="hidden" name="agent" value="${agent}" />
      <input type="hidden" name="property" value="${propertyId || ''}" />
      <div class="dial lv-${current}" role="group" aria-label="${agent} autonomy">
        ${(['draft', 'approve', 'auto'] as Autonomy[]).map((lv) => html`
          <label class="dial-opt ${lv === current ? 'on' : ''}">
            <input type="radio" name="level" value="${lv}" ${lv === current ? 'checked' : ''} />
            <span>${DIAL_LABEL[lv]}</span>
          </label>`)}
      </div>
    </form>`;
  }

  r.post('/ai/dials', requirePerm('ai:configure'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const agent = String(rq.body.agent) as AgentKey;
    const propertyId = String(rq.body.property || '') || undefined;
    const level = String(rq.body.level) as Autonomy;
    if (!AGENTS.some((a) => a.key === agent && a.dial) || !['draft', 'approve', 'auto'].includes(level)) {
      return redirect('/ai?view=dials', 'Bad dial', 'err');
    }
    // merged, so a property that already overrides one dial keeps tracking the
    // organization on the rest; the narrowing below keeps it that way on save
    const conf = { ...getSettingMerged<Record<string, Autonomy>>(ctx, 'ai_autonomy', propertyId) };
    conf[agent] = level;
    setSetting(ctx, 'ai_autonomy', conf, propertyId);
    audit(ctx, 'settings', `ai_autonomy${propertyId ? ':' + propertyId : ''}`, 'ai_dial_change', null, { agent, level });
    return redirect('/ai?view=dials', `${agent} → ${level}${propertyId ? ' (property override)' : ' (org default)'}`);
  });

  r.post('/ai/kill-switch', requirePerm('ai:configure'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const now = aiEnabled(ctx);
    setSetting(ctx, 'ai_enabled', !now);
    audit(ctx, 'settings', 'ai_enabled', now ? 'ai_kill_switch_engaged' : 'ai_resumed', { value: now }, { value: !now });
    return redirect('/ai', now ? '🛑 AI paused org-wide. Proposals still record for audit; nothing sends.' : '▶ AI resumed.');
  });

  r.post('/ai/:id/approve', requirePerm('ai:approve'), (rq) => {
    const ctx = rq.ctx as Ctx;
    try {
      decideAction(ctx, rq.params.id!, 'approve', { editedDraft: rq.body.edited ? String(rq.body.edited) : undefined });
      const a = q1<any>('SELECT * FROM ai_actions WHERE id=?', rq.params.id);
      return redirect('/ai', a.autonomy === 'draft' ? 'Marked reviewed — the draft is yours to send.' : `Approved and executed: ${a.result || 'done'}`);
    } catch (e) {
      return redirect('/ai', (e as Error).message, 'err');
    }
  });

  r.post('/ai/:id/reject', requirePerm('ai:approve'), (rq) => {
    const ctx = rq.ctx as Ctx;
    try {
      decideAction(ctx, rq.params.id!, 'reject', { reason: String(rq.body.reason || 'rejected by staff') });
      return redirect('/ai', 'Rejected — nothing was sent.');
    } catch (e) {
      return redirect('/ai', (e as Error).message, 'err');
    }
  });

  // ---------- agent trigger endpoints (buttons in other modules) ----------
  r.post('/ai/leads/:id/draft', requirePerm('leasing:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const lead = q1<any>('SELECT * FROM leads WHERE id=? AND org_id=?', rq.params.id, ctx.orgId);
    if (!lead) return notFound('Lead not found');
    const lastIn = q1<any>(
      `SELECT body FROM outbox_messages WHERE org_id=? AND person_id=? AND direction='in' ORDER BY created_at DESC LIMIT 1`,
      ctx.orgId, lead.id,
    );
    const message = lastIn?.body || lead.message || `Hi — I'm interested in a ${lead.beds ?? ''} bedroom. What's available and how much? Could I tour?`;
    const res = handleLeadInbound(ctx, lead.id, message);
    return redirect('/ai', res?.status === 'auto_executed' ? 'Leasing AI replied autonomously (see history).' : 'Leasing AI drafted a reply — review it here.');
  });

  r.post('/ai/delinquency/:leaseId/draft', requirePerm('collections:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const res = draftCollectionsOutreach(ctx, rq.params.leaseId!);
    if (!res) return redirect(`/delinquency/${rq.params.leaseId}`, 'Nothing to draft — balance is not positive.', 'err');
    return redirect('/ai', 'Payments AI drafted outreach (and a plan proposal when in bounds).');
  });

  r.post('/ai/renewals/:leaseId/draft', requirePerm('renewals:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const res = draftRenewalOutreach(ctx, rq.params.leaseId!);
    return redirect('/ai', res ? 'Renewals AI drafted personalized outreach.' : 'Could not draft for that lease.');
  });

  r.post('/ai/renewals/:leaseId/counter', requirePerm('renewals:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const cents = Math.round(Number(rq.body.amount || 0) * 100);
    const term = parseInt(String(rq.body.term || '12'), 10);
    if (!cents) return redirect('/ai', 'Counter amount required', 'err');
    evaluateCounter(ctx, rq.params.leaseId!, cents, term);
    return redirect('/ai', 'Counter evaluated against the matrix band.');
  });

  r.post('/ai/workorders/:id/triage', requirePerm('workorders:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const res = triageRequest(ctx, rq.params.id!);
    return redirect('/ai', res ? 'Maintenance AI triaged the request.' : 'Work order not found.', res ? undefined : 'err');
  });

  // ---------- call analysis ----------
  r.get('/ai/calls', requirePerm('ai:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const roll = callRollup(ctx, ctx.currentPropertyId);
    const recent = q<any>(
      `SELECT c.*, l.first_name || ' ' || l.last_name AS lead_name FROM call_logs c
       LEFT JOIN leads l ON l.id=c.lead_id
       WHERE c.org_id=? AND c.ai_summary IS NOT NULL ORDER BY c.at DESC LIMIT 25`,
      ctx.orgId,
    );
    const tasks = val<number>(`SELECT COUNT(*) FROM followup_tasks WHERE org_id=? AND kind LIKE 'ai:%' AND status='open'`, ctx.orgId) || 0;
    return shell(rq, {
      title: 'ELI Call Analysis',
      active: '/ai',
      crumbs: [['AI Activity', '/ai']],
      subtitle: 'Every transcript summarized — sentiment, intents, action items as real follow-up tasks, coaching notes.',
      actions: html`<form method="post" action="/ai/calls/run"><button class="btn">Analyze new calls</button></form>`,
      content: html`
        ${kpis([
          { label: 'Calls analyzed', value: `${roll.analyzed}/${roll.total}` },
          { label: 'Positive / negative', value: `${roll.sentiment.positive || 0} / ${roll.sentiment.negative || 0}`, tone: (roll.sentiment.negative || 0) > (roll.sentiment.positive || 0) ? 'warn' : 'ok' },
          { label: 'Missed opportunities', value: String(roll.missed), tone: roll.missed ? 'warn' : 'ok' },
          { label: 'Open AI follow-up tasks', value: String(tasks), href: '/leads' },
        ])}
        <div class="grid cols-2">
          ${card('Sentiment mix', donut([
            { label: 'Positive', value: roll.sentiment.positive || 0, tone: 'ok' },
            { label: 'Neutral', value: roll.sentiment.neutral || 0, tone: 'info' },
            { label: 'Negative', value: roll.sentiment.negative || 0, tone: 'bad' },
          ], { centerValue: String(roll.analyzed), centerLabel: 'calls' }))}
          ${card('What people call about', bars(roll.topTags.map(([t, n]) => ({ label: t, value: n }))))}
        </div>
        ${card('Recent analyses', tbl(
          [{ label: 'When' }, { label: 'Who' }, { label: 'Sentiment' }, { label: 'Tags' }, { label: 'AI summary' }],
          recent.map((c) => ({
            cells: [
              (c.business_date || c.at).slice(0, 10), c.lead_name || 'resident/other',
              statusBadge(c.ai_sentiment === 'positive' ? 'ok' : c.ai_sentiment === 'negative' ? 'overdue' : 'normal', c.ai_sentiment),
              (JSON.parse(c.ai_tags || '[]') as string[]).join(', ') || '—',
              html`<span class="small">${(c.ai_summary || '').slice(0, 90)}…</span>`,
            ],
          })),
        ))}`,
    });
  });

  r.post('/ai/calls/run', requirePerm('ai:view'), (rq) => {
    const n = analyzeNewCalls(rq.ctx as Ctx);
    return redirect('/ai/calls', n ? `${n} calls analyzed.` : 'Nothing new to analyze.');
  });

  // ---------- Ask StayLeased ----------
  // shared renderer: a structured answer as chat-bubble content
  const answerBody = (answer: AskAnswer): ReturnType<typeof html> => html`
    ${when(answer.table, () => html`<div class="aichat-table">${tbl(
      answer.table!.cols.map((c) => ({ label: c })),
      answer.table!.rows.map((row, i) => ({
        href: answer.table!.hrefs?.[i] || undefined,
        cells: row.map((cell) => html`${cell}`),
      })),
    )}</div>`)}
    ${when(answer.links.length, () => html`<div class="aichat-links">${answer.links.map((l) => html`<a class="btn btn-sm btn-ghost" href="${l.href}">${l.label}</a>`)}</div>`)}`;

  /** What Ask is about to do, and the button that does it.
   *
   * The preview is the whole basis on which a person says yes, so it leads
   * with the specific figures rather than a restatement of the request. A
   * blocker means the card offers no button at all — an action that cannot run
   * must not present one and fail on click. */
  const actionCard = (a: PendingAction, threadId: string): ReturnType<typeof html> => html`
    <div class="ask-act ask-act-${a.risk}">
      <div class="aa-head">
        <b>${a.opName}</b>
        ${when(a.risk === 'money', () => html`<span class="pill warn">moves money</span>`)}
        ${when(a.risk === 'admin', () => html`<span class="pill warn">changes access</span>`)}
      </div>
      <p class="aa-sum">${a.preview.summary}</p>
      ${when(a.resolved.length, () => html`<dl class="aa-res">${a.resolved.map((r) => html`<dt>${r.label}</dt><dd>${r.value}</dd>`)}</dl>`)}
      ${when(a.preview.changes.length, () => html`<dl class="aa-changes">${a.preview.changes.map((c) => html`<dt>${c.label}</dt><dd>${c.value}</dd>`)}</dl>`)}
      ${a.preview.warnings.map((w) => html`<p class="aa-warn">${w}</p>`)}
      ${a.preview.blockers.length
        ? html`${a.preview.blockers.map((b) => html`<p class="aa-block">${b}</p>`)}
               <p class="aa-foot">Nothing was changed.</p>`
        : html`<form method="post" action="/ask/act" class="aa-form" data-ask-act>
            <input type="hidden" name="op" value="${a.opKey}" />
            <input type="hidden" name="args" value="${JSON.stringify(a.args)}" />
            <input type="hidden" name="thread" value="${threadId}" />
            <button class="btn btn-primary" type="submit">${a.opName}</button>
            <span class="aa-foot">Nothing has changed yet. Confirming records this in AI Activity with your name on it.</span>
          </form>`}
    </div>`;

  /** Confirm: propose it, approve it, execute it — through the same audited
   * path an agent's action takes. Ask gets no shortcut around the queue; it
   * just fills it in one step because a person is standing right there. */
  r.post('/ask/act', requirePerm('ai:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const keepThread = String(rq.body.thread || '').slice(0, 40);
    const back = keepThread ? `/ask?thread=${keepThread}` : '/ask';
    const op = getOp(String(rq.body.op || ''));
    if (!op) return redirect(back, 'That action is no longer available.', 'err');
    if (!can(ctx, op.perm)) return redirect(back, `${op.name} is outside your role’s access.`, 'err');
    let args: Record<string, string | number | boolean | null> = {};
    try {
      const parsed = JSON.parse(String(rq.body.args || '{}'));
      if (parsed && typeof parsed === 'object') args = parsed;
    } catch { return redirect(back, 'That action could not be read back.', 'err'); }

    // Re-previewed at the moment of confirming, never trusted from the form:
    // the world can move between the plan and the click (the fee gets waived,
    // the lease ends), and the blockers are what stop a stale action landing.
    const pre = op.preview(ctx, args);
    if (pre.blockers.length) return redirect(back, pre.blockers.join(' '), 'err');

    // Where the answer goes. The old route always redirected to /ask, which
    // reloaded the page with an empty thread — you confirmed an action and the
    // conversation that led to it vanished, replaced by a flash message. It is
    // now a turn IN the thread, and the fetch caller never leaves the page.
    const thread = String(rq.body.thread || '').slice(0, 40) || currentThread(ctx);
    // The chat surfaces confirm with fetch and say so; a plain form POST (no
    // JavaScript) still gets a redirect, and now back into its own thread.
    const wantsJson = String(rq.body.json || '') === '1';
    const outcome = (text: string, ok: boolean): ReturnType<typeof jsonRes> | ReturnType<typeof redirect> => {
      remember(ctx, thread, 'agent', text, ok ? `did.${op.key}` : 'action.failed');
      return wantsJson
        ? jsonRes({ ok, summary: text, threadId: thread })
        : redirect(`/ask?thread=${thread}`, text, ok ? undefined : 'err');
    };

    try {
      // The click IS the decision, so proposing executes: `ask` carries no
      // autonomy dial, and framework.propose runs an auto action immediately.
      // Deliberately no decideAction afterwards — the row is already settled,
      // and calling it would throw "already decided" AFTER the money moved,
      // reporting a completed action as a failure.
      const { id: actionId, status } = propose(ctx, {
        agent: 'ask', title: op.name,
        input: { op: op.key, args },
        output: { kind: `op.${op.key}`, args },
        confidence: 0.99,
        rationale: `Confirmed in Ask StayLeased by ${ctx.userName}: ${pre.summary}`,
      });
      if (status !== 'auto_executed') {
        // the global kill switch forces every proposal to draft — Ask is no
        // exception, and the honest answer is that it is waiting, not done
        return outcome('AI is paused by the kill switch — this is held in the approval queue until it is switched back on.', false);
      }
      const done = q1<{ result: string }>('SELECT result FROM ai_actions WHERE id=? AND org_id=?', actionId, ctx.orgId);
      return outcome(done?.result || `${op.name} done.`, true);
    } catch (e) {
      return outcome(`Could not complete that: ${(e as Error).message}`, false);
    }
  });

  r.get('/ask', requirePerm('ai:view'), async (rq) => {
    const ctx = rq.ctx as Ctx;
    const question = (rq.query.get('q') || '').slice(0, 200);
    // The conversation this page is showing: the one named in the URL (a
    // confirm redirect, a "new conversation"), otherwise whichever one this
    // user is already in — which is how the dock's thread is on screen when
    // they click "Full page" instead of the page starting empty.
    const thread = (rq.query.get('thread') || '').slice(0, 40) || currentThread(ctx);
    const prior = recall(ctx, thread, 20);
    // askSmart, not askStayLeased: the page and the panel must answer the same
    // sentence the same way, and only askSmart can read one as an instruction
    const answer = question ? await askSmart(ctx, question, thread) : null;
    const st = llmStatus();
    const pc = askPanelContext(ctx, '/ask');
    return shell(rq, {
      title: 'Ask StayLeased',
      active: '/ask',
      content: html`
        <div class="aichat">
          <div class="aichat-hero">
            <div class="aichat-orb" aria-hidden="true">${raw('<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.9 2.6 2.6.9-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9z"/></svg>')}</div>
            <div class="aichat-hero-text">
              <h2>Ask StayLeased</h2>
              <p>Plain-English questions about your portfolio, answered from your live operating records. Every answer is recorded in the audit log.</p>
            </div>
            ${when(pc.scope, () => html`<span class="badge info">Scoped to ${pc.scope}</span>`)}
            <span class="aichat-brain ${st.live ? 'live' : ''}"><i></i>${st.live ? `Live · ${st.model}` : 'Built-in engine'}</span>
            ${when(prior.length, () => html`
              <form method="post" action="/ask/new" class="aichat-new">
                <button class="btn btn-sm btn-ghost" type="submit">New conversation</button>
              </form>`)}
          </div>

          <div class="aichat-panel">
            <div class="aichat-thread" id="aichat-thread" aria-live="polite" data-thread="${thread}">
              ${when(!prior.length, () => html`<div class="aichat-msg agent"><div class="aichat-bubble">${pc.greeting}</div></div>`)}
              ${prior.map((t) => html`
                <div class="aichat-msg ${t.role}"><div class="aichat-bubble">${t.text}</div></div>`)}
              ${when(answer, () => html`
                <div class="aichat-msg you"><div class="aichat-bubble">${question}</div></div>
                <div class="aichat-msg agent"><div class="aichat-bubble">
                  <div class="aichat-title">${answer!.title} <span class="badge violet">${answer!.matched}</span></div>
                  <div class="aichat-summary">${answer!.summary}</div>
                  ${answer!.action ? actionCard(answer!.action, thread) : answerBody(answer!)}
                </div></div>`)}
            </div>
            <div class="aichat-chips" id="aichat-chips">
              ${pc.chips.map((c) => html`<button type="button" class="aichat-chip">${c}</button>`)}
            </div>
            ${when(pc.actions.length, () => html`
              <div class="aichat-does" id="aichat-does">
                <span class="aichat-does-lead">I can also do things —</span>
                ${pc.actions.map((a) => html`<button type="button" class="aichat-chip act" data-fill="${a}">${a.trim()}…</button>`)}
              </div>`)}
            <form class="aichat-form" id="aichat-form" autocomplete="off">
              <input id="aichat-input" name="q" placeholder="Ask a question, or tell me to do something…" maxlength="300" aria-label="Ask StayLeased" autofocus />
              <button class="aichat-send" type="submit" aria-label="Send">${raw('<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>')}</button>
            </form>
          </div>
        </div>
        ${raw(`<script>${ASK_CHAT_JS}</script>`)}
      `,
    });
  });

  // context for the everywhere-panel: greeting grounded in live figures for
  // the user's current property + suggested questions for the app area
  r.get('/ask/panel.json', requirePerm('ai:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const path = String(rq.query.get('path') || '/').slice(0, 120);
    const st = llmStatus();
    return jsonRes({ ...askPanelContext(ctx, path), live: st.live, model: st.live ? st.model : null });
  });

  // fetch endpoint behind the same permission — structured or conversational
  //
  // The conversation is NOT posted up from the browser any more. It lives in
  // ask_turns keyed to this user, which is what lets the same thread be in
  // front of them in the dock, on the full page, after a reload, and after
  // confirming an action — four places the old client-side array was emptied.
  r.post('/ask.json', requirePerm('ai:view'), async (rq) => {
    const ctx = rq.ctx as Ctx;
    const question = String(rq.body.q || '').trim().slice(0, 300);
    const thread = String(rq.body.thread || '').slice(0, 40) || currentThread(ctx);
    if (question.length < 1) {
      return jsonRes({ summary: 'Ask me anything about your portfolio.', links: [], matched: 'noop', live: false, threadId: thread });
    }
    const a = await askSmart(ctx, question, thread);
    return jsonRes({
      title: a.conversational ? null : a.title,
      summary: a.summary,
      matched: a.matched,
      live: a.live,
      threadId: a.threadId,
      extraHtml: a.action ? actionCard(a.action, a.threadId).s
        : a.table || a.links.length ? answerBody(a).s : null,
    });
  });

  // The whole conversation, so any surface can pick it up mid-thread.
  r.get('/ask/thread.json', requirePerm('ai:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const thread = String(rq.query.get('thread') || '') || currentThread(ctx);
    return jsonRes({
      threadId: thread,
      turns: recall(ctx, thread, 20).map((t) => ({ role: t.role, text: t.text, matched: t.matched })),
    });
  });

  // Forgetting is an explicit act now that closing a panel is not one.
  r.post('/ask/new', requirePerm('ai:view'), (rq) => {
    const tid = newThread();
    if (String(rq.body.json || '') === '1') return jsonRes({ threadId: tid });
    return redirect(`/ask?thread=${tid}`);
  });

  // ---------- Essentials content studio ----------
  r.get('/ai/essentials', requirePerm('ai:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const props = q<any>('SELECT id, name FROM properties WHERE org_id=? ORDER BY name', ctx.orgId);
    const fps = q<any>('SELECT f.id, f.name, p.name AS prop FROM floorplans f JOIN properties p ON p.id=f.property_id WHERE f.org_id=? ORDER BY p.name, f.name', ctx.orgId);
    const generated = rq.query.get('generated') || '';
    const genSubject = rq.query.get('subject') || '';
    return shell(rq, {
      title: 'Essentials — content studio',
      active: '/ai',
      crumbs: [['AI Activity', '/ai']],
      subtitle: 'Grounded generation: listing copy from live pricing, template drafts, review responses. The same buttons live inside the CMS and template editors.',
      content: html`
        ${when(generated, () => card('Generated ✨ (copy into the editor, or regenerate)', html`
          ${when(genSubject, () => html`<p><b>Subject:</b> ${genSubject}</p>`)}
          <div style="border:1px solid var(--line-2);border-radius:10px;padding:12px;background:var(--surface-2)">${generated}</div>`))}
        <div class="grid cols-2">
          ${card('Listing description', html`<form method="post" action="/ai/essentials/listing">
            ${field('Floorplan', select('floorplan', fps.map((f): [string, string] => [f.id, `${f.prop} — ${f.name}`])))}
            <button class="btn btn-sm">Generate from live data</button>
          </form>`)}
          ${card('Message template', html`<form method="post" action="/ai/essentials/template">
            ${field('What is it for?', input('purpose', { placeholder: 'e.g. pool closure notice, parking reminder, welcome email', required: true }))}
            <button class="btn btn-sm">Draft it</button>
          </form>`)}
          ${card('Review response', html`<form method="post" action="/ai/essentials/review">
            ${field('Stars', select('stars', [['5', '5★'], ['4', '4★'], ['3', '3★'], ['2', '2★'], ['1', '1★']], '2'))}
            ${field('Reviewer name', input('reviewer', { value: 'Jordan M.' }))}
            ${field('The review', textarea('review', { rows: 3, placeholder: 'Maintenance took two weeks to fix my sink…', required: true }))}
            <button class="btn btn-sm">Draft response</button>
          </form>`)}
          ${card('Where these buttons live', html`<ul>
            <li>Marketing → Site editor: <b>Generate description</b> per property</li>
            <li>Communications → Templates: <b>Draft with AI</b></li>
            <li>Every generation is logged to AI Activity like any other agent action.</li>
          </ul>`)}
        </div>`,
    });
  });

  r.post('/ai/essentials/listing', requirePerm('ai:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const fp = q1<any>('SELECT * FROM floorplans WHERE id=?', String(rq.body.floorplan));
    if (!fp) return notFound('Floorplan not found');
    const text = generateListing(ctx, fp.property_id, fp.id);
    return redirect(`/ai/essentials?generated=${encodeURIComponent(text)}`);
  });
  r.post('/ai/essentials/template', requirePerm('ai:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const t = generateTemplateDraft(ctx, String(rq.body.purpose || 'community notice'));
    return redirect(`/ai/essentials?generated=${encodeURIComponent(t.body)}&subject=${encodeURIComponent(t.subject)}`);
  });
  r.post('/ai/essentials/review', requirePerm('ai:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const text = generateReviewResponse(ctx, String(rq.body.review || ''), Number(rq.body.stars || 3), String(rq.body.reviewer || 'a resident'));
    return redirect(`/ai/essentials?generated=${encodeURIComponent(`<p>${text}</p>`)}`);
  });
}

// client for the Ask chat page: fetch + typewriter (no framework)
//
// It no longer keeps the conversation. The thread is server-side and this
// only carries its id, which is what makes a reload, a click on "Full page"
// and a confirmed action all land back in the same conversation instead of
// three empty ones.
const ASK_CHAT_JS = `
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var thread = document.getElementById('aichat-thread');
  var form = document.getElementById('aichat-form');
  var input = document.getElementById('aichat-input');
  var chips = document.getElementById('aichat-chips');
  var does = document.getElementById('aichat-does');
  if (!thread || !form || !input) return;
  var tid = thread.getAttribute('data-thread') || '';
  var busy = false;
  var panel = thread.closest('.aichat-panel');
  function setBusy(on) {
    busy = on;
    if (panel) panel.classList.toggle('busy', on);
    var send = form.querySelector('.aichat-send');
    if (send) send.disabled = on;
  }
  function scrollDown() { thread.scrollTop = thread.scrollHeight; }
  function bubble(role) {
    var m = document.createElement('div'); m.className = 'aichat-msg ' + role;
    var b = document.createElement('div'); b.className = 'aichat-bubble';
    m.appendChild(b); thread.appendChild(m); scrollDown();
    return b;
  }
  function typeText(el, text, done) {
    if (reduce) { el.textContent = text; scrollDown(); if (done) done(); return; }
    var i = 0, per = text.length > 240 ? 3 : text.length > 120 ? 2 : 1;
    (function tick() {
      i = Math.min(text.length, i + per);
      el.textContent = text.slice(0, i);
      scrollDown();
      if (i < text.length) setTimeout(tick, 16); else if (done) done();
    })();
  }
  function ask(q) {
    if (busy || !q) return;
    setBusy(true);
    bubble('you').textContent = q;
    var b = bubble('agent');
    b.innerHTML = '<span class="aichat-typing"><i></i><i></i><i></i></span>';
    fetch('/ask.json', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'origin': location.origin },
      body: 'q=' + encodeURIComponent(q) + '&thread=' + encodeURIComponent(tid),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.threadId) { tid = d.threadId; thread.setAttribute('data-thread', tid); }
      b.innerHTML = '';
      if (d.title) {
        var t = document.createElement('div'); t.className = 'aichat-title'; t.textContent = d.title;
        b.appendChild(t);
      }
      var sum = document.createElement('div'); sum.className = 'aichat-summary'; b.appendChild(sum);
      typeText(sum, d.summary || 'Hmm — nothing came back. Try again?', function () {
        if (d.extraHtml) {
          var ex = document.createElement('div'); ex.className = 'aichat-extra'; ex.innerHTML = d.extraHtml;
          b.appendChild(ex);
          requestAnimationFrame(function () { ex.classList.add('vis'); scrollDown(); });
        }
        setBusy(false);
        input.focus();
      });
    }).catch(function () {
      b.textContent = 'I could not reach the assistant just now — try again in a moment.';
      setBusy(false);
    });
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    // check busy BEFORE clearing the box: ask() already refuses while a reply is
    // in flight, so without this a question typed mid-answer is wiped and never
    // sent. The disabled send button is an affordance, not the guard.
    if (busy) return;
    var q = input.value.trim(); if (!q) return;
    input.value = '';
    ask(q);
  });
  if (chips) chips.addEventListener('click', function (e) {
    var c = e.target.closest('.aichat-chip'); if (!c) return;
    ask(c.textContent.trim());
  });
  // An action example fills the box and waits. It is half a sentence — the
  // household or the unit is the operator's to name — so sending it would only
  // ever produce a refusal.
  if (does) does.addEventListener('click', function (e) {
    var c = e.target.closest('[data-fill]'); if (!c) return;
    input.value = c.getAttribute('data-fill') || '';
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
  // Confirming an action used to navigate: the page reloaded and the
  // conversation that led to the action was gone, replaced by a flash message.
  // It now answers in the thread it came from.
  thread.addEventListener('submit', function (e) {
    var f = e.target.closest('form[data-ask-act]'); if (!f) return;
    e.preventDefault();
    var btn = f.querySelector('button');
    if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
    var body = new URLSearchParams(new FormData(f));
    body.set('json', '1');
    fetch('/ask/act', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'origin': location.origin },
      body: body.toString(),
    }).then(function (r) { return r.json(); }).then(function (d) {
      var card = f.closest('.ask-act');
      if (card) card.classList.add(d.ok ? 'done' : 'failed');
      f.remove();
      var b = bubble('agent');
      b.className += ' result';
      typeText(b, d.summary || (d.ok ? 'Done.' : 'That did not go through.'));
    }).catch(function () {
      if (btn) { btn.disabled = false; btn.textContent = 'Try again'; }
    });
  });
})();
`;
