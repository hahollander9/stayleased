import { q, q1, insert, run, val, tx } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, addDays, lastOfMonth, cmp, fmtMonth } from '../../lib/dates.ts';
import { canAccessProperty, type Ctx } from '../../lib/auth.ts';
import { emit } from '../../lib/events.ts';
import { audit } from '../../lib/audit.ts';
import { registerJob, orgKind } from '../../lib/jobs.ts';
import { usd } from '../../lib/money.ts';
import { importFeed } from '../../lib/sim/bankfeed.ts';
import { postJE, accountBalance } from './service.ts';

/** M9.5 — bank reconciliation.
 *
 * Statement lines reach an account three ways: a file from the bank (CSV or
 * OFX), a line typed in by hand, or — in a demo organization only — the
 * BankFeed simulator. Whatever the source, a reconciliation is finished the
 * same way: every statement line is matched to what the books already hold
 * (or recorded on the books, or set aside as not a real line), and then the
 * book balance, less what has not reached the bank yet, must equal the
 * statement's ending balance. A month cannot be completed on "nothing is
 * unmatched" alone — that is also true of an empty month. */

/** What an account created for a real company says until someone tells us. */
export const BANK_NOT_SPECIFIED = 'Bank not specified';
const SIM_BANK = 'First Simulated Bank';

export function isLive(orgId: string): boolean {
  return orgKind(orgId) === 'live';
}

/** One operating account row per property.
 *
 * In a demo organization the row carries the simulated bank's name and an
 * invented last four, which is the simulation. A real company gets neither:
 * the row exists (month-end close and the opening balance need an account to
 * hang on) but says the bank is not specified until someone enters it. */
export function ensureBankAccounts(orgId: string): void {
  const live = isLive(orgId);
  if (live) {
    // rows created before this distinction existed carried the simulator's
    // bank name and a made-up account ending; correct them in place
    run(`UPDATE bank_accounts SET bank_name=?, last4='' WHERE org_id=? AND bank_name=?`, BANK_NOT_SPECIFIED, orgId, SIM_BANK);
  }
  const props = q<any>('SELECT id, name FROM properties WHERE org_id=? ORDER BY created_at', orgId);
  props.forEach((p, i) => {
    if (!q1(`SELECT id FROM bank_accounts WHERE org_id=? AND property_id=? AND kind='operating'`, orgId, p.id)) {
      insert('bank_accounts', {
        id: id('bnk'), org_id: orgId, property_id: p.id, name: `${p.name} — Operating`,
        kind: 'operating', gl_account: '1010',
        ...(live ? { bank_name: BANK_NOT_SPECIFIED, last4: '' } : { last4: String(4410 + i * 37).slice(-4) }),
        active: 1, created_at: nowIso(),
      });
    }
  });
}

/** "First National …1234", or the honest placeholder. Never the simulator's
 * name in a real company, even for a row nothing has repaired yet. */
export function bankLabel(acct: { bank_name?: string | null; last4?: string | null }, live: boolean): string {
  const name = live && (!acct.bank_name || acct.bank_name === SIM_BANK) ? BANK_NOT_SPECIFIED : String(acct.bank_name || BANK_NOT_SPECIFIED);
  const last4 = live && acct.bank_name === SIM_BANK ? '' : String(acct.last4 || '');
  return last4 ? `${name} …${last4}` : name;
}

/** Demo only: importFeed itself refuses a live organization. */
export function importAllFeeds(orgId: string, through: string): number {
  let n = 0;
  for (const a of q<any>('SELECT id FROM bank_accounts WHERE org_id=? AND active=1', orgId)) {
    n += importFeed(orgId, a.id, through);
  }
  return n;
}

// ---------- who may see which account ----------

/** A bank account tied to a property belongs to the staff who can work on
 * that property; an account with no property is the organization's own and
 * takes whole-portfolio access. Every banking route decides through here. */
export function canUseBankAccount(ctx: Ctx, acct: { property_id?: string | null } | null | undefined): boolean {
  if (!acct) return false;
  return acct.property_id ? canAccessProperty(ctx, acct.property_id) : ctx.allProperties;
}

/** The account, or nothing when it is another organization's or outside the
 * reader's properties — callers answer "not found" either way. */
export function bankAccountFor(ctx: Ctx, bankAccountId: string): any {
  const acct = q1<any>('SELECT * FROM bank_accounts WHERE id=? AND org_id=?', bankAccountId, ctx.orgId);
  return canUseBankAccount(ctx, acct) ? acct : undefined;
}

/** SQL for lists of bank accounts: `col` is the account's property_id column. */
export function bankScopeSql(ctx: Ctx, col: string): { sql: string; params: string[] } {
  if (ctx.allProperties) return { sql: '', params: [] };
  if (!ctx.propertyIds.length) return { sql: ' AND 1=0', params: [] };
  return { sql: ` AND ${col} IN (${ctx.propertyIds.map(() => '?').join(',')})`, params: [...ctx.propertyIds] };
}

// ---------- statement lines ----------

export function guessKind(desc: string, amount: number): string {
  const d = desc.toLowerCase();
  if (/fee|service charge/.test(d)) return 'fee';
  if (/interest/.test(d)) return 'interest';
  if (/check|chk/.test(d)) return 'check';
  if (/ach|transfer|xfer|payroll|autopay/.test(d)) return 'ach';
  return amount > 0 ? 'deposit' : 'other';
}

function monthCompleted(bankAccountId: string, date: string): boolean {
  return !!q1(
    `SELECT id FROM bank_recons WHERE bank_account_id=? AND period_key=? AND status='completed'`,
    bankAccountId, date.slice(0, 7),
  );
}

function validDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

