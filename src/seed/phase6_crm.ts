import { q, q1, insert, run, val } from '../lib/db.ts';
import { id } from '../lib/ids.ts';
import { nowIso, addDays } from '../lib/dates.ts';
import { sysCtx } from '../lib/auth.ts';
import { intakeLead, bookTour, completeTour, buildQuote, setLeadStatus, leadEvent, messageLead } from '../modules/m3_crm/service.ts';
import { FIRST, LAST } from './names.ts';
import type { SeedCtx } from './seed.ts';
import { log } from './seed.ts';

/** Phase 6 seed (§8): ~400 leads over the trailing 90 days with
 * funnel-realistic conversion; tours, quotes, cadence tasks (some overdue);
 * campaigns; call logs with fixture transcripts (feeds ELI in M17);
 * Alicia Nguyen mid-funnel cast. */

const TRANSCRIPTS = [
  `Agent: Thanks for calling {prop}, this is {agent}. Caller: Hi, I saw your two bedroom online — is it still available? Agent: It is! When are you hoping to move? Caller: Around the first of next month. Agent: Perfect, want to come see it Thursday? Caller: Thursday works, morning if possible. Agent: 10am it is. Can I grab your email for the confirmation? Caller: Sure, it's on the listing inquiry I sent. Agent: Got it — see you Thursday!`,
  `Agent: {prop}, this is {agent}. Caller: Hey, my rent felt higher this month? Agent: Let me look — I see a utility charge added alongside rent, that's the quarterly water true-up. Caller: Ohh, okay. Can I get the breakdown? Agent: Absolutely, I'll email the statement now. Anything else? Caller: No, that's it, thanks.`,
  `Agent: Leasing office. Caller: Do you take large dogs? I have a 70 pound lab. Agent: We welcome pets with a weight limit of 80 pounds, two pet max, with pet rent. Caller: Great. What's parking like? Agent: Assigned stalls, garages available too. Want me to send the full pet and parking policy? Caller: Yes please.`,
  `Agent: {prop}. Caller: I toured Saturday — I want to apply but had a question on the deposit. Agent: Sure — standard deposit is one month, or there's a deposit alternative program for a small monthly fee. Caller: Oh interesting, send me that info? Agent: Sending now, and your quote is still valid through next week.`,
  `Agent: {prop}, {agent} speaking. Caller: My upstairs neighbor's washer leaked into my bathroom ceiling. Agent: I'm sorry — is water actively coming in? Caller: It stopped, but there's a stain. Agent: I'm creating a work order right now and flagging the unit above. We'll have someone out today.`,
];

