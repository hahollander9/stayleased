import { q, q1, insert, run, val, tx, update, j, js } from '../../lib/db.ts';
import { id, token } from '../../lib/ids.ts';
import { nowIso, addDays } from '../../lib/dates.ts';
import type { Ctx } from '../../lib/auth.ts';
import { sysCtx } from '../../lib/auth.ts';
import { emit } from '../../lib/events.ts';
import { audit } from '../../lib/audit.ts';
import { getSetting } from '../../lib/settings.ts';
import { registerJob } from '../../lib/jobs.ts';
import { registerSendHook, sendEmail, sendSms, type OutboundMessage } from '../../lib/sim/messaging.ts';
import { getDials } from '../../lib/sim/dials.ts';
import { GLOBAL_SEED } from '../../lib/rng.ts';
import { leaseBalance } from '../m8_receivables/service.ts';

/** M15 — communications: unified per-person threads, consent, template
 * library, segments + mass comms with quiet hours & opt-outs, announcements,
 * call logging, automation audit. */

function strSeed(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return (h ^ GLOBAL_SEED) >>> 0;
}

// ---------- person resolution + threads ----------

export interface PersonRef {
  kind: 'resident' | 'lead' | 'vendor';
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  propertyId?: string | null;
}

export function resolvePerson(orgId: string, kind: string, personId: string): PersonRef | null {
  if (kind === 'resident') {
    const r = q1<any>('SELECT * FROM residents WHERE id=? AND org_id=?', personId, orgId);
    return r && { kind: 'resident', id: r.id, name: `${r.first_name} ${r.last_name}`.trim(), email: r.email, phone: r.phone, propertyId: r.property_id };
  }
  if (kind === 'lead') {
    const l = q1<any>('SELECT * FROM leads WHERE id=? AND org_id=?', personId, orgId);
    return l && { kind: 'lead', id: l.id, name: `${l.first_name || ''} ${l.last_name || ''}`.trim() || l.email || 'Lead', email: l.email, phone: l.phone, propertyId: l.property_id };
  }
  const v = q1<any>('SELECT * FROM vendors WHERE id=? AND org_id=?', personId, orgId);
  return v && { kind: 'vendor', id: v.id, name: v.name, email: v.email, phone: v.phone, propertyId: null };
}

/** find the person behind an outbox row (person_id may point at resident/lead) */
function personFromMessage(orgId: string, msg: OutboundMessage): PersonRef | null {
  if (msg.personId) {
    for (const kind of ['resident', 'lead', 'vendor'] as const) {
      const p = resolvePerson(orgId, kind, msg.personId);
      if (p) return p;
    }
  }
  if (msg.to) {
    const r = q1<any>('SELECT * FROM residents WHERE org_id=? AND (email=? OR phone=?) LIMIT 1', orgId, msg.to, msg.to);
    if (r) return { kind: 'resident', id: r.id, name: `${r.first_name} ${r.last_name}`.trim(), email: r.email, phone: r.phone, propertyId: r.property_id };
    const l = q1<any>('SELECT * FROM leads WHERE org_id=? AND (email=? OR phone=?) LIMIT 1', orgId, msg.to, msg.to);
    if (l) return { kind: 'lead', id: l.id, name: `${l.first_name || ''} ${l.last_name || ''}`.trim() || l.email || 'Lead', email: l.email, phone: l.phone, propertyId: l.property_id };
  }
  return null;
}

export function ensureThread(orgId: string, person: PersonRef): string {
  const existing = q1<any>('SELECT id FROM threads WHERE org_id=? AND person_kind=? AND person_id=?', orgId, person.kind, person.id);
  if (existing) return existing.id as string;
  const tid = id('thr');
  insert('threads', {
    id: tid, org_id: orgId, property_id: person.propertyId || null,
    person_kind: person.kind, person_id: person.id, display_name: person.name,
    status: 'open', needs_reply: 0, created_at: nowIso(),
  });
  return tid;
}

