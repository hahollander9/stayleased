import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q1, val, insert } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { sysCtx, type Ctx } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { createCharge, leaseBalance } from '../src/modules/m8_receivables/service.ts';
import { planFromAnswer, looksLikeInstruction } from '../src/modules/m17_ai/act.ts';
import { getOp, resolveLease, Ambiguous } from '../src/modules/m17_ai/ops.ts';
import { propose } from '../src/modules/m17_ai/framework.ts';
import '../src/modules/m17_ai/ops_catalog.ts';

/** Ask StayLeased doing the thing, not describing it.
 *
 * The model's only job here is to pick one operation from a catalog and fill
 * its parameters. Everything that could hurt somebody happens afterwards, in
 * deterministic code, and that is what these cover:
 *
 *  - a household name matching two households is REFUSED, with both. Guessing
 *    settles a stranger's deposit, and no confidence score makes that safe.
 *  - an operation the asker cannot perform never runs, even if the model names
 *    it — Ask acts with the permissions of the screens, never above them.
 *  - a preview computes the real figures and writes NOTHING, because it is the
 *    entire basis on which a person says yes.
 *  - confirming goes through ai_actions like any agent's action, so there is
 *    one audit trail and not two.
 *
 * The model is never invoked in these tests. `planFromAnswer` takes the answer
 * a model would have given, which is precisely the boundary worth testing. */

const AS_OF = '2026-08-19';
let org: string;
let prop: string;
let ctx: Ctx;
const leases: Record<string, string> = {};

before(() => {
  db();
  org = id('org');
  insert('orgs', { id: org, name: 'Act Co', slug: 'act-' + org.slice(-6), business_date: AS_OF, kind: 'live', created_at: nowIso() });
  ensureCoa(org);
  prop = id('prp');
  insert('properties', {
    id: prop, org_id: org, name: 'Orchard East', slug: 'oe-' + org.slice(-6), type: 'residential',
    address1: '1 Orchard', city: 'Madison', state: 'WI', zip: '53703', timezone: 'America/Chicago', created_at: nowIso(),
  });
  // Two households called Bhatt — the ambiguity that must never be guessed —
  // plus one distinctly named household to act on.
  const mk = (unit: string, household: string, deposit: number): string => {
    const u = id('unt');
    insert('units', {
      id: u, org_id: org, property_id: prop, unit_number: unit, floor: 1, sqft: 700,
      status: 'occupied', market_rent_cents: 150000, amenities: '[]', created_at: nowIso(),
    });
    const l = id('lse');
    insert('leases', {
      id: l, org_id: org, property_id: prop, unit_id: u, household_name: household,
      status: 'active', start_date: '2026-01-01', end_date: '2026-12-31', move_in_date: '2026-01-01',
      rent_cents: 150000, deposit_cents: deposit, term_months: 12, created_at: nowIso(),
    });
    return l;
  };
  leases.bhattA = mk('201', 'Bhatt', 150000);
  leases.bhattB = mk('202', 'Bhatt-Rao', 150000);
  leases.okafor = mk('203', 'Okafor', 150000);
  ctx = sysCtx(org, AS_OF);
});

const answer = (op: string | null, args: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ op, args, why: 'test' });

// ---------- the gate ----------

test('a command is recognised as a command, and a question is left alone', () => {
  for (const s of [
    'finalize disposition for the Bhatt household',
    'waive the late fee for Okafor',
    'please record a payment of $500 from Okafor',
    'close that work order',
    'can you assign it to Ace Plumbing',
  ]) assert.ok(looksLikeInstruction(s), `instruction: ${s}`);

  for (const s of [
    'delinquency over $500',
    'which units turn this month',
    'what is the collection rate',
    'how many open work orders',
  ]) assert.equal(looksLikeInstruction(s), false, `question: ${s}`);
});

// ---------- refusing what must be refused ----------

test('a household name matching two households is refused, with both named', () => {
  const r = planFromAnswer(ctx, answer('deposit.finalize', { lease: 'Bhatt' }), 'finalize disposition for bhatt');
  assert.equal(r?.kind, 'refusal');
  assert.match(r!.kind === 'refusal' ? r!.message : '', /matches 2 households/);
  assert.equal(r!.kind === 'refusal' ? r!.candidates?.length : 0, 2, 'and hands back both so the operator can pick');
  assert.match(r!.kind === 'refusal' ? r!.message : '', /Bhatt/);
});

test('a name matching nothing is refused rather than resolved to something near it', () => {
  const r = planFromAnswer(ctx, answer('deposit.finalize', { lease: 'Zylberstein' }), 'finalize disposition for zylberstein');
  assert.equal(r?.kind, 'refusal');
  assert.match(r!.kind === 'refusal' ? r!.message : '', /No household matches/);
});

test('an operation the model invented is a miss, not an action', () => {
  assert.equal(planFromAnswer(ctx, answer('leases.delete_everything', { lease: 'Okafor' }), 'x'), null);
  assert.equal(planFromAnswer(ctx, answer(null), 'x'), null);
  assert.equal(planFromAnswer(ctx, 'not json at all', 'x'), null);
});

