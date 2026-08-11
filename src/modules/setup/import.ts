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
  autoMap, fieldsFor, findHeaderRow, mergeStackedHeader, harvestSubRowCharges, detectDocumentProperty, norm, PRESETS,
  type ImportKind, type Mapping,
} from './mapping.ts';
import {
  validateRentRoll, validateVendors, validateResidents, validateBalances,
  applyRentRoll, applyVendors, applyResidents, applyBalances, postBankOpeningBalance,
  type BatchRow, type Validation,
} from './import_apply.ts';
import { leasePdfRoutes, leasePdfLaneCard } from './import_leases.ts';
import { aiPlanSpreadsheet, applyReadingPlan, aiReadPdfTable, mappingScore } from './ai_reader.ts';
import { docsChecklist } from './onboarding.ts';

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
    if (!up) return redirect(`/setup/import?tab=${tabFor(kind)}`, 'Choose a file to upload.', 'err');
    if (up.data.length > 15 * 1024 * 1024) return redirect(`/setup/import?tab=${tabFor(kind)}`, 'File is too large (15 MB max).', 'err');

    let headers: string[];
    let dataRows: string[][];
    let mapping: Mapping;
    let docProp: string | null = null; // property named by the document itself

    const isPdf = /\.pdf$/i.test(up.filename || '') || (up.data.length > 4 && up.data.subarray(0, 4).toString('latin1') === '%PDF');
    if (isPdf) {
      // PDF rent rolls: the AI reads the whole table — no template involved
      if (kind !== 'rent_roll') return redirect(`/setup/import?tab=${tabFor(kind)}`, 'PDF reading is available on the rent-roll lane.', 'err');
      if (!llmStatus().live) {
        return redirect('/setup/import?tab=rentroll', 'Reading PDF rent rolls requires the live AI, which is offline in this environment — export the report as Excel/CSV instead.', 'err');
      }
      const table = await aiReadPdfTable(up.data, kind);
      if (!table) return redirect('/setup/import?tab=rentroll', 'The AI couldn\'t find a unit table in that PDF. If it\'s a lease agreement, use the Lease PDFs lane; otherwise try the Excel/CSV export.', 'err');
      headers = table.headers;
      dataRows = table.dataRows.slice(0, MAX_ROWS);
      mapping = table.mapping;
    } else {
      let sheets;
      try {
        sheets = parseSpreadsheet(up.filename || 'upload.csv', up.data, parseCsv);
      } catch (e) {
        return redirect(`/setup/import?tab=${tabFor(kind)}`, `Couldn't read that file (${(e as Error).message}). Export as .xlsx or .csv and try again.`, 'err');
      }
      const sheet = sheets.filter((s) => s.rows.length > 1).sort((a, b) => b.rows.length - a.rows.length)[0];
      if (!sheet) return redirect(`/setup/import?tab=${tabFor(kind)}`, 'That file has no data rows.', 'err');

      // Whole-sheet AI reading first: the model sees the entire grid and plans
      // the read (header, columns, skip rows, property sections). Deterministic
      // code executes the plan; heuristics remain the fallback and the tiebreak.
      const plan = await aiPlanSpreadsheet({ ...sheet, rows: sheet.rows.slice(0, MAX_ROWS + 40) }, kind).catch(() => null);

      const headerIdx = findHeaderRow(sheet.rows, kind);
      let hHeaders = (sheet.rows[headerIdx] || []).map((h) => String(h));
      let hRows = sheet.rows.slice(headerIdx + 1, headerIdx + 1 + MAX_ROWS).filter((row) => row.some((c) => String(c).trim() !== ''));
      let hMapping = autoMap(hHeaders, kind, hRows.slice(0, 8));
      // stacked two-row header (Yardi): merge sub-labels when doing so maps
      // strictly more fields, and consume the continuation row
      const stacked = mergeStackedHeader(hHeaders, sheet.rows[headerIdx + 1]);
      if (stacked.merged) {
        const mergedMap = autoMap(stacked.headers, kind, hRows.slice(1, 9));
        const mappedCount = (m: Mapping): number => Object.values(m.cols).filter(Boolean).length;
        if (mappedCount(mergedMap) > mappedCount(hMapping)) {
          hHeaders = stacked.headers;
          hRows = hRows.slice(1);
          hMapping = mergedMap;
        }
      }

      docProp = plan?.document_property || detectDocumentProperty(sheet.rows, headerIdx);

      const aiRead = plan ? applyReadingPlan(sheet.rows.slice(0, MAX_ROWS + 40), plan, kind) : null;
      if (aiRead && aiRead.dataRows.length && mappingScore(aiRead.mapping.cols, kind) >= mappingScore(hMapping.cols, kind)) {
        headers = aiRead.headers;
        dataRows = aiRead.dataRows.slice(0, MAX_ROWS);
        mapping = aiRead.mapping;
      } else {
        if (!hRows.length) return redirect(`/setup/import?tab=${tabFor(kind)}`, 'No data rows found under the header.', 'err');
        hMapping = await aiAssistMapping(hHeaders, hRows, hMapping, kind);
        headers = hHeaders;
        dataRows = hRows;
        mapping = hMapping;
      }
    }
    // AI-plan mappings get a free synonym pass over the (possibly merged)
    // headers to fill columns the plan left unmapped — this is what catches
    // "Resident Deposit" when the model only saw "Resident"
    if (!isPdf && mapping.reader === 'ai') {
      const gap = autoMap(headers, kind, dataRows.slice(0, 8));
      const claimed = new Set(Object.values(mapping.cols).filter(Boolean));
      for (const [ci, f] of Object.entries(gap.cols)) {
        const n = Number(ci);
        if (f && mapping.cols[n] === undefined && !claimed.has(f)) { mapping.cols[n] = f; claimed.add(f); }
      }
    }
    // block-format rent rolls: fold charge sub-rows into the unit above and
    // drop total lines — nothing the file billed monthly is lost
    if (kind === 'rent_roll' && !isPdf) {
      const h = harvestSubRowCharges(dataRows, mapping);
      dataRows = h.rows;
      if (h.harvestedRows > 0) {
        const extraIdx = headers.length;
        headers = [...headers, 'Other monthly charges'];
        mapping.cols[extraIdx] = 'extra_monthly';
        dataRows = dataRows.map((r, i) => {
          const e = h.extraByRow.get(i);
          const row = Array.from({ length: extraIdx }, (_, ci) => String(r[ci] ?? ''));
          row.push(e ? (e.cents / 100).toFixed(2) : '');
          return row;
        });
        const codeStr = [...h.codes].slice(0, 5).join(', ');
        (mapping.notes ||= []).push(`Folded ${h.harvestedRows} recurring-charge sub-row${h.harvestedRows === 1 ? '' : 's'}${codeStr ? ` (${codeStr})` : ''} — $${(h.totalCents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}/mo — into an “Other monthly charges” column billed alongside rent.`);
      }
    }
    if (!dataRows.length) return redirect(`/setup/import?tab=${tabFor(kind)}`, 'No data rows found in that file.', 'err');

    // property targeting — 'detect' (the rent-roll default) resolves the
    // property FROM the document: its Property column when one is mapped,
    // else the name in the title banner, matched to an existing property or
    // queued for creation. Manual modes behave as before.
    const propMode = String(rq.body.prop_mode || 'existing');
    let propertyId = propMode === 'existing' ? String(rq.body.property || '') || null : null;
    let newPropertyName = propMode === 'new' ? String(rq.body.new_property || '').trim() || null : null;
    if (propMode === 'detect' && kind === 'rent_roll') {
      const hasPropCol = Object.values(mapping.cols).includes('property');
      if (!hasPropCol && docProp) {
        const existing = q1<{ id: string }>('SELECT id FROM properties WHERE org_id=? AND LOWER(name)=LOWER(?)', ctx.orgId, docProp);
        if (existing && canAccessProperty(ctx, existing.id)) {
          propertyId = existing.id;
          (mapping.notes ||= []).push(`Matched this file to your existing property “${docProp}”.`);
        } else if (!existing) {
          newPropertyName = docProp;
          (mapping.notes ||= []).push(`Detected the property “${docProp}” from the document — it will be created on apply.`);
        }
      }
    }
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
    // applied/discarded batches stay visitable as a read-only record — the
    // history's answer to "what did I upload, and what did it do?"
    if (batch.status === 'applied' || batch.status === 'discarded') return recordPage(rq, batch);
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
      const bits = summaryBits(s);
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

