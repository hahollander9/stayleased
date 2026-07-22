import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import type { Browser } from 'playwright';

/** Phase 2 / M2.5 gate: the top module bar renders, the Setup hub loads, the
 * property wizard creates a property with units, and the Migration Center
 * previews then imports units from CSV. */

let base: string;
let browser: Browser;
let close: () => Promise<void>;

before(async () => {
  const b = await boot();
  base = b.base;
  browser = b.browser;
  close = b.close;
});
after(async () => close());

test('top module bar renders the module tabs', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  const bar = await page.locator('.modulebar').first().textContent();
  for (const tab of ['Dashboard', 'Leasing', 'Residents', 'Financials', 'Property', 'Operations', 'Marketing', 'Messages', 'Reports']) {
    assert.match(bar || '', new RegExp(tab), `module bar should contain ${tab}`);
  }
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

test('gate: Migration Center previews then imports units from CSV', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/setup/import?entity=units`, { waitUntil: 'networkidle' });
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
