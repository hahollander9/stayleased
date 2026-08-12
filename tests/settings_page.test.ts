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
      'f.graceDays': '5', 'f.type': 'flat', 'f.flatCents': '75.00', 'f.percent': '5',
      'f.dailyCents': '10.00', 'f.dailyCapCents': '200.00', 'f.minBalanceCents': '25.00',
    }, cookie);
    assert.deepEqual(val('late_fee_policy'), {
      graceDays: 5, type: 'flat', flatCents: 7500, percent: 5, dailyCents: 1000, dailyCapCents: 20000, minBalanceCents: 2500,
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
      'f.graceDays': '400', 'f.type': 'flat', 'f.flatCents': '10.00', 'f.percent': '5',
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

test('the late-fee structures offered are exactly the ones the engine implements', async () => {
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@setpage.test');
    const page = await get(base, '/admin/settings', cookie);
    // lateFeeCandidates branches on flat | flat_plus_daily | percent. An option
    // it has no branch for would assess nothing at all, silently.
    assert.match(page.text, /value="percent"/, 'percent is offered — the engine implements it');
    assert.doesNotMatch(page.text, /value="daily"/, 'a daily-only structure the engine ignores is not offered');

    const res = await post(base, '/admin/settings', {
      key: 'late_fee_policy', property: '',
      'f.graceDays': '3', 'f.type': 'percent', 'f.flatCents': '50.00', 'f.percent': '5',
      'f.dailyCents': '10.00', 'f.dailyCapCents': '150.00', 'f.minBalanceCents': '50.00',
    }, cookie);
    assert.equal(res.status, 303);
    const policy = val<Record<string, unknown>>('late_fee_policy');
    assert.equal(policy.type, 'percent');
    assert.equal(policy.percent, 5, 'the percentage the engine reads is stored, not dropped');
  } finally {
    close();
  }
});

test('blank and negative numbers are refused rather than silently becoming zero', async () => {
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@setpage.test');

    // Number('') === 0 would have zeroed the income test for every applicant
    const before = val<Record<string, number>>('screening_criteria');
    const blank = await post(base, '/admin/settings', {
      key: 'screening_criteria', property: '',
      'f.incomeMultiple': '', 'f.minCreditScore': '640', 'f.conditionalCreditScore': '580',
      'f.conditionalDepositMultiplier': '2', 'f.evictionLookbackYears': '7', 'f.felonyLookbackYears': '7',
    }, cookie);
    assert.equal(blank.status, 303);
    assert.equal(val<Record<string, number>>('screening_criteria').incomeMultiple, before.incomeMultiple, 'unchanged');

    const blankPct = await post(base, '/admin/settings', { key: 'deposit_interest_pct', property: '', f: '' }, cookie);
    assert.equal(blankPct.status, 303);

    // a negative threshold inverts the rule it configures
    const je = val<number>('je_approval_threshold_cents');
    await post(base, '/admin/settings', { key: 'je_approval_threshold_cents', property: '', f: '-500.00' }, cookie);
    assert.equal(val<number>('je_approval_threshold_cents'), je, 'negative money refused');

    const blankMoney = await post(base, '/admin/settings', { key: 'nsf_fee_cents', property: '', f: '' }, cookie);
    assert.equal(blankMoney.status, 303);
    assert.notEqual(val<number>('nsf_fee_cents'), 0, 'a cleared money box is not zero');
  } finally {
    close();
  }
});

