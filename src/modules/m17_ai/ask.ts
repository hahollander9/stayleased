import { q, q1, val } from '../../lib/db.ts';
import { addMonths, monthKey, fmtMonth, fmtDate } from '../../lib/dates.ts';
import { usd, parseUsd } from '../../lib/money.ts';
import type { Ctx } from '../../lib/auth.ts';
import { propFilter } from '../../lib/auth.ts';
import { propose } from './framework.ts';
import { agingRows } from '../m8_receivables/service.ts';
import { receivablesStats } from '../m8_receivables/payments.ts';
import { computeDayMetrics } from '../m14_reports/snapshots.ts';
import { reportDefs } from '../m14_reports/engine.ts';

/** M17.7 "Ask Oriel": staff questions answered over the org's own data by
 * calling the same service-layer read APIs the screens use — the model never
 * writes SQL. Every answer is an audited ai_action. */

export interface AskAnswer {
  title: string;
  summary: string;
  table?: { cols: string[]; rows: (string | number)[][]; hrefs?: (string | null)[] };
  links: { label: string; href: string }[];
  matched: string; // which handler answered
}

function matchProperty(ctx: Ctx, question: string): { id: string; name: string } | null {
  const pf = propFilter(ctx, 'id');
  const props = q<any>(`SELECT id, name, slug FROM properties WHERE org_id=?${pf.sql}`, ctx.orgId, ...pf.params);
  const ql = question.toLowerCase();
  for (const p of props) {
    const words = String(p.name).toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
    if (words.some((w: string) => ql.includes(w)) || ql.includes(p.slug)) return p;
  }
  return null;
}

type Handler = (ctx: Ctx, question: string) => AskAnswer | null;

