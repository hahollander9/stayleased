import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import type { Browser, Page } from 'playwright';

/** Standard and Advanced, in a real browser.
 *
 * `tests/uimode.test.ts` proves the rules over HTTP: the mode is personal,
 * Standard only offers pages a role can open, sectioning loses no setting.
 * This proves the things only a rendered page can:
 *
 *   · the switch can be SEEN and PRESSED where a person looks for it — at the
 *     end of the bar it changes on a desk, at the head of the drawer on a phone;
 *   · pressing it changes the whole navigation and leaves you on the same page;
 *   · a settings switch saves when it is flipped, with no Save to hunt for;
 *   · nothing in the chrome pushes the page sideways at laptop widths — which
 *     it did, before this change, at every width from 981 to 1,279px. */

let base: string;
let browser: Browser;
let close: () => Promise<void>;
const ADMIN = 'admin@summitridge.demo';

before(async () => {
  const b = await boot();
  base = b.base;
  browser = b.browser;
  close = b.close;
});
after(async () => close());

const tabLabels = (page: Page): Promise<string[]> =>
  page.$$eval('.modulebar > .mtab > .mtab-btn, .modulebar > a.mtab-btn', (els) => els.map((e) => (e.textContent || '').trim()));

async function press(page: Page, mode: 'standard' | 'advanced'): Promise<void> {
  await page.locator(`.modulebar .modeswitch button[value="${mode}"]`).click();
  await page.waitForLoadState('networkidle');
}

test('the switch sits at the end of the bar, and pressing it swaps the whole navigation in place', async () => {
  const page = await newPage(browser, {});
  await login(page, base, ADMIN);
  await page.goto(`${base}/residents`);
  await page.waitForLoadState('networkidle');

  const sw = page.locator('.modulebar .modeswitch');
  assert.equal(await sw.count(), 1, 'there is one switch in the bar');
  assert.ok(await sw.isVisible(), 'and it is visible, not tucked into a menu');
  const box = (await sw.boundingBox())!;
  const bar = (await page.locator('.modulebar').boundingBox())!;
  assert.ok(bar.x + bar.width - (box.x + box.width) < 24, 'it sits at the trailing end of the row it changes');

  await press(page, 'standard');
  assert.match(page.url(), /\/residents$/, 'same page after switching — a change of view, not of place');
  assert.deepEqual(await tabLabels(page), ['Home', 'Money', 'Units', 'People', 'Repairs']);
  assert.equal(await page.getAttribute('.modulebar .modeswitch button[value="standard"]', 'aria-pressed'), 'true');
  // the page you were on is marked in the new navigation's own words
  assert.equal((await page.textContent('.subnav a.active'))?.trim(), 'Residents');

  await press(page, 'advanced');
  assert.equal((await tabLabels(page)).length, 8, 'and back to all eight');
  assert.match(page.url(), /\/residents$/);
  await page.close();
});

test('Standard’s menus open, group their pages, and land where they say', async () => {
  const page = await newPage(browser, {});
  await login(page, base, ADMIN);
  await page.goto(`${base}/units`);
  await page.waitForLoadState('networkidle');
  await press(page, 'standard');

  await page.click('.modulebar .mtab-btn:has-text("Money")');
  await page.waitForTimeout(250);
  const menu = page.locator('.modulebar .menu.open');
  assert.equal(await menu.count(), 1, 'the Money menu opens');
  const groups = await menu.locator('.mgroup').allTextContents();
  assert.deepEqual(groups.map((g) => g.trim()), ['Coming in', 'Going out', 'Your books']);
  await menu.locator('a:has-text("Who owes me")').click();
  await page.waitForLoadState('networkidle');
  assert.match(page.url(), /\/receivables$/, 'a plain-language label opens the real page');

  // Home is the front door in Standard.
  await page.click('.modulebar a.mtab-btn:has-text("Home")');
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('.sm-h1').count(), 1, 'Home is the five-answer screen');
  await press(page, 'advanced');
  await page.close();
});

test('on a phone the drawer leads with the switch and follows the mode', async () => {
  const page = await newPage(browser, { mobile: true });
  await login(page, base, ADMIN);
  await page.goto(`${base}/units`);
  await page.waitForLoadState('networkidle');
  await page.click('.menu-btn');
  await page.waitForTimeout(350);

  const sw = page.locator('#sidebar .drawer-mode .modeswitch');
  assert.ok(await sw.isVisible(), 'the switch is the first thing in the drawer');
  const h = (await sw.locator('button').first().boundingBox())!.height;
  assert.ok(h >= 36, `and thumb-sized (${Math.round(h)}px)`);

  await sw.locator('button[value="standard"]').click();
  await page.waitForLoadState('networkidle');
  await page.click('.menu-btn');
  await page.waitForTimeout(350);
  const heads = (await page.$$eval('#sidebar .nav-head', (e) => e.map((x) => (x.textContent || '').trim())));
  assert.deepEqual(heads, ['Money', 'Units', 'People', 'Repairs'], 'the drawer is Standard’s five tabs');
  const links = await page.$$eval('#sidebar .nav a', (a) => a.length);
  assert.ok(links < 30, `a drawer, not a sitemap (${links} links; it was 56)`);

  await page.locator('#sidebar .drawer-mode button[value="advanced"]').click();
  await page.waitForLoadState('networkidle');
  await page.close();
});

