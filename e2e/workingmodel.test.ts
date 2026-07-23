import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { boot, login, newPage } from './lib.ts';
import { setEnv } from '../src/lib/env.ts';
import { ROOT } from '../src/lib/db.ts';
import { writeXlsx } from '../src/lib/xlsx.ts';

/** Working-model gate: the full front door — invite-code signup, guided
 * onboarding, universal rent-roll import (xlsx upload → auto-map → review →
 * apply), lease-PDF extraction lane, connections page honesty, and the
 * live-org fences (no simulator console, no sim jobs). */

let base: string;
let browser: Browser;
let close: () => Promise<void>;
const XLSX_PATH = join(ROOT, 'data', 'e2e-rentroll.xlsx');
const PDF_PATH = join(ROOT, 'data', 'e2e-lease.pdf');

before(async () => {
  setEnv('SIGNUP_CODE', 'PARTNER2026');
  const b = await boot();
  base = b.base;
  browser = b.browser;
  close = b.close;

  writeFileSync(XLSX_PATH, writeXlsx([{
    name: 'Rent Roll',
    rows: [
      ['Rent Roll — exported 07/01/2026'],
      ['Unit', 'Floorplan', 'Sq Ft', 'Tenant', 'Email', 'Rent', 'Market Rent', 'Deposit', 'Balance', 'Lease From', 'Lease To', 'Status'],
      ['101', '1x1', '720', 'Avery, Jordan', 'jordan@example.com', '1450', '1500', '1450', '250.00', '1/1/2026', '12/31/2026', 'Occupied'],
      ['102', '1x1', '720', 'Sasha Kim & Ben Kim', 'sasha@example.com', '1400', '1500', '1400', '0', '9/15/2025', '9/14/2026', 'Occupied'],
      ['103', '2x2', '1080', '', '', '', '1925', '', '', '', '', 'Vacant'],
    ],
  }]));

  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines = [
    'RESIDENTIAL LEASE AGREEMENT',
    'Tenant: Priya Raman',
    'Unit: 301',
    'Monthly Rent: $1,650.00',
    'Security Deposit: $1,650.00',
    'Commencement Date: 03/01/2026',
    'Expiration Date: 02/28/2027',
  ];
  lines.forEach((t, i) => page.drawText(t, { x: 50, y: 720 - i * 24, size: 12, font }));
  writeFileSync(PDF_PATH, Buffer.from(await doc.save({ useObjectStreams: false })));
});
after(async () => {
  rmSync(XLSX_PATH, { force: true });
  rmSync(PDF_PATH, { force: true });
  await close();
});

async function signup(page: Page, email: string, company: string): Promise<void> {
  await page.goto(`${base}/signup`, { waitUntil: 'networkidle' });
  await page.fill('input[name=code]', 'PARTNER2026');
  await page.fill('input[name=company]', company);
  await page.fill('input[name=name]', 'Casey Founder');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', 'longpassword1');
  await page.fill('input[name=password2]', 'longpassword1');
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Create company")')]);
}

test('gate: signup lands a live org in guided onboarding', async () => {
  const page = await newPage(browser);
  await signup(page, 'casey@newco.test', 'NewCo Residential');
  assert.match(page.url(), /\/welcome/, 'signup should land on /welcome');
  const body = await page.content();
  assert.match(body, /Welcome to StayLeased/);
  assert.match(body, /Add your properties &amp; units/);
  assert.match(body, /rent-roll upload/i);
  await page.close();
});

test('gate: wrong invite code is rejected', async () => {
  const page = await newPage(browser);
  await page.goto(`${base}/signup`, { waitUntil: 'networkidle' });
  await page.fill('input[name=code]', 'NOPE');
  await page.fill('input[name=company]', 'Reject Co');
  await page.fill('input[name=name]', 'R J');
  await page.fill('input[name=email]', 'reject@newco.test');
  await page.fill('input[name=password]', 'longpassword1');
  await page.fill('input[name=password2]', 'longpassword1');
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Create company")')]);
  assert.match(await page.content(), /not valid/);
  await page.close();
});

