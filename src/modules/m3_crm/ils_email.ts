import { html, raw, when, type Raw } from '../../lib/html.ts';
import { jsonRes, redirect, type Router } from '../../lib/http.ts';
import { requireStaff, sysCtx, type Ctx } from '../../lib/auth.ts';
import { q, q1 } from '../../lib/db.ts';
import { getSetting, setSetting } from '../../lib/settings.ts';
import { token } from '../../lib/ids.ts';
import { audit } from '../../lib/audit.ts';
import { card } from '../../ui/ui.ts';
import { timingSafeEqual } from 'node:crypto';
import { intakeLead, leadEvent } from './service.ts';
import { inboundMessage } from '../m15_comms/service.ts';

/** ILS lead-email intake (M3.9) — the automatic path from "prospect clicked
 * Request Tour on apartments.com" to "lead in the CRM with the AI already
 * replying".
 *
 * Every ILS (Zillow, Apartments.com, Zumper, …) delivers inquiries the same
 * universal way: an email to whatever lead address the listing points at. So
 * each property gets a unique intake address —
 *   leads-<property-slug>-<code>@<inbound domain>
 * — that the operator sets as the lead email on their listings (or
 * auto-forwards into). An inbound-email provider (Postmark et al.) receives
 * the mail and POSTs it to /hooks/inbound-email; we parse the ILS format,
 * create/dedupe the lead, and record the prospect's message as a real inbox
 * thread message — which fires the existing Leasing AI hook, so the reply
 * obeys the property's autonomy dial like every other agent action.
 *
 * Design rules:
 * - NEVER drop a lead: if parsing fails, fall back to sender + raw text.
 * - The webhook is dumb and idempotent-ish: intakeLead dedupes by email/phone.
 * - Auth = server token (env STAYLEASED_INBOUND_TOKEN; unset ⇒ endpoint off)
 *   AND a per-property unguessable address code.
 * - Loop/auto-reply guards: bounces, OOO, our own mail — acknowledged with
 *   {ok:false} and a 200 so the provider never retries them.
 */

// ---------- intake addresses ----------

export function inboundDomain(): string {
  return process.env.STAYLEASED_INBOUND_DOMAIN || 'in.stayleased.com';
}

export function inboundToken(): string {
  return process.env.STAYLEASED_INBOUND_TOKEN || '';
}

/** Stable per-property address code (6 hex chars), created on first use. */
export function intakeCodeFor(ctx: Ctx, propertyId: string): string {
  const cur = getSetting<string | null>(ctx, 'lead_intake_code', propertyId);
  if (cur && typeof cur === 'string') return cur;
  const code = token(3); // 6 hex chars
  setSetting(ctx, 'lead_intake_code', code, propertyId);
  return code;
}

export function intakeAddressFor(ctx: Ctx, prop: { id: string; slug: string }): string {
  return `leads-${prop.slug}-${intakeCodeFor(ctx, prop.id)}@${inboundDomain()}`;
}

/** leads-<slug>-<code>@domain → the property row, or null. */
export function resolveIntakeAddress(addr: string): { id: string; org_id: string; slug: string; name: string } | null {
  const m = /^leads-(.+)-([a-f0-9]{6})@([^@\s>]+)$/i.exec(addr.trim().toLowerCase());
  if (!m) return null;
  const prop = q1<any>('SELECT id, org_id, slug, name FROM properties WHERE slug=?', m[1]);
  if (!prop) return null;
  const code = getSetting<string | null>(sysCtx(prop.org_id), 'lead_intake_code', prop.id);
  if (!code || code.toLowerCase() !== m[2]!.toLowerCase()) return null;
  return prop;
}

// ---------- parsing ----------

export interface InboundEmail {
  from: { email: string; name: string };
  replyTo?: string;
  to: string[]; // every recipient address we saw
  subject: string;
  text: string; // plain-text body (html-stripped upstream if needed)
}

export interface ParsedLead {
  source: string; // zillow | apartments_com | facebook | craigslist | google | ils_email
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  beds: number | null;
  moveIn: string | null; // ISO date
  message: string;
}

const FIELD_LINE = (text: string, labels: string[]): string | null => {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z][A-Za-z /-]{1,24})\s*[:—-]\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const label = m[1]!.trim().toLowerCase();
    if (labels.some((l) => label === l || label.startsWith(l))) return m[2]!.trim();
  }
  return null;
};

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;

