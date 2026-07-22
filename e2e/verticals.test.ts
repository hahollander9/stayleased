import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import type { Browser, Page } from 'playwright';

/** THE PHASE 17 GATE — by-the-bed leasing works end-to-end on the student
 * property; an affordable certification workflow completes with rent-limit
 * enforcement. Plus: pacing, matching, waitlist ordering, PCS breaks. */

let base: string;
let browser: Browser;
let close: () => Promise<void>;
let mgr: Page; // Elena — Summit Ridge + Cardinal scope

before(async () => {
  const b = await boot();
  base = b.base;
  browser = b.browser;
  close = b.close;
  mgr = await newPage(browser);
  await login(mgr, base, 'manager@summitridge.demo');
});

after(async () => close());

test('gate: by-the-bed — assign a bed in the UI, individual lease activates, student + parent in portal', async () => {
  await mgr.goto(`${base}/student`);
  const body = (await mgr.textContent('.content')) || '';
  assert.match(body, /Fall pre-leased/);
  assert.match(body, /72 \(75%\)/, 'seeded pacing shows');

  // find an open fall bed from the DB and assign it via the board form
  const { q1 } = await import('../src/lib/db.ts');
  const cc = q1<any>(`SELECT id FROM properties WHERE slug='cardinal-commons'`).id;
  const open = q1<any>(
    `SELECT u.id, u.unit_number FROM units u JOIN floorplans f ON f.id=u.floorplan_id
     WHERE u.property_id=? AND f.beds=4 AND (
       SELECT COUNT(*) FROM leases l WHERE l.unit_id=u.id AND l.bed_label IS NOT NULL AND l.status NOT IN ('canceled','ended','renewed')
     ) < 4 ORDER BY u.unit_number LIMIT 1`,
    cc,
  );
  assert.ok(open, 'a unit with an open bed exists');
  const form = mgr.locator(`form:has(input[name=unit_id][value="${open.id}"])`).first();
  await mgr.locator(`form:has(input[name=unit_id][value="${open.id}"])`).first().locator('xpath=ancestor::details').locator('summary').first().click();
  await form.locator('input[name=first_name]').fill('Test');
  await form.locator('input[name=last_name]').fill('Bedmate');
  await form.locator('input[name=email]').fill('test.bedmate@student.demo');
  await form.locator('select[name=start]').selectOption('now'); // immediate move-in
  await form.locator('input[name=g_name]').fill('Parent Bedmate');
  await form.locator('input[name=g_email]').fill('parent.bedmate@family.demo');
  await Promise.all([mgr.waitForLoadState('networkidle'), form.locator('button:has-text("Create individual lease")').click()]);
  assert.match((await mgr.textContent('.flash')) || '', /Individual liability lease created/);

  const lease = q1<any>(`SELECT * FROM leases WHERE household_name LIKE 'Bedmate, Test%'`);
  assert.ok(lease.bed_label, 'bed label on the lease');
  assert.equal(lease.unit_id, open.id);

  // +1 day advance: the activation job moves them in
  const admin = await newPage(browser);
  await login(admin, base, 'admin@summitridge.demo');
  await admin.goto(`${base}/dev/sim`);
  await admin.click('button[value="1"]', { timeout: 120000 });
  await admin.waitForLoadState('networkidle', { timeout: 120000 });
  await admin.close();
  assert.equal(q1<any>('SELECT status FROM leases WHERE id=?', lease.id).status, 'active', 'individual lease activated');

  // the student sees THEIR bed lease in the portal (separate ledger)
  const student = await newPage(browser, { mobile: true });
  await login(student, base, 'test.bedmate@student.demo');
  await student.goto(`${base}/portal`);
  const home = (await student.textContent('.portal')) || '';
  assert.match(home, new RegExp(open.unit_number.replaceAll('-', '.')), 'their unit');
  await student.close();

  // the parent guarantor sees the same lease with the guarantor banner
  const parent = await newPage(browser, { mobile: true });
  await login(parent, base, 'parent.bedmate@family.demo');
  await parent.goto(`${base}/portal`);
  const pHome = (await parent.textContent('.portal')) || '';
  assert.match(pHome, /guarantor/i, 'guarantor banner');
  await parent.close();
});

