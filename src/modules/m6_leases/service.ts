import { createHash } from 'node:crypto';
import { q, q1, insert, val, run, update, tx, j, js } from '../../lib/db.ts';
import { id, token } from '../../lib/ids.ts';
import { nowIso, addDays, addMonths, fmtDate, monthKey, diffDays } from '../../lib/dates.ts';
import { usd } from '../../lib/money.ts';
import type { Ctx } from '../../lib/auth.ts';
import { sysCtx, hashPassword } from '../../lib/auth.ts';
import { emit, on } from '../../lib/events.ts';
import { getSetting } from '../../lib/settings.ts';
import { registerJob } from '../../lib/jobs.ts';
import { audit } from '../../lib/audit.ts';
import { sendEmail } from '../../lib/sim/messaging.ts';
import { Pdf } from '../../lib/pdf.ts';
import { putFile, getFile } from '../../lib/files.ts';
import { PDFDocument } from 'pdf-lib';
import { createCharge, postMonthlyChargesForLease, leaseBalance } from '../m8_receivables/service.ts';
import { recordPayment } from '../m8_receivables/payments.ts';
import { assertAffordableCompliance, maxTenantRent } from '../m18_verticals/service.ts';

/** M6 services: templates, packet assembly, built-in e-sign with a
 * tamper-evident SHA-256 trail, the lease lifecycle state machine,
 * activation events, and renewals. */

export const DEFAULT_TEMPLATE_BODY = `RESIDENTIAL LEASE AGREEMENT

This Lease Agreement is made between {{landlord}} ("Landlord") and {{household_names}} ("Resident") for the residence at {{property_name}}, Unit {{unit_number}}, {{property_address}}.

1. TERM. The lease begins {{start_date}} and ends {{end_date}} ({{term_months}} months). Holding over without renewal converts the tenancy to month-to-month with the posted premium.

2. RENT. Base rent is {{rent}} per month, due on the 1st. Rent received after the grace period stated in the property policies incurs late fees per the fee schedule. The full recurring charge schedule attached to this lease is the single source of billing truth.

3. SECURITY DEPOSIT. Resident has paid or will pay a security deposit of {{deposit}}, held and returned per applicable law with an itemized disposition within the statutory deadline.

4. UTILITIES & SERVICES. Responsibility for utilities is set out in the utility addendum or charge schedule; amounts billed through the ledger are due with rent.

5. OCCUPANCY. Only the persons listed on this lease and approved occupants may reside in the unit. Guests beyond 14 consecutive days require approval.

6. CARE OF PREMISES. Resident will maintain the unit, report needed repairs promptly through the portal, and permit entry per notice rules and the permissions recorded on each request.

7. INSURANCE. Resident must maintain liability coverage as set by property policy and keep proof current in the portal; lapses may enroll the household in the property master policy at the posted fee.

8. DEFAULT & REMEDIES. Nonpayment or breach is handled per applicable law. Amounts owed flow through the resident ledger; formal notices are issued and tracked by the Landlord.

9. ENTIRE AGREEMENT. This lease, its charge schedule, and the attached addenda are the entire agreement.`;

export const DEFAULT_ADDENDA: [string, string, string, string | null][] = [
  ['pet', 'Pet Addendum', 'Resident may keep the approved pet(s) listed in the household record. Pet rent per the charge schedule applies monthly. Resident is responsible for all pet damage; waste must be picked up; breed/weight rules per property policy.', 'has_pet'],
  ['parking', 'Parking & Garage Addendum', 'The assigned parking/garage/storage item(s) in the charge schedule are licensed to Resident for the lease term. Vehicles must be registered in the portal; inoperable vehicles may be towed after notice.', 'has_parking'],
  ['utility', 'Utility Billing Addendum', 'Utilities may be billed via submeter reads or an allocation formula (RUBS) as posted for the property. Charges appear on the monthly statement and are due with rent.', 'always'],
  ['concession', 'Concession Addendum', 'Any concession granted is conditioned on completing the full lease term; early termination may require repayment of concession value per the schedule below.', 'concession'],
  ['guarantor', 'Guaranty Addendum', 'The undersigned Guarantor unconditionally guarantees all Resident obligations under this lease, including rent, fees and damages, continuing through renewals and holdover.', 'has_guarantor'],
  ['inst_guaranty', 'Institutional Guaranty Addendum', 'Resident obligations under this lease are guaranteed by Anchor Guaranty (simulated) up to the coverage stated in the guaranty contract, in exchange for the one-time program fee on the charge schedule. The guaranty does not relieve Resident of liability; the guarantor may pursue recovery of amounts paid.', 'inst_guaranty'],
  ['deposit_alt', 'Deposit Alternative Addendum', 'In lieu of a traditional security deposit, Resident participates in the SuretyShield (simulated) deposit alternative program per the fee on the charge schedule. The program covers Owner losses up to the coverage amount; Resident remains liable for damages and unpaid amounts, including any amounts the surety pays on Resident\'s behalf.', 'deposit_alt'],
  ['student', 'Student Housing Addendum', 'This is an individual liability lease covering one bedspace and shared common areas. Roommate assignments may change per community policy; each resident is responsible only for their own charges.', 'student'],
];

