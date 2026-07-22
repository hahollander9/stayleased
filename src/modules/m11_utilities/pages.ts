import { html, when, join, type Child } from '../../lib/html.ts';
import { notFound, redirect, type Router } from '../../lib/http.ts';
import { requirePerm, can, propFilter, type Ctx } from '../../lib/auth.ts';
import { q, q1, val, j } from '../../lib/db.ts';
import { fmtDate, fmtMonth, monthKey, addMonths } from '../../lib/dates.ts';
import { usd } from '../../lib/money.ts';
import { shell, card, tbl, dl, statusBadge, field, select, input, registerNav, kpis, tabs, emptyState } from '../../ui/ui.ts';
import { lines as lineChart, bars } from '../../lib/charts.ts';
import { unitFor } from '../../lib/sim/submeter.ts';
import { SERVICES, ingestMonth, estimateRead, acceptRead, rubsPreview, saveRubsRun, postRubsRun, recoveryReport, unitUsage } from './service.ts';

/** M11 screens: utilities dashboard (usage/cost trends), meters + anomaly
 * review, provider invoices with rate history, RUBS runs, vacant recovery. */

registerNav('Money', { href: '/utilities', label: 'Utilities', perm: 'utilities:view', match: ['/utilities'] });

function propsFor(ctx: Ctx): any[] {
  const pf = propFilter(ctx, 'id');
  return q<any>(`SELECT id, name FROM properties WHERE org_id=?${pf.sql} ORDER BY name`, ctx.orgId, ...pf.params);
}

