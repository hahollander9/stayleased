import { html, raw, when, type Raw } from '../../lib/html.ts';
import { notFound, redirect, type Router, type Res } from '../../lib/http.ts';
import { mkHeader, mkFooter, mkDoc, mkSignupOpen, MK_NAV, ldJson, siteOrigin } from './chrome.ts';

/** Dedicated marketing pages behind every nav-dropdown item — a real page
 * per product, curated to what StayLeased actually does and written for
 * small operators (including ones who have never used AI). Groups:
 * /platform (operator modules, incl. the resident portal as ONE item —
 * we're not marketing a resident-experience pillar yet), /agents (the AI,
 * led by a new-to-AI explainer), /for (audiences). Where an external rail
 * is still in rollout (card/ACH processing, screening bureau, ILS
 * syndication, carrier verification), the page says so with a status chip
 * and an FAQ answer instead of pretending — same honesty contract as
 * /setup/connections. Rent reporting was dropped entirely: not in the
 * product, so no page. Old /resident/* URLs 301 to the portal page. */

export interface MkPage {
  slug: string;
  group: 'platform' | 'agents' | 'for';
  label: string; // nav label
  title: string; // h1
  sub: string;
  chip?: { kind: 'live' | 'soon'; text: string };
  points: string[]; // hero checkmarks
  stats: { b: string; s: string }[]; // proof strip
  features: { t: string; b: string }[];
  mock: { kpis: [string, string][]; feed: [string, string][] };
  faq: { q: string; a: string }[];
  related: { label: string; href: string }[];
}

export const MK_GROUPS: Record<MkPage['group'], { base: string; name: string; kicker: string; lead: string }> = {
  platform: { base: '/platform', name: 'Platform', kicker: 'The system of record', lead: 'Leasing, rent, maintenance, and real books in one login — including a portal your tenants will actually use.' },
  agents: { base: '/agents', name: 'AI', kicker: 'Help that drafts, you approve', lead: 'AI that answers leads, follows up on rent, sorts maintenance, and drafts renewals — every message starting as a draft in your approval queue. New to AI? Start with the first page.' },
  for: { base: '/for', name: "Who it's for", kicker: 'Built for independent operators', lead: 'StayLeased is designed for the owners and managers who operate most of America’s rental housing — not 20,000-unit institutions.' },
};

