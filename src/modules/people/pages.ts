import { html, raw, when } from '../../lib/html.ts';
import { redirect, notFound, type Router, type Rq } from '../../lib/http.ts';
import { requirePerm, propFilter, canAccessProperty, type Ctx } from '../../lib/auth.ts';
import { q, q1, val, j } from '../../lib/db.ts';
import { fmtDate, diffDays } from '../../lib/dates.ts';
import { usd } from '../../lib/money.ts';
import {
  shell, card, tbl, kpis, dl, tabs, statusBadge, field, select, registerNav, registerSearch,
  historyPanel, pager, emptyState, input,
} from '../../ui/ui.ts';
import { leaseLedger, leaseBalance } from '../m8_receivables/service.ts';

registerNav('Residents', { href: '/residents', label: 'Residents', perm: 'residents:view', match: ['/residents'] });
registerNav('Residents', { href: '/leases', label: 'Leases', perm: 'leases:view', match: ['/leases'] });

registerSearch((ctx, query) => {
  if (!ctx.perms.has('residents:view')) return [];
  const like = `%${query}%`;
  const pf = propFilter(ctx, 'r.property_id');
  return q<any>(
    `SELECT r.id, r.first_name || ' ' || r.last_name AS name, r.email, p.name AS prop
     FROM residents r JOIN properties p ON p.id=r.property_id
     WHERE r.org_id=? AND (r.first_name || ' ' || r.last_name LIKE ? OR r.email LIKE ?)${pf.sql} LIMIT 7`,
    ctx.orgId, like, like, ...pf.params,
  ).map((r) => ({ kind: 'resident', label: r.name, sub: r.prop, href: `/residents/${r.id}` }));
});

const LEASE_STATUSES = ['active', 'month_to_month', 'notice', 'draft', 'out_for_signature', 'partially_signed', 'fully_executed', 'ended', 'renewed', 'canceled'];

