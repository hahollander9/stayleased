import { html, when } from '../../lib/html.ts';
import { redirect, forbidden, type Router, type Rq } from '../../lib/http.ts';
import { requireStaff, requirePerm, can, type Ctx } from '../../lib/auth.ts';
import { q1, run } from '../../lib/db.ts';
import { usd } from '../../lib/money.ts';
import { fmtDate, fmtMonth, assertDate } from '../../lib/dates.ts';
import { getSetting, setSetting } from '../../lib/settings.ts';
import { audit } from '../../lib/audit.ts';
import { on } from '../../lib/events.ts';
import { shell, card, tbl, emptyState } from '../../ui/ui.ts';
import { moneyApprovals, canApproveMoney } from '../m9_accounting/finops.ts';
import {
  monthEarnings, cashPosition, owedToYou, vacantUnits, notPaying, agentDrafts,
} from './service.ts';

/** Simple mode's home screen — phase 1.
 *
 * The five questions an owner of 5–100 units actually has, in the order they
 * have them, with each answer carrying the arithmetic that produced it. The
 * audit (docs/simple-mode-audit.md) found that all five were derivable from a
 * ledger that is genuinely good, and that none of them had a screen: "what did
 * I make" lived in /statements under NOI, "how much cash" in /gl under account
 * 1010, "who owes me" in /receivables under aging, and "which units cost me
 * money" nowhere at all.
 *
 * What this screen is not: a dashboard. There is no widget chooser, no
 * configuration, and no chart that does not answer one of the five. A screen
 * that must be set up before it pays out is a screen an owner abandons on the
 * first visit, which is the failure mode of the /dashboards page this one is
 * meant to make unnecessary.
 *
 * On honesty: every number here is the ledger's own answer, and where a figure
 * cannot be had the screen says so rather than estimating. An empty unit with
 * no lease history shows "empty" with no duration, because the vacancy date
 * does not exist for it. Rent still owed for this month is shown and
 * explicitly not counted in the cash arithmetic, because counting it would
 * require assuming a collection rate, and an assumption is not something the
 * books can vouch for.
 */

// A new org starts in simple mode; an existing one keeps the chrome it has.
// Writing the row explicitly (rather than flipping the SETTING_DEFAULTS value)
// is what makes that distinction possible at all: a setting with no row reads
// its default, so a default of true would have switched every live operator
// over on deploy.
on('org.created', (ctx) => setSetting(ctx, 'simple_mode', true));

export function simpleMode(ctx: Ctx): boolean {
  return getSetting<boolean>(ctx, 'simple_mode') === true;
}

/** The 12-month net strip. Bars scale on absolute value from a shared
 * baseline, and a losing month is toned rather than flipped, because the
 * question the strip answers is "is this month normal" and a bar that points
 * down reads as a different unit of measure at a glance. */
function strip(months: { month: string; net: number }[]): ReturnType<typeof html> {
  const max = Math.max(...months.map((m) => Math.abs(m.net)), 1);
  return html`<div class="sm-strip" role="img" aria-label="Net for each of the last twelve months">
    ${months.map((m) => html`<div class="sm-bar-wrap" title="${fmtMonth(m.month)}: ${usd(m.net)}">
      <div class="sm-bar ${m.net < 0 ? 'neg' : ''}" style="height:${Math.max(3, (Math.abs(m.net) / max) * 100).toFixed(1)}%"></div>
      <span class="sm-bar-label">${m.month.slice(5)}</span>
    </div>`)}
  </div>`;
}

/** A labelled subtraction. The product's billing page already established that
 * a number the reader cannot check is the one number they are asked to take on
 * faith; the same applies to every figure on this screen, so each one renders
 * its own working. */
function sum(terms: [string, number][], total: [string, number], opts?: { tone?: string }): ReturnType<typeof html> {
  return html`<div class="sm-sum">
    ${terms.map(([label, amount], i) => html`<div class="sm-term">
      <span class="sm-op">${i > 0 ? '−' : ''}</span>
      <span class="sm-term-label">${label}</span>
      <b class="sm-term-value">${usd(amount)}</b>
    </div>`)}
    <div class="sm-term sm-total ${opts?.tone || ''}">
      <span class="sm-op">=</span>
      <span class="sm-term-label">${total[0]}</span>
      <b class="sm-term-value">${usd(total[1])}</b>
    </div>
  </div>`;
}

