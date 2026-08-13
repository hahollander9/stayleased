import { q, q1, insert, run, tx, j, js } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, addMonths, firstOfMonth } from '../../lib/dates.ts';
import { audit } from '../../lib/audit.ts';
import { emit } from '../../lib/events.ts';
import type { Ctx } from '../../lib/auth.ts';
import { canAccessProperty } from '../../lib/auth.ts';
import { createCharge } from '../m8_receivables/service.ts';
import { ensurePortalAccess } from '../people/portal.ts';
import { postBothBases } from '../m9_accounting/service.ts';
import { ensureBankAccounts } from '../m9_accounting/banking.ts';
import {
  extractRecord, moneyToCents, toIsoDate, normStatus, splitName, normVendorCategory,
  classifyChargeCode,
  type Mapping, type ImportKind, type SourceSummary, type ChargeNature,
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

/** What the file adds up to — shown on the review screen and the applied
 * record so the operator can tie the import to the source report's own
 * summary page BEFORE anything applies. Born from the 2026-08-11 live run,
 * where $99k of deposits imported as $0 and a $14.50 mis-mapped column stood
 * in for $331k of balances with nothing on screen to catch either. */
export interface ImportRecon {
  units: number;
  occupied: number;
  rentCents: number;
  extraMonthlyCents: number;
  depositCents: number;
  balanceCents: number;
  moveOuts: number;
  /** batch-level mis-mapping heuristics ("every deposit is $0", …) */
  columnWarnings: string[];
  marketRentCents?: number;
  /** future residents/applicants the reader set aside (pending, not current) */
  futureApplicants?: number;
  /** line-by-line comparison against the report's own summary block */
  tieOuts?: TieOut[];
  /** the part of rentCents paid by vouchers, not by residents */
  subsidyCents?: number;
}

/** One row of the tie-out table: what the report says vs what we read. */
export interface TieOut {
  label: string;
  source: string;
  computed: string;
  ok: boolean;
}

function fmtMoney(c: number): string {
  return `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Compare the computed totals to the summary block the report printed about
 * itself. This is the check the 2026-08-11 live import didn't have: every
 * failure that run produced ($99k of deposits landing as $0, $331k of balances
 * standing in as $14.50) shows up here as a line that doesn't match, before
 * anything is written. It also caught the rent/extras split being $1,417 off
 * on the 2026-08-12 Livingston file while the monthly TOTAL still tied. */
export function tieOutToSource(recon: ImportRecon, source: SourceSummary, rentCode?: string, codeNature?: Record<string, ChargeNature>): TieOut[] {
  const out: TieOut[] = [];
  const num = (label: string, src: number | null, computed: number): void => {
    if (src === null) return;
    out.push({ label, source: String(src), computed: String(computed), ok: src === computed });
  };
  const money = (label: string, src: number | null, computed: number): void => {
    if (src === null) return;
    out.push({ label, source: fmtMoney(src), computed: fmtMoney(computed), ok: src === computed });
  };
  num('Units', source.units, recon.units);
  num('Occupied', source.occupiedUnits, recon.occupied);
  num('Future applicants', source.futureUnits, recon.futureApplicants ?? 0);
  if (recon.marketRentCents !== undefined) money('Market rent', source.marketRentCents, recon.marketRentCents);
  money('Monthly charges', source.leaseChargesCents, recon.rentCents + recon.extraMonthlyCents);
  // the split matters as much as the total: rent and "other monthly" post to
  // different accounts, so a total that ties with a split that doesn't is
  // still wrong money in the books
  const codes = Object.entries(source.chargeCodes);
  if (rentCode && codes.length) {
    // group the report's own per-code totals the same way the reader grouped
    // them: rent-nature codes (the tenant's portion plus any voucher) are the
    // contract rent, ancillary codes are the separate monthly charges
    const natureOf = (c: string): ChargeNature =>
      codeNature?.[c] ?? (c === rentCode ? 'rent' : classifyChargeCode(c, rentCode));
    const rentish = codes.filter(([c]) => natureOf(c) !== 'ancillary');
    const ancillary = codes.filter(([c]) => natureOf(c) === 'ancillary');
    const subsidy = codes.filter(([c]) => natureOf(c) === 'subsidy');
    if (rentish.length) {
      money(`Rent (${rentish.map(([c]) => c).join(' + ')})`, rentish.reduce((a, [, v]) => a + v, 0), recon.rentCents);
    }
    if (subsidy.length && recon.subsidyCents !== undefined) {
      money(`  …of which subsidy (${subsidy.map(([c]) => c).join(', ')})`, subsidy.reduce((a, [, v]) => a + v, 0), recon.subsidyCents);
    }
    if (ancillary.length) {
      money(`Other charges (${ancillary.map(([c]) => c).join(', ')})`, ancillary.reduce((a, [, v]) => a + v, 0), recon.extraMonthlyCents);
    }
  }
  money('Deposits held', source.depositCents, recon.depositCents);
  money('Balances owed', source.balanceCents, recon.balanceCents);
  return out;
}

export interface Validation {
  rows: VRow[];
  ok: number;
  warn: number;
  error: number;
  /** property names resolved from the file (property-column imports) */
  properties: string[];
  blockers: string[]; // batch-level problems that prevent apply entirely
  /** rent-roll reconciliation strip (see ImportRecon) */
  recon?: ImportRecon;
  /** residents-lane mass-insert guard: explains at review, enforced at apply */
  duplicateGuard?: { inserts: number; matched: number; message: string };
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

/** A rent roll carries no address, so an imported property has no location to
 * derive a timezone from — and the old hardcoded 'America/Denver' put a
 * Washington DC building on Mountain time, which moves business-date rollover,
 * rent-due timing and every late-fee window by two hours. Inherit what the org
 * already operates in; only fall back to a constant for the very first property,
 * where there is genuinely nothing to go on. */
export function importTimezone(ctx: Ctx): string {
  const existing = q1<{ timezone: string }>(
    `SELECT timezone, COUNT(*) n FROM properties WHERE org_id=? AND timezone IS NOT NULL AND timezone<>''
      GROUP BY timezone ORDER BY n DESC LIMIT 1`, ctx.orgId,
  );
  return existing?.timezone || 'America/New_York';
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
  /** imported move-out date — previously dropped (the audit's :336 finding) */
  moveOut: string | null;
  /** harvested/mapped recurring non-rent charges (parking, pet, storage…) */
  extraMonthlyCents: number;
  /** the part of rentCents a voucher/housing authority pays, not the resident */
  subsidyCents: number;
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
  const headers = j<string[]>(batch.headers, []);
  const headerFor = (field: string): string => {
    const ci = Object.entries(mapping.cols).find(([, f]) => f === field)?.[0];
    return ci !== undefined ? (headers[Number(ci)] || `column ${Number(ci) + 1}`) : '';
  };
  // reconciliation accumulators (non-error rows only — what would apply)
  const recon: ImportRecon = {
    units: 0, occupied: 0, rentCents: 0, extraMonthlyCents: 0, depositCents: 0, balanceCents: 0, moveOuts: 0,
    columnWarnings: [], marketRentCents: 0, subsidyCents: 0, futureApplicants: mapping.excluded?.futureApplicants ?? 0,
  };
  const colStats = { deposit: { zero: 0, freq: new Map<number, number>() }, balance: { zero: 0, freq: new Map<number, number>() } };
  const rentFreq = new Map<number, number>(); // occupied-row rent value → count

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
    // a digit-less "unit" with no tenant is a section or summary label that
    // leaked into the unit column ("Future Residents/Applicants", "Summary
    // Groups") — skip it instead of creating a unit named after it
    if (!/\d/.test(unit) && !rec.tenant && !rec.first_name) {
      fail('Looks like a section or summary label — row skipped.');
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
    // read the extras first: a lease can legitimately bill $0 rent and still
    // bill real money (a voucher/subsidy unit, where the whole contract rent
    // sits under a non-rent charge code), so the "needs a rent amount" rule
    // has to know whether anything else is being billed
    const extraMonthlyCents = moneyToCents(rec.extra_monthly) ?? 0;
    if (rec.extra_monthly && moneyToCents(rec.extra_monthly) === null) warn(`Couldn't read other monthly charges “${rec.extra_monthly}” — ignored.`);
    // the subsidy is a slice OF the rent, never an addition to it
    let subsidyCents = moneyToCents(rec.subsidy) ?? 0;
    if (rec.subsidy && moneyToCents(rec.subsidy) === null) warn(`Couldn't read housing subsidy “${rec.subsidy}” — ignored.`);
    if (subsidyCents > 0 && subsidyCents > (rentCents ?? marketRentCents ?? 0)) {
      warn(`Housing subsidy ${fmtMoney(subsidyCents)} is larger than the rent — capped at the rent.`);
      subsidyCents = rentCents ?? marketRentCents ?? 0;
    }
    if (occupied && tenantName) {
      if (rentCents === null && marketRentCents !== null) warn('No lease-rent column value — using market rent.');
      if (effRent <= 0 && extraMonthlyCents > 0) {
        warn(`No rent charge — this lease bills ${fmtMoney(extraMonthlyCents)}/mo of other recurring charges only.`);
      } else if (effRent <= 0) {
        fail('Occupied row needs a rent amount (rent or market rent column).');
      }
    }
    const depositCents = moneyToCents(rec.deposit) ?? 0;
    if (rec.deposit && moneyToCents(rec.deposit) === null) warn(`Couldn't read deposit “${rec.deposit}” — ignored.`);
    const balanceCents = moneyToCents(rec.balance) ?? 0;
    if (rec.balance && moneyToCents(rec.balance) === null) warn(`Couldn't read balance “${rec.balance}” — ignored.`);

    // dates
    const moveIn = toIsoDate(rec.move_in);
    const moveOut = toIsoDate(rec.move_out);
    if (rec.move_out && !moveOut) warn(`Couldn't read move-out date “${rec.move_out}” — ignored.`);
    if (moveOut && moveOut < asOf) warn(`Move-out ${moveOut} is before the switch date — imported on notice; end the lease after import.`);
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
      unitStatus: occupied && tenantName ? (st === 'notice' || moveOut ? 'notice' : 'occupied') : st === 'down' ? 'down' : 'vacant_ready',
      tenants: [], email: rec.email || null, phone: rec.phone || null,
      rentCents: effRent, depositCents, balanceCents,
      leaseStart: leaseStart || asOf, leaseEnd: leaseEnd || addMonths(asOf, 12), moveIn: moveIn || leaseStart || null,
      moveOut, extraMonthlyCents: extraMonthlyCents > 0 ? extraMonthlyCents : 0,
      subsidyCents: subsidyCents > 0 ? subsidyCents : 0,
      mtm, onNotice: st === 'notice' || (!!moveOut && occupied),
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
    // reconciliation accumulation — read the tallied level (closure mutations
    // above defeat TS narrowing on the local)
    if (out.rows[out.rows.length - 1]!.level !== 'error') {
      recon.units++;
      recon.marketRentCents = (recon.marketRentCents ?? 0) + (marketRentCents ?? 0);
      if (plan.occupied) {
        recon.occupied++;
        recon.rentCents += plan.rentCents;
        rentFreq.set(plan.rentCents, (rentFreq.get(plan.rentCents) || 0) + 1);
      }
      recon.extraMonthlyCents += plan.extraMonthlyCents;
      recon.subsidyCents = (recon.subsidyCents ?? 0) + plan.subsidyCents;
      recon.depositCents += plan.depositCents;
      recon.balanceCents += plan.balanceCents;
      if (moveOut) recon.moveOuts++;
      for (const [field, cents] of [['deposit', depositCents], ['balance', balanceCents]] as const) {
        const s = colStats[field];
        if (cents === 0) s.zero++;
        else s.freq.set(cents, (s.freq.get(cents) || 0) + 1);
      }
    }
  });

  out.properties = [...propNames];

  // ---- column-level mis-mapping heuristics (batch warnings, not row noise)
  const fmt = (c: number): string => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  const source = mapping.source;
  for (const [field, label] of [['deposit', 'deposit'], ['balance', 'balance']] as const) {
    if (!mappedFields.has(field) || recon.units < 10) continue;
    const s = colStats[field];
    const nonzero = [...s.freq.values()].reduce((a, b) => a + b, 0);
    if (nonzero === 0) {
      // …unless the report itself says the total is zero. An all-$0 column is
      // the signature of a mis-mapping, but on a portfolio that genuinely
      // holds no deposits it is the truth, and crying wolf on a correct import
      // teaches operators to click past the warning that matters.
      const reported = field === 'deposit' ? source?.depositCents : source?.balanceCents;
      if (reported === 0) continue;
      recon.columnWarnings.push(`The ${label} column (mapped from “${headerFor(field)}”) produced $0 on every row — that mapping is probably wrong. ${field === 'deposit' ? 'Deposits held would import as nothing.' : 'Balances owed would import as nothing.'}`);
      continue;
    }
    // uniformity is only suspicious for balances: what people owe varies
    // organically, so 98 identical balances means a mis-mapped column — while
    // an identical deposit on every lease is just a deposit policy.
    const [topCents, topCount] = [...s.freq.entries()].sort((a, b) => b[1] - a[1])[0]!;
    if (field === 'balance' && nonzero >= 10 && topCount / nonzero >= 0.8) {
      recon.columnWarnings.push(`${topCount} of ${nonzero} non-zero ${label} values are identical (${fmt(topCents)}) — an identical ${label} on nearly every lease usually means the column is mis-mapped, not real data.`);
    }
  }
  for (const [cents, count] of [...rentFreq.entries()].sort((a, b) => b[1] - a[1])) {
    if (count >= 3 && cents > 0 && cents <= 50000) {
      recon.columnWarnings.push(`${count} occupied units import with rent ${fmt(cents)} — in block-format rent rolls a small identical “rent” is usually a recurring charge (parking, storage) sitting on the unit row, not the rent. Check those rows before applying.`);
      break; // one such warning is enough
    }
  }

  // ---- tie the strip out to the report's own summary block
  if (source) {
    recon.tieOuts = tieOutToSource(recon, source, mapping.rentCode?.code, mapping.codeNature);
    const off = recon.tieOuts.filter((t) => !t.ok);
    if (off.length) {
      recon.columnWarnings.push(
        `${off.length} line${off.length === 1 ? ' does' : 's do'} not tie to the summary block of the uploaded report: ` +
        `${off.map((t) => `${t.label} (report ${t.source}, read ${t.computed})`).join('; ')}. ` +
        `Fix the mapping before applying — the report is the authority here.`,
      );
    }
  }
  out.recon = recon;
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
  /** portal logins created + invite emails sent to imported primary residents */
  portalInvites?: number;
  /** existing residents whose email/phone were filled in by a directory import */
  contactUpdates?: number;
  /** signed-but-not-started leases created from a future-residents section */
  futureLeases?: number;
  /** exactly what each merge wrote onto an existing resident, so removing the
   * upload can put those fields back — but only where the value is still the
   * one the import wrote (anything edited since belongs to the operator now) */
  merges?: { residentId: string; email?: string; phone?: string }[];
  skipped: number;
  /** what the applied file added up to (rent rolls) — kept on the record so
   * the batch page can show it without re-validating post-apply */
  recon?: ImportRecon;
}

