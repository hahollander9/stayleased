import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { esc, Raw } from './html.ts';

/** Tiny server-rendered web framework on node:http (environment fallback for
 * Next.js, per DECISIONS.md). Routes are registered per module; handlers are
 * synchronous-friendly and return a Res. */

export interface Upload {
  field: string;
  filename: string;
  mime: string;
  data: Buffer;
}

export interface Rq {
  raw: IncomingMessage;
  method: string;
  path: string;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, any>;
  uploads: Upload[];
  cookies: Record<string, string>;
  ip: string;
  // attached by auth middleware:
  user?: any;
  ctx?: any;
  session?: any;
  // response cookie accumulation:
  setCookies: string[];
}

export interface Res {
  status: number;
  headers: Record<string, string | string[]>;
  body: string | Uint8Array;
}

export type Handler = (r: Rq) => Res | Promise<Res>;
export type Middleware = (r: Rq) => Res | undefined | Promise<Res | undefined>;

// ---------- response helpers ----------

export function htmlRes(body: Raw | string, status = 200, headers: Record<string, string> = {}): Res {
  return {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
    body: body instanceof Raw ? body.s : body,
  };
}

export function jsonRes(obj: unknown, status = 200): Res {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(obj, null, 2),
  };
}

export function textRes(s: string, status = 200, mime = 'text/plain; charset=utf-8'): Res {
  return { status, headers: { 'content-type': mime }, body: s };
}

export function redirect(to: string, flash?: string, kind: 'ok' | 'err' = 'ok'): Res {
  const headers: Record<string, string | string[]> = { location: to };
  if (flash) {
    headers['set-cookie'] = [
      `oriel_fl=${encodeURIComponent(kind + '|' + flash)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=30`,
    ];
  }
  return { status: 303, headers, body: '' };
}

export function fileRes(
  data: Uint8Array | string,
  mime: string,
  opts?: { filename?: string; inline?: boolean; cache?: boolean },
): Res {
  const headers: Record<string, string> = { 'content-type': mime };
  if (opts?.filename) {
    headers['content-disposition'] = `${opts.inline ? 'inline' : 'attachment'}; filename="${opts.filename.replace(/[^\w.\- ]/g, '_')}"`;
  }
  if (opts?.cache) headers['cache-control'] = 'public, max-age=3600';
  return { status: 200, headers, body: data };
}

export function notFound(msg = 'Not found'): Res {
  return errorPage(404, msg);
}
export function forbidden(msg = 'You do not have permission to do that.'): Res {
  return errorPage(403, msg);
}
export function badRequest(msg = 'Bad request'): Res {
  return errorPage(400, msg);
}

export function errorPage(status: number, msg: string, detail?: string): Res {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${status}</title><link rel="stylesheet" href="/assets/theme.css"></head><body class="err-page"><div class="err-box"><h1 class="err-code">${status}</h1><p>${esc(msg)}</p>${detail ? `<pre class="err-detail">${esc(detail)}</pre>` : ''}<a class="btn" href="javascript:history.back()">Go back</a> <a class="btn btn-ghost" href="/">Home</a></div></body></html>`;
  return { status, headers: { 'content-type': 'text/html; charset=utf-8' }, body };
}

// ---------- router ----------

interface RouteDef {
  method: string;
  segs: string[];
  mws: Middleware[];
  handler: Handler;
  pattern: string;
}

export class Router {
  routes: RouteDef[] = [];

  add(method: string, pattern: string, ...fns: (Middleware | Handler)[]): void {
    const handler = fns[fns.length - 1] as Handler;
    const mws = fns.slice(0, -1) as Middleware[];
    this.routes.push({ method, pattern, segs: pattern.split('/').filter((s) => s !== ''), mws, handler });
  }
  get(pattern: string, ...fns: (Middleware | Handler)[]): void {
    this.add('GET', pattern, ...fns);
  }
  post(pattern: string, ...fns: (Middleware | Handler)[]): void {
    this.add('POST', pattern, ...fns);
  }

  match(method: string, path: string): { route: RouteDef; params: Record<string, string> } | null {
    const parts = path.split('/').filter((s) => s !== '');
    outer: for (const route of this.routes) {
      if (route.method !== method) continue;
      const segs = route.segs;
      const params: Record<string, string> = {};
      let i = 0;
      for (; i < segs.length; i++) {
        const s = segs[i]!;
        if (s.startsWith('*')) {
          params[s.slice(1)] = parts.slice(i).map(decodeURIComponent).join('/');
          return { route, params };
        }
        if (i >= parts.length) continue outer;
        if (s.startsWith(':')) params[s.slice(1)] = decodeURIComponent(parts[i]!);
        else if (s !== parts[i]) continue outer;
      }
      if (i !== parts.length) continue;
      return { route, params };
    }
    return null;
  }
}

// ---------- body parsing ----------

const MAX_BODY = 25 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseUrlEncoded(s: string): Record<string, any> {
  const out: Record<string, any> = {};
  const sp = new URLSearchParams(s);
  for (const [k, val] of sp) {
    if (k.endsWith('[]')) {
      const key = k.slice(0, -2);
      (out[key] ||= []).push(val);
    } else if (k in out) {
      if (Array.isArray(out[k])) out[k].push(val);
      else out[k] = [out[k], val];
    } else out[k] = val;
  }
  return out;
}

function parseMultipart(buf: Buffer, contentType: string): { fields: Record<string, any>; uploads: Upload[] } {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const boundary = m ? (m[1] || m[2] || '').trim() : '';
  const fields: Record<string, any> = {};
  const uploads: Upload[] = [];
  if (!boundary) return { fields, uploads };
  const delim = Buffer.from(`--${boundary}`);
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    const start = pos + delim.length;
    if (buf[start] === 45 && buf[start + 1] === 45) break; // closing --
    const headEnd = buf.indexOf('\r\n\r\n', start);
    if (headEnd === -1) break;
    const head = buf.subarray(start, headEnd).toString('utf8');
    const next = buf.indexOf(delim, headEnd + 4);
    if (next === -1) break;
    let bodyEnd = next - 2; // strip trailing \r\n
    const data = buf.subarray(headEnd + 4, bodyEnd);
    const nameM = /name="([^"]*)"/.exec(head);
    const fileM = /filename="([^"]*)"/.exec(head);
    const typeM = /content-type:\s*([^\r\n]+)/i.exec(head);
    const name = nameM ? nameM[1]! : '';
    if (fileM && fileM[1]) {
      uploads.push({ field: name, filename: fileM[1], mime: typeM ? typeM[1]!.trim() : 'application/octet-stream', data: Buffer.from(data) });
    } else if (name) {
      const val = data.toString('utf8');
      if (name.endsWith('[]')) (fields[name.slice(0, -2)] ||= []).push(val);
      else fields[name] = val;
    }
    pos = next;
  }
  return { fields, uploads };
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(
  name: string,
  value: string,
  opts: { maxAge?: number; path?: string; httpOnly?: boolean; expire?: boolean } = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path || '/'}`, 'SameSite=Lax'];
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.expire) parts.push('Max-Age=0');
  else if (opts.maxAge) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join('; ');
}

