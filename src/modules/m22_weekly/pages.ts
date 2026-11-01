import { html, raw, when, type Child, type Raw } from '../../lib/html.ts';
import { fileRes, notFound, forbidden, type Router, type Rq, type Res } from '../../lib/http.ts';
import { requireStaff, can, type Ctx } from '../../lib/auth.ts';
import { usd } from '../../lib/money.ts';
import { fmtDate, fmtMonth, fromUtc, monthKey, type DateStr } from '../../lib/dates.ts';
import { parseCsv, toCsv } from '../../lib/csv.ts';
import { parseSpreadsheet } from '../../lib/xlsx.ts';
import { shell, card, kpis, tbl, field, input, registerNav } from '../../ui/ui.ts';
import {
  parseRentRoll, parseDelinquency, parseReceipts, parseWorkOrders, type Parsed, type FileReport,
} from './exports.ts';
import { buildReport, summarize, type Report, type FollowUp, type Flag } from './engine.ts';
import { sampleFiles, sampleAsOf, sampleCsv, SAMPLE_FILE_NAMES } from './sample.ts';

/** /weekly-report — the Weekly Cash & Collections Action Report.
 *
 * Runs alongside the operator's existing system: upload the exports, read the
 * report, act on the list. The uploads are parsed in memory for this one
 * response and are never written to disk or to the database, so a prospective
 * partner can try it with real exports without StayLeased becoming a second
 * system of record for their residents' balances. That is also why there is
 * no "save" and no history: the history lives in their system, where it
 * belongs, and next week's report is next week's exports.
 */

registerNav('Money', { href: '/weekly-report', label: 'Weekly action report', perm: 'reports:view', match: ['/weekly-report'] });

const FILE_FIELDS = [
  { name: 'rent_roll', label: 'Rent roll', required: true, hint: 'With tenant and subsidy rent columns if the report has them.' },
  { name: 'delinquency', label: 'Delinquency (aged receivables)', required: true, hint: 'A subsidy-balance column lets the report split what agencies owe.' },
  { name: 'receipts', label: 'Receipts for this month', required: false, hint: 'Enables expected vs. received and missing agency payments.' },
  { name: 'delinquency_prior', label: 'Last week’s delinquency', required: false, hint: 'Enables “since last week”.' },
  { name: 'work_orders', label: 'Work orders', required: false, hint: 'Enables the stalled-repairs list.' },
] as const;

const ACCEPT = '.csv,.tsv,.txt,.xlsx,.xlsm,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function today(): DateStr {
  // the operator's calendar, not the server's UTC midnight
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return /^\d{4}-\d{2}-\d{2}$/.test(parts) ? parts : fromUtc(new Date());
}

/** Read one uploaded export. A workbook may carry several sheets; the one the
 * parser reads the most rows from is the report. */
function readUpload<T>(rq: Rq, name: string, parse: (grid: string[][]) => Parsed<T>): Parsed<T> | null {
  const up = (rq.uploads || []).find((u) => u.field === name && u.data.length);
  if (!up) return null;
  let sheets: { rows: string[][] }[];
  try {
    sheets = parseSpreadsheet(up.filename, up.data, parseCsv);
  } catch {
    const p = parse([]);
    p.report.warnings.unshift(`${up.filename} could not be opened as a spreadsheet or CSV.`);
    return p;
  }
  let best: Parsed<T> | null = null;
  for (const s of sheets) {
    const grid = s.rows.map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c))));
    const p = parse(grid);
    if (!best || p.report.rowsRead > best.report.rowsRead) best = p;
  }
  return best;
}

// ---------- rendering ----------

const KIND_LABEL: Record<FollowUp['kind'], [string, string]> = {
  agency: ['Agency', 'violet'],
  tenant: ['Household', 'info'],
  confirm: ['Confirm split', 'warn'],
  investigate: ['Check posting', 'warn'],
};

const FLAG_LABEL: Record<Flag['kind'], [string, string]> = {
  agency_missing: ['No agency payment', 'bad'],
  agency_short: ['Agency paid short', 'warn'],
  tenant_none: ['No household payment', 'warn'],
  tenant_short: ['Partial payment', 'warn'],
  overpaid: ['More than rent', 'info'],
  unmatched_receipt: ['Unit not on rent roll', 'warn'],
  vacant_receipt: ['Paid on a vacant unit', 'warn'],
};

