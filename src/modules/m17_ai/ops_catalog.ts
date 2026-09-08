import { q1, val, run, insert } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, addDays, fmtDate } from '../../lib/dates.ts';
import { usd } from '../../lib/money.ts';
import { audit } from '../../lib/audit.ts';
import type { Ctx } from '../../lib/auth.ts';
import { advanceBusinessDate } from '../../lib/jobs.ts';
import { createCharge, leaseBalance } from '../m8_receivables/service.ts';
import { finalizeDeposit, waiveLateFee, recordPayment, depositHeld } from '../m8_receivables/payments.ts';
import { assignWo, transitionWo, triageWo, woEvent } from '../m10_facilities/service.ts';
import { createRenewalOffer } from '../m6_leases/service.ts';
import { registerOp, leaseRow, type OpArgs } from './ops.ts';

/** The operations Ask can perform.
 *
 * Each one sits beside the service function the equivalent screen calls, takes
 * the same permission that screen takes, and previews itself with the actual
 * figures before anyone confirms. Adding another is one `registerOp` — which is
 * the point, because "everything you could do by hand" is not a finite list and
 * a design that needs a new code path per capability will never get there. */

const cents = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

// ---------------------------------------------------------------- money ----

registerOp({
  key: 'deposit.finalize',
  name: 'Finalize deposit disposition',
  describe: 'Close out a moved-out household\'s security deposit: apply what is held against the final balance, refund the remainder, and post the statement. Choose this for "finalize disposition", "close out the deposit", "settle the deposit".',
  perm: 'deposits:manage',
  risk: 'money',
  params: [
    { key: 'lease', type: 'lease', label: 'Household', required: true, hint: 'the household name, a resident surname, or the unit' },
    { key: 'date', type: 'date', label: 'Disposition date', hint: 'defaults to the business date' },
    { key: 'to_collections', type: 'boolean', label: 'Send any remaining balance to collections' },
  ],
  preview(ctx, a) {
    const l = leaseRow(ctx, str(a.lease));
    if (!l) return { summary: '', changes: [], blockers: ['That household no longer exists.'], warnings: [] };
    const held = depositHeld(ctx, l.id);
    const bal = leaseBalance(ctx, l.id);
    const apply = Math.max(0, Math.min(held, bal));
    const refund = Math.max(0, held - apply);
    const still = Math.max(0, bal - apply);
    const blockers: string[] = [];
    const warnings: string[] = [];
    if (held === 0 && bal === 0) blockers.push('Nothing to settle — no deposit held and no balance outstanding.');
    if (l.status !== 'ended' && l.status !== 'notice') {
      warnings.push(`This lease is ${l.status.replace(/_/g, ' ')}, not moved out — normally a disposition follows a move-out.`);
    }
    if (still > 0) warnings.push(`${usd(still)} would remain owed after the deposit is applied.`);
    return {
      summary: `Settle ${l.household_name}'s deposit on unit ${l.unit_number} at ${l.prop_name}.`,
      changes: [
        { label: 'Deposit held', value: usd(held) },
        { label: 'Balance owed', value: usd(bal) },
        { label: 'Applied to the balance', value: usd(apply) },
        { label: 'Refunded to the resident', value: usd(refund) },
        { label: 'Still owed afterwards', value: usd(still) },
        { label: 'Dated', value: fmtDate(str(a.date) || ctx.businessDate) },
      ],
      blockers, warnings,
    };
  },
  apply(ctx, a) {
    const r = finalizeDeposit(ctx, str(a.lease), {
      date: str(a.date) || ctx.businessDate,
      toCollections: a.to_collections === true,
    });
    return `Applied ${usd(r.applied)} and refunded ${usd(r.refunded)}.`;
  },
});

