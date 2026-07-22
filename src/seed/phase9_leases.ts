import { q, q1, val, run } from '../lib/db.ts';
import { addDays } from '../lib/dates.ts';
import { sysCtx } from '../lib/auth.ts';
import { ensureLeaseTemplates, leaseFromApplication, buildPacket, startSignatureRequest, recordSignature, createRenewalOffer, acceptRenewal } from '../modules/m6_leases/service.ts';
import type { SeedCtx } from './seed.ts';
import { log } from './seed.ts';

/** Phase 9 seed: templates + addenda; one approved application converted to a
 * lease mid-signature (demo the ceremony); renewal offers for the 0-60d
 * bucket incl. Maya; one accepted+executed renewal for history. */

export async function seedLeases(s: SeedCtx): Promise<void> {
  const ctx = sysCtx(s.orgId);
  ensureLeaseTemplates(s.orgId);

  // convert one approved application → lease → packet → residents signed, countersign pending
  const approved = q<any>(`SELECT * FROM applications WHERE org_id=? AND status='approved' ORDER BY created_at LIMIT 1`, s.orgId);
  if (approved[0]) {
    const leaseId = leaseFromApplication(ctx, approved[0].id);
    const packet = await buildPacket(ctx, leaseId);
    const adults = q<any>(
      `SELECT first_name, last_name, email, kind FROM applicants WHERE application_id=? AND kind IN ('primary','co') AND email IS NOT NULL`,
      approved[0].id,
    );
    const pm = q1<any>(`SELECT u.name, u.email FROM users u JOIN role_assignments ra ON ra.user_id=u.id WHERE ra.role='PROPERTY_MANAGER' AND u.org_id=? LIMIT 1`, s.orgId);
    startSignatureRequest(ctx, leaseId, 'lease', packet, [
      ...adults.map((a) => ({ name: `${a.first_name} ${a.last_name}`.trim(), email: a.email, role: 'resident' as const })),
      { name: pm?.name || 'Property Manager', email: pm?.email || 'manager@summitridge.demo', role: 'countersigner' as const },
    ], 'http://localhost:3000');
    // residents sign (typed); countersign left pending for the demo
    const signers = q<any>(`SELECT * FROM signature_signers WHERE request_id=(SELECT esign_request_id FROM leases WHERE id=?) AND role='resident'`, leaseId);
    for (const signer of signers) {
      recordSignature(ctx, signer.token, { kind: 'typed', text: signer.name, initials: signer.name.split(' ').map((x: string) => x[0]).join('') });
    }
    log(`lease packet out for countersignature (${signers.length} residents signed)`);
  }

  // renewal offers: Maya Torres first (portal demo cast), then everything expiring ≤ 45 days
  let offers = 0;
  const mayaLease = q1<any>(
    `SELECT l.id FROM leases l JOIN household_members hm ON hm.lease_id=l.id JOIN residents r ON r.id=hm.resident_id
     WHERE l.org_id=? AND l.status='active' AND r.email='maya.torres@mail.demo' LIMIT 1`,
    s.orgId,
  );
  if (mayaLease) {
    createRenewalOffer(ctx, mayaLease.id);
    offers++;
  }
  const expiring = q<any>(
    `SELECT l.id FROM leases l WHERE l.org_id=? AND l.status='active' AND l.end_date BETWEEN ? AND ?
     AND NOT EXISTS (SELECT 1 FROM renewal_offers ro WHERE ro.lease_id=l.id)
     ORDER BY l.end_date, l.id`,
    s.orgId, s.businessDate, addDays(s.businessDate, 45),
  );
  for (const l of expiring.slice(0, 11)) {
    createRenewalOffer(ctx, l.id);
    offers++;
  }

  // one historical accepted + executed renewal
  const offerRow = q<any>(
    `SELECT ro.* FROM renewal_offers ro JOIN leases l ON l.id=ro.lease_id
     WHERE ro.org_id=? AND ro.status='sent'
       AND NOT EXISTS (SELECT 1 FROM residents r JOIN household_members hm ON hm.resident_id=r.id WHERE hm.lease_id=l.id AND r.email='maya.torres@mail.demo')
     ORDER BY ro.created_at LIMIT 1`,
    s.orgId,
  );
  if (offerRow[0]) {
    const newLeaseId = acceptRenewal(ctx, offerRow[0].id, 12, 'http://localhost:3000');
    // sign it fully
    await new Promise((res) => setTimeout(res, 50)); // packet builds async
    const req = q1<any>(`SELECT esign_request_id FROM leases WHERE id=?`, newLeaseId);
    if (req?.esign_request_id) {
      const signers = q<any>(`SELECT * FROM signature_signers WHERE request_id=? ORDER BY CASE role WHEN 'countersigner' THEN 1 ELSE 0 END`, req.esign_request_id);
      for (const signer of signers) {
        recordSignature(ctx, signer.token, { kind: 'typed', text: signer.name, initials: (signer.name || 'XX').split(' ').map((x: string) => x[0]).join('') });
      }
      await new Promise((res) => setTimeout(res, 80)); // finalize async
    }
    log('one renewal accepted and fully executed (activates on its start date)');
  }
  log(`renewals: ${offers} offers out`);
}
