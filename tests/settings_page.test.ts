import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q1, insert } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword, sysCtx } from '../src/lib/auth.ts';
import { getSetting, SETTING_DEFAULTS } from '../src/lib/settings.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { specCoverage, SPECS } from '../src/modules/m1_admin/settings_spec.ts';
import { startTestServer, loginAs, get, post } from './harness.ts';

/** Org settings as typed controls. The page used to render every key as raw
 * JSON in a text box, which put `bah_table` at the same weight as the late fee
 * and made a typo a silent change to what residents are charged. Now one spec
 * per setting drives both the form and the parse, money is entered in dollars,
 * and a bad value is a sentence about that setting. */

const AS_OF = '2026-07-23';
let orgId: string;
let propId: string;

before(() => {
  db();
  const existing = q1<{ id: string }>('SELECT id FROM orgs WHERE slug=?', 'setpage-test');
  if (existing) {
    orgId = existing.id;
    propId = q1<{ id: string }>('SELECT id FROM properties WHERE org_id=?', orgId)!.id;
    return;
  }
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'Settings Test Co', slug: 'setpage-test', business_date: AS_OF, kind: 'live', created_at: nowIso() });
  const uid = id('usr');
  insert('users', {
    id: uid, org_id: orgId, email: 'admin@setpage.test', name: 'Set Admin',
    kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
  });
  insert('role_assignments', { id: id('ra'), org_id: orgId, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  ensureCoa(orgId);
  propId = id('prp');
  insert('properties', {
    id: propId, org_id: orgId, name: 'Override Court', slug: 'override-court', type: 'multifamily',
    address1: '1 Main', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver',
    phone: null, email: null, year_built: null, fiscal_year_start_month: 1, created_at: nowIso(),
  });
});

const val = <T>(key: string, property?: string): T => getSetting<T>(sysCtx(orgId), key, property);

test('every setting is described exactly once — no key renders unhandled, no spec is dead', () => {
  const { missing, extra } = specCoverage();
  assert.deepEqual(missing, [], 'settings with no typed control (add a spec in settings_spec.ts)');
  assert.deepEqual(extra, [], 'specs naming a setting that no longer exists');
  assert.equal(SPECS.length, Object.keys(SETTING_DEFAULTS).length);
});

test('the page renders grouped, labelled controls — and no raw JSON', async () => {
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@setpage.test');
    const page = await get(base, '/admin/settings', cookie);
    assert.equal(page.status, 200);

    // groups and plain-language labels, not key names
    assert.match(page.text, /Rent, fees and payments/);
    assert.match(page.text, /Deposits and move-out/);
    assert.match(page.text, /Approval thresholds/);
    assert.match(page.text, /Late fee policy/);
    assert.match(page.text, /Returned payment fee/);
    assert.match(page.text, /Grace period/, 'object settings expose their parts');

    // money is shown in dollars, not cents
    assert.match(page.text, /value="50\.00"/, 'the $50 flat late fee renders as 50.00');
    assert.doesNotMatch(page.text, /name="value"/, 'the raw JSON escape hatch is gone');
    // a JSON blob for a structured setting would look like {"graceDays":
    assert.doesNotMatch(page.text, /\{&quot;graceDays/, 'no JSON blobs in inputs');
  } finally {
    close();
  }
});

test('saving goes through the spec: dollars become cents, objects rebuild, schema fields survive', async () => {
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@setpage.test');

    // scalar money, typed in dollars
    const nsf = await post(base, '/admin/settings', { key: 'nsf_fee_cents', property: '', f: '42.50' }, cookie);
    assert.equal(nsf.status, 303);
    assert.equal(val<number>('nsf_fee_cents'), 4250, 'stored as integer cents');

    // object with mixed control types
    await post(base, '/admin/settings', {
      key: 'late_fee_policy', property: '',
      'f.graceDays': '5', 'f.type': 'flat', 'f.flatCents': '75.00',
      'f.dailyCents': '10.00', 'f.dailyCapCents': '200.00', 'f.minBalanceCents': '25.00',
    }, cookie);
    assert.deepEqual(val('late_fee_policy'), {
      graceDays: 5, type: 'flat', flatCents: 7500, dailyCents: 1000, dailyCapCents: 20000, minBalanceCents: 2500,
    });

    // `version` is schema, not a control — it must survive a save untouched
    await post(base, '/admin/settings', {
      key: 'screening_criteria', property: '',
      'f.incomeMultiple': '3', 'f.minCreditScore': '640', 'f.conditionalCreditScore': '580',
      'f.conditionalDepositMultiplier': '2', 'f.evictionLookbackYears': '7', 'f.felonyLookbackYears': '7',
    }, cookie);
    const sc = val<Record<string, number>>('screening_criteria');
    assert.equal(sc.version, 1, 'the schema version is carried through');
    assert.equal(sc.minCreditScore, 640);

    // booleans: unchecked boxes simply do not post
    await post(base, '/admin/settings', { key: 'payment_methods', property: '', 'f.ach': '1', 'f.cash_equivalent': '1' }, cookie);
    assert.deepEqual(val('payment_methods'), { ach: true, card: false, cash_equivalent: true });

    // weekdays
    await post(base, '/admin/settings', {
      key: 'business_hours', property: '', 'f.start': '08:30', 'f.end': '17:00',
      'f.days.1': '1', 'f.days.2': '1', 'f.days.3': '1',
    }, cookie);
    assert.deepEqual(val('business_hours'), { start: '08:30', end: '17:00', days: [1, 2, 3] });

    // comma list
    await post(base, '/admin/settings', { key: 'followup_cadence_days', property: '', f: '0, 2, 5' }, cookie);
    assert.deepEqual(val('followup_cadence_days'), [0, 2, 5]);

    // ranked order, entered as positions
    await post(base, '/admin/settings', {
      key: 'payment_application_order', property: '',
      'f.rent': '1', 'f.fee': '2', 'f.utility': '3', 'f.deposit': '4', 'f.other': '5',
    }, cookie);
    assert.deepEqual(val('payment_application_order'), ['rent', 'fee', 'utility', 'deposit', 'other']);
  } finally {
    close();
  }
});