test('the matrix leaves rows this form never saw alone, and refuses nonsense keys', async () => {
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@setpage.test');
    const start = val<Record<string, Record<string, number>>>('bah_table');
    const stale: Record<string, string> = {};
    for (const rank of Object.keys(start)) {
      stale[`f.${rank}.with_deps`] = (start[rank]!.with_deps! / 100).toFixed(2);
      stale[`f.${rank}.without_deps`] = (start[rank]!.without_deps! / 100).toFixed(2);
    }

    // someone else adds a grade after this page was rendered
    await post(base, '/admin/settings', {
      key: 'bah_table', property: '', ...stale,
      'add.key': 'E-9', 'add.with_deps': '2600.00', 'add.without_deps': '2200.00',
    }, cookie);
    assert.ok(val<Record<string, unknown>>('bah_table')['E-9'], 'E-9 added');

    // the stale form (no E-9 fields) must not read it as blank and zero it
    await post(base, '/admin/settings', { key: 'bah_table', property: '', ...stale }, cookie);
    const after = val<Record<string, Record<string, number>>>('bah_table');
    assert.deepEqual(after['E-9'], { with_deps: 260000, without_deps: 220000 }, 'the row this form never saw is untouched');

    // a prototype key must become data, not a silent no-op
    await post(base, '/admin/settings', {
      key: 'bah_table', property: '', ...stale,
      'add.key': '__proto__', 'add.with_deps': '10.00', 'add.without_deps': '10.00',
    }, cookie);
    const proto = val<Record<string, unknown>>('bah_table');
    assert.ok(Object.prototype.hasOwnProperty.call(proto, '__proto__'), 'stored as an own property');
    assert.equal(({} as Record<string, unknown>).polluted, undefined, 'nothing leaked onto Object.prototype');

    // amounts with no pay grade beside them are a mistake, not a silent drop
    const nameless = await post(base, '/admin/settings', {
      key: 'bah_table', property: '', ...stale, 'add.key': '', 'add.with_deps': '99.00', 'add.without_deps': '99.00',
    }, cookie);
    assert.equal(nameless.status, 303);
    assert.equal(Object.keys(val<Record<string, unknown>>('bah_table')).includes(''), false);
  } finally {
    close();
  }
});

test('a partial property override renders merged, so saving cannot pin the untouched dials', async () => {
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@setpage.test');
    // org sets every dial to approve
    await post(base, '/admin/settings', {
      key: 'ai_autonomy', property: '',
      'f.leasing': 'approve', 'f.maintenance': 'approve', 'f.payments': 'approve', 'f.renewals': 'approve',
    }, cookie);
    // a PARTIAL property override, as m17 writes them
    insert('settings', {
      id: id('set'), org_id: orgId, property_id: propId, key: 'ai_autonomy',
      value: JSON.stringify({ leasing: 'auto' }), updated_at: nowIso(),
    });

    const page = await get(base, `/admin/settings?property=${propId}`, cookie);
    // the three dials the property does not override must render the ORG value
    const block = page.text.slice(page.text.indexOf('Autonomy by area'), page.text.indexOf('Autonomy by area') + 4000);
    assert.equal((block.match(/value="approve" selected/g) || []).length, 3, 'maintenance, payments and renewals show the org value');
    assert.match(block, /value="auto" selected/, 'and leasing shows the property override');
  } finally {
    close();
  }
});

/** Parse a rendered settings form the way a browser would submit it: every
 * input's rendered value, every selected option, every CHECKED checkbox (an
 * unchecked one sends nothing), and nothing else. Deliberately reads the real
 * markup rather than reconstructing a body from the spec — a body built from
 * the spec would agree with the spec even when the form disagrees with both. */
function formsOn(page: string): { key: string; body: Record<string, string> }[] {
  const out: { key: string; body: Record<string, string> }[] = [];
  for (const chunk of page.split('<form method="post" action="/admin/settings">').slice(1)) {
    const form = chunk.slice(0, chunk.indexOf('</form>'));
    const body: Record<string, string> = {};
    for (const m of form.matchAll(/<input\b([^>]*)>/g)) {
      const attrs = m[1]!;
      const name = /name="([^"]*)"/.exec(attrs)?.[1];
      if (!name) continue;
      const isCheckbox = /type="checkbox"/.test(attrs);
      if (isCheckbox && !/\bchecked\b/.test(attrs)) continue; // unchecked sends nothing
      body[name] = (/value="([^"]*)"/.exec(attrs)?.[1] ?? '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    }
    for (const m of form.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
      const name = /name="([^"]*)"/.exec(m[1]!)?.[1];
      if (!name) continue;
      const sel = /<option value="([^"]*)"\s+selected>/.exec(m[2]!);
      body[name] = sel ? sel[1]! : (/<option value="([^"]*)"/.exec(m[2]!)?.[1] ?? '');
    }
    const key = body.key;
    if (key) out.push({ key, body });
  }
  return out;
}

