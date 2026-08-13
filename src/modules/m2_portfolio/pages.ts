import { onboardingBanner } from '../setup/onboarding.ts';
import { marketingHome } from '../m4_marketing/homepage.ts';
import { landingFor } from '../auth/pages.ts';
import { html, raw, when, join } from '../../lib/html.ts';
import { redirect, notFound, badRequest, type Router, type Rq } from '../../lib/http.ts';
import { requirePerm, requireStaff, propFilter, canAccessProperty, type Ctx , type UserRow } from '../../lib/auth.ts';
import { q, q1, run, insert, update, val, j, js } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, fmtDate, addMonths, addDays, timezoneLabel, timezoneOptions } from '../../lib/dates.ts';
import { usd } from '../../lib/money.ts';
import { audit } from '../../lib/audit.ts';
import { v } from '../../lib/validate.ts';
import {
  shell, card, tbl, kpis, dl, tabs, statusBadge, field, input, select, textarea,
  registerNav, registerSearch, emptyState, historyPanel, checkbox, moneyInput, type Kpi,
} from '../../ui/ui.ts';
import { donut, bars, sparkline, barChart, areaChart, funnelChart, splitBar } from '../../lib/charts.ts';
import { funnelStats, leadPerformance } from '../m3_crm/service.ts';
import {
  unitStats, floorplanAvailability, propertySummaries, unitAmenities, effectiveMarketRent,
  deleteProperty, UNIT_STATUSES, UNIT_STATUS_LABELS, MANUAL_UNIT_STATUSES,
} from './service.ts';
import { mapRoutes, dashMapCard } from './map.ts';

registerNav('', { href: '/', label: 'Dashboard', perm: 'dashboard:view' });
registerNav('Property', { href: '/properties', label: 'Properties', perm: 'properties:view', match: ['/properties'] });
registerNav('Property', { href: '/units', label: 'Units', perm: 'units:view', match: ['/units'] });

registerSearch((ctx, query) => {
  const like = `%${query}%`;
  const pf = propFilter(ctx, 'property_id');
  const units = q<any>(
    `SELECT u.id, u.unit_number, p.name AS prop FROM units u JOIN properties p ON p.id=u.property_id
     WHERE u.org_id=? AND u.unit_number LIKE ?${pf.sql.replaceAll('property_id', 'u.property_id')} LIMIT 6`,
    ctx.orgId, like, ...pf.params,
  ).map((u) => ({ kind: 'unit', label: `Unit ${u.unit_number}`, sub: u.prop, href: `/units/${u.id}` }));
  const props = q<any>(
    `SELECT id, name, city FROM properties WHERE org_id=? AND name LIKE ? LIMIT 4`, ctx.orgId, like,
  ).map((p) => ({ kind: 'property', label: p.name, sub: p.city, href: `/properties/${p.id}` }));
  return [...props, ...units];
});

const PROPERTY_TYPES: [string, string][] = [
  ['multifamily', 'Multifamily'], ['military', 'Military'], ['commercial', 'Commercial'], ['manufactured', 'Manufactured housing'],
];

