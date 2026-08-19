import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRead, readBySignature, readDocument, fieldMenu } from '../src/modules/setup/extract.ts';

/** Reading any file, from any system.
 *
 * Two things are being proven here, and only the second is about intelligence.
 *
 * The first is that ONE DOCUMENT CAN CARRY SEVERAL KINDS OF DATA and all of
 * them survive. The old reader picked a lane, so a rent roll that also held
 * emails and deposits imported as a rent roll and the rest was gone — not
 * refused, not reported, gone.
 *
 * The second is the trust boundary. `validateRead` is the only thing standing
 * between a model's answer and a real ledger, so every rule it enforces is
 * proven here rather than described in a comment: a column index that does not
 * exist, a field key the applier does not know, a stream with nothing to key
 * its rows on, a charge code the file never mentions, and a string clipped by
 * the renderer are each a way to corrupt a portfolio quietly. */

const GRID = (...rows: string[][]): string[][] => rows;

// A rent roll that also carries contact details and deposits — the ordinary
// case, and the one the lane-shaped reader used to lose two thirds of.
const COMBINED = GRID(
  ['Resident Data With Lease Charges'],
  ['Orchard East (1020)'],
  ['Unit', 'Resident', 'Email', 'Phone', 'Rent', 'Deposit Held', 'Deposit Billed', 'Balance'],
  ['101', 'Ana Ramos', 'ana@x.test', '555-0100', '1500.00', '1500.00', '1500.00', '0'],
  ['102', 'Chi Okafor', 'chi@x.test', '555-0101', '1450.00', '250.00', '1450.00', '300.00'],
);

const okStream = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'rent_roll', cols: { 0: 'unit', 1: 'tenant', 4: 'rent' }, confidence: 'high', why: 'Rows are keyed by unit and carry rent.', ...over,
});

test('one document yields every stream it carries, not one verdict', () => {
  const r = validateRead({
    report: 'Resident Data With Lease Charges',
    system: 'RealPage',
    header_row: 2,
    skip_rows: [0, 1],
    streams: [
      okStream(),
      { kind: 'residents', cols: { 0: 'unit', 1: 'tenant', 2: 'email', 3: 'phone' }, confidence: 'high', why: 'Names with emails and phones.' },
      { kind: 'deposits', cols: { 0: 'unit', 5: 'deposit_held', 6: 'deposit_billed' }, confidence: 'high', why: 'Deposit billed against held.' },
    ],
  }, COMBINED, 'export.xlsx')!;

  assert.ok(r, 'the read is usable');
  assert.deepEqual(r.streams.map((s) => s.kind), ['rent_roll', 'residents', 'deposits']);
  assert.equal(r.system, 'RealPage', 'a system we never wrote a signature for');
  assert.equal(r.header_row, 2);
  assert.deepEqual(r.skip_rows, [0, 1]);
});

test('a stream with nothing to key its rows on is dropped, not imported blind', () => {
  // no unit, no tenant, no email: every row would land on the same record,
  // which is not a partial import, it is a corrupt one
  const r = validateRead({
    streams: [okStream(), { kind: 'residents', cols: { 3: 'phone' }, confidence: 'high', why: 'has phones' }],
  }, COMBINED, 'x.xlsx')!;
  assert.deepEqual(r.streams.map((s) => s.kind), ['rent_roll']);
});

test('a column index outside the grid is discarded rather than silently mapping nothing', () => {
  const r = validateRead({
    streams: [okStream({ cols: { 0: 'unit', 99: 'rent', 1: 'tenant' } })],
  }, COMBINED, 'x.xlsx')!;
  assert.deepEqual(r.streams[0]!.cols, { 0: 'unit', 1: 'tenant' });
});

test('a field key no importer knows is discarded', () => {
  const r = validateRead({
    streams: [okStream({ cols: { 0: 'unit', 1: 'favourite_colour', 4: 'rent' } })],
  }, COMBINED, 'x.xlsx')!;
  assert.deepEqual(Object.values(r.streams[0]!.cols).sort(), ['rent', 'unit']);
});

test('one field cannot be claimed by two columns', () => {
  const r = validateRead({
    streams: [okStream({ cols: { 0: 'unit', 1: 'unit', 4: 'rent' } })],
  }, COMBINED, 'x.xlsx')!;
  const fields = Object.values(r.streams[0]!.cols);
  assert.equal(new Set(fields).size, fields.length, 'no field appears twice');
});

test('a duplicated stream kind is taken once', () => {
  const r = validateRead({
    streams: [okStream(), okStream({ why: 'again' })],
  }, COMBINED, 'x.xlsx')!;
  assert.equal(r.streams.length, 1);
});

test('an invented stream kind is ignored', () => {
  const r = validateRead({
    streams: [okStream(), { kind: 'work_orders', cols: { 0: 'unit' }, confidence: 'high', why: 'x' }],
  }, COMBINED, 'x.xlsx')!;
  assert.deepEqual(r.streams.map((s) => s.kind), ['rent_roll']);
});

