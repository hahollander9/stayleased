import { q, q1, insert, run, val, tx, update, j, js } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, addDays } from '../../lib/dates.ts';
import type { Ctx } from '../../lib/auth.ts';
import { can } from '../../lib/auth.ts';
import { emit } from '../../lib/events.ts';
import { audit } from '../../lib/audit.ts';
import { getSetting } from '../../lib/settings.ts';
import { postJE } from './service.ts';

/** M9.6 — accounts payable: vendor invoices with split GL coding, approval
 * routing by amount, payment runs (simulated check/ACH), positive-pay-style
 * register with void/reissue, and inter-property due-to/due-from automation. */

export interface InvoiceLineInput {
  glAccount: string;
  description: string;
  amountCents: number;
  propertyId?: string; // defaults to invoice property (splits allowed)
  unitId?: string | null;
  projectId?: string | null;
  costCode?: string | null;
}

export interface InvoiceInput {
  vendorId: string;
  propertyId: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate?: string;
  memo?: string;
  source?: string;
  sourceId?: string | null;
  lines: InvoiceLineInput[];
}

export function createInvoice(ctx: Ctx, input: InvoiceInput): string {
  if (!input.lines.length) throw new Error('an invoice needs at least one line');
  if (input.lines.some((l) => l.amountCents <= 0)) throw new Error('line amounts must be positive');
  const vendor = q1<any>('SELECT * FROM vendors WHERE id=? AND org_id=?', input.vendorId, ctx.orgId);
  if (!vendor) throw new Error('vendor not found');
  const total = input.lines.reduce((s, l) => s + l.amountCents, 0);
  const invId = id('vin');
  tx(() => {
    insert('vendor_invoices', {
      id: invId, org_id: ctx.orgId, property_id: input.propertyId, vendor_id: input.vendorId,
      invoice_number: input.invoiceNumber, invoice_date: input.invoiceDate,
      due_date: input.dueDate || addDays(input.invoiceDate, 30), memo: input.memo || null,
      status: 'draft', total_cents: total, source: input.source || 'manual', source_id: input.sourceId ?? null,
      created_by: ctx.userId, created_at: nowIso(),
    });
    for (const l of input.lines) {
      insert('vendor_invoice_lines', {
        id: id('vil'), org_id: ctx.orgId, invoice_id: invId, gl_account: l.glAccount,
        description: l.description, amount_cents: l.amountCents,
        property_id: l.propertyId || input.propertyId, unit_id: l.unitId ?? null,
        project_id: l.projectId ?? null, cost_code: l.costCode ?? null, created_at: nowIso(),
      });
    }
  });
  audit(ctx, 'vendor_invoice', invId, 'create', null, { totalCents: total, vendor: vendor.name });
  return invId;
}

/** submit for approval — auto-approves under the property threshold when the
 * submitter can approve; larger invoices route to ap:approve holders. */
export function submitInvoice(ctx: Ctx, invoiceId: string): 'approved' | 'pending_approval' {
  const inv = q1<any>('SELECT * FROM vendor_invoices WHERE id=? AND org_id=?', invoiceId, ctx.orgId);
  if (!inv || inv.status !== 'draft') throw new Error('invoice not in draft');
  const threshold = getSetting<number>(ctx, 'invoice_approval_threshold_cents', inv.property_id);
  if (inv.total_cents <= threshold && can(ctx, 'ap:approve')) {
    approveInvoice(ctx, invoiceId);
    return 'approved';
  }
  run(`UPDATE vendor_invoices SET status='pending_approval' WHERE id=?`, invoiceId);
  emit(ctx, 'invoice.submitted', 'vendor_invoice', invoiceId, { totalCents: inv.total_cents });
  audit(ctx, 'vendor_invoice', invoiceId, 'submit');
  return 'pending_approval';
}

