import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import type { Browser, Page } from 'playwright';

/** THE PHASE 16 GATE — at approve-to-send, Leasing AI drafts a grounded reply
 * to a simulated inquiry and books the tour on approval; Maintenance AI
 * triages an emergency correctly; call analysis produces summaries + tasks
 * from fixture transcripts; Ask StayLeased answers three cross-module questions
 * with correct live numbers; AI Activity shows every action. */

let base: string;
let browser: Browser;
let close: () => Promise<void>;
let mgr: Page; // manager: ai:view + ai:approve

before(async () => {
  const b = await boot();
  base = b.base;
  browser = b.browser;
  close = b.close;
  mgr = await newPage(browser);
  await login(mgr, base, 'manager@summitridge.demo');
});

after(async () => close());

test('gate: Leasing AI drafted a grounded reply for Alicia — approval sends it AND books the tour in M3', async () => {
  const { q1 } = await import('../src/lib/db.ts');
  const alicia = q1<any>(`SELECT * FROM leads WHERE email='alicia.nguyen@inbox.demo'`);
  const action = q1<any>(
    `SELECT * FROM ai_actions WHERE agent='leasing' AND entity_id=? AND status='proposed'`, alicia.id,
  );
  assert.ok(action, 'seeded inquiry is waiting at approve-to-send');

  await mgr.goto(`${base}/ai`);
  const queue = (await mgr.textContent('.content')) || '';
  assert.match(queue, /Alicia Nguyen/, 'her card is in the queue');
  assert.match(queue, /book tour/i, 'tour payload staged');

  // grounded: the draft quotes a REAL vacant-ready unit at her property + live pricing
  const { j } = await import('../src/lib/db.ts');
  const output = j<any>(action.output, {});
  const unitNo = /<b>([A-Z]-\d+)<\/b>/.exec(String(output.draft))?.[1];
  assert.ok(unitNo, 'draft names a unit');
  const unit = q1<any>(
    `SELECT u.* FROM units u WHERE u.unit_number=? AND u.property_id=? AND u.status='vacant_ready'`, unitNo, alicia.property_id,
  );
  assert.ok(unit, `unit ${unitNo} really is vacant-ready at her property`);
  assert.match(String(output.draft), /Pets are family/, 'pet policy grounded (she asked about her dog)');
  assert.match(String(output.draft), /\$\d/, 'real pricing quoted');

  // approve → executes: email + tour
  const form = mgr.locator(`form[action="/ai/${action.id}/approve"]`);
  await Promise.all([mgr.waitForLoadState('networkidle'), form.locator('button:has-text("Approve & execute")').click()]);
  assert.match((await mgr.textContent('.flash')) || '', /Approved and executed.*tour booked/i);
  const tour = q1<any>(`SELECT * FROM tours WHERE lead_id=? AND status='scheduled'`, alicia.id);
  assert.ok(tour, 'tour exists in M3');
  assert.equal(tour.date, output.tour.date);
  const sent = q1<any>(`SELECT * FROM outbox_messages WHERE person_id=? AND direction='out' AND subject LIKE 'Re: your%' ORDER BY created_at DESC`, alicia.id);
  assert.match(sent.body, new RegExp(unitNo!), 'the grounded reply landed in the console');
});

test('gate: a live simulated inquiry flows through the hook into the queue (approve-to-send)', async () => {
  const admin = await newPage(browser);
  await login(admin, base, 'admin@summitridge.demo');
  const { q1, val } = await import('../src/lib/db.ts');
  // a Summit Ridge lead with a backfilled thread
  const lead = q1<any>(
    `SELECT t.id AS thread_id, t.person_id FROM threads t
     JOIN leads l ON l.id=t.person_id AND l.property_id=(SELECT id FROM properties WHERE slug='summit-ridge')
     WHERE t.person_kind='lead' LIMIT 1`,
  );
  assert.ok(lead, 'a lead thread exists');
  const before2 = val<number>(`SELECT COUNT(*) FROM ai_actions WHERE agent='leasing'`) || 0;
  await admin.goto(`${base}/inbox/${lead.thread_id}`);
  await admin.fill('form[action*="simulate-reply"] textarea[name=body]', 'What is the rent on your cheapest place and could I tour tomorrow?');
  await Promise.all([admin.waitForLoadState('networkidle'), admin.click('form[action*="simulate-reply"] button')]);
  const after2 = val<number>(`SELECT COUNT(*) FROM ai_actions WHERE agent='leasing'`) || 0;
  assert.equal(after2, before2 + 1, 'the inbound hook staged a proposal');
  const newest = q1<any>(`SELECT * FROM ai_actions WHERE agent='leasing' ORDER BY created_at DESC`);
  assert.equal(newest.status, 'proposed', 'Summit Ridge dial is approve-to-send — nothing sent yet');
  await admin.close();
});

