import { q, q1, insert, run, val } from '../db.ts';
import { id } from '../ids.ts';
import { nowIso, addDays, lastOfMonth, monthKey, parts, mkDate, cmp, fmtMonth } from '../dates.ts';
import { Rng, GLOBAL_SEED } from '../rng.ts';
import { getDials } from './dials.ts';

/** BankFeed simulator (§5): deterministic bank transactions for reconciliation.
 *
 * The feed for a property's operating account is derived from the books plus
 * bank-only reality, so every month CAN reconcile to zero:
 *  - SETL-{batch}   one gross deposit per settlement batch (same day)
 *  - CHK-{payment}  AP checks/ACH clearing 1-4 banking days after issue
 *  - JE-{entry}     mirror of any other accrual JE touching 1010 (app fees,
 *                   opening balance, distributions, manual/intercompany cash)
 *  - FEE-{month}    processor fees billed monthly in arrears (Σ batch fees)
 *  - INT-{month}    interest credit (bankNoise dial)
 *  - NZ-{month}     one noise item/month (bankNoise dial) — needs an
 *                   adjustment JE during reconciliation, like real life
 * Idempotent via UNIQUE(bank_account_id, ref); deterministic via seeded RNG.
 */

function strSeed(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return (h ^ GLOBAL_SEED) >>> 0;
}

const NOISE_DESCS: [string, 1 | -1][] = [
  ['CARD NETWORK ADJUSTMENT', -1],
  ['VENDOR REBATE CREDIT', 1],
  ['RETURNED ITEM — NON-CUSTOMER', -1],
  ['MERCHANT CHARGEBACK RECOVERY', 1],
];

function put(orgId: string, accountId: string, t: {
  date: string; amount: number; desc: string; ref: string; kind: string;
}): boolean {
  if (q1('SELECT id FROM bank_txns WHERE bank_account_id=? AND ref=?', accountId, t.ref)) return false;
  insert('bank_txns', {
    id: id('btx'), org_id: orgId, bank_account_id: accountId, date: t.date,
    amount_cents: Math.round(t.amount), description: t.desc, ref: t.ref, kind: t.kind,
    status: 'unmatched', imported_at: nowIso(),
  });
  return true;
}

