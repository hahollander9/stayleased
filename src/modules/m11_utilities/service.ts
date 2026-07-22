import { q, q1, insert, run, val, tx, update } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, addMonths, monthKey, lastOfMonth, firstOfMonth, diffDays, minDate, maxDate, fmtMonth, parts, mkDate } from '../../lib/dates.ts';
import type { Ctx } from '../../lib/auth.ts';
import { sysCtx } from '../../lib/auth.ts';
import { emit } from '../../lib/events.ts';
import { audit } from '../../lib/audit.ts';
import { registerJob } from '../../lib/jobs.ts';
import { generateReads, providerRate, unitFor } from '../../lib/sim/submeter.ts';
import { createInvoice, approveInvoice } from '../m9_accounting/ap.ts';
import { createCharge } from '../m8_receivables/service.ts';
import { usd } from '../../lib/money.ts';

/** M11 — utilities: meters + SubmeterNetwork reads with anomaly review,
 * provider invoices through AP, the RUBS engine (preview → approve → post
 * converged charges), vacant-unit cost recovery. */

export const UTILITY_GL: Record<string, string> = { electric: '5110', water: '5120', gas: '5130', trash: '5140' };
export const SERVICES = ['electric', 'water', 'gas', 'trash'] as const;

// ---------- meters ----------

export function ensurePropertyMeters(orgId: string, propertyId: string, services: string[]): number {
  let made = 0;
  const units = q<any>('SELECT id, unit_number FROM units WHERE property_id=? ORDER BY unit_number', propertyId);
  for (const service of services) {
    for (const u of units) {
      if (!q1('SELECT id FROM meters WHERE unit_id=? AND service=?', u.id, service)) {
        insert('meters', {
          id: id('mtr'), org_id: orgId, property_id: propertyId, unit_id: u.id, service,
          serial: `${service.slice(0, 1).toUpperCase()}${u.unit_number.replace(/\W/g, '')}-${propertyId.slice(-4)}`,
          multiplier: 1, active: 1, created_at: nowIso(),
        });
        made++;
      }
    }
    if (!q1('SELECT id FROM meters WHERE property_id=? AND unit_id IS NULL AND service=?', propertyId, service)) {
      insert('meters', {
        id: id('mtr'), org_id: orgId, property_id: propertyId, unit_id: null, service,
        serial: `${service.slice(0, 1).toUpperCase()}COMMON-${propertyId.slice(-4)}`, multiplier: 1, active: 1, created_at: nowIso(),
      });
      made++;
    }
  }
  return made;
}

// ---------- reads + estimation ----------

/** ingest a usage month from the SubmeterNetwork; estimate missed reads */
export function ingestMonth(ctx: Ctx, usageMonth: string): { added: number; anomalies: number } {
  const added = generateReads(ctx.orgId, usageMonth);
  const anomalies = val<number>(
    `SELECT COUNT(*) FROM meter_reads WHERE org_id=? AND month_key=? AND status='review'`,
    ctx.orgId, usageMonth,
  ) || 0;
  return { added, anomalies };
}

/** estimation rule: average of the last 3 clean months (fallback: service base) */
export function estimateRead(ctx: Ctx, readId: string): void {
  const r = q1<any>('SELECT * FROM meter_reads WHERE id=? AND org_id=?', readId, ctx.orgId);
  if (!r || r.status !== 'review') throw new Error('read is not in review');
  const avg = val<number>(
    `SELECT AVG(usage_qty) FROM (SELECT usage_qty FROM meter_reads
       WHERE meter_id=? AND status IN ('ok','estimated') AND month_key<? ORDER BY month_key DESC LIMIT 3)`,
    r.meter_id, r.month_key,
  );
  const est = Math.round((avg || 100) * 10) / 10;
  update('meter_reads', readId, { usage_qty: est, source: 'estimate', status: 'estimated', note: `estimated from trailing average (was ${r.usage_qty} — ${r.anomaly})` });
  audit(ctx, 'meter_read', readId, 'estimate', null, { was: r.usage_qty, now: est });
}