const badge = (label: string, tone: string): Raw => html`<span class="badge ${tone}">${label}</span>`;
const where = (property: string, unit: string): string => [property, unit].filter(Boolean).join(' · ');

function followUpCsv(r: Report): string {
  return toCsv(
    ['Rank', 'Type', 'Who', 'Property', 'Unit', 'Amount', 'Age', 'Why', 'Next step'],
    r.followUps.map((f) => [f.rank, KIND_LABEL[f.kind][0], f.who, f.property, f.unit, (f.amount / 100).toFixed(2), f.age, f.why, f.step]),
  );
}

function filesCard(files: FileReport[], limits: string[]): Raw {
  const tie = (f: FileReport): Child => {
    if (f.fileTotal === null || f.ourTotal === null) return html`<span class="muted">No total row</span>`;
    return f.fileTotal === f.ourTotal
      ? badge(`Ties to ${usd(f.fileTotal)}`, 'ok')
      : badge(`Ours ${usd(f.ourTotal)} vs. file ${usd(f.fileTotal)}`, 'bad');
  };
  return card('What this report read', html`
    ${tbl(
      [{ label: 'Export' }, { label: 'Rows read', num: true }, { label: 'Total' }, { label: 'Columns not found' }],
      files.map((f) => ({
        cells: [
          html`<b>${f.title}</b>${f.warnings.map((w) => html`<div class="callout warn" style="margin:6px 0 0">${w}</div>`)}`,
          f.rowsRead, tie(f),
          f.missing.length ? html`<span class="muted small">${f.missing.join(', ')}</span>` : html`<span class="muted small">None</span>`,
        ],
      })),
      { sort: false },
    )}
    ${when(limits.length, () => html`<ul class="small muted" style="margin:12px 0 0;padding-left:18px">${limits.map((l) => html`<li>${l}</li>`)}</ul>`)}
    <p class="small muted" style="margin:10px 0 0">The files were read for this page only and were not saved. Nothing on this page has been sent to anyone.</p>
  `);
}