export const MK_PAGES: MkPage[] = [
  // ---------------- Platform ----------------
  {
    slug: 'rent-collection', group: 'platform', label: 'Rent collection',
    title: 'Rent collection that runs itself — and books itself.',
    sub: 'Monthly charges post on schedule, late fees follow your policy to the letter, autopay keeps the money predictable, and the Payments AI follows up on every remaining balance with a tone you approve.',
    chip: { kind: 'soon', text: 'Payment recording + books fully live · card/ACH processing rail in rollout' },
    points: [
      'Rent, prorations, and recurring charges billed automatically on your schedule',
      'Late fees applied by policy — grace days, flat or percent, per property',
      'Every payment posts through real double-entry books the moment it lands',
    ],
    stats: [
      { b: 'Autopay + receipts', s: 'Residents pay in the portal; receipts and a clear ledger, always' },
      { b: 'Payment plans in bounds', s: 'Structured plans inside limits you set — never improvised' },
      { b: 'Delinquency queue', s: 'Every balance aged, prioritized, and worked from one screen' },
    ],
    features: [
      { t: 'Automatic monthly billing', b: 'Charges generate from the lease — rent, pet fees, parking, utilities — with prorations handled on move-in, move-out, and mid-month changes.' },
      { t: 'Late-fee policy engine', b: 'Grace periods, flat or percentage fees, and caps set at the org or property level. The system applies them consistently, every month, without exceptions slipping through.' },
      { t: 'Autopay & resident payments', b: 'Residents set up autopay or pay a balance in the portal in seconds, with instant receipts and a running ledger they can actually read.' },
      { t: 'AI follow-up on every balance', b: 'The Payments AI drafts reminders matched to balance size and days late, inside compliance rails, queued for your approval — or fully autonomous where you dial it up.' },
      { t: 'Deposits done right', b: 'Security deposits tracked as liabilities the way an accountant expects, with dispositions and deposit-alternative support at move-out.' },
      { t: 'Real accounting underneath', b: 'Every charge and payment is a balanced journal entry in the same books your reports run from. No export, no re-key, no month-end surprise.' },
    ],
    mock: {
      kpis: [['96.8%', 'Collected · July'], ['$412k', 'Collected MTD'], ['11', 'Open balances'], ['6', 'AI reminders queued']],
      feed: [
        ['Payments AI', 'drafted 6 friendly reminders · queued for approval'],
        ['Autopay', 'posted $28,400 across 19 leases this morning'],
        ['Late-fee policy', 'applied 3 fees after the 5-day grace · Summit Ridge'],
      ],
    },
    faq: [
      { q: 'Do residents actually move money through StayLeased today?', a: 'Payments recorded in StayLeased post through real double-entry books instantly. The card/ACH processing rail is in controlled rollout with early-access partners — until it reaches your account, you keep collecting the way you do now and record it here, and the books stay perfect. Waitlist is one click on Setup → Connections.' },
      { q: 'Can I customize late fees per property?', a: 'Yes — grace days, fee type (flat or percent), and caps are policy settings at the org level with per-property overrides. The engine applies them identically every month.' },
      { q: 'What does the AI say to late residents?', a: 'Templates you approve, with tone matched to balance and days late. Hard compliance rails ban threatening language, and anything outside your bounds escalates to a human. Every message lands in the audit trail.' },
    ],
    related: [
      { label: 'Payments AI', href: '/agents/payments' },
      { label: 'Accounting', href: '/platform/accounting' },
      { label: 'Resident portal', href: '/platform/resident-portal' },
    ],
  },
  {
    slug: 'leasing-crm', group: 'platform', label: 'Leasing CRM',
    title: 'Every lead answered in seconds. Every tour booked while you sleep.',
    sub: 'Leads from your listings, property sites, and walk-ins land on one guest card with real source attribution — and the Leasing AI takes the first touch instantly, from live availability and pricing.',
    points: [
      'Per-property intake email addresses turn Zillow, Apartments.com, and Zumper inquiries into leads automatically — live today',
      'Guest cards, dedupe by email and phone, tours against real calendar slots',
      'Funnel reporting from inquiry to lease with source attribution that’s actually true',
    ],
    stats: [
      { b: 'ILS email intake · live', s: 'Point any listing’s lead email at your intake address — done' },
      { b: 'First touch in seconds', s: 'The Leasing AI answers from live availability, not a script' },
      { b: 'One pipeline', s: 'Website, ILS, phone, and walk-in leads in a single queue' },
    ],
    features: [
      { t: 'Automatic lead intake', b: 'Every listing site delivers inquiries by email. Each property gets an unguessable intake address — set it as the lead email on your listings (or auto-forward your current inbox) and every inquiry becomes a lead with the prospect’s own words on the thread.' },
      { t: 'Instant AI first touch', b: 'Website and ILS leads get a grounded reply in seconds — availability, pricing, tour offers — under the property’s autonomy dial, with fair-housing guardrails on every message.' },
      { t: 'Guest cards that stay clean', b: 'Dedupe by email and phone, full conversation threads, notes, and activity history — one card per human, no matter how many times they inquire.' },
      { t: 'Tour scheduling', b: 'Real tour slots from each property’s hours; prospects book from the property site and confirmations thread back to the card.' },
      { t: 'Follow-up that actually happens', b: 'Cadences run until a prospect answers or opts out. The 48-hour silence that kills most small-operator leasing simply stops happening.' },
      { t: 'Funnel & source reporting', b: 'Inquiry → tour → application → lease conversion by property and by source, so you know which listings earn their keep.' },
    ],
    mock: {
      kpis: [['41s', 'First response'], ['23', 'Active leads'], ['7', 'Tours this week'], ['3', 'Apps in review']],
      feed: [
        ['Leasing AI', 'replied to a Zillow lead · 41 seconds'],
        ['Intake', 'new lead from Apartments.com → Foundry Lofts guest card'],
        ['Tours', 'Sam K. booked Sat 11:00 · confirmation sent'],
      ],
    },
    faq: [
      { q: 'How do leads from Zillow or Apartments.com get in?', a: 'Every listing site delivers inquiries by email. On Setup → Connections each property has a private intake address — set it as the listing’s lead email and inquiries become leads, threads, and an instant AI first touch with zero staff involvement. This lane is live in production today.' },
      { q: 'Does the AI make things up about pricing or availability?', a: 'No. It answers from the same live availability and pricing tables the rest of the system runs on, and a deterministic fair-housing guardrail screens every prospect-facing message. Anything it can’t answer escalates to you.' },
      { q: 'Can I try it with one of my real lead emails?', a: 'Yes — Setup → Connections has a “Test it now” lane: paste any lead email you’ve received and watch it run the exact intake pipeline to a guest card.' },
    ],
    related: [
      { label: 'Leasing AI', href: '/agents/leasing' },
      { label: 'Property sites & listings', href: '/platform/property-sites' },
      { label: 'Applications & screening', href: '/platform/applications-screening' },
    ],
  },
  {
    slug: 'maintenance', group: 'platform', label: 'Maintenance & turns',
    title: 'Maintenance triaged 24/7. Turns that never lose a day.',
    sub: 'Requests arrive with photos, the Maintenance AI triages category, priority, and emergencies on arrival, vendors get dispatched with your approval — and turn boards keep every vacant unit moving toward rent-ready.',
    points: [
      'Emergency escalation and troubleshooting before a truck rolls',
      'Work orders with photos, threads, vendor assignment, and cost tracking',
      'Turn boards, make-ready checklists, preventive schedules, and inspections',
    ],
    stats: [
      { b: 'Triage on arrival', s: 'Category, priority, and emergency detection the moment a request lands' },
      { b: 'Vendor dispatch', s: 'Assign your people or your vendors, with approvals where you want them' },
      { b: 'Turns tracked', s: 'Every vacant unit on a board from notice to rent-ready' },
    ],
    features: [
      { t: 'Resident requests with photos', b: 'Residents submit from the portal with photos and access notes; the request threads like a conversation, with updates they can see — so “any news?” calls stop.' },
      { t: 'AI triage & troubleshooting', b: 'The Maintenance AI classifies category and priority, escalates emergencies (water, gas, no-heat) immediately, and walks residents through safe first steps — shut-off valves before service calls.' },
      { t: 'Work orders & dispatch', b: 'Assign in-house staff or vendors, schedule windows, track parts and costs, capture completion notes and resident satisfaction ratings.' },
      { t: 'Turn management', b: 'Notice-to-rent-ready boards per property: inspection, punch list, vendors, cleaning, photos — with days-vacant staring at you until it’s done.' },
      { t: 'Preventive maintenance', b: 'Recurring schedules for the things that get forgotten — filters, gutters, inspections — generated as work orders on cadence.' },
      { t: 'Costs into the books', b: 'Work-order costs post to the right property and GL account, so maintenance spend shows up honestly in your financials.' },
    ],
    mock: {
      kpis: [['14', 'Open work orders'], ['2', 'Emergencies · 0 waiting'], ['4', 'Units in turn'], ['4.7', 'Avg satisfaction']],
      feed: [
        ['Maintenance AI', 'escalated a water leak · Unit 204 · vendor paged'],
        ['Turns', 'Unit 112 passed final inspection · rent-ready'],
        ['PM schedule', 'quarterly filter change generated 38 work orders'],
      ],
    },
    faq: [
      { q: 'What counts as an emergency, and what happens?', a: 'Water intrusion, gas smell, no heat in winter, lockouts you define — the AI flags them on arrival, notifies the on-call contact immediately, and gives the resident safe first steps while help is en route. The escalation list is your policy.' },
      { q: 'Can vendors see or update work orders?', a: 'Yes — vendors get a scoped view of their assigned work orders to accept, schedule, and mark complete with notes and costs, without seeing anything else in your operation.' },
      { q: 'Does this handle turns between residents?', a: 'Turns are first-class: a per-unit board from notice through inspection, punch list, and make-ready, with vendor tasks and days-vacant tracking so nothing sits idle unnoticed.' },
    ],
    related: [
      { label: 'Maintenance AI', href: '/agents/maintenance' },
      { label: 'Resident portal', href: '/platform/resident-portal' },
      { label: 'Reports', href: '/platform/reports' },
    ],
  },
  {
    slug: 'accounting', group: 'platform', label: 'Accounting',
    title: 'Real double-entry books. Not a payments app with categories.',
    sub: 'A full general ledger under everything — cash and accrual side by side, bank reconciliation, AP, budgets, replacement reserves, period close, and owner-ready statements — kept current automatically by the operation itself.',
    points: [
      'Every operational event posts as a balanced journal entry, instantly',
      'Dual-basis: cash and accrual views of the same truth',
      'Bank reconciliation, AP approvals, replacement reserves, and period locks',
    ],
    stats: [
      { b: 'Books by default', s: 'Rent, fees, deposits, and bills post themselves — correctly' },
      { b: 'Owner-ready output', s: 'Statement packets, owner statements, and GL detail on demand' },
      { b: 'Clean conversions', s: 'Opening balances and billing-start dates prevent double-billing on migration' },
    ],
    features: [
      { t: 'General ledger, done properly', b: 'A real chart of accounts per company with property-level dimensions. Debits equal credits on every entry because entries come from the system, not from memory.' },
      { t: 'Cash + accrual, together', b: 'Both bases maintained simultaneously — see cash truth for yourself and accrual truth for your CPA without keeping two sets of anything.' },
      { t: 'Accounts payable', b: 'Vendor bills with coding, approval workflow, and payment tracking; costs land on the right property and account every time.' },
      { t: 'Bank reconciliation', b: 'Statement-to-ledger reconciliation with matching and adjustment workflows, so the books tie to the bank — the test most small-operator books fail.' },
      { t: 'Statement packets', b: 'Save a statement pull once — scope and basis — and reopen it as one page: trailing-12 income statement, balance sheet, and cash flow together, with CSV and PDF a click away.' },
      { t: 'Replacement reserves', b: 'A funding plan per property moves money to a designated reserve monthly, on the books; draws route through approval. The roof fund exists visibly, instead of living in a spreadsheet.' },
      { t: 'Owner statements', b: 'Ownership percentages per property produce per-owner statements: each owner’s share of operating results across everything they hold, consolidated — equity income without the side spreadsheet.' },
      { t: 'Budgets & variance', b: 'Property budgets with budget-vs-actual reporting, so “how are we doing” has a number.' },
      { t: 'Periods & close', b: 'Monthly periods you can close and lock. Postings into a closed month are blocked, reopening is permissioned and audited, and the numbers stakeholders received stay the numbers.' },
    ],
    mock: {
      kpis: [['$1.24M', 'YTD revenue'], ['100%', 'Entries balanced'], ['3', 'Bills awaiting approval'], ['Jun', 'Period closed']],
      feed: [
        ['GL', 'July rent run posted · 187 balanced entries'],
        ['Bank rec', 'operating account reconciled to statement · $0 variance'],
        ['Reserves', 'monthly funding posted · roof-project draw approved'],
      ],
    },
    faq: [
      { q: 'I migrated mid-year — are my books usable?', a: 'Yes. Conversion accounting brings prior balances in as opening balances (not fake transactions), and each lease’s billing start date guarantees StayLeased never re-bills a month your old system already billed.' },
      { q: 'Will my CPA accept these books?', a: 'Your CPA gets a real GL: chart of accounts, journal detail, trial balance, P&L and balance sheet on either basis, exportable. It’s the same double-entry structure they’d build themselves.' },
      { q: 'How do I pull statements for stakeholders without redoing the setup every month?', a: 'Save the pull as a statement packet — scope and basis remembered. From then on it’s one click: trailing-12 income statement, balance sheet, and cash flow on one page, exportable as CSV or PDF for a lender, board, or owner.' },
      { q: 'Do I have to be an accountant to use this?', a: 'No — the operation does the accounting. You collect rent and approve bills; the entries, basis handling, and reports happen underneath. The accounting screens are there when you (or your CPA) want them.' },
    ],
    related: [
      { label: 'Rent collection', href: '/platform/rent-collection' },
      { label: 'Reports', href: '/platform/reports' },
      { label: 'Growing portfolios', href: '/for/growing-portfolios' },
    ],
  },
  {
    slug: 'purchasing', group: 'platform', label: 'Purchasing & payables',
    title: 'Vendor spend, from request to reconciled payment.',
    sub: 'Purchase orders priced from an internal catalog and negotiated vendor agreements, amount-routed approvals, receiving, two- and three-way invoice matching, 1099s, and spend analytics — purchasing that ends in books that tie.',
    points: [
      'An internal catalog with negotiated per-vendor pricing on every PO',
      'Approval chains routed by amount before money is committed',
      'Invoices matched against PO and receipt before they can be paid',
    ],
    stats: [
      { b: 'Agreed prices, enforced', s: 'POs price from vendor agreements automatically — no rate drift' },
      { b: 'Coded at the source', s: 'Every line lands on the right GL account, property, and project' },
      { b: 'Matched before paid', s: '2/3-way matching with a tolerance-driven exception queue' },
    ],
    features: [
      { t: 'Internal catalog', b: 'A priced catalog of the materials the operation actually buys — filters, paint, appliances, locks — with units, GL coding, and preferred vendors built in. Ordering is picking, not retyping.' },
      { t: 'Vendor price agreements', b: 'Negotiate a rate once and the system enforces it: any PO for that vendor and item prices at the agreed rate automatically, for as long as the agreement runs.' },
      { t: 'Approval chains by amount', b: 'Small orders clear at the property; larger ones route up an amount-based chain before commitment. The threshold is a setting, not a habit.' },
      { t: 'Receiving & matching', b: 'Full or partial receiving restocks inventory, and vendor invoices match against PO and receipt — with a tolerance-driven exception queue for the ones that don’t.' },
      { t: 'Vendor records & 1099s', b: 'W-9s, COIs, payment terms, payment history, and year-end 1099 summaries live in the same place the money moves.' },
      { t: 'Spend analytics', b: 'Where the money went — by category, vendor, and property. The consolidated vendor view that turns scattered purchasing into negotiating leverage.' },
    ],
    mock: {
      kpis: [['12', 'Open POs'], ['100%', 'Lines GL-coded'], ['2', 'Match exceptions'], ['$48.2k', 'Month vendor spend']],
      feed: [
        ['PO', 'filter pre-buy approved · priced from vendor agreement'],
        ['Receiving', 'partial receipt posted · inventory restocked'],
        ['Match', 'invoice 7% over PO · queued as an exception'],
      ],
    },
    faq: [
      { q: 'What is an “agreed price” on a PO?', a: 'A vendor price agreement: a negotiated rate for a catalog item with an effective window. When a PO uses that vendor and item, the agreed price is applied automatically and the PO routes through the same amount-based approval chain as everything else.' },
      { q: 'Can property managers order without finance losing control?', a: 'Yes — that is what amount-routed approval is for. Orders under the threshold clear immediately; anything larger routes to an approver before it becomes a commitment.' },
      { q: 'Does purchasing hit the books?', a: 'Approved invoices post as balanced journal entries with property and project dimensions, payments run through AP, and bank reconciliation ties it out. Purchasing is a front door to the same ledger, not a side system.' },
    ],
    related: [
      { label: 'Accounting', href: '/platform/accounting' },
      { label: 'Maintenance & turns', href: '/platform/maintenance' },
      { label: 'Reports', href: '/platform/reports' },
    ],
  },
  {
    slug: 'leases-esign', group: 'platform', label: 'Leases & e-sign',
    title: 'From application to signed lease without printing anything.',
    sub: 'Lease templates assemble into packets, packets go out for e-signature, renewals generate on schedule, and every executed document lives on the lease it belongs to.',
    points: [
      'Templates with merge fields build consistent leases every time',
      'E-signature flow for applicants and residents — no third-party tool',
      'Renewals, notices, and month-to-month transitions handled on schedule',
    ],
    stats: [
      { b: 'Packets, not paperwork', s: 'Lease + addenda + disclosures assembled and sent as one' },
      { b: 'Signed in the browser', s: 'Residents sign from a link; execution status tracked live' },
      { b: 'Everything filed', s: 'Executed documents attached to the lease, forever findable' },
    ],
    features: [
      { t: 'Lease templates', b: 'Standard templates with merge fields for property, unit, pricing, dates, and policies — new companies start with a working set and adjust from there.' },
      { t: 'Packet assembly', b: 'Combine the lease with addenda (pets, parking, utilities) and disclosures into one packet generated from live lease data — no re-typing rent amounts into Word.' },
      { t: 'Built-in e-sign', b: 'Signers get a secure link, sign in the browser, and the executed packet lands on the lease record with a full signature trail.' },
      { t: 'Renewal generation', b: 'Renewal offers become renewal leases in one step, with terms carried forward and changes tracked — paired with the Renewals AI when you want offers proposed for you.' },
      { t: 'Notices & transitions', b: 'Notice-to-vacate, month-to-month rollovers with premiums, and move-out workflows tied to deposits and final statements.' },
      { t: 'One timeline per lease', b: 'Applications, signatures, amendments, charges, and communications on a single lease history — the answer to “what did we agree to?” in one click.' },
    ],
    mock: {
      kpis: [['5', 'Out for signature'], ['12', 'Renewals this quarter'], ['100%', 'Docs on-file'], ['2', 'MTM rollovers']],
      feed: [
        ['E-sign', 'Unit 305 lease executed · all parties signed'],
        ['Renewals', '12 offers generated for October expirations'],
        ['Packets', 'pet addendum added to draft · Unit 118'],
      ],
    },
    faq: [
      { q: 'Are the templates legally reviewed for my state?', a: 'Templates are a working starting point, not legal advice — have your attorney review your lease language once, load it in, and the system fills it perfectly every time after that.' },
      { q: 'Is the e-signature valid?', a: 'Signatures capture signer identity, timestamps, and document hashes in an audit trail — the structure e-sign validity relies on. As with any lease process, confirm requirements for your jurisdiction with counsel.' },
      { q: 'What happens at renewal time?', a: 'You set the window (say, 90 days out). Expiring leases surface with pricing recommendations; offers go out, and an accepted offer becomes the renewal lease with documents regenerated and re-signed.' },
    ],
    related: [
      { label: 'Renewals & pricing', href: '/platform/renewals-pricing' },
      { label: 'Applications & screening', href: '/platform/applications-screening' },
      { label: 'Renewals AI', href: '/agents/renewals' },
    ],
  },
  {
    slug: 'applications-screening', group: 'platform', label: 'Applications & screening',
    title: 'Applications in, decisions out — with criteria you set once.',
    sub: 'Prospects apply online from the property site, applications route through your written criteria, and decisions get made consistently — the fair-housing-safe way to say yes and no.',
    chip: { kind: 'soon', text: 'Criteria + decisioning workflow live · screening-bureau integration on the waitlist' },
    points: [
      'Online application from any listing or property site, tied to the guest card',
      'Written criteria applied the same way to every applicant',
      'Approve, conditionally approve, or decline with a documented trail',
    ],
    stats: [
      { b: 'One click from the site', s: 'Apply links on property sites and in AI conversations' },
      { b: 'Criteria, not vibes', s: 'Income ratios, history, and policy checks in one place' },
      { b: 'Documented decisions', s: 'Every decision stamped, reasoned, and audit-trailed' },
    ],
    features: [
      { t: 'Online applications', b: 'Applicants complete household, income, history, and disclosures from a link; drafts save, co-applicants join, and the application lands on the guest card it came from.' },
      { t: 'Your criteria, written down', b: 'Income-to-rent ratios, history rules, and property policies configured as criteria — the anchor of consistent, defensible screening.' },
      { t: 'Decision workflow', b: 'Approve, conditional (higher deposit, guarantor), or decline — each with reasons recorded and next steps generated, from approval-to-lease in one step.' },
      { t: 'Bureau integration (rolling out)', b: 'Credit, criminal, and eviction data from a screening bureau attaches to this same workflow. Until it reaches your account, run your current bureau alongside — decisions and documentation still live here.' },
      { t: 'Fair-housing posture', b: 'Uniform criteria, uniform process, documented reasons — the process shape that fair-housing compliance asks for, built into the software instead of a binder.' },
      { t: 'Straight to lease', b: 'An approved application becomes a lease draft with the applicant, unit, and terms carried over. No re-keying the same name five times.' },
    ],
    mock: {
      kpis: [['3', 'Apps in review'], ['1.9d', 'Avg decision time'], ['100%', 'Criteria applied'], ['2', 'Ready for lease']],
      feed: [
        ['Applications', 'new application · Foundry Lofts 2BR · household of 2'],
        ['Decisioning', 'app #182 meets criteria · recommended approve'],
        ['Leases', 'approved app converted to lease draft · Unit 118'],
      ],
    },
    faq: [
      { q: 'Can I pull credit and background checks today?', a: 'The bureau rail is in rollout — join the waitlist on Setup → Connections. Until then, operators run their existing bureau for the data pull while applications, criteria, decisions, and documentation all live in StayLeased. The moment the rail reaches you, the data pull joins the same flow.' },
      { q: 'How does this help with fair housing?', a: 'Consistency. Written criteria, identical process per applicant, and decisions with recorded reasons — plus AI guardrails that keep prospect-facing conversations inside neutral, compliant language.' },
      { q: 'Do applicants pay an application fee?', a: 'Fee amounts are your policy per property. Fees are charged and tracked with the application record; processing follows the payments rail rollout.' },
    ],
    related: [
      { label: 'Leasing CRM', href: '/platform/leasing-crm' },
      { label: 'Leases & e-sign', href: '/platform/leases-esign' },
      { label: 'Approvals & control', href: '/agents/governance' },
    ],
  },
  {
    slug: 'property-sites', group: 'platform', label: 'Property sites & listings',
    title: 'A leasing website per property — with pricing that’s never stale.',
    sub: 'Every property gets its own site with live availability, real pricing, photo galleries, amenities, and tour booking — kept current from the same records your team operates in, so it is never out of date.',
    chip: { kind: 'soon', text: 'Property sites + ILS lead-email intake live · listing syndication feed on the waitlist' },
    points: [
      'Live floorplan availability and starting-at pricing, straight from the system',
      'Inquiries and tour bookings land on guest cards instantly',
      'Editable branding, copy, photos, and sections per property',
    ],
    stats: [
      { b: 'Always accurate', s: 'A unit leases → the site updates. No Tuesday-morning edits' },
      { b: 'SEO plumbing included', s: 'Clean URLs, metadata, sitemaps — findable by default' },
      { b: 'Tour booking built in', s: 'Real slots from property hours, confirmed automatically' },
    ],
    features: [
      { t: 'Site per property', b: 'Hero, gallery, amenities, neighborhood, floorplans, and tour sections — toggle sections on or off, set the theme color, publish when ready.' },
      { t: 'Live availability & pricing', b: 'Floorplans show real vacant-ready counts and starting-at prices computed from actual units — the same numbers your leasing team sees.' },
      { t: 'Inquiries → guest cards', b: 'Site inquiries create leads with source attribution and trigger the Leasing AI’s instant first touch under your autonomy dial.' },
      { t: 'Tour scheduling', b: 'Prospects pick from real available slots; bookings confirm automatically and appear on the card and calendar.' },
      { t: 'ILS lead intake — live', b: 'List anywhere (Zillow, Apartments.com, Zumper) and point the listing’s lead email at your per-property intake address. Inquiries become leads and get answered in seconds. Live in production today.' },
      { t: 'Syndication feed (rolling out)', b: 'Publishing listings outward to ILS platforms by feed is on the waitlist — today you manage the listing on each ILS and let the intake rail catch every lead automatically.' },
    ],
    mock: {
      kpis: [['3', 'Published sites'], ['214', 'Site visits · 7d'], ['9', 'Inquiries · 7d'], ['5', 'Tours booked']],
      feed: [
        ['Site', 'Summit Ridge: 2BR “Aspen” now showing 3 available'],
        ['Inquiry', 'site visitor asked about pet policy → lead + AI reply'],
        ['Tours', 'self-scheduled tour · Sunday 2:00 · confirmed'],
      ],
    },
    faq: [
      { q: 'Do I need my own domain?', a: 'Sites live at your StayLeased address out of the box and work immediately. Custom domains per property are on the roadmap; most small operators find the built-in address plus ILS listings covers discovery.' },
      { q: 'Does StayLeased push my listings to Zillow?', a: 'Outbound syndication by feed is on the waitlist. What’s live now is the other (more valuable) half: every inquiry from every ILS flows in automatically via your per-property lead email and gets an instant, grounded AI response.' },
      { q: 'Can I edit the site myself?', a: 'Yes — copy, photos, amenities, theme, and section visibility are editable per property in Marketing → Sites, with changes live on publish.' },
    ],
    related: [
      { label: 'Leasing CRM', href: '/platform/leasing-crm' },
      { label: 'Leasing AI', href: '/agents/leasing' },
      { label: 'Applications & screening', href: '/platform/applications-screening' },
    ],
  },
  {
    slug: 'renewals-pricing', group: 'platform', label: 'Renewals & pricing',
    title: 'Price with evidence. Renew with confidence.',
    sub: 'Under-market units get flagged with evidence, renewal offers generate inside bounds you set, and the Renewals AI personalizes and negotiates within your matrix — escalating to you the moment anything falls outside it.',
    points: [
      'Under-market flags comparing in-place rent to current pricing',
      'Renewal offers generated on your calendar, inside your bounds',
      'Counters evaluated against your matrix — never improvised',
    ],
    stats: [
      { b: 'Evidence, not gut feel', s: 'Every recommendation shows the comparison behind it' },
      { b: 'Your bounds, hard-coded', s: 'Max increases and floors the AI cannot cross' },
      { b: 'Renewal-first economics', s: 'A saved renewal beats a turn + vacancy every time' },
    ],
    features: [
      { t: 'Pricing intelligence', b: 'In-place rents compared against current market rents by floorplan and unit, with under-market and over-market flags surfaced where you’ll see them.' },
      { t: 'Recommendation review', b: 'Accept, adjust, or reject pricing recommendations — accepted changes flow to unit pricing, property sites, and future offers.' },
      { t: 'Renewal offer engine', b: 'Offers generate ahead of expirations on your schedule with terms and increases inside org- and property-level bounds.' },
      { t: 'AI-personalized offers', b: 'The Renewals AI drafts offers that acknowledge the resident’s actual history — tenure, payment record, maintenance experience — inside your pricing bounds.' },
      { t: 'Counter handling', b: 'When a resident counters, the AI evaluates against your matrix: acceptable counters can be accepted at your dial setting; anything else escalates with context.' },
      { t: 'Expiration management', b: 'An expiration pipeline by month so you see the cliff coming — offers out, responses, signed renewals, and holdouts at a glance.' },
    ],
    mock: {
      kpis: [['8', 'Under-market flags'], ['12', 'Offers out'], ['67%', 'Renewal acceptance'], ['$180', 'Avg increase held']],
      feed: [
        ['Pricing', 'Unit 214 flagged $130 under market · evidence attached'],
        ['Renewals AI', 'personalized offer drafted · 4-year resident · queued'],
        ['Counter', 'resident countered $25 below offer · within matrix · accepted'],
      ],
    },
    faq: [
      { q: 'Will the AI raise rents without asking me?', a: 'No. Pricing recommendations require your acceptance, offers generate inside bounds you configure, and the autonomy dial decides whether offers send automatically or queue for approval. Bounds are hard limits, not suggestions.' },
      { q: 'Where does “market rent” come from?', a: 'From your own portfolio’s current pricing by floorplan and unit type — the honest baseline a small operator actually has. You stay in control of what the market number is.' },
      { q: 'What if a resident negotiates?', a: 'Counters inside your matrix can be accepted on the spot (at your dial setting); anything outside it escalates to you with the resident’s history and the numbers side by side.' },
    ],
    related: [
      { label: 'Renewals AI', href: '/agents/renewals' },
      { label: 'Leases & e-sign', href: '/platform/leases-esign' },
      { label: 'Reports', href: '/platform/reports' },
    ],
  },
  {
    slug: 'reports', group: 'platform', label: 'Reports',
    title: 'Fifty answers, zero exports.',
    sub: 'A 50-report catalog across leasing, receivables, financials, facilities, and utilities — plus a custom report builder and scheduled runs — all reading the same live records your operation maintains.',
    points: [
      'Occupancy, exposure, delinquency, P&L, GL detail, work-order aging, and more',
      'Custom builder for the report only you need',
      'Scheduled runs delivered on cadence to your team',
    ],
    stats: [
      { b: '50-report catalog', s: 'Curated reports across every module, ready on day one' },
      { b: 'Live numbers', s: 'Reports read your live operating records — no sync, no stale copy' },
      { b: 'Owner-ready', s: 'Financial packages your owners and CPA can take as-is' },
    ],
    features: [
      { t: 'The catalog', b: 'Rent roll, occupancy and exposure, delinquency aging, collections, lease expirations, P&L, balance sheet, trial balance, GL detail, AP aging, work-order performance, utility recovery — organized by module, filterable by property and period.' },
      { t: 'Custom report builder', b: 'Pick the dataset, choose columns, filter, group, and save. The one weird report your Thursday meeting needs, built once.' },
      { t: 'Scheduled delivery', b: 'Any report on a cadence — weekly delinquency to you, monthly financial package to each owner — generated on the business calendar and delivered to your team.' },
      { t: 'Dashboards on top', b: 'KPI dashboards for the daily glance — occupancy, collections, leasing funnel, maintenance load — with the full report one click deeper.' },
      { t: 'Export anything', b: 'Every report exports clean. Your data is yours, including on the way out.' },
      { t: 'Ask instead of hunting', b: 'Ask StayLeased answers “how’s collections this month?” conversationally from the same governed data — for the questions that don’t deserve a report.' },
    ],
    mock: {
      kpis: [['50+', 'Reports in catalog'], ['6', 'Scheduled runs'], ['3', 'Custom reports'], ['94.2%', 'Occupancy right now']],
      feed: [
        ['Scheduler', 'weekly delinquency aging generated · sent to ops'],
        ['Builder', 'custom “units w/ pets by property” saved'],
        ['Dashboards', 'exposure widget: 12 expirations next 60 days'],
      ],
    },
    faq: [
      { q: 'Are these reports real-time?', a: 'They read your live operating records at run time. A payment posted a minute ago appears in the report you run now — there is no overnight sync because there is nothing to sync.' },
      { q: 'Can owners get their own package?', a: 'Yes. Define owners and their ownership percentages, and each owner gets a consolidated statement of their share of operating results — equity income — across every property they hold, exportable as CSV or PDF. A dedicated read-only owner login is on the roadmap; today most operators send the exported package.' },
      { q: 'What if the report I need doesn’t exist?', a: 'Build it: choose the dataset and columns, filter and group, save and schedule. If it’s a common ask, tell us — the catalog grows from operator requests.' },
    ],
    related: [
      { label: 'Accounting', href: '/platform/accounting' },
      { label: 'Ask StayLeased', href: '/agents/ask-stayleased' },
      { label: 'Growing portfolios', href: '/for/growing-portfolios' },
    ],
  },
  {
    slug: 'utilities-rubs', group: 'platform', label: 'Utilities & RUBS',
    title: 'Bill utilities back fairly — without a spreadsheet ritual.',
    sub: 'Capture utility bills, allocate them across units by the method you choose, and post the charges to resident ledgers automatically. RUBS without the monthly math night.',
    points: [
      'Allocation by square footage, occupancy, unit count, or custom split',
      'Charges post straight to resident ledgers with clear line items',
      'Vacant-unit costs tracked to the property, not silently eaten',
    ],
    stats: [
      { b: 'Fair by formula', s: 'One allocation method, applied identically every month' },
      { b: 'On the ledger', s: 'RUBS charges bill like rent — visible, disputable, collectable' },
      { b: 'Recovery visible', s: 'Utility recovery reporting shows what you recouped' },
    ],
    features: [
      { t: 'Utility expense capture (rolling out)', b: 'Bill capture — water, sewer, trash, gas, electric, with period and amount coded to the right GL account — is in rollout; the demo shows the full cycle end to end on simulated meter and invoice data.' },
      { t: 'Allocation methods', b: 'Divide by occupied units, all units, square footage, occupant count, or custom ratios per property — whichever your leases specify.' },
      { t: 'Automatic charge posting', b: 'Allocated amounts post to each resident ledger as labeled utility charges in the next billing cycle — collected with rent, followed up by the same Payments AI.' },
      { t: 'Common-area & vacancy handling', b: 'Common-area deductions and vacant-unit shares stay with the property so your recovery numbers stay honest.' },
      { t: 'Lease-term aware', b: 'Move-ins and move-outs prorate; a resident who left mid-period pays their share, not the next resident’s.' },
      { t: 'Recovery reporting', b: 'Billed vs. recovered by property and period — the number that tells you whether your utility program is working.' },
    ],
    mock: {
      kpis: [['$4,180', 'July water/sewer'], ['92%', 'Recovery rate'], ['3', 'Allocation methods'], ['0', 'Manual calcs']],
      feed: [
        ['RUBS', 'July water allocated across 38 occupied units · posted'],
        ['Utilities', 'trash bill captured · Cardinal Commons · $640'],
        ['Recovery', 'utility recovery report generated · 92% recouped'],
      ],
    },
    faq: [
      { q: 'Is RUBS legal in my area?', a: 'RUBS legality and disclosure requirements vary by state and city — confirm with local counsel and your lease language. StayLeased executes whatever method your leases lawfully specify, identically every month.' },
      { q: 'Can different properties use different methods?', a: 'Yes — allocation method, common-area deductions, and admin fees are configured per property.' },
      { q: 'What about submetered units?', a: 'Submetered charges can be entered per unit and post the same way; RUBS handles the properties (or meters) where true submetering isn’t practical.' },
    ],
    related: [
      { label: 'Rent collection', href: '/platform/rent-collection' },
      { label: 'Accounting', href: '/platform/accounting' },
      { label: 'Reports', href: '/platform/reports' },
    ],
  },
  {
    slug: 'resident-portal', group: 'platform', label: 'Resident portal',
    title: 'Your tenants get a portal. You get your evenings back.',
    sub: 'Rent paid online with autopay, repair requests with photos, documents residents find themselves — routine questions answered by the portal.',
    chip: { kind: 'soon', text: 'Portal, requests & ledgers live · card/ACH processing rail in rollout' },
    points: [
      'Tenants see their balance and pay online — with autopay and instant receipts',
      'Repair requests come in with photos and get answered immediately, day or night',
      'Lease documents, insurance status, and renewal offers — self-serve, not office-hours',
    ],
    stats: [
      { b: 'Fewer calls', s: '“What’s my balance?” and “any news on my sink?” answer themselves' },
      { b: 'Faster rent', s: 'Paying takes seconds on a phone, so it happens on time' },
      { b: 'Nothing to install', s: 'Fast mobile website — works on any phone, no app store' },
    ],
    features: [
      { t: 'Money, self-serve', b: 'Balance, what it’s made of, payment history with receipts, and autopay controls. Balance questions become a screen residents check themselves.' },
      { t: 'Repair requests that behave', b: 'A photo of the leak, access notes, and live status — received, scheduled with a window, done. The “is anyone coming?” call disappears from your phone.' },
      { t: 'Answers without a phone call', b: 'Rent amount, due dates, balance detail, lease terms and documents sit on the portal itself — residents look instead of calling. An in-portal AI assistant is on the roadmap; today the answers live one tap away on the relevant screen.' },
      { t: 'Documents on demand', b: 'The signed lease, addenda, notices, and renewal offers, downloadable anytime. No more digging through email to resend a lease.' },
      { t: 'Insurance & deposit alternative', b: 'Tenants upload proof of coverage or enroll in your programs; compliance status stays visible on both sides instead of surprising anyone.' },
      { t: 'Everything lands in your system', b: 'Every payment, request, and message threads into the same records and books you run on — no separate tenant app to check.' },
    ],
    mock: {
      kpis: [['$0', 'Balance due'], ['Autopay', 'On · Aug 1'], ['1', 'Open request'], ['✓', 'Insurance current']],
      feed: [
        ['Portal', 'rent paid online · receipt issued instantly'],
        ['Requests', 'leak under sink + photo · tech scheduled Tue 9–11'],
        ['Documents', 'renewal offer viewed · expires in 14 days'],
      ],
    },
    faq: [
      { q: 'How do my current tenants get access?', a: 'You issue portal credentials from each resident’s record today (a self-serve invite-link flow is next on the roadmap). New tenants get access as part of move-in.' },
      { q: 'When can tenants pay by card or bank transfer through the portal?', a: 'The card/ACH processing rail is rolling out to early-access partners — waitlist on Setup → Connections. The portal, ledgers, receipts, and autopay scheduling are live now, so switching the money rail on later is a flip, not a migration.' },
      { q: 'Do tenants have to use it?', a: 'No — you can keep taking payments and requests however you do now and record them. But most tenants prefer paying from their phone at 9pm to writing a check, which is exactly why rent shows up faster.' },
    ],
    related: [
      { label: 'Rent collection', href: '/platform/rent-collection' },
      { label: 'Maintenance & turns', href: '/platform/maintenance' },
      { label: 'New to AI? Start here', href: '/agents/new-to-ai' },
    ],
  },

  // ---------------- AI agents ----------------
  {
    slug: 'new-to-ai', group: 'agents', label: 'New to AI? Start here',
    title: 'Never used AI before? Good. This was built for you.',
    sub: 'No prompts to write, nothing to learn, and nothing sent without your say-so. It reads what comes in, drafts what should go out, and puts every draft in a queue for you to approve — that’s the whole idea.',
    points: [
      'Nothing is sent to a tenant or prospect until you approve it — that’s the default',
      'You read every word it writes, and you can edit before approving',
      'One off switch stops all of it instantly, any time',
    ],
    stats: [
      { b: 'It drafts, you decide', s: 'Think “assistant who prepares everything,” not “autopilot”' },
      { b: 'Plain English only', s: 'If you can read email and click Approve, you know how to use it' },
      { b: 'Your data, not the internet', s: 'It answers from your rents, your units, your policies — nothing made up' },
    ],
    features: [
      { t: 'What it actually does', b: 'A lead emails at 9pm asking about a 2-bedroom: it drafts a reply with your real availability, price, and tour times. Rent is 5 days late: it drafts a polite reminder in your tone. A tenant reports a leak: it sorts urgent from routine and suggests the next step. That’s the work.' },
      { t: 'What it never does', b: 'It never invents a price or an answer (it only uses your live data), never threatens or pressures anyone (blocked in code, not by promises), never signs, spends, or changes terms, and never acts outside limits you set.' },
      { t: 'How you start', b: 'You don’t configure anything. Everything it writes lands in one queue as drafts. For the first couple of weeks you just read them and click Approve, Edit, or Reject — like reviewing a new employee’s emails.' },
      { t: 'When you’re ready for more', b: 'Once you notice you’ve stopped editing its drafts, you can let it send certain things on its own — most owners start with after-hours lead replies, because that’s money lost while you sleep. Each step up is your choice, per property, reversible.' },
      { t: 'If it’s ever wrong', b: 'You edit the draft or reject it — and everything it ever wrote or did sits in a permanent log you can review. You’re never wondering what it said to whom.' },
      { t: 'The off switch', b: 'One click stops every AI feature platform-wide. You’ll probably never use it. It’s there anyway, because trust needs an exit.' },
    ],
    mock: {
      kpis: [['3', 'Drafts waiting for you'], ['0', 'Sent without approval'], ['41s', 'Lead answered (draft)'], ['1', 'Off switch · always']],
      feed: [
        ['9:04pm', 'Zillow lead asks about the 2BR · reply drafted from real availability'],
        ['9:05pm', 'draft queued: “Hi Sam — yes, the 2BR at $1,450 is available…”'],
        ['You', 'read it over coffee, click Approve · sent'],
      ],
    },
    faq: [
      { q: 'I don’t want a robot talking to my tenants.', a: 'Then it won’t — that’s the default, not a setting you have to find. It drafts; you send. It only ever contacts anyone directly if you deliberately turn that on later, and you can turn it back off in one click.' },
      { q: 'Do I need to learn “prompting” or take a course?', a: 'No. There’s nothing to prompt. The AI reacts to real events — a lead, a late balance, a repair request — and shows you its work. Your only job is Approve / Edit / Reject, which you already know how to do.' },
      { q: 'How is this different from ChatGPT?', a: 'ChatGPT answers questions from the internet. This works inside your operation: it knows your actual units, prices, balances, and policies, acts only through drafts you approve, and logs everything. It’s an employee with rules, not a chat window.' },
      { q: 'What does it cost to try?', a: 'Early access is free. Book a live demo and watch the AI work on a fully populated portfolio before it touches yours — or explore the demo company self-guided first.' },
    ],
    related: [
      { label: 'Leasing AI', href: '/agents/leasing' },
      { label: 'Approvals & control', href: '/agents/governance' },
      { label: 'Self-managing owners', href: '/for/self-managing-owners' },
    ],
  },
  {
    slug: 'leasing', group: 'agents', label: 'Leasing AI',
    title: 'The leasing agent who never sleeps, never guesses, never skips follow-up.',
    sub: 'Answers every prospect in seconds from live availability and pricing, books tours into real slots, runs the follow-up cadence to the end — and escalates to you exactly when your dial says so.',
    points: [
      'Grounded in live availability, pricing, and policies — never invented',
      'Instant first touch on website and ILS email leads, in production today',
      'Deterministic fair-housing guardrail on every prospect-facing message',
    ],
    stats: [
      { b: 'Seconds, not hours', s: 'Every lead gets an immediate, professional reply' },
      { b: 'After-hours covered', s: '2am inquiries get 2am answers' },
      { b: 'You set the dial', s: 'Draft-for-approval to fully autonomous, per property' },
    ],
    features: [
      { t: 'Grounded answers only', b: 'Availability, pricing, pet policy, tour hours — pulled from your live operating records at answer time. If the information does not exist, the AI says so and escalates rather than improvising.' },
      { t: 'Tour booking', b: 'Offers real slots from the property’s tour calendar and books them, confirmation threaded to the guest card.' },
      { t: 'Follow-up cadence', b: 'No response? The cadence continues politely until answer or opt-out. The most profitable boring work in leasing, done every time.' },
      { t: 'Fair-housing guardrails', b: 'A deterministic screen (not a vibe) checks every outbound message, with approved neutral rewrites for risky territory. Compliance is enforced in code, then audited.' },
      { t: 'Autonomy dial', b: 'Start with every reply queued for your approval. When you’ve stopped editing them, dial up to auto-send after-hours, then fully autonomous — per property, reversible any time.' },
      { t: 'Every action audited', b: 'What it said, to whom, when, grounded in what — one reviewable trail. Trust built on receipts.' },
    ],
    mock: {
      kpis: [['41s', 'Avg first response'], ['100%', 'Leads touched'], ['7', 'Tours booked · 7d'], ['0', 'Guardrail violations']],
      feed: [
        ['Leasing AI', 'answered floorplan + pet policy question · Zillow lead'],
        ['Leasing AI', 'booked Sat 11:00 tour · confirmed to prospect'],
        ['Escalation', 'service-animal question routed to human · policy'],
      ],
    },
    faq: [
      { q: 'What if it doesn’t know the answer?', a: 'It escalates. The agent answers only from your live data and policies; questions outside that (or in sensitive territory like accommodations) route to a human with full context.' },
      { q: 'Will prospects know they’re talking to an AI?', a: 'That’s your call — disclosure language is your policy. Either way, the messages are grounded in real availability, respond in seconds, and read like your better emails.' },
      { q: 'How do I learn to trust it?', a: 'Run it on approve-everything mode and watch the queue. Operators typically dial up after-hours first — that’s where the money was leaking anyway.' },
    ],
    related: [
      { label: 'Leasing CRM', href: '/platform/leasing-crm' },
      { label: 'Property sites & listings', href: '/platform/property-sites' },
      { label: 'Approvals & control', href: '/agents/governance' },
    ],
  },
  {
    slug: 'maintenance', group: 'agents', label: 'Maintenance AI',
    title: 'Triage in seconds. Emergencies never wait for morning.',
    sub: 'Every request classified on arrival — category, priority, emergency detection — with safe troubleshooting for the resident and a dispatch proposal for you.',
    points: [
      'Emergency detection with immediate escalation, 24/7',
      'Troubleshooting scripts that fix simple issues before a truck rolls',
      'Dispatch proposals with vendor and window, inside your approval flow',
    ],
    stats: [
      { b: 'Instant classification', s: 'Category and priority the moment a request lands' },
      { b: 'Fewer wasted trips', s: 'Breaker checks and shut-off valves before service calls' },
      { b: 'Approval-first dispatch', s: 'Vendors roll when you say so — or automatically, if you dial it up' },
    ],
    features: [
      { t: 'Arrival triage', b: 'Requests classify on submission: plumbing vs. electrical vs. appliance, routine vs. urgent vs. emergency — consistently, at 2pm or 2am.' },
      { t: 'Emergency escalation', b: 'Water intrusion, gas, no-heat: flagged instantly, on-call contact notified, resident given safe immediate steps. The scenario insurance carriers ask about, handled.' },
      { t: 'Guided troubleshooting', b: 'Reset the breaker, check the disposal switch, close the valve — resolved-in-chat issues close without a dispatch, logged like any other outcome.' },
      { t: 'Dispatch proposals', b: 'For real issues, the agent proposes vendor, urgency, and window from your vendor list — you approve, or let it dispatch within bounds you’ve set.' },
      { t: 'Resident communication', b: 'Status updates, window confirmations, and follow-ups written for humans, threaded on the request.' },
      { t: 'Autonomy dial + audit', b: 'Same governance as every agent: per-property dial, approval queue, and a complete audit trail of every triage decision and message.' },
    ],
    mock: {
      kpis: [['100%', 'Requests triaged'], ['2', 'Emergencies caught · 7d'], ['31%', 'Resolved in chat'], ['14m', 'Emergency response']],
      feed: [
        ['Maintenance AI', 'water leak → emergency · on-call notified · Unit 204'],
        ['Maintenance AI', 'disposal issue resolved via reset · no dispatch'],
        ['Dispatch', 'HVAC vendor proposed · Thu window · awaiting approval'],
      ],
    },
    faq: [
      { q: 'What makes something an “emergency”?', a: 'Your policy defines the categories; the agent applies them. Standard set: active water intrusion, gas odor, no heat in winter, security-compromising failures — all escalate immediately regardless of hour.' },
      { q: 'Can it really fix things over chat?', a: 'A meaningful share of requests are switches, breakers, resets, and clogs. Guided steps close those on the spot — and everything attempted is logged on the work order either way.' },
      { q: 'Does it pick which vendor to send?', a: 'It proposes from your vendor list based on trade and availability. Whether proposals auto-dispatch or wait for approval is your dial setting.' },
    ],
    related: [
      { label: 'Maintenance & turns', href: '/platform/maintenance' },
      { label: 'Resident portal', href: '/platform/resident-portal' },
      { label: 'Approvals & control', href: '/agents/governance' },
    ],
  },
  {
    slug: 'payments', group: 'agents', label: 'Payments AI',
    title: 'Rent gets chased politely, consistently, and inside the law.',
    sub: 'Outreach on every balance with tone matched to amount and days late, payment plans inside your bounds, and hard-coded compliance rails — the collections work you hate, done the way you wish you did it.',
    points: [
      'Tone-matched reminders: friendly at day 2, firmer at day 15',
      'Payment plans proposed only inside limits you configure',
      'Banned-language rails: no threats, no legal bluffs, ever',
    ],
    stats: [
      { b: 'Every balance worked', s: 'Nothing slips because Thursday got busy' },
      { b: 'Consistent = defensible', s: 'Same policy, same process, every resident' },
      { b: 'Human escalation', s: 'Hardship stories route to you, not to a template' },
    ],
    features: [
      { t: 'Balance-aware outreach', b: 'A $40 utility remainder gets a friendly nudge; a month of rent at day 15 gets a firm, professional notice. Tone follows your matrix, not a mood.' },
      { t: 'Compliance hard rails', b: 'A deterministic banned-language screen blocks threats, legal posturing, and collection-practice violations before anything sends. This isn’t a prompt — it’s code.' },
      { t: 'Payment plans in bounds', b: 'Where you allow plans, the agent structures them inside your limits (duration, minimums) and monitors adherence, escalating misses.' },
      { t: 'Cadence by policy', b: 'Reminder day, late-fee day, notice day — outreach follows the schedule your policy defines, with the late-fee engine doing the math.' },
      { t: 'Knows when to hand off', b: 'Hardship, disputes, and anything approaching legal territory route to a human immediately, with the thread and ledger attached.' },
      { t: 'Queue, dial, audit', b: 'Drafts queue for approval until you dial up autonomy; every message and decision is audited with the balance context it acted on.' },
    ],
    mock: {
      kpis: [['11', 'Balances in outreach'], ['6', 'Drafts awaiting OK'], ['1', 'Plan monitored'], ['0', 'Compliance flags']],
      feed: [
        ['Payments AI', 'friendly reminder drafted · $180 · 3 days late'],
        ['Payments AI', 'plan proposed: 2 installments · inside bounds'],
        ['Escalation', 'hardship mention detected → routed to manager'],
      ],
    },
    faq: [
      { q: 'Will this ever threaten eviction?', a: 'No. Eviction, attorneys, credit bureaus, and similar language are on a hard banned list enforced in code. Escalation to legal process is a human decision that happens outside the agent.' },
      { q: 'Do reminders actually send to residents?', a: 'Messages compose, thread, and queue in the comms center today; the outbound SMS/email delivery rail is in rollout. When delivery reaches your account, the same approved messages go out externally — until then they are staged, visible to your team, and nothing reaches a resident unreviewed.' },
      { q: 'Can I review everything before it sends?', a: 'Yes — that’s the default. Approve, edit, or reject from the queue; dial up autonomy only when the edits stop.' },
    ],
    related: [
      { label: 'Rent collection', href: '/platform/rent-collection' },
      { label: 'Resident portal', href: '/platform/resident-portal' },
      { label: 'Approvals & control', href: '/agents/governance' },
    ],
  },
  {
    slug: 'renewals', group: 'agents', label: 'Renewals AI',
    title: 'Offers that read like you know them. Because it does.',
    sub: 'Renewal offers personalized from actual resident history — tenure, payment record, maintenance experience — priced inside your bounds, with counters evaluated against your matrix and escalations when they’re not.',
    points: [
      'Personalization from real history, not mail-merge fields',
      'Pricing locked inside org- and property-level bounds',
      'Counters accepted, countered, or escalated — per your matrix',
    ],
    stats: [
      { b: 'Renewals are the margin', s: 'A saved renewal beats a turn + vacancy, every time' },
      { b: 'On-time offers', s: 'Generated ahead of expiration, never forgotten' },
      { b: 'Negotiation with rails', s: 'The matrix decides; the AI just executes it' },
    ],
    features: [
      { t: 'History-aware offers', b: 'Four years, on-time payments, two maintenance requests both rated 5 stars — the offer acknowledges the resident’s actual record, which is why it converts.' },
      { t: 'Bounded pricing', b: 'Increases inside your caps, floors respected, term options you allow. The agent literally cannot offer outside the box you configure.' },
      { t: 'Counter evaluation', b: 'Resident counters are checked against your matrix: acceptable → accept (at your dial), close → counter, outside → escalate with the numbers laid out.' },
      { t: 'Timing on your calendar', b: 'Offers go out at the window you set before expiration, with reminders for non-responses — the pipeline stays visible the whole way.' },
      { t: 'Straight to lease', b: 'Accepted offers flow into renewal lease generation and e-signature without re-keying.' },
      { t: 'Approval queue + audit', b: 'Offers and counter-decisions queue for approval until you dial up; every number and message is audited.' },
    ],
    mock: {
      kpis: [['12', 'Offers out'], ['67%', 'Acceptance rate'], ['2', 'Counters in matrix'], ['1', 'Escalated to you']],
      feed: [
        ['Renewals AI', 'offer drafted · 4-yr resident · +$60 within bounds'],
        ['Counter', '$25 below offer · matrix says accept · accepted'],
        ['Escalation', 'counter 9% below floor → escalated with context'],
      ],
    },
    faq: [
      { q: 'Can it lower rent to keep someone?', a: 'Only inside bounds you set. If your matrix allows a retention concession for a resident profile, the agent can use it; anything below your floor escalates to you.' },
      { q: 'What actually gets personalized?', a: 'Tenure, payment history, maintenance experience, and lease context — drawn from your own records. Not demographics; conduct. Fair-housing rails apply to renewal messaging like everything else.' },
      { q: 'What if the resident just ignores the offer?', a: 'Polite reminders on cadence, expiration-risk surfaced in the pipeline, and a flag to you as the date approaches — silence gets managed instead of discovered.' },
    ],
    related: [
      { label: 'Renewals & pricing', href: '/platform/renewals-pricing' },
      { label: 'Leases & e-sign', href: '/platform/leases-esign' },
      { label: 'Approvals & control', href: '/agents/governance' },
    ],
  },
  {
    slug: 'call-analysis', group: 'agents', label: 'Call analysis',
    title: 'Every call becomes a summary, a sentiment, and a next step.',
    sub: 'Recorded calls turn into structured intelligence — what was discussed, how it went, what was promised — attached to the lead or resident it belongs to, with coaching notes your team can actually use.',
    points: [
      'Summaries and extracted intents on every recorded call',
      'Sentiment and escalation-risk flags you can scan in seconds',
      'Coaching notes that turn average calls into better ones',
    ],
    stats: [
      { b: 'No more “what did they say?”', s: 'The call is on the record it belongs to' },
      { b: 'Promises tracked', s: 'Commitments made on calls become follow-ups' },
      { b: 'Quality visible', s: 'Patterns across calls surface before reviews do' },
    ],
    features: [
      { t: 'Structured summaries', b: 'Who called about what, what was answered, what was promised — a paragraph instead of a 9-minute recording.' },
      { t: 'Intent extraction', b: 'Tour request, price objection, maintenance complaint, renewal question — intents extracted and routed to the right pipeline.' },
      { t: 'Sentiment & risk', b: 'Frustrated resident on a third callback? Flagged. Delighted prospect ready to apply? Also flagged. Attention goes where it matters.' },
      { t: 'Coaching notes', b: 'What the call did well and what it missed — specific, private, and consistent, which is more than most small teams ever get.' },
      { t: 'On the record', b: 'Analyses attach to the lead, resident, or work order the call concerned, so context survives the phone call ending.' },
      { t: 'Audited like everything', b: 'Analyses are agent actions: logged, reviewable, and governed by the same framework as every other AI output.' },
    ],
    mock: {
      kpis: [['23', 'Calls analyzed · 7d'], ['4', 'Escalation flags'], ['9', 'Intents routed'], ['100%', 'On-record']],
      feed: [
        ['Call analysis', 'tour intent detected → slot offered on the card'],
        ['Sentiment', 'repeat-caller frustration flagged · manager notified'],
        ['Coaching', 'note: quote the special earlier in pricing calls'],
      ],
    },
    faq: [
      { q: 'Where do the call transcripts come from?', a: 'Paste a transcript (or a detailed recap) when logging a call in the comms center — analysis runs on it automatically. Direct phone-system integrations that capture transcripts for you are on the connections waitlist.' },
      { q: 'Is this legal to do?', a: 'Call recording consent laws vary by state (one-party vs. all-party). Recording policy and disclosures are your responsibility; the analysis layer only works with what you lawfully record.' },
      { q: 'Can my staff see their own coaching notes?', a: 'That’s a permissions choice — many operators share notes 1:1. The point is consistent, specific feedback, not surveillance theater.' },
    ],
    related: [
      { label: 'Leasing CRM', href: '/platform/leasing-crm' },
      { label: 'Ask StayLeased', href: '/agents/ask-stayleased' },
      { label: 'Approvals & control', href: '/agents/governance' },
    ],
  },
  {
    slug: 'ask-stayleased', group: 'agents', label: 'Ask StayLeased',
    title: 'Ask your portfolio a question. Get an answer, not a report request.',
    sub: '“How’s collections this month?” “Who’s at risk of non-renewal?” Ask in plain English and get answers grounded in your live occupancy, ledgers, work orders, and leases — always within your permissions.',
    points: [
      'Answers computed from your live operating data at ask time',
      'Governed access — the AI sees only what your role can see',
      'Powered by Claude when live; honest about being in demo mode when not',
    ],
    stats: [
      { b: 'Zero report-hunting', s: 'The quick questions stop deserving a report at all' },
      { b: 'Grounded, not guessed', s: 'Numbers come from queries, not from the model’s imagination' },
      { b: 'Multi-turn', s: 'Follow-ups keep context like a real conversation' },
    ],
    features: [
      { t: 'Plain-English operations questions', b: 'Occupancy, collections, delinquency, expirations, maintenance load, leasing funnel — asked the way you’d ask a colleague, answered with the current numbers.' },
      { t: 'Governed data access', b: 'The assistant reads through the same permission system as every screen. It sees nothing your role could not already see, and never another company’s records.' },
      { t: 'Shows its arithmetic', b: 'Answers cite the figures they’re built from, so “94.2% occupancy” comes with where that number lives.' },
      { t: 'Conversation memory', b: '“And how does that compare to June?” works — context carries across the exchange.' },
      { t: 'Live or honest', b: 'With an Anthropic key configured, answers run on Claude and say so. Without one, the demo brain answers and says that instead. No pretending.' },
      { t: 'On the audit trail', b: 'Questions and answers are logged like any agent action — reviewable, attributable, governable.' },
    ],
    mock: {
      kpis: [['94.2%', 'Occupancy'], ['96.8%', 'Collected · July'], ['2', 'Urgent work orders'], ['3', 'Non-renewal risks']],
      feed: [
        ['You', '“Who’s at risk of non-renewal?”'],
        ['Ask', '3 leases: late twice + open request · list attached'],
        ['You', '“Draft a check-in note for the first one.”'],
      ],
    },
    faq: [
      { q: 'Can it change anything in my data?', a: 'No — Ask StayLeased is read-only. Agents that take actions (leasing replies, reminders) run separately, with approval queues and per-property controls.' },
      { q: 'What powers it?', a: 'Anthropic’s Claude when a key is configured (the live site runs live). The grounding pipeline — your data in, cited answer out — is the same either way, and the UI always tells you which brain answered.' },
      { q: 'Can my leasing agent ask about another property?', a: 'Only within their permissions. The assistant inherits role-based access — it’s a faster way to see what you’re allowed to see, not a side door.' },
    ],
    related: [
      { label: 'Reports', href: '/platform/reports' },
      { label: 'Approvals & control', href: '/agents/governance' },
      { label: 'Leasing AI', href: '/agents/leasing' },
    ],
  },
  {
    slug: 'governance', group: 'agents', label: 'Approvals & control',
    title: 'Autonomy is earned, dialed, and audited — never assumed.',
    sub: 'Every agent runs inside the same framework: per-agent, per-property autonomy dials, human approval queues, deterministic compliance rails, a global kill switch, and an audit trail under every single action.',
    points: [
      'Approval-first by default — the AI proposes, you dispose',
      'Dials per agent and per property, changeable any time',
      'One kill switch stops every agent platform-wide, instantly',
    ],
    stats: [
      { b: 'Trust with receipts', s: 'Every AI action logged with its grounding and outcome' },
      { b: 'Compliance in code', s: 'Fair-housing and banned-language rails are deterministic' },
      { b: 'Reversible always', s: 'Dial down or kill-switch without breaking the operation' },
    ],
    features: [
      { t: 'The autonomy dial', b: 'Off → draft-for-approval → auto within bounds → autonomous, set per agent per property. Most operators start everything on approve and dial up what they’ve stopped editing.' },
      { t: 'Approval queues', b: 'Proposed messages and actions land in one queue with full context. Approve, edit, or reject — each choice teaching you where the dial belongs.' },
      { t: 'Deterministic guardrails', b: 'Fair-housing screening and banned collection language are enforced by code that runs on every message — not by hoping a prompt holds.' },
      { t: 'Bounds & policies', b: 'Pricing floors, plan limits, concession caps, escalation lists — agents operate inside the same org- and property-level policy system as your staff.' },
      { t: 'Global kill switch', b: 'One setting stops all agent activity platform-wide immediately. You’ll probably never use it; you’ll always know it’s there.' },
      { t: 'The audit trail', b: 'Human and AI actions in one reviewable log: who/what acted, on which record, grounded in what data, approved by whom. The license to operate, in table form.' },
    ],
    mock: {
      kpis: [['4', 'Agents governed'], ['3', 'Autonomy profiles'], ['100%', 'Actions audited'], ['1', 'Kill switch · armed']],
      feed: [
        ['Governance', 'Leasing AI dialed to auto after-hours · Summit Ridge'],
        ['Queue', '6 proposals awaiting review · oldest 22m'],
        ['Audit', 'guardrail rewrite logged · original + sent version stored'],
      ],
    },
    faq: [
      { q: 'What’s the recommended starting posture?', a: 'Everything on draft-for-approval. Watch the queue for two weeks; whatever you approve without edits is a candidate for dialing up — after-hours leasing first, because that’s where money leaks.' },
      { q: 'What can agents never do?', a: 'Cross your configured bounds (pricing floors, plan limits), use banned language (threats, legal posturing), bypass fair-housing screening, or act with the kill switch on. These are code-level constraints, not instructions.' },
      { q: 'Who can change the dials?', a: 'Role-based permissions govern dial changes, and every change is itself an audited action — so “who turned this up?” always has an answer.' },
    ],
    related: [
      { label: 'Leasing AI', href: '/agents/leasing' },
      { label: 'Payments AI', href: '/agents/payments' },
      { label: 'Reports', href: '/platform/reports' },
    ],
  },

  // ---------------- Who it's for ----------------
  {
    slug: 'self-managing-owners', group: 'for', label: 'Self-managing owners',
    title: 'Your portfolio, professionally run — around the clock.',
    sub: 'StayLeased gives your properties a full-time operating staff: leasing, rent collection, maintenance coordination, and real books — with you making every decision that matters.',
    points: [
      'Leads answered in seconds from live availability, day and night',
      'Rent collected on schedule; books that keep themselves',
      'Requests triaged on arrival, with true emergencies escalated instantly',
    ],
    stats: [
      { b: 'Around-the-clock coverage', s: 'Leasing, reminders, and triage never close' },
      { b: 'One login', s: 'CRM, leases, money, maintenance, and books together' },
      { b: 'Import in an afternoon', s: 'Your rent roll builds the system for you' },
    ],
    features: [
      { t: 'Every lead answered in seconds', b: 'The Leasing AI replies with real availability and books tours into the windows you set — every prospect gets an immediate, professional response.' },
      { t: 'Rent collection, handled professionally', b: 'Billing runs on schedule, late fees follow your policy, and every reminder goes out in a tone you approved.' },
      { t: 'Maintenance as a decision, not a project', b: 'Requests come with photos, get triaged instantly, and reach you as a one-tap decision — "approve plumber Thursday?"' },
      { t: 'Books that are always current', b: 'Every rent payment and repair bill posts double-entry automatically. Tax season becomes an export.' },
      { t: 'Start from the spreadsheet you have', b: 'Upload your rent roll — the system maps it, you review, and the portfolio builds itself: properties, units, leases, balances.' },
      { t: 'You approve; it executes', b: 'Every agent starts in draft-for-approval mode — a tireless assistant that drafts everything and sends nothing without you.' },
    ],
    mock: {
      kpis: [['2am', 'Lead answered'], ['$0', 'Missed follow-ups'], ['15m', 'Your weekly books time'], ['1', 'Decision waiting']],
      feed: [
        ['Overnight', 'lead answered, tour booked, reminder drafted'],
        ['Morning', 'you: approve 2 drafts, one vendor dispatch · done'],
        ['Books', 'everything above already posted itself'],
      ],
    },
    faq: [
      { q: 'Does this make sense for a dozen units?', a: 'Yes — a dozen units is exactly who this is priced and shaped for. Full coverage from day one, free during early access.' },
      { q: 'How long does setup actually take?', a: 'One afternoon is the honest answer for a rent-roll import: upload, review what the AI mapped, accept. You operate the same day.' },
      { q: 'How much control do I keep over what the AI sends?', a: 'Complete control. Everything starts as drafts for your approval, and most owners grant after-hours leasing within a couple of weeks — because the drafts were what they would have written.' },
    ],
    related: [
      { label: 'Switching from spreadsheets', href: '/for/switching-from-spreadsheets' },
      { label: 'Leasing AI', href: '/agents/leasing' },
      { label: 'Rent collection', href: '/platform/rent-collection' },
    ],
  },
  {
    slug: 'small-management-companies', group: 'for', label: 'Small management companies',
    title: 'Hundreds of doors on a two-person office. Comfortably.',
    sub: 'One system for every property, owner-ready financials by default, roles for every hat your team wears — and agents doing the follow-up your people never have time for.',
    points: [
      'Every property, one login — with per-property policies where needed',
      'Financial statements and reports, generated not assembled',
      'Roles and permissions for staff, accountants, and vendors',
    ],
    stats: [
      { b: 'Doors per person, up', s: 'Agents absorb the follow-up load that eats staff hours' },
      { b: 'Owner trust, up', s: 'Financial packages that arrive on schedule, tied to real books' },
      { b: 'Tool sprawl, gone', s: 'Leasing, operations, accounting, and messaging in one system' },
    ],
    features: [
      { t: 'Portfolio-wide operations', b: 'A dashboard across every property — occupancy, delinquency, leasing funnel, maintenance load — with drill-down to any unit in two clicks.' },
      { t: 'Per-property policies', b: 'Different owners, different rules: late fees, screening criteria, tour hours, and autonomy dials set per property, inherited from org defaults.' },
      { t: 'The follow-up your team skips', b: 'Lead cadences, balance reminders, renewal offers — the work that always loses to the urgent thing now runs itself under your approval flow.' },
      { t: 'Accounting your owners can audit', b: 'Property-dimensioned double-entry books, bank rec, AP with approvals, and owner-ready packages on schedule. Owner questions get answers with line items.' },
      { t: 'Roles for the real org chart', b: 'Leasing agents see leasing, accountants see the GL, vendors see their work orders. Permission-scoped, org-isolated, fully audited.' },
      { t: 'Onboard a new owner in a day', b: 'A new management contract is a rent-roll import away from live: properties, units, leases, and opening balances without a data-entry week.' },
    ],
    mock: {
      kpis: [['340', 'Doors managed'], ['2.5', 'Office staff'], ['9', 'Owner packages sent'], ['61', 'AI actions this week']],
      feed: [
        ['Leasing AI', '14 leads worked across 6 properties overnight'],
        ['Owners', 'monthly packages generated · scheduled delivery'],
        ['Ops', 'new owner’s 28-unit building imported · live same day'],
      ],
    },
    faq: [
      { q: 'Can different staff have different access?', a: 'Yes — role-based permissions with property-level scoping: a leasing agent for two buildings sees those two buildings’ leasing world, your accountant sees financials, vendors see assigned work orders.' },
      { q: 'How do owner reports work?', a: 'Owner-ready financial packages generate per property on your schedule from the live books. A read-only owner login is on the roadmap; scheduled packages are how operators run it today.' },
      { q: 'Can we manage properties for multiple owners in one account?', a: 'Yes. Each property carries its own books, policies, and reporting, so one login runs every owner’s portfolio while statements and financial packages stay cleanly separated per property.' },
    ],
    related: [
      { label: 'Switching from Buildium / AppFolio', href: '/for/switching-from-buildium-appfolio' },
      { label: 'Accounting', href: '/platform/accounting' },
      { label: 'Approvals & control', href: '/agents/governance' },
    ],
  },
  {
    slug: 'growing-portfolios', group: 'for', label: 'Growing portfolios',
    title: 'Add buildings without adding headcount.',
    sub: 'Institutional-grade books, real reporting, and per-property governance — the back office that usually forces the first ops hire, already built in.',
    points: [
      'Dual-basis accounting, bank rec, budgets, and period close',
      'Portfolio dashboards with per-property drill-down',
      'Policies and autonomy dials that scale property by property',
    ],
    stats: [
      { b: 'Scale the system, not staff', s: 'The next 50 doors ride the same rails as the first 50' },
      { b: 'Lender-ready books', s: 'Real financial statements when refinancing asks' },
      { b: 'One portfolio view', s: 'Every property on one dashboard, one map, one set of controls' },
    ],
    features: [
      { t: 'Accounting that survives diligence', b: 'Double-entry, dual-basis books with bank reconciliation and period locks — what lenders, partners, and buyers expect to see when you grow.' },
      { t: 'Budget vs. actual, per property', b: 'Budgets by property with variance reporting, so each building answers for itself and surprises surface in the month they happen.' },
      { t: 'Acquisition-day onboarding', b: 'New building closes Friday; rent roll imports Friday afternoon. Opening balances, billing start dates, and leases land clean without a parallel-run month.' },
      { t: 'Governance that scales', b: 'Org defaults with per-property overrides mean the 40-unit building and the 120-unit building each run appropriate policies — and dials — without duplicating setup.' },
      { t: 'Reporting across the stack', b: 'The 50-report catalog, custom builder, and dashboards work portfolio-wide and per-property, scheduled to the people who need them.' },
    ],
    mock: {
      kpis: [['3 → 9', 'Properties · 2yr'], ['0', 'Back-office hires'], ['Jun', 'Closed on the 6th'], ['12', 'Scheduled reports']],
      feed: [
        ['Acquisition', '28-unit close → imported → billing live · one day'],
        ['Close', 'June locked · owner + lender packages out'],
        ['Budgets', 'Cardinal Commons R&M variance flagged · -8%'],
      ],
    },
    faq: [
      { q: 'At what size do I outgrow StayLeased?', a: 'The platform runs portfolios well past 500 units (multi-property, role-scoped, vertically aware). The honest ceiling today is enterprise-integration depth — if you need institutional payment/bank rails on day one, check the connections page against your requirements.' },
      { q: 'Can I keep my property-level LLC structure?', a: 'Properties carry their own books dimensionally, and portfolios organize by property. Complex multi-entity consolidation is CPA territory — the per-property statements give them exactly what they need.' },
      { q: 'How disruptive is moving 300 units in?', a: 'Import runs property by property — most operators migrate a building at a time over a week or two. Conversion accounting (opening balances + billing start dates) means no double-billed month, ever.' },
    ],
    related: [
      { label: 'Accounting', href: '/platform/accounting' },
      { label: 'Reports', href: '/platform/reports' },
      { label: 'Small management companies', href: '/for/small-management-companies' },
    ],
  },
  {
    slug: 'switching-from-buildium-appfolio', group: 'for', label: 'Switching from Buildium / AppFolio',
    title: 'Your rent roll imports in one afternoon. Seriously.',
    sub: 'Export from Buildium, AppFolio, Yardi, RentManager, or TenantCloud — the Migration Center recognizes the format, maps it automatically, shows you everything for review, and builds your portfolio from one file.',
    points: [
      'Preset detection for the big five’s export formats',
      'One rent-roll file creates properties, units, leases, and residents',
      'Opening balances + billing start dates — no double-billed month',
    ],
    stats: [
      { b: 'No implementation team', s: 'Because there’s no implementation — there’s an import' },
      { b: 'Review before commit', s: 'Every mapped row is human-approved before it lands' },
      { b: 'Keep your history', s: 'Balances convert cleanly; your old exports stay yours' },
    ],
    features: [
      { t: 'Export-shaped import', b: 'The Migration Center detects Buildium/AppFolio/Yardi/RentManager/TenantCloud export shapes and applies the right mapping preset — you’re not massaging columns in Excel first.' },
      { t: 'AI reading with human review', b: 'The AI reads the whole sheet and proposes the mapping; automated checks verify everything; you review and approve before a single record is created. The AI never writes directly to your records.' },
      { t: 'One file → whole portfolio', b: 'A rent roll builds properties, buildings, units, floorplans, leases, residents, and balances in one transactional apply.' },
      { t: 'Conversion accounting done right', b: 'Prior balances arrive as opening balances (not fake history), deposits land on both bases correctly, and each lease’s billing start date guarantees no month gets billed twice.' },
      { t: 'Vendors, balances, and lease PDFs too', b: 'Separate lanes import vendor lists and outstanding balances — and lease-PDF extraction reads document stacks when the spreadsheet is thin.' },
      { t: 'Instantly operational', b: 'The moment the apply commits, billing, portals, agents, and reports work. Same-day switchover is normal, not heroic.' },
    ],
    mock: {
      kpis: [['1', 'File uploaded'], ['187', 'Units created'], ['163', 'Leases live'], ['1', 'Afternoon']],
      feed: [
        ['Import', 'AppFolio rent-roll format detected · preset applied'],
        ['Review', '2 rows flagged for review · fixed inline · applied'],
        ['Live', 'August billing generated · portals ready · agents on'],
      ],
    },
    faq: [
      { q: 'What do I actually need to export?', a: 'The rent roll gets you operational. Add vendor lists and outstanding balances when you have them, and lease PDFs if you want documents attached. The “what to have ready” guide on the import hub lists all five inputs and what each unlocks.' },
      { q: 'What happens to my accounting history?', a: 'Cutover-date balances come in as proper opening balances; deep transaction history stays in your old system’s exports (keep them). Your books here are clean from day one — which is what your CPA actually wants.' },
      { q: 'What if my export has weird data?', a: 'Validation catches inconsistencies and shows them in the review screen before anything applies — fix inline or in the file. Nothing writes until you approve, and the apply is transactional: all or nothing.' },
    ],
    related: [
      { label: 'Switching from spreadsheets', href: '/for/switching-from-spreadsheets' },
      { label: 'Accounting', href: '/platform/accounting' },
      { label: 'Rent collection', href: '/platform/rent-collection' },
    ],
  },
  {
    slug: 'switching-from-spreadsheets', group: 'for', label: 'Switching from spreadsheets',
    title: 'Keep the spreadsheet. Upload it. We build the rest.',
    sub: 'Your rent-tracking sheet — whatever its columns, whatever its quirks — is enough. AI reads it, maps it with synonym matching, shows you the review screen, and turns it into a running operation.',
    points: [
      'Any reasonable sheet works: yours, not a template we make you fill',
      'Synonym auto-mapping (“tenant”, “renter”, “name” → resident) with review',
      'From upload to collecting rent in an afternoon',
    ],
    stats: [
      { b: 'No re-typing', s: 'The sheet you’ve maintained for years is the source' },
      { b: 'Nothing lost', s: 'Every row lands reviewed, validated, and traceable' },
      { b: 'Everything gained', s: 'Portals, agents, books, and reports on top of your data' },
    ],
    features: [
      { t: 'Bring the sheet you have', b: 'Column names don’t matter — “Tenant/Renter/Occupant”, “Rent/Monthly/Amount” — synonym mapping plus AI reading figure out your format and show you the interpretation for approval.' },
      { t: 'Whole-grid AI reading', b: 'The AI reads the entire sheet, handles merged headers and notes columns, and proposes structured data. Automated checks and your review stand between the AI and your records, always.' },
      { t: 'From rows to an operation', b: 'Approved rows become properties, units, residents, leases, and balances — then billing runs, portals open, and agents start working the same day.' },
      { t: 'Balances that reconcile', b: 'Who-owes-what from the sheet becomes opening balances on real ledgers, so collections start from truth instead of memory.' },
      { t: 'Your data stays yours', b: 'Everything exports back out clean at any time. The moat is being useful, not holding your data hostage.' },
      { t: 'Grow into the rest', b: 'Start with rent tracking; adopt leasing, maintenance, and accounting at your pace. The modules are there when the pain arrives.' },
    ],
    mock: {
      kpis: [['1', 'Sheet uploaded'], ['46', 'Units recognized'], ['44', 'Leases created'], ['2', 'Rows fixed in review']],
      feed: [
        ['Reading', 'headers mapped: “Renter” → resident · “Mo. Rent” → rent'],
        ['Review', 'two date formats normalized · approved'],
        ['Live', 'ledgers opened with balances · reminders drafted'],
      ],
    },
    faq: [
      { q: 'My spreadsheet is honestly a mess. Will this work?', a: 'Messy is the normal case and the review screen is built for it: the AI’s interpretation is shown next to your original, low-confidence cells are flagged, and you correct inline before anything applies.' },
      { q: 'What’s the minimum information I need?', a: 'Per unit: an identifier, the resident (if occupied), the rent, and ideally lease dates and balance. From that the system builds a working operation; everything else is enrichment you can add later.' },
      { q: 'Why not just keep using the spreadsheet?', a: 'The sheet records what happened; it doesn’t answer leads, chase balances, triage maintenance, or keep books. You’re not buying a nicer spreadsheet — you’re hiring the work.' },
    ],
    related: [
      { label: 'Self-managing owners', href: '/for/self-managing-owners' },
      { label: 'Switching from Buildium / AppFolio', href: '/for/switching-from-buildium-appfolio' },
      { label: 'Ask StayLeased', href: '/agents/ask-stayleased' },
    ],
  },
];

