import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert, js } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword, sysCtx } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import {
  autoMap, findHeaderRow, mergeStackedHeader, harvestSubRowCharges, scanRosterSections,
  parseSourceSummary, detectDocumentPropertyBanner, classifyChargeCode, type Mapping,
} from '../src/modules/setup/mapping.ts';
import { validateRentRoll, applyRentRoll, floorFromUnit, type BatchRow } from '../src/modules/setup/import_apply.ts';
import { unitStats } from '../src/modules/m2_portfolio/service.ts';
import { receivablesStats } from '../src/modules/m8_receivables/payments.ts';
import { LIVINGSTON_RENT_ROLL as ROWS, LIVINGSTON_EXPECTED as E } from './fixtures/livingston_rent_roll.ts';

/** The Test LLC audit, as a gate.
 *
 * A 152-unit Yardi rent roll was imported into a live org on 2026-08-12 and
 * then diffed screen by screen against the workbook. The unit and lease layer
 * was perfect; the money layer was wrong in five ways at once, and none of it
 * was visible on any screen. These are that audit's acceptance criteria, run
 * against the same document. Every number here comes from the report's own
 * summary block, so a regression shows up as a mismatch with the source rather
 * than with a number someone wrote down. */

const AS_OF = '2026-08-11';
let orgId: string;

before(() => {
  db();
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'Livingston Gate', slug: `livingston-${orgId.slice(-6)}`, business_date: AS_OF, kind: 'live', created_at: nowIso() });
  const uid = id('usr');
  insert('users', {
    id: uid, org_id: orgId, email: `admin@${orgId.slice(-6)}.test`, name: 'Gate Admin',
    kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
  });
  insert('role_assignments', { id: id('ra'), org_id: orgId, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  ensureCoa(orgId);
});

/** The upload route's spreadsheet transform, in the order routes.ts runs it. */
function read(): { headers: string[]; dataRows: string[][]; futureRows: string[][]; mapping: Mapping; property: string } {
  const kind = 'rent_roll' as const;
  const hi = findHeaderRow(ROWS, kind);
  let headers = (ROWS[hi] || []).map(String);
  let dataRows = ROWS.slice(hi + 1).filter((r) => r.some((c) => String(c).trim() !== ''));
  let mapping = autoMap(headers, kind, dataRows.slice(0, 8));
  const stacked = mergeStackedHeader(headers, ROWS[hi + 1]);
  const mapped = (m: Mapping): number => Object.values(m.cols).filter(Boolean).length;
  if (stacked.merged) {
    const merged = autoMap(stacked.headers, kind, dataRows.slice(1, 9));
    if (mapped(merged) > mapped(mapping)) { headers = stacked.headers; dataRows = dataRows.slice(1); mapping = merged; }
  }
  const source = parseSourceSummary(ROWS)!;
  const scan = scanRosterSections(dataRows, mapping);
  dataRows = scan.rows;
  mapping.excluded = {
    futureApplicants: scan.futureUnits.length, futureUnits: scan.futureUnits,
    summaryRows: scan.summaryRows, setAside: scan.setAside,
  };
  const h = harvestSubRowCharges(dataRows, mapping, headers);
  dataRows = h.rows;
  if (h.rentCode) mapping.rentCode = { code: h.rentCode, from: 'frequency', extras: [...h.codes] };
  mapping.codeNature = h.codeNature;
  if (h.harvestedRows > 0 || h.demotedRows > 0) {
    const ci = headers.length;
    headers = [...headers, 'Other monthly charges'];
    mapping.cols[ci] = 'extra_monthly';
    dataRows = dataRows.map((r, i) => {
      const e = h.extraByRow.get(i);
      const row = Array.from({ length: ci }, (_, c) => String(r[c] ?? ''));
      row.push(e ? (e.cents / 100).toFixed(2) : '');
      return row;
    });
  }
  if (h.subsidyCents > 0) {
    const ci = headers.length;
    headers = [...headers, 'Housing subsidy (of the rent)'];
    mapping.cols[ci] = 'subsidy';
    dataRows = dataRows.map((r, i) => {
      const sub = h.subsidyByRow.get(i);
      const row = Array.from({ length: ci }, (_, c) => String(r[c] ?? ''));
      row.push(sub ? (sub.cents / 100).toFixed(2) : '');
      return row;
    });
  }
  const banner = detectDocumentPropertyBanner(ROWS, hi)!;
  mapping.source = source;
  mapping.sourceProperty = banner;
  return { headers, dataRows, futureRows: scan.futureRows, mapping, property: banner.name };
}

