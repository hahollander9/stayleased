import { q, q1, insert, run, val, tx } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, addDays, lastOfMonth, firstOfMonth, cmp } from '../../lib/dates.ts';
import type { Ctx } from '../../lib/auth.ts';
import { emit } from '../../lib/events.ts';
import { audit } from '../../lib/audit.ts';
import { registerJob } from '../../lib/jobs.ts';
import { importFeed, feedBalance } from '../../lib/sim/bankfeed.ts';
import { postJE, accountBalance } from './service.ts';

/** M9.5 — bank reconciliation against the BankFeed simulator. */

export function ensureBankAccounts(orgId: string): void {
  const props = q<any>('SELECT id, name FROM properties WHERE org_id=? ORDER BY created_at', orgId);
  props.forEach((p, i) => {
    if (!q1(`SELECT id FROM bank_accounts WHERE org_id=? AND property_id=? AND kind='operating'`, orgId, p.id)) {
      insert('bank_accounts', {
        id: id('bnk'), org_id: orgId, property_id: p.id, name: `${p.name} — Operating`,
        kind: 'operating', gl_account: '1010', last4: String(4410 + i * 37).slice(-4), active: 1, created_at: nowIso(),
      });
    }
  });
}

export function importAllFeeds(orgId: string, through: string): number {
  let n = 0;
  for (const a of q<any>('SELECT id FROM bank_accounts WHERE org_id=? AND active=1', orgId)) {
    n += importFeed(orgId, a.id, through);
  }
  return n;
}

// ---------- reconciliation lifecycle ----------

export function createRecon(ctx: Ctx, bankAccountId: string, periodKey: string): string {
  const acct = q1<any>('SELECT * FROM bank_accounts WHERE id=? AND org_id=?', bankAccountId, ctx.orgId);
  if (!acct) throw new Error('bank account not found');
  const existing = q1<any>('SELECT id FROM bank_recons WHERE bank_account_id=? AND period_key=?', bankAccountId, periodKey);
  if (existing) return existing.id as string;
  const start = `${periodKey}-01`;
  const end = lastOfMonth(start);
  const rid = id('rec');
  insert('bank_recons', {
    id: rid, org_id: ctx.orgId, bank_account_id: bankAccountId, period_key: periodKey,
    statement_open_cents: feedBalance(bankAccountId, addDays(start, -1)),
    statement_close_cents: feedBalance(bankAccountId, end),
    status: 'in_progress', difference_cents: unmatchedTotal(ctx.orgId, bankAccountId, periodKey),
    created_at: nowIso(),
  });
  audit(ctx, 'bank_recon', rid, 'start', null, { periodKey });
  return rid;
}

export function unmatchedTotal(orgId: string, bankAccountId: string, periodKey: string): number {
  return val<number>(
    `SELECT COALESCE(SUM(amount_cents),0) FROM bank_txns
     WHERE org_id=? AND bank_account_id=? AND substr(date,1,7)=? AND status='unmatched'`,
    orgId, bankAccountId, periodKey,
  ) || 0;
}

function refreshDifference(orgId: string, reconId: string): void {
  const r = q1<any>('SELECT * FROM bank_recons WHERE id=?', reconId);
  run('UPDATE bank_recons SET difference_cents=? WHERE id=?', unmatchedTotal(orgId, r.bank_account_id, r.period_key), reconId);
}

function matchTxn(orgId: string, txn: any, kind: string, matchedId: string, reconId: string | null): void {
  run(`UPDATE bank_txns SET status='matched', matched_kind=?, matched_id=?, recon_id=? WHERE id=?`, kind, matchedId, reconId, txn.id);
  if (kind === 'settlement') {
    run(`UPDATE settlement_batches SET status='reconciled', bank_txn_id=? WHERE id=?`, txn.id, matchedId);
  }
}

