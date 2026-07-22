import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import type { Browser, Page } from 'playwright';

/** Phase 6 gate: simulated lead arrives on date advance → dedupes into a
 * guest card; cadence tasks appear; agent books a tour + builds a quote;
 * funnel report reflects it; Leasing Center works across properties. */

let base: string;
let browser: Browser;
let close: () => Promise<void>;
let page: Page;

before(async () => {
  const b = await boot();
  base = b.base;
  browser = b.browser;
  close = b.close;
  page = await newPage(browser);
  await login(page, base, 'agent@summitridge.demo');
});

after(async () => close());

test('lead inbox renders with cadence + exposure flags', async () => {
  await page.goto(`${base}/leads`);
  const rows = await page.locator('tbody tr[data-href]').count();
  assert.equal(rows > 10, true, 'seeded leads visible');
  // overdue filter
  await page.goto(`${base}/leads?filter=overdue`);
  assert.match((await page.textContent('.content')) || '', /overdue|No leads match/i);
});

test('GATE: duplicate inquiry dedupes into the existing guest card', async () => {
  const mgr = await newPage(browser);
  await login(mgr, base, 'manager2@summitridge.demo'); // Foundry manager (Alicia's property)
  await mgr.goto(`${base}/leads/new`);
  await mgr.fill('input[name=first_name]', 'Alicia');
  await mgr.fill('input[name=last_name]', 'Nguyen');
  await mgr.fill('input[name=email]', 'alicia.nguyen@inbox.demo');
  await Promise.all([mgr.waitForLoadState('networkidle'), mgr.click('button:has-text("Create guest card")')]);
  assert.match((await mgr.textContent('.flash')) || '', /Matched an existing guest card/);
  // the timeline shows the deduped inquiry
  assert.match((await mgr.textContent('.content')) || '', /deduped into this guest card/);
  await mgr.close();
});

test('GATE: agent books a tour and builds a quote from the guest card', async () => {
  // open Alicia via search
  const mgr = await newPage(browser);
  await login(mgr, base, 'regional@summitridge.demo');
  const res = await mgr.evaluate(async () => (await fetch('/search.json?q=Alicia Nguyen')).json());
  const hit = (res as any).results.find((x: any) => x.kind === 'lead');
  assert.ok(hit, 'Alicia findable in ⌘K search');
  await mgr.goto(base + hit.href);
  const before = (await mgr.textContent('.content')) || '';
  assert.match(before, /Tour completed|tour booked/i); // existing history
  assert.match(before, /Follow-up cadence/);
  // book another tour
  await Promise.all([mgr.waitForLoadState('networkidle'), mgr.click('button:has-text("Book tour + send confirmation")')]);
  assert.match((await mgr.textContent('.flash')) || '', /Tour booked/);
  // build a quote
  await Promise.all([mgr.waitForLoadState('networkidle'), mgr.click('button:has-text("Build + email quote")')]);
  assert.match((await mgr.textContent('.flash')) || '', /Quote built/);
  const after2 = (await mgr.textContent('.content')) || '';
  assert.match(after2, /Quote: unit/);
  await mgr.close();
});

test('GATE: ILS feed delivers new leads on date advance', async () => {
  const admin = await newPage(browser);
  await login(admin, base, 'admin@summitridge.demo');
  const countLeads = async (): Promise<number> => {
    const r = await admin.evaluate(async () => (await fetch('/api-none')).status).catch(() => 0);
    await admin.goto(`${base}/leads?status=new`);
    const t = (await admin.textContent('.pager')) || (await admin.textContent('.content')) || '';
    const m = /(\d+) records/.exec(t);
    return m ? parseInt(m[1]!, 10) : (await admin.locator('tbody tr[data-href]').count());
  };
  const beforeN = await countLeads();
  await admin.goto(`${base}/dev/sim`);
  await admin.click('button[value="1"]');
  await admin.waitForLoadState('networkidle');
  const afterN = await countLeads();
  assert.equal(afterN > beforeN, true, `expected new ILS leads (${beforeN} → ${afterN})`);
  await admin.close();
});

test('GATE: Leasing Center queue spans properties + round-robin assigns', async () => {
  await page.goto(`${base}/leasing-center`);
  const content = (await page.textContent('.content')) || '';
  assert.match(content, /Needs a touch today/);
  // spans at least two properties
  const propsSeen = ['Summit Ridge', 'Foundry', 'Cardinal'].filter((p) => content.includes(p));
  assert.equal(propsSeen.length >= 2, true, `cross-property queue (saw: ${propsSeen.join(', ')})`);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Round-robin assign")')]);
  assert.match((await page.textContent('.flash')) || '', /distributed among leasing agents/);
});

test('GATE: funnel analytics reflect the pipeline', async () => {
  await page.goto(`${base}/leasing/analytics`);
  const content = (await page.textContent('.content')) || '';
  assert.match(content, /Inquiries/);
  assert.match(content, /zillow/i);
  assert.match(content, /Agent leaderboard/);
  const svgOk = (await page.locator('.chart').count()) >= 1;
  assert.equal(svgOk, true, 'funnel chart renders');
});

test('tours page groups by day with outcomes', async () => {
  await page.goto(`${base}/tours`);
  const content = (await page.textContent('.content')) || '';
  assert.match(content, /Recent outcomes|No upcoming tours/);
});