function touchThread(threadId: string, at: string, snippet: string, needsReply: boolean | null): void {
  run(
    `UPDATE threads SET last_message_at=?, last_snippet=?, status=CASE WHEN status='closed' THEN 'open' ELSE status END
     ${needsReply === null ? '' : `, needs_reply=${needsReply ? 1 : 0}`} WHERE id=?`,
    at, snippet.slice(0, 120), threadId,
  );
}

/** every outbound message threads automatically + deterministic open sim */
registerSendHook((ctx, messageId, msg) => {
  const person = personFromMessage(ctx.orgId, msg);
  if (person) {
    const tid = ensureThread(ctx.orgId, person);
    run('UPDATE outbox_messages SET thread_id=?, person_id=? WHERE id=?', tid, person.id, messageId);
    touchThread(tid, nowIso(), (msg.subject || msg.body).replace(/<[^>]+>/g, ' '), false);
  }
  // ~55% of emails get "opened" (deterministic per message)
  if (msg.channel === 'email' && strSeed(messageId) % 100 < 55) {
    run(`UPDATE outbox_messages SET status='opened' WHERE id=?`, messageId);
  }
});

/** simulated inbound reply (Message Console / thread view / e2e) */
export function inboundMessage(
  ctx: Ctx,
  input: { personKind: string; personId: string; channel: 'email' | 'sms'; body: string; subject?: string },
): string {
  const person = resolvePerson(ctx.orgId, input.personKind, input.personId);
  if (!person) throw new Error('person not found');
  const tid = ensureThread(ctx.orgId, person);
  const mid = id('msg');
  insert('outbox_messages', {
    id: mid, org_id: ctx.orgId, property_id: person.propertyId || null, channel: input.channel,
    direction: 'in', to_addr: person.email || person.phone || '', to_name: person.name,
    subject: input.subject || null, body: input.body, template_key: null,
    entity: 'thread', entity_id: tid, thread_id: tid, person_id: person.id,
    status: 'received', sent_by: null, created_at: nowIso(), business_date: ctx.businessDate,
  });
  touchThread(tid, nowIso(), input.body, true);
  emit(ctx, 'message.inbound', 'thread', tid, { channel: input.channel, personId: person.id });
  return mid;
}

// ---------- consent (M15.7) ----------

export function commPrefs(orgId: string, personKind: string, personId: string): { emailOptout: boolean; smsOptout: boolean; token: string } {
  let row = q1<any>('SELECT * FROM comm_prefs WHERE org_id=? AND person_kind=? AND person_id=?', orgId, personKind, personId);
  if (!row) {
    const tok = token(12);
    insert('comm_prefs', {
      id: id('cpf'), org_id: orgId, person_kind: personKind, person_id: personId,
      email_optout: 0, sms_optout: 0, unsubscribe_token: tok, updated_at: nowIso(),
    });
    row = { email_optout: 0, sms_optout: 0, unsubscribe_token: tok };
  }
  return { emailOptout: !!row.email_optout, smsOptout: !!row.sms_optout, token: row.unsubscribe_token };
}

export function setOptout(ctx: Ctx, personKind: string, personId: string, channel: 'email' | 'sms', optout: boolean): void {
  commPrefs(ctx.orgId, personKind, personId); // ensure row
  run(
    `UPDATE comm_prefs SET ${channel === 'email' ? 'email_optout' : 'sms_optout'}=?, updated_at=? WHERE org_id=? AND person_kind=? AND person_id=?`,
    optout ? 1 : 0, nowIso(), ctx.orgId, personKind, personId,
  );
  audit(ctx, 'comm_prefs', personId, optout ? `optout_${channel}` : `optin_${channel}`);
}