/** One display name may carry a couple: "Sasha Kim & Ben Kim". */
export function splitHousehold(name: string): { first: string; last: string; display: string }[] {
  return name.split(/\s*(?:&| and )\s*/i).filter(Boolean).slice(0, 4).map((p) => splitName(p));
}

/** "Beltran, Angel" and "Angel Beltran" are the same person. */
function nameKey(s: string): string {
  return splitName(String(s || '').trim()).display.toLowerCase().replace(/\s+/g, ' ');
}

/** Stamp a charge and the journal entry it posted with the upload that created
 * them. createCharge posts its entry with sourceKind='charge' and the charge id,
 * which is how the entry is found here. Removing the upload takes back both. */
function stampCharge(batchId: string, chargeId: string): void {
  run('UPDATE charges SET import_batch_id=? WHERE id=?', batchId, chargeId);
  run(`UPDATE journal_entries SET import_batch_id=? WHERE source_kind='charge' AND source_id=?`, batchId, chargeId);
}

/** Provision portal access and, when a login was actually minted, stamp it with
 * the upload — so removal can take back a login the import created (and only
 * one the import created; a pre-existing account merely gets linked). */
export function portalAccessFor(ctx: Ctx, batchId: string, residentId: string): boolean {
  const access = ensurePortalAccess(ctx, residentId);
  if (!access.invited) return false;
  if (access.userId) run('UPDATE users SET import_batch_id=? WHERE id=?', batchId, access.userId);
  return true;
}