/** Lines parsed from a bank file. Re-importing the same file adds nothing
 * (stable ref per line); lines dated inside a month that is already
 * reconciled are left out rather than reopening a finished month. */
export function importStatementLines(
  ctx: Ctx, bankAccountId: string, rows: { date: string; amount: number; desc: string; ref: string }[],
): { added: number; duplicate: number; locked: number } {
  const acct = q1<any>('SELECT * FROM bank_accounts WHERE id=? AND org_id=?', bankAccountId, ctx.orgId);
  if (!acct) throw new Error('bank account not found');
  let added = 0; let duplicate = 0; let locked = 0;
  tx(() => {
    for (const t of rows) {
      if (!validDate(t.date) || !Number.isInteger(t.amount) || t.amount === 0) continue;
      if (q1('SELECT id FROM bank_txns WHERE bank_account_id=? AND ref=?', acct.id, t.ref)) { duplicate++; continue; }
      if (monthCompleted(acct.id, t.date)) { locked++; continue; }
      insert('bank_txns', {
        id: id('btx'), org_id: ctx.orgId, bank_account_id: acct.id,
        date: t.date, amount_cents: t.amount, description: t.desc, ref: t.ref,
        kind: guessKind(t.desc, t.amount), status: 'unmatched', imported_at: nowIso(),
      });
      added++;
    }
  });
  audit(ctx, 'bank_account', acct.id, 'statement_imported', null, { added, duplicate, locked });
  return { added, duplicate, locked };
}

/** One statement line typed in by hand. Positive = money in. */
export function addStatementLine(
  ctx: Ctx, bankAccountId: string, input: { date: string; description: string; amountCents: number },
): string {
  const acct = q1<any>('SELECT * FROM bank_accounts WHERE id=? AND org_id=?', bankAccountId, ctx.orgId);
  if (!acct) throw new Error('bank account not found');
  if (!validDate(input.date)) throw new Error('Enter the date shown on the statement.');
  if (!Number.isInteger(input.amountCents) || input.amountCents === 0) throw new Error('Enter the amount shown on the statement.');
  const desc = input.description.trim().slice(0, 160);
  if (!desc) throw new Error('Enter the description shown on the statement.');
  if (monthCompleted(acct.id, input.date)) throw new Error('That month is already reconciled for this account, so no lines can be added to it.');
  const tid = id('btx');
  insert('bank_txns', {
    id: tid, org_id: ctx.orgId, bank_account_id: acct.id, date: input.date,
    amount_cents: input.amountCents, description: desc, ref: `manual:${tid}`,
    kind: guessKind(desc, input.amountCents), status: 'unmatched', imported_at: nowIso(),
  });
  audit(ctx, 'bank_txn', tid, 'manual_entry', null, { date: input.date, amountCents: input.amountCents, description: desc });
  return tid;
}

// ---------- what the books hold that the bank has not shown yet ----------

export interface BookItem {
  id: string;
  date: string;
  memo: string;
  sourceKind: string;
  sourceId: string | null;
  reversalOf: string | null;
  /** effect on the bank account: positive = money in */
  net: number;
}

/** Accrual journal entries that moved this bank account's GL balance on or
 * before `through` and that no statement line dated on or before `through`
 * has cleared.
 *
 * An entry is cleared by the statement line matched to it — directly, through
 * the vendor payment or the deposit batch the line was matched to, or through
 * a link row when one line cleared several entries. Opening balances brought
 * in at conversion are the bank's own balance on that day and are never
 * outstanding. */
export function unclearedBookItems(orgId: string, acct: any, through: string): BookItem[] {
  const a = acct.id as string;
  const propSql = acct.property_id ? ' AND je.property_id=?' : '';
  const rows = q<any>(
    `WITH cleared(eid) AS (
       SELECT bt.matched_id FROM bank_txns bt
        WHERE bt.bank_account_id=? AND bt.status='matched' AND bt.date<=? AND bt.matched_kind='je'
       UNION
       SELECT ap.je_id FROM bank_txns bt JOIN ap_payments ap ON ap.id=bt.matched_id
        WHERE bt.bank_account_id=? AND bt.status='matched' AND bt.date<=? AND bt.matched_kind='ap_payment'
       UNION
       SELECT e.id FROM bank_txns bt
         JOIN payments p ON p.settlement_batch_id=bt.matched_id
         JOIN journal_entries e ON e.org_id=p.org_id AND e.source_kind='settlement' AND e.source_id=p.id AND e.basis='accrual'
        WHERE bt.bank_account_id=? AND bt.status='matched' AND bt.date<=? AND bt.matched_kind='settlement'
       UNION
       SELECT l.entry_id FROM bank_txn_links l JOIN bank_txns bt ON bt.id=l.bank_txn_id
        WHERE l.bank_account_id=? AND bt.status='matched' AND bt.date<=?
       UNION
       SELECT l.entry_id FROM bank_txn_links l
        WHERE l.bank_account_id=? AND l.bank_txn_id IS NULL AND l.cleared_date<=?
     )
     SELECT je.id, je.date, je.memo, je.source_kind, je.source_id, je.reversal_of,
            SUM(jl.debit_cents - jl.credit_cents) AS net
       FROM journal_entries je JOIN journal_lines jl ON jl.entry_id=je.id AND jl.account_code=?
      WHERE je.org_id=? AND je.basis='accrual' AND je.date<=? AND je.source_kind!='conversion'${propSql}
        AND je.id NOT IN (SELECT eid FROM cleared WHERE eid IS NOT NULL)
      GROUP BY je.id HAVING net != 0
      ORDER BY je.date, je.id`,
    a, through, a, through, a, through, a, through, a, through,
    acct.gl_account, orgId, through, ...(acct.property_id ? [acct.property_id] : []),
  );
  return rows.map((r) => ({
    id: r.id as string, date: r.date as string, memo: String(r.memo || ''), sourceKind: r.source_kind as string,
    sourceId: (r.source_id as string) || null, reversalOf: (r.reversal_of as string) || null, net: Number(r.net),
  }));
}

