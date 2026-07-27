import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './lib.ts';
import { q1 } from '../src/lib/db.ts';
import type { Browser } from 'playwright';

/** End-to-end gate for the ILS lead-email lane: a webhook POST (as an
 * inbound-email provider would send it) must become a guest card with the
 * prospect's message threaded AND a Leasing AI action — with zero staff
 * involvement. Also proves the token gate and the website auto-first-touch. */

process.env.STAYLEASED_INBOUND_TOKEN = 'e2e-test-token';

let base: string;
let browser: Browser;
let close: () => Promise<void>;

before(async () => {
  const b = await boot();
  base = b.base;
  browser = b.browser;
  close = b.close;
});
after(async () => close());

test('webhook refuses a bad token', async () => {
  const res = await fetch(`${base}/hooks/inbound-email?token=wrong`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: 'x@y.com' }),
  });
  assert.equal(res.status, 403);
});

test('apartments.com-style webhook email → lead + thread + AI action, hands-free', async () => {
  const prop = q1<any>(`SELECT p.id, p.org_id, p.slug FROM properties p WHERE p.slug='summit-ridge'`);
  assert.ok(prop, 'seeded Summit Ridge property');
  // Build the intake address the same way the connections card does: ask the
  // server to render it (ensures the code setting exists), then read it back.
  const { intakeAddressFor } = await import('../src/modules/m3_crm/ils_email.ts');
  const { sysCtx } = await import('../src/lib/auth.ts');
  const addr = intakeAddressFor(sysCtx(prop.org_id), prop);

  const payload = {
    FromFull: { Email: 'lead@apartments.com', Name: 'Apartments.com' },
    OriginalRecipient: addr,
    ToFull: [{ Email: addr }],
    Subject: 'New Lead for Summit Ridge Apartments',
    TextBody: [
      'Name: Harriet Blaine',
      'Email: harriet.blaine.e2e@mail.demo',
      'Phone: 720-555-0031',
      'Beds: 2 bd',
      'Move Date: 2026-09-01',
      'Message: Saw the B1 online — is it still available and can I tour Saturday morning?',
    ].join('\n'),
  };
  const res = await fetch(`${base}/hooks/inbound-email?token=e2e-test-token`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  assert.equal(res.status, 200);
  const out = await res.json() as any;
  assert.equal(out.ok, true);
  assert.equal(out.source, 'apartments_com');

  const lead = q1<any>(`SELECT * FROM leads WHERE email='harriet.blaine.e2e@mail.demo'`);
  assert.ok(lead, 'lead created');
  assert.equal(lead.source, 'apartments_com');
  assert.equal(lead.beds, 2);
  const thread = q1<any>(`SELECT * FROM threads WHERE person_kind='lead' AND person_id=?`, lead.id);
  assert.ok(thread, 'prospect message threaded into the inbox');
  const action = q1<any>(`SELECT * FROM ai_actions WHERE agent='leasing' AND entity_id=? ORDER BY created_at DESC`, lead.id);
  assert.ok(action, 'Leasing AI engaged with zero staff involvement');
  assert.ok(['proposed', 'executed', 'auto_executed'].includes(action.status));
});

test('website inquiry auto-engages the Leasing AI (first touch, no staff click)', async () => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${base}/p/summit-ridge#contact`);
  await page.fill('#contact input[name=first_name]', 'Nolan');
  await page.fill('#contact input[name=last_name]', 'Frey');
  await page.fill('#contact input[name=email]', 'nolan.frey.e2e@mail.demo');
  await page.fill('#contact textarea[name=message]', 'Do you have any 1 bedrooms and what is the pet policy? Could I tour tomorrow?');
  await Promise.all([page.waitForLoadState('networkidle'), page.click('#contact button')]);
  const lead = q1<any>(`SELECT * FROM leads WHERE email='nolan.frey.e2e@mail.demo'`);
  assert.ok(lead, 'website lead created');
  const action = q1<any>(`SELECT * FROM ai_actions WHERE agent='leasing' AND entity_id=?`, lead.id);
  assert.ok(action, 'first-touch AI action exists without any staff trigger');
  await page.context().close();
});
