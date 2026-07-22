import { q, q1, val } from '../../lib/db.ts';
import { addMonths, monthKey } from '../../lib/dates.ts';
import { registerReport, monthsBack, type ReportResult } from './engine.ts';
import { revenueAnalytics } from '../m13_pricing/service.ts';
import { computeDayMetrics, snapshotSeries } from './snapshots.ts';

/** §10 Portfolio/exec: Portfolio KPI Comparison, Economic vs Physical
 * Occupancy, Revenue Analytics, Resident Retention & Satisfaction, AI
 * Activity & Outcomes. */

const PROP = { key: 'property', kind: 'property' as const };

registerReport({
  key: 'portfolio_kpis',
  name: 'Portfolio KPI Comparison',
  category: 'Portfolio & executive',
  describe: 'Every property side by side: occupancy, exposure, delinquency, rents, work.',
  params: [],
  run(ctx): ReportResult {
    const props = q<any>(`SELECT id, name FROM properties WHERE org_id=? ORDER BY name`, ctx.orgId);
    const rows = props.map((p2) => {
      const m = computeDayMetrics(ctx, p2.id, ctx.businessDate);
      const noi = val<number>(
        `SELECT COALESCE(SUM(jl.credit_cents - jl.debit_cents),0) FROM journal_lines jl
         JOIN journal_entries je ON je.id=jl.entry_id
         JOIN gl_accounts ga ON ga.org_id=jl.org_id AND ga.code=jl.account_code
         WHERE jl.org_id=? AND jl.property_id=? AND je.basis='accrual' AND ga.type IN ('income','expense')
           AND je.date >= ?`,
        ctx.orgId, p2.id, `${monthKey(addMonths(ctx.businessDate, -11))}-01`,
      ) || 0;
      return {
        property: p2.name,
        units: m.rentable,
        occupancy: m.occupancy_pct,
        exposure: m.exposure_pct,
        delinquent: m.delinquent_cents,
        avg_inplace: m.avg_inplace_rent_cents,
        avg_market: m.avg_market_rent_cents,
        loss_to_lease: m.avg_market_rent_cents ? ((m.avg_market_rent_cents - m.avg_inplace_rent_cents) / m.avg_market_rent_cents) * 100 : 0,
        open_wos: m.open_wos,
        noi_t12: noi,
        __href: `/properties/${p2.id}`,
      };
    });
    return {
      cols: [
        { key: 'property', label: 'Property' },
        { key: 'units', label: 'Units', kind: 'num', total: true },
        { key: 'occupancy', label: 'Occupancy', kind: 'pct' },
        { key: 'exposure', label: 'Exposure', kind: 'pct' },
        { key: 'delinquent', label: 'Delinquent', kind: 'money', total: true },
        { key: 'avg_inplace', label: 'Avg in-place', kind: 'money' },
        { key: 'avg_market', label: 'Avg asking', kind: 'money' },
        { key: 'loss_to_lease', label: 'Loss to lease', kind: 'pct' },
        { key: 'open_wos', label: 'Open WOs', kind: 'num', total: true },
        { key: 'noi_t12', label: 'NOI (T-12)', kind: 'money', total: true },
      ],
      rows,
      note: 'Live as of the business date; NOI is accrual-basis trailing 12 months.',
    };
  },
});

