import { createHash } from 'node:crypto';
import { q, q1, run, val, insert, update, tx, j, js } from '../../lib/db.ts';
import { id, token } from '../../lib/ids.ts';
import { nowIso } from '../../lib/dates.ts';
import type { Ctx } from '../../lib/auth.ts';
import { sysCtx } from '../../lib/auth.ts';
import { audit } from '../../lib/audit.ts';
import { inboundDomain, registerInboundFallback, type InboundEmail } from '../m3_crm/ils_email.ts';
import {
  matchSender, classify, unwrapForward, subjectKey,
  type Contact, type ContactKind, type MailIn, type MatchStatus, type Category, type Urgency, type RosterRow,
} from './engine.ts';

/** One Inbox storage. Unlike the weekly action report (m22, which stores
 * nothing), an inbox has to keep what it receives: the dated record IS the
 * product. So everything here is org-scoped on every query, the contact list
 * and the messages can be deleted by the operator at any time (`purge`), and
 * sample data is flagged so it can be cleared without touching real mail. */

export interface ContactRow extends Contact { source: string; isSample: boolean }

export interface MessageRow {
  id: string;
  org_id: string;
  received_at: string;
  via: string;
  mailbox: string | null;
  from_email: string;
  from_name: string;
  forwarded_by: string | null;
  subject: string;
  body: string;
  category: Category;
  urgency: Urgency;
  match_status: MatchStatus;
  contact_id: string | null;
  candidates: string;
  match_reason: string;
  filed_by: string | null;
  status: 'open' | 'done';
  done_at: string | null;
  is_sample: number;
  replied_at: string | null;
  reply_message_id: string | null;
}

function toContact(r: any): ContactRow {
  return {
    id: r.id, name: r.name, emails: j<string[]>(r.emails, []), phones: j<string[]>(r.phones, []),
    property: r.property, unit: r.unit, kind: r.kind as ContactKind, source: r.source, isSample: !!r.is_sample,
  };
}

export function contacts(orgId: string): ContactRow[] {
  return q<any>('SELECT * FROM oi_contacts WHERE org_id=? ORDER BY property, unit, name', orgId).map(toContact);
}

export function contact(orgId: string, contactId: string): ContactRow | null {
  const r = q1<any>('SELECT * FROM oi_contacts WHERE id=? AND org_id=?', contactId, orgId);
  return r ? toContact(r) : null;
}

// ---------- the forwarding address ----------

export function inboxCode(orgId: string): string {
  const cur = q1<any>('SELECT code FROM oi_config WHERE org_id=?', orgId);
  if (cur) return cur.code as string;
  const code = token(5); // 10 hex chars: unguessable, short enough to read aloud
  insert('oi_config', { org_id: orgId, code, last_received_at: null, created_at: nowIso() });
  return code;
}

export function inboxAddress(orgId: string): string {
  return `inbox-${inboxCode(orgId)}@${inboundDomain()}`;
}

export function resolveInboxAddress(addr: string): string | null {
  const m = /^inbox-([a-f0-9]{10})@([^@\s>]+)$/i.exec(addr.trim().toLowerCase());
  if (!m) return null;
  return (q1<any>('SELECT org_id FROM oi_config WHERE code=?', m[1])?.org_id as string | undefined) || null;
}

export function lastReceivedAt(orgId: string): string | null {
  return (q1<any>('SELECT last_received_at FROM oi_config WHERE org_id=?', orgId)?.last_received_at as string | null) || null;
}

// ---------- contact list ----------

/** Replace the uploaded contact list. Contacts a person added by hand (and the
 * email addresses staff taught the system by filing) survive a re-upload:
 * re-uploading next month's directory must not forget what was learned. */