export function ensureLeaseTemplates(orgId: string): void {
  if (q1('SELECT id FROM lease_templates WHERE org_id=? LIMIT 1', orgId)) return;
  insert('lease_templates', {
    id: id('ltp'), org_id: orgId, property_id: '', state: '', name: 'Standard Residential Lease',
    version: 1, body: DEFAULT_TEMPLATE_BODY, active: 1, created_at: nowIso(),
  });
  DEFAULT_ADDENDA.forEach(([key, title, body, condition], i) => {
    insert('addenda_library', { id: id('add'), org_id: orgId, key, title, body, condition_key: condition, sort: i, active: 1, created_at: nowIso() });
  });
}

on('org.created', (ctx) => ensureLeaseTemplates(ctx.orgId));

export function templateFor(ctx: Ctx, propertyId: string): any {
  return (
    q1<any>(`SELECT * FROM lease_templates WHERE org_id=? AND property_id=? AND active=1 ORDER BY version DESC LIMIT 1`, ctx.orgId, propertyId) ||
    q1<any>(`SELECT * FROM lease_templates WHERE org_id=? AND property_id='' AND active=1 ORDER BY version DESC LIMIT 1`, ctx.orgId)
  );
}

// ---------- lease creation from an application ----------

export function leaseFromApplication(ctx: Ctx, applicationId: string): string {
  const app = q1<any>('SELECT * FROM applications WHERE id=? AND org_id=?', applicationId, ctx.orgId);
  if (!app) throw new Error('application not found');
  if (!['approved', 'approved_conditions'].includes(app.status)) throw new Error('application must be approved first');
  if (app.lease_id) return app.lease_id;
  const unit = q1<any>('SELECT * FROM units WHERE id=?', app.unit_id);
  const adults = q<any>(`SELECT * FROM applicants WHERE application_id=? AND kind IN ('primary','co')`, applicationId);
  const primary = adults.find((a) => a.kind === 'primary') || adults[0];
  const conditions = app.status === 'approved_conditions';
  const criteria = getSetting<any>(ctx, 'screening_criteria', app.property_id);
  const depositMult = conditions ? criteria.conditionalDepositMultiplier || 1.5 : 1;
  const deposit = Math.round((app.rent_cents * depositMult) / 500) * 500;
  const leaseId = id('lse');
  const endDate = addDays(addMonths(app.move_in, app.term_months), -1);
  tx(() => {
    insert('leases', {
      id: leaseId, org_id: ctx.orgId, property_id: app.property_id, unit_id: app.unit_id,
      household_name: `${primary?.last_name || 'New'} household`, status: 'draft',
      start_date: app.move_in, end_date: endDate, move_in_date: app.move_in,
      rent_cents: app.rent_cents, deposit_cents: deposit, deposit_alternative: 0,
      term_months: app.term_months, application_id: applicationId, created_at: nowIso(),
    });
    insert('lease_charges', {
      id: id('lc'), org_id: ctx.orgId, lease_id: leaseId, kind: 'rent',
      label: `Rent — ${unit.unit_number}`, amount_cents: app.rent_cents, created_at: nowIso(),
    });
    // rentable items from the originating quote
    if (app.quote_id) {
      const quote = q1<any>('SELECT * FROM quotes WHERE id=?', app.quote_id);
      for (const item of j<any[]>(quote?.items, [])) {
        const ri = q1<any>(`SELECT * FROM rentable_items WHERE property_id=? AND label=? AND status='available'`, app.property_id, item.label);
        if (ri) {
          run(`UPDATE rentable_items SET status='assigned', assigned_lease_id=? WHERE id=?`, leaseId, ri.id);
          insert('lease_charges', {
            id: id('lc'), org_id: ctx.orgId, lease_id: leaseId, kind: ri.kind, label: ri.label,
            amount_cents: ri.monthly_cents, rentable_item_id: ri.id, created_at: nowIso(),
          });
        }
      }
    }
    update('applications', applicationId, { status: 'converted', lease_id: leaseId });
  });
  audit(ctx, 'lease', leaseId, 'create_from_application', null, { applicationId });
  emit(ctx, 'lease.drafted', 'lease', leaseId, { applicationId });
  return leaseId;
}

// ---------- packet assembly ----------

interface PacketSigner {
  name: string;
  email: string;
  role: 'resident' | 'guarantor' | 'countersigner';
}

