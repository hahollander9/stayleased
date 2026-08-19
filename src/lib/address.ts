/** What counts as an address a stranger could drive to.
 *
 * A rent roll names buildings; it almost never carries their street address.
 * The importer therefore creates properties with a deliberate placeholder
 * (`(address pending)`, `—`, `--`, `00000`) so the NOT NULL columns are
 * satisfied and the gap stays visible rather than being invented.
 *
 * The placeholder is a marker, not data. Anything that shows an address to a
 * human — the public community site, its PostalAddress schema, statements,
 * maps — must ask here first and simply omit the address when the answer is
 * no. Publishing "(address pending), —, -- 00000" to the open web is worse
 * than publishing nothing at all. */

export const ADDRESS_PENDING = '(address pending)';

export interface AddressParts {
  address1?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

const PLACEHOLDER = new Set(['', '-', '—', '--', '---', 'n/a', 'na', 'none', 'tbd', '00000', ADDRESS_PENDING.toLowerCase()]);

function real(v: string | null | undefined): boolean {
  const s = String(v ?? '').trim().toLowerCase();
  return s !== '' && !PLACEHOLDER.has(s);
}

/** True only when the street line, city, state and postcode are all genuine —
 * a half-filled address is not mappable and must not be published either. */
export function hasRealAddress(p: AddressParts): boolean {
  return real(p.address1) && real(p.city) && real(p.state) && real(p.zip);
}

/** Which parts are still placeholders, for telling the operator what to fix. */
export function missingAddressParts(p: AddressParts): string[] {
  const out: string[] = [];
  if (!real(p.address1)) out.push('street');
  if (!real(p.city)) out.push('city');
  if (!real(p.state)) out.push('state');
  if (!real(p.zip)) out.push('ZIP');
  return out;
}

/** One-line address, or null when there isn't a real one to show. */
export function formatAddress(p: AddressParts): string | null {
  if (!hasRealAddress(p)) return null;
  return `${String(p.address1).trim()}, ${String(p.city).trim()}, ${String(p.state).trim().toUpperCase()} ${String(p.zip).trim()}`;
}

/** Split a one-line US address into the four columns, or null when it does not
 * parse cleanly. Used to accept an address a document stated — never to guess:
 * anything that does not match the shape "street, city, ST 12345" is refused
 * so a half-read line cannot land in a property record. */
export function parseUsAddress(line: string): { address1: string; city: string; state: string; zip: string } | null {
  const s = String(line || '').replace(/\s+/g, ' ').trim().replace(/[.,;]+$/, '');
  if (s.length < 10) return null;
  const m = /^(.+?),\s*([A-Za-z .'-]+),\s*([A-Za-z]{2})\.?\s+(\d{5})(?:-\d{4})?$/.exec(s);
  if (!m) return null;
  const [, address1, city, state, zip] = m;
  if (!address1 || address1.trim().length < 4 || !/\d/.test(address1)) return null; // a street line has a number
  return {
    address1: address1.trim(),
    city: city!.trim(),
    state: state!.toUpperCase(),
    zip: zip!,
  };
}