registerOp({
  key: 'ledger.charge',
  name: 'Post a charge',
  describe: 'Bill a household for something one-off — damage, a utility, a fee, a concession as a negative amount. Choose this for "charge", "bill", "add a charge", "credit" (use a negative amount).',
  perm: 'ledger:charge',
  risk: 'money',
  params: [
    { key: 'lease', type: 'lease', label: 'Household', required: true },
    { key: 'amount', type: 'money', label: 'Amount', required: true, hint: 'negative for a credit' },
    { key: 'label', type: 'text', label: 'What it is for', required: true, hint: 'appears on the resident ledger and statement' },
    { key: 'date', type: 'date', label: 'Date', hint: 'defaults to the business date' },
  ],
  preview(ctx, a) {
    const l = leaseRow(ctx, str(a.lease));
    if (!l) return { summary: '', changes: [], blockers: ['That household no longer exists.'], warnings: [] };
    const amt = cents(a.amount);
    const bal = leaseBalance(ctx, l.id);
    const blockers: string[] = [];
    if (amt === 0) blockers.push('An amount is required.');
    if (!str(a.label)) blockers.push('Say what the charge is for — it appears on the resident’s ledger.');
    return {
      summary: `${amt < 0 ? 'Credit' : 'Charge'} ${l.household_name} ${usd(Math.abs(amt))} for “${str(a.label)}”.`,
      changes: [
        { label: 'Household', value: `${l.household_name} — unit ${l.unit_number}` },
        { label: amt < 0 ? 'Credit' : 'Charge', value: usd(Math.abs(amt)) },
        { label: 'Balance now', value: usd(bal) },
        { label: 'Balance after', value: usd(bal + amt) },
      ],
      blockers, warnings: [],
    };
  },
  apply(ctx, a) {
    const date = str(a.date) || ctx.businessDate;
    createCharge(ctx, {
      leaseId: str(a.lease), kind: 'other', label: str(a.label),
      amountCents: cents(a.amount), date, dueDate: date, source: 'oneoff',
      memo: 'Posted from Ask StayLeased',
    });
    return `Posted ${usd(cents(a.amount))} — ${str(a.label)}.`;
  },
});

registerOp({
  key: 'latefee.waive',
  name: 'Waive a late fee',
  describe: 'Reverse the most recent unwaived late or NSF fee on a household, with a reason. Choose this for "waive the late fee", "reverse the NSF fee", "take the fee off".',
  perm: 'latefees:waive',
  risk: 'money',
  params: [
    { key: 'lease', type: 'lease', label: 'Household', required: true },
    { key: 'reason', type: 'text', label: 'Reason', required: true, hint: 'recorded on the ledger and in the audit trail' },
  ],
  preview(ctx, a) {
    const l = leaseRow(ctx, str(a.lease));
    if (!l) return { summary: '', changes: [], blockers: ['That household no longer exists.'], warnings: [] };
    const fee = latestFee(ctx, l.id);
    if (!fee) {
      return { summary: '', changes: [], blockers: [`${l.household_name} has no active late or NSF fee to waive.`], warnings: [] };
    }
    const blockers = str(a.reason) ? [] : ['A reason is required — it is recorded on the ledger.'];
    return {
      summary: `Waive ${l.household_name}'s ${fee.label} of ${usd(fee.amount_cents)}.`,
      changes: [
        { label: 'Fee', value: `${fee.label} — ${fmtDate(fee.date)}` },
        { label: 'Amount reversed', value: usd(fee.amount_cents) },
        { label: 'Reason', value: str(a.reason) || '—' },
      ],
      blockers, warnings: [],
    };
  },
  apply(ctx, a) {
    const l = leaseRow(ctx, str(a.lease))!;
    const fee = latestFee(ctx, l.id);
    if (!fee) throw new Error('no active fee to waive');
    waiveLateFee(ctx, fee.id, str(a.reason));
    return `Waived ${usd(fee.amount_cents)} — ${str(a.reason)}.`;
  },
});

