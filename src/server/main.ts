import * as nodeFs from 'node:fs';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Router, createApp, fileRes, jsonRes, notFound, redirect, type Rq } from '../lib/http.ts';
import { attachSession, guardPropertyParam, requireStaff, verifyPassword, hashPassword, type Ctx } from '../lib/auth.ts';
import { db, ROOT, q, q1, run, closeDb } from '../lib/db.ts';
import { startPoller, syncLiveOrgClocks } from '../lib/jobs.ts';
import { html } from '../lib/html.ts';
import { shell, card, emptyState } from '../ui/ui.ts';
import { env } from '../lib/env.ts';
import { log } from '../lib/log.ts';

// module route registrations (each module wires nav/search/api in its import)
import * as auth from '../modules/auth/pages.ts';
import * as admin from '../modules/m1_admin/pages.ts';
import { mountApi } from '../modules/m1_admin/api.ts';
import { registerModules } from './modules.ts';

export function buildRouter(): Router {
  const r = new Router();

  // static assets
  const assets: Record<string, [string, string]> = {
    '/assets/theme.css': ['src/ui/theme.css', 'text/css; charset=utf-8'],
    '/assets/app.js': ['src/ui/app.js', 'text/javascript; charset=utf-8'],
    '/assets/favicon.svg': ['src/ui/favicon.svg', 'image/svg+xml'],
    '/assets/fonts/inter-var.woff2': ['src/ui/fonts/inter-var.woff2', 'font/woff2'],
    '/assets/fonts/space-grotesk-var.woff2': ['src/ui/fonts/space-grotesk-var.woff2', 'font/woff2'],
    '/assets/fonts/fraunces-var.woff2': ['src/ui/fonts/fraunces-var.woff2', 'font/woff2'],
    '/assets/fonts/fraunces-italic-var.woff2': ['src/ui/fonts/fraunces-italic-var.woff2', 'font/woff2'],
    '/assets/mk/og-image.png': ['src/ui/mk-assets/og-image.png', 'image/png'],
    '/assets/mk/dashboard-light.png': ['src/ui/mk-assets/dashboard-light.png', 'image/png'],
    '/assets/mk/ai-queue-light.png': ['src/ui/mk-assets/ai-queue-light.png', 'image/png'],
    '/assets/mk/hero-dashboard.png': ['src/ui/mk-assets/hero-dashboard.png', 'image/png'],
    '/assets/mk/hero-home.png': ['src/ui/mk-assets/hero-home.png', 'image/png'],
    '/assets/mk/feat-ai.png': ['src/ui/mk-assets/feat-ai.png', 'image/png'],
    '/assets/mk/feat-accounting.png': ['src/ui/mk-assets/feat-accounting.png', 'image/png'],
    '/assets/mk/feat-portal.png': ['src/ui/mk-assets/feat-portal.png', 'image/png'],
    '/assets/vendor/leaflet.js': ['src/ui/vendor/leaflet.js', 'text/javascript; charset=utf-8'],
    '/assets/vendor/leaflet.css': ['src/ui/vendor/leaflet.css', 'text/css; charset=utf-8'],
  };
  for (const [route, [path, mime]] of Object.entries(assets)) {
    r.get(route, () => fileRes(readFileSync(join(ROOT, path)), mime, { inline: true, cache: true }));
  }
  r.get('/favicon.ico', () => fileRes(readFileSync(join(ROOT, 'src/ui/favicon.svg')), 'image/svg+xml', { inline: true, cache: true }));

  // Liveness for the host's health check and an uptime monitor. Public and
  // deliberately dull: it says whether the database answers and how full the
  // data disk is, and nothing about who is in it. A database that cannot answer
  // is a 503 (the host should restart us); a nearly full disk is a 200 marked
  // "degraded", because restarting does not free space and a restart loop on a
  // full disk is worse than the full disk — the monitor alerts on the word.
  r.get('/healthz', () => {
    let dbOk = false;
    try { dbOk = q1<{ ok: number }>('SELECT 1 AS ok')?.ok === 1; } catch { dbOk = false; }
    const disk = diskFree();
    const low = disk !== null && (disk.freePct < 10 || disk.freeMb < 100);
    const out = jsonRes({
      ok: dbOk,
      status: !dbOk ? 'down' : low ? 'degraded' : 'ok',
      db: dbOk ? 'ok' : 'unreachable',
      disk_free_pct: disk ? disk.freePct : null,
    }, dbOk ? 200 : 503);
    out.headers['cache-control'] = 'no-store';
    return out;
  });

  auth.routes(r);
  admin.routes(r);
  registerModules(r); // phase modules mount here as they are built
  mountApi(r);

  // root landing (replaced by the property dashboard from Phase 1 via modules)
  if (!r.routes.some((x) => x.pattern === '/' && x.method === 'GET')) {
    r.get('/', requireStaff, (rq: Rq) =>
      shell(rq, {
        title: 'Welcome to StayLeased',
        active: '/',
        content: card(null, emptyState('Foundation is up', 'Portfolio, units, and dashboards arrive in Phase 1.', null)),
      }),
    );
  }

  return r;
}

/** Free space on the volume that holds the database, or null where the
 * platform cannot say. */
