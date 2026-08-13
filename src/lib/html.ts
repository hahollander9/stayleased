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

/** Body for an inline `<script>` element.
 *
 * A script element's content is raw text: the HTML parser ends it at the first
 * closing script tag ANYWHERE inside, including one sitting in a string
 * literal or — as happened here — inside a code comment explaining this very
 * hazard. Everything after that point is reparsed as markup, so the script
 * silently truncates mid-statement and the page throws "Unexpected end of
 * input" with nothing to point at.
 *
 * Escaping the slash defuses it in every context the sequence can legally
 * appear: `'<\/script>'` is the same string to JavaScript, and in a comment or
 * a regex the extra backslash changes nothing that runs. */
export function inlineScript(js: string): Raw {
  return new Raw(js.replace(/<\/(script)/gi, '<\\/$1'));
}

export function join(items: Child[], sep = ''): Raw {
  return new Raw(items.map(renderChild).join(sep));
}

/** conditional helper that keeps templates tidy */
export function when(cond: unknown, then: () => Child, els?: () => Child): Child {
  return cond ? then() : els ? els() : null;
}

/** encode an attribute-safe JSON blob (for data-* attributes) */