function latestFee(ctx: Ctx, leaseId: string): { id: string; label: string; amount_cents: number; date: string } | undefined {
  return q1(
    `SELECT id, label, amount_cents, date FROM charges
      WHERE org_id=? AND lease_id=? AND kind IN ('late_fee','nsf_fee') AND status='active' AND amount_cents > 0
      ORDER BY date DESC, created_at DESC LIMIT 1`,
    ctx.orgId, leaseId,
  );
}

registerOp({
  key: 'payment.record',
  name: 'Record a payment',
  describe: 'Log money received from a household — a check, money order, cash equivalent or ACH already taken. Choose this for "record a payment", "they paid", "log a check".',
  perm: 'payments:record',
  risk: 'money',
  params: [
    { key: 'lease', type: 'lease', label: 'Household', required: true },
    { key: 'amount', type: 'money', label: 'Amount', required: true },
    { key: 'method', type: 'enum', label: 'Method', required: true, values: ['check', 'money_order', 'cash_equivalent', 'ach', 'card', 'lockbox'] },
    { key: 'reference', type: 'text', label: 'Reference', hint: 'cheque number or confirmation' },
    { key: 'date', type: 'date', label: 'Received', hint: 'defaults to the business date' },
  ],
  preview(ctx, a) {
    const l = leaseRow(ctx, str(a.lease));
    if (!l) return { summary: '', changes: [], blockers: ['That household no longer exists.'], warnings: [] };
    const amt = cents(a.amount);
    const bal = leaseBalance(ctx, l.id);
    const blockers: string[] = [];
    const warnings: string[] = [];
    if (amt <= 0) blockers.push('A positive amount is required.');
    if (amt > bal && bal > 0) warnings.push(`This is ${usd(amt - bal)} more than the ${usd(bal)} owed — the rest becomes a credit.`);
    return {
      summary: `Record ${usd(amt)} from ${l.household_name} by ${str(a.method) || 'check'}.`,
      changes: [
        { label: 'Household', value: `${l.household_name} — unit ${l.unit_number}` },
        { label: 'Amount', value: usd(amt) },
        { label: 'Method', value: (str(a.method) || 'check').replace(/_/g, ' ') },
        { label: 'Balance now', value: usd(bal) },
        { label: 'Balance after', value: usd(bal - amt) },
      ],
      blockers, warnings,
    };
  },
  apply(ctx, a) {
    recordPayment(ctx, {
      leaseId: str(a.lease), amountCents: cents(a.amount),
      method: (str(a.method) || 'check') as 'check',
      reference: str(a.reference) || null,
      receivedDate: str(a.date) || ctx.businessDate,
      memo: 'Recorded from Ask StayLeased',
    });
    return `Recorded ${usd(cents(a.amount))}.`;
  },
});

// ------------------------------------------------- leasing + residents ----

registerOp({
  key: 'lease.notice',
  name: 'Record a notice to vacate',
  describe: 'Put a household on notice with a planned move-out date. Choose this for "they gave notice", "record notice", "moving out on <date>".',
  perm: 'leases:manage',
  risk: 'record',
  params: [
    { key: 'lease', type: 'lease', label: 'Household', required: true },
    { key: 'move_out', type: 'date', label: 'Move-out date', required: true },
  ],
  preview(ctx, a) {
    const l = leaseRow(ctx, str(a.lease));
    if (!l) return { summary: '', changes: [], blockers: ['That household no longer exists.'], warnings: [] };
    const mo = str(a.move_out);
    const blockers: string[] = [];
    const warnings: string[] = [];
    if (!mo) blockers.push('A move-out date is required.');
    if (l.status === 'notice') warnings.push(`Already on notice for ${fmtDate(l.move_out_date || '')} — this replaces that date.`);
    if (l.status === 'ended') blockers.push('That lease has already ended.');
    if (mo && mo < ctx.businessDate) warnings.push('That date is in the past.');
    return {
      summary: `Put ${l.household_name} on notice to leave unit ${l.unit_number} on ${mo ? fmtDate(mo) : '—'}.`,
      changes: [
        { label: 'Household', value: `${l.household_name} — ${l.prop_name}` },
        { label: 'Status', value: `${l.status.replace(/_/g, ' ')} → notice` },
        { label: 'Move-out', value: mo ? fmtDate(mo) : '—' },
        { label: 'Lease end on file', value: fmtDate(l.end_date) },
      ],
      blockers, warnings,
    };
  },
  apply(ctx, a) {
    const l = leaseRow(ctx, str(a.lease))!;
    run(
      `UPDATE leases SET status='notice', notice_date=?, move_out_date=? WHERE id=? AND org_id=?`,
      ctx.businessDate, str(a.move_out), l.id, ctx.orgId,
    );
    audit(ctx, 'lease', l.id, 'notice', null, { moveOut: str(a.move_out), via: 'ask' });
    return `${l.household_name} is on notice for ${fmtDate(str(a.move_out))}.`;
  },
});

