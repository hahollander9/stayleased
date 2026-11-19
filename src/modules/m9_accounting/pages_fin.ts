import { html, when, join, type Child } from '../../lib/html.ts';
import { notFound, redirect, type Router } from '../../lib/http.ts';
import { requirePerm, can, canAccessProperty, propFilter, type Ctx } from '../../lib/auth.ts';
import { audit } from '../../lib/audit.ts';
import { q, q1, val, j } from '../../lib/db.ts';
import { fmtDate, fmtMonth, monthKey, lastOfMonth, addMonths } from '../../lib/dates.ts';
import { usd, parseUsd } from '../../lib/money.ts';
import { shell, card, tbl, dl, statusBadge, field, select, input, moneyInput, registerNav, kpis, tabs, emptyState, noProperties } from '../../ui/ui.ts';
import { COA } from './coa.ts';
import { accountBalance } from './service.ts';
import {
  ensureBankAccounts, importAllFeeds, createRecon, autoMatch, postAdjustment, excludeTxn, completeRecon, reconSummary, reconPreview,
  unreconciledAging, unmatchedTotal, bankLabel, addStatementLine, setStatementClose, matchCandidates, matchEntries, unmatchTxn, markInOpeningBalance,
} from './banking.ts';
import { closeChecklist, closePeriod, reopenPeriod, periodGrid, submitManualJe, decidePendingJe, createRecurringJe, pendingJeIsOwn, otherJeApprovers } from './close.ts';
import { getSetting } from '../../lib/settings.ts';
import { balanceSheet, incomeStatement, t12, cashFlow, toCsv, type Basis } from './statements.ts';
import { createBudget, setBudgetLine, approveBudget, budgetVsActual, seedFromActuals, spread, type SpreadCurve } from './budgets.ts';
import { createPacket, deletePacket, getPacket, listPackets, packetData, packetScopeName, packetCsv, packetPdf } from './packets.ts';
import { projectCommitments } from '../m16_procurement/service.ts';

/** M9 complete — banking & reconciliation, period close, budgets, financial
 * statements, recurring/manual JEs, capital projects. */

registerNav('Money', { href: '/banking', label: 'Banking', perm: 'banking:view', match: ['/banking'] });
registerNav('Money', { href: '/periods', label: 'Month-end close', perm: 'gl:close_period', match: ['/periods'] });
registerNav('Money', { href: '/budgets', label: 'Budgets', perm: 'budgets:view', match: ['/budgets'] });
registerNav('Money', { href: '/statements', label: 'Statements', perm: 'gl:view', match: ['/statements'] });

/** where a statement line came from, in words (the stored ref is an id) */
function lineSource(ref: string | null | undefined): string {
  const r = String(ref || '');
  if (r.startsWith('manual:')) return 'typed in';
  if (r.startsWith('file:') || r.startsWith('ofx:')) return 'from a file';
  return r;
}

function matchLabel(kind: string | null | undefined): string {
  return kind === 'ap_payment' ? 'vendor payment' : kind === 'settlement' ? 'deposit batch' : kind === 'multi' ? 'several entries' : 'journal entry';
}

function propsFor(ctx: Ctx): any[] {
  const pf = propFilter(ctx, 'id');
  return q<any>(`SELECT id, name FROM properties WHERE org_id=?${pf.sql} ORDER BY name`, ctx.orgId, ...pf.params);
}

