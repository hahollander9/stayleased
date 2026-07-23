import { q, q1, insert, val, run, update, tx } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, addDays, diffDays, fmtDate } from '../../lib/dates.ts';
import type { Ctx } from '../../lib/auth.ts';
import { emit, on } from '../../lib/events.ts';
import { registerJob } from '../../lib/jobs.ts';
import { sendSms } from '../../lib/sim/messaging.ts';
import { audit } from '../../lib/audit.ts';
import { postJE } from '../m9_accounting/service.ts';
import { createCharge } from '../m8_receivables/service.ts';

/** M10 services: WO state machine + SLA, turns, PM generation, inventory,
 * inspections→damages, vendor COI gating, analytics. */

export const WO_TRANSITIONS: Record<string, string[]> = {
  new: ['triaged', 'assigned', 'canceled'],
  triaged: ['assigned', 'canceled', 'on_hold'],
  assigned: ['scheduled', 'in_progress', 'on_hold', 'canceled', 'triaged'],
  scheduled: ['in_progress', 'on_hold', 'canceled', 'assigned'],
  in_progress: ['completed', 'on_hold'],
  on_hold: ['assigned', 'scheduled', 'in_progress', 'canceled'],
  completed: ['reopened'],
  reopened: ['assigned', 'scheduled', 'in_progress'],
  canceled: [],
};

export const SLA_HOURS: Record<string, number> = { emergency: 4, high: 24, normal: 72, low: 168 };

export function woEvent(ctx: Ctx, woId: string, kind: string, body: string, opts: { meta?: string; residentVisible?: boolean } = {}): void {
  insert('wo_events', {
    id: id('woe'), org_id: ctx.orgId, work_order_id: woId, kind, body,
    meta: opts.meta || null, actor: ctx.userName, visible_to_resident: opts.residentVisible === false ? 0 : 1,
    at: nowIso(), business_date: ctx.businessDate,
  });
}

export function transitionWo(ctx: Ctx, woId: string, to: string, note?: string): void {
  const wo = q1<any>('SELECT * FROM work_orders WHERE id=? AND org_id=?', woId, ctx.orgId);
  if (!wo) throw new Error('work order not found');
  const allowed = WO_TRANSITIONS[wo.status] || [];
  if (!allowed.includes(to)) throw new Error(`cannot move from ${wo.status} to ${to}`);
  const patch: Record<string, unknown> = { status: to };
  if (to === 'completed') {
    patch.completed_at = nowIso();
    patch.completed_date = ctx.businessDate;
  }
  update('work_orders', woId, patch);
  woEvent(ctx, woId, 'status', note || statusLabel(to));
  audit(ctx, 'work_order', woId, `status_${to}`, { status: wo.status }, { status: to });
  emit(ctx, `workorder.${to}`, 'work_order', woId, { propertyId: wo.property_id, category: wo.category, priority: wo.priority, leaseId: wo.lease_id });
  // resident-facing status updates land in the portal timeline now; email/SMS echoes arrive with M15 (Phase 13)
}

function statusLabel(s: string): string {
  const map: Record<string, string> = {
    triaged: 'Triaged', assigned: 'Assigned', scheduled: 'Scheduled', in_progress: 'Work started',
    on_hold: 'On hold', completed: 'Completed', canceled: 'Canceled', reopened: 'Reopened by request',
  };
  return map[s] || s;
}

export function triageWo(ctx: Ctx, woId: string, opts: { category?: string; priority: string }): void {
  const wo = q1<any>('SELECT * FROM work_orders WHERE id=? AND org_id=?', woId, ctx.orgId);
  if (!wo) throw new Error('not found');
  const sla = SLA_HOURS[opts.priority] ?? 72;
  update('work_orders', woId, {
    category: opts.category || wo.category,
    priority: opts.priority,
    sla_hours: sla,
    sla_due: addDays(ctx.businessDate, Math.max(0, Math.ceil(sla / 24))),
    status: wo.status === 'new' ? 'triaged' : wo.status,
  });
  woEvent(ctx, woId, 'status', `Triaged — ${opts.priority} priority${opts.category ? `, ${opts.category}` : ''}`);
  if (opts.priority === 'emergency') escalateEmergency(ctx, { ...wo, priority: 'emergency' });
}

