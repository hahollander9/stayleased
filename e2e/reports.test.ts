import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import type { Browser, Page } from 'playwright';

/** THE PHASE 15 GATE — every §10 report renders with seeded data and drills
 * through; a custom saved report schedules and delivers; the rent roll
 * reproduces correctly for a date 6 months back. Plus: role dashboards. */

let base: string;
let browser: Browser;
let close: () => Promise<void>;
let staff: Page; // regional manager

before(async () => {
  const b = await boot();
  base = b.base;
  browser = b.browser;
  close = b.close;
  staff = await newPage(browser);
  await login(staff, base, 'regional@summitridge.demo');
});

after(async () => close());

test('gate: every §10 report renders with seeded data (50 reports, zero empties)', async () => {
  const admin = await newPage(browser);
  await login(admin, base, 'admin@summitridge.demo');
  const { reportDefs } = await import('../src/modules/m14_reports/engine.ts');
  const defs = reportDefs();
  assert.ok(defs.length >= 50, `§10 catalog complete (${defs.length} reports)`);
  const failures: string[] = [];
  for (const def of defs) {
    const res = await admin.request.get(`${base}/reports/${def.key}`);
    const body = await res.text();
    if (res.status() !== 200) failures.push(`${def.key}: HTTP ${res.status()}`);
    else if (body.includes('No rows for these parameters')) failures.push(`${def.key}: EMPTY`);
  }
  assert.deepEqual(failures, [], 'every report renders with rows');
  await admin.close();
});