export function acceptRead(ctx: Ctx, readId: string): void {
  const r = q1<any>('SELECT * FROM meter_reads WHERE id=? AND org_id=?', readId, ctx.orgId);
  if (!r || r.status !== 'review') throw new Error('read is not in review');
  update('meter_reads', readId, { status: 'ok', note: `accepted after review (${r.anomaly})` });
  audit(ctx, 'meter_read', readId, 'accept');
}

// ---------- provider invoices (→ AP) ----------

export function recordProviderInvoice(
  ctx: Ctx,
  input: { propertyId: string; service: string; vendorId: string; usageMonth: string; totalCents: number; usageQty: number; weatherNote?: string },
): string {
  const existing = q1<any>(
    'SELECT id FROM utility_provider_invoices WHERE org_id=? AND property_id=? AND service=? AND usage_month=?',
    ctx.orgId, input.propertyId, input.service, input.usageMonth,
  );
  if (existing) return existing.id as string;
  const rate = input.usageQty > 0 ? (input.totalCents / input.usageQty / 100).toFixed(3) : '—';
  const invDate = mkDate(
    Number(input.usageMonth.slice(0, 4)) + (Number(input.usageMonth.slice(5, 7)) === 12 ? 1 : 0),
    Number(input.usageMonth.slice(5, 7)) === 12 ? 1 : Number(input.usageMonth.slice(5, 7)) + 1, 3,
  );
  const apId = createInvoice(ctx, {
    vendorId: input.vendorId, propertyId: input.propertyId,
    invoiceNumber: `${input.service.toUpperCase()}-${input.usageMonth}-${input.propertyId.slice(-4)}`,
    invoiceDate: invDate, memo: `${input.service} service — ${fmtMonth(input.usageMonth)}`, source: 'utility',
    lines: [{ glAccount: UTILITY_GL[input.service] || '5110', description: `${input.service} — ${fmtMonth(input.usageMonth)} (${input.usageQty} ${unitFor(input.service)})`, amountCents: input.totalCents }],
  });
  approveInvoice(ctx, apId);
  const upId = id('upi');
  insert('utility_provider_invoices', {
    id: upId, org_id: ctx.orgId, property_id: input.propertyId, service: input.service, vendor_id: input.vendorId,
    usage_month: input.usageMonth, total_cents: input.totalCents, usage_qty: input.usageQty,
    rate_note: `$${rate}/${unitFor(input.service)}`, weather_note: input.weatherNote || null,
    vendor_invoice_id: apId, created_at: nowIso(),
  });
  return upId;
}

/** deterministic estimate for services billed without submeters */
function estimateUsage(propertyId: string, service: string, usageMonth: string, unitCount: number): number {
  let h = 5381;
  for (const ch of propertyId + service + usageMonth) h = (Math.imul(h, 33) ^ ch.charCodeAt(0)) >>> 0;
  const jitter = 0.88 + ((h % 1000) / 1000) * 0.24;
  const perUnit: Record<string, number> = { electric: 610, water: 2850, gas: 33, trash: 1 };
  const m = Number(usageMonth.slice(5, 7));
  const seasonal = service === 'electric' ? (m >= 6 && m <= 9 ? 1.3 : 0.9) : service === 'gas' ? (m <= 3 || m === 12 ? 1.4 : 0.6) : 1;
  return (perUnit[service] || 100) * unitCount * seasonal * jitter;
}

/** simulate the month's provider invoices from metered usage (or an estimate
 * for services this property bills without submeters — RUBS still needs the
 * provider total). Only services with a RUBS config or meters get invoices. */
