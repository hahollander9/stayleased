import { html, raw, when, join } from '../../lib/html.ts';
import {
  redirect, notFound, forbidden, fileRes, type Router, type Rq, badRequest,
} from '../../lib/http.ts';
import {
  requirePerm, requireUser, devOnly, hashPassword, tempPassword, type Ctx, sysCtx, requireStaff,
} from '../../lib/auth.ts';
import { q, q1, run, insert, j, js, val, update } from '../../lib/db.ts';
import { id, token } from '../../lib/ids.ts';
import { nowIso, fmtDate, fmtTs, addDays } from '../../lib/dates.ts';
import { audit } from '../../lib/audit.ts';
import { getSetting, setSetting, SETTING_DEFAULTS } from '../../lib/settings.ts';
import { advanceBusinessDate, jobDefs, runJob, ensureJobRows } from '../../lib/jobs.ts';
import { getDials, setDials, DEFAULT_DIALS, type Dials } from '../../lib/sim/dials.ts';
import { receiveInbound } from '../../lib/sim/messaging.ts';
import { getFile, canDownload } from '../../lib/files.ts';
import {
  shell, card, tbl, kpis, dl, tabs, statusBadge, field, input, select, textarea,
  registerNav, registerSearch, emptyState, pager, checkbox,
} from '../../ui/ui.ts';
import { ROLES, ROLE_LABELS, ROLE_PERMS, PERMISSIONS, type Role } from '../../lib/rbac.ts';
import { deliverWebhooks, emit } from '../../lib/events.ts';
import { createHash } from 'node:crypto';
import { expandPerms } from '../../lib/rbac.ts';
import { historyPanel } from '../../ui/ui.ts';

registerNav('Admin', { href: '/admin/staff', label: 'Staff & roles', perm: 'admin:staff' });
registerNav('Admin', { href: '/admin/settings', label: 'Settings', perm: 'admin:settings' });
registerNav('Admin', { href: '/admin/audit', label: 'Audit log', perm: 'admin:audit' });
registerNav('Admin', { href: '/admin/jobs', label: 'Scheduled jobs', perm: 'admin:jobs' });
registerNav('Admin', { href: '/admin/api', label: 'API & webhooks', perm: 'admin:api' });
registerNav('Developer', { href: '/dev/sim', label: 'Simulator console', perm: 'dev:console', demoOnly: true });
registerNav('Developer', { href: '/dev/messages', label: 'Message console', perm: 'dev:console' });

registerSearch((ctx, query) => {
  if (!ctx.perms.has('admin:staff')) return [];
  const like = `%${query}%`;
  return q<any>(
    `SELECT id, name, email, kind FROM users WHERE org_id=? AND (name LIKE ? OR email LIKE ?) AND kind IN ('staff') LIMIT 5`,
    ctx.orgId, like, like,
  ).map((u) => ({ kind: 'staff', label: u.name, sub: u.email, href: `/admin/staff/${u.id}` }));
});

