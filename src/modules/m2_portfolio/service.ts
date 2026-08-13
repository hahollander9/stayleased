import { q, q1, run, tx, val, j, afterCommit } from '../../lib/db.ts';
import { propFilter, canAccessProperty, type Ctx } from '../../lib/auth.ts';
import { audit } from '../../lib/audit.ts';
import { unlinkBlobs } from '../../lib/files.ts';
import { emit } from '../../lib/events.ts';

/** M2 services: portfolio/unit math used by dashboards, quotes, pricing and
 * reports. KPI definitions live in docs/metrics.md (kept current):
 * rentable = units − down − model; physical occupancy = occupied+notice ÷ rentable;
 * exposure = (vacant + notice-not-preleased) ÷ rentable. */

export interface UnitStats {
  total: number;
  rentable: number;
  occupied: number; // includes notice (still physically occupied)
  notice: number;
  vacantReady: number;
  vacantNotReady: number;
  down: number;
  model: number;
  occupancyPct: number;
  exposureCount: number;
  exposurePct: number;
  avgMarketRentCents: number;
}

export function unitStats(ctx: Ctx, propertyId?: string | null): UnitStats {
  const pf = propertyId
    ? { sql: ' AND property_id = ?', params: [propertyId] }
    : propFilter(ctx);
  const rows = q<{ status: string; n: number; rent: number }>(
    `SELECT status, COUNT(*) AS n, AVG(market_rent_cents) AS rent FROM units WHERE org_id=?${pf.sql} GROUP BY status`,
    ctx.orgId,
    ...pf.params,
  );
  const by: Record<string, number> = {};
  for (const r of rows) by[r.status] = r.n;
  const total = rows.reduce((s, r) => s + r.n, 0);
  const down = by['down'] || 0;
  const model = by['model'] || 0;
  const notice = by['notice'] || 0;
  const occupiedOnly = by['occupied'] || 0;
  const vacantReady = by['vacant_ready'] || 0;
  const vacantNotReady = by['vacant_not_ready'] || 0;
  const rentable = total - down - model;
  const occupied = occupiedOnly + notice;
  // preleases (future leases on notice/vacant units) reduce exposure — wired in Phase 9
  const preleased = val<number>(
    `SELECT COUNT(DISTINCT l.unit_id) FROM leases l JOIN units u ON u.id=l.unit_id
     WHERE l.org_id=? AND l.status IN ('fully_executed','partially_signed','draft') AND u.status IN ('notice','vacant_ready','vacant_not_ready')${pf.sql.replaceAll('property_id', 'u.property_id')}`,
    ctx.orgId,
    ...pf.params,
  ) || 0;
  const exposureCount = Math.max(0, vacantReady + vacantNotReady + notice - preleased);
  const avg = val<number>(`SELECT AVG(market_rent_cents) FROM units WHERE org_id=?${pf.sql}`, ctx.orgId, ...pf.params) || 0;
  return {
    total, rentable, occupied, notice, vacantReady, vacantNotReady, down, model,
    occupancyPct: rentable ? Math.round((occupied / rentable) * 1000) / 10 : 0,
    exposureCount,
    exposurePct: rentable ? Math.round((exposureCount / rentable) * 1000) / 10 : 0,
    avgMarketRentCents: Math.round(avg),
  };
}

export interface FloorplanRow {
  id: string;
  name: string;
  beds: number;
  baths: number;
  sqft: number;
  market_rent_cents: number;
  units: number;
  available: number;
  occupied: number;
  exposure: number;
}

export function floorplanAvailability(ctx: Ctx, propertyId: string): FloorplanRow[] {
  return q<FloorplanRow>(
    `SELECT f.id, f.name, f.beds, f.baths, f.sqft, f.market_rent_cents,
      (SELECT COUNT(*) FROM units u WHERE u.floorplan_id=f.id) AS units,
      (SELECT COUNT(*) FROM units u WHERE u.floorplan_id=f.id AND u.status='vacant_ready') AS available,
      (SELECT COUNT(*) FROM units u WHERE u.floorplan_id=f.id AND u.status IN ('occupied','notice')) AS occupied,
      (SELECT COUNT(*) FROM units u WHERE u.floorplan_id=f.id AND u.status IN ('vacant_ready','vacant_not_ready','notice')) AS exposure
     FROM floorplans f WHERE f.org_id=? AND f.property_id=? ORDER BY f.market_rent_cents`,
    ctx.orgId,
    propertyId,
  );
}

