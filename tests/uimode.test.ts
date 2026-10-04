import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q1, insert, val } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword, sysCtx } from '../src/lib/auth.ts';
import { setSetting } from '../src/lib/settings.ts';
import { localPath } from '../src/lib/http.ts';
import { uiMode, orgDefaultMode } from '../src/lib/uimode.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { SPECS, GROUPS } from '../src/modules/m1_admin/settings_spec.ts';
import { startTestServer, loginAs, get, post } from './harness.ts';

/** Standard and Advanced: one switch, per person, that changes the whole
 * navigation — and a settings page that is sections instead of a scroll.
 *
 * Three kinds of promise are held here.
 *
 * **The switch is personal.** It sits in the navigation bar where anyone can
 * reach it, so it may only ever change the screen of whoever pressed it. A
 * property manager opening the full accounts must not rearrange the owner's
 * navigation — or a demo, mid-sentence.
 *
 * **Standard never offers a page its user could not otherwise open, and never
 * silently loses one.** Standard's tabs are a map onto pages the modules
 * register; every entry resolves through that registration, permissions and
 * all. The failure modes are a typo (an href nobody registered, which renders
 * as nothing) and a leak (a page shown to a role that cannot open it).
 *
 * **Sectioning the settings page loses no setting.** One section at a time is
 * easier to read and easy to get wrong: a group the section map forgets would
 * make its settings unreachable from every screen, with every test still
 * green because the "All settings" view would still render them. So the
 * union of the sections is checked against the spec list itself. */

let orgId: string;
let ownerId: string;
let managerId: string;

before(() => {
  db();
  const existing = q1<{ id: string }>('SELECT id FROM orgs WHERE slug=?', 'uimode-test');
  if (existing) {
    orgId = existing.id;
    ownerId = q1<{ id: string }>('SELECT id FROM users WHERE email=?', 'owner@uimode.test')!.id;
    managerId = q1<{ id: string }>('SELECT id FROM users WHERE email=?', 'agent@uimode.test')!.id;
    return;
  }
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'Mode Test Co', slug: 'uimode-test', business_date: '2026-09-20', kind: 'live', created_at: nowIso() });
  ensureCoa(orgId);
  const mkUser = (email: string, name: string, role: string): string => {
    const uid = id('usr');
    insert('users', {
      id: uid, org_id: orgId, email, name, kind: 'staff',
      password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
    });
    insert('role_assignments', { id: id('ra'), org_id: orgId, user_id: uid, role, scope_type: 'org', property_ids: '[]', created_at: nowIso() });
    return uid;
  };
  ownerId = mkUser('owner@uimode.test', 'Olive Owner', 'ORG_ADMIN');
  managerId = mkUser('agent@uimode.test', 'Lee Agent', 'LEASING_AGENT');
  insert('properties', {
    id: id('prp'), org_id: orgId, name: 'Mode Court', slug: 'mode-court', type: 'multifamily',
    address1: '1 Main', city: 'Madison', state: 'WI', zip: '53703', timezone: 'America/Chicago',
    phone: null, email: null, year_built: null, fiscal_year_start_month: 1, created_at: nowIso(),
  });
});

const ctxFor = (userId: string): ReturnType<typeof sysCtx> => ({ ...sysCtx(orgId), userId, kind: 'staff' });
const modeRow = (userId: string): string | null => val<string>('SELECT ui_mode FROM users WHERE id=?', userId) ?? null;

/** The tabs actually rendered in the module bar, by their visible label. */
function tabs(page: string): string[] {
  const bar = /<nav class="modulebar"[\s\S]*?<\/nav>/.exec(page)?.[0] || '';
  return [...bar.matchAll(/class="mtab-btn[^"]*"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]+)/g)].map((m) => m[1]!.trim());
}
/** Every link the module bar and its menus offer. */
function barLinks(page: string): string[] {
  const bar = /<nav class="modulebar"[\s\S]*?<\/nav>/.exec(page)?.[0] || '';
  // any attribute order: a tab with a single page renders as a direct link
  // whose class comes before its href
  return [...bar.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]!);
}

// ---------- the guard ----------

