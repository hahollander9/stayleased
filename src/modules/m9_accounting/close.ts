import { q, q1, insert, run, val, tx, j, js } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, addMonths, monthKey, parts } from '../../lib/dates.ts';
import type { Ctx } from '../../lib/auth.ts';
import { can } from '../../lib/auth.ts';
import { emit } from '../../lib/events.ts';
import { audit } from '../../lib/audit.ts';
import { getSetting } from '../../lib/settings.ts';
import { registerJob } from '../../lib/jobs.ts';
import { postJE, runInvariants, type JELine } from './service.ts';

/** M9.3-4 — manual JEs with approval routing, recurring JEs, accounting
 * periods with an auto-evaluated close checklist. */

// ---------- close checklist + period lifecycle ----------

export interface ChecklistItem {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export function closeChecklist(ctx: Ctx, propertyId: string, periodKey: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const acct = q1<any>(`SELECT id FROM bank_accounts WHERE org_id=? AND property_id=? AND kind='operating'`, ctx.orgId, propertyId);
  const rec = acct
    ? q1<any>(`SELECT status FROM bank_recons WHERE bank_account_id=? AND period_key=?`, acct.id, periodKey)
    : null;
  items.push({
    key: 'bank_rec', label: 'Bank reconciliation completed',
    ok: rec?.status === 'completed',
    detail: rec ? `reconciliation ${rec.status}` : 'no reconciliation started for this month',
  });

  const draftInv = val<number>(
    `SELECT COUNT(*) FROM vendor_invoices WHERE org_id=? AND property_id=? AND status IN ('draft','pending_approval') AND substr(invoice_date,1,7)<=?`,
    ctx.orgId, propertyId, periodKey,
  ) || 0;
  items.push({
    key: 'ap_clear', label: 'No vendor invoices awaiting entry or approval',
    ok: draftInv === 0, detail: draftInv ? `${draftInv} invoice(s) still draft/pending` : 'AP queue clear',
  });

  const pendingJe = val<number>(
    `SELECT COUNT(*) FROM pending_jes WHERE org_id=? AND property_id=? AND status='pending' AND substr(date,1,7)<=?`,
    ctx.orgId, propertyId, periodKey,
  ) || 0;
  items.push({
    key: 'je_clear', label: 'No journal entries awaiting approval',
    ok: pendingJe === 0, detail: pendingJe ? `${pendingJe} JE(s) pending approval` : 'approval queue clear',
  });

  const rjeMissing = q<any>(
    `SELECT name FROM recurring_jes WHERE org_id=? AND property_id=? AND active=1 AND start_month<=?
       AND (end_month IS NULL OR end_month>=?) AND (last_posted_month IS NULL OR last_posted_month<?)`,
    ctx.orgId, propertyId, periodKey, periodKey, periodKey,
  );
  items.push({
    key: 'recurring', label: 'Recurring journal entries posted through the month',
    ok: rjeMissing.length === 0,
    detail: rjeMissing.length ? `unposted: ${rjeMissing.map((r) => r.name).join(', ')}` : 'all recurring entries posted',
  });

  const inv = runInvariants(ctx);
  items.push({
    key: 'subledger', label: 'Subledgers tie to control accounts (invariants green)',
    ok: inv.every((i) => i.ok),
    detail: inv.every((i) => i.ok) ? 'AR, deposits, clearing all tie' : inv.filter((i) => !i.ok).map((i) => i.name).join('; '),
  });

  const unsettled = val<number>(
    `SELECT COUNT(*) FROM payments WHERE org_id=? AND property_id=? AND status='pending' AND substr(received_date,1,7)<?`,
    ctx.orgId, propertyId, periodKey,
  ) || 0;
  items.push({
    key: 'settlements', label: 'No stale unsettled payments from prior months',
    ok: unsettled === 0, detail: unsettled ? `${unsettled} payment(s) still pending settlement` : 'settlement queue clear',
  });

  return items;
}

export function closePeriod(ctx: Ctx, propertyId: string, periodKey: string): void {
  const items = closeChecklist(ctx, propertyId, periodKey);
  const blocked = items.filter((i) => !i.ok);
  if (blocked.length) throw new Error(`close checklist incomplete: ${blocked.map((b) => b.label).join('; ')}`);
  const existing = q1<any>('SELECT * FROM accounting_periods WHERE org_id=? AND property_id=? AND period_key=?', ctx.orgId, propertyId, periodKey);
  tx(() => {
    if (existing) {
      run(`UPDATE accounting_periods SET status='closed', checklist=?, closed_at=?, closed_by=? WHERE id=?`, js(items), nowIso(), ctx.userName, existing.id);
    } else {
      insert('accounting_periods', {
        id: id('per'), org_id: ctx.orgId, property_id: propertyId, period_key: periodKey,
        status: 'closed', checklist: js(items), closed_at: nowIso(), closed_by: ctx.userName,
      });
    }
  });
  emit(ctx, 'period.closed', 'accounting_period', `${propertyId}:${periodKey}`, { propertyId, periodKey });
  audit(ctx, 'accounting_period', `${propertyId}:${periodKey}`, 'close');
}

export function reopenPeriod(ctx: Ctx, propertyId: string, periodKey: string, reason: string): void {
  if (!can(ctx, 'gl:reopen_period')) throw new Error('reopening a closed period requires elevated permission');
  if (!reason.trim()) throw new Error('a written reason is required to reopen a period');
  const existing = q1<any>('SELECT * FROM accounting_periods WHERE org_id=? AND property_id=? AND period_key=?', ctx.orgId, propertyId, periodKey);
  if (!existing || existing.status !== 'closed') throw new Error('period is not closed');
  run(`UPDATE accounting_periods SET status='open', closed_at=NULL, closed_by=NULL WHERE id=?`, existing.id);
  emit(ctx, 'period.reopened', 'accounting_period', existing.id, { propertyId, periodKey, reason });
  audit(ctx, 'accounting_period', existing.id, 'reopen', null, { reason });
}

/** month grid for the periods page: last 15 months × property */
export function periodGrid(ctx: Ctx, propertyId: string): { periodKey: string; status: string; closedBy?: string; closedAt?: string }[] {
  const out: { periodKey: string; status: string; closedBy?: string; closedAt?: string }[] = [];
  let m = monthKey(addMonths(ctx.businessDate, -14));
  const last = monthKey(ctx.businessDate);
  while (m <= last) {
    const row = q1<any>('SELECT * FROM accounting_periods WHERE org_id=? AND property_id=? AND period_key=?', ctx.orgId, propertyId, m);
    out.push({ periodKey: m, status: row?.status || 'open', closedBy: row?.closed_by, closedAt: row?.closed_at });
    const [y, mm] = [Number(m.slice(0, 4)), Number(m.slice(5, 7))];
    m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
  }
  return out;
}

// ---------- manual JEs with approval (M9.3) ----------

export function submitManualJe(
  ctx: Ctx,
  input: { propertyId: string; date: string; memo: string; basis: 'accrual' | 'cash' | 'both'; lines: JELine[] },
): { status: 'posted' | 'pending'; id: string } {
  const dr = input.lines.reduce((s, l) => s + (l.debit || 0), 0);
  const cr = input.lines.reduce((s, l) => s + (l.credit || 0), 0);
  if (dr !== cr || dr === 0) throw new Error(`entry must balance (DR ${dr} vs CR ${cr})`);
  const threshold = getSetting<number>(ctx, 'je_approval_threshold_cents', input.propertyId);
  if (dr > threshold && !can(ctx, 'gl:close_period')) {
    // large JEs route to the controller (close_period holders act as approvers)
    const pid = id('pje');
    insert('pending_jes', {
      id: pid, org_id: ctx.orgId, property_id: input.propertyId, date: input.date, memo: input.memo,
      lines: js(input.lines), basis: input.basis, status: 'pending', requested_by: ctx.userName, created_at: nowIso(),
    });
    emit(ctx, 'je.approval_requested', 'pending_je', pid, { amountCents: dr });
    audit(ctx, 'pending_je', pid, 'submit', null, { amountCents: dr });
    return { status: 'pending', id: pid };
  }
  const jeId = postManual(ctx, input, ctx.userName);
  return { status: 'posted', id: jeId };
}

function postManual(
  ctx: Ctx,
  input: { propertyId: string; date: string; memo: string; basis: 'accrual' | 'cash' | 'both'; lines: JELine[] },
  approvedBy: string | null,
): string {
  const bases: ('accrual' | 'cash')[] = input.basis === 'both' ? ['accrual', 'cash'] : [input.basis];
  let first = '';
  tx(() => {
    for (const basis of bases) {
      const jeId = postJE(ctx, {
        propertyId: input.propertyId, date: input.date, basis, memo: input.memo,
        sourceKind: 'manual', approvedBy: approvedBy || undefined, lines: input.lines,
      });
      first = first || jeId;
    }
  });
  audit(ctx, 'journal_entry', first, 'manual_post', null, { memo: input.memo });
  return first;
}

export function decidePendingJe(ctx: Ctx, pendingId: string, approve: boolean, reason?: string): string | null {
  const p = q1<any>('SELECT * FROM pending_jes WHERE id=? AND org_id=?', pendingId, ctx.orgId);
  if (!p || p.status !== 'pending') throw new Error('entry is not pending');
  if (!approve) {
    run(`UPDATE pending_jes SET status='rejected', decided_by=?, decided_at=?, reject_reason=? WHERE id=?`, ctx.userName, nowIso(), reason || null, pendingId);
    audit(ctx, 'pending_je', pendingId, 'reject', null, { reason });
    return null;
  }
  const jeId = postManual(
    ctx,
    { propertyId: p.property_id, date: p.date, memo: p.memo, basis: p.basis, lines: j<JELine[]>(p.lines, []) },
    ctx.userName,
  );
  run(`UPDATE pending_jes SET status='posted', decided_by=?, decided_at=?, je_id=? WHERE id=?`, ctx.userName, nowIso(), jeId, pendingId);
  audit(ctx, 'pending_je', pendingId, 'approve', null, { jeId });
  return jeId;
}

// ---------- recurring JEs (M9.3) ----------

export function createRecurringJe(
  ctx: Ctx,
  input: { propertyId: string; name: string; memo?: string; lines: JELine[]; dayOfMonth: number; startMonth: string; endMonth?: string | null; basis?: 'accrual' | 'cash' | 'both' },
): string {
  const dr = input.lines.reduce((s, l) => s + (l.debit || 0), 0);
  const cr = input.lines.reduce((s, l) => s + (l.credit || 0), 0);
  if (dr !== cr || dr === 0) throw new Error('recurring entry must balance');
  const rid = id('rje');
  insert('recurring_jes', {
    id: rid, org_id: ctx.orgId, property_id: input.propertyId, name: input.name, memo: input.memo || null,
    lines: js(input.lines), day_of_month: input.dayOfMonth, start_month: input.startMonth,
    end_month: input.endMonth ?? null, basis: input.basis || 'both', active: 1,
    created_by: ctx.userName, created_at: nowIso(),
  });
  audit(ctx, 'recurring_je', rid, 'create', null, { name: input.name });
  return rid;
}

/** post everything due through `date` (catches up months on big advances) */
export function runRecurringJes(ctx: Ctx, date: string): number {
  const mk = monthKey(date);
  const day = parts(date).day;
  let posted = 0;
  for (const r of q<any>(`SELECT * FROM recurring_jes WHERE org_id=? AND active=1`, ctx.orgId)) {
    let m = r.last_posted_month ? nextMonth(r.last_posted_month) : r.start_month;
    while (m <= mk && (!r.end_month || m <= r.end_month) && m >= r.start_month) {
      if (m === mk && day < r.day_of_month) break; // not due yet this month
      const bases: ('accrual' | 'cash')[] = r.basis === 'both' ? ['accrual', 'cash'] : [r.basis];
      const postDate = `${m}-${String(Math.min(r.day_of_month, 28)).padStart(2, '0')}`;
      for (const basis of bases) {
        postJE(ctx, {
          propertyId: r.property_id, date: postDate, basis,
          memo: `${r.name}${r.memo ? ` — ${r.memo}` : ''}`, sourceKind: 'recurring', sourceId: r.id,
          lines: j<JELine[]>(r.lines, []),
        });
      }
      run('UPDATE recurring_jes SET last_posted_month=? WHERE id=?', m, r.id);
      r.last_posted_month = m;
      posted++;
      m = nextMonth(m);
    }
  }
  return posted;
}

function nextMonth(mk: string): string {
  const [y, m] = [Number(mk.slice(0, 4)), Number(mk.slice(5, 7))];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

registerJob({
  key: 'recurring_jes',
  name: 'Recurring journal entries',
  describe: 'Posts recurring JEs (amortizations, accrual templates) on their day of month; catches up after long advances.',
  run: (ctx, date) => {
    const n = runRecurringJes(ctx, date);
    return n ? `${n} recurring entr${n === 1 ? 'y' : 'ies'} posted` : 'nothing due';
  },
});
