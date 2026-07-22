import { html, raw, when, join } from '../../lib/html.ts';
import { redirect, notFound, badRequest, fileRes, type Router, type Rq, type Res } from '../../lib/http.ts';
import { requireResident, type Ctx } from '../../lib/auth.ts';
import { q, q1, val, run, insert, update, js, j } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, fmtDate, addDays, addMonths, monthKey, fmtMonth, diffDays, maxDate } from '../../lib/dates.ts';
import { usd, splitCents } from '../../lib/money.ts';
import { v } from '../../lib/validate.ts';
import { audit } from '../../lib/audit.ts';
import { emit } from '../../lib/events.ts';
import { getSetting } from '../../lib/settings.ts';
import { notify } from '../../lib/templates.ts';
import { putFile } from '../../lib/files.ts';
import { portalShell, card, tbl, dl, statusBadge, field, input, select, textarea, checkbox, moneyInput, emptyState } from '../../ui/ui.ts';
import { leaseBalance, leaseLedger } from '../m8_receivables/service.ts';
import { portalUsageCard } from '../m11_utilities/pages.ts';
import { portalInsuranceCard } from '../m12_insurance/pages.ts';
import { portalPrefsCard } from '../m15_comms/pages.ts';
import { recordPayment, PaymentRejected, openCharges } from '../m8_receivables/payments.ts';
import { statementPdf } from '../m8_receivables/statements.ts';

/** M7 resident portal core (items 1–3, 6, 9). Mobile-first. Residents are
 * scoped to their own lease; payment methods are private per user (item 9). */

export interface PortalCtx {
  ctx: Ctx;
  resident: any;
  lease: any; // current lease with unit/property joined
  role: string;
}

export function portalCtx(rq: Rq): PortalCtx | null {
  const ctx = rq.ctx as Ctx;
  const resident = q1<any>('SELECT * FROM residents WHERE user_id=? AND org_id=?', ctx.userId, ctx.orgId);
  if (!resident) return null;
  const lease = q1<any>(
    `SELECT l.*, u.unit_number, u.id AS unit_id, p.name AS prop_name, p.id AS prop_id, p.timezone, hm.role
     FROM household_members hm JOIN leases l ON l.id=hm.lease_id
     JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=l.property_id
     WHERE hm.resident_id=? AND l.status IN ('active','month_to_month','notice','fully_executed')
     ORDER BY CASE l.status WHEN 'active' THEN 0 WHEN 'month_to_month' THEN 1 WHEN 'notice' THEN 2 ELSE 3 END
     LIMIT 1`,
    resident.id,
  );
  if (!lease) return null;
  return { ctx, resident, lease, role: lease.role };
}

const noLease = (rq: Rq): Res =>
  portalShell(rq, {
    title: 'Welcome',
    active: '/portal',
    content: emptyState('No active lease found', 'When you have an active lease, your home, payments and requests appear here. Contact your property office if this looks wrong.'),
  });

const WO_CATEGORIES: [string, string][] = [
  ['plumbing', 'Plumbing / leaks'], ['electrical', 'Electrical'], ['hvac', 'Heating & cooling'],
  ['appliance', 'Appliance'], ['doors_locks', 'Doors & locks'], ['pest', 'Pest control'],
  ['grounds', 'Grounds / common areas'], ['safety', 'Safety concern'], ['other', 'Something else'],
];

const EMERGENCY_WORDS = /(gas leak|smell gas|carbon monoxide|\bfire\b|flood|burst pipe|no heat|sewage|sparking|smoke)/i;

