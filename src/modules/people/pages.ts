import { html, raw, when, esc, type Child, type Raw } from '../../lib/html.ts';
import { redirect, notFound, fileRes, type Router, type Rq } from '../../lib/http.ts';
import { requirePerm, propFilter, canAccessProperty, can, hashPassword, tempPassword, type Ctx } from '../../lib/auth.ts';
import { q, q1, val, run, j } from '../../lib/db.ts';
import { toCsv } from '../../lib/csv.ts';
import { audit } from '../../lib/audit.ts';
import { ensurePortalAccess } from './portal.ts';
import { fmtDate, diffDays } from '../../lib/dates.ts';
import { usd } from '../../lib/money.ts';
import {
  shell, card, tbl, kpis, dl, tabs, statusBadge, field, select, registerNav, registerSearch,
  historyPanel, pager, emptyState, input, viewBar, rememberDensity, type Density,
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

// ---------- residents list: sorting / page size / CSV ----------

const RESIDENT_SORTS = ['name', 'unit', 'property', 'role', 'balance'] as const;
type ResidentSort = (typeof RESIDENT_SORTS)[number];
const PER_CHOICES = ['25', '50', '100', 'all'] as const;

/** Two honest shapes for the same data. "People" answers "who lives here";
 * "Households" answers "what do we bill and who is on the hook" — and only the
 * second can total money, because money is owed per lease. */
type ResidentView = 'people' | 'households';

/** `primary` / `co` are how the lease records a signer; they are not words an
 * operator says out loud. */
const ROLE_LABEL: Record<string, string> = { primary: 'Primary', co: 'Co-resident', guarantor: 'Guarantor', occupant: 'Occupant', minor: 'Minor' };

interface Household {
  lease_id: string;
  household: string;
  unit_number: string;
  prop_name: string;
  lease_status: string;
  people: { first_name: string; last_name: string; email?: string; role: string }[];
}

/** Collapse the per-adult rows onto their lease, preserving the order the rows
 * arrived in (so the table's sort carries into the household view). */
function groupHouseholds(rows: any[]): Household[] {
  const by = new Map<string, Household>();
  for (const r of rows) {
    let h = by.get(r.lease_id);
    if (!h) {
      h = {
        lease_id: r.lease_id, household: '', unit_number: r.unit_number, prop_name: r.prop_name,
        lease_status: r.lease_status, people: [],
      };
      by.set(r.lease_id, h);
    }
    h.people.push({ first_name: r.first_name, last_name: r.last_name, email: r.email, role: r.role });
  }
  for (const h of by.values()) {
    const primary = h.people.find((p) => p.role === 'primary') || h.people[0]!;
    h.household = h.people.length > 1
      ? `${primary.last_name} household`
      : `${primary.first_name} ${primary.last_name}`;
  }
  return [...by.values()];
}

function residentCmp(sort: ResidentSort): (a: any, b: any) => number {
  const s = (v: unknown): string => String(v ?? '').toLowerCase();
  switch (sort) {
    case 'name': return (a, b) => s(a.last_name).localeCompare(s(b.last_name)) || s(a.first_name).localeCompare(s(b.first_name));
    // natural (numeric-aware) compare so unit 201 sorts before 1002
    case 'unit': return (a, b) => String(a.unit_number ?? '').localeCompare(String(b.unit_number ?? ''), 'en', { numeric: true, sensitivity: 'base' });
    case 'property': return (a, b) => s(a.prop_name).localeCompare(s(b.prop_name));
    case 'role': return (a, b) => s(a.role).localeCompare(s(b.role));
    case 'balance': return (a, b) => (a.balance as number) - (b.balance as number);
  }
}

/** Shared by GET /residents and GET /residents.csv so the export is exactly
 * the table the user sees — same org/property scope, same search, same sort —
 * across ALL pages. Sorting happens server-side in JS: unit needs a natural
 * compare and balance is computed off the ledger, neither of which SQLite
 * offers; the SQL default order (last, first) remains and, sort() being
 * stable, stays the tiebreaker. `x.balance` is attached only when the sort
 * needs it — callers fall back to leaseBalance() per rendered row. */
function residentListRows(ctx: Ctx, rq: Rq): { rows: any[]; sort: ResidentSort | null; dir: 'asc' | 'desc'; query: string } {
  const pf = propFilter(ctx, 'l.property_id');
  const query = rq.query.get('q') || '';
  const params: unknown[] = [ctx.orgId, ...pf.params];
  let where = `l.org_id=? AND l.status IN ('active','month_to_month','notice')${pf.sql} AND hm.role IN ('primary','co')`;
  if (query) { where += ` AND (r.first_name || ' ' || r.last_name LIKE ? OR r.email LIKE ? OR u.unit_number LIKE ?)`; params.push(`%${query}%`, `%${query}%`, `%${query}%`); }
  const rows = q<any>(
    `SELECT r.id, r.first_name, r.last_name, r.email, r.phone, hm.role, l.id AS lease_id, l.status AS lease_status,
            u.unit_number, p.name AS prop_name, l.end_date
     FROM household_members hm JOIN leases l ON l.id=hm.lease_id JOIN residents r ON r.id=hm.resident_id
     JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=l.property_id
     WHERE ${where} ORDER BY r.last_name, r.first_name`,
    ...params,
  );
  const sortParam = rq.query.get('sort') || '';
  const sort = (RESIDENT_SORTS as readonly string[]).includes(sortParam) ? (sortParam as ResidentSort) : null;
  const dir: 'asc' | 'desc' = rq.query.get('dir') === 'desc' ? 'desc' : 'asc';
  if (sort) {
    if (sort === 'balance') for (const x of rows) x.balance = leaseBalance(ctx, x.lease_id);
    const cmp = residentCmp(sort);
    const sgn = dir === 'desc' ? -1 : 1;
    rows.sort((a, b) => sgn * cmp(a, b));
  }
  return { rows, sort, dir, query };
}

/** tbl() with per-column aria-sort — same markup/classes as ui.ts tbl()
 * (tbl-wrap, data-href row links, num cells), which cannot carry attributes
 * on a <th>. Kept local to the residents list. */
function sortableTbl(
  cols: { label: Child; num?: boolean; ariaSort?: 'ascending' | 'descending' }[],
  rows: { cells: Child[]; href?: string }[],
  empty: string,
  density: Density = 'roomy',
): Raw {
  if (!rows.length) return html`<div class="empty"><div class="e-title">${empty}</div></div>`;
  return html`<div class="tbl-wrap"><table class="tbl ${density === 'tight' ? 'tight' : ''}">
    <thead><tr>${cols.map((c) => html`<th class="${c.num ? 'num' : ''}" ${c.ariaSort ? raw(`aria-sort="${c.ariaSort}"`) : ''}>${c.label}</th>`)}</tr></thead>
    <tbody>${rows.map(
      (row) =>
        html`<tr ${row.href ? raw(`data-href="${esc(row.href)}" tabindex="0"`) : ''}>${row.cells.map((cell, i) => html`<td class="${cols[i]?.num ? 'num' : ''}">${cell}</td>`)}</tr>`,
    )}</tbody>
  </table></div>`;
}

export function routes(r: Router): void {
  // ---------- residents ----------
  r.get('/residents', requirePerm('residents:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const { rows, sort, dir, query } = residentListRows(ctx, rq);
    const dens = rememberDensity(rq);
    const view: ResidentView = rq.query.get('view') === 'households' ? 'households' : 'people';

    // One balance per household, resolved once and shared by both views. A
    // lease's balance belongs to the LEASE, so printing it beside two adults
    // on the same lease showed the same money twice and summed to double the
    // truth; the total below counts each household exactly once.
    const balOf = new Map<string, number>();
    const balance = (leaseId: string): number => {
      let b = balOf.get(leaseId);
      if (b === undefined) { b = leaseBalance(ctx, leaseId); balOf.set(leaseId, b); }
      return b;
    };
    const households = groupHouseholds(rows);
    // Owed and in-credit are different facts and must not cancel each other in
    // a headline: a portfolio owed $10k that also holds $3k of prepayments is
    // not "owed $7k" to anyone collecting it. The column footer still sums the
    // column arithmetically — a total under a column has to equal the column.
    const owedTotal = households.reduce((sum, h) => sum + Math.max(0, balance(h.lease_id)), 0);
    const creditTotal = households.reduce((sum, h) => sum + Math.min(0, balance(h.lease_id)), 0);
    const netTotal = owedTotal + creditTotal;
    const owingCount = households.filter((h) => balance(h.lease_id) > 0).length;

    const listRows: any[] = view === 'households' ? households : rows;
    const total = listRows.length;
    const perParam = rq.query.get('per') || '50';
    const per = (PER_CHOICES as readonly string[]).includes(perParam) ? perParam : '50';
    const pageSize = per === 'all' ? Math.max(total, 1) : parseInt(per, 10);
    const page = Math.max(1, parseInt(rq.query.get('page') || '1', 10) || 1);
    const pageRows = per === 'all' ? listRows : listRows.slice((page - 1) * pageSize, page * pageSize);

    // sort links preserve search + page size (the pager already preserves
    // sort/dir/per the same way); a re-sort restarts at page 1
    const sortHref = (key: ResidentSort): string => {
      const sp = new URLSearchParams(rq.query);
      sp.delete('page');
      sp.set('sort', key);
      sp.set('dir', sort === key && dir === 'asc' ? 'desc' : 'asc');
      return `/residents?${sp}`;
    };
    const head = (key: ResidentSort, label: string, num?: boolean): { label: Child; num?: boolean; ariaSort?: 'ascending' | 'descending' } => ({
      num,
      ariaSort: sort === key ? (dir === 'asc' ? 'ascending' : 'descending') : undefined,
      label: html`<a href="${sortHref(key)}">${label}${sort === key ? html`<span aria-hidden="true"> ${dir === 'asc' ? '▲' : '▼'}</span>` : ''}</a>`,
    });
    const csvSp = new URLSearchParams(rq.query);
    csvSp.delete('page');
    csvSp.delete('per');
    const csvQs = csvSp.toString();

    const peopleTable = (): Raw => sortableTbl(
      [head('name', 'Resident'), head('unit', 'Unit'), head('property', 'Property'), head('role', 'On the lease'),
       { label: 'Lease' }, head('balance', 'Household balance', true)],
      pageRows.map((x) => {
        const bal = balance(x.lease_id);
        const shared = x.role !== 'primary';
        return {
          href: `/residents/${x.id}`,
          cells: [
            html`<b>${x.first_name} ${x.last_name}</b><span class="sub">${x.email || 'No email on file'}</span>`,
            x.unit_number, x.prop_name, ROLE_LABEL[x.role as string] || x.role, statusBadge(x.lease_status),
            bal === 0
              ? html`<span class="${shared ? 'shared' : ''}">${usd(0)}</span>`
              : html`<span class="${shared ? 'shared' : bal > 0 ? 'neg' : ''}"
                  title="${shared ? 'Owed by this household — counted once in the total below' : 'Owed by this household'}">${usd(bal)}</span>`,
          ],
        };
      }),
      'No residents match.',
      dens,
    );

    const householdTable = (): Raw => tbl(
      [{ label: 'Household' }, { label: 'Unit' }, { label: 'Property' }, { label: 'Who is on it' },
       { label: 'Lease' }, { label: 'Balance', num: true }],
      pageRows.map((h: Household) => {
        const bal = balance(h.lease_id);
        return {
          href: `/leases/${h.lease_id}`,
          cells: [
            html`<b>${h.household}</b><span class="sub">${h.people.length} adult${h.people.length === 1 ? '' : 's'}</span>`,
            h.unit_number, h.prop_name,
            html`${h.people.map((p) => `${p.first_name} ${p.last_name}`).join(', ')}`,
            statusBadge(h.lease_status),
            html`<span class="${bal > 0 ? 'neg' : ''}">${usd(bal)}</span>`,
          ],
        };
      }),
      {
        empty: 'No households match.',
        density: dens,
        foot: ['Total — all households', '', '', '',
          `${households.length} household${households.length === 1 ? '' : 's'}`, usd(netTotal)],
      },
    );

    return shell(rq, {
      title: 'Residents',
      active: '/residents',
      subtitle: `${rows.length} adult${rows.length === 1 ? '' : 's'} across ${households.length} household${households.length === 1 ? '' : 's'}`
        + (owingCount ? ` · ${usd(owedTotal)} owed by ${owingCount} household${owingCount === 1 ? '' : 's'}` : ' · nothing owed')
        + (creditTotal < 0 ? ` · ${usd(-creditTotal)} held in credit` : ''),
      content: html`
        <form method="get" class="toolbar" data-autosubmit>
          ${when(sort, () => html`<input type="hidden" name="sort" value="${sort}" /><input type="hidden" name="dir" value="${dir}" />`)}
          ${when(view === 'households', () => html`<input type="hidden" name="view" value="households" />`)}
          ${when(dens === 'tight', () => html`<input type="hidden" name="density" value="tight" />`)}
          ${field('Search', input('q', { value: query, placeholder: 'Name, email, or unit…', type: 'search' }))}
          ${field('Rows', select('per', PER_CHOICES.map((p): [string, string] => [p, p === 'all' ? 'All' : p]), per))}
          <button class="btn btn-ghost">Filter</button>
          <a class="btn btn-ghost" href="/residents.csv${csvQs ? `?${csvQs}` : ''}">Export CSV</a>
        </form>
        ${viewBar(rq, {
          views: { current: view, choices: [['people', 'People'], ['households', 'Households']], label: 'View' },
          density: dens,
          note: view === 'people'
            ? 'One row per adult. A balance is owed by the household, so roommates show the same figure.'
            : 'One row per lease, with the balance counted once.',
        })}
        ${card(null, html`${view === 'households' ? householdTable() : peopleTable()}${pager(rq, total, pageSize)}`, { flush: true })}`,
    });
  });

  // CSV export of the current view — same permission, same org/property scope,
  // same search + sort as the table, every matching row (not just one page).
  r.get('/residents.csv', requirePerm('residents:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const { rows } = residentListRows(ctx, rq);
    // One row per adult, so the balance repeats for roommates exactly as it
    // does on screen — the header says whose it is, and a "counts once" flag
    // lets a spreadsheet total the column without double-counting a household.
    const seen = new Set<string>();
    const csv = toCsv(
      ['Resident', 'Unit', 'Property', 'On the lease', 'Lease status', 'Household balance', 'Counts once'],
      rows.map((x) => {
        const first = !seen.has(x.lease_id);
        seen.add(x.lease_id);
        return [
          `${x.first_name} ${x.last_name}`, x.unit_number, x.prop_name,
          ROLE_LABEL[x.role as string] || x.role, x.lease_status,
          (((x.balance ?? leaseBalance(ctx, x.lease_id)) as number) / 100).toFixed(2),
          first ? 'yes' : 'no',
        ];
      }),
    );
    return fileRes(csv, 'text/csv; charset=utf-8', { filename: `residents-${ctx.businessDate}.csv` });
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
          ${card('Contact & profile', html`${dl([
            ['Email', res.email || '—'],
            ['Phone', res.phone || '—'],
            ['Employer', res.employer || '—'],
            ['Monthly income', res.monthly_income_cents ? usd(res.monthly_income_cents) : '—'],
            ['Portal account', res.user_id ? statusBadge('active', 'enabled') : statusBadge(undefined, 'none')],
          ])}
          ${when(can(ctx, 'residents:manage'), () => html`<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center">
            ${res.user_id
              ? html`<form method="post" action="/residents/${res.id}/portal-reset" data-confirm="Generate a new one-time portal password for this resident?"><button class="btn btn-ghost btn-sm">Reset portal password</button></form>`
              : res.email
                ? html`<form method="post" action="/residents/${res.id}/portal-invite"><button class="btn btn-sm">Create portal access & send invite</button></form>`
                : html`<span class="muted small">Add an email to enable portal access.</span>`}
          </div>`)}`)}
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
  // portal access from the resident record — create+invite, or rotate the
  // credential and show it once (the m1 staff-reset pattern, for residents)
  r.post('/residents/:id/portal-invite', requirePerm('residents:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const res = q1<any>('SELECT * FROM residents WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!res || !canAccessProperty(ctx, res.property_id)) return notFound('Resident not found');
    const out = ensurePortalAccess(ctx, res.id);
    if (!out.userId) return redirect(`/residents/${res.id}`, 'This resident has no email on file — add one first.', 'err');
    return redirect(
      `/residents/${res.id}`,
      out.invited
        ? 'Portal access created — the invite (with the one-time password) is in your Message Console.'
        : 'That email already had a portal account — linked it to this resident.',
    );
  });

  r.post('/residents/:id/portal-reset', requirePerm('residents:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const res = q1<any>('SELECT * FROM residents WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!res || !canAccessProperty(ctx, res.property_id)) return notFound('Resident not found');
    if (!res.user_id) return redirect(`/residents/${res.id}`, 'No portal account yet — create one first.', 'err');
    const pw = ctx.orgKind === 'live' ? tempPassword() : 'demo1234';
    run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(pw), res.user_id);
    audit(ctx, 'user', String(res.user_id), 'password_reset', null, { via: 'resident_page' });
    return redirect(
      `/residents/${res.id}`,
      ctx.orgKind === 'live' ? `Portal password reset. One-time password (shown only now): ${pw}` : 'Portal password reset to demo1234.',
    );
  });

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
