import { q, q1, insert, val, run, update, tx, j, js } from '../../lib/db.ts';
import { id, token } from '../../lib/ids.ts';
import { nowIso, addDays, fmtDate } from '../../lib/dates.ts';
import { usd } from '../../lib/money.ts';
import type { Ctx } from '../../lib/auth.ts';
import { sysCtx } from '../../lib/auth.ts';
import { emit } from '../../lib/events.ts';
import { getSetting } from '../../lib/settings.ts';
import { registerJob } from '../../lib/jobs.ts';
import { audit } from '../../lib/audit.ts';
import { sendEmail } from '../../lib/sim/messaging.ts';
import { resultFor } from '../../lib/sim/screening.ts';
import { postJE } from '../m9_accounting/service.ts';
import { Pdf } from '../../lib/pdf.ts';
import { putFile, getFile } from '../../lib/files.ts';
import { extractIncome } from '../../lib/sim/dococr.ts';

/** M5 services: application lifecycle, fees, screening orchestration,
 * household scorecard against versioned criteria, adverse action, unit holds. */

export interface Criteria {
  version: number;
  incomeMultiple: number;
  minCreditScore: number;
  conditionalCreditScore: number;
  evictionLookbackYears: number;
  felonyLookbackYears: number;
  conditionalDepositMultiplier: number;
}

/** snapshot criteria into a version row when contents change (M5.5) */
export function currentCriteriaVersion(ctx: Ctx, propertyId: string): { version: number; criteria: Criteria } {
  const criteria = getSetting<Criteria>(ctx, 'screening_criteria', propertyId);
  const pid = '';
  const latest = q1<any>(
    `SELECT * FROM criteria_versions WHERE org_id=? AND property_id=? ORDER BY version DESC LIMIT 1`,
    ctx.orgId, pid,
  );
  const body = js({ ...criteria, version: undefined });
  if (latest && latest.criteria === body) return { version: latest.version, criteria };
  const version = (latest?.version || 0) + 1;
  insert('criteria_versions', { id: id('crv'), org_id: ctx.orgId, property_id: pid, version, criteria: body, created_at: nowIso() });
  return { version, criteria };
}

export function createApplication(
  ctx: Ctx,
  opts: { propertyId: string; unitId: string; leadId?: string | null; quoteId?: string | null; termMonths?: number; moveIn?: string; rentCents?: number; primary: { firstName?: string; lastName?: string; email: string; phone?: string | null } },
): { applicationId: string; applicantToken: string } {
  const unit = q1<any>('SELECT * FROM units WHERE id=? AND org_id=?', opts.unitId, ctx.orgId);
  if (!unit) throw new Error('unit not found');
  const quote = opts.quoteId ? q1<any>('SELECT * FROM quotes WHERE id=?', opts.quoteId) : null;
  const appId = id('app');
  const appFee = getSetting<number>(ctx, 'application_fee_cents', unit.property_id);
  const holdDeposit = 25000; // holding deposit, credited at lease or refunded (DECISIONS.md)
  const applicantToken = token(18);
  tx(() => {
    insert('applications', {
      id: appId, org_id: ctx.orgId, property_id: unit.property_id, unit_id: unit.id,
      lead_id: opts.leadId || null, quote_id: opts.quoteId || null, status: 'draft',
      term_months: quote?.term_months || opts.termMonths || 12,
      move_in: quote?.move_in || opts.moveIn || addDays(ctx.businessDate, 21),
      rent_cents: quote?.rent_cents || opts.rentCents || unit.market_rent_cents,
      app_fee_cents: appFee, hold_deposit_cents: holdDeposit, created_at: nowIso(),
    });
    insert('applicants', {
      id: id('apl'), org_id: ctx.orgId, application_id: appId, kind: 'primary',
      first_name: opts.primary.firstName || '', last_name: opts.primary.lastName || '',
      email: opts.primary.email.toLowerCase(), phone: opts.primary.phone || null,
      invite_token: applicantToken, status: 'started', step: 1, created_at: nowIso(),
    });
  });
  if (opts.leadId) {
    run(`UPDATE leads SET status='applied', application_id=? WHERE id=? AND status NOT IN ('leased')`, appId, opts.leadId);
    insert('lead_events', {
      id: id('lev'), org_id: ctx.orgId, lead_id: opts.leadId, kind: 'application',
      body: `Application started for unit ${unit.unit_number}`, actor: ctx.userName, at: nowIso(), business_date: ctx.businessDate,
    });
  }
  emit(ctx, 'application.started', 'application', appId, { unitId: unit.id });
  return { applicationId: appId, applicantToken };
}

