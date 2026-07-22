import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import type { Browser, Page } from 'playwright';

/** THE PHASE 14 GATE — the pricing queue explains each recommendation's
 * factors; accepting/overriding changes updates quotes and the public website
 * instantly; the renewal batch respects org caps; expiration smoothing
 * visibly steers term pricing. */

let base: string;
let browser: Browser;
let close: () => Promise<void>;
let staff: Page; // regional manager (pricing:*)

let sr: string; // Summit Ridge id
let target: any; // the pending rec we override
let overrideCents = 0;
let planName = '';

before(async () => {
  const b = await boot();
  base = b.base;
  browser = b.browser;
  close = b.close;
  staff = await newPage(browser);
  await login(staff, base, 'regional@summitridge.demo');
  const { q1 } = await import('../src/lib/db.ts');
  sr = q1<any>(`SELECT id FROM properties WHERE slug='summit-ridge'`).id;
});

after(async () => close());

test('gate: the queue explains every recommendation with its factor math', async () => {
  await staff.goto(`${base}/pricing?property=${sr}`);
  const body = (await staff.textContent('.content')) || '';
  assert.match(body, /Awaiting review/);
  assert.match(body, /Why the engine suggests this/, 'per-rec explanation section');
  assert.match(body, /exposure \d+% (above|below|far above) 7% target|peak leasing season|comp set avg|vacant \d+ days/, 'named factors with numbers');
  // every card shows both the current and recommended number
  assert.match(body, /Current asking/);
  assert.match(body, /Recommended/);

  // the factor deltas on screen fully explain a real pending rec
  const { q1, j } = await import('../src/lib/db.ts');
  const rec = q1<any>(
    `SELECT pr.* FROM price_recommendations pr JOIN units u ON u.id=pr.unit_id
     WHERE pr.property_id=? AND pr.status='pending' AND pr.term_months=12 AND u.status='vacant_ready'
     ORDER BY u.unit_number LIMIT 1`, sr,
  );
  assert.ok(rec, 'a pending rec on a vacant-ready unit exists');
  const factors = j<any[]>(rec.factors, []);
  const sum = factors.reduce((s, f) => s + f.delta_cents, 0);
  assert.equal(Math.round((rec.current_rent_cents + sum) / 500) * 500, rec.recommended_rent_cents, 'factors sum to the recommendation');
  target = rec;
});

test('gate: overriding with a reason updates the public website instantly', async () => {
  const { q1 } = await import('../src/lib/db.ts');
  const fp = q1<any>(
    `SELECT f.id, f.name, (SELECT MIN(u.market_rent_cents) FROM units u WHERE u.floorplan_id=f.id AND u.status='vacant_ready') AS starting
     FROM floorplans f JOIN units un ON un.floorplan_id=f.id WHERE un.id=?`, target.unit_id,
  );
  planName = fp.name;
  overrideCents = fp.starting - 10000; // clearly the new cheapest unit of the plan
  const { usd } = await import('../src/lib/money.ts');

  // the site shows the old floor price before the decision
  const beforeRes = await staff.request.get(`${base}/p/summit-ridge`);
  const beforeSite = await beforeRes.text();
  assert.ok(beforeSite.includes(`from ${usd(fp.starting)}/mo`), `site quotes the pre-decision floor ${usd(fp.starting)}`);

  // override in the queue (reason required)
  await staff.goto(`${base}/pricing?property=${sr}`);
  const form = staff.locator(`form[action*="${target.id}"]:has(input[name=amount])`);
  await form.locator('input[name=amount]').fill((overrideCents / 100).toFixed(2));
  await form.locator('input[name=reason]').fill('Price to lead the plan — corner unit faces the courtyard');
  await Promise.all([staff.waitForLoadState('networkidle'), form.locator('button:has-text("Override")').click()]);
  assert.match((await staff.textContent('.flash')) || '', /Overridden — your amount is now the asking rent/);

  // website reflects it with zero delay
  const afterRes = await staff.request.get(`${base}/p/summit-ridge`);
  const site = await afterRes.text();
  assert.ok(site.includes(`from ${usd(overrideCents)}/mo`), `public "from" price moved to ${usd(overrideCents)}`);
  // and the change history records who/why
  await staff.goto(`${base}/pricing/changes`);
  const hist = (await staff.textContent('.content')) || '';
  assert.match(hist, /corner unit faces the courtyard/);
  assert.match(hist, /Marcus Bell/);
});

test('gate: a new CRM quote for that unit picks the price up instantly', async () => {
  const { q1 } = await import('../src/lib/db.ts');
  const { usd } = await import('../src/lib/money.ts');
  const lead = q1<any>(
    `SELECT l.id FROM leads l WHERE l.property_id=? AND l.status NOT IN ('lost','leased') ORDER BY l.created_at DESC LIMIT 1`, sr,
  );
  await staff.goto(`${base}/leads/${lead.id}`);
  await staff.selectOption('form[action*="/quote"] select[name=unit_id]', target.unit_id);
  await staff.selectOption('form[action*="/quote"] select[name=term_months]', '12');
  await Promise.all([staff.waitForLoadState('networkidle'), staff.click('button:has-text("Build + email quote")')]);
  assert.match((await staff.textContent('.flash')) || '', /Quote built/);
  const page = (await staff.textContent('.content')) || '';
  assert.ok(page.includes(usd(overrideCents)), `quote table shows ${usd(overrideCents)}`);
});

