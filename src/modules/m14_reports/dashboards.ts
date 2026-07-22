import { q, q1, val, j, js, insert, run } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, addMonths, monthKey, fmtMonth } from '../../lib/dates.ts';
import { usd } from '../../lib/money.ts';
import { html, type Child } from '../../lib/html.ts';
import type { Ctx } from '../../lib/auth.ts';
import { card, kpis } from '../../ui/ui.ts';
import { lines as lineChart, bars, funnel as funnelChart } from '../../lib/charts.ts';
import { computeDayMetrics, snapshotSeries } from './snapshots.ts';
import { agingRows } from '../m8_receivables/service.ts';
import { receivablesStats } from '../m8_receivables/payments.ts';
import { funnelStats } from '../m3_crm/service.ts';
import { t12 } from '../m9_accounting/statements.ts';

/** M14.4 dashboards: a widget library (KPI tile / trend / bar / table /
 * funnel) with role-appropriate defaults and user-customizable layouts. */

export interface Widget {
  key: string;
  name: string;
  kind: 'kpi' | 'trend' | 'bar' | 'table' | 'funnel';
  render: (ctx: Ctx) => Child;
}

function scopedProps(ctx: Ctx): { id: string; name: string }[] {
  if (ctx.currentPropertyId) return q<any>('SELECT id, name FROM properties WHERE id=?', ctx.currentPropertyId);
  if (ctx.allProperties) return q<any>('SELECT id, name FROM properties WHERE org_id=? ORDER BY name', ctx.orgId);
  if (!ctx.propertyIds.length) return [];
  return q<any>(`SELECT id, name FROM properties WHERE id IN (${ctx.propertyIds.map(() => '?').join(',')}) ORDER BY name`, ...ctx.propertyIds);
}

