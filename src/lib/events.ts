import { insert, q, run, js } from './db.ts';
import { id } from './ids.ts';
import { nowIso, addDays } from './dates.ts';
import type { Ctx } from './auth.ts';

/** Domain event log (§3.2.3). Modules subscribe in-process; the webhook
 * dispatcher and the AI layer consume the same stream. */

type Subscriber = (ctx: Ctx, payload: Record<string, any>, eventId: string) => void;

const subs = new Map<string, Subscriber[]>();

export function on(type: string, fn: Subscriber): void {
  const list = subs.get(type) || [];
  list.push(fn);
  subs.set(type, list);
}

export function emit(
  ctx: Ctx,
  type: string,
  entity: string,
  entityId: string,
  payload: Record<string, any> = {},
): string {
  const eid = id('evt');
  insert('domain_events', {
    id: eid,
    org_id: ctx.orgId,
    type,
    entity,
    entity_id: entityId,
    payload: js({ ...payload, entity, entityId }),
    at: nowIso(),
    business_date: ctx.businessDate,
  });
  for (const fn of subs.get(type) || []) {
    try {
      fn(ctx, { ...payload, entity, entityId }, eid);
    } catch (e) {
      console.error(`[events] subscriber for ${type} failed:`, (e as Error).message);
    }
  }
  // queue webhook deliveries for matching endpoints
  const endpoints = q<{ id: string; events: string }>(
    "SELECT id, events FROM webhook_endpoints WHERE org_id=? AND active=1",
    ctx.orgId,
  );
  for (const ep of endpoints) {
    const list = ep.events ? (JSON.parse(ep.events) as string[]) : ['*'];
    if (list.includes('*') || list.includes(type) || list.some((p) => p.endsWith('.*') && type.startsWith(p.slice(0, -1)))) {
      insert('webhook_deliveries', {
        id: id('whd'),
        org_id: ctx.orgId,
        endpoint_id: ep.id,
        event_id: eid,
        event_type: type,
        payload: js({ id: eid, type, orgId: ctx.orgId, businessDate: ctx.businessDate, data: { ...payload, entity, entityId } }),
        status: 'pending',
        attempts: 0,
        next_attempt_at: nowIso(),
        created_at: nowIso(),
      });
    }
  }
  return eid;
}

/** Deliver pending webhooks (called by the scheduler and manual trigger). */
export async function deliverWebhooks(ctx: Ctx): Promise<number> {
  const { createHmac } = await import('node:crypto');
  const pending = q<any>(
    "SELECT d.*, e.url, e.secret FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id WHERE d.org_id=? AND d.status IN ('pending','retrying') AND d.next_attempt_at<=? LIMIT 50",
    ctx.orgId,
    nowIso(),
  );
  let delivered = 0;
  for (const d of pending) {
    const sig = createHmac('sha256', String(d.secret)).update(String(d.payload)).digest('hex');
    try {
      const resp = await fetch(String(d.url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-oriel-signature': `sha256=${sig}`,
          'x-oriel-event': String(d.event_type),
        },
        body: String(d.payload),
        signal: AbortSignal.timeout(4000),
      });
      if (resp.ok) {
        run("UPDATE webhook_deliveries SET status='ok', attempts=attempts+1, last_code=? WHERE id=?", resp.status, d.id);
        delivered++;
      } else {
        retry(d, resp.status);
      }
    } catch {
      retry(d, 0);
    }
  }
  return delivered;
}

function retry(d: any, code: number): void {
  const attempts = Number(d.attempts) + 1;
  if (attempts >= 5) {
    run("UPDATE webhook_deliveries SET status='failed', attempts=?, last_code=? WHERE id=?", attempts, code, d.id);
  } else {
    const backoffMin = [1, 5, 15, 60][attempts - 1] || 60;
    run(
      "UPDATE webhook_deliveries SET status='retrying', attempts=?, last_code=?, next_attempt_at=? WHERE id=?",
      attempts,
      code,
      new Date(Date.now() + backoffMin * 60000).toISOString(),
      d.id,
    );
  }
}