/** approval posts the accrual: DR expense lines (line property) / CR 2010. */
export function approveInvoice(ctx: Ctx, invoiceId: string): void {
  const inv = q1<any>('SELECT * FROM vendor_invoices WHERE id=? AND org_id=?', invoiceId, ctx.orgId);
  if (!inv || !['draft', 'pending_approval'].includes(inv.status)) throw new Error('invoice not approvable');
  const lines = q<any>('SELECT * FROM vendor_invoice_lines WHERE invoice_id=?', invoiceId);
  tx(() => {
    // one accrual JE per property represented on the invoice (books are per-property)
    const byProp = new Map<string, any[]>();
    for (const l of lines) {
      byProp.set(l.property_id, [...(byProp.get(l.property_id) || []), l]);
    }
    let firstJe: string | null = null;
    for (const [propId, propLines] of byProp) {
      const sub = propLines.reduce((s, l) => s + l.amount_cents, 0);
      const jeId = postJE(ctx, {
        propertyId: propId, date: inv.invoice_date, basis: 'accrual',
        memo: `Invoice ${inv.invoice_number} — ${vendorName(ctx, inv.vendor_id)}`,
        sourceKind: 'invoice', sourceId: invoiceId,
        lines: [
          ...propLines.map((l) => ({ account: l.gl_account, debit: l.amount_cents, memo: l.description })),
          { account: '2010', credit: sub },
        ],
      });
      firstJe = firstJe || jeId;
    }
    run(`UPDATE vendor_invoices SET status='approved', je_id=?, approved_by=?, approved_at=? WHERE id=?`, firstJe, ctx.userName, nowIso(), invoiceId);
  });
  emit(ctx, 'invoice.approved', 'vendor_invoice', invoiceId, { totalCents: inv.total_cents });
  audit(ctx, 'vendor_invoice', invoiceId, 'approve', null, { totalCents: inv.total_cents });
}

export function rejectInvoice(ctx: Ctx, invoiceId: string, reason: string): void {
  const inv = q1<any>('SELECT * FROM vendor_invoices WHERE id=? AND org_id=?', invoiceId, ctx.orgId);
  if (!inv || inv.status !== 'pending_approval') throw new Error('invoice not pending');
  run(`UPDATE vendor_invoices SET status='draft', memo=COALESCE(memo,'')||' [returned: '||?||']' WHERE id=?`, reason, invoiceId);
  audit(ctx, 'vendor_invoice', invoiceId, 'reject', null, { reason });
}

export function voidInvoice(ctx: Ctx, invoiceId: string, reason: string): void {
  const inv = q1<any>('SELECT * FROM vendor_invoices WHERE id=? AND org_id=?', invoiceId, ctx.orgId);
  if (!inv || !['draft', 'pending_approval', 'approved'].includes(inv.status)) throw new Error('invoice not voidable');
  tx(() => {
    if (inv.status === 'approved') {
      // reverse the accrual(s)
      for (const je of q<any>(`SELECT * FROM journal_entries WHERE org_id=? AND source_kind='invoice' AND source_id=? AND basis='accrual' AND reversal_of IS NULL`, ctx.orgId, invoiceId)) {
        const jl = q<any>('SELECT * FROM journal_lines WHERE entry_id=?', je.id);
        postJE(ctx, {
          propertyId: je.property_id, date: ctx.businessDate, basis: 'accrual',
          memo: `VOID ${inv.invoice_number}: ${reason}`, sourceKind: 'invoice', sourceId: invoiceId, reversalOf: je.id,
          lines: jl.filter((l: any) => l.debit_cents || l.credit_cents).map((l: any) => ({ account: l.account_code, debit: l.credit_cents || undefined, credit: l.debit_cents || undefined })),
        });
      }
    }
    run(`UPDATE vendor_invoices SET status='void' WHERE id=?`, invoiceId);
  });
  audit(ctx, 'vendor_invoice', invoiceId, 'void', null, { reason });
}

function vendorName(ctx: Ctx, vendorId: string): string {
  return q1<any>('SELECT name FROM vendors WHERE id=?', vendorId)?.name || 'vendor';
}

// ---------- payment runs (M9.6) ----------

function nextCheckNumber(orgId: string): string {
  const max = val<number>(
    `SELECT COALESCE(MAX(CAST(check_number AS INTEGER)), 5000) FROM ap_payments WHERE org_id=? AND check_number GLOB '[0-9]*'`,
    orgId,
  ) || 5000;
  return String(max + 1);
}

/** Pay approved invoices. Cash leaves the *paying* property's account; when it
 * differs from the invoice property, due-to/due-from automation kicks in. */
