import { q, q1 } from '../../lib/db.ts';
import { usd } from '../../lib/money.ts';
import { fmtDate, fmtMonth, lastOfMonth } from '../../lib/dates.ts';
import type { Ctx } from '../../lib/auth.ts';
import { Pdf } from '../../lib/pdf.ts';
import { leaseLedger } from './service.ts';

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

/** Final account statement (deposit disposition) */
export async function sodaPdf(ctx: Ctx, leaseId: string): Promise<Uint8Array> {
  const l = q1<any>(
    `SELECT l.*, u.unit_number, p.name AS prop_name, p.address1, p.city, p.state, p.zip
     FROM leases l JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=l.property_id
     WHERE l.id=? AND l.org_id=?`,
    leaseId, ctx.orgId,
  );
  if (!l) throw new Error('lease not found');
  const activity = q<any>('SELECT * FROM deposit_activity WHERE lease_id=? ORDER BY date', leaseId);
  const damages = q<any>(`SELECT * FROM charges WHERE lease_id=? AND kind IN ('damage','other') AND date>=? AND status='active'`, leaseId, l.move_out_date || l.end_date);
  const refund = q1<any>(`SELECT * FROM refunds WHERE lease_id=? AND kind='deposit'`, leaseId);
  const applied = -activity.filter((a) => a.kind === 'apply').reduce((s, a) => s + a.amount_cents, 0);
  const refunded = -activity.filter((a) => a.kind === 'refund').reduce((s, a) => s + a.amount_cents, 0);

  const pdf = await Pdf.create(`Final account statement — ${l.household_name}`);
  pdf.brandHeader(l.prop_name, [`${l.address1}, ${l.city}, ${l.state} ${l.zip}`]);
  pdf.h1('Final account statement (security deposit disposition)');
  pdf.kv([
    ['Household', l.household_name],
    ['Unit', l.unit_number],
    ['Move-out date', fmtDate(l.move_out_date || l.end_date)],
    ['Deposit held', usd(l.deposit_cents)],
  ]);
  if (damages.length) {
    pdf.h2('Move-out charges');
    pdf.table(
      [
        { label: 'Date', w: 0.16 },
        { label: 'Item', w: 0.62 },
        { label: 'Amount', w: 0.22, align: 'right' },
      ],
      damages.map((d) => [fmtDate(d.date), d.label, usd(d.amount_cents)]),
      { totals: ['', 'Total move-out charges', usd(damages.reduce((s, d) => s + d.amount_cents, 0))] },
    );
  }
  pdf.h2('Disposition');
  pdf.kv([
    ['Applied to balance', usd(applied)],
    ['Refunded', refunded > 0 ? `${usd(refunded)} (check ${refund?.reference || ''})` : usd(0)],
  ]);
  pdf.space(6);
  pdf.text('You may dispute any item on this statement within 30 days by replying through the portal or writing to the office address above. This statement was prepared within the deadline required by applicable state rules (configurable per property).', { muted: true, size: 8.5 });
  pdf.footerAllPages(`${l.prop_name} · final account statement · generated ${fmtDate(ctx.businessDate)}`);
  return pdf.bytes();
}
