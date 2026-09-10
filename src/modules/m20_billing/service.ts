import { q, q1, val, insert, run, j, js } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso } from '../../lib/dates.ts';
import { usd } from '../../lib/money.ts';
import { env } from '../../lib/env.ts';
import { audit } from '../../lib/audit.ts';
import type { Ctx } from '../../lib/auth.ts';
import { stripeCall, stripeConfigured, type StripeError } from '../../lib/stripe.ts';

/** What the operator pays StayLeased.
 *
 * Everything else in this codebase is money a RESIDENT owes an operator. This
 * is the other direction, and it is the first place the company charges anyone,
 * so two rules shape the whole module.
 *
 * **The bill shows its arithmetic.** This product's argument is that you can
 * check its work — the import pipeline ties to the source report's own summary
 * page, every agent action carries its rationale. A bill that says "$282.00"
 * and nothing else asks for exactly the trust the rest of the product refuses
 * to ask for. So the meter is enumerable: the unit count comes with the
 * per-property breakdown that produces it, and the total is shown as the
 * multiplication rather than the result.
 *
 * **Early access means not billed, and that is the default.** Existing partners
 * were promised a free platform. A billing page that quietly began charging
 * them would break that promise on a deploy, so `early_access` is the status
 * every account starts in, no Stripe customer exists for such an org, and
 * moving one onto a paid plan is a deliberate, audited act. */

/** The list price for a NEW account. Existing accounts keep the price stored on
 * their own row — see the schema comment. Configurable so a change does not
 * need a deploy, but never read at render time for an account that exists. */
const DEFAULT_UNIT_PRICE_CENTS = Math.max(0, parseInt(env('BILLING_UNIT_PRICE_CENTS') || '600', 10) || 600);
const DEFAULT_MINIMUM_CENTS = Math.max(0, parseInt(env('BILLING_MINIMUM_CENTS') || '0', 10) || 0);

export type BillingStatus = 'early_access' | 'active' | 'past_due' | 'canceled';

export interface BillingAccount {
  id: string;
  org_id: string;
  status: BillingStatus;
  unit_price_cents: number;
  minimum_cents: number;
  currency: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  billed_units: number;
  cancel_at_period_end: number;
  created_at: string;
  updated_at: string;
}

/** The org's account, created on first read.
 *
 * Created rather than returned-null because every org has a billing position
 * whether or not anyone has looked at it, and the position of an org nobody has
 * touched is "early access, not billed" — which is a fact worth having a row
 * for rather than an absence to be interpreted later. */
export function billingAccount(ctx: Ctx): BillingAccount {
  const found = q1<BillingAccount>('SELECT * FROM billing_accounts WHERE org_id=?', ctx.orgId);
  if (found) return found;
  const row: BillingAccount = {
    id: id('bac'), org_id: ctx.orgId, status: 'early_access',
    unit_price_cents: DEFAULT_UNIT_PRICE_CENTS, minimum_cents: DEFAULT_MINIMUM_CENTS, currency: 'usd',
    stripe_customer_id: null, stripe_subscription_id: null, stripe_price_id: null,
    current_period_start: null, current_period_end: null,
    billed_units: 0, cancel_at_period_end: 0,
    created_at: nowIso(), updated_at: nowIso(),
  };
  insert('billing_accounts', row as unknown as Record<string, unknown>);
  return row;
}

// ---------------------------------------------------------------- the meter --

export interface MeterLine { propertyId: string; property: string; units: number }

export interface Meter {
  units: number;
  lines: MeterLine[];
  /** what the count deliberately leaves out, stated rather than assumed */
  excluded: { label: string; units: number }[];
}

/** Every unit under management, by property.
 *
 * Every unit, not every OCCUPIED unit: a vacant unit is one the software is
 * still doing work for — listing it, pricing it, turning it — and billing only
 * on occupancy would mean the bill falls exactly when the operator needs the
 * product most. It is also the number an operator can check against their own
 * property list without knowing anything about how we count.
 *
 * The breakdown is the point. `units` alone is a number to be trusted; `lines`
 * is a number to be checked, and this product's whole argument is the second
 * one. */
