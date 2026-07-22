import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import type { Browser } from 'playwright';

/** Phase 5 rebrand gate: no user-visible "Oriel" survives anywhere in the
 * rendered app. Visits a cross-section of staff, public, and portal pages and
 * asserts the served HTML contains no case-insensitive "oriel" token, while
 * confirming the StayLeased brand is present. */

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

// Org admin can reach every one of these, so a single login suffices.
const STAFF_PATHS = ['/', '/residents', '/leases', '/ai', '/ask?q=occupancy', '/setup', '/developers', '/inbox'];

test('no user-visible "Oriel" on staff pages; StayLeased brand present', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  for (const path of STAFF_PATHS) {
    await page.goto(base + path, { waitUntil: 'networkidle' });
    const html = (await page.content()).toLowerCase();
    assert.ok(!html.includes('oriel'), `"oriel" found in rendered ${path}`);
    assert.ok(html.includes('stayleased'), `StayLeased brand missing on ${path}`);
  }
  await page.close();
});

test('no "Oriel" on public marketing + a branded 404', async () => {
  const page = await newPage(browser);
  for (const path of ['/p/summit-ridge', '/company', '/this-page-does-not-exist']) {
    await page.goto(base + path, { waitUntil: 'networkidle' });
    const html = (await page.content()).toLowerCase();
    assert.ok(!html.includes('oriel'), `"oriel" found in rendered ${path}`);
  }
  // the 404 is branded StayLeased
  await page.goto(base + '/this-page-does-not-exist', { waitUntil: 'networkidle' });
  assert.ok((await page.content()).toLowerCase().includes('stayleased'), '404 should be StayLeased-branded');
  await page.close();
});

test('no "Oriel" in the resident portal', async () => {
  const page = await newPage(browser, { mobile: true });
  await login(page, base, 'maya.torres@mail.demo');
  for (const path of ['/portal', '/portal/pay', '/portal/lease']) {
    await page.goto(base + path, { waitUntil: 'networkidle' });
    assert.ok(!(await page.content()).toLowerCase().includes('oriel'), `"oriel" found in ${path}`);
  }
  await page.close();
});
