import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join as pjoin } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './env.ts';

/**
 * Database layer on node:sqlite (synchronous, in-process).
 * Schema lives in src/db/schema.sql, written in Postgres-compatible SQL
 * (TEXT/INTEGER types, no SQLite-only features beyond the file itself);
 * docs/production-port.md documents the one-line switch to Postgres.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = pjoin(HERE, '..', '..');

let _db: DatabaseSync | null = null;
const stmtCache = new Map<string, StatementSync>();

export function dbPath(): string {
  return pjoin(ROOT, env('DB') || 'data/stayleased.db');
}

export function db(): DatabaseSync {
  if (_db) return _db;
  const p = dbPath();
  mkdirSync(dirname(p), { recursive: true });
  _db = new DatabaseSync(p);
  _db.exec('PRAGMA journal_mode=WAL');
  _db.exec('PRAGMA foreign_keys=ON');
  _db.exec('PRAGMA busy_timeout=5000');
  const schemaPath = pjoin(ROOT, 'src', 'db', 'schema.sql');
  if (existsSync(schemaPath)) {
    _db.exec(readFileSync(schemaPath, 'utf8'));
  }
  // additive column migrations (schema.sql is append-only CREATE TABLEs;
  // SQLite has no ADD COLUMN IF NOT EXISTS, so each runs once and then no-ops)
  const MIGRATIONS = [
    "ALTER TABLE vendor_invoices ADD COLUMN po_id TEXT", // Phase 12: 2/3-way match
    "ALTER TABLE vendor_invoices ADD COLUMN discount_cents INTEGER NOT NULL DEFAULT 0", // early-pay terms
    "ALTER TABLE vendor_invoices ADD COLUMN discount_by TEXT", // pay-by date to capture it
    "ALTER TABLE vendors ADD COLUMN terms TEXT", // e.g. '2/10 net 30'
    "ALTER TABLE units ADD COLUMN program TEXT", // Phase 17: affordable set-aside (lihtc|section8)
    "ALTER TABLE units ADD COLUMN ami_pct INTEGER", // set-aside band (50/60/80)
    "ALTER TABLE units ADD COLUMN utility_allowance_cents INTEGER NOT NULL DEFAULT 0", // reduces tenant rent portion
    "ALTER TABLE units ADD COLUMN home_serial TEXT", // Phase 17: manufactured housing title/serial
    "ALTER TABLE units ADD COLUMN resident_owned INTEGER NOT NULL DEFAULT 0", // manufactured: resident-owned home on our lot
  ];
  for (const m of MIGRATIONS) {
    try {
      _db.exec(m);
    } catch {
      /* column already exists */
    }
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    try {
      _db.close();
    } catch {
      /* already closed */
    }
    _db = null;
    stmtCache.clear();
  }
}

function stmt(sql: string): StatementSync {
  let s = stmtCache.get(sql);
  if (!s) {
    s = db().prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

type Row = Record<string, any>;

/** SELECT many */
export function q<T = Row>(sql: string, ...params: unknown[]): T[] {
  return stmt(sql).all(...params) as T[];
}

/** SELECT one */
export function q1<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  return stmt(sql).get(...params) as T | undefined;
}

/** INSERT/UPDATE/DELETE */
export function run(sql: string, ...params: unknown[]): { changes: number } {
  const r = stmt(sql).run(...params);
  return { changes: Number(r.changes) };
}

/** scalar helper */
export function val<T = number>(sql: string, ...params: unknown[]): T {
  const row = q1<Row>(sql, ...params);
  if (!row) return undefined as unknown as T;
  const k = Object.keys(row)[0]!;
  return row[k] as T;
}

let txDepth = 0;

/** transaction with savepoint nesting */
export function tx<T>(fn: () => T): T {
  const d = db();
  if (txDepth === 0) d.exec('BEGIN IMMEDIATE');
  else d.exec(`SAVEPOINT sp${txDepth}`);
  txDepth++;
  try {
    const out = fn();
    txDepth--;
    if (txDepth === 0) d.exec('COMMIT');
    else d.exec(`RELEASE sp${txDepth}`);
    return out;
  } catch (e) {
    txDepth--;
    if (txDepth === 0) d.exec('ROLLBACK');
    else d.exec(`ROLLBACK TO sp${txDepth}; RELEASE sp${txDepth}`);
    throw e;
  }
}

/** generic insert from object (column names must be trusted code, never user input) */
export function insert(table: string, row: Record<string, unknown>): void {
  const keys = Object.keys(row);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  run(sql, ...keys.map((k) => normalize(row[k])));
}

export function update(table: string, id: string, patch: Record<string, unknown>): void {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`;
  run(sql, ...keys.map((k) => normalize(patch[k])), id);
}

function normalize(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

/** JSON column helpers */
export function j<T = any>(text: unknown, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(String(text)) as T;
  } catch {
    return fallback;
  }
}
export function js(v: unknown): string {
  return JSON.stringify(v ?? null);
}