// ---------------------------------------------------------------------------
// rendering

function ctaRow(large = false): Raw {
  const signupOpen = mkSignupOpen();
  const lg = large ? ' mk-btn-lg' : '';
  return html`<div class="mk-cta-row">
    <a class="mk-btn mk-btn-solid${lg}" href="/#walkthrough">Book a live demo</a>
    ${signupOpen
      ? html`<a class="mk-btn mk-btn-line${lg}" href="/signup">Create your company</a>`
      : html`<a class="mk-btn mk-btn-line${lg}" href="/login">Explore the live demo</a>`}
  </div>`;
}

function pageMock(p: MkPage): Raw {
  return html`<div class="mk-hero-visual" aria-hidden="true">
    <div class="mk-frame">
      <div class="mk-frame-bar"><span></span><span></span><span></span></div>
      <div class="mk-frame-kpis">${p.mock.kpis.map(([b, i]) => html`<div><b>${b}</b><i>${i}</i></div>`)}</div>
      <div class="mk-frame-feed">${p.mock.feed.map(([em, t]) => html`<div><em>${em}</em> ${t}</div>`)}</div>
    </div>
  </div>`;
}

export function featurePage(p: MkPage): Res {
  const g = MK_GROUPS[p.group];
  const o = siteOrigin();
  const path = `${g.base}/${p.slug}`;
  // BreadcrumbList mirrors the visible trail; FAQPage lifts the page's own
  // Q&A — no content exists in schema that isn't rendered on the page.
  const crumbLd = ldJson({
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${o}/` },
      { '@type': 'ListItem', position: 2, name: g.name, item: `${o}${g.base}` },
      { '@type': 'ListItem', position: 3, name: p.label, item: `${o}${path}` },
    ],
  });
  const faqLd = ldJson({
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: p.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  });
  const body = html`
${mkHeader()}
<section class="mkp-hero">
  <div class="mk-wrap mkp-hero-in">
    <div>
      <nav class="mkp-crumb" aria-label="Breadcrumb"><a href="/">Home</a><span class="sep" aria-hidden="true">/</span><a href="${g.base}">${g.name}</a><span class="sep" aria-hidden="true">/</span><span aria-current="page">${p.label}</span></nav>
      <h1>${p.title}</h1>
      <p class="mkp-sub">${p.sub}</p>
      ${when(p.chip, () => html`<div class="mkp-chip ${p.chip!.kind}">${p.chip!.text}</div>`)}
      <ul class="mkp-points">${p.points.map((pt) => html`<li>${pt}</li>`)}</ul>
      ${ctaRow()}
    </div>
    ${pageMock(p)}
  </div>
</section>

<section class="mk-band">
  <div class="mk-wrap mk-reveal">
    <div class="mkp-stats">${p.stats.map((s) => html`<div class="mkp-stat"><b>${s.b}</b><span>${s.s}</span></div>`)}</div>
  </div>
</section>

<section class="mk-band mk-band-alt">
  <div class="mk-wrap mk-reveal">
    <h2 class="mk-h2">What you get</h2>
    <p class="mk-lead">Every claim below is a working screen in the product — open the demo and check.</p>
    <div class="mk-grid3">
      ${p.features.map((f) => html`<div class="mk-card"><h3>${f.t}</h3><p>${f.b}</p></div>`)}
    </div>
  </div>
</section>

<section class="mk-band">
  <div class="mk-wrap mk-reveal">
    <h2 class="mk-h2">Common questions from operators</h2>
    <div class="mkp-faq" style="margin-top:26px">
      ${p.faq.map((f, i) => html`<details ${i === 0 ? 'open' : ''}><summary>${f.q}</summary><div class="mkp-a">${f.a}</div></details>`)}
    </div>
  </div>
</section>

<section class="mk-band mk-band-alt">
  <div class="mk-wrap mk-reveal">
    <h2 class="mk-h2" style="font-size:22px">Works together with</h2>
    <div class="mkp-related" style="margin-top:18px">
      ${p.related.map((r) => html`<a href="${r.href}">${r.label} <span aria-hidden="true">→</span></a>`)}
    </div>
  </div>
</section>

<section class="mkp-cta">
  <div class="mk-wrap">
    <h2>See it working in a live demo.</h2>
    <p>A fully seeded company — every screen live, every agent mid-flight. Book a call for the guided tour, or <a href="/login">explore it self-guided</a>.</p>
    ${ctaRow(true)}
  </div>
</section>
${mkFooter()}
${crumbLd}${faqLd}`;
  return mkDoc(`${p.label} — StayLeased`, p.sub, body, path);
}

export function hubPage(group: MkPage['group']): Res {
  const g = MK_GROUPS[group];
  const pages = MK_PAGES.filter((p) => p.group === group);
  const o = siteOrigin();
  const crumbLd = ldJson({
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${o}/` },
      { '@type': 'ListItem', position: 2, name: g.name, item: `${o}${g.base}` },
    ],
  });
  const body = html`
${mkHeader()}
<section class="mk-band mkp-hub-lead" style="padding-bottom:56px">
  <div class="mk-wrap">
    <nav class="mkp-crumb" aria-label="Breadcrumb"><a href="/">Home</a><span class="sep" aria-hidden="true">/</span><span aria-current="page">${g.name}</span></nav>
    <div class="mk-kicker">${g.kicker}</div>
    <h1 class="mk-h2" style="font-size:clamp(30px,3.8vw,46px)">${g.name}</h1>
    <p class="mk-lead">${g.lead}</p>
    <div class="mk-grid3">
      ${pages.map((p) => html`<a class="mk-card" href="${g.base}/${p.slug}"><h3>${p.label}</h3><p>${p.sub.length > 150 ? p.sub.slice(0, 147) + '…' : p.sub}</p><span class="mk-more">Learn more →</span></a>`)}
    </div>
    <div class="mk-inline-cta">${ctaRow()}</div>
  </div>
</section>
${mkFooter()}
${crumbLd}`;
  return mkDoc(`${g.name} — StayLeased`, g.lead, body, g.base);
}

