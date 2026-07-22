import { html, when } from '../../lib/html.ts';
import { notFound, type Router } from '../../lib/http.ts';
import { requirePerm, propFilter, type Ctx } from '../../lib/auth.ts';
import { q, q1, val } from '../../lib/db.ts';
import { fmtDate, monthKey } from '../../lib/dates.ts';
import { usd } from '../../lib/money.ts';
import { shell, card, tbl, dl, statusBadge, field, select, registerNav, pager, tabs } from '../../ui/ui.ts';
import { trialBalance, runInvariants } from './service.ts';

registerNav('Money', { href: '/gl', label: 'Accounting', perm: 'gl:view', match: ['/gl'] });

export function routes(r: Router): void {
  r.get('/gl', requirePerm('gl:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const basis = (rq.query.get('basis') || 'accrual') as 'accrual' | 'cash';
    const propId = rq.query.get('property') || ctx.currentPropertyId || null;
    const props = q<any>(`SELECT id, name FROM properties WHERE org_id=?${propFilter(ctx, 'id').sql} ORDER BY name`, ctx.orgId, ...propFilter(ctx, 'id').params);
    const rows = trialBalance(ctx, { propertyId: propId, basis, asOf: ctx.businessDate });
    const totals = rows.reduce((s, x) => ({ d: s.d + x.debit, c: s.c + x.credit }), { d: 0, c: 0 });
    return shell(rq, {
      title: 'General ledger',
      active: '/gl',
      subtitle: `Trial balance · ${basis} basis · as of ${fmtDate(ctx.businessDate)}`,
      actions: html`<a class="btn btn-ghost" href="/gl/journal">Journal entries</a> <a class="btn btn-ghost" href="/gl/invariants">Integrity checks</a>`,
      content: html`
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Basis', select('basis', [['accrual', 'Accrual'], ['cash', 'Cash']], basis))}
          ${field('Property', select('property', props.map((p): [string, string] => [p.id, p.name]), propId || '', { blank: 'All properties' }))}
        </form>
        ${card(null, tbl(
          [{ label: 'Account' }, { label: 'Type' }, { label: 'Debit', num: true }, { label: 'Credit', num: true }],
          rows.map((a) => ({
            href: `/gl/journal?account=${a.code}${propId ? `&property=${propId}` : ''}&basis=${basis}`,
            cells: [
              html`<span class="mono">${a.code}</span> ${a.name}`,
              statusBadge(undefined, a.type),
              a.debit ? usd(a.debit) : '',
              a.credit ? usd(a.credit) : '',
            ],
          })),
          { empty: 'No postings yet.', foot: [html`<b>Totals ${totals.d === totals.c ? '✓ balanced' : '✗ OUT OF BALANCE'}</b>`, '', usd(totals.d), usd(totals.c)] },
        ), { flush: true })}`,
    });
  });

  r.get('/gl/journal', requirePerm('gl:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const basis = rq.query.get('basis') || 'accrual';
    const account = rq.query.get('account') || '';
    const source = rq.query.get('source') || '';
    const period = rq.query.get('period') || '';
    const propId = rq.query.get('property') || ctx.currentPropertyId || '';
    const params: unknown[] = [ctx.orgId, basis];
    let where = 'je.org_id=? AND je.basis=?';
    if (propId) { where += ' AND je.property_id=?'; params.push(propId); }
    if (source) { where += ' AND je.source_kind=?'; params.push(source); }
    if (period) { where += ' AND je.period_key=?'; params.push(period); }
    if (account) { where += ' AND EXISTS (SELECT 1 FROM journal_lines jx WHERE jx.entry_id=je.id AND jx.account_code=?)'; params.push(account); }
    const total = val<number>(`SELECT COUNT(*) FROM journal_entries je WHERE ${where}`, ...params);
    const page = Math.max(1, parseInt(rq.query.get('page') || '1', 10) || 1);
    const rows = q<any>(
      `SELECT je.*, (SELECT SUM(debit_cents) FROM journal_lines jl WHERE jl.entry_id=je.id) AS amount,
        (SELECT name FROM properties p WHERE p.id=je.property_id) AS prop_name
       FROM journal_entries je WHERE ${where} ORDER BY je.date DESC, je.posted_at DESC LIMIT 50 OFFSET ?`,
      ...params, (page - 1) * 50,
    );
    const sources = q<any>(`SELECT DISTINCT source_kind FROM journal_entries WHERE org_id=? ORDER BY source_kind`, ctx.orgId);
    const periods = q<any>(`SELECT DISTINCT period_key FROM journal_entries WHERE org_id=? ORDER BY period_key DESC LIMIT 24`, ctx.orgId);
    return shell(rq, {
      title: 'Journal entries',
      active: '/gl',
      crumbs: [['General ledger', '/gl']],
      subtitle: `${total} entries · ${basis} basis${account ? ` · account ${account}` : ''}`,
      content: html`
        <form method="get" class="toolbar" data-autosubmit>
          <input type="hidden" name="account" value="${account}" />
          ${field('Basis', select('basis', [['accrual', 'Accrual'], ['cash', 'Cash']], basis))}
          ${field('Source', select('source', sources.map((s): [string, string] => [s.source_kind, s.source_kind]), source, { blank: 'All sources' }))}
          ${field('Period', select('period', periods.map((p): [string, string] => [p.period_key, p.period_key]), period, { blank: 'All periods' }))}
        </form>
        ${card(null, html`${tbl(
          [{ label: 'Date' }, { label: 'Memo' }, { label: 'Source' }, { label: 'Property' }, { label: 'Amount', num: true }],
          rows.map((je) => ({
            href: `/gl/journal/${je.id}`,
            cells: [
              html`<span class="nowrap">${fmtDate(je.date)}</span>`,
              html`<span class="small">${je.memo || je.id}</span>`,
              statusBadge(undefined, je.source_kind),
              html`<span class="small">${je.prop_name}</span>`,
              usd(je.amount || 0),
            ],
          })),
          { empty: 'No journal entries match.' },
        )}${pager(rq, total)}`, { flush: true })}`,
    });
  });

  r.get('/gl/journal/:id', requirePerm('gl:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const je = q1<any>('SELECT * FROM journal_entries WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!je) return notFound('Journal entry not found');
    const lines = q<any>(
      `SELECT jl.*, a.name AS acct_name FROM journal_lines jl LEFT JOIN gl_accounts a ON a.org_id=jl.org_id AND a.code=jl.account_code WHERE jl.entry_id=? ORDER BY jl.debit_cents DESC`,
      je.id,
    );
    return shell(rq, {
      title: `Journal entry`,
      active: '/gl',
      crumbs: [['General ledger', '/gl'], ['Journal', '/gl/journal']],
      content: html`
        ${card('Entry', dl([
          ['Date', fmtDate(je.date)], ['Period', je.period_key], ['Basis', statusBadge(undefined, je.basis)],
          ['Source', `${je.source_kind}${je.source_id ? ` · ${je.source_id}` : ''}`],
          ['Memo', je.memo || '—'], ['Posted', je.posted_at.slice(0, 19).replace('T', ' ')], ['By', je.created_by],
        ]))}
        ${card('Lines', tbl(
          [{ label: 'Account' }, { label: 'Memo' }, { label: 'Debit', num: true }, { label: 'Credit', num: true }],
          lines.map((l) => ({
            cells: [
              html`<span class="mono">${l.account_code}</span> ${l.acct_name || ''}`,
              html`<span class="small muted">${l.memo || ''}</span>`,
              l.debit_cents ? usd(l.debit_cents) : '',
              l.credit_cents ? usd(l.credit_cents) : '',
            ],
          })),
          { foot: ['', '', usd(lines.reduce((s, x) => s + x.debit_cents, 0)), usd(lines.reduce((s, x) => s + x.credit_cents, 0))] },
        ), { flush: true })}`,
    });
  });

  r.get('/gl/invariants', requirePerm('gl:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const results = runInvariants(ctx);
    const allOk = results.every((x) => x.ok);
    return shell(rq, {
      title: 'Financial integrity checks',
      active: '/gl',
      crumbs: [['General ledger', '/gl']],
      subtitle: 'The §9 invariant suite, run live against this database. The same checks run in CI.',
      content: card(
        html`${results.length} invariants ${allOk ? html`<span class="badge ok">all passing</span>` : html`<span class="badge bad">FAILURES</span>`}`,
        tbl(
          [{ label: '' }, { label: 'Invariant' }, { label: 'Detail' }],
          results.map((x) => ({
            cells: [
              x.ok ? html`<span style="color:var(--ok);font-weight:700">✓</span>` : html`<span style="color:var(--bad);font-weight:700">✗</span>`,
              html`<b>${x.name}</b>`,
              html`<span class="small mono">${x.detail}</span>`,
            ],
          })),
        ),
        { flush: true },
      ),
    });
  });
}
