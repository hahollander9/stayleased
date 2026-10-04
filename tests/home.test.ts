import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q1, val, insert, run } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { sysCtx, type Ctx } from '../src/lib/auth.ts';
import { getSetting, setSetting } from '../src/lib/settings.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { incomeStatement, balanceSheet, cashFlow } from '../src/modules/m9_accounting/statements.ts';
import { createCharge, agingRows } from '../src/modules/m8_receivables/service.ts';
import { recordPayment, settleDuePayments } from '../src/modules/m8_receivables/payments.ts';
import {
  monthEarnings, cashPosition, owedToYou, vacantUnits, notPaying, sureness,
} from '../src/modules/m21_home/service.ts';
import { simpleMode } from '../src/modules/m21_home/pages.ts';

/** Simple mode's five numbers, each checked against the ledger it claims to
 * come from.
 *
 * The premise of this screen is that an owner who cannot read a trial balance
 * will trust a figure they have no way to verify. That makes every number here
 * a correctness problem rather than a presentation one, and it makes one class
 * of bug uniquely dangerous: a figure that is plausible, stable, and wrong.
 * Such a figure fails no typecheck, throws no error, and renders beautifully.
 * The only defence is to re-derive it from the same exported function the
 * screen calls and assert the two agree — which is why the numbers live in
 * service.ts and not in the template.
 *
 * The cash assertions get the most attention because that is where the audit
 * found the live trap: `cashFlow().closing` sums {1010, 1020, 1030} and would
 * have presented the deposit float as the owner's spendable cash. On the
 * Station U&O figures that is a $99,367 overstatement, by a function that is
 * correct, well-named, and simply answering a different question. There is a
 * test below whose entire job is to fail if anyone ever wires Home to it.
 */

const D = '2026-09-20'; // business date: late in the month, so "this month" has history
let org: string;
let prop: string;
let ctx: Ctx;
let leaseBehind: string;
let leasePaid: string;
let unitEmptyKnown: string;
let unitEmptyUnknown: string;
let vendor: string;

before(() => {
  db();
  org = id('org');
  insert('orgs', {
    id: org, name: 'Simple Co', slug: 'simple-' + org.slice(-6),
    business_date: D, kind: 'live', created_at: nowIso(),
  });
  ensureCoa(org);
  ctx = sysCtx(org, D);

  prop = id('prp');
  insert('properties', {
    id: prop, org_id: org, name: 'Maple Court', slug: 'maple-' + prop.slice(-5), type: 'residential',
    address1: '1 Maple', city: 'Madison', state: 'WI', zip: '53703', timezone: 'America/Chicago', created_at: nowIso(),
  });

  const mkUnit = (num: string, status: string, rent = 120000): string => {
    const u = id('unt');
    insert('units', {
      id: u, org_id: org, property_id: prop, unit_number: num, floor: 1, sqft: 750,
      status, market_rent_cents: rent, amenities: '[]', created_at: nowIso(),
    });
    return u;
  };
  const mkLease = (unitId: string, household: string, status: string, extra: Record<string, unknown> = {}): string => {
    const l = id('lse');
    insert('leases', {
      id: l, org_id: org, property_id: prop, unit_id: unitId, household_name: household,
      status, start_date: '2025-10-01', end_date: '2026-09-30', rent_cents: 120000,
      deposit_cents: 0, created_at: nowIso(), ...extra,
    });
    return l;
  };

  // Two occupied units: one household pays, one falls behind.
  leasePaid = mkLease(mkUnit('101', 'occupied'), 'Alvarez', 'active');
  leaseBehind = mkLease(mkUnit('102', 'occupied'), 'Byrne', 'active');

  // One empty unit WITH lease history — the backfill can date its vacancy.
  unitEmptyKnown = mkUnit('201', 'vacant_ready', 150000);
  mkLease(unitEmptyKnown, 'Prior tenant', 'ended', { move_out_date: '2026-08-21', end_date: '2026-08-31' });

  // One empty unit with NO lease history — every unit of a fresh import. There
  // is no date to be had, and the screen has to say so rather than invent one.
  unitEmptyUnknown = mkUnit('202', 'vacant_ready', 140000);

  // Rent for this month on both occupied leases; one pays in full and settles.
  createCharge(ctx, { leaseId: leasePaid, kind: 'rent', label: 'September rent', amountCents: 120000, date: '2026-09-01', dueDate: '2026-09-01', monthKey: '2026-09' });
  createCharge(ctx, { leaseId: leaseBehind, kind: 'rent', label: 'September rent', amountCents: 120000, date: '2026-09-01', dueDate: '2026-09-01', monthKey: '2026-09' });
  recordPayment(ctx, { leaseId: leasePaid, amountCents: 120000, method: 'check', receivedDate: '2026-09-02' });
  settleDuePayments(sysCtx(org, '2026-09-06'), '2026-09-06'); // clearing → 1010

  // A bill due before month-end, and one due after it.
  vendor = id('ven');
  insert('vendors', { id: vendor, org_id: org, name: 'Northside Plumbing', category: 'plumbing', created_at: nowIso() });
  const mkInvoice = (num: string, due: string, cents: number, status: string): void => {
    insert('vendor_invoices', {
      id: id('vin'), org_id: org, property_id: prop, vendor_id: vendor, invoice_number: num,
      invoice_date: '2026-09-10', due_date: due, status, total_cents: cents,
      source: 'manual', created_at: nowIso(),
    });
  };
  mkInvoice('NP-1', '2026-09-28', 40000, 'approved');       // counts
  mkInvoice('NP-2', '2026-09-29', 15000, 'pending_approval'); // counts — it is still owed
  mkInvoice('NP-3', '2026-10-14', 90000, 'approved');       // next month, must NOT count
  mkInvoice('NP-4', '2026-09-27', 70000, 'void');           // void, must NOT count
});

