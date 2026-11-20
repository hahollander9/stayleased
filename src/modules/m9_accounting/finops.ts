import { html, when } from '../../lib/html.ts';
import { redirect, notFound, forbidden, type Router, type Rq } from '../../lib/http.ts';
import { requirePerm, requireStaff, can, canAccessProperty, propFilter, type Ctx } from '../../lib/auth.ts';
import { q, q1, run, insert, val } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, fmtDate, diffDays } from '../../lib/dates.ts';
import { usd } from '../../lib/money.ts';
import { audit } from '../../lib/audit.ts';
import { shell, card, tbl, dl, statusBadge, field, input, select, registerNav, emptyState } from '../../ui/ui.ts';
import { depositDeadline } from '../m8_receivables/depositlaw.ts';
import { depositHeld } from '../m8_receivables/payments.ts';
import { COA } from './coa.ts';
import { parseCsv } from '../../lib/csv.ts';
import { importStatementLines, bankLabel, bankAccountFor, bankScopeSql, BANK_NOT_SPECIFIED } from './banking.ts';

/** Financial operations glue (2026-08-03, from Henry's asset-manager
 * walkthrough): (1) /approvals — ONE inbox for everything waiting on a
 * money sign-off (POs over threshold, vendor invoices, large manual JEs,
 * deposit returns coming due), so "the operating officer" has a single
 * queue instead of four screens; (2) real bank-file import (CSV or OFX)
 * so statements can land in the reconciliation workbench without the
 * simulated feed; (3) /gl/setup — bank accounts + chart-of-accounts
 * management so accounting can be configured without touching seed. */

// visible when the user holds ANY approver perm
const APPROVER_PERMS = ['pos:approve', 'ap:approve', 'gl:close_period', 'deposits:manage'];
registerNav('Money', {
  href: '/approvals', label: 'Approvals', match: ['/approvals'],
  show: (ctx) => APPROVER_PERMS.some((p) => can(ctx, p)),
});

/** Everything waiting on a money sign-off, permission-filtered.
 *
 * Extracted from the /approvals route so the simple-mode home screen can
 * render the same queue without a second implementation of it. Two copies of
 * "what needs approving" would drift the first time a threshold moved, and
 * they would drift silently: both would still look like working screens. The
 * route below and Home now ask the same function, so the count on Home is the
 * count on /approvals by construction rather than by coincidence. */
export interface MoneyApprovals {
  pos: any[];
  invoices: any[];
  jes: any[];
  deposits: any[];
  total: number;
}

export function canApproveMoney(ctx: Ctx): boolean {
  return APPROVER_PERMS.some((p) => can(ctx, p));
}

export function moneyApprovals(ctx: Ctx): MoneyApprovals {
  const pos = can(ctx, 'pos:approve')
    ? q<any>(`SELECT po.*, v.name AS vendor_name, p.name AS prop_name FROM purchase_orders po
              JOIN vendors v ON v.id=po.vendor_id JOIN properties p ON p.id=po.property_id
              WHERE po.org_id=? AND po.status='pending_approval' ORDER BY po.created_at`, ctx.orgId)
    : [];
  const invoices = can(ctx, 'ap:approve')
    ? q<any>(`SELECT i.*, v.name AS vendor_name, p.name AS prop_name FROM vendor_invoices i
              JOIN vendors v ON v.id=i.vendor_id JOIN properties p ON p.id=i.property_id
              WHERE i.org_id=? AND i.status='pending_approval' ORDER BY i.due_date`, ctx.orgId)
    : [];
  const jes = can(ctx, 'gl:close_period')
    ? q<any>(`SELECT * FROM pending_jes WHERE org_id=? AND status='pending' ORDER BY created_at`, ctx.orgId)
    : [];
  const deposits = can(ctx, 'deposits:manage')
    ? q<any>(`SELECT l.id, l.property_id, l.household_name, l.move_out_date, p.name AS prop_name, p.state AS state
              FROM leases l JOIN properties p ON p.id=l.property_id
              WHERE l.org_id=? AND l.status='ended' AND l.move_out_date IS NOT NULL ORDER BY l.move_out_date`, ctx.orgId)
        .map((l) => ({ ...l, held: depositHeld(ctx, l.id), dl: depositDeadline(ctx, l.property_id, l.state, l.move_out_date) }))
        .filter((l) => l.held > 0 && l.dl.daysLeft !== null && l.dl.daysLeft <= 10)
    : [];
  return { pos, invoices, jes, deposits, total: pos.length + invoices.length + jes.length + deposits.length };
}

