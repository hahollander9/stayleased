import { q, q1, insert, run, tx, j, js } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, addMonths, firstOfMonth } from '../../lib/dates.ts';
import { audit } from '../../lib/audit.ts';
import { emit } from '../../lib/events.ts';
import type { Ctx } from '../../lib/auth.ts';
import { canAccessProperty } from '../../lib/auth.ts';
import { createCharge } from '../m8_receivables/service.ts';
import { postBothBases } from '../m9_accounting/service.ts';
import { ensureBankAccounts } from '../m9_accounting/banking.ts';
import {
  extractRecord, moneyToCents, toIsoDate, normStatus, splitName, normVendorCategory,
  type Mapping, type ImportKind,
} from './mapping.ts';

/** Validation + transactional apply for Migration Center batches. Preview and
 * commit run the SAME validators; apply is one transaction — a batch lands
 * whole or not at all (per-row problems are surfaced in preview, and error
 * rows are skipped deterministically on commit). */

export interface BatchRow {
  id: string;
  org_id: string;
  kind: ImportKind | 'lease_pdf';
  filename: string | null;
  property_id: string | null;
  new_property_name: string | null;
  preset: string | null;
  headers: string;
  mapping: string;
  rows: string;
  staged: string;
  as_of: string | null;
  status: string;
  created_by: string;
}

export interface VRow {
  n: number; // 1-based data row number
  rec: Record<string, string>;
  level: 'ok' | 'warn' | 'error';
  notes: string[];
  /** computed plan for the apply step */
  plan?: Record<string, unknown>;
}

export interface Validation {
  rows: VRow[];
  ok: number;
  warn: number;
  error: number;
  /** property names resolved from the file (property-column imports) */
  properties: string[];
  blockers: string[]; // batch-level problems that prevent apply entirely
}

function tally(out: Validation, row: VRow): void {
  out.rows.push(row);
  if (row.level === 'error') out.error++;
  else if (row.level === 'warn') out.warn++;
  else out.ok++;
}

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

function uniquePropertySlug(base: string): string {
  let slug = slugify(base) || 'property';
  if (!q1('SELECT id FROM properties WHERE slug=?', slug)) return slug;
  for (let i = 2; i < 500; i++) {
    if (!q1('SELECT id FROM properties WHERE slug=?', `${slug}-${i}`)) return `${slug}-${i}`;
  }
  return `${slug}-${Date.now() % 100000}`;
}

export function ensureOpeningEquityAccount(orgId: string): void {
  if (!q1('SELECT id FROM gl_accounts WHERE org_id=? AND code=?', orgId, '3030')) {
    insert('gl_accounts', {
      id: id('gla'), org_id: orgId, code: '3030', name: 'Opening Balance Equity (conversion)',
      type: 'equity', is_control: null, active: 1, sort: 14,
    });
  }
}

// ---------- rent roll (the composite lane) ----------

interface RRPlan {
  propertyKey: string;
  unit: string;
  floorplanName: string;
  beds: number;
  baths: number;
  sqft: number;
  marketRentCents: number;
  occupied: boolean;
  unitStatus: string;
  existingUnitId?: string;
  tenants: { first: string; last: string; display: string }[];
  email: string | null;
  phone: string | null;
  rentCents: number;
  depositCents: number;
  balanceCents: number;
  leaseStart: string;
  leaseEnd: string;
  moveIn: string | null;
  mtm: boolean;
  onNotice: boolean;
}

