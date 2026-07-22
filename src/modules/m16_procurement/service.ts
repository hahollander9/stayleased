import { q, q1, insert, run, val, tx, update, j } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, addDays, fmtDate } from '../../lib/dates.ts';
import type { Ctx } from '../../lib/auth.ts';
import { can, sysCtx } from '../../lib/auth.ts';
import { emit } from '../../lib/events.ts';
import { audit } from '../../lib/audit.ts';
import { getSetting } from '../../lib/settings.ts';
import { sendEmail } from '../../lib/sim/messaging.ts';
import { usd } from '../../lib/money.ts';
import { createInvoice, submitInvoice } from '../m9_accounting/ap.ts';
import { Pdf } from '../../lib/pdf.ts';
import { putFile } from '../../lib/files.ts';

/** M16 — procure to pay: purchase orders with amount-routed approval chains,
 * vendor acknowledgment, full/partial receiving into M10 inventory, 2/3-way
 * invoice matching with a tolerance-driven exception queue, discount terms,
 * remittance advice, 1099 workflow, spend analytics. */

export const DEFAULT_CATALOG: [string, string, string, number, string, string | null][] = [
  // name, category, unit, price cents, GL, inventory sku (null = expense-only)
  ['HVAC filter 20x25x1 (case of 12)', 'maintenance', 'case', 5400, '5910', 'FILT-2025'],
  ['Garbage disposal 1/2 HP', 'appliance', 'ea', 9800, '5910', 'DISP-05'],
  ['Interior paint — Agreeable Beige (5 gal)', 'turn', 'pail', 14500, '5020', 'PAINT-AB5'],
  ['LVP flooring plank (box, 20 sqft)', 'turn', 'box', 6200, '5020', 'LVP-20'],
  ['Smoke/CO combo detector', 'safety', 'ea', 4200, '5910', 'SMK-CO'],
  ['Water heater 40 gal electric', 'appliance', 'ea', 68500, '5010', null],
  ['Toilet fill/flush rebuild kit', 'maintenance', 'ea', 2350, '5910', 'TOIL-KIT'],
  ['Door lock set (keyed alike)', 'safety', 'ea', 5900, '5910', 'LOCK-KA'],
  ['Irrigation head assortment', 'grounds', 'kit', 8800, '5030', null],
  ['Copy paper & office bundle', 'office', 'bundle', 5200, '5810', null],
  ['Appliance dolly rental', 'maintenance', 'day', 3500, '5010', null],
  ['Carpet pad + install (per room)', 'turn', 'room', 18500, '5020', null],
];

export function ensureCatalog(orgId: string): void {
  if (q1('SELECT id FROM catalog_items WHERE org_id=? LIMIT 1', orgId)) return;
  for (const [name, category, unit, price, gl, sku] of DEFAULT_CATALOG) {
    insert('catalog_items', {
      id: id('cat'), org_id: orgId, name, category, unit, unit_price_cents: price,
      preferred_vendor_id: null, gl_account: gl, inventory_sku: sku, active: 1, created_at: nowIso(),
    });
  }
}

// ---------- purchase orders ----------

export interface PoLineInput {
  catalogItemId?: string | null;
  description: string;
  qty: number;
  unitPriceCents: number;
  glAccount: string;
  projectId?: string | null;
  costCode?: string | null;
}

function nextPoNumber(orgId: string): string {
  const max = val<number>(
    `SELECT COALESCE(MAX(CAST(substr(po_number, 4) AS INTEGER)), 1000) FROM purchase_orders WHERE org_id=?`, orgId,
  ) || 1000;
  return `PO-${max + 1}`;
}

