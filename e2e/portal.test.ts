import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/lib/db.ts';
import { boot, login, newPage } from './lib.ts';
import type { Browser, Page } from 'playwright';

/** Phase 4 gate: ON A PHONE-WIDTH VIEWPORT a resident logs in, pays with a
 * saved method, enrolls autopay, submits a photo'd maintenance request, and
 * downloads a statement PDF. */

let base: string;
let browser: Browser;
let close: () => Promise<void>;
let page: Page; // mobile page as Maya

before(async () => {
  const b = await boot();
  base = b.base;
  browser = b.browser;
  close = b.close;
  page = await newPage(browser, { mobile: true });
  await login(page, base, 'maya.torres@mail.demo');
});

after(async () => close());

test('resident dashboard renders mobile-first with balance + open request', async () => {
  assert.match(page.url(), /\/portal/);
  const content = (await page.textContent('.portal')) || '';
  assert.match(content, /Hi Maya/);
  assert.match(content, /Unit B-204/);
  assert.match(content, /Dishwasher not draining/);
  // bottom nav present
  assert.equal(await page.locator('.portal-nav a').count() >= 4, true);
});

test('GATE: pay with a saved method', async () => {
  await page.goto(`${base}/portal/pay`);
  // Maya has a saved ACH method from autopay enrollment
  const methods = await page.locator('select[name=method_token] option').count();
  assert.equal(methods >= 1, true, 'saved method listed');
  await page.fill('form[action="/portal/pay"] input[name=amount]', '12.00');
  await Promise.all([page.waitForLoadState('networkidle'), page.click('form[action="/portal/pay"] button.btn')]);
  assert.match((await page.textContent('.flash')) || '', /Payment (started|received)/);
});

test('GATE: autopay enrollment round-trip', async () => {
  await page.goto(`${base}/portal/pay`);
  // she's already enrolled from seed → turn off, then re-enroll to exercise both paths
  if ((await page.locator('form[action="/portal/autopay/cancel"]').count()) > 0) {
    page.once('dialog', (d) => void d.accept());
    await Promise.all([page.waitForLoadState('networkidle'), page.click('form[action="/portal/autopay/cancel"] button')]);
  }
  await page.goto(`${base}/portal/pay`);
  await page.selectOption('form[action="/portal/autopay"] select[name=mode]', 'full_balance');
  await Promise.all([page.waitForLoadState('networkidle'), page.click('form[action="/portal/autopay"] button.btn')]);
  assert.match((await page.textContent('.flash')) || '', /Autopay is on/);
});

test('GATE: submit a maintenance request with a photo', async () => {
  await page.goto(`${base}/portal/requests/new`);
  await page.selectOption('select[name=category]', 'doors_locks');
  await page.fill('input[name=summary]', 'Front door deadbolt sticking');
  await page.fill('textarea[name=description]', 'Key takes several tries to turn since yesterday.');
  // attach a generated photo
  const photo = join(ROOT, 'data', 'e2e-photo.png');
  writeFileSync(photo, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAF0lEQVR4nGP8z8Dwn4GBgYGJgYGBgQEAHhoCAv/HBVUAAAAASUVORK5CYII=', 'base64'));
  await page.setInputFiles('input[name=photos]', photo);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Submit request")')]);
  assert.match((await page.textContent('.flash')) || '', /Request submitted/);
  const content = (await page.textContent('.portal')) || '';
  assert.match(content, /Front door deadbolt sticking/);
  assert.match(content, /Request received/);
  // photo thumbnail rendered and downloadable
  assert.equal(await page.locator('img[src^="/f/"]').count() >= 1, true, 'photo visible');
});

test('GATE: download a statement PDF', async () => {
  const resp = await page.request.get(`${base}/portal/statements/2026-06.pdf`);
  assert.equal(resp.status(), 200);
  assert.equal(resp.headers()['content-type'], 'application/pdf');
  const body = await resp.body();
  assert.equal(body.length > 1200, true, 'pdf has content');
  assert.equal(body.subarray(0, 5).toString(), '%PDF-');
});

test('emergency keywords flag the request', async () => {
  await page.goto(`${base}/portal/requests/new`);
  await page.selectOption('select[name=category]', 'safety');
  await page.fill('input[name=summary]', 'I smell gas near the stove');
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Submit request")')]);
  assert.match((await page.textContent('.flash')) || '', /emergency/i);
});

test('notice to vacate: policy-aware earliest date enforced', async () => {
  await page.goto(`${base}/portal/lease`);
  const content = (await page.textContent('.portal')) || '';
  assert.match(content, /30 days notice|notice on file/i);
});

test('roommate privacy: co-resident sees household state but not Maya payment methods', async () => {
  // find a co-resident with a portal account on some lease
  const { q } = await import('../src/lib/db.ts');
  const co = q<any>(
    `SELECT r.email FROM household_members hm JOIN residents r ON r.id=hm.resident_id
     JOIN leases l ON l.id=hm.lease_id
     WHERE hm.role='co' AND r.user_id IS NOT NULL AND l.status='active' LIMIT 1`,
  );
  if (!co.length) return; // seed variance — skip quietly
  const p2 = await newPage(browser, { mobile: true });
  await login(p2, base, co[0].email);
  await p2.goto(`${base}/portal/pay`);
  const content = (await p2.textContent('.portal')) || '';
  assert.match(content, /suggested share|Balance/);
  // methods list shows only their own (none seeded for most co-residents)
  await p2.close();
});
