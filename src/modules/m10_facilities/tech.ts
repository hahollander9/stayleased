import { html, raw, when, join } from '../../lib/html.ts';
import { redirect, notFound, htmlRes, type Router, type Rq, type Res } from '../../lib/http.ts';
import { requirePerm, requireVendor, type Ctx } from '../../lib/auth.ts';
import { q, q1, run, insert } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, fmtDate } from '../../lib/dates.ts';
import { usd } from '../../lib/money.ts';
import { v } from '../../lib/validate.ts';
import { putFile } from '../../lib/files.ts';
import { doc, card, dl, statusBadge, field, input, select, textarea, emptyState, logo } from '../../ui/ui.ts';
import { takeFlash } from '../../lib/http.ts';
import { transitionWo, woEvent, logMaterial, logLabor } from './service.ts';

/** M10.2 tech mobile "My Day" (SiteTablet-style) + M10.8 vendor work view.
 * Phone-width optimized; plain-form flows tolerate flaky connectivity (each
 * action is a single POST; drafts live in the browser until submitted). */

import type { Child } from '../../lib/html.ts';
export function techShell(rq: Rq, title: string, content: Child, back?: string): Res {
  const flash = takeFlash(rq);
  const body = html`<div class="portal">
    <div class="portal-top">
      <div class="pt-brand">${logo(20, '#4653e5')} My Day</div>
      <div class="spacer"></div>
      <a class="chip" href="/">Full app</a>
      <form method="post" action="/logout"><button class="chip" type="submit">Sign out</button></form>
    </div>
    ${when(back, () => html`<div style="margin-bottom:8px"><a href="${back}" class="small">← Back to queue</a></div>`)}
    ${when(flash, () => html`<div class="flash ${flash![0]}">${flash![1]}</div>`)}
    <h1 style="margin-bottom:12px">${title}</h1>
    ${content}
  </div>`;
  return htmlRes(doc(title, body));
}