export function routes(r: Router): void {
  // ============================== BANKING ==============================
  // Reading these pages writes nothing: accounts are created by the import,
  // by the opening balance, or by the button below; a reconciliation is
  // created when someone starts it.
  r.get('/banking', requirePerm('banking:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const live = ctx.orgKind === 'live';
    const accounts = q<any>(
      `SELECT b.*, p.name AS property,
        (SELECT COUNT(*) FROM bank_txns t WHERE t.bank_account_id=b.id AND t.status='unmatched') AS open_txns,
        (SELECT COALESCE(SUM(amount_cents),0) FROM bank_txns t WHERE t.bank_account_id=b.id AND t.status!='excluded') AS balance,
        (SELECT r.period_key FROM bank_recons r WHERE r.bank_account_id=b.id AND r.status='completed' ORDER BY r.period_key DESC LIMIT 1) AS last_period,
        (SELECT r.statement_close_cents FROM bank_recons r WHERE r.bank_account_id=b.id AND r.status='completed' ORDER BY r.period_key DESC LIMIT 1) AS last_close
       FROM bank_accounts b LEFT JOIN properties p ON p.id=b.property_id WHERE b.org_id=? AND b.active=1 ORDER BY b.created_at`,
      ctx.orgId,
    );
    const recons = q<any>(
      `SELECT r.*, b.name AS account FROM bank_recons r JOIN bank_accounts b ON b.id=r.bank_account_id
       WHERE r.org_id=? ORDER BY r.period_key DESC, b.name LIMIT 40`, ctx.orgId,
    );
    const aging = unreconciledAging(ctx);
    const missing = (val<number>(
      `SELECT COUNT(*) FROM properties p WHERE p.org_id=? AND NOT EXISTS
         (SELECT 1 FROM bank_accounts b WHERE b.org_id=p.org_id AND b.property_id=p.id AND b.kind='operating')`, ctx.orgId,
    ) || 0);
    const canRec = can(ctx, 'banking:reconcile');
    const setUp = when(missing > 0 && canRec, () => html`
      <form method="post" action="/banking/accounts" style="display:inline"><button class="btn">Create an operating account for each property</button></form>`);
    return shell(rq, {
      title: 'Banking & reconciliation',
      active: '/banking',
      subtitle: live
        ? 'Statement import, matching and reconciliation'
        : 'Simulated bank feed, statement matching and reconciliation history',
      actions: live
        ? html`<a class="btn btn-ghost" href="/gl/setup">Bank accounts</a>`
        : html`<form method="post" action="/banking/import" style="display:inline"><button class="btn btn-ghost">Pull latest feed</button></form>`,
      content: html`
        ${when(live, () => html`<p class="small muted">No bank is connected to StayLeased. Statement lines come from a file downloaded from the bank or are typed in on the account's page; nothing here is fetched from a bank.</p>`)}
        ${accounts.length
          ? card('Accounts', html`${tbl(
            live
              ? [{ label: 'Account' }, { label: 'Bank' }, { label: 'Last reconciled' }, { label: 'Unmatched lines', num: true }, { label: '' }]
              : [{ label: 'Account' }, { label: 'Bank' }, { label: 'Last 4' }, { label: 'Feed balance', num: true }, { label: 'Unmatched', num: true }, { label: '' }],
            accounts.map((a) => {
              const openBadge = a.open_txns ? html`<span class="badge badge-warn">${a.open_txns}</span>` : '0';
              const links = html`${when(canRec, () => html`<a class="btn btn-sm" href="/banking/${a.id}/reconcile">Reconcile</a> `)}<a class="btn btn-ghost btn-sm" href="/banking/${a.id}">${live ? 'Statement lines' : 'Transactions'}</a>`;
              return {
                cells: live
                  ? [a.name, bankLabel(a, true), a.last_period ? `${fmtMonth(a.last_period)} · ${usd(a.last_close)}` : 'Not yet', openBadge, links]
                  : [a.name, a.bank_name, html`<span class="mono">…${a.last4}</span>`, usd(a.balance), openBadge, links],
              };
            }),
          )}${when(missing > 0, () => html`<div style="padding:10px 14px"><span class="small muted">${missing} propert${missing === 1 ? 'y has' : 'ies have'} no operating account yet.</span> ${setUp}</div>`)}`, { flush: true })
          : emptyState('No bank accounts yet',
            live
              ? 'Add the accounts your properties bank with. Each one gets its own statement lines and its own monthly reconciliation.'
              : 'Pull the feed to create a simulated operating account for each property.',
            html`${setUp} ${when(live, () => html`<a class="btn btn-ghost" href="/gl/setup">Add a bank account</a>`)}`)}
        ${when(accounts.length, () => card('Unreconciled item aging', tbl(
          [{ label: 'Account' }, { label: '0-30', num: true }, { label: '31-60', num: true }, { label: '61-90', num: true }, { label: '90+', num: true }],
          aging.map((a) => ({
            cells: [a.account.name, ...(['0-30', '31-60', '61-90', '90+'] as const).map((k) =>
              a.buckets[k]!.n ? html`${a.buckets[k]!.n} · ${usd(a.buckets[k]!.amount)}` : '—')],
          })),
        ), { flush: true }))}
        ${card('Reconciliation history', tbl(
          [{ label: 'Month' }, { label: 'Account' }, { label: 'Statement close', num: true }, { label: 'Unmatched', num: true }, { label: 'Status' }, { label: 'Completed' }],
          recons.map((rc) => ({
            href: `/banking/${rc.bank_account_id}/reconcile?month=${rc.period_key}`,
            cells: [fmtMonth(rc.period_key), rc.account, usd(rc.statement_close_cents), rc.difference_cents ? html`<b>${usd(rc.difference_cents)}</b>` : usd(0), statusBadge(rc.status), rc.completed_by ? `${rc.completed_by} · ${fmtDate((rc.completed_at || '').slice(0, 10))}` : '—'],
          })),
          { empty: 'No reconciliations yet — pick an account above.' },
        ), { flush: true })}`,
    });
  });

  r.post('/banking/accounts', requirePerm('banking:reconcile'), (rq) => {
    const ctx = rq.ctx as Ctx;
    ensureBankAccounts(ctx.orgId);
    audit(ctx, 'org', ctx.orgId, 'bank_accounts_created');
    return redirect('/banking', ctx.orgKind === 'live'
      ? 'Operating accounts created. Add each bank name and last 4 digits under Bank accounts.'
      : 'Operating accounts created.');
  });

  r.post('/banking/import', requirePerm('banking:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    // the simulated feed is for demo organizations; importFeed refuses a live
    // one itself, this just says why nothing happened
    if (ctx.orgKind === 'live') {
      return redirect('/banking', 'No bank is connected. Upload a statement file or type the lines in on the account page.', 'err');
    }
    ensureBankAccounts(ctx.orgId);
    const n = importAllFeeds(ctx.orgId, ctx.businessDate);
    return redirect('/banking', n ? `${n} new bank transactions imported` : 'Feed already up to date');
  });

  r.get('/banking/:id', requirePerm('banking:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const live = ctx.orgKind === 'live';
    const acct = q1<any>('SELECT * FROM bank_accounts WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!acct) return notFound();
    const txns = q<any>('SELECT * FROM bank_txns WHERE bank_account_id=? ORDER BY date DESC, imported_at DESC LIMIT 300', acct.id);
    const canRec = can(ctx, 'banking:reconcile');
    return shell(rq, {
      title: acct.name,
      active: '/banking',
      subtitle: `${bankLabel(acct, live)} · ${txns.length < 300 ? txns.length : '300+'} statement line${txns.length === 1 ? '' : 's'} on file`,
      actions: when(canRec, () => html`<a class="btn" href="/banking/${acct.id}/reconcile">Reconcile</a>`),
      content: html`
        ${when(canRec, () => html`<div class="cols">
          <div>${card('Import a statement file', html`
            <form method="post" action="/banking/${acct.id}/upload" enctype="multipart/form-data" class="toolbar">
              ${field('CSV or OFX/QFX from the bank', html`<input type="file" name="statement" accept=".csv,.ofx,.qfx,.txt" required />`)}
              <button class="btn">Import transactions</button>
            </form>
            <p class="small muted">Date, description, and amount (or debit and credit) columns are found automatically. Importing the same file twice adds nothing. Lines dated in a month that is already reconciled are left out.</p>`)}</div>
          <div>${card('Add a statement line by hand', html`
            <form method="post" action="/banking/${acct.id}/txn">
              <div class="grid2">
                ${field('Date on the statement', input('date', { type: 'date', value: ctx.businessDate, required: true }))}
                ${field('Money in or out', select('direction', [['out', 'Money out (check, payment, fee)'], ['in', 'Money in (deposit, interest)']], 'out'))}
                ${field('Description', input('description', { required: true, placeholder: 'as printed on the statement' }))}
                ${field('Amount', moneyInput('amount', null, { required: true }))}
              </div>
              <button class="btn">Add line</button>
            </form>`)}</div>
        </div>`)}
        ${card('Statement lines', tbl(
          [{ label: 'Date' }, { label: 'Description' }, { label: 'Kind' }, { label: 'Status' }, { label: 'Amount', num: true }],
          txns.map((t) => ({
            cells: [fmtDate(t.date), html`${t.description} <span class="mono small muted">${lineSource(t.ref)}</span>`, t.kind, statusBadge(t.status, t.status === 'excluded' ? 'set aside' : undefined), html`<span class="${t.amount_cents < 0 ? 'neg' : ''}">${usd(t.amount_cents)}</span>`],
          })),
          { empty: live ? 'No statement lines yet — import a file from the bank or add lines by hand above.' : 'No transactions yet — import a statement file above or pull the demo feed from the banking page.' },
        ), { flush: true })}`,
    });
  });

  r.post('/banking/:id/txn', requirePerm('banking:reconcile'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const acct = q1<any>('SELECT * FROM bank_accounts WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!acct) return notFound();
    const b = rq.body || {};
    const month = String(b.month || '');
    const back = /^\d{4}-\d{2}$/.test(month) ? `/banking/${acct.id}/reconcile?month=${month}` : `/banking/${acct.id}`;
    try {
      const amount = Math.abs(parseUsd(String(b.amount || '')));
      addStatementLine(ctx, acct.id, {
        date: String(b.date || ''), description: String(b.description || ''),
        amountCents: String(b.direction) === 'in' ? amount : -amount,
      });
      return redirect(back, 'Statement line added.');
    } catch (e) {
      const msg = (e as Error).message;
      return redirect(back, /^invalid amount/.test(msg) ? 'Enter the amount shown on the statement, like 1250.00.' : msg, 'err');
    }
  });

  // ---------- reconciliation workbench ----------
  r.get('/banking/:id/reconcile', requirePerm('banking:reconcile'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const live = ctx.orgKind === 'live';
    const acct = q1<any>('SELECT * FROM bank_accounts WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!acct) return notFound();
    // default month: first month with unmatched lines, else last full month
    const suggested = val<string>(
      `SELECT substr(date,1,7) FROM bank_txns WHERE bank_account_id=? AND status='unmatched' ORDER BY date LIMIT 1`, acct.id,
    ) || monthKey(addMonths(ctx.businessDate, -1));
    const asked = rq.query.get('month') || '';
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(asked) ? asked : suggested;
    // look, do not create: a reconciliation exists once someone starts it
    const rec = q1<any>('SELECT * FROM bank_recons WHERE bank_account_id=? AND period_key=? AND org_id=?', acct.id, month, ctx.orgId);
    const s = rec ? reconSummary(ctx, rec.id) : reconPreview(ctx, acct.id, month);
    const open = !!rec && rec.status !== 'completed';
    const txns = q<any>(
      `SELECT * FROM bank_txns WHERE bank_account_id=? AND substr(date,1,7)=? ORDER BY status DESC, date`, acct.id, month,
    );
    const diff = unmatchedTotal(ctx.orgId, acct.id, month);
    const months: [string, string][] = [];
    for (let i = 14; i >= 0; i--) {
      const mk2 = monthKey(addMonths(ctx.businessDate, -i));
      months.push([mk2, fmtMonth(mk2)]);
    }
    if (!months.some(([k]) => k === month)) months.unshift([month, fmtMonth(month)]);
    const ties = s.unmatchedCount === 0 && s.tieDifference === 0;
    const firstPeriod = val<string>('SELECT MIN(period_key) FROM bank_recons WHERE bank_account_id=?', acct.id);
    const notCleared = [...s.inTransit, ...s.outstanding].sort((a, b) => (a.date < b.date ? -1 : 1));
    const glName = COA.find(([c]) => c === acct.gl_account)?.[1] || 'Cash';
    return shell(rq, {
      title: `Reconcile — ${fmtMonth(month)}`,
      active: '/banking',
      subtitle: rec
        ? html`${acct.name} · statement ending balance ${usd(s.statementClose)} · ${statusBadge(rec.status)}`
        : html`${acct.name} · ${statusBadge('draft', 'not started')}`,
      actions: html`
        ${when(open, () => html`
          <form method="post" action="/banking/${acct.id}/reconcile/${rec.id}/automatch" style="display:inline"><button class="btn">Auto-match</button></form>
          <form method="post" action="/banking/${acct.id}/reconcile/${rec.id}/complete" style="display:inline"><button class="btn" ${ties ? '' : 'disabled'}>Complete at $0.00</button></form>`)}
        ${when(!rec && !live, () => html`
          <form method="post" action="/banking/${acct.id}/reconcile/start" style="display:inline">
            <input type="hidden" name="month" value="${month}"><input type="hidden" name="automatch" value="1">
            <button class="btn">Auto-match</button>
          </form>`)}
        ${when(rec, () => html`<a class="btn btn-ghost" href="/banking/${acct.id}/reconcile/${rec.id}/report">Report</a>`)}`,
      content: html`
        <form method="get" class="toolbar" data-autosubmit>${field('Statement month', select('month', months, month))}</form>
        ${when(!rec && live, () => card(`Start reconciling ${fmtMonth(month)}`, html`
          <form method="post" action="/banking/${acct.id}/reconcile/start" class="toolbar">
            <input type="hidden" name="month" value="${month}">
            ${field('Ending balance on the bank statement', input('statement_close', { required: true, placeholder: '0.00' }), `as printed for ${fmtDate(s.end)}; put a minus sign in front if the account is overdrawn`)}
            <button class="btn">Start reconciliation</button>
          </form>
          <p class="small muted">Have the statement for ${fmtMonth(month)} in front of you. ${txns.length ? `${txns.length} statement line${txns.length === 1 ? ' is' : 's are'} on file for this month.` : html`No statement lines are on file for this month yet — <a href="/banking/${acct.id}">import the bank's file or add them by hand</a> first or after starting.`}</p>`))}
        ${when(rec, () => kpis([
          { label: 'Unmatched difference', value: usd(diff), tone: s.unmatchedCount === 0 ? 'ok' : 'warn' },
          { label: 'Unmatched lines', value: String(s.unmatchedCount), tone: s.unmatchedCount === 0 ? 'ok' : 'warn' },
          { label: 'Statement ending balance', value: usd(s.statementClose) },
          { label: `Book balance, ${fmtDate(s.end)}`, value: usd(s.bookClose) },
          { label: 'Still to explain', value: usd(s.tieDifference), tone: s.tieDifference === 0 ? 'ok' : 'warn' },
        ]))}
        ${when(open && live, () => html`
          <form method="post" action="/banking/${acct.id}/reconcile/${rec.id}/statement" class="toolbar">
            ${field('Ending balance on the bank statement', input('statement_close', { value: (s.statementClose / 100).toFixed(2), required: true }))}
            <button class="btn btn-ghost">Update balance</button>
          </form>`)}
        ${when(open && s.linesGap !== null && s.linesGap !== 0, () => html`<p class="callout warn">The lines on file for ${fmtMonth(month)} do not add up to the change in the statement balance since last month — they are off by ${usd(Math.abs(s.linesGap || 0))}. A statement line is probably missing or entered twice.</p>`)}
        ${card('Statement lines', html`${tbl(
          [{ label: 'Date' }, { label: 'Description' }, { label: 'Kind' }, { label: 'Amount', num: true }, { label: 'Status' }, { label: 'Action' }],
          txns.map((t) => ({
            cells: [
              fmtDate(t.date), html`${t.description} <span class="mono small muted">${lineSource(t.ref)}</span>`, t.kind,
              html`<span class="${t.amount_cents < 0 ? 'neg' : ''}">${usd(t.amount_cents)}</span>`,
              statusBadge(t.status === 'excluded' ? 'inactive' : t.status, t.status === 'matched' ? `matched · ${matchLabel(t.matched_kind)}` : t.status === 'excluded' ? 'set aside' : undefined),
              !open ? ''
                : t.status === 'unmatched'
                  ? html`
                    <a class="btn btn-sm" href="/banking/txn/${t.id}">Match or record</a>
                    ${when(t.kind === 'fee' || t.kind === 'interest' || !live, () => html`<form method="post" action="/banking/txn/${t.id}/adjust" style="display:inline"><button class="btn btn-ghost btn-sm">${t.kind === 'fee' ? 'Record as bank fee' : t.kind === 'interest' ? 'Record as other income' : 'Post adjustment JE'}</button></form>`)}`
                  : html`<form method="post" action="/banking/txn/${t.id}/unmatch" style="display:inline" data-confirm="${t.status === 'excluded' ? 'Bring this line back?' : 'Undo this match?'}"><button class="btn btn-ghost btn-sm">${t.status === 'excluded' ? 'Bring back' : 'Undo'}</button></form>`,
            ],
          })),
          { empty: 'No statement lines on file for this month.' },
        )}
        ${when(open || (!rec && live), () => html`
          <details style="padding:10px 14px"><summary class="small">Add a statement line by hand</summary>
            <form method="post" action="/banking/${acct.id}/txn" class="toolbar" style="margin-top:8px">
              <input type="hidden" name="month" value="${month}">
              ${field('Date on the statement', input('date', { type: 'date', value: s.end, required: true }))}
              ${field('Money in or out', select('direction', [['out', 'Money out'], ['in', 'Money in']], 'out'))}
              ${field('Description', input('description', { required: true, placeholder: 'as printed on the statement' }))}
              ${field('Amount', moneyInput('amount', null, { required: true }))}
              <button class="btn btn-sm">Add line</button>
            </form>
          </details>`)}`, { flush: true })}
        ${when(notCleared.length, () => card(`On the books, not on a statement yet (as of ${fmtDate(s.end)})`, html`${tbl(
          [{ label: 'Date' }, { label: 'Entry' }, { label: 'Amount', num: true }, { label: '' }],
          notCleared.slice(0, 60).map((o) => ({
            cells: [
              fmtDate(o.date), o.desc, html`<span class="${o.amount < 0 ? 'neg' : ''}">${usd(o.amount)}</span>`,
              open && live && firstPeriod && o.date < `${firstPeriod}-01`
                ? html`<form method="post" action="/banking/${acct.id}/entries/${o.id}/opening" style="display:inline" data-confirm="Treat this entry as already included in the bank balance before the first statement?"><input type="hidden" name="month" value="${month}"><button class="btn btn-ghost btn-sm">Already in the opening balance</button></form>`
                : '',
            ],
          })),
        )}
        <p class="small muted" style="padding:0 14px 10px">${notCleared.length > 60 ? `Showing the first 60 of ${notCleared.length}. ` : ''}Payments the bank has not paid yet and deposits it has not shown yet. They are expected to appear on a later statement; match them there.</p>`, { flush: true }))}
        ${when(rec, () => card('Book to bank', html`${dl([
          ['Ending balance on the statement', usd(s.statementClose)],
          ['Plus deposits not on a statement yet', usd(s.inTransit.reduce((x, o) => x + o.amount, 0))],
          ['Less payments not cleared yet', usd(s.outstanding.reduce((x, o) => x + o.amount, 0))],
          ['Statement balance after those', html`<b>${usd(s.statementClose + s.unclearedTotal)}</b>`],
          [`Book balance (${acct.gl_account} ${glName}) on ${fmtDate(s.end)}`, html`<b>${usd(s.bookClose)}</b>`],
          ['Still to explain', html`<b>${usd(s.tieDifference)}</b>`],
        ])}
        <p class="small muted">The month can be completed when no statement line is unmatched and nothing is left to explain. ${when(s.adjusted !== 0, () => html`Entries recorded from statement lines in this reconciliation: ${usd(s.adjusted)}.`)}</p>`))}`,
    });
  });

  r.post('/banking/:id/reconcile/start', requirePerm('banking:reconcile'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const acct = q1<any>('SELECT * FROM bank_accounts WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!acct) return notFound();
    const month = String(rq.body?.month || '');
    const back = `/banking/${acct.id}/reconcile${/^\d{4}-\d{2}$/.test(month) ? `?month=${month}` : ''}`;
    try {
      let close: number | null = null;
      if (ctx.orgKind === 'live') {
        try { close = parseUsd(String(rq.body?.statement_close ?? '')); } catch { throw new Error('Enter the ending balance printed on the bank statement, like 12450.18.'); }
      }
      const rid = createRecon(ctx, acct.id, month, { statementCloseCents: close });
      if (rq.body?.automatch === '1') {
        const res = autoMatch(ctx, rid);
        return redirect(back, `${res.matched} matched · ${res.remaining} still open`);
      }
      return redirect(back, `Reconciliation started for ${fmtMonth(month)}.`);
    } catch (e) {
      return redirect(back, (e as Error).message, 'err');
    }
  });

  r.post('/banking/:id/reconcile/:rid/statement', requirePerm('banking:reconcile'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const rec = q1<any>('SELECT * FROM bank_recons WHERE id=? AND org_id=? AND bank_account_id=?', rq.params.rid!, ctx.orgId, rq.params.id!);
    if (!rec) return notFound();
    const back = `/banking/${rec.bank_account_id}/reconcile?month=${rec.period_key}`;
    try {
      let close: number;
      try { close = parseUsd(String(rq.body?.statement_close ?? '')); } catch { throw new Error('Enter the ending balance printed on the bank statement, like 12450.18.'); }
      setStatementClose(ctx, rec.id, close);
      return redirect(back, 'Statement ending balance updated.');
    } catch (e) {
      return redirect(back, (e as Error).message, 'err');
    }
  });

  r.post('/banking/:id/reconcile/:rid/automatch', requirePerm('banking:reconcile'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const rec = q1<any>('SELECT * FROM bank_recons WHERE id=? AND org_id=?', rq.params.rid!, ctx.orgId);
    if (!rec) return notFound();
    const back = `/banking/${rec.bank_account_id}/reconcile?month=${rec.period_key}`;
    try {
      const res = autoMatch(ctx, rec.id);
      return redirect(back, `${res.matched} matched · ${res.remaining} still open`);
    } catch (e) {
      return redirect(back, (e as Error).message, 'err');
    }
  });
  r.post('/banking/:id/reconcile/:rid/complete', requirePerm('banking:reconcile'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const rec = q1<any>('SELECT * FROM bank_recons WHERE id=? AND org_id=?', rq.params.rid!, ctx.orgId);
    if (!rec) return notFound();
    const back = `/banking/${rec.bank_account_id}/reconcile?month=${rec.period_key}`;
    try {
      completeRecon(ctx, rec.id);
      return redirect(back, 'Reconciled to zero difference ✓');
    } catch (e) {
      return redirect(back, (e as Error).message, 'err');
    }
  });

  // ---------- one statement line: match it, record it, or set it aside ----------
  const lineBack = (t: any): string => `/banking/${t.bank_account_id}/reconcile?month=${String(t.date).slice(0, 7)}`;

  r.get('/banking/txn/:id', requirePerm('banking:reconcile'), (rq) => {
    const ctx = rq.ctx as Ctx;
    let c;
    try { c = matchCandidates(ctx, rq.params.id!); } catch { return notFound(); }
    const { txn: t, acct, items } = c;
    const props = acct.property_id ? [] : propsFor(ctx);
    const accounts = q<any>(`SELECT code, name FROM gl_accounts WHERE org_id=? AND active=1 AND code!=? ORDER BY code`, ctx.orgId, acct.gl_account);
    const guess = t.kind === 'fee' ? '5710' : t.amount_cents > 0 ? '' : '';
    return shell(rq, {
      title: 'Statement line',
      active: '/banking',
      crumbs: [['Banking', '/banking'], [`Reconcile — ${fmtMonth(String(t.date).slice(0, 7))}`, lineBack(t)]],
      subtitle: html`${acct.name} · ${fmtDate(t.date)} · ${t.description} · <b>${usd(t.amount_cents)}</b> · ${statusBadge(t.status === 'excluded' ? 'inactive' : t.status, t.status === 'excluded' ? 'set aside' : undefined)}`,
      content: t.status !== 'unmatched'
        ? emptyState('This line is already dealt with', 'Undo it from the reconciliation page to change it.', html`<a class="btn" href="${lineBack(t)}">Back to the reconciliation</a>`)
        : html`
        ${card('It is already on the books — match it', items.length ? html`
          <form method="post" action="/banking/txn/${t.id}/match">
            ${tbl(
              [{ label: '' }, { label: 'Date' }, { label: 'Entry' }, { label: 'Amount', num: true }],
              items.map((i) => ({
                cells: [
                  html`<input type="checkbox" name="entry_ids" value="${i.id}" aria-label="Match to ${i.memo || i.sourceKind} ${usd(i.net)}" ${items.filter((x) => x.net === t.amount_cents).length === 1 && i.net === t.amount_cents ? 'checked' : ''}>`,
                  fmtDate(i.date), i.memo || i.sourceKind.replaceAll('_', ' '),
                  html`<span class="${i.net < 0 ? 'neg' : ''}">${i.net === t.amount_cents ? html`<b>${usd(i.net)}</b>` : usd(i.net)}</span>`,
                ],
              })),
              { sort: false },
            )}
            <div class="toolbar"><button class="btn">Match to the ticked entries</button></div>
            <p class="small muted">Tick one entry, or several that add up to ${usd(t.amount_cents)} — one deposit often covers several receipts. Entries shown are those the bank has not cleared yet; exact amounts are listed first.</p>
          </form>` : emptyState('Nothing on the books is waiting to clear', 'Every entry that moved this bank account is already matched to a statement line. If this line is real, record it below.'))}
        ${card('It is not on the books yet — record it', html`
          <form method="post" action="/banking/txn/${t.id}/adjust">
            <div class="grid2">
              ${field(t.amount_cents > 0 ? 'What the money was for' : 'What the money went to', select('account', accounts.map((a): [string, string] => [a.code, `${a.code} — ${a.name}`]), guess, { required: true, blank: 'Choose an account…' }))}
              ${field('Note', input('memo', { value: t.description, placeholder: 'what this was' }))}
              ${when(props.length, () => field('Property', select('property_id', props.map((p): [string, string] => [p.id, p.name]), '', { required: true, blank: 'Choose…' })))}
            </div>
            <button class="btn">Record on the books and match</button>
            <p class="small muted">Posts one entry dated ${fmtDate(t.date)} on both the accrual and cash books: ${t.amount_cents > 0 ? `${usd(t.amount_cents)} into ${acct.gl_account}, credited to the account chosen` : `${usd(-t.amount_cents)} out of ${acct.gl_account}, charged to the account chosen`}. Use this for bank fees, interest and anything else the books have never seen. A rent payment or a vendor payment belongs in Receivables or Payables instead, then matched above.</p>
          </form>`)}
        ${card('It is not a real line — set it aside', html`
          <form method="post" action="/banking/txn/${t.id}/exclude" class="toolbar">
            ${field('Why', input('reason', { required: true, placeholder: 'entered twice, wrong account…' }))}
            <button class="btn btn-ghost">Set aside</button>
          </form>
          <p class="small muted">For a line entered twice or imported from the wrong account. A line that really is on the statement cannot be set aside: the statement's ending balance includes it, so the month would not tie.</p>`)}`,
    });
  });

  r.post('/banking/txn/:id/match', requirePerm('banking:reconcile'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const t = q1<any>('SELECT * FROM bank_txns WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!t) return notFound();
    const ids = ([] as string[]).concat((rq.body?.entry_ids as string[] | string) || []);
    try {
      matchEntries(ctx, t.id, ids, null);
      return redirect(lineBack(t), 'Statement line matched.');
    } catch (e) {
      return redirect(`/banking/txn/${t.id}`, (e as Error).message, 'err');
    }
  });
  r.post('/banking/txn/:id/adjust', requirePerm('banking:reconcile'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const t = q1<any>('SELECT * FROM bank_txns WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!t) return notFound();
    const rec = String(rq.body?.recon || '') || null;
    const propertyId = String(rq.body?.property_id || '') || null;
    try {
      if (propertyId && !canAccessProperty(ctx, propertyId)) throw new Error('Choose a property in your portfolio.');
      postAdjustment(ctx, t.id, rec && q1('SELECT id FROM bank_recons WHERE id=? AND org_id=?', rec, ctx.orgId) ? rec : null, {
        account: String(rq.body?.account || '') || null, memo: String(rq.body?.memo || '') || null, propertyId,
      });
      return redirect(lineBack(t), 'Adjustment JE posted and matched');
    } catch (e) {
      return redirect(rq.body?.account !== undefined ? `/banking/txn/${t.id}` : lineBack(t), (e as Error).message, 'err');
    }
  });
  r.post('/banking/txn/:id/exclude', requirePerm('banking:reconcile'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const t = q1<any>('SELECT * FROM bank_txns WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!t) return notFound();
    try {
      excludeTxn(ctx, t.id, null, String(rq.body?.reason || '').trim().slice(0, 200) || 'set aside in reconciliation');
      return redirect(lineBack(t), 'Statement line set aside.');
    } catch (e) {
      return redirect(lineBack(t), (e as Error).message, 'err');
    }
  });
  r.post('/banking/txn/:id/unmatch', requirePerm('banking:reconcile'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const t = q1<any>('SELECT * FROM bank_txns WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!t) return notFound();
    try {
      unmatchTxn(ctx, t.id);
      return redirect(lineBack(t), t.status === 'excluded' ? 'Statement line brought back.' : 'Match undone.');
    } catch (e) {
      return redirect(lineBack(t), (e as Error).message, 'err');
    }
  });
  r.post('/banking/:id/entries/:eid/opening', requirePerm('banking:reconcile'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const acct = q1<any>('SELECT * FROM bank_accounts WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!acct) return notFound();
    const month = String(rq.body?.month || '');
    const back = `/banking/${acct.id}/reconcile${/^\d{4}-\d{2}$/.test(month) ? `?month=${month}` : ''}`;
    try {
      markInOpeningBalance(ctx, acct.id, rq.params.eid!);
      return redirect(back, 'Entry treated as part of the opening bank balance.');
    } catch (e) {
      return redirect(back, (e as Error).message, 'err');
    }
  });

  r.get('/banking/:id/reconcile/:rid/report', requirePerm('banking:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const s = reconSummary(ctx, rq.params.rid!);
    if (!s.rec) return notFound();
    const done = s.rec.status === 'completed';
    return shell(rq, {
      title: `Reconciliation report — ${fmtMonth(s.rec.period_key)}`,
      active: '/banking',
      subtitle: html`${s.acct.name} · ${statusBadge(s.rec.status)}${s.rec.completed_by ? html` · completed by ${s.rec.completed_by}` : ''}`,
      content: html`
        ${card('Summary', dl([
          ['Statement opening balance', usd(s.rec.statement_open_cents)],
          ['Statement closing balance', usd(s.statementClose)],
          ['Plus deposits not on a statement yet', usd(s.inTransit.reduce((x, o) => x + o.amount, 0))],
          ['Less payments not cleared yet', usd(s.outstanding.reduce((x, o) => x + o.amount, 0))],
          [`Book balance (GL ${s.acct.gl_account}) at ${fmtDate(s.end)}`, usd(s.bookClose)],
          ['Entries recorded from statement lines', usd(s.adjusted)],
          ['Unmatched statement lines', String(s.unmatchedCount)],
          ['Unexplained difference', html`<b>${usd(s.tieDifference)}</b>`],
        ]))}
        ${when(done && s.tieDifference !== 0, () => html`<p class="small muted">This month was completed at a zero difference. Entries dated in ${fmtMonth(s.rec.period_key)} have been posted or changed since, which is why a difference shows now.</p>`)}
        ${when(s.outstanding.length, () => card('Payments not cleared at the end of the period', tbl(
          [{ label: 'Item' }, { label: 'Date' }, { label: 'Amount', num: true }],
          s.outstanding.map((o) => ({ cells: [o.desc, fmtDate(o.date), usd(o.amount)] })),
        ), { flush: true }))}
        ${when(s.inTransit.length, () => card('Deposits not on a statement at the end of the period', tbl(
          [{ label: 'Item' }, { label: 'Date' }, { label: 'Amount', num: true }],
          s.inTransit.map((o) => ({ cells: [o.desc, fmtDate(o.date), usd(o.amount)] })),
        ), { flush: true }))}`,
    });
  });

  // ============================== PERIODS / CLOSE ==============================
  r.get('/periods', requirePerm('gl:close_period'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const props = propsFor(ctx);
    if (!props.length) return noProperties(rq, 'Month-end close', '/periods');
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
    const canApprove = can(ctx, 'gl:close_period');
    const others = pending.length && canApprove ? otherJeApprovers(ctx) : [];
    const threshold = getSetting<number>(ctx, 'je_approval_threshold_cents', ctx.currentPropertyId);
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
      subtitle: `Entries of ${usd(threshold)} or more wait for a second person to approve before they post`,
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
        ${when(pending.length, () => card('Awaiting approval', html`${tbl(
          [{ label: 'Date' }, { label: 'Property' }, { label: 'Memo' }, { label: 'Requested by' }, { label: 'Amount', num: true }, { label: '' }],
          pending.map((p) => {
            const total = j<any[]>(p.lines, []).reduce((s2, l) => s2 + (l.debit || 0), 0);
            const own = pendingJeIsOwn(ctx, p);
            const reject = html`<form method="post" action="/gl/pending/${p.id}/decide" style="display:inline"><button class="btn btn-ghost btn-sm">${own ? 'Withdraw' : 'Reject'}</button></form>`;
            return {
              cells: [
                fmtDate(p.date), q1<any>('SELECT name FROM properties WHERE id=?', p.property_id)?.name || '—', p.memo, p.requested_by, usd(total),
                !canApprove ? html`<span class="muted small">waiting for an approver</span>`
                  : own && others.length
                    ? html`<span class="muted small">needs ${others.slice(0, 2).join(' or ')}${others.length > 2 ? ' or another approver' : ''}</span> ${reject}`
                    : html`
                  <form method="post" action="/gl/pending/${p.id}/decide" style="display:inline"><input type="hidden" name="approve" value="1"><button class="btn btn-sm">${own ? 'Confirm & post' : html`Approve &amp; post`}</button></form>
                  ${reject}`,
              ],
            };
          }),
        )}
        ${when(canApprove && !others.length && pending.some((p) => pendingJeIsOwn(ctx, p)), () => html`<p class="small muted" style="padding:0 14px 10px">Nobody else in this organization can approve journal entries, so you confirm your own. That is recorded on the entry as approved without a second person.</p>`)}`, { flush: true }))}
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
      return redirect('/gl/new', res.status === 'posted'
        ? (String(b.basis || 'both') === 'both' ? 'Journal entry posted to both books' : `Journal entry posted to the ${String(b.basis)} books`)
        : 'This entry is at or above the approval amount, so it has not posted yet. It is waiting under Awaiting approval.');
    } catch (e) {
      return redirect('/gl/new', (e as Error).message, 'err');
    }
  });

  // gl:post, not gl:close_period: the person who entered an entry may always
  // withdraw it; approving is checked inside (it needs gl:close_period and,
  // when anyone else can approve, a different person)
  r.post('/gl/pending/:id/decide', requirePerm('gl:post'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const approve = rq.body?.approve === '1';
    try {
      const p = q1<any>('SELECT * FROM pending_jes WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
      if (!p) return notFound();
      if (!can(ctx, 'gl:close_period') && !(pendingJeIsOwn(ctx, p) && !approve)) {
        throw new Error('Approving journal entries needs the period-close permission.');
      }
      const jeId = decidePendingJe(ctx, p.id, approve, String(rq.body?.reason || 'rejected'));
      return redirect(String(rq.body?.back) === 'approvals' ? '/approvals' : '/gl/new', jeId ? 'Approved and posted' : 'Rejected');
    } catch (e) {
      return redirect(String(rq.body?.back) === 'approvals' ? '/approvals' : '/gl/new', (e as Error).message, 'err');
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
        ${body}
        ${card('Saved statement packets', html`
          ${tbl(
            [{ label: 'Packet' }, { label: 'Scope' }, { label: 'Basis' }, { label: 'Visibility' }],
            listPackets(ctx).map((pk) => ({
              href: `/statements/packets/${pk.id}`,
              cells: [pk.name, pk.property_id ? (pk.property_name || 'Property') : 'Consolidated — all properties', pk.basis, pk.shared ? 'shared' : 'private'],
            })),
            { empty: 'No packets yet — save the current settings once and the monthly stakeholder pull becomes one click.' },
          )}
          <form method="post" action="/statements/packets/new" class="toolbar">
            <input type="hidden" name="property" value="${propId}">
            <input type="hidden" name="basis" value="${basis}">
            ${field('Save current scope + basis as a packet', input('name', { placeholder: 'e.g. Monthly board packet' }))}
            <label class="small"><input type="checkbox" name="shared" value="1" checked> Shared with the team</label>
            <button class="btn">Save packet</button>
          </form>`)}`,
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

  // ============================== STATEMENT PACKETS (M9.11) ==============================
  r.post('/statements/packets/new', requirePerm('gl:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const pid = createPacket(ctx, {
      name: String(rq.body.name || ''),
      propertyId: String(rq.body.property || '') || null,
      basis: (String(rq.body.basis) === 'cash' ? 'cash' : 'accrual') as Basis,
      shared: rq.body.shared === '1',
    });
    return redirect(`/statements/packets/${pid}`, 'Packet saved — this pull is now one click.');
  });

  r.post('/statements/packets/:id/delete', requirePerm('gl:view'), (rq) => {
    deletePacket(rq.ctx as Ctx, rq.params.id!);
    return redirect('/statements', 'Packet deleted.');
  });

  r.get('/statements/packets/:id', requirePerm('gl:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const packet = getPacket(ctx, rq.params.id!);
    if (!packet) return notFound('Packet not found');
    const to = rq.query.get('to') || ctx.businessDate;
    const d = packetData(ctx, packet, to);
    const lineTbl = (title: string, lines: { code: string; name: string; amount: number }[], totalLabel: string, total: number): Child => card(title, tbl(
      [{ label: 'Account' }, { label: 'Amount', num: true }],
      lines.map((l) => ({ cells: [html`<span class="mono">${l.code}</span> ${l.name}`, usd(l.amount)] })),
      { foot: [html`<b>${totalLabel}</b>`, html`<b>${usd(total)}</b>`] },
    ), { flush: true });
    const isOwner = !packet.created_by || packet.created_by === ctx.userId || can(ctx, 'admin:settings');
    return shell(rq, {
      title: packet.name,
      active: '/statements',
      subtitle: html`${packetScopeName(packet)} · ${d.basis} basis · trailing 12 months to ${fmtDate(to)}`,
      actions: html`
        <a class="btn btn-ghost" href="/statements/packets/${packet.id}/export.csv?to=${to}">Download CSV</a>
        <a class="btn btn-ghost" href="/statements/packets/${packet.id}/export.pdf?to=${to}">Download PDF</a>
        ${when(isOwner, () => html`<form method="post" action="/statements/packets/${packet.id}/delete" style="display:inline"><button class="btn btn-ghost">Delete</button></form>`)}`,
      content: html`
        ${kpis([
          { label: 'Income (T12)', value: usd(d.is.totalIncome) },
          { label: 'NOI (T12)', value: usd(d.is.noi), tone: d.is.noi >= 0 ? 'ok' : 'bad' },
          { label: 'Total assets', value: usd(d.bs.totals.assets) },
          { label: 'Closing cash', value: usd(d.cf.closing) },
        ])}
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Trailing 12 months to', input('to', { type: 'date', value: to }))}
        </form>
        <div class="cols">
          ${lineTbl('Income — trailing 12 months', d.is.income, 'Total income', d.is.totalIncome)}
          ${lineTbl('Expenses — trailing 12 months', d.is.expenses, 'Total expenses', d.is.totalExpenses)}
        </div>
        <div class="cols">
          ${lineTbl('Assets', d.bs.assets, 'Total assets', d.bs.totals.assets)}
          <div>
            ${lineTbl('Liabilities', d.bs.liabilities, 'Total liabilities', d.bs.totals.liabilities)}
            ${lineTbl('Equity', d.bs.equity, 'Total equity', d.bs.totals.equity)}
          </div>
        </div>
        ${lineTbl('Cash flow — operating', d.cf.operating, 'Net operating cash', d.cf.operating.reduce((s, l) => s + l.amount, 0))}
        ${when(d.cf.investing.length, () => lineTbl('Cash flow — investing', d.cf.investing, 'Net investing cash', d.cf.investing.reduce((s, l) => s + l.amount, 0)))}
        ${when(d.cf.financing.length, () => lineTbl('Cash flow — financing', d.cf.financing, 'Net financing cash', d.cf.financing.reduce((s, l) => s + l.amount, 0)))}
        <p class="small muted">One saved pull — income statement, balance sheet, and cash flow, same scope and basis every month. The CSV export includes the month-by-month T-12 grid.</p>`,
    });
  });

  r.get('/statements/packets/:id/export.csv', requirePerm('gl:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const packet = getPacket(ctx, rq.params.id!);
    if (!packet) return notFound('Packet not found');
    const to = rq.query.get('to') || ctx.businessDate;
    return {
      status: 200,
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="packet-${to}.csv"` },
      body: packetCsv(ctx, packet, to),
    };
  });

  r.get('/statements/packets/:id/export.pdf', requirePerm('gl:view'), async (rq) => {
    const ctx = rq.ctx as Ctx;
    const packet = getPacket(ctx, rq.params.id!);
    if (!packet) return notFound('Packet not found');
    const to = rq.query.get('to') || ctx.businessDate;
    return {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="packet-${to}.pdf"` },
      body: await packetPdf(ctx, packet, to),
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
