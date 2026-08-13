import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q1, insert, js } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword, sysCtx } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { applyReadingPlan, renderSheetForAi, validatePlan, type ReadingPlan } from '../src/modules/setup/ai_reader.ts';
import {
  validateRentRoll, applyRentRoll, validateResidents, applyResidents, type BatchRow,
} from '../src/modules/setup/import_apply.ts';
import {
  autoMap, findHeaderRow, mergeStackedHeader, harvestSubRowCharges,
  scanRosterSections, parseSourceSummary, detectDocumentProperty, moneyToCents, type Mapping,
} from '../src/modules/setup/mapping.ts';
import { YARDI_BLOCK_ROLL } from './fixtures/yardi_block_roll.ts';

/** Import integrity gate (2026-08-12) — the guardrails born from the first
 * real-data run: (1) the AI reading plan can no longer suppress the stacked-
 * header merge by mislabeling the sub-label row as a section; (2) the rent-
 * roll validation computes a reconciliation strip + column-level mis-mapping
 * warnings (all-zero deposits, uniform balances, parking-as-rent); (3) the
 * resident-directory lane refuses a mass insert (247 duplicates on live)
 * unless the operator explicitly confirms. */

const AS_OF = '2026-07-23';
let orgId: string;

before(() => {
  db();
  const existing = q1<{ id: string }>('SELECT id FROM orgs WHERE slug=?', 'recon-test');
  if (existing) { orgId = existing.id; return; }
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'Recon Test Co', slug: 'recon-test', business_date: AS_OF, kind: 'live', created_at: nowIso() });
  const uid = id('usr');
  insert('users', {
    id: uid, org_id: orgId, email: 'admin@recon-test.test', name: 'Recon Admin',
    kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
  });
  insert('role_assignments', { id: id('ra'), org_id: orgId, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  ensureCoa(orgId);
});

function mkBatch(over: Partial<BatchRow>): BatchRow {
  const b: BatchRow = {
    id: id('imp'), org_id: orgId, kind: 'rent_roll', filename: 'test.xlsx',
    property_id: null, new_property_name: null, preset: null,
    headers: '[]', mapping: '{}', rows: '[]', staged: '[]',
    as_of: AS_OF, status: 'staged', created_by: 'test',
    ...over,
  } as BatchRow;
  insert('import_batches', { ...b, summary: null, created_at: nowIso(), applied_at: null } as unknown as Record<string, unknown>);
  return b;
}

// ---------- 1 · reading-plan structural fixes ----------

test('applyReadingPlan merges a stacked header even when the plan calls the sub-label row a section', () => {
  const rows = [
    ['Station U & O (1022)', '', '', '', ''],
    ['Unit', 'Unit', 'Name', 'Amount', 'Lease'],
    ['', 'Sq Ft', '', '', 'Expiration'],
    ['201', '750', 'Beltran, Angel', '1696.00', '3/28/2025'],
    ['202', '640', 'Karamoko, Melo', '1318.00', '10/3/2025'],
  ];
  const plan: ReadingPlan = {
    header_row: 1,
    cols: { 0: 'unit', 2: 'tenant', 3: 'rent' },
    skip_rows: [0],
    sections: [{ row: 2, property: 'Sq Ft' }], // the live failure: sub-labels misread as a section
  };
  const out = applyReadingPlan(rows, plan, 'rent_roll');
  assert.ok(out.headers[1]!.includes('Sq Ft'), `header merged (got "${out.headers[1]}")`);
  assert.ok(out.headers[4]!.includes('Expiration'), 'Lease Expiration merged');
  assert.equal(out.dataRows.length, 2, 'sub-label row consumed, real rows kept');
  assert.ok(!out.headers.includes('Property'), 'bogus section did not inject a property column');
  assert.ok(out.notes.some((n) => /stacked two-row header/i.test(n)), 'merge noted');
});

test('applyReadingPlan still honors real property sections deeper in the sheet', () => {
  const rows = [
    ['Unit', 'Name', 'Rent'],
    ['Maple Court', '', ''],
    ['101', 'A Person', '1000.00'],
    ['Birch Yard', '', ''],
    ['201', 'B Person', '1100.00'],
  ];
  const plan: ReadingPlan = {
    header_row: 0, cols: { 0: 'unit', 1: 'tenant', 2: 'rent' }, skip_rows: [],
    sections: [{ row: 1, property: 'Maple Court' }, { row: 3, property: 'Birch Yard' }],
  };
  const out = applyReadingPlan(rows, plan, 'rent_roll');
  assert.equal(out.headers[0], 'Property', 'synthetic property column injected');
  assert.deepEqual(out.dataRows.map((r) => r[0]), ['Maple Court', 'Birch Yard']);
});

