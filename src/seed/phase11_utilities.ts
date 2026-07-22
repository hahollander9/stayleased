import { q, q1, val, insert, run, js } from '../lib/db.ts';
import { id } from '../lib/ids.ts';
import { nowIso, addDays, addMonths, monthKey, fmtMonth } from '../lib/dates.ts';
import { sysCtx } from '../lib/auth.ts';
import { ensurePropertyMeters, ingestMonth, estimateRead, simulateProviderInvoices, saveRubsRun, postRubsRun } from '../modules/m11_utilities/service.ts';
import { enrollMaster, logIncident } from '../modules/m12_insurance/service.ts';
import { CARRIERS } from '../lib/sim/insurance.ts';
import { attachGuaranty } from '../modules/m12_insurance/service.ts';
import { computeScorecard } from '../modules/m5_screening/service.ts';
import type { SeedCtx } from './seed.ts';
import { log } from './seed.ts';

/** Phase 11 seed. Two stages:
 *  - setupUtilities(): runs BEFORE the money history — meters, RUBS configs,
 *    utility vendors, insurance policies + master enrollments (recurring
 *    lines bill through the real rent run), deposit alternatives.
 *  - historyHook(): runs at the start of every history month — ingests last
 *    month's reads, receives provider invoices into AP, posts RUBS charges
 *    so the same month's payments sweep them (convergent billing).
 *  - finishInsuranceRisk(): after history — lapsing/lapsed demo states,
 *    an auto-enrollment, a guaranty, incidents. */

const UTILITY_VENDORS: [string, string][] = [
  ['City Power & Light (sim)', 'power'],
  ['Metro Water & Sewer Authority (sim)', 'water'],
  ['Haulaway Disposal (sim)', 'haul'],
];

