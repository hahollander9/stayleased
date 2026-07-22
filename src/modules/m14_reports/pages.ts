import { html, raw, when, join, esc, type Child } from '../../lib/html.ts';
import { redirect, notFound, fileRes, htmlRes, type Router, type Rq } from '../../lib/http.ts';
import { requirePerm, can, type Ctx } from '../../lib/auth.ts';
import { q, q1, insert, run, j, js } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, fmtDate } from '../../lib/dates.ts';
import { audit } from '../../lib/audit.ts';
import {
  shell, card, tbl, statusBadge, field, select, input, checkbox, registerNav, kpis, tabs, emptyState,
} from '../../ui/ui.ts';
import {
  CATEGORY_ORDER, reportDefs, reportDef, resolveParams, processResult, reportCsv, reportPdf,
  accessibleProperties, fmtCell, type ReportDef, type RenderedReport, type ReportCol,
} from './engine.ts';
import { DATASETS, dataset, runCustom, configFromQuery, type BuilderConfig } from './builder.ts';
import { deliverSavedReport } from './schedule.ts';
import { WIDGETS, widget, userLayout, saveLayout, resetLayout } from './dashboards.ts';
import './defs_ops.ts';
import './defs_leasing.ts';
import './defs_receivables.ts';
import './defs_accounting.ts';
import './defs_facilities.ts';
import './defs_utilities.ts';
import './defs_portfolio.ts';
import './snapshots.ts'; // registers metric_snapshots job

/** M14 screens: the §10 report catalog, the generic report runner (params,
 * sort/group, totals, drill-through, CSV/PDF), the custom builder, saved +
 * scheduled reports, and role dashboards. */

registerNav('Intelligence', { href: '/reports', label: 'Reports', perm: 'reports:view', match: ['/reports'] });
registerNav('Intelligence', { href: '/dashboards', label: 'My dashboard', perm: 'dashboard:view', match: ['/dashboards'] });

// ---------- shared: render a processed report as an HTML table ----------

function sortLink(rq: Rq, col: ReportCol, current: { sort?: string; dir?: string }): string {
  const sp = new URLSearchParams(rq.query);
  sp.set('sort', col.key);
  sp.set('dir', current.sort === col.key && current.dir !== 'desc' ? 'desc' : 'asc');
  return `${rq.path}?${sp}`;
}

function reportTable(rq: Rq, rendered: RenderedReport, opts: { sort?: string; dir?: string }): Child {
  const cols = rendered.cols;
  const header = html`<thead><tr>${cols.map((c) => html`
    <th class="${c.kind === 'money' || c.kind === 'num' || c.kind === 'pct' ? 'num' : ''}">
      <a href="${sortLink(rq, c, opts)}" style="color:inherit;text-decoration:none">${c.label}${opts.sort === c.key ? (opts.dir === 'desc' ? ' ↓' : ' ↑') : ''}</a>
    </th>`)}</tr></thead>`;
  const cell = (r: Record<string, unknown>, c: ReportCol): Child => {
    const v = fmtCell(r[c.key], c.kind);
    if (c.kind === 'badge' && v !== '—') return statusBadge(String(r[c.key]), v.replaceAll('_', ' '));
    if (c.kind === 'money' && Number(r[c.key]) < 0) return html`<span class="neg">${v}</span>`;
    return v;
  };
  const bodyRows = (rows: RenderedReport['rows']): Child => join(rows.map((r) => html`
    <tr ${r.__href ? raw(`data-href="${esc(String(r.__href))}" tabindex="0"`) : ''}>
      ${cols.map((c) => html`<td class="${c.kind === 'money' || c.kind === 'num' || c.kind === 'pct' ? 'num' : ''}">${cell(r, c)}</td>`)}
    </tr>`));
  const totalsRow = (label: string, t: Record<string, unknown>): Child => html`
    <tr style="font-weight:700;border-top:2px solid var(--line)">
      ${cols.map((c, i) => html`<td class="${c.kind === 'money' || c.kind === 'num' ? 'num' : ''}">${i === 0 ? label : t[c.key] !== undefined ? fmtCell(t[c.key], c.kind) : ''}</td>`)}
    </tr>`;
  if (!rendered.rows.length) return emptyState('No rows for these parameters', 'Widen the range or change the property.');
  return html`<div class="tbl-wrap"><table class="tbl">
    ${header}
    <tbody>
      ${rendered.groups
        ? join(rendered.groups.map((g) => html`
            <tr><td colspan="${cols.length}" style="background:var(--surface-2);font-weight:700;padding:8px 10px">${g.label} <span class="muted small">(${g.rows.length})</span></td></tr>
            ${bodyRows(g.rows)}
            ${when(g.subtotal, () => totalsRow('Subtotal', g.subtotal!))}`))
        : bodyRows(rendered.rows)}
      ${when(rendered.totals, () => totalsRow('Total', rendered.totals!))}
    </tbody>
  </table></div>
  ${when(rendered.truncated, () => html`<p class="small muted">Showing the first ${rendered.rows.length} rows — export CSV for the full set.</p>`)}
  ${when(rendered.note, () => html`<p class="small muted" style="margin-top:8px">${rendered.note}</p>`)}`;
}

