import { html, raw, when, join } from '../../lib/html.ts';
import { redirect, notFound, type Router } from '../../lib/http.ts';
import { requirePerm, can, type Ctx } from '../../lib/auth.ts';
import { q, q1, val, j, js } from '../../lib/db.ts';
import { fmtDate } from '../../lib/dates.ts';
import { setSetting, getSetting } from '../../lib/settings.ts';
import { audit } from '../../lib/audit.ts';
import {
  shell, card, tbl, dl, statusBadge, field, select, input, textarea, registerNav, kpis, tabs, emptyState,
} from '../../ui/ui.ts';
import { donut, bars } from '../../lib/charts.ts';
import { llm } from '../../lib/sim/llm.ts';
import { AGENTS, decideAction, autonomyFor, type AgentKey, type Autonomy } from './framework.ts';
import { handleLeadInbound, draftCollectionsOutreach, draftRenewalOutreach, evaluateCounter, triageRequest, setAiHooksLive } from './agents.ts';
import { analyzeNewCalls, callRollup } from './analysis.ts';
import { askOriel } from './ask.ts';
import { generateListing, generateTemplateDraft, generateReviewResponse } from './content.ts';

/** M17 screens: AI Activity (approval queue + full audit + autonomy dials),
 * call analysis rollup, Ask Oriel, and the Essentials content studio. */

registerNav('Intelligence', { href: '/ai', label: 'AI Activity', perm: 'ai:view', match: ['/ai'] });
registerNav('Intelligence', { href: '/ask', label: 'Ask Oriel', perm: 'ai:view' });