export function setupUtilities(s: SeedCtx): { vendorFor: (service: string) => string } {
  const ctx = sysCtx(s.orgId);
  const props = Object.fromEntries(
    q<any>('SELECT slug, id FROM properties WHERE org_id=?', s.orgId).map((p) => [p.slug, p.id]),
  ) as Record<string, string>;

  // dedicated utility provider vendors
  const vendorIds: Record<string, string> = {};
  for (const [name, key] of UTILITY_VENDORS) {
    const vid = id('vnd');
    insert('vendors', {
      id: vid, org_id: s.orgId, name, category: 'general', email: `billing@${key}.demo`,
      w9_on_file: 1, is_1099: 0, diversity_tags: '[]', approved_property_ids: '[]', active: 1, created_at: nowIso(),
    });
    vendorIds[key] = vid;
  }
  const vendorFor = (service: string): string =>
    service === 'trash' ? vendorIds.haul! : service === 'water' ? vendorIds.water! : vendorIds.power!;

  // meters: SR electric+water, FL electric — submetered/usage-visible services
  let meters = 0;
  meters += ensurePropertyMeters(s.orgId, props['summit-ridge']!, ['electric', 'water']);
  meters += ensurePropertyMeters(s.orgId, props['foundry-lofts']!, ['electric']);

  // RUBS configs (varied methods per §M11.3)
  const configs: [string, string, string, Partial<{ flat: number; common: number; admin: number }>][] = [
    [props['summit-ridge']!, 'water', 'occupants', { common: 10, admin: 350 }],
    [props['summit-ridge']!, 'trash', 'flat', { flat: 1200, admin: 0 }],
    [props['foundry-lofts']!, 'electric', 'submeter', { common: 6, admin: 300 }],
    [props['foundry-lofts']!, 'trash', 'flat', { flat: 1400, admin: 0 }],
    [props['cardinal-commons']!, 'water', 'sqft', { common: 12, admin: 250 }],
    [props['cardinal-commons']!, 'electric', 'flat', { flat: 3800, admin: 0 }],
  ];
  for (const [propId, service, method, o] of configs) {
    insert('rubs_configs', {
      id: id('rcf'), org_id: s.orgId, property_id: propId, service, method,
      flat_fee_cents: o.flat || 0, admin_fee_cents: o.admin ?? 300, common_deduct_pct: o.common ?? 0,
      bill_vacant: 0, active: 1,
    });
  }
  log(`utilities: ${meters} meters, ${configs.length} RUBS formulas, 3 provider vendors`);

  // ---------- insurance + deposit alternatives BEFORE history ----------
  const leases = q<any>(
    `SELECT l.*, p.slug FROM leases l JOIN properties p ON p.id=l.property_id
     WHERE l.org_id=? AND l.status IN ('active','notice','month_to_month') ORDER BY l.created_at`,
    s.orgId,
  );
  let thirdParty = 0;
  let master = 0;
  let alts = 0;
  leases.forEach((l, i) => {
    const rng = s.rng.fork(4000 + i);
    const roll = rng.next();
    if (roll < 0.68) {
      // verified third-party policy; end dates spread ahead (a few lapse soon)
      const months = rng.weighted([[1, 6], [2, 6], [4, 20], [7, 30], [10, 38]] as const);
      insert('insurance_policies', {
        id: id('pol'), org_id: s.orgId, property_id: l.property_id, lease_id: l.id,
        kind: 'third_party', carrier: rng.pick(CARRIERS), policy_number: `RS-${rng.int(1000000, 9999999)}`,
        liability_cents: rng.pick([10000000, 10000000, 30000000]), start_date: addMonths(s.businessDate, -rng.int(2, 11)),
        end_date: addDays(addMonths(s.businessDate, months), rng.int(-10, 10)),
        status: 'active', verified_at: nowIso(), source: 'upload', created_at: nowIso(),
      });
      thirdParty++;
    } else if (roll < 0.88) {
      // master policy from day one: recurring line bills through the rent run
      insert('insurance_policies', {
        id: id('pol'), org_id: s.orgId, property_id: l.property_id, lease_id: l.id,
        kind: 'master', carrier: 'Oriel Community Master Policy (sim)', policy_number: `MP-${l.id.slice(-6).toUpperCase()}`,
        liability_cents: 10000000, start_date: l.start_date, end_date: null,
        status: 'active', verified_at: nowIso(), source: 'enroll', created_at: nowIso(),
      });
      insert('lease_charges', {
        id: id('lc'), org_id: s.orgId, lease_id: l.id, kind: 'insurance',
        label: 'Community insurance program', amount_cents: 1450, created_at: nowIso(),
      });
      master++;
    }
    // ~12 deposit alternatives on newer leases (no deposit charged in history)
    if (alts < 12 && roll > 0.3 && roll < 0.42 && l.start_date > addMonths(s.businessDate, -13)) {
      insert('deposit_alternatives', {
        id: id('dal'), org_id: s.orgId, property_id: l.property_id, lease_id: l.id,
        mode: 'monthly', fee_cents: Math.max(500, Math.round((l.deposit_cents || l.rent_cents) * 0.015 / 100) * 100),
        coverage_cents: l.deposit_cents || l.rent_cents, status: 'active',
        enrolled_date: l.start_date, created_at: nowIso(),
      });
      insert('lease_charges', {
        id: id('lc'), org_id: s.orgId, lease_id: l.id, kind: 'deposit_alternative',
        label: 'Deposit alternative program', amount_cents: Math.max(500, Math.round((l.deposit_cents || l.rent_cents) * 0.015 / 100) * 100),
        created_at: nowIso(),
      });
      run('UPDATE leases SET deposit_alternative=1 WHERE id=?', l.id);
      alts++;
    }
  });

  // Maya (demo cast) keeps a clean verified policy regardless of the dice
  const maya = q1<any>(
    `SELECT l.id, l.property_id FROM leases l JOIN household_members hm ON hm.lease_id=l.id JOIN residents r ON r.id=hm.resident_id
     WHERE r.email='maya.torres@mail.demo' AND l.status='active' LIMIT 1`,
  );
  if (maya) {
    run('DELETE FROM insurance_policies WHERE lease_id=?', maya.id);
    run(`DELETE FROM lease_charges WHERE lease_id=? AND kind='insurance'`, maya.id);
    insert('insurance_policies', {
      id: id('pol'), org_id: s.orgId, property_id: maya.property_id, lease_id: maya.id,
      kind: 'third_party', carrier: 'Renters Shield Co.', policy_number: 'RS-5541209',
      liability_cents: 10000000, start_date: addMonths(s.businessDate, -5), end_date: addMonths(s.businessDate, 7),
      status: 'active', verified_at: nowIso(), source: 'upload', created_at: nowIso(),
    });
    thirdParty++;
  }

  log(`insurance: ${thirdParty} third-party policies, ${master} master enrollments, ${alts} deposit alternatives`);
  return { vendorFor };
}

