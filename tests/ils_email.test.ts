import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { q1, q, insert } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { sysCtx } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import {
  parseLeadEmail, shouldIgnore, normalizeWebhook, intakeAddressFor, resolveIntakeAddress,
  applyInboundLead, type InboundEmail,
} from '../src/modules/m3_crm/ils_email.ts';

/** ILS lead-email gate — the automatic path from listing-site email to guest
 * card. Parsers are deterministic and never drop a lead; addresses resolve
 * only with the right per-property code; the apply path creates the lead,
 * threads the prospect's message, and dedupes repeats. */

let orgId: string;
let propId: string;

before(() => {
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'ILS Test Org', slug: `ils-test-${orgId.slice(-6)}`, business_date: '2026-07-26', kind: 'demo', created_at: nowIso() });
  ensureCoa(orgId);
  propId = id('prp');
  insert('properties', {
    id: propId, org_id: orgId, name: 'Testable Terrace', slug: `testable-terrace-${propId.slice(-6)}`,
    type: 'multifamily', address1: '1 Test Way', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso(),
  });
});

const ZILLOW: InboundEmail = {
  from: { email: 'no-reply@convo.zillow.com', name: 'Zillow' },
  replyTo: 'reply-abc123@convo.zillow.com',
  to: [],
  subject: 'New contact: Dana Fields is interested in 1 Test Way #B-204',
  text: [
    'You have a new contact from Zillow.',
    '',
    'Dana Fields says:',
    'Hi! Is the 2 bed still open? We could tour this weekend. We have a cat.',
    '',
    'Phone: (720) 555-0142',
    'Move-in: 09/01/2026',
    '',
    'Reply to this email to respond to Dana.',
  ].join('\n'),
};

const APARTMENTS: InboundEmail = {
  from: { email: 'lead@apartments.com', name: 'Apartments.com' },
  to: [],
  subject: 'New Lead for Testable Terrace',
  text: [
    'You have received a new lead from Apartments.com!',
    '',
    'Name: Marcus Webb',
    'Email: marcus.webb.demo@mail.demo',
    'Phone: 303-555-0177',
    'Beds: 1 bd',
    'Move Date: 2026-08-15',
    'Message: What does a 1 bedroom run per month? Is parking included?',
  ].join('\n'),
};

test('Zillow-style email parses: relay reply-to, name from subject, phone, move-in, message', () => {
  const p = parseLeadEmail(ZILLOW);
  assert.equal(p.source, 'zillow');
  assert.equal(p.firstName, 'Dana');
  assert.equal(p.lastName, 'Fields');
  assert.equal(p.email, 'reply-abc123@convo.zillow.com'); // relay: replying reaches the prospect
  assert.match(p.phone || '', /720/);
  assert.equal(p.moveIn, '2026-09-01');
  assert.match(p.message, /Is the 2 bed still open/);
});

test('Apartments.com-style email parses labeled fields', () => {
  const p = parseLeadEmail(APARTMENTS);
  assert.equal(p.source, 'apartments_com');
  assert.equal(p.firstName, 'Marcus');
  assert.equal(p.lastName, 'Webb');
  assert.equal(p.email, 'marcus.webb.demo@mail.demo');
  assert.equal(p.beds, 1);
  assert.equal(p.moveIn, '2026-08-15');
  assert.match(p.message, /1 bedroom run per month/);
});

test('junk email still becomes a lead (never drop): sender + raw text fallback', () => {
  const p = parseLeadEmail({
    from: { email: 'casey.someone@gmail.com', name: 'Casey Someone' },
    to: [], subject: 'apartment', text: 'u have anything open in october',
  });
  assert.equal(p.firstName, 'Casey');
  assert.equal(p.email, 'casey.someone@gmail.com');
  assert.match(p.message, /anything open/);
  assert.equal(p.source, 'ils_email');
});

