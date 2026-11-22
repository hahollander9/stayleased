import { html, raw, when, type Raw } from '../../lib/html.ts';
import { notFound, redirect, type Router, type Rq } from '../../lib/http.ts';
import { requireStaff, type Ctx } from '../../lib/auth.ts';
import { uiMode } from '../../lib/uimode.ts';
import { shell, emptyState, destinations, destScore, DEST_HEADINGS, type Destination } from '../../ui/ui.ts';

/** Finding things.
 *
 * Two small pieces that exist because a new office manager could not find the
 * page for sending a notice, and concluded the product could not send one:
 *
 * 1. GET /all-pages — "Everything in StayLeased". One page listing every place
 *    this person may open, under the five plain headings, with a line saying
 *    what each is for. It is generated from the navigation registry (and the
 *    short list of places that are in no menu), so it cannot fall behind the
 *    menus; only the one-line descriptions are written here, and a page with
 *    none still lists.
 *
 * 2. The URLs people type from memory (/settings, /outbox, /import, /help)
 *    used to end on a bare 404. They now go where the person meant. */

// ---------- the one-liners ----------

/** What each page is for, in a sentence a property manager would say. Keyed by
 * href; two entries share /leases/new, so those are keyed by label too. */
const WHAT: Record<string, string> = {
  '/': 'Where you stand today: what needs your OK, what you made, who owes you.',
  '/receivables': 'Every household with a balance, and how collections are going this month.',
  '/delinquency': 'Households that are past due, how far behind, and what to do next for each.',
  '/deposits': 'Security deposits you hold, and the legal deadline for returning each one.',
  '/weekly-report': 'Upload this week’s exports and get a ranked list of who to follow up with.',
  '/ap': 'Bills from vendors: enter them, approve them, record that they were paid.',
  '/approvals': 'Bills, spending requests and deposits waiting for someone to sign off.',
  '/statements': 'What came in, what went out and what is left, by month.',
  '/banking': 'Your bank accounts, and matching the bank’s record against your books.',
  '/reports': 'The report library: rent roll, aging, income, and reports you build yourself.',
  '/gl': 'The full accounts: every journal entry and the chart of accounts.',
  '/periods': 'Close a month so its numbers cannot change afterwards.',
  '/budgets': 'Set a budget for each building and see how the year is tracking against it.',
  '/utilities': 'Meters and utility bills, and billing residents back for their share.',
  '/reserves': 'Money set aside for big replacements such as roofs and boilers.',
  '/owners': 'Owners of each building, their statements and what they have been paid.',
  '/hub/financials': 'A one-page summary of the money side.',
  '/properties': 'Your buildings: address, details and settings for each.',
  '/units': 'Every unit, who is in it, what it rents for, and which are empty.',
  '/map': 'Your buildings on a map.',
  '/insurance': 'Renters insurance for each household, and anything about to lapse.',
  '/student': 'By-the-bed leasing for student housing.',
  '/affordable': 'Income certifications and compliance for affordable housing.',
  '/hub/property': 'A one-page summary of your buildings.',
  '/inbox': 'Every email, text, call and note with a resident or applicant, one thread per person.',
  '/one-inbox': 'Mail forwarded from your office address, matched to people and sorted for you.',
  '/ai': 'Messages and actions drafted for you. Nothing goes out until you say OK.',
  '/comms': 'Write one message and send it to a whole building, or to a group you choose.',
  '/outbox': 'Every message that went out, and whether it was delivered.',
  '/residents': 'Everyone who lives in your buildings, with phone, email and balance.',
  '/leases': 'Each household’s lease: dates, rent, payments and the full ledger.',
  '/renewals': 'Leases ending in the next few months, and the offer for each.',
  '/hub/residents': 'A one-page summary of your residents.',
  '/leads': 'People who asked about a unit, and where each one stands.',
  '/tours': 'Showings that are booked, and who is giving them.',
  '/leasing-center': 'One shared queue for answering inquiries across every building.',
  '/applications': 'Rental applications: screening results and your decision.',
  '/placement-scorecard': 'Which lead sources and agents bring residents who stay and pay.',
  '/leasing/analytics': 'How many inquiries become tours, applications and leases.',
  '/marketing/sites': 'The public website for each building.',
  '/marketing/syndication': 'Where your vacancies are listed.',
  '/hub/leasing': 'A one-page summary of leasing.',
  '/workorders': 'Repair requests: who reported each, who is on it, and what is still open.',
  '/myday': 'The jobs assigned to you today.',
  '/dispatch': 'Hand out today’s jobs to technicians and vendors.',
  '/turns': 'Units between residents, and what is left before each can be rented.',
  '/inspections': 'Move-in, move-out and routine inspections.',
  '/pm': 'Recurring maintenance such as filters and seasonal checks.',
  '/inventory': 'Parts and supplies on hand.',
  '/purchasing': 'Purchase orders: request, approve and receive.',
  '/vendors': 'Plumbers, electricians and other contractors, with phone and insurance status.',
  '/facilities': 'How long repairs take, and what they cost.',
  '/hub/operations': 'A one-page summary of repairs and upkeep.',
  '/dashboards': 'A dashboard you arrange yourself.',
  '/pricing': 'Suggested rents for vacant units and renewals, for you to accept or change.',
  '/ask': 'Ask a question in plain English and get an answer from your own records.',
  '/admin/settings': 'Late fees, policies and defaults for your whole company.',
  '/setup/connections': 'What is switched on: email, text messages, bank feed, payments, listings and AI.',
  '/admin/staff': 'The people on your team, what each can do, and which buildings they see.',
  '/admin/billing': 'What you pay for StayLeased: your plan, unit count and invoices.',
  '/admin/lease-templates': 'The lease documents residents sign.',
  '/admin/export': 'Download everything you have entered, as spreadsheets.',
  '/admin/audit': 'Every change, who made it and when.',
  '/admin/jobs': 'Automatic tasks and when each last ran.',
  '/admin/api': 'Access keys for connecting other software.',
  '/verticals': 'Extra tools for student, affordable and military housing.',
  '/dev/sim': 'Demo only: move the practice date forward and watch the demo company run.',
  '/receivables/payment': 'Find a household and record a check, cash or money order.',
  '/comms/mass/new': 'Start a new message to a building or a group.',
  '/leases/new|New lease': 'Enter a lease by hand: the unit, the people and the rent.',
  '/leases/new|Add a resident (new lease)': 'A resident is added by entering their lease.',
  '/vendors/new': 'Add a contractor you call.',
  '/workorders/new': 'Write up a repair that needs doing.',
  '/setup': 'What is set up, what is left, and where to upload your records.',
  '/setup#upload': 'Bring in a rent roll, a spreadsheet or signed lease PDFs.',
  '/setup#import-history': 'Every file you have uploaded, and what each one added.',
  '/setup/wizard': 'Add a building and its units, step by step.',
  '/welcome': 'The step-by-step walkthrough for a new company.',
  '/one-inbox/setup': 'Forward your office mail and upload the contact list it is matched against.',
  '/admin/roles': 'A table of exactly what each role is allowed to do.',
  '/me': 'Your name, your password and how the screen looks.',
  '/all-pages': 'This page.',
};