// ---------- 2 · reconciliation strip + column warnings ----------

const RR_HEADERS = ['Unit', 'Name', 'Rent', 'Deposit', 'Balance'];
const RR_MAPPING = js({ cols: { 0: 'unit', 1: 'tenant', 2: 'rent', 3: 'deposit', 4: 'balance' }, preset: null, aiAssisted: [] });

function rrRows(mut: (i: number) => [string, string, string], n = 12): string[][] {
  return Array.from({ length: n }, (_, i) => {
    const [rent, dep, bal] = mut(i);
    return [`${101 + i}`, `Tenant ${String.fromCharCode(65 + i)}`, rent, dep, bal];
  });
}

test('recon strip totals tie out and stay warning-free on clean data', () => {
  const batch = mkBatch({
    new_property_name: 'Clean Prop', headers: js(RR_HEADERS), mapping: RR_MAPPING,
    rows: js(rrRows((i) => [`${1400 + i}.00`, '500.00', i < 3 ? `${100 + i}.25` : '0'])),
  });
  const v = validateRentRoll(sysCtx(orgId, AS_OF), batch);
  assert.ok(v.recon, 'recon computed');
  assert.equal(v.recon!.units, 12);
  assert.equal(v.recon!.occupied, 12);
  assert.equal(v.recon!.rentCents, Array.from({ length: 12 }, (_, i) => (1400 + i) * 100).reduce((a, b) => a + b));
  assert.equal(v.recon!.depositCents, 12 * 50000);
  assert.equal(v.recon!.balanceCents, 10025 + 10125 + 10225);
  assert.deepEqual(v.recon!.columnWarnings, [], 'no false-positive warnings');
});

test('an all-zero deposit column raises a mis-mapping warning naming the source header', () => {
  const batch = mkBatch({
    new_property_name: 'Zero Dep Prop', headers: js(['Unit', 'Name', 'Rent', 'Other', 'Balance']),
    mapping: RR_MAPPING, rows: js(rrRows((i) => [`${1400 + i}.00`, '0', `${50 + i}.00`])),
  });
  const v = validateRentRoll(sysCtx(orgId, AS_OF), batch);
  const w = v.recon!.columnWarnings.find((x) => /deposit/i.test(x) && /\$0 on every row/.test(x));
  assert.ok(w, `deposit warning present (${js(v.recon!.columnWarnings)})`);
  assert.ok(w!.includes('“Other”'), 'names the mis-mapped source column');
});

test('a uniform balance value raises the identical-values warning', () => {
  const batch = mkBatch({
    new_property_name: 'Uniform Bal Prop', headers: js(RR_HEADERS), mapping: RR_MAPPING,
    rows: js(rrRows(() => ['1500.00', '750.00', '14.50'])),
  });
  const v = validateRentRoll(sysCtx(orgId, AS_OF), batch);
  assert.ok(v.recon!.columnWarnings.some((x) => /identical \(\$14\.50\)/.test(x)), 'uniform balance flagged');
});

test('several occupied units sharing a small rent raises the parking-as-rent warning', () => {
  const batch = mkBatch({
    new_property_name: 'Parking Rent Prop', headers: js(RR_HEADERS), mapping: RR_MAPPING,
    rows: js(rrRows((i) => [i < 3 ? '300.00' : `${1400 + i}.00`, '600.00', `${20 + i}.00`])),
  });
  const v = validateRentRoll(sysCtx(orgId, AS_OF), batch);
  assert.ok(v.recon!.columnWarnings.some((x) => /3 occupied units .*\$300\.00/.test(x) && /parking/i.test(x)), 'parking-as-rent flagged');
});

// ---------- 3 · resident-directory mass-insert guard ----------

