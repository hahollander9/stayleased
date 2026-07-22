import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Router, createApp, fileRes, notFound, redirect, type Rq } from '../lib/http.ts';
import { attachSession, requireStaff, type Ctx } from '../lib/auth.ts';
import { db, ROOT } from '../lib/db.ts';
import { startPoller } from '../lib/jobs.ts';
import { html } from '../lib/html.ts';
import { shell, card, emptyState } from '../ui/ui.ts';

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
        title: 'Welcome to Oriel',
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
    onError: (e, rq) => console.error(`[500] ${rq.method} ${rq.path}:`, e.stack || e.message),
  });
  app.listen(port, () => {
    const dbFile = process.env.ORIEL_DB || 'data/oriel.db';
    console.log(`Oriel listening on http://localhost:${port}  (db: ${dbFile}, mode: ${process.env.ORIEL_MODE || 'dev'})`);
  });
  return app;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() || '@@');
if (isMain) {
  const port = parseInt(process.env.PORT || '3000', 10);
  startServer(port);
  if (process.env.ORIEL_MODE !== 'test') startPoller(60000);
}
