import { html, raw, when, join } from '../../lib/html.ts';
import { redirect, notFound, badRequest, fileRes, type Router, type Rq } from '../../lib/http.ts';
import { requirePerm, propFilter, canAccessProperty, type Ctx } from '../../lib/auth.ts';
import { q, q1, val, run, insert } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, fmtDate, monthKey, addMonths, addDays, fmtMonth, diffDays } from '../../lib/dates.ts';
import { usd, splitCents } from '../../lib/money.ts';
import { v } from '../../lib/validate.ts';
import { audit } from '../../lib/audit.ts';
import { notify } from '../../lib/templates.ts';
import { toCsv } from '../../lib/csv.ts';
import {
  shell, card, tbl, kpis, dl, tabs, statusBadge, field, input, select, textarea, moneyInput,
  registerNav, pager, emptyState, checkbox,
} from '../../ui/ui.ts';
import { lines as lineChart, donut } from '../../lib/charts.ts';
import { agingRows, leaseBalance, leaseLedger, createCharge } from './service.ts';
import {
  recordPayment, PaymentRejected, lateFeeCandidates, assessLateFees, waiveLateFee, receivablesStats,
  createPaymentPlan, primaryContact, depositHeld, finalizeDeposit, openCollectionCase, reversePayment, writeOffBalance,
} from './payments.ts';
import { registerLeaseTab, registerLeaseAction } from '../people/pages.ts';
import { registerDashboardExtras } from '../m2_portfolio/pages.ts';

registerNav('Money', { href: '/receivables', label: 'Receivables', perm: 'ledger:view', match: ['/receivables'] });
registerNav('Money', { href: '/delinquency', label: 'Delinquency', perm: 'collections:manage', match: ['/delinquency'] });
registerNav('Money', { href: '/deposits', label: 'Deposits', perm: 'deposits:manage', match: ['/deposits'] });

// dashboard tiles
registerDashboardExtras((ctx, propertyId) => {
  const aging = agingRows(ctx, { propertyId });
  const total = aging.reduce((s, a) => s + a.balance, 0);
  const stats = receivablesStats(ctx, monthKey(ctx.businessDate), propertyId);
  return {
    kpis: [
      { label: 'Delinquent', value: usd(total), sub: `${aging.length} households`, tone: total > 0 ? 'bad' : 'ok', href: '/delinquency' },
      { label: 'Collection rate', value: `${stats.collectionRate}%`, sub: fmtMonth(monthKey(ctx.businessDate)), tone: stats.collectionRate >= 95 ? 'ok' : 'warn', href: '/receivables' },
      { label: 'Autopay', value: `${stats.autopayAdoption}%`, sub: 'of active leases', href: '/receivables' },
    ],
    panels: null,
  };
});