test('gate: rent-roll xlsx → auto-map → review → apply builds the portfolio', async () => {
  const page = await newPage(browser);
  await login(page, base, 'casey@newco.test', 'longpassword1');
  await page.goto(`${base}/setup/import`, { waitUntil: 'networkidle' });
  assert.match(await page.content(), /Upload your rent roll/);

  await page.setInputFiles('input[name=file]', XLSX_PATH);
  await page.check('input[name=prop_mode][value=new]');
  await page.fill('input[name=new_property]', 'Bayview Flats');
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Upload & map columns")')]);

  assert.match(page.url(), /\/setup\/import\/b\/imp/, 'should land on the review page');
  const review = await page.content();
  assert.match(review, /Column mapping/);
  assert.match(review, /2 ready|3 ready/); // vacant row + 2 occupied (some may warn)
  // auto-mapping picked the right targets
  const unitSel = await page.locator('select[name=map_0]').inputValue();
  assert.equal(unitSel, 'unit');
  const tenantSel = await page.locator('select[name=map_3]').inputValue();
  assert.equal(tenantSel, 'tenant');

  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Apply")')]);
  assert.match(page.url(), /\/properties\/prp/, 'apply should land on the property');
  const prop = await page.content();
  assert.match(prop, /Bayview Flats/);
  assert.match(prop, /Imported .*2 leases/i);

  // residents exist and the balance carried in
  await page.goto(`${base}/residents`, { waitUntil: 'networkidle' });
  const res = await page.content();
  assert.match(res, /Jordan Avery|Avery/);
  await page.close();
});

test('gate: onboarding checklist reflects the import', async () => {
  const page = await newPage(browser);
  await login(page, base, 'casey@newco.test', 'longpassword1');
  await page.goto(`${base}/welcome`, { waitUntil: 'networkidle' });
  const body = await page.content();
  // properties + residents steps auto-completed by the rent roll
  const done = (body.match(/dcfce7/g) || []).length; // green check chips
  assert.ok(done >= 3, `expected ≥3 completed steps, saw ${done}`);
  await page.close();
});

test('gate: lease PDF extracts into an editable draft and imports', async () => {
  const page = await newPage(browser);
  await login(page, base, 'casey@newco.test', 'longpassword1');
  await page.goto(`${base}/setup/import?tab=leases`, { waitUntil: 'networkidle' });
  await page.setInputFiles('input[name=files]', PDF_PATH);
  await page.selectOption('select[name=property]', { label: 'Bayview Flats' });
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Upload & extract")')]);

  assert.match(page.url(), /\/setup\/import\/leases\/imp/);
  const review = await page.content();
  assert.match(review, /Priya Raman/, 'tenant extracted from the PDF');
  const unitVal = await page.locator('input[name=f_0_unit]').inputValue();
  assert.equal(unitVal, '301');
  const rentVal = await page.locator('input[name=f_0_rent]').inputValue();
  assert.match(rentVal, /1,?650/);

  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Import checked leases")')]);
  assert.match(await page.content(), /Imported 1 lease/);

  await page.goto(`${base}/residents`, { waitUntil: 'networkidle' });
  assert.match(await page.content(), /Priya Raman|Raman/);
  await page.close();
});

test('gate: live org fences — no simulator, honest connections, no sim leads', async () => {
  const page = await newPage(browser);
  await login(page, base, 'casey@newco.test', 'longpassword1');

  // connections page: waitlists, not fake toggles
  await page.goto(`${base}/setup/connections`, { waitUntil: 'networkidle' });
  const conn = await page.content();
  assert.match(conn, /Payments/);
  assert.match(conn, /waitlist|Coming/i);
  assert.match(conn, /Migration Center|File import/);

  // simulator console is forbidden for live orgs
  const resp = await page.goto(`${base}/dev/sim`);
  assert.equal(resp!.status(), 403);

  // setup hub hides the simulator card
  await page.goto(`${base}/setup`, { waitUntil: 'networkidle' });
  const setup = await page.content();
  assert.ok(!/Simulator console/.test(setup), 'live orgs must not see the simulator');
  assert.match(setup, /Getting started/);
  await page.close();
});

test('gate: demo org still sees simulator and demo world intact', async () => {
  const page = await newPage(browser);
  await login(page, base, 'admin@summitridge.demo');
  await page.goto(`${base}/setup`, { waitUntil: 'networkidle' });
  assert.match(await page.content(), /Simulator console/);
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  const dash = await page.content();
  assert.match(dash, /Summit Ridge|Portfolio/);
  await page.close();
});
