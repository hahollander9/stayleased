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

/** Jobs that FABRICATE world activity (inbound leads, bank transactions,
 * meter reads + provider invoices). They exist so the demo org feels alive.
 * Live customer orgs must never run them — a real company's books cannot
 * grow simulated data. Real integrations will replace them per rail. */
export const SIM_ONLY_JOBS = new Set(['ils_leads', 'bank_feed', 'utility_cycle']);

export function orgKind(orgId: string): 'demo' | 'live' {
  return (q1<{ kind: string }>('SELECT kind FROM orgs WHERE id=?', orgId)?.kind as 'demo' | 'live') || 'demo';
}

export function ensureJobRows(orgId: string): void {
  const live = orgKind(orgId) === 'live';
  for (const def of registry.values()) {
    const existing = q1('SELECT id FROM jobs WHERE org_id=? AND key=?', orgId, def.key);
    if (!existing) {
      insert('jobs', {
        id: id('job'),
        org_id: orgId,
        key: def.key,
        name: def.name,
        describe: def.describe,
        enabled: live && SIM_ONLY_JOBS.has(def.key) ? 0 : 1,
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
  const live = orgKind(orgId) === 'live';
  const enabled = q<{ key: string }>('SELECT key FROM jobs WHERE org_id=? AND enabled=1', orgId);
  const ctx = sysCtx(orgId, date);
  for (const row of enabled) {
    if (live && SIM_ONLY_JOBS.has(row.key)) continue; // belt-and-braces: never fabricate data in a live org
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

/** "Today" for live orgs. Anchored to UTC-8 (the most conservative US zone)
 * so the business day never rolls before local midnight anywhere in the US:
 * rent posts in the small hours of the 1st everywhere rather than the
 * evening of the 31st on the coasts. Per-org timezones can refine this later. */
export function liveToday(): string {
  return new Date(Date.now() - 8 * 3600_000).toISOString().slice(0, 10);
}

/** Live orgs run on the real calendar: whenever the wall clock has moved past
 * an org's business date, advance it day by day through the normal scheduler
 * (rent posting, late fees, lease rollover, ...). Demo orgs keep their
 * simulator time machine and are untouched here. */
export function syncLiveOrgClocks(): number {
  const today = liveToday();
  let advanced = 0;
  for (const org of q<{ id: string; business_date: string }>(`SELECT id, business_date FROM orgs WHERE kind='live'`)) {
    if (org.business_date < today) {
      try {
        advanceBusinessDate(org.id, today);
        advanced++;
      } catch (e) {
        console.error(`[clock] org ${org.id}:`, (e as Error).message);
      }
    }
  }
  return advanced;
}

/** wall-clock poller: keep live-org clocks current, re-run today's jobs
 * periodically (idempotent), and deliver webhooks */
export function startPoller(intervalMs = 60000): { stop: () => void } {
  const t = setInterval(() => {
    try {
      syncLiveOrgClocks();
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
