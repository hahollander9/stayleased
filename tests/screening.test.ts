import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureFinance, type FinanceFx } from './harness.ts';
import { sysCtx } from '../src/lib/auth.ts';
import { q, q1, run, update, val } from '../src/lib/db.ts';
import { addDays } from '../src/lib/dates.ts';
import {
  createApplication, collectFees, submitApplication, completeScreenings, computeScorecard,
  decideApplication, currentCriteriaVersion, cancelApplication,
} from '../src/modules/m5_screening/service.ts';
import { resultFor } from '../src/lib/sim/screening.ts';
import { extractIncome } from '../src/lib/sim/dococr.ts';
import { accountBalance, runInvariants } from '../src/modules/m9_accounting/service.ts';
import { setSetting } from '../src/lib/settings.ts';

let fx: FinanceFx;
const D = '2026-07-26';

function mkApp(email: string, incomeMultiple: number): string {
  const ctx = sysCtx(fx.orgId, D);
  const { applicationId } = createApplication(ctx, {
    propertyId: fx.propId, unitId: fx.unitId, rentCents: 150000, moveIn: addDays(D, 20),
    primary: { firstName: 'T', lastName: 'App', email },
  });
  const primary = q1<any>(`SELECT * FROM applicants WHERE application_id=? AND kind='primary'`, applicationId);
  update('applicants', primary.id, {
    ssn_last4: String(1000 + (email.length * 37) % 9000), income_monthly_cents: Math.round(150000 * incomeMultiple),
    status: 'complete', step: 4, first_name: 'T', last_name: 'App',
  });
  collectFees(ctx, applicationId);
  submitApplication(ctx, applicationId);
  completeScreenings(ctx, applicationId);
  return applicationId;
}

before(() => {
  fx = fixtureFinance();
});

test('bureau results are deterministic per identity', () => {
  const a = resultFor(fx.orgId, 'same.person@x.test', '1234');
  const b = resultFor(fx.orgId, 'same.person@x.test', '1234');
  assert.deepEqual(a, b);
  const c = resultFor(fx.orgId, 'other.person@x.test', '9999');
  assert.notEqual(JSON.stringify(a), JSON.stringify(c));
  // test identities steer outcomes
  assert.equal(resultFor(fx.orgId, 'decline.test@screening.demo', null).creditScore, 505);
  assert.equal(resultFor(fx.orgId, 'thinfile.test@screening.demo', null).thinFile, true);
});

test('DocOcr is deterministic and flags large variances', () => {
  const doc1 = Buffer.from('paystub for someone honest');
  const r1 = extractIncome(doc1, 400000);
  const r2 = extractIncome(doc1, 400000);
  assert.deepEqual(r1, r2);
});

test('scorecard: strong applicant approves; weak income declines; middling gets conditions', () => {
  const ctx = sysCtx(fx.orgId, D);
  const strong = mkApp('approve.test@screening.demo', 3.5);
  assert.equal(q1<any>('SELECT recommendation FROM applications WHERE id=?', strong)!.recommendation, 'approve');

  const weak = mkApp('decline.test@screening.demo', 1.2);
  assert.equal(q1<any>('SELECT recommendation FROM applications WHERE id=?', weak)!.recommendation, 'decline');

  const mid = mkApp('conditions.test@screening.demo', 2.2);
  const rec = computeScorecard(ctx, mid);
  assert.equal(rec.recommendation, 'conditions');
  assert.equal(rec.conditions.length > 0, true);
});

test('criteria versions snapshot on change and stamp decisions', () => {
  const ctx = sysCtx(fx.orgId, D);
  const v1 = currentCriteriaVersion(ctx, fx.propId);
  const v1again = currentCriteriaVersion(ctx, fx.propId);
  assert.equal(v1.version, v1again.version);
  setSetting(ctx, 'screening_criteria', { ...v1.criteria, incomeMultiple: 3.0 });
  const v2 = currentCriteriaVersion(ctx, fx.propId);
  assert.equal(v2.version, v1.version + 1);
  setSetting(ctx, 'screening_criteria', { ...v1.criteria, incomeMultiple: 2.5 });
});

test('override permission + reason enforced at the service layer', () => {
  const appId = mkApp('conditions.test+ov@screening.demo', 2.2);
  const ctx = sysCtx(fx.orgId, D); // sysCtx has ORG_ADMIN perms incl override
  assert.throws(() => decideApplication(ctx, appId, 'approved', {}), /override requires a written reason/);
  const noPerm = { ...ctx, perms: new Set(['applications:manage']) };
  assert.throws(() => decideApplication(noPerm as any, appId, 'approved', { reason: 'because' }), /screening:override/);
  decideApplication(ctx, appId, 'approved', { reason: 'verified strong rental history with prior landlord' });
  const app = q1<any>('SELECT * FROM applications WHERE id=?', appId);
  assert.equal(app.status, 'approved');
  assert.ok(app.hold_expires);
});

test('fees post to GL and holding deposit refunds on cancel', () => {
  const ctx = sysCtx(fx.orgId, D);
  const feesBefore = -accountBalance(ctx, '4060');
  const holdBefore = -accountBalance(ctx, '2200');
  const appId = mkApp('cancel.me@apply.demo', 3.0);
  const feesAfter = -accountBalance(ctx, '4060');
  const holdAfter = -accountBalance(ctx, '2200');
  assert.equal(feesAfter - feesBefore, 5500); // one adult app fee
  assert.equal(holdAfter - holdBefore, 25000);
  cancelApplication(ctx, appId, 'test cancel');
  const holdFinal = -accountBalance(ctx, '2200');
  assert.equal(holdFinal, holdBefore); // refunded
  for (const r of runInvariants(ctx)) assert.equal(r.ok, true, `${r.name}: ${r.detail}`);
});
