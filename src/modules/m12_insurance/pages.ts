import { html, when, join, type Child } from '../../lib/html.ts';
import { notFound, redirect, type Router } from '../../lib/http.ts';
import { requirePerm, can, propFilter, requireResident, type Ctx } from '../../lib/auth.ts';
import { q, q1, val, run, js } from '../../lib/db.ts';
import { fmtDate, addMonths } from '../../lib/dates.ts';
import { usd, parseUsd } from '../../lib/money.ts';
import { getSetting } from '../../lib/settings.ts';
import { shell, card, tbl, dl, statusBadge, field, select, input, textarea, registerNav, kpis, emptyState } from '../../ui/ui.ts';
import { CARRIERS } from '../../lib/sim/insurance.ts';
import {
  complianceStats, leaseCompliance, submitPolicy, enrollMaster, requiredLiability,
  enrollDepositAlternative, quoteGuaranty, attachGuaranty, logIncident,
} from './service.ts';
import { computeScorecard } from '../m5_screening/service.ts';

/** M12 screens: insurance compliance dashboard, risk & incidents log, portal
 * insurance card, deposit-alternative and guaranty actions. */

registerNav('Property', { href: '/insurance', label: 'Insurance & risk', perm: 'insurance:view', match: ['/insurance', '/risk'] });

