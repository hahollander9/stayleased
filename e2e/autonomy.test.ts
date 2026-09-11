import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import type { Browser } from 'playwright';

/** The screen where an operator decides how much the AI may do without them.
 *
 * The redesign replaced a native `<select>` per cell with a segmented control,
 * which is a nicer thing to look at and a worse thing to ship if it stopped
 * setting the dial. So the first test is not about appearance at all: it clicks
 * a position and proves the setting actually moved and survived a reload.
 *
 * The rest guard the reason the control changed shape. Draft → approve →
 * autonomous is an ordered scale of delegation, and the old treatment rendered
 * all three identically: you could not tell, looking at the grid, which
 * buildings had been handed autonomy. The selected position now carries a
 * colour, and the card states the count outright — the operator's real question
 * on this page is "how much have I given away", and it should not require
 * reading sixteen dropdowns. */

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

const DIALS = '/ai?view=dials';

test('setting a dial still works — it is a control, not a picture of one', async () => {
  const page = await newPage(browser, {});
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}${DIALS}`);
  await page.waitForLoadState('networkidle');

  // Payments AI, org default — draft in the seed, and the row least likely to
  // be dialled up by another test.
  const row = page.locator('.dialgrid tbody tr', { has: page.locator('th:has-text("Payments AI")') });
  const orgDial = row.locator('td').first().locator('.dial');
  assert.match(await orgDial.getAttribute('class') || '', /lv-draft/, 'starts on draft');

  await Promise.all([
    page.waitForLoadState('networkidle'),
    orgDial.locator('label:has-text("Approve") input').click(),
  ]);

  const after0 = page.locator('.dialgrid tbody tr', { has: page.locator('th:has-text("Payments AI")') })
    .locator('td').first().locator('.dial');
  assert.match(await after0.getAttribute('class') || '', /lv-approve/, 'the click moved the dial');

  // and it is persisted, not just re-rendered optimistically
  await page.goto(`${base}${DIALS}`);
  await page.waitForLoadState('networkidle');
  const reloaded = page.locator('.dialgrid tbody tr', { has: page.locator('th:has-text("Payments AI")') })
    .locator('td').first().locator('.dial');
  assert.match(await reloaded.getAttribute('class') || '', /lv-approve/, 'and it stuck');

  // put it back, so the suite leaves the org as it found it
  await Promise.all([
    page.waitForLoadState('networkidle'),
    reloaded.locator('label:has-text("Draft") input').click(),
  ]);
  await page.close();
});

test('the grid can be read for delegation without reading every cell', async () => {
  const page = await newPage(browser, {});
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}${DIALS}`);
  await page.waitForLoadState('networkidle');

  // Every dial carries its position as a class, which is what colours it —
  // the point being that "where did I grant autonomy" is answerable by looking.
  const levels = await page.$$eval('.dialgrid .dial', (d) =>
    d.map((e) => (e.className.match(/lv-(\w+)/) || [])[1]));
  assert.ok(levels.length > 0, 'there are dials');
  assert.ok(levels.every((l) => ['draft', 'approve', 'auto'].includes(l!)), 'each one states its position');

  // and the card says the total outright rather than making you count
  const count = await page.locator('.dial-count').textContent() || '';
  const autos = levels.filter((l) => l === 'auto').length;
  assert.match(count, autos ? new RegExp(`${autos} of ${levels.length}`) : /Nothing runs autonomously/,
    `the headline count matches the grid (${autos} of ${levels.length}): "${count}"`);
  await page.close();
});

test('the three settings are explained in order, each saying who sends', async () => {
  const page = await newPage(browser, {});
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}${DIALS}`);
  await page.waitForLoadState('networkidle');

  const rungs = await page.$$eval('.ladder .rung', (r) => r.map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim()));
  assert.equal(rungs.length, 3, 'three settings, laid out as a scale');
  assert.match(rungs[0]!, /Draft only.*You send/);
  assert.match(rungs[1]!, /Approve to send.*You click, it sends/);
  assert.match(rungs[2]!, /Autonomous.*It sends, you review after/);
  await page.close();
});

test('the guardrails no longer claim Ask StayLeased is read-only', async () => {
  const page = await newPage(browser, {});
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}${DIALS}`);
  await page.waitForLoadState('networkidle');

  // It could only read when this page was written; it can act now, behind a
  // preview and a confirmation. A stale reassurance on the governance screen is
  // worse than none: it is the page an operator reads to decide what to trust.
  const guard = await page.locator('.guardrails').textContent() || '';
  assert.doesNotMatch(guard, /Ask StayLeased is read-only/i);
  assert.match(guard, /Ask StayLeased shows you the change before it makes it/i);
  await page.close();
});

test('a viewer without ai:configure sees every dial and can change none', async () => {
  const page = await newPage(browser, {});
  // Property manager: ai:view and ai:approve, but not ai:configure.
  await login(page, base, 'manager@summitridge.demo');
  await page.goto(`${base}${DIALS}`);
  await page.waitForLoadState('networkidle');

  assert.ok(await page.locator('.dial-ro').count() > 0, 'the positions are visible');
  assert.equal(await page.locator('.dialgrid input[type=radio]').count(), 0, 'and there is nothing to click');
  await page.close();
});

test('the dial reads correctly in both themes and does not overflow a phone', async () => {
  for (const scheme of ['light', 'dark'] as const) {
    const page = await newPage(browser, { colorScheme: scheme });
    await login(page, base, 'admin@summitridge.demo');
    await page.goto(`${base}${DIALS}`);
    await page.waitForLoadState('networkidle');

    // The selected option must be the emphasised one. The first version filled
    // the whole track with a hard-coded dark surface that has no light-theme
    // value, so in light mode the UNSELECTED options read heavier than the
    // selection — the one thing this control exists to communicate.
    const [on, off] = await page.evaluate(() => {
      const d = document.querySelector('.dial')!;
      const sel = d.querySelector('.dial-opt.on span')!;
      const un = d.querySelector('.dial-opt:not(.on) span')!;
      const bg = (e: Element): string => getComputedStyle(e).backgroundColor;
      return [bg(sel), bg(un)];
    });
    assert.notEqual(on, off, `${scheme}: the selected position is filled and the others are not`);
    assert.ok(/rgba\(0, 0, 0, 0\)|transparent/.test(off), `${scheme}: unselected options carry no fill (${off})`);
    await page.close();
  }

  const m = await newPage(browser, { mobile: true });
  await login(m, base, 'admin@summitridge.demo');
  await m.goto(`${base}${DIALS}`);
  await m.waitForLoadState('networkidle');
  const w = await m.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  assert.equal(w.sw, w.cw, `the page does not scroll sideways on a phone (${w.sw} vs ${w.cw})`);
  await m.close();
});
