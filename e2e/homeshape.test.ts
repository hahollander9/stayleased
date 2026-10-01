import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, newPage } from './lib.ts';
import type { Browser } from 'playwright';

/** Three things asked of the homepage, and the ways each quietly regresses.
 *
 * The hamburger is the clearest: it was already in the markup, already last in
 * the header, and still sat beside the logo with 149px of empty bar to its
 * right — because the element that pushed the right-hand side right was the
 * desktop menu's flex:1, and the menu is display:none at exactly the width
 * where the burger appears. A test that only asserts the burger exists would
 * have passed throughout.
 *
 * The page is shorter by argument rather than by deletion: the three bands that
 * each promised supervision became one, and the two that each explained the
 * architecture became one. So the pin is on the count of sections AND on the
 * content that had to survive the merge — a consolidation that quietly dropped
 * the guardrail list would otherwise look like a win.
 *
 * And the image is a real screenshot of the real product, which is the only
 * kind this repo's honesty gate allows: not a rendering, not a mockup of a
 * dashboard nobody can open. */

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

test('the hamburger sits at the right edge of the header, not beside the logo', async () => {
  const page = await newPage(browser, { mobile: true });
  await page.goto(`${base}/`);
  await page.waitForLoadState('networkidle');

  const m = await page.evaluate(() => {
    const b = document.querySelector('.mk-burger')!.getBoundingClientRect();
    const logo = document.querySelector('.mk-logo')!.getBoundingClientRect();
    const bar = document.querySelector('.mk-nav-in')!.getBoundingClientRect();
    return { bLeft: b.left, bRight: b.right, logoRight: logo.right, barRight: bar.right, vw: window.innerWidth };
  });

  // Flush right: the gap from the burger to the bar's right edge is smaller
  // than the gap from the logo to the burger. Before the fix those were 149px
  // and 30px — exactly backwards.
  const gapRight = m.barRight - m.bRight;
  const gapLeft = m.bLeft - m.logoRight;
  assert.ok(gapRight < gapLeft,
    `the burger is at the right edge (gap right ${Math.round(gapRight)}px vs gap from logo ${Math.round(gapLeft)}px)`);
  assert.ok(gapRight < 40, `and actually flush, not merely rightmost (${Math.round(gapRight)}px)`);
  await page.close();
});

test('the hamburger still opens the menu it is meant to open', async () => {
  const page = await newPage(browser, { mobile: true });
  await page.goto(`${base}/`);
  await page.waitForLoadState('networkidle');

  // Moving a control is the easiest way to put it under something else.
  assert.equal(await page.locator('.mk-mobile.open').count(), 0, 'closed to begin with');
  await page.click('#mk-burger');
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.mk-mobile.open').count(), 1, 'opens on click');
  assert.equal(await page.getAttribute('#mk-burger', 'aria-expanded'), 'true', 'and says so');
  await page.close();
});

test('the homepage shows the product, with a real screenshot of it', async () => {
  const page = await newPage(browser, {});
  await page.goto(`${base}/`);
  await page.waitForLoadState('networkidle');

  const img = page.locator('.mk-shot img');
  assert.equal(await img.count(), 1, 'there is a hero image');

  // It has to have actually loaded — a broken src renders as nothing and the
  // page still "has an img".
  const loaded = await img.evaluate((e) => {
    const i = e as HTMLImageElement;
    return { ok: i.complete && i.naturalWidth > 0, w: i.naturalWidth, alt: i.alt };
  });
  assert.ok(loaded.ok, `the image loads (naturalWidth ${loaded.w})`);
  assert.ok(loaded.alt.length > 40, 'and carries a description of what it shows, not a filename');

  // Dimensions on the tag, so the hero does not jump as it arrives.
  assert.ok(await img.getAttribute('width'), 'width is declared');
  assert.ok(await img.getAttribute('height'), 'height is declared');
  await page.close();
});

test('the page makes each argument once', async () => {
  const page = await newPage(browser, {});
  await page.goto(`${base}/`);
  await page.waitForLoadState('networkidle');

  const sections = await page.$$eval('section', (s) => s.length);
  assert.ok(sections <= 12, `the page runs to ${sections} sections, not the fifteen it had`);

  // Three separate headlines used to promise supervision. One does now — and
  // the material from the other two is inside it rather than deleted.
  const nta = await page.locator('#newtoai').textContent() || '';
  assert.match(nta, /Nothing reaches a resident without sign-off/);
  assert.match(nta, /Three levels, set by you/, 'the autonomy levels moved in');
  assert.match(nta, /What no setting can switch off/, 'so did the guardrails');
  assert.match(nta, /audit trail/i);

  // Same for the architecture claim and the comparison table that evidences it.
  const plat = await page.locator('#platform').textContent() || '';
  assert.match(plat, /Agents that work on the records/);
  assert.match(plat, /Legacy platforms hold the records/, 'the comparison moved in');
  assert.match(plat, /Published pricing/, 'with the table intact');

  // The band numbering is a sequence; a merge that leaves holes in it reads as
  // a page with pieces missing.
  const kickers = await page.$$eval('.mk-kicker .mk-k-n, .mk-kicker', (k) =>
    k.map((e) => (e.textContent || '').trim().match(/^(\d{2})/)?.[1]).filter(Boolean));
  const nums = [...new Set(kickers)];
  assert.deepEqual(nums, nums.slice().sort(), 'the numbers run in order');
  for (let i = 1; i < nums.length; i++) {
    assert.equal(Number(nums[i]) - Number(nums[i - 1]!), 1, `no gap between ${nums[i - 1]} and ${nums[i]}`);
  }
  await page.close();
});

test('the hero image does not overflow a phone or push the page sideways', async () => {
  const page = await newPage(browser, { mobile: true });
  await page.goto(`${base}/`);
  await page.waitForLoadState('networkidle');
  const m = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
    imgRight: Math.round(document.querySelector('.mk-shot img')!.getBoundingClientRect().right),
  }));
  assert.equal(m.sw, m.cw, `no sideways scroll (${m.sw} vs ${m.cw})`);
  assert.ok(m.imgRight <= m.cw, `the screenshot stays inside the viewport (${m.imgRight})`);
  await page.close();
});