export function routes(r: Router): void {
  mapRoutes(r);
  // ---------- dashboards ----------
  // The root is two front doors: logged-out visitors get the marketing
  // homepage (Entrata-style); signed-in users get their dashboard/portal.
  r.get('/', (rq) => {
    if (!rq.user) return marketingHome(rq);
    const user = rq.user as UserRow;
    if (user.kind !== 'staff' && user.kind !== 'platform') return redirect(landingFor(user));
    const ctx = rq.ctx as Ctx;
    if (!ctx.perms.has('dashboard:view')) return redirect('/me');
    if (ctx.currentPropertyId) return propertyDashboard(rq, ctx.currentPropertyId);
    return portfolioDashboard(rq);
  });

  // ---------- properties ----------
  r.get('/properties', requirePerm('properties:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const sums = propertySummaries(ctx);
    return shell(rq, {
      title: 'Properties',
      active: '/properties',
      actions: when((rq.ctx as Ctx).perms.has('properties:manage'), () => html`<a class="btn" href="/properties/new">Add property</a>`),
      content: card(null, tbl(
        [{ label: 'Property' }, { label: 'Type' }, { label: 'Location' }, { label: 'Units', num: true }, { label: 'Occupancy', num: true }, { label: 'Exposure', num: true }, { label: 'Avg market rent', num: true }],
        sums.map((p) => ({
          href: `/properties/${p.id}`,
          cells: [
            html`<b>${p.name}</b><span class="sub">${p.slug}</span>`,
            statusBadge(undefined, p.type),
            `${p.city}, ${p.state}`,
            p.stats.total,
            html`<b>${p.stats.occupancyPct}%</b>`,
            `${p.stats.exposurePct}%`,
            usd(p.stats.avgMarketRentCents),
          ],
        })),
        { empty: 'No properties yet — add your first property.' },
      ), { flush: true }),
    });
  });

  const propertyForm = (p?: any): ReturnType<typeof html> => html`
    <form method="post" action="${p ? `/properties/${p.id}/edit` : '/properties/new'}">
      <div class="form-grid">
        ${field('Property name', input('name', { value: p?.name, required: true }))}
        ${field('Slug (public URL)', input('slug', { value: p?.slug, required: true, placeholder: 'summit-ridge' }))}
        ${field('Type', select('type', PROPERTY_TYPES, p?.type ?? 'multifamily'))}
        ${field('Time zone', select('timezone', timezoneOptions(p?.timezone), p?.timezone ?? 'America/Denver'))}
        ${field('Street address', input('address1', { value: p?.address1, required: true }))}
        ${field('City', input('city', { value: p?.city, required: true }))}
        ${field('State', input('state', { value: p?.state, required: true }))}
        ${field('ZIP', input('zip', { value: p?.zip, required: true }))}
        ${field('Office phone', input('phone', { value: p?.phone ?? '', type: 'tel' }))}
        ${field('Office email', input('email', { value: p?.email ?? '', type: 'email' }))}
        ${field('Year built', input('year_built', { value: p?.year_built ?? '', type: 'number' }))}
        ${field('Fiscal year starts (month)', input('fiscal_year_start_month', { value: p?.fiscal_year_start_month ?? 1, type: 'number', min: '1', max: '12' }))}
      </div>
      <div class="btn-row"><button class="btn">${p ? 'Save property' : 'Create property'}</button><a class="btn btn-ghost" href="/properties">Cancel</a></div>
    </form>`;

  r.get('/properties/new', requirePerm('properties:manage'), (rq) =>
    shell(rq, { title: 'Add property', active: '/properties', crumbs: [['Properties', '/properties']], content: card(null, propertyForm()) }),
  );

  r.post('/properties/new', requirePerm('properties:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const schema = v.object({
      name: v.string({ min: 2 }), slug: v.string({ min: 2, pattern: /^[a-z0-9-]+$/ }),
      type: v.oneOf(...PROPERTY_TYPES.map((t) => t[0])), timezone: v.string(),
      address1: v.string({ min: 3 }), city: v.string({ min: 2 }), state: v.string({ min: 2, max: 2 }), zip: v.string({ min: 5 }),
    });
    const res = schema.safe(rq.body);
    if (!res.ok) return redirect('/properties/new', res.issues.map((i) => i.message).join('; '), 'err');
    if (q1('SELECT id FROM properties WHERE slug=?', res.value.slug)) return redirect('/properties/new', 'Slug already in use.', 'err');
    const pid = id('prp');
    insert('properties', {
      id: pid, org_id: ctx.orgId, ...res.value,
      phone: rq.body.phone || null, email: rq.body.email || null,
      year_built: rq.body.year_built ? parseInt(String(rq.body.year_built), 10) : null,
      fiscal_year_start_month: parseInt(String(rq.body.fiscal_year_start_month || '1'), 10) || 1,
      created_at: nowIso(),
    });
    audit(ctx, 'property', pid, 'create', null, res.value as Record<string, unknown>);
    return redirect(`/properties/${pid}`, 'Property created — add buildings and floorplans next.');
  });

  r.get('/properties/:id', requirePerm('properties:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const p = getProp(ctx, rq.params.id!);
    if (!p) return notFound('Property not found');
    const tab = rq.query.get('tab') || 'overview';
    const stats = unitStats(ctx, p.id);
    const buildings = q<any>('SELECT b.*, (SELECT COUNT(*) FROM units u WHERE u.building_id=b.id) AS units FROM buildings b WHERE b.property_id=? ORDER BY b.name', p.id);
    const fps = floorplanAvailability(ctx, p.id);
    const items = q<any>('SELECT * FROM rentable_items WHERE property_id=? ORDER BY kind, label', p.id);
    const spaces = q<any>('SELECT * FROM amenity_spaces WHERE property_id=? ORDER BY name', p.id);

    const tabItems = [
      { href: `/properties/${p.id}`, label: 'Overview', active: tab === 'overview' },
      { href: `/properties/${p.id}?tab=inventory`, label: 'Buildings & floorplans', active: tab === 'inventory' },
      { href: `/properties/${p.id}?tab=rentables`, label: 'Rentable items', active: tab === 'rentables', count: items.length },
      { href: `/properties/${p.id}?tab=spaces`, label: 'Amenity spaces', active: tab === 'spaces', count: spaces.length },
      { href: `/properties/${p.id}?tab=history`, label: 'History', active: tab === 'history' },
    ];

    let body;
    if (tab === 'inventory') {
      body = html`
        <div class="grid cols-2">
        ${card('Buildings', html`${tbl(
          [{ label: 'Building' }, { label: 'Floors', num: true }, { label: 'Units', num: true }],
          buildings.map((b) => ({ cells: [html`<b>${b.name}</b>`, b.floors, b.units] })),
          { empty: 'No buildings yet.' },
        )}
        ${when(ctx.perms.has('units:manage'), () => html`<div class="card-body"><form method="post" action="/properties/${p.id}/buildings" class="toolbar">
          ${field('Name', input('name', { required: true, placeholder: 'Building D' }))}
          ${field('Floors', input('floors', { type: 'number', value: 3, min: '1' }))}
          <button class="btn">Add</button>
        </form></div>`)}`, { flush: true })}
        ${card('Floorplans', html`${tbl(
          [{ label: 'Plan' }, { label: 'Bed/Bath' }, { label: 'Sqft', num: true }, { label: 'Base rent', num: true }, { label: 'Units', num: true }, { label: 'Available', num: true }],
          fps.map((f) => ({
            cells: [html`<b>${f.name}</b>`, `${f.beds === 0 ? 'Studio' : f.beds + ' bd'} / ${f.baths} ba`, f.sqft, usd(f.market_rent_cents), f.units, f.available],
          })),
          { empty: 'No floorplans yet.' },
        )}
        ${when(ctx.perms.has('units:manage'), () => html`<div class="card-body"><form method="post" action="/properties/${p.id}/floorplans" class="form-grid">
          ${field('Name', input('name', { required: true, placeholder: 'B3' }))}
          ${field('Beds', input('beds', { type: 'number', value: 1, min: '0' }))}
          ${field('Baths', input('baths', { type: 'number', value: 1, min: '1', step: '0.5' }))}
          ${field('Sqft', input('sqft', { type: 'number', value: 800, min: '100' }))}
          ${field('Base market rent', moneyInput('market_rent', 150000, { required: true }))}
          <div class="field"><label>&nbsp;</label><button class="btn">Add floorplan</button></div>
        </form></div>`)}`, { flush: true })}
        </div>`;
    } else if (tab === 'rentables') {
      const kinds = ['parking', 'garage', 'storage', 'pet'];
      body = html`${card('Rentable items', html`
        <p class="small muted" style="margin:0 0 10px">Parking, garages, storage and pet registrations — inventory whose monthly charges flow to resident ledgers via lease charge lines.</p>
        ${tbl(
          [{ label: 'Item' }, { label: 'Kind' }, { label: 'Monthly', num: true }, { label: 'Status' }, { label: 'Assigned to' }],
          items.map((it) => ({
            cells: [
              html`<b>${it.label}</b>`, statusBadge(undefined, it.kind), usd(it.monthly_cents), statusBadge(it.status === 'available' ? 'ready' : it.status, it.status),
              it.assigned_lease_id ? html`<a href="/leases/${it.assigned_lease_id}">lease</a>` : '—',
            ],
          })),
          { empty: 'No rentable items yet.' },
        )}
        ${when(ctx.perms.has('units:manage'), () => html`<form method="post" action="/properties/${p.id}/rentables" class="toolbar" style="margin-top:10px">
          ${field('Kind', select('kind', kinds.map((k): [string, string] => [k, k])))}
          ${field('Label', input('label', { required: true, placeholder: 'Stall P-41' }))}
          ${field('Monthly', moneyInput('monthly', 3500, { required: true }))}
          <button class="btn">Add item</button>
        </form>`)}`)}`;
    } else if (tab === 'spaces') {
      body = amenitySpacesTab(ctx, p, spaces);
    } else if (tab === 'history') {
      body = card('History', historyPanel(ctx.orgId, 'property', p.id));
    } else {
      const statusRows = q<any>(
        `SELECT status, COUNT(*) n FROM units WHERE property_id=? GROUP BY status ORDER BY n DESC`, p.id,
      );
      body = html`
        ${kpis([
          { label: 'Units', value: stats.total, href: `/units?property=${p.id}` },
          { label: 'Occupancy', value: `${stats.occupancyPct}%`, tone: stats.occupancyPct >= 93 ? 'ok' : stats.occupancyPct >= 88 ? 'warn' : 'bad', sub: `${stats.occupied} of ${stats.rentable} rentable` },
          { label: 'Exposure', value: `${stats.exposurePct}%`, sub: `${stats.exposureCount} units`, tone: stats.exposurePct <= 8 ? 'ok' : 'warn', href: `/units?property=${p.id}&status=vacant_ready` },
          { label: 'Vacant ready', value: stats.vacantReady, href: `/units?property=${p.id}&status=vacant_ready` },
          { label: 'On notice', value: stats.notice, href: `/units?property=${p.id}&status=notice` },
          { label: 'Avg market rent', value: usd(stats.avgMarketRentCents) },
        ])}
        <div class="grid cols-2">
          ${card('Unit mix', donut(
            statusRows.map((s) => ({ label: UNIT_STATUS_LABELS[s.status] || s.status, value: s.n, tone: s.status === 'occupied' ? 'info' : s.status === 'vacant_ready' ? 'ok' : s.status === 'notice' ? 'warn' : s.status === 'down' ? 'bad' : s.status === 'model' ? 'violet' : 'muted' })),
            { centerValue: `${stats.occupancyPct}%`, centerLabel: 'occupied' },
          ))}
          ${card('Property profile', propertyProfile(p, { buildings: buildings.length, floorplans: fps.length, units: stats.total }))}
        </div>
        ${card('Floorplan availability', bars(
          fps.map((f) => ({ label: `${f.name} · ${f.beds === 0 ? 'Studio' : f.beds + 'bd'}`, value: f.available, href: `/units?property=${p.id}&floorplan=${f.id}` })),
        ))}
        ${leasingPanel(ctx, p)}`;
    }

    return shell(rq, {
      title: p.name,
      active: '/properties',
      crumbs: [['Properties', '/properties']],
      subtitle: `${p.city}, ${p.state} · ${statusBadge(undefined, p.type).s ? '' : ''}${p.type}`,
      actions: when(ctx.perms.has('properties:manage'), () => html`<a class="btn btn-ghost" href="/properties/${p.id}/edit">Edit property</a>`),
      content: html`${tabs(tabItems)}${body}`,
    });
  });

  r.get('/properties/:id/edit', requirePerm('properties:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const p = getProp(ctx, rq.params.id!);
    if (!p) return notFound();
    const dangerZone = card('Danger zone', html`
      <p style="margin-top:0"><b>Remove this property.</b> This permanently deletes ${p.name} and everything recorded
      under it: units, leases, resident records and their portal access, files, and every journal entry booked to the
      property on both the accrual and cash books. Residents who also hold a lease at another property keep their
      records and portal access. This cannot be undone.</p>
      <p class="small muted" style="margin-top:0">If payments or manually posted journal entries have been recorded here
      since the books were set up, the removal will be declined to protect your financial history.</p>
      <form method="post" action="/properties/${p.id}/delete">
        ${field(html`To confirm, type the property name exactly — <b>${p.name}</b>`, input('confirm_name', { required: true, placeholder: p.name }))}
        <div class="btn-row"><button class="btn btn-danger">Remove this property permanently</button></div>
      </form>`);
    return shell(rq, {
      title: `Edit ${p.name}`, active: '/properties', crumbs: [['Properties', '/properties'], [p.name, `/properties/${p.id}`]],
      content: html`${card(null, propertyForm(p))}${dangerZone}`,
    });
  });

  r.post('/properties/:id/edit', requirePerm('properties:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const p = getProp(ctx, rq.params.id!);
    if (!p) return notFound();
    const before = { name: p.name, slug: p.slug, type: p.type, address1: p.address1 };
    update('properties', p.id, {
      name: String(rq.body.name || p.name), slug: String(rq.body.slug || p.slug), type: String(rq.body.type || p.type),
      timezone: String(rq.body.timezone || p.timezone), address1: String(rq.body.address1 || p.address1),
      city: String(rq.body.city || p.city), state: String(rq.body.state || p.state), zip: String(rq.body.zip || p.zip),
      phone: rq.body.phone || null, email: rq.body.email || null,
      year_built: rq.body.year_built ? parseInt(String(rq.body.year_built), 10) : null,
      fiscal_year_start_month: parseInt(String(rq.body.fiscal_year_start_month || p.fiscal_year_start_month), 10),
    });
    audit(ctx, 'property', p.id, 'update', before, { name: rq.body.name, slug: rq.body.slug, type: rq.body.type, address1: rq.body.address1 });
    return redirect(`/properties/${p.id}`, 'Property saved.');
  });

  // Typed-name confirmed, books-safe delete. The typed name IS the
  // confirmation — no script dialogs; the server re-checks it here.
  r.post('/properties/:id/delete', requirePerm('properties:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const p = getProp(ctx, rq.params.id!);
    if (!p) return notFound();
    const typed = String(rq.body.confirm_name || '').trim();
    if (typed !== p.name) {
      return redirect(`/properties/${p.id}/edit`, 'The name you typed does not match this property — nothing was removed.', 'err');
    }
    try {
      const { counts } = deleteProperty(ctx, p.id);
      const n = (k: string): number => counts[k] || 0;
      const bits = [
        `${n('units')} unit${n('units') === 1 ? '' : 's'}`,
        `${n('leases')} lease${n('leases') === 1 ? '' : 's'}`,
        `${n('residents')} resident record${n('residents') === 1 ? '' : 's'}`,
        `${n('journal_entries')} journal entr${n('journal_entries') === 1 ? 'y' : 'ies'}`,
      ];
      return redirect('/properties', `${p.name} was removed, along with ${bits.join(', ')}.`);
    } catch (e) {
      return redirect(`/properties/${p.id}/edit`, (e as Error).message, 'err');
    }
  });

  r.post('/properties/:id/buildings', requirePerm('units:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const p = getProp(ctx, rq.params.id!);
    if (!p) return notFound();
    const bid = id('bld');
    insert('buildings', { id: bid, org_id: ctx.orgId, property_id: p.id, name: String(rq.body.name || 'Building'), floors: parseInt(String(rq.body.floors || '1'), 10) || 1, created_at: nowIso() });
    audit(ctx, 'building', bid, 'create');
    return redirect(`/properties/${p.id}?tab=inventory`, 'Building added.');
  });

  r.post('/properties/:id/floorplans', requirePerm('units:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const p = getProp(ctx, rq.params.id!);
    if (!p) return notFound();
    const fid = id('fpl');
    insert('floorplans', {
      id: fid, org_id: ctx.orgId, property_id: p.id, name: String(rq.body.name || 'Plan'),
      beds: parseInt(String(rq.body.beds || '1'), 10), baths: parseFloat(String(rq.body.baths || '1')),
      sqft: parseInt(String(rq.body.sqft || '700'), 10), market_rent_cents: v.cents().parse(rq.body.market_rent),
      created_at: nowIso(),
    });
    audit(ctx, 'floorplan', fid, 'create');
    return redirect(`/properties/${p.id}?tab=inventory`, 'Floorplan added.');
  });

  r.post('/properties/:id/rentables', requirePerm('units:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const p = getProp(ctx, rq.params.id!);
    if (!p) return notFound();
    const rid = id('rti');
    insert('rentable_items', {
      id: rid, org_id: ctx.orgId, property_id: p.id, kind: String(rq.body.kind || 'parking'),
      label: String(rq.body.label || 'Item'), monthly_cents: v.cents().parse(rq.body.monthly), status: 'available', created_at: nowIso(),
    });
    audit(ctx, 'rentable_item', rid, 'create');
    return redirect(`/properties/${p.id}?tab=rentables`, 'Rentable item added.');
  });

  r.post('/properties/:id/spaces', requirePerm('units:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const p = getProp(ctx, rq.params.id!);
    if (!p) return notFound();
    const sid = id('spc');
    insert('amenity_spaces', {
      id: sid, org_id: ctx.orgId, property_id: p.id, name: String(rq.body.name || 'Space'),
      capacity: rq.body.capacity ? parseInt(String(rq.body.capacity), 10) : null,
      fee_cents: v.cents().default(0).parse(rq.body.fee), bookable: 1, created_at: nowIso(),
    });
    audit(ctx, 'amenity_space', sid, 'create');
    return redirect(`/properties/${p.id}?tab=spaces`, 'Amenity space added.');
  });

  // ---------- units ----------
  r.get('/units', requirePerm('units:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const view = rq.query.get('view') || 'board';
    const propId = rq.query.get('property') || ctx.currentPropertyId || '';
    const status = rq.query.get('status') || '';
    const fpId = rq.query.get('floorplan') || '';
    const beds = rq.query.get('beds') || '';
    const pf = propFilter(ctx, 'u.property_id');
    const params: unknown[] = [ctx.orgId, ...pf.params];
    let where = `u.org_id=?${pf.sql}`;
    if (propId) { where += ' AND u.property_id=?'; params.push(propId); }
    if (status) { where += ' AND u.status=?'; params.push(status); }
    if (fpId) { where += ' AND u.floorplan_id=?'; params.push(fpId); }
    if (beds !== '') { where += ' AND f.beds=?'; params.push(parseInt(beds, 10)); }
    const units = q<any>(
      `SELECT u.*, f.name AS fp_name, f.beds, f.baths, b.name AS building, p.name AS prop_name
       FROM units u LEFT JOIN floorplans f ON f.id=u.floorplan_id LEFT JOIN buildings b ON b.id=u.building_id JOIN properties p ON p.id=u.property_id
       WHERE ${where} ORDER BY p.name, u.unit_number LIMIT 600`,
      ...params,
    );
    const props = q<any>(`SELECT id, name FROM properties WHERE org_id=?${propFilter(ctx, 'id').sql} ORDER BY name`, ctx.orgId, ...propFilter(ctx, 'id').params);
    const fps = propId ? q<any>('SELECT id, name FROM floorplans WHERE property_id=? ORDER BY name', propId) : [];

    const filterBar = html`<form method="get" class="toolbar" data-autosubmit>
      <input type="hidden" name="view" value="${view}" />
      ${field('Property', select('property', props.map((p): [string, string] => [p.id, p.name]), propId, { blank: 'All properties' }))}
      ${field('Status', select('status', UNIT_STATUSES.map((s): [string, string] => [s, UNIT_STATUS_LABELS[s]!]), status, { blank: 'All statuses' }))}
      ${when(fps.length, () => field('Floorplan', select('floorplan', fps.map((f): [string, string] => [f.id, f.name]), fpId, { blank: 'All plans' })))}
      ${field('Beds', select('beds', [['0', 'Studio'], ['1', '1 bd'], ['2', '2 bd'], ['3', '3 bd'], ['4', '4 bd']], beds, { blank: 'Any' }))}
      <div class="grow"></div>
      <div class="field"><label>View</label><div style="display:flex;gap:4px">
        <a class="btn btn-sm ${view === 'board' ? '' : 'btn-ghost'}" href="${swapParam(rq, 'view', 'board')}">Board</a>
        <a class="btn btn-sm ${view === 'list' ? '' : 'btn-ghost'}" href="${swapParam(rq, 'view', 'list')}">List</a>
      </div></div>
    </form>`;

    let body;
    if (view === 'board' && !status) {
      const byStatus = new Map<string, any[]>();
      for (const s of UNIT_STATUSES) byStatus.set(s, []);
      for (const u of units) byStatus.get(u.status)?.push(u);
      const canMove = ctx.perms.has('units:manage');
      body = html`
        <form id="dnd-form" method="post" action="/units/move" style="display:none">
          <input type="hidden" name="item_id" /><input type="hidden" name="lane" />
          <input type="hidden" name="back" value="${swapParam(rq, 'view', 'board')}" />
        </form>
        ${when(canMove, () => html`<p class="small muted" style="margin:0 0 10px">Drag a unit onto another column to change its status. Occupied and On notice are set by lease events — those columns do not accept drops, and units in them cannot be dragged out.</p>`)}
        <div class="board">${UNIT_STATUSES.map((s) => {
          const list = byStatus.get(s) || [];
          // Lease-driven lanes are not drop targets. The board refuses the
          // gesture rather than accepting it and reporting a failure after the
          // round trip — a column you can drop into is a promise.
          const droppable = canMove && MANUAL_UNIT_STATUSES.includes(s);
          return html`<div class="col ${droppable ? 'dnd-ok' : 'dnd-locked'}" ${droppable ? raw(`data-dnd-lane="${s}"`) : null}>
            <div class="col-head"><span>${UNIT_STATUS_LABELS[s]}</span><span class="badge">${list.length}</span>${when(canMove && !droppable, () => html`<span class="col-lock" title="Set by lease events, not by hand">lease-driven</span>`)}</div>
            <div class="col-body">${list.slice(0, 40).map((u) => {
              const draggable = canMove && MANUAL_UNIT_STATUSES.includes(u.status);
              return html`<a class="bcard" href="/units/${u.id}" ${draggable ? raw(`data-dnd-item="${u.id}"`) : null}>
                <b>${u.unit_number}</b> · ${u.fp_name || '—'}
                <span class="sub">${u.prop_name}${u.building ? ` · ${u.building}` : ''} · ${usd(u.market_rent_cents)}</span>
              </a>`;
            })}${list.length > 40 ? html`<a class="small" href="/units?view=list&status=${s}&property=${propId}">+ ${list.length - 40} more…</a>` : null}</div>
          </div>`;
        })}</div>`;
    } else {
      body = card(null, tbl(
        [{ label: 'Unit' }, { label: 'Property' }, { label: 'Plan' }, { label: 'Sqft', num: true }, { label: 'Status' }, { label: 'Market rent', num: true }],
        units.map((u) => ({
          href: `/units/${u.id}`,
          cells: [
            html`<b>${u.unit_number}</b>${u.building ? html`<span class="sub">${u.building}</span>` : ''}`,
            u.prop_name,
            u.fp_name ? `${u.fp_name} · ${u.beds === 0 ? 'Studio' : u.beds + 'bd'}/${u.baths}ba` : '—',
            u.sqft,
            statusBadge(u.status, UNIT_STATUS_LABELS[u.status]),
            usd(u.market_rent_cents),
          ],
        })),
        { empty: 'No units match these filters.' },
      ), { flush: true });
    }

    return shell(rq, {
      title: 'Units',
      active: '/units',
      subtitle: `${units.length} unit${units.length === 1 ? '' : 's'} · status lifecycle is driven by lease events`,
      wide: view === 'board',
      content: html`${filterBar}${body}`,
    });
  });

  r.get('/units/:id', requirePerm('units:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const u = q1<any>(
      `SELECT u.*, f.name AS fp_name, f.beds, f.baths, f.market_rent_cents AS fp_rent, b.name AS building, p.name AS prop_name, p.id AS prop_id
       FROM units u LEFT JOIN floorplans f ON f.id=u.floorplan_id LEFT JOIN buildings b ON b.id=u.building_id JOIN properties p ON p.id=u.property_id
       WHERE u.id=? AND u.org_id=?`,
      rq.params.id!, ctx.orgId,
    );
    if (!u || !canAccessProperty(ctx, u.prop_id)) return notFound('Unit not found');
    const amenities = unitAmenities(u);
    const leases = q<any>(`SELECT * FROM leases WHERE unit_id=? ORDER BY start_date DESC LIMIT 10`, u.id);
    return shell(rq, {
      title: `Unit ${u.unit_number}`,
      active: '/units',
      crumbs: [['Units', '/units'], [u.prop_name, `/properties/${u.prop_id}`]],
      subtitle: html`${statusBadge(u.status, UNIT_STATUS_LABELS[u.status])} · ${u.fp_name || 'no plan'} · ${u.sqft} sqft`,
      actions: when(ctx.perms.has('units:manage'), () => html`
        <form method="post" action="/units/${u.id}/status" class="toolbar" style="margin:0">
          ${select('status', [['down', 'Mark down'], ['model', 'Mark model'], ['vacant_not_ready', 'Vacant · not ready'], ['vacant_ready', 'Vacant · ready']], undefined, { blank: 'Manual status…' })}
          <button class="btn btn-ghost btn-sm">Apply</button>
        </form>`),
      content: html`
        <div class="grid cols-2">
          ${card('Unit', dl([
            ['Property', html`<a href="/properties/${u.prop_id}">${u.prop_name}</a>`],
            ['Building / floor', `${u.building || '—'} / ${u.floor}`],
            ['Floorplan', u.fp_name ? `${u.fp_name} — ${u.beds === 0 ? 'Studio' : u.beds + ' bd'} / ${u.baths} ba` : '—'],
            ['Sqft', u.sqft],
            ['Status', statusBadge(u.status, UNIT_STATUS_LABELS[u.status])],
          ]))}
          ${card('Pricing', html`${dl([
            ['Floorplan base', usd(u.fp_rent ?? u.market_rent_cents)],
            ...amenities.map((a): [string, string] => [a.name, `+${usd(a.premium_cents)}`]),
            ['Effective market rent', html`<b>${usd(u.market_rent_cents)}</b>`],
          ])}
          <p class="small muted" style="margin-top:8px">Amenity premiums adjust effective pricing. Daily recommended pricing comes from Revenue Intelligence.</p>`)}
        </div>
        ${card('Lease history', tbl(
          [{ label: 'Household' }, { label: 'Status' }, { label: 'Term' }, { label: 'Rent', num: true }],
          leases.map((l) => ({
            href: `/leases/${l.id}`,
            cells: [l.household_name, statusBadge(l.status), `${fmtDate(l.start_date)} → ${fmtDate(l.end_date)}`, usd(l.rent_cents)],
          })),
          { empty: 'No leases yet for this unit.' },
        ), { flush: true })}
        ${card('History', historyPanel(ctx.orgId, 'unit', u.id))}`,
    });
  });

  r.post('/units/:id/status', requirePerm('units:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const u = q1<any>('SELECT * FROM units WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!u || !canAccessProperty(ctx, u.property_id)) return notFound();
    const to = String(rq.body.status || '');
    // manual transitions limited to non-lease states; occupied/notice always derive from lease events (M2.2)
    if (!MANUAL_UNIT_STATUSES.includes(to)) return badRequest('That status is driven by lease events.');
    if (!MANUAL_UNIT_STATUSES.includes(u.status)) return redirect(`/units/${u.id}`, 'Occupied/notice units change via lease events, not manually.', 'err');
    update('units', u.id, { status: to });
    audit(ctx, 'unit', u.id, 'status_change', { status: u.status }, { status: to });
    return redirect(`/units/${u.id}`, `Unit marked ${UNIT_STATUS_LABELS[to]}.`);
  });

  // Board drag-and-drop. Same rules as the unit page's status form — the
  // gesture is a different way to reach one transition, not a second, laxer
  // path to it, so both read MANUAL_UNIT_STATUSES and both audit the change.
  r.post('/units/move', requirePerm('units:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    // The return path is echoed from a hidden field to keep the operator's
    // filters. Anything that is not a /units board URL is discarded rather
    // than trusted into a Location header.
    const asked = String(rq.body.back || '');
    const back = /^\/units(\?[A-Za-z0-9_=&%.,+-]*)?$/.test(asked) ? asked : '/units';
    const u = q1<any>('SELECT * FROM units WHERE id=? AND org_id=?', String(rq.body.item_id || ''), ctx.orgId);
    if (!u || !canAccessProperty(ctx, u.property_id)) return redirect(back, 'That unit is no longer available.', 'err');
    const to = String(rq.body.lane || '');
    if (!MANUAL_UNIT_STATUSES.includes(to)) {
      return redirect(back, `${UNIT_STATUS_LABELS[to] || 'That status'} is set by lease events — move the lease, not the unit.`, 'err');
    }
    if (!MANUAL_UNIT_STATUSES.includes(u.status)) {
      return redirect(back, `Unit ${u.unit_number} is ${UNIT_STATUS_LABELS[u.status] || u.status} — that comes from its lease, so it cannot be dragged out of the column.`, 'err');
    }
    if (u.status === to) return redirect(back);
    update('units', u.id, { status: to });
    audit(ctx, 'unit', u.id, 'status_change', { status: u.status }, { status: to });
    return redirect(back, `Unit ${u.unit_number} moved to ${UNIT_STATUS_LABELS[to]}.`);
  });
}