/** An entry and the entry that reversed it, neither of which reached the bank,
 * cancel out. They stay in the arithmetic (they net to zero) but are noise in
 * a list someone has to read. */
function withoutReversedPairs(items: BookItem[]): BookItem[] {
  const ids = new Set(items.map((i) => i.id));
  const drop = new Set<string>();
  for (const i of items) {
    if (i.reversalOf && ids.has(i.reversalOf)) { drop.add(i.id); drop.add(i.reversalOf); }
  }
  return items.filter((i) => !drop.has(i.id));
}

/** Book entries a statement line could be matched to, best guesses first. */
export function matchCandidates(ctx: Ctx, txnId: string): { txn: any; acct: any; items: BookItem[] } {
  const txn = q1<any>('SELECT * FROM bank_txns WHERE id=? AND org_id=?', txnId, ctx.orgId);
  if (!txn) throw new Error('statement line not found');
  const acct = q1<any>('SELECT * FROM bank_accounts WHERE id=?', txn.bank_account_id);
  const from = addDays(txn.date, -120);
  const to = addDays(txn.date, 15);
  const dist = (d: string): number => Math.abs(Date.parse(d) - Date.parse(txn.date));
  const items = withoutReversedPairs(unclearedBookItems(ctx.orgId, acct, '9999-12-31'))
    .filter((i) => i.net === txn.amount_cents || (cmp(i.date, from) >= 0 && cmp(i.date, to) <= 0))
    .sort((x, y) =>
      Number(y.net === txn.amount_cents) - Number(x.net === txn.amount_cents)
      || Number(Math.sign(y.net) === Math.sign(txn.amount_cents)) - Number(Math.sign(x.net) === Math.sign(txn.amount_cents))
      || dist(x.date) - dist(y.date))
    .slice(0, 80);
  return { txn, acct, items };
}

// ---------- reconciliation lifecycle ----------

function periodEnd(periodKey: string, businessDate: string): string {
  // for an in-flight month the statement only exists through the business date
  const eom = lastOfMonth(`${periodKey}-01`);
  return cmp(eom, businessDate) > 0 ? businessDate : eom;
}

/** False only for a live organization looking at a month that is still
 * running: its statement is not out yet, so it must not be completed. */
export function statementMonthOver(ctx: Ctx, periodKey: string): boolean {
  if (!isLive(ctx.orgId)) return true;
  return cmp(lastOfMonth(`${periodKey}-01`), ctx.businessDate) <= 0;
}

/** Sum of the statement lines on file through `date`, leaving out lines set
 * aside as not real. In a demo organization this IS the statement balance. */
function linesBalance(bankAccountId: string, date: string): number {
  return val<number>(
    `SELECT COALESCE(SUM(amount_cents),0) FROM bank_txns WHERE bank_account_id=? AND date<=? AND status!='excluded'`,
    bankAccountId, date,
  ) || 0;
}

export function createRecon(ctx: Ctx, bankAccountId: string, periodKey: string, opts?: { statementCloseCents?: number | null }): string {
  const acct = q1<any>('SELECT * FROM bank_accounts WHERE id=? AND org_id=?', bankAccountId, ctx.orgId);
  if (!acct) throw new Error('bank account not found');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodKey)) throw new Error('Choose a statement month.');
  const existing = q1<any>('SELECT id FROM bank_recons WHERE bank_account_id=? AND period_key=?', bankAccountId, periodKey);
  if (existing) return existing.id as string;
  const start = `${periodKey}-01`;
  const end = lastOfMonth(start);
  let open: number; let close: number;
  if (isLive(ctx.orgId)) {
    // a real statement states its own ending balance; nothing here can know it
    const entered = opts?.statementCloseCents;
    if (entered === undefined || entered === null || !Number.isInteger(entered)) {
      throw new Error('Enter the ending balance printed on the bank statement.');
    }
    close = entered;
    const prior = q1<any>(
      `SELECT statement_close_cents FROM bank_recons WHERE bank_account_id=? AND period_key<? ORDER BY period_key DESC LIMIT 1`,
      bankAccountId, periodKey,
    );
    const monthLines = val<number>(
      `SELECT COALESCE(SUM(amount_cents),0) FROM bank_txns WHERE bank_account_id=? AND substr(date,1,7)=? AND status!='excluded'`,
      bankAccountId, periodKey,
    ) || 0;
    open = prior ? Number(prior.statement_close_cents) : close - monthLines;
  } else {
    open = linesBalance(bankAccountId, addDays(start, -1));
    close = linesBalance(bankAccountId, end);
  }
  const rid = id('rec');
  insert('bank_recons', {
    id: rid, org_id: ctx.orgId, bank_account_id: bankAccountId, period_key: periodKey,
    statement_open_cents: open, statement_close_cents: close,
    status: 'in_progress', difference_cents: unmatchedTotal(ctx.orgId, bankAccountId, periodKey),
    created_at: nowIso(),
  });
  audit(ctx, 'bank_recon', rid, 'start', null, { periodKey, statementCloseCents: close });
  return rid;
}

