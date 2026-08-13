import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q1, q, insert, js } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword, sysCtx } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { validateRentRoll, applyRentRoll, type BatchRow } from '../src/modules/setup/import_apply.ts';
import {
  autoMap, findHeaderRow, mergeStackedHeader, harvestSubRowCharges,
  scanRosterSections, parseSourceSummary, detectDocumentProperty, moneyToCents, type Mapping,
} from '../src/modules/setup/mapping.ts';
import { AUDUBON_BLOCK_ROLL } from './fixtures/audubon_block_roll.ts';

/** The 606-unit gate (2026-08-13) — born from the second real-data run, a
 * Section 18/RAD affordable property whose rent roll read 539 of 606 units.
 * Every dropped row was a REAL tenancy: the zero-charge households carrying
 * the portfolio's largest balances, 41 occupied parking licenses, two
 * employee units billed a negative concession, one inverted lease term, and
 * eight negative/zero coded sub-rows that fell out of their blocks. A row the
 * reader cannot price is a row to import at $0 with a warning and evidence —
 * never a row to discard: on a migration, discarding the unpriceable rows
 * means discarding exactly the households the product exists to manage. */

const AS_OF = '2026-08-13';
let orgId: string;

before(() => {
  db();
  const existing = q1<{ id: string }>('SELECT id FROM orgs WHERE slug=?', 'audubon-test');
  if (existing) { orgId = existing.id; return; }
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'Audubon Test Co', slug: 'audubon-test', business_date: AS_OF, kind: 'live', created_at: nowIso() });
  const uid = id('usr');
  insert('users', {
    id: uid, org_id: orgId, email: 'admin@audubon-test.test', name: 'Audubon Admin',
    kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
  });
  insert('role_assignments', { id: id('ra'), org_id: orgId, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  ensureCoa(orgId);
});

function mkBatch(over: Partial<BatchRow>): BatchRow {
  const b: BatchRow = {
    id: id('imp'), org_id: orgId, kind: 'rent_roll', filename: 'audubon.xlsx',
    property_id: null, new_property_name: null, preset: null,
    headers: '[]', mapping: '{}', rows: '[]', staged: '[]',
    as_of: AS_OF, status: 'staged', created_by: 'test',
    ...over,
  } as BatchRow;
  insert('import_batches', { ...b, summary: null, created_at: nowIso(), applied_at: null } as unknown as Record<string, unknown>);
  return b;
}