export function routes(r: Router): void {
  // ---------- dashboard ----------
  r.get('/portal', requireResident, (rq) => {
    const pc = portalCtx(rq);
    if (!pc) return noLease(rq);
    const { ctx, lease, resident } = pc;
    const guarantorBanner = pc.role === 'guarantor'
      ? html`<div class="flash info">You're viewing this lease as the <b>guarantor</b> — you can see the balance, documents and payments, and pay on the household's behalf. Household changes and notices stay with the resident.</div>`
      : null;
    const balance = leaseBalance(ctx, lease.id);
    const openReqs = q<any>(
      `SELECT * FROM work_orders WHERE lease_id=? AND status NOT IN ('completed','canceled') ORDER BY created_at DESC LIMIT 4`,
      lease.id,
    );
    const autopay = q1<any>('SELECT * FROM autopay_enrollments WHERE lease_id=? AND active=1', lease.id);
    const announcements = q<any>(
      `SELECT * FROM announcements WHERE org_id=? AND (property_id IS NULL OR property_id=?) AND starts_date<=? AND (ends_date IS NULL OR ends_date>=?) ORDER BY starts_date DESC LIMIT 3`,
      ctx.orgId, lease.prop_id, ctx.businessDate, ctx.businessDate,
    );
    const reservations = q<any>(
      `SELECT ar.*, s.name AS space FROM amenity_reservations ar JOIN amenity_spaces s ON s.id=ar.space_id
       WHERE ar.lease_id=? AND ar.status='confirmed' AND ar.date>=? ORDER BY ar.date LIMIT 3`,
      lease.id, ctx.businessDate,
    );
    const daysLeft = diffDays(lease.end_date, ctx.businessDate);
    const nextCharge = q1<any>(
      `SELECT SUM(amount_cents) AS amt FROM lease_charges WHERE lease_id=? AND (end_date IS NULL OR end_date>=?)`,
      lease.id, ctx.businessDate,
    );
    return portalShell(rq, {
      title: `Hi ${resident.first_name} 👋`,
      active: '/portal',
      propertyName: lease.prop_name,
      content: html`
        ${guarantorBanner}
        <div class="balance-hero">
          <div class="bh-label">Balance · Unit ${lease.unit_number}</div>
          <div class="bh-amount">${usd(Math.max(balance, 0))}</div>
          <div class="bh-sub">${balance > 0
            ? 'Due now'
            : balance < 0
              ? `You have a ${usd(-balance)} credit`
              : `All paid up — next charge ~${usd(nextCharge?.amt || lease.rent_cents)} on ${fmtDate(addMonths(ctx.businessDate.slice(0, 8) + '01', 1))}`}
            ${autopay ? ' · autopay is on' : ''}</div>
          ${balance > 0 ? html`<a class="btn" href="/portal/pay">Pay now</a>` : html`<a class="btn" href="/portal/pay">Make a payment</a>`}
        </div>

        ${when(lease.status === 'notice', () => html`<div class="callout warn">Your notice to vacate is on file — move-out ${fmtDate(lease.move_out_date)}. Check <a href="/portal/lease">Lease</a> for your move-out checklist.</div>`)}
        ${(() => {
          const offer = q1<any>(`SELECT * FROM renewal_offers WHERE lease_id=? AND status='sent' ORDER BY created_at DESC LIMIT 1`, lease.id);
          if (offer) {
            const options = j<any[]>(offer.options, []);
            return html`<div class="card"><div class="card-body" style="background:linear-gradient(140deg,var(--accent-soft),#fff);border-radius:var(--radius)">
              <h3 style="margin-bottom:6px">🏡 Your renewal offer is here</h3>
              <p class="small muted" style="margin:0 0 10px">Lease ends ${fmtDate(lease.end_date)} — lock in your next term (offer valid through ${fmtDate(offer.expires_date)}):</p>
              ${join(options.map((o: any) => html`<form method="post" action="/portal/renewal/${offer.id}/accept" style="display:inline-block;margin:0 6px 6px 0">
                <input type="hidden" name="term" value="${o.term_months}" />
                <button class="btn btn-sm" data-confirm="Renew for ${o.term_months} months at ${usd(o.rent_cents)}/mo? Your renewal packet will be emailed for signature.">${o.term_months} mo · ${usd(o.rent_cents)}</button>
              </form>`))}
              <form method="post" action="/portal/renewal/${offer.id}/counter" class="toolbar" style="margin-top:8px">
                ${field('Or ask us something / counter', input('note', { placeholder: 'Could you do $X for 12 months?' }))}
                <button class="btn btn-sm btn-ghost">Send</button>
              </form>
            </div></div>`;
          }
          return when(lease.status !== 'notice' && daysLeft <= 90 && daysLeft > 0, () => html`<div class="callout info"><b>Your lease ends in ${daysLeft} days</b> (${fmtDate(lease.end_date)}). Renewal offers will appear here when ready.</div>`);
        })()}

        ${card('Open requests', html`
          ${openReqs.length
            ? openReqs.map((w) => html`<a class="list-item" href="/portal/requests/${w.id}">
                <div class="li-main"><div class="li-title">${w.summary}</div><div class="li-sub">${fmtDate(w.created_date)} · ${w.category.replaceAll('_', ' ')}</div></div>
                ${statusBadge(w.status)}
              </a>`)
            : html`<p class="muted small" style="margin:4px 0">Nothing open right now.</p>`}
          <div style="margin-top:10px"><a class="btn btn-ghost btn-sm" href="/portal/requests/new">New maintenance request</a></div>`)}

        ${when(announcements.length, () => card('Announcements', join(announcements.map((a) => html`<div class="list-item"><div class="li-main"><div class="li-title">${a.title}</div><div class="li-sub">${a.body.slice(0, 120)}</div></div></div>`))))}
        ${when(reservations.length, () => card('Upcoming reservations', join(reservations.map((x) => html`<div class="list-item"><div class="li-main"><div class="li-title">${x.space}</div><div class="li-sub">${fmtDate(x.date)} · ${x.start_time}–${x.end_time}</div></div></div>`))))}`,
    });
  });

  // ---------- pay ----------
  r.get('/portal/pay', requireResident, (rq) => {
    const pc = portalCtx(rq);
    if (!pc) return noLease(rq);
    const { ctx, lease, resident } = pc;
    const balance = leaseBalance(ctx, lease.id);
    const open = openCharges(ctx, lease.id);
    const methods = q<any>('SELECT * FROM payment_method_tokens WHERE user_id=? ORDER BY is_default DESC, created_at DESC', ctx.userId);
    const adults = val<number>(
      `SELECT COUNT(*) FROM household_members hm JOIN residents rr ON rr.id=hm.resident_id WHERE hm.lease_id=? AND hm.role IN ('primary','co')`,
      lease.id,
    ) || 1;
    const share = adults > 1 && balance > 0 ? splitCents(balance, adults)[0]! : null;
    const feeCfg = getSetting<{ achCents: number; cardPct: number }>(ctx, 'convenience_fee', lease.prop_id);
    const autopay = q1<any>('SELECT * FROM autopay_enrollments WHERE lease_id=? AND active=1 AND user_id=?', lease.id, ctx.userId);
    return portalShell(rq, {
      title: 'Payments',
      active: '/portal/pay',
      propertyName: lease.prop_name,
      content: html`
        ${card(html`Balance <span class="badge ${balance > 0 ? 'bad' : 'ok'}">${usd(balance)}</span>`, html`
          ${open.length ? html`<div class="small muted" style="margin-bottom:8px">Open items:</div>
            ${join(open.slice(0, 6).map((c) => html`<div class="list-item"><div class="li-main"><div class="li-title" style="font-weight:500">${labelOf(c)}</div><div class="li-sub">due ${fmtDate(c.due_date)}</div></div><b>${usd(c.amount_cents - c.applied)}</b></div>`))}` : html`<p class="muted small">Nothing due.</p>`}
          ${when(share, () => html`<p class="small muted" style="margin-top:8px">Split with roommates: your suggested share is <b>${usd(share!)}</b> (1 of ${adults} adults — each pays separately).</p>`)}`)}

        ${card('Make a payment', html`
          <form method="post" action="/portal/pay">
            ${field('Amount', moneyInput('amount', balance > 0 ? balance : null, { required: true }))}
            ${field('Payment method', select('method_token', [
              ...methods.map((m): [string, string] => [m.id, `${m.label}${m.is_default ? ' (default)' : ''}`]),
            ], methods[0]?.id, { blank: methods.length ? undefined : 'No saved methods — add one below' }))}
            <p class="small muted">Bank transfers (ACH) are free and settle in ~3 days. Cards post instantly with a ${feeCfg.cardPct}% convenience fee.</p>
            <button class="btn" style="width:100%;justify-content:center" ${methods.length ? '' : 'disabled'}>Pay now</button>
          </form>`)}

        ${card('Autopay', autopay
          ? html`<p class="small">Autopay is <b>on</b>: ${autopay.mode === 'full_balance' ? 'full balance' : usd(autopay.fixed_amount_cents)} on day ${autopay.day_of_month} each month.</p>
            <form method="post" action="/portal/autopay/cancel" data-confirm="Turn off autopay?"><button class="btn btn-ghost btn-sm">Turn off autopay</button></form>`
          : html`<form method="post" action="/portal/autopay">
              ${field('Mode', select('mode', [['full_balance', 'Full balance'], ['fixed', 'Fixed amount']], 'full_balance'))}
              ${field('Fixed amount (if fixed)', moneyInput('fixed_amount'))}
              ${field('Day of month', input('day', { type: 'number', value: 1, min: '1', max: '28' }))}
              ${field('Method', select('method_token', methods.filter((m) => m.kind === 'ach').map((m): [string, string] => [m.id, m.label]), methods.find((m) => m.kind === 'ach')?.id, { blank: methods.some((m) => m.kind === 'ach') ? undefined : 'Add a bank account first' }))}
              <button class="btn" ${methods.some((m) => m.kind === 'ach') ? '' : 'disabled'}>Enroll in autopay</button>
            </form>`)}

        ${card('Saved payment methods', html`
          ${methods.length ? join(methods.map((m) => html`<div class="list-item">
            <div class="li-main"><div class="li-title">${m.label}</div><div class="li-sub">${m.kind.toUpperCase()}${m.is_default ? ' · default' : ''}</div></div>
            <form method="post" action="/portal/pay/methods/${m.id}/remove"><button class="chip">Remove</button></form>
          </div>`)) : html`<p class="muted small">No saved methods yet.</p>`}
          <details style="margin-top:10px">
            <summary class="btn btn-ghost btn-sm" style="list-style:none">Add a method</summary>
            <form method="post" action="/portal/pay/methods" style="margin-top:10px">
              ${field('Type', select('kind', [['ach', 'Bank account (ACH)'], ['card', 'Card']], 'ach'))}
              ${field('Account / card number', input('number', { required: true, placeholder: '•••• demo: any digits' }), html`Demo instruments: end in <code>0341</code> → returns NSF · end in <code>0002</code> → card declines`)}
              ${field('Name on account', input('holder', { value: `${resident.first_name} ${resident.last_name}` }))}
              ${checkbox('is_default', 'Make default', true)}
              <button class="btn btn-sm">Save method</button>
            </form>
          </details>`)}

        ${card('History & statements', html`
          <a class="btn btn-ghost btn-sm" href="/portal/ledger">Full ledger history</a>
          <div class="small muted" style="margin-top:8px">Monthly statements (PDF):</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
            ${[0, 1, 2, 3, 4, 5].map((i) => {
              const mk = monthKey(addMonths(ctx.businessDate, -i));
              return html`<a class="chip" href="/portal/statements/${mk}.pdf">${fmtMonth(mk)}</a>`;
            })}
          </div>`)}`,
    });
  });

  r.post('/portal/pay', requireResident, (rq) => {
    const pc = portalCtx(rq);
    if (!pc) return noLease(rq);
    const { ctx, lease, resident } = pc;
    const tokenId = String(rq.body.method_token || '');
    const token = q1<any>('SELECT * FROM payment_method_tokens WHERE id=? AND user_id=?', tokenId, ctx.userId);
    if (!token) return redirect('/portal/pay', 'Pick a saved payment method (or add one).', 'err');
    try {
      recordPayment(ctx, {
        leaseId: lease.id,
        amountCents: v.cents({ min: 100 }).parse(rq.body.amount),
        method: token.kind,
        methodTokenId: token.id,
        receivedDate: ctx.businessDate,
        payerResidentId: resident.id,
      });
    } catch (e) {
      if (e instanceof PaymentRejected) return redirect('/portal/pay', e.message, 'err');
      throw e;
    }
    return redirect('/portal/pay', token.kind === 'ach' ? 'Payment started — ACH settles in about 3 days. Receipt sent.' : 'Payment received — receipt sent.');
  });

  r.post('/portal/pay/methods', requireResident, (rq) => {
    const pc = portalCtx(rq);
    if (!pc) return noLease(rq);
    const { ctx, resident } = pc;
    const kind = v.oneOf('ach', 'card').parse(rq.body.kind);
    const number = String(rq.body.number || '').replace(/\D/g, '');
    if (number.length < 4) return redirect('/portal/pay', 'Enter a valid (demo) number.', 'err');
    const last4 = number.slice(-4);
    const behavior = last4 === '0341' ? 'nsf' : last4 === '0002' ? 'declined' : 'ok';
    if (rq.body.is_default) run('UPDATE payment_method_tokens SET is_default=0 WHERE user_id=?', ctx.userId);
    insert('payment_method_tokens', {
      id: id('tok'), org_id: ctx.orgId, user_id: ctx.userId, lease_id: pc.lease.id, kind,
      label: kind === 'ach' ? `Checking ····${last4}` : `Card ····${last4}`,
      token: 'sim_' + last4, behavior, is_default: rq.body.is_default ? 1 : 0, created_at: nowIso(),
    });
    audit(ctx, 'payment_method', last4, 'create');
    return redirect('/portal/pay', 'Payment method saved.');
  });

  r.post('/portal/pay/methods/:id/remove', requireResident, (rq) => {
    const ctx = rq.ctx as Ctx;
    run('DELETE FROM payment_method_tokens WHERE id=? AND user_id=?', rq.params.id!, ctx.userId);
    return redirect('/portal/pay', 'Method removed.');
  });

  r.post('/portal/autopay', requireResident, (rq) => {
    const pc = portalCtx(rq);
    if (!pc) return noLease(rq);
    const { ctx, lease, resident } = pc;
    const token = q1<any>('SELECT * FROM payment_method_tokens WHERE id=? AND user_id=? AND kind=?', String(rq.body.method_token || ''), ctx.userId, 'ach');
    if (!token) return redirect('/portal/pay', 'Autopay needs a saved bank account (ACH).', 'err');
    const mode = v.oneOf('full_balance', 'fixed').parse(rq.body.mode);
    const day = v.int({ min: 1, max: 28 }).parse(rq.body.day || 1);
    run('UPDATE autopay_enrollments SET active=0 WHERE lease_id=? AND user_id=?', lease.id, ctx.userId);
    insert('autopay_enrollments', {
      id: id('apy'), org_id: ctx.orgId, lease_id: lease.id, user_id: ctx.userId, method_token_id: token.id,
      mode, fixed_amount_cents: mode === 'fixed' ? v.cents({ min: 100 }).parse(rq.body.fixed_amount) : null,
      day_of_month: day, start_date: ctx.businessDate, active: 1, created_at: nowIso(),
    });
    emit(ctx, 'autopay.enrolled', 'lease', lease.id, { mode, day });
    audit(ctx, 'autopay', lease.id, 'enroll', null, { mode, day });
    notify(ctx, 'autopay_confirmation', {
      email: resident.email, phone: resident.phone, name: `${resident.first_name} ${resident.last_name}`,
      userId: ctx.userId, personId: resident.id, propertyId: lease.prop_id, entity: 'lease', entityId: lease.id,
    }, {
      first_name: resident.first_name, unit: lease.unit_number,
      mode: mode === 'full_balance' ? 'full balance' : usd(v.cents().default(0).parse(rq.body.fixed_amount || 0)),
      day, method: token.label, property: lease.prop_name,
    });
    return redirect('/portal/pay', 'Autopay is on. Confirmation sent.');
  });

  r.post('/portal/autopay/cancel', requireResident, (rq) => {
    const pc = portalCtx(rq);
    if (!pc) return noLease(rq);
    run('UPDATE autopay_enrollments SET active=0 WHERE lease_id=? AND user_id=?', pc.lease.id, pc.ctx.userId);
    audit(pc.ctx, 'autopay', pc.lease.id, 'cancel');
    return redirect('/portal/pay', 'Autopay turned off.');
  });

  // ---------- ledger + statements ----------
  r.get('/portal/ledger', requireResident, (rq) => {
    const pc = portalCtx(rq);
    if (!pc) return noLease(rq);
    const { ctx, lease } = pc;
    const ledger = leaseLedger(ctx, lease.id).slice().reverse();
    return portalShell(rq, {
      title: 'Ledger history',
      active: '/portal/pay',
      back: '/portal/pay',
      propertyName: lease.prop_name,
      content: card(null, tbl(
        [{ label: 'Date' }, { label: 'Item' }, { label: 'Amount', num: true }, { label: 'Balance', num: true }],
        ledger.map((row) => ({
          cells: [
            html`<span class="small nowrap">${fmtDate(row.date)}</span>`,
            html`<span class="small">${row.label}</span>`,
            html`<span class="${row.credit_cents ? 'pos' : ''}">${row.charge_cents ? usd(row.charge_cents) : `−${usd(row.credit_cents)}`}</span>`,
            usd(row.balance),
          ],
        })),
        { empty: 'No activity yet.' },
      ), { flush: true }),
    });
  });

  r.get('/portal/statements/:mk', requireResident, async (rq) => {
    const pc = portalCtx(rq);
    if (!pc) return noLease(rq);
    const mk = String(rq.params.mk || '').replace('.pdf', '');
    if (!/^\d{4}-\d{2}$/.test(mk)) return badRequest('bad month');
    const bytes = await statementPdf(pc.ctx, pc.lease.id, mk);
    return fileRes(bytes, 'application/pdf', { filename: `statement-${mk}.pdf`, inline: true });
  });

  // ---------- maintenance requests ----------
  r.get('/portal/requests', requireResident, (rq) => {
    const pc = portalCtx(rq);
    if (!pc) return noLease(rq);
    const { lease } = pc;
    const wos = q<any>('SELECT * FROM work_orders WHERE lease_id=? ORDER BY created_at DESC LIMIT 30', lease.id);
    return portalShell(rq, {
      title: 'Maintenance requests',
      active: '/portal/requests',
      propertyName: lease.prop_name,
      content: html`
        <a class="btn" style="width:100%;justify-content:center;margin-bottom:12px" href="/portal/requests/new">New request</a>
        ${card(null, wos.length
          ? join(wos.map((w) => html`<a class="list-item" href="/portal/requests/${w.id}">
              <div class="li-main"><div class="li-title">${w.summary}</div><div class="li-sub">#${w.id.slice(-6)} · ${fmtDate(w.created_date)} · ${w.category.replaceAll('_', ' ')}</div></div>
              ${statusBadge(w.status)}
            </a>`))
          : emptyState('No requests yet', 'When something needs fixing, submit a request and track it here.'))}`,
    });
  });

  r.get('/portal/requests/new', requireResident, (rq) => {
    const pc = portalCtx(rq);
    if (!pc) return noLease(rq);
    return portalShell(rq, {
      title: 'New maintenance request',
      active: '/portal/requests',
      back: '/portal/requests',
      propertyName: pc.lease.prop_name,
      content: card(null, html`
        <div class="callout bad" style="margin-top:0"><b>Emergency?</b> Gas smell, fire, flooding, or no heat in winter — call the 24/7 line at (555) 000-9111 first.</div>
        <form method="post" action="/portal/requests/new" enctype="multipart/form-data">
          ${field('What kind of issue?', select('category', WO_CATEGORIES, 'plumbing', { required: true }))}
          ${field('Short summary', input('summary', { required: true, placeholder: 'Kitchen sink dripping under the cabinet' }))}
          ${field('Details', textarea('description', { rows: 4, placeholder: 'When did it start? Where exactly? Anything you already tried?' }))}
          ${field('Photos (optional)', raw('<input type="file" name="photos" accept="image/*" multiple />'))}
          ${checkbox('permission_to_enter', 'Staff may enter if I am not home', true)}
          ${checkbox('pet_on_premises', 'A pet will be at home')}
          ${field('Preferred times', input('preferred_times', { placeholder: 'Weekdays after 3pm' }))}
          <button class="btn" style="width:100%;justify-content:center">Submit request</button>
        </form>`),
    });
  });

  r.post('/portal/requests/new', requireResident, (rq) => {
    const pc = portalCtx(rq);
    if (!pc) return noLease(rq);
    const { ctx, lease, resident } = pc;
    const summary = String(rq.body.summary || '').trim();
    if (!summary) return redirect('/portal/requests/new', 'Give the request a short summary.', 'err');
    const description = String(rq.body.description || '');
    const emergency = EMERGENCY_WORDS.test(summary + ' ' + description);
    const woId = id('wo');
    insert('work_orders', {
      id: woId, org_id: ctx.orgId, property_id: lease.prop_id, unit_id: lease.unit_id, lease_id: lease.id,
      resident_id: resident.id, category: String(rq.body.category || 'other'),
      priority: emergency ? 'emergency' : 'normal', status: 'new', summary, description,
      permission_to_enter: rq.body.permission_to_enter ? 1 : 0, pet_on_premises: rq.body.pet_on_premises ? 1 : 0,
      preferred_times: rq.body.preferred_times || null, source: 'portal',
      created_date: ctx.businessDate, created_by: ctx.userId, created_at: nowIso(),
    });
    insert('wo_events', {
      id: id('woe'), org_id: ctx.orgId, work_order_id: woId, kind: 'status',
      body: emergency ? 'Request received — flagged EMERGENCY' : 'Request received', actor: `${resident.first_name} ${resident.last_name}`,
      at: nowIso(), business_date: ctx.businessDate,
    });
    for (const up of rq.uploads.filter((u) => u.field === 'photos' && u.data.length > 0)) {
      const f = putFile(ctx, up.data, {
        name: up.filename || 'photo.jpg', mime: up.mime, entity: 'work_order', entityId: woId,
        visibility: 'resident', ownerUserId: ctx.userId,
      });
      insert('wo_events', {
        id: id('woe'), org_id: ctx.orgId, work_order_id: woId, kind: 'photo', body: up.filename,
        meta: js({ fileId: f.id }), actor: `${resident.first_name} ${resident.last_name}`, at: nowIso(), business_date: ctx.businessDate,
      });
    }
    emit(ctx, 'maintenance.requested', 'work_order', woId, { propertyId: lease.prop_id, category: rq.body.category, emergency, summary });
    return redirect(`/portal/requests/${woId}`, emergency ? 'Request submitted and flagged as an emergency — the on-call team is notified.' : 'Request submitted — we will keep you posted here.');
  });

  r.get('/portal/requests/:id', requireResident, (rq) => {
    const pc = portalCtx(rq);
    if (!pc) return noLease(rq);
    const { ctx, lease } = pc;
    const w = q1<any>('SELECT * FROM work_orders WHERE id=? AND lease_id=?', rq.params.id!, lease.id);
    if (!w) return notFound('Request not found');
    const events = q<any>('SELECT * FROM wo_events WHERE work_order_id=? AND visible_to_resident=1 ORDER BY at', w.id);
    const photos = q<any>(`SELECT * FROM files WHERE entity='work_order' AND entity_id=?`, w.id);
    return portalShell(rq, {
      title: w.summary,
      active: '/portal/requests',
      back: '/portal/requests',
      propertyName: lease.prop_name,
      content: html`
        ${card(html`Status ${statusBadge(w.status)} ${w.priority === 'emergency' ? statusBadge('emergency') : ''}`, html`
          ${dl([
            ['Request #', w.id.slice(-6)],
            ['Category', w.category.replaceAll('_', ' ')],
            ['Submitted', fmtDate(w.created_date)],
            ...(w.scheduled_date ? [['Scheduled', fmtDate(w.scheduled_date)] as [any, any]] : []),
            ['Entry permission', w.permission_to_enter ? 'Yes' : 'No — resident must be home'],
          ])}
          ${when(photos.length, () => html`<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">${photos.map((p) => html`<a href="/f/${p.id}" target="_blank"><img src="/f/${p.id}" alt="${p.name}" style="width:84px;height:84px;object-fit:cover;border-radius:8px;border:1px solid var(--line)" /></a>`)}</div>`)}`)}
        ${card('Timeline', html`<ul class="timeline">${events.map((e) => html`<li class="${e.kind === 'status' ? 'hot' : ''}">
          <div><b>${e.body || e.kind}</b>${e.actor ? html` <span class="muted small">· ${e.actor}</span>` : ''}</div>
          <div class="t-when">${fmtDate((e.business_date || e.at).slice(0, 10))}</div>
        </li>`)}</ul>`)}
        ${when(w.status === 'completed' && !w.rating, () => card('How did we do?', html`
          <form method="post" action="/portal/requests/${w.id}/rate">
            ${field('Rating', select('rating', [['5', '★★★★★ Great'], ['4', '★★★★ Good'], ['3', '★★★ OK'], ['2', '★★ Poor'], ['1', '★ Bad']], '5'))}
            ${field('Comment (optional)', textarea('comment', { rows: 2 }))}
            <button class="btn btn-sm">Send feedback</button>
          </form>`))}
        ${when(w.rating, () => html`<div class="callout">You rated this ${'★'.repeat(w.rating)} — thanks for the feedback!</div>`)}`,
    });
  });

  r.post('/portal/requests/:id/rate', requireResident, (rq) => {
    const pc = portalCtx(rq);
    if (!pc) return noLease(rq);
    const w = q1<any>('SELECT * FROM work_orders WHERE id=? AND lease_id=?', rq.params.id!, pc.lease.id);
    if (!w || w.status !== 'completed') return notFound();
    update('work_orders', w.id, { rating: v.int({ min: 1, max: 5 }).parse(rq.body.rating), rating_comment: rq.body.comment || null });
    emit(pc.ctx, 'maintenance.rated', 'work_order', w.id, { rating: Number(rq.body.rating) });
    return redirect(`/portal/requests/${w.id}`, 'Thanks for the feedback!');
  });

  // ---------- lease self-service ----------
  r.get('/portal/lease', requireResident, (rq) => {
    const pc = portalCtx(rq);
    if (!pc) return noLease(rq);
    const { ctx, lease, resident, role } = pc;
    const household = q<any>(
      `SELECT r.first_name, r.last_name, hm.role FROM household_members hm JOIN residents r ON r.id=hm.resident_id WHERE hm.lease_id=? ORDER BY hm.role`,
      lease.id,
    );
    const docs = q<any>(`SELECT * FROM files WHERE entity='lease' AND entity_id=? AND visibility IN ('resident','public')`, lease.id);
    const requests = q<any>('SELECT * FROM household_requests WHERE lease_id=? ORDER BY created_at DESC LIMIT 5', lease.id);
    const noticeDays = getSetting<number>(ctx, 'notice_period_days', lease.prop_id);
    const earliestMoveOut = addDays(ctx.businessDate, noticeDays);
    const pets = q<any>('SELECT * FROM pets WHERE lease_id=?', lease.id);
    const vehicles = q<any>('SELECT * FROM vehicles WHERE lease_id=?', lease.id);
    return portalShell(rq, {
      title: 'My lease',
      active: '/portal/lease',
      propertyName: lease.prop_name,
      content: html`
        ${card('Lease', dl([
          ['Unit', `${lease.unit_number} · ${lease.prop_name}`],
          ['Status', statusBadge(lease.status)],
          ['Term', `${fmtDate(lease.start_date)} → ${fmtDate(lease.end_date)}`],
          ['Monthly rent', usd(lease.rent_cents)],
          ['Deposit', lease.deposit_alternative ? 'Deposit alternative' : usd(lease.deposit_cents)],
          ['Household', household.map((h) => `${h.first_name} ${h.last_name}${h.role === 'guarantor' ? ' (guarantor)' : ''}`).join(', ')],
          ['Pets', pets.length ? pets.map((x) => x.name).join(', ') : 'None'],
          ['Vehicles', vehicles.length ? vehicles.map((x) => `${x.make} ${x.model}`).join(', ') : 'None'],
        ]))}
        ${(() => {
          const checklist = q1<any>(`SELECT * FROM move_checklists WHERE lease_id=? AND kind='move_in'`, lease.id);
          if (!checklist) return null;
          const items = j<any[]>(checklist.items, []);
          const doneCount = items.filter((x: any) => x.done).length;
          return card(html`Move-in checklist <span class="badge ${doneCount === items.length ? 'ok' : 'info'}">${doneCount}/${items.length}</span>`, join(items.map((it: any) => html`<div class="list-item">
            <div class="li-main"><div class="li-title" style="font-weight:500">${it.label}</div><div class="li-sub">${it.who === 'staff' ? 'Handled by your property team' : 'Your task'}</div></div>
            ${it.done ? statusBadge('ok', 'done') : it.who === 'resident' ? html`<form method="post" action="/portal/checklist/${checklist.id}/toggle"><input type="hidden" name="key" value="${it.key}" /><button class="chip">Mark done</button></form>` : statusBadge('pending')}
          </div>`)));
        })()}
        ${card('Documents', docs.length
          ? join(docs.map((d) => html`<a class="list-item" href="/f/${d.id}" target="_blank"><div class="li-main"><div class="li-title">${d.name}</div><div class="li-sub">${(d.size / 1024).toFixed(0)} KB</div></div>📄</a>`))
          : html`<p class="muted small">Signed lease documents will appear here once e-signing is complete.</p>`)}

        ${portalInsuranceCard(ctx, lease)}
        ${portalUsageCard(ctx, lease)}
        ${portalPrefsCard(ctx, resident)}

        ${when(role !== 'occupant', () => card('Request a household change', html`
          <form method="post" action="/portal/lease/household-request">
            ${field('Type', select('kind', [['occupant', 'Add an occupant'], ['pet', 'Add a pet'], ['vehicle', 'Add a vehicle']], 'pet'))}
            ${field('Details', textarea('details', { rows: 2, required: true, placeholder: 'e.g. Cat named Mochi, 8 lbs, domestic shorthair' }))}
            <button class="btn btn-sm">Send for approval</button>
          </form>
          ${when(requests.length, () => html`<div style="margin-top:10px">${join(requests.map((x) => html`<div class="list-item"><div class="li-main"><div class="li-title" style="font-weight:500">${x.kind}: ${j<any>(x.payload, {}).details || ''}</div><div class="li-sub">${fmtDate(x.created_at.slice(0, 10))}</div></div>${statusBadge(x.status)}</div>`))}</div>`)}`))}

        ${when(['active', 'month_to_month'].includes(lease.status) && role === 'primary', () => card('Give notice to vacate', html`
          <p class="small muted">Your lease requires ${noticeDays} days notice — the earliest move-out date is <b>${fmtDate(earliestMoveOut)}</b>. Moving out before ${fmtDate(lease.end_date)} may involve early-termination terms per your lease.</p>
          <form method="post" action="/portal/lease/notice" data-confirm="Submit your notice to vacate? Your property team will confirm next steps.">
            ${field('Planned move-out date', input('move_out', { type: 'date', required: true, min: earliestMoveOut, value: maxDate(earliestMoveOut, lease.end_date) }))}
            ${field('Forwarding address (optional)', input('forwarding'))}
            <button class="btn btn-danger btn-sm">Submit notice to vacate</button>
          </form>`))}
        ${when(lease.status === 'notice', () => html`<div class="callout warn">Notice on file — planned move-out <b>${fmtDate(lease.move_out_date)}</b>. Your final statement and deposit disposition arrive within ${getSetting<number>(ctx, 'deposit_disposition_days', lease.prop_id)} days after move-out.</div>`)}`,
    });
  });

  r.post('/portal/lease/household-request', requireResident, (rq) => {
    const pc = portalCtx(rq);
    if (!pc) return noLease(rq);
    const { ctx, lease } = pc;
    insert('household_requests', {
      id: id('hrq'), org_id: ctx.orgId, property_id: lease.prop_id, lease_id: lease.id,
      kind: v.oneOf('occupant', 'pet', 'vehicle').parse(rq.body.kind),
      payload: js({ details: String(rq.body.details || '') }),
      status: 'pending', created_by: ctx.userId, created_at: nowIso(),
    });
    emit(ctx, 'household.change_requested', 'lease', lease.id, { kind: rq.body.kind });
    return redirect('/portal/lease', 'Request sent — staff will review it shortly.');
  });

  r.post('/portal/lease/notice', requireResident, (rq) => {
    const pc = portalCtx(rq);
    if (!pc) return noLease(rq);
    const { ctx, lease, resident, role } = pc;
    if (role !== 'primary') return badRequest('Only the primary resident can give notice.');
    if (!['active', 'month_to_month'].includes(lease.status)) return redirect('/portal/lease', 'Notice is already on file.', 'err');
    const noticeDays = getSetting<number>(ctx, 'notice_period_days', lease.prop_id);
    const earliest = addDays(ctx.businessDate, noticeDays);
    const moveOut = v.date().parse(rq.body.move_out);
    if (moveOut < earliest) return redirect('/portal/lease', `Earliest allowed move-out is ${fmtDate(earliest)} (${noticeDays}-day notice).`, 'err');
    run('UPDATE leases SET status=?, notice_date=?, move_out_date=? WHERE id=?', 'notice', ctx.businessDate, moveOut, lease.id);
    run('UPDATE units SET status=? WHERE id=? AND status=?', 'notice', lease.unit_id, 'occupied');
    audit(ctx, 'lease', lease.id, 'notice_to_vacate', { status: lease.status }, { status: 'notice', move_out: moveOut });
    emit(ctx, 'lease.notice', 'lease', lease.id, { moveOut, propertyId: lease.prop_id, unitId: lease.unit_id });
    return redirect('/portal/lease', 'Notice submitted. Your property team will follow up with move-out details.');
  });
}

