import { q, q1 } from '../../lib/db.ts';
import { usd } from '../../lib/money.ts';
import { fmtDate } from '../../lib/dates.ts';
import type { Ctx } from '../../lib/auth.ts';
import { can, propFilter } from '../../lib/auth.ts';
import { registerExecutor, type ActionOutput } from './framework.ts';

/** What Ask StayLeased is allowed to DO.
 *
 * Ask could already read the whole portfolio and could not change a thing —
 * it would find the Bhatt household's balance and then tell you which screen to
 * go to. This is the other half: "finalize disposition for the Bhatt household"
 * runs the same `finalizeDeposit` the deposits screen runs.
 *
 * Three rules hold the design up, and each exists because of a specific way
 * this goes wrong.
 *
 * **Ask never executes. It proposes.** Every operation flows through the
 * `ai_actions` framework an agent uses — proposal row, executor, audit trail,
 * kill switch, and a decision by a person. There is no second write path with
 * weaker supervision than the first, because a natural-language sentence is a
 * far easier thing to get wrong than a form with a submit button.
 *
 * **An operation is a REGISTRATION, not a prompt.** The model chooses from a
 * catalog of typed operations and fills their parameters; it never names a
 * table, a column, or an id. Adding a capability means registering it next to
 * the service function it calls, so the catalog cannot drift from what the code
 * can actually do — the same reason `fieldMenu` is generated in the importer.
 *
 * **A reference that matches two things matches nothing.** "The Bhatt
 * household" is a search, and the search can return two Bhatts. Resolving that
 * to whichever sorted first would finalize a stranger's deposit; every resolver
 * therefore refuses ambiguity by name and hands back the candidates. */

// ---------- parameters ----------

export type ParamType = 'lease' | 'property' | 'unit' | 'vendor' | 'workorder' | 'staff'
  | 'money' | 'date' | 'number' | 'text' | 'enum' | 'boolean';

export interface ParamDef {
  key: string;
  type: ParamType;
  label: string;
  required?: boolean;
  /** for `enum` */
  values?: string[];
  /** shown to the model; say what a good value looks like */
  hint?: string;
}

/** What an operation WOULD do, computed without writing anything.
 *
 * The preview is the whole basis on which a person says yes, so it states the
 * specific figures rather than the shape of them: not "applies the deposit"
 * but "applies $1,057.00 of the $1,450.00 held, refunds $393.00". */
export interface OpPreview {
  summary: string;
  changes: { label: string; value: string }[];
  /** cannot proceed — the action is refused and these are shown instead */
  blockers: string[];
  /** proceeds, but the operator should know before confirming */
  warnings: string[];
}

export interface Op {
  key: string;
  /** how a person would name it */
  name: string;
  /** for the model's catalog: what it does and when to choose it */
  describe: string;
  /** the permission the equivalent screen requires — Ask grants nothing extra */
  perm: string;
  /** money moves, a record changes, or access itself changes */
  risk: 'money' | 'record' | 'admin';
  params: ParamDef[];
  preview(ctx: Ctx, args: OpArgs): OpPreview;
  apply(ctx: Ctx, args: OpArgs): string;
}

export type OpArgs = Record<string, string | number | boolean | null>;

const OPS = new Map<string, Op>();

/** Register an operation, and bind it to the agent framework in the same
 * breath so nothing can be reachable by Ask without being executable through
 * the audited path. */
export function registerOp(op: Op): void {
  OPS.set(op.key, op);
  registerExecutor(`op.${op.key}`, (ctx, _action, output: ActionOutput) => {
    const args = (output.args || {}) as OpArgs;
    // re-checked at execution, not only at proposal: a role can change between
    // the two, and the proposal row is long-lived
    if (!can(ctx, op.perm)) throw new Error(`${op.name} needs ${op.perm}`);
    const pre = op.preview(ctx, args);
    if (pre.blockers.length) throw new Error(pre.blockers.join(' '));
    return op.apply(ctx, args);
  });
}

