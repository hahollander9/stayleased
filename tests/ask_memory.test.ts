import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q1, val, insert } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { sysCtx, type Ctx } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { planFromAnswer, resumeClarification } from '../src/modules/m17_ai/act.ts';
import {
  currentThread, newThread, remember, recall, recallContext,
  matchCandidate, looksLikeFollowUp, spliceFollowUp,
} from '../src/modules/m17_ai/memory.ts';
import { getSettingMerged } from '../src/lib/settings.ts';
import { autonomyFor, aiEnabled } from '../src/modules/m17_ai/framework.ts';
import { getOp } from '../src/modules/m17_ai/ops.ts';
import '../src/modules/m17_ai/ops_catalog.ts';
import '../src/modules/m17_ai/ops_workflows.ts';
import '../src/modules/m14_reports/defs_receivables.ts'; // report.schedule resolves against the catalog

/** Ask StayLeased remembering what it just said.
 *
 * The bug worth writing tests around is not that the transcript was short. It
 * is that the transcript only ever reached the CONVERSATIONAL lane, so the two
 * lanes that do the work never saw a word of it. Concretely, before this:
 *
 *   staff: finalize disposition for the Bhatt household
 *   Ask:   "Bhatt" matches 2 households: Bhatt — unit 201, Bhatt-Rao — unit 202.
 *          Say which one.
 *   staff: the one in 201
 *   Ask:   I didn't find a report for that phrasing…
 *
 * The assistant asked a question and could not hear the answer, because "the
 * one in 201" is not an imperative sentence and nothing carried the question
 * forward. The operator has answered and believes they are understood.
 *
 * So these cover the carry-forward and, at least as carefully, its limits: an
 * ambiguous reply must not be resolved, a pronoun with nothing behind it must
 * not be resolved, and a name the operator actually typed must always beat
 * whatever the conversation was about a minute ago. */

const AS_OF = '2026-08-19';
let org: string;
let prop: string;
let ctx: Ctx;
const leases: Record<string, string> = {};
const CANDS = (): { id: string; label: string }[] => [
  { id: leases.bhattA!, label: 'Bhatt — unit 201, Orchard East' },
  { id: leases.bhattB!, label: 'Bhatt-Rao — unit 202, Orchard East' },
];

before(() => {
  db();
  org = id('org');
  insert('orgs', { id: org, name: 'Memory Co', slug: 'mem-' + org.slice(-6), business_date: AS_OF, kind: 'live', created_at: nowIso() });
  ensureCoa(org);
  prop = id('prp');
  insert('properties', {
    id: prop, org_id: org, name: 'Orchard East', slug: 'oe-' + org.slice(-6), type: 'residential',
    address1: '1 Orchard', city: 'Madison', state: 'WI', zip: '53703', timezone: 'America/Chicago', created_at: nowIso(),
  });
  const mk = (unit: string, household: string): string => {
    const u = id('unt');
    insert('units', {
      id: u, org_id: org, property_id: prop, unit_number: unit, floor: 1, sqft: 700,
      status: 'occupied', market_rent_cents: 150000, amenities: '[]', created_at: nowIso(),
    });
    const l = id('lse');
    insert('leases', {
      id: l, org_id: org, property_id: prop, unit_id: u, household_name: household,
      status: 'active', start_date: '2026-01-01', end_date: '2026-12-31', move_in_date: '2026-01-01',
      rent_cents: 150000, deposit_cents: 150000, term_months: 12, created_at: nowIso(),
    });
    return l;
  };
  leases.bhattA = mk('201', 'Bhatt');
  leases.bhattB = mk('202', 'Bhatt-Rao');
  leases.okafor = mk('203', 'Okafor');
  ctx = sysCtx(org, AS_OF);
});

const answer = (op: string | null, args: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ op, args, why: 'test' });

// ---------- the thread ----------

test('a turn is remembered, recalled in order, and scoped to one user', () => {
  const t = newThread();
  remember(ctx, t, 'you', 'occupancy right now');
  remember(ctx, t, 'agent', '93.1% occupied', 'occupancy');

  const turns = recall(ctx, t);
  assert.deepEqual(turns.map((x) => x.role), ['you', 'agent'], 'oldest first, as a conversation reads');
  assert.equal(turns[1]!.matched, 'occupancy');

  const other = { ...ctx, userId: id('usr') } as Ctx;
  assert.equal(recall(other, t).length, 0, 'another user cannot read this conversation');
});

test('a cold thread is not resumed — "them" must never reach into yesterday', () => {
  const t = newThread();
  remember(ctx, t, 'you', 'stale');
  // backdate the only turn past the idle window
  const row = q1<{ id: string }>('SELECT id FROM ask_turns WHERE thread_id=?', t)!;
  const old = new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString();
  db().exec(`UPDATE ask_turns SET created_at='${old}' WHERE id='${row.id}'`);

  assert.notEqual(currentThread(ctx), t, 'a conversation gone cold starts a new one');
});