test('a redirect target cannot leave the site, however it is spelled', () => {
  assert.equal(localPath('/home', '/'), '/home');
  assert.equal(localPath('/admin/settings?section=money&x=1', '/'), '/admin/settings?section=money&x=1');
  // the three ways a leading-slash check is fooled
  assert.equal(localPath('//evil.example/x', '/'), '/', 'protocol-relative');
  assert.equal(localPath('/\\evil.example/x', '/'), '/', 'browsers normalise /\\ to //');
  assert.equal(localPath('https://evil.example', '/'), '/', 'absolute');
  assert.equal(localPath('/ok\r\nSet-Cookie: x=1', '/'), '/', 'no header injection through a newline');
  assert.equal(localPath(undefined, '/ai'), '/ai');
  assert.equal(localPath('', '/ai'), '/ai');
});

// ---------- resolution ----------

test('a person who has not chosen follows the organization; a choice beats it both ways', () => {
  const owner = ctxFor(ownerId);
  setSetting(sysCtx(orgId), 'simple_mode', false);
  assert.equal(modeRow(ownerId), null, 'nobody has chosen yet');
  assert.equal(uiMode(owner), 'advanced', 'an org that starts people in Advanced');
  setSetting(sysCtx(orgId), 'simple_mode', true);
  assert.equal(uiMode(owner), 'standard', 'and one that starts them in Standard');
  assert.equal(orgDefaultMode(owner), 'standard');

  db().prepare("UPDATE users SET ui_mode='advanced' WHERE id=?").run(ownerId);
  assert.equal(uiMode(owner), 'advanced', 'a personal choice outranks the org starting point');
  setSetting(sysCtx(orgId), 'simple_mode', false);
  db().prepare("UPDATE users SET ui_mode='standard' WHERE id=?").run(ownerId);
  assert.equal(uiMode(owner), 'standard', 'in both directions');
  db().prepare('UPDATE users SET ui_mode=NULL WHERE id=?').run(ownerId);
});

test('only staff have a mode — the system context and portals are always the full product', () => {
  assert.equal(uiMode(sysCtx(orgId)), 'advanced', 'the system context has no screen');
  assert.equal(uiMode({ ...ctxFor(ownerId), kind: 'resident' }), 'advanced');
  assert.equal(uiMode(null), 'advanced');
});

// ---------- the switch, over HTTP ----------

test('the switch changes only the screen of whoever pressed it', async () => {
  const { base, close } = await startTestServer();
  try {
    setSetting(sysCtx(orgId), 'simple_mode', false);
    const owner = await loginAs(base, 'owner@uimode.test');
    const agent = await loginAs(base, 'agent@uimode.test');

    const r = await post(base, '/mode', { mode: 'standard', back: '/units' }, owner);
    assert.equal(r.status, 303);
    assert.equal(r.location, '/units', 'it returns to the page it was pressed on');
    assert.equal(modeRow(ownerId), 'standard');
    assert.equal(modeRow(managerId), null, 'the colleague is untouched');

    const ownerHome = await get(base, '/', owner);
    const agentHome = await get(base, '/', agent);
    assert.match(ownerHome.text, /Where you stand/, 'the owner’s front door is the home screen');
    assert.doesNotMatch(agentHome.text, /Where you stand/, 'the colleague still has the dashboard');
    assert.match(agentHome.text, /data-mode="advanced"/);
  } finally {
    close();
  }
});

test('the switch refuses a mode that does not exist and a destination off the site', async () => {
  const { base, close } = await startTestServer();
  try {
    const owner = await loginAs(base, 'owner@uimode.test');
    const before = modeRow(ownerId);
    const bogus = await post(base, '/mode', { mode: 'expert', back: '/units' }, owner);
    assert.equal(modeRow(ownerId), before, 'nothing stored');
    assert.equal(bogus.location, '/units');

    for (const back of ['//evil.example', '/\\evil.example', 'https://evil.example']) {
      const r = await post(base, '/mode', { mode: 'advanced', back }, owner);
      assert.equal(r.location, '/', `"${back}" falls back home rather than leaving the site`);
    }
  } finally {
    close();
  }
});

// ---------- Standard's navigation ----------

test('every page Standard names is one a module actually registered', async () => {
  // Importing the server mounts every module, which is what fills the registry.
  await import('../src/server/main.ts');
  const { standardNavHrefs, registeredNavHrefs } = await import('../src/ui/ui.ts');
  const registered = registeredNavHrefs();
  const missing = standardNavHrefs().filter((h) => !registered.has(h));
  assert.deepEqual(missing, [], 'a Standard entry with no registered page renders as nothing — a silent deletion');
});

