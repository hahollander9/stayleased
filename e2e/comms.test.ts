import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, newPage } from './lib.ts';
import type { Browser, Page } from 'playwright';

/** THE PHASE 13 GATE — a mass message to "balance > $0 at one property"
 * previews the correct recipients, sends on schedule into the Message
 * Console, and an inbound simulated reply threads correctly; quiet hours and
 * opt-outs are enforced. */

let base: string;
let browser: Browser;
let close: () => Promise<void>;
let staff: Page; // manager (comms:*)
let massUrl = '';

before(async () => {
  const b = await boot();
  base = b.base;
  browser = b.browser;
  close = b.close;
  staff = await newPage(browser);
  await login(staff, base, 'manager@summitridge.demo');
});

after(async () => close());

test('inbox: unified threads with needs-reply, notes, calls and assignment', async () => {
  await staff.goto(`${base}/inbox?view=needs_reply`);
  const list = (await staff.textContent('.content')) || '';
  assert.match(list, /Maya Torres/, 'her renewal counter-question waits');
  await Promise.all([staff.waitForLoadState('networkidle'), staff.click('a.list-item:has-text("Maya Torres")')]);
  const thread = (await staff.textContent('.content')) || '';
  assert.match(thread, /renewal options are ready/i, 'outbound renewal email in the timeline');
  assert.match(thread, /would you do \$1,395/, 'inbound reply threaded into the same conversation');

  // staff reply closes the loop
  await staff.fill('textarea[name=body]', 'Great news — we can do $1,395 on the 12-month term. Accept in your portal and it will reflect the updated rate.');
  await Promise.all([staff.waitForLoadState('networkidle'), staff.click('form[action*="/reply"] button:has-text("Send")')]);
  assert.match((await staff.textContent('.flash')) || '', /Reply sent/);

  // Derrick's SMS thread carries the internal note + assignment
  await staff.goto(`${base}/inbox?view=mine`);
  assert.match((await staff.textContent('.content')) || '', /Derrick Cole/);
  await Promise.all([staff.waitForLoadState('networkidle'), staff.click('a.list-item:has-text("Derrick Cole")')]);
  const derrick = (await staff.textContent('.content')) || '';
  assert.match(derrick, /Promise-to-pay on file/, 'internal note');
  assert.match(derrick, /pay \$800 Friday/, 'inbound SMS');
});

test('gate: mass message to "balance > $0 at Summit Ridge" previews exactly the right audience', async () => {
  const { q1 } = await import('../src/lib/db.ts');
  const { sysCtx } = await import('../src/lib/auth.ts');
  const { segmentRecipients } = await import('../src/modules/m15_comms/service.ts');
  const orgId = q1<any>('SELECT id FROM orgs').id;
  const sr = q1<any>(`SELECT id FROM properties WHERE slug='summit-ridge'`).id;
  const expected = segmentRecipients(sysCtx(orgId), { propertyId: sr, balanceOverCents: 0 });
  assert.equal(expected.length > 5, true, 'seeded delinquents exist');
  // guarantee a consent skip inside this audience for the next gate
  const { setOptout } = await import('../src/modules/m15_comms/service.ts');
  setOptout(sysCtx(orgId), 'resident', expected[1]!.residentId, 'email', true);

  await staff.goto(`${base}/comms/mass/new?preview=1&property=${sr}&balance_over=0.00`);
  const body = (await staff.textContent('.content')) || '';
  const m = /(\d+)\s*primary contacts match/.exec(body.replace(/\s+/g, ' '));
  assert.ok(m, 'preview count renders');
  assert.equal(Number(m![1]), expected.length, `UI count ${m![1]} equals live segment ${expected.length}`);
  assert.match(body, new RegExp(expected[0]!.name.split(' ')[0]!), 'per-recipient preview lists real residents');

  // compose + schedule for tomorrow
  await staff.fill('input[name=subject]', 'About your balance, {{first_name}}');
  await staff.fill('textarea[name=body]', '<p>Hi {{first_name}}, your current balance for unit {{unit}} is {{balance}}. Pay or set up a plan in the portal.</p>');
  await Promise.all([staff.waitForLoadState('networkidle'), staff.click('button:has-text("Schedule")')]);
  assert.match((await staff.textContent('.flash')) || '', /Scheduled/);
  massUrl = staff.url().split('?')[0]!;
  assert.match((await staff.textContent('.subtitle')) || '', /scheduled/i);
});

test('gate: it sends on schedule (day advance) — opt-outs skipped with recorded reasons', async () => {
  const admin = await newPage(browser);
  await login(admin, base, 'admin@summitridge.demo');
  await admin.goto(`${base}/dev/sim`);
  await admin.click('button[value="1"]', { timeout: 120000 });
  await admin.waitForLoadState('networkidle', { timeout: 120000 });
  await admin.close();

  await staff.goto(massUrl);
  assert.match((await staff.textContent('.subtitle')) || '', /sent/i);
  const body = (await staff.textContent('.content')) || '';
  assert.match(body, /skipped_optout|opted out of email/, 'consent enforced and the reason recorded');

  // the campaign landed in the Message Console
  const admin2 = await newPage(browser);
  await login(admin2, base, 'admin@summitridge.demo');
  await admin2.goto(`${base}/dev/messages`);
  assert.match((await admin2.textContent('.content')) || '', /About your balance/);
  await admin2.close();
});

