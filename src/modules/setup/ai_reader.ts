import { llmGenerate, llmExtractPdf, llmStatus } from '../../lib/sim/llm.ts';
import { fieldsFor, mergeStackedHeader, type ImportKind, type Mapping } from './mapping.ts';
import type { Sheet } from '../../lib/xlsx.ts';

/** AI-first document reading for the Migration Center.
 *
 * The trust architecture matters more than the intelligence: the model never
 * writes to the database. For spreadsheets it produces a READING PLAN —
 * "row 2 is the header, column 0 is the unit, rows 8/15/22 are subtotals,
 * row 3 says 'Maple Court' and names the section" — and deterministic code
 * executes that plan into the exact same rows+mapping shape the heuristic
 * path produces. For PDF rent rolls the model returns the table as records.
 * Either way, everything still flows through the same validators, the same
 * human review screen, and the same transactional apply. AI proposes;
 * code and humans dispose. */

// ---------- plan shape ----------

export interface ReadingPlan {
  header_row: number; // -1 = no header row present
  cols: Record<number, string>; // column index → canonical field key
  skip_rows: number[]; // titles, totals, summaries — not unit data
  sections: { row: number; property: string }[]; // property section headers
  /** the property the whole document is about, when its title names one */
  document_property?: string;
  /** in a block-format roll with a charge-code column, which code IS the rent.
   * The model reads this semantically — "rntnt" is the tenant's rent,
   * "rnsvchr" is a housing subsidy, "tsprkg" is parking — where header-word
   * matching has nothing to match on. Deterministic code still verifies the
   * code exists in the file before using it, and still computes the split. */
  rent_code?: string;
}

export interface ReadResult {
  headers: string[];
  dataRows: string[][];
  mapping: Mapping;
  notes: string[];
}

// ---------- sheet rendering (what the model sees) ----------

const RENDER_HEAD_ROWS = 140;
const RENDER_TAIL_ROWS = 12;
const RENDER_MAX_COLS = 40;
const CELL_CLIP = 28;

/** A row worth showing the model even when it falls in the elided middle:
 * anything that looks like a heading or a subtotal — a short run of words with
 * no money in it. Those rows are exactly where a document changes meaning
 * ("Future Residents/Applicants" at row 474 of a 542-row file), and a
 * head+tail window silently hides them: the model plans a read of a document
 * whose middle it never saw, and then its plan is wrong in the one place
 * accuracy costs money. */
function isStructuralRow(row: string[]): boolean {
  const filled = row.map((c) => String(c ?? '').trim()).filter(Boolean);
  if (!filled.length || filled.length > 14) return false;
  // every filled cell is a short word-ish label and none is a number: that is
  // a heading or a sub-header, never a unit of data (a rent-roll data row
  // always carries an amount, and a vacant one carries a zero)
  return filled.every((c) => c.length <= 48 && /[a-zA-Z]/.test(c) && !/^\$?[\d,]+\.?\d*$/.test(c));
}

/** Resolve a string the MODEL returned back to the cell it came from.
 *
 * The grid the model reads is clipped to CELL_CLIP characters per cell, so any
 * string it echoes back is a PREFIX of the real value, not the value. Copying
 * one straight into the database is how the 2026-08-12 live import stored a
 * property called "Livingston Place at Souther" — 27 characters, cut mid-word,
 * which then propagated to the property record, every screen, and the public
 * marketing slug /p/livingston-place-at-souther.
 *
 * So a model string that will be persisted is treated as a POINTER into the
 * sheet, never as data: find the cell it is a prefix of and use that cell's
 * full text. Nothing matches → return the model's string unchanged (it may be
 * a genuinely short value), and the caller's deterministic reader still gets
 * to win on its own merits. */
export function resolveClippedString(value: string, rows: string[][]): string {
  const want = String(value ?? '').replace(/…+\s*$/, '').trim();
  if (!want) return '';
  let best = want;
  for (const row of rows) {
    for (const cell of row) {
      const full = String(cell ?? '').replace(/[\t\n\r]+/g, ' ').trim();
      if (full.length > best.length && full.startsWith(want)) best = full;
    }
  }
  return best;
}