export async function buildPacket(ctx: Ctx, leaseId: string): Promise<{ fileId: string; sha256: string }> {
  const lease = q1<any>(
    `SELECT l.*, u.unit_number, p.name AS prop_name, p.address1, p.city, p.state, p.zip FROM leases l
     JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=l.property_id WHERE l.id=? AND l.org_id=?`,
    leaseId, ctx.orgId,
  );
  if (!lease) throw new Error('lease not found');
  const org = q1<any>('SELECT name FROM orgs WHERE id=?', ctx.orgId);
  const tpl = templateFor(ctx, lease.property_id);
  const charges = q<any>('SELECT * FROM lease_charges WHERE lease_id=? ORDER BY amount_cents DESC', leaseId);
  const names = householdNames(ctx, leaseId);
  const merged = String(tpl.body)
    .replaceAll('{{landlord}}', org?.name || 'Landlord')
    .replaceAll('{{household_names}}', names.join(', ') || lease.household_name)
    .replaceAll('{{property_name}}', lease.prop_name)
    .replaceAll('{{unit_number}}', lease.unit_number)
    .replaceAll('{{property_address}}', `${lease.address1}, ${lease.city}, ${lease.state} ${lease.zip}`)
    .replaceAll('{{start_date}}', fmtDate(lease.start_date))
    .replaceAll('{{end_date}}', fmtDate(lease.end_date))
    .replaceAll('{{term_months}}', String(lease.term_months))
    .replaceAll('{{rent}}', usd(lease.rent_cents))
    .replaceAll('{{deposit}}', usd(lease.deposit_cents));

  const pdf = await Pdf.create(`Lease — ${lease.household_name} — ${lease.unit_number}`);
  pdf.brandHeader(lease.prop_name, [`${lease.address1}, ${lease.city}, ${lease.state} ${lease.zip}`, `Lease packet · template "${tpl.name}" v${tpl.version}`]);
  for (const para of merged.split('\n\n')) {
    if (para.trim().toUpperCase() === para.trim() && para.trim().length < 60) pdf.h2(para.trim());
    else pdf.text(para.trim());
  }
  pdf.h2('Recurring charge schedule (drives monthly billing)');
  pdf.table(
    [
      { label: 'Charge', w: 0.5 },
      { label: 'Kind', w: 0.25 },
      { label: 'Monthly', w: 0.25, align: 'right' },
    ],
    charges.map((c) => [c.label, c.kind.replaceAll('_', ' '), usd(c.amount_cents)]),
    { totals: ['Total recurring', '', usd(charges.reduce((s, c) => s + c.amount_cents, 0))] },
  );
  // conditional addenda
  const conditions = addendaConditions(ctx, leaseId);
  const addenda = q<any>(`SELECT * FROM addenda_library WHERE org_id=? AND active=1 ORDER BY sort`, ctx.orgId)
    .filter((a) => !a.condition_key || a.condition_key === 'always' || conditions.has(a.condition_key));
  for (const a of addenda) {
    pdf.addPage();
    pdf.h1(`Addendum — ${a.title}`);
    for (const para of String(a.body).split('\n\n')) pdf.text(para);
    pdf.space(10);
    pdf.text('Agreed and incorporated into the lease by the signatures on the execution certificate.', { muted: true, size: 8.5 });
  }
  pdf.footerAllPages(`${lease.prop_name} · lease packet · generated ${fmtDate(ctx.businessDate)}`);
  const bytes = await pdf.bytes();
  const sha = createHash('sha256').update(bytes).digest('hex');
  const file = putFile(ctx, bytes, {
    name: `lease-packet-${lease.unit_number}-${leaseId.slice(-6)}.pdf`, mime: 'application/pdf',
    entity: 'lease', entityId: leaseId, visibility: 'staff',
  });
  return { fileId: file.id, sha256: sha };
}

function householdNames(ctx: Ctx, leaseId: string): string[] {
  const lease = q1<any>('SELECT * FROM leases WHERE id=?', leaseId);
  if (lease?.application_id) {
    return q<any>(`SELECT first_name, last_name FROM applicants WHERE application_id=? AND kind IN ('primary','co')`, lease.application_id)
      .map((a) => `${a.first_name} ${a.last_name}`.trim()).filter(Boolean);
  }
  return q<any>(
    `SELECT r.first_name, r.last_name FROM household_members hm JOIN residents r ON r.id=hm.resident_id WHERE hm.lease_id=? AND hm.role IN ('primary','co')`,
    leaseId,
  ).map((r) => `${r.first_name} ${r.last_name}`);
}

function addendaConditions(ctx: Ctx, leaseId: string): Set<string> {
  const out = new Set<string>();
  const lease = q1<any>('SELECT * FROM leases WHERE id=?', leaseId);
  const prop = q1<any>('SELECT type FROM properties WHERE id=?', lease.property_id);
  if (prop?.type === 'student') out.add('student');
  const kinds = q<any>('SELECT DISTINCT kind FROM lease_charges WHERE lease_id=?', leaseId).map((x) => x.kind);
  if (kinds.includes('pet_rent')) out.add('has_pet');
  if (kinds.some((k) => ['parking', 'garage', 'storage'].includes(k))) out.add('has_parking');
  if (kinds.includes('concession')) out.add('concession');
  if (lease?.application_id) {
    const g = val<number>(`SELECT COUNT(*) FROM applicants WHERE application_id=? AND kind='guarantor'`, lease.application_id) || 0;
    if (g > 0) out.add('has_guarantor');
    if (q1(`SELECT id FROM guaranty_contracts WHERE application_id=? AND status='active'`, lease.application_id)) out.add('inst_guaranty');
  } else {
    const g = val<number>(`SELECT COUNT(*) FROM household_members WHERE lease_id=? AND role='guarantor'`, leaseId) || 0;
    if (g > 0) out.add('has_guarantor');
  }
  if (lease?.deposit_alternative || q1(`SELECT id FROM deposit_alternatives WHERE lease_id=? AND status='active'`, leaseId)) out.add('deposit_alt');
  return out;
}