export function meter(ctx: Ctx): Meter {
  const lines = q<MeterLine>(
    `SELECT p.id AS propertyId, p.name AS property, COUNT(u.id) AS units
       FROM properties p LEFT JOIN units u ON u.property_id=p.id AND u.org_id=p.org_id
      WHERE p.org_id=? GROUP BY p.id ORDER BY p.name`,
    ctx.orgId,
  );
  // Deliberately org-wide rather than filtered to the reader's properties: the
  // bill is for the whole company, and a regional manager seeing a smaller
  // total than the invoice would be a discrepancy, not a permission.
  return {
    units: lines.reduce((s, l) => s + l.units, 0),
    lines,
    excluded: [],
  };
}

export interface Quote {
  units: number;
  unitPriceCents: number;
  subtotalCents: number;
  minimumCents: number;
  /** true when the minimum, not the unit count, set the price */
  minimumApplied: boolean;
  totalCents: number;
  /** the multiplication, in words, for the page to print verbatim */
  arithmetic: string;
}

export function quote(account: BillingAccount, units: number): Quote {
  const subtotal = units * account.unit_price_cents;
  const minimumApplied = account.minimum_cents > 0 && subtotal < account.minimum_cents;
  const total = minimumApplied ? account.minimum_cents : subtotal;
  return {
    units,
    unitPriceCents: account.unit_price_cents,
    subtotalCents: subtotal,
    minimumCents: account.minimum_cents,
    minimumApplied,
    totalCents: total,
    arithmetic: `${units} unit${units === 1 ? '' : 's'} × ${usd(account.unit_price_cents)} = ${usd(subtotal)}`,
  };
}

// ------------------------------------------------------------- invoices ------

export interface BillingInvoice {
  id: string;
  stripe_invoice_id: string | null;
  number: string | null;
  status: string;
  period_start: string | null;
  period_end: string | null;
  units: number | null;
  unit_price_cents: number | null;
  subtotal_cents: number;
  total_cents: number;
  amount_paid_cents: number;
  currency: string;
  hosted_url: string | null;
  pdf_url: string | null;
  issued_at: string | null;
  paid_at: string | null;
}

export function invoices(ctx: Ctx, limit = 24): BillingInvoice[] {
  return q<BillingInvoice>(
    `SELECT * FROM billing_invoices WHERE org_id=? ORDER BY COALESCE(issued_at, created_at) DESC LIMIT ?`,
    ctx.orgId, limit,
  );
}

// ------------------------------------------------------------ Stripe side ----

function touch(accountId: string, patch: Record<string, unknown>): void {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  run(
    `UPDATE billing_accounts SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`,
    ...keys.map((k) => patch[k] as never), nowIso(), accountId,
  );
}

/** The org's Stripe customer, created once.
 *
 * The id is stored on our row the moment Stripe returns it, and the create call
 * is idempotency-keyed on the org, so a retry after a timeout cannot leave the
 * company paying for two customers that both think they are this org. */
export async function ensureCustomer(ctx: Ctx, account: BillingAccount): Promise<string> {
  if (account.stripe_customer_id) return account.stripe_customer_id;
  const org = q1<{ name: string }>('SELECT name FROM orgs WHERE id=?', ctx.orgId);
  const created = await stripeCall<{ id: string }>('POST', '/v1/customers', {
    name: org?.name || ctx.orgId,
    email: ctx.userEmail,
    metadata: { stayleased_org_id: ctx.orgId },
  }, { idempotencyKey: `cust:${ctx.orgId}` });
  touch(account.id, { stripe_customer_id: created.id });
  audit(ctx, 'billing', account.id, 'stripe_customer_create', null, { customer: created.id });
  return created.id;
}

/** A Checkout session to start a subscription.
 *
 * Checkout rather than a card form: the operator lands on a page hosted by
 * Stripe, and no card number, CVC or expiry ever passes through this server or
 * appears in a log. That single decision is what keeps this application out of
 * PCI scope, and it is why the subscription is created BY Checkout rather than
 * by us calling /v1/subscriptions with a payment method we hold. */
