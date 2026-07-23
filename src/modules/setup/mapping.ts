/** Universal spreadsheet → portfolio mapping engine.
 *
 * The customer uploads whatever their old system produces — a Buildium or
 * AppFolio rent roll, a Yardi report export, a hand-kept Excel sheet — and
 * this module figures out which column is which: exact/synonym/contains
 * scoring first, vendor preset signatures when the file "smells" like a known
 * system, and (when the live AI brain is configured) an LLM assist for the
 * stragglers. Humans confirm the mapping before anything is written. */

export type ImportKind = 'rent_roll' | 'vendors' | 'residents' | 'balances';

export interface FieldDef {
  key: string;
  label: string;
  required?: boolean; // required for the file to be importable at all
  hint?: string;
  synonyms: string[]; // normalized exact matches
  contains?: string[]; // normalized substring matches (weaker)
}

/** normalize a header: lowercase, strip punctuation, collapse spaces */
export function norm(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------- canonical fields per import kind ----------

export const RENT_ROLL_FIELDS: FieldDef[] = [
  { key: 'property', label: 'Property', hint: 'groups rows into properties when the file spans several', synonyms: ['property', 'property name', 'community', 'building name', 'complex', 'property code'], contains: ['property'] },
  { key: 'unit', label: 'Unit number', required: true, synonyms: ['unit', 'unit number', 'unit no', 'unit id', 'apt', 'apt no', 'apartment', 'apartment number', 'unit name', 'space', 'space number', 'lot', 'lot number'], contains: ['unit'] },
  { key: 'floorplan', label: 'Floorplan / unit type', synonyms: ['floorplan', 'floor plan', 'unit type', 'type', 'plan', 'model', 'bd ba', 'bed bath'], contains: ['floorplan', 'unit type'] },
  { key: 'beds', label: 'Beds', synonyms: ['beds', 'bed', 'bedrooms', 'br', 'bds'], contains: ['bedroom'] },
  { key: 'baths', label: 'Baths', synonyms: ['baths', 'bath', 'bathrooms', 'ba'], contains: ['bathroom'] },
  { key: 'sqft', label: 'Square feet', synonyms: ['sqft', 'sq ft', 'square feet', 'square footage', 'sf', 'size', 'area'], contains: ['sq ft', 'sqft', 'square'] },
  { key: 'market_rent', label: 'Market rent', synonyms: ['market rent', 'market', 'asking rent', 'scheduled rent', 'market rate'], contains: ['market'] },
  { key: 'status', label: 'Occupancy status', synonyms: ['status', 'occupancy', 'occupancy status', 'unit status', 'vacancy'], contains: ['status', 'occupancy'] },
  { key: 'tenant', label: 'Tenant name', synonyms: ['tenant', 'tenant name', 'resident', 'resident name', 'name', 'lessee', 'occupant', 'primary tenant', 'household', 'current tenant', 'tenants'], contains: ['tenant', 'resident'] },
  { key: 'first_name', label: 'First name', synonyms: ['first name', 'first', 'fname'], contains: ['first name'] },
  { key: 'last_name', label: 'Last name', synonyms: ['last name', 'last', 'lname', 'surname'], contains: ['last name'] },
  { key: 'email', label: 'Email', synonyms: ['email', 'e mail', 'email address', 'tenant email', 'resident email'], contains: ['email'] },
  { key: 'phone', label: 'Phone', synonyms: ['phone', 'phone number', 'mobile', 'cell', 'telephone', 'contact number', 'tenant phone'], contains: ['phone'] },
  { key: 'rent', label: 'Lease rent', synonyms: ['rent', 'lease rent', 'current rent', 'monthly rent', 'rent amount', 'rate', 'rent charge', 'actual rent', 'contract rent', 'rental rate', 'total rent'], contains: ['rent'] },
  { key: 'deposit', label: 'Security deposit', synonyms: ['deposit', 'security deposit', 'sec dep', 'sec deposit', 'deposit held', 'deposits held', 'security dep'], contains: ['deposit'] },
  { key: 'balance', label: 'Balance owed', hint: 'what the household owes as of the switch date', synonyms: ['balance', 'balance due', 'past due', 'amount owed', 'outstanding', 'delinquent', 'delinquency', 'ar balance', 'total owed', 'open balance', 'amount due', 'total due'], contains: ['balance', 'past due', 'due'] },
  { key: 'lease_start', label: 'Lease start', synonyms: ['lease start', 'lease from', 'start date', 'lease start date', 'lease begin', 'begin date', 'from'], contains: ['lease start', 'lease from'] },
  { key: 'lease_end', label: 'Lease end', synonyms: ['lease end', 'lease to', 'end date', 'lease end date', 'expiration', 'lease expiration', 'expiry', 'to'], contains: ['lease end', 'lease to', 'expir'] },
  { key: 'move_in', label: 'Move-in date', synonyms: ['move in', 'move in date', 'movein', 'moved in', 'occupancy date'], contains: ['move in'] },
  { key: 'move_out', label: 'Move-out date', synonyms: ['move out', 'move out date', 'moveout', 'notice date'], contains: ['move out'] },
];

export const VENDOR_FIELDS: FieldDef[] = [
  { key: 'name', label: 'Vendor name', required: true, synonyms: ['name', 'vendor', 'vendor name', 'company', 'company name', 'business name'], contains: ['vendor', 'name'] },
  { key: 'category', label: 'Trade / category', synonyms: ['category', 'trade', 'type', 'service', 'specialty', 'work type'], contains: ['categor', 'trade', 'service'] },
  { key: 'email', label: 'Email', synonyms: ['email', 'email address', 'e mail'], contains: ['email'] },
  { key: 'phone', label: 'Phone', synonyms: ['phone', 'phone number', 'mobile', 'telephone'], contains: ['phone'] },
  { key: 'address', label: 'Address', synonyms: ['address', 'street', 'mailing address'], contains: ['address'] },
];

export const RESIDENT_FIELDS: FieldDef[] = [
  { key: 'unit', label: 'Unit number', required: true, synonyms: ['unit', 'unit number', 'apt', 'apartment', 'unit no'], contains: ['unit'] },
  { key: 'tenant', label: 'Name', synonyms: ['name', 'tenant', 'resident', 'tenant name', 'resident name', 'full name'], contains: ['name'] },
  { key: 'first_name', label: 'First name', synonyms: ['first name', 'first', 'fname'], contains: ['first'] },
  { key: 'last_name', label: 'Last name', synonyms: ['last name', 'last', 'lname'], contains: ['last'] },
  { key: 'email', label: 'Email', synonyms: ['email', 'email address'], contains: ['email'] },
  { key: 'phone', label: 'Phone', synonyms: ['phone', 'mobile', 'cell'], contains: ['phone'] },
  { key: 'role', label: 'Role', hint: 'co-tenant / occupant / guarantor', synonyms: ['role', 'kind', 'relationship', 'resident type', 'type'], contains: ['role', 'relation'] },
];

export const BALANCE_FIELDS: FieldDef[] = [
  { key: 'unit', label: 'Unit number', required: true, synonyms: ['unit', 'unit number', 'apt', 'apartment'], contains: ['unit'] },
  { key: 'tenant', label: 'Tenant (check)', synonyms: ['tenant', 'resident', 'name', 'tenant name'], contains: ['tenant', 'resident', 'name'] },
  { key: 'balance', label: 'Balance owed', required: true, synonyms: ['balance', 'balance due', 'amount', 'amount owed', 'past due', 'total due', 'open balance'], contains: ['balance', 'due', 'amount'] },
];

export function fieldsFor(kind: ImportKind): FieldDef[] {
  return kind === 'vendors' ? VENDOR_FIELDS : kind === 'residents' ? RESIDENT_FIELDS : kind === 'balances' ? BALANCE_FIELDS : RENT_ROLL_FIELDS;
}

// ---------- competitor presets (header signatures → instant mapping) ----------

export interface Preset {
  key: string;
  name: string;
  /** normalized headers that identify this vendor's export */
  signature: string[];
  /** normalized header → field key (wins over generic synonyms) */
  map: Record<string, string>;
}

export const PRESETS: Preset[] = [
  {
    key: 'buildium', name: 'Buildium',
    signature: ['unit', 'tenant', 'market rent', 'lease from', 'lease to', 'deposit held'],
    map: { 'unit': 'unit', 'tenant': 'tenant', 'market rent': 'market_rent', 'rent': 'rent', 'lease from': 'lease_start', 'lease to': 'lease_end', 'deposit held': 'deposit', 'outstanding balance': 'balance', 'property': 'property', 'bd ba': 'floorplan', 'size sqft': 'sqft' },
  },
  {
    key: 'appfolio', name: 'AppFolio',
    signature: ['unit', 'tenant', 'rent', 'move in', 'lease expiration', 'past due'],
    map: { 'unit': 'unit', 'bd ba': 'floorplan', 'tenant': 'tenant', 'rent': 'rent', 'market rent': 'market_rent', 'deposit': 'deposit', 'lease from': 'lease_start', 'lease to': 'lease_end', 'lease expiration': 'lease_end', 'move in': 'move_in', 'move out': 'move_out', 'past due': 'balance', 'late count': '', 'nsf count': '' },
  },
  {
    key: 'yardi', name: 'Yardi',
    signature: ['unit', 'unit type', 'resident', 'market rent', 'lease from', 'lease to'],
    map: { 'unit': 'unit', 'unit type': 'floorplan', 'resident': 'tenant', 'name': 'tenant', 'market rent': 'market_rent', 'actual rent': 'rent', 'resident deposit': 'deposit', 'other deposit': '', 'move in': 'move_in', 'lease from': 'lease_start', 'lease to': 'lease_end', 'move out': 'move_out', 'balance': 'balance', 'sq ft': 'sqft' },
  },
  {
    key: 'rentmanager', name: 'Rent Manager',
    signature: ['unit', 'name', 'unit type', 'move in', 'lease end', 'security deposit'],
    map: { 'unit': 'unit', 'unit type': 'floorplan', 'name': 'tenant', 'rent': 'rent', 'market rent': 'market_rent', 'security deposit': 'deposit', 'move in': 'move_in', 'lease start': 'lease_start', 'lease end': 'lease_end', 'balance': 'balance' },
  },
  {
    key: 'tenantcloud', name: 'TenantCloud',
    signature: ['unit', 'tenant name', 'monthly rent', 'lease start date', 'lease end date'],
    map: { 'unit': 'unit', 'tenant name': 'tenant', 'monthly rent': 'rent', 'security deposit': 'deposit', 'lease start date': 'lease_start', 'lease end date': 'lease_end', 'outstanding balance': 'balance', 'email': 'email', 'phone': 'phone' },
  },
];

export function detectPreset(headers: string[]): Preset | null {
  const set = new Set(headers.map(norm));
  let best: Preset | null = null;
  let bestHits = 0;
  for (const p of PRESETS) {
    const hits = p.signature.filter((s) => set.has(s)).length;
    if (hits >= Math.min(4, p.signature.length - 1) && hits > bestHits) {
      best = p;
      bestHits = hits;
    }
  }
  return best;
}

// ---------- auto-mapping ----------

export interface Mapping {
  /** column index → field key ('' = ignore) */
  cols: Record<number, string>;
  preset: string | null;
  /** field keys the AI assist filled (for the review badge) */
  aiAssisted: string[];
  /** 'ai' when a whole-document AI reading plan produced this mapping */
  reader?: 'ai' | 'heuristic';
  /** human-readable notes from the reader (sections found, rows skipped) */
  notes?: string[];
}

/** Score a header against a field. exact synonym 3 · contains 2 · fuzzy 1. */
function scoreField(h: string, f: FieldDef): number {
  if (f.synonyms.includes(h)) return 3;
  for (const c of f.contains || []) {
    if (h.includes(c)) return 2;
  }
  return 0;
}

export function autoMap(headers: string[], kind: ImportKind): Mapping {
  const fields = fieldsFor(kind);
  const preset = kind === 'rent_roll' ? detectPreset(headers) : null;
  const cols: Record<number, string> = {};
  const claimed = new Set<string>();

  // 1) preset exact headers win
  if (preset) {
    headers.forEach((h, i) => {
      const target = preset.map[norm(h)];
      if (target !== undefined && target !== '' && !claimed.has(target)) {
        cols[i] = target;
        claimed.add(target);
      } else if (target === '') {
        cols[i] = ''; // preset says: known column, deliberately ignored
      }
    });
  }

  // 2) generic synonym scoring for the rest — best score wins per column,
  //    and each field is claimed by its highest-scoring column
  const candidates: { col: number; field: string; score: number }[] = [];
  headers.forEach((h, i) => {
    if (cols[i] !== undefined) return;
    const hn = norm(h);
    if (!hn) return;
    for (const f of fields) {
      const s = scoreField(hn, f);
      if (s > 0) candidates.push({ col: i, field: f.key, score: s });
    }
  });
  candidates.sort((a, b) => b.score - a.score);
  const colTaken = new Set<number>(Object.keys(cols).map(Number));
  for (const c of candidates) {
    if (colTaken.has(c.col) || claimed.has(c.field)) continue;
    cols[c.col] = c.field;
    colTaken.add(c.col);
    claimed.add(c.field);
  }
  return { cols, preset: preset?.key || null, aiAssisted: [] };
}

/** Which required/important fields are still unmapped (for warnings + AI assist). */
export function unmappedFields(headers: string[], mapping: Mapping, kind: ImportKind): FieldDef[] {
  const mapped = new Set(Object.values(mapping.cols).filter(Boolean));
  return fieldsFor(kind).filter((f) => !mapped.has(f.key));
}

// ---------- header-row detection ----------

/** Real exports often start with title/blank rows ("Rent Roll as of ...").
 * Pick the row within the first 12 whose cells hit the most known synonyms. */
export function findHeaderRow(rows: string[][], kind: ImportKind): number {
  const fields = fieldsFor(kind);
  let best = 0;
  let bestScore = 0;
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const row = rows[i]!;
    let score = 0;
    for (const cell of row) {
      const cn = norm(cell);
      if (!cn) continue;
      if (fields.some((f) => scoreField(cn, f) >= 2)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return bestScore >= 2 ? best : 0;
}

// ---------- value cleaning ----------

export function moneyToCents(sRaw: string | undefined): number | null {
  if (sRaw === undefined || sRaw === null) return null;
  let s = String(sRaw).trim();
  if (!s || /^(n\/?a|none|-{1,2}|—)$/i.test(s)) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  s = s.replace(/[$,\s]/g, '');
  if (s.startsWith('-')) { negative = true; s = s.slice(1); }
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
  const n = Math.round(parseFloat(s) * 100);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export function toIsoDate(sRaw: string | undefined): string | null {
  if (!sRaw) return null;
  const s = String(sRaw).trim();
  if (!s || /^(n\/?a|none|-{1,2}|—|mtm|month to month)$/i.test(s)) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); // ISO already
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/); // M/D/YY[YY]
  if (m) {
    let y = +m[3]!;
    if (y < 100) y += y < 50 ? 2000 : 1900;
    return iso(y, +m[1]!, +m[2]!);
  }
  m = s.match(/^([a-zA-Z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/); // Jul 1, 2026
  if (m) {
    const mo = MONTHS[m[1]!.slice(0, 3).toLowerCase()];
    if (mo) return iso(+m[3]!, mo, +m[2]!);
  }
  m = s.match(/^(\d{1,2})\s+([a-zA-Z]{3,9})\.?\s+(\d{4})$/); // 1 Jul 2026
  if (m) {
    const mo = MONTHS[m[2]!.slice(0, 3).toLowerCase()];
    if (mo) return iso(+m[3]!, mo, +m[1]!);
  }
  return null;
}

function iso(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function normStatus(sRaw: string | undefined): 'occupied' | 'vacant' | 'notice' | 'down' | null {
  const s = norm(String(sRaw || ''));
  if (!s) return null;
  if (/(^|\s)(occupied|current|leased|rented|o)($|\s)/.test(s)) return 'occupied';
  if (/notice|pending move out|mtm notice/.test(s)) return 'notice';
  if (/down|reno|rehab|off line|offline/.test(s)) return 'down';
  if (/vacant|available|empty|v($|\s)|ready/.test(s)) return 'vacant';
  return null;
}

/** "Last, First" → "First Last"; split a display name into first/last. */
export function splitName(name: string): { first: string; last: string; display: string } {
  const s = name.trim().replace(/\s+/g, ' ');
  if (!s) return { first: '', last: '', display: '' };
  const comma = s.match(/^([^,]+),\s*(.+)$/);
  if (comma) {
    const first = comma[2]!.trim();
    const last = comma[1]!.trim();
    return { first, last, display: `${first} ${last}` };
  }
  const parts = s.split(' ');
  if (parts.length === 1) return { first: parts[0]!, last: '', display: s };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1]!, display: s };
}

/** map a free-text trade to the vendors.category enum */
export function normVendorCategory(sRaw: string | undefined): string {
  const s = norm(String(sRaw || ''));
  const table: [RegExp, string][] = [
    [/plumb/, 'plumbing'], [/electric/, 'electrical'], [/hvac|heat|air|cooling|furnace/, 'hvac'],
    [/clean|janitor|maid/, 'cleaning'], [/landscap|lawn|grounds|tree/, 'landscaping'],
    [/paint/, 'painting'], [/lock|key|door/, 'locks'], [/floor|carpet|tile/, 'flooring'],
    [/pest|extermin/, 'pest'], [/roof/, 'roofing'], [/restor|remediat|mold|water damage/, 'restoration'],
  ];
  for (const [re, cat] of table) if (re.test(s)) return cat;
  return 'general';
}

/** Extract mapped values from a raw row → clean record keyed by field. */
export function extractRecord(row: string[], mapping: Mapping): Record<string, string> {
  const rec: Record<string, string> = {};
  for (const [colStr, field] of Object.entries(mapping.cols)) {
    if (!field) continue;
    const vRaw = row[Number(colStr)];
    if (vRaw !== undefined && String(vRaw).trim() !== '') rec[field] = String(vRaw).trim();
  }
  return rec;
}