function reportPage(rq: Rq, r: Report, source: 'sample' | 'upload'): Res {
  const c = (n: number): string => usd(n);
  const monthName = fmtMonth(monthKey(r.asOf));
  const owedKpis = [
    { label: 'Owed in total', value: c(r.owed.total), sub: `${r.owed.households} household${r.owed.households === 1 ? '' : 's'}` },
    { label: 'Owed by households', value: c(r.owed.tenant), tone: 'warn' as const },
    { label: 'Owed by agencies', value: c(r.owed.agency), sub: r.agencies.length ? `${r.agencies.length} program${r.agencies.length === 1 ? '' : 's'}` : undefined, tone: 'bad' as const },
    ...(r.owed.unsplit ? [{ label: 'Not split', value: c(r.owed.unsplit), sub: 'Needs the subsidy column' }] : []),
    ...(r.month ? [{
      label: `Came in, ${monthName}`, value: c(r.month.receivedTenant + r.month.receivedAgency),
      sub: `of ${c(r.month.expectedTenant + r.month.expectedAgency + r.month.expectedUnsplit)} expected`,
    }] : []),
    { label: 'Vacant units', value: String(r.vacancy.units), sub: r.vacancy.units ? `${c(r.vacancy.monthlyRent)} a month in rent` : undefined },
  ];

  const top = r.followUps.slice(0, 15);
  const rest = r.followUps.slice(15);
  const fuTable = (rows: FollowUp[]): Raw => tbl(
    [{ label: '#', num: true, w: '36px' }, { label: 'Who' }, { label: 'Where' }, { label: 'Amount', num: true }, { label: 'Age' }, { label: 'Why' }, { label: 'Next step' }],
    rows.map((f) => ({
      cells: [
        f.rank,
        html`${badge(KIND_LABEL[f.kind][0], KIND_LABEL[f.kind][1])}<div style="margin-top:4px"><b>${f.who || '—'}</b></div>`,
        f.kind === 'agency' && !f.property ? html`<span class="small">${f.unit}</span>` : where(f.property, f.unit),
        html`<b>${c(f.amount)}</b>`, html`<span class="nowrap">${f.age || '—'}</span>`,
        html`<span class="small">${f.why}</span>`, html`<span class="small">${f.step}</span>`,
      ],
    })),
    { sort: false, empty: 'Nothing to follow up on.' },
  );
  const csvHref = 'data:text/csv;charset=utf-8,' + encodeURIComponent(followUpCsv(r));

  const content = html`
    <div class="callout info" style="font-size:14px;line-height:1.55">${summarize(r, usd)}</div>
    ${kpis(owedKpis)}

    ${card(html`Follow-up list for the week of ${fmtDate(r.asOf)}`, html`
      <p class="small muted" style="margin:0 0 10px">Ranked by amount × how long it has been owed. Agency balances are grouped, because one call to an agency’s landlord line covers every household on that program. Steps are suggestions for staff; nothing is sent from here.</p>
      <div class="wr-wide">${fuTable(top)}</div>
      ${when(rest.length, () => html`<details class="wr-wide" style="margin-top:10px" data-print-open><summary class="small">${rest.length} more</summary>${fuTable(rest)}</details>`)}
    `, { actions: html`<a class="btn btn-sm btn-ghost" download="follow-up-list-${r.asOf}.csv" href="${csvHref}">Download CSV</a>` })}

    ${when(r.agencies.length, () => card('What housing agencies owe', tbl(
      [{ label: 'Program' }, { label: 'Households', num: true }, { label: 'Owed', num: true }, { label: 'No payment this month', num: true }, { label: 'Most behind' }, { label: 'Units' }],
      r.agencies.map((a) => ({
        cells: [html`<b>${a.program}</b>`, a.households, c(a.owed), r.month ? a.noPaymentThisMonth : '—',
          a.worstMonthsBehind !== null ? `${a.worstMonthsBehind} mo of subsidy` : '—', html`<span class="small">${a.units.join(', ')}</span>`],
      })),
      { foot: ['Total', r.agencies.reduce((s, a) => s + a.households, 0), c(r.owed.agency), '', '', ''] },
    )))}

    ${when(r.month, () => {
      const m = r.month!;
      const row = (label: string, exp: number, got: number | null): { cells: Child[] } => ({
        cells: [label, c(exp), got === null ? '—' : c(got), got === null ? '—' : html`<b class="${got < exp ? 'sm-neg' : ''}">${c(got - exp)}</b>`],
      });
      const rows = [row('Households', m.expectedTenant, m.receivedTenant), row('Housing agencies', m.expectedAgency, m.receivedAgency)];
      if (m.expectedUnsplit) rows.push(row('Leases with no split on the rent roll', m.expectedUnsplit, null));
      return card(`Expected vs. received, ${monthName} to date`, html`
        ${tbl([{ label: 'From' }, { label: 'Expected (rent roll)', num: true }, { label: 'Received (receipts)', num: true }, { label: 'Difference', num: true }], rows, {
          sort: false,
          foot: ['Total', c(m.expectedTenant + m.expectedAgency + m.expectedUnsplit), c(m.receivedTenant + m.receivedAgency),
            c(m.receivedTenant + m.receivedAgency - m.expectedTenant - m.expectedAgency - m.expectedUnsplit)],
        })}
        <p class="small muted" style="margin:10px 0 0">Received includes catch-up and payment-plan money, so a household line can come in above its rent.</p>
        ${when(r.flags.length, () => {
          const flagTable = (fs: Flag[]): Raw => tbl([{ label: 'What' }, { label: 'Where' }, { label: 'Who' }, { label: 'Expected', num: true }, { label: 'Received', num: true }],
            fs.map((f) => ({ cells: [badge(FLAG_LABEL[f.kind][0], FLAG_LABEL[f.kind][1]), where(f.property, f.unit), f.who || '—', c(f.expected), c(f.received)] })));
          // agency problems first: one of those is a whole program's check
          const order: Flag['kind'][] = ['agency_missing', 'agency_short', 'unmatched_receipt', 'vacant_receipt', 'tenant_none', 'tenant_short', 'overpaid'];
          const fs = [...r.flags].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
          return html`<h3 style="font-size:14px;margin:18px 0 8px">Payments to look at (${fs.length})</h3>
            ${flagTable(fs.slice(0, 12))}
            ${when(fs.length > 12, () => html`<details style="margin-top:10px" data-print-open><summary class="small">${fs.length - 12} more</summary>${flagTable(fs.slice(12))}</details>`)}`;
        })}
      `);
    })}

    ${when(r.changes, () => card('Since last week', tbl(
      [{ label: 'Change' }, { label: 'Where' }, { label: 'Name' }, { label: 'Last week', num: true }, { label: 'Now', num: true }],
      r.changes!.map((ch) => ({
        cells: [badge({ new: 'Newly behind', grew: 'Grew', shrank: 'Paid down', cured: 'Paid off' }[ch.kind], { new: 'bad', grew: 'warn', shrank: 'info', cured: 'ok' }[ch.kind]),
          where(ch.property, ch.unit), ch.name || '—', c(ch.before), c(ch.after)],
      })),
      { empty: 'No balance moved by more than a dollar.' },
    )))}

    ${when(r.maintenance, () => {
      const m = r.maintenance!;
      return card('Repairs that need a push', html`
        <p class="small muted" style="margin:0 0 10px">${m.open} open · ${m.stalled} with no activity in a week · ${m.urgentOverdue} urgent and open more than a day.</p>
        ${tbl([{ label: 'WO' }, { label: 'Where' }, { label: 'Issue' }, { label: 'Priority' }, { label: 'Status' }, { label: 'Why it is here' }],
          m.items.map((w) => ({
            cells: [w.number || '—', where(w.property, w.unit), w.description || '—',
              badge(w.priority, w.priority === 'urgent' ? 'bad' : w.priority === 'normal' ? 'info' : ''), w.status, html`<span class="small">${w.why}</span>`],
          })),
          { sort: false, empty: 'No open work order is overdue or idle.' })}
      `);
    })}

    ${when(r.vacancy.units, () => card('Vacant units', tbl(
      [{ label: 'Where' }, { label: 'Monthly rent', num: true }],
      r.vacancy.list.map((v) => ({ cells: [where(v.property, v.unit), c(v.rent)] })),
      { foot: ['Total', c(r.vacancy.monthlyRent)] },
    )))}

    ${filesCard(r.files, r.limits)}
  `;

  return shell(rq, {
    title: 'Weekly action report',
    active: '/weekly-report',
    crumbs: [['Money'], ['Weekly action report', '/weekly-report']],
    subtitle: html`As of ${fmtDate(r.asOf)} · ${source === 'sample'
      ? html`<b>sample portfolio</b> (fictional names and figures)`
      : 'from the exports uploaded'}`,
    actions: html`<button type="button" class="btn btn-ghost" data-print>Print or save as PDF</button>
      <a class="btn" href="/weekly-report">New report</a>`,
    content,
    wide: true,
  });
}

