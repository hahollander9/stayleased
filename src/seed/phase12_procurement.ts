import { q, q1, val, run } from '../lib/db.ts';
import { addDays } from '../lib/dates.ts';
import { sysCtx } from '../lib/auth.ts';
import {
  ensureCatalog, createPo, submitPo, acknowledgePo, receivePo,
  ocrInvoiceFromPo, submitPoInvoice,
} from '../modules/m16_procurement/service.ts';
import { createPaymentRun } from '../modules/m9_accounting/ap.ts';
import type { SeedCtx } from './seed.ts';
import { log } from './seed.ts';

/** Phase 12 seed: catalog; a July PO pipeline in every state — several fully
 * paid through PO → ack → receive → matched invoice → payment run, one match
 * EXCEPTION in the queue, one awaiting approval, one awaiting acknowledgment,
 * one partially received, a project-coded PO committing capital budget; a
 * vendor with a missing W-9 for the 1099 exception list. All dated in the
 * open month so closed periods stay closed. */

export function seedProcurement(s: SeedCtx): void {
  const ctx = sysCtx(s.orgId);
  ensureCatalog(s.orgId);
  const props = q<any>('SELECT id, slug FROM properties WHERE org_id=?', s.orgId);
  const prop = (slug: string): string => props.find((p) => p.slug === slug)?.id || props[0].id;
  const vendors = q<any>(`SELECT * FROM vendors WHERE org_id=? AND active=1 AND category != 'general'`, s.orgId);
  const vendorBy = (cat: string): any => vendors.find((v) => v.category === cat) || vendors[0];
  const catalog = q<any>('SELECT * FROM catalog_items WHERE org_id=?', s.orgId);
  const item = (needle: string): any => catalog.find((c) => c.name.toLowerCase().includes(needle));

  // vendor payment terms + the 1099 W-9 gap
  run(`UPDATE vendors SET terms='2/10 net 30' WHERE id=?`, vendorBy('hvac').id);
  run(`UPDATE vendors SET terms='net 30' WHERE org_id=? AND terms IS NULL`, s.orgId);
  run(`UPDATE vendors SET w9_on_file=0 WHERE id=?`, vendorBy('painting').id);

  const mkLines = (specs: [any, number][]): { catalogItemId: string; description: string; qty: number; unitPriceCents: number; glAccount: string }[] =>
    specs.map(([c, qty]) => ({ catalogItemId: c.id, description: c.name, qty, unitPriceCents: c.unit_price_cents, glAccount: c.gl_account }));

  // ---------- fully-paid history (July): PO → ack → receive → invoice → pay ----------
  const paidSpecs: [string, string, [any, number][], string][] = [
    ['plumbing', 'summit-ridge', [[item('toilet'), 24], [item('disposal'), 4]], '-22'],
    ['hvac', 'summit-ridge', [[item('filter'), 10]], '-19'],
    ['painting', 'foundry-lofts', [[item('paint'), 12], [item('carpet'), 3]], '-16'],
    ['locks', 'cardinal-commons', [[item('lock'), 12], [item('smoke'), 10]], '-13'],
    ['flooring', 'foundry-lofts', [[item('lvp'), 40]], '-10'],
  ];
  const paidInvoices: string[] = [];
  for (const [cat, slug, specs, daysAgo] of paidSpecs) {
    const day = addDays(s.businessDate, Number(daysAgo));
    const dctx = sysCtx(s.orgId, day);
    const poId = createPo(dctx, {
      propertyId: prop(slug), vendorId: vendorBy(cat).id, memo: 'restock & turns', lines: mkLines(specs),
    });
    submitPo(dctx, poId);
    if (q1<any>('SELECT status FROM purchase_orders WHERE id=?', poId).status === 'pending_approval') {
      run(`UPDATE purchase_orders SET status='approved', approved_by='Dana Whitfield', approved_at=?, sent_at=? WHERE id=?`, day, day, poId);
    }
    const ackCtx = sysCtx(s.orgId, addDays(day, 1));
    acknowledgePo(ackCtx, poId);
    const rcvCtx = sysCtx(s.orgId, addDays(day, 3));
    receivePo(rcvCtx, poId, q<any>('SELECT id, qty FROM purchase_order_lines WHERE po_id=?', poId).map((l) => ({ poLineId: l.id, qty: l.qty })));
    const ocr = ocrInvoiceFromPo(s.orgId, poId, 'seed');
    const invCtx = sysCtx(s.orgId, addDays(day, 4));
    const { invoiceId, match } = submitPoInvoice(invCtx, {
      poId, invoiceNumber: ocr.invoiceNumber, invoiceDate: addDays(day, 4), lines: ocr.lines,
    });
    if (match.status === 'matched') paidInvoices.push(invoiceId);
  }
  if (paidInvoices.length) {
    createPaymentRun(sysCtx(s.orgId, addDays(s.businessDate, -6)), {
      runDate: addDays(s.businessDate, -6), method: 'ach', invoiceIds: paidInvoices,
    });
  }
  log(`procurement history: ${paidSpecs.length} POs received, matched and paid`);

  // ---------- the seeded EXCEPTION: price variance beyond tolerance ----------
  const excDay = addDays(s.businessDate, -5);
  const excCtx = sysCtx(s.orgId, excDay);
  const excPo = createPo(excCtx, {
    propertyId: prop('summit-ridge'), vendorId: vendorBy('electrical').id,
    memo: 'stairwell lighting retrofit', lines: mkLines([[item('smoke'), 30]]),
  });
  submitPo(excCtx, excPo);
  if (q1<any>('SELECT status FROM purchase_orders WHERE id=?', excPo).status === 'pending_approval') {
    run(`UPDATE purchase_orders SET status='approved', approved_by='Dana Whitfield', approved_at=?, sent_at=? WHERE id=?`, excDay, excDay, excPo);
  }
  acknowledgePo(excCtx, excPo);
  receivePo(excCtx, excPo, q<any>('SELECT id, qty FROM purchase_order_lines WHERE po_id=?', excPo).map((l) => ({ poLineId: l.id, qty: l.qty })));
  const excOcr = ocrInvoiceFromPo(s.orgId, excPo, 'seed', { exception: true });
  submitPoInvoice(sysCtx(s.orgId, addDays(excDay, 1)), {
    poId: excPo, invoiceNumber: excOcr.invoiceNumber, invoiceDate: addDays(excDay, 1), lines: excOcr.lines,
  });
  log('one invoice mis-priced above tolerance — waiting in the match exception queue');

  // ---------- live pipeline states ----------
  // awaiting approval (large, project-coded → commits capital budget)
  const project = q1<any>(`SELECT * FROM capital_projects WHERE org_id=? LIMIT 1`, s.orgId);
  const bigCtx = sysCtx(s.orgId, addDays(s.businessDate, -2));
  const bigPo = createPo(bigCtx, {
    propertyId: project?.property_id || prop('foundry-lofts'), vendorId: vendorBy('roofing').id,
    memo: 'Roof project — final flashing & contingency materials', neededBy: addDays(s.businessDate, 12),
    lines: [
      { catalogItemId: null, description: 'Parapet flashing kit (custom bent)', qty: 12, unitPriceCents: 48500, glAccount: '1500', projectId: project?.id || null, costCode: 'RB-300' },
      { catalogItemId: null, description: 'Walk-pad membrane rolls', qty: 6, unitPriceCents: 21500, glAccount: '1500', projectId: project?.id || null, costCode: 'RB-400' },
    ],
  });
  run(`UPDATE purchase_orders SET status='pending_approval' WHERE id=?`, bigPo); // over threshold — awaits pos:approve

  // awaiting vendor acknowledgment
  const ackPo = createPo(ctx, {
    propertyId: prop('summit-ridge'), vendorId: vendorBy('hvac').id, memo: 'fall filter program',
    neededBy: addDays(s.businessDate, 9), lines: mkLines([[item('filter'), 20]]),
  });
  submitPo(ctx, ackPo);
  run(`UPDATE purchase_orders SET status='approved', approved_by='Dana Whitfield', approved_at=?, sent_at=? WHERE id=? AND status='pending_approval'`, s.businessDate, s.businessDate, ackPo);

  // acknowledged + partially received
  const partDay = addDays(s.businessDate, -4);
  const partCtx = sysCtx(s.orgId, partDay);
  const partPo = createPo(partCtx, {
    propertyId: prop('cardinal-commons'), vendorId: vendorBy('pest').id, memo: 'move-in prep supplies',
    lines: mkLines([[item('paint'), 6], [item('toilet'), 8]]),
  });
  submitPo(partCtx, partPo);
  run(`UPDATE purchase_orders SET status='approved', approved_by='Dana Whitfield', approved_at=?, sent_at=? WHERE id=? AND status='pending_approval'`, partDay, partDay, partPo);
  acknowledgePo(partCtx, partPo);
  const partLines = q<any>('SELECT id, qty FROM purchase_order_lines WHERE po_id=?', partPo);
  receivePo(sysCtx(s.orgId, addDays(partDay, 2)), partPo, [{ poLineId: partLines[0].id, qty: Math.ceil(partLines[0].qty / 2) }]);

  // a draft
  createPo(ctx, {
    propertyId: prop('foundry-lofts'), vendorId: vendorBy('cleaning').id, memo: 'quarterly deep-clean supplies (draft)',
    lines: mkLines([[item('office'), 4]]),
  });

  const total = val<number>('SELECT COUNT(*) FROM purchase_orders WHERE org_id=?', s.orgId) || 0;
  log(`purchasing pipeline: ${total} POs (paid, exception, pending approval, awaiting ack, partial, draft)`);
}