export function validateRentRoll(ctx: Ctx, batch: BatchRow): Validation {
  const mapping = j<Mapping>(batch.mapping, { cols: {}, preset: null, aiAssisted: [] });
  const rows = j<string[][]>(batch.rows, []);
  const asOf = batch.as_of || ctx.businessDate;
  const out: Validation = { rows: [], ok: 0, warn: 0, error: 0, properties: [], blockers: [] };
  const mappedFields = new Set(Object.values(mapping.cols).filter(Boolean));

  if (!mappedFields.has('unit')) out.blockers.push('No column is mapped to “Unit number” — map it below.');
  const hasPropertyCol = mappedFields.has('property');
  if (!hasPropertyCol && !batch.property_id && !batch.new_property_name) {
    out.blockers.push('Choose a property to import into (or map a Property column).');
  }
  if (batch.property_id) {
    if (!canAccessProperty(ctx, batch.property_id)) out.blockers.push('That property is not in your portfolio.');
  }

  const seen = new Map<string, number>(); // propertyKey|unit → row n
  const propNames = new Set<string>();

  rows.forEach((raw, i) => {
    const n = i + 1;
    const rec = extractRecord(raw, mapping);
    const notes: string[] = [];
    let level: VRow['level'] = 'ok';
    const warn = (m: string): void => { notes.push(m); if (level === 'ok') level = 'warn'; };
    const fail = (m: string): void => { notes.push(m); level = 'error'; };

    const unit = (rec.unit || '').trim();
    if (!unit) {
      // skip obvious total/footer rows quietly when the row has no unit AND no tenant
      if (!rec.tenant && !rec.first_name) { fail('No unit number — row skipped.'); tally(out, { n, rec, level, notes }); return; }
      fail('Unit number is required.');
      tally(out, { n, rec, level, notes });
      return;
    }

    const propertyKey = hasPropertyCol ? (rec.property || '').trim() : (batch.property_id || `new:${batch.new_property_name}`);
    if (hasPropertyCol) {
      if (!rec.property) fail('Property column is empty for this row.');
      else propNames.add(rec.property.trim());
    }

    const dupKey = `${propertyKey}|${unit.toLowerCase()}`;
    if (seen.has(dupKey)) fail(`Duplicate of unit ${unit} on row ${seen.get(dupKey)}.`);
    else seen.set(dupKey, n);

    // tenant / occupancy
    let tenantName = (rec.tenant || '').trim();
    if (!tenantName && (rec.first_name || rec.last_name)) tenantName = `${rec.first_name || ''} ${rec.last_name || ''}`.trim();
    const vacantWords = /^(vacant|vacant.*|--|—|-)$/i.test(tenantName);
    if (vacantWords) tenantName = '';
    const st = normStatus(rec.status);
    const occupied = st === 'occupied' || st === 'notice' ? true : st === 'vacant' || st === 'down' ? false : !!tenantName;
    if (occupied && !tenantName) {
      warn('Marked occupied but no tenant name — importing the unit as vacant.');
    }

    // money
    const rentCents = moneyToCents(rec.rent);
    const marketRentCents = moneyToCents(rec.market_rent);
    const effRent = rentCents ?? marketRentCents ?? 0;
    if (occupied && tenantName) {
      if (rentCents === null && marketRentCents !== null) warn('No lease-rent column value — using market rent.');
      if (effRent <= 0) fail('Occupied row needs a rent amount (rent or market rent column).');
    }
    const depositCents = moneyToCents(rec.deposit) ?? 0;
    if (rec.deposit && moneyToCents(rec.deposit) === null) warn(`Couldn't read deposit “${rec.deposit}” — ignored.`);
    const balanceCents = moneyToCents(rec.balance) ?? 0;
    if (rec.balance && moneyToCents(rec.balance) === null) warn(`Couldn't read balance “${rec.balance}” — ignored.`);

    // dates
    const moveIn = toIsoDate(rec.move_in);
    let leaseStart = toIsoDate(rec.lease_start) || moveIn;
    let leaseEnd = toIsoDate(rec.lease_end);
    let mtm = false;
    if (occupied && tenantName) {
      if (!leaseStart) { leaseStart = asOf; warn('No lease-start date — using the switch date.'); }
      if (!leaseEnd) {
        if (/mtm|month/i.test(rec.lease_end || '')) mtm = true;
        leaseEnd = addMonths(leaseStart, 12);
        if (!mtm) warn('No lease-end date — assuming a 12-month term.');
      }
      if (leaseEnd < asOf) mtm = true; // expired term still in place = month-to-month
      if (leaseEnd < leaseStart) fail('Lease end is before lease start.');
    }

    // beds/baths/sqft/floorplan
    const beds = rec.beds ? parseInt(rec.beds, 10) : NaN;
    const baths = rec.baths ? parseFloat(rec.baths) : NaN;
    let floorplanName = (rec.floorplan || '').trim();
    const bb = floorplanName.match(/^(\d+)\s*(?:bd|br|bed)?\s*[x\/-]\s*(\d+(?:\.\d+)?)/i);
    const bedsF = Number.isFinite(beds) ? beds : bb ? parseInt(bb[1]!, 10) : 1;
    const bathsF = Number.isFinite(baths) ? baths : bb ? parseFloat(bb[2]!) : 1;
    if (!floorplanName) floorplanName = `${bedsF} bed / ${bathsF} bath`;
    const sqft = rec.sqft ? parseInt(String(rec.sqft).replace(/[^0-9]/g, ''), 10) || 750 : 750;

    // existing unit checks (only resolvable for a concrete target property)
    const plan: RRPlan = {
      propertyKey, unit, floorplanName, beds: bedsF, baths: bathsF, sqft,
      marketRentCents: marketRentCents ?? effRent, occupied: occupied && !!tenantName,
      unitStatus: occupied && tenantName ? (st === 'notice' ? 'notice' : 'occupied') : st === 'down' ? 'down' : 'vacant_ready',
      tenants: [], email: rec.email || null, phone: rec.phone || null,
      rentCents: effRent, depositCents, balanceCents,
      leaseStart: leaseStart || asOf, leaseEnd: leaseEnd || addMonths(asOf, 12), moveIn: moveIn || leaseStart || null,
      mtm, onNotice: st === 'notice',
    };
    if (tenantName && plan.occupied) {
      const parts = tenantName.split(/\s*(?:&| and )\s*/i).filter(Boolean).slice(0, 4);
      plan.tenants = parts.map((p) => splitName(p));
    }

    if (!hasPropertyCol && batch.property_id) {
      const existing = q1<any>('SELECT * FROM units WHERE property_id=? AND unit_number=?', batch.property_id, unit);
      if (existing) {
        const activeLease = q1(
          `SELECT id FROM leases WHERE unit_id=? AND status IN ('active','month_to_month','notice') LIMIT 1`, existing.id,
        );
        if (activeLease) fail(`Unit ${unit} already exists with an active lease — row skipped.`);
        else if (plan.occupied) { plan.existingUnitId = existing.id; warn(`Unit ${unit} already exists — the lease will be attached to it.`); }
        else fail(`Unit ${unit} already exists — row skipped.`);
      }
    }

    tally(out, { n, rec, level, notes, plan: plan as unknown as Record<string, unknown> });
  });

  out.properties = [...propNames];
  return out;
}

