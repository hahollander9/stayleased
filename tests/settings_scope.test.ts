import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/lib/db.ts';
import { SETTING_DEFAULTS } from '../src/lib/settings.ts';
import { SPECS } from '../src/modules/m1_admin/settings_spec.ts';

/** Does a per-property override actually REACH the code that acts on it?
 *
 * /admin/settings offers every setting at the property level, and stores an
 * override as only the fields that DIFFER from the organization. Two things
 * then have to be true at every read, and neither is checkable by the compiler:
 *
 *   1. the call passes a property id — `getSetting(ctx, key)` never looks at
 *      the property level, so the override is silently inert;
 *   2. an object-valued setting uses `getSettingMerged` — `getSetting` swaps a
 *      stored object wholesale, so a partial override leaves every field the
 *      operator did NOT change `undefined`. That is not a cosmetic loss:
 *      `addDays(due, undefined)` throws RangeError out of the nightly late-fee
 *      job, and `hours.days.includes(...)` 500s the public tour page.
 *
 * Both were violated in 20 places while the settings page itself was correct,
 * because the mechanism had only ever been exercised with whole-object saves.
 * This test fails the class of bug, not the instances — the same bargain
 * `specCoverage()` makes for unrendered settings. A setting that genuinely has
 * no property dimension declares `orgOnly` on its spec and says so on screen.
 *
 * Reads with a non-literal key (the settings page editing an arbitrary key,
 * onboarding's `onb_skip_<step>`) cannot be resolved statically and are skipped;
 * so are keys absent from SETTING_DEFAULTS, which the settings page cannot
 * reach at all. */

const SRC = join(ROOT, 'src');
// the hierarchy's own implementation, and the one helper that reads a scorer's
// org-wide rollout mode on purpose
const EXEMPT_FILES = new Set(['src/lib/settings.ts']);

interface Read { file: string; line: number; fn: string; key: string; hasProperty: boolean }

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/** Split a call's argument list at top level — commas inside nested parens,
 * brackets, braces, generics or strings are not argument separators. Returns
 * the arguments and the index just past the closing paren. */
function args(src: string, open: number): { list: string[]; end: number } {
  const list: string[] = [];
  let depth = 0, start = open + 1, i = open, quote = '';
  for (; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      depth--;
      if (depth === 0) { list.push(src.slice(start, i)); break; }
    } else if (c === ',' && depth === 1) { list.push(src.slice(start, i)); start = i + 1; }
  }
  return { list: list.map((a) => a.trim()).filter((a, n) => n > 0 || a !== ''), end: i + 1 };
}

function scan(): Read[] {
  const out: Read[] = [];
  for (const file of tsFiles(SRC)) {
    const rel = file.slice(ROOT.length + 1);
    if (EXEMPT_FILES.has(rel)) continue;
    const src = readFileSync(file, 'utf8');
    const call = /\bgetSetting(Merged)?\s*/g;
    for (let m = call.exec(src); m; m = call.exec(src)) {
      // the type argument is optional and may itself contain `;`, `<` and `>`
      // (`getSetting<{ start: string; end: string }>(…)`), so walk it rather
      // than trying to spell it as a regex
      let open = m.index + m[0].length;
      if (src[open] === '<') {
        let depth = 0;
        for (; open < src.length; open++) {
          if (src[open] === '<') depth++;
          else if (src[open] === '>' && --depth === 0) { open++; break; }
        }
        while (/\s/.test(src[open] || '')) open++;
      }
      if (src[open] !== '(') continue; // an import, a re-export, a mention in prose
      const { list } = args(src, open);
      const literal = /^'([^']+)'$/.exec(list[1] || '');
      if (!literal) continue; // dynamic key — the settings page itself, onboarding flags
      const third = list[2];
      out.push({
        file: rel,
        line: src.slice(0, m.index).split('\n').length,
        fn: m[1] ? 'getSettingMerged' : 'getSetting',
        key: literal[1]!,
        // `null` is how the settings page asks for the organization level on purpose
        hasProperty: third !== undefined && third !== 'null',
      });
    }
  }
  return out;
}

