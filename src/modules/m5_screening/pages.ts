import { html, raw, when, join } from '../../lib/html.ts';
import { redirect, notFound, type Router, type Rq } from '../../lib/http.ts';
import { requirePerm, propFilter, canAccessProperty, type Ctx } from '../../lib/auth.ts';
import { q, q1, val, run, j } from '../../lib/db.ts';
import { fmtDate, fmtTs } from '../../lib/dates.ts';
import { usd } from '../../lib/money.ts';
import {
  shell, card, tbl, kpis, dl, tabs, statusBadge, field, input, select, textarea,
  registerNav, registerSearch, pager, emptyState, historyPanel,
} from '../../ui/ui.ts';
import {
  completeScreenings, computeScorecard, decideApplication, cancelApplication, unitHold, releaseHold,
  createApplication, type Scorecard,
} from './service.ts';
import { registerDashboardExtras } from '../m2_portfolio/pages.ts';

registerNav('Leasing', { href: '/applications', label: 'Applications', perm: 'applications:view', match: ['/applications'] });

registerSearch((ctx, query) => {
  if (!ctx.perms.has('applications:view')) return [];
  const like = `%${query}%`;
  return q<any>(
    `SELECT DISTINCT ap.id, a.first_name || ' ' || a.last_name AS name, ap.status FROM applications ap
     JOIN applicants a ON a.application_id=ap.id
     WHERE ap.org_id=? AND (a.first_name || ' ' || a.last_name LIKE ? OR a.email LIKE ?) LIMIT 5`,
    ctx.orgId, like, like,
  ).map((x) => ({ kind: 'application', label: x.name, sub: x.status, href: `/applications/${x.id}` }));
});

registerDashboardExtras((ctx, propertyId) => {
  const propSql = propertyId ? ' AND property_id=?' : '';
  const p = propertyId ? [propertyId] : [];
  const inReview = val<number>(`SELECT COUNT(*) FROM applications WHERE org_id=? AND status IN ('review','screening')${propSql}`, ctx.orgId, ...p) || 0;
  return { kpis: inReview ? [{ label: 'Applications pending', value: inReview, tone: 'accent', href: '/applications' }] : [], panels: null };
});

const APP_STATUSES = ['draft', 'submitted', 'screening', 'review', 'approved', 'approved_conditions', 'declined', 'canceled', 'converted'];