registerOp({
  key: 'resident.contact',
  name: 'Update a resident’s contact details',
  describe: 'Set or correct the email or phone on the primary resident of a household. Choose this for "update their email", "their new number is…", "fix the contact".',
  perm: 'residents:manage',
  risk: 'record',
  params: [
    { key: 'lease', type: 'lease', label: 'Household', required: true },
    { key: 'email', type: 'text', label: 'Email' },
    { key: 'phone', type: 'text', label: 'Phone' },
  ],
  preview(ctx, a) {
    const l = leaseRow(ctx, str(a.lease));
    if (!l) return { summary: '', changes: [], blockers: ['That household no longer exists.'], warnings: [] };
    const r = primaryResident(ctx, l.id);
    const email = str(a.email);
    const phone = str(a.phone);
    const blockers: string[] = [];
    if (!r) blockers.push('No primary resident is recorded on that household.');
    if (!email && !phone) blockers.push('Give an email or a phone number to set.');
    if (email && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) blockers.push(`“${email}” is not a usable email address.`);
    const changes = [{ label: 'Resident', value: r ? `${r.first_name} ${r.last_name}` : '—' }];
    if (email) changes.push({ label: 'Email', value: `${r?.email || 'none on file'} → ${email}` });
    if (phone) changes.push({ label: 'Phone', value: `${r?.phone || 'none on file'} → ${phone}` });
    return { summary: `Update contact details for ${l.household_name}.`, changes, blockers, warnings: [] };
  },
  apply(ctx, a) {
    const l = leaseRow(ctx, str(a.lease))!;
    const r = primaryResident(ctx, l.id)!;
    const email = str(a.email);
    const phone = str(a.phone);
    const before = { email: r.email, phone: r.phone };
    if (email) run('UPDATE residents SET email=? WHERE id=? AND org_id=?', email, r.id, ctx.orgId);
    if (phone) run('UPDATE residents SET phone=? WHERE id=? AND org_id=?', phone, r.id, ctx.orgId);
    audit(ctx, 'resident', r.id, 'contact_update', before, { email: email || r.email, phone: phone || r.phone, via: 'ask' });
    return `Updated ${r.first_name} ${r.last_name}.`;
  },
});

function primaryResident(ctx: Ctx, leaseId: string): { id: string; first_name: string; last_name: string; email: string | null; phone: string | null } | undefined {
  return q1(
    `SELECT r.id, r.first_name, r.last_name, r.email, r.phone
       FROM household_members hm JOIN residents r ON r.id=hm.resident_id
      WHERE hm.lease_id=? AND r.org_id=? ORDER BY CASE hm.role WHEN 'primary' THEN 0 ELSE 1 END LIMIT 1`,
    leaseId, ctx.orgId,
  );
}