// ---------- e-signature ----------

export function startSignatureRequest(ctx: Ctx, leaseId: string, kind: 'lease' | 'renewal', packet: { fileId: string; sha256: string }, signers: PacketSigner[], baseUrl: string): string {
  const reqId = id('sig');
  tx(() => {
    insert('signature_requests', {
      id: reqId, org_id: ctx.orgId, lease_id: leaseId, kind, status: 'out',
      doc_file_id: packet.fileId, doc_sha256: packet.sha256,
      events: js([{ at: nowIso(), who: ctx.userName, action: 'request_created', hash: packet.sha256 }]),
      created_at: nowIso(),
    });
    signers.forEach((s, i) => {
      const t = token(16);
      insert('signature_signers', {
        id: id('sgn'), org_id: ctx.orgId, request_id: reqId, name: s.name, email: s.email,
        role: s.role, token: t, order_idx: i, status: 'pending', created_at: nowIso(),
      });
      if (s.role !== 'countersigner') {
        sendEmail(ctx, {
          to: s.email, toName: s.name, subject: `Your lease is ready to sign`,
          body: `<p>Hi ${s.name.split(' ')[0]},</p><p>Your lease packet is ready. Review and sign here:</p><p><a href="${baseUrl}/sign/${t}">${baseUrl}/sign/${t}</a></p><p>The document is fingerprinted (SHA-256 ${packet.sha256.slice(0, 16)}…) so everyone signs exactly the same packet.</p>`,
          entity: 'signature_request', entityId: reqId, templateKey: 'esign_invite',
        });
      }
    });
    run(`UPDATE leases SET status='out_for_signature', esign_request_id=?, packet_file_id=? WHERE id=?`, reqId, packet.fileId, leaseId);
  });
  emit(ctx, 'esign.sent', 'signature_request', reqId, { leaseId, signers: signers.length });
  return reqId;
}

function pushEvent(reqId: string, who: string, action: string, extra: string): void {
  const req = q1<any>('SELECT events FROM signature_requests WHERE id=?', reqId);
  const events = j<any[]>(req.events, []);
  const prevHash = events.length ? events[events.length - 1].hash : '';
  const hash = createHash('sha256').update(prevHash + who + action + extra + nowIso()).digest('hex');
  events.push({ at: nowIso(), who, action, extra, hash });
  run('UPDATE signature_requests SET events=? WHERE id=?', js(events), reqId);
}

export function recordSignature(
  ctx: Ctx,
  signerToken: string,
  sig: { kind: 'typed' | 'drawn'; text?: string; pngDataUrl?: string; initials: string },
): { requestId: string; complete: boolean } {
  const signer = q1<any>('SELECT * FROM signature_signers WHERE token=?', signerToken);
  if (!signer) throw new Error('signer link not found');
  if (signer.status === 'signed') return { requestId: signer.request_id, complete: false };
  const req = q1<any>('SELECT * FROM signature_requests WHERE id=?', signer.request_id);
  if (req.status !== 'out') throw new Error('this request is no longer open');
  // countersigner must wait for everyone else (sequential countersign)
  if (signer.role === 'countersigner') {
    const waiting = val<number>(
      `SELECT COUNT(*) FROM signature_signers WHERE request_id=? AND role != 'countersigner' AND status != 'signed'`,
      req.id,
    ) || 0;
    if (waiting > 0) throw new Error('residents must sign before the countersignature');
  }
  let sigFileId: string | null = null;
  if (sig.kind === 'drawn' && sig.pngDataUrl?.startsWith('data:image/png')) {
    const data = Buffer.from(sig.pngDataUrl.split(',')[1] || '', 'base64');
    if (data.length > 100) {
      sigFileId = putFile(sysCtx(signer.org_id), data, {
        name: `signature-${signer.id}.png`, mime: 'image/png', entity: 'signature', entityId: signer.id, visibility: 'staff',
      }).id;
    }
  }
  update('signature_signers', signer.id, {
    status: 'signed', signature_kind: sig.kind, signature_text: sig.text || null,
    signature_file_id: sigFileId, initials: sig.initials, signed_at: nowIso(),
  });
  pushEvent(req.id, `${signer.name} <${signer.email}>`, `signed_${sig.kind}`, sig.text || sigFileId || '');
  const orgCtx = sysCtx(signer.org_id);
  emit(orgCtx, 'esign.signed', 'signature_request', req.id, { signer: signer.name, role: signer.role });

  const remaining = q<any>(`SELECT * FROM signature_signers WHERE request_id=? AND status='pending'`, req.id);
  const lease = q1<any>('SELECT * FROM leases WHERE id=?', req.lease_id);
  if (remaining.length === 0) {
    void finalizeSignedPacket(orgCtx, req.id);
    return { requestId: req.id, complete: true };
  }
  // lease → partially_signed; notify countersigner when only they remain
  if (lease.status === 'out_for_signature') run(`UPDATE leases SET status='partially_signed' WHERE id=?`, lease.id);
  const onlyCounter = remaining.every((x) => x.role === 'countersigner');
  if (onlyCounter) {
    for (const c of remaining) {
      sendEmail(orgCtx, {
        to: c.email, toName: c.name, subject: 'Lease ready for countersignature',
        body: `<p>All residents have signed. Countersign here to execute the lease:</p><p><a href="/sign/${c.token}">/sign/${c.token}</a></p>`,
        entity: 'signature_request', entityId: req.id, templateKey: 'esign_countersign',
      });
    }
  }
  return { requestId: req.id, complete: false };
}

