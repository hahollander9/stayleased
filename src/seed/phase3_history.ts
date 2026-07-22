import { q, q1, insert, run, val, tx } from '../lib/db.ts';
import { id } from '../lib/ids.ts';
import {
  nowIso, addDays, addMonths, monthKey, firstOfMonth, lastOfMonth, mkDate, parts, minDate, maxDate, diffDays,
} from '../lib/dates.ts';
import { sysCtx } from '../lib/auth.ts';
import { Rng } from '../lib/rng.ts';
import { createCharge, postMonthlyChargesForLease, leaseBalance } from '../modules/m8_receivables/service.ts';
import {
  recordPayment, settleDuePayments, assessLateFees, finalizeDeposit, openCollectionCase, createPaymentPlan,
} from '../modules/m8_receivables/payments.ts';
import type { SeedCtx } from './seed.ts';
import type { CastIds } from './phase2_residents.ts';
import { log } from './seed.ts';
import { FIRST, LAST } from './names.ts';

/** Phase 3 seed: 14 months of financial history generated THROUGH the real
 * pipelines (charges → payments → settlement → NSF → late fees), plus
 * turnover history (ended leases with deposit dispositions), autopay
 * enrollments (~55%), payment methods, and the delinquency cast (§8). */

type Archetype = 'autopay' | 'early' | 'ontime' | 'late' | 'very_late' | 'struggler';

interface LeasePlan {
  lease: any;
  archetype: Archetype;
  payDay: number;
  tokenId: string | null;
  method: 'ach' | 'card';
}

export interface HistoryHooks {
  /** runs at the start of each simulated month, after recurring charges post
   * and before any payments — Phase 11 posts provider invoices + RUBS here */
  onMonth?: (orgId: string, mk: string, monthStart: string) => void;
  /** runs once after turnover (ended) leases are created, before the month
   * loop — Phase 11 marks a couple as deposit-alternative so their historical
   * dispositions exercise the surety-claim path */
  onTurnoverLeases?: (leases: any[]) => void;
}

