import { html } from '../../lib/html.ts';
import { fileRes, type Router, type Rq } from '../../lib/http.ts';
import { requirePerm, type Ctx } from '../../lib/auth.ts';
import { q, q1 } from '../../lib/db.ts';
import { toCsv } from '../../lib/csv.ts';
import { writeZip } from '../../lib/zip.ts';
import { audit } from '../../lib/audit.ts';
import { shell, card, tbl, registerNav } from '../../ui/ui.ts';

/** Everything an organization has put into StayLeased, as files it can open
 * anywhere.
 *
 * The product said "export anything, any time" and linked to the reports page.
 * Reports do export — but a report is our view of the records, not the records:
 * there was no way to leave with the residents, leases, charges, payments and
 * journal lines themselves. This is that way out, and it is deliberately dumb:
 * one CSV per table, every row this organization owns, column names as stored.
 * A format that needs our software to read it would not be an export.
 *
 * Left out, on purpose: sign-in secrets (password hashes, sessions, API keys,
 * webhook signing secrets) and uploaded file contents — the `files` sheet lists
 * every document with its name and size, and each one downloads from the
 * record it is attached to. */

registerNav('Admin', { href: '/admin/export', label: 'Export your data', perm: 'admin:settings' });

/** Tables that hold credentials rather than records. */
const NEVER = new Set(['sessions', 'api_keys', 'webhook_endpoints', 'webhook_deliveries', 'stripe_events']);
/** Columns that are secrets, or bulk bytes, wherever they appear. */
const DROP = /^(password_hash|secret|token_hash|invite_token|sign_token|token|data|blob|content_b64)$/;

interface Sheet { table: string; columns: string[]; rows: number }

function orgTables(): { table: string; columns: string[] }[] {
  const tables = q<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).map((t) => t.name);
  const out: { table: string; columns: string[] }[] = [];
  for (const t of tables) {
    if (NEVER.has(t) || !/^[a-z0-9_]+$/.test(t)) continue;
    const cols = q<{ name: string }>(`PRAGMA table_info(${t})`).map((c) => c.name);
    if (!cols.includes('org_id')) continue;
    out.push({ table: t, columns: cols.filter((c) => !DROP.test(c)) });
  }
  return out;
}

export function exportSheets(ctx: Ctx): Sheet[] {
  return orgTables().map(({ table, columns }) => ({
    table, columns,
    rows: q1<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id=?`, ctx.orgId)?.n || 0,
  }));
}

export function exportZip(ctx: Ctx): Buffer {
  const org = q1<{ name: string; slug: string }>('SELECT name, slug FROM orgs WHERE id=?', ctx.orgId);
  const files: { name: string; data: string }[] = [];
  const index: (string | number)[][] = [];
  for (const { table, columns } of orgTables()) {
    const rows = q<Record<string, unknown>>(`SELECT ${columns.map((c) => `"${c}"`).join(', ')} FROM ${table} WHERE org_id=?`, ctx.orgId);
    if (!rows.length) continue;
    files.push({
      name: `${table}.csv`,
      data: toCsv(columns, rows.map((r) => columns.map((c) => {
        const v = r[c];
        return v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : (v as string | number);
      }))),
    });
    index.push([`${table}.csv`, rows.length, columns.join(' ')]);
  }
  files.unshift({
    name: 'README.txt',
    data: [
      `${org?.name || 'Organization'} — full data export from StayLeased`,
      `Made ${new Date().toISOString()} · business date ${ctx.businessDate}`,
      '',
      'One CSV per table, every row this organization owns, columns as stored.',
      'Money columns ending in _cents are whole cents (150000 = $1,500.00).',
      'Dates are YYYY-MM-DD; timestamps are ISO 8601, UTC.',
      'Not included: sign-in secrets, and the contents of uploaded documents',
      '(files.csv lists each one; download it from the record it belongs to).',
      '',
      ...index.map((r) => `${String(r[0]).padEnd(34)} ${String(r[1]).padStart(7)} rows`),
    ].join('\n'),
  });
  return writeZip(files);
}

export function routes(r: Router): void {
  r.get('/admin/export', requirePerm('admin:settings'), (rq: Rq) => {
    const ctx = rq.ctx as Ctx;
    const sheets = exportSheets(ctx).filter((s) => s.rows > 0);
    const total = sheets.reduce((n, s) => n + s.rows, 0);
    return shell(rq, {
      title: 'Export your data',
      active: '/admin/export',
      subtitle: 'Every record this organization has in StayLeased, as spreadsheet files that open anywhere. Available at any time, on any plan.',
      actions: sheets.length ? html`<a class="btn" href="/admin/export.zip">Download everything (.zip)</a>` : null,
      content: html`
        ${card('What is in the download', sheets.length
          ? html`${tbl(
              [{ label: 'File' }, { label: 'Rows', num: true }],
              sheets.map((s) => ({ cells: [html`<span class="mono">${s.table}.csv</span>`, s.rows.toLocaleString('en-US')] })),
              { foot: ['All files', total.toLocaleString('en-US')] },
            )}`
          : html`<p class="muted" style="margin:0">Nothing to export yet. Once buildings, residents and transactions exist, they appear here.</p>`, { flush: sheets.length > 0 })}
        <p class="small muted">One file per kind of record, with a README that explains the columns. Sign-in secrets are never included.
          Uploaded documents are listed in <span class="mono">files.csv</span> and download from the record they belong to.
          Each download is written to the audit log.</p>`,
    });
  });

  r.get('/admin/export.zip', requirePerm('admin:settings'), (rq: Rq) => {
    const ctx = rq.ctx as Ctx;
    const zip = exportZip(ctx);
    const slug = q1<{ slug: string }>('SELECT slug FROM orgs WHERE id=?', ctx.orgId)?.slug || 'organization';
    audit(ctx, 'org', ctx.orgId, 'export', null, { bytes: zip.length });
    const out = fileRes(zip, 'application/zip', { filename: `stayleased-${slug}-${ctx.businessDate}.zip` });
    out.headers['cache-control'] = 'no-store';
    return out;
  });
}
