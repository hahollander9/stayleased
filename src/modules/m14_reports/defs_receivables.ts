import { q, q1, val, j } from '../../lib/db.ts';
import { addMonths, monthKey } from '../../lib/dates.ts';
import { registerReport, propScope, monthsBack, type ReportResult } from './engine.ts';
import { agingAsOf } from './asof.ts';
import { receivablesStats, depositHeld } from '../m8_receivables/payments.ts';

/** §10 Receivables: Delinquency/Aged Receivables (with notes), Collection
 * Rate & On-Time %, NSF/Chargeback Register, Payment Plan Status, Prepaids &
 * Credits, Deposit Accountability, Final Account Statement Register, Bad
 * Debt/Write-Off. */

const PROP = { key: 'property', kind: 'property' as const };

registerReport({
  key: 'delinquency_aged',
  name: 'Delinquency / Aged Receivables',
  category: 'Receivables',
  describe: 'Aged open balances as of any date, with the latest collection note.',
  params: [{ ...PROP, allowAll: true }, { key: 'date', kind: 'date' }],
  run(ctx, p): ReportResult {
    const propId = p.property === 'all' ? null : p.property!;
    const rows = agingAsOf(ctx, propId, p.date!)
      .filter((r) => propId || ctx.allProperties || ctx.propertyIds.includes(r.property_id))
      .map((r) => ({
        property: r.property_name,
        unit: r.unit_number,
        household: r.household_name,
        current: r.current,
        d1_30: r.d1_30,
        d31_60: r.d31_60,
        d61_90: r.d61_90,
        d90p: r.d90p,
        balance: r.balance,
        note: r.latest_note ? r.latest_note.slice(0, 80) : '—',
        __href: `/delinquency/${r.lease_id}`,
      }));
    return {
      cols: [
        { key: 'property', label: 'Property' },
        { key: 'unit', label: 'Unit' },
        { key: 'household', label: 'Household' },
        { key: 'current', label: 'Current', kind: 'money', total: true },
        { key: 'd1_30', label: '1–30', kind: 'money', total: true },
        { key: 'd31_60', label: '31–60', kind: 'money', total: true },
        { key: 'd61_90', label: '61–90', kind: 'money', total: true },
        { key: 'd90p', label: '90+', kind: 'money', total: true },
        { key: 'balance', label: 'Total', kind: 'money', total: true },
        { key: 'note', label: 'Latest note' },
      ],
      rows,
      note: `As of ${p.date}. Aging applies good payments FIFO against charges by due date (docs/metrics.md).`,
    };
  },
});

registerReport({
  key: 'collection_rate',
  name: 'Collection Rate & On-Time %',
  category: 'Receivables',
  describe: 'Billed vs collected, on-time share, NSF rate and autopay adoption by month.',
  params: [{ ...PROP, allowAll: true }],
  run(ctx, p): ReportResult {
    const propId = p.property === 'all' ? null : p.property!;
    const rows = monthsBack(ctx, 12).map((mk) => {
      const s = receivablesStats(ctx, mk, propId);
      return {
        month: mk,
        billed: s.billed,
        collected: s.collected,
        collection_rate: s.collectionRate,
        on_time: s.onTimePct,
        nsf_rate: s.nsfRate,
        autopay: s.autopayAdoption,
        __href: `/receivables?month=${mk}`,
      };
    });
    return {
      cols: [
        { key: 'month', label: 'Month', kind: 'month' },
        { key: 'billed', label: 'Billed', kind: 'money', total: true },
        { key: 'collected', label: 'Collected', kind: 'money', total: true },
        { key: 'collection_rate', label: 'Collection rate', kind: 'pct' },
        { key: 'on_time', label: 'On-time rent', kind: 'pct' },
        { key: 'nsf_rate', label: 'NSF rate', kind: 'pct' },
        { key: 'autopay', label: 'Autopay', kind: 'pct' },
      ],
      rows,
    };
  },
});

