import { html, raw, when, join as hjoin, type Raw, type Child } from '../../lib/html.ts';
import { redirect, notFound, fileRes, type Router, type Rq } from '../../lib/http.ts';
import { requirePerm, canAccessProperty, type Ctx } from '../../lib/auth.ts';
import { q, q1, insert, run, j, js } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, fmtDate } from '../../lib/dates.ts';
import { audit } from '../../lib/audit.ts';
import { parseCsv } from '../../lib/csv.ts';
import { parseSpreadsheet, writeXlsx } from '../../lib/xlsx.ts';
import { llmGenerate, llmStatus } from '../../lib/sim/llm.ts';
import { shell, card, tbl, field, input, select, statusBadge } from '../../ui/ui.ts';
import {
  autoMap, fieldsFor, findHeaderRow, norm, PRESETS, type ImportKind, type Mapping,
} from './mapping.ts';
import {
  validateRentRoll, validateVendors, validateResidents, validateBalances,
  applyRentRoll, applyVendors, applyResidents, applyBalances, postBankOpeningBalance,
  type BatchRow, type Validation,
} from './import_apply.ts';
import { leasePdfRoutes, leasePdfLaneCard } from './import_leases.ts';

/** Migration Center — the working model's front door for data.
 * One principle: the customer uploads WHATEVER their old system produces
 * (Buildium/AppFolio/Yardi exports, a hand-kept Excel sheet, signed lease
 * PDFs) and StayLeased does the reading. Columns are auto-mapped, humans
 * confirm, and one transactional apply builds the portfolio. */

const MAX_ROWS = 5000;

const KINDS: { key: ImportKind; label: string; blurb: string }[] = [
  { key: 'rent_roll', label: 'Rent roll / units', blurb: 'One file builds everything: properties, floorplans, units, residents, leases, deposits, and balances owed.' },
  { key: 'vendors', label: 'Vendors', blurb: 'Your plumbers, electricians and landscapers — name, trade, contact info.' },
  { key: 'residents', label: 'More residents', blurb: 'Co-tenants, occupants and guarantors attached to leases you already imported.' },
  { key: 'balances', label: 'Opening balances', blurb: 'Amounts owed per unit as of your switch date, onto existing leases.' },
];

function batchById(ctx: Ctx, batchId: string): BatchRow | undefined {
  return q1<BatchRow>('SELECT * FROM import_batches WHERE id=? AND org_id=?', batchId, ctx.orgId);
}

function validate(ctx: Ctx, batch: BatchRow): Validation {
  switch (batch.kind) {
    case 'vendors': return validateVendors(ctx, batch);
    case 'residents': return validateResidents(ctx, batch);
    case 'balances': return validateBalances(ctx, batch);
    default: return validateRentRoll(ctx, batch);
  }
}

function orgProperties(ctx: Ctx): { id: string; name: string }[] {
  return q<{ id: string; name: string }>(
    ctx.allProperties
      ? 'SELECT id, name FROM properties WHERE org_id=? ORDER BY name'
      : `SELECT id, name FROM properties WHERE org_id=? AND id IN (${ctx.propertyIds.map(() => '?').join(',') || "''"}) ORDER BY name`,
    ...(ctx.allProperties ? [ctx.orgId] : [ctx.orgId, ...ctx.propertyIds]),
  );
}

// ---------- AI mapping assist ----------

function extractJson(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
}

/** Ask the live brain to map leftover columns. Only fills gaps — heuristic
 * matches always win — and never invents fields. No key configured → no-op. */