export function inviteApplicant(ctx: Ctx, applicationId: string, kind: 'co' | 'guarantor' | 'occupant', email: string, baseUrl: string): string {
  const app = q1<any>('SELECT * FROM applications WHERE id=? AND org_id=?', applicationId, ctx.orgId);
  if (!app) throw new Error('application not found');
  const t = token(18);
  const aplId = id('apl');
  insert('applicants', {
    id: aplId, org_id: ctx.orgId, application_id: applicationId, kind,
    email: email.toLowerCase(), invite_token: t, status: 'invited', step: 1, created_at: nowIso(),
  });
  sendEmail(ctx, {
    to: email, subject: `You're invited to join a rental application`,
    body: `<p>You've been added as a ${kind === 'co' ? 'co-applicant' : kind} on a rental application. Complete your part here:</p><p><a href="${baseUrl}/apply/${t}">${baseUrl}/apply/${t}</a></p><p>It takes about 5 minutes — have your income info handy.</p>`,
    propertyId: app.property_id, entity: 'application', entityId: applicationId, templateKey: 'applicant_invite',
  });
  emit(ctx, 'application.applicant_invited', 'application', applicationId, { kind, email });
  return aplId;
}

/** fees at submission: app fee per adult + holding deposit (simulated card) */
export function collectFees(ctx: Ctx, applicationId: string): { total: number; ref: string } {
  const app = q1<any>('SELECT * FROM applications WHERE id=? AND org_id=?', applicationId, ctx.orgId);
  if (!app) throw new Error('application not found');
  if (app.fees_paid) return { total: 0, ref: app.fee_payment_ref };
  const adults = val<number>(`SELECT COUNT(*) FROM applicants WHERE application_id=? AND kind IN ('primary','co')`, applicationId) || 1;
  const feeTotal = app.app_fee_cents * adults;
  const total = feeTotal + app.hold_deposit_cents;
  const ref = 'appch_' + applicationId.slice(-8);
  tx(() => {
    for (const basis of ['accrual', 'cash'] as const) {
      postJE(ctx, {
        propertyId: app.property_id, date: ctx.businessDate, basis,
        memo: `Application fees ${usd(feeTotal)} + holding deposit ${usd(app.hold_deposit_cents)} (${applicationId.slice(-6)})`,
        sourceKind: 'application_fee', sourceId: applicationId,
        lines: [
          { account: '1010', debit: total },
          { account: '4060', credit: feeTotal },
          { account: '2200', credit: app.hold_deposit_cents, memo: 'holding deposit (refundable)' },
        ],
      });
    }
    update('applications', applicationId, { fees_paid: 1, fee_payment_ref: ref });
  });
  emit(ctx, 'application.fees_paid', 'application', applicationId, { totalCents: total });
  return { total, ref };
}

/** submit: kick off screening for every adult applicant */
export function submitApplication(ctx: Ctx, applicationId: string): void {
  const app = q1<any>('SELECT * FROM applications WHERE id=? AND org_id=?', applicationId, ctx.orgId);
  if (!app) throw new Error('application not found');
  if (!['draft'].includes(app.status)) throw new Error('already submitted');
  if (!app.fees_paid) throw new Error('fees must be collected before submission');
  const adults = q<any>(`SELECT * FROM applicants WHERE application_id=? AND kind IN ('primary','co','guarantor')`, applicationId);
  const { version } = currentCriteriaVersion(ctx, app.property_id);
  tx(() => {
    update('applications', applicationId, { status: 'screening', submitted_at: nowIso(), criteria_version: version });
    for (const a of adults) {
      insert('screening_reports', {
        id: id('scr'), org_id: ctx.orgId, application_id: applicationId, applicant_id: a.id,
        status: 'pending', requested_at: nowIso(),
      });
    }
  });
  emit(ctx, 'application.submitted', 'application', applicationId, { applicants: adults.length });
}

/** bureau responses arrive asynchronously — the scheduler tick (or a manual
 * check) completes pending reports deterministically */