export function assignWo(ctx: Ctx, woId: string, opts: { userId?: string; vendorId?: string; scheduledDate?: string }): void {
  const wo = q1<any>('SELECT * FROM work_orders WHERE id=? AND org_id=?', woId, ctx.orgId);
  if (!wo) throw new Error('not found');
  if (opts.vendorId) {
    const vendor = q1<any>('SELECT * FROM vendors WHERE id=? AND org_id=?', opts.vendorId, ctx.orgId);
    if (!vendor) throw new Error('vendor not found');
    if (vendor.coi_expiry && vendor.coi_expiry < ctx.businessDate) {
      throw new Error(`${vendor.name}'s insurance certificate expired ${fmtDate(vendor.coi_expiry)} — dispatch blocked until COI is renewed`);
    }
  }
  update('work_orders', woId, {
    assigned_to_user_id: opts.userId || null,
    vendor_id: opts.vendorId || null,
    scheduled_date: opts.scheduledDate || wo.scheduled_date,
    status: ['new', 'triaged', 'reopened', 'on_hold'].includes(wo.status) ? 'assigned' : wo.status,
    sla_due: wo.sla_due || addDays(ctx.businessDate, 3),
    sla_hours: wo.sla_hours || 72,
  });
  const who = opts.userId
    ? val<string>('SELECT name FROM users WHERE id=?', opts.userId)
    : val<string>('SELECT name FROM vendors WHERE id=?', opts.vendorId);
  woEvent(ctx, woId, 'assign', `Assigned to ${who}${opts.scheduledDate ? ` · scheduled ${fmtDate(opts.scheduledDate)}` : ''}`);
  emit(ctx, 'workorder.assigned', 'work_order', woId, { userId: opts.userId, vendorId: opts.vendorId });
}

function escalateEmergency(ctx: Ctx, wo: any): void {
  const oncall = q<any>(
    `SELECT u.* FROM users u JOIN role_assignments ra ON ra.user_id=u.id
     WHERE u.org_id=? AND ra.role IN ('MAINTENANCE_SUPERVISOR') AND u.active=1 LIMIT 2`,
    ctx.orgId,
  );
  for (const person of oncall) {
    if (person.phone || true) {
      sendSms(ctx, {
        to: person.phone || 'on-call', toUserId: person.id, toName: person.name,
        body: `🚨 EMERGENCY work order at ${val<string>('SELECT name FROM properties WHERE id=?', wo.property_id)}: "${wo.summary}" — open /workorders/${wo.id}`,
        propertyId: wo.property_id, entity: 'work_order', entityId: wo.id,
      });
    }
  }
  emit(ctx, 'workorder.emergency', 'work_order', wo.id, { summary: wo.summary });
}

// emergency portal requests escalate on arrival
on('maintenance.requested', (ctx, payload) => {
  if (payload.emergency) {
    const wo = q1<any>('SELECT * FROM work_orders WHERE id=?', payload.entityId);
    if (wo) {
      update('work_orders', wo.id, { sla_hours: 4, sla_due: ctx.businessDate });
      escalateEmergency(ctx, wo);
    }
  }
});

// ---------- materials & labor ----------

export function logMaterial(ctx: Ctx, woId: string, opts: { itemId?: string; description?: string; qty: number; unitCostCents?: number }): void {
  const wo = q1<any>('SELECT * FROM work_orders WHERE id=? AND org_id=?', woId, ctx.orgId);
  if (!wo) throw new Error('not found');
  let description = opts.description || 'Material';
  let unitCost = opts.unitCostCents ?? 0;
  tx(() => {
    if (opts.itemId) {
      const item = q1<any>('SELECT * FROM inventory_items WHERE id=? AND org_id=?', opts.itemId, ctx.orgId);
      if (!item) throw new Error('inventory item not found');
      description = item.name;
      unitCost = item.unit_cost_cents;
      run('UPDATE inventory_items SET on_hand = on_hand - ? WHERE id=?', opts.qty, item.id);
      insert('stock_moves', {
        id: id('stk'), org_id: ctx.orgId, item_id: item.id, kind: 'usage', qty: -opts.qty,
        work_order_id: woId, cost_cents: Math.round(unitCost * opts.qty), memo: wo.summary.slice(0, 60),
        created_by: ctx.userId, at: nowIso(), business_date: ctx.businessDate,
      });
      // GL reclass: supplies → R&M (or turn expense for turn WOs)
      const total = Math.round(unitCost * opts.qty);
      if (total > 0) {
        postJE(ctx, {
          propertyId: wo.property_id, date: ctx.businessDate, basis: 'accrual',
          memo: `Materials — ${description} ×${opts.qty} (WO ${woId.slice(-6)})`, sourceKind: 'inventory_usage', sourceId: woId,
          lines: [
            { account: wo.category === 'turn' ? '5020' : '5010', debit: total },
            { account: '5910', credit: total },
          ],
        });
        postJE(ctx, {
          propertyId: wo.property_id, date: ctx.businessDate, basis: 'cash',
          memo: `Materials — ${description} ×${opts.qty} (WO ${woId.slice(-6)})`, sourceKind: 'inventory_usage', sourceId: woId,
          lines: [
            { account: wo.category === 'turn' ? '5020' : '5010', debit: total },
            { account: '5910', credit: total },
          ],
        });
      }
    }
    const total = Math.round(unitCost * opts.qty);
    insert('wo_materials', {
      id: id('wom'), org_id: ctx.orgId, work_order_id: woId, item_id: opts.itemId || null,
      description, qty: opts.qty, unit_cost_cents: unitCost, total_cents: total,
      created_by: ctx.userId, created_at: nowIso(),
    });
    woEvent(ctx, woId, 'material', `${description} ×${opts.qty}`, { residentVisible: false });
  });
}

