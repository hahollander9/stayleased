import { html, raw, when, join } from '../../lib/html.ts';
import { redirect, notFound, type Router } from '../../lib/http.ts';
import { requirePerm, can, type Ctx } from '../../lib/auth.ts';
import { q, q1, val, insert, j, js } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso } from '../../lib/dates.ts';
import { fmtDate, addDays } from '../../lib/dates.ts';
import { usd, parseUsd } from '../../lib/money.ts';
import { putFile } from '../../lib/files.ts';
import {
  shell, card, tbl, dl, statusBadge, field, select, input, textarea, moneyInput, checkbox,
  registerNav, kpis, tabs, emptyState,
} from '../../ui/ui.ts';
import { lines as lineChart, bars } from '../../lib/charts.ts';
import {
  academicCalendar, bedRoster, assignBed, preLeasePacing, ROOMMATE_QUESTIONS, suggestGroups, matchScore,
  rentLimit, maxTenantRent, CERT_CHECKLIST, startCert, checkCertItem, completeCert,
  addToWaitlist, waitlistAction, bahTable, pcsBreak, camReconciliation, BED_LABELS,
} from './service.ts';
import { registerLeaseAction } from '../people/pages.ts';

/** M18 screens: the verticals hub, the student housing board (roster, pacing,
 * roommate matching), the affordable compliance center (certs, limits,
 * waitlist), the military toolkit, and the CAM worksheet. */

registerNav('Property', { href: '/student', label: 'Student housing', perm: 'leases:view', match: ['/student'] });
registerNav('Property', { href: '/affordable', label: 'Affordable', perm: 'leases:view', match: ['/affordable'] });
registerNav('Property', { href: '/verticals', label: 'Vertical modes', perm: 'admin:settings', match: ['/verticals'] });

// PCS break action on every active lease detail (military households live everywhere)
registerLeaseAction((ctx, lease) => {
  if (!['active', 'month_to_month'].includes(lease.status) || !can(ctx, 'leases:manage')) return null;
  return html`<details class="dropdown">
    <summary class="btn btn-ghost btn-sm">PCS lease break</summary>
    <div class="pop" style="min-width:340px">
      <form method="post" action="/verticals/pcs/${lease.id}" enctype="multipart/form-data">
        <p class="small muted">Permanent-change-of-station orders terminate the lease with <b>no early-termination fee</b> (30-day minimum).</p>
        ${field('Orders date', input('report_date', { type: 'date', required: true }))}
        ${field('Termination date', input('termination_date', { type: 'date', value: addDays(ctx.businessDate, 35), required: true }))}
        ${field('Orders document', html`<input type="file" name="orders" accept="application/pdf,image/*" />`)}
        <button class="btn btn-sm">Record PCS break (fee-free)</button>
      </form>
    </div>
  </details>`;
});

