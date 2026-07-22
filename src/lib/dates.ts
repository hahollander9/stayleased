/**
 * Business dates are plain `YYYY-MM-DD` strings. Timestamps are ISO-8601 UTC.
 * Every property carries an IANA timezone used for *display* and for
 * property-local business rules; the simulated business date (per org) is the
 * operative date for all scheduled behavior.
 */

export type DateStr = string; // YYYY-MM-DD

const DAY_MS = 86400000;

export function assertDate(d: string): DateStr {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`bad date: ${d}`);
  return d;
}

export function toUtc(d: DateStr): Date {
  return new Date(d + 'T00:00:00Z');
}

export function fromUtc(dt: Date): DateStr {
  return dt.toISOString().slice(0, 10);
}

export function addDays(d: DateStr, n: number): DateStr {
  return fromUtc(new Date(toUtc(d).getTime() + n * DAY_MS));
}

export function diffDays(a: DateStr, b: DateStr): number {
  return Math.round((toUtc(a).getTime() - toUtc(b).getTime()) / DAY_MS);
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

export function parts(d: DateStr): { y: number; m: number; day: number } {
  return { y: +d.slice(0, 4), m: +d.slice(5, 7), day: +d.slice(8, 10) };
}

export function mkDate(y: number, m1: number, day: number): DateStr {
  const dim = daysInMonth(y, m1);
  const dd = Math.min(day, dim);
  return `${String(y).padStart(4, '0')}-${String(m1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/** month arithmetic with end-of-month clamping */
export function addMonths(d: DateStr, n: number): DateStr {
  const { y, m, day } = parts(d);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return mkDate(ny, nm, day);
}

export function firstOfMonth(d: DateStr): DateStr {
  return d.slice(0, 8) + '01';
}

export function lastOfMonth(d: DateStr): DateStr {
  const { y, m } = parts(d);
  return mkDate(y, m, daysInMonth(y, m));
}

export function monthKey(d: DateStr): string {
  return d.slice(0, 7); // YYYY-MM
}

export function cmp(a: DateStr, b: DateStr): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function maxDate(a: DateStr, b: DateStr): DateStr {
  return a > b ? a : b;
}
export function minDate(a: DateStr, b: DateStr): DateStr {
  return a < b ? a : b;
}

export function nowIso(): string {
  return new Date().toISOString();
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Mar 4, 2026" */
export function fmtDate(d: DateStr | null | undefined): string {
  if (!d) return '—';
  const { y, m, day } = parts(d.slice(0, 10));
  return `${MONTHS[m - 1]} ${day}, ${y}`;
}

/** "Tue, Mar 4" */
export function fmtDateShort(d: DateStr | null | undefined): string {
  if (!d) return '—';
  const dt = toUtc(d.slice(0, 10));
  return `${DOW[dt.getUTCDay()]}, ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
}

/** "Mar 2026" from a YYYY-MM or date */
export function fmtMonth(mk: string): string {
  const m = +mk.slice(5, 7);
  return `${MONTHS[m - 1]} ${mk.slice(0, 4)}`;
}

/** timestamp display in a given IANA tz */
export function fmtTs(iso: string | null | undefined, tz = 'America/Denver'): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function dowName(d: DateStr): string {
  return DOW[toUtc(d).getUTCDay()]!;
}
export function dowIdx(d: DateStr): number {
  return toUtc(d).getUTCDay();
}