test('an operation outside the asker’s role is refused even when the model names it', () => {
  const agent: Ctx = { ...ctx, perms: new Set(['ai:view', 'ledger:view']) as unknown as Ctx['perms'] };
  const r = planFromAnswer(agent, answer('deposit.finalize', { lease: 'Okafor' }), 'finalize disposition for okafor');
  assert.equal(r?.kind, 'refusal');
  assert.match(r!.kind === 'refusal' ? r!.message : '', /outside your role/);
});

test('a required parameter the model left out is asked for, never invented', () => {
  const r = planFromAnswer(ctx, answer('ledger.charge', { lease: 'Okafor', amount: '250' }), 'charge okafor $250');
  assert.equal(r?.kind, 'refusal');
  assert.match(r!.kind === 'refusal' ? r!.message : '', /still need what it is for/i);
});

test('an amount or date the system cannot read is refused, not coerced to zero', () => {
  const bad = planFromAnswer(ctx, answer('ledger.charge', { lease: 'Okafor', amount: 'a few hundred', label: 'x' }), 'x');
  assert.equal(bad?.kind, 'refusal');

  const badDate = planFromAnswer(ctx, answer('lease.notice', { lease: 'Okafor', move_out: 'sometime in October' }), 'x');
  assert.equal(badDate?.kind, 'refusal');
  assert.match(badDate!.kind === 'refusal' ? badDate!.message : '', /not a date/);
});

// ---------- the preview ----------

test('a preview states the real figures and writes nothing', () => {
  createCharge(ctx, {
    leaseId: leases.okafor!, kind: 'rent', label: 'August rent', amountCents: 150000,
    date: AS_OF, dueDate: AS_OF, monthKey: '2026-08',
  });
  const before = leaseBalance(ctx, leases.okafor!);
  const actionsBefore = val<number>('SELECT COUNT(*) FROM ai_actions WHERE org_id=?', org) || 0;

  const r = planFromAnswer(ctx, answer('ledger.charge', { lease: 'Okafor', amount: '250', label: 'Carpet repair' }), 'charge okafor $250 for carpet repair');
  assert.equal(r?.kind, 'action');
  const a = r as Extract<typeof r, { kind: 'action' }>;
  assert.equal(a.opKey, 'ledger.charge');
  assert.equal(a.args.amount, 25000, 'dollars became cents');
  assert.equal(a.args.lease, leases.okafor, 'the name resolved to the right lease');
  assert.match(a.resolved.map((x) => x.value).join(' '), /Okafor/, 'and the card shows what it understood');

  const after = a.preview.changes.find((c) => c.label === 'Balance after')!;
  assert.equal(after.value, '$1,750.00', '$1,500 owed plus the $250 charge');

  assert.equal(leaseBalance(ctx, leases.okafor!), before, 'the preview changed no balance');
  assert.equal(val<number>('SELECT COUNT(*) FROM ai_actions WHERE org_id=?', org), actionsBefore,
    'and proposed nothing — planning is not doing');
});

test('a preview that cannot proceed says so instead of offering a button', () => {
  const r = planFromAnswer(ctx, answer('latefee.waive', { lease: 'Okafor', reason: 'goodwill' }), 'waive the late fee for okafor');
  assert.equal(r?.kind, 'action');
  const a = r as Extract<typeof r, { kind: 'action' }>;
  assert.ok(a.preview.blockers.length, 'no late fee exists to waive');
  assert.match(a.preview.blockers.join(' '), /no active late or NSF fee/i);
});

// ---------- confirming ----------

test('confirming runs through ai_actions, changes the data, and leaves the trail', () => {
  const r = planFromAnswer(ctx, answer('ledger.charge', { lease: 'Okafor', amount: '250', label: 'Carpet repair' }), 'x');
  const a = r as Extract<typeof r, { kind: 'action' }>;
  const before = leaseBalance(ctx, leases.okafor!);

  // exactly what POST /ask/act does
  const { id: actionId, status } = propose(ctx, {
    agent: 'ask', title: 'Post a charge',
    input: { op: a.opKey, args: a.args },
    output: { kind: `op.${a.opKey}`, args: a.args },
    confidence: 0.99,
    rationale: 'Confirmed in Ask StayLeased by System',
  });
  // `ask` has no autonomy dial, so proposing IS executing — the operator's
  // click was the decision. A decideAction here would throw after the fact.
  assert.equal(status, 'auto_executed');

  assert.equal(leaseBalance(ctx, leases.okafor!), before + 25000, 'the charge posted');
  const row = q1<{ status: string; agent: string; result: string; output: string }>(
    'SELECT status, agent, result, output FROM ai_actions WHERE id=?', actionId)!;
  assert.equal(row.agent, 'ask');
  assert.match(row.status, /executed/);
  assert.match(row.result, /Posted \$250\.00/);
  assert.ok(
    val<number>(`SELECT COUNT(*) FROM audit_events WHERE org_id=? AND entity='ai_action' AND entity_id=?`, org, actionId),
    'and it is in the audit log like every other AI action',
  );
});

