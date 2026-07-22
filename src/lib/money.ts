/** All money is integer cents, USD. No floats ever cross a service boundary. */

export type Cents = number;

export function usd(cents: Cents, opts?: { paren?: boolean; zero?: string }): string {
  if (!Number.isInteger(cents)) throw new Error(`non-integer cents: ${cents}`);
  if (cents === 0 && opts?.zero !== undefined) return opts.zero;
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = String(abs % 100).padStart(2, '0');
  const grouped = dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const s = `$${grouped}.${rem}`;
  if (!neg) return s;
  return opts?.paren ? `(${s})` : `-${s}`;
}

/** "1,234.56" | "$1,234.56" | "1234" -> cents. Throws on garbage. */
export function parseUsd(input: string): Cents {
  const s = input.replace(/[$,\s]/g, '');
  if (!/^-?\d*(\.\d{1,2})?$/.test(s) || s === '' || s === '-') {
    throw new Error(`invalid amount: ${input}`);
  }
  const neg = s.startsWith('-');
  const [d = '0', c = ''] = s.replace('-', '').split('.');
  const cents = parseInt(d || '0', 10) * 100 + parseInt((c + '00').slice(0, 2) || '0', 10);
  return neg ? -cents : cents;
}

export function sumCents(list: (Cents | null | undefined)[]): Cents {
  let t = 0;
  for (const v of list) t += v ?? 0;
  return t;
}

/** rounds half-up at the cent */
export function pctOf(cents: Cents, pctBps: number): Cents {
  // pctBps in basis points: 5% => 500
  return Math.round((cents * pctBps) / 10000);
}

/** Split `total` into n parts differing by at most 1 cent, sum preserved. */
export function splitCents(total: Cents, n: number): Cents[] {
  const base = Math.floor(total / n);
  const rem = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
}