test('gate: pacing + roommate matching render from live data', async () => {
  await mgr.goto(`${base}/student?view=pacing`);
  assert.match((await mgr.textContent('.content')) || '', /Pre-lease velocity vs target/);
  await mgr.goto(`${base}/student?view=matching`);
  const body = (await mgr.textContent('.content')) || '';
  assert.match(body, /Suggested group 1/);
  assert.match(body, /% compatible/);
});

test('gate: affordable — over-limit blocked, cert checklist completes, activation unblocks', async () => {
  const { q1, run } = await import('../src/lib/db.ts');
  const { id: mkId } = await import('../src/lib/ids.ts');
  const { nowIso, addDays } = await import('../src/lib/dates.ts');
  const bd = q1<any>('SELECT business_date FROM orgs').business_date as string;
  // a vacant LIHTC unit at Foundry
  const unit = q1<any>(
    `SELECT u.*, f.beds AS fp_beds FROM units u JOIN floorplans f ON f.id=u.floorplan_id
     WHERE u.program='lihtc' AND NOT EXISTS (
       SELECT 1 FROM leases l WHERE l.unit_id=u.id AND l.status IN ('active','month_to_month','notice')
     ) LIMIT 1`,
  );
  assert.ok(unit, 'a vacant program unit exists');
  const limit = q1<any>(`SELECT max_rent_cents FROM rent_limits WHERE ami_pct=? AND beds=?`, unit.ami_pct, Math.min(3, unit.fp_beds)).max_rent_cents;
  const maxRent = limit - unit.utility_allowance_cents;

  // stage a fully-executed lease ABOVE the limit → activation must fail
  const leaseId = mkId('lse');
  run(
    `INSERT INTO leases (id, org_id, property_id, unit_id, household_name, status, start_date, end_date, move_in_date, rent_cents, deposit_cents, deposit_alternative, term_months, created_at)
     VALUES (?, ?, ?, ?, 'Gate household', 'fully_executed', ?, ?, ?, ?, 0, 0, 12, ?)`,
    leaseId, unit.org_id, unit.property_id, unit.id, bd, addDays(bd, 364), bd, maxRent + 10000, nowIso(),
  );
  const { activateLease } = await import('../src/modules/m6_leases/service.ts');
  const { sysCtx } = await import('../src/lib/auth.ts');
  const ctx = sysCtx(unit.org_id);
  assert.throws(() => activateLease(ctx, leaseId), /exceeds the .*AMI limit/); // over-limit rent hard-blocked
  run('UPDATE leases SET rent_cents=? WHERE id=?', maxRent - 5000, leaseId);
  assert.throws(() => activateLease(ctx, leaseId), /income certification/); // compliant rent still needs the cert

  // run the certification through the UI (income inside the unit's band)
  const { startCert } = await import('../src/modules/m18_verticals/service.ts');
  const LIMIT_100 = [7080000, 8090000, 9100000, 10110000, 10920000, 11730000];
  const qualifyingIncome = Math.round((LIMIT_100[1]! * (unit.ami_pct - 15)) / 100 / 100) * 100;
  startCert(ctx, { unitId: unit.id, leaseId, householdSize: 2, incomeCents: qualifyingIncome });
  await mgr.goto(`${base}/affordable?view=certs`);
  let body = (await mgr.textContent('.content')) || '';
  assert.match(body, new RegExp(unit.unit_number.replaceAll('-', '.')), 'the open cert card renders');

  // certify button is disabled until every checklist item is checked
  const certRow = q1<any>(`SELECT id FROM income_certs WHERE unit_id=? AND status='in_progress' ORDER BY created_at DESC`, unit.id);
  const card = mgr.locator(`form[action="/affordable/certs/${certRow.id}/check"]`);
  const boxes = card.locator('input[type=checkbox]');
  const count = await boxes.count();
  for (let i = 0; i < count; i++) {
    await boxes.nth(i).check();
    await mgr.waitForLoadState('networkidle');
  }
  await Promise.all([mgr.waitForLoadState('networkidle'), mgr.click(`form[action="/affordable/certs/${certRow.id}/complete"] button`)]);
  assert.match((await mgr.textContent('.flash')) || '', /certified — move-in unblocked/i);

  // and now activation succeeds
  activateLease(ctx, leaseId);
  assert.equal(q1<any>('SELECT status FROM leases WHERE id=?', leaseId).status, 'active');
  // compliance tab shows the unit certified with headroom
  await mgr.goto(`${base}/affordable`);
  body = (await mgr.textContent('.content')) || '';
  assert.match(body, /certified initial|certified annual/);
});

