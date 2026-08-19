import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q1, val, insert, js } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { sysCtx } from '../src/lib/auth.ts';
import { validateDeposits, applyDeposits, type BatchRow } from '../src/modules/setup/import_apply.ts';
import { reverseImport } from '../src/modules/setup/import_reverse.ts';
import { readinessItems } from '../src/modules/setup/readiness.ts';

/** The deposit a resident was CHARGED, against what they actually paid.
 *
 * A rent roll carries one deposit figure — what is held — so a household billed
 * $3,165 that paid $633 is indistinguishable from one that paid in full. The
 * gap is collectible money, and until a deposit report is imported nobody can
 * see it exists. That single number is the reason this lane exists, so it is
 * what these tests are mostly about.
 *
 * The shape here is the real one: a Yardi "Security Deposit Activity" export
 * has a two-row stacked header, a "(Prpd)/Delnq Deposits" column that is the
 * shortfall, a forfeiture column that only past residents use, and its own
 * totals row at the bottom. */

const AS_OF = '2026-08-19';
let org: string;
let prop: string;
const units: Record<string, string> = {};
const leases: Record<string, string> = {};

before(() => {
  db();
  org = id('org');
  insert('orgs', { id: org, name: 'Deposit Co', slug: 'dep-' + org.slice(-6), business_date: AS_OF, kind: 'live', created_at: nowIso() });
  prop = id('prp');
  insert('properties', {
    id: prop, org_id: org, name: 'Orchard East', slug: 'orchard-east-' + org.slice(-6), type: 'residential',
    address1: '1 Orchard', city: 'Madison', state: 'WI', zip: '53703', timezone: 'America/Chicago', created_at: nowIso(),
  });
  // three tenancies: one paid in full, one that paid a fifth, one that paid nothing
  for (const [n, deposit] of [['101', 105700], ['102', 0], ['103', 0]] as [string, number][]) {
    const u = id('unt');
    units[n] = u;
    insert('units', {
      id: u, org_id: org, property_id: prop, unit_number: n, floor: 1, sqft: 700,
      status: 'occupied', market_rent_cents: 120000, amenities: '[]', created_at: nowIso(),
    });
    const l = id('lse');
    leases[n] = l;
    insert('leases', {
      id: l, org_id: org, property_id: prop, unit_id: u, household_name: `Household ${n}`,
      status: 'active', start_date: '2026-01-01', end_date: '2026-12-31', move_in_date: '2026-01-01',
      rent_cents: 120000, deposit_cents: deposit, term_months: 12, created_at: nowIso(),
    });
  }
});

/** A batch shaped exactly as the upload route stores one. */
function depositBatch(rows: string[][]): BatchRow {
  const b = id('imp');
  insert('import_batches', {
    id: b, org_id: org, kind: 'deposits', filename: 'SecurityDepositActivity.xlsx',
    property_id: prop, new_property_name: null, preset: null,
    headers: js(['Unit', 'Resident', 'Resident Code', 'Prior Deposit Billed', 'Deposits On Hand', '(Prpd)/Delnq Deposits', 'Deposits Forfeited']),
    mapping: js({
      cols: { 0: 'unit', 1: 'tenant', 2: 'source_ref', 3: 'deposit_billed', 4: 'deposit_held', 5: 'deposit_shortfall', 6: 'deposit_forfeited' },
      preset: null, aiAssisted: [], reader: 'ai',
    }),
    rows: js(rows), staged: js([]), as_of: AS_OF,
    status: 'staged', summary: null, created_by: 'sys', created_at: nowIso(), applied_at: null,
  });
  return q1<BatchRow>('SELECT * FROM import_batches WHERE id=?', b)!;
}

const ROWS = [
  // unit, resident,           code,        billed, on hand, short,  forfeited
  ['101', 'Kia Harrison', 't0007893', '1057', '1057', '0', '0'],
  ['102', 'Steven Rollins', 't0007666', '837', '418', '419', '0'],
  ['103', 'Dominique Graham', 't0007833', '130', '0', '130', '0'],
];