/** One compact phrase list for what an apply did — shared by the apply flash,
 * the history table, and the read-only batch record. */
function summaryBits(s: Partial<import('./import_apply.ts').ApplySummary>): string[] {
  const bits: string[] = [];
  if (s.properties) bits.push(`${s.properties} propert${s.properties === 1 ? 'y' : 'ies'}`);
  if (s.units) bits.push(`${s.units} unit${s.units === 1 ? '' : 's'}`);
  if (s.leases) bits.push(`${s.leases} lease${s.leases === 1 ? '' : 's'}`);
  if (s.residents) bits.push(`${s.residents} resident${s.residents === 1 ? '' : 's'}`);
  if (s.vendors) bits.push(`${s.vendors} vendor${s.vendors === 1 ? '' : 's'}`);
  if (s.balancesCents) bits.push(`$${(s.balancesCents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} in balances`);
  if (s.depositsCents) bits.push(`$${(s.depositsCents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} in deposits held`);
  if (s.contactUpdates) bits.push(`${s.contactUpdates} contact update${s.contactUpdates === 1 ? '' : 's'}`);
  if (s.portalInvites) bits.push(`${s.portalInvites} portal invite${s.portalInvites === 1 ? '' : 's'} sent`);
  return bits;
}

// ---------- hub page ----------