// ---------- dashboards ----------

function propertyDashboard(rq: Rq, propertyId: string) {
  const ctx = rq.ctx as Ctx;
  const p = getProp(ctx, propertyId);
  if (!p) return notFound('Property not found');
  const stats = unitStats(ctx, p.id);
  const fps = floorplanAvailability(ctx, p.id);
  const noticeUnits = q<any>(
    `SELECT u.id, u.unit_number, l.move_out_date, l.household_name FROM units u
     LEFT JOIN leases l ON l.unit_id=u.id AND l.status IN ('notice','active','month_to_month')
     WHERE u.property_id=? AND u.status='notice' ORDER BY l.move_out_date LIMIT 8`,
    p.id,
  );
  const extra = dashboardExtras(ctx, p.id);
  return shell(rq, {
    title: p.name,
    active: '/',
    bareHead: true,
    content: html`
      ${dashHero(ctx, {
        kicker: `Property dashboard · ${fmtDate(ctx.businessDate)}`,
        title: p.name,
        sub: html`${p.city}, ${p.state} · ${stats.occupied}/${stats.rentable} rentable occupied · <a href="/properties/${p.id}">Property setup →</a>`,
        occupancyPct: stats.occupancyPct,
        actions: html`<a class="btn btn-ghost btn-sm" href="/map">Portfolio map</a>`,
      })}
      ${kpiBands([
        { label: 'Occupancy', value: `${stats.occupancyPct}%`, sub: `${stats.occupied}/${stats.rentable} rentable`, tone: stats.occupancyPct >= 93 ? 'ok' : stats.occupancyPct >= 88 ? 'warn' : 'bad', href: `/units?property=${p.id}` },
        { label: 'Exposure', value: `${stats.exposurePct}%`, sub: `${stats.exposureCount} units vacant or leaving`, tone: stats.exposurePct <= 8 ? 'ok' : 'warn', href: `/units?property=${p.id}&status=vacant_ready` },
        { label: 'Vacant ready', value: stats.vacantReady, href: `/units?property=${p.id}&status=vacant_ready` },
        { label: 'On notice', value: stats.notice, href: `/units?property=${p.id}&status=notice` },
        ...extra.kpis,
      ])}
      <div class="grid cols-2">
        ${card('Unit mix', donut([
          { label: 'Occupied', value: stats.occupied - stats.notice, tone: 'info' },
          { label: 'Notice', value: stats.notice, tone: 'warn' },
          { label: 'Vacant ready', value: stats.vacantReady, tone: 'ok' },
          { label: 'Vacant not ready', value: stats.vacantNotReady, tone: 'muted' },
          { label: 'Down', value: stats.down, tone: 'bad' },
          { label: 'Model', value: stats.model, tone: 'violet' },
        ], { centerValue: `${stats.occupancyPct}%`, centerLabel: 'occupancy' }))}
        ${card('Available by floorplan', bars(fps.map((f) => ({ label: `${f.name} · ${f.beds === 0 ? 'Studio' : f.beds + 'bd'}`, value: f.available, href: `/units?property=${p.id}&floorplan=${f.id}&status=vacant_ready` }))))}
      </div>
      ${extra.panels}
      ${card('Upcoming move-outs (notice)', tbl(
        [{ label: 'Unit' }, { label: 'Household' }, { label: 'Move-out' }],
        noticeUnits.map((n) => ({ href: `/units/${n.id}`, cells: [html`<b>${n.unit_number}</b>`, n.household_name || '—', n.move_out_date ? fmtDate(n.move_out_date) : 'TBD'] })),
        { empty: 'No units on notice.' },
      ), { flush: true })}`,
  });
}

