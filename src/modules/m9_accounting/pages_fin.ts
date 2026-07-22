import { html, when, join, type Child } from '../../lib/html.ts';
import { notFound, redirect, type Router } from '../../lib/http.ts';
import { requirePerm, can, propFilter, type Ctx } from '../../lib/auth.ts';
import { q, q1, val, j } from '../../lib/db.ts';
import { fmtDate, fmtMonth, monthKey, lastOfMonth, addMonths } from '../../lib/dates.ts';
import { usd, parseUsd } from '../../lib/money.ts';
import { shell, card, tbl, dl, statusBadge, field, select, input, registerNav, kpis, tabs, emptyState } from '../../ui/ui.ts';
import { COA } from './coa.ts';
import { accountBalance } from './service.ts';
import { ensureBankAccounts, importAllFeeds, createRecon, autoMatch, postAdjustment, manualMatch, excludeTxn, completeRecon, reconSummary, unreconciledAging, unmatchedTotal } from './banking.ts';
import { closeChecklist, closePeriod, reopenPeriod, periodGrid, submitManualJe, decidePendingJe, createRecurringJe } from './close.ts';
import { balanceSheet, incomeStatement, t12, cashFlow, toCsv, type Basis } from './statements.ts';
import { createBudget, setBudgetLine, approveBudget, budgetVsActual, seedFromActuals, spread, type SpreadCurve } from './budgets.ts';
import { projectCommitments } from '../m16_procurement/service.ts';

/** M9 complete — banking & reconciliation, period close, budgets, financial
 * statements, recurring/manual JEs, capital projects. */

registerNav('Money', { href: '/banking', label: 'Banking', perm: 'banking:view', match: ['/banking'] });
registerNav('Money', { href: '/periods', label: 'Month-end close', perm: 'gl:close_period', match: ['/periods'] });
registerNav('Money', { href: '/budgets', label: 'Budgets', perm: 'budgets:view', match: ['/budgets'] });
registerNav('Money', { href: '/statements', label: 'Statements', perm: 'gl:view', match: ['/statements'] });

function propsFor(ctx: Ctx): any[] {
  const pf = propFilter(ctx, 'id');
  return q<any>(`SELECT id, name FROM properties WHERE org_id=?${pf.sql} ORDER BY name`, ctx.orgId, ...pf.params);
}

