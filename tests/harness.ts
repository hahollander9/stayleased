import { db, q1, insert, ROOT } from '../src/lib/db.ts';
import { id, token } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { hashPassword } from '../src/lib/auth.ts';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Shared test fixtures + HTTP helpers. Tests run against ORIEL_DB=data/test.db
 * (wiped per run by scripts/test.sh). */

export interface TwoOrgs {
  orgA: string;
  orgB: string;
  propA: string;
  propB: string;
  adminA: string; // email
  adminB: string;
  apiKeyA: string;
  apiKeyB: string;
  fileA: string;
  userAId: string;
  userBId: string;
}

export function fixtureTwoOrgs(): TwoOrgs {
  db();
  const existing = q1<{ id: string }>('SELECT id FROM orgs WHERE slug=?', 'iso-a');
  if (existing) {
    const orgA = existing.id;
    const orgB = q1<{ id: string }>('SELECT id FROM orgs WHERE slug=?', 'iso-b')!.id;
    return {
      orgA, orgB,
      propA: q1<{ id: string }>('SELECT id FROM properties WHERE org_id=?', orgA)!.id,
      propB: q1<{ id: string }>('SELECT id FROM properties WHERE org_id=?', orgB)!.id,
      adminA: 'admin@iso-a.test', adminB: 'admin@iso-b.test',
      apiKeyA: (globalThis as any).__keyA, apiKeyB: (globalThis as any).__keyB,
      fileA: q1<{ id: string }>('SELECT id FROM files WHERE org_id=?', orgA)!.id,
      userAId: q1<{ id: string }>('SELECT id FROM users WHERE email=?', 'admin@iso-a.test')!.id,
      userBId: q1<{ id: string }>('SELECT id FROM users WHERE email=?', 'admin@iso-b.test')!.id,
    };
  }
  const mk = (slug: string): { org: string; prop: string; userId: string; key: string } => {
    const org = id('org');
    insert('orgs', { id: org, name: `Org ${slug}`, slug, business_date: '2026-07-26', created_at: nowIso() });
    const uid = id('usr');
    insert('users', {
      id: uid, org_id: org, email: `admin@${slug}.test`, name: `Admin ${slug}`,
      kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
    });
    insert('role_assignments', { id: id('ra'), org_id: org, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
    const prop = id('prp');
    insert('properties', {
      id: prop, org_id: org, name: `Prop ${slug}`, slug: `prop-${slug}`, type: 'multifamily',
      address1: '1 Test St', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso(),
    });
    const key = 'ok_' + token(24);
    insert('api_keys', {
      id: id('key'), org_id: org, name: 'test', prefix: key.slice(0, 10),
      key_hash: createHash('sha256').update(key).digest('hex'), active: 1, created_at: nowIso(),
    });
    return { org, prop, userId: uid, key };
  };
  const a = mk('iso-a');
  const b = mk('iso-b');
  (globalThis as any).__keyA = a.key;
  (globalThis as any).__keyB = b.key;
  // a file owned by org A
  const fid = id('fil');
  insert('files', {
    id: fid, org_id: a.org, name: 'secret-a.txt', mime: 'text/plain', size: 3, sha256: 'x',
    entity: null, entity_id: null, visibility: 'staff', owner_user_id: null, created_by: a.userId, created_at: nowIso(),
  });
  mkdirSync(join(ROOT, 'data', 'files'), { recursive: true });
  writeFileSync(join(ROOT, 'data', 'files', fid + '.bin'), 'AAA');
  return {
    orgA: a.org, orgB: b.org, propA: a.prop, propB: b.prop,
    adminA: 'admin@iso-a.test', adminB: 'admin@iso-b.test',
    apiKeyA: a.key, apiKeyB: b.key, fileA: fid, userAId: a.userId, userBId: b.userId,
  };
}

// ---------- live server ----------

export async function startTestServer(): Promise<{ base: string; close: () => void }> {
  const { startServer } = await import('../src/server/main.ts');
  const app = startServer(0);
  const base: string = await new Promise((resolve) => {
    const tick = (): void => {
      const addr = app.address();
      if (addr && typeof addr === 'object') resolve(`http://127.0.0.1:${addr.port}`);
      else setTimeout(tick, 20);
    };
    tick();
  });
  return { base, close: () => app.close() };
}

export async function loginAs(base: string, email: string, password = 'demo1234'): Promise<string> {
  const resp = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ email, password }).toString(),
    redirect: 'manual',
  });
  const setCookie = resp.headers.get('set-cookie') || '';
  const m = /oriel_s=([^;]+)/.exec(setCookie);
  if (!m) throw new Error(`login failed for ${email}: ${resp.status} ${setCookie}`);
  return `oriel_s=${m[1]}`;
}

export async function get(base: string, path: string, cookie?: string): Promise<{ status: number; text: string }> {
  const resp = await fetch(base + path, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
  return { status: resp.status, text: await resp.text() };
}

export async function post(
  base: string,
  path: string,
  body: Record<string, string>,
  cookie?: string,
): Promise<{ status: number; text: string; location: string | null }> {
  const resp = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(body).toString(),
    redirect: 'manual',
  });
  return { status: resp.status, text: await resp.text(), location: resp.headers.get('location') };
}

// ---------- finance fixture (Phase 2+) ----------

import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';

export interface FinanceFx {
  orgId: string;
  propId: string;
  unitId: string;
  leaseId: string;
}

let financeFx: FinanceFx | null = null;

/** small org with COA, one property/unit, one active lease with rent+pet schedule */
export function fixtureFinance(): FinanceFx {
  if (financeFx) return financeFx;
  db();
  const orgId = id('org');
  insert('orgs', { id: orgId, name: 'Fin Org', slug: 'fin-' + orgId.slice(-6), business_date: '2026-07-26', created_at: nowIso() });
  ensureCoa(orgId);
  const propId = id('prp');
  insert('properties', {
    id: propId, org_id: orgId, name: 'Fin Prop', slug: 'fin-prop-' + orgId.slice(-6), type: 'multifamily',
    address1: '1 Fin St', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso(),
  });
  const unitId = id('unt');
  insert('units', {
    id: unitId, org_id: orgId, property_id: propId, unit_number: 'F-101', floor: 1, sqft: 800,
    status: 'occupied', market_rent_cents: 150000, amenities: '[]', created_at: nowIso(),
  });
  const leaseId = id('lse');
  insert('leases', {
    id: leaseId, org_id: orgId, property_id: propId, unit_id: unitId, household_name: 'Fin household',
    status: 'active', start_date: '2026-01-01', end_date: '2026-12-31', move_in_date: '2026-01-01',
    rent_cents: 150000, deposit_cents: 150000, term_months: 12, created_at: nowIso(),
  });
  insert('lease_charges', { id: id('lc'), org_id: orgId, lease_id: leaseId, kind: 'rent', label: 'Rent — F-101', amount_cents: 150000, created_at: nowIso() });
  insert('lease_charges', { id: id('lc'), org_id: orgId, lease_id: leaseId, kind: 'pet_rent', label: 'Pet rent', amount_cents: 3500, created_at: nowIso() });
  financeFx = { orgId, propId, unitId, leaseId };
  return financeFx;
}
