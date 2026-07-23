import { readZip, writeZip } from './zip.ts';

/** Minimal .xlsx reader/writer (SpreadsheetML) — zero dependencies.
 *
 * Reader goals: get the GRID OF DISPLAY VALUES out of real-world exports
 * (Excel, Google Sheets, LibreOffice, Buildium/AppFolio/Yardi report exports):
 * shared strings, inline strings, numbers, booleans, and dates (both native
 * `t="d"` and the common styled-serial-number form, which we detect through
 * styles.xml number formats and convert to ISO yyyy-mm-dd).
 * Writer goals: valid single-or-multi-sheet workbooks for import templates. */

export interface Sheet {
  name: string;
  rows: string[][];
}

// ---------- tiny XML helpers (namespace-prefix tolerant) ----------

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** every <tag ...>...</tag> body (prefix-tolerant, non-nested) */
function tagBodies(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]!);
  return out;
}

function attr(tagXml: string, name: string): string | null {
  const m = tagXml.match(new RegExp(`(?:^|\\s)(?:\\w+:)?${name}="([^"]*)"`));
  return m ? unescapeXml(m[1]!) : null;
}

// ---------- date serials ----------

/** Excel serial → ISO date. Base 1899-12-30 absorbs the 1900 leap-year bug. */
export function serialToIso(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400000); // 25569 = days 1899-12-30 → 1970-01-01
  return new Date(ms).toISOString().slice(0, 10);
}

const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47]);