export function replaceRoster(ctx: Ctx, rows: RosterRow[], opts: { sample?: boolean } = {}): { added: number; carried: number } {
  return tx(() => {
    const old = contacts(ctx.orgId).filter((c) => c.source === 'upload');
    // learned addresses: emails on an old upload row that the new file does not carry
    const learned = new Map<string, string[]>();
    const keyOf = (c: { name: string; property: string; unit: string }): string =>
      `${c.name.toLowerCase().trim()}|${c.property.toLowerCase().trim()}|${c.unit.toLowerCase().trim()}`;
    for (const c of old) learned.set(keyOf(c), c.emails);
    const oldIds = new Map(old.map((c) => [keyOf(c), c.id]));
    run(`DELETE FROM oi_contacts WHERE org_id=? AND source='upload'`, ctx.orgId);
    let carried = 0;
    for (const r of rows) {
      const k = keyOf(r);
      const extra = (learned.get(k) || []).filter((e) => !r.emails.includes(e));
      if (extra.length) carried++;
      insert('oi_contacts', {
        // keep the id when the same person is still on the list, so messages
        // already filed to them stay filed
        id: oldIds.get(k) || id('oic'), org_id: ctx.orgId, name: r.name,
        emails: js([...r.emails, ...extra]), phones: js(r.phones), property: r.property, unit: r.unit,
        kind: r.kind, source: 'upload', is_sample: opts.sample ? 1 : 0, created_at: nowIso(),
      });
      oldIds.delete(k);
    }
    // messages filed to someone no longer on the list go back to "needs filing"
    for (const goneId of oldIds.values()) {
      run(`UPDATE oi_messages SET contact_id=NULL, match_status='unsorted', match_reason='The person this was filed to is no longer on the contact list.' WHERE org_id=? AND contact_id=?`, ctx.orgId, goneId);
    }
    audit(ctx, 'one_inbox', ctx.orgId, 'roster_replaced', null, { rows: rows.length, carried });
    return { added: rows.length, carried };
  });
}

// ---------- ingest ----------

export interface IngestResult { id: string; duplicate: boolean; status: MatchStatus }

export function ingest(
  orgId: string,
  raw: MailIn,
  opts: { via: 'forward' | 'manual' | 'sample'; receivedAt?: string; ownAddress?: string } = { via: 'manual' },
): IngestResult {
  const { mail, forwardedBy } = unwrapForward(raw);
  const receivedAt = opts.receivedAt || nowIso();
  const dedupe = createHash('sha1')
    .update([mail.fromEmail, mail.subject, mail.text.slice(0, 4000), receivedAt.slice(0, 10)].join('\u0000'))
    .digest('hex');
  const dup = q1<any>('SELECT id, match_status FROM oi_messages WHERE org_id=? AND dedupe_key=?', orgId, dedupe);
  if (dup) return { id: dup.id, duplicate: true, status: dup.match_status };

  const list = contacts(orgId);
  const sKey = subjectKey(mail.subject);
  const prior = sKey
    ? (q1<any>(`SELECT contact_id FROM oi_messages WHERE org_id=? AND subject_key=? AND contact_id IS NOT NULL ORDER BY received_at DESC LIMIT 1`, orgId, sKey)?.contact_id as string | undefined) || null
    : null;
  const m = matchSender(mail, list, prior);
  const sender = m.contactId ? list.find((c) => c.id === m.contactId) || null : null;
  // not sure WHICH record, but every candidate is the same kind of sender
  // (a case worker with two households is still an agency)
  const candKinds = new Set(m.candidates.map((cid) => list.find((c) => c.id === cid)?.kind));
  const kind = sender?.kind ?? (m.status === 'ambiguous' && candKinds.size === 1 && mail.fromEmail && list.some((c) => c.emails.includes(mail.fromEmail)) ? [...candKinds][0]! : null);
  const { category, urgency } = classify(mail, kind);
  const own = (opts.ownAddress || '').toLowerCase();
  const mailbox = mail.to.find((a) => a !== own && !a.endsWith(`@${inboundDomain()}`)) || null;
  const mid = id('oim');
  insert('oi_messages', {
    id: mid, org_id: orgId, received_at: receivedAt, via: opts.via, mailbox,
    from_email: mail.fromEmail, from_name: mail.fromName, forwarded_by: forwardedBy,
    subject: mail.subject.slice(0, 300), body: mail.text.slice(0, 50_000), subject_key: sKey,
    category, urgency, match_status: m.status, contact_id: m.contactId, candidates: js(m.candidates),
    match_reason: m.reason, filed_by: null, status: 'open', done_by: null, done_at: null,
    dedupe_key: dedupe, is_sample: opts.via === 'sample' ? 1 : 0, created_at: nowIso(),
  });
  if (opts.via === 'forward') run('UPDATE oi_config SET last_received_at=? WHERE org_id=?', receivedAt, orgId);
  return { id: mid, duplicate: false, status: m.status };
}

/** The webhook path: /hooks/inbound-email found no property intake address, so
 * see whether a recipient is some org's One Inbox address. */
