import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, newPage } from './lib.ts';
import { MK_PAGES, MK_GROUPS } from '../src/modules/m4_marketing/features.ts';
import { setEnv } from '../src/lib/env.ts';
import type { Browser } from 'playwright';

/** SEO/UX pass gate (2026-08-12): share meta + JSON-LD + breadcrumbs +
 * homepage FAQ + response promise + sticky mobile CTA + 404 destinations +
 * env-gated GA (off by default, CSP unchanged until the env var exists). */

let base: string;
let browser: Browser;
let close: () => Promise<void>;

before(async () => {
  const b = await boot();
  base = b.base;
  browser = b.browser;
  close = b.close;
});
after(async () => close());

const ALL_MARKETING_URLS = [
  '/',
  ...Object.values(MK_GROUPS).map((g) => g.base),
  ...MK_PAGES.map((p) => `${MK_GROUPS[p.group].base}/${p.slug}`),
  '/legal/privacy',
  '/legal/terms',
];

function ldBlocks(body: string): any[] {
  const out: any[] = [];
  for (const m of body.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    out.push(JSON.parse(m[1]!));
  }
  return out;
}

test('gate: every marketing page ships canonical + og:image + twitter card + Organization schema', async () => {
  for (const url of ALL_MARKETING_URLS) {
    const res = await fetch(`${base}${url}`);
    assert.equal(res.status, 200, `${url} → 200`);
    const body = await res.text();
    assert.ok(body.includes(`<link rel="canonical" href="https://stayleased.com${url === '/' ? '/' : url}" />`), `${url} canonical`);
    assert.match(body, /property="og:image" content="https:\/\/stayleased\.com\/assets\/mk\/og-image\.png"/, `${url} og:image`);
    assert.match(body, /name="twitter:card" content="summary_large_image"/, `${url} twitter card`);
    assert.match(body, /property="og:url" content="https:\/\/stayleased\.com/, `${url} og:url`);
    const blocks = ldBlocks(body);
    assert.ok(blocks.length >= 1, `${url} has JSON-LD`);
    const graph = blocks.find((b) => b['@graph']);
    assert.ok(graph?.['@graph']?.some((n: any) => n['@type'] === 'Organization'), `${url} Organization schema`);
    assert.ok(!body.includes('streetAddress'), `${url} publishes no street address`);
  }
});

test('gate: the og-image asset serves as a real PNG', async () => {
  const res = await fetch(`${base}/assets/mk/og-image.png`);
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get('content-type')), /image\/png/);
  const buf = new Uint8Array(await res.arrayBuffer());
  assert.ok(buf.length > 10_000, 'not an empty file');
  assert.deepEqual([...buf.slice(1, 4)], [0x50, 0x4e, 0x47], 'PNG magic bytes');
});

test('gate: homepage schema = SoftwareApplication + 5-question FAQPage; band + promise render', async () => {
  const body = await (await fetch(`${base}/`)).text();
  const blocks = ldBlocks(body);
  const app = blocks.find((b) => b['@type'] === 'SoftwareApplication');
  assert.ok(app, 'SoftwareApplication present');
  assert.equal(app.offers.price, '0', 'early-access offer price 0 (matches the pricing band)');
  const faq = blocks.find((b) => b['@type'] === 'FAQPage');
  assert.equal(faq.mainEntity.length, 5, 'FAQPage carries exactly 5 questions');
  // the rendered band mirrors the schema
  const faqSection = body.slice(body.indexOf('id="faq"'), body.indexOf('</section>', body.indexOf('id="faq"')));
  assert.equal((faqSection.match(/<details/g) || []).length, 5, '5 rendered FAQ items');
  for (const q of faq.mainEntity) {
    assert.ok(body.includes(q.name), `rendered: ${q.name}`);
  }
  assert.match(body, /Demo requests are answered within one business day\./, 'response promise at the form');
  const thanks = await (await fetch(`${base}/?walkthrough=thanks`)).text();
  assert.match(thanks, /within one business day to set up your demo/, 'thanks copy carries the same promise');
});

test('gate: feature pages carry a visible Home/Group/Page breadcrumb that matches BreadcrumbList', async () => {
  const body = await (await fetch(`${base}/platform/rent-collection`)).text();
  assert.match(body, /<nav class="mkp-crumb" aria-label="Breadcrumb"><a href="\/">Home<\/a>/, 'trail starts at Home');
  assert.match(body, /<a href="\/platform">Platform<\/a>/, 'group link present');
  assert.match(body, /aria-current="page">Rent collection</, 'current page marked');
  const crumb = ldBlocks(body).find((b) => b['@type'] === 'BreadcrumbList');
  assert.equal(crumb.itemListElement.length, 3);
  assert.deepEqual(crumb.itemListElement.map((i: any) => i.name), ['Home', 'Platform', 'Rent collection']);
  const faq = ldBlocks(body).find((b) => b['@type'] === 'FAQPage');
  assert.ok(faq.mainEntity.length >= 3, 'feature FAQ schema from the page catalog');
  // hubs get the two-level trail
  const hub = await (await fetch(`${base}/agents`)).text();
  const hubCrumb = ldBlocks(hub).find((b) => b['@type'] === 'BreadcrumbList');
  assert.equal(hubCrumb.itemListElement.length, 2);
});