test('a bad value is refused with a sentence about that setting, and nothing is stored', async () => {
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@setpage.test');
    const before = val<number>('nsf_fee_cents');

    const bad = await post(base, '/admin/settings', { key: 'nsf_fee_cents', property: '', f: 'forty dollars' }, cookie);
    assert.equal(bad.status, 303);
    assert.match(bad.location || '', /\/admin\/settings/);
    assert.equal(val<number>('nsf_fee_cents'), before, 'the old value stands');

    // out-of-range integers are caught by the spec's bounds, not by the DB
    const grace = await post(base, '/admin/settings', {
      key: 'late_fee_policy', property: '',
      'f.graceDays': '400', 'f.type': 'flat', 'f.flatCents': '10.00',
      'f.dailyCents': '0', 'f.dailyCapCents': '0', 'f.minBalanceCents': '0',
    }, cookie);
    assert.equal(grace.status, 303);
    assert.equal((val<Record<string, number>>('late_fee_policy')).graceDays, 5, 'unchanged');

    // a duplicated position in the payment order is a real mistake, not a shrug
    const dup = await post(base, '/admin/settings', {
      key: 'payment_application_order', property: '',
      'f.rent': '1', 'f.fee': '1', 'f.utility': '3', 'f.deposit': '4', 'f.other': '5',
    }, cookie);
    assert.equal(dup.status, 303);
    assert.deepEqual(val('payment_application_order'), ['rent', 'fee', 'utility', 'deposit', 'other'], 'unchanged');

    // an unknown key is rejected outright
    const unknown = await post(base, '/admin/settings', { key: 'not_a_setting', property: '', f: '1' }, cookie);
    assert.equal(unknown.status, 400);
  } finally {
    close();
  }
});

test('the BAH matrix edits, adds and removes pay grades without touching JSON', async () => {
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@setpage.test');
    const start = val<Record<string, Record<string, number>>>('bah_table');
    assert.ok(start['E-4'], 'seeded with pay grades');

    const body: Record<string, string> = {};
    for (const rank of Object.keys(start)) {
      body[`f.${rank}.with_deps`] = (start[rank]!.with_deps! / 100).toFixed(2);
      body[`f.${rank}.without_deps`] = (start[rank]!.without_deps! / 100).toFixed(2);
    }
    body['f.E-4.with_deps'] = '2100.00';       // edit one
    body['drop.E-5'] = '1';                     // remove one
    body['add.key'] = 'E-7';                    // add one
    body['add.with_deps'] = '2400.00';
    body['add.without_deps'] = '2000.00';
    const res = await post(base, '/admin/settings', { key: 'bah_table', property: '', ...body }, cookie);
    assert.equal(res.status, 303);

    const after = val<Record<string, Record<string, number>>>('bah_table');
    assert.equal(after['E-4']!.with_deps, 210000, 'edited grade stored in cents');
    assert.equal(after['E-5'], undefined, 'removed grade is gone');
    assert.deepEqual(after['E-7'], { with_deps: 240000, without_deps: 200000 }, 'added grade');
    assert.ok(after['O-3'], 'untouched grades survive');
  } finally {
    close();
  }
});

test('a property override saves, is badged, and can be handed back to the org default', async () => {
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@setpage.test');
    await post(base, '/admin/settings', { key: 'nsf_fee_cents', property: '', f: '35.00' }, cookie);

    await post(base, '/admin/settings', { key: 'nsf_fee_cents', property: propId, f: '60.00' }, cookie);
    assert.equal(val<number>('nsf_fee_cents'), 3500, 'the org default is untouched');
    assert.equal(val<number>('nsf_fee_cents', propId), 6000, 'the property differs');

    const page = await get(base, `/admin/settings?property=${propId}`, cookie);
    assert.match(page.text, /overridden here/, 'the page says which settings differ here');
    assert.match(page.text, /Use the organization default/);

    await post(base, '/admin/settings/clear', { key: 'nsf_fee_cents', property: propId }, cookie);
    assert.equal(val<number>('nsf_fee_cents', propId), 3500, 'back to the org default');
  } finally {
    close();
  }
});