export function createPo(
  ctx: Ctx,
  input: { propertyId: string; vendorId: string; memo?: string; neededBy?: string; source?: string; sourceId?: string | null; lines: PoLineInput[] },
): string {
  if (!input.lines.length) throw new Error('a purchase order needs at least one line');
  const vendor = q1<any>('SELECT * FROM vendors WHERE id=? AND org_id=?', input.vendorId, ctx.orgId);
  if (!vendor) throw new Error('vendor not found');
  const approved = j<string[]>(vendor.approved_property_ids, []);
  if (approved.length && !approved.includes(input.propertyId)) throw new Error(`${vendor.name} is not on this property's approved vendor list`);
  const total = input.lines.reduce((s, l) => s + Math.round(l.qty * l.unitPriceCents), 0);
  const poId = id('po');
  tx(() => {
    insert('purchase_orders', {
      id: poId, org_id: ctx.orgId, property_id: input.propertyId, vendor_id: input.vendorId,
      po_number: nextPoNumber(ctx.orgId), status: 'draft', memo: input.memo || null,
      needed_by: input.neededBy || null, source: input.source || 'manual', source_id: input.sourceId ?? null,
      total_cents: total, created_by: ctx.userName, created_at: nowIso(),
    });
    for (const l of input.lines) {
      insert('purchase_order_lines', {
        id: id('pol'), org_id: ctx.orgId, po_id: poId, catalog_item_id: l.catalogItemId ?? null,
        description: l.description, qty: l.qty, unit_price_cents: l.unitPriceCents,
        gl_account: l.glAccount, project_id: l.projectId ?? null, cost_code: l.costCode ?? null,
        received_qty: 0, created_at: nowIso(),
      });
    }
  });
  audit(ctx, 'purchase_order', poId, 'create', null, { totalCents: total, vendor: vendor.name });
  return poId;
}

/** amount-routed approval: under the threshold, any pos:create user self-approves;
 * over it, pos:approve is required (approval chains by amount and role) */
export function submitPo(ctx: Ctx, poId: string): 'approved' | 'pending_approval' {
  const po = q1<any>('SELECT * FROM purchase_orders WHERE id=? AND org_id=?', poId, ctx.orgId);
  if (!po || po.status !== 'draft') throw new Error('PO not in draft');
  const threshold = getSetting<number>(ctx, 'po_approval_threshold_cents', po.property_id);
  if (po.total_cents <= threshold || can(ctx, 'pos:approve')) {
    approvePo(ctx, poId);
    return 'approved';
  }
  run(`UPDATE purchase_orders SET status='pending_approval' WHERE id=?`, poId);
  emit(ctx, 'po.submitted', 'purchase_order', poId, { totalCents: po.total_cents });
  audit(ctx, 'purchase_order', poId, 'submit');
  return 'pending_approval';
}

export function approvePo(ctx: Ctx, poId: string): void {
  const po = q1<any>('SELECT * FROM purchase_orders WHERE id=? AND org_id=?', poId, ctx.orgId);
  if (!po || !['draft', 'pending_approval'].includes(po.status)) throw new Error('PO not approvable');
  const vendor = q1<any>('SELECT * FROM vendors WHERE id=?', po.vendor_id);
  run(`UPDATE purchase_orders SET status='approved', approved_by=?, approved_at=?, sent_at=? WHERE id=?`, ctx.userName, nowIso(), nowIso(), poId);
  if (vendor?.email) {
    sendEmail(ctx, {
      to: vendor.email, toName: vendor.name, subject: `Purchase order ${po.po_number} — ${usd(po.total_cents)}`,
      body: `<p>${vendor.name},</p><p>Please acknowledge PO <b>${po.po_number}</b> (${usd(po.total_cents)}) in your vendor portal${po.needed_by ? `, needed by ${fmtDate(po.needed_by)}` : ''}.</p>`,
      entity: 'purchase_order', entityId: poId, templateKey: 'po_sent',
    });
  }
  emit(ctx, 'po.approved', 'purchase_order', poId, { totalCents: po.total_cents });
  audit(ctx, 'purchase_order', poId, 'approve');
}

export function acknowledgePo(ctx: Ctx, poId: string): void {
  const po = q1<any>('SELECT * FROM purchase_orders WHERE id=? AND org_id=?', poId, ctx.orgId);
  if (!po || po.status !== 'approved') throw new Error('PO is not awaiting acknowledgment');
  run(`UPDATE purchase_orders SET status='acknowledged', acknowledged_at=? WHERE id=?`, nowIso(), poId);
  emit(ctx, 'po.acknowledged', 'purchase_order', poId, {});
  audit(ctx, 'purchase_order', poId, 'acknowledge');
}