test('a rent code the file never mentions is refused', () => {
  // a code nothing matches would select no charge row and silently zero every
  // rent it was meant to find
  const withCode = GRID(
    ['Unit', 'Code', 'Amount'],
    ['101', 'rntnt', '1500'],
  );
  const good = validateRead({ rent_code: 'rntnt', streams: [okStream({ cols: { 0: 'unit', 2: 'rent' } })] }, withCode, 'x.xlsx')!;
  assert.equal(good.rent_code, 'rntnt');

  const bad = validateRead({ rent_code: 'zzz_not_here', streams: [okStream({ cols: { 0: 'unit', 2: 'rent' } })] }, withCode, 'x.xlsx')!;
  assert.equal(bad.rent_code, undefined, 'a code with nothing to match is dropped');
});

test('a string the model echoes back is resolved to the full cell, never persisted clipped', () => {
  // the grid the model reads is clipped per cell, so an echoed string is a
  // PREFIX — persisting one is how a property became "Livingston Place at Souther"
  const rows = GRID(
    ['Livingston Place at Southern Avenue Apartments'],
    ['Unit', 'Resident', 'Rent'],
    ['101', 'Ana Ramos', '1500'],
  );
  const r = validateRead({
    document_property: 'Livingston Place at Souther',
    sections: [{ row: 0, property: 'Livingston Place at Souther' }],
    streams: [okStream({ cols: { 0: 'unit', 1: 'tenant', 2: 'rent' } })],
  }, rows, 'x.xlsx')!;
  assert.equal(r.document_property, 'Livingston Place at Southern Avenue Apartments');
  assert.equal(r.sections[0]!.property, 'Livingston Place at Southern Avenue Apartments');
});

test('a row index outside the grid is dropped from skips and sections', () => {
  const r = validateRead({
    skip_rows: [0, 1, 999, -4],
    sections: [{ row: 900, property: 'Nowhere' }],
    streams: [okStream()],
  }, COMBINED, 'x.xlsx')!;
  assert.deepEqual(r.skip_rows, [0, 1]);
  assert.deepEqual(r.sections, []);
});

test('a document carrying nothing importable reads as no streams, and says what it is', () => {
  const r = validateRead({
    report: 'Box Score Summary',
    streams: [],
    also_found: [{ what: 'Leasing activity by day', unlocks: 'a traffic history to compare against' }],
  }, COMBINED, 'x.xlsx')!;
  assert.deepEqual(r.streams, []);
  assert.equal(r.also_found[0]!.what, 'Leasing activity by day');
  assert.match(r.why, /Nothing in the rows/);
});

test('garbage in is null out — never a half-built read', () => {
  assert.equal(validateRead(null, COMBINED, 'x'), null);
  assert.equal(validateRead('nope', COMBINED, 'x'), null);
  assert.equal(validateRead({ streams: [okStream()] }, [], 'x'), null, 'no grid, no read');
});

// ---------- the understudy ----------

test('with the model unreachable, the format matcher still routes a report that names itself', () => {
  const r = readBySignature('export.xlsx', GRID(
    ['Rent Roll with Lease Charges'],
    ['Orchard East (1020)'],
    ['Unit', 'Resident', 'Rent'],
  ))!;
  assert.equal(r.by, 'signature');
  assert.deepEqual(r.streams.map((s) => s.kind), ['rent_roll']);
});

test('the matcher reports a recognised-but-unimportable report as found, not as a stream', () => {
  const r = readBySignature('export.xlsx', GRID(['Box Score Summary'], ['Orchard East'], ['Unit', 'Something']))!;
  assert.deepEqual(r.streams, [], 'nothing is imported from it');
  assert.equal(r.also_found[0]!.what, 'Box Score Summary', 'and it is named');
  assert.ok(r.also_found[0]!.unlocks.length > 10, 'with what it would give them');
});

test('a file nothing recognises, with no AI, is an honest empty read that says why', async () => {
  const r = await readDocument('mystery.csv', GRID(['Alpha', 'Beta'], ['1', '2']));
  assert.deepEqual(r.streams, []);
  assert.equal(r.by, 'fallback');
  assert.match(r.why, /no AI key is configured/);
});

test('with no AI configured, a self-naming report still routes and does not claim an outage', async () => {
  const r = await readDocument('roll.xlsx', GRID(
    ['Rent Roll with Lease Charges'], ['Orchard East (1020)'], ['Unit', 'Resident', 'Rent'],
  ));
  assert.equal(r.by, 'signature');
  assert.deepEqual(r.streams.map((s) => s.kind), ['rent_roll']);
  assert.doesNotMatch(r.why, /could not be reached/);
});

// ---------- the prompt cannot drift from the code ----------

test('the field menu is generated from the importer’s own fields, so it can never drift', () => {
  // a prompt that lists keys the applier ignores teaches the model to emit
  // columns that are silently discarded
  assert.match(fieldMenu('rent_roll'), /\bunit — Unit number\b/);
  assert.match(fieldMenu('vendors'), /\bname — Vendor name\b/);
  assert.match(fieldMenu('deposits'), /deposit_shortfall/);
  assert.doesNotMatch(fieldMenu('vendors'), /deposit_shortfall/);
});