/** import everything knowable through `through` (the org business date). */
export function importFeed(orgId: string, bankAccountId: string, through: string): number {
  const acct = q1<any>('SELECT * FROM bank_accounts WHERE id=? AND org_id=?', bankAccountId, orgId);
  if (!acct) throw new Error('bank account not found');
  const propId = acct.property_id;
  let added = 0;

  // incremental floor: everything older than the feed's high-water mark is
  // already imported (idempotent by ref) — a 35-day lookback covers month-end
  // fee postings and slightly backdated entries without rescanning history
  const highWater = val<string>('SELECT MAX(date) FROM bank_txns WHERE bank_account_id=?', bankAccountId);
  const since = highWater ? addDays(highWater, -35) : '0000-01-01';

  // 1. settlement batch deposits — the processor splits security-deposit
  //    portions straight to the escrow account, so the operating deposit is
  //    gross minus escrow split (processor fees are billed monthly in arrears)
  const batches = q<any>(
    `SELECT b.*, COALESCE((
        SELECT SUM(pa.amount_cents) FROM payments p
        JOIN payment_applications pa ON pa.payment_id=p.id
        JOIN charges c ON c.id=pa.charge_id AND c.kind='deposit'
        WHERE p.settlement_batch_id=b.id
      ),0) AS escrow_cents
     FROM settlement_batches b WHERE b.org_id=? AND b.property_id=? AND b.batch_date>=? AND b.batch_date<=? AND b.status != 'pending'`,
    orgId, propId, since, through,
  );
  for (const b of batches) {
    const operating = b.total_cents - b.escrow_cents;
    if (operating === 0) continue;
    if (put(orgId, bankAccountId, {
      date: b.batch_date, amount: operating, ref: `SETL-${b.id}`,
      desc: `PROCESSOR DEPOSIT ${String(b.method_group).toUpperCase()}${b.escrow_cents ? ' (NET OF ESCROW SPLIT)' : ''}`, kind: 'deposit',
    })) added++;
  }

  // 2. AP payments clear with a lag (checks 2-4 banking days, ACH next day)
  const pays = q<any>(
    `SELECT ap.* FROM ap_payments ap JOIN ap_payment_runs r ON r.id=ap.run_id
     WHERE ap.org_id=? AND ap.property_id=? AND (ap.status='issued' OR (ap.status='cleared' AND r.run_date>=?))`,
    orgId, propId, since,
  );
  for (const p of pays) {
    const lag = p.method === 'ach' ? 1 : 2 + (strSeed(p.id) % 3);
    const clearDate = addDays(q1<any>('SELECT run_date FROM ap_payment_runs WHERE id=?', p.run_id).run_date, lag);
    if (cmp(clearDate, through) > 0) continue;
    if (put(orgId, bankAccountId, {
      date: clearDate, amount: -p.amount_cents, ref: `CHK-${p.id}`,
      desc: p.method === 'ach' ? `ACH OUT ${p.check_number}` : `CHECK ${p.check_number} PAID`, kind: p.method === 'ach' ? 'ach' : 'check',
    })) {
      added++;
    }
  }
  // positive-pay register: issued payments whose clearing txn now exists → cleared
  for (const r of q<any>(
    `SELECT ap.id, bt.date FROM ap_payments ap JOIN bank_txns bt ON bt.ref='CHK-'||ap.id AND bt.bank_account_id=?
     WHERE ap.org_id=? AND ap.status='issued'`,
    bankAccountId, orgId,
  )) {
    run(`UPDATE ap_payments SET status='cleared', cleared_date=? WHERE id=?`, r.date, r.id);
  }

  // 3. mirror other cash-touching accrual JEs (application fees, opening
  //    balances, owner distributions, manual + intercompany entries)
  const jes = q<any>(
    `SELECT je.id, je.date, je.memo,
            SUM(CASE WHEN jl.account_code='1010' THEN jl.debit_cents - jl.credit_cents ELSE 0 END) AS net
     FROM journal_entries je JOIN journal_lines jl ON jl.entry_id=je.id
     WHERE je.org_id=? AND je.property_id=? AND je.basis='accrual' AND je.date>=? AND je.date<=?
       AND je.source_kind NOT IN ('settlement','ap_payment','ap_void','bank_adjustment')
     GROUP BY je.id HAVING net != 0`,
    orgId, propId, since, through,
  );
  for (const e of jes) {
    if (put(orgId, bankAccountId, {
      date: e.date, amount: e.net, ref: `JE-${e.id}`,
      desc: String(e.memo || 'BOOK TRANSFER').toUpperCase().slice(0, 60), kind: e.net >= 0 ? 'deposit' : 'ach',
    })) added++;
  }

  // 4. monthly bank-only items for every fully-elapsed month with activity
  const dials = getDials(orgId);
  const firstTxn = val<string>('SELECT MIN(date) FROM bank_txns WHERE bank_account_id=?', bankAccountId);
  if (firstTxn) {
    let m = monthKey(firstTxn);
    const lastFull = monthKey(through) > monthKey(firstTxn) ? monthKey(addDays(mkDate(parts(through).y, parts(through).m, 1), -1)) : '';
    while (m <= lastFull && lastFull) {
      const eom = lastOfMonth(`${m}-15`);
      const fees = val<number>(
        `SELECT COALESCE(SUM(fee_cents),0) FROM settlement_batches WHERE org_id=? AND property_id=? AND substr(batch_date,1,7)=?`,
        orgId, propId, m,
      ) || 0;
      if (fees > 0 && put(orgId, bankAccountId, {
        date: eom, amount: -fees, ref: `FEE-${m}`, desc: `PROCESSOR FEES ${fmtMonth(m).toUpperCase()}`, kind: 'fee',
      })) added++;
      if (dials.bankNoise) {
        const rng = new Rng(strSeed(`${bankAccountId}:${m}`));
        const interest = rng.int(300, 1900);
        if (put(orgId, bankAccountId, { date: eom, amount: interest, ref: `INT-${m}`, desc: 'INTEREST CREDIT', kind: 'interest' })) added++;
        if (rng.chance(0.6)) {
          const [desc, sign] = rng.pick(NOISE_DESCS);
          if (put(orgId, bankAccountId, {
            date: mkDate(Number(m.slice(0, 4)), Number(m.slice(5, 7)), rng.int(4, 24)),
            amount: sign * rng.int(900, 9900), ref: `NZ-${m}`, desc, kind: 'adjustment',
          })) added++;
        }
      }
      // next month
      const [y, mm] = [Number(m.slice(0, 4)), Number(m.slice(5, 7))];
      m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
    }
  }
  return added;
}

/** bank balance per the feed as of end of `date` (inclusive) */
export function feedBalance(bankAccountId: string, date: string): number {
  return val<number>(
    'SELECT COALESCE(SUM(amount_cents),0) FROM bank_txns WHERE bank_account_id=? AND date<=?',
    bankAccountId, date,
  ) || 0;
}
