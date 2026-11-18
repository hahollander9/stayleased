import { html, when, raw } from '../../lib/html.ts';
import {
  htmlRes, jsonRes, redirect, notFound, forbidden, cookie,
  type Router, type Rq, takeFlash,
  localPath,
} from '../../lib/http.ts';
import {
  verifyPassword, hashPassword, tokenHash, dummyVerify, createSession, destroySession, setSessionCookie, clearSessionCookie,
  getSessionToken, attachSession, requireUser, requirePerm, rateLimit, rateLimited, rateStrike, rateClear,
  type UserRow, type Ctx, canAccessProperty,
} from '../../lib/auth.ts';
import { q, q1, run } from '../../lib/db.ts';
import { nowIso } from '../../lib/dates.ts';
import { audit } from '../../lib/audit.ts';
import { authShell, logo, wordmark, runSearch, shell, card, dl } from '../../ui/ui.ts';
import { ROLE_LABELS, type Role } from '../../lib/rbac.ts';
import { env } from '../../lib/env.ts';
import { signupRoutes } from './signup.ts';

/** The demo cast (admin@summitridge.demo and friends) is a set of published,
 * shared sign-ins: letting one visitor change one would lock the demo for
 * everyone after them. The platform operator's account is not part of the
 * cast, whatever its address ends in. */
function sharedDemoLogin(rq: Rq): boolean {
  const ctx = rq.ctx as Ctx;
  const u = rq.user as UserRow;
  return ctx.orgKind !== 'live' && u.kind !== 'platform' && String(u.email).endsWith('.demo');
}