/** Correct the statement's ending balance on a reconciliation still in progress. */
export function setStatementClose(ctx: Ctx, reconId: string, cents: number): void {
  const rec = q1<any>('SELECT * FROM bank_recons WHERE id=? AND org_id=?', reconId, ctx.orgId);
  if (!rec || rec.status === 'completed') throw new Error('This reconciliation is not open.');
  if (!Number.isInteger(cents)) throw new Error('Enter the ending balance printed on the bank statement.');
  run('UPDATE bank_recons SET statement_close_cents=? WHERE id=?', cents, reconId);
  audit(ctx, 'bank_recon', reconId, 'statement_balance', { statementCloseCents: rec.statement_close_cents }, { statementCloseCents: cents });
}

export function unmatchedTotal(orgId: string, bankAccountId: string, periodKey: string): number {
  return val<number>(
    `SELECT COALESCE(SUM(amount_cents),0) FROM bank_txns
     WHERE org_id=? AND bank_account_id=? AND substr(date,1,7)=? AND status='unmatched'`,
    orgId, bankAccountId, periodKey,
  ) || 0;
}

function unmatchedCount(bankAccountId: string, periodKey: string): number {
  return val<number>(
    `SELECT COUNT(*) FROM bank_txns WHERE bank_account_id=? AND substr(date,1,7)=? AND status='unmatched'`,
    bankAccountId, periodKey,
  ) || 0;
}

function refreshDifference(orgId: string, reconId: string): void {
  const r = q1<any>('SELECT * FROM bank_recons WHERE id=?', reconId);
  if (!r) return;
  run('UPDATE bank_recons SET difference_cents=? WHERE id=?', unmatchedTotal(orgId, r.bank_account_id, r.period_key), reconId);
}

/** the open reconciliation a statement line belongs to, if one has been started */
function reconFor(txn: any): any {
  return q1<any>('SELECT * FROM bank_recons WHERE bank_account_id=? AND period_key=?', txn.bank_account_id, String(txn.date).slice(0, 7));
}

function matchTxn(orgId: string, txn: any, kind: string, matchedId: string | null, reconId: string | null): void {
  run(`UPDATE bank_txns SET status='matched', matched_kind=?, matched_id=?, recon_id=? WHERE id=?`, kind, matchedId, reconId, txn.id);
  if (kind === 'settlement') {
    run(`UPDATE settlement_batches SET status='reconciled', bank_txn_id=? WHERE id=? AND org_id=?`, txn.id, matchedId, orgId);
  }
  if (kind === 'ap_payment') {
    // the bank has paid it: that is what "cleared" means on the payment register
    run(`UPDATE ap_payments SET status='cleared', cleared_date=? WHERE id=? AND org_id=? AND status='issued'`, txn.date, matchedId, orgId);
  }
}

/** auto-match by stable ref, then by amount and date against what the books hold. */
export function autoMatch(ctx: Ctx, reconId: string): { matched: number; remaining: number } {
  const rec = q1<any>('SELECT * FROM bank_recons WHERE id=? AND org_id=?', reconId, ctx.orgId);
  if (!rec) throw new Error('reconciliation not found');
  if (rec.status === 'completed') throw new Error('This reconciliation is already completed.');
  const acct = q1<any>('SELECT * FROM bank_accounts WHERE id=?', rec.bank_account_id);
  const txns = q<any>(
    `SELECT * FROM bank_txns WHERE bank_account_id=? AND substr(date,1,7)=? AND status='unmatched' ORDER BY date`,
    rec.bank_account_id, rec.period_key,
  );
  let matched = 0;
  tx(() => {
    // 1. stable references written by the simulated feed
    const rest: any[] = [];
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
      rest.push(t);
    }
    if (!rest.length) return;

    // 2. everything else: against the entries the bank has not shown yet.
    // A match is only made when it is the single plausible one — two equal
    // candidates are a question for a person, not a coin toss.
    // An entry and its own reversal never reached the bank and are not
    // candidates: matching a line to the reversed half would leave the reversal
    // standing alone as a deposit in transit and let the month tie on cash
    // that is not there.
    const pool = new Map(withoutReversedPairs(unclearedBookItems(ctx.orgId, acct, '9999-12-31')).map((i) => [i.id, i]));
    const take = (ids: string[]): void => { for (const x of ids) pool.delete(x); };
    for (const t of rest) {
      const amt = t.amount_cents as number;
      if (amt > 0) {
        // a day's deposit batch (one or many receipts) of exactly this amount
        const batches = q<any>(
          `SELECT b.id FROM settlement_batches b
            WHERE b.org_id=? AND b.status='deposited' AND b.bank_txn_id IS NULL
              AND b.batch_date BETWEEN ? AND ?${acct.property_id ? ' AND b.property_id=?' : ''}`,
          ctx.orgId, addDays(t.date, -5), addDays(t.date, 3), ...(acct.property_id ? [acct.property_id] : []),
        ).map((b) => {
          const eids = batchEntries(ctx.orgId, acct, b.id as string);
          // every entry of the batch must still be outstanding — one already
          // cleared on its own means this batch did not arrive as one deposit
          const whole = eids.length > 0 && eids.every((eid) => pool.has(eid));
          return { id: b.id as string, eids, whole, total: whole ? eids.reduce((s2, eid) => s2 + pool.get(eid)!.net, 0) : 0 };
        }).filter((b) => b.whole && b.total === amt);
        if (batches.length === 1) {
          matchTxn(ctx.orgId, t, 'settlement', batches[0]!.id, reconId); take(batches[0]!.eids); matched++; continue;
        }
      } else if (amt < 0) {
        // a vendor payment: by check number when the bank printed it, else by a lone amount
        const pays = q<any>(
          `SELECT ap.id, ap.je_id, ap.check_number, r.run_date FROM ap_payments ap JOIN ap_payment_runs r ON r.id=ap.run_id
            WHERE ap.org_id=? AND ap.amount_cents=? AND ap.status='issued' AND r.run_date BETWEEN ? AND ?`,
          ctx.orgId, -amt, addDays(t.date, -90), addDays(t.date, 1),
        ).filter((p) => p.je_id && pool.has(p.je_id));
        const desc = String(t.description || '');
        const byNumber = pays.filter((p) => p.check_number && new RegExp(`(^|[^0-9A-Za-z])${escapeRe(String(p.check_number))}([^0-9A-Za-z]|$)`).test(desc));
        const recent = pays.filter((p) => cmp(p.run_date, addDays(t.date, -10)) >= 0);
        const pick = byNumber.length === 1 ? byNumber[0] : recent.length === 1 && pays.length === 1 ? recent[0] : null;
        if (pick) { matchTxn(ctx.orgId, t, 'ap_payment', pick.id, reconId); take([pick.je_id]); matched++; continue; }
        if (pays.length) continue; // several equal payments: leave it to a person
      }
      // any other single entry of exactly this amount, close in date
      const near = [...pool.values()].filter((i) => i.net === amt && cmp(i.date, addDays(t.date, -7)) >= 0 && cmp(i.date, addDays(t.date, 3)) <= 0);
      if (near.length === 1) {
        const e = near[0]!;
        const pay = q1<any>(`SELECT id FROM ap_payments WHERE org_id=? AND je_id=? AND status='issued'`, ctx.orgId, e.id);
        if (pay) matchTxn(ctx.orgId, t, 'ap_payment', pay.id, reconId);
        else matchTxn(ctx.orgId, t, 'je', e.id, reconId);
        take([e.id]); matched++;
      }
    }
  });
  refreshDifference(ctx.orgId, reconId);
  const remaining = unmatchedCount(rec.bank_account_id, rec.period_key);
  audit(ctx, 'bank_recon', reconId, 'auto_match', null, { matched, remaining });
  return { matched, remaining };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** the accrual entries of one deposit batch that moved this bank account */
