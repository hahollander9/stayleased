/** Mini validation library (Zod-shaped, environment fallback per DECISIONS.md).
 * Schemas validate + coerce form/API input at every boundary. */

export class VError extends Error {
  issues: { path: string; message: string }[];
  constructor(issues: { path: string; message: string }[]) {
    super(issues.map((i) => `${i.path}: ${i.message}`).join('; '));
    this.issues = issues;
  }
}

type Result<T> = { ok: true; value: T } | { ok: false; issues: { path: string; message: string }[] };

export interface Schema<T> {
  parse(input: unknown, path?: string): T;
  safe(input: unknown): Result<T>;
  optional(): Schema<T | undefined>;
  nullable(): Schema<T | null>;
  default(v: T): Schema<T>;
}

function mk<T>(fn: (input: unknown, path: string) => T): Schema<T> {
  const s: Schema<T> = {
    parse(input, path = 'value') {
      return fn(input, path);
    },
    safe(input) {
      try {
        return { ok: true, value: fn(input, 'value') };
      } catch (e) {
        if (e instanceof VError) return { ok: false, issues: e.issues };
        return { ok: false, issues: [{ path: 'value', message: String((e as Error).message) }] };
      }
    },
    optional() {
      return mk((input, path) =>
        input === undefined || input === null || input === '' ? (undefined as any) : fn(input, path),
      );
    },
    nullable() {
      return mk((input, path) =>
        input === undefined || input === null || input === '' ? (null as any) : fn(input, path),
      );
    },
    default(v) {
      return mk((input, path) =>
        input === undefined || input === null || input === '' ? v : fn(input, path),
      );
    },
  };
  return s;
}

const fail = (path: string, message: string): never => {
  throw new VError([{ path, message }]);
};

export const v = {
  string(opts?: { min?: number; max?: number; pattern?: RegExp; trim?: boolean }) {
    return mk<string>((input, path) => {
      if (typeof input !== 'string') fail(path, 'must be text');
      let s = String(input);
      if (opts?.trim !== false) s = s.trim();
      if (opts?.min !== undefined && s.length < opts.min) fail(path, `min length ${opts.min}`);
      if (opts?.max !== undefined && s.length > opts.max) fail(path, `max length ${opts.max}`);
      if (opts?.pattern && !opts.pattern.test(s)) fail(path, 'invalid format');
      return s;
    });
  },
  email() {
    return mk<string>((input, path) => {
      const s = String(input ?? '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) fail(path, 'invalid email');
      return s;
    });
  },
  phone() {
    return mk<string>((input, path) => {
      const digits = String(input ?? '').replace(/\D/g, '');
      if (digits.length < 10 || digits.length > 11) fail(path, 'invalid phone');
      const d = digits.length === 11 ? digits.slice(1) : digits;
      return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
    });
  },
  int(opts?: { min?: number; max?: number }) {
    return mk<number>((input, path) => {
      const n = typeof input === 'number' ? input : parseInt(String(input), 10);
      if (!Number.isInteger(n)) fail(path, 'must be a whole number');
      if (opts?.min !== undefined && n < opts.min) fail(path, `min ${opts.min}`);
      if (opts?.max !== undefined && n > opts.max) fail(path, `max ${opts.max}`);
      return n;
    });
  },
  /** money input -> integer cents */
  cents(opts?: { min?: number; max?: number }) {
    return mk<number>((input, path) => {
      let n: number;
      if (typeof input === 'number') n = Math.round(input);
      else {
        const s = String(input).replace(/[$,\s]/g, '');
        if (!/^-?\d*(\.\d{1,2})?$/.test(s) || s === '' || s === '-') fail(path, 'invalid amount');
        n = Math.round(parseFloat(s) * 100);
      }
      if (opts?.min !== undefined && n < opts.min) fail(path, `min ${opts.min / 100}`);
      if (opts?.max !== undefined && n > opts.max) fail(path, `max ${opts.max / 100}`);
      return n;
    });
  },
  number(opts?: { min?: number; max?: number }) {
    return mk<number>((input, path) => {
      const n = typeof input === 'number' ? input : parseFloat(String(input));
      if (!Number.isFinite(n)) fail(path, 'must be a number');
      if (opts?.min !== undefined && n < opts.min) fail(path, `min ${opts.min}`);
      if (opts?.max !== undefined && n > opts.max) fail(path, `max ${opts.max}`);
      return n;
    });
  },
  date() {
    return mk<string>((input, path) => {
      const s = String(input ?? '').trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) fail(path, 'invalid date');
      return s;
    });
  },
  bool() {
    return mk<boolean>((input) => input === true || input === 'true' || input === 'on' || input === '1' || input === 1);
  },
  oneOf<T extends string>(...vals: T[]) {
    return mk<T>((input, path) => {
      const s = String(input ?? '');
      if (!vals.includes(s as T)) fail(path, `must be one of: ${vals.join(', ')}`);
      return s as T;
    });
  },
  object<S extends Record<string, Schema<any>>>(shape: S) {
    return mk<{ [K in keyof S]: S[K] extends Schema<infer U> ? U : never }>((input, path) => {
      if (typeof input !== 'object' || input === null) fail(path, 'must be an object');
      const obj = input as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const issues: { path: string; message: string }[] = [];
      for (const key of Object.keys(shape)) {
        try {
          out[key] = shape[key]!.parse(obj[key], key);
        } catch (e) {
          if (e instanceof VError) issues.push(...e.issues);
          else issues.push({ path: key, message: String((e as Error).message) });
        }
      }
      if (issues.length) throw new VError(issues);
      return out as any;
    });
  },
  array<T>(inner: Schema<T>, opts?: { min?: number; max?: number }) {
    return mk<T[]>((input, path) => {
      const arr = Array.isArray(input) ? input : input === undefined || input === null ? [] : [input];
      if (opts?.min !== undefined && arr.length < opts.min) fail(path, `at least ${opts.min} required`);
      if (opts?.max !== undefined && arr.length > opts.max) fail(path, `at most ${opts.max} allowed`);
      return arr.map((x, i) => inner.parse(x, `${path}[${i}]`));
    });
  },
};