export function getOp(key: string): Op | undefined {
  return OPS.get(key);
}

/** Operations this user could actually run. The catalog handed to the model is
 * already filtered by permission, so it cannot propose something the asker is
 * not allowed to do and then have it refused after the fact — the refusal
 * would be correct but the suggestion should never have been made. */
export function opsFor(ctx: Ctx): Op[] {
  return [...OPS.values()].filter((o) => can(ctx, o.perm)).sort((a, b) => a.key.localeCompare(b.key));
}

export function opCatalog(ctx: Ctx): string {
  return opsFor(ctx).map((o) => {
    const params = o.params.map((p) => {
      const bits = [p.key, p.type];
      if (p.values) bits.push(p.values.join('|'));
      if (!p.required) bits.push('optional');
      return `${bits.join(':')}${p.hint ? ` (${p.hint})` : ''}`;
    }).join(', ');
    return `- ${o.key} — ${o.describe} Parameters: ${params || 'none'}`;
  }).join('\n');
}

// ---------- resolving what a person named ----------

export interface Resolved {
  id: string;
  label: string;
  propertyId?: string | null;
}

export class Ambiguous extends Error {
  kind: string;
  term: string;
  candidates: Resolved[];
  constructor(kind: string, term: string, candidates: Resolved[]) {
    super(
      candidates.length
        ? `“${term}” matches ${candidates.length} ${kind}s: ${candidates.slice(0, 6).map((c) => c.label).join(', ')}. Say which one.`
        : `No ${kind} matches “${term}”.`,
    );
    this.kind = kind;
    this.term = term;
    this.candidates = candidates;
  }
}

const like = (s: string): string => `%${String(s || '').trim().toLowerCase()}%`;

/** A household, by whatever a person calls it: the household name, a
 * resident's surname, or the unit. Scoped to the properties this user can see,
 * so resolution can never reach across a portfolio boundary. */
export function resolveLease(ctx: Ctx, term: string): Resolved {
  const t = String(term || '').trim();
  if (!t) throw new Ambiguous('household', term, []);
  const pf = propFilter(ctx, 'l.property_id');
  const rows = q<{ id: string; household_name: string; unit_number: string; prop_name: string; property_id: string; status: string }>(
    `SELECT DISTINCT l.id, l.household_name, u.unit_number, p.name AS prop_name, l.property_id, l.status
       FROM leases l
       JOIN units u ON u.id=l.unit_id
       JOIN properties p ON p.id=l.property_id
       LEFT JOIN household_members hm ON hm.lease_id=l.id
       LEFT JOIN residents r ON r.id=hm.resident_id
      WHERE l.org_id=?${pf.sql}
        AND (LOWER(l.household_name) LIKE ? OR LOWER(r.last_name) LIKE ? OR LOWER(r.first_name || ' ' || r.last_name) LIKE ? OR LOWER(u.unit_number)=?)
      ORDER BY CASE l.status WHEN 'active' THEN 0 WHEN 'notice' THEN 1 WHEN 'month_to_month' THEN 2 ELSE 3 END, l.created_at DESC`,
    ctx.orgId, ...pf.params, like(t), like(t), like(t), t.toLowerCase(),
  );
  const cands: Resolved[] = rows.map((r) => ({
    id: r.id,
    label: `${r.household_name} — unit ${r.unit_number}, ${r.prop_name}${r.status === 'active' ? '' : ` (${r.status.replace(/_/g, ' ')})`}`,
    propertyId: r.property_id,
  }));
  if (cands.length === 1) return cands[0]!;
  // Several tenancies for ONE unit is the ordinary case at move-out (the old
  // lease and its renewal); several DISTINCT households is the dangerous one.
  const households = new Set(rows.map((r) => `${r.household_name}|${r.unit_number}`));
  if (cands.length > 1 && households.size === 1) return cands[0]!;
  throw new Ambiguous('household', t, cands);
}