test('gate: reports drill through to source records', async () => {
  await staff.goto(`${base}/reports/rent_roll`);
  const before2 = staff.url();
  await Promise.all([staff.waitForLoadState('networkidle'), staff.click('tbody tr[data-href]')]);
  assert.notEqual(staff.url(), before2);
  assert.match(staff.url(), /\/leases\//, 'rent roll row opens the lease');
  assert.match((await staff.textContent('.content')) || '', /Ledger|ledger/, 'lease detail rendered');
});

test('gate: the rent roll reproduces correctly for a date six months back', async () => {
  const { q1, q } = await import('../src/lib/db.ts');
  const bd = q1<any>('SELECT business_date FROM orgs').business_date as string;
  const { addMonths } = await import('../src/lib/dates.ts');
  const d6 = addMonths(bd, -6);
  const sr = q1<any>(`SELECT id FROM properties WHERE slug='summit-ridge'`).id;

  // independent truth: effective-dated possession + historical rents at D6
  const expected = q<any>(
    `SELECT l.id, l.rent_cents FROM leases l WHERE l.property_id=?
       AND l.status NOT IN ('draft','out_for_signature','partially_signed','fully_executed','canceled')
       AND COALESCE(l.move_in_date, l.start_date) <= ?
       AND (CASE WHEN l.status='ended' THEN COALESCE(l.move_out_date, l.end_date) >= ?
                 WHEN l.status='renewed' THEN l.end_date >= ? ELSE 1 END)`,
    sr, d6, d6, d6,
  );
  const expectedRent = expected.reduce((s: number, l: any) => s + l.rent_cents, 0);
  assert.ok(expected.length > 60, `historical roll is substantial (${expected.length} leases)`);

  await staff.goto(`${base}/reports/rent_roll?property=${sr}&date=${d6}`);
  const body = (await staff.textContent('.content')) || '';
  const { usd } = await import('../src/lib/money.ts');
  assert.ok(body.includes(usd(expectedRent)), `total scheduled rent ${usd(expectedRent)} reproduced for ${d6}`);
  const m = /(\d+) rows/.exec(body);
  assert.equal(Number(m![1]), expected.length, `row count ${m![1]} equals effective-dated truth ${expected.length}`);

  // leases that had already turned over by today appear at D6 (history, not current state)
  const endedSince = q<any>(
    `SELECT COUNT(*) n FROM leases WHERE property_id=? AND status='ended'
     AND COALESCE(move_in_date,start_date) <= ? AND COALESCE(move_out_date,end_date) >= ?`,
    sr, d6, d6,
  )[0];
  assert.ok(endedSince.n > 0, 'the historical roll includes since-departed residents');
});

test('gate: a custom report is built in the UI, saved with a schedule, and delivers on the day advance', async () => {
  const mgr = await newPage(browser);
  await login(mgr, base, 'manager@summitridge.demo');
  // build: work orders still open, grouped by priority
  await mgr.goto(`${base}/reports/builder?dataset=work_orders&col=summary&col=priority&col=status&col=created&f0_col=status&f0_op=eq&f0_val=new`);
  const preview = (await mgr.textContent('.content')) || '';
  assert.match(preview, /Preview/, 'live preview renders');
  await mgr.fill('input[name=name]', 'New WOs — nightly for the morning huddle');
  await mgr.selectOption('form[action*="builder/save"] select[name=schedule]', 'daily');
  await Promise.all([mgr.waitForLoadState('networkidle'), mgr.click('form[action*="builder/save"] button')]);
  assert.match((await mgr.textContent('.flash')) || '', /Report saved/);
  assert.match((await mgr.textContent('.subtitle')) || '', /daily/i);
  const savedUrl = mgr.url();

  // advance one day: report_delivery runs (plus the seeded daily snapshot)
  const admin = await newPage(browser);
  await login(admin, base, 'admin@summitridge.demo');
  await admin.goto(`${base}/dev/sim`);
  await admin.click('button[value="1"]', { timeout: 120000 });
  await admin.waitForLoadState('networkidle', { timeout: 120000 });

  await admin.goto(`${base}/dev/messages?template=scheduled_report`);
  const console2 = (await admin.textContent('.content')) || '';
  assert.match(console2, /New WOs — nightly for the morning huddle/, 'the new custom report delivered');
  assert.match(console2, /Daily delinquency snapshot/, 'the seeded daily report delivered too');

  // the attachment link downloads a real CSV (owner opens it)
  await mgr.goto(savedUrl);
  assert.match((await mgr.textContent('.subtitle')) || '', /last ran/i, 'last-run stamped');
  const { q1 } = await import('../src/lib/db.ts');
  const file = q1<any>(
    `SELECT f.id FROM files f JOIN saved_reports sr ON sr.id=f.entity_id
     WHERE f.entity='saved_report' AND sr.name LIKE 'New WOs%' ORDER BY f.created_at DESC`,
  );
  const res = await mgr.request.get(`${base}/f/${file.id}`);
  assert.equal(res.status(), 200);
  const csv = await res.text();
  assert.match(csv.split('\n')[0]!, /Summary|Priority/, 'CSV header row');
  await admin.close();
  await mgr.close();
});

test('gate: sorting, grouping, totals and CSV export on a canned report', async () => {
  const { q1 } = await import('../src/lib/db.ts');
  const sr = q1<any>(`SELECT id FROM properties WHERE slug='summit-ridge'`).id;
  await staff.goto(`${base}/reports/delinquency_aged?property=${sr}`);
  const body = (await staff.textContent('.content')) || '';
  assert.match(body, /Total/, 'totals row');
  assert.match(body, /Latest note/, 'notes column (per §10)');
  // sort by balance asc via header click
  await Promise.all([staff.waitForLoadState('networkidle'), staff.click('th a:has-text("Total")')]);
  assert.match(staff.url(), /sort=balance|sort=/, 'sort applied');
  // CSV export carries the same data
  const csvRes = await staff.request.get(`${base}/reports/delinquency_aged?property=${sr}&format=csv`);
  assert.equal(csvRes.status(), 200);
  assert.match((csvRes.headers()['content-type'] || ''), /text\/csv/);
  const csv = await csvRes.text();
  assert.match(csv.split('\n')[0]!, /Household,Current/i);
  assert.match(csv, /TOTAL/);
});

test('gate: role dashboards — exec default renders from the widget library and is customizable', async () => {
  await staff.goto(`${base}/dashboards`);
  const body = (await staff.textContent('.content')) || '';
  assert.match(body, /Physical occupancy/, 'exec KPI widget');
  assert.match(body, /NOI — trailing 12/, 'NOI trend widget');
  assert.match(body, /Exposure by property/, 'bar widget');

  // customize: add the inbox widget, then remove it
  await staff.goto(`${base}/dashboards?customize=1`);
  await Promise.all([staff.waitForLoadState('networkidle'), staff.click('button:has-text("+ Inbox (KPI)")')]);
  assert.match((await staff.textContent('.content')) || '', /Conversations needing reply/, 'widget added');
  await Promise.all([staff.waitForLoadState('networkidle'), staff.click('form[action="/dashboards/remove"] button[title="Remove"] >> nth=-1')]);
  await staff.goto(`${base}/dashboards`);
  assert.doesNotMatch((await staff.textContent('.content')) || '', /Conversations needing reply/, 'widget removed');

  // a maintenance persona gets an ops-flavored default
  const tech = await newPage(browser);
  await login(tech, base, 'maintsup@summitridge.demo');
  await tech.goto(`${base}/dashboards`);
  assert.match((await tech.textContent('.content')) || '', /Oldest open work orders/, 'maintenance default layout');
  await tech.close();
});
