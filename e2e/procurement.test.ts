import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import type { Browser, Page } from 'playwright';

/** THE PHASE 12 GATE — PO → approval → vendor acknowledges → receive → OCR'd
 * invoice 3-way matches (one seeded exception routes to the queue) → payment
 * run pays it → vendor portal shows remittance; 1099 summary generates. */

let base: string;
let browser: Browser;
let close: () => Promise<void>;
let staff: Page; // property manager
let vendor: Page; // Pinnacle Plumbing
let poUrl = '';

before(async () => {
  const b = await boot();
  base = b.base;
  browser = b.browser;
  close = b.close;
  staff = await newPage(browser);
  await login(staff, base, 'manager@summitridge.demo');
  vendor = await newPage(browser, { mobile: true });
  await login(vendor, base, 'vendor@summitridge.demo');
});

after(async () => close());

test('gate 1: PO created (auto-approved under threshold); big PO routes for approval', async () => {
  await staff.goto(`${base}/purchasing/new`);
  const { q1: q1db } = await import('../src/lib/db.ts');
  const pinnacle = q1db<any>(`SELECT id FROM vendors WHERE name='Pinnacle Plumbing'`);
  const sr = q1db<any>(`SELECT id FROM properties WHERE slug='summit-ridge'`);
  await staff.selectOption('form[action="/purchasing/new"] select[name=vendor_id]', pinnacle.id);
  await staff.selectOption('form[action="/purchasing/new"] select[name=property_id]', sr.id);
  const kit = await staff.locator('select[name=cat_0] option', { hasText: 'Toilet fill/flush' }).getAttribute('value');
  await staff.selectOption('select[name=cat_0]', kit!);
  await staff.fill('input[name=qty_0]', '4');
  await staff.fill('input[name=memo]', 'gate test — supply restock');
  await Promise.all([staff.waitForLoadState('networkidle'), staff.click('button:has-text("Create & submit")')]);
  assert.match((await staff.textContent('.flash')) || '', /approved and sent/i);
  poUrl = staff.url().split('?')[0]!;
  const created = q1db<any>(`SELECT v.name FROM purchase_orders po JOIN vendors v ON v.id=po.vendor_id WHERE po.id=?`, poUrl.split('/').pop());
  assert.equal(created?.name, 'Pinnacle Plumbing', 'PO belongs to the portal vendor');

  // the seeded project PO awaits approval; an approver clears it
  const admin = await newPage(browser);
  await login(admin, base, 'admin@summitridge.demo');
  await admin.goto(`${base}/purchasing?status=pending_approval`);
  await Promise.all([admin.waitForLoadState('networkidle'), admin.click('tbody tr[data-href]')]);
  assert.match((await admin.textContent('.content')) || '', /Roof project/);
  await Promise.all([admin.waitForLoadState('networkidle'), admin.click('button:has-text("Approve & send")')]);
  assert.match((await admin.textContent('.flash')) || '', /sent to the vendor/i);
  await admin.close();
});

test('gate 2: vendor acknowledges the PO in their portal', async () => {
  await vendor.goto(`${base}/vendor/pos`);
  const body = (await vendor.textContent('body')) || '';
  assert.match(body, /gate test — supply restock/);
  await Promise.all([vendor.waitForLoadState('networkidle'), vendor.click('form[action*="/ack"] button:has-text("Acknowledge")')]);
  assert.match((await vendor.textContent('.flash')) || '', /acknowledged — thank you/i);
});

test('gate 3: receiving restocks inventory; PO fully received', async () => {
  await staff.goto(poUrl);
  assert.match((await staff.textContent('.content')) || '', /acknowledged/i);
  await Promise.all([staff.waitForLoadState('networkidle'), staff.click('button:has-text("Post receipt")')]);
  assert.match((await staff.textContent('.flash')) || '', /Receipt posted/);
  assert.match((await staff.textContent('.subtitle')) || '', /received/i);
});

test('gate 4: vendor submits the OCR-prefilled invoice — 3-way match passes', async () => {
  await vendor.goto(`${base}/vendor/pos`);
  await Promise.all([vendor.waitForLoadState('networkidle'), vendor.click('a:has-text("Submit invoice")')]);
  const body = (await vendor.textContent('body')) || '';
  assert.match(body, /OCR pre-filled/i);
  assert.match(body, /Toilet fill\/flush/);
  await Promise.all([vendor.waitForLoadState('networkidle'), vendor.click('button:has-text("Submit invoice")')]);
  assert.match((await vendor.textContent('.flash')) || '', /matched — routed for payment/i);
});

test('gate 5: the seeded mis-priced invoice sits in the exception queue; override routes to AP', async () => {
  const acct = await newPage(browser);
  await login(acct, base, 'accountant@summitridge.demo');
  await acct.goto(`${base}/purchasing/exceptions`);
  const body = (await acct.textContent('.content')) || '';
  assert.match(body, /variance exceeds the .*tolerance/i, 'seeded price exception');
  await acct.fill('input[name=reason]', 'vendor price increase confirmed by PM');
  await Promise.all([acct.waitForLoadState('networkidle'), acct.click('button:has-text("Override & route to AP")')]);
  assert.match((await acct.textContent('.flash')) || '', /overridden — invoice routed to AP/i);
  assert.match((await acct.textContent('.content')) || '', /No open exceptions/);
  await acct.close();
});

test('gate 6: payment run pays the matched invoices; vendor sees payment + remittance', async () => {
  const acct = await newPage(browser);
  await login(acct, base, 'accountant@summitridge.demo');
  await acct.goto(`${base}/ap/runs`);
  await Promise.all([acct.waitForLoadState('networkidle'), acct.click('button:has-text("Process payment run")')]);
  assert.match((await acct.textContent('.flash')) || '', /payment run processed/i);
  await acct.close();

  await vendor.goto(`${base}/vendor/pos`);
  const body = (await vendor.textContent('body')) || '';
  assert.match(body, /Payments to you/);
  assert.match(body, /issued|cleared/i);
  const remitHref = await vendor.locator('a:has-text("Remittance")').first().getAttribute('href');
  assert.ok(remitHref);
  const res = await vendor.request.get(base + remitHref!);
  assert.equal(res.status(), 200);
  assert.match(res.headers()['content-type'] || '', /application\/pdf/);
});

test('gate 7: 1099 summary generates with the missing-W-9 exception list', async () => {
  const acct = await newPage(browser);
  await login(acct, base, 'accountant@summitridge.demo');
  await acct.goto(`${base}/purchasing/1099`);
  const body = (await acct.textContent('.content')) || '';
  assert.match(body, /Missing W-9/i);
  assert.match(body, /SwiftTurn Painting/, 'the W-9 gap vendor is flagged');
  assert.match((await acct.textContent('.kpis')) || '', /Reportable payments/);
  const res = await acct.request.get(`${base}/purchasing/1099.pdf?year=2026`);
  assert.equal(res.status(), 200);
  assert.match(res.headers()['content-type'] || '', /application\/pdf/);
  await acct.close();
});

test('spend analytics renders with PO leakage split', async () => {
  const acct = await newPage(browser);
  await login(acct, base, 'accountant@summitridge.demo');
  await acct.goto(`${base}/purchasing/spend`);
  const body = (await acct.textContent('.content')) || '';
  assert.match(body, /PO-backed spend|PO leakage/);
  assert.match(body, /Spend by vendor/);
  await acct.close();
});
