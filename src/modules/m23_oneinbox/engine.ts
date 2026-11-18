/** One Inbox: who is this email from, what is it about, and what do we say?
 *
 * One Inbox works ALONGSIDE the operator's system of record. The operator
 * forwards a shared mailbox (maintenance@, leasing@, agencies@) to their
 * StayLeased address; each message is matched to a person on the contact list
 * they uploaded, sorted by kind and urgency, and given a suggested reply for a
 * human to send from their own email. Nothing is sent from here.
 *
 * Everything in this file is deterministic and pure (no database, no LLM), so
 * the rule that matters most can be tested exhaustively:
 *
 *   An email is filed to a person automatically ONLY on strong evidence.
 *   Anything less is "needs filing" — a suggestion for a human, or nothing.
 *
 * Strong evidence is: the sender's address is on the list for exactly one
 * household; or the body carries that household's phone number; or it names
 * their property AND unit; or the sender's display name is a name only one
 * person on the list has. A name merely mentioned in the body is never enough
 * — "my neighbor James Brown keeps me up" is not from James Brown. The cost of
 * the two mistakes is not symmetric: an email left unfiled for an hour is a
 * small delay, a reply drafted to the wrong household discloses one resident's
 * business to another.
 */

export type ContactKind = 'tenant' | 'agency' | 'owner' | 'vendor' | 'other';

export interface Contact {
  id: string;
  name: string;
  emails: string[]; // lowercased
  phones: string[]; // 10 digits each
  property: string;
  unit: string;
  kind: ContactKind;
}

export interface MailIn {
  fromEmail: string;
  fromName: string;
  /** every recipient address seen, lowercased (the shared mailbox is in here) */
  to: string[];
  subject: string;
  text: string;
}

export type MatchStatus = 'matched' | 'ambiguous' | 'unsorted';

export interface MatchResult {
  status: MatchStatus;
  contactId: string | null;
  /** people a human should choose between (ambiguous), best first */
  candidates: string[];
  /** one plain sentence shown on screen: why it was (or was not) filed */
  reason: string;
}

export type Category = 'repair' | 'payment' | 'agency' | 'owner' | 'leasing' | 'other';
export type Urgency = 'urgent' | 'normal';

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

// ---------- small normalizers ----------

const words = (s: string): string => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** Every 10-digit US phone number in a blob of text, as bare digits. */
export function phonesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<!\d)(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?!\d)/g)) {
    out.add(`${m[1]}${m[2]}${m[3]}`);
  }
  return [...out];
}

export function normPhone(raw: string): string | null {
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return d;
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return null;
}

export function emailsIn(raw: string): string[] {
  return [...new Set([...raw.matchAll(new RegExp(EMAIL_RE, 'gi'))].map((m) => m[0].toLowerCase()))];
}

const household = (c: Contact): string => `${words(c.property)}|${words(c.unit)}`;

/** "re: fwd: RE: Leak in kitchen " → "leak in kitchen" */
export function subjectKey(subject: string): string {
  let s = subject.trim().toLowerCase();
  for (let i = 0; i < 6; i++) {
    const next = s.replace(/^(re|fwd?|fw|aw|tr)\s*:\s*/i, '');
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, ' ').trim();
}

// ---------- forwarded mail ----------

/** A staff member who clicks Forward (instead of a mailbox rule doing it)
 * becomes the sender, and the real one is buried in the body. Recover the
 * original From/Subject from the forwarded header block when there is one, so
 * the message is matched to the resident and not to the employee. */