function paramPanel(rq: Rq, ctx: Ctx, def: ReportDef, params: Record<string, string>): Child {
  const props = accessibleProperties(ctx);
  return html`<form method="get" class="toolbar" data-autosubmit>
    ${def.params.map((p) => {
      const v = params[p.key] || '';
      switch (p.kind) {
        case 'property': {
          const opts: [string, string][] = [...(p.allowAll ? [['all', 'All properties'] as [string, string]] : []), ...props.map((x): [string, string] => [x.id, x.name])];
          return field(p.label || 'Property', select(p.key, opts, v));
        }
        case 'date': return field(p.label || 'As of', input(p.key, { type: 'date', value: v }));
        case 'month': return field(p.label || 'Month', input(p.key, { type: 'month', value: v }));
        case 'from': return field(p.label || 'From', input(p.key, { type: 'date', value: v }));
        case 'to': return field(p.label || 'To', input(p.key, { type: 'date', value: v }));
        case 'basis': return field('Basis', select(p.key, [['accrual', 'Accrual'], ['cash', 'Cash']], v));
        case 'year': return field(p.label || 'Year', input(p.key, { value: v }));
        case 'select': return field(p.label || p.key, select(p.key, p.options || [], v));
      }
    })}
    ${when(rq.query.get('group'), () => html`<input type="hidden" name="group" value="${rq.query.get('group')}" />`)}
    <button class="btn btn-sm">Run</button>
  </form>`;
}

