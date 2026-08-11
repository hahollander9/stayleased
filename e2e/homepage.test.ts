import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import { q1 } from '../src/lib/db.ts';
import type { Browser } from 'playwright';

/** Marketing front door gate: logged-out visitors get the small-operator
 * homepage (nav dropdowns, first-week walkthrough, never-used-AI example,
 * three autonomy modes, agents, control, walkthrough capture) with the
 * retired enterprise framing verifiably absent; signed-in users still land
 * on their dashboard/portal; chart hover tooltips show values. */

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
  assert.match(body, /Property management software that does the work/i);
  assert.match(body, /Operational in an afternoon\./);
  // the differentiation build (2026-08-05): segment evidence band, records
  // band (the retired "Everything in one place" recast as mechanism), the
  // agents-as-staff h2, and the verification band
  assert.match(body, /Built for the middle of the market\./);
  assert.match(body, /of rental inquiries arrive outside office hours/);
  assert.match(body, /Terner Center/);
  assert.match(body, /Agents that work on the records, not beside them\./);
  assert.match(body, /AI agents for the work a small building can’t staff\./);
  assert.match(body, /Verification, not claims\./);
  assert.match(body, /Live demo, open to anyone/);
  assert.ok(!/Everything in one place\./.test(body), 'retired category-wallpaper headline stays gone');
  assert.match(body, /Nothing reaches a resident without sign-off\./);
  // v4 control-first order (2026-08-10): the approval band is the first band
  // after the hero — a skeptical buyer meets the leash before the claims.
  assert.ok(
    body.indexOf('Nothing reaches a resident without sign-off') < body.indexOf('Built for the middle of the market'),
    'approval band precedes the segment band',
  );
  assert.match(body, /Three levels of autonomy\./);
  assert.match(body, /Governance and oversight\./);
  assert.match(body, /Built for independent operators/);
  assert.match(body, /Straightforward pricing/);
  assert.match(body, /Self-managing owners/);
  assert.match(body, /Equal Housing Opportunity/);
  // the platform suites (the Entrata-model taxonomy)
  for (const suite of ['Leasing & Marketing', 'Payments & Receivables', 'Accounting & Finance', 'Facilities & Maintenance', 'Resident Services', 'Reporting & Analytics']) {
    assert.ok(body.includes(suite.replace('&', '&amp;')) || body.includes(suite), `suite "${suite}" present`);
  }
  // the retired jargon must stay gone
  assert.ok(!/ontology/i.test(body), 'no ontology-layer jargon');
  assert.ok(!/Operations Experience|Resident Experience/.test(body), 'no OXP/RXP platform framing');
  assert.ok(!/agentic operating system/i.test(body), 'no agentic-OS meta line');
  // the three implementation steps and three autonomy levels
  for (const step of ['Import the portfolio', 'Review and approve drafts', 'Delegate proven work']) {
    assert.match(body, new RegExp(step), `step "${step}" present`);
  }
  for (const mode of ['Draft for approval', 'Autonomous within limits', 'Fully autonomous, audited']) {
    assert.match(body, new RegExp(mode), `mode "${mode}" present`);
  }
  await page.close();
});

test('gate: homepage interactions — nav dropdown exclusivity and the new-to-AI example', async () => {
  const page = await newPage(browser);
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });

  // nav dropdown opens on click and is exclusive
  await page.click('.mk-item-btn:has-text("Platform")');
  assert.ok(await page.locator('.mk-item.open .mk-drop').isVisible(), 'Platform dropdown opens');
  await page.click('.mk-item-btn:has-text("AI")');
  assert.equal(await page.locator('.mk-item.open').count(), 1, 'only one dropdown open at a time');

  // the never-used-AI example card renders the drafted reply + approval row
  const card = page.locator('.mk-nta-card');
  await card.scrollIntoViewIfNeeded();
  assert.match(await card.textContent() || '', /waiting for your approval/i, 'draft card shows approval framing');
  assert.match(await card.textContent() || '', /Approve/, 'approve action shown');
  // and it links to the plain-English tour
  assert.ok(await page.locator('a[href="/agents/new-to-ai"]').first().isVisible(), 'new-to-AI page linked');
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