const READS = scan().filter((r) => r.key in SETTING_DEFAULTS);
const isObject = (v: unknown): boolean => !!v && typeof v === 'object' && !Array.isArray(v);
const specFor = (key: string) => SPECS.find((s) => s.key === key);
const at = (r: Read): string => `${r.file}:${r.line} (${r.key})`;

test('the scanner sees the real call sites — a silent zero would pass everything', () => {
  // a scanner that silently matches nothing would make every rule below vacuous
  assert.ok(READS.length >= 40, `only found ${READS.length} settings reads; the scanner is broken`);
  assert.ok(new Set(READS.map((r) => r.key)).size >= 25, 'too few distinct settings seen');
  assert.ok(
    READS.some((r) => r.key === 'late_fee_policy' && r.fn === 'getSettingMerged' && r.hasProperty),
    'the late fee — the setting whose partial override threw RangeError out of the nightly job — is not being seen as a merged, property-scoped read',
  );
});

test('an object setting read at a property MERGES — a partial override must not blank the rest', () => {
  // Arrays and matrix specs (BAH rates) are stored whole, so replacing is right
  // for them: a merge could not express "the operator deleted this row".
  const offenders = READS.filter((r) =>
    r.hasProperty
    && r.fn === 'getSetting'
    && isObject(SETTING_DEFAULTS[r.key])
    && !specFor(r.key)?.matrix,
  );
  assert.deepEqual(
    offenders.map(at), [],
    'these read a partial property override with getSetting, so every field the operator did not change comes back undefined — use getSettingMerged',
  );
});

test('every property-overridable setting is READ with a property — or declared org-wide', () => {
  const offenders = READS.filter((r) => !r.hasProperty && !specFor(r.key)?.orgOnly);
  assert.deepEqual(
    offenders.map(at), [],
    'the settings page offers these per property but the product reads them org-wide, so the override does nothing — pass the property id, or mark the spec orgOnly',
  );
});

test('orgOnly is a claim about the code — no such setting is ever read with a property', () => {
  const offenders = READS.filter((r) => r.hasProperty && specFor(r.key)?.orgOnly);
  assert.deepEqual(
    offenders.map(at), [],
    'declared org-wide on the settings page but read with a property id — one of the two is lying',
  );
});

// ---------------------------------------------------------------------------
// The lint above proves the CALL is shaped right. These prove the OVERRIDE
// arrives: a property that changes one field of a setting, exercised through
// the function production actually calls. Simulated whole-object saves are how
// this shipped broken — a partial override is the shape an operator produces
// by editing one box, and it was never run through the consumers.
// ---------------------------------------------------------------------------

import { before, test as btest } from 'node:test';
import { db, q1, insert } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { sysCtx } from '../src/lib/auth.ts';
import { setSetting } from '../src/lib/settings.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { createCharge } from '../src/modules/m8_receivables/service.ts';
import { lateFeeCandidates } from '../src/modules/m8_receivables/payments.ts';
import { tourSlots } from '../src/modules/m3_crm/service.ts';
import { inQuietHours } from '../src/modules/m15_comms/service.ts';
import { academicCalendar } from '../src/modules/m18_verticals/service.ts';
import { depositDeadline } from '../src/modules/m8_receivables/depositlaw.ts';

const BD = '2026-08-05';
let org = '', prop = '', lease = '';

before(() => {
  db();
  org = id('org');
  insert('orgs', { id: org, name: 'Scope Co', slug: 'scope-' + org.slice(-6), business_date: BD, kind: 'live', created_at: nowIso() });
  ensureCoa(org);
  prop = id('prp');
  insert('properties', {
    id: prop, org_id: org, name: 'Override Hall', slug: 'override-hall-' + org.slice(-6), type: 'student',
    address1: '1 Main', city: 'Madison', state: 'WI', zip: '53703', timezone: 'America/Chicago', created_at: nowIso(),
  });
  const unit = id('unt');
  insert('units', {
    id: unit, org_id: org, property_id: prop, unit_number: 'S-1', floor: 1, sqft: 700,
    status: 'occupied', market_rent_cents: 120000, amenities: '[]', created_at: nowIso(),
  });
  lease = id('lse');
  insert('leases', {
    id: lease, org_id: org, property_id: prop, unit_id: unit, household_name: 'Scope household',
    status: 'active', start_date: '2026-01-01', end_date: '2026-12-31', move_in_date: '2026-01-01',
    rent_cents: 120000, deposit_cents: 120000, term_months: 12, created_at: nowIso(),
  });
});