export function simulateProviderInvoices(ctx: Ctx, usageMonth: string, vendorFor: (service: string) => string): number {
  let made = 0;
  const props = q<any>(`SELECT id FROM properties WHERE org_id=?`, ctx.orgId);
  for (const { id: property_id } of props) {
    for (const service of SERVICES) {
      const metered = val<number>(
        `SELECT SUM(r.usage_qty * m.multiplier) FROM meter_reads r JOIN meters m ON m.id=r.meter_id
         WHERE m.property_id=? AND m.service=? AND r.month_key=? AND r.status IN ('ok','estimated')`,
        property_id, service, usageMonth,
      ) || 0;
      const hasRubs = !!q1('SELECT id FROM rubs_configs WHERE property_id=? AND service=? AND active=1', property_id, service);
      if (metered <= 0 && !hasRubs) continue;
      const unitCount = val<number>('SELECT COUNT(*) FROM units WHERE property_id=?', property_id) || 0;
      const usage = metered > 0 ? metered : estimateUsage(property_id, service, usageMonth, unitCount);
      const total = service === 'trash'
        ? unitCount * 850 // flat per-unit hauling contract
        : Math.round(usage * providerRate(service, usageMonth));
      recordProviderInvoice(ctx, {
        propertyId: property_id, service, vendorId: vendorFor(service), usageMonth,
        totalCents: Math.max(100, Math.round(total / 100) * 100), usageQty: Math.round(usage),
      });
      made++;
    }
  }
  return made;
}

// ---------- RUBS engine (M11.3) ----------

export interface RubsLine {
  unitId: string;
  unitNumber: string;
  leaseId: string | null;
  household: string | null;
  basisLabel: string;
  occupiedDays: number;
  monthDays: number;
  amountCents: number;
  adminFeeCents: number;
}

export interface RubsPreview {
  config: any;
  invoice: any;
  totalCents: number;
  commonCents: number;
  billableCents: number;
  recoveredCents: number;
  vacantCents: number;
  lines: RubsLine[];
}