export interface PropertySummary {
  id: string;
  name: string;
  slug: string;
  type: string;
  city: string;
  state: string;
  timezone: string;
  stats: UnitStats;
}

export function propertySummaries(ctx: Ctx): PropertySummary[] {
  const pf = propFilter(ctx, 'id');
  const props = q<any>(`SELECT * FROM properties WHERE org_id=?${pf.sql} ORDER BY name`, ctx.orgId, ...pf.params);
  return props.map((p) => ({ ...p, stats: unitStats(ctx, p.id) }));
}

/** effective market rent = floorplan base + unit amenity premiums */
export function effectiveMarketRent(fpRentCents: number, amenities: { name: string; premium_cents: number }[]): number {
  return fpRentCents + amenities.reduce((s, a) => s + (a.premium_cents || 0), 0);
}

export function unitAmenities(unit: { amenities: string }): { name: string; premium_cents: number }[] {
  return j<{ name: string; premium_cents: number }[]>(unit.amenities, []);
}

/** Books-safe, audited property delete (Migration Center recovery path).
 *
 * Removes every row the property owns — units, leases, households, files,
 * the resident subledger, and the property's journal entries on BOTH bases.
 * JEs and their lines carry property_id, so removing them nets the org-wide
 * trial balance back to exactly what it was before the property existed.
 *
 * Residents are deleted only when this property held their last household
 * anywhere in the org; their portal logins (users.kind='resident' via
 * residents.user_id) and invite messages go with them. Residents who also
 * live at another property survive — if their home property was the one
 * being removed, they are re-homed to a property they still hold a lease at.
 *
 * Safety rail: refuses (unless opts.force) when real post-import activity
 * exists on the books — recorded payments (imports never create payment
 * rows) or manually posted journal entries (source_kind='manual'). Deleting
 * those would erase genuine financial history, not just an import.
 *
 * Everything happens in ONE transaction; the audit trail (audit_events,
 * domain_events, import_batches) is never deleted. */
