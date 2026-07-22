import { q, q1, val } from '../../lib/db.ts';
import { addMonths, monthKey } from '../../lib/dates.ts';
import { registerReport, propScope, type ReportResult } from './engine.ts';
import { woCost, turnCost } from '../m10_facilities/service.ts';

/** §10 Facilities: WO Aging & SLA Compliance, Maintenance Cost per Unit,
 * PM Compliance, Turn Time & Cost, Inspection Results, Inventory Valuation. */

const PROP = { key: 'property', kind: 'property' as const };

registerReport({
  key: 'wo_sla',
  name: 'Work Order Aging & SLA Compliance',
  category: 'Facilities',
  describe: 'Open work orders by age with SLA state; completed-in-range SLA hit rate.',
  params: [{ ...PROP, allowAll: true }, { key: 'from', kind: 'from', default: (ctx) => addMonths(ctx.businessDate, -1) }, { key: 'to', kind: 'to' }],
  perm: 'workorders:view',
  defaultGroup: 'state',
  run(ctx, p): ReportResult {
    const { sql, params } = propScope(ctx, p.property!, 'wo.property_id');
    const open = q<any>(
      `SELECT wo.*, u.unit_number, p2.name AS prop FROM work_orders wo
       LEFT JOIN units u ON u.id=wo.unit_id JOIN properties p2 ON p2.id=wo.property_id
       WHERE wo.org_id=?${sql} AND wo.status NOT IN ('completed','canceled') ORDER BY wo.created_date`,
      ctx.orgId, ...params,
    );
    const done = q<any>(
      `SELECT wo.*, u.unit_number, p2.name AS prop FROM work_orders wo
       LEFT JOIN units u ON u.id=wo.unit_id JOIN properties p2 ON p2.id=wo.property_id
       WHERE wo.org_id=?${sql} AND wo.status='completed' AND wo.completed_date BETWEEN ? AND ?`,
      ctx.orgId, ...params, p.from, p.to,
    );
    const rows = [
      ...open.map((wo) => ({
        state: 'Open',
        wo: wo.summary.slice(0, 50),
        property: wo.prop,
        unit: wo.unit_number || '—',
        priority: wo.priority,
        age_days: Math.round((Date.parse(ctx.businessDate) - Date.parse(wo.created_date)) / 86400000),
        sla: wo.sla_due ? (wo.sla_due < new Date().toISOString() ? 'BREACHED' : 'inside SLA') : '—',
        __href: `/workorders/${wo.id}`,
      })),
      ...done.map((wo) => ({
        state: 'Completed in range',
        wo: wo.summary.slice(0, 50),
        property: wo.prop,
        unit: wo.unit_number || '—',
        priority: wo.priority,
        age_days: Math.round((Date.parse(wo.completed_date) - Date.parse(wo.created_date)) / 86400000),
        sla: wo.sla_due && wo.completed_at && wo.completed_at > wo.sla_due ? 'missed' : 'hit',
        __href: `/workorders/${wo.id}`,
      })),
    ];
    const hit = done.filter((wo) => !(wo.sla_due && wo.completed_at && wo.completed_at > wo.sla_due)).length;
    return {
      cols: [
        { key: 'state', label: 'State' },
        { key: 'wo', label: 'Work order' },
        { key: 'property', label: 'Property' },
        { key: 'unit', label: 'Unit' },
        { key: 'priority', label: 'Priority', kind: 'badge' },
        { key: 'age_days', label: 'Age (days)', kind: 'num' },
        { key: 'sla', label: 'SLA', kind: 'badge' },
      ],
      rows,
      note: `${open.length} open · ${done.length} completed in range · SLA hit rate ${done.length ? Math.round((hit / done.length) * 100) : 100}%.`,
    };
  },
});

