import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, newPage } from './lib.ts';
import { MK_PAGES, MK_GROUPS } from '../src/modules/m4_marketing/features.ts';
import type { Browser } from 'playwright';

/** Marketing pages + chrome gate: every dedicated page behind the nav
 * dropdowns renders with the shared chrome; the dropdowns are hover-safe
 * (gap crossing + grace period + exclusivity + Escape); the mobile menu
 * navigates; robots/sitemap expose the marketing site. */

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

const ALL_MARKETING_URLS = [
  ...Object.values(MK_GROUPS).map((g) => g.base),
  ...MK_PAGES.map((p) => `${MK_GROUPS[p.group].base}/${p.slug}`),
  '/legal/privacy',
  '/legal/terms',
];

test('gate: every dedicated marketing page renders 200 with the shared chrome', async () => {
  for (const url of ALL_MARKETING_URLS) {
    const res = await fetch(`${base}${url}`);
    assert.equal(res.status, 200, `${url} → 200`);
    const body = await res.text();
    assert.match(body, /mk-nav/, `${url} has marketing nav`);
    assert.match(body, /mk-foot/, `${url} has marketing footer`);
    assert.match(body, /mk-burger/, `${url} has the mobile menu button`);
    assert.match(body, /<h1[\s>]/, `${url} has an h1`);
    assert.match(body, /Equal Housing Opportunity/, `${url} footer base`);
  }
});

test('gate: unknown feature slugs 404 instead of erroring', async () => {
  for (const url of ['/platform/not-a-page', '/agents/nope', '/for/nobody']) {
    const res = await fetch(`${base}${url}`);
    assert.equal(res.status, 404, `${url} → 404`);
  }
});

test('gate: staggered content actually becomes visible (no opacity-0 stuck cards)', async () => {
  // regression: reveal children were left at opacity 0 when their group had
  // no .mk-reveal ancestor — content rendered in source but never appeared
  const page = await newPage(browser);
  for (const url of ['/platform', '/for/self-managing-owners']) {
    await page.goto(`${base}${url}`, { waitUntil: 'networkidle' });
    const card = page.locator('.mk-grid3 > *, .mk-grid2 > *, .mkp-stats > *').first();
    await card.scrollIntoViewIfNeeded();
    await page.waitForFunction(
      () => {
        const el = document.querySelector('.mk-grid3 > *, .mk-grid2 > *, .mkp-stats > *');
        return el && parseFloat(getComputedStyle(el).opacity) > 0.9;
      },
      undefined,
      { timeout: 5000 },
    ).catch(() => { throw new Error(`${url}: staggered card stuck invisible`); });
  }
  await page.close();
});

test('gate: retired /resident URLs redirect to the portal page', async () => {
  for (const url of ['/resident', '/resident/portal', '/resident/autopay', '/resident/anything']) {
    const res = await fetch(`${base}${url}`); // follows redirects
    assert.equal(res.status, 200, `${url} lands 200`);
    assert.match(res.url, /\/platform\/resident-portal$/, `${url} → /platform/resident-portal`);
  }
});

test('gate: every internal link on the homepage resolves', async () => {
  const res = await fetch(`${base}/`);
  const body = await res.text();
  const hrefs = new Set<string>();
  for (const m of body.matchAll(/href="(\/[^"#]*)"/g)) {
    const u = m[1]!;
    if (u.startsWith('/assets') || u.includes('?')) continue;
    hrefs.add(u);
  }
  assert.ok(hrefs.size >= 30, `found ${hrefs.size} internal links (nav + footer)`);
  for (const u of hrefs) {
    const r = await fetch(`${base}${u}`); // follows redirects (e.g. auth gates)
    assert.ok(r.status < 400, `${u} → ${r.status}`);
  }
});

test('gate: dropdown survives the hover gap and closes with a grace period', async () => {
  const page = await newPage(browser);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });

  const item = page.locator('.mk-item', { has: page.locator('.mk-item-btn', { hasText: 'Platform' }) });
  const btn = item.locator('.mk-item-btn');
  const bb = (await btn.boundingBox())!;

  // hover the button → menu opens, aria-expanded reflects it
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await item.locator('.mk-drop').waitFor({ state: 'visible', timeout: 2000 });
  assert.equal(await btn.getAttribute('aria-expanded'), 'true', 'aria-expanded true when open');

  // cross the 8px gap under the button — the old pure-CSS hover lost the
  // menu here; the bridge + grace period must keep it open
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height + 4);
  await page.waitForTimeout(120);
  assert.ok(await item.locator('.mk-drop').isVisible(), 'menu survives the gap');

  // travel into the panel and dwell — still open
  const db = (await item.locator('.mk-drop').boundingBox())!;
  await page.mouse.move(db.x + 40, db.y + 40);
  await page.waitForTimeout(350);
  assert.ok(await item.locator('.mk-drop').isVisible(), 'menu stays open inside the panel');

  // hovering another group closes this one and opens that one (exclusive)
  await page.locator('.mk-item-btn', { hasText: 'AI' }).hover();
  await page.waitForFunction(() => {
    const open = document.querySelectorAll('.mk-item.open');
    return open.length === 1 && !!open[0]!.querySelector('.mk-item-btn')!.textContent!.includes('AI');
  }, undefined, { timeout: 2000 });

  // leaving the nav entirely closes everything after the grace period
  await page.mouse.move(640, 500);
  await page.waitForFunction(() => document.querySelectorAll('.mk-item.open').length === 0, undefined, { timeout: 2000 });
  assert.equal(await btn.getAttribute('aria-expanded'), 'false', 'aria-expanded false when closed');
  await page.close();
});

