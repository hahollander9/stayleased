import { html, raw, inlineScript } from '../../lib/html.ts';
import { redirect, forbidden, type Router } from '../../lib/http.ts';
import { requirePerm, canAccessProperty, type Ctx } from '../../lib/auth.ts';
import { cookie } from '../../lib/http.ts';
import { shell, registerNav } from '../../ui/ui.ts';
import { propertyCoords } from '../../lib/geo.ts';
import { propertySummaries } from './service.ts';
import { usd } from '../../lib/money.ts';
import { fmtDate } from '../../lib/dates.ts';

/** Portfolio map — a CoStar-style navigation surface for the portfolio.
 * Every property renders as a pin at its location on a dark basemap; the
 * view fits itself to wherever the portfolio is (two properties in one
 * metro → the map opens on that metro). Selecting a pin opens a property
 * panel with its key figures and a direct route into that property's
 * dashboard. Coordinates come from the property record, with a city-
 * centroid fallback (src/lib/geo.ts) so the map works before anyone has
 * entered exact locations. Tiles are street-map imagery; pins and panels
 * render even if tile imagery is unavailable. */

registerNav('Property', { href: '/map', label: 'Portfolio map', perm: 'dashboard:view', match: ['/map'] });

/** The map's client behavior. Plain string (no template interpolation) so
 * the code survives the html template layer untouched. */
const MAP_JS = `
(function () {
  'use strict';
  var el = document.getElementById('slmap');
  var dataEl = document.getElementById('slmap-data');
  if (!el || !dataEl || typeof L === 'undefined') return;
  var props = [];
  try { props = JSON.parse(dataEl.textContent || '[]'); } catch (e) { return; }
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var map = L.map(el, { zoomControl: false, attributionControl: true, scrollWheelZoom: true });
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  function tileUrl() {
    var light = document.documentElement.getAttribute('data-theme') === 'light';
    return 'https://{s}.basemaps.cartocdn.com/' + (light ? 'light_all' : 'dark_all') + '/{z}/{x}/{y}{r}.png';
  }
  var tiles = L.tileLayer(tileUrl(), {
    subdomains: 'abcd', maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
  }).addTo(map);
  document.addEventListener('sl-theme', function () { tiles.setUrl(tileUrl()); });

  // Property names, cities and rents are operator-entered text going into
  // innerHTML by way of L.divIcon/bindPopup. The JSON island escapes '<' only
  // far enough to survive its own closing script tag; JSON.parse hands the raw
  // '<' straight back. Escape at the point of injection instead.
  //
  // (This code is served inside an inline script element, so nothing in it —
  // comments included — may contain a literal closing script tag: the HTML
  // parser would end the element there and truncate everything below.)
  function e(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function pinHtml(p) {
    var cls = 'slpin' + (p.precise ? '' : ' approx');
    var scale = p.units >= 150 ? ' slpin-lg' : p.units >= 50 ? ' slpin-md' : '';
    // The name rides in the pin itself, not the hover. A map whose labels only
    // appear under the cursor cannot be read — you have to already know where
    // a property is to find out which one it is.
    return '<div class="' + cls + scale + '"><span class="slpin-halo"></span><span class="slpin-dot"></span>' +
      '<span class="slpin-tag"><b class="slpin-name">' + e(p.name) + '</b><i class="slpin-occ">' + e(p.occ) + '%</i></span></div>';
  }
  function popupHtml(p) {
    return '<div class="slpop">' +
      '<div class="slpop-name">' + e(p.name) + '</div>' +
      '<div class="slpop-sub">' + e(p.city) + ', ' + e(p.state) + ' · ' + e(p.units) + ' units' + (p.precise ? '' : ' · approximate location') + '</div>' +
      '<div class="slpop-stats">' +
        '<div><b>' + e(p.occ) + '%</b><i>Occupancy</i></div>' +
        '<div><b>' + e(p.exposure) + '%</b><i>Exposure</i></div>' +
        '<div><b>' + e(p.avgRent) + '</b><i>Avg rent</i></div>' +
      '</div>' +
      '<div class="slpop-actions">' +
        '<a class="btn btn-sm" href="/map/open/' + encodeURIComponent(p.id) + '">Open dashboard</a>' +
        '<a class="btn btn-ghost btn-sm" href="/properties/' + encodeURIComponent(p.id) + '">Property record</a>' +
      '</div></div>';
  }

  var markers = {};
  var bounds = [];
  props.forEach(function (p, i) {
    if (p.lat === null || p.lng === null) return;
    var icon = L.divIcon({ className: 'slpin-wrap', html: pinHtml(p), iconSize: [0, 0], iconAnchor: [0, 0] });
    var m = L.marker([p.lat, p.lng], { icon: icon, riseOnHover: true }).addTo(map);
    m.bindPopup(popupHtml(p), { closeButton: true, offset: [0, -10], maxWidth: 300 });
    markers[p.id] = m;
    bounds.push([p.lat, p.lng]);
    if (!reduce) {
      var elw = m.getElement && m.getElement();
      if (elw) { elw.style.opacity = '0'; setTimeout(function () { elw.style.transition = 'opacity .5s ease'; elw.style.opacity = '1'; }, 140 + i * 110); }
    }
  });

  if (bounds.length === 1) map.setView(bounds[0], 13);
  else if (bounds.length > 1) map.fitBounds(bounds, { paddingTopLeft: [390, 90], paddingBottomRight: [90, 90], maxZoom: 13 });
  else map.setView([39.5, -98.35], 4); // continental view when nothing is placeable

  // side panel → fly to the property and open its panel. Rows are
  // role="button" tabindex="0", so keyboard users get the same action: Enter
  // and Space activate, and Space is prevented from scrolling the page.
  document.querySelectorAll('[data-map-prop]').forEach(function (row) {
    function activate() {
      var id = row.getAttribute('data-map-prop');
      var m = markers[id];
      if (!m) return;
      document.querySelectorAll('[data-map-prop]').forEach(function (r) { r.classList.toggle('active', r === row); });
      var ll = m.getLatLng();
      if (reduce) { map.setView(ll, Math.max(map.getZoom(), 13)); m.openPopup(); }
      else { map.flyTo(ll, Math.max(map.getZoom(), 13), { duration: 1.1, easeLinearity: 0.18 }); setTimeout(function () { m.openPopup(); }, 1150); }
    }
    row.addEventListener('click', activate);
    row.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); activate(); }
    });
  });
})();
`;