export function deleteProperty(ctx: Ctx, propertyId: string, opts?: { force?: boolean }): { counts: Record<string, number> } {
  const prop = q1<any>('SELECT * FROM properties WHERE id=? AND org_id=?', propertyId, ctx.orgId);
  if (!prop || !canAccessProperty(ctx, propertyId)) throw new Error('Property not found in this portfolio.');

  if (!opts?.force) {
    const payN = val<number>('SELECT COUNT(*) FROM payments WHERE org_id=? AND property_id=?', ctx.orgId, propertyId) || 0;
    const manN = val<number>(`SELECT COUNT(*) FROM journal_entries WHERE org_id=? AND property_id=? AND source_kind='manual'`, ctx.orgId, propertyId) || 0;
    if (payN || manN) {
      const parts: string[] = [];
      if (payN) parts.push(`${payN} recorded payment${payN === 1 ? '' : 's'}`);
      if (manN) parts.push(`${manN} manually posted journal entr${manN === 1 ? 'y' : 'ies'}`);
      throw new Error(
        `${prop.name} has ${parts.join(' and ')} on its books. Removing the property would erase that financial history. ` +
        `Void or reverse those records first, then try again.`,
      );
    }
  }

  const counts: Record<string, number> = {};
  const del = (table: string, where: string, ...params: unknown[]): void => {
    const { changes } = run(`DELETE FROM ${table} WHERE ${where}`, ...params);
    if (changes) counts[table] = (counts[table] || 0) + changes;
  };
  // file rows are deleted below by raw SQL, which cannot reach the file store —
  // collect their ids first and unlink the bytes only once the tx has committed
  const doomedBlobs: string[] = [];
  const o = ctx.orgId;
  const p = propertyId;
  // reusable org-scoped subqueries — each use appends (o, p) to the params
  const L = 'SELECT id FROM leases WHERE org_id=? AND property_id=?';
  const U = 'SELECT id FROM units WHERE org_id=? AND property_id=?';

  tx(() => {
    // ---- residents: resolve keep/delete BEFORE any rows disappear ----
    const candidates = q<{ id: string; user_id: string | null; property_id: string }>(
      `SELECT DISTINCT r.id, r.user_id, r.property_id FROM residents r
       WHERE r.org_id=? AND (r.property_id=? OR r.id IN (
         SELECT hm.resident_id FROM household_members hm JOIN leases l ON l.id=hm.lease_id
         WHERE l.org_id=? AND l.property_id=?))`,
      o, p, o, p,
    );
    const deadResidents: string[] = [];
    for (const r of candidates) {
      const elsewhere = val<number>(
        `SELECT COUNT(*) FROM household_members hm JOIN leases l ON l.id=hm.lease_id WHERE hm.resident_id=? AND l.property_id!=?`,
        r.id, p,
      ) || 0;
      if (elsewhere === 0) { deadResidents.push(r.id); continue; }
      if (r.property_id === p) {
        // survivor whose home property is going away — re-home to a property they still live at
        const home = q1<{ property_id: string }>(
          `SELECT l.property_id FROM household_members hm JOIN leases l ON l.id=hm.lease_id
           WHERE hm.resident_id=? AND l.property_id!=? ORDER BY l.created_at DESC LIMIT 1`,
          r.id, p,
        );
        if (home) run('UPDATE residents SET property_id=? WHERE id=?', home.property_id, r.id);
      }
    }
    const inDead = deadResidents.length ? `(${deadResidents.map(() => '?').join(',')})` : `('')`;
    // portal logins owned by deleted residents, unless a surviving resident shares the login
    const deadUserSet = new Set<string>();
    for (const r of candidates) {
      if (!r.user_id || !deadResidents.includes(r.id)) continue;
      const sharedWithSurvivor = val<number>(
        `SELECT COUNT(*) FROM residents WHERE org_id=? AND user_id=? AND id NOT IN ${inDead}`,
        o, r.user_id, ...deadResidents,
      ) || 0;
      if (sharedWithSurvivor) continue;
      const u = q1<{ kind: string }>('SELECT kind FROM users WHERE id=? AND org_id=?', r.user_id, o);
      if (u?.kind === 'resident') deadUserSet.add(r.user_id);
    }
    const deadUsers = [...deadUserSet];
    const inDeadUsers = deadUsers.length ? `(${deadUsers.map(() => '?').join(',')})` : `('')`;

    // ---- files first, while the owning rows still exist to resolve ----
    const fileWhere = `org_id=? AND (
        (entity='property' AND entity_id=?)
        OR entity_id IN (${U}) OR entity_id IN (${L})
        OR entity_id IN (SELECT id FROM work_orders WHERE org_id=? AND property_id=?)
        OR entity_id IN (SELECT id FROM applications WHERE org_id=? AND property_id=?)
        OR entity_id IN (SELECT id FROM inspections WHERE org_id=? AND property_id=?)
        OR entity_id IN (SELECT id FROM signature_requests WHERE org_id=? AND lease_id IN (${L}))
        OR (entity='resident' AND entity_id IN ${inDead})
      )`;
    const fileParams = [o, p, o, p, o, p, o, p, o, p, o, p, o, o, p, ...deadResidents];
    for (const f of q<{ id: string }>(`SELECT id FROM files WHERE ${fileWhere}`, ...fileParams)) doomedBlobs.push(f.id);
    del('files', fileWhere, ...fileParams);

    // ---- money: resident subledger + settlements ----
    del('payment_applications',
      `org_id=? AND (payment_id IN (SELECT id FROM payments WHERE org_id=? AND property_id=?)
        OR charge_id IN (SELECT id FROM charges WHERE org_id=? AND property_id=?))`,
      o, o, p, o, p);
    del('payments', 'org_id=? AND property_id=?', o, p);
    del('deposit_activity', 'org_id=? AND property_id=?', o, p);
    del('refunds', 'org_id=? AND property_id=?', o, p);
    del('collection_cases', 'org_id=? AND property_id=?', o, p);
    del('payment_plan_installments', 'org_id=? AND plan_id IN (SELECT id FROM payment_plans WHERE org_id=? AND property_id=?)', o, o, p);
    del('payment_plans', 'org_id=? AND property_id=?', o, p);
    del('delinquency_notes', `org_id=? AND lease_id IN (${L})`, o, o, p);
    del('delinquency_assessments', `org_id=? AND lease_id IN (${L})`, o, o, p);
    del('autopay_enrollments', `org_id=? AND (lease_id IN (${L}) OR user_id IN ${inDeadUsers})`, o, o, p, ...deadUsers);
    del('payment_method_tokens', `org_id=? AND (lease_id IN (${L}) OR user_id IN ${inDeadUsers})`, o, o, p, ...deadUsers);
    del('charges', 'org_id=? AND property_id=?', o, p);
    del('settlement_batches', 'org_id=? AND property_id=?', o, p);

    // ---- the ledger: this property's journal entries on both bases ----
    del('journal_lines', 'org_id=? AND entry_id IN (SELECT id FROM journal_entries WHERE org_id=? AND property_id=?)', o, o, p);
    del('journal_entries', 'org_id=? AND property_id=?', o, p);
    del('accounting_periods', 'org_id=? AND property_id=?', o, p);
    del('pending_jes', 'org_id=? AND property_id=?', o, p);
    del('recurring_jes', 'org_id=? AND property_id=?', o, p);
    del('budget_lines', 'org_id=? AND budget_id IN (SELECT id FROM budgets WHERE org_id=? AND property_id=?)', o, o, p);
    del('budgets', 'org_id=? AND property_id=?', o, p);
    del('capital_projects', 'org_id=? AND property_id=?', o, p);
    del('bank_txns', 'org_id=? AND bank_account_id IN (SELECT id FROM bank_accounts WHERE org_id=? AND property_id=?)', o, o, p);
    del('bank_recons', 'org_id=? AND bank_account_id IN (SELECT id FROM bank_accounts WHERE org_id=? AND property_id=?)', o, o, p);
    del('bank_accounts', 'org_id=? AND property_id=?', o, p);

    // ---- AP / procurement (vendors themselves are org-level and stay) ----
    del('invoice_matches',
      `org_id=? AND (invoice_id IN (SELECT id FROM vendor_invoices WHERE org_id=? AND property_id=?)
        OR po_id IN (SELECT id FROM purchase_orders WHERE org_id=? AND property_id=?))`,
      o, o, p, o, p);
    del('ap_payments', 'org_id=? AND property_id=?', o, p);
    del('vendor_invoice_lines', 'org_id=? AND (property_id=? OR invoice_id IN (SELECT id FROM vendor_invoices WHERE org_id=? AND property_id=?))', o, p, o, p);
    del('vendor_invoices', 'org_id=? AND property_id=?', o, p);
    del('po_receipt_lines', 'org_id=? AND receipt_id IN (SELECT id FROM po_receipts WHERE org_id=? AND po_id IN (SELECT id FROM purchase_orders WHERE org_id=? AND property_id=?))', o, o, o, p);
    del('po_receipts', 'org_id=? AND po_id IN (SELECT id FROM purchase_orders WHERE org_id=? AND property_id=?)', o, o, p);
    del('purchase_order_lines', 'org_id=? AND po_id IN (SELECT id FROM purchase_orders WHERE org_id=? AND property_id=?)', o, o, p);
    del('purchase_orders', 'org_id=? AND property_id=?', o, p);
    del('stock_moves', 'org_id=? AND item_id IN (SELECT id FROM inventory_items WHERE org_id=? AND property_id=?)', o, o, p);
    del('inventory_items', 'org_id=? AND property_id=?', o, p);

    // ---- facilities ----
    del('wo_events', 'org_id=? AND work_order_id IN (SELECT id FROM work_orders WHERE org_id=? AND property_id=?)', o, o, p);
    del('wo_materials', 'org_id=? AND work_order_id IN (SELECT id FROM work_orders WHERE org_id=? AND property_id=?)', o, o, p);
    del('wo_labor', 'org_id=? AND work_order_id IN (SELECT id FROM work_orders WHERE org_id=? AND property_id=?)', o, o, p);
    del('work_orders', 'org_id=? AND property_id=?', o, p);
    del('turn_tasks', 'org_id=? AND turn_id IN (SELECT id FROM turns WHERE org_id=? AND property_id=?)', o, o, p);
    del('turns', 'org_id=? AND property_id=?', o, p);
    del('inspection_items', 'org_id=? AND inspection_id IN (SELECT id FROM inspections WHERE org_id=? AND property_id=?)', o, o, p);
    del('inspections', 'org_id=? AND property_id=?', o, p);
    del('pm_schedules', 'org_id=? AND property_id=?', o, p);
    del('meter_reads', 'org_id=? AND meter_id IN (SELECT id FROM meters WHERE org_id=? AND property_id=?)', o, o, p);
    del('meters', 'org_id=? AND property_id=?', o, p);
    del('rubs_lines', `org_id=? AND (run_id IN (SELECT id FROM rubs_runs WHERE org_id=? AND property_id=?) OR unit_id IN (${U}))`, o, o, p, o, p);
    del('rubs_runs', 'org_id=? AND property_id=?', o, p);
    del('utility_provider_invoices', 'org_id=? AND property_id=?', o, p);
    del('rubs_configs', 'org_id=? AND property_id=?', o, p);
    del('incidents', 'org_id=? AND property_id=?', o, p);

    // ---- leasing funnel, screening, pricing, marketing ----
    del('lead_events', 'org_id=? AND lead_id IN (SELECT id FROM leads WHERE org_id=? AND property_id=?)', o, o, p);
    del('tours', 'org_id=? AND property_id=?', o, p);
    del('followup_tasks', 'org_id=? AND property_id=?', o, p);
    del('quotes', 'org_id=? AND property_id=?', o, p);
    del('screening_reports', 'org_id=? AND application_id IN (SELECT id FROM applications WHERE org_id=? AND property_id=?)', o, o, p);
    del('applicants', 'org_id=? AND application_id IN (SELECT id FROM applications WHERE org_id=? AND property_id=?)', o, o, p);
    del('applications', 'org_id=? AND property_id=?', o, p);
    del('leads', 'org_id=? AND property_id=?', o, p);
    del('campaigns', 'org_id=? AND property_id=?', o, p);
    del('call_logs', `org_id=? AND (property_id=? OR resident_id IN ${inDead})`, o, p, ...deadResidents);
    del('listing_publications', 'org_id=? AND property_id=?', o, p);
    del('price_recommendations', 'org_id=? AND property_id=?', o, p);
    del('price_changes', 'org_id=? AND property_id=?', o, p);
    del('comp_observations', 'org_id=? AND comp_id IN (SELECT id FROM comp_sets WHERE org_id=? AND property_id=?)', o, o, p);
    del('comp_sets', 'org_id=? AND property_id=?', o, p);
    del('metric_snapshots', 'org_id=? AND property_id=?', o, p);
    del('waitlist_entries', 'org_id=? AND property_id=?', o, p);
    del('roommate_profiles', 'org_id=? AND property_id=?', o, p);
    del('income_certs', 'org_id=? AND property_id=?', o, p);
    del('pcs_breaks', 'org_id=? AND property_id=?', o, p);

    // ---- lease documents, coverage, household extras ----
    del('signature_signers', `org_id=? AND request_id IN (SELECT id FROM signature_requests WHERE org_id=? AND lease_id IN (${L}))`, o, o, o, p);
    del('signature_requests', `org_id=? AND lease_id IN (${L})`, o, o, p);
    del('renewal_offers', 'org_id=? AND property_id=?', o, p);
    del('move_checklists', `org_id=? AND lease_id IN (${L})`, o, o, p);
    del('pets', `org_id=? AND lease_id IN (${L})`, o, o, p);
    del('vehicles', `org_id=? AND lease_id IN (${L})`, o, o, p);
    del('insurance_policies', 'org_id=? AND property_id=?', o, p);
    del('deposit_alternatives', 'org_id=? AND property_id=?', o, p);
    del('guaranty_contracts', 'org_id=? AND property_id=?', o, p);
    del('household_requests', 'org_id=? AND property_id=?', o, p);
    del('amenity_reservations', 'org_id=? AND property_id=?', o, p);
    del('amenity_spaces', 'org_id=? AND property_id=?', o, p);
    del('announcements', 'org_id=? AND property_id=?', o, p); // org-wide (NULL) announcements stay

    // ---- communications (org-wide templates/messages stay) ----
    del('thread_notes',
      `org_id=? AND thread_id IN (SELECT id FROM threads WHERE org_id=? AND (property_id=? OR (person_kind='resident' AND person_id IN ${inDead})))`,
      o, o, p, ...deadResidents);
    del('threads', `org_id=? AND (property_id=? OR (person_kind='resident' AND person_id IN ${inDead}))`, o, p, ...deadResidents);
    del('outbox_messages', `org_id=? AND (property_id=? OR person_id IN ${inDead})`, o, p, ...deadResidents);
    del('comm_prefs', `org_id=? AND person_kind='resident' AND person_id IN ${inDead}`, o, ...deadResidents);
    del('mass_recipients', `org_id=? AND (lease_id IN (${L}) OR resident_id IN ${inDead})`, o, o, p, ...deadResidents);
    del('message_templates', 'org_id=? AND property_id=?', o, p);
    del('lease_templates', 'org_id=? AND property_id=?', o, p);
    del('criteria_versions', 'org_id=? AND property_id=?', o, p);
    del('settings', 'org_id=? AND property_id=?', o, p);
    del('statement_packets', 'org_id=? AND property_id=?', o, p);
    del('ai_actions', 'org_id=? AND property_id=?', o, p);

    // ---- ownership & reserves (owners themselves are org-level and stay) ----
    del('reserve_draws', 'org_id=? AND property_id=?', o, p);
    del('reserve_plans', 'org_id=? AND property_id=?', o, p);
    del('property_owners', 'org_id=? AND property_id=?', o, p);

    // ---- household spine, people, then the physical asset ----
    del('household_members', `org_id=? AND lease_id IN (${L})`, o, o, p);
    del('lease_charges', `org_id=? AND lease_id IN (${L})`, o, o, p);
    del('residents', `org_id=? AND id IN ${inDead}`, o, ...deadResidents);
    del('sessions', `user_id IN ${inDeadUsers}`, ...deadUsers);
    del('role_assignments', `org_id=? AND user_id IN ${inDeadUsers}`, o, ...deadUsers);
    del('users', `org_id=? AND kind='resident' AND id IN ${inDeadUsers}`, o, ...deadUsers);
    del('leases', 'org_id=? AND property_id=?', o, p);
    del('rentable_items', 'org_id=? AND property_id=?', o, p);
    del('units', 'org_id=? AND property_id=?', o, p);
    del('floorplans', 'org_id=? AND property_id=?', o, p);
    del('buildings', 'org_id=? AND property_id=?', o, p);
    del('properties', 'org_id=? AND id=?', o, p);

    audit(ctx, 'property', p, 'delete', { name: prop.name, slug: prop.slug }, { counts });
  });
  // Deferred to the OUTERMOST commit, not to this function returning: tx()
  // nests via savepoints, so when clearOrgData calls this inside its own
  // transaction, returning here is a savepoint release and an outer rollback
  // would restore these rows over bytes already gone.
  if (doomedBlobs.length) {
    counts.file_blobs = doomedBlobs.length;
    afterCommit(() => unlinkBlobs(doomedBlobs));
  }
  emit(ctx, 'property.deleted', 'property', p, { name: prop.name, counts });
  return { counts };
}