export function routes(r: Router): void {
  // ---------- STUDENT ----------
  r.get('/student', requirePerm('leases:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const props = q<any>(`SELECT * FROM properties WHERE org_id=? AND type='student' ORDER BY name`, ctx.orgId);
    if (!props.length) return shell(rq, { title: 'Student housing', active: '/student', content: emptyState('No student properties', 'Set a property\'s type to student to activate by-the-bed leasing.') });
    const prop = props.find((p) => p.id === rq.query.get('property')) || props[0]!;
    const cal = academicCalendar(ctx);
    const roster = bedRoster(ctx, prop.id);
    const pacing = preLeasePacing(ctx, prop.id);
    const groups = suggestGroups(ctx, prop.id);
    const view = rq.query.get('view') || 'board';
    const canManage = can(ctx, 'leases:manage');
    return shell(rq, {
      title: `Student housing — ${prop.name}`,
      active: '/student',
      subtitle: `By-the-bed individual liability leases · academic year ${cal.fallStart} → ${cal.fallEnd}`,
      wide: true,
      content: html`
        ${kpis([
          { label: 'Beds', value: String(pacing.totalBeds) },
          { label: 'Fall pre-leased', value: `${pacing.preleased} (${pacing.pct}%)`, tone: pacing.pct >= pacing.targetPct ? 'ok' : 'warn' },
          { label: 'Pacing target today', value: `${pacing.targetPct}%`, sub: pacing.pct >= pacing.targetPct ? 'ahead of curve' : 'behind curve' },
          { label: 'Unmatched applicants', value: String(groups.reduce((s, g) => s + g.members.length, 0)) },
        ])}
        ${tabs([
          { href: '/student', label: 'Assignment board', active: view === 'board' },
          { href: '/student?view=pacing', label: 'Pre-lease pacing', active: view === 'pacing' },
          { href: '/student?view=matching', label: 'Roommate matching', active: view === 'matching' },
        ])}
        ${view === 'pacing' ? pacingView(pacing) : view === 'matching' ? matchingView(groups, canManage) : boardView(roster, cal, canManage)}`,
    });
  });

  function pacingView(p: ReturnType<typeof preLeasePacing>): ReturnType<typeof html> {
    return html`${card('Pre-lease velocity vs target (fall start)', lineChart(
      p.curve.map((x) => x.week.slice(5)),
      [
        { name: 'Pre-leased %', tone: 'accent', points: p.curve.map((x) => x.cumulative) },
        { name: 'Target %', tone: 'warn', points: p.curve.map((x) => x.target) },
      ],
      { height: 220 },
    ))}
    <p class="small muted">Target ramps linearly Feb 1 → fall start to 95%. The M13 exposure factor treats unleased fall beds as availability.</p>`;
  }

  function matchingView(groups: { members: any[]; avgScore: number }[], canManage: boolean): ReturnType<typeof html> {
    return html`
      ${card('How matching works', html`<p class="small">Applicants answer ${ROOMMATE_QUESTIONS.length} questions (${ROOMMATE_QUESTIONS.map((qn) => qn.label.toLowerCase()).join(', ')}). Compatibility = matching answers. Groupings are suggestions — staff assign beds.</p>`)}
      ${groups.length === 0 ? emptyState('No unassigned questionnaires', 'Profiles appear here as student applications come in.') : join(groups.map((g, i) => card(
        html`Suggested group ${i + 1} <span class="badge ${g.avgScore >= 60 ? 'ok' : 'warn'}">${g.avgScore}% compatible</span>`,
        tbl(
          [{ label: 'Applicant' }, ...ROOMMATE_QUESTIONS.map((qn) => ({ label: qn.label }))],
          g.members.map((m) => {
            const a = j<Record<string, string>>(m.answers, {});
            return { cells: [html`<b>${m.person_name}</b>`, ...ROOMMATE_QUESTIONS.map((qn) => a[qn.key] || '—')] };
          }),
        ),
      )))}
      ${when(canManage, () => card('Add a questionnaire', html`<form method="post" action="/student/profile" class="toolbar">
        ${field('Applicant name', input('name', { required: true }))}
        ${ROOMMATE_QUESTIONS.map((qn) => field(qn.label, select(qn.key, qn.options.map((o): [string, string] => [o, o]))))}
        <button class="btn btn-sm">Save</button>
      </form>`))}`;
  }

  function boardView(roster: ReturnType<typeof bedRoster>, cal: { fallStart: string; fallEnd: string }, canManage: boolean): ReturnType<typeof html> {
    return html`<div class="grid cols-2">${roster.map((u) => card(
      html`${u.unit.unit_number} <span class="muted small">${u.unit.fp} · ${u.beds} beds</span> ${statusBadge(u.unit.status)}`,
      html`<table class="tbl"><thead><tr><th>Bed</th><th>Now</th><th>Fall ${cal.fallStart.slice(0, 4)}</th></tr></thead><tbody>
        ${u.slots.map((s) => html`<tr>
          <td><b>${s.bedLabel}</b></td>
          <td>${s.current ? html`<a href="/leases/${s.current.id}">${s.current.who || s.current.household_name}</a>${s.current.bed_label ? '' : html` <span class="badge">joint</span>`}` : html`<span class="muted">vacant</span>`}</td>
          <td>${s.fall
            ? html`<a href="/leases/${s.fall.id}">${s.fall.who || s.fall.household_name}</a> ${statusBadge(s.fall.status)}`
            : canManage
              ? html`<details class="dropdown"><summary class="btn btn-sm btn-ghost">Assign bed</summary>
                  <div class="pop" style="min-width:300px"><form method="post" action="/student/assign">
                    <input type="hidden" name="unit_id" value="${u.unit.id}" />
                    <input type="hidden" name="bed" value="${s.bedLabel}" />
                    ${field('First name', input('first_name', { required: true }))}
                    ${field('Last name', input('last_name', { required: true }))}
                    ${field('Email', input('email', { type: 'email', required: true }))}
                    ${field('Rent / bed / month', moneyInput('rent', 89900, { required: true }))}
                    ${field('Start', select('start', [[cal.fallStart, `Fall (${cal.fallStart})`], ['now', 'Immediate move-in']]))}
                    ${field('Parent / guarantor name', input('g_name'))}
                    ${field('Parent / guarantor email', input('g_email', { type: 'email' }))}
                    <button class="btn btn-sm">Create individual lease</button>
                  </form></div>
                </details>`
              : html`<span class="muted">open</span>`}</td>
        </tr>`)}
      </tbody></table>`,
    ))}</div>`;
  }

  r.post('/student/assign', requirePerm('leases:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    try {
      const leaseId = assignBed(ctx, {
        unitId: String(rq.body.unit_id),
        bedLabel: String(rq.body.bed),
        firstName: String(rq.body.first_name),
        lastName: String(rq.body.last_name),
        email: String(rq.body.email),
        rentCents: parseUsd(String(rq.body.rent)),
        startDate: rq.body.start === 'now' ? ctx.businessDate : String(rq.body.start),
        guarantor: rq.body.g_email ? { name: String(rq.body.g_name || 'Guarantor'), email: String(rq.body.g_email) } : null,
      });
      return redirect('/student', `Individual liability lease created for bed ${rq.body.bed} — activates on move-in (${leaseId.slice(-6)}).`);
    } catch (e) {
      return redirect('/student', (e as Error).message, 'err');
    }
  });

  r.post('/student/profile', requirePerm('leases:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const prop = q1<any>(`SELECT id FROM properties WHERE org_id=? AND type='student' LIMIT 1`, ctx.orgId);
    if (!prop) return notFound('No student property');
    const answers: Record<string, string> = {};
    for (const qn of ROOMMATE_QUESTIONS) answers[qn.key] = String(rq.body[qn.key] || qn.options[0]);
    insert('roommate_profiles', {
      id: id('rmp'), org_id: ctx.orgId, property_id: prop.id, application_id: null,
      person_name: String(rq.body.name || 'Applicant'), answers: js(answers), created_at: nowIso(),
    });
    return redirect('/student?view=matching', 'Questionnaire saved.');
  });

  // ---------- AFFORDABLE ----------
  r.get('/affordable', requirePerm('leases:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const programUnits = q<any>(
      `SELECT u.*, f.beds AS fp_beds, f.name AS fp, p.name AS prop, p.id AS prop_id,
         (SELECT l.id FROM leases l WHERE l.unit_id=u.id AND l.status IN ('active','month_to_month','notice') LIMIT 1) AS active_lease,
         (SELECT l.rent_cents FROM leases l WHERE l.unit_id=u.id AND l.status IN ('active','month_to_month','notice') LIMIT 1) AS rent
       FROM units u JOIN floorplans f ON f.id=u.floorplan_id JOIN properties p ON p.id=u.property_id
       WHERE u.org_id=? AND u.program IS NOT NULL ORDER BY p.name, u.unit_number`,
      ctx.orgId,
    );
    if (!programUnits.length) return shell(rq, { title: 'Affordable housing', active: '/affordable', content: emptyState('No program units', 'Flag units with a program (LIHTC / Section 8) to activate compliance workflows.') });
    const view = rq.query.get('view') || 'compliance';
    const certs = q<any>(
      `SELECT ic.*, u.unit_number FROM income_certs ic JOIN units u ON u.id=ic.unit_id
       WHERE ic.org_id=? ORDER BY ic.status='complete', COALESCE(ic.due_date, ic.created_at)`,
      ctx.orgId,
    );
    const openCerts = certs.filter((c) => c.status !== 'complete');
    const propId = programUnits[0]!.prop_id;
    const waitlist = q<any>(`SELECT * FROM waitlist_entries WHERE org_id=? AND property_id=? ORDER BY position`, ctx.orgId, propId);
    const overdue = openCerts.filter((c) => c.due_date && c.due_date < ctx.businessDate);
    const limits = q<any>('SELECT * FROM rent_limits WHERE org_id=? ORDER BY ami_pct, beds', ctx.orgId);
    const canManage = can(ctx, 'leases:manage');
    return shell(rq, {
      title: 'Affordable housing compliance',
      active: '/affordable',
      subtitle: `${programUnits.length} set-aside units at ${programUnits[0]!.prop} · income certification gates move-in · rent limits enforced everywhere`,
      wide: true,
      content: html`
        ${kpis([
          { label: 'Program units', value: String(programUnits.length), sub: `LIHTC set-aside (${[...new Set(programUnits.map((u) => u.ami_pct))].sort().map((a) => a + '%').join(' / ')} AMI)` },
          { label: 'Open certifications', value: String(openCerts.length), tone: openCerts.length ? 'warn' : 'ok' },
          { label: 'Overdue recerts', value: String(overdue.length), tone: overdue.length ? 'bad' : 'ok' },
          { label: 'Waitlist', value: String(waitlist.filter((w) => w.status === 'active').length), sub: 'audit-safe ordering' },
        ])}
        ${tabs([
          { href: '/affordable', label: 'Unit compliance', active: view === 'compliance' },
          { href: '/affordable?view=certs', label: 'Certifications', active: view === 'certs', count: openCerts.length },
          { href: '/affordable?view=waitlist', label: 'Waitlist', active: view === 'waitlist' },
          { href: '/affordable?view=limits', label: 'Rent limits', active: view === 'limits' },
        ])}
        ${view === 'certs' ? certsView(ctx, openCerts, certs, canManage)
          : view === 'waitlist' ? waitlistView(waitlist, canManage)
          : view === 'limits' ? limitsView(limits)
          : complianceView(ctx, programUnits)}`,
    });
  });

  function complianceView(ctx: Ctx, units: any[]): ReturnType<typeof html> {
    return tbl(
      [{ label: 'Unit' }, { label: 'Program' }, { label: 'Set-aside' }, { label: 'Current rent', num: true }, { label: 'Max tenant rent', num: true }, { label: 'Headroom', num: true }, { label: 'Utility allowance', num: true }, { label: 'Cert status' }],
      units.map((u) => {
        const max = maxTenantRent(ctx, u);
        const cert = q1<any>(
          `SELECT * FROM income_certs WHERE unit_id=? ORDER BY created_at DESC LIMIT 1`, u.id,
        );
        return {
          href: u.active_lease ? `/leases/${u.active_lease}` : `/units/${u.id}`,
          cells: [
            html`<b>${u.unit_number}</b> <span class="muted small">${u.fp}</span>`,
            statusBadge('active', u.program.toUpperCase()),
            `${u.ami_pct}% AMI`,
            u.rent ? usd(u.rent) : html`<span class="muted">vacant</span>`,
            max !== null ? usd(max) : '—',
            u.rent && max !== null ? html`<span class="${max - u.rent >= 0 ? 'pos' : 'neg'}">${usd(max - u.rent)}</span>` : '—',
            usd(u.utility_allowance_cents || 0),
            cert
              ? cert.status === 'complete'
                ? statusBadge('ok', `certified ${cert.kind}`)
                : statusBadge('pending', `${cert.kind} in progress`)
              : statusBadge('overdue', 'no cert on file'),
          ],
        };
      }),
    );
  }

  function certsView(ctx: Ctx, open: any[], all: any[], canManage: boolean): ReturnType<typeof html> {
    return html`
      ${open.length === 0 ? emptyState('No open certifications') : join(open.map((c) => {
        const list = j<{ item: string; done: boolean }[]>(c.checklist, []);
        const doneCount = list.filter((x) => x.done).length;
        return card(
          html`${c.unit_number} — ${c.kind} certification ${statusBadge(c.due_date && c.due_date < ctx.businessDate ? 'overdue' : 'pending', c.due_date && c.due_date < ctx.businessDate ? 'OVERDUE' : `due ${fmtDate(c.due_date)}`)}`,
          html`
            ${dl([
              ['Household size', String(c.household_size)],
              ['Stated annual income', usd(c.household_income_cents)],
              ['Checklist', `${doneCount}/${list.length} complete`],
            ])}
            ${when(canManage, () => html`
              <form method="post" action="/affordable/certs/${c.id}/check" style="margin:8px 0">
                ${list.map((item, i) => html`<label class="check" style="display:block;margin:4px 0">
                  <input type="checkbox" name="item_${i}" value="1" ${item.done ? 'checked' : ''} onchange="this.form.submit()" /> <span>${item.item}</span>
                </label>`)}
              </form>
              <form method="post" action="/affordable/certs/${c.id}/complete">
                <button class="btn" ${doneCount < list.length ? 'disabled' : ''}>Certify household (income-qualify)</button>
                <span class="small muted"> — blocks unless every document is in and income fits the ${'≤'}${q1<any>('SELECT ami_pct FROM units WHERE id=?', c.unit_id)?.ami_pct}% AMI band</span>
              </form>`)}`,
        );
      }))}
      ${card('History', tbl(
        [{ label: 'Unit' }, { label: 'Kind' }, { label: 'Status' }, { label: 'Band' }, { label: 'Completed' }, { label: 'By' }],
        all.filter((c) => c.status === 'complete').slice(0, 20).map((c) => ({
          cells: [c.unit_number, c.kind, statusBadge('ok', 'complete'), c.ami_pct ? `${c.ami_pct}% AMI` : '—', c.completed_at ? fmtDate(c.completed_at.slice(0, 10)) : '—', c.completed_by || '—'],
        })),
        { empty: 'None yet.' },
      ))}`;
  }

  function waitlistView(entries: any[], canManage: boolean): ReturnType<typeof html> {
    return html`
      ${card('Audit-safe ordering', html`<p class="small">Positions never renumber. Offers must follow order; skipping anyone requires a written reason and lands in the audit log — the compliance answer to "why was #4 housed before #2?" is always on file.</p>`)}
      ${tbl(
        [{ label: '#' }, { label: 'Household' }, { label: 'Size' }, { label: 'Income', num: true }, { label: 'Preferences' }, { label: 'Status' }, { label: '' }],
        entries.map((w) => ({
          cells: [
            html`<b>${w.position}</b>`, html`${w.name}<span class="sub">${w.email || w.phone || ''}</span>`,
            String(w.household_size), usd(w.income_cents),
            Object.entries(j<Record<string, unknown>>(w.preferences, {})).map(([k, v]) => `${k}: ${v}`).join(', ') || '—',
            w.status === 'skipped' ? html`${statusBadge('hold', 'skipped')} <span class="small muted">${w.skip_reason}</span>` : statusBadge(w.status),
            canManage && w.status === 'active'
              ? html`<div style="display:flex;gap:4px">
                  <form method="post" action="/affordable/waitlist/${w.id}/offer"><button class="btn btn-sm">Offer</button></form>
                  <details class="dropdown"><summary class="btn btn-sm btn-ghost">Skip</summary>
                    <div class="pop"><form method="post" action="/affordable/waitlist/${w.id}/skip">
                      ${field('Reason (audited)', input('reason', { required: true, placeholder: 'e.g. needs 3BR; only 1BR available' }))}
                      <button class="btn btn-sm">Skip with reason</button>
                    </form></div>
                  </details>
                </div>`
              : '',
          ],
        })),
        { empty: 'Waitlist is empty.' },
      )}
      ${when(canManage, () => card('Add to waitlist', html`<form method="post" action="/affordable/waitlist" class="toolbar">
        ${field('Name', input('name', { required: true }))}
        ${field('Email', input('email', { type: 'email' }))}
        ${field('Household size', select('size', [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5']]))}
        ${field('Annual income', moneyInput('income', 4200000))}
        ${field('Needs', input('needs', { placeholder: 'e.g. 2BR, accessible' }))}
        <button class="btn btn-sm">Add</button>
      </form>`))}`;
  }

  function limitsView(limits: any[]): ReturnType<typeof html> {
    return card('Maximum gross rents by AMI band (deterministic schedule)', html`
      ${tbl(
        [{ label: 'AMI band' }, { label: 'Studio', num: true }, { label: '1 BR', num: true }, { label: '2 BR', num: true }, { label: '3 BR', num: true }],
        [50, 60, 80].map((ami) => ({
          cells: [
            html`<b>${ami}% AMI</b>`,
            ...[0, 1, 2, 3].map((beds) => {
              const l = limits.find((x) => x.ami_pct === ami && x.beds === beds);
              return l ? usd(l.max_rent_cents) : '—';
            }),
          ],
        })),
      )}
      <p class="small muted">Tenant-paid rent may not exceed the limit minus the unit's utility allowance. Enforced at lease activation, renewal offers, and the pricing engine (program units are never engine-priced).</p>`);
  }

  r.post('/affordable/certs/:id/check', requirePerm('leases:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const cert = q1<any>('SELECT * FROM income_certs WHERE id=? AND org_id=?', rq.params.id, ctx.orgId);
    if (!cert) return notFound('cert not found');
    const list = j<{ item: string; done: boolean }[]>(cert.checklist, []);
    for (let i = 0; i < list.length; i++) checkCertItem(ctx, cert.id, i, !!rq.body[`item_${i}`]);
    return redirect('/affordable?view=certs', 'Checklist updated.');
  });

  r.post('/affordable/certs/:id/complete', requirePerm('leases:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    try {
      completeCert(ctx, rq.params.id!);
      return redirect('/affordable?view=certs', 'Household certified — move-in unblocked.');
    } catch (e) {
      return redirect('/affordable?view=certs', (e as Error).message, 'err');
    }
  });

  r.post('/affordable/waitlist', requirePerm('leasing:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const prop = q1<any>(`SELECT DISTINCT property_id FROM units WHERE org_id=? AND program IS NOT NULL LIMIT 1`, ctx.orgId);
    addToWaitlist(ctx, {
      propertyId: prop.property_id, name: String(rq.body.name), email: String(rq.body.email || '') || undefined,
      householdSize: parseInt(String(rq.body.size || '1'), 10), incomeCents: rq.body.income ? parseUsd(String(rq.body.income)) : 0,
      preferences: rq.body.needs ? { needs: String(rq.body.needs) } : {},
    });
    return redirect('/affordable?view=waitlist', 'Added to the bottom of the list (ordering is immutable).');
  });

  r.post('/affordable/waitlist/:id/offer', requirePerm('leasing:manage'), (rq) => {
    try {
      waitlistAction(rq.ctx as Ctx, rq.params.id!, 'offer');
      return redirect('/affordable?view=waitlist', 'Offered — next step is an application.');
    } catch (e) {
      return redirect('/affordable?view=waitlist', (e as Error).message, 'err');
    }
  });

  r.post('/affordable/waitlist/:id/skip', requirePerm('leasing:manage'), (rq) => {
    try {
      waitlistAction(rq.ctx as Ctx, rq.params.id!, 'skip', String(rq.body.reason || ''));
      return redirect('/affordable?view=waitlist', 'Skipped with a documented reason (audited).');
    } catch (e) {
      return redirect('/affordable?view=waitlist', (e as Error).message, 'err');
    }
  });

  // ---------- MILITARY + COMMERCIAL + hub ----------
  r.post('/verticals/pcs/:leaseId', requirePerm('leases:manage'), (rq) => {
    const ctx = rq.ctx as Ctx;
    try {
      let ordersFileId: string | null = null;
      const up = rq.uploads.find((u) => u.field === 'orders' && u.data.length > 0);
      if (up) {
        ordersFileId = putFile(ctx, up.data, { name: up.filename || 'pcs-orders.pdf', mime: up.mime, entity: 'lease', entityId: rq.params.leaseId }).id;
      }
      pcsBreak(ctx, {
        leaseId: rq.params.leaseId!,
        reportDate: String(rq.body.report_date),
        terminationDate: String(rq.body.termination_date),
        ordersFileId,
      });
      return redirect(`/leases/${rq.params.leaseId}`, 'PCS break recorded — notice set, NO early-termination fee, resident notified.');
    } catch (e) {
      return redirect(`/leases/${rq.params.leaseId}`, (e as Error).message, 'err');
    }
  });

  r.get('/verticals', requirePerm('admin:settings'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const props = q<any>('SELECT * FROM properties WHERE org_id=? ORDER BY name', ctx.orgId);
    const bah = bahTable(ctx);
    const pcs = q<any>(
      `SELECT pb.*, l.household_name FROM pcs_breaks pb JOIN leases l ON l.id=pb.lease_id WHERE pb.org_id=? ORDER BY pb.created_at DESC LIMIT 8`,
      ctx.orgId,
    );
    return shell(rq, {
      title: 'Vertical modes',
      active: '/verticals',
      subtitle: 'One codebase — each vertical is conditional behavior on the property type, never a fork.',
      content: html`
        ${card('Property modes', tbl(
          [{ label: 'Property' }, { label: 'Type' }, { label: 'What changes' }],
          props.map((p) => ({
            cells: [
              html`<b>${p.name}</b>`, statusBadge(p.type === 'multifamily' ? 'active' : 'violet', p.type),
              p.type === 'student' ? 'By-the-bed individual leases, academic terms, roommate matching, pacing, guarantor portal'
                : q1<any>(`SELECT COUNT(*) n FROM units WHERE property_id=? AND program IS NOT NULL`, p.id)?.n
                  ? `${q1<any>(`SELECT COUNT(*) n FROM units WHERE property_id=? AND program IS NOT NULL`, p.id)?.n} LIHTC set-aside units — certification gating + rent limits + waitlist`
                  : 'Standard multifamily behavior',
            ],
          })),
        ))}
        <div class="grid cols-2">
          ${card('Military toolkit', html`
            <p class="small">PCS lease breaks are available on every lease detail (fee-free, orders on file, audited). Allotment-style payments ride autopay. BAH reference (simulated ${new Date('2026-01-01').getFullYear()} schedule):</p>
            ${tbl(
              [{ label: 'Grade' }, { label: 'With dependents', num: true }, { label: 'Without', num: true }],
              Object.entries(bah).map(([grade, v]) => ({ cells: [grade, usd((v as any).with_deps), usd((v as any).without_deps)] })),
            )}
            ${when(pcs.length, () => html`<p class="small" style="margin-top:8px"><b>PCS breaks on file:</b> ${pcs.map((x) => `${x.household_name} → ${fmtDate(x.termination_date)}`).join(' · ')}</p>`)}`)}
          ${card('Commercial — CAM reconciliation worksheet', html`
            <form method="get" action="/verticals/cam" class="toolbar">
              ${field('Property', select('property', props.map((p): [string, string] => [p.id, p.name])))}
              ${field('Year', select('year', [['2026', '2026'], ['2025', '2025']]))}
              <button class="btn btn-sm">Open worksheet</button>
            </form>
            <p class="small muted">Budgeted vs actual operating expenses → per-suite true-up by square footage. Posting requires a commercial property type (none in the demo portfolio — preview mode; logged as a gap).</p>`)}
        </div>
        ${card('Manufactured housing', html`<p class="small">Lot-rent/home-rent split, resident-owned-home flags and title/serial fields ship on the unit record (schema + unit page) and activate with a manufactured property type. No manufactured community in the demo portfolio — logged as a gap in docs/parity.md.</p>`)}`,
    });
  });

  r.get('/verticals/cam', requirePerm('gl:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const props = q<any>('SELECT * FROM properties WHERE org_id=? ORDER BY name', ctx.orgId);
    const propId = rq.query.get('property') || props[0]?.id;
    const year = parseInt(rq.query.get('year') || String(new Date(ctx.businessDate).getFullYear()), 10);
    const cam = camReconciliation(ctx, propId!, year);
    return shell(rq, {
      title: 'CAM reconciliation worksheet',
      active: '/verticals',
      crumbs: [['Vertical modes', '/verticals']],
      subtitle: `Budgeted vs actual operating expenses, allocated by leased square footage · FY${year}`,
      content: html`
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Property', select('property', props.map((p): [string, string] => [p.id, p.name]), propId))}
          ${field('Year', select('year', [['2026', '2026'], ['2025', '2025']], String(year)))}
        </form>
        ${kpis([
          { label: 'Budgeted OpEx (5xxx)', value: usd(cam.budgetedOpex) },
          { label: 'Actual OpEx', value: usd(cam.actualOpex) },
          { label: 'Variance to allocate', value: usd(cam.actualOpex - cam.budgetedOpex), tone: cam.actualOpex > cam.budgetedOpex ? 'warn' : 'ok' },
          { label: 'Posting', value: cam.postable ? 'enabled' : 'preview only', sub: cam.postable ? 'commercial property' : 'requires commercial type', tone: cam.postable ? 'ok' : undefined },
        ])}
        ${tbl(
          [{ label: 'Suite' }, { label: 'Tenant' }, { label: 'Sqft', num: true }, { label: 'Share', num: true }, { label: 'Budgeted CAM', num: true }, { label: 'Actual share', num: true }, { label: 'True-up', num: true }],
          cam.rows.slice(0, 60).map((r2) => ({
            cells: [r2.suite, r2.tenant.slice(0, 30), String(r2.sqft), `${r2.sharePct}%`, usd(r2.budgetedCam), usd(r2.actualShare),
              html`<span class="${r2.trueUp >= 0 ? 'neg' : 'pos'}">${r2.trueUp >= 0 ? usd(r2.trueUp) + ' invoice' : usd(-r2.trueUp) + ' credit'}</span>`],
          })),
          { empty: 'No active leases.' },
        )}
        <p class="small muted">Shown for the first 60 suites. True-ups post as ledger charges/credits when the property type is commercial.</p>`,
    });
  });
}
