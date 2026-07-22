import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert, run, val } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { sysCtx } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { setDials } from '../src/lib/sim/dials.ts';
import { setSetting } from '../src/lib/settings.ts';
import { notify, renderTemplate } from '../src/lib/templates.ts';
import {
  ensureThread, inboundMessage, commPrefs, setOptout, inQuietHours,
  upsertCustomTemplate, segmentRecipients, scheduleMass, runMassMessages,
} from '../src/modules/m15_comms/service.ts';
import { createCharge } from '../src/modules/m8_receivables/service.ts';
import '../src/modules/m15_comms/pages.ts'; // registers send hook via service import

/** Phase 13 units: segments, consent + quiet hours in the mass pipeline,
 * threading on send + inbound, template overrides, automation toggles. */

let orgId: string;
let propId: string;
const residents: { id: string; leaseId: string }[] = [];
const BD = '2026-07-26';

before(() => {
  db();
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'Comms Test Org', slug: 'comms-' + orgId.slice(-6), business_date: BD, created_at: nowIso() });
  ensureCoa(orgId);
  propId = id('prp');
  insert('properties', {
    id: propId, org_id: orgId, name: 'Comm Court', slug: 'comm-' + orgId.slice(-6), type: 'multifamily',
    address1: '5 Signal St', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso(),
  });
  for (let i = 0; i < 4; i++) {
    const uid = id('unt');
    insert('units', {
      id: uid, org_id: orgId, property_id: propId, unit_number: `C-10${i}`, floor: 1, sqft: 800,
      status: 'occupied', market_rent_cents: 140000, amenities: '[]', created_at: nowIso(),
    });
    const lid = id('lse');
    insert('leases', {
      id: lid, org_id: orgId, property_id: propId, unit_id: uid, household_name: `C10${i} household`,
      status: 'active', start_date: '2026-01-01', end_date: '2026-12-31', move_in_date: '2026-01-01',
      rent_cents: 140000, deposit_cents: 140000, deposit_alternative: 0, term_months: 12, created_at: nowIso(),
    });
    const rid = id('res');
    insert('residents', {
      id: rid, org_id: orgId, property_id: propId, first_name: `Cam${i}`, last_name: 'Comms',
      email: `cam${i}@comms.test`, phone: `555010${i}`, kind: 'adult', created_at: nowIso(),
    });
    insert('household_members', { id: id('hm'), org_id: orgId, lease_id: lid, resident_id: rid, role: 'primary', created_at: nowIso() });
    residents.push({ id: rid, leaseId: lid });
  }
  // balances: residents 0 and 1 owe money
  const ctx = sysCtx(orgId);
  createCharge(ctx, { leaseId: residents[0]!.leaseId, kind: 'rent', label: 'Rent', amountCents: 140000, date: BD, dueDate: BD, source: 'recurring' });
  createCharge(ctx, { leaseId: residents[1]!.leaseId, kind: 'late_fee', label: 'Late fee', amountCents: 5000, date: BD, dueDate: BD, source: 'late_fee' });
});

test('segments filter on live balance and property', () => {
  const ctx = sysCtx(orgId);
  const withBalance = segmentRecipients(ctx, { propertyId: propId, balanceOverCents: 0 });
  assert.equal(withBalance.length, 2);
  assert.deepEqual(withBalance.map((r) => r.name).sort(), ['Cam0 Comms', 'Cam1 Comms']);
  const over100 = segmentRecipients(ctx, { propertyId: propId, balanceOverCents: 100000 });
  assert.equal(over100.length, 1, 'only the full rent balance clears $1,000');
  assert.equal(segmentRecipients(ctx, { propertyId: propId }).length, 4, 'no filter = all primaries');
});