// ---------- 1. what you made ----------

test('what you made is the cash-basis income statement, and the terms add up to it', () => {
  const e = monthEarnings(ctx, null);
  assert.equal(e.from, '2026-09-01', 'the window starts at the first of the business month');
  assert.equal(e.to, D);

  // The screen renders "came in − went out = you made". If that subtraction
  // does not hold, the page is showing an operation that is not the one it
  // performed, which is worse than showing no working at all.
  assert.equal(e.net, e.collected - e.paidOut, 'the arithmetic on the page is the arithmetic that was done');

  const direct = incomeStatement(ctx, { propertyId: null, from: '2026-09-01', to: D, basis: 'cash' });
  assert.equal(e.collected, direct.totalIncome, 'collected is the statement income');
  assert.equal(e.paidOut, direct.totalExpenses, 'paid out is the statement expenses');
  assert.equal(e.net, direct.noi, 'and the headline is its NOI — the same call /statements makes');

  assert.ok(e.collected > 0, 'the settled rent reached the cash books');
});

test('the twelve-month strip is twelve months, oldest first, ending on this one', () => {
  const e = monthEarnings(ctx, null);
  assert.equal(e.strip.length, 12);
  assert.equal(e.strip[11]!.month, '2026-09', 'the last bar is the month in progress');
  assert.equal(e.strip[0]!.month, '2025-10', 'and the first is eleven months back');
  const months = e.strip.map((s) => s.month);
  assert.deepEqual(months, months.slice().sort(), 'ascending — a strip read right to left would invert the trend');
});

// ---------- 2. cash ----------

test('cash in the bank is account 1010 alone', () => {
  const c = cashPosition(ctx, null);
  const sheet = balanceSheet(ctx, { propertyId: null, asOf: D, basis: 'cash' });
  const line = (code: string): number => sheet.assets.find((l) => l.code === code)?.amount || 0;

  assert.equal(c.operating, line('1010'), 'the headline is the operating cash account, nothing else');
  assert.ok(c.operating > 0, 'the fixture settled a payment into it');
});

