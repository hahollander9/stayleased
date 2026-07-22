import { q, q1, val } from '../../lib/db.ts';
import { addMonths, monthKey } from '../../lib/dates.ts';
import { registerReport, propScope, monthsBack, type ReportResult } from './engine.ts';
import { recoveryReport } from '../m11_utilities/service.ts';

/** §10 Utilities/insurance/risk: Utility Recovery Rate, Usage & Expense
 * Trends, Vacant Unit Cost Recovery, Insurance Compliance, Deposit
 * Alternative & Guaranty Portfolio. */

const PROP = { key: 'property', kind: 'property' as const };

registerReport({
  key: 'utility_recovery',
  name: 'Utility Recovery Rate',
  category: 'Utilities, insurance & risk',
  describe: 'RUBS billing vs provider cost by service and month.',
  params: [PROP],
  perm: 'utilities:view',
  defaultGroup: 'service',
  run(ctx, p): ReportResult {
    const r = recoveryReport(ctx, p.property!, 6);
    const rows: ReportResult['rows'] = [];
    for (const svc of r.rows) {
      r.months.forEach((mk, i) => {
        if (!svc.billed[i]) return;
        rows.push({
          service: svc.service,
          month: mk,
          provider_bill: svc.billed[i],
          recovered: svc.recovered[i],
          vacant_absorbed: svc.vacant[i],
          common_deduction: svc.common[i],
          recovery_rate: svc.billed[i] ? (Number(svc.recovered[i]) / Number(svc.billed[i])) * 100 : 0,
          __href: `/utilities/rubs?property=${p.property}`,
        });
      });
    }
    return {
      cols: [
        { key: 'service', label: 'Service' },
        { key: 'month', label: 'Month', kind: 'month' },
        { key: 'provider_bill', label: 'Provider bill', kind: 'money', total: true },
        { key: 'recovered', label: 'Recovered (RUBS)', kind: 'money', total: true },
        { key: 'vacant_absorbed', label: 'Vacant share', kind: 'money', total: true },
        { key: 'common_deduction', label: 'Common area', kind: 'money', total: true },
        { key: 'recovery_rate', label: 'Recovery', kind: 'pct' },
      ],
      rows,
      note: 'Recovery = resident RUBS billings ÷ provider invoice. Vacant + common shares stay property expense.',
    };
  },
});

registerReport({
  key: 'usage_expense_trends',
  name: 'Utility Usage & Expense Trends',
  category: 'Utilities, insurance & risk',
  describe: 'Provider cost and metered usage by service, month over month.',
  params: [PROP],
  perm: 'utilities:view',
  defaultGroup: 'service',
  run(ctx, p): ReportResult {
    const rows = q<any>(
      `SELECT service, usage_month, total_cents, usage_qty, rate_note FROM utility_provider_invoices
       WHERE property_id=? AND usage_month >= ? ORDER BY service, usage_month`,
      p.property, monthKey(addMonths(ctx.businessDate, -13)),
    ).map((r) => {
      const prior = q1<any>(
        `SELECT total_cents FROM utility_provider_invoices WHERE property_id=? AND service=? AND usage_month=?`,
        p.property, r.service, monthKey(addMonths(`${r.usage_month}-15`, -12)),
      );
      return {
        service: r.service,
        month: r.usage_month,
        cost: r.total_cents,
        usage: r.usage_qty,
        unit_rate: r.usage_qty ? Math.round(r.total_cents / r.usage_qty) : 0,
        yoy: prior?.total_cents ? ((r.total_cents - prior.total_cents) / prior.total_cents) * 100 : null,
        note: r.rate_note || '—',
        __href: `/utilities?property=${p.property}`,
      };
    });
    return {
      cols: [
        { key: 'service', label: 'Service' },
        { key: 'month', label: 'Month', kind: 'month' },
        { key: 'cost', label: 'Provider cost', kind: 'money', total: true },
        { key: 'usage', label: 'Usage', kind: 'num' },
        { key: 'unit_rate', label: 'Cost / unit', kind: 'money' },
        { key: 'yoy', label: 'YoY', kind: 'pct' },
        { key: 'note', label: 'Rate note' },
      ],
      rows,
    };
  },
});

registerReport({
  key: 'vacant_recovery',
  name: 'Vacant Unit Cost Recovery',
  category: 'Utilities, insurance & risk',
  describe: 'Utility cost absorbed by vacant units, per unit and month.',
  params: [PROP],
  perm: 'utilities:view',
  run(ctx, p): ReportResult {
    const r = recoveryReport(ctx, p.property!, 6);
    const rows = r.vacantDetail.map((v) => ({
      month: v.month,
      unit: v.unit,
      service: v.service,
      absorbed: v.amount,
      vacancy: v.days,
      __href: `/utilities/recovery?property=${p.property}`,
    }));
    return {
      cols: [
        { key: 'month', label: 'Month', kind: 'month' },
        { key: 'unit', label: 'Unit' },
        { key: 'service', label: 'Service' },
        { key: 'absorbed', label: 'Property-paid share', kind: 'money', total: true },
        { key: 'vacancy', label: 'Vacant days' },
      ],
      rows,
      note: 'Vacant shares never bill to residents — they surface here as a cost-of-vacancy metric.',
    };
  },
});