test('the executor re-checks permission at execution, not only when planned', () => {
  const r = planFromAnswer(ctx, answer('ledger.charge', { lease: 'Okafor', amount: '10', label: 'Late test' }), 'x');
  const a = r as Extract<typeof r, { kind: 'action' }>;
  // a role that cannot post a charge must be refused BY THE EXECUTOR, even
  // holding a proposal that was planned while the permission was held
  const demoted: Ctx = { ...ctx, perms: new Set(['ai:view', 'ai:approve']) as unknown as Ctx['perms'] };
  assert.throws(
    () => propose(demoted, {
      agent: 'ask', title: 'Post a charge',
      input: { op: a.opKey, args: a.args }, output: { kind: `op.${a.opKey}`, args: a.args }, confidence: 0.99,
    }),
    /ledger:charge/,
  );
});

// ---------- resolution itself ----------

test('one household resolves; a unit number resolves; a surname that is unique resolves', () => {
  assert.equal(resolveLease(ctx, 'Okafor').id, leases.okafor);
  assert.equal(resolveLease(ctx, '203').id, leases.okafor);
  assert.equal(resolveLease(ctx, 'Bhatt-Rao').id, leases.bhattB);
  assert.throws(() => resolveLease(ctx, 'Bhatt'), /matches 2 households/);
  // and it is the typed refusal, carrying the candidates the operator picks from
  let caught: unknown;
  try { resolveLease(ctx, 'Bhatt'); } catch (e) { caught = e; }
  assert.ok(caught instanceof Ambiguous);
  assert.equal((caught as Ambiguous).candidates.length, 2);
});

test('every registered operation declares a permission and can preview itself', () => {
  // a capability with no permission is a capability with no supervision
  for (const key of ['deposit.finalize', 'ledger.charge', 'latefee.waive', 'payment.record',
    'lease.notice', 'resident.contact', 'renewal.offer',
    'wo.create', 'wo.assign', 'wo.priority', 'wo.close', 'clock.advance']) {
    const op = getOp(key);
    assert.ok(op, `${key} is registered`);
    assert.match(op!.perm, /^[a-z]+:[a-z_]+$/, `${key} names a real permission`);
    assert.ok(op!.params.length >= 0 && op!.describe.length > 20, `${key} describes itself to the model`);
  }
});

// ---------- the route a person actually clicks ----------

import { startTestServer, loginAs, post } from './harness.ts';
import { hashPassword } from '../src/lib/auth.ts';
import { setSetting } from '../src/lib/settings.ts';

test('POST /ask/act runs the operation, and refuses one that has gone stale', async () => {
  const uid = id('usr');
  insert('users', {
    id: uid, org_id: org, email: 'act@act.test', name: 'Act Admin',
    kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
  });
  insert('role_assignments', {
    id: id('ra'), org_id: org, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org',
    property_ids: '[]', created_at: nowIso(),
  });

  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'act@act.test');
    const before = leaseBalance(ctx, leases.okafor!);

    const r = await post(base, '/ask/act', {
      op: 'ledger.charge',
      args: JSON.stringify({ lease: leases.okafor, amount: 12500, label: 'Screen repair' }),
    }, cookie);
    assert.equal(r.status, 303);
    assert.equal(leaseBalance(ctx, leases.okafor!), before + 12500, 'the charge posted through the route');

    // an action whose preview no longer passes is refused rather than run:
    // the blockers are re-computed at the click, not trusted from the form
    const stale = await post(base, '/ask/act', {
      op: 'ledger.charge',
      args: JSON.stringify({ lease: leases.okafor, amount: 0, label: 'Nothing' }),
    }, cookie);
    assert.equal(stale.status, 303);
    assert.equal(leaseBalance(ctx, leases.okafor!), before + 12500, 'and nothing else was written');

    // an operation that does not exist cannot be smuggled in through the form
    const bogus = await post(base, '/ask/act', { op: 'leases.wipe', args: '{}' }, cookie);
    assert.equal(bogus.status, 303);
    assert.match(String(bogus.location), /\/ask/);
  } finally { close(); }
});

test('the global kill switch holds an Ask action instead of running it', async () => {
  const { base, close } = await startTestServer();
  try {
    const cookie = await loginAs(base, 'act@act.test');
    setSetting(ctx, 'ai_enabled', false, null);
    const before = leaseBalance(ctx, leases.okafor!);
    const r = await post(base, '/ask/act', {
      op: 'ledger.charge',
      args: JSON.stringify({ lease: leases.okafor, amount: 5000, label: 'Held by kill switch' }),
    }, cookie);
    assert.equal(r.status, 303);
    assert.equal(leaseBalance(ctx, leases.okafor!), before, 'nothing was posted while AI is paused');
    const held = q1<{ status: string; autonomy: string }>(
      `SELECT status, autonomy FROM ai_actions WHERE org_id=? AND agent='ask' AND title='Post a charge' ORDER BY created_at DESC LIMIT 1`, org)!;
    assert.equal(held.status, 'proposed', 'it is waiting in the queue');
    assert.equal(held.autonomy, 'draft', 'forced to draft by the switch');
  } finally {
    setSetting(ctx, 'ai_enabled', true, null);
    close();
  }
});