export function logLabor(ctx: Ctx, woId: string, opts: { userId: string; hours: number; rateCents?: number; note?: string }): void {
  const rate = opts.rateCents ?? 4500;
  insert('wo_labor', {
    id: id('wol'), org_id: ctx.orgId, work_order_id: woId, user_id: opts.userId,
    hours: opts.hours, rate_cents: rate, total_cents: Math.round(rate * opts.hours),
    note: opts.note || null, created_at: nowIso(),
  });
  woEvent(ctx, woId, 'labor', `${opts.hours}h labor logged`, { residentVisible: false });
}

export function woCost(woId: string): number {
  const m = val<number>('SELECT COALESCE(SUM(total_cents),0) FROM wo_materials WHERE work_order_id=?', woId) || 0;
  const l = val<number>('SELECT COALESCE(SUM(total_cents),0) FROM wo_labor WHERE work_order_id=?', woId) || 0;
  return m + l;
}

// ---------- turns (M10.5) ----------

export const TURN_STAGES = ['inspect', 'punch', 'paint', 'clean', 'floors', 'final_qc'] as const;

export function createTurn(ctx: Ctx, opts: { unitId: string; leaseId?: string; moveOut: string; nextMoveIn?: string | null }): string {
  const unit = q1<any>('SELECT * FROM units WHERE id=? AND org_id=?', opts.unitId, ctx.orgId);
  if (!unit) throw new Error('unit not found');
  const existing = q1<any>(`SELECT id FROM turns WHERE unit_id=? AND status IN ('scheduled','in_progress')`, opts.unitId);
  if (existing) return existing.id as string;
  const turnId = id('trn');
  const target = opts.nextMoveIn ? addDays(opts.nextMoveIn, -1) : addDays(opts.moveOut, 7);
  tx(() => {
    insert('turns', {
      id: turnId, org_id: ctx.orgId, property_id: unit.property_id, unit_id: unit.id, lease_id: opts.leaseId || null,
      move_out_date: opts.moveOut, target_ready_date: target, next_move_in_date: opts.nextMoveIn || null,
      status: 'scheduled', created_at: nowIso(),
    });
    const estimates: Record<string, number> = { inspect: 0, punch: 15000, paint: 42000, clean: 18000, floors: 25000, final_qc: 0 };
    TURN_STAGES.forEach((name, i) => {
      insert('turn_tasks', {
        id: id('ttk'), org_id: ctx.orgId, turn_id: turnId, seq: i + 1, name,
        status: 'pending', est_cost_cents: estimates[name] || 0, created_at: nowIso(),
      });
    });
  });
  emit(ctx, 'turn.created', 'turn', turnId, { unitId: unit.id, target });
  return turnId;
}

// notice → turn pipeline (the M10.5 trigger)
on('lease.notice', (ctx, payload) => {
  if (payload.unitId && payload.moveOut) {
    createTurn(ctx, { unitId: payload.unitId as string, leaseId: payload.entityId, moveOut: payload.moveOut as string });
  }
});

