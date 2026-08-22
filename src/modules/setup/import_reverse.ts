import { q, q1, run, val, tx, j } from '../../lib/db.ts';
import { audit } from '../../lib/audit.ts';
import type { Ctx } from '../../lib/auth.ts';
import { deleteProperty } from '../m2_portfolio/service.ts';
import type { BatchRow, ApplySummary } from './import_apply.ts';

/** Taking an import back.
 *
 * Every row an apply creates carries `import_batch_id`, so removing an upload
 * removes exactly what it wrote — no guessing, no heuristics. Two paths:
 *
 *  1. Properties the import CREATED are handed to `deleteProperty`, the
 *     books-safe cascade that already knows all ~80 tables hanging off a
 *     property (and already refuses when real payments or manual journal
 *     entries landed on it). Nothing is duplicated here.
 *  2. Rows the import added INTO a property that already existed are deleted
 *     by their stamp, in dependency order. This is deliberately narrow — it
 *     covers what an import can create and nothing else. `PRAGMA foreign_keys`
 *     is ON, so if anything downstream came to reference one of these rows,
 *     the database refuses and we surface that as a readable message instead
 *     of orphaning it.
 *
 * Contact merges are a third case: the directory lane fills BLANK email/phone
 * on residents that already existed, so there is no row to delete — the undo
 * is putting the field back to empty. Only fields still holding the value the
 * import wrote are reverted; anything edited since belongs to the operator. */

export interface ReverseCounts {
  properties: number;
  units: number;
  floorplans: number;
  leases: number;
  residents: number;
  vendors: number;
  charges: number;
  journalEntries: number;
  portalLogins: number;
  /** existing residents whose imported email/phone were put back to empty */
  contactRestores: number;
  /** deposit positions carried in from a deposit report */
  depositPositions: number;
}

const ZERO: ReverseCounts = {
  properties: 0, units: 0, floorplans: 0, leases: 0, residents: 0, vendors: 0,
  charges: 0, journalEntries: 0, portalLogins: 0, contactRestores: 0, depositPositions: 0 };

function countStamped(orgId: string, table: string, batchId: string): number {
  return val<number>(`SELECT COUNT(*) FROM ${table} WHERE org_id=? AND import_batch_id=?`, orgId, batchId) || 0;
}

/** A footprint plus the property names on either side of the line, so the
 * confirm screen can say which building disappears and which one merely loses
 * the rows this upload added to it. */
export interface ImportFootprint extends ReverseCounts {
  /** properties this upload CREATED — these are removed entirely */
  propertyNames: string[];
  /** properties it only added rows to — these survive the removal */
  keptPropertyNames: string[];
}

/** What removing this upload would take back, for the confirm screen. Counts
 * only — nothing is written. A footprint of all zeros means the upload created
 * nothing traceable: either it wrote nothing, or it was applied before
 * provenance was tracked, and the screen says so rather than implying an undo
 * it cannot perform. */
export function importFootprint(ctx: Ctx, batch: BatchRow & { summary?: string | null }): ImportFootprint {
  const o = ctx.orgId;
  const b = batch.id;
  const summary = batch.summary ? j<Partial<ApplySummary>>(batch.summary, {}) : {};
  const merges = summary.merges || [];
  // properties the upload created (removed) vs merely added to (kept)
  const created = q<{ name: string }>('SELECT name FROM properties WHERE org_id=? AND import_batch_id=? ORDER BY name', o, b);
  const kept = q<{ name: string }>(
    `SELECT DISTINCT p.name FROM properties p
       WHERE p.org_id=? AND (p.import_batch_id IS NULL OR p.import_batch_id!=?)
         AND (p.id IN (SELECT property_id FROM units WHERE org_id=? AND import_batch_id=?)
           OR p.id IN (SELECT property_id FROM leases WHERE org_id=? AND import_batch_id=?)
           OR p.id IN (SELECT property_id FROM residents WHERE org_id=? AND import_batch_id=?))
       ORDER BY p.name`,
    o, b, o, b, o, b, o, b,
  );
  return {
    propertyNames: created.map((r) => r.name),
    keptPropertyNames: kept.map((r) => r.name),
    properties: countStamped(o, 'properties', b),
    units: countStamped(o, 'units', b),
    floorplans: countStamped(o, 'floorplans', b),
    leases: countStamped(o, 'leases', b),
    residents: countStamped(o, 'residents', b),
    depositPositions: countStamped(o, 'deposit_positions', b),
    vendors: countStamped(o, 'vendors', b),
    charges: countStamped(o, 'charges', b),
    journalEntries: countStamped(o, 'journal_entries', b),
    portalLogins: countStamped(o, 'users', b),
    contactRestores: merges.filter((m) => stillOurs(o, m)).length,
  };
}