export function unwrapForward(mail: MailIn): { mail: MailIn; forwardedBy: string | null } {
  if (!/^\s*(fwd?|fw)\s*:/i.test(mail.subject)) return { mail, forwardedBy: null };
  const marker = /^[-_\s>]*(?:forwarded message|original message|begin forwarded message)[-_\s:]*$/im.exec(mail.text);
  const tail = marker ? mail.text.slice(marker.index + marker[0].length) : mail.text;
  const head = tail.split(/\r?\n/).slice(0, 14).join('\n');
  const from = /^\s*>?\s*From:\s*(.+)$/im.exec(head);
  if (!from) return { mail, forwardedBy: null };
  const email = EMAIL_RE.exec(from[1]!)?.[0]?.toLowerCase();
  if (!email) return { mail, forwardedBy: null };
  const name = from[1]!.replace(/<[^>]*>/g, '').replace(EMAIL_RE, '').replace(/["']/g, '').trim();
  const subj = /^\s*>?\s*Subject:\s*(.+)$/im.exec(head)?.[1]?.trim();
  // body = what follows the forwarded header block (first blank line after it)
  const lines = tail.split(/\r?\n/);
  let i = lines.findIndex((l) => /^\s*>?\s*From:/i.test(l));
  while (i < lines.length && lines[i]!.trim() !== '') i++;
  const body = lines.slice(i + 1).join('\n').trim() || mail.text;
  return {
    mail: { ...mail, fromEmail: email, fromName: name, subject: subj || mail.subject.replace(/^\s*(fwd?|fw)\s*:\s*/i, ''), text: body },
    forwardedBy: mail.fromEmail,
  };
}

// ---------- matching ----------

interface Scored { c: Contact; score: number; why: string[] }

function scoreClues(mail: MailIn, contacts: Contact[]): Scored[] {
  const body = words(`${mail.subject} ${mail.text}`);
  const display = words(mail.fromName);
  const bodyPhones = new Set(phonesIn(`${mail.subject}\n${mail.text}`));
  // a name is evidence only when one person on the list carries it
  const nameCount = new Map<string, number>();
  for (const c of contacts) nameCount.set(words(c.name), (nameCount.get(words(c.name)) || 0) + 1);

  const out: Scored[] = [];
  for (const c of contacts) {
    let score = 0;
    const why: string[] = [];
    if (c.phones.some((p) => bodyPhones.has(p))) { score += 3; why.push('their phone number is in the email'); }

    const parts = c.name.toLowerCase().replace(/[^a-z\s'-]/g, ' ').split(/\s+/).filter((p) => p.length >= 2);
    if (parts.length >= 2) {
      const first = ` ${parts[0]} `;
      const last = ` ${parts[parts.length - 1]} `;
      const unique = nameCount.get(words(c.name)) === 1;
      if (display.includes(first) && display.includes(last)) {
        if (unique) { score += 3; why.push('the sender’s name matches'); } else { score += 1; why.push('the sender’s name matches, but so does someone else’s'); }
      } else if (body.includes(first) && body.includes(last)) {
        // mentioned, not necessarily the author: a suggestion, never a filing
        score += 1; why.push('their name appears in the email');
      }
    }

    const prop = words(c.property).trim();
    if (prop.length >= 4 && body.includes(` ${prop} `)) {
      const unit = c.unit.trim().toLowerCase();
      const unitRe = unit && unit !== 'main'
        ? new RegExp(`(?:unit|apt|apartment|suite|ste|#)\\s*#?\\s*${unit.replace(/[^a-z0-9]/g, '')}(?![a-z0-9])`, 'i')
        : null;
      if (unitRe && unitRe.test(`${mail.subject} ${mail.text}`)) { score += 3; why.push('it names their property and unit'); }
      else if (!unitRe) { score += 3; why.push('it names their property'); }
      else { score += 1; why.push('it names their property'); }
    }
    if (score > 0) out.push({ c, score, why });
  }
  return out.sort((a, b) => b.score - a.score);
}

export function matchSender(mail: MailIn, contacts: Contact[], priorThreadContactId: string | null = null): MatchResult {
  const from = mail.fromEmail.toLowerCase();
  const byEmail = from ? contacts.filter((c) => c.emails.includes(from)) : [];
  if (byEmail.length) {
    const households = new Set(byEmail.map(household));
    if (households.size === 1) {
      return { status: 'matched', contactId: byEmail[0]!.id, candidates: [], reason: 'The sender’s email address is on the contact list.' };
    }
    // one address, several households (a case worker, a tenant with two units):
    // let the body break the tie, otherwise ask
    const scored = scoreClues(mail, byEmail);
    if (scored[0] && scored[0].score >= 3 && (!scored[1] || household(scored[1].c) === household(scored[0].c) || scored[0].score - scored[1].score >= 2)) {
      return { status: 'matched', contactId: scored[0].c.id, candidates: [], reason: `The sender’s email is on file for ${byEmail.length} records; ${scored[0].why[0]}.` };
    }
    return {
      status: 'ambiguous', contactId: null, candidates: byEmail.slice(0, 8).map((c) => c.id),
      reason: `The sender’s email address is on file for ${byEmail.length} different records.`,
    };
  }

  const scored = scoreClues(mail, contacts);
  const top = scored[0];
  if (top && top.score >= 3) {
    const rivals = scored.filter((s) => s !== top && household(s.c) !== household(top.c) && top.score - s.score < 2);
    if (!rivals.length) {
      return { status: 'matched', contactId: top.c.id, candidates: [], reason: `New email address, but ${top.why.join(' and ')}.` };
    }
    return {
      status: 'ambiguous', contactId: null, candidates: [top, ...rivals].slice(0, 6).map((s) => s.c.id),
      reason: 'More than one person on the contact list fits this email.',
    };
  }
  if (top) {
    return {
      status: 'ambiguous', contactId: null, candidates: scored.slice(0, 6).map((s) => s.c.id),
      reason: `Not certain who sent this: ${top.why[0]}.`,
    };
  }
  if (priorThreadContactId && contacts.some((c) => c.id === priorThreadContactId)) {
    return {
      status: 'ambiguous', contactId: null, candidates: [priorThreadContactId],
      reason: 'Same subject as an earlier email that was filed to this person.',
    };
  }
  return { status: 'unsorted', contactId: null, candidates: [], reason: 'The sender is not on the contact list and the email does not say who they are.' };
}

// ---------- sorting ----------

const KEYWORDS: [Category, RegExp][] = [
  ['agency', /\b(inspection|re-?inspection|hqs|nspire|hap\b|housing assistance|voucher|recertif|re-?cert\b|abatement|rent reasonable|rfta|request for tenancy|case ?(worker|manager)|housing authority|subsidy|rapid re-?housing)\b/i],
  ['repair', /\b(leak|leaking|flood|no heat|heat(er|ing)?\b|no hot water|hot water|water heater|a\/?c\b|air condition|broken|not working|won'?t (work|open|close|flush|turn)|clog|toilet|sink|faucet|pipe|mold|mould|roach|mice|mouse|rats?\b|bed ?bugs?|pest|outlet|electric|power (is )?out|smoke (alarm|detector)|carbon monoxide|gas smell|smell(s)? (of )?gas|sewage|lock(ed)? ?out|door lock|window|stove|oven|fridge|refrigerator|dishwasher|ceiling|repair|maintenance|fix(ed)?\b)/i],
  ['payment', /\b(rent|payment|paid|pay\b|late fee|balance|ledger|receipt|money order|check\b|deposit|payment plan|past due|owe|owed|charge|refund|erap|rental assistance)\b/i],
  // conduct complaints are their own thing: without this, one sent to
  // maintenance@ would be labelled a repair by the mailbox hint
  ['other', /\b(noise|noisy|loud|neighbou?r|smoking|smoke smell|marijuana|parking|parked|trash|barking|harass|complaint)\b/i],
  ['leasing', /\b(available|availability|tour|showing|apply|application|move[- ]?in|lease (renewal|term)|renew|vacanc|looking for (a|an) (apartment|unit|place)|bedroom)\b/i],
];

const URGENT_RE = /\b(no heat|no hot water|no water|flood(ing|ed)?|burst|gas smell|smell(s)? (of )?gas|gas leak|carbon monoxide|\bco alarm|fire\b|smoke (in|coming)|sparks?|sewage|sewer back|ceiling (is )?(collaps|fall|caving)|lock(ed)? ?out|no (power|electricity)|emergency|urgent|asap|immediately|within 24 hours|24[- ]hour|abate(d|ment)|payments? (will|has|have) (stop|be(en)? (stopped|withheld))|water (is )?(coming|pouring|leaking|dripping) (through|from|in)|failed (the )?(re-?)?inspection|final notice|notice to (vacate|quit))\b/i;

const MAILBOX_HINT: [Category, RegExp][] = [
  ['repair', /^(maint|maintenance|repairs?|service|workorders?)@/i],
  ['leasing', /^(leasing|rentals?|apply|applications?|tours?)@/i],
  ['payment', /^(payments?|accounting|billing|ar|collections?)@/i],
  ['agency', /^(agenc(y|ies)|vouchers?|compliance|subsid(y|ies))@/i],
  ['owner', /^(owners?|investors?)@/i],
];

const AGENCY_SENDER = /\.gov$|housing ?authorit|dchousing|\bhud\b|dhs\b|human services|urban league|voa\b|pathways|community (partnership|connections)/i;

export function classify(mail: MailIn, senderKind: ContactKind | null): { category: Category; urgency: Urgency } {
  const blob = `${mail.subject}\n${mail.text}`;
  let category: Category = 'other';
  if (senderKind === 'agency' || AGENCY_SENDER.test(`${mail.fromEmail} ${mail.fromName}`)) category = 'agency';
  else if (senderKind === 'owner') category = 'owner';
  else {
    // the kind with the most keyword hits wins; ties go to the earlier entry.
    // ("I have a voucher, is the 3 bedroom available for a tour?" is leasing.)
    let best = 0;
    for (const [cat, re] of KEYWORDS) {
      const n = (blob.match(new RegExp(re.source, 'gi')) || []).length;
      if (n > best) { best = n; category = cat; }
    }
    if (!best) {
      for (const addr of mail.to) {
        const hint = MAILBOX_HINT.find(([, re]) => re.test(addr));
        if (hint) { category = hint[0]; break; }
      }
    }
  }
  return { category, urgency: URGENT_RE.test(blob) ? 'urgent' : 'normal' };
}

// ---------- suggested replies ----------

/** A suggested reply for staff to copy into their own email — or null when
 * nobody has been identified, because a reply needs a known recipient.
 *
 * The wording promises a response, never an outcome: no repair date, no fee
 * waiver, no statement about what is owed. Those are the operator's calls, and
 * in a tenant-protective jurisdiction a careless written promise is a
 * liability. Staff edit before sending. */
export function suggestReply(category: Category, urgency: Urgency, contact: Contact | null): string | null {
  if (!contact) return null;
  const first = contact.kind === 'tenant' ? contact.name.trim().split(/\s+/)[0] || 'there' : contact.name.trim() || 'there';
  const place = [contact.property, contact.unit && contact.unit.toLowerCase() !== 'main' ? `Unit ${contact.unit}` : ''].filter(Boolean).join(', ');
  const at = place ? ` for ${place}` : '';
  const sign = '\n\nThank you,\n[Your name]';
  switch (category) {
    case 'repair':
      return urgency === 'urgent'
        ? `Hi ${first},\n\nThank you for telling us right away. We have logged this as urgent${at} and someone from maintenance will contact you shortly to arrange access.\n\nIf anyone is in danger (fire, gas smell, carbon monoxide alarm), please leave the unit and call 911 first.${sign}`
        : `Hi ${first},\n\nThank you for letting us know. We have logged your request${at}, and maintenance will follow up to schedule a time.\n\nIf it gets worse before then, reply to this email or call the office.${sign}`;
    case 'payment':
      return `Hi ${first},\n\nThank you for your message. We are reviewing your account${at} and will get back to you with an answer.\n\nIf you are having trouble making a payment, tell us; we would rather work out a plan with you.${sign}`;
    case 'agency':
      return `Hello ${first},\n\nThank you. We have received this${at} and are reviewing it. We will respond with what you need${urgency === 'urgent' ? ' today' : ' within two business days'}.${sign}`;
    case 'owner':
      return `Hello ${first},\n\nThank you for your note${at}. We are looking into it and will follow up shortly.${sign}`;
    case 'leasing':
      return `Hi ${first},\n\nThanks for reaching out. We will follow up shortly with details and next steps.${sign}`;
    default:
      return `Hi ${first},\n\nThank you for your message. We have received it and will follow up shortly.${sign}`;
  }
}

// ---------- contact list (tenant directory) ----------

export interface RosterRow {
  name: string;
  emails: string[];
  phones: string[];
  property: string;
  unit: string;
  kind: ContactKind;
}

export interface RosterParse {
  rows: RosterRow[];
  rowsRead: number;
  skipped: number;
  missing: string[];
  warnings: string[];
}

const ROSTER_FIELDS: { key: string; label: string; aliases: string[] }[] = [
  { key: 'name', label: 'Name', aliases: ['name', 'tenant', 'tenant name', 'resident', 'resident name', 'contact', 'contact name', 'full name'] },
  { key: 'first', label: 'First name', aliases: ['first name', 'first', 'firstname'] },
  { key: 'last', label: 'Last name', aliases: ['last name', 'last', 'lastname'] },
  { key: 'email', label: 'Email', aliases: ['email', 'emails', 'e-mail', 'email address', 'tenant email', 'primary email'] },
  { key: 'phone', label: 'Phone', aliases: ['phone', 'phones', 'phone number', 'phone numbers', 'mobile', 'cell', 'cell phone', 'primary phone'] },
  { key: 'property', label: 'Property', aliases: ['property', 'property name', 'building', 'property address', 'address'] },
  { key: 'unit', label: 'Unit', aliases: ['unit', 'unit name', 'unit #', 'unit number', 'apt'] },
  { key: 'kind', label: 'Type', aliases: ['type', 'contact type', 'kind', 'role'] },
];

const hnorm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();

function kindOf(raw: string): ContactKind {
  const s = raw.toLowerCase();
  if (/agenc|case ?(worker|manager)|authority|voucher|program/.test(s)) return 'agency';
  if (/owner|landlord|investor/.test(s)) return 'owner';
  if (/vendor|contractor/.test(s)) return 'vendor';
  if (!s || /tenant|resident|current|occupant|lease/.test(s)) return 'tenant';
  return 'other';
}

/** Read a tenant directory / contact list export. Title rows above the header
 * are skipped; a "-> Property" section row sets the property when there is no
 * Property column; people with no email AND no phone are kept (they can still
 * be matched by name, property and unit). */
export function parseRoster(grid: string[][]): RosterParse {
  const out: RosterParse = { rows: [], rowsRead: 0, skipped: 0, missing: [], warnings: [] };
  let headAt = -1;
  let map = new Map<string, number>();
  for (let r = 0; r < Math.min(grid.length, 25); r++) {
    const cells = grid[r]!.map(hnorm);
    const m = new Map<string, number>();
    for (const f of ROSTER_FIELDS) {
      const i = cells.findIndex((c, idx) => ![...m.values()].includes(idx) && f.aliases.includes(c));
      if (i >= 0) m.set(f.key, i);
    }
    if (m.size > map.size && m.size >= 2) { map = m; headAt = r; }
  }
  const hasName = map.has('name') || (map.has('first') && map.has('last'));
  if (headAt < 0 || !hasName) {
    out.warnings.push('Could not find a header row with a Name column. Is this a tenant directory or contact list?');
    out.missing = ['Name'];
    return out;
  }
  out.missing = ROSTER_FIELDS.filter((f) => !map.has(f.key) && !['first', 'last', 'kind'].includes(f.key) && !(f.key === 'name' && hasName)).map((f) => f.label);
  if (!map.has('email')) out.warnings.push('No Email column: emails can only be matched by name, phone, property and unit.');
  let section = '';
  for (const row of grid.slice(headAt + 1)) {
    const filled = row.map((c) => (c || '').trim()).filter(Boolean);
    if (!filled.length) continue;
    const get = (k: string): string => { const i = map.get(k); return i === undefined ? '' : (row[i] || '').trim(); };
    if (!map.has('property') && filled.length === 1) { section = filled[0]!.replace(/^->\s*/, ''); continue; }
    if (/^(grand\s+)?totals?\b/i.test(filled[0]!)) { out.skipped++; continue; }
    let name = get('name') || `${get('first')} ${get('last')}`.trim();
    // "Harper, Denise" → "Denise Harper"
    const flip = /^([^,]+),\s*(.+)$/.exec(name);
    if (flip && !/\b(llc|inc|authority|dept|department)\b/i.test(name)) name = `${flip[2]} ${flip[1]}`.trim();
    if (!name || /^vacant/i.test(name)) { out.skipped++; continue; }
    out.rows.push({
      name,
      emails: emailsIn(get('email')),
      phones: phonesIn(get('phone')),
      property: (get('property') || section).replace(/^->\s*/, ''),
      unit: get('unit'),
      kind: kindOf(get('kind')),
    });
    out.rowsRead++;
  }
  return out;
}