/** executed packet = original + signature page + certificate page (immutable) */
async function finalizeSignedPacket(ctx: Ctx, requestId: string): Promise<void> {
  const req = q1<any>('SELECT * FROM signature_requests WHERE id=?', requestId);
  const signers = q<any>('SELECT * FROM signature_signers WHERE request_id=? ORDER BY order_idx', requestId);
  const original = getFile(req.doc_file_id);
  if (!original) throw new Error('packet file missing');

  const sigPdf = await Pdf.create('Execution certificate');
  sigPdf.h1('Signatures');
  for (const s of signers) {
    sigPdf.text(`${s.name} — ${s.role}${s.initials ? ` · initials ${s.initials}` : ''}`, { bold: true });
    if (s.signature_kind === 'typed') sigPdf.text(`/s/ ${s.signature_text}`, { size: 13 });
    else sigPdf.text('[drawn signature on file — embedded below]');
    sigPdf.text(`Signed ${s.signed_at?.slice(0, 19).replace('T', ' ')} UTC`, { muted: true, size: 8 });
    sigPdf.space(6);
  }
  sigPdf.addPage();
  sigPdf.h1('Completion certificate');
  sigPdf.kv([
    ['Request', requestId],
    ['Document SHA-256', req.doc_sha256],
    ['Completed', nowIso()],
  ]);
  sigPdf.h2('Tamper-evident event trail');
  for (const e of j<any[]>(req.events, [])) {
    sigPdf.text(`${e.at} — ${e.who} — ${e.action}`, { size: 8.5 });
    sigPdf.text(`   chain ${String(e.hash).slice(0, 40)}…`, { muted: true, size: 7.5 });
  }
  const sigBytes = await sigPdf.bytes();

  // merge original + signature/cert pages; embed drawn signatures
  const merged = await PDFDocument.create();
  const orig = await PDFDocument.load(original.data);
  const extra = await PDFDocument.load(sigBytes);
  for (const p of await merged.copyPages(orig, orig.getPageIndices())) merged.addPage(p);
  const extraPages = await merged.copyPages(extra, extra.getPageIndices());
  for (const p of extraPages) merged.addPage(p);
  // draw signature images onto the signatures page (first extra page)
  const sigPage = merged.getPage(orig.getPageCount());
  let y = sigPage.getHeight() - 100;
  for (const s of signers) {
    if (s.signature_file_id) {
      const f = getFile(s.signature_file_id);
      if (f) {
        try {
          const png = await merged.embedPng(f.data);
          sigPage.drawImage(png, { x: 330, y: y - 20, width: 160, height: 44 });
        } catch { /* non-png ignored */ }
      }
    }
    y -= 78;
  }
  const finalBytes = await merged.save();
  const signedFile = putFile(ctx, finalBytes, {
    name: `lease-executed-${req.lease_id.slice(-6)}.pdf`, mime: 'application/pdf',
    entity: 'lease', entityId: req.lease_id, visibility: 'resident',
  });
  update('signature_requests', requestId, { status: 'completed', signed_file_id: signedFile.id, completed_at: nowIso() });
  pushEvent(requestId, 'system', 'completed', signedFile.sha256);
  run(`UPDATE leases SET status='fully_executed', packet_file_id=? WHERE id=?`, signedFile.id, req.lease_id);
  emit(ctx, 'lease.fully_executed', 'lease', req.lease_id, { requestId });
  audit(ctx, 'lease', req.lease_id, 'fully_executed', null, { sha256: signedFile.sha256 });
}

// ---------- activation (M6.4) ----------

