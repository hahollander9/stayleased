import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gaSnippet, mkSeoHead, ldJson, siteOrigin, orgLd } from '../src/modules/m4_marketing/chrome.ts';
import { setEnv } from '../src/lib/env.ts';

/** SEO/UX pass (2026-08-12) unit gate: the shared helpers in chrome.ts.
 * GA must be OFF by default (no env var → no markup, and http.ts keeps the
 * pre-GA CSP byte-identical); JSON-LD must never leak a street address or
 * an unescaped `<`; canonical/share meta must be absolute on the prod origin. */

test('gaSnippet renders nothing until STAYLEASED_GA_ID is set, then a privacy-flagged config', () => {
  delete process.env.STAYLEASED_GA_ID;
  delete process.env.ORIEL_GA_ID;
  assert.equal(gaSnippet().s, '', 'no env var → no analytics markup at all');
  setEnv('GA_ID', 'G-TEST123');
  try {
    const s = gaSnippet().s;
    assert.match(s, /googletagmanager\.com\/gtag\/js\?id=G-TEST123/, 'loader targets the configured id');
    assert.match(s, /anonymize_ip:true/, 'IP anonymization on');
    assert.match(s, /allow_google_signals:false/, 'Google signals off');
    assert.match(s, /allow_ad_personalization_signals:false/, 'ad personalization off');
  } finally {
    delete process.env.STAYLEASED_GA_ID;
  }
  assert.equal(gaSnippet().s, '', 'clearing the env var turns it back off');
});

test('gaSnippet sanitizes a hostile measurement id', () => {
  setEnv('GA_ID', 'G-1"/><script>alert(1)</script>');
  try {
    const s = gaSnippet().s;
    assert.ok(!s.includes('alert(1)'), 'script payload stripped');
    assert.match(s, /id=G-1scriptalert1script/, 'only [A-Za-z0-9-] survives');
  } finally {
    delete process.env.STAYLEASED_GA_ID;
  }
});

test('mkSeoHead emits absolute canonical + og:url/og:image + twitter card for the path', () => {
  const s = mkSeoHead('/platform/rent-collection', 'Rent collection — StayLeased', 'Sub.').s;
  assert.match(s, /<link rel="canonical" href="https:\/\/stayleased\.com\/platform\/rent-collection" \/>/);
  assert.match(s, /property="og:url" content="https:\/\/stayleased\.com\/platform\/rent-collection"/);
  assert.match(s, /property="og:image" content="https:\/\/stayleased\.com\/assets\/mk\/og-image\.png"/);
  assert.match(s, /name="twitter:card" content="summary_large_image"/);
});

test('siteOrigin respects the env override', () => {
  assert.equal(siteOrigin(), 'https://stayleased.com');
  setEnv('SITE_ORIGIN', 'https://www.example.org');
  try {
    assert.equal(siteOrigin(), 'https://www.example.org');
    assert.match(mkSeoHead('/', 't', 'd').s, /https:\/\/www\.example\.org\//);
  } finally {
    delete process.env.STAYLEASED_SITE_ORIGIN;
  }
});

test('ldJson escapes `<` so content can never close the script tag', () => {
  const s = ldJson({ a: '</script><script>alert(1)</script>' }).s;
  assert.ok(!s.includes('</script><script>'), 'no tag breakout');
  assert.match(s, /\\u003c\/script/, 'angle brackets unicode-escaped');
  assert.match(s, /^<script type="application\/ld\+json">/, 'well-formed opener');
});

test('Organization schema carries areaServed but never a street address', () => {
  const s = orgLd().s;
  const json = JSON.parse(s.replace(/^<script type="application\/ld\+json">/, '').replace(/<\/script>$/, ''));
  const org = json['@graph'].find((n: any) => n['@type'] === 'Organization');
  assert.ok(org, 'Organization node present');
  assert.match(JSON.stringify(org.areaServed), /Washington/, 'DC-metro areaServed');
  assert.ok(!s.includes('streetAddress'), 'no street address published (decision 2026-08-11)');
  const site = json['@graph'].find((n: any) => n['@type'] === 'WebSite');
  assert.ok(site, 'WebSite node present');
});