function batchEntries(orgId: string, acct: any, batchId: string): string[] {
  return q<any>(
    `SELECT e.id FROM payments p
       JOIN journal_entries e ON e.org_id=p.org_id AND e.source_kind='settlement' AND e.source_id=p.id AND e.basis='accrual'
       JOIN journal_lines jl ON jl.entry_id=e.id AND jl.account_code=?
      WHERE p.org_id=? AND p.settlement_batch_id=? GROUP BY e.id HAVING SUM(jl.debit_cents - jl.credit_cents) != 0`,
    acct.gl_account, orgId, batchId,
  ).map((e) => e.id as string);
}

function link(ctx: Ctx, bankAccountId: string, txnId: string | null, entryId: string, clearedDate: string): void {
  insert('bank_txn_links', {
    id: id('btl'), org_id: ctx.orgId, bank_account_id: bankAccountId, bank_txn_id: txnId,
    entry_id: entryId, cleared_date: clearedDate, created_by: ctx.userName, created_at: nowIso(),
  });
}

/** A bank-only item (fee, interest, a deposit nobody recorded): put it on the
 * books, both bases, and match the line to the new entry.
 *
 * `account` is the other side of the entry. It used to be decided here —
 * any money in went to 4080 Other income — which booked a deposit that was
 * already on the books a second time as income. The caller now says what it
 * is; the old guesses remain only as the default for fees and interest. */
export function postAdjustment(
  ctx: Ctx, txnId: string, reconId: string | null,
  opts?: { account?: string | null; memo?: string | null; propertyId?: string | null },
): string {
  const t = q1<any>('SELECT * FROM bank_txns WHERE id=? AND org_id=?', txnId, ctx.orgId);
  if (!t) throw new Error('bank txn not found');
  if (t.status !== 'unmatched') throw new Error('transaction already matched');
  const acct = q1<any>('SELECT * FROM bank_accounts WHERE id=?', t.bank_account_id);
  if (!canUseBankAccount(ctx, acct)) throw new Error('bank txn not found');
  const propertyId = acct.property_id || opts?.propertyId || null;
  // the entry lands on this property's books, so the poster must be able to work on it
  if (!propertyId || !canAccessProperty(ctx, propertyId)) {
    throw new Error('Choose the property this entry belongs to.');
  }
  const amt = Math.abs(t.amount_cents);
  const inflow = t.amount_cents > 0;
  const counter = String(opts?.account || '') || (t.kind === 'fee' ? '5710' : inflow ? '4080' : '5810');
  if (counter === acct.gl_account) throw new Error('Choose the account the money came from or went to, not the bank account itself.');
  if (!q1('SELECT id FROM gl_accounts WHERE org_id=? AND code=? AND active=1', ctx.orgId, counter)) {
    throw new Error(`Account ${counter} is not in the chart of accounts.`);
  }
  const memo = (opts?.memo || '').trim().slice(0, 160) || `Bank adjustment — ${t.description}`;
  let jeId = '';
  tx(() => {
    for (const basis of ['accrual', 'cash'] as const) {
      const eid = postJE(ctx, {
        propertyId, date: t.date, basis,
        memo, sourceKind: 'bank_adjustment', sourceId: t.id,
        lines: inflow
          ? [{ account: acct.gl_account, debit: amt }, { account: counter, credit: amt }]
          : [{ account: counter, debit: amt }, { account: acct.gl_account, credit: amt }],
      });
      if (basis === 'accrual') jeId = eid;
    }
    matchTxn(ctx.orgId, t, 'je', jeId, reconId ?? reconFor(t)?.id ?? null);
  });
  const rid = reconId ?? reconFor(t)?.id ?? null;
  if (rid) refreshDifference(ctx.orgId, rid);
  audit(ctx, 'bank_txn', t.id, 'adjustment_je', null, { jeId, amountCents: t.amount_cents, account: counter });
  return jeId;
}

