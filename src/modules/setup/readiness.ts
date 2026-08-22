import { html, when, raw, type Raw } from '../../lib/html.ts';
import { q, q1, val } from '../../lib/db.ts';
import { hasRealAddress } from '../../lib/address.ts';
import { card } from '../../ui/ui.ts';
import type { Ctx } from '../../lib/auth.ts';

/** "What else do I need to bring in?" — measured against the portfolio that is
 * actually in the database, not against a generic checklist.
 *
 * Two screens ask this question and must never disagree: the Migration Center
 * (mid-migration: what is still missing from my upload) and the Setup hub
 * (day to day: what is my company still missing). Both read this file.
 *
 * Every item answers three things in the operator's language: where it stands,
 * what it turns on, and the one button that gets it done. An item is never
 * scolding — a portfolio can be perfectly runnable with several of these
 * untouched, so "missing" reads as an opportunity, not an error. */

export type ReadyState = 'done' | 'partial' | 'missing';

export interface ReadyItem {
  key: string;
  /** what the operator brings in, named as they would name it */
  title: string;
  state: ReadyState;
  /** where it stands right now, counted from their own data */
  status: string;
  /** what having it turns on — the reason to bother */
  unlocks: string;
  /** [href, label] — the first is the primary action */
  links: [string, string][];
  /** true when this is worth doing but nothing is broken without it */
  optional?: boolean;
}

function n(sql: string, ...params: unknown[]): number {
  return val<number>(sql, ...params) ?? 0;
}

/** Reads the portfolio and reports what is in, what is partly in, and what has
 * not arrived yet. Ordered the way a migration actually goes: the rent roll
 * builds the world, then the details that automate it. */