test('a directory that matches nobody is blocked from applying until explicitly confirmed', () => {
  const ctx = sysCtx(orgId, AS_OF);
  // real leases first: a clean 12-unit rent roll builds the property
  const rr = mkBatch({
    new_property_name: 'Guard Prop', headers: js(RR_HEADERS), mapping: RR_MAPPING,
    rows: js(rrRows((i) => [`${1400 + i}.00`, '0', '0'])),
  });
  applyRentRoll(ctx, rr);
  const prop = q1<{ id: string }>('SELECT id FROM properties WHERE org_id=? AND name=?', orgId, 'Guard Prop')!;

  // a directory naming 12 strangers on those same units
  const dirRows = Array.from({ length: 12 }, (_, i) => [`${101 + i}`, `Stranger, Completely ${i}`, `s${i}@x.test`]);
  const dir = mkBatch({
    kind: 'residents', property_id: prop.id,
    headers: js(['Unit', 'Resident', 'Email']),
    mapping: js({ cols: { 0: 'unit', 1: 'tenant', 2: 'email' }, preset: null, aiAssisted: [] }),
    rows: js(dirRows),
  });

  const v = validateResidents(ctx, dir);
  assert.ok(v.duplicateGuard, 'guard tripped');
  assert.equal(v.duplicateGuard!.inserts, 12);
  assert.equal(v.duplicateGuard!.matched, 0);
  assert.throws(() => applyResidents(ctx, dir), /match anyone/);

  // confirmed: the same batch applies, as new residents
  const s = applyResidents(ctx, dir, { confirmDuplicates: true });
  assert.equal(s.residents, 12, 'confirmed apply inserts the new people');
});

test('a directory that matches the rent roll by name merges without tripping the guard', () => {
  const ctx = sysCtx(orgId, AS_OF);
  const rr = mkBatch({
    new_property_name: 'Merge Prop', headers: js(RR_HEADERS), mapping: RR_MAPPING,
    rows: js(rrRows((i) => [`${1400 + i}.00`, '0', '0'])),
  });
  applyRentRoll(ctx, rr);
  const prop = q1<{ id: string }>('SELECT id FROM properties WHERE org_id=? AND name=?', orgId, 'Merge Prop')!;

  // same people, directory-style "Last, First" ordering ("Tenant A" → "A, Tenant")
  const dirRows = Array.from({ length: 12 }, (_, i) => [`${101 + i}`, `${String.fromCharCode(65 + i)}, Tenant`, `t${i}@merge.test`]);
  const dir = mkBatch({
    kind: 'residents', property_id: prop.id,
    headers: js(['Unit', 'Resident', 'Email']),
    mapping: js({ cols: { 0: 'unit', 1: 'tenant', 2: 'email' }, preset: null, aiAssisted: [] }),
    rows: js(dirRows),
  });
  const v = validateResidents(ctx, dir);
  assert.equal(v.duplicateGuard, undefined, 'no guard on a matching directory');
  const s = applyResidents(ctx, dir);
  assert.equal(s.contactUpdates, 12, 'all 12 merged as contact updates');
  assert.equal(s.residents, 0, 'nobody duplicated');
});

// ---------- 4 · the block-format Yardi rent roll, read end to end ----------

const YARDI_ROWS = YARDI_BLOCK_ROLL;

/** The upload path's spreadsheet transform, in the order routes.ts runs it. */
function readYardi(rows: string[][]): { headers: string[]; dataRows: string[][]; mapping: Mapping; property: string } {
  const kind = 'rent_roll' as const;
  const headerIdx = findHeaderRow(rows, kind);
  let headers = (rows[headerIdx] || []).map(String);
  let dataRows = rows.slice(headerIdx + 1).filter((r) => r.some((c) => String(c).trim() !== ''));
  let mapping = autoMap(headers, kind, dataRows.slice(0, 8));
  const stacked = mergeStackedHeader(headers, rows[headerIdx + 1]);
  const mapped = (m: Mapping): number => Object.values(m.cols).filter(Boolean).length;
  if (stacked.merged) {
    const merged = autoMap(stacked.headers, kind, dataRows.slice(1, 9));
    if (mapped(merged) > mapped(mapping)) { headers = stacked.headers; dataRows = dataRows.slice(1); mapping = merged; }
  }
  const source = parseSourceSummary(rows);
  const scan = scanRosterSections(dataRows, mapping);
  if (scan.sectioned && (scan.futureRows.length || scan.summaryRows)) {
    dataRows = scan.rows;
    mapping.excluded = { futureApplicants: scan.futureUnits.length, futureUnits: scan.futureUnits, summaryRows: scan.summaryRows };
  }
  const h = harvestSubRowCharges(dataRows, mapping, headers);
  dataRows = h.rows;
  if (h.rentCode) mapping.rentCode = { code: h.rentCode, from: 'frequency', extras: [...h.codes] };
  if (Object.keys(h.codeNature).length) mapping.codeNature = h.codeNature;
  if (h.harvestedRows > 0 || h.demotedRows > 0) {
    const extraIdx = headers.length;
    headers = [...headers, 'Other monthly charges'];
    mapping.cols[extraIdx] = 'extra_monthly';
    dataRows = dataRows.map((r, i) => {
      const e = h.extraByRow.get(i);
      const row = Array.from({ length: extraIdx }, (_, ci) => String(r[ci] ?? ''));
      row.push(e ? (e.cents / 100).toFixed(2) : '');
      return row;
    });
  }
  if (h.subsidyCents > 0) {
    const subIdx = headers.length;
    headers = [...headers, 'Housing subsidy (of the rent)'];
    mapping.cols[subIdx] = 'subsidy';
    dataRows = dataRows.map((r, i) => {
      const sub = h.subsidyByRow.get(i);
      const row = Array.from({ length: subIdx }, (_, ci) => String(r[ci] ?? ''));
      row.push(sub ? (sub.cents / 100).toFixed(2) : '');
      return row;
    });
  }
  if (source) mapping.source = source;
  return { headers, dataRows, mapping, property: detectDocumentProperty(rows, headerIdx) || '' };
}