export const WIDGETS: Widget[] = [
  {
    key: 'occupancy_kpi',
    name: 'Occupancy & exposure (KPI)',
    kind: 'kpi',
    render(ctx) {
      const props = scopedProps(ctx);
      const ms = props.map((p) => computeDayMetrics(ctx, p.id, ctx.businessDate));
      const occ = ms.reduce((s, m) => s + m.occupied, 0);
      const rentable = ms.reduce((s, m) => s + m.rentable, 0) || 1;
      const vacantNotice = ms.reduce((s, m) => s + m.vacant + m.notice, 0);
      return kpis([
        { label: 'Physical occupancy', value: `${Math.round((occ / rentable) * 1000) / 10}%`, sub: `${occ}/${rentable} units`, href: '/units', tone: occ / rentable >= 0.93 ? 'ok' : 'warn' },
        { label: 'Exposure', value: `${Math.round((vacantNotice / rentable) * 1000) / 10}%`, sub: 'vacant + notice', href: '/reports/availability_exposure' },
        { label: 'Open work orders', value: String(ms.reduce((s, m) => s + m.open_wos, 0)), href: '/workorders' },
      ]);
    },
  },
  {
    key: 'delinquency_kpi',
    name: 'Delinquency (KPI)',
    kind: 'kpi',
    render(ctx) {
      const aging = agingRows(ctx, { propertyId: ctx.currentPropertyId });
      const total = aging.reduce((s, a) => s + a.balance, 0);
      const d60 = aging.reduce((s, a) => s + a.d61_90 + a.d90p, 0);
      return kpis([
        { label: 'Delinquent', value: usd(total), sub: `${aging.length} households`, tone: total ? 'bad' : 'ok', href: '/delinquency' },
        { label: '60+ days', value: usd(d60), tone: d60 ? 'warn' : 'ok', href: '/delinquency?bucket=61_90' },
        { label: 'Aged report', value: 'open →', href: '/reports/delinquency_aged' },
      ]);
    },
  },
  {
    key: 'collections_trend',
    name: 'Collection rate (trend)',
    kind: 'trend',
    render(ctx) {
      const months: string[] = [];
      for (let i = 11; i >= 0; i--) months.push(monthKey(addMonths(ctx.businessDate, -i)));
      const pts = months.map((mk) => receivablesStats(ctx, mk, ctx.currentPropertyId).collectionRate);
      return card('Collection rate — 12 months', lineChart(months.map((m) => m.slice(5)), [{ name: 'Collection %', points: pts, tone: 'accent' }]));
    },
  },
  {
    key: 'noi_trend',
    name: 'NOI (trend)',
    kind: 'trend',
    render(ctx) {
      const m = t12(ctx, { propertyId: ctx.currentPropertyId, to: ctx.businessDate, basis: 'accrual' });
      return card('NOI — trailing 12 (accrual)', lineChart(
        m.months.map((mk) => fmtMonth(mk).slice(0, 3)),
        [
          { name: 'Income', points: m.totals.income, tone: 'ok' },
          { name: 'Expenses', points: m.totals.expenses, tone: 'warn' },
          { name: 'NOI', points: m.totals.noi, tone: 'accent' },
        ],
        { money: true, height: 200 },
      ));
    },
  },
  {
    key: 'exposure_bar',
    name: 'Exposure by property (bar)',
    kind: 'bar',
    render(ctx) {
      const props = scopedProps(ctx);
      return card('Exposure by property', bars(props.map((p) => {
        const m = computeDayMetrics(ctx, p.id, ctx.businessDate);
        return { label: p.name, value: m.exposure_pct, tone: m.exposure_pct > 10 ? 'bad' : m.exposure_pct > 7 ? 'warn' : 'ok', href: `/properties/${p.id}` };
      })));
    },
  },
  {
    key: 'occupancy_trend_chart',
    name: 'Occupancy (trend)',
    kind: 'trend',
    render(ctx) {
      const props = scopedProps(ctx);
      const first = props[0];
      if (!first) return card('Occupancy trend', html`<p class="muted">No properties in scope.</p>`);
      const series = snapshotSeries(ctx, first.id, 14);
      return card(`Occupancy trend — ${first.name}`, lineChart(
        series.map((s) => fmtMonth(monthKey(s.date)).slice(0, 3)),
        [
          { name: 'Occupancy %', points: series.map((s) => s.m.occupancy_pct), tone: 'accent' },
          { name: 'Exposure %', points: series.map((s) => s.m.exposure_pct), tone: 'warn' },
        ],
        { height: 190 },
      ));
    },
  },
  {
    key: 'leasing_funnel',
    name: 'Leasing funnel (90 days)',
    kind: 'funnel',
    render(ctx) {
      const f = funnelStats(ctx, addMonths(ctx.businessDate, -3), ctx.currentPropertyId);
      return card('Leasing funnel — trailing 90 days', funnelChart([
        { label: 'Inquiries', value: f.inquiries },
        { label: 'Toured', value: f.toured },
        { label: 'Applied', value: f.applied },
        { label: 'Leased', value: f.leased },
      ]));
    },
  },
  {
    key: 'expirations_bar',
    name: 'Lease expirations (bar)',
    kind: 'bar',
    render(ctx) {
      const months: string[] = [];
      for (let i = 0; i < 6; i++) months.push(monthKey(addMonths(ctx.businessDate, i)));
      const pf = ctx.currentPropertyId ? ' AND property_id=?' : '';
      const params = ctx.currentPropertyId ? [ctx.currentPropertyId] : [];
      return card('Expirations — next 6 months', bars(months.map((mk) => ({
        label: fmtMonth(mk),
        value: val<number>(
          `SELECT COUNT(*) FROM leases WHERE org_id=? AND status IN ('active','notice') AND substr(end_date,1,7)=?${pf}`,
          ctx.orgId, mk, ...params,
        ) || 0,
        href: '/reports/lease_expirations',
      }))));
    },
  },
  {
    key: 'wo_sla_table',
    name: 'Oldest open work orders (table)',
    kind: 'table',
    render(ctx) {
      const pf = ctx.currentPropertyId ? ' AND wo.property_id=?' : '';
      const params = ctx.currentPropertyId ? [ctx.currentPropertyId] : [];
      const rows = q<any>(
        `SELECT wo.id, wo.summary, wo.priority, wo.created_date, u.unit_number FROM work_orders wo
         LEFT JOIN units u ON u.id=wo.unit_id
         WHERE wo.org_id=?${pf} AND wo.status NOT IN ('completed','canceled') ORDER BY wo.created_date LIMIT 8`,
        ctx.orgId, ...params,
      );
      return card('Oldest open work orders', html`<table class="tbl"><tbody>
        ${rows.map((wo) => html`<tr data-href="/workorders/${wo.id}" tabindex="0">
          <td>${wo.unit_number || '—'}</td><td>${wo.summary.slice(0, 48)}</td>
          <td><span class="badge ${wo.priority === 'emergency' ? 'bad' : wo.priority === 'high' ? 'warn' : ''}">${wo.priority}</span></td>
          <td class="num">${wo.created_date}</td></tr>`)}
      </tbody></table>`);
    },
  },
  {
    key: 'pricing_kpi',
    name: 'Pricing queue (KPI)',
    kind: 'kpi',
    render(ctx) {
      const pend = q<any>(
        `SELECT recommended_rent_cents - current_rent_cents AS d FROM price_recommendations WHERE org_id=? AND status='pending' AND term_months=12`,
        ctx.orgId,
      );
      return kpis([
        { label: 'Pricing recs awaiting review', value: String(pend.length), tone: pend.length ? 'warn' : 'ok', href: '/pricing' },
        { label: 'Net move if all accepted', value: usd(pend.reduce((s, x) => s + x.d, 0)), href: '/pricing' },
      ]);
    },
  },
  {
    key: 'inbox_kpi',
    name: 'Inbox (KPI)',
    kind: 'kpi',
    render(ctx) {
      const needs = val<number>(`SELECT COUNT(*) FROM threads WHERE org_id=? AND needs_reply=1 AND status != 'closed'`, ctx.orgId) || 0;
      const mine = val<number>(`SELECT COUNT(*) FROM threads WHERE org_id=? AND assigned_to=? AND status='open'`, ctx.orgId, ctx.userId) || 0;
      return kpis([
        { label: 'Conversations needing reply', value: String(needs), tone: needs ? 'warn' : 'ok', href: '/inbox?view=needs_reply' },
        { label: 'Assigned to me', value: String(mine), href: '/inbox?view=mine' },
      ]);
    },
  },
  {
    key: 'close_kpi',
    name: 'Month-end close (KPI)',
    kind: 'kpi',
    render(ctx) {
      const lastMonth = monthKey(addMonths(ctx.businessDate, -1));
      const closed = val<number>(`SELECT COUNT(*) FROM accounting_periods WHERE org_id=? AND period_key=? AND status='closed'`, ctx.orgId, lastMonth) || 0;
      const props = val<number>('SELECT COUNT(*) FROM properties WHERE org_id=?', ctx.orgId) || 0;
      const openRecons = val<number>(`SELECT COUNT(*) FROM bank_recons WHERE org_id=? AND status != 'completed'`, ctx.orgId) || 0;
      return kpis([
        { label: `${fmtMonth(lastMonth)} close`, value: `${closed}/${props} properties`, tone: closed === props ? 'ok' : 'warn', href: '/periods' },
        { label: 'Open reconciliations', value: String(openRecons), href: '/banking', tone: openRecons ? 'warn' : 'ok' },
        { label: 'Close status report', value: 'open →', href: '/reports/close_status' },
      ]);
    },
  },
];

