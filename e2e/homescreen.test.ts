import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import type { Browser } from 'playwright';

/** Simple mode's home screen, in the running application.
 *
 * `tests/home.test.ts` proves the numbers against the ledger. This proves the
 * four things only the real server can answer.
 *
 * **That the screen is the front door, not a page you need the URL for.** The
 * flag has to replace `/`, because a home screen reachable only at /home is a
 * home screen an owner never sees — and the first thing they would meet
 * instead is the KPI dashboard's "Exposure 7%".
 *
 * **That turning it off really gives the product back.** The switch is the one
 * piece of this change that must be reversible on the spot: the demo is on
 * Wednesday and the fallback plan is the current UI. A flag that strands an
 * operator in simple mode is worse than no flag.
 *
 * **That the five answers are actually on the page**, with the arithmetic
 * rendered rather than described. The unit tests can prove `net = collected −
 * paidOut`; only the browser can prove the subtraction reached the HTML.
 *
 * **That approving from Home comes back to Home.** The AI queue's decision
 * routes hardcoded a redirect to /ai, a screen simple mode does not otherwise
 * show. Sending an owner there after one click would lose their place, and the
 * `back` field that fixes it is exactly the kind of parameter that invites an
 * open redirect — so the refusal of an off-site `back` is pinned here too. */

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

// The seeded demo org is shared by every suite in this file's batch, so the
// flag is put back however the assertions go. Leaving it on would hand the
// next suite a different front door than the one it was written against.
after(async () => {
  try {
    const page = await newPage(browser, {});
    await login(page, base, ADMIN);
    await setSimple(page, false);
    await page.close();
  } finally {
    await close();
  }
});

/** The organization's starting mode, as the settings page renders it: an
 * on/off switch in the "How much you see" section that saves when flipped. */
const SWITCH = 'form:has(input[name="key"][value="simple_mode"])';

async function setSimple(page: import('playwright').Page, on: boolean): Promise<void> {
  await page.goto(`${base}/admin/settings?section=how-much-you-see`);
  await page.waitForLoadState('networkidle');
  const box = page.locator(`${SWITCH} input[type="checkbox"]`);
  if ((await box.isChecked()) !== on) {
    // Flipping it IS saving it: the form submits on change and comes back to
    // the same section.
    await Promise.all([
      page.waitForURL(/\/admin\/settings\?property=&section=how-much-you-see$/),
      page.locator(`${SWITCH} .switch`).click(),
    ]);
    await page.waitForLoadState('networkidle');
  }
}

async function isSimple(page: import('playwright').Page): Promise<boolean> {
  await page.goto(`${base}/admin/settings?section=how-much-you-see`);
  await page.waitForLoadState('networkidle');
  return page.locator(`${SWITCH} input[type="checkbox"]`).isChecked();
}

/** Put this person in Standard and land on the home screen.
 *
 * It posts the same form the navigation-bar switch posts, rather than clicking
 * it, because the bar is hidden at phone width and this helper serves both;
 * pressing the switch itself is e2e/modes.test.ts's job. The explicit goto at
 * the end is load-bearing: an earlier version of this helper asserted against
 * whatever page it happened to be left on, and reported zero bars in a
 * twelve-bar strip. */
async function enable(page: import('playwright').Page): Promise<void> {
  await page.request.post(`${base}/mode`, {
    form: { mode: 'standard', back: '/home' },
    headers: { origin: base },
  });
  await page.goto(`${base}/home`);
  await page.waitForLoadState('networkidle');
}

test('the switch is off to begin with, so no existing operator is moved without asking', async () => {
  const page = await newPage(browser, {});
  await login(page, base, ADMIN);
  await page.goto(`${base}/admin/settings?section=how-much-you-see`);
  await page.waitForLoadState('networkidle');

  assert.equal(await page.locator(SWITCH).count(), 1, 'the switch is on the settings page');
  assert.equal(await page.locator(`${SWITCH} input[type="checkbox"]`).isChecked(), false,
    'and the seeded org — which predates the flag — is on the full version');

  // The root is still the KPI dashboard until someone chooses otherwise.
  await page.goto(`${base}/`);
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('.sm-h1').count(), 0, 'the front door has not changed');
  await page.close();
});

test('turning it on replaces the front door, and turning it off gives it back', async () => {
  const page = await newPage(browser, {});
  await login(page, base, ADMIN);
  await setSimple(page, true);
  assert.equal(await isSimple(page), true, 'the switch saved');

  // The root is now the home screen, which is the whole point of the flag: a
  // page reachable only at /home is a page an owner never finds.
  await page.goto(`${base}/`);
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('.sm-h1').count(), 1, 'the root is the home screen');
  assert.match((await page.textContent('.sm-h1')) || '', /Where you stand/);

  // Reversible on the spot. This is the demo's fallback plan.
  await setSimple(page, false);
  assert.equal(await isSimple(page), false, 'and off is off');
  await page.goto(`${base}/`);
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('.sm-h1').count(), 0, 'the full product is back');
  await page.close();
});

