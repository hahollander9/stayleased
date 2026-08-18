import { html, raw, when, join } from '../../lib/html.ts';
import { redirect, notFound, badRequest, type Router, type Rq } from '../../lib/http.ts';
import { requirePerm, propFilter, canAccessProperty, can, type Ctx } from '../../lib/auth.ts';
import { q, q1, val, run, insert, update } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, fmtDate, addDays, diffDays } from '../../lib/dates.ts';
import { usd } from '../../lib/money.ts';
import { v } from '../../lib/validate.ts';
import { audit } from '../../lib/audit.ts';
import { putFile } from '../../lib/files.ts';
import {
  shell, card, tbl, kpis, dl, tabs, statusBadge, field, input, select, textarea, moneyInput,
  registerNav, registerSearch, pager, emptyState, historyPanel, checkbox,
} from '../../ui/ui.ts';
// (historyPanel imported above)
import { bars, donut, lines as lineChart } from '../../lib/charts.ts';
import {
  WO_TRANSITIONS, SLA_HOURS, transitionWo, triageWo, assignWo, woEvent, logMaterial, logLabor, woCost,
  TURN_STAGES, createTurn, advanceTurnTask, turnCost, INSPECTION_TEMPLATES, createInspection, postInspectionDamages,
  facilitiesStats, notifyAssignedTech, notifyTechsOfBoard,
  inviteBid, recordBid, declineBid, awardBid, bidsFor, type BidRow,
} from './service.ts';
import { registerDashboardExtras } from '../m2_portfolio/pages.ts';

registerNav('Operations', { href: '/workorders', label: 'Work orders', perm: 'workorders:view', match: ['/workorders'] });
// "My day" is one person's own queue, so it belongs to the people who work
// that queue. An admin or accountant holds workorders:work through a wildcard
// and was shown a permanently empty page in their Operations menu; maintenance
// staff see it, everyone else sees the dispatch board instead.
registerNav('Operations', {
  href: '/myday', label: 'My day', perm: 'workorders:work',
  show: (ctx) => ctx.roles.some((r) => r === 'MAINTENANCE_TECH' || r === 'MAINTENANCE_SUPERVISOR'),
});
registerNav('Operations', { href: '/dispatch', label: 'Dispatch board', perm: 'workorders:assign' });
registerNav('Operations', { href: '/turns', label: 'Turn board', perm: 'turns:manage', match: ['/turns'] });
registerNav('Operations', { href: '/inspections', label: 'Inspections', perm: 'inspections:manage', match: ['/inspections'] });
registerNav('Operations', { href: '/pm', label: 'Preventive maintenance', perm: 'pm:manage' });
registerNav('Operations', { href: '/inventory', label: 'Inventory', perm: 'inventory:manage' });
registerNav('Operations', { href: '/facilities', label: 'Facilities analytics', perm: 'workorders:view' });
registerNav('Operations', { href: '/vendors', label: 'Vendors', perm: 'vendors:view', match: ['/vendors'] });

registerSearch((ctx, query) => {
  const like = `%${query}%`;
  const hits: { kind: string; label: string; sub: string; href: string }[] = [];
  if (ctx.perms.has('workorders:view')) {
    const pf = propFilter(ctx, 'w.property_id');
    hits.push(...q<any>(
      `SELECT w.id, w.summary, w.status, u.unit_number FROM work_orders w LEFT JOIN units u ON u.id=w.unit_id
       WHERE w.org_id=? AND (w.summary LIKE ? OR w.id LIKE ?)${pf.sql} ORDER BY w.created_at DESC LIMIT 5`,
      ctx.orgId, like, like, ...pf.params,
    ).map((w) => ({ kind: 'workorder', label: w.summary, sub: `${w.unit_number || 'property'} · ${w.status}`, href: `/workorders/${w.id}` })));
  }
  // Contractors were unreachable from search — typing a vendor's name found
  // nothing, which is the one thing you want when a plumber is on the phone.
  if (ctx.perms.has('vendors:view')) {
    hits.push(...q<any>(
      `SELECT id, name, category, phone FROM vendors WHERE org_id=? AND active=1 AND name LIKE ? ORDER BY name LIMIT 4`,
      ctx.orgId, like,
    ).map((x) => ({ kind: 'vendor', label: x.name, sub: `${String(x.category).replaceAll('_', ' ')}${x.phone ? ` · ${x.phone}` : ''}`, href: `/vendors/${x.id}` })));
  }
  return hits;
});

/** Operations on the dashboard. The facilities analytics page held the numbers
 * that describe how maintenance is actually running — SLA compliance, how long
 * jobs take, what they cost per unit, how old the open queue is — and a
 * separate page is a page nobody opens on a normal morning. The health of the
 * operation belongs in the overview the operator already looks at; the
 * analytics page keeps the deeper cuts (per-tech productivity, category
 * breakdown, turn times) that reward going looking. */
registerDashboardExtras((ctx, propertyId) => {
  const stats = facilitiesStats(ctx, propertyId);
  const propSql = propertyId ? ' AND property_id=?' : '';
  const p = propertyId ? [propertyId] : [];
  const aging = q<any>(
    `SELECT CASE WHEN julianday(?) - julianday(created_date) <= 3 THEN '0-3d'
                 WHEN julianday(?) - julianday(created_date) <= 7 THEN '4-7d'
                 WHEN julianday(?) - julianday(created_date) <= 14 THEN '8-14d' ELSE '15d+' END AS bucket,
       COUNT(*) n FROM work_orders WHERE org_id=? AND status NOT IN ('completed','canceled')${propSql} GROUP BY bucket`,
    ctx.businessDate, ctx.businessDate, ctx.businessDate, ctx.orgId, ...p,
  );
  const AGE_ORDER = ['0-3d', '4-7d', '8-14d', '15d+'];
  const byAge = new Map(aging.map((a) => [a.bucket as string, a.n as number]));
  const byCategory = q<any>(
    `SELECT category, COUNT(*) n FROM work_orders WHERE org_id=? AND created_date>=?${propSql} GROUP BY category ORDER BY n DESC LIMIT 6`,
    ctx.orgId, addDays(ctx.businessDate, -90), ...p,
  );
  const panels = stats.open || byCategory.length
    ? html`<div class="grid cols-2">
        ${card('Open work order aging', html`${bars(AGE_ORDER.filter((b) => byAge.get(b)).map((b) => ({
          label: b, value: byAge.get(b)!, tone: b === '15d+' ? 'bad' : b === '8-14d' ? 'warn' : 'info',
        })))}<div class="muted small" style="margin-top:6px"><a href="/facilities">Facilities analytics →</a> for tech productivity and turn times.</div>`)}
        ${card('Maintenance requests · last 90 days', bars(byCategory.map((c) => ({ label: String(c.category).replaceAll('_', ' '), value: c.n }))))}
      </div>`
    : null;
  return {
    kpis: [
      { label: 'Open work orders', value: stats.open, sub: stats.emergencies ? `${stats.emergencies} EMERGENCY` : `${stats.overSla} past SLA`, tone: stats.emergencies ? 'bad' : stats.overSla > 3 ? 'warn' : undefined, href: '/workorders' },
      { label: 'SLA compliance', value: `${stats.slaCompliance30d}%`, sub: 'completed on time, 30d', tone: stats.slaCompliance30d >= 90 ? 'ok' : 'warn', href: '/facilities' },
      { label: 'Avg completion', value: `${stats.avgDaysToComplete}d`, sub: stats.avgRating ? `${stats.avgRating}★ resident rating` : 'no ratings yet', href: '/facilities' },
      { label: 'Maintenance / unit', value: usd(stats.costPerUnit30d), sub: 'last 30 days', href: '/facilities' },
    ],
    panels,
  };
});

const WO_CATEGORIES = ['plumbing', 'electrical', 'hvac', 'appliance', 'doors_locks', 'pest', 'grounds', 'safety', 'turn', 'pm', 'other'];
const PRIORITIES = ['emergency', 'high', 'normal', 'low'];

function techs(ctx: Ctx): { id: string; name: string }[] {
  return q<any>(
    `SELECT DISTINCT u.id, u.name FROM users u JOIN role_assignments ra ON ra.user_id=u.id
     WHERE u.org_id=? AND u.active=1 AND ra.role IN ('MAINTENANCE_TECH','MAINTENANCE_SUPERVISOR') ORDER BY u.name`,
    ctx.orgId,
  );
}

