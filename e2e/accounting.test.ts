import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import type { Browser, Page } from 'playwright';

/** THE PHASE 10 GATE — accountant reconciles a seeded month to zero
 * difference; period closes and blocks postings; balance sheet balances, IS
 * ties to T-12, AR aging ties to control; budget vs actual shows variances.
 * Plus the AP lifecycle end-to-end in the UI. */

let base: string;
let browser: Browser;
let close: () => Promise<void>;
let acct: Page; // Priya Raman, accountant

before(async () => {
  const b = await boot();
  base = b.base;
  browser = b.browser;
  close = b.close;
  acct = await newPage(browser);
  await login(acct, base, 'accountant@summitridge.demo');
});

after(async () => close());

test('gate 1: seeded history is reconciled through last month; July reconciles to zero live', async () => {
  await acct.goto(`${base}/banking`);
  const body = (await acct.textContent('.content')) || '';
  assert.match(body, /Reconciliation history/);
  assert.match(body, /completed/i);

  // open the Summit Ridge operating account workbench — July suggested (has unmatched feed)
  await Promise.all([acct.waitForLoadState('networkidle'), acct.click('table tbody tr:has-text("Summit Ridge") a:has-text("Reconcile")')]);
  assert.match(acct.url(), /\/reconcile/);
  assert.match((await acct.textContent('h1')) || '', /Jul 2026/);

  // auto-match clears every ref-tagged transaction
  await Promise.all([acct.waitForLoadState('networkidle'), acct.click('button:has-text("Auto-match")')]);
  assert.match((await acct.textContent('.flash')) || '', /0 still open/);

  // difference hits zero and the month completes
  const kpi = (await acct.textContent('.kpis')) || '';
  assert.match(kpi, /Unmatched difference\s*\$0\.00/);
  await Promise.all([acct.waitForLoadState('networkidle'), acct.click('button:has-text("Complete at $0.00")')]);
  assert.match((await acct.textContent('.flash')) || '', /zero difference/);

  // reconciliation report renders with book-vs-bank walk
  await Promise.all([acct.waitForLoadState('networkidle'), acct.click('.content a:has-text("Report")')]);
  const report = (await acct.textContent('.content')) || '';
  assert.match(report, /Statement closing balance/);
  assert.match(report, /Book balance/);
});

test('gate 2: closed period blocks postings; reopen is audited; re-close works', async () => {
  await acct.goto(`${base}/periods`);
  let body = (await acct.textContent('.content')) || '';
  assert.match(body, /Close checklist/);
  assert.match(body, /closed/i); // seeded closes through June

  // June is closed — a manual JE into June bounces
  await acct.goto(`${base}/gl/new`);
  await acct.fill('input[name=date]', '2026-06-15');
  await acct.fill('input[name=memo]', 'late reclass attempt');
  await acct.selectOption('select[name=acct_0]', '5010');
  await acct.fill('input[name=dr_0]', '1.00');
  await acct.selectOption('select[name=acct_1]', '5020');
  await acct.fill('input[name=cr_1]', '1.00');
  await Promise.all([acct.waitForLoadState('networkidle'), acct.click('button:has-text("Post entry")')]);
  assert.match((await acct.textContent('.flash')) || '', /closed/i);

  // audited reopen, then the checklist is still green and it re-closes
  await acct.goto(`${base}/periods?month=2026-06`);
  await acct.fill('input[name=reason]', 'auditor requested a reclass window');
  acct.once('dialog', (d) => void d.accept());
  await Promise.all([acct.waitForLoadState('networkidle'), acct.click('button:has-text("Reopen period")')]);
  assert.match((await acct.textContent('.flash')) || '', /reopened/i);
  await Promise.all([acct.waitForLoadState('networkidle'), acct.click('button:has-text("Close Jun 2026")')]);
  assert.match((await acct.textContent('.flash')) || '', /closed — postings now blocked/);
});

test('gate 3: balance sheet balances on both bases; IS ties to T-12; invariants green', async () => {
  for (const basis of ['accrual', 'cash']) {
    await acct.goto(`${base}/statements?kind=bs&basis=${basis}`);
    const body = (await acct.textContent('.content')) || '';
    assert.match(body, /Balanced ✓/, `${basis} balance sheet`);
  }
  // IS NOI for July == T-12 July column (server-computed from the same lines)
  await acct.goto(`${base}/statements?kind=is&from=2026-07-01&asof=2026-07-26`);
  const isBody = (await acct.textContent('.kpis')) || '';
  const noi = /NOI\s*(\$[\d,.]+)/.exec(isBody)?.[1];
  assert.ok(noi, 'NOI renders');
  await acct.goto(`${base}/statements?kind=t12&asof=2026-07-26`);
  const t12Body = (await acct.textContent('.content')) || '';
  assert.equal(t12Body.includes(noi!), true, `T-12 contains July NOI ${noi}`);

  // AR aging ties to control account — the invariant suite runs live
  await acct.goto(`${base}/gl/invariants`);
  const inv = (await acct.textContent('.content')) || '';
  assert.match(inv, /all passing/);
  assert.match(inv, /AR control ties/);
});

test('gate 4: approved budget shows seeded variances', async () => {
  await acct.goto(`${base}/budgets`);
  const list = (await acct.textContent('.content')) || '';
  assert.match(list, /approved/i);
  await Promise.all([acct.waitForLoadState('networkidle'), acct.click('tbody tr:has-text("Summit Ridge")')]);
  assert.match(acct.url(), /\/budgets\//);
  const bva = (await acct.textContent('.content')) || '';
  assert.match(bva, /Budget vs actual/);
  assert.match(bva, /over budget|under/, 'variance flags fire');
});

test('gate 5: AP lifecycle — approve the pending invoice, run payment, void + reissue', async () => {
  await acct.goto(`${base}/ap?status=pending_approval`);
  const row = acct.locator('tbody tr[data-href]').first();
  assert.equal((await row.count()) >= 1, true, 'seeded pending invoice');
  await row.click();
  await acct.waitForLoadState('networkidle');
  assert.match((await acct.textContent('.content')) || '', /requires ap:approve|Rooftop/);
  await Promise.all([acct.waitForLoadState('networkidle'), acct.click('button:has-text("Approve & post")')]);
  assert.match((await acct.textContent('.flash')) || '', /approved — accrual posted/i);

  // pay it in a run
  await acct.goto(`${base}/ap/runs`);
  await Promise.all([acct.waitForLoadState('networkidle'), acct.click('button:has-text("Process payment run")')]);
  assert.match((await acct.textContent('.flash')) || '', /payment run processed/i);

  // positive-pay register: void + reissue the newest check
  acct.once('dialog', (d) => void d.accept());
  await Promise.all([acct.waitForLoadState('networkidle'), acct.click('form[action*="/void"] button:has-text("Void + reissue")')]);
  assert.match((await acct.textContent('.flash')) || '', /voided and reissued/i);
  const register = (await acct.textContent('.content')) || '';
  assert.match(register, /void/i);
});

test('intercompany due-to/due-from is visible on the trial balance', async () => {
  await acct.goto(`${base}/gl?basis=accrual`);
  // pick Summit Ridge property filter
  const sr = await acct.locator('select[name=property] option', { hasText: 'Summit Ridge' }).getAttribute('value');
  await acct.goto(`${base}/gl?basis=accrual&property=${sr}`);
  const body = (await acct.textContent('.content')) || '';
  assert.match(body, /Due from Affiliated Properties/);
});
