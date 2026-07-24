import { q1, val } from '../../lib/db.ts';
import { addDays } from '../../lib/dates.ts';
import { rateLimit } from '../../lib/auth.ts';
import { llmGenerate, llmStatus } from '../../lib/sim/llm.ts';
import { redirect, jsonRes, type Router, type Rq } from '../../lib/http.ts';

/** Public "Ask StayLeased" — the marketing-page assistant.
 *
 * It answers questions about the seeded demo company (Summit Ridge) from its
 * REAL numbers, and about the product itself. When ANTHROPIC_API_KEY is set,
 * Claude phrases the answer grounded in facts we compute here (never inventing
 * figures); with no key it falls back to deterministic, still-correct answers.
 * The endpoint is public, so it's rate-limited and never touches a real
 * customer's private data — only the shared demo world. */

interface DemoFacts {
  org: string;
  property: string;
  properties: number;
  units: number;
  occupied: number;
  vacantReady: number;
  inTurn: number;
  occupancyPct: string;
  billed: number; // cents, this month
  collected: number; // cents, this month
  collectionPct: string;
  pastDueCount: number;
  pastDueCents: number;
  openWos: number;
  urgentWos: number;
  endingSoon: number; // leases ending within 60 days
  mtm: number; // month-to-month leases
}

const usd = (c: number): string => '$' + Math.round(c / 100).toLocaleString('en-US');

// memoize per (org, business_date) — demo data only changes when the sim advances
let cache: { key: string; facts: DemoFacts } | null = null;

