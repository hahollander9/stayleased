import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureTwoOrgs, startTestServer, loginAs, get, post, type TwoOrgs } from './harness.ts';

/** Tenant isolation (§4.4/§9): a user of Org A must receive 403/404 for every
 * Org B entity across representative endpoints of every module. This file
 * grows as modules land. */

let fx: TwoOrgs;
let base: string;
let close: () => void;
let cookieA: string;

before(async () => {
  fx = fixtureTwoOrgs();
  const srv = await startTestServer();
  base = srv.base;
  close = srv.close;
  cookieA = await loginAs(base, fx.adminA);
});

after(() => close());

test('staff record of another org is invisible', async () => {
  const mine = await get(base, `/admin/staff/${fx.userAId}`, cookieA);
  assert.equal(mine.status, 200);
  const theirs = await get(base, `/admin/staff/${fx.userBId}`, cookieA);
  assert.equal(theirs.status, 404);
});

test('cannot switch property context into another org', async () => {
  const resp = await post(base, '/switch-property', { property_id: fx.propB }, cookieA);
  assert.equal(resp.status, 403);
});

test('impersonation across orgs is blocked', async () => {
  const resp = await post(base, `/admin/impersonate/${fx.userBId}`, {}, cookieA);
  assert.equal(resp.status, 404);
});

test('file downloads are org-scoped', async () => {
  const cookieB = await loginAs(base, fx.adminB);
  const ok = await get(base, `/f/${fx.fileA}`, cookieA);
  assert.equal(ok.status, 200);
  const denied = await get(base, `/f/${fx.fileA}`, cookieB);
  assert.equal(denied.status, 403);
});

test('API keys are org-scoped', async () => {
  const a = await fetch(`${base}/api/v1/properties`, { headers: { 'x-api-key': fx.apiKeyA } });
  const dataA = (await a.json()) as { data: { id: string }[] };
  assert.equal(dataA.data.some((p) => p.id === fx.propA), true);
  assert.equal(dataA.data.some((p) => p.id === fx.propB), false);

  const bad = await fetch(`${base}/api/v1/properties`, { headers: { 'x-api-key': 'ok_nope' } });
  assert.equal(bad.status, 401);

  const unitsB = await fetch(`${base}/api/v1/units?property_id=${fx.propB}`, { headers: { 'x-api-key': fx.apiKeyA } });
  const ub = (await unitsB.json()) as { data: unknown[] };
  assert.equal(ub.data.length, 0);
});

test('property and unit records of another org are invisible (M2)', async () => {
  const mine = await get(base, `/properties/${fx.propA}`, cookieA);
  assert.equal(mine.status, 200);
  const theirs = await get(base, `/properties/${fx.propB}`, cookieA);
  assert.equal(theirs.status, 404);
  const editTheirs = await post(base, `/properties/${fx.propB}/edit`, { name: 'Hacked' }, cookieA);
  assert.equal(editTheirs.status, 404);
});

test('unauthenticated staff pages redirect to login', async () => {
  const resp = await get(base, '/admin/staff');
  assert.equal(resp.status, 303);
});

test('permission enforcement: tech cannot open admin', async () => {
  // seed fixture uses ORG_ADMINs; create a low-privilege user via org A admin UI
  const created = await post(
    base,
    '/admin/staff/new',
    { name: 'Iso Tech', email: 'tech@iso-a.test', role: 'MAINTENANCE_TECH', scope_type: 'org' },
    cookieA,
  );
  assert.equal(created.status, 303);
  const cookieTech = await loginAs(base, 'tech@iso-a.test');
  const denied = await get(base, '/admin/staff', cookieTech);
  assert.equal(denied.status, 403);
  const deniedJobs = await get(base, '/admin/jobs', cookieTech);
  assert.equal(deniedJobs.status, 403);
});