export function routes(r: Router): void {
  // ---------- catalog ----------
  r.get('/reports', requirePerm('reports:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const term = (rq.query.get('q') || '').toLowerCase();
    const defs = reportDefs().filter((d) => !d.perm || can(ctx, d.perm))
      .filter((d) => !term || `${d.name} ${d.describe} ${d.category}`.toLowerCase().includes(term));
    const mine = q<any>(
      `SELECT sr.*, u.name AS owner FROM saved_reports sr JOIN users u ON u.id=sr.owner_user_id
       WHERE sr.org_id=? AND (sr.owner_user_id=? OR sr.shared=1) ORDER BY sr.created_at DESC`,
      ctx.orgId, ctx.userId,
    );
    return shell(rq, {
      title: 'Report library',
      active: '/reports',
      subtitle: `${defs.length} canonical reports — every §10 report with parameters, drill-through, totals and CSV/PDF export`,
      actions: html`${when(can(ctx, 'reports:build'), () => html`<a class="btn" href="/reports/builder">Custom report builder</a>`)}`,
      content: html`
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Search the catalog', input('q', { value: rq.query.get('q') || '', placeholder: 'rent roll, aging, SLA…' }))}
        </form>
        ${when(mine.length, () => card('Saved & scheduled reports', tbl(
          [{ label: 'Name' }, { label: 'Base' }, { label: 'Owner' }, { label: 'Shared' }, { label: 'Schedule' }, { label: 'Last run' }],
          mine.map((s) => ({
            href: `/reports/saved/${s.id}`,
            cells: [
              html`<b>${s.name}</b>`,
              s.kind === 'custom' ? `${s.dataset} (custom)` : reportDef(s.dataset)?.name || s.dataset,
              s.owner, s.shared ? 'shared' : 'private',
              s.schedule ? statusBadge('scheduled', s.schedule) : html`<span class="muted">—</span>`,
              s.last_run_date ? fmtDate(s.last_run_date) : '—',
            ],
          })),
        )))}
        ${CATEGORY_ORDER.map((cat) => {
          const list = defs.filter((d) => d.category === cat);
          if (!list.length) return null;
          return card(`${cat} (${list.length})`, html`<div class="grid cols-2">
            ${list.map((d) => html`<a class="list-item" href="/reports/${d.key}" style="display:block;padding:10px;border:1px solid var(--line-2);border-radius:10px;text-decoration:none;color:inherit">
              <b>${d.name}</b><br /><span class="muted small">${d.describe}</span>
            </a>`)}
          </div>`);
        })}`,
    });
  });

  // ---------- custom builder ----------
  r.get('/reports/builder', requirePerm('reports:build'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const cfg = configFromQuery(rq.query);
    const ds = dataset(cfg.dataset) || DATASETS[0]!;
    if (!cfg.cols.length) cfg.cols = ds.defaultCols;
    let rendered: RenderedReport | null = null;
    let error = '';
    try {
      rendered = processResult(runCustom(ctx, cfg), {});
    } catch (e) {
      error = (e as Error).message;
    }
    const filterRow = (i: number): Child => {
      const f = cfg.filters[i];
      return html`<div class="toolbar">
        ${field(`Filter ${i + 1}`, select(`f${i}_col`, [...ds.cols.filter((c) => c.filter).map((c): [string, string] => [c.key, c.label])], f?.col, { blank: '(none)' }))}
        ${field('Op', select(`f${i}_op`, [['contains', 'contains'], ['eq', '='], ['gte', '≥'], ['lte', '≤']], f?.op || 'eq'))}
        ${field('Value', input(`f${i}_val`, { value: f?.value || '' }))}
      </div>`;
    };
    return shell(rq, {
      title: 'Custom report builder',
      active: '/reports',
      crumbs: [['Reports', '/reports']],
      subtitle: 'Pick a dataset, choose columns, filter, group — then save, share, or schedule it.',
      wide: true,
      content: html`
        <form method="get" class="card"><div class="card-body">
          <div class="toolbar">
            ${field('Dataset', select('dataset', DATASETS.map((d): [string, string] => [d.key, d.name]), ds.key))}
            ${field('Group by (optional)', select('group', ds.cols.map((c): [string, string] => [c.key, c.label]), cfg.group || '', { blank: '(no grouping — row detail)' }))}
            ${field('Sort by', select('sort_col', cfg.cols.map((k): [string, string] => {
              const c = ds.cols.find((x) => x.key === k);
              return [k, c?.label || k];
            }), cfg.sort || '', { blank: '(default)' }))}
            ${field('Direction', select('dir', [['asc', 'Ascending'], ['desc', 'Descending']], cfg.dir || 'asc'))}
          </div>
          <div class="field"><label>Columns</label>
            <div style="display:flex;flex-wrap:wrap;gap:10px">${ds.cols.map((c) => checkbox('col', c.label, cfg.cols.includes(c.key), c.key))}</div>
          </div>
          ${filterRow(0)}${filterRow(1)}${filterRow(2)}
          <button class="btn">Run preview</button>
          <span class="muted small" style="margin-left:8px">${ds.describe}</span>
        </div></form>
        ${when(error, () => html`<div class="flash err">${error}</div>`)}
        ${when(rendered, () => card(html`Preview <span class="muted small">(${rendered!.rows.length} rows)</span>`, reportTable(rq, rendered!, {})))}
        ${card('Save this report', html`<form method="post" action="/reports/builder/save">
          <input type="hidden" name="config" value="${js(cfg)}" />
          <div class="toolbar">
            ${field('Name', input('name', { required: true, placeholder: 'e.g. Delinquent autopay-off residents' }))}
            ${field('Visibility', select('shared', [['0', 'Private to me'], ['1', 'Shared with the org']]))}
            ${field('Schedule', select('schedule', [['', 'Not scheduled'], ['daily', 'Daily'], ['weekly', 'Weekly (Mondays)'], ['monthly', 'Monthly (1st)']]))}
            <button class="btn">Save report</button>
          </div>
          <p class="small muted">Scheduled reports run on the day scheduler, export CSV, and land in the owner's Message Console as an attachment.</p>
        </form>`)}`,
    });
  });

  r.post('/reports/builder/save', requirePerm('reports:build'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const cfg = j<BuilderConfig>(String(rq.body.config || '{}'), { dataset: 'residents', cols: [], filters: [] });
    if (!dataset(cfg.dataset)) return redirect('/reports/builder', 'Unknown dataset', 'err');
    const schedule = String(rq.body.schedule || '') || null;
    if (schedule && !can(ctx, 'reports:schedule')) return redirect('/reports/builder', 'You can save but not schedule reports (reports:schedule).', 'err');
    const sid = id('svr');
    insert('saved_reports', {
      id: sid, org_id: ctx.orgId, owner_user_id: ctx.userId, name: String(rq.body.name || 'Untitled report').slice(0, 80),
      kind: 'custom', dataset: cfg.dataset, config: js(cfg), shared: rq.body.shared === '1' ? 1 : 0,
      schedule, last_run_date: null, created_at: nowIso(),
    });
    audit(ctx, 'saved_report', sid, 'create', null, { name: rq.body.name, schedule });
    return redirect(`/reports/saved/${sid}`, 'Report saved.');
  });

  // ---------- saved reports ----------
  r.get('/reports/saved/:id', requirePerm('reports:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const saved = q1<any>('SELECT * FROM saved_reports WHERE id=? AND org_id=?', rq.params.id, ctx.orgId);
    if (!saved || (!saved.shared && saved.owner_user_id !== ctx.userId && !can(ctx, 'admin:settings'))) return notFound('Report not found');
    const owner = q1<any>('SELECT name FROM users WHERE id=?', saved.owner_user_id);
    let rendered: RenderedReport;
    let editHref = '';
    if (saved.kind === 'custom') {
      const cfg = j<BuilderConfig>(saved.config, { dataset: saved.dataset, cols: [], filters: [] });
      rendered = processResult(runCustom(ctx, cfg), { sort: rq.query.get('sort') || cfg.sort || undefined, dir: rq.query.get('dir') || cfg.dir });
      const sp = new URLSearchParams();
      sp.set('dataset', cfg.dataset);
      cfg.cols.forEach((c) => sp.append('col', c));
      cfg.filters.forEach((f, i) => { sp.set(`f${i}_col`, f.col); sp.set(`f${i}_op`, f.op); sp.set(`f${i}_val`, f.value); });
      if (cfg.group) sp.set('group', cfg.group);
      editHref = `/reports/builder?${sp}`;
    } else {
      const def = reportDef(saved.dataset);
      if (!def) return notFound('The underlying report no longer exists');
      const params = resolveParams(ctx, def, new URLSearchParams(j<Record<string, string>>(saved.config, {})));
      rendered = processResult(def.run(ctx, params), { sort: rq.query.get('sort') || undefined, dir: rq.query.get('dir') || undefined, group: def.defaultGroup });
      editHref = `/reports/${def.key}?${new URLSearchParams(j<Record<string, string>>(saved.config, {}))}`;
    }
    const isOwner = saved.owner_user_id === ctx.userId;
    return shell(rq, {
      title: saved.name,
      active: '/reports',
      crumbs: [['Reports', '/reports'], ['Saved']],
      subtitle: html`${saved.kind === 'custom' ? `Custom · dataset: ${saved.dataset}` : `Saved view of ${reportDef(saved.dataset)?.name}`} · by ${owner?.name || '—'} · ${saved.shared ? 'shared' : 'private'}
        ${saved.schedule ? html` · <span class="badge info">${saved.schedule}</span> ${saved.last_run_date ? `last ran ${fmtDate(saved.last_run_date)}` : 'not yet run'}` : ''}`,
      actions: html`
        <a class="btn btn-ghost" href="${editHref}">Open in ${saved.kind === 'custom' ? 'builder' : 'report'}</a>
        ${when(isOwner || can(ctx, 'reports:schedule'), () => html`
          <form method="post" action="/reports/saved/${saved.id}/deliver" style="display:inline"><button class="btn btn-ghost">Run & deliver now</button></form>
          <form method="post" action="/reports/saved/${saved.id}/schedule" style="display:inline" class="toolbar">
            ${select('schedule', [['', 'Not scheduled'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly']], saved.schedule || '')}
            <button class="btn btn-sm">Set</button>
          </form>`)}
        ${when(isOwner, () => html`<form method="post" action="/reports/saved/${saved.id}/delete" style="display:inline">
          <button class="btn btn-ghost" data-confirm="Delete this saved report?">Delete</button>
        </form>`)}`,
      content: reportTable(rq, rendered, { sort: rq.query.get('sort') || undefined, dir: rq.query.get('dir') || undefined }),
    });
  });

  r.post('/reports/saved/:id/schedule', requirePerm('reports:build'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const saved = q1<any>('SELECT * FROM saved_reports WHERE id=? AND org_id=?', rq.params.id, ctx.orgId);
    if (!saved) return notFound('Report not found');
    const schedule = String(rq.body.schedule || '') || null;
    if (schedule && !can(ctx, 'reports:schedule')) return redirect(`/reports/saved/${saved.id}`, 'Scheduling needs reports:schedule.', 'err');
    run('UPDATE saved_reports SET schedule=? WHERE id=?', schedule, saved.id);
    audit(ctx, 'saved_report', saved.id, 'schedule', null, { schedule });
    return redirect(`/reports/saved/${saved.id}`, schedule ? `Scheduled ${schedule}.` : 'Schedule removed.');
  });

  r.post('/reports/saved/:id/deliver', requirePerm('reports:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const saved = q1<any>('SELECT * FROM saved_reports WHERE id=? AND org_id=?', rq.params.id, ctx.orgId);
    if (!saved) return notFound('Report not found');
    const fileId = deliverSavedReport(ctx, saved, ctx.businessDate);
    return redirect(`/reports/saved/${saved.id}`, `Delivered — the CSV is in the owner's Message Console (file /f/${fileId.slice(-6)}…).`);
  });

  r.post('/reports/saved/:id/delete', requirePerm('reports:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const saved = q1<any>('SELECT * FROM saved_reports WHERE id=? AND org_id=?', rq.params.id, ctx.orgId);
    if (!saved || saved.owner_user_id !== ctx.userId) return notFound('Report not found');
    run('DELETE FROM saved_reports WHERE id=?', saved.id);
    return redirect('/reports', 'Saved report deleted.');
  });

  // ---------- dashboards (M14.4) ----------
  r.get('/dashboards', requirePerm('dashboard:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const { layout, customized } = userLayout(ctx);
    const customize = rq.query.get('customize') === '1';
    const available = WIDGETS.filter((w) => !layout.includes(w.key));
    return shell(rq, {
      title: 'My dashboard',
      active: '/dashboards',
      subtitle: customized ? 'Your customized layout' : 'Role default layout — customize it to make it yours',
      actions: html`
        <a class="btn ${customize ? '' : 'btn-ghost'}" href="/dashboards${customize ? '' : '?customize=1'}">${customize ? 'Done customizing' : 'Customize'}</a>
        ${when(customized, () => html`<form method="post" action="/dashboards/reset" style="display:inline"><button class="btn btn-ghost">Reset to role default</button></form>`)}`,
      wide: true,
      content: html`
        ${when(customize, () => card('Add widgets', available.length ? html`<div style="display:flex;flex-wrap:wrap;gap:8px">
          ${available.map((w) => html`<form method="post" action="/dashboards/add" style="display:inline">
            <input type="hidden" name="widget" value="${w.key}" />
            <button class="btn btn-sm btn-ghost">+ ${w.name}</button>
          </form>`)}
        </div>` : html`<p class="muted">Every widget is already on your board.</p>`))}
        ${layout.length === 0 ? emptyState('Empty dashboard', 'Use Customize to add widgets from the library.') : null}
        ${join(layout.map((key, i) => {
          const w = widget(key);
          if (!w) return null;
          return html`<div style="position:relative">
            ${when(customize, () => html`<div style="position:absolute;right:8px;top:8px;z-index:5;display:flex;gap:4px">
              ${when(i > 0, () => html`<form method="post" action="/dashboards/move"><input type="hidden" name="widget" value="${key}" /><input type="hidden" name="dir" value="up" /><button class="btn btn-sm btn-ghost" title="Move up">↑</button></form>`)}
              ${when(i < layout.length - 1, () => html`<form method="post" action="/dashboards/move"><input type="hidden" name="widget" value="${key}" /><input type="hidden" name="dir" value="down" /><button class="btn btn-sm btn-ghost" title="Move down">↓</button></form>`)}
              <form method="post" action="/dashboards/remove"><input type="hidden" name="widget" value="${key}" /><button class="btn btn-sm btn-ghost" title="Remove">✕</button></form>
            </div>`)}
            ${w.render(ctx)}
          </div>`;
        }))}`,
    });
  });

  const mutateLayout = (rq: Rq, fn: (layout: string[], widgetKey: string) => string[]): ReturnType<typeof redirect> => {
    const ctx = rq.ctx as Ctx;
    const { layout } = userLayout(ctx);
    const wk = String(rq.body.widget || '');
    saveLayout(ctx, fn([...layout], wk));
    return redirect('/dashboards?customize=1');
  };
  r.post('/dashboards/add', requirePerm('dashboard:view'), (rq) => mutateLayout(rq, (l, w) => (widget(w) && !l.includes(w) ? [...l, w] : l)));
  r.post('/dashboards/remove', requirePerm('dashboard:view'), (rq) => mutateLayout(rq, (l, w) => l.filter((x) => x !== w)));
  r.post('/dashboards/move', requirePerm('dashboard:view'), (rq) => mutateLayout(rq, (l, w) => {
    const i = l.indexOf(w);
    const dir = String(rq.body.dir) === 'up' ? -1 : 1;
    if (i < 0 || i + dir < 0 || i + dir >= l.length) return l;
    [l[i], l[i + dir]] = [l[i + dir]!, l[i]!];
    return l;
  }));
  r.post('/dashboards/reset', requirePerm('dashboard:view'), (rq) => {
    resetLayout(rq.ctx as Ctx);
    return redirect('/dashboards', 'Back to your role default.');
  });

  // ---------- the generic report runner (keep LAST: /reports/:key) ----------
  r.get('/reports/:key', requirePerm('reports:view'), async (rq) => {
    const ctx = rq.ctx as Ctx;
    const def = reportDef(rq.params.key!);
    if (!def) return notFound('Report not found');
    if (def.perm && !can(ctx, def.perm)) return notFound('Report not found');
    const params = resolveParams(ctx, def, rq.query);
    const res = def.run(ctx, params);
    const sort = rq.query.get('sort') || def.defaultSort;
    const dir = rq.query.get('dir') || def.defaultDir;
    const group = rq.query.get('group') ?? def.defaultGroup;
    const rendered = processResult(res, { sort: sort || undefined, dir: dir || undefined, group: group || undefined });

    const format = rq.query.get('format');
    const paramLine = def.params.map((p) => `${p.label || p.key}: ${params[p.key]}`).join(' · ');
    if (format === 'csv') {
      return fileRes(new TextEncoder().encode(reportCsv(rendered)), 'text/csv', { filename: `${def.key}-${ctx.businessDate}.csv` });
    }
    if (format === 'pdf') {
      const orgName = q1<any>('SELECT name FROM orgs WHERE id=?', ctx.orgId)?.name || 'Oriel';
      const bytes = await reportPdf(def.name, orgName, paramLine, rendered);
      return fileRes(bytes, 'application/pdf', { filename: `${def.key}-${ctx.businessDate}.pdf`, inline: true });
    }

    const exportLink = (fmt: string): string => {
      const sp = new URLSearchParams(rq.query);
      sp.set('format', fmt);
      return `${rq.path}?${sp.toString()}`;
    };
    const groupable = res.cols.filter((c) => !c.kind || ['text', 'badge', 'month', 'date'].includes(c.kind));
    return shell(rq, {
      title: def.name,
      active: '/reports',
      crumbs: [['Reports', '/reports'], [def.category]],
      subtitle: def.describe,
      wide: rendered.cols.length > 7,
      actions: html`
        <a class="btn btn-ghost" href="${exportLink('csv')}">CSV</a>
        <a class="btn btn-ghost" href="${exportLink('pdf')}" target="_blank">PDF</a>
        ${when(can(ctx, 'reports:build'), () => html`<form method="post" action="/reports/${def.key}/save" style="display:inline">
          <input type="hidden" name="params" value="${js(params)}" />
          <button class="btn btn-ghost">Save this view</button>
        </form>`)}`,
      content: html`
        ${paramPanel(rq, ctx, def, params)}
        <div class="toolbar" style="margin-bottom:10px">
          <form method="get" data-autosubmit style="display:flex;gap:8px;align-items:end">
            ${def.params.map((p) => html`<input type="hidden" name="${p.key}" value="${params[p.key]}" />`)}
            ${field('Group by', select('group', groupable.map((c): [string, string] => [c.key, c.label]), group || '', { blank: '(no grouping)' }))}
          </form>
          <span class="muted small" style="align-self:end;padding-bottom:10px">${rendered.rows.length} rows · click a column to sort · click a row to drill through</span>
        </div>
        ${reportTable(rq, rendered, { sort: sort || undefined, dir: dir || undefined })}`,
    });
  });

  r.post('/reports/:key/save', requirePerm('reports:build'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const def = reportDef(rq.params.key!);
    if (!def) return notFound('Report not found');
    const sid = id('svr');
    insert('saved_reports', {
      id: sid, org_id: ctx.orgId, owner_user_id: ctx.userId,
      name: `${def.name} (my view)`, kind: 'canned', dataset: def.key,
      config: String(rq.body.params || '{}'), shared: 0, schedule: null, last_run_date: null, created_at: nowIso(),
    });
    audit(ctx, 'saved_report', sid, 'create', null, { report: def.key });
    return redirect(`/reports/saved/${sid}`, 'View saved — name, share or schedule it from here.');
  });
}
