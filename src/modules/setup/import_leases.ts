import { html, raw, when, type Raw, type Child } from '../../lib/html.ts';
import { redirect, notFound, type Router, type Rq } from '../../lib/http.ts';
import { requirePerm, canAccessProperty, type Ctx } from '../../lib/auth.ts';
import { q1, insert, run, tx, j, js } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, addMonths, firstOfMonth } from '../../lib/dates.ts';
import { audit } from '../../lib/audit.ts';
import { emit } from '../../lib/events.ts';
import { putFile } from '../../lib/files.ts';
import { pdfExtractText } from '../../lib/pdftext.ts';
import { llmGenerate, llmExtractPdf, llmStatus } from '../../lib/sim/llm.ts';
import { createCharge } from '../m8_receivables/service.ts';
import { postBothBases } from '../m9_accounting/service.ts';
import { shell, card, field, input, select, statusBadge } from '../../ui/ui.ts';
import { moneyToCents, toIsoDate, splitName } from './mapping.ts';
import { ensureOpeningEquityAccount, type BatchRow } from './import_apply.ts';

/** Lease-PDF onboarding: drop in the signed leases; the system reads them.
 * Digital PDFs are text-extracted locally; with the live AI configured the
 * document itself goes to the model (scans included). Every extraction lands
 * as an editable draft with confidence flags — nothing imports unreviewed. */

export interface LeaseDraft {
  filename: string;
  fileId: string | null;
  include: boolean;
  fields: {
    unit: string;
    tenants: string; // "First Last & First Last"
    email: string;
    phone: string;
    rent: string; // dollars string
    deposit: string;
    start: string; // ISO
    end: string; // ISO
  };
  confidence: Record<string, 'high' | 'low'>;
  notes: string[];
  source: 'ai' | 'text' | 'none';
}

// ---------- deterministic fallback extraction (works offline) ----------

