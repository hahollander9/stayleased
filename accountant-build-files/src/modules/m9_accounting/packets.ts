import { q, q1, insert, run } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, addMonths, firstOfMonth, fmtMonth, monthKey } from '../../lib/dates.ts';
import type { Ctx } from '../../lib/auth.ts';
import { can } from '../../lib/auth.ts';
import { audit } from '../../lib/audit.ts';
import { balanceSheet, incomeStatement, t12, cashFlow, toCsv, type Basis } from './statements.ts';
import { Pdf } from '../../lib/pdf.ts';
import { usd } from '../../lib/money.ts';

/** M9.11 — statement packets: a saved statement pull (accountant-feedback
 * build). One packet = scope + basis, saved once; opening it renders the
 * trailing-12 income statement, balance sheet, and cash flow together, with
 * one-click CSV and PDF exports. Built because pulling statements for
 * stakeholders one at a time, re-picking the same settings every month, is
 * exactly the tedium accountants describe. */

export interface PacketInput { name: string; propertyId?: string | null; basis: Basis; shared?: boolean }

export function createPacket(ctx: Ctx, input: PacketInput): string {
  if (!input.name.trim()) throw new Error('packet needs a name');
  const pid = id('pkt');
  insert('statement_packets', {
    id: pid, org_id: ctx.orgId, name: input.name.trim().slice(0, 80),
    property_id: input.propertyId || null, basis: input.basis === 'cash' ? 'cash' : 'accrual',
    shared: input.shared === false ? 0 : 1, created_by: ctx.userId || null, created_at: nowIso(),
  });
  audit(ctx, 'statement_packet', pid, 'create', null, { name: input.name, propertyId: input.propertyId || null, basis: input.basis });
  return pid;
}

export function deletePacket(ctx: Ctx, packetId: string): void {
  const p = q1<any>('SELECT * FROM statement_packets WHERE id=? AND org_id=?', packetId, ctx.orgId);
  if (!p) throw new Error('packet not found');
  if (p.created_by && p.created_by !== ctx.userId && !can(ctx, 'admin:settings')) {
    throw new Error('only the creator (or an admin) can delete a packet');
  }
  run('DELETE FROM statement_packets WHERE id=?', packetId);
  audit(ctx, 'statement_packet', packetId, 'delete');
}

export function getPacket(ctx: Ctx, packetId: string): any | null {
  const p = q1<any>(
    `SELECT sp.*, pr.name AS property_name FROM statement_packets sp
     LEFT JOIN properties pr ON pr.id=sp.property_id
     WHERE sp.id=? AND sp.org_id=?`, packetId, ctx.orgId,
  );
  if (!p) return null;
  if (!p.shared && p.created_by && p.created_by !== ctx.userId && !can(ctx, 'admin:settings')) return null;
  return p;
}

export function listPackets(ctx: Ctx): any[] {
  return q<any>(
    `SELECT sp.*, pr.name AS property_name FROM statement_packets sp
     LEFT JOIN properties pr ON pr.id=sp.property_id
     WHERE sp.org_id=? AND (sp.shared=1 OR sp.created_by=?) ORDER BY sp.name`,
    ctx.orgId, ctx.userId || '',
  );
}

export function packetScopeName(packet: any): string {
  return packet.property_id ? String(packet.property_name || 'Property') : 'Consolidated — all properties';
}

export function packetData(ctx: Ctx, packet: any, to: string): {
  from: string; to: string; basis: Basis; scope: string | null;
  is: ReturnType<typeof incomeStatement>; bs: ReturnType<typeof balanceSheet>;
  cf: ReturnType<typeof cashFlow>; grid: ReturnType<typeof t12>;
} {
  const basis = (packet.basis === 'cash' ? 'cash' : 'accrual') as Basis;
  const scope = (packet.property_id as string | null) || null;
  const from = firstOfMonth(addMonths(to, -11));
  return {
    from, to, basis, scope,
    is: incomeStatement(ctx, { propertyId: scope, from, to, basis }),
    bs: balanceSheet(ctx, { propertyId: scope, asOf: to, basis }),
    cf: cashFlow(ctx, { propertyId: scope, from, to, basis }),
    grid: t12(ctx, { propertyId: scope, to, basis }),
  };
}

