import { q, q1 } from '../../lib/db.ts';
import { usd } from '../../lib/money.ts';
import { fmtDate, fmtMonth, lastOfMonth } from '../../lib/dates.ts';
import type { Ctx } from '../../lib/auth.ts';
import { Pdf } from '../../lib/pdf.ts';
import { leaseLedger, leaseBalance } from './service.ts';
import { depositHeld, openCharges } from './payments.ts';

/** Monthly resident statement PDF (M7.2) + final account statement (SODA, M8.6). */

export async function statementPdf(ctx: Ctx, leaseId: string, mk: string): Promise<Uint8Array> {
  const l = q1<any>(
    `SELECT l.*, u.unit_number, p.name AS prop_name, p.address1, p.city, p.state, p.zip
     FROM leases l JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=l.property_id
     WHERE l.id=? AND l.org_id=?`,
    leaseId, ctx.orgId,
  );
  if (!l) throw new Error('lease not found');
  const monthStart = mk + '-01';
  const monthEnd = lastOfMonth(monthStart);
  const ledger = leaseLedger(ctx, leaseId);
  const before = ledger.filter((r) => r.date < monthStart);
  const inMonth = ledger.filter((r) => r.date >= monthStart && r.date <= monthEnd);
  const opening = before.length ? before[before.length - 1]!.balance : 0;
  const closing = inMonth.length ? inMonth[inMonth.length - 1]!.balance : opening;

  const pdf = await Pdf.create(`Statement ${mk} — ${l.household_name}`);
  pdf.brandHeader(l.prop_name, [`${l.address1}, ${l.city}, ${l.state} ${l.zip}`]);
  pdf.h1(`Resident statement — ${fmtMonth(mk)}`);
  pdf.kv([
    ['Household', l.household_name],
    ['Unit', l.unit_number],
    ['Statement period', `${fmtDate(monthStart)} – ${fmtDate(monthEnd)}`],
    ['Opening balance', usd(opening)],
    ['Closing balance', usd(closing)],
  ]);
  pdf.space(4);
  pdf.table(
    [
      { label: 'Date', w: 0.14 },
      { label: 'Description', w: 0.46 },
      { label: 'Charges', w: 0.13, align: 'right' },
      { label: 'Payments', w: 0.13, align: 'right' },
      { label: 'Balance', w: 0.14, align: 'right' },
    ],
    inMonth.length
      ? inMonth.map((r) => [
          fmtDate(r.date),
          r.label,
          r.charge_cents ? usd(r.charge_cents) : '',
          r.credit_cents ? usd(r.credit_cents) : '',
          usd(r.balance),
        ])
      : [['—', 'No activity this period', '', '', usd(opening)]],
    { zebra: true, totals: ['', 'Closing balance', '', '', usd(closing)] },
  );
  pdf.space(8);
  pdf.text('Questions about a line item? Reply through the resident portal or contact the office. Payments made after the period end appear on the next statement.', { muted: true, size: 8.5 });
  pdf.footerAllPages(`${l.prop_name} · resident statement · generated ${fmtDate(ctx.businessDate)}`);
  return pdf.bytes();
}

/** Final account statement — the itemized security-deposit statement.
 *
 * Itemized from what the books actually did: every line under "Applied from
 * the deposit" is a charge the deposit paid, read from the disposition's own
 * applications, so the statement cannot disagree with the ledger. Before the
 * disposition is finalized it prints as a draft listing what is open. A
 * refund is described as paid only when a check has been recorded. */