function imported(): { pid: string; ctx: ReturnType<typeof sysCtx> } {
  const ctx = sysCtx(orgId, AS_OF);
  const { headers, dataRows, futureRows, mapping, property } = read();
  const batch: BatchRow = {
    id: id('imp'), org_id: orgId, kind: 'rent_roll', filename: 'livingston.xlsx',
    property_id: null, new_property_name: property, preset: mapping.preset,
    headers: js(headers), mapping: js(mapping), rows: js(dataRows), staged: js(futureRows),
    as_of: AS_OF, status: 'staged', created_by: 'gate',
  } as BatchRow;
  insert('import_batches', { ...batch, summary: null, created_at: nowIso(), applied_at: null } as unknown as Record<string, unknown>);
  applyRentRoll(ctx, batch);
  return { pid: q1<{ id: string }>('SELECT id FROM properties WHERE org_id=? AND name=?', orgId, property)!.id, ctx };
}

let once: { pid: string; ctx: ReturnType<typeof sysCtx> } | null = null;
const portfolio = (): { pid: string; ctx: ReturnType<typeof sysCtx> } => (once ||= imported());

// ---------- the reconciliation the audit had to do by hand ----------

test('every recon line ties to the report’s own summary, with no false warnings', () => {
  const { headers, dataRows, futureRows, mapping, property } = read();
  const batch = {
    id: id('imp'), org_id: orgId, kind: 'rent_roll', filename: 'l.xlsx',
    property_id: null, new_property_name: property, preset: mapping.preset,
    headers: js(headers), mapping: js(mapping), rows: js(dataRows), staged: js(futureRows),
    as_of: AS_OF, status: 'staged', created_by: 'gate',
  } as BatchRow;
  insert('import_batches', { ...batch, summary: null, created_at: nowIso(), applied_at: null } as unknown as Record<string, unknown>);
  const v = validateRentRoll(sysCtx(orgId, AS_OF), batch);

  assert.equal(v.error, 0, `a clean report must review clean: ${v.rows.filter((r) => r.level === 'error').map((r) => r.notes.join(';')).slice(0, 5).join(' | ')}`);
  assert.deepEqual(v.recon!.tieOuts!.filter((t) => !t.ok), [], 'every line ties to the report');
  assert.deepEqual(v.recon!.columnWarnings, [], 'genuinely-$0 deposits and balances are not mis-mappings');
  assert.equal(v.recon!.units, E.units);
  assert.equal(v.recon!.occupied, E.occupied);
  assert.equal(v.recon!.marketRentCents, E.marketRentCents);
  assert.equal(v.recon!.rentCents, E.leaseChargesCents, 'rent is the contract rent — the report’s own Total line');
  assert.equal(v.recon!.subsidyCents, E.rnsvchrCents);
  assert.equal(v.recon!.depositCents, 0);
  assert.equal(v.recon!.balanceCents, 0);
  assert.equal(v.recon!.futureApplicants, E.futureApplicants);
});

// ---------- Bug 1: classification is by code, never by position ----------

test('units 205 and 245 classify their rnsvchr rows identically', () => {
  const { mapping } = read();
  assert.equal(mapping.codeNature!.rnsvchr, 'subsidy');
  assert.equal(mapping.codeNature!.rntnt, 'rent');
  // 245 carries it on its ONLY row, 205 on its second — position must not matter
  assert.equal(classifyChargeCode('rnsvchr', 'rntnt'), 'subsidy');
  assert.equal(classifyChargeCode('tsprkg', 'rntnt'), 'ancillary', 'parking is not rent in either direction');
});