export function routes(r: Router): void {
  // ---------- staff & roles ----------
  r.get('/admin/staff', requirePerm('admin:staff'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const staff = q<any>(
      `SELECT u.*, (SELECT GROUP_CONCAT(role, ', ') FROM role_assignments ra WHERE ra.user_id=u.id) AS roles
       FROM users u WHERE u.org_id=? AND u.kind='staff' ORDER BY u.name`,
      ctx.orgId,
    );
    return shell(rq, {
      title: 'Staff & roles',
      active: '/admin/staff',
      actions: html`<a class="btn" href="/admin/staff/new">Invite staff</a> <a class="btn btn-ghost" href="/admin/roles">Permission matrix</a>`,
      content: card(
        null,
        tbl(
          [{ label: 'Name' }, { label: 'Email' }, { label: 'Roles' }, { label: 'Scope' }, { label: 'Status' }, { label: 'Last login' }],
          staff.map((u) => {
            const grants = q<any>('SELECT * FROM role_assignments WHERE user_id=?', u.id);
            const scope = grants.some((g) => g.scope_type === 'org')
              ? 'All properties'
              : [...new Set(grants.flatMap((g) => j<string[]>(g.property_ids, [])))]
                  .map((pid) => val<string>('SELECT name FROM properties WHERE id=?', pid) || '?')
                  .join(', ') || '—';
            return {
              href: `/admin/staff/${u.id}`,
              cells: [
                html`<b>${u.name}</b>`,
                u.email,
                u.roles ? u.roles.split(', ').map((x: string) => ROLE_LABELS[x as Role] ?? x).join(', ') : '—',
                scope,
                statusBadge(u.active ? 'active' : 'inactive'),
                u.last_login_at ? fmtTs(u.last_login_at) : 'never',
              ],
            };
          }),
          { empty: 'No staff yet — invite your team.' },
        ),
        { flush: true },
      ),
    });
  });

  const staffForm = (rq: Rq, u?: any, grants?: any[]): ReturnType<typeof card> => {
    const ctx = rq.ctx as Ctx;
    const props = q<any>('SELECT id, name FROM properties WHERE org_id=? ORDER BY name', ctx.orgId);
    const grant = grants?.[0];
    const scopeIds = grant ? j<string[]>(grant.property_ids, []) : [];
    return card(
      u ? 'Edit staff member' : 'Invite staff member',
      html`<form method="post" action="${u ? `/admin/staff/${u.id}` : '/admin/staff/new'}">
        <div class="form-grid">
          ${field('Full name', input('name', { value: u?.name, required: true }))}
          ${field('Email', input('email', { value: u?.email, type: 'email', required: true }))}
          ${field('Phone', input('phone', { value: u?.phone ?? '', type: 'tel' }))}
          ${field('Role', select('role', ROLES.filter((x) => !['RESIDENT', 'APPLICANT', 'GUARANTOR', 'VENDOR', 'PLATFORM_ADMIN'].includes(x)).map((x) => [x, ROLE_LABELS[x]]), grant?.role ?? 'LEASING_AGENT', { required: true }))}
          ${field('Scope', select('scope_type', [['org', 'Entire organization'], ['properties', 'Specific properties']], grant?.scope_type ?? 'org'))}
          ${field('Properties (if scoped)', html`<select name="property_ids[]" multiple size="3">${props.map((p) => html`<option value="${p.id}" ${scopeIds.includes(p.id) ? 'selected' : ''}>${p.name}</option>`)}</select>`)}
          ${u ? field('Status', select('active', [['1', 'Active'], ['0', 'Deactivated']], String(u.active))) : null}
        </div>
        <div class="btn-row">
          <button class="btn">${u ? 'Save changes' : 'Create account'}</button>
          <a class="btn btn-ghost" href="/admin/staff">Cancel</a>
          ${u
            ? html`<span class="muted small">${(rq.ctx as Ctx).orgKind === 'live' ? 'Password resets generate a one-time password shown to you once.' : 'Password resets to demo1234 only on request below.'}</span>`
            : html`<span class="muted small">${(rq.ctx as Ctx).orgKind === 'live' ? 'A one-time password is generated and shown to you once — share it securely.' : html`New accounts get password <code>demo1234</code> (demo build).`}</span>`}
        </div>
      </form>`,
    );
  };

  r.get('/admin/staff/new', requirePerm('admin:staff'), (rq) =>
    shell(rq, { title: 'Invite staff', active: '/admin/staff', crumbs: [['Staff & roles', '/admin/staff']], content: staffForm(rq) }),
  );

  r.post('/admin/staff/new', requirePerm('admin:staff'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const email = String(rq.body.email || '').trim().toLowerCase();
    if (q1('SELECT id FROM users WHERE email=?', email)) return redirect('/admin/staff/new', 'That email is already in use.', 'err');
    const uid = id('usr');
    const live = ctx.orgKind === 'live';
    const pw = live ? tempPassword() : 'demo1234';
    insert('users', {
      id: uid, org_id: ctx.orgId, email, name: String(rq.body.name || '').trim(), phone: rq.body.phone || null,
      kind: 'staff', password_hash: hashPassword(pw), active: 1, created_at: nowIso(),
    });
    saveGrant(ctx, uid, rq);
    audit(ctx, 'user', uid, 'create', null, { email, name: rq.body.name, role: rq.body.role });
    return redirect(`/admin/staff/${uid}`, live
      ? `Staff member created. One-time password (share securely, shown only now): ${pw}`
      : 'Staff member created (password demo1234).');
  });

  r.get('/admin/staff/:id', requirePerm('admin:staff'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const u = q1<any>('SELECT * FROM users WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!u) return notFound('Staff member not found');
    const grants = q<any>('SELECT * FROM role_assignments WHERE user_id=?', u.id);
    return shell(rq, {
      title: u.name,
      active: '/admin/staff',
      crumbs: [['Staff & roles', '/admin/staff']],
      actions: html`
        <form method="post" action="/admin/impersonate/${u.id}" data-confirm="Impersonate ${u.name}? This is audited."><button class="btn btn-ghost">Login as ${u.name.split(' ')[0]}</button></form>
        <form method="post" action="/admin/staff/${u.id}/reset-password" data-confirm="Reset password to demo1234?"><button class="btn btn-ghost">Reset password</button></form>`,
      content: html`${staffForm(rq, u, grants)}
        ${card('History', historyPanel(ctx.orgId, 'user', u.id))}`,
    });
  });

  r.post('/admin/staff/:id', requirePerm('admin:staff'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const u = q1<any>('SELECT * FROM users WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!u) return notFound();
    const before = { name: u.name, email: u.email, active: u.active };
    update('users', u.id, {
      name: String(rq.body.name || u.name),
      email: String(rq.body.email || u.email).toLowerCase(),
      phone: rq.body.phone || null,
      active: rq.body.active !== undefined ? Number(rq.body.active) : u.active,
    });
    run('DELETE FROM role_assignments WHERE user_id=?', u.id);
    saveGrant(ctx, u.id, rq);
    audit(ctx, 'user', u.id, 'update', before, { name: rq.body.name, email: rq.body.email, active: Number(rq.body.active ?? u.active), role: rq.body.role });
    return redirect(`/admin/staff/${u.id}`, 'Saved.');
  });

  r.post('/admin/staff/:id/reset-password', requirePerm('admin:staff'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const u = q1<any>('SELECT * FROM users WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!u) return notFound();
    const live = ctx.orgKind === 'live';
    const pw = live ? tempPassword() : 'demo1234';
    run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(pw), u.id);
    audit(ctx, 'user', u.id, 'password_reset');
    return redirect(`/admin/staff/${u.id}`, live
      ? `Password reset. One-time password (shown only now): ${pw}`
      : 'Password reset to demo1234.');
  });

  // permission matrix
  r.get('/admin/roles', requirePerm('admin:staff'), (rq) => {
    const mods = Object.keys(PERMISSIONS);
    const staffRoles = ROLES.filter((x) => !['RESIDENT', 'APPLICANT', 'GUARANTOR', 'VENDOR'].includes(x));
    return shell(rq, {
      title: 'Permission matrix',
      active: '/admin/staff',
      crumbs: [['Staff & roles', '/admin/staff']],
      subtitle: 'Generated from the role catalog — also written to docs/permission-matrix.md',
      wide: true,
      content: card(null, html`<div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Permission</th>${staffRoles.map((role) => html`<th class="center">${ROLE_LABELS[role]}</th>`)}</tr></thead>
        <tbody>${mods.flatMap((m) =>
          PERMISSIONS[m]!.map((a) => {
            const p = `${m}:${a}`;
            return html`<tr><td class="mono small">${p}</td>${staffRoles.map((role) => {
              const set = expandFor(role);
              return html`<td class="center">${set.has(p) ? raw('<span style="color:var(--ok)">●</span>') : raw('<span class="faint">·</span>')}</td>`;
            })}</tr>`;
          }),
        )}</tbody></table></div>`, { flush: true }),
    });
  });

  // ---------- settings ----------
  r.get('/admin/settings', requirePerm('admin:settings'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const propId = rq.query.get('property') || '';
    const props = q<any>('SELECT id, name FROM properties WHERE org_id=? ORDER BY name', ctx.orgId);
    const keys = Object.keys(SETTING_DEFAULTS);
    const rows = keys.map((k) => {
      const orgVal = getSetting(sysCtx(ctx.orgId), k);
      const effective = getSetting(sysCtx(ctx.orgId), k, propId || undefined);
      const overridden = propId && q1('SELECT id FROM settings WHERE org_id=? AND property_id=? AND key=?', ctx.orgId, propId, k);
      return { k, orgVal, effective, overridden: !!overridden };
    });
    return shell(rq, {
      title: 'Settings',
      active: '/admin/settings',
      subtitle: 'Organization defaults with per-property overrides. Values are stored as JSON.',
      content: html`
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Level', select('property', [['', 'Organization defaults'], ...props.map((p): [string, string] => [p.id, `Override: ${p.name}`])], propId))}
        </form>
        ${card(null, tbl(
          [{ label: 'Setting' }, { label: propId ? 'Effective value' : 'Value' }, { label: '', w: '220px' }],
          rows.map(({ k, effective, overridden }) => ({
            cells: [
              html`<b>${k}</b>${overridden ? html` <span class="badge accent">override</span>` : ''}`,
              html`<code class="small">${JSON.stringify(effective)}</code>`,
              html`<form method="post" action="/admin/settings" style="display:flex;gap:6px">
                <input type="hidden" name="key" value="${k}" />
                <input type="hidden" name="property" value="${propId}" />
                <input name="value" value="${JSON.stringify(effective)}" style="width:280px;font-family:var(--mono);font-size:11.5px;border:1px solid var(--line);border-radius:6px;padding:4px 6px" />
                <button class="btn btn-sm">Save</button>
                ${overridden ? html`<button class="btn btn-sm btn-ghost" formaction="/admin/settings/clear">Clear</button>` : ''}
              </form>`,
            ],
          })),
        ), { flush: true })}`,
    });
  });

  r.post('/admin/settings', requirePerm('admin:settings'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const key = String(rq.body.key || '');
    if (!(key in SETTING_DEFAULTS)) return badRequest('Unknown setting');
    let value: unknown;
    try {
      value = JSON.parse(String(rq.body.value));
    } catch {
      return redirect(`/admin/settings?property=${rq.body.property || ''}`, `Invalid JSON for ${key}.`, 'err');
    }
    setSetting(ctx, key, value, String(rq.body.property || '') || null);
    return redirect(`/admin/settings?property=${rq.body.property || ''}`, `${key} saved.`);
  });

  r.post('/admin/settings/clear', requirePerm('admin:settings'), (rq) => {
    const ctx = rq.ctx as Ctx;
    run('DELETE FROM settings WHERE org_id=? AND property_id=? AND key=?', ctx.orgId, String(rq.body.property || ''), String(rq.body.key || ''));
    return redirect(`/admin/settings?property=${rq.body.property || ''}`, 'Override cleared.');
  });

  // ---------- audit log ----------
  r.get('/admin/audit', requirePerm('admin:audit'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const entity = rq.query.get('entity') || '';
    const user = rq.query.get('user') || '';
    const params: unknown[] = [ctx.orgId];
    let where = 'org_id=?';
    if (entity) { where += ' AND entity=?'; params.push(entity); }
    if (user) { where += ' AND user_id=?'; params.push(user); }
    const total = val<number>(`SELECT COUNT(*) c FROM audit_events WHERE ${where}`, ...params);
    const page = Math.max(1, parseInt(rq.query.get('page') || '1', 10) || 1);
    const rows = q<any>(`SELECT * FROM audit_events WHERE ${where} ORDER BY at DESC LIMIT 50 OFFSET ?`, ...params, (page - 1) * 50);
    const entities = q<any>('SELECT DISTINCT entity FROM audit_events WHERE org_id=? ORDER BY entity', ctx.orgId);
    const users = q<any>('SELECT DISTINCT a.user_id, COALESCE(u.name, a.user_name, a.user_id) AS name FROM audit_events a LEFT JOIN users u ON u.id=a.user_id WHERE a.org_id=? ORDER BY name LIMIT 200', ctx.orgId);
    return shell(rq, {
      title: 'Audit log',
      active: '/admin/audit',
      content: html`
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Entity', select('entity', entities.map((e): [string, string] => [e.entity, e.entity]), entity, { blank: 'All entities' }))}
          ${field('User', select('user', users.map((u): [string, string] => [u.user_id, u.name]), user, { blank: 'All users' }))}
        </form>
        ${card(null, html`${tbl(
          [{ label: 'When', w: '150px' }, { label: 'Who' }, { label: 'Action' }, { label: 'Entity' }, { label: 'Changes' }],
          rows.map((a) => ({
            cells: [
              html`<span class="nowrap small">${a.at.slice(0, 19).replace('T', ' ')}</span>`,
              a.user_name || a.user_id,
              statusBadge(undefined, a.action.replaceAll('_', ' ')),
              html`<span class="mono small">${a.entity}/${String(a.entity_id).slice(0, 18)}</span>`,
              html`<span class="small muted">${a.changes ? summarizeDiff(a.changes) : ''}</span>`,
            ],
          })),
          { empty: 'No audit events match.' },
        )}${pager(rq, total)}`, { flush: true })}`,
    });
  });

  // ---------- jobs dashboard ----------
  r.get('/admin/jobs', requirePerm('admin:jobs'), (rq) => {
    const ctx = rq.ctx as Ctx;
    ensureJobRows(ctx.orgId);
    const rows = q<any>('SELECT * FROM jobs WHERE org_id=? ORDER BY key', ctx.orgId);
    const runs = q<any>('SELECT * FROM job_runs WHERE org_id=? ORDER BY at DESC LIMIT 25', ctx.orgId);
    return shell(rq, {
      title: 'Scheduled jobs',
      active: '/admin/jobs',
      subtitle: 'Every job runs once per business day (idempotent) as the Simulator Console advances time.',
      content: html`
        ${card('Jobs', tbl(
          [{ label: 'Job' }, { label: 'What it does' }, { label: 'Enabled' }, { label: 'Last run' }, { label: 'Status' }, { label: '', w: '170px' }],
          rows.map((jb) => ({
            cells: [
              html`<b class="mono small">${jb.key}</b>`,
              html`<span class="small">${jb.describe || jb.name}</span>`,
              html`<form method="post" action="/admin/jobs/${jb.key}/toggle">${jb.enabled ? html`<button class="btn btn-sm btn-ghost">On — disable</button>` : html`<button class="btn btn-sm btn-ghost" style="opacity:.6">Off — enable</button>`}</form>`,
              jb.last_run_date ? html`${fmtDate(jb.last_run_date)} <span class="muted small">(${jb.last_ms}ms)</span>` : html`<span class="muted">never</span>`,
              jb.last_status ? statusBadge(jb.last_status === 'ok' ? 'ok' : 'error') : '—',
              html`<form method="post" action="/admin/jobs/${jb.key}/run"><button class="btn btn-sm">Run now</button></form>`,
            ],
          })),
        ), { flush: true })}
        ${card('Recent runs', tbl(
          [{ label: 'When' }, { label: 'Job' }, { label: 'Business date' }, { label: 'Status' }, { label: 'Summary' }, { label: 'ms', num: true }],
          runs.map((x) => ({
            cells: [
              html`<span class="small nowrap">${x.at.slice(5, 19).replace('T', ' ')}</span>`,
              html`<span class="mono small">${x.job_key}</span>`,
              fmtDate(x.date), statusBadge(x.status === 'ok' ? 'ok' : 'error'),
              html`<span class="small muted">${x.summary || ''}</span>`, x.ms,
            ],
          })),
          { empty: 'No runs yet — advance the business date in the Simulator Console.' },
        ), { flush: true })}`,
    });
  });

  r.post('/admin/jobs/:key/run', requirePerm('admin:jobs'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const out = runJob(sysCtx(ctx.orgId), rq.params.key!, ctx.businessDate);
    return redirect('/admin/jobs', `${rq.params.key}: ${out.status}${out.summary ? ` — ${out.summary}` : ''}`, out.status === 'ok' ? 'ok' : 'err');
  });

  r.post('/admin/jobs/:key/toggle', requirePerm('admin:jobs'), (rq) => {
    const ctx = rq.ctx as Ctx;
    run('UPDATE jobs SET enabled = 1-enabled WHERE org_id=? AND key=?', ctx.orgId, rq.params.key!);
    return redirect('/admin/jobs', 'Toggled.');
  });

  // ---------- simulator console ----------
  r.get('/dev/sim', devOnly, requirePerm('dev:console'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const dials = getDials(ctx.orgId);
    return shell(rq, {
      title: 'Simulator console',
      active: '/dev/sim',
      subtitle: 'Dev-only. Advance the business date to fast-forward rent runs, late fees, autopay, screening turnarounds and more; tune simulator dials.',
      content: html`
        <div class="grid cols-2">
          ${card('Time machine', html`
            <p>Business date: <b>${fmtDate(ctx.businessDate)}</b></p>
            <form method="post" action="/dev/sim/advance" class="btn-row" style="margin-top:6px">
              <button class="btn" name="days" value="1">+1 day</button>
              <button class="btn" name="days" value="3">+3 days</button>
              <button class="btn" name="days" value="7">+1 week</button>
              <button class="btn" name="days" value="30">+30 days</button>
            </form>
            <form method="post" action="/dev/sim/advance" class="toolbar" style="margin-top:10px">
              ${field('Advance to date', input('to', { type: 'date', value: addDays(ctx.businessDate, 1) }))}
              <button class="btn btn-ghost">Advance</button>
            </form>
            <p class="small muted">Each day runs the full scheduler: rent posting, late fees, ACH settlement, lead generation, follow-ups, PM work orders, insurance lapses…</p>`)}
          ${card('Simulator dials', html`<form method="post" action="/dev/sim/dials">
            <div class="form-grid">
              ${field('ACH NSF rate %', input('nsfRatePct', { type: 'number', value: dials.nsfRatePct, step: '0.5', min: '0', max: '100' }))}
              ${field('Card decline rate %', input('cardDeclineRatePct', { type: 'number', value: dials.cardDeclineRatePct, step: '0.5', min: '0', max: '100' }))}
              ${field('ILS leads / property / day', input('leadsPerDay', { type: 'number', value: dials.leadsPerDay, min: '0', max: '50' }))}
              ${field('Screening outcome mix', select('screeningMix', [['normal', 'Normal'], ['strict', 'Strict market'], ['rosy', 'Rosy']], dials.screeningMix))}
              ${field('Meter anomaly rate %', input('meterAnomalyRatePct', { type: 'number', value: dials.meterAnomalyRatePct, min: '0', max: '100' }))}
              ${field('ACH settle days', input('achSettleDays', { type: 'number', value: dials.achSettleDays, min: '0', max: '10' }))}
              ${field('Simulated clock hour (quiet hours)', input('clockHour', { type: 'number', value: dials.clockHour, min: '0', max: '23' }))}
            </div>
            ${checkbox('bankNoise', 'Bank feed noise (timing jitter + stray transactions)', dials.bankNoise)}
            <div class="btn-row"><button class="btn">Save dials</button></div>
          </form>`)}
        </div>`,
    });
  });

  r.post('/dev/sim/advance', devOnly, requirePerm('dev:console'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const to = rq.body.to ? String(rq.body.to) : addDays(ctx.businessDate, parseInt(String(rq.body.days || '1'), 10) || 1);
    const started = Date.now();
    const { days } = advanceBusinessDate(ctx.orgId, to);
    return redirect('/dev/sim', `Advanced ${days} day${days === 1 ? '' : 's'} to ${fmtDate(to)} in ${Date.now() - started}ms.`);
  });

  r.post('/dev/sim/dials', devOnly, requirePerm('dev:console'), (rq) => {
    const ctx = rq.ctx as Ctx;
    setDials(ctx.orgId, {
      nsfRatePct: parseFloat(String(rq.body.nsfRatePct ?? DEFAULT_DIALS.nsfRatePct)),
      cardDeclineRatePct: parseFloat(String(rq.body.cardDeclineRatePct ?? DEFAULT_DIALS.cardDeclineRatePct)),
      leadsPerDay: parseInt(String(rq.body.leadsPerDay ?? DEFAULT_DIALS.leadsPerDay), 10),
      screeningMix: (String(rq.body.screeningMix || 'normal') as Dials['screeningMix']),
      meterAnomalyRatePct: parseFloat(String(rq.body.meterAnomalyRatePct ?? DEFAULT_DIALS.meterAnomalyRatePct)),
      achSettleDays: parseInt(String(rq.body.achSettleDays ?? 3), 10),
      clockHour: parseInt(String(rq.body.clockHour ?? 14), 10),
      bankNoise: rq.body.bankNoise === '1',
    });
    audit(ctx, 'sim', ctx.orgId, 'dials_update');
    return redirect('/dev/sim', 'Dials saved.');
  });

  // ---------- message console ----------
  r.get('/dev/messages', devOnly, requirePerm('dev:console'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const channel = rq.query.get('channel') || '';
    const template = rq.query.get('template') || '';
    const qtext = rq.query.get('q') || '';
    const params: unknown[] = [ctx.orgId];
    let where = 'org_id=?';
    if (channel) { where += ' AND channel=?'; params.push(channel); }
    if (template) { where += ' AND template_key=?'; params.push(template); }
    if (qtext) { where += ' AND (subject LIKE ? OR to_addr LIKE ? OR body LIKE ?)'; params.push(`%${qtext}%`, `%${qtext}%`, `%${qtext}%`); }
    const total = val<number>(`SELECT COUNT(*) c FROM outbox_messages WHERE ${where}`, ...params);
    const page = Math.max(1, parseInt(rq.query.get('page') || '1', 10) || 1);
    const rows = q<any>(`SELECT * FROM outbox_messages WHERE ${where} ORDER BY created_at DESC LIMIT 50 OFFSET ?`, ...params, (page - 1) * 50);
    return shell(rq, {
      title: 'Message console',
      active: '/dev/messages',
      subtitle: `Outbox simulator — nothing actually sends. ${total} message${total === 1 ? '' : 's'} captured.`,
      content: html`
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Channel', select('channel', [['email', 'Email'], ['sms', 'SMS']], channel, { blank: 'All channels' }))}
          ${field('Template', input('template', { value: template, placeholder: 'e.g. payment_nsf', list: '' }))}
          ${field('Search', input('q', { value: qtext, placeholder: 'subject, address or body' }))}
        </form>
        ${card(null, html`${tbl(
          [{ label: '' }, { label: 'When' }, { label: 'To' }, { label: 'Subject / body' }, { label: 'Template' }],
          rows.map((m) => ({
            href: `/dev/messages/${m.id}`,
            cells: [
              html`${statusBadge(undefined, m.direction === 'in' ? 'in' : m.channel)}`,
              html`<span class="small nowrap">${m.created_at.slice(5, 16).replace('T', ' ')}</span>`,
              html`${m.to_name ? html`<b>${m.to_name}</b> ` : ''}<span class="muted small">${m.to_addr}</span>`,
              html`<span class="small">${m.subject || m.body.replace(/<[^>]+>/g, ' ').slice(0, 90)}</span>`,
              m.template_key ? html`<span class="mono small">${m.template_key}</span>` : '—',
            ],
          })),
          { empty: 'No messages yet. Actions across StayLeased (receipts, reminders, letters) will land here.' },
        )}${pager(rq, total)}`, { flush: true })}`,
    });
  });

  r.get('/dev/messages/:id', devOnly, requirePerm('dev:console'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const m = q1<any>('SELECT * FROM outbox_messages WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!m) return notFound('Message not found');
    return shell(rq, {
      title: m.subject || `${m.channel.toUpperCase()} message`,
      active: '/dev/messages',
      crumbs: [['Message console', '/dev/messages']],
      content: html`
        ${card('Details', dl([
          ['Direction', m.direction], ['Channel', m.channel],
          [m.direction === 'in' ? 'From' : 'To', `${m.to_name || ''} <${m.to_addr}>`],
          ['Status', statusBadge(m.status)], ['Template', m.template_key || '—'],
          ['Sent', fmtTs(m.created_at)], ['Entity', m.entity ? `${m.entity}/${m.entity_id}` : '—'],
        ]))}
        ${card('Rendered message', m.channel === 'email'
          ? html`<div style="border:1px solid var(--line);border-radius:8px;padding:16px;background:#fff">${raw(m.body)}</div>`
          : html`<div style="max-width:340px;background:var(--info-soft);border-radius:14px;padding:10px 14px;font-size:14px">${m.body}</div>`)}
        ${m.direction === 'out' && m.person_id ? card('Simulate inbound reply', html`
          <form method="post" action="/dev/messages/${m.id}/reply">
            ${field('Reply body', textarea('body', { required: true, placeholder: 'Type the simulated reply from this person…' }))}
            <button class="btn">Receive reply</button>
          </form>`) : null}`,
    });
  });

  r.post('/dev/messages/:id/reply', devOnly, requirePerm('dev:console'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const m = q1<any>('SELECT * FROM outbox_messages WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!m) return notFound();
    receiveInbound(ctx, {
      channel: m.channel, from: m.to_addr, fromName: m.to_name || undefined,
      subject: m.subject ? `Re: ${m.subject}` : undefined, body: String(rq.body.body || ''),
      propertyId: m.property_id, threadId: m.thread_id, personId: m.person_id,
    });
    emit(ctx, 'message.inbound', 'message', m.id, { channel: m.channel, from: m.to_addr });
    return redirect('/dev/messages', 'Inbound reply recorded.');
  });

  // ---------- API keys & webhooks admin ----------
  r.get('/admin/api', requirePerm('admin:api'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const keys = q<any>('SELECT * FROM api_keys WHERE org_id=? ORDER BY created_at DESC', ctx.orgId);
    const hooks = q<any>('SELECT * FROM webhook_endpoints WHERE org_id=? ORDER BY created_at DESC', ctx.orgId);
    const deliveries = q<any>('SELECT * FROM webhook_deliveries WHERE org_id=? ORDER BY created_at DESC LIMIT 20', ctx.orgId);
    const fresh = rq.query.get('fresh');
    return shell(rq, {
      title: 'API & webhooks',
      active: '/admin/api',
      actions: html`<a class="btn btn-ghost" href="/developers" target="_blank">API reference ↗</a>`,
      content: html`
        ${when(fresh, () => html`<div class="callout info">New API key (copy now — it is stored hashed): <code>${fresh}</code></div>`)}
        ${card('API keys', html`${tbl(
          [{ label: 'Name' }, { label: 'Key' }, { label: 'Created' }, { label: 'Last used' }, { label: 'Status' }, { label: '' }],
          keys.map((k) => ({
            cells: [
              html`<b>${k.name}</b>`, html`<code>${k.prefix}…</code>`, fmtTs(k.created_at), k.last_used_at ? fmtTs(k.last_used_at) : 'never',
              statusBadge(k.active ? 'active' : 'inactive'),
              html`<form method="post" action="/admin/api/keys/${k.id}/toggle"><button class="btn btn-sm btn-ghost">${k.active ? 'Revoke' : 'Reactivate'}</button></form>`,
            ],
          })),
          { empty: 'No API keys yet.' },
        )}
        <div class="card-body"><form method="post" action="/admin/api/keys" class="toolbar">
          ${field('Key name', input('name', { placeholder: 'e.g. Reporting integration', required: true }))}
          <button class="btn">Create key</button>
        </form></div>`, { flush: true })}
        ${card('Webhook endpoints', html`${tbl(
          [{ label: 'URL' }, { label: 'Events' }, { label: 'Status' }, { label: '' }],
          hooks.map((h) => ({
            cells: [
              html`<code class="small">${h.url}</code>`,
              html`<span class="small">${j<string[]>(h.events, ['*']).join(', ')}</span>`,
              statusBadge(h.active ? 'active' : 'inactive'),
              html`<div style="display:flex;gap:6px"><form method="post" action="/admin/api/webhooks/${h.id}/toggle"><button class="btn btn-sm btn-ghost">${h.active ? 'Disable' : 'Enable'}</button></form></div>`,
            ],
          })),
          { empty: 'No webhook endpoints registered.' },
        )}
        <div class="card-body"><form method="post" action="/admin/api/webhooks" class="toolbar">
          ${field('Endpoint URL', input('url', { type: 'url', placeholder: 'https://example.com/hooks/stayleased', required: true }))}
          ${field('Events (comma or *)', input('events', { value: '*' }))}
          <button class="btn">Add endpoint</button>
        </form>
        <form method="post" action="/admin/api/webhooks/deliver"><button class="btn btn-ghost btn-sm">Deliver pending now</button></form></div>`, { flush: true })}
        ${card('Recent deliveries', tbl(
          [{ label: 'When' }, { label: 'Event' }, { label: 'Status' }, { label: 'Attempts', num: true }, { label: 'HTTP', num: true }],
          deliveries.map((d) => ({
            cells: [html`<span class="small nowrap">${d.created_at.slice(5, 19).replace('T', ' ')}</span>`, html`<span class="mono small">${d.event_type}</span>`, statusBadge(d.status), d.attempts, d.last_code ?? '—'],
          })),
          { empty: 'No deliveries yet — register an endpoint and trigger events.' },
        ), { flush: true })}`,
    });
  });

  r.post('/admin/api/keys', requirePerm('admin:api'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const secret = 'ok_' + token(24);
    insert('api_keys', {
      id: id('key'), org_id: ctx.orgId, name: String(rq.body.name || 'API key'),
      prefix: secret.slice(0, 10), key_hash: createHash('sha256').update(secret).digest('hex'),
      active: 1, created_at: nowIso(),
    });
    audit(ctx, 'api_key', secret.slice(0, 10), 'create');
    return redirect(`/admin/api?fresh=${encodeURIComponent(secret)}`, 'API key created — copy it now.');
  });

  r.post('/admin/api/keys/:id/toggle', requirePerm('admin:api'), (rq) => {
    const ctx = rq.ctx as Ctx;
    run('UPDATE api_keys SET active=1-active WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    audit(ctx, 'api_key', rq.params.id!, 'toggle');
    return redirect('/admin/api', 'Key updated.');
  });

  r.post('/admin/api/webhooks', requirePerm('admin:api'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const events = String(rq.body.events || '*').split(',').map((s) => s.trim()).filter(Boolean);
    const secret = 'whsec_' + token(16);
    insert('webhook_endpoints', {
      id: id('wh'), org_id: ctx.orgId, url: String(rq.body.url || ''), secret,
      events: js(events.length ? events : ['*']), active: 1, created_at: nowIso(),
    });
    audit(ctx, 'webhook', String(rq.body.url), 'create');
    return redirect('/admin/api', `Webhook added. Signing secret: ${secret}`);
  });

  r.post('/admin/api/webhooks/:id/toggle', requirePerm('admin:api'), (rq) => {
    const ctx = rq.ctx as Ctx;
    run('UPDATE webhook_endpoints SET active=1-active WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    return redirect('/admin/api', 'Endpoint updated.');
  });

  r.post('/admin/api/webhooks/deliver', requirePerm('admin:api'), async (rq) => {
    const ctx = rq.ctx as Ctx;
    const n = await deliverWebhooks(sysCtx(ctx.orgId));
    return redirect('/admin/api', `Delivered ${n} webhook${n === 1 ? '' : 's'}.`);
  });

  // ---------- org onboarding (platform admin) ----------
  r.get('/admin/orgs', requirePerm('admin:platform'), (rq) => {
    const orgs = q<any>('SELECT o.*, (SELECT COUNT(*) FROM properties p WHERE p.org_id=o.id) AS props, (SELECT COUNT(*) FROM users u WHERE u.org_id=o.id) AS users FROM orgs o ORDER BY o.created_at');
    return shell(rq, {
      title: 'Organizations',
      active: '/admin/orgs',
      actions: html`<a class="btn" href="/admin/orgs/new">New organization</a>`,
      content: card(null, tbl(
        [{ label: 'Organization' }, { label: 'Slug' }, { label: 'Business date' }, { label: 'Properties', num: true }, { label: 'Users', num: true }],
        orgs.map((o) => ({ cells: [html`<b>${o.name}</b>`, html`<code>${o.slug}</code>`, fmtDate(o.business_date), o.props, o.users] })),
        { empty: 'No organizations yet.' },
      ), { flush: true }),
    });
  });

  r.get('/admin/orgs/new', requirePerm('admin:platform'), (rq) =>
    shell(rq, {
      title: 'New organization',
      active: '/admin/orgs',
      crumbs: [['Organizations', '/admin/orgs']],
      content: card('Organization onboarding', html`<form method="post" action="/admin/orgs/new">
        <div class="form-grid">
          ${field('Company name', input('name', { required: true, placeholder: 'Acme Residential LLC' }))}
          ${field('Slug', input('slug', { required: true, placeholder: 'acme' }))}
          ${field('First admin name', input('admin_name', { required: true }))}
          ${field('First admin email', input('admin_email', { type: 'email', required: true }))}
        </div>
        <p class="small muted">Creates the org with the standard multifamily chart of accounts, default settings, and an ORG_ADMIN account (password demo1234). Add properties and invite staff next.</p>
        <button class="btn">Create organization</button>
      </form>`),
    }),
  );

  r.post('/admin/orgs/new', requirePerm('admin:platform'), (rq) => {
    const name = String(rq.body.name || '').trim();
    const slug = String(rq.body.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!name || !slug) return badRequest('Name and slug required');
    if (q1('SELECT id FROM orgs WHERE slug=?', slug)) return redirect('/admin/orgs/new', 'Slug already taken.', 'err');
    const orgId = id('org');
    insert('orgs', { id: orgId, name, slug, business_date: (rq.ctx as Ctx).businessDate || nowIso().slice(0, 10), created_at: nowIso() });
    const uid = id('usr');
    insert('users', {
      id: uid, org_id: orgId, email: String(rq.body.admin_email).toLowerCase(), name: String(rq.body.admin_name),
      kind: 'staff', password_hash: hashPassword('demo1234'), active: 1, created_at: nowIso(),
    });
    insert('role_assignments', { id: id('ra'), org_id: orgId, user_id: uid, role: 'ORG_ADMIN', scope_type: 'org', property_ids: '[]', created_at: nowIso() });
    // standard chart of accounts is created by the accounting module hook
    emit(sysCtx(orgId), 'org.created', 'org', orgId, { name });
    audit(rq.ctx as Ctx, 'org', orgId, 'create', null, { name, slug });
    return redirect('/admin/orgs', `${name} created — admin ${rq.body.admin_email} / demo1234.`);
  });

  // ---------- file downloads (authorized per record) ----------
  r.get('/f/:id', requireUser, (rq) => {
    const found = getFile(rq.params.id!);
    if (!found) return notFound('File not found');
    if (!canDownload(rq.ctx as Ctx, found.row)) return forbidden('You do not have access to this file.');
    const inline = ['application/pdf', 'image/png', 'image/jpeg', 'image/svg+xml'].includes(found.row.mime);
    return fileRes(found.data, found.row.mime, { filename: found.row.name, inline });
  });
}

// helpers

function saveGrant(ctx: Ctx, userId: string, rq: Rq): void {
  const role = String(rq.body.role || 'LEASING_AGENT') as Role;
  const scope = String(rq.body.scope_type || 'org');
  const pids = Array.isArray(rq.body.property_ids) ? rq.body.property_ids : rq.body.property_ids ? [rq.body.property_ids] : [];
  insert('role_assignments', {
    id: id('ra'), org_id: ctx.orgId, user_id: userId, role,
    scope_type: scope === 'properties' && pids.length ? 'properties' : 'org',
    property_ids: js(pids), created_at: nowIso(),
  });
}

function summarizeDiff(changes: string): string {
  try {
    const diff = JSON.parse(changes) as Record<string, { from: unknown; to: unknown }>;
    return Object.entries(diff).slice(0, 3).map(([k, d]) => `${k}: ${short(d.from)}→${short(d.to)}`).join('; ');
  } catch {
    return '';
  }
}
function short(v: unknown): string {
  const s = v === null || v === undefined ? '∅' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 24 ? s.slice(0, 24) + '…' : s;
}

function expandFor(role: Role): Set<string> {
  return expandPerms([role]);
}
