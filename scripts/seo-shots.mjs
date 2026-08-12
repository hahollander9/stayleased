// One batched visual-verify round for the 2026-08-12 SEO/UX pass.
// Boots the seeded server in-process and captures the four new UI pieces
// in both themes, desktop + mobile. Not part of CI; a review tool.
import { chromium } from 'playwright';
import { startServer } from '../src/server/main.ts';

const app = startServer(0);
const base = await new Promise((res) => {
  const tick = () => { const a = app.address(); a && typeof a === 'object' ? res(`http://127.0.0.1:${a.port}`) : setTimeout(tick, 20); };
  tick();
});
const exe = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});

async function shot(name, { url, theme, mobile, scrollTo, fullTo }) {
  const ctx = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1360, height: 900 },
    deviceScaleFactor: mobile ? 2 : 1,
  });
  await ctx.addCookies([{ name: 'sl_theme', value: theme, url: base }]);
  const page = await ctx.newPage();
  await page.goto(`${base}${url}`, { waitUntil: 'networkidle' });
  if (scrollTo) {
    await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'start' }), scrollTo);
    await page.waitForTimeout(900); // one-shot reveals settle
  }
  if (fullTo !== undefined) {
    await page.evaluate((y) => window.scrollTo(0, y), fullTo);
    await page.waitForTimeout(700);
  }
  await page.screenshot({ path: `shots/${name}.png` });
  await ctx.close();
  console.log(`shot ${name}`);
}

import { mkdirSync } from 'node:fs';
mkdirSync('shots', { recursive: true });

await shot('faq-dark', { url: '/', theme: 'dark', scrollTo: '#faq' });
await shot('faq-light', { url: '/', theme: 'light', scrollTo: '#faq' });
await shot('promise-dark', { url: '/', theme: 'dark', scrollTo: '#walkthrough' });
await shot('mcta-mobile-dark', { url: '/platform/rent-collection', theme: 'dark', mobile: true, fullTo: 900 });
await shot('mcta-mobile-light', { url: '/', theme: 'light', mobile: true, fullTo: 1200 });
await shot('crumb-light', { url: '/platform/rent-collection', theme: 'light' });
await shot('hub-crumb-dark', { url: '/agents', theme: 'dark' });
await shot('404-dark', { url: '/definitely-not-a-page', theme: 'dark' });
await shot('404-light', { url: '/definitely-not-a-page', theme: 'light' });

await browser.close();
app.close();
process.exit(0);