/** Empty the org's portfolio back to a fresh start — every property and
 * everything under it, plus the org-level things an onboarding leaves behind:
 * vendors and their price agreements, and the Migration Center's uploads with
 * their stored files.
 *
 * This exists for the onboarding loop. Getting a real portfolio in takes
 * several tries — a mis-mapped rent roll, a directory in the wrong format —
 * and clearing up after a bad attempt one property at a time is the kind of
 * chore that makes people stop testing and start living with bad data.
 *
 * What it keeps: the organization itself, staff accounts and their roles, the
 * chart of accounts, settings, and the audit trail — the trail is the record
 * that this happened and must outlive the data it describes.
 *
 * Deliberately `force`: this is the "I am starting over" button, so it clears
 * recorded payments and hand-posted entries too, which the per-property delete
 * refuses to touch. The typed org-name confirm on the route is the gate, and
 * demo orgs are refused outright — the seeded world is the public demo. */
export function clearOrgData(ctx: Ctx): { counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  const bump = (k: string, n: number): void => { if (n) counts[k] = (counts[k] || 0) + n; };
  const orgBlobs: string[] = [];

  tx(() => {
    for (const p of q<{ id: string }>('SELECT id FROM properties WHERE org_id=?', ctx.orgId)) {
      const { counts: c } = deleteProperty(ctx, p.id, { force: true });
      for (const [k, v] of Object.entries(c)) bump(k, v);
    }
    // org-level rows a property delete leaves standing, by design
    bump('vendor_price_agreements', run('DELETE FROM vendor_price_agreements WHERE org_id=?', ctx.orgId).changes);
    bump('vendors', run('DELETE FROM vendors WHERE org_id=?', ctx.orgId).changes);
    // Every stored byte the org owns. deleteProperty removes `files` ROWS and
    // never the blobs behind them, so by now the property loop has already
    // orphaned signed leases, ID scans and unit photos on disk. Sweep by
    // sha-less id: whatever row survives here is deleted with its bytes, and
    // any blob whose row the cascade already dropped is collected too.
    orgBlobs.push(...q<{ id: string }>('SELECT id FROM files WHERE org_id=?', ctx.orgId).map((f) => f.id));
    bump('files', run('DELETE FROM files WHERE org_id=?', ctx.orgId).changes);
    bump('import_batches', run('DELETE FROM import_batches WHERE org_id=?', ctx.orgId).changes);
    audit(ctx, 'org', ctx.orgId, 'clear_portfolio_data', null, counts);
  });
  // the property loop's blobs are already queued on the same commit hook
  if (orgBlobs.length) {
    bump('file_blobs', orgBlobs.length);
    afterCommit(() => unlinkBlobs(orgBlobs));
  }
  emit(ctx, 'org.data_cleared', 'org', ctx.orgId, { counts });
  return { counts };
}

export const UNIT_STATUSES = ['vacant_ready', 'vacant_not_ready', 'occupied', 'notice', 'down', 'model'] as const;
/** The statuses a human may set directly (M2.2). `occupied` and `notice` are
 * derived from lease events and never assigned by hand — a unit is occupied
 * because a lease says so, and letting the two disagree would make the rent
 * roll a matter of opinion. Every surface that offers a status change reads
 * this list, so the board, the unit page and the API cannot drift apart. */
export const MANUAL_UNIT_STATUSES: readonly string[] = ['vacant_ready', 'vacant_not_ready', 'down', 'model'];
export const UNIT_STATUS_LABELS: Record<string, string> = {
  vacant_ready: 'Vacant · ready',
  vacant_not_ready: 'Vacant · not ready',
  occupied: 'Occupied',
  notice: 'On notice',
  down: 'Down',
  model: 'Model',
};
