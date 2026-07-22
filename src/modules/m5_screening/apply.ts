import { html, raw, when, join } from '../../lib/html.ts';
import { htmlRes, redirect, notFound, type Router, type Rq, type Res, takeFlash } from '../../lib/http.ts';
import { q, q1, val, run, update, j } from '../../lib/db.ts';
import { sysCtx } from '../../lib/auth.ts';
import { fmtDate, addDays } from '../../lib/dates.ts';
import { usd } from '../../lib/money.ts';
import { v } from '../../lib/validate.ts';
import { putFile } from '../../lib/files.ts';
import { doc, logo, statusBadge } from '../../ui/ui.ts';
import {
  createApplication, inviteApplicant, collectFees, submitApplication, completeScreenings,
} from './service.ts';
import { marketingOf } from '../m4_marketing/public.ts';

/** M5.1 applicant experience: tokenized multi-step application with
 * save-and-resume, co-applicant invites, document upload, fee payment. */

import type { Child } from '../../lib/html.ts';
function wizardShell(rq: Rq, title: string, content: Child, opts: { propName?: string; step?: number; total?: number } = {}): Res {
  const flash = takeFlash(rq);
  const body = html`<div class="portal" style="max-width:680px">
    <div class="portal-top"><div class="pt-brand">${logo(20, '#4653e5')} ${opts.propName || 'Application'}</div></div>
    ${when(opts.step, () => html`<div style="display:flex;gap:6px;margin-bottom:12px">${Array.from({ length: opts.total || 4 }, (_, i) => html`<div style="flex:1;height:5px;border-radius:3px;background:${i < (opts.step || 0) ? 'var(--accent)' : 'var(--line)'}"></div>`)}</div>`)}
    ${when(flash, () => html`<div class="flash ${flash![0]}">${flash![1]}</div>`)}
    <h1 style="margin-bottom:12px">${title}</h1>
    ${content}
    <p class="small muted center" style="margin-top:20px">Save-and-resume any time — this link is your application. Fake data only; no real SSNs.</p>
  </div>`;
  return htmlRes(doc(title, body));
}

function loadByToken(tokenStr: string): { app: any; applicant: any; prop: any } | null {
  const applicant = q1<any>('SELECT * FROM applicants WHERE invite_token=?', tokenStr);
  if (!applicant) return null;
  const app = q1<any>('SELECT * FROM applications WHERE id=?', applicant.application_id);
  const prop = q1<any>('SELECT * FROM properties WHERE id=?', app.property_id);
  return { app, applicant, prop };
}

