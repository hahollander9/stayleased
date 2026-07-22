import { q, q1, insert, run, val, tx, update } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, addDays, addMonths, diffDays, fmtDate } from '../../lib/dates.ts';
import type { Ctx } from '../../lib/auth.ts';
import { emit } from '../../lib/events.ts';
import { audit } from '../../lib/audit.ts';
import { getSetting } from '../../lib/settings.ts';
import { registerJob } from '../../lib/jobs.ts';
import { notify } from '../../lib/templates.ts';
import { verifyPolicy } from '../../lib/sim/insurance.ts';
import { createCharge, leaseBalance } from '../m8_receivables/service.ts';
import { recordPayment, registerDepositAlternativeHook } from '../m8_receivables/payments.ts';
import { usd } from '../../lib/money.ts';

/** M12 — insurance & risk: compliance engine (third-party verification via the
 * InsuranceCarrier sim, master-policy enrollment, lapse → auto-enroll with
 * notices), deposit alternative with move-out claims, guaranty product,
 * incident/claims log. */

// ---------- compliance core ----------

export function requiredLiability(ctx: Ctx, propertyId: string): number {
  return getSetting<number>(ctx, 'required_liability_cents', propertyId);
}

export function activePolicy(ctx: Ctx, leaseId: string): any | null {
  return q1<any>(
    `SELECT * FROM insurance_policies WHERE lease_id=? AND status='active'
       AND (end_date IS NULL OR end_date >= ?) ORDER BY created_at DESC LIMIT 1`,
    leaseId, ctx.businessDate,
  );
}

export type Compliance = 'covered' | 'lapsing' | 'lapsed';

export function leaseCompliance(ctx: Ctx, leaseId: string): { state: Compliance; policy: any | null } {
  const p = activePolicy(ctx, leaseId);
  if (!p) return { state: 'lapsed', policy: null };
  if (p.end_date && diffDays(p.end_date, ctx.businessDate) <= 21) return { state: 'lapsing', policy: p };
  return { state: 'covered', policy: p };
}

function primaryContact(orgId: string, leaseId: string): any | null {
  return q1<any>(
    `SELECT r.*, l.property_id, p.name AS property_name FROM household_members hm
     JOIN residents r ON r.id=hm.resident_id JOIN leases l ON l.id=hm.lease_id JOIN properties p ON p.id=l.property_id
     WHERE hm.lease_id=? AND hm.role='primary' LIMIT 1`,
    leaseId,
  );
}

/** resident uploads a third-party policy → carrier verification (sim) */
export function submitPolicy(
  ctx: Ctx,
  input: { leaseId: string; carrier: string; policyNumber: string; liabilityCents: number; startDate: string; endDate: string; fileId?: string | null },
): { policyId: string; outcome: string } {
  const lease = q1<any>('SELECT * FROM leases WHERE id=? AND org_id=?', input.leaseId, ctx.orgId);
  if (!lease) throw new Error('lease not found');
  const required = requiredLiability(ctx, lease.property_id);
  const res = verifyPolicy(input.carrier, input.policyNumber, input.liabilityCents, required);
  const pid = id('pol');
  tx(() => {
    insert('insurance_policies', {
      id: pid, org_id: ctx.orgId, property_id: lease.property_id, lease_id: input.leaseId,
      kind: 'third_party', carrier: input.carrier, policy_number: input.policyNumber,
      liability_cents: input.liabilityCents, start_date: input.startDate, end_date: input.endDate,
      status: res.outcome === 'verified' ? 'active' : res.outcome === 'rejected' ? 'rejected' : 'pending_verification',
      verified_at: res.outcome === 'verified' ? nowIso() : null,
      file_id: input.fileId ?? null, source: 'upload', created_at: nowIso(),
    });
    // a verified upload replaces master enrollment (program fee stops next cycle)
    if (res.outcome === 'verified') {
      cancelMasterEnrollment(ctx, input.leaseId, 'third-party policy verified');
    }
  });
  const contact = primaryContact(ctx.orgId, input.leaseId);
  if (contact?.email) {
    notify(ctx, res.outcome === 'verified' ? 'insurance_verified' : res.outcome === 'rejected' ? 'insurance_rejected' : 'insurance_reminder', {
      email: contact.email, phone: contact.phone, name: `${contact.first_name} ${contact.last_name}`,
      propertyId: lease.property_id, entity: 'insurance_policy', entityId: pid, personId: contact.id,
    }, {
      first_name: contact.first_name, policy: input.policyNumber, carrier: input.carrier,
      end_date: fmtDate(input.endDate), reason: res.note, property: contact.property_name,
      required: usd(required), master_fee: usd(getSetting<number>(ctx, 'master_policy_fee_cents', lease.property_id)),
      when: 'is pending verification',
    });
  }
  emit(ctx, 'insurance.submitted', 'insurance_policy', pid, { leaseId: input.leaseId, outcome: res.outcome });
  audit(ctx, 'insurance_policy', pid, 'submit', null, { outcome: res.outcome, note: res.note });
  return { policyId: pid, outcome: res.outcome };
}