test('gate: Maintenance AI triages an emergency correctly (gas → emergency, unconditional escalation)', async () => {
  const maya = await newPage(browser, { mobile: true });
  await login(maya, base, 'maya.torres@mail.demo');
  await maya.goto(`${base}/portal/requests/new`);
  await maya.fill('input[name=summary]', 'I smell gas near the stove');
  await maya.fill('textarea[name=description]', 'Strong gas smell in the kitchen since this morning.');
  await Promise.all([maya.waitForLoadState('networkidle'), maya.click('button:has-text("Submit")')]);
  await maya.close();

  const { q1 } = await import('../src/lib/db.ts');
  const wo = q1<any>(`SELECT * FROM work_orders WHERE summary LIKE 'I smell gas%' ORDER BY created_at DESC`);
  assert.equal(wo.priority, 'emergency');
  const action = q1<any>(`SELECT * FROM ai_actions WHERE agent='maintenance' AND entity_id=?`, wo.id);
  assert.ok(action, 'triage proposal staged by the intake hook');
  assert.match(action.title, /emergency/i);
  assert.match(action.guardrail_note, /emergency keywords.*never optional/i);

  // approve applies the triage + audit note
  await mgr.goto(`${base}/ai`);
  const form = mgr.locator(`form[action="/ai/${action.id}/approve"]`);
  await Promise.all([mgr.waitForLoadState('networkidle'), form.locator('button:has-text("Approve & execute")').click()]);
  const events = q1<any>(`SELECT COUNT(*) n FROM wo_events WHERE work_order_id=? AND body LIKE 'AI triage%'`, wo.id);
  assert.equal(events.n, 1, 'AI triage note on the work order');
});

test('gate: call analysis produced summaries + real follow-up tasks from the fixture transcripts', async () => {
  const { val, q1 } = await import('../src/lib/db.ts');
  const total = val<number>(`SELECT COUNT(*) FROM call_logs WHERE transcript IS NOT NULL`) || 0;
  const analyzed = val<number>(`SELECT COUNT(*) FROM call_logs WHERE ai_summary IS NOT NULL`) || 0;
  assert.ok(total >= 30, `fixture corpus present (${total})`);
  assert.equal(analyzed, total, 'every transcript analyzed by seed');
  const tasks = val<number>(`SELECT COUNT(*) FROM followup_tasks WHERE kind LIKE 'ai:%'`) || 0;
  assert.ok(tasks > 0, 'action items became real follow-up tasks');

  await mgr.goto(`${base}/ai/calls`);
  const body = (await mgr.textContent('.content')) || '';
  assert.match(body, new RegExp(`${analyzed}/${total}`), 'rollup KPI matches');
  assert.match(body, /Sentiment mix/);
  const sample = q1<any>(`SELECT ai_summary FROM call_logs WHERE ai_summary IS NOT NULL ORDER BY at DESC LIMIT 1`);
  assert.ok(body.includes(String(sample.ai_summary).slice(0, 40)), 'a real summary renders');
});