export function inQuietHours(ctx: Ctx, propertyId?: string | null): boolean {
  const quiet = getSetting<{ start: string; end: string }>(ctx, 'quiet_hours', propertyId);
  const hour = getDials(ctx.orgId).clockHour;
  const start = parseInt(quiet.start.slice(0, 2), 10);
  const end = parseInt(quiet.end.slice(0, 2), 10);
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

// ---------- template library (M15.2) ----------

export function upsertCustomTemplate(
  ctx: Ctx,
  input: { key?: string; name: string; category: string; subject: string; body: string; sms?: string; propertyId?: string | null },
): string {
  const key = input.key || `custom:${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40)}`;
  const existing = q1<any>('SELECT id FROM message_templates WHERE org_id=? AND key=?', ctx.orgId, key);
  if (existing) {
    update('message_templates', existing.id, {
      name: input.name, category: input.category, subject: input.subject, body: input.body, sms: input.sms || null,
    });
    return existing.id as string;
  }
  const tid = id('tpl');
  insert('message_templates', {
    id: tid, org_id: ctx.orgId, property_id: input.propertyId ?? null, key, category: input.category,
    name: input.name, subject: input.subject, body: input.body, sms: input.sms || null,
    active: 1, created_by: ctx.userName, created_at: nowIso(),
  });
  audit(ctx, 'message_template', tid, 'create', null, { key });
  return tid;
}

// ---------- segments + mass comms (M15.3) ----------

export interface SegmentFilters {
  propertyId?: string | null;
  balanceOverCents?: number | null;
  expiringDays?: number | null;
  hasPet?: boolean;
  autopay?: 'on' | 'off' | null;
  delinquent?: boolean;
}

export interface SegmentRecipient {
  residentId: string;
  leaseId: string;
  name: string;
  email: string | null;
  phone: string | null;
  unit: string;
  propertyId: string;
  balanceCents: number;
}

/** live audience from filters — primary contact per matching lease */
export function segmentRecipients(ctx: Ctx, f: SegmentFilters): SegmentRecipient[] {
  const params: unknown[] = [ctx.orgId];
  let where = `l.org_id=? AND l.status IN ('active','notice','month_to_month')`;
  if (f.propertyId) { where += ' AND l.property_id=?'; params.push(f.propertyId); }
  if (f.expiringDays) { where += ' AND l.end_date <= ?'; params.push(addDays(ctx.businessDate, f.expiringDays)); }
  if (f.hasPet) where += ' AND EXISTS (SELECT 1 FROM pets p WHERE p.lease_id=l.id)';
  if (f.autopay === 'on') where += ' AND EXISTS (SELECT 1 FROM autopay_enrollments ae WHERE ae.lease_id=l.id AND ae.active=1)';
  if (f.autopay === 'off') where += ' AND NOT EXISTS (SELECT 1 FROM autopay_enrollments ae WHERE ae.lease_id=l.id AND ae.active=1)';
  const leases = q<any>(
    `SELECT l.id AS lease_id, l.property_id, u.unit_number, r.id AS resident_id, r.first_name, r.last_name, r.email, r.phone
     FROM leases l JOIN units u ON u.id=l.unit_id
     JOIN household_members hm ON hm.lease_id=l.id AND hm.role='primary'
     JOIN residents r ON r.id=hm.resident_id
     WHERE ${where} ORDER BY u.unit_number`,
    ...params,
  );
  const out: SegmentRecipient[] = [];
  for (const l of leases) {
    const balance = leaseBalance(ctx, l.lease_id);
    if (f.balanceOverCents != null && balance <= f.balanceOverCents) continue;
    if (f.delinquent && balance <= 0) continue;
    out.push({
      residentId: l.resident_id, leaseId: l.lease_id, name: `${l.first_name} ${l.last_name}`.trim(),
      email: l.email, phone: l.phone, unit: l.unit_number, propertyId: l.property_id, balanceCents: balance,
    });
  }
  return out;
}

export function renderMerge(ctx: Ctx, text: string, r: SegmentRecipient): string {
  const prop = q1<any>('SELECT name FROM properties WHERE id=?', r.propertyId);
  return text.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    const map: Record<string, string> = {
      first_name: r.name.split(' ')[0] || 'resident',
      name: r.name, unit: r.unit, property: prop?.name || '',
      balance: `$${(r.balanceCents / 100).toFixed(2)}`,
    };
    return map[k] ?? `{{${k}}}`;
  });
}