/** one-click master policy enrollment: policy row + monthly recurring charge line */
export function enrollMaster(ctx: Ctx, leaseId: string, source: 'enroll' | 'auto_enroll' = 'enroll'): string {
  const lease = q1<any>('SELECT * FROM leases WHERE id=? AND org_id=?', leaseId, ctx.orgId);
  if (!lease) throw new Error('lease not found');
  const existing = q1<any>(`SELECT id FROM insurance_policies WHERE lease_id=? AND kind='master' AND status='active'`, leaseId);
  if (existing) return existing.id as string;
  const fee = getSetting<number>(ctx, 'master_policy_fee_cents', lease.property_id);
  const pid = id('pol');
  tx(() => {
    insert('insurance_policies', {
      id: pid, org_id: ctx.orgId, property_id: lease.property_id, lease_id: leaseId,
      kind: 'master', carrier: 'Oriel Community Master Policy (sim)', policy_number: `MP-${leaseId.slice(-6).toUpperCase()}`,
      liability_cents: requiredLiability(ctx, lease.property_id), start_date: ctx.businessDate, end_date: null,
      status: 'active', verified_at: nowIso(), source, created_at: nowIso(),
    });
    if (!q1(`SELECT id FROM lease_charges WHERE lease_id=? AND kind='insurance'`, leaseId)) {
      insert('lease_charges', {
        id: id('lc'), org_id: ctx.orgId, lease_id: leaseId, kind: 'insurance',
        label: 'Community insurance program', amount_cents: fee, created_at: nowIso(),
      });
    }
    // first month posts immediately (recurring line covers the following cycles)
    createCharge(ctx, {
      leaseId, kind: 'insurance', label: 'Community insurance program (first month)', amountCents: fee,
      date: ctx.businessDate, dueDate: ctx.businessDate, monthKey: `ins-${ctx.businessDate.slice(0, 7)}`, source: 'recurring',
    });
  });
  emit(ctx, 'insurance.enrolled_master', 'insurance_policy', pid, { leaseId, source });
  audit(ctx, 'insurance_policy', pid, source === 'auto_enroll' ? 'auto_enroll' : 'enroll', null, { fee });
  return pid;
}

export function cancelMasterEnrollment(ctx: Ctx, leaseId: string, reason: string): void {
  const pol = q1<any>(`SELECT id FROM insurance_policies WHERE lease_id=? AND kind='master' AND status='active'`, leaseId);
  if (!pol) return;
  run(`UPDATE insurance_policies SET status='canceled' WHERE id=?`, pol.id);
  run(`DELETE FROM lease_charges WHERE lease_id=? AND kind='insurance'`, leaseId);
  audit(ctx, 'insurance_policy', pol.id, 'cancel_master', null, { reason });
}

