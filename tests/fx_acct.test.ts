import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert, val } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword, sysCtx, buildCtx } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { postJE, postBothBases, accountBalance, runInvariants } from '../src/modules/m9_accounting/service.ts';
import { createInvoice, approveInvoice, createPaymentRun } from '../src/modules/m9_accounting/ap.ts';
import {
  ensureBankAccounts, importAllFeeds, createRecon, completeRecon, autoMatch, postAdjustment, unclearedBookItems, reconSummary, BANK_NOT_SPECIFIED,
} from '../src/modules/m9_accounting/banking.ts';
import { closeChecklist, submitManualJe, decidePendingJe } from '../src/modules/m9_accounting/close.ts';
import { parseBankCsv } from '../src/modules/m9_accounting/finops.ts';
import { postBankOpeningBalance, uniquePropertySlug } from '../src/modules/setup/import_apply.ts';
import { classifyBySignature } from '../src/modules/setup/ai_classify.ts';
import { startTestServer, loginAs, get } from './harness.ts';

/** Regression guards for the "walk every feature as a real company" pass —
 * accounting area. Each test is one confirmed defect: the thing a live
 * (non-demo) operator did, and what must now be true in the database.
 * Own fixtures (one live org with two properties, one demo org), so nothing
 * here disturbs the shared harness orgs. */

let base: string;
let close: () => void;
const sfx = id('x').slice(-6);
const BD = '2026-08-05';

interface Fx { org: string; propA: string; propB: string; admin: string; adminId: string; second: string; secondId: string; vendor: string }
let live: Fx;
let solo: Fx; // a live org with exactly one person who can approve
let demo: Fx;
let cookie: string;