export function routes(r: Router): void {
  // ---------- residents ----------
  r.get('/residents', requirePerm('residents:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const pf = propFilter(ctx, 'l.property_id');
    const query = rq.query.get('q') || '';
    const params: unknown[] = [ctx.orgId, ...pf.params];
    let where = `l.org_id=? AND l.status IN ('active','month_to_month','notice')${pf.sql} AND hm.role IN ('primary','co')`;
    if (query) { where += ` AND (r.first_name || ' ' || r.last_name LIKE ? OR r.email LIKE ? OR u.unit_number LIKE ?)`; params.push(`%${query}%`, `%${query}%`, `%${query}%`); }
    const total = val<number>(
      `SELECT COUNT(*) FROM household_members hm JOIN leases l ON l.id=hm.lease_id JOIN residents r ON r.id=hm.resident_id JOIN units u ON u.id=l.unit_id WHERE ${where}`,
      ...params,
    );
    const page = Math.max(1, parseInt(rq.query.get('page') || '1', 10) || 1);
    const rows = q<any>(
      `SELECT r.id, r.first_name, r.last_name, r.email, r.phone, hm.role, l.id AS lease_id, l.status AS lease_status,
              u.unit_number, p.name AS prop_name, l.end_date
       FROM household_members hm JOIN leases l ON l.id=hm.lease_id JOIN residents r ON r.id=hm.resident_id
       JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=l.property_id
       WHERE ${where} ORDER BY r.last_name, r.first_name LIMIT 50 OFFSET ?`,
      ...params, (page - 1) * 50,
    );
    return shell(rq, {
      title: 'Residents',
      active: '/residents',
      subtitle: `${total} adults on current leases`,
      content: html`
        <form method="get" class="toolbar">
          ${field('Search', input('q', { value: query, placeholder: 'Name, email, or unit…', type: 'search' }))}
          <button class="btn btn-ghost">Filter</button>
        </form>
        ${card(null, html`${tbl(
          [{ label: 'Resident' }, { label: 'Unit' }, { label: 'Property' }, { label: 'Role' }, { label: 'Lease' }, { label: 'Balance', num: true }],
          rows.map((x) => {
            const bal = leaseBalance(ctx, x.lease_id);
            return {
              href: `/residents/${x.id}`,
              cells: [
                html`<b>${x.first_name} ${x.last_name}</b><span class="sub">${x.email || ''}</span>`,
                x.unit_number, x.prop_name, statusBadge(undefined, x.role), statusBadge(x.lease_status),
                html`<span class="${bal > 0 ? 'neg' : ''}">${usd(bal)}</span>`,
              ],
            };
          }),
          { empty: 'No residents match.' },
        )}${pager(rq, total)}`, { flush: true })}`,
    });
  });

  r.get('/residents/:id', requirePerm('residents:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const res = q1<any>('SELECT * FROM residents WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!res || !canAccessProperty(ctx, res.property_id)) return notFound('Resident not found');
    const memberships = q<any>(
      `SELECT hm.role, l.*, u.unit_number, p.name AS prop_name FROM household_members hm
       JOIN leases l ON l.id=hm.lease_id JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=l.property_id
       WHERE hm.resident_id=? ORDER BY l.start_date DESC`,
      res.id,
    );
    const pets = q<any>(`SELECT pt.* FROM pets pt WHERE pt.lease_id IN (SELECT lease_id FROM household_members WHERE resident_id=?)`, res.id);
    const vehicles = q<any>(`SELECT vh.* FROM vehicles vh WHERE vh.lease_id IN (SELECT lease_id FROM household_members WHERE resident_id=?)`, res.id);
    return shell(rq, {
      title: `${res.first_name} ${res.last_name}`,
      active: '/residents',
      crumbs: [['Residents', '/residents']],
      subtitle: html`${statusBadge(undefined, res.kind)} ${res.email || ''}`,
      content: html`
        <div class="grid cols-2">
          ${card('Contact & profile', dl([
            ['Email', res.email || '—'],
            ['Phone', res.phone || '—'],
            ['Employer', res.employer || '—'],
            ['Monthly income', res.monthly_income_cents ? usd(res.monthly_income_cents) : '—'],
            ['Portal account', res.user_id ? statusBadge('active', 'enabled') : statusBadge(undefined, 'none')],
          ]))}
          ${card('Household extras', html`
            ${dl([
              ['Pets', pets.length ? pets.map((x) => `${x.name} (${x.species}${x.breed ? ` · ${x.breed}` : ''})`).join(', ') : 'None'],
              ['Vehicles', vehicles.length ? vehicles.map((x) => `${x.make} ${x.model} · ${x.plate}`).join(', ') : 'None'],
            ])}`)}
        </div>
        ${card('Leases', tbl(
          [{ label: 'Unit' }, { label: 'Property' }, { label: 'Role' }, { label: 'Status' }, { label: 'Term' }, { label: 'Rent', num: true }, { label: 'Balance', num: true }],
          memberships.map((m) => {
            const bal = leaseBalance(ctx, m.id);
            return {
              href: `/leases/${m.id}`,
              cells: [
                html`<b>${m.unit_number}</b>`, m.prop_name, statusBadge(undefined, m.role), statusBadge(m.status),
                `${fmtDate(m.start_date)} → ${fmtDate(m.end_date)}`, usd(m.rent_cents),
                html`<span class="${bal > 0 ? 'neg' : ''}">${usd(bal)}</span>`,
              ],
            };
          }),
          { empty: 'No leases.' },
        ), { flush: true })}
        ${card('History', historyPanel(ctx.orgId, 'resident', res.id))}`,
    });
  });

  // ---------- leases ----------
  r.get('/leases', requirePerm('leases:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const pf = propFilter(ctx, 'l.property_id');
    const status = rq.query.get('status') || '';
    const params: unknown[] = [ctx.orgId, ...pf.params];
    let where = `l.org_id=?${pf.sql}`;
    if (status) { where += ' AND l.status=?'; params.push(status); }
    else { where += " AND l.status IN ('active','month_to_month','notice')"; }
    const total = val<number>(`SELECT COUNT(*) FROM leases l WHERE ${where}`, ...params);
    const page = Math.max(1, parseInt(rq.query.get('page') || '1', 10) || 1);
    const rows = q<any>(
      `SELECT l.*, u.unit_number, p.name AS prop_name FROM leases l
       JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=l.property_id
       WHERE ${where} ORDER BY l.end_date LIMIT 50 OFFSET ?`,
      ...params, (page - 1) * 50,
    );
    return shell(rq, {
      title: 'Leases',
      active: '/leases',
      subtitle: `${total} lease${total === 1 ? '' : 's'}${status ? ` · ${status}` : ' · current'}`,
      content: html`
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Status', select('status', LEASE_STATUSES.map((s): [string, string] => [s, s.replaceAll('_', ' ')]), status, { blank: 'Current (active/MTM/notice)' }))}
        </form>
        ${card(null, html`${tbl(
          [{ label: 'Household' }, { label: 'Unit' }, { label: 'Property' }, { label: 'Status' }, { label: 'Ends' }, { label: 'Rent', num: true }, { label: 'Balance', num: true }],
          rows.map((l) => {
            const bal = leaseBalance(ctx, l.id);
            const daysToEnd = diffDays(l.end_date, ctx.businessDate);
            return {
              href: `/leases/${l.id}`,
              cells: [
                html`<b>${l.household_name}</b>`,
                l.unit_number, l.prop_name, statusBadge(l.status),
                html`${fmtDate(l.end_date)}${l.status === 'active' && daysToEnd <= 90 ? html` <span class="badge warn">${daysToEnd}d</span>` : ''}`,
                usd(l.rent_cents),
                html`<span class="${bal > 0 ? 'neg' : ''}">${usd(bal)}</span>`,
              ],
            };
          }),
          { empty: 'No leases match.' },
        )}${pager(rq, total)}`, { flush: true })}`,
    });
  });

  r.get('/leases/:id', requirePerm('leases:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const l = q1<any>(
      `SELECT l.*, u.unit_number, u.id AS unit_id, p.name AS prop_name, p.id AS prop_id FROM leases l
       JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=l.property_id WHERE l.id=? AND l.org_id=?`,
      rq.params.id!, ctx.orgId,
    );
    if (!l || !canAccessProperty(ctx, l.prop_id)) return notFound('Lease not found');
    const tab = rq.query.get('tab') || 'ledger';
    const household = q<any>(
      `SELECT r.*, hm.role FROM household_members hm JOIN residents r ON r.id=hm.resident_id WHERE hm.lease_id=? ORDER BY CASE hm.role WHEN 'primary' THEN 0 WHEN 'co' THEN 1 WHEN 'guarantor' THEN 2 ELSE 3 END`,
      l.id,
    );
    const schedule = q<any>('SELECT * FROM lease_charges WHERE lease_id=? ORDER BY amount_cents DESC', l.id);
    const bal = leaseBalance(ctx, l.id);
    const extras = leaseExtraTabs.map((fn) => fn(ctx, l)).filter(Boolean) as { key: string; label: string; render: () => any }[];

    const tabItems = [
      { href: `/leases/${l.id}?tab=ledger`, label: 'Ledger', active: tab === 'ledger' },
      { href: `/leases/${l.id}?tab=overview`, label: 'Household & terms', active: tab === 'overview' },
      ...extras.map((e) => ({ href: `/leases/${l.id}?tab=${e.key}`, label: e.label, active: tab === e.key })),
      { href: `/leases/${l.id}?tab=history`, label: 'History', active: tab === 'history' },
    ];

    let body;
    const extra = extras.find((e) => e.key === tab);
    if (extra) {
      body = extra.render();
    } else if (tab === 'overview') {
      body = html`
        <div class="grid cols-2">
          ${card('Terms', dl([
            ['Unit', html`<a href="/units/${l.unit_id}">${l.unit_number}</a> · ${l.prop_name}`],
            ['Status', statusBadge(l.status)],
            ['Term', `${fmtDate(l.start_date)} → ${fmtDate(l.end_date)} (${l.term_months} mo)`],
            ['Move-in', fmtDate(l.move_in_date)],
            ...(l.notice_date ? [['Notice given', fmtDate(l.notice_date)] as [any, any]] : []),
            ...(l.move_out_date ? [['Move-out', fmtDate(l.move_out_date)] as [any, any]] : []),
            ['Rent', usd(l.rent_cents)],
            ['Deposit', l.deposit_alternative ? html`${usd(0)} <span class="badge violet">deposit alternative</span>` : usd(l.deposit_cents)],
          ]))}
          ${card('Household', tbl(
            [{ label: 'Person' }, { label: 'Role' }, { label: 'Contact' }],
            household.map((h) => ({
              href: `/residents/${h.id}`,
              cells: [html`<b>${h.first_name} ${h.last_name}</b>`, statusBadge(undefined, h.role), html`<span class="small">${h.email || h.phone || '—'}</span>`],
            })),
          ), { flush: true })}
        </div>
        ${card('Recurring charge schedule', tbl(
          [{ label: 'Charge' }, { label: 'Kind' }, { label: 'Window' }, { label: 'Monthly', num: true }],
          schedule.map((s) => ({
            cells: [s.label, statusBadge(undefined, s.kind), s.start_date || s.end_date ? `${s.start_date ? fmtDate(s.start_date) : '…'} → ${s.end_date ? fmtDate(s.end_date) : 'ongoing'}` : 'ongoing', usd(s.amount_cents)],
          })),
          { empty: 'No recurring charges configured.', foot: ['Total', '', '', usd(schedule.reduce((s, x) => s + x.amount_cents, 0))] },
        ), { flush: true })}`;
    } else if (tab === 'history') {
      body = card('History', historyPanel(ctx.orgId, 'lease', l.id));
    } else {
      const ledger = leaseLedger(ctx, l.id);
      body = card(
        html`Resident ledger <span class="badge ${bal > 0 ? 'bad' : 'ok'}">balance ${usd(bal)}</span>`,
        tbl(
          [{ label: 'Date' }, { label: 'Description' }, { label: 'Charge', num: true }, { label: 'Payment', num: true }, { label: 'Balance', num: true }],
          ledger.map((row) => ({
            cells: [
              html`<span class="nowrap">${fmtDate(row.date)}</span>`,
              html`${row.label}${row.status && !['active', 'settled', 'issued'].includes(row.status) ? html` ${statusBadge(row.status)}` : ''}`,
              row.charge_cents ? usd(row.charge_cents) : '',
              row.credit_cents ? usd(row.credit_cents) : '',
              html`<b>${usd(row.balance)}</b>`,
            ],
          })),
          { empty: 'No ledger activity yet.' },
        ),
        { flush: true },
      );
    }

    return shell(rq, {
      title: `${l.household_name} — ${l.unit_number}`,
      active: '/leases',
      crumbs: [['Leases', '/leases'], [l.prop_name, `/properties/${l.prop_id}`]],
      subtitle: html`${statusBadge(l.status)} · ${fmtDate(l.start_date)} → ${fmtDate(l.end_date)} · ${usd(l.rent_cents)}/mo`,
      actions: html`${leaseActions.map((fn) => fn(ctx, l))}`,
      content: html`${tabs(tabItems)}${body}`,
    });
  });
}

/** later phases (payments, renewals, esign, insurance) contribute lease tabs/actions */
type LeaseTab = (ctx: Ctx, lease: any) => { key: string; label: string; render: () => any } | null;
const leaseExtraTabs: LeaseTab[] = [];
export function registerLeaseTab(fn: LeaseTab): void {
  leaseExtraTabs.push(fn);
}
type LeaseAction = (ctx: Ctx, lease: any) => any;
const leaseActions: LeaseAction[] = [];
export function registerLeaseAction(fn: LeaseAction): void {
  leaseActions.push(fn);
}
