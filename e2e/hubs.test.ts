import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import type { Browser } from 'playwright';

/** Module overview hubs gate: every module tab opens with an organized
 * Overview landing — hero, AI strip, link grid with descriptions, and the
 * module's key figures — and Overview leads the tab's sub-nav. */

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

const HUBS = [
  { slug: 'leasing', title: 'Leasing', link: 'Leads' },
  { slug: 'residents', title: 'Residents', link: 'Renewals' },
  { slug: 'financials', title: 'Financials', link: 'Delinquency' },
  { slug: 'property', title: 'Property', link: 'Units' },
  { slug: 'operations', title: 'Operations', link: 'Work orders' },
];

test('gate: every module hub renders hero, AI strip, and link grid', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  for (const h of HUBS) {
    await page.goto(`${base}/hub/${h.slug}`, { waitUntil: 'networkidle' });
    // hero owns the page h1
    const h1 = await page.locator('h1').textContent();
    assert.equal(h1?.trim(), h.title, `${h.slug}: hero title`);
    // Overview leads the sub-nav and is active
    const first = page.locator('.subnav a').first();
    assert.equal((await first.textContent())?.trim(), 'Overview', `${h.slug}: Overview first in sub-nav`);
    assert.match((await first.getAttribute('class')) || '', /active/, `${h.slug}: Overview active`);
    // AI strip present for the admin (ai:view)
    assert.ok(await page.locator('.hub-ai').count(), `${h.slug}: AI strip`);
    // link grid contains a described entry for a known module page
    const link = page.locator('.hub-link', { hasText: h.link }).first();
    assert.ok(await link.count(), `${h.slug}: link grid has ${h.link}`);
    assert.ok(await link.locator('.hl-desc').textContent(), `${h.slug}: ${h.link} carries a description`);
  }
  await page.close();
});

test('gate: hub link grid navigates into the module', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/hub/operations`, { waitUntil: 'networkidle' });
  await page.locator('.hub-link', { hasText: 'Work orders' }).first().click();
  await page.waitForLoadState('networkidle');
  assert.match(page.url(), /\/workorders/, 'landed on work orders');
  await page.close();
});