export function readinessItems(ctx: Ctx): ReadyItem[] {
  const o = ctx.orgId;
  const units = n('SELECT COUNT(*) FROM units WHERE org_id=?', o);
  const leases = n(`SELECT COUNT(*) FROM leases WHERE org_id=? AND status IN ('active','month_to_month','notice')`, o);
  const occupied = n(`SELECT COUNT(DISTINCT unit_id) FROM leases WHERE org_id=? AND status IN ('active','month_to_month','notice')`, o);

  // contact details decide whether the portal and every automated message can
  // reach anyone at all — the most common thing a rent roll leaves out
  const adults = n(
    `SELECT COUNT(*) FROM household_members hm JOIN leases l ON l.id=hm.lease_id
      WHERE l.org_id=? AND l.status IN ('active','month_to_month','notice') AND hm.role IN ('primary','co')`, o);
  const withEmail = n(
    `SELECT COUNT(*) FROM household_members hm JOIN leases l ON l.id=hm.lease_id JOIN residents r ON r.id=hm.resident_id
      WHERE l.org_id=? AND l.status IN ('active','month_to_month','notice') AND hm.role IN ('primary','co')
        AND r.email IS NOT NULL AND TRIM(r.email) <> ''`, o);

  const docs = n(
    `SELECT COUNT(*) FROM leases l WHERE l.org_id=? AND l.status IN ('active','month_to_month','notice')
       AND (l.packet_file_id IS NOT NULL OR EXISTS (SELECT 1 FROM files f WHERE f.entity='lease' AND f.entity_id=l.id))`, o);

  const openingBalances = n(`SELECT COUNT(*) FROM charges WHERE org_id=? AND kind='opening_balance'`, o);
  const depositsHeld = n(
    `SELECT COUNT(*) FROM leases WHERE org_id=? AND status IN ('active','month_to_month','notice') AND deposit_cents > 0`, o);
  // Deposits BILLED and never collected, carried in from a deposit report.
  // This is money the operator is owed and has no other way to see: a rent
  // roll shows one deposit figure — what is held — so a household that paid a
  // fifth of its deposit looks exactly like one that paid in full.
  const depositShortRows = n('SELECT COUNT(*) FROM deposit_positions WHERE org_id=? AND short_cents > 0', o);
  const depositShortCents = n('SELECT COALESCE(SUM(short_cents),0) FROM deposit_positions WHERE org_id=? AND short_cents > 0', o);
  // the specific entry postBankOpeningBalance writes — NOT "any conversion
  // entry", which would report the bank balance as posted for an org that only
  // carried over what residents owe
  const bankOpening = !!q1(
    `SELECT id FROM journal_entries WHERE org_id=? AND memo LIKE 'Opening operating bank balance%' LIMIT 1`, o);
  // A rent roll names buildings; it does not carry their street address, so an
  // imported property holds a placeholder until someone supplies the real one.
  // Until then the public community site can show no address at all.
  const properties = q<{ id: string; name: string; address1: string; city: string; state: string; zip: string }>(
    'SELECT id, name, address1, city, state, zip FROM properties WHERE org_id=? ORDER BY name', o);
  const addressed = properties.filter((p) => hasRealAddress(p));
  const unaddressed = properties.filter((p) => !hasRealAddress(p));

  const vendors = n('SELECT COUNT(*) FROM vendors WHERE org_id=? AND active=1', o);
  const staff = n(`SELECT COUNT(*) FROM users WHERE org_id=? AND kind='staff' AND active=1`, o);

  const pct = (part: number, whole: number): number => (whole ? Math.round((part / whole) * 100) : 0);
  const some = (part: number, whole: number): ReadyState => (part === 0 ? 'missing' : part >= whole ? 'done' : 'partial');

  return [
    {
      key: 'portfolio',
      title: 'Properties and units',
      state: units > 0 ? 'done' : 'missing',
      status: units > 0
        ? `${units} unit${units === 1 ? '' : 's'} on file`
        : 'Nothing yet — this is the first upload.',
      unlocks: 'The building itself: unit board, occupancy, availability, and every report that counts doors.',
      links: [['/setup/import?tab=rentroll', 'Upload a rent roll'], ['/setup/wizard', 'Add a property by hand']],
    },
    {
      key: 'leases',
      title: 'Residents and leases',
      state: units === 0 ? 'missing' : some(occupied, units),
      status: units === 0
        ? 'Waiting on the rent roll.'
        : leases > 0
          ? `${leases} active lease${leases === 1 ? '' : 's'} across ${occupied} of ${units} units (${pct(occupied, units)}% occupied)`
          : 'No leases yet — units are all reading vacant.',
      unlocks: 'Rent bills itself on the 1st, late fees follow your policy, and the resident portal has someone to let in.',
      links: [['/setup/import?tab=rentroll', 'Upload a rent roll'], ['/setup/import?tab=leases', 'Upload lease PDFs']],
    },
    {
      key: 'addresses',
      title: 'Property addresses',
      state: properties.length === 0 ? 'missing' : some(addressed.length, properties.length),
      status: properties.length === 0
        ? 'No properties yet.'
        : unaddressed.length === 0
          ? `All ${properties.length} propert${properties.length === 1 ? 'y has' : 'ies have'} a street address`
          : `${unaddressed.length} of ${properties.length} have no street address yet — ${unaddressed.slice(0, 3).map((p) => p.name).join(', ')}${unaddressed.length > 3 ? `, +${unaddressed.length - 3} more` : ''}`,
      unlocks: 'The address on your public community page and its listing data, directions for applicants and vendors, and the mailing address on notices and statements.',
      links: unaddressed.length === 1 && unaddressed[0]
        ? [[`/properties/${unaddressed[0].id}/edit`, `Add the address for ${unaddressed[0].name}`]]
        : [['/properties', 'Add the addresses']],
    },
    {
      key: 'contacts',
      title: 'Resident email addresses',
      state: adults === 0 ? 'missing' : some(withEmail, adults),
      status: adults === 0
        ? 'No residents on file yet.'
        : withEmail >= adults
          ? `All ${adults} residents can be reached by email`
          : `${withEmail} of ${adults} residents have an email address — ${adults - withEmail} cannot be contacted`,
      unlocks: 'Portal invitations, payment reminders, renewal offers, and every AI-drafted message that needs somewhere to go.',
      links: [['/setup/import?tab=residents', 'Upload a resident directory'], ['/residents', 'Review residents']],
    },
    {
      key: 'balances',
      title: 'Balances owed at switch-over',
      state: leases === 0 ? 'missing' : openingBalances > 0 ? 'done' : 'missing',
      optional: true,
      status: openingBalances > 0
        ? `${openingBalances} opening balance${openingBalances === 1 ? '' : 's'} carried over`
        : 'Nothing carried over — every resident starts at zero owed.',
      unlocks: 'Collections continue instead of restarting: real aging, real delinquency, and follow-up drafted from day one.',
      links: [['/setup/import?tab=balances', 'Set opening balances']],
    },
    {
      key: 'deposits',
      title: 'Deposits you hold',
      state: leases === 0 ? 'missing' : depositsHeld > 0 ? 'done' : 'missing',
      optional: true,
      status: depositsHeld > 0
        ? `${depositsHeld} lease${depositsHeld === 1 ? '' : 's'} record a deposit held`
          + (depositShortRows
            ? ` · ${depositShortRows} household${depositShortRows === 1 ? '' : 's'} still owe $${(depositShortCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} of deposit`
            : '')
        : 'No deposits recorded against leases.',
      unlocks: 'Move-out accounting that knows what to return, a deposit liability your books actually carry, and the deposits residents were billed but never paid.',
      links: [['/setup#upload', 'Upload a deposit report'], ['/deposits', 'Review deposits']],
    },
    {
      key: 'bank',
      title: 'Opening bank balance',
      state: bankOpening ? 'done' : 'missing',
      optional: true,
      status: bankOpening ? 'Posted — the books open from a real number.' : 'Not posted — the books open at zero cash.',
      unlocks: 'Reconciliation and owner statements that tie out to your account instead of starting from nothing.',
      links: [['/setup/import?tab=balances', 'Post the opening balance']],
    },
    {
      key: 'documents',
      title: 'Lease documents on file',
      state: leases === 0 ? 'missing' : some(docs, leases),
      optional: true,
      status: leases === 0
        ? 'No leases yet.'
        : docs >= leases && leases > 0
          ? `All ${leases} leases have their document attached`
          : `${docs} of ${leases} leases have the signed document attached`,
      unlocks: 'The signed page is one click from the lease, and renewals read real terms rather than a typed summary.',
      links: [['/setup/import?tab=leases', 'Upload lease PDFs']],
    },
    {
      key: 'vendors',
      title: 'Vendors',
      state: vendors > 0 ? 'done' : 'missing',
      optional: true,
      status: vendors > 0 ? `${vendors} active vendor${vendors === 1 ? '' : 's'}` : 'None yet — work orders have nobody to dispatch to.',
      unlocks: 'One-click dispatch on work orders, and vendor messages drafted for your approval.',
      links: [['/setup/import?tab=vendors', 'Upload a vendor list'], ['/vendors', 'Add one by hand']],
    },
    {
      key: 'team',
      title: 'Your team',
      state: staff > 1 ? 'done' : 'missing',
      optional: true,
      status: staff > 1 ? `${staff} people have logins` : 'Just you — which is fine for a solo operator.',
      unlocks: 'Role-scoped access: leasing sees leasing, maintenance sees their queue, and approvals route to the right person.',
      links: [['/admin/staff', 'Invite your team']],
    },
  ];
}

