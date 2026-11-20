import { html, raw, when, esc, type Child, type Raw } from '../../lib/html.ts';
import { redirect, notFound, fileRes, type Router, type Rq } from '../../lib/http.ts';
import { requirePerm, propFilter, canAccessProperty, can, hashPassword, tempPassword, type Ctx } from '../../lib/auth.ts';
import { q, q1, val, run, j, insert, tx } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { toCsv } from '../../lib/csv.ts';
import { audit } from '../../lib/audit.ts';
import { ensurePortalAccess } from './portal.ts';
import { fmtDate, diffDays, addMonths, addDays, nowIso, minDate } from '../../lib/dates.ts';
import { usd, parseUsd } from '../../lib/money.ts';
import {
  shell, card, tbl, kpis, dl, tabs, statusBadge, field, select, registerNav, registerSearch,
  historyPanel, pager, emptyState, input, viewBar, rememberDensity, type Density, type Col,
} from '../../ui/ui.ts';
import { createLeaseManual, recordNotice, withdrawNotice, recordMoveOut, cancelPendingLease, PENDING_STATUSES, MANUAL_ENTRY_BATCH, type ManualLeasePerson } from '../m6_leases/service.ts';
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

// ---------- a lease entered by hand: the form ----------

const EXTRA_PEOPLE = 3;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** an optional money field: '' → fallback; garbage → a message a person can act on */
function moneyField(raw: unknown, label: string, fallback: number | null = null): number {
  const s = String(raw ?? '').trim();
  if (!s) {
    if (fallback === null) throw new Error(`Enter ${label}.`);
    return fallback;
  }
  try {
    return parseUsd(s);
  } catch {
    throw new Error(`${label[0]!.toUpperCase()}${label.slice(1)} must be an amount, like 1450.00.`);
  }
}

/** units this person may lease right now: no current household, nothing in progress */
function leasableUnits(ctx: Ctx): any[] {
  const pf = propFilter(ctx, 'u.property_id');
  return q<any>(
    `SELECT u.id, u.unit_number, u.status, u.market_rent_cents, p.name AS prop_name FROM units u
     JOIN properties p ON p.id=u.property_id
     WHERE u.org_id=?${pf.sql}
       AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.unit_id=u.id AND l.org_id=u.org_id
         AND ((l.status IN ('active','month_to_month') AND l.move_out_date IS NULL)
           OR (l.renewal_of_lease_id IS NULL AND l.status IN ('draft','out_for_signature','partially_signed','fully_executed'))))
     ORDER BY p.name, u.unit_number`,
    ctx.orgId, ...pf.params,
  ).sort((a, b) => String(a.prop_name).localeCompare(String(b.prop_name))
    || String(a.unit_number).localeCompare(String(b.unit_number), 'en', { numeric: true }));
}

