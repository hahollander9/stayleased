import { html } from '../../lib/html.ts';
import { jsonRes, redirect, type Router } from '../../lib/http.ts';
import { requirePerm, rateLimit, type Ctx } from '../../lib/auth.ts';
import { insert } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso } from '../../lib/dates.ts';
import { audit } from '../../lib/audit.ts';
import { log } from '../../lib/log.ts';
import {
  emailConfigured, emailProvider, emailFromAddress, emailLive, isDeliverableAddress, deliverNow,
  emailWebhookConfigured, emailWebhookSecretOk, parseProviderEvent, applyProviderEvent,
} from '../../lib/email.ts';

/** Routes for the email rail (lib/email.ts): proof that it works, and the
 * provider's reports of what happened after a message left. */

/** What Connections says about email for this organization. */
export function emailRailStatus(ctx: Ctx): { state: 'off' | 'ready' | 'live'; line: string } {
  if (ctx.orgKind !== 'live') return { state: 'off', line: 'The demo never sends real email.' };
  if (!emailConfigured()) {
    return { state: 'off', line: 'Messages compose, thread and audit fully, but nothing reaches a real phone or inbox until a delivery provider is connected. Every message is saved in the Outbox marked “Saved — not delivered”, so staff can pass it on another way. The resident portal does not show messages yet.' };
  }
  const via = `${emailProvider() === 'postmark' ? 'Postmark' : 'Resend'}, from ${emailFromAddress()}`;
  return emailLive(ctx)
    ? { state: 'live', line: `Email is delivered for real through ${via}. The Outbox shows each message as sent, not delivered, or bounced. Text messages are not connected, and the resident portal does not show messages yet.` }
    : { state: 'ready', line: `Email is set up on this server (${via}) and switched off for this organization. Send a test, then turn it on under Settings → Communications. Text messages are not connected, and the resident portal does not show messages yet.` };
}

export function routes(r: Router): void {
  // One real message to the person asking, and the provider's answer on screen.
  r.post('/setup/connections/test-email', requirePerm('admin:settings'), async (rq) => {
    const ctx = rq.ctx as Ctx;
    if (ctx.orgKind !== 'live') return redirect('/setup/connections', 'The demo never sends real email.', 'err');
    if (!emailConfigured()) return redirect('/setup/connections', 'Email is not set up on this server yet.', 'err');
    if (!isDeliverableAddress(ctx.userEmail)) return redirect('/setup/connections', `${ctx.userEmail} is not an address a test can be delivered to.`, 'err');
    if (!rateLimit(`emailtest:${ctx.orgId}`, 5, 3600000)) return redirect('/setup/connections', 'That is enough tests for an hour.', 'err');
    const mid = id('msg');
    insert('outbox_messages', {
      id: mid, org_id: ctx.orgId, property_id: null, channel: 'email', direction: 'out',
      to_addr: ctx.userEmail, to_user_id: ctx.userId, to_name: ctx.userName,
      subject: 'StayLeased test email',
      body: html`<p>This is a test from StayLeased, sent to ${ctx.userName} because they pressed “Send me a test”.</p><p>If it arrived, email delivery is working for this account.</p>`.s,
      template_key: 'email_test', entity: null, entity_id: null, thread_id: null, person_id: null,
      status: 'queued', sent_by: ctx.userId, created_at: nowIso(), business_date: ctx.businessDate,
    });
    const res = await deliverNow(mid, { test: true });
    audit(ctx, 'org', ctx.orgId, 'email_test', null, { status: res.status });
    return res.status === 'sent'
      ? redirect('/setup/connections', `Test sent to ${ctx.userEmail}. Check the inbox (and the spam folder the first time).`)
      : redirect('/setup/connections', `The test was not sent: ${res.error || res.status}`, 'err');
  });

  // The provider reports bounces and spam complaints here. Unauthenticated by
  // necessity, like the Stripe webhook: the shared secret is its
  // authentication, compared in constant time, and an event can only touch a
  // message whose provider id this server recorded when it sent it.
  r.post('/webhooks/email', (rq) => {
    if (!emailWebhookConfigured()) return jsonRes({ error: 'Email webhooks are not configured on this deployment.' }, 503);
    const given = String(rq.query.get('key') || rq.raw.headers['x-webhook-secret'] || '');
    if (!emailWebhookSecretOk(given)) {
      log.warn('email.webhook_rejected', { ip: rq.ip });
      return jsonRes({ error: 'Not authorized.' }, 401);
    }
    const body = rq.body as unknown;
    const events = Array.isArray(body) ? body : [body];
    let applied = 0;
    for (const e of events.slice(0, 200)) {
      const evt = parseProviderEvent(e);
      if (evt && applyProviderEvent(evt)) applied++;
    }
    return jsonRes({ ok: true, applied });
  });
}