export function completeScreenings(ctx: Ctx, applicationId?: string): number {
  const pending = applicationId
    ? q<any>(`SELECT s.*, a.email, a.ssn_last4, a.income_monthly_cents FROM screening_reports s JOIN applicants a ON a.id=s.applicant_id WHERE s.status='pending' AND s.application_id=?`, applicationId)
    : q<any>(`SELECT s.*, a.email, a.ssn_last4, a.income_monthly_cents FROM screening_reports s JOIN applicants a ON a.id=s.applicant_id WHERE s.status='pending' AND s.org_id=?`, ctx.orgId);
  for (const s of pending) {
    const result = resultFor(ctx.orgId, s.email, s.ssn_last4);
    // fraud: duplicate SSN across other applications (M5.4)
    const fraud: string[] = [];
    if (s.ssn_last4) {
      const dupes = val<number>(
        `SELECT COUNT(*) FROM applicants x WHERE x.org_id=? AND x.ssn_last4=? AND x.email != ? AND x.application_id != ?`,
        ctx.orgId, s.ssn_last4, s.email, s.application_id,
      ) || 0;
      if (dupes > 0) fraud.push(`SSN last-4 reused across ${dupes} other application${dupes === 1 ? '' : 's'}`);
    }
    // income-doc OCR runs deterministically against the stored document (M5.4)
    let incomeExtracted: number | null = null;
    const docRow = q1<any>(`SELECT id FROM files WHERE entity='applicant_income' AND entity_id=? ORDER BY created_at DESC LIMIT 1`, s.applicant_id);
    if (docRow && s.income_monthly_cents) {
      const found = getFile(docRow.id);
      if (found) {
        const ocr = extractIncome(found.data, s.income_monthly_cents);
        incomeExtracted = ocr.extractedMonthlyIncomeCents;
        if (ocr.anomaly) fraud.push(`Income document anomaly: ${ocr.note}`);
      }
    }
    update('screening_reports', s.id, {
      status: 'complete', credit_score: result.creditScore, credit_band: result.creditBand,
      criminal_flag: result.criminalFlag ? 1 : 0, eviction_flag: result.evictionFlag ? 1 : 0,
      eviction_years_ago: result.evictionYearsAgo, thin_file: result.thinFile ? 1 : 0,
      fraud_flags: js(fraud), income_extracted_cents: incomeExtracted,
      completed_at: nowIso(),
    });
    emit(ctx, 'screening.completed', 'screening_report', s.id, { applicationId: s.application_id, band: result.creditBand });
  }
  // move fully-screened applications into review with a computed recommendation
  const apps = [...new Set(pending.map((s) => s.application_id))];
  for (const appId of apps) {
    const remaining = val<number>(`SELECT COUNT(*) FROM screening_reports WHERE application_id=? AND status='pending'`, appId) || 0;
    if (remaining === 0) {
      const rec = computeScorecard(ctx, appId);
      update('applications', appId, { status: 'review', recommendation: rec.recommendation, recommendation_detail: js(rec) });
      emit(ctx, 'application.review_ready', 'application', appId, { recommendation: rec.recommendation });
    }
  }
  return pending.length;
}


export interface Scorecard {
  recommendation: 'approve' | 'conditions' | 'decline';
  reasons: string[];
  conditions: string[];
  totalIncomeCents: number;
  incomeMultiple: number | null;
  minScore: number | null;
  flags: string[];
}