export function routes(r: Router): void {
  r.get('/insurance', requirePerm('insurance:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const pf = propFilter(ctx, 'id');
    const props = q<any>(`SELECT id, name FROM properties WHERE org_id=?${pf.sql} ORDER BY name`, ctx.orgId, ...pf.params);
    const propId = rq.query.get('property') || '';
    const stats = complianceStats(ctx, propId || null);
    const filter = rq.query.get('state') || 'lapsed';
    const leases = q<any>(
      `SELECT l.*, u.unit_number, p.name AS property FROM leases l JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=l.property_id
       WHERE l.org_id=? AND l.status IN ('active','notice','month_to_month')${propId ? ' AND l.property_id=?' : ''} ORDER BY p.name, u.unit_number`,
      ...(propId ? [ctx.orgId, propId] : [ctx.orgId]),
    );
    const rows: { lease: any; state: string; policy: any }[] = [];
    for (const l of leases) {
      const c = leaseCompliance(ctx, l.id);
      if (filter === 'all' || c.state === filter) rows.push({ lease: l, state: c.state, policy: c.policy });
      if (rows.length >= 80) break;
    }
    const alts = val<number>(`SELECT COUNT(*) FROM deposit_alternatives WHERE org_id=? AND status='active'`, ctx.orgId) || 0;
    return shell(rq, {
      title: 'Insurance compliance',
      active: '/insurance',
      subtitle: 'Every active lease requires liability coverage — verified, master-enrolled, or force-placed on lapse',
      actions: html`<a class="btn btn-ghost" href="/risk">Risk & incidents</a>`,
      content: html`
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Property', select('property', props.map((p): [string, string] => [p.id, p.name]), propId, { blank: 'All properties' }))}
          ${field('Show', select('state', [['lapsed', 'Lapsed'], ['lapsing', 'Lapsing soon'], ['covered', 'Covered'], ['all', 'All']], filter))}
        </form>
        ${kpis([
          { label: 'Coverage rate', value: stats.total ? `${Math.round(((stats.covered + stats.lapsing) / stats.total) * 100)}%` : '—', tone: 'ok' },
          { label: 'Covered', value: String(stats.covered) },
          { label: 'Lapsing ≤21d', value: String(stats.lapsing), tone: stats.lapsing ? 'warn' : undefined },
          { label: 'Lapsed', value: String(stats.lapsed), tone: stats.lapsed ? 'bad' : 'ok' },
          { label: 'On master policy', value: `${stats.masterShare}%` },
          { label: 'Deposit alternatives', value: String(alts) },
        ])}
        ${card(null, tbl(
          [{ label: 'Household' }, { label: 'Unit' }, { label: 'Property' }, { label: 'Coverage' }, { label: 'Carrier / policy' }, { label: 'Expires' }, { label: '' }],
          rows.map(({ lease, state, policy }) => ({
            href: `/leases/${lease.id}`,
            cells: [
              lease.household_name, lease.unit_number, lease.property,
              statusBadge(state === 'covered' ? 'ok' : state === 'lapsing' ? 'warn' : 'error', state),
              policy ? html`${policy.carrier} <span class="mono small">${policy.policy_number}</span>` : html`<span class="muted">none on file</span>`,
              policy?.end_date ? fmtDate(policy.end_date) : policy ? 'evergreen' : '—',
              state !== 'covered' && can(ctx, 'insurance:manage')
                ? html`<form method="post" action="/insurance/enroll/${lease.id}" style="display:inline"><button class="btn btn-sm">Enroll master</button></form>`
                : '',
            ],
          })),
          { empty: 'Nothing in this bucket.' },
        ), { flush: true })}`,
    });
  });

  r.post('/insurance/enroll/:leaseId', requirePerm('insurance:manage'), (rq) => {
    enrollMaster(rq.ctx as Ctx, rq.params.leaseId!, 'enroll');
    return redirect('/insurance', 'Enrolled in the master policy — program fee added to the ledger');
  });

  // ---------- risk & incidents ----------
  r.get('/risk', requirePerm('insurance:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const stats = complianceStats(ctx, null);
    const incidents = q<any>(
      `SELECT i.*, p.name AS property, u.unit_number FROM incidents i JOIN properties p ON p.id=i.property_id
       LEFT JOIN units u ON u.id=i.unit_id WHERE i.org_id=? ORDER BY i.date DESC LIMIT 60`,
      ctx.orgId,
    );
    const claims = q<any>(
      `SELECT da.*, l.household_name, p.name AS property FROM deposit_alternatives da
       JOIN leases l ON l.id=da.lease_id JOIN properties p ON p.id=da.property_id
       WHERE da.org_id=? AND da.status='claimed' ORDER BY da.claim_date DESC LIMIT 20`,
      ctx.orgId,
    );
    const pf = propFilter(ctx, 'id');
    const props = q<any>(`SELECT id, name FROM properties WHERE org_id=?${pf.sql} ORDER BY name`, ctx.orgId, ...pf.params);
    const openLoss = incidents.filter((i) => i.status !== 'closed').reduce((s, i) => s + i.est_loss_cents, 0);
    return shell(rq, {
      title: 'Risk & incidents',
      active: '/insurance',
      subtitle: 'Coverage, losses and the incident log',
      content: html`
        ${kpis([
          { label: 'Coverage rate', value: stats.total ? `${Math.round(((stats.covered + stats.lapsing) / stats.total) * 100)}%` : '—' },
          { label: 'Lapse rate', value: stats.total ? `${Math.round((stats.lapsed / stats.total) * 100)}%` : '—', tone: stats.lapsed ? 'warn' : 'ok' },
          { label: 'Open incidents', value: String(incidents.filter((i) => i.status !== 'closed').length) },
          { label: 'Est. open exposure', value: usd(openLoss), tone: openLoss ? 'warn' : undefined },
          { label: 'Surety claims paid', value: usd(claims.reduce((s, c) => s + c.claim_cents, 0)) },
        ])}
        ${when(can(ctx, 'insurance:manage'), () => card('Log an incident', html`
          <form method="post" action="/risk/incidents" class="toolbar">
            ${select('property_id', props.map((p): [string, string] => [p.id, p.name]), props[0]?.id)}
            ${select('kind', [['water', 'Water damage'], ['fire', 'Fire/smoke'], ['injury', 'Injury'], ['theft', 'Theft/vandalism'], ['liability', 'Liability claim'], ['mold', 'Mold'], ['other', 'Other']], 'water')}
            ${input('date', { type: 'date', value: ctx.businessDate })}
            ${input('description', { placeholder: 'what happened', required: true })}
            ${input('est_loss', { placeholder: 'est. loss $' })}
            <button class="btn">Log</button>
          </form>`))}
        ${card('Incident log', tbl(
          [{ label: 'Date' }, { label: 'Property' }, { label: 'Unit' }, { label: 'Kind' }, { label: 'Description' }, { label: 'Est. loss', num: true }, { label: 'Status' }],
          incidents.map((i) => ({
            cells: [fmtDate(i.date), i.property, i.unit_number || '—', i.kind, i.description, i.est_loss_cents ? usd(i.est_loss_cents) : '', statusBadge(i.status)],
          })),
          { empty: 'No incidents logged.' },
        ), { flush: true })}
        ${card('Deposit-alternative claims', tbl(
          [{ label: 'Household' }, { label: 'Property' }, { label: 'Coverage', num: true }, { label: 'Claim paid', num: true }, { label: 'Date' }],
          claims.map((c) => ({
            href: `/leases/${c.lease_id}`,
            cells: [c.household_name, c.property, usd(c.coverage_cents), usd(c.claim_cents), fmtDate(c.claim_date)],
          })),
          { empty: 'No claims yet.' },
        ), { flush: true })}`,
    });
  });

  r.post('/risk/incidents', requirePerm('insurance:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    logIncident(ctx, {
      propertyId: String(rq.body?.property_id), kind: String(rq.body?.kind || 'other'),
      date: String(rq.body?.date || ctx.businessDate), description: String(rq.body?.description || ''),
      estLossCents: parseUsd(String(rq.body?.est_loss || '0')),
    });
    return redirect('/risk', 'Incident logged');
  });

  // ---------- staff lease actions ----------
  r.post('/leases/:id/deposit-alternative', requirePerm('leases:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    try {
      enrollDepositAlternative(ctx, rq.params.id!, (String(rq.body?.mode || 'monthly') as 'monthly' | 'one_time'));
      return redirect(`/leases/${rq.params.id}`, 'Deposit alternative enrolled — no traditional deposit will be charged');
    } catch (e) {
      return redirect(`/leases/${rq.params.id}`, (e as Error).message, 'err');
    }
  });

  // ---------- application guaranty ----------
  r.post('/applications/:id/guaranty', requirePerm('screening:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    try {
      attachGuaranty(ctx, rq.params.id!);
      // refresh the stored scorecard so the rescue shows immediately
      const rec = computeScorecard(ctx, rq.params.id!);
      run('UPDATE applications SET recommendation=?, recommendation_detail=? WHERE id=?', rec.recommendation, js(rec), rq.params.id!);
      return redirect(`/applications/${rq.params.id}`, 'Institutional guaranty attached — the scorecard now treats the condition as satisfied');
    } catch (e) {
      return redirect(`/applications/${rq.params.id}`, (e as Error).message, 'err');
    }
  });
}