const HANDLERS: Handler[] = [
  // delinquency over $X (at property)
  (ctx, question) => {
    if (!/delinquen|owe|past due|balance/i.test(question)) return null;
    const money = /(?:over|above|more than|>)\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i.exec(question);
    const floor = money ? parseUsd(money[1]!) : 0;
    const prop = matchProperty(ctx, question);
    const rows = agingRows(ctx, { propertyId: prop?.id || null }).filter((a) => a.balance >= floor);
    const total = rows.reduce((s, a) => s + a.balance, 0);
    return {
      title: `Delinquency${floor ? ` over ${usd(floor)}` : ''}${prop ? ` at ${prop.name}` : ''}`,
      summary: `${rows.length} household${rows.length === 1 ? '' : 's'} owing ${usd(total)} total${floor ? ` (each ≥ ${usd(floor)})` : ''}, as of ${fmtDate(ctx.businessDate)}.`,
      table: {
        cols: ['Household', 'Unit', 'Property', 'Balance', 'Oldest bucket'],
        rows: rows.slice(0, 12).map((a) => [
          a.household_name, a.unit_number, a.property_name, usd(a.balance),
          a.d90p ? '90+' : a.d61_90 ? '61-90' : a.d31_60 ? '31-60' : a.d1_30 ? '1-30' : 'current',
        ]),
        hrefs: rows.slice(0, 12).map((a) => `/delinquency/${a.lease_id}`),
      },
      links: [{ label: 'Delinquency workbench', href: '/delinquency' }, { label: 'Aged receivables report', href: '/reports/delinquency_aged' }],
      matched: 'delinquency',
    };
  },
  // units turning / expiring this|next month
  (ctx, question) => {
    if (!/turn|expir|ending|end this|end next|move.?outs?/i.test(question)) return null;
    const next = /next month/i.test(question);
    const mk = monthKey(addMonths(ctx.businessDate, next ? 1 : 0));
    const prop = matchProperty(ctx, question);
    const pf = prop ? ' AND l.property_id=?' : propFilter(ctx, 'l.property_id').sql;
    const params = prop ? [prop.id] : propFilter(ctx, 'l.property_id').params;
    const leases = q<any>(
      `SELECT l.id, l.household_name, l.end_date, l.status, u.unit_number, p.name AS prop FROM leases l
       JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=l.property_id
       WHERE l.org_id=? AND substr(l.end_date,1,7)=? AND l.status IN ('active','notice')${pf} ORDER BY l.end_date`,
      ctx.orgId, mk, ...params,
    );
    const turns = val<number>(
      `SELECT COUNT(*) FROM turns t WHERE t.org_id=? AND t.status NOT IN ('completed','canceled')${prop ? ' AND t.property_id=?' : ''}`,
      ctx.orgId, ...(prop ? [prop.id] : []),
    ) || 0;
    return {
      title: `Turning in ${fmtMonth(mk)}${prop ? ` — ${prop.name}` : ''}`,
      summary: `${leases.length} lease${leases.length === 1 ? '' : 's'} end${leases.length === 1 ? 's' : ''} in ${fmtMonth(mk)}${leases.filter((l) => l.status === 'notice').length ? ` (${leases.filter((l) => l.status === 'notice').length} already on notice)` : ''}. ${turns} turn board${turns === 1 ? '' : 's'} currently in flight.`,
      table: {
        cols: ['Unit', 'Household', 'Ends', 'Status'],
        rows: leases.slice(0, 12).map((l) => [l.unit_number, l.household_name, fmtDate(l.end_date), l.status]),
        hrefs: leases.slice(0, 12).map((l) => `/leases/${l.id}`),
      },
      links: [{ label: 'Expiration schedule report', href: '/reports/lease_expirations' }, { label: 'Turn board', href: '/turns' }],
      matched: 'expirations',
    };
  },
  // occupancy / exposure
  (ctx, question) => {
    if (!/occupanc|exposure|vacan|how full/i.test(question)) return null;
    const prop = matchProperty(ctx, question);
    const pf = propFilter(ctx, 'id');
    const props = prop ? [prop] : q<any>(`SELECT id, name FROM properties WHERE org_id=?${pf.sql}`, ctx.orgId, ...pf.params);
    const rows = props.map((p: any) => {
      const m = computeDayMetrics(ctx, p.id, ctx.businessDate);
      return { name: p.name, m };
    });
    const occ = rows.reduce((s: number, r: any) => s + r.m.occupied, 0);
    const rentable = rows.reduce((s: number, r: any) => s + r.m.rentable, 0) || 1;
    return {
      title: `Occupancy${prop ? ` — ${prop.name}` : ' — portfolio'}`,
      summary: `${Math.round((occ / rentable) * 1000) / 10}% physical occupancy (${occ}/${rentable} units) as of ${fmtDate(ctx.businessDate)}.`,
      table: {
        cols: ['Property', 'Occupied', 'Rentable', 'Occupancy', 'Exposure', 'On notice'],
        rows: rows.map((r: any) => [r.name, r.m.occupied, r.m.rentable, `${r.m.occupancy_pct}%`, `${r.m.exposure_pct}%`, r.m.notice]),
      },
      links: [{ label: 'Occupancy trend report', href: '/reports/occupancy_trend' }, { label: 'Unit board', href: '/units' }],
      matched: 'occupancy',
    };
  },
  // collection rate
  (ctx, question) => {
    if (!/collect|on.?time/i.test(question)) return null;
    const last = /last month/i.test(question);
    const mk = monthKey(addMonths(ctx.businessDate, last ? -1 : 0));
    const prop = matchProperty(ctx, question);
    const s = receivablesStats(ctx, mk, prop?.id || null);
    return {
      title: `Collections — ${fmtMonth(mk)}${prop ? ` at ${prop.name}` : ''}`,
      summary: `${s.collectionRate}% collected (${usd(s.collected)} of ${usd(s.billed)} billed); ${s.onTimePct}% of rent on time; NSF rate ${s.nsfRate}%.`,
      links: [{ label: 'Collection rate report', href: '/reports/collection_rate' }, { label: 'Receivables analytics', href: '/receivables' }],
      matched: 'collections',
    };
  },
  // pricing queue
  (ctx, question) => {
    if (!/pricing|recommendation|price rec/i.test(question)) return null;
    const pend = q<any>(
      `SELECT pr.recommended_rent_cents - pr.current_rent_cents AS d, p.name FROM price_recommendations pr
       JOIN properties p ON p.id=pr.property_id WHERE pr.org_id=? AND pr.status='pending' AND pr.term_months=12`,
      ctx.orgId,
    );
    return {
      title: 'Pricing queue',
      summary: `${pend.length} recommendation${pend.length === 1 ? '' : 's'} awaiting review; net ${usd(pend.reduce((s2: number, x: any) => s2 + x.d, 0))}/mo if all accepted.`,
      links: [{ label: 'Review queue', href: '/pricing' }, { label: 'Change history', href: '/pricing/changes' }],
      matched: 'pricing',
    };
  },
  // work orders / maintenance backlog
  (ctx, question) => {
    if (!/work order|maintenance|backlog|repairs?/i.test(question)) return null;
    const prop = matchProperty(ctx, question);
    const pf = prop ? ' AND wo.property_id=?' : propFilter(ctx, 'wo.property_id').sql;
    const params = prop ? [prop.id] : propFilter(ctx, 'wo.property_id').params;
    const rows = q<any>(
      `SELECT wo.priority, COUNT(*) n FROM work_orders wo WHERE wo.org_id=? AND wo.status NOT IN ('completed','canceled')${pf} GROUP BY wo.priority ORDER BY n DESC`,
      ctx.orgId, ...params,
    );
    const total = rows.reduce((s: number, r: any) => s + r.n, 0);
    return {
      title: `Open maintenance${prop ? ` — ${prop.name}` : ''}`,
      summary: `${total} open work order${total === 1 ? '' : 's'}: ${rows.map((r: any) => `${r.n} ${r.priority}`).join(', ') || 'none'}.`,
      links: [{ label: 'Work orders', href: '/workorders' }, { label: 'SLA report', href: '/reports/wo_sla' }],
      matched: 'workorders',
    };
  },
  // top vendor spend
  (ctx, question) => {
    if (!/vendor|spend|paid the most/i.test(question)) return null;
    const rows = q<any>(
      `SELECT v.name, SUM(ap.amount_cents) paid FROM ap_payments ap JOIN vendors v ON v.id=ap.vendor_id
       JOIN ap_payment_runs r ON r.id=ap.run_id
       WHERE ap.org_id=? AND ap.status != 'void' AND r.run_date >= ? GROUP BY v.id ORDER BY paid DESC LIMIT 6`,
      ctx.orgId, addMonths(ctx.businessDate, -3),
    );
    return {
      title: 'Vendor spend — trailing 3 months',
      summary: rows.length ? `Top vendor: ${rows[0].name} at ${usd(rows[0].paid)}.` : 'No vendor payments in the window.',
      table: { cols: ['Vendor', 'Paid (3mo)'], rows: rows.map((r: any) => [r.name, usd(r.paid)]) },
      links: [{ label: 'Vendor payment register', href: '/reports/vendor_payments' }, { label: 'Spend analytics', href: '/purchasing/spend' }],
      matched: 'vendors',
    };
  },
];