export function seedHistory(s: SeedCtx, cast: CastIds, hooks?: HistoryHooks): void {
  const t0 = Date.now();
  const historyStart = addMonths(firstOfMonth(s.businessDate), -13); // 14 months incl current
  const orgId = s.orgId;

  // ---------- turnover history: ended leases on currently-vacant units ----------
  const vacantUnits = q<any>(
    `SELECT u.*, p.slug AS prop_slug, p.state AS prop_state FROM units u JOIN properties p ON p.id=u.property_id
     WHERE u.org_id=? AND u.status IN ('vacant_ready','vacant_not_ready') ORDER BY u.unit_number LIMIT 12`,
    orgId,
  );
  const endedLeases: any[] = [];
  tx(() => {
    vacantUnits.forEach((unit, i) => {
      const rng = s.rng.fork(900 + i);
      const moveOut = addDays(s.businessDate, -rng.int(35, 150));
      const start = addMonths(moveOut, -12);
      const rent = Math.round((unit.market_rent_cents * (1 + rng.around(0, 0.04))) / 500) * 500;
      const leaseId = id('lse');
      const last = rng.pick(LAST);
      insert('leases', {
        id: leaseId, org_id: orgId, property_id: unit.property_id, unit_id: unit.id,
        household_name: `${last} household (moved out)`, status: 'ended',
        start_date: start, end_date: moveOut, move_in_date: start, move_out_date: moveOut,
        notice_date: addDays(moveOut, -35), rent_cents: rent,
        deposit_cents: Math.round(rent / 500) * 500, deposit_alternative: 0, term_months: 12, created_at: nowIso(),
      });
      insert('lease_charges', { id: id('lc'), org_id: orgId, lease_id: leaseId, kind: 'rent', label: `Rent — ${unit.unit_number}`, amount_cents: rent, created_at: nowIso() });
      const rid = id('res');
      insert('residents', {
        id: rid, org_id: orgId, property_id: unit.property_id, first_name: rng.pick(FIRST), last_name: last,
        email: `former.${last.toLowerCase()}${i}@mail.demo`, phone: `(555) ${rng.int(200, 989)}-${rng.int(1000, 9999)}`,
        kind: 'adult', created_at: nowIso(),
      });
      insert('household_members', { id: id('hm'), org_id: orgId, lease_id: leaseId, resident_id: rid, role: 'primary', created_at: nowIso() });
      endedLeases.push(q1<any>('SELECT * FROM leases WHERE id=?', leaseId));
    });
  });

  // ---------- archetypes, tokens & autopay enrollments ----------
  const activeLeases = q<any>(`SELECT * FROM leases WHERE org_id=? AND status IN ('active','month_to_month','notice')`, orgId);
  const plans: LeasePlan[] = [];
  tx(() => {
    for (const lease of activeLeases) {
      const rng = s.rng.fork(hash(lease.id));
      const isMaya = lease.id === cast.mayaLeaseId;
      const isDerrick = lease.id === cast.derrickLeaseId;
      let archetype: Archetype = rng.weighted([
        ['autopay', 55], ['early', 16], ['ontime', 10], ['late', 8], ['very_late', 6], ['struggler', 5],
      ] as const);
      if (isMaya) archetype = 'autopay';
      if (isDerrick) archetype = 'ontime'; // pays fine until spring 2026, then stops (below)

      const contactUser = q1<any>(
        `SELECT r.user_id, r.id AS resident_id FROM household_members hm JOIN residents r ON r.id=hm.resident_id WHERE hm.lease_id=? AND hm.role='primary'`,
        lease.id,
      );
      let tokenId: string | null = null;
      let method: 'ach' | 'card' = 'ach';
      if (contactUser?.user_id && (archetype === 'autopay' || rng.chance(0.6))) {
        method = archetype === 'autopay' ? 'ach' : rng.chance(0.72) ? 'ach' : 'card';
        tokenId = id('tok');
        insert('payment_method_tokens', {
          id: tokenId, org_id: orgId, user_id: contactUser.user_id, lease_id: lease.id, kind: method,
          label: method === 'ach' ? `Checking ····${rng.int(1000, 9999)}` : `Visa ····${rng.int(1000, 9999)}`,
          token: 'sim_' + tokenId.slice(-8), behavior: 'ok', is_default: 1, created_at: nowIso(),
        });
      }
      if (archetype === 'autopay' && tokenId && contactUser?.user_id) {
        insert('autopay_enrollments', {
          id: id('apy'), org_id: orgId, lease_id: lease.id, user_id: contactUser.user_id,
          method_token_id: tokenId, mode: 'full_balance', day_of_month: 1,
          start_date: maxDate(lease.start_date, historyStart), active: 1, created_at: nowIso(),
        });
      }
      const payDay =
        archetype === 'autopay' ? 1
        : archetype === 'early' ? rng.int(1, 3)
        : archetype === 'ontime' ? rng.int(3, 5)
        : archetype === 'late' ? rng.int(5, 9)
        : archetype === 'very_late' ? rng.int(10, 28)
        : rng.int(8, 27);
      plans.push({ lease, archetype, payDay, tokenId, method });
    }
    for (const lease of endedLeases) {
      plans.push({ lease, archetype: 'ontime', payDay: 3, tokenId: null, method: 'ach' });
    }
  });

  hooks?.onTurnoverLeases?.(endedLeases);

  // ---------- month-by-month simulation ----------
  let months = 0;
  for (let m = 0; m < 14; m++) {
    const monthStart = addMonths(historyStart, m);
    if (monthStart > s.businessDate) break;
    const mk = monthKey(monthStart);
    const monthEnd = minDate(lastOfMonth(monthStart), s.businessDate);
    const ctx = sysCtx(orgId, monthStart);
    months++;

    tx(() => {
      // 1) recurring charges for every lease alive this month (real engine)
      for (const p of plans) {
        const alive = { ...p.lease, status: leaseAliveStatus(p.lease, monthStart) };
        if (!alive.status) continue;
        postMonthlyChargesForLease(ctx, alive, mk);
      }
      // 2) deposit charge (+ dedicated payment) in the lease's first history month
      for (const p of plans) {
        const startMonth = maxDate(firstOfMonth(p.lease.start_date), historyStart);
        if (monthKey(startMonth) !== mk || p.lease.deposit_cents <= 0 || p.lease.deposit_alternative) continue;
        const already = q1<any>(`SELECT id FROM charges WHERE lease_id=? AND kind='deposit'`, p.lease.id);
        if (already) continue;
        const day = maxDate(monthStart, p.lease.start_date) <= monthEnd ? maxDate(monthStart, p.lease.start_date) : monthStart;
        createCharge(sysCtx(orgId, day), {
          leaseId: p.lease.id, kind: 'deposit', label: 'Security deposit', amountCents: p.lease.deposit_cents,
          date: day, dueDate: day, source: 'move_in',
        });
        // pay exactly the open deposit (guards against early balance payments double-covering it)
        const openDeposit = p.lease.deposit_cents - (val<number>(
          `SELECT COALESCE(SUM(pa.amount_cents),0) FROM payment_applications pa
           JOIN payments py ON py.id=pa.payment_id AND py.status IN ('pending','settled')
           JOIN charges c ON c.id=pa.charge_id WHERE c.lease_id=? AND c.kind='deposit'`,
          p.lease.id,
        ) || 0);
        if (openDeposit > 0) {
          recordPayment(sysCtx(orgId, day), {
            leaseId: p.lease.id, amountCents: openDeposit, method: 'ach', methodTokenId: p.tokenId,
            receivedDate: day, memo: 'deposit at move-in', suppressReceipt: true,
          });
        }
      }
    });

    // 2.5) phase hooks (utility invoices + RUBS post before anyone pays)
    hooks?.onMonth?.(orgId, mk, monthStart);

    // 3) day loop: fees on day 5, payments on their day, settlements daily
    const { y, m: mm } = parts(monthStart);
    const lastDay = parts(monthEnd).day;
    for (let d = 1; d <= lastDay; d++) {
      const date = mkDate(y, mm, d);
      const dctx = sysCtx(orgId, date);
      if (d === 5) assessLateFees(dctx, date);
      tx(() => {
        for (const p of plans) {
          if (p.payDay !== d) continue;
          if (!leaseAliveStatus(p.lease, monthStart)) continue;
          if (skipsThisMonth(p, mk, cast, s)) continue;
          // balance as of this date — future-dated charges within the month don't get paid early
          const balance = balanceAsOf(orgId, p.lease.id, date);
          if (balance <= 0) continue;
          const rng = s.rng.fork(hash(p.lease.id + mk));
          let amount = balance;
          if (p.archetype === 'struggler') {
            amount = rng.chance(0.7) ? Math.round((balance * rng.int(45, 90)) / 100) : balance;
          }
          if (p.lease.id === cast.derrickLeaseId && mk === '2026-05') {
            amount = Math.round(balance * 0.6); // partial May → oldest open charge ages into 61–90
          }
          if (amount <= 0) continue;
          const isCurrentMonth = mk === monthKey(s.businessDate);
          const method = p.archetype === 'autopay' ? 'ach' : p.method;
          try {
            recordPayment(dctx, {
              leaseId: p.lease.id, amountCents: amount, method,
              methodTokenId: p.tokenId, receivedDate: date, autopay: p.archetype === 'autopay',
              suppressReceipt: !isCurrentMonth && rng.chance(0.85), // keep the console browsable, current month fully noisy
            });
          } catch {
            // card declined — most people retry with their bank account
            if (method === 'card' && rng.chance(0.75) && p.lease.id !== cast.derrickLeaseId) {
              try {
                recordPayment(dctx, {
                  leaseId: p.lease.id, amountCents: amount, method: 'ach',
                  receivedDate: date, memo: 'retry after card decline', suppressReceipt: !isCurrentMonth,
                });
              } catch { /* stays delinquent */ }
            }
          }
        }
      });
      settleDuePayments(sysCtx(orgId, date), date);
    }
  }

  // trailing settlements for the current month (up to business date)
  settleDuePayments(sysCtx(orgId, s.businessDate), s.businessDate);

  // ---------- move-out dispositions for ended leases ----------
  for (const lease of endedLeases) {
    const rng = s.rng.fork(hash(lease.id) ^ 77);
    const dispDate = minDate(addDays(lease.move_out_date, rng.int(8, 24)), s.businessDate);
    const dctx = sysCtx(orgId, dispDate);
    if (rng.chance(0.45)) {
      createCharge(dctx, {
        leaseId: lease.id, kind: 'damage', label: rng.pick(['Carpet replacement — bedroom', 'Wall repair & paint', 'Deep clean + haul-away', 'Broken blinds & screen replacement'] as const),
        amountCents: rng.int(80, 450) * 100, date: dispDate, dueDate: dispDate, source: 'damage',
      });
    }
    if (rng.chance(0.2)) {
      // leave a rent shortfall so some dispositions owe money → collections
      createCharge(dctx, {
        leaseId: lease.id, kind: 'other', label: 'Insufficient notice fee', amountCents: Math.round(lease.rent_cents / 2), date: dispDate, dueDate: dispDate, source: 'damage',
      });
    }
    finalizeDeposit(dctx, lease.id, { date: dispDate, toCollections: true });
  }

  // ---------- the delinquency cast ----------
  // Derrick Cole: partial May, nothing since → lands in the 61–90 bucket with real depth
  const derrickCtx = sysCtx(orgId, s.businessDate);
  insert('delinquency_notes', {
    id: id('dnn'), org_id: orgId, lease_id: cast.derrickLeaseId, kind: 'promise_to_pay',
    body: 'Called the office — lost hours at work; promises $800 by the 1st and asked about a payment plan.',
    promise_date: addDays(s.businessDate, 6), promise_amount_cents: 80000,
    created_by: 'system', created_at: nowIso(),
  });
  insert('delinquency_notes', {
    id: id('dnn'), org_id: orgId, lease_id: cast.derrickLeaseId, kind: 'contact',
    body: 'Left voicemail re: May balance. No answer.', created_by: 'system', created_at: nowIso(),
  });

  // one long-delinquent household → open collection case
  const longDelinquent = q<any>(
    `SELECT l.id FROM leases l WHERE l.org_id=? AND l.status='active' AND l.id NOT IN (?, ?)
     ORDER BY (SELECT COALESCE(SUM(c.amount_cents),0) FROM charges c WHERE c.lease_id=l.id AND c.status='active') -
              (SELECT COALESCE(SUM(p.amount_cents),0) FROM payments p WHERE p.lease_id=l.id AND p.status IN ('pending','settled')) DESC
     LIMIT 1`,
    orgId, cast.mayaLeaseId, cast.derrickLeaseId,
  );
  if (longDelinquent[0]) openCollectionCase(derrickCtx, longDelinquent[0].id, 'chronic delinquency — 90+ days');

  const totals = {
    charges: val<number>('SELECT COUNT(*) FROM charges WHERE org_id=?', orgId),
    payments: val<number>('SELECT COUNT(*) FROM payments WHERE org_id=?', orgId),
    jes: val<number>('SELECT COUNT(*) FROM journal_entries WHERE org_id=?', orgId),
    batches: val<number>('SELECT COUNT(*) FROM settlement_batches WHERE org_id=?', orgId),
  };
  log(`${months} months of history: ${totals.charges} charges, ${totals.payments} payments, ${totals.jes} JEs, ${totals.batches} settlement batches (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

// Derrick stops paying May 2026; strugglers randomly skip ~12% of months
function skipsThisMonth(p: LeasePlan, mk: string, cast: CastIds, s: SeedCtx): boolean {
  if (p.lease.id === cast.derrickLeaseId) {
    if (mk >= '2026-06') return true; // nothing June onward
    if (mk === '2026-05') return false; // partial May happens via struggler-style override below
  }
  if (p.archetype === 'struggler') {
    return s.rng.fork(hash(p.lease.id + mk) ^ 5).chance(0.18);
  }
  return false;
}

/** effective status of a lease for a given history month (or null if not alive) */
function leaseAliveStatus(lease: any, monthStart: string): string | null {
  const monthEnd = lastOfMonth(monthStart);
  const start = lease.move_in_date || lease.start_date;
  if (start > monthEnd) return null;
  const out = lease.move_out_date;
  if (out && out < monthStart) return null;
  if (lease.status === 'ended') return 'active'; // historically active
  if (lease.status === 'month_to_month' && lease.mtm_since && lease.mtm_since <= monthEnd) return 'month_to_month';
  if (lease.status === 'month_to_month') return 'active';
  return lease.status;
}

/** ledger balance counting only charges dated on/before `date` */
function balanceAsOf(orgId: string, leaseId: string, date: string): number {
  const c = val<number>(
    `SELECT COALESCE(SUM(amount_cents),0) FROM charges WHERE org_id=? AND lease_id=? AND status='active' AND date<=?`,
    orgId, leaseId, date,
  ) || 0;
  const p = val<number>(
    `SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE org_id=? AND lease_id=? AND status IN ('pending','settled')`,
    orgId, leaseId,
  ) || 0;
  return c - p;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
