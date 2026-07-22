import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import type { Browser, Page } from 'playwright';

let base: string;
let browser: Browser;
let close: () => Promise<void>;
let page: Page;

before(async () => {
  const b = await boot();
  base = b.base;
  browser = b.browser;
  close = b.close;
  page = await newPage(browser);
  await login(page, base, 'accountant@summitridge.demo');
});

after(async () => close());

test('trial balance renders and is balanced', async () => {
  await page.goto(`${base}/gl`);
  const foot = (await page.textContent('tfoot')) || '';
  assert.match(foot, /balanced/);
  assert.doesNotMatch(foot, /OUT OF BALANCE/);
  const body = (await page.textContent('tbody')) || '';
  assert.match(body, /Rent Income/);
  assert.match(body, /Accounts Receivable/);
});

test('financial invariants page shows all passing', async () => {
  await page.goto(`${base}/gl/invariants`);
  const text = (await page.textContent('.content')) || '';
  assert.match(text, /all passing/);
  assert.doesNotMatch(text, /✗/);
});

test('a resident ledger renders with a running balance', async () => {
  await page.goto(`${base}/leases`);
  await page.click('tbody tr[data-href]');
  await page.waitForLoadState('networkidle');
  const content = (await page.textContent('.content')) || '';
  assert.match(content, /Resident ledger/);
  assert.match(content, /balance \$/);
  assert.match(content, /Rent — /);
});

test('GATE: advancing the business date posts rent org-wide', async () => {
  // sim console needs dev:console → org admin persona
  const admin = await newPage(browser);
  await login(admin, base, 'admin@summitridge.demo');
  await admin.goto(`${base}/dev/sim`);
  await admin.click('button[value="7"]');
  await admin.waitForLoadState('networkidle');
  assert.match((await admin.textContent('.flash')) || '', /Advanced 7 days/);
  await admin.close();
  // August journal entries now exist
  await page.goto(`${base}/gl/journal?period=2026-08&source=charge`);
  const rows = await page.locator('tbody tr').count();
  assert.equal(rows > 10, true, `expected many August charge JEs, saw ${rows}`);
  // and a lease ledger shows an August rent line
  await page.goto(`${base}/leases`);
  await page.click('tbody tr[data-href]');
  await page.waitForLoadState('networkidle');
  assert.match((await page.textContent('.content')) || '', /Aug 1, 2026/);
});