/** Live mini-map card for the portfolio dashboard: real tiles, glowing pins,
 * ambient pulse — pointer-events disabled so the whole card is one link into
 * the full /map experience. */
export function dashMapCard(ctx: Ctx): ReturnType<typeof html> {
  const sums = propertySummaries(ctx);
  if (!sums.length) return html``;
  const items = sums.map((p) => {
    const at = propertyCoords(p as any);
    return {
      id: p.id, name: p.name, units: p.stats.total, occ: p.stats.occupancyPct,
      lat: at ? at.lat : null, lng: at ? at.lng : null, precise: at ? at.precise : false,
    };
  }).filter((i) => i.lat !== null);
  if (!items.length) return html``;
  return html`<div class="card dashmap-card">
    <link rel="stylesheet" href="/assets/vendor/leaflet.css" />
    <a class="dashmap" href="/map" aria-label="Open the portfolio map">
      <div id="dashmap"></div>
      <div class="dashmap-veil"></div>
      <div class="dashmap-label">
        <div class="dm-title">Portfolio map</div>
        <div class="dm-sub">${items.length} propert${items.length === 1 ? 'y' : 'ies'} · open the full map</div>
      </div>
      <span class="dashmap-cta">Explore →</span>
    </a>
    <script type="application/json" id="dashmap-data">${raw(JSON.stringify(items).replaceAll('<', '\\u003c'))}</script>
    <script src="/assets/vendor/leaflet.js"></script>
    <script>${inlineScript(DASHMAP_JS)}</script>
  </div>`;
}