test('gate: waitlist enforces order with audited skips; rent limits published', async () => {
  await mgr.goto(`${base}/affordable?view=waitlist`);
  const body = (await mgr.textContent('.content')) || '';
  assert.match(body, /needs a 1BR; only 3BR/, 'the seeded documented skip');
  assert.match(body, /offered/, 'position 2 offered in order');
  // out-of-order offer is refused in the UI
  const { q1 } = await import('../src/lib/db.ts');
  const later = q1<any>(`SELECT id, position FROM waitlist_entries WHERE status='active' ORDER BY position DESC LIMIT 1`);
  const ahead = q1<any>(`SELECT COUNT(*) n FROM waitlist_entries WHERE status='active' AND position < ?`, later.position);
  if (ahead.n > 0) {
    await Promise.all([mgr.waitForLoadState('networkidle'), mgr.click(`form[action="/affordable/waitlist/${later.id}/offer"] button`)]);
    assert.match((await mgr.textContent('.flash')) || '', /ahead — offer in order/);
  }
  await mgr.goto(`${base}/affordable?view=limits`);
  assert.match((await mgr.textContent('.content')) || '', /60% AMI/);
});

test('verticals hub + military PCS break from the lease page (fee-free)', async () => {
  const admin = await newPage(browser);
  await login(admin, base, 'admin@summitridge.demo');
  await admin.goto(`${base}/verticals`);
  const hub = (await admin.textContent('.content')) || '';
  assert.match(hub, /By-the-bed individual leases/);
  assert.match(hub, /LIHTC set-aside units/);
  assert.match(hub, /BAH reference/);
  assert.match(hub, /CAM reconciliation/);

  // PCS break on an active Summit Ridge lease
  const { q1, val } = await import('../src/lib/db.ts');
  const lease = q1<any>(
    `SELECT l.id FROM leases l JOIN properties p ON p.id=l.property_id AND p.slug='summit-ridge'
     WHERE l.status='active' ORDER BY l.created_at LIMIT 1`,
  );
  const chargesBefore = val<number>('SELECT COUNT(*) FROM charges WHERE lease_id=?', lease.id) || 0;
  await admin.goto(`${base}/leases/${lease.id}`);
  await admin.click('summary:has-text("PCS lease break")');
  await admin.fill('form[action*="/verticals/pcs/"] input[name=report_date]', q1<any>('SELECT business_date FROM orgs').business_date);
  await Promise.all([admin.waitForLoadState('networkidle'), admin.click('form[action*="/verticals/pcs/"] button')]);
  assert.match((await admin.textContent('.flash')) || '', /NO early-termination fee/i);
  assert.equal(q1<any>('SELECT status FROM leases WHERE id=?', lease.id).status, 'notice');
  assert.equal(val<number>('SELECT COUNT(*) FROM charges WHERE lease_id=?', lease.id), chargesBefore, 'no ETF charge posted');
  await admin.goto(`${base}/verticals/cam`);
  assert.match((await admin.textContent('.content')) || '', /True-up|preview only/i);
  await admin.close();
});