export function routes(r: Router): void {
  // start an application from a public unit/quote link
  r.get('/p/:slug/apply', (rq) => {
    const prop = q1<any>('SELECT * FROM properties WHERE slug=?', rq.params.slug!);
    if (!prop) return notFound();
    const units = q<any>(
      `SELECT u.*, f.name AS fp_name, f.beds FROM units u LEFT JOIN floorplans f ON f.id=u.floorplan_id
       WHERE u.property_id=? AND u.status='vacant_ready'
         AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.unit_id=u.id AND a.status IN ('approved','approved_conditions') AND a.hold_expires>=?)
       ORDER BY u.market_rent_cents LIMIT 30`,
      prop.id, sysCtx(prop.org_id).businessDate,
    );
    return wizardShell(rq, `Apply at ${prop.name}`, html`
      <div class="card"><div class="card-body">
        <form method="post" action="/p/${prop.slug}/apply">
          <div class="field"><label>Choose your home</label><select name="unit_id" required>${units.map((u) => html`<option value="${u.id}">${u.unit_number} — ${u.fp_name || ''} · ${usd(u.market_rent_cents)}/mo</option>`)}</select></div>
          <div class="form-grid">
            <div class="field"><label>First name</label><input name="first_name" required /></div>
            <div class="field"><label>Last name</label><input name="last_name" required /></div>
            <div class="field"><label>Email</label><input name="email" type="email" required /></div>
            <div class="field"><label>Move-in date</label><input name="move_in" type="date" required value="${addDays(sysCtx(prop.org_id).businessDate, 21)}" /></div>
          </div>
          <button class="btn" style="width:100%;justify-content:center">Start my application</button>
        </form>
      </div></div>`, { propName: prop.name });
  });

  r.post('/p/:slug/apply', (rq) => {
    const prop = q1<any>('SELECT * FROM properties WHERE slug=?', rq.params.slug!);
    if (!prop) return notFound();
    const ctx = sysCtx(prop.org_id);
    const email = v.email().safe(rq.body.email);
    if (!email.ok) return redirect(`/p/${prop.slug}/apply`, 'Valid email required.', 'err');
    // connect to an existing lead if one matches
    const lead = q1<any>('SELECT id FROM leads WHERE org_id=? AND email=?', prop.org_id, email.value);
    const { applicantToken } = createApplication(ctx, {
      propertyId: prop.id, unitId: String(rq.body.unit_id), leadId: lead?.id || null,
      moveIn: rq.body.move_in ? String(rq.body.move_in) : undefined,
      primary: { firstName: String(rq.body.first_name || ''), lastName: String(rq.body.last_name || ''), email: email.value },
    });
    return redirect(`/apply/${applicantToken}`, 'Application started — you can return to this link any time.');
  });

  // staff: start application from a quote (M3.5 one-click convert)
  // (registered under staff router in pages.ts)

  // ---------- the wizard ----------
  r.get('/apply/:token', (rq) => {
    const loaded = loadByToken(rq.params.token!);
    if (!loaded) return notFound('Application link not found');
    const { app, applicant, prop } = loaded;
    const ctx = sysCtx(prop.org_id);
    const unit = q1<any>('SELECT * FROM units WHERE id=?', app.unit_id);
    const isPrimary = applicant.kind === 'primary';

    if (app.status !== 'draft') return statusScreen(rq, app, applicant, prop, unit);

    const step = applicant.step;
    if (step === 1) {
      return wizardShell(rq, isPrimary ? 'About you' : `Join the application (${applicant.kind === 'guarantor' ? 'guarantor' : 'co-applicant'})`, html`
        <div class="card"><div class="card-body">
          <p class="small muted">Unit ${unit.unit_number} at ${prop.name} · ${usd(app.rent_cents)}/mo · move-in ${fmtDate(app.move_in)}</p>
          <form method="post" action="/apply/${applicant.invite_token}/step1">
            <div class="form-grid">
              <div class="field"><label>First name</label><input name="first_name" value="${applicant.first_name}" required /></div>
              <div class="field"><label>Last name</label><input name="last_name" value="${applicant.last_name}" required /></div>
              <div class="field"><label>Phone</label><input name="phone" type="tel" value="${applicant.phone ?? ''}" /></div>
              <div class="field"><label>SSN last 4 (fake)</label><input name="ssn_last4" value="${applicant.ssn_last4 ?? ''}" maxlength="4" pattern="[0-9]{4}" required /></div>
            </div>
            <div class="field"><label>Current address</label><input name="current_address" value="${applicant.current_address ?? ''}" required /></div>
            <button class="btn" style="width:100%;justify-content:center">Continue</button>
          </form>
        </div></div>`, { propName: prop.name, step: 1, total: isPrimary ? 4 : 2 });
    }
    if (step === 2) {
      const incomeDoc = q1<any>(`SELECT * FROM files WHERE entity='applicant_income' AND entity_id=?`, applicant.id);
      const idDoc = q1<any>(`SELECT * FROM files WHERE entity='applicant_id' AND entity_id=?`, applicant.id);
      return wizardShell(rq, 'Income & employment', html`
        <div class="card"><div class="card-body">
          <form method="post" action="/apply/${applicant.invite_token}/step2" enctype="multipart/form-data">
            <div class="form-grid">
              <div class="field"><label>Employer</label><input name="employer" value="${applicant.employer ?? ''}" required /></div>
              <div class="field"><label>Gross monthly income</label><input name="income" inputmode="decimal" value="${applicant.income_monthly_cents ? (applicant.income_monthly_cents / 100).toFixed(0) : ''}" required /></div>
            </div>
            <div class="field"><label>Income proof (paystub — any file)</label><input type="file" name="income_doc" ${incomeDoc ? '' : 'required'} />${incomeDoc ? html`<div class="hint">✓ ${incomeDoc.name} uploaded</div>` : ''}</div>
            <div class="field"><label>Photo ID (any file)</label><input type="file" name="id_doc" ${idDoc ? '' : 'required'} />${idDoc ? html`<div class="hint">✓ ${idDoc.name} uploaded</div>` : ''}</div>
            <button class="btn" style="width:100%;justify-content:center">Continue</button>
          </form>
        </div></div>`, { propName: prop.name, step: 2, total: isPrimary ? 4 : 2 });
    }
    if (!isPrimary) {
      // co-applicants finish after step 2
      return statusScreen(rq, app, applicant, prop, unit);
    }
    if (step === 3) {
      const others = q<any>(`SELECT * FROM applicants WHERE application_id=? AND id != ?`, app.id, applicant.id);
      return wizardShell(rq, 'Your household', html`
        <div class="card"><div class="card-body">
          <p class="small muted">Add co-applicants (adults who will sign the lease) and a guarantor if needed. Each person gets their own link by email.</p>
          ${others.length ? join(others.map((o) => html`<div class="list-item"><div class="li-main"><div class="li-title">${o.email}</div><div class="li-sub">${o.kind}</div></div>${statusBadge(o.status)}</div>`)) : html`<p class="muted small">Just you so far.</p>`}
          <form method="post" action="/apply/${applicant.invite_token}/invite" class="toolbar" style="margin-top:10px">
            <div class="field"><label>Email</label><input name="email" type="email" required /></div>
            <div class="field"><label>Role</label><select name="kind"><option value="co">Co-applicant</option><option value="guarantor">Guarantor</option><option value="occupant">Occupant (minor/non-signer)</option></select></div>
            <button class="btn btn-sm btn-ghost">Invite</button>
          </form>
          <form method="post" action="/apply/${applicant.invite_token}/step3" style="margin-top:12px">
            <button class="btn" style="width:100%;justify-content:center">Continue to review & payment</button>
          </form>
        </div></div>`, { propName: prop.name, step: 3, total: 4 });
    }
    // step 4: review & pay & submit
    const adults = q<any>(`SELECT * FROM applicants WHERE application_id=? AND kind IN ('primary','co')`, app.id);
    const feeTotal = app.app_fee_cents * adults.length;
    const incomplete = q<any>(`SELECT * FROM applicants WHERE application_id=? AND kind IN ('primary','co','guarantor') AND status != 'complete'`, app.id).filter((x) => x.id !== applicant.id || applicant.status !== 'complete');
    return wizardShell(rq, 'Review & submit', html`
      <div class="card"><div class="card-body">
        <div class="dl" style="margin-bottom:12px">
          <dt>Home</dt><dd>Unit ${unit.unit_number} · ${usd(app.rent_cents)}/mo · ${app.term_months} months</dd>
          <dt>Move-in</dt><dd>${fmtDate(app.move_in)}</dd>
          <dt>Application fees</dt><dd>${usd(app.app_fee_cents)} × ${adults.length} applicant${adults.length === 1 ? '' : 's'} = ${usd(feeTotal)}</dd>
          <dt>Holding deposit</dt><dd>${usd(app.hold_deposit_cents)} <span class="muted small">(credited at lease signing, refunded if not approved)</span></dd>
          <dt>Due now</dt><dd><b>${usd(feeTotal + app.hold_deposit_cents)}</b></dd>
        </div>
        ${when(incomplete.length, () => html`<div class="callout warn">Waiting on: ${incomplete.map((x) => x.email).join(', ')} — you can still submit; screening starts for everyone who has finished, and the rest are screened when they complete.</div>`)}
        <form method="post" action="/apply/${applicant.invite_token}/submit">
          <div class="form-grid">
            <div class="field"><label>Card number (simulated)</label><input name="card" value="4242 4242 4242 4242" required /></div>
            <div class="field"><label>Exp / CVC</label><input name="exp" value="12/28 · 123" /></div>
          </div>
          <button class="btn" style="width:100%;justify-content:center">Pay ${usd(feeTotal + app.hold_deposit_cents)} & submit application</button>
        </form>
      </div></div>`, { propName: prop.name, step: 4, total: 4 });
  });

  r.post('/apply/:token/step1', (rq) => {
    const loaded = loadByToken(rq.params.token!);
    if (!loaded) return notFound();
    const { applicant } = loaded;
    update('applicants', applicant.id, {
      first_name: String(rq.body.first_name || '').trim(), last_name: String(rq.body.last_name || '').trim(),
      phone: rq.body.phone || null, ssn_last4: String(rq.body.ssn_last4 || '').replace(/\D/g, '').slice(0, 4) || null,
      current_address: String(rq.body.current_address || ''), status: 'started', step: 2,
    });
    return redirect(`/apply/${rq.params.token}`);
  });

  r.post('/apply/:token/step2', (rq) => {
    const loaded = loadByToken(rq.params.token!);
    if (!loaded) return notFound();
    const { app, applicant, prop } = loaded;
    const ctx = sysCtx(prop.org_id);
    const income = v.cents({ min: 0 }).safe(rq.body.income);
    if (!income.ok) return redirect(`/apply/${rq.params.token}`, 'Enter your monthly income as a number.', 'err');
    for (const up of rq.uploads) {
      if (!up.data.length) continue;
      if (up.field === 'income_doc') {
        putFile(ctx, up.data, { name: up.filename || 'income.pdf', mime: up.mime, entity: 'applicant_income', entityId: applicant.id, visibility: 'staff' });
      } else if (up.field === 'id_doc') {
        putFile(ctx, up.data, { name: up.filename || 'id.png', mime: up.mime, entity: 'applicant_id', entityId: applicant.id, visibility: 'staff' });
      }
    }
    const isPrimary = applicant.kind === 'primary';
    update('applicants', applicant.id, {
      employer: String(rq.body.employer || ''), income_monthly_cents: income.value,
      step: isPrimary ? 3 : 2, status: isPrimary ? 'started' : 'complete',
    });
    return redirect(`/apply/${rq.params.token}`, isPrimary ? undefined as unknown as string : 'All set — the primary applicant finishes submission.');
  });

  r.post('/apply/:token/invite', (rq) => {
    const loaded = loadByToken(rq.params.token!);
    if (!loaded) return notFound();
    const { app, prop } = loaded;
    const ctx = sysCtx(prop.org_id);
    const email = v.email().safe(rq.body.email);
    if (!email.ok) return redirect(`/apply/${rq.params.token}`, 'Valid email required.', 'err');
    const base = `http://${String(rq.raw.headers.host || 'localhost:3000')}`;
    inviteApplicant(ctx, app.id, String(rq.body.kind || 'co') as 'co' | 'guarantor' | 'occupant', email.value, base);
    return redirect(`/apply/${rq.params.token}`, `Invite sent to ${email.value}.`);
  });

  r.post('/apply/:token/step3', (rq) => {
    const loaded = loadByToken(rq.params.token!);
    if (!loaded) return notFound();
    update('applicants', loaded.applicant.id, { step: 4 });
    return redirect(`/apply/${rq.params.token}`);
  });

  r.post('/apply/:token/submit', (rq) => {
    const loaded = loadByToken(rq.params.token!);
    if (!loaded) return notFound();
    const { app, applicant, prop } = loaded;
    if (applicant.kind !== 'primary') return notFound();
    const ctx = sysCtx(prop.org_id);
    update('applicants', applicant.id, { status: 'complete' });
    collectFees(ctx, app.id);
    submitApplication(ctx, app.id);
    return redirect(`/apply/${rq.params.token}`, 'Submitted! Screening is underway — this page updates as results come back.');
  });

  // status screen also lets the applicant nudge the (simulated) bureau
  function statusScreen(rq: Rq, app: any, applicant: any, prop: any, unit: any): Res {
    const reports = q<any>(
      `SELECT s.*, a.first_name, a.last_name, a.email, a.kind FROM screening_reports s JOIN applicants a ON a.id=s.applicant_id WHERE s.application_id=? ORDER BY a.kind`,
      app.id,
    );
    const decision = j<any>(app.decision, null);
    return wizardShell(rq, 'Application status', html`
      <div class="card"><div class="card-body">
        <div class="dl">
          <dt>Home</dt><dd>Unit ${unit.unit_number} at ${prop.name}</dd>
          <dt>Status</dt><dd>${statusBadge(app.status)}</dd>
          ${app.hold_expires ? html`<dt>Unit held until</dt><dd>${fmtDate(app.hold_expires)}</dd>` : ''}
        </div>
        ${when(app.status === 'screening', () => html`
          <p class="small muted" style="margin-top:10px">The screening bureau usually responds within a minute in this demo.</p>
          <form method="post" action="/apply/${applicant.invite_token}/check"><button class="btn btn-ghost btn-sm">Check for results</button></form>`)}
        ${when(reports.length, () => html`<div style="margin-top:12px">${join(reports.map((s) => html`<div class="list-item">
          <div class="li-main"><div class="li-title">${s.first_name || s.email} <span class="muted small">(${s.kind})</span></div>
          <div class="li-sub">${s.status === 'complete' ? 'Screening complete' : 'Awaiting bureau…'}</div></div>
          ${statusBadge(s.status === 'complete' ? 'complete' : 'pending')}
        </div>`))}</div>`)}
        ${when(decision && app.status === 'approved_conditions', () => html`<div class="callout warn" style="margin-top:10px"><b>Approved with conditions.</b> The leasing team will reach out about next steps (see your email for details).</div>`)}
        ${when(decision && app.status === 'declined', () => html`<div class="callout bad" style="margin-top:10px">We couldn't approve this application. A notice with the reasons and your rights was emailed to you.</div>`)}
        ${when(app.status === 'approved', () => html`<div class="callout" style="border-color:var(--ok);margin-top:10px"><b>Approved!</b> Your unit is held${app.hold_expires ? ` until ${fmtDate(app.hold_expires)}` : ''} — lease signing comes next.</div>`)}
      </div></div>`, { propName: prop.name });
  }

  r.post('/apply/:token/check', (rq) => {
    const loaded = loadByToken(rq.params.token!);
    if (!loaded) return notFound();
    const ctx = sysCtx(loaded.prop.org_id);
    const n = completeScreenings(ctx, loaded.app.id);
    return redirect(`/apply/${rq.params.token}`, n ? 'Results are in!' : 'Still waiting on the bureau…');
  });
}