registerReport({
  key: 'maint_cost_per_unit',
  name: 'Maintenance Cost per Unit',
  category: 'Facilities',
  describe: 'Materials + labor by property and month, normalized per unit.',
  params: [{ ...PROP, allowAll: true }],
  perm: 'workorders:view',
  run(ctx, p): ReportResult {
    const props = p.property === 'all'
      ? q<any>(`SELECT id, name FROM properties WHERE org_id=? ORDER BY name`, ctx.orgId)
      : q<any>(`SELECT id, name FROM properties WHERE id=?`, p.property);
    const rows: ReportResult['rows'] = [];
    for (const prop of props) {
      const units = val<number>('SELECT COUNT(*) FROM units WHERE property_id=?', prop.id) || 1;
      for (let i = 5; i >= 0; i--) {
        const mk = monthKey(addMonths(ctx.businessDate, -i));
        const mat = val<number>(
          `SELECT COALESCE(SUM(m.total_cents),0) FROM wo_materials m JOIN work_orders wo ON wo.id=m.work_order_id
           WHERE wo.property_id=? AND substr(m.created_at,1,7)=?`,
          prop.id, mk,
        ) || 0;
        const lab = val<number>(
          `SELECT COALESCE(SUM(l.total_cents),0) FROM wo_labor l JOIN work_orders wo ON wo.id=l.work_order_id
           WHERE wo.property_id=? AND substr(l.created_at,1,7)=?`,
          prop.id, mk,
        ) || 0;
        const wos = val<number>(
          `SELECT COUNT(*) FROM work_orders WHERE property_id=? AND substr(created_date,1,7)=?`, prop.id, mk,
        ) || 0;
        rows.push({
          property: prop.name,
          month: mk,
          wos_created: wos,
          materials: mat,
          labor: lab,
          total: mat + lab,
          per_unit: Math.round((mat + lab) / units),
        });
      }
    }
    return {
      cols: [
        { key: 'property', label: 'Property' },
        { key: 'month', label: 'Month', kind: 'month' },
        { key: 'wos_created', label: 'WOs', kind: 'num', total: true },
        { key: 'materials', label: 'Materials', kind: 'money', total: true },
        { key: 'labor', label: 'Labor', kind: 'money', total: true },
        { key: 'total', label: 'Total', kind: 'money', total: true },
        { key: 'per_unit', label: 'Per unit', kind: 'money' },
      ],
      rows,
    };
  },
});

registerReport({
  key: 'pm_compliance',
  name: 'PM Compliance',
  category: 'Facilities',
  describe: 'Preventive maintenance schedules: on-time completion and overdue work.',
  params: [{ ...PROP, allowAll: true }],
  perm: 'workorders:view',
  run(ctx, p): ReportResult {
    const { sql, params } = propScope(ctx, p.property!, 'ps.property_id');
    const rows = q<any>(
      `SELECT ps.*, p2.name AS prop FROM pm_schedules ps JOIN properties p2 ON p2.id=ps.property_id
       WHERE ps.org_id=?${sql} AND ps.active=1 ORDER BY ps.next_due`,
      ctx.orgId, ...params,
    ).map((ps) => {
      const generated = val<number>(
        `SELECT COUNT(*) FROM work_orders WHERE property_id=? AND source='pm' AND summary LIKE ?`,
        ps.property_id, `%${ps.name}%`,
      ) || 0;
      const completed = val<number>(
        `SELECT COUNT(*) FROM work_orders WHERE property_id=? AND source='pm' AND summary LIKE ? AND status='completed'`,
        ps.property_id, `%${ps.name}%`,
      ) || 0;
      return {
        schedule: ps.name,
        property: ps.prop,
        category: ps.category,
        every: `${ps.freq_days} days`,
        next_due: ps.next_due,
        overdue: ps.next_due < ctx.businessDate ? 'OVERDUE' : 'on track',
        generated,
        completed,
        compliance: generated ? (completed / generated) * 100 : 100,
        __href: '/pm',
      };
    });
    return {
      cols: [
        { key: 'schedule', label: 'Schedule' },
        { key: 'property', label: 'Property' },
        { key: 'category', label: 'Category', kind: 'badge' },
        { key: 'every', label: 'Cadence' },
        { key: 'next_due', label: 'Next due', kind: 'date' },
        { key: 'overdue', label: 'State', kind: 'badge' },
        { key: 'generated', label: 'WOs generated', kind: 'num', total: true },
        { key: 'completed', label: 'Completed', kind: 'num', total: true },
        { key: 'compliance', label: 'Compliance', kind: 'pct' },
      ],
      rows,
    };
  },
});

registerReport({
  key: 'turn_performance',
  name: 'Turn Time & Cost',
  category: 'Facilities',
  describe: 'Completed turns: days vacant-to-ready and actual cost vs estimate.',
  params: [{ ...PROP, allowAll: true }, { key: 'from', kind: 'from', default: (ctx) => addMonths(ctx.businessDate, -6) }, { key: 'to', kind: 'to' }],
  perm: 'workorders:view',
  run(ctx, p): ReportResult {
    const { sql, params } = propScope(ctx, p.property!, 't.property_id');
    const rows = q<any>(
      `SELECT t.*, u.unit_number, p2.name AS prop FROM turns t
       JOIN units u ON u.id=t.unit_id JOIN properties p2 ON p2.id=t.property_id
       WHERE t.org_id=?${sql} AND t.status='completed' AND t.completed_date BETWEEN ? AND ?
       ORDER BY t.completed_date DESC`,
      ctx.orgId, ...params, p.from, p.to,
    ).map((t) => {
      const cost = turnCost(t.id);
      return {
        completed: t.completed_date,
        property: t.prop,
        unit: t.unit_number,
        move_out: t.move_out_date,
        days: Math.round((Date.parse(t.completed_date) - Date.parse(t.move_out_date)) / 86400000),
        target_hit: t.completed_date <= t.target_ready_date ? 'on target' : 'late',
        est_cost: cost.est,
        actual_cost: cost.actual,
        __href: '/turns',
      };
    });
    const avgDays = rows.length ? Math.round(rows.reduce((s, r) => s + Number(r.days), 0) / rows.length) : 0;
    return {
      cols: [
        { key: 'completed', label: 'Ready', kind: 'date' },
        { key: 'property', label: 'Property' },
        { key: 'unit', label: 'Unit' },
        { key: 'move_out', label: 'Move-out', kind: 'date' },
        { key: 'days', label: 'Turn days', kind: 'num' },
        { key: 'target_hit', label: 'Target', kind: 'badge' },
        { key: 'est_cost', label: 'Estimated', kind: 'money', total: true },
        { key: 'actual_cost', label: 'Actual', kind: 'money', total: true },
      ],
      rows,
      note: `Average turn: ${avgDays} days across ${rows.length} completed turns in range.`,
    };
  },
});