// ---------- Bug 2 / 3: the rent roll total, and what renewals price off ----------

test('the Rent Roll report totals $177,893 and residents are billed $166,337', () => {
  const { pid } = portfolio();
  const contract = q1<{ t: number }>(
    `SELECT COALESCE(SUM(rent_cents),0) t FROM leases WHERE property_id=? AND status IN ('active','month_to_month','notice')`, pid,
  )!.t;
  assert.equal(contract, E.leaseChargesCents, 'the number the Rent Roll report reads');

  const subsidy = q1<{ t: number }>(`SELECT COALESCE(SUM(subsidy_cents),0) t FROM leases WHERE property_id=?`, pid)!.t;
  assert.equal(subsidy, E.rnsvchrCents, 'the voucher share, recorded as who pays');

  const billed = q1<{ t: number }>(
    `SELECT COALESCE(SUM(lc.amount_cents),0) t FROM lease_charges lc JOIN leases l ON l.id=lc.lease_id
      WHERE l.property_id=? AND l.status IN ('active','month_to_month','notice')`, pid,
  )!.t;
  assert.equal(billed, E.rntntCents, 'residents are billed their own portion, never the voucher');
});

test('no lease prices a renewal off less than what it actually rents for', () => {
  const { pid } = portfolio();
  // Bug 3: the holdover premium multiplies leases.rent_cents, so an understated
  // rent produced offers ~$1,130/mo below contract rent. Contract rent must be
  // at least the resident's own recurring rent charge, on every lease.
  const bad = q<{ unit_number: string; rent_cents: number; charged: number }>(
    `SELECT u.unit_number, l.rent_cents, COALESCE(SUM(lc.amount_cents),0) charged
       FROM leases l JOIN units u ON u.id=l.unit_id
       LEFT JOIN lease_charges lc ON lc.lease_id=l.id AND lc.kind='rent'
      WHERE l.property_id=? GROUP BY l.id HAVING l.rent_cents < charged`, pid,
  );
  assert.deepEqual(bad, [], 'a renewal may never be priced from a rent below the lease’s own rent charges');
});

// ---------- Bug 4: the future-residents section ----------

test('16 future residents import as signed leases and stop overstating availability', () => {
  const { pid, ctx } = portfolio();
  const future = q<{ unit_number: string }>(
    `SELECT u.unit_number FROM leases l JOIN units u ON u.id=l.unit_id
      WHERE l.property_id=? AND l.status='fully_executed' ORDER BY CAST(u.unit_number AS INTEGER)`, pid,
  );
  assert.equal(future.length, E.futureApplicants);
  assert.deepEqual(
    future.map((f) => f.unit_number).sort(),
    [...E.futureUnits].sort(),
    'every unit the report pre-leased carries its future lease',
  );
  for (const u of E.futureUnits.slice(0, 4)) {
    const r = q1(`SELECT r.id FROM residents r JOIN household_members hm ON hm.resident_id=r.id
                  JOIN leases l ON l.id=hm.lease_id JOIN units un ON un.id=l.unit_id
                  WHERE un.unit_number=? AND l.property_id=? AND l.status='fully_executed'`, u, pid);
    assert.ok(r, `unit ${u}'s future resident is findable`);
  }
  const stats = unitStats(ctx, pid);
  assert.equal(stats.preleased, E.futureApplicants, 'pre-leased units are counted as such');
  assert.equal(stats.available, E.genuinelyAvailable, 'only the genuinely unassigned units read as available');
  assert.equal(stats.occupied, E.occupied, 'a future lease is not an occupied one');
});

