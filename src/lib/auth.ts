import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { q, q1, run, insert, j } from './db.ts';
import { id, token } from './ids.ts';
import { nowIso } from './dates.ts';
import { cookie, forbidden, redirect, type Middleware, type Rq, type Res } from './http.ts';
import { expandPerms, type Role } from './rbac.ts';

// ---------- passwords ----------

export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pw, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const test = scryptSync(pw, salt, 64);
  const ref = Buffer.from(hash, 'hex');
  return test.length === ref.length && timingSafeEqual(test, ref);
}

// ---------- sessions ----------

const SESSION_COOKIE = 'oriel_s';
const SESSION_DAYS = 7;

function tokenHash(t: string): string {
  return createHash('sha256').update(t).digest('hex');
}

export function createSession(userId: string, impersonatorId?: string): string {
  const t = token(32);
  insert('sessions', {
    id: id('ses'),
    user_id: userId,
    token_hash: tokenHash(t),
    impersonator_user_id: impersonatorId ?? null,
    expires_at: new Date(Date.now() + SESSION_DAYS * 86400000).toISOString(),
    created_at: nowIso(),
  });
  return t;
}

export function destroySession(t: string): void {
  run('DELETE FROM sessions WHERE token_hash=?', tokenHash(t));
}

export interface UserRow {
  id: string;
  org_id: string | null;
  email: string;
  name: string;
  phone: string | null;
  kind: string; // staff | resident | vendor | applicant | guarantor | platform
  active: number;
  password_hash: string;
  vendor_id?: string | null;
}

export interface Ctx {
  orgId: string;
  userId: string;
  userName: string;
  userEmail: string;
  kind: string;
  roles: Role[];
  perms: Set<string>;
  /** property ids this user's grants cover; allProperties=true means whole org */
  propertyIds: string[];
  allProperties: boolean;
  /** UI property switcher selection; null = all accessible */
  currentPropertyId: string | null;
  businessDate: string;
  impersonatorId: string | null;
  vendorId: string | null;
}

export function buildCtx(user: UserRow, currentPropertyId: string | null, impersonatorId: string | null): Ctx {
  const grants = q<{ role: Role; scope_type: string; property_ids: string }>(
    'SELECT role, scope_type, property_ids FROM role_assignments WHERE user_id=?',
    user.id,
  );
  const roles = grants.map((g) => g.role);
  if (user.kind === 'platform') roles.push('PLATFORM_ADMIN');
  if (user.kind === 'resident') roles.push('RESIDENT');
  if (user.kind === 'vendor') roles.push('VENDOR');
  const allProperties =
    user.kind === 'platform' || grants.some((g) => g.scope_type === 'org');
  const propertyIds = allProperties
    ? []
    : [...new Set(grants.flatMap((g) => j<string[]>(g.property_ids, [])))];
  const org = user.org_id
    ? q1<{ business_date: string }>('SELECT business_date FROM orgs WHERE id=?', user.org_id)
    : undefined;
  return {
    orgId: user.org_id || '',
    userId: user.id,
    userName: user.name,
    userEmail: user.email,
    kind: user.kind,
    roles: [...new Set(roles)] as Role[],
    perms: expandPerms([...new Set(roles)] as Role[]),
    propertyIds,
    allProperties,
    currentPropertyId,
    businessDate: org?.business_date || new Date().toISOString().slice(0, 10),
    impersonatorId,
    vendorId: (user as any).vendor_id ?? null,
  };
}

export function can(ctx: Ctx, perm: string): boolean {
  return ctx.perms.has(perm);
}

export function assertPerm(ctx: Ctx, perm: string): void {
  if (!can(ctx, perm)) throw new Error(`permission denied: ${perm}`);
}

/** Does this ctx have access to the given property? Always verifies the
 * property belongs to the ctx org — org isolation is checked here, not
 * trusted from role scope. */
export function canAccessProperty(ctx: Ctx, propertyId: string): boolean {
  const row = q1<{ org_id: string }>('SELECT org_id FROM properties WHERE id=?', propertyId);
  if (!row || row.org_id !== ctx.orgId) return false;
  return ctx.allProperties || ctx.propertyIds.includes(propertyId);
}

/** SQL fragment limiting property-scoped queries to accessible properties.
 * Usage: const pf = propFilter(ctx, 'p.id'); ...WHERE org_id=? ${pf.sql}...  */
export function propFilter(ctx: Ctx, col = 'property_id'): { sql: string; params: string[] } {
  // honor UI switcher first
  if (ctx.currentPropertyId) return { sql: ` AND ${col} = ?`, params: [ctx.currentPropertyId] };
  if (ctx.allProperties) return { sql: '', params: [] };
  if (!ctx.propertyIds.length) return { sql: ' AND 1=0', params: [] };
  return {
    sql: ` AND ${col} IN (${ctx.propertyIds.map(() => '?').join(',')})`,
    params: ctx.propertyIds,
  };
}

