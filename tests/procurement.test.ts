import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert, run, val } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { sysCtx, hashPassword, buildCtx } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { runInvariants } from '../src/modules/m9_accounting/service.ts';
import { createPaymentRun } from '../src/modules/m9_accounting/ap.ts';
import {
  ensureCatalog, createPo, submitPo, approvePo, acknowledgePo, receivePo,
  ocrInvoiceFromPo, matchInvoice, decideMatchException, submitPoInvoice,
  ten99Summary, projectCommitments,
} from '../src/modules/m16_procurement/service.ts';

/** Phase 12 units: PO approval routing, receiving + inventory restock, OCR
 * determinism, 2/3-way match tolerances + exception queue, 1099 workflow,
 * job-cost commitments. */

let orgId: string;
let propId: string;
let vendorId: string;
let pmCtx: any;
const BD = '2026-07-26';

before(() => {
  db();
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'P2P Test Org', slug: 'p2p-' + orgId.slice(-6), business_date: BD, created_at: nowIso() });
  ensureCoa(orgId);
  ensureCatalog(orgId);
  propId = id('prp');
  insert('properties', {
    id: propId, org_id: orgId, name: 'Procure Point', slug: 'procure-' + orgId.slice(-6), type: 'multifamily',
    address1: '4 Supply Rd', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso(),
  });
  vendorId = id('vnd');
  insert('vendors', {
    id: vendorId, org_id: orgId, name: 'Supply Side LLC', category: 'general', email: 'po@supplyside.demo',
    tin_last4: '4821', w9_on_file: 1, is_1099: 1, terms: '2/10 net 30',
    diversity_tags: '[]', approved_property_ids: '[]', active: 1, created_at: nowIso(),
  });
  const uid = id('usr');
  insert('users', { id: uid, org_id: orgId, email: `pm@p2p-${orgId.slice(-4)}.test`, name: 'Perry Manager', kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso() });
  insert('role_assignments', { id: id('ra'), org_id: orgId, user_id: uid, role: 'PROPERTY_MANAGER', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  pmCtx = buildCtx(q1<any>('SELECT * FROM users WHERE id=?', uid), null, null);
});

function catalogItem(needle: string): any {
  return q1<any>(`SELECT * FROM catalog_items WHERE org_id=? AND name LIKE ?`, orgId, `%${needle}%`);
}

test('PO approval routes by amount and role', () => {
  const kit = catalogItem('Toilet');
  const small = createPo(pmCtx, {
    propertyId: propId, vendorId, lines: [{ catalogItemId: kit.id, description: kit.name, qty: 4, unitPriceCents: kit.unit_price_cents, glAccount: kit.gl_account }],
  });
  assert.equal(submitPo(pmCtx, small), 'approved', 'under threshold self-approves');

  const heater = catalogItem('Water heater');
  const big = createPo(pmCtx, {
    propertyId: propId, vendorId, lines: [{ catalogItemId: heater.id, description: heater.name, qty: 3, unitPriceCents: heater.unit_price_cents, glAccount: heater.gl_account }],
  });
  assert.equal(submitPo(pmCtx, big), 'pending_approval', 'over threshold routes up (PM lacks pos:approve)');
  approvePo(sysCtx(orgId), big);
  assert.equal(q1<any>('SELECT status FROM purchase_orders WHERE id=?', big).status, 'approved');
});

test('receiving is partial-aware and restocks SKU-linked inventory', () => {
  const ctx = sysCtx(orgId);
  const filt = catalogItem('HVAC filter');
  const poId = createPo(ctx, {
    propertyId: propId, vendorId, lines: [{ catalogItemId: filt.id, description: filt.name, qty: 10, unitPriceCents: filt.unit_price_cents, glAccount: filt.gl_account }],
  });
  submitPo(ctx, poId);
  acknowledgePo(ctx, poId);
  const line = q1<any>('SELECT * FROM purchase_order_lines WHERE po_id=?', poId);
  receivePo(ctx, poId, [{ poLineId: line.id, qty: 4 }]);
  assert.equal(q1<any>('SELECT status FROM purchase_orders WHERE id=?', poId).status, 'partially_received');
  const inv1 = q1<any>('SELECT on_hand FROM inventory_items WHERE property_id=? AND sku=?', propId, filt.inventory_sku);
  assert.equal(inv1.on_hand, 4, 'inventory restocked on receipt');
  receivePo(ctx, poId, [{ poLineId: line.id, qty: 99 }]); // over-receipt clamps to remaining
  assert.equal(q1<any>('SELECT status FROM purchase_orders WHERE id=?', poId).status, 'received');
  assert.equal(q1<any>('SELECT received_qty FROM purchase_order_lines WHERE id=?', line.id).received_qty, 10);
  assert.equal(q1<any>('SELECT on_hand FROM inventory_items WHERE property_id=? AND sku=?', propId, filt.inventory_sku).on_hand, 10);
});

test('OCR prefill is deterministic; the exception variant drifts beyond tolerance', () => {
  const poId = q1<any>(`SELECT id FROM purchase_orders WHERE org_id=? AND status='received'`, orgId).id;
  const a = ocrInvoiceFromPo(orgId, poId, 'salt');
  const b = ocrInvoiceFromPo(orgId, poId, 'salt');
  assert.deepEqual(a, b, 'same inputs, same extraction');
  const exc = ocrInvoiceFromPo(orgId, poId, 'salt', { exception: true });
  assert.equal(exc.totalCents > a.totalCents * 1.05, true, 'exception variant inflates ≥5%');
});