/** 12-month org trends for the dashboard sparklines (occupancy %, delinquency $,
 * collections %). Occupancy/delinquency read the monthly MetricSnapshots; the
 * collection rate is billed-vs-collected per month. Self-contained (no
 * cross-module import) so it can never introduce a cycle. */
function orgTrends(ctx: Ctx): { labels: string[]; occ: number[]; deliq: number[]; coll: number[] } | null {
  const snaps = q<{ property_id: string; date: string; metrics: string }>(
    `SELECT ms.property_id, ms.date, ms.metrics FROM metric_snapshots ms
     JOIN properties p ON p.id=ms.property_id WHERE p.org_id=? ORDER BY ms.date`,
    ctx.orgId,
  );
  if (snaps.length < 4) return null;
  // keep the last snapshot per (property, month), then aggregate by month
  const perPropMonth = new Map<string, { occ: number; rent: number; deliq: number }>();
  for (const s of snaps) {
    const m = j<any>(s.metrics, {});
    perPropMonth.set(`${s.property_id}|${s.date.slice(0, 7)}`, { occ: m.occupied || 0, rent: m.rentable || 0, deliq: m.delinquent_cents || 0 });
  }
  const byMonth = new Map<string, { occ: number; rent: number; deliq: number }>();
  for (const [k, v2] of perPropMonth) {
    const mk = k.split('|')[1]!;
    const b = byMonth.get(mk) || { occ: 0, rent: 0, deliq: 0 };
    b.occ += v2.occ; b.rent += v2.rent; b.deliq += v2.deliq;
    byMonth.set(mk, b);
  }
  const keys = [...byMonth.keys()].sort().slice(-12);
  if (keys.length < 3) return null;
  const occ = keys.map((k) => { const b = byMonth.get(k)!; return b.rent ? Math.round((b.occ / b.rent) * 1000) / 10 : 0; });
  const deliq = keys.map((k) => Math.round(byMonth.get(k)!.deliq / 100));
  const coll = keys.map((mk) => {
    // billed by posting DATE (one-off fees have month_key NULL); collected nets
    // out security-deposit receipts (balance-sheet cash, never "billed" here).
    // The rate can still top 100% in months when residents catch up prior
    // balances — that's real collections behavior, not an error.
    const billed = val<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM charges WHERE org_id=? AND date LIKE ? AND status='active' AND kind NOT IN ('deposit')`, ctx.orgId, `${mk}%`) || 0;
    const collectedGross = val<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE org_id=? AND received_date LIKE ? AND status IN ('pending','settled') AND method != 'credit'`, ctx.orgId, `${mk}%`) || 0;
    const depositReceipts = val<number>(
      `SELECT COALESCE(SUM(pa.amount_cents),0) FROM payment_applications pa
       JOIN payments p2 ON p2.id=pa.payment_id AND p2.status IN ('pending','settled') AND p2.method != 'credit'
       JOIN charges c ON c.id=pa.charge_id AND c.kind='deposit'
       WHERE pa.org_id=? AND p2.received_date LIKE ?`, ctx.orgId, `${mk}%`) || 0;
    const collected = collectedGross - depositReceipts;
    return billed ? Math.round((collected / billed) * 1000) / 10 : 0;
  });
  return { labels: keys.map((k) => k.slice(5)), occ, deliq, coll };
}