export function routes(r: Router): void {
  // ---------- work orders list ----------
  r.get('/workorders', requirePerm('workorders:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const status = rq.query.get('status') || 'open';
    const priority = rq.query.get('priority') || '';
    const category = rq.query.get('category') || '';
    const assignee = rq.query.get('assignee') || '';
    const pf = propFilter(ctx, 'w.property_id');
    const params: unknown[] = [ctx.orgId, ...pf.params];
    let where = `w.org_id=?${pf.sql}`;
    if (status === 'open') where += ` AND w.status NOT IN ('completed','canceled')`;
    else if (status) { where += ' AND w.status=?'; params.push(status); }
    if (priority) { where += ' AND w.priority=?'; params.push(priority); }
    if (category) { where += ' AND w.category=?'; params.push(category); }
    if (assignee) { where += ' AND w.assigned_to_user_id=?'; params.push(assignee); }
    const total = val<number>(`SELECT COUNT(*) FROM work_orders w WHERE ${where}`, ...params);
    const page = Math.max(1, parseInt(rq.query.get('page') || '1', 10) || 1);
    const rows = q<any>(
      `SELECT w.*, u.unit_number, p.name AS prop_name,
        (SELECT name FROM users x WHERE x.id=w.assigned_to_user_id) AS tech,
        (SELECT name FROM vendors vd WHERE vd.id=w.vendor_id) AS vendor
       FROM work_orders w LEFT JOIN units u ON u.id=w.unit_id JOIN properties p ON p.id=w.property_id
       WHERE ${where}
       ORDER BY CASE w.priority WHEN 'emergency' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, w.created_date
       LIMIT 50 OFFSET ?`,
      ...params, (page - 1) * 50,
    );
    const stats = facilitiesStats(ctx, ctx.currentPropertyId);
    return shell(rq, {
      title: 'Work orders',
      active: '/workorders',
      actions: html`<a class="btn" href="/workorders/new">New work order</a>`,
      content: html`
        ${kpis([
          { label: 'Open', value: stats.open, href: '/workorders' },
          { label: 'Emergency', value: stats.emergencies, tone: stats.emergencies ? 'bad' : undefined },
          { label: 'Past SLA', value: stats.overSla, tone: stats.overSla ? 'warn' : 'ok' },
          { label: 'SLA compliance (30d)', value: `${stats.slaCompliance30d}%`, tone: stats.slaCompliance30d >= 90 ? 'ok' : 'warn' },
          { label: 'Avg days to complete', value: stats.avgDaysToComplete },
          { label: 'Resident rating', value: stats.avgRating ? `${stats.avgRating}★` : '—' },
        ])}
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Status', select('status', [['open', 'All open'], ...Object.keys(WO_TRANSITIONS).map((s): [string, string] => [s, s.replaceAll('_', ' ')])], status))}
          ${field('Priority', select('priority', PRIORITIES.map((x): [string, string] => [x, x]), priority, { blank: 'Any' }))}
          ${field('Category', select('category', WO_CATEGORIES.map((x): [string, string] => [x, x.replaceAll('_', ' ')]), category, { blank: 'Any' }))}
          ${field('Assignee', select('assignee', techs(ctx).map((t): [string, string] => [t.id, t.name]), assignee, { blank: 'Anyone' }))}
        </form>
        ${card(null, html`${tbl(
          [{ label: '#' }, { label: 'Summary' }, { label: 'Unit' }, { label: 'Priority' }, { label: 'Status' }, { label: 'Assigned' }, { label: 'SLA' }, { label: 'Age', num: true }],
          rows.map((w) => {
            const overdue = w.sla_due && w.sla_due < ctx.businessDate && !['completed', 'canceled'].includes(w.status);
            return {
              href: `/workorders/${w.id}`,
              cells: [
                html`<span class="mono small">${w.id.slice(-6)}</span>`,
                html`<b>${w.summary}</b><span class="sub">${w.prop_name} · ${w.category.replaceAll('_', ' ')}</span>`,
                w.unit_number || '—',
                statusBadge(w.priority),
                statusBadge(w.status),
                w.tech || w.vendor || html`<span class="muted">—</span>`,
                w.sla_due ? html`<span class="${overdue ? 'neg' : ''}">${fmtDate(w.sla_due)}${overdue ? ' ⚠' : ''}</span>` : '—',
                `${diffDays(ctx.businessDate, w.created_date)}d`,
              ],
            };
          }),
          { empty: 'No work orders match.' },
        )}${pager(rq, total)}`, { flush: true })}`,
    });
  });

  // ---------- new WO (staff intake) ----------
  r.get('/workorders/new', requirePerm('workorders:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const pf = propFilter(ctx, 'property_id');
    const units = q<any>(
      `SELECT u.id, u.unit_number, p.name AS prop FROM units u JOIN properties p ON p.id=u.property_id WHERE u.org_id=?${pf.sql.replaceAll('property_id', 'u.property_id')} ORDER BY p.name, u.unit_number`,
      ctx.orgId, ...pf.params,
    );
    return shell(rq, {
      title: 'New work order',
      active: '/workorders',
      crumbs: [['Work orders', '/workorders']],
      content: card(null, html`<form method="post" action="/workorders/new">
        <div class="form-grid">
          ${field('Unit (blank = property/common area)', select('unit_id', units.map((u): [string, string] => [u.id, `${u.prop} · ${u.unit_number}`]), undefined, { blank: 'Common area / property-wide' }))}
          ${field('Category', select('category', WO_CATEGORIES.map((x): [string, string] => [x, x.replaceAll('_', ' ')]), 'plumbing'))}
          ${field('Priority', select('priority', PRIORITIES.map((x): [string, string] => [x, x]), 'normal'))}
          ${field('Summary', input('summary', { required: true }))}
        </div>
        ${field('Details', textarea('description', { rows: 3 }))}
        <button class="btn">Create work order</button>
      </form>`),
    });
  });

  r.post('/workorders/new', requirePerm('workorders:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const unitId = String(rq.body.unit_id || '');
    const unit = unitId ? q1<any>('SELECT * FROM units WHERE id=? AND org_id=?', unitId, ctx.orgId) : null;
    const propertyId = unit?.property_id || ctx.currentPropertyId || q1<any>('SELECT id FROM properties WHERE org_id=? LIMIT 1', ctx.orgId)?.id;
    if (!propertyId) return badRequest('no property');
    const lease = unit ? q1<any>(`SELECT * FROM leases WHERE unit_id=? AND status IN ('active','month_to_month','notice') LIMIT 1`, unit.id) : null;
    // validate enums + required fields at the boundary (was: arbitrary strings stored verbatim)
    const priority = String(rq.body.priority || 'normal');
    if (!(priority in SLA_HOURS)) return redirect('/workorders/new', 'Invalid priority.', 'err');
    const category = String(rq.body.category || 'other');
    if (!WO_CATEGORIES.includes(category)) return redirect('/workorders/new', 'Invalid category.', 'err');
    const summary = String(rq.body.summary || '').trim();
    if (!summary) return redirect('/workorders/new', 'A summary is required.', 'err');
    const woId = id('wo');
    insert('work_orders', {
      id: woId, org_id: ctx.orgId, property_id: propertyId, unit_id: unit?.id || null,
      lease_id: lease?.id || null, resident_id: null,
      category, priority, status: 'triaged',
      summary, description: rq.body.description || null,
      permission_to_enter: 1, pet_on_premises: 0, source: 'staff',
      sla_hours: SLA_HOURS[priority] ?? 72, sla_due: addDays(ctx.businessDate, Math.ceil((SLA_HOURS[priority] ?? 72) / 24)),
      created_date: ctx.businessDate, created_by: ctx.userId, created_at: nowIso(),
    });
    woEvent(ctx, woId, 'status', 'Created by staff');
    audit(ctx, 'work_order', woId, 'create');
    return redirect(`/workorders/${woId}`, 'Work order created.');
  });

  // ---------- WO detail ----------
  r.get('/workorders/:id', requirePerm('workorders:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const w = q1<any>(
      `SELECT w.*, u.unit_number, p.name AS prop_name, l.household_name,
        (SELECT name FROM users x WHERE x.id=w.assigned_to_user_id) AS tech,
        (SELECT name FROM vendors vd WHERE vd.id=w.vendor_id) AS vendor_name
       FROM work_orders w LEFT JOIN units u ON u.id=w.unit_id JOIN properties p ON p.id=w.property_id
       LEFT JOIN leases l ON l.id=w.lease_id
       WHERE w.id=? AND w.org_id=?`,
      rq.params.id!, ctx.orgId,
    );
    if (!w || !canAccessProperty(ctx, w.property_id)) return notFound('Work order not found');
    const events = q<any>('SELECT * FROM wo_events WHERE work_order_id=? ORDER BY at', w.id);
    const materials = q<any>('SELECT * FROM wo_materials WHERE work_order_id=?', w.id);
    const labor = q<any>('SELECT l.*, (SELECT name FROM users u WHERE u.id=l.user_id) AS who FROM wo_labor l WHERE l.work_order_id=?', w.id);
    const photos = q<any>(`SELECT * FROM files WHERE entity='work_order' AND entity_id=?`, w.id);
    const items = q<any>(`SELECT * FROM inventory_items WHERE org_id=? AND property_id=? AND on_hand>0 ORDER BY name`, ctx.orgId, w.property_id);
    const vendors = q<any>(`SELECT * FROM vendors WHERE org_id=? AND active=1 ORDER BY name`, ctx.orgId);
    const canManage = ctx.perms.has('workorders:manage');
    const canAssign = ctx.perms.has('workorders:assign');
    const next = WO_TRANSITIONS[w.status] || [];
    const cost = woCost(w.id);
    const bidCount = val<number>('SELECT COUNT(*) FROM wo_bids WHERE work_order_id=? AND org_id=?', w.id, ctx.orgId) || 0;

    return shell(rq, {
      title: w.summary,
      active: '/workorders',
      crumbs: [['Work orders', '/workorders']],
      subtitle: html`${statusBadge(w.priority)} ${statusBadge(w.status)} · #${w.id.slice(-6)} · ${w.prop_name}${w.unit_number ? ` · Unit ${w.unit_number}` : ''}${w.sla_due ? html` · SLA ${fmtDate(w.sla_due)}` : ''}`,
      actions: html`<div style="display:flex;gap:6px;flex-wrap:wrap">
        ${when(canAssign && !['completed', 'canceled', 'closed'].includes(w.status), () => html`<a class="btn btn-ghost btn-sm" href="/workorders/${w.id}/bids" title="Invite outside contractors to bid and compare their prices, start dates and track records side by side">Contractor bids${bidCount ? ` (${bidCount})` : ''}</a>`)}
        ${when(can(ctx, 'pos:create') && !['completed', 'canceled', 'closed'].includes(w.status), () => html`<a class="btn btn-ghost btn-sm" href="/purchasing/new?workorder=${w.id}" title="Order parts or services for this job — routes to the approver over the threshold, then flows into AP">Create purchase order</a>`)}
        ${when(canManage, () => next.filter((s) => !['assigned', 'scheduled'].includes(s)).map((s) => html`<form method="post" action="/workorders/${w.id}/transition"><input type="hidden" name="to" value="${s}" /><button class="btn btn-sm ${s === 'completed' ? '' : 'btn-ghost'}">${s.replaceAll('_', ' ')}</button></form>`))}
      </div>`,
      content: html`
        <div class="grid cols-2">
          <div>
            ${card('Details', dl([
              ['Reported', html`${fmtDate(w.created_date)} <span class="muted small">via ${w.source}</span>`],
              ['Category', w.category.replaceAll('_', ' ')],
              ['Household', w.household_name ? html`<a href="/leases/${w.lease_id}">${w.household_name}</a>` : '—'],
              ['Entry permission', w.permission_to_enter ? 'Yes' : 'No'],
              ['Pet on premises', w.pet_on_premises ? 'Yes ⚠' : 'No'],
              ['Preferred times', w.preferred_times || '—'],
              ['Assigned to', w.tech || w.vendor_name || '—'],
              ['Scheduled', w.scheduled_date ? fmtDate(w.scheduled_date) : '—'],
              ['Cost so far', usd(cost)],
              ...(w.rating ? [['Resident rating', `${'★'.repeat(w.rating)} ${w.rating_comment || ''}`] as [any, any]] : []),
            ]))}
            ${when(w.description, () => card('Description', html`<p style="margin:0">${w.description}</p>`))}
            ${when(photos.length, () => card('Photos', html`<div style="display:flex;gap:8px;flex-wrap:wrap">${photos.map((p) => html`<a href="/f/${p.id}" target="_blank"><img src="/f/${p.id}" alt="${p.name}" style="width:100px;height:100px;object-fit:cover;border-radius:8px;border:1px solid var(--line)" /></a>`)}</div>`))}
            ${when(canAssign || canManage, () => card('Triage · assign · schedule', html`
              <form method="post" action="/workorders/${w.id}/triage" class="toolbar">
                ${field('Priority', select('priority', PRIORITIES.map((x): [string, string] => [x, x]), w.priority))}
                ${field('Category', select('category', WO_CATEGORIES.map((x): [string, string] => [x, x.replaceAll('_', ' ')]), w.category))}
                <button class="btn btn-sm btn-ghost">Set</button>
              </form>
              <form method="post" action="/workorders/${w.id}/assign" class="toolbar">
                ${field('Tech', select('user_id', techs(ctx).map((t): [string, string] => [t.id, t.name]), w.assigned_to_user_id || '', { blank: '—' }))}
                ${field('or Vendor', select('vendor_id', vendors.map((x): [string, string] => [x.id, `${x.name}${x.coi_expiry && x.coi_expiry < ctx.businessDate ? ' (COI EXPIRED)' : ''}`]), w.vendor_id || '', { blank: '—' }))}
                ${field('Schedule', input('scheduled_date', { type: 'date', value: w.scheduled_date || addDays(ctx.businessDate, 1) }))}
                <button class="btn btn-sm">Assign</button>
              </form>`))}
          </div>
          <div>
            ${card('Timeline', html`
              <ul class="timeline">${events.map((e) => html`<li class="${e.kind === 'status' ? 'hot' : ''}">
                <div><b>${e.body || e.kind}</b> <span class="muted small">· ${e.actor || ''}</span>${e.visible_to_resident ? '' : html` <span class="badge">internal</span>`}</div>
                <div class="t-when">${fmtDate((e.business_date || e.at).slice(0, 10))}</div>
              </li>`)}</ul>
              ${when(canManage, () => html`<form method="post" action="/workorders/${w.id}/note" class="toolbar">
                ${field('Add note', input('body', { placeholder: 'Parts ordered, ETA Friday…', required: true }))}
                ${checkbox('internal', 'Internal only')}
                <button class="btn btn-sm">Note</button>
              </form>`)}`)}
            ${card('Materials & labor', html`
              ${tbl(
                [{ label: 'Item' }, { label: 'Qty', num: true }, { label: 'Total', num: true }],
                [
                  ...materials.map((m) => ({ cells: [m.description, m.qty, usd(m.total_cents)] as any[] })),
                  ...labor.map((l) => ({ cells: [html`Labor — ${l.who}`, `${l.hours}h`, usd(l.total_cents)] as any[] })),
                ],
                { empty: 'Nothing logged yet.', foot: ['Total', '', usd(cost)] },
              )}
              ${when(canManage || ctx.perms.has('workorders:work'), () => html`
              <form method="post" action="/workorders/${w.id}/material" class="toolbar" style="margin-top:8px">
                ${field('Stock item', select('item_id', items.map((x): [string, string] => [x.id, `${x.name} (${x.on_hand} on hand)`]), undefined, { blank: 'Non-stock / custom' }))}
                ${field('Custom desc', input('description', { placeholder: 'if non-stock' }))}
                ${field('Qty', input('qty', { type: 'number', value: 1, step: '0.5', min: '0.5' }))}
                ${field('Unit cost', moneyInput('unit_cost'))}
                <button class="btn btn-sm btn-ghost">Log material</button>
              </form>
              <form method="post" action="/workorders/${w.id}/labor" class="toolbar">
                ${field('Tech', select('user_id', techs(ctx).map((t): [string, string] => [t.id, t.name]), ctx.userId))}
                ${field('Hours', input('hours', { type: 'number', value: 1, step: '0.25', min: '0.25' }))}
                <button class="btn btn-sm btn-ghost">Log labor</button>
              </form>`)}`)}
          </div>
        </div>`,
    });
  });

  r.post('/workorders/:id/transition', requirePerm('workorders:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    try {
      transitionWo(ctx, rq.params.id!, String(rq.body.to || ''));
    } catch (e) {
      return redirect(`/workorders/${rq.params.id}`, (e as Error).message, 'err');
    }
    return redirect(`/workorders/${rq.params.id}`, 'Status updated.');
  });

  r.post('/workorders/:id/triage', requirePerm('workorders:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    triageWo(ctx, rq.params.id!, { priority: String(rq.body.priority || 'normal'), category: String(rq.body.category || '') || undefined });
    return redirect(`/workorders/${rq.params.id}`, 'Triage saved.');
  });

  r.post('/workorders/:id/assign', requirePerm('workorders:assign'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const userId = rq.body.user_id ? String(rq.body.user_id) : undefined;
    const before = val<string>('SELECT assigned_to_user_id FROM work_orders WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    try {
      assignWo(ctx, rq.params.id!, {
        userId,
        vendorId: rq.body.vendor_id ? String(rq.body.vendor_id) : undefined,
        scheduledDate: rq.body.scheduled_date ? String(rq.body.scheduled_date) : undefined,
      });
    } catch (e) {
      return redirect(`/workorders/${rq.params.id}`, (e as Error).message, 'err');
    }
    if (userId && userId !== before) notifyAssignedTech(ctx, rq.params.id!, userId);
    return redirect(`/workorders/${rq.params.id}`, userId && userId !== before ? 'Assigned — the tech has been notified.' : 'Assigned.');
  });

  r.post('/workorders/:id/note', requirePerm('workorders:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    insert('wo_events', {
      id: id('woe'), org_id: ctx.orgId, work_order_id: rq.params.id!, kind: 'note',
      body: String(rq.body.body || ''), actor: ctx.userName,
      visible_to_resident: rq.body.internal ? 0 : 1, at: nowIso(), business_date: ctx.businessDate,
    });
    return redirect(`/workorders/${rq.params.id}`, 'Note added.');
  });

  r.post('/workorders/:id/material', requirePerm('workorders:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    try {
      logMaterial(ctx, rq.params.id!, {
        itemId: rq.body.item_id ? String(rq.body.item_id) : undefined,
        description: rq.body.description ? String(rq.body.description) : undefined,
        qty: v.number({ min: 0.1 }).parse(rq.body.qty || 1),
        unitCostCents: rq.body.unit_cost ? v.cents().parse(rq.body.unit_cost) : undefined,
      });
    } catch (e) {
      return redirect(`/workorders/${rq.params.id}`, (e as Error).message, 'err');
    }
    return redirect(`/workorders/${rq.params.id}`, 'Material logged.');
  });

  r.post('/workorders/:id/labor', requirePerm('workorders:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    logLabor(ctx, rq.params.id!, {
      userId: String(rq.body.user_id || ctx.userId),
      hours: v.number({ min: 0.25, max: 24 }).parse(rq.body.hours || 1),
    });
    return redirect(`/workorders/${rq.params.id}`, 'Labor logged.');
  });

  // dnd reassign from dispatch board
  r.post('/workorders/reassign', requirePerm('workorders:assign'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const woId = String(rq.body.item_id || '');
    const lane = String(rq.body.lane || '');
    // Scope the work order to this org AND this user's properties before
    // touching it — the lane id arrives from the client and the id does too.
    const wo = q1<any>('SELECT id, property_id, assigned_to_user_id FROM work_orders WHERE id=? AND org_id=?', woId, ctx.orgId);
    if (!wo || !canAccessProperty(ctx, wo.property_id)) return redirect('/dispatch', 'That work order is no longer available.', 'err');
    try {
      if (lane === 'unassigned') {
        run('UPDATE work_orders SET assigned_to_user_id=NULL WHERE id=? AND org_id=?', woId, ctx.orgId);
        woEvent(ctx, woId, 'assign', 'Moved to unassigned');
      } else {
        assignWo(ctx, woId, { userId: lane });
      }
    } catch (e) {
      return redirect('/dispatch', (e as Error).message, 'err');
    }
    // Moving a card is a decision about someone's day; they hear about it from
    // the product rather than from the board they were not looking at. Only on
    // a real change of hands — re-dropping a card in the lane it came from is
    // not news.
    if (lane !== 'unassigned' && lane !== wo.assigned_to_user_id) notifyAssignedTech(ctx, woId, lane);
    return redirect('/dispatch', lane === 'unassigned' ? 'Moved to unassigned.' : 'Reassigned — the tech has been notified.');
  });

  // Broadcast the board to the whole maintenance team.
  r.post('/dispatch/notify', requirePerm('workorders:assign'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const { sent, recipients } = notifyTechsOfBoard(ctx, ctx.currentPropertyId);
    if (!sent) return redirect('/dispatch', 'No active maintenance techs to notify — add someone with a maintenance role first.', 'err');
    audit(ctx, 'dispatch', ctx.businessDate, 'notify_techs', null, { recipients: sent });
    return redirect('/dispatch', `Dispatch sent to ${sent} tech${sent === 1 ? '' : 's'}: ${recipients.join(', ')}.`);
  });

  // ---------- dispatch board ----------
  r.get('/dispatch', requirePerm('workorders:assign'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const pf = propFilter(ctx, 'w.property_id');
    const open = q<any>(
      `SELECT w.*, u.unit_number, p.name AS prop_name FROM work_orders w
       LEFT JOIN units u ON u.id=w.unit_id JOIN properties p ON p.id=w.property_id
       WHERE w.org_id=? AND w.status NOT IN ('completed','canceled') AND w.vendor_id IS NULL${pf.sql}
       ORDER BY CASE w.priority WHEN 'emergency' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, w.created_date`,
      ctx.orgId, ...pf.params,
    );
    const team = techs(ctx);
    const lanes: { key: string; label: string; items: any[] }[] = [
      { key: 'unassigned', label: 'Unassigned', items: open.filter((w) => !w.assigned_to_user_id) },
      ...team.map((t) => ({ key: t.id, label: t.name, items: open.filter((w) => w.assigned_to_user_id === t.id) })),
    ];
    const oldest = open.reduce((n, w) => Math.max(n, diffDays(ctx.businessDate, w.created_date)), 0);

    /** The card's identity line: the number the job is called by, and every
     * date that decides whether it is late — together, on one row. Age is the
     * number a dispatcher actually triages on ("that one's been sitting nine
     * days"), and it was the one number the board did not show. */
    const woCard = (w: any): ReturnType<typeof html> => {
      const age = Math.max(0, diffDays(ctx.businessDate, w.created_date));
      const overdue = w.sla_due && w.sla_due < ctx.businessDate;
      const ageTone = overdue ? 'bad' : age >= 14 ? 'bad' : age >= 7 ? 'warn' : '';
      return html`<a class="bcard" href="/workorders/${w.id}" data-dnd-item="${w.id}">
        <span class="bc-id">
          <span class="mono">#${w.id.slice(-6)}</span>
          <span class="bc-age ${ageTone}" title="Reported ${fmtDate(w.created_date)}">${age}d</span>
          <span class="bc-dates">
            <i title="Reported">↳ ${fmtDate(w.created_date)}</i>
            ${when(w.scheduled_date, () => html`<i title="Scheduled">· sched ${fmtDate(w.scheduled_date)}</i>`)}
            ${when(w.sla_due, () => html`<i class="${overdue ? 'neg' : ''}" title="SLA due">· due ${fmtDate(w.sla_due)}${overdue ? ' ⚠' : ''}</i>`)}
          </span>
        </span>
        <b>${w.summary.slice(0, 44)}</b>
        <span class="sub">${w.unit_number || w.prop_name} · ${statusBadge(w.priority)}</span>
      </a>`;
    };

    return shell(rq, {
      title: 'Dispatch board',
      active: '/dispatch',
      subtitle: `Drag a card onto a tech to reassign. Vendors are dispatched from the work order page.${oldest ? ` · oldest open job ${oldest}d` : ''}`,
      wide: true,
      actions: html`<div style="display:flex;gap:6px;flex-wrap:wrap">
        <form method="post" action="/dispatch/notify" style="margin:0">
          <button class="btn btn-sm btn-ghost" title="Text every active tech the state of the board: what is unassigned, what is an emergency, what is past SLA, and what is on them">Notify all techs (${team.length})</button>
        </form>
      </div>`,
      content: html`
        <form id="dnd-form" method="post" action="/workorders/reassign" style="display:none">
          <input type="hidden" name="item_id" /><input type="hidden" name="lane" />
        </form>
        <div class="board">${lanes.map((lane) => html`<div class="col" data-dnd-lane="${lane.key}">
          <div class="col-head"><span>${lane.label}</span><span class="badge ${lane.items.length > 8 ? 'warn' : ''}">${lane.items.length}</span></div>
          <div class="col-body">${lane.items.slice(0, 30).map(woCard)}${lane.items.length > 30 ? html`<a class="small" href="/workorders?assignee=${lane.key === 'unassigned' ? '' : lane.key}">+ ${lane.items.length - 30} more…</a>` : null}</div>
        </div>`)}</div>`,
    });
  });

  // ---------- outside contractors: bid comparison ----------
  // Not every technician works for the management company. When the job goes
  // out to contractors, the decision is a comparison — price against schedule
  // against track record — and it has to live next to the work order it
  // decides, not in an inbox.
  r.get('/workorders/:id/bids', requirePerm('workorders:assign'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const w = q1<any>(
      `SELECT w.*, u.unit_number, p.name AS prop_name FROM work_orders w
       LEFT JOIN units u ON u.id=w.unit_id JOIN properties p ON p.id=w.property_id WHERE w.id=? AND w.org_id=?`,
      rq.params.id!, ctx.orgId,
    );
    if (!w || !canAccessProperty(ctx, w.property_id)) return notFound('Work order not found');
    const bids = bidsFor(ctx, w.id);
    const invitedIds = new Set(bids.map((b) => b.vendor_id));
    // Same-category vendors first: a plumbing job invites plumbers. Everyone
    // else stays available, because trade categories are a guide, not a rule.
    const candidates = q<any>(
      `SELECT * FROM vendors WHERE org_id=? AND active=1 ORDER BY CASE WHEN category=? THEN 0 ELSE 1 END, name`,
      ctx.orgId, w.category,
    ).filter((x) => !invitedIds.has(x.id));

    const quoted = bids.filter((b) => b.amount_cents !== null && b.status !== 'declined');
    const low = quoted.length ? Math.min(...quoted.map((b) => b.amount_cents!)) : null;
    const high = quoted.length ? Math.max(...quoted.map((b) => b.amount_cents!)) : null;
    const awarded = bids.find((b) => b.status === 'awarded') || null;
    const soonest = quoted.filter((b) => b.can_start_date).sort((a, b) => String(a.can_start_date).localeCompare(String(b.can_start_date)))[0] || null;

    const bidCard = (b: BidRow): ReturnType<typeof html> => {
      const coiExpired = !!b.coi_expiry && b.coi_expiry < ctx.businessDate;
      const isLow = b.amount_cents !== null && b.amount_cents === low && quoted.length > 1;
      const delta = b.amount_cents !== null && low !== null && b.amount_cents > low ? b.amount_cents - low : 0;
      return html`<div class="bid-card ${b.status === 'awarded' ? 'awarded' : ''} ${b.status === 'declined' ? 'declined' : ''}">
        <div class="bid-head">
          <div>
            <a class="bid-vendor" href="/vendors/${b.vendor_id}">${b.vendor_name}</a>
            <span class="bid-cat">${String(b.category).replaceAll('_', ' ')}</span>
          </div>
          ${b.status === 'awarded' ? statusBadge('ok', 'awarded')
            : b.status === 'declined' ? statusBadge(undefined, 'declined')
            : b.status === 'not_awarded' ? statusBadge(undefined, 'not awarded')
            : b.status === 'quoted' ? statusBadge('info', 'quoted') : statusBadge('warn', 'awaiting bid')}
        </div>
        ${b.amount_cents === null
          ? html`<div class="bid-amount none">${b.status === 'declined' ? (b.decline_reason || 'Declined to bid') : 'No price yet'}</div>`
          : html`<div class="bid-amount">${usd(b.amount_cents)}${when(isLow, () => html`<span class="badge ok">lowest</span>`)}${when(delta > 0, () => html`<span class="bid-delta">+${usd(delta)} vs lowest</span>`)}</div>`}
        <dl class="bid-facts">
          <div><dt>Labor</dt><dd>${b.labor_cents === null ? '—' : usd(b.labor_cents)}</dd></div>
          <div><dt>Materials</dt><dd>${b.materials_cents === null ? '—' : usd(b.materials_cents)}</dd></div>
          <div><dt>Can start</dt><dd>${b.can_start_date ? fmtDate(b.can_start_date) : '—'}</dd></div>
          <div><dt>Duration</dt><dd>${b.days_to_complete ? `${b.days_to_complete}d` : '—'}</dd></div>
          <div><dt>Warranty</dt><dd>${b.warranty_months ? `${b.warranty_months} mo` : '—'}</dd></div>
          <div><dt>Insurance</dt><dd>${b.coi_expiry
            ? html`<span class="${coiExpired ? 'neg' : ''}">${coiExpired ? 'EXPIRED' : fmtDate(b.coi_expiry)}</span>`
            : html`<span class="neg">missing</span>`}</dd></div>
        </dl>
        <div class="bid-track">
          ${b.jobs_done} completed job${b.jobs_done === 1 ? '' : 's'}
          ${b.avg_rating ? html` · ${Math.round(b.avg_rating * 10) / 10}★` : html` · <span class="muted">unrated</span>`}
          ${b.avg_days ? html` · avg ${Math.round(b.avg_days)}d to close` : null}
        </div>
        ${when(b.scope, () => html`<p class="bid-scope">${b.scope}</p>`)}
        ${when(b.notes, () => html`<p class="bid-scope muted">${b.notes}</p>`)}
        ${when(!awarded && b.status !== 'declined', () => html`
          <details class="bid-form"><summary>${b.amount_cents === null ? 'Record their bid' : 'Update bid'}</summary>
            <form method="post" action="/workorders/${w.id}/bids/${b.id}/quote" class="form-grid">
              ${field('Total price', moneyInput('amount', b.amount_cents ?? 0, { required: true }))}
              ${field('Labor', moneyInput('labor', b.labor_cents ?? 0))}
              ${field('Materials', moneyInput('materials', b.materials_cents ?? 0))}
              ${field('Can start', input('can_start_date', { type: 'date', value: b.can_start_date || addDays(ctx.businessDate, 2) }))}
              ${field('Days to complete', input('days_to_complete', { type: 'number', min: '1', value: b.days_to_complete ?? 1 }))}
              ${field('Warranty (months)', input('warranty_months', { type: 'number', min: '0', value: b.warranty_months ?? 0 }))}
              ${field('Scope quoted', input('scope', { value: b.scope || '', placeholder: 'Replace 40-gal water heater, haul away old unit' }))}
              ${field('Notes', input('notes', { value: b.notes || '', placeholder: 'Price holds 30 days' }))}
              <div class="field"><label>&nbsp;</label><button class="btn btn-sm">Save bid</button></div>
            </form>
            <form method="post" action="/workorders/${w.id}/bids/${b.id}/decline" class="toolbar">
              ${field('Or mark declined', input('reason', { placeholder: 'Too busy this month' }))}
              <button class="btn btn-sm btn-ghost">Declined</button>
            </form>
          </details>`)}
        ${when(!awarded && b.amount_cents !== null && b.status !== 'declined', () => html`
          <form method="post" action="/workorders/${w.id}/bids/${b.id}/award" class="toolbar bid-award">
            ${field('Schedule', input('scheduled_date', { type: 'date', value: b.can_start_date || addDays(ctx.businessDate, 2) }))}
            <button class="btn btn-sm"${coiExpired ? raw(' disabled title="Insurance certificate expired — renew the COI before awarding"') : null}>Award &amp; dispatch</button>
          </form>`)}
      </div>`;
    };

    return shell(rq, {
      title: `Bids · ${w.summary}`,
      active: '/workorders',
      crumbs: [['Work orders', '/workorders'], [w.summary, `/workorders/${w.id}`]],
      subtitle: html`${statusBadge(w.priority)} ${statusBadge(w.status)} · #${w.id.slice(-6)} · ${w.prop_name}${w.unit_number ? ` · Unit ${w.unit_number}` : ''} · reported ${fmtDate(w.created_date)} · ${Math.max(0, diffDays(ctx.businessDate, w.created_date))}d ago`,
      content: html`
        ${when(awarded, () => html`<div class="card" style="border-color:var(--ok)"><div class="card-body">
          <b>${awarded!.vendor_name} was awarded this job at ${usd(awarded!.amount_cents || 0)}.</b>
          <span class="muted small"> The vendor is dispatched on the work order; the other bids are kept as the record of what was compared.</span>
        </div></div>`)}
        ${when(quoted.length > 1, () => kpis([
          { label: 'Bids in', value: quoted.length, sub: `${bids.length - quoted.length} outstanding` },
          { label: 'Lowest', value: usd(low || 0), tone: 'ok' },
          { label: 'Spread', value: usd((high || 0) - (low || 0)), sub: low ? `${Math.round((((high || 0) - low) / low) * 100)}% between high and low` : '' },
          { label: 'Soonest start', value: soonest?.can_start_date ? fmtDate(soonest.can_start_date) : '—', sub: soonest ? soonest.vendor_name : '' },
        ]))}
        ${bids.length
          ? html`<div class="bid-grid">${bids.map(bidCard)}</div>`
          : emptyState(
            'No contractors invited yet.',
            'Invite outside contractors to bid, record what each one quotes, and compare price against start date, warranty and their track record before awarding.',
          )}
        ${when(!awarded && candidates.length, () => card('Invite a contractor to bid', html`
          <form method="post" action="/workorders/${w.id}/bids/invite" class="toolbar">
            ${field('Vendor', select('vendor_id', candidates.map((x): [string, string] => [x.id, `${x.name} · ${String(x.category).replaceAll('_', ' ')}${x.coi_expiry && x.coi_expiry < ctx.businessDate ? ' (COI EXPIRED)' : ''}`]), '', { blank: 'Choose a contractor…' }))}
            <button class="btn btn-sm">Request bid</button>
          </form>
          <p class="small muted" style="margin:8px 0 0">Contractors in the ${String(w.category).replaceAll('_', ' ')} trade are listed first. Requesting a bid records the invitation on the work order timeline; enter their price here when it comes back.</p>`))}`,
    });
  });

  r.post('/workorders/:id/bids/invite', requirePerm('workorders:assign'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const w = q1<any>('SELECT id, property_id FROM work_orders WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!w || !canAccessProperty(ctx, w.property_id)) return notFound('Work order not found');
    try {
      inviteBid(ctx, w.id, String(rq.body.vendor_id || ''));
    } catch (e) {
      return redirect(`/workorders/${w.id}/bids`, (e as Error).message, 'err');
    }
    return redirect(`/workorders/${w.id}/bids`, 'Bid requested.');
  });

  r.post('/workorders/:id/bids/:bidId/quote', requirePerm('workorders:assign'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const w = q1<any>('SELECT id, property_id FROM work_orders WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!w || !canAccessProperty(ctx, w.property_id)) return notFound('Work order not found');
    const bid = q1<any>('SELECT id FROM wo_bids WHERE id=? AND work_order_id=? AND org_id=?', rq.params.bidId!, w.id, ctx.orgId);
    if (!bid) return notFound('Bid not found');
    try {
      recordBid(ctx, bid.id, {
        amountCents: v.cents().parse(rq.body.amount),
        laborCents: rq.body.labor ? v.cents().parse(rq.body.labor) : null,
        materialsCents: rq.body.materials ? v.cents().parse(rq.body.materials) : null,
        canStartDate: rq.body.can_start_date ? String(rq.body.can_start_date) : null,
        daysToComplete: rq.body.days_to_complete ? parseInt(String(rq.body.days_to_complete), 10) : null,
        warrantyMonths: rq.body.warranty_months ? parseInt(String(rq.body.warranty_months), 10) : null,
        scope: rq.body.scope ? String(rq.body.scope) : null,
        notes: rq.body.notes ? String(rq.body.notes) : null,
      });
    } catch (e) {
      return redirect(`/workorders/${w.id}/bids`, (e as Error).message, 'err');
    }
    return redirect(`/workorders/${w.id}/bids`, 'Bid recorded.');
  });

  r.post('/workorders/:id/bids/:bidId/decline', requirePerm('workorders:assign'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const w = q1<any>('SELECT id, property_id FROM work_orders WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!w || !canAccessProperty(ctx, w.property_id)) return notFound('Work order not found');
    const bid = q1<any>('SELECT id FROM wo_bids WHERE id=? AND work_order_id=? AND org_id=?', rq.params.bidId!, w.id, ctx.orgId);
    if (!bid) return notFound('Bid not found');
    try {
      declineBid(ctx, bid.id, String(rq.body.reason || ''));
    } catch (e) {
      return redirect(`/workorders/${w.id}/bids`, (e as Error).message, 'err');
    }
    return redirect(`/workorders/${w.id}/bids`, 'Marked declined.');
  });

  r.post('/workorders/:id/bids/:bidId/award', requirePerm('workorders:assign'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const w = q1<any>('SELECT id, property_id FROM work_orders WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!w || !canAccessProperty(ctx, w.property_id)) return notFound('Work order not found');
    const bid = q1<any>('SELECT id FROM wo_bids WHERE id=? AND work_order_id=? AND org_id=?', rq.params.bidId!, w.id, ctx.orgId);
    if (!bid) return notFound('Bid not found');
    try {
      awardBid(ctx, bid.id, rq.body.scheduled_date ? String(rq.body.scheduled_date) : undefined);
    } catch (e) {
      return redirect(`/workorders/${w.id}/bids`, (e as Error).message, 'err');
    }
    return redirect(`/workorders/${w.id}/bids`, 'Awarded — the contractor is dispatched on this work order.');
  });

  // ---------- turn board ----------
  r.get('/turns', requirePerm('turns:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const pf = propFilter(ctx, 't.property_id');
    const turns = q<any>(
      `SELECT t.*, u.unit_number, p.name AS prop_name, l.household_name,
        (SELECT COUNT(*) FROM turn_tasks x WHERE x.turn_id=t.id AND x.status IN ('done','skipped')) AS done_tasks,
        (SELECT COUNT(*) FROM turn_tasks x WHERE x.turn_id=t.id) AS total_tasks,
        (SELECT name FROM turn_tasks x WHERE x.turn_id=t.id AND x.status IN ('pending','in_progress') ORDER BY x.seq LIMIT 1) AS current_stage
       FROM turns t JOIN units u ON u.id=t.unit_id JOIN properties p ON p.id=t.property_id LEFT JOIN leases l ON l.id=t.lease_id
       WHERE t.org_id=? AND t.status IN ('scheduled','in_progress')${pf.sql} ORDER BY t.target_ready_date`,
      ctx.orgId, ...pf.params,
    );
    const readyRecent = q<any>(
      `SELECT t.*, u.unit_number, p.name AS prop_name FROM turns t JOIN units u ON u.id=t.unit_id JOIN properties p ON p.id=t.property_id
       WHERE t.org_id=? AND t.status='ready'${pf.sql} ORDER BY t.completed_date DESC LIMIT 8`,
      ctx.orgId, ...pf.params,
    );
    const stages = ['not_started', ...TURN_STAGES] as string[];
    const byStage = new Map<string, any[]>(stages.map((s) => [s, []]));
    for (const t of turns) {
      const stage = t.move_out_date > ctx.businessDate ? 'not_started' : t.current_stage || 'final_qc';
      byStage.get(stage)?.push(t);
    }
    return shell(rq, {
      title: 'Make-ready turn board',
      active: '/turns',
      subtitle: `${turns.length} units in turn · bottleneck stages highlighted · driven by notices and move-outs`,
      wide: true,
      content: html`
        <div class="board">${stages.map((stage) => {
          const items = byStage.get(stage) || [];
          const bottleneck = items.length >= 3 && stage !== 'not_started';
          return html`<div class="col" style="${bottleneck ? 'border-color:var(--warn);' : ''}">
            <div class="col-head"><span>${stage === 'not_started' ? 'Awaiting move-out' : stage.replaceAll('_', ' ')}</span><span class="badge ${bottleneck ? 'warn' : ''}">${items.length}</span></div>
            <div class="col-body">${items.map((t) => {
              const late = t.target_ready_date < ctx.businessDate;
              return html`<a class="bcard" href="/turns/${t.id}" style="${late ? 'border-color:var(--bad)' : ''}">
                <b>${t.unit_number}</b> · ${t.prop_name.split(' ')[0]}
                <span class="sub">target ${fmtDate(t.target_ready_date)}${late ? ' ⚠ late' : ''} · ${t.done_tasks}/${t.total_tasks} tasks${t.next_move_in_date ? ` · next move-in ${fmtDate(t.next_move_in_date)}` : ''}</span>
              </a>`;
            })}</div>
          </div>`;
        })}</div>
        ${when(readyRecent.length, () => card('Recently made ready', tbl(
          [{ label: 'Unit' }, { label: 'Property' }, { label: 'Ready' }, { label: 'Turn cost', num: true }],
          readyRecent.map((t) => ({ href: `/turns/${t.id}`, cells: [html`<b>${t.unit_number}</b>`, t.prop_name, fmtDate(t.completed_date), usd(turnCost(t.id).actual)] })),
        ), { flush: true }))}`,
    });
  });

  r.get('/turns/:id', requirePerm('turns:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const t = q1<any>(
      `SELECT t.*, u.unit_number, p.name AS prop_name FROM turns t JOIN units u ON u.id=t.unit_id JOIN properties p ON p.id=t.property_id WHERE t.id=? AND t.org_id=?`,
      rq.params.id!, ctx.orgId,
    );
    if (!t || !canAccessProperty(ctx, t.property_id)) return notFound('Turn not found');
    const tasks = q<any>(
      `SELECT tt.*, (SELECT name FROM users u WHERE u.id=tt.assigned_to_user_id) AS tech, (SELECT name FROM vendors vd WHERE vd.id=tt.vendor_id) AS vendor
       FROM turn_tasks tt WHERE tt.turn_id=? ORDER BY tt.seq`,
      t.id,
    );
    const cost = turnCost(t.id);
    const vendors = q<any>(`SELECT * FROM vendors WHERE org_id=? AND active=1 ORDER BY name`, ctx.orgId);
    return shell(rq, {
      title: `Turn — ${t.unit_number}`,
      active: '/turns',
      crumbs: [['Turn board', '/turns']],
      subtitle: html`${statusBadge(t.status)} · move-out ${fmtDate(t.move_out_date)} · target ready <b>${fmtDate(t.target_ready_date)}</b> · est ${usd(cost.est)} / actual ${usd(cost.actual)}`,
      content: html`
        ${card('Pipeline', tbl(
          [{ label: '#' }, { label: 'Stage' }, { label: 'Status' }, { label: 'Assigned' }, { label: 'Est', num: true }, { label: 'Actual', num: true }, { label: '', w: '320px' }],
          tasks.map((task) => ({
            cells: [
              task.seq, html`<b>${task.name.replaceAll('_', ' ')}</b>`, statusBadge(task.status),
              task.tech || task.vendor || '—', usd(task.est_cost_cents), usd(task.actual_cost_cents),
              html`<form method="post" action="/turns/tasks/${task.id}" class="toolbar" style="margin:0">
                ${select('status', [['pending', 'pending'], ['in_progress', 'in progress'], ['done', 'done'], ['skipped', 'skipped']], task.status)}
                ${select('vendor_id', vendors.map((x): [string, string] => [x.id, x.name]), task.vendor_id || '', { blank: 'vendor…' })}
                ${moneyInput('actual_cost', task.actual_cost_cents || null, { placeholder: 'actual $' })}
                <button class="btn btn-sm btn-ghost">Save</button>
              </form>`,
            ],
          })),
        ), { flush: true })}
        ${when(t.status === 'ready', () => html`<div class="callout" style="border-color:var(--ok)">Unit made ready ${fmtDate(t.completed_date)} — it is back in available inventory.</div>`)}`,
    });
  });

  r.post('/turns/tasks/:id', requirePerm('turns:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const task = q1<any>('SELECT * FROM turn_tasks WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!task) return notFound();
    try {
      advanceTurnTask(ctx, task.id, {
        status: String(rq.body.status || task.status),
        actualCostCents: rq.body.actual_cost ? v.cents().parse(rq.body.actual_cost) : undefined,
        vendorId: rq.body.vendor_id ? String(rq.body.vendor_id) : undefined,
      });
    } catch (e) {
      return redirect(`/turns/${task.turn_id}`, (e as Error).message, 'err');
    }
    return redirect(`/turns/${task.turn_id}`, 'Task updated.');
  });

  // ---------- inspections ----------
  r.get('/inspections', requirePerm('inspections:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const pf = propFilter(ctx, 'i.property_id');
    const rows = q<any>(
      `SELECT i.*, u.unit_number, p.name AS prop_name, (SELECT name FROM users x WHERE x.id=i.inspector_user_id) AS inspector,
        (SELECT COUNT(*) FROM inspection_items ii WHERE ii.inspection_id=i.id AND ii.condition IN ('damaged','missing')) AS issues
       FROM inspections i JOIN units u ON u.id=i.unit_id JOIN properties p ON p.id=i.property_id
       WHERE i.org_id=?${pf.sql} ORDER BY i.date DESC LIMIT 60`,
      ctx.orgId, ...pf.params,
    );
    const units = q<any>(
      `SELECT u.id, u.unit_number, p.name AS prop FROM units u JOIN properties p ON p.id=u.property_id WHERE u.org_id=?${propFilter(ctx, 'u.property_id').sql} ORDER BY p.name, u.unit_number`,
      ctx.orgId, ...propFilter(ctx, 'u.property_id').params,
    );
    return shell(rq, {
      title: 'Inspections',
      active: '/inspections',
      content: html`
        ${card('Start an inspection', html`<form method="post" action="/inspections/new" class="toolbar">
          ${field('Unit', select('unit_id', units.map((u): [string, string] => [u.id, `${u.prop} · ${u.unit_number}`]), undefined, { required: true }))}
          ${field('Type', select('type', Object.keys(INSPECTION_TEMPLATES).map((t): [string, string] => [t, t.replaceAll('_', ' ')]), 'quarterly'))}
          <button class="btn">Start</button>
        </form>`)}
        ${card(null, tbl(
          [{ label: 'Date' }, { label: 'Unit' }, { label: 'Property' }, { label: 'Type' }, { label: 'Inspector' }, { label: 'Issues', num: true }, { label: 'Status' }],
          rows.map((i) => ({
            href: `/inspections/${i.id}`,
            cells: [fmtDate(i.date), html`<b>${i.unit_number}</b>`, i.prop_name, statusBadge(undefined, i.type.replaceAll('_', ' ')), i.inspector || '—', i.issues || 0, statusBadge(i.status)],
          })),
          { empty: 'No inspections yet.' },
        ), { flush: true })}`,
    });
  });

  r.post('/inspections/new', requirePerm('inspections:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const unitId = String(rq.body.unit_id || '');
    const type = String(rq.body.type || 'quarterly');
    const lease = q1<any>(`SELECT * FROM leases WHERE unit_id=? AND status IN ('active','month_to_month','notice','ended') ORDER BY end_date DESC LIMIT 1`, unitId);
    const inspId = createInspection(ctx, { unitId, type, leaseId: type === 'move_out' || type === 'move_in' ? lease?.id : null });
    audit(ctx, 'inspection', inspId, 'create', null, { type });
    return redirect(`/inspections/${inspId}`, 'Inspection started — walk the checklist.');
  });

  r.get('/inspections/:id', requirePerm('inspections:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const insp = q1<any>(
      `SELECT i.*, u.unit_number, p.name AS prop_name FROM inspections i JOIN units u ON u.id=i.unit_id JOIN properties p ON p.id=i.property_id WHERE i.id=? AND i.org_id=?`,
      rq.params.id!, ctx.orgId,
    );
    if (!insp || !canAccessProperty(ctx, insp.property_id)) return notFound('Inspection not found');
    const items = q<any>('SELECT * FROM inspection_items WHERE inspection_id=? ORDER BY id', insp.id);
    const byArea = new Map<string, any[]>();
    for (const it of items) {
      const list = byArea.get(it.area) || [];
      list.push(it);
      byArea.set(it.area, list);
    }
    // side-by-side move-in comparison for move-out inspections
    const moveIn = insp.type === 'move_out' && insp.lease_id
      ? q1<any>(`SELECT * FROM inspections WHERE lease_id=? AND type='move_in' ORDER BY date LIMIT 1`, insp.lease_id)
      : null;
    const moveInItems = moveIn ? q<any>('SELECT * FROM inspection_items WHERE inspection_id=?', moveIn.id) : [];
    const conditionOf = (area: string, item: string): string | null =>
      moveInItems.find((x) => x.area === area && x.item === item)?.condition || null;
    const damageTotal = items.reduce((s, x) => s + x.charge_cents, 0);
    return shell(rq, {
      title: `${insp.type.replaceAll('_', ' ')} inspection — ${insp.unit_number}`,
      active: '/inspections',
      crumbs: [['Inspections', '/inspections']],
      subtitle: html`${statusBadge(insp.status)} · ${fmtDate(insp.date)} · ${insp.prop_name}${moveIn ? html` · comparing against move-in ${fmtDate(moveIn.date)}` : ''}`,
      actions: html`
        ${when(insp.status === 'in_progress', () => html`<form method="post" action="/inspections/${insp.id}/complete"><button class="btn">Complete inspection</button></form>`)}
        ${when(insp.type === 'move_out' && insp.status === 'completed' && !insp.damages_posted && damageTotal > 0, () => html`<form method="post" action="/inspections/${insp.id}/post-damages" data-confirm="Post ${usd(damageTotal)} in damage charges to the vacating lease ledger?"><button class="btn btn-danger">Post ${usd(damageTotal)} damages to ledger</button></form>`)}
        ${when(!!insp.damages_posted, () => statusBadge('ok', 'damages posted'))}`,
      content: html`${[...byArea.entries()].map(([area, list]) => card(area, tbl(
        [{ label: 'Item' }, ...(moveIn ? [{ label: 'Move-in' }] : []), { label: 'Condition' }, { label: 'Note' }, { label: 'Charge', num: true }],
        list.map((it) => ({
          cells: [
            html`<b>${it.item}</b>`,
            ...(moveIn ? [statusBadge(conditionOf(area, it.item) || undefined, conditionOf(area, it.item) || '—')] : []),
            insp.status === 'in_progress'
              ? html`<form method="post" action="/inspections/items/${it.id}" class="toolbar" style="margin:0" data-autosubmit>
                  ${select('condition', [['good', 'good'], ['fair', 'fair'], ['damaged', 'damaged'], ['missing', 'missing']], it.condition)}
                </form>`
              : statusBadge(it.condition === 'good' ? 'ok' : it.condition === 'fair' ? 'pending' : 'bad', it.condition),
            insp.status === 'in_progress'
              ? html`<form method="post" action="/inspections/items/${it.id}" class="toolbar" style="margin:0">
                  ${input('note', { value: it.note ?? '', placeholder: 'note' })}
                  ${moneyInput('charge', it.charge_cents || null, { placeholder: 'charge $' })}
                  <input type="hidden" name="condition" value="${it.condition}" />
                  <button class="btn btn-sm btn-ghost">Save</button>
                </form>`
              : html`<span class="small">${it.note || ''}</span>`,
            it.charge_cents ? usd(it.charge_cents) : '',
          ],
        })),
      ), { flush: true }))}`,
    });
  });

  r.post('/inspections/items/:id', requirePerm('inspections:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const it = q1<any>('SELECT * FROM inspection_items WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!it) return notFound();
    update('inspection_items', it.id, {
      condition: String(rq.body.condition || it.condition),
      note: rq.body.note !== undefined ? String(rq.body.note) : it.note,
      charge_cents: rq.body.charge ? v.cents().parse(rq.body.charge) : it.charge_cents,
    });
    return redirect(`/inspections/${it.inspection_id}`, undefined as unknown as string);
  });

  r.post('/inspections/:id/complete', requirePerm('inspections:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    run(`UPDATE inspections SET status='completed' WHERE id=? AND org_id=?`, rq.params.id!, ctx.orgId);
    audit(ctx, 'inspection', rq.params.id!, 'complete');
    return redirect(`/inspections/${rq.params.id}`, 'Inspection completed.');
  });

  r.post('/inspections/:id/post-damages', requirePerm('inspections:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    try {
      const n = postInspectionDamages(ctx, rq.params.id!);
      return redirect(`/inspections/${rq.params.id}`, `${n} damage charge${n === 1 ? '' : 's'} posted to the resident ledger — they now appear in the deposit disposition.`);
    } catch (e) {
      return redirect(`/inspections/${rq.params.id}`, (e as Error).message, 'err');
    }
  });

  // ---------- preventive maintenance ----------
  r.get('/pm', requirePerm('pm:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const pf = propFilter(ctx, 'pm.property_id');
    const schedules = q<any>(
      `SELECT pm.*, p.name AS prop_name, (SELECT name FROM users x WHERE x.id=pm.assigned_to_user_id) AS tech FROM pm_schedules pm JOIN properties p ON p.id=pm.property_id WHERE pm.org_id=?${pf.sql} ORDER BY pm.next_due`,
      ctx.orgId, ...pf.params,
    );
    // compliance: PM WOs completed within 7 days of creation over trailing 90d
    const pmWos = q<any>(
      `SELECT * FROM work_orders WHERE org_id=? AND source='pm' AND created_date>=?`,
      ctx.orgId, addDays(ctx.businessDate, -90),
    );
    const done = pmWos.filter((w) => w.status === 'completed');
    const onTime = done.filter((w) => diffDays(w.completed_date, w.created_date) <= 7).length;
    const props = q<any>(`SELECT id, name FROM properties WHERE org_id=?${propFilter(ctx, 'id').sql} ORDER BY name`, ctx.orgId, ...propFilter(ctx, 'id').params);
    return shell(rq, {
      title: 'Preventive maintenance',
      active: '/pm',
      subtitle: `Schedules auto-generate work orders on their due dates (advance the business date to see it).`,
      content: html`
        ${kpis([
          { label: 'Active schedules', value: schedules.filter((s) => s.active).length },
          { label: 'PM WOs (90d)', value: pmWos.length },
          { label: 'Completed on time', value: done.length ? `${Math.round((onTime / done.length) * 100)}%` : '—', tone: done.length && onTime / done.length >= 0.85 ? 'ok' : 'warn' },
        ])}
        ${card('Schedules', html`${tbl(
          [{ label: 'Schedule' }, { label: 'Property' }, { label: 'Every' }, { label: 'Next due' }, { label: 'Assigned' }, { label: 'Active' }],
          schedules.map((s) => ({
            cells: [
              html`<b>${s.name}</b><span class="sub">${s.category}</span>`, s.prop_name, `${s.freq_days}d`,
              html`<span class="${s.next_due <= ctx.businessDate ? 'neg' : ''}">${fmtDate(s.next_due)}</span>`,
              s.tech || '—',
              html`<form method="post" action="/pm/${s.id}/toggle"><button class="btn btn-sm btn-ghost">${s.active ? 'On' : 'Off'}</button></form>`,
            ],
          })),
          { empty: 'No PM schedules yet.' },
        )}
        <div class="card-body"><form method="post" action="/pm" class="toolbar">
          ${field('Name', input('name', { required: true, placeholder: 'HVAC filters — building A' }))}
          ${field('Property', select('property_id', props.map((p): [string, string] => [p.id, p.name]), undefined, { required: true }))}
          ${field('Category', select('category', WO_CATEGORIES.map((x): [string, string] => [x, x]), 'hvac'))}
          ${field('Every (days)', input('freq_days', { type: 'number', value: 90, min: '7' }))}
          ${field('First due', input('next_due', { type: 'date', value: addDays(ctx.businessDate, 7) }))}
          ${field('Assign to', select('assigned_to', techs(ctx).map((t): [string, string] => [t.id, t.name]), undefined, { blank: 'Unassigned' }))}
          <button class="btn">Add schedule</button>
        </form></div>`, { flush: true })}`,
    });
  });

  r.post('/pm', requirePerm('pm:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    insert('pm_schedules', {
      id: id('pms'), org_id: ctx.orgId, property_id: String(rq.body.property_id), name: String(rq.body.name || 'PM'),
      category: String(rq.body.category || 'pm'), instructions: null,
      freq_days: v.int({ min: 7 }).parse(rq.body.freq_days || 90), next_due: v.date().parse(rq.body.next_due),
      assigned_to_user_id: rq.body.assigned_to ? String(rq.body.assigned_to) : null, active: 1, created_at: nowIso(),
    });
    return redirect('/pm', 'Schedule added — it will generate work orders on its due date.');
  });

  r.post('/pm/:id/toggle', requirePerm('pm:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    run('UPDATE pm_schedules SET active=1-active WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    return redirect('/pm', 'Toggled.');
  });

  // ---------- inventory ----------
  r.get('/inventory', requirePerm('inventory:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const pf = propFilter(ctx, 'i.property_id');
    const items = q<any>(
      `SELECT i.*, p.name AS prop_name FROM inventory_items i JOIN properties p ON p.id=i.property_id WHERE i.org_id=?${pf.sql} ORDER BY p.name, i.name`,
      ctx.orgId, ...pf.params,
    );
    const reorder = items.filter((i) => i.on_hand < i.min_qty);
    const props = q<any>(`SELECT id, name FROM properties WHERE org_id=?${propFilter(ctx, 'id').sql} ORDER BY name`, ctx.orgId, ...propFilter(ctx, 'id').params);
    const value = items.reduce((s, i) => s + Math.round(i.on_hand * i.unit_cost_cents), 0);
    return shell(rq, {
      title: 'Inventory',
      active: '/inventory',
      subtitle: `${items.length} stock items · ${usd(value)} on hand · usage posts to work orders and the GL`,
      content: html`
        ${when(reorder.length, () => html`<div class="callout warn"><b>${reorder.length} item${reorder.length === 1 ? '' : 's'} below minimum</b> — ${reorder.slice(0, 4).map((i) => i.name).join(', ')}${reorder.length > 4 ? '…' : ''}. Reorder through Procure-to-Pay.</div>`)}
        ${card(null, html`${tbl(
          [{ label: 'Item' }, { label: 'Property' }, { label: 'Bin' }, { label: 'On hand', num: true }, { label: 'Min/Max', num: true }, { label: 'Unit cost', num: true }, { label: 'Status' }],
          items.map((i) => ({
            cells: [
              html`<b>${i.name}</b><span class="sub">${i.sku} · ${i.category}</span>`, i.prop_name, i.bin || '—',
              i.on_hand, `${i.min_qty}/${i.max_qty}`, usd(i.unit_cost_cents),
              i.on_hand < i.min_qty ? statusBadge('bad', 'reorder') : statusBadge('ok', 'ok'),
            ],
          })),
          { empty: 'No inventory yet.' },
        )}
        <div class="card-body"><form method="post" action="/inventory" class="toolbar">
          ${field('Property', select('property_id', props.map((p): [string, string] => [p.id, p.name]), undefined, { required: true }))}
          ${field('SKU', input('sku', { required: true, placeholder: 'FLT-20x25' }))}
          ${field('Name', input('name', { required: true }))}
          ${field('Category', input('category', { value: 'general' }))}
          ${field('Unit cost', moneyInput('unit_cost', 1000))}
          ${field('On hand', input('on_hand', { type: 'number', value: 10 }))}
          ${field('Min', input('min_qty', { type: 'number', value: 2 }))}
          <button class="btn">Add item</button>
        </form></div>`, { flush: true })}`,
    });
  });

  r.post('/inventory', requirePerm('inventory:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    insert('inventory_items', {
      id: id('inv'), org_id: ctx.orgId, property_id: String(rq.body.property_id),
      sku: String(rq.body.sku || '').trim(), name: String(rq.body.name || '').trim(),
      category: String(rq.body.category || 'general'), bin: rq.body.bin || null,
      unit_cost_cents: v.cents().parse(rq.body.unit_cost || 0), on_hand: v.number({ min: 0 }).parse(rq.body.on_hand || 0),
      min_qty: v.number({ min: 0 }).parse(rq.body.min_qty || 0), max_qty: v.number({ min: 0 }).parse(rq.body.max_qty || 20),
      created_at: nowIso(),
    });
    return redirect('/inventory', 'Item added.');
  });

  // ---------- vendors (COI focus; full management in M16) ----------
  r.get('/vendors', requirePerm('vendors:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const vendors = q<any>(
      `SELECT vd.*, (SELECT COUNT(*) FROM work_orders w WHERE w.vendor_id=vd.id AND w.status NOT IN ('completed','canceled')) AS open_wos
       FROM vendors vd WHERE vd.org_id=? ORDER BY vd.name`,
      ctx.orgId,
    );
    return shell(rq, {
      title: 'Vendors',
      active: '/vendors',
      subtitle: 'Insurance certificates gate dispatch — an expired COI blocks assignment. Purchasing runs through Procure-to-Pay.',
      content: card(null, tbl(
        [{ label: 'Vendor' }, { label: 'Category' }, { label: 'Contact' }, { label: 'COI expires' }, { label: 'W-9' }, { label: 'Open WOs', num: true }],
        vendors.map((x) => {
          const expired = x.coi_expiry && x.coi_expiry < ctx.businessDate;
          const expiring = !expired && x.coi_expiry && diffDays(x.coi_expiry, ctx.businessDate) <= 30;
          return {
            href: `/vendors/${x.id}`,
            cells: [
              html`<b>${x.name}</b>`, statusBadge(undefined, x.category),
              html`<span class="small">${x.email || x.phone || '—'}</span>`,
              x.coi_expiry ? html`<span class="${expired ? 'neg' : ''}">${fmtDate(x.coi_expiry)} ${expired ? statusBadge('bad', 'EXPIRED') : expiring ? statusBadge('warn', 'expiring') : ''}</span>` : statusBadge('bad', 'missing'),
              x.w9_on_file ? statusBadge('ok', 'on file') : statusBadge('warn', 'missing'),
              x.open_wos,
            ],
          };
        }),
        { empty: 'No vendors yet.' },
      ), { flush: true }),
    });
  });

  r.get('/vendors/:id', requirePerm('vendors:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const x = q1<any>('SELECT * FROM vendors WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!x) return notFound('Vendor not found');
    const wos = q<any>(`SELECT w.*, u.unit_number FROM work_orders w LEFT JOIN units u ON u.id=w.unit_id WHERE w.vendor_id=? ORDER BY w.created_date DESC LIMIT 20`, x.id);
    const expired = x.coi_expiry && x.coi_expiry < ctx.businessDate;
    return shell(rq, {
      title: x.name,
      active: '/vendors',
      crumbs: [['Vendors', '/vendors']],
      actions: when(ctx.perms.has('vendors:manage'), () => html`<form method="post" action="/vendors/${x.id}/renew-coi" class="toolbar" style="margin:0">
        ${input('coi_expiry', { type: 'date', value: addDays(ctx.businessDate, 365) })}
        <button class="btn btn-ghost btn-sm">Record new COI</button>
      </form>`),
      content: html`
        ${when(expired, () => html`<div class="callout bad"><b>Insurance certificate expired ${fmtDate(x.coi_expiry)}.</b> This vendor cannot be assigned work until a current COI is recorded.</div>`)}
        <div class="grid cols-2">
          ${card('Profile', dl([
            ['Category', x.category], ['Phone', x.phone || '—'], ['Email', x.email || '—'],
            ['COI expiry', x.coi_expiry ? fmtDate(x.coi_expiry) : 'missing'],
            ['W-9', x.w9_on_file ? `On file (TIN ···${x.tin_last4})` : 'Missing'],
            ['1099 eligible', x.is_1099 ? 'Yes' : 'No'],
          ]))}
          ${card('History', historyPanel(ctx.orgId, 'vendor', x.id))}
        </div>
        ${card('Assigned work', tbl(
          [{ label: '#' }, { label: 'Summary' }, { label: 'Unit' }, { label: 'Status' }, { label: 'Created' }],
          wos.map((w) => ({ href: `/workorders/${w.id}`, cells: [html`<span class="mono small">${w.id.slice(-6)}</span>`, w.summary, w.unit_number || '—', statusBadge(w.status), fmtDate(w.created_date)] })),
          { empty: 'No work assigned yet.' },
        ), { flush: true })}`,
    });
  });

  r.post('/vendors/:id/renew-coi', requirePerm('vendors:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const x = q1<any>('SELECT * FROM vendors WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!x) return notFound();
    const newDate = v.date().parse(rq.body.coi_expiry);
    update('vendors', x.id, { coi_expiry: newDate });
    audit(ctx, 'vendor', x.id, 'coi_renewed', { coi_expiry: x.coi_expiry }, { coi_expiry: newDate });
    return redirect(`/vendors/${x.id}`, 'COI recorded.');
  });

  // ---------- facilities analytics ----------
  r.get('/facilities', requirePerm('workorders:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const propId = ctx.currentPropertyId;
    const stats = facilitiesStats(ctx, propId);
    const propSql = propId ? ' AND property_id=?' : '';
    const p = propId ? [propId] : [];
    const byCategory = q<any>(
      `SELECT category, COUNT(*) n FROM work_orders WHERE org_id=? AND created_date>=?${propSql} GROUP BY category ORDER BY n DESC`,
      ctx.orgId, addDays(ctx.businessDate, -90), ...p,
    );
    const aging = q<any>(
      `SELECT CASE WHEN julianday(?) - julianday(created_date) <= 3 THEN '0-3d' WHEN julianday(?) - julianday(created_date) <= 7 THEN '4-7d' WHEN julianday(?) - julianday(created_date) <= 14 THEN '8-14d' ELSE '15d+' END AS bucket, COUNT(*) n
       FROM work_orders WHERE org_id=? AND status NOT IN ('completed','canceled')${propSql} GROUP BY bucket`,
      ctx.businessDate, ctx.businessDate, ctx.businessDate, ctx.orgId, ...p,
    );
    const techRows = q<any>(
      `SELECT (SELECT name FROM users u WHERE u.id=w.assigned_to_user_id) AS tech, COUNT(*) done,
        AVG(julianday(w.completed_date) - julianday(w.created_date)) avg_days, AVG(w.rating) rating
       FROM work_orders w WHERE w.org_id=? AND w.status='completed' AND w.assigned_to_user_id IS NOT NULL AND w.completed_date>=?${propSql}
       GROUP BY w.assigned_to_user_id ORDER BY done DESC`,
      ctx.orgId, addDays(ctx.businessDate, -90), ...p,
    );
    const turnRows = q<any>(
      `SELECT * FROM turns WHERE org_id=? AND status='ready'${propSql} ORDER BY completed_date DESC LIMIT 40`,
      ctx.orgId, ...p,
    );
    const avgTurnDays = turnRows.length
      ? Math.round(turnRows.reduce((s, t) => s + Math.max(0, diffDays(t.completed_date, t.move_out_date)), 0) / turnRows.length)
      : 0;
    return shell(rq, {
      title: 'Facilities analytics',
      active: '/facilities',
      content: html`
        ${kpis([
          { label: 'Open WOs', value: stats.open, href: '/workorders' },
          { label: 'SLA compliance (30d)', value: `${stats.slaCompliance30d}%`, tone: stats.slaCompliance30d >= 90 ? 'ok' : 'warn' },
          { label: 'Avg completion', value: `${stats.avgDaysToComplete}d` },
          { label: 'Maint. cost / unit (30d)', value: usd(stats.costPerUnit30d) },
          { label: 'Avg turn time', value: `${avgTurnDays}d`, sub: `${turnRows.length} turns completed` },
          { label: 'Resident rating', value: stats.avgRating ? `${stats.avgRating}★` : '—', tone: stats.avgRating >= 4.2 ? 'ok' : undefined },
        ])}
        <div class="grid cols-2">
          ${card('Open work order aging', bars(aging.map((a) => ({ label: a.bucket, value: a.n, tone: a.bucket === '15d+' ? 'bad' : a.bucket === '8-14d' ? 'warn' : 'info' }))))}
          ${card('Top categories (90d)', bars(byCategory.slice(0, 8).map((c) => ({ label: c.category.replaceAll('_', ' '), value: c.n }))))}
        </div>
        ${card('Tech productivity (90d)', tbl(
          [{ label: 'Tech' }, { label: 'Completed', num: true }, { label: 'Avg days', num: true }, { label: 'Rating', num: true }],
          techRows.map((t) => ({ cells: [t.tech || '—', t.done, Math.round((t.avg_days || 0) * 10) / 10, t.rating ? `${Math.round(t.rating * 10) / 10}★` : '—'] })),
          { empty: 'No completions yet.' },
        ), { flush: true })}`,
    });
  });
}