test('Standard shows five plain-language tabs; Advanced keeps all eight', async () => {
  const { base, close } = await startTestServer();
  try {
    const owner = await loginAs(base, 'owner@uimode.test');
    await post(base, '/mode', { mode: 'standard', back: '/' }, owner);
    const std = await get(base, '/units', owner);
    assert.deepEqual(tabs(std.text), ['Home', 'Money', 'Units', 'People', 'Repairs']);
    // the words from the approved copy map, not the department names
    for (const label of ['Who owes me', 'Bills', 'Money in and out', 'Leases ending soon', 'Inquiries']) {
      assert.match(std.text, new RegExp(`>${label}<`), `"${label}" is in Standard's navigation`);
    }
    // overview hubs are a menu layer between a tab and its pages; Standard has none
    assert.ok(!barLinks(std.text).some((h) => h.startsWith('/hub/')), 'no hub pages in Standard');

    await post(base, '/mode', { mode: 'advanced', back: '/' }, owner);
    const adv = await get(base, '/units', owner);
    assert.deepEqual(tabs(adv.text), ['Dashboard', 'Leasing', 'Residents', 'Financials', 'Property', 'Operations', 'Messages', 'Reports']);
  } finally {
    close();
  }
});

test('Standard never offers a page the person’s role cannot open', async () => {
  const { base, close } = await startTestServer();
  try {
    const agent = await loginAs(base, 'agent@uimode.test');
    await post(base, '/mode', { mode: 'standard', back: '/' }, agent);
    const page = await get(base, '/', agent);
    const links = barLinks(page.text);
    // A leasing agent holds ledger:view but not collections:manage or ap:view.
    assert.ok(links.includes('/receivables'), 'who owes me: the agent can open it');
    assert.ok(!links.includes('/delinquency'), 'seriously behind: the agent cannot');
    assert.ok(!links.includes('/ap'), 'bills: the agent cannot');
    // A tab whose every page is out of reach is not drawn at all.
    assert.ok(!tabs(page.text).includes('Repairs'), 'no repairs permission, no Repairs tab');
    for (const h of links) {
      if (h === '/' || h.startsWith('/mode')) continue;
      const r = await get(base, h, agent);
      assert.notEqual(r.status, 403, `${h} is offered and must open`);
    }
  } finally {
    close();
  }
});

test('the switch is in the bar and the drawer, saying which mode is on', async () => {
  const { base, close } = await startTestServer();
  try {
    const owner = await loginAs(base, 'owner@uimode.test');
    await post(base, '/mode', { mode: 'standard', back: '/' }, owner);
    const page = await get(base, '/residents', owner);
    const forms = page.text.match(/<form method="post" action="\/mode"/g) || [];
    assert.equal(forms.length, 2, 'one in the module bar, one at the head of the phone drawer');
    assert.match(page.text, /value="standard" aria-pressed="true"/);
    assert.match(page.text, /value="advanced" aria-pressed="false"/);
    assert.match(page.text, /name="back" value="\/residents"/, 'it knows where to come back to');
  } finally {
    close();
  }
});

test('the gear groups what it holds, and keeps system plumbing to Advanced', async () => {
  const { base, close } = await startTestServer();
  try {
    const owner = await loginAs(base, 'owner@uimode.test');
    await post(base, '/mode', { mode: 'standard', back: '/' }, owner);
    const std = (await get(base, '/', owner)).text;
    const gear = (t: string): string => /id="setup-pop">([\s\S]*?)<\/div>\s*<\/div>/.exec(t)?.[1] || '';
    assert.match(gear(std), /Your organization/);
    assert.match(gear(std), /href="\/admin\/settings"/);
    assert.match(gear(std), /href="\/admin\/billing"/, 'billing lives with the other organization pages');
    assert.doesNotMatch(gear(std), /href="\/admin\/jobs"/, 'scheduled jobs are Advanced’s');

    await post(base, '/mode', { mode: 'advanced', back: '/' }, owner);
    const adv = (await get(base, '/', owner)).text;
    assert.match(gear(adv), /href="\/admin\/jobs"/, 'and are there in Advanced');

    // The account menu is personal: organization pages left it for the gear.
    const acct = /id="usermenu-pop">([\s\S]*?)<\/form>/.exec(adv)?.[1] || '';
    assert.doesNotMatch(acct, /Org settings|admin\/billing/);
  } finally {
    close();
  }
});

// ---------- settings: sections ----------