/** Match one statement line to one or more entries already on the books.
 * The entries must add up to the line exactly. */
export function matchEntries(ctx: Ctx, txnId: string, entryIds: string[], reconId: string | null): void {
  const t = q1<any>('SELECT * FROM bank_txns WHERE id=? AND org_id=?', txnId, ctx.orgId);
  if (!t || t.status !== 'unmatched') throw new Error('That statement line is not waiting to be matched.');
  if (monthCompleted(t.bank_account_id, t.date)) throw new Error('That month is already reconciled.');
  const acct = q1<any>('SELECT * FROM bank_accounts WHERE id=?', t.bank_account_id);
  const ids = [...new Set(entryIds.filter(Boolean))];
  if (!ids.length) throw new Error('Choose at least one entry to match this line to.');
  // same candidate rule as the picker and auto-match: a reversed entry is not on offer
  const pool = new Map(withoutReversedPairs(unclearedBookItems(ctx.orgId, acct, '9999-12-31')).map((i) => [i.id, i]));
  const chosen = ids.map((eid) => {
    const item = pool.get(eid);
    if (!item) throw new Error('One of those entries is no longer available — it may already be matched to another line.');
    return item;
  });
  const total = chosen.reduce((s, i) => s + i.net, 0);
  if (total !== t.amount_cents) {
    throw new Error(`The entries chosen add up to ${usd(total)}, but the statement line is ${usd(t.amount_cents)}. They must be equal.`);
  }
  const rid = reconId ?? reconFor(t)?.id ?? null;
  tx(() => {
    const payOf = (eid: string): any => q1<any>(`SELECT id FROM ap_payments WHERE org_id=? AND je_id=? AND status IN ('issued','cleared')`, ctx.orgId, eid);
    if (chosen.length === 1) {
      const pay = payOf(chosen[0]!.id);
      matchTxn(ctx.orgId, t, pay ? 'ap_payment' : 'je', pay ? pay.id : chosen[0]!.id, rid);
    } else {
      matchTxn(ctx.orgId, t, 'multi', null, rid);
      for (const c of chosen) {
        const pay = payOf(c.id);
        if (pay) run(`UPDATE ap_payments SET status='cleared', cleared_date=? WHERE id=? AND status='issued'`, t.date, pay.id);
      }
    }
    for (const c of chosen) link(ctx, acct.id, t.id, c.id, t.date);
  });
  if (rid) refreshDifference(ctx.orgId, rid);
  audit(ctx, 'bank_txn', t.id, 'manual_match', null, { entries: ids, amountCents: t.amount_cents });
}

/** kept for callers that match by kind + id (the seed, older code) */
export function manualMatch(ctx: Ctx, txnId: string, kind: 'settlement' | 'ap_payment' | 'je', matchedId: string, reconId: string | null): void {
  const t = q1<any>('SELECT * FROM bank_txns WHERE id=? AND org_id=?', txnId, ctx.orgId);
  if (!t || t.status !== 'unmatched') throw new Error('transaction not matchable');
  const table = kind === 'settlement' ? 'settlement_batches' : kind === 'ap_payment' ? 'ap_payments' : 'journal_entries';
  if (!q1(`SELECT id FROM ${table} WHERE id=? AND org_id=?`, matchedId, ctx.orgId)) throw new Error('nothing to match to');
  matchTxn(ctx.orgId, t, kind, matchedId, reconId);
  if (reconId) refreshDifference(ctx.orgId, reconId);
  audit(ctx, 'bank_txn', t.id, 'manual_match', null, { kind, matchedId });
}

/** Undo a match or an exclusion while the month is still open. */
export function unmatchTxn(ctx: Ctx, txnId: string): void {
  const t = q1<any>('SELECT * FROM bank_txns WHERE id=? AND org_id=?', txnId, ctx.orgId);
  if (!t || t.status === 'unmatched') throw new Error('That statement line is not matched.');
  if (monthCompleted(t.bank_account_id, t.date)) throw new Error('That month is already reconciled, so its matches are final.');
  const acct = q1<any>('SELECT * FROM bank_accounts WHERE id=?', t.bank_account_id);
  tx(() => {
    if (t.status === 'matched') {
      const reissue = (payId: string): void => {
        run(`UPDATE ap_payments SET status='issued', cleared_date=NULL WHERE id=? AND org_id=? AND status='cleared'`, payId, ctx.orgId);
      };
      if (t.matched_kind === 'ap_payment' && t.matched_id) reissue(t.matched_id);
      if (t.matched_kind === 'settlement' && t.matched_id) {
        run(`UPDATE settlement_batches SET status='deposited', bank_txn_id=NULL WHERE id=? AND org_id=?`, t.matched_id, ctx.orgId);
      }
      for (const l of q<any>('SELECT entry_id FROM bank_txn_links WHERE bank_txn_id=?', t.id)) {
        const pay = q1<any>(`SELECT id FROM ap_payments WHERE org_id=? AND je_id=?`, ctx.orgId, l.entry_id);
        if (pay) reissue(pay.id);
      }
      // an entry that was put on the books FOR this line goes with it
      for (const je of q<any>(
        `SELECT je.* FROM journal_entries je
          WHERE je.org_id=? AND je.source_kind='bank_adjustment' AND je.source_id=? AND je.reversal_of IS NULL
            AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reversal_of=je.id)`,
        ctx.orgId, t.id,
      )) {
        const jl = q<any>('SELECT * FROM journal_lines WHERE entry_id=?', je.id);
        postJE(ctx, {
          propertyId: je.property_id, date: je.date, basis: je.basis,
          memo: `Reversed — ${je.memo || 'bank adjustment'}`, sourceKind: 'bank_adjustment', sourceId: t.id, reversalOf: je.id,
          lines: jl.filter((l: any) => l.debit_cents || l.credit_cents).map((l: any) => ({ account: l.account_code, debit: l.credit_cents || undefined, credit: l.debit_cents || undefined })),
        });
      }
      run('DELETE FROM bank_txn_links WHERE bank_txn_id=? AND bank_account_id=?', t.id, acct.id);
    }
    run(`UPDATE bank_txns SET status='unmatched', matched_kind=NULL, matched_id=NULL, recon_id=NULL WHERE id=?`, t.id);
  });
  const rec = reconFor(t);
  if (rec) refreshDifference(ctx.orgId, rec.id);
  audit(ctx, 'bank_txn', t.id, 'unmatch', { status: t.status, matchedKind: t.matched_kind, matchedId: t.matched_id }, null);
}

