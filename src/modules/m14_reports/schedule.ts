import { q, q1, run, j } from '../../lib/db.ts';
import { registerJob } from '../../lib/jobs.ts';
import { putFile } from '../../lib/files.ts';
import { sendEmail } from '../../lib/sim/messaging.ts';
import type { Ctx } from '../../lib/auth.ts';
import { reportDef, resolveParams, processResult, reportCsv } from './engine.ts';
import { runCustom, type BuilderConfig } from './builder.ts';

/** M14.3 scheduled reports: saved reports with a cadence run on the day
 * scheduler, export to CSV, and deliver into the Message Console as an
 * attachment link — deterministic, no real email. */

function cadenceDue(schedule: string, date: string): boolean {
  if (schedule === 'daily') return true;
  const dow = new Date(Date.parse(date)).getUTCDay();
  if (schedule === 'weekly') return dow === 1; // Mondays
  if (schedule === 'monthly') return date.endsWith('-01');
  return false;
}

export function runSavedReport(ctx: Ctx, saved: any): { csv: string; rows: number; name: string } {
  if (saved.kind === 'custom') {
    const cfg = j<BuilderConfig>(saved.config, { dataset: saved.dataset, cols: [], filters: [] });
    const res = runCustom(ctx, cfg);
    const rendered = processResult(res, { sort: cfg.sort || undefined, dir: cfg.dir });
    return { csv: reportCsv(rendered), rows: res.rows.length, name: saved.name };
  }
  const def = reportDef(saved.dataset);
  if (!def) throw new Error(`saved report references unknown report ${saved.dataset}`);
  const cfg = j<Record<string, string>>(saved.config, {});
  const params = resolveParams(ctx, def, new URLSearchParams(cfg));
  const res = def.run(ctx, params);
  const rendered = processResult(res, { sort: cfg.sort, dir: cfg.dir, group: cfg.group || def.defaultGroup });
  return { csv: reportCsv(rendered), rows: res.rows.length, name: saved.name };
}

export function deliverSavedReport(ctx: Ctx, saved: any, date: string): string {
  const { csv, rows, name } = runSavedReport(ctx, saved);
  const owner = q1<any>('SELECT * FROM users WHERE id=?', saved.owner_user_id);
  const file = putFile(ctx, new TextEncoder().encode(csv), {
    name: `${name.replaceAll(/[^a-z0-9]+/gi, '-').toLowerCase()}-${date}.csv`,
    mime: 'text/csv',
    entity: 'saved_report',
    entityId: saved.id,
    visibility: 'staff',
    ownerUserId: saved.owner_user_id,
  });
  if (owner?.email) {
    sendEmail(ctx, {
      to: owner.email,
      toName: owner.name,
      toUserId: owner.id,
      subject: `Scheduled report: ${name} — ${date}`,
      body: `<p>Your ${saved.schedule} report <b>${name}</b> ran for ${date} with <b>${rows}</b> rows.</p>
        <p>📎 Attachment: <a href="/f/${file.id}">${file.name}</a></p>
        <p>Manage or edit this report under <a href="/reports/saved/${saved.id}">Reports → Saved</a>.</p>`,
      templateKey: 'scheduled_report',
      entity: 'saved_report',
      entityId: saved.id,
    });
  }
  run('UPDATE saved_reports SET last_run_date=? WHERE id=?', date, saved.id);
  return file.id;
}

registerJob({
  key: 'report_delivery',
  name: 'Scheduled report delivery',
  describe: 'Runs saved reports on their cadence (daily/weekly Mondays/monthly 1sts), exports CSV, and delivers the attachment to the owner via the Message Console.',
  run: (ctx, date) => {
    const due = q<any>(
      `SELECT * FROM saved_reports WHERE org_id=? AND schedule IS NOT NULL AND (last_run_date IS NULL OR last_run_date < ?)`,
      ctx.orgId, date,
    ).filter((s) => cadenceDue(s.schedule, date));
    let delivered = 0;
    for (const saved of due) {
      try {
        deliverSavedReport(ctx, saved, date);
        delivered++;
      } catch {
        run('UPDATE saved_reports SET last_run_date=? WHERE id=?', date, saved.id); // never wedge the queue
      }
    }
    return delivered ? `${delivered} report${delivered === 1 ? '' : 's'} delivered` : 'nothing scheduled today';
  },
});
