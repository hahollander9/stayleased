import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, q1, insert } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso, addDays } from '../src/lib/dates.ts';
import { sysCtx } from '../src/lib/auth.ts';
import { ensureCoa } from '../src/modules/m9_accounting/coa.ts';
import { triageRequest } from '../src/modules/m17_ai/agents.ts';
import { askSmart, explainOccupancy } from '../src/modules/m17_ai/ask.ts';
import { intakeLead, messageLead, bookTour } from '../src/modules/m3_crm/service.ts';
import '../src/modules/m17_ai/pages.ts'; // registers executors

/** Reasoning everywhere (Henry's ask): every AI action carries a plain-language
 * rationale, stage moves log their reason on the lead timeline, and analytical
 * questions to Ask get a causal story instead of a snapshot table. */

const BD = '2026-07-26';
let orgId: string;
let propId: string;

before(() => {
  db();
  orgId = id('org');
  insert('orgs', { id: orgId, name: 'Reasoning Test Org', slug: 'rsn-' + orgId.slice(-6), business_date: BD, created_at: nowIso() });
  ensureCoa(orgId);
  propId = id('prp');
  insert('properties', {
    id: propId, org_id: orgId, name: 'Rationale Row', slug: 'rationale-' + orgId.slice(-6), type: 'multifamily',
    address1: '1 Why Way', city: 'Denver', state: 'CO', zip: '80202', timezone: 'America/Denver', created_at: nowIso(),
  });
  const fpId = id('fpl');
  insert('floorplans', { id: fpId, org_id: orgId, property_id: propId, name: 'B1', beds: 1, baths: 1, sqft: 720, market_rent_cents: 150000, created_at: nowIso() });
  const mkUnit = (n: string, status: string): string => {
    const uid = id('unt');
    insert('units', {
      id: uid, org_id: orgId, property_id: propId, floorplan_id: fpId, unit_number: n,
      floor: 1, sqft: 720, status, market_rent_cents: 150000, amenities: '[]', created_at: nowIso(),
    });
    return uid;
  };
  const u1 = mkUnit('W-101', 'occupied');
  const u2 = mkUnit('W-102', 'vacant_ready');
  mkUnit('W-103', 'occupied');
  // one move-OUT inside the 30-day window (ended 10 days ago)…
  insert('leases', {
    id: id('lse'), org_id: orgId, property_id: propId, unit_id: u2, household_name: 'Left Lastmonth',
    status: 'ended', start_date: '2025-07-01', end_date: addDays(BD, -10), move_in_date: '2025-07-01',
    move_out_date: addDays(BD, -10), rent_cents: 150000, deposit_cents: 150000, deposit_alternative: 0, term_months: 12, created_at: nowIso(),
  });
  // …and one move-IN inside the window (started 5 days ago)
  insert('leases', {
    id: id('lse'), org_id: orgId, property_id: propId, unit_id: u1, household_name: 'Just Movedin',
    status: 'active', start_date: addDays(BD, -5), end_date: addDays(BD, 360), move_in_date: addDays(BD, -5),
    rent_cents: 150000, deposit_cents: 150000, deposit_alternative: 0, term_months: 12, created_at: nowIso(),
  });
});

test('explainOccupancy tells the 30-day story: direction, move-ins/outs, the lever', () => {
  const ctx = sysCtx(orgId);
  const why = explainOccupancy(ctx, { id: propId, name: 'Rationale Row' });
  assert.match(why, /Occupancy (slipped|improved|held flat)/);
  assert.match(why, /1 move-out/);
  assert.match(why, /1 move-in/);
  assert.match(why, /on notice/);
  assert.match(why, /at Rationale Row/);
});

test('askSmart: analytical phrasing gets the causal story; plain phrasing keeps the snapshot', async () => {
  const ctx = sysCtx(orgId);
  const why = await askSmart(ctx, 'why is occupancy down at Rationale Row?');
  assert.equal(why.matched, 'occupancy+why');
  assert.match(why.summary, /move-out/);
  assert.ok(why.table, 'receipts table stays attached');
  const plain = await askSmart(ctx, 'occupancy right now');
  assert.equal(plain.matched, 'occupancy');
  assert.match(plain.summary, /physical occupancy/);
  // both answers were audited with a rationale
  const acts = q<any>(`SELECT rationale FROM ai_actions WHERE org_id=? AND agent='ask' ORDER BY created_at`, orgId);
  assert.ok(acts.length >= 2);
  assert.ok(acts.every((a) => a.rationale && a.rationale.length > 20), 'every ask action carries a rationale');
  assert.match(acts[0]!.rationale, /explainer|Analytical/);
});

test('agent decisions persist a plain-language rationale (triage)', () => {
  const ctx = sysCtx(orgId);
  const woId = id('wo');
  insert('work_orders', {
    id: woId, org_id: orgId, property_id: propId, unit_id: null, lease_id: null,
    category: 'other', priority: 'normal', status: 'new', summary: 'I smell gas in the hallway', description: '',
    source: 'portal', created_date: BD, created_at: nowIso(),
  });
  triageRequest(ctx, woId);
  const action = q1<any>(`SELECT * FROM ai_actions WHERE entity_id=? AND agent='maintenance'`, woId);
  assert.ok(action, 'triage produced an action');
  assert.match(action.rationale, /Keyed off/);
  assert.match(action.rationale, /emergency keywords/);
});

test('lead stage moves log their reason on the timeline', () => {
  const ctx = sysCtx(orgId);
  const { leadId } = intakeLead(ctx, { propertyId: propId, firstName: 'Reya', lastName: 'Reason', email: 'reya@x.test', source: 'website' });
  messageLead(ctx, leadId, 'email', 'Welcome', 'Thanks for reaching out!');
  assert.equal(q1<any>('SELECT status FROM leads WHERE id=?', leadId)!.status, 'contacted');
  const contacted = q1<any>(`SELECT body FROM lead_events WHERE lead_id=? AND kind='status' ORDER BY at DESC`, leadId);
  assert.match(contacted!.body, /Status → contacted \(first email sent\)/);
  bookTour(ctx, { leadId, date: '2026-07-27', startTime: '10:00', skipConfirmation: true });
  assert.equal(q1<any>('SELECT status FROM leads WHERE id=?', leadId)!.status, 'touring');
  const touring = q<any>(`SELECT body FROM lead_events WHERE lead_id=? AND kind='status' ORDER BY at`, leadId);
  assert.match(touring[touring.length - 1]!.body, /Status → touring \(tour booked for .+ 10:00\)/);
});