function isDateFormatCode(code: string): boolean {
  // strip quoted literals, [colors]/[conditions], then look for date tokens
  const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
  if (/[#0?]/.test(bare) && !/[ymdh]/i.test(bare)) return false;
  return /[dmy]/i.test(bare) && !/General/i.test(bare);
}

// ---------- reader ----------

export function parseXlsx(buf: Buffer): Sheet[] {
  const entries = new Map(readZip(buf).map((e) => [e.name.replace(/^\//, ''), e.data]));
  const get = (name: string): string | null => {
    const e = entries.get(name);
    return e ? e.toString('utf8') : null;
  };

  const workbook = get('xl/workbook.xml');
  if (!workbook) throw new Error('not an xlsx workbook (xl/workbook.xml missing)');

  // sheet name → relationship id, in workbook order
  const sheetTags = workbook.match(/<(?:\w+:)?sheet\s[^>]*\/?>/g) || [];
  const rels = get('xl/_rels/workbook.xml.rels') || '';
  const relMap = new Map<string, string>();
  for (const rel of rels.match(/<Relationship\s[^>]*\/?>/g) || []) {
    const rid = attr(rel, 'Id');
    const target = attr(rel, 'Target');
    if (rid && target) relMap.set(rid, target.replace(/^\//, '').replace(/^xl\//, ''));
  }

  // shared strings (concatenate rich-text runs)
  const sstXml = get('xl/sharedStrings.xml') || '';
  const shared: string[] = tagBodies(sstXml, 'si').map((si) =>
    tagBodies(si, 't').map(unescapeXml).join(''),
  );

  // styles: which cell-format indexes are dates
  const stylesXml = get('xl/styles.xml') || '';
  const customDate = new Set<number>();
  for (const m of stylesXml.match(/<(?:\w+:)?numFmt\s[^>]*\/?>/g) || []) {
    const fid = parseInt(attr(m, 'numFmtId') || '-1', 10);
    const code = attr(m, 'formatCode') || '';
    if (fid >= 0 && isDateFormatCode(code)) customDate.add(fid);
  }
  const dateStyles = new Set<number>();
  const cellXfsBody = tagBodies(stylesXml, 'cellXfs')[0] || '';
  (cellXfsBody.match(/<(?:\w+:)?xf\b[^>]*\/?>/g) || []).forEach((xf, i) => {
    const fid = parseInt(attr(xf, 'numFmtId') || '0', 10);
    if (BUILTIN_DATE_FMTS.has(fid) || customDate.has(fid)) dateStyles.add(i);
  });

  const sheets: Sheet[] = [];
  for (const tag of sheetTags) {
    const name = attr(tag, 'name') || `Sheet${sheets.length + 1}`;
    const rid = attr(tag, 'id'); // matches r:id via prefix-tolerant attr
    let target = rid ? relMap.get(rid) : undefined;
    if (!target) target = `worksheets/sheet${sheets.length + 1}.xml`;
    const ws = get(`xl/${target}`) || get(target);
    if (!ws) continue;
    sheets.push({ name, rows: parseWorksheet(ws, shared, dateStyles) });
  }
  return sheets;
}

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
    else break;
  }
  return n - 1;
}

function parseWorksheet(xml: string, shared: string[], dateStyles: Set<number>): string[][] {
  const rows: string[][] = [];
  const rowRe = /<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g;
  const cellRe = /<(?:\w+:)?c\b([^>]*)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(xml))) {
    const cells: string[] = [];
    let cm: RegExpExecArray | null;
    let autoCol = 0;
    while ((cm = cellRe.exec(rm[1]!))) {
      const attrs = cm[1] || '';
      const body = cm[2] || '';
      const ref = attr(`<c ${attrs}>`, 'r');
      const col = ref ? colIndex(ref) : autoCol;
      autoCol = col + 1;
      const t = attr(`<c ${attrs}>`, 't') || 'n';
      const s = parseInt(attr(`<c ${attrs}>`, 's') || '-1', 10);
      const v = tagBodies(body, 'v')[0];
      let out = '';
      if (t === 's') out = shared[parseInt(v || '0', 10)] ?? '';
      else if (t === 'inlineStr') out = tagBodies(body, 't').map(unescapeXml).join('');
      else if (t === 'str') out = unescapeXml(v || '');
      else if (t === 'b') out = v === '1' ? 'TRUE' : 'FALSE';
      else if (t === 'e') out = '';
      else if (t === 'd') out = (v || '').slice(0, 10);
      else if (v !== undefined && v !== '') {
        const num = Number(v);
        if (Number.isFinite(num) && dateStyles.has(s) && num >= 1 && num < 2958466) out = serialToIso(num);
        else out = unescapeXml(v);
      }
      while (cells.length < col) cells.push('');
      cells[col] = out.trim();
    }
    rows.push(cells);
  }
  // trim fully-empty trailing rows
  while (rows.length && rows[rows.length - 1]!.every((c) => c === '')) rows.pop();
  return rows;
}

// ---------- writer (import templates / exports) ----------

function colRef(i: number): string {
  let s = '';
  i += 1;
  while (i > 0) {
    const r = (i - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

export function writeXlsx(sheets: Sheet[]): Buffer {
  const sheetXml = (rows: string[][]): string => {
    const body = rows
      .map((r, ri) => {
        const cells = r
          .map((cell, ci) => {
            if (cell === '' || cell === undefined || cell === null) return '';
            const ref = `${colRef(ci)}${ri + 1}`;
            const asNum = Number(cell);
            if (cell !== '' && Number.isFinite(asNum) && String(asNum) === String(cell).trim()) {
              return `<c r="${ref}"><v>${asNum}</v></c>`;
            }
            return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(cell))}</t></is></c>`;
          })
          .join('');
        return `<row r="${ri + 1}">${cells}</row>`;
      })
      .join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
  };

  const files: { name: string; data: string }[] = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
    },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows) })),
  ];
  return writeZip(files);
}

/** Sniff + parse any tabular upload: .xlsx workbooks, or delimited text
 * (comma/semicolon/tab — sniffed from the first lines). Returns all sheets. */
export function parseSpreadsheet(filename: string, data: Buffer, parseDsv: (text: string, delim?: string) => string[][]): Sheet[] {
  const isZip = data.length > 3 && data[0] === 0x50 && data[1] === 0x4b;
  if (isZip || /\.xlsx?$|\.xlsm$/i.test(filename)) return parseXlsx(data);
  const text = data.toString('utf8').replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 3).join('\n');
  const counts: [string, number][] = [
    ['\t', (first.match(/\t/g) || []).length],
    [',', (first.match(/,/g) || []).length],
    [';', (first.match(/;/g) || []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  const delim = counts[0]![1] > 0 ? counts[0]![0] : ',';
  return [{ name: filename.replace(/\.[a-z]+$/i, '') || 'Sheet1', rows: parseDsv(text, delim) }];
}
