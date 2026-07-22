import { html, raw, when, join } from '../../lib/html.ts';
import { redirect, notFound, type Router, type Rq } from '../../lib/http.ts';
import { requirePerm, propFilter, canAccessProperty, type Ctx } from '../../lib/auth.ts';
import { q, q1, val, run, insert, update, js } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso, fmtDate } from '../../lib/dates.ts';
import { audit } from '../../lib/audit.ts';
import { emit } from '../../lib/events.ts';
import {
  shell, card, tbl, dl, statusBadge, field, input, select, textarea, registerNav, checkbox, emptyState,
} from '../../ui/ui.ts';
import { marketingOf, DEFAULT_MARKETING, liveAvailability, type Marketing } from './public.ts';

registerNav('Marketing', { href: '/marketing/sites', label: 'Websites (CMS)', perm: 'marketing:sites', match: ['/marketing/sites'] });
registerNav('Marketing', { href: '/marketing/syndication', label: 'Syndication', perm: 'marketing:syndication' });

const CHANNELS = ['zillow', 'apartments_com', 'craigslist', 'facebook'] as const;

export function routes(r: Router): void {
  // ---------- CMS: site list ----------
  r.get('/marketing/sites', requirePerm('marketing:sites'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const pf = propFilter(ctx, 'id');
    const props = q<any>(`SELECT * FROM properties WHERE org_id=?${pf.sql} ORDER BY name`, ctx.orgId, ...pf.params);
    return shell(rq, {
      title: 'Marketing websites',
      active: '/marketing/sites',
      subtitle: 'Studio-style CMS: section toggles, text and image slots, theme color — publish is instant.',
      content: card(null, tbl(
        [{ label: 'Property' }, { label: 'Public URL' }, { label: 'Status' }, { label: 'Available now', num: true }, { label: '' }],
        props.map((p) => {
          const mk = marketingOf(p);
          const avail = liveAvailability(p.id).reduce((s, f) => s + f.available, 0);
          return {
            cells: [
              html`<b>${p.name}</b>`,
              html`<a href="/p/${p.slug}" target="_blank"><code>/p/${p.slug}</code> ↗</a>`,
              statusBadge(mk.published ? 'published' : 'draft'),
              avail,
              html`<a class="btn btn-sm" href="/marketing/sites/${p.id}">Edit site</a>`,
            ],
          };
        }),
        { empty: 'No properties yet.' },
      ), { flush: true }),
    });
  });

  // ---------- CMS: editor ----------
  r.get('/marketing/sites/:id', requirePerm('marketing:sites'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const p = q1<any>('SELECT * FROM properties WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!p || !canAccessProperty(ctx, p.id)) return notFound('Property not found');
    const mk = marketingOf(p);
    return shell(rq, {
      title: `Site editor — ${p.name}`,
      active: '/marketing/sites',
      crumbs: [['Websites', '/marketing/sites']],
      actions: html`<a class="btn btn-ghost" href="/p/${p.slug}" target="_blank">Preview live ↗</a>`,
      content: html`<form method="post" action="/marketing/sites/${p.id}">
        <div class="grid cols-2">
          ${card('Hero & theme', html`
            ${field('Hero title', input('heroTitle', { value: mk.heroTitle, required: true }))}
            ${field('Hero subtitle', input('heroSub', { value: mk.heroSub }))}
            ${field('Theme color', html`<input type="color" name="theme" value="${mk.theme}" style="width:64px;height:36px;border:1px solid var(--line);border-radius:6px" />`)}
            ${field('Meta description (SEO)', textarea('metaDescription', { value: mk.metaDescription || '', rows: 2 }))}`)}
          ${card('Sections', html`
            ${checkbox('sec_floorplans', 'Floorplans with live availability & pricing', mk.sections.floorplans)}
            ${checkbox('sec_gallery', 'Photo gallery', mk.sections.gallery)}
            ${checkbox('sec_amenities', 'Amenities', mk.sections.amenities)}
            ${checkbox('sec_neighborhood', 'Neighborhood', mk.sections.neighborhood)}
            ${checkbox('sec_tour', 'Self-scheduled tours', mk.sections.tour)}
            <hr style="border:0;border-top:1px solid var(--line-2);margin:10px 0" />
            ${checkbox('published', html`<b>Published</b> — site is live at /p/${p.slug}`, mk.published)}`)}
        </div>
        ${card(html`Copy <a class="btn btn-sm btn-ghost" href="/ai/essentials" style="margin-left:8px" title="ELI Essentials generates listing copy from live data">✨ Generate with AI</a>`, html`
          ${field('About paragraph', textarea('about', { value: mk.about, rows: 3 }))}
          ${field('Neighborhood paragraph', textarea('neighborhood', { value: mk.neighborhood, rows: 3 }))}
          ${field('Amenities (one per line)', textarea('amenities', { value: mk.amenities.join('\n'), rows: 5 }))}`)}
        ${card('Gallery image slots', html`
          <p class="small muted">Original placeholder art (label + gradient) — swap for real photos in production. One per line: <code>Label | #colorA | #colorB</code></p>
          ${field('Slots', textarea('photos', { value: mk.photos.map((x) => `${x.label} | ${x.a} | ${x.b}`).join('\n'), rows: 6 }))}`)}
        <div class="btn-row"><button class="btn">Save & publish instantly</button></div>
      </form>`,
    });
  });

  r.post('/marketing/sites/:id', requirePerm('marketing:sites'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const p = q1<any>('SELECT * FROM properties WHERE id=? AND org_id=?', rq.params.id!, ctx.orgId);
    if (!p) return notFound();
    const before = marketingOf(p);
    const mk: Marketing = {
      ...before,
      theme: /^#[0-9a-fA-F]{6}$/.test(String(rq.body.theme)) ? String(rq.body.theme) : before.theme,
      heroTitle: String(rq.body.heroTitle || before.heroTitle),
      heroSub: String(rq.body.heroSub || ''),
      about: String(rq.body.about || ''),
      neighborhood: String(rq.body.neighborhood || ''),
      metaDescription: String(rq.body.metaDescription || ''),
      amenities: String(rq.body.amenities || '').split('\n').map((s) => s.trim()).filter(Boolean),
      photos: String(rq.body.photos || '').split('\n').map((line) => {
        const [label, a, b] = line.split('|').map((s) => s.trim());
        return label ? { label, a: a || '#5563e8', b: b || '#8b5ce8' } : null;
      }).filter(Boolean) as Marketing['photos'],
      sections: {
        floorplans: !!rq.body.sec_floorplans, gallery: !!rq.body.sec_gallery, amenities: !!rq.body.sec_amenities,
        neighborhood: !!rq.body.sec_neighborhood, tour: !!rq.body.sec_tour,
      },
      published: !!rq.body.published,
    };
    update('properties', p.id, { marketing: js(mk) });
    audit(ctx, 'property', p.id, 'marketing_publish', { heroTitle: before.heroTitle, published: before.published }, { heroTitle: mk.heroTitle, published: mk.published });
    emit(ctx, 'marketing.published', 'property', p.id, { published: mk.published });
    return redirect(`/marketing/sites/${p.id}`, mk.published ? 'Saved — the public site is live with these changes right now.' : 'Saved as draft (site unpublished).');
  });

  // ---------- syndication manager ----------
  r.get('/marketing/syndication', requirePerm('marketing:syndication'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const pf = propFilter(ctx, 'id');
    const props = q<any>(`SELECT * FROM properties WHERE org_id=?${pf.sql} ORDER BY name`, ctx.orgId, ...pf.params);
    const propId = rq.query.get('property') || ctx.currentPropertyId || props[0]?.id;
    const prop = props.find((x) => x.id === propId) || props[0];
    if (!prop) return shell(rq, { title: 'Syndication', active: '/marketing/syndication', content: emptyState('No properties') });
    const units = q<any>(
      `SELECT u.*, f.name AS fp_name FROM units u LEFT JOIN floorplans f ON f.id=u.floorplan_id
       WHERE u.property_id=? AND u.status IN ('vacant_ready','vacant_not_ready','notice') ORDER BY u.unit_number`,
      prop.id,
    );
    const pubs = q<any>('SELECT * FROM listing_publications WHERE property_id=?', prop.id);
    const pubMap = new Map(pubs.map((x) => [`${x.unit_id}:${x.channel}`, x]));
    const activeCounts = CHANNELS.map((ch) => pubs.filter((x) => x.channel === ch && x.status === 'active').length);
    return shell(rq, {
      title: 'Listing syndication',
      active: '/marketing/syndication',
      subtitle: 'Choose which units publish to which (simulated) ILS channels — the ILS lead feed references these listings.',
      content: html`
        <form method="get" class="toolbar" data-autosubmit>
          ${field('Property', select('property', props.map((x): [string, string] => [x.id, x.name]), prop.id))}
        </form>
        <div class="kpis">${CHANNELS.map((ch, i) => html`<div class="kpi"><div class="k-label">${ch.replaceAll('_', '.')}</div><div class="k-value">${activeCounts[i]}</div><div class="k-sub">active listings</div></div>`)}</div>
        ${card(html`Exposed units <form method="post" action="/marketing/syndication/${prop.id}/publish-all" style="display:inline"><button class="btn btn-sm" style="margin-left:8px">Publish all vacant-ready to all channels</button></form>`, tbl(
          [{ label: 'Unit' }, { label: 'Plan' }, { label: 'Status' }, ...CHANNELS.map((ch) => ({ label: ch.replaceAll('_', '.') }))],
          units.map((u) => ({
            cells: [
              html`<b>${u.unit_number}</b>`, u.fp_name || '—', statusBadge(u.status),
              ...CHANNELS.map((ch) => {
                const pub = pubMap.get(`${u.id}:${ch}`);
                return html`<form method="post" action="/marketing/syndication/toggle" style="margin:0">
                  <input type="hidden" name="unit_id" value="${u.id}" /><input type="hidden" name="channel" value="${ch}" />
                  <button class="btn btn-sm ${pub?.status === 'active' ? '' : 'btn-ghost'}" title="${pub ? `since ${fmtDate(pub.published_at)}` : 'not listed'}">${pub?.status === 'active' ? 'Live' : pub?.status === 'paused' ? 'Paused' : 'Off'}</button>
                </form>`;
              }),
            ],
          })),
          { empty: 'No exposed units — everything is occupied.' },
        ), { flush: true })}`,
    });
  });

  r.post('/marketing/syndication/toggle', requirePerm('marketing:syndication'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const unitId = String(rq.body.unit_id);
    const channel = String(rq.body.channel);
    const unit = q1<any>('SELECT * FROM units WHERE id=? AND org_id=?', unitId, ctx.orgId);
    if (!unit) return notFound();
    const existing = q1<any>('SELECT * FROM listing_publications WHERE unit_id=? AND channel=?', unitId, channel);
    if (!existing) {
      insert('listing_publications', {
        id: id('pub'), org_id: ctx.orgId, property_id: unit.property_id, unit_id: unitId,
        channel, status: 'active', published_at: ctx.businessDate,
      });
    } else {
      run('UPDATE listing_publications SET status=? WHERE id=?', existing.status === 'active' ? 'paused' : 'active', existing.id);
    }
    audit(ctx, 'listing', `${unitId}:${channel}`, 'syndication_toggle');
    return redirect(`/marketing/syndication?property=${unit.property_id}`, `${channel} listing updated.`);
  });

  r.post('/marketing/syndication/:propId/publish-all', requirePerm('marketing:syndication'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const units = q<any>(`SELECT * FROM units WHERE property_id=? AND status='vacant_ready' AND org_id=?`, rq.params.propId!, ctx.orgId);
    let n = 0;
    for (const u of units) {
      for (const ch of CHANNELS) {
        const existing = q1<any>('SELECT id, status FROM listing_publications WHERE unit_id=? AND channel=?', u.id, ch);
        if (!existing) {
          insert('listing_publications', { id: id('pub'), org_id: ctx.orgId, property_id: u.property_id, unit_id: u.id, channel: ch, status: 'active', published_at: ctx.businessDate });
          n++;
        } else if (existing.status !== 'active') {
          run("UPDATE listing_publications SET status='active' WHERE id=?", existing.id);
          n++;
        }
      }
    }
    audit(ctx, 'listing', rq.params.propId!, 'publish_all', null, { published: n });
    return redirect(`/marketing/syndication?property=${rq.params.propId}`, `${n} listings published.`);
  });
}
