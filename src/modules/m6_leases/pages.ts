import { html, raw, when, join, type Child } from '../../lib/html.ts';
import { htmlRes, redirect, notFound, badRequest, type Router, type Rq, type Res, takeFlash } from '../../lib/http.ts';
import { requirePerm, propFilter, canAccessProperty, sysCtx, type Ctx } from '../../lib/auth.ts';
import { q, q1, val, run, j, js, update, insert } from '../../lib/db.ts';
import { getFile } from '../../lib/files.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, fmtDate, addDays, diffDays, fmtTs } from '../../lib/dates.ts';
import { usd } from '../../lib/money.ts';
import { audit } from '../../lib/audit.ts';
import {
  shell, card, tbl, kpis, dl, tabs, statusBadge, field, input, select, textarea,
  registerNav, emptyState, doc, logo,
} from '../../ui/ui.ts';
import {
  leaseFromApplication, buildPacket, startSignatureRequest, recordSignature, activateLease,
  createRenewalOffer, renewalMatrix, ensureLeaseTemplates, templateFor,
} from './service.ts';
import { registerLeaseTab, registerLeaseAction } from '../people/pages.ts';
import { registerDashboardExtras } from '../m2_portfolio/pages.ts';

registerNav('Residents', { href: '/renewals', label: 'Renewals', perm: 'renewals:view' });
registerNav('Admin', { href: '/admin/lease-templates', label: 'Lease templates', perm: 'admin:settings' });

registerDashboardExtras((ctx, propertyId) => {
  const propSql = propertyId ? ' AND property_id=?' : '';
  const p = propertyId ? [propertyId] : [];
  const in90 = val<number>(
    `SELECT COUNT(*) FROM leases WHERE org_id=? AND status='active' AND end_date BETWEEN ? AND ?${propSql}`,
    ctx.orgId, ctx.businessDate, addDays(ctx.businessDate, 90), ...p,
  ) || 0;
  return { kpis: [{ label: 'Expiring ≤90d', value: in90, href: '/renewals', tone: in90 > 20 ? 'warn' : undefined }], panels: null };
});