test('gate: 404 offers destinations and stays branded', async () => {
  const res = await fetch(`${base}/no-such-page`);
  assert.equal(res.status, 404);
  const body = await res.text();
  assert.match(body, /Page not found · StayLeased/, '404 title');
  for (const href of ['/platform', '/agents', '/login', '/#walkthrough']) {
    assert.ok(body.includes(`href="${href}"`), `404 links ${href}`);
  }
  // non-404 errors keep the terse page
  const forbidden = await fetch(`${base}/gl`, { redirect: 'manual' });
  assert.ok(forbidden.status === 302 || forbidden.status === 303 || forbidden.status === 401 || forbidden.status === 403, 'app route gated');
});

test('gate: GA is absent by default and the CSP is the pre-GA policy; setting the env var turns both on', async () => {
  const off = await fetch(`${base}/`);
  const offBody = await off.text();
  assert.ok(!offBody.includes('googletagmanager'), 'no GA markup without env var');
  const offCsp = String(off.headers.get('content-security-policy'));
  assert.ok(!offCsp.includes('googletagmanager'), 'no GA hosts in CSP without env var');
  assert.ok(!offCsp.includes('connect-src'), 'no connect-src directive without env var (default-src covers self)');

  setEnv('GA_ID', 'G-E2ETEST1');
  try {
    const on = await fetch(`${base}/`);
    const onBody = await on.text();
    assert.match(onBody, /googletagmanager\.com\/gtag\/js\?id=G-E2ETEST1/, 'loader present with env var');
    assert.match(onBody, /allow_ad_personalization_signals:false/, 'privacy flags in config');
    const onCsp = String(on.headers.get('content-security-policy'));
    assert.match(onCsp, /script-src [^;]*https:\/\/www\.googletagmanager\.com/, 'CSP allows the loader host');
    assert.match(onCsp, /connect-src 'self' https:\/\/\*\.google-analytics\.com/, 'CSP allows the beacon hosts');
    // the app (authed surface) never gets the snippet even with the env var set
    const login = await (await fetch(`${base}/login`)).text();
    assert.ok(!login.includes('googletagmanager'), 'login/app surface stays analytics-free');
  } finally {
    delete process.env.STAYLEASED_GA_ID;
  }
  const offAgain = await (await fetch(`${base}/`)).text();
  assert.ok(!offAgain.includes('googletagmanager'), 'clearing the env var restores the no-GA page');
});

test('gate: sticky mobile CTA appears after the hero on phones, never on desktop', async () => {
  const page = await newPage(browser);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const url of ['/', '/platform/rent-collection']) {
    await page.goto(`${base}${url}`, { waitUntil: 'networkidle' });
    const probe = () => page.evaluate(() => {
      const el = document.getElementById('mk-mcta')!;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { display: cs.display, show: el.classList.contains('show'), top: r.top, height: r.height, vh: window.innerHeight };
    });
    const atTop = await probe();
    assert.equal(atTop.display, 'block', `${url}: bar exists on mobile`);
    assert.equal(atTop.show, false, `${url}: hidden before scrolling`);
    await page.evaluate(() => window.scrollTo(0, 900));
    // wait for the slide-in transition to SETTLE, not just the class flip
    await page.waitForFunction(() => {
      const el = document.getElementById('mk-mcta')!;
      return el.classList.contains('show') && el.getBoundingClientRect().top < window.innerHeight;
    });
    await page.waitForTimeout(350);
    const shown = await probe();
    assert.ok(shown.top < shown.vh && shown.top > shown.vh - 160, `${url}: bar docked at the viewport bottom`);
    assert.ok(shown.height >= 44, `${url}: comfortable tap target (${shown.height}px)`);
    // back at the top it stands down again (state-toggled, like #mktop)
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForFunction(() => !document.getElementById('mk-mcta')!.classList.contains('show'));
  }
  // desktop: never rendered
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  await page.evaluate(() => window.scrollTo(0, 900));
  const desktop = await page.evaluate(() => getComputedStyle(document.getElementById('mk-mcta')!).display);
  assert.equal(desktop, 'none', 'hidden at desktop widths');
  await page.close();
});
