import { q, q1, val, j } from '../../lib/db.ts';
import { addDays, addMonths, monthKey, fmtMonth } from '../../lib/dates.ts';
import type { Ctx } from '../../lib/auth.ts';
import { registerReport, propScope, monthsBack, type ReportResult } from './engine.ts';
import { rentRollAsOf, agingAsOf, occupancyAt } from './asof.ts';
import { snapshotSeries } from './snapshots.ts';

/** §10 Operations: Box Score, Rent Roll (as-of), Availability & Exposure,
 * Lease Expiration Schedule, Renewal Summary, Move Register, Notice & Turn
 * Status, Occupancy Trend. */

const PROP = { key: 'property', kind: 'property' as const };

registerReport({
  key: 'box_score',
  name: 'Box Score',
  category: 'Operations',
  describe: 'Traffic, leasing and occupancy on one page for a date range.',
  params: [PROP, { key: 'from', kind: 'from', default: (ctx) => addDays(ctx.businessDate, -27) }, { key: 'to', kind: 'to' }],
  defaultGroup: 'section',
  run(ctx, p): ReportResult {
    const { sql, params } = propScope(ctx, p.property!, 'property_id');
    const between = ' BETWEEN ? AND ?';
    const count = (table: string, dateCol: string, extra = ''): number =>
      val<number>(`SELECT COUNT(*) FROM ${table} WHERE org_id=?${sql} AND ${dateCol}${between}${extra}`, ctx.orgId, ...params, p.from, p.to) || 0;
    const occ = p.property === 'all'
      ? null
      : occupancyAt(ctx, p.property!, p.to!);
    const rows: ReportResult['rows'] = [];
    const add = (section: string, metric: string, value: string, href?: string): void => {
      rows.push({ section, metric, value, __href: href });
    };
    add('Traffic', 'New leads', String(count('leads', 'created_date')), '/leads');
    add('Traffic', 'Tours completed', String(count('tours', 'date', " AND status='completed'")), '/tours');
    add('Traffic', 'Tour no-shows', String(count('tours', 'date', " AND status='no_show'")));
    add('Leasing', 'Applications submitted', String(count('applications', 'date(submitted_at)')), '/applications');
    add('Leasing', 'Approved', String(count('applications', 'date(submitted_at)', " AND decision='approve'")));
    add('Leasing', 'Leases signed (executed)', String(count('leases', 'start_date', " AND status IN ('active','month_to_month','notice','renewed','ended')")));
    add('Leasing', 'Renewal offers accepted', String(count('renewal_offers', 'date(decided_at)', " AND status='accepted'")), '/renewals');
    add('Moves', 'Move-ins', String(count('leases', 'move_in_date')));
    add('Moves', 'Notices given', String(count('leases', 'notice_date')));
    add('Moves', 'Move-outs', String(count('leases', 'move_out_date')));
    if (occ) {
      add('Occupancy', 'Rentable units', String(occ.rentable), '/units');
      add('Occupancy', 'Occupied', `${occ.occupied} (${occ.occupancyPct}%)`);
      add('Occupancy', 'On notice', String(occ.notice));
      add('Occupancy', 'Vacant', String(occ.vacant));
      add('Occupancy', 'Exposure', `${occ.exposurePct}%`);
    } else {
      add('Occupancy', 'Scope', 'Pick a single property for the occupancy block');
    }
    return {
      cols: [
        { key: 'section', label: 'Section' },
        { key: 'metric', label: 'Metric' },
        { key: 'value', label: 'Value' },
      ],
      rows,
      note: `Range ${p.from} → ${p.to}. Definitions in docs/metrics.md.`,
    };
  },
});

registerReport({
  key: 'rent_roll',
  name: 'Rent Roll',
  category: 'Operations',
  describe: 'Every lease in possession as of any date — rent, deposit, balance. Reproducible historically.',
  params: [{ ...PROP, allowAll: true }, { key: 'date', kind: 'date' }],
  run(ctx, p): ReportResult {
    const propId = p.property === 'all' ? null : p.property!;
    const rows = (propId ? rentRollAsOf(ctx, propId, p.date!) : rentRollAsOf(ctx, null, p.date!)
      .filter((r) => propScopeOk(ctx, r.property_id)))
      .map((r) => ({
        property: r.property_name,
        unit: r.unit_number,
        floorplan: r.floorplan || '—',
        household: r.household_name,
        status: r.status_at,
        start: r.start_date,
        end: r.end_date,
        rent: r.rent_cents,
        deposit: r.deposit_cents,
        balance: r.balance_cents,
        __href: `/leases/${r.lease_id}`,
      }));
    return {
      cols: [
        { key: 'property', label: 'Property' },
        { key: 'unit', label: 'Unit' },
        { key: 'floorplan', label: 'Plan' },
        { key: 'household', label: 'Household' },
        { key: 'status', label: 'Status', kind: 'badge' },
        { key: 'start', label: 'Start', kind: 'date' },
        { key: 'end', label: 'End', kind: 'date' },
        { key: 'rent', label: 'Rent', kind: 'money', total: true },
        { key: 'deposit', label: 'Deposit held', kind: 'money', total: true },
        { key: 'balance', label: 'Balance', kind: 'money', total: true },
      ],
      rows,
      note: `As of ${p.date} — derived from effective-dated leases, charges and payments (docs/metrics.md).`,
    };
  },
});