registerReport({
  key: 'nsf_register',
  name: 'NSF / Chargeback Register',
  category: 'Receivables',
  describe: 'Every returned payment with fees assessed and recovery status.',
  params: [{ ...PROP, allowAll: true }, { key: 'from', kind: 'from', default: (ctx) => addMonths(ctx.businessDate, -6) }, { key: 'to', kind: 'to' }],
  run(ctx, p): ReportResult {
    const { sql, params } = propScope(ctx, p.property!, 'py.property_id');
    const rows = q<any>(
      `SELECT py.*, l.household_name, u.unit_number, p2.name AS prop
       FROM payments py JOIN leases l ON l.id=py.lease_id JOIN units u ON u.id=l.unit_id JOIN properties p2 ON p2.id=py.property_id
       WHERE py.org_id=?${sql} AND py.status IN ('nsf','chargeback') AND COALESCE(py.nsf_date, py.received_date) BETWEEN ? AND ?
       ORDER BY COALESCE(py.nsf_date, py.received_date) DESC`,
      ctx.orgId, ...params, p.from, p.to,
    ).map((py) => {
      const fee = q1<any>(
        `SELECT amount_cents FROM charges WHERE lease_id=? AND kind='nsf_fee' AND date>=? ORDER BY date LIMIT 1`,
        py.lease_id, py.nsf_date || py.received_date,
      );
      const rebilled = val<number>(
        `SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE lease_id=? AND status IN ('pending','settled') AND received_date > ?`,
        py.lease_id, py.nsf_date || py.received_date,
      ) || 0;
      return {
        date: py.nsf_date || py.received_date,
        kind: py.status,
        property: py.prop,
        unit: py.unit_number,
        household: py.household_name,
        method: py.method,
        amount: py.amount_cents,
        fee: fee?.amount_cents ?? 0,
        recovered: rebilled >= py.amount_cents ? 'repaid since' : 'outstanding',
        __href: `/leases/${py.lease_id}`,
      };
    });
    return {
      cols: [
        { key: 'date', label: 'Returned', kind: 'date' },
        { key: 'kind', label: 'Type', kind: 'badge' },
        { key: 'property', label: 'Property' },
        { key: 'unit', label: 'Unit' },
        { key: 'household', label: 'Household' },
        { key: 'method', label: 'Method' },
        { key: 'amount', label: 'Amount', kind: 'money', total: true },
        { key: 'fee', label: 'Fee assessed', kind: 'money', total: true },
        { key: 'recovered', label: 'Recovery', kind: 'badge' },
      ],
      rows,
    };
  },
});

registerReport({
  key: 'payment_plans',
  name: 'Payment Plan Status',
  category: 'Receivables',
  describe: 'Every plan with installment progress and defaults.',
  params: [{ ...PROP, allowAll: true }],
  run(ctx, p): ReportResult {
    const { sql, params } = propScope(ctx, p.property!, 'pp.property_id');
    const rows = q<any>(
      `SELECT pp.*, l.household_name, u.unit_number, p2.name AS prop
       FROM payment_plans pp JOIN leases l ON l.id=pp.lease_id JOIN units u ON u.id=l.unit_id JOIN properties p2 ON p2.id=pp.property_id
       WHERE pp.org_id=?${sql} ORDER BY pp.created_at DESC`,
      ctx.orgId, ...params,
    ).map((pp) => {
      const inst = q<any>('SELECT status, amount_cents FROM payment_plan_installments WHERE plan_id=? ORDER BY due_date', pp.id);
      const paid = inst.filter((i) => i.status === 'paid');
      const missed = inst.filter((i) => i.status === 'missed').length;
      return {
        created: pp.created_at.slice(0, 10),
        property: pp.prop,
        unit: pp.unit_number,
        household: pp.household_name,
        total: pp.total_cents,
        paid: paid.reduce((s, i) => s + i.amount_cents, 0),
        installments: `${paid.length}/${inst.length}`,
        missed,
        status: pp.status,
        __href: `/delinquency/${pp.lease_id}`,
      };
    });
    return {
      cols: [
        { key: 'created', label: 'Created', kind: 'date' },
        { key: 'property', label: 'Property' },
        { key: 'unit', label: 'Unit' },
        { key: 'household', label: 'Household' },
        { key: 'total', label: 'Plan total', kind: 'money', total: true },
        { key: 'paid', label: 'Paid so far', kind: 'money', total: true },
        { key: 'installments', label: 'Installments' },
        { key: 'missed', label: 'Missed', kind: 'num' },
        { key: 'status', label: 'Status', kind: 'badge' },
      ],
      rows,
    };
  },
});

