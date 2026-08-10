import { q1, insert, run } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso } from '../../lib/dates.ts';
import { hashPassword, tempPassword, type Ctx } from '../../lib/auth.ts';
import { sendEmail } from '../../lib/sim/messaging.ts';

/** Portal access for residents (client-onboarding audit fix, 2026-08-10).
 *
 * Residents who arrive through the application pipeline got portal logins;
 * residents who arrive through the Migration Center (a new client's rent-roll
 * or lease-PDF upload) got none — which quietly broke the whole "upload your
 * documents and you're started" promise: imported residents could never sign
 * in to see a balance or send a request. This makes portal access a property
 * of BEING a resident with an email, however they arrived, and always
 * delivers the credential: live orgs get a generated one-time password in an
 * invite email (readable by staff in the Message Console until the live email
 * rail ships), demo orgs stay demo1234. */

export function sendPortalInvite(ctx: Ctx, args: {
  residentId: string; email: string; firstName: string; name: string;
  propertyId: string | null; oneTime: string;
}): void {
  const propName = args.propertyId
    ? (q1<{ name: string }>('SELECT name FROM properties WHERE id=?', args.propertyId)?.name ?? null)
    : null;
  sendEmail(ctx, {
    to: args.email,
    toName: args.name,
    subject: `Your resident portal is ready${propName ? ` — ${propName}` : ''}`,
    body: `<p>Hi ${args.firstName},</p>
<p>Your resident portal account is set up. Sign in with this email address and your temporary password: <b>${args.oneTime}</b></p>
<p>In the portal you can see your balance and charges, make payments once payments go live for your community, send maintenance requests with photos, and keep your contact details current.</p>
<p>Keep this password safe. Questions? Just reply — your management team reads every message.</p>`,
    propertyId: args.propertyId,
    entity: 'resident',
    entityId: args.residentId,
    personId: args.residentId,
    templateKey: 'portal_invite',
  });
}

/** Idempotent: creates the portal login for a resident with an email, links
 * `residents.user_id`, and sends the invite. Safe to call for residents
 * without an email (no-op) or who already have access (links/no-op). */
export function ensurePortalAccess(ctx: Ctx, residentId: string): { userId: string | null; invited: boolean } {
  const res = q1<any>('SELECT * FROM residents WHERE id=? AND org_id=?', residentId, ctx.orgId);
  if (!res || !res.email) return { userId: null, invited: false };
  if (res.user_id) return { userId: res.user_id as string, invited: false };
  const existing = q1<any>('SELECT id FROM users WHERE email=?', res.email);
  if (existing) {
    run('UPDATE residents SET user_id=? WHERE id=?', existing.id, residentId);
    return { userId: existing.id as string, invited: false };
  }
  const oneTime = ctx.orgKind === 'live' ? tempPassword() : 'demo1234';
  const uid = id('usr');
  const name = `${res.first_name} ${res.last_name}`.trim() || String(res.email);
  insert('users', {
    id: uid, org_id: ctx.orgId, email: res.email, name,
    kind: 'resident', password_hash: hashPassword(oneTime), active: 1, created_at: nowIso(),
  });
  run('UPDATE residents SET user_id=? WHERE id=?', uid, residentId);
  sendPortalInvite(ctx, {
    residentId, email: String(res.email), firstName: String(res.first_name || 'there'),
    name, propertyId: (res.property_id as string) || null, oneTime,
  });
  return { userId: uid, invited: true };
}
