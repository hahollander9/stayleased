import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q1, q, insert, val } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword, sysCtx } from '../src/lib/auth.ts';
import { getSettingMerged } from '../src/lib/settings.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { readPolicyFromLease } from '../src/modules/setup/policy_reader.ts';
import {
  recordProposals, reconcileFindings, pendingProposals, acceptProposal, dismissProposal,
  proposalDelta, type SourcedFinding,
} from '../src/modules/setup/policy_proposals.ts';
import { startTestServer, loginAs, get, post } from './harness.ts';

/** Settings proposed from the documents already uploaded. The rule the whole
 * feature turns on: reading is not writing. A proposal changes nothing until a
 * human confirms it against the sentence it came from. */

const AS_OF = '2026-07-23';
let orgId: string;
let propId: string;

before(() => {
  db();
  const existing = q1<{ id: string }>('SELECT id FROM orgs WHERE slug=?', 'policy-test');
  if (existing) {
    orgId = existing.id;
    propId = q1<{ id: string }>('SELECT id FROM properties WHERE org_id=?', orgId)!.id;
    return;
  }
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'Policy Test Co', slug: 'policy-test', business_date: AS_OF, kind: 'live', created_at: nowIso() });
  const uid = id('usr');
  insert('users', {
    id: uid, org_id: orgId, email: 'admin@policy.test', name: 'Policy Admin',
    kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
  });
  insert('role_assignments', { id: id('ra'), org_id: orgId, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  ensureCoa(orgId);
  propId = id('prp');
  insert('properties', {
    id: propId, org_id: orgId, name: 'Policy Court', slug: 'policy-court', type: 'multifamily',
    address1: '1 Main', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver',
    phone: null, email: null, year_built: null, fiscal_year_start_month: 1, created_at: nowIso(),
  });
});

const ctx = (): ReturnType<typeof sysCtx> => sysCtx(orgId, AS_OF);
const sourced = (text: string, label: string): SourcedFinding[] =>
  readPolicyFromLease(text).map((f) => ({ ...f, sourceLabel: label, sourceFileId: null }));

const LEASE_75 = `RENT. If rent is not received by the 5th day of the month, Resident shall pay a late charge of $75.00.`;
const LEASE_50 = `RENT. If rent is not received by the 5th day of the month, Resident shall pay a late charge of $50.00.`;

test('documents that agree produce one confident proposal; documents that disagree say so', () => {
  const agree = reconcileFindings([...sourced(LEASE_75, 'a.pdf'), ...sourced(LEASE_75, 'b.pdf')]);
  const fee = agree.find((r) => r.path === 'flatCents')!;
  assert.equal(fee.value, 7500);
  assert.equal(fee.confidence, 'high');
  assert.match(fee.agreement, /all 2 documents agree/);

  // a portfolio with two late-fee regimes is a fact the operator needs, not a
  // tie for this code to break quietly
  const split = reconcileFindings([
    ...sourced(LEASE_75, 'a.pdf'), ...sourced(LEASE_75, 'b.pdf'), ...sourced(LEASE_50, 'c.pdf'),
  ]);
  const contested = split.find((r) => r.path === 'flatCents')!;
  assert.equal(contested.value, 7500, 'the value most documents state');
  assert.equal(contested.confidence, 'low', 'but flagged, because they do not agree');
  assert.match(contested.agreement, /2 of 3 documents/);
  assert.match(contested.agreement, /\$50\.00/, 'and names what the others said');
});

test('recording proposals writes no setting', () => {
  const before = getSettingMerged<Record<string, number>>(ctx(), 'late_fee_policy');
  const n = recordProposals(ctx(), { propertyId: propId }, sourced(LEASE_75, 'lease-a.pdf'));
  assert.ok(n >= 2, 'the fee and its grace period');
  assert.deepEqual(
    getSettingMerged<Record<string, number>>(ctx(), 'late_fee_policy'), before,
    'reading is not writing — the setting is untouched until a human confirms',
  );
  const pending = pendingProposals(ctx());
  const fee = pending.find((p) => p.key === 'late_fee_policy' && p.path === 'flatCents')!;
  assert.equal(JSON.parse(fee.value), 7500);
  assert.match(fee.quote!, /late charge of \$75\.00/, 'the sentence travels with the proposal');
  assert.equal(fee.source_label, 'lease-a.pdf');
});

