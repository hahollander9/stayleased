import { q1, run, insert, j, js } from '../db.ts';
import { nowIso } from '../dates.ts';

/** Simulator Console dials (M1.6): control simulator behavior at runtime. */

export interface Dials {
  nsfRatePct: number; // % of ACH payments that bounce
  cardDeclineRatePct: number;
  leadsPerDay: number; // ILS lead volume per property
  screeningMix: 'normal' | 'strict' | 'rosy'; // distribution of simulated bureau outcomes
  bankNoise: boolean; // add realistic noise to bank feed
  meterAnomalyRatePct: number;
  achSettleDays: number;
  clockHour: number; // simulated time of day (0-23) for quiet-hours enforcement
}

export const DEFAULT_DIALS: Dials = {
  nsfRatePct: 3,
  cardDeclineRatePct: 2,
  leadsPerDay: 2,
  screeningMix: 'normal',
  bankNoise: true,
  meterAnomalyRatePct: 4,
  achSettleDays: 3,
  clockHour: 14,
};

export function getDials(orgId: string): Dials {
  const row = q1<{ dials: string }>('SELECT dials FROM sim_state WHERE org_id=?', orgId);
  return row ? { ...DEFAULT_DIALS, ...j<Partial<Dials>>(row.dials, {}) } : { ...DEFAULT_DIALS };
}

export function setDials(orgId: string, patch: Partial<Dials>): Dials {
  const cur = getDials(orgId);
  const next = { ...cur, ...patch };
  const exists = q1('SELECT org_id FROM sim_state WHERE org_id=?', orgId);
  if (exists) run('UPDATE sim_state SET dials=?, updated_at=? WHERE org_id=?', js(next), nowIso(), orgId);
  else insert('sim_state', { org_id: orgId, dials: js(next), updated_at: nowIso() });
  return next;
}