/** daily compliance sweep: expire, remind (14/7/1), lapse → auto-enroll */
export function complianceSweep(ctx: Ctx, date: string): { lapsed: number; reminded: number; enrolled: number } {
  let lapsed = 0;
  let reminded = 0;
  let enrolled = 0;
  // expire policies whose end date passed
  for (const p of q<any>(
    `SELECT * FROM insurance_policies WHERE org_id=? AND status='active' AND end_date IS NOT NULL AND end_date < ?`,
    ctx.orgId, date,
  )) {
    run(`UPDATE insurance_policies SET status='lapsed' WHERE id=?`, p.id);
    lapsed++;
  }
  // pending verifications re-check (SLOW carrier queue)
  for (const p of q<any>(`SELECT * FROM insurance_policies WHERE org_id=? AND status='pending_verification'`, ctx.orgId)) {
    const required = requiredLiability(ctx, p.property_id);
    const res = verifyPolicy(p.carrier, p.policy_number.replace(/SLOW/i, ''), p.liability_cents, required);
    if (res.outcome === 'verified') {
      run(`UPDATE insurance_policies SET status='active', verified_at=? WHERE id=?`, nowIso(), p.id);
      cancelMasterEnrollment(ctx, p.lease_id, 'third-party policy verified');
    } else if (res.outcome === 'rejected') {
      run(`UPDATE insurance_policies SET status='rejected' WHERE id=?`, p.id);
    }
  }
  // reminders: policies inside the 14/7/1-day windows that haven't hit that stage
  const lapsing = q<any>(
    `SELECT ip.* FROM insurance_policies ip JOIN leases l ON l.id=ip.lease_id
     WHERE ip.org_id=? AND ip.status='active' AND ip.end_date IS NOT NULL
       AND ip.end_date >= ? AND ip.end_date <= date(?, '+14 days')
       AND l.status IN ('active','notice','month_to_month')
       AND NOT EXISTS (SELECT 1 FROM insurance_policies ip2 WHERE ip2.lease_id=ip.lease_id AND ip2.status='active'
                         AND ip2.id != ip.id AND (ip2.end_date IS NULL OR ip2.end_date > ip.end_date))`,
    ctx.orgId, date, date,
  );
  for (const policy of lapsing) {
    const days = diffDays(policy.end_date, date);
    const stage = days <= 1 ? 3 : days <= 7 ? 2 : 1;
    if (stage <= policy.reminder_stage) continue;
    const contact = primaryContact(ctx.orgId, policy.lease_id);
    const masterFee = usd(getSetting<number>(ctx, 'master_policy_fee_cents', policy.property_id));
    if (contact?.email) {
      notify(ctx, 'insurance_reminder', {
        email: contact.email, phone: contact.phone, name: `${contact.first_name} ${contact.last_name}`,
        propertyId: policy.property_id, entity: 'insurance_policy', entityId: policy.id, personId: contact.id,
      }, {
        first_name: contact.first_name, policy: policy.policy_number,
        when: `expires ${fmtDate(policy.end_date)} (${days} day${days === 1 ? '' : 's'})`,
        required: usd(requiredLiability(ctx, policy.property_id)), master_fee: masterFee, property: contact.property_name,
      });
      reminded++;
    }
    run('UPDATE insurance_policies SET reminder_stage=? WHERE id=?', stage, policy.id);
  }

  // auto-enroll: active leases with no valid coverage at all (set-based)
  const autoEnroll = getSetting<boolean>(ctx, 'auto_enroll_on_lapse');
  if (autoEnroll) {
    const uncovered = q<any>(
      `SELECT l.id, l.property_id FROM leases l
       WHERE l.org_id=? AND l.status IN ('active','notice','month_to_month')
         AND NOT EXISTS (SELECT 1 FROM insurance_policies ip WHERE ip.lease_id=l.id AND ip.status='active'
                           AND (ip.end_date IS NULL OR ip.end_date >= ?))`,
      ctx.orgId, date,
    );
    for (const lease of uncovered) {
      enrollMaster({ ...ctx, businessDate: date } as Ctx, lease.id, 'auto_enroll');
      enrolled++;
      const contact = primaryContact(ctx.orgId, lease.id);
      if (contact?.email) {
        notify(ctx, 'insurance_autoenroll', {
          email: contact.email, phone: contact.phone, name: `${contact.first_name} ${contact.last_name}`,
          propertyId: lease.property_id, entity: 'lease', entityId: lease.id, personId: contact.id,
        }, {
          first_name: contact.first_name, date: fmtDate(date),
          master_fee: usd(getSetting<number>(ctx, 'master_policy_fee_cents', lease.property_id)), property: contact.property_name,
        });
      }
    }
  }
  return { lapsed, reminded, enrolled };
}