/** auto-match by stable ref, then by amount+date tolerance (±3 days). */
export function autoMatch(ctx: Ctx, reconId: string): { matched: number; remaining: number } {
  const rec = q1<any>('SELECT * FROM bank_recons WHERE id=? AND org_id=?', reconId, ctx.orgId);
  if (!rec) throw new Error('reconciliation not found');
  const txns = q<any>(
    `SELECT * FROM bank_txns WHERE bank_account_id=? AND substr(date,1,7)=? AND status='unmatched'`,
    rec.bank_account_id, rec.period_key,
  );
  let matched = 0;
  tx(() => {
    for (const t of txns) {
      const ref = String(t.ref || '');
      if (ref.startsWith('SETL-')) {
        const b = q1<any>(
          `SELECT b.*, COALESCE((
              SELECT SUM(pa.amount_cents) FROM payments p
              JOIN payment_applications pa ON pa.payment_id=p.id
              JOIN charges c ON c.id=pa.charge_id AND c.kind='deposit'
              WHERE p.settlement_batch_id=b.id
            ),0) AS escrow_cents
           FROM settlement_batches b WHERE b.id=? AND b.org_id=?`,
          ref.slice(5), ctx.orgId,
        );
        if (b && b.total_cents - b.escrow_cents === t.amount_cents) { matchTxn(ctx.orgId, t, 'settlement', b.id, reconId); matched++; continue; }
      }
      if (ref.startsWith('CHK-')) {
        const p = q1<any>('SELECT * FROM ap_payments WHERE id=? AND org_id=?', ref.slice(4), ctx.orgId);
        if (p && p.amount_cents === -t.amount_cents && p.status !== 'void') { matchTxn(ctx.orgId, t, 'ap_payment', p.id, reconId); matched++; continue; }
      }
      if (ref.startsWith('JE-')) {
        const e = q1<any>('SELECT id FROM journal_entries WHERE id=? AND org_id=?', ref.slice(3), ctx.orgId);
        if (e) { matchTxn(ctx.orgId, t, 'je', e.id, reconId); matched++; continue; }
      }
      // tolerance: settlement batch with same amount within 3 days
      if (t.amount_cents > 0) {
        const b = q1<any>(
          `SELECT * FROM settlement_batches WHERE org_id=? AND total_cents=? AND status='deposited'
             AND batch_date BETWEEN ? AND ? AND bank_txn_id IS NULL LIMIT 1`,
          ctx.orgId, t.amount_cents, addDays(t.date, -3), addDays(t.date, 3),
        );
        if (b) { matchTxn(ctx.orgId, t, 'settlement', b.id, reconId); matched++; continue; }
      } else if (t.amount_cents < 0) {
        const p = q1<any>(
          `SELECT ap.* FROM ap_payments ap JOIN ap_payment_runs r ON r.id=ap.run_id
           WHERE ap.org_id=? AND ap.amount_cents=? AND ap.status IN ('issued','cleared')
             AND r.run_date BETWEEN ? AND ?
             AND NOT EXISTS (SELECT 1 FROM bank_txns bt WHERE bt.matched_kind='ap_payment' AND bt.matched_id=ap.id) LIMIT 1`,
          ctx.orgId, -t.amount_cents, addDays(t.date, -6), t.date,
        );
        if (p) { matchTxn(ctx.orgId, t, 'ap_payment', p.id, reconId); matched++; continue; }
      }
    }
  });
  refreshDifference(ctx.orgId, reconId);
  const remaining = val<number>(
    `SELECT COUNT(*) FROM bank_txns WHERE bank_account_id=? AND substr(date,1,7)=? AND status='unmatched'`,
    rec.bank_account_id, rec.period_key,
  ) || 0;
  audit(ctx, 'bank_recon', reconId, 'auto_match', null, { matched, remaining });
  return { matched, remaining };
}