export function routes(r: Router): void {
  // ---------- generate lease from an approved application ----------
  r.post('/applications/:id/generate-lease', requirePerm('leases:manage'), async (rq) => {
    const ctx = rq.ctx as Ctx;
    let leaseId: string;
    try {
      leaseId = leaseFromApplication(ctx, rq.params.id!);
    } catch (e) {
      return redirect(`/applications/${rq.params.id}`, (e as Error).message, 'err');
    }
    return redirect(`/leases/${leaseId}`, 'Lease drafted from the application — review it, then send for signature.');
  });

  // ---------- send packet for signature ----------
  r.post('/leases/:id/send-for-signature', requirePerm('leases:manage'), async (rq) => {
    const ctx = rq.ctx as Ctx;
    const lease = q1<any>('SELECT * FROM leases WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!lease) return notFound();
    if (!['draft'].includes(lease.status)) return redirect(`/leases/${lease.id}`, 'Lease already out for signature.', 'err');
    const packet = await buildPacket(ctx, lease.id);
    // signers: adults (from application or household) + guarantors + PM countersigner
    let adults: { name: string; email: string; role: 'resident' | 'guarantor' }[] = [];
    if (lease.application_id) {
      adults = q<any>(`SELECT first_name, last_name, email, kind FROM applicants WHERE application_id=? AND kind IN ('primary','co','guarantor') AND email IS NOT NULL`, lease.application_id)
        .map((a) => ({ name: `${a.first_name} ${a.last_name}`.trim() || a.email, email: a.email, role: a.kind === 'guarantor' ? 'guarantor' : 'resident' }));
    } else {
      adults = q<any>(
        `SELECT r.first_name, r.last_name, r.email, hm.role FROM household_members hm JOIN residents r ON r.id=hm.resident_id
         WHERE hm.lease_id=? AND hm.role IN ('primary','co','guarantor') AND r.email IS NOT NULL`,
        lease.id,
      ).map((x) => ({ name: `${x.first_name} ${x.last_name}`, email: x.email, role: x.role === 'guarantor' ? 'guarantor' : 'resident' }));
    }
    if (!adults.length) return redirect(`/leases/${lease.id}`, 'No signers with email addresses found.', 'err');
    const base = `http://${String(rq.raw.headers.host || 'localhost:3000')}`;
    startSignatureRequest(ctx, lease.id, lease.renewal_of_lease_id ? 'renewal' : 'lease', packet, [
      ...adults,
      { name: ctx.userName, email: ctx.userEmail, role: 'countersigner' },
    ], base);
    return redirect(`/leases/${lease.id}?tab=esign`, `Packet sent to ${adults.length} signer${adults.length === 1 ? '' : 's'} — you countersign last.`);
  });

  r.post('/leases/:id/activate', requirePerm('leases:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    try {
      activateLease(ctx, rq.params.id!);
    } catch (e) {
      return redirect(`/leases/${rq.params.id}`, (e as Error).message, 'err');
    }
    return redirect(`/leases/${rq.params.id}`, 'Lease activated — unit occupied, ledger started, portal accounts ready.');
  });

  // ---------- public signing ceremony ----------
  r.get('/sign/:token', (rq) => {
    const signer = q1<any>('SELECT * FROM signature_signers WHERE token=?', rq.params.token!);
    if (!signer) return notFound('Signing link not found');
    const req = q1<any>('SELECT * FROM signature_requests WHERE id=?', signer.request_id);
    const lease = q1<any>(
      `SELECT l.*, u.unit_number, p.name AS prop_name FROM leases l JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=l.property_id WHERE l.id=?`,
      req.lease_id,
    );
    const others = q<any>('SELECT name, role, status FROM signature_signers WHERE request_id=? ORDER BY order_idx', req.id);
    const flash = takeFlash(rq);
    const waitingOnOthers = signer.role === 'countersigner' &&
      others.some((o) => o.role !== 'countersigner' && o.status !== 'signed');
    const body = html`<div class="portal" style="max-width:640px">
      <div class="portal-top"><div class="pt-brand">${logo(20, '#4653e5')} ${lease.prop_name}</div></div>
      ${when(flash, () => html`<div class="flash ${flash![0]}">${flash![1]}</div>`)}
      <h1>${req.kind === 'renewal' ? 'Sign your renewal' : 'Sign your lease'}</h1>
      <div class="card"><div class="card-body">
        <div class="dl">
          <dt>Home</dt><dd>Unit ${lease.unit_number} · ${lease.prop_name}</dd>
          <dt>Term</dt><dd>${fmtDate(lease.start_date)} → ${fmtDate(lease.end_date)} · ${usd(lease.rent_cents)}/mo</dd>
          <dt>Document</dt><dd><a href="/sign/${signer.token}/packet" target="_blank">📄 Review the full packet (PDF)</a></dd>
          <dt>Fingerprint</dt><dd><code class="small">${req.doc_sha256.slice(0, 24)}…</code></dd>
        </div>
        <div style="margin:10px 0">${join(others.map((o) => html`<span class="badge ${o.status === 'signed' ? 'ok' : ''}" style="margin-right:6px">${o.name} · ${o.status}</span>`))}</div>
      </div></div>
      ${when(signer.status === 'signed', () => html`<div class="callout" style="border-color:var(--ok)">You signed ${fmtTs(signer.signed_at)}. ${req.status === 'completed' ? 'The lease is fully executed — the final document is in your portal.' : 'Waiting on the remaining signers.'}</div>`)}
      ${when(signer.status !== 'signed' && req.status === 'out' && waitingOnOthers, () => html`<div class="callout info">Residents sign first — you'll countersign once everyone else has finished.</div>`)}
      ${when(signer.status !== 'signed' && req.status === 'out' && !waitingOnOthers, () => html`
        <div class="card"><div class="card-body">
          <form method="post" action="/sign/${signer.token}">
            <div class="field"><label>Sign as</label>
              <select name="kind" data-autosubmit-ignore>
                <option value="typed">Type my signature</option>
                <option value="drawn">Draw my signature</option>
              </select>
            </div>
            <div class="field"><label>Typed signature</label><input name="text" value="${signer.name}" class="sig-preview" /></div>
            <div class="field"><label>Or draw it</label>
              <canvas class="sigpad" id="sig" data-target="#sig-data"></canvas>
              <input type="hidden" name="pngDataUrl" id="sig-data" />
              <button class="btn btn-ghost btn-sm" type="button" data-sig-clear="sig" style="margin-top:6px">Clear</button>
            </div>
            <div class="field"><label>Initials</label><input name="initials" required maxlength="4" style="width:90px" value="${signer.name.split(' ').map((x: string) => x[0]).join('')}" /></div>
            <label class="check"><input type="checkbox" name="agree" required /> <span>I have reviewed the packet and agree to sign electronically. My e-signature is as binding as ink.</span></label>
            <button class="btn" style="width:100%;justify-content:center">${signer.role === 'countersigner' ? 'Countersign & execute' : 'Sign the lease'}</button>
          </form>
        </div></div>`)}
    </div>`;
    return htmlRes(doc('Sign', body));
  });

  r.get('/sign/:token/packet', (rq) => {
    const signer = q1<any>('SELECT * FROM signature_signers WHERE token=?', rq.params.token!);
    if (!signer) return notFound();
    const req = q1<any>('SELECT * FROM signature_requests WHERE id=?', signer.request_id);
    const f = getFile(req.signed_file_id || req.doc_file_id);
    if (!f) return notFound('packet missing');
    return { status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="lease-packet.pdf"' }, body: f.data };
  });

  r.post('/sign/:token', (rq) => {
    const signer = q1<any>('SELECT * FROM signature_signers WHERE token=?', rq.params.token!);
    if (!signer) return notFound();
    const ctx = sysCtx(signer.org_id);
    const drawn = String(rq.body.pngDataUrl || '');
    try {
      const out = recordSignature(ctx, rq.params.token!, {
        kind: drawn.startsWith('data:image/png') && drawn.length > 200 ? 'drawn' : 'typed',
        text: String(rq.body.text || signer.name),
        pngDataUrl: drawn,
        initials: String(rq.body.initials || '').toUpperCase().slice(0, 4),
      });
      return redirect(`/sign/${rq.params.token}`, out.complete ? '🎉 Fully executed! The final signed packet with its completion certificate is being filed.' : 'Signed — thank you!');
    } catch (e) {
      return redirect(`/sign/${rq.params.token}`, (e as Error).message, 'err');
    }
  });

  // ---------- renewals board ----------
  r.get('/renewals', requirePerm('renewals:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const pf = propFilter(ctx, 'l.property_id');
    const horizon = (days: number, minDays: number): any[] =>
      q<any>(
        `SELECT l.*, u.unit_number, p.name AS prop_name,
          (SELECT ro.status FROM renewal_offers ro WHERE ro.lease_id=l.id ORDER BY ro.created_at DESC LIMIT 1) AS offer_status,
          (SELECT ro.id FROM renewal_offers ro WHERE ro.lease_id=l.id ORDER BY ro.created_at DESC LIMIT 1) AS offer_id
         FROM leases l JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=l.property_id
         WHERE l.org_id=? AND l.status='active' AND l.end_date BETWEEN ? AND ?${pf.sql}
         ORDER BY l.end_date`,
        ctx.orgId, addDays(ctx.businessDate, minDays), addDays(ctx.businessDate, days), ...pf.params,
      );
    const b30 = horizon(30, 0);
    const b60 = horizon(60, 31);
    const b90 = horizon(90, 61);
    const mtm = q<any>(
      `SELECT l.*, u.unit_number, p.name AS prop_name FROM leases l JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=l.property_id
       WHERE l.org_id=? AND l.status='month_to_month'${pf.sql} ORDER BY l.mtm_since LIMIT 20`,
      ctx.orgId, ...pf.params,
    );
    const recent = q<any>(
      `SELECT ro.*, l.household_name, u.unit_number FROM renewal_offers ro JOIN leases l ON l.id=ro.lease_id JOIN units u ON u.id=l.unit_id
       WHERE ro.org_id=? ORDER BY ro.created_at DESC LIMIT 12`,
      ctx.orgId,
    );
    const bucket = (title: string, rows: any[], urgent: boolean): Child =>
      card(html`${title} <span class="badge ${urgent && rows.length ? 'warn' : ''}">${rows.length}</span>`, tbl(
        [{ label: 'Household' }, { label: 'Unit' }, { label: 'Ends' }, { label: 'Current rent', num: true }, { label: 'Offer' }, { label: '' }],
        rows.map((l) => ({
          href: `/leases/${l.id}`,
          cells: [
            html`<b>${l.household_name}</b><span class="sub">${l.prop_name}</span>`, l.unit_number,
            html`${fmtDate(l.end_date)} <span class="muted small">(${diffDays(l.end_date, ctx.businessDate)}d)</span>`,
            usd(l.rent_cents),
            l.offer_status ? statusBadge(l.offer_status) : statusBadge(undefined, 'none'),
            !l.offer_status || l.offer_status === 'expired'
              ? html`<div style="display:flex;gap:4px">
                  <form method="post" action="/renewals/${l.id}/offer"><button class="btn btn-sm">Send offer</button></form>
                  <form method="post" action="/ai/renewals/${l.id}/draft"><button class="btn btn-sm btn-ghost" title="Renewals AI drafts personalized outreach from their history">✨ AI</button></form>
                </div>`
              : '',
          ],
        })),
        { empty: 'Nothing in this bucket.' },
      ), { flush: true });
    return shell(rq, {
      title: 'Renewals pipeline',
      active: '/renewals',
      subtitle: 'Expirations in 30/60/90-day buckets. Offers use the pricing matrix (M13 refines it) within org caps.',
      actions: html`<form method="post" action="/renewals/batch" data-confirm="Send offers to every 60–90 day expiration without one?"><button class="btn">Batch: offer the 60–90d bucket</button></form>`,
      content: html`
        ${bucket('Expiring in 0–30 days', b30, true)}
        ${bucket('31–60 days', b60, false)}
        ${bucket('61–90 days', b90, false)}
        ${when(mtm.length, () => card('Month-to-month holdovers (premium billing)', tbl(
          [{ label: 'Household' }, { label: 'Unit' }, { label: 'MTM since' }, { label: 'Rent + premium', num: true }, { label: '' }],
          mtm.map((l) => ({
            href: `/leases/${l.id}`,
            cells: [l.household_name, l.unit_number, fmtDate(l.mtm_since), usd(Math.round(l.rent_cents * 1.15)),
              html`<form method="post" action="/renewals/${l.id}/offer"><button class="btn btn-sm btn-ghost">Offer renewal</button></form>`],
          })),
        ), { flush: true }))}
        ${card('Recent offers', tbl(
          [{ label: 'Household' }, { label: 'Unit' }, { label: 'Sent' }, { label: 'Status' }, { label: 'Accepted' }],
          recent.map((ro) => ({
            href: `/leases/${ro.lease_id}`,
            cells: [ro.household_name, ro.unit_number, fmtDate(ro.created_at.slice(0, 10)), statusBadge(ro.status),
              ro.accepted_term ? `${ro.accepted_term} mo @ ${usd(ro.accepted_rent_cents)}` : '—'],
          })),
          { empty: 'No offers yet.' },
        ), { flush: true })}`,
    });
  });

  r.post('/renewals/:leaseId/offer', requirePerm('renewals:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    try {
      createRenewalOffer(ctx, rq.params.leaseId!);
    } catch (e) {
      return redirect('/renewals', (e as Error).message, 'err');
    }
    return redirect('/renewals', 'Offer sent — the resident sees it in their portal and email.');
  });

  r.post('/renewals/batch', requirePerm('renewals:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const pf = propFilter(ctx, 'l.property_id');
    const targets = q<any>(
      `SELECT l.id FROM leases l WHERE l.org_id=? AND l.status='active' AND l.end_date BETWEEN ? AND ?${pf.sql}
       AND NOT EXISTS (SELECT 1 FROM renewal_offers ro WHERE ro.lease_id=l.id AND ro.status IN ('sent','accepted','countered'))`,
      ctx.orgId, addDays(ctx.businessDate, 60), addDays(ctx.businessDate, 90), ...pf.params,
    );
    for (const t of targets) createRenewalOffer(ctx, t.id);
    return redirect('/renewals', `${targets.length} offers sent.`);
  });

  // ---------- lease template designer ----------
  r.get('/admin/lease-templates', requirePerm('admin:settings'), (rq) => {
    const ctx = rq.ctx as Ctx;
    ensureLeaseTemplates(ctx.orgId);
    const templates = q<any>('SELECT * FROM lease_templates WHERE org_id=? ORDER BY property_id, version DESC', ctx.orgId);
    const addenda = q<any>('SELECT * FROM addenda_library WHERE org_id=? ORDER BY sort', ctx.orgId);
    const editing = rq.query.get('edit');
    const tpl = editing ? templates.find((t) => t.id === editing) : templates[0];
    return shell(rq, {
      title: 'Lease templates',
      active: '/admin/lease-templates',
      subtitle: 'Versioned templates with merge fields; addenda attach conditionally (pet, parking, guarantor, student…). Saving creates a new version.',
      content: html`
        <div class="grid cols-2">
          ${card('Templates', tbl(
            [{ label: 'Name' }, { label: 'Scope' }, { label: 'Version', num: true }, { label: '' }],
            templates.map((t) => ({
              cells: [html`<b>${t.name}</b>`, t.property_id ? val<string>('SELECT name FROM properties WHERE id=?', t.property_id) : 'Org default', `v${t.version}`,
                html`<a class="btn btn-sm btn-ghost" href="/admin/lease-templates?edit=${t.id}">Edit</a>`],
            })),
          ), { flush: true })}
          ${card('Addenda library', tbl(
            [{ label: 'Addendum' }, { label: 'Attaches when' }],
            addenda.map((a) => ({ cells: [html`<b>${a.title}</b>`, statusBadge(undefined, a.condition_key || 'manual')] })),
          ), { flush: true })}
        </div>
        ${when(tpl, () => card(`Edit: ${tpl.name} (saving creates v${tpl.version + 1})`, html`
          <form method="post" action="/admin/lease-templates/${tpl.id}">
            ${field('Body — merge fields: {{landlord}} {{household_names}} {{property_name}} {{unit_number}} {{property_address}} {{start_date}} {{end_date}} {{term_months}} {{rent}} {{deposit}}',
              textarea('body', { value: tpl.body, rows: 18 }))}
            <button class="btn">Save as v${tpl.version + 1}</button>
          </form>`))}`,
    });
  });

  r.post('/admin/lease-templates/:id', requirePerm('admin:settings'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const tpl = q1<any>('SELECT * FROM lease_templates WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!tpl) return notFound();
    run('UPDATE lease_templates SET active=0 WHERE id=?', tpl.id);
    insert('lease_templates', {
      id: id('ltp'), org_id: ctx.orgId, property_id: tpl.property_id, state: tpl.state, name: tpl.name,
      version: tpl.version + 1, body: String(rq.body.body || tpl.body), active: 1, created_at: nowIso(),
    });
    audit(ctx, 'lease_template', tpl.name, 'new_version', { version: tpl.version }, { version: tpl.version + 1 });
    return redirect('/admin/lease-templates', `Saved as version ${tpl.version + 1}.`);
  });
}

// ---------- lease page integrations ----------

registerLeaseTab((ctx, lease) => {
  const req = lease.esign_request_id ? q1<any>('SELECT * FROM signature_requests WHERE id=?', lease.esign_request_id) : null;
  if (!req && !['draft', 'out_for_signature', 'partially_signed', 'fully_executed'].includes(lease.status)) return null;
  return {
    key: 'esign',
    label: 'E-sign',
    render: () => {
      const signers = req ? q<any>('SELECT * FROM signature_signers WHERE request_id=? ORDER BY order_idx', req.id) : [];
      const events = req ? j<any[]>(req.events, []) : [];
      return html`
        ${when(!req && lease.status === 'draft', () => card('Ready to send', html`
          <p class="small muted">Generates the packet PDF (template + merge fields + charge schedule + conditional addenda), then emails per-signer secure links. You countersign last; completion produces the executed PDF with a SHA-256 certificate.</p>
          <form method="post" action="/leases/${lease.id}/send-for-signature"><button class="btn">Build packet & send for signature</button></form>`))}
        ${when(req, () => html`
          ${card(html`Signature request ${statusBadge(req.status)}`, html`
            ${dl([
              ['Packet', html`<a href="/f/${req.signed_file_id || req.doc_file_id}" target="_blank">📄 ${req.signed_file_id ? 'Executed packet (signed)' : 'Unsigned packet'}</a>`],
              ['SHA-256', html`<code class="small">${req.doc_sha256}</code>`],
              ['Sent', fmtTs(req.created_at)],
              ...(req.completed_at ? [['Completed', fmtTs(req.completed_at)] as [Child, Child]] : []),
            ])}
            ${tbl(
              [{ label: 'Signer' }, { label: 'Role' }, { label: 'Status' }, { label: 'Signed' }, { label: 'Link' }],
              signers.map((s) => ({
                cells: [html`<b>${s.name}</b><span class="sub">${s.email}</span>`, statusBadge(undefined, s.role), statusBadge(s.status),
                  s.signed_at ? fmtTs(s.signed_at) : '—',
                  s.status === 'pending' ? html`<a class="small" href="/sign/${s.token}" target="_blank">open signing page ↗</a>` : '—'],
              })),
            )}`)}
          ${card('Tamper-evident event trail', html`<ul class="timeline">${events.map((e) => html`<li><div><b>${e.action}</b> <span class="muted small">· ${e.who}</span></div><div class="t-when">${e.at?.slice(0, 19).replace('T', ' ')} · <code class="small">${String(e.hash || '').slice(0, 18)}…</code></div></li>`)}</ul>`)}`)}
        ${when(lease.status === 'fully_executed', () => card('Activation', html`
          <p class="small">Move-in ${fmtDate(lease.start_date)} — the scheduler activates automatically on that business day, or activate now:</p>
          <form method="post" action="/leases/${lease.id}/activate"><button class="btn">Activate lease now</button></form>`))}`;
    },
  };
});

registerLeaseAction((ctx, lease) => {
  if (lease.status === 'draft' && ctx.perms.has('leases:manage')) {
    return html`<form method="post" action="/leases/${lease.id}/send-for-signature"><button class="btn">Send for signature</button></form>`;
  }
  return null;
});



// ---------- resident portal: renewal acceptance + checklist ----------

import { requireResident } from '../../lib/auth.ts';
import { portalCtx } from '../m7_portal/pages.ts';
import { acceptRenewal } from './service.ts';

export function portalRoutes(r: Router): void {
  r.post('/portal/renewal/:offerId/accept', requireResident, (rq) => {
    const pc = portalCtx(rq);
    if (!pc) return notFound();
    const offer = q1<any>('SELECT * FROM renewal_offers WHERE id=? AND lease_id=?', rq.params.offerId!, pc.lease.id);
    if (!offer) return notFound('Offer not found');
    const base = `http://${String(rq.raw.headers.host || 'localhost:3000')}`;
    try {
      acceptRenewal(pc.ctx, offer.id, parseInt(String(rq.body.term || '12'), 10), base);
    } catch (e) {
      return redirect('/portal', (e as Error).message, 'err');
    }
    return redirect('/portal', '🎉 Renewal accepted! Check your email — your renewal packet is ready to sign.');
  });

  r.post('/portal/renewal/:offerId/counter', requireResident, (rq) => {
    const pc = portalCtx(rq);
    if (!pc) return notFound();
    const offer = q1<any>('SELECT * FROM renewal_offers WHERE id=? AND lease_id=?', rq.params.offerId!, pc.lease.id);
    if (!offer) return notFound();
    run(`UPDATE renewal_offers SET status='countered', counter_note=? WHERE id=?`, String(rq.body.note || ''), offer.id);
    return redirect('/portal', 'Sent to the leasing team — they will get back to you.');
  });

  r.post('/portal/checklist/:id/toggle', requireResident, (rq) => {
    const pc = portalCtx(rq);
    if (!pc) return notFound();
    const checklist = q1<any>('SELECT * FROM move_checklists WHERE id=? AND lease_id=?', rq.params.id!, pc.lease.id);
    if (!checklist) return notFound();
    const items = j<any[]>(checklist.items, []);
    const item = items.find((x) => x.key === String(rq.body.key));
    if (item && item.who === 'resident') item.done = true;
    run('UPDATE move_checklists SET items=? WHERE id=?', js(items), checklist.id);
    return redirect('/portal/lease', 'Checked off — nice progress!');
  });
}