// ---------- server ----------

export interface AppOptions {
  router: Router;
  /** run before routing (session attach etc); may short-circuit */
  before?: Middleware[];
  onError?: (e: Error, r: Rq) => void;
}

export function createApp(opts: AppOptions): Server {
  return createServer((req, res) => {
    void handle(req, res, opts);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, opts: AppOptions): Promise<void> {
  const method = (req.method || 'GET').toUpperCase();
  let r: Rq | null = null;
  try {
    const url = new URL(req.url || '/', `http://${(req.headers.host as string) || 'localhost'}`);
    r = {
      raw: req,
      method,
      path: url.pathname.replace(/\/+$/, '') || '/',
      url,
      params: {},
      query: url.searchParams,
      body: {},
      uploads: [],
      cookies: parseCookies(req.headers.cookie as string | undefined),
      ip: req.socket.remoteAddress || '0.0.0.0',
      setCookies: [],
    };

    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const ctype = String(req.headers['content-type'] || '');
      const bodyBuf = await readBody(req);
      if (ctype.includes('multipart/form-data')) {
        const { fields, uploads } = parseMultipart(bodyBuf, ctype);
        r.body = fields;
        r.uploads = uploads;
      } else if (ctype.includes('application/json')) {
        try {
          r.body = bodyBuf.length ? JSON.parse(bodyBuf.toString('utf8')) : {};
        } catch {
          send(res, r, badRequest('Invalid JSON body'));
          return;
        }
      } else {
        r.body = parseUrlEncoded(bodyBuf.toString('utf8'));
      }
      // CSRF: same-origin check for cookie-authenticated browser posts (API-key routes skip via /api prefix)
      if (!r.path.startsWith('/api/') && r.cookies['oriel_s']) {
        const origin = (req.headers.origin as string) || '';
        const host = (req.headers.host as string) || '';
        if (origin && new URL(origin).host !== host) {
          send(res, r, forbidden('Cross-origin request blocked.'));
          return;
        }
      }
    }

    for (const mw of opts.before || []) {
      const out = await mw(r);
      if (out) {
        send(res, r, out);
        return;
      }
    }

    const matched = opts.router.match(method, r.path);
    if (!matched) {
      send(res, r, notFound(`No page at ${r.path}`));
      return;
    }
    r.params = matched.params;
    for (const mw of matched.route.mws) {
      const out = await mw(r);
      if (out) {
        send(res, r, out);
        return;
      }
    }
    const out = await matched.route.handler(r);
    send(res, r, out);
  } catch (e) {
    const err = e as Error;
    if (opts.onError && r) opts.onError(err, r);
    const dev = process.env.ORIEL_MODE !== 'production';
    try {
      send(res, r, errorPage(500, 'Something went wrong.', dev ? String(err.stack || err.message) : undefined));
    } catch {
      /* socket gone */
    }
  }
}

function send(res: ServerResponse, r: Rq | null, out: Res): void {
  if (res.headersSent) return;
  const headers = { ...out.headers };
  const cookies: string[] = [];
  const existing = headers['set-cookie'];
  if (existing) cookies.push(...(Array.isArray(existing) ? existing : [existing]));
  if (r?.setCookies.length) cookies.push(...r.setCookies);
  if (cookies.length) headers['set-cookie'] = cookies;
  headers['x-content-type-options'] = 'nosniff';
  headers['x-frame-options'] = 'SAMEORIGIN';
  headers['referrer-policy'] = 'same-origin';
  res.writeHead(out.status, headers);
  res.end(out.body);
}

/** read+clear flash cookie; returns [kind, message] */
export function takeFlash(r: Rq): [string, string] | null {
  const v = r.cookies['oriel_fl'];
  if (!v) return null;
  r.setCookies.push(cookie('oriel_fl', '', { expire: true }));
  const i = v.indexOf('|');
  return i === -1 ? ['ok', v] : [v.slice(0, i), v.slice(i + 1)];
}

/** pagination helper: parse ?page= and build offset */
export function pageParams(r: Rq, perPage = 50): { page: number; limit: number; offset: number } {
  const page = Math.max(1, parseInt(r.query.get('page') || '1', 10) || 1);
  return { page, limit: perPage, offset: (page - 1) * perPage };
}
