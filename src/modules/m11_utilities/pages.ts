import { html, when, join, type Child } from '../../lib/html.ts';
import { notFound, redirect, type Router } from '../../lib/http.ts';
import { requirePerm, can, propFilter, type Ctx } from '../../lib/auth.ts';
import { audit } from '../../lib/audit.ts';
import { isLiveOrg } from '../../lib/sim/messaging.ts';
import { q, q1, val, j } from '../../lib/db.ts';
import { fmtDate, fmtMonth, monthKey, addMonths } from '../../lib/dates.ts';
import { usd, parseUsd } from '../../lib/money.ts';
import { shell, card, tbl, dl, statusBadge, field, select, input, moneyInput, checkbox, registerNav, kpis, tabs, emptyState, noProperties } from '../../ui/ui.ts';
import { lines as lineChart, bars } from '../../lib/charts.ts';
import { unitFor } from '../../lib/sim/submeter.ts';
import {
  SERVICES, RUBS_METHODS, estimateRead, acceptRead, saveRubsRun, postRubsRun, recoveryReport, unitUsage,
  ensurePropertyMeters, recordManualRead, enterProviderInvoice, saveRubsConfig, discardRubsRun,
} from './service.ts';

/** M11 screens: utilities dashboard (usage/cost trends), meters + anomaly
 * review, provider invoices with rate history, RUBS runs, vacant recovery. */

registerNav('Money', { href: '/utilities', label: 'Utilities', perm: 'utilities:view', match: ['/utilities'] });

function propsFor(ctx: Ctx): any[] {
  const pf = propFilter(ctx, 'id');
  return q<any>(`SELECT id, name FROM properties WHERE org_id=?${pf.sql} ORDER BY name`, ctx.orgId, ...pf.params);
}

/** The property a form names, only if this user may act on it. */
function ownProp(ctx: Ctx, propertyId: unknown): { id: string; name: string } | undefined {
  return propsFor(ctx).find((p) => p.id === String(propertyId || ''));
}

/** The last twelve usage months, newest first, for a month picker. */
function monthChoices(ctx: Ctx): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < 12; i++) {
    const m = monthKey(addMonths(ctx.businessDate, -i));
    out.push([m, fmtMonth(m)]);
  }
  return out;
}

const METHOD_LABEL: Record<string, string> = {
  sqft: 'By square footage', occupants: 'By number of occupants', flat: 'Flat amount per home',
  submeter: 'By each home’s meter reading', hybrid: 'Half meter reading, half square footage',
};

/** Where the numbers on these pages come from. The demo is fed by a simulated
 * submeter network and a monthly job; a live account has neither — every
 * reading and every provider bill is typed in by its own staff. */
function sourceNote(ctx: Ctx, demo: string, live: string): string {
  return isLiveOrg(ctx) ? live : demo;
}

