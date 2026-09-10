import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import type { Browser, Page } from 'playwright';

/** The conversation, as the operator actually experiences it.
 *
 * `tests/ask_memory.test.ts` proves the rules. This proves the thing those
 * rules exist for: that the conversation is still there. Every assertion below
 * describes a moment the old browser-held transcript was silently emptied —
 * a reload, closing the panel, walking to another page, clicking "Full page" —
 * none of which the operator would read as "and forget what I asked".
 *
 * The suggestions are here for the same reason. They used to name Summit
 * Ridge, Foundry and Cardinal, which are the demo seed's buildings: in a real
 * customer's org every one of those chips asked about a property that does not
 * exist, and the first thing a new operator clicks answered with a shrug. */

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

const bubbles = (page: Page, root = '#aichat-thread'): Promise<string[]> =>
  page.$$eval(`${root} .aichat-msg`, (n) => n.map((e) => (e.textContent || '').trim()));

async function say(page: Page, q: string, sel = '#aichat-input'): Promise<void> {
  await page.fill(sel, q);
  await page.press(sel, 'Enter');
  await page.waitForTimeout(2200);
}

test('a follow-up is answered as the question it continues, not as small talk', async () => {
  const page = await newPage(browser, {});
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/ask`);
  await page.waitForLoadState('networkidle');

  await say(page, 'which units turn this month');
  const first = (await bubbles(page)).pop() || '';
  assert.match(first, /leases? end/i, 'the first question is answered from the data');

  // "what about next month" carries no topic of its own. Before the thread
  // reached the data handlers this fell through to the conversational lane and
  // came back as prose — a data question answered with chat.
  await say(page, 'what about next month');
  const second = (await bubbles(page)).pop() || '';
  assert.match(second, /leases? end/i, 'and so is the follow-up');
  assert.notEqual(second.slice(0, 60), first.slice(0, 60), 'about a different month than the first');
  await page.close();
});

test('the conversation survives a reload', async () => {
  const page = await newPage(browser, {});
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/ask`);
  await page.waitForLoadState('networkidle');
  await page.click('.aichat-new button').catch(() => { /* nothing to clear */ });
  await page.waitForLoadState('networkidle');

  await say(page, 'occupancy right now');
  const before = await bubbles(page);
  assert.ok(before.length >= 2, 'a question and an answer');

  await page.reload();
  await page.waitForLoadState('networkidle');
  const after = await bubbles(page);
  assert.ok(after.some((b) => /occupancy right now/.test(b)), 'the question is still on screen');
  assert.ok(after.some((b) => /occupancy/i.test(b) && /%/.test(b)), 'and so is its answer');
  await page.close();
});

test('closing the panel stops the conversation without ending it', async () => {
  const page = await newPage(browser, {});
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/properties`);
  await page.waitForLoadState('networkidle');

  await page.click('[data-ask-open]');
  await page.waitForSelector('.askdock.open');
  await page.waitForTimeout(700);
  await say(page, 'open work orders', '.askdock input');
  assert.ok((await bubbles(page, '.askdock')).some((b) => /work order/i.test(b)));

  // Closing used to delete the thread outright, so reopening handed you an
  // assistant with no idea who you had just been talking about.
  await page.click('.askdock-close');
  await page.waitForTimeout(200);
  await page.click('[data-ask-open]');
  await page.waitForTimeout(900);
  assert.ok((await bubbles(page, '.askdock')).some((b) => /open work orders/.test(b)),
    'reopening resumes the same conversation');

  // …and it follows you to the full page, which used to start empty.
  await page.click('.askdock-full');
  await page.waitForLoadState('networkidle');
  assert.ok((await bubbles(page)).some((b) => /open work orders/.test(b)),
    'the dock and the full page are one conversation, not two');

  // Forgetting is its own control now that leaving is not one.
  await page.click('.aichat-new button');
  await page.waitForLoadState('networkidle');
  assert.ok(!(await bubbles(page)).some((b) => /open work orders/.test(b)),
    '"New conversation" is what forgets');
  await page.close();
});

test('the suggestions name this org’s own properties, and the actions only fill the box', async () => {
  const page = await newPage(browser, {});
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/ask`);
  await page.waitForLoadState('networkidle');

  const chips = await page.$$eval('#aichat-chips .aichat-chip', (n) => n.map((e) => e.textContent!.trim()));
  assert.ok(chips.length, 'there are suggestions');
  assert.ok(!chips.some((c) => /<property>/.test(c)), 'no placeholder ever reaches the screen');
  // Whatever building a chip names has to be one this org actually has — the
  // whole point of generating them instead of writing them down.
  const own = await page.$$eval('.prop-switch option', (o) => o.map((e) => e.textContent!.trim()));
  for (const c of chips.filter((x) => / at /.test(x))) {
    const named = c.split(' at ')[1]!;
    assert.ok(own.some((p) => p.includes(named)), `"${named}" is a property this org has (of ${own.join(', ')})`);
  }

  const acts = page.locator('#aichat-does .aichat-chip');
  assert.ok(await acts.count() > 0, 'and the things it can DO are shown, not just the things it can answer');
  const beforeCount = (await bubbles(page)).length;
  await acts.first().click();
  await page.waitForTimeout(300);
  assert.ok((await page.inputValue('#aichat-input')).length > 0, 'clicking one fills the box');
  assert.equal((await bubbles(page)).length, beforeCount,
    'and sends nothing — the household is the operator’s to name');
  await page.close();
});

test('the Ask button is on screen on a phone, and no page scrolls sideways', async () => {
  const page = await newPage(browser, { mobile: true });
  await login(page, base, 'admin@summitridge.demo');
  for (const path of ['/ask', '/delinquency', '/properties', '/workorders']) {
    await page.goto(`${base}${path}`);
    await page.waitForLoadState('networkidle');
    const m = await page.evaluate(() => {
      const d = document.documentElement;
      const a = document.querySelector('.askbtn')?.getBoundingClientRect();
      return { sw: d.scrollWidth, cw: d.clientWidth, right: a ? Math.round(a.right) : -1, left: a ? Math.round(a.left) : -1 };
    });
    // The bar ran to 652px inside a 390px screen, which scrolled every page
    // sideways and put the Ask button past the right edge entirely.
    assert.equal(m.sw, m.cw, `${path} does not scroll sideways (${m.sw} vs ${m.cw})`);
    assert.ok(m.left >= 0 && m.right <= m.cw, `${path}: the Ask button is on screen (${m.left}→${m.right} of ${m.cw})`);
  }
  await page.close();
});
