import { inflateRawSync, gunzipSync } from 'node:zlib';

/** Best-effort text extraction from digitally-produced PDFs — no deps.
 * Decompresses Flate content streams and collects the text-showing operators
 * ((…) Tj, [(…)…] TJ, hex strings). Good enough for typed/generated leases;
 * scanned documents come back empty and get routed to the live AI instead. */

function inflateStream(raw: Buffer): Buffer | null {
  // PDF FlateDecode = zlib envelope; try raw-deflate and gzip variants too
  try { return inflateZlib(raw); } catch { /* try next */ }
  try { return inflateRawSync(raw); } catch { /* try next */ }
  try { return gunzipSync(raw); } catch { return null; }
}

function inflateZlib(raw: Buffer): Buffer {
  // node exposes inflateSync via zlib; avoid adding another shim entry by
  // stripping the 2-byte zlib header and inflating raw (works for CM=8)
  if (raw.length > 2 && (raw[0]! & 0x0f) === 8) return inflateRawSync(raw.subarray(2));
  return inflateRawSync(raw);
}

function decodePdfString(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== '\\') { out += c; continue; }
    const n = s[++i];
    if (n === undefined) break;
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n === 'b' || n === 'f') out += ' ';
    else if (n >= '0' && n <= '7') {
      let oct = n;
      while (oct.length < 3 && s[i + 1]! >= '0' && s[i + 1]! <= '7') oct += s[++i]!;
      out += String.fromCharCode(parseInt(oct, 8));
    } else out += n; // \\ \( \)
  }
  return out;
}

function printableRatio(s: string): number {
  if (!s.length) return 0;
  let ok = 0;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if ((c >= 32 && c < 127) || c === 10 || c === 13 || c === 9) ok++;
  }
  return ok / s.length;
}

/** Pull the visible text out of a PDF buffer. Returns '' when the document
 * has no extractable text (scans, exotic encodings). */
export function pdfExtractText(pdf: Buffer): string {
  const chunks: string[] = [];
  let idx = 0;
  const src = pdf;
  while (idx < src.length) {
    const s = src.indexOf('stream', idx);
    if (s < 0) break;
    let dataStart = s + 6;
    if (src[dataStart] === 13) dataStart++;
    if (src[dataStart] === 10) dataStart++;
    const e = src.indexOf('endstream', dataStart);
    if (e < 0) break;
    const rawStream = src.subarray(dataStart, e);
    idx = e + 9;
    const inflated = inflateStream(rawStream) ?? rawStream;
    const text = inflated.toString('latin1');
    if (!/\b(Tj|TJ|BT)\b/.test(text)) continue;
    chunks.push(extractOps(text));
  }
  const joined = chunks.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return printableRatio(joined) > 0.85 ? joined : '';
}

function decodeHexString(hex: string): string {
  const clean = hex.replace(/\s+/g, '');
  let out = '';
  // single-byte codes (WinAnsi/Standard); 4-hex-digit CID text decodes to
  // garbage and gets rejected by the printable-ratio gate upstream
  for (let i = 0; i + 1 < clean.length; i += 2) out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
  if (clean.length % 2 === 1) out += String.fromCharCode(parseInt(clean.slice(-1) + '0', 16));
  return out;
}

function extractOps(content: string): string {
  const out: string[] = [];
  // walk the content stream, capturing strings that feed Tj/TJ/' operators —
  // both literal (…) and hex <…> forms (pdf-lib writes hex)
  const re = /\(((?:\\.|[^()\\])*)\)\s*(Tj|')|<([0-9A-Fa-f\s]*)>\s*(Tj|')|\[((?:\((?:\\.|[^()\\])*\)|<[0-9A-Fa-f\s]*>|[^\]])*)\]\s*TJ|(T\*|Td|TD|ET)/g;
  let m: RegExpExecArray | null;
  let line = '';
  const pushLine = (): void => {
    if (line.trim()) out.push(line.trim());
    line = '';
  };
  while ((m = re.exec(content))) {
    if (m[6]) { // positioning / block end → line break
      pushLine();
      continue;
    }
    if (m[1] !== undefined) {
      line += decodePdfString(m[1]) + ' ';
    } else if (m[3] !== undefined) {
      line += decodeHexString(m[3]) + ' ';
    } else if (m[5] !== undefined) {
      const inner = m[5];
      const sre = /\(((?:\\.|[^()\\])*)\)|<([0-9A-Fa-f\s]*)>/g;
      let sm: RegExpExecArray | null;
      while ((sm = sre.exec(inner))) line += sm[1] !== undefined ? decodePdfString(sm[1]) : decodeHexString(sm[2]!);
      line += ' ';
    }
  }
  pushLine();
  return out.join('\n');
}