function propScopeOk(ctx: Ctx, propertyId: string): boolean {
  return ctx.allProperties || ctx.propertyIds.includes(propertyId);
}

registerReport({
  key: 'availability_exposure',
  name: 'Unit Availability & Exposure',
  category: 'Operations',
  describe: 'Vacancy, notice and make-ready pipeline with days-vacant aging.',
  params: [PROP],
  defaultSort: 'days_vacant',
  defaultDir: 'desc',
  run(ctx, p): ReportResult {
    const units = q<any>(
      `SELECT u.*, f.name AS fp FROM units u LEFT JOIN floorplans f ON f.id=u.floorplan_id
       WHERE u.property_id=? AND (u.status LIKE 'vacant%' OR EXISTS (
         SELECT 1 FROM leases l WHERE l.unit_id=u.id AND l.status='notice'))
       ORDER BY u.unit_number`,
      p.property,
    );
    const rows = units.map((u) => {
      const lastEnd = val<string>(
        `SELECT MAX(COALESCE(move_out_date, end_date)) FROM leases WHERE unit_id=? AND status IN ('ended','renewed')`, u.id,
      );
      const notice = q1<any>(`SELECT end_date FROM leases WHERE unit_id=? AND status='notice'`, u.id);
      const futureLease = q1<any>(
        `SELECT start_date FROM leases WHERE unit_id=? AND status IN ('fully_executed','active') AND start_date > ?`, u.id, ctx.businessDate,
      );
      const daysVacant = u.status.startsWith('vacant') && lastEnd ? Math.max(0, Math.round((Date.parse(ctx.businessDate) - Date.parse(lastEnd)) / 86400000)) : 0;
      return {
        unit: u.unit_number,
        floorplan: u.fp || '—',
        status: notice ? 'notice' : u.status,
        available: notice ? notice.end_date : u.status === 'vacant_ready' ? 'now' : 'make-ready',
        days_vacant: daysVacant,
        market_rent: u.market_rent_cents,
        preleased: futureLease ? `yes — ${futureLease.start_date}` : 'no',
        __href: `/units/${u.id}`,
      };
    });
    const occ = occupancyAt(ctx, p.property!, ctx.businessDate);
    return {
      cols: [
        { key: 'unit', label: 'Unit' },
        { key: 'floorplan', label: 'Plan' },
        { key: 'status', label: 'Status', kind: 'badge' },
        { key: 'available', label: 'Available' },
        { key: 'days_vacant', label: 'Days vacant', kind: 'num' },
        { key: 'market_rent', label: 'Asking rent', kind: 'money', total: true },
        { key: 'preleased', label: 'Pre-leased' },
      ],
      rows,
      note: `Exposure ${occ.exposurePct}% (${occ.vacant} vacant + ${occ.notice} notice of ${occ.rentable} rentable).`,
    };
  },
});

registerReport({
  key: 'lease_expirations',
  name: 'Lease Expiration Schedule',
  category: 'Operations',
  describe: 'Expirations by month for the next 15 months with renewal status.',
  params: [PROP],
  defaultGroup: 'month',
  run(ctx, p): ReportResult {
    const horizon = monthKey(addMonths(ctx.businessDate, 15));
    const leases = q<any>(
      `SELECT l.*, u.unit_number FROM leases l JOIN units u ON u.id=l.unit_id
       WHERE l.property_id=? AND l.status IN ('active','notice') AND substr(l.end_date,1,7) <= ?
       ORDER BY l.end_date`,
      p.property, horizon,
    );
    const rows = leases.map((l) => {
      const offer = q1<any>(`SELECT status FROM renewal_offers WHERE lease_id=? ORDER BY created_at DESC`, l.id);
      return {
        month: monthKey(l.end_date),
        unit: l.unit_number,
        household: l.household_name,
        end: l.end_date,
        rent: l.rent_cents,
        renewal: offer?.status || 'not offered',
        __href: `/leases/${l.id}`,
      };
    });
    return {
      cols: [
        { key: 'month', label: 'Expires', kind: 'month' },
        { key: 'unit', label: 'Unit' },
        { key: 'household', label: 'Household' },
        { key: 'end', label: 'End date', kind: 'date' },
        { key: 'rent', label: 'Current rent', kind: 'money', total: true },
        { key: 'renewal', label: 'Renewal offer', kind: 'badge' },
      ],
      rows,
    };
  },
});