test('3-way match: clean pass within tolerance, exception beyond it, override routes to AP', () => {
  const ctx = sysCtx(orgId);
  const poId = q1<any>(`SELECT id FROM purchase_orders WHERE org_id=? AND status='received'`, orgId).id;
  const clean = ocrInvoiceFromPo(orgId, poId, 'clean');
  const ok = submitPoInvoice(ctx, { poId, invoiceNumber: clean.invoiceNumber, invoiceDate: BD, lines: clean.lines });
  assert.equal(ok.match.status, 'matched');
  const inv = q1<any>('SELECT * FROM vendor_invoices WHERE id=?', ok.invoiceId);
  assert.equal(inv.status, 'approved', 'matched invoice flowed into AP routing');
  assert.equal(inv.discount_cents > 0, true, '2/10 terms captured a discount');
  assert.ok(inv.discount_by, 'discount deadline set');

  // exception path on a second received PO
  const paint = catalogItem('paint');
  const po2 = createPo(ctx, {
    propertyId: propId, vendorId, lines: [{ catalogItemId: paint.id, description: paint.name, qty: 5, unitPriceCents: paint.unit_price_cents, glAccount: paint.gl_account }],
  });
  submitPo(ctx, po2);
  acknowledgePo(ctx, po2);
  receivePo(ctx, po2, q<any>('SELECT id, qty FROM purchase_order_lines WHERE po_id=?', po2).map((l) => ({ poLineId: l.id, qty: l.qty })));
  const bad = ocrInvoiceFromPo(orgId, po2, 'bad', { exception: true });
  const exc = submitPoInvoice(ctx, { poId: po2, invoiceNumber: bad.invoiceNumber, invoiceDate: BD, lines: bad.lines });
  assert.equal(exc.match.status, 'exception');
  assert.equal(q1<any>('SELECT status FROM vendor_invoices WHERE id=?', exc.invoiceId).status, 'draft', 'exception holds out of AP');

  const m = q1<any>('SELECT * FROM invoice_matches WHERE invoice_id=?', exc.invoiceId);
  assert.throws(() => decideMatchException(ctx, m.id, 'override', ''), /reason/);
  decideMatchException(ctx, m.id, 'override', 'price increase confirmed');
  assert.equal(q1<any>('SELECT status FROM invoice_matches WHERE id=?', m.id).status, 'overridden');
  assert.equal(q1<any>('SELECT status FROM vendor_invoices WHERE id=?', exc.invoiceId).status, 'approved');
});

test('3-way match requires a receipt (2-way alone is an exception)', () => {
  const ctx = sysCtx(orgId);
  const lock = catalogItem('lock');
  const poId = createPo(ctx, {
    propertyId: propId, vendorId, lines: [{ catalogItemId: lock.id, description: lock.name, qty: 3, unitPriceCents: lock.unit_price_cents, glAccount: lock.gl_account }],
  });
  submitPo(ctx, poId);
  acknowledgePo(ctx, poId);
  const ocr = ocrInvoiceFromPo(orgId, poId, 'norcpt');
  const res = submitPoInvoice(ctx, { poId, invoiceNumber: ocr.invoiceNumber, invoiceDate: BD, lines: ocr.lines });
  assert.equal(res.match.status, 'exception');
  assert.match(res.match.detail.join(' '), /nothing received/);
});

test('1099: year totals, $600 floor, missing-W-9 exceptions, non-1099 excluded', () => {
  const ctx = sysCtx(orgId);
  // pay everything approved so the year has reportable payments
  const approved = q<any>(`SELECT id FROM vendor_invoices WHERE org_id=? AND status='approved'`, orgId).map((x) => x.id);
  createPaymentRun(ctx, { runDate: BD, method: 'ach', invoiceIds: approved });

  const nonReportable = id('vnd');
  insert('vendors', {
    id: nonReportable, org_id: orgId, name: 'MegaCorp Inc (W-2 world)', category: 'general',
    w9_on_file: 1, is_1099: 0, diversity_tags: '[]', approved_property_ids: '[]', active: 1, created_at: nowIso(),
  });
  run(`UPDATE vendors SET w9_on_file=0 WHERE id=?`, vendorId);

  const s = ten99Summary(ctx, 2026);
  const supply = s.rows.find((r) => r.vendor === 'Supply Side LLC');
  assert.ok(supply, 'reportable vendor listed');
  assert.equal(supply!.paidCents >= 60000, true);
  assert.equal(s.missingW9.some((m) => m.vendor === 'Supply Side LLC'), true, 'W-9 gap flagged');
  assert.equal(s.rows.some((r) => r.vendor.includes('MegaCorp')), false, 'non-1099 vendors excluded');
  run(`UPDATE vendors SET w9_on_file=1 WHERE id=?`, vendorId);
});

test('open POs commit against capital project budgets; invariants stay green', () => {
  const ctx = sysCtx(orgId);
  const projId = id('cpj');
  insert('capital_projects', {
    id: projId, org_id: orgId, property_id: propId, name: 'Test capex', budget_cents: 1000000,
    cost_codes: '[]', status: 'active', created_at: nowIso(),
  });
  const poId = createPo(ctx, {
    propertyId: propId, vendorId,
    lines: [{ catalogItemId: null, description: 'Custom fabrication', qty: 2, unitPriceCents: 120000, glAccount: '1500', projectId: projId }],
  });
  submitPo(ctx, poId);
  assert.equal(projectCommitments(ctx, projId), 240000);
  acknowledgePo(ctx, poId);
  const line = q1<any>('SELECT id FROM purchase_order_lines WHERE po_id=?', poId);
  receivePo(ctx, poId, [{ poLineId: line.id, qty: 1 }]);
  assert.equal(projectCommitments(ctx, projId), 120000, 'commitment burns down as receipts land');
  for (const inv of runInvariants(ctx)) assert.equal(inv.ok, true, inv.name + ': ' + inv.detail);
});
