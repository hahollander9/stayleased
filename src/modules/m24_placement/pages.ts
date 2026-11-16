import { html, raw, when, type Child, type Raw } from '../../lib/html.ts';
import { fileRes, notFound, type Router, type Rq, type Res } from '../../lib/http.ts';
import { requirePerm } from '../../lib/auth.ts';
import { usd } from '../../lib/money.ts';
import { fmtDate, fromUtc, type DateStr } from '../../lib/dates.ts';
import { parseCsv } from '../../lib/csv.ts';
import { parseSpreadsheet } from '../../lib/xlsx.ts';
import { shell, card, kpis, tbl, field, input, registerNav } from '../../ui/ui.ts';
import { parseDelinquency, type DelinquencyRow, type Parsed } from '../m22_weekly/exports.ts';
import { sampleAsOf, sampleCsv } from '../m22_weekly/sample.ts';
import { parsePlacements, buildScorecard, MIN_GROUP, type Scorecard, type GroupStat, type PlacementParse } from './scorecard.ts';
import { samplePlacements } from './sample.ts';

/** /placement-scorecard — how tenants turn out, by leasing agent, lead source
 * and screening decision. Upload a tenant export and (optionally) a
 * delinquency export; nothing is stored. The fair-housing rules that shape
 * what this will and will not show are in scorecard.ts and are repeated on
 * the page, because the person reading the table needs them more than the
 * person reading the code. */

registerNav('Leasing', { href: '/placement-scorecard', label: 'Placement scorecard', perm: 'reports:view', match: ['/placement-scorecard'] });

const ACCEPT = '.csv,.tsv,.txt,.xlsx,.xlsm,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SAMPLE_FILES = { placements: 'sample-tenants-with-leasing-detail.csv', delinquency: 'sample-delinquency.csv' } as const;

function today(): DateStr {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return /^\d{4}-\d{2}-\d{2}$/.test(parts) ? parts : fromUtc(new Date());
}

function grids(rq: Rq, name: string): string[][][] | null {
  const up = (rq.uploads || []).find((u) => u.field === name && u.data.length);
  if (!up) return null;
  try {
    return parseSpreadsheet(up.filename, up.data, parseCsv)
      .map((s: { rows: unknown[][] }) => s.rows.map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c)))));
  } catch {
    return [];
  }
}