export interface ApplySummary {
  /** ids of every property touched/created (single-target redirects) */
  propertyIds?: string[];
  properties: number;
  units: number;
  residents: number;
  leases: number;
  vendors: number;
  balancesCents: number;
  depositsCents: number;
  skipped: number;
}

export function applyRentRoll(ctx: Ctx, batch: BatchRow): ApplySummary {
  const validation = validateRentRoll(ctx, batch);
  if (validation.blockers.length) throw new Error(validation.blockers.join(' '));
  const asOf = batch.as_of || ctx.businessDate;
  const billingStart = firstOfMonth(addMonths(asOf, 1));
  const summary: ApplySummary = { properties: 0, units: 0, residents: 0, leases: 0, vendors: 0, balancesCents: 0, depositsCents: 0, skipped: validation.error };

  tx(() => {
    ensureOpeningEquityAccount(ctx.orgId);

    // resolve target properties
    const propIds = new Map<string, string>(); // propertyKey → property id
    const mkProperty = (name: string): string => {
      const pid = id('prp');
      insert('properties', {
        id: pid, org_id: ctx.orgId, name, slug: uniquePropertySlug(name), type: 'multifamily',
        address1: '(address pending)', city: '—', state: '--', zip: '00000', timezone: 'America/Denver',
        phone: null, email: null, year_built: null, fiscal_year_start_month: 1, created_at: nowIso(),
      });
      summary.properties++;
      audit(ctx, 'property', pid, 'import_create', null, { name, batch: batch.id });
      return pid;
    };
    if (batch.property_id) propIds.set(batch.property_id, batch.property_id);
    if (batch.new_property_name) propIds.set(`new:${batch.new_property_name}`, mkProperty(batch.new_property_name));
    for (const name of validation.properties) {
      const existing = q1<{ id: string }>('SELECT id FROM properties WHERE org_id=? AND LOWER(name)=LOWER(?)', ctx.orgId, name.trim());
      propIds.set(name.trim(), existing?.id || mkProperty(name.trim()));
    }

    const fpCache = new Map<string, string>(); // pid|name → floorplan id
    const depositByProp = new Map<string, number>();

    for (const row of validation.rows) {
      if (row.level === 'error' || !row.plan) continue;
      const plan = row.plan as unknown as RRPlan;
      const pid = propIds.get(plan.propertyKey);
      if (!pid) continue;

      // floorplan
      const fpKey = `${pid}|${plan.floorplanName.toLowerCase()}`;
      let fid = fpCache.get(fpKey) || q1<{ id: string }>('SELECT id FROM floorplans WHERE property_id=? AND LOWER(name)=LOWER(?)', pid, plan.floorplanName)?.id;
      if (!fid) {
        fid = id('fpl');
        insert('floorplans', {
          id: fid, org_id: ctx.orgId, property_id: pid, name: plan.floorplanName,
          beds: plan.beds, baths: plan.baths, sqft: plan.sqft,
          market_rent_cents: plan.marketRentCents || plan.rentCents || 100000, created_at: nowIso(),
        });
      }
      fpCache.set(fpKey, fid);

      // unit
      let unitId = plan.existingUnitId;
      if (!unitId) {
        // property-column mode can hit existing units too — final safety check
        const existing = q1<any>('SELECT id FROM units WHERE property_id=? AND unit_number=?', pid, plan.unit);
        if (existing) {
          const activeLease = q1(`SELECT id FROM leases WHERE unit_id=? AND status IN ('active','month_to_month','notice') LIMIT 1`, existing.id);
          if (activeLease || !plan.occupied) { summary.skipped++; continue; }
          unitId = existing.id as string;
        }
      }
      if (!unitId) {
        unitId = id('unt');
        insert('units', {
          id: unitId, org_id: ctx.orgId, property_id: pid, building_id: null, floorplan_id: fid,
          unit_number: plan.unit, floor: 1, sqft: plan.sqft, status: plan.occupied ? 'occupied' : plan.unitStatus,
          market_rent_cents: plan.marketRentCents || plan.rentCents || 100000, amenities: '[]', notes: null, created_at: nowIso(),
        });
        summary.units++;
      }

      // household
      if (plan.occupied && plan.tenants.length) {
        const householdName = plan.tenants.map((t) => t.display).join(' & ');
        const leaseId = id('lse');
        insert('leases', {
          id: leaseId, org_id: ctx.orgId, property_id: pid, unit_id: unitId,
          household_name: householdName, status: plan.mtm ? 'month_to_month' : plan.onNotice ? 'notice' : 'active',
          start_date: plan.leaseStart, end_date: plan.leaseEnd, move_in_date: plan.moveIn,
          move_out_date: null, notice_date: null, mtm_since: plan.mtm ? (plan.leaseEnd < asOf ? plan.leaseEnd : asOf) : null,
          rent_cents: plan.rentCents, deposit_cents: plan.depositCents, deposit_alternative: 0,
          term_months: 12, application_id: null, renewal_of_lease_id: null, template_id: null,
          packet_file_id: null, esign_request_id: null, bed_label: null,
          billing_start_date: billingStart, created_at: nowIso(),
        });
        insert('lease_charges', {
          id: id('lch'), org_id: ctx.orgId, lease_id: leaseId, kind: 'rent', label: 'Rent',
          amount_cents: plan.rentCents, gl_account_code: null, rentable_item_id: null,
          start_date: billingStart, end_date: null, created_at: nowIso(),
        });
        run(`UPDATE units SET status=? WHERE id=?`, plan.onNotice ? 'notice' : 'occupied', unitId);

        plan.tenants.forEach((t, ti) => {
          const rid = id('res');
          insert('residents', {
            id: rid, org_id: ctx.orgId, property_id: pid, user_id: null,
            first_name: t.first || t.display, last_name: t.last, email: ti === 0 ? plan.email : null,
            phone: ti === 0 ? plan.phone : null, kind: 'adult', employer: null,
            monthly_income_cents: null, ssn_last4: null, created_at: nowIso(),
          });
          insert('household_members', {
            id: id('hm'), org_id: ctx.orgId, lease_id: leaseId, resident_id: rid,
            role: ti === 0 ? 'primary' : 'co', created_at: nowIso(),
          });
          summary.residents++;
        });
        summary.leases++;

        if (plan.balanceCents !== 0) {
          createCharge(ctx, {
            leaseId, kind: 'opening_balance',
            label: plan.balanceCents > 0 ? 'Opening balance (migrated)' : 'Opening credit (migrated)',
            amountCents: plan.balanceCents, date: asOf, dueDate: asOf, source: 'conversion',
            memo: `Balance carried in from prior system — ${householdName}`,
          });
          summary.balancesCents += plan.balanceCents;
        }
        if (plan.depositCents > 0) {
          depositByProp.set(pid, (depositByProp.get(pid) || 0) + plan.depositCents);
          summary.depositsCents += plan.depositCents;
        }
      }
    }

    // security deposits held: one conversion JE per property (both bases)
    for (const [pid, cents] of depositByProp) {
      postBothBases(ctx, {
        propertyId: pid, date: asOf, memo: 'Migrated security deposits held (conversion)',
        sourceKind: 'conversion', sourceId: batch.id,
        lines: [
          { account: '1020', debit: cents, memo: 'Security deposit cash carried in' },
          { account: '2100', credit: cents, memo: 'Security deposits held' },
        ],
      });
    }

    ensureBankAccounts(ctx.orgId); // every property gets an operating account row

    summary.propertyIds = [...new Set(propIds.values())];
    run('UPDATE import_batches SET status=?, applied_at=?, summary=? WHERE id=?', 'applied', nowIso(), js(summary), batch.id);
    audit(ctx, 'import_batch', batch.id, 'apply', null, summary as unknown as Record<string, unknown>);
  });
  emit(ctx, 'import.applied', 'import_batch', batch.id, { kind: batch.kind, ...summary });
  return summary;
}