export function routes(r: Router): void {
  // ---------------- the approver's single queue ----------------
  r.get('/approvals', requireStaff, (rq) => {
    const ctx = rq.ctx as Ctx;
    if (!canApproveMoney(ctx)) return forbidden();
    const { pos, invoices, jes, deposits, total } = moneyApprovals(ctx);
    return shell(rq, {
      title: 'Approvals',
      active: '/approvals',
      subtitle: total ? `${total} item${total === 1 ? '' : 's'} waiting on a decision` : 'Nothing is waiting on you.',
      content: html`
        ${when(pos.length, () => card(html`Purchase orders over threshold <span class="badge warn">${pos.length}</span>`, tbl(
          [{ label: 'PO' }, { label: 'Vendor' }, { label: 'Property' }, { label: 'Needed by' }, { label: 'Total', num: true }, { label: '' }],
          pos.map((po) => ({
            cells: [html`<a href="/purchasing/${po.id}"><b>${po.po_number}</b></a>${po.memo ? html` <span class="muted small">${po.memo}</span>` : ''}`,
              po.vendor_name, po.prop_name, po.needed_by ? fmtDate(po.needed_by) : '—', usd(po.total_cents),
              html`<form method="post" action="/purchasing/${po.id}/approve" style="display:inline"><button class="btn btn-sm">Approve &amp; send</button></form>`],
          })), { empty: '' },
        ), { flush: true }))}
        ${when(invoices.length, () => card(html`Vendor invoices <span class="badge warn">${invoices.length}</span>`, tbl(
          [{ label: 'Invoice' }, { label: 'Vendor' }, { label: 'Property' }, { label: 'Due' }, { label: 'Total', num: true }, { label: '' }],
          invoices.map((i) => ({
            cells: [html`<a href="/ap/${i.id}"><b>${i.invoice_number}</b></a>`, i.vendor_name, i.prop_name, fmtDate(i.due_date), usd(i.total_cents),
              html`<form method="post" action="/ap/${i.id}/approve" style="display:inline"><button class="btn btn-sm">Approve</button></form>
                   <form method="post" action="/ap/${i.id}/reject" style="display:inline"><button class="btn btn-ghost btn-sm">Reject</button></form>`],
          })), { empty: '' },
        ), { flush: true }))}
        ${when(jes.length, () => card(html`Manual journal entries over threshold <span class="badge warn">${jes.length}</span>`, tbl(
          [{ label: 'Memo' }, { label: 'Requested by' }, { label: '' }],
          jes.map((p) => ({
            cells: [p.memo || '(no memo)', p.requested_by || '—',
              html`<form method="post" action="/gl/pending/${p.id}/decide" style="display:inline"><input type="hidden" name="approve" value="1" /><button class="btn btn-sm">Approve &amp; post</button></form>
                   <form method="post" action="/gl/pending/${p.id}/decide" style="display:inline"><button class="btn btn-ghost btn-sm">Reject</button></form>`],
          })), { empty: '' },
        ), { flush: true }))}
        ${when(deposits.length, () => card(html`Deposit returns coming due <span class="badge ${deposits.some((d: any) => d.dl.daysLeft < 0) ? 'bad' : 'warn'}">${deposits.length}</span>`, tbl(
          [{ label: 'Household' }, { label: 'Property' }, { label: 'Held', num: true }, { label: 'State clock' }, { label: 'Due' }, { label: '' }],
          deposits.map((d: any) => ({
            cells: [html`<b>${d.household_name}</b>`, d.prop_name, usd(d.held), `${d.state} · ${d.dl.days}d`,
              d.dl.daysLeft < 0 ? html`<span class="badge bad">overdue ${-d.dl.daysLeft}d</span>` : html`<span class="badge warn">${fmtDate(d.dl.due)} · ${d.dl.daysLeft}d left</span>`,
              html`<a class="btn btn-sm" href="/leases/${d.id}?tab=deposit">Finalize disposition</a>`],
          })), { empty: '' },
        ), { flush: true }))}
        ${when(!total, () => emptyState('All clear', 'Purchase orders, vendor invoices, large journal entries, and deposit deadlines will queue here when they need a decision.'))}
        <p class="small muted" style="margin-top:10px">A purchase order, vendor invoice or manual journal entry waits here when it is over the amount set under <a href="/admin/settings?section=approval-thresholds">Settings → Approval thresholds</a>. Deposit deadlines follow each property's state law.</p>`,
    });
  });

  // ---------------- real bank-file import (CSV / OFX) ----------------
  r.post('/banking/:id/upload', requirePerm('banking:reconcile'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const acct = bankAccountFor(ctx, rq.params.id!);
    if (!acct) return notFound();
    const up = rq.uploads.find((u) => u.field === 'statement' && u.data.length > 0);
    if (!up) return redirect(`/banking/${acct.id}`, 'Choose a CSV or OFX/QFX file first.', 'err');
    let rows: { date: string; amount: number; desc: string; ref: string }[];
    try {
      const text = up.data.toString('utf8');
      rows = /<OFX|<STMTTRN>/i.test(text) ? parseOfx(text) : parseBankCsv(text);
    } catch (e) {
      return redirect(`/banking/${acct.id}`, `Could not parse ${up.filename}: ${(e as Error).message}`, 'err');
    }
    if (!rows.length) return redirect(`/banking/${acct.id}`, 'No transactions found in the file. It needs a date column and an amount (or debit and credit) column.', 'err');
    const res = importStatementLines(ctx, acct.id, rows);
    return redirect(
      `/banking/${acct.id}`,
      `${res.added} transaction${res.added === 1 ? '' : 's'} imported from ${up.filename} (${res.duplicate} already present)`
        + (res.locked ? ` · ${res.locked} left out because their month is already reconciled` : '')
        + ' — reconcile when ready.',
    );
  });

  // ---------------- accounting setup ----------------
  r.get('/gl/setup', requirePerm('gl:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const bankScope = bankScopeSql(ctx, 'b.property_id');
    const banks = q<any>(`SELECT b.*, p.name AS prop_name FROM bank_accounts b LEFT JOIN properties p ON p.id=b.property_id WHERE b.org_id=?${bankScope.sql} ORDER BY b.created_at`, ctx.orgId, ...bankScope.params);
    const live = ctx.orgKind === 'live';
    const accounts = q<any>(`SELECT * FROM gl_accounts WHERE org_id=? ORDER BY code`, ctx.orgId);
    const props = q<any>(`SELECT id, name FROM properties WHERE org_id=?${propFilter(ctx, 'id').sql} ORDER BY name`, ctx.orgId, ...propFilter(ctx, 'id').params);
    return shell(rq, {
      title: 'Accounting setup',
      active: '/gl',
      crumbs: [['Accounting', '/gl']],
      subtitle: 'Bank accounts, chart of accounts, and opening balances — everything needed before the books run.',
      content: html`
        ${card('Bank accounts', html`
          ${tbl(
            [{ label: 'Name' }, { label: 'Kind' }, { label: 'GL' }, { label: 'Bank' }, { label: 'Scope' }, { label: 'Status' }, { label: '' }],
            banks.map((b) => ({
              cells: [html`<a href="/banking/${b.id}"><b>${b.name}</b></a>`, b.kind, html`<span class="mono">${b.gl_account}</span>`, bankLabel(b, live), b.prop_name || 'Organization', statusBadge(b.active ? 'active' : 'ended', b.active ? 'active' : 'inactive'),
                can(ctx, 'banking:reconcile') ? html`
                  <details><summary class="btn btn-ghost btn-sm">Edit</summary>
                    <form method="post" action="/gl/setup/bank/${b.id}" class="toolbar" style="margin-top:8px">
                      ${field('Account name', input('name', { value: b.name, required: true }))}
                      ${field('Bank', input('bank_name', { value: b.bank_name === BANK_NOT_SPECIFIED || (live && b.bank_name === 'First Simulated Bank') ? '' : b.bank_name, placeholder: 'First National' }))}
                      ${field('Last 4 digits', input('last4', { value: live && b.bank_name === 'First Simulated Bank' ? '' : b.last4, placeholder: '1234' }))}
                      <button class="btn btn-sm">Save</button>
                    </form>
                    <form method="post" action="/gl/setup/bank/${b.id}/toggle" style="margin-top:6px">
                      <button class="btn btn-ghost btn-sm">${b.active ? 'Deactivate account' : 'Reactivate account'}</button>
                    </form>
                  </details>` : ''],
            })), { empty: 'No bank accounts yet — add the operating account first.' },
          )}
          ${when(can(ctx, 'banking:reconcile'), () => html`<form method="post" action="/gl/setup/bank" class="toolbar" style="margin-top:10px">
            ${field('Name', input('name', { placeholder: 'Operating — Main', required: true }))}
            ${field('Kind', select('kind', [['operating', 'Operating (GL 1010)'], ['deposits', 'Security deposits (GL 1020)']]))}
            ${field('Bank', input('bank_name', { placeholder: 'First National', required: true }))}
            ${field('Last 4', input('last4', { placeholder: '1234', required: true }))}
            ${field('Property', select('property_id', props.map((p): [string, string] => [p.id, p.name]), '', ctx.allProperties ? { blank: 'Organization-wide' } : { required: true, blank: 'Choose…' }))}
            <button class="btn">Add bank account</button>
          </form>`)}
          <p class="small muted">Statements import on each account's page (CSV or OFX/QFX) or can be typed in line by line, then reconcile monthly. Deposit funds must stay in a <b>deposits</b> account — most states require segregation. A deactivated account leaves the banking page and month-end close; its history is kept.</p>`)}
        ${card('Opening balances', html`
          <p class="small">Three ways to establish the books, in order of preference:</p>
          ${dl([
            ['1 · Opening-balance entry', html`Post one manual JE against <span class="mono">3030 Opening Balance Equity</span> as of the cutover date — <a href="/gl/new">new journal entry</a>. This is how a trial balance comes across today; there is no trial-balance import yet.`],
            ['2 · Upload your data', html`Brings across the <b>subledgers</b> — rent roll, units, leases, residents, deposits, per-lease balances and vendors — from a spreadsheet or lease PDFs: <a href="/setup#upload">open Setup</a>. It does not import GL history.`],
            ['3 · Live from zero', 'New portfolios simply start posting — no opening entry needed.'],
          ])}`)}
        ${card('Chart of accounts', html`
          ${tbl(
            [{ label: 'Code' }, { label: 'Name' }, { label: 'Type' }, { label: 'Control' }, { label: 'Status' }],
            accounts.map((a) => ({
              cells: [html`<span class="mono"><b>${a.code}</b></span>`, a.name, a.type, a.is_control || '—',
                can(ctx, 'gl:post')
                  ? html`<form method="post" action="/gl/setup/account/${a.id}/toggle" style="display:inline"><button class="btn btn-ghost btn-sm">${a.active ? 'Deactivate' : 'Reactivate'}</button></form>`
                  : statusBadge(a.active ? 'active' : 'ended', a.active ? 'active' : 'inactive')],
            })), { empty: 'Chart of accounts is created automatically for new organizations.' },
          )}
          ${when(can(ctx, 'gl:post'), () => html`<form method="post" action="/gl/setup/account" class="toolbar" style="margin-top:10px">
            ${field('Code', input('code', { placeholder: '5915', required: true }))}
            ${field('Name', input('name', { placeholder: 'Snow removal', required: true }))}
            ${field('Type', select('type', [['expense', 'Expense'], ['income', 'Income'], ['asset', 'Asset'], ['liability', 'Liability'], ['equity', 'Equity']]))}
            <button class="btn">Add account</button>
          </form>
          <p class="small muted">The standard chart (${COA.length} accounts) posts automatically from every workflow; add accounts for anything you code manually on invoices, POs, or JEs. Accounts with history deactivate rather than delete.</p>`)}`)}`,
    });
  });

  r.post('/gl/setup/bank', requirePerm('banking:reconcile'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const kind = String(rq.body.kind) === 'deposits' ? 'deposits' : 'operating';
    const name = String(rq.body.name || '').trim().slice(0, 80);
    const last4 = String(rq.body.last4 || '').replace(/\D/g, '').slice(0, 4);
    if (!name || last4.length !== 4) return redirect('/gl/setup', 'Name and a 4-digit last-4 are required.', 'err');
    // an account belongs to a property the person can work on; one with no
    // property is the organization's own and takes access to every property
    const propertyId = String(rq.body.property_id || '') || null;
    if (propertyId ? !canAccessProperty(ctx, propertyId) : !ctx.allProperties) {
      return redirect('/gl/setup', propertyId ? 'Choose a property in your portfolio.' : 'Choose the property this account belongs to.', 'err');
    }
    insert('bank_accounts', {
      id: id('bank'), org_id: ctx.orgId, property_id: propertyId,
      name, kind, gl_account: kind === 'deposits' ? '1020' : '1010',
      bank_name: String(rq.body.bank_name || 'Bank').trim().slice(0, 60), last4,
      active: 1, created_at: nowIso(),
    });
    audit(ctx, 'org', ctx.orgId, 'bank_account_added');
    return redirect('/gl/setup', `${name} added — import its statement from the account page.`);
  });

  r.post('/gl/setup/bank/:id', requirePerm('banking:reconcile'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const acct = bankAccountFor(ctx, rq.params.id!);
    if (!acct) return notFound();
    const name = String(rq.body.name || '').trim().slice(0, 80);
    const bankName = String(rq.body.bank_name || '').trim().slice(0, 60) || BANK_NOT_SPECIFIED;
    const rawLast4 = String(rq.body.last4 || '').trim();
    const last4 = rawLast4.replace(/\D/g, '').slice(0, 4);
    if (!name) return redirect('/gl/setup', 'The account needs a name.', 'err');
    if (rawLast4 && last4.length !== 4) return redirect('/gl/setup', 'Enter the last 4 digits of the account number, or leave it blank.', 'err');
    run('UPDATE bank_accounts SET name=?, bank_name=?, last4=? WHERE id=?', name, bankName, last4, acct.id);
    audit(ctx, 'bank_account', acct.id, 'update', { name: acct.name, bank_name: acct.bank_name, last4: acct.last4 }, { name, bank_name: bankName, last4 });
    return redirect('/gl/setup', `${name} updated.`);
  });

  r.post('/gl/setup/bank/:id/toggle', requirePerm('banking:reconcile'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const acct = bankAccountFor(ctx, rq.params.id!);
    if (!acct) return notFound();
    if (acct.active) {
      const open = val<number>(`SELECT COUNT(*) FROM bank_recons WHERE bank_account_id=? AND status='in_progress'`, acct.id) || 0;
      if (open) return redirect('/gl/setup', `${acct.name} has a reconciliation in progress. Complete it before deactivating the account.`, 'err');
    }
    run('UPDATE bank_accounts SET active=? WHERE id=?', acct.active ? 0 : 1, acct.id);
    audit(ctx, 'bank_account', acct.id, acct.active ? 'deactivate' : 'reactivate');
    return redirect('/gl/setup', `${acct.name} ${acct.active ? 'deactivated' : 'reactivated'}.`);
  });

  r.post('/gl/setup/account', requirePerm('gl:post'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const code = String(rq.body.code || '').trim();
    const name = String(rq.body.name || '').trim().slice(0, 80);
    const type = ['asset', 'liability', 'equity', 'income', 'expense'].includes(String(rq.body.type)) ? String(rq.body.type) : 'expense';
    if (!/^\d{4}$/.test(code) || !name) return redirect('/gl/setup', 'A 4-digit code and a name are required.', 'err');
    if (q1('SELECT id FROM gl_accounts WHERE org_id=? AND code=?', ctx.orgId, code)) return redirect('/gl/setup', `Account ${code} already exists.`, 'err');
    insert('gl_accounts', { id: id('acct'), org_id: ctx.orgId, code, name, type, is_control: null, active: 1, sort: Number(code) });
    audit(ctx, 'org', ctx.orgId, 'gl_account_added');
    return redirect('/gl/setup', `${code} ${name} added to the chart.`);
  });

  r.post('/gl/setup/account/:id/toggle', requirePerm('gl:post'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const acct = q1<any>('SELECT * FROM gl_accounts WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!acct) return notFound();
    if (acct.is_control) return redirect('/gl/setup', 'Control accounts cannot be deactivated — the platform posts to them.', 'err');
    run('UPDATE gl_accounts SET active=? WHERE id=?', acct.active ? 0 : 1, acct.id);
    audit(ctx, 'org', ctx.orgId, acct.active ? 'gl_account_deactivated' : 'gl_account_reactivated');
    return redirect('/gl/setup', `${acct.code} ${acct.name} ${acct.active ? 'deactivated' : 'reactivated'}.`);
  });
}

// ---------- statement parsing ----------

/** CSV: finds date / description / amount columns by header name; falls
 * back to positional date,description,amount. Supports debit/credit
 * column pairs and $, commas, and (parens) negatives. */
export function parseBankCsv(text: string): { date: string; amount: number; desc: string; ref: string }[] {
  // bank exports are comma-, semicolon- or tab-separated; pick the one the header uses
  const firstLine = text.replace(/^\uFEFF/, '').split(/\r?\n/).find((l) => l.trim()) || '';
  const delim = [',', ';', '\t'].map((d): [string, number] => [d, firstLine.split(d).length]).sort((x, y) => y[1] - x[1])[0]![0];
  const grid = parseCsv(text, delim).map((r) => r.map((c) => c.trim()));
  if (!grid.length) throw new Error('empty file');
  const head = grid[0]!.map((h) => h.toLowerCase());
  const idx = (...names: string[]): number => head.findIndex((h) => names.some((n) => h.includes(n)));
  let di = idx('date'); let de = idx('description', 'memo', 'payee', 'name', 'details'); let ai = idx('amount');
  // Some banks print every amount unsigned and say which way it went in a
  // column beside it ("Transaction Type": Debit / Credit).
  const ti = head.findIndex((h, i) => i !== ai && /(^|\s)(type|dr\/cr|debit\/credit|indicator)$/.test(h));
  const debit = idx('debit', 'withdrawal', 'money out', 'paid out'); const credit = idx('credit', 'deposit', 'money in', 'paid in');
  const hasHeader = di >= 0;
  if (!hasHeader) { di = 0; de = 1; ai = 2; }
  const rows: { date: string; amount: number; desc: string; ref: string }[] = [];
  // Two genuine lines can be identical in every column (two $1,500.00 deposits
  // on one day). The first keeps the plain fingerprint; later ones are
  // numbered, so both import — and importing the file again still adds nothing.
  const seen = new Map<string, number>();
  const body = grid.slice(hasHeader ? 1 : 0);
  // The type column decides the sign only when no amount in the file carries
  // one. An export that signs its amounts (and labels a card refund
  // "DEBIT_CARD") already says which way the money went.
  const unsigned = ai >= 0 && ti >= 0 && !body.some((c) => { const v = parseMoney(c[ai] || ''); return v !== null && v < 0; });
  for (const c of body) {
    if (c.length < 2) continue;
    const date = normDate(c[di] || '');
    if (!date) continue;
    let amount: number | null = null;
    if (ai >= 0 && c[ai]) {
      amount = parseMoney(c[ai]!);
      if (amount !== null && unsigned && /^(debit|dr|withdrawal|check|payment)$/i.test(c[ti] || '')) amount = -Math.abs(amount);
    } else if (debit >= 0 || credit >= 0) {
      const d = debit >= 0 ? parseMoney(c[debit] || '') : null;
      const cr = credit >= 0 ? parseMoney(c[credit] || '') : null;
      amount = cr && cr !== 0 ? Math.abs(cr) : d && d !== 0 ? -Math.abs(d) : null;
    }
    if (amount === null || amount === 0 || Number.isNaN(amount)) continue;
    const desc = (de >= 0 ? c[de] : c.filter((_, i2) => i2 !== di && i2 !== ai).join(' ')) || 'Imported transaction';
    const key = `${date}|${amount}|${desc}`;
    const n = seen.get(key) || 0;
    seen.set(key, n + 1);
    rows.push({ date, amount, desc: desc.slice(0, 160), ref: `file:${hash(n ? `${key}|${n}` : key)}` });
  }
  return rows;
}

/** OFX/QFX: SGML or XML style <STMTTRN> blocks. */
export function parseOfx(text: string): { date: string; amount: number; desc: string; ref: string }[] {
  const rows: { date: string; amount: number; desc: string; ref: string }[] = [];
  for (const m of text.matchAll(/<STMTTRN>([\s\S]*?)(?=<STMTTRN>|<\/BANKTRANLIST>|<\/STMTTRN>)/gi)) {
    const block = m[1]!;
    const tag = (t: string): string => {
      const mm = block.match(new RegExp(`<${t}>([^<\r\n]*)`, 'i'));
      return mm ? mm[1]!.trim() : '';
    };
    const dt = tag('DTPOSTED').slice(0, 8);
    if (!/^\d{8}$/.test(dt)) continue;
    const amount = Math.round(parseFloat(tag('TRNAMT') || '0') * 100);
    if (!amount) continue;
    const desc = (tag('NAME') || tag('MEMO') || 'OFX transaction').slice(0, 160);
    const fit = tag('FITID');
    const date = `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`;
    rows.push({ date, amount, desc, ref: fit ? `ofx:${fit}` : `file:${hash(`${date}|${amount}|${desc}`)}` });
  }
  return rows;
}

function parseMoney(s: string): number | null {
  // money out is written many ways: (75.00), -75.00, $-75.00, - $75.00, 75.00-, 75.00 DR
  const t = s.trim();
  const neg = /\(.*\)/.test(t) || /^[^0-9.]*-/.test(t) || /-\s*$/.test(t) || /\bDR\b\.?\s*$/i.test(t);
  const num = s.replace(/[^0-9.]/g, '');
  if (!num) return null;
  const cents = Math.round(parseFloat(num) * 100);
  if (Number.isNaN(cents)) return null;
  return neg ? -cents : cents;
}

function normDate(s: string): string | null {
  const t = s.trim().replace(/"/g, '');
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    return `${y}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
  }
  return null;
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
