import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  cellCents, cellDate, unitKey, parseRentRoll, parseDelinquency, parseReceipts, parseWorkOrders,
} from '../src/modules/m22_weekly/exports.ts';
import { buildReport, summarize, type Report } from '../src/modules/m22_weekly/engine.ts';
import { sampleFiles, sampleAsOf, sampleCsv, SAMPLE_FILE_NAMES } from '../src/modules/m22_weekly/sample.ts';
import { usd } from '../src/lib/money.ts';
import { parseCsv } from '../src/lib/csv.ts';
import { fixtureTwoOrgs, startTestServer, loginAs, get } from './harness.ts';

/** The weekly action report is a list a property manager acts on, so the
 * failures that matter are the quiet ones: a balance attributed to the wrong
 * payer, a unit joined to the wrong lease, a total that no longer ties to the
 * export it came from. Most of what follows re-derives a figure from the
 * sample files independently and asserts the report agrees. */

const AS_OF = '2026-10-30';
const S = sampleFiles(AS_OF);

function full(): Report {
  return buildReport({
    asOf: S.asOf,
    rentRoll: parseRentRoll(S.rentRoll),
    delinquency: parseDelinquency(S.delinquency),
    receipts: parseReceipts(S.receipts),
    prior: parseDelinquency(S.delinquencyPrior, 'Last week'),
    workOrders: parseWorkOrders(S.workOrders),
  });
}

// ---------- cells ----------

test('money cells: commas, dollar signs, parentheses, dashes, blanks', () => {
  assert.equal(cellCents('1,234.56'), 123456);
  assert.equal(cellCents('$1,234.5'), 123450);
  assert.equal(cellCents('(45.00)'), -4500);
  assert.equal(cellCents('-12'), -1200);
  assert.equal(cellCents('-'), null);
  assert.equal(cellCents(''), null);
  assert.equal(cellCents('0.005'), 1); // half-up at the cent
  assert.throws(() => cellCents('Current'), /not an amount/);
});

test('date cells: US, ISO, two-digit year, Excel serial; junk is null', () => {
  assert.equal(cellDate('10/05/2026'), '2026-10-05');
  assert.equal(cellDate('1/5/26'), '2026-01-05');
  assert.equal(cellDate('2026-10-05T00:00:00'), '2026-10-05');
  assert.equal(cellDate('46300'), '2026-10-05');
  assert.equal(cellDate('soon'), null);
});

test('unit labels compare loosely', () => {
  assert.equal(unitKey('Unit 02'), unitKey('2'));
  assert.equal(unitKey('#101'), unitKey('101'));
  assert.notEqual(unitKey('101'), unitKey('10'));
});

// ---------- reading exports ----------

test('rent roll: title rows skipped, "Rent" does not take the "Tenant Rent" column', () => {
  const p = parseRentRoll(S.rentRoll);
  assert.equal(p.rows.length, 47);
  assert.equal(p.rows.filter((r) => r.vacant).length, 3);
  for (const r of p.rows.filter((x) => !x.vacant)) {
    assert.equal(r.tenantRent! + r.subsidyRent!, r.rent, `${r.property} ${r.unit}: shares must add to rent`);
  }
  assert.equal(p.report.ourTotal, p.report.fileTotal, 'ties to the export’s own total row');
});

test('delinquency: property comes from section rows; subtotals skipped; grand total ties', () => {
  const p = parseDelinquency(S.delinquency);
  assert.ok(p.rows.every((r) => r.property && !r.property.startsWith('->')));
  assert.ok(p.report.fileTotal! > 0);
  assert.equal(p.report.ourTotal, p.report.fileTotal);
  for (const r of p.rows) {
    const a = r.aging!;
    assert.equal(a.d0_30 + a.d30_60 + a.d60_90 + a.d90, r.total, `${r.property} ${r.unit}: buckets add to balance`);
  }
});

test('section-row layouts do not report the Property column as missing', () => {
  assert.ok(!parseDelinquency(S.delinquency).report.missing.includes('Property'));
  const flat = parseDelinquency([['Unit', 'Amount Receivable'], ['1', '10.00']]);
  assert.ok(flat.report.missing.includes('Property'), 'no property anywhere is still reported');
});

test('the report discloses when agency payments were recognised by name', () => {
  assert.ok(full().limits.some((l) => /recognised by the payer’s name/.test(l)));
});

test('receipts: agencies recognised by payer name when there is no payer-type column', () => {
  const p = parseReceipts(S.receipts);
  const agency = p.rows.filter((r) => r.payerType === 'agency');
  assert.ok(agency.length > 10);
  assert.ok(agency.every((r) => /Housing Authority|Human Services/.test(r.payer)));
  assert.ok(p.rows.filter((r) => r.payerType === 'tenant').every((r) => !/Housing Authority|Human Services/.test(r.payer)));
});

test('a file that is not the report says so instead of reading zeros', () => {
  const p = parseDelinquency([['Some other report'], ['Owner', 'Distribution'], ['A', '12']]);
  assert.equal(p.rows.length, 0);
  assert.ok(p.report.warnings.length > 0);
});