function newLeaseForm(rq: Rq, b: Record<string, unknown>, err?: string) {
  const ctx = rq.ctx as Ctx;
  const units = leasableUnits(ctx);
  const val0 = (k: string, d = ''): string => (b[k] === undefined ? d : String(b[k]));
  const today = ctx.businessDate;
  if (!units.length) {
    return shell(rq, {
      title: 'New lease', active: '/leases', crumbs: [['Leases', '/leases']],
      content: emptyState('No unit is free for a new lease', 'Every unit already has a current lease or one in progress. Add units under Properties, or record a move-out first.', html`<a class="btn" href="/properties">Go to properties</a>`),
    });
  }
  const unitNote: Record<string, string> = { vacant_ready: 'vacant', vacant_not_ready: 'vacant, not ready', notice: 'on notice', occupied: 'no lease on file', down: 'down', model: 'model' };
  const person = (i: number): Raw => html`
    <div class="grid cols-2">
      ${field(i === 0 ? 'First name' : `Person ${i + 1} first name`, input(`p${i}_first`, { value: val0(`p${i}_first`), required: i === 0 }))}
      ${field(i === 0 ? 'Last name' : `Person ${i + 1} last name`, input(`p${i}_last`, { value: val0(`p${i}_last`), required: i === 0 }))}
      ${field(i === 0 ? 'Email' : `Person ${i + 1} email`, input(`p${i}_email`, { value: val0(`p${i}_email`), type: 'email' }), i === 0 ? 'Optional. Needed later for portal access and e-signature.' : undefined)}
      ${field(i === 0 ? 'Phone' : `Person ${i + 1} phone`, input(`p${i}_phone`, { value: val0(`p${i}_phone`), type: 'tel' }))}
    </div>
    ${when(i > 0, () => field(`Person ${i + 1} is a`, select(`p${i}_role`, [['co', 'Co-resident (on the lease)'], ['occupant', 'Occupant (lives here, not on the lease)'], ['guarantor', 'Guarantor']], val0(`p${i}_role`, 'co'))))}`;
  return shell(rq, {
    title: 'New lease',
    active: '/leases',
    crumbs: [['Leases', '/leases']],
    subtitle: 'Enter a lease by hand — for a new move-in, or a household that already lives here.',
    content: html`
      ${when(err, () => html`<div class="flash err" role="alert">${err}</div>`)}
      <form method="post" action="/leases/new">
        ${card('Home', field('Unit', select('unit_id', units.map((u): [string, string] => [u.id, `${u.prop_name} · ${u.unit_number} (${unitNote[u.status as string] || u.status})`]), val0('unit_id', rq.query.get('unit') || ''), { required: true, blank: 'Choose a unit…' }),
          'Only units without a current lease are listed.'))}
        ${card('Primary resident', html`${person(0)}
          ${field('Household name', input('household_name', { value: val0('household_name'), placeholder: 'Leave blank to use the resident’s name' }))}`)}
        ${card('Other people (optional)', html`${Array.from({ length: EXTRA_PEOPLE }, (_, k) => html`${person(k + 1)}${k < EXTRA_PEOPLE - 1 ? raw('<hr style="border:0;border-top:1px solid var(--line);margin:12px 0" />') : ''}`)}
          <p class="small muted">More people can be added from the lease page afterwards.</p>`)}
        ${card('Term and rent', html`<div class="grid cols-2">
          ${field('Lease start', input('start_date', { type: 'date', required: true, value: val0('start_date', today) }))}
          ${field('Lease end', input('end_date', { type: 'date', required: true, value: val0('end_date', addDays(addMonths(today, 12), -1)) }))}
          ${field('Monthly rent', raw(`<input id="nl_rent" name="rent" type="text" inputmode="decimal" value="${esc(val0('rent'))}" placeholder="0.00" required />`))}
          ${field('Moved in on', input('move_in_date', { type: 'date', value: val0('move_in_date') }), 'Only if different from the lease start. The first month is prorated from this date.')}
        </div>`)}
        ${card('Security deposit', html`<div class="grid cols-2">
          ${field('Deposit amount', raw(`<input id="nl_deposit" name="deposit" type="text" inputmode="decimal" value="${esc(val0('deposit'))}" placeholder="0.00" />`), 'Leave blank if there is no deposit.')}
          ${field('Has the deposit been collected?', select('deposit_on_hand', [['no', 'Not yet — bill it to the household at move-in'], ['yes', 'Yes — it is already in the bank']], val0('deposit_on_hand', 'no')),
            'If it is already in the bank it is recorded as held and not billed again. If it is collected later, record that payment on the lease.')}
        </div>`)}
        ${card('If the household already lives here', html`<div class="grid cols-2">
          ${field('Start billing rent from', input('billing_start_date', { type: 'date', value: val0('billing_start_date') }), 'The first month this system should bill. Leave blank to bill from the lease start.')}
          ${field('Balance owed today', raw(`<input id="nl_opening_balance" name="opening_balance" type="text" inputmode="decimal" value="${esc(val0('opening_balance'))}" placeholder="0.00" />`), 'What the household owes right now for earlier months, if anything. It becomes the first line of their ledger.')}
        </div>`)}
        ${card('Signature', field('Is the lease signed?', select('signed', [['yes', 'Yes, signed on paper — make it active'], ['no', 'Not yet — save a draft to send for e-signature']], val0('signed', 'yes')),
          'A signed lease becomes active on its start date (right away if that date has passed): the unit shows occupied and rent is billed.'))}
        <button class="btn">Create lease</button> <a class="btn btn-ghost" href="/leases">Cancel</a>
      </form>`,
  });
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
    // Server-sorted, because this list is paginated: ordering has to cover all
    // 366 residents, not the 50 on screen. tbl() renders the header as a link
    // and stands its in-page sorter down when any column carries an href.
    const head = (key: ResidentSort, label: string, num?: boolean): Col => ({
      num,
      label,
      href: sortHref(key),
      sorted: sort === key ? dir : undefined,
    });
    const csvSp = new URLSearchParams(rq.query);
    csvSp.delete('page');
    csvSp.delete('per');
    const csvQs = csvSp.toString();

    const peopleTable = (): Raw => tbl(
      [head('name', 'Resident'), head('unit', 'Unit'), head('property', 'Property'), head('role', 'On the lease'),
       { label: 'Lease', nosort: true }, head('balance', 'Household balance', true)],
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
      { empty: 'No residents match.', density: dens },
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
          </div>
          <details style="margin-top:12px"><summary class="small"><b>Edit name and contact details</b></summary>
            <form method="post" action="/residents/${res.id}" style="margin-top:10px">
              <div class="grid cols-2">
                ${field('First name', input('first_name', { value: res.first_name, required: true }))}
                ${field('Last name', input('last_name', { value: res.last_name, required: true }))}
                ${field('Email', input('email', { value: res.email || '', type: 'email' }), res.user_id ? 'Also changes the email this resident signs in to the portal with.' : undefined)}
                ${field('Phone', input('phone', { value: res.phone || '', type: 'tel' }))}
              </div>
              <button class="btn btn-sm">Save changes</button>
            </form>
          </details>`)}`)}
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
  r.post('/residents/:id', requirePerm('residents:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const res = q1<any>('SELECT * FROM residents WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!res || !canAccessProperty(ctx, res.property_id)) return notFound('Resident not found');
    const first = String(rq.body.first_name || '').trim();
    const last = String(rq.body.last_name || '').trim();
    const email = String(rq.body.email || '').trim().toLowerCase();
    const phone = String(rq.body.phone || '').trim();
    const back = (msg: string) => redirect(`/residents/${res.id}`, msg, 'err');
    if (!first || !last) return back('Enter a first and last name.');
    if (email && !EMAIL_RE.test(email)) return back('That email address does not look right.');
    if (res.user_id && !email) return back('This resident signs in to the portal with their email, so it cannot be blank.');
    if (res.user_id && email !== String(res.email || '').toLowerCase()
      && q1('SELECT id FROM users WHERE email=? AND id != ?', email, res.user_id)) {
      return back('Another account already signs in with that email address.');
    }
    tx(() => {
      run('UPDATE residents SET first_name=?, last_name=?, email=?, phone=? WHERE id=? AND org_id=?', first, last, email || null, phone || null, res.id, ctx.orgId);
      // the portal sign-in follows the resident's email and name
      if (res.user_id) run(`UPDATE users SET email=?, name=? WHERE id=? AND org_id=? AND kind='resident'`, email, `${first} ${last}`, res.user_id, ctx.orgId);
    });
    audit(ctx, 'resident', res.id, 'update',
      { first_name: res.first_name, last_name: res.last_name, email: res.email, phone: res.phone },
      { first_name: first, last_name: last, email: email || null, phone: phone || null });
    return redirect(`/residents/${res.id}`, 'Saved.');
  });

  // ---------- a lease entered by hand (registered before /leases/:id) ----------
  r.get('/leases/new', requirePerm('leases:manage'), (rq) => newLeaseForm(rq, {}));

  r.post('/leases/new', requirePerm('leases:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const b = rq.body as Record<string, unknown>;
    const str = (k: string): string => String(b[k] ?? '').trim();
    let out: { leaseId: string; status: string };
    try {
      const unit = q1<any>('SELECT id, property_id FROM units WHERE id=? AND org_id=?', str('unit_id'), ctx.orgId);
      if (!unit || !canAccessProperty(ctx, unit.property_id)) throw new Error('Choose a unit.');
      const people: ManualLeasePerson[] = [];
      for (let i = 0; i <= EXTRA_PEOPLE; i++) {
        const role = i === 0 ? 'primary' : str(`p${i}_role`);
        if (!['primary', 'co', 'occupant', 'guarantor'].includes(role)) continue;
        people.push({
          firstName: str(`p${i}_first`), lastName: str(`p${i}_last`), email: str(`p${i}_email`), phone: str(`p${i}_phone`),
          role: role as ManualLeasePerson['role'],
        });
      }
      out = createLeaseManual(ctx, {
        unitId: unit.id, people, householdName: str('household_name'),
        startDate: str('start_date'), endDate: str('end_date'), moveInDate: str('move_in_date') || null,
        rentCents: moneyField(b.rent, 'the monthly rent'),
        depositCents: moneyField(b.deposit, 'the deposit', 0),
        depositOnHand: str('deposit_on_hand') === 'yes',
        billingStartDate: str('billing_start_date') || null,
        openingBalanceCents: moneyField(b.opening_balance, 'the balance owed', 0),
        signed: str('signed') !== 'no',
      });
    } catch (e) {
      return newLeaseForm(rq, b, (e as Error).message);
    }
    const lease = q1<any>('SELECT start_date FROM leases WHERE id=?', out.leaseId);
    return redirect(
      `/leases/${out.leaseId}?tab=overview`,
      out.status === 'active' ? 'Lease created and active — the unit is occupied and rent is on the ledger.'
        : out.status === 'fully_executed' ? `Lease saved. It becomes active on ${fmtDate(lease.start_date)}, and rent is billed from then.`
          : 'Draft lease saved. Send it for signature when it is ready.',
    );
  });

  // ---------- notice to vacate and move-out, recorded by staff ----------
  const leaseFor = (rq: Rq): any => {
    const ctx = rq.ctx as Ctx;
    const l = q1<any>('SELECT * FROM leases WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    return l && canAccessProperty(ctx, l.property_id) ? l : null;
  };
  const leaseAction = (rq: Rq, ok: string, fn: (ctx: Ctx, l: any) => void) => {
    const l = leaseFor(rq);
    if (!l) return notFound('Lease not found');
    try {
      fn(rq.ctx as Ctx, l);
    } catch (e) {
      return redirect(`/leases/${l.id}?tab=overview`, (e as Error).message, 'err');
    }
    return redirect(`/leases/${l.id}?tab=overview`, ok);
  };

  r.post('/leases/:id/notice', requirePerm('leases:manage'), (rq) =>
    leaseAction(rq, 'Notice recorded. The unit shows on notice and its make-ready is scheduled. Rent is billed through the move-out date.', (ctx, l) =>
      recordNotice(ctx, l.id, String(rq.body.move_out || ''), { noticeDate: String(rq.body.notice_date || '') || null })));

  r.post('/leases/:id/notice/withdraw', requirePerm('leases:manage'), (rq) =>
    leaseAction(rq, 'Notice withdrawn — the household is staying, and rent is billed in full again.', (ctx, l) => withdrawNotice(ctx, l.id)));

  r.post('/leases/:id/move-out', requirePerm('leases:manage'), (rq) =>
    leaseAction(rq, 'Move-out recorded. The lease has ended, rent is billed through the move-out date, and the unit is vacant. Settle the deposit on the Deposit tab.', (ctx, l) =>
      recordMoveOut(ctx, l.id, String(rq.body.move_out || ''))));

  // ---------- cancel a lease that never started ----------
  r.post('/leases/:id/cancel', requirePerm('leases:manage'), (rq) => {
    const l = leaseFor(rq);
    if (!l) return notFound('Lease not found');
    let out: { depositReversedCents: number };
    try {
      out = cancelPendingLease(rq.ctx as Ctx, l.id);
    } catch (e) {
      return redirect(`/leases/${l.id}?tab=overview`, (e as Error).message, 'err');
    }
    return redirect(`/leases/${l.id}?tab=overview`, out.depositReversedCents > 0
      ? `Lease canceled. The unit is free for another lease. The ${usd(out.depositReversedCents)} deposit is no longer recorded as held — return that money to the household yourself; nothing was sent.`
      : 'Lease canceled. The unit is free for another lease. No money was recorded on it.');
  });

  // ---------- household: add or remove a person ----------
  r.post('/leases/:id/household', requirePerm('residents:manage'), (rq) =>
    leaseAction(rq, 'Added to the household.', (ctx, l) => {
      if (['ended', 'renewed', 'canceled'].includes(l.status)) throw new Error('This lease is closed — its household can no longer be changed.');
      const first = String(rq.body.first_name || '').trim();
      const last = String(rq.body.last_name || '').trim();
      const email = String(rq.body.email || '').trim().toLowerCase();
      const phone = String(rq.body.phone || '').trim();
      const role = String(rq.body.role || 'co');
      if (!first || !last) throw new Error('Enter a first and last name.');
      if (!['co', 'occupant', 'guarantor'].includes(role)) throw new Error('Choose how this person is on the lease.');
      if (email && !EMAIL_RE.test(email)) throw new Error('That email address does not look right.');
      const rid = id('res');
      tx(() => {
        insert('residents', {
          id: rid, org_id: ctx.orgId, property_id: l.property_id, user_id: null, first_name: first, last_name: last,
          email: email || null, phone: phone || null,
          kind: role === 'guarantor' ? 'guarantor' : role === 'occupant' ? 'occupant' : 'adult', created_at: nowIso(),
        });
        insert('household_members', { id: id('hm'), org_id: ctx.orgId, lease_id: l.id, resident_id: rid, role, created_at: nowIso() });
      });
      audit(ctx, 'lease', l.id, 'household_add', null, { resident: rid, name: `${first} ${last}`, role });
    }));

  r.post('/leases/:id/household/:rid/remove', requirePerm('residents:manage'), (rq) =>
    leaseAction(rq, 'Removed from this lease. Their record is kept.', (ctx, l) => {
      const hm = q1<any>(
        `SELECT hm.id, hm.role, r.first_name, r.last_name FROM household_members hm JOIN residents r ON r.id=hm.resident_id
         WHERE hm.lease_id=? AND hm.resident_id=? AND hm.org_id=?`, l.id, rq.params.rid!, ctx.orgId);
      if (!hm) throw new Error('That person is not on this lease.');
      if (hm.role === 'primary') throw new Error('The primary resident cannot be removed — a lease needs someone responsible for it.');
      run('DELETE FROM household_members WHERE id=? AND org_id=?', hm.id, ctx.orgId);
      audit(ctx, 'lease', l.id, 'household_remove', { resident: rq.params.rid, name: `${hm.first_name} ${hm.last_name}`, role: hm.role }, null);
    }));

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
    run('DELETE FROM sessions WHERE user_id=?', res.user_id);
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
      actions: when(can(ctx, 'leases:manage'), () => html`<a class="btn" href="/leases/new">New lease</a>`),
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
        ${when(can(ctx, 'residents:manage') && !['ended', 'renewed', 'canceled'].includes(l.status), () => card('Change the household', html`
          <form method="post" action="/leases/${l.id}/household">
            <div class="grid cols-2">
              ${field('First name', input('first_name', { required: true }))}
              ${field('Last name', input('last_name', { required: true }))}
              ${field('Email', input('email', { type: 'email' }))}
              ${field('Phone', input('phone', { type: 'tel' }))}
            </div>
            ${field('This person is a', select('role', [['co', 'Co-resident (on the lease)'], ['occupant', 'Occupant (lives here, not on the lease)'], ['guarantor', 'Guarantor']], 'co'))}
            <button class="btn btn-sm">Add person</button>
          </form>
          ${when(household.some((h) => h.role !== 'primary'), () => html`<div style="margin-top:12px">${household.filter((h) => h.role !== 'primary').map((h) => html`
            <form method="post" action="/leases/${l.id}/household/${h.id}/remove" data-confirm="Remove ${h.first_name} ${h.last_name} from this lease?" style="display:inline-block;margin:0 6px 6px 0">
              <button class="btn btn-sm btn-ghost">Remove ${h.first_name} ${h.last_name}</button>
            </form>`)}</div>`)}
          <p class="small muted" style="margin-top:8px">To correct a name, email or phone, open the person from the household list.</p>`))}
        ${when(can(ctx, 'leases:manage') && ['active', 'month_to_month', 'notice', 'ended'].includes(l.status), () => card('Notice and move-out', l.status === 'ended'
          ? html`<p>Moved out ${fmtDate(l.move_out_date || l.end_date)}. <a href="/leases/${l.id}?tab=deposit">Settle the deposit</a> once final charges are on the ledger.</p>`
          : html`
          <div class="grid cols-2">
            <form method="post" action="/leases/${l.id}/notice">
              <h3 style="font-size:14px;margin:0 0 6px">${l.status === 'notice' ? 'Change the planned move-out' : 'Record notice to vacate'}</h3>
              ${field('Notice given on', input('notice_date', { type: 'date', required: true, max: ctx.businessDate, value: l.notice_date || ctx.businessDate }))}
              ${field('Planned move-out date', input('move_out', { type: 'date', required: true, value: l.move_out_date || '' }))}
              <button class="btn btn-sm">${l.status === 'notice' ? 'Save' : 'Record notice'}</button>
              <p class="small muted" style="margin-top:6px">The unit shows as on notice and its make-ready is scheduled. The lease ends on the move-out date, and rent is billed through that day — a month already billed is adjusted.</p>
            </form>
            <form method="post" action="/leases/${l.id}/move-out" data-confirm="End this lease as of the move-out date? The unit becomes vacant.">
              <h3 style="font-size:14px;margin:0 0 6px">Record the move-out</h3>
              ${field('Moved out on', input('move_out', { type: 'date', required: true, max: ctx.businessDate, value: l.move_out_date ? minDate(l.move_out_date, ctx.businessDate) : ctx.businessDate }))}
              <button class="btn btn-sm btn-danger">End lease</button>
              <p class="small muted" style="margin-top:6px">Use this once the household has actually left — on the planned day, earlier or later. Rent is billed through that day: anything already billed past it is credited back, and the unit becomes vacant.</p>
            </form>
          </div>
          ${when(l.status === 'notice', () => html`<form method="post" action="/leases/${l.id}/notice/withdraw" data-confirm="Withdraw the notice? The household stays and the make-ready is canceled." style="margin-top:10px">
            <button class="btn btn-sm btn-ghost">Withdraw notice — the household is staying</button></form>`)}`))}
        ${when(can(ctx, 'leases:manage') && PENDING_STATUSES.includes(l.status) && !l.renewal_of_lease_id && (!l.import_batch_id || l.import_batch_id === MANUAL_ENTRY_BATCH), () => card('Cancel this lease', html`
          <p>This lease has not started. Cancel it if the household is not moving in or it was entered by mistake — the unit is free for another lease and nothing is billed.</p>
          <p class="small muted">${l.deposit_on_hand && l.deposit_cents > 0
            ? `The ${usd(l.deposit_cents)} deposit recorded as already held comes off the books: deposit cash and deposits held both go down by ${usd(l.deposit_cents)}. Return that money to the household yourself — canceling does not send a payment.`
            : 'No deposit or rent has been recorded on this lease, so there is no money to return.'}</p>
          <form method="post" action="/leases/${l.id}/cancel" data-confirm="Cancel this lease? This cannot be undone.">
            <button class="btn btn-sm btn-danger">Cancel lease</button>
          </form>`))}
        ${when(l.status === 'canceled', () => card('Canceled', html`<p>This lease was canceled before it started. Nothing is billed on it and the unit is free for another lease.</p>`))}
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
