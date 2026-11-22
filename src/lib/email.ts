import { timingSafeEqual } from 'node:crypto';
import { q, q1, run, insert } from './db.ts';
import { env } from './env.ts';
import { nowIso } from './dates.ts';
import { id } from './ids.ts';
import { log } from './log.ts';
import { getSetting } from './settings.ts';
import { sysCtx } from './auth.ts';

/** The real email rail.
 *
 * Until this file existed nothing StayLeased "sent" left the building: a live
 * company's messages were stored as `recorded` and the Outbox said so. Now a
 * message for a live org with delivery switched on is stored `queued`, handed
 * to a transactional email provider over HTTPS, and ends as `sent` (the
 * provider accepted it), `failed` (it refused, with the reason kept), or later
 * `bounced` (the recipient's server refused it, reported by webhook).
 *
 * Three things have to be true before a single message goes out, and each is a
 * separate decision by a separate person:
 *   1. the deployment has a provider key and a from-address (the operator of
 *      StayLeased opened an account and verified a sending domain);
 *   2. the organization is a live one — the shared demo never sends, because
 *      anyone can sign in to it and it would be an open relay with our name on
 *      the envelope;
 *   3. that organization turned email delivery on in its own settings.
 *
 * `send()` in sim/messaging.ts runs inside database transactions all over the
 * product and cannot wait on a network call, so delivery is a queue: the row
 * is written first, and this module drains it — immediately after the write,
 * and again every minute from the poller, with backoff on failures. */

export type EmailProvider = 'postmark' | 'resend';

export function emailProvider(): EmailProvider | null {
  const p = (env('EMAIL_PROVIDER') || '').toLowerCase();
  return p === 'postmark' || p === 'resend' ? p : null;
}
export function emailFromAddress(): string {
  return (env('EMAIL_FROM') || '').trim();
}
/** Provider, key and from-address are all present and plausible. */
export function emailConfigured(): boolean {
  return !!emailProvider() && !!(env('EMAIL_API_KEY') || '').trim() && isDeliverableAddress(emailFromAddress(), true);
}
/** This organization's email really goes out. */
export function emailLive(ctx: { orgId: string; orgKind?: string }): boolean {
  if (!emailConfigured()) return false;
  const kind = ctx.orgKind || q1<{ kind: string }>('SELECT kind FROM orgs WHERE id=?', ctx.orgId)?.kind;
  if (kind !== 'live') return false;
  return getSetting<boolean>(sysCtx(ctx.orgId), 'email_delivery') === true;
}

const RESERVED_TLD = /\.(demo|test|example|invalid|localhost|local|internal)$/i;
/** A shape we are willing to hand to a provider. Reserved names are refused:
 * seeded and fixture people live at @something.demo and @example.test, and a
 * bounce storm against them is how a new sending domain gets blocked. */
