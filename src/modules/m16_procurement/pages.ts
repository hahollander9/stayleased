import { html, when, join, type Child } from '../../lib/html.ts';
import { notFound, redirect, fileRes, type Router } from '../../lib/http.ts';
import { requirePerm, requireVendor, can, propFilter, type Ctx } from '../../lib/auth.ts';
import { q, q1, val, j } from '../../lib/db.ts';
import { fmtDate, fmtMonth } from '../../lib/dates.ts';
import { usd, parseUsd } from '../../lib/money.ts';
import { shell, card, tbl, dl, statusBadge, field, select, input, registerNav, kpis, tabs, emptyState, historyPanel } from '../../ui/ui.ts';
import { bars } from '../../lib/charts.ts';
import { getFile } from '../../lib/files.ts';
import {
  ensureCatalog, createPo, submitPo, approvePo, acknowledgePo, receivePo,
  ocrInvoiceFromPo, matchInvoice, decideMatchException, submitPoInvoice,
  remittanceAdvice, ten99Summary, ten99Pdf, spendAnalytics,
} from './service.ts';

/** M16 screens: PO pipeline + detail (approve/receive), match exception queue,
 * spend analytics + 1099, vendor portal procurement (ack, invoice, payments). */

registerNav('Operations', { href: '/purchasing', label: 'Purchasing', perm: 'pos:create', match: ['/purchasing'] });

function propsFor(ctx: Ctx): any[] {
  const pf = propFilter(ctx, 'id');
  return q<any>(`SELECT id, name FROM properties WHERE org_id=?${pf.sql} ORDER BY name`, ctx.orgId, ...pf.params);
}

