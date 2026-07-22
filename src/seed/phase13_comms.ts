import { q, q1, val, insert, run } from '../lib/db.ts';
import { id } from '../lib/ids.ts';
import { nowIso, addDays } from '../lib/dates.ts';
import { sysCtx } from '../lib/auth.ts';
import {
  ensureThread, resolvePerson, inboundMessage, commPrefs, setOptout,
  upsertCustomTemplate, scheduleMass, postAnnouncement,
} from '../modules/m15_comms/service.ts';
import type { SeedCtx } from './seed.ts';
import { log } from './seed.ts';

/** Phase 13 seed: backfill threads from 14 months of outbox traffic, live
 * inbox states (inbound replies waiting, an assigned + a snoozed thread),
 * consent demo (SMS + email opt-outs), a custom template + an override, a
 * scheduled mass message for tomorrow, and an announcement. */

export function seedComms(s: SeedCtx): void {
  const ctx = sysCtx(s.orgId);

  // ---------- backfill threads from historical outbox traffic ----------
  const people = q<any>(
    `SELECT person_id, COUNT(*) n, MAX(created_at) last FROM outbox_messages
     WHERE org_id=? AND person_id IS NOT NULL GROUP BY person_id`,
    s.orgId,
  );
  let threads = 0;
  for (const p of people) {
    for (const kind of ['resident', 'lead'] as const) {
      const person = resolvePerson(s.orgId, kind, p.person_id);
      if (!person) continue;
      const tid = ensureThread(s.orgId, person);
      const lastMsg = q1<any>(
        `SELECT subject, body FROM outbox_messages WHERE org_id=? AND person_id=? ORDER BY created_at DESC LIMIT 1`,
        s.orgId, p.person_id,
      );
      run(
        `UPDATE threads SET last_message_at=?, last_snippet=? WHERE id=? AND last_message_at IS NULL`,
        p.last, String(lastMsg?.subject || lastMsg?.body || '').replace(/<[^>]+>/g, ' ').slice(0, 120), tid,
      );
      run(`UPDATE outbox_messages SET thread_id=? WHERE org_id=? AND person_id=? AND thread_id IS NULL`, tid, s.orgId, p.person_id);
      threads++;
      break;
    }
  }
  log(`comms: ${threads} threads backfilled from message history`);

  // ---------- live inbox states ----------
  const maya = q1<any>(`SELECT id FROM residents WHERE email='maya.torres@mail.demo'`);
  if (maya) {
    inboundMessage(ctx, {
      personKind: 'resident', personId: maya.id, channel: 'email',
      subject: 'Re: Your renewal options are ready',
      body: 'Hi! Quick question before I renew — would you do $1,395 on the 12-month option? We love it here but the increase is a stretch this year.',
    });
  }
  const derrick = q1<any>(`SELECT id FROM residents WHERE email='derrick.cole@mail.demo'`);
  if (derrick) {
    inboundMessage(ctx, {
      personKind: 'resident', personId: derrick.id, channel: 'sms',
      body: 'Got my hours back at work. Can pay $800 Friday and set up a plan for the rest like we talked about?',
    });
    const t = q1<any>(`SELECT id FROM threads WHERE org_id=? AND person_id=?`, s.orgId, derrick.id);
    const mgr = q1<any>(`SELECT id FROM users WHERE email='manager@summitridge.demo'`);
    if (t && mgr) run('UPDATE threads SET assigned_to=? WHERE id=?', mgr.id, t.id);
    if (t) {
      insert('thread_notes', {
        id: id('tnn'), org_id: s.orgId, thread_id: t.id,
        body: 'Promise-to-pay on file for the 1st ($800). If Friday payment lands, offer the 3-installment plan per policy.',
        author: 'Elena Ruiz', created_at: nowIso(),
      });
    }
  }
  // one snoozed thread
  const anyLead = q1<any>(`SELECT t.id FROM threads t WHERE t.org_id=? AND t.person_kind='lead' AND t.needs_reply=0 LIMIT 1`, s.orgId);
  if (anyLead) run(`UPDATE threads SET status='snoozed', snooze_until=? WHERE id=?`, addDays(s.businessDate, 3), anyLead.id);

  // ---------- consent demo ----------
  let optouts = 0;
  const residents = q<any>(
    `SELECT r.id FROM residents r JOIN household_members hm ON hm.resident_id=r.id AND hm.role='primary'
     JOIN leases l ON l.id=hm.lease_id AND l.status='active'
     WHERE r.org_id=? AND r.email != 'maya.torres@mail.demo' ORDER BY r.created_at, r.id LIMIT 40`,
    s.orgId,
  );
  for (const [i, r] of residents.entries()) {
    if (i % 9 === 3) {
      setOptout(ctx, 'resident', r.id, 'email', true);
      optouts++;
    }
    if (i % 7 === 2) {
      setOptout(ctx, 'resident', r.id, 'sms', true);
      optouts++;
    }
  }
  log(`comms: ${optouts} opt-outs on file (consent demo)`);

  // ---------- templates ----------
  upsertCustomTemplate(ctx, {
    name: 'Pool closure notice', category: 'community',
    subject: '{{property}}: pool closed for maintenance {{date}}',
    body: '<p>Hi {{first_name}},</p><p>The pool will be closed for scheduled maintenance. We expect to reopen the following morning. Sorry for the inconvenience!</p><p>— {{property}}</p>',
    sms: '{{property}}: Pool closed for maintenance — back tomorrow morning.',
  });
  upsertCustomTemplate(ctx, {
    key: 'dunning_friendly', name: 'Friendly balance reminder (our voice)', category: 'delinquency',
    subject: 'Quick reminder from {{property}} 💛',
    body: `<p>Hi {{first_name}},</p><p>Just a friendly note that your account shows <b>{{balance}}</b> open. If you've already paid — thank you, it can take a day to post!</p><p>Money tight this month? Reply here and we'll figure out a plan together. No judgment.</p><p>— {{property}}</p>`,
    sms: '{{property}}: friendly reminder — {{balance}} open on your account. Reply if you want to set up a plan; happy to help.',
  });

  // ---------- a scheduled mass message (sends on tomorrow's advance) ----------
  const summit = q1<any>(`SELECT id FROM properties WHERE slug='summit-ridge'`);
  scheduleMass(ctx, {
    filters: { propertyId: summit.id, autopay: 'off' },
    subject: 'Set up autopay in 2 minutes, {{first_name}}?',
    body: '<p>Hi {{first_name}},</p><p>Rent for unit {{unit}} is easier on autopay — pick your date, keep your grace period, cancel anytime in the portal.</p>',
    smsBody: '{{property}}: Autopay takes 2 minutes in the portal — pick your date, cancel anytime.',
    channels: ['email'],
    scheduledFor: addDays(s.businessDate, 1),
  });
  log('comms: autopay campaign scheduled for tomorrow (Summit Ridge, autopay-off segment)');

  // ---------- announcement ----------
  postAnnouncement(ctx, {
    propertyId: summit.id, title: 'Elevator B maintenance Thursday',
    body: 'Elevator B is down for its annual inspection Thursday 9am–1pm. Elevator A and the west stairs remain open.',
    startsDate: s.businessDate, endsDate: addDays(s.businessDate, 5),
  });
  const threadsTotal = val<number>('SELECT COUNT(*) FROM threads WHERE org_id=?', s.orgId) || 0;
  log(`comms: ${threadsTotal} threads live, announcement posted`);
}