export function routes(r: Router): void {
  signupRoutes(r);
  r.get('/login', (rq) => {
    if (rq.user) return redirect(landingFor(rq.user as UserRow));
    const flash = takeFlash(rq);
    const personas = env('MODE') !== 'production'
      ? q<{ email: string; name: string; role: string }>(
          `SELECT u.email, u.name, COALESCE(ra.role, u.kind) AS role FROM users u
           LEFT JOIN role_assignments ra ON ra.user_id = u.id
           WHERE u.active=1 AND u.email LIKE '%@summitridge.demo' GROUP BY u.id ORDER BY u.created_at LIMIT 14`,
        )
      : [];
    return authShell(
      'Sign in',
      html`
        <a class="auth-back" href="/">← Back to home</a>
        <div class="auth-brand">${wordmark(28)}</div>
        <div class="auth-sub">Property management that does the work.</div>
        ${when(flash, () => html`<div class="flash ${flash![0]}">${flash![1]}</div>`)}
        <form method="post" action="/login">
          <input type="hidden" name="next" value="${rq.query.get('next') || ''}" />
          <div class="field"><label>Email</label><input name="email" type="email" required autofocus /></div>
          <div class="field"><label>Password</label><input name="password" type="password" required /></div>
          <button class="btn" style="width:100%;justify-content:center">Sign in</button>
        </form>
        ${when(!!env('SIGNUP_CODE'), () => html`<p class="small muted" style="margin-top:12px;text-align:center">New to StayLeased? <a href="/signup">Create your company</a></p>`)}
        ${when(personas.length, () => html`
          <details class="demo-personas">
            <summary class="dp-head">Explore the demo — choose a role to sign in</summary>
            <div class="chips">
              ${personas.map((p) => html`<button type="button" class="chip" data-email="${p.email}" data-password="demo1234">${p.name} · ${ROLE_LABELS[p.role as Role] ?? p.role}</button>`)}
            </div>
          </details>`)}
      `,
    );
  });

  r.post('/login', (rq) => {
    const email = String(rq.body.email || '').trim().toLowerCase();
    const password = String(rq.body.password || '');
    // rate-limit on real client IP (see clientIp/X-Forwarded-For) AND email, so a
    // single shared proxy IP can't exhaust one global bucket and lock everyone out
    if (!rateLimit(`login:${rq.ip}:${email}`, 20, 60000)) {
      return redirect('/login', 'Too many attempts — wait a minute and try again.', 'err');
    }
    // and on the account alone, counting failed attempts only: the address
    // above comes from a header a caller can forge, so the per-IP bucket was
    // unlimited guesses for anyone who rotated it. Thirty wrong passwords in
    // fifteen minutes pauses that account; a correct sign-in clears the count.
    // The shared demo logins are exempt — they are public.
    const acct = `login-acct:${email}`;
    const guarded = !email.endsWith('.demo');
    if (guarded && rateLimited(acct, 30)) {
      return redirect('/login', 'Too many wrong passwords on this account — wait fifteen minutes and try again.', 'err');
    }
    const user = q1<UserRow>('SELECT * FROM users WHERE email=? AND active=1', email);
    if (!user) {
      dummyVerify(); // equalize timing so a missing email can't be distinguished from a wrong password
      return redirect('/login', 'Invalid email or password.', 'err');
    }
    if (!verifyPassword(password, user.password_hash)) {
      if (guarded) rateStrike(acct, 15 * 60000);
      return redirect('/login', 'Invalid email or password.', 'err');
    }
    rateClear(acct);
    const t = createSession(user.id);
    setSessionCookie(rq, t);
    run('UPDATE users SET last_login_at=? WHERE id=?', nowIso(), user.id);
    const next = String(rq.body.next || '');
    return redirect(localPath(next, landingFor(user)));
  });

  r.post('/logout', (rq) => {
    const t = getSessionToken(rq);
    if (t) destroySession(t);
    clearSessionCookie(rq);
    return redirect('/login', 'Signed out.');
  });

  r.post('/switch-property', requireUser, (rq) => {
    const pid = String(rq.body.property_id || 'all');
    const ctx = rq.ctx as Ctx;
    if (pid !== 'all' && !canAccessProperty(ctx, pid)) return forbidden();
    rq.setCookies.push(cookie('sl_prop', pid === 'all' ? '' : pid, { maxAge: 30 * 86400, httpOnly: false }));
    const ref = String(rq.raw.headers.referer || '/');
    return redirect(ref.startsWith('http') ? new URL(ref).pathname : '/');
  });

  r.get('/me', requireUser, (rq) => {
    const ctx = rq.ctx as Ctx;
    const grants = q<{ role: Role; scope_type: string; property_ids: string }>(
      'SELECT role, scope_type, property_ids FROM role_assignments WHERE user_id=?', ctx.userId,
    );
    return shell(rq, {
      title: 'My profile',
      active: '/me',
      content: html`${card(
        'Account',
        dl([
          ['Name', ctx.userName],
          ['Email', ctx.userEmail],
          ['Roles', grants.length ? grants.map((g) => ROLE_LABELS[g.role] ?? g.role).join(', ') : ctx.kind],
          ['Access', ctx.allProperties ? 'All properties' : `${ctx.propertyIds.length} propert${ctx.propertyIds.length === 1 ? 'y' : 'ies'}`],
        ]),
      )}
      ${card('Password', sharedDemoLogin(rq)
        ? html`<p class="muted" style="margin:0">This is a shared demo sign-in, so its password stays as published. Accounts in a real organization change theirs here.</p>`
        : html`<form method="post" action="/me/password" style="max-width:420px" autocomplete="off">
            <div class="field"><label>Current password</label><input name="current" type="password" required autocomplete="current-password" /></div>
            <div class="field"><label>New password</label><input name="password" type="password" required minlength="10" autocomplete="new-password" /><div class="hint">At least 10 characters.</div></div>
            <div class="field"><label>Confirm new password</label><input name="password2" type="password" required minlength="10" autocomplete="new-password" /></div>
            <button class="btn">Change password</button>
            <p class="small muted" style="margin:10px 0 0">Changing it signs this account out everywhere else.</p>
          </form>`)}`,
    });
  });

  // Until this existed, nobody could change a password: the owner who signed
  // up kept the one they typed forever, staff kept the temporary one an admin
  // read out to them, and the platform account kept the one printed in the
  // demo-logins file.
  r.post('/me/password', requireUser, (rq) => {
    const ctx = rq.ctx as Ctx;
    if (sharedDemoLogin(rq)) return forbidden('The shared demo sign-ins keep their published password.');
    if (!rateLimit(`pwchange:${ctx.userId}`, 8, 15 * 60000)) return redirect('/me', 'Too many attempts — wait fifteen minutes and try again.', 'err');
    const user = q1<UserRow>('SELECT * FROM users WHERE id=? AND active=1', ctx.userId);
    const next = String(rq.body.password || '');
    if (!user || !verifyPassword(String(rq.body.current || ''), user.password_hash)) return redirect('/me', 'The current password is not right.', 'err');
    if (next.length < 10) return redirect('/me', 'The new password needs at least 10 characters.', 'err');
    if (next !== String(rq.body.password2 || '')) return redirect('/me', 'The two new passwords do not match.', 'err');
    if (next === String(rq.body.current || '') || next.toLowerCase() === 'demo1234') return redirect('/me', 'Choose a password that is not the old one.', 'err');
    run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(next), user.id);
    const mine = getSessionToken(rq);
    run('DELETE FROM sessions WHERE user_id=? AND token_hash<>?', user.id, mine ? tokenHash(mine) : '');
    if (user.org_id) audit(ctx, 'user', user.id, 'password_changed');
    return redirect('/me', 'Password changed. Other sessions for this account have been signed out.');
  });

  // impersonation (admins; bannered + audited)
  r.post('/admin/impersonate/:userId', requirePerm('admin:impersonate'), (rq) => {
    const target = q1<UserRow>('SELECT * FROM users WHERE id=? AND active=1', rq.params.userId!);
    const ctx = rq.ctx as Ctx;
    if (!target || (target.org_id !== ctx.orgId && ctx.kind !== 'platform')) return notFound('User not found');
    const t = createSession(target.id, ctx.userId);
    // keep admin session in a backup cookie to restore later
    const cur = getSessionToken(rq);
    if (cur) rq.setCookies.push(cookie('sl_admin', cur, { maxAge: 86400 }));
    setSessionCookie(rq, t);
    audit(ctx, 'user', target.id, 'impersonate_start');
    return redirect(landingFor(target), `Now viewing as ${target.name}.`);
  });

  r.get('/unimpersonate', (rq) => {
    const backup = rq.cookies['sl_admin'];
    const cur = getSessionToken(rq);
    if (cur) destroySession(cur);
    if (backup) {
      setSessionCookie(rq, backup);
      rq.setCookies.push(cookie('sl_admin', '', { expire: true }));
      return redirect('/', 'Back to your own account.');
    }
    clearSessionCookie(rq);
    return redirect('/login');
  });

  // global search (⌘K backend)
  r.get('/search.json', requireUser, (rq) => {
    const ctx = rq.ctx as Ctx;
    const query = (rq.query.get('q') || '').trim();
    if (query.length < 2) return jsonRes({ results: [] });
    return jsonRes({ results: runSearch(ctx, query) });
  });
}

export function landingFor(user: UserRow): string {
  switch (user.kind) {
    case 'resident': return '/portal';
    case 'vendor': return '/vendor';
    case 'applicant': return '/portal/apply';
    case 'guarantor': return '/portal';
    case 'platform': return '/admin/orgs';
    default: {
      // a live org with nothing in it yet lands on guided onboarding
      if (user.org_id) {
        const org = q1<{ kind: string }>('SELECT kind FROM orgs WHERE id=?', user.org_id);
        if (org?.kind === 'live' && !q1('SELECT id FROM properties WHERE org_id=? LIMIT 1', user.org_id)) return '/welcome';
      }
      return '/';
    }
  }
}
