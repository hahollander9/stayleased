// Render scripts/og-image.html → src/ui/mk-assets/og-image.png (1200×630).
// Usage: node scripts/og-image.mjs   (requires playwright + a chromium)
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const exe = process.env.PLAYWRIGHT_CHROMIUM || undefined;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 });
await page.goto('file://' + path.join(here, 'og-image.html'));
await page.waitForTimeout(400); // fonts settle
await page.screenshot({ path: path.join(here, '..', 'src', 'ui', 'mk-assets', 'og-image.png') });
await browser.close();
console.log('wrote src/ui/mk-assets/og-image.png');