// ---------- portal ----------

export function portalRoutes(r: Router): void {
  r.post('/portal/insurance/upload', requireResident, (rq) => {
    const ctx = rq.ctx as Ctx;
    const lease = q1<any>(
      `SELECT l.* FROM leases l JOIN household_members hm ON hm.lease_id=l.id JOIN residents rr ON rr.id=hm.resident_id
       WHERE rr.user_id=? AND l.status IN ('active','notice','month_to_month') LIMIT 1`,
      ctx.userId,
    );
    if (!lease) return notFound();
    try {
      const res = submitPolicy(ctx, {
        leaseId: lease.id, carrier: String(rq.body?.carrier || CARRIERS[0]),
        policyNumber: String(rq.body?.policy_number || ''), liabilityCents: parseUsd(String(rq.body?.liability || '100000')),
        startDate: ctx.businessDate, endDate: String(rq.body?.end_date || addMonths(ctx.businessDate, 12)),
      });
      return redirect('/portal/lease', res.outcome === 'verified'
        ? 'Policy verified — you are covered ✓'
        : res.outcome === 'pending' ? 'Policy submitted — carrier verification is queued' : 'The carrier could not verify that policy — check the number or enroll in the master policy');
    } catch (e) {
      return redirect('/portal/lease', (e as Error).message, 'err');
    }
  });

  r.post('/portal/insurance/enroll', requireResident, (rq) => {
    const ctx = rq.ctx as Ctx;
    const lease = q1<any>(
      `SELECT l.* FROM leases l JOIN household_members hm ON hm.lease_id=l.id JOIN residents rr ON rr.id=hm.resident_id
       WHERE rr.user_id=? AND l.status IN ('active','notice','month_to_month') LIMIT 1`,
      ctx.userId,
    );
    if (!lease) return notFound();
    enrollMaster(ctx, lease.id, 'enroll');
    return redirect('/portal/lease', 'Enrolled in the community insurance program ✓');
  });
}

