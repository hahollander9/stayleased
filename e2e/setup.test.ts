import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { boot, login, newPage } from './lib.ts';
import { ROOT } from '../src/lib/db.ts';
import { writeXlsx } from '../src/lib/xlsx.ts';
import { YARDI_BLOCK_ROLL, YARDI_EXPECTED } from '../tests/fixtures/yardi_block_roll.ts';
import { AUDUBON_BLOCK_ROLL } from '../tests/fixtures/audubon_block_roll.ts';
import type { Browser } from 'playwright';

/** Phase 2 / M2.5 gate: the top module bar renders, the Setup hub loads, the
 * property wizard creates a property with units, and the Migration Center
 * previews then imports units from CSV. */

let base: string;
let browser: Browser;
let close: () => Promise<void>;
const YARDI_PATH = join(ROOT, 'data', 'e2e-yardi-block-roll.xlsx');
const AUDUBON_PATH = join(ROOT, 'data', 'e2e-audubon-block-roll.xlsx');
const AUDUBON_GATE_PATH = join(ROOT, 'data', 'e2e-audubon-gate.xlsx');

before(async () => {
  const b = await boot();
  base = b.base;
  browser = b.browser;
  close = b.close;
  writeFileSync(YARDI_PATH, writeXlsx([{ name: 'Report1', rows: YARDI_BLOCK_ROLL }]));
  writeFileSync(AUDUBON_PATH, writeXlsx([{ name: 'Report1', rows: AUDUBON_BLOCK_ROLL }]));
  // the gate variant: a different property, and a summary the read cannot tie
  // to (14 units claimed, 13 on the roster) — the honest-apply gate must hold
  const gateRows = AUDUBON_BLOCK_ROLL.map((r) => r.slice());
  gateRows[1] = ['Audubon Gate House (1019)', '', '', '', '', '', '', '', '', '', '', '', '', ''];
  const totals = gateRows.findIndex((r) => String(r[0]).startsWith('Totals:'));
  gateRows[totals]![10] = '14';
  writeFileSync(AUDUBON_GATE_PATH, writeXlsx([{ name: 'Report1', rows: gateRows }]));
});
after(async () => {
  rmSync(YARDI_PATH, { force: true });
  rmSync(AUDUBON_PATH, { force: true });
  rmSync(AUDUBON_GATE_PATH, { force: true });
  await close();
});

test('top module bar renders the module tabs', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  const bar = await page.locator('.modulebar').first().textContent();
  // Small-operator chrome: the top-level TABS (the .mtab-btn labels, not the
  // dropdown contents — group headers like "Marketing" may appear inside menus).
  const tabs = (await page.locator('.modulebar .mtab-btn').allTextContents()).map((t) => t.trim());
  for (const tab of ['Dashboard', 'Leasing', 'Residents', 'Financials', 'Property', 'Operations', 'Messages', 'Reports']) {
    assert.ok(tabs.some((t) => t.includes(tab)), `module bar should contain ${tab} (got: ${tabs.join(', ')})`);
  }
  assert.ok(!tabs.some((t) => t.includes('Marketing')), 'Marketing must not be a top-level tab (merged into Leasing)');
  assert.match(bar || '', /Websites \(CMS\)/, 'Leasing dropdown should carry the CMS page');
  const brand = await page.locator('.brand').first().textContent();
  assert.match(brand || '', /StayLeased/);
  await page.close();
});