test('deposit cash and reserves are never folded into "your cash"', () => {
  // Fund the deposit and reserve accounts, then prove the headline does not move.
  const before = cashPosition(ctx, null).operating;
  const je = id('je');
  insert('journal_entries', {
    id: je, org_id: org, property_id: prop, date: '2026-09-15', period_key: '2026-09',
    basis: 'cash', memo: 'deposit + reserve funding', source_kind: 'manual',
    created_by: 'test', posted_at: nowIso(),
  });
  insert('journal_lines', { id: id('jl'), org_id: org, entry_id: je, account_code: '1020', debit_cents: 9936700, credit_cents: 0, property_id: prop });
  insert('journal_lines', { id: id('jl'), org_id: org, entry_id: je, account_code: '1030', debit_cents: 500000, credit_cents: 0, property_id: prop });
  insert('journal_lines', { id: id('jl'), org_id: org, entry_id: je, account_code: '2100', debit_cents: 0, credit_cents: 9936700, property_id: prop });
  insert('journal_lines', { id: id('jl'), org_id: org, entry_id: je, account_code: '3100', debit_cents: 0, credit_cents: 500000, property_id: prop });

  const c = cashPosition(ctx, null);
  assert.equal(c.operating, before, 'a $99,367 deposit float does not become spendable cash');

  // The float is not hidden either — it gets its own line, with the sentence
  // that says whose money it is.
  const deposits = c.otherLines.find((l) => l.code === '1020');
  assert.ok(deposits, 'the deposit float is shown');
  assert.equal(deposits!.amount, 9936700);
  assert.match(deposits!.note, /not yours to spend/i);
  const reserves = c.otherLines.find((l) => l.code === '1030');
  assert.equal(reserves?.amount, 500000);
  assert.match(reserves!.note, /repairs/i);
});

test('Home is not wired to cashFlow().closing — the regression this suite exists for', () => {
  // cashFlow is correct and well-named; its CASH_CODES is {1010,1020,1030}, so
  // its closing balance answers "how much cash exists" and not "how much can
  // the owner spend". With the deposit float funded above, the two diverge by
  // the whole of it. If someone ever simplifies cashPosition() by reaching for
  // the ready-made closing figure, this fails instead of shipping.
  const flow = cashFlow(ctx, { propertyId: null, from: '2026-09-01', to: D, basis: 'cash' });
  const c = cashPosition(ctx, null);
  assert.notEqual(c.operating, flow.closing,
    'the fixture funds 1020/1030 precisely so these cannot coincide');
  assert.ok(flow.closing - c.operating >= 9936700,
    'and the gap is at least the deposit float that must never read as spendable');
});

test('money still clearing is shown as its own line, not missing', () => {
  // A payment recorded this morning sits in 1050 until settlement. Without a
  // line for it an owner would find today's rent absent from "in the bank" and
  // conclude the screen is broken.
  const c0 = cashPosition(ctx, null);
  recordPayment(ctx, { leaseId: leaseBehind, amountCents: 30000, method: 'check', receivedDate: D });
  const c1 = cashPosition(ctx, null);

  assert.equal(c1.operating, c0.operating, 'unsettled money is not in the bank yet');
  const clearing = c1.otherLines.find((l) => l.code === '1050');
  assert.ok(clearing, 'but it is on the screen');
  assert.equal(clearing!.amount, 30000);
  assert.match(clearing!.note, /on its way/i);
});

test('month-end cash is the subtraction, and rent still owed is excluded from it', () => {
  const c = cashPosition(ctx, null);
  assert.equal(c.monthEnd, '2026-09-30');

  // Only bills actually falling due this month, and only ones still owed.
  assert.equal(c.billsDueByMonthEnd, 55000, 'the 28th and the 29th; not October, not the void one');
  assert.equal(c.billsCount, 2);
  assert.equal(c.afterBills, c.operating - c.billsDueByMonthEnd, 'arithmetic, not a forecast');

  // Rent still owed is real and is shown — but adding it would require
  // assuming what share of it arrives, and an assumption is not something the
  // books can vouch for. This is the assertion that keeps the figure honest.
  assert.ok(c.rentStillExpected > 0, 'the fixture leaves rent outstanding');
  assert.notEqual(c.afterBills, c.operating - c.billsDueByMonthEnd + c.rentStillExpected,
    'expected rent must not be counted into the cash position');
});

// ---------- 3. who owes you ----------

