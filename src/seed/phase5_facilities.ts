import { q, q1, insert, run, val, tx } from '../lib/db.ts';
import { id } from '../lib/ids.ts';
import { nowIso, addDays, monthKey, fmtDate } from '../lib/dates.ts';
import { hashPassword, sysCtx } from '../lib/auth.ts';
import { createTurn, advanceTurnTask, createInspection, SLA_HOURS } from '../modules/m10_facilities/service.ts';
import { VENDOR_NAMES } from './names.ts';
import type { SeedCtx } from './seed.ts';
import { log } from './seed.ts';

/** Phase 5 seed (§8): vendors (Pinnacle Plumbing COI expiring soon), 35 open
 * + ~600 historical work orders, PM schedules, inventory, active turn
 * pipeline from notice leases, inspections. */

const WO_POOL: [string, string, string][] = [
  // category, summary, description
  ['plumbing', 'Kitchen sink draining slowly', 'Standing water after dishes.'],
  ['plumbing', 'Toilet runs constantly', 'Flapper likely worn.'],
  ['plumbing', 'Leak under bathroom vanity', 'Small drip, towel placed.'],
  ['hvac', 'AC not cooling below 78', 'Filter changed recently, still warm.'],
  ['hvac', 'Furnace making rattling noise', 'Noise on startup.'],
  ['appliance', 'Dishwasher not draining', 'Water pools after cycle.'],
  ['appliance', 'Refrigerator too warm', 'Milk spoiling early.'],
  ['appliance', 'Garbage disposal jammed', 'Humming but not spinning.'],
  ['electrical', 'Outlet not working in bedroom', 'Tried the breaker already.'],
  ['electrical', 'Hallway light flickering', 'New bulb did not help.'],
  ['doors_locks', 'Deadbolt sticking', 'Key hard to turn.'],
  ['doors_locks', 'Patio door off track', 'Hard to slide.'],
  ['pest', 'Ants in kitchen', 'Near the window sill.'],
  ['grounds', 'Sprinkler head broken', 'Spraying the sidewalk.'],
  ['grounds', 'Parking lot light out', 'Near building B.'],
  ['safety', 'Smoke detector chirping', 'Battery replaced, still chirps.'],
  ['other', 'Blinds cord broken', 'Bedroom window.'],
];

