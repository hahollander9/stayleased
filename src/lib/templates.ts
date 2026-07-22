import { esc } from './html.ts';
import { usd } from './money.ts';
import { fmtDate } from './dates.ts';
import { sendEmail, sendSms } from './sim/messaging.ts';
import type { Ctx } from './auth.ts';
import { q1 } from './db.ts';
import { getSetting } from './settings.ts';

/** Minimal lifecycle template mechanism (§7 carry-along rule). Phase 13
 * upgrades this into the full M15 template library; the keys stay stable so
 * nothing downstream changes. Templates render simple HTML emails + SMS. */

export interface TemplateVars {
  [k: string]: string | number | null | undefined;
}

interface Tpl {
  subject: string;
  body: string; // {{var}} placeholders
  sms?: string;
}

export const TEMPLATES: Record<string, Tpl> = {
  insurance_reminder: {
    subject: 'Your renters insurance {{when}} — action needed',
    body: `<p>Hi {{first_name}},</p><p>Your renters insurance policy {{policy}} {{when}}. Your lease requires active liability coverage of at least {{required}}.</p><p>Upload a new policy in the resident portal, or enroll in the community master policy ({{master_fee}}/month) with one click.</p><p>If coverage lapses, you may be enrolled automatically per your lease.</p><p>— {{property}}</p>`,
    sms: '{{property}}: Your renters insurance {{when}}. Upload proof or enroll in the master policy ({{master_fee}}/mo) in the portal to stay covered.',
  },
  insurance_autoenroll: {
    subject: 'You have been enrolled in the community insurance program',
    body: `<p>Hi {{first_name}},</p><p>Because we did not receive proof of active renters insurance, you were enrolled in the community master policy effective {{date}}, as provided in your lease. The monthly program fee of <b>{{master_fee}}</b> will appear on your ledger.</p><p>Have your own coverage? Upload proof in the portal any time and the program fee stops with the next cycle.</p><p>— {{property}}</p>`,
    sms: '{{property}}: No proof of renters insurance on file — you were enrolled in the master policy ({{master_fee}}/mo) effective {{date}}. Upload your own policy in the portal to opt out.',
  },
  insurance_verified: {
    subject: 'Your insurance is verified ✓',
    body: `<p>Hi {{first_name}},</p><p>Your policy {{policy}} with {{carrier}} was verified. You're all set through {{end_date}}.</p><p>— {{property}}</p>`,
    sms: '{{property}}: Insurance policy {{policy}} verified through {{end_date}}. You are covered.',
  },
  insurance_rejected: {
    subject: 'We could not verify your insurance policy',
    body: `<p>Hi {{first_name}},</p><p>We could not verify policy {{policy}} with {{carrier}}: {{reason}}.</p><p>Please double-check the policy number, upload current proof, or enroll in the community master policy ({{master_fee}}/month) in the portal.</p><p>— {{property}}</p>`,
    sms: '{{property}}: We could not verify policy {{policy}} ({{reason}}). Upload proof or enroll in the master policy in the portal.',
  },
  payment_receipt: {
    subject: 'Receipt: {{amount}} received for {{unit}}',
    body: `<p>Hi {{first_name}},</p><p>We received your payment of <b>{{amount}}</b> for unit {{unit}} on {{date}}.</p><p>Method: {{method}} · Confirmation: {{reference}}</p><p>Your balance after this payment: <b>{{balance}}</b>.</p><p>— {{property}}</p>`,
    sms: '{{property}}: Payment of {{amount}} received for {{unit}}. Confirmation {{reference}}. Balance: {{balance}}.',
  },
  payment_nsf: {
    subject: 'Action needed: your payment was returned',
    body: `<p>Hi {{first_name}},</p><p>Your payment of <b>{{amount}}</b> made on {{date}} was returned by your bank (NSF). The amount has been restored to your balance and a returned-payment fee of {{nsf_fee}} was applied per your lease.</p><p>Current balance: <b>{{balance}}</b>. Please make a replacement payment in the resident portal.</p><p>— {{property}}</p>`,
    sms: '{{property}}: Your {{amount}} payment was returned (NSF). Balance is now {{balance}}. A {{nsf_fee}} fee applied. Please pay in the portal.',
  },
  late_fee_notice: {
    subject: 'A late fee was applied to your account',
    body: `<p>Hi {{first_name}},</p><p>Rent for {{month}} was not received by the end of the grace period, so a late fee of <b>{{fee}}</b> was applied on {{date}}.</p><p>Current balance: <b>{{balance}}</b>. If you believe this is an error or need to arrange a payment plan, reply to this message or contact the office.</p><p>— {{property}}</p>`,
    sms: '{{property}}: A late fee of {{fee}} was applied. Balance {{balance}}. Contact the office about payment options.',
  },
  dunning_friendly: {
    subject: 'Friendly reminder: rent balance open for {{unit}}',
    body: `<p>Hi {{first_name}},</p><p>Just a reminder that your account shows an open balance of <b>{{balance}}</b>. If you've already paid, thank you — payments can take a day or two to post.</p><p>You can pay any time in the resident portal.</p><p>— {{property}}</p>`,
    sms: '{{property}}: Reminder — open balance of {{balance}} on your account. Pay any time in the portal. Questions? Reply here.',
  },
  dunning_firm: {
    subject: 'Second notice: past-due balance of {{balance}}',
    body: `<p>Hi {{first_name}},</p><p>Your account remains past due with a balance of <b>{{balance}}</b> ({{days}} days). Please pay in the portal or contact the office today to discuss a payment plan. Additional fees may apply per your lease.</p><p>— {{property}}</p>`,
    sms: '{{property}}: 2nd notice — past-due balance {{balance}} ({{days}} days). Please pay or contact the office to avoid further fees.',
  },
  dunning_final: {
    subject: 'Important: account referred for further action',
    body: `<p>Hi {{first_name}},</p><p>Despite prior notices your balance of <b>{{balance}}</b> remains unpaid ({{days}} days). Your account is being reviewed for further action, which may include a formal demand or referral to collections. You may dispute this balance by replying with details.</p><p>Contact the office immediately to resolve or arrange a plan.</p><p>— {{property}}</p>`,
    sms: '{{property}}: FINAL notice — {{balance}} past due {{days}} days. Contact the office immediately. You may reply to dispute.',
  },
  payment_plan_confirmed: {
    subject: 'Your payment plan is confirmed',
    body: `<p>Hi {{first_name}},</p><p>Your payment plan for <b>{{total}}</b> is confirmed:</p>{{schedule_html}}<p>Installments will be charged to your saved payment method on each date. Thank you for working with us.</p><p>— {{property}}</p>`,
    sms: '{{property}}: Payment plan confirmed — {{total}} across {{n}} installments. First: {{first_date}}.',
  },
  deposit_disposition: {
    subject: 'Your final account statement for {{unit}}',
    body: `<p>Hi {{first_name}},</p><p>Your move-out accounting for unit {{unit}} is complete. Your final account statement is attached{{refund_line}}.</p><p>If you have questions about any item, reply to this message within 30 days.</p><p>— {{property}}</p>`,
    sms: '{{property}}: Your final account statement for {{unit}} is ready. {{refund_sms}}',
  },
  autopay_confirmation: {
    subject: 'Autopay is on for {{unit}}',
    body: `<p>Hi {{first_name}},</p><p>Autopay is now active for unit {{unit}}: <b>{{mode}}</b> on day {{day}} of each month using {{method}}.</p><p>You can change or cancel any time in the portal.</p><p>— {{property}}</p>`,
    sms: '{{property}}: Autopay ON — {{mode}} on day {{day}} each month via {{method}}.',
  },
};