test('nothing the reader set aside is reported as a bare count', () => {
  const { mapping } = read();
  const setAside = mapping.excluded!.setAside!;
  assert.ok(setAside.length >= E.futureApplicants, 'every set-aside row is enumerated');
  for (const u of E.futureUnits) {
    assert.ok(setAside.some((r) => r.label === `unit ${u}`), `unit ${u} is named, not just counted`);
  }
  assert.ok(setAside.every((r) => r.reason), 'each carries a reason');
});

// ---------- Bug 5: nothing invented, nothing falsely delinquent ----------

test('no household is delinquent and nothing is past due at import time', () => {
  const { pid } = portfolio();
  const charges = q1<{ n: number; t: number }>(
    `SELECT COUNT(*) n, COALESCE(SUM(c.amount_cents),0) t FROM charges c JOIN leases l ON l.id=c.lease_id WHERE l.property_id=?`, pid,
  )!;
  assert.equal(charges.n, 0, 'a migration bills nothing on the day it lands — least of all an insurance program nobody chose');
  assert.equal(charges.t, 0);
  const ins = q1<{ n: number }>(
    `SELECT COUNT(*) n FROM lease_charges lc JOIN leases l ON l.id=lc.lease_id WHERE l.property_id=? AND lc.kind='insurance'`, pid,
  )!.n;
  assert.equal(ins, 0, 'no master policy is force-placed on a migrated household');
});

// ---------- Bug 7 / 9: the property, and the detail the import used to invent ----------

test('the property keeps its whole name and its source key', () => {
  const { pid } = portfolio();
  const p = q1<{ name: string; source_ref: string; timezone: string }>('SELECT name, source_ref, timezone FROM properties WHERE id=?', pid)!;
  assert.equal(p.name, E.property, 'the full name, not a 27-character prefix of it');
  assert.equal(p.source_ref, E.yardiCode, 'the Yardi code is the key the next reconciliation joins on');
  assert.notEqual(p.timezone, 'America/Denver', 'a DC building is not on Mountain time');
});

test('floors come off the unit numbers, and resident ids and charge codes survive', () => {
  const { pid } = portfolio();
  assert.equal(floorFromUnit('201'), 2);
  assert.equal(floorFromUnit('1102'), 11);
  assert.equal(floorFromUnit('7'), 1, 'a unit number that encodes no floor gets no invented one');
  const floors = q<{ floor: number }>('SELECT DISTINCT floor FROM units WHERE property_id=? ORDER BY floor', pid);
  assert.ok(floors.length >= 4, `units span their real floors (got ${floors.map((f) => f.floor).join(',')})`);
  const refs = q1<{ n: number }>('SELECT COUNT(*) n FROM residents WHERE org_id=? AND source_ref IS NOT NULL', orgId)!.n;
  assert.ok(refs >= E.occupied, 'every imported household keeps the id its old system used');
  const codes = q1<{ n: number }>(
    `SELECT COUNT(*) n FROM lease_charges lc JOIN leases l ON l.id=lc.lease_id WHERE l.property_id=? AND lc.source_code='rntnt'`, pid,
  )!.n;
  assert.equal(codes, E.occupied, 'the source charge code rides along with the charge it created');
});

// ---------- Bug 8: a move-out that already happened ----------

test('a household whose move-out already passed schedules no rent', () => {
  const { pid } = portfolio();
  const lease = q1<{ status: string; billing_start_date: string | null; move_out_date: string }>(
    `SELECT l.status, l.billing_start_date, l.move_out_date FROM leases l JOIN units u ON u.id=l.unit_id
      WHERE l.property_id=? AND u.unit_number=?`, pid, E.pastMoveOutUnit,
  )!;
  assert.equal(lease.move_out_date, E.pastMoveOutDate, 'the date imports exactly as the source states it');
  assert.equal(lease.billing_start_date, null, 'and no rent is scheduled for a tenancy that already ended');
});

