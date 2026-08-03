import { html, when } from '../../lib/html.ts';
import { redirect, notFound, forbidden, type Router, type Rq } from '../../lib/http.ts';
import { requirePerm, requireStaff, can, propFilter, type Ctx } from '../../lib/auth.ts';
import { q, q1, run, insert } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, fmtDate, diffDays } from '../../lib/dates.ts';
import { usd } from '../../lib/money.ts';
import { audit } from '../../lib/audit.ts';
import { shell, card, tbl, dl, statusBadge, field, input, select, registerNav, emptyState } from '../../ui/ui.ts';
import { depositDeadline } from '../m8_receivables/depositlaw.ts';
import { depositHeld } from '../m8_receivables/payments.ts';
import { COA } from './coa.ts';

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

export function routes(r: Router): void {
  // ---------------- the approver's single queue ----------------
  r.get('/approvals', requireStaff, (rq) => {
    const ctx = rq.ctx as Ctx;
    if (!APPROVER_PERMS.some((p) => can(ctx, p))) return forbidden();
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
    const total = pos.length + invoices.length + jes.length + deposits.length;
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
            cells: [p.memo || '(no memo)', p.created_by || '—',
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
        <p class="small muted" style="margin-top:10px">Thresholds live in Settings: POs route here over <code>po_approval_threshold_cents</code>, invoices over <code>invoice_approval_threshold_cents</code>, manual JEs over <code>je_approval_threshold_cents</code>. Deposit deadlines follow each property's state law.</p>`,
    });
  });

  // ---------------- real bank-file import (CSV / OFX) ----------------
  r.post('/banking/:id/upload', requirePerm('banking:reconcile'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const acct = q1<any>('SELECT * FROM bank_accounts WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
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
    if (!rows.length) return redirect(`/banking/${acct.id}`, 'No transactions found in the file.', 'err');
    let added = 0;
    for (const t of rows) {
      if (q1('SELECT id FROM bank_txns WHERE bank_account_id=? AND ref=?', acct.id, t.ref)) continue; // idempotent re-import
      insert('bank_txns', {
        id: id('btx'), org_id: ctx.orgId, bank_account_id: acct.id,
        date: t.date, amount_cents: t.amount, description: t.desc, ref: t.ref,
        kind: guessKind(t.desc, t.amount), status: 'unmatched', imported_at: nowIso(),
      });
      added++;
    }
    audit(ctx, 'bank_account', acct.id, 'statement_imported');
    return redirect(`/banking/${acct.id}`, `${added} transaction${added === 1 ? '' : 's'} imported from ${up.filename} (${rows.length - added} already present) — reconcile when ready.`);
  });

  // ---------------- accounting setup ----------------
  r.get('/gl/setup', requirePerm('gl:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const banks = q<any>(`SELECT b.*, p.name AS prop_name FROM bank_accounts b LEFT JOIN properties p ON p.id=b.property_id WHERE b.org_id=? ORDER BY b.created_at`, ctx.orgId);
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
            [{ label: 'Name' }, { label: 'Kind' }, { label: 'GL' }, { label: 'Bank' }, { label: 'Scope' }, { label: 'Status' }],
            banks.map((b) => ({
              href: `/banking/${b.id}`,
              cells: [html`<b>${b.name}</b>`, b.kind, html`<span class="mono">${b.gl_account}</span>`, `${b.bank_name} …${b.last4}`, b.prop_name || 'Organization', statusBadge(b.active ? 'active' : 'ended', b.active ? 'active' : 'inactive')],
            })), { empty: 'No bank accounts yet — add the operating account first.' },
          )}
          ${when(can(ctx, 'banking:reconcile'), () => html`<form method="post" action="/gl/setup/bank" class="toolbar" style="margin-top:10px">
            ${field('Name', input('name', { placeholder: 'Operating — Main', required: true }))}
            ${field('Kind', select('kind', [['operating', 'Operating (GL 1010)'], ['deposits', 'Security deposits (GL 1020)']]))}
            ${field('Bank', input('bank_name', { placeholder: 'First National', required: true }))}
            ${field('Last 4', input('last4', { placeholder: '1234', required: true }))}
            ${field('Property', select('property_id', props.map((p): [string, string] => [p.id, p.name]), '', { blank: 'Organization-wide' }))}
            <button class="btn">Add bank account</button>
          </form>`)}
          <p class="small muted">Statements import on each account's page (CSV or OFX/QFX), then reconcile monthly. Deposit funds must stay in a <b>deposits</b> account — most states require segregation.</p>`)}
        ${card('Opening balances', html`
          <p class="small">Three ways to establish the books, in order of preference:</p>
          ${dl([
            ['1 · Migration Center', html`Import the prior system's trial balance and subledgers — <a href="/migration">open Migration Center</a>`],
            ['2 · Opening-balance entry', html`Post one manual JE against <span class="mono">3030 Opening Balance Equity</span> as of the cutover date — <a href="/gl/new">new journal entry</a>`],
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
    insert('bank_accounts', {
      id: id('bank'), org_id: ctx.orgId, property_id: String(rq.body.property_id || '') || null,
      name, kind, gl_account: kind === 'deposits' ? '1020' : '1010',
      bank_name: String(rq.body.bank_name || 'Bank').trim().slice(0, 60), last4,
      active: 1, created_at: nowIso(),
    });
    audit(ctx, 'org', ctx.orgId, 'bank_account_added');
    return redirect('/gl/setup', `${name} added — import its statement from the account page.`);
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
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) throw new Error('empty file');
  const split = (l: string): string[] => {
    const out: string[] = []; let cur = ''; let inQ = false;
    for (const ch of l) {
      if (ch === '"') inQ = !inQ;
      else if (ch === ',' && !inQ) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const head = split(lines[0]!).map((h) => h.toLowerCase());
  const idx = (...names: string[]): number => head.findIndex((h) => names.some((n) => h.includes(n)));
  let di = idx('date'); let de = idx('description', 'memo', 'payee', 'name', 'details'); let ai = idx('amount');
  const debit = idx('debit', 'withdrawal'); const credit = idx('credit', 'deposit');
  const hasHeader = di >= 0;
  if (!hasHeader) { di = 0; de = 1; ai = 2; }
  const rows: { date: string; amount: number; desc: string; ref: string }[] = [];
  for (const line of lines.slice(hasHeader ? 1 : 0)) {
    const c = split(line);
    if (c.length < 2) continue;
    const date = normDate(c[di] || '');
    if (!date) continue;
    let amount: number | null = null;
    if (ai >= 0 && c[ai]) amount = parseMoney(c[ai]!);
    else if (debit >= 0 || credit >= 0) {
      const d = debit >= 0 ? parseMoney(c[debit] || '') : null;
      const cr = credit >= 0 ? parseMoney(c[credit] || '') : null;
      amount = cr && cr !== 0 ? Math.abs(cr) : d && d !== 0 ? -Math.abs(d) : null;
    }
    if (amount === null || amount === 0 || Number.isNaN(amount)) continue;
    const desc = (de >= 0 ? c[de] : c.filter((_, i2) => i2 !== di && i2 !== ai).join(' ')) || 'Imported transaction';
    rows.push({ date, amount, desc: desc.slice(0, 160), ref: `file:${hash(`${date}|${amount}|${desc}`)}` });
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
  const neg = /\(.*\)/.test(s) || s.trim().startsWith('-');
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

function guessKind(desc: string, amount: number): string {
  const d = desc.toLowerCase();
  if (/fee|service charge/.test(d)) return 'fee';
  if (/interest/.test(d)) return 'interest';
  if (/check|chk/.test(d)) return 'check';
  if (/ach|transfer|xfer|payroll|autopay/.test(d)) return 'ach';
  return amount > 0 ? 'deposit' : 'other';
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