function agentBadge(agent: string): ReturnType<typeof html> {
  const names: Record<string, string> = {
    leasing: 'Leasing AI', maintenance: 'Maintenance AI', payments: 'Payments AI',
    renewals: 'Renewals AI', call_analysis: 'Call Analysis', content: 'Essentials', ask: 'Ask Oriel',
  };
  return html`<span class="badge violet">${names[agent] || agent}</span>`;
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
    return shell(rq, {
      title: 'AI Activity',
      active: '/ai',
      subtitle: html`Every agent action with its input, output and approval trail — powered by <b>${llm().name}</b>. Supervision is the product.`,
      actions: html`<a class="btn btn-ghost" href="/ai/calls">Call analysis</a><a class="btn btn-ghost" href="/ai/essentials">Content studio</a>`,
      content: html`
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
        ${view === 'dials' ? dialsView(ctx, props, canApprove) : view === 'history' ? historyView(history) : queueView(pending, canApprove)}`,
    });
  });

  function queueView(pending: any[], canApprove: boolean): ReturnType<typeof html> {
    if (!pending.length) return emptyState('Nothing waiting on a human', 'Agent proposals appear here when their dial is draft or approve-to-send.');
    return join(pending.map((a) => {
      const output = j<any>(a.output, {});
      const input = j<any>(a.input, {});
      return card(
        html`${agentBadge(a.agent)} ${a.title} <span class="muted small">· ${a.prop || 'org'} · ${a.created_at.slice(0, 16).replace('T', ' ')}</span>`,
        html`<div class="split" style="display:flex;gap:20px;flex-wrap:wrap">
          <div style="flex:1;min-width:280px">
            ${when(output.draft, () => html`<div class="small muted" style="margin-bottom:4px">Draft (${a.autonomy === 'draft' ? 'draft-only dial: approve = reviewed, human sends' : 'sends on approval'}):</div>
              <div style="border:1px solid var(--line-2);border-radius:10px;padding:10px;background:var(--surface-2);max-height:220px;overflow:auto">${raw(String(output.draft))}</div>`)}
            ${when(output.tour, () => html`<p class="small">📅 Will also book: <b>${(output.tour as any).date} at ${(output.tour as any).startTime}</b></p>`)}
            ${when(output.installments, () => html`<p class="small">Plan: ${(output.installments as any[]).map((i) => `${fmtDate(i.dueDate)} — $${(i.amountCents / 100).toFixed(2)}`).join(' · ')}</p>`)}
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
      [{ label: 'When' }, { label: 'Agent' }, { label: 'Action' }, { label: 'Property' }, { label: 'Dial' }, { label: 'Status' }, { label: 'Decided by' }, { label: 'Result' }],
      history.map((a) => ({
        cells: [
          a.created_at.slice(5, 16).replace('T', ' '), agentBadge(a.agent),
          html`<span title="${a.title}">${a.title.slice(0, 60)}</span>`,
          a.prop || '—', a.autonomy, statusBadge(a.status, a.status.replaceAll('_', ' ')),
          a.decided_by || (a.status === 'auto_executed' ? 'autonomous' : '—'),
          html`<span class="small muted">${(a.result || '—').slice(0, 50)}</span>`,
        ],
      })),
      { empty: 'No settled actions yet.' },
    );
  }

  function dialsView(ctx: Ctx, props: any[], canConfigure: boolean): ReturnType<typeof html> {
    const dialAgents = AGENTS.filter((a) => a.dial);
    return html`
      ${card('How the dials work', html`<p><b>Draft-only</b> — the agent suggests; approving marks it reviewed and a human sends manually. <b>Approve-to-send</b> — one click executes exactly what you approved. <b>Autonomous</b> — executes immediately with a full audit trail; low-confidence items (like "I want to talk to a human") still hold for staff.</p>`)}
      ${card('Org defaults + per-property overrides', html`
        <table class="tbl"><thead><tr><th>Agent</th><th>Org default</th>${props.map((p) => html`<th>${p.name}</th>`)}</tr></thead>
        <tbody>${dialAgents.map((a) => html`<tr>
          <td><b>${a.name}</b><br /><span class="small muted">${a.describe}</span></td>
          <td>${dialCell(ctx, a.key, null, canConfigure)}</td>
          ${props.map((p) => html`<td>${dialCell(ctx, a.key, p.id, canConfigure)}</td>`)}
        </tr>`)}</tbody></table>
        ${when(!canConfigure, () => html`<p class="small muted">You can view the dials; changing them needs ai:configure.</p>`)}`)}
      ${card('Hard guardrails (not configurable)', html`<ul>
        <li>Payments AI never threatens — a banned-phrase filter scrubs drafts and every message embeds the dispute path.</li>
        <li>Renewals AI never commits below the approved matrix band — out-of-band counters always escalate to the PM.</li>
        <li>Maintenance AI can never <i>downgrade</i> an emergency — keyword escalation is unconditional.</li>
        <li>Leasing AI hands off whenever a prospect asks for a human, even on autonomous.</li>
        <li>Ask Oriel reads through service APIs only — the model never writes SQL.</li>
      </ul>`)}`;
  }

  function dialCell(ctx: Ctx, agent: AgentKey, propertyId: string | null, canConfigure: boolean): ReturnType<typeof html> {
    const current = autonomyFor(ctx, agent, propertyId);
    if (!canConfigure) return statusBadge(current === 'auto' ? 'active' : current === 'approve' ? 'pending' : 'draft', current);
    return html`<form method="post" action="/ai/dials" data-autosubmit>
      <input type="hidden" name="agent" value="${agent}" />
      <input type="hidden" name="property" value="${propertyId || ''}" />
      ${select('level', [['draft', 'draft-only'], ['approve', 'approve-to-send'], ['auto', 'autonomous']], current)}
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
    const conf = { ...getSetting<Record<string, Autonomy>>(ctx, 'ai_autonomy', propertyId) };
    conf[agent] = level;
    setSetting(ctx, 'ai_autonomy', conf, propertyId);
    audit(ctx, 'settings', `ai_autonomy${propertyId ? ':' + propertyId : ''}`, 'ai_dial_change', null, { agent, level });
    return redirect('/ai?view=dials', `${agent} → ${level}${propertyId ? ' (property override)' : ' (org default)'}`);
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

  // ---------- Ask Oriel ----------
  r.get('/ask', requirePerm('ai:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const question = (rq.query.get('q') || '').slice(0, 200);
    const answer = question ? askOriel(ctx, question) : null;
    return shell(rq, {
      title: 'Ask Oriel',
      active: '/ask',
      subtitle: 'Questions over your own data — answered through the same service APIs the screens use, never raw SQL.',
      content: html`
        <form method="get" class="card"><div class="card-body" style="display:flex;gap:8px">
          <input name="q" value="${question}" placeholder='Try: delinquency over $500 at Summit Ridge · which units turn this month · occupancy at Foundry' style="flex:1" autofocus />
          <button class="btn">Ask</button>
        </div></form>
        ${when(answer, () => html`
          ${card(html`${answer!.title} <span class="badge violet">${answer!.matched}</span>`, html`
            <p style="font-size:15px">${answer!.summary}</p>
            ${when(answer!.table, () => tbl(
              answer!.table!.cols.map((c) => ({ label: c })),
              answer!.table!.rows.map((row, i) => ({
                href: answer!.table!.hrefs?.[i] || undefined,
                cells: row.map((cell) => html`${cell}`),
              })),
            ))}
            <div style="display:flex;gap:8px;margin-top:10px">${answer!.links.map((l) => html`<a class="btn btn-sm btn-ghost" href="${l.href}">${l.label}</a>`)}</div>`)}`)}
        ${when(!answer, () => card('Things people ask', html`<ul>
          <li><a href="/ask?q=${encodeURIComponent('delinquency over $500 at Summit Ridge')}">delinquency over $500 at Summit Ridge</a></li>
          <li><a href="/ask?q=${encodeURIComponent('which units turn this month')}">which units turn this month</a></li>
          <li><a href="/ask?q=${encodeURIComponent('occupancy at Foundry')}">occupancy at Foundry</a></li>
          <li><a href="/ask?q=${encodeURIComponent('collection rate last month')}">collection rate last month</a></li>
          <li><a href="/ask?q=${encodeURIComponent('open work orders at Cardinal')}">open work orders at Cardinal</a></li>
          <li><a href="/ask?q=${encodeURIComponent('top vendor spend')}">top vendor spend</a></li>
        </ul>`))}`,
    });
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
          <div style="border:1px solid var(--line-2);border-radius:10px;padding:12px;background:var(--surface-2)">${raw(generated)}</div>`))}
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
