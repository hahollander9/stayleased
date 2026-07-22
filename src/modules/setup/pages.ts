import { html, raw, join, when, type Raw, type Child } from '../../lib/html.ts';
import { redirect, notFound, fileRes, type Router, type Rq } from '../../lib/http.ts';
import { requireStaff, requirePerm, can, type Ctx } from '../../lib/auth.ts';
import { q, q1, insert, tx } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso } from '../../lib/dates.ts';
import { audit } from '../../lib/audit.ts';
import { parseCsvObjects } from '../../lib/csv.ts';
import { v } from '../../lib/validate.ts';
import { shell, card, kpis, tbl, field, input, select, moneyInput, statusBadge, emptyState } from '../../ui/ui.ts';

/** M2.5 Setup hub: the gear → administration landing, a guided property
 * onboarding wizard, and a CSV Migration Center for bulk-importing a
 * portfolio (properties, floorplans, units) when moving off another system. */

const PROPERTY_TYPES: [string, string][] = [
  ['multifamily', 'Multifamily'], ['student', 'Student housing'], ['affordable', 'Affordable'],
  ['military', 'Military'], ['commercial', 'Commercial'], ['manufactured', 'Manufactured housing'],
];
const TIMEZONES: [string, string][] = [
  ['America/New_York', 'Eastern (New York)'], ['America/Chicago', 'Central (Chicago)'],
  ['America/Denver', 'Mountain (Denver)'], ['America/Phoenix', 'Mountain — no DST (Phoenix)'],
  ['America/Los_Angeles', 'Pacific (Los Angeles)'],
];

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

// ---------- setup hub ----------

