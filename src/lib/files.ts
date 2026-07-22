import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { insert, q1 } from './db.ts';
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
    mime: opts.mime,
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