registerReport({
  key: 'renewal_summary',
  name: 'Renewal Summary',
  category: 'Operations',
  describe: 'Offers, acceptance rate and renewal trade-out by month.',
  params: [{ ...PROP, allowAll: true }],
  run(ctx, p): ReportResult {
    const { sql, params } = propScope(ctx, p.property!, 'ro.property_id');
    const rows = q<any>(
      `SELECT substr(ro.created_at,1,7) AS month,
              COUNT(*) AS offers,
              SUM(CASE WHEN ro.status='accepted' THEN 1 ELSE 0 END) AS accepted,
              SUM(CASE WHEN ro.status='declined' THEN 1 ELSE 0 END) AS declined,
              SUM(CASE WHEN ro.status='countered' THEN 1 ELSE 0 END) AS countered,
              SUM(CASE WHEN ro.status IN ('sent') THEN 1 ELSE 0 END) AS open
       FROM renewal_offers ro WHERE ro.org_id=?${sql}
       GROUP BY month ORDER BY month`,
      ctx.orgId, ...params,
    ).map((r) => {
      const tradeOut = q<any>(
        `SELECT AVG((next.rent_cents - prior.rent_cents) * 100.0 / prior.rent_cents) AS pct
         FROM renewal_offers ro JOIN leases next ON next.id=ro.new_lease_id JOIN leases prior ON prior.id=ro.lease_id
         WHERE ro.org_id=? AND substr(ro.created_at,1,7)=? AND ro.status='accepted'${sql.replaceAll('ro.property_id', 'ro.property_id')}`,
        ctx.orgId, r.month, ...params,
      )[0];
      return {
        month: r.month,
        offers: r.offers,
        accepted: r.accepted,
        declined: r.declined,
        countered: r.countered,
        open: r.open,
        acceptance: r.offers ? (r.accepted / r.offers) * 100 : 0,
        trade_out: tradeOut?.pct ?? null,
        __href: '/renewals',
      };
    });
    return {
      cols: [
        { key: 'month', label: 'Offered', kind: 'month' },
        { key: 'offers', label: 'Offers', kind: 'num', total: true },
        { key: 'accepted', label: 'Accepted', kind: 'num', total: true },
        { key: 'countered', label: 'Countered', kind: 'num', total: true },
        { key: 'declined', label: 'Declined', kind: 'num', total: true },
        { key: 'open', label: 'Open', kind: 'num', total: true },
        { key: 'acceptance', label: 'Acceptance', kind: 'pct' },
        { key: 'trade_out', label: 'Avg trade-out', kind: 'pct' },
      ],
      rows,
      note: 'Trade-out = rent change on accepted renewals vs the prior lease.',
    };
  },
});

registerReport({
  key: 'move_register',
  name: 'Move-In / Move-Out Register',
  category: 'Operations',
  describe: 'Every move-in and move-out in the range, with deposits and dispositions.',
  params: [{ ...PROP, allowAll: true }, { key: 'from', kind: 'from', default: (ctx) => addMonths(ctx.businessDate, -2) }, { key: 'to', kind: 'to' }],
  defaultGroup: 'event',
  run(ctx, p): ReportResult {
    const { sql, params } = propScope(ctx, p.property!, 'l.property_id');
    const ins = q<any>(
      `SELECT l.*, u.unit_number, p2.name AS prop FROM leases l JOIN units u ON u.id=l.unit_id JOIN properties p2 ON p2.id=l.property_id
       WHERE l.org_id=?${sql} AND l.move_in_date BETWEEN ? AND ? ORDER BY l.move_in_date`,
      ctx.orgId, ...params, p.from, p.to,
    );
    const outs = q<any>(
      `SELECT l.*, u.unit_number, p2.name AS prop FROM leases l JOIN units u ON u.id=l.unit_id JOIN properties p2 ON p2.id=l.property_id
       WHERE l.org_id=?${sql} AND l.move_out_date BETWEEN ? AND ? ORDER BY l.move_out_date`,
      ctx.orgId, ...params, p.from, p.to,
    );
    const rows = [
      ...ins.map((l) => ({
        event: 'Move-in', date: l.move_in_date, property: l.prop, unit: l.unit_number,
        household: l.household_name, rent: l.rent_cents, deposit: l.deposit_alternative ? 0 : l.deposit_cents,
        detail: l.renewal_of_lease_id ? 'renewal' : 'new lease', __href: `/leases/${l.id}`,
      })),
      ...outs.map((l) => {
        const dispo = val<number>(
          `SELECT SUM(-amount_cents) FROM deposit_activity WHERE lease_id=? AND kind IN ('apply','refund')`, l.id,
        );
        return {
          event: 'Move-out', date: l.move_out_date, property: l.prop, unit: l.unit_number,
          household: l.household_name, rent: l.rent_cents, deposit: l.deposit_cents,
          detail: dispo ? 'disposition posted' : 'disposition pending', __href: `/leases/${l.id}`,
        };
      }),
    ].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return {
      cols: [
        { key: 'event', label: 'Event', kind: 'badge' },
        { key: 'date', label: 'Date', kind: 'date' },
        { key: 'property', label: 'Property' },
        { key: 'unit', label: 'Unit' },
        { key: 'household', label: 'Household' },
        { key: 'rent', label: 'Rent', kind: 'money' },
        { key: 'deposit', label: 'Deposit', kind: 'money' },
        { key: 'detail', label: 'Detail' },
      ],
      rows,
    };
  },
});

