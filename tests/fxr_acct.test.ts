import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert, run, val, js } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword, buildCtx, sysCtx, type Ctx } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { postBothBases, accountBalance, runInvariants } from '../src/modules/m9_accounting/service.ts';
import {
  createRecon, completeRecon, autoMatch, postAdjustment, unmatchTxn, matchEntries, addStatementLine, setStatementClose,
  reconSummary, matchCandidates,
} from '../src/modules/m9_accounting/banking.ts';
import { closeChecklist } from '../src/modules/m9_accounting/close.ts';
import { parseBankCsv } from '../src/modules/m9_accounting/finops.ts';
import { recordOwnerDistribution } from '../src/modules/m9_accounting/owners.ts';
import { applyDeposits, postBankOpeningBalance, type BatchRow } from '../src/modules/setup/import_apply.ts';
import { reverseImport } from '../src/modules/setup/import_reverse.ts';
import { startTestServer, loginAs, get } from './harness.ts';

/** Regression guards for the second review of the accounting area. One test
 * per confirmed defect: what a live (non-demo) operator did, and what must now
 * be true in the ledger and the database — including the built-in integrity
 * checks. Every test builds its own organization, so nothing leaks between
 * them or into the shared harness orgs. */

let base: string;
let close: () => void;
const sfx = id('x').slice(-6);
let seq = 0;

interface Fx { org: string; propA: string; propB: string; admin: string; adminId: string }

function mkUser(org: string, email: string, name: string, role: string, propertyIds?: string[]): string {
  const uid = id('usr');
  insert('users', { id: uid, org_id: org, email, name, kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso() });
  insert('role_assignments', {
    id: id('ra'), org_id: org, user_id: uid, role,
    scope_type: propertyIds ? 'properties' : 'org', property_ids: js(propertyIds || []), created_at: nowIso(),
  });
  return uid;
}

