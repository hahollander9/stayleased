import { html, when, join } from '../../lib/html.ts';
import { notFound, redirect, type Router } from '../../lib/http.ts';
import { requirePerm, can, propFilter, type Ctx } from '../../lib/auth.ts';
import { q, q1, val, j } from '../../lib/db.ts';
import { fmtDate, fmtMonth, monthKey, addMonths } from '../../lib/dates.ts';
import { usd, parseUsd } from '../../lib/money.ts';
import { getSetting } from '../../lib/settings.ts';
import {
  shell, card, tbl, dl, statusBadge, field, select, input, textarea, moneyInput,
  registerNav, kpis, tabs, emptyState,
} from '../../ui/ui.ts';
import { lines as lineChart, bars } from '../../lib/charts.ts';
import {
  ensureCompSets, generateCompObservations, compAverage, runPricingEngine,
  decideRecommendation, acceptAll, termRateMatrix, expirationLoad, runRenewalBatch,
  revenueAnalytics, type Factor,
} from './service.ts';

/** M13 screens: daily pricing review queue with transparent factor breakdowns,
 * comp positioning, term-rate matrix with expiration smoothing, renewal batch
 * pricing, revenue analytics, and the full price-change audit trail. */

registerNav('Intelligence', { href: '/pricing', label: 'Pricing', perm: 'pricing:view', match: ['/pricing'] });

function propsFor(ctx: Ctx): any[] {
  const pf = propFilter(ctx, 'id');
  return q<any>(`SELECT id, name FROM properties WHERE org_id=?${pf.sql} ORDER BY name`, ctx.orgId, ...pf.params);
}

function factorList(factors: Factor[]): ReturnType<typeof html> {
  if (!factors.length) return html`<span class="muted">no adjustments</span>`;
  return html`<ul class="factor-list" style="margin:0;padding-left:16px">${factors.map(
    (f) => html`<li><span class="${f.delta_cents > 0 ? 'pos' : f.delta_cents < 0 ? 'neg' : 'muted'}" style="font-variant-numeric:tabular-nums">${f.delta_cents >= 0 ? '+' : '−'}${usd(Math.abs(f.delta_cents))}</span> — ${f.label}</li>`,
  )}</ul>`;
}

function pricingTabs(active: string): ReturnType<typeof tabs> {
  return tabs([
    { href: '/pricing', label: 'Review queue', active: active === 'queue' },
    { href: '/pricing/terms', label: 'Term rates', active: active === 'terms' },
    { href: '/pricing/renewals', label: 'Renewal batch', active: active === 'renewals' },
    { href: '/pricing/comps', label: 'Comp market', active: active === 'comps' },
    { href: '/pricing/analytics', label: 'Revenue analytics', active: active === 'analytics' },
    { href: '/pricing/changes', label: 'Change history', active: active === 'history' },
  ]);
}