registerReport({
  key: 'prepaids_credits',
  name: 'Prepaids & Credits',
  category: 'Receivables',
  describe: 'Households holding credit balances, with the GL liability tie-out.',
  params: [{ ...PROP, allowAll: true }],
  defaultSort: 'credit',
  defaultDir: 'desc',
  run(ctx, p): ReportResult {
    const { sql, params } = propScope(ctx, p.property!, 'l.property_id');
    const leases = q<any>(
      `SELECT l.id, l.household_name, l.status, u.unit_number, p2.name AS prop,
        (SELECT COALESCE(SUM(amount_cents),0) FROM charges WHERE lease_id=l.id AND status='active') -
        (SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE lease_id=l.id AND status IN ('pending','settled')) AS bal
       FROM leases l JOIN units u ON u.id=l.unit_id JOIN properties p2 ON p2.id=l.property_id
       WHERE l.org_id=?${sql} AND l.status IN ('active','month_to_month','notice')`,
      ctx.orgId, ...params,
    ).filter((l) => l.bal < 0);
    const rows = leases.map((l) => ({
      property: l.prop,
      unit: l.unit_number,
      household: l.household_name,
      status: l.status,
      credit: -l.bal,
      __href: `/leases/${l.id}`,
    }));
    const glBal = val<number>(
      `SELECT COALESCE(SUM(jl.credit_cents - jl.debit_cents),0) FROM journal_lines jl
       JOIN journal_entries je ON je.id=jl.entry_id
       WHERE jl.org_id=? AND je.basis='accrual' AND jl.account_code='2150'${p.property !== 'all' ? ' AND jl.property_id=?' : ''}`,
      ctx.orgId, ...(p.property !== 'all' ? [p.property] : []),
    ) || 0;
    return {
      cols: [
        { key: 'property', label: 'Property' },
        { key: 'unit', label: 'Unit' },
        { key: 'household', label: 'Household' },
        { key: 'status', label: 'Status', kind: 'badge' },
        { key: 'credit', label: 'Credit balance', kind: 'money', total: true },
      ],
      rows,
      note: `GL 2150 Resident Prepayments & Credits balance: ${(glBal / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} (accrual). Ledger credits auto-apply to the next charge run.`,
    };
  },
});

registerReport({
  key: 'deposit_accountability',
  name: 'Deposit Accountability',
  category: 'Receivables',
  describe: 'Deposits held per household vs the 2100 liability and escrow cash.',
  params: [PROP],
  run(ctx, p): ReportResult {
    const leases = q<any>(
      `SELECT l.id, l.household_name, l.status, l.deposit_alternative, u.unit_number
       FROM leases l JOIN units u ON u.id=l.unit_id
       WHERE l.property_id=? AND l.status IN ('active','month_to_month','notice','ended')
       ORDER BY u.unit_number`,
      p.property,
    );
    const rows: ReportResult['rows'] = [];
    for (const l of leases) {
      const held = depositHeld(ctx, l.id);
      if (held <= 0 && !l.deposit_alternative) continue;
      rows.push({
        unit: l.unit_number,
        household: l.household_name,
        status: l.status,
        arrangement: l.deposit_alternative ? 'deposit alternative' : 'cash deposit',
        held,
        __href: `/leases/${l.id}`,
      });
    }
    const gl2100 = val<number>(
      `SELECT COALESCE(SUM(jl.credit_cents - jl.debit_cents),0) FROM journal_lines jl
       JOIN journal_entries je ON je.id=jl.entry_id
       WHERE jl.org_id=? AND je.basis='accrual' AND jl.account_code='2100' AND jl.property_id=?`,
      ctx.orgId, p.property,
    ) || 0;
    const heldSum = rows.reduce((s, r) => s + Number(r.held || 0), 0);
    return {
      cols: [
        { key: 'unit', label: 'Unit' },
        { key: 'household', label: 'Household' },
        { key: 'status', label: 'Status', kind: 'badge' },
        { key: 'arrangement', label: 'Arrangement' },
        { key: 'held', label: 'Held', kind: 'money', total: true },
      ],
      rows,
      note: `Subledger held ${(heldSum / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} vs GL 2100 ${(gl2100 / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} — ${heldSum === gl2100 ? 'TIES ✓' : 'difference is dispositions in flight'}.`,
    };
  },
});