export function createPaymentRun(
  ctx: Ctx,
  opts: { runDate: string; method: 'check' | 'ach'; invoiceIds: string[]; payFromPropertyId?: string | null },
): string {
  const invoices = opts.invoiceIds.map((iid) => {
    const inv = q1<any>(`SELECT * FROM vendor_invoices WHERE id=? AND org_id=? AND status='approved'`, iid, ctx.orgId);
    if (!inv) throw new Error(`invoice ${iid} is not approved/payable`);
    return inv;
  });
  if (!invoices.length) throw new Error('nothing to pay');
  const runId = id('apr');
  tx(() => {
    insert('ap_payment_runs', {
      id: runId, org_id: ctx.orgId, run_date: opts.runDate, method: opts.method,
      status: 'processed', total_cents: invoices.reduce((s, i) => s + i.total_cents, 0),
      created_by: ctx.userId, created_at: nowIso(),
    });
    for (const inv of invoices) {
      const payer = opts.payFromPropertyId || inv.property_id;
      const payId = id('app');
      const checkNo = nextCheckNumber(ctx.orgId);
      const jeId = postApJes(ctx, inv, payer, opts.runDate, checkNo);
      insert('ap_payments', {
        id: payId, org_id: ctx.orgId, run_id: runId, invoice_id: inv.id, vendor_id: inv.vendor_id,
        property_id: payer, amount_cents: inv.total_cents, method: opts.method,
        check_number: checkNo, status: 'issued', je_id: jeId, created_at: nowIso(),
      });
      run(`UPDATE vendor_invoices SET status='paid', paid_at=? WHERE id=?`, nowIso(), inv.id);
      emit(ctx, 'invoice.paid', 'vendor_invoice', inv.id, { runId, method: opts.method, checkNumber: checkNo });
    }
  });
  audit(ctx, 'ap_payment_run', runId, 'process', null, { invoices: invoices.length, method: opts.method });
  return runId;
}

/** accrual: DR 2010 / CR 1010 (+ due-to/due-from when payer ≠ invoice property);
 * cash basis recognizes the expense at payment. */
function postApJes(ctx: Ctx, inv: any, payerPropId: string, date: string, checkNo: string): string {
  const lines = q<any>('SELECT * FROM vendor_invoice_lines WHERE invoice_id=?', inv.id);
  const vendor = vendorName(ctx, inv.vendor_id);
  const memo = `Pay ${vendor} — inv ${inv.invoice_number} (check ${checkNo})`;
  let jeId = '';
  const intercompany = payerPropId !== inv.property_id;
  if (!intercompany) {
    jeId = postJE(ctx, {
      propertyId: inv.property_id, date, basis: 'accrual', memo, sourceKind: 'ap_payment', sourceId: inv.id,
      lines: [{ account: '2010', debit: inv.total_cents }, { account: '1010', credit: inv.total_cents }],
    });
    postJE(ctx, {
      propertyId: inv.property_id, date, basis: 'cash', memo, sourceKind: 'ap_payment', sourceId: inv.id,
      lines: [
        ...lines.map((l: any) => ({ account: l.gl_account, debit: l.amount_cents, memo: l.description })),
        { account: '1010', credit: inv.total_cents },
      ],
    });
  } else {
    // payer property: cash out, due-from affiliate
    jeId = postJE(ctx, {
      propertyId: payerPropId, date, basis: 'accrual', memo: `${memo} on behalf of affiliate`, sourceKind: 'ap_payment', sourceId: inv.id,
      lines: [{ account: '1300', debit: inv.total_cents }, { account: '1010', credit: inv.total_cents }],
    });
    postJE(ctx, {
      propertyId: payerPropId, date, basis: 'cash', memo: `${memo} on behalf of affiliate`, sourceKind: 'ap_payment', sourceId: inv.id,
      lines: [{ account: '1300', debit: inv.total_cents }, { account: '1010', credit: inv.total_cents }],
    });
    // invoice property: AP relieved, due-to affiliate
    postJE(ctx, {
      propertyId: inv.property_id, date, basis: 'accrual', memo: `${memo} — paid by affiliate`, sourceKind: 'intercompany', sourceId: inv.id,
      lines: [{ account: '2010', debit: inv.total_cents }, { account: '2300', credit: inv.total_cents }],
    });
    postJE(ctx, {
      propertyId: inv.property_id, date, basis: 'cash', memo: `${memo} — paid by affiliate`, sourceKind: 'intercompany', sourceId: inv.id,
      lines: [
        ...lines.map((l: any) => ({ account: l.gl_account, debit: l.amount_cents, memo: l.description })),
        { account: '2300', credit: inv.total_cents },
      ],
    });
  }
  return jeId;
}