export async function checkoutUrl(ctx: Ctx, account: BillingAccount, units: number, origin: string): Promise<string> {
  const customer = await ensureCustomer(ctx, account);
  const session = await stripeCall<{ url: string }>('POST', '/v1/checkout/sessions', {
    mode: 'subscription',
    customer,
    line_items: [{
      quantity: units,
      price_data: {
        currency: account.currency,
        unit_amount: account.unit_price_cents,
        product_data: { name: 'StayLeased — per unit, per month' },
        recurring: { interval: 'month' },
      },
    }],
    subscription_data: { metadata: { stayleased_org_id: ctx.orgId } },
    // Where Stripe sends them back. Both land on the billing page: one with a
    // flash saying it worked, one saying nothing was charged.
    success_url: `${origin}/admin/billing?started=1`,
    cancel_url: `${origin}/admin/billing?canceled=1`,
  }, { idempotencyKey: `checkout:${ctx.orgId}:${units}:${account.unit_price_cents}` });
  audit(ctx, 'billing', account.id, 'checkout_start', null, { units, unit_price_cents: account.unit_price_cents });
  return session.url;
}

/** The Stripe Billing Portal: change a card, read past invoices, cancel.
 *
 * Deliberately not rebuilt in this app. Every one of those screens would
 * otherwise handle a payment method, and Stripe's versions are already correct,
 * localized, and PCI-compliant. */
export async function portalUrl(ctx: Ctx, account: BillingAccount, origin: string): Promise<string> {
  if (!account.stripe_customer_id) throw new Error('This organization has no Stripe customer yet.');
  const session = await stripeCall<{ url: string }>('POST', '/v1/billing_portal/sessions', {
    customer: account.stripe_customer_id,
    return_url: `${origin}/admin/billing`,
  });
  return session.url;
}

/** Push the current unit count to Stripe.
 *
 * The meter moves when a property is imported or a unit is added, and Stripe
 * bills whatever quantity it last heard. Left alone the two drift apart
 * silently and the customer is billed for a portfolio they no longer have —
 * in either direction. `billed_units` records what was last SENT, so the
 * difference is visible on the page rather than inferred. */
export async function syncQuantity(ctx: Ctx, account: BillingAccount, units: number): Promise<void> {
  if (!account.stripe_subscription_id || account.status !== 'active') return;
  const sub = await stripeCall<{ items: { data: { id: string; quantity: number }[] } }>(
    'GET', `/v1/subscriptions/${account.stripe_subscription_id}`,
  );
  const item = sub.items?.data?.[0];
  if (!item) return;
  if (item.quantity === units) {
    touch(account.id, { billed_units: units });
    return;
  }
  await stripeCall('POST', `/v1/subscription_items/${item.id}`, {
    quantity: units,
    // The operator is told the next invoice reflects the change; proration
    // would produce an immediate charge they did not ask for on this page.
    proration_behavior: 'none',
  });
  touch(account.id, { billed_units: units });
  audit(ctx, 'billing', account.id, 'quantity_sync', { units: item.quantity }, { units });
}

// ------------------------------------------------------------- webhooks ------

/** Apply one Stripe event, exactly once.
 *
 * Idempotency is the whole job. Stripe retries any delivery we do not answer
 * with a 2xx, and can send the same event twice unprompted, so the event id is
 * recorded first and a second arrival returns without touching anything. The
 * function is pure of HTTP — it takes a parsed event and returns a note — so
 * every branch is testable without a webhook. */
