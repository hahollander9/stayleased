import { html, raw, esc, when, join, type Raw } from '../../lib/html.ts';
import { htmlRes, redirect, notFound, textRes, type Router, type Rq, type Res, takeFlash } from '../../lib/http.ts';
import { q, q1, val, j } from '../../lib/db.ts';
import { sysCtx, type Ctx } from '../../lib/auth.ts';
import { fmtDate, addDays } from '../../lib/dates.ts';
import { usd } from '../../lib/money.ts';
import { v } from '../../lib/validate.ts';
import { logo } from '../../ui/ui.ts';
import { intakeLead, bookTour, tourSlots } from '../m3_crm/service.ts';

/** M4 public marketing sites + prospect flows. Everything renders from LIVE
 * inventory/pricing (M2 now, M13 recommendations once accepted) — no stale
 * copies. Original branding; gradient placeholders instead of photos. */

export interface Marketing {
  theme: string;
  heroTitle: string;
  heroSub: string;
  about: string;
  neighborhood: string;
  amenities: string[];
  photos: { label: string; a: string; b: string }[];
  sections: { gallery: boolean; amenities: boolean; neighborhood: boolean; floorplans: boolean; tour: boolean };
  published: boolean;
  metaDescription?: string;
}

export const DEFAULT_MARKETING: Marketing = {
  theme: '#4653e5',
  heroTitle: 'Come home to something better',
  heroSub: 'Thoughtful floorplans, resident-first service, and a location you will love.',
  about: 'Professionally managed homes with responsive maintenance, easy online payments, and a community team that knows your name.',
  neighborhood: 'Minutes from parks, coffee, groceries and transit.',
  amenities: ['Resident lounge', 'Fitness center', '24/7 emergency maintenance', 'Online payments & requests', 'Pet friendly', 'Package alerts'],
  photos: [
    { label: 'Community exterior', a: '#5563e8', b: '#8b5ce8' },
    { label: 'Resident lounge', a: '#12a5a5', b: '#4653e5' },
    { label: 'Model kitchen', a: '#e8843a', b: '#d24379' },
    { label: 'Fitness studio', a: '#5a9e2f', b: '#12a5a5' },
    { label: 'Pool deck', a: '#4a7ab8', b: '#6d28d9' },
    { label: 'Courtyard', a: '#c2a416', b: '#e8843a' },
  ],
  sections: { gallery: true, amenities: true, neighborhood: true, floorplans: true, tour: true },
  published: true,
};

export function marketingOf(prop: any): Marketing {
  return { ...DEFAULT_MARKETING, ...j<Partial<Marketing>>(prop.marketing, {}) };
}

interface FpAvail {
  id: string;
  name: string;
  beds: number;
  baths: number;
  sqft: number;
  available: number;
  startingAt: number | null;
}

export function liveAvailability(propertyId: string): FpAvail[] {
  return q<any>(
    `SELECT f.id, f.name, f.beds, f.baths, f.sqft, f.market_rent_cents,
      (SELECT COUNT(*) FROM units u WHERE u.floorplan_id=f.id AND u.status='vacant_ready') AS available,
      (SELECT MIN(u.market_rent_cents) FROM units u WHERE u.floorplan_id=f.id AND u.status='vacant_ready') AS starting
     FROM floorplans f WHERE f.property_id=? ORDER BY f.market_rent_cents`,
    propertyId,
  ).map((f) => ({
    id: f.id, name: f.name, beds: f.beds, baths: f.baths, sqft: f.sqft,
    available: f.available, startingAt: f.available > 0 ? f.starting : null,
  }));
}

