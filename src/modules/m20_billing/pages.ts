import type { Router } from '../../lib/http.ts';
import { jsonRes, redirect } from '../../lib/http.ts';
import { html, when } from '../../lib/html.ts';
import { usd } from '../../lib/money.ts';
import { fmtDate } from '../../lib/dates.ts';
import { env } from '../../lib/env.ts';
import { log } from '../../lib/log.ts';
import { requirePerm, type Ctx } from '../../lib/auth.ts';
import { shell, card, tbl, statusBadge, dl, emptyState } from '../../ui/ui.ts';
import {
  stripeMode, stripeWebhookConfigured, verifyStripeSignature, StripeError,
} from '../../lib/stripe.ts';
import {
  billingAccount, meter, quote, invoices, drift,
  checkoutUrl, portalUrl, syncQuantity, applyStripeEvent,
  type BillingAccount,
} from './service.ts';

/** The billing page.
 *
 * The design question this page answers is not "how do we show a total" but
 * "why should the operator believe it". Every other number in this product can
 * be checked — the import reconciles to the source report's own summary, each
 * agent action carries its rationale, the ledger balances. A bill that arrives
 * as one figure would be the only number in the application asking to be taken
 * on faith, and it is the one number where being wrong costs the customer money
 * directly.
 *
 * So the page is built as a statement rather than a dashboard: the count, the
 * buildings that produce it, the multiplication, and the result — in that
 * order, so it reads top to bottom as an argument. The per-property table is
 * not a detail view behind a disclosure; it is the evidence, and it is on the
 * page.
 *
 * Two honesty rules it holds to. An early-access org sees its real figure and
 * is told plainly that it is not being charged, because the promise already
 * made to those partners outranks the existence of a billing page. And when
 * Stripe is not configured the page says exactly that, rather than rendering
 * buttons that fail on click. */

const PRICE_NOTE = 'Every unit under management, vacant or occupied — the same count you can take from your own property list.';

function originOf(rq: { url: URL }): string {
  return env('SITE_ORIGIN') || `${rq.url.protocol}//${rq.url.host}`;
}

/** The status line, in the operator's terms rather than Stripe's.
 *
 * The tone is chosen here rather than derived from the status string, because
 * `statusBadge` maps a RECORD's status to a tone and these are not that: a
 * canceled subscription is not an error state to paint red, and early access is
 * not a warning. */
function statusCopy(a: BillingAccount): { tone: string; label: string; line: string } {
  switch (a.status) {
    case 'early_access':
      return {
        tone: 'info', label: 'Early access',
        line: 'You are not being charged. This is what the plan below would come to — nothing is billed, and no payment method is on file.',
      };
    case 'active':
      return {
        tone: 'ok', label: 'Active',
        line: a.cancel_at_period_end
          ? 'Active until the end of the current period, then it ends. Nothing further will be charged.'
          : 'Billed monthly. The next invoice is for the period shown below.',
      };
    case 'past_due':
      return {
        tone: 'bad', label: 'Past due',
        line: 'The last payment did not go through. Your data is untouched and nothing has been suspended — update the payment method and the outstanding invoice will be retried.',
      };
    case 'canceled':
      return {
        tone: '', label: 'Canceled',
        line: 'The subscription has ended. Your records remain yours and remain exportable; start a plan again whenever you want.',
      };
  }
}