export function seedFacilities(s: SeedCtx): void {
  const t0 = Date.now();
  const props = q<any>('SELECT * FROM properties WHERE org_id=? ORDER BY created_at', s.orgId);
  const rng = s.rng.fork(555);

  // ---------- vendors ----------
  const vendorIds: string[] = [];
  tx(() => {
    VENDOR_NAMES.forEach(([name, category], i) => {
      const vid = id('ven');
      const isPinnacle = name === 'Pinnacle Plumbing';
      insert('vendors', {
        id: vid, org_id: s.orgId, name, category,
        phone: `(555) ${rng.int(300, 899)}-${rng.int(1000, 9999)}`,
        email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@vendor.demo`,
        address: `${rng.int(100, 999)} Commerce Way`,
        tin_last4: String(rng.int(1000, 9999)), w9_on_file: rng.chance(0.85) ? 1 : 0, is_1099: 1,
        coi_expiry: isPinnacle ? addDays(s.businessDate, 12) : rng.chance(0.12) ? addDays(s.businessDate, -rng.int(5, 60)) : addDays(s.businessDate, rng.int(60, 400)),
        banking: JSON.stringify({ routing: '110000000', account: `····${rng.int(1000, 9999)}` }),
        active: 1, created_at: nowIso(),
      });
      vendorIds.push(vid);
      if (isPinnacle) {
        const uid = id('usr');
        insert('users', {
          id: uid, org_id: s.orgId, email: 'vendor@summitridge.demo', name: 'Pinnacle Plumbing (portal)',
          kind: 'vendor', vendor_id: vid, password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
        });
        s.demoLogins.push(['Vendor (Pinnacle Plumbing)', 'vendor@summitridge.demo', 'COI expiring in 12 days']);
      }
    });
  });

  // ---------- inventory ----------
  const stock: [string, string, string, number, number, number][] = [
    ['FLT-2025', 'HVAC filter 20×25', 'hvac', 900, 12, 40],
    ['FLT-1620', 'HVAC filter 16×20', 'hvac', 750, 10, 30],
    ['GD-05', 'Garbage disposal 1/2HP', 'appliance', 8900, 2, 6],
    ['WAX-STD', 'Toilet wax ring', 'plumbing', 400, 6, 20],
    ['FLAP-2', 'Toilet flapper', 'plumbing', 650, 8, 24],
    ['PAINT-SW', 'Paint — swiss coffee (gal)', 'turn', 3200, 8, 30],
    ['BLIND-STD', 'Blinds 36" white', 'other', 2200, 4, 16],
    ['LOCK-KWK', 'Deadbolt kwikset', 'doors_locks', 2800, 3, 12],
    ['SMK-9V', 'Smoke detector 9V', 'safety', 1500, 6, 24],
    ['LED-A19', 'LED bulb A19 (4pk)', 'electrical', 1100, 10, 40],
  ];
  tx(() => {
    for (const p of props) {
      for (const [sku, name, category, cost, min, max] of stock) {
        insert('inventory_items', {
          id: id('inv'), org_id: s.orgId, property_id: p.id, sku, name, category,
          bin: `${String.fromCharCode(65 + rng.int(0, 3))}-${rng.int(1, 12)}`,
          unit_cost_cents: cost, on_hand: rng.int(min - 1, max), min_qty: min, max_qty: max, created_at: nowIso(),
        });
      }
    }
  });

  // ---------- PM schedules ----------
  const techs = q<any>(
    `SELECT u.id, u.name FROM users u JOIN role_assignments ra ON ra.user_id=u.id WHERE u.org_id=? AND ra.role='MAINTENANCE_TECH'`,
    s.orgId,
  );
  tx(() => {
    for (const p of props) {
      const pmDefs: [string, string, number][] = [
        ['HVAC filter change — all units', 'hvac', 90],
        ['Gutter & roof drain clearing', 'grounds', 180],
        ['Fire extinguisher inspection', 'safety', 365],
        ['Common area deep clean', 'grounds', 30],
      ];
      pmDefs.forEach(([name, category, freq], i) => {
        insert('pm_schedules', {
          id: id('pms'), org_id: s.orgId, property_id: p.id, name, category,
          instructions: `Recurring preventive task: ${name.toLowerCase()}.`,
          // first schedule per property comes due within days → date-advance demo always fires
          freq_days: freq, next_due: i === 0 ? addDays(s.businessDate, 2) : addDays(s.businessDate, rng.int(5, freq)),
          assigned_to_user_id: techs.length ? techs[i % techs.length]!.id : null, active: 1, created_at: nowIso(),
        });
      });
    }
  });

  // ---------- historical + open work orders ----------
  const leases = q<any>(
    `SELECT l.id, l.unit_id, l.property_id, hm.resident_id FROM leases l
     LEFT JOIN household_members hm ON hm.lease_id=l.id AND hm.role='primary'
     WHERE l.org_id=? AND l.status IN ('active','month_to_month','notice')`,
    s.orgId,
  );
  let historical = 0;
  let open = 0;
  tx(() => {
    // ~600 completed over 14 months
    for (let i = 0; i < 600; i++) {
      const lease = rng.pick(leases);
      const [category, summary, description] = rng.pick(WO_POOL);
      const created = addDays(s.businessDate, -rng.int(4, 420));
      const days = rng.weighted([[0, 15], [1, 30], [2, 22], [3, 14], [5, 10], [8, 6], [14, 3]] as const);
      const completed = addDays(created, days);
      if (completed > s.businessDate) continue;
      const tech = techs.length ? rng.pick(techs) : null;
      const priority = rng.weighted([['normal', 78], ['high', 14], ['low', 6], ['emergency', 2]] as const);
      const woId = id('wo');
      insert('work_orders', {
        id: woId, org_id: s.orgId, property_id: lease.property_id, unit_id: lease.unit_id, lease_id: lease.id,
        resident_id: lease.resident_id, category, priority, status: 'completed', summary, description,
        permission_to_enter: rng.chance(0.85) ? 1 : 0, pet_on_premises: rng.chance(0.25) ? 1 : 0,
        source: rng.weighted([['portal', 70], ['staff', 25], ['phone', 5]] as const),
        assigned_to_user_id: tech?.id || null, sla_hours: SLA_HOURS[priority], sla_due: addDays(created, Math.ceil(SLA_HOURS[priority]! / 24)),
        created_date: created, completed_at: nowIso(), completed_date: completed,
        rating: rng.chance(0.55) ? rng.weighted([[5, 52], [4, 30], [3, 11], [2, 5], [1, 2]] as const) : null,
        created_by: 'seed', created_at: nowIso(),
      });
      insert('wo_events', { id: id('woe'), org_id: s.orgId, work_order_id: woId, kind: 'status', body: 'Request received', actor: 'Resident', visible_to_resident: 1, at: nowIso(), business_date: created });
      insert('wo_events', { id: id('woe'), org_id: s.orgId, work_order_id: woId, kind: 'status', body: 'Completed', actor: tech?.name || 'Staff', visible_to_resident: 1, at: nowIso(), business_date: completed });
      if (rng.chance(0.4)) {
        insert('wo_labor', { id: id('wol'), org_id: s.orgId, work_order_id: woId, user_id: tech?.id || 'seed', hours: rng.pick([0.5, 1, 1.5, 2] as const), rate_cents: 4500, total_cents: 0, created_at: nowIso() });
        run('UPDATE wo_labor SET total_cents = CAST(hours * rate_cents AS INTEGER) WHERE work_order_id=?', woId);
      }
      historical++;
    }

    // 35 open in varied states
    const states: [string, number][] = [['new', 8], ['triaged', 6], ['assigned', 9], ['scheduled', 6], ['in_progress', 4], ['on_hold', 2]];
    for (const [status, count] of states) {
      for (let i = 0; i < count; i++) {
        const lease = rng.pick(leases);
        const [category, summary, description] = rng.pick(WO_POOL);
        const created = addDays(s.businessDate, -rng.int(0, 12));
        const tech = ['assigned', 'scheduled', 'in_progress'].includes(status) && techs.length ? rng.pick(techs) : null;
        const priority = rng.weighted([['normal', 70], ['high', 20], ['low', 8], ['emergency', 2]] as const);
        const woId = id('wo');
        insert('work_orders', {
          id: woId, org_id: s.orgId, property_id: lease.property_id, unit_id: lease.unit_id, lease_id: lease.id,
          resident_id: lease.resident_id, category, priority, status, summary, description,
          permission_to_enter: rng.chance(0.85) ? 1 : 0, pet_on_premises: rng.chance(0.25) ? 1 : 0,
          source: 'portal', assigned_to_user_id: tech?.id || null,
          scheduled_date: status === 'scheduled' ? addDays(s.businessDate, rng.int(0, 4)) : null,
          sla_hours: SLA_HOURS[priority], sla_due: addDays(created, Math.ceil(SLA_HOURS[priority]! / 24)),
          created_date: created, created_by: 'seed', created_at: nowIso(),
        });
        insert('wo_events', { id: id('woe'), org_id: s.orgId, work_order_id: woId, kind: 'status', body: 'Request received', actor: 'Resident', visible_to_resident: 1, at: nowIso(), business_date: created });
        if (tech) insert('wo_events', { id: id('woe'), org_id: s.orgId, work_order_id: woId, kind: 'assign', body: `Assigned to ${tech.name}`, actor: 'Gus Romero', visible_to_resident: 1, at: nowIso(), business_date: created });
        open++;
      }
    }
  });

  // dedicated My-Day demo WO for Sam Whitaker (deterministic e2e + demo)
  const sam = q1<any>(`SELECT id FROM users WHERE email='tech@summitridge.demo'`);
  const samLease = q1<any>(
    `SELECT l.id, l.unit_id, l.property_id FROM leases l JOIN properties p ON p.id=l.property_id
     WHERE l.org_id=? AND l.status='active' AND p.slug='summit-ridge' AND l.id != ? LIMIT 1`,
    s.orgId, q1<any>(`SELECT lease_id FROM household_members hm JOIN residents r ON r.id=hm.resident_id WHERE r.email='maya.torres@mail.demo'`)?.lease_id || '',
  );
  if (sam && samLease) {
    const woId = id('wo');
    insert('work_orders', {
      id: woId, org_id: s.orgId, property_id: samLease.property_id, unit_id: samLease.unit_id, lease_id: samLease.id,
      resident_id: null, category: 'plumbing', priority: 'high', status: 'scheduled',
      summary: 'Water heater pilot light out', description: 'No hot water since this morning; resident available all day.',
      permission_to_enter: 1, pet_on_premises: 0, source: 'phone', assigned_to_user_id: sam.id,
      scheduled_date: s.businessDate, sla_hours: 24, sla_due: s.businessDate,
      created_date: s.businessDate, created_by: 'seed', created_at: nowIso(),
    });
    insert('wo_events', { id: id('woe'), org_id: s.orgId, work_order_id: woId, kind: 'status', body: 'Request received by phone', actor: 'Elena Ruiz', visible_to_resident: 1, at: nowIso(), business_date: s.businessDate });
    insert('wo_events', { id: id('woe'), org_id: s.orgId, work_order_id: woId, kind: 'assign', body: 'Assigned to Sam Whitaker — today', actor: 'Gus Romero', visible_to_resident: 1, at: nowIso(), business_date: s.businessDate });
  }

  // ---------- turn pipeline from current notice leases ----------
  const ctx = sysCtx(s.orgId);
  const noticeLeases = q<any>(`SELECT * FROM leases WHERE org_id=? AND status='notice'`, s.orgId);
  let turns = 0;
  for (const lease of noticeLeases) {
    const turnId = createTurn(ctx, { unitId: lease.unit_id, leaseId: lease.id, moveOut: lease.move_out_date });
    turns++;
    // move-outs already past → advance some tasks realistically
    if (lease.move_out_date <= s.businessDate) {
      const tasks = q<any>('SELECT * FROM turn_tasks WHERE turn_id=? ORDER BY seq', turnId);
      const progress = rng.int(1, 4);
      for (let i = 0; i < progress && i < tasks.length; i++) {
        advanceTurnTask(sysCtx(s.orgId), tasks[i]!.id, {
          status: 'done',
          actualCostCents: tasks[i]!.est_cost_cents ? Math.round(tasks[i]!.est_cost_cents * (0.85 + rng.next() * 0.4)) : 0,
        });
      }
    }
  }
  // a few vacant-not-ready units mid-turn too
  const vnr = q<any>(`SELECT * FROM units WHERE org_id=? AND status='vacant_not_ready' LIMIT 6`, s.orgId);
  for (const unit of vnr) {
    const turnId = createTurn(ctx, { unitId: unit.id, moveOut: addDays(s.businessDate, -rng.int(3, 15)) });
    const tasks = q<any>('SELECT * FROM turn_tasks WHERE turn_id=? ORDER BY seq', turnId);
    const progress = rng.int(1, 5);
    for (let i = 0; i < progress && i < tasks.length; i++) {
      advanceTurnTask(sysCtx(s.orgId), tasks[i]!.id, { status: 'done', actualCostCents: Math.round((tasks[i]!.est_cost_cents || 5000) * (0.8 + rng.next() * 0.5)) });
    }
    turns++;
  }

  // ---------- inspections: quarterly history + one move-out with damages ----------
  const someUnits = q<any>(`SELECT * FROM units WHERE org_id=? AND status='occupied' LIMIT 4`, s.orgId);
  for (const unit of someUnits) {
    const inspId = createInspection(sysCtx(s.orgId, addDays(s.businessDate, -rng.int(10, 80))), { unitId: unit.id, type: 'quarterly' });
    run(`UPDATE inspections SET status='completed', date=? WHERE id=?`, addDays(s.businessDate, -rng.int(10, 80)), inspId);
  }
  const endedLease = q1<any>(`SELECT * FROM leases WHERE org_id=? AND status='ended' ORDER BY move_out_date DESC LIMIT 1`, s.orgId);
  if (endedLease) {
    const inspId = createInspection(sysCtx(s.orgId, endedLease.move_out_date), { unitId: endedLease.unit_id, type: 'move_out', leaseId: endedLease.id });
    const items = q<any>(`SELECT * FROM inspection_items WHERE inspection_id=? LIMIT 3`, inspId);
    if (items[0]) run(`UPDATE inspection_items SET condition='damaged', note='Large carpet stain — needs replacement', charge_cents=28500 WHERE id=?`, items[0].id);
    if (items[1]) run(`UPDATE inspection_items SET condition='fair', note='Scuffed walls, normal wear' WHERE id=?`, items[1].id);
    run(`UPDATE inspections SET status='completed' WHERE id=?`, inspId);
  }

  log(`facilities: ${VENDOR_NAMES.length} vendors, ${historical} historical + ${open} open WOs, ${turns} turns, PM + inventory + inspections (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