function hubPage(rq: Rq): ReturnType<typeof shell> {
  const ctx = rq.ctx as Ctx;
  const tab = rq.query.get('tab') || 'rentroll';
  const props = orgProperties(ctx);
  const history = q<BatchRow & { created_at: string; applied_at: string | null; summary: string | null }>(
    `SELECT * FROM import_batches WHERE org_id=? ORDER BY created_at DESC LIMIT 12`, ctx.orgId,
  );
  const ai = llmStatus();

  const aiLive = llmStatus().live;
  const uploader = (kind: ImportKind, extra?: Raw): Raw => html`
    <form method="post" action="/setup/import/upload" enctype="multipart/form-data">
      <input type="hidden" name="kind" value="${kind}" />
      <div class="form-grid">
        ${field(kind === 'rent_roll' && aiLive ? 'Rent roll file (Excel, CSV, or PDF)' : 'Spreadsheet file',
          raw(`<label class="dropzone" data-dropzone>
            <input type="file" name="file" accept=".csv,.tsv,.txt,.xlsx,.xlsm${kind === 'rent_roll' && aiLive ? ',.pdf,application/pdf' : ''},text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required />
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4m0 0 4.2 4.2M12 4 7.8 8.2"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>
            <b>Drop the file here <span>or click to browse</span></b>
            <span class="dz-hint">Exactly as your old system exports it — nothing to reformat</span>
            <span class="dz-file" data-dz-name></span>
          </label>`))}
        ${kind === 'rent_roll'
          ? field('Import into', raw(`<div>
              <label style="display:flex;gap:6px;align-items:center;margin-bottom:2px"><input type="radio" name="prop_mode" value="detect" checked/> Read it from the file</label>
              <div class="muted small" style="margin:0 0 10px 22px">The property named in the document — or its Property column — is matched or created automatically.</div>
              <label style="display:flex;gap:6px;align-items:center;margin-bottom:4px"><input type="radio" name="prop_mode" value="existing"/> Existing property:&nbsp;</label>
              ${props.length ? `<select name="property">${props.map((p) => `<option value="${p.id}">${p.name.replace(/</g, '&lt;')}</option>`).join('')}</select>` : '<span class="muted small">none yet</span>'}
              <label style="display:flex;gap:6px;align-items:center;margin:8px 0 4px"><input type="radio" name="prop_mode" value="new"/> New property named:&nbsp;</label>
              <input name="new_property" placeholder="Harbor Point Apartments" />
            </div>`))
          : kind === 'vendors'
            ? raw('')
            : field('Property', props.length ? select('property', props.map((p) => [p.id, p.name] as [string, Child]), '', { required: true }) : html`<span class="muted">No properties yet — import a rent roll first.</span>`)}
        ${field('As-of (switch) date', input('as_of', { type: 'date', value: ctx.businessDate }), 'Balances post on this date; billing starts the following month.')}
      </div>
      ${extra || ''}
      <div class="wiz-actions"><button class="btn" type="submit">Upload &amp; map columns</button></div>
    </form>`;

  const lanes: [string, string, Raw][] = [
    ['rentroll', 'Rent roll', html`
      ${card('Upload your rent roll', html`
        <p class="muted" style="margin-top:0">${KINDS[0]!.blurb}</p>
        <p class="muted small" style="margin-top:-6px">${hjoin(PRESETS.map((p) => html`${p.name}`), raw(' · ').s)} · any spreadsheet
        · <a href="/setup/import/template?kind=rent_roll">Excel template</a>
        ${ai.live ? html` <span class="pill" title="The model reads the entire document — headers, sections, totals — and pre-fills the mapping; you review before anything is written">AI document reading: on</span>` : raw('')}</p>
        ${uploader('rent_roll')}
      `)}
      <details style="margin:2px 0 0">
        <summary style="cursor:pointer;font-weight:600;font-size:14px;padding:6px 2px">What to have ready — and what each file unlocks</summary>
        ${docsChecklist(true)}
      </details>`],
    ['leases', 'Lease PDFs', leasePdfLaneCard(ctx, props)],
    ['vendors', 'Vendors', card('Import vendors', html`
      <p class="muted" style="margin-top:0">${KINDS[1]!.blurb} <a href="/setup/import/template?kind=vendors">CSV template</a>.</p>
      ${uploader('vendors')}`)],
    ['residents', 'Residents', card('Attach co-tenants & occupants', html`
      <p class="muted" style="margin-top:0">${KINDS[2]!.blurb} <a href="/setup/import/template?kind=residents">CSV template</a>.</p>
      ${uploader('residents')}`)],
    ['balances', 'Opening balances', html`
      ${card('Per-unit balances owed', html`
        <p class="muted" style="margin-top:0">${KINDS[3]!.blurb} Already in your rent roll's Balance column? Skip this. <a href="/setup/import/template?kind=balances">CSV template</a>.</p>
        ${uploader('balances')}`)}
      ${card('Opening bank balance', html`
        <p class="muted" style="margin-top:0">Your operating account balance on the switch date — one number, no file.</p>
        <form method="post" action="/setup/import/bank-balance">
          <div class="form-grid">
            ${field('Property', props.length ? select('property', props.map((p) => [p.id, p.name] as [string, Child]), '', { required: true }) : html`<span class="muted">Import properties first.</span>`)}
            ${field('Balance (USD)', input('amount', { placeholder: '25000.00', required: true }))}
            ${field('As of', input('as_of', { type: 'date', value: ctx.businessDate }))}
          </div>
          <div class="wiz-actions"><button class="btn" ${props.length ? '' : 'disabled'}>Post opening balance</button></div>
        </form>`)}`],
    ['templates', 'Templates', card('Fixed-format CSV templates', html`
      <p class="muted" style="margin-top:0">Prefer exact templates over auto-mapping? The strict importers for properties, floorplans and units live here.</p>
      <a class="btn btn-ghost" href="/setup/import/legacy">Open template importers</a>`)],
  ];

  return shell(rq, {
    title: 'Migration Center',
    active: '/setup/import',
    crumbs: [['Setup', '/setup'], ['Migration Center']],
    subtitle: 'Bring your portfolio in from anywhere — upload what you have, confirm the mapping, done.',
    content: html`
      ${when(history.length, () => card('Import history', tbl(
        [{ label: 'File' }, { label: 'Type' }, { label: 'Uploaded' }, { label: 'Status' }, { label: 'Result' }, { label: '' }],
        history.map((b) => {
          const s = b.summary ? j<Partial<import('./import_apply.ts').ApplySummary>>(b.summary, {}) : null;
          const result = b.status === 'applied'
            ? (s ? summaryBits(s).slice(0, 4).join(' · ') || 'Applied' : 'Applied') + (s?.skipped ? ` · ${s.skipped} skipped` : '')
            : b.status === 'staged' ? `${j<string[][]>(b.rows, []).length} rows awaiting review` : '—';
          const href = b.kind === 'lease_pdf'
            ? (b.status === 'staged' ? `/setup/import/leases/${b.id}` : null)
            : `/setup/import/b/${b.id}`;
          return { cells: [
            html`<b>${b.filename || '(pasted)'}</b>`,
            KINDS.find((k) => k.key === b.kind)?.label || (b.kind === 'lease_pdf' ? 'Lease PDFs' : b.kind),
            fmtDate(b.created_at.slice(0, 10)),
            statusBadge(b.status === 'applied' ? 'ok' : b.status === 'staged' ? 'pending' : 'error', b.status === 'applied' ? 'Applied' : b.status === 'staged' ? 'Staged' : 'Discarded'),
            html`<span class="muted small">${result}</span>`,
            href ? html`<a class="btn btn-ghost" href="${href}">${b.status === 'staged' ? 'Review' : 'View'}</a>` : raw(''),
          ] };
        }),
        { empty: '' },
      ), { flush: true }))}
      <div class="tabs">${lanes.map(([key, label]) => html`<a href="/setup/import?tab=${key}" class="${key === tab ? 'active' : ''}">${label}</a>`)}</div>
      ${(lanes.find(([key]) => key === tab) || lanes[0]!)[2]}
    `,
  });
}

