import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureFinance, type FinanceFx } from './harness.ts';
import { sysCtx } from '../src/lib/auth.ts';
import { q, q1, insert, run, val } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso, addDays } from '../src/lib/dates.ts';
import {
  transitionWo, assignWo, triageWo, logMaterial, woCost, createTurn, advanceTurnTask,
  createInspection, postInspectionDamages, TURN_STAGES,
} from '../src/modules/m10_facilities/service.ts';
import { leaseBalance } from '../src/modules/m8_receivables/service.ts';
import '../src/modules/m10_facilities/service.ts';

let fx: FinanceFx;
const D = '2026-07-26';

function mkWo(status = 'new'): string {
  const woId = id('wo');
  insert('work_orders', {
    id: woId, org_id: fx.orgId, property_id: fx.propId, unit_id: fx.unitId, lease_id: fx.leaseId,
    category: 'plumbing', priority: 'normal', status, summary: 'Test WO', permission_to_enter: 1,
    pet_on_premises: 0, source: 'staff', created_date: D, created_by: 'test', created_at: nowIso(),
  });
  return woId;
}

before(() => {
  fx = fixtureFinance();
});

test('work order state machine enforces legal transitions', () => {
  const ctx = sysCtx(fx.orgId, D);
  const wo = mkWo('new');
  assert.throws(() => transitionWo(ctx, wo, 'completed'), /cannot move/);
  triageWo(ctx, wo, { priority: 'high' });
  assert.equal(q1<any>('SELECT status, sla_hours FROM work_orders WHERE id=?', wo)!.sla_hours, 24);
  transitionWo(ctx, wo, 'assigned');
  transitionWo(ctx, wo, 'in_progress');
  transitionWo(ctx, wo, 'completed');
  transitionWo(ctx, wo, 'reopened');
  assert.equal(q1<any>('SELECT status FROM work_orders WHERE id=?', wo)!.status, 'reopened');
});

test('expired COI blocks vendor dispatch', () => {
  const ctx = sysCtx(fx.orgId, D);
  const vid = id('ven');
  insert('vendors', {
    id: vid, org_id: fx.orgId, name: 'Lapsed LLC', category: 'plumbing',
    coi_expiry: addDays(D, -10), w9_on_file: 1, is_1099: 1, active: 1, created_at: nowIso(),
  });
  const wo = mkWo('triaged');
  assert.throws(() => assignWo(ctx, wo, { vendorId: vid }), /COI|expired|insurance/i);
  run('UPDATE vendors SET coi_expiry=? WHERE id=?', addDays(D, 200), vid);
  assignWo(ctx, wo, { vendorId: vid });
  assert.equal(q1<any>('SELECT vendor_id FROM work_orders WHERE id=?', wo)!.vendor_id, vid);
});

test('material usage decrements stock and posts GL reclass', () => {
  const ctx = sysCtx(fx.orgId, D);
  const item = id('inv');
  insert('inventory_items', {
    id: item, org_id: fx.orgId, property_id: fx.propId, sku: 'T-1', name: 'Test part', category: 'plumbing',
    unit_cost_cents: 2500, on_hand: 10, min_qty: 2, max_qty: 20, created_at: nowIso(),
  });
  const wo = mkWo('in_progress');
  logMaterial(ctx, wo, { itemId: item, qty: 2 });
  assert.equal(q1<any>('SELECT on_hand FROM inventory_items WHERE id=?', item)!.on_hand, 8);
  assert.equal(woCost(wo), 5000);
  const je = q1<any>(`SELECT * FROM journal_entries WHERE source_kind='inventory_usage' AND source_id=? AND basis='accrual'`, wo);
  assert.ok(je, 'GL reclass posted');
});

test('turn pipeline completes → unit vacant_ready', () => {
  const ctx = sysCtx(fx.orgId, D);
  run("UPDATE units SET status='vacant_not_ready' WHERE id=?", fx.unitId);
  const turnId = createTurn(ctx, { unitId: fx.unitId, moveOut: addDays(D, -5) });
  const tasks = q<any>('SELECT * FROM turn_tasks WHERE turn_id=? ORDER BY seq', turnId);
  assert.equal(tasks.length, TURN_STAGES.length);
  for (const task of tasks) advanceTurnTask(ctx, task.id, { status: 'done', actualCostCents: 1000 });
  assert.equal(q1<any>('SELECT status FROM turns WHERE id=?', turnId)!.status, 'ready');
  assert.equal(q1<any>('SELECT status FROM units WHERE id=?', fx.unitId)!.status, 'vacant_ready');
  run("UPDATE units SET status='occupied' WHERE id=?", fx.unitId); // restore for other tests
});

test('move-out inspection damages post to the resident ledger', () => {
  const ctx = sysCtx(fx.orgId, D);
  const before = leaseBalance(ctx, fx.leaseId);
  const insp = createInspection(ctx, { unitId: fx.unitId, type: 'move_out', leaseId: fx.leaseId });
  const items = q<any>('SELECT * FROM inspection_items WHERE inspection_id=? LIMIT 2', insp);
  run(`UPDATE inspection_items SET condition='damaged', charge_cents=12000, note='broken blinds' WHERE id=?`, items[0]!.id);
  run(`UPDATE inspection_items SET condition='missing', charge_cents=5000 WHERE id=?`, items[1]!.id);
  const n = postInspectionDamages(ctx, insp);
  assert.equal(n, 2);
  assert.equal(leaseBalance(ctx, fx.leaseId), before + 17000);
  assert.throws(() => postInspectionDamages(ctx, insp), /already posted/);
});
