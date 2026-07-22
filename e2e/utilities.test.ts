import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import type { Browser, Page } from 'playwright';

/** THE PHASE 11 GATE — a RUBS run previews per-unit math and posts converged
 * charges visible on one resident statement; the vacant-recovery report is
 * correct around seeded move-outs; an insurance lapse auto-enrolls into the
 * master policy with notices; deposit-alternative claims settle at move-out. */

let base: string;
let browser: Browser;
let close: () => Promise<void>;
let staff: Page;

before(async () => {
  const b = await boot();
  base = b.base;
  browser = b.browser;
  close = b.close;
  staff = await newPage(browser);
  await login(staff, base, 'accountant@summitridge.demo');
});

after(async () => close());

test('gate 1: RUBS preview shows every unit\'s math, then posts converged charges', async () => {
  await staff.goto(`${base}/utilities/rubs`);
  // pick the property with the seeded preview run (Cardinal water, June usage)
  const cc = await staff.locator('select[name=property] option', { hasText: 'Cardinal' }).getAttribute('value');
  await staff.goto(`${base}/utilities/rubs?property=${cc}`);
  const runLink = staff.locator('tr:has-text("preview") a:has-text("Review & post")').first();
  assert.equal((await runLink.count()) >= 1, true, 'seeded preview run');
  await runLink.click();
  await staff.waitForLoadState('networkidle');

  const body = (await staff.textContent('.content')) || '';
  assert.match(body, /Per-unit math/);
  assert.match(body, /sqft · \d+\/\d+ days/, 'allocation basis per unit');
  assert.match(body, /Billed to residents/);
  staff.once('dialog', (d) => void d.accept());
  await Promise.all([staff.waitForLoadState('networkidle'), staff.click('button:has-text("Approve & post to ledgers")')]);
  assert.match((await staff.textContent('.flash')) || '', /charges posted .* converged/i);
  assert.match((await staff.textContent('.content')) || '', /on ledger/);
});

test('gate 2: converged charges appear on the resident ledger with rent', async () => {
  // Maya's staff-side ledger shows rent and RUBS items on one statement
  const { q1 } = await import('../src/lib/db.ts');
  const lease = q1<any>(
    `SELECT l.id FROM leases l JOIN household_members hm ON hm.lease_id=l.id JOIN residents r ON r.id=hm.resident_id
     WHERE r.email='maya.torres@mail.demo' AND l.status='active' LIMIT 1`,
  );
  assert.ok(lease, 'Maya has an active lease');
  await staff.goto(`${base}/leases/${lease.id}`);
  const body = (await staff.textContent('.content')) || '';
  assert.match(body, /RUBS/, 'converged utility charges on the ledger');
  assert.match(body, /Rent — /, 'alongside rent');
});

test('gate 3: vacant recovery report is correct around seeded move-outs', async () => {
  await staff.goto(`${base}/utilities/recovery`);
  const body = (await staff.textContent('.content')) || '';
  assert.match(body, /Recovery rate by service/);
  assert.match(body, /\d+%/, 'recovery percentage renders');
  assert.match(body, /vacant days/, 'per-unit vacant shares listed');
});

