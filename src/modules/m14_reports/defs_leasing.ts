import { q, q1, val } from '../../lib/db.ts';
import { addMonths } from '../../lib/dates.ts';
import { registerReport, propScope, type ReportResult } from './engine.ts';
import { funnelStats } from '../m3_crm/service.ts';

/** §10 Leasing & marketing: Funnel by Source, Source ROI, Agent Productivity,
 * Application Pipeline & Screening Outcomes, Pricing Change History,
 * Concession Usage. */

const PROP = { key: 'property', kind: 'property' as const };

registerReport({
  key: 'funnel_by_source',
  name: 'Traffic & Conversion Funnel by Source',
  category: 'Leasing & marketing',
  describe: 'Inquiry → tour → application → lease conversion for every source.',
  params: [PROP, { key: 'from', kind: 'from', default: (ctx) => addMonths(ctx.businessDate, -3) }],
  defaultSort: 'inquiries',
  defaultDir: 'desc',
  run(ctx, p): ReportResult {
    const f = funnelStats(ctx, p.from!, p.property);
    const rows = f.bySource.map((s) => ({
      source: s.source,
      inquiries: s.inquiries,
      tours: s.tours,
      apps: s.apps,
      leases: s.leases,
      tour_rate: s.inquiries ? (s.tours / s.inquiries) * 100 : 0,
      close_rate: s.inquiries ? (s.leases / s.inquiries) * 100 : 0,
      __href: '/leasing/analytics',
    }));
    return {
      cols: [
        { key: 'source', label: 'Source' },
        { key: 'inquiries', label: 'Inquiries', kind: 'num', total: true },
        { key: 'tours', label: 'Tours', kind: 'num', total: true },
        { key: 'apps', label: 'Applications', kind: 'num', total: true },
        { key: 'leases', label: 'Leases', kind: 'num', total: true },
        { key: 'tour_rate', label: 'Tour rate', kind: 'pct' },
        { key: 'close_rate', label: 'Close rate', kind: 'pct' },
      ],
      rows,
      note: `Leads created since ${p.from}. Overall: ${f.inquiries} → ${f.toured} toured → ${f.applied} applied → ${f.leased} leased.`,
    };
  },
});

registerReport({
  key: 'source_roi',
  name: 'Marketing Source ROI',
  category: 'Leasing & marketing',
  describe: 'Campaign spend vs signed leases — cost per lead and per lease.',
  params: [PROP, { key: 'from', kind: 'from', default: (ctx) => addMonths(ctx.businessDate, -3) }],
  defaultSort: 'cost_per_lease',
  run(ctx, p): ReportResult {
    const f = funnelStats(ctx, p.from!, p.property);
    const rows = f.bySource.map((s) => ({
      source: s.source,
      spend: s.costCents,
      inquiries: s.inquiries,
      leases: s.leases,
      cost_per_lead: s.inquiries ? Math.round(s.costCents / s.inquiries) : 0,
      cost_per_lease: s.leases ? Math.round(s.costCents / s.leases) : 0,
      first_year_value: s.leases * 12 * (val<number>(
        `SELECT AVG(rent_cents) FROM leases WHERE org_id=? AND status IN ('active','notice')${p.property && p.property !== 'all' ? ' AND property_id=?' : ''}`,
        ctx.orgId, ...(p.property && p.property !== 'all' ? [p.property] : []),
      ) || 0),
      __href: '/leasing/analytics',
    }));
    return {
      cols: [
        { key: 'source', label: 'Source' },
        { key: 'spend', label: 'Spend (period)', kind: 'money', total: true },
        { key: 'inquiries', label: 'Leads', kind: 'num', total: true },
        { key: 'leases', label: 'Leases', kind: 'num', total: true },
        { key: 'cost_per_lead', label: 'Cost / lead', kind: 'money' },
        { key: 'cost_per_lease', label: 'Cost / lease', kind: 'money' },
        { key: 'first_year_value', label: 'Est. 1st-year rent', kind: 'money' },
      ],
      rows,
      note: 'Spend = active campaign monthly cost × months in range. Organic sources carry no spend.',
    };
  },
});

