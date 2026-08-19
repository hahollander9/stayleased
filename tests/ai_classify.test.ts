import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBySignature, classifyDocument, resolveClassification, type DocClassification } from '../src/modules/setup/ai_classify.ts';
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

test('with the AI unreachable, a document that names itself still routes — degraded, and it says so', async () => {
  // This is the OUTAGE path, not the design. With a key present the model reads
  // every upload; signatures exist so an outage degrades the product instead of
  // stopping it (2026-08-19: the reader is the model, not a lookup table).
  const c = await classifyDocument('orchard-east.xlsx', rows(
    ['Rent Roll with Lease Charges'], ['Orchard East (1042)'], ['Unit', 'Resident', 'Name', 'Rent'],
  ));
  assert.equal(c.kind, 'rent_roll');
  assert.equal(c.by, 'signature');
  assert.equal(c.supported, true);
  assert.match(c.why, /calls itself/, 'and states what it went on');
});

test('the fallback never pretends to be a read: an unrecognised file with no AI is unknown', async () => {
  const c = await classifyDocument('mystery.csv', rows(['Alpha', 'Beta', 'Gamma'], ['1', '2', '3']));
  assert.equal(c.kind, 'unknown');
  assert.equal(c.by, 'fallback');
  assert.equal(c.supported, false);
});

// ---------- who wins ----------
//
// The precedence rule is the whole answer to "is the AI reading my documents,
// or is a script matching formats?" — so it is a pure function, proven here
// rather than described in a comment. The model reads; the matcher is the
// understudy for when the model cannot be reached.

const aiSays = (over: Partial<DocClassification> = {}): DocClassification => ({
  kind: 'balances', supported: true, report: 'Aged Receivables', system: 'Yardi',
  confidence: 'high', why: 'Rows carry aging buckets per unit.', by: 'ai', ...over,
});
const sigSays = (over: Partial<DocClassification> = {}): DocClassification => ({
  kind: 'rent_roll', supported: true, report: 'Rent Roll', system: 'Yardi',
  confidence: 'high', why: 'The document calls itself a Rent Roll.', by: 'signature', ...over,
});

test('a confident AI read wins outright — the format matcher does not get a vote', () => {
  const r = resolveClassification(aiSays(), sigSays(), true);
  assert.equal(r.by, 'ai');
  assert.equal(r.kind, 'balances', 'the model routed it, not the printed title');
  assert.equal(r.report, 'Aged Receivables');
});

test('an AI read wins even when nothing else recognised the document', () => {
  const r = resolveClassification(aiSays({ confidence: 'low' }), null, true);
  assert.equal(r.by, 'ai');
  assert.equal(r.kind, 'balances');
});

test('an uncertain AI read that contradicts the printed title surfaces the disagreement', () => {
  const r = resolveClassification(aiSays({ confidence: 'low' }), sigSays(), true);
  assert.equal(r.kind, 'rent_roll', 'the document’s own title decides a coin toss');
  assert.match(r.why, /calls itself a Rent Roll/);
  assert.match(r.why, /AI read it as aged receivables but was not certain/, 'and both readings are stated');
  assert.equal(r.confidence, 'low', 'flagged as uncertain rather than presented as settled');
});

test('an uncertain AI read that AGREES with the title is left alone', () => {
  const r = resolveClassification(aiSays({ kind: 'rent_roll', confidence: 'low' }), sigSays(), true);
  assert.equal(r.by, 'ai');
  assert.equal(r.kind, 'rent_roll');
});

test('with the model unreachable the matcher answers — and the page says why', () => {
  const r = resolveClassification(null, sigSays(), true);
  assert.equal(r.by, 'signature');
  assert.equal(r.kind, 'rent_roll');
  assert.match(r.why, /could not be reached/, 'a degraded read announces itself');
});

test('with no AI configured the matcher answers plainly, with no outage language', () => {
  const r = resolveClassification(null, sigSays(), false);
  assert.equal(r.by, 'signature');
  assert.doesNotMatch(r.why, /could not be reached/);
});

test('neither reader answering is an honest unknown, never a guess', () => {
  const live = resolveClassification(null, null, true, 'mystery.csv');
  assert.equal(live.kind, 'unknown');
  assert.equal(live.supported, false);
  assert.match(live.why, /could not be reached/);

  const offline = resolveClassification(null, null, false, 'mystery.csv');
  assert.equal(offline.kind, 'unknown');
  assert.doesNotMatch(offline.why, /could not be reached/);
});
