/** Server-side HTML rendering: tagged template with auto-escaping.
 * `html\`...\`` returns a Raw; interpolated values are escaped unless they are
 * Raw (nested html``), arrays of children, numbers, or null/undefined/false
 * (dropped). This replaces JSX with zero build step. */

export class Raw {
  readonly s: string;
  constructor(s: string) {
    this.s = s;
  }
  toString(): string {
    return this.s;
  }
}

export type Child = string | number | boolean | null | undefined | Raw | Child[];

export function esc(s: unknown): string {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderChild(v: Child): string {
  if (v === null || v === undefined || v === false || v === true) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(renderChild).join('');
  if (typeof v === 'number') return String(v);
  return esc(v);
}

export function html(strings: TemplateStringsArray, ...vals: Child[]): Raw {
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < vals.length) out += renderChild(vals[i]);
  }
  return new Raw(out);
}

export const raw = (s: string): Raw => new Raw(s);

export function join(items: Child[], sep = ''): Raw {
  return new Raw(items.map(renderChild).join(sep));
}

/** conditional helper that keeps templates tidy */
export function when(cond: unknown, then: () => Child, els?: () => Child): Child {
  return cond ? then() : els ? els() : null;
}

/** encode an attribute-safe JSON blob (for data-* attributes) */
export function jsonAttr(v: unknown): string {
  return esc(JSON.stringify(v));
}
