import { q, q1, run, insert, tx } from './db.ts';
import { id } from './ids.ts';
import { nowIso, addDays, assertDate } from './dates.ts';
import { sysCtx, type Ctx } from './auth.ts';
import { emit, deliverWebhooks } from './events.ts';

/** Jobs & scheduling (§3.1): a jobs registry + in-process scheduler. All
 * recurring behavior is driven by the simulated business date — every job
 * runs once per business day and decides internally whether it has work
 * (idempotent by design). A light wall-clock poller re-runs the current
 * day's jobs so long-running sessions stay fresh. */

export interface JobDef {
  key: string;
  name: string;
  describe: string;
  run: (ctx: Ctx, date: string) => string | void; // returns summary
}

const registry = new Map<string, JobDef>();

export function registerJob(def: JobDef): void {
  registry.set(def.key, def);
}

export function jobDefs(): JobDef[] {
  return [...registry.values()];
}

export function ensureJobRows(orgId: string): void {
  for (const def of registry.values()) {
    const existing = q1('SELECT id FROM jobs WHERE org_id=? AND key=?', orgId, def.key);
    if (!existing) {
      insert('jobs', {
        id: id('job'),
        org_id: orgId,
        key: def.key,
        name: def.name,
        describe: def.describe,
        enabled: 1,
        last_run_date: null,
        last_status: null,
        last_ms: null,
        last_error: null,
      });
    }
  }
}

export function runJob(ctx: Ctx, key: string, date: string): { status: string; summary: string; ms: number } {
  const def = registry.get(key);
  if (!def) return { status: 'missing', summary: `no job ${key}`, ms: 0 };
  const start = Date.now();
  let status = 'ok';
  let summary = '';
  try {
    summary = def.run(ctx, date) || '';
  } catch (e) {
    status = 'error';
    summary = (e as Error).message;
    console.error(`[job ${key}] ${date}:`, (e as Error).stack);
  }
  const ms = Date.now() - start;
  run(
    'UPDATE jobs SET last_run_date=?, last_status=?, last_ms=?, last_error=? WHERE org_id=? AND key=?',
    date,
    status,
    ms,
    status === 'error' ? summary : null,
    ctx.orgId,
    key,
  );
  insert('job_runs', {
    id: id('jrn'),
    org_id: ctx.orgId,
    job_key: key,
    date,
    status,
    summary: summary.slice(0, 500),
    ms,
    at: nowIso(),
  });
  return { status, summary, ms };
}

export function runJobsForDay(orgId: string, date: string): void {
  ensureJobRows(orgId);
  const enabled = q<{ key: string }>('SELECT key FROM jobs WHERE org_id=? AND enabled=1', orgId);
  const ctx = sysCtx(orgId, date);
  for (const row of enabled) {
    if (registry.has(row.key)) runJob(ctx, row.key, date);
  }
}

/** Advance the simulated business date day by day, running the scheduler for
 * each day. This is the Simulator Console's time machine. */
export function advanceBusinessDate(orgId: string, toDate: string): { days: number } {
  assertDate(toDate);
  const org = q1<{ business_date: string }>('SELECT business_date FROM orgs WHERE id=?', orgId);
  if (!org) throw new Error('org not found');
  let current = org.business_date;
  if (toDate <= current) throw new Error(`target ${toDate} must be after current business date ${current}`);
  let days = 0;
  while (current < toDate) {
    current = addDays(current, 1);
    days++;
    if (days > 400) throw new Error('refusing to advance more than 400 days at once');
    run('UPDATE orgs SET business_date=? WHERE id=?', current, orgId);
    runJobsForDay(orgId, current);
    const ctx = sysCtx(orgId, current);
    emit(ctx, 'business_date.advanced', 'org', orgId, { date: current });
  }
  return { days };
}

/** wall-clock poller: re-run today's jobs periodically (idempotent) + webhooks */
export function startPoller(intervalMs = 60000): { stop: () => void } {
  const t = setInterval(() => {
    try {
      const orgs = q<{ id: string; business_date: string }>('SELECT id, business_date FROM orgs');
      for (const org of orgs) {
        runJobsForDay(org.id, org.business_date);
        void deliverWebhooks(sysCtx(org.id));
      }
    } catch (e) {
      console.error('[poller]', (e as Error).message);
    }
  }, intervalMs);
  return { stop: () => clearInterval(t as unknown as number) };
}
