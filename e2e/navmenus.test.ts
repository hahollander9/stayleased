import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import type { Browser, Page } from 'playwright';

/** Regression guard for the module-bar dropdowns.
 *
 * Why this exists: a `.modulebar { overflow-x: auto }` rule once clipped every
 * dropdown (any overflow value other than `visible` on the bar force-clips the
 * absolutely-positioned menus inside it — overflow-x:auto computes
 * overflow-y:auto per spec). Ordinary Playwright visibility checks did NOT
 * catch it, because clipped-by-ancestor elements still count as "visible".
 * The honest test is document.elementFromPoint at the menu link's own
 * coordinates: it returns the link only if a human could actually see and
 * click it. Never weaken these assertions back to isVisible(). */

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

async function humanCanClickFirstItem(page: Page, menuSel: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const m = document.querySelector(sel);
    if (!m || !m.classList.contains('open')) return false;
    const a = m.querySelector('a, button');
    if (!a) return false;
    const r = a.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!(hit && (hit === a || a.contains(hit)));
  }, menuSel);
}

for (const width of [1440, 1024]) {
  test(`module-bar dropdowns are truly visible and clickable at ${width}px`, async () => {
    const page = await newPage(browser);
    await page.setViewportSize({ width, height: 900 });
    await login(page, base, 'admin@summitridge.demo');

    const tabs = page.locator('.modulebar .mtab');
    const n = await tabs.count();
    assert.ok(n >= 7, `expected at least 7 dropdown tabs, saw ${n}`);

    for (let i = 0; i < n; i++) {
      const tab = tabs.nth(i);
      const label = (await tab.locator('.mtab-btn').innerText()).trim();
      await tab.locator('.mtab-btn').click();
      const menuId = await tab.locator('.mtab-btn').getAttribute('data-toggle');
      assert.ok(menuId, `tab "${label}" has no data-toggle`);
      const ok = await humanCanClickFirstItem(page, menuId!);
      assert.ok(ok, `dropdown "${label}" opened in the DOM but is not human-visible/clickable (ancestor clipping?)`);
      await page.mouse.click(720, 520); // close via outside click
    }
    await page.close();
  });
}

test('gear and account menus are truly visible and clickable', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  for (const [name, btnSel, menuSel] of [
    ['setup gear', 'button[data-toggle="#setup-pop"]', '#setup-pop'],
    ['account avatar', 'button[data-toggle="#usermenu-pop"]', '#usermenu-pop'],
  ] as const) {
    await page.click(btnSel);
    const ok = await humanCanClickFirstItem(page, menuSel);
    assert.ok(ok, `${name} menu opened but is not human-visible/clickable`);
    await page.mouse.click(720, 520);
  }
  await page.close();
});

test('dropdown click-through navigates (Financials → Accounting reaches /gl)', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  await page.locator('.modulebar .mtab-btn', { hasText: 'Financials' }).first().click();
  await Promise.all([
    page.waitForLoadState('networkidle'),
    page.locator('.mtab .menu.open a', { hasText: 'Accounting' }).first().click(),
  ]);
  assert.match(new URL(page.url()).pathname, /^\/gl/, `expected /gl, got ${page.url()}`);
  await page.close();
});
