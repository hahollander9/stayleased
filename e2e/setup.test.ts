import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { boot, login, newPage } from './lib.ts';
import { ROOT } from '../src/lib/db.ts';
import { writeXlsx } from '../src/lib/xlsx.ts';
import { YARDI_BLOCK_ROLL, YARDI_EXPECTED } from '../tests/fixtures/yardi_block_roll.ts';
import type { Browser } from 'playwright';

/** Phase 2 / M2.5 gate: the top module bar renders, the Setup hub loads, the
 * property wizard creates a property with units, and the Migration Center
 * previews then imports units from CSV. */

let base: string;
let browser: Browser;
let close: () => Promise<void>;
const YARDI_PATH = join(ROOT, 'data', 'e2e-yardi-block-roll.xlsx');

before(async () => {
  const b = await boot();
  base = b.base;
  browser = b.browser;
  close = b.close;
  writeFileSync(YARDI_PATH, writeXlsx([{ name: 'Report1', rows: YARDI_BLOCK_ROLL }]));
});
after(async () => {
  rmSync(YARDI_PATH, { force: true });
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