// ---------- read-only record for applied/discarded batches ----------

function recordPage(rq: Rq, batch: BatchRow & { created_at?: string; applied_at?: string | null; summary?: string | null }): ReturnType<typeof shell> {
  const headers = j<string[]>(batch.headers, []);
  const rows = j<string[][]>(batch.rows, []);
  const mapping = j<Mapping>(batch.mapping, { cols: {}, preset: null, aiAssisted: [] });
  const kind = batch.kind as ImportKind;
  const fields = fieldsFor(kind);
  const s = (batch as { summary?: string | null }).summary ? j<Partial<import('./import_apply.ts').ApplySummary>>((batch as { summary?: string | null }).summary!, {}) : null;
  const applied = batch.status === 'applied';
  const mapped = headers.map((h, i) => ({ h, i, f: mapping.cols[i] })).filter((x) => x.f);

  return shell(rq, {
    title: `Import — ${batch.filename || 'upload'}`,
    active: '/setup/import',
    crumbs: [['Setup', '/setup'], ['Migration Center', '/setup/import'], ['Record']],
    subtitle: `${KINDS.find((k) => k.key === kind)?.label || kind} · uploaded ${fmtDate((batch as { created_at?: string }).created_at?.slice(0, 10) || batch.as_of || '')}`,
    content: html`
      ${card(null, html`
        <div class="btn-row" style="align-items:center;gap:10px">
          ${statusBadge(applied ? 'ok' : 'error', applied ? 'Applied' : 'Discarded')}
          ${applied && (batch as { applied_at?: string | null }).applied_at ? html`<span class="muted small">applied ${fmtDate((batch as { applied_at?: string | null }).applied_at!.slice(0, 10))}</span>` : raw('')}
          <span class="muted small">${String(rows.length)} data row${rows.length === 1 ? '' : 's'} in the file</span>
        </div>
        ${when(applied && !!s, () => html`<p style="margin:10px 0 0">${summaryBits(s!).join(' · ') || 'Nothing new was created.'}${s!.skipped ? html` <span class="muted">· ${String(s!.skipped)} row${s!.skipped === 1 ? '' : 's'} skipped</span>` : raw('')}</p>`)}
        ${when(!applied, () => html`<p class="muted" style="margin:10px 0 0">This upload was discarded — nothing was written. The file's mapping is kept below for reference.</p>`)}
        ${when(!!(mapping.notes || []).length, () => html`<p class="muted small" style="margin:8px 0 0">${(mapping.notes || []).join(' ')}</p>`)}
      `)}
      ${card('Column mapping used', tbl(
        [{ label: 'Your column' }, { label: 'Imported as' }],
        mapped.map((x) => ({ cells: [html`<b>${x.h || `(column ${String(x.i + 1)})`}</b>`, fields.find((f) => f.key === x.f)?.label || x.f!] })),
        { empty: 'No columns were mapped.' },
      ), { flush: true })}
      <div class="wiz-actions"><a class="btn btn-ghost" href="/setup/import">Back to Migration Center</a></div>
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
      ${when(mapping.reader === 'ai', () => html`<div class="callout info"><b>Read by AI.</b> The model read the whole document — header, columns, section labels and summary rows. ${(mapping.notes || []).join(' ')} Everything below is already pre-filled from that read — this screen is verification, not data entry. Nothing imports until you apply.</div>`)}
      ${when(mapping.reader !== 'ai' && !!(mapping.notes || []).length, () => html`<div class="callout info">${(mapping.notes || []).join(' ')}</div>`)}
      ${when(mapping.aiAssisted.length, () => html`<div class="callout info">AI assist mapped: ${mapping.aiAssisted.join(', ')} — double-check those selects below.</div>`)}

      <form method="post" action="/setup/import/b/${batch.id}/mapping">
      ${card('1 · Column mapping', html`
        <p class="muted small" style="margin-top:0">${String(headers.filter((_, i) => mapping.cols[i]).length)} of ${String(headers.length)} columns mapped automatically${mapping.reader === 'ai' ? ' by the AI read' : preset ? ` from the ${preset.name} format` : ''} — adjust anything, then re-check.</p>
        ${tbl(
          [{ label: 'Your column' }, { label: 'Sample values' }, { label: 'Maps to' }, { label: '' }],
          headers.map((h, i) => ({ cells: [
            html`<b>${h || html`<span class="muted">(column ${String(i + 1)})</span>`}</b>`,
            html`<span class="muted small">${sample(i)}</span>`,
            select(`map_${i}`, [['', '— ignore —'], ...fields.map((f) => [f.key, f.label + (f.required ? ' *' : '')] as [string, Child])], mapping.cols[i] ?? ''),
            mapping.cols[i]
              ? (mapping.aiAssisted.includes(mapping.cols[i]!)
                ? html`<span class="pill" title="Filled by the AI assist — double-check">AI assist</span>`
                : mapping.reader === 'ai'
                  ? html`<span class="pill" title="Mapped by the whole-document AI read">AI</span>`
                  : preset ? html`<span class="pill" title="Recognized ${preset.name} column">${preset.name}</span>` : html`<span class="pill" title="Matched by column name">auto</span>`)
              : raw(''),
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