/** True when the resident still carries exactly what this import wrote — the
 * only case where blanking the field is an undo rather than a deletion of
 * someone else's edit. */
function stillOurs(orgId: string, m: { residentId: string; email?: string; phone?: string }): boolean {
  const r = q1<{ email: string | null; phone: string | null }>(
    'SELECT email, phone FROM residents WHERE id=? AND org_id=?', m.residentId, orgId,
  );
  if (!r) return false;
  return (!!m.email && r.email === m.email) || (!!m.phone && r.phone === m.phone);
}

export function totalFootprint(c: ReverseCounts): number {
  return c.properties + c.units + c.floorplans + c.leases + c.residents + c.vendors
    + c.charges + c.journalEntries + c.portalLogins + c.contactRestores;
}

/** Human summary of a footprint, for the confirm screen and the flash. */
export function footprintBits(c: ReverseCounts): string[] {
  const bits: string[] = [];
  const add = (n: number, one: string, many = one + 's'): void => { if (n) bits.push(`${n} ${n === 1 ? one : many}`); };
  add(c.properties, 'property', 'properties');
  add(c.units, 'unit');
  add(c.leases, 'lease');
  add(c.residents, 'resident record');
  add(c.portalLogins, 'portal login');
  add(c.vendors, 'vendor');
  add(c.charges, 'posted charge');
  add(c.journalEntries, 'journal entry', 'journal entries');
  add(c.contactRestores, 'restored contact record');
  return bits;
}

/** Take back everything this upload wrote. One transaction: the import comes
 * out whole or not at all. Throws (with a message meant for the operator) when
 * real activity has accumulated on the imported records — money recorded
 * against them, or anything else that came to depend on them. */
