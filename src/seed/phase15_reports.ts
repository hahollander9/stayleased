import { q, q1, val, insert, js } from '../lib/db.ts';
import { id } from '../lib/ids.ts';
import { nowIso, addDays } from '../lib/dates.ts';
import { sysCtx } from '../lib/auth.ts';
import { backfillSnapshots } from '../modules/m14_reports/snapshots.ts';
import { openCollectionCase, writeOffBalance, createPaymentPlan } from '../modules/m8_receivables/payments.ts';
import { createCharge } from '../modules/m8_receivables/service.ts';
import type { SeedCtx } from './seed.ts';
import { log } from './seed.ts';

/** Phase 15 seed: 15 months of MetricSnapshot backfill, a bad-debt story
 * (one written-off skip + one open collections case) so those reports have
 * rows, and saved/scheduled reports — including a daily one that delivers to
 * the Message Console on the next day advance. */

export function seedReports(s: SeedCtx): void {
  const n = backfillSnapshots(s.orgId);
  log(`reports: ${n} metric snapshots backfilled (15 month-ends + today)`);

  // ---------- bad-debt story (two Foundry skips with damages beyond deposit) ----------
  // Historical dispositions settled cleanly, so manufacture the classic case:
  // final-inspection damages above the deposit on two old move-outs. Runs
  // before seedAccounting so the backdated charges post into open periods.
  const skips = q<any>(
    `SELECT l.id, l.household_name, l.move_out_date FROM leases l
     JOIN properties p ON p.id=l.property_id AND p.slug='foundry-lofts'
     WHERE l.org_id=? AND l.status='ended' AND l.move_out_date <= ? AND l.move_out_date >= ?
     ORDER BY l.move_out_date DESC LIMIT 2`,
    s.orgId, addDays(s.businessDate, -45), addDays(s.businessDate, -150),
  );
  if (skips.length >= 2) {
    for (const [i, sk] of skips.entries()) {
      const c = { ...sysCtx(s.orgId, sk.move_out_date), userName: 'Priya Raman' };
      createCharge(c, {
        leaseId: sk.id, kind: 'damage', label: 'Damages beyond normal wear — final inspection',
        amountCents: 62000 + i * 21500, date: sk.move_out_date, dueDate: sk.move_out_date, source: 'disposition',
      });
      openCollectionCase(c, sk.id, i === 0 ? 'moved out with balance — agency placement pending' : 'skip — no forwarding address');
    }
    // the second one comes back uncollectible and is written off two weeks ago
    const wCtx = { ...sysCtx(s.orgId, addDays(s.businessDate, -14)), userName: 'Priya Raman' };
    const cents = writeOffBalance(wCtx, skips[1]!.id, 'agency returned uncollectible after 90 days');
    log(`reports: bad debt — ${skips[0]!.household_name} in collections, ${skips[1]!.household_name} written off ($${(cents / 100).toFixed(2)})`);
  }

  // ---------- world enrichment: concessions, credits, plans, completed turns ----------
  // These flows all existed but no seed data exercised them; the §10 catalog
  // made the gaps visible. Keep everything convergent with the GL.
  const sys = { ...sysCtx(s.orgId), userName: 'Elena Ruiz' };

  // move-in specials (negative concession charges) on recent move-ins → a few
  // households sit at a credit, feeding Concession Usage + Prepaids & Credits
  const recentMoveIns = q<any>(
    `SELECT l.id, l.rent_cents, l.move_in_date FROM leases l
     WHERE l.org_id=? AND l.status='active' AND l.move_in_date BETWEEN ? AND ?
     ORDER BY l.move_in_date DESC, l.id LIMIT 6`,
    s.orgId, addDays(s.businessDate, -150), addDays(s.businessDate, -20),
  );
  for (const [i, l] of recentMoveIns.entries()) {
    const c = { ...sysCtx(s.orgId, l.move_in_date), userName: 'Elena Ruiz' };
    createCharge(c, {
      leaseId: l.id, kind: 'concession',
      label: i % 3 === 2 ? 'Resident referral credit' : 'Move-in special — half month off',
      amountCents: i % 3 === 2 ? -25000 : -Math.round(l.rent_cents / 2 / 100) * 100,
      date: l.move_in_date, dueDate: l.move_in_date, source: 'concession',
    });
  }
  log(`reports: ${recentMoveIns.length} move-in concessions posted (credits now on the books)`);

  // payment plans: Derrick's promised plan (comms thread) + one more
  const derrick = q1<any>(
    `SELECT hm.lease_id AS id, l.property_id FROM residents r JOIN household_members hm ON hm.resident_id=r.id
     JOIN leases l ON l.id=hm.lease_id WHERE r.email='derrick.cole@mail.demo'`,
  );
  if (derrick) {
    createPaymentPlan(sys, derrick.id, 240000, [
      { dueDate: addDays(s.businessDate, 3), amountCents: 80000 },
      { dueDate: addDays(s.businessDate, 17), amountCents: 80000 },
      { dueDate: addDays(s.businessDate, 31), amountCents: 80000 },
    ], 'Per promise-to-pay: $800 Friday, then two biweekly installments.');
  }
  const otherDelinquent = q<any>(
    `SELECT * FROM (
       SELECT l.id, (SELECT COALESCE(SUM(amount_cents),0) FROM charges WHERE lease_id=l.id AND status='active') -
         (SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE lease_id=l.id AND status IN ('pending','settled')) AS bal
       FROM leases l WHERE l.org_id=? AND l.status='active' AND l.id != ?
     ) WHERE bal BETWEEN 50000 AND 200000 ORDER BY bal DESC LIMIT 1`,
    s.orgId, derrick?.id || '',
  )[0];
  if (otherDelinquent) {
    const half = Math.round(otherDelinquent.bal / 2 / 100) * 100;
    createPaymentPlan(sys, otherDelinquent.id, otherDelinquent.bal, [
      { dueDate: addDays(s.businessDate, 7), amountCents: half },
      { dueDate: addDays(s.businessDate, 21), amountCents: otherDelinquent.bal - half },
    ], 'Two installments agreed after hours were cut.');
  }
  log('reports: 2 payment plans on file (Derrick per his promise-to-pay)');

  // completed historical turns: record the turnovers that already happened
  // (ended lease → later lease on the same unit) as completed turn boards
  // (seeded history keeps one lease per unit, so a "completed turn" is an
  // ended lease whose unit is rent-ready today — turn done, on the market)
  const pastTurnovers = q<any>(
    `SELECT prior.id AS prior_id, prior.unit_id, prior.property_id,
            COALESCE(prior.move_out_date, prior.end_date) AS mo
     FROM leases prior JOIN units u ON u.id=prior.unit_id AND u.status='vacant_ready'
     WHERE prior.org_id=? AND prior.status='ended' AND COALESCE(prior.move_out_date, prior.end_date) BETWEEN ? AND ?
       AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.unit_id=prior.unit_id)
     ORDER BY mo DESC LIMIT 10`,
    s.orgId, addDays(s.businessDate, -170), addDays(s.businessDate, -12),
  );
  for (const [i, t] of pastTurnovers.entries()) {
    const days = 5 + (i % 6);
    const ready = addDays(t.mo, days);
    const turnId = id('trn');
    insert('turns', {
      id: turnId, org_id: s.orgId, property_id: t.property_id, unit_id: t.unit_id, lease_id: t.prior_id,
      move_out_date: t.mo, target_ready_date: addDays(t.mo, 7 + (i % 3)), next_move_in_date: null,
      status: 'completed', completed_date: ready, created_at: nowIso(),
    });
    const tasks: [string, number, number][] = [
      ['Punch & repairs', 18000, 15000 + (i % 4) * 2500],
      ['Paint', 32000, 32000 + (i % 3) * 4000],
      ['Clean + carpets', 16000, 14500],
    ];
    for (const [seq, [name, est, actual]] of tasks.entries()) {
      insert('turn_tasks', {
        id: id('ttk'), org_id: s.orgId, turn_id: turnId, seq: seq + 1, name,
        status: 'done', est_cost_cents: est, actual_cost_cents: actual,
        completed_date: ready, created_at: nowIso(),
      });
    }
  }
  log(`reports: ${pastTurnovers.length} historical turns recorded as completed boards`);

  // ---------- saved + scheduled reports ----------
  const manager = q1<any>(`SELECT id FROM users WHERE email='manager@summitridge.demo'`);
  const accountant = q1<any>(`SELECT id FROM users WHERE email='accountant@summitridge.demo'`);
  const regional = q1<any>(`SELECT id FROM users WHERE email='regional@summitridge.demo'`);

  insert('saved_reports', {
    id: id('svr'), org_id: s.orgId, owner_user_id: manager.id,
    name: 'Delinquent residents with autopay off',
    kind: 'custom', dataset: 'residents',
    config: js({
      dataset: 'residents',
      cols: ['name', 'unit', 'property', 'lease_status', 'balance', 'autopay'],
      filters: [
        { col: 'balance', op: 'gte', value: '1.00' },
        { col: 'autopay', op: 'eq', value: 'off' },
        { col: 'role', op: 'eq', value: 'primary' },
      ],
      sort: 'balance', dir: 'desc',
    }),
    shared: 1, schedule: null, last_run_date: null, created_at: nowIso(),
  });

  insert('saved_reports', {
    id: id('svr'), org_id: s.orgId, owner_user_id: accountant.id,
    name: 'Daily delinquency snapshot',
    kind: 'canned', dataset: 'delinquency_aged',
    config: js({ property: 'all' }),
    shared: 0, schedule: 'daily', last_run_date: null, created_at: nowIso(),
  });

  insert('saved_reports', {
    id: id('svr'), org_id: s.orgId, owner_user_id: regional.id,
    name: 'Monthly portfolio KPIs',
    kind: 'canned', dataset: 'portfolio_kpis',
    config: js({}),
    shared: 1, schedule: 'monthly', last_run_date: null, created_at: nowIso(),
  });

  const savedCount = val<number>('SELECT COUNT(*) FROM saved_reports WHERE org_id=?', s.orgId) || 0;
  log(`reports: ${savedCount} saved reports (1 shared custom, 1 daily scheduled, 1 monthly scheduled)`);
}