test('yardi block roll: the header merges, the preset lands, and the property comes off the banner', () => {
  const { headers, mapping, property } = readYardi(YARDI_ROWS);
  assert.equal(property, 'Ridgeline Court at Fairview');
  assert.deepEqual(headers.slice(0, 8), ['Unit', 'Unit Type', 'Unit Sq Ft', 'Resident', 'Name', 'Market Rent', 'Charge Code', 'Amount']);
  assert.equal(mapping.preset, 'yardi');
  const by = Object.fromEntries(Object.entries(mapping.cols).filter(([, f]) => f).map(([c, f]) => [f, Number(c)]));
  assert.equal(by.unit, 0, 'unit column');
  assert.equal(by.tenant, 4, 'Name is the household — NOT the "Resident" t-code column');
  assert.equal(by.rent, 7, 'Amount beside the charge code is the rent');
  assert.equal(by.deposit, 8, 'Resident Deposit, not Other Deposit');
  assert.equal(by.sqft, 2, 'the stacked "Unit / Sq Ft" pair');
  assert.equal(mapping.cols[3], undefined, 'the resident t-code column stays unmapped');
});

test('yardi block roll: roster sections split current leases from future applicants and the trailer', () => {
  const { mapping, dataRows } = readYardi(YARDI_ROWS);
  assert.equal(dataRows.length, 4, 'only the four current units survive');
  assert.deepEqual(dataRows.map((r) => r[0]), ['201', '205', '245', '523']);
  assert.equal(mapping.excluded?.futureApplicants, 2);
  assert.deepEqual(mapping.excluded?.futureUnits, ['523', '601']);
  assert.ok((mapping.excluded?.summaryRows ?? 0) >= 10, 'the report trailer is set aside, not read as units');
});

/** The same `rnsvchr` code must land in the same place on both units, whatever
 * row it sits on — the audit's Bug 1, where 245 (voucher on its only row) was
 * read as rent and 205 (voucher on its second row) was read as "other", so
 * position decided the answer instead of the code. */
test('the same charge code classifies identically wherever it sits in the block', () => {
  const { mapping } = readYardi(YARDI_ROWS);
  assert.equal(mapping.rentCode?.code, 'rntnt');
  assert.equal(mapping.codeNature?.rntnt, 'rent');
  assert.equal(mapping.codeNature?.rnsvchr, 'subsidy', 'a housing voucher is part of contract rent, not an ancillary charge');
});

/** Doctrine reversal, 2026-08-13: rent is CONTRACT rent — the tenant's portion
 * plus any voucher on top of it — because that is what the unit rents for and
 * what the rent roll's own Total line says. The previous rule (rent = the
 * rent-code amount alone) understated the rent roll by $10,139/mo and priced
 * renewal offers ~$1,130/mo below contract rent. Ancillary codes still stay
 * out of rent; a voucher is not ancillary. */
test('rent is the contract rent, and the voucher is recorded as who pays it', () => {
  const { dataRows, mapping } = readYardi(YARDI_ROWS);
  const rentCol = Number(Object.entries(mapping.cols).find(([, f]) => f === 'rent')![0]);
  const subCol = Number(Object.entries(mapping.cols).find(([, f]) => f === 'subsidy')![0]);

  // 245 is fully subsidised: the voucher IS the rent, none of it from the resident
  const unit245 = dataRows.find((r) => r[0] === '245')!;
  assert.equal(moneyToCents(unit245[rentCol]!), 141700, 'a fully-subsidised unit still rents for $1,417');
  assert.equal(moneyToCents(unit245[subCol]!), 141700, 'and every cent of it is paid by the voucher');

  // 205 splits: $348 from the resident, $766 from the voucher, $1,114 contract
  const unit205 = dataRows.find((r) => r[0] === '205')!;
  assert.equal(moneyToCents(unit205[rentCol]!), 111400, 'contract rent is both codes together');
  assert.equal(moneyToCents(unit205[subCol]!), 76600, 'the voucher portion is the payer split');
});