export function renderSheetForAi(rows: string[][]): string {
  const clip = (c: string): string => {
    const s = String(c ?? '').replace(/[\t\n\r]+/g, ' ').trim();
    return s.length > CELL_CLIP ? s.slice(0, CELL_CLIP - 1) + '…' : s;
  };
  const line = (r: string[], i: number): string => `${i}: ${r.slice(0, RENDER_MAX_COLS).map(clip).join(' | ')}`;
  if (rows.length <= RENDER_HEAD_ROWS + RENDER_TAIL_ROWS) {
    return rows.map(line).join('\n');
  }
  const headEnd = RENDER_HEAD_ROWS;
  const tailStart = rows.length - RENDER_TAIL_ROWS;
  const out: string[] = rows.slice(0, headEnd).map(line);
  // walk the middle, keeping every structural row (with one row of context on
  // each side) and collapsing the uniform data runs between them
  let elided = 0;
  const flush = (): void => {
    if (elided) out.push(`… (${elided} more data rows omitted; same shape as above) …`);
    elided = 0;
  };
  for (let i = headEnd; i < tailStart; i++) {
    const near = isStructuralRow(rows[i]!) || isStructuralRow(rows[i - 1] || []) || isStructuralRow(rows[i + 1] || []);
    if (near) { flush(); out.push(line(rows[i]!, i)); } else elided++;
  }
  flush();
  out.push(...rows.slice(tailStart).map((r, k) => line(r, tailStart + k)));
  return out.join('\n');
}

// ---------- plan validation (never trust model output blindly) ----------

export function validatePlan(raw: unknown, rowCount: number, colCount: number, kind: ImportKind): ReadingPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const fieldKeys = new Set(fieldsFor(kind).map((f) => f.key));
  const inRow = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < rowCount;

  const header = Number.isInteger(p.header_row) && (p.header_row as number) >= -1 && (p.header_row as number) < rowCount
    ? (p.header_row as number) : -1;

  const cols: Record<number, string> = {};
  const claimed = new Set<string>();
  if (p.cols && typeof p.cols === 'object') {
    for (const [k, v] of Object.entries(p.cols as Record<string, unknown>)) {
      const ci = parseInt(k, 10);
      const field = String(v);
      if (!Number.isInteger(ci) || ci < 0 || ci >= colCount) continue;
      if (!fieldKeys.has(field) || claimed.has(field)) continue;
      cols[ci] = field;
      claimed.add(field);
    }
  }
  if (!claimed.size) return null;
  // a rent-roll plan that can't find the unit column is not a usable plan
  if (kind === 'rent_roll' && !claimed.has('unit')) return null;
  if (kind === 'vendors' && !claimed.has('name')) return null;

  const skip = Array.isArray(p.skip_rows) ? [...new Set((p.skip_rows as unknown[]).filter(inRow))] as number[] : [];
  const sections: { row: number; property: string }[] = [];
  if (Array.isArray(p.sections)) {
    for (const s of p.sections as unknown[]) {
      if (!s || typeof s !== 'object') continue;
      const row = (s as any).row;
      const property = String((s as any).property || '').trim();
      if (!inRow(row) || !property || row === header) continue;
      // A ROSTER heading is not a property. "Current/Notice/Vacant Residents"
      // and "Future Residents/Applicants" head sections of ONE property's rent
      // roll; letting either through as a section name would inject a synthetic
      // Property column and create a property literally named after the
      // heading. Deterministic vocabulary beats a model's row label here, for
      // the same reason the stacked-header merge is unconditional.
      if (ROSTER_LABEL.test(property)) { skip.push(row); continue; }
      sections.push({ row, property: property.slice(0, 80) });
    }
  }
  sections.sort((a, b) => a.row - b.row);
  const docProp = typeof p.document_property === 'string' ? p.document_property.trim().slice(0, 80) : '';
  const rentCode = typeof p.rent_code === 'string' ? p.rent_code.trim().slice(0, 24) : '';
  return {
    header_row: header,
    cols,
    skip_rows: [...new Set(skip)].filter((r) => r !== header),
    sections,
    ...(docProp ? { document_property: docProp } : {}),
    ...(rentCode ? { rent_code: rentCode } : {}),
  };
}