/** household scorecard vs versioned criteria (M5.2-3) */
export function computeScorecard(ctx: Ctx, applicationId: string): Scorecard {
  const app = q1<any>('SELECT * FROM applications WHERE id=? AND org_id=?', applicationId, ctx.orgId);
  const criteria = getSetting<Criteria>(ctx, 'screening_criteria', app.property_id);
  const adults = q<any>(`SELECT a.*, s.credit_score, s.credit_band, s.criminal_flag, s.eviction_flag, s.eviction_years_ago, s.thin_file, s.fraud_flags FROM applicants a LEFT JOIN screening_reports s ON s.applicant_id=a.id WHERE a.application_id=? AND a.kind IN ('primary','co')`, applicationId);
  const guarantors = q<any>(`SELECT a.*, s.credit_score FROM applicants a LEFT JOIN screening_reports s ON s.applicant_id=a.id WHERE a.application_id=? AND a.kind='guarantor'`, applicationId);
  const reasons: string[] = [];
  const conditions: string[] = [];
  const flags: string[] = [];
  const totalIncome = adults.reduce((s, a) => s + (a.income_monthly_cents || 0), 0);
  const multiple = app.rent_cents > 0 && totalIncome > 0 ? Math.round((totalIncome / app.rent_cents) * 100) / 100 : null;
  const scores = adults.map((a) => a.credit_score).filter((x) => x !== null) as number[];
  const minScore = scores.length ? Math.min(...scores) : null;
  const anyThin = adults.some((a) => a.thin_file);
  for (const a of adults) {
    for (const f of j<string[]>(a.fraud_flags, [])) flags.push(`${a.first_name || a.email}: ${f}`);
  }

  let level: Scorecard['recommendation'] = 'approve';
  // income
  if (multiple === null) {
    level = 'conditions';
    reasons.push('Income not stated');
    conditions.push('Provide verifiable income or add a guarantor');
  } else if (multiple < criteria.incomeMultiple) {
    if (multiple >= criteria.incomeMultiple * 0.8) {
      level = 'conditions';
      reasons.push(`Income ${multiple}× rent is below the ${criteria.incomeMultiple}× requirement`);
      conditions.push(`Additional deposit (${criteria.conditionalDepositMultiplier}× rent) or qualified guarantor`);
    } else {
      level = 'decline';
      reasons.push(`Income ${multiple}× rent is well below the ${criteria.incomeMultiple}× requirement`);
    }
  }
  // credit
  if (minScore !== null) {
    if (minScore < criteria.conditionalCreditScore) {
      level = 'decline';
      reasons.push(`Credit score ${minScore} is below the minimum of ${criteria.conditionalCreditScore}`);
    } else if (minScore < criteria.minCreditScore && level !== 'decline') {
      level = 'conditions';
      reasons.push(`Credit score ${minScore} is below the preferred ${criteria.minCreditScore}`);
      conditions.push(`Additional deposit (${criteria.conditionalDepositMultiplier}× rent) required`);
    }
  } else if (anyThin && level !== 'decline') {
    level = 'conditions';
    reasons.push('Thin credit file — no score returned');
    conditions.push('Guarantor required or additional deposit');
  }
  // eviction lookback
  for (const a of adults) {
    if (a.eviction_flag && (a.eviction_years_ago ?? 0) <= criteria.evictionLookbackYears) {
      level = 'decline';
      reasons.push(`Eviction record within the ${criteria.evictionLookbackYears}-year lookback`);
      break;
    }
  }
  // criminal: review flag only (individualized assessment), never auto-decline
  if (adults.some((a) => a.criminal_flag)) flags.push('Criminal record hit — perform individualized assessment per policy');
  // qualified guarantor rescues a conditions case
  if (level === 'conditions' && guarantors.some((g) => (g.credit_score ?? 0) >= 700 && (g.income_monthly_cents || 0) >= app.rent_cents * 4)) {
    reasons.push('Qualified guarantor on file satisfies the condition');
    conditions.length = 0;
    level = 'approve';
  }
  // an institutional guaranty (M12.4) does the same for income/credit conditions
  if (level === 'conditions' && q1(`SELECT id FROM guaranty_contracts WHERE application_id=? AND status='active'`, applicationId)) {
    reasons.push('Institutional guaranty (simulated) covers the shortfall — condition satisfied');
    conditions.length = 0;
    level = 'approve';
  }
  if (level === 'approve' && reasons.length === 0) reasons.push('Meets all property criteria');
  return { recommendation: level, reasons, conditions, totalIncomeCents: totalIncome, incomeMultiple: multiple, minScore, flags };
}