const what = (d: Destination): string => WHAT[`${d.href}|${d.label}`] || WHAT[d.href] || '';
const slug = (h: string): string => (h === 'Setup and your company' ? 'setup' : h.toLowerCase());

// ---------- aliases ----------

/** The address people type → where they meant. Only for signed-in staff; for
 * anyone else each stays exactly the 404 it was. Every source here is a path
 * no module serves (tests/find_pages.test.ts holds that), so nothing real is
 * shadowed. */
export const ALIASES: [from: string, to: string][] = [
  ['/sent', '/outbox'],
  ['/messages', '/inbox'],
  ['/mail', '/inbox'],
  ['/settings', '/admin/settings'],
  ['/connections', '/setup/connections'],
  ['/import', '/setup#upload'],
  ['/upload', '/setup#upload'],
  ['/export', '/admin/export'],
  ['/tenants', '/residents'],
  ['/payments', '/receivables'],
  ['/rent', '/receivables'],
  ['/late', '/receivables'],
  ['/notices', '/comms'],
  ['/bills', '/ap'],
  ['/repairs', '/workorders'],
  ['/billing', '/admin/billing'],
  ['/staff', '/admin/staff'],
  ['/users', '/admin/staff'],
  ['/admin', '/setup'],
  ['/help', '/all-pages'],
  ['/sitemap', '/all-pages'],
  ['/search', '/all-pages'],
  ['/residents/new', '/leases/new'],
];