export function routes(r: Router): void {
  // ---------- dashboard ----------
  r.get('/utilities', requirePerm('utilities:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const props = propsFor(ctx);
    const propId = rq.query.get('property') || props[0]?.id;
    const months: string[] = [];
    for (let i = 11; i >= 0; i--) months.push(monthKey(addMonths(ctx.businessDate, -i - 1)));
    const services = SERVICES.filter((s) =>
      val<number>('SELECT COUNT(*) FROM utility_provider_invoices WHERE property_id=? AND service=?', propId, s));
    const costSeries = services.map((s, i) => ({
      name: s,
      tone: ['accent', 'ok', 'warn', 'bad'][i % 4]!,
      points: months.map((m) => val<number>(
        'SELECT total_cents FROM utility_provider_invoices WHERE property_id=? AND service=? AND usage_month=?', propId, s, m,
      ) || 0),
    }));
    const usageSeries = services.map((s, i) => ({
      name: `${s} (${unitFor(s)})`,
      tone: ['accent', 'ok', 'warn', 'bad'][i % 4]!,
      points: months.map((m) => val<number>(
        'SELECT usage_qty FROM utility_provider_invoices WHERE property_id=? AND service=? AND usage_month=?', propId, s, m,
      ) || 0),
    }));
    const unitCount = val<number>('SELECT COUNT(*) FROM units WHERE property_id=?', propId) || 1;
    const lastMonth = months[months.length - 1]!;
    const lastCost = val<number>('SELECT SUM(total_cents) FROM utility_provider_invoices WHERE property_id=? AND usage_month=?', propId, lastMonth) || 0;
    const yoyMonth = monthKey(addMonths(`${lastMonth}-15`, -12));
    const yoyCost = val<number>('SELECT SUM(total_cents) FROM utility_provider_invoices WHERE property_id=? AND usage_month=?', propId, yoyMonth) || 0;
    const anomalies = val<number>(
      `SELECT COUNT(*) FROM meter_reads mr JOIN meters m ON m.id=mr.meter_id WHERE m.property_id=? AND mr.status='review'`, propId,
    ) || 0;
    const recovered = val<number>(`SELECT SUM(recovered_cents) FROM rubs_runs WHERE property_id=? AND usage_month=?`, propId, lastMonth) || 0;
    return shell(rq, {
      title: 'Utility expense management',
      active: '/utilities',
      subtitle: 'Usage & cost trends, benchmarks and recovery — fed by SubmeterNetwork',
      actions: html`
        <a class="btn btn-ghost" href="/utilities/meters">Meters ${anomalies ? html`<span class="badge badge-warn">${anomalies}</span>` : ''}</a>
        <a class="btn btn-ghost" href="/utilities/invoices">Provider invoices</a>
        <a class="btn btn-ghost" href="/utilities/recovery?property=${propId}">Recovery report</a>
        <a class="btn" href="/utilities/rubs?property=${propId}">RUBS runs</a>`,
      content: html`
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Property', select('property', props.map((p): [string, string] => [p.id, p.name]), propId))}
        </form>
        ${kpis([
          { label: `Utility spend — ${fmtMonth(lastMonth)}`, value: usd(lastCost) },
          { label: 'Cost per unit', value: usd(Math.round(lastCost / unitCount)) },
          { label: 'YoY', value: yoyCost ? `${lastCost >= yoyCost ? '+' : ''}${Math.round(((lastCost - yoyCost) / yoyCost) * 100)}%` : '—', tone: lastCost > yoyCost ? 'warn' : 'ok' },
          { label: `Recovered via RUBS — ${fmtMonth(lastMonth)}`, value: usd(recovered) },
          { label: 'Reads to review', value: String(anomalies), tone: anomalies ? 'warn' : 'ok' },
        ])}
        ${card('Cost by service (12 months)', lineChart(months.map((m) => fmtMonth(m).slice(0, 3)), costSeries, { money: true, height: 200 }))}
        ${card('Usage by service (12 months)', lineChart(months.map((m) => fmtMonth(m).slice(0, 3)), usageSeries, { height: 180 }))}`,
    });
  });

  // ---------- meters + anomaly queue ----------
  r.get('/utilities/meters', requirePerm('utilities:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const review = q<any>(
      `SELECT mr.*, m.service, m.serial, m.property_id, u.unit_number, p.name AS property
       FROM meter_reads mr JOIN meters m ON m.id=mr.meter_id LEFT JOIN units u ON u.id=m.unit_id JOIN properties p ON p.id=m.property_id
       WHERE mr.org_id=? AND mr.status='review' ORDER BY mr.month_key DESC LIMIT 60`,
      ctx.orgId,
    );
    const meterCount = val<number>('SELECT COUNT(*) FROM meters WHERE org_id=? AND active=1', ctx.orgId) || 0;
    const readCount = val<number>('SELECT COUNT(*) FROM meter_reads WHERE org_id=?', ctx.orgId) || 0;
    return shell(rq, {
      title: 'Meters & reads',
      active: '/utilities',
      subtitle: `${meterCount} meters · ${readCount.toLocaleString()} reads ingested from SubmeterNetwork`,
      content: html`
        ${card(html`Anomaly review queue ${review.length ? html`<span class="badge badge-warn">${review.length}</span>` : html`<span class="badge ok">clear</span>`}`, tbl(
          [{ label: 'Month' }, { label: 'Property' }, { label: 'Unit' }, { label: 'Service' }, { label: 'Read' }, { label: 'Anomaly' }, { label: 'Action' }],
          review.map((x) => ({
            cells: [
              fmtMonth(x.month_key), x.property, x.unit_number || 'common', x.service,
              `${x.usage_qty} ${unitFor(x.service)}`, statusBadge('warn', x.anomaly),
              html`
                <form method="post" action="/utilities/reads/${x.id}/estimate" style="display:inline"><button class="btn btn-sm">Estimate (trailing avg)</button></form>
                <form method="post" action="/utilities/reads/${x.id}/accept" style="display:inline"><button class="btn btn-ghost btn-sm">Accept as-is</button></form>`,
            ],
          })),
          { empty: 'Nothing needs review — reads are clean.' },
        ), { flush: true })}`,
    });
  });

  r.post('/utilities/reads/:id/estimate', requirePerm('utilities:manage'), (rq) => {
    estimateRead(rq.ctx as Ctx, rq.params.id!);
    return redirect('/utilities/meters', 'Read estimated from the trailing average');
  });
  r.post('/utilities/reads/:id/accept', requirePerm('utilities:manage'), (rq) => {
    acceptRead(rq.ctx as Ctx, rq.params.id!);
    return redirect('/utilities/meters', 'Read accepted');
  });

  // ---------- provider invoices + rate history ----------
  r.get('/utilities/invoices', requirePerm('utilities:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const rows = q<any>(
      `SELECT upi.*, p.name AS property, v.name AS vendor FROM utility_provider_invoices upi
       JOIN properties p ON p.id=upi.property_id JOIN vendors v ON v.id=upi.vendor_id
       WHERE upi.org_id=? ORDER BY upi.usage_month DESC, p.name LIMIT 120`,
      ctx.orgId,
    );
    return shell(rq, {
      title: 'Utility provider invoices',
      active: '/utilities',
      subtitle: 'Provider bills flow into AP; rates tracked per service month',
      content: card(null, tbl(
        [{ label: 'Usage month' }, { label: 'Property' }, { label: 'Service' }, { label: 'Usage' }, { label: 'Rate' }, { label: 'AP invoice' }, { label: 'Amount', num: true }],
        rows.map((x) => ({
          href: x.vendor_invoice_id ? `/ap/${x.vendor_invoice_id}` : undefined,
          cells: [fmtMonth(x.usage_month), x.property, x.service, `${Math.round(x.usage_qty).toLocaleString()} ${unitFor(x.service)}`, x.rate_note || '—', x.vendor_invoice_id ? statusBadge('ok', 'in AP') : '—', usd(x.total_cents)],
        })),
        { empty: 'No provider invoices yet — they arrive on the 3rd via the utility cycle job.' },
      ), { flush: true }),
    });
  });

  // ---------- RUBS ----------
  r.get('/utilities/rubs', requirePerm('utilities:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const props = propsFor(ctx);
    const propId = rq.query.get('property') || props[0]?.id;
    const runs = q<any>(
      `SELECT * FROM rubs_runs WHERE org_id=? AND property_id=? ORDER BY usage_month DESC, service LIMIT 60`,
      ctx.orgId, propId,
    );
    const configs = q<any>('SELECT * FROM rubs_configs WHERE org_id=? AND property_id=?', ctx.orgId, propId);
    return shell(rq, {
      title: 'RUBS billing runs',
      active: '/utilities',
      subtitle: 'Preview every unit\'s math, then post converged charges to resident ledgers',
      content: html`
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Property', select('property', props.map((p): [string, string] => [p.id, p.name]), propId))}
        </form>
        ${card('Allocation formulas', tbl(
          [{ label: 'Service' }, { label: 'Method' }, { label: 'Common deduction' }, { label: 'Billing fee' }],
          configs.map((c) => ({ cells: [c.service, statusBadge(undefined, c.method), `${c.common_deduct_pct}%`, usd(c.admin_fee_cents)] })),
          { empty: 'No RUBS configuration for this property (resident-paid utilities).' },
        ), { flush: true })}
        ${card('Runs', tbl(
          [{ label: 'Usage month' }, { label: 'Service' }, { label: 'Provider bill', num: true }, { label: 'Recovered', num: true }, { label: 'Vacant', num: true }, { label: 'Status' }, { label: '' }],
          runs.map((x) => ({
            cells: [
              fmtMonth(x.usage_month), x.service, usd(x.total_cents), usd(x.recovered_cents), usd(x.vacant_cents),
              statusBadge(x.status),
              html`<a class="btn btn-ghost btn-sm" href="/utilities/rubs/${x.id}">${x.status === 'preview' ? 'Review & post' : 'View math'}</a>`,
            ],
          })),
          { empty: 'No runs staged — the utility cycle job stages previews on the 3rd.' },
        ), { flush: true })}`,
    });
  });

  r.get('/utilities/rubs/:id', requirePerm('utilities:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const runRow = q1<any>('SELECT r.*, p.name AS property FROM rubs_runs r JOIN properties p ON p.id=r.property_id WHERE r.id=? AND r.org_id=?', rq.params.id!, ctx.orgId);
    if (!runRow) return notFound();
    const lineRows = q<any>(
      `SELECT l.*, u.unit_number, ls.household_name FROM rubs_lines l JOIN units u ON u.id=l.unit_id
       LEFT JOIN leases ls ON ls.id=l.lease_id WHERE l.run_id=? ORDER BY u.unit_number`,
      runRow.id,
    );
    return shell(rq, {
      title: `${runRow.service} RUBS — ${fmtMonth(runRow.usage_month)}`,
      active: '/utilities',
      subtitle: html`${runRow.property} · ${statusBadge(runRow.status)} · method: ${runRow.method}`,
      actions: when(runRow.status === 'preview' && can(ctx, 'utilities:bill'), () => html`
        <form method="post" action="/utilities/rubs/${runRow.id}/post" data-confirm="Post these charges to every resident ledger?">
          <button class="btn">Approve & post to ledgers</button>
        </form>`),
      content: html`
        ${kpis([
          { label: 'Provider bill', value: usd(runRow.total_cents) },
          { label: `Common deduction`, value: usd(runRow.common_cents) },
          { label: 'Billed to residents', value: usd(runRow.recovered_cents), tone: 'ok' },
          { label: 'Vacant (property absorbs)', value: usd(runRow.vacant_cents), tone: runRow.vacant_cents ? 'warn' : undefined },
        ])}
        ${card('Per-unit math', tbl(
          [{ label: 'Unit' }, { label: 'Household' }, { label: 'Basis' }, { label: 'Share', num: true }, { label: 'Billing fee', num: true }, { label: 'Posted' }],
          lineRows.map((l) => ({
            cells: [
              l.unit_number, l.household_name || html`<span class="muted">vacant share</span>`, l.basis_label,
              usd(l.amount_cents), l.admin_fee_cents ? usd(l.admin_fee_cents) : '',
              l.charge_id ? statusBadge('ok', 'on ledger') : runRow.status === 'posted' ? '—' : statusBadge(undefined, 'preview'),
            ],
          })),
        ), { flush: true })}`,
    });
  });

  r.post('/utilities/rubs/:id/post', requirePerm('utilities:bill'), (rq) => {
    const ctx = rq.ctx as Ctx;
    try {
      const res = postRubsRun(ctx, rq.params.id!);
      return redirect(`/utilities/rubs/${rq.params.id}`, `${res.charges} charges posted (${usd(res.recovered)}) — converged on this month's statements`);
    } catch (e) {
      return redirect(`/utilities/rubs/${rq.params.id}`, (e as Error).message, 'err');
    }
  });

  // ---------- vacant recovery ----------
  r.get('/utilities/recovery', requirePerm('utilities:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const props = propsFor(ctx);
    const propId = rq.query.get('property') || props[0]?.id;
    const rep = recoveryReport(ctx, propId, 6);
    return shell(rq, {
      title: 'Vacant-unit cost recovery',
      active: '/utilities',
      subtitle: 'Utility cost during vacancy stays with the property — tracked to the day around move-in/out',
      content: html`
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Property', select('property', props.map((p): [string, string] => [p.id, p.name]), propId))}
        </form>
        ${card('Recovery rate by service', tbl(
          [{ label: 'Service' }, ...rep.months.map((m) => ({ label: fmtMonth(m).slice(0, 3), num: true })), { label: 'Recovery %', num: true }],
          rep.rows.map((x) => {
            const billed = x.billed.reduce((s, y) => s + y, 0);
            const rec = x.recovered.reduce((s, y) => s + y, 0);
            return {
              cells: [
                x.service,
                ...x.recovered.map((r2, i) => (x.billed[i] ? html`${usd(r2)}<br><span class="small muted">of ${usd(x.billed[i]!)}</span>` : '—')),
                billed ? `${Math.round((rec / billed) * 100)}%` : '—',
              ],
            };
          }),
          { empty: 'No RUBS history yet.' },
        ), { flush: true })}
        ${card('Vacant shares (most recent)', tbl(
          [{ label: 'Month' }, { label: 'Unit' }, { label: 'Service' }, { label: 'Vacancy' }, { label: 'Property absorbed', num: true }],
          rep.vacantDetail.map((v) => ({ cells: [fmtMonth(v.month), v.unit, v.service, v.days, usd(v.amount)] })),
          { empty: 'No vacant shares — full occupancy through the window.' },
        ), { flush: true })}`,
    });
  });
}

