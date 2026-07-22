import { q, q1, insert } from '../db.ts';
import { id } from '../ids.ts';
import { nowIso, mkDate } from '../dates.ts';
import { Rng, GLOBAL_SEED } from '../rng.ts';
import { getDials } from './dials.ts';

/** SubmeterNetwork simulator (§5): deterministic monthly usage reads per
 * meter, seasonal by service, scaled by unit size, with dial-controlled
 * anomalies (spikes and missed reads). Idempotent per (meter, month). */

function strSeed(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return (h ^ GLOBAL_SEED) >>> 0;
}

/** seasonal factor per service (month 1-12) */
function season(service: string, m: number): number {
  if (service === 'electric') return [0.9, 0.85, 0.8, 0.85, 1.0, 1.25, 1.45, 1.4, 1.15, 0.9, 0.85, 0.95][m - 1]!;
  if (service === 'gas') return [1.5, 1.4, 1.2, 0.9, 0.6, 0.4, 0.35, 0.35, 0.5, 0.8, 1.2, 1.45][m - 1]!;
  if (service === 'water') return [0.9, 0.9, 0.95, 1.0, 1.1, 1.2, 1.25, 1.2, 1.1, 1.0, 0.9, 0.9][m - 1]!;
  return 1; // trash is flat
}

/** base monthly usage for a 850 sqft unit */
const BASE: Record<string, { qty: number; unit: string }> = {
  electric: { qty: 620, unit: 'kWh' },
  water: { qty: 2900, unit: 'gal' },
  gas: { qty: 34, unit: 'therms' },
  trash: { qty: 1, unit: 'svc' },
};

export function unitFor(service: string): string {
  return BASE[service]?.unit || 'units';
}

/** generate (idempotently) all reads for a usage month; returns rows added */
export function generateReads(orgId: string, usageMonth: string): number {
  const dials = getDials(orgId);
  const meters = q<any>(
    `SELECT m.*, u.sqft, u.status AS unit_status FROM meters m LEFT JOIN units u ON u.id=m.unit_id
     WHERE m.org_id=? AND m.active=1`,
    orgId,
  );
  const [y, mm] = [Number(usageMonth.slice(0, 4)), Number(usageMonth.slice(5, 7))];
  let added = 0;
  for (const m of meters) {
    if (q1('SELECT id FROM meter_reads WHERE meter_id=? AND month_key=?', m.id, usageMonth)) continue;
    const rng = new Rng(strSeed(`${m.id}:${usageMonth}`));
    const base = BASE[m.service] || BASE.electric!;
    const sqftScale = m.unit_id ? Math.max(0.5, (m.sqft || 850) / 850) : 6; // common meters run big
    // occupied units use full load; vacant ~18% (fridge, minimal HVAC)
    const occupancy = !m.unit_id ? 1 : rng.chance(0.93) ? 1 : 1; // per-month occupancy handled by RUBS, keep meter physical
    const vacantFactor = m.unit_id && m.unit_status?.startsWith('vacant') ? 0.18 : 1;
    let qty = base.qty * sqftScale * season(m.service, mm) * occupancy * vacantFactor * (1 + (rng.next() * 2 - 1) * 0.14);
    let anomaly: string | null = null;
    let status = 'ok';
    const anomalyRoll = rng.next() * 100;
    if (anomalyRoll < dials.meterAnomalyRatePct / 2) {
      qty = qty * rng.int(3, 6); // stuck-register spike
      anomaly = 'spike';
      status = 'review';
    } else if (anomalyRoll < dials.meterAnomalyRatePct) {
      qty = 0; // transmitter missed
      anomaly = 'missed';
      status = 'review';
    }
    insert('meter_reads', {
      id: id('mrd'), org_id: orgId, meter_id: m.id, month_key: usageMonth,
      read_date: mkDate(mm === 12 ? y + 1 : y, mm === 12 ? 1 : mm + 1, 1),
      usage_qty: Math.round(qty * 10) / 10, source: 'feed', anomaly, status, created_at: nowIso(),
    });
    added++;
  }
  return added;
}

/** provider rate per service (cents per unit) with a slow annual drift */
export function providerRate(service: string, usageMonth: string): number {
  const y = Number(usageMonth.slice(0, 4));
  const drift = 1 + (y - 2025) * 0.04;
  const base: Record<string, number> = { electric: 14.2, water: 1.1, gas: 118, trash: 0 };
  return (base[service] || 10) * drift;
}