export function routes(r: Router): void {
  r.get('/admin/billing', requirePerm('admin:billing'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const account = billingAccount(ctx);
    const m = meter(ctx);
    const qt = quote(account, m.units);
    const st = statusCopy(account);
    const mode = stripeMode();
    const past = invoices(ctx);
    const off = drift(account, m.units);
    const started = rq.query.get('started');
    const canceled = rq.query.get('canceled');

    return shell(rq, {
      title: 'Billing',
      active: '/admin/billing',
      crumbs: [['Setup & administration', '/setup']],
      subtitle: 'What this organization pays for StayLeased, and the count it is based on.',
      content: html`
        ${when(started, () => html`<div class="callout ok">Your plan is active. The first invoice is issued by Stripe and appears below within a minute.</div>`)}
        ${when(canceled, () => html`<div class="callout info">Nothing was charged — you left before completing checkout.</div>`)}

        <!-- The statement. Status, the arithmetic, and what happens next, in
             one block, because they are one thought: this is what you pay, this
             is why, this is when. -->
        <section class="bill">
          <div class="bill-state">
            <span class="badge ${st.tone}">${st.label}</span>
            <p>${st.line}</p>
          </div>

          <div class="bill-sum">
            <div class="bill-calc">
              <span class="bc-n">${m.units}</span>
              <span class="bc-x">${m.units === 1 ? 'unit' : 'units'}</span>
              <span class="bc-op">×</span>
              <span class="bc-n">${usd(qt.unitPriceCents)}</span>
              <span class="bc-x">per month</span>
            </div>
            <div class="bill-total">
              <span class="bt-eq" aria-hidden="true">=</span>
              <span class="bt-amt">${usd(qt.totalCents)}</span>
              <span class="bt-per">per month</span>
            </div>
            ${when(qt.minimumApplied, () => html`
              <p class="bill-note">${usd(qt.subtotalCents)} by the unit count, raised to the ${usd(qt.minimumCents)} monthly minimum.</p>`)}
            ${when(account.status === 'early_access', () => html`
              <p class="bill-note">Not charged while you are in early access.</p>`)}
            ${when(account.current_period_end && account.status === 'active', () => html`
              <p class="bill-note">Current period ends ${fmtDate(String(account.current_period_end).slice(0, 10))}.</p>`)}
          </div>
        </section>

        ${when(off !== 0, () => html`
          <div class="callout warn">
            Stripe is billing for ${account.billed_units} unit${account.billed_units === 1 ? '' : 's'} and this
            portfolio now has ${m.units}. The next invoice will not reflect the difference until the count is sent.
            <form method="post" action="/admin/billing/sync" class="inline-form">
              <button class="btn btn-sm">Send the current count to Stripe</button>
            </form>
          </div>`)}

        <div class="grid cols-2">
          ${card('The count', html`
            <p class="muted small flush-note">${PRICE_NOTE}</p>
            ${tbl(
              [{ label: 'Property' }, { label: 'Units', num: true }],
              m.lines.map((l) => ({
                href: `/properties/${l.propertyId}`,
                cells: [l.property, l.units],
              })),
              {
                empty: 'No properties yet — nothing to bill for.',
                foot: [html`<b>Total</b>`, html`<b>${m.units}</b>`],
              },
            )}`, { flush: true })}

          ${card('Plan', html`
            ${dl([
              ['Price', html`${usd(account.unit_price_cents)} <span class="muted">per unit, per month</span>`],
              ['Minimum', account.minimum_cents ? usd(account.minimum_cents) : html`<span class="muted">None</span>`],
              ['Billing', 'Monthly, in advance'],
              ['Your records', html`Yours. <a href="/reports">Export anything</a>, any time, plan or no plan.`],
            ])}
            ${planActions(account, mode, m.units)}`)}
        </div>

        ${card('Invoices', past.length
          ? tbl(
            [{ label: 'Date' }, { label: 'Number' }, { label: 'Period' }, { label: 'Units', num: true },
              { label: 'Amount', num: true }, { label: 'Status' }, { label: '' }],
            past.map((inv) => ({
              cells: [
                inv.issued_at ? fmtDate(inv.issued_at.slice(0, 10)) : '—',
                inv.number || '—',
                inv.period_start && inv.period_end
                  ? `${fmtDate(inv.period_start.slice(0, 10))} – ${fmtDate(inv.period_end.slice(0, 10))}`
                  : '—',
                inv.units ?? '—',
                usd(inv.total_cents),
                statusBadge(inv.status === 'paid' ? 'paid' : inv.status === 'open' ? 'pending' : inv.status),
                inv.hosted_url
                  ? html`<a class="btn btn-sm btn-ghost" href="${inv.hosted_url}" target="_blank" rel="noopener">View ↗</a>`
                  : html`<span class="muted">—</span>`,
              ],
            })),
            { sort: false },
          )
          : emptyState(
            account.status === 'early_access' ? 'No invoices — you are not being charged' : 'No invoices yet',
            account.status === 'early_access'
              ? 'While you are in early access nothing is billed, so there is nothing here. Invoices appear once a plan starts.'
              : 'The first invoice appears here once the current period closes.',
          ), { flush: past.length > 0 })}
      `,
    });
  });

  /** Start a plan. The operator never sees a card field in this application —
   * they are handed to Stripe's own checkout and come back. */
  r.post('/admin/billing/checkout', requirePerm('admin:billing'), async (rq) => {
    const ctx = rq.ctx as Ctx;
    const account = billingAccount(ctx);
    const units = meter(ctx).units;
    if (!units) return redirect('/admin/billing', 'There are no units to bill for yet — add a property first.', 'err');
    if (stripeMode() === 'off') return redirect('/admin/billing', 'Payments are not configured on this deployment.', 'err');
    try {
      const url = await checkoutUrl(ctx, account, units, originOf(rq));
      return redirect(url);
    } catch (e) {
      log.warn('billing.checkout_failed', { org: ctx.orgId, err: (e as Error).message });
      return redirect('/admin/billing', stripeMessage(e), 'err');
    }
  });

  /** Change a card, read Stripe's own invoice history, cancel. All of it on
   * Stripe's pages, none of it rebuilt here. */
  r.post('/admin/billing/portal', requirePerm('admin:billing'), async (rq) => {
    const ctx = rq.ctx as Ctx;
    const account = billingAccount(ctx);
    if (!account.stripe_customer_id) return redirect('/admin/billing', 'There is no payment account to manage yet.', 'err');
    try {
      return redirect(await portalUrl(ctx, account, originOf(rq)));
    } catch (e) {
      log.warn('billing.portal_failed', { org: ctx.orgId, err: (e as Error).message });
      return redirect('/admin/billing', stripeMessage(e), 'err');
    }
  });

  r.post('/admin/billing/sync', requirePerm('admin:billing'), async (rq) => {
    const ctx = rq.ctx as Ctx;
    const account = billingAccount(ctx);
    const units = meter(ctx).units;
    try {
      await syncQuantity(ctx, account, units);
      return redirect('/admin/billing', `Stripe now bills for ${units} unit${units === 1 ? '' : 's'}. The change appears on the next invoice.`);
    } catch (e) {
      log.warn('billing.sync_failed', { org: ctx.orgId, err: (e as Error).message });
      return redirect('/admin/billing', stripeMessage(e), 'err');
    }
  });

  /** Stripe's callbacks.
   *
   * Unauthenticated by necessity — Stripe has no session — so the signature IS
   * the authentication, and an unverifiable delivery is refused with a 400
   * rather than recorded. Deliberately mounted outside /api/ so the CSRF
   * same-origin check does not apply to it (Stripe is cross-origin by
   * definition) and outside every requirePerm, which is why the verification
   * above it has to be exactly right. */
  r.post('/webhooks/stripe', (rq) => {
    if (!stripeWebhookConfigured()) {
      return jsonRes({ error: 'Webhooks are not configured on this deployment.' }, 503);
    }
    const sig = String((rq.raw.headers['stripe-signature'] as string) || '');
    // The parsed body is not good enough: a signature covers the exact bytes,
    // and JSON.parse + re-serialize changes them.
    const raw0 = rq.rawBody;
    if (!raw0) return jsonRes({ error: 'Expected a JSON body.' }, 400);

    const verified = verifyStripeSignature(raw0, sig);
    if (!verified.ok) {
      log.warn('billing.webhook_rejected', { reason: verified.reason, ip: rq.ip });
      return jsonRes({ error: verified.reason }, 400);
    }

    let evt: { id: string; type: string; data?: { object?: Record<string, unknown> } };
    try {
      evt = JSON.parse(raw0.toString('utf8'));
    } catch {
      return jsonRes({ error: 'Body was not valid JSON.' }, 400);
    }
    if (!evt?.id || !evt?.type) return jsonRes({ error: 'Not a Stripe event.' }, 400);

    try {
      const note = applyStripeEvent(evt);
      // 200 on anything we understood, including a duplicate: a non-2xx makes
      // Stripe retry, and retrying an event we have already applied is exactly
      // what the idempotency check exists to make harmless.
      return jsonRes({ received: true, note });
    } catch (e) {
      log.error('billing.webhook_failed', { id: evt.id, type: evt.type, err: (e as Error).message });
      // 500 so Stripe retries — this one we genuinely failed to apply.
      return jsonRes({ error: 'Could not apply the event.' }, 500);
    }
  });
}