registerReport({
  key: 'insurance_compliance',
  name: 'Insurance Compliance',
  category: 'Utilities, insurance & risk',
  describe: 'Coverage state of every active lease: verified, master-enrolled, lapsing, lapsed.',
  params: [{ ...PROP, allowAll: true }],
  perm: 'insurance:view',
  defaultGroup: 'state',
  run(ctx, p): ReportResult {
    const { sql, params } = propScope(ctx, p.property!, 'l.property_id');
    const leases = q<any>(
      `SELECT l.id, l.household_name, u.unit_number, p2.name AS prop FROM leases l
       JOIN units u ON u.id=l.unit_id JOIN properties p2 ON p2.id=l.property_id
       WHERE l.org_id=?${sql} AND l.status IN ('active','month_to_month','notice')`,
      ctx.orgId, ...params,
    );
    const rows = leases.map((l) => {
      const pol = q1<any>(
        `SELECT * FROM insurance_policies WHERE lease_id=? AND status IN ('active','lapsing') ORDER BY end_date DESC LIMIT 1`, l.id,
      );
      const lapsed = q1<any>(`SELECT id FROM insurance_policies WHERE lease_id=? AND status='lapsed'`, l.id);
      const state = pol
        ? pol.status === 'lapsing' ? 'lapsing' : pol.kind === 'master' ? 'master policy' : 'third-party verified'
        : lapsed ? 'lapsed' : 'no coverage on file';
      return {
        state,
        property: l.prop,
        unit: l.unit_number,
        household: l.household_name,
        carrier: pol?.carrier || '—',
        liability: pol?.liability_cents ?? null,
        expires: pol?.end_date || '—',
        __href: `/insurance?state=all`,
      };
    });
    return {
      cols: [
        { key: 'state', label: 'Coverage', kind: 'badge' },
        { key: 'property', label: 'Property' },
        { key: 'unit', label: 'Unit' },
        { key: 'household', label: 'Household' },
        { key: 'carrier', label: 'Carrier' },
        { key: 'liability', label: 'Liability', kind: 'money' },
        { key: 'expires', label: 'Expires' },
      ],
      rows,
      note: 'Lapsed leases auto-enroll into the master policy when the org toggle is on.',
    };
  },
});

registerReport({
  key: 'dep_alt_guaranty',
  name: 'Deposit Alternative & Guaranty Portfolio',
  category: 'Utilities, insurance & risk',
  describe: 'Surety enrollments, coverage in force, claims paid, and guaranty contracts.',
  params: [{ ...PROP, allowAll: true }],
  perm: 'insurance:view',
  defaultGroup: 'product',
  run(ctx, p): ReportResult {
    const { sql, params } = propScope(ctx, p.property!, 'da.property_id');
    const alts = q<any>(
      `SELECT da.*, l.household_name, u.unit_number, p2.name AS prop FROM deposit_alternatives da
       JOIN leases l ON l.id=da.lease_id JOIN units u ON u.id=l.unit_id JOIN properties p2 ON p2.id=da.property_id
       WHERE da.org_id=?${sql} ORDER BY da.enrolled_date DESC`,
      ctx.orgId, ...params,
    );
    const { sql: gSql, params: gParams } = propScope(ctx, p.property!, 'gc.property_id');
    const guaranties = q<any>(
      `SELECT gc.*, p2.name AS prop, COALESCE(l.household_name, 'application ' || substr(gc.application_id, -6)) AS household, u.unit_number
       FROM guaranty_contracts gc JOIN properties p2 ON p2.id=gc.property_id
       LEFT JOIN leases l ON l.id=gc.lease_id LEFT JOIN units u ON u.id=l.unit_id
       WHERE gc.org_id=?${gSql} ORDER BY gc.created_at DESC`,
      ctx.orgId, ...gParams,
    );
    const rows = [
      ...alts.map((a) => ({
        product: 'Deposit alternative',
        property: a.prop,
        unit: a.unit_number,
        household: a.household_name,
        detail: `${a.mode} · ${a.provider}`,
        monthly_or_fee: a.fee_cents,
        coverage: a.coverage_cents,
        claims: a.claim_cents || 0,
        status: a.status,
        __href: '/risk',
      })),
      ...guaranties.map((g) => ({
        product: 'Guaranty',
        property: g.prop,
        unit: g.unit_number || '—',
        household: g.household,
        detail: `${g.provider} · ${g.coverage_months} months coverage`,
        monthly_or_fee: g.fee_cents,
        coverage: null,
        claims: 0,
        status: g.status,
        __href: '/risk',
      })),
    ];
    return {
      cols: [
        { key: 'product', label: 'Product' },
        { key: 'property', label: 'Property' },
        { key: 'unit', label: 'Unit' },
        { key: 'household', label: 'Household' },
        { key: 'detail', label: 'Terms' },
        { key: 'monthly_or_fee', label: 'Fee', kind: 'money' },
        { key: 'coverage', label: 'Coverage', kind: 'money', total: true },
        { key: 'claims', label: 'Claims paid', kind: 'money', total: true },
        { key: 'status', label: 'Status', kind: 'badge' },
      ],
      rows,
    };
  },
});