export function scheduleMass(
  ctx: Ctx,
  input: { filters: SegmentFilters; segmentId?: string | null; subject: string; body: string; smsBody?: string; channels: string[]; scheduledFor: string },
): string {
  const mid = id('mas');
  const recipients = segmentRecipients(ctx, input.filters);
  if (!recipients.length) throw new Error('the segment matches no one');
  tx(() => {
    insert('mass_messages', {
      id: mid, org_id: ctx.orgId, segment_id: input.segmentId ?? null, filters: js(input.filters),
      subject: input.subject, body: input.body, sms_body: input.smsBody || null,
      channels: js(input.channels), scheduled_for: input.scheduledFor, status: 'scheduled',
      created_by: ctx.userName, created_at: nowIso(),
    });
    for (const r of recipients) {
      for (const channel of input.channels) {
        insert('mass_recipients', {
          id: id('mrc'), org_id: ctx.orgId, mass_id: mid, resident_id: r.residentId, lease_id: r.leaseId,
          channel, status: 'pending', reason: null,
        });
      }
    }
  });
  emit(ctx, 'mass.scheduled', 'mass_message', mid, { recipients: recipients.length, scheduledFor: input.scheduledFor });
  audit(ctx, 'mass_message', mid, 'schedule', null, { recipients: recipients.length });
  return mid;
}

/** deliver everything due: consent + quiet hours enforced per recipient */
export function runMassMessages(ctx: Ctx, date: string): { sent: number; skipped: number; deferred: number } {
  let sent = 0;
  let skipped = 0;
  let deferred = 0;
  const due = q<any>(
    `SELECT * FROM mass_messages WHERE org_id=? AND status IN ('scheduled','sending') AND scheduled_for<=?`,
    ctx.orgId, date,
  );
  for (const m of due) {
    run(`UPDATE mass_messages SET status='sending' WHERE id=?`, m.id);
    const pend = q<any>(`SELECT * FROM mass_recipients WHERE mass_id=? AND status IN ('pending','deferred_quiet')`, m.id);
    let anyDeferred = false;
    for (const rc of pend) {
      const resident = q1<any>('SELECT * FROM residents WHERE id=?', rc.resident_id);
      if (!resident) continue;
      const prefs = commPrefs(ctx.orgId, 'resident', rc.resident_id);
      const rec: SegmentRecipient = {
        residentId: resident.id, leaseId: rc.lease_id, name: `${resident.first_name} ${resident.last_name}`.trim(),
        email: resident.email, phone: resident.phone,
        unit: q1<any>('SELECT u.unit_number FROM leases l JOIN units u ON u.id=l.unit_id WHERE l.id=?', rc.lease_id)?.unit_number || '',
        propertyId: resident.property_id, balanceCents: leaseBalance(ctx, rc.lease_id),
      };
      if (rc.channel === 'email') {
        if (prefs.emailOptout) {
          run(`UPDATE mass_recipients SET status='skipped_optout', reason='resident opted out of email' WHERE id=?`, rc.id);
          skipped++;
          continue;
        }
        if (!resident.email) {
          run(`UPDATE mass_recipients SET status='skipped_no_address', reason='no email on file' WHERE id=?`, rc.id);
          skipped++;
          continue;
        }
        const unsubscribe = `<p style="font-size:11px;color:#888">— <a href="/u/${prefs.token}">Unsubscribe from community emails</a></p>`;
        const oid = sendEmail(ctx, {
          to: resident.email, toName: rec.name, subject: renderMerge(ctx, m.subject, rec),
          body: renderMerge(ctx, m.body, rec) + unsubscribe,
          propertyId: resident.property_id, entity: 'mass_message', entityId: m.id, personId: resident.id, templateKey: 'mass',
        });
        run(`UPDATE mass_recipients SET status='sent', outbox_id=?, sent_at=? WHERE id=?`, oid, nowIso(), rc.id);
        sent++;
      } else if (rc.channel === 'sms') {
        if (prefs.smsOptout) {
          run(`UPDATE mass_recipients SET status='skipped_optout', reason='resident opted out of SMS' WHERE id=?`, rc.id);
          skipped++;
          continue;
        }
        if (!resident.phone) {
          run(`UPDATE mass_recipients SET status='skipped_no_address', reason='no mobile number on file' WHERE id=?`, rc.id);
          skipped++;
          continue;
        }
        if (inQuietHours(ctx, resident.property_id)) {
          run(`UPDATE mass_recipients SET status='deferred_quiet', reason='inside quiet hours — retries next window' WHERE id=?`, rc.id);
          deferred++;
          anyDeferred = true;
          continue;
        }
        const oid = sendSms(ctx, {
          to: resident.phone, toName: rec.name, body: renderMerge(ctx, m.sms_body || m.subject, rec),
          propertyId: resident.property_id, entity: 'mass_message', entityId: m.id, personId: resident.id, templateKey: 'mass',
        });
        run(`UPDATE mass_recipients SET status='sent', outbox_id=?, sent_at=? WHERE id=?`, oid, nowIso(), rc.id);
        sent++;
      }
    }
    if (!anyDeferred) {
      const counts = q1<any>(
        `SELECT SUM(status='sent') AS s, SUM(status LIKE 'skipped%') AS k FROM mass_recipients WHERE mass_id=?`, m.id,
      );
      run(`UPDATE mass_messages SET status='sent', sent_at=?, sent_count=?, skipped_count=? WHERE id=?`, nowIso(), counts?.s || 0, counts?.k || 0, m.id);
    }
  }
  return { sent, skipped, deferred };
}