test('who owes you sums the same leases the receivables screen ages', () => {
  const o = owedToYou(ctx, null);
  const rows = agingRows(ctx, { propertyId: null, minBalance: 0 });

  assert.equal(o.households, rows.length, 'the count is the aging row count');
  assert.equal(o.total, rows.reduce((s, r) => s + r.balance, 0), 'and the total is their sum');
  assert.ok(o.total > 0, 'the fixture has a household behind');
});

test('the tie compares the whole subledger to the ledger, not the filtered view of it', () => {
  // The headline figure is positive balances on aging-scoped lease statuses.
  // GL 1100 carries every lease and every credit. Comparing those two
  // reported "these do not agree" in red on the seeded demo, whose books
  // balance to the cent — a false alarm on the one rule that exists to be
  // believed, and the fastest way to teach an owner to ignore warnings.
  const o = owedToYou(ctx, null);
  const sheet = balanceSheet(ctx, { propertyId: null, asOf: D, basis: 'accrual' });
  assert.equal(o.glReceivable, sheet.assets.find((l) => l.code === '1100')?.amount || 0);
  assert.equal(o.subledger, o.glReceivable, 'the subledger ties to the receivable account');
  assert.ok(o.ties);

  // Give one lease a credit balance — real, and invisible to the aging view.
  // The filtered total now diverges while the books stay perfectly tied, which
  // is exactly the shape of the false alarm.
  createCharge(ctx, { leaseId: leasePaid, kind: 'other', label: 'goodwill credit', amountCents: -25000, date: D, dueDate: D });
  const after = owedToYou(ctx, null);
  const sheet2 = balanceSheet(ctx, { propertyId: null, asOf: D, basis: 'accrual' });
  assert.equal(after.subledger, sheet2.assets.find((l) => l.code === '1100')?.amount || 0,
    'the credit lands in both places');
  assert.ok(after.ties, 'so the screen still says the books agree — because they do');
  assert.notEqual(after.total, after.glReceivable,
    'while the headline figure differs, as a filtered view should');
});

test('the top list is capped but the count is not — the screen cannot under-report the problem', () => {
  const o = owedToYou(ctx, null);
  assert.ok(o.top.length <= 5, 'at most five rows are shown');
  assert.ok(o.top.length <= o.households);
  assert.equal(o.top[0]!.balance, Math.max(...o.top.map((r) => r.balance)), 'largest first');
});

// ---------- 4. units costing money ----------

test('an empty unit with lease history is dated from the lease, and priced from the days', () => {
  const units = vacantUnits(ctx, null);
  const known = units.find((u) => u.id === unitEmptyKnown);
  assert.ok(known, 'the empty unit is listed');
  assert.equal(known!.since, '2026-08-21', 'dated from the move-out, not the end of the lease term');
  assert.equal(known!.sinceSource, 'lease', 'and labelled as derived rather than entered');
  assert.equal(known!.daysEmpty, 30, '2026-08-21 → 2026-09-20');
  assert.equal(known!.rentLostCents, Math.round((150000 / 30) * 30), 'daily rate x days');
});

test('an empty unit with no lease history has no date and no figure — it does not get a guess', () => {
  const unknown = vacantUnits(ctx, null).find((u) => u.id === unitEmptyUnknown);
  assert.ok(unknown, 'it is still listed — it is still empty');
  assert.equal(unknown!.since, null, 'no date exists for it');
  assert.equal(unknown!.daysEmpty, null, 'so no duration is computed');
  assert.equal(unknown!.rentLostCents, null,
    'and no rent-lost figure — a number here would measure when the data arrived, not how long the unit sat');
});

test('an owner-entered date is kept distinguishable from a derived one', () => {
  run("UPDATE units SET vacant_since='2026-07-01', vacant_since_source='owner' WHERE id=?", unitEmptyUnknown);
  const u = vacantUnits(ctx, null).find((x) => x.id === unitEmptyUnknown)!;
  assert.equal(u.since, '2026-07-01');
  assert.equal(u.sinceSource, 'owner',
    'the UI labels this as entered — a date someone recalled is not a date the books can show');
  assert.equal(u.daysEmpty, 81);
  run("UPDATE units SET vacant_since=NULL, vacant_since_source=NULL WHERE id=?", unitEmptyUnknown);
});