/** allocation math — every unit's share of the month, occupancy-prorated */
export function rubsPreview(ctx: Ctx, propertyId: string, service: string, usageMonth: string): RubsPreview {
  const config = q1<any>('SELECT * FROM rubs_configs WHERE org_id=? AND property_id=? AND service=? AND active=1', ctx.orgId, propertyId, service);
  if (!config) throw new Error(`no RUBS configuration for ${service} at this property`);
  const invoice = q1<any>(
    'SELECT * FROM utility_provider_invoices WHERE org_id=? AND property_id=? AND service=? AND usage_month=?',
    ctx.orgId, propertyId, service, usageMonth,
  );
  if (!invoice) throw new Error(`no ${service} provider invoice recorded for ${fmtMonth(usageMonth)}`);

  const mStart = `${usageMonth}-01`;
  const mEnd = lastOfMonth(mStart);
  const monthDays = diffDays(mEnd, mStart) + 1;
  const units = q<any>('SELECT * FROM units WHERE property_id=? ORDER BY unit_number', propertyId);

  const totalCents = invoice.total_cents;
  const commonCents = Math.round((totalCents * config.common_deduct_pct) / 100 / 100) * 100;
  const billable = totalCents - commonCents;

  // per-unit weights by method
  interface W { unit: any; lease: any | null; occDays: number; weight: number; basis: string }
  const rows: W[] = [];
  for (const unit of units) {
    // the lease occupying this unit during the usage month (longest overlap wins)
    const lease = q1<any>(
      `SELECT l.*, MAX(MIN(julianday(?), julianday(COALESCE(l.move_out_date, l.end_date))) - MAX(julianday(?), julianday(l.start_date))) AS overlap
       FROM leases l WHERE l.unit_id=? AND l.status IN ('active','notice','month_to_month','ended','renewed')
         AND l.start_date <= ? AND COALESCE(l.move_out_date, l.end_date) >= ?
       GROUP BY l.unit_id HAVING overlap >= 0`,
      mEnd, mStart, unit.id, mEnd, mStart,
    );
    let occDays = 0;
    if (lease) {
      const from = maxDate(mStart, lease.start_date);
      const to = minDate(mEnd, lease.move_out_date || lease.end_date);
      occDays = Math.max(0, diffDays(to, from) + 1);
    }
    let weight = 0;
    let basis = '';
    if (config.method === 'submeter') {
      const usage = val<number>(
        `SELECT SUM(r.usage_qty) FROM meter_reads r JOIN meters m ON m.id=r.meter_id
         WHERE m.unit_id=? AND m.service=? AND r.month_key=? AND r.status IN ('ok','estimated')`,
        unit.id, service, usageMonth,
      ) || 0;
      weight = usage;
      basis = `${Math.round(usage)} ${unitFor(service)}`;
    } else if (config.method === 'occupants') {
      const occ = lease ? (val<number>('SELECT COUNT(*) FROM household_members WHERE lease_id=?', lease.id) || 1) : 0;
      weight = occ;
      basis = `${occ} occupant${occ === 1 ? '' : 's'}`;
    } else if (config.method === 'flat') {
      weight = 1;
      basis = 'flat fee';
    } else if (config.method === 'hybrid') {
      const usage = val<number>(
        `SELECT SUM(r.usage_qty) FROM meter_reads r JOIN meters m ON m.id=r.meter_id
         WHERE m.unit_id=? AND m.service=? AND r.month_key=? AND r.status IN ('ok','estimated')`,
        unit.id, service, usageMonth,
      ) || 0;
      weight = usage * 0.5 + (unit.sqft || 850) * 0.5;
      basis = `hybrid (${Math.round(usage)} ${unitFor(service)} · ${unit.sqft} sqft)`;
    } else {
      weight = unit.sqft || 850;
      basis = `${unit.sqft || 850} sqft`;
    }
    rows.push({ unit, lease, occDays, weight, basis });
  }

  const totalWeight = rows.reduce((s, r) => s + r.weight, 0) || 1;
  const lines: RubsLine[] = [];
  let recovered = 0;
  let vacant = 0;
  for (const r of rows) {
    const gross = config.method === 'flat'
      ? config.flat_fee_cents
      : Math.round((billable * r.weight) / totalWeight / 25) * 25;
    const occShare = Math.round((gross * r.occDays) / monthDays / 25) * 25;
    const vacShare = gross - occShare;
    if (r.lease && occShare > 0) {
      lines.push({
        unitId: r.unit.id, unitNumber: r.unit.unit_number, leaseId: r.lease.id, household: r.lease.household_name,
        basisLabel: `${r.basis} · ${r.occDays}/${monthDays} days`, occupiedDays: r.occDays, monthDays,
        amountCents: occShare, adminFeeCents: config.admin_fee_cents,
      });
      recovered += occShare;
    }
    if (vacShare > 0) {
      lines.push({
        unitId: r.unit.id, unitNumber: r.unit.unit_number, leaseId: null, household: null,
        basisLabel: `${r.basis} · vacant ${monthDays - r.occDays}/${monthDays} days`, occupiedDays: r.occDays, monthDays,
        amountCents: vacShare, adminFeeCents: 0,
      });
      vacant += vacShare;
    }
  }
  return { config, invoice, totalCents, commonCents, billableCents: billable, recoveredCents: recovered, vacantCents: vacant, lines };
}