// ---------- announcements (M15.4) ----------

export function postAnnouncement(
  ctx: Ctx,
  input: { propertyId?: string | null; title: string; body: string; startsDate: string; endsDate?: string | null; echoEmail?: boolean; echoSms?: boolean },
): string {
  const aid = id('ann');
  insert('announcements', {
    id: aid, org_id: ctx.orgId, property_id: input.propertyId ?? null, title: input.title, body: input.body,
    starts_date: input.startsDate, ends_date: input.endsDate ?? null,
    echo_email: input.echoEmail ? 1 : 0, echo_sms: input.echoSms ? 1 : 0,
    created_by: ctx.userName, created_at: nowIso(),
  });
  if (input.echoEmail || input.echoSms) {
    const channels = [...(input.echoEmail ? ['email'] : []), ...(input.echoSms ? ['sms'] : [])];
    scheduleMass(ctx, {
      filters: { propertyId: input.propertyId || null },
      subject: `📣 ${input.title}`, body: `<p>${input.body}</p>`, smsBody: `${input.title}: ${input.body}`,
      channels, scheduledFor: input.startsDate,
    });
  }
  audit(ctx, 'announcement', aid, 'post', null, { title: input.title });
  return aid;
}

// ---------- automation audit (M15.5) ----------

export function automationAudit(ctx: Ctx): { key: string; count: number; last: string; sample: any }[] {
  return q<any>(
    `SELECT template_key AS key, COUNT(*) AS count, MAX(created_at) AS last
     FROM outbox_messages WHERE org_id=? AND template_key IS NOT NULL AND direction='out'
     GROUP BY template_key ORDER BY count DESC`,
    ctx.orgId,
  ).map((r) => ({
    ...r,
    sample: q1<any>(
      `SELECT id, entity, entity_id, subject FROM outbox_messages WHERE org_id=? AND template_key=? ORDER BY created_at DESC LIMIT 1`,
      ctx.orgId, r.key,
    ),
  }));
}

registerJob({
  key: 'mass_comms',
  name: 'Mass communications delivery',
  describe: 'Delivers scheduled mass messages and announcement echoes — consent and quiet hours enforced per recipient.',
  run: (ctx, date) => {
    const r = runMassMessages(ctx, date);
    return r.sent || r.skipped || r.deferred ? `${r.sent} sent, ${r.skipped} skipped, ${r.deferred} deferred (quiet hours)` : 'nothing scheduled';
  },
});