test('occupied units are not listed as empty, and not-paying is the other half of the question', () => {
  const empty = vacantUnits(ctx, null);
  assert.equal(empty.length, 2, 'only the two vacant units');
  assert.ok(!empty.some((u) => u.status === 'occupied'));

  const behind = notPaying(ctx, null);
  assert.ok(behind.length >= 1, 'the household in arrears shows up');
  assert.ok(behind.every((r) => r.balance > 0));
});

test('the vacancy clock survives a turn, because readiness is not occupancy', () => {
  // vacant_not_ready → vacant_ready means the unit got cleaned, not re-let.
  // Resetting the clock there would wipe the cost of the vacancy at the exact
  // moment the unit becomes rentable.
  run("UPDATE units SET status='vacant_not_ready' WHERE id=?", unitEmptyKnown);
  const during = vacantUnits(ctx, null).find((u) => u.id === unitEmptyKnown)!;
  assert.equal(during.since, '2026-08-21');
  run("UPDATE units SET status='vacant_ready' WHERE id=?", unitEmptyKnown);
  assert.equal(vacantUnits(ctx, null).find((u) => u.id === unitEmptyKnown)!.since, '2026-08-21');
});

// ---------- the vacancy columns themselves ----------

test('the vacancy columns exist, and the backfill filled them from ended leases only', () => {
  // The migration loop swallows every error ("column already exists"), so a
  // typo in an ALTER is silent and shows up later as a mystery. Assert the
  // columns are really there.
  const cols = new Set(
    (db().prepare('PRAGMA table_info(units)').all() as { name: string }[]).map((c) => c.name),
  );
  assert.ok(cols.has('vacant_since'), 'units.vacant_since applied');
  assert.ok(cols.has('vacant_since_source'), 'units.vacant_since_source applied');

  // The backfill statement itself, run the way a boot runs it. Asserting it
  // had ALREADY run against this fixture would be testing the wrong thing:
  // the migration fires once when the connection opens, and these rows were
  // inserted after that. Which is the gap worth naming — units arrive after
  // startup, so a boot-only backfill is not where correctness can live, and
  // vacantUnits() derives the date itself. This covers the persisted half.
  const backfill = `UPDATE units SET vacant_since = (
       SELECT COALESCE(l.move_out_date, l.end_date) FROM leases l
       WHERE l.unit_id = units.id AND l.status = 'ended'
         AND COALESCE(l.move_out_date, l.end_date) IS NOT NULL
       ORDER BY COALESCE(l.move_out_date, l.end_date) DESC LIMIT 1
     ), vacant_since_source = 'lease'
     WHERE vacant_since IS NULL
       AND status IN ('vacant_ready','vacant_not_ready')
       AND EXISTS (
         SELECT 1 FROM leases l WHERE l.unit_id = units.id AND l.status = 'ended'
           AND COALESCE(l.move_out_date, l.end_date) IS NOT NULL
       )`;
  run(backfill);
  assert.equal(
    val<string>('SELECT vacant_since FROM units WHERE id=?', unitEmptyKnown),
    '2026-08-21', 'backfilled from the move-out of the lease that ended',
  );
  assert.equal(
    val<string>('SELECT vacant_since_source FROM units WHERE id=?', unitEmptyKnown),
    'lease', 'and marked as derived',
  );
  assert.equal(
    val<string>('SELECT vacant_since FROM units WHERE id=?', unitEmptyUnknown),
    null, 'and left alone where there was nothing to derive it from',
  );

  // Re-running it is a no-op, which is what makes it safe on every boot.
  run(backfill);
  assert.equal(val<string>('SELECT vacant_since FROM units WHERE id=?', unitEmptyKnown), '2026-08-21');
});