test('gate: quiet hours defer SMS; morning delivers', async () => {
  const admin = await newPage(browser);
  await login(admin, base, 'admin@summitridge.demo');
  // night time
  await admin.goto(`${base}/dev/sim`);
  await admin.fill('input[name=clockHour]', '22');
  await Promise.all([admin.waitForLoadState('networkidle'), admin.click('button:has-text("Save dials")')]);
  await admin.close();

  const { q1 } = await import('../src/lib/db.ts');
  const sr = q1<any>(`SELECT id FROM properties WHERE slug='summit-ridge'`).id;
  await staff.goto(`${base}/comms/mass/new?preview=1&property=${sr}&balance_over=0.00`);
  await staff.fill('input[name=subject]', 'Night SMS test');
  await staff.fill('textarea[name=body]', '<p>{{first_name}} — balance {{balance}}.</p>');
  await staff.fill('input[name=sms_body]', '{{property}}: balance {{balance}} — portal has payment options.');
  await staff.uncheck('input[name=ch_email]');
  await staff.check('input[name=ch_sms]');
  await Promise.all([staff.waitForLoadState('networkidle'), staff.click('button:has-text("Schedule")')]);
  const nightUrl = staff.url().split('?')[0]!;
  await Promise.all([staff.waitForLoadState('networkidle'), staff.click('button:has-text("Send now")')]);
  assert.match((await staff.textContent('.flash')) || '', /deferred/i);
  assert.match((await staff.textContent('.content')) || '', /quiet hours/i);

  // morning: deferred recipients deliver
  const admin2 = await newPage(browser);
  await login(admin2, base, 'admin@summitridge.demo');
  await admin2.goto(`${base}/dev/sim`);
  await admin2.fill('input[name=clockHour]', '10');
  await Promise.all([admin2.waitForLoadState('networkidle'), admin2.click('button:has-text("Save dials")')]);
  await admin2.close();
  await staff.goto(nightUrl);
  await Promise.all([staff.waitForLoadState('networkidle'), staff.click('button:has-text("Send now")')]);
  const after2 = (await staff.textContent('.kpis')) || '';
  assert.match(after2, /Deferred \(quiet hours\)\s*0/, 'deferred queue drained in the morning');
});

test('gate: an inbound simulated reply threads correctly and flags needs-reply', async () => {
  const admin = await newPage(browser);
  await login(admin, base, 'admin@summitridge.demo');
  const { q1 } = await import('../src/lib/db.ts');
  const maya = q1<any>(`SELECT id FROM residents WHERE email='maya.torres@mail.demo'`);
  const thread = q1<any>('SELECT id FROM threads WHERE person_id=?', maya.id);
  await admin.goto(`${base}/inbox/${thread.id}`);
  await admin.fill('form[action*="simulate-reply"] textarea[name=body]', 'Perfect — accepting the 12-month at $1,395 today. Thank you!');
  await Promise.all([admin.waitForLoadState('networkidle'), admin.click('form[action*="simulate-reply"] button')]);
  assert.match((await admin.textContent('.flash')) || '', /needs-reply/i);
  assert.match((await admin.textContent('.content')) || '', /accepting the 12-month/);
  await admin.goto(`${base}/inbox?view=needs_reply`);
  assert.match((await admin.textContent('.content')) || '', /Maya Torres/);
  await admin.close();
});

test('template overrides + automation audit + portal preferences + unsubscribe', async () => {
  await staff.goto(`${base}/comms/templates`);
  const tpl = (await staff.textContent('.content')) || '';
  assert.match(tpl, /Pool closure notice/, 'custom template');
  assert.match(tpl, /dunning_friendly[\s\S]*overridden|overridden[\s\S]*dunning_friendly/, 'built-in override flagged');

  await staff.goto(`${base}/comms/automations`);
  const auto = (await staff.textContent('.content')) || '';
  assert.match(auto, /payment_receipt/);
  assert.match(auto, /ON — disable|OFF — enable/);

  // portal preferences + unsubscribe
  const maya = await newPage(browser, { mobile: true });
  await login(maya, base, 'maya.torres@mail.demo');
  await maya.goto(`${base}/portal/lease`);
  assert.match((await maya.textContent('.portal')) || '', /Communication preferences/);
  await maya.close();

  const { q1 } = await import('../src/lib/db.ts');
  const tok = q1<any>(`SELECT unsubscribe_token FROM comm_prefs WHERE unsubscribe_token IS NOT NULL LIMIT 1`)?.unsubscribe_token;
  const res = await staff.request.get(`${base}/u/${tok}`);
  assert.equal(res.status(), 200);
  assert.match(await res.text(), /unsubscribed/i);
});