export function activateLease(ctx: Ctx, leaseId: string): void {
  const lease = q1<any>('SELECT * FROM leases WHERE id=? AND org_id=?', leaseId, ctx.orgId);
  if (!lease || lease.status !== 'fully_executed') throw new Error('lease must be fully executed');
  assertAffordableCompliance(ctx, lease); // M18.2: program units gate on cert + rent limit
  const unit = q1<any>('SELECT * FROM units WHERE id=?', lease.unit_id);
  tx(() => {
    // renewals: retire the prior lease
    if (lease.renewal_of_lease_id) {
      run(`UPDATE leases SET status='renewed' WHERE id=?`, lease.renewal_of_lease_id);
    }
    run(`UPDATE leases SET status='active' WHERE id=?`, leaseId);
    run(`UPDATE units SET status='occupied' WHERE id=?`, lease.unit_id);

    // people: applicants → residents with portal accounts (fresh leases only)
    if (lease.application_id && !q1('SELECT id FROM household_members WHERE lease_id=? LIMIT 1', leaseId)) {
      const applicants = q<any>('SELECT * FROM applicants WHERE application_id=?', lease.application_id);
      for (const a of applicants) {
        if (a.kind === 'occupant' && !a.first_name) continue;
        let userId: string | null = null;
        if (['primary', 'co'].includes(a.kind) && a.email) {
          const existing = q1<any>('SELECT id FROM users WHERE email=?', a.email);
          userId = existing?.id || null;
          if (!userId) {
            userId = id('usr');
            insert('users', {
              id: userId, org_id: ctx.orgId, email: a.email, name: `${a.first_name} ${a.last_name}`.trim() || a.email,
              kind: 'resident', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
            });
          }
        }
        const rid = id('res');
        insert('residents', {
          id: rid, org_id: ctx.orgId, property_id: lease.property_id, user_id: userId,
          first_name: a.first_name || 'Resident', last_name: a.last_name || '', email: a.email, phone: a.phone,
          kind: a.kind === 'guarantor' ? 'guarantor' : a.kind === 'occupant' ? 'occupant' : 'adult',
          employer: a.employer, monthly_income_cents: a.income_monthly_cents, ssn_last4: a.ssn_last4, created_at: nowIso(),
        });
        insert('household_members', {
          id: id('hm'), org_id: ctx.orgId, lease_id: leaseId, resident_id: rid,
          role: a.kind === 'primary' ? 'primary' : a.kind === 'co' ? 'co' : a.kind, created_at: nowIso(),
        });
      }
    } else if (lease.renewal_of_lease_id) {
      // carry the household forward
      const members = q<any>('SELECT * FROM household_members WHERE lease_id=?', lease.renewal_of_lease_id);
      for (const m of members) {
        if (!q1('SELECT id FROM household_members WHERE lease_id=? AND resident_id=?', leaseId, m.resident_id)) {
          insert('household_members', { id: id('hm'), org_id: ctx.orgId, lease_id: leaseId, resident_id: m.resident_id, role: m.role, created_at: nowIso() });
        }
      }
      // ledger continuity: balance-forward the prior lease's remaining balance
      // onto the renewal lease (offsetting AR↔AR pair — GL is untouched) so the
      // household's running balance never "disappears" at rollover.
      const carry = leaseBalance(ctx, lease.renewal_of_lease_id);
      if (carry !== 0) {
        createCharge(ctx, {
          leaseId, kind: 'other', label: 'Balance forward from prior lease term',
          amountCents: carry, date: lease.start_date, dueDate: lease.start_date, source: 'oneoff',
        });
        createCharge(ctx, {
          leaseId: lease.renewal_of_lease_id, kind: 'other', label: 'Balance transferred to renewal lease',
          amountCents: -carry, date: lease.start_date, dueDate: lease.start_date, source: 'oneoff',
        });
      }
      // autopay + open maintenance requests carry over (same home, same people)
      run(`UPDATE autopay_enrollments SET lease_id=? WHERE lease_id=? AND active=1`, leaseId, lease.renewal_of_lease_id);
      run(`UPDATE work_orders SET lease_id=? WHERE lease_id=? AND status NOT IN ('completed','canceled')`, leaseId, lease.renewal_of_lease_id);
    }

    // deposit alternative (M12): no traditional deposit; one-time premiums and
    // guaranty fees post at move-in instead
    const alt = q1<any>(`SELECT * FROM deposit_alternatives WHERE lease_id=? AND status='active'`, leaseId);
    if (alt?.mode === 'one_time' && !q1(`SELECT id FROM charges WHERE lease_id=? AND kind='deposit_alternative'`, leaseId)) {
      createCharge(ctx, {
        leaseId, kind: 'deposit_alternative', label: 'Deposit alternative — one-time premium',
        amountCents: alt.fee_cents, date: lease.start_date, dueDate: lease.start_date, source: 'move_in',
      });
    }
    if (lease.application_id) {
      const gty = q1<any>(`SELECT * FROM guaranty_contracts WHERE application_id=? AND status='active'`, lease.application_id);
      if (gty && !q1(`SELECT id FROM charges WHERE lease_id=? AND kind='guaranty'`, leaseId)) {
        createCharge(ctx, {
          leaseId, kind: 'guaranty', label: 'Institutional guaranty fee (one-time)',
          amountCents: gty.fee_cents, date: lease.start_date, dueDate: lease.start_date, source: 'move_in',
        });
        run('UPDATE guaranty_contracts SET lease_id=? WHERE id=?', leaseId, gty.id);
      }
    }

    // money (fresh leases): security deposit charge + holding-deposit credit.
    // Renewals keep the deposit already held on file — never re-charge it.
    if (!lease.renewal_of_lease_id && !alt && lease.deposit_cents > 0 && !q1(`SELECT id FROM charges WHERE lease_id=? AND kind='deposit'`, leaseId)) {
      createCharge(ctx, {
        leaseId, kind: 'deposit', label: 'Security deposit', amountCents: lease.deposit_cents,
        date: lease.start_date, dueDate: lease.start_date, source: 'move_in',
      });
      if (lease.application_id) {
        const app = q1<any>('SELECT * FROM applications WHERE id=?', lease.application_id);
        if (app?.hold_deposit_cents > 0 && app.fees_paid) {
          recordPayment(ctx, {
            leaseId, amountCents: app.hold_deposit_cents, method: 'credit', creditFunding: '2200',
            receivedDate: lease.start_date, memo: 'application holding deposit applied', suppressReceipt: true,
          });
        }
      }
    }
    postMonthlyChargesForLease(ctx, { ...lease, status: 'active' }, monthKey(lease.start_date));

    // move-in checklist (fresh move-ins only — a renewal household is already home)
    if (!lease.renewal_of_lease_id && !q1(`SELECT id FROM move_checklists WHERE lease_id=? AND kind='move_in'`, leaseId)) {
      insert('move_checklists', {
        id: id('mcl'), org_id: ctx.orgId, lease_id: leaseId, kind: 'move_in',
        items: js([
          { key: 'insurance', label: 'Upload renters insurance or enroll in the master policy', done: false, who: 'resident' },
          { key: 'utilities', label: 'Acknowledge utility transfer (electric in your name)', done: false, who: 'resident' },
          { key: 'inspection', label: 'Complete move-in inspection walk', done: false, who: 'staff' },
          { key: 'keys', label: 'Pick up keys & access credentials', done: false, who: 'staff' },
          { key: 'autopay', label: 'Set up autopay (optional but loved)', done: false, who: 'resident' },
        ]),
        created_at: nowIso(),
      });
    }
  });
  // lead attribution
  const app = lease.application_id ? q1<any>('SELECT lead_id FROM applications WHERE id=?', lease.application_id) : null;
  if (app?.lead_id) {
    run(`UPDATE leads SET status='leased', lease_id=? WHERE id=?`, leaseId, app.lead_id);
  }
  emit(ctx, 'lease.activated', 'lease', leaseId, { unitId: lease.unit_id, propertyId: lease.property_id, renewal: !!lease.renewal_of_lease_id });
  audit(ctx, 'lease', leaseId, 'activated');
}

