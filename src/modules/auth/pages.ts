import { html, when, raw } from '../../lib/html.ts';
import {
  htmlRes, jsonRes, redirect, notFound, forbidden, cookie,
  type Router, type Rq, takeFlash,
} from '../../lib/http.ts';
import {
  verifyPassword, createSession, destroySession, setSessionCookie, clearSessionCookie,
  getSessionToken, attachSession, requireUser, requirePerm, rateLimit,
  type UserRow, type Ctx, canAccessProperty,
} from '../../lib/auth.ts';
import { q, q1, run } from '../../lib/db.ts';
import { nowIso } from '../../lib/dates.ts';
import { audit } from '../../lib/audit.ts';
import { authShell, logo, wordmark, runSearch, shell, card, dl } from '../../ui/ui.ts';
import { ROLE_LABELS, type Role } from '../../lib/rbac.ts';
import { env } from '../../lib/env.ts';
import { signupRoutes } from './signup.ts';

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
        <div class="auth-sub">Property management, run by AI.</div>
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
    if (!rateLimit(`login:${rq.ip}`, 20, 60000)) {
      return redirect('/login', 'Too many attempts — wait a minute and try again.', 'err');
    }
    const email = String(rq.body.email || '').trim().toLowerCase();
    const password = String(rq.body.password || '');
    const user = q1<UserRow>('SELECT * FROM users WHERE email=? AND active=1', email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return redirect('/login', 'Invalid email or password.', 'err');
    }
    const t = createSession(user.id);
    setSessionCookie(rq, t);
    run('UPDATE users SET last_login_at=? WHERE id=?', nowIso(), user.id);
    const next = String(rq.body.next || '');
    return redirect(next && next.startsWith('/') && !next.startsWith('//') ? next : landingFor(user));
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
      content: card(
        'Account',
        dl([
          ['Name', ctx.userName],
          ['Email', ctx.userEmail],
          ['Roles', grants.length ? grants.map((g) => ROLE_LABELS[g.role] ?? g.role).join(', ') : ctx.kind],
          ['Access', ctx.allProperties ? 'All properties' : `${ctx.propertyIds.length} propert${ctx.propertyIds.length === 1 ? 'y' : 'ies'}`],
        ]),
      ),
    });
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
