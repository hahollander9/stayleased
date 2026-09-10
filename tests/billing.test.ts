import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { db, q1, val, insert, run } from '../src/lib/db.ts';
import { id } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/dates.ts';
import { sysCtx, type Ctx } from '../src/lib/auth.ts';
import { expandPerms } from '../src/lib/rbac.ts';

/** What the OPERATOR pays StayLeased.
 *
 * Everything else in this suite is money a resident owes an operator. This is
 * the first place the company charges anyone, so the tests are weighted towards
 * the two ways a billing integration hurts somebody:
 *
 *   · **The webhook is an unauthenticated write.** Stripe has no session, so
 *     the signature is the only thing standing between a public URL and
 *     "this invoice is paid". Forged, replayed, malformed and unsigned
 *     deliveries all have to be refused, and refused for the right reason.
 *   · **A retried delivery must not be applied twice.** Stripe re-sends
 *     anything it does not get a 2xx for, and re-sends some events unprompted.
 *
 * The meter gets the same attention for a different reason: it is the number on
 * the invoice, and the product's whole argument is that its numbers can be
 * checked. A total nobody can reproduce from their own property list is the one
 * figure in this application asking to be taken on faith.
 *
 * The signing secret is set BEFORE the module loads, because it is read once at
 * import — which is itself the behavior worth pinning: a deployment cannot
 * acquire a webhook secret halfway through its life. */
process.env.STAYLEASED_STRIPE_WEBHOOK_SECRET = 'whsec_test_secret_for_this_suite';
const { verifyStripeSignature, stripeWebhookConfigured, stripeMode } = await import('../src/lib/stripe.ts');
const { billingAccount, meter, quote, applyStripeEvent, invoices, drift } = await import('../src/modules/m20_billing/service.ts');

const SECRET = 'whsec_test_secret_for_this_suite';
let org: string;
let ctx: Ctx;

/** Sign a payload the way Stripe does, so the verifier is tested against the
 * real scheme rather than against a mock of itself. */
function sign(payload: string, at = Math.floor(Date.now() / 1000), secret = SECRET): string {
  const v1 = createHmac('sha256', secret).update(`${at}.${payload}`).digest('hex');
  return `t=${at},v1=${v1}`;
}