test('a subsidy amount larger than the balance is refused, not used', () => {
  const grid = [['Property', 'Unit', 'Name', 'Amount Receivable', 'Delinquent Subsidy Amount'], ['A', '1', 'X', '100.00', '250.00']];
  const p = parseDelinquency(grid);
  assert.equal(p.rows[0]!.subsidy, null);
  assert.match(p.report.warnings.join(' '), /outside the balance/);
});

// ---------- the report ----------

test('owed: every dollar is attributed exactly once and ties to the delinquency export', () => {
  const r = full();
  const fileTotal = parseDelinquency(S.delinquency).report.fileTotal!;
  assert.equal(r.owed.total, fileTotal);
  assert.equal(r.owed.tenant + r.owed.agency + r.owed.unsplit, r.owed.total);
  assert.equal(r.owed.unsplit, 0, 'the sample carries a subsidy column, so nothing is unsplit');
  const agencyFromFile = parseDelinquency(S.delinquency).rows.reduce((s, d) => s + (d.subsidy ?? 0), 0);
  assert.equal(r.owed.agency, agencyFromFile);
  assert.equal(r.agencies.reduce((s, a) => s + a.owed, 0), r.owed.agency, 'agency groups sum to the agency total');
});

test('agencies: grouped by program, most owed first, months behind from the lease subsidy', () => {
  const r = full();
  assert.equal(r.agencies[0]!.program, 'DHS Rapid Rehousing');
  assert.equal(r.agencies[0]!.worstMonthsBehind, 3);
  for (let i = 1; i < r.agencies.length; i++) assert.ok(r.agencies[i - 1]!.owed >= r.agencies[i]!.owed);
});

test('expected vs. received: expected is the occupied rent roll; received is this month only', () => {
  const r = full();
  const rr = parseRentRoll(S.rentRoll).rows.filter((x) => !x.vacant);
  assert.equal(r.month!.expectedTenant + r.month!.expectedAgency, rr.reduce((s, x) => s + x.rent, 0));
  const rc = parseReceipts(S.receipts).rows.filter((x) => x.date >= '2026-10-01' && x.date <= AS_OF && x.unit !== '12B');
  assert.equal(r.month!.receivedTenant + r.month!.receivedAgency, rc.reduce((s, x) => s + x.amount, 0));
  assert.ok(parseReceipts(S.receipts).rows.some((x) => x.date < '2026-10-01'), 'the sample does include last month’s receipts');
});

test('flags: the abated agency payment, the stray receipt, the catch-up', () => {
  const r = full();
  const short = r.flags.find((f) => f.kind === 'agency_short');
  assert.ok(short);
  assert.equal(short!.expected - short!.received, 21000);
  assert.ok(r.flags.some((f) => f.kind === 'unmatched_receipt' && f.unit === '12B'));
  assert.ok(r.flags.some((f) => f.kind === 'overpaid' && f.property === 'Birch Hollow'));
});

test('no "missing agency payment" before agencies are due', () => {
  const early = sampleFiles('2026-10-04');
  const r = buildReport({
    asOf: '2026-10-04', rentRoll: parseRentRoll(early.rentRoll), delinquency: parseDelinquency(early.delinquency),
    receipts: parseReceipts(early.receipts),
  });
  assert.equal(r.flags.filter((f) => f.kind === 'agency_missing').length, 0);
  assert.ok(r.limits.some((l) => /before the 10th/.test(l)));
});

test('follow-up list: ranked by score, agencies grouped, payment plans halved', () => {
  const r = full();
  for (let i = 1; i < r.followUps.length; i++) assert.ok(r.followUps[i - 1]!.score >= r.followUps[i]!.score);
  assert.deepEqual(r.followUps.map((f) => f.rank), r.followUps.map((_, i) => i + 1));
  assert.equal(r.followUps[0]!.kind, 'agency');
  assert.equal(r.followUps.filter((f) => f.kind === 'agency' && f.who === 'DHS Rapid Rehousing').length, 1);
  const plan = r.followUps.find((f) => /payment plan/.test(f.why));
  assert.ok(plan);
  assert.match(plan!.step, /installment/);
});

test('since last week: new, grew and paid-off households are found by property + unit', () => {
  const r = full();
  const kinds = new Set(r.changes!.map((c) => c.kind));
  for (const k of ['new', 'grew', 'cured'] as const) assert.ok(kinds.has(k), k);
  // Regression: "Unit 2" at Cedar Gate must never be matched to "Unit 2" at
  // another property just because only one unit 2 owed money last week.
  const cedar2 = r.changes!.find((c) => c.property === 'Cedar Gate' && c.unit === '2');
  assert.equal(cedar2?.kind, 'new');
  assert.equal(cedar2?.before, 0);
});