// ---------- vendors ----------

export function validateVendors(ctx: Ctx, batch: BatchRow): Validation {
  const mapping = j<Mapping>(batch.mapping, { cols: {}, preset: null, aiAssisted: [] });
  const rows = j<string[][]>(batch.rows, []);
  const out: Validation = { rows: [], ok: 0, warn: 0, error: 0, properties: [], blockers: [] };
  const mapped = new Set(Object.values(mapping.cols).filter(Boolean));
  if (!mapped.has('name')) out.blockers.push('No column is mapped to “Vendor name”.');
  const seen = new Set<string>();
  rows.forEach((raw, i) => {
    const rec = extractRecord(raw, mapping);
    const notes: string[] = [];
    let level: VRow['level'] = 'ok';
    const name = (rec.name || '').trim();
    if (!name) { level = 'error'; notes.push('Vendor name is required.'); }
    else if (seen.has(name.toLowerCase())) { level = 'error'; notes.push('Duplicate vendor in file.'); }
    else if (q1('SELECT id FROM vendors WHERE org_id=? AND LOWER(name)=LOWER(?)', ctx.orgId, name)) {
      level = 'error'; notes.push('Vendor already exists.');
    }
    seen.add(name.toLowerCase());
    tally(out, { n: i + 1, rec, level, notes });
  });
  return out;
}