/** full/partial receiving; catalog lines with an inventory SKU restock M10 */
export function receivePo(ctx: Ctx, poId: string, lines: { poLineId: string; qty: number }[], note?: string): string {
  const po = q1<any>('SELECT * FROM purchase_orders WHERE id=? AND org_id=?', poId, ctx.orgId);
  if (!po || !['acknowledged', 'approved', 'partially_received'].includes(po.status)) throw new Error('PO is not receivable');
  const receiptId = id('rcp');
  tx(() => {
    insert('po_receipts', {
      id: receiptId, org_id: ctx.orgId, po_id: poId, date: ctx.businessDate,
      note: note || null, received_by: ctx.userName, created_at: nowIso(),
    });
    for (const l of lines) {
      if (l.qty <= 0) continue;
      const pol = q1<any>('SELECT * FROM purchase_order_lines WHERE id=? AND po_id=?', l.poLineId, poId);
      if (!pol) throw new Error('PO line not found');
      const remaining = pol.qty - pol.received_qty;
      const take = Math.min(l.qty, remaining);
      if (take <= 0) continue;
      insert('po_receipt_lines', { id: id('rcl'), org_id: ctx.orgId, receipt_id: receiptId, po_line_id: pol.id, qty: take });
      run('UPDATE purchase_order_lines SET received_qty=received_qty+? WHERE id=?', take, pol.id);
      // restock inventory for catalog items with a SKU
      if (pol.catalog_item_id) {
        const cat = q1<any>('SELECT * FROM catalog_items WHERE id=?', pol.catalog_item_id);
        if (cat?.inventory_sku) {
          const inv = q1<any>('SELECT * FROM inventory_items WHERE property_id=? AND sku=?', po.property_id, cat.inventory_sku);
          if (inv) run('UPDATE inventory_items SET on_hand=on_hand+? WHERE id=?', take, inv.id);
          else {
            insert('inventory_items', {
              id: id('inv'), org_id: ctx.orgId, property_id: po.property_id, sku: cat.inventory_sku,
              name: cat.name, category: cat.category, bin: 'RCV', unit_cost_cents: pol.unit_price_cents,
              on_hand: take, min_qty: 2, max_qty: take * 3, created_at: nowIso(),
            });
          }
        }
      }
    }
    const open = val<number>('SELECT COUNT(*) FROM purchase_order_lines WHERE po_id=? AND received_qty < qty', poId) || 0;
    run(`UPDATE purchase_orders SET status=? WHERE id=?`, open ? 'partially_received' : 'received', poId);
  });
  emit(ctx, 'po.received', 'purchase_order', poId, { receiptId, complete: q1<any>('SELECT status FROM purchase_orders WHERE id=?', poId).status === 'received' });
  audit(ctx, 'purchase_order', poId, 'receive', null, { receiptId, lines: lines.length });
  return receiptId;
}

// ---------- DocOcr invoice prefill (sim) ----------

export interface OcrInvoice {
  invoiceNumber: string;
  invoiceDate: string;
  totalCents: number;
  lines: { description: string; qty: number; unitPriceCents: number }[];
  confidence: number;
}

/** deterministic "OCR": with a PO reference the extraction mirrors the PO
 * (receipted quantities), with a stable low-noise price wobble keyed by the
 * upload — exactly how a believable demo exception is manufactured */
export function ocrInvoiceFromPo(orgId: string, poId: string, salt: string, opts?: { exception?: boolean }): OcrInvoice {
  const po = q1<any>('SELECT * FROM purchase_orders WHERE id=?', poId);
  const lines = q<any>('SELECT * FROM purchase_order_lines WHERE po_id=?', poId);
  let h = 5381;
  for (const ch of poId + salt) h = (Math.imul(h, 33) ^ ch.charCodeAt(0)) >>> 0;
  const wobble = opts?.exception ? 1 + (0.06 + (h % 40) / 1000) : 1; // +6-10% price variance
  const out = lines.map((l) => ({
    description: l.description,
    qty: l.received_qty || l.qty,
    unitPriceCents: Math.round((l.unit_price_cents * wobble) / 25) * 25,
  }));
  return {
    invoiceNumber: `INV-${po.po_number.slice(3)}-${(h % 900) + 100}`,
    invoiceDate: q1<any>('SELECT business_date FROM orgs WHERE id=?', orgId).business_date,
    totalCents: out.reduce((s, l) => s + Math.round(l.qty * l.unitPriceCents), 0),
    lines: out,
    confidence: opts?.exception ? 0.87 : 0.98,
  };
}

// ---------- 2/3-way match ----------

export interface MatchResult {
  status: 'matched' | 'exception';
  priceVarianceCents: number;
  qtyException: boolean;
  detail: string[];
}

