import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import type { Browser } from 'playwright';

/** Portfolio map gate: the map page renders a panel entry and a placed pin
 * for every property (tile imagery is not required), and selecting a
 * property from the map opens that property's dashboard. */

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

test('gate: /map renders panel, data, and pins for the whole portfolio', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/map`, { waitUntil: 'networkidle' });

  // side panel lists all three demo properties
  assert.equal(await page.locator('.mp-item').count(), 3, 'three panel entries');
  const body = await page.content();
  assert.match(body, /Summit Ridge Apartments/);
  assert.match(body, /The Foundry Lofts/);
  assert.match(body, /Cardinal Commons/);

  // embedded data places every property (seeded coordinates or centroid fallback)
  const data = await page.evaluate(() => JSON.parse(document.getElementById('slmap-data')!.textContent || '[]'));
  assert.equal(data.length, 3);
  for (const p of data) {
    assert.equal(typeof p.lat, 'number', `${p.name} has a latitude`);
    assert.equal(typeof p.lng, 'number', `${p.name} has a longitude`);
  }
  // seeded demo properties carry precise coordinates
  const summit = data.find((p: any) => p.name === 'Summit Ridge Apartments');
  assert.ok(summit.precise, 'seeded property uses its own coordinates');

  // Leaflet placed pins (works without tile imagery; the marker wrapper is a
  // zero-size anchor, so assert attachment + child content rather than box size)
  await page.locator('.slpin').first().waitFor({ state: 'attached', timeout: 10000 });
  assert.ok((await page.locator('.slpin').count()) >= 3, 'pins rendered');
  assert.ok(await page.locator('.slpin-tag').first().textContent(), 'pin occupancy tag rendered');
  await page.close();
});

test('gate: opening a property from the map lands on its dashboard', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/map`, { waitUntil: 'networkidle' });
  const data = await page.evaluate(() => JSON.parse(document.getElementById('slmap-data')!.textContent || '[]'));
  const target = data.find((p: any) => p.name === 'The Foundry Lofts');
  await page.goto(`${base}/map/open/${target.id}`, { waitUntil: 'networkidle' });
  assert.match(page.url(), /\/$/, 'redirected to the dashboard');
  await page.locator('h1', { hasText: 'The Foundry Lofts' }).waitFor({ timeout: 10000 });
  // reset context for later suites
  await page.selectOption('.prop-switch select', 'all');
  await page.waitForLoadState('networkidle');
  await page.close();
});