export function renderTemplate(key: string, vars: TemplateVars, orgId?: string): { subject: string; html: string; sms: string } {
  // an org-level override in the template library (M15.2) wins over code defaults
  let tpl: Tpl | undefined = TEMPLATES[key];
  if (orgId) {
    const row = q1<any>('SELECT subject, body, sms FROM message_templates WHERE org_id=? AND key=? AND active=1 ORDER BY property_id IS NULL LIMIT 1', orgId, key);
    if (row) tpl = { subject: row.subject, body: row.body, sms: row.sms || undefined };
  }
  if (!tpl) throw new Error(`unknown template ${key}`);
  const fill = (s: string): string =>
    s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
      const v = vars[k];
      return v === null || v === undefined ? '' : String(v);
    });
  return { subject: fill(tpl.subject), html: fill(tpl.body), sms: fill(tpl.sms || tpl.subject) };
}

export interface NotifyTarget {
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  userId?: string | null;
  personId?: string | null;
  propertyId?: string | null;
  entity?: string;
  entityId?: string;
}

/** render + send via the outbox (email always; sms when phone known) */
export function notify(ctx: Ctx, key: string, target: NotifyTarget, vars: TemplateVars): void {
  // per-org automation toggles (M15.5): a disabled lifecycle template is skipped
  const toggles = getSetting<Record<string, boolean>>(ctx, 'comms_toggles');
  if (toggles && toggles[key] === false) return;
  const r = renderTemplate(key, vars, ctx.orgId);
  if (target.email) {
    sendEmail(ctx, {
      to: target.email, toName: target.name || undefined, toUserId: target.userId || undefined,
      subject: r.subject, body: r.html, templateKey: key,
      propertyId: target.propertyId || undefined, entity: target.entity, entityId: target.entityId,
      personId: target.personId || undefined,
    });
  }
  if (target.phone) {
    sendSms(ctx, {
      to: target.phone, toName: target.name || undefined, toUserId: target.userId || undefined,
      body: r.sms, templateKey: key,
      propertyId: target.propertyId || undefined, entity: target.entity, entityId: target.entityId,
      personId: target.personId || undefined,
    });
  }
}

export const fmtMoneyVar = usd;
export const fmtDateVar = fmtDate;
export const escVar = esc;