/** Each is an exact path. This module mounts FIRST among the modules so that
 * `/residents/new` is answered here rather than read as a resident id. */
function aliasRoutes(r: Router): void {
  for (const [from, to] of ALIASES) {
    r.get(from, (rq: Rq) => {
      const kind = rq.user?.kind;
      if (kind !== 'staff' && kind !== 'platform') return notFound(`No page at ${rq.path}`);
      const q = from === '/search' ? rq.query.get('q') : null;
      return redirect(q ? `${to}?q=${encodeURIComponent(q)}` : to);
    });
  }
}

// ---------- the index ----------

export function routes(r: Router): void {
  aliasRoutes(r);
  r.get('/all-pages', requireStaff, (rq) => {
    const ctx = rq.ctx as Ctx;
    const mode = uiMode(ctx);
    const query = (rq.query.get('q') || '').trim().slice(0, 60);
    const all = destinations(ctx, mode);
    const needle = query.toLowerCase();
    const matches = (d: Destination): boolean => !needle
      || destScore(d, query) > 0
      || d.label.toLowerCase().includes(needle)
      || (d.alias || '').toLowerCase().includes(needle)
      || what(d).toLowerCase().includes(needle);
    const shown = all.filter(matches);
    const advancedOnly = all.filter((d) => !d.inStandard).length;

    const row = (d: Destination): Raw => html`<li><a class="ap-row" href="${d.href}">
      <span class="ap-name">${d.label}${d.kind === 'action' ? html` <span class="ap-tag">shortcut</span>` : ''}${!d.inStandard ? html` <span class="ap-tag">Advanced menus</span>` : ''}</span>
      <span class="ap-what">${what(d) || d.hint || ''}${d.alias ? html`${what(d) || d.hint ? ' ' : ''}<span class="ap-aka">Also called ${d.alias}.</span>` : ''}</span>
    </a></li>`;

    // everyday pages first, then what only Advanced's menus show, then shortcuts
    const rank = (d: Destination): number => (d.kind === 'action' ? 2 : d.inStandard ? 0 : 1);
    const sections = DEST_HEADINGS.map((h) => ({ h, items: shown.filter((d) => d.heading === h).sort((x, y) => rank(x) - rank(y)) })).filter((x) => x.items.length);

    return shell(rq, {
      title: 'Everything in StayLeased',
      active: '/all-pages',
      subtitle: query
        ? `${shown.length} of ${all.length} places match “${query}”`
        : `${all.length} places you can open, under the same headings as the menu.`,
      content: html`
        <form method="get" action="/all-pages" class="ap-find" role="search">
          <label for="ap-q">Find a page</label>
          <div class="ap-find-row">
            <input id="ap-q" name="q" type="search" value="${query}" placeholder="Type a word: late, bills, notice, export…" autocomplete="off" />
            <button class="btn" type="submit">Find</button>
            ${when(query, () => html`<a class="btn btn-ghost" href="/all-pages">Show everything</a>`)}
          </div>
        </form>
        ${when(!query && sections.length > 1, () => html`<nav class="ap-jump" aria-label="Jump to a section">
          ${sections.map((s) => html`<a href="#${slug(s.h)}">${s.h}</a>`)}
        </nav>`)}
        ${sections.length
          ? sections.map((s) => html`<section class="ap-sec" id="${slug(s.h)}" aria-labelledby="ap-h-${slug(s.h)}">
              <h2 id="ap-h-${slug(s.h)}">${s.h}</h2>
              <ul class="ap-list">${s.items.map(row)}</ul>
            </section>`)
          : emptyState(`Nothing matches “${query}”`, 'Try a shorter word, or the name of the thing rather than the task.',
              html`<a class="btn btn-ghost" href="/all-pages">Show everything</a>`)}
        ${when(advancedOnly > 0 && !query, () => html`<p class="ap-foot">Pages marked <span class="ap-tag">Advanced menus</span> open from here in either mode.
          ${mode === 'standard' ? raw('To see them in the menus as well, press <b>Advanced</b> at the end of the menu bar.') : raw('Standard’s menus leave them out; nothing is switched off.')}</p>`)}
        <p class="ap-foot">Looking for a person, a unit or an invoice rather than a page? Press <b>Find anything</b> at the top of the screen and type the name.</p>`,
    });
  });
}