test('sectioning the settings page loses no setting', async () => {
  const { base, close } = await startTestServer();
  try {
    const owner = await loginAs(base, 'owner@uimode.test');
    const first = await get(base, '/admin/settings', owner);
    const sectionIds = [...first.text.matchAll(/href="\/admin\/settings\?property=&amp;section=([a-z0-9-]+)"/g)]
      .map((m) => m[1]!).filter((x) => x !== 'all');
    assert.ok(sectionIds.length >= 8, `a real index of sections (${sectionIds.length})`);

    // Every spec's form must be reachable from SOME section, not just from All.
    const seen = new Set<string>();
    for (const sec of sectionIds) {
      const page = await get(base, `/admin/settings?property=&section=${sec}`, owner);
      for (const m of page.text.matchAll(/<input type="hidden" name="key" value="([^"]+)"/g)) seen.add(m[1]!);
    }
    const unreachable = SPECS.map((sp) => sp.key).filter((k) => !seen.has(k));
    assert.deepEqual(unreachable, [], 'a setting no section shows is a setting nobody can find');
    assert.ok(GROUPS.length > 0);
  } finally {
    close();
  }
});

test('the bare page shows one section, and All settings shows everything', async () => {
  const { base, close } = await startTestServer();
  try {
    const owner = await loginAs(base, 'owner@uimode.test');
    const one = (await get(base, '/admin/settings', owner)).text;
    const all = (await get(base, '/admin/settings?section=all', owner)).text;
    const forms = (t: string): number => (t.match(/<input type="hidden" name="key"/g) || []).length;
    assert.ok(forms(one) < forms(all) / 3, `one section is a fraction of the whole (${forms(one)} of ${forms(all)})`);
    assert.equal(forms(all), SPECS.length, 'and All really is all');
    assert.match(one, /aria-current="true">Rent, fees and payments/, 'the section in view is marked in the index');
  } finally {
    close();
  }
});

test('a save returns to the section it was made from', async () => {
  const { base, close } = await startTestServer();
  try {
    const owner = await loginAs(base, 'owner@uimode.test');
    const r = await post(base, '/admin/settings', { key: 'nsf_fee_cents', property: '', section: 'documents', f: '35.00' }, owner);
    assert.equal(r.location, '/admin/settings?property=&section=documents');
    // an attacker-shaped section value is reduced to nothing harmful
    const r2 = await post(base, '/admin/settings', { key: 'nsf_fee_cents', property: '', section: 'x"><script>', f: '35.00' }, owner);
    assert.equal(r2.location, '/admin/settings?property=&section=xscript');
  } finally {
    close();
  }
});

test('an on/off setting is a switch that saves when flipped; every other setting keeps its Save', async () => {
  const { base, close } = await startTestServer();
  try {
    const owner = await loginAs(base, 'owner@uimode.test');
    const page = (await get(base, '/admin/settings?section=all', owner)).text;
    const formFor = (key: string): string => {
      const at = page.indexOf(`name="key" value="${key}"`);
      const start = page.lastIndexOf('<form', at);
      return page.slice(start, page.indexOf('</form>', at));
    };
    const ai = formFor('ai_enabled');
    assert.match(ai, /data-autosubmit/, 'the form saves on change');
    assert.match(ai, /role="switch"/, 'and says what it is to assistive tech');
    assert.match(ai, /<noscript>[\s\S]*Save for Mode Test Co/, 'Save survives only without JavaScript');

    const fee = formFor('nsf_fee_cents');
    assert.doesNotMatch(fee, /data-autosubmit/, 'a money field never saves on a keystroke');
    assert.match(fee, /<button class="btn btn-sm">Save for Mode Test Co/);

    // "Value" named nothing the heading did not; the heading names the control now.
    assert.doesNotMatch(page, />Value</, 'no setting is labelled "Value"');
  } finally {
    close();
  }
});

test('the mode section tells the reader which mode they are in, and why', async () => {
  const { base, close } = await startTestServer();
  try {
    const owner = await loginAs(base, 'owner@uimode.test');
    db().prepare('UPDATE users SET ui_mode=NULL WHERE id=?').run(ownerId);
    setSetting(sysCtx(orgId), 'simple_mode', false);
    let page = (await get(base, '/admin/settings?section=how-much-you-see', owner)).text;
    assert.match(page, /You are using <b>Advanced<\/b>\s*— the starting mode below/);

    await post(base, '/mode', { mode: 'standard', back: '/' }, owner);
    page = (await get(base, '/admin/settings?section=how-much-you-see', owner)).text;
    assert.match(page, /You are using <b>Standard<\/b>\s*— your own choice/);
  } finally {
    close();
  }
});