/** invoice vs PO prices (2-way) and vs received quantities (3-way) */
export function matchInvoice(ctx: Ctx, invoiceId: string, poId: string): MatchResult {
  const inv = q1<any>('SELECT * FROM vendor_invoices WHERE id=? AND org_id=?', invoiceId, ctx.orgId);
  const po = q1<any>('SELECT * FROM purchase_orders WHERE id=? AND org_id=?', poId, ctx.orgId);
  if (!inv || !po) throw new Error('invoice or PO not found');
  const tolerancePct = getSetting<number>(ctx, 'match_price_tolerance_pct', po.property_id);
  const detail: string[] = [];

  const receivedValue = val<number>(
    `SELECT COALESCE(SUM(received_qty * unit_price_cents),0) FROM purchase_order_lines WHERE po_id=?`, poId,
  ) || 0;
  const poValue = po.total_cents;
  const priceVariance = inv.total_cents - receivedValue;
  const pct = receivedValue > 0 ? Math.abs(priceVariance / receivedValue) * 100 : 100;

  let qtyException = false;
  if (receivedValue === 0) {
    qtyException = true;
    detail.push('nothing received against this PO yet (3-way match requires a receipt)');
  } else if (receivedValue < poValue) {
    detail.push(`partial receipt: ${usd(receivedValue)} of ${usd(poValue)} received`);
  }
  if (pct > tolerancePct) {
    detail.push(`invoice ${usd(inv.total_cents)} vs received value ${usd(receivedValue)} — ${pct.toFixed(1)}% variance exceeds the ${tolerancePct}% tolerance`);
  } else if (priceVariance !== 0) {
    detail.push(`price variance ${usd(priceVariance)} within tolerance`);
  }

  const status: MatchResult['status'] = qtyException || pct > tolerancePct ? 'exception' : 'matched';
  const existing = q1<any>('SELECT id FROM invoice_matches WHERE invoice_id=?', invoiceId);
  if (existing) {
    run('UPDATE invoice_matches SET po_id=?, status=?, price_variance_cents=?, qty_exception=?, detail=? WHERE id=?',
      poId, status, priceVariance, qtyException ? 1 : 0, detail.join('; '), existing.id);
  } else {
    insert('invoice_matches', {
      id: id('mat'), org_id: ctx.orgId, invoice_id: invoiceId, po_id: poId, status,
      price_variance_cents: priceVariance, qty_exception: qtyException ? 1 : 0,
      detail: detail.join('; '), created_at: nowIso(),
    });
  }
  run('UPDATE vendor_invoices SET po_id=? WHERE id=?', poId, invoiceId);
  emit(ctx, 'invoice.matched', 'vendor_invoice', invoiceId, { poId, status });
  audit(ctx, 'vendor_invoice', invoiceId, status === 'matched' ? 'match_ok' : 'match_exception', null, { poId, detail });
  return { status, priceVarianceCents: priceVariance, qtyException, detail };
}

/** exception queue actions: override (audited, needs ap:approve) or reject */
export function decideMatchException(ctx: Ctx, matchId: string, action: 'override' | 'reject', reason: string): void {
  const m = q1<any>('SELECT * FROM invoice_matches WHERE id=? AND org_id=?', matchId, ctx.orgId);
  if (!m || m.status !== 'exception') throw new Error('no open exception');
  if (!reason.trim()) throw new Error('a written reason is required');
  if (action === 'override') {
    run(`UPDATE invoice_matches SET status='overridden', decided_by=?, decided_at=? WHERE id=?`, ctx.userName, nowIso(), matchId);
    submitInvoice(ctx, m.invoice_id);
  } else {
    run(`UPDATE invoice_matches SET status='rejected', decided_by=?, decided_at=? WHERE id=?`, ctx.userName, nowIso(), matchId);
    run(`UPDATE vendor_invoices SET status='void' WHERE id=? AND status='draft'`, m.invoice_id);
  }
  audit(ctx, 'invoice_match', matchId, action, null, { reason });
}

/** vendor (or staff) submits an invoice against a PO; OCR prefill + auto-match.
 * Matched invoices submit straight into AP approval routing; exceptions hold
 * as drafts in the queue. */
