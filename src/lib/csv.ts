/** CSV export helper. */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [headers.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n') + '\r\n';
}

/** Minimal RFC-4180-ish CSV parser: quoted fields, escaped "" quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQ = false;
  const s = text.replace(/^﻿/, ''); // strip BOM
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* handled by \n */ }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Parse CSV with a header row into row objects keyed by snake_cased header. */
export function parseCsvObjects(text: string): { headers: string[]; keys: string[]; rows: Record<string, string>[] } {
  const grid = parseCsv(text);
  if (!grid.length) return { headers: [], keys: [], rows: [] };
  const headers = grid[0]!.map((h) => h.trim());
  const keys = headers.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const rows = grid.slice(1).map((r) => {
    const o: Record<string, string> = {};
    keys.forEach((k, i) => { o[k] = (r[i] ?? '').trim(); });
    return o;
  });
  return { headers, keys, rows };
}