registerJob({
  key: 'lease_activation',
  name: 'Lease activation (move-in day)',
  describe: 'Activates fully-executed leases whose start date has arrived: unit occupied, household + portal accounts, deposits, first charges, move-in checklist.',
  run: (ctx, date) => {
    const due = q<any>(`SELECT id FROM leases WHERE org_id=? AND status='fully_executed' AND start_date<=?`, ctx.orgId, date);
    for (const l of due) activateLease(ctx, l.id);
    return due.length ? `${due.length} leases activated` : 'no move-ins today';
  },
});

registerJob({
  key: 'lease_rollover',
  name: 'Month-to-month rollover',
  describe: 'Active leases past their end date without an accepted renewal convert to month-to-month (premium applies).',
  run: (ctx, date) => {
    const due = q<any>(
      `SELECT l.id FROM leases l WHERE l.org_id=? AND l.status='active' AND l.end_date<?
       AND NOT EXISTS (SELECT 1 FROM renewal_offers ro WHERE ro.lease_id=l.id AND ro.status='accepted')`,
      ctx.orgId, date,
    );
    for (const l of due) {
      run(`UPDATE leases SET status='month_to_month', mtm_since=(SELECT end_date FROM leases WHERE id=?) WHERE id=?`, l.id, l.id);
      emit(ctx, 'lease.mtm', 'lease', l.id, {});
    }
    return due.length ? `${due.length} leases rolled to month-to-month` : 'no holdovers';
  },
});

// ---------- renewals (M6.5) ----------

/** offer matrix: M13 engine rows when present, else capped defaults; program
 * (affordable) units clamp every option to the AMI rent limit (M18.2) */
export function renewalMatrix(ctx: Ctx, lease: any): { term_months: number; rent_cents: number }[] {
  const unit = q1<any>('SELECT * FROM units WHERE id=?', lease.unit_id);
  const affordableMax = maxTenantRent(ctx, unit);
  const clamp = (rows: { term_months: number; rent_cents: number }[]): { term_months: number; rent_cents: number }[] =>
    affordableMax === null ? rows : rows.map((r) => ({ ...r, rent_cents: Math.min(r.rent_cents, affordableMax) }));
  const priced = q<any>(
    `SELECT term_months, COALESCE(accepted_rent_cents, recommended_rent_cents) AS rent FROM price_recommendations
     WHERE unit_id=? AND status IN ('accepted') AND date>=? ORDER BY term_months`,
    lease.unit_id, addDays(ctx.businessDate, -30),
  );
  if (priced.length >= 2) return clamp(priced.map((p) => ({ term_months: p.term_months, rent_cents: p.rent })));
  const capPct = getSetting<number>(ctx, 'renewal_max_increase_pct', lease.property_id);
  const base = lease.rent_cents;
  const raw = [
    { term_months: 15, pct: 3 },
    { term_months: 12, pct: 4 },
    { term_months: 9, pct: 5.5 },
    { term_months: 6, pct: 7 },
  ];
  return clamp(raw.map((r) => ({
    term_months: r.term_months,
    rent_cents: Math.round((base * (1 + Math.min(r.pct, capPct) / 100)) / 100) * 100,
  })));
}