export function routes(r: Router): void {
  // ---------- receivables analytics ----------
  r.get('/receivables', requirePerm('ledger:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const propId = rq.query.get('property') || ctx.currentPropertyId || null;
    const mk = rq.query.get('month') || monthKey(ctx.businessDate);
    const stats = receivablesStats(ctx, mk, propId);
    const aging = agingRows(ctx, { propertyId: propId });
    const agingTotal = aging.reduce((s, a) => s + a.balance, 0);
    // 12-month trend
    const months: string[] = [];
    for (let i = 11; i >= 0; i--) months.push(monthKey(addMonths(ctx.businessDate, -i)));
    const trends = months.map((m) => receivablesStats(ctx, m, propId));
    const props = q<any>(`SELECT id, name FROM properties WHERE org_id=?${propFilter(ctx, 'id').sql} ORDER BY name`, ctx.orgId, ...propFilter(ctx, 'id').params);
    return shell(rq, {
      title: 'Receivables',
      active: '/receivables',
      subtitle: `Collections & payment analytics · ${fmtMonth(mk)}`,
      actions: html`<a class="btn btn-ghost" href="/receivables/latefees">Late fee run</a> <a class="btn btn-ghost" href="/receivables/lockbox">Lockbox import</a>`,
      content: html`
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Month', select('month', months.slice().reverse().map((m): [string, string] => [m, fmtMonth(m)]), mk))}
          ${field('Property', select('property', props.map((p): [string, string] => [p.id, p.name]), propId || '', { blank: 'All properties' }))}
        </form>
        ${kpis([
          { label: 'Billed', value: usd(stats.billed), sub: fmtMonth(mk) },
          { label: 'Collected', value: usd(stats.collected), tone: 'ok' },
          { label: 'Collection rate', value: `${stats.collectionRate}%`, tone: stats.collectionRate >= 95 ? 'ok' : 'warn' },
          { label: 'On-time rent', value: `${stats.onTimePct}%` },
          { label: 'NSF rate', value: `${stats.nsfRate}%`, sub: `${stats.nsfCount} returned`, tone: stats.nsfRate > 4 ? 'bad' : undefined },
          { label: 'Autopay adoption', value: `${stats.autopayAdoption}%` },
          { label: 'Open receivables', value: usd(agingTotal), tone: 'bad', href: '/delinquency' },
        ])}
        <div class="grid cols-2">
          ${card('Collection rate trend', lineChart(months.map((m) => m.slice(5)), [{ name: 'Collection %', points: trends.map((t) => t.collectionRate), tone: 'accent' }]))}
          ${card('Billed vs collected', lineChart(months.map((m) => m.slice(5)), [
            { name: 'Billed', points: trends.map((t) => t.billed), tone: 'muted' },
            { name: 'Collected', points: trends.map((t) => t.collected), tone: 'ok' },
          ], { money: true }))}
        </div>
        ${card('Aging summary', (() => {
          const sums = aging.reduce(
            (s, a) => ({ current: s.current + a.current, d1: s.d1 + a.d1_30, d31: s.d31 + a.d31_60, d61: s.d61 + a.d61_90, d90: s.d90 + a.d90p }),
            { current: 0, d1: 0, d31: 0, d61: 0, d90: 0 },
          );
          return donut([
            { label: 'Current', value: Math.round(sums.current / 100), tone: 'info' },
            { label: '1–30', value: Math.round(sums.d1 / 100), tone: 'warn' },
            { label: '31–60', value: Math.round(sums.d31 / 100), tone: 'warn' },
            { label: '61–90', value: Math.round(sums.d61 / 100), tone: 'bad' },
            { label: '90+', value: Math.round(sums.d90 / 100), tone: 'bad' },
          ], { centerValue: usd(agingTotal).replace('.00', ''), centerLabel: 'open (dollars)' });
        })())}`,
    });
  });

  // ---------- late fee preview & assessment ----------
  r.get('/receivables/latefees', requirePerm('ledger:charge'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const candidates = lateFeeCandidates(ctx, ctx.businessDate, ctx.currentPropertyId);
    const recentFees = q<any>(
      `SELECT c.*, l.household_name, u.unit_number FROM charges c
       JOIN leases l ON l.id=c.lease_id JOIN units u ON u.id=l.unit_id
       WHERE c.org_id=? AND c.kind='late_fee' AND c.status='active' ${ctx.currentPropertyId ? 'AND c.property_id=?' : ''}
       ORDER BY c.date DESC LIMIT 30`,
      ctx.orgId, ...(ctx.currentPropertyId ? [ctx.currentPropertyId] : []),
    );
    return shell(rq, {
      title: 'Late fees',
      active: '/receivables',
      crumbs: [['Receivables', '/receivables']],
      subtitle: `Preview for ${fmtDate(ctx.businessDate)} — the scheduler assesses these automatically each day; this screen previews and runs on demand.`,
      content: html`
        ${card(html`Due for assessment today <span class="badge ${candidates.length ? 'warn' : 'ok'}">${candidates.length}</span>`, html`
          ${tbl(
            [{ label: 'Household' }, { label: 'Unit' }, { label: 'Property' }, { label: 'Unpaid rent', num: true }, { label: 'Days late', num: true }, { label: 'Fee', num: true }, { label: 'Type' }],
            candidates.map((c) => ({
              href: `/leases/${c.leaseId}`,
              cells: [html`<b>${c.householdName}</b>`, c.unit, c.propertyName, usd(c.unpaidRent), c.daysLate, usd(c.fee), statusBadge(undefined, c.kind)],
            })),
            { empty: 'No late fees due today — everyone is inside grace or paid up.' },
          )}
          ${when(candidates.length, () => html`<div class="card-body"><form method="post" action="/receivables/latefees/assess" data-confirm="Assess ${candidates.length} late fees now?"><button class="btn">Assess ${candidates.length} fees now</button></form></div>`)}`, { flush: true })}
        ${card('Recently assessed', tbl(
          [{ label: 'Date' }, { label: 'Household' }, { label: 'Unit' }, { label: 'Fee' }, { label: 'Amount', num: true }, { label: '', w: '120px' }],
          recentFees.map((f) => ({
            cells: [
              fmtDate(f.date), html`<a href="/leases/${f.lease_id}">${f.household_name}</a>`, f.unit_number, f.label, usd(f.amount_cents),
              f.amount_cents > 0
                ? html`<form method="post" action="/receivables/latefees/${f.id}/waive"><input type="hidden" name="reason" value="goodwill" /><button class="btn btn-sm btn-ghost" ${!(rq.ctx as Ctx).perms.has('latefees:waive') ? 'disabled' : ''}>Waive</button></form>`
                : statusBadge(undefined, 'waiver'),
            ],
          })),
          { empty: 'No late fees assessed yet.' },
        ), { flush: true })}`,
    });
  });

  r.post('/receivables/latefees/assess', requirePerm('ledger:charge'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const summary = assessLateFees(ctx, ctx.businessDate, ctx.currentPropertyId);
    return redirect('/receivables/latefees', summary);
  });

  r.post('/receivables/latefees/:id/waive', requirePerm('latefees:waive'), (rq) => {
    const ctx = rq.ctx as Ctx;
    try {
      waiveLateFee(ctx, rq.params.id!, String(rq.body.reason || 'no reason given'));
    } catch (e) {
      return redirect('/receivables/latefees', (e as Error).message, 'err');
    }
    return redirect('/receivables/latefees', 'Fee waived (audited).');
  });

  // ---------- lockbox ----------
  r.get('/receivables/lockbox', requirePerm('payments:record'), (rq) => {
    const ctx = rq.ctx as Ctx;
    return shell(rq, {
      title: 'Lockbox import',
      active: '/receivables',
      crumbs: [['Receivables', '/receivables']],
      content: html`
        ${card('Import a lockbox batch (simulated)', html`
          <p class="small muted">Paste CSV rows: <code>unit_number,amount,check_number</code> — one payment per line. Payments are matched to the unit's current lease and post as pending checks.</p>
          <form method="post" action="/receivables/lockbox">
            ${field('CSV', textarea('csv', { rows: 6, placeholder: 'B-204,1525.00,4471\nC-311,800.00,1092' }))}
            <button class="btn">Import batch</button>
          </form>`)}`,
    });
  });

  r.post('/receivables/lockbox', requirePerm('payments:record'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const csv = String(rq.body.csv || '').trim();
    if (!csv) return redirect('/receivables/lockbox', 'Nothing to import.', 'err');
    let ok = 0;
    const errors: string[] = [];
    for (const line of csv.split('\n')) {
      const [unitNo, amountS, check] = line.split(',').map((s) => s?.trim());
      if (!unitNo || !amountS) continue;
      const pf = propFilter(ctx, 'u.property_id');
      const lease = q1<any>(
        `SELECT l.* FROM leases l JOIN units u ON u.id=l.unit_id
         WHERE l.org_id=? AND u.unit_number=? AND l.status IN ('active','month_to_month','notice')${pf.sql} LIMIT 1`,
        ctx.orgId, unitNo, ...pf.params,
      );
      if (!lease) { errors.push(`${unitNo}: no current lease`); continue; }
      try {
        recordPayment(ctx, {
          leaseId: lease.id, amountCents: v.cents({ min: 1 }).parse(amountS), method: 'lockbox',
          reference: check || undefined, receivedDate: ctx.businessDate, memo: 'lockbox batch',
        });
        ok++;
      } catch (e) {
        errors.push(`${unitNo}: ${(e as Error).message}`);
      }
    }
    return redirect('/receivables/lockbox', `${ok} payments imported.${errors.length ? ` Issues: ${errors.slice(0, 3).join('; ')}` : ''}`, errors.length ? 'err' : 'ok');
  });

  // ---------- delinquency workbench ----------
  r.get('/delinquency', requirePerm('collections:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const propId = rq.query.get('property') || ctx.currentPropertyId || null;
    const bucket = rq.query.get('bucket') || '';
    let aging = agingRows(ctx, { propertyId: propId });
    if (bucket === '1_30') aging = aging.filter((a) => a.d1_30 > 0);
    else if (bucket === '31_60') aging = aging.filter((a) => a.d31_60 > 0);
    else if (bucket === '61_90') aging = aging.filter((a) => a.d61_90 > 0);
    else if (bucket === '90p') aging = aging.filter((a) => a.d90p > 0);
    const total = aging.reduce((s, a) => s + a.balance, 0);
    const props = q<any>(`SELECT id, name FROM properties WHERE org_id=?${propFilter(ctx, 'id').sql} ORDER BY name`, ctx.orgId, ...propFilter(ctx, 'id').params);
    const cases = q<any>(
      `SELECT cc.*, l.household_name FROM collection_cases cc JOIN leases l ON l.id=cc.lease_id WHERE cc.org_id=? AND cc.status='open' ORDER BY cc.opened_date DESC LIMIT 15`,
      ctx.orgId,
    );
    return shell(rq, {
      title: 'Delinquency workbench',
      active: '/delinquency',
      subtitle: `${aging.length} delinquent households · ${usd(total)} open · as of ${fmtDate(ctx.businessDate)}`,
      actions: html`<a class="btn btn-ghost" href="/delinquency/export">Export CSV</a>`,
      content: html`
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Property', select('property', props.map((p): [string, string] => [p.id, p.name]), propId || '', { blank: 'All properties' }))}
          ${field('Bucket', select('bucket', [['1_30', '1–30 days'], ['31_60', '31–60'], ['61_90', '61–90'], ['90p', '90+']], bucket, { blank: 'All buckets' }))}
        </form>
        ${card(null, tbl(
          [{ label: 'Household' }, { label: 'Unit' }, { label: 'Property' }, { label: 'Current', num: true }, { label: '1–30', num: true }, { label: '31–60', num: true }, { label: '61–90', num: true }, { label: '90+', num: true }, { label: 'Total', num: true }],
          aging.map((a) => ({
            href: `/delinquency/${a.lease_id}`,
            cells: [
              html`<b>${a.household_name}</b>`, a.unit_number, a.property_name,
              a.current ? usd(a.current) : '', a.d1_30 ? usd(a.d1_30) : '', a.d31_60 ? usd(a.d31_60) : '',
              a.d61_90 ? html`<span class="neg">${usd(a.d61_90)}</span>` : '', a.d90p ? html`<span class="neg">${usd(a.d90p)}</span>` : '',
              html`<b>${usd(a.balance)}</b>`,
            ],
          })),
          {
            empty: 'No delinquent households — everyone is current. 🎉',
            foot: ['Totals', '', '',
              usd(aging.reduce((s, a) => s + a.current, 0)), usd(aging.reduce((s, a) => s + a.d1_30, 0)),
              usd(aging.reduce((s, a) => s + a.d31_60, 0)), usd(aging.reduce((s, a) => s + a.d61_90, 0)),
              usd(aging.reduce((s, a) => s + a.d90p, 0)), usd(total)],
          },
        ), { flush: true })}
        ${when(cases.length, () => card('Open collection cases', tbl(
          [{ label: 'Household' }, { label: 'Opened' }, { label: 'Balance', num: true }, { label: 'Status' }],
          cases.map((c) => ({ href: `/leases/${c.lease_id}`, cells: [c.household_name, fmtDate(c.opened_date), usd(c.balance_cents), statusBadge(c.status)] })),
        ), { flush: true }))}`,
    });
  });

  r.get('/delinquency/export', requirePerm('collections:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const aging = agingRows(ctx, { propertyId: ctx.currentPropertyId });
    const csv = toCsv(
      ['household', 'unit', 'property', 'current', '1_30', '31_60', '61_90', '90_plus', 'total', 'oldest_due'],
      aging.map((a) => [a.household_name, a.unit_number, a.property_name, a.current / 100, a.d1_30 / 100, a.d31_60 / 100, a.d61_90 / 100, a.d90p / 100, a.balance / 100, a.oldest_due]),
    );
    return fileRes(csv, 'text/csv', { filename: `delinquency-${ctx.businessDate}.csv` });
  });

  r.get('/delinquency/:leaseId', requirePerm('collections:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const l = q1<any>(
      `SELECT l.*, u.unit_number, p.name AS prop_name FROM leases l JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=l.property_id WHERE l.id=? AND l.org_id=?`,
      rq.params.leaseId!, ctx.orgId,
    );
    if (!l || !canAccessProperty(ctx, l.property_id)) return notFound('Lease not found');
    const balance = leaseBalance(ctx, l.id);
    const notes = q<any>(`SELECT * FROM delinquency_notes WHERE lease_id=? ORDER BY created_at DESC LIMIT 30`, l.id);
    const plans = q<any>(`SELECT * FROM payment_plans WHERE lease_id=? ORDER BY created_at DESC`, l.id);
    const ledger = leaseLedger(ctx, l.id).slice(-12);
    const contact = primaryContact(ctx, l.id);
    return shell(rq, {
      title: `${l.household_name} — delinquency`,
      active: '/delinquency',
      crumbs: [['Delinquency', '/delinquency']],
      subtitle: html`${l.unit_number} · ${l.prop_name} · balance <b class="neg">${usd(balance)}</b>`,
      actions: html`
        ${when(balance > 0, () => html`<form method="post" action="/ai/delinquency/${l.id}/draft" style="display:inline">
          <button class="btn btn-ghost" title="Payments AI drafts tone-graded outreach + a plan proposal within org bounds">✨ AI outreach</button>
        </form>`)}
        <a class="btn btn-ghost" href="/leases/${l.id}">Open lease</a>`,
      content: html`
        <div class="grid cols-2">
          ${card('Actions', html`
            <form method="post" action="/delinquency/${l.id}/note" style="margin-bottom:12px">
              ${field('Add note / promise to pay', textarea('body', { rows: 2, required: true, placeholder: 'Spoke with resident — promises $600 by Friday…' }))}
              <div class="toolbar">
                ${field('Kind', select('kind', [['note', 'Note'], ['promise_to_pay', 'Promise to pay'], ['contact', 'Contact attempt']]))}
                ${field('Promise date', input('promise_date', { type: 'date' }))}
                ${field('Amount', moneyInput('promise_amount'))}
                <button class="btn btn-sm">Save</button>
              </div>
            </form>
            <hr style="border:0;border-top:1px solid var(--line-2)" />
            <form method="post" action="/delinquency/${l.id}/dunning" class="toolbar" style="margin-top:10px">
              ${field('Send reminder', select('template', [['dunning_friendly', 'Day-1 friendly'], ['dunning_firm', 'Day-3 firm'], ['dunning_final', 'Final / attorney review']]))}
              <button class="btn btn-sm">Send</button>
            </form>
            <form method="post" action="/delinquency/${l.id}/collections" data-confirm="Open a collections case and freeze this account?" style="margin-top:10px">
              <button class="btn btn-sm btn-danger">Escalate to collections</button>
            </form>
            ${when(balance > 0 && (l.status === 'ended' || q1<any>(`SELECT id FROM collection_cases WHERE lease_id=? AND status='open'`, l.id)), () => html`
            <form method="post" action="/delinquency/${l.id}/writeoff" data-confirm="Write ${usd(balance)} off to bad debt? This posts to the GL and closes the collections case." class="toolbar" style="margin-top:10px">
              ${field('Write off to bad debt (reason required)', input('reason', { required: true, placeholder: 'e.g. skip — agency returned uncollectible' }))}
              <button class="btn btn-sm btn-danger">Write off ${usd(balance)}</button>
            </form>`)}`)}
          ${card('Set up a payment plan', html`
            <form method="post" action="/delinquency/${l.id}/plan">
              <div class="toolbar">
                ${field('Total', moneyInput('total', balance, { required: true }))}
                ${field('Installments', select('n', [['2', '2'], ['3', '3'], ['4', '4'], ['6', '6']], '3'))}
                ${field('First due', input('first_due', { type: 'date', value: addDays(ctx.businessDate, 7) }))}
                <button class="btn btn-sm">Create plan</button>
              </div>
              <p class="small muted">Equal installments every 2 weeks, auto-charged to the household's saved method when available. Plan default after 2 missed installments.</p>
            </form>
            ${when(plans.length, () => tbl(
              [{ label: 'Created' }, { label: 'Total', num: true }, { label: 'Status' }],
              plans.map((p) => ({ cells: [fmtDate(p.created_at.slice(0, 10)), usd(p.total_cents), statusBadge(p.status)] })),
            ))}`)}
        </div>
        <div class="grid cols-2">
          ${card('Notes & promises', notes.length ? html`<ul class="timeline">${notes.map((n) => html`<li class="${n.kind === 'promise_to_pay' ? 'hot' : ''}">
            <div><b>${n.kind.replaceAll('_', ' ')}</b> ${n.promise_amount_cents ? html`· ${usd(n.promise_amount_cents)} by ${fmtDate(n.promise_date)}` : ''}</div>
            <div class="small">${n.body}</div><div class="t-when">${n.created_at.slice(0, 16).replace('T', ' ')}</div>
          </li>`)}</ul>` : emptyState('No notes yet'))}
          ${card('Recent ledger', tbl(
            [{ label: 'Date' }, { label: 'Item' }, { label: 'Charge', num: true }, { label: 'Payment', num: true }, { label: 'Balance', num: true }],
            ledger.map((row) => ({
              cells: [fmtDate(row.date), html`<span class="small">${row.label}</span>`, row.charge_cents ? usd(row.charge_cents) : '', row.credit_cents ? usd(row.credit_cents) : '', usd(row.balance)],
            })),
          ), { flush: true })}
        </div>`,
    });
  });

  r.post('/delinquency/:leaseId/note', requirePerm('collections:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    insert('delinquency_notes', {
      id: id('dnn'), org_id: ctx.orgId, lease_id: rq.params.leaseId!, kind: String(rq.body.kind || 'note'),
      body: String(rq.body.body || ''), promise_date: rq.body.promise_date || null,
      promise_amount_cents: rq.body.promise_amount ? v.cents().parse(rq.body.promise_amount) : null,
      created_by: ctx.userId, created_at: nowIso(),
    });
    return redirect(`/delinquency/${rq.params.leaseId}`, 'Saved.');
  });

  r.post('/delinquency/:leaseId/dunning', requirePerm('comms:send'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const leaseId = rq.params.leaseId!;
    const l = q1<any>('SELECT * FROM leases WHERE id=? AND org_id=?', leaseId, ctx.orgId);
    if (!l) return notFound();
    const contact = primaryContact(ctx, leaseId);
    const balance = leaseBalance(ctx, leaseId);
    const aging = agingRows(ctx, {}).find((a) => a.lease_id === leaseId);
    const days = aging?.oldest_due ? Math.max(0, diffDays(ctx.businessDate, aging.oldest_due)) : 0;
    notify(ctx, String(rq.body.template || 'dunning_friendly'), {
      email: contact.email, phone: contact.phone, name: contact.name, userId: contact.userId,
      personId: contact.residentId, propertyId: l.property_id, entity: 'lease', entityId: leaseId,
    }, {
      first_name: contact.first, balance: usd(balance), days, unit: contact.unit, property: contact.propertyName,
    });
    return redirect(`/delinquency/${leaseId}`, 'Reminder sent (see Message console).');
  });

  r.post('/delinquency/:leaseId/plan', requirePerm('collections:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const total = v.cents({ min: 100 }).parse(rq.body.total);
    const n = parseInt(String(rq.body.n || '3'), 10);
    const firstDue = v.date().parse(rq.body.first_due || addDays(ctx.businessDate, 7));
    const amounts = splitCents(total, n);
    const installments = amounts.map((amt, i) => ({ dueDate: addDays(firstDue, i * 14), amountCents: amt }));
    try {
      createPaymentPlan(ctx, rq.params.leaseId!, total, installments);
    } catch (e) {
      return redirect(`/delinquency/${rq.params.leaseId}`, (e as Error).message, 'err');
    }
    return redirect(`/delinquency/${rq.params.leaseId}`, `Payment plan created (${n} installments).`);
  });

  r.post('/delinquency/:leaseId/collections', requirePerm('collections:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    openCollectionCase(ctx, rq.params.leaseId!, 'escalated from delinquency workbench');
    return redirect(`/delinquency/${rq.params.leaseId}`, 'Collection case opened.');
  });

  r.post('/delinquency/:leaseId/writeoff', requirePerm('collections:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    try {
      const cents = writeOffBalance(ctx, rq.params.leaseId!, String(rq.body.reason || ''));
      return redirect(`/delinquency/${rq.params.leaseId}`, `${usd(cents)} written off to bad debt (5610).`);
    } catch (e) {
      return redirect(`/delinquency/${rq.params.leaseId}`, (e as Error).message, 'err');
    }
  });

  // ---------- deposits ----------
  r.get('/deposits', requirePerm('deposits:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const pf = propFilter(ctx, 'l.property_id');
    const held = q<any>(
      `SELECT l.id, l.household_name, l.status, l.deposit_cents, l.deposit_alternative, l.move_out_date, u.unit_number, p.name AS prop_name
       FROM leases l JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=l.property_id
       WHERE l.org_id=? AND l.status IN ('active','month_to_month','notice','ended')${pf.sql}
       ORDER BY CASE WHEN l.status='ended' THEN 0 WHEN l.status='notice' THEN 1 ELSE 2 END, l.move_out_date`,
      ctx.orgId, ...pf.params,
    );
    const rows = held
      .map((l) => ({ ...l, held: depositHeld(ctx, l.id) }))
      .filter((l) => l.held > 0 || l.deposit_alternative || l.status === 'notice' || l.status === 'ended');
    const totalHeld = rows.reduce((s, l) => s + l.held, 0);
    const dispositionDays = 30;
    return shell(rq, {
      title: 'Deposit accountability',
      active: '/deposits',
      subtitle: `${usd(totalHeld)} held across ${rows.filter((x) => x.held > 0).length} households · dispositions due ${dispositionDays} days after move-out`,
      content: card(null, tbl(
        [{ label: 'Household' }, { label: 'Unit' }, { label: 'Property' }, { label: 'Status' }, { label: 'Held', num: true }, { label: 'Move-out' }, { label: 'Disposition' }],
        rows.slice(0, 200).map((l) => {
          const overdue = l.status === 'ended' && l.move_out_date && diffDays(ctx.businessDate, l.move_out_date) > dispositionDays && l.held > 0;
          return {
            href: `/leases/${l.id}?tab=deposit`,
            cells: [
              html`<b>${l.household_name}</b>`, l.unit_number, l.prop_name, statusBadge(l.status),
              l.deposit_alternative ? html`<span class="badge violet">alternative</span>` : usd(l.held),
              l.move_out_date ? fmtDate(l.move_out_date) : '—',
              l.status === 'ended' && l.held > 0
                ? (overdue ? html`<span class="badge bad">overdue</span>` : html`<span class="badge warn">due ${fmtDate(addDays(l.move_out_date, dispositionDays))}</span>`)
                : l.held > 0 ? statusBadge('active', 'held') : '—',
            ],
          };
        }),
        { empty: 'No deposits held.' },
      ), { flush: true }),
    });
  });

  // record payment / reverse / disposition actions under leases
  r.post('/leases/:id/payments', requirePerm('payments:record'), (rq) => {
    const ctx = rq.ctx as Ctx;
    try {
      recordPayment(ctx, {
        leaseId: rq.params.id!,
        amountCents: v.cents({ min: 1 }).parse(rq.body.amount),
        method: v.oneOf('ach', 'card', 'check', 'money_order', 'cash_equivalent').parse(rq.body.method || 'check'),
        reference: rq.body.reference ? String(rq.body.reference) : undefined,
        receivedDate: ctx.businessDate,
        memo: rq.body.memo ? String(rq.body.memo) : 'staff entered',
      });
    } catch (e) {
      if (e instanceof PaymentRejected) return redirect(`/leases/${rq.params.id}`, e.message, 'err');
      throw e;
    }
    return redirect(`/leases/${rq.params.id}`, 'Payment recorded — receipt sent.');
  });

  r.post('/leases/:id/charges', requirePerm('ledger:charge'), (rq) => {
    const ctx = rq.ctx as Ctx;
    createCharge(ctx, {
      leaseId: rq.params.id!,
      kind: v.oneOf('rent', 'utility', 'amenity', 'damage', 'other', 'late_fee', 'concession').parse(rq.body.kind || 'other'),
      label: String(rq.body.label || 'Charge'),
      amountCents: v.cents().parse(rq.body.amount),
      date: ctx.businessDate,
      source: 'oneoff',
    });
    return redirect(`/leases/${rq.params.id}`, 'Charge posted.');
  });

  r.post('/leases/:id/deposit/finalize', requirePerm('deposits:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const result = finalizeDeposit(ctx, rq.params.id!, { date: ctx.businessDate, toCollections: rq.body.to_collections === '1' });
    return redirect(
      `/leases/${rq.params.id}?tab=deposit`,
      `Disposition complete: ${usd(result.applied)} applied, ${usd(result.refunded)} refunded${result.balanceDue > 0 ? `, ${usd(result.balanceDue)} still owed` : ''}.`,
    );
  });

  r.post('/payments/:id/reverse', requirePerm('payments:refund'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const p = q1<any>('SELECT * FROM payments WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!p) return notFound();
    if (!['pending', 'settled'].includes(p.status)) return badRequest('payment is not reversible');
    reversePayment(ctx, p, ctx.businessDate, p.method === 'card' ? 'chargeback' : 'nsf');
    audit(ctx, 'payment', p.id, 'manual_reversal');
    return redirect(`/leases/${p.lease_id}`, 'Payment reversed; balance reinstated with fee.');
  });
}

