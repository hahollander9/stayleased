import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlacements, buildScorecard, DIMENSIONS, MIN_GROUP } from '../src/modules/m24_placement/scorecard.ts';
import { samplePlacements } from '../src/modules/m24_placement/sample.ts';
import { parseDelinquency } from '../src/modules/m22_weekly/exports.ts';
import { sampleCsv } from '../src/modules/m22_weekly/sample.ts';
import { fixtureTwoOrgs, startTestServer, loginAs, get } from './harness.ts';

/** The scorecard's rules are fair-housing rules: it compares sources, never
 * kinds of people; it does not blame a household (or its agent) for an
 * agency's late payment; and it does not rank a group too small to mean
 * anything. Each is pinned here. */

const AS_OF = '2026-10-31';
const H = ['Property', 'Unit', 'Tenant', 'Move In', 'Move Out', 'Rent', 'Tenant Rent', 'Subsidy Program', 'Leasing Agent', 'Lead Source'];
const row = (unit: string, agent: string, over: Partial<Record<string, string>> = {}): string[] =>
  ['Elm Court', unit, `Tenant ${unit}`, over.moveIn ?? '01/01/2024', over.moveOut ?? '', '1,500.00', over.tenantRent ?? '1,500.00', over.program ?? '', agent, over.source ?? 'Zillow'];
const DEL = (rows: [string, string, string][]): string[][] =>
  [['Property', 'Unit', 'Name', 'Amount Receivable', 'Delinquent Subsidy Amount'], ...rows.map(([u, total, sub]) => ['Elm Court', u, `Tenant ${u}`, total, sub])];

test('the only things it will group by are agent, source and screening decision', () => {
  assert.deepEqual(DIMENSIONS.map((d) => d.key), ['agent', 'source', 'screening']);
  const p = parsePlacements([H, row('1', 'A', { program: 'HCVP' }), row('2', 'B', { program: '' })]);
  assert.deepEqual(p.dimsFound, ['agent', 'source']);
  // the subsidy column is not read: nothing about it survives parsing
  assert.ok(!JSON.stringify(p.rows).includes('HCVP'));
  const sc = buildScorecard({ asOf: AS_OF, placements: p });
  assert.deepEqual(sc.dims.map((d) => d.key), ['agent', 'source']);
});

test('an export with no source column says so instead of inventing a comparison', () => {
  const p = parsePlacements([['Property', 'Unit', 'Tenant', 'Rent'], ['Elm Court', '1', 'T', '1,500.00']]);
  assert.equal(p.rows.length, 0);
  assert.match(p.warnings.join(' '), /nothing to compare by/);
});

test('an agency’s late payment never counts against the household', () => {
  const units = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
  const p = parsePlacements([H, ...units.map((u, i) => row(u, i < 5 ? 'Agent A' : 'Agent B'))]);
  // Agent A's five households each show $3,000 owed, all of it the agency's
  const withSplit = buildScorecard({ asOf: AS_OF, placements: p, delinquency: parseDelinquency(DEL(units.slice(0, 5).map((u) => [u, '3,000.00', '3,000.00']))) });
  const a = withSplit.dims[0]!.groups.find((g) => g.name === 'Agent A')!;
  assert.equal(a.behind, 0);
  assert.equal(a.owed, 0);
  assert.ok(withSplit.notes.some((n) => /agency owes is left out/.test(n)));
  // the same balances with no subsidy column DO count, and the page warns about it
  const noSplit = buildScorecard({ asOf: AS_OF, placements: p, delinquency: parseDelinquency(DEL(units.slice(0, 5).map((u) => [u, '3,000.00', ''])).map((r) => r.slice(0, 4))) });
  assert.equal(noSplit.dims[0]!.groups.find((g) => g.name === 'Agent A')!.behind, 5);
  assert.ok(noSplit.notes.some((n) => /no subsidy column/.test(n)));
});

test('small groups are listed but never compared', () => {
  const p = parsePlacements([H, ...['1', '2', '3', '4', '5', '6'].map((u) => row(u, 'Big')), row('7', 'Tiny'), row('8', 'Tiny')]);
  const sc = buildScorecard({ asOf: AS_OF, placements: p, delinquency: parseDelinquency(DEL([['7', '900.00', '0.00'], ['8', '900.00', '0.00']])) });
  const tiny = sc.dims[0]!.groups.find((g) => g.name === 'Tiny')!;
  assert.equal(tiny.placements, 2);
  assert.ok(tiny.placements < MIN_GROUP);
  assert.equal(tiny.judged, false);
  assert.equal(tiny.vsOthers, null, 'a 100% rate on two tenants is not a finding');
  assert.equal(sc.dims[0]!.groups[0]!.name, 'Big', 'judged groups sort ahead of unjudged ones');
  assert.ok(sc.notes.some((n) => /fewer than 5 placements/.test(n)));
});