export function routes(r: Router): void {
  r.get('/applications', requirePerm('applications:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const status = rq.query.get('status') || 'pipeline';
    const pf = propFilter(ctx, 'ap.property_id');
    const params: unknown[] = [ctx.orgId, ...pf.params];
    let where = `ap.org_id=?${pf.sql}`;
    if (status === 'pipeline') where += ` AND ap.status IN ('draft','screening','review','approved','approved_conditions')`;
    else if (status) { where += ' AND ap.status=?'; params.push(status); }
    const total = val<number>(`SELECT COUNT(*) FROM applications ap WHERE ${where}`, ...params);
    const page = Math.max(1, parseInt(rq.query.get('page') || '1', 10) || 1);
    const rows = q<any>(
      `SELECT ap.*, u.unit_number, p.name AS prop_name,
        (SELECT a.first_name || ' ' || a.last_name FROM applicants a WHERE a.application_id=ap.id AND a.kind='primary') AS primary_name,
        (SELECT COUNT(*) FROM applicants a WHERE a.application_id=ap.id AND a.kind IN ('primary','co','guarantor')) AS people,
        (SELECT COUNT(*) FROM screening_reports s WHERE s.application_id=ap.id AND s.status='complete') AS done_reports,
        (SELECT COUNT(*) FROM screening_reports s WHERE s.application_id=ap.id) AS total_reports
       FROM applications ap JOIN units u ON u.id=ap.unit_id JOIN properties p ON p.id=ap.property_id
       WHERE ${where} ORDER BY ap.created_at DESC LIMIT 50 OFFSET ?`,
      ...params, (page - 1) * 50,
    );
    const counts = Object.fromEntries(
      q<any>(`SELECT status, COUNT(*) n FROM applications WHERE org_id=? GROUP BY status`, ctx.orgId).map((x) => [x.status, x.n]),
    );
    return shell(rq, {
      title: 'Applications',
      active: '/applications',
      subtitle: `Pipeline: ${counts['screening'] || 0} screening · ${counts['review'] || 0} awaiting decision · ${(counts['approved'] || 0) + (counts['approved_conditions'] || 0)} approved`,
      content: html`
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Status', select('status', [['pipeline', 'Active pipeline'], ...APP_STATUSES.map((s): [string, string] => [s, s.replaceAll('_', ' ')])], status))}
        </form>
        ${card(null, html`${tbl(
          [{ label: 'Household' }, { label: 'Unit' }, { label: 'Property' }, { label: 'Move-in' }, { label: 'Rent', num: true }, { label: 'Screening' }, { label: 'Status' }],
          rows.map((ap) => ({
            href: `/applications/${ap.id}`,
            cells: [
              html`<b>${ap.primary_name || '(started)'}</b><span class="sub">${ap.people} applicant${ap.people === 1 ? '' : 's'}</span>`,
              ap.unit_number, ap.prop_name, fmtDate(ap.move_in), usd(ap.rent_cents),
              ap.total_reports ? html`${ap.done_reports}/${ap.total_reports} ${ap.done_reports < ap.total_reports ? statusBadge('pending') : statusBadge('complete')}` : '—',
              statusBadge(ap.status),
            ],
          })),
          { empty: 'No applications match.' },
        )}${pager(rq, total)}`, { flush: true })}`,
    });
  });

  r.get('/applications/:id', requirePerm('applications:view'), async (rq) => {
    const ctx = rq.ctx as Ctx;
    const ap = q1<any>(
      `SELECT ap.*, u.unit_number, u.status AS unit_status, p.name AS prop_name FROM applications ap
       JOIN units u ON u.id=ap.unit_id JOIN properties p ON p.id=ap.property_id WHERE ap.id=? AND ap.org_id=?`,
      rq.params.id!, ctx.orgId,
    );
    if (!ap || !canAccessProperty(ctx, ap.property_id)) return notFound('Application not found');
    const applicants = q<any>(
      `SELECT a.*, s.status AS scr_status, s.credit_score, s.credit_band, s.criminal_flag, s.eviction_flag, s.eviction_years_ago, s.thin_file, s.fraud_flags, s.income_extracted_cents
       FROM applicants a LEFT JOIN screening_reports s ON s.applicant_id=a.id
       WHERE a.application_id=? ORDER BY CASE a.kind WHEN 'primary' THEN 0 WHEN 'co' THEN 1 WHEN 'guarantor' THEN 2 ELSE 3 END`,
      ap.id,
    );
    const scorecard: Scorecard | null = ap.recommendation_detail ? j<Scorecard>(ap.recommendation_detail, null as unknown as Scorecard) : null;
    const decision = j<any>(ap.decision, null);
    const docs = (aplId: string) => q<any>(`SELECT * FROM files WHERE entity IN ('applicant_income','applicant_id') AND entity_id=?`, aplId);
    const letters = q<any>(`SELECT * FROM files WHERE entity='application' AND entity_id=?`, ap.id);
    const canDecide = ctx.perms.has('applications:manage') && ['review', 'screening'].includes(ap.status);
    const hold = unitHold(ap.unit_id);
    return shell(rq, {
      title: `Application — ${ap.unit_number}`,
      active: '/applications',
      crumbs: [['Applications', '/applications']],
      subtitle: html`${statusBadge(ap.status)} · ${ap.prop_name} · move-in ${fmtDate(ap.move_in)} · ${usd(ap.rent_cents)}/mo · criteria v${ap.criteria_version ?? '—'}`,
      actions: html`
        ${when(['approved', 'approved_conditions'].includes(ap.status) && ctx.perms.has('leases:manage'), () => html`<form method="post" action="/applications/${ap.id}/generate-lease"><button class="btn">Generate lease</button></form>`)}
        ${when(ap.status === 'converted' && ap.lease_id, () => html`<a class="btn" href="/leases/${ap.lease_id}">Open lease</a>`)}
        ${when(ap.status === 'screening', () => html`<form method="post" action="/applications/${ap.id}/check"><button class="btn btn-ghost">Check bureau results</button></form>`)}
        ${when(
          scorecard?.recommendation === 'conditions' && ['review', 'screening'].includes(ap.status)
            && !q1(`SELECT id FROM guaranty_contracts WHERE application_id=?`, ap.id),
          () => html`<form method="post" action="/applications/${ap.id}/guaranty" data-confirm="Attach the simulated institutional guaranty? A one-time fee (85% of one month's rent) posts at move-in and the income/credit condition is treated as satisfied.">
            <button class="btn btn-ghost">Attach institutional guaranty</button></form>`,
        )}
        ${when(!['canceled', 'converted', 'declined'].includes(ap.status), () => html`<form method="post" action="/applications/${ap.id}/cancel" data-confirm="Cancel this application and release any hold?"><button class="btn btn-ghost">Cancel</button></form>`)}`,
      content: html`
        ${when(scorecard?.flags?.length, () => html`<div class="callout warn"><b>Review flags (never auto-decline):</b><br/>${join(scorecard!.flags.map((f) => html`• ${f}<br/>`))}</div>`)}
        <div class="grid cols-2">
          <div>
            ${card('Household & screening', join(applicants.map((a) => {
              const fraud = j<string[]>(a.fraud_flags, []);
              return html`<div style="border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:10px">
                <div style="display:flex;gap:8px;align-items:center">
                  <b>${a.first_name || '—'} ${a.last_name || ''}</b> ${statusBadge(undefined, a.kind)} ${statusBadge(a.status === 'complete' ? 'complete' : a.status)}
                  <div style="flex:1"></div>
                  ${a.scr_status === 'complete'
                    ? html`<span class="badge ${a.credit_band === 'excellent' || a.credit_band === 'good' ? 'ok' : a.credit_band === 'fair' ? 'warn' : 'bad'}">${a.thin_file ? 'thin file' : `${a.credit_score} · ${a.credit_band}`}</span>`
                    : a.scr_status ? statusBadge('pending', 'bureau pending') : ''}
                </div>
                <div class="small muted" style="margin-top:4px">${a.email} · ${a.phone || 'no phone'} · income ${a.income_monthly_cents ? usd(a.income_monthly_cents) + '/mo' : '—'}${a.income_extracted_cents ? ` (doc reads ${usd(a.income_extracted_cents)})` : ''}</div>
                ${when(a.scr_status === 'complete', () => html`<div class="small" style="margin-top:4px">
                  ${a.criminal_flag ? html`<span class="badge warn">criminal hit — individualized review</span> ` : ''}
                  ${a.eviction_flag ? html`<span class="badge bad">eviction ${a.eviction_years_ago}y ago</span> ` : ''}
                  ${fraud.map((f) => html`<span class="badge bad">⚠ ${f}</span> `)}
                  ${!a.criminal_flag && !a.eviction_flag && !fraud.length ? html`<span class="badge ok">no records</span>` : ''}
                </div>`)}
                ${when(docs(a.id).length, () => html`<div class="small" style="margin-top:4px">${docs(a.id).map((d) => html`<a href="/f/${d.id}" target="_blank">📄 ${d.name}</a> `)}</div>`)}
              </div>`;
            })), { flush: false })}
            ${when(letters.length, () => card('Letters & documents', join(letters.map((d) => html`<div class="list-item"><a href="/f/${d.id}" target="_blank">📄 ${d.name}</a></div>`))))}
          </div>
          <div>
            ${when(scorecard, () => card(html`Household scorecard ${statusBadge(scorecard!.recommendation === 'approve' ? 'ok' : scorecard!.recommendation === 'conditions' ? 'warn' : 'bad', scorecard!.recommendation)}`, html`
              ${dl([
                ['Household income', scorecard!.totalIncomeCents ? `${usd(scorecard!.totalIncomeCents)}/mo` : '—'],
                ['Income multiple', scorecard!.incomeMultiple !== null ? `${scorecard!.incomeMultiple}× rent` : '—'],
                ['Lowest credit score', scorecard!.minScore ?? 'thin file'],
              ])}
              <div class="small" style="margin-top:8px"><b>Reasons</b><ul style="margin:4px 0 0 18px;padding:0">${scorecard!.reasons.map((x) => html`<li>${x}</li>`)}</ul></div>
              ${when(scorecard!.conditions.length, () => html`<div class="small" style="margin-top:6px"><b>Conditions</b><ul style="margin:4px 0 0 18px;padding:0">${scorecard!.conditions.map((x) => html`<li>${x}</li>`)}</ul></div>`)}`))}
            ${when(canDecide, () => card('Decision', html`
              <p class="small muted">Recommendation: <b>${ap.recommendation || 'pending'}</b>. Choosing a different outcome is an override — it requires the screening:override permission and a written reason (both audited).</p>
              <form method="post" action="/applications/${ap.id}/decide">
                ${field('Action', select('action', [['approved', 'Approve'], ['approved_conditions', 'Approve with conditions'], ['declined', 'Decline']], ap.recommendation === 'approve' ? 'approved' : ap.recommendation === 'conditions' ? 'approved_conditions' : 'declined'))}
                ${field('Reason (required when overriding)', textarea('reason', { rows: 2, placeholder: 'e.g. Verified 3 years excellent rental history with prior landlord…' }))}
                <button class="btn">Record decision</button>
              </form>`))}
            ${when(decision, () => card('Decision record', dl([
              ['Outcome', statusBadge(ap.status)],
              ['Decided by', decision.byName || decision.by],
              ['Recommendation was', decision.recommendation || '—'],
              ['Override', decision.overrode ? html`<span class="badge warn">YES — with reason</span>` : 'No'],
              ...(decision.reason ? [['Reason', decision.reason] as [any, any]] : []),
              ['Criteria version', `v${decision.criteriaVersion ?? ap.criteria_version}`],
              ['At', fmtTs(decision.at)],
            ])))}
            ${card('Unit hold', html`${dl([
              ['Unit', html`<a href="/units/${ap.unit_id}">${ap.unit_number}</a> (${ap.unit_status.replaceAll('_', ' ')})`],
              ['Held', hold && hold.applicationId === ap.id ? html`<b>until ${fmtDate(hold.expires)}</b>` : hold ? html`by another application until ${fmtDate(hold.expires)}` : 'not held'],
              ['Fees', ap.fees_paid ? html`${statusBadge('paid')} app fees + ${usd(ap.hold_deposit_cents)} holding deposit` : statusBadge('pending', 'unpaid')],
            ])}
            ${when(hold && hold.applicationId === ap.id && ctx.perms.has('applications:manage'), () => html`<form method="post" action="/applications/${ap.id}/release-hold" data-confirm="Release this unit back to available inventory?"><button class="btn btn-sm btn-ghost">Release hold</button></form>`)}`)}
            ${card('History', historyPanel(ctx.orgId, 'application', ap.id))}
          </div>
        </div>`,
    });
  });

  r.post('/applications/:id/check', requirePerm('applications:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const n = completeScreenings(ctx, rq.params.id!);
    return redirect(`/applications/${rq.params.id}`, n ? `${n} bureau report${n === 1 ? '' : 's'} returned.` : 'Nothing pending.');
  });

  r.post('/applications/:id/decide', requirePerm('applications:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    try {
      decideApplication(ctx, rq.params.id!, String(rq.body.action) as any, {
        reason: rq.body.reason ? String(rq.body.reason) : undefined,
      });
    } catch (e) {
      return redirect(`/applications/${rq.params.id}`, (e as Error).message, 'err');
    }
    return redirect(`/applications/${rq.params.id}`, 'Decision recorded.');
  });

  r.post('/applications/:id/cancel', requirePerm('applications:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    try {
      cancelApplication(ctx, rq.params.id!, 'canceled by staff');
    } catch (e) {
      return redirect(`/applications/${rq.params.id}`, (e as Error).message, 'err');
    }
    return redirect(`/applications/${rq.params.id}`, 'Canceled — hold released and holding deposit refunded.');
  });

  r.post('/applications/:id/release-hold', requirePerm('applications:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    releaseHold(ctx, rq.params.id!, 'released by staff');
    return redirect(`/applications/${rq.params.id}`, 'Hold released.');
  });

  // one-click quote → application (M3.5)
  r.post('/quotes/:id/convert', requirePerm('applications:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const quote = q1<any>('SELECT * FROM quotes WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!quote) return notFound();
    const lead = q1<any>('SELECT * FROM leads WHERE id=?', quote.lead_id);
    const { applicationId, applicantToken } = createApplication(ctx, {
      propertyId: quote.property_id, unitId: quote.unit_id, leadId: quote.lead_id, quoteId: quote.id,
      primary: { firstName: lead?.first_name, lastName: lead?.last_name, email: lead?.email || `${quote.lead_id}@apply.demo`, phone: lead?.phone },
    });
    run(`UPDATE quotes SET status='accepted' WHERE id=?`, quote.id);
    return redirect(`/applications/${applicationId}`, `Application created from the quote — applicant link emailed (or share /apply/${applicantToken}).`);
  });
}