test('yardi block roll: the report summary is parsed and every recon line ties to it', () => {
  const ctx = sysCtx(orgId, '2026-08-11');
  const { headers, dataRows, mapping, property } = readYardi(YARDI_ROWS);
  const src = mapping.source!;
  assert.equal(src.units, 4);
  assert.equal(src.occupiedUnits, 3);
  assert.equal(src.vacantUnits, 1);
  assert.equal(src.futureUnits, 2);
  assert.equal(src.marketRentCents, 548000);
  assert.equal(src.leaseChargesCents, 402200);
  assert.deepEqual(src.chargeCodes, { rntnt: 183900, rnsvchr: 218300 });

  const batch = mkBatch({
    new_property_name: property, as_of: '2026-08-11',
    headers: js(headers), mapping: js(mapping), rows: js(dataRows),
  });
  const v = validateRentRoll(ctx, batch);
  assert.equal(v.error, 0, `a clean report must review clean: ${v.rows.flatMap((r) => r.notes).join(' | ')}`);
  assert.equal(v.recon!.units, 4);
  assert.equal(v.recon!.occupied, 3);
  assert.equal(v.recon!.rentCents, 402200, 'rent is the contract rent — both codes, the report\u2019s own Total line');
  assert.equal(v.recon!.subsidyCents, 218300, 'the voucher portion is tracked as who pays, not as a rent reduction');
  assert.equal(v.recon!.extraMonthlyCents, 0, 'neither code is ancillary, so nothing lands in other charges');
  assert.equal(v.recon!.futureApplicants, 2);
  const ties = v.recon!.tieOuts!;
  assert.ok(ties.length >= 8, 'the tie-out covers units, occupancy, rent, the split, deposits and balances');
  assert.deepEqual(ties.filter((t) => !t.ok), [], 'every line ties to the report');
  assert.deepEqual(v.recon!.columnWarnings, [], 'genuinely-$0 deposits and balances are not mis-mapping warnings');
});

test('yardi block roll: applying it bills rent and the subsidy as separate monthly charges', () => {
  const ctx = sysCtx(orgId, '2026-08-11');
  const { headers, dataRows, mapping } = readYardi(YARDI_ROWS);
  const batch = mkBatch({
    new_property_name: 'Ridgeline Apply Test', as_of: '2026-08-11',
    headers: js(headers), mapping: js(mapping), rows: js(dataRows),
  });
  const s = applyRentRoll(ctx, batch);
  assert.equal(s.units, 4);
  assert.equal(s.leases, 3, 'the vacant unit gets no lease; the future applicants never reached apply');
  const pid = q1<{ id: string }>('SELECT id FROM properties WHERE org_id=? AND name=?', orgId, 'Ridgeline Apply Test')!.id;
  const sum = (kind: string): number => q1<{ t: number }>(
    `SELECT COALESCE(SUM(lc.amount_cents),0) t FROM lease_charges lc JOIN leases l ON l.id=lc.lease_id WHERE l.property_id=? AND lc.kind=?`, pid, kind,
  )!.t;
  // what the RESIDENTS are billed is contract rent less the voucher — billing
  // them the whole contract rent would invoice them for someone else's money
  assert.equal(sum('rent'), 183900, 'residents are billed only their own portion');
  assert.equal(sum('other'), 0, 'the voucher is not an ancillary charge');
  const contract = q1<{ t: number }>(
    `SELECT COALESCE(SUM(rent_cents),0) t FROM leases WHERE property_id=?`, pid,
  )!.t;
  const subsidy = q1<{ t: number }>(
    `SELECT COALESCE(SUM(subsidy_cents),0) t FROM leases WHERE property_id=?`, pid,
  )!.t;
  assert.equal(contract, 402200, 'the leases carry the full contract rent — what the rent roll reports');
  assert.equal(subsidy, 218300, 'and the voucher share is recorded against it');
  const u245 = q1<{ id: string }>('SELECT id FROM units WHERE property_id=? AND unit_number=?', pid, '245')!;
  const lease245 = q1<{ id: string; rent_cents: number; subsidy_cents: number }>(
    'SELECT id, rent_cents, subsidy_cents FROM leases WHERE unit_id=?', u245.id,
  )!;
  assert.equal(lease245.rent_cents, 141700, 'a fully-subsidised unit still rents for $1,417');
  assert.equal(lease245.subsidy_cents, 141700, 'all of it paid by the voucher');
  const rent245 = q1<{ amount_cents: number }>(`SELECT amount_cents FROM lease_charges WHERE lease_id=? AND kind='rent'`, lease245.id)!;
  assert.equal(rent245.amount_cents, 0, 'so the resident is billed nothing');
});

