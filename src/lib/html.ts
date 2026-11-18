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

/** Pair every bare `<label>` with the form control that follows it.
 *
 * `field()` in the UI kit has always done this, but half the forms in the
 * product are written by hand as `<div class="field"><label>Email</label>
 * <input name="email" /></div>` — the sign-in and sign-up forms among them —
 * and a label that merely sits above a control names nothing: a screen reader
 * announces "edit text", and clicking the word does not focus the box (WCAG
 * 1.3.1, 4.1.2). Fixing sixty call sites would fix today's sixty; doing it
 * where every HTML response already passes fixes the sixty-first as well.
 *
 * Deliberately narrow: only a label with no `for`, wrapping no control of its
 * own, immediately followed by an input, select or textarea. Anything else is
 * left exactly as written. */
const BARE_LABEL = /<label((?:\s+(?!for=)[a-zA-Z-]+="[^"]*")*)>((?:(?!<\/label>|<input|<select|<textarea)[\s\S]){1,400}?)<\/label>(\s*)<(input|select|textarea)\b([^>]*)>/g;
export function associateLabels(body: string): string {
  if (!body.includes('<label')) return body;
  let n = 0;
  return body.replace(BARE_LABEL, (whole, lattrs: string, text: string, gap: string, tag: string, cattrs: string) => {
    if (/\btype="?hidden/.test(cattrs)) return whole;
    const existing = / id="([^"]+)"/.exec(cattrs);
    const id = existing ? existing[1] : `lf-${++n}`;
    const ctrl = existing ? `<${tag}${cattrs}>` : `<${tag} id="${id}"${cattrs}>`;
    return `<label${lattrs} for="${id}">${text}</label>${gap}${ctrl}`;
  });
}

/** Render stored rich text — an AI draft, a queued message body — without
 * trusting it. These bodies are assembled from things strangers type (a lead's
 * name on a public inquiry form goes straight into the reply draft), so
 * `raw()` on them was a script-injection path into a signed-in staff session.
 *
 * Everything is escaped first; then a short list of formatting tags with no
 * attributes, and links to http(s)/mailto/site-relative targets, are let back
 * through. Anything else stays visible as the text it was typed as. */
const SAFE_TAGS = 'p|b|strong|i|em|u|br|ul|ol|li|h3|h4|blockquote|div|span|small|hr';
export function safeHtml(s: unknown): Raw {
  const plain = String(s ?? '')
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'").replaceAll('&amp;', '&');
  const out = esc(plain)
    .replace(new RegExp(`&lt;(/?)(${SAFE_TAGS})\\s*/?&gt;`, 'gi'), (_m, close: string, tag: string) => `<${close}${tag.toLowerCase()}>`)
    .replace(/&lt;a href=(?:&quot;|&#39;)((?:https?:\/\/|mailto:|\/(?!\/))[^\s<>]*?)(?:&quot;|&#39;)&gt;/gi, (_m, href: string) => `<a href="${href}" rel="noopener noreferrer">`)
    .replace(/&lt;\/a&gt;/gi, '</a>');
  return raw(out);
}
