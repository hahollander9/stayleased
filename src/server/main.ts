import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Router, createApp, fileRes, notFound, redirect, type Rq } from '../lib/http.ts';
import { attachSession, requireStaff, type Ctx } from '../lib/auth.ts';
import { db, ROOT, q1, closeDb } from '../lib/db.ts';
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
    '/assets/mk/dashboard-light.png': ['src/ui/mk-assets/dashboard-light.png', 'image/png'],
    '/assets/mk/ai-queue-light.png': ['src/ui/mk-assets/ai-queue-light.png', 'image/png'],
    '/assets/mk/hero-dashboard.png': ['src/ui/mk-assets/hero-dashboard.png', 'image/png'],
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

export function startServer(port: number): ReturnType<typeof createApp> {
  db(); // open + apply schema
  const router = buildRouter();
  const app = createApp({
    router,
    before: [attachSession],
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
  startServer(port);
  if (env('MODE') !== 'test') {
    startPoller(60000);
    // catch live orgs up to today shortly after boot (poller repeats this)
    setTimeout(() => {
      try { syncLiveOrgClocks(); } catch (e) { log.error('clock_sync', e); }
    }, 2000);
  }
}
