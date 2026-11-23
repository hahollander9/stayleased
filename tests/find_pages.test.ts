import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { insert, db } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { fixtureTwoOrgs, startTestServer, loginAs, get, post, type TwoOrgs } from './harness.ts';

/** Finding things.
 *
 * A new office manager typed "payment" into the search box and got nothing;
 * typed /settings into the address bar and got a bare 404; looked for the page
 * that sends a notice and concluded there was not one. Each promise below is
 * one of those, held:
 *
 * - the search box answers the words people actually type, first hit first;
 * - Standard's menus reach notices, the approval queue, reports, sent mail,
 *   export and connections;
 * - one page lists everything, built from the registry so it cannot drift;
 * - the addresses people guess go where they meant, and shadow nothing real;
 * - the Outbox answers at /outbox and at its old address, sent mail first. */

let fx: TwoOrgs;
let base: string;
let close: () => void;
let cookie: string;

before(async () => {
  fx = fixtureTwoOrgs();
  ({ base, close } = await startTestServer());
  cookie = await loginAs(base, fx.adminA);
  await post(base, '/mode', { mode: 'standard', back: '/' }, cookie);
});
after(() => close());

const search = async (query: string): Promise<{ kind: string; label: string; href: string; sub?: string }[]> => {
  const r = await fetch(`${base}/search.json?q=${encodeURIComponent(query)}`, { headers: { cookie } });
  return ((await r.json()) as { results: { kind: string; label: string; href: string; sub?: string }[] }).results;
};

// ---------- search ----------

test('the words people type each open the right place first', async () => {
  const want: [string, string][] = [
    ['payment', '/receivables/payment'],
    ['late', '/receivables'],
    ['behind', '/delinquency'],
    ['owes', '/receivables'],
    ['email', '/inbox'],
    ['notice', '/comms'],
    ['import', '/setup#upload'],
    ['upload', '/setup#upload'],
    ['rent roll', '/setup#upload'],
    ['bills', '/ap'],
    ['sent', '/outbox'],
    ['messages', '/inbox'],
    ['billing', '/admin/billing'],
    ['setup', '/setup'],
    ['connections', '/setup/connections'],
    ['approve', '/ai'],
    ['drafts', '/ai'],
    ['new lease', '/leases/new'],
    ['add resident', '/leases/new'],
  ];
  for (const [query, href] of want) {
    const hits = await search(query);
    assert.ok(hits.length, `"${query}" finds something`);
    assert.equal(hits[0]!.href, href, `"${query}" → ${href} first (got ${hits[0]!.label} ${hits[0]!.href})`);
  }
});

test('results carry the name the person’s own menus use', async () => {
  const std = await search('owes');
  assert.equal(std[0]!.label, 'Who owes me');
  await post(base, '/mode', { mode: 'advanced', back: '/' }, cookie);
  const adv = await search('owes');
  assert.equal(adv[0]!.label, 'Receivables', 'Advanced keeps the accounting name');
  assert.equal(adv[0]!.href, '/receivables');
  await post(base, '/mode', { mode: 'standard', back: '/' }, cookie);
});

test('a loose match stays below the records; nonsense finds nothing', async () => {
  assert.deepEqual(await search('zzqqxx'), []);
  // "adm" is the start of a person's name here and of no page word: the person leads
  const hits = await search('Admin iso');
  assert.ok(hits.some((h) => h.label.includes('Admin iso-a')), 'records are still searched');
});

// ---------- Standard's menus ----------