/** two turnover (ended) leases used the alternative — their historical
 * dispositions then exercise the surety-claim path through the real pipeline */
export function markTurnoverAlternatives(s: SeedCtx) {
  return (endedLeases: any[]): void => {
    for (const l of endedLeases.slice(0, 2)) {
      insert('deposit_alternatives', {
        id: id('dal'), org_id: s.orgId, property_id: l.property_id, lease_id: l.id,
        mode: 'monthly', fee_cents: 2100, coverage_cents: l.deposit_cents || l.rent_cents, status: 'active',
        enrolled_date: l.start_date, created_at: nowIso(),
      });
      run('UPDATE leases SET deposit_alternative=1 WHERE id=?', l.id);
    }
  };
}

/** history hook: usage month = the month BEFORE `mk` */
export function utilitiesMonthHook(s: SeedCtx, vendorFor: (service: string) => string) {
  return (orgId: string, mk: string, monthStart: string): void => {
    const usageMonth = monthKey(addMonths(monthStart, -1));
    const ctx = sysCtx(orgId, monthStart);
    ingestMonth(ctx, usageMonth);
    // clean the anomaly queue for history months through the real estimation rule
    for (const r of q<any>(
      `SELECT mr.id FROM meter_reads mr WHERE mr.org_id=? AND mr.month_key=? AND mr.status='review'`,
      orgId, usageMonth,
    )) {
      estimateRead(ctx, r.id);
    }
    simulateProviderInvoices(ctx, usageMonth, vendorFor);
    const currentMk = monthKey(s.businessDate);
    for (const c of q<any>(`SELECT * FROM rubs_configs WHERE org_id=? AND active=1`, orgId)) {
      try {
        const runId = saveRubsRun(ctx, c.property_id, c.service, usageMonth);
        // leave one run in preview for the live demo: Cardinal water, latest month
        const isDemoPreview = mk === currentMk && c.service === 'water'
          && c.property_id === q1<any>(`SELECT id FROM properties WHERE slug='cardinal-commons'`)?.id;
        if (!isDemoPreview && q1<any>('SELECT status FROM rubs_runs WHERE id=?', runId)?.status === 'preview') {
          postRubsRun(ctx, runId, monthStart);
        }
      } catch { /* no invoice yet for that service (first month) */ }
    }
  };
}

