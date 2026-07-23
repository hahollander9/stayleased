import { html, when } from '../../lib/html.ts';
import { redirect, type Router, type Rq, type Res, takeFlash } from '../../lib/http.ts';
import {
  hashPassword, createSession, setSessionCookie, rateLimit, buildCtx, type UserRow,
} from '../../lib/auth.ts';
import { q1, insert, tx } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso } from '../../lib/dates.ts';
import { audit } from '../../lib/audit.ts';
import { emit } from '../../lib/events.ts';
import { ensureJobRows, liveToday } from '../../lib/jobs.ts';
import { authShell, wordmark } from '../../ui/ui.ts';
import { env } from '../../lib/env.ts';

/** Public signup — the front door of the working model. A new customer
 * creates their own LIVE organization (empty portfolio, real calendar,
 * standard chart of accounts) and lands in guided onboarding. Gated by an
 * invite code (STAYLEASED_SIGNUP_CODE) so the operator controls who gets in;
 * with no code configured, signup is closed and the page says so. */

function signupEnabled(): boolean {
  return !!env('SIGNUP_CODE');
}

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function uniqueSlug(base: string): string {
  let slug = slugify(base) || 'company';
  if (!q1('SELECT id FROM orgs WHERE slug=?', slug)) return slug;
  for (let i = 2; i < 1000; i++) {
    const c = `${slug}-${i}`;
    if (!q1('SELECT id FROM orgs WHERE slug=?', c)) return c;
  }
  return `${slug}-${Date.now() % 100000}`;
}

function signupPage(rq: Rq, errs: string[] = [], b: Record<string, any> = {}): Res {
  const flash = takeFlash(rq);
  const val = (k: string): string => String(b[k] ?? '').replace(/"/g, '&quot;');
  return authShell(
    'Create your company',
    html`
      <div class="auth-brand">${wordmark(28)}</div>
      <div class="auth-sub">Set up your company on StayLeased.</div>
      ${when(flash, () => html`<div class="flash ${flash![0]}">${flash![1]}</div>`)}
      ${when(errs.length, () => html`<div class="flash err">${errs.join(' ')}</div>`)}
      ${signupEnabled()
        ? html`
          <form method="post" action="/signup">
            <div class="field"><label>Invite code</label><input name="code" required autofocus value="${val('code')}" /></div>
            <div class="field"><label>Company name</label><input name="company" required placeholder="Acme Residential LLC" value="${val('company')}" /></div>
            <div class="field"><label>Your name</label><input name="name" required value="${val('name')}" /></div>
            <div class="field"><label>Work email</label><input name="email" type="email" required value="${val('email')}" /></div>
            <div class="field"><label>Password</label><input name="password" type="password" required minlength="8" placeholder="At least 8 characters" /></div>
            <div class="field"><label>Confirm password</label><input name="password2" type="password" required /></div>
            <button class="btn" style="width:100%;justify-content:center">Create company</button>
          </form>
          <p class="small muted" style="margin-top:12px">You'll get an empty portfolio with the standard multifamily chart of accounts, ready to import your properties, residents, and balances — no simulated data.</p>`
        : html`<p>StayLeased is currently invite-only. If you'd like access for your portfolio, reach out and we'll set you up with an invite code.</p>`}
      <p class="small muted" style="margin-top:10px">Already have an account? <a href="/login">Sign in</a></p>
    `,
  );
}

export function signupRoutes(r: Router): void {
  r.get('/signup', (rq) => {
    if (rq.user) return redirect('/');
    return signupPage(rq);
  });

  r.post('/signup', (rq) => {
    if (!rateLimit(`signup:${rq.ip}`, 10, 60000)) {
      return redirect('/signup', 'Too many attempts — wait a minute and try again.', 'err');
    }
    if (!signupEnabled()) return signupPage(rq, ['Signup is currently closed.']);
    const b = rq.body;
    const errs: string[] = [];
    const code = String(b.code || '').trim();
    const company = String(b.company || '').trim();
    const name = String(b.name || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    if (code !== env('SIGNUP_CODE')) errs.push('That invite code is not valid.');
    if (company.length < 2) errs.push('Company name is required.');
    if (name.length < 2) errs.push('Your name is required.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errs.push('Enter a valid email address.');
    else if (q1('SELECT id FROM users WHERE email=?', email)) errs.push('An account with that email already exists — sign in instead.');
    if (password.length < 8) errs.push('Password must be at least 8 characters.');
    if (password !== String(b.password2 || '')) errs.push('Passwords do not match.');
    if (errs.length) return signupPage(rq, errs, { code, company, name, email });

    const orgId = id('org');
    const uid = id('usr');
    tx(() => {
      insert('orgs', {
        id: orgId, name: company, slug: uniqueSlug(company),
        business_date: liveToday(), kind: 'live', created_at: nowIso(),
      });
      insert('users', {
        id: uid, org_id: orgId, email, name,
        kind: 'staff', password_hash: hashPassword(password), active: 1, created_at: nowIso(),
      });
      insert('role_assignments', {
        id: id('ra'), org_id: orgId, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso(),
      });
    });
    const user = q1<UserRow>('SELECT * FROM users WHERE id=?', uid)!;
    const ctx = buildCtx(user, null, null);
    // standard chart of accounts + lease templates hang off this event
    emit(ctx, 'org.created', 'org', orgId, { name: company, self_signup: true });
    ensureJobRows(orgId); // live org: simulator feeds stay disabled
    audit(ctx, 'org', orgId, 'self_signup', null, { company, email });

    const t = createSession(uid);
    setSessionCookie(rq, t);
    return redirect('/welcome', `Welcome to StayLeased, ${name.split(' ')[0]}!`);
  });
}