export function advanceTurnTask(ctx: Ctx, taskId: string, opts: { status: string; actualCostCents?: number; assignUserId?: string; vendorId?: string }): void {
  const task = q1<any>('SELECT t.*, tr.unit_id, tr.property_id, tr.id AS turn_id FROM turn_tasks t JOIN turns tr ON tr.id=t.turn_id WHERE t.id=? AND t.org_id=?', taskId, ctx.orgId);
  if (!task) throw new Error('task not found');
  if (opts.vendorId) {
    const vendor = q1<any>('SELECT * FROM vendors WHERE id=?', opts.vendorId);
    if (vendor?.coi_expiry && vendor.coi_expiry < ctx.businessDate) throw new Error(`${vendor.name} COI expired — cannot assign`);
  }
  update('turn_tasks', taskId, {
    status: opts.status,
    actual_cost_cents: opts.actualCostCents ?? task.actual_cost_cents,
    assigned_to_user_id: opts.assignUserId ?? task.assigned_to_user_id,
    vendor_id: opts.vendorId ?? task.vendor_id,
    completed_date: opts.status === 'done' ? ctx.businessDate : task.completed_date,
  });
  // GL: actual cost posts to turn expense when a task completes with cost
  const cost = opts.actualCostCents ?? 0;
  if (opts.status === 'done' && cost > 0) {
    for (const basis of ['accrual', 'cash'] as const) {
      postJE(ctx, {
        propertyId: task.property_id, date: ctx.businessDate, basis,
        memo: `Turn ${task.name} — unit ${val<string>('SELECT unit_number FROM units WHERE id=?', task.unit_id)}`,
        sourceKind: 'turn_cost', sourceId: task.turn_id,
        lines: [
          { account: '5020', debit: cost },
          { account: '2200', credit: cost }, // accrued until vendor invoice clears via AP (M16)
        ],
      });
    }
  }
  // turn status roll-forward
  const tasks = q<any>('SELECT * FROM turn_tasks WHERE turn_id=? ORDER BY seq', task.turn_id);
  const allDone = tasks.every((t) => ['done', 'skipped'].includes(t.status));
  const anyStarted = tasks.some((t) => t.status !== 'pending');
  if (allDone) {
    update('turns', task.turn_id, { status: 'ready', completed_date: ctx.businessDate });
    run("UPDATE units SET status='vacant_ready' WHERE id=? AND status IN ('vacant_not_ready','notice')", task.unit_id);
    emit(ctx, 'turn.ready', 'turn', task.turn_id, { unitId: task.unit_id });
    audit(ctx, 'turn', task.turn_id, 'ready');
  } else if (anyStarted) {
    run("UPDATE turns SET status='in_progress' WHERE id=? AND status='scheduled'", task.turn_id);
  }
}

export function turnCost(turnId: string): { est: number; actual: number } {
  const row = q1<any>('SELECT SUM(est_cost_cents) e, SUM(actual_cost_cents) a FROM turn_tasks WHERE turn_id=?', turnId);
  return { est: Number(row?.e || 0), actual: Number(row?.a || 0) };
}

// ---------- move-outs advance leases/units (drives the turn board) ----------

registerJob({
  key: 'lease_moveouts',
  name: 'Move-out processing',
  describe: 'Ends leases whose move-out date has arrived; unit goes vacant-not-ready and the turn pipeline takes over.',
  run: (ctx, date) => {
    const due = q<any>(
      `SELECT * FROM leases WHERE org_id=? AND status='notice' AND move_out_date<=?`,
      ctx.orgId, date,
    );
    for (const lease of due) {
      run("UPDATE leases SET status='ended' WHERE id=?", lease.id);
      run("UPDATE units SET status='vacant_not_ready' WHERE id=? AND status='notice'", lease.unit_id);
      emit(ctx, 'lease.ended', 'lease', lease.id, { unitId: lease.unit_id, propertyId: lease.property_id });
    }
    return due.length ? `${due.length} move-outs processed` : 'no move-outs today';
  },
});

// ---------- preventive maintenance ----------