function siteDoc(prop: any, mk: Marketing, title: string, body: Raw, extraHead: Raw | null = null): Res {
  const page = `<!doctype html>${html`<html lang="en"><head>
    <meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <meta name="description" content="${mk.metaDescription || `${prop.name} — apartments in ${prop.city}, ${prop.state}. ${mk.heroSub}`}" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${mk.heroSub}" />
    <meta property="og:type" content="website" />
    <link rel="stylesheet" href="/assets/theme.css" />
    <link rel="icon" href="/assets/favicon.svg" />
    <style>.site .hero{background:linear-gradient(160deg,#242b47,${mk.theme})} .site .btn{background:${mk.theme};border-color:${mk.theme}} .site a{color:${mk.theme}}</style>
    ${extraHead}
  </head><body class="site">${body}</body></html>`.s}`;
  return htmlRes(page);
}

function siteNav(prop: any): Raw {
  return html`<nav class="site-nav">
    <div class="sn-name">${logo(20, 'currentColor')} ${prop.name}</div>
    <a href="/p/${prop.slug}#floorplans">Floorplans</a>
    <a href="/p/${prop.slug}#amenities">Amenities</a>
    <a href="/p/${prop.slug}#tour" class="btn" style="color:#fff">Book a tour</a>
  </nav>`;
}

function siteFooter(prop: any): Raw {
  return html`<footer class="foot">
    <div><b>${prop.name}</b> · ${prop.address1}, ${prop.city}, ${prop.state} ${prop.zip} · ${prop.phone || ''}</div>
    <div style="margin-top:6px">Professionally managed with Oriel · <span title="We follow all fair housing laws">⌂ Equal Housing Opportunity</span></div>
  </footer>`;
}

export function routes(r: Router): void {
  // ---------- property site ----------
  r.get('/p/:slug', (rq) => {
    const prop = q1<any>('SELECT * FROM properties WHERE slug=?', rq.params.slug!);
    if (!prop) return notFound('Community not found');
    const mk = marketingOf(prop);
    if (!mk.published) return notFound('This community page is not published yet');
    const fps = liveAvailability(prop.id);
    const totalAvail = fps.reduce((s, f) => s + f.available, 0);
    const flash = takeFlash(rq);
    const ld = {
      '@context': 'https://schema.org', '@type': 'ApartmentComplex', name: prop.name,
      address: { '@type': 'PostalAddress', streetAddress: prop.address1, addressLocality: prop.city, addressRegion: prop.state, postalCode: prop.zip },
      telephone: prop.phone || undefined, numberOfAvailableAccommodationUnits: totalAvail,
    };
    const body = html`
      ${siteNav(prop)}
      <header class="hero">
        <h1>${mk.heroTitle}</h1>
        <p>${mk.heroSub}</p>
        <a class="btn" style="background:#fff;color:#1b2331;border-color:#fff" href="#tour">Schedule a tour</a>
        <a class="btn" style="margin-left:8px" href="#floorplans">${totalAvail} homes available now</a>
      </header>
      ${when(flash, () => html`<section style="padding-top:20px"><div class="flash ${flash![0]}">${flash![1]}</div></section>`)}
      <section><p style="font-size:17px;max-width:760px">${mk.about}</p></section>
      ${when(mk.sections.floorplans, () => html`<section id="floorplans">
        <h2>Floorplans & live pricing</h2>
        <div class="fp-grid">${fps.map((f) => html`<div class="card"><div class="card-body">
          <div class="ph" style="--ph-a:${mk.theme};--ph-b:#8b5ce8;min-height:90px;margin-bottom:10px">${f.name}</div>
          <h3 style="font-size:16px">${f.name} — ${f.beds === 0 ? 'Studio' : `${f.beds} bed`} · ${f.baths} bath</h3>
          <p class="muted">${f.sqft.toLocaleString()} sqft</p>
          <p style="font-size:17px">${f.startingAt
            ? html`<b>from ${usd(f.startingAt)}/mo</b> · <span class="pos">${f.available} available</span>`
            : html`<span class="muted">Join the waitlist — none open today</span>`}</p>
          <a class="btn btn-sm" style="color:#fff" href="/p/${prop.slug}/inquire?plan=${f.name}">${f.startingAt ? 'Request this plan' : 'Join waitlist'}</a>
        </div></div>`)}</div>
        <p class="small muted" style="margin-top:10px">Pricing and availability are live from our property system — never stale.</p>
      </section>`)}
      ${when(mk.sections.gallery, () => html`<section id="gallery"><h2>Gallery</h2>
        <div class="gallery">${mk.photos.map((p) => html`<div class="ph" style="--ph-a:${p.a};--ph-b:${p.b}">${p.label}</div>`)}</div>
      </section>`)}
      ${when(mk.sections.amenities, () => html`<section id="amenities"><h2>Amenities</h2>
        <div class="grid cols-3">${mk.amenities.map((a) => html`<div class="card"><div class="card-body">✓ ${a}</div></div>`)}</div>
      </section>`)}
      ${when(mk.sections.neighborhood, () => html`<section id="neighborhood"><h2>The neighborhood</h2>
        <p style="max-width:760px">${mk.neighborhood}</p>
      </section>`)}
      ${when(mk.sections.tour, () => tourSection(prop))}
      <section id="contact"><h2>Get in touch</h2>${inquiryForm(prop, '')}</section>
      ${siteFooter(prop)}`;
    return siteDoc(prop, mk, `${prop.name} — Apartments in ${prop.city}, ${prop.state}`, body,
      raw(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`));
  });

  function tourSection(prop: any): Raw {
    const ctx = sysCtx(prop.org_id);
    const days = [1, 2, 3, 4, 5, 6].map((d) => addDays(ctx.businessDate, d)).filter((d) => tourSlots(ctx, prop.id, d).length > 0).slice(0, 4);
    return html`<section id="tour" style="background:var(--surface-2);border-radius:16px">
      <h2>Book a self-scheduled tour</h2>
      <form method="post" action="/p/${prop.slug}/tour" class="form-grid" style="max-width:720px">
        ${['first_name', 'last_name'].map((f) => html`<div class="field"><label>${f === 'first_name' ? 'First name' : 'Last name'}</label><input name="${f}" required /></div>`)}
        <div class="field"><label>Email</label><input name="email" type="email" required /></div>
        <div class="field"><label>Phone</label><input name="phone" type="tel" /></div>
        <div class="field"><label>Day</label><select name="date">${days.map((d) => html`<option value="${d}">${fmtDate(d)}</option>`)}</select></div>
        <div class="field"><label>Time</label><select name="start_time">${(days.length ? tourSlots(ctx, prop.id, days[0]!) : ['10:00']).slice(0, 12).map((s) => html`<option>${s}</option>`)}</select></div>
        <div class="field"><label>Tour type</label><select name="type"><option value="in_person">With our team</option><option value="self_guided">Self-guided</option><option value="virtual">Virtual</option></select></div>
        <div class="field full"><button class="btn" style="color:#fff">Confirm my tour</button></div>
      </form>
      <p class="small muted">You'll get an instant email confirmation and a reminder the day before.</p>
    </section>`;
  }

  function inquiryForm(prop: any, plan: string): Raw {
    return html`<form method="post" action="/p/${prop.slug}/inquire" class="form-grid" style="max-width:720px">
      <input type="hidden" name="plan" value="${plan}" />
      <div class="field"><label>First name</label><input name="first_name" required /></div>
      <div class="field"><label>Last name</label><input name="last_name" required /></div>
      <div class="field"><label>Email</label><input name="email" type="email" required /></div>
      <div class="field"><label>Phone</label><input name="phone" type="tel" /></div>
      <div class="field"><label>Desired move-in</label><input name="move_in" type="date" /></div>
      <div class="field"><label>Bedrooms</label><select name="beds"><option value="">Any</option><option value="0">Studio</option><option value="1">1</option><option value="2">2</option><option value="3">3+</option></select></div>
      <div class="field full"><label>Anything else?</label><textarea name="message" rows="3" placeholder="Tell us what you're looking for…"></textarea></div>
      <div class="field full"><button class="btn" style="color:#fff">Send inquiry</button></div>
    </form>`;
  }

  r.get('/p/:slug/inquire', (rq) => {
    const prop = q1<any>('SELECT * FROM properties WHERE slug=?', rq.params.slug!);
    if (!prop) return notFound();
    const mk = marketingOf(prop);
    const plan = rq.query.get('plan') || '';
    return siteDoc(prop, mk, `Inquire — ${prop.name}`, html`
      ${siteNav(prop)}
      <section><h2>Request info${plan ? ` — ${plan} floorplan` : ''}</h2>${inquiryForm(prop, plan)}</section>
      ${siteFooter(prop)}`);
  });

  r.post('/p/:slug/inquire', (rq) => {
    const prop = q1<any>('SELECT * FROM properties WHERE slug=?', rq.params.slug!);
    if (!prop) return notFound();
    const ctx = sysCtx(prop.org_id);
    const schema = v.object({ first_name: v.string({ min: 1 }), last_name: v.string({ min: 1 }), email: v.email() });
    const parsed = schema.safe(rq.body);
    if (!parsed.ok) return redirect(`/p/${prop.slug}#contact`, 'Please provide your name and a valid email.', 'err');
    intakeLead(ctx, {
      propertyId: prop.id, firstName: parsed.value.first_name, lastName: parsed.value.last_name,
      email: parsed.value.email, phone: rq.body.phone ? String(rq.body.phone) : null,
      source: 'website', channel: 'web', desiredMoveIn: rq.body.move_in || null,
      beds: rq.body.beds !== '' && rq.body.beds !== undefined ? parseInt(String(rq.body.beds), 10) : null,
      message: [rq.body.plan ? `Interested in ${rq.body.plan}.` : '', rq.body.message || ''].filter(Boolean).join(' ') || null,
    });
    return redirect(`/p/${prop.slug}`, 'Thanks! Our leasing team will reach out shortly — check your inbox.');
  });

  r.post('/p/:slug/tour', (rq) => {
    const prop = q1<any>('SELECT * FROM properties WHERE slug=?', rq.params.slug!);
    if (!prop) return notFound();
    const ctx = sysCtx(prop.org_id);
    const schema = v.object({ first_name: v.string({ min: 1 }), last_name: v.string({ min: 1 }), email: v.email(), date: v.date() });
    const parsed = schema.safe(rq.body);
    if (!parsed.ok) return redirect(`/p/${prop.slug}#tour`, 'Please complete your name, email and tour day.', 'err');
    const { leadId } = intakeLead(ctx, {
      propertyId: prop.id, firstName: parsed.value.first_name, lastName: parsed.value.last_name,
      email: parsed.value.email, phone: rq.body.phone ? String(rq.body.phone) : null,
      source: 'website', channel: 'web', message: 'Self-scheduled a tour from the website.',
    });
    try {
      bookTour(ctx, {
        leadId, date: parsed.value.date, startTime: String(rq.body.start_time || '10:00'),
        type: String(rq.body.type || 'in_person'), agentUserId: null,
      });
    } catch {
      return redirect(`/p/${prop.slug}#tour`, 'That time was just taken — pick another slot.', 'err');
    }
    return redirect(`/p/${prop.slug}`, `You're booked! Check ${parsed.value.email} for your confirmation.`);
  });

  // ---------- corporate brand site ----------
  r.get('/company', (rq) => {
    const orgs = q<any>('SELECT * FROM orgs LIMIT 1');
    const org = orgs[0];
    if (!org) return notFound();
    const city = rq.query.get('city') || '';
    const beds = rq.query.get('beds') || '';
    const maxRent = rq.query.get('max') || '';
    let props = q<any>('SELECT * FROM properties WHERE org_id=? ORDER BY name', org.id).filter((p) => marketingOf(p).published);
    if (city) props = props.filter((p) => p.city === city);
    const cards = props.map((p) => {
      const fps = liveAvailability(p.id).filter((f) => {
        if (beds !== '' && f.beds !== parseInt(beds, 10)) return false;
        if (maxRent && f.startingAt && f.startingAt > parseInt(maxRent, 10) * 100) return false;
        return true;
      });
      const avail = fps.reduce((s, f) => s + f.available, 0);
      const cheapest = Math.min(...fps.filter((f) => f.startingAt).map((f) => f.startingAt!), Infinity);
      return { p, avail, cheapest: Number.isFinite(cheapest) ? cheapest : null };
    }).filter((x) => beds === '' && !maxRent ? true : x.avail > 0 || true);
    const cities = [...new Set(q<any>('SELECT city FROM properties WHERE org_id=?', org.id).map((x) => x.city))];
    const body = html`
      <nav class="site-nav"><div class="sn-name">${logo(20, 'currentColor')} ${org.name}</div></nav>
      <header class="hero"><h1>Find your next home</h1><p>${props.length} communities, one resident-first team.</p></header>
      <section>
        <form method="get" class="toolbar">
          <div class="field"><label>City</label><select name="city" ><option value="">All</option>${cities.map((c) => html`<option ${c === city ? 'selected' : ''}>${c}</option>`)}</select></div>
          <div class="field"><label>Beds</label><select name="beds"><option value="">Any</option>${[0, 1, 2, 3, 4].map((b) => html`<option value="${b}" ${String(b) === beds ? 'selected' : ''}>${b === 0 ? 'Studio' : b}</option>`)}</select></div>
          <div class="field"><label>Max rent ($)</label><input name="max" type="number" value="${maxRent}" /></div>
          <button class="btn" style="color:#fff">Search</button>
        </form>
        <div class="fp-grid" style="margin-top:16px">${cards.map(({ p, avail, cheapest }) => html`<a class="card" href="/p/${p.slug}" style="text-decoration:none;color:inherit"><div class="card-body">
          <div class="ph" style="--ph-a:${marketingOf(p).theme};--ph-b:#8b5ce8;min-height:110px;margin-bottom:10px">${p.name}</div>
          <h3 style="font-size:16px">${p.name}</h3>
          <p class="muted">${p.city}, ${p.state}</p>
          <p>${avail > 0 ? html`<b class="pos">${avail} available</b>${cheapest ? html` · from ${usd(cheapest)}` : ''}` : html`<span class="muted">Join the waitlist</span>`}</p>
        </div></a>`)}</div>
      </section>
      <footer class="foot">${org.name} · professionally managed with Oriel · ⌂ Equal Housing Opportunity</footer>`;
    return htmlRes(`<!doctype html>${html`<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${org.name} — Communities</title><link rel="stylesheet" href="/assets/theme.css" /><link rel="icon" href="/assets/favicon.svg" /></head><body class="site">${body}</body></html>`.s}`);
  });

  // ---------- SEO plumbing ----------
  r.get('/sitemap.xml', (rq) => {
    const props = q<any>('SELECT slug FROM properties').filter((p) => {
      const full = q1<any>('SELECT * FROM properties WHERE slug=?', p.slug);
      return full && marketingOf(full).published;
    });
    const host = `http://${String(rq.raw.headers.host || 'localhost:3000')}`;
    const urls = ['/company', ...props.map((p) => `/p/${p.slug}`), ...props.map((p) => `/p/${p.slug}/inquire`)];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${host}${u}</loc></url>`).join('\n')}\n</urlset>\n`;
    return textRes(xml, 200, 'application/xml; charset=utf-8');
  });

  r.get('/robots.txt', (rq) => {
    const host = `http://${String(rq.raw.headers.host || 'localhost:3000')}`;
    return textRes(`User-agent: *\nAllow: /p/\nAllow: /company\nDisallow: /\nSitemap: ${host}/sitemap.xml\n`);
  });
}