registerReport({
  key: 'econ_vs_physical',
  name: 'Economic vs Physical Occupancy',
  category: 'Portfolio & executive',
  describe: 'Physical occupancy vs the share of gross potential rent actually collected.',
  params: [PROP],
  run(ctx, p): ReportResult {
    const gpr = val<number>(`SELECT COALESCE(SUM(market_rent_cents),0) FROM units WHERE property_id=? AND status NOT IN ('model','down')`, p.property) || 1;
    const series = snapshotSeries(ctx, p.property!, 13);
    const rows = monthsBack(ctx, 12).map((mk) => {
      const snap = series.find((s) => monthKey(s.date) === mk);
      const rentBilled = val<number>(
        `SELECT COALESCE(SUM(amount_cents),0) FROM charges WHERE property_id=? AND kind IN ('rent','mtm_premium') AND status='active' AND month_key=?`,
        p.property, mk,
      ) || 0;
      const collected = val<number>(
        `SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE property_id=? AND status IN ('pending','settled') AND substr(received_date,1,7)=?`,
        p.property, mk,
      ) || 0;
      const concessions = val<number>(
        `SELECT COALESCE(SUM(-amount_cents),0) FROM charges WHERE property_id=? AND kind='concession' AND status='active' AND month_key=?`,
        p.property, mk,
      ) || 0;
      return {
        month: mk,
        physical: snap?.m.occupancy_pct ?? null,
        gpr,
        rent_billed: rentBilled,
        concessions,
        collected,
        economic: Math.min(150, (collected / gpr) * 100),
        __href: `/receivables?month=${mk}&property=${p.property}`,
      };
    });
    return {
      cols: [
        { key: 'month', label: 'Month', kind: 'month' },
        { key: 'physical', label: 'Physical occ.', kind: 'pct' },
        { key: 'gpr', label: 'Gross potential', kind: 'money' },
        { key: 'rent_billed', label: 'Rent billed', kind: 'money', total: true },
        { key: 'concessions', label: 'Concessions', kind: 'money', total: true },
        { key: 'collected', label: 'All cash collected', kind: 'money', total: true },
        { key: 'economic', label: 'Economic occ.', kind: 'pct' },
      ],
      rows,
      note: 'Economic occupancy = total cash collected ÷ gross potential rent at today\'s asking rents (docs/metrics.md); collections include utilities/fees so hot months can exceed 100%.',
    };
  },
});

registerReport({
  key: 'revenue_analytics',
  name: 'Revenue Analytics',
  category: 'Portfolio & executive',
  describe: 'Loss-to-lease, trade-outs and effective rent from the M13 engine.',
  params: [PROP],
  perm: 'pricing:view',
  run(ctx, p): ReportResult {
    const a = revenueAnalytics(ctx, p.property!);
    const rows: ReportResult['rows'] = [
      ...a.effectiveRentTrend.map((t) => ({
        section: 'Effective in-place rent by month',
        label: t.month,
        value: t.cents,
        detail: '—',
      })),
      ...a.newTradeOuts.map((t) => ({
        section: 'New-lease trade-outs',
        label: t.unit,
        value: t.next,
        detail: `${t.prior ? (((t.next - t.prior) / t.prior) * 100).toFixed(1) : '—'}% vs prior ${(t.prior / 100).toFixed(0)}`,
      })),
      ...a.renewalTradeOuts.map((t) => ({
        section: 'Renewal trade-outs',
        label: t.unit,
        value: t.next,
        detail: `${t.prior ? (((t.next - t.prior) / t.prior) * 100).toFixed(1) : '—'}% vs prior ${(t.prior / 100).toFixed(0)}`,
      })),
    ];
    return {
      cols: [
        { key: 'section', label: 'Section' },
        { key: 'label', label: 'Month / Unit' },
        { key: 'value', label: 'Rent', kind: 'money' },
        { key: 'detail', label: 'Detail' },
      ],
      rows,
      note: `Loss to lease: in-place ${(a.lossToLease.inPlace / 100).toFixed(0)} vs market ${(a.lossToLease.market / 100).toFixed(0)} → ${a.lossToLease.gapPct}%. Concessions trailing 12mo: $${(a.concessions / 100).toFixed(0)}. Full interactive view at /pricing/analytics.`,
    };
  },
  defaultGroup: 'section',
});