// ---------- resident portal card (mounted from m7 via portalUsageCard) ----------

export function portalUsageCard(ctx: Ctx, lease: any): Child {
  const services = q<any>(
    `SELECT DISTINCT m.service FROM meters m WHERE m.unit_id=? AND m.active=1`, lease.unit_id,
  ).map((x) => x.service).filter((s) => s !== 'trash');
  if (!services.length) return null;
  const service = services.includes('electric') ? 'electric' : services[0]!;
  const u = unitUsage(ctx, lease.unit_id, service, 8);
  if (u.mine.every((x) => !x)) return null;
  const latest = u.mine[u.mine.length - 1] || 0;
  const commAvg = u.community[u.community.length - 1] || 0;
  const delta = commAvg ? Math.round(((latest - commAvg) / commAvg) * 100) : 0;
  return html`
    <div class="card">
      <h3>Your ${service} usage</h3>
      ${lineChart(u.months.map((m) => fmtMonth(m).slice(0, 3)), [
        { name: 'You', tone: 'accent', points: u.mine },
        { name: 'Community avg', tone: 'ok', points: u.community },
      ], { height: 130 })}
      <p class="small ${delta > 10 ? '' : 'muted'}">
        Last month you used <b>${Math.round(latest)} ${unitFor(service)}</b> — ${delta === 0 ? 'right at' : `${Math.abs(delta)}% ${delta > 0 ? 'above' : 'below'}`} the community average.
        ${delta > 10 ? 'Small changes help: LED bulbs, thermostat schedules, and full loads of laundry.' : 'Nice work keeping usage in check. 🌱'}
      </p>
    </div>`;
}
