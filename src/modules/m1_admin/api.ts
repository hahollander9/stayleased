import { createHash } from 'node:crypto';
import { html, raw } from '../../lib/html.ts';
import { jsonRes, type Router, type Rq, type Res, type Middleware } from '../../lib/http.ts';
import { q, q1, run, val } from '../../lib/db.ts';
import { nowIso } from '../../lib/dates.ts';
import { sysCtx, rateLimit, type Ctx } from '../../lib/auth.ts';
import { doc, logo } from '../../ui/ui.ts';

/** REST API v1 (§3.5) — parity with Entrata's open API concept: versioned
 * endpoints, per-org API keys, rate limiting, and a generated reference at
 * /developers. Endpoints register here so the reference stays current. */

export interface ApiEndpoint {
  method: 'GET' | 'POST';
  path: string; // e.g. /api/v1/properties
  summary: string;
  params?: { name: string; in: 'query' | 'path' | 'body'; desc: string }[];
  handler: (rq: Rq, ctx: Ctx) => Res;
}

const endpoints: ApiEndpoint[] = [];

export function registerApi(ep: ApiEndpoint): void {
  endpoints.push(ep);
}

export const apiAuth: Middleware = (rq) => {
  const key = String(rq.raw.headers['x-api-key'] || rq.query.get('api_key') || '');
  if (!key) return jsonRes({ error: 'missing_api_key', hint: 'Send X-Api-Key header. Create keys at /admin/api.' }, 401);
  const hash = createHash('sha256').update(key).digest('hex');
  const row = q1<{ id: string; org_id: string; active: number }>('SELECT id, org_id, active FROM api_keys WHERE key_hash=?', hash);
  if (!row || !row.active) return jsonRes({ error: 'invalid_api_key' }, 401);
  if (!rateLimit(`api:${row.id}`, 240, 60000)) return jsonRes({ error: 'rate_limited', limit: '240/min' }, 429);
  run('UPDATE api_keys SET last_used_at=? WHERE id=?', nowIso(), row.id);
  rq.ctx = sysCtx(row.org_id);
  return;
};

export function mountApi(r: Router): void {
  for (const ep of endpoints) {
    r.add(ep.method, ep.path, apiAuth, (rq) => ep.handler(rq, rq.ctx as Ctx));
  }

  r.get('/developers', (rq) => {
    const body = html`<div style="max-width:880px;margin:0 auto;padding:30px 20px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">${logo(26, 'var(--accent)')}<h1 style="font-size:24px">StayLeased API v1</h1></div>
      <p class="muted">REST over HTTPS. Authenticate with an org-scoped key in the <code>X-Api-Key</code> header (create keys in <a href="/admin/api">Admin → API &amp; webhooks</a>). Rate limit 240 req/min per key. All money values are integer cents; dates are <code>YYYY-MM-DD</code>.</p>
      <div class="card"><div class="card-body">
        <h2>Webhooks</h2>
        <p class="small">Register endpoint URLs in Admin → API &amp; webhooks. StayLeased POSTs JSON on major domain events with an <code>X-StayLeased-Signature: sha256=&lt;hmac&gt;</code> header (HMAC-SHA256 of the raw body with your endpoint secret). Deliveries retry with backoff (1m/5m/15m/60m, 5 attempts).</p>
        <p class="small mono">event envelope: { id, type, orgId, businessDate, data }</p>
      </div></div>
      ${endpoints.map(
        (ep) => html`<div class="card"><div class="card-body">
          <div style="display:flex;gap:10px;align-items:center"><span class="badge ${ep.method === 'GET' ? 'info' : 'ok'}">${ep.method}</span><code>${ep.path}</code></div>
          <p style="margin:8px 0 4px">${ep.summary}</p>
          ${ep.params?.length
            ? html`<table class="tbl"><thead><tr><th>Param</th><th>In</th><th>Description</th></tr></thead><tbody>
                ${ep.params.map((p) => html`<tr><td class="mono small">${p.name}</td><td class="small">${p.in}</td><td class="small">${p.desc}</td></tr>`)}
              </tbody></table>`
            : null}
          <pre style="background:#171d2b;color:#c8d0e0;border-radius:8px;padding:10px;font-size:12px;overflow:auto">curl -H "X-Api-Key: ok_…" ${ep.method === 'POST' ? '-X POST ' : ''}http://localhost:3000${ep.path.replace(':id', '{id}')}</pre>
        </div></div>`,
      )}
    </div>`;
    return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: doc('API reference', body) };
  });
}

// ---------- core endpoints (grow per module) ----------

registerApi({
  method: 'GET',
  path: '/api/v1/ping',
  summary: 'Health check + authenticated org identity.',
  handler: (rq, ctx) => {
    const org = q1<any>('SELECT id, name, slug, business_date FROM orgs WHERE id=?', ctx.orgId);
    return jsonRes({ ok: true, org });
  },
});

registerApi({
  method: 'GET',
  path: '/api/v1/properties',
  summary: 'List properties with unit counts and occupancy.',
  handler: (rq, ctx) => {
    const rows = q<any>(
      `SELECT p.id, p.name, p.slug, p.type, p.city, p.state, p.timezone,
        (SELECT COUNT(*) FROM units u WHERE u.property_id=p.id) AS units,
        (SELECT COUNT(*) FROM units u WHERE u.property_id=p.id AND u.status IN ('occupied','notice')) AS occupied
       FROM properties p WHERE p.org_id=? ORDER BY p.name`,
      ctx.orgId,
    );
    return jsonRes({ data: rows });
  },
});

registerApi({
  method: 'GET',
  path: '/api/v1/units',
  summary: 'List units, filterable by property and status.',
  params: [
    { name: 'property_id', in: 'query', desc: 'Filter by property' },
    { name: 'status', in: 'query', desc: 'vacant_ready | vacant_not_ready | occupied | notice | down | model' },
  ],
  handler: (rq, ctx) => {
    const params: unknown[] = [ctx.orgId];
    let where = 'org_id=?';
    const pid = rq.query.get('property_id');
    const status = rq.query.get('status');
    if (pid) { where += ' AND property_id=?'; params.push(pid); }
    if (status) { where += ' AND status=?'; params.push(status); }
    const rows = q<any>(`SELECT id, property_id, unit_number, status, sqft, market_rent_cents, floorplan_id FROM units WHERE ${where} ORDER BY unit_number LIMIT 500`, ...params);
    return jsonRes({ data: rows });
  },
});

registerApi({
  method: 'GET',
  path: '/api/v1/events',
  summary: 'Domain event stream (most recent first).',
  params: [
    { name: 'type', in: 'query', desc: 'Filter by event type prefix, e.g. payment.' },
    { name: 'limit', in: 'query', desc: 'Max rows (default 50, cap 200)' },
  ],
  handler: (rq, ctx) => {
    const type = rq.query.get('type');
    const limit = Math.min(200, parseInt(rq.query.get('limit') || '50', 10) || 50);
    const rows = type
      ? q<any>('SELECT id, type, entity, entity_id, payload, business_date, at FROM domain_events WHERE org_id=? AND type LIKE ? ORDER BY at DESC LIMIT ?', ctx.orgId, type + '%', limit)
      : q<any>('SELECT id, type, entity, entity_id, payload, business_date, at FROM domain_events WHERE org_id=? ORDER BY at DESC LIMIT ?', ctx.orgId, limit);
    return jsonRes({ data: rows.map((e) => ({ ...e, payload: JSON.parse(e.payload) })) });
  },
});