/** like propFilter but ignores the UI switcher (for org-wide jobs/reports) */
export function scopeFilter(ctx: Ctx, col = 'property_id'): { sql: string; params: string[] } {
  if (ctx.allProperties) return { sql: '', params: [] };
  if (!ctx.propertyIds.length) return { sql: ' AND 1=0', params: [] };
  return { sql: ` AND ${col} IN (${ctx.propertyIds.map(() => '?').join(',')})`, params: ctx.propertyIds };
}

/** system context for jobs/seed (full org access, no user) */
export function sysCtx(orgId: string, businessDate?: string): Ctx {
  const org = q1<{ business_date: string }>('SELECT business_date FROM orgs WHERE id=?', orgId);
  return {
    orgId,
    userId: 'system',
    userName: 'System',
    userEmail: 'system@oriel',
    kind: 'system',
    roles: [],
    perms: expandPerms(['ORG_ADMIN'] as Role[]),
    propertyIds: [],
    allProperties: true,
    currentPropertyId: null,
    businessDate: businessDate || org?.business_date || new Date().toISOString().slice(0, 10),
    impersonatorId: null,
    vendorId: null,
  };
}

// ---------- middleware ----------

/** attach session/user/ctx if a valid cookie exists (never blocks) */
export const attachSession: Middleware = (r) => {
  const t = r.cookies[SESSION_COOKIE];
  if (!t) return;
  const ses = q1<{ id: string; user_id: string; expires_at: string; impersonator_user_id: string | null }>(
    'SELECT * FROM sessions WHERE token_hash=?',
    tokenHash(t),
  );
  if (!ses || ses.expires_at < nowIso()) return;
  const user = q1<UserRow>('SELECT * FROM users WHERE id=? AND active=1', ses.user_id);
  if (!user) return;
  r.session = ses;
  r.user = user;
  const propCookie = r.cookies['oriel_prop'] || null;
  const ctx = buildCtx(user, null, ses.impersonator_user_id);
  // validate switcher cookie against accessible properties
  if (propCookie && propCookie !== 'all' && canAccessProperty(ctx, propCookie)) {
    ctx.currentPropertyId = propCookie;
  } else if (!ctx.allProperties && ctx.propertyIds.length === 1) {
    ctx.currentPropertyId = ctx.propertyIds[0]!;
  }
  r.ctx = ctx;
  return;
};

export function loginRedirect(r: Rq): Res {
  const next = encodeURIComponent(r.path + (r.url.search || ''));
  return redirect(`/login?next=${next}`);
}

export const requireUser: Middleware = (r) => {
  if (!r.user) return loginRedirect(r);
  return;
};

export const requireStaff: Middleware = (r) => {
  if (!r.user) return loginRedirect(r);
  const kind = (r.user as UserRow).kind;
  if (kind !== 'staff' && kind !== 'platform') return forbidden('Staff access only.');
  return;
};

export function requirePerm(perm: string): Middleware {
  return (r) => {
    if (!r.user) return loginRedirect(r);
    if (!r.ctx || !can(r.ctx as Ctx, perm)) return forbidden(`This requires the ${perm} permission.`);
    return;
  };
}

export const requireResident: Middleware = (r) => {
  if (!r.user) return loginRedirect(r);
  if ((r.user as UserRow).kind !== 'resident') return forbidden('Resident portal access only.');
  return;
};

export const requireVendor: Middleware = (r) => {
  if (!r.user) return loginRedirect(r);
  if ((r.user as UserRow).kind !== 'vendor') return forbidden('Vendor portal access only.');
  return;
};

export const devOnly: Middleware = (r) => {
  if (process.env.ORIEL_MODE === 'production') return forbidden('Not available in production mode.');
  if (!r.user) return loginRedirect(r);
  return;
};

// ---------- login rate limiting ----------

const attempts = new Map<string, { n: number; reset: number }>();

export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const cur = attempts.get(key);
  if (!cur || cur.reset < now) {
    attempts.set(key, { n: 1, reset: now + windowMs });
    return true;
  }
  cur.n++;
  return cur.n <= max;
}

export function setSessionCookie(r: Rq, t: string): void {
  r.setCookies.push(cookie(SESSION_COOKIE, t, { maxAge: SESSION_DAYS * 86400 }));
}
export function clearSessionCookie(r: Rq): void {
  r.setCookies.push(cookie(SESSION_COOKIE, '', { expire: true }));
}
export function getSessionToken(r: Rq): string | undefined {
  return r.cookies[SESSION_COOKIE];
}