export interface ReadinessSummary {
  items: ReadyItem[];
  done: number;
  total: number;
  /** the items worth doing next — never more than three, most valuable first */
  next: ReadyItem[];
  /** true once the portfolio is genuinely operable (doors, leases, contacts) */
  operable: boolean;
}

export function readiness(ctx: Ctx): ReadinessSummary {
  const items = readinessItems(ctx);
  const done = items.filter((i) => i.state === 'done').length;
  const core = ['portfolio', 'leases', 'contacts'];
  const next = items
    .filter((i) => i.state !== 'done')
    .sort((a, b) => {
      const rank = (i: ReadyItem): number => (core.includes(i.key) ? 0 : i.optional ? 2 : 1);
      return rank(a) - rank(b);
    })
    .slice(0, 3);
  return {
    items, done, total: items.length, next,
    operable: items.filter((i) => core.includes(i.key)).every((i) => i.state !== 'missing'),
  };
}

// ---------- rendering ----------

const TICK = raw('<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>');
const HALF = raw('<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg>');
const PLUS = raw('<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>');

const MARK: Record<ReadyState, Raw> = { done: TICK, partial: HALF, missing: PLUS };
const WORD: Record<ReadyState, string> = { done: 'On file', partial: 'Partly there', missing: 'Not yet' };

/** The readiness panel.
 *
 * What is OUTSTANDING is the page; what is already done is a line you can open
 * if you want to check. A finished portfolio otherwise pushes nine rows of
 * ticks in front of the operator before they reach anything they can act on,
 * which is how a status board turns back into wallpaper. */
export function readinessPanel(ctx: Ctx, opts: { title?: string; only?: string[]; intro?: string } = {}): Raw {
  const { items } = readiness(ctx);
  const list = opts.only ? items.filter((i) => opts.only!.includes(i.key)) : items;
  const outstanding = list.filter((i) => i.state !== 'done');
  const settled = list.filter((i) => i.state === 'done');

  const row = (i: ReadyItem): Raw => html`<div class="ready-item ${i.state}">
    <span class="ri-mark ${i.state}" aria-hidden="true">${MARK[i.state]}</span>
    <div class="ri-body">
      <div class="ri-head">
        <b>${i.title}</b>
        <span class="ri-state ${i.state}">${WORD[i.state]}</span>
        ${when(!!i.optional && i.state !== 'done', () => html`<span class="ri-opt">optional</span>`)}
      </div>
      <div class="ri-status">${i.status}</div>
      ${when(i.state !== 'done', () => html`<div class="ri-unlocks"><span class="ri-key">Turns on</span> ${i.unlocks}</div>`)}
    </div>
    ${when(i.state !== 'done', () => html`<div class="ri-actions">
      ${i.links.slice(0, 1).map(([href, label]) => html`<a class="btn btn-ghost" href="${href}">${label}</a>`)}
    </div>`)}
  </div>`;

  return card(opts.title ?? 'Your setup', html`
    <p class="muted" style="margin-top:0">${opts.intro
      ?? 'Counted from your own portfolio every time this page opens. Each line says where it stands and what it turns on — the software runs without any one of them, and works harder with each.'}</p>
    <div class="ready-bar" role="img" aria-label="${String(settled.length)} of ${String(list.length)} complete">
      ${list.map((i) => html`<span class="rb-seg ${i.state}"></span>`)}
    </div>
    <p class="small muted" style="margin:6px 0 14px">${String(settled.length)} of ${String(list.length)} complete</p>
    ${when(outstanding.length === 0, () => html`<div class="callout ok" style="margin-top:0"><b>Everything is on file.</b> Nothing is waiting on you — new gaps appear here if data goes missing.</div>`)}
    <div class="ready-list">${outstanding.map(row)}</div>
    ${when(settled.length > 0, () => html`<details class="ready-done">
      <summary>${String(settled.length)} already on file</summary>
      <div class="ready-list">${settled.map(row)}</div>
    </details>`)}
  `);
}