test('later turns win, and the last agent turn is the only one that can hold a question', () => {
  const t = newThread();
  remember(ctx, t, 'agent', 'a', 'x', { entities: { lease: { id: leases.okafor!, label: 'Okafor' } } });
  remember(ctx, t, 'agent', 'b', 'y', { entities: { lease: { id: leases.bhattA!, label: 'Bhatt' } } });
  const rc = recallContext(ctx, t);
  assert.equal(rc.entities.lease!.id, leases.bhattA, 'the most recent mention is the one in play');
  assert.equal(rc.pending, null, 'no clarification was asked, so none is waiting');
});

// ---------- reading a reply as an answer ----------

test('a clarification is carried, and answering it finishes the original instruction', () => {
  // Ask asks which Bhatt…
  const refused = planFromAnswer(
    ctx, answer('deposit.finalize', { lease: 'Bhatt' }), 'finalize disposition for the bhatt household',
  );
  assert.equal(refused?.kind, 'refusal');
  const pending = refused!.kind === 'refusal' ? refused!.pending : undefined;
  assert.ok(pending, 'the refusal is a question, so it is held rather than dropped');
  assert.equal(pending!.opKey, 'deposit.finalize');
  assert.equal(pending!.candidates.length, 2);

  // …the operator answers it, in the way people actually answer it.
  const t = newThread();
  remember(ctx, t, 'agent', refused!.kind === 'refusal' ? refused!.message : '', 'action.refused', { pending });
  const rc = recallContext(ctx, t);

  const resumed = resumeClarification(ctx, rc, 'the one in 201');
  assert.equal(resumed?.kind, 'action', 'the reply completes the instruction rather than starting a new one');
  assert.equal(resumed!.kind === 'action' ? resumed!.opKey : '', 'deposit.finalize');
  assert.equal(resumed!.kind === 'action' ? resumed!.args.lease : '', leases.bhattA,
    'and resolves to the household the operator picked');
  assert.match(resumed!.kind === 'action' ? resumed!.resolved[0]!.value : '', /unit 201/,
    'the card names it back, so a wrong pick is visible before confirming');
});

test('a reply that fits both candidates is not resolved to either', () => {
  const t = newThread();
  remember(ctx, t, 'agent', 'which one?', 'action.refused', {
    pending: { kind: 'household', paramKey: 'lease', opKey: 'deposit.finalize', args: {}, candidates: CANDS(), question: 'finalize disposition for bhatt' },
  });
  const rc = recallContext(ctx, t);
  // "Bhatt" is in BOTH labels — the word that caused the ambiguity cannot end it
  assert.equal(resumeClarification(ctx, rc, 'bhatt'), null, 'still ambiguous, so the question stands');
  assert.equal(resumeClarification(ctx, rc, 'the orchard east one'), null, 'so does a property both share');
});

test('the ways people answer "which one?" all work', () => {
  const c = CANDS();
  assert.equal(matchCandidate('the one in 202', c)?.id, leases.bhattB, 'by unit');
  assert.equal(matchCandidate('202', c)?.id, leases.bhattB, 'by a bare unit number');
  assert.equal(matchCandidate('unit 201', c)?.id, leases.bhattA, 'by "unit N"');
  assert.equal(matchCandidate('the first one', c)?.id, leases.bhattA, 'by ordinal, into the list as printed');
  assert.equal(matchCandidate('the second', c)?.id, leases.bhattB, 'by ordinal');
  assert.equal(matchCandidate('Bhatt-Rao', c)?.id, leases.bhattB, 'by the distinguishing part of the name');
  assert.equal(matchCandidate('unit 999', c), null, 'a unit that is not on the list matches nothing');
  assert.equal(matchCandidate('', c), null);
});

test('an answered clarification does not resurrect on the next question', () => {
  const t = newThread();
  remember(ctx, t, 'agent', 'which one?', 'action.refused', {
    pending: { kind: 'household', paramKey: 'lease', opKey: 'deposit.finalize', args: {}, candidates: CANDS(), question: 'q' },
  });
  remember(ctx, t, 'you', 'the one in 201');
  remember(ctx, t, 'agent', 'Applies $1,500.00…', 'action.deposit.finalize', { entities: { lease: { id: leases.bhattA!, label: 'Bhatt — unit 201' } } });

  const rc = recallContext(ctx, t);
  assert.equal(rc.pending, null, 'the question was answered, so it is no longer on the table');
  assert.equal(resumeClarification(ctx, rc, 'the one in 202'), null,
    'and a later sentence is not attached to an instruction the operator has moved on from');
});

// ---------- carrying an entity forward ----------

test('“them” means the household already under discussion, and the card says so', () => {
  const t = newThread();
  remember(ctx, t, 'agent', 'Okafor owes $1,200.', 'delinquency', {
    entities: { lease: { id: leases.okafor!, label: 'Okafor — unit 203, Orchard East' } },
  });
  const rc = recallContext(ctx, t);

  const r = planFromAnswer(ctx, answer('ledger.charge', { lease: 'them', amount: '50', label: 'damaged rail' }), 'charge them $50', rc);
  assert.equal(r?.kind, 'action');
  assert.equal(r!.kind === 'action' ? r!.args.lease : '', leases.okafor);
  assert.match(r!.kind === 'action' ? r!.resolved.map((x) => x.value).join(' ') : '', /from earlier in this conversation/,
    'a household the operator did not name in this sentence is labelled as carried, not presented as typed');
});