/** persist a preview as a run (idempotent per property/service/month) */
export function saveRubsRun(ctx: Ctx, propertyId: string, service: string, usageMonth: string): string {
  const existing = q1<any>('SELECT id, status FROM rubs_runs WHERE org_id=? AND property_id=? AND service=? AND usage_month=?', ctx.orgId, propertyId, service, usageMonth);
  if (existing) return existing.id as string;
  const p = rubsPreview(ctx, propertyId, service, usageMonth);
  const runId = id('rub');
  tx(() => {
    insert('rubs_runs', {
      id: runId, org_id: ctx.orgId, property_id: propertyId, service, usage_month: usageMonth,
      provider_invoice_id: p.invoice.id, method: p.config.method, total_cents: p.totalCents,
      billable_cents: p.billableCents, recovered_cents: p.recoveredCents, vacant_cents: p.vacantCents,
      common_cents: p.commonCents, status: 'preview', created_at: nowIso(),
    });
    for (const l of p.lines) {
      insert('rubs_lines', {
        id: id('rbl'), org_id: ctx.orgId, run_id: runId, unit_id: l.unitId, lease_id: l.leaseId,
        basis_label: l.basisLabel, occupied_days: l.occupiedDays, month_days: l.monthDays,
        amount_cents: l.amountCents, admin_fee_cents: l.adminFeeCents, created_at: nowIso(),
      });
    }
  });
  return runId;
}

/** approval → converged charges post to resident ledgers (M8), itemized */
export function postRubsRun(ctx: Ctx, runId: string, chargeDate?: string): { charges: number; recovered: number } {
  const runRow = q1<any>('SELECT * FROM rubs_runs WHERE id=? AND org_id=?', runId, ctx.orgId);
  if (!runRow) throw new Error('run not found');
  if (runRow.status === 'posted') throw new Error('run already posted');
  const date = chargeDate || ctx.businessDate;
  const label = `${runRow.service[0]!.toUpperCase()}${runRow.service.slice(1)} (RUBS) — ${fmtMonth(runRow.usage_month)}`;
  let charges = 0;
  let recovered = 0;
  tx(() => {
    for (const l of q<any>('SELECT * FROM rubs_lines WHERE run_id=? AND lease_id IS NOT NULL', runId)) {
      const total = l.amount_cents + l.admin_fee_cents;
      const chargeId = createCharge(ctx, {
        leaseId: l.lease_id, kind: 'utility',
        label: l.admin_fee_cents ? `${label} · ${usd(l.amount_cents)} + ${usd(l.admin_fee_cents)} billing fee` : label,
        amountCents: total, date, dueDate: date,
        monthKey: `rubs-${runRow.service}-${runRow.usage_month}`, source: 'utility',
      });
      run('UPDATE rubs_lines SET charge_id=? WHERE id=?', chargeId, l.id);
      charges++;
      recovered += total;
    }
    run(`UPDATE rubs_runs SET status='posted', posted_at=?, posted_by=? WHERE id=?`, nowIso(), ctx.userName, runId);
  });
  emit(ctx, 'rubs.posted', 'rubs_run', runId, { service: runRow.service, usageMonth: runRow.usage_month, charges });
  audit(ctx, 'rubs_run', runId, 'post', null, { charges, recovered });
  return { charges, recovered };
}

// ---------- vacant cost recovery report (M11.4) ----------

export function recoveryReport(ctx: Ctx, propertyId: string, monthsBack = 6): {
  months: string[];
  rows: { service: string; billed: number[]; recovered: number[]; vacant: number[]; common: number[] }[];
  vacantDetail: { month: string; unit: string; service: string; amount: number; days: string }[];
} {
  const months: string[] = [];
  for (let i = monthsBack - 1; i >= 0; i--) months.push(monthKey(addMonths(ctx.businessDate, -i - 1)));
  const rows: { service: string; billed: number[]; recovered: number[]; vacant: number[]; common: number[] }[] = [];
  for (const service of SERVICES) {
    const billed: number[] = [];
    const recovered: number[] = [];
    const vacant: number[] = [];
    const common: number[] = [];
    for (const m of months) {
      const r = q1<any>('SELECT * FROM rubs_runs WHERE property_id=? AND service=? AND usage_month=?', propertyId, service, m);
      billed.push(r?.total_cents || 0);
      recovered.push(r?.recovered_cents || 0);
      vacant.push(r?.vacant_cents || 0);
      common.push(r?.common_cents || 0);
    }
    if (billed.some((x) => x > 0)) rows.push({ service, billed, recovered, vacant, common });
  }
  const vacantDetail = q<any>(
    `SELECT r.usage_month, u.unit_number, r.service, l.amount_cents, l.occupied_days, l.month_days
     FROM rubs_lines l JOIN rubs_runs r ON r.id=l.run_id JOIN units u ON u.id=l.unit_id
     WHERE r.property_id=? AND l.lease_id IS NULL AND r.usage_month>=? ORDER BY r.usage_month DESC, u.unit_number LIMIT 40`,
    propertyId, months[0],
  ).map((x) => ({
    month: x.usage_month, unit: x.unit_number, service: x.service, amount: x.amount_cents,
    days: `${x.month_days - x.occupied_days}/${x.month_days} vacant days`,
  }));
  return { months, rows, vacantDetail };
}