test('maintenance: completed work is ignored; urgent and idle work surfaces first', () => {
  const r = full();
  const wo = parseWorkOrders(S.workOrders).rows;
  assert.equal(r.maintenance!.open, wo.filter((w) => !/Completed/.test(w.status)).length);
  assert.ok(r.maintenance!.items.every((m) => !/Completed/.test(m.status)));
  assert.equal(r.maintenance!.items[0]!.priority, 'urgent');
  assert.ok(r.maintenance!.urgentOverdue >= 1);
});

test('without a subsidy column: subsidized balances are "not split", market-rate ones are the household’s', () => {
  const noSub = S.delinquency.map((row) => {
    const i = S.delinquency.findIndex((r) => r[0] === 'Unit');
    return i >= 0 ? row.filter((_, k) => k !== 4) : row;
  });
  const r = buildReport({ asOf: AS_OF, rentRoll: parseRentRoll(S.rentRoll), delinquency: parseDelinquency(noSub) });
  assert.equal(r.owed.agency, 0);
  assert.ok(r.owed.unsplit > 0);
  assert.equal(r.owed.tenant + r.owed.unsplit, r.owed.total);
  assert.ok(r.households.filter((h) => !h.program).every((h) => h.split === 'market'));
  assert.ok(r.households.filter((h) => h.program).every((h) => h.split === 'unknown'));
  assert.ok(r.followUps.some((f) => f.kind === 'confirm'));
  assert.ok(r.limits.some((l) => /no subsidy-balance column/.test(l)));
});

test('the summary sentence quotes the report’s own figures', () => {
  const r = full();
  const s = summarize(r, usd);
  assert.ok(s.includes(usd(r.owed.total)));
  assert.ok(s.includes(usd(r.owed.agency)));
});

test('sample: as-of never lands before agencies are due; CSVs round-trip through the parser', () => {
  assert.equal(sampleAsOf('2026-11-01'), '2026-10-31');
  assert.equal(sampleAsOf('2026-11-12'), '2026-11-12');
  const back = parseDelinquency(parseCsv(sampleCsv(S.delinquency)));
  assert.equal(back.report.ourTotal, parseDelinquency(S.delinquency).report.ourTotal);
  assert.equal(back.report.ourTotal, back.report.fileTotal);
});

// ---------- the page ----------

let base = '';
let close: () => void = () => {};
let cookie = '';

before(async () => {
  const fx = fixtureTwoOrgs();
  const s = await startTestServer();
  base = s.base;
  close = s.close;
  cookie = await loginAs(base, fx.adminA);
});
after(() => close());

test('GET /weekly-report: the upload form, and a sign-in wall for strangers', async () => {
  const r = await get(base, '/weekly-report', cookie);
  assert.equal(r.status, 200);
  assert.match(r.text, /enctype="multipart\/form-data"/);
  assert.match(r.text, /name="rent_roll"/);
  const anon = await get(base, '/weekly-report');
  assert.notEqual(anon.status, 200);
});

test('GET /weekly-report/sample renders the report from fictional data', async () => {
  const r = await get(base, '/weekly-report/sample', cookie);
  assert.equal(r.status, 200);
  assert.match(r.text, /Follow-up list/);
  assert.match(r.text, /DHS Rapid Rehousing/);
  assert.match(r.text, /sample portfolio/);
  assert.match(r.text, /were not saved/);
});

test('sample files download; unknown names 404', async () => {
  const ok = await get(base, `/weekly-report/sample/${SAMPLE_FILE_NAMES.delinquency}`, cookie);
  assert.equal(ok.status, 200);
  assert.match(ok.text, /Amount Receivable/);
  const bad = await get(base, '/weekly-report/sample/..%2F..%2Fetc%2Fpasswd', cookie);
  assert.equal(bad.status, 404);
});

test('POST /weekly-report with uploaded exports builds the report and is never cached', async () => {
  const fd = new FormData();
  fd.append('rent_roll', new Blob([sampleCsv(S.rentRoll)], { type: 'text/csv' }), 'rent-roll.csv');
  fd.append('delinquency', new Blob([sampleCsv(S.delinquency)], { type: 'text/csv' }), 'delinquency.csv');
  fd.append('receipts', new Blob([sampleCsv(S.receipts)], { type: 'text/csv' }), 'receipts.csv');
  fd.append('as_of', AS_OF);
  const resp = await fetch(`${base}/weekly-report`, { method: 'POST', body: fd, headers: { cookie, origin: base }, redirect: 'manual' });
  const text = await resp.text();
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get('cache-control'), 'no-store');
  assert.ok(text.includes(usd(full().owed.total)), 'the page shows the same total the engine computes');
  assert.match(text, /from the exports uploaded/);
});

test('POST /weekly-report without the two required exports explains what is missing', async () => {
  const fd = new FormData();
  fd.append('rent_roll', new Blob([sampleCsv(S.rentRoll)], { type: 'text/csv' }), 'rent-roll.csv');
  const resp = await fetch(`${base}/weekly-report`, { method: 'POST', body: fd, headers: { cookie, origin: base }, redirect: 'manual' });
  assert.equal(resp.status, 200);
  assert.match(await resp.text(), /are both needed/);
});