export function applyVendors(ctx: Ctx, batch: BatchRow): ApplySummary {
  const validation = validateVendors(ctx, batch);
  if (validation.blockers.length) throw new Error(validation.blockers.join(' '));
  const summary: ApplySummary = { properties: 0, units: 0, residents: 0, leases: 0, vendors: 0, balancesCents: 0, depositsCents: 0, skipped: validation.error };
  tx(() => {
    for (const row of validation.rows) {
      if (row.level === 'error') continue;
      const vid = id('ven');
      insert('vendors', {
        id: vid, org_id: ctx.orgId, name: row.rec.name!.trim(), category: normVendorCategory(row.rec.category),
        phone: row.rec.phone || null, email: row.rec.email || null, address: row.rec.address || null,
        tin_last4: null, w9_on_file: 0, is_1099: 1, coi_expiry: null, banking: null,
        diversity_tags: '[]', approved_property_ids: '[]', active: 1, created_at: nowIso(),
      });
      summary.vendors++;
    }
    run('UPDATE import_batches SET status=?, applied_at=?, summary=? WHERE id=?', 'applied', nowIso(), js(summary), batch.id);
    audit(ctx, 'import_batch', batch.id, 'apply', null, summary as unknown as Record<string, unknown>);
  });
  emit(ctx, 'import.applied', 'import_batch', batch.id, { kind: batch.kind, ...summary });
  return summary;
}