export function submitPoInvoice(
  ctx: Ctx,
  input: { poId: string; invoiceNumber: string; invoiceDate: string; lines: { description: string; qty: number; unitPriceCents: number }[]; discountPct?: number; discountDays?: number },
): { invoiceId: string; match: MatchResult } {
  const po = q1<any>('SELECT * FROM purchase_orders WHERE id=? AND org_id=?', input.poId, ctx.orgId);
  if (!po) throw new Error('PO not found');
  const polines = q<any>('SELECT * FROM purchase_order_lines WHERE po_id=?', input.poId);
  const glFor = (desc: string): string => polines.find((p) => p.description === desc)?.gl_account || polines[0]?.gl_account || '5910';
  const vendor = q1<any>('SELECT * FROM vendors WHERE id=?', po.vendor_id);
  const invoiceId = createInvoice(ctx, {
    vendorId: po.vendor_id, propertyId: po.property_id,
    invoiceNumber: input.invoiceNumber, invoiceDate: input.invoiceDate,
    memo: `Against ${po.po_number}`, source: 'po', sourceId: po.id,
    lines: input.lines.map((l) => ({
      glAccount: glFor(l.description), description: l.description,
      amountCents: Math.round(l.qty * l.unitPriceCents),
      projectId: polines.find((p) => p.description === l.description)?.project_id || null,
      costCode: polines.find((p) => p.description === l.description)?.cost_code || null,
    })),
  });
  // early-pay discount terms (vendor default like '2/10 net 30')
  const terms = String(vendor?.terms || '');
  const tm = /(\d+(?:\.\d+)?)\/(\d+)/.exec(terms);
  if (tm || input.discountPct) {
    const pct = input.discountPct ?? Number(tm![1]);
    const days = input.discountDays ?? Number(tm![2]);
    const inv = q1<any>('SELECT total_cents FROM vendor_invoices WHERE id=?', invoiceId);
    run('UPDATE vendor_invoices SET discount_cents=?, discount_by=? WHERE id=?',
      Math.round((inv.total_cents * pct) / 100), addDays(input.invoiceDate, days), invoiceId);
  }
  const match = matchInvoice(ctx, invoiceId, input.poId);
  if (match.status === 'matched') submitInvoice(ctx, invoiceId);
  return { invoiceId, match };
}

// ---------- remittance advice ----------

export async function remittanceAdvice(ctx: Ctx, paymentId: string): Promise<string> {
  const p = q1<any>(
    `SELECT ap.*, r.run_date, v.name AS vendor_name, vi.invoice_number, pr.name AS property_name
     FROM ap_payments ap JOIN ap_payment_runs r ON r.id=ap.run_id JOIN vendors v ON v.id=ap.vendor_id
     JOIN vendor_invoices vi ON vi.id=ap.invoice_id JOIN properties pr ON pr.id=ap.property_id
     WHERE ap.id=? AND ap.org_id=?`,
    paymentId, ctx.orgId,
  );
  if (!p) throw new Error('payment not found');
  const existing = q1<any>(`SELECT id FROM files WHERE entity='ap_payment' AND entity_id=?`, paymentId);
  if (existing) return existing.id as string;
  const pdf = await Pdf.create('Remittance advice');
  pdf.h1('Remittance advice');
  pdf.kv([
    ['Payee', p.vendor_name],
    ['Payment', `${p.method === 'ach' ? 'ACH' : 'Check'} ${p.check_number}`],
    ['Date', fmtDate(p.run_date)],
    ['Amount', usd(p.amount_cents)],
    ['Invoice', p.invoice_number],
    ['Property', p.property_name],
    ['Status', p.status],
  ]);
  pdf.space(8);
  pdf.text('This payment was issued by Summit Ridge Management Co. via the StayLeased platform (simulated rails).', { muted: true, size: 9 });
  const f = putFile(sysCtx(ctx.orgId), Buffer.from(await pdf.bytes()), {
    name: `remittance-${p.check_number}.pdf`, mime: 'application/pdf', entity: 'ap_payment', entityId: paymentId, visibility: 'staff',
  });
  return f.id;
}

// ---------- 1099 workflow ----------

export function ten99Summary(ctx: Ctx, year: number): {
  rows: { vendorId: string; vendor: string; tin: string; w9: boolean; paidCents: number }[];
  missingW9: { vendorId: string; vendor: string; paidCents: number }[];
  totalCents: number;
} {
  const rows = q<any>(
    `SELECT v.id AS vendor_id, v.name, v.tin_last4, v.w9_on_file, COALESCE(SUM(ap.amount_cents),0) AS paid
     FROM ap_payments ap JOIN ap_payment_runs r ON r.id=ap.run_id JOIN vendors v ON v.id=ap.vendor_id
     WHERE ap.org_id=? AND ap.status != 'void' AND substr(r.run_date,1,4)=? AND v.is_1099=1
     GROUP BY v.id HAVING paid >= 60000 ORDER BY paid DESC`,
    ctx.orgId, String(year),
  );
  const mapped = rows.map((r) => ({
    vendorId: r.vendor_id as string, vendor: r.name as string,
    tin: r.tin_last4 ? `***-**-${r.tin_last4}` : '—', w9: !!r.w9_on_file, paidCents: Number(r.paid),
  }));
  return {
    rows: mapped,
    missingW9: mapped.filter((r) => !r.w9).map((r) => ({ vendorId: r.vendorId, vendor: r.vendor, paidCents: r.paidCents })),
    totalCents: mapped.reduce((s, r) => s + r.paidCents, 0),
  };
}

