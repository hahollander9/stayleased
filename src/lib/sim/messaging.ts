import { insert, q1 } from '../db.ts';
import { id } from '../ids.ts';
import { nowIso } from '../dates.ts';
import type { Ctx } from '../auth.ts';
import { env } from '../env.ts';
import { emailLive, kickEmailQueue } from '../email.ts';

/** EmailGateway / SmsGateway simulators (§3.4): outbox pattern. Nothing
 * actually sends (demo orgs store 'sent' as part of the simulation; live orgs
 * store 'recorded' — see outboundStatus) — messages land in the dev Message Console, where inbound
 * replies can be simulated. From Phase 13 these thread into M15; until then
 * each message stands alone (carry-along rule §7). */

export interface OutboundMessage {
  channel: 'email' | 'sms';
  to: string; // address or phone
  toUserId?: string | null;
  toName?: string | null;
  subject?: string;
  body: string; // html for email, text for sms
  templateKey?: string | null;
  propertyId?: string | null;
  entity?: string | null;
  entityId?: string | null;
  threadId?: string | null;
  personId?: string | null;
  /** Write the row but do not deliver it, whatever the organization's email
   * switch says. For mail nobody deliberately chose to send right now: bulk
   * portal invitations from an import, and anything started by a member of the
   * public. Staff can read it in the Outbox and send it on purpose. */
  hold?: boolean;
}

/** M15 registers this to thread every outbound message + simulate opens */
type SendHook = (ctx: Ctx, messageId: string, msg: OutboundMessage) => void;
let sendHook: SendHook | null = null;
export function registerSendHook(fn: SendHook): void {
  sendHook = fn;
}

/** A live (non-demo) org has no email or SMS provider connected. `ctx.orgKind`
 * is the fast path; the row lookup covers hand-built system contexts. */
export function isLiveOrg(ctx: Pick<Ctx, 'orgId'> & { orgKind?: string }): boolean {
  if (ctx.orgKind === 'live') return true;
  return q1<{ kind: string }>('SELECT kind FROM orgs WHERE id=?', ctx.orgId)?.kind === 'live';
}

/** The status a new outbound row gets. Demo orgs keep the simulator's 'sent'.
 * A live org gets 'recorded': the message is saved in the Outbox and has NOT
 * been delivered to anyone, because no email/SMS rail is connected. Nothing may
 * move a 'recorded' row to 'sent' or 'opened' except a real provider. */
export const RECORDED = 'recorded';
export const QUEUED = 'queued';
/** `channel` matters since the email rail arrived (lib/email.ts): a live org
 * with delivery switched on gets `queued` for email — a real provider then
 * moves it to sent, failed or bounced — while text messages, which still have
 * no rail, stay `recorded`. */
export function outboundStatus(ctx: Pick<Ctx, 'orgId'> & { orgKind?: string }, channel: 'email' | 'sms' = 'sms'): 'sent' | 'recorded' | 'queued' {
  if (!isLiveOrg(ctx)) return 'sent';
  return channel === 'email' && emailLive(ctx) ? QUEUED : RECORDED;
}

/** One sentence for flash messages after anything that calls send(): what
 * actually happened to the message. Live orgs: saved, not delivered. */
export function deliveryNote(ctx: Pick<Ctx, 'orgId'> & { orgKind?: string }, channel?: 'email' | 'sms' | 'held'): string {
  if (!isLiveOrg(ctx)) return 'Sent (see Message console)';
  if (!emailLive(ctx)) return 'Saved to the Outbox — email and text delivery are not connected yet';
  // say what happened to THIS message when the caller knows what it wrote
  if (channel === 'email') return 'Email is on its way — the Outbox shows when it is delivered';
  if (channel === 'sms') return 'Saved to the Outbox — text messages are not connected yet, so it was not delivered';
  if (channel === 'held') return 'Saved to the Outbox, not emailed — open it there to send it';
  return 'Email is on its way — the Outbox shows when it is delivered. Text messages are not connected yet';
}

/** Absolute origin for links inside a message body (an inbox has no page for
 * a link to be relative to). The demo keeps relative links when no origin is
 * configured so its Message console stays clickable on any host. */
export function messageOrigin(ctx: Pick<Ctx, 'orgId'> & { orgKind?: string }): string {
  const o = (env('SITE_ORIGIN') || '').replace(/\/+$/, '');
  return o || (isLiveOrg(ctx) ? 'https://stayleased.com' : '');
}

/** Plain-language label for an outbox / mass-recipient status. */
export function deliveryLabel(status: string | null | undefined): string {
  const s = String(status ?? '');
  if (s === RECORDED) return 'Saved — not delivered';
  if (s === QUEUED) return 'Sending';
  if (s === 'failed') return 'Not delivered';
  if (s === 'bounced') return 'Bounced';
  if (s === 'received') return 'Received';
  if (s === 'sent') return 'Sent';
  if (s === 'opened') return 'Opened';
  return s.replaceAll('_', ' ') || '—';
}

export function send(ctx: Ctx, msg: OutboundMessage): string {
  const mid = id('msg');
  const status = msg.hold && isLiveOrg(ctx) ? RECORDED : outboundStatus(ctx, msg.channel);
  insert('outbox_messages', {
    id: mid,
    org_id: ctx.orgId,
    property_id: msg.propertyId || null,
    channel: msg.channel,
    direction: 'out',
    to_addr: msg.to,
    to_user_id: msg.toUserId || null,
    to_name: msg.toName || null,
    subject: msg.subject || null,
    body: msg.body,
    template_key: msg.templateKey || null,
    entity: msg.entity || null,
    entity_id: msg.entityId || null,
    thread_id: msg.threadId || null,
    person_id: msg.personId || null,
    status,
    sent_by: ctx.userId,
    created_at: nowIso(),
    business_date: ctx.businessDate,
  });
  try {
    sendHook?.(ctx, mid, msg);
  } catch {
    /* threading must never break a send */
  }
  if (status === QUEUED) kickEmailQueue();
  return mid;
}

export function sendEmail(ctx: Ctx, msg: Omit<OutboundMessage, 'channel'>): string {
  return send(ctx, { ...msg, channel: 'email' });
}

export function sendSms(ctx: Ctx, msg: Omit<OutboundMessage, 'channel'> & { subject?: undefined }): string {
  return send(ctx, { ...msg, channel: 'sms' });
}

/** record a simulated inbound message (from Message Console or simulators) */
export function receiveInbound(
  ctx: Ctx,
  msg: { channel: 'email' | 'sms'; from: string; fromName?: string; subject?: string; body: string; propertyId?: string | null; threadId?: string | null; personId?: string | null },
): string {
  const mid = id('msg');
  insert('outbox_messages', {
    id: mid,
    org_id: ctx.orgId,
    property_id: msg.propertyId || null,
    channel: msg.channel,
    direction: 'in',
    to_addr: msg.from, // for inbound, to_addr stores the counterparty address
    to_user_id: null,
    to_name: msg.fromName || null,
    subject: msg.subject || null,
    body: msg.body,
    template_key: null,
    entity: null,
    entity_id: null,
    thread_id: msg.threadId || null,
    person_id: msg.personId || null,
    status: 'received',
    sent_by: null,
    created_at: nowIso(),
    business_date: ctx.businessDate,
  });
  return mid;
}