// ---------- additional residents (co-tenants / occupants onto existing leases) ----------

export function validateResidents(ctx: Ctx, batch: BatchRow): Validation {
  const mapping = j<Mapping>(batch.mapping, { cols: {}, preset: null, aiAssisted: [] });
  const rows = j<string[][]>(batch.rows, []);
  const out: Validation = { rows: [], ok: 0, warn: 0, error: 0, properties: [], blockers: [] };
  const mapped = new Set(Object.values(mapping.cols).filter(Boolean));
  if (!mapped.has('unit')) out.blockers.push('No column is mapped to “Unit number”.');
  if (!mapped.has('tenant') && !(mapped.has('first_name') || mapped.has('last_name'))) out.blockers.push('No name column is mapped.');
  if (!batch.property_id) out.blockers.push('Choose the property these residents belong to.');
  else if (!canAccessProperty(ctx, batch.property_id)) out.blockers.push('That property is not in your portfolio.');
  rows.forEach((raw, i) => {
    const rec = extractRecord(raw, mapping);
    const notes: string[] = [];
    let level: VRow['level'] = 'ok';
    const name = (rec.tenant || `${rec.first_name || ''} ${rec.last_name || ''}`).trim();
    if (!rec.unit) { level = 'error'; notes.push('Unit is required.'); }
    if (!name) { level = 'error'; notes.push('Name is required.'); }
    if (batch.property_id && rec.unit) {
      const unit = q1<{ id: string }>('SELECT id FROM units WHERE property_id=? AND unit_number=?', batch.property_id, rec.unit.trim());
      if (!unit) { level = 'error'; notes.push(`No unit “${rec.unit}” in that property.`); }
      else if (!q1(`SELECT id FROM leases WHERE unit_id=? AND status IN ('active','month_to_month','notice') LIMIT 1`, unit.id)) {
        level = 'error'; notes.push(`Unit ${rec.unit} has no active lease to attach to.`);
      }
    }
    tally(out, { n: i + 1, rec, level, notes });
  });
  return out;
}

