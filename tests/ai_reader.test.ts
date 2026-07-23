import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert, run } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword, sysCtx } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import {
  validatePlan, applyReadingPlan, mappingScore, pdfRowsToTable, renderSheetForAi, type ReadingPlan,
} from '../src/modules/setup/ai_reader.ts';
import { autoMap } from '../src/modules/setup/mapping.ts';
import { validateRentRoll, applyRentRoll, type BatchRow } from '../src/modules/setup/import_apply.ts';

/** AI reader gate — everything DOWNSTREAM of the model call is deterministic
 * and tested here: plan validation (never trust model output), plan execution
 * over a messy multi-property grid, the AI-vs-heuristic tiebreak, and the
 * PDF-records → grid conversion. The messy grid also runs end-to-end through
 * the real rent-roll apply to prove an AI reading lands correctly in the DB. */

const AS_OF = '2026-07-23';
let orgId: string;

before(() => {
  db();
  const existing = q1<{ id: string }>('SELECT id FROM orgs WHERE slug=?', 'ai-read-test');
  if (existing) { orgId = existing.id; return; }
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'AI Reader Test Co', slug: 'ai-read-test', business_date: AS_OF, kind: 'live', created_at: nowIso() });
  const uid = id('usr');
  insert('users', {
    id: uid, org_id: orgId, email: 'admin@ai-read.test', name: 'Reader Admin',
    kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
  });
  insert('role_assignments', { id: id('ra'), org_id: orgId, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  ensureCoa(orgId);
});

/** A realistic messy export: title, blank, header, two property sections,
 * per-section subtotal rows, and a grand-total footer. */
const MESSY: string[][] = [
  ['Portfolio Rent Roll', '', '', '', ''], // 0 title
  ['', '', '', '', ''], // 1 blank
  ['Unit', 'Resident', 'Rent', 'Deposit', 'Balance'], // 2 header
  ['Maple Court', '', '', '', ''], // 3 section
  ['101', 'Ann Ash', '1200', '1200', '0'], // 4
  ['102', 'Bo Beck', '1250', '1250', '75.50'], // 5
  ['Subtotal', '', '2450', '', ''], // 6 subtotal
  ['Oak Ridge', '', '', '', ''], // 7 section
  ['A1', 'Cy Cole', '1400', '1400', '0'], // 8
  ['A2', '', '', '', ''], // 9 vacant
  ['Subtotal', '', '1400', '', ''], // 10 subtotal
  ['GRAND TOTAL', '', '3850', '', ''], // 11 footer
];

const MESSY_PLAN_RAW = {
  header_row: 2,
  cols: { '0': 'unit', '1': 'tenant', '2': 'rent', '3': 'deposit', '4': 'balance' },
  skip_rows: [0, 1, 6, 10, 11],
  sections: [{ row: 3, property: 'Maple Court' }, { row: 7, property: 'Oak Ridge' }],
};

test('plan validation: accepts a good plan, rejects unusable ones', () => {
  const good = validatePlan(MESSY_PLAN_RAW, MESSY.length, 5, 'rent_roll');
  assert.ok(good);
  assert.equal(good!.header_row, 2);
  assert.equal(good!.sections.length, 2);

  assert.equal(validatePlan(null, 12, 5, 'rent_roll'), null);
  assert.equal(validatePlan('nope', 12, 5, 'rent_roll'), null);
  // no unit column mapped → not a usable rent-roll plan
  assert.equal(validatePlan({ header_row: 0, cols: { '1': 'tenant' } }, 12, 5, 'rent_roll'), null);
  // out-of-range and duplicate fields are dropped, junk fields ignored
  const cleaned = validatePlan({
    header_row: 2,
    cols: { '0': 'unit', '99': 'tenant', '1': 'made_up_field', '2': 'rent', '3': 'rent' },
    skip_rows: [0, 99, -3, 2],
    sections: [{ row: 50, property: 'x' }, { row: 3, property: '' }, { row: 3, property: 'Real' }, 'junk'],
  }, MESSY.length, 5, 'rent_roll');
  assert.ok(cleaned);
  assert.deepEqual(cleaned!.cols, { 0: 'unit', 2: 'rent' });
  assert.deepEqual(cleaned!.skip_rows, [0]); // header removed, out-of-range dropped
  assert.deepEqual(cleaned!.sections, [{ row: 3, property: 'Real' }]);
});

test('plan execution: sections become a synthetic Property column; totals vanish', () => {
  const plan = validatePlan(MESSY_PLAN_RAW, MESSY.length, 5, 'rent_roll')!;
  const out = applyReadingPlan(MESSY, plan, 'rent_roll');

  assert.deepEqual(out.headers, ['Property', 'Unit', 'Resident', 'Rent', 'Deposit', 'Balance']);
  assert.equal(out.dataRows.length, 4); // 101, 102, A1, A2 — no titles/totals/sections
  assert.deepEqual(out.dataRows[0], ['Maple Court', '101', 'Ann Ash', '1200', '1200', '0']);
  assert.deepEqual(out.dataRows[2], ['Oak Ridge', 'A1', 'Cy Cole', '1400', '1400', '0']);
  assert.deepEqual(out.dataRows[3]!.slice(0, 2), ['Oak Ridge', 'A2']); // vacant keeps its section
  assert.equal(out.mapping.cols[0], 'property'); // injected column
  assert.equal(out.mapping.cols[1], 'unit'); // originals shifted +1
  assert.equal(out.mapping.reader, 'ai');
  assert.match(out.notes.join(' '), /Maple Court, Oak Ridge/);
  assert.match(out.notes.join(' '), /Skipped 7 non-data rows/); // 0,1,6,10,11 + 2 section rows
});