function uploadPage(rq: Rq, error?: string): Res {
  const fileField = (f: typeof FILE_FIELDS[number]): Raw => field(
    html`${f.label}${f.required ? html` <span class="req">*</span>` : html` <span class="muted small">(optional)</span>`}`,
    raw(`<input type="file" name="${f.name}" accept="${ACCEPT}"${f.required ? ' required' : ''} />`),
    f.hint,
  );
  return shell(rq, {
    title: 'Weekly action report',
    active: '/weekly-report',
    crumbs: [['Money'], ['Weekly action report']],
    subtitle: 'Cash, collections and stalled repairs from AppFolio exports — alongside AppFolio, not instead of it.',
    actions: html`<a class="btn" href="/weekly-report/sample">See it on a sample portfolio</a>`,
    content: html`
      ${when(error, () => html`<div class="callout bad">${error}</div>`)}
      <div class="grid cols-2">
        ${card('Build this week’s report', html`
          <form method="post" action="/weekly-report" enctype="multipart/form-data">
            <div class="form-grid">
              ${FILE_FIELDS.map(fileField)}
              ${field('As of', input('as_of', { type: 'date', value: today() }), 'Usually today. “This month” runs from the 1st to this date.')}
            </div>
            <div class="btn-row"><button class="btn" type="submit">Build the report</button></div>
          </form>
        `)}
        ${card('How it works', html`
          <ol class="small" style="margin:0;padding-left:18px;line-height:1.7">
            <li>Export the reports from AppFolio as Excel or CSV, exactly as they come out.</li>
            <li>Upload them here. The files are read for this one page and are not saved.</li>
            <li>The report splits what households owe from what housing agencies owe, compares this month’s receipts with the rent roll, ranks a follow-up list, and flags repairs that have stalled.</li>
          </ol>
          <p class="small muted" style="margin:12px 0 0">Nothing is sent to residents, agencies or vendors from this page. Every figure is arithmetic on the uploaded rows, and anything the exports cannot support is shown as such rather than estimated.</p>
          <h3 style="font-size:13px;margin:16px 0 6px">The sample exports</h3>
          <p class="small muted" style="margin:0 0 6px">Fictional data in the layout the reader expects:</p>
          <ul class="small" style="margin:0;padding-left:18px">
            ${Object.entries(SAMPLE_FILE_NAMES).map(([, fname]) => html`<li><a href="/weekly-report/sample/${fname}">${fname}</a></li>`)}
          </ul>
        `)}
      </div>
    `,
  });
}