registerOp({
  key: 'renewal.offer',
  name: 'Send a renewal offer',
  describe: 'Create and send the renewal offer for a household from the pricing matrix. Choose this for "offer them a renewal", "send the renewal".',
  perm: 'renewals:manage',
  risk: 'record',
  params: [{ key: 'lease', type: 'lease', label: 'Household', required: true }],
  preview(ctx, a) {
    const l = leaseRow(ctx, str(a.lease));
    if (!l) return { summary: '', changes: [], blockers: ['That household no longer exists.'], warnings: [] };
    const blockers: string[] = [];
    if (l.status === 'ended') blockers.push('That lease has already ended.');
    const open = val<number>(
      `SELECT COUNT(*) FROM ai_actions WHERE org_id=? AND entity='lease' AND entity_id=? AND agent='renewals' AND status='proposed'`,
      ctx.orgId, l.id,
    ) || 0;
    return {
      summary: `Offer ${l.household_name} a renewal on unit ${l.unit_number}.`,
      changes: [
        { label: 'Household', value: `${l.household_name} — ${l.prop_name}` },
        { label: 'Lease ends', value: fmtDate(l.end_date) },
        { label: 'Rent today', value: usd(l.rent_cents) },
      ],
      blockers,
      warnings: open ? [`${open} renewal action is already waiting in the approval queue for this household.`] : [],
    };
  },
  apply(ctx, a) {
    const offerId = createRenewalOffer(ctx, str(a.lease));
    return `Renewal offer ${offerId} created.`;
  },
});

// -------------------------------------------------- maintenance + vendors ----

const SLA_HOURS: Record<string, number> = { emergency: 4, urgent: 24, high: 48, normal: 72, low: 168 };

registerOp({
  key: 'wo.create',
  name: 'Create a work order',
  describe: 'Open a maintenance work order on a unit. Choose this for "create a work order", "log a repair", "something is broken in <unit>".',
  perm: 'workorders:manage',
  risk: 'record',
  params: [
    { key: 'unit', type: 'unit', label: 'Unit', required: true },
    { key: 'summary', type: 'text', label: 'What is wrong', required: true },
    { key: 'priority', type: 'enum', label: 'Priority', values: ['emergency', 'urgent', 'high', 'normal', 'low'] },
    { key: 'category', type: 'text', label: 'Category', hint: 'plumbing, electrical, hvac, appliance, general' },
  ],
  preview(ctx, a) {
    const u = q1<{ id: string; unit_number: string; property_id: string }>(
      'SELECT id, unit_number, property_id FROM units WHERE id=? AND org_id=?', str(a.unit), ctx.orgId);
    if (!u) return { summary: '', changes: [], blockers: ['That unit no longer exists.'], warnings: [] };
    const pri = str(a.priority) || 'normal';
    const blockers: string[] = [];
    if (!str(a.summary)) blockers.push('Say what is wrong — it becomes the work order’s title.');
    if (!(pri in SLA_HOURS)) blockers.push(`“${pri}” is not a priority we use.`);
    const hours = SLA_HOURS[pri] ?? 72;
    return {
      summary: `Open a ${pri} work order on unit ${u.unit_number}.`,
      changes: [
        { label: 'Unit', value: u.unit_number },
        { label: 'Summary', value: str(a.summary) || '—' },
        { label: 'Priority', value: pri },
        { label: 'Due', value: `${fmtDate(addDays(ctx.businessDate, Math.ceil(hours / 24)))} (${hours}h SLA)` },
      ],
      blockers, warnings: pri === 'emergency' ? ['Emergency work orders page the on-call tech immediately.'] : [],
    };
  },
  apply(ctx, a) {
    const u = q1<{ id: string; unit_number: string; property_id: string }>(
      'SELECT id, unit_number, property_id FROM units WHERE id=? AND org_id=?', str(a.unit), ctx.orgId)!;
    const lease = q1<{ id: string }>(
      `SELECT id FROM leases WHERE unit_id=? AND org_id=? AND status IN ('active','month_to_month','notice') ORDER BY created_at DESC LIMIT 1`,
      u.id, ctx.orgId);
    const pri = str(a.priority) || 'normal';
    const hours = SLA_HOURS[pri] ?? 72;
    const woId = id('wo');
    insert('work_orders', {
      id: woId, org_id: ctx.orgId, property_id: u.property_id, unit_id: u.id,
      lease_id: lease?.id || null, resident_id: null,
      category: str(a.category) || 'other', priority: pri, status: 'triaged',
      summary: str(a.summary), description: null,
      permission_to_enter: 1, pet_on_premises: 0, source: 'staff',
      sla_hours: hours, sla_due: addDays(ctx.businessDate, Math.ceil(hours / 24)),
      created_date: ctx.businessDate, created_by: ctx.userId, created_at: nowIso(),
    });
    woEvent(ctx, woId, 'status', 'Created from Ask StayLeased');
    audit(ctx, 'work_order', woId, 'create', null, { via: 'ask' });
    return `Work order opened on unit ${u.unit_number}.`;
  },
});

