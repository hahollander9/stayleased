import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/lib/db.ts';
import { boot, login, newPage } from './lib.ts';

/** Capture "after" (StayLeased) shots of marquee screens for the rebrand
 * before/after comparison. `npm run seed` first so the dev DB is fresh. */
const SHOTS: { name: string; path: string; persona: string; mobile?: boolean; fullPage?: boolean }[] = [
  { name: 'login', path: '/login', persona: '' },
  { name: 'not-found-404', path: '/this-page-does-not-exist', persona: '' },
  { name: 'staff-dashboard', path: '/', persona: 'admin@summitridge.demo', fullPage: true },
  { name: 'ask-stayleased', path: '/ask?q=occupancy', persona: 'regional@summitridge.demo', fullPage: true },
  { name: 'public-site', path: '/p/summit-ridge', persona: '', fullPage: true },
  { name: 'company', path: '/company', persona: '', fullPage: true },
  { name: 'portal-home', path: '/portal', persona: 'maya.torres@mail.demo', mobile: true, fullPage: true },
];

async function main(): Promise<void> {
  const sub = process.argv[2] || 'rebrand-after';
  const dir = join(ROOT, 'docs', 'screenshots', sub);
  mkdirSync(dir, { recursive: true });
  const { base, browser, close } = await boot();
  const cache = new Map<string, Awaited<ReturnType<typeof newPage>>>();
  for (const shot of SHOTS) {
    const key = `${shot.persona}|${shot.mobile ? 'm' : 'd'}`;
    let page = cache.get(key);
    if (!page) {
      page = await newPage(browser, { mobile: shot.mobile });
      if (shot.persona) await login(page, base, shot.persona);
      cache.set(key, page);
    }
    await page.goto(base + shot.path, { waitUntil: 'networkidle' });
    await page.screenshot({ path: join(dir, `${shot.name}.png`), fullPage: shot.fullPage ?? false });
    console.log(`  📸 ${shot.name}.png`);
  }
  await close();
  console.log(`Saved ${SHOTS.length} shots to docs/screenshots/${sub}/`);
}
main().catch((e) => { console.error(e); process.exit(1); });