const DASHMAP_JS = `
(function () {
  'use strict';
  function init() {
    var el = document.getElementById('dashmap');
    var dataEl = document.getElementById('dashmap-data');
    if (!el || !dataEl || typeof L === 'undefined') return;
    var props = [];
    try { props = JSON.parse(dataEl.textContent || '[]'); } catch (e) { return; }
    var map = L.map(el, { zoomControl: false, attributionControl: true, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false });
    function tileUrl() {
      var light = document.documentElement.getAttribute('data-theme') === 'light';
      return 'https://{s}.basemaps.cartocdn.com/' + (light ? 'light_all' : 'dark_all') + '/{z}/{x}/{y}{r}.png';
    }
    var tiles = L.tileLayer(tileUrl(), { subdomains: 'abcd', maxZoom: 19, attribution: '&copy; OpenStreetMap &copy; CARTO' }).addTo(map);
    document.addEventListener('sl-theme', function () { tiles.setUrl(tileUrl()); });
    var bounds = [];
    props.forEach(function (p) {
      var icon = L.divIcon({ className: 'slpin-wrap', html: '<div class="slpin slpin-mini"><span class="slpin-halo"></span><span class="slpin-dot"></span><span class="slpin-tag">' + p.occ + '%</span></div>', iconSize: [0, 0], iconAnchor: [0, 0] });
      L.marker([p.lat, p.lng], { icon: icon, interactive: false }).addTo(map);
      bounds.push([p.lat, p.lng]);
    });
    if (bounds.length === 1) map.setView(bounds[0], 12);
    else map.fitBounds(bounds, { padding: [46, 46], maxZoom: 12 });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
`;

export function mapRoutes(r: Router): void {
  r.get('/map', requirePerm('dashboard:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const sums = propertySummaries(ctx);
    const items = sums.map((p) => {
      const at = propertyCoords(p as any);
      return {
        id: p.id, name: p.name, city: p.city, state: p.state, type: p.type,
        lat: at ? at.lat : null, lng: at ? at.lng : null, precise: at ? at.precise : false,
        units: p.stats.total, occ: p.stats.occupancyPct, exposure: p.stats.exposurePct,
        avgRent: usd(p.stats.avgMarketRentCents),
      };
    });
    const placed = items.filter((i) => i.lat !== null).length;
    return shell(rq, {
      title: 'Portfolio map',
      active: '/map',
      wide: true,
      bareHead: true,
      head: html`<link rel="stylesheet" href="/assets/vendor/leaflet.css" />`,
      content: html`
        <div class="mapview">
          <div id="slmap" aria-label="Portfolio map"></div>
          <div class="map-panel">
            <div class="mp-head">
              <h1>Portfolio map</h1>
              <div class="mp-sub">${sums.length} propert${sums.length === 1 ? 'y' : 'ies'} · ${fmtDate(ctx.businessDate)}</div>
            </div>
            <div class="mp-list">
              ${sums.map((p) => html`<div class="mp-item" data-map-prop="${p.id}" tabindex="0" role="button" aria-label="Show ${p.name} on the map">
                <div class="mp-item-main">
                  <div class="mp-name">${p.name}</div>
                  <div class="mp-city">${p.city}, ${p.state} · ${p.stats.total} units</div>
                </div>
                <div class="mp-occ ${p.stats.occupancyPct >= 93 ? 'ok' : p.stats.occupancyPct >= 88 ? 'warn' : 'bad'}">${p.stats.occupancyPct}%</div>
              </div>`)}
            </div>
            <div class="mp-foot"><a class="btn btn-ghost btn-sm" href="/">Standard dashboard</a></div>
          </div>
          ${placed < sums.length ? html`<div class="map-note">Some properties are shown at their city center — set exact coordinates on the property record for precise placement.</div>` : null}
        </div>
        <script type="application/json" id="slmap-data">${raw(JSON.stringify(items).replaceAll('<', '\\u003c'))}</script>
        <script src="/assets/vendor/leaflet.js"></script>
        <script>${inlineScript(MAP_JS)}</script>`,
    });
  });

  // Selecting a property from the map sets the working property context and
  // lands on that property's dashboard.
  r.get('/map/open/:id', requirePerm('dashboard:view'), (rq) => {
    const ctx = rq.ctx as Ctx;
    const pid = rq.params.id!;
    // Stale history entries and bookmarks outlive the property they point at
    // (the public demo world can be rebuilt; portfolios change). Recover to
    // the map with an explanation instead of a dead-end error page.
    if (!canAccessProperty(ctx, pid)) {
      return redirect('/map', 'That property is not available — pick one from the map.', 'err');
    }
    rq.setCookies.push(cookie('sl_prop', pid, { maxAge: 30 * 86400, httpOnly: false }));
    return redirect('/');
  });
}