registerReport({
  key: 'agent_productivity',
  name: 'Leasing Agent Productivity',
  category: 'Leasing & marketing',
  describe: 'Leads worked, response time, tours and closes per agent.',
  params: [PROP, { key: 'from', kind: 'from', default: (ctx) => addMonths(ctx.businessDate, -3) }],
  defaultSort: 'closes',
  defaultDir: 'desc',
  run(ctx, p): ReportResult {
    const f = funnelStats(ctx, p.from!, p.property);
    const rows = f.agents.map((a) => ({
      agent: a.name,
      leads: a.leads,
      tours: a.tours,
      closes: a.closes,
      close_rate: a.leads ? (a.closes / a.leads) * 100 : 0,
      avg_first_response_h: a.avgResponseHours,
    }));
    return {
      cols: [
        { key: 'agent', label: 'Agent' },
        { key: 'leads', label: 'Leads', kind: 'num', total: true },
        { key: 'tours', label: 'Tours', kind: 'num', total: true },
        { key: 'closes', label: 'Leases', kind: 'num', total: true },
        { key: 'close_rate', label: 'Close rate', kind: 'pct' },
        { key: 'avg_first_response_h', label: 'Avg first response (h)', kind: 'num' },
      ],
      rows,
    };
  },
});

registerReport({
  key: 'application_pipeline',
  name: 'Application Pipeline & Screening Outcomes',
  category: 'Leasing & marketing',
  describe: 'Applications by status plus screening result mix and decision outcomes.',
  params: [{ ...PROP, allowAll: true }],
  defaultGroup: 'section',
  run(ctx, p): ReportResult {
    const { sql, params } = propScope(ctx, p.property!, 'a.property_id');
    const rows: ReportResult['rows'] = [];
    for (const s of q<any>(
      `SELECT a.status, COUNT(*) n FROM applications a WHERE a.org_id=?${sql} GROUP BY a.status ORDER BY n DESC`,
      ctx.orgId, ...params,
    )) {
      rows.push({ section: 'Pipeline', metric: s.status.replaceAll('_', ' '), count: s.n, __href: `/applications?status=${s.status}` });
    }
    for (const s of q<any>(
      `SELECT COALESCE(a.recommendation,'(not screened)') rec, COUNT(*) n FROM applications a WHERE a.org_id=?${sql} AND a.submitted_at IS NOT NULL GROUP BY rec ORDER BY n DESC`,
      ctx.orgId, ...params,
    )) {
      rows.push({ section: 'Screening recommendation', metric: s.rec.replaceAll('_', ' '), count: s.n });
    }
    for (const s of q<any>(
      `SELECT COALESCE(a.decision,'(undecided)') d, COUNT(*) n FROM applications a WHERE a.org_id=?${sql} AND a.submitted_at IS NOT NULL GROUP BY d ORDER BY n DESC`,
      ctx.orgId, ...params,
    )) {
      rows.push({ section: 'Decision', metric: s.d.replaceAll('_', ' '), count: s.n });
    }
    const bands = q<any>(
      `SELECT sr.credit_band, COUNT(*) n FROM screening_reports sr JOIN applications a ON a.id=sr.application_id
       WHERE sr.org_id=?${sql} AND sr.status='complete' GROUP BY sr.credit_band ORDER BY n DESC`,
      ctx.orgId, ...params,
    );
    for (const b of bands) rows.push({ section: 'Credit bands (completed reports)', metric: b.credit_band || 'thin file', count: b.n });
    return {
      cols: [
        { key: 'section', label: 'Section' },
        { key: 'metric', label: 'Bucket', kind: 'badge' },
        { key: 'count', label: 'Count', kind: 'num', total: true },
      ],
      rows,
    };
  },
});

