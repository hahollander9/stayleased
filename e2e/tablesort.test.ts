import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import type { Browser } from 'playwright';

/** Click a header, sort the table.
 *
 * Sorting is a property of `tbl()` rather than of any page, because there are
 * 163 tables and a feature granted table by table is one most tables never get.
 * So these run against ordinary screens that asked for nothing.
 *
 * The rule worth guarding is not "it sorts" — it is the two ways sorting lies.
 * A money column compared as text puts $1,000.00 above $9.00. And a table
 * showing one page of a long list can only order that page, so presenting the
 * result as a sorted list claims a maximum that may sit ten pages away. The
 * first is fixed by reading cells as values; the second by saying so. */

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

test('any table sorts from its header, and a third click gives the page back', async () => {
  const page = await newPage(browser, {});
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/properties`);
  await page.waitForLoadState('networkidle');

  const th = 'table[data-sortable] thead th:nth-child(1) button[data-sort]';
  assert.ok(await page.locator(th).count(), 'the properties table sorts without having asked to');

  const col = (): Promise<string[]> =>
    page.$$eval('table[data-sortable] tbody tr td:nth-child(1)', (tds) =>
      tds.map((td) => (td.textContent || '').trim()));

  const original = await col();
  await page.click(th);
  const asc = await col();
  assert.deepEqual(
    asc, [...asc].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })),
    'first click sorts ascending',
  );
  assert.equal(
    await page.getAttribute('table[data-sortable] thead th:nth-child(1)', 'aria-sort'), 'ascending',
    'and says so to a screen reader',
  );

  await page.click(th);
  assert.deepEqual(await col(), [...asc].reverse(), 'second click reverses');

  await page.click(th);
  assert.deepEqual(await col(), original, 'third click restores the order the server sent');
  assert.equal(
    await page.getAttribute('table[data-sortable] thead th:nth-child(1)', 'aria-sort'), null,
    'and clears the sort state with it',
  );
  await page.close();
});

test('a money column sorts by amount, not by the text of the amount', async () => {
  const page = await newPage(browser, {});
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/delinquency`);
  await page.waitForLoadState('networkidle');

  const heads = await page.$$eval('table[data-sortable] thead th', (ths) =>
    ths.map((th) => (th.textContent || '').trim()));
  const i = heads.findIndex((h) => /^total$/i.test(h)) + 1;
  assert.ok(i > 0, `a Total column exists to sort (saw ${JSON.stringify(heads)})`);

  await page.click(`table[data-sortable] thead th:nth-child(${i}) button[data-sort]`);
  const amounts = await page.$$eval(
    `table[data-sortable] tbody tr td:nth-child(${i})`,
    (tds) => tds.map((td) => {
      const s = (td.textContent || '').trim();
      const n = parseFloat(s.replace(/[$,()\s]/g, '')) || 0;
      return /^\(.*\)$/.test(s) ? -n : n;
    }),
  );
  assert.ok(amounts.length > 1, 'there are balances to order');
  for (let k = 1; k < amounts.length; k++) {
    assert.ok(amounts[k - 1]! <= amounts[k]!,
      `ascending by amount: ${amounts[k - 1]} came before ${amounts[k]}`);
  }
  await page.close();
});

test('a paginated list says the sort covered its page, and unsays it on restore', async () => {
  const page = await newPage(browser, {});
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/admin/audit`);
  await page.waitForLoadState('networkidle');

  const pages = Number(await page.getAttribute('.pager[data-pages]', 'data-pages'));
  assert.ok(pages > 1, 'the audit log runs to more than one page');

  const th = 'table[data-sortable] thead th:nth-child(1) button[data-sort]';
  await page.click(th);
  const note = await page.locator('.tbl-scope').first().textContent();
  assert.match(String(note), /rows on this page, not all [\d,]+ records/,
    'the disclosure names both counts rather than implying a full sort');
  assert.doesNotMatch(String(note), /\d{5}(?!\d)/, 'and thousands are separated, as everywhere else');

  await page.click(th);
  await page.click(th);
  assert.equal(await page.locator('.tbl-scope').count(), 0,
    'restoring the original order removes a disclaimer that no longer applies');
  await page.close();
});

test('the residents roster keeps sorting on the server, over all of it', async () => {
  const page = await newPage(browser, {});
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/residents`);
  await page.waitForLoadState('networkidle');

  // It is paginated, so an in-page sorter would order 50 of 366. Its headers
  // are links instead, and tbl() stands the in-page sorter down entirely.
  assert.ok(await page.locator('table .th-sort[href]').count() > 0, 'headers are server-sort links');
  assert.equal(await page.locator('table[data-sortable]').count(), 0,
    'and the in-page sorter does not also run on it');

  await page.click('table .th-sort[href]');
  await page.waitForLoadState('networkidle');
  assert.match(page.url(), /[?&]sort=/, 'clicking a header sorts through the server');
  assert.ok(await page.locator('th[aria-sort]').count() > 0, 'and the applied column is announced');
  await page.close();
});
