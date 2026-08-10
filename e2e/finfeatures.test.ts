import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import type { Browser } from 'playwright';

/** Phase 19 e2e (accountant feedback): replacement reserves, owner statements,
 * saved statement packets, and vendor price agreements — the four surfaces
 * built from the Dantes Partners senior-accountant conversation. Pins the
 * seeded demo state so future deploys can't silently lose them. */

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

test('reserves: overview, seeded pending draw, and approval flow', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/reserves`);
  const body = await page.textContent('body');
  assert.match(body!, /Replacement reserves/);
  assert.match(body!, /Reserves by property/);
  assert.match(body!, /Water heater replacements/, 'seeded pending draw visible');
  assert.match(body!, /Total reserves/);
  // approve the seeded pending draw (isolated DB clone — safe to mutate)
  await Promise.all([
    page.waitForLoadState('networkidle'),
    page.click('form[action*="/reserves/draws/"] button:has-text("Approve")'),
  ]);
  const after1 = await page.textContent('body');
  assert.match(after1!, /Draw approved — transfer posted to operating/);
  await page.close();
});

test('owners: seeded owners and a consolidated equity-income statement', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/owners`);
  const body = await page.textContent('body');
  assert.match(body!, /Bluestone Holdings LLC/);
  assert.match(body!, /Rosa Alvarez/);
  await page.click('text=Bluestone Holdings LLC');
  await page.waitForLoadState('networkidle');
  const detail = await page.textContent('body');
  assert.match(detail!, /Equity income by property/);
  assert.match(detail!, /Summit Ridge Apartments/);
  assert.match(detail!, /The Foundry Lofts/);
  assert.match(detail!, /Equity income \(T12\)/);
  assert.ok(await page.$('a[href*="/statement.csv"]'), 'CSV export link');
  assert.ok(await page.$('a[href*="/statement.pdf"]'), 'PDF export link');
  await page.close();
});

test('statement packets: saved pull opens as one page with all three statements', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/statements`);
  const body = await page.textContent('body');
  assert.match(body!, /Saved statement packets/);
  assert.match(body!, /Monthly board packet — consolidated/);
  await page.click('text=Monthly board packet — consolidated');
  await page.waitForLoadState('networkidle');
  const packet = await page.textContent('body');
  assert.match(packet!, /Income — trailing 12 months/);
  assert.match(packet!, /Total assets/);
  assert.match(packet!, /Cash flow — operating/);
  assert.ok(await page.$('a[href*="/export.csv"]'), 'packet CSV link');
  assert.ok(await page.$('a[href*="/export.pdf"]'), 'packet PDF link');
  await page.close();
});

test('vendor price agreements: listed, and the seeded PO priced at the agreed rate', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/purchasing/agreements`);
  const body = await page.textContent('body');
  assert.match(body!, /Agreements in effect/);
  assert.match(body!, /ClearFlow HVAC/);
  assert.match(body!, /\$49\.00/, 'agreed price shown');
  assert.match(body!, /\$54\.00/, 'catalog price shown for contrast');
  await page.goto(`${base}/purchasing?status=all`);
  const pos = await page.textContent('body');
  assert.match(pos!, /\$392\.00/, 'winter filter pre-buy priced 8 × $49.00 from the agreement');
  await page.close();
});

test('report library: reserve activity and owner equity income registered', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/reports`);
  const body = await page.textContent('body');
  assert.match(body!, /Replacement Reserve Activity/);
  assert.match(body!, /Owner Equity Income/);
  await page.close();
});