registerJob({
  key: 'pm_generator',
  name: 'Preventive maintenance generator',
  describe: 'Creates work orders from PM schedules when they come due; advances the next-due date.',
  run: (ctx, date) => {
    const due = q<any>(`SELECT * FROM pm_schedules WHERE org_id=? AND active=1 AND next_due<=?`, ctx.orgId, date);
    for (const pm of due) {
      const woId = id('wo');
      insert('work_orders', {
        id: woId, org_id: ctx.orgId, property_id: pm.property_id, unit_id: null, lease_id: null, resident_id: null,
        category: pm.category, priority: 'normal', status: pm.assigned_to_user_id ? 'assigned' : 'triaged',
        summary: `PM: ${pm.name}`, description: pm.instructions,
        permission_to_enter: 1, pet_on_premises: 0, source: 'pm', pm_schedule_id: pm.id,
        assigned_to_user_id: pm.assigned_to_user_id || null,
        sla_hours: 168, sla_due: addDays(date, 7), created_date: date, created_by: 'scheduler', created_at: nowIso(),
      });
      insert('wo_events', {
        id: id('woe'), org_id: ctx.orgId, work_order_id: woId, kind: 'status', body: `Generated from PM schedule "${pm.name}"`,
        actor: 'Scheduler', visible_to_resident: 0, at: nowIso(), business_date: date,
      });
      run('UPDATE pm_schedules SET next_due=? WHERE id=?', addDays(pm.next_due, pm.freq_days), pm.id);
      emit(ctx, 'workorder.created', 'work_order', woId, { source: 'pm' });
    }
    return due.length ? `${due.length} PM work orders generated` : 'no PM due';
  },
});

// ---------- inspections → damage charges (M10.6) ----------

export const INSPECTION_TEMPLATES: Record<string, { area: string; items: string[] }[]> = {
  move_in: [
    { area: 'Kitchen', items: ['Appliances', 'Counters & cabinets', 'Sink & faucet', 'Flooring'] },
    { area: 'Living room', items: ['Walls & paint', 'Flooring / carpet', 'Windows & blinds', 'Doors'] },
    { area: 'Bedroom(s)', items: ['Walls & paint', 'Flooring / carpet', 'Closet doors', 'Windows & blinds'] },
    { area: 'Bathroom(s)', items: ['Tub & tile', 'Toilet', 'Vanity & sink', 'Exhaust fan'] },
    { area: 'General', items: ['Smoke/CO detectors', 'HVAC filter', 'Keys & locks', 'Light fixtures'] },
  ],
  move_out: [
    { area: 'Kitchen', items: ['Appliances', 'Counters & cabinets', 'Sink & faucet', 'Flooring'] },
    { area: 'Living room', items: ['Walls & paint', 'Flooring / carpet', 'Windows & blinds', 'Doors'] },
    { area: 'Bedroom(s)', items: ['Walls & paint', 'Flooring / carpet', 'Closet doors', 'Windows & blinds'] },
    { area: 'Bathroom(s)', items: ['Tub & tile', 'Toilet', 'Vanity & sink', 'Exhaust fan'] },
    { area: 'General', items: ['Smoke/CO detectors', 'Cleanliness', 'Keys returned', 'Light fixtures'] },
  ],
  quarterly: [
    { area: 'Safety', items: ['Smoke/CO detectors', 'GFCI outlets', 'Water heater', 'Leaks under sinks'] },
    { area: 'HVAC', items: ['Filter replaced', 'Thermostat', 'Vents clear'] },
  ],
  grounds: [
    { area: 'Exterior', items: ['Landscaping', 'Walkways & trip hazards', 'Lighting', 'Signage'] },
    { area: 'Common areas', items: ['Hallways', 'Amenities', 'Trash areas', 'Parking'] },
  ],
};

export function createInspection(ctx: Ctx, opts: { unitId: string; type: string; leaseId?: string | null }): string {
  const unit = q1<any>('SELECT * FROM units WHERE id=? AND org_id=?', opts.unitId, ctx.orgId);
  if (!unit) throw new Error('unit not found');
  const inspId = id('ins');
  tx(() => {
    insert('inspections', {
      id: inspId, org_id: ctx.orgId, property_id: unit.property_id, unit_id: unit.id,
      lease_id: opts.leaseId || null, type: opts.type, status: 'in_progress',
      inspector_user_id: ctx.userId, date: ctx.businessDate, created_at: nowIso(),
    });
    for (const section of INSPECTION_TEMPLATES[opts.type] || INSPECTION_TEMPLATES['quarterly']!) {
      for (const item of section.items) {
        insert('inspection_items', {
          id: id('ini'), org_id: ctx.orgId, inspection_id: inspId, area: section.area, item,
          condition: 'good', created_at: nowIso(),
        });
      }
    }
  });
  return inspId;
}