/** void a check (positive-pay exception, lost check…) and optionally reissue. */
export function voidApPayment(ctx: Ctx, paymentId: string, reason: string, reissue: boolean): string | null {
  const p = q1<any>('SELECT * FROM ap_payments WHERE id=? AND org_id=?', paymentId, ctx.orgId);
  if (!p || p.status !== 'issued') throw new Error('only issued (uncleared) payments can be voided');
  const inv = q1<any>('SELECT * FROM vendor_invoices WHERE id=?', p.invoice_id);
  let newPayId: string | null = null;
  tx(() => {
    run(`UPDATE ap_payments SET status='void', void_reason=?, voided_at=? WHERE id=?`, reason, nowIso(), paymentId);
    // reverse the payment JEs (both bases, all properties involved)
    for (const je of q<any>(
      `SELECT * FROM journal_entries WHERE org_id=? AND source_kind IN ('ap_payment','intercompany') AND source_id=? AND reversal_of IS NULL
         AND posted_at >= (SELECT created_at FROM ap_payments WHERE id=?)`,
      ctx.orgId, p.invoice_id, paymentId,
    )) {
      const jl = q<any>('SELECT * FROM journal_lines WHERE entry_id=?', je.id);
      postJE(ctx, {
        propertyId: je.property_id, date: ctx.businessDate, basis: je.basis,
        memo: `VOID check ${p.check_number}: ${reason}`, sourceKind: 'ap_void', sourceId: paymentId, reversalOf: je.id,
        lines: jl.filter((l: any) => l.debit_cents || l.credit_cents).map((l: any) => ({ account: l.account_code, debit: l.credit_cents || undefined, credit: l.debit_cents || undefined })),
      });
    }
    run(`UPDATE vendor_invoices SET status='approved', paid_at=NULL WHERE id=?`, p.invoice_id);
    if (reissue) {
      newPayId = createPaymentRun(ctx, {
        runDate: ctx.businessDate, method: p.method as 'check' | 'ach', invoiceIds: [p.invoice_id],
        payFromPropertyId: p.property_id === inv.property_id ? null : p.property_id,
      });
      const np = q1<any>('SELECT id FROM ap_payments WHERE run_id=?', newPayId);
      run('UPDATE ap_payments SET reissued_payment_id=? WHERE id=?', np.id, paymentId);
    }
  });
  audit(ctx, 'ap_payment', paymentId, 'void', null, { reason, reissued: !!newPayId });
  return newPayId;
}

// ---------- AP reporting ----------

export function apAging(ctx: Ctx, propertyId?: string | null): { vendor: string; vendorId: string; buckets: number[]; total: number }[] {
  const rows = q<any>(
    `SELECT vi.*, v.name AS vendor_name FROM vendor_invoices vi JOIN vendors v ON v.id=vi.vendor_id
     WHERE vi.org_id=? AND vi.status='approved' ${propertyId ? 'AND vi.property_id=?' : ''}`,
    ...(propertyId ? [ctx.orgId, propertyId] : [ctx.orgId]),
  );
  const byVendor = new Map<string, { vendor: string; vendorId: string; buckets: number[]; total: number }>();
  for (const r of rows) {
    const age = Math.max(0, Math.round((Date.parse(ctx.businessDate) - Date.parse(r.due_date)) / 86400000));
    const b = age <= 0 ? 0 : age <= 30 ? 1 : age <= 60 ? 2 : 3;
    const cur = byVendor.get(r.vendor_id) || { vendor: r.vendor_name, vendorId: r.vendor_id, buckets: [0, 0, 0, 0], total: 0 };
    cur.buckets[b]! += r.total_cents;
    cur.total += r.total_cents;
    byVendor.set(r.vendor_id, cur);
  }
  return [...byVendor.values()].sort((a, b) => b.total - a.total);
}

export function apStats(ctx: Ctx): { open: number; openCents: number; pendingApproval: number; paidThisMonth: number } {
  const mk = ctx.businessDate.slice(0, 7);
  return {
    open: val<number>(`SELECT COUNT(*) FROM vendor_invoices WHERE org_id=? AND status='approved'`, ctx.orgId) || 0,
    openCents: val<number>(`SELECT COALESCE(SUM(total_cents),0) FROM vendor_invoices WHERE org_id=? AND status='approved'`, ctx.orgId) || 0,
    pendingApproval: val<number>(`SELECT COUNT(*) FROM vendor_invoices WHERE org_id=? AND status='pending_approval'`, ctx.orgId) || 0,
    paidThisMonth: val<number>(
      `SELECT COALESCE(SUM(ap.amount_cents),0) FROM ap_payments ap JOIN ap_payment_runs r ON r.id=ap.run_id
       WHERE ap.org_id=? AND ap.status != 'void' AND substr(r.run_date,1,7)=?`, ctx.orgId, mk,
    ) || 0,
  };
}
