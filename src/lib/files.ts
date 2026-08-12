import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { insert, q1, run } from './db.ts';
import { ROOT } from './db.ts';
import { id } from './ids.ts';
import { nowIso } from './dates.ts';
import type { Ctx } from './auth.ts';

/** Local-disk storage abstraction with an S3-shaped interface (§3.1).
 * Every stored file gets a DB row; downloads are authorized per record. */

export interface FileRow {
  id: string;
  org_id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  entity: string | null;
  entity_id: string | null;
  visibility: string; // staff | resident | vendor | public
  owner_user_id: string | null;
  created_by: string;
  created_at: string;
}

function dir(): string {
  const d = join(ROOT, 'data', 'files');
  mkdirSync(d, { recursive: true });
  return d;
}

/** The only content types we ever serve inline in the browser. SVG is
 * deliberately absent — it can carry <script>/onload and would execute in the
 * user's session. Everything else downloads as an attachment (§SEC-1). */
const INLINE_SERVABLE = new Set(['application/pdf', 'image/png', 'image/jpeg']);

/** Server-side upload allowlist. Anything a caller legitimately stores here
 * (portal photos, lease/adverse-action/remittance PDFs, rent-roll & report
 * CSV/XLSX, id & income docs) is covered; unrecognized declared types are
 * coerced to a safe generic rather than trusted. */
const ALLOWED_UPLOAD_MIME = new Set([
  'application/pdf',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'text/plain', 'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.ms-excel', // xls
  'application/zip',
  'application/octet-stream',
]);

function normalizeMime(m: string): string {
  return String(m || '').split(';')[0]!.trim().toLowerCase() || 'application/octet-stream';
}

/** Derive a coarse content type from the leading bytes, independent of any
 * client-supplied mime. Binary formats are matched by magic number; textual
 * uploads are inspected for scriptable markup (svg/html/xml) so callers can
 * refuse to serve them inline. Returns 'application/octet-stream' when the
 * bytes match nothing recognized. */