export function routes(r: Router): void {
  // ---------- tech: my day ----------
  r.get('/myday', requirePerm('workorders:work'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const today = q<any>(
      `SELECT w.*, u.unit_number, p.name AS prop_name, l.household_name
       FROM work_orders w LEFT JOIN units u ON u.id=w.unit_id JOIN properties p ON p.id=w.property_id LEFT JOIN leases l ON l.id=w.lease_id
       WHERE w.org_id=? AND w.assigned_to_user_id=? AND w.status NOT IN ('completed','canceled')
       ORDER BY CASE w.priority WHEN 'emergency' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
                COALESCE(w.scheduled_date, w.sla_due, '9999') `,
      ctx.orgId, ctx.userId,
    );
    const scheduled = today.filter((w) => w.scheduled_date && w.scheduled_date <= ctx.businessDate);
    const rest = today.filter((w) => !scheduled.includes(w));
    const doneToday = q<any>(
      `SELECT COUNT(*) n FROM work_orders WHERE org_id=? AND assigned_to_user_id=? AND completed_date=?`,
      ctx.orgId, ctx.userId, ctx.businessDate,
    );
    const item = (w: any) => html`<a class="list-item" href="/myday/${w.id}">
      <div class="li-main">
        <div class="li-title">${w.priority === 'emergency' ? '🚨 ' : ''}${w.summary}</div>
        <div class="li-sub">${w.unit_number ? `Unit ${w.unit_number}` : w.prop_name}${w.household_name ? ` · ${w.household_name}` : ''}${w.permission_to_enter ? '' : ' · ⚠ must be home'}${w.pet_on_premises ? ' · 🐾 pet' : ''}</div>
      </div>
      ${statusBadge(w.status)}
    </a>`;
    return techShell(rq, `${fmtDate(ctx.businessDate)} — ${today.length} open`, html`
      ${when(scheduled.length, () => card('Due today', join(scheduled.map(item))))}
      ${card(scheduled.length ? 'Everything else assigned to me' : 'My queue', rest.length || scheduled.length ? join(rest.map(item)) : emptyState('Queue is clear', 'Nice work. New assignments appear here.'))}
      <p class="small muted center">${doneToday[0]?.n || 0} completed today</p>`);
  });

  r.get('/myday/:id', requirePerm('workorders:work'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const w = q1<any>(
      `SELECT w.*, u.unit_number, p.name AS prop_name, l.household_name
       FROM work_orders w LEFT JOIN units u ON u.id=w.unit_id JOIN properties p ON p.id=w.property_id LEFT JOIN leases l ON l.id=w.lease_id
       WHERE w.id=? AND w.org_id=?`,
      rq.params.id!, ctx.orgId,
    );
    if (!w) return notFound('Work order not found');
    const events = q<any>('SELECT * FROM wo_events WHERE work_order_id=? ORDER BY at DESC LIMIT 8', w.id);
    const items = q<any>(`SELECT * FROM inventory_items WHERE org_id=? AND property_id=? AND on_hand>0 ORDER BY name`, ctx.orgId, w.property_id);
    const photos = q<any>(`SELECT * FROM files WHERE entity='work_order' AND entity_id=?`, w.id);
    const canStart = ['assigned', 'scheduled', 'reopened', 'on_hold'].includes(w.status);
    return techShell(rq, w.summary, html`
      ${card(html`${statusBadge(w.priority)} ${statusBadge(w.status)}`, dl([
        ['Where', `${w.unit_number ? `Unit ${w.unit_number} · ` : ''}${w.prop_name}`],
        ['Entry', w.permission_to_enter ? 'Permission to enter ✓' : '⚠ Resident must be home'],
        ['Pet', w.pet_on_premises ? '🐾 Pet at home' : 'No pet'],
        ['Preferred times', w.preferred_times || 'Any'],
        ['Details', w.description || '—'],
      ]))}
      ${when(photos.length, () => card('Photos', html`<div style="display:flex;gap:8px;flex-wrap:wrap">${photos.map((p) => html`<a href="/f/${p.id}" target="_blank"><img src="/f/${p.id}" style="width:84px;height:84px;object-fit:cover;border-radius:8px;border:1px solid var(--line)" alt="${p.name}" /></a>`)}</div>`))}

      ${when(canStart, () => html`<form method="post" action="/myday/${w.id}/start"><button class="btn" style="width:100%;justify-content:center;margin-bottom:12px">▶ Start work</button></form>`)}

      ${when(w.status === 'in_progress', () => html`
        ${card('Log as you go', html`
          <form method="post" action="/myday/${w.id}/material" class="toolbar">
            ${field('Material', select('item_id', items.map((x): [string, string] => [x.id, `${x.name} (${x.on_hand})`]), undefined, { blank: 'pick stock…' }))}
            ${field('Qty', input('qty', { type: 'number', value: 1, step: '0.5' }))}
            <button class="btn btn-sm btn-ghost">Add</button>
          </form>
          <form method="post" action="/myday/${w.id}/labor" class="toolbar">
            ${field('My time (hours)', input('hours', { type: 'number', value: 1, step: '0.25' }))}
            <button class="btn btn-sm btn-ghost">Log time</button>
          </form>
          <form method="post" action="/myday/${w.id}/photo" enctype="multipart/form-data" class="toolbar">
            ${field('Photo', raw('<input type="file" name="photo" accept="image/*" capture="environment" />'))}
            <button class="btn btn-sm btn-ghost">Upload</button>
          </form>
          <form method="post" action="/myday/${w.id}/note" class="toolbar">
            ${field('Note', input('body', { placeholder: 'Replaced trap; tested.' }))}
            <button class="btn btn-sm btn-ghost">Add note</button>
          </form>`)}
        ${card('Complete', html`<form method="post" action="/myday/${w.id}/complete">
          ${field('Completion note (resident sees this)', textarea('note', { rows: 2, placeholder: 'Cleared drain blockage, ran dishwasher full cycle — draining normally.' }))}
          <label class="check"><span>Resident signature (or tech attestation)</span></label>
          <canvas class="sigpad" id="sig" data-target="#sig-data"></canvas>
          <input type="hidden" name="signature" id="sig-data" />
          <div class="btn-row">
            <button class="btn" style="flex:1;justify-content:center">✓ Complete work order</button>
            <button class="btn btn-ghost" type="button" data-sig-clear="sig">Clear</button>
          </div>
        </form>`)}`)}

      ${card('Recent activity', html`<ul class="timeline">${events.map((e) => html`<li><div><b>${e.body || e.kind}</b></div><div class="t-when">${(e.business_date || e.at).slice(0, 10)}</div></li>`)}</ul>`)}`,
      '/myday');
  });

  r.post('/myday/:id/start', requirePerm('workorders:work'), (rq) => {
    const ctx = rq.ctx as Ctx;
    try {
      transitionWo(ctx, rq.params.id!, 'in_progress', 'Work started on site');
    } catch (e) {
      return redirect(`/myday/${rq.params.id}`, (e as Error).message, 'err');
    }
    return redirect(`/myday/${rq.params.id}`, 'Marked in progress.');
  });

  r.post('/myday/:id/material', requirePerm('workorders:work'), (rq) => {
    const ctx = rq.ctx as Ctx;
    if (!rq.body.item_id) return redirect(`/myday/${rq.params.id}`, 'Pick a stock item.', 'err');
    logMaterial(ctx, rq.params.id!, { itemId: String(rq.body.item_id), qty: v.number({ min: 0.1 }).parse(rq.body.qty || 1) });
    return redirect(`/myday/${rq.params.id}`, 'Material logged.');
  });

  r.post('/myday/:id/labor', requirePerm('workorders:work'), (rq) => {
    const ctx = rq.ctx as Ctx;
    logLabor(ctx, rq.params.id!, { userId: ctx.userId, hours: v.number({ min: 0.25, max: 24 }).parse(rq.body.hours || 1) });
    return redirect(`/myday/${rq.params.id}`, 'Time logged.');
  });

  r.post('/myday/:id/photo', requirePerm('workorders:work'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const up = rq.uploads.find((u) => u.field === 'photo' && u.data.length > 0);
    if (!up) return redirect(`/myday/${rq.params.id}`, 'No photo attached.', 'err');
    putFile(ctx, up.data, { name: up.filename || 'photo.jpg', mime: up.mime, entity: 'work_order', entityId: rq.params.id!, visibility: 'resident' });
    woEvent(ctx, rq.params.id!, 'photo', `Photo added: ${up.filename}`);
    return redirect(`/myday/${rq.params.id}`, 'Photo uploaded.');
  });

  r.post('/myday/:id/note', requirePerm('workorders:work'), (rq) => {
    const ctx = rq.ctx as Ctx;
    woEvent(ctx, rq.params.id!, 'note', String(rq.body.body || ''));
    return redirect(`/myday/${rq.params.id}`, 'Note added.');
  });

  r.post('/myday/:id/complete', requirePerm('workorders:work'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const sig = String(rq.body.signature || '');
    if (sig.startsWith('data:image/png')) {
      const data = Buffer.from(sig.split(',')[1] || '', 'base64');
      if (data.length > 100) {
        const f = putFile(ctx, data, { name: 'completion-signature.png', mime: 'image/png', entity: 'work_order', entityId: rq.params.id!, visibility: 'staff' });
        woEvent(ctx, rq.params.id!, 'photo', 'Completion signature captured', { meta: JSON.stringify({ fileId: f.id }), residentVisible: false });
      }
    }
    if (rq.body.note) woEvent(ctx, rq.params.id!, 'note', String(rq.body.note));
    try {
      transitionWo(ctx, rq.params.id!, 'completed');
    } catch (e) {
      return redirect(`/myday/${rq.params.id}`, (e as Error).message, 'err');
    }
    return redirect('/myday', 'Completed — nice work. Resident will be asked to rate it.');
  });

  // ---------- vendor portal (assignments only; invoices arrive with M16) ----------
  r.get('/vendor', requireVendor, (rq) => {
    const ctx = rq.ctx as Ctx;
    const vendor = q1<any>('SELECT * FROM vendors WHERE id=? AND org_id=?', ctx.vendorId || '', ctx.orgId);
    if (!vendor) {
      return techShell(rq, 'Vendor portal', emptyState('No vendor profile linked', 'Ask the property management company to link your login to a vendor record.'));
    }
    const wos = q<any>(
      `SELECT w.*, u.unit_number, p.name AS prop_name FROM work_orders w LEFT JOIN units u ON u.id=w.unit_id JOIN properties p ON p.id=w.property_id
       WHERE w.vendor_id=? ORDER BY CASE WHEN w.status IN ('completed','canceled') THEN 1 ELSE 0 END, w.created_date DESC LIMIT 30`,
      vendor.id,
    );
    const expired = vendor.coi_expiry && vendor.coi_expiry < ctx.businessDate;
    return techShell(rq, vendor.name, html`
      ${when(expired, () => html`<div class="callout bad"><b>Your insurance certificate expired ${fmtDate(vendor.coi_expiry)}.</b> Send an updated COI to keep receiving work.</div>`)}
      ${card('My assignments', wos.length ? join(wos.map((w) => html`<a class="list-item" href="/vendor/wo/${w.id}">
        <div class="li-main"><div class="li-title">${w.summary}</div><div class="li-sub">${w.prop_name}${w.unit_number ? ` · Unit ${w.unit_number}` : ''} · ${fmtDate(w.created_date)}</div></div>
        ${statusBadge(w.status)}
      </a>`)) : emptyState('No assignments yet'))}`);
  });

  r.get('/vendor/wo/:id', requireVendor, (rq) => {
    const ctx = rq.ctx as Ctx;
    const w = q1<any>(
      `SELECT w.*, u.unit_number, p.name AS prop_name FROM work_orders w LEFT JOIN units u ON u.id=w.unit_id JOIN properties p ON p.id=w.property_id
       WHERE w.id=? AND w.vendor_id=?`,
      rq.params.id!, ctx.vendorId || '',
    );
    if (!w) return notFound('Assignment not found');
    return techShell(rq, w.summary, html`
      ${card(html`${statusBadge(w.status)}`, dl([
        ['Where', `${w.unit_number ? `Unit ${w.unit_number} · ` : ''}${w.prop_name}`],
        ['Details', w.description || '—'],
        ['Entry', w.permission_to_enter ? 'Permission to enter ✓' : 'Resident must be home'],
      ]))}
      ${when(!['completed', 'canceled'].includes(w.status), () => card('Complete this job', html`
        <form method="post" action="/vendor/wo/${w.id}/complete" enctype="multipart/form-data">
          ${field('Completion note', textarea('note', { rows: 2, required: true }))}
          ${field('Completion photo', raw('<input type="file" name="photo" accept="image/*" />'))}
          <p class="small muted">Vendor invoices are handled in Procure-to-Pay once the work is billed.</p>
          <button class="btn" style="width:100%;justify-content:center">Mark complete</button>
        </form>`))}`,
      '/vendor');
  });

  r.post('/vendor/wo/:id/complete', requireVendor, (rq) => {
    const ctx = rq.ctx as Ctx;
    const w = q1<any>('SELECT * FROM work_orders WHERE id=? AND vendor_id=?', rq.params.id!, ctx.vendorId || '');
    if (!w) return notFound();
    const up = rq.uploads.find((u) => u.field === 'photo' && u.data.length > 0);
    if (up) {
      putFile(ctx, up.data, { name: up.filename || 'vendor-photo.jpg', mime: up.mime, entity: 'work_order', entityId: w.id, visibility: 'staff' });
      woEvent(ctx, w.id, 'photo', `Vendor photo: ${up.filename}`);
    }
    woEvent(ctx, w.id, 'note', `Vendor: ${String(rq.body.note || 'work complete')}`);
    if (w.status !== 'in_progress') run("UPDATE work_orders SET status='in_progress' WHERE id=?", w.id);
    transitionWo(ctx, w.id, 'completed', 'Completed by vendor');
    return redirect('/vendor', 'Marked complete — the property team will review.');
  });
}