/** staff decision; overriding the recommendation needs elevated permission + reason */
export function decideApplication(
  ctx: Ctx,
  applicationId: string,
  action: 'approved' | 'approved_conditions' | 'declined',
  opts: { reason?: string; override?: boolean },
): void {
  const app = q1<any>('SELECT * FROM applications WHERE id=? AND org_id=?', applicationId, ctx.orgId);
  if (!app) throw new Error('application not found');
  if (!['review', 'screening'].includes(app.status)) throw new Error(`cannot decide from status ${app.status}`);
  const recommended = app.recommendation === 'approve' ? 'approved' : app.recommendation === 'conditions' ? 'approved_conditions' : 'declined';
  const isOverride = action !== recommended;
  if (isOverride) {
    if (!ctx.perms.has('screening:override')) throw new Error('overriding the recommendation requires the screening:override permission');
    if (!opts.reason || opts.reason.trim().length < 5) throw new Error('an override requires a written reason');
  }
  const holdDays = getSetting<number>(ctx, 'hold_window_days', app.property_id);
  tx(() => {
    update('applications', applicationId, {
      status: action,
      hold_expires: action.startsWith('approved') ? addDays(ctx.businessDate, holdDays) : null,
      decision: js({ action, by: ctx.userId, byName: ctx.userName, reason: opts.reason || null, overrode: isOverride, recommendation: app.recommendation, criteriaVersion: app.criteria_version, at: nowIso() }),
    });
  });
  audit(ctx, 'application', applicationId, isOverride ? 'decision_override' : 'decision', { recommendation: app.recommendation }, { action, reason: opts.reason });
  emit(ctx, `application.${action}`, 'application', applicationId, { override: isOverride });
  if (app.lead_id && action.startsWith('approved')) {
    run(`UPDATE leads SET status='applied' WHERE id=? AND status NOT IN ('leased')`, app.lead_id);
  }
  if (action === 'declined') {
    releaseHold(ctx, applicationId, 'declined');
  }
  if (action === 'declined' || action === 'approved_conditions') {
    void issueAdverseAction(ctx, applicationId, action);
  }
}

/** adverse action letter: PDF + Message Console (M5.5) */
export async function issueAdverseAction(ctx: Ctx, applicationId: string, action: string): Promise<void> {
  const app = q1<any>(
    `SELECT ap.*, p.name AS prop_name, p.address1, p.city, p.state, p.zip, u.unit_number FROM applications ap
     JOIN properties p ON p.id=ap.property_id JOIN units u ON u.id=ap.unit_id WHERE ap.id=?`,
    applicationId,
  );
  const primary = q1<any>(`SELECT * FROM applicants WHERE application_id=? AND kind='primary'`, applicationId);
  const rec = j<Scorecard>(app.recommendation_detail, { reasons: [] } as unknown as Scorecard);
  const pdf = await Pdf.create('Adverse action notice');
  pdf.brandHeader(app.prop_name, [`${app.address1}, ${app.city}, ${app.state} ${app.zip}`]);
  pdf.h1(action === 'declined' ? 'Notice of adverse action' : 'Notice of conditional approval');
  pdf.text(`Date: ${fmtDate(ctx.businessDate)}   ·   Application: ${applicationId.slice(-8)}   ·   Criteria version: ${app.criteria_version}`);
  pdf.space(4);
  pdf.text(`Dear ${primary?.first_name || 'Applicant'} ${primary?.last_name || ''},`);
  pdf.text(action === 'declined'
    ? `Thank you for applying to ${app.prop_name}. After reviewing your application against our written rental criteria (version ${app.criteria_version}, applied consistently to all applicants), we are unable to approve it at this time for the following reason(s):`
    : `Thank you for applying to ${app.prop_name}. Your application has been approved with conditions based on our written rental criteria (version ${app.criteria_version}):`);
  for (const reason of rec.reasons || []) pdf.text(`•  ${reason}`);
  if (action !== 'declined') {
    pdf.h2('Conditions');
    for (const c of rec.conditions || []) pdf.text(`•  ${c}`);
  }
  pdf.space(4);
  pdf.text('This decision was based in whole or in part on information provided by a consumer reporting agency (simulated bureau for this demo). You have the right to obtain a free copy of your report within 60 days and to dispute incomplete or inaccurate information directly with the agency. The agency did not make this decision and cannot explain why it was made.', { muted: true, size: 8.5 });
  pdf.footerAllPages(`${app.prop_name} · adverse action record · retain per policy`);
  const bytes = await pdf.bytes();
  const file = putFile(ctx, bytes, {
    name: `adverse-action-${applicationId.slice(-6)}.pdf`, mime: 'application/pdf',
    entity: 'application', entityId: applicationId, visibility: 'staff',
  });
  if (primary?.email) {
    sendEmail(ctx, {
      to: primary.email, toName: `${primary.first_name} ${primary.last_name}`,
      subject: action === 'declined' ? `Update on your application — ${app.prop_name}` : `Your conditional approval — ${app.prop_name}`,
      body: `<p>Dear ${primary.first_name || 'applicant'},</p><p>${action === 'declined' ? 'We were unable to approve your application at this time.' : 'Your application is approved with conditions.'} The formal notice with your rights and the specific reasons is attached to your file (ref ${file.id}).</p><p>${(rec.reasons || []).map((x: string) => `• ${x}`).join('<br/>')}</p>${action !== 'declined' ? `<p>Conditions:<br/>${(rec.conditions || []).map((x: string) => `• ${x}`).join('<br/>')}</p>` : ''}<p>You may dispute information from the screening agency; details are in the attached notice.</p>`,
      propertyId: app.property_id, entity: 'application', entityId: applicationId, templateKey: 'adverse_action',
    });
  }
  emit(ctx, 'application.adverse_action', 'application', applicationId, { action, fileId: file.id });
}