registerOp({
  key: 'wo.assign',
  name: 'Assign a work order',
  describe: 'Send an open work order to a vendor. Choose this for "assign it to <vendor>", "send that to <vendor>".',
  perm: 'workorders:assign',
  risk: 'record',
  params: [
    { key: 'workorder', type: 'workorder', label: 'Work order', required: true },
    { key: 'vendor', type: 'vendor', label: 'Vendor', required: true },
    { key: 'scheduled', type: 'date', label: 'Scheduled for' },
  ],
  preview(ctx, a) {
    const w = q1<{ id: string; summary: string; status: string; priority: string }>(
      'SELECT id, summary, status, priority FROM work_orders WHERE id=? AND org_id=?', str(a.workorder), ctx.orgId);
    const v = q1<{ name: string }>('SELECT name FROM vendors WHERE id=? AND org_id=?', str(a.vendor), ctx.orgId);
    const blockers: string[] = [];
    if (!w) blockers.push('That work order no longer exists.');
    if (!v) blockers.push('That vendor no longer exists.');
    if (w && ['completed', 'canceled'].includes(w.status)) blockers.push(`That work order is already ${w.status}.`);
    return {
      summary: w && v ? `Assign “${w.summary}” to ${v.name}.` : '',
      changes: w && v ? [
        { label: 'Work order', value: w.summary },
        { label: 'Vendor', value: v.name },
        { label: 'Priority', value: w.priority },
        { label: 'Scheduled', value: str(a.scheduled) ? fmtDate(str(a.scheduled)) : 'not scheduled' },
      ] : [],
      blockers, warnings: [],
    };
  },
  apply(ctx, a) {
    assignWo(ctx, str(a.workorder), { vendorId: str(a.vendor), scheduledDate: str(a.scheduled) || undefined });
    const v = q1<{ name: string }>('SELECT name FROM vendors WHERE id=? AND org_id=?', str(a.vendor), ctx.orgId);
    return `Assigned to ${v?.name || 'the vendor'}.`;
  },
});