test('settings: one section at a time, a section list that says where you are, and a phone picker', async () => {
  const page = await newPage(browser, {});
  await login(page, base, ADMIN);
  await page.goto(`${base}/admin/settings`);
  await page.waitForLoadState('networkidle');

  const height = await page.evaluate(() => document.body.scrollHeight);
  assert.ok(height < 3000, `the page is one section, not every setting (${height}px; it was 8,105)`);
  assert.equal(await page.locator('.set-nav a[aria-current="true"]').count(), 1, 'exactly one section is current');

  await page.click('.set-nav a:has-text("AI and automation")');
  await page.waitForLoadState('networkidle');
  assert.match(page.url(), /section=ai-and-automation/);
  assert.equal((await page.textContent('.set-nav a[aria-current="true"]'))?.trim(), 'AI and automation');

  const phone = await newPage(browser, { mobile: true });
  await login(phone, base, ADMIN);
  await phone.goto(`${base}/admin/settings`);
  await phone.waitForLoadState('networkidle');
  assert.ok(await phone.locator('.set-pick select').isVisible(), 'a native picker on a phone');
  assert.ok(!(await phone.locator('.set-nav').isVisible()), 'instead of the rail');
  await Promise.all([
    phone.waitForURL(/section=communications/),
    phone.selectOption('.set-pick select', 'communications'),
  ]);
  await phone.waitForLoadState('networkidle');
  assert.match(phone.url(), /section=communications/, 'choosing a section goes there');
  const sw = await phone.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  assert.equal(sw[0], sw[1], 'no sideways scroll on a phone');
  await phone.close();
  await page.close();
});

test('an on/off setting saves the moment it is flipped', async () => {
  const page = await newPage(browser, {});
  await login(page, base, ADMIN);
  await page.goto(`${base}/admin/settings?section=ai-and-automation`);
  await page.waitForLoadState('networkidle');

  const FORM = 'form:has(input[name="key"][value="ai_first_touch"])';
  const box = page.locator(`${FORM} input[role="switch"]`);
  const was = await box.isChecked();
  assert.equal(await page.locator(`${FORM} button:has-text("Save")`).count(), 0, 'no Save to hunt for');

  await Promise.all([
    page.waitForURL(/section=ai-and-automation/),
    page.locator(`${FORM} .switch`).click(),
  ]);
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator(`${FORM} input[role="switch"]`).isChecked(), !was, 'the new state survived a reload');
  assert.match((await page.textContent('.flash')) || '', /saved/i, 'and the page says so');

  // put it back
  await Promise.all([page.waitForURL(/section=ai-and-automation/), page.locator(`${FORM} .switch`).click()]);
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator(`${FORM} input[role="switch"]`).isChecked(), was);
  await page.close();
});

test('the gear groups what it holds', async () => {
  const page = await newPage(browser, {});
  await login(page, base, ADMIN);
  await page.goto(`${base}/units`);
  await page.waitForLoadState('networkidle');
  await page.click('[data-toggle="#setup-pop"]');
  await page.waitForTimeout(250);
  const heads = await page.$$eval('#setup-pop .mgroup', (e) => e.map((x) => (x.textContent || '').trim()));
  assert.ok(heads.includes('Your organization') && heads.includes('Records'), `labelled groups (${heads.join(', ')})`);
  const bottom = (await page.locator('#setup-pop').boundingBox())!;
  const vh = page.viewportSize()!.height;
  assert.ok(bottom.y + bottom.height <= vh + 1, 'the menu fits on screen, or scrolls within itself');
  await page.close();
});

test('no page scrolls sideways at laptop widths, in either mode', async () => {
  const page = await newPage(browser, {});
  await login(page, base, ADMIN);
  for (const width of [1024, 1152, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    for (const mode of ['standard', 'advanced'] as const) {
      await page.goto(`${base}/admin/settings`);
      await page.waitForLoadState('networkidle');
      await press(page, mode);
      const m = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
        gear: Math.round(document.querySelector('[data-toggle="#setup-pop"]')!.getBoundingClientRect().right),
        avatar: Math.round(document.querySelector('.avatar')!.getBoundingClientRect().right),
        sw2: Math.round(document.querySelector('.modulebar .modeswitch')!.getBoundingClientRect().right),
      }));
      assert.equal(m.sw, m.cw, `${width}px ${mode}: no sideways scroll (${m.sw} vs ${m.cw})`);
      assert.ok(m.gear <= m.cw && m.avatar <= m.cw, `${width}px ${mode}: the gear and account menu are on screen`);
      assert.ok(m.sw2 <= m.cw, `${width}px ${mode}: the switch is on screen`);
    }
  }
  await page.close();
});