/** unit holds: approved applications hold the unit; denial/cancel/expiry releases */
export function unitHold(unitId: string): { applicationId: string; expires: string } | null {
  const app = q1<any>(
    `SELECT id, hold_expires FROM applications WHERE unit_id=? AND status IN ('approved','approved_conditions') AND hold_expires IS NOT NULL ORDER BY hold_expires DESC LIMIT 1`,
    unitId,
  );
  return app ? { applicationId: app.id, expires: app.hold_expires } : null;
}

export function releaseHold(ctx: Ctx, applicationId: string, why: string): void {
  const app = q1<any>('SELECT * FROM applications WHERE id=? AND org_id=?', applicationId, ctx.orgId);
  if (!app) return;
  if (app.hold_expires) {
    update('applications', applicationId, { hold_expires: null });
    audit(ctx, 'application', applicationId, 'hold_released', null, { why });
    emit(ctx, 'application.hold_released', 'application', applicationId, { why });
  }
  // refund holding deposit when the application dies (per policy)
  if (['declined', 'canceled'].includes(why) && app.hold_deposit_cents > 0 && app.fees_paid) {
    for (const basis of ['accrual', 'cash'] as const) {
      postJE(ctx, {
        propertyId: app.property_id, date: ctx.businessDate, basis,
        memo: `Holding deposit refund (${why}) — application ${applicationId.slice(-6)}`,
        sourceKind: 'application_refund', sourceId: applicationId,
        lines: [
          { account: '2200', debit: app.hold_deposit_cents },
          { account: '1010', credit: app.hold_deposit_cents },
        ],
      });
    }
  }
}

export function cancelApplication(ctx: Ctx, applicationId: string, reason: string): void {
  const app = q1<any>('SELECT * FROM applications WHERE id=? AND org_id=?', applicationId, ctx.orgId);
  if (!app || ['converted', 'canceled'].includes(app.status)) throw new Error('cannot cancel');
  update('applications', applicationId, { status: 'canceled', decision: js({ action: 'canceled', reason, by: ctx.userId, at: nowIso() }) });
  releaseHold(ctx, applicationId, 'canceled');
  audit(ctx, 'application', applicationId, 'cancel', null, { reason });
  emit(ctx, 'application.canceled', 'application', applicationId, {});
}

// jobs: bureau turnaround + hold expiry
registerJob({
  key: 'screening_results',
  name: 'Screening bureau responses',
  describe: 'Completes pending screening reports (simulated async bureau turnaround) and computes household scorecards.',
  run: (ctx) => {
    const n = completeScreenings(ctx);
    return n ? `${n} reports returned` : 'no pending reports';
  },
});

registerJob({
  key: 'hold_expiry',
  name: 'Application hold expiry',
  describe: 'Releases unit holds on approved applications past their hold window.',
  run: (ctx, date) => {
    const expired = q<any>(
      `SELECT id FROM applications WHERE org_id=? AND status IN ('approved','approved_conditions') AND hold_expires IS NOT NULL AND hold_expires<?`,
      ctx.orgId, date,
    );
    for (const app of expired) releaseHold(ctx, app.id, 'expired');
    return expired.length ? `${expired.length} holds expired` : 'no holds expiring';
  },
});
