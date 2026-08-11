import { env } from './env.ts';

/** Tiny leveled logger — node built-ins only, zero deps.
 *
 * Level is read from LOG_LEVEL (debug|info|warn|error, default info). Output is
 * a pretty single-line record in dev; one JSON object per line when
 * MODE=production, so a log aggregator can parse it. warn/error go to stderr,
 * debug/info to stdout. `error(msg, err?, fields?)` always records err.message
 * and attaches the stack outside production (and always at error level, since
 * errors matter enough to keep the trace). */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function isProd(): boolean {
  return env('MODE') === 'production';
}

function minWeight(): number {
  const configured = (env('LOG_LEVEL') || 'info').toLowerCase();
  return WEIGHT[configured as LogLevel] ?? WEIGHT.info;
}

/** render a fields bag as `k=v k=v` for the dev pretty format */
function fmtFields(rec: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(rec)) {
    parts.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  return parts.join(' ');
}

function write(level: LogLevel, msg: string, err?: unknown, fields?: Record<string, unknown>): void {
  if (WEIGHT[level] < minWeight()) return;
  const rec: Record<string, unknown> = { ...(fields || {}) };
  let stack: string | undefined;
  if (err !== undefined && err !== null) {
    const e: Error = err instanceof Error ? err : new Error(String(err));
    rec.err = e.message; // err.message always
    // stack outside production, or always at error level
    if ((!isProd() || level === 'error') && e.stack) stack = e.stack;
  }
  const sink = level === 'warn' || level === 'error' ? console.error : console.log;
  if (isProd()) {
    sink(JSON.stringify({ level, time: new Date().toISOString(), msg, ...rec, ...(stack ? { stack } : {}) }));
  } else {
    const extras = Object.keys(rec).length ? '  ' + fmtFields(rec) : '';
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${extras}`;
    sink(stack ? `${line}\n${stack}` : line);
  }
}

export const log = {
  debug(msg: string, fields?: Record<string, unknown>): void {
    write('debug', msg, undefined, fields);
  },
  info(msg: string, fields?: Record<string, unknown>): void {
    write('info', msg, undefined, fields);
  },
  warn(msg: string, fields?: Record<string, unknown>): void {
    write('warn', msg, undefined, fields);
  },
  error(msg: string, err?: unknown, fields?: Record<string, unknown>): void {
    write('error', msg, err, fields);
  },
};