export function applyRentRoll(ctx: Ctx, batch: BatchRow): ApplySummary {
  const validation = validateRentRoll(ctx, batch);
  if (validation.blockers.length) throw new Error(validation.blockers.join(' '));
  const mapping = j<Mapping>(batch.mapping, { cols: {}, preset: null, aiAssisted: [] });
  const asOf = batch.as_of || ctx.businessDate;
  const billingStart = firstOfMonth(addMonths(asOf, 1));
  const summary: ApplySummary = { properties: 0, units: 0, residents: 0, leases: 0, vendors: 0, balancesCents: 0, depositsCents: 0, skipped: validation.error, recon: validation.recon };

  tx(() => {
    ensureOpeningEquityAccount(ctx.orgId);

    // resolve target properties
    const propIds = new Map<string, string>(); // propertyKey → property id
    const mkProperty = (name: string): string => {
      const pid = id('prp');
      // the source system's own code for this property, when the document
      // named one — the key the next reconciliation joins on
      const sourceRef = mapping.sourceProperty && mapping.sourceProperty.name === name
        ? mapping.sourceProperty.code : null;
      insert('properties', {
        id: pid, org_id: ctx.orgId, name, slug: uniquePropertySlug(name), type: 'multifamily', import_batch_id: batch.id,
        source_ref: sourceRef,
        address1: '(address pending)', city: '—', state: '--', zip: '00000', timezone: importTimezone(ctx),
        phone: null, email: null, year_built: null, fiscal_year_start_month: 1, created_at: nowIso(),
      });
      summary.properties++;
      audit(ctx, 'property', pid, 'import_create', null, { name, batch: batch.id, source_ref: sourceRef });
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
          id: fid, org_id: ctx.orgId, property_id: pid, name: plan.floorplanName, import_batch_id: batch.id,
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
          id: unitId, org_id: ctx.orgId, property_id: pid, building_id: null, floorplan_id: fid, import_batch_id: batch.id,
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
          id: leaseId, org_id: ctx.orgId, property_id: pid, unit_id: unitId, import_batch_id: batch.id,
          household_name: householdName, status: plan.mtm ? 'month_to_month' : plan.onNotice ? 'notice' : 'active',
          start_date: plan.leaseStart, end_date: plan.leaseEnd, move_in_date: plan.moveIn,
          move_out_date: plan.moveOut, notice_date: null, mtm_since: plan.mtm ? (plan.leaseEnd < asOf ? plan.leaseEnd : asOf) : null,
          rent_cents: plan.rentCents, subsidy_cents: plan.subsidyCents, deposit_cents: plan.depositCents, deposit_alternative: 0,
          term_months: 12, application_id: null, renewal_of_lease_id: null, template_id: null,
          packet_file_id: null, esign_request_id: null, bed_label: null,
          billing_start_date: billingStart, created_at: nowIso(),
        });
        // The lease RENTS for plan.rentCents — that is the contract rent and
        // what every report, average and renewal is priced off. What the
        // RESIDENT owes is that less any voucher a housing authority pays, so
        // the recurring charge (which is what actually bills) carries only
        // their share. Billing the whole contract rent to the household would
        // invoice them for someone else's money.
        const tenantRentCents = Math.max(0, plan.rentCents - plan.subsidyCents);
        insert('lease_charges', {
          id: id('lch'), org_id: ctx.orgId, lease_id: leaseId, kind: 'rent',
          label: plan.subsidyCents > 0 ? 'Rent (resident portion)' : 'Rent', import_batch_id: batch.id,
          amount_cents: tenantRentCents, gl_account_code: null, rentable_item_id: null,
          source_code: mapping.rentCode?.code || null,
          start_date: billingStart, end_date: null, created_at: nowIso(),
        });
        if (plan.extraMonthlyCents > 0) {
          // parking/pet/storage lines folded in from the source file — billed
          // monthly alongside rent as their own charge line, never merged into it
          insert('lease_charges', {
            id: id('lch'), org_id: ctx.orgId, lease_id: leaseId, kind: 'other', label: 'Other recurring (imported)', import_batch_id: batch.id,
            amount_cents: plan.extraMonthlyCents, gl_account_code: null, rentable_item_id: null,
            source_code: null,
            start_date: billingStart, end_date: null, created_at: nowIso(),
          });
        }
        run(`UPDATE units SET status=? WHERE id=?`, plan.onNotice ? 'notice' : 'occupied', unitId);

        plan.tenants.forEach((t, ti) => {
          const rid = id('res');
          insert('residents', {
            id: rid, org_id: ctx.orgId, property_id: pid, user_id: null, import_batch_id: batch.id,
            first_name: t.first || t.display, last_name: t.last, email: ti === 0 ? plan.email : null,
            phone: ti === 0 ? plan.phone : null, kind: 'adult', employer: null,
            monthly_income_cents: null, ssn_last4: null, created_at: nowIso(),
          });
          insert('household_members', {
            id: id('hm'), org_id: ctx.orgId, lease_id: leaseId, resident_id: rid, import_batch_id: batch.id,
            role: ti === 0 ? 'primary' : 'co', created_at: nowIso(),
          });
          summary.residents++;
          // imported residents are residents: portal login + invite, day one
          if (ti === 0 && plan.email && portalAccessFor(ctx, batch.id, rid)) {
            summary.portalInvites = (summary.portalInvites || 0) + 1;
          }
        });
        summary.leases++;

        if (plan.balanceCents !== 0) {
          stampCharge(batch.id, createCharge(ctx, {
            leaseId, kind: 'opening_balance',
            label: plan.balanceCents > 0 ? 'Opening balance (migrated)' : 'Opening credit (migrated)',
            amountCents: plan.balanceCents, date: asOf, dueDate: asOf, source: 'conversion',
            memo: `Balance carried in from prior system — ${householdName}`,
          }));
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

    // ---- signed-but-not-started leases (the report's own future-residents
    // section). These were being dropped: 16 rows, every one a lease someone
    // has already signed, and their 16 units then read as "ready to lease" so
    // the dashboard offered availability that does not exist. They import as
    // fully-executed leases dated from their move-in, which the portfolio
    // stats already understand as a PRE-LEASE — so exposure falls, occupancy
    // does not move, and nothing bills until the lease actually starts.
    for (const raw of j<string[][]>(batch.staged, [])) {
      const rec = extractRecord(raw, mapping);
      const unit = (rec.unit || '').trim();
      const tenantName = (rec.tenant || '').trim();
      if (!unit || !tenantName || /^vacant$/i.test(tenantName)) continue;
      const pid = propIds.get(rec.property ? rec.property.trim() : (batch.property_id || `new:${batch.new_property_name}`));
      if (!pid) continue;
      const unitRow = q1<{ id: string; market_rent_cents: number }>(
        'SELECT id, market_rent_cents FROM units WHERE property_id=? AND unit_number=?', pid, unit,
      );
      if (!unitRow) { summary.skipped++; continue; }
      const start = toIsoDate(rec.move_in) || toIsoDate(rec.lease_start);
      const end = toIsoDate(rec.lease_end);
      if (!start) { summary.skipped++; continue; }
      // a future lease already on the books is not imported twice
      if (q1(`SELECT id FROM leases WHERE unit_id=? AND status='fully_executed' AND start_date=?`, unitRow.id, start)) continue;
      const rentCents = moneyToCents(rec.rent) || moneyToCents(rec.market_rent) || unitRow.market_rent_cents || 0;
      const leaseId = id('lse');
      insert('leases', {
        id: leaseId, org_id: ctx.orgId, property_id: pid, unit_id: unitRow.id, import_batch_id: batch.id,
        household_name: tenantName, status: 'fully_executed',
        start_date: start, end_date: end || addMonths(start, 12), move_in_date: start,
        move_out_date: null, notice_date: null, mtm_since: null,
        rent_cents: rentCents, subsidy_cents: 0, deposit_cents: moneyToCents(rec.deposit) ?? 0, deposit_alternative: 0,
        term_months: 12, application_id: null, renewal_of_lease_id: null, template_id: null,
        packet_file_id: null, esign_request_id: null, bed_label: null,
        // nothing bills before the lease starts
        billing_start_date: start, created_at: nowIso(),
      });
      insert('lease_charges', {
        id: id('lch'), org_id: ctx.orgId, lease_id: leaseId, kind: 'rent', label: 'Rent', import_batch_id: batch.id,
        amount_cents: rentCents, gl_account_code: null, rentable_item_id: null, source_code: null,
        start_date: start, end_date: null, created_at: nowIso(),
      });
      for (const [ti, t] of splitHousehold(tenantName).entries()) {
        const rid = id('res');
        insert('residents', {
          id: rid, org_id: ctx.orgId, property_id: pid, user_id: null, import_batch_id: batch.id,
          first_name: t.first || t.display, last_name: t.last, email: ti === 0 ? (rec.email || null) : null,
          phone: ti === 0 ? (rec.phone || null) : null, kind: 'adult', employer: null,
          source_ref: ti === 0 ? (rec.source_ref || null) : null,
          monthly_income_cents: null, ssn_last4: null, created_at: nowIso(),
        });
        insert('household_members', {
          id: id('hm'), org_id: ctx.orgId, lease_id: leaseId, resident_id: rid, import_batch_id: batch.id,
          role: ti === 0 ? 'primary' : 'co', created_at: nowIso(),
        });
        summary.residents++;
      }
      summary.futureLeases = (summary.futureLeases || 0) + 1;
    }

    ensureBankAccounts(ctx.orgId); // every property gets an operating account row

    // deposit conversion entries post with sourceId = this batch, on both bases
    run(`UPDATE journal_entries SET import_batch_id=? WHERE org_id=? AND source_kind='conversion' AND source_id=?`, batch.id, ctx.orgId, batch.id);
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

export function validateResidents(ctx: Ctx, batch: BatchRow, opts: { confirmDuplicates?: boolean } = {}): Validation {
  const mapping = j<Mapping>(batch.mapping, { cols: {}, preset: null, aiAssisted: [] });
  const rows = j<string[][]>(batch.rows, []);
  const out: Validation = { rows: [], ok: 0, warn: 0, error: 0, properties: [], blockers: [] };
  let inserts = 0; // rows that found the unit + lease but matched nobody on it
  let matched = 0; // rows that matched an existing household member by name
  const mapped = new Set(Object.values(mapping.cols).filter(Boolean));
  if (!mapped.has('unit')) out.blockers.push('No column is mapped to “Unit number”.');
  if (!mapped.has('tenant') && !(mapped.has('first_name') || mapped.has('last_name'))) out.blockers.push('No name column is mapped.');
  if (!batch.property_id) out.blockers.push('Choose the property these residents belong to.');
  else if (!canAccessProperty(ctx, batch.property_id)) out.blockers.push('That property is not in your portfolio.');
  rows.forEach((raw, i) => {
    const rec = extractRecord(raw, mapping);
    const notes: string[] = [];
    let level: VRow['level'] = 'ok';
    let plan: Record<string, unknown> | undefined;
    const name = (rec.tenant || `${rec.first_name || ''} ${rec.last_name || ''}`).trim();
    if (!rec.unit) { level = 'error'; notes.push('Unit is required.'); }
    if (!name) { level = 'error'; notes.push('Name is required.'); }
    if (batch.property_id && rec.unit && name) {
      const unit = q1<{ id: string }>('SELECT id FROM units WHERE property_id=? AND unit_number=?', batch.property_id, rec.unit.trim());
      const lease = unit
        ? q1<{ id: string }>(`SELECT id FROM leases WHERE unit_id=? AND status IN ('active','month_to_month','notice') ORDER BY created_at DESC LIMIT 1`, unit.id)
        : undefined;
      if (!unit) { level = 'error'; notes.push(`No unit “${rec.unit}” in that property.`); }
      else if (!lease) { level = 'error'; notes.push(`Unit ${rec.unit} has no active lease to attach to.`); }
      else {
        // directory rows usually name people the rent roll already created —
        // match them and MERGE contact info instead of duplicating the person
        const members = q<{ id: string; first_name: string; last_name: string; email: string | null; phone: string | null; role: string }>(
          `SELECT r.id, r.first_name, r.last_name, r.email, r.phone, hm.role FROM residents r
           JOIN household_members hm ON hm.resident_id=r.id WHERE hm.lease_id=?`, lease.id,
        );
        const match = members.find((m) => nameKey(`${m.first_name} ${m.last_name}`) === nameKey(name));
        if (match) {
          matched++;
          const newEmail = (rec.email || '').trim();
          const newPhone = (rec.phone || '').trim();
          const addsEmail = !!newEmail && !match.email;
          const addsPhone = !!newPhone && !match.phone;
          if (addsEmail || addsPhone) {
            notes.push(`Matches ${match.first_name} ${match.last_name} on the lease — ${[addsEmail ? 'email' : '', addsPhone ? 'phone' : ''].filter(Boolean).join(' and ')} will be added.`);
            plan = { mergeResidentId: match.id, memberRole: match.role, addsEmail };
          } else {
            level = 'error';
            notes.push(`${match.first_name} ${match.last_name} is already on the lease with this contact info — nothing to add.`);
          }
        } else {
          inserts++;
          notes.push(`No one on unit ${rec.unit}’s lease matches this name — will be added as a NEW person.`);
        }
      }
    }
    tally(out, { n: i + 1, rec, level, notes, plan });
  });

  // ---- mass-insert guard (2026-08-11 live run: 247 duplicates in one apply).
  // A directory that lists people the rent roll already created should MERGE;
  // when most rows would insert instead, the overwhelmingly likely cause is a
  // name-format mismatch between the two files, and applying would duplicate
  // the building. Explained here at review; enforced in applyResidents.
  if (inserts >= 10 && matched / Math.max(1, inserts + matched) < 0.5 && !opts.confirmDuplicates) {
    out.duplicateGuard = {
      inserts, matched,
      message: `${inserts} of ${inserts + matched} people in this file don’t match anyone on their unit’s lease, so they would be added as NEW residents. When a directory names people the rent roll already created, that usually means a name-format mismatch between the files — applying would duplicate the building’s residents. Spot-check a few rows below; if these really are new people, tick “Add them as new residents” beside Apply.`,
    };
  }
  return out;
}

export function applyResidents(ctx: Ctx, batch: BatchRow, opts: { confirmDuplicates?: boolean } = {}): ApplySummary {
  const validation = validateResidents(ctx, batch, opts);
  if (validation.blockers.length) throw new Error(validation.blockers.join(' '));
  if (validation.duplicateGuard) {
    throw new Error(`${validation.duplicateGuard.inserts} of ${validation.duplicateGuard.inserts + validation.duplicateGuard.matched} people don’t match anyone on their unit’s lease — applying would add them all as new residents. Tick “Add them as new residents” to confirm, or fix the mapping.`);
  }
  const summary: ApplySummary = { properties: 0, units: 0, residents: 0, leases: 0, vendors: 0, balancesCents: 0, depositsCents: 0, skipped: validation.error };
  tx(() => {
    for (const row of validation.rows) {
      if (row.level === 'error') continue;
      // merge path: the person already exists on the lease — fill in the
      // blanks and provision portal access if an email just arrived
      const merge = row.plan as { mergeResidentId?: string; memberRole?: string; addsEmail?: boolean } | undefined;
      if (merge?.mergeResidentId) {
        const newEmail = (row.rec.email || '').trim();
        const newPhone = (row.rec.phone || '').trim();
        const wrote: { residentId: string; email?: string; phone?: string } = { residentId: merge.mergeResidentId };
        if (newEmail) {
          const { changes } = run(`UPDATE residents SET email=? WHERE id=? AND (email IS NULL OR email='')`, newEmail, merge.mergeResidentId);
          if (changes) wrote.email = newEmail;
        }
        if (newPhone) {
          const { changes } = run(`UPDATE residents SET phone=? WHERE id=? AND (phone IS NULL OR phone='')`, newPhone, merge.mergeResidentId);
          if (changes) wrote.phone = newPhone;
        }
        // only fields this import actually filled are reversible later
        if (wrote.email || wrote.phone) (summary.merges ||= []).push(wrote);
        summary.contactUpdates = (summary.contactUpdates || 0) + 1;
        audit(ctx, 'resident', merge.mergeResidentId, 'import_contact_merge', null, { batch: batch.id, email: !!newEmail, phone: !!newPhone });
        if (merge.addsEmail && merge.memberRole !== 'occupant' && portalAccessFor(ctx, batch.id, merge.mergeResidentId)) {
          summary.portalInvites = (summary.portalInvites || 0) + 1;
        }
        continue;
      }
      const unit = q1<{ id: string }>('SELECT id FROM units WHERE property_id=? AND unit_number=?', batch.property_id, row.rec.unit!.trim())!;
      const lease = q1<{ id: string }>(`SELECT id FROM leases WHERE unit_id=? AND status IN ('active','month_to_month','notice') ORDER BY created_at DESC LIMIT 1`, unit.id)!;
      const nm = splitName((row.rec.tenant || `${row.rec.first_name || ''} ${row.rec.last_name || ''}`).trim());
      const role = /guarantor/i.test(row.rec.role || '') ? 'guarantor' : /occupant|minor|child/i.test(row.rec.role || '') ? 'occupant' : 'co';
      const rid = id('res');
      insert('residents', {
        id: rid, org_id: ctx.orgId, property_id: batch.property_id, user_id: null, import_batch_id: batch.id,
        first_name: nm.first || nm.display, last_name: nm.last, email: row.rec.email || null, phone: row.rec.phone || null,
        kind: role === 'guarantor' ? 'guarantor' : role === 'occupant' ? 'occupant' : 'adult',
        employer: null, monthly_income_cents: null, ssn_last4: null, created_at: nowIso(),
      });
      insert('household_members', {
        id: id('hm'), org_id: ctx.orgId, lease_id: lease.id, resident_id: rid, role, import_batch_id: batch.id, created_at: nowIso(),
      });
      summary.residents++;
      if (row.rec.email && role !== 'occupant' && portalAccessFor(ctx, batch.id, rid)) {
        summary.portalInvites = (summary.portalInvites || 0) + 1;
      }
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
      stampCharge(batch.id, createCharge(ctx, {
        leaseId: lease.id, kind: 'opening_balance',
        label: cents > 0 ? 'Opening balance (migrated)' : 'Opening credit (migrated)',
        amountCents: cents, date: asOf, dueDate: asOf, source: 'conversion',
        memo: `Balance carried in from prior system — ${lease.household_name}`,
      }));
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