test('end-to-end: an AI reading of the messy grid builds both properties correctly', () => {
  const ctx = sysCtx(orgId, AS_OF);
  const plan = validatePlan(MESSY_PLAN_RAW, MESSY.length, 5, 'rent_roll')!;
  const out = applyReadingPlan(MESSY, plan, 'rent_roll');

  const batch: BatchRow = {
    id: id('imp'), org_id: orgId, kind: 'rent_roll', filename: 'messy.xlsx',
    property_id: null, new_property_name: null, preset: 'ai-read',
    headers: JSON.stringify(out.headers), mapping: JSON.stringify(out.mapping),
    rows: JSON.stringify(out.dataRows), staged: '[]', as_of: AS_OF, status: 'staged', created_by: 'test',
  };
  insert('import_batches', { ...batch, summary: null, created_at: nowIso(), applied_at: null } as unknown as Record<string, unknown>);

  const v = validateRentRoll(ctx, batch);
  assert.equal(v.blockers.length, 0);
  assert.equal(v.error, 0);
  assert.deepEqual(new Set(v.properties), new Set(['Maple Court', 'Oak Ridge']));

  const s = applyRentRoll(ctx, batch);
  assert.equal(s.properties, 2);
  assert.equal(s.units, 4);
  assert.equal(s.leases, 3); // A2 vacant
  const maple = q1<any>('SELECT * FROM properties WHERE org_id=? AND name=?', orgId, 'Maple Court')!;
  const oak = q1<any>('SELECT * FROM properties WHERE org_id=? AND name=?', orgId, 'Oak Ridge')!;
  assert.equal(q<any>('SELECT * FROM units WHERE property_id=?', maple.id).length, 2);
  assert.equal(q<any>('SELECT * FROM units WHERE property_id=?', oak.id).length, 2);
  const bo = q1<any>(`SELECT l.* FROM leases l JOIN units u ON u.id=l.unit_id WHERE u.unit_number='102' AND l.property_id=?`, maple.id)!;
  assert.equal(bo.rent_cents, 125000);
  const ob = q1<any>(`SELECT * FROM charges WHERE lease_id=? AND kind='opening_balance'`, bo.id)!;
  assert.equal(ob.amount_cents, 7550);
});

test('tiebreak: a plan that reads more of the important fields beats heuristics', () => {
  // heuristic on headerless data finds nothing; a plan mapping unit+tenant+rent wins
  const headerless = [['101', 'Ann Ash', '1200'], ['102', 'Bo Beck', '1250']];
  const h = autoMap(['Column 1', 'Column 2', 'Column 3'], 'rent_roll');
  const plan: ReadingPlan = { header_row: -1, cols: { 0: 'unit', 1: 'tenant', 2: 'rent' }, skip_rows: [], sections: [] };
  assert.ok(mappingScore(plan.cols, 'rent_roll') > mappingScore(h.cols, 'rent_roll'));
  const out = applyReadingPlan(headerless, plan, 'rent_roll');
  assert.equal(out.dataRows.length, 2);
  assert.deepEqual(out.headers, ['Unit number', 'Tenant name', 'Lease rent']); // synthesized from field labels
});

test('pdf records → grid conversion keeps canonical order and property grouping', () => {
  const parsed = {
    property: 'Cedar Point',
    rows: [
      { unit: '10', tenant: 'Dee Fox', rent: '990.00', balance: '12.00', lease_start: '2026-01-01', lease_end: '2026-12-31', junk: 'ignored' },
      { unit: '11', tenant: '', rent: '', status: 'Vacant' },
      { unit: '12', tenant: 'Gil Hart', rent: 1010, property: 'Override Court' },
      'garbage',
      {},
    ],
  };
  const t = pdfRowsToTable(parsed as any, 'rent_roll')!;
  assert.ok(t);
  const unitCol = Object.entries(t.mapping.cols).find(([, f]) => f === 'unit')![0];
  const propCol = Object.entries(t.mapping.cols).find(([, f]) => f === 'property')![0];
  assert.equal(t.dataRows.length, 3);
  assert.equal(t.dataRows[0]![Number(unitCol)], '10');
  assert.equal(t.dataRows[0]![Number(propCol)], 'Cedar Point'); // doc-level property fills in
  assert.equal(t.dataRows[2]![Number(propCol)], 'Override Court'); // row-level wins
  assert.equal(t.dataRows[2]![Number(Object.entries(t.mapping.cols).find(([, f]) => f === 'rent')![0])], '1010'); // numeric coerced
  assert.equal(t.mapping.reader, 'ai');

  assert.equal(pdfRowsToTable(null, 'rent_roll'), null);
  assert.equal(pdfRowsToTable({ rows: [] }, 'rent_roll'), null);
  assert.equal(pdfRowsToTable({ rows: [{ tenant: 'No Unit' }] }, 'rent_roll'), null); // unit column required
});

test('sheet rendering clips long cells and shows head + tail of big files', () => {
  const big: string[][] = Array.from({ length: 400 }, (_, i) => [String(i), 'x'.repeat(60)]);
  const rendered = renderSheetForAi(big);
  assert.match(rendered, /^0: 0 \| x{27}…/);
  assert.match(rendered, /more data rows omitted/);
  assert.match(rendered, /399: 399/); // tail rows keep true indices (trailing totals stay visible)
  assert.ok(!rendered.includes('200: 200'), 'middle rows are omitted');
});