export function routes(r: Router): void {
  // ---------- PO pipeline ----------
  r.get('/purchasing', requirePerm('pos:create'), (rq) => {
    const ctx = rq.ctx as Ctx;
    ensureCatalog(ctx.orgId);
    const status = rq.query.get('status') || 'open';
    const where = status === 'open' ? `('pending_approval','approved','acknowledged','partially_received')`
      : status === 'all' ? `('draft','pending_approval','approved','acknowledged','partially_received','received','closed','canceled')`
      : `('${status}')`;
    const pf = propFilter(ctx, 'po.property_id');
    const rows = q<any>(
      `SELECT po.*, v.name AS vendor, p.name AS property FROM purchase_orders po
       JOIN vendors v ON v.id=po.vendor_id JOIN properties p ON p.id=po.property_id
       WHERE po.org_id=? AND po.status IN ${where}${pf.sql} ORDER BY po.created_at DESC LIMIT 100`,
      ctx.orgId, ...pf.params,
    );
    const exceptions = val<number>(`SELECT COUNT(*) FROM invoice_matches WHERE org_id=? AND status='exception'`, ctx.orgId) || 0;
    const counts = (st: string): number => val<number>('SELECT COUNT(*) FROM purchase_orders WHERE org_id=? AND status=?', ctx.orgId, st) || 0;
    return shell(rq, {
      title: 'Purchasing',
      active: '/purchasing',
      subtitle: 'Purchase orders → vendor acknowledgment → receiving → 3-way matched invoices',
      actions: html`
        <a class="btn btn-ghost" href="/purchasing/exceptions">Match exceptions ${exceptions ? html`<span class="badge badge-warn">${exceptions}</span>` : ''}</a>
        <a class="btn btn-ghost" href="/purchasing/spend">Spend analytics</a>
        <a class="btn btn-ghost" href="/purchasing/1099">1099</a>
        <a class="btn" href="/purchasing/new">New PO</a>`,
      content: html`
        ${tabs([
          { href: '/purchasing?status=open', label: 'Open', active: status === 'open' },
          { href: '/purchasing?status=pending_approval', label: 'Needs approval', active: status === 'pending_approval', count: counts('pending_approval') },
          { href: '/purchasing?status=draft', label: 'Draft', active: status === 'draft', count: counts('draft') },
          { href: '/purchasing?status=received', label: 'Received', active: status === 'received' },
          { href: '/purchasing?status=all', label: 'All', active: status === 'all' },
        ])}
        ${card(null, tbl(
          [{ label: 'PO' }, { label: 'Vendor' }, { label: 'Property' }, { label: 'Needed by' }, { label: 'Status' }, { label: 'Received' }, { label: 'Total', num: true }],
          rows.map((po) => {
            const pct = val<number>(
              `SELECT CAST(SUM(received_qty * unit_price_cents) * 100 / NULLIF(SUM(qty * unit_price_cents),0) AS INTEGER) FROM purchase_order_lines WHERE po_id=?`, po.id,
            ) || 0;
            return {
              href: `/purchasing/${po.id}`,
              cells: [html`<span class="mono">${po.po_number}</span>`, po.vendor, po.property, po.needed_by ? fmtDate(po.needed_by) : '—', statusBadge(po.status), `${pct}%`, usd(po.total_cents)],
            };
          }),
          { empty: 'No purchase orders here.' },
        ), { flush: true })}`,
    });
  });

  // ---------- new PO ----------
  r.get('/purchasing/new', requirePerm('pos:create'), (rq) => {
    const ctx = rq.ctx as Ctx;
    ensureCatalog(ctx.orgId);
    const props = propsFor(ctx);
    const vendors = q<any>('SELECT id, name FROM vendors WHERE org_id=? AND active=1 ORDER BY name', ctx.orgId);
    const catalog = q<any>('SELECT * FROM catalog_items WHERE org_id=? AND active=1 ORDER BY category, name', ctx.orgId);
    const projects = q<any>(`SELECT id, name FROM capital_projects WHERE org_id=? AND status='active'`, ctx.orgId);
    const lineRow = (i: number): Child => html`
      <tr>
        <td>${select(`cat_${i}`, catalog.map((c: any): [string, string] => [c.id, `${c.name} — ${usd(c.unit_price_cents)}/${c.unit}`]), '', { blank: 'free-form' })}</td>
        <td>${input(`desc_${i}`, { placeholder: 'or describe it' })}</td>
        <td>${input(`qty_${i}`, { placeholder: 'qty' })}</td>
        <td>${input(`price_${i}`, { placeholder: 'unit $ (blank = catalog)' })}</td>
        <td>${select(`proj_${i}`, projects.map((p: any): [string, string] => [p.id, p.name]), '', { blank: '—' })}</td>
      </tr>`;
    return shell(rq, {
      title: 'New purchase order',
      active: '/purchasing',
      content: html`
        <form method="post" action="/purchasing/new">
          ${card('Order', html`
            <div class="grid2">
              ${field('Vendor', select('vendor_id', vendors.map((v: any): [string, string] => [v.id, v.name]), '', { required: true }))}
              ${field('Property', select('property_id', props.map((p): [string, string] => [p.id, p.name]), ctx.currentPropertyId || '', { required: true }))}
              ${field('Needed by', input('needed_by', { type: 'date' }))}
              ${field('Memo', input('memo', { placeholder: 'e.g. B-building turn materials' }))}
            </div>`)}
          ${card('Lines (catalog or free-form)', html`
            <table class="tbl"><thead><tr><th>Catalog item</th><th>Free-form description</th><th>Qty</th><th>Unit price</th><th>Capital project</th></tr></thead>
            <tbody>${join([0, 1, 2, 3].map(lineRow), '')}</tbody></table>
            <p class="small muted">Catalog lines carry their GL + inventory SKU; receiving restocks inventory automatically. POs over ${usd(100000)} route for approval.</p>`)}
          <button class="btn">Create & submit</button>
        </form>`,
    });
  });

  r.post('/purchasing/new', requirePerm('pos:create'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const b = rq.body!;
    const catalog = q<any>('SELECT * FROM catalog_items WHERE org_id=?', ctx.orgId);
    const lines = [0, 1, 2, 3]
      .map((i) => {
        const cat = catalog.find((c) => c.id === b[`cat_${i}`]);
        const qty = Number(b[`qty_${i}`] || 0);
        if ((!cat && !b[`desc_${i}`]) || qty <= 0) return null;
        const rawPrice = String(b[`price_${i}`] || '').trim();
        const price = (rawPrice ? parseUsd(rawPrice) : 0) || cat?.unit_price_cents || 0;
        if (price <= 0) return null;
        return {
          catalogItemId: cat?.id || null,
          description: cat?.name || String(b[`desc_${i}`]),
          qty, unitPriceCents: price, glAccount: cat?.gl_account || '5910',
          projectId: String(b[`proj_${i}`] || '') || null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    try {
      const poId = createPo(ctx, {
        propertyId: String(b.property_id), vendorId: String(b.vendor_id),
        memo: String(b.memo || '') || undefined, neededBy: String(b.needed_by || '') || undefined, lines,
      });
      const res = submitPo(ctx, poId);
      return redirect(`/purchasing/${poId}`, res === 'approved' ? 'PO approved and sent to the vendor' : 'PO submitted for approval');
    } catch (e) {
      return redirect('/purchasing/new', (e as Error).message, 'err');
    }
  });

  // ---------- exceptions / analytics / 1099 (registered before :id) ----------
  r.get('/purchasing/exceptions', requirePerm('invoices:approve'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const rows = q<any>(
      `SELECT m.*, vi.invoice_number, vi.total_cents, v.name AS vendor, po.po_number
       FROM invoice_matches m JOIN vendor_invoices vi ON vi.id=m.invoice_id
       JOIN vendors v ON v.id=vi.vendor_id JOIN purchase_orders po ON po.id=m.po_id
       WHERE m.org_id=? AND m.status='exception' ORDER BY m.created_at`,
      ctx.orgId,
    );
    return shell(rq, {
      title: 'Match exception queue',
      active: '/purchasing',
      subtitle: '2/3-way match failures — override with a reason (audited) or reject back to the vendor',
      content: card(null, tbl(
        [{ label: 'Invoice' }, { label: 'Vendor' }, { label: 'PO' }, { label: 'Variance', num: true }, { label: 'Why' }, { label: 'Action' }],
        rows.map((m) => ({
          cells: [
            html`<a href="/ap/${m.invoice_id}"><span class="mono">${m.invoice_number}</span> · ${usd(m.total_cents)}</a>`,
            m.vendor, html`<span class="mono">${m.po_number}</span>`,
            html`<span class="${m.price_variance_cents > 0 ? 'neg' : ''}">${usd(m.price_variance_cents)}</span>`,
            html`<span class="small">${m.detail}</span>`,
            html`
              <form method="post" action="/purchasing/exceptions/${m.id}" style="display:inline">
                ${input('reason', { placeholder: 'reason (required)' })}
                <button class="btn btn-sm" name="action" value="override">Override & route to AP</button>
                <button class="btn btn-ghost btn-sm" name="action" value="reject">Reject</button>
              </form>`,
          ],
        })),
        { empty: 'No open exceptions — every invoice matches.' },
      ), { flush: true }),
    });
  });

  r.post('/purchasing/exceptions/:id', requirePerm('invoices:approve'), (rq) => {
    try {
      decideMatchException(rq.ctx as Ctx, rq.params.id!, rq.body?.action === 'reject' ? 'reject' : 'override', String(rq.body?.reason || ''));
      return redirect('/purchasing/exceptions', rq.body?.action === 'reject' ? 'Invoice rejected' : 'Exception overridden — invoice routed to AP');
    } catch (e) {
      return redirect('/purchasing/exceptions', (e as Error).message, 'err');
    }
  });

  r.get('/purchasing/spend', requirePerm('ap:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const s = spendAnalytics(ctx);
    const leakTotal = s.poLeakage.withPo + s.poLeakage.withoutPo || 1;
    return shell(rq, {
      title: 'Spend analytics',
      active: '/purchasing',
      subtitle: 'Trailing 12 months of vendor spend (utility + recurring contracts excluded from leakage)',
      content: html`
        ${kpis([
          { label: 'PO-backed spend', value: usd(s.poLeakage.withPo) },
          { label: 'PO leakage (no PO)', value: usd(s.poLeakage.withoutPo), tone: s.poLeakage.withoutPo > s.poLeakage.withPo ? 'warn' : undefined },
          { label: 'PO coverage', value: `${Math.round((s.poLeakage.withPo / leakTotal) * 100)}%` },
        ])}
        <div class="cols">
          ${card('Spend by vendor', bars(s.byVendor.map((x) => ({ label: x.label, value: x.cents })), { money: true }))}
          ${card('Spend by category', bars(s.byCategory.map((x) => ({ label: x.label, value: x.cents })), { money: true }))}
        </div>
        ${card('Spend by property', bars(s.byProperty.map((x) => ({ label: x.label, value: x.cents })), { money: true }))}
        ${card('Price variance from 3-way matches', tbl(
          [{ label: 'Month' }, { label: 'Net variance vs PO', num: true }],
          s.priceVariance.map((x) => ({ cells: [fmtMonth(x.month), usd(x.varianceCents)] })),
          { empty: 'No matched invoices yet.' },
        ), { flush: true })}`,
    });
  });

  r.get('/purchasing/1099', requirePerm('ap:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const year = Number(rq.query.get('year') || ctx.businessDate.slice(0, 4));
    const s = ten99Summary(ctx, year);
    return shell(rq, {
      title: `1099-NEC — tax year ${year}`,
      active: '/purchasing',
      subtitle: 'Vendors paid $600+ on 1099-eligible rails this year',
      actions: html`<a class="btn" href="/purchasing/1099.pdf?year=${year}">Download summary PDF</a>`,
      content: html`
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Tax year', select('year', [[String(year - 1), String(year - 1)], [String(year), String(year)]], String(year)))}
        </form>
        ${kpis([
          { label: 'Reportable payments', value: usd(s.totalCents) },
          { label: '1099 vendors', value: String(s.rows.length) },
          { label: 'Missing W-9', value: String(s.missingW9.length), tone: s.missingW9.length ? 'bad' : 'ok' },
        ])}
        ${when(s.missingW9.length, () => card('⚠ Missing W-9 — collect before filing', tbl(
          [{ label: 'Vendor' }, { label: 'Paid', num: true }],
          s.missingW9.map((m) => ({ cells: [m.vendor, usd(m.paidCents)] })),
        ), { flush: true }))}
        ${card('Summary', tbl(
          [{ label: 'Vendor' }, { label: 'TIN' }, { label: 'W-9' }, { label: 'Paid', num: true }],
          s.rows.map((r2) => ({ cells: [r2.vendor, html`<span class="mono">${r2.tin}</span>`, r2.w9 ? statusBadge('ok', 'on file') : statusBadge('error', 'missing'), usd(r2.paidCents)] })),
          { empty: 'No reportable payments this year.' },
        ), { flush: true })}`,
    });
  });

  r.get('/purchasing/1099.pdf', requirePerm('ap:view'), async (rq) => {
    const ctx = rq.ctx as Ctx;
    const year = Number(rq.query.get('year') || ctx.businessDate.slice(0, 4));
    const bytes = await ten99Pdf(ctx, year);
    return {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="1099-summary-${year}.pdf"` },
      body: bytes,
    };
  });

  // ---------- PO detail ----------
  r.get('/purchasing/:id', requirePerm('pos:create'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const po = q1<any>(
      `SELECT po.*, v.name AS vendor, p.name AS property FROM purchase_orders po
       JOIN vendors v ON v.id=po.vendor_id JOIN properties p ON p.id=po.property_id WHERE po.id=? AND po.org_id=?`,
      rq.params.id!, ctx.orgId,
    );
    if (!po) return notFound();
    const lines = q<any>('SELECT * FROM purchase_order_lines WHERE po_id=?', po.id);
    const receipts = q<any>('SELECT * FROM po_receipts WHERE po_id=? ORDER BY created_at', po.id);
    const invoices = q<any>(
      `SELECT vi.*, m.status AS match_status, m.detail AS match_detail FROM vendor_invoices vi
       LEFT JOIN invoice_matches m ON m.invoice_id=vi.id WHERE vi.po_id=?`, po.id,
    );
    const receivable = ['approved', 'acknowledged', 'partially_received'].includes(po.status);
    return shell(rq, {
      title: po.po_number,
      active: '/purchasing',
      crumbs: [['Purchasing', '/purchasing']],
      subtitle: html`${po.vendor} · ${po.property} · ${statusBadge(po.status)} · ${usd(po.total_cents)}`,
      actions: html`
        ${when(po.status === 'pending_approval' && can(ctx, 'pos:approve'), () => html`<form method="post" action="/purchasing/${po.id}/approve" style="display:inline"><button class="btn">Approve & send</button></form>`)}
        ${when(po.status === 'approved', () => html`<form method="post" action="/purchasing/${po.id}/ack" style="display:inline"><button class="btn btn-ghost" title="normally done by the vendor in their portal">Mark acknowledged</button></form>`)}`,
      content: html`
        <div class="cols">
          <div>
            ${card('Lines', tbl(
              [{ label: 'Item' }, { label: 'GL' }, { label: 'Project' }, { label: 'Qty' }, { label: 'Received' }, { label: 'Unit', num: true }, { label: 'Ext.', num: true }],
              lines.map((l) => ({
                cells: [l.description, html`<span class="mono">${l.gl_account}</span>`,
                  l.project_id ? q1<any>('SELECT name FROM capital_projects WHERE id=?', l.project_id)?.name : '—',
                  String(l.qty), String(l.received_qty), usd(l.unit_price_cents), usd(Math.round(l.qty * l.unit_price_cents))],
              })),
            ), { flush: true })}
            ${when(receivable && can(ctx, 'pos:receive'), () => card('Receive', html`
              <form method="post" action="/purchasing/${po.id}/receive">
                ${join(lines.filter((l) => l.received_qty < l.qty).map((l) => html`
                  <div class="toolbar" style="margin-bottom:6px">
                    <span style="flex:1">${l.description} <span class="muted small">(${l.qty - l.received_qty} open)</span></span>
                    ${input(`qty_${l.id}`, { value: String(l.qty - l.received_qty) })}
                  </div>`), '')}
                <button class="btn">Post receipt${lines.some((l) => q1<any>('SELECT inventory_sku FROM catalog_items WHERE id=?', l.catalog_item_id)?.inventory_sku) ? ' (restocks inventory)' : ''}</button>
              </form>`))}
            ${when(invoices.length, () => card('Invoices against this PO', tbl(
              [{ label: 'Invoice' }, { label: 'Status' }, { label: 'Match' }, { label: 'Amount', num: true }],
              invoices.map((vi) => ({
                href: `/ap/${vi.id}`,
                cells: [html`<span class="mono">${vi.invoice_number}</span>`, statusBadge(vi.status),
                  vi.match_status ? statusBadge(vi.match_status === 'matched' ? 'ok' : vi.match_status === 'exception' ? 'warn' : vi.match_status, vi.match_status) : '—',
                  usd(vi.total_cents)],
              })),
            ), { flush: true }))}
          </div>
          <div>
            ${card('Timeline', dl([
              ['Created', `${po.created_by} · ${fmtDate(po.created_at.slice(0, 10))}`],
              ['Approved', po.approved_by ? `${po.approved_by} · ${fmtDate((po.approved_at || '').slice(0, 10))}` : '—'],
              ['Vendor acknowledged', po.acknowledged_at ? fmtDate(po.acknowledged_at.slice(0, 10)) : '—'],
              ['Receipts', receipts.length ? receipts.map((r2) => fmtDate(r2.date)).join(', ') : 'none'],
              ['Needed by', po.needed_by ? fmtDate(po.needed_by) : '—'],
              ['Memo', po.memo || '—'],
            ]))}
            ${historyPanel(ctx.orgId, 'purchase_order', po.id)}
          </div>
        </div>`,
    });
  });

  r.post('/purchasing/:id/approve', requirePerm('pos:approve'), (rq) => {
    approvePo(rq.ctx as Ctx, rq.params.id!);
    return redirect(`/purchasing/${rq.params.id}`, 'PO approved — sent to the vendor portal');
  });
  r.post('/purchasing/:id/ack', requirePerm('pos:create'), (rq) => {
    acknowledgePo(rq.ctx as Ctx, rq.params.id!);
    return redirect(`/purchasing/${rq.params.id}`, 'Acknowledged');
  });
  r.post('/purchasing/:id/receive', requirePerm('pos:receive'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const lines = q<any>('SELECT id FROM purchase_order_lines WHERE po_id=?', rq.params.id!)
      .map((l) => ({ poLineId: l.id as string, qty: Number(rq.body?.[`qty_${l.id}`] || 0) }))
      .filter((l) => l.qty > 0);
    try {
      receivePo(ctx, rq.params.id!, lines);
      return redirect(`/purchasing/${rq.params.id}`, 'Receipt posted');
    } catch (e) {
      return redirect(`/purchasing/${rq.params.id}`, (e as Error).message, 'err');
    }
  });
}

// ---------- vendor portal procurement ----------

export function vendorRoutes(r: Router): void {
  r.get('/vendor/pos', requireVendor, (rq) => {
    const ctx = rq.ctx as Ctx;
    const vendor = q1<any>('SELECT * FROM vendors WHERE id=? AND org_id=?', ctx.vendorId || '', ctx.orgId);
    if (!vendor) return notFound();
    const pos = q<any>(
      `SELECT po.*, p.name AS property FROM purchase_orders po JOIN properties p ON p.id=po.property_id
       WHERE po.vendor_id=? AND po.status IN ('approved','acknowledged','partially_received','received')
       ORDER BY po.created_at DESC LIMIT 30`,
      vendor.id,
    );
    const payments = q<any>(
      `SELECT ap.*, r2.run_date, vi.invoice_number FROM ap_payments ap JOIN ap_payment_runs r2 ON r2.id=ap.run_id
       JOIN vendor_invoices vi ON vi.id=ap.invoice_id WHERE ap.vendor_id=? ORDER BY r2.run_date DESC LIMIT 20`,
      vendor.id,
    );
    const { vendorShell } = vendorUi(rq);
    return vendorShell('Purchase orders & payments', html`
      ${card('Purchase orders', pos.length ? join(pos.map((po) => html`
        <div class="list-item">
          <div class="li-main">
            <div class="li-title"><span class="mono">${po.po_number}</span> · ${usd(po.total_cents)} · ${po.property}</div>
            <div class="li-sub">${po.memo || ''} ${po.needed_by ? `· needed by ${fmtDate(po.needed_by)}` : ''}</div>
          </div>
          ${po.status === 'approved'
            ? html`<form method="post" action="/vendor/pos/${po.id}/ack"><button class="btn btn-sm">Acknowledge</button></form>`
            : statusBadge(po.status)}
          ${when(['acknowledged', 'partially_received', 'received'].includes(po.status) && !q1('SELECT id FROM vendor_invoices WHERE po_id=?', po.id), () => html`
            <a class="btn btn-ghost btn-sm" href="/vendor/pos/${po.id}/invoice">Submit invoice</a>`)}
        </div>`), '') : emptyState('No purchase orders', 'New POs from the management company appear here to acknowledge.'))}
      ${card('Payments to you', payments.length ? tbl(
        [{ label: 'Date' }, { label: 'Invoice' }, { label: 'Method' }, { label: 'Ref' }, { label: 'Status' }, { label: 'Amount', num: true }, { label: '' }],
        payments.map((p) => ({
          cells: [fmtDate(p.run_date), html`<span class="mono">${p.invoice_number}</span>`, p.method, html`<span class="mono">${p.check_number}</span>`,
            statusBadge(p.status), usd(p.amount_cents),
            html`<a class="btn btn-ghost btn-sm" href="/vendor/payments/${p.id}/remittance">Remittance</a>`],
        })),
      ) : html`<p class="muted small">Payment status and remittance advice appear here once invoices are paid.</p>`, { flush: true })}`);
  });

  r.post('/vendor/pos/:id/ack', requireVendor, (rq) => {
    const ctx = rq.ctx as Ctx;
    const po = q1<any>('SELECT * FROM purchase_orders WHERE id=? AND vendor_id=?', rq.params.id!, ctx.vendorId || '');
    if (!po) return notFound();
    acknowledgePo(ctx, po.id);
    return redirect('/vendor/pos', `${po.po_number} acknowledged — thank you`);
  });

  // invoice submission with OCR prefill
  r.get('/vendor/pos/:id/invoice', requireVendor, (rq) => {
    const ctx = rq.ctx as Ctx;
    const po = q1<any>('SELECT * FROM purchase_orders WHERE id=? AND vendor_id=?', rq.params.id!, ctx.vendorId || '');
    if (!po) return notFound();
    const ocr = ocrInvoiceFromPo(ctx.orgId, po.id, ctx.vendorId || '');
    const { vendorShell } = vendorUi(rq);
    return vendorShell(`Invoice ${po.po_number}`, html`
      ${card(html`Submit your invoice <span class="badge ok">OCR pre-filled · ${Math.round(ocr.confidence * 100)}%</span>`, html`
        <p class="small muted">We read your uploaded invoice (simulated DocOcr) and pre-filled everything from ${po.po_number}. Adjust if needed — it 3-way matches against the PO and receipts on submit.</p>
        <form method="post" action="/vendor/pos/${po.id}/invoice">
          <div class="grid2">
            ${field('Invoice #', input('invoice_number', { value: ocr.invoiceNumber, required: true }))}
            ${field('Invoice date', input('invoice_date', { type: 'date', value: ocr.invoiceDate, required: true }))}
          </div>
          <table class="tbl"><thead><tr><th>Line</th><th>Qty</th><th>Unit price</th></tr></thead><tbody>
            ${join(ocr.lines.map((l, i) => html`<tr>
              <td>${l.description}<input type="hidden" name="desc_${i}" value="${l.description}"></td>
              <td>${input(`qty_${i}`, { value: String(l.qty) })}</td>
              <td>${input(`price_${i}`, { value: (l.unitPriceCents / 100).toFixed(2) })}</td>
            </tr>`), '')}
          </tbody></table>
          <button class="btn">Submit invoice</button>
        </form>`)}`);
  });

  r.post('/vendor/pos/:id/invoice', requireVendor, (rq) => {
    const ctx = rq.ctx as Ctx;
    const po = q1<any>('SELECT * FROM purchase_orders WHERE id=? AND vendor_id=?', rq.params.id!, ctx.vendorId || '');
    if (!po) return notFound();
    const b = rq.body!;
    const lines = [];
    for (let i = 0; i < 10; i++) {
      if (!b[`desc_${i}`]) break;
      lines.push({ description: String(b[`desc_${i}`]), qty: Number(b[`qty_${i}`] || 0), unitPriceCents: parseUsd(String(b[`price_${i}`] || '0')) });
    }
    try {
      const { match } = submitPoInvoice(ctx, {
        poId: po.id, invoiceNumber: String(b.invoice_number), invoiceDate: String(b.invoice_date), lines,
      });
      return redirect('/vendor/pos', match.status === 'matched'
        ? 'Invoice submitted and matched — routed for payment'
        : 'Invoice submitted — a variance routed it to the review queue');
    } catch (e) {
      return redirect('/vendor/pos', (e as Error).message, 'err');
    }
  });

  r.get('/vendor/payments/:id/remittance', requireVendor, async (rq) => {
    const ctx = rq.ctx as Ctx;
    const p = q1<any>('SELECT * FROM ap_payments WHERE id=? AND vendor_id=?', rq.params.id!, ctx.vendorId || '');
    if (!p) return notFound();
    const fileId = await remittanceAdvice(ctx, p.id);
    const f = getFile(fileId);
    if (!f) return notFound();
    return {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${f.row.name}"` },
      body: f.data,
    };
  });
}

/** vendor pages reuse the tech/vendor chrome from M10 */
import { techShell } from '../m10_facilities/tech.ts';
function vendorUi(rq: any): { vendorShell: (title: string, content: Child) => any } {
  return { vendorShell: (title: string, content: Child) => techShell(rq, title, content) };
}
