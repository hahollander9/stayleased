import { llmGenerate, llmExtractPdf, llmStatus } from '../../lib/sim/llm.ts';
import { fieldsFor, type ImportKind, type Mapping } from './mapping.ts';
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

export function renderSheetForAi(rows: string[][]): string {
  const clip = (c: string): string => {
    const s = String(c ?? '').replace(/[\t\n\r]+/g, ' ').trim();
    return s.length > CELL_CLIP ? s.slice(0, CELL_CLIP - 1) + '…' : s;
  };
  const line = (r: string[], i: number): string => `${i}: ${r.slice(0, RENDER_MAX_COLS).map(clip).join(' | ')}`;
  if (rows.length <= RENDER_HEAD_ROWS + RENDER_TAIL_ROWS) {
    return rows.map(line).join('\n');
  }
  const head = rows.slice(0, RENDER_HEAD_ROWS).map(line);
  const tail = rows.slice(rows.length - RENDER_TAIL_ROWS).map((r, k) => line(r, rows.length - RENDER_TAIL_ROWS + k));
  return [...head, `… (${rows.length - RENDER_HEAD_ROWS - RENDER_TAIL_ROWS} more data rows omitted; same shape) …`, ...tail].join('\n');
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
      if (inRow(row) && property && row !== header) sections.push({ row, property: property.slice(0, 80) });
    }
  }
  sections.sort((a, b) => a.row - b.row);
  return { header_row: header, cols, skip_rows: skip.filter((r) => r !== header), sections };
}

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
  const sectionRows = new Set(plan.sections.map((s) => s.row));
  const notes: string[] = [];

  const colCount = Math.max(...rows.map((r) => r.length), Object.keys(plan.cols).length ? Math.max(...Object.keys(plan.cols).map(Number)) + 1 : 1);
  const headers = plan.header_row >= 0
    ? Array.from({ length: colCount }, (_, i) => String(rows[plan.header_row]?.[i] ?? '') || `Column ${i + 1}`)
    : Array.from({ length: colCount }, (_, i) => plan.cols[i] ? fieldsFor(kind).find((f) => f.key === plan.cols[i])!.label : `Column ${i + 1}`);

  const propertyFor = (rowIdx: number): string => {
    let name = '';
    for (const s of plan.sections) {
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
    dataRows.push(plan.sections.length ? [propertyFor(i), ...base] : base);
  });

  let cols: Record<number, string> = { ...plan.cols };
  let outHeaders = headers;
  if (plan.sections.length) {
    // inject a synthetic Property column so the standard multi-property path applies
    const shifted: Record<number, string> = { 0: 'property' };
    for (const [k, v] of Object.entries(plan.cols)) shifted[Number(k) + 1] = v;
    cols = shifted;
    outHeaders = ['Property', ...headers];
    notes.push(`Found ${plan.sections.length} property section${plan.sections.length === 1 ? '' : 's'}: ${plan.sections.map((s) => s.property).slice(0, 6).join(', ')}${plan.sections.length > 6 ? '…' : ''}.`);
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
{"header_row": <int, -1 if none>, "cols": {"<colIndex>": "<fieldKey>"}, "skip_rows": [<ints>], "sections": [{"row": <int>, "property": "<name>"}]}
Rules:
- header_row: the row containing column titles.
- cols: map ONLY columns that clearly match a canonical field. Never guess.
- skip_rows: report titles, blank spacers, TOTAL/SUBTOTAL/summary rows, footers — anything that is not one unit/record of data.
- sections: rows that label a property/building whose name applies to the data rows BELOW them (common in multi-property rent rolls). Do not list them in skip_rows too.
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
  return validatePlan(extractJson(res.text), rows.length, colCount, kind);
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