export function demoFacts(): DemoFacts | null {
  const org = q1<{ id: string; name: string; business_date: string }>(
    `SELECT id, name, business_date FROM orgs WHERE kind='demo' ORDER BY created_at LIMIT 1`,
  ) || q1<{ id: string; name: string; business_date: string }>(`SELECT id, name, business_date FROM orgs ORDER BY created_at LIMIT 1`);
  if (!org) return null;
  const key = `${org.id}:${org.business_date}`;
  if (cache && cache.key === key) return cache.facts;

  const mk = org.business_date.slice(0, 7);
  const n = (sql: string, ...p: unknown[]): number => val<number>(sql, ...p) || 0;

  const units = n('SELECT COUNT(*) FROM units WHERE org_id=?', org.id);
  const occupied = n(`SELECT COUNT(*) FROM units WHERE org_id=? AND status='occupied'`, org.id);
  const vacantReady = n(`SELECT COUNT(*) FROM units WHERE org_id=? AND status='vacant_ready'`, org.id);
  const inTurn = n(`SELECT COUNT(*) FROM units WHERE org_id=? AND status IN ('vacant_not_ready','notice','down')`, org.id);
  const properties = n('SELECT COUNT(*) FROM properties WHERE org_id=?', org.id);
  const firstProp = q1<{ name: string }>('SELECT name FROM properties WHERE org_id=? ORDER BY created_at LIMIT 1', org.id);

  const billed = n(`SELECT COALESCE(SUM(amount_cents),0) FROM charges WHERE org_id=? AND date LIKE ? AND status='active' AND kind NOT IN ('deposit')`, org.id, mk + '%');
  const collectedGross = n(`SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE org_id=? AND received_date LIKE ? AND status IN ('pending','settled') AND method != 'credit'`, org.id, mk + '%');
  const depositReceipts = n(
    `SELECT COALESCE(SUM(pa.amount_cents),0) FROM payment_applications pa
     JOIN payments p ON p.id=pa.payment_id AND p.status IN ('pending','settled') AND p.method != 'credit'
     JOIN charges c ON c.id=pa.charge_id AND c.kind='deposit'
     WHERE pa.org_id=? AND p.received_date LIKE ?`, org.id, mk + '%');
  const collected = collectedGross - depositReceipts;

  // past due: active leases whose posted (non-deposit) charges exceed payments applied
  const pastDue = q1<{ cnt: number; amt: number }>(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(bal),0) AS amt FROM (
       SELECT l.id,
         (SELECT COALESCE(SUM(c.amount_cents),0) FROM charges c WHERE c.lease_id=l.id AND c.status='active' AND c.kind NOT IN ('deposit'))
         - (SELECT COALESCE(SUM(pa.amount_cents),0) FROM payment_applications pa
              JOIN payments p ON p.id=pa.payment_id AND p.status IN ('pending','settled')
              JOIN charges c2 ON c2.id=pa.charge_id AND c2.kind NOT IN ('deposit')
              WHERE c2.lease_id=l.id) AS bal
       FROM leases l WHERE l.org_id=? AND l.status IN ('active','month_to_month','notice')
     ) WHERE bal > 0`, org.id,
  );

  const openWos = n(`SELECT COUNT(*) FROM work_orders WHERE org_id=? AND status NOT IN ('completed','canceled')`, org.id);
  const urgentWos = n(`SELECT COUNT(*) FROM work_orders WHERE org_id=? AND status NOT IN ('completed','canceled') AND priority IN ('emergency','high')`, org.id);

  const endingSoon = n(
    `SELECT COUNT(*) FROM leases WHERE org_id=? AND status IN ('active','notice') AND end_date>=? AND end_date<=?`,
    org.id, org.business_date, addDays(org.business_date, 60),
  );
  const mtm = n(`SELECT COUNT(*) FROM leases WHERE org_id=? AND status='month_to_month'`, org.id);

  const facts: DemoFacts = {
    org: org.name, property: firstProp?.name || org.name, properties, units, occupied, vacantReady, inTurn,
    occupancyPct: units ? (Math.round((occupied / units) * 1000) / 10).toFixed(1) : '0',
    billed, collected, collectionPct: billed ? (Math.round((collected / billed) * 1000) / 10).toFixed(1) : '0',
    pastDueCount: pastDue?.cnt || 0, pastDueCents: pastDue?.amt || 0,
    openWos, urgentWos, endingSoon, mtm,
  };
  cache = { key, facts };
  return facts;
}

// ---------- deterministic answers (fallback + no-key mode) ----------

type Intent = 'occupancy' | 'collection' | 'maintenance' | 'renewal' | 'delinquency' | 'pricing' | 'migration' | 'product' | 'unknown';

function classify(qtext: string): Intent {
  const s = qtext.toLowerCase();
  if (/occupan|vacan|vacate|units? (open|available|empty)|fill/.test(s)) return 'occupancy';
  if (/rent collect|collection|collected|how('| i)?s rent|paid|payment.*(month|status)|income this/.test(s)) return 'collection';
  if (/delinqu|past due|behind|owe|arrears|late/.test(s)) return 'delinquency';
  if (/maintenance|repair|work order|urgent|emergenc|leak|fix/.test(s)) return 'maintenance';
  if (/renew|non.?renewal|lease (end|expir)|move.?out|at risk|churn/.test(s)) return 'renewal';
  if (/price|pricing|cost|how much|fee|expensive|per unit|charge/.test(s)) return 'pricing';
  if (/migrat|import|switch|move (from|off)|onboard|buildium|appfolio|yardi|rent roll|set ?up/.test(s)) return 'migration';
  if (/what (is|does)|how (does|do)|who|why|tell me|explain|feature|can (it|you|stayleased)/.test(s)) return 'product';
  return 'unknown';
}

export function deterministicAnswer(qtext: string, f: DemoFacts | null): string {
  const intent = classify(qtext);
  if (f) {
    switch (intent) {
      case 'occupancy':
        return `Occupancy at ${f.property} is ${f.occupancyPct}%, with ${f.occupied} of ${f.units} units occupied. ${f.vacantReady} are vacant-ready and ${f.inTurn} are in turnover across ${f.properties} propert${f.properties === 1 ? 'y' : 'ies'}.`;
      case 'collection':
        return `You've collected ${usd(f.collected)} of ${usd(f.billed)} billed this month — a ${f.collectionPct}% collection rate. Autopay and the Payments AI are chasing the rest.`;
      case 'delinquency':
        return `${f.pastDueCount} resident${f.pastDueCount === 1 ? '' : 's'} ${f.pastDueCount === 1 ? 'is' : 'are'} past due, totaling ${usd(f.pastDueCents)}. The Payments AI has drafted follow-ups for your approval — friendly first, firmer as it ages.`;
      case 'maintenance':
        return `There ${f.openWos === 1 ? 'is' : 'are'} ${f.openWos} open work order${f.openWos === 1 ? '' : 's'}${f.urgentWos ? `, ${f.urgentWos} flagged urgent` : ''}. The Maintenance AI triages each request on arrival and escalates emergencies to your phone instantly.`;
      case 'renewal':
        return `${f.endingSoon} lease${f.endingSoon === 1 ? '' : 's'} end within 60 days and ${f.mtm} ${f.mtm === 1 ? 'is' : 'are'} month-to-month. The Renewals AI drafts personalized offers ahead of each expiration so nothing lapses.`;
      default: break;
    }
  }
  switch (intent) {
    case 'pricing':
      return `Early-access partners run the full platform free while we build with them. When pricing lands it will be a transparent per-unit price — an order of magnitude below the enterprise platforms, with no implementation or quote-only games.`;
    case 'migration':
      return `Moving in takes an afternoon: upload your rent roll (Excel, CSV, or even a PDF) from Buildium, AppFolio, Yardi, or a spreadsheet, confirm the auto-detected columns, and the system builds your whole portfolio — properties, units, residents, leases, deposits, and balances.`;
    case 'product':
    case 'unknown':
    default:
      return `StayLeased is an AI property manager built for independent multifamily operators. It runs leasing, rent collection, maintenance, and real double-entry accounting — with AI agents that draft and act inside your approval queue. Sign in to the live demo to see it, or ask me about the demo company's occupancy, collections, maintenance, or renewals.`;
  }
}