test('every setting round-trips: submitting the form exactly as rendered saves it unchanged', async () => {
  // The class of bug this exists for: a sub-field missing from the default
  // object renders as an empty box, so the very first save of an untouched
  // org fails — or worse, stores something the form never showed. A test that
  // hand-writes the POST body cannot see it, because it supplies the value the
  // form omitted. This drives the real markup instead.
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@setpage.test');
    const page = await get(base, '/admin/settings', cookie);
    const forms = formsOn(page.text);
    assert.equal(forms.length, SPECS.length, 'one editable form per setting');

    for (const { key, body } of forms) {
      // deep-equal, not stringified: a spec may declare sub-fields in a
      // different order than the default object lists them, and key order in
      // stored JSON means nothing to any consumer
      const before = structuredClone(val(key));
      const res = await post(base, '/admin/settings', body, cookie);
      assert.equal(res.status, 303, `${key}: submitting the rendered form should be accepted`);
      const flash = await get(base, res.location!.replace(/^[^/]*/, ''), cookie);
      assert.doesNotMatch(
        flash.text, /class="flash err"/,
        `${key}: submitting the form exactly as rendered was rejected — the form renders a value the parse will not take`,
      );
      assert.deepEqual(val(key), before, `${key}: a no-op save changed the stored value`);
    }
  } finally {
    close();
  }
});

test('every sub-field a spec declares exists in that setting default', () => {
  // the render side of the same class: a declared path with no value renders
  // an empty control, which for a required type cannot be saved back
  const missing: string[] = [];
  for (const spec of SPECS) {
    if (!spec.subs) continue;
    const def = SETTING_DEFAULTS[spec.key] as Record<string, unknown>;
    for (const sub of spec.subs) {
      if (def === null || typeof def !== 'object' || !(sub.path in def)) missing.push(`${spec.key}.${sub.path}`);
    }
  }
  assert.deepEqual(missing, [], 'these controls render empty because the default object has no such field');
});

test('a deleted pay grade stays deleted — the render must not merge a default row back in', async () => {
  // Regression guard for the merge fix: closed-shape settings merge levels so
  // a partial override does not show code defaults, but an open-ended key map
  // must REPLACE. Merging re-supplies whatever the operator just removed, and
  // the next save writes it back — deletion becomes impossible.
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@setpage.test');
    // earlier tests in this file mutate the table, so pick a grade that is
    // actually present right now rather than assuming the shipped defaults
    const start = val<Record<string, Record<string, number>>>('bah_table');
    const doomed = Object.keys(start).find((r) => r in (SETTING_DEFAULTS.bah_table as Record<string, unknown>));
    assert.ok(doomed, 'a grade that also exists in the code defaults — the one a merge would resurrect');

    const body: Record<string, string> = { key: 'bah_table', property: '', [`drop.${doomed}`]: '1' };
    for (const rank of Object.keys(start)) {
      body[`f.${rank}.with_deps`] = (start[rank]!.with_deps! / 100).toFixed(2);
      body[`f.${rank}.without_deps`] = (start[rank]!.without_deps! / 100).toFixed(2);
    }
    await post(base, '/admin/settings', body, cookie);
    assert.equal(val<Record<string, unknown>>('bah_table')[doomed!], undefined, `stored without ${doomed}`);

    // …and the PAGE must agree, or the next save silently resurrects it
    const page = await get(base, '/admin/settings', cookie);
    const matrix = page.text.slice(page.text.indexOf('BAH rates by pay grade'));
    assert.doesNotMatch(matrix.slice(0, 6000), new RegExp(`f\\.${doomed}\\.with_deps`), 'the deleted grade is gone from the form too');

    // prove it round-trips: resubmitting the rendered form keeps it deleted
    const forms = formsOn(page.text).filter((f) => f.key === 'bah_table');
    assert.equal(forms.length, 1);
    await post(base, '/admin/settings', forms[0]!.body, cookie);
    assert.equal(val<Record<string, unknown>>('bah_table')[doomed!], undefined, 'still gone after a no-op save');
  } finally {
    close();
  }
});