test('Standard reaches notices, the approval queue, reports and sent mail from the bar', async () => {
  const page = (await get(base, '/units', cookie)).text;
  const bar = /<nav class="modulebar"[\s\S]*?<\/nav>/.exec(page)?.[0] || '';
  for (const [href, label] of [['/comms', 'Send a notice'], ['/ai', 'Waiting for your OK'], ['/reports', 'Reports'], ['/outbox', 'Sent messages']] as const) {
    assert.match(bar, new RegExp(`href="${href}"[^>]*>${label}`), `${label} is in Standard's bar`);
  }
  assert.match(bar, />Shared mailbox \(One Inbox\)</, 'the second inbox says what it is');
  assert.match(bar, />Inbox<span class="mhint">conversations with residents</, 'and so does the first');
  assert.match(bar, /class="mmore" href="\/all-pages#money"/, 'each dropdown ends by saying more exists');
  const gear = /id="setup-pop">([\s\S]*?)<\/div>\s*<\/div>/.exec(page)?.[1] || '';
  for (const href of ['/admin/export', '/setup/connections', '/outbox', '/all-pages']) {
    assert.match(gear, new RegExp(`href="${href}"`), `${href} is in the gear in Standard`);
  }
});

test('the drawer is the bar: same tabs, group sub-heads, then All pages', async () => {
  const page = (await get(base, '/units', cookie)).text;
  const drawer = /<nav class="nav">([\s\S]*?)<\/nav>/.exec(page)?.[1] || '';
  const heads = [...drawer.matchAll(/class="nav-head">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(heads, ['Money', 'Units', 'People', 'Repairs']);
  assert.match(drawer, /class="nav-sub">Coming in</);
  assert.match(drawer, /class="nav-sub">Messages</);
  assert.match(drawer, /href="\/all-pages"/);

  await post(base, '/mode', { mode: 'advanced', back: '/' }, cookie);
  const adv = (await get(base, '/units', cookie)).text;
  const advDrawer = /<nav class="nav">([\s\S]*?)<\/nav>/.exec(adv)?.[1] || '';
  const advHeads = [...advDrawer.matchAll(/class="nav-head">([^<]+)</g)].map((m) => m[1]);
  const barTabs = [...(/<nav class="modulebar"[\s\S]*?<\/nav>/.exec(adv)?.[0] || '').matchAll(/class="mtab-btn"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]+)/g)].map((m) => m[1]!.trim());
  assert.deepEqual(advHeads, barTabs, 'the Advanced drawer uses the bar’s own tab names');
  await post(base, '/mode', { mode: 'standard', back: '/' }, cookie);
});

test('the browser tab carries the menu’s words, and a page outside the menus says where it lives', async () => {
  const recv = (await get(base, '/receivables', cookie)).text;
  assert.match(recv, /<title>Who owes me · StayLeased<\/title>/);
  assert.match(recv, /href="\/receivables\/payment">Record a payment</, 'and recording a payment starts here');
  // Budgets is Advanced-only: in Standard it gets a line saying so
  const budgets = (await get(base, '/budgets', cookie)).text;
  assert.match(budgets, /class="crumbs">[\s\S]*?Money[\s\S]*?Advanced menus/);
});

// ---------- All pages ----------

test('All pages lists every destination, filters without script, and tags what Standard leaves out', async () => {
  const all = await get(base, '/all-pages', cookie);
  assert.equal(all.status, 200);
  assert.match(all.text, /Everything in StayLeased/);
  for (const h of ['Money', 'Units', 'People', 'Repairs', 'Setup and your company']) assert.match(all.text, new RegExp(`<h2 id="ap-h-[a-z]+">${h}</h2>`));
  // every registered page this admin can open is on it
  const { registeredNavHrefs } = await import('../src/ui/ui.ts');
  const missing = [...registeredNavHrefs()].filter((h) => !['/student', '/affordable', '/myday', '/dev/sim'].includes(h) && !all.text.includes(`class="ap-row" href="${h}"`));
  assert.deepEqual(missing, [], 'generated from the registry: nothing registered is left off');
  assert.match(all.text, /href="\/budgets">\s*<span class="ap-name">Budgets <span class="ap-tag">Advanced menus<\/span>/);
  assert.doesNotMatch(all.text, /href="\/receivables">\s*<span class="ap-name">Who owes me <span class="ap-tag">Advanced/);

  const f = await get(base, '/all-pages?q=notice', cookie);
  assert.match(f.text, /href="\/comms"/);
  assert.doesNotMatch(f.text, /class="ap-row" href="\/budgets"/);
  const none = await get(base, '/all-pages?q=zzqqxx', cookie);
  assert.match(none.text, /Nothing matches/);
});

