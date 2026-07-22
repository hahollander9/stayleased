import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import type { Browser } from 'playwright';

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

const PERSONAS: [string, string][] = [
  // [email, expected content marker after login]
  ['admin@summitridge.demo', 'StayLeased'],
  ['regional@summitridge.demo', 'StayLeased'],
  ['manager@summitridge.demo', 'StayLeased'],
  ['agent@summitridge.demo', 'StayLeased'],
  ['maintsup@summitridge.demo', 'StayLeased'],
  ['tech@summitridge.demo', 'StayLeased'],
  ['accountant@summitridge.demo', 'StayLeased'],
  ['marketing@summitridge.demo', 'StayLeased'],
];

test('every staff persona can log in and sees the app shell', async () => {
  for (const [email] of PERSONAS) {
    const page = await newPage(browser);
    await login(page, base, email);
    assert.equal(page.url().includes('/login'), false, `${email} should be past login`);
    const brand = await page.locator('.brand, .auth-brand').first().textContent();
    assert.match(brand || '', /StayLeased/);
    await page.close();
  }
});

test('admin console pages render with data', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/admin/staff`);
  assert.match((await page.locator('table').textContent()) || '', /Priya Raman/);
  await page.goto(`${base}/admin/jobs`);
  assert.match((await page.textContent('h1')) || '', /Scheduled jobs/);
  await page.goto(`${base}/dev/sim`);
  assert.match((await page.textContent('h1')) || '', /Simulator/);
  await page.goto(`${base}/admin/audit`);
  assert.match((await page.textContent('h1')) || '', /Audit/);
  await page.close();
});

test('permission matrix and developers reference render', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/admin/roles`);
  assert.match((await page.textContent('table')) || '', /gl:close_period/);
  await page.goto(`${base}/developers`);
  assert.match((await page.textContent('body')) || '', /X-Api-Key/);
  await page.close();
});

test('phase 1: portfolio roll-up, property dashboard, unit board filters', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  // roll-up renders all three properties with occupancy math
  const rollup = (await page.textContent('.content')) || '';
  assert.match(rollup, /Summit Ridge Apartments/);
  assert.match(rollup, /Foundry Lofts/);
  assert.match(rollup, /Cardinal Commons/);
  assert.match(rollup, /Occupancy/);
  // switch into a property → property dashboard
  await page.selectOption('.prop-switch select', { label: 'Summit Ridge Apartments' });
  await page.locator('h1', { hasText: 'Summit Ridge' }).waitFor({ timeout: 15000 });
  assert.match((await page.textContent('.kpis')) || '', /Occupancy/);
  // unit board filters
  await page.goto(`${base}/units?view=list&beds=2`);
  const table = (await page.textContent('.content')) || '';
  assert.match(table, /2bd/);
  assert.doesNotMatch(table, /Studio ·/);
  await page.selectOption('select[name=status]', 'vacant_ready');
  await page.waitForLoadState('networkidle');
  assert.match(page.url(), /status=vacant_ready/);
  // reset property context for later tests
  await page.goto(`${base}/`);
  await page.selectOption('.prop-switch select', 'all');
  await page.locator('h1', { hasText: 'Portfolio' }).waitFor({ timeout: 15000 });
  await page.close();
});

test('global search returns staff', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  const res = await page.evaluate(async () => {
    const r = await fetch('/search.json?q=Priya');
    return r.json();
  });
  assert.equal((res as { results: { label: string }[] }).results.some((h) => h.label.includes('Priya')), true);
  await page.close();
});