test('gate: setup hub → property wizard creates a property with units', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/setup`, { waitUntil: 'networkidle' });
  assert.match(await page.content(), /Migration Center/);

  await page.goto(`${base}/setup/wizard`, { waitUntil: 'networkidle' });
  await page.fill('input[name=name]', 'Wizard Test Property');
  await page.fill('input[name=address1]', '500 Test Ave');
  await page.fill('input[name=city]', 'Boulder');
  await page.fill('input[name=state]', 'CO');
  await page.fill('input[name=zip]', '80301');
  await page.fill('input[name=fp_rent]', '1450');
  await page.fill('input[name=unit_count]', '4');
  await page.fill('input[name=unit_start]', '201');
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Create property")')]);
  assert.match(page.url(), /\/properties\/prp/, 'should land on the new property page');
  assert.match(await page.content(), /Wizard Test Property/);
  assert.match(await page.content(), /4 units/);
  await page.close();
});

test('gate: Migration Center previews then imports units from CSV (legacy templates)', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/setup/import/legacy?entity=units`, { waitUntil: 'networkidle' });
  await page.selectOption('select[name=property]', { label: 'Summit Ridge Apartments' });
  const csv = 'unit_number,floorplan,sqft,market_rent,status\n9001,CSV Import Plan,760,1499,vacant_ready\n9002,CSV Import Plan,760,1499,occupied\n';
  await page.fill('textarea[name=csv]', csv);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Preview import")')]);
  const preview = await page.content();
  assert.match(preview, /2 of 2 rows are ready/);
  assert.match(preview, /Ready/);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Import 2 units")')]);
  assert.match(await page.content(), /Imported 2 of 2 units/);
  await page.close();
});


test('gate: a Yardi block-format rent roll uploads, ties out to its own summary, and applies', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/setup/import`, { waitUntil: 'networkidle' });

  // "detect" is the rent-roll default: the property comes off the title banner
  await page.setInputFiles('input[name=file]', YARDI_PATH);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Upload & map columns")')]);
  assert.match(page.url(), /\/setup\/import\/b\/imp/, 'should land on the review page');
  const review = await page.content();

  // the stacked header merged and the columns landed on the right fields
  assert.equal(await page.locator('select[name=map_0]').inputValue(), 'unit');
  assert.equal(await page.locator('select[name=map_4]').inputValue(), 'tenant', 'Name is the household, not the resident t-code');
  assert.equal(await page.locator('select[name=map_7]').inputValue(), 'rent', 'the Amount beside the charge code is the rent');
  assert.equal(await page.locator('select[name=map_8]').inputValue(), 'deposit', 'Resident Deposit, not Other Deposit');

  // the report's own summary block is read back and every line ties
  assert.match(review, /ties to the summary block of the uploaded report/i);
  assert.doesNotMatch(review, /do(es)? not tie to the summary block/i);
  // rent is the CONTRACT rent — both codes together, the report's own Total
  // line — with the voucher share shown beneath it as who pays (DECISIONS #67)
  assert.match(review, /Rent \(rntnt \+ rnsvchr\)/, 'the tie-out names both rent-nature codes');
  assert.match(review, /\$4,022\.00/, 'rent ties to the report\u2019s Total line');
  assert.match(review, /of which subsidy \(rnsvchr\)/, 'the voucher share is broken out, not hidden');
  assert.match(review, /\$2,183\.00/, 'and it ties to the rnsvchr line');
  assert.match(review, new RegExp(`${YARDI_EXPECTED.futureApplicants} future applicants set aside`), 'future applicants are their own line, not errors');
  assert.doesNotMatch(review, /probably wrong/, 'genuinely-$0 deposits and balances raise no mis-mapping alarm');
  // every current unit reviews clean now that a fully-subsidised lease is a
  // normal lease rather than one billing $0 rent
  assert.match(review, /4 ready/);
  assert.doesNotMatch(review, /\d+ skipped/, 'a clean report must review with no skipped rows');

  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Apply")')]);
  assert.match(page.url(), /\/properties\/prp/, 'apply lands on the property it detected');
  const prop = await page.content();
  assert.match(prop, new RegExp(YARDI_EXPECTED.property));
  assert.match(prop, /Imported .*3 leases/i, 'the vacant unit and the future applicants get no lease');
  await page.close();
});

test('gate: the 606-unit shapes — zero-rent tenancies, concessions, parking — review clean and apply whole', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/setup/import`, { waitUntil: 'networkidle' });
  await page.setInputFiles('input[name=file]', AUDUBON_PATH);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Upload & map columns")')]);
  assert.match(page.url(), /\/setup\/import\/b\/imp/, 'should land on the review page');
  const review = await page.content();

  // nothing real is discarded, and the strip ties line for line
  assert.doesNotMatch(review, /Will not import/, 'every tenancy shape reads as importable');
  assert.doesNotMatch(review, /\d+ skipped/, 'no skipped rows on a clean report');
  assert.doesNotMatch(review, /do(es)? not tie to the summary block/i, 'every line ties — including the negative concession in other charges');
  assert.match(review, /-\$?3,313\.60|\$-3,313\.60/, 'other charges carry the concession, signed');
  // the zero-rent households import with their evidence named, not silently
  assert.match(review, /\$0 scheduled rent/, 'zero-rent tenancies warn and import');
  assert.match(review, /month-to-month holdover/, 'the inverted term reads as a holdover');

  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Apply")')]);
  assert.match(page.url(), /\/properties\/prp/, 'apply lands on the property');
  const prop = await page.content();
  assert.match(prop, /Audubon Mills/);
  assert.match(prop, /Imported .*13 units/i, 'all twelve units import — parking and employee units included');
  await page.close();
});