function fromWebhook(mail: InboundEmail): { ok: boolean; id?: string; status?: string } | null {
  for (const addr of mail.to) {
    const orgId = resolveInboxAddress(addr);
    if (!orgId) continue;
    const res = ingest(orgId, {
      fromEmail: mail.from.email, fromName: mail.from.name, to: mail.to, subject: mail.subject, text: mail.text,
    }, { via: 'forward', ownAddress: addr });
    if (!res.duplicate) audit(sysCtx(orgId), 'one_inbox', res.id, 'email_in', null, { status: res.status });
    return { ok: true, id: res.id, status: res.status };
  }
  return null;
}
registerInboundFallback(fromWebhook);

// ---------- acting on a message ----------

export function message(orgId: string, messageId: string): MessageRow | null {
  return q1<MessageRow>('SELECT * FROM oi_messages WHERE id=? AND org_id=?', messageId, orgId) || null;
}

/** A person says who this email is from. Optionally remember the sender's
 * address on that contact, so the next email from it files itself. */
export function fileTo(ctx: Ctx, messageId: string, contactId: string, remember: boolean): boolean {
  const m = message(ctx.orgId, messageId);
  const c = contact(ctx.orgId, contactId);
  if (!m || !c) return false;
  tx(() => {
    // knowing the sender can change what the email is (an agency's "quick
    // question" is agency mail); urgency is about the words and stays put
    const { category } = classify({ fromEmail: m.from_email, fromName: m.from_name, to: m.mailbox ? [m.mailbox] : [], subject: m.subject, text: m.body }, c.kind);
    update('oi_messages', m.id, { contact_id: c.id, match_status: 'matched', match_reason: `Filed by ${ctx.userName}.`, filed_by: ctx.userId, candidates: '[]', category });
    if (remember && m.from_email && !c.emails.includes(m.from_email)) {
      update('oi_contacts', c.id, { emails: js([...c.emails, m.from_email]) });
      // everything else still waiting from that address now has an owner
      run(
        `UPDATE oi_messages SET contact_id=?, match_status='matched', match_reason=?, candidates='[]'
         WHERE org_id=? AND from_email=? AND match_status != 'matched'`,
        c.id, `Same sender as an email ${ctx.userName} filed.`, ctx.orgId, m.from_email,
      );
    }
    audit(ctx, 'one_inbox', m.id, 'filed', null, { contact: c.id, remember });
  });
  return true;
}

export function unfile(ctx: Ctx, messageId: string): boolean {
  const m = message(ctx.orgId, messageId);
  if (!m) return false;
  update('oi_messages', m.id, { contact_id: null, match_status: 'unsorted', match_reason: `Unfiled by ${ctx.userName}.`, filed_by: null });
  audit(ctx, 'one_inbox', m.id, 'unfiled', { contact: m.contact_id }, null);
  return true;
}

export function setDone(ctx: Ctx, messageId: string, done: boolean): boolean {
  const m = message(ctx.orgId, messageId);
  if (!m) return false;
  update('oi_messages', m.id, done
    ? { status: 'done', done_by: ctx.userId, done_at: nowIso() }
    : { status: 'open', done_by: null, done_at: null });
  return true;
}

export function addContact(ctx: Ctx, row: RosterRow): string {
  const cid = id('oic');
  insert('oi_contacts', {
    id: cid, org_id: ctx.orgId, name: row.name, emails: js(row.emails), phones: js(row.phones),
    property: row.property, unit: row.unit, kind: row.kind, source: 'manual', is_sample: 0, created_at: nowIso(),
  });
  return cid;
}

// ---------- counts + deletion ----------

export function counts(orgId: string): { needsFiling: number; urgent: number; open: number; done: number; contacts: number; sample: number } {
  const n = (sql: string): number => val<number>(sql, orgId) || 0;
  return {
    needsFiling: n(`SELECT COUNT(*) FROM oi_messages WHERE org_id=? AND status='open' AND match_status != 'matched'`),
    urgent: n(`SELECT COUNT(*) FROM oi_messages WHERE org_id=? AND status='open' AND urgency='urgent'`),
    open: n(`SELECT COUNT(*) FROM oi_messages WHERE org_id=? AND status='open'`),
    done: n(`SELECT COUNT(*) FROM oi_messages WHERE org_id=? AND status='done'`),
    contacts: n('SELECT COUNT(*) FROM oi_contacts WHERE org_id=?'),
    sample: n('SELECT (SELECT COUNT(*) FROM oi_messages WHERE org_id=?1 AND is_sample=1) + (SELECT COUNT(*) FROM oi_contacts WHERE org_id=?1 AND is_sample=1)'),
  };
}