/** Set a line aside as not a real statement line (a duplicate, a typo, a line
 * from another account). A real line cannot be made to disappear this way:
 * the statement's ending balance still includes it, so the month will not tie. */
export function excludeTxn(ctx: Ctx, txnId: string, reconId: string | null, reason: string): void {
  const t = q1<any>('SELECT * FROM bank_txns WHERE id=? AND org_id=?', txnId, ctx.orgId);
  if (!t || t.status !== 'unmatched') throw new Error('transaction not excludable');
  if (monthCompleted(t.bank_account_id, t.date)) throw new Error('That month is already reconciled.');
  const rid = reconId ?? reconFor(t)?.id ?? null;
  run(`UPDATE bank_txns SET status='excluded', recon_id=? WHERE id=?`, rid, txnId);
  if (rid) refreshDifference(ctx.orgId, rid);
  audit(ctx, 'bank_txn', txnId, 'exclude', null, { reason });
}

/** An entry dated before the first statement reconciled here was already
 * part of the bank's balance when reconciling began (an opening balance posted
 * by journal entry, a deposit from the month before). Say so once, so it stops
 * being carried as "not yet at the bank". Only entries older than the first
 * statement qualify — anything later has to appear on a statement. */
export function markInOpeningBalance(ctx: Ctx, bankAccountId: string, entryId: string): void {
  const acct = q1<any>('SELECT * FROM bank_accounts WHERE id=? AND org_id=?', bankAccountId, ctx.orgId);
  if (!acct) throw new Error('bank account not found');
  const first = val<string>('SELECT MIN(period_key) FROM bank_recons WHERE bank_account_id=?', acct.id);
  if (!first) throw new Error('Start the first reconciliation for this account before doing this.');
  const item = unclearedBookItems(ctx.orgId, acct, '9999-12-31').find((i) => i.id === entryId);
  if (!item) throw new Error('That entry is not waiting to clear.');
  if (cmp(item.date, `${first}-01`) >= 0) {
    throw new Error('Only entries dated before the first statement can be treated as part of the opening balance. Later entries must be matched to a statement line.');
  }
  link(ctx, acct.id, null, entryId, item.date);
  audit(ctx, 'journal_entry', entryId, 'in_bank_opening_balance', null, { bankAccountId: acct.id, amountCents: item.net });
}

export interface ReconSummary {
  rec: any;
  acct: any;
  live: boolean;
  /** last day the statement covers (month end, or the business date mid-month) */
  end: string;
  bookClose: number;
  /** the statement's ending balance: entered by the operator, or the simulated feed's */
  statementClose: number;
  /** payments on the books the bank has not paid yet (negative amounts) */
  outstanding: { id: string; desc: string; date: string; amount: number }[];
  /** deposits on the books the bank has not shown yet (positive amounts) */
  inTransit: { id: string; desc: string; date: string; amount: number }[];
  unclearedTotal: number;
  /** book balance − not-yet-cleared − statement ending balance; 0 = it ties */
  tieDifference: number;
  unmatchedCount: number;
  /** when a prior statement balance exists: prior close + this month's lines − this close; else null */
  linesGap: number | null;
  adjusted: number;
  matchedCount: number;
}

/** book-vs-bank summary for the workbench and the report */
export function reconSummary(ctx: Ctx, reconId: string): ReconSummary {
  const rec = q1<any>('SELECT * FROM bank_recons WHERE id=? AND org_id=?', reconId, ctx.orgId);
  if (!rec) return { rec: null } as unknown as ReconSummary;
  const acct = q1<any>('SELECT * FROM bank_accounts WHERE id=?', rec.bank_account_id);
  return summarize(ctx, acct, rec.period_key, rec);
}