export function diskFree(): { freePct: number; freeMb: number } | null {
  try {
    const file = env('DB') || 'data/stayleased.db';
    // statfsSync is in Node 18.15+, ahead of the type package this repo pins
    const statfs = (nodeFs as unknown as { statfsSync?: (p: string) => { blocks: number | bigint; bavail: number | bigint; bsize: number | bigint } }).statfsSync;
    if (!statfs) return null;
    const st = statfs(dirname(isAbsolute(file) ? file : join(ROOT, file)));
    if (!st.blocks) return null;
    return {
      freePct: Math.round((Number(st.bavail) / Number(st.blocks)) * 1000) / 10,
      freeMb: Math.round((Number(st.bavail) * Number(st.bsize)) / 1048576),
    };
  } catch { return null; }
}

export function startServer(port: number): ReturnType<typeof createApp> {
  db(); // open + apply schema
  const router = buildRouter();
  const app = createApp({
    router,
    before: [
      attachSession,
      guardPropertyParam,
      // /pricing is the staff pricing desk, but it is also the first URL a
      // visitor types to find the price — and it sent them to a sign-in form.
      // Only the bare typed URL: a deep link, an in-app click or an expired
      // session still goes to sign-in and comes back where it was headed.
      (rq) => (!rq.user && rq.method === 'GET' && rq.path === '/pricing' && ![...rq.query.keys()].length && !rq.cookies['sl_s'] && !rq.raw.headers.referer
        ? redirect('/#pricing') : undefined),
    ],
    onError: (e, rq) => log.error('request_failed', e, { method: rq.method, path: rq.path, ip: rq.ip }),
  });
  app.listen(port, () => {
    const dbFile = env('DB') || 'data/stayleased.db';
    log.info(`StayLeased listening on http://localhost:${port}`, { db: dbFile, mode: env('MODE') || 'dev' });
  });
  return app;
}

/** First-boot seeding: when the database has no orgs at all (fresh install or
 * a brand-new persistent disk), build the demo world before serving. Runs in a
 * child process so seed memory is released; the server does not listen until
 * the world exists, which deploy health checks treat as "still starting". */
function seedIfEmpty(): void {
  if (env('SEED_ON_BOOT') === '0') return;
  const empty = !q1('SELECT id FROM orgs LIMIT 1');
  closeDb();
  if (!empty) return;
  log.info('Empty database — seeding the demo world (about a minute)...');
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', join(ROOT, 'src/seed/seed.ts'), '--quiet'],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (r.status !== 0) throw new Error(`seed failed with exit ${r.status}`);
  log.info('Seed complete.');
}

/** The platform account that shipped in the first seed has the password from
 * the public demo-logins file, and it can open every organization. On a real
 * deployment, set STAYLEASED_PLATFORM_PASSWORD and the next boot rotates it;
 * until then every boot says so in the log, loudly. Local runs are left alone. */
function securePlatformAccount(): void {
  try {
    const real = process.env.RENDER === 'true' || env('MODE') === 'production';
    if (!real) return;
    const rows = q<{ id: string; email: string; password_hash: string }>(`SELECT id, email, password_hash FROM users WHERE kind='platform' AND active=1`);
    const set = env('PLATFORM_PASSWORD');
    for (const u of rows) {
      if (!verifyPassword('demo1234', u.password_hash)) continue;
      if (set && set !== 'demo1234') {
        run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(set), u.id);
        run('DELETE FROM sessions WHERE user_id=?', u.id);
        log.info('platform account password rotated from STAYLEASED_PLATFORM_PASSWORD', { email: u.email });
      } else {
        log.error('platform_account_default_password', new Error(`${u.email} still has the public demo password — set STAYLEASED_PLATFORM_PASSWORD or change it at /me`));
      }
    }
  } catch (e) { log.error('platform_account_check', e); }
}

let poller: { stop: () => void } | undefined;

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() || '@@');
if (isMain) {
  // Crash safety (CODE-1): a stray rejection or throw must be logged, not
  // silently swallowed. We deliberately do NOT exit — the in-process poller and
  // request handlers are resilient, so killing the process would take the whole
  // server down over one bad async task.
  process.on('unhandledRejection', (reason) => log.error('unhandledRejection', reason));
  process.on('uncaughtException', (err) => log.error('uncaughtException', err));
  const port = parseInt(process.env.PORT || '3000', 10);
  if (env('MODE') !== 'test') seedIfEmpty();
  const server = startServer(port);
  if (env('MODE') !== 'test') securePlatformAccount();
  if (env('MODE') !== 'test') {
    poller = startPoller(60000);
    // catch live orgs up to today shortly after boot (poller repeats this)
    setTimeout(() => {
      try { syncLiveOrgClocks(); } catch (e) { log.error('clock_sync', e); }
    }, 2000);
  }
  // A deploy sends SIGTERM. Without a handler the process died mid-request and
  // could stop a job halfway; now it stops taking work, lets what is in flight
  // finish, closes the database cleanly, and only then exits.
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received — shutting down`);
    poller?.stop();
    const done = (): void => { try { closeDb(); } catch { /* already closed */ } process.exit(0); };
    server.close(done);
    (setTimeout(done, 8000) as unknown as { unref: () => void }).unref(); // keep-alive sockets must not hold a deploy hostage
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