// ---------- sales mode (floating widget): product & sales, no demo numbers ----------

export function salesAnswer(qtext: string): string {
  const intent = classify(qtext);
  switch (intent) {
    case 'pricing':
      return `Early access is free — the full platform, your real portfolio, export any time. When pricing lands it will be a simple per-unit price published right on the site, far below the enterprise platforms. No implementation fees, no quote-only games. Want an invite code? Book a walkthrough below.`;
    case 'migration':
      return `Switching takes an afternoon, not a quarter. Export your rent roll from Buildium, AppFolio, Yardi — or keep your spreadsheet — upload it (Excel, CSV, even PDF), confirm the columns our AI detected, and your properties, units, residents, leases, deposits and balances are in. Lease PDFs and vendor lists are optional extras.`;
    case 'occupancy': case 'collection': case 'delinquency': case 'maintenance': case 'renewal':
      return `In the product, that answer comes live from your own portfolio — occupancy, collections, delinquency, maintenance and renewals, in plain English. You can watch it work in the interactive demo above, or sign in to the live demo company to try it on real screens.`;
    case 'product': case 'unknown':
    default:
      return `StayLeased is an AI property manager for independent multifamily operators (roughly 10–500 units): leasing that answers every lead in seconds, rent collection with polite-but-persistent AI follow-up, 24/7 maintenance triage, and real double-entry books. Every AI action lands in your approval queue until you dial up autonomy. What would you like to know — pricing, switching over, or what the AI actually does?`;
  }
}

const SALES_SYSTEM = `You are "Ask StayLeased", the sales assistant on the StayLeased marketing site. StayLeased is an AI property-management platform for independent multifamily operators (roughly 10–500 units).
What you know: leasing CRM answers every lead in seconds from live availability; rent collection with autopay and AI delinquency follow-up; 24/7 maintenance triage with emergency escalation; real double-entry accounting with bank rec and owner-ready statements; renewals AI; a resident portal. AI agents propose actions into a human approval queue with per-agent autonomy dials, fair-housing guardrails, and a full audit trail. Migration = upload a rent roll (Excel/CSV/PDF from Buildium, AppFolio, Yardi, or a spreadsheet) and the system builds the portfolio in an afternoon. Early access is FREE with an invite code; future pricing will be a published per-unit price. Payments/bank/screening rails are labeled simulated during early access. There is a live demo company visitors can sign in to, and a "Book a walkthrough" form on this page.
Rules: 1–3 sentences, under 70 words, warm, plain, confident but honest. Never invent numbers, customers, or features beyond the list above. If asked for portfolio-style numbers, explain those come from THEIR data in the product and point to the demo. When helpful, end by inviting them to book a walkthrough or try the demo. No markdown.`;

export interface AskTurn { role: 'you' | 'agent'; text: string }