export function applyStripeEvent(evt: { id: string; type: string; data?: { object?: Record<string, unknown> } }): string {
  const already = q1<{ id: string; handled: number }>('SELECT id, handled FROM billing_events WHERE id=?', evt.id);
  if (already) return 'Already handled.';

  const obj = (evt.data?.object || {}) as Record<string, unknown>;
  const customer = typeof obj.customer === 'string' ? obj.customer : null;
  const metaOrg = ((obj.metadata as Record<string, unknown>) || {}).stayleased_org_id;
  const account = customer
    ? q1<BillingAccount>('SELECT * FROM billing_accounts WHERE stripe_customer_id=?', customer)
    : typeof metaOrg === 'string'
      ? q1<BillingAccount>('SELECT * FROM billing_accounts WHERE org_id=?', metaOrg)
      : undefined;

  let note = 'No matching organization.';
  if (account) {
    switch (evt.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const status = String(obj.status || '');
        // Stripe's vocabulary is wider than ours; only the states that change
        // what the operator sees are mapped, and anything else leaves the
        // account where it is rather than inventing a transition.
        const mapped: BillingStatus | null =
          status === 'active' || status === 'trialing' ? 'active'
            : status === 'past_due' || status === 'unpaid' ? 'past_due'
              : status === 'canceled' || status === 'incomplete_expired' ? 'canceled'
                : null;
        const items = (obj.items as { data?: { quantity?: number; price?: { id?: string } }[] })?.data || [];
        touch(account.id, {
          ...(mapped ? { status: mapped } : {}),
          stripe_subscription_id: String(obj.id || account.stripe_subscription_id || ''),
          stripe_price_id: items[0]?.price?.id || account.stripe_price_id,
          billed_units: items[0]?.quantity ?? account.billed_units,
          cancel_at_period_end: obj.cancel_at_period_end ? 1 : 0,
          current_period_start: epoch(obj.current_period_start),
          current_period_end: epoch(obj.current_period_end),
        });
        note = `Subscription ${status} → ${mapped || 'unchanged'}.`;
        break;
      }
      case 'customer.subscription.deleted':
        touch(account.id, { status: 'canceled', cancel_at_period_end: 0 });
        note = 'Subscription canceled.';
        break;
      case 'invoice.paid':
      case 'invoice.payment_failed':
      case 'invoice.finalized': {
        upsertInvoice(account.org_id, obj);
        if (evt.type === 'invoice.paid' && account.status === 'past_due') touch(account.id, { status: 'active' });
        if (evt.type === 'invoice.payment_failed') touch(account.id, { status: 'past_due' });
        note = `Invoice ${String(obj.status || evt.type)}.`;
        break;
      }
      default:
        note = 'Recorded, no action.';
    }
  }

  insert('billing_events', {
    id: evt.id, org_id: account?.org_id || null, type: evt.type,
    payload: js(evt).slice(0, 20000), handled: account ? 1 : 0, note,
    received_at: nowIso(),
  });
  return note;
}

function epoch(v: unknown): string | null {
  const n = typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? new Date(n * 1000).toISOString() : null;
}

function upsertInvoice(orgId: string, obj: Record<string, unknown>): void {
  const sid = String(obj.id || '');
  if (!sid) return;
  const line = ((obj.lines as { data?: { quantity?: number; price?: { unit_amount?: number } }[] })?.data || [])[0];
  const fields = {
    org_id: orgId,
    stripe_invoice_id: sid,
    number: (obj.number as string) || null,
    status: String(obj.status || 'open'),
    period_start: epoch((obj.period_start as number)),
    period_end: epoch((obj.period_end as number)),
    units: line?.quantity ?? null,
    unit_price_cents: line?.price?.unit_amount ?? null,
    subtotal_cents: Number(obj.subtotal || 0),
    total_cents: Number(obj.total || 0),
    amount_paid_cents: Number(obj.amount_paid || 0),
    currency: String(obj.currency || 'usd'),
    hosted_url: (obj.hosted_invoice_url as string) || null,
    pdf_url: (obj.invoice_pdf as string) || null,
    issued_at: epoch((obj.created as number)),
    paid_at: obj.status === 'paid' ? epoch((obj.status_transitions as Record<string, unknown>)?.paid_at) : null,
  };
  const existing = q1<{ id: string }>('SELECT id FROM billing_invoices WHERE stripe_invoice_id=?', sid);
  if (existing) {
    const keys = Object.keys(fields).filter((k) => k !== 'org_id' && k !== 'stripe_invoice_id');
    run(
      `UPDATE billing_invoices SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`,
      ...keys.map((k) => (fields as Record<string, unknown>)[k] as never), existing.id,
    );
  } else {
    insert('billing_invoices', { id: id('binv'), ...fields, created_at: nowIso() });
  }
}

// ------------------------------------------------------------- reporting -----

export function stripeReady(): boolean {
  return stripeConfigured();
}

/** How far this org's Stripe state and our own have drifted. Shown on the page
 * rather than reconciled silently, because a mismatch between what we meter and
 * what Stripe bills is exactly the thing an operator should see first. */
export function drift(account: BillingAccount, units: number): number {
  return account.status === 'active' ? units - account.billed_units : 0;
}