function mkProp(org: string, name: string): string {
  const pid = id('prp');
  insert('properties', { id: pid, org_id: org, name, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id('s').slice(-5)}`, type: 'multifamily', address1: '1 Test St', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso() });
  return pid;
}

function mkOrg(kind: 'demo' | 'live', businessDate: string): Fx {
  const tag = `r${++seq}`;
  const org = id('org');
  insert('orgs', { id: org, name: `Racct ${tag} ${sfx}`, slug: `racct-${tag}-${sfx}`, kind, business_date: businessDate, created_at: nowIso() });
  ensureCoa(org);
  const admin = `admin-racct-${tag}-${sfx}@example.test`;
  const adminId = mkUser(org, admin, `Avery ${tag}`, 'ORG_ADMIN');
  return { org, propA: mkProp(org, `Alder ${tag} ${sfx}`), propB: mkProp(org, `Birch ${tag} ${sfx}`), admin, adminId };
}

function ctxOf(userId: string): Ctx {
  return buildCtx(q1<any>('SELECT * FROM users WHERE id=?', userId), null, null);
}

interface Posted { status: number; location: string | null; flash: string }

function flashOf(resp: Response): string {
  const m = /sl_fl=([^;]+)/.exec(resp.headers.get('set-cookie') || '');
  return m ? decodeURIComponent(m[1]!).replace(/^(ok|err)\|/, '') : '';
}

async function post(path: string, body: Record<string, string>, ck: string): Promise<Posted> {
  const resp = await fetch(base + path, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, cookie: ck },
    body: new URLSearchParams(body).toString(),
  });
  await resp.text();
  return { status: resp.status, location: resp.headers.get('location'), flash: flashOf(resp) };
}

async function upload(acctId: string, filename: string, text: string, ck: string): Promise<{ status: number; flash: string }> {
  const fd = new FormData();
  fd.append('statement', new Blob([text], { type: 'text/csv' }), filename);
  const resp = await fetch(`${base}/banking/${acctId}/upload`, { method: 'POST', redirect: 'manual', headers: { origin: base, cookie: ck }, body: fd });
  await resp.text();
  return { status: resp.status, flash: flashOf(resp) };
}

const count = (sql: string, ...p: unknown[]): number => Number(val<number>(sql, ...p) || 0);
const operating = (org: string, prop: string): any => q1<any>(`SELECT * FROM bank_accounts WHERE org_id=? AND property_id=? AND kind='operating'`, org, prop);
const failed = (ctx: Ctx): string => JSON.stringify(runInvariants(ctx).filter((i) => !i.ok));

function mkLease(fx: Fx, prop: string, unitNumber: string, fields: Record<string, unknown>): string {
  const unit = id('unt');
  insert('units', { id: unit, org_id: fx.org, property_id: prop, unit_number: unitNumber, floor: 1, sqft: 700, status: 'occupied', market_rent_cents: 100000, amenities: '[]', created_at: nowIso() });
  const lease = id('lse');
  insert('leases', {
    id: lease, org_id: fx.org, property_id: prop, unit_id: unit, household_name: `Household ${unitNumber}`, status: 'active',
    start_date: '2026-01-01', end_date: '2026-12-31', move_in_date: '2026-01-01', rent_cents: 100000, deposit_cents: 0, term_months: 12,
    created_at: nowIso(), ...fields,
  });
  return lease;
}

before(async () => {
  db();
  const s = await startTestServer();
  base = s.base; close = s.close;
});

after(() => close());

// ---------------------------------------------------------------- item 3
test('item 3: a live month that is still running cannot be completed, so the rest of its statement still has somewhere to go', async () => {
  const fx = mkOrg('live', '2026-11-19');
  let ctx = ctxOf(fx.adminId);
  const cookie = await loginAs(base, fx.admin);
  postBankOpeningBalance(ctx, fx.propA, 1000000, '2026-10-31');
  const acct = operating(fx.org, fx.propA);

  // November, on the 19th: nothing on file, and the books tie to $10,000.00 today
  const rid = createRecon(ctx, acct.id, '2026-11', { statementCloseCents: 1000000 });
  assert.equal(reconSummary(ctx, rid).tieDifference, 0, 'it ties as of the business date — which is what used to let it complete');
  assert.throws(() => completeRecon(ctx, rid), /has not ended yet/);
  const early = await post(`/banking/${acct.id}/reconcile/${rid}/complete`, {}, cookie);
  assert.match(early.flash, /The statement month has not ended yet\. Nov 2026 can be completed once the month is over and the full statement is entered\./);
  assert.equal(q1<any>('SELECT status FROM bank_recons WHERE id=?', rid).status, 'in_progress');
  const page = await get(base, `/banking/${acct.id}/reconcile?month=2026-11`, cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<button class="btn" disabled>Complete at \$0\.00<\/button>/, 'the button is not offered');
  assert.match(page.text, /Nov 2026 has not ended, so its bank statement is not out yet/);

  // the fee the bank charges on the 25th can still be entered — the month is not locked
  const fee = addStatementLine(ctx, acct.id, { date: '2026-11-25', description: 'MONTHLY SERVICE FEE', amountCents: -2500 });
  assert.equal(count(`SELECT COUNT(*) FROM bank_txns WHERE bank_account_id=? AND substr(date,1,7)='2026-11'`, acct.id), 1);

  // December 1st: the full statement is in hand
  run('UPDATE orgs SET business_date=? WHERE id=?', '2026-12-01', fx.org);
  ctx = ctxOf(fx.adminId);
  postAdjustment(ctx, fee, rid, { account: '5710' });
  setStatementClose(ctx, rid, 997500);
  completeRecon(ctx, rid);
  const rec = q1<any>('SELECT * FROM bank_recons WHERE id=?', rid);
  assert.deepEqual([rec.status, rec.statement_close_cents], ['completed', 997500], 'completed at the real ending balance, fee included');
  assert.equal(accountBalance(ctx, '1010', { propertyId: fx.propA, basis: 'accrual', asOf: '2026-11-30' }), 997500);
  assert.equal(accountBalance(ctx, '1010', { propertyId: fx.propA, basis: 'cash', asOf: '2026-11-30' }), 997500);
  assert.equal(failed(ctx), '[]');

  // a demo organization keeps completing its in-flight month against the simulated feed
  const demo = mkOrg('demo', '2026-11-19');
  const dctx = ctxOf(demo.adminId);
  insert('bank_accounts', { id: id('bank'), org_id: demo.org, property_id: demo.propA, name: 'Demo operating', kind: 'operating', gl_account: '1010', bank_name: 'First Simulated Bank', last4: '1234', active: 1, created_at: nowIso() });
  const drid = createRecon(dctx, operating(demo.org, demo.propA).id, '2026-11');
  completeRecon(dctx, drid);
  assert.equal(q1<any>('SELECT status FROM bank_recons WHERE id=?', drid).status, 'completed');
});

// ---------------------------------------------------------------- item 4
test('item 4: after Undo, a bank fee is not auto-matched back onto its own reversed entry', () => {
  const fx = mkOrg('live', '2026-08-05');
  const ctx = ctxOf(fx.adminId);
  postBankOpeningBalance(ctx, fx.propA, 500000, '2026-06-30');
  const acct = operating(fx.org, fx.propA);
  const fee = addStatementLine(ctx, acct.id, { date: '2026-07-15', description: 'ACCOUNT ANALYSIS CHARGE', amountCents: -2500 });
  const rid = createRecon(ctx, acct.id, '2026-07', { statementCloseCents: 497500 });

  // record it, then undo: the entry and its reversal now cancel on the books
  const je = postAdjustment(ctx, fee, rid, { account: '5710' });
  unmatchTxn(ctx, fee);
  assert.equal(accountBalance(ctx, '1010', { propertyId: fx.propA, basis: 'accrual' }), 500000);
  assert.equal(count('SELECT COUNT(*) FROM journal_entries WHERE org_id=? AND reversal_of=?', fx.org, je), 1);

  // auto-match used to take the reversed entry (the only −$25.00 on the books),
  // leave its reversal as a phantom deposit in transit, and tie the month
  const res = autoMatch(ctx, rid);
  assert.deepEqual([res.matched, res.remaining], [0, 1], 'nothing to match the fee to');
  assert.equal(q1<any>('SELECT status FROM bank_txns WHERE id=?', fee).status, 'unmatched');
  assert.equal(matchCandidates(ctx, fee).items.length, 0, 'the picker offers nothing either');
  // and a hand-built request cannot pick it
  assert.throws(() => matchEntries(ctx, fee, [je], rid), /no longer available/);
  assert.throws(() => completeRecon(ctx, rid), /still unmatched/);
  const s = reconSummary(ctx, rid);
  assert.equal(s.inTransit.length + s.outstanding.length, 0, 'no phantom item carried forward');
  assert.equal(s.tieDifference, 2500, 'the books are $25.00 above the bank until the fee is recorded');

  // recording it again is the way through, and then cash is right
  postAdjustment(ctx, fee, rid, { account: '5710' });
  completeRecon(ctx, rid);
  assert.equal(q1<any>('SELECT status FROM bank_recons WHERE id=?', rid).status, 'completed');
  for (const basis of ['accrual', 'cash'] as const) {
    assert.equal(accountBalance(ctx, '1010', { propertyId: fx.propA, basis }), 497500, `${basis} cash equals the bank`);
    assert.equal(accountBalance(ctx, '5710', { propertyId: fx.propA, basis }), 2500, `${basis} fee expense recorded once`);
  }
  assert.equal(failed(ctx), '[]');
});

// ---------------------------------------------------------------- item 5
test('item 5: an imported lease that has not started yet does not count as a deposit held', () => {
  const fx = mkOrg('live', '2026-08-05');
  const ctx = ctxOf(fx.adminId);
  // the rent roll: one current household whose deposit was carried in with its entry…
  mkLease(fx, fx.propA, '101', { import_batch_id: 'rr-batch', deposit_cents: 100000 });
  postBothBases(ctx, { propertyId: fx.propA, date: '2026-07-31', memo: 'Migrated security deposits held (conversion)', sourceKind: 'conversion', sourceId: 'rr-batch', lines: [{ account: '1020', debit: 100000 }, { account: '2100', credit: 100000 }] });
  // …and one future resident: signed, $1,500.00 deposit on the lease, nothing collected or posted
  const future = mkLease(fx, fx.propA, '102', { import_batch_id: 'rr-batch', status: 'fully_executed', start_date: '2026-09-01', move_in_date: '2026-09-01', deposit_cents: 150000 });
  // a lease typed in by hand, not started, with the deposit already in the bank: entry posted, so it counts
  const manual = mkLease(fx, fx.propA, '103', { import_batch_id: 'manual-entry', deposit_on_hand: 1, status: 'fully_executed', start_date: '2026-09-01', move_in_date: '2026-09-01', deposit_cents: 80000 });
  postBothBases(ctx, { propertyId: fx.propA, date: '2026-08-05', memo: 'Security deposit already held', sourceKind: 'deposit_on_hand', sourceId: manual, lines: [{ account: '1020', debit: 80000 }, { account: '2100', credit: 80000 }] });

  const dep = runInvariants(ctx).find((i) => i.name === 'Deposit liability equals deposits held')!;
  assert.equal(dep.ok, true, dep.detail);
  assert.match(dep.detail, /GL 2100 180000 vs subledger 180000/, 'the future $1,500.00 is not in the subledger');
  assert.equal(failed(ctx), '[]');
  assert.equal(closeChecklist(ctx, fx.propA, '2026-07').find((i) => i.key === 'subledger')!.ok, true, 'month-end close is not blocked');
  assert.equal(closeChecklist(ctx, fx.propB, '2026-07').find((i) => i.key === 'subledger')!.ok, true, 'for any property in the organization');

  // once it has started as an in-place tenancy it counts like any other imported lease
  run(`UPDATE leases SET status='active' WHERE id=?`, future);
  assert.match(runInvariants(ctx).find((i) => i.name === 'Deposit liability equals deposits held')!.detail, /subledger 330000/);
});

// ---------------------------------------------------------------- item 6
test('item 6: a deposit report that fills an imported lease posts the liability and the escrow cash beside it', () => {
  const fx = mkOrg('live', '2026-08-19');
  const ctx = ctxOf(fx.adminId);
  const imported = mkLease(fx, fx.propA, '201', { import_batch_id: 'rr-batch' });   // rent roll carried no deposit
  const byHand = mkLease(fx, fx.propA, '202', {});                                    // ordinary lease, deposit not billed yet
  const already = mkLease(fx, fx.propA, '203', { import_batch_id: 'rr-batch', deposit_cents: 60000 });
  postBothBases(ctx, { propertyId: fx.propA, date: '2026-07-31', memo: 'Migrated security deposits held (conversion)', sourceKind: 'conversion', sourceId: 'rr-batch', lines: [{ account: '1020', debit: 60000 }, { account: '2100', credit: 60000 }] });
  assert.equal(failed(ctx), '[]', 'ties before the deposit report');

  const b = id('imp');
  insert('import_batches', {
    id: b, org_id: fx.org, kind: 'deposits', filename: 'SecurityDepositActivity.xlsx',
    property_id: fx.propA, new_property_name: null, preset: null,
    headers: js(['Unit', 'Resident', 'Resident Code', 'Prior Deposit Billed', 'Deposits On Hand', '(Prpd)/Delnq Deposits', 'Deposits Forfeited']),
    mapping: js({ cols: { 0: 'unit', 1: 'tenant', 2: 'source_ref', 3: 'deposit_billed', 4: 'deposit_held', 5: 'deposit_shortfall', 6: 'deposit_forfeited' }, preset: null, aiAssisted: [], reader: 'ai' }),
    rows: js([
      ['201', 'Household 201', 't0000201', '903.34', '903.34', '0', '0'],
      ['202', 'Household 202', 't0000202', '500', '500', '0', '0'],
      ['203', 'Household 203', 't0000203', '600', '600', '0', '0'],
    ]),
    staged: js([]), as_of: '2026-08-19', status: 'staged', summary: null, created_by: 'sys', created_at: nowIso(), applied_at: null,
  });
  const summary = applyDeposits(ctx, q1<BatchRow>('SELECT * FROM import_batches WHERE id=?', b)!);
  assert.equal(summary.depositsFilledOnLeases, 2);
  assert.equal(q1<any>('SELECT deposit_cents FROM leases WHERE id=?', imported).deposit_cents, 90334);
  assert.equal(q1<any>('SELECT deposit_cents FROM leases WHERE id=?', byHand).deposit_cents, 50000);
  assert.equal(q1<any>('SELECT deposit_cents FROM leases WHERE id=?', already).deposit_cents, 60000);

  // $903.34 for the imported lease only: the hand-entered lease is not in the
  // subledger (its deposit will be billed), so nothing is posted for it
  const posted = q<any>(`SELECT basis, date, property_id FROM journal_entries WHERE org_id=? AND import_batch_id=? ORDER BY basis`, fx.org, b);
  assert.deepEqual(posted.map((e) => [e.basis, e.date, e.property_id]), [['accrual', '2026-08-19', fx.propA], ['cash', '2026-08-19', fx.propA]]);
  for (const basis of ['accrual', 'cash'] as const) {
    assert.equal(-accountBalance(ctx, '2100', { propertyId: fx.propA, basis }), 150334, `${basis} liability`);
    assert.equal(accountBalance(ctx, '1020', { propertyId: fx.propA, basis }), 150334, `${basis} escrow cash`);
  }
  const dep = runInvariants(ctx).find((i) => i.name === 'Deposit liability equals deposits held')!;
  assert.equal(dep.ok, true, dep.detail);
  assert.match(dep.detail, /GL 2100 150334 vs subledger 150334/);
  assert.equal(failed(ctx), '[]', 'every integrity check, the trust three-way included');
  assert.equal(closeChecklist(ctx, fx.propA, '2026-08').find((i) => i.key === 'subledger')!.ok, true);

  // removing the import takes the entry and the filled figures away together
  reverseImport(sysCtx(fx.org, '2026-08-19'), q1<any>('SELECT * FROM import_batches WHERE id=?', b)!);
  assert.equal(count('SELECT COUNT(*) FROM journal_entries WHERE org_id=? AND import_batch_id=?', fx.org, b), 0);
  assert.equal(q1<any>('SELECT deposit_cents FROM leases WHERE id=?', imported).deposit_cents, 0);
  assert.equal(-accountBalance(ctx, '2100', { propertyId: fx.propA, basis: 'accrual' }), 60000);
  assert.equal(failed(ctx), '[]');
});

// ---------------------------------------------------------------- item 7
test('item 7: every cent of an owner distribution is attributed to an owner, or the distribution is refused', () => {
  const fx = mkOrg('live', '2026-08-05');
  const ctx = ctxOf(fx.adminId);
  const mkOwner = (name: string, prop: string, pct: number): string => {
    const oid = id('own');
    insert('owners', { id: oid, org_id: fx.org, name, kind: 'individual', active: 1, created_at: nowIso() });
    insert('property_owners', { id: id('po'), org_id: fx.org, owner_id: oid, property_id: prop, pct, created_at: nowIso() });
    return oid;
  };
  // three equal owners can only be entered as 33.33% each
  for (const n of ['Ash', 'Bay', 'Cedar']) mkOwner(`${n} Owner`, fx.propA, 33.33);
  const did = recordOwnerDistribution(ctx, { propertyId: fx.propA, amountCents: 1000000, date: '2026-08-04' });
  const parts = q<any>('SELECT amount_cents FROM owner_distribution_shares WHERE distribution_id=? ORDER BY amount_cents DESC', did).map((p) => p.amount_cents as number);
  assert.deepEqual(parts, [333334, 333333, 333333], 'the odd cent goes to one owner; none is left unattributed');
  assert.equal(parts.reduce((s, x) => s + x, 0), q1<any>('SELECT amount_cents FROM owner_distributions WHERE id=?', did).amount_cents);
  for (const basis of ['accrual', 'cash'] as const) {
    assert.equal(accountBalance(ctx, '3020', { propertyId: fx.propA, basis }), 1000000);
    assert.equal(accountBalance(ctx, '1010', { propertyId: fx.propA, basis }), -1000000);
  }

  // a property with 60% on record: $4,000.00 of $10,000.00 would belong to nobody
  mkOwner('Dune Owner', fx.propB, 60);
  assert.throws(
    () => recordOwnerDistribution(ctx, { propertyId: fx.propB, amountCents: 1000000, date: '2026-08-04' }),
    /Ownership of this property adds up to 60%\. Assign the remaining share before recording a distribution/,
  );
  assert.equal(count('SELECT COUNT(*) FROM owner_distributions WHERE org_id=? AND property_id=?', fx.org, fx.propB), 0);
  assert.equal(accountBalance(ctx, '3020', { propertyId: fx.propB, basis: 'accrual' }), 0, 'nothing posted');
  assert.equal(failed(ctx), '[]');
});

// ---------------------------------------------------------------- item 8
test('item 8: money out in a bank file is read as money out, however the bank writes the sign', async () => {
  const amounts = (csv: string): number[] => parseBankCsv(csv).map((r) => r.amount);
  assert.deepEqual(amounts([
    'Date,Description,Amount',
    '07/01/2026,ACH UTILITY,$-75.00',
    '07/02/2026,CHECK 2001,40.00-',
    '07/03/2026,SERVICE FEE,20.00 DR',
    '07/04/2026,WIRE OUT,- $12.50',
    '07/05/2026,CARD,-$10.00',
    '07/06/2026,ADJUSTMENT,($5.00)',
    '07/07/2026,DEPOSIT,"1,500.00"',
    '07/08/2026,INTEREST,3.10 CR',
  ].join('\n')), [-7500, -4000, -2000, -1250, -1000, -500, 150000, 310]);

  // unsigned amounts with a column that says which way the money went
  assert.deepEqual(amounts([
    'Date,Description,Transaction Amount,Transaction Type',
    '07/09/2026,CHECK 2002,250.00,Debit',
    '07/10/2026,DEPOSIT,100.00,Credit',
  ].join('\n')), [-25000, 10000]);

  // an export that signs its own amounts is left alone — a card refund labelled DEBIT_CARD is still money in
  assert.deepEqual(amounts([
    'Details,Posting Date,Description,Amount,Type',
    'DEBIT,07/11/2026,HARDWARE STORE,-45.10,DEBIT_CARD',
    'CREDIT,07/12/2026,HARDWARE STORE REFUND,45.10,DEBIT_CARD',
    'DEBIT,07/13/2026,CHECK 2003,-300.00,CHECK',
  ].join('\n')), [-4510, 4510, -30000]);

  // through the upload route, onto the account
  const fx = mkOrg('live', '2026-08-05');
  const ctx = ctxOf(fx.adminId);
  const cookie = await loginAs(base, fx.admin);
  postBankOpeningBalance(ctx, fx.propA, 100000, '2026-06-30');
  const acct = operating(fx.org, fx.propA);
  const up = await upload(acct.id, 'july.csv', ['Date,Description,Transaction Amount,Transaction Type', '07/09/2026,CHECK 2002,250.00,Debit', '07/14/2026,ACH UTILITY,75.00,DR'].join('\n'), cookie);
  assert.match(up.flash, /2 transactions imported/);
  const up2 = await upload(acct.id, 'july-b.csv', ['Date,Description,Amount', '07/20/2026,ACH INSURANCE,$-60.00', '07/21/2026,CHECK 2004,40.00-'].join('\n'), cookie);
  assert.match(up2.flash, /2 transactions imported/);
  assert.deepEqual(
    q<any>('SELECT description, amount_cents FROM bank_txns WHERE bank_account_id=? ORDER BY date', acct.id).map((t) => [t.description, t.amount_cents]),
    [['CHECK 2002', -25000], ['ACH UTILITY', -7500], ['ACH INSURANCE', -6000], ['CHECK 2004', -4000]],
  );
  assert.equal(count(`SELECT COALESCE(SUM(amount_cents),0) FROM bank_txns WHERE bank_account_id=?`, acct.id), -42500, 'the statement total moves down, not up');
});

// ---------------------------------------------------------------- item 9
test('item 9: banking follows property scope — another property’s account, or the organization’s own, is out of reach', async () => {
  const fx = mkOrg('live', '2026-08-05');
  const admin = ctxOf(fx.adminId);
  const adminCookie = await loginAs(base, fx.admin);
  const scopedEmail = `scoped-racct-${sfx}@example.test`;
  const scopedId = mkUser(fx.org, scopedEmail, 'Sky Scoped', 'ACCOUNTANT', [fx.propA]);
  const scoped = ctxOf(scopedId);
  assert.equal(scoped.allProperties, false);
  const cookie = await loginAs(base, scopedEmail);

  postBankOpeningBalance(admin, fx.propA, 100000, '2026-06-30'); // creates an operating account per property
  run(`UPDATE bank_accounts SET name='Alder operating AAA' WHERE org_id=? AND property_id=?`, fx.org, fx.propA);
  run(`UPDATE bank_accounts SET name='Birch operating BBB' WHERE org_id=? AND property_id=?`, fx.org, fx.propB);
  const orgAcct = id('bank');
  insert('bank_accounts', { id: orgAcct, org_id: fx.org, property_id: null, name: 'Company sweep CCC', kind: 'operating', gl_account: '1010', bank_name: 'Bank', last4: '0001', active: 1, created_at: nowIso() });
  const a = operating(fx.org, fx.propA);
  const b = operating(fx.org, fx.propB);

  // what the administrator set up on B and on the organization's account
  const bLine = addStatementLine(admin, b.id, { date: '2026-07-10', description: 'B LINE', amountCents: -250000 });
  const bRec = createRecon(admin, b.id, '2026-07', { statementCloseCents: -250000 });
  const bMatched = addStatementLine(admin, b.id, { date: '2026-07-11', description: 'B FEE', amountCents: -1000 });
  postAdjustment(admin, bMatched, bRec, { account: '5710' });
  const orgLine = addStatementLine(admin, orgAcct, { date: '2026-07-10', description: 'ORG LINE', amountCents: -40000 });
  const orgRec = createRecon(admin, orgAcct, '2026-07', { statementCloseCents: -40000 });
  const jeCount = (): number => count('SELECT COUNT(*) FROM journal_entries WHERE org_id=?', fx.org);
  const lineCount = (): number => count('SELECT COUNT(*) FROM bank_txns WHERE org_id=?', fx.org);
  const je0 = jeCount(); const lines0 = lineCount();

  // ---- lists show only what the person can work on ----
  const list = await get(base, '/banking', cookie);
  assert.equal(list.status, 200);
  assert.match(list.text, /Alder operating AAA/);
  assert.doesNotMatch(list.text, /Birch operating BBB/);
  assert.doesNotMatch(list.text, /Company sweep CCC/);
  const setup = await get(base, '/gl/setup', cookie);
  assert.match(setup.text, /Alder operating AAA/);
  assert.doesNotMatch(setup.text, /Birch operating BBB|Company sweep CCC/);

  // ---- every route on an out-of-scope account answers "not found" and changes nothing ----
  for (const [acctId, lineId, matchedId, recId] of [[b.id, bLine, bMatched, bRec], [orgAcct, orgLine, '', orgRec]] as [string, string, string, string][]) {
    for (const path of [`/banking/${acctId}`, `/banking/${acctId}/reconcile`, `/banking/${acctId}/reconcile/${recId}/report`, `/banking/txn/${lineId}`]) {
      assert.equal((await get(base, path, cookie)).status, 404, `GET ${path}`);
    }
    const writes: [string, Record<string, string>][] = [
      [`/banking/${acctId}/txn`, { date: '2026-07-12', direction: 'out', description: 'SNEAK', amount: '2,500.00' }],
      [`/banking/${acctId}/reconcile/start`, { month: '2026-06', statement_close: '0.00' }],
      [`/banking/${acctId}/reconcile/${recId}/statement`, { statement_close: '1.00' }],
      [`/banking/${acctId}/reconcile/${recId}/automatch`, {}],
      [`/banking/${acctId}/reconcile/${recId}/complete`, {}],
      [`/banking/txn/${lineId}/adjust`, { account: '5810', memo: 'sneak' }],
      [`/banking/txn/${lineId}/adjust`, { account: '5810', memo: 'sneak', property_id: fx.propA }],
      [`/banking/txn/${lineId}/exclude`, { reason: 'sneak' }],
      [`/banking/txn/${lineId}/match`, { entry_ids: 'je_x' }],
      [`/banking/${acctId}/entries/je_x/opening`, { month: '2026-07' }],
      [`/gl/setup/bank/${acctId}`, { name: 'Renamed', bank_name: 'X', last4: '' }],
      [`/gl/setup/bank/${acctId}/toggle`, {}],
    ];
    if (matchedId) writes.push([`/banking/txn/${matchedId}/unmatch`, {}]);
    for (const [path, body] of writes) assert.equal((await post(path, body, cookie)).status, 404, `POST ${path}`);
    assert.equal((await upload(acctId, 's.csv', 'Date,Description,Amount\n07/01/2026,SNEAK,-1.00', cookie)).status, 404, 'upload');
  }
  assert.equal(jeCount(), je0, 'no entry reached another property’s books');
  assert.equal(lineCount(), lines0, 'no statement line added');
  assert.deepEqual(
    q<any>('SELECT id, status FROM bank_recons WHERE org_id=? ORDER BY id', fx.org).map((r) => r.status), ['in_progress', 'in_progress'], 'no reconciliation started or completed');
  assert.equal(q1<any>('SELECT statement_close_cents FROM bank_recons WHERE id=?', bRec).statement_close_cents, -250000);
  assert.equal(q1<any>('SELECT status FROM bank_txns WHERE id=?', bLine).status, 'unmatched');
  assert.equal(q1<any>('SELECT status FROM bank_txns WHERE id=?', bMatched).status, 'matched');
  assert.deepEqual([q1<any>('SELECT name, active FROM bank_accounts WHERE id=?', b.id).name, q1<any>('SELECT active FROM bank_accounts WHERE id=?', b.id).active], ['Birch operating BBB', 1]);
  // the service refuses too, whoever calls it
  assert.throws(() => postAdjustment(scoped, bLine, null, { account: '5810' }), /not found/);
  assert.equal(accountBalance(admin, '5810', { propertyId: fx.propB, basis: 'accrual' }), 0);

  // ---- an account cannot be created outside the person's properties, or for the whole organization ----
  const n0 = count('SELECT COUNT(*) FROM bank_accounts WHERE org_id=?', fx.org);
  assert.match((await post('/gl/setup/bank', { name: 'Sneak', last4: '1234', property_id: fx.propB }, cookie)).flash, /Choose a property in your portfolio/);
  assert.match((await post('/gl/setup/bank', { name: 'Sneak', last4: '1234', property_id: '' }, cookie)).flash, /Choose the property this account belongs to/);
  assert.match((await post('/banking/accounts', {}, cookie)).flash, /needs access to all properties/);
  assert.equal(count('SELECT COUNT(*) FROM bank_accounts WHERE org_id=?', fx.org), n0);
  assert.match((await post('/gl/setup/bank', { name: 'Alder reserve', last4: '1234', property_id: fx.propA }, cookie)).flash, /Alder reserve added/);

  // ---- and the person's own property works as before ----
  assert.equal((await get(base, `/banking/${a.id}`, cookie)).status, 200);
  assert.equal((await get(base, `/banking/${a.id}/reconcile?month=2026-07`, cookie)).status, 200);
  assert.match((await post(`/banking/${a.id}/txn`, { date: '2026-07-15', direction: 'out', description: 'WIRE FEE', amount: '12.50' }, cookie)).flash, /Statement line added/);
  const aLine = q1<any>(`SELECT id FROM bank_txns WHERE bank_account_id=?`, a.id).id as string;
  assert.match((await post(`/banking/${a.id}/reconcile/start`, { month: '2026-07', statement_close: '987.50' }, cookie)).flash, /Reconciliation started/);
  assert.match((await post(`/banking/txn/${aLine}/adjust`, { account: '5710' }, cookie)).flash, /posted and matched/);
  assert.equal(accountBalance(admin, '5710', { propertyId: fx.propA, basis: 'accrual' }), 1250);
  assert.equal(accountBalance(admin, '5710', { propertyId: fx.propA, basis: 'cash' }), 1250);
  const aRec = q1<any>('SELECT id FROM bank_recons WHERE bank_account_id=?', a.id).id as string;
  assert.match((await post(`/banking/${a.id}/reconcile/${aRec}/complete`, {}, cookie)).flash, /Reconciled to zero difference/);

  // ---- someone with the whole portfolio still reaches everything ----
  for (const path of [`/banking/${b.id}`, `/banking/${orgAcct}`, `/banking/${b.id}/reconcile/${bRec}/report`, `/banking/txn/${orgLine}`]) {
    assert.equal((await get(base, path, adminCookie)).status, 200, `admin GET ${path}`);
  }
  const all = await get(base, '/banking', adminCookie);
  assert.match(all.text, /Birch operating BBB/);
  assert.match(all.text, /Company sweep CCC/);
  // an entry recorded on the organization's account lands on a property the poster may use
  assert.match((await post(`/banking/txn/${orgLine}/adjust`, { account: '5810', property_id: fx.propB }, adminCookie)).flash, /posted and matched/);
  assert.equal(accountBalance(admin, '5810', { propertyId: fx.propB, basis: 'accrual' }), 40000);
  assert.equal(failed(admin), '[]');
});