function summarize(ctx: Ctx, acct: any, periodKey: string, rec: any): ReconSummary {
  const live = isLive(ctx.orgId);
  const end = periodEnd(periodKey, ctx.businessDate);
  const bookClose = accountBalance(ctx, acct.gl_account, { propertyId: acct.property_id || undefined, asOf: end, basis: 'accrual' });
  const uncleared = unclearedBookItems(ctx.orgId, acct, end);
  const unclearedTotal = uncleared.reduce((s, i) => s + i.net, 0);
  const shown = withoutReversedPairs(uncleared);
  const describe = (i: BookItem): string => {
    if (i.sourceKind === 'ap_payment') {
      const p = q1<any>(`SELECT check_number, method FROM ap_payments WHERE org_id=? AND je_id=?`, ctx.orgId, i.id);
      if (p?.check_number) return `${p.method === 'ach' ? 'ACH' : 'Check'} ${p.check_number}${i.memo ? ` — ${i.memo}` : ''}`;
    }
    return i.memo || i.sourceKind.replaceAll('_', ' ');
  };
  const outstanding = shown.filter((i) => i.net < 0).map((i) => ({ id: i.id, desc: describe(i), date: i.date, amount: i.net }));
  const inTransit = shown.filter((i) => i.net > 0).map((i) => ({ id: i.id, desc: describe(i), date: i.date, amount: i.net }));
  // A completed month keeps the balance it was completed at. An open month in
  // a real company uses what the operator read off the statement; in a demo
  // organization the simulated feed is the statement.
  const statementClose = rec && (live || rec.status === 'completed')
    ? Number(rec.statement_close_cents)
    : linesBalance(acct.id, end);
  const monthLines = val<number>(
    `SELECT COALESCE(SUM(amount_cents),0) FROM bank_txns WHERE bank_account_id=? AND substr(date,1,7)=? AND status!='excluded'`,
    acct.id, periodKey,
  ) || 0;
  const prior = q1<any>(
    `SELECT statement_close_cents FROM bank_recons WHERE bank_account_id=? AND period_key<? AND status='completed' ORDER BY period_key DESC LIMIT 1`,
    acct.id, periodKey,
  );
  const linesGap = live && rec && prior ? Number(prior.statement_close_cents) + monthLines - statementClose : null;
  const adjusted = rec ? (val<number>(
    `SELECT COALESCE(SUM(amount_cents),0) FROM bank_txns WHERE recon_id=? AND matched_kind='je' AND status='matched'
        AND EXISTS (SELECT 1 FROM journal_entries je WHERE je.id=bank_txns.matched_id AND je.source_kind='bank_adjustment')`,
    rec.id,
  ) || 0) : 0;
  const matchedCount = val<number>(`SELECT COUNT(*) FROM bank_txns WHERE bank_account_id=? AND substr(date,1,7)=? AND status='matched'`, acct.id, periodKey) || 0;
  return {
    rec, acct, live, end, bookClose, statementClose, outstanding, inTransit, unclearedTotal,
    tieDifference: bookClose - unclearedTotal - statementClose,
    unmatchedCount: unmatchedCount(acct.id, periodKey),
    linesGap, adjusted, matchedCount,
  };
}

/** The same picture for a month nobody has started reconciling yet — read
 * only, so that opening the page writes nothing. */
export function reconPreview(ctx: Ctx, bankAccountId: string, periodKey: string): ReconSummary {
  const acct = q1<any>('SELECT * FROM bank_accounts WHERE id=? AND org_id=?', bankAccountId, ctx.orgId);
  if (!acct) throw new Error('bank account not found');
  return summarize(ctx, acct, periodKey, null);
}

export function completeRecon(ctx: Ctx, reconId: string): void {
  const rec = q1<any>('SELECT * FROM bank_recons WHERE id=? AND org_id=?', reconId, ctx.orgId);
  if (!rec || rec.status === 'completed') throw new Error('reconciliation not open');
  // Completing locks the calendar month for good: no line can be added to it
  // afterwards and there is no reopen. A real statement does not exist until
  // the month is over, so a live month cannot be completed while it is still
  // running — the lines from the rest of the month would have nowhere to go.
  // Demo organizations keep the in-flight clamp (the simulated feed IS the
  // statement, through the business date).
  if (!statementMonthOver(ctx, rec.period_key)) {
    throw new Error(`The statement month has not ended yet. ${fmtMonth(rec.period_key)} can be completed once the month is over and the full statement is entered.`);
  }
  const open = unmatchedCount(rec.bank_account_id, rec.period_key);
  if (open > 0) {
    throw new Error(`${open} statement line${open === 1 ? ' is' : 's are'} still unmatched — every line must be matched, recorded on the books or set aside, and the difference must be zero to complete.`);
  }
  const s = reconSummary(ctx, reconId);
  if (s.tieDifference !== 0) {
    throw new Error(
      `The books and the statement are ${usd(Math.abs(s.tieDifference))} apart: book balance ${usd(s.bookClose)}, less ${usd(s.unclearedTotal)} not yet at the bank, `
      + `leaves ${usd(s.bookClose - s.unclearedTotal)} against a statement ending balance of ${usd(s.statementClose)}. `
      + 'Look for a statement line that is missing, entered twice or set aside, an earlier month with unmatched lines, or a wrong ending balance.',
    );
  }
  run(
    `UPDATE bank_recons SET status='completed', difference_cents=0, statement_close_cents=?, completed_by=?, completed_at=? WHERE id=?`,
    s.statementClose, ctx.userName, nowIso(), reconId,
  );
  emit(ctx, 'bank.reconciled', 'bank_recon', reconId, { periodKey: rec.period_key, bankAccountId: rec.bank_account_id });
  audit(ctx, 'bank_recon', reconId, 'complete', null, { statementCloseCents: s.statementClose, bookCloseCents: s.bookClose, notYetClearedCents: s.unclearedTotal });
}

/** unreconciled-item aging (M9.5) */
export function unreconciledAging(ctx: Ctx): { account: any; buckets: Record<string, { n: number; amount: number }> }[] {
  const out: { account: any; buckets: Record<string, { n: number; amount: number }> }[] = [];
  const scope = bankScopeSql(ctx, 'property_id');
  for (const a of q<any>(`SELECT * FROM bank_accounts WHERE org_id=? AND active=1${scope.sql}`, ctx.orgId, ...scope.params)) {
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
  describe: 'Demo organizations only: pulls simulated bank transactions (settlement deposits, check clearings, fees) into every active bank account.',
  run: (ctx, date) => {
    ensureBankAccounts(ctx.orgId);
    const n = importAllFeeds(ctx.orgId, date);
    return n ? `${n} bank transactions imported` : 'feed up to date';
  },
});
