import { q, q1 } from '../../lib/db.ts';
import { firstOfMonth, lastOfMonth, addMonths, diffDays, type DateStr } from '../../lib/dates.ts';
import { propFilter, type Ctx } from '../../lib/auth.ts';
import { incomeStatement, balanceSheet, t12 } from '../m9_accounting/statements.ts';
import { agingRows, leaseBalance, type AgingRow } from '../m8_receivables/service.ts';

/** Simple mode, phase 1: the five numbers.
 *
 * Every figure on the home screen is computed here rather than in the page, so
 * a test can re-derive it from the same call the screen makes. That is not
 * tidiness — it is the only way to keep this screen honest. The whole point of
 * simple mode is that an owner who does not read a trial balance can trust a
 * number they cannot check, which means the number has to be the ledger's own
 * answer and has to be provably so. A convenience aggregate computed in the
 * template would be unfalsifiable by construction.
 *
 * Two rules the numbers here obey:
 *
 * **Cash basis, stated.** The owner's intuition for "what did I make" is money
 * that actually arrived minus money that actually left, which is the cash-basis
 * books. Accrual stays in advanced mode. Both bases are real here — every
 * payment posts a JE on each — so this is a choice of question, not a
 * compromise on rigour.
 *
 * **Arithmetic, not results.** Each answer carries the terms it was computed
 * from, because a single figure invites belief and a subtraction invites
 * checking. `net` ships beside `collected` and `paidOut`; `afterBills` ships
 * beside the balance and the bills. The page renders the operation.
 */

// ---------- 1. what you made this month ----------

export interface MonthEarnings {
  from: DateStr;
  to: DateStr;
  /** money that actually arrived, this month to date */
  collected: number;
  /** money that actually left */
  paidOut: number;
  /** collected − paidOut */
  net: number;
  /** the same figure for the whole of last month, for comparison */
  prevNet: number;
  /** trailing 12 months of net, oldest first, with their YYYY-MM keys */
  strip: { month: string; net: number }[];
}

export function monthEarnings(ctx: Ctx, propertyId: string | null): MonthEarnings {
  const to = ctx.businessDate as DateStr;
  const from = firstOfMonth(to);
  const cur = incomeStatement(ctx, { propertyId, from, to, basis: 'cash' });

  const prevAnchor = addMonths(to, -1);
  const prev = incomeStatement(ctx, {
    propertyId,
    from: firstOfMonth(prevAnchor),
    to: lastOfMonth(prevAnchor),
    basis: 'cash',
  });

  const trail = t12(ctx, { propertyId, to, basis: 'cash' });
  return {
    from,
    to,
    collected: cur.totalIncome,
    paidOut: cur.totalExpenses,
    net: cur.noi,
    prevNet: prev.noi,
    strip: trail.months.map((month, i) => ({ month, net: trail.totals.noi[i] || 0 })),
  };
}

// ---------- 2. cash ----------

/** One cash account, with the sentence that says whose money it is. */
export interface CashLine {
  code: string;
  label: string;
  note: string;
  amount: number;
}

export interface CashPosition {
  /** GL 1010 — the only figure that answers "how much have I got" */
  operating: number;
  /** the other cash accounts, each labelled with whose money it is */
  otherLines: CashLine[];
  /** approved and awaiting-approval bills falling due on or before month-end */
  billsDueByMonthEnd: number;
  billsCount: number;
  /** operating − billsDueByMonthEnd. Arithmetic, not a forecast. */
  afterBills: number;
  /** rent billed for this month and still unpaid — shown, NOT counted */
  rentStillExpected: number;
  monthEnd: DateStr;
}

/** A balance-sheet line's amount, or zero.
 *
 * `balanceSheet` drops lines whose balance is zero, so an absent code means
 * "no balance" and not "no such account". Reading it as undefined and letting
 * it reach the page as NaN is the obvious bug here, and it would render as a
 * blank where the owner expects a number. */
function assetAmount(sheet: ReturnType<typeof balanceSheet>, code: string): number {
  return sheet.assets.find((l) => l.code === code)?.amount || 0;
}