test('a proposal knows whether it conflicts with the value in force', () => {
  const pending = pendingProposals(ctx());
  const fee = pending.find((p) => p.key === 'late_fee_policy' && p.path === 'flatCents')!;
  const d = proposalDelta(ctx(), fee);
  assert.equal(d.proposed, 7500);
  assert.equal(d.current, 5000, 'the shipped default');
  assert.equal(d.conflicts, true, 'which is the signal worth surfacing — it is money');
});

test('accepting writes the setting; dismissing keeps yours and stops the asking', async () => {
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@policy.test');
    const page = await get(base, '/admin/settings', cookie);
    assert.equal(page.status, 200);
    assert.match(page.text, /Read from your documents/);
    assert.match(page.text, /late charge of \$75\.00/, 'the quoted sentence is on the page');
    assert.match(page.text, /differs from your setting/, 'and the conflict is called out');

    const fee = pendingProposals(ctx()).find((p) => p.path === 'flatCents')!;
    const grace = pendingProposals(ctx()).find((p) => p.path === 'graceDays')!;

    const ok = await post(base, '/admin/settings/proposal', { id: fee.id, decision: 'accept' }, cookie);
    assert.equal(ok.status, 303);
    assert.equal(getSettingMerged<Record<string, number>>(ctx(), 'late_fee_policy').flatCents, 7500, 'now it is written');
    assert.equal(
      getSettingMerged<Record<string, number>>(ctx(), 'late_fee_policy').graceDays, 3,
      'and only the accepted field changed — the untouched ones keep their value',
    );

    const no = await post(base, '/admin/settings/proposal', { id: grace.id, decision: 'dismiss' }, cookie);
    assert.equal(no.status, 303);
    assert.equal(getSettingMerged<Record<string, number>>(ctx(), 'late_fee_policy').graceDays, 3, 'yours stands');

    // re-reading the same documents must not re-ask a question already answered
    recordProposals(ctx(), { propertyId: propId }, sourced(LEASE_75, 'lease-a.pdf'));
    const still = pendingProposals(ctx());
    assert.equal(still.some((p) => p.path === 'graceDays'), false, 'a dismissed field is not proposed again');
    assert.equal(still.some((p) => p.path === 'flatCents'), false, 'nor is an accepted one');
  } finally {
    close();
  }
});

test('a single-property org takes the value as its organization default', () => {
  // with one building there is no meaningful distinction, and a property added
  // later should inherit the policy that was read rather than a shipped guess
  const row = q1<{ property_id: string }>(
    `SELECT property_id FROM settings WHERE org_id=? AND key='late_fee_policy'`, orgId,
  );
  assert.equal(row?.property_id, '', 'stored at org level, not against the building');
});

test('screening criteria is never proposed from a document', () => {
  // fair-housing sensitive: these thresholds must be authored deliberately,
  // never inherited from whatever a lease happened to say
  const text = `SCREENING. Applicants must show income of three times the monthly rent and a
    credit score of at least 700. A late charge of $60.00 applies after the 5th.`;
  const found = readPolicyFromLease(text);
  assert.equal(found.some((f) => f.key === 'screening_criteria'), false);
  assert.ok(found.some((f) => f.key === 'late_fee_policy'), 'but the late fee in the same document is read');
});

test('proposals are org-scoped and need whole-organization access to decide', async () => {
  const otherOrg = id('org');
  insert('orgs', { id: otherOrg, name: 'Other Policy Co', slug: 'policy-other', business_date: AS_OF, kind: 'live', created_at: nowIso() });
  ensureCoa(otherOrg);
  recordProposals(sysCtx(otherOrg, AS_OF), { propertyId: null }, sourced(LEASE_50, 'theirs.pdf'));
  const theirs = q<{ id: string }>(`SELECT id FROM setting_proposals WHERE org_id=?`, otherOrg);
  assert.ok(theirs.length, 'the other org has proposals of its own');

  assert.equal(
    pendingProposals(ctx()).some((p) => theirs.some((t) => t.id === p.id)), false,
    "one org never sees another's",
  );
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'admin@policy.test');
    const res = await post(base, '/admin/settings/proposal', { id: theirs[0]!.id, decision: 'accept' }, cookie);
    assert.equal(res.status, 303);
    assert.equal(
      val<number>(`SELECT COUNT(*) FROM setting_proposals WHERE id=? AND status='pending'`, theirs[0]!.id), 1,
      "and cannot decide another org's proposal",
    );
  } finally {
    close();
  }
});