export function routes(r: Router): void {
  // ---------- daily review queue ----------
  r.get('/pricing', requirePerm('pricing:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const props = propsFor(ctx);
    const propId = rq.query.get('property') || '';
    const pf = propId ? ' AND pr.property_id=?' : '';
    const pend = q<any>(
      `SELECT pr.*, u.unit_number, u.status AS unit_status, p.name AS prop, f.name AS fp
       FROM price_recommendations pr
       JOIN units u ON u.id=pr.unit_id LEFT JOIN floorplans f ON f.id=u.floorplan_id
       JOIN properties p ON p.id=pr.property_id
       WHERE pr.org_id=? AND pr.status='pending' AND pr.term_months=12${pf}
       ORDER BY p.name, u.unit_number`,
      ...(propId ? [ctx.orgId, propId] : [ctx.orgId]),
    );
    const decidedToday = val<number>(
      `SELECT COUNT(*) FROM price_recommendations WHERE org_id=? AND date(decided_at)=? AND term_months=12`,
      ctx.orgId, ctx.businessDate,
    ) || 0;
    const netMove = pend.reduce((s, p) => s + (p.recommended_rent_cents - p.current_rent_cents), 0);
    const up = pend.filter((p) => p.recommended_rent_cents > p.current_rent_cents).length;
    const down = pend.filter((p) => p.recommended_rent_cents < p.current_rent_cents).length;
    const canApprove = can(ctx, 'pricing:approve');
    return shell(rq, {
      title: 'Pricing review queue',
      active: '/pricing',
      subtitle: 'Every recommendation shows its factors — accept, override with a reason, or reject. Accepted prices update quotes and the marketing site instantly.',
      actions: html`${when(canApprove, () => html`
        <form method="post" action="/pricing/run" style="display:inline">
          <button class="btn btn-ghost" type="submit">Run engine now</button>
        </form>
        ${when(pend.length > 0, () => html`<form method="post" action="/pricing/accept-all" style="display:inline">
          <input type="hidden" name="property" value="${propId}" />
          <button class="btn" type="submit" data-confirm="Accept all ${pend.length} pending recommendations?">Accept all</button>
        </form>`)}`)}`,
      content: html`
        ${pricingTabs('queue')}
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Property', select('property', props.map((p): [string, string] => [p.id, p.name]), propId, { blank: 'All properties' }))}
        </form>
        ${kpis([
          { label: 'Awaiting review', value: String(pend.length), tone: pend.length ? 'warn' : 'ok' },
          { label: 'Suggested up / down', value: `${up} ↑ · ${down} ↓` },
          { label: 'Net monthly move if all accepted', value: usd(netMove), tone: netMove >= 0 ? 'ok' : 'warn' },
          { label: 'Decided today', value: String(decidedToday) },
        ])}
        ${pend.length === 0
          ? emptyState('Queue is clear', 'The nightly pricing engine stages new recommendations for vacant and on-notice units each morning.')
          : join(pend.map((p) => {
              const factors = j<Factor[]>(p.factors, []);
              const delta = p.recommended_rent_cents - p.current_rent_cents;
              return card(
                html`<a href="/units/${p.unit_id}">${p.prop} · ${p.unit_number}</a> <span class="muted small">${p.fp || ''} · ${String(p.unit_status).replaceAll('_', ' ')}</span>`,
                html`<div class="split" style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
                  <div style="min-width:230px">
                    ${dl([
                      ['Current asking', usd(p.current_rent_cents)],
                      ['Recommended', html`<b>${usd(p.recommended_rent_cents)}</b> <span class="${delta >= 0 ? 'pos' : 'neg'}">(${delta >= 0 ? '+' : '−'}${usd(Math.abs(delta))})</span>`],
                      ['As of', fmtDate(p.date)],
                    ])}
                  </div>
                  <div style="flex:1;min-width:260px">
                    <div class="small muted" style="margin-bottom:4px">Why the engine suggests this:</div>
                    ${factorList(factors)}
                  </div>
                  ${when(canApprove, () => html`<div style="min-width:280px">
                    <form method="post" action="/pricing/${p.id}/decide" style="display:flex;gap:8px;margin-bottom:8px">
                      <input type="hidden" name="action" value="accept" />
                      <button class="btn" type="submit">Accept ${usd(p.recommended_rent_cents)}</button>
                    </form>
                    <form method="post" action="/pricing/${p.id}/decide" class="stack" style="display:grid;gap:6px">
                      <input type="hidden" name="action" value="override" />
                      ${field('Override amount', moneyInput('amount', p.recommended_rent_cents))}
                      ${field('Reason (required for overrides)', input('reason', { placeholder: 'e.g. unit backs the parking garage' }))}
                      <div style="display:flex;gap:8px">
                        <button class="btn btn-ghost" type="submit">Override</button>
                        <button class="btn btn-ghost" type="submit" formaction="/pricing/${p.id}/decide?reject=1">Reject</button>
                      </div>
                    </form>
                  </div>`)}
                </div>`,
              );
            }))}`,
    });
  });

  r.post('/pricing/run', requirePerm('pricing:approve'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const n = runPricingEngine(ctx, ctx.businessDate);
    return redirect('/pricing', n ? `Engine staged ${n} recommendation${n === 1 ? '' : 's'}` : 'No pricing moves suggested today');
  });

  r.post('/pricing/accept-all', requirePerm('pricing:approve'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const body = rq.body!;
    const n = acceptAll(ctx, body.property || null);
    return redirect('/pricing', `${n} recommendation${n === 1 ? '' : 's'} accepted — quotes and the website now show the new prices`);
  });

  r.post('/pricing/:id/decide', requirePerm('pricing:approve'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const body = rq.body!;
    const action = rq.query.get('reject') ? 'reject' : (body.action as 'accept' | 'override');
    try {
      decideRecommendation(ctx, rq.params.id!, action, {
        amountCents: body.amount ? parseUsd(body.amount) : undefined,
        reason: body.reason,
      });
    } catch (e) {
      return redirect('/pricing', (e as Error).message, 'err');
    }
    const msg = action === 'accept' ? 'Accepted — asking rent updated everywhere'
      : action === 'override' ? 'Overridden — your amount is now the asking rent' : 'Rejected';
    return redirect('/pricing', msg);
  });

  // ---------- term-rate matrix + expiration smoothing ----------
  r.get('/pricing/terms', requirePerm('pricing:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const props = propsFor(ctx);
    const propId = rq.query.get('property') || props[0]?.id;
    const units = q<any>(
      `SELECT u.id, u.unit_number FROM units u WHERE u.property_id=? AND (u.status LIKE 'vacant%' OR EXISTS (
         SELECT 1 FROM leases l WHERE l.unit_id=u.id AND l.status IN ('notice','active')))
       ORDER BY u.unit_number`,
      propId,
    );
    const unitId = rq.query.get('unit') || units[0]?.id;
    const unit = unitId ? q1<any>('SELECT * FROM units WHERE id=?', unitId) : null;
    const matrix = unit ? termRateMatrix(ctx, unit, ctx.businessDate) : [];
    // expiration calendar for the next 15 months
    const load = expirationLoad(ctx, propId);
    const months: string[] = [];
    for (let i = 0; i < 15; i++) months.push(monthKey(addMonths(ctx.businessDate, i)));
    const counts = [...load.entries()].filter(([mk]) => months.includes(mk)).map(([, n]) => n);
    const p75 = [...load.values()].sort((a, b) => a - b)[Math.floor(load.size * 0.75)] || 10;
    return shell(rq, {
      title: 'Term rates & expiration smoothing',
      active: '/pricing',
      subtitle: 'Lease terms are priced to steer expirations away from over-loaded months — heavy months carry a premium, light months a discount.',
      content: html`
        ${pricingTabs('terms')}
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Property', select('property', props.map((p): [string, string] => [p.id, p.name]), propId))}
          ${field('Unit', select('unit', units.map((u): [string, string] => [u.id, u.unit_number]), unitId))}
        </form>
        ${card(`Expiration calendar — next 15 months`, html`
          ${bars(months.map((mk) => ({
            label: fmtMonth(mk),
            value: load.get(mk) || 0,
            tone: (load.get(mk) || 0) >= p75 ? 'bad' : (load.get(mk) || 0) <= 2 ? 'ok' : 'accent',
          })), { maxBars: 15 })}
          <div class="small muted">Red months are at/above the 75th percentile of expirations — the matrix prices terms landing there higher to spread renewals out.</div>`)}
        ${when(unit, () => card(
          html`Term-rate matrix — unit ${unit.unit_number} <span class="muted small">(base ${usd(unit.market_rent_cents)})</span>`,
          tbl(
            [{ label: 'Term' }, { label: 'Expires' }, { label: 'Expiration load' }, { label: 'Adjustment', num: true }, { label: 'Monthly rent', num: true }],
            matrix.map((t) => ({
              cells: [
                html`<b>${t.term} months</b>`,
                fmtMonth(t.expiresMonth),
                statusBadge(t.loadFactor === 'high' ? 'overdue' : t.loadFactor === 'low' ? 'ok' : 'normal', `${t.loadFactor} (${expirationLoad(ctx, propId).get(t.expiresMonth) || 0} leases)`),
                html`<span class="${t.adj >= 0 ? '' : 'pos'}">${t.adj >= 0 ? '+' : ''}${t.adj}%</span>`,
                html`<b>${usd(t.rent)}</b>`,
              ],
            })),
          ),
        ))}`,
    });
  });

  // ---------- renewal batch ----------
  r.get('/pricing/renewals', requirePerm('pricing:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const props = propsFor(ctx);
    const propId = rq.query.get('property') || props[0]?.id;
    const windowDays = 120;
    const expiring = q<any>(
      `SELECT l.*, u.unit_number, u.market_rent_cents AS market FROM leases l JOIN units u ON u.id=l.unit_id
       WHERE l.property_id=? AND l.status='active' AND l.end_date BETWEEN ? AND ?
       ORDER BY l.end_date`,
      propId, ctx.businessDate, `${monthKey(addMonths(ctx.businessDate, 4))}-28`,
    );
    const capPct = getSetting<number>(ctx, 'renewal_max_increase_pct', propId);
    const priced = q<any>(
      `SELECT pr.*, u.unit_number FROM price_recommendations pr JOIN units u ON u.id=pr.unit_id
       WHERE pr.property_id=? AND pr.decided_by='renewal batch' AND pr.date>=?
       ORDER BY u.unit_number, pr.term_months DESC`,
      propId, ctx.businessDate,
    );
    const byUnit = new Map<string, any[]>();
    for (const p of priced) byUnit.set(p.unit_number, [...(byUnit.get(p.unit_number) || []), p]);
    return shell(rq, {
      title: 'Renewal batch pricing',
      active: '/pricing',
      subtitle: `Prices every lease expiring in the next ${windowDays} days across four terms — capped at the org's max renewal increase (${capPct ?? '—'}%). Renewal offers pull these rates automatically.`,
      actions: when(can(ctx, 'pricing:approve'), () => html`<form method="post" action="/pricing/renewals/run">
        <input type="hidden" name="property" value="${propId}" />
        <button class="btn" type="submit">Price expiring leases</button>
      </form>`),
      content: html`
        ${pricingTabs('renewals')}
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Property', select('property', props.map((p): [string, string] => [p.id, p.name]), propId))}
        </form>
        ${kpis([
          { label: `Expiring within ${windowDays} days`, value: String(expiring.length) },
          { label: 'Units priced this batch', value: String(byUnit.size), tone: byUnit.size ? 'ok' : 'warn' },
          { label: 'Org renewal cap', value: capPct !== undefined && capPct !== null ? `${capPct}%` : '—', sub: 'max increase vs current rent' },
        ])}
        ${byUnit.size === 0
          ? card('Batch results', emptyState('No batch priced yet today', 'Run the batch to stage capped, term-smoothed renewal rates for every expiring lease.'))
          : card('Batch results — accepted renewal rates by term', tbl(
              [{ label: 'Unit' }, { label: 'Current rent', num: true }, { label: '15 mo', num: true }, { label: '12 mo', num: true }, { label: '9 mo', num: true }, { label: '6 mo', num: true }, { label: 'Cap applied?' }],
              [...byUnit.entries()].map(([unitNo, rows]) => {
                const cur = rows[0]!.current_rent_cents;
                const term = (t: number): any => rows.find((x) => x.term_months === t);
                const capped = rows.some((x) => (j<Factor[]>(x.factors, [])).some((f) => f.label.includes('org cap')));
                const cell = (t: number): ReturnType<typeof html> => {
                  const row = term(t);
                  if (!row) return html`<span class="muted">—</span>`;
                  const inc = row.accepted_rent_cents - cur;
                  return html`${usd(row.accepted_rent_cents)} <span class="small ${inc > 0 ? 'muted' : 'pos'}">(${inc >= 0 ? '+' : ''}${((inc / cur) * 100).toFixed(1)}%)</span>`;
                };
                return { cells: [html`<b>${unitNo}</b>`, usd(cur), cell(15), cell(12), cell(9), cell(6), capped ? statusBadge('hold', 'capped') : html`<span class="muted">no</span>`] };
              }),
            ))}
        ${card('Leases in the window', tbl(
          [{ label: 'Unit' }, { label: 'Household' }, { label: 'Ends' }, { label: 'Current rent', num: true }, { label: 'Asking (market)', num: true }],
          expiring.map((l) => ({
            href: `/leases/${l.id}`,
            cells: [l.unit_number, l.household_name, fmtDate(l.end_date), usd(l.rent_cents), usd(l.market)],
          })),
          { empty: 'Nothing expiring in the window.' },
        ))}`,
    });
  });

  r.post('/pricing/renewals/run', requirePerm('pricing:approve'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const body = rq.body!;
    const n = runRenewalBatch(ctx, body.property!);
    return redirect(`/pricing/renewals?property=${body.property}`, `${n} term rates staged — renewal offers now quote these prices`);
  });

  // ---------- comp market ----------
  r.get('/pricing/comps', requirePerm('pricing:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    ensureCompSets(ctx.orgId);
    const props = propsFor(ctx);
    const propId = rq.query.get('property') || props[0]?.id;
    const comps = q<any>('SELECT * FROM comp_sets WHERE property_id=? AND active=1 ORDER BY distance_miles', propId);
    const bedsList = q<any>('SELECT DISTINCT beds FROM floorplans WHERE property_id=? ORDER BY beds', propId).map((x) => x.beds as number);
    const beds = Number(rq.query.get('beds') ?? bedsList[Math.min(1, bedsList.length - 1)] ?? 1);
    const months: string[] = [];
    for (let i = 13; i >= 0; i--) months.push(monthKey(addMonths(ctx.businessDate, -i)));
    const ourSeries = months.map((m) => val<number>(
      `SELECT AVG(market_rent_cents) FROM floorplans WHERE property_id=? AND beds=?`, propId, beds,
    ) || 0);
    const compSeries = months.map((m) => Math.round(compAverage(ctx.orgId, propId!, beds, m) || 0));
    const latest = q<any>(
      `SELECT o.*, c.name, c.distance_miles FROM comp_observations o JOIN comp_sets c ON c.id=o.comp_id
       WHERE c.property_id=? AND o.month_key=? ORDER BY o.beds, c.distance_miles`,
      propId, months[months.length - 1],
    );
    const ourNow = ourSeries[ourSeries.length - 1] || 0;
    const compNow = compSeries[compSeries.length - 1] || 0;
    const gapPct = compNow ? Math.round(((ourNow - compNow) / compNow) * 1000) / 10 : 0;
    return shell(rq, {
      title: 'Comp market positioning',
      active: '/pricing',
      subtitle: 'Deterministic market simulator — nearby communities drift ~3.2%/yr with seasonal swings. The engine prices against this set.',
      content: html`
        ${pricingTabs('comps')}
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Property', select('property', props.map((p): [string, string] => [p.id, p.name]), propId))}
          ${field('Bedrooms', select('beds', bedsList.map((b): [string, string] => [String(b), b === 0 ? 'Studio' : `${b} BR`]), String(beds)))}
        </form>
        ${kpis([
          { label: `Our avg asking (${beds === 0 ? 'studio' : `${beds} BR`})`, value: usd(ourNow) },
          { label: 'Comp set avg', value: usd(compNow) },
          { label: 'Position vs market', value: `${gapPct >= 0 ? '+' : ''}${gapPct}%`, tone: Math.abs(gapPct) <= 5 ? 'ok' : 'warn', sub: 'engine nudges when |gap| > 5%' },
          { label: 'Active comps', value: String(comps.length) },
        ])}
        ${card('Us vs the comp set — trailing 14 months', lineChart(
          months.map((m) => fmtMonth(m).slice(0, 3)),
          [
            { name: 'Our asking', tone: 'accent', points: ourSeries },
            { name: 'Comp set avg', tone: 'warn', points: compSeries },
          ],
          { money: true, height: 210 },
        ))}
        ${card(`Latest observations — ${fmtMonth(months[months.length - 1]!)}`, tbl(
          [{ label: 'Community' }, { label: 'Distance' }, { label: 'Beds' }, { label: 'Observed rent', num: true }, { label: 'Concessions' }],
          latest.map((o) => ({
            cells: [o.name, `${o.distance_miles} mi`, o.beds === 0 ? 'Studio' : `${o.beds} BR`, usd(o.rent_cents), o.concession_note || html`<span class="muted">none noted</span>`],
          })),
        ))}
        ${card('Comp set', tbl(
          [{ label: 'Community' }, { label: 'Distance' }, { label: 'Year built' }],
          comps.map((c) => ({ cells: [c.name, `${c.distance_miles} mi`, String(c.year_built || '—')] })),
        ))}`,
    });
  });

  // ---------- revenue analytics ----------
  r.get('/pricing/analytics', requirePerm('pricing:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const props = propsFor(ctx);
    const propId = rq.query.get('property') || props[0]?.id;
    const a = revenueAnalytics(ctx, propId!);
    const tradeTbl = (rows: { unit: string; prior: number; next: number }[], empty: string): ReturnType<typeof tbl> =>
      tbl(
        [{ label: 'Unit' }, { label: 'Prior rent', num: true }, { label: 'New rent', num: true }, { label: 'Trade-out', num: true }],
        rows.map((t) => {
          const pct = t.prior ? ((t.next - t.prior) / t.prior) * 100 : 0;
          return { cells: [t.unit, usd(t.prior), usd(t.next), html`<span class="${pct >= 0 ? 'pos' : 'neg'}">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</span>`] };
        }),
        { empty },
      );
    return shell(rq, {
      title: 'Revenue analytics',
      active: '/pricing',
      subtitle: 'Loss-to-lease, trade-outs and effective rent — how pricing decisions land in the rent roll.',
      content: html`
        ${pricingTabs('analytics')}
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Property', select('property', props.map((p): [string, string] => [p.id, p.name]), propId))}
        </form>
        ${kpis([
          { label: 'In-place avg rent', value: usd(a.lossToLease.inPlace) },
          { label: 'Market avg asking', value: usd(a.lossToLease.market) },
          { label: 'Loss to lease', value: `${a.lossToLease.gapPct}%`, sub: `${usd(a.lossToLease.gapCents)}/unit/mo`, tone: a.lossToLease.gapPct > 6 ? 'warn' : 'ok' },
          { label: 'Concessions (12 mo)', value: usd(a.concessions), tone: 'accent' },
        ])}
        ${card('Effective in-place rent trend (avg monthly rent charge)', lineChart(
          a.effectiveRentTrend.map((t) => fmtMonth(t.month).slice(0, 3)),
          [{ name: 'Avg rent charged', tone: 'accent', points: a.effectiveRentTrend.map((t) => t.cents) }],
          { money: true, height: 190 },
        ))}
        <div class="grid-2" style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
          ${card('New-lease trade-outs (last 12)', tradeTbl(a.newTradeOuts, 'No completed turnovers yet.'))}
          ${card('Renewal trade-outs (last 12)', tradeTbl(a.renewalTradeOuts, 'No renewals executed yet.'))}
        </div>`,
    });
  });

  // ---------- change history ----------
  r.get('/pricing/changes', requirePerm('pricing:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const pf = propFilter(ctx, 'pc.property_id');
    const rows = q<any>(
      `SELECT pc.*, u.unit_number, p.name AS prop FROM price_changes pc
       JOIN units u ON u.id=pc.unit_id JOIN properties p ON p.id=pc.property_id
       WHERE pc.org_id=?${pf.sql} ORDER BY pc.created_at DESC LIMIT 200`,
      ctx.orgId, ...pf.params,
    );
    return shell(rq, {
      title: 'Price change history',
      active: '/pricing',
      subtitle: 'Every asking-rent change with who, when, source and reason — the audit trail behind the rent roll.',
      content: html`
        ${pricingTabs('history')}
        ${tbl(
          [{ label: 'Date' }, { label: 'Property' }, { label: 'Unit' }, { label: 'From', num: true }, { label: 'To', num: true }, { label: 'Move', num: true }, { label: 'Source' }, { label: 'By' }, { label: 'Reason' }],
          rows.map((c) => {
            const d = c.new_cents - c.old_cents;
            return {
              href: `/units/${c.unit_id}`,
              cells: [
                fmtDate(c.date), c.prop, c.unit_number, usd(c.old_cents), usd(c.new_cents),
                html`<span class="${d >= 0 ? 'pos' : 'neg'}">${d >= 0 ? '+' : '−'}${usd(Math.abs(d))}</span>`,
                statusBadge(c.source === 'pricing_queue' ? 'accepted' : c.source, c.source.replaceAll('_', ' ')),
                c.changed_by || '—', c.reason || html`<span class="muted">—</span>`,
              ],
            };
          }),
          { empty: 'No price changes recorded yet.' },
        )}`,
    });
  });
}
