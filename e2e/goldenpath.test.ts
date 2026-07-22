import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import type { Browser, Page } from 'playwright';

/** THE PHASE 9 GATE — the full golden path:
 * lead → tour → quote → application → screening → lease → all parties sign →
 * move-in day advance → resident appears in portal with correct ledger;
 * then a renewal is offered, accepted, and re-signed. */

let base: string;
let browser: Browser;
let close: () => Promise<void>;
let staff: Page;
let applyUrl = '';
let leaseUrl = '';

before(async () => {
  const b = await boot();
  base = b.base;
  browser = b.browser;
  close = b.close;
  staff = await newPage(browser);
  await login(staff, base, 'manager@summitridge.demo');
});

after(async () => close());

test('golden path 1: lead → tour → quote', async () => {
  await staff.goto(`${base}/leads/new`);
  await staff.selectOption('select[name=property_id]', { label: 'Summit Ridge Apartments' });
  await staff.fill('input[name=first_name]', 'Golda');
  await staff.fill('input[name=last_name]', 'Path');
  await staff.fill('input[name=email]', 'approve.test@screening.demo');
  await staff.fill('input[name=phone]', '(555) 909-1000');
  await Promise.all([staff.waitForLoadState('networkidle'), staff.click('button:has-text("Create guest card")')]);
  assert.match((await staff.textContent('.flash')) || '', /Guest card created/);
  // tour
  await Promise.all([staff.waitForLoadState('networkidle'), staff.click('button:has-text("Book tour + send confirmation")')]);
  assert.match((await staff.textContent('.flash')) || '', /Tour booked/);
  await Promise.all([staff.waitForLoadState('networkidle'), staff.click('form[action*="/complete"] button:has-text("Completed")')]);
  // quote
  await Promise.all([staff.waitForLoadState('networkidle'), staff.click('button:has-text("Build + email quote")')]);
  assert.match((await staff.textContent('.flash')) || '', /Quote built/);
});

test('golden path 2: quote converts to application; applicant completes + pays + screens', async () => {
  await Promise.all([staff.waitForLoadState('networkidle'), staff.click('button:has-text("Start application")')]);
  const flash = (await staff.textContent('.flash')) || '';
  const m = /\/apply\/([a-f0-9]+)/.exec(flash);
  assert.ok(m, `applicant link in flash: ${flash}`);
  applyUrl = `${base}/apply/${m![1]}`;

  const applicant = await newPage(browser, { mobile: true });
  await applicant.goto(applyUrl);
  await applicant.fill('input[name=ssn_last4]', '4242');
  await applicant.fill('input[name=current_address]', '9 Golden Way');
  await Promise.all([applicant.waitForLoadState('networkidle'), applicant.click('button:has-text("Continue")')]);
  await applicant.fill('input[name=employer]', 'Prairie Software');
  const rentText = (await applicant.textContent('.portal')) || '';
  await applicant.fill('input[name=income]', '9000'); // comfortably 3x+
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { ROOT } = await import('../src/lib/db.ts');
  const doc = join(ROOT, 'data', 'golda-paystub.txt');
  writeFileSync(doc, 'PAYSTUB Golda Path monthly 9000');
  await applicant.setInputFiles('input[name=income_doc]', doc);
  await applicant.setInputFiles('input[name=id_doc]', doc);
  await Promise.all([applicant.waitForLoadState('networkidle'), applicant.click('button:has-text("Continue")')]);
  await Promise.all([applicant.waitForLoadState('networkidle'), applicant.click('button:has-text("Continue to review")')]);
  await Promise.all([applicant.waitForLoadState('networkidle'), applicant.click('button:has-text("& submit application")')]);
  assert.match((await applicant.textContent('.portal')) || '', /Screening is underway|Submitted/);
  await Promise.all([applicant.waitForLoadState('networkidle'), applicant.click('button:has-text("Check for results")')]);
  await applicant.close();
});

test('golden path 3: approve → generate lease → send for signature → everyone signs', async () => {
  const res = await staff.evaluate(async () => (await fetch('/search.json?q=Golda Path')).json());
  const hit = (res as any).results.find((x: any) => x.kind === 'application');
  assert.ok(hit);
  await staff.goto(base + hit.href);
  assert.match((await staff.textContent('.content')) || '', /Meets all property criteria/);
  await Promise.all([staff.waitForLoadState('networkidle'), staff.click('form[action*="/decide"] button')]);
  assert.match((await staff.textContent('.flash')) || '', /Decision recorded/);
  await Promise.all([staff.waitForLoadState('networkidle'), staff.click('button:has-text("Generate lease")')]);
  assert.match((await staff.textContent('.flash')) || '', /Lease drafted/);
  leaseUrl = staff.url().split('?')[0]!;
  await Promise.all([staff.waitForLoadState('networkidle'), staff.click('button:has-text("Send for signature")')]);
  assert.match((await staff.textContent('.flash')) || '', /Packet sent/);

  // collect signer links from the e-sign tab
  await staff.goto(`${leaseUrl}?tab=esign`);
  const links = await staff.locator('a:has-text("open signing page")').all();
  assert.equal(links.length >= 2, true, 'resident + countersigner links');
  const hrefs: string[] = [];
  for (const l of links) hrefs.push((await l.getAttribute('href'))!);

  // resident signs typed
  const signer = await newPage(browser, { mobile: true });
  await signer.goto(base + hrefs[0]!);
  assert.match((await signer.textContent('.portal')) || '', /Review the full packet/);
  await signer.check('input[name=agree]');
  await Promise.all([signer.waitForLoadState('networkidle'), signer.click('button:has-text("Sign the lease")')]);
  assert.match((await signer.textContent('.flash')) || '', /Signed — thank you/);

  // countersigner executes
  await signer.goto(base + hrefs[hrefs.length - 1]!);
  await signer.check('input[name=agree]');
  await Promise.all([signer.waitForLoadState('networkidle'), signer.click('button:has-text("Countersign & execute")')]);
  assert.match((await signer.textContent('.flash')) || '', /Fully executed/);
  await signer.close();

  await staff.goto(`${leaseUrl}?tab=esign`);
  const content = (await staff.textContent('.content')) || '';
  assert.match(content, /Executed packet \(signed\)/);
  assert.match(content, /Completion|completed/i);
});