test('mass pipeline: opt-outs skipped with reasons; quiet hours defer SMS then deliver', () => {
  const ctx = sysCtx(orgId);
  setOptout(ctx, 'resident', residents[1]!.id, 'email', true);
  setOptout(ctx, 'resident', residents[0]!.id, 'sms', true);
  setDials(orgId, { clockHour: 22 }); // night

  const mid = scheduleMass(ctx, {
    filters: { propertyId: propId, balanceOverCents: 0 },
    subject: 'Balance note {{first_name}}', body: '<p>{{balance}} open on {{unit}}</p>', smsBody: '{{balance}} open',
    channels: ['email', 'sms'], scheduledFor: BD,
  });
  let r = runMassMessages(ctx, BD);
  // email: resident0 sent, resident1 skipped_optout; sms: resident0 skipped_optout, resident1 deferred (quiet)
  const rows = q<any>('SELECT * FROM mass_recipients WHERE mass_id=? ORDER BY channel, resident_id', mid);
  const emailStatuses = rows.filter((x) => x.channel === 'email').map((x) => x.status).sort();
  assert.deepEqual(emailStatuses, ['sent', 'skipped_optout']);
  assert.match(rows.find((x) => x.channel === 'email' && x.status === 'skipped_optout')!.reason, /opted out of email/);
  const smsStatuses = rows.filter((x) => x.channel === 'sms').map((x) => x.status).sort();
  assert.deepEqual(smsStatuses, ['deferred_quiet', 'skipped_optout']);
  assert.equal(q1<any>('SELECT status FROM mass_messages WHERE id=?', mid).status, 'sending', 'stays open while deferred');

  setDials(orgId, { clockHour: 9 }); // morning
  r = runMassMessages(ctx, BD);
  assert.equal(r.sent, 1, 'deferred SMS delivers after quiet hours');
  assert.equal(q1<any>('SELECT status FROM mass_messages WHERE id=?', mid).status, 'sent');
  // unsubscribe link embedded in mass email
  const sentEmail = q1<any>(`SELECT body FROM outbox_messages WHERE org_id=? AND template_key='mass' AND channel='email' ORDER BY created_at DESC`, orgId);
  assert.match(sentEmail.body, /\/u\//, 'unsubscribe link present');
});

test('sends auto-thread; inbound flags needs-reply; unified identity', () => {
  const ctx = sysCtx(orgId);
  const t = q1<any>('SELECT * FROM threads WHERE org_id=? AND person_id=?', orgId, residents[0]!.id);
  assert.ok(t, 'mass send created/attached a thread');
  assert.equal(t.needs_reply, 0);
  inboundMessage(ctx, { personKind: 'resident', personId: residents[0]!.id, channel: 'sms', body: 'can I get an extension?' });
  const t2 = q1<any>('SELECT * FROM threads WHERE id=?', t.id);
  assert.equal(t2.needs_reply, 1);
  assert.match(t2.last_snippet, /extension/);
  const msgs = q<any>('SELECT direction FROM outbox_messages WHERE thread_id=?', t.id);
  assert.equal(msgs.some((m) => m.direction === 'in'), true);
  assert.equal(msgs.some((m) => m.direction === 'out'), true);
});

test('org template overrides beat code defaults; automation toggles suppress sends', () => {
  const ctx = sysCtx(orgId);
  upsertCustomTemplate(ctx, {
    key: 'late_fee_notice', name: 'Kinder late fee note', category: 'delinquency',
    subject: 'Heads up {{first_name}} — a late fee posted', body: '<p>Softer wording. Balance {{balance}}.</p>', sms: 'softer {{balance}}',
  });
  const r = renderTemplate('late_fee_notice', { first_name: 'Cam', balance: '$50' }, orgId);
  assert.match(r.subject, /Heads up Cam/);
  const rDefault = renderTemplate('late_fee_notice', { first_name: 'Cam', balance: '$50' });
  assert.match(rDefault.subject, /late fee was applied/);

  // toggle off payment_receipt: notify becomes a no-op
  setSetting(ctx, 'comms_toggles', { payment_receipt: false });
  const before2 = val<number>('SELECT COUNT(*) FROM outbox_messages WHERE org_id=?', orgId) || 0;
  notify(ctx, 'payment_receipt', { email: 'cam0@comms.test', name: 'Cam' }, { first_name: 'Cam', amount: '$1', unit: 'C', date: 'x', method: 'ach', reference: 'r', balance: '$0', property: 'P' });
  assert.equal(val<number>('SELECT COUNT(*) FROM outbox_messages WHERE org_id=?', orgId), before2, 'disabled template skipped');
  setSetting(ctx, 'comms_toggles', { payment_receipt: true });
  notify(ctx, 'payment_receipt', { email: 'cam0@comms.test', name: 'Cam' }, { first_name: 'Cam', amount: '$1', unit: 'C', date: 'x', method: 'ach', reference: 'r', balance: '$0', property: 'P' });
  assert.equal(val<number>('SELECT COUNT(*) FROM outbox_messages WHERE org_id=?', orgId), before2 + 1);
});