before(() => {
  db();
  org = id('org');
  insert('orgs', { id: org, name: 'Bill Co', slug: 'bill-' + org.slice(-6), business_date: '2026-09-10', kind: 'live', created_at: nowIso() });
  const mkProp = (name: string, units: number): string => {
    const p = id('prp');
    insert('properties', {
      id: p, org_id: org, name, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${p.slice(-5)}`, type: 'residential',
      address1: '1 Main', city: 'Madison', state: 'WI', zip: '53703', timezone: 'America/Chicago', created_at: nowIso(),
    });
    for (let i = 0; i < units; i++) {
      insert('units', {
        id: id('unt'), org_id: org, property_id: p, unit_number: `${name[0]}${i + 1}`, floor: 1, sqft: 700,
        // deliberately mixed: the meter must not care
        status: i % 3 === 0 ? 'vacant_ready' : 'occupied',
        market_rent_cents: 150000, amenities: '[]', created_at: nowIso(),
      });
    }
    return p;
  };
  mkProp('Orchard East', 12);
  mkProp('Station Yards', 7);
  ctx = sysCtx(org, '2026-09-10');
});

// ---------- the meter ----------

test('the meter counts every unit, vacant or occupied, and shows the buildings that make the number', () => {
  const m = meter(ctx);
  assert.equal(m.units, 19, 'every unit under management');
  assert.equal(m.lines.length, 2, 'one line per property');
  assert.equal(m.lines.reduce((s, l) => s + l.units, 0), m.units,
    'the total is the sum of what is shown — an operator can add up the page and land on the invoice');
  assert.deepEqual(m.lines.map((l) => l.property), ['Orchard East', 'Station Yards'], 'ordered by name, stable to read');

  // Occupancy must not move the bill: billing only on occupied units would drop
  // the price exactly when a vacancy makes the software most useful.
  const occupied = val<number>(`SELECT COUNT(*) FROM units WHERE org_id=? AND status='occupied'`, org) || 0;
  assert.notEqual(occupied, m.units, 'the fixture has vacants, so this is a real distinction');
});

test('the meter is org-wide and never reaches another company', () => {
  const other = id('org');
  insert('orgs', { id: other, name: 'Other Co', slug: 'oth-' + other.slice(-6), business_date: '2026-09-10', kind: 'live', created_at: nowIso() });
  const p = id('prp');
  insert('properties', {
    id: p, org_id: other, name: 'Not Ours', slug: 'notours-' + p.slice(-5), type: 'residential',
    address1: '9 Elsewhere', city: 'Madison', state: 'WI', zip: '53703', timezone: 'America/Chicago', created_at: nowIso(),
  });
  insert('units', { id: id('unt'), org_id: other, property_id: p, unit_number: 'X1', floor: 1, sqft: 700, status: 'occupied', market_rent_cents: 100000, amenities: '[]', created_at: nowIso() });
  assert.equal(meter(ctx).units, 19, 'another org’s units are not on this bill');
});

test('the quote is the multiplication, and says so in words the page prints', () => {
  const a = billingAccount(ctx);
  const qt = quote(a, 19);
  assert.equal(qt.unitPriceCents, 600, '$6.00 per unit is the configured default');
  assert.equal(qt.subtotalCents, 19 * 600);
  assert.equal(qt.totalCents, 11400);
  assert.equal(qt.minimumApplied, false);
  assert.match(qt.arithmetic, /19 units × \$6\.00 = \$114\.00/, 'the working, not just the result');
});

test('a monthly minimum raises a small portfolio and is disclosed as the reason', () => {
  const a = { ...billingAccount(ctx), minimum_cents: 9900 };
  const small = quote(a, 5);
  assert.equal(small.subtotalCents, 3000);
  assert.equal(small.totalCents, 9900, 'the floor, not the unit count, set the price');
  assert.equal(small.minimumApplied, true, 'and the page can say which');

  const big = quote(a, 40);
  assert.equal(big.totalCents, 24000, 'above the floor the minimum is irrelevant');
  assert.equal(big.minimumApplied, false);
});

// ---------- early access ----------

test('a new organization is in early access, is not billed, and has nothing at Stripe', () => {
  const a = billingAccount(ctx);
  assert.equal(a.status, 'early_access', 'the promise already made to early partners is the default');
  assert.equal(a.stripe_customer_id, null, 'no customer record exists for an org nobody bills');
  assert.equal(a.stripe_subscription_id, null);
  assert.equal(invoices(ctx).length, 0);
  assert.equal(drift(a, 19), 0, 'drift is meaningless while nothing is being billed');
});

test('the account is created once, not once per read', () => {
  const first = billingAccount(ctx);
  const second = billingAccount(ctx);
  assert.equal(first.id, second.id);
  assert.equal(val<number>('SELECT COUNT(*) FROM billing_accounts WHERE org_id=?', org), 1);
});

test('billing is an owner’s permission, not a manager’s', () => {
  assert.ok(expandPerms(['ORG_ADMIN']).has('admin:billing'), 'the org admin can see the bill');
  for (const role of ['PROPERTY_MANAGER', 'ASSISTANT_MANAGER', 'LEASING_AGENT'] as const) {
    const p = expandPerms([role]);
    if (p.size) assert.ok(!p.has('admin:billing'), `${role} cannot see or change the company's own bill`);
  }
});

// ---------- the webhook is an unauthenticated write ----------

test('a genuine Stripe delivery verifies', () => {
  assert.ok(stripeWebhookConfigured(), 'the suite configured a signing secret');
  const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' });
  assert.deepEqual(verifyStripeSignature(body, sign(body)), { ok: true });
});

test('a forged delivery is refused — the signature is the only authentication this endpoint has', () => {
  const body = JSON.stringify({ id: 'evt_forged', type: 'invoice.paid' });
  const wrong = verifyStripeSignature(body, sign(body, undefined, 'whsec_attacker_guess'));
  assert.equal(wrong.ok, false);
  assert.match(wrong.ok === false ? wrong.reason : '', /did not match/);

  // A body altered after signing must fail too: the HMAC covers the payload,
  // which is why the route verifies the raw bytes and not the parsed object.
  const tampered = verifyStripeSignature(JSON.stringify({ id: 'evt_forged', type: 'invoice.paid', total: 1 }), sign(body));
  assert.equal(tampered.ok, false);
});

test('a captured delivery cannot be replayed forever', () => {
  const body = JSON.stringify({ id: 'evt_old', type: 'invoice.paid' });
  const old = Math.floor(Date.now() / 1000) - 3600;
  const r = verifyStripeSignature(body, sign(body, old));
  assert.equal(r.ok, false, 'a valid signature stays valid; the timestamp is what expires');
  assert.match(r.ok === false ? r.reason : '', /replay window/);
});

test('a malformed or absent signature is refused rather than waved through', () => {
  const body = '{}';
  for (const header of ['', 'garbage', 't=123', 'v1=abc', 't=,v1=']) {
    const r = verifyStripeSignature(body, header);
    assert.equal(r.ok, false, `refused: ${JSON.stringify(header)}`);
  }
});

test('several signatures are accepted during a secret rotation, as Stripe sends them', () => {
  const body = JSON.stringify({ id: 'evt_rot', type: 'invoice.paid' });
  const at = Math.floor(Date.now() / 1000);
  const good = createHmac('sha256', SECRET).update(`${at}.${body}`).digest('hex');
  assert.deepEqual(verifyStripeSignature(body, `t=${at},v1=deadbeef,v1=${good}`), { ok: true });
});

// ---------- applying events exactly once ----------

function evt(id0: string, type: string, object: Record<string, unknown>): { id: string; type: string; data: { object: Record<string, unknown> } } {
  return { id: id0, type, data: { object } };
}

test('a subscription event moves the account onto a plan and records what Stripe is billing', () => {
  const a = billingAccount(ctx);
  run('UPDATE billing_accounts SET stripe_customer_id=? WHERE id=?', 'cus_test_1', a.id);
  const period = Math.floor(Date.parse('2026-09-01T00:00:00Z') / 1000);

  applyStripeEvent(evt('evt_sub_1', 'customer.subscription.updated', {
    id: 'sub_test_1', customer: 'cus_test_1', status: 'active',
    current_period_start: period, current_period_end: period + 30 * 86400,
    items: { data: [{ quantity: 19, price: { id: 'price_1' } }] },
  }));

  const after = billingAccount(ctx);
  assert.equal(after.status, 'active');
  assert.equal(after.stripe_subscription_id, 'sub_test_1');
  assert.equal(after.billed_units, 19, 'what Stripe is charging for, recorded so drift is visible rather than assumed');
  assert.equal(String(after.current_period_end).slice(0, 10), '2026-10-01');
});

test('the same delivery twice changes nothing the second time', () => {
  const before0 = billingAccount(ctx);
  const note = applyStripeEvent(evt('evt_sub_1', 'customer.subscription.updated', {
    id: 'sub_test_1', customer: 'cus_test_1', status: 'canceled',
    items: { data: [{ quantity: 999, price: { id: 'price_1' } }] },
  }));
  assert.match(note, /Already handled/);
  const after = billingAccount(ctx);
  assert.equal(after.status, before0.status, 'a replay of a handled event cannot cancel a live subscription');
  assert.equal(after.billed_units, before0.billed_units);
});

test('drift between the meter and what Stripe bills is reported, not silently reconciled', () => {
  const a = billingAccount(ctx);
  assert.equal(drift(a, 19), 0);
  assert.equal(drift(a, 24), 5, 'five units added since the last sync');
  assert.equal(drift(a, 15), -4, 'and it reads in both directions');
});

test('a failed payment marks the account past due; paying clears it', () => {
  applyStripeEvent(evt('evt_inv_fail', 'invoice.payment_failed', {
    id: 'in_test_1', customer: 'cus_test_1', status: 'open', total: 11400, subtotal: 11400,
    created: Math.floor(Date.now() / 1000),
    lines: { data: [{ quantity: 19, price: { unit_amount: 600 } }] },
  }));
  assert.equal(billingAccount(ctx).status, 'past_due');

  applyStripeEvent(evt('evt_inv_paid', 'invoice.paid', {
    id: 'in_test_1', customer: 'cus_test_1', status: 'paid', total: 11400, subtotal: 11400,
    amount_paid: 11400, created: Math.floor(Date.now() / 1000),
    status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
    lines: { data: [{ quantity: 19, price: { unit_amount: 600 } }] },
  }));
  assert.equal(billingAccount(ctx).status, 'active', 'paying the outstanding invoice restores the plan');
});

test('an invoice seen twice is one row, updated — not two rows telling different stories', () => {
  const rows = invoices(ctx);
  assert.equal(rows.length, 1, 'the failed and the paid delivery are the same invoice');
  assert.equal(rows[0]!.status, 'paid', 'and it holds the latest state');
  assert.equal(rows[0]!.total_cents, 11400);
  assert.equal(rows[0]!.units, 19, 'the unit count is kept on the invoice, so a past bill can be checked later');
  assert.equal(val<number>('SELECT COUNT(*) FROM billing_invoices WHERE stripe_invoice_id=?', 'in_test_1'), 1);
});

test('an event for a customer we do not know is recorded and changes nothing', () => {
  const note = applyStripeEvent(evt('evt_stranger', 'customer.subscription.updated', {
    id: 'sub_x', customer: 'cus_not_ours', status: 'canceled', items: { data: [] },
  }));
  assert.match(note, /No matching organization/);
  assert.equal(billingAccount(ctx).status, 'active', 'a stranger’s event cannot cancel this org’s plan');
  const row = q1<{ handled: number }>('SELECT handled FROM billing_events WHERE id=?', 'evt_stranger');
  assert.equal(row?.handled, 0, 'kept, marked unhandled, so it can be looked at rather than lost');
});

test('a Stripe status this app has no meaning for leaves the account where it is', () => {
  const before0 = billingAccount(ctx).status;
  applyStripeEvent(evt('evt_incomplete', 'customer.subscription.updated', {
    id: 'sub_test_1', customer: 'cus_test_1', status: 'incomplete',
    items: { data: [{ quantity: 19, price: { id: 'price_1' } }] },
  }));
  assert.equal(billingAccount(ctx).status, before0,
    'an unmapped status is not a transition to invent — the account keeps the state it had');
});

test('with no secret key configured, the integration reports itself off rather than half-working', () => {
  // The suite never sets STRIPE_SECRET_KEY, only the webhook secret.
  assert.equal(stripeMode(), 'off');
});