/** Section headings that describe a slice of ONE property's roster (or the
 * report's own arithmetic) rather than naming a building. */
const ROSTER_LABEL = /^\s*(current|future|occupied|vacant|notice|pending|applicants?|summary|totals?|non\s*rev)\b|residents?\s*\/\s*applicants?|^\s*(sub)?total/i;

/** Which of the fields that matter most did a mapping find? Used to pick
 * between the AI plan and the heuristic when both produce something. */
export function mappingScore(cols: Record<number, string>, kind: ImportKind): number {
  const important = kind === 'rent_roll'
    ? ['unit', 'tenant', 'rent', 'lease_start', 'lease_end', 'balance', 'deposit', 'property']
    : kind === 'vendors' ? ['name', 'category', 'email', 'phone'] : ['unit', 'balance', 'tenant'];
  const mapped = new Set(Object.values(cols));
  return important.filter((f) => mapped.has(f)).length + Object.keys(cols).length * 0.01;
}

// ---------- plan execution (deterministic) ----------

export function applyReadingPlan(rows: string[][], plan: ReadingPlan, kind: ImportKind): ReadResult {
  const skip = new Set(plan.skip_rows);
  const notes: string[] = [];

  const colCount = Math.max(...rows.map((r) => r.length), Object.keys(plan.cols).length ? Math.max(...Object.keys(plan.cols).map(Number)) + 1 : 1);
  let headers: string[];
  let sections = plan.sections;
  if (plan.header_row >= 0) {
    // stacked two-row headers (Yardi): merge the sub-labels into the titles
    // and consume the continuation row so it never reads as data. The merge
    // is attempted UNCONDITIONALLY — the plan's own row taxonomy (skip rows,
    // section labels) never suppresses it, because a sub-label row ("Sq Ft" /
    // "Deposit" / "Expiration") is not a property section. The 2026-08-11
    // live import showed what happens when the model's labels win: raw
    // one-word headers ("Lease", "Other"), deposits read from the wrong
    // column, $0 applied where $99k was owed. Deterministic safety nets do
    // not defer to model row labels.
    const base = Array.from({ length: colCount }, (_, i) => String(rows[plan.header_row]?.[i] ?? ''));
    const stacked = mergeStackedHeader(base, rows[plan.header_row + 1]);
    if (stacked.merged) {
      skip.add(plan.header_row + 1);
      sections = sections.filter((s) => s.row !== plan.header_row + 1);
      notes.push('Merged a stacked two-row header.');
    }
    headers = stacked.headers.map((h, i) => h || `Column ${i + 1}`);
  } else {
    headers = Array.from({ length: colCount }, (_, i) => plan.cols[i] ? fieldsFor(kind).find((f) => f.key === plan.cols[i])!.label : `Column ${i + 1}`);
  }
  const sectionRows = new Set(sections.map((s) => s.row));

  const propertyFor = (rowIdx: number): string => {
    let name = '';
    for (const s of sections) {
      if (s.row < rowIdx) name = s.property;
      else break;
    }
    return name;
  };

  const dataRows: string[][] = [];
  let skipped = 0;
  rows.forEach((r, i) => {
    if (i === plan.header_row || skip.has(i) || sectionRows.has(i)) { if (i !== plan.header_row) skipped++; return; }
    if (plan.header_row >= 0 && i < plan.header_row) { skipped++; return; }
    if (!r.some((c) => String(c).trim() !== '')) return;
    const base = Array.from({ length: colCount }, (_, ci) => String(r[ci] ?? ''));
    dataRows.push(sections.length ? [propertyFor(i), ...base] : base);
  });

  let cols: Record<number, string> = { ...plan.cols };
  let outHeaders = headers;
  if (sections.length) {
    // inject a synthetic Property column so the standard multi-property path applies
    const shifted: Record<number, string> = { 0: 'property' };
    for (const [k, v] of Object.entries(plan.cols)) shifted[Number(k) + 1] = v;
    cols = shifted;
    outHeaders = ['Property', ...headers];
    notes.push(`Found ${sections.length} property section${sections.length === 1 ? '' : 's'}: ${sections.map((s) => s.property).slice(0, 6).join(', ')}${sections.length > 6 ? '…' : ''}.`);
  }
  if (skipped) notes.push(`Skipped ${skipped} non-data row${skipped === 1 ? '' : 's'} (titles, totals, section labels).`);

  return {
    headers: outHeaders,
    dataRows,
    mapping: { cols, preset: 'ai-read', aiAssisted: [], reader: 'ai', notes } as Mapping,
    notes,
  };
}

