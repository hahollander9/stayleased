import { q, q1, insert, run, tx } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, addMonths, firstOfMonth } from '../../lib/dates.ts';
import type { Ctx } from '../../lib/auth.ts';
import { assertPerm, canAccessProperty } from '../../lib/auth.ts';
import { audit } from '../../lib/audit.ts';
import { incomeStatement, type Basis } from './statements.ts';
import { accountBalance, postJE, postBothBases } from './service.ts';
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

// ---------- owner distributions ----------

/** Record a distribution: money already paid to a property's owners from its
 * operating account. This is bookkeeping, not a payment — nothing is sent from
 * here. It posts DR 3020 Owner contributions/(distributions) / CR 1010 on both
 * books, and stores each owner's part by their share on that day, so an owner
 * can be shown what they received rather than a percentage of a GL balance.
 *
 * The 1010 credit is a normal book entry: it shows up in bank reconciliation
 * to be matched to the transfer or check on the statement. */
export function recordOwnerDistribution(
  ctx: Ctx, input: { propertyId: string; amountCents: number; date: string; memo?: string },
): string {
  assertPerm(ctx, 'owners:manage');
  if (!canAccessProperty(ctx, input.propertyId) || !q1('SELECT id FROM properties WHERE id=? AND org_id=?', input.propertyId, ctx.orgId)) {
    throw new Error('Choose a property in your portfolio.');
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new Error('Enter the amount that was paid out.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number.isNaN(Date.parse(input.date))) throw new Error('Enter the date the money left the account.');
  if (input.date > ctx.businessDate) throw new Error('The distribution date cannot be in the future.');
  const shares = q<any>(
    `SELECT po.owner_id, po.pct, o.name FROM property_owners po JOIN owners o ON o.id=po.owner_id
      WHERE po.org_id=? AND po.property_id=? AND po.pct>0 ORDER BY po.pct DESC, o.name`,
    ctx.orgId, input.propertyId,
  );
  if (!shares.length) throw new Error('This property has no owners assigned yet. Assign ownership first, so the distribution can be divided between them.');
  const totalPct = shares.reduce((s, x) => s + Number(x.pct), 0);
  // each owner's part, to the cent; when the owners hold the whole property
  // the rounding remainder goes to the largest holder so the parts add up
  const parts = shares.map((x) => ({ ownerId: x.owner_id as string, pct: Number(x.pct), cents: Math.round((input.amountCents * Number(x.pct)) / 100) }));
  if (Math.abs(totalPct - 100) < 0.0001) {
    parts[0]!.cents += input.amountCents - parts.reduce((s, x) => s + x.cents, 0);
  }
  const memo = (input.memo || '').trim().slice(0, 160);
  const did = id('odi');
  tx(() => {
    const je = postBothBases(ctx, {
      propertyId: input.propertyId, date: input.date,
      memo: `Owner distribution${memo ? ` — ${memo}` : ''}`,
      sourceKind: 'owner_distribution', sourceId: did,
      lines: [
        { account: '3020', debit: input.amountCents, memo: 'Distribution to owners' },
        { account: '1010', credit: input.amountCents, memo: 'Paid from operating account' },
      ],
    });
    insert('owner_distributions', {
      id: did, org_id: ctx.orgId, property_id: input.propertyId, date: input.date,
      amount_cents: input.amountCents, memo: memo || null, je_id: je.accrual, status: 'posted',
      created_by: ctx.userName, created_at: nowIso(),
    });
    for (const p of parts) {
      insert('owner_distribution_shares', {
        id: id('ods'), org_id: ctx.orgId, distribution_id: did, owner_id: p.ownerId,
        pct: p.pct, amount_cents: p.cents, created_at: nowIso(),
      });
    }
  });
  audit(ctx, 'owner_distribution', did, 'record', null, { propertyId: input.propertyId, amountCents: input.amountCents, date: input.date });
  return did;
}

/** Take back a distribution recorded in error: reverses its entries on both
 * books (same date; a closed month refuses, as any posting would). */
export function voidOwnerDistribution(ctx: Ctx, distributionId: string): void {
  assertPerm(ctx, 'owners:manage');
  const d = q1<any>('SELECT * FROM owner_distributions WHERE id=? AND org_id=?', distributionId, ctx.orgId);
  if (!d || d.status !== 'posted') throw new Error('That distribution is not on the books.');
  if (!canAccessProperty(ctx, d.property_id)) throw new Error('Choose a property in your portfolio.');
  tx(() => {
    for (const je of q<any>(
      `SELECT je.* FROM journal_entries je
        WHERE je.org_id=? AND je.source_kind='owner_distribution' AND je.source_id=? AND je.reversal_of IS NULL
          AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reversal_of=je.id)`,
      ctx.orgId, d.id,
    )) {
      const jl = q<any>('SELECT * FROM journal_lines WHERE entry_id=?', je.id);
      postJE(ctx, {
        propertyId: je.property_id, date: je.date, basis: je.basis,
        memo: `Reversed — ${je.memo || 'owner distribution'}`, sourceKind: 'owner_distribution', sourceId: d.id, reversalOf: je.id,
        lines: jl.filter((l: any) => l.debit_cents || l.credit_cents).map((l: any) => ({ account: l.account_code, debit: l.credit_cents || undefined, credit: l.debit_cents || undefined })),
      });
    }
    run(`UPDATE owner_distributions SET status='void' WHERE id=?`, d.id);
  });
  audit(ctx, 'owner_distribution', d.id, 'void', null, { amountCents: d.amount_cents });
}

export function listOwnerDistributions(ctx: Ctx, opts: { ownerId?: string; limit?: number } = {}): any[] {
  if (opts.ownerId) {
    return q<any>(
      `SELECT d.*, p.name AS property_name, s.pct AS share_pct, s.amount_cents AS share_cents
         FROM owner_distribution_shares s JOIN owner_distributions d ON d.id=s.distribution_id
         JOIN properties p ON p.id=d.property_id
        WHERE s.org_id=? AND s.owner_id=? ORDER BY d.date DESC, d.created_at DESC LIMIT ?`,
      ctx.orgId, opts.ownerId, opts.limit || 100,
    );
  }
  return q<any>(
    `SELECT d.*, p.name AS property_name FROM owner_distributions d JOIN properties p ON p.id=d.property_id
      WHERE d.org_id=? ORDER BY d.date DESC, d.created_at DESC LIMIT ?`,
    ctx.orgId, opts.limit || 50,
  );
}