test('the backfill never overwrites an owner-entered date, however often it runs', () => {
  // It re-runs on every boot — there is no applied-migrations table — so
  // "WHERE vacant_since IS NULL" is the whole of its safety.
  run("UPDATE units SET vacant_since='2026-05-05', vacant_since_source='owner' WHERE id=?", unitEmptyKnown);
  run(`UPDATE units SET vacant_since = (
         SELECT COALESCE(l.move_out_date, l.end_date) FROM leases l
         WHERE l.unit_id = units.id AND l.status = 'ended'
           AND COALESCE(l.move_out_date, l.end_date) IS NOT NULL
         ORDER BY COALESCE(l.move_out_date, l.end_date) DESC LIMIT 1
       ), vacant_since_source = 'lease'
       WHERE vacant_since IS NULL
         AND status IN ('vacant_ready','vacant_not_ready')`);
  assert.equal(val<string>('SELECT vacant_since FROM units WHERE id=?', unitEmptyKnown), '2026-05-05',
    'the entered date stood');
  assert.equal(val<string>('SELECT vacant_since_source FROM units WHERE id=?', unitEmptyKnown), 'owner');
  run("UPDATE units SET vacant_since='2026-08-21', vacant_since_source='lease' WHERE id=?", unitEmptyKnown);
});

// ---------- the flag ----------

test('simple mode is off where no row was ever written, so no live operator is switched on deploy', () => {
  // The distinction "on for new orgs, off for existing" is impossible to
  // express through SETTING_DEFAULTS alone: a setting with no row reads its
  // default, so a default of true would reach every existing org too.
  const other = id('org');
  insert('orgs', { id: other, name: 'Legacy Co', slug: 'legacy-' + other.slice(-6), business_date: D, created_at: nowIso() });
  assert.equal(simpleMode(sysCtx(other, D)), false, 'an org that predates the flag keeps its chrome');
  assert.equal(getSetting<boolean>(sysCtx(other, D), 'simple_mode'), false);
});

test('the flag is per organization and survives a round trip', () => {
  assert.equal(simpleMode(ctx), false, 'this fixture org has no row');
  setSetting(ctx, 'simple_mode', true);
  assert.equal(simpleMode(ctx), true);
  setSetting(ctx, 'simple_mode', false);
  assert.equal(simpleMode(ctx), false, 'and turning it off really turns it off');
});

// ---------- plain language ----------

test('confidence becomes a word an owner can act on', () => {
  assert.equal(sureness(0.95), 'Very sure');
  assert.equal(sureness(0.9), 'Very sure');
  assert.equal(sureness(0.82), 'Fairly sure');
  assert.equal(sureness(0.7), 'Fairly sure', 'the 0.7 auto floor reads as confident, not doubtful');
  assert.equal(sureness(0.69), 'Not sure');
  assert.equal(sureness(0.1), 'Not sure');
});

// ---------- scoping ----------

test('every number scopes to the selected property, and the org view is the consolidation', () => {
  const other = id('prp');
  insert('properties', {
    id: other, org_id: org, name: 'Birch Row', slug: 'birch-' + other.slice(-5), type: 'residential',
    address1: '2 Birch', city: 'Madison', state: 'WI', zip: '53703', timezone: 'America/Chicago', created_at: nowIso(),
  });
  insert('units', {
    id: id('unt'), org_id: org, property_id: other, unit_number: 'B1', floor: 1, sqft: 600,
    status: 'vacant_ready', market_rent_cents: 100000, amenities: '[]', created_at: nowIso(),
  });

  const all = vacantUnits(ctx, null);
  const justMaple = vacantUnits(ctx, prop);
  const justBirch = vacantUnits(ctx, other);
  assert.equal(justBirch.length, 1, 'the new property has its one empty unit');
  assert.equal(all.length, justMaple.length + justBirch.length, 'and the org view is the sum of the parts');
  assert.ok(justMaple.every((u) => u.propertyName === 'Maple Court'));

  // Cash and bills scope too — a property-scoped view that silently showed
  // org-wide money would be the most misleading number on the screen.
  const cashAll = cashPosition(ctx, null);
  const cashBirch = cashPosition(ctx, other);
  assert.equal(cashBirch.billsDueByMonthEnd, 0, 'Birch Row has no bills of its own');
  assert.ok(cashAll.billsDueByMonthEnd > 0);
});
