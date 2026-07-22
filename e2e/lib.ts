import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { startServer } from '../src/server/main.ts';
import { ROOT, closeDb } from '../src/lib/db.ts';

/** Playwright e2e helpers. The server runs in-process against the DB named by
 * ORIEL_DB (scripts/e2e.sh seeds data/e2e.db; shots use the dev db).
 *
 * Isolation: when ORIEL_E2E_ISOLATE=1 (set by scripts/e2e.sh), each test file
 * (its own node:test process) boots against a private copy of the pristine
 * seeded DB, so files that advance the business date or mutate data can never
 * bleed into each other's expectations. */

export async function boot(): Promise<{ base: string; browser: Browser; close: () => Promise<void> }> {
  let clone: string | null = null;
  if (process.env.ORIEL_E2E_ISOLATE === '1') {
    const src = join(ROOT, process.env.ORIEL_DB || 'data/e2e.db');
    clone = `data/e2e-run-${process.pid}.db`;
    const dst = join(ROOT, clone);
    copyFileSync(src, dst);
    for (const sfx of ['-wal', '-shm']) {
      if (existsSync(src + sfx)) copyFileSync(src + sfx, dst + sfx);
      else rmSync(dst + sfx, { force: true });
    }
    process.env.ORIEL_DB = clone;
  }
  const app = startServer(0);
  const base: string = await new Promise((resolve) => {
    const tick = (): void => {
      const addr = app.address();
      if (addr && typeof addr === 'object') resolve(`http://127.0.0.1:${addr.port}`);
      else setTimeout(tick, 20);
    };
    tick();
  });
  const browser = await chromium.launch();
  return {
    base,
    browser,
    close: async () => {
      await browser.close();
      app.close();
      if (clone) {
        closeDb();
        for (const sfx of ['', '-wal', '-shm']) rmSync(join(ROOT, clone + sfx), { force: true });
      }
    },
  };
}

export async function login(page: Page, base: string, email: string, password = 'demo1234'): Promise<void> {
  await page.goto(`${base}/login`);
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', password);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button:has-text("Sign in")')]);
}

export async function newPage(browser: Browser, opts?: { mobile?: boolean }): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: opts?.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: opts?.mobile ? 2 : 1,
  });
  return ctx.newPage();
}
