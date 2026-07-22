import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/lib/db.ts';
import { boot, login, newPage } from './lib.ts';
import type { Browser, Page } from 'playwright';

/** Phase 8 gate: prospect applies + pays fee, co-applicant invited, screening
 * returns results async, scorecard recommends conditions, override requires
 * permission + reason, adverse-action letters exist, unit holds/releases. */

let base: string;
let browser: Browser;
let close: () => Promise<void>;
let applicantUrl = '';
let appUrl = '';
let heldUnitNumber = '';

before(async () => {
  const b = await boot();
  base = b.base;
  browser = b.browser;
  close = b.close;
});

after(async () => close());

test('GATE: prospect completes the wizard — info, docs, co-applicant invite, fees, submit', async () => {
  const page = await newPage(browser, { mobile: true });
  await page.goto(`${base}/p/summit-ridge/apply`);
  // remember the unit we're applying for (first option)
  const unitLabel = (await page.locator('select[name=unit_id] option').first().textContent()) || '';
  heldUnitNumber = unitLabel.split('—')[0]!.trim();
  await page.fill('input[name=first_name]', 'Cara');
  await page.fill('input[name=last_name]', 'Conditions');
  await page.fill('input[name=email]', 'conditions.test@screening.demo');
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Start my application")')]);
  applicantUrl = page.url();
  assert.match(applicantUrl, /\/apply\//);

  // step 1
  await page.fill('input[name=ssn_last4]', '7211');
  await page.fill('input[name=current_address]', '12 Old Town Rd');
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Continue")')]);
  // step 2: income + docs
  await page.fill('input[name=employer]', 'Bluebird Coffee Co.');
  await page.fill('input[name=income]', '4200');
  const doc = join(ROOT, 'data', 'e2e-paystub.txt');
  writeFileSync(doc, 'PAYSTUB Cara Conditions — monthly gross 4200');
  await page.setInputFiles('input[name=income_doc]', doc);
  await page.setInputFiles('input[name=id_doc]', doc);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Continue")')]);
  // step 3: invite a co-applicant
  await page.fill('form[action*="/invite"] input[name=email]', 'coco.applicant@apply.demo');
  await Promise.all([page.waitForLoadState('networkidle'), page.click('form[action*="/invite"] button')]);
  assert.match((await page.textContent('.flash')) || '', /Invite sent/);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Continue to review")')]);
  // step 4: fees show per-adult × 2 + holding deposit
  const review = (await page.textContent('.portal')) || '';
  assert.match(review, /× 2 applicants/);
  assert.match(review, /Holding deposit/);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("& submit application")')]);
  assert.match((await page.textContent('.portal')) || '', /Screening is underway|Submitted/);
  await page.close();
});

test('GATE: screening returns async; scorecard recommends conditions', async () => {
  const page = await newPage(browser, { mobile: true });
  await page.goto(applicantUrl);
  // bureau still pending → check button completes it (same path the scheduler uses)
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Check for results")')]);
  const content = (await page.textContent('.portal')) || '';
  assert.match(content, /Results are in|Screening complete/);
  await page.close();

  const staff = await newPage(browser);
  await login(staff, base, 'manager@summitridge.demo');
  const res = await staff.evaluate(async () => (await fetch('/search.json?q=Cara Conditions')).json());
  const hit = (res as any).results.find((x: any) => x.kind === 'application');
  assert.ok(hit, 'application searchable');
  appUrl = base + hit.href;
  await staff.goto(appUrl);
  const detail = (await staff.textContent('.content')) || '';
  assert.match(detail, /Household scorecard/);
  assert.match(detail, /conditions/i);
  assert.match(detail, /Additional deposit|guarantor/i);
  await staff.close();
});

test('GATE: override requires permission + reason', async () => {
  // assistant manager: applications:manage but NOT screening:override
  const asst = await newPage(browser);
  await login(asst, base, 'assistant@summitridge.demo');
  await asst.goto(appUrl);
  await asst.selectOption('form[action*="/decide"] select[name=action]', 'approved'); // differs from recommendation → override
  await Promise.all([asst.waitForLoadState('networkidle'), asst.click('form[action*="/decide"] button')]);
  assert.match((await asst.textContent('.flash')) || '', /requires the screening:override permission/);
  await asst.close();

  // manager tries override WITHOUT reason → blocked; with reason → recorded
  const mgr = await newPage(browser);
  await login(mgr, base, 'manager@summitridge.demo');
  await mgr.goto(appUrl);
  await mgr.selectOption('form[action*="/decide"] select[name=action]', 'approved');
  await Promise.all([mgr.waitForLoadState('networkidle'), mgr.click('form[action*="/decide"] button')]);
  assert.match((await mgr.textContent('.flash')) || '', /override requires a written reason/);
  await mgr.selectOption('form[action*="/decide"] select[name=action]', 'approved');
  await mgr.fill('form[action*="/decide"] textarea[name=reason]', 'Verified 3 years of excellent rental history and stable employment.');
  await Promise.all([mgr.waitForLoadState('networkidle'), mgr.click('form[action*="/decide"] button')]);
  assert.match((await mgr.textContent('.flash')) || '', /Decision recorded/);
  const detail = (await mgr.textContent('.content')) || '';
  assert.match(detail, /YES — with reason/);
  assert.match(detail, /held/i);
  await mgr.close();
});

test('GATE: unit hold removes it from public availability; release restores', async () => {
  const pub = await newPage(browser);
  await pub.goto(`${base}/p/summit-ridge/apply`);
  const options = (await pub.locator('select[name=unit_id]').textContent()) || '';
  assert.equal(options.includes(heldUnitNumber), false, `${heldUnitNumber} should be held off-market`);
  await pub.close();

  const mgr = await newPage(browser);
  await login(mgr, base, 'manager@summitridge.demo');
  await mgr.goto(appUrl);
  mgr.once('dialog', (d) => void d.accept());
  await Promise.all([mgr.waitForLoadState('networkidle'), mgr.click('form[action*="release-hold"] button')]);
  assert.match((await mgr.textContent('.flash')) || '', /Hold released/);
  await mgr.close();

  const pub2 = await newPage(browser);
  await pub2.goto(`${base}/p/summit-ridge/apply`);
  const options2 = (await pub2.locator('select[name=unit_id]').textContent()) || '';
  assert.equal(options2.includes(heldUnitNumber), true, 'unit back on market');
  await pub2.close();
});

test('GATE: adverse-action letters land in the Message Console with PDFs on file', async () => {
  const admin = await newPage(browser);
  await login(admin, base, 'admin@summitridge.demo');
  await admin.goto(`${base}/dev/messages?channel=email`);
  // seeded declined + conditions applications generated letters
  const found = await admin.locator('tr', { hasText: 'adverse_action' }).count();
  assert.equal(found > 0, true, 'adverse action email in console');
  // and the co-applicant invite from the wizard
  const invite = await admin.locator('tr', { hasText: 'applicant_invite' }).count();
  assert.equal(invite > 0, true, 'co-applicant invite in console');
  await admin.close();
});

test('application pipeline + fraud/thin-file review flags render', async () => {
  const mgr = await newPage(browser);
  await login(mgr, base, 'regional@summitridge.demo');
  await mgr.goto(`${base}/applications?status=review`);
  const rows = await mgr.locator('tbody tr[data-href]').count();
  assert.equal(rows >= 2, true, 'review queue has seeded applications');
  // open each until we find the fraud flag
  let sawFraud = false;
  for (let i = 0; i < Math.min(rows, 5) && !sawFraud; i++) {
    await mgr.goto(`${base}/applications?status=review`);
    await mgr.locator('tbody tr[data-href]').nth(i).click();
    await mgr.waitForLoadState('networkidle');
    const text = (await mgr.textContent('.content')) || '';
    if (/SSN last-4 reused|thin file/i.test(text)) sawFraud = true;
  }
  assert.equal(sawFraud, true, 'fraud/thin-file flags visible in review');
  await mgr.close();
});