/** Stripe's message reaches the operator; anything else is generalized, because
 * an internal error string is not something to render on an admin page. */
function stripeMessage(e: unknown): string {
  return e instanceof StripeError && e.message
    ? e.message
    : 'Could not reach the payment provider just now. Nothing was charged — try again in a moment.';
}

function planActions(account: BillingAccount, mode: ReturnType<typeof stripeMode>, units: number): ReturnType<typeof html> {
  if (mode === 'off') {
    return html`<div class="callout info">
      Payments are not switched on for this deployment, so there is nothing to pay with yet.
      The figure above is what the plan comes to; set <code>STAYLEASED_STRIPE_SECRET_KEY</code> to enable checkout.
    </div>`;
  }
  return html`
    ${when(mode === 'test', () => html`<div class="callout warn">Stripe is in test mode. Checkout works end to end and no real money moves.</div>`)}
    <div class="toolbar">
      ${account.status === 'active' || account.status === 'past_due'
        ? html`<form method="post" action="/admin/billing/portal">
            <button class="btn">Manage payment and invoices</button>
          </form>`
        : html`<form method="post" action="/admin/billing/checkout">
            <button class="btn btn-primary" ${units ? '' : 'disabled'}>Start the plan — ${usd(account.unit_price_cents * units)}/mo</button>
          </form>`}
      ${when(account.status === 'past_due', () => html`<span class="muted small">The outstanding invoice is retried once the card is updated.</span>`)}
    </div>
    <p class="muted small">Card details are entered on Stripe’s own pages and never reach StayLeased.</p>`;
}