btest('a property that changes only the flat late fee still gets the organization’s grace period', () => {
  const ctx = sysCtx(org, BD);
  setSetting(ctx, 'late_fee_policy', { graceDays: 6, type: 'flat', flatCents: 5000, percent: 5, dailyCents: 0, dailyCapCents: 0, minBalanceCents: 0 }, null);
  // exactly what the settings page stores when one box is edited at a property
  setSetting(ctx, 'late_fee_policy', { flatCents: 7500 }, prop);
  createCharge(sysCtx(org, '2026-08-01'), {
    leaseId: lease, kind: 'rent', label: 'Rent', amountCents: 120000, date: '2026-08-01', dueDate: '2026-08-01', monthKey: '2026-08',
  });
  // before the fix this threw RangeError out of addDays(due, undefined) and took
  // the whole nightly late-fee run down with it, for every property in the org
  const inGrace = lateFeeCandidates(sysCtx(org, '2026-08-05'), '2026-08-05').filter((c) => c.leaseId === lease);
  assert.equal(inGrace.length, 0, 'day 5 of a 6-day grace period the organization set');
  const due = lateFeeCandidates(sysCtx(org, '2026-08-08'), '2026-08-08').filter((c) => c.leaseId === lease);
  assert.equal(due.length, 1, 'past grace, the fee is assessed');
  assert.equal(due[0]!.fee, 7500, 'at the property’s own amount');
});

btest('a property that moves only its first tour slot keeps the organization’s tour days', () => {
  const ctx = sysCtx(org, BD);
  setSetting(ctx, 'tour_hours', { start: '09:00', end: '12:00', days: [0, 1, 2, 3, 4, 5, 6], slotMinutes: 60 }, null);
  setSetting(ctx, 'tour_hours', { start: '10:00' }, prop);
  // this runs on the PUBLIC property site; an undefined `days` was a 500 on a
  // prospect's booking page, not a quiet fallback
  const slots = tourSlots(ctx, prop, '2026-08-05');
  assert.deepEqual(slots, ['10:00', '11:00'], 'property start, organization end and slot length');
});

btest('a property that shifts only the start of quiet hours keeps the organization’s end', () => {
  const ctx = sysCtx(org, BD);
  setSetting(ctx, 'quiet_hours', { start: '21:00', end: '08:00' }, null);
  setSetting(ctx, 'quiet_hours', { start: '22:00' }, prop);
  assert.equal(typeof inQuietHours(ctx, prop), 'boolean', 'no throw on quiet.end.slice of undefined');
});

btest('a student property runs its own academic term, and a half-set term keeps the rest', () => {
  const ctx = sysCtx(org, BD);
  setSetting(ctx, 'academic_calendar', { fallStart: '2026-08-20', fallEnd: '2027-07-31' }, null);
  setSetting(ctx, 'academic_calendar', { fallEnd: '2027-06-30' }, prop);
  const cal = academicCalendar(ctx, prop);
  assert.equal(cal.fallEnd, '2027-06-30', 'the property’s own term end');
  assert.equal(cal.fallStart, '2026-08-20', 'and the organization’s start, not undefined');
});

btest('a deposit deadline the operator chose is honored even when it equals the code default', () => {
  const ctx = sysCtx(org, BD);
  // Wisconsin's statutory deadline is shorter than the 30-day code default, so
  // "did anyone choose 30?" cannot be answered by looking at the number
  const untouched = depositDeadline(ctx, prop, 'WI', '2026-08-01');
  setSetting(ctx, 'deposit_disposition_days', 30, prop);
  const chosen = depositDeadline(ctx, prop, 'WI', '2026-08-01');
  assert.equal(chosen.days, 30, 'the property’s explicit 30 days wins over the state preset');
  assert.notEqual(untouched.days, 30, 'and the state preset applies until someone chooses');
});