// ---------- the AI calls ----------

function extractJson(text: string): unknown {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function fieldList(kind: ImportKind): string {
  return fieldsFor(kind).map((f) => `${f.key} — ${f.label}${f.hint ? ` (${f.hint})` : ''}`).join('\n');
}

const PLAN_SYSTEM = `You analyze property-management spreadsheet exports (rent rolls, vendor lists, balance reports). Given a numbered grid, reply with ONLY JSON:
{"header_row": <int, -1 if none>, "cols": {"<colIndex>": "<fieldKey>"}, "skip_rows": [<ints>], "sections": [{"row": <int>, "property": "<name>"}], "document_property": "<name or empty>", "rent_code": "<code or empty>"}
Rules:
- header_row: the row containing column titles. When titles span two stacked rows (sub-labels like "Sq Ft" / "Deposit" directly under the titles), header_row is the FIRST of them.
- cols: map ONLY columns that clearly match a canonical field. Judge by what the VALUES are, not only by what the title says: a "Resident" column holding codes like "t0002302" is not the tenant name, and the column holding "Amount" next to a charge code is the rent.
- skip_rows: report titles, blank spacers, TOTAL/SUBTOTAL/summary rows, footers — anything that is not one unit/record of data.
- Rows that continue the unit above with an additional recurring charge line (blank unit cell, a short charge code plus an amount — parking, pet, storage) ARE data rows: do NOT list them in skip_rows.
- sections: rows that label a PROPERTY/BUILDING whose name applies to the data rows BELOW them (common in multi-property rent rolls). A heading that slices ONE property's roster — "Current/Notice/Vacant Residents", "Future Residents/Applicants", "Summary Groups" — is NOT a property: put those in skip_rows instead. Never list a row in both.
- document_property: when the title banner names the ONE property the whole document covers ("Station U & O (1022)"), its name without any trailing code; empty when the file spans several properties or no name appears.
- rent_code: when the file has a charge-code column, the code that means base rent — read the codes' meaning, e.g. "rntnt" (tenant rent) is rent while "rnsvchr" (housing subsidy/voucher), "tsprkg" (parking), "petfee" are not. Empty when the file has no charge codes or none of them is rent.
- Everything not listed is treated as a data row.`;

/** Ask the model to read the whole sheet. Returns null when the AI is off,
 * times out, or produces an unusable plan — callers fall back to heuristics. */
export async function aiPlanSpreadsheet(sheet: Sheet, kind: ImportKind): Promise<ReadingPlan | null> {
  if (!llmStatus().live) return null;
  const rows = sheet.rows;
  if (!rows.length) return null;
  const colCount = Math.max(...rows.map((r) => r.length));
  const res = await llmGenerate({
    system: PLAN_SYSTEM,
    prompt: `Canonical fields for this import (${kind}):\n${fieldList(kind)}\n\nGrid (${rows.length} rows × ${colCount} cols, "row: cell | cell | …"):\n${renderSheetForAi(rows)}\n\nJSON only:`,
    fallback: '',
    maxTokens: 1500,
    extended: true,
    cacheKey: `plan:${kind}:${sheet.name}:${rows.length}x${colCount}:${JSON.stringify(rows[0] || [])}`,
  });
  if (!res.text) return null;
  const plan = validatePlan(extractJson(res.text), rows.length, colCount, kind);
  if (!plan) return null;
  // Every string the model echoes back came off a CLIPPED grid, so resolve each
  // one that can reach the database back to the cell it points at. Numbers and
  // row indexes are the model's own analysis and stay as they are; text is not.
  if (plan.document_property) plan.document_property = resolveClippedString(plan.document_property, rows);
  for (const s of plan.sections) s.property = resolveClippedString(s.property, rows);
  return plan;
}

// ---------- PDF rent rolls → records ----------

const PDF_ROWS_SYSTEM = `You extract the unit table from property-management rent-roll documents. Reply with ONLY JSON:
{"property": "<name or empty>", "rows": [{"unit": "", "tenant": "", "floorplan": "", "beds": "", "baths": "", "sqft": "", "market_rent": "", "rent": "", "deposit": "", "balance": "", "lease_start": "YYYY-MM-DD", "lease_end": "YYYY-MM-DD", "move_in": "", "status": "", "email": "", "phone": "", "property": ""}]}
Rules: one object per unit; empty string for anything absent; amounts as plain dollar strings ("1450.00"); dates ISO; include vacant units with an empty tenant; NEVER include total/summary lines as rows; if the document covers several properties, set "property" per row. Never invent data.`;

export interface PdfTableResult {
  headers: string[];
  dataRows: string[][];
  mapping: Mapping;
  notes: string[];
}

/** Read a whole rent-roll PDF into rows via the live model. Null on failure. */
export async function aiReadPdfTable(pdf: Buffer, kind: ImportKind): Promise<PdfTableResult | null> {
  if (!llmStatus().live) return null;
  const res = await llmExtractPdf({
    system: PDF_ROWS_SYSTEM,
    prompt: `Extract every unit row from this document. JSON only:`,
    pdf,
    fallback: '',
    maxTokens: 8000,
  });
  if (!res.text) return null;
  return pdfRowsToTable(extractJson(res.text) as { property?: unknown; rows?: unknown } | null, kind);
}

/** Deterministic conversion of the model's record list into the standard
 * headers/rows/mapping shape (exported for tests). */
export function pdfRowsToTable(parsed: { property?: unknown; rows?: unknown } | null, kind: ImportKind): PdfTableResult | null {
  if (!parsed || !Array.isArray(parsed.rows) || !parsed.rows.length) return null;

  const fields = fieldsFor(kind);
  const order = fields.map((f) => f.key);
  const docProperty = String(parsed.property || '').trim();

  // keep only keys that actually appear, in canonical order
  const present = new Set<string>();
  const clean: Record<string, string>[] = [];
  for (const r of (parsed.rows as unknown[]).slice(0, 1000)) {
    if (!r || typeof r !== 'object') continue;
    const rec: Record<string, string> = {};
    for (const k of order) {
      const v = (r as Record<string, unknown>)[k];
      if (typeof v === 'string' && v.trim() !== '') {
        rec[k] = v.trim();
        present.add(k);
      } else if (typeof v === 'number') {
        rec[k] = String(v);
        present.add(k);
      }
    }
    const hasOwnContent = Object.keys(rec).length > 0; // before doc-level fill-in
    if (docProperty && !rec.property) { rec.property = docProperty; present.add('property'); }
    if (hasOwnContent) clean.push(rec);
  }
  if (!clean.length || !present.has('unit')) return null;

  const keys = order.filter((k) => present.has(k));
  const cols: Record<number, string> = {};
  keys.forEach((k, i) => { cols[i] = k; });
  const notes = [`Read ${clean.length} row${clean.length === 1 ? '' : 's'} directly from the PDF by AI — verify before applying.`];
  return {
    headers: keys.map((k) => fields.find((f) => f.key === k)!.label),
    dataRows: clean.map((rec) => keys.map((k) => rec[k] || '')),
    mapping: { cols, preset: 'ai-read', aiAssisted: [], reader: 'ai', notes } as Mapping,
    notes,
  };
}