function labelOf(c: { kind: string }): string {
  const map: Record<string, string> = {
    rent: 'Rent', late_fee: 'Late fee', nsf_fee: 'Returned payment fee', utility: 'Utilities',
    parking: 'Parking', garage: 'Garage', storage: 'Storage', pet_rent: 'Pet rent',
    deposit: 'Security deposit', mtm_premium: 'Month-to-month premium', damage: 'Damage charge',
  };
  return map[c.kind] || 'Charge';
}

// ---------- staff-side: household change approvals (M7.6) ----------

import { registerLeaseTab } from '../people/pages.ts';
import { requirePerm } from '../../lib/auth.ts';
import { createCharge } from '../m8_receivables/service.ts';

registerLeaseTab((ctx, lease) => {
  const pending = q<any>(`SELECT * FROM household_requests WHERE lease_id=? ORDER BY created_at DESC LIMIT 20`, lease.id);
  if (!pending.length) return null;
  return {
    key: 'portal-requests',
    label: `Portal requests`,
    render: () => card('Household change requests', tbl(
      [{ label: 'Requested' }, { label: 'Type' }, { label: 'Details' }, { label: 'Status' }, { label: '', w: '190px' }],
      pending.map((x) => ({
        cells: [
          fmtDate(x.created_at.slice(0, 10)), statusBadge(undefined, x.kind),
          html`<span class="small">${j<any>(x.payload, {}).details || ''}</span>`, statusBadge(x.status),
          x.status === 'pending'
            ? html`<div style="display:flex;gap:6px">
                <form method="post" action="/staff/household-requests/${x.id}/approve"><button class="btn btn-sm">Approve</button></form>
                <form method="post" action="/staff/household-requests/${x.id}/deny"><button class="btn btn-sm btn-ghost">Deny</button></form>
              </div>`
            : '',
        ],
      })),
    ), { flush: true }),
  };
});