/** insurance card for the portal lease tab */
export function portalInsuranceCard(ctx: Ctx, lease: any): Child {
  const { state, policy } = leaseCompliance(ctx, lease.id);
  const required = requiredLiability(ctx, lease.property_id);
  const fee = getSetting<number>(ctx, 'master_policy_fee_cents', lease.property_id);
  return html`
    <div class="card">
      <h3>Renters insurance ${statusBadge(state === 'covered' ? 'ok' : state === 'lapsing' ? 'warn' : 'error', state)}</h3>
      ${policy
        ? html`<p class="small">${policy.carrier} · <span class="mono">${policy.policy_number}</span>${policy.end_date ? html` · through ${fmtDate(policy.end_date)}` : ''}${policy.kind === 'master' ? html` · ${usd(fee)}/mo on your ledger` : ''}</p>`
        : html`<p class="small">Your lease requires liability coverage of at least <b>${usd(required)}</b>. Upload your policy or enroll in the community program.</p>`}
      ${when(state !== 'covered' || policy?.kind === 'master', () => html`
        <details ${state !== 'covered' ? 'open' : ''}>
          <summary class="small">Upload a policy you already have</summary>
          <form method="post" action="/portal/insurance/upload" class="stack">
            ${field('Carrier', select('carrier', CARRIERS.map((c): [string, string] => [c, c]), CARRIERS[0]))}
            ${field('Policy number', input('policy_number', { required: true, placeholder: 'e.g. RS-2216804' }))}
            ${field('Liability coverage ($)', input('liability', { value: '100,000' }))}
            ${field('Expires', input('end_date', { type: 'date', value: addMonths(ctx.businessDate, 12) }))}
            <button class="btn btn-sm">Submit for verification</button>
          </form>
        </details>
        ${when(!policy || policy.kind !== 'master', () => html`
          <form method="post" action="/portal/insurance/enroll" style="margin-top:8px">
            <button class="btn btn-sm">Enroll in the community program — ${usd(fee)}/mo</button>
          </form>`)}`)}
    </div>`;
}

// ---------- lease page contributions ----------
import { registerLeaseAction, registerLeaseTab } from '../people/pages.ts';

registerLeaseAction((ctx: Ctx, lease: any) => {
  if (!can(ctx, 'leases:manage')) return null;
  if (!['draft', 'out_for_signature', 'partially_signed', 'fully_executed'].includes(lease.status)) return null;
  if (q1('SELECT id FROM deposit_alternatives WHERE lease_id=?', lease.id)) return null;
  return html`
    <form method="post" action="/leases/${lease.id}/deposit-alternative" style="display:inline" data-confirm="Replace the traditional deposit with the SuretyShield alternative?">
      <input type="hidden" name="mode" value="monthly">
      <button class="btn btn-ghost">Offer deposit alternative</button>
    </form>`;
});

registerLeaseTab((ctx: Ctx, lease: any) => {
  const pols = q<any>('SELECT * FROM insurance_policies WHERE lease_id=? ORDER BY created_at DESC LIMIT 8', lease.id);
  const alt = q1<any>('SELECT * FROM deposit_alternatives WHERE lease_id=?', lease.id);
  if (!pols.length && !alt) return null;
  return {
    key: 'coverage',
    label: 'Coverage',
    render: () => html`
      ${card('Insurance policies', tbl(
        [{ label: 'Kind' }, { label: 'Carrier' }, { label: 'Policy' }, { label: 'Liability', num: true }, { label: 'Window' }, { label: 'Status' }],
        pols.map((p: any) => ({
          cells: [p.kind === 'master' ? 'master policy' : 'third-party', p.carrier, html`<span class="mono">${p.policy_number}</span>`, usd(p.liability_cents), `${fmtDate(p.start_date)} → ${p.end_date ? fmtDate(p.end_date) : 'evergreen'}`, statusBadge(p.status)],
        })),
        { empty: 'No policies on file.' },
      ), { flush: true })}
      ${when(alt, () => card('Deposit alternative', dl([
        ['Provider', alt.provider],
        ['Mode', alt.mode === 'monthly' ? `${usd(alt.fee_cents)}/month` : `one-time ${usd(alt.fee_cents)}`],
        ['Coverage', usd(alt.coverage_cents)],
        ['Status', statusBadge(alt.status)],
        ...(alt.status === 'claimed' ? [['Claim paid', html`${usd(alt.claim_cents)} on ${fmtDate(alt.claim_date)}`]] as [any, any][] : []),
      ])))}`,
  };
});
