import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBySignature, classifyDocument } from '../src/modules/setup/ai_classify.ts';
import { YARDI_BLOCK_ROLL } from './fixtures/yardi_block_roll.ts';
import { AUDUBON_BLOCK_ROLL } from './fixtures/audubon_block_roll.ts';

/** "What did they just upload?"
 *
 * The operator exports whatever their system offers — Yardi alone lists forty
 * report names — and should never have to match it to one of our lanes. These
 * cover the deterministic reader, which runs with no API key: reports print
 * their own name, and bare CSVs are recognised by their column vocabulary.
 *
 * The rule that matters most is the refusal: a report that is genuinely about
 * a portfolio but carries no tenancy data must come back `unknown`, because
 * forcing it into a lane writes garbage into a real book. */

const rows = (...lines: string[][]): string[][] => lines;

test('a report that prints its own name is identified from the banner alone — no AI', () => {
  const c = classifyBySignature('export.xlsx', rows(
    ['Rent Roll with Lease Charges'],
    ['Orchard East (1042)'],
    ['As of 08/19/2026'],
    ['Unit', 'Resident', 'Name', 'Status', 'Rent'],
  ))!;
  assert.equal(c.kind, 'rent_roll');
  assert.equal(c.supported, true);
  assert.equal(c.report, 'Rent Roll with Lease Charges');
  assert.equal(c.by, 'signature');
  assert.equal(c.confidence, 'high');
});

test('the real Yardi fixtures classify as rent rolls with the system named', () => {
  const yardi = classifyBySignature('yardi-export.xlsx', YARDI_BLOCK_ROLL.slice(0, 12))!;
  assert.equal(yardi.kind, 'rent_roll');
  assert.equal(yardi.supported, true);

  const audubon = classifyBySignature('audubon.xlsx', AUDUBON_BLOCK_ROLL.slice(0, 12))!;
  assert.equal(audubon.kind, 'rent_roll');
  assert.equal(audubon.supported, true);
});

test('each supported lane is reachable from the report name a system actually prints', () => {
  const cases: [string, string][] = [
    ['Resident Directory', 'residents'],
    ['Aged Receivables', 'balances'],
    ['Vendor List', 'vendors'],
    ['Rent Roll', 'rent_roll'],
    ['Resident Lease Expirations', 'rent_roll'],
  ];
  for (const [title, kind] of cases) {
    const c = classifyBySignature('export.xlsx', rows([title], ['Property'], ['Unit', 'Name']))!;
    assert.ok(c, `${title} should be recognised`);
    assert.equal(c.kind, kind, `${title} → ${kind}`);
    assert.equal(c.supported, true);
  }
});

test('a portfolio report with no tenancy data is recognised and refused, not forced into a lane', () => {
  for (const title of ['Box Score Summary', 'Traffic By Day', 'Unit Availability', 'Market Rent Schedule',
    '12 Month Occupancy', 'Concession Burn Off', 'Security Deposit Activity', 'Prospect Ledger', 'Reasons For Moveout']) {
    const c = classifyBySignature('export.xlsx', rows([title], ['Orchard East'], ['Unit', 'Something']))!;
    assert.ok(c, `${title} should be recognised`);
    assert.equal(c.kind, 'unknown', `${title} must not be imported as data`);
    assert.equal(c.supported, false);
    assert.ok(c.report.length > 3, 'and it is named, not just rejected');
    assert.ok((c.wouldUnlock || '').length > 10, `${title} says what it would give them`);
  }
});

test('a bare CSV with no banner is read by its column vocabulary', () => {
  const rr = classifyBySignature('export.csv', rows(
    ['Unit', 'Tenant', 'Rent', 'Lease From', 'Lease To', 'Deposit', 'Balance'],
    ['101', 'Ana Ramos', '1500', '2026-01-01', '2026-12-31', '1500', '0'],
  ))!;
  assert.equal(rr.kind, 'rent_roll');

  const dir = classifyBySignature('contacts.csv', rows(
    ['Name', 'Email', 'Phone', 'Unit'],
    ['Ana Ramos', 'ana@x.test', '555-0100', '101'],
  ))!;
  assert.equal(dir.kind, 'residents');

  const ven = classifyBySignature('vendors.csv', rows(
    ['Vendor', 'Trade', 'Phone', 'Email'],
    ['Ace Plumbing', 'Plumbing', '555-0101', 'ace@x.test'],
  ))!;
  assert.equal(ven.kind, 'vendors');
});

test('the source system is named when the document reveals it', () => {
  const c = classifyBySignature('yardi_rentroll.xlsx', rows(
    ['Yardi Systems, Inc.'], ['Rent Roll with Lease Charges'], ['Unit', 'Resident'],
  ))!;
  assert.equal(c.system, 'Yardi');
  const b = classifyBySignature('export.csv', rows(['Buildium'], ['Rent Roll'], ['Unit', 'Tenant']))!;
  assert.equal(b.system, 'Buildium');
});

test('nothing recognisable classifies as unknown rather than guessing a lane', async () => {
  assert.equal(classifyBySignature('mystery.csv', rows(['Alpha', 'Beta'], ['1', '2'])), null);
  // …and the whole-pipeline answer with the AI off is an honest unknown
  const c = await classifyDocument('mystery.csv', rows(['Alpha', 'Beta'], ['1', '2']));
  assert.equal(c.kind, 'unknown');
  assert.equal(c.supported, false);
  assert.equal(c.by, 'fallback');
  assert.ok(c.why.length > 10, 'and it says why');
});

test('classifyDocument works end to end with no API key — the offline path is the default path', async () => {
  const c = await classifyDocument('orchard-east.xlsx', rows(
    ['Rent Roll with Lease Charges'], ['Orchard East (1042)'], ['Unit', 'Resident', 'Name', 'Rent'],
  ));
  assert.equal(c.kind, 'rent_roll');
  assert.equal(c.by, 'signature', 'a document that names itself needs no model call');
  assert.equal(c.supported, true);
});