export function staffRoutes(r: Router): void {
  r.post('/staff/household-requests/:id/approve', requirePerm('residents:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const x = q1<any>('SELECT * FROM household_requests WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!x || x.status !== 'pending') return notFound();
    const details = j<any>(x.payload, {}).details || '';
    if (x.kind === 'pet') {
      insert('pets', {
        id: id('pet'), org_id: ctx.orgId, lease_id: x.lease_id, name: details.split(/\s+/).find((w: string) => /^[A-Z]/.test(w)) || 'Pet',
        species: /cat/i.test(details) ? 'cat' : 'dog', breed: null, created_at: nowIso(),
      });
      const hasPetRent = q1<any>(`SELECT id FROM lease_charges WHERE lease_id=? AND kind='pet_rent'`, x.lease_id);
      if (!hasPetRent) {
        insert('lease_charges', { id: id('lc'), org_id: ctx.orgId, lease_id: x.lease_id, kind: 'pet_rent', label: 'Pet rent', amount_cents: 3500, start_date: ctx.businessDate, created_at: nowIso() });
      }
    } else if (x.kind === 'vehicle') {
      insert('vehicles', { id: id('veh'), org_id: ctx.orgId, lease_id: x.lease_id, make: details.split(' ')[0] || 'Vehicle', model: details.split(' ').slice(1, 3).join(' ') || '—', plate: 'TBD', created_at: nowIso() });
    } else if (x.kind === 'occupant') {
      const rid = id('res');
      const lease = q1<any>('SELECT * FROM leases WHERE id=?', x.lease_id);
      insert('residents', {
        id: rid, org_id: ctx.orgId, property_id: lease.property_id, first_name: details.split(' ')[0] || 'New',
        last_name: details.split(' ')[1] || 'Occupant', kind: 'occupant', created_at: nowIso(),
      });
      insert('household_members', { id: id('hm'), org_id: ctx.orgId, lease_id: x.lease_id, resident_id: rid, role: 'occupant', created_at: nowIso() });
    }
    run("UPDATE household_requests SET status='approved', decided_by=?, decided_at=? WHERE id=?", ctx.userId, nowIso(), x.id);
    audit(ctx, 'household_request', x.id, 'approve', null, { kind: x.kind });
    emit(ctx, 'household.change_approved', 'lease', x.lease_id, { kind: x.kind });
    return redirect(`/leases/${x.lease_id}?tab=portal-requests`, `${x.kind} request approved${x.kind === 'pet' ? ' — pet rent added to the schedule' : ''}.`);
  });

  r.post('/staff/household-requests/:id/deny', requirePerm('residents:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const x = q1<any>('SELECT * FROM household_requests WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!x || x.status !== 'pending') return notFound();
    run("UPDATE household_requests SET status='denied', decided_by=?, decided_at=? WHERE id=?", ctx.userId, nowIso(), x.id);
    audit(ctx, 'household_request', x.id, 'deny');
    return redirect(`/leases/${x.lease_id}?tab=portal-requests`, 'Request denied.');
  });
}
