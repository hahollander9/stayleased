import { test } from 'node:test';
import assert from 'node:assert/strict';
import { log } from '../src/lib/log.ts';
import { cookie, redirect } from '../src/lib/http.ts';
import { PermError, assertPerm, type Ctx } from '../src/lib/auth.ts';
import { setEnv } from '../src/lib/env.ts';
import { startTestServer } from './harness.ts';

/** Regression cover for the security + reliability plumbing fixes (CODE-2
 * logger, SEC-5 Secure cookies, SEC-6 CSP/nonce, CODE-5 PermError). Hermetic:
 * env toggles are always restored so the shared test process stays on MODE=test. */

// ---------- helpers ----------

function restoreEnv(name: string, val: string | undefined): void {
  if (val === undefined) delete process.env[`STAYLEASED_${name}`];
  else process.env[`STAYLEASED_${name}`] = val;
}

/** capture console.log/console.error emitted while fn runs, then restore */
function captureConsole(fn: () => void): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]): void => { out.push(a.join(' ')); };
  console.error = (...a: unknown[]): void => { err.push(a.join(' ')); };
  try {
    fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { out, err };
}

// ---------- CODE-2: logger ----------

test('log: dev is pretty single-line, LOG_LEVEL gates, fields render, streams split', () => {
  const savedMode = process.env.STAYLEASED_MODE;
  const savedLevel = process.env.STAYLEASED_LOG_LEVEL;
  try {
    setEnv('MODE', 'development'); // anything non-production → pretty
    setEnv('LOG_LEVEL', 'info');
    const cap = captureConsole(() => {
      log.debug('below the threshold');
      log.info('hello', { orgId: 'org_1' });
      log.warn('careful');
    });
    // debug suppressed at the info threshold
    assert.equal(cap.out.some((l) => l.includes('below the threshold')), false);
    // info → stdout, pretty (not JSON), with the field rendered k=v
    const info = cap.out.find((l) => l.includes('hello'));
    assert.ok(info, 'info went to stdout');
    assert.match(info!, /INFO/);
    assert.match(info!, /orgId=org_1/);
    assert.doesNotMatch(info!, /^\{/); // pretty, not a JSON object
    // warn → stderr
    assert.ok(cap.err.some((l) => l.includes('careful') && l.includes('WARN')), 'warn to stderr');
  } finally {
    restoreEnv('MODE', savedMode);
    restoreEnv('LOG_LEVEL', savedLevel);
  }
});

test('log: production emits one JSON line; error keeps err.message + stack', () => {
  const savedMode = process.env.STAYLEASED_MODE;
  try {
    setEnv('MODE', 'production');
    const cap = captureConsole(() => {
      log.error('boom', new Error('kaboom'), { orgId: 'org_9' });
    });
    assert.equal(cap.err.length, 1, 'exactly one line to stderr');
    const rec = JSON.parse(cap.err[0]!) as Record<string, unknown>;
    assert.equal(rec.level, 'error');
    assert.equal(rec.msg, 'boom');
    assert.equal(rec.err, 'kaboom'); // err.message always
    assert.equal(rec.orgId, 'org_9'); // caller fields merged in
    assert.ok(typeof rec.time === 'string' && rec.time.length > 0, 'timestamped');
    assert.ok(typeof rec.stack === 'string' && (rec.stack as string).includes('kaboom'),
      'stack retained at error level even in production');
  } finally {
    restoreEnv('MODE', savedMode);
  }
});

// ---------- SEC-5: Secure cookie gating ----------

test('cookie: Secure attribute only in production, HttpOnly/SameSite always', () => {
  const savedMode = process.env.STAYLEASED_MODE;
  try {
    setEnv('MODE', 'production');
    const prod = cookie('sl_s', 'tok', { maxAge: 100 });
    assert.match(prod, /; Secure/, 'Secure set in production');
    assert.match(prod, /HttpOnly/);
    assert.match(prod, /SameSite=Lax/);
    // flash cookie built inline in redirect() is also gated on MODE
    const flash = redirect('/x', 'hello', 'err').headers['set-cookie'] as string[];
    assert.match(flash[0]!, /; Secure/, 'flash cookie Secure in production');

    setEnv('MODE', 'test');
    const dev = cookie('sl_s', 'tok', { maxAge: 100 });
    assert.doesNotMatch(dev, /Secure/, 'no Secure in dev so http://localhost works');
  } finally {
    restoreEnv('MODE', savedMode);
  }
});

// ---------- CODE-5: PermError is user-safe ----------

test('PermError: user-safe message, perm code on a property, thrown by assertPerm', () => {
  const e = new PermError('gl:close_period');
  assert.equal(e.message, "You don't have permission to do that.");
  assert.equal(e.perm, 'gl:close_period', 'internal code available for logging');
  assert.doesNotMatch(e.message, /gl:close_period/, 'never leaks the perm code to users');
  assert.ok(e instanceof Error);

  // assertPerm on a ctx without the perm throws the user-safe PermError
  const ctx = { perms: new Set<string>() } as unknown as Ctx;
  let caught: unknown;
  try {
    assertPerm(ctx, 'gl:close_period');
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof PermError, 'assertPerm throws PermError');
  assert.equal((caught as PermError).perm, 'gl:close_period');
  assert.equal((caught as PermError).message, "You don't have permission to do that.");
});

// ---------- SEC-6: CSP header + nonce injection ----------

test('CSP: HTML responses carry a nonce header and every <script gets that nonce', async () => {
  const srv = await startTestServer();
  try {
    const resp = await fetch(`${srv.base}/login`);
    assert.equal(resp.status, 200);
    const csp = resp.headers.get('content-security-policy');
    assert.ok(csp, 'CSP header present on HTML response');
    assert.match(csp!, /default-src 'self'/);
    assert.match(csp!, /script-src 'self' 'nonce-/);
    assert.match(csp!, /style-src 'self' 'unsafe-inline'/);
    assert.match(csp!, /img-src 'self' data: blob: https:/); // Leaflet tiles ride https:
    assert.match(csp!, /object-src 'none'/);
    assert.match(csp!, /base-uri 'none'/);
    assert.match(csp!, /frame-ancestors 'none'/);

    const m = /'nonce-([^']+)'/.exec(csp!);
    assert.ok(m, 'nonce present in the CSP header');
    const nonce = m![1]!;
    const body = await resp.text();
    // the login page has an inline theme-boot script AND an external app.js —
    // both must carry this response's nonce, and no bare <script> may survive.
    assert.ok(body.includes(`<script nonce="${nonce}"`), 'scripts carry the response nonce');
    assert.equal(body.includes('<script>'), false, 'no un-nonced inline <script> remains');
    assert.equal(body.includes('<script src='), false, 'external <script src> also nonced');

    // a distinct HTML response must mint a distinct nonce
    const resp2 = await fetch(`${srv.base}/login`);
    const csp2 = resp2.headers.get('content-security-policy');
    assert.notEqual(csp, csp2, 'nonce is per-response, not reused');

    // non-HTML responses are left untouched (no CSP on a static asset)
    const css = await fetch(`${srv.base}/assets/theme.css`);
    assert.equal(css.headers.get('content-security-policy'), null, 'no CSP on non-HTML');
  } finally {
    srv.close();
  }
});
