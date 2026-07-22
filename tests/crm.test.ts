import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureFinance, type FinanceFx } from './harness.ts';
import { sysCtx } from '../src/lib/auth.ts';
import { q, q1, val, run } from '../src/lib/db.ts';
import { intakeLead, bookTour, completeTour, buildQuote, quotedRent, tourSlots, funnelStats, messageLead } from '../src/modules/m3_crm/service.ts';
import { addDays } from '../src/lib/dates.ts';

let fx: FinanceFx;
const D = '2026-07-26';

before(() => {
  fx = fixtureFinance();
});

test('lead intake dedupes by email and phone', () => {
  const ctx = sysCtx(fx.orgId, D);
  const a = intakeLead(ctx, { propertyId: fx.propId, firstName: 'Dee', lastName: 'Dupe', email: 'dee@x.test', phone: '(555) 111-2222', source: 'zillow' });
  assert.equal(a.deduped, false);
  const b = intakeLead(ctx, { propertyId: fx.propId, firstName: 'Dee', lastName: 'Dupe', email: 'DEE@X.TEST', source: 'apartments_com' });
  assert.equal(b.deduped, true);
  assert.equal(b.leadId, a.leadId);
  const c = intakeLead(ctx, { propertyId: fx.propId, firstName: 'D', lastName: 'D', phone: '(555) 111-2222', source: 'phone' });
  assert.equal(c.deduped, true);
  const events = q<any>(`SELECT * FROM lead_events WHERE lead_id=? AND kind='inquiry'`, a.leadId);
  assert.equal(events.length, 3);
  // cadence created once
  const tasks = q<any>(`SELECT * FROM followup_tasks WHERE lead_id=? AND status='open'`, a.leadId);
  assert.equal(tasks.length, 5); // default cadence [0,1,3,7,14]
});

test('outbound touch completes the earliest cadence task and advances status', () => {
  const ctx = sysCtx(fx.orgId, D);
  const { leadId } = intakeLead(ctx, { propertyId: fx.propId, firstName: 'Tess', lastName: 'Touch', email: 'tess@x.test', source: 'google' });
  messageLead(ctx, leadId, 'email', 'Hello', 'Thanks for reaching out!');
  const open = val<number>(`SELECT COUNT(*) FROM followup_tasks WHERE lead_id=? AND status='open'`, leadId);
  assert.equal(open, 4);
  assert.equal(q1<any>('SELECT status FROM leads WHERE id=?', leadId)!.status, 'contacted');
});

test('tour slots respect hours and double-booking is prevented', () => {
  const ctx = sysCtx(fx.orgId, D);
  // 2026-08-03 is a Monday
  const slots = tourSlots(ctx, fx.propId, '2026-08-03');
  assert.equal(slots.length > 5, true);
  assert.equal(slots[0], '09:00');
  const { leadId } = intakeLead(ctx, { propertyId: fx.propId, firstName: 'Tori', lastName: 'Tour', email: 'tori@x.test', source: 'zillow' });
  bookTour(ctx, { leadId, date: '2026-08-03', startTime: '10:00', skipConfirmation: true });
  const after = tourSlots(ctx, fx.propId, '2026-08-03');
  assert.equal(after.includes('10:00'), false);
  const lead2 = intakeLead(ctx, { propertyId: fx.propId, firstName: 'Toby', lastName: 'Tour', email: 'toby@x.test', source: 'zillow' });
  assert.throws(() => bookTour(ctx, { leadId: lead2.leadId, date: '2026-08-03', startTime: '10:00', skipConfirmation: true }), /slot/);
  // sunday closed by default (days [1..6])
  assert.equal(tourSlots(ctx, fx.propId, '2026-08-02').length, 0);
});

test('quote honors term pricing and rentable items', () => {
  const ctx = sysCtx(fx.orgId, D);
  const unit = q1<any>('SELECT * FROM units WHERE id=?', fx.unitId);
  assert.equal(quotedRent(ctx, unit, 12), 150000);
  assert.equal(quotedRent(ctx, unit, 6), 162000); // +8%
  assert.equal(quotedRent(ctx, unit, 15), 147000); // -2%
  const { leadId } = intakeLead(ctx, { propertyId: fx.propId, firstName: 'Q', lastName: 'Quote', email: 'q@x.test', source: 'website' });
  const quoteId = buildQuote(ctx, { leadId, unitId: fx.unitId, termMonths: 12, moveIn: addDays(D, 20) });
  const quote = q1<any>('SELECT * FROM quotes WHERE id=?', quoteId);
  assert.equal(quote.total_monthly_cents, 150000);
  assert.equal(quote.status, 'sent');
});

test('funnel stats count stages correctly', () => {
  const ctx = sysCtx(fx.orgId, D);
  const { leadId } = intakeLead(ctx, { propertyId: fx.propId, firstName: 'Fun', lastName: 'Nel', email: 'funnel@x.test', source: 'referral' });
  const tourId = bookTour(ctx, { leadId, date: '2026-08-04', startTime: '11:00', skipConfirmation: true });
  completeTour(ctx, tourId, 'completed');
  run(`UPDATE leads SET status='leased' WHERE id=?`, leadId);
  const stats = funnelStats(ctx, addDays(D, -30));
  assert.equal(stats.inquiries >= 5, true);
  assert.equal(stats.leased >= 1, true);
  assert.equal(stats.toured >= 1, true);
  assert.equal(stats.bySource.some((s) => s.source === 'referral'), true);
});