export async function ten99Pdf(ctx: Ctx, year: number): Promise<Uint8Array> {
  const s = ten99Summary(ctx, year);
  const pdf = await Pdf.create(`1099-NEC summary ${year}`);
  pdf.h1(`1099-NEC summary — tax year ${year}`);
  pdf.text(`Vendors paid $600+ on simulated rails. Generated ${fmtDate(ctx.businessDate)}.`, { muted: true, size: 9 });
  pdf.space(6);
  for (const r of s.rows) {
    pdf.text(`${r.vendor}  ·  TIN ${r.tin}  ·  ${usd(r.paidCents)}${r.w9 ? '' : '   ** W-9 MISSING **'}`, { size: 10.5 });
  }
  pdf.space(6);
  pdf.kv([['Total reportable', usd(s.totalCents)], ['Vendors', String(s.rows.length)], ['Missing W-9', String(s.missingW9.length)]]);
  return pdf.bytes();
}

// ---------- spend analytics ----------

export function spendAnalytics(ctx: Ctx, monthsBack = 12): {
  byCategory: { label: string; cents: number }[];
  byVendor: { label: string; cents: number }[];
  byProperty: { label: string; cents: number }[];
  poLeakage: { withPo: number; withoutPo: number };
  priceVariance: { month: string; varianceCents: number }[];
} {
  const since = addDays(ctx.businessDate, -30 * monthsBack);
  const byCategory = q<any>(
    `SELECT v.category AS label, SUM(vi.total_cents) AS cents FROM vendor_invoices vi JOIN vendors v ON v.id=vi.vendor_id
     WHERE vi.org_id=? AND vi.status IN ('approved','paid') AND vi.invoice_date>=? GROUP BY v.category ORDER BY cents DESC LIMIT 10`,
    ctx.orgId, since,
  );
  const byVendor = q<any>(
    `SELECT v.name AS label, SUM(vi.total_cents) AS cents FROM vendor_invoices vi JOIN vendors v ON v.id=vi.vendor_id
     WHERE vi.org_id=? AND vi.status IN ('approved','paid') AND vi.invoice_date>=? GROUP BY v.id ORDER BY cents DESC LIMIT 10`,
    ctx.orgId, since,
  );
  const byProperty = q<any>(
    `SELECT p.name AS label, SUM(vi.total_cents) AS cents FROM vendor_invoices vi JOIN properties p ON p.id=vi.property_id
     WHERE vi.org_id=? AND vi.status IN ('approved','paid') AND vi.invoice_date>=? GROUP BY p.id ORDER BY cents DESC`,
    ctx.orgId, since,
  );
  const withPo = val<number>(
    `SELECT COALESCE(SUM(total_cents),0) FROM vendor_invoices WHERE org_id=? AND status IN ('approved','paid') AND invoice_date>=? AND po_id IS NOT NULL`,
    ctx.orgId, since,
  ) || 0;
  const withoutPo = val<number>(
    `SELECT COALESCE(SUM(total_cents),0) FROM vendor_invoices WHERE org_id=? AND status IN ('approved','paid') AND invoice_date>=? AND po_id IS NULL AND source NOT IN ('utility','recurring')`,
    ctx.orgId, since,
  ) || 0;
  const priceVariance = q<any>(
    `SELECT substr(vi.invoice_date,1,7) AS month, SUM(m.price_variance_cents) AS varianceCents
     FROM invoice_matches m JOIN vendor_invoices vi ON vi.id=m.invoice_id
     WHERE m.org_id=? GROUP BY month ORDER BY month DESC LIMIT 6`,
    ctx.orgId,
  );
  return { byCategory, byVendor, byProperty, poLeakage: { withPo, withoutPo }, priceVariance };
}

/** open-PO commitments per capital project (job costing) */
export function projectCommitments(ctx: Ctx, projectId: string): number {
  return val<number>(
    `SELECT COALESCE(SUM((pol.qty - pol.received_qty) * pol.unit_price_cents),0)
     FROM purchase_order_lines pol JOIN purchase_orders po ON po.id=pol.po_id
     WHERE pol.org_id=? AND pol.project_id=? AND po.status IN ('approved','acknowledged','partially_received')`,
    ctx.orgId, projectId,
  ) || 0;
}
