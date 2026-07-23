import { onboardingBanner } from '../setup/onboarding.ts';
import { marketingHome } from '../m4_marketing/homepage.ts';
import { landingFor } from '../auth/pages.ts';
import { html, raw, when, join } from '../../lib/html.ts';
import { redirect, notFound, badRequest, type Router, type Rq } from '../../lib/http.ts';
import { requirePerm, requireStaff, propFilter, canAccessProperty, type Ctx , type UserRow } from '../../lib/auth.ts';
import { q, q1, run, insert, update, val, j, js } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, fmtDate, addMonths, addDays } from '../../lib/dates.ts';
import { usd } from '../../lib/money.ts';
import { audit } from '../../lib/audit.ts';
import { v } from '../../lib/validate.ts';
import {
  shell, card, tbl, kpis, dl, tabs, statusBadge, field, input, select, textarea,
  registerNav, registerSearch, emptyState, historyPanel, checkbox, moneyInput,
} from '../../ui/ui.ts';
import { donut, bars, sparkline, barChart, areaChart, funnelChart, splitBar } from '../../lib/charts.ts';
import { funnelStats } from '../m3_crm/service.ts';
import {
  unitStats, floorplanAvailability, propertySummaries, unitAmenities, effectiveMarketRent,
  UNIT_STATUSES, UNIT_STATUS_LABELS,
} from './service.ts';

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
  ['multifamily', 'Multifamily'], ['student', 'Student housing'], ['affordable', 'Affordable'],
  ['military', 'Military'], ['commercial', 'Commercial'], ['manufactured', 'Manufactured housing'],
];

export function routes(r: Router): void {
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
        ${field('Timezone (IANA)', select('timezone', ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles'].map((z): [string, string] => [z, z]), p?.timezone ?? 'America/Denver'))}
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
      body = html`${card('Bookable amenity spaces', html`${tbl(
        [{ label: 'Space' }, { label: 'Capacity', num: true }, { label: 'Fee', num: true }, { label: 'Hours' }, { label: 'Bookable' }],
        spaces.map((s) => ({
          cells: [html`<b>${s.name}</b><span class="sub">${s.description || ''}</span>`, s.capacity ?? '—', usd(s.fee_cents), `${s.open_time}–${s.close_time}`, statusBadge(s.bookable ? 'yes' : 'no')],
        })),
        { empty: 'No amenity spaces configured.' },
      )}
      ${when(ctx.perms.has('units:manage'), () => html`<form method="post" action="/properties/${p.id}/spaces" class="toolbar" style="margin-top:10px">
        ${field('Name', input('name', { required: true, placeholder: 'Clubhouse' }))}
        ${field('Capacity', input('capacity', { type: 'number', value: 20 }))}
        ${field('Fee', moneyInput('fee', 0))}
        <button class="btn">Add space</button>
      </form>`)}`)}`;
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
          ${card('Property profile', dl([
            ['Address', `${p.address1}, ${p.city}, ${p.state} ${p.zip}`],
            ['Type', statusBadge(undefined, p.type)],
            ['Timezone', p.timezone],
            ['Office', p.phone || '—'],
            ['Email', p.email || '—'],
            ['Year built', p.year_built || '—'],
            ['Fiscal year start', `Month ${p.fiscal_year_start_month}`],
            ['Public site', html`<a href="/p/${p.slug}" target="_blank">/p/${p.slug} ↗</a>`],
          ]))}
        </div>
        ${card('Floorplan availability', bars(
          fps.map((f) => ({ label: `${f.name} · ${f.beds === 0 ? 'Studio' : f.beds + 'bd'}`, value: f.available, href: `/units?property=${p.id}&floorplan=${f.id}` })),
        ))}`;
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
    return shell(rq, { title: `Edit ${p.name}`, active: '/properties', crumbs: [['Properties', '/properties'], [p.name, `/properties/${p.id}`]], content: card(null, propertyForm(p)) });
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
      body = html`<div class="board">${UNIT_STATUSES.map((s) => {
        const list = byStatus.get(s) || [];
        return html`<div class="col">
          <div class="col-head"><span>${UNIT_STATUS_LABELS[s]}</span><span class="badge">${list.length}</span></div>
          <div class="col-body">${list.slice(0, 40).map((u) => html`<a class="bcard" href="/units/${u.id}">
            <b>${u.unit_number}</b> · ${u.fp_name || '—'}
            <span class="sub">${u.prop_name}${u.building ? ` · ${u.building}` : ''} · ${usd(u.market_rent_cents)}</span>
          </a>`)}${list.length > 40 ? html`<a class="small" href="/units?view=list&status=${s}&property=${propId}">+ ${list.length - 40} more…</a>` : null}</div>
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
    if (!u) return notFound();
    const to = String(rq.body.status || '');
    // manual transitions limited to non-lease states; occupied/notice always derive from lease events (M2.2)
    if (!['down', 'model', 'vacant_not_ready', 'vacant_ready'].includes(to)) return badRequest('That status is driven by lease events.');
    if (['occupied', 'notice'].includes(u.status)) return redirect(`/units/${u.id}`, 'Occupied/notice units change via lease events, not manually.', 'err');
    update('units', u.id, { status: to });
    audit(ctx, 'unit', u.id, 'status_change', { status: u.status }, { status: to });
    return redirect(`/units/${u.id}`, `Unit marked ${UNIT_STATUS_LABELS[to]}.`);
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
    subtitle: `${p.city}, ${p.state} · property dashboard · business date ${fmtDate(ctx.businessDate)}`,
    actions: html`<a class="btn btn-ghost" href="/properties/${p.id}">Property setup</a>`,
    content: html`
      ${kpis([
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
function analyticsCards(ctx: Ctx): ReturnType<typeof html> {
  const t = orgTrends(ctx);
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
      ${card('Delinquency', html`<div class="chart-head-val neg">${usd(last(t!.deliq) * 100)}</div>${areaChart(monthLabels, t!.deliq, { kind: 'usd', color: '#b3261e' })}`)}
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

function portfolioDashboard(rq: Rq) {
  const ctx = rq.ctx as Ctx;
  const sums = propertySummaries(ctx);
  const org = unitStats(ctx, null);
  const extra = dashboardExtras(ctx, null);
  const analytics = analyticsCards(ctx);
  return shell(rq, {
    title: 'Portfolio',
    active: '/',
    subtitle: `Roll-up across ${sums.length} propert${sums.length === 1 ? 'y' : 'ies'} · business date ${fmtDate(ctx.businessDate)}`,
    content: html`
      ${onboardingBanner(ctx)}
      ${kpis([
        { label: 'Units', value: org.total },
        { label: 'Occupancy', value: `${org.occupancyPct}%`, tone: org.occupancyPct >= 93 ? 'ok' : 'warn', sub: `${org.occupied} occupied` },
        { label: 'Exposure', value: `${org.exposurePct}%`, sub: `${org.exposureCount} units` },
        { label: 'Vacant ready', value: org.vacantReady, href: '/units?status=vacant_ready' },
        { label: 'Avg market rent', value: usd(org.avgMarketRentCents) },
        ...extra.kpis,
      ])}
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