test('gate: hover-open + click confirms; second click closes; Escape closes', async () => {
  const page = await newPage(browser);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  const item = page.locator('.mk-item', { has: page.locator('.mk-item-btn', { hasText: 'Platform' }) });
  const btn = item.locator('.mk-item-btn');

  // click moves the pointer first (hover-opens), so the click confirms —
  // the menu must NOT toggle closed
  await btn.click();
  await page.waitForTimeout(150);
  assert.ok(await item.locator('.mk-drop').isVisible(), 'first click confirms the hover-open');

  // second click toggles closed even though the pointer still hovers
  await btn.click();
  await page.waitForFunction(() => document.querySelectorAll('.mk-item.open').length === 0, undefined, { timeout: 2000 });

  // third click re-opens (pointer never left → no hover flag → plain toggle)
  await btn.click();
  await page.waitForTimeout(100);
  assert.ok(await item.locator('.mk-drop').isVisible(), 'click re-opens');

  // Escape closes
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelectorAll('.mk-item.open').length === 0, undefined, { timeout: 2000 });
  await page.close();
});

test('gate: mobile menu opens, expands a group, and navigates to a feature page', async () => {
  const page = await newPage(browser);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });

  // desktop menu hidden, burger shown
  assert.ok(!(await page.locator('.mk-menu').isVisible()), 'desktop menu hidden on phone width');
  await page.locator('#mk-burger').click();
  await page.locator('#mk-mobile.open').waitFor({ state: 'visible', timeout: 2000 });

  await page.locator('.mk-mm-group summary', { hasText: 'Platform' }).click();
  const link = page.locator('.mk-mm-links a', { hasText: 'Rent collection' });
  await link.waitFor({ state: 'visible', timeout: 2000 });
  await Promise.all([page.waitForLoadState('networkidle'), link.click()]);
  assert.match(page.url(), /\/platform\/rent-collection$/);
  assert.match(await page.locator('h1').textContent() || '', /Rent collection/i);
  await page.close();
});

test('gate: feature page renders chip, stats, features, FAQ, related, and CTA', async () => {
  const page = await newPage(browser);
  await page.goto(`${base}/platform/rent-collection`, { waitUntil: 'networkidle' });
  const body = await page.content();
  assert.match(body, /mkp-chip/, 'status chip present (honest rail state)');
  assert.match(body, /What you get/, 'features section');
  assert.match(body, /Common questions from operators/, 'FAQ section');
  assert.match(body, /Works together with/, 'related section');
  // FAQ interaction: second entry opens
  const second = page.locator('.mkp-faq details').nth(1);
  await second.locator('summary').click();
  assert.equal(await second.getAttribute('open'), '', 'FAQ entry toggles open');
  await page.close();
});

test('gate: robots.txt allows the marketing site; sitemap lists the pages', async () => {
  const robots = await (await fetch(`${base}/robots.txt`)).text();
  assert.match(robots, /Allow: \/\$/, 'homepage allowed');
  assert.match(robots, /Allow: \/platform\//, 'platform pages allowed');
  assert.match(robots, /Allow: \/agents\//, 'agent pages allowed');
  assert.match(robots, /Disallow: \//, 'app remains disallowed');

  const sitemap = await (await fetch(`${base}/sitemap.xml`)).text();
  assert.match(sitemap, /\/platform\/rent-collection</, 'sitemap has feature pages');
  assert.match(sitemap, /\/for\/switching-from-spreadsheets</, 'sitemap has audience pages');
  assert.match(sitemap, /\/legal\/privacy</, 'sitemap has legal pages');
});
