import { insert, q, run, js, j } from './db.ts';
import { id } from './ids.ts';
import { nowIso, addDays } from './dates.ts';
import { log } from './log.ts';
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
      log.error('event_subscriber_failed', e, { type });
    }
  }
  // queue webhook deliveries for matching endpoints
  const endpoints = q<{ id: string; events: string }>(
    "SELECT id, events FROM webhook_endpoints WHERE org_id=? AND active=1",
    ctx.orgId,
  );
  for (const ep of endpoints) {
    const list = j<string[]>(ep.events, ['*']);
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
      if (!(await webhookUrlAllowed(String(d.url)))) throw new Error('endpoint address not allowed');
      const resp = await fetch(String(d.url), {
        redirect: 'manual',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-stayleased-signature': `sha256=${sig}`,
          'x-stayleased-event': String(d.event_type),
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

/** Where this server is willing to send a webhook. The URL is typed by a
 * customer and fetched from inside our network every minute, so on a real
 * deployment it must be https and must not resolve to this machine, the
 * private network, or the cloud metadata address — and redirects are not
 * followed, since a public URL can simply answer "go to 169.254.169.254".
 * Local and test runs may post to http://localhost, which is how they are
 * tested. */
export function webhookUrlShape(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return 'Enter a full URL, starting with https://'; }
  const real = process.env.RENDER === 'true' || process.env.STAYLEASED_MODE === 'production';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && !real)) return 'A webhook URL must start with https://';
  if (u.username || u.password) return 'A webhook URL cannot carry a username or password.';
  if (real && (isPrivateHost(u.hostname) || /(^|\.)(localhost|local|internal)$/i.test(u.hostname))) return 'That address is not reachable from the public internet.';
  return null;
}
function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (h.includes(':')) return h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h.startsWith('::ffff:');
  return false;
}
export async function webhookUrlAllowed(url: string): Promise<boolean> {
  if (webhookUrlShape(url)) return false;
  const real = process.env.RENDER === 'true' || process.env.STAYLEASED_MODE === 'production';
  if (!real) return true;
  try {
    const dnsName = 'node:dns';
    const dns = (await import(dnsName)) as { promises: { lookup: (h: string, o: { all: true }) => Promise<{ address: string }[]> } };
    const addrs = await dns.promises.lookup(new URL(url).hostname, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateHost(a.address));
  } catch { return false; }
}
