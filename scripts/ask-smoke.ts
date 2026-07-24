/** Visual + functional smoke for the /ask chat: screenshots the page, sends
 * "hello" (conversational path) and a data question (structured path). */
import { boot, login, newPage } from '../e2e/lib.ts';
import type { Page } from 'playwright';

const { base, browser, close } = await boot();
const page = await newPage(browser);
await login(page, base, 'admin@summitridge.demo');
await page.goto(`${base}/ask`, { waitUntil: 'networkidle' });
await page.screenshot({ path: 'shots/ask-1-empty.png' });

// the panel carries .busy while a request/typewriter is running — wait it out
const idle = (p: Page): Promise<unknown> =>
  p.waitForFunction(() => !document.querySelector('.aichat-panel.busy'), undefined, { timeout: 30000 });
const lastAgent = (p: Page): Promise<string> => p.evaluate(() => {
  const a = document.querySelectorAll('.aichat-msg.agent .aichat-bubble');
  return (a[a.length - 1]!.textContent || '').trim();
});

// conversational: "hello" must NOT hit the old fallback
await page.fill('#aichat-input', 'hello');
await page.click('.aichat-send');
await page.waitForSelector('.aichat-panel.busy', { timeout: 5000 });
await idle(page);
const helloTxt = await lastAgent(page);
console.log('HELLO →', helloTxt);
if (/could not answer that directly/i.test(helloTxt)) throw new Error('fallback leaked!');
await page.screenshot({ path: 'shots/ask-2-hello.png' });

// structured: chip click → table answer
await page.click('.aichat-chip:has-text("delinquency over $500 at Summit Ridge")');
await page.waitForSelector('.aichat-panel.busy', { timeout: 5000 });
await idle(page);
await page.waitForSelector('.aichat-extra .tbl', { timeout: 5000 });
console.log('DATA →', (await lastAgent(page)).slice(0, 140));
await page.screenshot({ path: 'shots/ask-3-data.png' });

// follow-up smalltalk: "thanks"
await page.fill('#aichat-input', 'thanks!');
await page.click('.aichat-send');
await page.waitForSelector('.aichat-panel.busy', { timeout: 5000 });
await idle(page);
console.log('THANKS →', await lastAgent(page));
await page.screenshot({ path: 'shots/ask-4-thanks.png', fullPage: true });

await page.close();
await close();
console.log('SMOKE OK');
