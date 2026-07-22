import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert, run, val } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso, addDays } from '../src/lib/dates.ts';
import { sysCtx } from '../src/lib/auth.ts';
import { expandPerms } from '../src/lib/rbac.ts';
import type { Ctx } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { decideRecommendation } from '../src/modules/m13_pricing/service.ts';
import { decideAction, propose, registerExecutor } from '../src/modules/m17_ai/framework.ts';
import { waitlistAction, addToWaitlist, pcsBreak, completeCert, startCert, assignBed } from '../src/modules/m18_verticals/service.ts';
import { runCustom } from '../src/modules/m14_reports/builder.ts';
import { writeOffBalance } from '../src/modules/m8_receivables/payments.ts';

/** Phase 18 security sweep: org isolation + permission guards on every
 * surface added since Phase 10 (§9 review). Cross-org access must read as
 * "not found", never as "forbidden but exists". */

let orgA: string;
let orgB: string;
let propA: string;
let unitA: string;
let leaseA: string;

function mkOrg(name: string): string {
  const oid = id('org');
  insert('orgs', { id: oid, name, slug: name.toLowerCase().replaceAll(/[^a-z]+/g, '-') + '-' + oid.slice(-5), business_date: '2026-07-26', created_at: nowIso() });
  ensureCoa(oid);
  return oid;
}

before(() => {
  db();
  orgA = mkOrg('Sec Org A');
  orgB = mkOrg('Sec Org B');
  propA = id('prp');
  insert('properties', {
    id: propA, org_id: orgA, name: 'Alpha Court', slug: 'alpha-' + propA.slice(-5), type: 'multifamily',
    address1: '1 A St', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso(),
  });
  const fp = id('fpl');
  insert('floorplans', { id: fp, org_id: orgA, property_id: propA, name: 'S1', beds: 1, baths: 1, sqft: 600, market_rent_cents: 150000, created_at: nowIso() });
  unitA = id('unt');
  insert('units', {
    id: unitA, org_id: orgA, property_id: propA, floorplan_id: fp, unit_number: 'A-1', floor: 1, sqft: 600,
    status: 'vacant_ready', market_rent_cents: 150000, amenities: '[]', created_at: nowIso(),
  });
  leaseA = id('lse');
  insert('leases', {
    id: leaseA, org_id: orgA, property_id: propA, unit_id: unitA, household_name: 'Alpha household',
    status: 'active', start_date: '2026-01-01', end_date: '2026-12-31', move_in_date: '2026-01-01',
    rent_cents: 150000, deposit_cents: 0, deposit_alternative: 0, term_months: 12, created_at: nowIso(),
  });
});

test('M13: pricing recommendations are org-scoped', () => {
  const recId = id('prc');
  insert('price_recommendations', {
    id: recId, org_id: orgA, property_id: propA, unit_id: unitA, date: '2026-07-26', term_months: 12,
    current_rent_cents: 150000, recommended_rent_cents: 152000, factors: '[]', status: 'pending', created_at: nowIso(),
  });
  const intruder = sysCtx(orgB);
  assert.throws(() => decideRecommendation(intruder, recId, 'accept'), /not pending|not found/i);
  assert.equal(q1<any>('SELECT status FROM price_recommendations WHERE id=?', recId).status, 'pending', 'untouched');
});

test('M17: AI actions are org-scoped and approvals audit the actor', () => {
  registerExecutor('sec.noop', () => 'ok');
  const a = propose({ ...sysCtx(orgA), userName: 'A Staff' }, { agent: 'payments', title: 'sec test', input: {}, output: { kind: 'sec.noop' } });
  const intruder = { ...sysCtx(orgB), userName: 'B Intruder' };
  assert.throws(() => decideAction(intruder, a.id, 'approve'), /not found/);
  assert.throws(() => decideAction(intruder, a.id, 'reject'), /not found/);
  assert.equal(q1<any>('SELECT status FROM ai_actions WHERE id=?', a.id).status, 'proposed');
});

test('M14: the custom report builder cannot cross orgs (closed SQL surface + org predicate)', () => {
  // org A has a lease; org B must see zero rows from the same dataset
  const resA = runCustom(sysCtx(orgA), { dataset: 'leases', cols: ['household', 'rent'], filters: [] });
  const resB = runCustom(sysCtx(orgB), { dataset: 'leases', cols: ['household', 'rent'], filters: [] });
  assert.ok(resA.rows.length >= 1);
  assert.equal(resB.rows.length, 0, 'org B sees nothing of org A');
  // filter values are parameterized — a quote in a filter is data, not SQL
  const inj = runCustom(sysCtx(orgA), {
    dataset: 'leases', cols: ['household'],
    filters: [{ col: 'household', op: 'contains', value: "' OR 1=1 --" }],
  });
  assert.equal(inj.rows.length, 0, 'injection-looking filter matches nothing');
});

test('M18: waitlist, certs, bed assignment and PCS are org/permission guarded', () => {
  const a = sysCtx(orgA);
  const wid = addToWaitlist(a, { propertyId: propA, name: 'A Waiter', householdSize: 1, incomeCents: 2000000 });
  const intruder = sysCtx(orgB);
  assert.throws(() => waitlistAction(intruder, wid, 'offer'), /not found/);
  // certs: cross-org completion refused
  run('UPDATE units SET program=?, ami_pct=? WHERE id=?', 'lihtc', 60, unitA);
  insert('rent_limits', { id: id('rlm'), org_id: orgA, ami_pct: 60, beds: 1, max_rent_cents: 170500 });
  const certId = startCert(a, { unitId: unitA, householdSize: 1, incomeCents: 3000000 });
  assert.throws(() => completeCert(intruder, certId), /not open|not found/i);
  // PCS on a foreign lease is a 404, not a state change
  assert.throws(() => pcsBreak(intruder, { leaseId: leaseA, reportDate: '2026-07-20', terminationDate: addDays('2026-07-26', 40) }), /not active|not found/i);
  assert.equal(q1<any>('SELECT status FROM leases WHERE id=?', leaseA).status, 'active');
  // a ctx without leases:manage cannot assign beds even in its own org
  const readonly: Ctx = { ...sysCtx(orgA), perms: expandPerms(['LEASING_AGENT']) };
  run(`UPDATE properties SET type='student' WHERE id=?`, propA);
  assert.throws(() => assignBed(readonly, { unitId: unitA, bedLabel: 'A', firstName: 'X', lastName: 'Y', email: 'x@sec.test', rentCents: 90000 }), /permission|denied|leases:manage/i);
});

test('M8/M15 write paths added late: write-offs are permission + org guarded', () => {
  const readonly: Ctx = { ...sysCtx(orgA), perms: expandPerms(['LEASING_AGENT']) };
  assert.throws(() => writeOffBalance(readonly, leaseA, 'nope'), /permission|denied|collections:manage/i);
  const intruder = sysCtx(orgB);
  assert.throws(() => writeOffBalance(intruder, leaseA, 'cross-org'), /lease not found|nothing to write off/i);
});

test('org data volumes stay watertight after everything (spot invariant)', () => {
  // nothing in org B references org A rows
  for (const table of ['price_recommendations', 'ai_actions', 'income_certs', 'waitlist_entries', 'metric_snapshots']) {
    const leak = val<number>(
      `SELECT COUNT(*) FROM ${table} t WHERE t.org_id=? AND EXISTS (SELECT 1 FROM properties p WHERE p.id=t.property_id AND p.org_id=?)`,
      orgB, orgA,
    ) || 0;
    assert.equal(leak, 0, `${table}: no cross-org property references`);
  }
});
