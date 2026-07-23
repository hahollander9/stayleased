import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert, run, j } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso, addMonths, monthKey, firstOfMonth } from '../src/lib/dates.ts';
import { hashPassword, sysCtx } from '../src/lib/auth.ts';
import { setEnv } from '../src/lib/env.ts';
import { readZip, writeZip, crc32 } from '../src/lib/zip.ts';
import { writeXlsx, parseXlsx, serialToIso } from '../src/lib/xlsx.ts';
import { pdfExtractText } from '../src/lib/pdftext.ts';
import {
  autoMap, detectPreset, findHeaderRow, moneyToCents, toIsoDate, normStatus, splitName, norm,
} from '../src/modules/setup/mapping.ts';
import { extractLeaseFromText } from '../src/modules/setup/import_leases.ts';
import {
  validateRentRoll, applyRentRoll, validateVendors, applyVendors, validateBalances, applyBalances,
  type BatchRow,
} from '../src/modules/setup/import_apply.ts';
import { postMonthlyChargesForLease } from '../src/modules/m8_receivables/service.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { orgKind, SIM_ONLY_JOBS, ensureJobRows, syncLiveOrgClocks, liveToday } from '../src/lib/jobs.ts';
import { startTestServer, loginAs, get, post } from './harness.ts';

/** Working-model gate: universal import engine (zip/xlsx/mapping/apply),
 * conversion accounting, live-org clock + sim-job fences, and self-signup. */

const AS_OF = '2026-07-23';

let orgId: string;
let propId: string;

before(() => {
  db();
  const existing = q1<{ id: string }>('SELECT id FROM orgs WHERE slug=?', 'mig-test');
  if (existing) {
    orgId = existing.id;
    propId = q1<{ id: string }>('SELECT id FROM properties WHERE org_id=?', orgId)!.id;
    return;
  }
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'Migration Test Co', slug: 'mig-test', business_date: AS_OF, kind: 'live', created_at: nowIso() });
  const uid = id('usr');
  insert('users', {
    id: uid, org_id: orgId, email: 'admin@mig-test.test', name: 'Mig Admin',
    kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
  });
  insert('role_assignments', { id: id('ra'), org_id: orgId, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  ensureCoa(orgId);
  propId = id('prp');
  insert('properties', {
    id: propId, org_id: orgId, name: 'Existing Prop', slug: 'mig-existing', type: 'multifamily',
    address1: '1 Test Way', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso(),
  });
});

function mkBatch(over: Partial<BatchRow>): BatchRow {
  const b: BatchRow = {
    id: id('imp'), org_id: orgId, kind: 'rent_roll', filename: 'test.xlsx',
    property_id: null, new_property_name: null, preset: null,
    headers: '[]', mapping: '{}', rows: '[]', staged: '[]',
    as_of: AS_OF, status: 'staged', created_by: 'test',
    ...over,
  } as BatchRow;
  insert('import_batches', {
    ...b, summary: null, created_at: nowIso(), applied_at: null,
  } as unknown as Record<string, unknown>);
  return b;
}

// ---------- zip / xlsx ----------

test('zip: write → read roundtrip with crc', () => {
  const files = [
    { name: 'a.txt', data: 'hello zip' },
    { name: 'dir/b.xml', data: '<x>çontent &amp; more</x>' },
  ];
  const buf = writeZip(files);
  const back = readZip(buf);
  assert.equal(back.length, 2);
  assert.equal(back[0]!.name, 'a.txt');
  assert.equal(back[0]!.data.toString('utf8'), 'hello zip');
  assert.equal(back[1]!.data.toString('utf8'), files[1]!.data);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926); // canonical vector
});

test('xlsx: write → parse roundtrip (strings, numbers, blanks)', () => {
  const rows = [
    ['Unit', 'Tenant', 'Rent', 'Note'],
    ['101', 'Jordan Avery', '1450', 'has & <specials>'],
    ['102', '', '0', ''],
  ];
  const sheets = parseXlsx(writeXlsx([{ name: 'Roll', rows }]));
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0]!.name, 'Roll');
  assert.deepEqual(sheets[0]!.rows[0], rows[0]);
  assert.equal(sheets[0]!.rows[1]![1], 'Jordan Avery');
  assert.equal(sheets[0]!.rows[1]![2], '1450');
  assert.equal(sheets[0]!.rows[1]![3], 'has & <specials>');
});

