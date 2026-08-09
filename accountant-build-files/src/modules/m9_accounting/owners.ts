import { q, q1, insert, run } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, addMonths, firstOfMonth } from '../../lib/dates.ts';
import type { Ctx } from '../../lib/auth.ts';
import { assertPerm } from '../../lib/auth.ts';
import { audit } from '../../lib/audit.ts';
import { incomeStatement, type Basis } from './statements.ts';
import { accountBalance } from './service.ts';
import { RESERVE_GL } from './reserves.ts';

/** M9.10 — owner entities + owner statements (accountant-feedback build).
 *
 * Owners and ownership percentages are reporting dimensions, not money
 * movement: an owner statement is the owner's share of each property's
 * operating result (equity income) plus their share of capital activity
 * (3020) and reserve balances, consolidated across everything they hold.
 * The GL itself never changes shape — statements scale by percentage at
 * read time, so the books stay one set of books. */

export interface OwnerInput { name: string; kind?: 'individual' | 'entity'; email?: string; phone?: string; notes?: string }

export function createOwner(ctx: Ctx, input: OwnerInput): string {
  assertPerm(ctx, 'owners:manage');
  if (!input.name.trim()) throw new Error('owner needs a name');
  const oid = id('own');
  insert('owners', {
    id: oid, org_id: ctx.orgId, name: input.name.trim().slice(0, 120),
    kind: input.kind === 'entity' ? 'entity' : 'individual',
    email: input.email || null, phone: input.phone || null, notes: input.notes || null,
    active: 1, created_at: nowIso(),
  });
  audit(ctx, 'owner', oid, 'create', null, { name: input.name });
  return oid;
}

/** Set (or remove, with pct <= 0) one owner's percentage of one property.
 * Total assigned ownership of a property can never exceed 100%. */
export function setOwnershipShare(ctx: Ctx, input: { ownerId: string; propertyId: string; pct: number }): void {
  assertPerm(ctx, 'owners:manage');
  const owner = q1<any>('SELECT id FROM owners WHERE id=? AND org_id=?', input.ownerId, ctx.orgId);
  if (!owner) throw new Error('owner not found');
  const prop = q1<any>('SELECT id FROM properties WHERE id=? AND org_id=?', input.propertyId, ctx.orgId);
  if (!prop) throw new Error('property not found');
  const pct = Math.round(input.pct * 100) / 100;
  const existing = q1<any>('SELECT id FROM property_owners WHERE owner_id=? AND property_id=?', input.ownerId, input.propertyId);
  if (pct <= 0) {
    if (existing) {
      run('DELETE FROM property_owners WHERE id=?', existing.id);
      audit(ctx, 'property_owner', existing.id as string, 'remove');
    }
    return;
  }
  const others = q<any>(
    'SELECT pct FROM property_owners WHERE org_id=? AND property_id=? AND owner_id != ?',
    ctx.orgId, input.propertyId, input.ownerId,
  ).reduce((s, r) => s + (r.pct as number), 0);
  if (others + pct > 100.0001) throw new Error(`ownership would exceed 100% — ${others}% is already assigned to other owners`);
  if (existing) {
    run('UPDATE property_owners SET pct=? WHERE id=?', pct, existing.id);
    audit(ctx, 'property_owner', existing.id as string, 'update', null, { pct });
  } else {
    const pid = id('pow');
    insert('property_owners', { id: pid, org_id: ctx.orgId, owner_id: input.ownerId, property_id: input.propertyId, pct, created_at: nowIso() });
    audit(ctx, 'property_owner', pid, 'create', null, { pct });
  }
}

export interface OwnerStatementRow {
  propertyId: string;
  propertyName: string;
  pct: number;
  income: number;        // owner share of income, cents
  expenses: number;      // owner share of expenses, cents
  equityIncome: number;  // owner share of net operating result, cents
  capitalShare: number;  // owner share of 3020 capital activity in window (contributions positive)
  reserveShare: number;  // owner share of the reserve balance as of `to`
}

export interface OwnerStatement {
  owner: any;
  from: string;
  to: string;
  basis: Basis;
  rows: OwnerStatementRow[];
  totals: { income: number; expenses: number; equityIncome: number; capitalShare: number; reserveShare: number };
}

/** Trailing-N-month equity-income statement for one owner, consolidated
 * across every property they hold a share of. */
export function ownerStatement(ctx: Ctx, ownerId: string, opts: { to: string; basis: Basis; months?: number }): OwnerStatement {
  const owner = q1<any>('SELECT * FROM owners WHERE id=? AND org_id=?', ownerId, ctx.orgId);
  if (!owner) throw new Error('owner not found');
  const months = opts.months ?? 12;
  const from = firstOfMonth(addMonths(opts.to, -(months - 1)));
  const shares = q<any>(
    `SELECT po.*, p.name AS property_name FROM property_owners po
     JOIN properties p ON p.id=po.property_id
     WHERE po.org_id=? AND po.owner_id=? ORDER BY p.name`,
    ctx.orgId, ownerId,
  );
  const rows: OwnerStatementRow[] = shares.map((sh) => {
    const is = incomeStatement(ctx, { propertyId: sh.property_id, from, to: opts.to, basis: opts.basis });
    const frac = (sh.pct as number) / 100;
    // 3020 is credit-positive in its natural sign (contributions); accountBalance is debit-positive
    const capitalActivity = -accountBalance(ctx, '3020', { propertyId: sh.property_id, basis: opts.basis, from, asOf: opts.to });
    const reserveBal = accountBalance(ctx, RESERVE_GL, { propertyId: sh.property_id, basis: 'accrual', asOf: opts.to });
    return {
      propertyId: sh.property_id as string,
      propertyName: sh.property_name as string,
      pct: sh.pct as number,
      income: Math.round(is.totalIncome * frac),
      expenses: Math.round(is.totalExpenses * frac),
      equityIncome: Math.round(is.noi * frac),
      capitalShare: Math.round(capitalActivity * frac),
      reserveShare: Math.round(reserveBal * frac),
    };
  });
  const tot = (k: 'income' | 'expenses' | 'equityIncome' | 'capitalShare' | 'reserveShare'): number => rows.reduce((s, r) => s + r[k], 0);
  return {
    owner, from, to: opts.to, basis: opts.basis, rows,
    totals: {
      income: tot('income'), expenses: tot('expenses'), equityIncome: tot('equityIncome'),
      capitalShare: tot('capitalShare'), reserveShare: tot('reserveShare'),
    },
  };
}

export function ownersOverview(ctx: Ctx): { owner: any; holdings: { property_name: string; pct: number }[] }[] {
  return q<any>('SELECT * FROM owners WHERE org_id=? AND active=1 ORDER BY name', ctx.orgId).map((o) => ({
    owner: o,
    holdings: q<any>(
      `SELECT po.pct, p.name AS property_name FROM property_owners po
       JOIN properties p ON p.id=po.property_id WHERE po.owner_id=? ORDER BY p.name`,
      o.id,
    ),
  }));
}