test('bounces, auto-replies, and own-domain mail are ignored', () => {
  assert.ok(shouldIgnore({ from: { email: 'mailer-daemon@googlemail.com', name: '' }, to: [], subject: 'x', text: '' }));
  assert.ok(shouldIgnore({ from: { email: 'a@b.com', name: '' }, to: [], subject: 'Automatic reply: out this week', text: '' }));
  assert.ok(shouldIgnore({ from: { email: 'leads-x-abc123@in.stayleased.com', name: '' }, to: [], subject: 'hi', text: '' }));
  assert.equal(shouldIgnore(ZILLOW), null);
});

test('intake address round-trips and rejects a wrong code', () => {
  const ctx = sysCtx(orgId);
  const prop = q1<any>('SELECT id, org_id, slug, name FROM properties WHERE id=?', propId);
  const addr = intakeAddressFor(ctx, prop);
  assert.match(addr, new RegExp(`^leads-${prop.slug}-[a-f0-9]{6}@`));
  assert.equal(intakeAddressFor(ctx, prop), addr, 'code is stable across calls');
  const hit = resolveIntakeAddress(addr);
  assert.equal(hit?.id, propId);
  assert.equal(resolveIntakeAddress(addr.replace(/-[a-f0-9]{6}@/, '-000000@')), null, 'wrong code must not resolve');
  assert.equal(resolveIntakeAddress('leads-nope-abcdef@in.stayleased.com'), null);
});

test('normalizeWebhook reads Postmark and generic shapes', () => {
  const pm = normalizeWebhook({
    FromFull: { Email: 'Lead@Apartments.com', Name: 'Apartments.com' },
    ToFull: [{ Email: 'leads-testable-abc123@in.stayleased.com' }],
    OriginalRecipient: 'leads-testable-abc123@in.stayleased.com',
    Subject: 'New Lead', HtmlBody: '<p>Name: A B</p>',
  });
  assert.equal(pm.from.email, 'lead@apartments.com');
  assert.ok(pm.to.includes('leads-testable-abc123@in.stayleased.com'));
  assert.match(pm.text, /Name: A B/);
  const gen = normalizeWebhook({ to: 'x@y.com', from: 'a@b.com', subject: 's', text: 'hello' });
  assert.equal(gen.text, 'hello');
  assert.ok(gen.to.includes('x@y.com'));
});

test('applyInboundLead creates lead + threaded inbound message; repeat dedupes into same card', () => {
  const prop = q1<any>('SELECT id, org_id, slug, name FROM properties WHERE id=?', propId);
  const first = applyInboundLead(prop, parseLeadEmail(ZILLOW), { to: 'leads-test@in.test', subject: ZILLOW.subject });
  assert.equal(first.deduped, false);
  const lead = q1<any>('SELECT * FROM leads WHERE id=?', first.leadId);
  assert.equal(lead.first_name, 'Dana');
  assert.equal(lead.source, 'zillow');
  assert.equal(lead.property_id, propId);
  const thread = q1<any>(`SELECT * FROM threads WHERE org_id=? AND person_kind='lead' AND person_id=?`, orgId, first.leadId);
  assert.ok(thread, 'prospect message must land as a real inbox thread');
  const msgs = q<any>(`SELECT * FROM outbox_messages WHERE thread_id=? AND direction='in'`, thread.id);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].body, /Is the 2 bed still open/);
  // cadence exists
  const tasks = q<any>('SELECT * FROM followup_tasks WHERE lead_id=?', first.leadId);
  assert.ok(tasks.length >= 4, 'follow-up cadence should be scheduled');
  // same prospect emails again → dedupe, second thread message
  const second = applyInboundLead(prop, parseLeadEmail(ZILLOW), { to: 'leads-test@in.test', subject: 'Re: still interested' });
  assert.equal(second.leadId, first.leadId);
  assert.equal(second.deduped, true);
  const msgs2 = q<any>(`SELECT * FROM outbox_messages WHERE thread_id=? AND direction='in'`, thread.id);
  assert.equal(msgs2.length, 2);
});
