import { createHash } from 'node:crypto';
import { q, q1, insert, val, run, update, tx, j, js } from '../../lib/db.ts';
import { id, token } from '../../lib/ids.ts';
import { nowIso, addDays, addMonths, fmtDate, monthKey, diffDays, daysInMonth, parts, lastOfMonth, maxDate, minDate } from '../../lib/dates.ts';
import { usd } from '../../lib/money.ts';
import type { Ctx } from '../../lib/auth.ts';
import { sysCtx, hashPassword , tempPassword } from '../../lib/auth.ts';
import { sendPortalInvite } from '../people/portal.ts';
import { emit, on } from '../../lib/events.ts';
import { getSetting, getSettingMerged, scorerMode } from '../../lib/settings.ts';
import { latestAssessment } from '../m19_scoring/service.ts';
import { registerJob } from '../../lib/jobs.ts';
import { audit } from '../../lib/audit.ts';
import { sendEmail, messageOrigin } from '../../lib/sim/messaging.ts';
import { esc } from '../../lib/html.ts';
import { Pdf } from '../../lib/pdf.ts';
import { putFile, getFile } from '../../lib/files.ts';
import { PDFDocument } from 'pdf-lib';
import { createCharge, postMonthlyChargesForLease, leaseBalance } from '../m8_receivables/service.ts';
import { recordPayment, registerNoticeHook } from '../m8_receivables/payments.ts';
import { assertAffordableCompliance, maxTenantRent } from '../m18_verticals/service.ts';
import { postBothBases } from '../m9_accounting/service.ts';

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
  const criteria = getSettingMerged<any>(ctx, 'screening_criteria', app.property_id);
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
  // links in an email come from the configured origin, never the Host header
  // the request happened to carry; the demo with no origin keeps the caller's
  const linkBase = messageOrigin(ctx) || baseUrl;
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
          body: `<p>Hi ${esc(s.name.split(' ')[0] ?? '')},</p><p>Your lease packet is ready. Review and sign here:</p><p><a href="${linkBase}/sign/${t}">${linkBase}/sign/${t}</a></p><p>The document is fingerprinted (SHA-256 ${packet.sha256.slice(0, 16)}…) so everyone signs exactly the same packet.</p>`,
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
    // absolute in a live org — an inbox has no page for '/sign/…' to be
    // relative to; the demo with no origin configured keeps the relative link
    const linkBase = messageOrigin(orgCtx);
    for (const c of remaining) {
      sendEmail(orgCtx, {
        to: c.email, toName: c.name, subject: 'Lease ready for countersignature',
        body: `<p>All residents have signed. Countersign here to execute the lease:</p><p><a href="${linkBase}/sign/${c.token}">${linkBase}/sign/${c.token}</a></p>`,
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
  // One household per unit (per bed, where leased by the bed). A renewal takes
  // over from its own prior term; any other lease must find the unit free —
  // otherwise both would be current and both billed.
  if (!lease.renewal_of_lease_id) {
    const other = q1<any>(
      `SELECT household_name, status, move_out_date FROM leases WHERE org_id=? AND unit_id=? AND id<>?
         AND COALESCE(bed_label,'')=COALESCE(?,'')
         AND (status IN ('active','month_to_month') OR (status='notice' AND (move_out_date IS NULL OR move_out_date >= ?))) LIMIT 1`,
      ctx.orgId, lease.unit_id, leaseId, lease.bed_label ?? null, lease.start_date,
    );
    if (other) {
      throw new Error(`Unit ${unit?.unit_number || ''} still has a current lease (${other.household_name}). Record its move-out before this lease can start.`.replace('  ', ' '));
    }
  }
  tx(() => {
    // renewals: retire the prior lease
    if (lease.renewal_of_lease_id) {
      run(`UPDATE leases SET status='renewed' WHERE id=?`, lease.renewal_of_lease_id);
    }
    run(`UPDATE leases SET status='active' WHERE id=?`, leaseId);
    run(`UPDATE units SET status='occupied', vacant_since=NULL, vacant_since_source=NULL WHERE id=?`, lease.unit_id);

    // people: applicants → residents with portal accounts (fresh leases only)
    if (lease.application_id && !q1('SELECT id FROM household_members WHERE lease_id=? LIMIT 1', leaseId)) {
      const applicants = q<any>('SELECT * FROM applicants WHERE application_id=?', lease.application_id);
      for (const a of applicants) {
        if (a.kind === 'occupant' && !a.first_name) continue;
        let userId: string | null = null;
        let issuedOneTime: string | null = null;
        if (['primary', 'co'].includes(a.kind) && a.email) {
          const existing = q1<any>('SELECT id FROM users WHERE email=?', a.email);
          userId = existing?.id || null;
          if (!userId) {
            userId = id('usr');
            // the credential must reach the resident — generate, hash, and
            // send it in the portal invite below (it was previously discarded)
            issuedOneTime = ctx.orgKind === 'live' ? tempPassword() : 'demo1234';
            insert('users', {
              id: userId, org_id: ctx.orgId, email: a.email, name: `${a.first_name} ${a.last_name}`.trim() || a.email,
              kind: 'resident', password_hash: hashPassword(issuedOneTime), active: 1, created_at: nowIso(),
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
        if (issuedOneTime && a.email) {
          sendPortalInvite(ctx, {
            residentId: rid, email: a.email, firstName: a.first_name || 'there',
            name: `${a.first_name} ${a.last_name}`.trim() || a.email,
            propertyId: lease.property_id, oneTime: issuedOneTime,
          });
        }
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
      creditRenewalOverlap(ctx, lease);
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
    // A deposit that was already in the bank when the lease was entered by
    // hand is recorded as held at entry (createLeaseManual) — never billed.
    if (!lease.renewal_of_lease_id && !alt && !lease.deposit_on_hand && lease.deposit_cents > 0 && !q1(`SELECT id FROM charges WHERE lease_id=? AND kind='deposit'`, leaseId)) {
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
    // First charges. A renewal bills from its own start date (the row carries
    // the household's original move-in, which would bill the whole first
    // month on top of the prior term's). Billing begins at the lease start —
    // or at "start billing from" on a lease entered by hand — and catches up
    // to the current month, so a lease activated after its first month is not
    // left with a gap the daily run (current month only) would never fill.
    const billed = { ...lease, status: 'active', ...(lease.renewal_of_lease_id ? { move_in_date: lease.start_date } : {}) };
    const firstBilled = lease.billing_start_date && lease.billing_start_date > lease.start_date ? lease.billing_start_date : lease.start_date;
    const lastMk = monthKey(ctx.businessDate);
    // "Start billing from" a month that has not arrived: nothing is owed yet.
    // The rent run posts that month when it comes. (A fresh lease activated
    // ahead of its start still gets its first month — due at move-in.)
    const deferred = !!lease.billing_start_date && lease.billing_start_date > lease.start_date && monthKey(firstBilled) > lastMk;
    if (!deferred) {
      let mk = monthKey(firstBilled);
      for (let i = 0; i < 24; i++) {
        postMonthlyChargesForLease(ctx, billed, mk);
        mk = monthKey(addMonths(mk + '-01', 1));
        if (mk > lastMk) break;
      }
    }

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

/** A renewal bills from its own start date. Whatever the prior term was
 * billed for the same days is credited back on the prior term before its
 * balance is carried forward, so no day is billed twice:
 *  · the start month — the prior term keeps the days before the renewal's
 *    start (none, when the renewal starts on the 1st);
 *  · every later month — a renewal signed after its start date leaves the
 *    prior term current through one or more rent runs; those months belong to
 *    the renewal, which bills them itself when it activates.
 * Only what was over-billed is credited — a prior-term charge already prorated
 * to its end date is left alone. Credits record the line and month they
 * correct (see adjustmentOf), so a second pass finds nothing left to credit. */
function creditRenewalOverlap(ctx: Ctx, lease: any): void {
  const { y, m, day } = parts(lease.start_date);
  const dim = daysInMonth(y, m);
  const keepDays = day - 1;
  const thirty = getSetting<string>(ctx, 'prorate_method', lease.property_id) === 'thirty_day';
  const frac = thirty ? Math.min(1, keepDays / 30) : keepDays / dim;
  const startMk = monthKey(lease.start_date);
  const prior = lease.renewal_of_lease_id;
  const rows = q<any>(
    `SELECT lc.id AS lease_charge_id, c.month_key, SUM(c.amount_cents) AS billed, lc.amount_cents AS full_cents, lc.kind, lc.label
     FROM charges c JOIN lease_charges lc ON lc.id=${LINE_OF_CHARGE}
     WHERE c.org_id=? AND c.lease_id=? AND c.month_key>=? AND c.status='active'
     GROUP BY lc.id, c.month_key ORDER BY c.month_key`,
    ctx.orgId, prior, startMk,
  );
  const premium = q<any>(
    `SELECT NULL AS lease_charge_id, c.month_key, SUM(c.amount_cents) AS billed, MAX(c.amount_cents) AS full_cents, 'mtm_premium' AS kind, 'Month-to-month premium' AS label
     FROM charges c WHERE c.org_id=? AND c.lease_id=? AND c.month_key>=? AND c.status='active' AND c.kind='mtm_premium' AND c.lease_charge_id IS NULL
     GROUP BY c.month_key ORDER BY c.month_key`,
    ctx.orgId, prior, startMk,
  );
  for (const c of [...rows, ...premium]) {
    const first = c.month_key === startMk;
    const keep = first ? Math.round(c.full_cents * frac) : 0;
    const over = c.billed - keep;
    if (over <= 0) continue;
    const date = first ? lease.start_date : ctx.businessDate;
    createCharge(ctx, {
      leaseId: prior, kind: c.kind,
      label: first && keepDays > 0
        ? `${c.label} — credit for ${dim - keepDays} days billed on the renewal`
        : `${c.label} — credit, month billed on the renewal`,
      amountCents: -over, date, dueDate: date, monthKey: c.month_key, source: adjustmentOf(c.lease_charge_id),
    });
  }
}

/** An adjustment to a recurring charge (a credit or a balance-of-month
 * charge) carries the month it corrects in month_key and the schedule line in
 * its source — `adjust:<lease_charge id>`, or `adjust:mtm_premium`. It cannot
 * carry lease_charge_id itself: one row per line and month is a UNIQUE key on
 * charges, and that row is the rent run's "already billed" marker. */
const adjustmentOf = (leaseChargeId: string | null): string => `adjust:${leaseChargeId || 'mtm_premium'}`;
/** SQL: the schedule line a charge row `c` belongs to — its own, or the one it adjusts */
const LINE_OF_CHARGE = `COALESCE(c.lease_charge_id, CASE WHEN c.source LIKE 'adjust:%' THEN substr(c.source, 8) END)`;

// ---------- recurring charges follow the move-out date ----------

/** The share of a month a lease is billed for, by the same rule the rent run
 * uses (postMonthlyChargesForLease): from move-in (a renewal: its start) to
 * the move-out date, by the property's proration method. */
function billedShare(ctx: Ctx, lease: any, mk: string, stopDate: string | null): { frac: number; prorated: boolean; days: number } {
  const monthStart = mk + '-01';
  const monthEnd = lastOfMonth(monthStart);
  const none = { frac: 0, prorated: true, days: 0 };
  if (lease.billing_start_date && monthEnd < lease.billing_start_date) return none;
  const effectiveStart = lease.renewal_of_lease_id ? lease.start_date : (lease.move_in_date || lease.start_date);
  if (effectiveStart > monthEnd) return none;
  if (stopDate && stopDate < monthStart) return none;
  const dim = daysInMonth(parts(monthStart).y, parts(monthStart).m);
  const from = maxDate(monthStart, effectiveStart);
  const to = stopDate ? minDate(monthEnd, stopDate) : monthEnd;
  const days = diffDays(to, from) + 1;
  if (days <= 0) return none;
  const thirty = getSetting<string>(ctx, 'prorate_method', lease.property_id) === 'thirty_day';
  return { frac: thirty ? Math.min(1, days / 30) : days / dim, prorated: days < dim, days };
}

/** Bring the recurring charges already on the ledger into line with the
 * lease's move-out date (`stopDate`; null = no move-out), from month `fromMk`
 * on. The rent run prorates a month only if the move-out date is known when
 * that month is posted, and never revisits a posted month — so a move-out
 * recorded after the 1st, a notice withdrawn, or a changed date would
 * otherwise leave the month billed for the wrong number of days.
 *
 * For each recurring line and month already billed, what the line should
 * have billed is compared with everything billed on it so far (the original
 * charge and any earlier adjustment — see adjustmentOf), and the difference
 * is posted: a credit when over-billed, a charge
 * for the balance of the month when under-billed. Running it twice posts
 * nothing the second time. `allow` limits it to the direction the caller's
 * change can cause. */
function trueUpRecurring(
  ctx: Ctx, lease: any, stopDate: string | null, fromMk: string,
  allow: 'credit' | 'topup' | 'both', why: { credit: string; topup: string },
): void {
  const rows = q<any>(
    `SELECT ${LINE_OF_CHARGE} AS lease_charge_id, c.month_key, SUM(c.amount_cents) AS billed, MIN(c.due_date) AS due
     FROM charges c WHERE c.org_id=? AND c.lease_id=? AND c.status='active' AND c.month_key>=?
       AND ${LINE_OF_CHARGE} IS NOT NULL AND c.source <> 'adjust:mtm_premium'
     GROUP BY 1, c.month_key ORDER BY c.month_key`,
    ctx.orgId, lease.id, fromMk,
  );
  for (const r of rows) {
    const lc = q1<any>('SELECT * FROM lease_charges WHERE id=? AND org_id=?', r.lease_charge_id, ctx.orgId);
    if (!lc) continue;
    const monthStart = r.month_key + '-01';
    // a line outside its own billing window that month is not ours to judge
    if ((lc.start_date && lc.start_date > lastOfMonth(monthStart)) || (lc.end_date && lc.end_date < monthStart)) continue;
    const share = billedShare(ctx, lease, r.month_key, stopDate);
    const expected = share.days === 0 ? 0 : share.prorated ? Math.round(lc.amount_cents * share.frac) : lc.amount_cents;
    const diff = expected - r.billed;
    if (diff === 0 || (diff < 0 && allow === 'topup') || (diff > 0 && allow === 'credit')) continue;
    createCharge(ctx, {
      leaseId: lease.id, kind: lc.kind,
      label: `${lc.label} — ${diff < 0 ? why.credit : why.topup}`,
      amountCents: diff, date: ctx.businessDate, dueDate: diff < 0 ? r.due : ctx.businessDate,
      monthKey: r.month_key, source: adjustmentOf(lc.id),
    });
  }
  // the month-to-month premium has no schedule line; it is only ever credited
  // back (it is not billed while a lease is on notice, so there is no top-up)
  if (allow !== 'topup') {
    const pct = getSetting<number>(ctx, 'mtm_premium_pct', lease.property_id) || 0;
    const full = Math.round((lease.rent_cents * pct) / 100);
    const prem = q<any>(
      `SELECT c.month_key, SUM(c.amount_cents) AS billed, MIN(c.due_date) AS due FROM charges c
       WHERE c.org_id=? AND c.lease_id=? AND c.status='active' AND c.kind='mtm_premium' AND c.lease_charge_id IS NULL AND c.month_key>=?
       GROUP BY c.month_key ORDER BY c.month_key`,
      ctx.orgId, lease.id, fromMk,
    );
    for (const r of prem) {
      const share = billedShare(ctx, lease, r.month_key, stopDate);
      const expected = share.days === 0 ? 0 : share.prorated ? Math.round(full * share.frac) : full;
      const over = r.billed - Math.min(r.billed, expected);
      if (over <= 0) continue;
      createCharge(ctx, {
        leaseId: lease.id, kind: 'mtm_premium', label: `Month-to-month premium — ${why.credit}`,
        amountCents: -over, date: ctx.businessDate, dueDate: r.due, monthKey: r.month_key, source: adjustmentOf(null),
      });
    }
  }
}

/** Months the rent run skipped only because the old move-out date came before
 * them: post them now (idempotent), up to the current month. */
function postSkippedMonths(ctx: Ctx, lease: any, oldStop: string, newStop: string | null): void {
  const lastMk = newStop && monthKey(newStop) < monthKey(ctx.businessDate) ? monthKey(newStop) : monthKey(ctx.businessDate);
  let mk = monthKey(addMonths(monthKey(oldStop) + '-01', 1));
  for (let i = 0; i < 24 && mk <= lastMk; i++) {
    postMonthlyChargesForLease(ctx, lease, mk);
    mk = monthKey(addMonths(mk + '-01', 1));
  }
}

/** Another household's lease on the same unit (the same bed, where leased by
 * the bed) that is entered and not a renewal. `startingBy` narrows it to
 * leases that start on or before that date. */
function nextLeaseOnUnit(ctx: Ctx, lease: any, startingBy?: string): { household_name: string; start_date: string } | null {
  return q1<any>(
    `SELECT household_name, start_date FROM leases WHERE org_id=? AND unit_id=? AND id<>? AND renewal_of_lease_id IS NULL
       AND COALESCE(bed_label,'')=COALESCE(?,'')
       AND status IN ('draft','out_for_signature','partially_signed','fully_executed','active','month_to_month')
       AND start_date > ? ${startingBy ? 'AND start_date <= ?' : ''} ORDER BY start_date LIMIT 1`,
    ...[ctx.orgId, lease.unit_id, lease.id, lease.bed_label ?? null, lease.start_date, ...(startingBy ? [startingBy] : [])],
  ) || null;
}

// ---------- a lease entered by hand ----------

export interface ManualLeasePerson {
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  role: 'primary' | 'co' | 'occupant' | 'guarantor';
}

export interface ManualLeaseInput {
  unitId: string;
  people: ManualLeasePerson[];
  householdName?: string | null;
  startDate: string;
  endDate: string;
  /** when the household actually moved in, if not the lease start */
  moveInDate?: string | null;
  rentCents: number;
  depositCents: number;
  /** true = the deposit is already in the bank; false = bill it at move-in */
  depositOnHand: boolean;
  /** first month to bill, for a tenancy already under way (default: lease start) */
  billingStartDate?: string | null;
  /** what the household already owes today (negative = a credit) */
  openingBalanceCents?: number;
  /** true = signed on paper, make it active; false = save a draft to send for e-signature */
  signed: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Create a lease for a unit without an application or an import: the
 * household, its people, the term, rent and deposit. A lease signed on paper
 * becomes active on its start date (today, if that has passed) through the
 * same activation every other lease uses — unit occupied, rent billed by the
 * rent run, move-in checklist. A deposit already on hand is recorded as held
 * (escrow cash / deposit liability, both books) instead of being billed. */
export function createLeaseManual(ctx: Ctx, input: ManualLeaseInput): { leaseId: string; status: string } {
  const unit = q1<any>('SELECT * FROM units WHERE id=? AND org_id=?', input.unitId, ctx.orgId);
  if (!unit) throw new Error('Choose a unit.');
  for (const [label, d] of [['lease start', input.startDate], ['lease end', input.endDate]] as const) {
    if (!ISO_DATE.test(d || '')) throw new Error(`Enter the ${label} date.`);
  }
  if (input.endDate <= input.startDate) throw new Error('The lease end date must be after the start date.');
  const moveIn = input.moveInDate || input.startDate;
  if (!ISO_DATE.test(moveIn)) throw new Error('Enter the move-in date as a date.');
  if (!Number.isInteger(input.rentCents) || input.rentCents <= 0) throw new Error('Enter the monthly rent.');
  if (!Number.isInteger(input.depositCents) || input.depositCents < 0) throw new Error('Enter the deposit as an amount (0 if there is none).');
  const billingStart = input.billingStartDate || null;
  if (billingStart && !ISO_DATE.test(billingStart)) throw new Error('Enter "start billing from" as a date.');
  if (billingStart && billingStart < input.startDate) throw new Error('"Start billing from" cannot be before the lease start.');
  if (billingStart && billingStart > input.endDate) throw new Error('"Start billing from" cannot be after the lease end.');
  const opening = input.openingBalanceCents || 0;
  if (!Number.isInteger(opening)) throw new Error('Enter the balance owed as an amount.');
  if (opening !== 0 && (!input.signed || input.startDate > ctx.businessDate)) {
    throw new Error('A balance already owed can only be entered on a signed lease that has started.');
  }
  const people = input.people
    .map((p) => ({ ...p, firstName: p.firstName.trim(), lastName: p.lastName.trim(), email: (p.email || '').trim().toLowerCase() || null, phone: (p.phone || '').trim() || null }))
    .filter((p) => p.firstName || p.lastName);
  const primaries = people.filter((p) => p.role === 'primary');
  if (primaries.length !== 1) throw new Error('Name one primary resident — the person responsible for the lease.');
  for (const p of people) {
    if (!p.firstName || !p.lastName) throw new Error('Each person needs a first and last name.');
    if (p.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email)) throw new Error(`"${p.email}" is not an email address.`);
  }
  // the unit must be free for this term
  const occupying = q1<any>(
    `SELECT household_name FROM leases WHERE org_id=? AND unit_id=? AND status IN ('active','month_to_month','notice')
       AND (move_out_date IS NULL OR move_out_date >= ?) LIMIT 1`,
    ctx.orgId, unit.id, input.startDate,
  );
  if (occupying) throw new Error(`Unit ${unit.unit_number} already has a current lease (${occupying.household_name}). Record its move-out first, or start this lease after it.`);
  const pending = q1<any>(
    `SELECT household_name FROM leases WHERE org_id=? AND unit_id=? AND renewal_of_lease_id IS NULL
       AND status IN ('draft','out_for_signature','partially_signed','fully_executed') LIMIT 1`,
    ctx.orgId, unit.id,
  );
  if (pending) throw new Error(`Unit ${unit.unit_number} already has a lease in progress (${pending.household_name}).`);
  // an existing tenancy needs a billing start, or we would re-bill its history
  const firstBilled = billingStart && billingStart > input.startDate ? billingStart : input.startDate;
  if (input.signed && firstBilled < addMonths(ctx.businessDate.slice(0, 8) + '01', -12)) {
    throw new Error('This lease started more than a year ago. Set "start billing from" to the first month this system should bill, and enter what is already owed as the balance.');
  }

  const primary = primaries[0]!;
  const householdName = (input.householdName || '').trim()
    || (people.filter((p) => ['primary', 'co'].includes(p.role)).length > 1 ? `${primary.lastName} household` : `${primary.firstName} ${primary.lastName}`);
  const termMonths = Math.max(1, Math.round((diffDays(input.endDate, input.startDate) + 1) / 30.4375));
  const onHand = input.depositOnHand && input.depositCents > 0;
  const leaseId = id('lse');
  let status = input.signed ? 'fully_executed' : 'draft';
  tx(() => {
    insert('leases', {
      id: leaseId, org_id: ctx.orgId, property_id: unit.property_id, unit_id: unit.id,
      household_name: householdName, status,
      start_date: input.startDate, end_date: input.endDate, move_in_date: moveIn,
      rent_cents: input.rentCents, deposit_cents: input.depositCents, deposit_alternative: 0,
      term_months: termMonths, billing_start_date: billingStart, deposit_on_hand: onHand ? 1 : 0,
      // The deposits workbench counts a deposit that arrived already held by
      // this marker (it was written for imports: "held, with no deposit
      // charge"). A hand-entered deposit on hand is the same fact.
      import_batch_id: onHand ? MANUAL_ENTRY_BATCH : null,
      created_at: nowIso(),
    });
    insert('lease_charges', {
      id: id('lc'), org_id: ctx.orgId, lease_id: leaseId, kind: 'rent',
      label: `Rent — ${unit.unit_number}`, amount_cents: input.rentCents, created_at: nowIso(),
    });
    for (const p of people) {
      const rid = id('res');
      insert('residents', {
        id: rid, org_id: ctx.orgId, property_id: unit.property_id, user_id: null,
        first_name: p.firstName, last_name: p.lastName, email: p.email, phone: p.phone,
        kind: p.role === 'guarantor' ? 'guarantor' : p.role === 'occupant' ? 'occupant' : 'adult', created_at: nowIso(),
      });
      insert('household_members', { id: id('hm'), org_id: ctx.orgId, lease_id: leaseId, resident_id: rid, role: p.role, created_at: nowIso() });
    }
    if (onHand) {
      postBothBases(ctx, {
        propertyId: unit.property_id, date: ctx.businessDate,
        memo: `Security deposit already held — ${householdName} (lease entered by hand)`,
        sourceKind: 'deposit_on_hand', sourceId: leaseId,
        lines: [
          { account: '1020', debit: input.depositCents, memo: 'Security deposit cash on hand' },
          { account: '2100', credit: input.depositCents, memo: 'Security deposits held' },
        ],
      });
    }
    if (opening !== 0) {
      createCharge(ctx, {
        leaseId, kind: 'opening_balance',
        label: opening > 0 ? 'Balance owed when the lease was entered' : 'Credit on account when the lease was entered',
        amountCents: opening, date: ctx.businessDate, dueDate: ctx.businessDate, source: 'conversion',
      });
    }
    audit(ctx, 'lease', leaseId, 'create_manual', null, {
      unit: unit.unit_number, household: householdName, start: input.startDate, end: input.endDate,
      rentCents: input.rentCents, depositCents: input.depositCents, depositOnHand: onHand, signed: input.signed,
      billingStart, openingBalanceCents: opening,
    });
    if (input.signed && input.startDate <= ctx.businessDate) {
      activateLease(ctx, leaseId);
      status = 'active';
    }
  });
  emit(ctx, 'lease.drafted', 'lease', leaseId, { manual: true });
  return { leaseId, status };
}

/** leases.import_batch_id for a hand-entered lease whose deposit was already held */
export const MANUAL_ENTRY_BATCH = 'manual-entry';

// ---------- notice to vacate & move-out, recorded by staff ----------

/** Put a lease on notice with its planned move-out date — the same three
 * things the resident's own notice does: the lease, the unit, and the event
 * that opens the make-ready. Calling it again on a lease already on notice
 * changes the planned date. */
export function recordNotice(ctx: Ctx, leaseId: string, moveOutDate: string, opts: { noticeDate?: string | null; source?: string } = {}): void {
  const lease = q1<any>('SELECT * FROM leases WHERE id=? AND org_id=?', leaseId, ctx.orgId);
  if (!lease) throw new Error('Lease not found.');
  if (!['active', 'month_to_month', 'notice'].includes(lease.status)) throw new Error('Notice can only be recorded on a current lease.');
  if (!ISO_DATE.test(moveOutDate || '')) throw new Error('Enter the planned move-out date.');
  const noticeDate = opts.noticeDate || lease.notice_date || ctx.businessDate;
  if (!ISO_DATE.test(noticeDate)) throw new Error('Enter the date notice was given.');
  if (noticeDate > ctx.businessDate) throw new Error('The notice date cannot be in the future.');
  if (moveOutDate < noticeDate) throw new Error('The move-out date cannot be before the notice date.');
  if (moveOutDate < (lease.move_in_date || lease.start_date)) throw new Error('The move-out date is before the move-in date.');
  // the unit may already be leased to the next household
  const next = nextLeaseOnUnit(ctx, lease, moveOutDate);
  if (next) throw new Error(`The next lease on this unit (${next.household_name}) starts ${fmtDate(next.start_date)} — the move-out must be before it.`);
  const oldStop: string | null = lease.status === 'notice' ? lease.move_out_date : null;
  tx(() => {
    run(`UPDATE leases SET status='notice', notice_date=?, move_out_date=? WHERE id=? AND org_id=?`, noticeDate, moveOutDate, leaseId, ctx.orgId);
    run(`UPDATE units SET status='notice' WHERE id=? AND org_id=? AND status='occupied'`, lease.unit_id, ctx.orgId);
    // an open make-ready follows a changed date
    run(`UPDATE turns SET move_out_date=? WHERE org_id=? AND lease_id=? AND status='scheduled'`, moveOutDate, ctx.orgId, leaseId);
    // Rent already billed follows the date: a month posted in full before the
    // notice is credited down to the move-out day; a month prorated to an
    // earlier date is topped up when the date moves later.
    const now = { ...lease, status: 'notice', notice_date: noticeDate, move_out_date: moveOutDate };
    if (!oldStop || moveOutDate < oldStop) {
      trueUpRecurring(ctx, now, moveOutDate, monthKey(moveOutDate), 'credit', {
        credit: `credit, moving out ${fmtDate(moveOutDate)}`, topup: '',
      });
    } else if (moveOutDate > oldStop) {
      trueUpRecurring(ctx, now, moveOutDate, monthKey(oldStop), 'topup', {
        credit: '', topup: `balance of month, move-out changed to ${fmtDate(moveOutDate)}`,
      });
      postSkippedMonths(ctx, now, oldStop, moveOutDate);
    }
  });
  audit(ctx, 'lease', leaseId, 'notice_to_vacate', { status: lease.status, move_out: lease.move_out_date }, { status: 'notice', notice_date: noticeDate, move_out: moveOutDate, source: opts.source || 'staff' });
  emit(ctx, 'lease.notice', 'lease', leaseId, { moveOut: moveOutDate, propertyId: lease.property_id, unitId: lease.unit_id });
}

/** Take back a notice: the household is staying. */
export function withdrawNotice(ctx: Ctx, leaseId: string): void {
  const lease = q1<any>('SELECT * FROM leases WHERE id=? AND org_id=?', leaseId, ctx.orgId);
  if (!lease || lease.status !== 'notice') throw new Error('There is no notice on this lease to withdraw.');
  const back = lease.mtm_since ? 'month_to_month' : 'active';
  // the unit may already be leased to the next household for after this one
  const next = nextLeaseOnUnit(ctx, lease);
  if (next) throw new Error(`This unit is already leased to ${next.household_name} from ${fmtDate(next.start_date)}. Cancel or move that lease before withdrawing the notice.`);
  tx(() => {
    run(`UPDATE leases SET status=?, notice_date=NULL, move_out_date=NULL WHERE id=? AND org_id=?`, back, leaseId, ctx.orgId);
    run(`UPDATE units SET status='occupied' WHERE id=? AND org_id=? AND status='notice'`, lease.unit_id, ctx.orgId);
    run(`UPDATE turns SET status='canceled' WHERE org_id=? AND lease_id=? AND status='scheduled'`, ctx.orgId, leaseId);
    // a month the rent run prorated to the move-out date is owed in full again
    if (lease.move_out_date) {
      // billed as a lease that is staying; 'active' so the months the notice
      // skipped post as plain rent (the premium resumes with the next rent run)
      const now = { ...lease, status: 'active', notice_date: null, move_out_date: null };
      trueUpRecurring(ctx, now, null, monthKey(lease.move_out_date), 'topup', {
        credit: '', topup: 'balance of month, notice withdrawn',
      });
      postSkippedMonths(ctx, now, lease.move_out_date, null);
    }
  });
  audit(ctx, 'lease', leaseId, 'notice_withdrawn', { status: 'notice', move_out: lease.move_out_date }, { status: back });
  emit(ctx, 'lease.notice_withdrawn', 'lease', leaseId, { propertyId: lease.property_id, unitId: lease.unit_id });
}

/** The household has moved out: end the lease on the date they actually left.
 * The unit goes vacant (not ready) with its vacancy clock on that date, and
 * the make-ready opens if notice had never been recorded. Works with or
 * without a prior notice — early, late or on the planned day. */
export function recordMoveOut(ctx: Ctx, leaseId: string, moveOutDate: string): void {
  const lease = q1<any>('SELECT * FROM leases WHERE id=? AND org_id=?', leaseId, ctx.orgId);
  if (!lease) throw new Error('Lease not found.');
  if (!['active', 'month_to_month', 'notice'].includes(lease.status)) throw new Error('Only a current lease can be moved out.');
  if (!ISO_DATE.test(moveOutDate || '')) throw new Error('Enter the date the household moved out.');
  if (moveOutDate > ctx.businessDate) throw new Error('That date is in the future — record it as notice to vacate, and the lease ends on that day.');
  if (moveOutDate < (lease.move_in_date || lease.start_date)) throw new Error('The move-out date is before the move-in date.');
  tx(() => {
    run(
      `UPDATE leases SET status='ended', move_out_date=?, notice_date=COALESCE(notice_date, ?) WHERE id=? AND org_id=?`,
      moveOutDate, moveOutDate, leaseId, ctx.orgId,
    );
    // only this household's unit state: a unit already re-let is left alone
    if (!q1(`SELECT id FROM leases WHERE org_id=? AND unit_id=? AND id != ? AND status IN ('active','month_to_month','notice')`, ctx.orgId, lease.unit_id, leaseId)) {
      run(
        `UPDATE units SET status='vacant_not_ready', vacant_since=?, vacant_since_source='lease' WHERE id=? AND org_id=? AND status IN ('occupied','notice')`,
        moveOutDate, lease.unit_id, ctx.orgId,
      );
    }
    run(`UPDATE turns SET move_out_date=? WHERE org_id=? AND lease_id=? AND status='scheduled'`, moveOutDate, ctx.orgId, leaseId);
    // Rent stops on the day they left. Months the rent run already posted
    // past that day are credited back (a move-out recorded after the 1st, or
    // backdated); a month prorated to an earlier planned date is topped up
    // when they stayed longer. Without this the over-billed rent would be
    // taken out of the deposit or sent to collections.
    const oldStop: string | null = lease.status === 'notice' ? lease.move_out_date : null;
    const billedAs = { ...lease, status: 'notice', move_out_date: moveOutDate };
    const fromMk = oldStop && oldStop < moveOutDate ? monthKey(oldStop) : monthKey(moveOutDate);
    trueUpRecurring(ctx, billedAs, moveOutDate, fromMk, oldStop && oldStop < moveOutDate ? 'both' : 'credit', {
      credit: `credit, moved out ${fmtDate(moveOutDate)}`, topup: `balance through move-out ${fmtDate(moveOutDate)}`,
    });
    if (oldStop && oldStop < moveOutDate) postSkippedMonths(ctx, billedAs, oldStop, moveOutDate);
  });
  audit(ctx, 'lease', leaseId, 'move_out', { status: lease.status, move_out: lease.move_out_date }, { status: 'ended', move_out: moveOutDate });
  // the make-ready is opened by the notice event; raise it if it never was
  if (lease.status !== 'notice') {
    emit(ctx, 'lease.notice', 'lease', leaseId, { moveOut: moveOutDate, propertyId: lease.property_id, unitId: lease.unit_id });
  }
  emit(ctx, 'lease.ended', 'lease', leaseId, { unitId: lease.unit_id, propertyId: lease.property_id });
}

/** Cancel a lease that never started — a draft, one out for signature, or a
 * signed lease whose start date has not come: the applicant backed out, or it
 * was entered by mistake. The unit is free for another lease and nothing
 * activates. A deposit that was recorded as already held comes back off the
 * books (escrow cash and the deposit liability, both bases); the money itself
 * is the operator's to hand back. Returns that amount in cents. */
export function cancelPendingLease(ctx: Ctx, leaseId: string): { depositReversedCents: number } {
  const lease = q1<any>('SELECT * FROM leases WHERE id=? AND org_id=?', leaseId, ctx.orgId);
  if (!lease) throw new Error('Lease not found.');
  if (!PENDING_STATUSES.includes(lease.status)) throw new Error('Only a lease that has not started can be canceled. For a current lease, record the move-out.');
  if (lease.renewal_of_lease_id) throw new Error('This is a renewal — the household stays on its current lease until the renewal starts. It cannot be canceled here.');
  if (lease.import_batch_id && lease.import_batch_id !== MANUAL_ENTRY_BATCH) {
    throw new Error('This lease came from an import. Remove it through the import it arrived in.');
  }
  const onLedger = (val<number>(`SELECT COUNT(*) FROM charges WHERE org_id=? AND lease_id=? AND status='active'`, ctx.orgId, leaseId) || 0)
    + (val<number>(`SELECT COUNT(*) FROM payments WHERE org_id=? AND lease_id=? AND status IN ('pending','settled')`, ctx.orgId, leaseId) || 0);
  if (onLedger > 0) throw new Error('This lease has charges or payments on its ledger. Void or refund them first, then cancel the lease.');
  const reversed = lease.deposit_on_hand && lease.deposit_cents > 0 ? lease.deposit_cents : 0;
  tx(() => {
    if (reversed > 0) {
      postBothBases(ctx, {
        propertyId: lease.property_id, date: ctx.businessDate,
        memo: `Security deposit no longer held — ${lease.household_name} (lease canceled before it started)`,
        sourceKind: 'deposit_on_hand_reversal', sourceId: leaseId,
        lines: [
          { account: '2100', debit: reversed, memo: 'Security deposits held' },
          { account: '1020', credit: reversed, memo: 'Security deposit cash returned' },
        ],
      });
    }
    // off the deposit subledger: both markers say "held with no deposit charge"
    run(`UPDATE leases SET status='canceled', deposit_on_hand=0, import_batch_id=NULL WHERE id=? AND org_id=?`, leaseId, ctx.orgId);
    // open signing links stop working
    run(`UPDATE signature_requests SET status='canceled' WHERE org_id=? AND lease_id=? AND status='out'`, ctx.orgId, leaseId);
    audit(ctx, 'lease', leaseId, 'cancel', { status: lease.status, depositOnHand: !!lease.deposit_on_hand }, { status: 'canceled', depositReversedCents: reversed });
  });
  emit(ctx, 'lease.canceled', 'lease', leaseId, { unitId: lease.unit_id, propertyId: lease.property_id });
  return { depositReversedCents: reversed };
}

/** a lease that is entered but has not started */
export const PENDING_STATUSES = ['draft', 'out_for_signature', 'partially_signed', 'fully_executed'];

registerJob({
  key: 'lease_activation',
  name: 'Lease activation (move-in day)',
  describe: 'Activates fully-executed leases whose start date has arrived: unit occupied, household + portal accounts, deposits, first charges, move-in checklist.',
  run: (ctx, date) => {
    const due = q<any>(`SELECT id, household_name FROM leases WHERE org_id=? AND status='fully_executed' AND start_date<=?`, ctx.orgId, date);
    // one lease that cannot start (its unit is still occupied, a compliance
    // gate) must not hold up every other move-in that day
    let activated = 0;
    const blocked: string[] = [];
    for (const l of due) {
      try {
        activateLease(ctx, l.id);
        activated++;
      } catch (e) {
        blocked.push(`${l.household_name}: ${(e as Error).message}`);
      }
    }
    if (!due.length) return 'no move-ins today';
    return `${activated} leases activated` + (blocked.length ? ` · ${blocked.length} could not start — ${blocked.join(' · ')}` : '');
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

/** M19 cross-guard: true when active-mode scoring has the lease in the
 * escalate bucket. Shadow mode never holds anything. */
export function renewalHeldForDelinquency(ctx: Ctx, leaseId: string): boolean {
  const scoring = { mode: scorerMode(ctx, 'delinquency_scoring') };
  if (scoring?.mode !== 'active') return false;
  return latestAssessment(ctx, leaseId)?.bucket === 'escalate';
}

export function createRenewalOffer(ctx: Ctx, leaseId: string): string {
  const lease = q1<any>('SELECT * FROM leases WHERE id=? AND org_id=?', leaseId, ctx.orgId);
  if (!lease) throw new Error('lease not found');
  const existing = q1<any>(`SELECT id FROM renewal_offers WHERE lease_id=? AND status IN ('sent','accepted','countered')`, leaseId);
  if (existing) return existing.id as string;
  // M19 cross-guard (active mode): an escalated delinquency holds the
  // renewal offer — nothing today stopped the system from cheerfully
  // offering 12 more months to a household 60 days behind. Resolving the
  // balance (or the scorer's recovery path) releases the hold.
  if (renewalHeldForDelinquency(ctx, leaseId)) {
    throw new Error('renewal held: delinquency escalation — resolve the balance (or its recovery plan) before offering');
  }
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
      body: `<p>Hi ${contact.first_name},</p><p>We'd love to keep you! Your renewal options:</p><ul>${options.map((o) => `<li><b>${o.term_months} months</b> — ${usd(o.rent_cents)}/mo</li>`).join('')}</ul><p>${contact.user_id ? 'Accept right in the resident portal (Lease tab) — or reply with questions.' : 'Reply with the term that suits you, or with any questions.'}</p>`,
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

// a move-out recorded from the deposit screen goes through the same notice as every other
registerNoticeHook((ctx, leaseId, moveOutDate) => recordNotice(ctx, leaseId, moveOutDate, { source: 'deposit disposition' }));