// ---------- portal usage (M11.5) ----------

export function unitUsage(ctx: Ctx, unitId: string, service: string, monthsBack = 12): { months: string[]; mine: number[]; community: number[] } {
  const months: string[] = [];
  for (let i = monthsBack - 1; i >= 0; i--) months.push(monthKey(addMonths(ctx.businessDate, -i - 1)));
  const propId = q1<any>('SELECT property_id FROM units WHERE id=?', unitId)?.property_id;
  const mine: number[] = [];
  const community: number[] = [];
  for (const m of months) {
    mine.push(val<number>(
      `SELECT SUM(r.usage_qty) FROM meter_reads r JOIN meters mt ON mt.id=r.meter_id
       WHERE mt.unit_id=? AND mt.service=? AND r.month_key=? AND r.status IN ('ok','estimated')`,
      unitId, service, m,
    ) || 0);
    community.push(Math.round(val<number>(
      `SELECT AVG(t.total) FROM (
        SELECT SUM(r.usage_qty) AS total FROM meter_reads r JOIN meters mt ON mt.id=r.meter_id
        WHERE mt.property_id=? AND mt.service=? AND mt.unit_id IS NOT NULL AND r.month_key=? AND r.status IN ('ok','estimated')
        GROUP BY mt.unit_id) t`,
      propId, service, m,
    ) || 0));
  }
  return { months, mine, community };
}

// ---------- monthly cycle job ----------

registerJob({
  key: 'utility_cycle',
  name: 'Utility cycle (reads + provider invoices + RUBS previews)',
  describe: 'On the 3rd: ingests last month\'s SubmeterNetwork reads, receives provider invoices into AP, and stages RUBS runs for approval.',
  run: (ctx, date) => {
    if (parts(date).day < 3) return 'waits for the 3rd';
    const usageMonth = monthKey(addMonths(date, -1));
    if (val<number>(`SELECT COUNT(*) FROM rubs_runs WHERE org_id=? AND usage_month=?`, ctx.orgId, usageMonth)) return 'cycle already staged';
    const { added, anomalies } = ingestMonth(ctx, usageMonth);
    const vendors = q<any>(`SELECT id, name FROM vendors WHERE org_id=? AND active=1`, ctx.orgId);
    if (!vendors.length) return 'no utility vendor';
    const vendorFor = (service: string): string =>
      (vendors.find((v) => v.name.toLowerCase().includes(service === 'trash' ? 'haul' : service === 'water' ? 'water' : service === 'gas' ? 'gas' : 'power')) || vendors[0]).id;
    const invoices = simulateProviderInvoices(ctx, usageMonth, vendorFor);
    let previews = 0;
    for (const c of q<any>(`SELECT * FROM rubs_configs WHERE org_id=? AND active=1`, ctx.orgId)) {
      try {
        saveRubsRun(ctx, c.property_id, c.service, usageMonth);
        previews++;
      } catch { /* no invoice for that service */ }
    }
    return `${added} reads (${anomalies} to review), ${invoices} provider invoices, ${previews} RUBS previews staged`;
  },
});
