import { html, when, join } from '../../lib/html.ts';
import { notFound, redirect, type Router } from '../../lib/http.ts';
import { requirePerm, propFilter, can, type Ctx } from '../../lib/auth.ts';
import { q, q1, val, j } from '../../lib/db.ts';
import { fmtDate } from '../../lib/dates.ts';
import { usd, parseUsd } from '../../lib/money.ts';
import { getSetting } from '../../lib/settings.ts';
import { shell, card, tbl, dl, statusBadge, field, select, input, textarea, registerNav, kpis, tabs, historyPanel, moneyInput, emptyState } from '../../ui/ui.ts';
import { COA } from './coa.ts';
import { createInvoice, submitInvoice, approveInvoice, rejectInvoice, voidInvoice, createPaymentRun, voidApPayment, apAging, apStats } from './ap.ts';

/** M9.6 — AP screens: invoice entry with GL splits, approval queue, payment
 * runs, positive-pay register with void/reissue, AP aging. */

registerNav('Money', { href: '/ap', label: 'Payables', perm: 'ap:view', match: ['/ap'] });

const EXPENSE_OPTS = COA.filter(([, , t]) => t === 'expense' || t === 'asset').map(([c, n]): [string, string] => [c, `${c} — ${n}`]);

export function routes(r: Router): void {
  // ---------- invoice list ----------
  r.get('/ap', requirePerm('ap:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const status = rq.query.get('status') || 'open';
    const where = status === 'open' ? `('pending_approval','approved')` : status === 'all' ? `('draft','pending_approval','approved','paid','void')` : `('${status}')`;
    const pf = propFilter(ctx, 'vi.property_id');
    const rows = q<any>(
      `SELECT vi.*, v.name AS vendor, p.name AS property FROM vendor_invoices vi
       JOIN vendors v ON v.id=vi.vendor_id JOIN properties p ON p.id=vi.property_id
       WHERE vi.org_id=? AND vi.status IN ${where}${pf.sql} ORDER BY vi.invoice_date DESC LIMIT 200`,
      ctx.orgId, ...pf.params,
    );
    const s = apStats(ctx);
    const counts = (st: string): number => val<number>(`SELECT COUNT(*) FROM vendor_invoices WHERE org_id=? AND status=?`, ctx.orgId, st) || 0;
    return shell(rq, {
      title: 'Accounts payable',
      active: '/ap',
      subtitle: 'Vendor invoices, approvals and payment runs',
      actions: html`<a class="btn btn-ghost" href="/ap/aging">AP aging</a> <a class="btn btn-ghost" href="/ap/runs">Payment register</a> ${when(can(ctx, 'ap:manage'), () => html`<a class="btn" href="/ap/new">Enter invoice</a>`)}`,
      content: html`
        ${kpis([
          { label: 'Open payables', value: usd(s.openCents) },
          { label: 'Approved invoices', value: String(s.open) },
          { label: 'Awaiting approval', value: String(s.pendingApproval), tone: s.pendingApproval ? 'warn' : undefined },
          { label: 'Paid this month', value: usd(s.paidThisMonth) },
        ])}
        ${tabs([
          { href: '/ap?status=open', label: 'Open', active: status === 'open' },
          { href: '/ap?status=pending_approval', label: 'Needs approval', active: status === 'pending_approval', count: counts('pending_approval') },
          { href: '/ap?status=draft', label: 'Draft', active: status === 'draft', count: counts('draft') },
          { href: '/ap?status=paid', label: 'Paid', active: status === 'paid' },
          { href: '/ap?status=all', label: 'All', active: status === 'all' },
        ])}
        ${card(null, tbl(
          [{ label: 'Invoice' }, { label: 'Vendor' }, { label: 'Property' }, { label: 'Invoice date' }, { label: 'Due' }, { label: 'Status' }, { label: 'Amount', num: true }],
          rows.map((v) => ({
            href: `/ap/${v.id}`,
            cells: [html`<span class="mono">${v.invoice_number}</span>`, v.vendor, v.property, fmtDate(v.invoice_date), fmtDate(v.due_date), statusBadge(v.status), usd(v.total_cents)],
          })),
          { empty: 'No invoices here.' },
        ), { flush: true })}`,
    });
  });

  // ---------- invoice entry ----------
  r.get('/ap/new', requirePerm('ap:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const pf = propFilter(ctx, 'id');
    const props = q<any>(`SELECT id, name FROM properties WHERE org_id=?${pf.sql} ORDER BY name`, ctx.orgId, ...pf.params);
    const vendors = q<any>('SELECT id, name FROM vendors WHERE org_id=? AND active=1 ORDER BY name', ctx.orgId);
    const projects = q<any>(`SELECT id, name FROM capital_projects WHERE org_id=? AND status='active'`, ctx.orgId);
    const lineRow = (i: number) => html`
      <tr>
        <td>${select(`gl_${i}`, EXPENSE_OPTS, i === 0 ? '5010' : '', { blank: i === 0 ? undefined : '—' })}</td>
        <td>${input(`desc_${i}`, { placeholder: 'Line description' })}</td>
        <td>${select(`prop_${i}`, props.map((p: any): [string, string] => [p.id, p.name]), '', { blank: 'Invoice property' })}</td>
        <td>${select(`proj_${i}`, projects.map((p: any): [string, string] => [p.id, p.name]), '', { blank: '—' })}</td>
        <td>${moneyInput(`amt_${i}`)}</td>
      </tr>`;
    return shell(rq, {
      title: 'Enter vendor invoice',
      active: '/ap',
      content: html`
        <form method="post" action="/ap/new">
          ${card('Invoice', html`
            <div class="grid2">
              ${field('Vendor', select('vendor_id', vendors.map((v: any): [string, string] => [v.id, v.name]), '', { required: true }))}
              ${field('Property', select('property_id', props.map((p: any): [string, string] => [p.id, p.name]), ctx.currentPropertyId || '', { required: true }))}
              ${field('Invoice #', input('invoice_number', { required: true, placeholder: 'e.g. 10442' }))}
              ${field('Invoice date', input('invoice_date', { type: 'date', value: ctx.businessDate, required: true }))}
              ${field('Due date', input('due_date', { type: 'date' }), 'defaults to net-30')}
              ${field('Memo', input('memo', { placeholder: 'optional' }))}
            </div>`)}
          ${card('GL coding (splits allowed)', html`
            <table class="tbl"><thead><tr><th>Account</th><th>Description</th><th>Property (split)</th><th>Capital project</th><th>Amount</th></tr></thead>
            <tbody>${join([0, 1, 2, 3].map(lineRow), '')}</tbody></table>
            <p class="small muted">Leave extra rows empty. Lines can hit a different property — inter-property due-to/due-from posts automatically when paid centrally.</p>`)}
          <div class="toolbar"><button class="btn">Save draft</button> <button class="btn" name="and_submit" value="1">Save &amp; submit for approval</button></div>
        </form>`,
    });
  });

  r.post('/ap/new', requirePerm('ap:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const b = rq.body!;
    const lines = [0, 1, 2, 3]
      .filter((i) => b[`gl_${i}`] && String(b[`amt_${i}`] || '').trim() && parseUsd(String(b[`amt_${i}`])) > 0)
      .map((i) => ({
        glAccount: String(b[`gl_${i}`]),
        description: String(b[`desc_${i}`] || 'Invoice line'),
        amountCents: parseUsd(String(b[`amt_${i}`])),
        propertyId: String(b[`prop_${i}`] || '') || undefined,
        projectId: String(b[`proj_${i}`] || '') || null,
      }));
    try {
      const invId = createInvoice(ctx, {
        vendorId: String(b.vendor_id), propertyId: String(b.property_id),
        invoiceNumber: String(b.invoice_number), invoiceDate: String(b.invoice_date),
        dueDate: String(b.due_date || '') || undefined, memo: String(b.memo || '') || undefined, lines,
      });
      if (b.and_submit) {
        const res = submitInvoice(ctx, invId);
        return redirect(`/ap/${invId}`, res === 'approved' ? 'Invoice approved and posted to AP' : 'Invoice submitted for approval');
      }
      return redirect(`/ap/${invId}`, 'Draft saved');
    } catch (e) {
      return redirect('/ap/new', `Could not save: ${(e as Error).message}`, 'err');
    }
  });

  // ---------- AP aging ----------
  r.get('/ap/aging', requirePerm('ap:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const rows = apAging(ctx);
    return shell(rq, {
      title: 'AP aging',
      active: '/ap',
      subtitle: `Open payables by vendor · as of ${fmtDate(ctx.businessDate)}`,
      content: card(null, tbl(
        [{ label: 'Vendor' }, { label: 'Current', num: true }, { label: '1-30', num: true }, { label: '31-60', num: true }, { label: '60+', num: true }, { label: 'Total', num: true }],
        rows.map((r2) => ({ cells: [r2.vendor, ...r2.buckets.map((b) => (b ? usd(b) : '')), html`<b>${usd(r2.total)}</b>`] })),
        { empty: 'Nothing outstanding — every approved invoice is paid.' },
      ), { flush: true }),
    });
  });

  // ---------- payment runs / register ----------
  r.get('/ap/runs', requirePerm('ap:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const payable = q<any>(
      `SELECT vi.*, v.name AS vendor FROM vendor_invoices vi JOIN vendors v ON v.id=vi.vendor_id
       WHERE vi.org_id=? AND vi.status='approved' ORDER BY vi.due_date LIMIT 100`, ctx.orgId,
    );
    const register = q<any>(
      `SELECT ap.*, v.name AS vendor, r.run_date, p.name AS property FROM ap_payments ap
       JOIN vendors v ON v.id=ap.vendor_id JOIN ap_payment_runs r ON r.id=ap.run_id JOIN properties p ON p.id=ap.property_id
       WHERE ap.org_id=? ORDER BY CAST(ap.check_number AS INTEGER) DESC LIMIT 100`, ctx.orgId,
    );
    return shell(rq, {
      title: 'Payment runs',
      active: '/ap',
      subtitle: 'Select approved invoices to pay; the register below is your positive-pay file',
      content: html`
        ${when(can(rq.ctx as Ctx, 'ap:pay'), () => card('Ready to pay', payable.length ? html`
          <form method="post" action="/ap/runs/new">
            ${tbl(
              [{ label: '' }, { label: 'Vendor' }, { label: 'Invoice' }, { label: 'Due' }, { label: 'Amount', num: true }],
              payable.map((v) => ({ cells: [html`<input type="checkbox" name="invoice_ids" value="${v.id}" checked>`, v.vendor, () => html`<span class="mono">${v.invoice_number}</span>`, fmtDate(v.due_date), usd(v.total_cents)] })),
            )}
            <div class="toolbar">
              ${field('Method', select('method', [['check', 'Check run'], ['ach', 'ACH batch']], 'check'))}
              <button class="btn">Process payment run</button>
            </div>
          </form>` : emptyState('Nothing approved and unpaid', 'Approve invoices to queue them here.')))}
        ${card('Check & ACH register (positive pay)', tbl(
          [{ label: 'Check/Ref' }, { label: 'Date' }, { label: 'Vendor' }, { label: 'Account' }, { label: 'Method' }, { label: 'Status' }, { label: 'Amount', num: true }, { label: '' }],
          register.map((p) => ({
            cells: [
              html`<span class="mono">${p.check_number}</span>`, fmtDate(p.run_date), p.vendor, p.property, p.method,
              statusBadge(p.status), usd(p.amount_cents),
              p.status === 'issued' && can(rq.ctx as Ctx, 'ap:pay')
                ? html`<form method="post" action="/ap/payments/${p.id}/void" data-confirm="Void and reissue this check?"><input type="hidden" name="reissue" value="1"><button class="btn btn-ghost btn-sm">Void + reissue</button></form>`
                : '',
            ],
          })),
          { empty: 'No payments issued yet.' },
        ), { flush: true })}`,
    });
  });

  // ---------- invoice detail ----------
  r.get('/ap/:id', requirePerm('ap:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const v = q1<any>(
      `SELECT vi.*, v.name AS vendor, p.name AS property FROM vendor_invoices vi
       JOIN vendors v ON v.id=vi.vendor_id JOIN properties p ON p.id=vi.property_id WHERE vi.id=? AND vi.org_id=?`,
      rq.params.id!, ctx.orgId,
    );
    if (!v) return notFound();
    const lines = q<any>(
      `SELECT l.*, p.name AS property, cp.name AS project FROM vendor_invoice_lines l
       JOIN properties p ON p.id=l.property_id LEFT JOIN capital_projects cp ON cp.id=l.project_id
       WHERE l.invoice_id=?`, v.id,
    );
    const pays = q<any>(`SELECT ap.*, r.run_date, r.method AS run_method FROM ap_payments ap JOIN ap_payment_runs r ON r.id=ap.run_id WHERE ap.invoice_id=? ORDER BY ap.created_at`, v.id);
    const threshold = getSetting<number>(ctx, 'invoice_approval_threshold_cents', v.property_id);
    return shell(rq, {
      title: `Invoice ${v.invoice_number}`,
      active: '/ap',
      subtitle: html`${v.vendor} · ${v.property} · ${statusBadge(v.status)}`,
      actions: html`
        ${when(v.status === 'draft' && can(ctx, 'ap:manage'), () => html`<form method="post" action="/ap/${v.id}/submit" style="display:inline"><button class="btn">Submit for approval</button></form>`)}
        ${when(v.status === 'pending_approval' && can(ctx, 'ap:approve'), () => html`
          <form method="post" action="/ap/${v.id}/approve" style="display:inline"><button class="btn">Approve &amp; post</button></form>
          <form method="post" action="/ap/${v.id}/reject" style="display:inline"><input type="hidden" name="reason" value="returned for edits"><button class="btn btn-ghost">Return</button></form>`)}
        ${when(v.status === 'approved' && can(ctx, 'ap:pay'), () => html`<form method="post" action="/ap/runs/new" style="display:inline"><input type="hidden" name="invoice_ids" value="${v.id}"><button class="btn">Pay now</button></form>`)}
        ${when(['draft', 'pending_approval', 'approved'].includes(v.status) && can(ctx, 'ap:manage'), () => html`<form method="post" action="/ap/${v.id}/void" style="display:inline" data-confirm="Void this invoice?"><input type="hidden" name="reason" value="entered in error"><button class="btn btn-ghost">Void</button></form>`)}`,
      content: html`
        <div class="cols">
          <div>
            ${card('Details', dl([
              ['Vendor', v.vendor], ['Invoice #', () => html`<span class="mono">${v.invoice_number}</span>`],
              ['Invoice date', fmtDate(v.invoice_date)], ['Due', fmtDate(v.due_date)],
              ['Amount', () => html`<b>${usd(v.total_cents)}</b>`], ['Source', v.source],
              ['Memo', v.memo || '—'],
              ['Approval', v.approved_by ? `${v.approved_by} · ${fmtDate((v.approved_at || '').slice(0, 10))}` : v.total_cents > threshold ? `requires ap:approve (over ${usd(threshold)})` : 'auto under threshold'],
            ]))}
            ${card('GL coding', tbl(
              [{ label: 'Account' }, { label: 'Description' }, { label: 'Property' }, { label: 'Project' }, { label: 'Amount', num: true }],
              lines.map((l) => ({ cells: [html`<span class="mono">${l.gl_account}</span>`, l.description, l.property, l.project || '—', usd(l.amount_cents)] })),
            ), { flush: true })}
            ${when(pays.length, () => card('Payments', tbl(
              [{ label: 'Check/Ref' }, { label: 'Run date' }, { label: 'Method' }, { label: 'Status' }, { label: 'Cleared' }, { label: 'Amount', num: true }],
              pays.map((p) => ({ cells: [html`<span class="mono">${p.check_number}</span>`, fmtDate(p.run_date), p.method, statusBadge(p.status), p.cleared_date ? fmtDate(p.cleared_date) : '—', usd(p.amount_cents)] })),
            ), { flush: true }))}
          </div>
          <div>${historyPanel(ctx.orgId, 'vendor_invoice', v.id)}</div>
        </div>`,
    });
  });

  r.post('/ap/:id/submit', requirePerm('ap:manage'), (rq) => {
    const res = submitInvoice(rq.ctx as Ctx, rq.params.id!);
    return redirect(`/ap/${rq.params.id}`, res === 'approved' ? 'Approved and posted to AP' : 'Submitted for approval');
  });
  r.post('/ap/:id/approve', requirePerm('ap:approve'), (rq) => {
    approveInvoice(rq.ctx as Ctx, rq.params.id!);
    return redirect(`/ap/${rq.params.id}`, 'Invoice approved — accrual posted');
  });
  r.post('/ap/:id/reject', requirePerm('ap:approve'), (rq) => {
    rejectInvoice(rq.ctx as Ctx, rq.params.id!, String(rq.body?.reason || 'returned'));
    return redirect(`/ap/${rq.params.id}`, 'Returned to draft');
  });
  r.post('/ap/:id/void', requirePerm('ap:manage'), (rq) => {
    voidInvoice(rq.ctx as Ctx, rq.params.id!, String(rq.body?.reason || 'void'));
    return redirect(`/ap/${rq.params.id}`, 'Invoice voided');
  });

  r.post('/ap/runs/new', requirePerm('ap:pay'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const ids = ([] as string[]).concat((rq.body?.invoice_ids as string[] | string) || []);
    if (!ids.length) return redirect('/ap/runs', 'Select at least one invoice', 'err');
    try {
      const runId = createPaymentRun(ctx, {
        runDate: ctx.businessDate, method: (String(rq.body?.method || 'check') as 'check' | 'ach'), invoiceIds: ids,
      });
      const n = val<number>('SELECT COUNT(*) FROM ap_payments WHERE run_id=?', runId) || 0;
      return redirect('/ap/runs', `Payment run processed — ${n} payment${n === 1 ? '' : 's'} issued`);
    } catch (e) {
      return redirect('/ap/runs', `Run failed: ${(e as Error).message}`, 'err');
    }
  });

  r.post('/ap/payments/:id/void', requirePerm('ap:pay'), (rq) => {
    const ctx = rq.ctx as Ctx;
    try {
      voidApPayment(ctx, rq.params.id!, 'voided from register', rq.body?.reissue === '1');
      return redirect('/ap/runs', 'Payment voided' + (rq.body?.reissue === '1' ? ' and reissued' : ''));
    } catch (e) {
      return redirect('/ap/runs', (e as Error).message, 'err');
    }
  });
}