export function applyResidents(ctx: Ctx, batch: BatchRow): ApplySummary {
  const validation = validateResidents(ctx, batch);
  if (validation.blockers.length) throw new Error(validation.blockers.join(' '));
  const summary: ApplySummary = { properties: 0, units: 0, residents: 0, leases: 0, vendors: 0, balancesCents: 0, depositsCents: 0, skipped: validation.error };
  tx(() => {
    for (const row of validation.rows) {
      if (row.level === 'error') continue;
      const unit = q1<{ id: string }>('SELECT id FROM units WHERE property_id=? AND unit_number=?', batch.property_id, row.rec.unit!.trim())!;
      const lease = q1<{ id: string }>(`SELECT id FROM leases WHERE unit_id=? AND status IN ('active','month_to_month','notice') ORDER BY created_at DESC LIMIT 1`, unit.id)!;
      const nm = splitName((row.rec.tenant || `${row.rec.first_name || ''} ${row.rec.last_name || ''}`).trim());
      const role = /guarantor/i.test(row.rec.role || '') ? 'guarantor' : /occupant|minor|child/i.test(row.rec.role || '') ? 'occupant' : 'co';
      const rid = id('res');
      insert('residents', {
        id: rid, org_id: ctx.orgId, property_id: batch.property_id, user_id: null,
        first_name: nm.first || nm.display, last_name: nm.last, email: row.rec.email || null, phone: row.rec.phone || null,
        kind: role === 'guarantor' ? 'guarantor' : role === 'occupant' ? 'occupant' : 'adult',
        employer: null, monthly_income_cents: null, ssn_last4: null, created_at: nowIso(),
      });
      insert('household_members', {
        id: id('hm'), org_id: ctx.orgId, lease_id: lease.id, resident_id: rid, role, created_at: nowIso(),
      });
      summary.residents++;
    }
    run('UPDATE import_batches SET status=?, applied_at=?, summary=? WHERE id=?', 'applied', nowIso(), js(summary), batch.id);
    audit(ctx, 'import_batch', batch.id, 'apply', null, summary as unknown as Record<string, unknown>);
  });
  emit(ctx, 'import.applied', 'import_batch', batch.id, { kind: batch.kind, ...summary });
  return summary;
}

// ---------- opening balances (onto existing leases) ----------

export function validateBalances(ctx: Ctx, batch: BatchRow): Validation {
  const mapping = j<Mapping>(batch.mapping, { cols: {}, preset: null, aiAssisted: [] });
  const rows = j<string[][]>(batch.rows, []);
  const out: Validation = { rows: [], ok: 0, warn: 0, error: 0, properties: [], blockers: [] };
  const mapped = new Set(Object.values(mapping.cols).filter(Boolean));
  if (!mapped.has('unit')) out.blockers.push('No column is mapped to “Unit number”.');
  if (!mapped.has('balance')) out.blockers.push('No column is mapped to “Balance owed”.');
  if (!batch.property_id) out.blockers.push('Choose the property these balances belong to.');
  else if (!canAccessProperty(ctx, batch.property_id)) out.blockers.push('That property is not in your portfolio.');
  rows.forEach((raw, i) => {
    const rec = extractRecord(raw, mapping);
    const notes: string[] = [];
    let level: VRow['level'] = 'ok';
    const cents = moneyToCents(rec.balance);
    if (!rec.unit) { level = 'error'; notes.push('Unit is required.'); }
    if (cents === null) { level = 'error'; notes.push('Balance is not a readable amount.'); }
    else if (cents === 0) { level = 'error'; notes.push('Zero balance — nothing to carry in.'); }
    if (batch.property_id && rec.unit) {
      const unit = q1<{ id: string }>('SELECT id FROM units WHERE property_id=? AND unit_number=?', batch.property_id, rec.unit.trim());
      const lease = unit
        ? q1<{ id: string; household_name: string }>(`SELECT id, household_name FROM leases WHERE unit_id=? AND status IN ('active','month_to_month','notice') ORDER BY created_at DESC LIMIT 1`, unit.id)
        : undefined;
      if (!unit) { level = 'error'; notes.push(`No unit “${rec.unit}” in that property.`); }
      else if (!lease) { level = 'error'; notes.push(`Unit ${rec.unit} has no active lease.`); }
      else if (q1(`SELECT id FROM charges WHERE lease_id=? AND kind='opening_balance' LIMIT 1`, lease.id)) {
        level = 'error'; notes.push('This lease already has an opening balance.');
      } else if (rec.tenant && lease.household_name && !lease.household_name.toLowerCase().includes(splitName(rec.tenant).last.toLowerCase())) {
        notes.push(`Heads up: lease household is “${lease.household_name}”.`);
        if (level === 'ok') level = 'warn';
      }
    }
    tally(out, { n: i + 1, rec, level, notes });
  });
  return out;
}