test('a pronoun with nothing behind it is refused, never matched against a name', () => {
  const r = planFromAnswer(ctx, answer('ledger.charge', { lease: 'them', amount: '50', label: 'x' }), 'charge them $50', null);
  assert.equal(r?.kind, 'refusal', 'no conversation to refer back to');
  assert.match(r!.kind === 'refusal' ? r!.message : '', /household/i);
});

test('a name the operator typed always beats the one being carried', () => {
  const t = newThread();
  remember(ctx, t, 'agent', 'Okafor owes $1,200.', 'delinquency', {
    entities: { lease: { id: leases.okafor!, label: 'Okafor — unit 203' } },
  });
  const rc = recallContext(ctx, t);
  const r = planFromAnswer(ctx, answer('ledger.charge', { lease: 'Bhatt-Rao', amount: '50', label: 'x' }), 'charge Bhatt-Rao $50', rc);
  assert.equal(r!.kind === 'action' ? r!.args.lease : '', leases.bhattB,
    'memory fills a gap; it never overrides what was said');
});

// ---------- follow-ups to data questions ----------

test('a follow-up is recognised, and splices onto the question it continues', () => {
  for (const s of ['what about next month', 'and at Foundry?', 'same for Cardinal', 'next month?', 'of those, which is biggest']) {
    assert.ok(looksLikeFollowUp(s), `follow-up: ${s}`);
  }
  for (const s of ['which units turn this month', 'delinquency over $500', 'finalize disposition for Okafor']) {
    assert.equal(looksLikeFollowUp(s), false, `stands alone: ${s}`);
  }
  const s = spliceFollowUp('which units turn this month', 'what about next month');
  assert.match(s, /turn/, 'the topic survives from the first question');
  assert.match(s, /next month/, 'and the modifier from the second');
});

// ---------- standing behavior ----------

test('a report can be put on a cadence, and it lands where the reports screen keeps them', () => {
  const op = getOp('report.schedule')!;
  const pre = op.preview(ctx, { report: 'aged receivables', cadence: 'weekly' });
  assert.equal(pre.blockers.length, 0, `no blockers: ${pre.blockers.join(' ')}`);
  assert.match(pre.summary, /every Monday/, 'the preview states the cadence in words, not a cron string');

  op.apply(ctx, { report: 'aged receivables', cadence: 'weekly' });
  const saved = q1<{ schedule: string; dataset: string }>(
    'SELECT schedule, dataset FROM saved_reports WHERE org_id=? AND owner_user_id=?', ctx.orgId, ctx.userId,
  );
  assert.equal(saved?.schedule, 'weekly', 'the day job picks it up from the same table the screen writes');

  const again = op.preview(ctx, { report: 'aged receivables', cadence: 'weekly' });
  assert.equal(again.blockers.length, 1, 'asking twice is refused rather than leaving two of them');
});

test('an agent’s dial can be set by sentence, and the dials screen shows it', () => {
  const op = getOp('agent.autonomy')!;
  const pre = op.preview(ctx, { agent: 'renewals', level: 'auto' });
  assert.equal(pre.blockers.length, 0);
  assert.ok(pre.warnings.some((w) => /without waiting/i.test(w)),
    'autonomy is the dial that acts without you, and the preview says so before you confirm');

  op.apply(ctx, { agent: 'renewals', level: 'auto' });
  assert.equal(autonomyFor(ctx, 'renewals'), 'auto');
  assert.equal((getSettingMerged<Record<string, string>>(ctx, 'ai_autonomy', null)).renewals, 'auto',
    'written through the same setting /ai?view=dials reads, so it is not a change only Ask can see');

  assert.equal(op.preview(ctx, { agent: 'renewals', level: 'auto' }).blockers.length, 1, 'a no-op is refused');
  assert.equal(op.preview(ctx, { agent: 'nonsense', level: 'auto' }).blockers.length > 0, true, 'an unknown agent is refused');
});

test('the kill switch is reachable by sentence, and refuses to be set to where it already is', () => {
  const op = getOp('ai.pause')!;
  assert.equal(aiEnabled(ctx), true);
  assert.equal(op.preview(ctx, { paused: false }).blockers.length, 1, 'already running');

  op.apply(ctx, { paused: true });
  assert.equal(aiEnabled(ctx), false, 'paused org-wide');
  op.apply(ctx, { paused: false });
  assert.equal(aiEnabled(ctx), true, 'and back');
});

test('every standing-behavior operation is registered behind a permission and executable', () => {
  for (const key of ['report.schedule', 'agent.autonomy', 'ai.pause']) {
    const op = getOp(key);
    assert.ok(op, `${key} is registered`);
    assert.ok(op!.perm, `${key} takes a permission`);
    assert.equal(typeof op!.apply, 'function', `${key} can actually be carried out`);
  }
});