test('recon warns loudly when a mapping does not tie to the report summary', () => {
  const ctx = sysCtx(orgId, '2026-08-11');
  const { headers, dataRows, mapping, property } = readYardi(YARDI_ROWS);
  // the operator re-maps rent onto the market-rent column, as on the live run
  const rentCol = Number(Object.entries(mapping.cols).find(([, f]) => f === 'rent')![0]);
  const broken = { ...mapping, cols: { ...mapping.cols, [rentCol]: '', 5: 'rent' } };
  const batch = mkBatch({
    new_property_name: property, as_of: '2026-08-11',
    headers: js(headers), mapping: js(broken), rows: js(dataRows),
  });
  const v = validateRentRoll(ctx, batch);
  const off = v.recon!.tieOuts!.filter((t) => !t.ok);
  assert.ok(off.length, 'a mis-mapped rent column has to break a tie-out line');
  assert.ok(off.some((t) => /^Rent/.test(t.label)), 'and it is the rent line that breaks');
  assert.ok(v.recon!.columnWarnings.some((w) => /do(es)? not tie to the summary block/.test(w)), 'and it is said out loud');
});

// ---------- 5 · what the AI is shown, and what it is not trusted with ----------

test('the sheet the AI reads keeps the headings buried in the middle of a long file', () => {
  const rows: string[][] = [['Unit', 'Name', 'Amount']];
  for (let i = 0; i < 200; i++) rows.push([`${100 + i}`, `Resident ${i}`, '1450']);
  rows.splice(150, 0, ['Future Residents/Applicants', '', '']);
  for (let i = 0; i < 40; i++) rows.push([`${400 + i}`, `Applicant ${i}`, '0']);
  const rendered = renderSheetForAi(rows);
  assert.ok(rendered.includes('Future Residents/Applicants'), 'a section heading past the head window must still reach the model');
  assert.ok(/\d+ more data rows omitted/.test(rendered), 'the uniform runs between headings still collapse');
  assert.ok(rendered.split('\n').length < rows.length, 'and the rendering stays smaller than the sheet');
});

test('a reading plan may not turn a roster heading into a property', () => {
  const plan = validatePlan({
    header_row: 0,
    cols: { 0: 'unit', 1: 'tenant', 2: 'rent' },
    sections: [{ row: 3, property: 'Future Residents/Applicants' }, { row: 6, property: 'Maple Court' }],
    skip_rows: [],
  }, 10, 3, 'rent_roll')!;
  assert.deepEqual(plan.sections, [{ row: 6, property: 'Maple Court' }], 'only a real building stays a section');
  assert.ok(plan.skip_rows.includes(3), 'the roster heading is skipped instead');
});

test('a reading plan may name the rent charge code, but only one the file contains', () => {
  const plan = validatePlan({ header_row: 0, cols: { 0: 'unit', 3: 'rent' }, rent_code: 'rntnt' }, 10, 5, 'rent_roll')!;
  assert.equal(plan.rent_code, 'rntnt');
  const mapping = { cols: { 0: 'unit', 2: 'rent' } as Record<number, string>, preset: null, aiAssisted: [] };
  const rows = [
    ['211', 'Allan Rodriguez', '1413', 'rntnt'],
    ['', '', '60', 'tsprkg'],
    ['', '', '1473', 'Total'],
  ];
  const invented = harvestSubRowCharges(rows, mapping as Mapping, ['Unit', 'Tenant', 'Amount', 'Charge Code'], 'notacode');
  assert.equal(invented.rentCode, 'rntnt', 'a code the file does not contain is ignored, not obeyed');
  const honoured = harvestSubRowCharges(rows, mapping as Mapping, ['Unit', 'Tenant', 'Amount', 'Charge Code'], 'tsprkg');
  assert.equal(honoured.rentCode, 'tsprkg', 'a code the file does contain wins over frequency');
});