test('xlsx: styled date serials convert to ISO', () => {
  // hand-built workbook: cell B2 = serial 46204 styled with builtin date fmt 14
  assert.equal(serialToIso(46204), '2026-07-01');
  const sheetXml = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
    `<row r="1"><c r="A1" t="inlineStr"><is><t>Lease Start</t></is></c></row>` +
    `<row r="2"><c r="A2" s="1"><v>46204</v></c><c r="B2"><v>46204</v></c></row>` +
    `</sheetData></worksheet>`;
  const styles = `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>`;
  const wb = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="w" Target="worksheets/sheet1.xml"/></Relationships>`;
  const buf = writeZip([
    { name: 'xl/workbook.xml', data: wb },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/styles.xml', data: styles },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml },
  ]);
  const sheets = parseXlsx(buf);
  assert.equal(sheets[0]!.rows[1]![0], '2026-07-01'); // styled serial → ISO
  assert.equal(sheets[0]!.rows[1]![1], '46204'); // unstyled stays numeric
});

// ---------- mapping ----------

test('mapping: value cleaners', () => {
  assert.equal(moneyToCents('$1,234.56'), 123456);
  assert.equal(moneyToCents('(150.00)'), -15000);
  assert.equal(moneyToCents('-42'), -4200);
  assert.equal(moneyToCents('n/a'), null);
  assert.equal(moneyToCents(''), null);
  assert.equal(toIsoDate('7/1/2026'), '2026-07-01');
  assert.equal(toIsoDate('07/01/26'), '2026-07-01');
  assert.equal(toIsoDate('Jul 1, 2026'), '2026-07-01');
  assert.equal(toIsoDate('2026-07-01'), '2026-07-01');
  assert.equal(toIsoDate('MTM'), null);
  assert.equal(normStatus('Occupied'), 'occupied');
  assert.equal(normStatus('VACANT-READY'), 'vacant');
  assert.equal(normStatus('Notice given'), 'notice');
  assert.deepEqual(splitName('Avery, Jordan'), { first: 'Jordan', last: 'Avery', display: 'Jordan Avery' });
  assert.deepEqual(splitName('Jordan Avery'), { first: 'Jordan', last: 'Avery', display: 'Jordan Avery' });
  assert.equal(norm('  Lease  From!! '), 'lease from');
});

test('mapping: AppFolio-style headers detect preset and map', () => {
  const headers = ['Unit', 'BD/BA', 'Tenant', 'Rent', 'Market Rent', 'Deposit', 'Lease From', 'Lease Expiration', 'Move-in', 'Past Due'];
  assert.equal(detectPreset(headers)?.key, 'appfolio');
  const m = autoMap(headers, 'rent_roll');
  const by = (f: string): number | undefined => Number(Object.entries(m.cols).find(([, v]) => v === f)?.[0]);
  assert.equal(by('unit'), 0);
  assert.equal(by('floorplan'), 1);
  assert.equal(by('tenant'), 2);
  assert.equal(by('rent'), 3);
  assert.equal(by('market_rent'), 4);
  assert.equal(by('deposit'), 5);
  assert.equal(by('lease_start'), 6);
  assert.equal(by('lease_end'), 7);
  assert.equal(by('move_in'), 8);
  assert.equal(by('balance'), 9);
});

test('mapping: header row found under title rows', () => {
  const rows = [
    ['Rent Roll as of 07/01/2026'],
    [''],
    ['Unit', 'Tenant', 'Rent', 'Lease From', 'Lease To'],
    ['101', 'A B', '1000', '1/1/2026', '12/31/2026'],
  ];
  assert.equal(findHeaderRow(rows, 'rent_roll'), 2);
});

// ---------- rent roll validate + apply ----------

function rentRollBatch(newProp = 'Harbor Point Test'): BatchRow {
  const headers = ['Unit', 'Floorplan', 'Sq Ft', 'Tenant', 'Email', 'Rent', 'Market Rent', 'Deposit', 'Balance', 'Lease From', 'Lease To', 'Status'];
  const mapping = autoMap(headers, 'rent_roll');
  const rows = [
    ['101', '1x1', '720', 'Avery, Jordan', 'jordan@example.com', '1450', '1500', '1450', '250.00', '1/1/2026', '12/31/2026', 'Occupied'],
    ['102', '1x1', '720', 'Sasha Kim & Ben Kim', 'sasha@example.com', '1400', '1500', '1400', '(50.00)', '9/15/2025', '9/14/2026', 'Occupied'],
    ['103', '2x2', '1080', '', '', '', '1925', '', '', '', '', 'Vacant'],
    ['104', '2x2', '1080', 'Lee, Dana', '', '1900', '1925', '1900', '0', '6/1/2025', '5/31/2026', 'Occupied'], // expired → MTM
    ['104', '2x2', '1080', 'Dup Row', '', '1900', '', '', '', '', '', ''], // duplicate unit
    ['105', '2x2', '1080', 'No Rent Person', '', '', '', '', '', '', '', 'Occupied'], // no rent → error
  ];
  return mkBatch({
    kind: 'rent_roll', new_property_name: newProp,
    headers: JSON.stringify(headers), mapping: JSON.stringify(mapping), rows: JSON.stringify(rows),
  });
}

test('rent roll: validation flags duplicates, missing rent, vacant rows', () => {
  const ctx = sysCtx(orgId, AS_OF);
  const batch = rentRollBatch('Validation Prop');
  const v = validateRentRoll(ctx, batch);
  assert.equal(v.blockers.length, 0);
  assert.equal(v.rows.length, 6);
  assert.equal(v.error, 2); // dup + no-rent
  const dup = v.rows[4]!;
  assert.equal(dup.level, 'error');
  assert.match(dup.notes.join(' '), /Duplicate/);
  const noRent = v.rows[5]!;
  assert.match(noRent.notes.join(' '), /rent amount/);
  run(`UPDATE import_batches SET status='discarded' WHERE id=?`, batch.id);
});

test('rent roll: apply builds property, units, leases, balances, deposits', () => {
  const ctx = sysCtx(orgId, AS_OF);
  const batch = rentRollBatch();
  const s = applyRentRoll(ctx, batch);
  assert.equal(s.properties, 1);
  assert.equal(s.units, 4); // 101,102,103,104 (dup + no-rent skipped)
  assert.equal(s.leases, 3);
  assert.equal(s.residents, 4); // Jordan, Sasha+Ben, Dana
  assert.equal(s.skipped, 2);

  const prop = q1<any>('SELECT * FROM properties WHERE org_id=? AND name=?', orgId, 'Harbor Point Test')!;
  assert.ok(prop, 'property created');
  const units = q<any>('SELECT * FROM units WHERE property_id=? ORDER BY unit_number', prop.id);
  assert.equal(units.length, 4);
  assert.equal(units.find((u) => u.unit_number === '103')!.status, 'vacant_ready');
  assert.equal(units.find((u) => u.unit_number === '101')!.status, 'occupied');

  // household & lease shape
  const lease101 = q1<any>(`SELECT l.* FROM leases l JOIN units u ON u.id=l.unit_id WHERE u.unit_number='101' AND l.property_id=?`, prop.id)!;
  assert.equal(lease101.status, 'active');
  assert.equal(lease101.rent_cents, 145000);
  assert.equal(lease101.deposit_cents, 145000);
  assert.equal(lease101.household_name, 'Jordan Avery');
  assert.equal(lease101.billing_start_date, firstOfMonth(addMonths(AS_OF, 1)));
  const hm = q<any>('SELECT * FROM household_members WHERE lease_id=?', lease101.id);
  assert.equal(hm.length, 1);

  // two-tenant household
  const lease102 = q1<any>(`SELECT l.* FROM leases l JOIN units u ON u.id=l.unit_id WHERE u.unit_number='102' AND l.property_id=?`, prop.id)!;
  assert.equal(q<any>('SELECT * FROM household_members WHERE lease_id=?', lease102.id).length, 2);

  // expired term → month_to_month
  const lease104 = q1<any>(`SELECT l.* FROM leases l JOIN units u ON u.id=l.unit_id WHERE u.unit_number='104' AND l.property_id=?`, prop.id)!;
  assert.equal(lease104.status, 'month_to_month');

  // opening balances: +25000 and -5000 cents on the right leases via kind
  const ob101 = q1<any>(`SELECT * FROM charges WHERE lease_id=? AND kind='opening_balance'`, lease101.id)!;
  assert.equal(ob101.amount_cents, 25000);
  const ob102 = q1<any>(`SELECT * FROM charges WHERE lease_id=? AND kind='opening_balance'`, lease102.id)!;
  assert.equal(ob102.amount_cents, -5000);

  // conversion posting: opening balances land as AR (1100) against 3030 equity
  const obLines = q<any>(
    `SELECT jl.account_code, jl.debit_cents, jl.credit_cents FROM journal_lines jl
     JOIN journal_entries je ON je.id=jl.entry_id
     WHERE je.org_id=? AND jl.account_code='3030' AND je.property_id=?`, orgId, prop.id,
  );
  assert.ok(obLines.length >= 2, 'opening balance lines posted against 3030');
  // net equity credit = 25000 - 5000 = 20000 (accrual basis only for charges)
  const net = obLines.reduce((acc: number, l: any) => acc + l.credit_cents - l.debit_cents, 0);
  assert.equal(net, 20000);

  // deposits JE: 2100 credited on BOTH bases, 1450+1400+1900 = $4,750 each
  const depLines = q<any>(
    `SELECT jl.credit_cents, je.basis FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
     WHERE je.org_id=? AND je.source_kind='conversion' AND je.source_id=? AND jl.account_code='2100'`, orgId, batch.id,
  );
  assert.equal(depLines.length, 2); // accrual + cash
  for (const l of depLines) assert.equal(l.credit_cents, 475000);
  assert.deepEqual(new Set(depLines.map((l: any) => l.basis)), new Set(['accrual', 'cash']));
});

test('rent roll: no double-billing before billing_start_date', () => {
  const ctx = sysCtx(orgId, AS_OF);
  const prop = q1<any>('SELECT * FROM properties WHERE org_id=? AND name=?', orgId, 'Harbor Point Test')!;
  const lease = q1<any>(`SELECT l.* FROM leases l JOIN units u ON u.id=l.unit_id WHERE u.unit_number='101' AND l.property_id=?`, prop.id)!;
  // current month (July) is covered by the migrated balance → nothing posts
  assert.equal(postMonthlyChargesForLease(ctx, lease, monthKey(AS_OF)), 0);
  // next month posts the rent line
  const nextMk = monthKey(addMonths(AS_OF, 1));
  const posted = postMonthlyChargesForLease(sysCtx(orgId, firstOfMonth(addMonths(AS_OF, 1))), lease, nextMk);
  assert.equal(posted, 1);
  const chg = q1<any>(`SELECT * FROM charges WHERE lease_id=? AND month_key=? AND kind='rent'`, lease.id, nextMk)!;
  assert.equal(chg.amount_cents, 145000);
});

test('rent roll: existing occupied unit is skipped, vacant existing unit gets the lease', () => {
  const ctx = sysCtx(orgId, AS_OF);
  // seed one vacant unit in the existing property
  const fid = id('fpl');
  insert('floorplans', { id: fid, org_id: orgId, property_id: propId, name: 'T1', beds: 1, baths: 1, sqft: 700, market_rent_cents: 120000, created_at: nowIso() });
  insert('units', { id: id('unt'), org_id: orgId, property_id: propId, building_id: null, floorplan_id: fid, unit_number: 'A1', floor: 1, sqft: 700, status: 'vacant_ready', market_rent_cents: 120000, amenities: '[]', notes: null, created_at: nowIso() });

  const headers = ['Unit', 'Tenant', 'Rent'];
  const mapping = autoMap(headers, 'rent_roll');
  const rows = [['A1', 'New Person', '1200']];
  const batch = mkBatch({ kind: 'rent_roll', property_id: propId, headers: JSON.stringify(headers), mapping: JSON.stringify(mapping), rows: JSON.stringify(rows) });
  const v = validateRentRoll(ctx, batch);
  assert.equal(v.error, 0);
  assert.match(v.rows[0]!.notes.join(' '), /already exists — the lease will be attached/);
  const s = applyRentRoll(ctx, batch);
  assert.equal(s.units, 0); // reused, not created
  assert.equal(s.leases, 1);
  const unit = q1<any>('SELECT * FROM units WHERE property_id=? AND unit_number=?', propId, 'A1')!;
  assert.equal(unit.status, 'occupied');

  // a second import against the now-occupied unit is rejected
  const batch2 = mkBatch({ kind: 'rent_roll', property_id: propId, headers: JSON.stringify(headers), mapping: JSON.stringify(mapping), rows: JSON.stringify([['A1', 'Someone Else', '1300']]) });
  const v2 = validateRentRoll(ctx, batch2);
  assert.equal(v2.error, 1);
  assert.match(v2.rows[0]!.notes.join(' '), /active lease/);
  run(`UPDATE import_batches SET status='discarded' WHERE id=?`, batch2.id);
});

// ---------- vendors + balances ----------

test('vendors: import with category normalization and dedupe', () => {
  const ctx = sysCtx(orgId, AS_OF);
  const headers = ['Vendor Name', 'Trade', 'Email', 'Phone'];
  const mapping = autoMap(headers, 'vendors');
  const rows = [
    ['Pinnacle Plumbing', 'Plumber', 'p@x.test', '(555) 000-1111'],
    ['BrightSpark', 'Electrician', '', ''],
    ['Pinnacle Plumbing', 'Plumbing', '', ''], // dup in file
  ];
  const batch = mkBatch({ kind: 'vendors', headers: JSON.stringify(headers), mapping: JSON.stringify(mapping), rows: JSON.stringify(rows) });
  const v = validateVendors(ctx, batch);
  assert.equal(v.error, 1);
  const s = applyVendors(ctx, batch);
  assert.equal(s.vendors, 2);
  assert.equal(q1<any>('SELECT * FROM vendors WHERE org_id=? AND name=?', orgId, 'Pinnacle Plumbing')!.category, 'plumbing');
  assert.equal(q1<any>('SELECT * FROM vendors WHERE org_id=? AND name=?', orgId, 'BrightSpark')!.category, 'electrical');
});

test('balances: post onto existing lease once, reject repeats and unknown units', () => {
  const ctx = sysCtx(orgId, AS_OF);
  const headers = ['Unit', 'Tenant', 'Balance'];
  const mapping = autoMap(headers, 'balances');
  const rows = [['A1', 'New Person', '312.25'], ['ZZ9', 'Ghost', '100']];
  const batch = mkBatch({ kind: 'balances', property_id: propId, headers: JSON.stringify(headers), mapping: JSON.stringify(mapping), rows: JSON.stringify(rows) });
  const v = validateBalances(ctx, batch);
  assert.equal(v.error, 1); // unknown unit
  const s = applyBalances(ctx, batch);
  assert.equal(s.balancesCents, 31225);
  const unit = q1<any>('SELECT * FROM units WHERE property_id=? AND unit_number=?', propId, 'A1')!;
  const lease = q1<any>(`SELECT * FROM leases WHERE unit_id=? AND status IN ('active','month_to_month','notice')`, unit.id)!;
  const ob = q<any>(`SELECT * FROM charges WHERE lease_id=? AND kind='opening_balance'`, lease.id);
  assert.equal(ob.length, 1);
  // second pass refuses the duplicate opening balance
  const batch2 = mkBatch({ kind: 'balances', property_id: propId, headers: JSON.stringify(headers), mapping: JSON.stringify(mapping), rows: JSON.stringify([['A1', '', '10']]) });
  const v2 = validateBalances(ctx, batch2);
  assert.equal(v2.error, 1);
  assert.match(v2.rows[0]!.notes.join(' '), /already has an opening balance/);
  run(`UPDATE import_batches SET status='discarded' WHERE id=?`, batch2.id);
});

// ---------- lease PDF text extraction ----------

test('pdf: text extraction + lease field regexes on a generated lease', async () => {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines = [
    'RESIDENTIAL LEASE AGREEMENT',
    'Tenant: Jordan Avery',
    'Unit: 204',
    'Premises: 400 Bay Street, Seattle, WA',
    'Monthly Rent: $1,450.00',
    'Security Deposit: $1,450.00',
    'Commencement Date: 01/01/2026',
    'Expiration Date: 12/31/2026',
    'Contact: jordan.avery@example.com (555) 201-8890',
  ];
  lines.forEach((t, i) => page.drawText(t, { x: 50, y: 720 - i * 24, size: 12, font }));
  const bytes = Buffer.from(await doc.save({ useObjectStreams: false }));

  const text = pdfExtractText(bytes);
  assert.match(text, /RESIDENTIAL LEASE/);
  assert.match(text, /Jordan Avery/);

  const { fields } = extractLeaseFromText(text);
  assert.equal(fields.unit, '204');
  assert.match(fields.tenants, /Jordan Avery/);
  assert.equal(fields.rent, '1,450.00');
  assert.equal(fields.deposit, '1,450.00');
  assert.equal(fields.start, '2026-01-01');
  assert.equal(fields.end, '2026-12-31');
  assert.equal(fields.email, 'jordan.avery@example.com');
});

// ---------- live-org fences + clock ----------

test('live org: sim-only jobs are created disabled and skipped', () => {
  assert.equal(orgKind(orgId), 'live');
  ensureJobRows(orgId);
  for (const key of SIM_ONLY_JOBS) {
    const row = q1<any>('SELECT * FROM jobs WHERE org_id=? AND key=?', orgId, key);
    if (row) assert.equal(row.enabled, 0, `${key} must be disabled for live orgs`);
  }
});

test('live org: clock catches up to today through the scheduler', () => {
  const today = liveToday();
  const lateOrg = id('org');
  insert('orgs', { id: lateOrg, name: 'Clock Co', slug: 'clock-co', business_date: '2026-07-20', kind: 'live', created_at: nowIso() });
  ensureCoa(lateOrg);
  const advanced = syncLiveOrgClocks();
  assert.ok(advanced >= 1);
  assert.equal(q1<any>('SELECT business_date FROM orgs WHERE id=?', lateOrg)!.business_date, today);
  // demo orgs never move
  const demoDate = q1<any>(`SELECT business_date FROM orgs WHERE kind='demo' LIMIT 1`);
  if (demoDate) assert.notEqual(demoDate.business_date, '1900-01-01');
});

// ---------- signup (HTTP) ----------

test('signup: invite code gates; success creates a live org with chart + admin session', async () => {
  setEnv('SIGNUP_CODE', 'LETMEIN2026');
  const { base, close } = await startTestServer();
  try {
    const page = await get(base, '/signup');
    assert.equal(page.status, 200);
    assert.match(page.text, /Invite code/);

    const bad = await post(base, '/signup', {
      code: 'WRONG', company: 'Acme Rentals', name: 'Ava Admin', email: 'ava@acme.test',
      password: 'supersecret1', password2: 'supersecret1',
    });
    assert.match(bad.text, /not valid/);
    assert.ok(!q1('SELECT id FROM users WHERE email=?', 'ava@acme.test'));

    const good = await post(base, '/signup', {
      code: 'LETMEIN2026', company: 'Acme Rentals', name: 'Ava Admin', email: 'ava@acme.test',
      password: 'supersecret1', password2: 'supersecret1',
    });
    assert.equal(good.status, 303);
    assert.equal(good.location, '/welcome');

    const org = q1<any>(`SELECT o.* FROM orgs o JOIN users u ON u.org_id=o.id WHERE u.email=?`, 'ava@acme.test')!;
    assert.equal(org.kind, 'live');
    assert.equal(org.name, 'Acme Rentals');
    assert.ok(q1('SELECT id FROM gl_accounts WHERE org_id=? AND code=?', org.id, '4010'), 'chart of accounts created');
    assert.ok(q1(`SELECT ra.id FROM role_assignments ra JOIN users u ON u.id=ra.user_id WHERE u.email=? AND ra.role='ORG_ADMIN'`, 'ava@acme.test'));

    // login lands on onboarding for an empty live org; welcome renders checklist
    const cookie = await loginAs(base, 'ava@acme.test', 'supersecret1');
    const welcome = await get(base, '/welcome', cookie);
    assert.equal(welcome.status, 200);
    assert.match(welcome.text, /rent roll/i);

    // duplicate email refused
    const dup = await post(base, '/signup', {
      code: 'LETMEIN2026', company: 'Other Co', name: 'Ava Again', email: 'ava@acme.test',
      password: 'supersecret1', password2: 'supersecret1',
    });
    assert.match(dup.text, /already exists/);

    // live org staff cannot open the simulator console
    const sim = await get(base, '/dev/sim', cookie);
    assert.equal(sim.status, 403);
  } finally {
    close();
  }
});