registerReport({
  key: 'notice_turn_status',
  name: 'Notice & Turn Status',
  category: 'Operations',
  describe: 'Every notice on file and every turn in flight, with target-ready risk.',
  params: [PROP],
  run(ctx, p): ReportResult {
    const notices = q<any>(
      `SELECT l.*, u.unit_number FROM leases l JOIN units u ON u.id=l.unit_id
       WHERE l.property_id=? AND l.status='notice' ORDER BY l.end_date`,
      p.property,
    );
    const turns = q<any>(
      `SELECT t.*, u.unit_number FROM turns t JOIN units u ON u.id=t.unit_id
       WHERE t.property_id=? AND t.status NOT IN ('completed','canceled') ORDER BY t.target_ready_date`,
      p.property,
    );
    const rows = [
      ...notices.map((l) => ({
        stage: 'notice', unit: l.unit_number, household: l.household_name,
        key_date: l.end_date, detail: `moves out ${l.end_date}`, at_risk: '—', __href: `/leases/${l.id}`,
      })),
      ...turns.map((t) => ({
        stage: `turn: ${t.status}`, unit: t.unit_number, household: '—',
        key_date: t.target_ready_date,
        detail: t.next_move_in_date ? `next move-in ${t.next_move_in_date}` : 'no next lease yet',
        at_risk: t.target_ready_date < ctx.businessDate ? 'LATE' : t.next_move_in_date && t.target_ready_date > t.next_move_in_date ? 'AT RISK' : 'on track',
        __href: '/turns',
      })),
    ];
    return {
      cols: [
        { key: 'stage', label: 'Stage', kind: 'badge' },
        { key: 'unit', label: 'Unit' },
        { key: 'household', label: 'Household' },
        { key: 'key_date', label: 'Key date', kind: 'date' },
        { key: 'detail', label: 'Detail' },
        { key: 'at_risk', label: 'Risk' },
      ],
      rows,
    };
  },
});

registerReport({
  key: 'occupancy_trend',
  name: 'Occupancy Trend',
  category: 'Operations',
  describe: 'Month-end physical occupancy, exposure and delinquency from MetricSnapshot rollups.',
  params: [PROP],
  run(ctx, p): ReportResult {
    const series = snapshotSeries(ctx, p.property!, 15);
    const rows = series.map((s) => ({
      date: s.date,
      occupied: s.m.occupied,
      rentable: s.m.rentable,
      occupancy: s.m.occupancy_pct,
      exposure: s.m.exposure_pct,
      notice: s.m.notice,
      delinquent: s.m.delinquent_cents,
      avg_inplace: s.m.avg_inplace_rent_cents,
      open_wos: s.m.open_wos,
    }));
    return {
      cols: [
        { key: 'date', label: 'Snapshot', kind: 'date' },
        { key: 'occupied', label: 'Occupied', kind: 'num' },
        { key: 'rentable', label: 'Rentable', kind: 'num' },
        { key: 'occupancy', label: 'Occupancy', kind: 'pct' },
        { key: 'exposure', label: 'Exposure', kind: 'pct' },
        { key: 'notice', label: 'Notices', kind: 'num' },
        { key: 'delinquent', label: 'Delinquent', kind: 'money' },
        { key: 'avg_inplace', label: 'Avg in-place rent', kind: 'money' },
        { key: 'open_wos', label: 'Open WOs', kind: 'num' },
      ],
      rows,
      note: 'Month-end MetricSnapshot rollups; today\'s row is refreshed by the nightly job.',
    };
  },
});