registerReport({
  key: 'final_statements',
  name: 'Final Account Statement Register',
  category: 'Receivables',
  describe: 'Move-out dispositions: deposit applied, refunded, and balance due.',
  params: [{ ...PROP, allowAll: true }, { key: 'from', kind: 'from', default: (ctx) => addMonths(ctx.businessDate, -12) }, { key: 'to', kind: 'to' }],
  run(ctx, p): ReportResult {
    const { sql, params } = propScope(ctx, p.property!, 'l.property_id');
    const rows = q<any>(
      `SELECT l.id, l.household_name, l.move_out_date, u.unit_number, p2.name AS prop,
        (SELECT COALESCE(SUM(-amount_cents),0) FROM deposit_activity WHERE lease_id=l.id AND kind='apply') AS applied,
        (SELECT COALESCE(SUM(-amount_cents),0) FROM deposit_activity WHERE lease_id=l.id AND kind='refund') AS refunded
       FROM leases l JOIN units u ON u.id=l.unit_id JOIN properties p2 ON p2.id=l.property_id
       WHERE l.org_id=?${sql} AND l.status='ended' AND l.move_out_date BETWEEN ? AND ?
       ORDER BY l.move_out_date DESC`,
      ctx.orgId, ...params, p.from, p.to,
    ).map((l) => {
      const balAfter = val<number>(
        `SELECT (SELECT COALESCE(SUM(amount_cents),0) FROM charges WHERE lease_id=? AND status='active') -
                (SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE lease_id=? AND status IN ('pending','settled'))`,
        l.id, l.id,
      ) || 0;
      return {
        move_out: l.move_out_date,
        property: l.prop,
        unit: l.unit_number,
        household: l.household_name,
        applied: l.applied,
        refunded: l.refunded,
        balance_due: Math.max(0, balAfter),
        outcome: balAfter > 0 ? 'balance due' : l.refunded > 0 ? 'refund issued' : 'settled',
        __href: `/leases/${l.id}`,
      };
    });
    return {
      cols: [
        { key: 'move_out', label: 'Move-out', kind: 'date' },
        { key: 'property', label: 'Property' },
        { key: 'unit', label: 'Unit' },
        { key: 'household', label: 'Household' },
        { key: 'applied', label: 'Deposit applied', kind: 'money', total: true },
        { key: 'refunded', label: 'Refunded', kind: 'money', total: true },
        { key: 'balance_due', label: 'Balance due', kind: 'money', total: true },
        { key: 'outcome', label: 'Outcome', kind: 'badge' },
      ],
      rows,
    };
  },
});

registerReport({
  key: 'bad_debt',
  name: 'Bad Debt / Write-Off',
  category: 'Receivables',
  describe: 'Write-offs posted to 5610 plus open collection exposure.',
  params: [{ ...PROP, allowAll: true }],
  defaultGroup: 'bucket',
  run(ctx, p): ReportResult {
    const { sql, params } = propScope(ctx, p.property!, 'c.property_id');
    const writeoffs = q<any>(
      `SELECT c.date, c.amount_cents, c.label, l.household_name, u.unit_number, p2.name AS prop, c.lease_id
       FROM charges c JOIN leases l ON l.id=c.lease_id JOIN units u ON u.id=l.unit_id JOIN properties p2 ON p2.id=c.property_id
       WHERE c.org_id=?${sql} AND c.kind='writeoff' AND c.status='active' ORDER BY c.date DESC`,
      ctx.orgId, ...params,
    );
    const { sql: sql2, params: params2 } = propScope(ctx, p.property!, 'cc.property_id');
    const cases = q<any>(
      `SELECT cc.*, l.household_name, u.unit_number, p2.name AS prop
       FROM collection_cases cc JOIN leases l ON l.id=cc.lease_id JOIN units u ON u.id=l.unit_id JOIN properties p2 ON p2.id=cc.property_id
       WHERE cc.org_id=?${sql2} AND cc.status='open' ORDER BY cc.opened_date`,
      ctx.orgId, ...params2,
    );
    const rows = [
      ...writeoffs.map((w) => ({
        bucket: 'Written off',
        date: w.date,
        property: w.prop,
        unit: w.unit_number,
        household: w.household_name,
        amount: -w.amount_cents,
        detail: w.label,
        __href: `/delinquency/${w.lease_id}`,
      })),
      ...cases.map((c) => ({
        bucket: 'In collections (open)',
        date: c.opened_date,
        property: c.prop,
        unit: c.unit_number,
        household: c.household_name,
        amount: c.balance_cents,
        detail: c.agency ? `agency: ${c.agency}` : 'awaiting agency export',
        __href: `/delinquency/${c.lease_id}`,
      })),
    ];
    return {
      cols: [
        { key: 'bucket', label: 'Bucket' },
        { key: 'date', label: 'Date', kind: 'date' },
        { key: 'property', label: 'Property' },
        { key: 'unit', label: 'Unit' },
        { key: 'household', label: 'Household' },
        { key: 'amount', label: 'Amount', kind: 'money', total: true },
        { key: 'detail', label: 'Detail' },
      ],
      rows,
      note: 'Write-offs post DR 5610 Bad Debt Expense / CR 1100 AR with a required written reason.',
    };
  },
});