export function routes(r: Router): void {
  // ---------- dashboard ----------
  r.get('/utilities', requirePerm('utilities:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const props = propsFor(ctx);
    if (!props.length) return noProperties(rq, 'Utilities', '/utilities');
    const propId = ownProp(ctx, rq.query.get('property'))?.id || props[0]!.id;
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
      subtitle: sourceNote(ctx, 'Usage & cost trends, benchmarks and recovery — fed by SubmeterNetwork',
        'Cost and usage from the provider bills you enter, and what was billed back to residents'),
      actions: html`
        <a class="btn btn-ghost" href="/utilities/meters">Meters ${anomalies ? html`<span class="badge badge-warn">${anomalies}</span>` : ''}</a>
        <a class="btn btn-ghost" href="/utilities/invoices">Provider invoices</a>
        <a class="btn btn-ghost" href="/utilities/recovery?property=${propId}">Recovery report</a>
        <a class="btn" href="/utilities/rubs?property=${propId}">RUBS runs</a>`,
      content: html`
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Property', select('property', props.map((p): [string, string] => [p.id, p.name]), propId))}
        </form>
        ${when(!services.length, () => card('Billing utilities back to residents', html`
          <p style="margin-top:0">Nothing is entered for this property yet. ${isLiveOrg(ctx) ? 'Readings and provider bills are typed in by your team — nothing arrives automatically.' : ''}</p>
          <ol style="margin:0 0 0 18px">
            <li><a href="/utilities/rubs?property=${propId}">Choose how each utility is split</a> between homes (square footage, occupants, a flat amount, or meter readings).</li>
            <li>If you split by meter reading, <a href="/utilities/meters?property=${propId}">set up meters and enter the month’s readings</a>.</li>
            <li><a href="/utilities/invoices?property=${propId}">Enter the provider’s bill</a> for the month. It goes to Payables as a bill to pay.</li>
            <li><a href="/utilities/rubs?property=${propId}">Stage the bill-back</a>, check every home’s share, then post it to resident ledgers.</li>
          </ol>`))}
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

  // ---------- meters, manual readings, anomaly queue ----------
  r.get('/utilities/meters', requirePerm('utilities:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const props = propsFor(ctx);
    if (!props.length) return noProperties(rq, 'Meters & reads', '/utilities');
    const propId = ownProp(ctx, rq.query.get('property'))?.id || props[0]!.id;
    const pf = propFilter(ctx, 'm.property_id');
    const review = q<any>(
      `SELECT mr.*, m.service, m.serial, m.property_id, u.unit_number, p.name AS property
       FROM meter_reads mr JOIN meters m ON m.id=mr.meter_id LEFT JOIN units u ON u.id=m.unit_id JOIN properties p ON p.id=m.property_id
       WHERE mr.org_id=? AND mr.status='review'${pf.sql} ORDER BY mr.month_key DESC LIMIT 60`,
      ctx.orgId, ...pf.params,
    );
    const meterCount = val<number>('SELECT COUNT(*) FROM meters WHERE org_id=? AND active=1', ctx.orgId) || 0;
    const readCount = val<number>('SELECT COUNT(*) FROM meter_reads WHERE org_id=?', ctx.orgId) || 0;
    const byService = q<any>(
      `SELECT m.service, SUM(CASE WHEN m.unit_id IS NOT NULL THEN 1 ELSE 0 END) AS unit_meters,
         SUM(CASE WHEN m.unit_id IS NULL THEN 1 ELSE 0 END) AS common_meters,
         (SELECT MAX(r.month_key) FROM meter_reads r JOIN meters m2 ON m2.id=r.meter_id WHERE m2.property_id=m.property_id AND m2.service=m.service) AS last_month
       FROM meters m WHERE m.org_id=? AND m.property_id=? AND m.active=1 GROUP BY m.service ORDER BY m.service`,
      ctx.orgId, propId,
    );
    const unitCount = val<number>('SELECT COUNT(*) FROM units WHERE org_id=? AND property_id=?', ctx.orgId, propId) || 0;
    const canManage = can(ctx, 'utilities:manage');
    const months = monthChoices(ctx);
    return shell(rq, {
      title: 'Meters & reads',
      active: '/utilities',
      crumbs: [['Utilities', '/utilities']],
      subtitle: sourceNote(ctx, `${meterCount} meters · ${readCount.toLocaleString()} reads ingested from SubmeterNetwork`,
        `${meterCount} meters · ${readCount.toLocaleString()} readings entered by your team`),
      content: html`
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Property', select('property', props.map((p): [string, string] => [p.id, p.name]), propId))}
        </form>
        ${card('Meters at this property', html`
          ${tbl(
            [{ label: 'Utility' }, { label: 'Home meters', num: true }, { label: 'Common-area meters', num: true }, { label: 'Latest readings' }, { label: '' }],
            byService.map((x) => ({
              cells: [
                x.service, x.unit_meters, x.common_meters, x.last_month ? fmtMonth(x.last_month) : 'none yet',
                canManage ? html`<a class="btn btn-ghost btn-sm" href="/utilities/reads/enter?property=${propId}&service=${x.service}&month=${months[1]![0]}">Enter readings</a>` : '',
              ],
            })),
            { empty: 'No meters are set up for this property. Meters are only needed if a utility is split by each home’s reading.' },
          )}
          ${when(canManage, () => html`
            <form method="post" action="/utilities/meters/setup" class="toolbar" style="margin-top:12px">
              <input type="hidden" name="property_id" value="${propId}" />
              <fieldset style="border:0;padding:0;margin:0"><legend class="small"><b>Add a meter for every home (${unitCount}) and one for common areas</b></legend>
                ${SERVICES.filter((x) => x !== 'trash').map((x) => checkbox(`svc_${x}`, x[0]!.toUpperCase() + x.slice(1)))}
              </fieldset>
              <button class="btn btn-sm btn-ghost">Set up meters</button>
            </form>
            <p class="small muted">Homes that already have a meter for that utility are left alone, so this is safe to run again after adding units.</p>`)}`)}
        ${card(html`${isLiveOrg(ctx) ? 'Readings to review' : 'Anomaly review queue'} ${review.length ? html`<span class="badge badge-warn">${review.length}</span>` : html`<span class="badge ok">clear</span>`}`, tbl(
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

  r.post('/utilities/meters/setup', requirePerm('utilities:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const prop = ownProp(ctx, rq.body?.property_id);
    if (!prop) return notFound();
    const back = `/utilities/meters?property=${prop.id}`;
    const services = SERVICES.filter((x) => x !== 'trash' && rq.body?.[`svc_${x}`]);
    if (!services.length) return redirect(back, 'Tick at least one utility to set up meters for.', 'err');
    if (!val<number>('SELECT COUNT(*) FROM units WHERE org_id=? AND property_id=?', ctx.orgId, prop.id)) {
      return redirect(back, 'This property has no units yet — add its units first.', 'err');
    }
    const made = ensurePropertyMeters(ctx.orgId, prop.id, services);
    audit(ctx, 'property', prop.id, 'meters_setup', null, { services, metersAdded: made });
    return redirect(back, made ? `${made} meter${made === 1 ? '' : 's'} added for ${services.join(', ')}.` : 'Every home already had those meters — nothing to add.');
  });

  r.get('/utilities/reads/enter', requirePerm('utilities:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const prop = ownProp(ctx, rq.query.get('property'));
    if (!prop) return notFound();
    const months = monthChoices(ctx);
    const service = (SERVICES as readonly string[]).includes(rq.query.get('service') || '') ? rq.query.get('service')! : 'water';
    const month = months.some(([m]) => m === rq.query.get('month')) ? rq.query.get('month')! : months[1]![0];
    const meters = q<any>(
      `SELECT m.*, u.unit_number, (SELECT r.usage_qty FROM meter_reads r WHERE r.meter_id=m.id AND r.month_key=?) AS usage_qty
       FROM meters m LEFT JOIN units u ON u.id=m.unit_id
       WHERE m.org_id=? AND m.property_id=? AND m.service=? AND m.active=1
       ORDER BY CASE WHEN m.unit_id IS NULL THEN 1 ELSE 0 END, u.unit_number`,
      month, ctx.orgId, prop.id, service,
    );
    const unit = unitFor(service);
    return shell(rq, {
      title: 'Enter meter readings',
      active: '/utilities',
      crumbs: [['Utilities', '/utilities'], ['Meters & reads', `/utilities/meters?property=${prop.id}`]],
      subtitle: `${prop.name} · ${service} · ${fmtMonth(month)}`,
      content: html`
        <form method="get" class="toolbar" data-autosubmit>
          <input type="hidden" name="property" value="${prop.id}" />
          ${field('Utility', select('service', SERVICES.filter((x) => x !== 'trash').map((x): [string, string] => [x, x]), service))}
          ${field('Usage month', select('month', months, month))}
        </form>
        ${meters.length ? html`<form method="post" action="/utilities/reads/enter">
          <input type="hidden" name="property_id" value="${prop.id}" /><input type="hidden" name="service" value="${service}" /><input type="hidden" name="month" value="${month}" />
          ${card(`Usage for ${fmtMonth(month)}, in ${unit}`, html`
            <p class="small muted" style="margin-top:0">Type how much each meter used during the month (this month’s reading minus last month’s). Leave a box empty to skip that meter.</p>
            <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Home</th><th>Meter</th><th>Usage (${unit})</th></tr></thead><tbody>
              ${join(meters.map((m) => html`<tr>
                <td>${m.unit_number ? `Unit ${m.unit_number}` : 'Common areas'}</td>
                <td><span class="mono small">${m.serial}</span></td>
                <td>${input(`read_${m.id}`, { type: 'number', step: 'any', min: '0', value: m.usage_qty ?? '', placeholder: `Usage for ${m.unit_number ? `unit ${m.unit_number}` : 'common areas'}` })}</td>
              </tr>`), '')}
            </tbody></table></div>`)}
          <div class="btn-row"><button class="btn">Save readings</button> <a class="btn btn-ghost" href="/utilities/meters?property=${prop.id}">Cancel</a></div>
        </form>` : card(null, emptyState(`No ${service} meters at this property`, 'Set up meters first, then come back to enter readings.', html`<a class="btn" href="/utilities/meters?property=${prop.id}">Set up meters</a>`))}`,
    });
  });

  r.post('/utilities/reads/enter', requirePerm('utilities:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const b = rq.body || {};
    const prop = ownProp(ctx, b.property_id);
    if (!prop) return notFound();
    const service = String(b.service || '');
    const month = String(b.month || '');
    const back = `/utilities/reads/enter?property=${prop.id}&service=${encodeURIComponent(service)}&month=${encodeURIComponent(month)}`;
    const meters = q<any>('SELECT id FROM meters WHERE org_id=? AND property_id=? AND service=? AND active=1', ctx.orgId, prop.id, service);
    let saved = 0;
    try {
      for (const m of meters) {
        const raw = String(b[`read_${m.id}`] ?? '').trim();
        if (raw === '') continue;
        const qty = Number(raw);
        if (!Number.isFinite(qty) || qty < 0) throw new Error(`"${raw}" is not a usable reading — enter a number, zero or more.`);
        if (recordManualRead(ctx, m.id, month, qty) !== 'unchanged') saved++;
      }
    } catch (e) {
      return redirect(back, (e as Error).message, 'err');
    }
    return redirect(back, saved ? `${saved} reading${saved === 1 ? '' : 's'} saved for ${fmtMonth(month)}.` : 'No readings changed.');
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
    const props = propsFor(ctx);
    const pf = propFilter(ctx, 'upi.property_id');
    const rows = q<any>(
      `SELECT upi.*, p.name AS property, v.name AS vendor, vi.status AS ap_status FROM utility_provider_invoices upi
       JOIN properties p ON p.id=upi.property_id JOIN vendors v ON v.id=upi.vendor_id
       LEFT JOIN vendor_invoices vi ON vi.id=upi.vendor_invoice_id
       WHERE upi.org_id=?${pf.sql} ORDER BY upi.usage_month DESC, p.name LIMIT 120`,
      ctx.orgId, ...pf.params,
    );
    const vendors = q<any>('SELECT id, name, category FROM vendors WHERE org_id=? AND active=1 ORDER BY CASE WHEN category=\'utility\' THEN 0 ELSE 1 END, name', ctx.orgId);
    const canManage = can(ctx, 'utilities:manage');
    const months = monthChoices(ctx);
    const preProp = ownProp(ctx, rq.query.get('property'))?.id || props[0]?.id || '';
    return shell(rq, {
      title: 'Utility provider invoices',
      active: '/utilities',
      crumbs: [['Utilities', '/utilities']],
      subtitle: 'Provider bills flow into AP; rates tracked per service month',
      content: html`
        ${when(canManage && props.length, () => card('Enter a provider bill', vendors.length ? html`
          <form method="post" action="/utilities/invoices/new">
            <div class="grid cols-2">
              ${field('Property', select('property_id', props.map((p): [string, string] => [p.id, p.name]), preProp, { required: true }))}
              ${field('Utility', select('service', SERVICES.map((x): [string, string] => [x, x]), 'water', { required: true }))}
              ${field('Provider', select('vendor_id', vendors.map((x): [string, string] => [x.id, x.name]), '', { required: true, blank: 'Choose…' }), html`The company the bill is from. Not listed? ${can(ctx, 'vendors:manage') ? html`<a href="/vendors/new">Add it as a vendor</a>` : 'Ask an administrator to add it as a vendor'}.`)}
              ${field('Usage month', select('usage_month', months, months[1]![0], { required: true }), 'The month the service was used, not the month the bill arrived.')}
              ${field('Bill total', moneyInput('total', null, { required: true }))}
              ${field('Total usage on the bill (optional)', input('usage_qty', { type: 'number', step: 'any', min: '0' }), 'kWh, gallons or therms — used to track the rate over time.')}
              ${field('Bill or account number (optional)', input('invoice_number'))}
              ${field('Bill date', input('invoice_date', { type: 'date', value: ctx.businessDate, required: true }))}
            </div>
            <button class="btn">Enter bill</button>
          </form>
          <p class="small muted">The bill is added to Payables as a bill to pay and follows your normal approval rules. It is also the total that gets divided between homes when you stage the bill-back.</p>`
          : html`<p style="margin-top:0">Add your utility providers as vendors first, so the bill has someone to be paid to.</p>${can(ctx, 'vendors:manage') ? html`<a class="btn" href="/vendors/new">Add vendor</a>` : ''}`))}
        ${card(null, tbl(
          [{ label: 'Usage month' }, { label: 'Property' }, { label: 'Service' }, { label: 'Provider' }, { label: 'Usage' }, { label: 'Rate' }, { label: 'AP invoice' }, { label: 'Amount', num: true }],
          rows.map((x) => ({
            href: x.vendor_invoice_id && can(ctx, 'ap:view') ? `/ap/${x.vendor_invoice_id}` : undefined,
            cells: [fmtMonth(x.usage_month), x.property, x.service, x.vendor, x.usage_qty ? `${Math.round(x.usage_qty).toLocaleString()} ${unitFor(x.service)}` : '—', x.rate_note || '—',
              x.vendor_invoice_id ? statusBadge(x.ap_status === 'pending_approval' ? 'warn' : 'ok', x.ap_status === 'pending_approval' ? 'awaiting approval' : x.ap_status === 'paid' ? 'paid' : x.ap_status === 'void' ? 'void' : 'in AP') : '—', usd(x.total_cents)],
          })),
          { empty: sourceNote(ctx, 'No provider invoices yet — they arrive on the 3rd via the utility cycle job.', 'No provider bills entered yet.') },
        ), { flush: true })}`,
    });
  });

  r.post('/utilities/invoices/new', requirePerm('utilities:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const b = rq.body || {};
    const prop = ownProp(ctx, b.property_id);
    if (!prop) return notFound();
    const back = `/utilities/invoices?property=${prop.id}`;
    try {
      let total = 0;
      try { total = parseUsd(String(b.total || '')); } catch { throw new Error('Enter the total amount of the bill.'); }
      const res = enterProviderInvoice(ctx, {
        propertyId: prop.id, service: String(b.service || ''), vendorId: String(b.vendor_id || ''),
        usageMonth: String(b.usage_month || ''), totalCents: total,
        usageQty: String(b.usage_qty || '').trim() ? Number(b.usage_qty) : 0,
        invoiceNumber: String(b.invoice_number || ''), invoiceDate: String(b.invoice_date || ''),
      });
      return redirect(back, `Bill entered: ${usd(total)} for ${String(b.service)}, ${fmtMonth(String(b.usage_month))}. It is in Payables ${res.apStatus === 'approved' ? 'ready to pay' : 'waiting for approval'}.`);
    } catch (e) {
      return redirect(back, (e as Error).message, 'err');
    }
  });

  // ---------- RUBS ----------
  r.get('/utilities/rubs', requirePerm('utilities:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const props = propsFor(ctx);
    if (!props.length) return noProperties(rq, 'RUBS billing runs', '/utilities');
    const propId = ownProp(ctx, rq.query.get('property'))?.id || props[0]!.id;
    const canManage = can(ctx, 'utilities:manage');
    const months = monthChoices(ctx);
    const editing = rq.query.get('edit') || '';
    const runs = q<any>(
      `SELECT * FROM rubs_runs WHERE org_id=? AND property_id=? ORDER BY usage_month DESC, service LIMIT 60`,
      ctx.orgId, propId,
    );
    const configs = q<any>('SELECT * FROM rubs_configs WHERE org_id=? AND property_id=? ORDER BY service', ctx.orgId, propId);
    const editCfg = configs.find((c) => c.service === editing);
    const activeCfgs = configs.filter((c) => c.active);
    return shell(rq, {
      title: 'RUBS billing runs',
      active: '/utilities',
      subtitle: 'Preview every unit\'s math, then post converged charges to resident ledgers',
      content: html`
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Property', select('property', props.map((p): [string, string] => [p.id, p.name]), propId))}
        </form>
        ${card('Allocation formulas', tbl(
          [{ label: 'Service' }, { label: 'Method' }, { label: 'Common deduction' }, { label: 'Billing fee' }, { label: '' }],
          configs.map((c) => ({ cells: [
            html`${c.service}${c.active ? '' : html` ${statusBadge(undefined, 'off')}`}`, statusBadge(undefined, c.method),
            c.method === 'flat' ? html`<span class="muted small">${usd(c.flat_fee_cents)} per home</span>` : `${c.common_deduct_pct}%`, usd(c.admin_fee_cents),
            canManage ? html`<a class="btn btn-ghost btn-sm" href="/utilities/rubs?property=${propId}&edit=${c.service}#formula">Change</a>` : '',
          ] })),
          { empty: 'No RUBS configuration for this property (resident-paid utilities).' },
        ), { flush: true })}
        ${when(canManage, () => html`<div id="formula">${card(editCfg ? `Change how ${editCfg.service} is split` : 'Set how a utility is split', html`
          <form method="post" action="/utilities/rubs/config">
            <input type="hidden" name="property_id" value="${propId}" />
            <div class="grid cols-2">
              ${field('Utility', select('service', SERVICES.map((x): [string, string] => [x, x]), editCfg?.service || 'water'))}
              ${field('How the bill is split', select('method', RUBS_METHODS.map((m): [string, string] => [m, METHOD_LABEL[m] || m]), editCfg?.method || 'sqft'), 'Meter-reading methods need meters and each month’s readings.')}
              ${field('Common-area share kept by the property (%)', input('common_deduct_pct', { type: 'number', step: 'any', min: '0', max: '100', value: editCfg ? editCfg.common_deduct_pct : 10 }), 'Held back before the rest is divided between homes.')}
              ${field('Billing fee per home, per bill', moneyInput('admin_fee', editCfg ? editCfg.admin_fee_cents : 0), 'Added to each resident’s share. Check your leases and local rules before charging one.')}
              ${field('Flat amount per home (flat method only)', moneyInput('flat_fee', editCfg ? editCfg.flat_fee_cents : 0))}
            </div>
            ${checkbox('active', 'Bill this utility back to residents', editCfg ? !!editCfg.active : true)}
            <div class="btn-row"><button class="btn btn-sm">Save formula</button></div>
          </form>
          <p class="small muted">Only bill a utility back if your leases say residents pay for it this way. A home’s share is prorated to the days it was occupied; the vacant share stays with the property.</p>`)}</div>
        ${card('Stage a bill-back', activeCfgs.length ? html`
          <form method="post" action="/utilities/rubs/stage" class="toolbar">
            <input type="hidden" name="property_id" value="${propId}" />
            ${field('Utility', select('service', activeCfgs.map((c): [string, string] => [c.service, c.service]), activeCfgs[0]!.service))}
            ${field('Usage month', select('usage_month', months, months[1]![0]))}
            <button class="btn btn-sm">Work out each home’s share</button>
          </form>
          <p class="small muted">Uses the provider bill entered for that month. Nothing is charged until you review the result and post it.</p>`
          : html`<p class="muted small" style="margin:0">Save a formula above first.</p>`)}`)}
        ${card('Runs', tbl(
          [{ label: 'Usage month' }, { label: 'Service' }, { label: 'Provider bill', num: true }, { label: 'Recovered', num: true }, { label: 'Vacant', num: true }, { label: 'Status' }, { label: '' }],
          runs.map((x) => ({
            cells: [
              fmtMonth(x.usage_month), x.service, usd(x.total_cents), usd(x.recovered_cents), usd(x.vacant_cents),
              statusBadge(x.status),
              html`<a class="btn btn-ghost btn-sm" href="/utilities/rubs/${x.id}">${x.status === 'preview' ? 'Review & post' : 'View math'}</a>`,
            ],
          })),
          { empty: sourceNote(ctx, 'No runs staged — the utility cycle job stages previews on the 3rd.', 'No bill-backs staged yet.') },
        ), { flush: true })}`,
    });
  });

  r.get('/utilities/rubs/:id', requirePerm('utilities:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const runRow = q1<any>('SELECT r.*, p.name AS property FROM rubs_runs r JOIN properties p ON p.id=r.property_id WHERE r.id=? AND r.org_id=?', rq.params.id!, ctx.orgId);
    if (!runRow || !ownProp(ctx, runRow.property_id)) return notFound();
    const lineRows = q<any>(
      `SELECT l.*, u.unit_number, ls.household_name FROM rubs_lines l JOIN units u ON u.id=l.unit_id
       LEFT JOIN leases ls ON ls.id=l.lease_id WHERE l.run_id=? ORDER BY u.unit_number`,
      runRow.id,
    );
    return shell(rq, {
      title: `${runRow.service} RUBS — ${fmtMonth(runRow.usage_month)}`,
      active: '/utilities',
      crumbs: [['Utilities', '/utilities'], ['RUBS billing runs', `/utilities/rubs?property=${runRow.property_id}`]],
      subtitle: html`${runRow.property} · ${statusBadge(runRow.status)} · method: ${runRow.method}`,
      actions: when(runRow.status === 'preview' && can(ctx, 'utilities:bill'), () => html`
        <form method="post" action="/utilities/rubs/${runRow.id}/post" data-confirm="Post these charges to every resident ledger?" style="display:inline">
          <button class="btn">Approve & post to ledgers</button>
        </form>
        ${when(can(ctx, 'utilities:manage'), () => html`<form method="post" action="/utilities/rubs/${runRow.id}/discard" data-confirm="Discard this preview? Nothing has been charged. You can stage it again after correcting the bill or the readings." style="display:inline">
          <button class="btn btn-ghost">Discard preview</button>
        </form>`)}`),
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

  r.post('/utilities/rubs/config', requirePerm('utilities:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const b = rq.body || {};
    const prop = ownProp(ctx, b.property_id);
    if (!prop) return notFound();
    const service = String(b.service || '');
    const money = (raw: unknown, what: string): number => {
      const t = String(raw ?? '').trim();
      if (!t) return 0;
      try { return parseUsd(t); } catch { throw new Error(`${what} is not a valid amount.`); }
    };
    try {
      saveRubsConfig(ctx, {
        propertyId: prop.id, service, method: String(b.method || ''),
        commonDeductPct: String(b.common_deduct_pct ?? '').trim() === '' ? 0 : Number(b.common_deduct_pct),
        adminFeeCents: money(b.admin_fee, 'The billing fee'), flatFeeCents: money(b.flat_fee, 'The flat amount'),
        active: !!b.active,
      });
    } catch (e) {
      return redirect(`/utilities/rubs?property=${prop.id}&edit=${encodeURIComponent(service)}`, (e as Error).message, 'err');
    }
    return redirect(`/utilities/rubs?property=${prop.id}`, `Saved how ${service} is split at ${prop.name}.`);
  });

  r.post('/utilities/rubs/stage', requirePerm('utilities:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const b = rq.body || {};
    const prop = ownProp(ctx, b.property_id);
    if (!prop) return notFound();
    const service = String(b.service || '');
    const month = String(b.usage_month || '');
    const back = `/utilities/rubs?property=${prop.id}`;
    if (!(SERVICES as readonly string[]).includes(service) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return redirect(back, 'Choose a utility and a usage month.', 'err');
    const existing = q1<any>('SELECT id, status FROM rubs_runs WHERE org_id=? AND property_id=? AND service=? AND usage_month=?', ctx.orgId, prop.id, service, month);
    if (existing) {
      return redirect(`/utilities/rubs/${existing.id}`, existing.status === 'posted'
        ? `${fmtMonth(month)} ${service} has already been posted to resident ledgers.`
        : `${fmtMonth(month)} ${service} is already staged. Discard this preview first if the bill or readings have changed.`, 'err');
    }
    try {
      const runId = saveRubsRun(ctx, prop.id, service, month);
      audit(ctx, 'rubs_run', runId, 'stage', null, { service, usageMonth: month });
      return redirect(`/utilities/rubs/${runId}`, 'Shares worked out. Check each home below — nothing is charged until you post.');
    } catch (e) {
      const msg = (e as Error).message;
      return redirect(back, /provider invoice/.test(msg) ? `Enter the ${service} provider bill for ${fmtMonth(month)} first — there is nothing to divide yet.` : msg, 'err');
    }
  });

  r.post('/utilities/rubs/:id/discard', requirePerm('utilities:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const runRow = q1<any>('SELECT id, property_id FROM rubs_runs WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!runRow || !ownProp(ctx, runRow.property_id)) return notFound();
    try {
      discardRubsRun(ctx, runRow.id);
    } catch (e) {
      return redirect(`/utilities/rubs/${runRow.id}`, (e as Error).message, 'err');
    }
    return redirect(`/utilities/rubs?property=${runRow.property_id}`, 'Preview discarded — nothing was charged.');
  });

  r.post('/utilities/rubs/:id/post', requirePerm('utilities:bill'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const owned = q1<any>('SELECT property_id FROM rubs_runs WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!owned || !ownProp(ctx, owned.property_id)) return notFound();
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
    if (!props.length) return noProperties(rq, 'Vacant-unit cost recovery', '/utilities');
    const propId = ownProp(ctx, rq.query.get('property'))?.id || props[0]!.id;
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