// lease page integrations
registerLeaseTab((ctx, lease) => ({
  key: 'deposit',
  label: 'Deposit',
  render: () => {
    const held = depositHeld(ctx, lease.id);
    const activity = q<any>('SELECT * FROM deposit_activity WHERE lease_id=? ORDER BY date', lease.id);
    const balance = leaseBalance(ctx, lease.id);
    return html`
      ${card('Deposit position', dl([
        ['Contract deposit', lease.deposit_alternative ? html`Deposit alternative <span class="badge violet">no cash deposit</span>` : usd(lease.deposit_cents)],
        ['Currently held', usd(held)],
        ['Account balance', html`<span class="${balance > 0 ? 'neg' : ''}">${usd(balance)}</span>`],
      ]))}
      ${when(activity.length, () => card('Deposit activity', tbl(
        [{ label: 'Date' }, { label: 'Kind' }, { label: 'Memo' }, { label: 'Amount', num: true }],
        activity.map((a) => ({ cells: [fmtDate(a.date), statusBadge(undefined, a.kind), a.memo || '', usd(a.amount_cents)] })),
      ), { flush: true }))}
      ${when(held > 0 && ['notice', 'ended', 'month_to_month', 'active'].includes(lease.status), () => card('Move-out disposition (SODA)', html`
        <p class="small muted">Post any damage charges on the ledger first (they appear in the final statement), then finalize: the held deposit applies to the balance oldest-first, any remainder refunds by check, any shortfall can escalate to collections.</p>
        <form method="post" action="/leases/${lease.id}/charges" class="toolbar">
          <input type="hidden" name="kind" value="damage" />
          ${field('Damage description', input('label', { placeholder: 'Carpet replacement — bedroom' }))}
          ${field('Amount', moneyInput('amount'))}
          <button class="btn btn-sm btn-ghost">Post damage charge</button>
        </form>
        <form method="post" action="/leases/${lease.id}/deposit/finalize" data-confirm="Finalize the deposit disposition? This posts GL entries and issues any refund.">
          ${checkbox('to_collections', 'Open a collections case if a balance remains', true)}
          <button class="btn">Finalize disposition</button>
        </form>`))}`;
  },
}));

registerLeaseAction((ctx, lease) => {
  if (!ctx.perms.has('payments:record') || !['active', 'month_to_month', 'notice', 'ended'].includes(lease.status)) return null;
  const balance = leaseBalance(ctx, lease.id);
  return html`<details style="position:relative">
    <summary class="btn btn-ghost" style="list-style:none">Record payment</summary>
    <div style="position:absolute;right:0;top:42px;z-index:50;background:var(--surface);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow-lg);padding:14px;width:300px">
      <form method="post" action="/leases/${lease.id}/payments">
        ${field('Amount', moneyInput('amount', balance > 0 ? balance : null, { required: true }))}
        ${field('Method', select('method', [['check', 'Check'], ['money_order', 'Money order'], ['ach', 'ACH (simulated)'], ['card', 'Card (simulated)'], ['cash_equivalent', 'Certified funds']]))}
        ${field('Reference #', input('reference', { placeholder: 'check number' }))}
        <button class="btn" style="width:100%">Post payment</button>
      </form>
    </div>
  </details>`;
});
