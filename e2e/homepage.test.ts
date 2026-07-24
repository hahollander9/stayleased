import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import { q1 } from '../src/lib/db.ts';
import type { Browser } from 'playwright';

/** Marketing front door gate: logged-out visitors get the Entrata-modeled
 * homepage (nav dropdowns, six-layer ontology stack, L1–L5 ladder, agents,
 * governance, walkthrough capture); signed-in users still land on their
 * dashboard/portal; chart hover tooltips show values. */

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

test('gate: logged-out root serves the marketing homepage with every section', async () => {
  const page = await newPage(browser);
  const resp = await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  assert.equal(resp!.status(), 200);
  const body = await page.content();
  assert.match(body, /Autonomous property management/);
  assert.match(body, /agentic operating system/i);
  assert.match(body, /Two platforms\. One operating system\./);
  assert.match(body, /Built for the way property management actually works/);
  assert.match(body, /Automation that fits the way you operate/);
  assert.match(body, /Functional agents embedded in every corner/);
  assert.match(body, /Autonomy that operates inside your rules/);
  assert.match(body, /Built for operators like you/);
  assert.match(body, /Simple, honest pricing/);
  assert.match(body, /Self-managing owners/);
  assert.match(body, /Equal Housing Opportunity/);
  // all six ontology layers and five automation levels
  for (const layer of ['Workflow autonomy', 'Where agents act', 'System of action', 'System of context', 'System of record', 'Foundation']) {
    assert.match(body, new RegExp(layer), `layer "${layer}" present`);
  }
  for (const lvl of ['L1', 'L2', 'L3', 'L4', 'L5', 'Adaptive self-improvement', 'Generative assistance']) {
    assert.match(body, new RegExp(lvl), `level "${lvl}" present`);
  }
  await page.close();
});

test('gate: homepage interactions — nav dropdown and ontology accordion', async () => {
  const page = await newPage(browser);
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });

  // nav dropdown opens on click and is exclusive
  await page.click('.mk-item-btn:has-text("Platform")');
  assert.ok(await page.locator('.mk-item.open .mk-drop').isVisible(), 'Platform dropdown opens');
  await page.click('.mk-item-btn:has-text("AI")');
  assert.equal(await page.locator('.mk-item.open').count(), 1, 'only one dropdown open at a time');

  // ontology stack behaves as an accordion: opening one closes the default-open one
  const first = page.locator('details.mk-layer').first();
  assert.equal(await first.getAttribute('open'), '', 'top layer starts open');
  await page.click('details.mk-layer:nth-of-type(3) summary');
  // the exclusive-close runs on the async 'toggle' event — wait for the state
  await page.waitForFunction(() => {
    const ds = document.querySelectorAll('details.mk-layer');
    return ds.length >= 3 && !ds[0]!.hasAttribute('open') && ds[2]!.hasAttribute('open');
  }, undefined, { timeout: 5000 });
  await page.close();
});

test('gate: footer reveals on scroll and back-to-top appears', async () => {
  const page = await newPage(browser);
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  // back-to-top hidden at the top
  assert.equal(await page.locator('#mktop.show').count(), 0, 'back-to-top hidden at top');
  // scroll to the very bottom
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' as ScrollBehavior }));
  // footer link columns must be visible (regression: they were stuck at opacity:0)
  const footLink = page.locator('.mk-foot-grid a').first();
  await footLink.waitFor({ state: 'visible', timeout: 5000 });
  const op = await footLink.evaluate((el) => {
    let n: Element | null = el; while (n) { if (getComputedStyle(n).opacity === '0') return '0'; n = n.parentElement; }
    return 'visible';
  });
  assert.equal(op, 'visible', 'footer links are not stuck invisible');
  // back-to-top now shown
  await page.locator('#mktop.show').waitFor({ state: 'visible', timeout: 3000 });
  assert.ok(await page.locator('#mktop.show').count() >= 1, 'back-to-top shows after scrolling');
  await page.close();
});

test('gate: walkthrough form captures a platform lead and thanks the visitor', async () => {
  const page = await newPage(browser);
  await page.goto(`${base}/#walkthrough`, { waitUntil: 'networkidle' });
  await page.fill('.mk-form-card input[name=name]', 'Pat Prospect');
  await page.fill('.mk-form-card input[name=email]', 'pat@prospect.test');
  await page.fill('.mk-form-card input[name=company]', 'Prospect Properties');
  await page.fill('.mk-form-card input[name=note]', 'Moving off AppFolio, 120 units');
  await Promise.all([page.waitForLoadState('networkidle'), page.click('.mk-form-card button[type=submit]')]);
  assert.match(await page.content(), /Got it — thank you/);
  const lead = q1<any>('SELECT * FROM platform_leads WHERE email=?', 'pat@prospect.test');
  assert.ok(lead, 'lead stored');
  assert.equal(lead!.company, 'Prospect Properties');

  // platform admin sees it on the orgs page
  await login(page, base, 'platform@stayleased.demo');
  await page.goto(`${base}/admin/orgs`, { waitUntil: 'networkidle' });
  assert.match(await page.content(), /Pat Prospect/);
  await page.close();
});