function mkUser(org: string, email: string, name: string, role: string): string {
  const uid = id('usr');
  insert('users', { id: uid, org_id: org, email, name, kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso() });
  insert('role_assignments', { id: id('ra'), org_id: org, user_id: uid, role, scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  return uid;
}

function mkProp(org: string, name: string): string {
  const pid = id('prp');
  insert('properties', { id: pid, org_id: org, name, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id('s').slice(-5)}`, type: 'multifamily', address1: '1 Test St', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso() });
  return pid;
}

function mkOrg(kind: 'demo' | 'live', tag: string, withSecond: boolean): Fx {
  const org = id('org');
  insert('orgs', { id: org, name: `Acct ${tag} ${sfx}`, slug: `acct-${tag}-${sfx}`, kind, business_date: BD, created_at: nowIso() });
  ensureCoa(org);
  const admin = `admin-acct-${tag}-${sfx}@example.test`;
  const adminId = mkUser(org, admin, `Avery ${tag}`, 'ORG_ADMIN');
  const second = `acct2-${tag}-${sfx}@example.test`;
  const secondId = withSecond ? mkUser(org, second, `Blake ${tag}`, 'ACCOUNTANT') : '';
  const propA = mkProp(org, `Alder ${tag} ${sfx}`);
  const propB = mkProp(org, `Birch ${tag} ${sfx}`);
  const vendor = id('ven');
  insert('vendors', { id: vendor, org_id: org, name: `Vendor ${tag}`, category: 'general', active: 1, created_at: nowIso() });
  return { org, propA, propB, admin, adminId, second, secondId, vendor };
}

function ctxOf(userId: string) {
  return buildCtx(q1<any>('SELECT * FROM users WHERE id=?', userId), null, null);
}

interface Posted { status: number; location: string | null; flash: string }

/** the flash message a redirect carries (it travels in a cookie, not the URL) */
function flashOf(resp: Response): string {
  const m = /sl_fl=([^;]+)/.exec(resp.headers.get('set-cookie') || '');
  return m ? decodeURIComponent(m[1]!).replace(/^(ok|err)\|/, '') : '';
}

/** form POST that can repeat a field (checkbox lists) */
async function postMulti(path: string, pairs: [string, string][], ck: string): Promise<Posted> {
  const body = new URLSearchParams();
  for (const [k, v] of pairs) body.append(k, v);
  const resp = await fetch(base + path, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, cookie: ck },
    body: body.toString(),
  });
  await resp.text();
  return { status: resp.status, location: resp.headers.get('location'), flash: flashOf(resp) };
}

function post(_base: string, path: string, body: Record<string, string>, ck: string): Promise<Posted> {
  return postMulti(path, Object.entries(body), ck);
}

async function uploadStatement(acctId: string, filename: string, text: string, ck: string): Promise<string> {
  const fd = new FormData();
  fd.append('statement', new Blob([text], { type: 'text/csv' }), filename);
  const resp = await fetch(`${base}/banking/${acctId}/upload`, { method: 'POST', redirect: 'manual', headers: { origin: base, cookie: ck }, body: fd });
  await resp.text();
  assert.equal(resp.status, 303, 'upload redirects');
  return flashOf(resp);
}

const count = (sql: string, ...p: unknown[]): number => Number(val<number>(sql, ...p) || 0);

before(async () => {
  db();
  live = mkOrg('live', 'live', true);
  solo = mkOrg('live', 'solo', false);
  demo = mkOrg('demo', 'demo', true);
  const s = await startTestServer();
  base = s.base; close = s.close;
  cookie = await loginAs(base, live.admin);
});

after(() => close());

// ---------------------------------------------------------------- item 3
test('item 3: a second opening bank balance for the same property is refused, not stacked', () => {
  const ctx = ctxOf(live.adminId);
  postBankOpeningBalance(ctx, live.propA, 1000000, '2026-06-30');
  assert.throws(() => postBankOpeningBalance(ctx, live.propA, 1000000, '2026-06-30'), /already posted for this property/);
  assert.throws(() => postBankOpeningBalance(ctx, live.propA, 55555, '2026-07-01'), /\$10,000\.00/);
  assert.equal(accountBalance(ctx, '1010', { propertyId: live.propA, basis: 'accrual' }), 1000000, 'cash carried in once');
  assert.equal(accountBalance(ctx, '1010', { propertyId: live.propA, basis: 'cash' }), 1000000);
  assert.equal(count(`SELECT COUNT(*) FROM journal_entries WHERE org_id=? AND source_kind='conversion' AND source_id=? AND basis='accrual'`, live.org, live.propA), 1);
  // the other property is independent
  postBankOpeningBalance(ctx, live.propB, 200000, '2026-06-30');
  assert.equal(accountBalance(ctx, '1010', { propertyId: live.propB, basis: 'accrual' }), 200000);
});

test('item 1 (shared helper): uniquePropertySlug is exported and avoids a taken slug', () => {
  const taken = q1<any>('SELECT slug FROM properties WHERE id=?', live.propA).slug as string;
  const next = uniquePropertySlug(taken);
  assert.notEqual(next, taken);
  assert.equal(q1('SELECT id FROM properties WHERE slug=?', next), undefined);
});

// ---------------------------------------------------------- items 4 + 28
test('items 4/28: a live org gets no invented bank name or account number, and can edit or retire an account', async () => {
  // postBankOpeningBalance above created the rows
  const rows = q<any>(`SELECT * FROM bank_accounts WHERE org_id=? ORDER BY created_at`, live.org);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.bank_name, BANK_NOT_SPECIFIED);
    assert.equal(r.last4, '');
  }
  // a row left behind by the old code is corrected, not displayed
  const stale = id('bnk');
  insert('bank_accounts', { id: stale, org_id: solo.org, property_id: solo.propA, name: 'Old — Operating', kind: 'operating', gl_account: '1010', last4: '4410', active: 1, created_at: nowIso() });
  assert.equal(q1<any>('SELECT bank_name FROM bank_accounts WHERE id=?', stale).bank_name, 'First Simulated Bank', 'schema default still applies to a bare insert');
  ensureBankAccounts(solo.org);
  const fixed = q1<any>('SELECT * FROM bank_accounts WHERE id=?', stale);
  assert.equal(fixed.bank_name, BANK_NOT_SPECIFIED);
  assert.equal(fixed.last4, '');

  const page = await get(base, '/banking', cookie);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /First Simulated Bank/);
  assert.doesNotMatch(page.text, /Pull latest feed/);
  assert.doesNotMatch(page.text, /BankFeed/);
  assert.match(page.text, /No bank is connected/);
  assert.match(page.text, /Bank not specified/);

  // edit: the operator says which bank it really is
  const acct = rows.find((r) => r.property_id === live.propB)!;
  const r1 = await post(base, `/gl/setup/bank/${acct.id}`, { name: 'Birch operating', bank_name: 'First National', last4: '8821' }, cookie);
  assert.equal(r1.status, 303);
  const edited = q1<any>('SELECT * FROM bank_accounts WHERE id=?', acct.id);
  assert.deepEqual([edited.name, edited.bank_name, edited.last4], ['Birch operating', 'First National', '8821']);
  const bad = await post(base, `/gl/setup/bank/${acct.id}`, { name: 'Birch operating', bank_name: 'First National', last4: '12' }, cookie);
  assert.match(bad.flash, /last 4 digits/);
  assert.equal(q1<any>('SELECT last4 FROM bank_accounts WHERE id=?', acct.id).last4, '8821');

  // retire it, add the real one: month-end close must look at the active account
  await post(base, `/gl/setup/bank/${acct.id}/toggle`, {}, cookie);
  assert.equal(q1<any>('SELECT active FROM bank_accounts WHERE id=?', acct.id).active, 0);
  const ctx = ctxOf(live.adminId);
  assert.match(closeChecklist(ctx, live.propB, '2026-07').find((i) => i.key === 'bank_rec')!.detail, /no active operating bank account/);
  await post(base, `/gl/setup/bank/${acct.id}/toggle`, {}, cookie);
  assert.equal(q1<any>('SELECT active FROM bank_accounts WHERE id=?', acct.id).active, 1);

  // another org's account cannot be edited
  const other = q1<any>('SELECT id FROM bank_accounts WHERE org_id=?', solo.org).id as string;
  const cross = await post(base, `/gl/setup/bank/${other}`, { name: 'Hijack', bank_name: 'X', last4: '1111' }, cookie);
  assert.equal(cross.status, 404);
  assert.notEqual(q1<any>('SELECT name FROM bank_accounts WHERE id=?', other).name, 'Hijack');
});

// ---------------------------------------------------------------- item 29
test('item 29: the simulated bank feed writes nothing in a live org, by any route', async () => {
  const before = count('SELECT COUNT(*) FROM bank_txns WHERE org_id=?', live.org);
  // there IS book activity the simulator would mirror (the opening entries)
  assert.equal(importAllFeeds(live.org, BD), 0);
  const r = await post(base, '/banking/import', {}, cookie);
  assert.equal(r.status, 303);
  assert.match(r.flash, /No bank is connected/);
  assert.equal(count('SELECT COUNT(*) FROM bank_txns WHERE org_id=?', live.org), before, 'no fabricated bank lines');
  // ...and it still works for a demo org
  const dctx = sysCtx(demo.org);
  ensureBankAccounts(demo.org);
  postBothBases(dctx, { propertyId: demo.propA, date: '2026-07-02', memo: 'Owner funding', sourceKind: 'manual', lines: [{ account: '1010', debit: 500000 }, { account: '3020', credit: 500000 }] });
  assert.ok(importAllFeeds(demo.org, BD) >= 1, 'demo feed still simulates');
  assert.equal(q1<any>('SELECT bank_name FROM bank_accounts WHERE org_id=? LIMIT 1', demo.org).bank_name, 'First Simulated Bank');
});

// ---------------------------------------------------------------- item 76
test('item 76: opening the banking pages writes nothing', async () => {
  const acct = q1<any>(`SELECT id FROM bank_accounts WHERE org_id=? AND property_id=?`, live.org, live.propA).id as string;
  const recons = count('SELECT COUNT(*) FROM bank_recons WHERE org_id=?', live.org);
  const audits = count('SELECT COUNT(*) FROM audit_events WHERE org_id=?', live.org);
  for (const path of [`/banking/${acct}/reconcile`, `/banking/${acct}/reconcile?month=2031-01`, `/banking/${acct}/reconcile?month=garbage`, `/banking/${acct}`, '/banking']) {
    const r = await get(base, path, cookie);
    assert.equal(r.status, 200, path);
  }
  assert.equal(count('SELECT COUNT(*) FROM bank_recons WHERE org_id=?', live.org), recons, 'a GET started no reconciliation');
  assert.equal(count('SELECT COUNT(*) FROM audit_events WHERE org_id=?', live.org), audits, 'a GET audited nothing');
  // a live org with a property and no account: the page offers, it does not create
  const scookie = await loginAs(base, solo.admin);
  mkProp(solo.org, `Cedar solo ${sfx}`);
  const had = count('SELECT COUNT(*) FROM bank_accounts WHERE org_id=?', solo.org);
  const page = await get(base, '/banking', scookie);
  assert.equal(page.status, 200);
  assert.equal(count('SELECT COUNT(*) FROM bank_accounts WHERE org_id=?', solo.org), had);
  assert.match(page.text, /Create an operating account for each property/);
  // ...and the button (a POST) does, with nothing invented
  await post(base, '/banking/accounts', {}, scookie);
  assert.equal(count('SELECT COUNT(*) FROM bank_accounts WHERE org_id=?', solo.org), had + 1);
  assert.equal(count(`SELECT COUNT(*) FROM bank_accounts WHERE org_id=? AND (bank_name!=? OR last4!='')`, solo.org, BANK_NOT_SPECIFIED), 0);
});

// ---------------------------------------------------------------- item 30
test('item 30: a live org reconciles a month from an uploaded file and hand-typed lines, and it has to tie', async () => {
  const ctx = ctxOf(live.adminId);
  const acct = q1<any>(`SELECT * FROM bank_accounts WHERE org_id=? AND property_id=?`, live.org, live.propA);
  const A = live.propA;

  // --- July on the books (opening balance 10,000.00 was posted 06-30) ---
  const dep1 = postBothBases(ctx, { propertyId: A, date: '2026-07-02', memo: 'Rent received — unit 1', sourceKind: 'manual', lines: [{ account: '1010', debit: 150000 }, { account: '4010', credit: 150000 }] }).accrual;
  const dep2 = postBothBases(ctx, { propertyId: A, date: '2026-07-02', memo: 'Rent received — unit 2', sourceKind: 'manual', lines: [{ account: '1010', debit: 150000 }, { account: '4010', credit: 150000 }] }).accrual;
  const xfer = postBothBases(ctx, { propertyId: A, date: '2026-07-20', memo: 'Transfer to reserve account', sourceKind: 'manual', lines: [{ account: '1030', debit: 200000 }, { account: '1010', credit: 200000 }] }).accrual;
  const mkInv = (num: string, cents: number): string => {
    const inv = createInvoice(ctx, { vendorId: live.vendor, propertyId: A, invoiceNumber: num, invoiceDate: '2026-07-05', lines: [{ glAccount: '5010', description: 'Repair', amountCents: cents }] });
    approveInvoice(ctx, inv);
    return inv;
  };
  const inv1 = mkInv(`R-1-${sfx}`, 50000);
  const inv2 = mkInv(`R-2-${sfx}`, 30000);
  createPaymentRun(ctx, { runDate: '2026-07-08', method: 'check', invoiceIds: [inv1], references: { [inv1]: '1042' } });
  createPaymentRun(ctx, { runDate: '2026-07-30', method: 'check', invoiceIds: [inv2], references: { [inv2]: '1043' } }); // will not clear in July
  const pay1 = q1<any>('SELECT * FROM ap_payments WHERE invoice_id=?', inv1);
  const pay2 = q1<any>('SELECT * FROM ap_payments WHERE invoice_id=?', inv2);
  assert.equal(pay1.status, 'issued');

  // --- the statement: a bank CSV with two identical lines, plus one typed in ---
  const csv = [
    'Date,Description,Debit,Credit',
    '07/03/2026,"DEPOSIT, BRANCH 12",,"3,000.00"',
    '07/10/2026,CHECK 1042,500.00,',
    '07/15/2026,WIRE FEE,12.50,',
    '07/15/2026,WIRE FEE,12.50,',
  ].join('\r\n');
  assert.equal(parseBankCsv(csv).length, 4, 'two identical lines are two lines');
  assert.match(await uploadStatement(acct.id, 'july.csv', csv, cookie), /4 transactions imported from july\.csv \(0 already present\)/);
  assert.match(await uploadStatement(acct.id, 'july.csv', csv, cookie), /0 transactions imported from july\.csv \(4 already present\)/);
  assert.equal(count('SELECT COUNT(*) FROM bank_txns WHERE bank_account_id=?', acct.id), 4);
  const typed = await post(base, `/banking/${acct.id}/txn`, { date: '2026-07-20', direction: 'out', description: 'ONLINE TRANSFER 4471', amount: '2,000.00', month: '2026-07' }, cookie);
  assert.match(typed.flash, /Statement line added/);
  const badLine = await post(base, `/banking/${acct.id}/txn`, { date: '2026-07-21', direction: 'out', description: 'X', amount: 'lots' }, cookie);
  assert.match(badLine.flash, /Enter the amount/);
  const lines = q<any>('SELECT * FROM bank_txns WHERE bank_account_id=? ORDER BY date, amount_cents', acct.id);
  assert.equal(lines.length, 5);
  const line = (re: RegExp): any => lines.find((l) => re.test(l.description));
  assert.equal(line(/ONLINE TRANSFER/).amount_cents, -200000);
  assert.equal(line(/DEPOSIT/).amount_cents, 300000);

  // --- start: a real statement states its ending balance; nothing is guessed ---
  const noBal = await post(base, `/banking/${acct.id}/reconcile/start`, { month: '2026-07', statement_close: '' }, cookie);
  assert.match(noBal.flash, /Enter the ending balance/);
  assert.equal(count('SELECT COUNT(*) FROM bank_recons WHERE bank_account_id=?', acct.id), 0);
  assert.throws(() => createRecon(ctx, acct.id, '2026-07'), /ending balance/);
  // 10,000 + 3,000 − 500 − 12.50 − 12.50 − 2,000 = 10,475.00
  await post(base, `/banking/${acct.id}/reconcile/start`, { month: '2026-07', statement_close: '10,475.00' }, cookie);
  const rec = q1<any>('SELECT * FROM bank_recons WHERE bank_account_id=? AND period_key=?', acct.id, '2026-07');
  assert.ok(rec, 'reconciliation started by POST');
  assert.equal(rec.statement_close_cents, 1047500);
  assert.equal(rec.statement_open_cents, 1000000, 'opening balance works back from the lines on file');

  // --- cannot complete with lines open ---
  let done = await post(base, `/banking/${acct.id}/reconcile/${rec.id}/complete`, {}, cookie);
  assert.match(done.flash, /still unmatched/);

  // --- auto-match: the check by its number; the 3,000 deposit has no single entry ---
  const am = await post(base, `/banking/${acct.id}/reconcile/${rec.id}/automatch`, {}, cookie);
  assert.match(am.flash, /2 matched · 3 still open/);
  const chk = q1<any>('SELECT * FROM bank_txns WHERE id=?', line(/CHECK 1042/).id);
  assert.deepEqual([chk.status, chk.matched_kind, chk.matched_id], ['matched', 'ap_payment', pay1.id]);
  const cleared = q1<any>('SELECT status, cleared_date FROM ap_payments WHERE id=?', pay1.id);
  assert.deepEqual([cleared.status, cleared.cleared_date], ['cleared', '2026-07-10'], 'matching a payment clears it on the register');
  assert.equal(q1<any>('SELECT status FROM bank_txns WHERE id=?', line(/ONLINE TRANSFER/).id).status, 'matched', 'lone equal amount close in date');
  assert.equal(q1<any>('SELECT matched_id FROM bank_txns WHERE id=?', line(/ONLINE TRANSFER/).id).matched_id, xfer);

  // --- the match page lists what the books hold; one deposit, two receipts ---
  const depLine = line(/DEPOSIT/);
  const mp = await get(base, `/banking/txn/${depLine.id}`, cookie);
  assert.equal(mp.status, 200);
  assert.match(mp.text, /Rent received — unit 1/);
  assert.match(mp.text, /Rent received — unit 2/);
  const short = await postMulti(`/banking/txn/${depLine.id}/match`, [['entry_ids', dep1]], cookie);
  assert.match(short.flash, /add up to \$1,500\.00, but the statement line is \$3,000\.00/);
  assert.equal(q1<any>('SELECT status FROM bank_txns WHERE id=?', depLine.id).status, 'unmatched');
  await postMulti(`/banking/txn/${depLine.id}/match`, [['entry_ids', dep1], ['entry_ids', dep2]], cookie);
  assert.equal(q1<any>('SELECT status FROM bank_txns WHERE id=?', depLine.id).status, 'matched');
  assert.equal(count('SELECT COUNT(*) FROM bank_txn_links WHERE bank_txn_id=?', depLine.id), 2);
  // an entry already cleared cannot be matched to a second line
  const fees = lines.filter((l) => /WIRE FEE/.test(l.description));
  const reuse = await postMulti(`/banking/txn/${fees[0].id}/match`, [['entry_ids', dep1]], cookie);
  assert.match(reuse.flash, /no longer available/);

  // --- bank-only lines go on the books to the account the operator names ---
  const cash0 = accountBalance(ctx, '1010', { propertyId: A, basis: 'accrual' });
  await post(base, `/banking/txn/${fees[0].id}/adjust`, { account: '5710', memo: 'Wire fee' }, cookie);
  assert.equal(accountBalance(ctx, '1010', { propertyId: A, basis: 'accrual' }), cash0 - 1250);
  assert.equal(accountBalance(ctx, '5710', { propertyId: A, basis: 'cash' }), 1250, 'both books');
  const ownAcct = await post(base, `/banking/txn/${fees[1].id}/adjust`, { account: '1010' }, cookie);
  assert.match(ownAcct.flash, /not the bank account itself/);

  // --- setting a real line aside does not make the month tie ---
  await post(base, `/banking/txn/${fees[1].id}/exclude`, { reason: 'trying to skip it' }, cookie);
  assert.equal(q1<any>('SELECT status FROM bank_txns WHERE id=?', fees[1].id).status, 'excluded');
  done = await post(base, `/banking/${acct.id}/reconcile/${rec.id}/complete`, {}, cookie);
  assert.match(done.flash, /\$12\.50 apart/);
  assert.equal(q1<any>('SELECT status FROM bank_recons WHERE id=?', rec.id).status, 'in_progress', 'everything matched or set aside is not enough');
  await post(base, `/banking/txn/${fees[1].id}/unmatch`, {}, cookie);
  assert.equal(q1<any>('SELECT status FROM bank_txns WHERE id=?', fees[1].id).status, 'unmatched');
  await post(base, `/banking/txn/${fees[1].id}/adjust`, { account: '5710' }, cookie);

  // --- a wrong ending balance does not tie either ---
  await post(base, `/banking/${acct.id}/reconcile/${rec.id}/statement`, { statement_close: '10000.00' }, cookie);
  done = await post(base, `/banking/${acct.id}/reconcile/${rec.id}/complete`, {}, cookie);
  assert.match(done.flash, /\$475\.00 apart/);
  await post(base, `/banking/${acct.id}/reconcile/${rec.id}/statement`, { statement_close: '10475.00' }, cookie);

  // --- the picture before completing: one check still outstanding, nothing unexplained ---
  const s = reconSummary(ctx, rec.id);
  assert.equal(s.unmatchedCount, 0);
  assert.equal(s.bookClose, 1000000 + 300000 - 50000 - 30000 - 200000 - 2500);
  assert.deepEqual(s.outstanding.map((o) => o.amount), [-30000], 'check 1043 has not reached the bank');
  assert.match(s.outstanding[0]!.desc, /1043/);
  assert.equal(s.inTransit.length, 0);
  assert.equal(s.tieDifference, 0);
  const wb = await get(base, `/banking/${acct.id}/reconcile?month=2026-07`, cookie);
  assert.match(wb.text, /Still to explain/);
  assert.match(wb.text, /Check 1043/);

  // --- complete ---
  done = await post(base, `/banking/${acct.id}/reconcile/${rec.id}/complete`, {}, cookie);
  assert.match(done.flash, /zero difference/);
  const fin = q1<any>('SELECT * FROM bank_recons WHERE id=?', rec.id);
  assert.deepEqual([fin.status, fin.statement_close_cents, fin.difference_cents], ['completed', 1047500, 0]);
  assert.equal(closeChecklist(ctx, A, '2026-07').find((i) => i.key === 'bank_rec')!.ok, true, 'month-end close sees it');
  assert.equal(q1<any>('SELECT status FROM ap_payments WHERE id=?', pay2.id).status, 'issued', 'the outstanding check stays outstanding');

  // --- a finished month is closed to new lines and to un-matching ---
  const late = await post(base, `/banking/${acct.id}/txn`, { date: '2026-07-28', direction: 'in', description: 'LATE', amount: '5.00' }, cookie);
  assert.match(late.flash, /already reconciled/);
  const undo = await post(base, `/banking/txn/${depLine.id}/unmatch`, {}, cookie);
  assert.match(undo.flash, /already reconciled/);
  assert.equal(q1<any>('SELECT status FROM bank_txns WHERE id=?', depLine.id).status, 'matched');

  // --- August: the outstanding check clears, matched by hand; un-matching puts it back ---
  await post(base, `/banking/${acct.id}/txn`, { date: '2026-08-03', direction: 'out', description: 'CHECK PAID', amount: '300.00' }, cookie);
  const aug = q1<any>(`SELECT * FROM bank_txns WHERE bank_account_id=? AND date='2026-08-03'`, acct.id);
  await postMulti(`/banking/txn/${aug.id}/match`, [['entry_ids', pay2.je_id]], cookie);
  assert.deepEqual(Object.values(q1<any>('SELECT status, cleared_date FROM ap_payments WHERE id=?', pay2.id)), ['cleared', '2026-08-03']);
  assert.equal(unclearedBookItems(live.org, acct, '2026-08-31').length, 0, 'nothing left outstanding');
  await post(base, `/banking/txn/${aug.id}/unmatch`, {}, cookie);
  assert.deepEqual(Object.values(q1<any>('SELECT status, cleared_date FROM ap_payments WHERE id=?', pay2.id)), ['issued', null]);

  // --- another org cannot touch these lines ---
  const scookie = await loginAs(base, solo.admin);
  assert.equal((await get(base, `/banking/txn/${aug.id}`, scookie)).status, 404);
  assert.equal((await post(base, `/banking/txn/${aug.id}/exclude`, { reason: 'x' }, scookie)).status, 404);
  assert.equal((await get(base, `/banking/${acct.id}/reconcile`, scookie)).status, 404);
});

test('item 30: an empty month cannot be completed against a statement balance the books do not support', () => {
  const ctx = ctxOf(live.adminId);
  const acctB = q1<any>(`SELECT * FROM bank_accounts WHERE org_id=? AND property_id=?`, live.org, live.propB);
  // books: 2,000.00 opening. No statement lines at all.
  const wrong = createRecon(ctx, acctB.id, '2026-07', { statementCloseCents: 250000 });
  assert.throws(() => completeRecon(ctx, wrong), /\$500\.00 apart/);
  assert.equal(q1<any>('SELECT status FROM bank_recons WHERE id=?', wrong).status, 'in_progress');
});

test('item 30: an entry older than the first statement can be counted as part of the opening bank balance — a later one cannot', async () => {
  const ctx = ctxOf(live.adminId);
  const acctB = q1<any>(`SELECT * FROM bank_accounts WHERE org_id=? AND property_id=?`, live.org, live.propB);
  const rec = q1<any>(`SELECT * FROM bank_recons WHERE bank_account_id=? AND period_key='2026-07'`, acctB.id);
  // money that was already in the bank before July, brought onto the books by journal entry
  const old = postBothBases(ctx, { propertyId: live.propB, date: '2026-06-15', memo: 'Cash on hand at takeover', sourceKind: 'manual', lines: [{ account: '1010', debit: 50000 }, { account: '3030', credit: 50000 }] }).accrual;
  const inJuly = postBothBases(ctx, { propertyId: live.propB, date: '2026-07-09', memo: 'Deposit not yet at the bank', sourceKind: 'manual', lines: [{ account: '1010', debit: 7000 }, { account: '4080', credit: 7000 }] }).accrual;
  // books 2,570.00; statement says 2,500.00; 500.00 + 70.00 not on any statement
  assert.equal(reconSummary(ctx, rec.id).tieDifference, -50000);
  const no = await post(base, `/banking/${acctB.id}/entries/${inJuly}/opening`, { month: '2026-07' }, cookie);
  assert.match(no.flash, /Only entries dated before the first statement/);
  const yes = await post(base, `/banking/${acctB.id}/entries/${old}/opening`, { month: '2026-07' }, cookie);
  assert.match(yes.flash, /part of the opening bank balance/);
  assert.equal(count('SELECT COUNT(*) FROM bank_txn_links WHERE bank_account_id=? AND entry_id=? AND bank_txn_id IS NULL', acctB.id, old), 1);
  const s = reconSummary(ctx, rec.id);
  assert.equal(s.tieDifference, 0);
  assert.deepEqual(s.inTransit.map((i) => i.amount), [7000], 'the July deposit is in transit, not explained away');
  completeRecon(ctx, rec.id);
  assert.equal(q1<any>('SELECT status FROM bank_recons WHERE id=?', rec.id).status, 'completed');
});

test('item 30: the demo feed still reconciles to zero, and the same tie rule applies to it', () => {
  const ctx = sysCtx(demo.org);
  const acct = q1<any>(`SELECT * FROM bank_accounts WHERE org_id=? AND property_id=?`, demo.org, demo.propA);
  const rec = createRecon(ctx, acct.id, '2026-07');
  autoMatch(ctx, rec);
  // the simulator's bank-only lines (interest, noise) are recorded on the books, as in real life
  const bankOnly = q<any>(`SELECT id FROM bank_txns WHERE bank_account_id=? AND substr(date,1,7)='2026-07' AND status='unmatched'`, acct.id);
  assert.ok(bankOnly.length >= 1, 'the simulated feed carries bank-only lines');
  assert.throws(() => completeRecon(ctx, rec), /still unmatched/);
  for (const t of bankOnly) postAdjustment(ctx, t.id, rec);
  assert.equal(reconSummary(ctx, rec).tieDifference, 0);
  completeRecon(ctx, rec);
  assert.equal(q1<any>('SELECT status FROM bank_recons WHERE id=?', rec).status, 'completed');
});

// ---------------------------------------------------------------- item 23
test('item 23: an invoice split across two properties relieves each property’s payable and posts due-to/due-from', () => {
  const ctx = ctxOf(live.adminId);
  const { propA: A, propB: B } = live;
  const bal = (code: string, p: string, basis: 'accrual' | 'cash' = 'accrual'): number => accountBalance(ctx, code, { propertyId: p, basis });
  const before = { a2010: bal('2010', A), b2010: bal('2010', B), a1010: bal('1010', A), b1010: bal('1010', B), a1300: bal('1300', A), b2300: bal('2300', B), a5030c: bal('5030', A, 'cash'), b5030c: bal('5030', B, 'cash') };
  const inv = createInvoice(ctx, {
    vendorId: live.vendor, propertyId: A, invoiceNumber: `SPLIT-${sfx}`, invoiceDate: '2026-08-01',
    lines: [
      { glAccount: '5030', description: 'Landscaping — Alder', amountCents: 60000 },
      { glAccount: '5030', description: 'Landscaping — Birch', amountCents: 40000, propertyId: B },
    ],
  });
  approveInvoice(ctx, inv);
  assert.equal(bal('2010', A) - before.a2010, -60000);
  assert.equal(bal('2010', B) - before.b2010, -40000);
  createPaymentRun(ctx, { runDate: '2026-08-04', method: 'check', invoiceIds: [inv], references: { [inv]: '1050' } });
  assert.equal(bal('2010', A), before.a2010, 'payer payable back to where it was — not negative');
  assert.equal(bal('2010', B), before.b2010, 'the other property’s payable is relieved too');
  assert.equal(bal('1010', A) - before.a1010, -100000, 'the payer wrote the whole check');
  assert.equal(bal('1010', B), before.b1010, 'the other property paid no cash');
  assert.equal(bal('1300', A) - before.a1300, 40000, 'due from the other property');
  assert.equal(bal('2300', B) - before.b2300, -40000, 'due to the payer');
  // cash basis: each property bears its own expense
  assert.equal(bal('5030', A, 'cash') - before.a5030c, 60000);
  assert.equal(bal('5030', B, 'cash') - before.b5030c, 40000);
  assert.equal(bal('1300', A, 'cash') - before.a1300, 40000);
  for (const i of runInvariants(ctx).filter((x) => /balances|equation/.test(x.name))) assert.equal(i.ok, true, `${i.name}: ${i.detail}`);
  // a line coded to another company's property is refused
  assert.throws(() => createInvoice(ctx, { vendorId: live.vendor, propertyId: A, invoiceNumber: 'X', invoiceDate: '2026-08-01', lines: [{ glAccount: '5030', description: 'x', amountCents: 100, propertyId: solo.propA }] }), /property not found/);
});

// ---------------------------------------------------------------- item 24
test('item 24: recording a payment in a live org invents no check number and says no money moves', async () => {
  const ctx = ctxOf(live.adminId);
  const mk = (num: string): string => {
    const inv = createInvoice(ctx, { vendorId: live.vendor, propertyId: live.propA, invoiceNumber: num, invoiceDate: '2026-08-01', lines: [{ glAccount: '5010', description: 'Repair', amountCents: 11100 }] });
    approveInvoice(ctx, inv);
    return inv;
  };
  const a = mk(`P-1-${sfx}`); const b = mk(`P-2-${sfx}`);
  const page = await get(base, '/ap/runs', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /does not print checks or move money/);
  assert.match(page.text, /Record payments/);
  assert.doesNotMatch(page.text, /positive.pay/i);
  assert.doesNotMatch(page.text, /=&gt;|\(\) =>/, 'no arrow-function source in the table');
  const r = await postMulti('/ap/runs/new', [['invoice_ids', a], ['invoice_ids', b], ['method', 'ach'], ['run_date', '2026-08-04'], [`ref_${a}`, 'ACH-778812']], cookie);
  assert.match(r.flash, /2 payments recorded\. No money was sent/);
  assert.equal(q1<any>('SELECT check_number FROM ap_payments WHERE invoice_id=?', a).check_number, 'ACH-778812', 'the operator’s own reference');
  assert.equal(q1<any>('SELECT check_number FROM ap_payments WHERE invoice_id=?', b).check_number, '', 'no reference given, none invented');
  assert.equal(q1<any>('SELECT r.run_date FROM ap_payments p JOIN ap_payment_runs r ON r.id=p.run_id WHERE p.invoice_id=?', a).run_date, '2026-08-04');
  const future = await postMulti('/ap/runs/new', [['invoice_ids', mk(`P-3-${sfx}`)], ['run_date', '2031-01-01']], cookie);
  assert.match(future.flash, /cannot be in the future/);
  // demo keeps its simulated numbering
  const dctx = sysCtx(demo.org);
  const dinv = createInvoice(dctx, { vendorId: demo.vendor, propertyId: demo.propA, invoiceNumber: 'D-1', invoiceDate: '2026-08-01', lines: [{ glAccount: '5010', description: 'Repair', amountCents: 5000 }] });
  approveInvoice(dctx, dinv);
  createPaymentRun(dctx, { runDate: BD, method: 'check', invoiceIds: [dinv] });
  assert.match(q1<any>('SELECT check_number FROM ap_payments WHERE invoice_id=?', dinv).check_number, /^\d+$/);
});

// ---------------------------------------------------------------- item 27
test('item 27: a manual entry at or above the threshold waits for a second person', async () => {
  const admin = ctxOf(live.adminId);
  const second = ctxOf(live.secondId);
  const je = (cents: number, memo: string) => ({ propertyId: live.propA, date: '2026-08-03', memo, basis: 'both' as const, lines: [{ account: '5810', debit: cents }, { account: '2200', credit: cents }] });
  assert.equal(submitManualJe(admin, je(499999, 'just under')).status, 'posted');
  const at = submitManualJe(admin, je(500000, 'exactly at the threshold'));
  assert.equal(at.status, 'pending', '"at or above" includes the threshold itself, and holding approval rights does not skip it');
  assert.equal(count(`SELECT COUNT(*) FROM journal_entries WHERE org_id=? AND memo='exactly at the threshold'`, live.org), 0, 'nothing posted yet');
  // the person who entered it cannot approve it while someone else can
  assert.throws(() => decidePendingJe(admin, at.id, true), /second person/);
  const viaHttp = await post(base, `/gl/pending/${at.id}/decide`, { approve: '1' }, cookie);
  assert.match(viaHttp.flash, /second person/);
  assert.equal(q1<any>('SELECT status FROM pending_jes WHERE id=?', at.id).status, 'pending');
  // a second person can
  assert.ok(decidePendingJe(second, at.id, true));
  const posted = q1<any>('SELECT * FROM pending_jes WHERE id=?', at.id);
  assert.deepEqual([posted.status, posted.decided_by], ['posted', second.userName]);
  assert.equal(count(`SELECT COUNT(*) FROM journal_entries WHERE org_id=? AND memo='exactly at the threshold'`, live.org), 2, 'both books');
  // the page shows the queue to the person who is waiting
  const big = submitManualJe(admin, je(900000, 'waiting on Blake'));
  const page = await get(base, '/gl/new', cookie);
  assert.match(page.text, /Awaiting approval/);
  assert.match(page.text, /waiting on Blake/);
  assert.match(page.text, /needs Blake live/);
  // ...who may withdraw it
  await post(base, `/gl/pending/${big.id}/decide`, {}, cookie);
  assert.equal(q1<any>('SELECT status FROM pending_jes WHERE id=?', big.id).status, 'rejected');

  // one-person company: there is no second person, so they confirm their own — and the record says so
  const only = ctxOf(solo.adminId);
  const mine = submitManualJe(only, { ...je(700000, 'sole approver'), propertyId: solo.propA });
  assert.equal(mine.status, 'pending');
  assert.ok(decidePendingJe(only, mine.id, true));
  assert.equal(count(`SELECT COUNT(*) FROM audit_events WHERE org_id=? AND entity='pending_je' AND entity_id=? AND action='self_approve'`, solo.org, mine.id), 1);
});

// ---------------------------------------------------------------- item 31
test('item 31: an owner distribution is recorded on the books and divided between the owners', async () => {
  const ctx = ctxOf(live.adminId);
  const mkOwner = (name: string, pct: number): string => {
    const oid = id('own');
    insert('owners', { id: oid, org_id: live.org, name, kind: 'individual', active: 1, created_at: nowIso() });
    insert('property_owners', { id: id('po'), org_id: live.org, owner_id: oid, property_id: live.propA, pct, created_at: nowIso() });
    return oid;
  };
  // no owners yet: refused, nothing posted
  const none = await post(base, '/owners/distribution', { property: live.propB, date: '2026-08-04', amount: '100.00' }, cookie);
  assert.match(none.flash, /no owners assigned/);
  const o1 = mkOwner('Casey Owner', 60); const o2 = mkOwner('Devon Owner', 40);
  const eq0 = accountBalance(ctx, '3020', { propertyId: live.propA, basis: 'accrual' });
  const eqCash0 = accountBalance(ctx, '3020', { propertyId: live.propA, basis: 'cash' });
  const cash0 = accountBalance(ctx, '1010', { propertyId: live.propA, basis: 'accrual' });
  const r = await post(base, '/owners/distribution', { property: live.propA, date: '2026-08-04', amount: '1,000.01', memo: 'July distribution' }, cookie);
  assert.match(r.flash, /Distribution of \$1,000\.01 recorded\. No money was sent/);
  const d = q1<any>('SELECT * FROM owner_distributions WHERE org_id=? AND property_id=?', live.org, live.propA);
  assert.deepEqual([d.amount_cents, d.status, d.date], [100001, 'posted', '2026-08-04']);
  const shares = q<any>('SELECT owner_id, amount_cents FROM owner_distribution_shares WHERE distribution_id=?', d.id);
  assert.equal(shares.find((s) => s.owner_id === o1)!.amount_cents + shares.find((s) => s.owner_id === o2)!.amount_cents, 100001, 'the parts add up to the whole');
  assert.equal(shares.find((s) => s.owner_id === o2)!.amount_cents, 40000);
  assert.equal(accountBalance(ctx, '3020', { propertyId: live.propA, basis: 'accrual' }) - eq0, 100001, 'taken out of owner equity');
  assert.equal(accountBalance(ctx, '3020', { propertyId: live.propA, basis: 'cash' }) - eqCash0, 100001, 'on the cash books too');
  assert.equal(accountBalance(ctx, '1010', { propertyId: live.propA, basis: 'accrual' }), cash0 - 100001);
  // it waits in bank reconciliation like any other payment
  const acct = q1<any>(`SELECT * FROM bank_accounts WHERE org_id=? AND property_id=?`, live.org, live.propA);
  assert.ok(unclearedBookItems(live.org, acct, '2026-08-31').some((i) => i.sourceKind === 'owner_distribution' && i.net === -100001));
  const stmt = await get(base, `/owners/${o1}`, cookie);
  assert.match(stmt.text, /Distributions received/);
  assert.match(stmt.text, /\$600\.01/);
  // bad input is refused
  const bad = await post(base, '/owners/distribution', { property: live.propA, date: '2031-01-01', amount: '5' }, cookie);
  assert.match(bad.flash, /cannot be in the future/);
  const cross = await post(base, '/owners/distribution', { property: solo.propA, date: '2026-08-04', amount: '5' }, cookie);
  assert.match(cross.flash, /in your portfolio/);
  assert.equal(count('SELECT COUNT(*) FROM owner_distributions WHERE org_id=?', live.org), 1);
  // void reverses it
  await post(base, `/owners/distribution/${d.id}/void`, {}, cookie);
  assert.equal(q1<any>('SELECT status FROM owner_distributions WHERE id=?', d.id).status, 'void');
  assert.equal(accountBalance(ctx, '3020', { propertyId: live.propA, basis: 'accrual' }), eq0);
  assert.equal(accountBalance(ctx, '1010', { propertyId: live.propA, basis: 'cash' }), accountBalance(ctx, '1010', { propertyId: live.propA, basis: 'accrual' }));
});

// ---------------------------------------------------------------- item 52
test('item 52: staff can enter a vendor invoice against a purchase order and the match runs', async () => {
  const mkPo = (num: string, received: number): string => {
    const po = id('po');
    insert('purchase_orders', { id: po, org_id: live.org, property_id: live.propA, vendor_id: live.vendor, po_number: num, status: 'received', total_cents: 20000, created_at: nowIso() });
    insert('purchase_order_lines', { id: id('pol'), org_id: live.org, po_id: po, description: 'Filters', qty: 10, unit_price_cents: 2000, gl_account: '5910', received_qty: received, created_at: nowIso() });
    return po;
  };
  const po = mkPo(`PO-OK-${sfx}`, 10);
  const form = await get(base, '/ap/new', cookie);
  assert.match(form.text, /Against purchase order/);
  assert.match(form.text, new RegExp(`PO-OK-${sfx}`));
  const fields = { vendor_id: live.vendor, property_id: live.propA, invoice_date: '2026-08-03', gl_0: '5910', desc_0: 'Filters', amt_0: '200.00' };
  await post(base, '/ap/new', { ...fields, invoice_number: `POINV-1-${sfx}`, po_id: po }, cookie);
  const inv = q1<any>('SELECT * FROM vendor_invoices WHERE org_id=? AND invoice_number=?', live.org, `POINV-1-${sfx}`);
  assert.equal(inv.po_id, po);
  assert.equal(q1<any>('SELECT status FROM invoice_matches WHERE invoice_id=?', inv.id).status, 'matched');
  assert.match((await get(base, `/ap/${inv.id}`, cookie)).text, new RegExp(`PO-OK-${sfx}`));
  // nothing received yet: held as an exception instead of going on to approval
  const po2 = mkPo(`PO-NR-${sfx}`, 0);
  const ex = await post(base, '/ap/new', { ...fields, invoice_number: `POINV-2-${sfx}`, po_id: po2, and_submit: '1' }, cookie);
  assert.match(ex.flash, /does not match purchase order/);
  const inv2 = q1<any>('SELECT * FROM vendor_invoices WHERE org_id=? AND invoice_number=?', live.org, `POINV-2-${sfx}`);
  assert.equal(inv2.status, 'draft');
  assert.equal(q1<any>('SELECT status FROM invoice_matches WHERE invoice_id=?', inv2.id).status, 'exception');
  // a PO issued to a different vendor is refused before anything is saved
  const v2 = id('ven');
  insert('vendors', { id: v2, org_id: live.org, name: 'Other vendor', category: 'general', active: 1, created_at: nowIso() });
  const wrong = await post(base, '/ap/new', { ...fields, vendor_id: v2, invoice_number: `POINV-3-${sfx}`, po_id: po }, cookie);
  assert.match(wrong.flash, /different vendor/);
  assert.equal(q1('SELECT id FROM vendor_invoices WHERE org_id=? AND invoice_number=?', live.org, `POINV-3-${sfx}`), undefined);
});

// ---------------------------------------------------------------- item 53
test('item 53: the invoice detail page shows the invoice number and amount, not function source', async () => {
  const ctx = ctxOf(live.adminId);
  const inv = createInvoice(ctx, { vendorId: live.vendor, propertyId: live.propA, invoiceNumber: `DETAIL-${sfx}`, invoiceDate: '2026-08-01', lines: [{ glAccount: '5010', description: 'Repair', amountCents: 123456 }] });
  const page = await get(base, `/ap/${inv}`, cookie);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /=&gt;|\(\) =>/);
  assert.match(page.text, new RegExp(`<dd><span class="mono">DETAIL-${sfx}</span></dd>`));
  assert.match(page.text, /<dd><b>\$1,234\.56<\/b><\/dd>/);
});

// ----------------------------------------------------------- items 5 + 70
test('items 5/70: deposits carried in by an import tie to GL 2100, so the close checklist is not blocked', () => {
  const ctx = ctxOf(solo.adminId);
  const mkLease = (cents: number, extra: Record<string, unknown>): string => {
    const unit = id('unt');
    insert('units', { id: unit, org_id: solo.org, property_id: solo.propA, unit_number: `U-${id('n').slice(-4)}`, floor: 1, sqft: 700, status: 'occupied', market_rent_cents: 100000, amenities: '[]', created_at: nowIso() });
    const lease = id('lse');
    insert('leases', { id: lease, org_id: solo.org, property_id: solo.propA, unit_id: unit, household_name: 'Imported household', status: 'active', start_date: '2026-01-01', end_date: '2026-12-31', move_in_date: '2026-01-01', rent_cents: 100000, deposit_cents: cents, term_months: 12, created_at: nowIso(), ...extra });
    return lease;
  };
  mkLease(125000, { import_batch_id: 'batch-test' });
  mkLease(80000, { deposit_on_hand: 1 });
  mkLease(99900, {}); // an ordinary lease whose deposit has not been billed: not held, not counted
  postBothBases(ctx, { propertyId: solo.propA, date: '2026-07-01', memo: 'Migrated security deposits held (conversion)', sourceKind: 'conversion', sourceId: 'batch-test', lines: [{ account: '1020', debit: 205000 }, { account: '2100', credit: 205000 }] });
  const inv = runInvariants(ctx);
  const dep = inv.find((i) => i.name === 'Deposit liability equals deposits held')!;
  assert.equal(dep.ok, true, dep.detail);
  assert.match(dep.detail, /GL 2100 205000 vs subledger 205000/);
  assert.equal(closeChecklist(ctx, solo.propA, '2026-07').find((i) => i.key === 'subledger')!.ok, true, JSON.stringify(inv.filter((i) => !i.ok)));
});

// ---------------------------------------------------------------- item 6
test('item 6: the product’s own balances template is recognised as a balances list', () => {
  const rows = [['Unit', 'Tenant', 'Balance'], ['101', 'Jordan Lee', '1250.00'], ['102', 'Sam Roe', '-50.00']];
  const own = classifyBySignature('stayleased-balances-template.csv', rows);
  assert.equal(own?.kind, 'balances');
  assert.equal(own?.supported, true);
  // and without the filename, on the columns alone
  assert.equal(classifyBySignature('export (3).csv', rows)?.kind, 'balances');
  assert.equal(classifyBySignature('list.csv', [['Unit', 'Resident', 'Amount Due'], ['1', 'A B', '10']])?.kind, 'balances');
  // neighbours are not disturbed
  assert.equal(classifyBySignature('data.csv', [['Unit', 'Tenant', 'Rent', 'Lease From', 'Lease To', 'Deposit', 'Balance'], ['1', 'A', '1', '2', '3', '4', '5']])?.kind, 'rent_roll');
  assert.equal(classifyBySignature('data.csv', [['Unit', 'Tenant', 'Email', 'Phone'], ['1', 'A', 'a@b.c', '555']])?.kind, 'residents');
  assert.equal(classifyBySignature('data.csv', [['Vendor', 'Category', 'Phone', 'Email'], ['Acme', 'plumbing', '555', 'a@b.c']])?.kind, 'vendors');
  assert.equal(classifyBySignature('stayleased-residents-template.csv', [['Unit', 'First name', 'Last name', 'Email', 'Phone']])?.kind, 'residents');
  assert.equal(classifyBySignature('stayleased-vendors-template.csv', [['Name', 'Category', 'Phone', 'Email']])?.kind, 'vendors');
});