registerReport({
  key: 'pricing_changes',
  name: 'Pricing Change History',
  category: 'Leasing & marketing',
  describe: 'Every asking-rent change: source, decider and written reason.',
  params: [{ ...PROP, allowAll: true }, { key: 'from', kind: 'from', default: (ctx) => addMonths(ctx.businessDate, -2) }, { key: 'to', kind: 'to' }],
  run(ctx, p): ReportResult {
    const { sql, params } = propScope(ctx, p.property!, 'pc.property_id');
    const rows = q<any>(
      `SELECT pc.*, u.unit_number, p2.name AS prop FROM price_changes pc
       JOIN units u ON u.id=pc.unit_id JOIN properties p2 ON p2.id=pc.property_id
       WHERE pc.org_id=?${sql} AND pc.date BETWEEN ? AND ? ORDER BY pc.date DESC, pc.created_at DESC`,
      ctx.orgId, ...params, p.from, p.to,
    ).map((c) => ({
      date: c.date,
      property: c.prop,
      unit: c.unit_number,
      from_rent: c.old_cents,
      to_rent: c.new_cents,
      move: c.new_cents - c.old_cents,
      source: c.source,
      by: c.changed_by || '—',
      reason: c.reason || '—',
      __href: `/units/${c.unit_id}`,
    }));
    return {
      cols: [
        { key: 'date', label: 'Date', kind: 'date' },
        { key: 'property', label: 'Property' },
        { key: 'unit', label: 'Unit' },
        { key: 'from_rent', label: 'From', kind: 'money' },
        { key: 'to_rent', label: 'To', kind: 'money' },
        { key: 'move', label: 'Move', kind: 'money', total: true },
        { key: 'source', label: 'Source', kind: 'badge' },
        { key: 'by', label: 'By' },
        { key: 'reason', label: 'Reason' },
      ],
      rows,
    };
  },
});

registerReport({
  key: 'concession_usage',
  name: 'Concession Usage',
  category: 'Leasing & marketing',
  describe: 'Concession credits granted by month and property, with per-lease detail.',
  params: [{ ...PROP, allowAll: true }, { key: 'from', kind: 'from', default: (ctx) => addMonths(ctx.businessDate, -6) }, { key: 'to', kind: 'to' }],
  defaultGroup: 'month',
  run(ctx, p): ReportResult {
    const { sql, params } = propScope(ctx, p.property!, 'c.property_id');
    const rows = q<any>(
      `SELECT substr(c.date,1,7) AS month, c.date, c.label, c.amount_cents, l.household_name, u.unit_number, p2.name AS prop, c.lease_id
       FROM charges c JOIN leases l ON l.id=c.lease_id JOIN units u ON u.id=l.unit_id JOIN properties p2 ON p2.id=c.property_id
       WHERE c.org_id=?${sql} AND c.kind='concession' AND c.status='active' AND c.date BETWEEN ? AND ?
       ORDER BY c.date DESC`,
      ctx.orgId, ...params, p.from, p.to,
    ).map((c) => ({
      month: c.month,
      date: c.date,
      property: c.prop,
      unit: c.unit_number,
      household: c.household_name,
      label: c.label,
      credit: -c.amount_cents,
      __href: `/leases/${c.lease_id}`,
    }));
    return {
      cols: [
        { key: 'month', label: 'Month', kind: 'month' },
        { key: 'date', label: 'Date', kind: 'date' },
        { key: 'property', label: 'Property' },
        { key: 'unit', label: 'Unit' },
        { key: 'household', label: 'Household' },
        { key: 'label', label: 'Concession' },
        { key: 'credit', label: 'Credit', kind: 'money', total: true },
      ],
      rows,
      note: 'Credit shown positive; posts as negative rent-income charges (docs/metrics.md).',
    };
  },
});