function transcript(history: AskTurn[]): string {
  if (!history.length) return '';
  return 'Conversation so far:\n' + history.map((t) => `${t.role === 'you' ? 'Visitor' : 'You'}: ${t.text}`).join('\n') + '\n\n';
}

// ---------- live (Claude) answer, grounded in the computed facts ----------

const SYSTEM = `You are "Ask StayLeased", the assistant on the StayLeased marketing site. StayLeased is an AI property-management platform for independent multifamily operators (roughly 10–500 units): leasing CRM, rent collection with AI follow-up, maintenance triage, and real double-entry accounting, with AI agents that propose actions into a human approval queue. Migration is a rent-roll upload (Excel/CSV/PDF). Early access is free.
You answer for a DEMO company using ONLY the facts provided. Rules: be concise (1–3 sentences, under 75 words), warm and plain. NEVER invent numbers — use only the FACTS block for figures; if a number isn't there, speak qualitatively or invite them to sign in. No markdown, no bullet lists.`;

function factsBlock(f: DemoFacts | null): string {
  if (!f) return 'FACTS: (no demo company loaded — answer about the product only).';
  return `FACTS (demo company "${f.org}", property "${f.property}"):
- occupancy ${f.occupancyPct}% (${f.occupied}/${f.units} occupied, ${f.vacantReady} vacant-ready, ${f.inTurn} in turnover, ${f.properties} properties)
- this month: billed ${usd(f.billed)}, collected ${usd(f.collected)} (${f.collectionPct}% collection rate)
- past due: ${f.pastDueCount} residents, ${usd(f.pastDueCents)}
- maintenance: ${f.openWos} open work orders (${f.urgentWos} urgent)
- renewals: ${f.endingSoon} leases end within 60 days, ${f.mtm} month-to-month`;
}

export async function askStayLeased(qtext: string, mode: 'demo' | 'sales' = 'demo', history: AskTurn[] = []): Promise<{ answer: string; live: boolean }> {
  const f = mode === 'demo' ? demoFacts() : null;
  const fallback = mode === 'sales' ? salesAnswer(qtext) : deterministicAnswer(qtext, f);
  const res = await llmGenerate({
    system: mode === 'sales' ? SALES_SYSTEM : SYSTEM,
    prompt: `${mode === 'demo' ? factsBlock(f) + '\n\n' : ''}${transcript(history)}Visitor asks: "${qtext}"\n\nAnswer:`,
    fallback,
    maxTokens: 220,
  });
  const answer = (res.text || fallback).trim();
  return { answer: answer.length > 700 ? answer.slice(0, 700) : answer, live: res.live };
}

// ---------- routes ----------

export function askRoutes(r: Router): void {
  r.post('/company/ask', async (rq: Rq) => {
    if (!rateLimit(`ask:${rq.ip}`, 24, 60000)) {
      return jsonRes({ answer: 'You’re asking quickly! Give me a few seconds and try again.', live: false, throttled: true });
    }
    const qtext = String(rq.body.q || '').trim().slice(0, 500);
    const mode: 'demo' | 'sales' = rq.body.mode === 'sales' ? 'sales' : 'demo';
    if (qtext.length < 2) return jsonRes({ answer: 'Ask me anything about StayLeased — or the demo company.', live: false });
    // short client-provided transcript makes follow-up questions work (real chat)
    let history: AskTurn[] = [];
    try {
      const rawH = JSON.parse(String(rq.body.history || '[]'));
      if (Array.isArray(rawH)) {
        history = rawH.slice(-8).map((t: any) => ({
          role: t && t.role === 'you' ? 'you' as const : 'agent' as const,
          text: String((t && t.text) || '').slice(0, 300),
        })).filter((t) => t.text.length > 0);
      }
    } catch { /* ignore malformed history */ }
    try {
      const out = await askStayLeased(qtext, mode, history);
      return jsonRes({ answer: out.answer, live: out.live, model: out.live ? llmStatus().model : null });
    } catch {
      return jsonRes({ answer: mode === 'sales' ? salesAnswer(qtext) : deterministicAnswer(qtext, demoFacts()), live: false });
    }
  });

  // graceful no-JS fallback: a GET renders nothing special, just bounce home
  r.get('/company/ask', () => redirect('/#ask'));
}
