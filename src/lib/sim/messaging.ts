import { insert, q1 } from '../db.ts';
import { id } from '../ids.ts';
import { nowIso } from '../dates.ts';
import type { Ctx } from '../auth.ts';

/** EmailGateway / SmsGateway simulators (§3.4): outbox pattern. Nothing
 * actually sends — messages land in the dev Message Console, where inbound
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
}

/** M15 registers this to thread every outbound message + simulate opens */
type SendHook = (ctx: Ctx, messageId: string, msg: OutboundMessage) => void;
let sendHook: SendHook | null = null;
export function registerSendHook(fn: SendHook): void {
  sendHook = fn;
}

export function send(ctx: Ctx, msg: OutboundMessage): string {
  const mid = id('msg');
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
    status: 'sent',
    sent_by: ctx.userId,
    created_at: nowIso(),
    business_date: ctx.businessDate,
  });
  try {
    sendHook?.(ctx, mid, msg);
  } catch {
    /* threading must never break a send */
  }
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
