import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MK_PAGES, MK_GROUPS } from '../src/modules/m4_marketing/features.ts';
import { MK_NAV } from '../src/modules/m4_marketing/chrome.ts';

/** Marketing catalog integrity: every nav dropdown item must resolve to a
 * real dedicated page, every page must be complete enough to render, and
 * features the product does not have (rent reporting) must stay out of the
 * nav and the catalog. This is the drift guard between chrome.ts and
 * features.ts. */

const pageUrl = (group: keyof typeof MK_GROUPS, slug: string): string => `${MK_GROUPS[group].base}/${slug}`;
const ALL_URLS = new Set(MK_PAGES.map((p) => pageUrl(p.group, p.slug)));

test('every nav dropdown item points at a dedicated page that exists', () => {
  const groupByLabel: Record<string, keyof typeof MK_GROUPS> = {
    Platform: 'platform', AI: 'agents', "Who it's for": 'for',
  };
  for (const g of MK_NAV) {
    const groupKey = groupByLabel[g.label];
    assert.ok(groupKey, `nav group "${g.label}" is a known group`);
    assert.equal(g.href, MK_GROUPS[groupKey!].base, `group "${g.label}" hub href`);
    for (const [label, href] of g.items) {
      assert.ok(ALL_URLS.has(href), `nav item "${label}" (${href}) has a dedicated page`);
      const page = MK_PAGES.find((p) => `${MK_GROUPS[p.group].base}/${p.slug}` === href)!;
      assert.equal(page.label, label, `nav label matches page label for ${href}`);
    }
  }
});

test('every page in the catalog appears in the nav (no orphan pages)', () => {
  const navHrefs = new Set(MK_NAV.flatMap((g) => g.items.map(([, href]) => href)));
  for (const p of MK_PAGES) {
    assert.ok(navHrefs.has(pageUrl(p.group, p.slug)), `page ${p.slug} is reachable from the nav`);
  }
});

test('slugs are unique within their group', () => {
  const seen = new Set<string>();
  for (const p of MK_PAGES) {
    const key = `${p.group}/${p.slug}`;
    assert.ok(!seen.has(key), `duplicate slug ${key}`);
    seen.add(key);
  }
});

test('every page is complete: copy, stats, features, mock, faq, related', () => {
  for (const p of MK_PAGES) {
    const at = `${p.group}/${p.slug}`;
    assert.ok(p.title.length > 10 && p.sub.length > 40, `${at}: title+sub`);
    assert.ok(p.points.length >= 3, `${at}: >=3 hero points`);
    assert.equal(p.stats.length, 3, `${at}: exactly 3 proof stats`);
    assert.ok(p.features.length >= 4, `${at}: >=4 feature cards`);
    assert.equal(p.mock.kpis.length, 4, `${at}: 4 mock KPIs`);
    assert.equal(p.mock.feed.length, 3, `${at}: 3 mock feed lines`);
    assert.ok(p.faq.length >= 3, `${at}: >=3 FAQ entries`);
    assert.ok(p.related.length >= 2, `${at}: >=2 related links`);
  }
});

test('related links resolve to real pages', () => {
  for (const p of MK_PAGES) {
    for (const r of p.related) {
      assert.ok(ALL_URLS.has(r.href), `${p.group}/${p.slug}: related "${r.label}" (${r.href}) exists`);
    }
  }
});

test('rent reporting stays out: not in the product, so not in nav or catalog', () => {
  const navText = JSON.stringify(MK_NAV).toLowerCase();
  assert.ok(!navText.includes('rent reporting'), 'nav has no rent-reporting item');
  for (const p of MK_PAGES) {
    assert.ok(p.label.toLowerCase() !== 'rent reporting', 'no rent-reporting page');
  }
});

test('rails still in rollout carry an honest status chip', () => {
  // money movement and the screening bureau are simulated rails (see
  // /setup/connections) — their pages must say so
  for (const slug of ['rent-collection', 'applications-screening', 'resident-portal']) {
    const p = MK_PAGES.find((x) => x.group === 'platform' && x.slug === slug)!;
    assert.ok(p.chip, `platform/${slug} has a status chip`);
  }
});

test('the retired Residents pillar stays retired: no resident group, portal folded into Platform', () => {
  assert.ok(!('resident' in MK_GROUPS), 'no resident marketing group');
  assert.ok(!MK_NAV.some((g) => g.label === 'Residents'), 'no Residents nav dropdown');
  const portal = MK_PAGES.find((p) => p.slug === 'resident-portal');
  assert.ok(portal && portal.group === 'platform', 'resident portal lives as ONE Platform item');
});

test('the AI group leads with the new-to-AI explainer', () => {
  const ai = MK_NAV.find((g) => g.label === 'AI')!;
  assert.match(ai.items[0]![0], /New to AI/i, 'first AI nav item is the newcomer page');
  const page = MK_PAGES.find((p) => p.slug === 'new-to-ai');
  assert.ok(page, 'new-to-ai page exists');
});