/** Entrata-BI-style analytics: real charts in chart cards (Rolling Occupancy
 * bars, gradient area trends, lead funnel, monthly lead bars, comm split). */
function analyticsCards(ctx: Ctx, t: ReturnType<typeof orgTrends>): ReturnType<typeof html> {
  const last = <T>(a: T[]): T => a[a.length - 1]!;
  const monthLabels = (t?.labels || []).map((l) => {
    const m = parseInt(l, 10);
    return ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m] || l;
  });

  // lead funnel + monthly lead counts (last 12 months)
  const f = funnelStats(ctx, addMonths(ctx.businessDate, -3), ctx.currentPropertyId);
  const since = `${addMonths(ctx.businessDate, -11).slice(0, 7)}-01`;
  const leadRows = q<{ mk: string; c: number }>(
    `SELECT substr(created_date,1,7) AS mk, COUNT(*) AS c FROM leads WHERE org_id=? AND created_date>=? GROUP BY mk ORDER BY mk`,
    ctx.orgId, since,
  );
  const leadByMk = new Map(leadRows.map((r) => [r.mk, r.c]));
  const leadLabels: string[] = [], leadVals: number[] = [];
  for (let i = 11; i >= 0; i--) {
    const mk = addMonths(ctx.businessDate, -i).slice(0, 7);
    leadLabels.push(['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][parseInt(mk.slice(5), 10)] || mk);
    leadVals.push(leadByMk.get(mk) || 0);
  }

  // communication mix over the last 30 days
  const comm = q<{ channel: string; c: number }>(
    `SELECT channel, COUNT(*) AS c FROM outbox_messages WHERE org_id=? AND created_at>=? GROUP BY channel ORDER BY c DESC`,
    ctx.orgId, `${addDays(ctx.businessDate, -30)}T00:00:00`,
  );
  const commParts = comm.map((r) => ({ label: r.channel === 'sms' ? 'Text' : r.channel[0]!.toUpperCase() + r.channel.slice(1), value: r.c }));

  return html`
    ${when(t, () => html`${card(`Rolling occupancy · last 12 months`, html`<div class="chart-head-val">${last(t!.occ)}%</div>${barChart(monthLabels, t!.occ, { kind: 'pct', highlightLast: true })}`)}
    <div class="grid cols-2 chart-pair">
      ${card('Collections rate', html`<div class="chart-head-val pos">${last(t!.coll)}%</div>${areaChart(monthLabels, t!.coll, { kind: 'pct' })}<div class="muted small" style="margin-top:6px">Cash applied this month ÷ amounts billed this month. Can top 100% when residents catch up prior balances.</div>`)}
      ${card('Delinquency', html`<div class="chart-head-val neg">${usd(last(t!.deliq) * 100)}</div>${areaChart(monthLabels, t!.deliq, { kind: 'usd', color: '#f87171' })}`)}
    </div>`)}
    <div class="grid cols-2 chart-pair">
      ${card('Leads by month', barChart(leadLabels, leadVals, { kind: 'num' }))}
      ${card(`Lead conversion · last 90 days${f.inquiries ? ` · ${Math.round((f.leased / (f.inquiries || 1)) * 1000) / 10}% lead to lease` : ''}`, funnelChart([
        { label: 'Inquiries', value: f.inquiries },
        { label: 'Toured', value: f.toured },
        { label: 'Applied', value: f.applied },
        { label: 'Leased', value: f.leased },
      ]))}
    </div>
    ${when(commParts.length, () => card('Communication · last 30 days', splitBar(commParts)))}`;
}

/** The luminous dashboard hero: portfolio pulse + occupancy ring + live
 * activity ticker. The shell's page-head stays in the DOM (title contract)
 * but is hidden by CSS when a .dash-hero is present. */
/** "AI at work" — one row per business domain showing what the AI is doing
 * or proposing there: Leasing, Residents, Financials, Operations, Property
 * marketing, and Communications. Pending work (awaiting approval) outranks
 * completed work within each domain; Ask StayLeased staff Q&A is excluded —
 * this panel is about actions in the business, not lookups. */
const AI_DOMAINS: { key: string; label: string; agents: string[]; href: string }[] = [
  { key: 'leasing', label: 'Leasing', agents: ['leasing'], href: '/ai?agent=leasing' },
  { key: 'residents', label: 'Residents', agents: ['renewals'], href: '/ai?agent=renewals' },
  { key: 'financials', label: 'Financials', agents: ['payments'], href: '/ai?agent=payments' },
  { key: 'operations', label: 'Operations', agents: ['maintenance'], href: '/ai?agent=maintenance' },
  { key: 'property', label: 'Property', agents: ['content'], href: '/ai?agent=content' },
  { key: 'comms', label: 'Communications', agents: ['call_analysis'], href: '/ai?agent=call_analysis' },
];
function aiWorkPanel(ctx: Ctx): ReturnType<typeof html> {
  if (!ctx.perms.has('ai:view')) return html``;
  const pending = val<number>(`SELECT COUNT(*) FROM ai_actions WHERE org_id=? AND status='proposed' AND agent!='ask'`, ctx.orgId) || 0;
  const rows = q<any>(
    `SELECT agent, title, status, created_at FROM ai_actions WHERE org_id=? AND agent!='ask' ORDER BY created_at DESC LIMIT 120`,
    ctx.orgId,
  );
  const forDomain = (agents: string[]): { latest: any | null; pending: number } => {
    const mine = rows.filter((r) => agents.includes(r.agent));
    const open = mine.filter((r) => r.status === 'proposed');
    return { latest: open[0] || mine[0] || null, pending: open.length };
  };
  const statusLabel = (r: any): ReturnType<typeof html> => {
    if (r.status === 'proposed') return html`<span class="badge warn">awaiting approval</span>`;
    if (r.status === 'auto_executed') return html`<span class="badge info">ran autonomously</span>`;
    if (r.status === 'executed' || r.status === 'approved') return html`<span class="badge ok">approved &amp; sent</span>`;
    if (r.status === 'rejected') return html`<span class="badge">rejected</span>`;
    return html`<span class="badge">${String(r.status).replaceAll('_', ' ')}</span>`;
  };
  return html`<div class="card ai-panel">
    <div class="card-head">
      <h2>AI at work — across the business</h2>
      ${when(pending > 0, () => html`<span class="badge warn">${pending} awaiting your approval</span>`)}
      <a class="btn btn-sm" href="/ai">${pending > 0 ? 'Review queue' : 'AI activity'}</a>
    </div>
    <div class="card-body flush">
      <ul class="ai-feed">${AI_DOMAINS.map((d) => {
        const { latest, pending: p } = forDomain(d.agents);
        return html`<li>
          <a class="af-domain" href="${d.href}">${d.label}${when(p > 0, () => html`<i class="af-count">${p}</i>`)}</a>
          ${latest
            ? html`<span class="af-title" title="${latest.title}">${latest.title}</span>${statusLabel(latest)}<span class="af-when">${String(latest.created_at).slice(11, 16)}</span>`
            : html`<span class="af-title af-quiet">Monitoring — no action needed right now</span><span class="badge ok">clear</span>`}
        </li>`;
      })}</ul>
    </div>
  </div>`;
}

/** KPI tiles grouped by how urgently they need the operator's eyes. */
const KPI_ATTENTION = new Set(['Delinquent', 'Overdue follow-ups', 'Open work orders', 'Expiring ≤90d', 'Applications pending', 'On notice']);
const KPI_PIPELINE = new Set(['Units', 'Vacant ready', 'Leads (7d)']);
function kpiBands(items: Kpi[]): ReturnType<typeof html> {
  const attention = items.filter((k) => KPI_ATTENTION.has(String(k.label)));
  const pipeline = items.filter((k) => KPI_PIPELINE.has(String(k.label)));
  const performance = items.filter((k) => !KPI_ATTENTION.has(String(k.label)) && !KPI_PIPELINE.has(String(k.label)));
  const band = (title: string, cls: string, list: Kpi[]): ReturnType<typeof html> =>
    when(list.length, () => html`<section class="kpi-band ${cls}"><div class="kb-head">${title}</div>${kpis(list)}</section>`) as ReturnType<typeof html>;
  return html`${band('Needs attention', 'kb-attn', attention)}${band('Performance', '', performance)}${band('Leasing pipeline', '', pipeline)}`;
}

/** Micro-sparklines inside KPI tiles — the metrics with a 12-month history
 * carry their own trend line next to the headline number. */
function withSparks(items: Kpi[], t: ReturnType<typeof orgTrends>): Kpi[] {
  if (!t) return items;
  const SPARK: Record<string, { points: number[]; tone: string }> = {
    'Occupancy': { points: t.occ, tone: 'ok' },
    'Collection rate': { points: t.coll, tone: 'ok' },
    'Delinquent': { points: t.deliq, tone: 'bad' },
  };
  return items.map((k) => {
    const s = SPARK[String(k.label)];
    if (!s || s.points.length < 3) return k;
    return { ...k, sub: html`${k.sub || ''}${sparkline(s.points, { tone: s.tone, w: 72, h: 20 })}` };
  });
}

const AGENT_LABEL: Record<string, string> = {
  leasing: 'Leasing AI', maintenance: 'Maintenance AI', payments: 'Payments AI', renewals: 'Renewals AI',
  call_analysis: 'Call analysis', content: 'Content AI', ask: 'Ask StayLeased',
};

function dashHero(ctx: Ctx, opts: { kicker: string; title: string; sub: string | ReturnType<typeof html>; occupancyPct: number; actions?: ReturnType<typeof html> }): ReturnType<typeof html> {
  // AI activity leads the hero feed; general audit events fill any remainder.
  const ai = q<any>(
    `SELECT agent, title, created_at AS at FROM ai_actions WHERE org_id=? ORDER BY created_at DESC LIMIT 3`,
    ctx.orgId,
  ).map((a) => ({ user_name: AGENT_LABEL[a.agent] || 'AI', action: a.title, entity: '', at: a.at }));
  const feed: any[] = [...ai];
  if (feed.length < 3) {
    const events = q<any>(
      'SELECT user_name, action, entity, at FROM audit_events WHERE org_id=? ORDER BY at DESC LIMIT 40',
      ctx.orgId,
    );
    const seen = new Set<string>();
    for (const e of events) {
      const key = `${e.user_name}|${e.action}|${e.entity}`;
      if (seen.has(key)) continue;
      seen.add(key);
      feed.push(e);
      if (feed.length === 3) break;
    }
  }
  const pct = Math.max(0, Math.min(100, opts.occupancyPct));
  const R = 46, C = 2 * Math.PI * R;
  const ring = raw(`<svg width="108" height="108" viewBox="0 0 108 108" aria-hidden="true">
    <defs><linearGradient id="dring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#38bdf8"/><stop offset="55%" stop-color="#2563eb"/><stop offset="100%" stop-color="#4f46e5"/>
    </linearGradient></defs>
    <circle cx="54" cy="54" r="${R}" fill="none" stroke="rgba(154,170,196,.14)" stroke-width="9"/>
    <circle cx="54" cy="54" r="${R}" fill="none" stroke="url(#dring)" stroke-width="9" stroke-linecap="round"
      stroke-dasharray="${((pct / 100) * C).toFixed(1)} ${C.toFixed(1)}"/>
  </svg>`);
  return html`<div class="dash-hero">
    <div class="dh-main">
      <div class="dh-kicker">${opts.kicker}</div>
      <h1 class="dh-title">${opts.title}</h1>
      <div class="dh-sub">${opts.sub}</div>
      ${when(opts.actions, () => html`<div class="dh-actions">${opts.actions}</div>`)}
    </div>
    <div class="dh-side">
      <div class="dash-ring">${ring}<div class="dr-val"><div>${pct}%<small>occupied</small></div></div></div>
      ${when(feed.length, () => html`<div class="dash-feed">
        <div class="df-head"><i></i>Live activity</div>
        ${feed.map((e) => html`<div class="df-row"><b>${e.user_name}</b><span>${String(e.action).replaceAll('_', ' ')}${e.entity ? ` · ${String(e.entity).replaceAll('_', ' ')}` : ''}</span><span class="df-when">${e.at.slice(11, 16)}</span></div>`)}
      </div>`)}
    </div>
  </div>`;
}

function portfolioDashboard(rq: Rq) {
  const ctx = rq.ctx as Ctx;
  const sums = propertySummaries(ctx);
  const org = unitStats(ctx, null);
  const extra = dashboardExtras(ctx, null);
  const trends = orgTrends(ctx);
  const analytics = analyticsCards(ctx, trends);
  const orgName = q1<{ name: string }>('SELECT name FROM orgs WHERE id=?', ctx.orgId)?.name || 'Your portfolio';
  return shell(rq, {
    title: 'Portfolio',
    active: '/',
    bareHead: true,
    content: html`
      ${dashHero(ctx, {
        kicker: `${orgName} · ${fmtDate(ctx.businessDate)}`,
        title: 'Portfolio',
        sub: `${org.total} units across ${sums.length} propert${sums.length === 1 ? 'y' : 'ies'} · ${org.occupied} occupied · ${org.vacantReady} ready to lease`,
        occupancyPct: org.occupancyPct,
        actions: html`<a class="btn btn-sm" href="/map">${raw('<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 20 3 17V4l6 3m0 13 6-3m-6 3V7m6 10 6 3V7l-6-3m0 13V4M9 7l6-3"/></svg>')} Map view</a><a class="btn btn-sm btn-ghost" href="/leads">Log a lead</a><a class="btn btn-sm btn-ghost" href="/workorders">New work order</a><a class="btn btn-sm btn-ghost" href="/reports">Reports</a>`,
      })}
      ${onboardingBanner(ctx)}
      ${(() => {
        const ai = aiWorkPanel(ctx);
        const mapCard = dashMapCard(ctx);
        return ai.s ? html`<div class="dash-duo">${ai}${mapCard}</div>` : mapCard;
      })()}
      ${kpiBands(withSparks([
        { label: 'Units', value: org.total },
        { label: 'Occupancy', value: `${org.occupancyPct}%`, tone: org.occupancyPct >= 93 ? 'ok' : 'warn', sub: `${org.occupied} occupied` },
        { label: 'Exposure', value: `${org.exposurePct}%`, sub: `${org.exposureCount} units` },
        { label: 'Vacant ready', value: org.vacantReady, href: '/units?status=vacant_ready' },
        { label: 'Avg market rent', value: usd(org.avgMarketRentCents) },
        ...extra.kpis,
      ], trends))}
      ${analytics}
      ${card('Property comparison', tbl(
        [{ label: 'Property' }, { label: 'Type' }, { label: 'Units', num: true }, { label: 'Occupancy', num: true }, { label: 'Notice', num: true }, { label: 'Vacant ready', num: true }, { label: 'Exposure', num: true }, { label: 'Avg rent', num: true }],
        sums.map((p) => ({
          href: `/properties/${p.id}`,
          cells: [
            html`<b>${p.name}</b><span class="sub">${p.city}, ${p.state}</span>`,
            statusBadge(undefined, p.type),
            p.stats.total,
            html`<b class="${p.stats.occupancyPct >= 93 ? 'pos' : ''}">${p.stats.occupancyPct}%</b>`,
            p.stats.notice,
            p.stats.vacantReady,
            `${p.stats.exposurePct}%`,
            usd(p.stats.avgMarketRentCents),
          ],
        })),
        { empty: 'No properties yet — create one under Properties.' },
      ), { flush: true })}
      ${extra.panels}`,
  });
}

/** Later phases contribute dashboard tiles/panels here (delinquency, WOs, leasing funnel). */
type Extras = { kpis: { label: string; value: any; sub?: any; tone?: 'ok' | 'warn' | 'bad' | 'accent'; href?: string }[]; panels: any };
const extraProviders: ((ctx: Ctx, propertyId: string | null) => Extras)[] = [];
export function registerDashboardExtras(fn: (ctx: Ctx, propertyId: string | null) => Extras): void {
  extraProviders.push(fn);
}
function dashboardExtras(ctx: Ctx, propertyId: string | null): Extras {
  const out: Extras = { kpis: [], panels: [] as any[] };
  for (const fn of extraProviders) {
    try {
      const e = fn(ctx, propertyId);
      out.kpis.push(...e.kpis);
      (out.panels as any[]).push(e.panels);
    } catch (err) {
      console.error('[dashboard extras]', (err as Error).message);
    }
  }
  return out;
}

/** Amenity spaces, with the bookings they exist to produce. Configuring a
 * clubhouse at $75 a booking and then having nowhere to see the bookings meant
 * the fee was a number the operator set and never saw again: no way to tell a
 * space that earns from one that sits empty, and no way to check that a
 * booking fee actually reached a resident ledger. The rows now carry their own
 * booking counts and billed revenue, and the reservations themselves are
 * listed underneath — upcoming first, because that is the list the front desk
 * works from. */
function amenitySpacesTab(ctx: Ctx, p: any, spaces: any[]): ReturnType<typeof html> {
  const today = ctx.businessDate;
  const bookings = q<any>(
    `SELECT ar.*, s.name AS space_name, l.household_name, u.unit_number
     FROM amenity_reservations ar
     JOIN amenity_spaces s ON s.id=ar.space_id
     LEFT JOIN leases l ON l.id=ar.lease_id
     LEFT JOIN units u ON u.id=l.unit_id
     WHERE ar.property_id=? AND ar.org_id=? ORDER BY ar.date DESC, ar.start_time DESC LIMIT 400`,
    p.id, ctx.orgId,
  );
  const live = bookings.filter((b) => b.status !== 'canceled');
  const upcoming = live.filter((b) => b.date >= today).sort((a, b) => (a.date === b.date ? a.start_time.localeCompare(b.start_time) : a.date.localeCompare(b.date)));
  const past = live.filter((b) => b.date < today);
  const since = addDays(today, -90);

  // Per space: what is on the calendar, and what those bookings billed. Billed
  // (not "collected") is the honest word — the fee posts as a charge on the
  // resident ledger, and whether it has been paid is the ledger's question.
  const perSpace = new Map<string, { upcoming: number; booked90: number; billed90: number }>();
  for (const b of live) {
    const e = perSpace.get(b.space_id) || { upcoming: 0, booked90: 0, billed90: 0 };
    if (b.date >= today) e.upcoming++;
    if (b.date >= since && b.date <= today) { e.booked90++; e.billed90 += b.fee_cents || 0; }
    perSpace.set(b.space_id, e);
  }
  const paid = spaces.filter((s) => s.fee_cents > 0);
  const billed90 = paid.reduce((sum, s) => sum + (perSpace.get(s.id)?.billed90 || 0), 0);
  const bookingRow = (b: any): { cells: any[] } => ({
    cells: [
      html`<b>${fmtDate(b.date)}</b><span class="sub">${b.start_time}–${b.end_time}</span>`,
      b.space_name,
      b.lease_id
        ? html`<a href="/leases/${b.lease_id}">${b.household_name || 'Resident'}</a>${b.unit_number ? html`<span class="sub">Unit ${b.unit_number}</span>` : null}`
        : (b.household_name || '—'),
      b.guests,
      b.fee_cents ? usd(b.fee_cents) : html`<span class="muted">free</span>`,
      b.fee_cents
        ? (b.charge_id ? html`<a href="/leases/${b.lease_id}" class="badge ok">billed</a>` : html`<span class="badge warn">not billed</span>`)
        : '—',
    ],
  });

  return html`
    ${when(paid.length, () => kpis([
      { label: 'Paid spaces', value: paid.length, sub: `${spaces.length - paid.length} free to reserve` },
      { label: 'Upcoming bookings', value: upcoming.length, sub: upcoming.length ? `next ${fmtDate(upcoming[0]!.date)}` : 'nothing on the calendar' },
      { label: 'Billed · last 90 days', value: usd(billed90), sub: `${paid.reduce((n, s) => n + (perSpace.get(s.id)?.booked90 || 0), 0)} paid bookings` },
    ]))}
    ${card('Bookable amenity spaces', html`${tbl(
      [{ label: 'Space' }, { label: 'Capacity', num: true }, { label: 'Fee', num: true }, { label: 'Hours' }, { label: 'Bookable' }, { label: 'Upcoming', num: true }, { label: 'Billed · 90d', num: true }],
      spaces.map((s) => {
        const e = perSpace.get(s.id) || { upcoming: 0, booked90: 0, billed90: 0 };
        return {
          cells: [
            html`<b>${s.name}</b><span class="sub">${s.description || ''}</span>`,
            s.capacity ?? '—',
            s.fee_cents ? usd(s.fee_cents) : html`<span class="muted">free</span>`,
            `${s.open_time}–${s.close_time}`,
            statusBadge(s.bookable ? 'yes' : 'no'),
            e.upcoming || html`<span class="muted">—</span>`,
            s.fee_cents ? usd(e.billed90) : '—',
          ],
        };
      }),
      { empty: 'No amenity spaces configured.' },
    )}
    ${when(ctx.perms.has('units:manage'), () => html`<form method="post" action="/properties/${p.id}/spaces" class="toolbar" style="margin-top:10px">
      ${field('Name', input('name', { required: true, placeholder: 'Clubhouse' }))}
      ${field('Capacity', input('capacity', { type: 'number', value: 20 }))}
      ${field('Fee', moneyInput('fee', 0))}
      <button class="btn">Add space</button>
    </form>`)}`)}
    ${card('Upcoming bookings', tbl(
      [{ label: 'When' }, { label: 'Space' }, { label: 'Reserved by' }, { label: 'Guests', num: true }, { label: 'Fee', num: true }, { label: 'Charge' }],
      upcoming.slice(0, 40).map(bookingRow),
      { empty: spaces.length ? 'Nothing booked from today forward. Residents reserve spaces from the resident portal.' : 'Add a bookable space and reservations will appear here.' },
    ), { flush: true })}
    ${when(past.length, () => card('Recent bookings', tbl(
      [{ label: 'When' }, { label: 'Space' }, { label: 'Reserved by' }, { label: 'Guests', num: true }, { label: 'Fee', num: true }, { label: 'Charge' }],
      past.slice(0, 25).map(bookingRow),
      { empty: 'No past bookings.' },
    ), { flush: true }))}`;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The property profile, formatted as the record it is rather than as an
 * undifferentiated list of label/value pairs. A definition list gave equal
 * weight to the street address, the fiscal calendar and the time zone, so
 * nothing was findable at a glance. Here the identity of the place (address,
 * how to reach the office, where the public site lives) sits at the top where
 * it is read, and the settings that govern how the software treats the
 * property sit below it in a scannable grid.
 *
 * Phone and email are dialable and mailable — a manager looking at this card
 * usually wants to contact the office, not to read a string. */
function propertyProfile(p: any, counts: { buildings: number; floorplans: number; units: number }): ReturnType<typeof html> {
  const fact = (k: string, v: string | number | null, sub?: string | null): ReturnType<typeof html> =>
    html`<div class="pp-fact"><dt>${k}</dt><dd>${v ?? '—'}${when(sub, () => html`<span class="pp-sub">${sub}</span>`)}</dd></div>`;
  const fyStart = MONTH_NAMES[(Number(p.fiscal_year_start_month) || 1) - 1] || `Month ${p.fiscal_year_start_month}`;
  return html`<div class="prop-profile">
    <div class="pp-ident">
      <div class="pp-addr">
        <div class="pp-street">${p.address1}</div>
        <div class="pp-csz">${p.city}, ${p.state} ${p.zip}</div>
      </div>
      ${statusBadge(undefined, p.type)}
    </div>
    <div class="pp-contact">
      ${p.phone ? html`<a href="tel:${String(p.phone).replace(/[^\d+]/g, '')}">${p.phone}</a>` : html`<span class="pp-none">No office phone</span>`}
      ${p.email ? html`<a href="mailto:${p.email}">${p.email}</a>` : html`<span class="pp-none">No office email</span>`}
      <a href="/p/${p.slug}" target="_blank" rel="noopener">Public site ↗</a>
    </div>
    <dl class="pp-facts">
      ${fact('Time zone', timezoneLabel(p.timezone), p.timezone)}
      ${fact('Year built', p.year_built || '—')}
      ${fact('Fiscal year starts', fyStart)}
      ${fact('Inventory', `${counts.units} unit${counts.units === 1 ? '' : 's'}`, `${counts.buildings} building${counts.buildings === 1 ? '' : 's'} · ${counts.floorplans} floorplan${counts.floorplans === 1 ? '' : 's'}`)}
    </dl>
  </div>`;
}

/** Leasing analytics for one property. The portfolio dashboard already charts
 * the org-wide funnel; a property manager standing on their own property page
 * needs the version scoped to the building they run, and needs the two numbers
 * the funnel cannot show: how fast inquiries get answered, and how many open
 * leads have gone quiet. Speed-to-lead is first because it is the input the
 * team controls today; conversion is the output it produces weeks later. */
function leasingPanel(ctx: Ctx, p: any): ReturnType<typeof html> {
  if (!ctx.perms.has('leasing:view')) return html``;
  const since = addMonths(ctx.businessDate, -3);
  const f = funnelStats(ctx, since, p.id);
  const perf = leadPerformance(ctx, p.id, since);
  if (!f.inquiries && !perf.open) {
    return card('Leasing performance', emptyState(
      'No leads recorded for this property yet.',
      'Lead analytics — response time, conversion by source, and cost per lease — appear here once inquiries start arriving.',
      html`<a class="btn btn-sm" href="/leads">Log a lead</a>`,
    ));
  }
  const rate = (n: number, d: number): string => (d ? `${Math.round((n / d) * 1000) / 10}%` : '—');
  const respTone = perf.medianResponseHours === null ? undefined : perf.medianResponseHours <= 1 ? 'ok' : perf.medianResponseHours <= 8 ? 'warn' : 'bad';
  const respValue = perf.medianResponseHours === null
    ? '—'
    : perf.medianResponseHours < 1 ? `${Math.round(perf.medianResponseHours * 60)}m` : `${perf.medianResponseHours}h`;

  // Cost per lease is the number that decides next month's ad spend, so a
  // source with spend but no leases must read as "no leases yet" rather than
  // as a blank — a blank looks like missing data, not like a bad channel.
  const sourceRows = f.bySource.map((s) => ({
    cells: [
      html`<b>${String(s.source).replaceAll('_', ' ')}</b>`,
      s.inquiries,
      s.tours,
      s.apps,
      html`<b>${s.leases}</b>`,
      rate(s.leases, s.inquiries),
      s.costCents ? usd(s.costCents) : '—',
      s.costCents ? (s.leases ? usd(Math.round(s.costCents / s.leases)) : html`<span class="muted">no leases yet</span>`) : '—',
    ],
  }));

  return html`${card('Leasing performance · last 90 days', html`
    ${kpis([
      { label: 'Median response', value: respValue, tone: respTone as any, sub: perf.respondedWithinHour === null ? 'no outbound replies yet' : `${perf.respondedWithinHour}% answered within the hour` },
      { label: 'Leads (90d)', value: f.inquiries, sub: `${perf.last30} in the last 30 days`, href: `/leads?property=${p.id}` },
      { label: 'Working now', value: perf.open, tone: perf.stale > 0 ? 'warn' : undefined, sub: perf.stale ? `${perf.stale} untouched 7+ days` : 'all touched this week', href: `/leads?property=${p.id}` },
      { label: 'Lead to lease', value: rate(f.leased, f.inquiries), sub: `${f.leased} signed` },
      { label: 'Tour rate', value: rate(f.toured, f.inquiries), sub: `${f.toured} toured` },
      { label: 'Days to lease', value: perf.medianDaysToLease === null ? '—' : `${perf.medianDaysToLease}`, sub: 'median, inquiry to signature' },
    ])}
    <div class="grid cols-2 chart-pair" style="margin-top:12px">
      <div>
        <div class="pp-chart-title">Conversion</div>
        ${funnelChart([
          { label: 'Inquiries', value: f.inquiries },
          { label: 'Toured', value: f.toured },
          { label: 'Applied', value: f.applied },
          { label: 'Leased', value: f.leased },
        ])}
      </div>
      <div>
        <div class="pp-chart-title">Leads by month · last 12</div>
        ${barChart(perf.byMonth.map((m) => m.label), perf.byMonth.map((m) => m.value), { kind: 'num' })}
      </div>
    </div>`)}
  ${card('Lead sources · last 90 days', tbl(
    [{ label: 'Source' }, { label: 'Leads', num: true }, { label: 'Tours', num: true }, { label: 'Applications', num: true }, { label: 'Leases', num: true }, { label: 'Conversion', num: true }, { label: 'Spend', num: true }, { label: 'Cost per lease', num: true }],
    sourceRows,
    { empty: 'No leads in the last 90 days.' },
  ), { flush: true })}`;
}

function getProp(ctx: Ctx, pid: string): any {
  const p = q1<any>('SELECT * FROM properties WHERE id=? AND org_id=?', pid, ctx.orgId);
  if (!p || !canAccessProperty(ctx, p.id)) return undefined;
  return p;
}

function swapParam(rq: Rq, key: string, value: string): string {
  const sp = new URLSearchParams(rq.query);
  sp.set(key, value);
  return `${rq.path}?${sp}`;
}
