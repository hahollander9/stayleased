import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q1, insert } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { sysCtx } from '../src/lib/auth.ts';
import { setSetting } from '../src/lib/settings.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { accountBalance } from '../src/modules/m9_accounting/service.ts';
import { DEPOSIT_RULES, depositRule, depositDeadline, postDepositInterest } from '../src/modules/m8_receivables/depositlaw.ts';
import { parseBankCsv, parseOfx } from '../src/modules/m9_accounting/finops.ts';
import { createCharge } from '../src/modules/m8_receivables/service.ts';
import { recordPayment, depositHeld } from '../src/modules/m8_receivables/payments.ts';

/** Deposit-return law presets, deadline math, interest posting to the GL,
 * and the bank statement file parsers (CSV header/positional/debit-credit
 * and OFX). */

let orgId: string;
let propId: string;
let leaseId: string;
const BD = '2026-07-26';

before(() => {
  db();
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'DepLaw Test Org', slug: 'dep-' + orgId.slice(-6), business_date: BD, created_at: nowIso() });
  ensureCoa(orgId);
  propId = id('prp');
  insert('properties', {
    id: propId, org_id: orgId, name: 'Capitol Rows', slug: 'capitol-rows-' + orgId.slice(-4), type: 'multifamily',
    address1: '1 DC St NE', city: 'Washington', state: 'DC', zip: '20002', timezone: 'America/New_York', created_at: nowIso(),
  });
  const unitId = id('unt');
  insert('units', { id: unitId, org_id: orgId, property_id: propId, unit_number: '101', sqft: 650, market_rent_cents: 150000, status: 'occupied', created_at: nowIso() });
  leaseId = id('lse');
  insert('leases', {
    id: leaseId, org_id: orgId, property_id: propId, unit_id: unitId, household_name: 'Deposit Household',
    status: 'active', rent_cents: 150000, deposit_cents: 150000, deposit_alternative: 0, term_months: 12,
    start_date: '2025-07-01', end_date: '2026-06-30', move_in_date: '2025-07-26', created_at: nowIso(),
  });
});

test('every US jurisdiction has a preset and unknown states fall back to 30 days', () => {
  assert.equal(Object.keys(DEPOSIT_RULES).length, 51, '50 states + DC');
  for (const [st, r] of Object.entries(DEPOSIT_RULES)) {
    assert.ok(r.days >= 14 && r.days <= 60, `${st} days in a sane range`);
  }
  assert.equal(depositRule('DC').days, 45);
  assert.equal(depositRule('DC').interest, true);
  assert.equal(depositRule('CA').days, 21);
  assert.equal(depositRule('NY').days, 14);
  assert.equal(depositRule('xx').days, 30, 'fallback');
  assert.equal(depositRule(null).days, 30);
});

test('deadline math: DC move-out gets a 45-day clock with countdown', () => {
  const ctx = sysCtx(orgId);
  const dl = depositDeadline(ctx, propId, 'DC', '2026-07-01');
  assert.equal(dl.days, 45);
  assert.equal(dl.due, '2026-08-15');
  assert.equal(dl.daysLeft, 20, `from ${BD} to 08-15`);
  const none = depositDeadline(ctx, propId, 'DC', null);
  assert.equal(none.due, null);
});

test('interest posts DR 5720 / CR 2100 and raises the held balance', () => {
  const ctx = sysCtx(orgId);
  // hold a deposit: charge + credit-funded... simplest: post the deposit charge and pay it
  createCharge(ctx, { leaseId, kind: 'deposit', label: 'Security deposit', amountCents: 150000, date: '2025-07-26', source: 'move_in' });
  recordPayment(ctx, { leaseId, amountCents: 150000, method: 'check', receivedDate: '2025-07-26', memo: 'deposit check' });
  const held0 = depositHeld(ctx, leaseId);
  assert.equal(held0, 150000, 'deposit held after payment');
  // no rate set → refuses
  assert.throws(() => postDepositInterest(ctx, leaseId), /deposit_interest_pct/);
  setSetting(ctx, 'deposit_interest_pct', 1.5);
  const cents = postDepositInterest(ctx, leaseId);
  // 365 days at 1.5% on $1,500 = $22.50
  assert.equal(cents, 2250, 'one year of simple interest');
  assert.equal(depositHeld(ctx, leaseId), 152250, 'held balance includes interest');
  const bal2100 = accountBalance(ctx, '2100', { propertyId: propId, basis: 'accrual' });
  assert.equal(-bal2100, 152250, 'liability 2100 carries the interest');
  const exp = accountBalance(ctx, '5720', { propertyId: propId, basis: 'accrual' });
  assert.equal(exp, 2250, '5720 expense recognized');
  // idempotent day: accruing again the same day refuses
  assert.throws(() => postDepositInterest(ctx, leaseId), /already accrued/);
});

test('bank CSV parser: headers, debit/credit pairs, and parens negatives', () => {
  const rows = parseBankCsv([
    'Date,Description,Amount',
    '2026-07-01,ACH DEPOSIT RENT BATCH,"12,340.55"',
    '07/03/2026,CHECK 1041,(2500.00)',
    '2026-07-05,SERVICE FEE,-35.00',
  ].join('\n'));
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0]!.date, rows[0]!.amount], ['2026-07-01', 1234055]);
  assert.deepEqual([rows[1]!.date, rows[1]!.amount], ['2026-07-03', -250000]);
  assert.equal(rows[2]!.amount, -3500);
  const dc = parseBankCsv([
    'Post Date,Details,Debit,Credit',
    '2026-07-02,TRANSFER IN,,500.00',
    '2026-07-04,UTILITY PAYMENT,120.25,',
  ].join('\n'));
  assert.equal(dc.length, 2);
  assert.equal(dc[0]!.amount, 50000);
  assert.equal(dc[1]!.amount, -12025);
  // refs are stable → re-import of the same file is idempotent upstream
  assert.equal(parseBankCsv('Date,Description,Amount\n2026-07-01,X,1.00')[0]!.ref,
    parseBankCsv('Date,Description,Amount\n2026-07-01,X,1.00')[0]!.ref);
});

test('OFX parser reads SGML STMTTRN blocks with FITIDs', () => {
  const rows = parseOfx(`OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260701120000
<TRNAMT>1500.00
<FITID>ABC123
<NAME>RENT ACH BATCH
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260702
<TRNAMT>-42.10
<FITID>ABC124
<MEMO>MONTHLY SERVICE FEE
</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0]!.date, rows[0]!.amount, rows[0]!.ref], ['2026-07-01', 150000, 'ofx:ABC123']);
  assert.deepEqual([rows[1]!.date, rows[1]!.amount], ['2026-07-02', -4210]);
  assert.match(rows[1]!.desc, /SERVICE FEE/);
});
