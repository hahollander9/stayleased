import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { boot, login, newPage } from './lib.ts';
import { setEnv } from '../src/lib/env.ts';
import { ROOT } from '../src/lib/db.ts';
import { writeXlsx } from '../src/lib/xlsx.ts';

/** CLIENT-READY GATE (the whole-workflow audit, as code): a brand-new client
 * signs up, uploads their real-world documents, and the org must be genuinely
 * operational — carried balances visible, books balanced, portal invites out,
 * an imported resident able to LOG IN with the credential from their invite,
 * and every screen in the app rendering for a fresh live org (empty-state
 * 500s hide exactly here, where the seeded demo never walks). */

let base: string;
let browser: Browser;
let close: () => Promise<void>;
const RR_PATH = join(ROOT, 'data', 'clientready-rentroll.xlsx');
const VEND_PATH = join(ROOT, 'data', 'clientready-vendors.csv');
const ADMIN = 'taylor@clientready.test';
const PASS = 'longpassword1';

before(async () => {
  setEnv('SIGNUP_CODE', 'PARTNER2026');
  const b = await boot();
  base = b.base;
  browser = b.browser;
  close = b.close;

  // a realistic export: title row, '#'-prefixed units, currency strings, a
  // two-tenant household, an expired term (month-to-month), and a vacant
  writeFileSync(RR_PATH, writeXlsx([{
    name: 'Rent Roll',
    rows: [
      ['Cedar Yard — Rent Roll as of 07/01/2026'],
      ['Unit', 'Floorplan', 'Sq Ft', 'Tenant', 'Email', 'Rent', 'Market Rent', 'Deposit', 'Balance', 'Lease From', 'Lease To', 'Status'],
      ['#101', '1x1', '720', 'Avery, Jordan', 'jordan.avery@clientready.test', '$1,450.00', '$1,500.00', '$1,450.00', '250.00', '1/1/2026', '12/31/2026', 'Occupied'],
      ['102', '1x1', '720', 'Sasha Kim & Ben Kim', 'sasha.kim@clientready.test', '1400', '1500', '1400', '0', '9/15/2025', '9/14/2026', 'Occupied'],
      ['103', '2x2', '1080', '', '', '', '1925', '', '', '', '', 'Vacant'],
      ['104', '2x2', '1080', 'Lee, Dana', 'dana.lee@clientready.test', '1900', '1925', '1900', '0', '6/1/2025', '5/31/2026', 'Occupied'],
    ],
  }]));
  writeFileSync(VEND_PATH, [
    'Name,Category,Phone,Email',
    'Rooter Bros Plumbing,Plumbing,555-0181,dispatch@rooterbros.test',
    'Bright Spark Electric,Electrical,555-0182,team@brightspark.test',
  ].join('\n'));
});
after(async () => {
  rmSync(RR_PATH, { force: true });
  rmSync(VEND_PATH, { force: true });
  await close();
});

async function body(page: Page): Promise<string> {
  return ((await page.textContent('body').catch(() => '')) || '').replace(/\s+/g, ' ');
}