interface HubCard { href: string; title: string; desc: string; perm?: string; icon: string; }
const HUB: HubCard[] = [
  { href: '/setup/wizard', title: 'Add a property', desc: 'Guided wizard — property details, a floorplan, and its units.', perm: 'properties:manage', icon: 'M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6' },
  { href: '/setup/import', title: 'Migration Center', desc: 'Bulk-import properties, floorplans and units from CSV.', perm: 'properties:manage', icon: 'M12 3v12m0 0 4-4m-4 4-4-4M4 21h16' },
  { href: '/admin/settings', title: 'Organization settings', desc: 'Policies, fees, and defaults for your whole portfolio.', perm: 'admin:settings', icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.3 1a7 7 0 0 0-1.7-1L14.5 3h-4l-.4 2.6a7 7 0 0 0-1.7 1l-2.3-1-2 3.4 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7 7 0 0 0 1.7-1l2.3 1 2-3.4-2-1.5A7 7 0 0 0 19 12z' },
  { href: '/admin/staff', title: 'Staff & roles', desc: 'Invite users and assign roles and property scope.', perm: 'admin:staff', icon: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75' },
  { href: '/admin/roles', title: 'Permission matrix', desc: 'Review exactly what each role can do.', perm: 'admin:staff', icon: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11' },
  { href: '/admin/api', title: 'API & webhooks', desc: 'Keys and webhook endpoints for integrations.', perm: 'admin:api', icon: 'M4 17l6-6-6-6M12 19h8' },
  { href: '/admin/jobs', title: 'Scheduled jobs', desc: 'The automation engine and its run history.', perm: 'admin:jobs', icon: 'M12 6v6l4 2M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z' },
  { href: '/admin/audit', title: 'Audit log', desc: 'Every change, who made it, and when.', perm: 'admin:audit', icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 15h6M9 11h2' },
  { href: '/dev/sim', title: 'Simulator console', desc: 'Advance the business date and drive the demo world.', perm: 'dev:console', icon: 'M13 2L3 14h9l-1 8 10-12h-9z' },
];

function svgIcon(d: string): Raw {
  return raw(`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`);
}

export function routes(r: Router): void {
  r.get('/setup', requireStaff, (rq) => {
    const ctx = rq.ctx as Ctx;
    const cards = HUB.filter((c) => !c.perm || can(ctx, c.perm));
    const propCount = q1<{ n: number }>('SELECT COUNT(*) n FROM properties WHERE org_id=?', ctx.orgId)?.n ?? 0;
    const unitCount = q1<{ n: number }>('SELECT COUNT(*) n FROM units u JOIN properties p ON p.id=u.property_id WHERE p.org_id=?', ctx.orgId)?.n ?? 0;
    const staffCount = q1<{ n: number }>("SELECT COUNT(*) n FROM users WHERE org_id=? AND kind='staff' AND active=1", ctx.orgId)?.n ?? 0;
    return shell(rq, {
      title: 'Setup',
      active: '/setup',
      subtitle: 'Configure your portfolio, onboard properties, and administer StayLeased.',
      content: html`
        ${kpis([
          { label: 'Properties', value: String(propCount), href: '/properties' },
          { label: 'Units', value: String(unitCount), href: '/units' },
          { label: 'Staff', value: String(staffCount), href: '/admin/staff' },
        ])}
        <div class="setup-grid">
          ${cards.map((c) => html`<a class="setup-card" href="${c.href}">
            <div class="sc-icon">${svgIcon(c.icon)}</div>
            <div><div class="sc-title">${c.title}</div><div class="sc-desc">${c.desc}</div></div>
          </a>`)}
        </div>`,
    });
  });

  // ---------- property wizard ----------
  r.get('/setup/wizard', requirePerm('properties:manage'), (rq) => wizardPage(rq));

  r.post('/setup/wizard', requirePerm('properties:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const b = rq.body;
    const name = String(b.name || '').trim();
    const slug = slugify(String(b.slug || name));
    const errs: string[] = [];
    if (name.length < 2) errs.push('Property name is required.');
    if (!slug || slug.length < 2) errs.push('A valid URL slug is required.');
    if (slug && q1('SELECT id FROM properties WHERE slug=?', slug)) errs.push('That URL slug is already in use.');
    const type = PROPERTY_TYPES.some((t) => t[0] === b.type) ? String(b.type) : 'multifamily';
    const state = String(b.state || '').trim().toUpperCase().slice(0, 2);
    if (String(b.address1 || '').trim().length < 3) errs.push('Street address is required.');
    if (String(b.city || '').trim().length < 2) errs.push('City is required.');
    if (state.length !== 2) errs.push('State must be a 2-letter code.');
    if (String(b.zip || '').trim().length < 5) errs.push('A 5-digit ZIP is required.');
    const beds = parseInt(String(b.fp_beds || '1'), 10) || 0;
    const baths = parseFloat(String(b.fp_baths || '1')) || 1;
    const sqft = parseInt(String(b.fp_sqft || '700'), 10) || 700;
    let rentCents = 0;
    try { rentCents = v.cents().parse(b.fp_rent); } catch { errs.push('Enter a valid market rent for the floorplan.'); }
    const unitCount = Math.max(0, Math.min(500, parseInt(String(b.unit_count || '0'), 10) || 0));
    const startNo = parseInt(String(b.unit_start || '101'), 10) || 101;
    if (errs.length) return wizardPage(rq, errs, b);

    const pid = id('prp');
    tx(() => {
      insert('properties', {
        id: pid, org_id: ctx.orgId, name, slug, type, timezone: String(b.timezone || 'America/Denver'),
        address1: String(b.address1).trim(), city: String(b.city).trim(), state, zip: String(b.zip).trim(),
        phone: String(b.phone || '') || null, email: String(b.email || '') || null,
        year_built: b.year_built ? parseInt(String(b.year_built), 10) : null,
        fiscal_year_start_month: 1, created_at: nowIso(),
      });
      const fid = id('fpl');
      insert('floorplans', {
        id: fid, org_id: ctx.orgId, property_id: pid, name: String(b.fp_name || 'Plan A'),
        beds, baths, sqft, market_rent_cents: rentCents, created_at: nowIso(),
      });
      for (let i = 0; i < unitCount; i++) {
        insert('units', {
          id: id('unt'), org_id: ctx.orgId, property_id: pid, building_id: null, floorplan_id: fid,
          unit_number: String(startNo + i), floor: 1, sqft, status: 'vacant_ready',
          market_rent_cents: rentCents, amenities: '[]', notes: null, created_at: nowIso(),
        });
      }
      audit(ctx, 'property', pid, 'create', null, { name, slug, type, units: unitCount });
    });
    return redirect(`/properties/${pid}`, `${name} created with ${unitCount} unit${unitCount === 1 ? '' : 's'}. Add buildings, amenities and pricing next.`);
  });

  // ---------- Migration Center ----------
  r.get('/setup/import', requirePerm('properties:manage'), (rq) => importPage(rq));
  r.post('/setup/import', requirePerm('properties:manage'), (rq) => runImport(rq));
  r.get('/setup/import/template', requirePerm('properties:manage'), (rq) => {
    const spec = IMPORTS[rq.query.get('entity') || 'units'] || IMPORTS.units!;
    const csv = spec.sample.map((row) => row.join(',')).join('\r\n') + '\r\n';
    return fileRes(csv, 'text/csv; charset=utf-8', { filename: `stayleased-${spec.key}-template.csv` });
  });
}

function stepHead(n: number, title: string): Raw {
  return html`<div class="wiz-step"><span class="wiz-num">${n}</span><h2>${title}</h2></div>`;
}

function wizardPage(rq: Rq, errs: string[] = [], b: Record<string, any> = {}): ReturnType<typeof shell> {
  const val = (k: string, d = ''): string => String(b[k] ?? d);
  return shell(rq, {
    title: 'Add a property',
    active: '/setup/wizard',
    crumbs: [['Setup', '/setup'], ['Add a property']],
    subtitle: 'Create a property, its first floorplan, and its units in one step. You can refine everything afterward.',
    content: html`
      ${when(errs.length, () => html`<div class="flash err">${errs.join(' ')}</div>`)}
      <form method="post" action="/setup/wizard" class="wiz">
        ${card(null, html`
          ${stepHead(1, 'Property details')}
          <div class="form-grid">
            ${field('Property name', input('name', { value: val('name'), placeholder: 'Summit Ridge Apartments', required: true }))}
            ${field('URL slug', input('slug', { value: val('slug'), placeholder: 'summit-ridge' }), 'Used in the public site address /p/<slug>. Leave blank to auto-generate.')}
            ${field('Type', select('type', PROPERTY_TYPES, val('type', 'multifamily')))}
            ${field('Time zone', select('timezone', TIMEZONES, val('timezone', 'America/Denver')))}
          </div>
          <div class="form-grid">
            ${field('Street address', input('address1', { value: val('address1'), placeholder: '100 Summit Way', required: true }))}
            ${field('City', input('city', { value: val('city'), required: true }))}
            ${field('State', input('state', { value: val('state'), placeholder: 'CO', max: '2' }))}
            ${field('ZIP', input('zip', { value: val('zip'), placeholder: '80202' }))}
          </div>
          <div class="form-grid">
            ${field('Leasing phone (optional)', input('phone', { value: val('phone') }))}
            ${field('Leasing email (optional)', input('email', { type: 'email', value: val('email') }))}
            ${field('Year built (optional)', input('year_built', { type: 'number', value: val('year_built') }))}
          </div>
        `)}
        ${card(null, html`
          ${stepHead(2, 'First floorplan')}
          <div class="form-grid">
            ${field('Floorplan name', input('fp_name', { value: val('fp_name', 'Plan A') }))}
            ${field('Beds', input('fp_beds', { type: 'number', value: val('fp_beds', '1'), min: '0' }))}
            ${field('Baths', input('fp_baths', { type: 'number', value: val('fp_baths', '1'), step: '0.5', min: '0' }))}
            ${field('Sq ft', input('fp_sqft', { type: 'number', value: val('fp_sqft', '750'), min: '0' }))}
            ${field('Market rent', moneyInput('fp_rent', b.fp_rent !== undefined ? undefined : 1500_00, { required: true }))}
          </div>
        `)}
        ${card(null, html`
          ${stepHead(3, 'Units')}
          <div class="form-grid">
            ${field('How many units?', input('unit_count', { type: 'number', value: val('unit_count', '12'), min: '0', max: '500' }), 'Created vacant-ready on this floorplan. Max 500 in the wizard — use the Migration Center for larger imports.')}
            ${field('First unit number', input('unit_start', { type: 'number', value: val('unit_start', '101') }))}
          </div>
        `)}
        <div class="wiz-actions">
          <a class="btn btn-ghost" href="/setup">Cancel</a>
          <button class="btn" type="submit">Create property</button>
        </div>
      </form>`,
  });
}

// ---------- Migration Center specs ----------

interface ImportSpec {
  key: string;
  label: string;
  needsProperty: boolean;
  columns: { name: string; required?: boolean; hint?: string }[];
  sample: string[][];
  importRow(ctx: Ctx, propertyId: string | null, row: Record<string, string>, cache: Map<string, string>): { ok: boolean; msg: string };
}

function num(s: string | undefined, d = 0): number { const n = parseInt(String(s ?? ''), 10); return Number.isFinite(n) ? n : d; }
function cents(s: string | undefined): number { const n = Math.round(parseFloat(String(s ?? '').replace(/[$,]/g, '')) * 100); return Number.isFinite(n) ? n : 0; }

const IMPORTS: Record<string, ImportSpec> = {
  properties: {
    key: 'properties', label: 'Properties', needsProperty: false,
    columns: [
      { name: 'name', required: true }, { name: 'slug', hint: 'auto from name if blank' },
      { name: 'type', hint: 'multifamily | student | affordable | military | commercial | manufactured' },
      { name: 'address1', required: true }, { name: 'city', required: true }, { name: 'state', required: true }, { name: 'zip', required: true },
    ],
    sample: [
      ['name', 'slug', 'type', 'address1', 'city', 'state', 'zip'],
      ['Harbor Point', 'harbor-point', 'multifamily', '400 Bay St', 'Seattle', 'WA', '98101'],
    ],
    importRow(ctx, _p, row) {
      const name = (row.name || '').trim();
      if (name.length < 2) return { ok: false, msg: 'name required' };
      const slug = slugify(row.slug || name);
      if (q1('SELECT id FROM properties WHERE slug=?', slug)) return { ok: false, msg: `slug "${slug}" already exists` };
      const type = PROPERTY_TYPES.some((t) => t[0] === row.type) ? row.type! : 'multifamily';
      const state = (row.state || '').trim().toUpperCase().slice(0, 2);
      if (state.length !== 2) return { ok: false, msg: 'state must be 2 letters' };
      const pid = id('prp');
      insert('properties', {
        id: pid, org_id: ctx.orgId, name, slug, type, timezone: 'America/Denver',
        address1: (row.address1 || '').trim(), city: (row.city || '').trim(), state, zip: (row.zip || '').trim(),
        phone: null, email: null, year_built: null, fiscal_year_start_month: 1, created_at: nowIso(),
      });
      audit(ctx, 'property', pid, 'import');
      return { ok: true, msg: `created ${name}` };
    },
  },
  floorplans: {
    key: 'floorplans', label: 'Floorplans', needsProperty: true,
    columns: [
      { name: 'name', required: true }, { name: 'beds', required: true }, { name: 'baths', required: true },
      { name: 'sqft', required: true }, { name: 'market_rent', required: true, hint: 'dollars, e.g. 1495' },
    ],
    sample: [['name', 'beds', 'baths', 'sqft', 'market_rent'], ['A1 — 1x1', '1', '1', '720', '1495'], ['B2 — 2x2', '2', '2', '1080', '1975']],
    importRow(ctx, pid, row) {
      const name = (row.name || '').trim();
      if (!name) return { ok: false, msg: 'name required' };
      if (q1('SELECT id FROM floorplans WHERE property_id=? AND name=?', pid, name)) return { ok: false, msg: `"${name}" already exists` };
      insert('floorplans', {
        id: id('fpl'), org_id: ctx.orgId, property_id: pid, name, beds: num(row.beds, 1),
        baths: parseFloat(row.baths || '1') || 1, sqft: num(row.sqft, 700), market_rent_cents: cents(row.market_rent), created_at: nowIso(),
      });
      return { ok: true, msg: `created ${name}` };
    },
  },
  units: {
    key: 'units', label: 'Units', needsProperty: true,
    columns: [
      { name: 'unit_number', required: true }, { name: 'floorplan', required: true, hint: 'floorplan name; created if new' },
      { name: 'sqft' }, { name: 'market_rent', hint: 'dollars' }, { name: 'status', hint: 'vacant_ready | occupied | down | model' }, { name: 'floor' },
    ],
    sample: [['unit_number', 'floorplan', 'sqft', 'market_rent', 'status', 'floor'], ['101', 'A1 — 1x1', '720', '1495', 'vacant_ready', '1'], ['102', 'A1 — 1x1', '720', '1495', 'occupied', '1']],
    importRow(ctx, pid, row, cache) {
      const no = (row.unit_number || '').trim();
      if (!no) return { ok: false, msg: 'unit_number required' };
      if (q1('SELECT id FROM units WHERE property_id=? AND unit_number=?', pid, no)) return { ok: false, msg: `unit ${no} already exists` };
      const fpName = (row.floorplan || 'Plan A').trim();
      let fid = cache.get(fpName) || q1<{ id: string }>('SELECT id FROM floorplans WHERE property_id=? AND name=?', pid, fpName)?.id;
      const rent = cents(row.market_rent);
      const sqft = num(row.sqft, 700);
      if (!fid) {
        fid = id('fpl');
        insert('floorplans', { id: fid, org_id: ctx.orgId, property_id: pid, name: fpName, beds: 1, baths: 1, sqft, market_rent_cents: rent || 1200_00, created_at: nowIso() });
      }
      cache.set(fpName, fid);
      const status = ['vacant_ready', 'vacant_not_ready', 'occupied', 'notice', 'down', 'model'].includes(row.status || '') ? row.status! : 'vacant_ready';
      insert('units', {
        id: id('unt'), org_id: ctx.orgId, property_id: pid, building_id: null, floorplan_id: fid,
        unit_number: no, floor: num(row.floor, 1), sqft, status,
        market_rent_cents: rent || cents(String((q1<{ c: number }>('SELECT market_rent_cents c FROM floorplans WHERE id=?', fid)?.c ?? 120000) / 100)),
        amenities: '[]', notes: null, created_at: nowIso(),
      });
      return { ok: true, msg: `unit ${no}` };
    },
  },
};

function csvFromRequest(rq: Rq): string {
  if (rq.uploads && rq.uploads.length) {
    const up = rq.uploads.find((u) => u.field === 'file');
    if (up && up.data.length) return up.data.toString('utf8');
  }
  return String(rq.body.csv || '');
}

function importPage(rq: Rq, opts: { entity?: string; property?: string; csv?: string; errs?: string[] } = {}): ReturnType<typeof shell> {
  const ctx = rq.ctx as Ctx;
  const entity = opts.entity || rq.query.get('entity') || 'units';
  const spec = IMPORTS[entity] || IMPORTS.units!;
  const props = q<{ id: string; name: string }>(
    ctx.allProperties
      ? 'SELECT id, name FROM properties WHERE org_id=? ORDER BY name'
      : `SELECT id, name FROM properties WHERE org_id=? AND id IN (${ctx.propertyIds.map(() => '?').join(',') || "''"}) ORDER BY name`,
    ...(ctx.allProperties ? [ctx.orgId] : [ctx.orgId, ...ctx.propertyIds]),
  );
  const templateLink = `/setup/import/template?entity=${spec.key}`;
  return shell(rq, {
    title: 'Migration Center',
    active: '/setup/import',
    crumbs: [['Setup', '/setup'], ['Migration Center']],
    subtitle: 'Bulk-import your portfolio from CSV. Download the template, fill it in, then preview before you commit.',
    content: html`
      ${when(opts.errs?.length, () => html`<div class="flash err">${opts.errs!.join(' ')}</div>`)}
      <div class="tabs">${Object.values(IMPORTS).map((s) => html`<a href="/setup/import?entity=${s.key}" class="${s.key === entity ? 'active' : ''}">${s.label}</a>`)}</div>
      ${card('Import ' + spec.label.toLowerCase(), html`
        <form method="post" action="/setup/import" enctype="multipart/form-data">
          <input type="hidden" name="entity" value="${spec.key}" />
          <div class="form-grid">
            ${when(spec.needsProperty, () => field('Into property', props.length
              ? select('property', props.map((p) => [p.id, p.name] as [string, Child]), opts.property || '', { required: true })
              : html`<span class="muted">No properties yet — <a href="/setup/wizard">add one first</a>.</span>`))}
            ${field('Upload CSV file', raw('<input type="file" name="file" accept=".csv,text/csv" />'), 'Or paste the CSV contents below.')}
          </div>
          ${field('Paste CSV', raw(`<textarea name="csv" rows="7" placeholder="${spec.columns.map((c) => c.name).join(',')}">${opts.csv ? opts.csv.replace(/</g, '&lt;') : ''}</textarea>`))}
          <div class="wiz-actions">
            <a class="btn btn-ghost" href="${templateLink}">Download template</a>
            <button class="btn" type="submit" name="mode" value="preview">Preview import</button>
          </div>
        </form>
        <div class="callout info" style="margin-top:12px"><b>Columns:</b> ${join(spec.columns.map((c) => html`<code>${c.name}</code>${c.required ? html`<span class="req">*</span>` : ''}${c.hint ? html` <span class="muted">(${c.hint})</span>` : ''}`), raw(' · ').s)}</div>
      `)}`,
  });
}

function runImport(rq: Rq) {
  const ctx = rq.ctx as Ctx;
  const entity = String(rq.body.entity || 'units');
  const spec = IMPORTS[entity];
  if (!spec) return notFound('Unknown import type');
  const propertyId = spec.needsProperty ? String(rq.body.property || '') : null;
  const csv = csvFromRequest(rq);
  const errs: string[] = [];
  if (spec.needsProperty && !propertyId) errs.push('Choose a property to import into.');
  if (spec.needsProperty && propertyId && !q1('SELECT id FROM properties WHERE id=? AND org_id=?', propertyId, ctx.orgId)) errs.push('That property is not in your portfolio.');
  if (!csv.trim()) errs.push('Provide a CSV file or paste CSV content.');
  if (errs.length) return importPage(rq, { entity, property: propertyId || '', csv, errs });

  const { rows } = parseCsvObjects(csv);
  if (!rows.length) return importPage(rq, { entity, property: propertyId || '', csv, errs: ['No data rows found under the header.'] });

  const mode = String(rq.body.mode || 'preview');
  // Validate/insert each row inside a savepoint so a bad row rolls back alone.
  const cache = new Map<string, string>();
  const results: { n: number; ok: boolean; msg: string; row: Record<string, string> }[] = [];
  if (mode === 'commit') {
    tx(() => {
      rows.forEach((row, i) => {
        try {
          const res = spec.importRow(ctx, propertyId, row, cache);
          results.push({ n: i + 1, ...res, row });
        } catch (e) {
          results.push({ n: i + 1, ok: false, msg: (e as Error).message, row });
        }
      });
    });
    const okN = results.filter((r) => r.ok).length;
    return redirect(spec.needsProperty ? `/properties/${propertyId}` : '/properties',
      `Imported ${okN} of ${results.length} ${spec.label.toLowerCase()}.${okN < results.length ? ' Some rows were skipped — see the Migration Center to retry.' : ''}`);
  }

  // preview: dry-run validate without persisting (rollback the savepoint)
  try {
    tx(() => {
      rows.forEach((row, i) => {
        try {
          const res = spec.importRow(ctx, propertyId, row, cache);
          results.push({ n: i + 1, ...res, row });
        } catch (e) {
          results.push({ n: i + 1, ok: false, msg: (e as Error).message, row });
        }
      });
      throw new Error('__rollback_preview__'); // never persist a preview
    });
  } catch (e) {
    if ((e as Error).message !== '__rollback_preview__') throw e;
  }
  const okN = results.filter((r) => r.ok).length;
  const cols = [{ label: 'Row' }, { label: 'Status' }, { label: 'Detail' }, ...spec.columns.map((c) => ({ label: c.name }))];
  return shell(rq, {
    title: 'Preview import',
    active: '/setup/import',
    crumbs: [['Setup', '/setup'], ['Migration Center', '/setup/import'], ['Preview']],
    subtitle: `${okN} of ${results.length} rows are ready to import.`,
    content: html`
      ${okN === 0 ? html`<div class="callout bad">No rows can be imported — fix the errors below and try again.</div>` : html`<div class="callout info">${okN} row${okN === 1 ? '' : 's'} will be created. This preview did not change anything.</div>`}
      ${card(null, tbl(cols, results.map((r) => ({
        cells: [
          String(r.n),
          statusBadge(r.ok ? 'ok' : 'error', r.ok ? 'Ready' : 'Skip'),
          r.msg,
          ...spec.columns.map((c) => r.row[c.name] || ''),
        ],
      })), { empty: 'No rows.' }), { flush: true })}
      <form method="post" action="/setup/import" class="wiz-actions">
        <input type="hidden" name="entity" value="${spec.key}" />
        ${when(spec.needsProperty, () => raw(`<input type="hidden" name="property" value="${propertyId}" />`))}
        <input type="hidden" name="csv" value="${csv.replace(/"/g, '&quot;').replace(/</g, '&lt;')}" />
        <a class="btn btn-ghost" href="/setup/import?entity=${spec.key}">Back</a>
        <button class="btn" type="submit" name="mode" value="commit" ${okN === 0 ? 'disabled' : ''}>Import ${okN} ${spec.label.toLowerCase()}</button>
      </form>`,
  });
}