/** Delete One Inbox data for this org: only the sample, or everything. The
 * forwarding address is kept so a mailbox rule does not have to be redone. */
export function purge(ctx: Ctx, scope: 'sample' | 'all'): { messages: number; contacts: number } {
  return tx(() => {
    const extra = scope === 'sample' ? ' AND is_sample=1' : '';
    const messages = run(`DELETE FROM oi_messages WHERE org_id=?${extra}`, ctx.orgId).changes;
    const people = run(`DELETE FROM oi_contacts WHERE org_id=?${extra}`, ctx.orgId).changes;
    if (scope === 'sample') {
      // real mail that had been filed to a sample contact goes back to the pile
      run(`UPDATE oi_messages SET contact_id=NULL, match_status='unsorted', match_reason='Filed to sample data that has been cleared.' WHERE org_id=? AND contact_id IS NOT NULL AND contact_id NOT IN (SELECT id FROM oi_contacts WHERE org_id=?)`, ctx.orgId, ctx.orgId);
    }
    audit(ctx, 'one_inbox', ctx.orgId, scope === 'all' ? 'purged' : 'sample_cleared', null, { messages, contacts: people });
    return { messages, contacts: people };
  });
}

// ---------- replying ----------

import { esc } from '../../lib/html.ts';
import { sendEmail } from '../../lib/sim/messaging.ts';
import { emailLive, isDeliverableAddress, registerReplyToResolver, suppressed } from '../../lib/email.ts';
import { inboundToken } from '../m3_crm/ils_email.ts';

// A reply to something StayLeased sent comes back into One Inbox, when mail
// forwarding is switched on for this server; otherwise the email module falls
// back to the sender's own address.
registerReplyToResolver((orgId) => (inboundToken() ? inboxAddress(orgId) : null));

/** Why a reply cannot be sent from here, or null when it can. */
export function replyBlocker(ctx: Ctx, m: MessageRow): string | null {
  if (m.is_sample) return 'This is a sample email, so there is nobody to reply to.';
  if (!emailLive(ctx)) return 'Email delivery is not switched on for this account.';
  if (!isDeliverableAddress(m.from_email)) return 'The sender’s address is not one email can be delivered to.';
  // an address that bounced or reported mail as spam is never written to again
  const why = suppressed(ctx.orgId, m.from_email);
  if (why !== null) return `This address is on the do-not-email list${why ? ` (${why})` : ''}, so a reply cannot be sent to it from here.`;
  return null;
}

/** What actually happened to the reply sent from here: the linked Outbox row,
 * read at view time. `replied_at` only says a reply was WRITTEN; whether it
 * was delivered is the provider's answer, which arrives later. */
export function replyDelivery(orgId: string, m: MessageRow): { status: string; error: string | null } | null {
  if (!m.reply_message_id) return null;
  const r = q1<{ status: string; delivery_error: string | null }>(
    'SELECT status, delivery_error FROM outbox_messages WHERE id=? AND org_id=?', m.reply_message_id, orgId);
  return r ? { status: r.status, error: r.delivery_error } : null;
}

/** Send a reply to the person who wrote. The text is the operator's own —
 * the suggestion is only a starting point — and it is escaped into simple
 * paragraphs, so nothing typed here can carry markup into someone's inbox. */
export function sendReply(ctx: Ctx, messageId: string, input: { subject: string; text: string }): { ok: true; outboxId: string } | { ok: false; error: string } {
  const m = message(ctx.orgId, messageId);
  if (!m) return { ok: false, error: 'That email is no longer here.' };
  const blocked = replyBlocker(ctx, m);
  if (blocked) return { ok: false, error: blocked };
  const text = String(input.text || '').replace(/\r\n/g, '\n').trim();
  if (text.length < 2) return { ok: false, error: 'Write the reply first.' };
  if (text.length > 20000) return { ok: false, error: 'That reply is too long to send.' };
  const subject = String(input.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200) || `Re: ${m.subject || 'your message'}`;
  const body = text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  const outboxId = sendEmail(ctx, {
    to: m.from_email, toName: m.from_name || null, subject, body,
    templateKey: 'one_inbox_reply', entity: 'oi_message', entityId: m.id,
  });
  run('UPDATE oi_messages SET replied_at=?, reply_message_id=? WHERE id=? AND org_id=?', nowIso(), outboxId, m.id, ctx.orgId);
  audit(ctx, 'oi_message', m.id, 'reply', null, { outbox: outboxId });
  return { ok: true, outboxId };
}