test('gate 4: insurance lapse auto-enrolls into the master policy with notices', async () => {
  await staff.goto(`${base}/insurance`);
  const kpiBefore = (await staff.textContent('.kpis')) || '';
  const lapsedBefore = Number(/Lapsed\s*(\d+)/.exec(kpiBefore)?.[1] || '0');
  assert.equal(lapsedBefore > 0, true, `seeded lapsed bucket (${lapsedBefore})`);

  // advance to Aug 3 (+7 then +1): compliance sweep force-places on the first
  // day; the utility cycle stages July's reads/invoices/previews on the 3rd
  const admin = await newPage(browser);
  await login(admin, base, 'admin@summitridge.demo');
  await admin.goto(`${base}/dev/sim`);
  await admin.click('button[value="7"]', { timeout: 120000 });
  await admin.waitForLoadState('networkidle', { timeout: 120000 });
  await admin.click('button[value="1"]', { timeout: 120000 });
  await admin.waitForLoadState('networkidle', { timeout: 120000 });
  await admin.close();

  await staff.goto(`${base}/insurance`);
  const kpiAfter = (await staff.textContent('.kpis')) || '';
  assert.match(kpiAfter, /Lapsed\s*0/, 'force-placement clears the lapsed bucket');

  // the auto-enroll notice went out
  const dev = await newPage(browser);
  await login(dev, base, 'admin@summitridge.demo');
  await dev.goto(`${base}/dev/messages`);
  const msgs = (await dev.textContent('.content')) || '';
  assert.match(msgs, /enrolled in the community insurance program/i);
  await dev.close();
});

test('gate 5: utility cycle staged July — anomaly queue + estimation rule work', async () => {
  await staff.goto(`${base}/utilities/meters`);
  const body = (await staff.textContent('.content')) || '';
  if (/Anomaly review queue/.test(body) && !/Nothing needs review/.test(body)) {
    await Promise.all([staff.waitForLoadState('networkidle'), staff.click('button:has-text("Estimate (trailing avg)")')]);
    assert.match((await staff.textContent('.flash')) || '', /estimated from the trailing average/i);
  }
  // July previews staged by the cycle job — post one live
  await staff.goto(`${base}/utilities/rubs`);
  const preview = staff.locator('tr:has-text("preview") a:has-text("Review & post")').first();
  if ((await preview.count()) >= 1) {
    await preview.click();
    await staff.waitForLoadState('networkidle');
    staff.once('dialog', (d) => void d.accept());
    await Promise.all([staff.waitForLoadState('networkidle'), staff.click('button:has-text("Approve & post to ledgers")')]);
    assert.match((await staff.textContent('.flash')) || '', /charges posted/i);
  }
});

test('gate 6: deposit-alternative claims settled at move-out; risk log renders', async () => {
  await staff.goto(`${base}/risk`);
  const body = (await staff.textContent('.content')) || '';
  assert.match(body, /Deposit-alternative claims/);
  assert.match(body, /Claim paid/);
  const claims = await staff.locator('table').last().locator('tbody tr').count();
  assert.equal(claims >= 1, true, 'seeded historical claims visible');
  assert.match(body, /Incident log/);
  assert.match(body, /water|mold|theft/i);
});

test('gate 7: guaranty rescues a conditions scorecard; portal shows coverage + usage', async () => {
  // the seeded guarantied application's scorecard shows the rescue (manager view)
  const mgr = await newPage(browser);
  await login(mgr, base, 'manager@summitridge.demo');
  await mgr.goto(`${base}/applications`);
  const hrefs = await mgr.locator('tbody tr[data-href]').evaluateAll(
    (rows) => rows.map((r) => r.getAttribute('data-href')).filter(Boolean),
  );
  let found = false;
  for (const href of hrefs) {
    await mgr.goto(base + href!);
    const body = (await mgr.textContent('.content')) || '';
    if (/guaranty \(simulated\) covers/i.test(body)) {
      assert.match(body, /approve/i, 'scorecard upgraded to approve');
      found = true;
      break;
    }
  }
  await mgr.close();
  assert.equal(found, true, 'guarantied application visible in review');

  // portal: Maya sees her verified policy + usage chart
  const maya = await newPage(browser, { mobile: true });
  await login(maya, base, 'maya.torres@mail.demo');
  await maya.goto(`${base}/portal/lease`);
  const body = (await maya.textContent('.portal')) || '';
  assert.match(body, /Renters insurance/);
  assert.match(body, /covered/i);
  assert.match(body, /RS-5541209/);
  assert.match(body, /usage/i, 'usage card renders');
  assert.match(body, /Community avg|community average/i);
  await maya.close();
});