/** One CSV, four sections: trailing-12 IS, BS, CF, and the T-12 grid. */
export function packetCsv(ctx: Ctx, packet: any, to: string): string {
  const d = packetData(ctx, packet, to);
  const rows: (string | number)[][] = [
    [String(packet.name)],
    ['Scope', packetScopeName(packet)],
    ['Basis', d.basis],
    ['Period', `${d.from} to ${to}`],
    [],
    ['INCOME STATEMENT — TRAILING 12 MONTHS'],
    ['Section', 'Code', 'Account', 'Amount'],
    ...d.is.income.map((l): (string | number)[] => ['Income', l.code, l.name, l.amount / 100]),
    ...d.is.expenses.map((l): (string | number)[] => ['Expenses', l.code, l.name, l.amount / 100]),
    ['', '', 'Net operating income', d.is.noi / 100],
    [],
    [`BALANCE SHEET — AS OF ${to}`],
    ['Section', 'Code', 'Account', 'Balance'],
    ...d.bs.assets.map((l): (string | number)[] => ['Assets', l.code, l.name, l.amount / 100]),
    ...d.bs.liabilities.map((l): (string | number)[] => ['Liabilities', l.code, l.name, l.amount / 100]),
    ...d.bs.equity.map((l): (string | number)[] => ['Equity', l.code, l.name, l.amount / 100]),
    [],
    ['CASH FLOW — TRAILING 12 MONTHS'],
    ['Section', 'Code', 'Source', 'Cash effect'],
    ...d.cf.operating.map((l): (string | number)[] => ['Operating', l.code, l.name, l.amount / 100]),
    ...d.cf.investing.map((l): (string | number)[] => ['Investing', l.code, l.name, l.amount / 100]),
    ...d.cf.financing.map((l): (string | number)[] => ['Financing', l.code, l.name, l.amount / 100]),
    ['', '', 'Net change in cash', d.cf.netChange / 100],
    [],
    ['TRAILING 12 BY MONTH'],
    ['Code', 'Account', ...d.grid.months, 'Total'],
    ...d.grid.rows.map((r): (string | number)[] => [r.code, r.name, ...r.cells.map((c) => c / 100), r.total / 100]),
  ];
  return toCsv(rows);
}

/** One PDF: header, trailing-12 IS, BS, CF (the month-by-month grid stays in CSV). */
export async function packetPdf(ctx: Ctx, packet: any, to: string): Promise<Uint8Array> {
  const d = packetData(ctx, packet, to);
  const pdf = await Pdf.create(String(packet.name));
  pdf.h1(String(packet.name));
  pdf.kv([
    ['Scope', packetScopeName(packet)],
    ['Basis', d.basis],
    ['Period', `${fmtMonth(monthKey(d.from))} – ${fmtMonth(monthKey(to))}`],
    ['Prepared', ctx.businessDate],
  ]);
  pdf.space(6);
  const cols = (amountLabel: string): { label: string; w: number; align?: 'left' | 'right' }[] => [
    { label: 'Section', w: 0.16 }, { label: 'Code', w: 0.1 }, { label: 'Account', w: 0.48 }, { label: amountLabel, w: 0.26, align: 'right' },
  ];
  pdf.text('Income statement — trailing 12 months', { size: 11 });
  pdf.table(cols('Amount'), [
    ...d.is.income.map((l) => ['Income', l.code, l.name, usd(l.amount)]),
    ...d.is.expenses.map((l) => ['Expenses', l.code, l.name, usd(l.amount)]),
  ], { totals: ['', '', 'Net operating income', usd(d.is.noi)] });
  pdf.space(6);
  pdf.text(`Balance sheet — as of ${to}`, { size: 11 });
  pdf.table(cols('Balance'), [
    ...d.bs.assets.map((l) => ['Assets', l.code, l.name, usd(l.amount)]),
    ['', '', 'Total assets', usd(d.bs.totals.assets)],
    ...d.bs.liabilities.map((l) => ['Liabilities', l.code, l.name, usd(l.amount)]),
    ...d.bs.equity.map((l) => ['Equity', l.code, l.name, usd(l.amount)]),
  ], { totals: ['', '', 'Liabilities + equity', usd(d.bs.totals.liabilities + d.bs.totals.equity)] });
  pdf.space(6);
  pdf.text('Cash flow — trailing 12 months', { size: 11 });
  pdf.table(cols('Cash effect'), [
    ...d.cf.operating.map((l) => ['Operating', l.code, l.name, usd(l.amount)]),
    ...d.cf.investing.map((l) => ['Investing', l.code, l.name, usd(l.amount)]),
    ...d.cf.financing.map((l) => ['Financing', l.code, l.name, usd(l.amount)]),
  ], { totals: ['', '', 'Net change in cash', usd(d.cf.netChange)] });
  pdf.space(6);
  pdf.text('The month-by-month trailing-12 grid is included in the CSV export.', { muted: true, size: 9 });
  return pdf.bytes();
}