export function widget(key: string): Widget | undefined {
  return WIDGETS.find((w) => w.key === key);
}

/** role-appropriate default layouts (M14.4) */
export function defaultLayout(ctx: Ctx): string[] {
  const roles = new Set(ctx.roles);
  if (roles.has('ACCOUNTANT')) return ['close_kpi', 'collections_trend', 'delinquency_kpi', 'noi_trend'];
  if (roles.has('MAINTENANCE_SUPERVISOR') || roles.has('MAINTENANCE_TECH')) return ['wo_sla_table', 'occupancy_kpi'];
  if (roles.has('LEASING_AGENT') || roles.has('MARKETING_MANAGER')) return ['leasing_funnel', 'expirations_bar', 'occupancy_kpi'];
  if (roles.has('PROPERTY_MANAGER') || roles.has('ASSISTANT_MANAGER')) {
    return ['occupancy_kpi', 'delinquency_kpi', 'expirations_bar', 'wo_sla_table', 'inbox_kpi', 'leasing_funnel'];
  }
  // org admin / regional / platform: the exec portfolio view
  return ['occupancy_kpi', 'noi_trend', 'exposure_bar', 'delinquency_kpi', 'collections_trend', 'pricing_kpi'];
}

export function userLayout(ctx: Ctx): { layout: string[]; customized: boolean } {
  const row = q1<any>('SELECT layout FROM user_dashboards WHERE user_id=?', ctx.userId);
  if (!row) return { layout: defaultLayout(ctx), customized: false };
  const layout = j<string[]>(row.layout, []).filter((k) => widget(k));
  return { layout, customized: true };
}

export function saveLayout(ctx: Ctx, layout: string[]): void {
  const existing = q1<any>('SELECT id FROM user_dashboards WHERE user_id=?', ctx.userId);
  if (existing) run('UPDATE user_dashboards SET layout=?, updated_at=? WHERE id=?', js(layout), nowIso(), existing.id);
  else insert('user_dashboards', { id: id('udb'), org_id: ctx.orgId, user_id: ctx.userId, layout: js(layout), updated_at: nowIso() });
}

export function resetLayout(ctx: Ctx): void {
  run('DELETE FROM user_dashboards WHERE user_id=?', ctx.userId);
}
