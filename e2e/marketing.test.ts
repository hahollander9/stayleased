import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import type { Browser } from 'playwright';

/** Phase 7 gate: public site renders live availability/pricing; a prospect
 * self-schedules a tour and submits a lead that appears in M3; CMS edit
 * publishes instantly; sitemap/meta present. */

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

test('public property site renders live availability + pricing + SEO', async () => {
  const page = await newPage(browser);
  await page.goto(`${base}/p/summit-ridge`);
  const content = (await page.textContent('body')) || '';
  assert.match(content, /Mountain views/);
  assert.match(content, /from \$\d/); // starting-at pricing
  assert.match(content, /available/);
  assert.match(content, /Equal Housing Opportunity/);
  // meta + JSON-LD
  const metaDesc = await page.getAttribute('meta[name=description]', 'content');
  assert.ok(metaDesc && metaDesc.length > 20);
  const ld = await page.textContent('script[type="application/ld+json"]');
  assert.match(ld || '', /ApartmentComplex/);
  await page.close();
});

test('GATE: prospect submits an inquiry that lands in the lead inbox', async () => {
  const page = await newPage(browser, { mobile: true });
  await page.goto(`${base}/p/foundry-lofts`);
  await page.fill('#contact input[name=first_name]', 'Paige');
  await page.fill('#contact input[name=last_name]', 'Prospect');
  await page.fill('#contact input[name=email]', 'paige.prospect@web.demo');
  await page.fill('#contact textarea[name=message]', 'Do you have anything with a skyline view for October?');
  await Promise.all([page.waitForLoadState('networkidle'), page.click('#contact button')]);
  assert.match((await page.textContent('body')) || '', /Thanks!/);
  await page.close();

  const staff = await newPage(browser);
  await login(staff, base, 'agent2@summitridge.demo');
  const res = await staff.evaluate(async () => (await fetch('/search.json?q=Paige Prospect')).json());
  const hit = (res as any).results.find((x: any) => x.kind === 'lead');
  assert.ok(hit, 'website lead appears in CRM');
  await staff.goto(base + hit.href);
  const cardText = (await staff.textContent('.content')) || '';
  assert.match(cardText, /website/i);
  assert.match(cardText, /skyline view/);
  await staff.close();
});

test('GATE: prospect self-schedules a tour from the site', async () => {
  const page = await newPage(browser);
  await page.goto(`${base}/p/summit-ridge`);
  await page.fill('#tour input[name=first_name]', 'Toby');
  await page.fill('#tour input[name=last_name]', 'Toursmith');
  await page.fill('#tour input[name=email]', 'toby.toursmith@web.demo');
  await Promise.all([page.waitForLoadState('networkidle'), page.click('#tour button')]);
  assert.match((await page.textContent('body')) || '', /You're booked!/);
  await page.close();

  const staff = await newPage(browser);
  await login(staff, base, 'agent@summitridge.demo');
  await staff.goto(`${base}/tours`);
  assert.match((await staff.textContent('.content')) || '', /Toby Toursmith/);
  await staff.close();
});

test('GATE: CMS edit publishes instantly', async () => {
  const staff = await newPage(browser);
  await login(staff, base, 'marketing@summitridge.demo');
  await staff.goto(`${base}/marketing/sites`);
  await staff.locator('tr', { hasText: 'Summit Ridge Apartments' }).locator('a.btn:has-text("Edit site")').click();
  await staff.waitForLoadState('networkidle');
  const stamp = `Now leasing for fall ${Math.floor(Math.random() * 10000)}`;
  await staff.fill('input[name=heroTitle]', stamp);
  await Promise.all([staff.waitForLoadState('networkidle'), staff.click('button:has-text("Save & publish instantly")')]);
  assert.match((await staff.textContent('.flash')) || '', /live with these changes right now/);
  // the public page shows it immediately
  const pub = await newPage(browser);
  await pub.goto(`${base}/p/summit-ridge`);
  assert.match((await pub.textContent('h1')) || '', new RegExp(stamp.slice(0, 20)));
  await pub.close();
  await staff.close();
});

test('sitemap + robots + corporate search', async () => {
  const page = await newPage(browser);
  const sm = await page.request.get(`${base}/sitemap.xml`);
  assert.equal(sm.status(), 200);
  assert.match(await sm.text(), /\/p\/summit-ridge/);
  const rb = await page.request.get(`${base}/robots.txt`);
  assert.match(await rb.text(), /Sitemap:/);
  await page.goto(`${base}/company?beds=2`);
  const content = (await page.textContent('body')) || '';
  assert.match(content, /Find your next home/);
  assert.match(content, /Summit Ridge Apartments|Foundry Lofts/);
  await page.close();
});

test('syndication manager toggles listings per channel', async () => {
  const staff = await newPage(browser);
  await login(staff, base, 'marketing@summitridge.demo');
  await staff.goto(`${base}/marketing/syndication`);
  const content = (await staff.textContent('.content')) || '';
  assert.match(content, /zillow/);
  assert.match(content, /active listings/);
  const liveButtons = await staff.locator('button:has-text("Live")').count();
  assert.equal(liveButtons > 0, true, 'seeded publications visible');
  // toggle an Off channel on
  const offBtn = staff.locator('button:has-text("Off")').first();
  if ((await offBtn.count()) > 0) {
    await Promise.all([staff.waitForLoadState('networkidle'), offBtn.click()]);
    assert.match((await staff.textContent('.flash')) || '', /listing updated/);
  }
  await staff.close();
});
