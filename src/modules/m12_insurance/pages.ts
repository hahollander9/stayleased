import { html, when, join, type Child } from '../../lib/html.ts';
import { notFound, redirect, type Router } from '../../lib/http.ts';
import { requirePerm, can, canAccessProperty, propFilter, requireResident, type Ctx } from '../../lib/auth.ts';
import { q, q1, val, run, js } from '../../lib/db.ts';
import { fmtDate, addMonths } from '../../lib/dates.ts';
import { usd, parseUsd } from '../../lib/money.ts';
import { getSetting } from '../../lib/settings.ts';
import { shell, card, tbl, dl, statusBadge, field, select, input, textarea, registerNav, kpis, emptyState } from '../../ui/ui.ts';
import { CARRIERS } from '../../lib/sim/insurance.ts';
import { isLiveOrg } from '../../lib/sim/messaging.ts';
import { putFile } from '../../lib/files.ts';
import {
  masterPolicyConfig, pendingPolicies, verifyPolicyByStaff, rejectPolicyByStaff, recordPolicyByStaff,
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
    const live = isLiveOrg(ctx);
    const manage = can(ctx, 'insurance:manage');
    const pending = pendingPolicies(ctx, props.map((p) => p.id)).filter((p) => !propId || p.property_id === propId);
    const hasMaster = (propertyId: string): boolean => !!masterPolicyConfig(ctx, propertyId);
    const noMaster = live && !props.some((p) => hasMaster(p.id));
    return shell(rq, {
      title: 'Insurance compliance',
      active: '/insurance',
      subtitle: live
        ? 'Every active lease requires liability coverage. Residents submit their policy in the portal; your team checks the proof and marks it verified.'
        : 'Every active lease requires liability coverage — verified, master-enrolled, or force-placed on lapse',
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
        ${when(noMaster, () => html`<div class="callout info">No master policy is set up, so nobody can be enrolled in or billed for a community program. If you hold a master tenant-liability policy, add its carrier and policy number under <a href="/admin/settings">Settings → Insurance</a>.</div>`)}
        ${when(pending.length > 0, () => card(html`Policies waiting for review <span class="muted small">(${pending.length})</span>`, html`
          <p class="small muted">Check each policy against the proof the resident gave you (or call the carrier), then mark it verified or say why it cannot be accepted. A policy counts as coverage only after it is verified.</p>
          ${tbl(
            [{ label: 'Household' }, { label: 'Unit' }, { label: 'Carrier / policy' }, { label: 'Liability', num: true }, { label: 'Expires' }, { label: 'Proof' }, { label: 'Decision' }],
            pending.map((p) => ({
              cells: [
                html`<a href="/leases/${p.lease_id}">${p.household_name}</a>`, html`${p.unit_number} <span class="muted small">${p.property}</span>`,
                html`${p.carrier} <span class="mono small">${p.policy_number}</span>`, usd(p.liability_cents),
                p.end_date ? fmtDate(p.end_date) : '—',
                p.file_id ? html`<a href="/f/${p.file_id}" target="_blank">Open proof</a>` : html`<span class="muted small">none attached</span>`,
                manage ? html`
                  <form method="post" action="/insurance/policies/${p.id}/verify" style="display:inline"><button class="btn btn-sm">Mark verified</button></form>
                  <form method="post" action="/insurance/policies/${p.id}/reject" class="toolbar" style="display:inline-flex;margin-top:4px">
                    <label class="sr-only" for="why-${p.id}">Reason the policy cannot be accepted</label>
                    <input id="why-${p.id}" name="reason" required placeholder="Reason (the resident sees this)" maxlength="300">
                    <button class="btn btn-sm btn-ghost">Reject</button>
                  </form>` : html`<span class="muted small">needs insurance:manage</span>`,
              ],
            })),
          )}`))}
        ${when(manage && live && leases.length > 0, () => card('Record a policy from proof you have', html`
          <form method="post" action="/insurance/policies" enctype="multipart/form-data">
            <div class="grid2">
              ${field('Household', select('lease_id', leases.slice(0, 500).map((l): [string, string] => [l.id, `${l.household_name} — ${l.unit_number}, ${l.property}`]), '', { required: true, blank: 'Choose a household' }))}
              ${field('Insurance company', input('carrier', { required: true }))}
              ${field('Policy number', input('policy_number', { required: true }))}
              ${field('Liability coverage ($)', input('liability', { required: true, placeholder: '100,000' }))}
              ${field('Expires', input('end_date', { type: 'date', required: true, value: addMonths(ctx.businessDate, 12) }))}
              ${field('Proof (PDF or photo, optional)', html`<input type="file" name="proof" accept="application/pdf,image/*">`)}
            </div>
            <button class="btn btn-sm">Record as verified</button>
            <span class="muted small" style="margin-left:8px">Use this when you are holding the declarations page. Your name is logged as the person who verified it.</span>
          </form>`))}
        ${card(null, tbl(
          [{ label: 'Household' }, { label: 'Unit' }, { label: 'Property' }, { label: 'Coverage' }, { label: 'Carrier / policy' }, { label: 'Expires' }, { label: '' }],
          rows.map(({ lease, state, policy }) => ({
            href: `/leases/${lease.id}`,
            cells: [
              lease.household_name, lease.unit_number, lease.property,
              statusBadge(state === 'covered' ? 'ok' : state === 'lapsing' ? 'warn' : 'error', state),
              policy ? html`${policy.carrier} <span class="mono small">${policy.policy_number}</span>` : html`<span class="muted">none on file</span>`,
              policy?.end_date ? fmtDate(policy.end_date) : policy ? 'evergreen' : '—',
              state !== 'covered' && manage && hasMaster(lease.property_id)
                ? html`<form method="post" action="/insurance/enroll/${lease.id}" style="display:inline"><button class="btn btn-sm">Enroll master</button></form>`
                : '',
            ],
          })),
          { empty: 'Nothing in this bucket.' },
        ), { flush: true })}`,
    });
  });

  r.post('/insurance/enroll/:leaseId', requirePerm('insurance:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const lease = q1<any>('SELECT property_id FROM leases WHERE id=? AND org_id=?', rq.params.leaseId!, ctx.orgId);
    if (!lease || !canAccessProperty(ctx, lease.property_id)) return notFound();
    try {
      enrollMaster(ctx, rq.params.leaseId!, 'enroll');
      return redirect('/insurance', 'Enrolled in the master policy — program fee added to the ledger');
    } catch (e) {
      return redirect('/insurance', (e as Error).message, 'err');
    }
  });

  // ---------- staff review of resident-submitted policies ----------
  const reviewable = (ctx: Ctx, policyId: string): any | null => {
    const p = q1<any>('SELECT * FROM insurance_policies WHERE id=? AND org_id=?', policyId, ctx.orgId);
    return p && canAccessProperty(ctx, p.property_id) ? p : null;
  };
  r.post('/insurance/policies/:id/verify', requirePerm('insurance:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    if (!reviewable(ctx, rq.params.id!)) return notFound();
    try {
      verifyPolicyByStaff(ctx, rq.params.id!);
      return redirect('/insurance', 'Policy verified — the household now shows as covered.');
    } catch (e) {
      return redirect('/insurance', (e as Error).message, 'err');
    }
  });
  r.post('/insurance/policies/:id/reject', requirePerm('insurance:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    if (!reviewable(ctx, rq.params.id!)) return notFound();
    try {
      rejectPolicyByStaff(ctx, rq.params.id!, String(rq.body?.reason || ''));
      return redirect('/insurance', 'Policy rejected — the reason is on the resident’s portal.');
    } catch (e) {
      return redirect('/insurance', (e as Error).message, 'err');
    }
  });
  r.post('/insurance/policies', requirePerm('insurance:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const lease = q1<any>('SELECT id, property_id FROM leases WHERE id=? AND org_id=?', String(rq.body?.lease_id || ''), ctx.orgId);
    if (!lease || !canAccessProperty(ctx, lease.property_id)) return redirect('/insurance', 'Choose a household.', 'err');
    try {
      const up = rq.uploads.find((u) => u.field === 'proof' && u.data.length > 0);
      const file = up ? putFile(ctx, up.data, { name: up.filename || 'insurance-proof', mime: up.mime, entity: 'lease', entityId: lease.id, visibility: 'staff', ownerUserId: ctx.userId }) : null;
      recordPolicyByStaff(ctx, {
        leaseId: lease.id, carrier: String(rq.body?.carrier || ''), policyNumber: String(rq.body?.policy_number || ''),
        liabilityCents: parseUsd(String(rq.body?.liability || '0')), startDate: ctx.businessDate, endDate: String(rq.body?.end_date || ''), fileId: file?.id ?? null,
      });
      return redirect('/insurance', 'Policy recorded and verified.');
    } catch (e) {
      return redirect('/insurance', (e as Error).message, 'err');
    }
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
      const live = isLiveOrg(ctx);
      const up = rq.uploads.find((u) => u.field === 'proof' && u.data.length > 0);
      const file = up ? putFile(ctx, up.data, { name: up.filename || 'insurance-proof', mime: up.mime, entity: 'lease', entityId: lease.id, visibility: 'resident', ownerUserId: ctx.userId }) : null;
      const res = submitPolicy(ctx, {
        leaseId: lease.id, carrier: String(rq.body?.carrier || (live ? '' : CARRIERS[0])),
        policyNumber: String(rq.body?.policy_number || ''), liabilityCents: parseUsd(String(rq.body?.liability || (live ? '0' : '100000'))),
        startDate: ctx.businessDate, endDate: String(rq.body?.end_date || addMonths(ctx.businessDate, 12)), fileId: file?.id ?? null,
      });
      if (live) return redirect('/portal/lease', 'Policy received — the office will review it. It shows as pending until then.');
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
    try {
      enrollMaster(ctx, lease.id, 'enroll');
      return redirect('/portal/lease', 'Enrolled in the community insurance program ✓');
    } catch {
      return redirect('/portal/lease', 'This community does not offer an insurance program. Upload a policy of your own instead.', 'err');
    }
  });
}

/** insurance card for the portal lease tab */
export function portalInsuranceCard(ctx: Ctx, lease: any): Child {
  const { state, policy } = leaseCompliance(ctx, lease.id);
  const required = requiredLiability(ctx, lease.property_id);
  const fee = getSetting<number>(ctx, 'master_policy_fee_cents', lease.property_id);
  const live = isLiveOrg(ctx);
  const program = !!masterPolicyConfig(ctx, lease.property_id);
  const latest = q1<any>(
    `SELECT * FROM insurance_policies WHERE lease_id=? AND org_id=? AND kind='third_party' ORDER BY created_at DESC LIMIT 1`,
    lease.id, ctx.orgId,
  );
  const waiting = latest?.status === 'pending_verification' ? latest : null;
  const turnedDown = !policy && latest?.status === 'rejected' && latest.review_note ? latest : null;
  return html`
    <div class="card">
      <h3>Renters insurance ${waiting && state === 'lapsed'
        ? statusBadge('pending', 'pending review')
        : statusBadge(state === 'covered' ? 'ok' : state === 'lapsing' ? 'warn' : 'error', state)}</h3>
      ${policy
        ? html`<p class="small">${policy.carrier} · <span class="mono">${policy.policy_number}</span>${policy.end_date ? html` · through ${fmtDate(policy.end_date)}` : ''}${policy.kind === 'master' ? html` · ${usd(fee)}/mo on your ledger` : ''}</p>`
        : html`<p class="small">Your lease requires liability coverage of at least <b>${usd(required)}</b>. ${program ? 'Upload your policy or enroll in the community program.' : 'Upload your policy below.'}</p>`}
      ${when(waiting, () => html`<p class="small"><b>Received:</b> ${waiting.carrier} · <span class="mono">${waiting.policy_number}</span>. The office is reviewing it — you do not need to do anything else.</p>`)}
      ${when(turnedDown, () => html`<p class="small"><b>The office could not accept policy <span class="mono">${turnedDown.policy_number}</span>:</b> ${turnedDown.review_note}</p>`)}
      ${when(state !== 'covered' || policy?.kind === 'master', () => html`
        <details ${state !== 'covered' && !waiting ? 'open' : ''}>
          <summary class="small">Upload a policy you already have</summary>
          <form method="post" action="/portal/insurance/upload" class="stack" enctype="multipart/form-data">
            ${live
              ? field('Insurance company', input('carrier', { required: true, placeholder: 'the company named on your policy' }))
              : field('Carrier', select('carrier', CARRIERS.map((c): [string, string] => [c, c]), CARRIERS[0]))}
            ${field('Policy number', input('policy_number', { required: true, placeholder: 'e.g. RS-2216804' }))}
            ${field('Liability coverage ($)', input('liability', live ? { required: true, placeholder: 'e.g. 100,000' } : { value: '100,000' }))}
            ${field('Expires', input('end_date', { type: 'date', value: addMonths(ctx.businessDate, 12) }))}
            ${when(live, () => field('Proof of coverage (PDF or photo of your declarations page)', html`<input type="file" name="proof" accept="application/pdf,image/*">`))}
            <button class="btn btn-sm">${live ? 'Send to the office for review' : 'Submit for verification'}</button>
          </form>
        </details>
        ${when(program && (!policy || policy.kind !== 'master'), () => html`
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