function detectSource(mail: InboundEmail): string {
  const hay = `${mail.from.email} ${mail.subject} ${mail.text.slice(0, 600)}`.toLowerCase();
  if (/zillow|hotpads|trulia/.test(hay)) return 'zillow';
  if (/apartments\.com|apartmentfinder|costar|forrent/.test(hay)) return 'apartments_com';
  if (/facebook|marketplace/.test(hay)) return 'facebook';
  if (/craigslist/.test(hay)) return 'craigslist';
  if (/zumper|padmapper/.test(hay)) return 'zumper';
  if (/realtor\.com|rent\.com|apartmentguide|redfin/.test(hay)) return 'rent_com';
  if (/google/.test(hay)) return 'google';
  return 'ils_email';
}

function parseMoveIn(v: string | null): string | null {
  if (!v) return null;
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (iso) return iso[0]!;
  const us = /(\d{1,2})[/](\d{1,2})[/](\d{4})/.exec(v);
  if (us) return `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`;
  const t = Date.parse(v.replace(/(st|nd|rd|th),/i, ','));
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    if (d.getFullYear() >= 2020 && d.getFullYear() <= 2100) return d.toISOString().slice(0, 10);
  }
  return null;
}

function splitName(full: string): { first: string; last: string } {
  const parts = full.replace(/["<>]/g, '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: 'Unknown', last: 'Prospect' };
  if (parts.length === 1) return { first: parts[0]!, last: '(via listing)' };
  return { first: parts[0]!, last: parts.slice(1).join(' ') };
}

/** True for bounces, auto-replies, and our own outbound — never make leads from these. */
export function shouldIgnore(mail: InboundEmail): string | null {
  const from = mail.from.email.toLowerCase();
  if (from.includes('mailer-daemon') || from.includes('postmaster@')) return 'bounce';
  if (from.endsWith(`@${inboundDomain()}`)) return 'own domain (loop guard)';
  if (/^(automatic reply|auto[- ]?reply|out of office|undeliverable|delivery status|mail delivery failed)/i.test(mail.subject)) return 'auto-reply';
  return null;
}

/** Parse a lead email from any ILS. Deterministic; never throws; never returns null. */
export function parseLeadEmail(mail: InboundEmail): ParsedLead {
  const source = detectSource(mail);
  const text = mail.text.slice(0, 20000);

  // name: labeled field → subject pattern → sender display name → email local part
  let name = FIELD_LINE(text, ['name', 'full name', 'contact name', 'renter name', 'prospect']);
  if (!name) {
    const sub = /^(?:fwd:\s*|re:\s*)*(?:new (?:contact|lead|inquiry)[:\s-]*)?([A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+){1,3})\s+(?:is interested|is requesting|sent you|would like|inquired|wants)/i.exec(mail.subject);
    if (sub) name = sub[1]!;
  }
  const ilsSender = source !== 'ils_email';
  if (!name && mail.from.name && !(ilsSender && /zillow|apartments|costar|facebook|craigslist|zumper|realtor|rent\.com/i.test(mail.from.name))) {
    name = mail.from.name;
  }

  // email: labeled → reply-to → sender (unless the sender is the ILS notification robot)
  const labeledEmail = FIELD_LINE(text, ['email', 'e-mail', 'email address']);
  const emailInLabel = labeledEmail ? EMAIL_RE.exec(labeledEmail)?.[0] : null;
  const replyTo = mail.replyTo && EMAIL_RE.test(mail.replyTo) ? EMAIL_RE.exec(mail.replyTo)![0] : null;
  const fromUsable = !/no-?reply|notification|donotreply|@(convo\.)?zillow|@apartments\.com|@costar/i.test(mail.from.email);
  const email = (emailInLabel || replyTo || (fromUsable ? mail.from.email : null) || null)?.toLowerCase() || null;
  if (!name && email) name = email.split('@')[0]!.replace(/[._\d]+/g, ' ').trim() || 'Unknown';

  // phone / beds / move-in
  const labeledPhone = FIELD_LINE(text, ['phone', 'phone number', 'tel', 'mobile']);
  const phone = (labeledPhone && PHONE_RE.exec(labeledPhone)?.[0]) || PHONE_RE.exec(text)?.[0] || null;
  const bedsM = /(\d)\s*(?:bed|bd|br)\b/i.exec(`${mail.subject} ${text.slice(0, 1200)}`);
  const beds = bedsM ? parseInt(bedsM[1]!, 10) : (/\bstudio\b/i.test(text.slice(0, 1200)) ? 0 : null);
  const moveIn = parseMoveIn(FIELD_LINE(text, ['move date', 'move-in', 'move in', 'desired move', 'move in date']));

  // message: labeled → "says:" block → whole body
  let message = FIELD_LINE(text, ['message', 'comments', 'inquiry', 'question']);
  if (!message) {
    const says = /says?:\s*\r?\n?([\s\S]{10,1200}?)(?:\r?\n\s*\r?\n|Phone:|Email:|Move|$)/i.exec(text);
    if (says) message = says[1]!.trim();
  }
  if (!message) message = text.trim().slice(0, 1200) || mail.subject;

  const nm = splitName(name || 'Unknown Prospect');
  return { source, firstName: nm.first, lastName: nm.last, email, phone, beds, moveIn, message: message.slice(0, 2000) };
}

// ---------- apply ----------

export function applyInboundLead(
  prop: { id: string; org_id: string; name: string },
  parsed: ParsedLead,
  meta: { to: string; subject: string },
): { leadId: string; deduped: boolean } {
  const ctx = sysCtx(prop.org_id);
  const { leadId, deduped } = intakeLead(ctx, {
    propertyId: prop.id,
    firstName: parsed.firstName,
    lastName: parsed.lastName,
    email: parsed.email,
    phone: parsed.phone,
    source: parsed.source,
    channel: 'email',
    desiredMoveIn: parsed.moveIn,
    beds: parsed.beds,
    message: parsed.message,
  });
  leadEvent(ctx, leadId, 'note', `ILS email received at ${meta.to} — routed automatically${deduped ? ' (existing guest card)' : ''}.`);
  // The prospect's words become a real inbox thread message → the Leasing AI
  // hook fires exactly as it does for any inbound reply (dials decide the rest).
  inboundMessage(ctx, {
    personKind: 'lead',
    personId: leadId,
    channel: 'email',
    subject: meta.subject || `Inquiry via ${parsed.source}`,
    body: parsed.message,
  });
  return { leadId, deduped };
}

// ---------- webhook + staff test lane ----------

function tokenOk(given: string): boolean {
  const want = inboundToken();
  if (!want || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

function stripHtml(s: string): string {
  return s.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ');
}

/** Normalize a Postmark inbound payload (or our simplified generic shape). */
export function normalizeWebhook(body: Record<string, any>): InboundEmail {
  const fromFull = body.FromFull || {};
  const toList: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === 'string') for (const m of v.matchAll(new RegExp(EMAIL_RE, 'g'))) toList.push(m[0].toLowerCase());
  };
  push(body.OriginalRecipient);
  if (Array.isArray(body.ToFull)) for (const t of body.ToFull) push(t?.Email);
  if (Array.isArray(body.CcFull)) for (const t of body.CcFull) push(t?.Email);
  push(body.To);
  push(body.to);
  const text = String(body.TextBody || body.text || '') || stripHtml(String(body.HtmlBody || body.html || ''));
  return {
    from: {
      email: String(fromFull.Email || body.From || body.from || '').trim().toLowerCase(),
      name: String(fromFull.Name || body.FromName || body.from_name || '').trim(),
    },
    replyTo: String(body.ReplyTo || body.reply_to || '').trim() || undefined,
    to: [...new Set(toList)],
    subject: String(body.Subject || body.subject || '').slice(0, 300),
    text: text.slice(0, 100_000),
  };
}

export function routes(r: Router): void {
  /** Inbound-email provider webhook (Postmark JSON or generic
   * {to,from,subject,text}). Public; gated by server token + per-property
   * address code. Always 200 for handled-but-skipped mail so providers
   * don't retry. */
  r.post('/hooks/inbound-email', (rq) => {
    const given = rq.query.get('token') || String(rq.body?._token || '');
    if (!tokenOk(given)) return jsonRes({ ok: false, error: 'bad or missing token' }, 403);
    const mail = normalizeWebhook(rq.body || {});
    const skip = shouldIgnore(mail);
    if (skip) return jsonRes({ ok: false, skipped: skip });
    let prop: ReturnType<typeof resolveIntakeAddress> = null;
    let matched = '';
    for (const addr of mail.to) {
      prop = resolveIntakeAddress(addr);
      if (prop) { matched = addr; break; }
    }
    if (!prop) return jsonRes({ ok: false, error: 'no recipient matches a property intake address' }, 404);
    const parsed = parseLeadEmail(mail);
    const { leadId, deduped } = applyInboundLead(prop, parsed, { to: matched, subject: mail.subject });
    audit(sysCtx(prop.org_id), 'lead', leadId, 'ils_email_in', null, { source: parsed.source, to: matched, deduped });
    return jsonRes({ ok: true, leadId, deduped, source: parsed.source, property: prop.slug });
  });

  /** Staff test lane: paste any lead email, watch it become a lead + AI reply.
   * Runs the exact same parser/apply path as the webhook. */
  r.post('/setup/connections/ils-test', requireStaff, (rq) => {
    const ctx = rq.ctx as Ctx;
    const propertyId = String(rq.body.property_id || '');
    const prop = q1<any>('SELECT id, org_id, slug, name FROM properties WHERE id=? AND org_id=?', propertyId, ctx.orgId);
    if (!prop) return redirect('/setup/connections', 'Pick a property for the test email.', 'err');
    const rawText = String(rq.body.raw || '').slice(0, 50_000);
    if (rawText.trim().length < 10) return redirect('/setup/connections', 'Paste the lead email (headers optional) into the box first.', 'err');
    // headers are optional: pull From/Subject/Reply-To lines if present
    const hdr = (k: string): string => new RegExp(`^${k}\\s*:\\s*(.+)$`, 'im').exec(rawText)?.[1]?.trim() || '';
    const fromLine = hdr('From');
    const mail: InboundEmail = {
      from: { email: EMAIL_RE.exec(fromLine)?.[0]?.toLowerCase() || '', name: fromLine.replace(/<[^>]*>/, '').trim() },
      replyTo: EMAIL_RE.exec(hdr('Reply-To'))?.[0],
      to: [],
      subject: hdr('Subject') || 'Pasted lead email',
      text: rawText,
    };
    const parsed = parseLeadEmail(mail);
    const { leadId, deduped } = applyInboundLead(prop, parsed, { to: `test paste (${ctx.userName})`, subject: mail.subject });
    audit(ctx, 'lead', leadId, 'ils_email_test', null, { source: parsed.source, deduped });
    return redirect(`/leads/${leadId}`,
      `${deduped ? 'Matched an existing guest card' : 'Lead created'}: ${parsed.firstName} ${parsed.lastName} via ${parsed.source} — the AI is on it per your autonomy dial (check /ai).`);
  });
}

// ---------- connections-page card ----------

export function ilsIntakeCard(ctx: Ctx): Raw {
  const props = q<any>(`SELECT id, slug, name FROM properties WHERE org_id=? AND status != 'archived' ORDER BY name`, ctx.orgId);
  if (!props.length) return html``;
  const armed = !!inboundToken();
  return card('ILS lead email — automatic intake', html`
    <p class="muted small" style="margin-top:0">Every listing site (Zillow, Apartments.com, Zumper…) delivers inquiries by email.
      Set the address below as the <b>lead email on each listing</b> — or auto-forward your current lead inbox to it — and every
      inquiry lands here as a guest card with the prospect's message threaded, cadence started, and the Leasing AI answering
      per that property's autonomy dial. No retyping, no tab-switching.</p>
    <table class="tbl"><thead><tr><th>Property</th><th>Lead intake address</th></tr></thead><tbody>
      ${props.map((p: any) => html`<tr><td>${p.name}</td><td><input readonly value="${intakeAddressFor(ctx, p)}" style="width:100%;max-width:420px;font-family:var(--mono,monospace);font-size:12px" class="selectall" /></td></tr>`)}
    </tbody></table>
    <div class="callout ${armed ? '' : 'bad'}" style="margin-top:10px">
      ${armed
        ? html`Receiving endpoint is <b>armed</b> (${inboundDomain()}). Point your inbound-email provider's webhook at
          <code>/hooks/inbound-email?token=…</code> and mail starts flowing.`
        : html`Receiving endpoint is <b>off</b> — set <code>STAYLEASED_INBOUND_TOKEN</code> (and optionally
          <code>STAYLEASED_INBOUND_DOMAIN</code>) on the server, then configure an inbound-email provider (e.g. Postmark) to
          POST to <code>/hooks/inbound-email?token=&lt;that token&gt;</code>. The test lane below works right now either way.`}
    </div>
    <details style="margin-top:10px"><summary class="muted small">Test it now — paste any lead email</summary>
      <form method="post" action="/setup/connections/ils-test" style="margin-top:8px">
        <div class="field"><label>Property</label><select name="property_id">${props.map((p: any) => html`<option value="${p.id}">${p.name}</option>`)}</select></div>
        <div class="field"><label>Lead email (paste the whole thing — headers optional)</label>
          <textarea name="raw" rows="8" placeholder="Subject: New contact: Jamie Rivera is interested in your listing&#10;From: Zillow <no-reply@zillow.com>&#10;&#10;Jamie Rivera says:&#10;Hi! Is the 2 bedroom still available?...&#10;Phone: (303) 555-0164"></textarea></div>
        <button class="btn" type="submit">Run it through the real pipeline</button>
      </form>
    </details>
  `);
}