// ---------------------------------------------------------------------------
// legal pages

function legalDoc(title: string, updated: string, content: Raw, path: string): Res {
  const o = siteOrigin();
  const crumbLd = ldJson({
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${o}/` },
      { '@type': 'ListItem', position: 2, name: title, item: `${o}${path}` },
    ],
  });
  const body = html`
${mkHeader()}
<div class="mkp-prose">
  <nav class="mkp-crumb" aria-label="Breadcrumb"><a href="/">Home</a><span class="sep" aria-hidden="true">/</span><span aria-current="page">${title}</span></nav>
  <h1>${title}</h1>
  <div class="mkp-date">Last updated ${updated}</div>
  ${content}
</div>
${mkFooter()}
${crumbLd}`;
  return mkDoc(`${title} — StayLeased`, `StayLeased ${title.toLowerCase()}.`, body, path);
}

const PRIVACY = html`
<p>StayLeased (“we”, “us”) provides property management software for independent rental operators. This policy explains what we collect and how we use it, in plain English.</p>
<h2>What we collect</h2>
<ul>
  <li><b>Account and contact information</b> — name, email, company, and portfolio details you provide when you request a demo, create a company, or sign in.</li>
  <li><b>Operating data</b> — the property, lease, resident, financial, and communications records your company creates in the product. This data belongs to your company; we process it to run the service.</li>
  <li><b>Usage and log data</b> — sign-ins, actions taken (kept in your company’s audit trail), and technical logs needed to operate and secure the service.</li>
  <li><b>Marketing-site analytics</b> — our public marketing pages may use Google Analytics to count visits and understand which pages are useful. This runs only on the marketing site — never inside the product, the resident portal, or any property’s leasing site — with IP anonymization on and Google signals and ad-personalization off. No operating data, resident data, or account data is ever sent to it.</li>
</ul>
<h2>How we use it</h2>
<ul>
  <li>To operate the service: billing runs, portals, reports, and the AI features described in the product.</li>
  <li>To respond when you ask us to (demo requests, support).</li>
  <li>To secure the platform: session management, permission enforcement, and audit logging.</li>
</ul>
<h2>AI processing</h2>
<p>Some features send relevant excerpts of your operating data to our AI provider (Anthropic) to generate answers and drafts — for example Ask StayLeased or import file reading. These calls are used to produce the response you asked for; agents act under your company’s autonomy settings, and their actions are recorded in your audit trail.</p>
<h2>What we don’t do</h2>
<ul>
  <li>We don’t sell your data or your residents’ data.</li>
  <li>We don’t use your company’s operating data to advertise to anyone.</li>
  <li>We don’t claim ownership of your data — export it at any time, including on the way out.</li>
</ul>
<h2>Residents</h2>
<p>If you’re a resident whose landlord or manager uses StayLeased, your records are controlled by that company; contact them for questions about your data. We process it on their behalf to provide the portal and related services.</p>
<h2>Retention and deletion</h2>
<p>Company data is retained while the account is active. On request after account closure we delete company data from the live system, subject to legal retention requirements.</p>
<h2>Contact</h2>
<p>Questions or requests: email us via the demo-request form on the homepage and we’ll respond from a human inbox. As an early-access product this policy will evolve; material changes will be posted here with a new date.</p>`;

const TERMS = html`
<p>These terms cover use of StayLeased during early access. They’re written to be read.</p>
<h2>The service</h2>
<p>StayLeased is property management software: leasing, operations, accounting, resident portals, and AI agents that work inside rules you configure. During early access some external rails (for example card/ACH processing, screening-bureau data, listing syndication, and outbound message delivery) are in staged rollout — the product labels what’s live and what’s coming on the Connections page, and we don’t charge you while we build with you.</p>
<h2>Your account and your data</h2>
<ul>
  <li>You’re responsible for the accuracy of data you import and for the credentials of users you invite.</li>
  <li>Your company’s data is yours. You can export it at any time, including if you leave.</li>
  <li>We operate the platform with role-based permissions, org isolation, and audit logging; you’re responsible for assigning roles sensibly.</li>
</ul>
<h2>AI features</h2>
<ul>
  <li>AI agents act only within the autonomy levels and bounds you configure, and their actions are logged.</li>
  <li>Default settings queue AI output for human approval. You choose when to increase autonomy, and you can reduce it — or use the kill switch — at any time.</li>
  <li>AI output can be wrong. Review what you approve; the audit trail exists so you always can.</li>
</ul>
<h2>Not professional advice</h2>
<p>StayLeased is software, not a law firm, accounting firm, or insurance carrier. Lease templates, fee policies, screening criteria, RUBS methods, and similar configurations are tools — have your attorney and CPA confirm what’s lawful and right for your jurisdiction and business.</p>
<h2>Acceptable use</h2>
<p>Don’t use the platform to violate law — including fair-housing, consumer-protection, and debt-collection law — or to harass anyone, attempt to access other companies’ data, or probe the service’s security. We can suspend accounts that do.</p>
<h2>Early-access warranty & liability</h2>
<p>The service is provided “as is” during early access, without warranties, and our liability is limited to the greatest extent the law allows. We run production carefully — persistent storage, backups, audit trails — and we tell you honestly what’s simulated versus live.</p>
<h2>Changes</h2>
<p>We’ll update these terms as the product matures (for example when payment processing goes live for your account); material changes will be posted here with a new date, and continued use after that constitutes acceptance.</p>`;

// ---------------------------------------------------------------------------
// routes

export function featureRoutes(r: Router): void {
  for (const group of Object.keys(MK_GROUPS) as MkPage['group'][]) {
    const g = MK_GROUPS[group];
    r.get(g.base, () => hubPage(group));
    r.get(`${g.base}/:slug`, (rq) => {
      const p = MK_PAGES.find((x) => x.group === group && x.slug === String(rq.params.slug));
      return p ? featurePage(p) : notFound();
    });
  }
  // the Residents marketing pillar was retired (2026-07-28) — we're not
  // selling a resident-experience platform yet; the portal is one Platform
  // item. Old URLs land on the portal page.
  r.get('/resident', () => redirect('/platform/resident-portal'));
  r.get('/resident/:slug', () => redirect('/platform/resident-portal'));
  r.get('/legal/privacy', () => legalDoc('Privacy Policy', 'August 12, 2026', PRIVACY, '/legal/privacy'));
  r.get('/legal/terms', () => legalDoc('Terms of Service', 'July 28, 2026', TERMS, '/legal/terms'));
}