export function reverseImport(ctx: Ctx, batch: BatchRow & { summary?: string | null }, opts?: { force?: boolean }): ReverseCounts {
  const o = ctx.orgId;
  const b = batch.id;
  const counts: ReverseCounts = { ...ZERO };
  const summary = batch.summary ? j<Partial<ApplySummary>>(batch.summary, {}) : {};

  // ---- rail: payments recorded against leases this import created ----
  // Imports never create payment rows, so any that exist were taken after the
  // fact and represent real money movement. deleteProperty enforces the same
  // rule for its own scope; this covers leases added to existing properties.
  if (!opts?.force) {
    const payN = val<number>(
      `SELECT COUNT(*) FROM payments WHERE org_id=? AND lease_id IN (SELECT id FROM leases WHERE org_id=? AND import_batch_id=?)`,
      o, o, b,
    ) || 0;
    if (payN) {
      throw new Error(
        `${payN} payment${payN === 1 ? ' has' : 's have'} been recorded against leases this upload created. `
        + `Removing it would erase that financial history. Void or reverse those payments first, then try again.`,
      );
    }
  }

  tx(() => {
    // ---- 1. properties the import created: the whole tested cascade ----
    for (const p of q<{ id: string }>('SELECT id FROM properties WHERE org_id=? AND import_batch_id=?', o, b)) {
      deleteProperty(ctx, p.id, opts); // throws on payments / manual JEs
      counts.properties++;
    }

    // ---- 2. rows added into properties that already existed ----
    // Dependency order. Anything the property cascade already removed is gone,
    // so these only touch survivors.
    const del = (table: string, where: string, ...params: unknown[]): number =>
      run(`DELETE FROM ${table} WHERE ${where}`, ...params).changes;

    // the ledger first: lines, then their entries (charge entries are found by
    // the charge they posted for; deposit entries carry the batch directly)
    del('journal_lines',
      `org_id=? AND entry_id IN (SELECT id FROM journal_entries WHERE org_id=? AND import_batch_id=?)`, o, o, b);
    counts.journalEntries = del('journal_entries', 'org_id=? AND import_batch_id=?', o, b);
    del('payment_applications', `org_id=? AND charge_id IN (SELECT id FROM charges WHERE org_id=? AND import_batch_id=?)`, o, o, b);
    counts.charges = del('charges', 'org_id=? AND import_batch_id=?', o, b);

    del('lease_charges', 'org_id=? AND import_batch_id=?', o, b);
    del('household_members', 'org_id=? AND import_batch_id=?', o, b);
    counts.leases = del('leases', 'org_id=? AND import_batch_id=?', o, b);

    // residents the import created, and the portal logins minted for them
    const imported = q<{ id: string; user_id: string | null }>(
      'SELECT id, user_id FROM residents WHERE org_id=? AND import_batch_id=?', o, b,
    );
    counts.residents = del('residents', 'org_id=? AND import_batch_id=?', o, b);
    for (const r of imported) {
      if (!r.user_id) continue;
      // only a login this import minted, and only if nobody else still uses it
      const stillHeld = val<number>('SELECT COUNT(*) FROM residents WHERE org_id=? AND user_id=?', o, r.user_id) || 0;
      if (stillHeld) continue;
      del('sessions', 'user_id=?', r.user_id);
      counts.portalLogins += del('users', 'id=? AND org_id=? AND import_batch_id=?', r.user_id, o, b);
    }

    // Deposit positions, and the held figures they filled in.
    //
    // Restored by PROVENANCE, never by value. applyDeposits stamps
    // `filled_lease` on the rows where it actually wrote a deposit onto an
    // empty lease, and only those are put back — a lease that already carried
    // the same figure before the import must keep it. Matching on the amount
    // instead cannot tell those cases apart, and gets it wrong in the
    // direction that destroys a real deposit.
    for (const dp of q<{ lease_id: string | null; held_cents: number }>(
      'SELECT lease_id, held_cents FROM deposit_positions WHERE org_id=? AND import_batch_id=? AND filled_lease=1', o, b,
    )) {
      if (!dp.lease_id) continue;
      run('UPDATE leases SET deposit_cents=0 WHERE id=? AND org_id=? AND deposit_cents=?', dp.lease_id, o, dp.held_cents);
    }
    counts.depositPositions = del('deposit_positions', 'org_id=? AND import_batch_id=?', o, b);

    counts.units = del('units', 'org_id=? AND import_batch_id=?', o, b);
    counts.floorplans = del('floorplans', 'org_id=? AND import_batch_id=?', o, b);
    counts.vendors = del('vendors', 'org_id=? AND import_batch_id=?', o, b);

    // ---- 3. contact merges: put the fields back where they are still ours ----
    for (const m of summary.merges || []) {
      if (!stillOurs(o, m)) continue;
      if (m.email) run(`UPDATE residents SET email=NULL WHERE id=? AND org_id=? AND email=?`, m.residentId, o, m.email);
      if (m.phone) run(`UPDATE residents SET phone=NULL WHERE id=? AND org_id=? AND phone=?`, m.residentId, o, m.phone);
      // a login minted off the merged email goes too, unless it has been used
      const res = q1<{ user_id: string | null }>('SELECT user_id FROM residents WHERE id=?', m.residentId);
      if (res?.user_id) {
        const u = q1<{ last_login_at: string | null }>(
          'SELECT last_login_at FROM users WHERE id=? AND org_id=? AND import_batch_id=?', res.user_id, o, b,
        );
        if (u && !u.last_login_at) {
          run('UPDATE residents SET user_id=NULL WHERE id=?', m.residentId);
          run('DELETE FROM sessions WHERE user_id=?', res.user_id);
          counts.portalLogins += run('DELETE FROM users WHERE id=? AND org_id=?', res.user_id, o).changes;
        }
      }
      counts.contactRestores++;
    }
  });

  audit(ctx, 'import_batch', b, 'reverse', null, counts as unknown as Record<string, unknown>);
  return counts;
}