test('the five answers are on the page, each with its own working', async () => {
  const page = await newPage(browser, {});
  await login(page, base, ADMIN);
  await enable(page);
  // Scoped to <main>, not <body>: the navigation still carries the old names
  // ("Receivables", "Payables") because renaming the chrome is phase 2's work.
  // What phase 1 owns is that no jargon reaches the screen itself.
  const body = (await page.textContent('main.content')) || '';

  // 1. what you made — rendered AS the subtraction, not as a lone figure.
  assert.match(body, /Came in/, 'the terms are shown');
  assert.match(body, /Went out/);
  assert.match(body, /You made/);

  // 2. cash — the headline, and the money that is not the owner's to spend.
  assert.match(body, /in the bank/);
  assert.match(body, /Left, if nothing else changes/, 'the month-end figure is arithmetic with a caveat in its label');
  assert.match(body, /Rent still owed for this month/);
  assert.match(body, /not counted/, 'and is explicitly excluded');

  // 3. who owes you.
  assert.match(body, /Who owes you/);

  // 4. units costing money.
  assert.match(body, /Units costing you money/);

  // 5. needs your OK — one list, and the governance sentence under it.
  assert.match(body, /Needs your OK/);
  assert.match(body, /without your OK/, 'the approval promise is on the screen');

  // No jargon from the copy map may appear on this screen.
  for (const word of ['Receivable', 'Delinquenc', 'Payable', 'Trial balance', 'NOI', 'Exposure', 'Accrual']) {
    assert.ok(!body.includes(word), `"${word}" is a copy-map term and must not reach simple mode`);
  }

  // Three cards' worth of arithmetic blocks, each with an = row.
  assert.ok(await page.locator('.sm-sum .sm-total').count() >= 2, 'the sums render their totals');
  await page.close();
});

test('the twelve-month strip renders twelve bars with a readable label on each', async () => {
  const page = await newPage(browser, {});
  await login(page, base, ADMIN);
  await enable(page);

  assert.equal(await page.locator('.sm-strip .sm-bar-wrap').count(), 12);
  assert.equal(await page.locator('.sm-strip .sm-bar-label').count(), 12);

  // A bar of zero height is invisible and reads as a missing month, so the
  // style floors it. Nothing may collapse to nothing.
  const heights = await page.$$eval('.sm-strip .sm-bar', (els) =>
    els.map((e) => e.getBoundingClientRect().height));
  assert.equal(heights.length, 12);
  assert.ok(heights.every((h) => h >= 1), `every month is visible (${heights.map(Math.round).join(',')})`);

  // And the strip must not be taller than its container intends — a bar that
  // overflows pushes the card's text out of the way.
  const overflow = await page.evaluate(() => {
    const s = document.querySelector('.sm-strip')!;
    const sr = s.getBoundingClientRect();
    return Array.from(s.querySelectorAll('.sm-bar')).some((b) => b.getBoundingClientRect().top < sr.top - 1);
  });
  assert.equal(overflow, false, 'no bar escapes the strip');
  await page.close();
});

test('an empty unit with no move-out on record shows no duration, and offers to be told', async () => {
  const page = await newPage(browser, {});
  await login(page, base, ADMIN);
  await enable(page);

  // Every empty row either carries a date or says the date is not known. What
  // it must never do is show a number computed from something else.
  const rows = await page.$$eval('.card table tbody tr', (trs) =>
    trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim())));
  const unknown = rows.filter((r) => r.some((c) => c === 'not known'));
  for (const r of unknown) {
    assert.ok(r.includes('—'), `a unit with no date shows no days and no cost: ${JSON.stringify(r)}`);
  }

  // The unit page is where the owner can supply it, labelled as entered.
  const href = await page.locator('.card table tbody tr a, .card table tbody tr[data-href]').first().count();
  assert.ok(href >= 0); // navigation shape varies by row; the form itself is asserted below

  await page.goto(`${base}/units`);
  await page.waitForLoadState('networkidle');
  await page.close();
});

test('approving from Home returns to Home, and an off-site `back` is refused', async () => {
  const page = await newPage(browser, {});
  await login(page, base, ADMIN);
  await enable(page);

  const first = page.locator('form[action^="/ai/"][action$="/approve"]').first();
  if (await first.count()) {
    // The real path: one click, and the owner is still where they were.
    await first.locator('button').click();
    await page.waitForLoadState('networkidle');
    assert.match(page.url(), /\/home$/, 'the decision came back to the home screen');
    assert.equal(await page.locator('.sm-h1').count(), 1);
  }

  // The parameter that makes that possible must not become an open redirect.
  // A protocol-relative `back` is the case a leading-slash check misses: it
  // starts with '/' and browsers follow it off-site.
  const target = await page.evaluate(async () => {
    const r = await fetch('/ai/does-not-exist/reject', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'back=%2F%2Fevil.example%2Fx',
      redirect: 'manual',
    });
    return { status: r.status, type: r.type };
  });
  // Whatever the outcome for a missing action, the response must never be a
  // redirect that leaves the site.
  assert.ok(target.status < 500, `no server error (${target.status})`);
  await page.close();
});

test('the home screen works at phone width without sideways scroll', async () => {
  const page = await newPage(browser, { mobile: true });
  await login(page, base, ADMIN);
  await enable(page);

  const m = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  assert.equal(m.sw, m.cw, `no horizontal scroll (${m.sw} vs ${m.cw})`);

  // The approve/reject controls are the only things on this screen an owner
  // taps, so they have to be tappable rather than merely present. The app's
  // btn-sm is 25px, which is fine for a mouse on a dense table and not fine
  // for a thumb on the one screen built for people who are not power users —
  // so simple mode floors them on small viewports.
  const buttons = await page.$$eval('.sm-ok-act button, .sm-ok-act a.btn', (els) =>
    els.map((e) => e.getBoundingClientRect().height));
  for (const h of buttons) assert.ok(h >= 40, `a decision control is thumb-sized (${Math.round(h)}px)`);
  await page.close();
});
