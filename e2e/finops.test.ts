import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import { q, q1 } from '../src/lib/db.ts';
import type { Browser } from 'playwright';

/** Financial-operations gate: the approvals inbox aggregates money
 * decisions; bank statements import from real CSV files into the rec
 * workbench; accounting setup manages bank accounts + the chart; work
 * orders open pre-linked purchase orders; the deposits screen runs
 * state-law return clocks. */

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

test('gate: approvals inbox shows pending money decisions and approves an invoice', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/approvals`, { waitUntil: 'networkidle' });
  const body = await page.content();
  assert.match(body, /Approvals/);
  // seed guarantees a pending vendor invoice (accounting gate 5 relies on it)
  const pending = q<any>(`SELECT i.id, i.invoice_number FROM vendor_invoices i WHERE i.status='pending_approval'`);
  if (pending.length) {
    assert.ok(body.includes('Vendor invoices'), 'invoice section present');
    const inv = pending[0]!;
    await Promise.all([
      page.waitForLoadState('networkidle'),
      page.click(`form[action="/ap/${inv.id}/approve"] button`),
    ]);
    const row = q1<any>('SELECT status, je_id FROM vendor_invoices WHERE id=?', inv.id);
    assert.equal(row!.status, 'approved', 'invoice approved from the inbox');
    assert.ok(row!.je_id, 'approval posted the accrual JE');
  }
  await page.close();
});

test('gate: a real bank CSV imports idempotently and lands in the workbench', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/banking`, { waitUntil: 'networkidle' });
  const acct = q1<any>(`SELECT id FROM bank_accounts WHERE kind='operating' ORDER BY created_at LIMIT 1`);
  assert.ok(acct, 'operating bank account exists');
  await page.goto(`${base}/banking/${acct!.id}`, { waitUntil: 'networkidle' });
  assert.match(await page.content(), /Import a statement file/);
  const csv = [
    'Date,Description,Amount',
    '2026-07-30,E2E WIRE DEPOSIT,1234.56',
    '2026-07-31,E2E SERVICE FEE,-19.00',
  ].join('\n');
  await page.setInputFiles('input[name=statement]', { name: 'stmt.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await Promise.all([page.waitForLoadState('networkidle'), page.click('form[action$="/upload"] button')]);
  assert.match(await page.content(), /2 transactions imported/);
  // re-import: zero new rows
  await page.setInputFiles('input[name=statement]', { name: 'stmt.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await Promise.all([page.waitForLoadState('networkidle'), page.click('form[action$="/upload"] button')]);
  assert.match(await page.content(), /0 transactions imported from stmt\.csv \(2 already present\)/);
  const rows = q<any>(`SELECT * FROM bank_txns WHERE bank_account_id=? AND description LIKE 'E2E %'`, acct!.id);
  assert.equal(rows.length, 2, 'idempotent import');
  assert.equal(rows.find((r) => r.amount_cents === 123456)!.kind, 'deposit');
  assert.equal(rows.find((r) => r.amount_cents === -1900)!.kind, 'fee');
  await page.close();
});

test('gate: accounting setup adds a bank account and a GL account; control accounts locked', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/gl/setup`, { waitUntil: 'networkidle' });
  const body = await page.content();
  assert.match(body, /Bank accounts/);
  assert.match(body, /Opening balances/);
  assert.match(body, /Chart of accounts/);
  // add a bank account
  await page.fill('form[action="/gl/setup/bank"] input[name=name]', 'Ops — E2E National');
  await page.fill('form[action="/gl/setup/bank"] input[name=bank_name]', 'E2E National');
  await page.fill('form[action="/gl/setup/bank"] input[name=last4]', '9876');
  await Promise.all([page.waitForLoadState('networkidle'), page.click('form[action="/gl/setup/bank"] button')]);
  assert.ok(q1('SELECT id FROM bank_accounts WHERE name=?', 'Ops — E2E National'), 'bank account stored');
  // add a GL account
  await page.fill('form[action="/gl/setup/account"] input[name=code]', '5915');
  await page.fill('form[action="/gl/setup/account"] input[name=name]', 'Snow removal');
  await Promise.all([page.waitForLoadState('networkidle'), page.click('form[action="/gl/setup/account"] button')]);
  assert.ok(q1(`SELECT id FROM gl_accounts WHERE code='5915' AND name='Snow removal'`), 'GL account added');
  // control accounts refuse deactivation
  const control = q1<any>(`SELECT id FROM gl_accounts WHERE code='1100' AND is_control='ar' LIMIT 1`);
  if (control) {
    await Promise.all([page.waitForLoadState('networkidle'), page.click(`form[action="/gl/setup/account/${control.id}/toggle"] button`)]);
    assert.match(await page.content(), /Control accounts cannot be deactivated/);
  }
  await page.close();
});

test('gate: a work order opens a pre-linked purchase order', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  const wo = q1<any>(`SELECT id, summary FROM work_orders WHERE status NOT IN ('completed','canceled','closed') ORDER BY created_at DESC LIMIT 1`);
  assert.ok(wo, 'an open work order exists in seed');
  await page.goto(`${base}/workorders/${wo!.id}`, { waitUntil: 'networkidle' });
  const link = page.locator(`a[href="/purchasing/new?workorder=${wo!.id}"]`);
  assert.ok(await link.isVisible(), 'Create purchase order action on the work order');
  await Promise.all([page.waitForLoadState('networkidle'), link.click()]);
  const body = await page.content();
  assert.match(body, /Linked to work order/);
  assert.ok(body.includes(`value="${wo!.id}"`), 'source_id carried on the form');
  const memo = await page.inputValue('input[name=memo]');
  assert.match(memo, /^WO /, 'memo prefilled from the work order');
  await page.close();
});

test('gate: deposits screen runs state-law clocks; lease tab shows the deadline', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/deposits`, { waitUntil: 'networkidle' });
  const body = await page.content();
  assert.match(body, /state law/i, 'state-law subtitle');
  assert.match(body, /State clock/, 'state clock column');
  assert.match(body, /verify specifics with counsel/i, 'counsel disclaimer');
  // any lease row leads to the deposit tab with the deadline line
  const first = page.locator('tbody tr[data-href], tbody tr a, tbody tr').first();
  const lease = q1<any>(`SELECT l.id FROM leases l WHERE l.org_id=(SELECT org_id FROM properties LIMIT 1) AND l.status IN ('active','month_to_month','notice','ended') AND l.deposit_cents>0 LIMIT 1`);
  if (lease) {
    await page.goto(`${base}/leases/${lease.id}?tab=deposit`, { waitUntil: 'networkidle' });
    const tab = await page.content();
    assert.match(tab, /Return deadline/, 'deadline row on the deposit tab');
    assert.match(tab, /days after move-out/, 'state days rendered');
  }
  await page.close();
});