test('the lease layer the audit found perfect stays perfect', () => {
  const { pid } = portfolio();
  const counts = q1<{ leases: number; withStart: number; withEnd: number }>(
    `SELECT COUNT(*) leases,
            SUM(CASE WHEN move_in_date IS NOT NULL THEN 1 ELSE 0 END) withStart,
            SUM(CASE WHEN end_date IS NOT NULL THEN 1 ELSE 0 END) withEnd
       FROM leases WHERE property_id=? AND status IN ('active','month_to_month','notice')`, pid,
  )!;
  assert.equal(counts.leases, E.occupied, '124 current leases, unchanged');
  assert.equal(counts.withStart, E.occupied, 'every move-in date survived');
  assert.equal(counts.withEnd, E.occupied, 'every lease expiration survived');
  const units = q1<{ n: number; sqft: number }>('SELECT COUNT(*) n, COALESCE(SUM(sqft),0) sqft FROM units WHERE property_id=?', pid)!;
  assert.equal(units.n, E.units);
  assert.equal(units.sqft, E.sqft, 'square footage ties to the report');
});

// ---------- Bug 6: the books before the first billing cycle ----------

test('a portfolio that has not been billed yet reports when billing starts, not 0% collected', () => {
  const { pid, ctx } = portfolio();
  const stats = receivablesStats(ctx, ctx.businessDate.slice(0, 7), pid);
  assert.equal(stats.billed, 0, 'a mid-month migration bills nothing in the month it lands');
  assert.ok(stats.billingStartsOn, 'so the screen has a date to show instead of a rate');
  assert.ok(
    stats.billingStartsOn! > ctx.businessDate,
    `billing starts after the switch date (got ${stats.billingStartsOn})`,
  );
  // the conversion balance covers everything before that date, which is why
  // 0 collected of 0 billed is not a collection failure
  assert.equal(stats.collected, 0);
});

// ---------- Bug 9: what the source did not say is not asserted ----------

test('a floorplan whose layout the file never stated says so', () => {
  const { pid } = portfolio();
  // this rent roll HAS a Unit Type column, so its plans are named from the
  // source and carry no caveat — the guard is that a guessed layout is labelled
  const named = q<{ name: string; description: string | null }>(
    'SELECT name, description FROM floorplans WHERE property_id=?', pid,
  );
  assert.ok(named.length, 'the import created floorplans');
  for (const f of named) {
    if (f.description) {
      assert.match(f.description, /not stated in the imported rent roll/, 'a placeholder layout says it is one');
    }
  }
  // and a file with neither beds/baths nor a layout-bearing plan name gets the caveat
  const ctx = sysCtx(orgId, AS_OF);
  const headers = ['Unit', 'Name', 'Rent', 'Sq Ft'];
  const rows = [['901', 'Nobody Stated', '1200.00', '640'], ['902', 'Also Nobody', '1250.00', '780']];
  const batch = {
    id: id('imp'), org_id: orgId, kind: 'rent_roll', filename: 'nolayout.csv',
    property_id: null, new_property_name: 'No Layout Court', preset: null,
    headers: js(headers), mapping: js({ cols: { 0: 'unit', 1: 'tenant', 2: 'rent', 3: 'sqft' }, preset: null, aiAssisted: [] }),
    rows: js(rows), staged: '[]', as_of: AS_OF, status: 'staged', created_by: 'gate',
  } as BatchRow;
  insert('import_batches', { ...batch, summary: null, created_at: nowIso(), applied_at: null } as unknown as Record<string, unknown>);
  applyRentRoll(ctx, batch);
  const fps = q<{ name: string; description: string | null }>(
    `SELECT f.name, f.description FROM floorplans f JOIN properties p ON p.id=f.property_id
      WHERE p.org_id=? AND p.name='No Layout Court'`, orgId,
  );
  assert.ok(fps.length, 'the plan exists');
  for (const f of fps) {
    assert.ok(f.description, `"${f.name}" must admit its bed/bath is a placeholder`);
    assert.doesNotMatch(f.name, /bed \/ \d+ bath/, 'and must not be NAMED after the guess');
  }
});