export function complianceStats(ctx: Ctx, propertyId?: string | null): { covered: number; lapsing: number; lapsed: number; total: number; masterShare: number } {
  const leases = q<any>(
    `SELECT l.id FROM leases l WHERE l.org_id=? AND l.status IN ('active','notice','month_to_month')${propertyId ? ' AND l.property_id=?' : ''}`,
    ...(propertyId ? [ctx.orgId, propertyId] : [ctx.orgId]),
  );
  let covered = 0;
  let lapsing = 0;
  let lapsed = 0;
  let master = 0;
  for (const l of leases) {
    const { state, policy } = leaseCompliance(ctx, l.id);
    if (state === 'covered') covered++;
    else if (state === 'lapsing') lapsing++;
    else lapsed++;
    if (policy?.kind === 'master') master++;
  }
  return { covered, lapsing, lapsed, total: leases.length, masterShare: leases.length ? Math.round((master / leases.length) * 100) : 0 };
}

// ---------- deposit alternative (M12.3) ----------

export function enrollDepositAlternative(ctx: Ctx, leaseId: string, mode: 'monthly' | 'one_time'): string {
  const lease = q1<any>('SELECT * FROM leases WHERE id=? AND org_id=?', leaseId, ctx.orgId);
  if (!lease) throw new Error('lease not found');
  if (q1('SELECT id FROM deposit_alternatives WHERE lease_id=?', leaseId)) throw new Error('already enrolled');
  const held = val<number>(
    `SELECT COALESCE(SUM(amount_cents),0) FROM deposit_activity WHERE lease_id=?`, leaseId,
  ) || 0;
  if (held > 0) throw new Error('a traditional deposit is already held — release it first');
  const coverage = lease.deposit_cents || lease.rent_cents;
  const fee = mode === 'monthly' ? Math.max(500, Math.round(coverage * 0.015 / 100) * 100) : Math.round(coverage * 0.175 / 100) * 100;
  const altId = id('dal');
  tx(() => {
    insert('deposit_alternatives', {
      id: altId, org_id: ctx.orgId, property_id: lease.property_id, lease_id: leaseId,
      mode, fee_cents: fee, coverage_cents: coverage, status: 'active',
      enrolled_date: ctx.businessDate, created_at: nowIso(),
    });
    run('UPDATE leases SET deposit_alternative=1 WHERE id=?', leaseId);
    if (mode === 'monthly') {
      if (!q1(`SELECT id FROM lease_charges WHERE lease_id=? AND kind='deposit_alternative'`, leaseId)) {
        insert('lease_charges', {
          id: id('lc'), org_id: ctx.orgId, lease_id: leaseId, kind: 'deposit_alternative',
          label: 'Deposit alternative program', amount_cents: fee, created_at: nowIso(),
        });
      }
    } else if (lease.status !== 'draft') {
      createCharge(ctx, {
        leaseId, kind: 'deposit_alternative', label: 'Deposit alternative — one-time premium', amountCents: fee,
        date: ctx.businessDate, dueDate: ctx.businessDate, source: 'oneoff',
      });
    }
  });
  emit(ctx, 'deposit_alternative.enrolled', 'lease', leaseId, { mode, fee, coverage });
  audit(ctx, 'deposit_alternative', altId, 'enroll', null, { mode, fee, coverage });
  return altId;
}

/** at move-out: surety covers the final balance up to coverage; remainder stays
 * with the resident. Returns the claim amount. */