export function askOriel(ctx: Ctx, question: string): AskAnswer {
  let answer: AskAnswer | null = null;
  for (const h of HANDLERS) {
    answer = h(ctx, question);
    if (answer) break;
  }
  if (!answer) {
    const ql = question.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const matches = reportDefs()
      .filter((d) => ql.some((w) => `${d.name} ${d.describe}`.toLowerCase().includes(w)))
      .slice(0, 5);
    answer = {
      title: 'I could not answer that directly',
      summary: matches.length
        ? 'These reports look closest to what you asked — or try phrasing like "delinquency over $500 at Summit Ridge", "which units turn this month", "occupancy at Foundry".'
        : 'Try questions like "delinquency over $500 at Summit Ridge", "which units turn this month", "occupancy at Foundry", "collection rate last month", "open work orders", "top vendor spend".',
      links: matches.map((d) => ({ label: d.name, href: `/reports/${d.key}` })),
      matched: 'fallback',
    };
  }
  propose(ctx, {
    agent: 'ask',
    title: `Q: ${question.slice(0, 70)}`,
    input: { question },
    output: { kind: 'noop.analysis', matched: answer.matched, summary: answer.summary },
    confidence: answer.matched === 'fallback' ? 0.5 : 0.95,
  });
  return answer;
}