test('gate: accepting a recommendation moves the asking rent everywhere', async () => {
  const { q1 } = await import('../src/lib/db.ts');
  const rec = q1<any>(
    `SELECT pr.* FROM price_recommendations pr WHERE pr.property_id=? AND pr.status='pending' AND pr.term_months=12
     AND pr.unit_id != ? ORDER BY pr.unit_id LIMIT 1`, sr, target.unit_id,
  );
  assert.ok(rec, 'another pending rec remains');
  await staff.goto(`${base}/pricing?property=${sr}`);
  const acceptForm = staff.locator(`form[action*="${rec.id}"]:has(input[name=action][value=accept])`);
  await Promise.all([staff.waitForLoadState('networkidle'), acceptForm.locator('button').click()]);
  assert.match((await staff.textContent('.flash')) || '', /Accepted — asking rent updated everywhere/);
  const unit = q1<any>('SELECT market_rent_cents FROM units WHERE id=?', rec.unit_id);
  assert.equal(unit.market_rent_cents, rec.recommended_rent_cents);
});

test('gate: renewal batch (run live at Foundry) respects the org cap on every term', async () => {
  const { q1, q } = await import('../src/lib/db.ts');
  const foundry = q1<any>(`SELECT id FROM properties WHERE slug='foundry-lofts'`).id;
  await staff.goto(`${base}/pricing/renewals?property=${foundry}`);
  assert.match((await staff.textContent('.content')) || '', /No batch priced yet today/, 'Foundry left unpriced by seed');
  await Promise.all([staff.waitForLoadState('networkidle'), staff.click('button:has-text("Price expiring leases")')]);
  assert.match((await staff.textContent('.flash')) || '', /\d+ term rates staged — renewal offers now quote these prices/);

  const body = (await staff.textContent('.content')) || '';
  const pcts = [...body.matchAll(/\(([+-]\d+\.\d)%\)/g)].map((m) => Number(m[1]));
  assert.ok(pcts.length >= 8, `batch table shows per-term increases (${pcts.length})`);
  for (const p of pcts) assert.ok(p <= 8.05, `${p}% within the 8% org cap`);

  // DB-level: every accepted batch row within cap of the live lease rent
  const rows = q<any>(
    `SELECT pr.accepted_rent_cents, pr.term_months, l.rent_cents FROM price_recommendations pr
     JOIN leases l ON l.unit_id=pr.unit_id AND l.status='active'
     WHERE pr.property_id=? AND pr.decided_by='renewal batch'`, foundry,
  );
  assert.ok(rows.length >= 8);
  for (const r of rows) {
    assert.ok(r.accepted_rent_cents <= Math.round((r.rent_cents * 1.08) / 100) * 100, `${r.term_months}mo within 8%`);
    assert.ok(r.accepted_rent_cents >= r.rent_cents, 'never below current rent');
  }
});

test('gate: expiration smoothing visibly steers term pricing', async () => {
  const { q1 } = await import('../src/lib/db.ts');
  const foundry = q1<any>(`SELECT id FROM properties WHERE slug='foundry-lofts'`).id;
  await staff.goto(`${base}/pricing/terms?property=${foundry}`);
  const body = (await staff.textContent('.content')) || '';
  assert.match(body, /Expiration calendar/, 'calendar renders');
  assert.match(body, /high \(\d+ leases\)/, 'heavy months flagged on the matrix');
  assert.match(body, /low \(\d+ leases\)/, 'light months flagged on the matrix');

  // the steer matches the engine: page rent for a high month = service matrix rent
  const { termRateMatrix } = await import('../src/modules/m13_pricing/service.ts');
  const { sysCtx } = await import('../src/lib/auth.ts');
  const { usd } = await import('../src/lib/money.ts');
  const orgId = q1<any>('SELECT id FROM orgs').id;
  // replicate the page's default unit pick exactly
  const unitId = q1<any>(
    `SELECT u.id FROM units u WHERE u.property_id=? AND (u.status LIKE 'vacant%' OR EXISTS (
       SELECT 1 FROM leases l WHERE l.unit_id=u.id AND l.status IN ('notice','active')))
     ORDER BY u.unit_number LIMIT 1`, foundry,
  ).id;
  const shownUnit = q1<any>('SELECT * FROM units WHERE id=?', unitId);
  const matrix = termRateMatrix(sysCtx(orgId), shownUnit, q1<any>('SELECT business_date FROM orgs').business_date);
  const high = matrix.find((t) => t.loadFactor === 'high');
  const low = matrix.find((t) => t.loadFactor === 'low');
  assert.ok(high && low, 'both load classes present in the matrix');
  assert.ok(body.includes(usd(high!.rent)), 'high-load term rate shown');
  assert.ok(body.includes(usd(low!.rent)), 'low-load term rate shown');
  // steering beats the pure term-length slope between these two rows
  const curve = (term: number): number =>
    term <= 6 ? 7 - (term - 2) * 0.8 : term <= 11 ? 2 - (term - 7) * 0.5 : term === 12 ? 0 : -0.5;
  assert.ok(
    high!.adj - curve(high!.term) > 0 && low!.adj - curve(low!.term) < 0,
    `premium on the heavy month (+${(high!.adj - curve(high!.term)).toFixed(1)}), discount on the light (${(low!.adj - curve(low!.term)).toFixed(1)})`,
  );
});