async function aiAssistMapping(headers: string[], samples: string[][], mapping: Mapping, kind: ImportKind): Promise<Mapping> {
  if (!llmStatus().live) return mapping;
  const fields = fieldsFor(kind);
  const unmappedCols = headers.map((_, i) => i).filter((i) => mapping.cols[i] === undefined);
  const unclaimed = fields.filter((f) => !Object.values(mapping.cols).includes(f.key));
  if (!unmappedCols.length || !unclaimed.length) return mapping;
  const colDesc = unmappedCols
    .map((i) => `${i}: "${headers[i]}" (samples: ${samples.slice(0, 3).map((r) => JSON.stringify(r[i] ?? '')).join(', ')})`)
    .join('\n');
  const res = await llmGenerate({
    system: 'You map spreadsheet columns from property-management exports to canonical fields. Answer with ONLY a JSON object mapping column index (string) to field key. Omit columns that match no field. Never guess wildly.',
    prompt: `Canonical fields: ${unclaimed.map((f) => `${f.key} (${f.label})`).join(', ')}\n\nUnmapped columns:\n${colDesc}\n\nJSON only:`,
    fallback: '{}',
    maxTokens: 300,
    cacheKey: `map:${kind}:${headers.join('|')}`,
  });
  const parsed = extractJson(res.text) || {};
  const valid = new Set(unclaimed.map((f) => f.key));
  const claimed = new Set(Object.values(mapping.cols).filter(Boolean));
  for (const [k, v] of Object.entries(parsed)) {
    const col = parseInt(k, 10);
    const fieldKey = String(v);
    if (!Number.isInteger(col) || !unmappedCols.includes(col)) continue;
    if (!valid.has(fieldKey) || claimed.has(fieldKey)) continue;
    mapping.cols[col] = fieldKey;
    claimed.add(fieldKey);
    mapping.aiAssisted.push(fieldKey);
  }
  return mapping;
}

// ---------- routes ----------