/** bank-only item (fees/interest/noise) → adjustment JE that trues up the books. */
export function postAdjustment(ctx: Ctx, txnId: string, reconId: string | null): string {
  const t = q1<any>('SELECT * FROM bank_txns WHERE id=? AND org_id=?', txnId, ctx.orgId);
  if (!t) throw new Error('bank txn not found');
  if (t.status !== 'unmatched') throw new Error('transaction already matched');
  const acct = q1<any>('SELECT * FROM bank_accounts WHERE id=?', t.bank_account_id);
  const amt = Math.abs(t.amount_cents);
  const inflow = t.amount_cents > 0;
  const counter = t.kind === 'fee' ? '5710' : inflow ? '4080' : '5810';
  let jeId = '';
  tx(() => {
    for (const basis of ['accrual', 'cash'] as const) {
      const eid = postJE(ctx, {
        propertyId: acct.property_id, date: t.date, basis,
        memo: `Bank adjustment — ${t.description}`, sourceKind: 'bank_adjustment', sourceId: t.id,
        lines: inflow
          ? [{ account: '1010', debit: amt }, { account: counter, credit: amt }]
          : [{ account: counter, debit: amt }, { account: '1010', credit: amt }],
      });
      if (basis === 'accrual') jeId = eid;
    }
    matchTxn(ctx.orgId, t, 'je', jeId, reconId);
  });
  if (reconId) refreshDifference(ctx.orgId, reconId);
  audit(ctx, 'bank_txn', t.id, 'adjustment_je', null, { jeId, amountCents: t.amount_cents });
  return jeId;
}

/** manual match from the workbench UI */
export function manualMatch(ctx: Ctx, txnId: string, kind: 'settlement' | 'ap_payment' | 'je', matchedId: string, reconId: string | null): void {
  const t = q1<any>('SELECT * FROM bank_txns WHERE id=? AND org_id=?', txnId, ctx.orgId);
  if (!t || t.status !== 'unmatched') throw new Error('transaction not matchable');
  matchTxn(ctx.orgId, t, kind, matchedId, reconId);
  if (reconId) refreshDifference(ctx.orgId, reconId);
  audit(ctx, 'bank_txn', t.id, 'manual_match', null, { kind, matchedId });
}

export function excludeTxn(ctx: Ctx, txnId: string, reconId: string | null, reason: string): void {
  const t = q1<any>('SELECT * FROM bank_txns WHERE id=? AND org_id=?', txnId, ctx.orgId);
  if (!t || t.status !== 'unmatched') throw new Error('transaction not excludable');
  run(`UPDATE bank_txns SET status='excluded', recon_id=? WHERE id=?`, reconId, txnId);
  if (reconId) refreshDifference(ctx.orgId, reconId);
  audit(ctx, 'bank_txn', txnId, 'exclude', null, { reason });
}

export function completeRecon(ctx: Ctx, reconId: string): void {
  const rec = q1<any>('SELECT * FROM bank_recons WHERE id=? AND org_id=?', reconId, ctx.orgId);
  if (!rec || rec.status === 'completed') throw new Error('reconciliation not open');
  const diff = unmatchedTotal(ctx.orgId, rec.bank_account_id, rec.period_key);
  if (diff !== 0) throw new Error('difference must be zero to complete');
  const openCount = val<number>(
    `SELECT COUNT(*) FROM bank_txns WHERE bank_account_id=? AND substr(date,1,7)=? AND status='unmatched'`,
    rec.bank_account_id, rec.period_key,
  ) || 0;
  if (openCount > 0) throw new Error('all statement transactions must be matched or excluded');
  run(
    `UPDATE bank_recons SET status='completed', difference_cents=0, statement_close_cents=?, completed_by=?, completed_at=? WHERE id=?`,
    feedBalance(rec.bank_account_id, lastOfMonth(`${rec.period_key}-01`)), ctx.userName, nowIso(), reconId,
  );
  emit(ctx, 'bank.reconciled', 'bank_recon', reconId, { periodKey: rec.period_key, bankAccountId: rec.bank_account_id });
  audit(ctx, 'bank_recon', reconId, 'complete');
}