export function seedCrm(s: SeedCtx): void {
  const t0 = Date.now();
  const props = q<any>('SELECT * FROM properties WHERE org_id=? ORDER BY created_at', s.orgId);
  const agents = q<any>(
    `SELECT u.id, u.name FROM users u JOIN role_assignments ra ON ra.user_id=u.id WHERE u.org_id=? AND ra.role='LEASING_AGENT'`,
    s.orgId,
  );
  const rng = s.rng.fork(660);
  let count = 0;

  // campaigns (source spend)
  const spend: [string, number][] = [
    ['zillow', 120000], ['apartments_com', 95000], ['google', 80000], ['facebook', 45000], ['craigslist', 0], ['referral', 25000],
  ];
  for (const [source, cost] of spend) {
    insert('campaigns', { id: id('cmp'), org_id: s.orgId, property_id: null, source, monthly_cost_cents: cost, active: 1, created_at: nowIso() });
  }

  // ~400 leads trailing 90 days
  for (let i = 0; i < 400; i++) {
    const prop = rng.weighted([[props[0], 45], [props[1], 40], [props[2], 15]] as const);
    if (!prop) continue;
    const daysAgo = rng.int(0, 90);
    const created = addDays(s.businessDate, -daysAgo);
    const ctx = sysCtx(s.orgId, created);
    const first = rng.pick(FIRST);
    const last = rng.pick(LAST);
    const source = rng.weighted([['zillow', 26], ['apartments_com', 22], ['google', 14], ['facebook', 11], ['craigslist', 7], ['website', 8], ['walk_in', 4], ['phone', 5], ['referral', 3]] as const);
    const fp = q1<any>('SELECT * FROM floorplans WHERE property_id=? ORDER BY RANDOM() LIMIT 1', prop.id);
    const { leadId } = intakeLead(ctx, {
      propertyId: prop.id, firstName: first, lastName: last,
      email: `${first}.${last}${rng.int(1, 999)}@inbox.demo`.toLowerCase(),
      phone: rng.chance(0.75) ? `(555) ${rng.int(200, 989)}-${rng.int(1000, 9999)}` : null,
      source, channel: source === 'phone' ? 'phone' : 'email',
      desiredMoveIn: addDays(created, rng.int(14, 70)), beds: fp?.beds ?? rng.int(0, 3),
      budgetCents: fp ? Math.round((fp.market_rent_cents * (0.9 + rng.next() * 0.3)) / 5000) * 5000 : null,
      message: 'Interested — what is availability and pricing?',
    });
    count++;
    const agent = agents.length ? rng.pick(agents) : null;
    if (agent && rng.chance(0.8)) run('UPDATE leads SET assigned_to_user_id=? WHERE id=?', agent.id, leadId);

    // funnel destiny by age
    const destiny = rng.weighted([
      ['stale', daysAgo > 30 ? 40 : 8], ['contacted', 18], ['toured', 14], ['quoted', 10], ['applied', daysAgo > 10 ? 9 : 3], ['leased', daysAgo > 20 ? 9 : 1], ['lost', 12],
    ] as const);

    const touch = (d: number): ReturnType<typeof sysCtx> => sysCtx(s.orgId, addDays(created, Math.min(d, daysAgo)));
    try {
      if (destiny !== 'stale') {
        const respondDay = rng.chance(0.7) ? 0 : 1;
        messageLead(touch(respondDay), leadId, 'email', `Re: your inquiry`, `Hi ${first}! Thanks for reaching out — happy to help. Want to come take a look this week?`);
      }
      if (['toured', 'quoted', 'applied', 'leased'].includes(destiny)) {
        const tourDay = Math.min(rng.int(1, 5), daysAgo);
        const tourId = bookTour(touch(tourDay), {
          leadId, date: addDays(created, tourDay), startTime: rng.pick(['10:00', '11:30', '14:00', '15:30', '16:30'] as const),
          type: rng.weighted([['in_person', 70], ['self_guided', 20], ['virtual', 10]] as const),
          agentUserId: agent?.id, skipConfirmation: true,
        });
        if (addDays(created, tourDay) <= s.businessDate) {
          completeTour(touch(tourDay), tourId, rng.chance(0.88) ? 'completed' : 'no_show');
        }
      }
      if (['quoted', 'applied', 'leased'].includes(destiny)) {
        const unit = q1<any>(`SELECT * FROM units WHERE property_id=? AND status='vacant_ready' LIMIT 1`, prop.id)
          || q1<any>(`SELECT * FROM units WHERE property_id=? LIMIT 1`, prop.id);
        if (unit) {
          buildQuote(touch(rng.int(2, 6)), { leadId, unitId: unit.id, termMonths: rng.pick([12, 12, 9, 15] as const), moveIn: addDays(created, rng.int(20, 50)) });
        }
      }
      if (destiny === 'applied') setLeadStatus(touch(rng.int(4, 9)), leadId, 'applied');
      if (destiny === 'leased') setLeadStatus(touch(rng.int(8, 20)), leadId, 'leased');
      if (destiny === 'lost') setLeadStatus(touch(rng.int(3, 15)), leadId, 'lost', rng.pick(['went with another community', 'budget', 'timing changed', 'no response'] as const));
    } catch {
      /* seed resilience: slot clashes etc are fine */
    }
  }

  // Alicia Nguyen — mid-funnel cast (Foundry, toured, quote sent, follow-up due)
  const foundry = props.find((p) => p.slug === 'foundry-lofts') || props[1];
  const aliciaCtx = sysCtx(s.orgId, addDays(s.businessDate, -6));
  const alicia = intakeLead(aliciaCtx, {
    propertyId: foundry.id, firstName: 'Alicia', lastName: 'Nguyen', email: 'alicia.nguyen@inbox.demo',
    phone: '(555) 301-8890', source: 'zillow', desiredMoveIn: addDays(s.businessDate, 24), beds: 1,
    budgetCents: 215000, message: 'Hi! Interested in the L-1D — do any have the skyline view? Hoping to move next month.',
  });
  const agent = agents[0];
  if (agent) run('UPDATE leads SET assigned_to_user_id=? WHERE id=?', agent.id, alicia.leadId);
  messageLead(sysCtx(s.orgId, addDays(s.businessDate, -6)), alicia.leadId, 'email', 'Skyline views at The Foundry', 'Hi Alicia! Yes — two L-1D homes with skyline views are available. Want to see them this week?');
  const aliciaTour = bookTour(sysCtx(s.orgId, addDays(s.businessDate, -4)), {
    leadId: alicia.leadId, date: addDays(s.businessDate, -3), startTime: '15:30', type: 'in_person', agentUserId: agent?.id, skipConfirmation: true,
  });
  completeTour(sysCtx(s.orgId, addDays(s.businessDate, -3)), aliciaTour, 'completed', 'Loved the 5th floor unit; comparing with one other community.');
  const aliciaUnit = q1<any>(`SELECT * FROM units WHERE property_id=? AND status='vacant_ready' ORDER BY market_rent_cents DESC LIMIT 1`, foundry.id);
  if (aliciaUnit) {
    buildQuote(sysCtx(s.orgId, addDays(s.businessDate, -2)), {
      leadId: alicia.leadId, unitId: aliciaUnit.id, termMonths: 12, moveIn: addDays(s.businessDate, 24),
      concessionNote: '6 weeks free parking with a 12-month term',
    });
  }
  insert('followup_tasks', {
    id: id('fut'), org_id: s.orgId, property_id: foundry.id, lead_id: alicia.leadId,
    kind: 'custom', due_date: s.businessDate, status: 'open', assigned_to_user_id: agent?.id || null, created_at: nowIso(),
  });
  s.demoLogins.push(['(Prospect cast)', 'alicia.nguyen@inbox.demo', 'mid-funnel at Foundry — no login, see /leads']);

  // call logs with transcripts (M17 fixture corpus)
  const agentNames = agents.map((a) => a.name);
  for (let i = 0; i < 40; i++) {
    const prop = rng.pick(props);
    const lead = rng.chance(0.6) ? q1<any>(`SELECT id, phone FROM leads WHERE property_id=? ORDER BY RANDOM() LIMIT 1`, prop.id) : null;
    insert('call_logs', {
      id: id('cal'), org_id: s.orgId, property_id: prop.id, lead_id: lead?.id || null,
      direction: rng.chance(0.8) ? 'inbound' : 'outbound', from_number: lead?.phone || `(555) ${rng.int(200, 989)}-${rng.int(1000, 9999)}`,
      duration_seconds: rng.int(45, 480), outcome: rng.weighted([['answered', 80], ['voicemail', 15], ['missed', 5]] as const),
      transcript: rng.pick(TRANSCRIPTS).replaceAll('{prop}', prop.name).replaceAll('{agent}', agentNames.length ? rng.pick(agentNames as unknown as readonly string[]) : 'Caleb'),
      handled_by: agentNames.length ? rng.pick(agentNames as unknown as readonly string[]) : null,
      at: nowIso(), business_date: addDays(s.businessDate, -rng.int(0, 60)),
    });
  }

  const totals = {
    leads: val<number>('SELECT COUNT(*) FROM leads WHERE org_id=?', s.orgId),
    tours: val<number>('SELECT COUNT(*) FROM tours WHERE org_id=?', s.orgId),
    quotes: val<number>('SELECT COUNT(*) FROM quotes WHERE org_id=?', s.orgId),
    calls: val<number>('SELECT COUNT(*) FROM call_logs WHERE org_id=?', s.orgId),
  };
  log(`crm: ${totals.leads} leads, ${totals.tours} tours, ${totals.quotes} quotes, ${totals.calls} calls (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