export function resolveProperty(ctx: Ctx, term: string): Resolved {
  const t = String(term || '').trim();
  const pf = propFilter(ctx, 'id');
  const rows = q<{ id: string; name: string }>(
    `SELECT id, name FROM properties WHERE org_id=?${pf.sql} AND (LOWER(name) LIKE ? OR LOWER(slug) LIKE ?) ORDER BY name`,
    ctx.orgId, ...pf.params, like(t), like(t),
  );
  const cands = rows.map((r) => ({ id: r.id, label: r.name, propertyId: r.id }));
  if (cands.length === 1) return cands[0]!;
  throw new Ambiguous('property', t, cands);
}

export function resolveVendor(ctx: Ctx, term: string): Resolved {
  const t = String(term || '').trim();
  const rows = q<{ id: string; name: string; category: string }>(
    `SELECT id, name, category FROM vendors WHERE org_id=? AND active=1 AND LOWER(name) LIKE ? ORDER BY name`,
    ctx.orgId, like(t),
  );
  const cands = rows.map((r) => ({ id: r.id, label: `${r.name}${r.category ? ` (${r.category})` : ''}` }));
  if (cands.length === 1) return cands[0]!;
  throw new Ambiguous('vendor', t, cands);
}

export function resolveUnit(ctx: Ctx, term: string): Resolved {
  const t = String(term || '').trim();
  const pf = propFilter(ctx, 'u.property_id');
  const rows = q<{ id: string; unit_number: string; prop_name: string; property_id: string }>(
    `SELECT u.id, u.unit_number, p.name AS prop_name, u.property_id
       FROM units u JOIN properties p ON p.id=u.property_id
      WHERE u.org_id=?${pf.sql} AND LOWER(u.unit_number)=? ORDER BY p.name`,
    ctx.orgId, ...pf.params, t.toLowerCase(),
  );
  const cands = rows.map((r) => ({ id: r.id, label: `Unit ${r.unit_number}, ${r.prop_name}`, propertyId: r.property_id }));
  if (cands.length === 1) return cands[0]!;
  throw new Ambiguous('unit', t, cands);
}

export function resolveWorkOrder(ctx: Ctx, term: string): Resolved {
  const t = String(term || '').trim();
  const pf = propFilter(ctx, 'w.property_id');
  const rows = q<{ id: string; title: string; unit_number: string | null; property_id: string }>(
    `SELECT w.id, w.title, u.unit_number, w.property_id
       FROM work_orders w LEFT JOIN units u ON u.id=w.unit_id
      WHERE w.org_id=?${pf.sql} AND (w.id=? OR LOWER(w.title) LIKE ?)
        AND w.status NOT IN ('completed','canceled')
      ORDER BY w.created_at DESC`,
    ctx.orgId, ...pf.params, t, like(t),
  );
  const cands = rows.map((r) => ({ id: r.id, label: `${r.title}${r.unit_number ? ` — unit ${r.unit_number}` : ''}`, propertyId: r.property_id }));
  if (cands.length === 1) return cands[0]!;
  throw new Ambiguous('work order', t, cands);
}

// ---------- small shared formatting for previews ----------

export const money = (cents: number): string => usd(cents);
export const onDate = (d: string): string => fmtDate(d);

export function leaseRow(ctx: Ctx, leaseId: string): {
  id: string; household_name: string; status: string; unit_number: string; prop_name: string;
  property_id: string; deposit_cents: number; rent_cents: number; move_out_date: string | null; end_date: string;
} | undefined {
  return q1(
    `SELECT l.id, l.household_name, l.status, u.unit_number, p.name AS prop_name, l.property_id,
            l.deposit_cents, l.rent_cents, l.move_out_date, l.end_date
       FROM leases l JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=l.property_id
      WHERE l.id=? AND l.org_id=?`,
    leaseId, ctx.orgId,
  );
}