export async function sodaPdf(ctx: Ctx, leaseId: string): Promise<Uint8Array> {
  const l = q1<any>(
    `SELECT l.*, u.unit_number, p.name AS prop_name, p.address1, p.city, p.state, p.zip
     FROM leases l JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=l.property_id
     WHERE l.id=? AND l.org_id=?`,
    leaseId, ctx.orgId,
  );
  if (!l) throw new Error('lease not found');
  const activity = q<any>('SELECT * FROM deposit_activity WHERE org_id=? AND lease_id=? ORDER BY date', ctx.orgId, leaseId);
  const interest = activity.filter((a) => a.kind === 'interest').reduce((s, a) => s + a.amount_cents, 0);
  const applied = -activity.filter((a) => a.kind === 'apply').reduce((s, a) => s + a.amount_cents, 0);
  const refunds = q<any>(`SELECT * FROM refunds WHERE org_id=? AND lease_id=? AND kind='deposit' ORDER BY created_at`, ctx.orgId, leaseId);
  const paid = refunds.filter((r) => r.status === 'issued');
  const owed = refunds.filter((r) => r.status === 'pending');
  const refundPaid = paid.reduce((s, r) => s + r.amount_cents, 0);
  const refundOwed = owed.reduce((s, r) => s + r.amount_cents, 0);
  const stillHeld = depositHeld(ctx, leaseId);
  const finalized = applied > 0 || refunds.length > 0;
  // everything the deposit amounted to: what is left, plus what already went out
  const total = stillHeld + refundOwed + refundPaid + applied;
  const balance = leaseBalance(ctx, leaseId);

  // what the deposit paid, charge by charge
  const items = q<any>(
    `SELECT c.date, c.label, c.kind, SUM(pa.amount_cents) AS amount
     FROM payment_applications pa
     JOIN payments p ON p.id=pa.payment_id AND p.method='credit' AND p.amount_cents>0 AND p.status='settled'
       AND p.memo='security deposit applied at move-out'
     JOIN charges c ON c.id=pa.charge_id
     WHERE pa.org_id=? AND p.lease_id=? GROUP BY c.id ORDER BY c.date, c.created_at`,
    ctx.orgId, leaseId,
  );
  // damage is itemized whenever it was posted (inspections often follow the
  // move-out date, and a charge posted before it is no less a deduction)
  const open = finalized ? [] : openCharges(ctx, leaseId).filter((c) => c.kind !== 'deposit');
  const openLabels = new Map<string, string>(
    open.length
      ? q<any>(`SELECT id, label, date FROM charges WHERE org_id=? AND lease_id=?`, ctx.orgId, leaseId).map((c) => [c.id as string, `${c.label}`])
      : [],
  );
  const moveOut = l.move_out_date || (l.status === 'ended' ? l.end_date : null);

  const pdf = await Pdf.create(`Final account statement — ${l.household_name}`);
  pdf.brandHeader(l.prop_name, [`${l.address1}, ${l.city}, ${l.state} ${l.zip}`]);
  pdf.h1(finalized ? 'Final account statement (security deposit disposition)' : 'Draft final account statement — not yet finalized');
  pdf.kv([
    ['Household', l.household_name],
    ['Unit', l.unit_number],
    ['Move-out date', moveOut ? fmtDate(moveOut) : 'not recorded'],
    ['Security deposit', usd(total - interest)],
    ...(interest ? [['Interest earned', usd(interest)] as [string, string]] : []),
    ['Total deposit to account for', usd(total)],
  ]);
  if (finalized) {
    pdf.h2('Applied from the deposit');
    pdf.table(
      [
        { label: 'Date', w: 0.16 },
        { label: 'Item', w: 0.62 },
        { label: 'Amount', w: 0.22, align: 'right' },
      ],
      items.length
        ? items.map((d) => [fmtDate(d.date), d.kind === 'damage' ? `${d.label} (damage)` : d.label, usd(d.amount)])
        : [['—', 'Nothing was withheld', usd(0)]],
      { totals: ['', 'Total applied from the deposit', usd(applied)] },
    );
  } else {
    pdf.h2('Charges open on the account');
    pdf.table(
      [
        { label: 'Due', w: 0.16 },
        { label: 'Item', w: 0.62 },
        { label: 'Open', w: 0.22, align: 'right' },
      ],
      open.length
        ? open.map((c) => [fmtDate(c.due_date), openLabels.get(c.id) || c.kind, usd(c.amount_cents - c.applied)])
        : [['—', 'No open charges', usd(0)]],
      { totals: ['', 'Account balance', usd(balance)] },
    );
  }
  pdf.h2('Disposition');
  const rows: [string, string][] = [
    ['Total deposit', usd(total)],
    ['Applied to the account', usd(applied)],
  ];
  for (const r of paid) rows.push(['Refund paid', `${usd(r.amount_cents)} — check ${r.reference || ''} dated ${fmtDate(r.date)}`]);
  for (const r of owed) rows.push(['Refund owed to you', `${usd(r.amount_cents)} — check to follow`]);
  if (!finalized) rows.push(['Deposit still held', usd(stillHeld)]);
  if (balance > 0) rows.push([finalized ? 'Balance still owed after the deposit' : 'Account balance today', usd(balance)]);
  pdf.kv(rows);
  pdf.space(6);
  pdf.text(
    finalized
      ? 'To question or dispute any item on this statement, write to the office at the address above.'
      : 'This is a draft for review. Amounts can change until the disposition is finalized.',
    { muted: true, size: 8.5 },
  );
  pdf.footerAllPages(`${l.prop_name} · ${finalized ? 'final account statement' : 'draft final account statement'} · generated ${fmtDate(ctx.businessDate)}`);
  return pdf.bytes();
}