const DATE_PAT = String.raw`([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})`;
const RE = {
  unit: /(?:unit|apartment|apt\.?|premises(?:\s+known\s+as)?)[:#\s]*(?:no\.?|number)?[:#\s]*([A-Za-z]?-?\d{1,5}[A-Za-z]?)\b/i,
  // label is case-tolerant; the captured NAME must be capitalized words
  tenants: /(?:[Tt]enant|[Rr]esident|[Ll]essee|TENANT|RESIDENT|LESSEE)s?(?:\s*\(s\))?[:\s]+((?:[A-Z][a-zA-Z'.-]+\s+[A-Z][a-zA-Z'.-]+)(?:\s*(?:,|&|\band\b)\s*[A-Z][a-zA-Z'.-]+\s+[A-Z][a-zA-Z'.-]+)*)/,
  rent: /(?:monthly\s+rent|rent(?:al)?\s+(?:amount|rate)|base\s+rent)[^$\d]{0,40}\$?\s*([\d,]+(?:\.\d{2})?)/i,
  deposit: /(?:security\s+deposit|deposit)[^$\d]{0,40}\$?\s*([\d,]+(?:\.\d{2})?)/i,
  start: new RegExp(String.raw`(?:commenc\w+|lease\s+start\w*|start(?:ing)?|term\s+begin\w*|\bfrom\b)\s*(?:date|on)?[:\s]+` + DATE_PAT, 'i'),
  end: new RegExp(String.raw`(?:expir\w+|lease\s+end\w*|end(?:ing)?|term\s+end\w*|\bthrough\b|\buntil\b|\bto\b)\s*(?:date|on)?[:\s]+` + DATE_PAT, 'i'),
  email: /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/,
  phone: /(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/,
};

export function extractLeaseFromText(text: string): { fields: LeaseDraft['fields']; confidence: Record<string, 'high' | 'low'> } {
  const pick = (re: RegExp): string => {
    const m = text.match(re);
    return m ? m[1]!.trim() : '';
  };
  const rent = pick(RE.rent);
  const deposit = pick(RE.deposit);
  const start = toIsoDate(pick(RE.start)) || '';
  const end = toIsoDate(pick(RE.end)) || '';
  const fields = {
    unit: pick(RE.unit), tenants: pick(RE.tenants).replace(/\s*,\s*/g, ' & ').replace(/\s+and\s+/gi, ' & '),
    email: pick(RE.email), phone: pick(RE.phone),
    rent, deposit, start, end,
  };
  const confidence: Record<string, 'high' | 'low'> = {};
  for (const [k, v] of Object.entries(fields)) confidence[k] = v ? 'high' : 'low';
  return { fields, confidence };
}

function extractJson(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
}

const EXTRACT_SYSTEM = 'You extract structured data from residential lease agreements. Reply with ONLY JSON: {"unit":string,"tenants":string,"email":string,"phone":string,"rent":string,"deposit":string,"start":"YYYY-MM-DD","end":"YYYY-MM-DD","confidence":{"field":"high"|"low"}}. tenants joins multiple names with " & ". Amounts are plain dollar strings like "1450.00". Empty string when absent. Never invent values.';

async function extractDraft(filename: string, pdf: Buffer): Promise<Omit<LeaseDraft, 'fileId' | 'include'>> {
  const text = pdfExtractText(pdf);
  const notes: string[] = [];
  const live = llmStatus().live;

  // fallback result from local text (deterministic; also the no-AI path)
  const local = text ? extractLeaseFromText(text) : null;

  if (live) {
    const res = text && text.length > 300
      ? await llmGenerate({
          system: EXTRACT_SYSTEM,
          prompt: `Lease text:\n"""\n${text.slice(0, 14000)}\n"""\nJSON only:`,
          fallback: '',
          maxTokens: 500,
          cacheKey: `lease:${filename}:${text.length}`,
        })
      : await llmExtractPdf({
          system: EXTRACT_SYSTEM,
          prompt: 'Extract the lease fields from this document. JSON only:',
          pdf, fallback: '', maxTokens: 500,
        });
    const parsed = res.text ? extractJson(res.text) : null;
    if (parsed) {
      const g = (k: string): string => (typeof parsed[k] === 'string' ? String(parsed[k]).trim() : '');
      const conf = (parsed.confidence && typeof parsed.confidence === 'object' ? parsed.confidence : {}) as Record<string, string>;
      const fields = {
        unit: g('unit'), tenants: g('tenants'), email: g('email'), phone: g('phone'),
        rent: g('rent'), deposit: g('deposit'),
        start: toIsoDate(g('start')) || '', end: toIsoDate(g('end')) || '',
      };
      const confidence: Record<string, 'high' | 'low'> = {};
      for (const k of Object.keys(fields)) confidence[k] = conf[k] === 'high' && (fields as any)[k] ? 'high' : (fields as any)[k] ? 'high' : 'low';
      for (const k of Object.keys(fields)) if (conf[k] === 'low') confidence[k] = 'low';
      if (!text) notes.push('Scanned document — read by AI.');
      return { filename, fields, confidence, notes, source: 'ai' };
    }
    notes.push('AI extraction unavailable for this file — used local text reading.');
  }

  if (local) {
    if (!live) notes.push('Read locally from the PDF text. Connect the live AI for scanned documents.');
    return { filename, fields: local.fields, confidence: local.confidence, notes, source: 'text' };
  }
  notes.push('No text found in this PDF (likely a scan). Enter the fields manually or enable live AI.');
  return {
    filename,
    fields: { unit: '', tenants: '', email: '', phone: '', rent: '', deposit: '', start: '', end: '' },
    confidence: { unit: 'low', tenants: 'low', email: 'low', phone: 'low', rent: 'low', deposit: 'low', start: 'low', end: 'low' },
    notes, source: 'none',
  };
}

// ---------- lane card (embedded in the Import Hub) ----------

export function leasePdfLaneCard(ctx: Ctx, props: { id: string; name: string }[]): Raw {
  const ai = llmStatus();
  return card('Upload signed lease PDFs', html`
    <p class="muted" style="margin-top:0">Drop in your executed leases — tenants, unit, rent, deposit and dates are extracted into drafts you review and approve. Units are created if they don't exist yet.
    ${ai.live ? html` <span class="pill">AI document reading: live (${ai.model})</span>` : html` <span class="muted small">(Live AI off — typed PDFs still read locally; scans need the key.)</span>`}</p>
    <form method="post" action="/setup/import/leases/upload" enctype="multipart/form-data">
      <div class="form-grid">
        ${field('Lease PDFs (up to 20)', raw('<input type="file" name="files" accept=".pdf,application/pdf" multiple required />'))}
        ${field('Property', props.length ? select('property', props.map((p) => [p.id, p.name] as [string, Child]), '', { required: true }) : html`<span class="muted">Create a property first (rent-roll import or wizard).</span>`)}
        ${field('As-of (switch) date', input('as_of', { type: 'date', value: ctx.businessDate }), 'Billing here starts the month after; past months belong to your old system.')}
      </div>
      <div class="wiz-actions"><button class="btn" ${props.length ? '' : 'disabled'}>Upload &amp; extract</button></div>
    </form>`);
}

// ---------- routes ----------

export function leasePdfRoutes(r: Router): void {
  r.post('/setup/import/leases/upload', requirePerm('properties:manage'), async (rq) => {
    const ctx = rq.ctx as Ctx;
    const propertyId = String(rq.body.property || '');
    if (!propertyId || !canAccessProperty(ctx, propertyId)) return redirect('/setup/import?tab=leases', 'Choose a property for these leases.', 'err');
    const pdfs = (rq.uploads || []).filter((u) => u.field === 'files' && u.data.length).slice(0, 20);
    if (!pdfs.length) return redirect('/setup/import?tab=leases', 'Choose at least one PDF.', 'err');

    const drafts: LeaseDraft[] = [];
    for (const up of pdfs) {
      if (up.data.length > 10 * 1024 * 1024) {
        drafts.push({
          filename: up.filename || 'lease.pdf', fileId: null, include: false,
          fields: { unit: '', tenants: '', email: '', phone: '', rent: '', deposit: '', start: '', end: '' },
          confidence: {}, notes: ['File over 10 MB — skipped.'], source: 'none',
        });
        continue;
      }
      const extracted = await extractDraft(up.filename || 'lease.pdf', up.data);
      const f = putFile(ctx, up.data, { name: up.filename || 'lease.pdf', mime: 'application/pdf', entity: 'import', visibility: 'staff' });
      drafts.push({ ...extracted, fileId: f.id, include: extracted.source !== 'none' });
    }

    const batchId = id('imp');
    insert('import_batches', {
      id: batchId, org_id: ctx.orgId, kind: 'lease_pdf', filename: pdfs.length === 1 ? pdfs[0]!.filename : `${pdfs.length} lease PDFs`,
      property_id: propertyId, new_property_name: null, preset: null,
      headers: '[]', mapping: '{}', rows: '[]', staged: js(drafts),
      as_of: String(rq.body.as_of || '') || ctx.businessDate,
      status: 'staged', summary: null, created_by: ctx.userId, created_at: nowIso(), applied_at: null,
    });
    audit(ctx, 'import_batch', batchId, 'upload', null, { kind: 'lease_pdf', files: pdfs.length });
    return redirect(`/setup/import/leases/${batchId}`);
  });

  r.get('/setup/import/leases/:id', requirePerm('properties:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const batch = q1<BatchRow>(`SELECT * FROM import_batches WHERE id=? AND org_id=? AND kind='lease_pdf'`, rq.params.id!, ctx.orgId);
    if (!batch) return notFound('Import not found');
    if (batch.status !== 'staged') return redirect('/setup/import', 'That import is already settled.');
    return reviewLeases(rq, batch);
  });

  r.post('/setup/import/leases/:id/apply', requirePerm('properties:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const batch = q1<BatchRow>(`SELECT * FROM import_batches WHERE id=? AND org_id=? AND kind='lease_pdf'`, rq.params.id!, ctx.orgId);
    if (!batch || batch.status !== 'staged') return notFound('Import not found');
    const drafts = j<LeaseDraft[]>(batch.staged, []);
    const asOf = batch.as_of || ctx.businessDate;
    const billingStart = firstOfMonth(addMonths(asOf, 1));
    const pid = batch.property_id!;
    if (!canAccessProperty(ctx, pid)) return notFound('Property not found');

    // read edited fields back from the form
    drafts.forEach((d, i) => {
      d.include = rq.body[`inc_${i}`] === 'on' || rq.body[`inc_${i}`] === '1';
      for (const k of Object.keys(d.fields) as (keyof LeaseDraft['fields'])[]) {
        const v = rq.body[`f_${i}_${k}`];
        if (v !== undefined) d.fields[k] = String(v).trim();
      }
    });

    let leases = 0, residents = 0, units = 0, skipped = 0, depositsCents = 0;
    const problems: string[] = [];
    tx(() => {
      ensureOpeningEquityAccount(ctx.orgId);
      let depositTotal = 0;
      drafts.forEach((d, di) => {
        if (!d.include) { skipped++; return; }
        const unitNo = d.fields.unit.trim();
        const tenants = d.fields.tenants.split(/\s*(?:&| and )\s*/i).map((t) => t.trim()).filter(Boolean).slice(0, 4);
        const rentCents = moneyToCents(d.fields.rent) ?? 0;
        const depositCents = moneyToCents(d.fields.deposit) ?? 0;
        let start = toIsoDate(d.fields.start) || asOf;
        let end = toIsoDate(d.fields.end) || addMonths(start, 12);
        if (!unitNo || !tenants.length || rentCents <= 0) {
          skipped++;
          problems.push(`${d.filename}: needs at least a unit, tenant and rent — skipped.`);
          return;
        }
        if (end < start) end = addMonths(start, 12);

        let unit = q1<any>('SELECT * FROM units WHERE property_id=? AND unit_number=?', pid, unitNo);
        if (unit && q1(`SELECT id FROM leases WHERE unit_id=? AND status IN ('active','month_to_month','notice') LIMIT 1`, unit.id)) {
          skipped++;
          problems.push(`${d.filename}: unit ${unitNo} already has an active lease — skipped.`);
          return;
        }
        if (!unit) {
          const fid = q1<{ id: string }>('SELECT id FROM floorplans WHERE property_id=? AND LOWER(name)=?', pid, 'imported')?.id || ((): string => {
            const nid = id('fpl');
            insert('floorplans', { id: nid, org_id: ctx.orgId, property_id: pid, name: 'Imported', beds: 1, baths: 1, sqft: 750, market_rent_cents: rentCents || 100000, created_at: nowIso() });
            return nid;
          })();
          const uid = id('unt');
          insert('units', {
            id: uid, org_id: ctx.orgId, property_id: pid, building_id: null, floorplan_id: fid,
            unit_number: unitNo, floor: 1, sqft: 750, status: 'occupied',
            market_rent_cents: rentCents || 100000, amenities: '[]', notes: null, created_at: nowIso(),
          });
          unit = q1<any>('SELECT * FROM units WHERE id=?', uid);
          units++;
        }

        const mtm = end < asOf;
        const householdName = tenants.join(' & ');
        const leaseId = id('lse');
        insert('leases', {
          id: leaseId, org_id: ctx.orgId, property_id: pid, unit_id: unit.id,
          household_name: householdName, status: mtm ? 'month_to_month' : 'active',
          start_date: start, end_date: end, move_in_date: start, move_out_date: null, notice_date: null,
          mtm_since: mtm ? end : null, rent_cents: rentCents, deposit_cents: depositCents,
          deposit_alternative: 0, term_months: 12, application_id: null, renewal_of_lease_id: null,
          template_id: null, packet_file_id: d.fileId, esign_request_id: null, bed_label: null,
          billing_start_date: billingStart, created_at: nowIso(),
        });
        insert('lease_charges', {
          id: id('lch'), org_id: ctx.orgId, lease_id: leaseId, kind: 'rent', label: 'Rent',
          amount_cents: rentCents, gl_account_code: null, rentable_item_id: null,
          start_date: billingStart, end_date: null, created_at: nowIso(),
        });
        run(`UPDATE units SET status='occupied' WHERE id=?`, unit.id);
        tenants.forEach((t, ti) => {
          const nm = splitName(t);
          const rid = id('res');
          insert('residents', {
            id: rid, org_id: ctx.orgId, property_id: pid, user_id: null,
            first_name: nm.first || nm.display, last_name: nm.last,
            email: ti === 0 ? d.fields.email || null : null, phone: ti === 0 ? d.fields.phone || null : null,
            kind: 'adult', employer: null, monthly_income_cents: null, ssn_last4: null, created_at: nowIso(),
          });
          insert('household_members', { id: id('hm'), org_id: ctx.orgId, lease_id: leaseId, resident_id: rid, role: ti === 0 ? 'primary' : 'co', created_at: nowIso() });
          residents++;
        });
        if (depositCents > 0) depositTotal += depositCents;
        leases++;
        audit(ctx, 'lease', leaseId, 'import_from_pdf', null, { file: d.filename, unit: unitNo, batch: batch.id, index: di });
      });

      if (depositTotal > 0) {
        depositsCents = depositTotal;
        postBothBases(ctx, {
          propertyId: pid, date: asOf, memo: 'Migrated security deposits held (lease PDFs)',
          sourceKind: 'conversion', sourceId: batch.id,
          lines: [
            { account: '1020', debit: depositTotal, memo: 'Security deposit cash carried in' },
            { account: '2100', credit: depositTotal, memo: 'Security deposits held' },
          ],
        });
      }
      run('UPDATE import_batches SET status=?, applied_at=?, summary=?, staged=? WHERE id=?', 'applied', nowIso(), js({ leases, residents, units, skipped }), js(drafts), batch.id);
      audit(ctx, 'import_batch', batch.id, 'apply', null, { leases, residents, units, skipped });
    });
    emit(ctx, 'import.applied', 'import_batch', batch.id, { kind: 'lease_pdf', leases, residents, units, skipped });
    const problemNote = problems.length ? ` ${problems.join(' ')}` : '';
    return redirect(`/properties/${pid}`, `Imported ${leases} lease${leases === 1 ? '' : 's'} (${residents} resident${residents === 1 ? '' : 's'}${units ? `, ${units} new unit${units === 1 ? '' : 's'}` : ''}${depositsCents ? `, $${(depositsCents / 100).toLocaleString('en-US')} deposits held` : ''}).${problemNote}`);
  });
}

function reviewLeases(rq: Rq, batch: BatchRow): ReturnType<typeof shell> {
  const drafts = j<LeaseDraft[]>(batch.staged, []);
  const prop = q1<{ name: string }>('SELECT name FROM properties WHERE id=?', batch.property_id);
  const lowBadge = (d: LeaseDraft, k: string): Raw | '' => (d.confidence[k] === 'low' ? html` <span class="pill" style="background:#fef3c7;color:#92400e" title="Low confidence — please verify">check</span>` : '');
  return shell(rq, {
    title: 'Review extracted leases',
    active: '/setup/import',
    crumbs: [['Setup', '/setup'], ['Migration Center', '/setup/import'], ['Lease PDFs']],
    subtitle: `${drafts.length} document${drafts.length === 1 ? '' : 's'} → ${prop?.name || 'property'} · every field is editable before anything imports`,
    content: html`
      <form method="post" action="/setup/import/leases/${batch.id}/apply">
        ${drafts.map((d, i) => card(html`${d.filename} ${d.source === 'ai' ? statusBadge('ok', 'AI read') : d.source === 'text' ? statusBadge('ok', 'Text read') : statusBadge('error', 'Unreadable')}`, html`
          ${when(d.notes.length, () => html`<div class="callout ${d.source === 'none' ? 'bad' : 'info'}" style="margin-top:0">${d.notes.join(' ')}</div>`)}
          <label style="display:flex;gap:8px;align-items:center;margin-bottom:10px"><input type="checkbox" name="inc_${i}" ${d.include ? 'checked' : ''} /> Import this lease</label>
          <div class="form-grid">
            ${field(html`Unit${lowBadge(d, 'unit')}`, input(`f_${i}_unit`, { value: d.fields.unit }))}
            ${field(html`Tenant(s)${lowBadge(d, 'tenants')}`, input(`f_${i}_tenants`, { value: d.fields.tenants, placeholder: 'First Last & First Last' }))}
            ${field(html`Monthly rent (USD)${lowBadge(d, 'rent')}`, input(`f_${i}_rent`, { value: d.fields.rent }))}
            ${field(html`Deposit (USD)${lowBadge(d, 'deposit')}`, input(`f_${i}_deposit`, { value: d.fields.deposit }))}
            ${field(html`Lease start${lowBadge(d, 'start')}`, input(`f_${i}_start`, { type: 'date', value: d.fields.start }))}
            ${field(html`Lease end${lowBadge(d, 'end')}`, input(`f_${i}_end`, { type: 'date', value: d.fields.end }))}
            ${field(html`Email${lowBadge(d, 'email')}`, input(`f_${i}_email`, { value: d.fields.email }))}
            ${field(html`Phone${lowBadge(d, 'phone')}`, input(`f_${i}_phone`, { value: d.fields.phone }))}
          </div>
          ${when(!!d.fileId, () => html`<p class="small"><a href="/f/${d.fileId}" target="_blank">Open the PDF</a> to verify.</p>`)}
        `))}
        <div class="wiz-actions">
          <button class="btn" type="submit">Import checked leases</button>
        </div>
      </form>
      <form method="post" action="/setup/import/b/${batch.id}/discard" style="margin-top:8px"><button class="btn btn-ghost" type="submit">Discard all</button></form>
      <p class="muted small">Units that don't exist yet are created. Expired terms import as month-to-month. Billing starts the month after your switch date.</p>
    `,
  });
}