export function homeScreen(rq: Rq): ReturnType<typeof shell> {
  const ctx = rq.ctx as Ctx;
  const pid = ctx.currentPropertyId || null;
  const earn = monthEarnings(ctx, pid);
  const cash = cashPosition(ctx, pid);
  const owed = owedToYou(ctx, pid);
  const empty = vacantUnits(ctx, pid);
  const behind = notPaying(ctx, pid);
  const drafts = can(ctx, 'ai:view') ? agentDrafts(ctx, pid) : [];
  const money = canApproveMoney(ctx) ? moneyApprovals(ctx) : null;
  const orgName = q1<{ name: string }>('SELECT name FROM orgs WHERE id=?', ctx.orgId)?.name || 'your properties';
  const needsOk = drafts.length + (money?.total || 0);
  const emptyLost = empty.reduce((s, u) => s + (u.rentLostCents || 0), 0);
  const canDecideAi = can(ctx, 'ai:approve');

  return shell(rq, {
    title: 'Home',
    active: '/home',
    bareHead: true,
    content: html`
      <div class="sm-head">
        <div class="sm-kicker">${orgName} · ${fmtDate(ctx.businessDate)}</div>
        <h1 class="sm-h1">Where you stand</h1>
        <p class="sm-sub">Counting money that actually came in and went out.
          ${when(can(ctx, 'admin:settings'), () => html`<a class="sm-advanced" href="/admin/settings">Switch to the full version</a>`)}</p>
      </div>

      ${card('What you made this month', html`
        ${sum(
          [['Came in', earn.collected], ['Went out', earn.paidOut]],
          ['You made', earn.net],
          { tone: earn.net < 0 ? 'bad' : 'good' },
        )}
        <p class="sm-note">
          ${earn.prevNet === 0
            ? 'No figure for last month to compare against.'
            : html`Last month, all of it: <b>${usd(earn.prevNet)}</b>.
                ${earn.net >= earn.prevNet
                  ? html`<span class="sm-pos">You are ahead of that pace so far.</span>`
                  : html`<span class="sm-neg">Behind that so far — the month is not over.</span>`}`}
        </p>
        ${strip(earn.strip)}
        <p class="sm-note sm-tie">The same figure, in full, is on
          <a href="/statements">Money in and out</a> — income statement, cash basis.</p>`)}

      ${card('What you have', html`
        <div class="sm-big ${cash.operating < 0 ? 'bad' : ''}">${usd(cash.operating)}<span class="sm-big-note">in the bank</span></div>
        ${when(cash.otherLines.length, () => html`<div class="sm-other">
          ${cash.otherLines.map((l) => html`<div class="sm-other-line">
            <b>${usd(l.amount)}</b> <span class="sm-other-label">${l.label}</span>
            <span class="sm-other-note">${l.note}</span>
          </div>`)}
        </div>`)}
        ${sum(
          [['In the bank', cash.operating], [`Bills due by ${fmtDate(cash.monthEnd)}${cash.billsCount ? ` (${cash.billsCount})` : ''}`, cash.billsDueByMonthEnd]],
          ['Left, if nothing else changes', cash.afterBills],
          { tone: cash.afterBills < 0 ? 'bad' : '' },
        )}
        <p class="sm-note">
          Rent still owed for this month: <b>${usd(cash.rentStillExpected)}</b>
          <span class="badge">not counted</span>
          <span class="sm-note-why">Counting it would mean assuming how much of it arrives, and that is a guess rather than something your books can show.</span>
        </p>`)}

      ${card(html`Who owes you${when(owed.households, () => html` <span class="badge warn">${owed.households}</span>`)}`, html`
        <div class="sm-big ${owed.total > 0 ? 'warn' : ''}">${usd(owed.total)}<span class="sm-big-note">across ${owed.households} resident${owed.households === 1 ? '' : 's'}</span></div>
        ${owed.households
          ? tbl(
              [{ label: 'Resident' }, { label: 'Unit' }, { label: 'Owes', num: true }, { label: 'Oldest unpaid' }],
              owed.top.map((r) => ({
                href: `/leases/${r.lease_id}`,
                cells: [
                  html`<b>${r.household_name}</b><span class="sub">${r.property_name}</span>`,
                  r.unit_number,
                  html`<b>${usd(r.balance)}</b>`,
                  r.oldest_due ? html`${fmtDate(r.oldest_due)}<span class="sub">${Math.max(0, Math.round((new Date(ctx.businessDate).getTime() - new Date(r.oldest_due).getTime()) / 86400000))} days</span>` : '—',
                ],
              })),
              { empty: '', sort: false },
            )
          : emptyState('Everyone is paid up', 'Nothing is outstanding as of today.')}
        ${owed.households > owed.top.length
          ? html`<p class="sm-note"><a href="/receivables">See all ${owed.households}</a></p>`
          : null}
        <p class="sm-note sm-tie">
          ${owed.ties
            ? html`Checked: every resident's balance added up matches what your books say is owed.`
            : html`<span class="sm-neg"><b>Your books and the resident balances do not agree.</b>
                Adding up every resident's balance comes to ${usd(owed.subledger)}; your books say
                ${usd(owed.glReceivable)}. That gap is worth looking into before it reaches a tax return —
                <a href="/gl">open the full accounts</a>.</span>`}
        </p>`)}

      ${card(html`Units costing you money${when(empty.length, () => html` <span class="badge warn">${empty.length} empty</span>`)}`, html`
        ${empty.length
          ? html`${when(emptyLost > 0, () => html`<div class="sm-big warn">${usd(emptyLost)}<span class="sm-big-note">rent not collected while empty, where the dates are known</span></div>`)}
            ${tbl(
              [{ label: 'Unit' }, { label: 'State' }, { label: 'Empty since' }, { label: 'Days', num: true }, { label: 'Rent not collected', num: true }],
              empty.slice(0, 8).map((u) => ({
                href: `/units/${u.id}`,
                cells: [
                  html`<b>${u.unitNumber}</b><span class="sub">${u.propertyName}</span>`,
                  u.status === 'vacant_ready'
                    ? html`<span class="badge ok">ready to rent</span>`
                    : html`<span class="badge warn">needs work</span>`,
                  u.since
                    ? html`${fmtDate(u.since)}${u.sinceSource === 'owner' ? html`<span class="sub">you entered this</span>` : null}`
                    : html`<span class="muted">not known</span>`,
                  u.daysEmpty === null ? html`<span class="muted">—</span>` : u.daysEmpty,
                  u.rentLostCents === null
                    ? html`<span class="muted">—</span>`
                    : html`<b>${usd(u.rentLostCents)}</b>`,
                ],
              })),
              { empty: '', sort: false },
            )}
            ${when(empty.length > 8, () => html`<p class="sm-note">
              <a href="/units?status=vacant_ready">See all ${empty.length} empty units</a></p>`)}
            ${when(empty.some((u) => !u.since), () => html`<p class="sm-note">
              Some of these have no move-out on record, so there is no date to count from and no figure to show.
              Opening the unit lets you enter when it went empty.</p>`)}`
          : emptyState('Nothing is sitting empty', 'Every unit is occupied or on notice.')}
        ${when(behind.length, () => html`
          <h3 class="sm-h3">Occupied, but not paying</h3>
          ${tbl(
            [{ label: 'Unit' }, { label: 'Resident' }, { label: 'Owes', num: true }],
            behind.slice(0, 5).map((r) => ({
              href: `/leases/${r.lease_id}`,
              cells: [r.unit_number, r.household_name, html`<b>${usd(r.balance)}</b>`],
            })),
            { empty: '', sort: false },
          )}
          ${when(behind.length > 5, () => html`<p class="sm-note"><a href="/receivables">See all ${behind.length}</a></p>`)}`)}
        <p class="sm-note sm-tie">A unit's own income and costs side by side is coming in a later pass; it needs a
          line for building-wide costs that are not split per unit, or the numbers would look like they add up to the
          building's total when they do not.</p>`)}

      ${card(html`Needs your OK${when(needsOk, () => html` <span class="badge warn">${needsOk}</span>`)}`, html`
        ${needsOk
          ? html`
            ${drafts.slice(0, 6).map((d) => html`<div class="sm-ok-item">
              <div class="sm-ok-tag msg">message</div>
              <div class="sm-ok-body">
                <b>${d.title}</b>
                ${when(d.detail, () => html`<span class="sub">${d.detail}</span>`)}
                ${when(d.rationale, () => html`<p class="sm-ok-why">${d.rationale}</p>`)}
                <span class="badge">${d.sureness}</span>
              </div>
              <div class="sm-ok-act">
                ${canDecideAi
                  ? html`<form method="post" action="/ai/${d.id}/approve"><input type="hidden" name="back" value="/home" /><button class="btn btn-sm">OK, send it</button></form>
                         <form method="post" action="/ai/${d.id}/reject"><input type="hidden" name="back" value="/home" /><button class="btn btn-ghost btn-sm">No</button></form>`
                  : html`<a class="btn btn-sm btn-ghost" href="/ai">Open</a>`}
              </div>
            </div>`)}
            ${(money?.invoices || []).map((i: any) => html`<div class="sm-ok-item">
              <div class="sm-ok-tag money">money</div>
              <div class="sm-ok-body"><b>Bill from ${i.vendor_name}</b><span class="sub">${i.prop_name} · due ${fmtDate(i.due_date)}</span></div>
              <div class="sm-ok-act"><b class="sm-ok-amt">${usd(i.total_cents)}</b>
                <form method="post" action="/ap/${i.id}/approve"><button class="btn btn-sm">OK, pay it</button></form></div>
            </div>`)}
            ${(money?.pos || []).map((po: any) => html`<div class="sm-ok-item">
              <div class="sm-ok-tag money">money</div>
              <div class="sm-ok-body"><b>Spending request — ${po.vendor_name}</b><span class="sub">${po.prop_name}${po.memo ? ` · ${po.memo}` : ''}</span></div>
              <div class="sm-ok-act"><b class="sm-ok-amt">${usd(po.total_cents)}</b>
                <a class="btn btn-sm" href="/purchasing/${po.id}">Review</a></div>
            </div>`)}
            ${(money?.deposits || []).map((d: any) => html`<div class="sm-ok-item">
              <div class="sm-ok-tag money">money</div>
              <div class="sm-ok-body"><b>Deposit to return — ${d.household_name}</b>
                <span class="sub">${d.prop_name} · ${d.dl.daysLeft < 0 ? `${-d.dl.daysLeft} days overdue by law` : `${d.dl.daysLeft} days left by law`}</span></div>
              <div class="sm-ok-act"><b class="sm-ok-amt">${usd(d.held)}</b>
                <a class="btn btn-sm" href="/leases/${d.id}?tab=deposit">Settle it</a></div>
            </div>`)}
            ${(money?.jes || []).map((j: any) => html`<div class="sm-ok-item">
              <div class="sm-ok-tag money">money</div>
              <div class="sm-ok-body"><b>Bookkeeping entry</b><span class="sub">${j.memo || '(no note)'} · entered by ${j.created_by || 'staff'}</span></div>
              <div class="sm-ok-act"><a class="btn btn-sm" href="/approvals">Review</a></div>
            </div>`)}`
          : emptyState('Nothing is waiting on you', 'Bills, spending and anything an agent wants to send will appear here first.')}
        ${when(drafts.length > 6, () => html`<p class="sm-note">
          <a href="/ai">${drafts.length - 6} more waiting for your OK</a></p>`)}
        <p class="sm-note sm-tie">Nothing reaches a resident or a vendor without your OK, unless you have
          set an agent to act on its own.</p>`)}`,
  });
}

export function routes(r: Router): void {
  r.get('/home', requireStaff, (rq) => {
    const ctx = rq.ctx as Ctx;
    if (!can(ctx, 'dashboard:view')) return forbidden();
    return homeScreen(rq);
  });

  // Owner-entered "empty since", for a unit with no move-out on record. Stored
  // with its source so the screen can label it as entered rather than
  // measured: a date someone recalled is not a date the books can show, and
  // the difference has to survive into the UI.
  r.post('/units/:id/vacant-since', requirePerm('units:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const unit = q1<any>(
      'SELECT u.id, u.property_id FROM units u WHERE u.id=? AND u.org_id=?',
      rq.params.id!, ctx.orgId,
    );
    if (!unit) return forbidden();
    if (!ctx.allProperties && !ctx.propertyIds.includes(unit.property_id)) return forbidden();
    const raw0 = String(rq.body.vacant_since || '').trim();
    if (!raw0) {
      run("UPDATE units SET vacant_since=NULL, vacant_since_source=NULL WHERE id=?", unit.id);
      return redirect(`/units/${unit.id}`, 'Cleared.');
    }
    let d: string;
    try {
      d = assertDate(raw0);
    } catch {
      return redirect(`/units/${unit.id}`, 'That is not a date we can read — use YYYY-MM-DD.', 'err');
    }
    if (d > ctx.businessDate) return redirect(`/units/${unit.id}`, 'A unit cannot have gone empty in the future.', 'err');
    run("UPDATE units SET vacant_since=?, vacant_since_source='owner' WHERE id=?", d, unit.id);
    audit(ctx, 'unit', unit.id, 'vacant_since', null, { vacant_since: d, source: 'owner' });
    return redirect(`/units/${unit.id}`, 'Saved — shown as a date you entered.');
  });
}