test('golden path 4: move-in day advance → resident portal with correct ledger', async () => {
  // advance to the move-in date (+the lease activation job runs per day)
  await staff.goto(leaseUrl);
  const subtitle = (await staff.textContent('.subtitle')) || '';
  // activate via date advance: jump 30 days to be safely past move-in.
  // A month of simulated operations (rent run, autopay, settlements, late
  // fees, RUBS cycle, feeds, compliance) takes ~25-40s — allow for it.
  const admin = await newPage(browser);
  await login(admin, base, 'admin@summitridge.demo');
  await admin.goto(`${base}/dev/sim`);
  await admin.click('button[value="30"]', { timeout: 120000 });
  await admin.waitForLoadState('networkidle', { timeout: 120000 });
  await admin.close();

  await staff.goto(leaseUrl);
  assert.match((await staff.textContent('.subtitle')) || '', /active/);
  const ledgerText = (await staff.textContent('.content')) || '';
  assert.match(ledgerText, /Security deposit/);
  assert.match(ledgerText, /Rent — /);
  assert.match(ledgerText, /application holding deposit applied|CREDIT/i);

  // the new resident logs into the portal
  const portal = await newPage(browser, { mobile: true });
  await login(portal, base, 'approve.test@screening.demo');
  assert.match(portal.url(), /\/portal/);
  const home = (await portal.textContent('.portal')) || '';
  assert.match(home, /Hi Golda/);
  await portal.goto(`${base}/portal/lease`);
  const leasePage = (await portal.textContent('.portal')) || '';
  assert.match(leasePage, /Move-in checklist/);
  assert.match(leasePage, /lease-executed|Documents/i);
  await portal.close();
});

test('golden path 5: renewal offered → accepted in portal → re-signed', async () => {
  // Maya has a seeded offer
  const maya = await newPage(browser, { mobile: true });
  await login(maya, base, 'maya.torres@mail.demo');
  const home = (await maya.textContent('.portal')) || '';
  assert.match(home, /renewal offer is here/i);
  maya.once('dialog', (d) => void d.accept());
  await Promise.all([maya.waitForLoadState('networkidle'), maya.locator('form[action*="/portal/renewal"] button').first().click()]);
  assert.match((await maya.textContent('.flash')) || '', /Renewal accepted/);
  await maya.close();

  // packet builds async — find the renewal lease and sign it
  await new Promise((r) => setTimeout(r, 600));
  const res = await staff.evaluate(async () => (await fetch('/search.json?q=Torres')).json());
  const leaseHit = (res as any).results.find((x: any) => x.kind === 'resident');
  await staff.goto(`${base}/renewals`);
  assert.match((await staff.textContent('.content')) || '', /accepted/);
  // locate the new draft lease via leases list (status out_for_signature)
  await staff.goto(`${base}/leases?status=out_for_signature`);
  const row = staff.locator('tbody tr[data-href]', { hasText: 'Torres' }).first();
  assert.equal(await row.count() >= 1, true, 'renewal lease out for signature');
  await row.click();
  await staff.waitForLoadState('networkidle');
  const renewalLeaseUrl = staff.url().split('?')[0]!;
  await staff.goto(`${renewalLeaseUrl}?tab=esign`);
  const links = await staff.locator('a:has-text("open signing page")').all();
  const hrefs: string[] = [];
  for (const l of links) hrefs.push((await l.getAttribute('href'))!);
  const signer = await newPage(browser, { mobile: true });
  for (const href of hrefs) {
    await signer.goto(base + href);
    if ((await signer.locator('input[name=agree]').count()) === 0) continue;
    await signer.check('input[name=agree]');
    await Promise.all([signer.waitForLoadState('networkidle'), signer.click('button:has-text("Sign the lease"), button:has-text("Countersign & execute")')]);
  }
  await signer.close();
  // packet finalization is async — poll briefly
  let subtitle = '';
  for (let i = 0; i < 10; i++) {
    await staff.goto(renewalLeaseUrl);
    subtitle = (await staff.textContent('.subtitle')) || '';
    if (/fully executed/i.test(subtitle)) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  assert.match(subtitle, /fully executed/i);
});