export function createRenewalOffer(ctx: Ctx, leaseId: string): string {
  const lease = q1<any>('SELECT * FROM leases WHERE id=? AND org_id=?', leaseId, ctx.orgId);
  if (!lease) throw new Error('lease not found');
  const existing = q1<any>(`SELECT id FROM renewal_offers WHERE lease_id=? AND status IN ('sent','accepted','countered')`, leaseId);
  if (existing) return existing.id as string;
  const options = renewalMatrix(ctx, lease);
  const offerId = id('rno');
  insert('renewal_offers', {
    id: offerId, org_id: ctx.orgId, property_id: lease.property_id, lease_id: leaseId,
    options: js(options), status: 'sent', expires_date: addDays(ctx.businessDate, 30), created_at: nowIso(),
  });
  const contact = q1<any>(
    `SELECT r.* FROM household_members hm JOIN residents r ON r.id=hm.resident_id WHERE hm.lease_id=? AND hm.role='primary'`,
    leaseId,
  );
  if (contact?.email) {
    sendEmail(ctx, {
      to: contact.email, toName: `${contact.first_name} ${contact.last_name}`,
      subject: `Your renewal options are ready 🏡`,
      body: `<p>Hi ${contact.first_name},</p><p>We'd love to keep you! Your renewal options:</p><ul>${options.map((o) => `<li><b>${o.term_months} months</b> — ${usd(o.rent_cents)}/mo</li>`).join('')}</ul><p>Accept right in the resident portal (Lease tab) — or reply with questions.</p>`,
      propertyId: lease.property_id, entity: 'renewal_offer', entityId: offerId, personId: contact.id, templateKey: 'renewal_offer',
    });
  }
  emit(ctx, 'renewal.offered', 'renewal_offer', offerId, { leaseId });
  audit(ctx, 'renewal_offer', offerId, 'create', null, { leaseId, options: options.length });
  return offerId;
}

export function acceptRenewal(ctx: Ctx, offerId: string, termMonths: number, baseUrl: string): string {
  const offer = q1<any>('SELECT * FROM renewal_offers WHERE id=? AND org_id=?', offerId, ctx.orgId);
  if (!offer || !['sent', 'countered'].includes(offer.status)) throw new Error('offer not open');
  const option = j<any[]>(offer.options, []).find((o) => o.term_months === termMonths);
  if (!option) throw new Error('unknown option');
  const oldLease = q1<any>('SELECT * FROM leases WHERE id=?', offer.lease_id);
  const start = addDays(oldLease.end_date, 1);
  const newLeaseId = id('lse');
  tx(() => {
    insert('leases', {
      id: newLeaseId, org_id: ctx.orgId, property_id: oldLease.property_id, unit_id: oldLease.unit_id,
      household_name: oldLease.household_name, status: 'draft',
      start_date: start, end_date: addDays(addMonths(start, termMonths), -1), move_in_date: oldLease.move_in_date,
      rent_cents: option.rent_cents, deposit_cents: oldLease.deposit_cents, deposit_alternative: oldLease.deposit_alternative,
      term_months: termMonths, renewal_of_lease_id: oldLease.id, created_at: nowIso(),
    });
    // carry the recurring schedule at the new rent
    const lines = q<any>('SELECT * FROM lease_charges WHERE lease_id=?', oldLease.id);
    for (const lc of lines) {
      insert('lease_charges', {
        id: id('lc'), org_id: ctx.orgId, lease_id: newLeaseId, kind: lc.kind, label: lc.label,
        amount_cents: lc.kind === 'rent' ? option.rent_cents : lc.amount_cents,
        rentable_item_id: lc.rentable_item_id, created_at: nowIso(),
      });
    }
    update('renewal_offers', offerId, { status: 'accepted', accepted_term: termMonths, accepted_rent_cents: option.rent_cents, new_lease_id: newLeaseId, decided_at: nowIso() });
  });
  emit(ctx, 'renewal.accepted', 'renewal_offer', offerId, { leaseId: oldLease.id, newLeaseId, termMonths });
  // packet + e-sign for the renewal
  void (async () => {
    const packet = await buildPacket(sysCtx(ctx.orgId), newLeaseId);
    const adults = q<any>(
      `SELECT r.first_name, r.last_name, r.email FROM household_members hm JOIN residents r ON r.id=hm.resident_id
       WHERE hm.lease_id=? AND hm.role IN ('primary','co') AND r.email IS NOT NULL`,
      oldLease.id,
    );
    const pm = q1<any>(
      `SELECT u.name, u.email FROM users u JOIN role_assignments ra ON ra.user_id=u.id
       WHERE u.org_id=? AND ra.role IN ('PROPERTY_MANAGER','ORG_ADMIN') AND u.active=1 LIMIT 1`,
      ctx.orgId,
    );
    startSignatureRequest(sysCtx(ctx.orgId), newLeaseId, 'renewal', packet, [
      ...adults.map((a) => ({ name: `${a.first_name} ${a.last_name}`, email: a.email, role: 'resident' as const })),
      ...(pm ? [{ name: pm.name, email: pm.email, role: 'countersigner' as const }] : []),
    ], baseUrl);
  })();
  return newLeaseId;
}