test('the shortfall is carried in — the number a rent roll cannot show', () => {
  const ctx = sysCtx(org, AS_OF);
  const batch = depositBatch(ROWS);
  const v = validateDeposits(ctx, batch);
  assert.deepEqual(v.blockers, [], 'the file is importable');
  assert.equal(v.error, 0, 'every row is readable');

  const s = applyDeposits(ctx, batch);
  assert.equal(s.depositsShortCents, 54900, '$419 + $130 billed and never collected');
  assert.equal(s.depositsCents, 147500, '$1,057 + $418 actually on hand');

  const short = val<number>('SELECT COALESCE(SUM(short_cents),0) FROM deposit_positions WHERE org_id=?', org);
  assert.equal(short, 54900);
  const rollins = q1<{ short_cents: number; source_ref: string; lease_id: string }>(
    'SELECT short_cents, source_ref, lease_id FROM deposit_positions WHERE org_id=? AND unit_number=?', org, '102')!;
  assert.equal(rollins.short_cents, 41900);
  assert.equal(rollins.source_ref, 't0007893'.replace('7893', '7666'), 'the old system’s id is kept as the cross-report key');
  assert.equal(rollins.lease_id, leases['102'], 'and it is attached to the right lease');
});

test('a deposit fills a lease that had none, and never overwrites one that did (#81)', () => {
  // 101 already records 1057.00 held; 102 and 103 recorded nothing
  assert.equal(q1<{ deposit_cents: number }>('SELECT deposit_cents FROM leases WHERE id=?', leases['101'])!.deposit_cents, 105700);
  assert.equal(q1<{ deposit_cents: number }>('SELECT deposit_cents FROM leases WHERE id=?', leases['102'])!.deposit_cents, 41800,
    'the gap was filled from the report');
  assert.equal(q1<{ deposit_cents: number }>('SELECT deposit_cents FROM leases WHERE id=?', leases['103'])!.deposit_cents, 0,
    'nothing on hand, so nothing written');
});

test('nothing is posted to the books — this is what the OLD system said, not an entry we made', () => {
  const entries = val<number>(
    `SELECT COUNT(*) FROM journal_entries WHERE org_id=?`, org);
  assert.equal(entries, 0, 'a deposit report must never invent journal entries');
  assert.equal(val<number>('SELECT COUNT(*) FROM charges WHERE org_id=?', org), 0, 'nor bill anybody');
});

test('a row with no readable amount is refused rather than recorded as zero', () => {
  const ctx = sysCtx(org, AS_OF);
  const v = validateDeposits(ctx, depositBatch([['104', 'Nobody', 't1', '', '', '', '']]));
  assert.equal(v.error, 1);
  assert.match(v.rows[0]!.notes.join(' '), /zero or unreadable/);
});

test('a deposit for a unit that does not exist is kept and flagged, not dropped', () => {
  // a past resident's forfeiture is real history even when the unit has re-let
  const ctx = sysCtx(org, AS_OF);
  const v = validateDeposits(ctx, depositBatch([['999', 'Alaya Tyndle', 't0005904', '0', '0', '0', '2511']]));
  assert.equal(v.error, 0, 'not an error');
  assert.equal(v.warn, 1, 'but the operator is told');
  assert.match(v.rows[0]!.notes.join(' '), /No unit “999”/);
});

test('the setup hub reports the shortfall as money owed, in the operator’s language', () => {
  const item = readinessItems(sysCtx(org, AS_OF)).find((i) => i.key === 'deposits')!;
  assert.match(item.status, /2 leases record a deposit held/);
  assert.match(item.status, /2 households still owe \$549\.00 of deposit/);
  assert.doesNotMatch(item.status, /short_cents|deposit_positions/, 'no internal vocabulary on a customer page');
});