/** post move-out damages to the vacating lease's ledger → deposit disposition */
export function postInspectionDamages(ctx: Ctx, inspectionId: string): number {
  const insp = q1<any>('SELECT * FROM inspections WHERE id=? AND org_id=?', inspectionId, ctx.orgId);
  if (!insp) throw new Error('inspection not found');
  if (insp.type !== 'move_out' || !insp.lease_id) throw new Error('damages post from move-out inspections tied to a lease');
  if (insp.damages_posted) throw new Error('damages already posted');
  const items = q<any>(`SELECT * FROM inspection_items WHERE inspection_id=? AND charge_cents>0`, inspectionId);
  for (const item of items) {
    createCharge(ctx, {
      leaseId: insp.lease_id, kind: 'damage', label: `${item.area}: ${item.item}${item.note ? ` — ${item.note}` : ''}`,
      amountCents: item.charge_cents, date: ctx.businessDate, source: 'damage',
    });
  }
  run('UPDATE inspections SET damages_posted=1 WHERE id=?', inspectionId);
  audit(ctx, 'inspection', inspectionId, 'damages_posted', null, { count: items.length });
  return items.length;
}

// ---------- analytics ----------

export interface FacilitiesStats {
  open: number;
  emergencies: number;
  overSla: number;
  slaCompliance30d: number;
  avgDaysToComplete: number;
  costPerUnit30d: number;
  avgRating: number;
}

export function facilitiesStats(ctx: Ctx, propertyId?: string | null): FacilitiesStats {
  const propSql = propertyId ? ' AND property_id=?' : '';
  const p = propertyId ? [propertyId] : [];
  const open = val<number>(`SELECT COUNT(*) FROM work_orders WHERE org_id=? AND status NOT IN ('completed','canceled')${propSql}`, ctx.orgId, ...p) || 0;
  const emergencies = val<number>(`SELECT COUNT(*) FROM work_orders WHERE org_id=? AND status NOT IN ('completed','canceled') AND priority='emergency'${propSql}`, ctx.orgId, ...p) || 0;
  const overSla = val<number>(`SELECT COUNT(*) FROM work_orders WHERE org_id=? AND status NOT IN ('completed','canceled') AND sla_due IS NOT NULL AND sla_due < ?${propSql}`, ctx.orgId, ctx.businessDate, ...p) || 0;
  const d30 = addDays(ctx.businessDate, -30);
  const completed30 = q<any>(`SELECT * FROM work_orders WHERE org_id=? AND status='completed' AND completed_date>=?${propSql}`, ctx.orgId, d30, ...p);
  const inSla = completed30.filter((w) => !w.sla_due || (w.completed_date && w.completed_date <= w.sla_due)).length;
  const days = completed30.map((w) => Math.max(0, diffDays(w.completed_date, w.created_date)));
  const cost30 = val<number>(
    `SELECT COALESCE(SUM(m.total_cents),0) FROM wo_materials m JOIN work_orders w ON w.id=m.work_order_id WHERE w.org_id=? AND w.completed_date>=?${propSql.replaceAll('property_id', 'w.property_id')}`,
    ctx.orgId, d30, ...p,
  ) || 0;
  const labor30 = val<number>(
    `SELECT COALESCE(SUM(l.total_cents),0) FROM wo_labor l JOIN work_orders w ON w.id=l.work_order_id WHERE w.org_id=? AND w.completed_date>=?${propSql.replaceAll('property_id', 'w.property_id')}`,
    ctx.orgId, d30, ...p,
  ) || 0;
  const units = val<number>(`SELECT COUNT(*) FROM units WHERE org_id=?${propSql}`, ctx.orgId, ...p) || 1;
  const ratings = q<any>(`SELECT rating FROM work_orders WHERE org_id=? AND rating IS NOT NULL${propSql}`, ctx.orgId, ...p);
  return {
    open, emergencies, overSla,
    slaCompliance30d: completed30.length ? Math.round((inSla / completed30.length) * 100) : 100,
    avgDaysToComplete: days.length ? Math.round((days.reduce((s, x) => s + x, 0) / days.length) * 10) / 10 : 0,
    costPerUnit30d: Math.round((cost30 + labor30) / units),
    avgRating: ratings.length ? Math.round((ratings.reduce((s, x) => s + x.rating, 0) / ratings.length) * 10) / 10 : 0,
  };
}