export function cashPosition(ctx: Ctx, propertyId: string | null): CashPosition {
  const asOf = ctx.businessDate as DateStr;
  const monthEnd = lastOfMonth(asOf);
  const sheet = balanceSheet(ctx, { propertyId, asOf, basis: 'cash' });

  // 1010 alone. NOT cashFlow().closing, whose CASH_CODES is {1010,1020,1030}:
  // that sum folds the deposit float and the reserve into "your cash" and
  // overstates spendable cash by the whole of both. The others are real money
  // and get their own lines — they are simply not the owner's to spend.
  const operating = assetAmount(sheet, '1010');
  const otherLines: CashLine[] = [
    { code: '1020', label: 'Deposits', note: 'Held for residents — not yours to spend.', amount: assetAmount(sheet, '1020') },
    { code: '1030', label: 'Reserves', note: 'Saved for repairs.', amount: assetAmount(sheet, '1030') },
    // Payments land in clearing and settle to 1010 a day or two later. Without
    // this line an owner who recorded a payment this morning would find it
    // missing from "in the bank" and conclude the screen is broken.
    { code: '1050', label: 'Still clearing', note: 'Paid by residents, on its way to the bank.', amount: assetAmount(sheet, '1050') },
  ].filter((l) => l.amount !== 0);

  const pf = propertyId ? { sql: ' AND property_id=?', params: [propertyId] } : propFilter(ctx, 'property_id');
  const bills = q1<{ n: number; total: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(total_cents),0) AS total FROM vendor_invoices
     WHERE org_id=? AND status IN ('approved','pending_approval') AND due_date<=?${pf.sql}`,
    ctx.orgId, monthEnd, ...pf.params,
  );
  const billsDueByMonthEnd = Number(bills?.total || 0);

  // Rent billed this month and not yet paid. Deliberately NOT added to
  // `afterBills`: the moment a collection assumption enters the arithmetic the
  // figure stops being something the books can vouch for.
  const rpf = propertyId ? { sql: ' AND c.property_id=?', params: [propertyId] } : propFilter(ctx, 'c.property_id');
  const expected = q1<{ total: number }>(
    `SELECT COALESCE(SUM(c.amount_cents - COALESCE((
       SELECT SUM(pa.amount_cents) FROM payment_applications pa
       JOIN payments p ON p.id=pa.payment_id AND p.status IN ('pending','settled')
       WHERE pa.charge_id=c.id), 0)), 0) AS total
     FROM charges c
     WHERE c.org_id=? AND c.status='active' AND c.kind='rent'
       AND c.due_date>=? AND c.due_date<=?${rpf.sql}`,
    ctx.orgId, firstOfMonth(asOf), monthEnd, ...rpf.params,
  );

  return {
    operating,
    otherLines,
    billsDueByMonthEnd,
    billsCount: Number(bills?.n || 0),
    afterBills: operating - billsDueByMonthEnd,
    rentStillExpected: Math.max(0, Number(expected?.total || 0)),
    monthEnd,
  };
}

// ---------- 3. who owes you ----------

export interface OwedToYou {
  /** what residents are behind by — positive balances only */
  total: number;
  households: number;
  top: AgingRow[];
  /** every lease balance, any status, signed: the resident subledger in full */
  subledger: number;
  /** GL 1100 on the accrual books */
  glReceivable: number;
  /** whether the subledger and the ledger agree, to the cent */
  ties: boolean;
}

export function owedToYou(ctx: Ctx, propertyId: string | null): OwedToYou {
  const rows = agingRows(ctx, { propertyId, minBalance: 0 });
  const total = rows.reduce((s, r) => s + r.balance, 0);

  // The tie has to compare like with like, and `total` above is not like GL
  // 1100. It is a filtered view of the subledger: positive balances only, and
  // only the lease statuses the aging report covers. Comparing it to the
  // receivable account produced a confident red "these do not agree" on books
  // that balance to the cent — a false alarm on the one rule whose entire job
  // is to be believed. An owner who is shown a scary warning that turns out to
  // be nothing learns to skip the next one, which is worse than having no rule.
  //
  // So the tie sums EVERY lease balance, every status, signed — credits
  // included — which is exactly what posts to 1100. On the seeded demo that
  // difference is zero; the filtered figure was out by $3,564.71.
  const pf = propertyId ? { sql: ' AND property_id=?', params: [propertyId] } : propFilter(ctx, 'property_id');
  const leases = q<{ id: string }>(
    `SELECT id FROM leases WHERE org_id=?${pf.sql}`, ctx.orgId, ...pf.params,
  );
  let subledger = 0;
  for (const l of leases) subledger += leaseBalance(ctx, l.id);

  const sheet = balanceSheet(ctx, { propertyId, asOf: ctx.businessDate as DateStr, basis: 'accrual' });
  const glReceivable = assetAmount(sheet, '1100');

  return {
    total, households: rows.length, top: rows.slice(0, 5),
    subledger, glReceivable, ties: subledger === glReceivable,
  };
}

// ---------- 4. which units cost you money ----------

/** An empty unit, and what the emptiness has cost so far.
 *
 * `since` is null for a unit with no lease history — every unit of a fresh
 * import. That is the honest answer and the page renders it as one: "empty",
 * with no duration and no lost-rent figure. The alternative, dating the
 * vacancy from the import, would put a measured-looking number on the screen
 * that measures when the data arrived. */
export interface VacantUnit {
  id: string;
  unitNumber: string;
  propertyName: string;
  status: string;
  marketRentCents: number;
  since: string | null;
  sinceSource: string | null;
  daysEmpty: number | null;
  rentLostCents: number | null;
}

export function vacantUnits(ctx: Ctx, propertyId: string | null): VacantUnit[] {
  const pf = propertyId ? { sql: ' AND u.property_id=?', params: [propertyId] } : propFilter(ctx, 'u.property_id');
  // The stored column wins; where it is empty the date is derived from the
  // lease that ended, in the query.
  //
  // The boot migration persists the same derivation, but correctness must not
  // depend on it: the migration runs once at startup, and units arrive AFTER
  // startup — an import brings in a vacant unit with its ended lease, and a
  // boot-only backfill would leave that unit dateless until the next restart.
  // That is precisely the live re-import case. Deriving here makes the column
  // a stored value rather than the only source of the answer, so an owner-
  // entered date still overrides and everything else is always current.
  const rows = q<any>(
    `SELECT u.id, u.unit_number, u.status, u.market_rent_cents, u.vacant_since_source,
            COALESCE(u.vacant_since, (
              SELECT COALESCE(l.move_out_date, l.end_date) FROM leases l
              WHERE l.unit_id = u.id AND l.status = 'ended'
                AND COALESCE(l.move_out_date, l.end_date) IS NOT NULL
              ORDER BY COALESCE(l.move_out_date, l.end_date) DESC LIMIT 1
            )) AS vacant_since,
            p.name AS property_name
     FROM units u JOIN properties p ON p.id=u.property_id
     WHERE u.org_id=? AND u.status IN ('vacant_ready','vacant_not_ready')${pf.sql}
     ORDER BY vacant_since IS NULL, vacant_since, p.name, u.unit_number`,
    ctx.orgId, ...pf.params,
  );
  return rows.map((r) => {
    const days = r.vacant_since ? Math.max(0, diffDays(ctx.businessDate, r.vacant_since)) : null;
    return {
      id: r.id,
      unitNumber: r.unit_number,
      propertyName: r.property_name,
      status: r.status,
      marketRentCents: r.market_rent_cents,
      since: r.vacant_since || null,
      // A date that came out of the COALESCE above has no stored source row.
      // It is still a lease-derived date, and the UI distinction that matters
      // is entered-vs-derived, so anything not marked 'owner' reads as 'lease'.
      sinceSource: r.vacant_since ? (r.vacant_since_source === 'owner' ? 'owner' : 'lease') : null,
      daysEmpty: days,
      // Daily rate x days empty. Market rent is what the unit is advertised at,
      // so this is rent not collected rather than rent lost to a known tenant.
      rentLostCents: days === null ? null : Math.round((r.market_rent_cents / 30) * days),
    };
  });
}

/** Occupied units whose household is behind. The other half of question 4:
 * a unit can cost money by being empty or by being occupied and not paying. */
export function notPaying(ctx: Ctx, propertyId: string | null): AgingRow[] {
  return agingRows(ctx, { propertyId, minBalance: 0 }).slice(0, 10);
}

// ---------- 5. what needs your OK ----------

/** One thing waiting on a decision, from either queue.
 *
 * `kind` is the tag the owner sees: 'money' for a bill or a spend, 'message'
 * for anything an agent wants to send to a person. Simple mode shows one list
 * because an owner has one question ("what needs me?"), and the product had
 * two screens answering it — /approvals for money and /ai for drafts, the
 * second of which is the governance promise and was filed under Reports. */
export interface NeedsOkItem {
  kind: 'money' | 'message';
  id: string;
  title: string;
  detail: string;
  amountCents: number | null;
  /** plain-language confidence, agent items only */
  sureness: string | null;
  rationale: string | null;
  /** where to go to act on it, when it is not decidable inline */
  href: string | null;
  /** inline approve/reject, agent items only */
  decidable: boolean;
}

/** The copy map's words for a confidence number. An owner cannot act on 0.82. */
export function sureness(confidence: number): string {
  if (confidence >= 0.9) return 'Very sure';
  if (confidence >= 0.7) return 'Fairly sure';
  return 'Not sure';
}

export function agentDrafts(ctx: Ctx, propertyId: string | null): NeedsOkItem[] {
  const pf = propertyId ? ' AND a.property_id=?' : '';
  const rows = q<any>(
    `SELECT a.*, p.name AS prop FROM ai_actions a LEFT JOIN properties p ON p.id=a.property_id
     WHERE a.org_id=? AND a.status='proposed'${pf} ORDER BY a.created_at DESC`,
    ...(propertyId ? [ctx.orgId, propertyId] : [ctx.orgId]),
  );
  return rows.map((a) => ({
    kind: 'message' as const,
    id: a.id,
    title: a.title,
    detail: a.prop || '',
    amountCents: null,
    sureness: sureness(Number(a.confidence)),
    rationale: a.rationale || null,
    href: null,
    decidable: true,
  }));
}