test('removing the upload takes the positions with it and puts the filled deposit back', () => {
  const ctx = sysCtx(org, AS_OF);
  const batch = depositBatch(ROWS.map((r) => [...r]));
  applyDeposits(ctx, batch);
  const applied = q1<BatchRow>('SELECT * FROM import_batches WHERE id=?', batch.id)!;
  const before = val<number>('SELECT COUNT(*) FROM deposit_positions WHERE org_id=? AND import_batch_id=?', org, batch.id);
  assert.ok(before > 0);

  reverseImport(ctx, applied);
  assert.equal(val<number>('SELECT COUNT(*) FROM deposit_positions WHERE org_id=? AND import_batch_id=?', org, batch.id), 0);
  // 101 keeps its own figure: this import never wrote it
  assert.equal(q1<{ deposit_cents: number }>('SELECT deposit_cents FROM leases WHERE id=?', leases['101'])!.deposit_cents, 105700);
});

// ---------- the header the matcher lands on ----------

import { resolveStackedHeader, autoMap } from '../src/modules/setup/mapping.ts';

/** A real Yardi "Security Deposit Activity" header: two rows, and the words the
 * column vocabulary recognises ("Billed", "On Hand", "Forfeited") all sit on
 * the SECOND one. `findHeaderRow` therefore picks the continuation row, merges
 * it with the first row of data, and `(Prpd)/Delnq Deposits` — the shortfall —
 * never maps. The lane would import, tie out, and quietly carry none of the
 * money it exists to find. */
const STACKED = [
  ['Security Deposit Activity'],
  ['Orchard East (1020)'],
  ['Period = 06/2026-08/2026'],
  ['Property', 'Unit', 'Resident', 'Resident', 'Prior Deposit', 'Prior', 'Deposits', '(Prpd)/Delnq', 'Deposits'],
  ['', '', 'Code', '', 'Billed', 'Receipts', 'On Hand', 'Deposits', 'Forfeited'],
  ['1020', 'OE013679', 't0007893', 'Kia Harrison (Current)', '1057', '1057', '1057', '0', '0'],
  ['1020', 'OE013685', 't0007666', 'Steven Rollins (Current)', '837', '418', '418', '419', '0'],
];

test('a two-row header is merged in whichever direction reads better — the shortfall must survive', () => {
  // the matcher lands on row 4, the continuation
  const r = resolveStackedHeader(STACKED, 4, 'deposits');
  assert.deepEqual(r.headers.slice(4), ['Prior Deposit Billed', 'Prior Receipts', 'Deposits On Hand', '(Prpd)/Delnq Deposits', 'Deposits Forfeited']);
  assert.equal(r.consumesNextRow, false, 'merging upward eats no data row');

  const mapped = Object.values(autoMap(r.headers, 'deposits', STACKED.slice(5)).cols).filter(Boolean);
  assert.ok(mapped.includes('deposit_shortfall'), 'the shortfall column maps — this is the whole point of the lane');
  assert.ok(mapped.includes('unit') && mapped.includes('tenant'), 'and the row still identifies itself');
});

test('the downward merge still wins where it is the right one, and consumes its row', () => {
  const downward = [
    ['Unit', 'Resident', 'Prior Deposit', 'Deposits', '(Prpd)/Delnq'],
    ['', '', 'Billed', 'On Hand', 'Deposits'],
    ['101', 'Ana Ramos', '1500', '1500', '0'],
  ];
  const r = resolveStackedHeader(downward, 0, 'deposits');
  assert.equal(r.consumesNextRow, true, 'the continuation row is not data');
  assert.ok(Object.values(autoMap(r.headers, 'deposits', downward.slice(2)).cols).includes('deposit_shortfall'));
});

test('a single-row header is left exactly as it is', () => {
  const flat = [['Unit', 'Resident', 'Deposits On Hand'], ['101', 'Ana', '1500']];
  const r = resolveStackedHeader(flat, 0, 'deposits');
  assert.deepEqual(r.headers, ['Unit', 'Resident', 'Deposits On Hand']);
  assert.equal(r.consumesNextRow, false);
});
