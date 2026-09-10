import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import type { Browser } from 'playwright';

/** The billing page, in the running application.
 *
 * `tests/billing.test.ts` proves the rules — the meter, the signature, the
 * idempotency. This proves the two things only the real server can answer.
 *
 * The first is that the page tells the truth to the person looking at it: an
 * early-access org sees its real figure AND is told it is not being charged.
 * Those two facts have to appear together, because either one alone is a
 * different and wrong message.
 *
 * The second is the webhook. It is the one route in this application that is
 * deliberately unauthenticated — Stripe carries no session — so it has to be
 * reachable by an anonymous request and it has to refuse that request. A test
 * that only checks the signature function would pass just as happily if the
 * route were never mounted, or were sitting behind a login that Stripe could
 * never satisfy. */

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

test('the bill shows its arithmetic, and the count adds up to the total on the page', async () => {
  const page = await newPage(browser, {});
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/admin/billing`);
  await page.waitForLoadState('networkidle');

  const calc = (await page.locator('.bill-calc').textContent() || '').replace(/\s+/g, ' ').trim();
  assert.match(calc, /^\d[\d,]* units × \$[\d.,]+ per month$/, `the working is on the page: ${calc}`);

  const units = Number(calc.match(/^([\d,]+)/)![1]!.replace(/,/g, ''));
  const price = Number(calc.match(/\$([\d.,]+)/)![1]!.replace(/,/g, ''));
  const total = Number((await page.locator('.bt-amt').textContent() || '').replace(/[$,]/g, ''));
  assert.ok(units > 0, 'the demo portfolio has units');
  assert.equal(Math.round(units * price * 100), Math.round(total * 100),
    'the total is the multiplication shown above it, not a separate number');

  // The evidence: the per-property table has to sum to the same count, because
  // that is the operator's way of checking the bill against their own records.
  const rows = await page.$$eval('.card table tbody tr td:last-child', (td) =>
    td.map((c) => Number((c.textContent || '0').replace(/[^\d]/g, ''))));
  assert.equal(rows.reduce((a, b) => a + b, 0), units,
    `the buildings add up to the billed count (${rows.join(' + ')} vs ${units})`);
  await page.close();
});

test('an early-access org sees its real figure and is told it is not being charged', async () => {
  const page = await newPage(browser, {});
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/admin/billing`);
  await page.waitForLoadState('networkidle');

  assert.match(await page.locator('.bill-state .badge').textContent() || '', /Early access/);
  const line = await page.locator('.bill-state p').textContent() || '';
  assert.match(line, /not being charged/i, 'said plainly, not implied by an absent invoice');
  assert.ok(Number((await page.locator('.bt-amt').textContent() || '').replace(/[$,]/g, '')) > 0,
    'and the figure is real rather than hidden — the operator can see what it would come to');

  // The empty state has to say WHY it is empty. "No invoices yet" would read as
  // a bill that has not arrived rather than one that is never coming.
  assert.match(await page.locator('.empty').textContent() || '', /not being charged|nothing is billed/i);
  await page.close();
});

test('with no Stripe key configured the page says so instead of offering a button that fails', async () => {
  const page = await newPage(browser, {});
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/admin/billing`);
  await page.waitForLoadState('networkidle');

  // The e2e environment has no STRIPE_SECRET_KEY, which is the state every
  // deployment starts in and the one most likely to be seen.
  assert.match(await page.locator('.card .callout').last().textContent() || '', /not switched on/i);
  assert.equal(await page.locator('form[action="/admin/billing/checkout"]').count(), 0,
    'no checkout button, because pressing it could only produce an error');
  await page.close();
});

test('billing is the org admin’s page, and a leasing agent cannot open it', async () => {
  const page = await newPage(browser, {});
  await login(page, base, 'agent@summitridge.demo');
  const res = await page.goto(`${base}/admin/billing`);
  assert.ok((res?.status() || 0) >= 400, `refused (${res?.status()})`);
  assert.equal(await page.locator('.bill-calc').count(), 0, 'and nothing of the bill is rendered');
  await page.close();
});

test('the Stripe webhook is reachable without a session and refuses an unsigned delivery', async () => {
  const page = await newPage(browser, {});
  // Deliberately NOT logged in, and deliberately not through the page: Stripe
  // is a server somewhere posting to a URL, so the call is made the same way —
  // no session, no cookie, no origin. This route has to work for that caller
  // and therefore has to defend itself.
  const res = await page.request.post(`${base}/webhooks/stripe`, {
    headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
    data: { id: 'evt_forged', type: 'invoice.paid', data: { object: { id: 'in_x' } } },
  });
  const body = await res.text();

  assert.notEqual(res.status(), 404, 'the route exists — a 404 here would pass a signature-only test too');
  assert.notEqual(res.status(), 200, 'and a forged delivery is never accepted');
  assert.ok(res.status() === 400 || res.status() === 503,
    `refused with a reason (${res.status()}: ${body.slice(0, 140)})`);
  await page.close();
});