export function routes(r: Router): void {
  r.get('/weekly-report', requireStaff, (rq) => {
    if (!can(rq.ctx as Ctx, 'reports:view')) return forbidden();
    return uploadPage(rq);
  });

  r.post('/weekly-report', requireStaff, (rq) => {
    if (!can(rq.ctx as Ctx, 'reports:view')) return forbidden();
    const rentRoll = readUpload(rq, 'rent_roll', parseRentRoll);
    const delinquency = readUpload(rq, 'delinquency', (g) => parseDelinquency(g));
    if (!rentRoll || !delinquency) return uploadPage(rq, 'The rent roll and the delinquency export are both needed.');
    if (!rentRoll.rows.length || !delinquency.rows.length) {
      const which = !rentRoll.rows.length ? rentRoll.report : delinquency.report;
      return uploadPage(rq, `No rows could be read from the ${which.title.toLowerCase()}. ${which.warnings.join(' ')}`);
    }
    const asOfRaw = String(rq.body.as_of || '');
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(asOfRaw) ? asOfRaw : today();
    const report = buildReport({
      asOf, rentRoll, delinquency,
      receipts: readUpload(rq, 'receipts', parseReceipts),
      prior: readUpload(rq, 'delinquency_prior', (g) => parseDelinquency(g, 'Last week’s delinquency')),
      workOrders: readUpload(rq, 'work_orders', parseWorkOrders),
    });
    const res = reportPage(rq, report, 'upload');
    // residents' balances: never cache this response anywhere
    res.headers['cache-control'] = 'no-store';
    return res;
  });

  r.get('/weekly-report/sample', requireStaff, (rq) => {
    if (!can(rq.ctx as Ctx, 'reports:view')) return forbidden();
    const s = sampleFiles(sampleAsOf(today()));
    return reportPage(rq, buildReport({
      asOf: s.asOf,
      rentRoll: parseRentRoll(s.rentRoll),
      delinquency: parseDelinquency(s.delinquency),
      receipts: parseReceipts(s.receipts),
      prior: parseDelinquency(s.delinquencyPrior, 'Last week’s delinquency'),
      workOrders: parseWorkOrders(s.workOrders),
    }), 'sample');
  });

  r.get('/weekly-report/sample/:file', requireStaff, (rq) => {
    if (!can(rq.ctx as Ctx, 'reports:view')) return forbidden();
    const entry = Object.entries(SAMPLE_FILE_NAMES).find(([, f]) => f === rq.params.file);
    if (!entry) return notFound();
    const s = sampleFiles(sampleAsOf(today()));
    return fileRes(sampleCsv(s[entry[0] as keyof typeof SAMPLE_FILE_NAMES]), 'text/csv; charset=utf-8', { filename: entry[1] });
  });
}