test('gate: signed-in users still land on their app, not marketing', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  const body = await page.content();
  assert.match(body, /Portfolio/);
  assert.ok(!body.includes('mk-hero'), 'no marketing chrome for signed-in staff');
  // demo world is labeled in the app chrome
  assert.match(body, /demo-pill/);

  // residents bounce to their portal
  const rp = await newPage(browser);
  await login(rp, base, 'maya.torres@mail.demo');
  await rp.goto(`${base}/`, { waitUntil: 'networkidle' });
  assert.match(rp.url(), /\/portal/);
  await rp.close();
  await page.close();
});

test('gate: demo persona chips are hidden until "Explore the demo" is clicked', async () => {
  const page = await newPage(browser);
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  // a back-to-home link returns to the marketing page
  const back = page.locator('a.auth-back');
  assert.equal(await back.getAttribute('href'), '/', 'back link points home');
  await back.click();
  await page.waitForLoadState('networkidle');
  assert.match(await page.content(), /Autonomous property management/, 'back link lands on the homepage');
  await page.goBack({ waitUntil: 'networkidle' });
  // the summary is present, but the chips are collapsed (not visible) by default
  const summary = page.locator('.demo-personas summary.dp-head');
  await summary.waitFor({ state: 'visible' });
  assert.match((await summary.textContent()) || '', /Explore the demo/);
  const firstChip = page.locator('.demo-personas .chip').first();
  assert.equal(await firstChip.isVisible(), false, 'chips hidden before expanding');
  // clicking the summary reveals them
  await summary.click();
  await firstChip.waitFor({ state: 'visible', timeout: 3000 });
  assert.ok(await firstChip.isVisible(), 'chips visible after clicking Explore the demo');
  await page.close();
});

test('gate: Ask StayLeased types out an answer grounded in real data', async () => {
  const page = await newPage(browser);
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  // scroll the Ask panel into view — it auto-demos "What's my occupancy?"
  await page.locator('#mk-askbox').scrollIntoViewIfNeeded();
  // a YOU bubble and a typed AGENT answer with a real number appear
  await page.waitForFunction(() => {
    const a = Array.from(document.querySelectorAll('#mk-ask-msgs .mk-msg.agent'));
    return a.some((el) => /occupanc/i.test(el.textContent || '') && /%/.test(el.textContent || ''));
  }, undefined, { timeout: 15000 });
  assert.ok(await page.locator('#mk-ask-msgs .mk-msg.you').count() >= 1, 'user question bubble shown');
  await page.close();
});

test('gate: floating chat widget opens and answers a question', async () => {
  const page = await newPage(browser);
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  // launcher present, panel closed
  assert.equal(await page.locator('#mkchat.open').count(), 0);
  await page.click('#mkchat-launch');
  await page.locator('#mkchat.open').waitFor({ state: 'attached', timeout: 3000 });
  // ask via a quick chip
  await page.click('#mkchat-chips .mk-ask-chip');
  await page.waitForFunction(() => {
    const msgs = Array.from(document.querySelectorAll('#mkchat-msgs .mk-msg.agent'));
    // greeting + a real answer (>=2 agent bubbles) with substantive text
    return msgs.length >= 2 && (msgs[msgs.length - 1]!.textContent || '').trim().length > 20;
  }, undefined, { timeout: 15000 });
  assert.ok(await page.locator('#mkchat-msgs .mk-msg.you').count() >= 1, 'question echoed in widget');
  // close with the X
  await page.click('#mkchat-close');
  assert.equal(await page.locator('#mkchat.open').count(), 0, 'widget closes');
  await page.close();
});

test('gate: chart hover shows a value tooltip', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  const bar = page.locator('svg.chart rect.ct').first();
  await bar.hover();
  const tip = page.locator('#charttip');
  await tip.waitFor({ state: 'visible', timeout: 5000 });
  const text = (await tip.textContent()) || '';
  assert.ok(text.trim().length > 2, `tooltip has content, saw "${text}"`);
  assert.match(text, /·/, 'tooltip carries a label · value pair');
  await page.close();
});
