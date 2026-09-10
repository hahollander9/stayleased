import { request as httpsRequest } from 'node:https';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from './env.ts';

/** Stripe, over raw HTTPS.
 *
 * No SDK, for the same reason the Anthropic adapter has none: this repo runs on
 * one dependency, and a billing integration is the last place to take on a
 * transitive tree that can change under a `npm install`. The API is small here
 * — a customer, a subscription, a checkout session, a portal session — and
 * form-encoded, which is what Stripe speaks.
 *
 * **Card data never reaches this server.** Every flow that touches a payment
 * method is a redirect to a Stripe-hosted page (Checkout to start, the Billing
 * Portal to change a card, the hosted invoice to pay one). That is not
 * convenience; it is what keeps this application out of PCI scope entirely, and
 * it is why there is no card form anywhere in this module and must never be.
 *
 * Everything here is inert until `STAYLEASED_STRIPE_SECRET_KEY` is set — the
 * same shape the AI key and the GA4 id already use in this codebase. An
 * unconfigured deployment does not half-work: `configured()` is false, the
 * billing page says so plainly, and no call is attempted. */

const SECRET = env('STRIPE_SECRET_KEY') || '';
const WEBHOOK_SECRET = env('STRIPE_WEBHOOK_SECRET') || '';
const API = 'api.stripe.com';
const CALL_TIMEOUT_MS = 15000;

/** Live mode is inferred from the key itself rather than a separate flag, so
 * the two can never disagree. `sk_live_…` moves real money; `sk_test_…` does
 * not, and the UI says which one it is looking at. */
export function stripeMode(): 'off' | 'test' | 'live' {
  if (!SECRET) return 'off';
  return SECRET.startsWith('sk_live_') ? 'live' : 'test';
}

export function stripeConfigured(): boolean {
  return SECRET.length > 0;
}

/** Webhooks are a separate switch: a deployment can be able to CALL Stripe
 * while not yet able to trust what Stripe calls back. Without the signing
 * secret we refuse deliveries rather than accepting unverified ones. */
export function stripeWebhookConfigured(): boolean {
  return WEBHOOK_SECRET.length > 0;
}

export class StripeError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 0, code = '') {
    super(message);
    this.name = 'StripeError';
    this.status = status;
    this.code = code;
  }
}

/** Stripe's form encoding: nested objects and arrays become bracketed keys
 * (`items[0][price]`), which is the only shape its API accepts. */
function formEncode(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === 'object') out.push(...formEncode(item as Record<string, unknown>, `${key}[${i}]`));
        else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof v === 'object') {
      out.push(...formEncode(v as Record<string, unknown>, key));
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return out;
}

/** One Stripe API call.
 *
 * `idempotencyKey` is not optional in spirit: every call here that creates
 * something takes one, because a retried POST without it is how a customer ends
 * up with two subscriptions. Callers derive it from the thing being created
 * (the org and the action), never from a clock or a random value, so a genuine
 * retry collides with itself on purpose. */
export function stripeCall<T = Record<string, unknown>>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params: Record<string, unknown> = {},
  opts: { idempotencyKey?: string } = {},
): Promise<T> {
  if (!SECRET) return Promise.reject(new StripeError('Stripe is not configured on this deployment.'));
  const encoded = formEncode(params).join('&');
  const isGet = method === 'GET';
  const body = isGet ? '' : encoded;
  const url = isGet && encoded ? `${path}?${encoded}` : path;

  return new Promise<T>((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: API,
        path: url,
        method,
        headers: {
          authorization: `Bearer ${SECRET}`,
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body),
          'stripe-version': '2024-06-20',
          ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
        },
        timeout: CALL_TIMEOUT_MS,
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          const status = res.statusCode ?? 500;
          let parsed: Record<string, unknown> = {};
          try {
            parsed = buf ? JSON.parse(buf) : {};
          } catch {
            reject(new StripeError('Stripe returned a response this server could not read.', status));
            return;
          }
          if (status >= 400) {
            const e = (parsed.error || {}) as { message?: string; code?: string };
            // Stripe's own message names the problem precisely ("No such
            // customer", "Your card was declined"); it reaches the operator
            // rather than being flattened into "something went wrong".
            reject(new StripeError(e.message || `Stripe request failed (${status}).`, status, e.code || ''));
            return;
          }
          resolve(parsed as T);
        });
      },
    );
    req.on('error', (e) => reject(new StripeError(`Could not reach Stripe: ${(e as Error).message}`)));
    req.on('timeout', () => req.destroy(new StripeError('Stripe did not respond in time.')));
    if (body) req.write(body);
    req.end();
  });
}

/** Verify a webhook delivery against the signing secret.
 *
 * Anyone can POST to a public webhook URL, and the payloads say things like
 * "this invoice is paid". Without verification the endpoint is an unauthenticated
 * write to billing state, so an unverifiable delivery is refused rather than
 * logged-and-accepted.
 *
 * Two properties matter beyond the HMAC itself. The comparison is
 * constant-time, because a byte-by-byte one leaks the expected signature to
 * anyone willing to make enough requests. And the timestamp is checked against
 * a tolerance, because a valid signature stays valid forever — without this, a
 * single captured delivery can be replayed back at us indefinitely. */
export function verifyStripeSignature(
  rawBody: Buffer | string, header: string, toleranceSec = 300,
): { ok: true } | { ok: false; reason: string } {
  if (!WEBHOOK_SECRET) return { ok: false, reason: 'No webhook signing secret is configured.' };
  if (!header) return { ok: false, reason: 'The delivery carried no Stripe-Signature header.' };

  let t = '';
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.trim().split('=', 2);
    if (k === 't' && v) t = v;
    else if (k === 'v1' && v) sigs.push(v);
  }
  if (!t || !sigs.length) return { ok: false, reason: 'The Stripe-Signature header was malformed.' };

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(t));
  if (!Number.isFinite(age) || age > toleranceSec) {
    return { ok: false, reason: 'The delivery is older than the replay window.' };
  }

  const payload = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
  const expBuf = Buffer.from(expected, 'utf8');
  // Stripe may send several v1 signatures during a secret rotation; any one
  // matching is a valid delivery.
  const matched = sigs.some((s) => {
    const got = Buffer.from(s, 'utf8');
    return got.length === expBuf.length && timingSafeEqual(got, expBuf);
  });
  return matched ? { ok: true } : { ok: false, reason: 'The signature did not match this endpoint’s secret.' };
}