export function sniffMime(data: Uint8Array): string {
  const b = data;
  const n = b.length;
  if (n >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf'; // %PDF
  if (n >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (n >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (n >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 &&
      (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif'; // GIF87a / GIF89a
  if (n >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'; // RIFF....WEBP
  if (n >= 4 && b[0] === 0x50 && b[1] === 0x4b &&
      (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07) &&
      (b[3] === 0x04 || b[3] === 0x06 || b[3] === 0x08)) return 'application/zip'; // PK.. (xlsx/docx/zip)
  // textual: does the leading window look like scriptable markup?
  let start = 0;
  if (n >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) start = 3; // strip UTF-8 BOM
  const head = Buffer.from(b.subarray(start, Math.min(n, start + 512))).toString('utf8').replace(/^\s+/, '').toLowerCase();
  if (head.startsWith('<?xml') || head.startsWith('<svg')) return 'image/svg+xml';
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head') ||
      head.startsWith('<body') || head.startsWith('<script') || head.startsWith('<!--')) return 'text/html';
  if (/^<[a-z!/?]/.test(head)) return 'text/html'; // any other leading markup tag is treated as scriptable
  return 'application/octet-stream';
}

/** Reconcile a client-declared mime with the actual bytes. Scriptable content
 * (svg/html/xml) and anything outside the allowlist collapses to a safe
 * generic that can never be served inline; a genuine inline-safe image whose
 * label is merely wrong is corrected to its true type. */
export function safeMime(declared: string, data: Uint8Array): string {
  const claimed = normalizeMime(declared);
  const sniffed = sniffMime(data);
  if (sniffed === 'image/svg+xml' || sniffed === 'text/html') return 'application/octet-stream';
  if (INLINE_SERVABLE.has(claimed)) {
    if (claimed === sniffed) return claimed;
    return INLINE_SERVABLE.has(sniffed) ? sniffed : 'application/octet-stream';
  }
  if (ALLOWED_UPLOAD_MIME.has(claimed)) return claimed;
  return ALLOWED_UPLOAD_MIME.has(sniffed) ? sniffed : 'application/octet-stream';
}

/** True only when a stored file may be streamed inline: its (already
 * validated) mime is inline-safe AND the bytes still match it. Used by the
 * /f/:id download route as a second, serve-time guard. */
export function canServeInline(row: FileRow, data: Uint8Array): boolean {
  return INLINE_SERVABLE.has(row.mime) && sniffMime(data) === row.mime;
}

export function putFile(
  ctx: Ctx,
  data: Uint8Array,
  opts: {
    name: string;
    mime: string;
    entity?: string;
    entityId?: string;
    visibility?: 'staff' | 'resident' | 'vendor' | 'public';
    ownerUserId?: string | null;
  },
): FileRow {
  const fid = id('fil');
  const sha = createHash('sha256').update(data).digest('hex');
  writeFileSync(join(dir(), fid + '.bin'), data);
  const row: FileRow = {
    id: fid,
    org_id: ctx.orgId,
    name: opts.name,
    // Never trust the caller's declared mime: sniff the bytes and coerce
    // scriptable/unknown content to a non-inline generic (§SEC-1).
    mime: safeMime(opts.mime, data),
    size: data.length,
    sha256: sha,
    entity: opts.entity || null,
    entity_id: opts.entityId || null,
    visibility: opts.visibility || 'staff',
    owner_user_id: opts.ownerUserId ?? null,
    created_by: ctx.userId,
    created_at: nowIso(),
  };
  insert('files', row as unknown as Record<string, unknown>);
  return row;
}

export function getFile(fileId: string): { row: FileRow; data: Buffer } | null {
  const row = q1<FileRow>('SELECT * FROM files WHERE id=?', fileId);
  if (!row) return null;
  const p = join(dir(), fileId + '.bin');
  if (!existsSync(p)) return null;
  return { row, data: readFileSync(p) };
}

/** Delete `files` ROWS only. Safe inside a transaction, because a rollback
 * puts the rows back. Pair it with unlinkBlobs AFTER the commit. */
export function deleteFileRows(fileIds: string[]): number {
  let removed = 0;
  for (const fid of fileIds) removed += run('DELETE FROM files WHERE id=?', fid).changes;
  return removed;
}

/** Delete stored BYTES only.
 *
 * Never call this inside a transaction. Unlinking cannot be rolled back, so a
 * transaction that deletes rows and bytes together and then aborts — a failing
 * commit, a disk-full audit insert, any throw after the unlink — restores every
 * row over bytes that are permanently gone, leaving a portfolio of dead
 * download links. The safe order is: delete rows in the transaction, commit,
 * then unlink. A crash in the gap leaves unreachable bytes instead, which
 * only unreachable bytes, which no user can see. */
export function unlinkBlobs(fileIds: string[]): number {
  let removed = 0;
  for (const fid of fileIds) {
    const p = join(dir(), fid + '.bin');
    if (!existsSync(p)) continue;
    rmSync(p, { force: true });
    removed++;
  }
  return removed;
}

/** Rows and bytes together, in the safe order. For callers that are NOT inside
 * a transaction: a row without its blob is a dead download link, and a blob
 * without its row is unreachable data that still holds resident information. */
export function deleteFiles(fileIds: string[]): number {
  const removed = deleteFileRows(fileIds);
  unlinkBlobs(fileIds);
  return removed;
}

/* A global "delete every blob with no row" sweep used to live here. It is
 * unsafe by construction: every database in a checkout shares data/files, so
 * sweeping while pointed at one database unlinks bytes owned by rows in
 * another (verified: running it against a scratch db removed every blob
 * data/e2e.db still referenced). The file store has no database affinity, so
 * orphans can only be collected by an id the caller actually owns — which is
 * what deleteFileRows + unlinkBlobs do at every deliberate delete site. */

/** authorization for downloads: staff of the org, the owning user, or public */
export function canDownload(ctx: Ctx | undefined, row: FileRow): boolean {
  if (row.visibility === 'public') return true;
  if (!ctx) return false;
  if (ctx.orgId !== row.org_id && ctx.kind !== 'platform') return false;
  if (ctx.kind === 'staff' || ctx.kind === 'platform' || ctx.kind === 'system') return true;
  if (row.owner_user_id && row.owner_user_id === ctx.userId) return true;
  if (row.visibility === 'resident' && ctx.kind === 'resident' && row.owner_user_id === ctx.userId) return true;
  if (row.visibility === 'vendor' && ctx.kind === 'vendor') return true;
  return false;
}