export function applyBalances(ctx: Ctx, batch: BatchRow): ApplySummary {
  const validation = validateBalances(ctx, batch);
  if (validation.blockers.length) throw new Error(validation.blockers.join(' '));
  const asOf = batch.as_of || ctx.businessDate;
  const summary: ApplySummary = { properties: 0, units: 0, residents: 0, leases: 0, vendors: 0, balancesCents: 0, depositsCents: 0, skipped: validation.error };
  tx(() => {
    ensureOpeningEquityAccount(ctx.orgId);
    for (const row of validation.rows) {
      if (row.level === 'error') continue;
      const unit = q1<{ id: string }>('SELECT id FROM units WHERE property_id=? AND unit_number=?', batch.property_id, row.rec.unit!.trim())!;
      const lease = q1<{ id: string; household_name: string }>(`SELECT id, household_name FROM leases WHERE unit_id=? AND status IN ('active','month_to_month','notice') ORDER BY created_at DESC LIMIT 1`, unit.id)!;
      const cents = moneyToCents(row.rec.balance)!;
      createCharge(ctx, {
        leaseId: lease.id, kind: 'opening_balance',
        label: cents > 0 ? 'Opening balance (migrated)' : 'Opening credit (migrated)',
        amountCents: cents, date: asOf, dueDate: asOf, source: 'conversion',
        memo: `Balance carried in from prior system — ${lease.household_name}`,
      });
      summary.balancesCents += cents;
    }
    run('UPDATE import_batches SET status=?, applied_at=?, summary=? WHERE id=?', 'applied', nowIso(), js(summary), batch.id);
    audit(ctx, 'import_batch', batch.id, 'apply', null, summary as unknown as Record<string, unknown>);
  });
  emit(ctx, 'import.applied', 'import_batch', batch.id, { kind: batch.kind, ...summary });
  return summary;
}

/** one conversion JE for a property's operating bank balance (both bases) */
export function postBankOpeningBalance(ctx: Ctx, propertyId: string, cents: number, asOf: string): void {
  if (!canAccessProperty(ctx, propertyId)) throw new Error('property not in your portfolio');
  if (!Number.isInteger(cents) || cents === 0) throw new Error('enter a non-zero amount');
  ensureOpeningEquityAccount(ctx.orgId);
  ensureBankAccounts(ctx.orgId);
  postBothBases(ctx, {
    propertyId, date: asOf, memo: 'Opening operating bank balance (conversion)',
    sourceKind: 'conversion', sourceId: propertyId,
    lines: cents > 0
      ? [
          { account: '1010', debit: cents, memo: 'Bank balance carried in' },
          { account: '3030', credit: cents, memo: 'Opening balance equity' },
        ]
      : [
          { account: '3030', debit: -cents, memo: 'Opening balance equity' },
          { account: '1010', credit: -cents, memo: 'Bank balance carried in (overdrawn)' },
        ],
  });
  audit(ctx, 'property', propertyId, 'bank_opening_balance', null, { cents, asOf });
}