/** The upload path's spreadsheet transform, in the order routes.ts runs it. */
function readRoll(rows: string[][]): { headers: string[]; dataRows: string[][]; mapping: Mapping; property: string; futureRows: string[][] } {
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
  let futureRows: string[][] = [];
  if (scan.sectioned && (scan.futureRows.length || scan.summaryRows)) {
    dataRows = scan.rows;
    futureRows = scan.futureRows;
    mapping.excluded = { futureApplicants: scan.futureUnits.length, futureUnits: scan.futureUnits, summaryRows: scan.summaryRows, setAside: scan.setAside };
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
  return { headers, dataRows, mapping, property: detectDocumentProperty(rows, headerIdx) || '', futureRows };
}

const col = (mapping: Mapping, f: string): number => Number(Object.entries(mapping.cols).find(([, x]) => x === f)![0]);

// ---------- 1 · the harvest keeps every coded sub-row, whatever its sign ----------

test('negative and zero coded sub-rows fold into their unit block instead of orphaning', () => {
  const { dataRows, mapping } = readRoll(AUDUBON_BLOCK_ROLL);
  // no orphan fragments: every surviving row carries a unit number
  const unitCol = col(mapping, 'unit');
  const orphans = dataRows.filter((r) => !String(r[unitCol] ?? '').trim());
  assert.deepEqual(orphans, [], 'no charge fragment may survive as a unit-less row');

  // 302: rent = 716 + 1319 − 119 + 119 = 2,035 — the transfer pair nets into the block
  const rentCol = col(mapping, 'rent');
  const subCol = col(mapping, 'subsidy');
  const u302 = dataRows.find((r) => r[unitCol] === '302')!;
  assert.equal(moneyToCents(u302[rentCol]!), 203500, 'the block nets its signed charge rows');
  assert.equal(moneyToCents(u302[subCol]!), 120000, 'subsidy nets the −119 transfer: 1319 − 119');

  // 307: the $0 tenant-portion row attaches — fully-voucher household
  const u307 = dataRows.find((r) => r[unitCol] === '307')!;
  assert.equal(moneyToCents(u307[rentCol]!), 154300);
  assert.equal(moneyToCents(u307[subCol]!), 154300, 'every cent voucher-paid');
});

test('an employee concession demotes to a negative other-monthly charge, never negative rent', () => {
  const { dataRows, mapping } = readRoll(AUDUBON_BLOCK_ROLL);
  const unitCol = col(mapping, 'unit');
  const rentCol = col(mapping, 'rent');
  const extraCol = col(mapping, 'extra_monthly');
  const u305 = dataRows.find((r) => r[unitCol] === '305')!;
  assert.equal(moneyToCents(u305[rentCol]!), 0, 'rent floors at zero');
  assert.equal(moneyToCents(u305[extraCol]!), -332200, 'the concession is preserved as a negative recurring charge');
});

// ---------- 2 · validation imports every real tenancy ----------

test('the 606-unit shapes validate with zero errors — a real tenancy is never discarded', () => {
  const ctx = sysCtx(orgId, AS_OF);
  const { headers, dataRows, mapping, property } = readRoll(AUDUBON_BLOCK_ROLL);
  const batch = mkBatch({ new_property_name: property, as_of: AS_OF, headers: js(headers), mapping: js(mapping), rows: js(dataRows) });
  const v = validateRentRoll(ctx, batch);
  assert.equal(v.error, 0, `every row is a real tenancy: ${v.rows.filter((r) => r.level === 'error').map((r) => `${r.rec.unit}: ${r.notes.join('|')}`).join(' · ')}`);

  const notesFor = (unit: string): string => v.rows.find((r) => r.rec.unit === unit)?.notes.join(' | ') || '';
  // zero-charge occupied: imports at $0 with the evidence named
  assert.match(notesFor('304'), /\$0(\.00)? scheduled rent|no scheduled rent/i);
  // occupied parking: same rule
  assert.match(notesFor('A-01'), /\$0(\.00)? scheduled rent|no scheduled rent/i);
  // inverted term: month-to-month holdover, not a discard
  assert.match(notesFor('306'), /month-to-month|holdover/i);

  // the recon strip counts what will actually import
  assert.equal(v.recon!.units, 13);
  assert.equal(v.recon!.occupied, 11);
  assert.equal(v.recon!.rentCents, 1313400, 'rent = rnsvchr + rntnt, signed');
  assert.equal(v.recon!.subsidyCents, 934500);
  assert.equal(v.recon!.extraMonthlyCents, 840 - 332200, 'other charges carry the negative concession and both trash lines');
  assert.equal(v.recon!.depositCents, 84600);
  assert.equal(v.recon!.balanceCents, 2996562);
  const ties = v.recon!.tieOuts!;
  assert.deepEqual(ties.filter((t) => !t.ok), [], `every line ties to the report: ${js(ties.filter((t) => !t.ok))}`);
});

test('sq ft 0 in the source imports as 0 — never an invented 750', () => {
  const ctx = sysCtx(orgId, AS_OF);
  const { headers, dataRows, mapping } = readRoll(AUDUBON_BLOCK_ROLL);
  const batch = mkBatch({ new_property_name: 'Audubon Sqft Test', as_of: AS_OF, headers: js(headers), mapping: js(mapping), rows: js(dataRows) });
  const s = applyRentRoll(ctx, batch);
  assert.equal(s.units, 13);
  const pid = q1<{ id: string }>('SELECT id FROM properties WHERE org_id=? AND name=?', orgId, 'Audubon Sqft Test')!.id;
  const sq = q<{ sqft: number; c: number }>('SELECT sqft, COUNT(*) c FROM units WHERE property_id=? GROUP BY sqft', pid);
  assert.deepEqual(sq.map((r) => [r.sqft, r.c]), [[0, 13]], 'a source that states no area yields no area');
});

test('applying bills the concession and the zero-rent households exactly as the source schedules them', () => {
  const ctx = sysCtx(orgId, AS_OF);
  const { headers, dataRows, mapping, futureRows } = readRoll(AUDUBON_BLOCK_ROLL);
  const batch = mkBatch({ new_property_name: 'Audubon Apply Test', as_of: AS_OF, headers: js(headers), mapping: js(mapping), rows: js(dataRows), staged: js(futureRows) });
  const s = applyRentRoll(ctx, batch);
  assert.equal(s.units, 13);
  assert.equal(s.leases, 11, 'every occupied row leases — zero-rent households included');
  const pid = q1<{ id: string }>('SELECT id FROM properties WHERE org_id=? AND name=?', orgId, 'Audubon Apply Test')!.id;
  const sum = (kind: string): number => q1<{ t: number }>(
    `SELECT COALESCE(SUM(lc.amount_cents),0) t FROM lease_charges lc JOIN leases l ON l.id=lc.lease_id WHERE l.property_id=? AND lc.kind=?`, pid, kind)!.t;
  assert.equal(sum('rent'), 1313400 - 934500, 'residents are billed their own share: contract rent less the vouchers');
  assert.equal(sum('other'), 840 - 332200, 'the concession survives as a scheduled monthly credit');
  const bal = q1<{ t: number }>(
    `SELECT COALESCE(SUM(c.amount_cents),0) t FROM charges c JOIN leases l ON l.id=c.lease_id
     WHERE l.property_id=? AND c.kind='opening_balance'`, pid)!;
  // signed: owed net of credit balances — the report's own Totals line
  assert.equal(bal.t, 2996562, 'opening balances carry the credits too');

  // nothing invented, nothing billed backward
  const mkt = q1<{ s: number }>(`SELECT SUM(market_rent_cents) s FROM units WHERE property_id=?`, pid)!;
  assert.equal(mkt.s, 2001876, 'market rent totals exactly what the source states — a $0 market stays $0');
  const fut = q1<{ billing_start_date: string; rent_cents: number; status: string }>(
    `SELECT l.billing_start_date, l.rent_cents, l.status FROM leases l JOIN units u ON u.id=l.unit_id
     WHERE l.property_id=? AND u.unit_number='A-03'`, pid)!;
  assert.equal(fut.status, 'fully_executed');
  assert.equal(fut.billing_start_date, '2026-09-01', 'a future row whose move-in already passed never bills backward');
  assert.equal(fut.rent_cents, 0, 'an explicit $0 future row stays $0 — no rent is invented from the unit');
  const backCharges = q1<{ c: number }>(
    `SELECT COUNT(*) c FROM charges ch JOIN leases l ON l.id=ch.lease_id
     WHERE l.property_id=? AND ch.kind='rent' AND ch.due_date < ?`, pid, AS_OF)!;
  assert.equal(backCharges.c, 0, 'no rent charge may be dated before the switch');
});