registerOp({
  key: 'wo.priority',
  name: 'Change a work order’s priority',
  describe: 'Re-prioritise an open work order, which resets its SLA. Choose this for "make it urgent", "bump the priority", "that is an emergency".',
  perm: 'workorders:manage',
  risk: 'record',
  params: [
    { key: 'workorder', type: 'workorder', label: 'Work order', required: true },
    { key: 'priority', type: 'enum', label: 'Priority', required: true, values: ['emergency', 'urgent', 'high', 'normal', 'low'] },
  ],
  preview(ctx, a) {
    const w = q1<{ summary: string; priority: string; status: string }>(
      'SELECT summary, priority, status FROM work_orders WHERE id=? AND org_id=?', str(a.workorder), ctx.orgId);
    const pri = str(a.priority);
    const blockers: string[] = [];
    if (!w) blockers.push('That work order no longer exists.');
    if (!(pri in SLA_HOURS)) blockers.push(`“${pri}” is not a priority we use.`);
    if (w && ['completed', 'canceled'].includes(w.status)) blockers.push(`That work order is already ${w.status}.`);
    return {
      summary: w ? `Change “${w.summary}” from ${w.priority} to ${pri}.` : '',
      changes: w ? [
        { label: 'Work order', value: w.summary },
        { label: 'Priority', value: `${w.priority} → ${pri}` },
        { label: 'New SLA', value: `${SLA_HOURS[pri] ?? 72} hours` },
      ] : [],
      blockers, warnings: [],
    };
  },
  apply(ctx, a) {
    triageWo(ctx, str(a.workorder), { priority: str(a.priority) });
    return `Priority set to ${str(a.priority)}.`;
  },
});

registerOp({
  key: 'wo.close',
  name: 'Close a work order',
  describe: 'Mark an open work order completed, with a closing note. Choose this for "close that work order", "it is fixed", "mark it done".',
  perm: 'workorders:manage',
  risk: 'record',
  params: [
    { key: 'workorder', type: 'workorder', label: 'Work order', required: true },
    { key: 'note', type: 'text', label: 'What was done' },
  ],
  preview(ctx, a) {
    const w = q1<{ summary: string; status: string }>(
      'SELECT summary, status FROM work_orders WHERE id=? AND org_id=?', str(a.workorder), ctx.orgId);
    const blockers: string[] = [];
    if (!w) blockers.push('That work order no longer exists.');
    if (w && ['completed', 'canceled'].includes(w.status)) blockers.push(`That work order is already ${w.status}.`);
    return {
      summary: w ? `Close “${w.summary}”.` : '',
      changes: w ? [
        { label: 'Work order', value: w.summary },
        { label: 'Status', value: `${w.status} → completed` },
        { label: 'Note', value: str(a.note) || '—' },
      ] : [],
      blockers, warnings: [],
    };
  },
  apply(ctx, a) {
    transitionWo(ctx, str(a.workorder), 'completed', str(a.note) || 'Closed from Ask StayLeased');
    return 'Work order closed.';
  },
});

// ---------------------------------------------------------------- admin ----

registerOp({
  key: 'clock.advance',
  name: 'Advance the business date',
  describe: 'Move the simulated business date forward, running every scheduled job for each day passed. Choose this for "advance the date", "move to <date>", "run the clock forward".',
  perm: 'admin:jobs',
  risk: 'admin',
  params: [{ key: 'to', type: 'date', label: 'New business date', required: true }],
  preview(ctx, a) {
    const to = str(a.to);
    const blockers: string[] = [];
    if (!to) blockers.push('A target date is required.');
    else if (to <= ctx.businessDate) blockers.push(`${fmtDate(to)} is not after the current business date, ${fmtDate(ctx.businessDate)}.`);
    const days = to && to > ctx.businessDate
      ? Math.round((Date.parse(to) - Date.parse(ctx.businessDate)) / 86400000) : 0;
    return {
      summary: `Advance the business date to ${to ? fmtDate(to) : '—'}.`,
      changes: [
        { label: 'From', value: fmtDate(ctx.businessDate) },
        { label: 'To', value: to ? fmtDate(to) : '—' },
        { label: 'Days processed', value: String(days) },
      ],
      blockers,
      warnings: days > 31
        ? [`${days} days of rent, late fees and scheduled jobs will post. This cannot be undone.`]
        : ['Rent, late fees and scheduled jobs run for each day passed. This cannot be undone.'],
    };
  },
  apply(ctx, a) {
    const r = advanceBusinessDate(ctx.orgId, str(a.to));
    return `Advanced ${r.days} day${r.days === 1 ? '' : 's'} to ${fmtDate(str(a.to))}.`;
  },
});
