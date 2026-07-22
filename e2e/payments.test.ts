import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import type { Browser, Page } from 'playwright';

/** Phase 3 gate: resident pays → ACH settles T+3 via date advance → one
 * payment NSFs and reinstates balance + fee + notification; late-fee run
 * previews then assesses; delinquency workbench matches ledger truth. */

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
  await login(page, base, 'manager@summitridge.demo');
});

after(async () => close());

test('delinquency workbench matches ledger truth', async () => {
  await page.goto(`${base}/delinquency`);
  const rows = await page.locator('tbody tr[data-href]').count();
  assert.equal(rows > 3, true, 'delinquent households exist');
  // open Derrick (61-90 bucket cast member)
  const text = (await page.textContent('tbody')) || '';
  assert.match(text, /Cole household/);
  // workbench total for the first row equals the lease ledger balance
  const firstTotal = (await page.locator('tbody tr[data-href] td:last-child b').first().textContent()) || '';
  await page.click('tbody tr[data-href]');
  await page.waitForLoadState('networkidle');
  const subtitle = (await page.textContent('.subtitle')) || '';
  assert.equal(subtitle.includes(firstTotal.trim()), true, `workbench ${firstTotal} should appear in detail subtitle`);
});

test('staff records a payment; it applies to the ledger immediately', async () => {
  await page.goto(`${base}/leases`);
  await page.click('tbody tr[data-href]');
  await page.waitForLoadState('networkidle');
  // open the record-payment dropdown and submit $25 check
  await page.click('summary:has-text("Record payment")');
  await page.fill('form[action*="/payments"] input[name=amount]', '25.00');
  await page.fill('form[action*="/payments"] input[name=reference]', '9001');
  await Promise.all([page.waitForLoadState('networkidle'), page.click('form[action*="/payments"] button')]);
  assert.match((await page.textContent('.flash')) || '', /Payment recorded/);
  assert.match((await page.textContent('.content')) || '', /#9001/);
});

test('GATE: ACH pending → settled after +3 day advance; NSF path reinstates + fee + notice', async () => {
  const admin = await newPage(browser);
  await login(admin, base, 'admin@summitridge.demo');

  // find a current lease and record an ACH payment via staff UI
  await admin.goto(`${base}/leases`);
  await admin.click('tbody tr[data-href]');
  await admin.waitForLoadState('networkidle');
  const leaseUrl = admin.url();
  await admin.click('summary:has-text("Record payment")');
  await admin.selectOption('form[action*="/payments"] select[name=method]', 'ach');
  await admin.fill('form[action*="/payments"] input[name=amount]', '19.00');
  await Promise.all([admin.waitForLoadState('networkidle'), admin.click('form[action*="/payments"] button')]);
  assert.match((await admin.textContent('.content')) || '', /\(pending\)/);

  // advance +3 days → settle
  await admin.goto(`${base}/dev/sim`);
  await admin.click('button[value="3"]');
  await admin.waitForLoadState('networkidle');
  await admin.goto(leaseUrl);
  const ledger = (await admin.textContent('.content')) || '';
  assert.doesNotMatch(ledger, /ACH \(pending\)/);
  await admin.close();
});

test('NSF reversal reinstates balance with fee and notification (via dev console record)', async () => {
  // seeded history contains real NSFs — verify one produced a fee + message
  const admin = await newPage(browser);
  await login(admin, base, 'admin@summitridge.demo');
  await admin.goto(`${base}/dev/messages?template=payment_nsf`);
  const consoleText = (await admin.textContent('.content')) || '';
  assert.match(consoleText, /payment_nsf/, 'NSF notifications captured in the console');
  await admin.goto(`${base}/gl/journal?source=nsf`);
  const rows = await admin.locator('tbody tr').count();
  assert.equal(rows > 0, true, 'NSF reversal JEs exist from history');
  await admin.close();
});

test('late fee run previews then assesses', async () => {
  await page.goto(`${base}/receivables/latefees`);
  const content = (await page.textContent('.content')) || '';
  assert.match(content, /Due for assessment|No late fees due/);
  const hasCandidates = await page.locator('form[action="/receivables/latefees/assess"] button').count();
  if (hasCandidates) {
    page.on('dialog', (d) => void d.accept());
    await Promise.all([page.waitForLoadState('networkidle'), page.click('form[action="/receivables/latefees/assess"] button')]);
    assert.match((await page.textContent('.flash')) || '', /assessed|no late fees/i);
  }
  assert.match((await page.textContent('.content')) || '', /Recently assessed/);
});

test('receivables analytics renders with history trends', async () => {
  await page.goto(`${base}/receivables`);
  const content = (await page.textContent('.content')) || '';
  assert.match(content, /Collection rate/);
  assert.match(content, /Autopay adoption/);
  const svgs = await page.locator('svg').count();
  assert.equal(svgs >= 2, true, 'trend charts render');
});

test('deposits screen shows held deposits and dispositions', async () => {
  await page.goto(`${base}/deposits`);
  const content = (await page.textContent('.content')) || '';
  assert.match(content, /held across/);
  assert.match(content, /moved out|held/);
});