const pct = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`);
const badge = (label: string, tone: string): Raw => html`<span class="badge ${tone}">${label}</span>`;

function versus(g: GroupStat): Child {
  if (!g.judged) return html`<span class="muted small">Too few to judge</span>`;
  if (g.vsOthers === null) return '—';
  if (Math.abs(g.vsOthers) < 5) return html`<span class="muted small">About the same</span>`;
  return g.vsOthers > 0 ? badge(`${g.vsOthers} points more often`, g.vsOthers >= 15 ? 'bad' : 'warn') : badge(`${-g.vsOthers} points less often`, 'ok');
}

function scorecardPage(rq: Rq, s: Scorecard, parse: PlacementParse, source: 'sample' | 'upload'): Res {
  const content = html`
    <div class="callout info" style="font-size:14px;line-height:1.55">
      This compares <b>sources and processes</b> (which agent, which listing site, which screening decision), never people or kinds of people.
      A gap between groups is a question to look into, not a verdict. It must not be used to accept or reject an applicant.
    </div>
    ${kpis([
      { label: 'Tenants in the export', value: String(s.placements) },
      ...(s.hasBalances ? [
        { label: 'Behind on their share', value: pct(s.overall.behindRate), sub: `${s.overall.behind} household${s.overall.behind === 1 ? '' : 's'}`, tone: 'warn' as const },
        { label: 'Owed by households', value: usd(s.overall.owed || 0) },
      ] : []),
      ...(s.hasDates ? [{ label: 'Left within a year', value: pct(s.overall.earlyRate), sub: 'of those with a full year of history' }] : []),
    ])}
    ${s.dims.map((d) => card(`By ${d.label.toLowerCase()}`, html`
      ${tbl(
        [{ label: d.label }, { label: 'Placements', num: true },
          ...(s.hasBalances ? [{ label: 'Behind', num: true }, { label: 'Behind rate', num: true }, { label: 'Compared with the rest' }, { label: 'Owed', num: true }, { label: 'Avg. months behind', num: true }] : []),
          ...(s.hasDates ? [{ label: 'Left within a year', num: true }] : [])],
        d.groups.map((g) => ({
          cells: [
            html`<b>${g.name}</b>`, g.placements,
            ...(s.hasBalances ? [g.behind ?? '—', g.judged ? pct(g.behindRate) : html`<span class="muted">${pct(g.behindRate)}</span>`, versus(g), usd(g.owed || 0), g.avgMonthsBehind ?? '—'] : []),
            ...(s.hasDates ? [g.earlyMoveOuts === null ? '—' : `${g.earlyMoveOuts} (${pct(g.earlyRate)})`] : []),
          ],
        })),
        { sort: false, empty: 'No rows carry this label.' },
      )}
      ${when(d.unlabeled, () => html`<p class="small muted" style="margin:10px 0 0">${d.unlabeled} row${d.unlabeled === 1 ? '' : 's'} with no ${d.label.toLowerCase()} left out.</p>`)}`))}
    ${card('How to read this', html`
      <ul class="small" style="margin:0;padding-left:18px;line-height:1.7">
        <li><b>Behind</b> means the household’s own share is at least $50 past due.</li>
        <li><b>Compared with the rest</b> is the group’s behind rate against everyone else’s, in percentage points. Groups under ${MIN_GROUP} placements are listed but not compared.</li>
        <li><b>Left within a year</b> counts only tenants who have had a full year to stay or go.</li>
        ${s.notes.map((n) => html`<li>${n}</li>`)}
      </ul>
      <p class="small muted" style="margin:10px 0 0">Read ${parse.rowsRead} tenant rows${parse.skipped ? `, skipped ${parse.skipped} (vacant, blank or total rows)` : ''}.${parse.missing.length ? ` Columns not found: ${parse.missing.join(', ')}.` : ''} The files were read for this page only and were not saved.</p>`)}
  `;
  return shell(rq, {
    title: 'Placement scorecard',
    active: '/placement-scorecard',
    crumbs: [['Leasing'], ['Placement scorecard', '/placement-scorecard']],
    subtitle: html`As of ${fmtDate(s.asOf)} · ${source === 'sample' ? html`<b>sample portfolio</b> (fictional names, agents and figures)` : 'from the exports uploaded'}`,
    actions: html`<button type="button" class="btn btn-ghost" data-print>Print or save as PDF</button> <a class="btn" href="/placement-scorecard">New scorecard</a>`,
    content,
    wide: true,
  });
}

function uploadPage(rq: Rq, error?: string): Res {
  return shell(rq, {
    title: 'Placement scorecard',
    active: '/placement-scorecard',
    crumbs: [['Leasing'], ['Placement scorecard']],
    subtitle: 'How tenants turn out, by leasing agent and lead source. From your own exports; nothing is saved.',
    actions: html`<a class="btn" href="/placement-scorecard/sample">See it on a sample portfolio</a>`,
    content: html`
      ${when(error, () => html`<div class="callout bad">${error}</div>`)}
      <div class="grid cols-2">
        ${card('Build a scorecard', html`
          <form method="post" action="/placement-scorecard" enctype="multipart/form-data">
            <div class="form-grid">
              ${field(html`Tenant export <span class="req">*</span>`, raw(`<input type="file" name="placements" accept="${ACCEPT}" required />`),
                'Needs a Unit column and at least one of: Leasing Agent, Lead Source, Screening Decision. Move-in and move-out dates enable “left within a year”.')}
              ${field(html`Delinquency <span class="muted small">(optional)</span>`, raw(`<input type="file" name="delinquency" accept="${ACCEPT}" />`),
                'Enables “behind on rent”. A subsidy-balance column keeps agency balances from counting against households.')}
              ${field('As of', input('as_of', { type: 'date', value: today() }))}
            </div>
            <div class="btn-row"><button class="btn" type="submit">Build the scorecard</button></div>
          </form>`)}
        ${card('What it does, and what it will not do', html`
          <ul class="small" style="margin:0;padding-left:18px;line-height:1.7">
            <li>Compares outcomes by <b>leasing agent</b>, <b>lead source</b> and <b>screening decision</b>.</li>
            <li>Will not group by anything else in the file. It never reads a subsidy or voucher column: source of income is a protected trait in DC and many other places.</li>
            <li>Does not rank groups with fewer than ${MIN_GROUP} placements.</li>
            <li>Is for managing agents and advertising spend. It is not a screening tool and must not be used on an applicant.</li>
          </ul>
          <h3 style="font-size:13px;margin:16px 0 6px">The sample exports</h3>
          <ul class="small" style="margin:0;padding-left:18px">
            ${Object.values(SAMPLE_FILES).map((f) => html`<li><a href="/placement-scorecard/sample/${f}">${f}</a></li>`)}
          </ul>`)}
      </div>`,
  });
}

export function routes(r: Router): void {
  const view = requirePerm('reports:view');

  r.get('/placement-scorecard', view, (rq) => uploadPage(rq));

  r.post('/placement-scorecard', view, (rq) => {
    const pg = grids(rq, 'placements');
    if (!pg) return uploadPage(rq, 'A tenant export is needed.');
    let best = null as PlacementParse | null;
    for (const g of pg) {
      const p = parsePlacements(g);
      if (!best || p.rowsRead > best.rowsRead || (!best.rowsRead && p.warnings.length < best.warnings.length)) best = p;
    }
    if (!best || !best.rows.length) {
      return uploadPage(rq, `No tenant rows could be read. ${best?.warnings.join(' ') || 'The file could not be opened as a spreadsheet or CSV.'}`);
    }
    let del = null as Parsed<DelinquencyRow> | null;
    for (const g of grids(rq, 'delinquency') || []) {
      const p = parseDelinquency(g);
      if (!del || p.report.rowsRead > del.report.rowsRead) del = p;
    }
    if (del && !del.rows.length) del = null;
    const asOfRaw = String(rq.body.as_of || '');
    const res = scorecardPage(rq, buildScorecard({
      asOf: /^\d{4}-\d{2}-\d{2}$/.test(asOfRaw) ? asOfRaw : today(), placements: best, delinquency: del,
    }), best, 'upload');
    res.headers['cache-control'] = 'no-store';
    return res;
  });

  r.get('/placement-scorecard/sample', view, (rq) => {
    const asOf = sampleAsOf(today());
    const s = samplePlacements(asOf);
    const parse = parsePlacements(s.placements);
    return scorecardPage(rq, buildScorecard({ asOf, placements: parse, delinquency: parseDelinquency(s.delinquency) }), parse, 'sample');
  });

  r.get('/placement-scorecard/sample/:file', view, (rq) => {
    const entry = Object.entries(SAMPLE_FILES).find(([, f]) => f === rq.params.file);
    if (!entry) return notFound();
    const s = samplePlacements(sampleAsOf(today()));
    return fileRes(sampleCsv(s[entry[0] as keyof typeof SAMPLE_FILES]), 'text/csv; charset=utf-8', { filename: entry[1] });
  });
}