export function settleAlternativeClaim(ctx: Ctx, leaseId: string, date: string): number {
  const alt = q1<any>(`SELECT * FROM deposit_alternatives WHERE lease_id=? AND status='active'`, leaseId);
  if (!alt) return 0;
  const balance = leaseBalance(ctx, leaseId);
  const claim = Math.max(0, Math.min(balance, alt.coverage_cents));
  tx(() => {
    if (claim > 0) {
      recordPayment(ctx, {
        leaseId, amountCents: claim, method: 'credit', receivedDate: date,
        memo: `deposit alternative claim — ${alt.provider}`, creditFunding: '4110', suppressReceipt: true,
      });
    }
    run(`UPDATE deposit_alternatives SET status='claimed', claim_cents=?, claim_date=? WHERE id=?`, claim, date, alt.id);
  });
  emit(ctx, 'deposit_alternative.claimed', 'lease', leaseId, { claim, coverage: alt.coverage_cents });
  audit(ctx, 'deposit_alternative', alt.id, 'claim', null, { claim, balanceBefore: balance });
  return claim;
}

// ---------- guaranty product (M12.4) ----------

export function quoteGuaranty(ctx: Ctx, applicationId: string): { feeCents: number; rentCents: number } {
  const app = q1<any>('SELECT * FROM applications WHERE id=? AND org_id=?', applicationId, ctx.orgId);
  if (!app) throw new Error('application not found');
  const quote = q1<any>('SELECT * FROM quotes WHERE id=?', app.quote_id);
  const unit = app.unit_id ? q1<any>('SELECT * FROM units WHERE id=?', app.unit_id) : null;
  const rent = quote?.rent_cents || unit?.market_rent_cents || 150000;
  return { feeCents: Math.round(rent * 0.85 / 100) * 100, rentCents: rent };
}

export function attachGuaranty(ctx: Ctx, applicationId: string): string {
  const app = q1<any>('SELECT * FROM applications WHERE id=? AND org_id=?', applicationId, ctx.orgId);
  if (!app) throw new Error('application not found');
  const existing = q1<any>('SELECT id FROM guaranty_contracts WHERE application_id=?', applicationId);
  if (existing) return existing.id as string;
  const { feeCents } = quoteGuaranty(ctx, applicationId);
  const gid = id('gty');
  insert('guaranty_contracts', {
    id: gid, org_id: ctx.orgId, property_id: app.property_id, application_id: applicationId,
    fee_cents: feeCents, coverage_months: 6, status: 'active', created_at: nowIso(),
  });
  emit(ctx, 'guaranty.attached', 'application', applicationId, { feeCents });
  audit(ctx, 'guaranty_contract', gid, 'attach', null, { feeCents });
  return gid;
}

export function hasGuaranty(applicationId: string): boolean {
  return !!q1(`SELECT id FROM guaranty_contracts WHERE application_id=? AND status='active'`, applicationId);
}

// ---------- incidents / claims log (M12.5) ----------

export function logIncident(
  ctx: Ctx,
  input: { propertyId: string; unitId?: string | null; kind: string; date: string; description: string; estLossCents?: number },
): string {
  const iid = id('inc');
  insert('incidents', {
    id: iid, org_id: ctx.orgId, property_id: input.propertyId, unit_id: input.unitId ?? null,
    kind: input.kind, date: input.date, description: input.description,
    est_loss_cents: input.estLossCents || 0, claim_number: null, status: 'open',
    created_by: ctx.userName, created_at: nowIso(),
  });
  audit(ctx, 'incident', iid, 'log', null, { kind: input.kind });
  return iid;
}

registerDepositAlternativeHook(settleAlternativeClaim);

registerJob({
  key: 'insurance_compliance',
  name: 'Insurance compliance sweep',
  describe: 'Expires ended policies, re-checks pending verifications, sends 14/7/1-day lapse reminders, and force-places the master policy on lapse (per org setting).',
  run: (ctx, date) => {
    const r = complianceSweep(ctx, date);
    return `${r.lapsed} lapsed, ${r.reminded} reminded, ${r.enrolled} auto-enrolled`;
  },
});