test('gate: an import that cannot tie to its own report applies only with explicit acknowledgement', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/setup/import`, { waitUntil: 'networkidle' });
  await page.setInputFiles('input[name=file]', AUDUBON_GATE_PATH);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Upload & map columns")')]);
  assert.match(page.url(), /\/setup\/import\/b\/imp/);
  const review = await page.content();
  assert.match(review, /do(es)? not tie to the summary block/i, 'the doctored summary must read as off');
  assert.match(review, /Apply anyway/, 'the gap is acknowledged next to the button, not hidden');

  // applying without the acknowledgement is refused server-side
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Apply")')]);
  assert.match(page.url(), /\/setup\/import\/b\/imp/, 'stays on the review page');
  assert.match(await page.content(), /Not applied:/, 'the refusal says why');

  // ticking it is an explicit decision, and then the apply proceeds
  await page.check('input[name=ack]');
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Apply")')]);
  assert.match(page.url(), /\/properties\/prp/, 'acknowledged apply lands on the property');
  await page.close();
});

test('a file dropped anywhere on the import page lands in the dropzone — and never replaces the app', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/setup/import`, { waitUntil: 'networkidle' });
  const before = page.url();
  const result = await page.evaluate(() => {
    const out: { guardActive: boolean; dropPrevented: boolean; fileCount: number; fileName: string; feedback: string; hasFileClass: boolean } =
      { guardActive: false, dropPrevented: false, fileCount: 0, fileName: '', feedback: '', hasFileClass: false };
    // page-level guard: dragging a file over ANYWHERE must be cancelled
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true });
    document.body.dispatchEvent(over);
    out.guardActive = over.defaultPrevented;
    // drop OUTSIDE the zone (on the page body) — the file must be routed in
    const dt = new DataTransfer();
    dt.items.add(new File(['a,b\n1,2'], 'stray.csv', { type: 'text/csv' }));
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
    document.body.dispatchEvent(drop);
    out.dropPrevented = drop.defaultPrevented;
    const zone = document.querySelector('[data-dropzone]');
    const input = zone ? (zone.querySelector('input[type=file]') as HTMLInputElement | null) : null;
    out.fileCount = input && input.files ? input.files.length : 0;
    out.fileName = input && input.files && input.files[0] ? input.files[0].name : '';
    out.feedback = zone ? (zone.querySelector('[data-dz-name]')?.textContent || '') : '';
    out.hasFileClass = !!(zone && zone.classList.contains('has-file'));
    return out;
  });
  assert.equal(result.guardActive, true, 'a page-level dragover guard is active');
  assert.equal(result.dropPrevented, true, 'the drop default (navigate to the file) is cancelled');
  assert.equal(result.fileCount, 1, 'the stray drop landed in the dropzone input');
  assert.equal(result.fileName, 'stray.csv');
  assert.match(result.feedback, /ready to upload/, 'the zone says the file is ready — a drop is visibly acknowledged');
  assert.equal(result.hasFileClass, true);
  await page.waitForTimeout(250);
  assert.equal(page.url(), before, 'the app did not navigate away');
  await page.close();
});