export function routes(r: Router): void {
  leasePdfRoutes(r);

  r.get('/setup/import', requirePerm('properties:manage'), (rq) => hubPage(rq));

  r.get('/setup/import/template', requirePerm('properties:manage'), (rq) => {
    const kind = rq.query.get('kind') || 'rent_roll';
    if (kind === 'rent_roll') {
      const rows = [
        ['Unit', 'Floorplan', 'Beds', 'Baths', 'Sq Ft', 'Market Rent', 'Tenant', 'Email', 'Phone', 'Lease Start', 'Lease End', 'Rent', 'Deposit', 'Balance'],
        ['101', '1x1', '1', '1', '720', '1450', 'Jordan Avery', 'jordan@example.com', '(555) 201-8890', '2026-01-01', '2026-12-31', '1425', '1425', '0'],
        ['102', '1x1', '1', '1', '720', '1450', 'Sasha Kim & Ben Kim', 'sasha@example.com', '', '2025-09-15', '2026-09-14', '1400', '1400', '150.50'],
        ['103', '2x2', '2', '2', '1080', '1925', '', '', '', '', '', '', '', ''],
      ];
      return fileRes(writeXlsx([{ name: 'Rent Roll', rows }]), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', { filename: 'stayleased-rent-roll-template.xlsx' });
    }
    if (kind === 'vendors') {
      const csv = 'Vendor Name,Trade,Email,Phone\nPinnacle Plumbing,Plumbing,dispatch@pinnacle.example,(555) 301-2200\nBrightSpark Electric,Electrical,hello@brightspark.example,(555) 301-2201\r\n';
      return fileRes(csv, 'text/csv; charset=utf-8', { filename: 'stayleased-vendors-template.csv' });
    }
    if (kind === 'balances') {
      const csv = 'Unit,Tenant,Balance\n101,Jordan Avery,250.00\n102,Sasha Kim,0\r\n';
      return fileRes(csv, 'text/csv; charset=utf-8', { filename: 'stayleased-balances-template.csv' });
    }
    const csv = 'Unit,Name,Role,Email,Phone\n101,Riley Avery,co,riley@example.com,\n101,Miles Avery,occupant,,\r\n';
    return fileRes(csv, 'text/csv; charset=utf-8', { filename: 'stayleased-residents-template.csv' });
  });

  r.post('/setup/import/upload', requirePerm('properties:manage'), async (rq) => {
    const ctx = rq.ctx as Ctx;
    const kind = (KINDS.some((k) => k.key === rq.body.kind) ? String(rq.body.kind) : 'rent_roll') as ImportKind;
    const up = (rq.uploads || []).find((u) => u.field === 'file' && u.data.length);
    if (!up) return redirect(`/setup/import?tab=${tabFor(kind)}`, 'Choose a spreadsheet file to upload.', 'err');
    if (up.data.length > 15 * 1024 * 1024) return redirect(`/setup/import?tab=${tabFor(kind)}`, 'File is too large (15 MB max).', 'err');

    let sheets;
    try {
      sheets = parseSpreadsheet(up.filename || 'upload.csv', up.data, parseCsv);
    } catch (e) {
      return redirect(`/setup/import?tab=${tabFor(kind)}`, `Couldn't read that file (${(e as Error).message}). Export as .xlsx or .csv and try again.`, 'err');
    }
    const sheet = sheets.filter((s) => s.rows.length > 1).sort((a, b) => b.rows.length - a.rows.length)[0];
    if (!sheet) return redirect(`/setup/import?tab=${tabFor(kind)}`, 'That file has no data rows.', 'err');

    const headerIdx = findHeaderRow(sheet.rows, kind);
    const headers = (sheet.rows[headerIdx] || []).map((h) => String(h));
    const dataRows = sheet.rows.slice(headerIdx + 1, headerIdx + 1 + MAX_ROWS).filter((row) => row.some((c) => String(c).trim() !== ''));
    if (!dataRows.length) return redirect(`/setup/import?tab=${tabFor(kind)}`, 'No data rows found under the header.', 'err');

    let mapping = autoMap(headers, kind);
    mapping = await aiAssistMapping(headers, dataRows, mapping, kind);

    // property targeting
    const propMode = String(rq.body.prop_mode || 'existing');
    const propertyId = propMode === 'existing' ? String(rq.body.property || '') || null : null;
    const newPropertyName = propMode === 'new' ? String(rq.body.new_property || '').trim() || null : null;
    if (propertyId && !canAccessProperty(ctx, propertyId)) return redirect('/setup/import', 'That property is not in your portfolio.', 'err');

    const batchId = id('imp');
    insert('import_batches', {
      id: batchId, org_id: ctx.orgId, kind, filename: up.filename || null,
      property_id: propertyId, new_property_name: newPropertyName,
      preset: mapping.preset, headers: js(headers), mapping: js(mapping), rows: js(dataRows),
      staged: '[]', as_of: String(rq.body.as_of || '') || ctx.businessDate,
      status: 'staged', summary: null, created_by: ctx.userId, created_at: nowIso(), applied_at: null,
    });
    audit(ctx, 'import_batch', batchId, 'upload', null, { kind, filename: up.filename, rows: dataRows.length, preset: mapping.preset });
    return redirect(`/setup/import/b/${batchId}`);
  });

  r.get('/setup/import/b/:id', requirePerm('properties:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const batch = batchById(ctx, rq.params.id!);
    if (!batch || batch.kind === 'lease_pdf') return notFound('Import not found');
    if (batch.status === 'applied') return redirect('/setup/import', 'That import has already been applied.');
    if (batch.status === 'discarded') return redirect('/setup/import', 'That import was discarded.');
    return reviewPage(rq, batch);
  });

  r.post('/setup/import/b/:id/mapping', requirePerm('properties:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const batch = batchById(ctx, rq.params.id!);
    if (!batch || batch.status !== 'staged') return notFound('Import not found');
    const headers = j<string[]>(batch.headers, []);
    const mapping = j<Mapping>(batch.mapping, { cols: {}, preset: null, aiAssisted: [] });
    const fields = new Set(fieldsFor(batch.kind as ImportKind).map((f) => f.key));
    const cols: Record<number, string> = {};
    const claimed = new Set<string>();
    headers.forEach((_, i) => {
      const v = String(rq.body[`map_${i}`] ?? '');
      if (v && fields.has(v) && !claimed.has(v)) { cols[i] = v; claimed.add(v); }
      else cols[i] = '';
    });
    mapping.cols = cols;
    const asOf = String(rq.body.as_of || '').match(/^\d{4}-\d{2}-\d{2}$/) ? String(rq.body.as_of) : batch.as_of;
    const propertyId = String(rq.body.property || '') || null;
    const newPropertyName = String(rq.body.new_property || '').trim() || null;
    run(
      'UPDATE import_batches SET mapping=?, as_of=?, property_id=?, new_property_name=? WHERE id=?',
      js(mapping), asOf, propertyId && canAccessProperty(ctx, propertyId) ? propertyId : null,
      propertyId ? null : newPropertyName, batch.id,
    );
    return redirect(`/setup/import/b/${batch.id}`, 'Mapping updated — review the preview below.');
  });

  r.post('/setup/import/b/:id/apply', requirePerm('properties:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const batch = batchById(ctx, rq.params.id!);
    if (!batch || batch.status !== 'staged') return notFound('Import not found');
    try {
      const s =
        batch.kind === 'vendors' ? applyVendors(ctx, batch)
        : batch.kind === 'residents' ? applyResidents(ctx, batch)
        : batch.kind === 'balances' ? applyBalances(ctx, batch)
        : applyRentRoll(ctx, batch);
      const bits: string[] = [];
      if (s.properties) bits.push(`${s.properties} propert${s.properties === 1 ? 'y' : 'ies'}`);
      if (s.units) bits.push(`${s.units} unit${s.units === 1 ? '' : 's'}`);
      if (s.leases) bits.push(`${s.leases} lease${s.leases === 1 ? '' : 's'}`);
      if (s.residents) bits.push(`${s.residents} resident${s.residents === 1 ? '' : 's'}`);
      if (s.vendors) bits.push(`${s.vendors} vendor${s.vendors === 1 ? '' : 's'}`);
      if (s.balancesCents) bits.push(`$${(s.balancesCents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} in balances`);
      if (s.depositsCents) bits.push(`$${(s.depositsCents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} in deposits held`);
      const skipNote = s.skipped ? ` ${s.skipped} row${s.skipped === 1 ? '' : 's'} skipped (see the import log).` : '';
      const single = batch.property_id || (s.propertyIds && s.propertyIds.length === 1 ? s.propertyIds[0] : null);
      const dest = single ? `/properties/${single}` : '/properties';
      return redirect(dest, `Imported ${bits.join(', ') || 'nothing new'}.${skipNote}`);
    } catch (e) {
      return redirect(`/setup/import/b/${batch.id}`, `Import failed: ${(e as Error).message}`, 'err');
    }
  });

  r.post('/setup/import/b/:id/discard', requirePerm('properties:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const batch = batchById(ctx, rq.params.id!);
    if (!batch) return notFound('Import not found');
    run(`UPDATE import_batches SET status='discarded' WHERE id=?`, batch.id);
    audit(ctx, 'import_batch', batch.id, 'discard');
    return redirect('/setup/import', 'Import discarded — nothing was written.');
  });

  r.post('/setup/import/bank-balance', requirePerm('accounting:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const propertyId = String(rq.body.property || '');
    const cents = Math.round(parseFloat(String(rq.body.amount || '').replace(/[$,]/g, '')) * 100);
    const asOf = String(rq.body.as_of || '').match(/^\d{4}-\d{2}-\d{2}$/) ? String(rq.body.as_of) : ctx.businessDate;
    try {
      if (!Number.isFinite(cents)) throw new Error('enter an amount like 12500.00');
      postBankOpeningBalance(ctx, propertyId, cents, asOf);
      return redirect('/setup/import?tab=balances', `Opening bank balance posted for ${fmtDate(asOf)}.`);
    } catch (e) {
      return redirect('/setup/import?tab=balances', `Couldn't post that balance: ${(e as Error).message}`, 'err');
    }
  });
}

function tabFor(kind: ImportKind): string {
  return kind === 'rent_roll' ? 'rentroll' : kind;
}

// ---------- hub page ----------

function hubPage(rq: Rq): ReturnType<typeof shell> {
  const ctx = rq.ctx as Ctx;
  const tab = rq.query.get('tab') || 'rentroll';
  const props = orgProperties(ctx);
  const staged = q<BatchRow & { created_at: string }>(
    `SELECT * FROM import_batches WHERE org_id=? AND status='staged' ORDER BY created_at DESC LIMIT 8`, ctx.orgId,
  );
  const ai = llmStatus();

  const uploader = (kind: ImportKind, extra?: Raw): Raw => html`
    <form method="post" action="/setup/import/upload" enctype="multipart/form-data">
      <input type="hidden" name="kind" value="${kind}" />
      <div class="form-grid">
        ${field('Spreadsheet file', raw('<input type="file" name="file" accept=".csv,.tsv,.txt,.xlsx,.xlsm,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required />'),
          'Excel (.xlsx) or CSV — exactly as your old system exports it. Columns are auto-detected; you confirm before anything is written.')}
        ${kind === 'rent_roll'
          ? field('Import into', raw(`<div>
              <label style="display:flex;gap:6px;align-items:center;margin-bottom:4px"><input type="radio" name="prop_mode" value="existing" ${props.length ? 'checked' : ''}/> Existing property:&nbsp;</label>
              ${props.length ? `<select name="property">${props.map((p) => `<option value="${p.id}">${p.name.replace(/</g, '&lt;')}</option>`).join('')}</select>` : '<span class="muted small">none yet</span>'}
              <label style="display:flex;gap:6px;align-items:center;margin:8px 0 4px"><input type="radio" name="prop_mode" value="new" ${props.length ? '' : 'checked'}/> New property named:&nbsp;</label>
              <input name="new_property" placeholder="Harbor Point Apartments" />
              <div class="muted small" style="margin-top:6px">Has a Property column? Map it on the next screen and every property in the file is created automatically.</div>
            </div>`))
          : kind === 'vendors'
            ? raw('')
            : field('Property', props.length ? select('property', props.map((p) => [p.id, p.name] as [string, Child]), '', { required: true }) : html`<span class="muted">No properties yet — import a rent roll first.</span>`)}
        ${field('As-of (switch) date', input('as_of', { type: 'date', value: ctx.businessDate }), 'Balances and deposits post on this date; recurring billing starts the following month.')}
      </div>
      ${extra || ''}
      <div class="wiz-actions"><button class="btn" type="submit">Upload &amp; map columns</button></div>
    </form>`;

  const lanes: [string, string, Raw][] = [
    ['rentroll', 'Rent roll (everything)', html`
      ${card('Upload your rent roll — the whole portfolio in one file', html`
        <p class="muted" style="margin-top:0">${KINDS[0]!.blurb} Works with exports from ${hjoin(PRESETS.map((p) => html`<b>${p.name}</b>`), raw(', ').s)} or any spreadsheet.
        ${ai.live ? html` <span class="pill" title="Unrecognized columns get an AI mapping suggestion">AI mapping assist: on</span>` : html` <span class="muted small">(AI mapping assist off — heuristics only)</span>`}</p>
        ${uploader('rent_roll')}
        <div class="callout info" style="margin-top:10px">No file handy? <a href="/setup/import/template?kind=rent_roll">Download the Excel template</a> — or try the sample to see the flow.</div>
      `)}`],
    ['leases', 'Lease PDFs', leasePdfLaneCard(ctx, props)],
    ['vendors', 'Vendors', card('Import vendors', html`
      <p class="muted" style="margin-top:0">${KINDS[1]!.blurb} <a href="/setup/import/template?kind=vendors">CSV template</a>.</p>
      ${uploader('vendors')}`)],
    ['residents', 'More residents', card('Attach co-tenants & occupants', html`
      <p class="muted" style="margin-top:0">${KINDS[2]!.blurb} <a href="/setup/import/template?kind=residents">CSV template</a>.</p>
      ${uploader('residents')}`)],
    ['balances', 'Opening balances', html`
      ${card('Per-unit balances owed', html`
        <p class="muted" style="margin-top:0">${KINDS[3]!.blurb} Already in your rent roll's Balance column? Skip this. <a href="/setup/import/template?kind=balances">CSV template</a>.</p>
        ${uploader('balances')}`)}
      ${card('Opening bank balance', html`
        <p class="muted" style="margin-top:0">Your operating account balance on the switch date, so bank reconciliation starts from truth.</p>
        <form method="post" action="/setup/import/bank-balance">
          <div class="form-grid">
            ${field('Property', props.length ? select('property', props.map((p) => [p.id, p.name] as [string, Child]), '', { required: true }) : html`<span class="muted">Import properties first.</span>`)}
            ${field('Balance (USD)', input('amount', { placeholder: '25000.00', required: true }))}
            ${field('As of', input('as_of', { type: 'date', value: ctx.businessDate }))}
          </div>
          <div class="wiz-actions"><button class="btn" ${props.length ? '' : 'disabled'}>Post opening balance</button></div>
        </form>`)}`],
    ['templates', 'Structured templates', card('Fixed-format CSV templates', html`
      <p class="muted" style="margin-top:0">Prefer exact templates over auto-mapping? The original strict importers for properties, floorplans and units live here.</p>
      <a class="btn btn-ghost" href="/setup/import/legacy">Open template importers</a>`)],
  ];

  const sourceTiles = html`<div class="setup-grid" style="margin-top:4px">
    ${PRESETS.map((p) => html`<a class="setup-card" href="/setup/import?tab=rentroll" title="Upload your ${p.name} rent-roll export — its columns are recognized automatically">
      <div class="sc-icon">${raw('<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 21h16"/></svg>')}</div>
      <div><div class="sc-title">From ${p.name}</div><div class="sc-desc">Export your rent roll, upload it here — columns map automatically.</div></div>
    </a>`)}
    <a class="setup-card" href="/setup/connections">
      <div class="sc-icon">${raw('<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12h6M8 7H6a5 5 0 0 0 0 10h2M16 7h2a5 5 0 0 1 0 10h-2"/></svg>')}</div>
      <div><div class="sc-title">Live connections</div><div class="sc-desc">Payments, bank feeds, listing syndication — see what's connected.</div></div>
    </a>
  </div>`;

  return shell(rq, {
    title: 'Migration Center',
    active: '/setup/import',
    crumbs: [['Setup', '/setup'], ['Migration Center']],
    subtitle: 'Bring your portfolio in from anywhere — upload what you have, confirm the mapping, done.',
    content: html`
      ${when(staged.length, () => card('Resume a staged import', tbl(
        [{ label: 'File' }, { label: 'Type' }, { label: 'Uploaded' }, { label: '' }],
        staged.map((b) => ({ cells: [
          b.filename || '(pasted)',
          KINDS.find((k) => k.key === b.kind)?.label || b.kind,
          fmtDate(b.created_at.slice(0, 10)),
          b.kind === 'lease_pdf'
            ? html`<a class="btn btn-ghost" href="/setup/import/leases/${b.id}">Review</a>`
            : html`<a class="btn btn-ghost" href="/setup/import/b/${b.id}">Review</a>`,
        ] })),
        { empty: '' },
      ), { flush: true }))}
      <div class="tabs">${lanes.map(([key, label]) => html`<a href="/setup/import?tab=${key}" class="${key === tab ? 'active' : ''}">${label}</a>`)}</div>
      ${(lanes.find(([key]) => key === tab) || lanes[0]!)[2]}
      ${card('Moving from another system?', sourceTiles)}
    `,
  });
}

// ---------- review page (mapping + preview + apply) ----------

function reviewPage(rq: Rq, batch: BatchRow): ReturnType<typeof shell> {
  const ctx = rq.ctx as Ctx;
  const headers = j<string[]>(batch.headers, []);
  const rows = j<string[][]>(batch.rows, []);
  const mapping = j<Mapping>(batch.mapping, { cols: {}, preset: null, aiAssisted: [] });
  const kind = batch.kind as ImportKind;
  const fields = fieldsFor(kind);
  const validation = validate(ctx, batch);
  const preset = PRESETS.find((p) => p.key === batch.preset);
  const props = orgProperties(ctx);
  const applyable = validation.ok + validation.warn;

  const sample = (i: number): string =>
    rows.slice(0, 3).map((r) => r[i]).filter((v) => v !== undefined && String(v).trim() !== '').slice(0, 2).map((v) => `“${String(v).slice(0, 24)}”`).join(', ');

  const issueRows = validation.rows.filter((r) => r.notes.length).slice(0, 60);

  return shell(rq, {
    title: `Review import — ${batch.filename || 'upload'}`,
    active: '/setup/import',
    crumbs: [['Setup', '/setup'], ['Migration Center', '/setup/import'], ['Review']],
    subtitle: `${rows.length} data row${rows.length === 1 ? '' : 's'} · ${KINDS.find((k) => k.key === kind)?.label || kind}${preset ? ` · detected ${preset.name} format` : ''}`,
    content: html`
      ${when(validation.blockers.length, () => html`<div class="callout bad"><b>Before you can apply:</b> ${validation.blockers.join(' ')}</div>`)}
      ${when(!!preset, () => html`<div class="callout info">Recognized a <b>${preset!.name}</b> export — its columns were pre-mapped. Adjust anything below.</div>`)}
      ${when(mapping.aiAssisted.length, () => html`<div class="callout info">AI assist mapped: ${mapping.aiAssisted.join(', ')} — double-check those selects below.</div>`)}

      <form method="post" action="/setup/import/b/${batch.id}/mapping">
      ${card('1 · Column mapping', html`
        ${tbl(
          [{ label: 'Your column' }, { label: 'Sample values' }, { label: 'Maps to' }],
          headers.map((h, i) => ({ cells: [
            html`<b>${h || html`<span class="muted">(column ${String(i + 1)})</span>`}</b>`,
            html`<span class="muted small">${sample(i)}</span>`,
            select(`map_${i}`, [['', '— ignore —'], ...fields.map((f) => [f.key, f.label + (f.required ? ' *' : '')] as [string, Child])], mapping.cols[i] ?? ''),
          ] })),
          { empty: 'No columns found.' },
        )}
        <div class="form-grid" style="margin-top:10px">
          ${kind !== 'vendors' ? field('Target property', raw(`<div><select name="property"><option value="">${kind === 'rent_roll' ? '— from Property column / new —' : '— choose —'}</option>${props.map((p) => `<option value="${p.id}" ${batch.property_id === p.id ? 'selected' : ''}>${p.name.replace(/</g, '&lt;')}</option>`).join('')}</select>
            ${kind === 'rent_roll' ? `<input name="new_property" placeholder="…or new property name" value="${(batch.new_property_name || '').replace(/"/g, '&quot;')}" style="margin-top:6px" />` : ''}</div>`)) : raw('')}
          ${field('As-of (switch) date', input('as_of', { type: 'date', value: batch.as_of || ctx.businessDate }), 'Balances post this date; billing starts the following month.')}
        </div>
        <div class="wiz-actions"><button class="btn btn-ghost" type="submit">Re-check with this mapping</button></div>
      `)}
      </form>

      ${card('2 · Preview', html`
        <div class="btn-row" style="margin-bottom:10px">
          ${statusBadge('ok', `${validation.ok} ready`)}
          ${validation.warn ? statusBadge('pending', `${validation.warn} with warnings (will import)`) : ''}
          ${validation.error ? statusBadge('error', `${validation.error} skipped`) : ''}
        </div>
        ${when(issueRows.length, () => tbl(
          [{ label: 'Row' }, { label: 'Unit' }, { label: 'Status' }, { label: 'Notes' }],
          issueRows.map((vr) => ({ cells: [
            String(vr.n),
            vr.rec.unit || vr.rec.name || '—',
            statusBadge(vr.level === 'error' ? 'error' : 'pending', vr.level === 'error' ? 'Skip' : 'Warn'),
            vr.notes.join(' '),
          ] })),
          { empty: '' },
        ))}
        ${when(!issueRows.length, () => html`<div class="callout info">Every row validates clean. ${validation.properties.length ? `Properties from the file: ${validation.properties.join(', ')}.` : ''}</div>`)}
        ${when(issueRows.length && validation.rows.filter((r) => r.notes.length).length > 60, () => html`<p class="muted small">Showing the first 60 rows with notes.</p>`)}
      `)}

      <div class="wiz-actions">
        <form method="post" action="/setup/import/b/${batch.id}/discard"><button class="btn btn-ghost" type="submit">Discard</button></form>
        <form method="post" action="/setup/import/b/${batch.id}/apply">
          <button class="btn" type="submit" ${applyable === 0 || validation.blockers.length ? 'disabled' : ''}>Apply ${String(applyable)} row${applyable === 1 ? '' : 's'}</button>
        </form>
      </div>
      <p class="muted small">Applying is transactional and audited — skipped rows never partially import, and you can find this batch later in the audit log.</p>
    `,
  });
}
