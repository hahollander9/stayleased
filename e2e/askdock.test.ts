import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import type { Browser } from 'playwright';

/** Ask-everywhere gate: the brandbar button opens the Ask panel on any app
 * page, the panel is tailored to the user's current property and app area,
 * and unnamed questions answer scoped to that property. Plus the theme
 * contract: system setting decides by default, the cookie override wins. */

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

test('gate: Ask panel opens everywhere, greets with live property figures, answers scoped', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');

  // work inside Summit Ridge, on a financials page (the switcher autosubmits;
  // wait for that navigation to land so the property cookie is actually set)
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.selectOption('.prop-switch select', { label: 'Summit Ridge Apartments' }),
  ]);
  await page.goto(`${base}/delinquency`, { waitUntil: 'networkidle' });

  await page.click('[data-ask-open]');
  await page.waitForSelector('.askdock.open .aichat-chip', { timeout: 10000 });
  assert.match(page.url(), /\/delinquency/, 'no navigation — panel opened in place');
  assert.match((await page.textContent('.askdock-scope')) || '', /Summit Ridge/, 'scope pill names the property');
  const greeting = (await page.textContent('.askdock .aichat-msg.agent')) || '';
  assert.match(greeting, /Summit Ridge Apartments/, 'greeting names the property');
  assert.match(greeting, /% occupied/, 'greeting carries live figures');

  // financials-area chips, and an unnamed question answers for the property
  await page.click('.askdock .aichat-chip:has-text("collection rate last month")');
  await page.waitForFunction(() => !document.querySelector('.askdock.busy'), undefined, { timeout: 30000 });
  const answer = (await page.evaluate(() => {
    const a = document.querySelectorAll('.askdock .aichat-msg.agent');
    return (a[a.length - 1]!.textContent || '').trim();
  }));
  assert.match(answer, /at Summit Ridge Apartments/, 'answer scoped to the property without naming it');

  // escape hatch: "portfolio" widens the same question org-wide
  await page.fill('.askdock .aichat-form input', 'occupancy across the portfolio');
  await page.click('.askdock .aichat-send');
  await page.waitForFunction(() => !document.querySelector('.askdock.busy'), undefined, { timeout: 30000 });
  const wide = (await page.evaluate(() => {
    const a = document.querySelectorAll('.askdock .aichat-msg.agent');
    return (a[a.length - 1]!.textContent || '').trim();
  }));
  assert.match(wide, /portfolio/i, 'portfolio phrasing answers org-wide');

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.askdock.open'), undefined, { timeout: 5000 });

  // reset context for later suites
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.selectOption('.prop-switch select', 'all'),
  ]);
  await page.close();
});

test('gate: theme follows the system setting; the toggle cookie overrides it', async () => {
  // system dark, no cookie → dark
  const dark = await browser.newPage({ colorScheme: 'dark' });
  await login(dark, base, 'admin@summitridge.demo');
  assert.equal(await dark.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark', 'system dark respected');
  await dark.close();

  // system light, no cookie → light
  const light = await browser.newPage({ colorScheme: 'light' });
  await login(light, base, 'admin@summitridge.demo');
  assert.equal(await light.evaluate(() => document.documentElement.getAttribute('data-theme')), 'light', 'system light respected');

  // explicit toggle wins over the system setting on the next load
  await light.click('[data-theme-toggle]');
  assert.equal(await light.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark', 'toggle flips immediately');
  await light.reload({ waitUntil: 'networkidle' });
  assert.equal(await light.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark', 'cookie override survives reload against system light');
  await light.close();
});