test('behind rate, the comparison, and months behind against the tenant’s own rent', () => {
  const units = Array.from({ length: 12 }, (_, i) => String(i + 1));
  const p = parsePlacements([H, ...units.map((u, i) => row(u, i < 6 ? 'A' : 'B', { tenantRent: '500.00' }))]);
  const del = parseDelinquency(DEL([['1', '1,000.00', '0.00'], ['2', '1,000.00', '0.00'], ['3', '1,000.00', '0.00'], ['7', '40.00', '0.00']]));
  const sc = buildScorecard({ asOf: AS_OF, placements: p, delinquency: del });
  const a = sc.dims[0]!.groups.find((g) => g.name === 'A')!;
  const b = sc.dims[0]!.groups.find((g) => g.name === 'B')!;
  assert.equal(a.behind, 3);
  assert.equal(a.behindRate, 0.5);
  assert.equal(a.avgMonthsBehind, 2, '$1,000 owed on a $500 tenant share is two months, whatever the contract rent');
  assert.equal(b.behind, 0, 'a $40 balance is under the $50 floor');
  assert.equal(a.vsOthers, 50);
  assert.equal(b.vsOthers, -50);
  assert.equal(sc.overall.behind, 3);
});

test('left within a year: only tenants with a full year of history are counted; labels group case-insensitively', () => {
  const p = parsePlacements([H,
    row('1', 'Zed', { moveIn: '01/01/2025', moveOut: '06/01/2025' }), // left after 5 months
    row('2', 'zed', { moveIn: '01/01/2024', moveOut: '06/01/2025' }), // stayed 17 months
    row('3', 'ZED', { moveIn: '01/01/2024' }), // still here after a year
    row('4', 'Zed ', { moveIn: '09/01/2026' }), // too new to know
    row('5', 'Zed', { moveIn: '' }),
  ]);
  const sc = buildScorecard({ asOf: AS_OF, placements: p });
  const z = sc.dims[0]!.groups;
  assert.equal(z.length, 1, 'one agent, four spellings');
  assert.equal(z[0]!.name, 'Zed');
  assert.equal(z[0]!.placements, 5);
  assert.equal(z[0]!.earlyMoveOuts, 1);
  assert.equal(z[0]!.earlyRate, 1 / 3);
  assert.equal(sc.hasBalances, false);
  assert.equal(z[0]!.behind, null);
});

test('a balance on a unit is never pinned on a tenant who has moved out', () => {
  const p = parsePlacements([H, row('1', 'A', { moveOut: '03/01/2025' }), ...['2', '3', '4', '5', '6'].map((u) => row(u, 'A'))]);
  const sc = buildScorecard({ asOf: AS_OF, placements: p, delinquency: parseDelinquency(DEL([['1', '2,000.00', '0.00']])) });
  assert.equal(sc.dims[0]!.groups[0]!.behind, 0);
});

test('the sample: the planted pattern shows, the two-tenant source is not ranked', () => {
  const s = samplePlacements(AS_OF);
  const p = parsePlacements(s.placements);
  assert.equal(p.rowsRead, 53);
  const sc = buildScorecard({ asOf: AS_OF, placements: p, delinquency: parseDelinquency(s.delinquency) });
  const agents = sc.dims.find((d) => d.key === 'agent')!.groups;
  assert.equal(agents[0]!.name, 'Keystone Leasing (outside)');
  assert.ok(agents[0]!.vsOthers! > 30);
  const fb = sc.dims.find((d) => d.key === 'source')!.groups.find((g) => g.name === 'Facebook')!;
  assert.equal(fb.judged, false);
  assert.ok(sc.splitByPayer);
});

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

test('screens: form, sample, sample downloads, upload (never cached), and the no-source-column message', async () => {
  const form = await get(base, '/placement-scorecard', cookie);
  assert.equal(form.status, 200);
  assert.match(form.text, /never reads a subsidy or voucher column/);
  assert.notEqual((await get(base, '/placement-scorecard', '')).status, 200);
  const sample = await get(base, '/placement-scorecard/sample', cookie);
  assert.match(sample.text, /By leasing agent/);
  assert.match(sample.text, /Too few to judge/);
  assert.match(sample.text, /must not be used to accept or reject an applicant/);
  assert.equal((await get(base, '/placement-scorecard/sample/sample-delinquency.csv', cookie)).status, 200);
  assert.equal((await get(base, '/placement-scorecard/sample/nope.csv', cookie)).status, 404);

  const s = samplePlacements(AS_OF);
  const fd = new FormData();
  fd.append('placements', new Blob([sampleCsv(s.placements)], { type: 'text/csv' }), 'tenants.csv');
  fd.append('delinquency', new Blob([sampleCsv(s.delinquency)], { type: 'text/csv' }), 'delinquency.csv');
  fd.append('as_of', AS_OF);
  const up = await fetch(`${base}/placement-scorecard`, { method: 'POST', body: fd, headers: { cookie, origin: base }, redirect: 'manual' });
  assert.equal(up.status, 200);
  assert.equal(up.headers.get('cache-control'), 'no-store');
  assert.match(await up.text(), /Keystone Leasing \(outside\)/);

  const bad = new FormData();
  bad.append('placements', new Blob(['Property,Unit,Tenant\nElm,1,T\n'], { type: 'text/csv' }), 'plain.csv');
  const res = await fetch(`${base}/placement-scorecard`, { method: 'POST', body: bad, headers: { cookie, origin: base }, redirect: 'manual' });
  assert.match(await res.text(), /nothing to compare by/);
});