test('gate: Ask StayLeased answers three cross-module questions with correct live numbers', async () => {
  // org-wide persona: property scoping is enforced (a scoped manager asking
  // about an out-of-scope property gets their own portfolio, by design)
  const reg = await newPage(browser);
  await login(reg, base, 'regional@summitridge.demo');
  const { q1 } = await import('../src/lib/db.ts');
  const { sysCtx } = await import('../src/lib/auth.ts');
  const { agingRows } = await import('../src/modules/m8_receivables/service.ts');
  const { computeDayMetrics } = await import('../src/modules/m14_reports/snapshots.ts');
  const { usd } = await import('../src/lib/money.ts');
  const orgId = q1<any>('SELECT id FROM orgs').id;
  const ctx = sysCtx(orgId);
  const sr = q1<any>(`SELECT id FROM properties WHERE slug='summit-ridge'`).id;
  const fl = q1<any>(`SELECT id FROM properties WHERE slug='foundry-lofts'`).id;

  // Q1: delinquency over $500 at Summit Ridge (receivables)
  const expect1 = agingRows(ctx, { propertyId: sr }).filter((a) => a.balance >= 50000);
  const total1 = expect1.reduce((s, a) => s + a.balance, 0);
  await reg.goto(`${base}/ask?q=${encodeURIComponent('delinquency over $500 at Summit Ridge')}`);
  let body = (await reg.textContent('.content')) || '';
  assert.ok(body.includes(`${expect1.length} household`), `count ${expect1.length} correct`);
  assert.ok(body.includes(usd(total1)), `total ${usd(total1)} correct`);

  // Q2: which units turn this month (operations)
  const mk = q1<any>('SELECT business_date FROM orgs').business_date.slice(0, 7);
  const expect2 = q1<any>(
    `SELECT COUNT(*) n FROM leases WHERE org_id=? AND substr(end_date,1,7)=? AND status IN ('active','notice')`, orgId, mk,
  ).n;
  await reg.goto(`${base}/ask?q=${encodeURIComponent('which units turn this month')}`);
  body = (await reg.textContent('.content')) || '';
  assert.ok(body.includes(`${expect2} lease`), `${expect2} expirations correct`);

  // Q3: occupancy at Foundry (portfolio)
  const m = computeDayMetrics(ctx, fl, ctx.businessDate);
  await reg.goto(`${base}/ask?q=${encodeURIComponent('occupancy at Foundry')}`);
  body = (await reg.textContent('.content')) || '';
  assert.ok(body.includes(`${m.occupancy_pct}%`), `occupancy ${m.occupancy_pct}% correct`);
  assert.ok(body.includes(`${m.occupied}`), 'occupied count shown');

  await reg.close();
  // every ask was itself logged
  const asks = q1<any>(`SELECT COUNT(*) n FROM ai_actions WHERE agent='ask'`);
  assert.ok(asks.n >= 5, 'asks audited (seeded 2 + these 3)');
});

test('gate: AI Activity shows every action; dials render with guardrails; autonomous history from Cardinal', async () => {
  const { val } = await import('../src/lib/db.ts');
  await mgr.goto(`${base}/ai?view=history`);
  const hist = (await mgr.textContent('.content')) || '';
  assert.match(hist, /auto executed|auto_executed/i, 'autonomous actions visible');
  assert.match(hist, /Leasing AI/);
  assert.match(hist, /Call Analysis/);
  // the Cardinal after-hours booking happened autonomously with audit
  assert.match(hist, /After-hours reply/, 'after-hours coverage demoed');
  const autoCount = val<number>(`SELECT COUNT(*) FROM ai_actions WHERE status='auto_executed'`) || 0;
  const kpis = (await mgr.textContent('.kpis')) || '';
  assert.ok(kpis.includes(String(autoCount)), 'KPI equals DB truth');

  await mgr.goto(`${base}/ai?view=dials`);
  const dials = (await mgr.textContent('.content')) || '';
  assert.match(dials, /Hard guardrails/);
  assert.match(dials, /never threatens/);
  assert.match(dials, /never commits below the approved matrix band/);

  // payments draft-only: approving marks reviewed without sending
  const { q1 } = await import('../src/lib/db.ts');
  const draftAction = q1<any>(`SELECT * FROM ai_actions WHERE agent='payments' AND status='proposed' AND autonomy='draft' LIMIT 1`);
  if (draftAction) {
    await mgr.goto(`${base}/ai?agent=payments`);
    const form = mgr.locator(`form[action="/ai/${draftAction.id}/approve"]`);
    await Promise.all([mgr.waitForLoadState('networkidle'), form.locator('button:has-text("Mark reviewed")').click()]);
    assert.match((await mgr.textContent('.flash')) || '', /reviewed — the draft is yours/i);
    assert.equal(q1<any>('SELECT status FROM ai_actions WHERE id=?', draftAction.id).status, 'approved');
  }
});