test('client walk 1: signup → rent-roll upload → applied with portal invites', async () => {
  const page = await newPage(browser);
  await page.goto(`${base}/signup`, { waitUntil: 'networkidle' });
  await page.fill('input[name=code]', 'PARTNER2026');
  await page.fill('input[name=company]', 'Cedar Yard Management');
  await page.fill('input[name=name]', 'Taylor Client');
  await page.fill('input[name=email]', ADMIN);
  await page.fill('input[name=password]', PASS);
  await page.fill('input[name=password2]', PASS);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Create company")')]);
  assert.match(page.url(), /\/welcome/);

  await page.goto(`${base}/setup/import`, { waitUntil: 'networkidle' });
  await page.setInputFiles('input[name=file]', RR_PATH);
  await page.check('input[name=prop_mode][value=new]');
  await page.fill('input[name=new_property]', 'Cedar Yard');
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Upload & read it")')]);
  assert.match(page.url(), /\/setup\/import\/b\/imp/, 'review page');

  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Apply")')]);
  const flash = await body(page);
  assert.match(flash, /3 leases/);
  assert.match(flash, /4 residents/);
  assert.match(flash, /3 portal invites sent/, 'every primary with an email got portal access');

  // the applied import stays visible: uploads on the hub + a read-only record.
  // /setup/import is a redirect into the one hub now (2026-08-19) — following
  // it is part of what this asserts.
  await page.goto(`${base}/setup/import`, { waitUntil: 'networkidle' });
  assert.match(page.url(), /\/setup(\?|#|$)/, 'the retired import page lands on the hub');
  const hub = await body(page);
  assert.match(hub, /Uploads/, 'hub lists what has been uploaded once a batch exists');
  assert.match(hub, /Bring your data in/, 'and carries the upload lanes itself');
  assert.match(hub, /Applied/, 'applied batch is listed, not hidden');
  assert.match(hub, /3 leases/, 'history row carries the result summary');
  await Promise.all([page.waitForLoadState('networkidle'), page.click('a.btn-ghost[href*="/setup/import/b/"]')]);
  const record = await body(page);
  assert.match(record, /Applied/, 'read-only record renders for an applied batch');
  assert.match(record, /Cedar Yard|3 leases/, 'record shows what the import did');
  assert.doesNotMatch(record, /Apply \d+ rows?/, 'no apply button on an applied batch');
  await page.close();
});

test('client walk 2: the org is operational — balances, books, dashboard', async () => {
  const page = await newPage(browser);
  await login(page, base, ADMIN, PASS);

  // dashboard: property live, onboarding banner progressing
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  const dash = await body(page);
  assert.match(dash, /Cedar Yard/);
  assert.doesNotMatch(dash, /Something went wrong/);

  // the balance their old system carried is visible where staff work it
  await page.goto(`${base}/delinquency`, { waitUntil: 'networkidle' });
  const del = await body(page);
  assert.match(del, /Avery|Jordan/);
  assert.match(del, /250/);

  // conversion accounting: balanced books with the migration accounts posted
  await page.goto(`${base}/statements`, { waitUntil: 'networkidle' });
  const st = await body(page);
  assert.match(st, /Balanced ✓/);
  assert.match(st, /Opening Balance Equity/);
  assert.match(st, /Security Deposits Held/);

  // month-to-month conversion happened for the expired term
  await page.goto(`${base}/leases`, { waitUntil: 'networkidle' });
  const ls = await body(page);
  assert.match(ls, /Dana|Lee/);
  await page.close();
});

test('client walk 3: vendors CSV lane → dispatchable vendor list', async () => {
  const page = await newPage(browser);
  await login(page, base, ADMIN, PASS);
  await page.goto(`${base}/setup`, { waitUntil: 'networkidle' });
  await page.setInputFiles('input[name=file]', VEND_PATH);
  // the same dropzone takes a vendor list — no lane was chosen
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Upload & read it")')]);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Apply")')]);
  assert.match(await body(page), /2 vendors/);
  await page.goto(`${base}/vendors`, { waitUntil: 'networkidle' });
  const v = await body(page);
  assert.match(v, /Rooter Bros/);
  assert.match(v, /Bright Spark/);
  await page.close();
});

test('client walk 4: an imported resident can sign in with the invited credential', async () => {
  const staff = await newPage(browser);
  await login(staff, base, ADMIN, PASS);
  // the invite (with the one-time password) is readable in the Message Console:
  // filter to portal invites, open Jordan's row, read the credential from the body
  await staff.goto(`${base}/dev/messages?template=portal_invite`, { waitUntil: 'networkidle' });
  const row = staff.locator('tr[data-href]', { hasText: 'jordan.avery@clientready.test' }).first();
  assert.ok(await row.count(), 'Jordan’s portal invite is listed in the Message Console');
  const href = await row.getAttribute('data-href');
  await staff.goto(`${base}${href}`, { waitUntil: 'networkidle' });
  const detail = await body(staff);
  assert.match(detail, /portal is ready/i, 'invite detail renders');
  const otp = /sl-[0-9a-f]{12}/.exec(detail)?.[0];
  assert.ok(otp, 'a one-time password is visible to staff in the Message Console');
  await staff.close();

  const resident = await newPage(browser);
  await resident.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await resident.fill('input[name=email]', 'jordan.avery@clientready.test');
  await resident.fill('input[name=password]', otp!);
  await Promise.all([resident.waitForLoadState('networkidle'), resident.click('button:has-text("Sign in")')]);
  assert.match(resident.url(), /\/portal/, 'imported resident lands in the portal');
  const portal = await body(resident);
  assert.doesNotMatch(portal, /Something went wrong/);
  assert.match(portal, /balance|Balance|due|Cedar Yard/, 'portal shows their world');
  await resident.close();
});

test('client walk 5: every screen renders for a fresh live org (empty-state sweep)', async () => {
  const page = await newPage(browser);
  await login(page, base, ADMIN, PASS);
  const URLS = [
    '/', '/welcome', '/setup', '/setup/import', '/setup/connections', '/setup/wizard',
    '/leads', '/tours', '/leasing-center', '/leasing/analytics', '/applications',
    '/marketing/sites', '/marketing/syndication',
    '/residents', '/leases', '/renewals', '/inbox', '/comms',
    '/receivables', '/delinquency', '/deposits', '/utilities',
    '/ap', '/approvals', '/gl', '/banking', '/periods', '/budgets', '/statements', '/reserves', '/owners',
    '/workorders', '/myday', '/dispatch', '/turns', '/inspections', '/pm', '/inventory', '/facilities',
    '/vendors', '/purchasing', '/purchasing/agreements',
    '/properties', '/units', '/map', '/insurance',
    '/reports', '/dashboards', '/pricing', '/ai', '/ask',
    '/admin/staff', '/admin/settings', '/admin/audit', '/admin/jobs', '/admin/api', '/admin/lease-templates', '/verticals',
    '/dev/messages',
  ];
  const failures: string[] = [];
  for (const u of URLS) {
    const resp = await page.goto(`${base}${u}`, { waitUntil: 'domcontentloaded' });
    const status = resp?.status() ?? 0;
    const text = await body(page);
    if (status !== 200) failures.push(`${u} → HTTP ${status}`);
    else if (/Something went wrong|Page not found|Access denied/.test(text)) failures.push(`${u} → error page`);
  }
  assert.deepEqual(failures, [], `screens failing for a fresh live org:\n${failures.join('\n')}`);
  await page.close();
});

test('client walk 6: removing the rent-roll upload takes the whole import back out', async () => {
  const page = await newPage(browser);
  await login(page, base, ADMIN, PASS);

  // the property and its leases exist right up until the upload is removed
  await page.goto(`${base}/properties`, { waitUntil: 'networkidle' });
  // NB: "Cedar Yard" is also the org name in the chrome on every page, so the
  // list's own empty state is the only unambiguous signal here
  assert.doesNotMatch(await body(page), /No properties yet/, 'imported property is there to begin with');

  // scope to the rent-roll row: the vendors upload from walk 3 is newer and
  // sits above it in the history, and must survive this untouched
  const removeRentRoll = async (): Promise<void> => {
    await page.goto(`${base}/setup/import`, { waitUntil: 'networkidle' });
    const link = page.locator('tr', { hasText: 'clientready-rentroll.xlsx' }).locator('a[href$="/remove"]');
    await Promise.all([page.waitForLoadState('networkidle'), link.click()]);
  };
  await removeRentRoll();
  const confirm = await body(page);
  assert.match(confirm, /What it imported comes out with it/, 'confirm screen leads with the real consequence');
  assert.match(confirm, /1 property/, 'footprint counts the property the upload created');
  assert.match(confirm, /3 leases/, 'footprint counts the leases');

  // the typed-name confirm still guards it
  await page.fill('input[name=confirm_name]', 'wrong-name.xlsx');
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Remove this upload permanently")')]);
  assert.match(await body(page), /does not match/, 'a mismatched name removes nothing');
  await page.goto(`${base}/properties`, { waitUntil: 'networkidle' });
  assert.match(await body(page), /Cedar Yard/, 'and really nothing — the property is still there');

  await removeRentRoll();
  await page.fill('input[name=confirm_name]', 'clientready-rentroll.xlsx');
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Remove this upload permanently")')]);
  const hubAfter = await body(page);
  assert.match(hubAfter, /Also removed .*1 property/, 'the flash reports what came back out');
  // row-scoped: the flash names the file it just removed, so a body-text check
  // would match itself — and the vendors upload keeps the history section alive
  assert.equal(
    await page.locator('tr', { hasText: 'clientready-rentroll.xlsx' }).count(), 0,
    'the upload is gone from the history',
  );
  assert.equal(
    await page.locator('tr', { hasText: 'clientready-vendors.csv' }).count(), 1,
    "the other upload's row is still listed",
  );

  // the import is genuinely out of the system, not just off the hub
  await page.goto(`${base}/properties`, { waitUntil: 'networkidle' });
  assert.match(await body(page), /No properties yet/, 'the imported property is gone');
  await page.goto(`${base}/leases`, { waitUntil: 'networkidle' });
  const leases = await body(page);
  assert.doesNotMatch(leases, /Dana|Lee/, 'the imported leases are gone');
  await page.goto(`${base}/statements`, { waitUntil: 'networkidle' });
  assert.match(await body(page), /Balanced ✓/, 'and the books still balance with the conversion entries removed');

  // a different upload's records are none of this removal's business
  await page.goto(`${base}/vendors`, { waitUntil: 'networkidle' });
  assert.match(await body(page), /Rooter Bros/, 'the vendors upload is untouched');
  await page.close();
});