/** after history: demo states that read well on the dashboards */
export function finishInsuranceRisk(s: SeedCtx): void {
  const ctx = sysCtx(s.orgId);

  // a handful of policies expiring in the reminder window (lapsing bucket)
  const soonCovered = q<any>(
    `SELECT ip.* FROM insurance_policies ip JOIN leases l ON l.id=ip.lease_id
     WHERE ip.org_id=? AND ip.status='active' AND ip.kind='third_party' AND l.status='active'
     ORDER BY ip.created_at LIMIT 4`,
    s.orgId,
  );
  soonCovered.forEach((p, i) => {
    run('UPDATE insurance_policies SET end_date=? WHERE id=?', addDays(s.businessDate, [3, 9, 14, 20][i] || 12), p.id);
  });

  // one historical lapse that force-placed into the master policy (with notice)
  const lapsed = q1<any>(
    `SELECT l.id FROM leases l WHERE l.org_id=? AND l.status='active'
       AND NOT EXISTS (SELECT 1 FROM insurance_policies ip WHERE ip.lease_id=l.id) LIMIT 1`,
    s.orgId,
  );
  if (lapsed) {
    insert('insurance_policies', {
      id: id('pol'), org_id: s.orgId, property_id: q1<any>('SELECT property_id FROM leases WHERE id=?', lapsed.id).property_id,
      lease_id: lapsed.id, kind: 'third_party', carrier: 'Allgood Mutual', policy_number: `RS-${s.rng.int(1000000, 9999999)}`,
      liability_cents: 10000000, start_date: addMonths(s.businessDate, -13), end_date: addDays(s.businessDate, -40),
      status: 'lapsed', verified_at: nowIso(), source: 'upload', created_at: nowIso(),
    });
    enrollMaster({ ...ctx, businessDate: addDays(s.businessDate, -38) }, lapsed.id, 'auto_enroll');
  }

  // guaranty on one approved-with-conditions application (rescues the scorecard)
  const condApp = q1<any>(
    `SELECT id FROM applications WHERE org_id=? AND status IN ('review','approved_conditions') AND recommendation='conditions' LIMIT 1`,
    s.orgId,
  );
  if (condApp) {
    attachGuaranty(ctx, condApp.id);
    const rec = computeScorecard(ctx, condApp.id);
    run('UPDATE applications SET recommendation=?, recommendation_detail=? WHERE id=?', rec.recommendation, js(rec), condApp.id);
    log('guaranty attached to a conditions application (scorecard rescued)');
  }

  // incident log
  const props = q<any>('SELECT id, slug FROM properties WHERE org_id=?', s.orgId);
  const pick = (slug: string): string => props.find((p) => p.slug === slug)?.id || props[0].id;
  const incidents: [string, string, string, number, string][] = [
    // [prop slug, kind, description, est loss, days ago]
    ['summit-ridge', 'water', 'Supply line failure in B-317 — mitigation complete, flooring replaced in two units below.', 1850000, '55'],
    ['foundry-lofts', 'injury', 'Visitor slip on pool deck; incident report filed, no medical transport. Deck resurfacing scheduled.', 0, '31'],
    ['cardinal-commons', 'theft', 'Package room breach over the weekend — locks rekeyed, camera coverage extended.', 78000, '17'],
    ['summit-ridge', 'liability', 'Demand letter re: vehicle damage claim in the garage (gate arm). Forwarded to carrier.', 240000, '9'],
    ['foundry-lofts', 'mold', 'Moisture reading behind W/D closet in L-214 during turn — remediation vendor engaged.', 65000, '4'],
  ];
  for (const [slug, kind, description, loss, daysAgo] of incidents) {
    logIncident({ ...ctx, businessDate: addDays(s.businessDate, -Number(daysAgo)) }, {
      propertyId: pick(slug), kind, date: addDays(s.businessDate, -Number(daysAgo)),
      description, estLossCents: loss,
    });
  }
  run(`UPDATE incidents SET status='closed' WHERE org_id=? AND est_loss_cents=0`, s.orgId);
  run(`UPDATE incidents SET status='monitoring' WHERE org_id=? AND kind='mold'`, s.orgId);
  log(`risk: ${incidents.length} incidents logged`);

  const runs = val<number>('SELECT COUNT(*) FROM rubs_runs WHERE org_id=?', s.orgId) || 0;
  const rubsCharges = val<number>(`SELECT COUNT(*) FROM charges WHERE org_id=? AND source='utility'`, s.orgId) || 0;
  log(`utilities history: ${runs} RUBS runs, ${rubsCharges} converged utility charges`);
}