registerReport({
  key: 'inspection_results',
  name: 'Inspection Results',
  category: 'Facilities',
  describe: 'Inspections by type and outcome, with damage charges posted.',
  params: [{ ...PROP, allowAll: true }, { key: 'from', kind: 'from', default: (ctx) => addMonths(ctx.businessDate, -6) }, { key: 'to', kind: 'to' }],
  perm: 'workorders:view',
  defaultGroup: 'type',
  run(ctx, p): ReportResult {
    const { sql, params } = propScope(ctx, p.property!, 'i.property_id');
    const rows = q<any>(
      `SELECT i.*, u.unit_number, p2.name AS prop FROM inspections i
       JOIN units u ON u.id=i.unit_id JOIN properties p2 ON p2.id=i.property_id
       WHERE i.org_id=?${sql} AND i.date BETWEEN ? AND ? ORDER BY i.date DESC LIMIT 400`,
      ctx.orgId, ...params, p.from, p.to,
    ).map((i) => {
      const items = q1<any>(
        `SELECT COUNT(*) AS n, SUM(CASE WHEN condition IN ('damaged','missing') THEN 1 ELSE 0 END) AS bad
         FROM inspection_items WHERE inspection_id=?`, i.id,
      );
      return {
        type: i.type.replaceAll('_', ' '),
        date: i.date,
        property: i.prop,
        unit: i.unit_number,
        status: i.status,
        items: items?.n ?? 0,
        issues: items?.bad ?? 0,
        damages_posted: i.damages_posted ? 'yes' : '—',
        __href: `/inspections/${i.id}`,
      };
    });
    return {
      cols: [
        { key: 'type', label: 'Type' },
        { key: 'date', label: 'Date', kind: 'date' },
        { key: 'property', label: 'Property' },
        { key: 'unit', label: 'Unit' },
        { key: 'status', label: 'Status', kind: 'badge' },
        { key: 'items', label: 'Items', kind: 'num' },
        { key: 'issues', label: 'Issues', kind: 'num', total: true },
        { key: 'damages_posted', label: 'Damages billed' },
      ],
      rows,
    };
  },
});

registerReport({
  key: 'inventory_valuation',
  name: 'Inventory Valuation & Usage',
  category: 'Facilities',
  describe: 'Stock on hand at cost, reorder flags and 90-day usage.',
  params: [{ ...PROP, allowAll: true }],
  perm: 'workorders:view',
  defaultSort: 'value',
  defaultDir: 'desc',
  run(ctx, p): ReportResult {
    const { sql, params } = propScope(ctx, p.property!, 'ii.property_id');
    const rows = q<any>(
      `SELECT ii.*, p2.name AS prop FROM inventory_items ii JOIN properties p2 ON p2.id=ii.property_id
       WHERE ii.org_id=?${sql} ORDER BY ii.name`,
      ctx.orgId, ...params,
    ).map((ii) => {
      const used90 = val<number>(
        `SELECT COALESCE(SUM(m.qty),0) FROM wo_materials m WHERE m.item_id=? AND m.created_at >= ?`,
        ii.id, addMonths(ctx.businessDate, -3),
      ) || 0;
      return {
        sku: ii.sku,
        item: ii.name,
        property: ii.prop,
        on_hand: ii.on_hand,
        unit_cost: ii.unit_cost_cents,
        value: ii.on_hand * ii.unit_cost_cents,
        used_90d: used90,
        reorder: ii.on_hand <= ii.min_qty ? 'REORDER' : 'ok',
        __href: '/inventory',
      };
    });
    return {
      cols: [
        { key: 'sku', label: 'SKU' },
        { key: 'item', label: 'Item' },
        { key: 'property', label: 'Property' },
        { key: 'on_hand', label: 'On hand', kind: 'num', total: true },
        { key: 'unit_cost', label: 'Unit cost', kind: 'money' },
        { key: 'value', label: 'Value', kind: 'money', total: true },
        { key: 'used_90d', label: 'Used (90d)', kind: 'num' },
        { key: 'reorder', label: 'Reorder', kind: 'badge' },
      ],
      rows,
    };
  },
});
