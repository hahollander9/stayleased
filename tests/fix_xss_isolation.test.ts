import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, q1, insert } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { sysCtx, hashPassword } from '../src/lib/auth.ts';
import { putFile, sniffMime, safeMime, canServeInline } from '../src/lib/files.ts';
import { startTestServer, loginAs, get, post } from './harness.ts';

/** Regression guards for the Batch-B security fixes:
 *  SEC-1 stored XSS via inline-served uploads, SEC-2 stored XSS in the Message
 *  Console, SEC-3 cross-tenant thread snooze, SEC-4 reflected XSS on
 *  /ai/essentials. Self-contained two-org fixture so it can't perturb the
 *  shared harness fixture's cross-process state. */

let orgA: string;
let orgB: string;
let base: string;
let close: () => void;
let cookieA: string;

// an SVG that would run script if a browser ever rendered it inline
const SVG_XSS = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(document.cookie)</script></svg>',
  'utf8',
);
// a real PNG needs only its 8-byte signature to be recognized by the sniffer
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

function mkOrg(slug: string): { org: string; adminEmail: string } {
  const org = id('org');
  const suffix = org.slice(-6);
  insert('orgs', { id: org, name: `XSS Org ${slug}`, slug: `xss-${slug}-${suffix}`, business_date: '2026-07-26', created_at: nowIso() });
  const uid = id('usr');
  const adminEmail = `admin-xss-${slug}-${suffix}@test.demo`;
  insert('users', {
    id: uid, org_id: org, email: adminEmail, name: `Admin ${slug}`,
    kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
  });
  insert('role_assignments', { id: id('ra'), org_id: org, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
  insert('properties', {
    id: id('prp'), org_id: org, name: `Prop ${slug}`, slug: `xss-prop-${slug}-${suffix}`, type: 'multifamily',
    address1: '1 Test St', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso(),
  });
  return { org, adminEmail };
}

before(async () => {
  db();
  const a = mkOrg('a');
  const b = mkOrg('b');
  orgA = a.org;
  orgB = b.org;
  const srv = await startTestServer();
  base = srv.base;
  close = srv.close;
  cookieA = await loginAs(base, a.adminEmail);
});

after(() => close());

// ---------------------------------------------------------------- SEC-1 ----

test('SEC-1: putFile coerces svg/scriptable uploads away from any inline type', () => {
  const ctx = sysCtx(orgA);
  // attacker uploads svg bytes but labels them image/png (the portal path)
  const asPng = putFile(ctx, SVG_XSS, { name: 'evil.png', mime: 'image/png' });
  assert.equal(asPng.mime, 'application/octet-stream', 'svg bytes never stored as an inline image type');
  assert.equal(canServeInline(asPng, SVG_XSS), false, 'never inline-servable');
  // …or labels them honestly as svg — svg is not in the allowlist either
  const asSvg = putFile(ctx, SVG_XSS, { name: 'evil.svg', mime: 'image/svg+xml' });
  assert.equal(asSvg.mime, 'application/octet-stream');
  assert.equal(canServeInline(asSvg, SVG_XSS), false);
});

test('SEC-1: sniffMime flags scriptable markup; legit uploads keep their type', () => {
  assert.equal(sniffMime(SVG_XSS), 'image/svg+xml');
  assert.equal(sniffMime(Buffer.from('<!DOCTYPE html><script>x()</script>')), 'text/html');
  assert.equal(sniffMime(Buffer.from('<?xml version="1.0"?><svg/>')), 'image/svg+xml');
  assert.equal(sniffMime(PNG_BYTES), 'image/png');
  assert.equal(sniffMime(Buffer.from('%PDF-1.7\n%â')), 'application/pdf');
  // legitimate uploads are preserved (no false positives that break real files)
  assert.equal(safeMime('image/png', PNG_BYTES), 'image/png');
  assert.equal(safeMime('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(safeMime('text/csv', Buffer.from('name,balance\nA,100')), 'text/csv');
  assert.equal(
    safeMime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Buffer.from([0x50, 0x4b, 0x03, 0x04])),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
});

test('SEC-1: an uploaded svg downloads as an attachment at /f/:id, never inline', async () => {
  const ctx = sysCtx(orgA);
  const f = putFile(ctx, SVG_XSS, { name: 'x.svg', mime: 'image/svg+xml', visibility: 'staff' });
  const resp = await fetch(`${base}/f/${f.id}`, { headers: { cookie: cookieA } });
  assert.equal(resp.status, 200);
  assert.match(resp.headers.get('content-disposition') || '', /attachment/, 'forced download');
  assert.doesNotMatch(resp.headers.get('content-type') || '', /svg/, 'not served as image/svg+xml');
});

test('SEC-1: a genuine png is still served inline (no regression for real images)', async () => {
  const ctx = sysCtx(orgA);
  const f = putFile(ctx, PNG_BYTES, { name: 'ok.png', mime: 'image/png', visibility: 'staff' });
  assert.equal(f.mime, 'image/png');
  const resp = await fetch(`${base}/f/${f.id}`, { headers: { cookie: cookieA } });
  assert.equal(resp.status, 200);
  assert.match(resp.headers.get('content-disposition') || '', /inline/, 'real png still inlines');
});

// ---------------------------------------------------------------- SEC-2 ----

test('SEC-2: an inbound email body is HTML-escaped in the Message Console', async () => {
  const mid = id('msg');
  const payload = '<script>alert(document.cookie)</script>';
  insert('outbox_messages', {
    id: mid, org_id: orgA, channel: 'email', direction: 'in',
    to_addr: 'lead@public-intake.test', to_name: 'Prospect', subject: 'Interested in a unit',
    body: `Hello there ${payload}`, status: 'received', created_at: nowIso(),
  });
  const res = await get(base, `/dev/messages/${mid}`, cookieA);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /<script>alert\(document\.cookie\)<\/script>/, 'raw script tag must not reach the DOM');
  assert.match(res.text, /&lt;script&gt;alert\(document\.cookie\)&lt;\/script&gt;/, 'payload rendered as escaped text');
});

// ---------------------------------------------------------------- SEC-3 ----

test('SEC-3: snoozing/closing another org\'s thread returns 404 and mutates nothing', async () => {
  const tid = id('thr');
  insert('threads', {
    id: tid, org_id: orgB, person_kind: 'lead', person_id: id('led'),
    display_name: 'B Prospect', status: 'open', needs_reply: 0, created_at: nowIso(),
  });
  const snoozed = await post(base, `/inbox/${tid}/snooze`, {}, cookieA);
  assert.equal(snoozed.status, 404, 'cross-org snooze is a not-found');
  assert.equal(q1<any>('SELECT status FROM threads WHERE id=?', tid).status, 'open', 'thread untouched by snooze');
  assert.equal(q1<any>('SELECT snooze_until FROM threads WHERE id=?', tid).snooze_until, null, 'no snooze_until written');

  await post(base, `/inbox/${tid}/close`, {}, cookieA);
  assert.equal(q1<any>('SELECT status FROM threads WHERE id=?', tid).status, 'open', 'thread untouched by close');
});

// ---------------------------------------------------------------- SEC-4 ----

test('SEC-4: the generated param on /ai/essentials is reflected escaped, not raw', async () => {
  const payload = '<img src=x onerror=alert(1)>';
  const res = await get(base, `/ai/essentials?generated=${encodeURIComponent(payload)}`, cookieA);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /<img src=x onerror=alert\(1\)>/, 'payload not reflected as live HTML');
  assert.match(res.text, /&lt;img src=x onerror=alert\(1\)&gt;/, 'payload reflected as escaped text');
});
