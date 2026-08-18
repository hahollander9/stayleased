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

test('gate: theme follows the system setting; an explicit choice overrides it, and System gives it back', async () => {
  // system dark, no choice → dark
  const dark = await newPage(browser, { colorScheme: 'dark' });
  await login(dark, base, 'admin@summitridge.demo');
  assert.equal(await dark.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark', 'system dark respected');
  await dark.close();

  // system light, no choice → light
  const light = await newPage(browser, { colorScheme: 'light' });
  await login(light, base, 'admin@summitridge.demo');
  assert.equal(await light.evaluate(() => document.documentElement.getAttribute('data-theme')), 'light', 'system light respected');

  // Appearance lives in the account menu now — three named choices, not a bare
  // glyph beside the setup gear (2026-08-18).
  assert.equal(await light.locator('[data-theme-toggle]').count(), 0, 'no lone theme glyph in the app chrome');
  await light.click('button.avatar');
  await light.waitForTimeout(120);
  assert.match((await light.textContent('#usermenu-pop')) || '', /Appearance/);

  // an explicit choice wins over the system setting, and survives a reload
  await light.click('[data-theme-set="dark"]');
  assert.equal(await light.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark', 'the choice applies immediately');
  await light.reload({ waitUntil: 'networkidle' });
  assert.equal(await light.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark', 'and survives a reload against system light');

  // the menu shows which choice is live
  await light.click('button.avatar');
  await light.waitForTimeout(120);
  assert.equal(await light.locator('[data-theme-set="dark"]').getAttribute('aria-pressed'), 'true', 'the live choice is marked');

  // System is a real choice, not the absence of one: picking it clears the
  // override and hands the page back to the operating system.
  await light.click('[data-theme-set="system"]');
  assert.equal(await light.evaluate(() => document.documentElement.getAttribute('data-theme')), 'light', 'back to the system setting immediately');
  await light.reload({ waitUntil: 'networkidle' });
  assert.equal(await light.evaluate(() => document.documentElement.getAttribute('data-theme')), 'light', 'and it stays there');
  await light.close();
});