// ---------- aliases and the 404 ----------

test('the addresses people guess go where they meant — for staff only', async () => {
  const { ALIASES } = await import('../src/modules/m25_find/pages.ts');
  for (const [from, to] of ALIASES) {
    const r = await fetch(base + from, { headers: { cookie }, redirect: 'manual' });
    assert.ok(r.status >= 300 && r.status < 400, `${from} redirects (${r.status})`);
    assert.equal(r.headers.get('location'), to, `${from} → ${to}`);
    const out = await fetch(base + from, { redirect: 'manual' });
    assert.equal(out.status, 404, `${from} is still a 404 signed out`);
  }
});

test('no alias shadows a route a module serves, and every target exists', async () => {
  const { buildRouter } = await import('../src/server/main.ts');
  const { ALIASES } = await import('../src/modules/m25_find/pages.ts');
  const router = buildRouter();
  for (const [from, to] of ALIASES) {
    const same = router.routes.filter((x) => x.method === 'GET' && x.pattern === from);
    assert.equal(same.length, 1, `${from} is served once — by the alias`);
    assert.ok(router.match('GET', to.split('#')[0]!), `${to} is a real page`);
  }
});

test('a signed-in 404 offers to find the page; a signed-out one does not', async () => {
  const inn = await get(base, '/no-such-page-here', cookie);
  assert.equal(inn.status, 404);
  assert.match(inn.text, /action="\/all-pages"/);
  assert.match(inn.text, />Find it</);
  assert.match(inn.text, /href="\/all-pages">All pages</);
  const out = await get(base, '/no-such-page-here');
  assert.equal(out.status, 404);
  assert.doesNotMatch(out.text, /all-pages/);
});

// ---------- the Outbox ----------

test('the Outbox answers at /outbox and at its old address, sent mail first', async () => {
  db();
  const sfx = id('t').slice(-6);
  const mk = (direction: string, subject: string): string => {
    const mid = id('msg');
    insert('outbox_messages', { id: mid, org_id: fx.orgA, property_id: fx.propA, channel: 'email', direction, to_addr: 'p@example.test', subject, body: '<p>x</p>', template_key: direction === 'out' ? 'payment_nsf' : null, status: direction === 'out' ? 'sent' : 'received', created_at: nowIso() });
    return mid;
  };
  const out = mk('out', `Sent ${sfx}`);
  mk('in', `Received ${sfx}`);
  for (const path of ['/outbox', '/dev/messages']) {
    const list = await get(base, path, cookie);
    assert.equal(list.status, 200, path);
    assert.ok(list.text.includes(`Sent ${sfx}`));
    assert.ok(!list.text.includes(`Received ${sfx}`), 'received mail is not in the default list');
    assert.equal((await get(base, `${path}/${out}`, cookie)).status, 200);
  }
  const both = await get(base, '/outbox?received=1', cookie);
  assert.ok(both.text.includes(`Received ${sfx}`), 'and is one tick away');
  // Standard reads plainly; the template's code name is Advanced's
  const std = await get(base, '/outbox', cookie);
  assert.match(std.text, /<title>Sent messages · StayLeased<\/title>/);
  assert.match(std.text, /Returned payment notice/);
  assert.doesNotMatch(std.text, /class="mono small">payment_nsf/);
  await post(base, '/mode', { mode: 'advanced', back: '/' }, cookie);
  assert.match((await get(base, '/outbox', cookie)).text, /class="mono small">payment_nsf/);
  await post(base, '/mode', { mode: 'standard', back: '/' }, cookie);
});

// ---------- record a payment ----------

test('recording a payment starts with finding the household', async () => {
  const page = await get(base, '/receivables/payment', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Who paid\?/);
  const none = await get(base, '/receivables/payment?q=zzqqxx', cookie);
  assert.match(none.text, /Nobody by that name or unit/);
});