registerReport({
  key: 'retention',
  name: 'Resident Retention & Satisfaction',
  category: 'Portfolio & executive',
  describe: 'Renewal retention by month plus maintenance satisfaction ratings.',
  params: [{ ...PROP, allowAll: true }],
  run(ctx, p): ReportResult {
    const scope = p.property === 'all' ? '' : ' AND l.property_id=?';
    const scopeParams = p.property === 'all' ? [] : [p.property];
    const rows = monthsBack(ctx, 12).map((mk) => {
      const reached = q<any>(
        `SELECT l.id, l.status FROM leases l WHERE l.org_id=?${scope} AND substr(l.end_date,1,7)=? AND l.status IN ('renewed','ended','month_to_month')`,
        ctx.orgId, ...scopeParams, mk,
      );
      const renewed = reached.filter((l) => l.status === 'renewed').length;
      const held = reached.filter((l) => l.status === 'month_to_month').length;
      const moved = reached.filter((l) => l.status === 'ended').length;
      const rating = val<number>(
        `SELECT AVG(wo.rating) FROM work_orders wo WHERE wo.org_id=? AND wo.rating IS NOT NULL AND substr(wo.completed_date,1,7)=?${p.property === 'all' ? '' : ' AND wo.property_id=?'}`,
        ctx.orgId, mk, ...scopeParams,
      );
      return {
        month: mk,
        expirations: reached.length,
        renewed,
        holdover_mtm: held,
        moved_out: moved,
        retention: reached.length ? ((renewed + held) / reached.length) * 100 : null,
        wo_rating: rating ? Math.round(rating * 10) / 10 : null,
        __href: '/renewals',
      };
    });
    return {
      cols: [
        { key: 'month', label: 'Expirations in', kind: 'month' },
        { key: 'expirations', label: 'Leases reaching end', kind: 'num', total: true },
        { key: 'renewed', label: 'Renewed', kind: 'num', total: true },
        { key: 'holdover_mtm', label: 'Went MTM', kind: 'num', total: true },
        { key: 'moved_out', label: 'Moved out', kind: 'num', total: true },
        { key: 'retention', label: 'Retention', kind: 'pct' },
        { key: 'wo_rating', label: 'Avg WO rating (of 5)', kind: 'num' },
      ],
      rows,
      note: 'Retention counts renewals + MTM holdovers as retained. Satisfaction = resident ratings on completed work orders.',
    };
  },
});

registerReport({
  key: 'ai_activity',
  name: 'AI & Automation Activity',
  category: 'Portfolio & executive',
  describe: 'What the platform did on its own: job runs, automated sends, engine decisions.',
  params: [{ key: 'from', kind: 'from', default: (ctx) => addMonths(ctx.businessDate, -1) }, { key: 'to', kind: 'to' }],
  defaultGroup: 'kind',
  run(ctx, p): ReportResult {
    const rows: ReportResult['rows'] = [];
    for (const jr of q<any>(
      `SELECT job_key, COUNT(*) runs, SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) ok, MAX(date) last
       FROM job_runs WHERE org_id=? AND date BETWEEN ? AND ? GROUP BY job_key ORDER BY runs DESC`,
      ctx.orgId, p.from, p.to,
    )) {
      rows.push({
        kind: 'Scheduled jobs',
        what: jr.job_key.replaceAll('_', ' '),
        volume: jr.runs,
        outcome: `${jr.ok}/${jr.runs} ok · last ${jr.last}`,
        __href: '/admin/jobs',
      });
    }
    for (const t of q<any>(
      `SELECT template_key, COUNT(*) n FROM outbox_messages
       WHERE org_id=? AND business_date BETWEEN ? AND ? AND template_key IS NOT NULL AND template_key != ''
       GROUP BY template_key ORDER BY n DESC LIMIT 20`,
      ctx.orgId, p.from, p.to,
    )) {
      rows.push({
        kind: 'Automated messages',
        what: t.template_key.replaceAll('_', ' '),
        volume: t.n,
        outcome: 'delivered to Message Console',
        __href: `/dev/messages?template=${t.template_key}`,
      });
    }
    const recs = q1<any>(
      `SELECT COUNT(*) n, SUM(CASE WHEN status IN ('accepted','overridden') THEN 1 ELSE 0 END) decided
       FROM price_recommendations WHERE org_id=? AND date BETWEEN ? AND ? AND term_months=12`,
      ctx.orgId, p.from, p.to,
    );
    if (recs?.n) {
      rows.push({
        kind: 'Pricing engine',
        what: 'unit price recommendations staged',
        volume: recs.n,
        outcome: `${recs.decided} human-decided`,
        __href: '/pricing',
      });
    }
    return {
      cols: [
        { key: 'kind', label: 'Automation' },
        { key: 'what', label: 'What ran' },
        { key: 'volume', label: 'Volume', kind: 'num', total: true },
        { key: 'outcome', label: 'Outcome' },
      ],
      rows,
      note: 'Every automated action is deterministic, auditable, and human-supervisable. ELI-style AI agents (M17) land in Phase 16 and will report here alongside the jobs.',
    };
  },
});
