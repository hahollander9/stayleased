import { insert } from './db.ts';
import { id } from './ids.ts';
import { nowIso } from './dates.ts';
import type { Ctx } from './auth.ts';

/** Every mutation writes an audit row (who/when/org/entity/diff). Surfaced on
 * each record's History tab and in the admin audit viewer. */

export function audit(
  ctx: Ctx,
  entity: string,
  entityId: string,
  action: string,
  before?: Record<string, unknown> | null,
  after?: Record<string, unknown> | null,
): void {
  let changes: string | null = null;
  if (before || after) {
    const diff: Record<string, { from: unknown; to: unknown }> = {};
    const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    for (const k of keys) {
      if (k === 'password_hash' || k === 'token_hash' || k === 'secret') continue;
      const from = before?.[k];
      const to = after?.[k];
      if (JSON.stringify(from) !== JSON.stringify(to)) diff[k] = { from: from ?? null, to: to ?? null };
    }
    if (Object.keys(diff).length) changes = JSON.stringify(diff);
  }
  insert('audit_events', {
    id: id('aud'),
    org_id: ctx.orgId || null,
    user_id: ctx.userId,
    user_name: ctx.userName,
    entity,
    entity_id: entityId,
    action,
    changes,
    at: nowIso(),
  });
}