/** book-vs-bank summary for the recon report */
export function reconSummary(ctx: Ctx, reconId: string): {
  rec: any; acct: any; bookClose: number; outstanding: { desc: string; date: string; amount: number }[];
  inTransit: { desc: string; date: string; amount: number }[]; adjusted: number; matchedCount: number;
} {
  const rec = q1<any>('SELECT * FROM bank_recons WHERE id=? AND org_id=?', reconId, ctx.orgId);
  const acct = q1<any>('SELECT * FROM bank_accounts WHERE id=?', rec.bank_account_id);
  // for an in-flight month the statement only exists through the business date
  const eom = lastOfMonth(`${rec.period_key}-01`);
  const end = cmp(eom, ctx.businessDate) > 0 ? ctx.businessDate : eom;
  const bookClose = accountBalance(ctx, '1010', { propertyId: acct.property_id, asOf: end, basis: 'accrual' });
  // outstanding checks: issued/cleared payments whose JE hit the books ≤ EOM but bank cleared after EOM
  const outstanding = q<any>(
    `SELECT ap.check_number, ap.amount_cents, r.run_date FROM ap_payments ap JOIN ap_payment_runs r ON r.id=ap.run_id
     WHERE ap.org_id=? AND ap.property_id=? AND ap.status IN ('issued','cleared') AND r.run_date<=?
       AND NOT EXISTS (SELECT 1 FROM bank_txns bt WHERE bt.ref='CHK-'||ap.id AND bt.date<=?)`,
    ctx.orgId, acct.property_id, end, end,
  ).map((o) => ({ desc: `Check ${o.check_number}`, date: o.run_date, amount: -o.amount_cents }));
  // deposits in transit: batches with an *operating* portion on the books ≤ EOM
  // but no bank deposit ≤ EOM (pure-escrow batches never hit this account)
  const inTransit = q<any>(
    `SELECT b.id, b.batch_date, b.total_cents - COALESCE((
        SELECT SUM(pa.amount_cents) FROM payments p
        JOIN payment_applications pa ON pa.payment_id=p.id
        JOIN charges c ON c.id=pa.charge_id AND c.kind='deposit'
        WHERE p.settlement_batch_id=b.id
      ),0) AS operating_cents
     FROM settlement_batches b
     WHERE b.org_id=? AND b.property_id=? AND b.batch_date<=? AND b.status != 'pending'
       AND NOT EXISTS (SELECT 1 FROM bank_txns bt WHERE bt.ref='SETL-'||b.id AND bt.date<=?)`,
    ctx.orgId, acct.property_id, end, end,
  )
    .filter((b) => b.operating_cents > 0)
    .map((b) => ({ desc: `Batch ${b.id.slice(-6)}`, date: b.batch_date, amount: b.operating_cents }));
  const adjusted = val<number>(
    `SELECT COALESCE(SUM(amount_cents),0) FROM bank_txns WHERE recon_id=? AND matched_kind='je' AND ref NOT LIKE 'JE-%'`,
    reconId,
  ) || 0;
  const matchedCount = val<number>(`SELECT COUNT(*) FROM bank_txns WHERE bank_account_id=? AND substr(date,1,7)=? AND status='matched'`, rec.bank_account_id, rec.period_key) || 0;
  return { rec, acct, bookClose, outstanding, inTransit, adjusted, matchedCount };
}

/** unreconciled-item aging (M9.5) */
export function unreconciledAging(ctx: Ctx): { account: any; buckets: Record<string, { n: number; amount: number }> }[] {
  const out: { account: any; buckets: Record<string, { n: number; amount: number }> }[] = [];
  for (const a of q<any>('SELECT * FROM bank_accounts WHERE org_id=? AND active=1', ctx.orgId)) {
    const buckets: Record<string, { n: number; amount: number }> = {
      '0-30': { n: 0, amount: 0 }, '31-60': { n: 0, amount: 0 }, '61-90': { n: 0, amount: 0 }, '90+': { n: 0, amount: 0 },
    };
    for (const t of q<any>(`SELECT date, amount_cents FROM bank_txns WHERE bank_account_id=? AND status='unmatched'`, a.id)) {
      const age = Math.max(0, Math.round((Date.parse(ctx.businessDate) - Date.parse(t.date)) / 86400000));
      const key = age <= 30 ? '0-30' : age <= 60 ? '31-60' : age <= 90 ? '61-90' : '90+';
      buckets[key]!.n++;
      buckets[key]!.amount += t.amount_cents;
    }
    out.push({ account: a, buckets });
  }
  return out;
}

registerJob({
  key: 'bank_feed',
  name: 'Bank feed import',
  describe: 'Pulls new BankFeed transactions (settlement deposits, check clearings, fees) into every active bank account.',
  run: (ctx, date) => {
    ensureBankAccounts(ctx.orgId);
    const n = importAllFeeds(ctx.orgId, date);
    return n ? `${n} bank transactions imported` : 'feed up to date';
  },
});