export function routes(r: Router): void {
  // ============================== BANKING ==============================
  r.get('/banking', requirePerm('banking:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    ensureBankAccounts(ctx.orgId);
    const accounts = q<any>(
      `SELECT b.*, p.name AS property,
        (SELECT COUNT(*) FROM bank_txns t WHERE t.bank_account_id=b.id AND t.status='unmatched') AS open_txns,
        (SELECT COALESCE(SUM(amount_cents),0) FROM bank_txns t WHERE t.bank_account_id=b.id) AS balance
       FROM bank_accounts b LEFT JOIN properties p ON p.id=b.property_id WHERE b.org_id=? AND b.active=1`,
      ctx.orgId,
    );
    const recons = q<any>(
      `SELECT r.*, b.name AS account FROM bank_recons r JOIN bank_accounts b ON b.id=r.bank_account_id
       WHERE r.org_id=? ORDER BY r.period_key DESC, b.name LIMIT 40`, ctx.orgId,
    );
    const aging = unreconciledAging(ctx);
    return shell(rq, {
      title: 'Banking & reconciliation',
      active: '/banking',
      subtitle: 'BankFeed accounts, statement matching and reconciliation history',
      actions: html`<form method="post" action="/banking/import" style="display:inline"><button class="btn btn-ghost">Pull latest feed</button></form>`,
      content: html`
        ${card('Accounts', tbl(
          [{ label: 'Account' }, { label: 'Bank' }, { label: 'Last 4' }, { label: 'Feed balance', num: true }, { label: 'Unmatched', num: true }, { label: '' }],
          accounts.map((a) => ({
            cells: [
              a.name, a.bank_name, html`<span class="mono">…${a.last4}</span>`, usd(a.balance),
              a.open_txns ? html`<span class="badge badge-warn">${a.open_txns}</span>` : '0',
              html`<a class="btn btn-sm" href="/banking/${a.id}/reconcile">Reconcile</a> <a class="btn btn-ghost btn-sm" href="/banking/${a.id}">Transactions</a>`,
            ],
          })),
        ), { flush: true })}
        ${card('Unreconciled item aging', tbl(
          [{ label: 'Account' }, { label: '0-30', num: true }, { label: '31-60', num: true }, { label: '61-90', num: true }, { label: '90+', num: true }],
          aging.map((a) => ({
            cells: [a.account.name, ...(['0-30', '31-60', '61-90', '90+'] as const).map((k) =>
              a.buckets[k]!.n ? html`${a.buckets[k]!.n} · ${usd(a.buckets[k]!.amount)}` : '—')],
          })),
        ), { flush: true })}
        ${card('Reconciliation history', tbl(
          [{ label: 'Month' }, { label: 'Account' }, { label: 'Statement close', num: true }, { label: 'Difference', num: true }, { label: 'Status' }, { label: 'Completed' }],
          recons.map((rc) => ({
            href: `/banking/${rc.bank_account_id}/reconcile?month=${rc.period_key}`,
            cells: [fmtMonth(rc.period_key), rc.account, usd(rc.statement_close_cents), rc.difference_cents ? html`<b>${usd(rc.difference_cents)}</b>` : usd(0), statusBadge(rc.status), rc.completed_by ? `${rc.completed_by} · ${fmtDate((rc.completed_at || '').slice(0, 10))}` : '—'],
          })),
          { empty: 'No reconciliations yet — pick an account above.' },
        ), { flush: true })}`,
    });
  });

  r.post('/banking/import', requirePerm('banking:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    ensureBankAccounts(ctx.orgId);
    const n = importAllFeeds(ctx.orgId, ctx.businessDate);
    return redirect('/banking', n ? `${n} new bank transactions imported` : 'Feed already up to date');
  });

  r.get('/banking/:id', requirePerm('banking:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const acct = q1<any>('SELECT * FROM bank_accounts WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!acct) return notFound();
    const txns = q<any>('SELECT * FROM bank_txns WHERE bank_account_id=? ORDER BY date DESC LIMIT 300', acct.id);
    return shell(rq, {
      title: acct.name,
      active: '/banking',
      subtitle: `${acct.bank_name} · …${acct.last4} · feed shows ${txns.length < 300 ? txns.length : '300+'} transactions`,
      actions: html`<a class="btn" href="/banking/${acct.id}/reconcile">Reconcile</a>`,
      content: card(null, tbl(
        [{ label: 'Date' }, { label: 'Description' }, { label: 'Ref' }, { label: 'Kind' }, { label: 'Status' }, { label: 'Amount', num: true }],
        txns.map((t) => ({
          cells: [fmtDate(t.date), t.description, html`<span class="mono small">${t.ref || ''}</span>`, t.kind, statusBadge(t.status), html`<span class="${t.amount_cents < 0 ? 'neg' : ''}">${usd(t.amount_cents)}</span>`],
        })),
        { empty: 'Feed is empty — pull the latest feed from the banking page.' },
      ), { flush: true }),
    });
  });

  // ---------- reconciliation workbench ----------
  r.get('/banking/:id/reconcile', requirePerm('banking:reconcile'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const acct = q1<any>('SELECT * FROM bank_accounts WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!acct) return notFound();
    // default month: first month with unmatched txns, else last full month
    const suggested = val<string>(
      `SELECT substr(date,1,7) FROM bank_txns WHERE bank_account_id=? AND status='unmatched' ORDER BY date LIMIT 1`, acct.id,
    ) || monthKey(addMonths(ctx.businessDate, -1));
    const month = rq.query.get('month') || suggested;
    const reconId = createRecon(ctx, acct.id, month);
    const rec = q1<any>('SELECT * FROM bank_recons WHERE id=?', reconId);
    const txns = q<any>(
      `SELECT * FROM bank_txns WHERE bank_account_id=? AND substr(date,1,7)=? ORDER BY status DESC, date`, acct.id, month,
    );
    const summary = reconSummary(ctx, reconId);
    const diff = unmatchedTotal(ctx.orgId, acct.id, month);
    const months: [string, string][] = [];
    for (let i = 14; i >= 0; i--) {
      const mk2 = monthKey(addMonths(ctx.businessDate, -i));
      months.push([mk2, fmtMonth(mk2)]);
    }
    return shell(rq, {
      title: `Reconcile — ${fmtMonth(month)}`,
      active: '/banking',
      subtitle: html`${acct.name} · statement ${usd(rec.statement_open_cents)} → ${usd(rec.statement_close_cents)} · ${statusBadge(rec.status)}`,
      actions: html`
        ${when(rec.status !== 'completed', () => html`
          <form method="post" action="/banking/${acct.id}/reconcile/${reconId}/automatch" style="display:inline"><button class="btn">Auto-match</button></form>
          <form method="post" action="/banking/${acct.id}/reconcile/${reconId}/complete" style="display:inline"><button class="btn" ${diff === 0 ? '' : 'disabled'}>Complete at $0.00</button></form>`)}
        <a class="btn btn-ghost" href="/banking/${acct.id}/reconcile/${reconId}/report">Report</a>`,
      content: html`
        <form method="get" class="toolbar" data-autosubmit>${field('Statement month', select('month', months, month))}</form>
        ${kpis([
          { label: 'Unmatched difference', value: usd(diff), tone: diff === 0 ? 'ok' : 'warn' },
          { label: 'Matched this month', value: String(summary.matchedCount) },
          { label: 'Book balance (EOM)', value: usd(summary.bookClose) },
          { label: 'Outstanding checks', value: usd(summary.outstanding.reduce((s, o) => s + o.amount, 0)) },
        ])}
        ${card('Statement transactions', tbl(
          [{ label: 'Date' }, { label: 'Description' }, { label: 'Kind' }, { label: 'Amount', num: true }, { label: 'Status' }, { label: 'Action' }],
          txns.map((t) => ({
            cells: [
              fmtDate(t.date), html`${t.description} <span class="mono small muted">${t.ref || ''}</span>`, t.kind,
              html`<span class="${t.amount_cents < 0 ? 'neg' : ''}">${usd(t.amount_cents)}</span>`,
              statusBadge(t.status === 'matched' ? 'matched' : t.status, t.status === 'matched' ? `matched · ${t.matched_kind}` : undefined),
              t.status === 'unmatched' && rec.status !== 'completed'
                ? html`
                  <form method="post" action="/banking/txn/${t.id}/adjust" style="display:inline"><input type="hidden" name="recon" value="${reconId}"><button class="btn btn-sm">Post adjustment JE</button></form>
                  <form method="post" action="/banking/txn/${t.id}/exclude" style="display:inline"><input type="hidden" name="recon" value="${reconId}"><button class="btn btn-ghost btn-sm">Exclude</button></form>`
                : '',
            ],
          })),
          { empty: 'No statement activity this month.' },
        ), { flush: true })}
        ${card('Book vs bank', dl([
          ['GL 1010 at month end', usd(summary.bookClose)],
          ['Less outstanding checks', usd(summary.outstanding.reduce((s, o) => s + o.amount, 0))],
          ['Plus deposits in transit', usd(summary.inTransit.reduce((s, o) => s + o.amount, 0))],
          ['Adjustments posted this recon', usd(summary.adjusted)],
          ['Bank statement close', html`<b>${usd(rec.statement_close_cents)}</b>`],
        ]))}`,
    });
  });

  r.post('/banking/:id/reconcile/:rid/automatch', requirePerm('banking:reconcile'), (rq) => {
    const res = autoMatch(rq.ctx as Ctx, rq.params.rid!);
    return redirect(`/banking/${rq.params.id}/reconcile?month=${q1<any>('SELECT period_key FROM bank_recons WHERE id=?', rq.params.rid!)?.period_key}`,
      `${res.matched} matched · ${res.remaining} still open`);
  });
  r.post('/banking/:id/reconcile/:rid/complete', requirePerm('banking:reconcile'), (rq) => {
    const month = q1<any>('SELECT period_key FROM bank_recons WHERE id=?', rq.params.rid!)?.period_key;
    try {
      completeRecon(rq.ctx as Ctx, rq.params.rid!);
      return redirect(`/banking/${rq.params.id}/reconcile?month=${month}`, 'Reconciled to zero difference ✓');
    } catch (e) {
      return redirect(`/banking/${rq.params.id}/reconcile?month=${month}`, (e as Error).message, 'err');
    }
  });
  r.post('/banking/txn/:id/adjust', requirePerm('banking:reconcile'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const t = q1<any>('SELECT * FROM bank_txns WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!t) return notFound();
    const rec = String(rq.body?.recon || '') || null;
    const month = rec ? q1<any>('SELECT period_key FROM bank_recons WHERE id=?', rec)?.period_key : '';
    try {
      postAdjustment(ctx, t.id, rec);
      return redirect(`/banking/${t.bank_account_id}/reconcile?month=${month}`, 'Adjustment JE posted and matched');
    } catch (e) {
      return redirect(`/banking/${t.bank_account_id}/reconcile?month=${month}`, (e as Error).message, 'err');
    }
  });
  r.post('/banking/txn/:id/exclude', requirePerm('banking:reconcile'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const t = q1<any>('SELECT * FROM bank_txns WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!t) return notFound();
    const rec = String(rq.body?.recon || '') || null;
    const month = rec ? q1<any>('SELECT period_key FROM bank_recons WHERE id=?', rec)?.period_key : '';
    excludeTxn(ctx, t.id, rec, 'excluded from workbench');
    return redirect(`/banking/${t.bank_account_id}/reconcile?month=${month}`, 'Transaction excluded');
  });

  r.get('/banking/:id/reconcile/:rid/report', requirePerm('banking:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const s = reconSummary(ctx, rq.params.rid!);
    if (!s.rec) return notFound();
    return shell(rq, {
      title: `Reconciliation report — ${fmtMonth(s.rec.period_key)}`,
      active: '/banking',
      subtitle: html`${s.acct.name} · ${statusBadge(s.rec.status)}${s.rec.completed_by ? html` · completed by ${s.rec.completed_by}` : ''}`,
      content: html`
        ${card('Summary', dl([
          ['Statement opening balance', usd(s.rec.statement_open_cents)],
          ['Statement closing balance', usd(s.rec.statement_close_cents)],
          ['Book balance (GL 1010) at month end', usd(s.bookClose)],
          ['Outstanding checks', usd(s.outstanding.reduce((x, o) => x + o.amount, 0))],
          ['Deposits in transit', usd(s.inTransit.reduce((x, o) => x + o.amount, 0))],
          ['Adjustment JEs posted', usd(s.adjusted)],
          ['Unexplained difference', html`<b>${usd(s.rec.status === 'completed' ? 0 : s.rec.difference_cents)}</b>`],
        ]))}
        ${when(s.outstanding.length, () => card('Outstanding checks at month end', tbl(
          [{ label: 'Item' }, { label: 'Issued' }, { label: 'Amount', num: true }],
          s.outstanding.map((o) => ({ cells: [o.desc, fmtDate(o.date), usd(o.amount)] })),
        ), { flush: true }))}`,
    });
  });

  // ============================== PERIODS / CLOSE ==============================
  r.get('/periods', requirePerm('gl:close_period'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const props = propsFor(ctx);
    const propId = rq.query.get('property') || props[0]?.id;
    const month = rq.query.get('month') || monthKey(addMonths(ctx.businessDate, -1));
    const grid = periodGrid(ctx, propId);
    const items = closeChecklist(ctx, propId, month);
    const ready = items.every((i) => i.ok);
    const status = grid.find((g) => g.periodKey === month)?.status || 'open';
    return shell(rq, {
      title: 'Month-end close',
      active: '/periods',
      subtitle: 'Close checklist per property; closed periods block postings',
      content: html`
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Property', select('property', props.map((p): [string, string] => [p.id, p.name]), propId))}
          ${field('Month', select('month', grid.map((g): [string, string] => [g.periodKey, fmtMonth(g.periodKey)]), month))}
        </form>
        <div class="cols">
          <div>
            ${card(html`Close checklist — ${fmtMonth(month)} ${statusBadge(status)}`, html`
              <ul class="checklist">
                ${join(items.map((i) => html`<li class="${i.ok ? 'ok' : 'todo'}"><b>${i.ok ? '✓' : '○'} ${i.label}</b><br><span class="small muted">${i.detail}</span></li>`), '')}
              </ul>
              ${when(status !== 'closed', () => html`
                <form method="post" action="/periods/close">
                  <input type="hidden" name="property_id" value="${propId}"><input type="hidden" name="month" value="${month}">
                  <button class="btn" ${ready ? '' : 'disabled'}>${ready ? `Close ${fmtMonth(month)}` : 'Checklist incomplete'}</button>
                </form>`,
                () => html`
                <form method="post" action="/periods/reopen" data-confirm="Reopen this closed period? This is audited.">
                  <input type="hidden" name="property_id" value="${propId}"><input type="hidden" name="month" value="${month}">
                  ${field('Reason (required, audited)', input('reason', { required: true, placeholder: 'why does this need to reopen?' }))}
                  <button class="btn btn-ghost">Reopen period</button>
                </form>`)}`)}
          </div>
          <div>
            ${card('Period status — last 15 months', tbl(
              [{ label: 'Month' }, { label: 'Status' }, { label: 'Closed by' }],
              grid.slice().reverse().map((g) => ({
                href: `/periods?property=${propId}&month=${g.periodKey}`,
                cells: [fmtMonth(g.periodKey), statusBadge(g.status), g.closedBy ? `${g.closedBy} · ${fmtDate((g.closedAt || '').slice(0, 10))}` : '—'],
              })),
            ), { flush: true })}
          </div>
        </div>`,
    });
  });

  r.post('/periods/close', requirePerm('gl:close_period'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const propId = String(rq.body?.property_id);
    const month = String(rq.body?.month);
    try {
      closePeriod(ctx, propId, month);
      return redirect(`/periods?property=${propId}&month=${month}`, `${fmtMonth(month)} closed — postings now blocked`);
    } catch (e) {
      return redirect(`/periods?property=${propId}&month=${month}`, (e as Error).message, 'err');
    }
  });
  r.post('/periods/reopen', requirePerm('gl:reopen_period'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const propId = String(rq.body?.property_id);
    const month = String(rq.body?.month);
    try {
      reopenPeriod(ctx, propId, month, String(rq.body?.reason || ''));
      return redirect(`/periods?property=${propId}&month=${month}`, 'Period reopened (audited)');
    } catch (e) {
      return redirect(`/periods?property=${propId}&month=${month}`, (e as Error).message, 'err');
    }
  });

  // ============================== MANUAL + RECURRING JEs ==============================
  r.get('/gl/new', requirePerm('gl:post'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const props = propsFor(ctx);
    const acctOpts = COA.map(([c, n]): [string, string] => [c, `${c} — ${n}`]);
    const pending = q<any>(`SELECT * FROM pending_jes WHERE org_id=? AND status='pending' ORDER BY created_at DESC`, ctx.orgId);
    const lineRow = (i: number): Child => html`
      <tr>
        <td>${select(`acct_${i}`, acctOpts, '', { blank: '—' })}</td>
        <td>${input(`memo_${i}`, { placeholder: 'line memo' })}</td>
        <td>${input(`dr_${i}`, { placeholder: '0.00' })}</td>
        <td>${input(`cr_${i}`, { placeholder: '0.00' })}</td>
      </tr>`;
    return shell(rq, {
      title: 'Manual journal entry',
      active: '/gl',
      subtitle: 'Large entries route to a controller for approval',
      content: html`
        <form method="post" action="/gl/new">
          ${card('Entry', html`
            <div class="grid2">
              ${field('Property', select('property_id', props.map((p): [string, string] => [p.id, p.name]), ctx.currentPropertyId || '', { required: true }))}
              ${field('Date', input('date', { type: 'date', value: ctx.businessDate, required: true }))}
              ${field('Basis', select('basis', [['both', 'Both books'], ['accrual', 'Accrual only'], ['cash', 'Cash only']], 'both'))}
              ${field('Memo', input('memo', { required: true, placeholder: 'why this entry exists' }))}
            </div>
            <table class="tbl"><thead><tr><th>Account</th><th>Memo</th><th>Debit</th><th>Credit</th></tr></thead>
            <tbody>${join([0, 1, 2, 3, 4, 5].map(lineRow), '')}</tbody></table>`)}
          <button class="btn">Post entry</button>
        </form>
        ${when(pending.length && can(ctx, 'gl:close_period'), () => card('Awaiting approval', tbl(
          [{ label: 'Date' }, { label: 'Property' }, { label: 'Memo' }, { label: 'Requested by' }, { label: 'Amount', num: true }, { label: '' }],
          pending.map((p) => {
            const total = j<any[]>(p.lines, []).reduce((s, l) => s + (l.debit || 0), 0);
            return {
              cells: [
                fmtDate(p.date), q1<any>('SELECT name FROM properties WHERE id=?', p.property_id)?.name || '—', p.memo, p.requested_by, usd(total),
                html`
                  <form method="post" action="/gl/pending/${p.id}/decide" style="display:inline"><input type="hidden" name="approve" value="1"><button class="btn btn-sm">Approve &amp; post</button></form>
                  <form method="post" action="/gl/pending/${p.id}/decide" style="display:inline"><button class="btn btn-ghost btn-sm">Reject</button></form>`,
              ],
            };
          }),
        ), { flush: true }))}
        ${card('Recurring entries', html`
          ${tbl(
            [{ label: 'Name' }, { label: 'Property' }, { label: 'Day' }, { label: 'Last posted' }, { label: 'Amount', num: true }],
            q<any>('SELECT * FROM recurring_jes WHERE org_id=? AND active=1', ctx.orgId).map((r2) => ({
              cells: [r2.name, q1<any>('SELECT name FROM properties WHERE id=?', r2.property_id)?.name || '—', String(r2.day_of_month), r2.last_posted_month ? fmtMonth(r2.last_posted_month) : 'never', usd(j<any[]>(r2.lines, []).reduce((s, l) => s + (l.debit || 0), 0))],
            })),
            { empty: 'No recurring entries yet.' },
          )}
          <p class="small muted">Recurring entries post automatically on their day of month as the business date advances (amortizations, standing accruals).</p>`)}`,
    });
  });

  r.post('/gl/new', requirePerm('gl:post'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const b = rq.body!;
    const lines = [0, 1, 2, 3, 4, 5]
      .filter((i) => b[`acct_${i}`] && (parseUsd(String(b[`dr_${i}`] || '0')) > 0 || parseUsd(String(b[`cr_${i}`] || '0')) > 0))
      .map((i) => ({
        account: String(b[`acct_${i}`]),
        memo: String(b[`memo_${i}`] || '') || undefined,
        debit: parseUsd(String(b[`dr_${i}`] || '0')) || undefined,
        credit: parseUsd(String(b[`cr_${i}`] || '0')) || undefined,
      }));
    try {
      const res = submitManualJe(ctx, {
        propertyId: String(b.property_id), date: String(b.date), memo: String(b.memo),
        basis: String(b.basis || 'both') as 'accrual' | 'cash' | 'both', lines,
      });
      return redirect('/gl/new', res.status === 'posted' ? 'Journal entry posted to both books' : 'Entry over the approval threshold — routed to a controller');
    } catch (e) {
      return redirect('/gl/new', (e as Error).message, 'err');
    }
  });

  r.post('/gl/pending/:id/decide', requirePerm('gl:close_period'), (rq) => {
    try {
      const jeId = decidePendingJe(rq.ctx as Ctx, rq.params.id!, rq.body?.approve === '1', String(rq.body?.reason || 'rejected'));
      return redirect('/gl/new', jeId ? 'Approved and posted' : 'Rejected');
    } catch (e) {
      return redirect('/gl/new', (e as Error).message, 'err');
    }
  });

  // ============================== BUDGETS ==============================
  r.get('/budgets', requirePerm('budgets:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const budgets = q<any>(
      `SELECT b.*, p.name AS property,
        (SELECT COUNT(*) FROM budget_lines l WHERE l.budget_id=b.id) AS line_count
       FROM budgets b JOIN properties p ON p.id=b.property_id WHERE b.org_id=? ORDER BY b.year DESC, p.name, b.version DESC`,
      ctx.orgId,
    );
    const props = propsFor(ctx);
    const year = Number(ctx.businessDate.slice(0, 4));
    return shell(rq, {
      title: 'Budgets',
      active: '/budgets',
      subtitle: 'Annual budgets per property with monthly spreads and variance tracking',
      actions: when(can(ctx, 'budgets:manage'), () => html`
        <form method="post" action="/budgets/new" class="toolbar" style="display:inline-flex">
          ${select('property_id', props.map((p): [string, string] => [p.id, p.name]), props[0]?.id)}
          ${select('year', [[String(year), String(year)], [String(year + 1), String(year + 1)]], String(year + 1))}
          ${select('seed', [['blank', 'Start blank'], ['actuals', `Seed from FY${year - 1} actuals +3%`]], 'actuals')}
          <button class="btn">New budget</button>
        </form>`),
      content: card(null, tbl(
        [{ label: 'Year' }, { label: 'Property' }, { label: 'Version' }, { label: 'Status' }, { label: 'Lines' }, { label: 'Annual total', num: true }],
        budgets.map((b) => {
          const total = q<any>('SELECT months FROM budget_lines WHERE budget_id=?', b.id)
            .reduce((s, l) => s + j<number[]>(l.months, []).reduce((x, y) => x + y, 0), 0);
          return { href: `/budgets/${b.id}`, cells: [String(b.year), b.property, `v${b.version}`, statusBadge(b.status), String(b.line_count), usd(total)] };
        }),
        { empty: 'No budgets yet — create one for next year.' },
      ), { flush: true }),
    });
  });

  r.post('/budgets/new', requirePerm('budgets:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const propId = String(rq.body?.property_id);
    const year = Number(rq.body?.year);
    const bid = rq.body?.seed === 'actuals'
      ? seedFromActuals(ctx, propId, year - 1, year, 3)
      : createBudget(ctx, propId, year);
    return redirect(`/budgets/${bid}`, 'Budget created');
  });

  r.get('/budgets/:id', requirePerm('budgets:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const b = q1<any>('SELECT b.*, p.name AS property FROM budgets b JOIN properties p ON p.id=b.property_id WHERE b.id=? AND b.org_id=?', rq.params.id!, ctx.orgId);
    if (!b) return notFound();
    const view = rq.query.get('view') || (b.status === 'approved' ? 'variance' : 'edit');
    const throughMonth = b.year === Number(ctx.businessDate.slice(0, 4)) ? Number(ctx.businessDate.slice(5, 7)) : 12;
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    let body: Child;
    if (view === 'variance') {
      const { rows } = budgetVsActual(ctx, b.id, throughMonth);
      body = card(html`Budget vs actual — YTD through ${MONTHS[throughMonth - 1]}`, tbl(
        [{ label: 'Account' }, { label: 'Type' }, { label: 'Budget YTD', num: true }, { label: 'Actual YTD', num: true }, { label: 'Variance', num: true }, { label: '%', num: true }, { label: '' }],
        rows.map((r2) => {
          const bYtd = r2.budget.slice(0, throughMonth).reduce((s, x) => s + x, 0);
          const aYtd = r2.actual.slice(0, throughMonth).reduce((s, x) => s + x, 0);
          return {
            cells: [
              html`<span class="mono">${r2.code}</span> ${r2.name}`, r2.type, usd(bYtd), usd(aYtd),
              html`<span class="${r2.varianceCents > 0 && r2.type === 'expense' ? 'neg' : ''}">${usd(r2.varianceCents)}</span>`,
              r2.variancePct === null ? '—' : `${r2.variancePct}%`,
              r2.flag === 'ok' ? '' : statusBadge(r2.flag === 'over' ? 'error' : 'warn', r2.flag === 'over' ? 'over budget' : 'under'),
            ],
          };
        }),
        { empty: 'No budget lines.' },
      ), { flush: true });
    } else {
      const lines = q<any>('SELECT * FROM budget_lines WHERE budget_id=? ORDER BY gl_account', b.id);
      body = html`
        ${card('Budget lines', tbl(
          [{ label: 'Account' }, ...MONTHS.map((m) => ({ label: m, num: true })), { label: 'Annual', num: true }],
          lines.map((l) => {
            const months = j<number[]>(l.months, []);
            return {
              cells: [
                html`<span class="mono">${l.gl_account}</span> ${COA.find(([c]) => c === l.gl_account)?.[1] || ''}`,
                ...months.map((m) => usd(m)),
                html`<b>${usd(months.reduce((s, x) => s + x, 0))}</b>`,
              ],
            };
          }),
          { empty: 'No lines yet — add one below.' },
        ), { flush: true })}
        ${when(b.status === 'draft' && can(ctx, 'budgets:manage'), () => card('Add / replace a line', html`
          <form method="post" action="/budgets/${b.id}/line" class="toolbar">
            ${select('gl_account', COA.filter(([, , t]) => t === 'income' || t === 'expense').map(([c, n]): [string, string] => [c, `${c} — ${n}`]), '5010')}
            ${input('annual', { placeholder: 'annual $', required: true })}
            ${select('curve', [['even', 'Even 1/12'], ['seasonal_summer', 'Summer-heavy'], ['seasonal_winter', 'Winter-heavy'], ['front', 'Front-loaded'], ['back', 'Back-loaded']], 'even')}
            <button class="btn">Set line</button>
          </form>`))}`;
    }
    return shell(rq, {
      title: `FY${b.year} budget — ${b.property}`,
      active: '/budgets',
      subtitle: html`v${b.version} · ${statusBadge(b.status)}${b.approved_by ? html` · approved by ${b.approved_by}` : ''}`,
      actions: html`
        ${tabs([
          { href: `/budgets/${b.id}?view=edit`, label: 'Lines', active: view === 'edit' },
          { href: `/budgets/${b.id}?view=variance`, label: 'Budget vs actual', active: view === 'variance' },
        ])}
        ${when(b.status === 'draft' && can(ctx, 'budgets:manage'), () => html`<form method="post" action="/budgets/${b.id}/approve" style="display:inline"><button class="btn">Approve (board)</button></form>`)}`,
      content: body,
    });
  });

  r.post('/budgets/:id/line', requirePerm('budgets:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    try {
      const annual = parseUsd(String(rq.body?.annual || '0'));
      setBudgetLine(ctx, rq.params.id!, String(rq.body?.gl_account), spread(annual, String(rq.body?.curve || 'even') as SpreadCurve));
      return redirect(`/budgets/${rq.params.id}?view=edit`, 'Line saved');
    } catch (e) {
      return redirect(`/budgets/${rq.params.id}?view=edit`, (e as Error).message, 'err');
    }
  });
  r.post('/budgets/:id/approve', requirePerm('budgets:manage'), (rq) => {
    approveBudget(rq.ctx as Ctx, rq.params.id!);
    return redirect(`/budgets/${rq.params.id}?view=variance`, 'Budget approved — now the plan of record');
  });

  // ============================== STATEMENTS ==============================
  r.get('/statements', requirePerm('gl:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const props = propsFor(ctx);
    const kind = rq.query.get('kind') || 'bs';
    const basis = (rq.query.get('basis') || 'accrual') as Basis;
    const propId = rq.query.get('property') || '';
    const asOf = rq.query.get('asof') || ctx.businessDate;
    const from = rq.query.get('from') || `${asOf.slice(0, 7)}-01`;
    const scope = propId || null;
    const scopeName = propId ? props.find((p) => p.id === propId)?.name : 'Consolidated — all properties';
    let body: Child = null;
    if (kind === 'bs') {
      const bs = balanceSheet(ctx, { propertyId: scope, asOf, basis });
      const sec = (title: string, lines: typeof bs.assets, total: number): Child => card(title, tbl(
        [{ label: 'Account' }, { label: 'Balance', num: true }],
        lines.map((l) => ({ cells: [html`<span class="mono">${l.code}</span> ${l.name}`, usd(l.amount)] })),
        { foot: [html`<b>Total ${title.toLowerCase()}</b>`, html`<b>${usd(total)}</b>`] },
      ), { flush: true });
      body = html`
        ${kpis([
          { label: 'Assets', value: usd(bs.totals.assets) },
          { label: 'Liabilities', value: usd(bs.totals.liabilities) },
          { label: 'Equity', value: usd(bs.totals.equity) },
          { label: 'A = L + E', value: bs.balanced ? 'Balanced ✓' : 'OUT OF BALANCE', tone: bs.balanced ? 'ok' : 'bad' },
        ])}
        <div class="cols">${sec('Assets', bs.assets, bs.totals.assets)}<div>${sec('Liabilities', bs.liabilities, bs.totals.liabilities)}${sec('Equity', bs.equity, bs.totals.equity)}</div></div>`;
    } else if (kind === 'is') {
      const is = incomeStatement(ctx, { propertyId: scope, from, to: asOf, basis });
      const sec = (title: string, lines: typeof is.income, total: number): Child => card(title, tbl(
        [{ label: 'Account' }, { label: 'Amount', num: true }],
        lines.map((l) => ({ cells: [html`<span class="mono">${l.code}</span> ${l.name}`, usd(l.amount)] })),
        { foot: [html`<b>Total ${title.toLowerCase()}</b>`, html`<b>${usd(total)}</b>`] },
      ), { flush: true });
      body = html`
        ${kpis([
          { label: 'Income', value: usd(is.totalIncome) },
          { label: 'Expenses', value: usd(is.totalExpenses) },
          { label: 'NOI', value: usd(is.noi), tone: is.noi >= 0 ? 'ok' : 'bad' },
        ])}
        <div class="cols">${sec('Income', is.income, is.totalIncome)}${sec('Expenses', is.expenses, is.totalExpenses)}</div>`;
    } else if (kind === 't12') {
      const m = t12(ctx, { propertyId: scope, to: asOf, basis });
      body = card('Trailing 12 months', html`
        <div class="scroll-x">
        ${tbl(
          [{ label: 'Account' }, ...m.months.map((mk2) => ({ label: fmtMonth(mk2).slice(0, 3), num: true })), { label: 'T-12', num: true }],
          [
            ...m.rows.map((r2) => ({
              cells: [html`<span class="mono">${r2.code}</span> ${r2.name}`, ...r2.cells.map((c) => (c ? usd(c) : '')), html`<b>${usd(r2.total)}</b>`],
            })),
            { cells: [html`<b>NOI</b>`, ...m.totals.noi.map((c) => html`<b>${usd(c)}</b>`), html`<b>${usd(m.totals.noi.reduce((s, x) => s + x, 0))}</b>`] },
          ],
        )}</div>`, { flush: true });
    } else {
      const cf = cashFlow(ctx, { propertyId: scope, from, to: asOf, basis });
      const sec = (title: string, lines: typeof cf.operating): Child => card(title, tbl(
        [{ label: 'Source' }, { label: 'Cash effect', num: true }],
        lines.map((l) => ({ cells: [html`<span class="mono">${l.code}</span> ${l.name}`, usd(l.amount)] })),
        { foot: [html`<b>Net</b>`, html`<b>${usd(lines.reduce((s, l) => s + l.amount, 0))}</b>`] },
      ), { flush: true });
      body = html`
        ${kpis([
          { label: 'Opening cash', value: usd(cf.opening) },
          { label: 'Net change', value: usd(cf.netChange), tone: cf.netChange >= 0 ? 'ok' : 'bad' },
          { label: 'Closing cash', value: usd(cf.closing) },
        ])}
        ${sec('Operating activities', cf.operating)}
        ${when(cf.investing.length, () => sec('Investing activities', cf.investing))}
        ${when(cf.financing.length, () => sec('Financing activities', cf.financing))}`;
    }
    return shell(rq, {
      title: 'Financial statements',
      active: '/statements',
      subtitle: html`${scopeName} · ${basis} basis`,
      actions: html`<a class="btn btn-ghost" href="/statements/export?kind=${kind}&basis=${basis}&property=${propId}&asof=${asOf}&from=${from}">Download CSV</a>`,
      content: html`
        ${tabs([
          { href: `/statements?kind=bs&basis=${basis}&property=${propId}&asof=${asOf}`, label: 'Balance sheet', active: kind === 'bs' },
          { href: `/statements?kind=is&basis=${basis}&property=${propId}&asof=${asOf}&from=${from}`, label: 'Income statement', active: kind === 'is' },
          { href: `/statements?kind=t12&basis=${basis}&property=${propId}&asof=${asOf}`, label: 'T-12', active: kind === 't12' },
          { href: `/statements?kind=cf&basis=${basis}&property=${propId}&asof=${asOf}&from=${from}`, label: 'Cash flow', active: kind === 'cf' },
        ])}
        <form method="get" class="toolbar" data-autosubmit>
          <input type="hidden" name="kind" value="${kind}">
          ${field('Scope', select('property', props.map((p): [string, string] => [p.id, p.name]), propId, { blank: 'Consolidated (all)' }))}
          ${field('Basis', select('basis', [['accrual', 'Accrual'], ['cash', 'Cash']], basis))}
          ${field(kind === 'bs' ? 'As of' : 'Period end', input('asof', { type: 'date', value: asOf }))}
          ${when(kind === 'is' || kind === 'cf', () => field('Period start', input('from', { type: 'date', value: from })))}
        </form>
        ${body}`,
    });
  });

  r.get('/statements/export', requirePerm('gl:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const kind = rq.query.get('kind') || 'bs';
    const basis = (rq.query.get('basis') || 'accrual') as Basis;
    const propId = rq.query.get('property') || null;
    const asOf = rq.query.get('asof') || ctx.businessDate;
    const from = rq.query.get('from') || `${asOf.slice(0, 7)}-01`;
    let rows: (string | number)[][] = [];
    if (kind === 'bs') {
      const bs = balanceSheet(ctx, { propertyId: propId, asOf, basis });
      rows = [['Section', 'Code', 'Account', 'Balance'],
        ...bs.assets.map((l) => ['Assets', l.code, l.name, l.amount / 100]),
        ...bs.liabilities.map((l) => ['Liabilities', l.code, l.name, l.amount / 100]),
        ...bs.equity.map((l) => ['Equity', l.code, l.name, l.amount / 100])];
    } else if (kind === 't12') {
      const m = t12(ctx, { propertyId: propId, to: asOf, basis });
      rows = [['Code', 'Account', ...m.months, 'Total'],
        ...m.rows.map((r2) => [r2.code, r2.name, ...r2.cells.map((c) => c / 100), r2.total / 100])];
    } else if (kind === 'is') {
      const is = incomeStatement(ctx, { propertyId: propId, from, to: asOf, basis });
      rows = [['Section', 'Code', 'Account', 'Amount'],
        ...is.income.map((l) => ['Income', l.code, l.name, l.amount / 100]),
        ...is.expenses.map((l) => ['Expenses', l.code, l.name, l.amount / 100]),
        ['', '', 'NOI', is.noi / 100]];
    } else {
      const cf = cashFlow(ctx, { propertyId: propId, from, to: asOf, basis });
      rows = [['Section', 'Code', 'Source', 'Cash effect'],
        ...cf.operating.map((l) => ['Operating', l.code, l.name, l.amount / 100]),
        ...cf.investing.map((l) => ['Investing', l.code, l.name, l.amount / 100]),
        ...cf.financing.map((l) => ['Financing', l.code, l.name, l.amount / 100]),
        ['', '', 'Net change', cf.netChange / 100]];
    }
    return {
      status: 200,
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${kind}-${asOf}.csv"` },
      body: toCsv(rows),
    };
  });

  // ============================== CAPITAL PROJECTS (M9.8) ==============================
  r.get('/projects', requirePerm('gl:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const projects = q<any>(
      `SELECT cp.*, p.name AS property,
        (SELECT COALESCE(SUM(l.amount_cents),0) FROM vendor_invoice_lines l JOIN vendor_invoices vi ON vi.id=l.invoice_id
          WHERE l.project_id=cp.id AND vi.status IN ('approved','paid')) AS actuals
       FROM capital_projects cp JOIN properties p ON p.id=cp.property_id WHERE cp.org_id=? ORDER BY cp.created_at DESC`,
      ctx.orgId,
    );
    return shell(rq, {
      title: 'Capital projects',
      active: '/gl',
      subtitle: 'Job costing: budget vs committed actuals from coded AP lines',
      content: card(null, tbl(
        [{ label: 'Project' }, { label: 'Property' }, { label: 'Status' }, { label: 'Budget', num: true }, { label: 'Committed (open POs)', num: true }, { label: 'Actuals', num: true }, { label: 'Remaining', num: true }],
        projects.map((p) => {
          const committed = projectCommitments(ctx, p.id);
          const remaining = p.budget_cents - p.actuals - committed;
          return {
            href: `/projects/${p.id}`,
            cells: [p.name, p.property, statusBadge(p.status), usd(p.budget_cents), usd(committed), usd(p.actuals), html`<span class="${remaining < 0 ? 'neg' : ''}">${usd(remaining)}</span>`],
          };
        }),
        { empty: 'No capital projects.' },
      ), { flush: true }),
    });
  });

  r.get('/projects/:id', requirePerm('gl:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const p = q1<any>('SELECT cp.*, pr.name AS property FROM capital_projects cp JOIN properties pr ON pr.id=cp.property_id WHERE cp.id=? AND cp.org_id=?', rq.params.id!, ctx.orgId);
    if (!p) return notFound();
    const codes = j<any[]>(p.cost_codes, []);
    const lines = q<any>(
      `SELECT l.*, vi.invoice_number, vi.status AS inv_status, v.name AS vendor FROM vendor_invoice_lines l
       JOIN vendor_invoices vi ON vi.id=l.invoice_id JOIN vendors v ON v.id=vi.vendor_id
       WHERE l.project_id=? AND vi.status IN ('approved','paid') ORDER BY vi.invoice_date`,
      p.id,
    );
    const byCode = new Map<string, number>();
    for (const l of lines) byCode.set(l.cost_code || 'uncoded', (byCode.get(l.cost_code || 'uncoded') || 0) + l.amount_cents);
    return shell(rq, {
      title: p.name,
      active: '/gl',
      subtitle: html`${p.property} · ${statusBadge(p.status)} · budget ${usd(p.budget_cents)}`,
      content: html`
        ${card('Cost codes', tbl(
          [{ label: 'Code' }, { label: 'Scope' }, { label: 'Budget', num: true }, { label: 'Actuals', num: true }, { label: 'Remaining', num: true }],
          codes.map((c) => {
            const act = byCode.get(c.code) || 0;
            return { cells: [html`<span class="mono">${c.code}</span>`, c.label, usd(c.budget_cents), usd(act), html`<span class="${act > c.budget_cents ? 'neg' : ''}">${usd(c.budget_cents - act)}</span>`] };
          }),
          { empty: 'No cost codes defined.' },
        ), { flush: true })}
        ${card('Coded invoice lines', tbl(
          [{ label: 'Invoice' }, { label: 'Vendor' }, { label: 'Cost code' }, { label: 'Description' }, { label: 'Status' }, { label: 'Amount', num: true }],
          lines.map((l) => ({
            href: `/ap/${l.invoice_id}`,
            cells: [html`<span class="mono">${l.invoice_number}</span>`, l.vendor, l.cost_code || '—', l.description, statusBadge(l.inv_status), usd(l.amount_cents)],
          })),
          { empty: 'Nothing coded to this project yet.' },
        ), { flush: true })}`,
    });
  });
}
