import { html, when, type Child } from '../../lib/html.ts';
import { notFound, redirect, type Router } from '../../lib/http.ts';
import { requirePerm, can, type Ctx } from '../../lib/auth.ts';
import { q, q1 } from '../../lib/db.ts';
import { fmtDate, fmtMonth } from '../../lib/dates.ts';
import { usd, parseUsd } from '../../lib/money.ts';
import { shell, card, tbl, statusBadge, field, select, input, registerNav, kpis } from '../../ui/ui.ts';
import { toCsv, type Basis } from './statements.ts';
import { Pdf } from '../../lib/pdf.ts';
import {
  reserveOverview, upsertReservePlan, requestReserveDraw, decideReserveDraw, fundDueReserves,
} from './reserves.ts';
import { createOwner, setOwnershipShare, ownersOverview, ownerStatement } from './owners.ts';

/** M9.9/M9.10 pages — replacement reserves and owner statements. */

registerNav('Money', { href: '/reserves', label: 'Reserves', perm: 'reserves:view', match: ['/reserves'] });
registerNav('Money', { href: '/owners', label: 'Owners', perm: 'owners:view', match: ['/owners'] });

const pctFmt = (n: number): string => `${Math.round(n * 100) / 100}%`;

export function routes(r: Router): void {
  // ============================== RESERVES ==============================
  r.get('/reserves', requirePerm('reserves:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const props = q<any>('SELECT * FROM properties WHERE org_id=? ORDER BY name', ctx.orgId);
    const rows = reserveOverview(ctx, props);
    const draws = q<any>(
      `SELECT rd.*, p.name AS property_name FROM reserve_draws rd
       JOIN properties p ON p.id=rd.property_id
       WHERE rd.org_id=? ORDER BY rd.created_at DESC LIMIT 25`, ctx.orgId,
    );
    const pending = draws.filter((d) => d.status === 'pending_approval');
    const totalBal = rows.reduce((s, x) => s + x.balance, 0);
    const monthly = rows.reduce((s, x) => s + (x.plan?.active ? x.plan.monthly_cents : 0), 0);
    const activity = q<any>(
      `SELECT je.date, je.memo, p.name AS property_name,
              SUM(CASE WHEN jl.account_code='1030' THEN jl.debit_cents - jl.credit_cents ELSE 0 END) AS net
       FROM journal_entries je
       JOIN journal_lines jl ON jl.entry_id=je.id
       JOIN properties p ON p.id=je.property_id
       WHERE je.org_id=? AND je.basis='accrual' AND je.source_kind IN ('reserve_funding','reserve_draw')
       GROUP BY je.id ORDER BY je.date DESC, je.posted_at DESC LIMIT 12`, ctx.orgId,
    );
    return shell(rq, {
      title: 'Replacement reserves',
      active: '/reserves',
      subtitle: 'Designated reserve cash (GL 1030) — funded monthly by plan, released by approved draw',
      content: html`
        ${kpis([
          { label: 'Total reserves', value: usd(totalBal) },
          { label: 'Monthly funding', value: usd(monthly) },
          { label: 'Funded properties', value: String(rows.filter((x) => x.plan?.active).length) },
          { label: 'Draws awaiting approval', value: String(pending.length), tone: pending.length ? 'warn' : 'ok' },
        ])}
        ${card('Reserves by property', tbl(
          [{ label: 'Property' }, { label: 'Monthly funding', num: true }, { label: 'Target', num: true }, { label: 'Balance', num: true }, { label: 'Last funded' }, { label: 'Pending draws' }],
          rows.map((x) => ({
            cells: [
              x.property.name,
              x.plan?.active ? usd(x.plan.monthly_cents) : html`<span class="muted">no plan</span>`,
              x.plan?.target_cents != null ? usd(x.plan.target_cents) : '—',
              usd(x.balance),
              x.lastFunded ? fmtMonth(x.lastFunded) : '—',
              x.pendingDraws ? html`<span class="badge badge-warn">${x.pendingDraws}</span>` : '—',
            ],
          })),
          { empty: 'No properties yet.' },
        ), { flush: true })}
        ${when(can(ctx, 'reserves:manage'), () => html`
          <div class="cols">
            ${card('Set a funding plan', html`
              <form method="post" action="/reserves/plan">
                ${field('Property', select('property', props.map((p): [string, string] => [p.id, p.name]), '', { required: true, blank: 'Choose…' }))}
                ${field('Monthly funding', input('monthly', { placeholder: 'e.g. 1,250.00', required: true }))}
                ${field('Target balance (optional)', input('target', { placeholder: 'stop funding at this balance' }), 'Leave blank for no cap')}
                <button class="btn">Save plan</button>
              </form>`)}
            ${card('Request a draw', html`
              <form method="post" action="/reserves/draw">
                ${field('Property', select('property', props.map((p): [string, string] => [p.id, p.name]), '', { required: true, blank: 'Choose…' }))}
                ${field('Amount', input('amount', { placeholder: 'e.g. 4,800.00', required: true }))}
                ${field('Purpose', input('purpose', { placeholder: 'what the reserve is paying for', required: true }))}
                <button class="btn">Submit for approval</button>
              </form>`)}
          </div>`)}
        ${card('Draws', tbl(
          [{ label: 'Requested' }, { label: 'Property' }, { label: 'Purpose' }, { label: 'Amount', num: true }, { label: 'Status' }, { label: '' }],
          draws.map((d) => ({
            cells: [
              fmtDate(d.created_at.slice(0, 10)),
              d.property_name,
              d.purpose,
              usd(d.amount_cents),
              statusBadge(d.status),
              d.status === 'pending_approval' && can(ctx, 'reserves:approve')
                ? html`<form method="post" action="/reserves/draws/${d.id}/decide" style="display:inline">
                    <button class="btn btn-sm" name="approve" value="1">Approve</button>
                    <button class="btn btn-sm btn-ghost" name="approve" value="0">Deny</button>
                  </form>`
                : '',
            ],
          })),
          { empty: 'No draws requested yet.' },
        ), { flush: true })}
        ${card('Recent reserve activity', tbl(
          [{ label: 'Date' }, { label: 'Property' }, { label: 'Entry' }, { label: 'Reserve effect', num: true }],
          activity.map((a) => ({ cells: [fmtDate(a.date), a.property_name, a.memo, usd(a.net)] })),
          { empty: 'No reserve activity yet — set a funding plan above.' },
        ), { flush: true })}`,
    });
  });

  r.post('/reserves/plan', requirePerm('reserves:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const monthly = parseUsd(String(rq.body.monthly || ''));
    const targetRaw = String(rq.body.target || '').trim();
    upsertReservePlan(ctx, {
      propertyId: String(rq.body.property || ''),
      monthlyCents: monthly,
      targetCents: targetRaw ? parseUsd(targetRaw) : null,
    });
    fundDueReserves(ctx, ctx.businessDate);
    return redirect('/reserves', 'Funding plan saved — current month funded.');
  });

  r.post('/reserves/draw', requirePerm('reserves:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    requestReserveDraw(ctx, {
      propertyId: String(rq.body.property || ''),
      amountCents: parseUsd(String(rq.body.amount || '')),
      purpose: String(rq.body.purpose || ''),
    });
    return redirect('/reserves', 'Draw submitted for approval.');
  });

  r.post('/reserves/draws/:id/decide', requirePerm('reserves:approve'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const approve = String(rq.body.approve) === '1';
    decideReserveDraw(ctx, rq.params.id!, approve);
    return redirect('/reserves', approve ? 'Draw approved — transfer posted to operating.' : 'Draw denied.');
  });

  // ============================== OWNERS ==============================
  r.get('/owners', requirePerm('owners:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const list = ownersOverview(ctx);
    const props = q<any>('SELECT * FROM properties WHERE org_id=? ORDER BY name', ctx.orgId);
    return shell(rq, {
      title: 'Owners',
      active: '/owners',
      subtitle: 'Ownership percentages per property drive per-owner equity-income statements',
      content: html`
        ${card('Owners', tbl(
          [{ label: 'Owner' }, { label: 'Type' }, { label: 'Holdings' }],
          list.map((x) => ({
            href: `/owners/${x.owner.id}`,
            cells: [
              x.owner.name,
              x.owner.kind === 'entity' ? 'Entity' : 'Individual',
              x.holdings.length
                ? x.holdings.map((h) => `${h.property_name} ${pctFmt(h.pct)}`).join(' · ')
                : html`<span class="muted">no holdings assigned</span>`,
            ],
          })),
          { empty: 'No owners yet — add one below.' },
        ), { flush: true })}
        ${when(can(ctx, 'owners:manage'), () => html`
          <div class="cols">
            ${card('Add an owner', html`
              <form method="post" action="/owners/new">
                ${field('Name', input('name', { placeholder: 'person or entity name', required: true }))}
                ${field('Type', select('kind', [['individual', 'Individual'], ['entity', 'Entity (LLC, LP, trust)']]))}
                ${field('Email (optional)', input('email', { placeholder: 'for sending statements' }))}
                <button class="btn">Add owner</button>
              </form>`)}
            ${card('Assign ownership', html`
              <form method="post" action="/owners/share">
                ${field('Owner', select('owner', list.map((x): [string, string] => [x.owner.id, x.owner.name]), '', { required: true, blank: 'Choose…' }))}
                ${field('Property', select('property', props.map((p): [string, string] => [p.id, p.name]), '', { required: true, blank: 'Choose…' }))}
                ${field('Ownership %', input('pct', { placeholder: 'e.g. 50', required: true }), 'Set 0 to remove. Total per property can never exceed 100%.')}
                <button class="btn">Save share</button>
              </form>`)}
          </div>`)}`,
    });
  });

  r.post('/owners/new', requirePerm('owners:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    createOwner(ctx, {
      name: String(rq.body.name || ''),
      kind: String(rq.body.kind) === 'entity' ? 'entity' : 'individual',
      email: String(rq.body.email || '') || undefined,
    });
    return redirect('/owners', 'Owner added.');
  });

  r.post('/owners/share', requirePerm('owners:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    setOwnershipShare(ctx, {
      ownerId: String(rq.body.owner || ''),
      propertyId: String(rq.body.property || ''),
      pct: Number(rq.body.pct || 0),
    });
    return redirect('/owners', 'Ownership updated.');
  });

  r.get('/owners/:id', requirePerm('owners:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const basis = (rq.query.get('basis') === 'cash' ? 'cash' : 'accrual') as Basis;
    const to = rq.query.get('to') || ctx.businessDate;
    let st;
    try {
      st = ownerStatement(ctx, rq.params.id!, { to, basis });
    } catch {
      return notFound('Owner not found');
    }
    const foot = [
      html`<b>Total — ${st.owner.name}</b>`, '',
      html`<b>${usd(st.totals.income)}</b>`, html`<b>${usd(st.totals.expenses)}</b>`,
      html`<b>${usd(st.totals.equityIncome)}</b>`, html`<b>${usd(st.totals.capitalShare)}</b>`, html`<b>${usd(st.totals.reserveShare)}</b>`,
    ];
    return shell(rq, {
      title: st.owner.name,
      active: '/owners',
      subtitle: html`Owner statement · trailing 12 months to ${fmtDate(to)} · ${basis} basis`,
      actions: html`
        <a class="btn btn-ghost" href="/owners/${st.owner.id}/statement.csv?to=${to}&basis=${basis}">Download CSV</a>
        <a class="btn btn-ghost" href="/owners/${st.owner.id}/statement.pdf?to=${to}&basis=${basis}">Download PDF</a>`,
      content: html`
        ${kpis([
          { label: 'Holdings', value: String(st.rows.length) },
          { label: 'Equity income (T12)', value: usd(st.totals.equityIncome), tone: st.totals.equityIncome >= 0 ? 'ok' : 'bad' },
          { label: 'Capital activity (share)', value: usd(st.totals.capitalShare) },
          { label: 'Reserve balances (share)', value: usd(st.totals.reserveShare) },
        ])}
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Basis', select('basis', [['accrual', 'Accrual'], ['cash', 'Cash']], basis))}
          ${field('Trailing 12 months to', input('to', { type: 'date', value: to }))}
        </form>
        ${card('Equity income by property', tbl(
          [{ label: 'Property' }, { label: 'Share' }, { label: 'Income', num: true }, { label: 'Expenses', num: true }, { label: 'Equity income', num: true }, { label: 'Capital activity', num: true }, { label: 'Reserves', num: true }],
          st.rows.map((x) => ({
            cells: [x.propertyName, pctFmt(x.pct), usd(x.income), usd(x.expenses), usd(x.equityIncome), usd(x.capitalShare), usd(x.reserveShare)],
          })),
          { empty: 'No holdings assigned to this owner yet.', foot },
        ), { flush: true })}
        <p class="small muted">Amounts are this owner's percentage share of each property's operating results for the period, their share of capital contributions/(distributions) posted to 3020, and their share of the designated reserve balance. The underlying books stay whole — shares are computed at read time.</p>`,
    });
  });

  r.get('/owners/:id/statement.csv', requirePerm('owners:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const basis = (rq.query.get('basis') === 'cash' ? 'cash' : 'accrual') as Basis;
    const to = rq.query.get('to') || ctx.businessDate;
    const st = ownerStatement(ctx, rq.params.id!, { to, basis });
    const rows: (string | number)[][] = [
      [`Owner statement — ${st.owner.name}`],
      ['Period', `${st.from} to ${st.to}`], ['Basis', st.basis], [],
      ['Property', 'Share %', 'Income', 'Expenses', 'Equity income', 'Capital activity', 'Reserve balance (share)'],
      ...st.rows.map((x): (string | number)[] => [x.propertyName, x.pct, x.income / 100, x.expenses / 100, x.equityIncome / 100, x.capitalShare / 100, x.reserveShare / 100]),
      ['Total', '', st.totals.income / 100, st.totals.expenses / 100, st.totals.equityIncome / 100, st.totals.capitalShare / 100, st.totals.reserveShare / 100],
    ];
    return {
      status: 200,
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="owner-statement-${to}.csv"` },
      body: toCsv(rows),
    };
  });

  r.get('/owners/:id/statement.pdf', requirePerm('owners:view'), async (rq) => {
    const ctx = rq.ctx as Ctx;
    const basis = (rq.query.get('basis') === 'cash' ? 'cash' : 'accrual') as Basis;
    const to = rq.query.get('to') || ctx.businessDate;
    const st = ownerStatement(ctx, rq.params.id!, { to, basis });
    const pdf = await Pdf.create(`Owner statement — ${st.owner.name}`);
    pdf.h1(`Owner statement — ${st.owner.name}`);
    pdf.kv([
      ['Period', `${st.from} to ${st.to} (trailing 12 months)`],
      ['Basis', st.basis],
      ['Prepared', ctx.businessDate],
    ]);
    pdf.space(6);
    pdf.table(
      [
        { label: 'Property', w: 0.26 }, { label: 'Share', w: 0.09, align: 'right' },
        { label: 'Income', w: 0.14, align: 'right' }, { label: 'Expenses', w: 0.14, align: 'right' },
        { label: 'Equity income', w: 0.14, align: 'right' }, { label: 'Capital', w: 0.115, align: 'right' },
        { label: 'Reserves', w: 0.115, align: 'right' },
      ],
      st.rows.map((x) => [x.propertyName, pctFmt(x.pct), usd(x.income), usd(x.expenses), usd(x.equityIncome), usd(x.capitalShare), usd(x.reserveShare)]),
      { totals: ['Total', '', usd(st.totals.income), usd(st.totals.expenses), usd(st.totals.equityIncome), usd(st.totals.capitalShare), usd(st.totals.reserveShare)] },
    );
    pdf.space(6);
    pdf.text('Equity income is the owner\'s percentage share of each property\'s operating result for the period. Capital activity is their share of contributions/(distributions) posted to account 3020.', { muted: true, size: 9 });
    return {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="owner-statement-${to}.pdf"` },
      body: await pdf.bytes(),
    };
  });
}