export function isDeliverableAddress(addr: string, allowAnyDomain = false): boolean {
  const a = String(addr || '').trim();
  if (a.length > 254 || /[\s<>"',;\r\n]/.test(a)) return false;
  const m = /^[^@]+@([a-z0-9-]+(\.[a-z0-9-]+)+)$/i.exec(a);
  if (!m) return false;
  if (!allowAnyDomain && (RESERVED_TLD.test(m[1]!) || /^example\.(com|org|net)$/i.test(m[1]!))) return false;
  return true;
}

export function htmlToText(html: string): string {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
      const t = text.replace(/<[^>]+>/g, '').trim();
      return t && t !== href ? `${t} (${href})` : href;
    })
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const oneLine = (s: string, max: number): string => String(s || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);
/** A display name that cannot break out of the From header. */
const displayName = (s: string): string => oneLine(s, 70).replace(/["<>\\,;:@()[\]]/g, '').trim();

export interface OutgoingEmail {
  from: string; // already formatted: "Name" <addr>
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string | null;
  tag?: string | null;
  messageId: string; // our outbox id, sent to the provider as metadata
}
export interface TransportResult { ok: boolean; providerId?: string; error?: string; retry?: boolean }
type Transport = (m: OutgoingEmail) => Promise<TransportResult>;

async function postmark(m: OutgoingEmail): Promise<TransportResult> {
  const resp = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'x-postmark-server-token': (env('EMAIL_API_KEY') || '').trim() },
    body: JSON.stringify({
      From: m.from, To: m.to, Subject: m.subject, HtmlBody: m.html, TextBody: m.text,
      ...(m.replyTo ? { ReplyTo: m.replyTo } : {}),
      ...(m.tag ? { Tag: m.tag } : {}),
      MessageStream: (env('EMAIL_STREAM') || 'outbound').trim(),
      Metadata: { outbox_id: m.messageId },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const body = (await resp.json().catch(() => ({}))) as { MessageID?: string; ErrorCode?: number; Message?: string };
  if (resp.ok && !body.ErrorCode) return { ok: true, providerId: body.MessageID };
  return { ok: false, error: oneLine(body.Message || `HTTP ${resp.status}`, 300), retry: resp.status >= 500 || resp.status === 429 };
}

async function resend(m: OutgoingEmail): Promise<TransportResult> {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${(env('EMAIL_API_KEY') || '').trim()}` },
    body: JSON.stringify({
      from: m.from, to: [m.to], subject: m.subject, html: m.html, text: m.text,
      ...(m.replyTo ? { reply_to: m.replyTo } : {}),
      tags: [{ name: 'outbox_id', value: m.messageId.replace(/[^A-Za-z0-9_-]/g, '_') }],
    }),
    signal: AbortSignal.timeout(15000),
  });
  const body = (await resp.json().catch(() => ({}))) as { id?: string; message?: string };
  if (resp.ok && body.id) return { ok: true, providerId: body.id };
  return { ok: false, error: oneLine(body.message || `HTTP ${resp.status}`, 300), retry: resp.status >= 500 || resp.status === 429 };
}

let transportOverride: Transport | null = null;
/** Tests hand in a transport; production uses the configured provider. */
export function setEmailTransport(fn: Transport | null): void { transportOverride = fn; }
function transport(): Transport | null {
  if (transportOverride) return transportOverride;
  const p = emailProvider();
  return p === 'postmark' ? postmark : p === 'resend' ? resend : null;
}

/** Where a reply should land. A module that receives mail (One Inbox) can
 * register a resolver so replies come back into the product. */
type ReplyResolver = (orgId: string) => string | null;
let replyResolver: ReplyResolver | null = null;
export function registerReplyToResolver(fn: ReplyResolver): void { replyResolver = fn; }

function replyToFor(orgId: string, sentBy: string | null): string | null {
  const set = String(getSetting<string>(sysCtx(orgId), 'email_reply_to') || '').trim();
  if (set && isDeliverableAddress(set, true)) return set;
  const viaInbox = replyResolver?.(orgId) || null;
  if (viaInbox && isDeliverableAddress(viaInbox, true)) return viaInbox;
  const sender = sentBy ? q1<{ email: string }>('SELECT email FROM users WHERE id=? AND org_id=?', sentBy, orgId)?.email : null;
  return sender && isDeliverableAddress(sender) ? sender : null;
}

export function suppressed(orgId: string, addr: string): string | null {
  const r = q1<{ reason: string }>('SELECT reason FROM email_suppressions WHERE org_id=? AND address=?', orgId, String(addr).trim().toLowerCase());
  return r ? r.reason : null;
}
export function suppress(orgId: string, addr: string, reason: string): void {
  const a = String(addr).trim().toLowerCase();
  if (!a || suppressed(orgId, a)) return;
  insert('email_suppressions', { id: id('sup'), org_id: orgId, address: a, reason: oneLine(reason, 120), created_at: nowIso() });
}
export function unsuppress(orgId: string, addr: string): void {
  run('DELETE FROM email_suppressions WHERE org_id=? AND address=?', orgId, String(addr).trim().toLowerCase());
}

/** A ceiling per organization per day. A compromised or careless account must
 * not be able to burn the sending domain's reputation for everyone else. */
export function dailyCap(): number {
  const n = parseInt(env('EMAIL_DAILY_CAP_PER_ORG') || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 500;
}
function sentToday(orgId: string): number {
  return q1<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox_messages WHERE org_id=? AND channel='email' AND direction='out' AND status IN ('sent','bounced') AND delivered_at >= ?`,
    orgId, new Date(Date.now() - 86400000).toISOString())?.n || 0;
}

const BACKOFF_MIN = [1, 5, 30, 120]; // after the 1st, 2nd, 3rd, 4th failed attempt
const MAX_ATTEMPTS = BACKOFF_MIN.length + 1;

interface Row {
  id: string; org_id: string; to_addr: string; to_name: string | null; subject: string | null; body: string;
  template_key: string | null; sent_by: string | null; attempts: number | null;
}

const fail = (row: Row, why: string): void => {
  run(`UPDATE outbox_messages SET status='failed', delivery_error=?, next_attempt_at=NULL WHERE id=?`, oneLine(why, 300), row.id);
};

/** Build and hand one queued row to the provider. Returns its final status. */
const inFlight = new Set<string>();
/** One message is handed to the provider by one caller at a time — the poller,
 * the kick after a write and "send now" can all reach the same queued row, and
 * a second hand-off would be a second copy in somebody's inbox. */
async function deliverOne(row: Row, opts: { test?: boolean } = {}): Promise<'sent' | 'failed' | 'queued'> {
  if (inFlight.has(row.id)) return 'queued';
  inFlight.add(row.id);
  try {
    const now = q1<{ status: string }>('SELECT status FROM outbox_messages WHERE id=?', row.id);
    if (!now || now.status !== 'queued') return now?.status === 'sent' ? 'sent' : 'failed';
    return await deliverOneLocked(row, opts);
  } finally {
    inFlight.delete(row.id);
  }
}

async function deliverOneLocked(row: Row, opts: { test?: boolean } = {}): Promise<'sent' | 'failed' | 'queued'> {
  const org = q1<{ name: string; kind: string }>('SELECT name, kind FROM orgs WHERE id=?', row.org_id);
  // Every guard is re-checked at the moment of sending: the switch may have
  // been turned off, or the key removed, between the write and now.
  // A test message (Connections → "Send me a test") is allowed before the
  // organization's switch is on — that is what the test is for — but still only
  // for a live org on a configured server.
  const allowed = opts.test ? !!org && org.kind === 'live' && emailConfigured() : !!org && emailLive({ orgId: row.org_id, orgKind: org.kind });
  if (!org || !allowed) { fail(row, 'Email delivery is switched off for this organization.'); return 'failed'; }
  const to = String(row.to_addr || '').trim();
  if (!isDeliverableAddress(to)) { fail(row, 'That is not an address email can be delivered to.'); return 'failed'; }
  const sup = suppressed(row.org_id, to);
  if (sup) { fail(row, `Not sent: this address is on the do-not-email list (${sup}).`); return 'failed'; }
  if (sentToday(row.org_id) >= dailyCap()) {
    run(`UPDATE outbox_messages SET next_attempt_at=?, delivery_error=? WHERE id=?`, new Date(Date.now() + 3600000).toISOString(), 'Waiting: the daily sending limit for this organization has been reached.', row.id);
    return 'queued';
  }
  const send1 = transport();
  if (!send1) { fail(row, 'No email provider is configured on this server.'); return 'failed'; }

  const attempts = (row.attempts || 0) + 1;
  run('UPDATE outbox_messages SET attempts=? WHERE id=?', attempts, row.id);
  const html = String(row.body || '');
  let res: TransportResult;
  try {
    res = await send1({
      from: `"${displayName(org.name) || 'StayLeased'}" <${emailFromAddress()}>`,
      to,
      subject: oneLine(row.subject || '(no subject)', 200),
      html,
      text: htmlToText(html),
      replyTo: replyToFor(row.org_id, row.sent_by),
      tag: row.template_key ? oneLine(row.template_key, 60) : null,
      messageId: row.id,
    });
  } catch (e) {
    res = { ok: false, error: oneLine((e as Error).message || 'network error', 200), retry: true };
  }
  if (res.ok) {
    run(`UPDATE outbox_messages SET status='sent', provider_id=?, delivered_at=?, delivery_error=NULL, next_attempt_at=NULL WHERE id=?`, res.providerId || null, nowIso(), row.id);
    return 'sent';
  }
  if (res.retry && attempts < MAX_ATTEMPTS) {
    const wait = BACKOFF_MIN[attempts - 1]! * 60000;
    run(`UPDATE outbox_messages SET next_attempt_at=?, delivery_error=? WHERE id=?`, new Date(Date.now() + wait).toISOString(), res.error || 'temporary failure', row.id);
    return 'queued';
  }
  fail(row, res.error || 'The email provider refused the message.');
  log.warn('email.failed', { org: row.org_id, id: row.id, reason: res.error }); // never the address or the body
  return 'failed';
}

let draining = false;
/** Drain the queue. Safe to call as often as liked: one pass at a time. */
export async function deliverEmailQueue(limit = 40): Promise<{ sent: number; failed: number; waiting: number }> {
  const out = { sent: 0, failed: 0, waiting: 0 };
  if (draining) return out;
  draining = true;
  try {
    const rows = q<Row>(
      `SELECT id, org_id, to_addr, to_name, subject, body, template_key, sent_by, attempts FROM outbox_messages
        WHERE status='queued' AND channel='email' AND direction='out' AND COALESCE(template_key,'') <> 'email_test'
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY created_at LIMIT ?`,
      nowIso(), limit);
    for (const row of rows) {
      const r = await deliverOne(row);
      if (r === 'sent') out.sent++; else if (r === 'failed') out.failed++; else out.waiting++;
    }
  } catch (e) {
    log.error('email.queue', e);
  } finally {
    draining = false;
  }
  return out;
}

/** Called right after a queued row is written. The write may still be inside a
 * transaction, so the drain waits for the current call stack to unwind — by
 * then a synchronous transaction has committed (or rolled the row away). */
export function kickEmailQueue(): void {
  setTimeout(() => { void deliverEmailQueue(); }, 0);
}

/** Send one message now and wait for the answer (the "send me a test" button). */
export async function deliverNow(messageId: string, opts: { test?: boolean } = {}): Promise<{ status: string; error: string | null }> {
  const row = q1<Row & { status: string }>(
    `SELECT id, org_id, to_addr, to_name, subject, body, template_key, sent_by, attempts, status FROM outbox_messages WHERE id=?`, messageId);
  if (!row) return { status: 'missing', error: 'Message not found.' };
  if (row.status === 'queued') await deliverOne(row, opts);
  const after = q1<{ status: string; delivery_error: string | null }>('SELECT status, delivery_error FROM outbox_messages WHERE id=?', messageId)!;
  return { status: after.status, error: after.delivery_error };
}

// ---------- provider events (bounces, complaints) ----------

export function emailWebhookConfigured(): boolean {
  return (env('EMAIL_WEBHOOK_SECRET') || '').trim().length >= 16;
}
export function emailWebhookSecretOk(given: string): boolean {
  const want = Buffer.from((env('EMAIL_WEBHOOK_SECRET') || '').trim());
  const got = Buffer.from(String(given || ''));
  return want.length >= 16 && want.length === got.length && timingSafeEqual(want, got);
}

export interface ProviderEvent { kind: 'bounced' | 'complained' | 'delivered'; providerId: string; address: string; detail: string }

/** Read a Postmark or Resend webhook body into the one thing we act on. */
export function parseProviderEvent(body: unknown): ProviderEvent | null {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, any>;
  if (typeof b.RecordType === 'string') { // Postmark
    const kind = b.RecordType === 'Bounce' ? 'bounced' : b.RecordType === 'SpamComplaint' ? 'complained' : b.RecordType === 'Delivery' ? 'delivered' : null;
    if (!kind || !b.MessageID) return null;
    // a soft bounce (mailbox full, temporary) is not a reason to stop writing to someone
    if (kind === 'bounced' && b.Type && !/HardBounce|BadEmailAddress|ManuallyDeactivated|Blocked|SpamNotification/i.test(String(b.Type))) return null;
    return { kind, providerId: String(b.MessageID), address: String(b.Email || b.Recipient || ''), detail: oneLine(String(b.Description || b.Type || kind), 120) };
  }
  if (typeof b.type === 'string' && b.data && typeof b.data === 'object') { // Resend
    const kind = b.type === 'email.bounced' ? 'bounced' : b.type === 'email.complained' ? 'complained' : b.type === 'email.delivered' ? 'delivered' : null;
    if (!kind || !b.data.email_id) return null;
    const to = Array.isArray(b.data.to) ? b.data.to[0] : b.data.to;
    return { kind, providerId: String(b.data.email_id), address: String(to || ''), detail: oneLine(String(b.data.bounce?.message || kind), 120) };
  }
  return null;
}

/** Apply a provider event to the message it names. Matching is by the id the
 * provider gave us at send time, so an event can only touch a message this
 * server actually sent. */
export function applyProviderEvent(evt: ProviderEvent): boolean {
  const row = q1<{ id: string; org_id: string; to_addr: string; status: string }>(
    `SELECT id, org_id, to_addr, status FROM outbox_messages WHERE provider_id=? AND channel='email' AND direction='out'`, evt.providerId);
  if (!row) return false;
  if (evt.kind === 'delivered') return true; // 'sent' already says the provider took it; nothing to change
  if (evt.kind === 'bounced') {
    run(`UPDATE outbox_messages SET status='bounced', delivery_error=? WHERE id=?`, `Bounced: ${evt.detail}`, row.id);
    suppress(row.org_id, row.to_addr, 'bounced');
  } else {
    run(`UPDATE outbox_messages SET delivery_error=? WHERE id=?`, 'The recipient marked this as spam.', row.id);
    suppress(row.org_id, row.to_addr, 'marked as spam');
  }
  return true;
}
