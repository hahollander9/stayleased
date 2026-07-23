import { html, raw, esc, type Raw } from './html.ts';

/** Server-rendered SVG charts (environment fallback for Recharts, DECISIONS.md
 * #6). Consistent with the design system; zero client JS. */

export const PALETTE = ['#4653e5', '#12a5a5', '#e8843a', '#8b5ce8', '#d24379', '#5a9e2f', '#c2a416', '#4a7ab8'];

const TONE: Record<string, string> = {
  ok: '#157f3d', warn: '#a95c08', bad: '#b3261e', info: '#1d5bd8', accent: '#4653e5',
  muted: '#98a1ae', violet: '#6d28d9',
};
export function toneColor(t: string): string {
  return TONE[t] || PALETTE[0]!;
}

function fmtTick(v: number, money?: boolean): string {
  if (money) {
    const d = v / 100;
    return d >= 1000000 ? `$${(d / 1000000).toFixed(1)}M` : d >= 1000 ? `$${(d / 1000).toFixed(0)}k` : `$${d.toFixed(0)}`;
  }
  return v >= 1000000 ? `${(v / 1000000).toFixed(1)}M` : v >= 10000 ? `${(v / 1000).toFixed(0)}k` : String(Math.round(v * 100) / 100);
}

export interface DonutSlice { label: string; value: number; tone?: string }
export function donut(slices: DonutSlice[], opts?: { size?: number; centerLabel?: string; centerValue?: string }): Raw {
  const size = opts?.size ?? 150;
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  const cx = size / 2, cy = size / 2, r = size / 2 - 8, w = 17;
  let angle = -Math.PI / 2;
  const paths: string[] = [];
  slices.forEach((s, i) => {
    if (s.value <= 0) return;
    const frac = s.value / total;
    const a2 = angle + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
    const x2 = cx + r * Math.cos(a2 - 0.004), y2 = cy + r * Math.sin(a2 - 0.004);
    const color = s.tone ? toneColor(s.tone) : PALETTE[i % PALETTE.length]!;
    paths.push(`<path d="M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}" fill="none" stroke="${color}" stroke-width="${w}"><title>${esc(s.label)}: ${s.value}</title></path>`);
    angle = a2;
  });
  const center = opts?.centerValue
    ? `<text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="20" font-weight="700" fill="#1b2331">${esc(opts.centerValue)}</text><text x="${cx}" y="${cy + 15}" text-anchor="middle" font-size="9.5" fill="#66707f">${esc(opts.centerLabel || '')}</text>`
    : '';
  const legend = slices
    .filter((s) => s.value > 0)
    .map((s, i) => `<span><span class="sw" style="background:${s.tone ? toneColor(s.tone) : PALETTE[i % PALETTE.length]}"></span>${esc(s.label)} · ${s.value}</span>`)
    .join('');
  return html`<div class="chart" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
    ${raw(`<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="donut chart">${paths.join('')}${center}</svg>`)}
    <div class="legend" style="flex-direction:column;display:flex;gap:5px">${raw(legend)}</div>
  </div>`;
}

export interface BarDatum { label: string; value: number; tone?: string; href?: string }
export function bars(data: BarDatum[], opts?: { money?: boolean; height?: number; maxBars?: number }): Raw {
  const rows = data.slice(0, opts?.maxBars ?? 14);
  const max = Math.max(...rows.map((d) => d.value), 1);
  return html`<div class="chart">${rows.map((d, i) => {
    const pct = Math.max(1.5, (d.value / max) * 100);
    const color = d.tone ? toneColor(d.tone) : PALETTE[i % PALETTE.length]!;
    const inner = html`<div style="display:flex;align-items:center;gap:8px;margin:4px 0">
      <div style="width:130px;flex:none;font-size:12px;color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${d.label}</div>
      <div style="flex:1;background:var(--line-2);border-radius:5px;height:16px;overflow:hidden"><div style="width:${pct.toFixed(1)}%;background:${raw(color)};height:100%"></div></div>
      <div style="width:64px;flex:none;text-align:right;font-size:12px;font-variant-numeric:tabular-nums">${fmtTick(d.value, opts?.money)}</div>
    </div>`;
    return d.href ? html`<a href="${d.href}" style="display:block;color:inherit;text-decoration:none">${inner}</a>` : inner;
  })}</div>`;
}

export interface Series { name: string; points: number[]; tone?: string }
/** multi-series line chart; labels are x-axis categories */
export function lines(labels: string[], series: Series[], opts?: { money?: boolean; height?: number; fill?: boolean }): Raw {
  const W = 640, H = opts?.height ?? 190, padL = 48, padR = 10, padT = 12, padB = 22;
  const all = series.flatMap((s) => s.points);
  const max = Math.max(...all, 1);
  const min = Math.min(...all, 0);
  const span = max - min || 1;
  const iw = W - padL - padR, ih = H - padT - padB;
  const x = (i: number): number => padL + (labels.length <= 1 ? iw / 2 : (i / (labels.length - 1)) * iw);
  const y = (v: number): number => padT + ih - ((v - min) / span) * ih;
  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = min + f * span;
    return `<line x1="${padL}" x2="${W - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="#eef0f3"/><text x="${padL - 6}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end" font-size="9.5" fill="#98a1ae">${fmtTick(v, opts?.money)}</text>`;
  }).join('');
  const step = Math.max(1, Math.ceil(labels.length / 10));
  const xLabels = labels.map((l, i) => (i % step === 0 ? `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="9.5" fill="#98a1ae">${esc(l)}</text>` : '')).join('');
  const paths = series.map((s, si) => {
    const color = s.tone ? toneColor(s.tone) : PALETTE[si % PALETTE.length]!;
    const d = s.points.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    const fill = opts?.fill && si === 0
      ? `<path d="${d} L ${x(s.points.length - 1).toFixed(1)} ${y(min).toFixed(1)} L ${x(0).toFixed(1)} ${y(min).toFixed(1)} Z" fill="${color}" opacity="0.08"/>`
      : '';
    return `${fill}<path d="${d}" fill="none" stroke="${color}" stroke-width="2"/>` +
      s.points.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.4" fill="${color}"><title>${esc(s.name)} · ${esc(labels[i] || '')}: ${fmtTick(v, opts?.money)}</title></circle>`).join('');
  }).join('');
  const legend = series.length > 1
    ? html`<div class="legend">${series.map((s, si) => html`<span><span class="sw" style="background:${raw(s.tone ? toneColor(s.tone) : PALETTE[si % PALETTE.length]!)}"></span>${s.name}</span>`)}</div>`
    : null;
  return html`<div class="chart">${raw(`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="line chart">${gridLines}${xLabels}${paths}</svg>`)}${legend}</div>`;
}

export function sparkline(points: number[], opts?: { tone?: string; w?: number; h?: number }): Raw {
  const W = opts?.w ?? 90, H = opts?.h ?? 26;
  if (!points.length) return html`<span class="muted">—</span>`;
  const max = Math.max(...points), min = Math.min(...points);
  const span = max - min || 1;
  const x = (i: number): number => (points.length === 1 ? W / 2 : (i / (points.length - 1)) * (W - 4) + 2);
  const y = (v: number): number => H - 3 - ((v - min) / span) * (H - 6);
  const d = points.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const color = toneColor(opts?.tone || 'accent');
  return raw(`<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true"><path d="${d}" fill="none" stroke="${color}" stroke-width="1.8"/><circle cx="${x(points.length - 1)}" cy="${y(points[points.length - 1]!)}" r="2.2" fill="${color}"/></svg>`);
}

export function funnel(stages: { label: string; value: number }[]): Raw {
  const max = Math.max(...stages.map((s) => s.value), 1);
  return html`<div class="chart">${stages.map((s, i) => {
    const pct = Math.max(2, (s.value / max) * 100);
    const conv = i > 0 && stages[i - 1]!.value > 0 ? Math.round((s.value / stages[i - 1]!.value) * 100) : null;
    return html`<div style="display:flex;align-items:center;gap:8px;margin:5px 0">
      <div style="width:110px;flex:none;font-size:12px;color:var(--ink-2)">${s.label}</div>
      <div style="flex:1"><div style="width:${pct.toFixed(1)}%;background:${raw(PALETTE[i % PALETTE.length]!)};height:20px;border-radius:4px;display:flex;align-items:center;padding:0 7px;color:#fff;font-size:11.5px;font-weight:700;min-width:26px">${s.value}</div></div>
      <div style="width:52px;flex:none;font-size:11px;color:var(--muted)">${conv !== null ? `${conv}%` : ''}</div>
    </div>`;
  })}</div>`;
}

// ===== Entrata-BI-grade charts (bar/area/funnel/split) =====

/** Entrata-BI-grade inline-SVG charts. Zero dependencies, server-rendered.
 * Palette: the signature-blue family (like Entrata BI's periwinkle range) so
 * every chart reads as one system. All charts scale to card width via
 * viewBox + width:100% (see .chart CSS). */

const BLUE = '#2563eb';
const BLUE_MID = '#7c9bf5';
const BLUE_SOFT = '#c7d5fb';
const GRID = '#eef0f3';
const AXIS = '#98a1ae';

function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

export function tickLabel(v: number, kind: 'num' | 'pct' | 'usd' = 'num'): string {
  const abs = Math.abs(v);
  const base = abs >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : abs >= 1e3 ? `${+(v / 1e3).toFixed(1)}K` : `${+v.toFixed(1)}`;
  return kind === 'pct' ? `${base}%` : kind === 'usd' ? `$${base}` : base;
}

/** Vertical bar chart with y-gridlines and axis labels (Rolling Weekly
 * Occupancy pattern). Highlights the final bar in the strong brand color. */
export function barChart(labels: string[], values: number[], opts?: { kind?: 'num' | 'pct' | 'usd'; h?: number; highlightLast?: boolean; zeroBase?: boolean }): Raw {
  const kind = opts?.kind || 'num';
  const H = opts?.h ?? 190;
  const W = 640;
  const padL = 42, padR = 8, padT = 12, padB = 26;
  const iw = W - padL - padR, ih = H - padT - padB;
  const n = Math.max(values.length, 1);
  const vmax = niceCeil(Math.max(...values, 0) * 1.05);
  const vmin = opts?.zeroBase === false ? Math.min(...values, 0) : 0;
  const y = (v: number): number => padT + ih - ((v - vmin) / (vmax - vmin || 1)) * ih;
  const bw = Math.min(34, (iw / n) * 0.62);
  const step = iw / n;
  let g = '';
  for (let t = 0; t <= 4; t++) {
    const v = vmin + ((vmax - vmin) * t) / 4;
    const yy = y(v);
    g += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="${GRID}" stroke-width="1"/>`;
    g += `<text x="${padL - 6}" y="${yy + 3.5}" text-anchor="end" font-size="10" fill="${AXIS}">${esc(tickLabel(v, kind))}</text>`;
  }
  let bars = '';
  values.forEach((v, i) => {
    const cx = padL + step * i + step / 2;
    const yy = y(v);
    const hh = Math.max(padT + ih - yy, 1.5);
    const last = i === values.length - 1;
    const fill = opts?.highlightLast ? (last ? BLUE : BLUE_MID) : BLUE_MID;
    bars += `<rect class="ct" data-tip="${esc(labels[i] || '')} · ${esc(tickLabel(v, kind))}" x="${(cx - bw / 2).toFixed(1)}" y="${yy.toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}" rx="3" fill="${fill}"><title>${esc(labels[i] || '')}: ${esc(tickLabel(v, kind))}</title></rect>`;
    const every = n > 8 ? 2 : 1;
    if (i % every === 0) bars += `<text x="${cx}" y="${H - 8}" text-anchor="middle" font-size="10" fill="${AXIS}">${esc(labels[i] || '')}</text>`;
  });
  return raw(`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="xMidYMid meet">${g}${bars}</svg>`);
}

let GRAD_SEQ = 0;

/** Smooth area chart with a soft gradient fill (Interactions / Conversion
 * Rate card pattern). */
export function areaChart(labels: string[], values: number[], opts?: { kind?: 'num' | 'pct' | 'usd'; h?: number; color?: string }): Raw {
  const kind = opts?.kind || 'num';
  const H = opts?.h ?? 190;
  const W = 640;
  const padL = 42, padR = 10, padT = 12, padB = 26;
  const iw = W - padL - padR, ih = H - padT - padB;
  const color = opts?.color || BLUE;
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = hi - lo || 1;
  const vmin = Math.max(0, lo - span * 0.25);
  const vmax = hi + span * 0.15;
  const x = (i: number): number => padL + (iw * i) / Math.max(values.length - 1, 1);
  const y = (v: number): number => padT + ih - ((v - vmin) / (vmax - vmin || 1)) * ih;
  let g = '';
  for (let t = 0; t <= 3; t++) {
    const v = vmin + ((vmax - vmin) * t) / 3;
    const yy = y(v);
    g += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="${GRID}" stroke-width="1"/>`;
    g += `<text x="${padL - 6}" y="${yy + 3.5}" text-anchor="end" font-size="10" fill="${AXIS}">${esc(tickLabel(v, kind))}</text>`;
  }
  const pts = values.map((v, i) => [x(i), y(v)] as const);
  let d = `M ${pts[0]![0].toFixed(1)} ${pts[0]![1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!, [x1, y1] = pts[i]!;
    const mx = (x0 + x1) / 2;
    d += ` C ${mx.toFixed(1)} ${y0.toFixed(1)}, ${mx.toFixed(1)} ${y1.toFixed(1)}, ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  }
  const gid = `ag${++GRAD_SEQ}`;
  const area = `${d} L ${pts[pts.length - 1]![0].toFixed(1)} ${padT + ih} L ${pts[0]![0].toFixed(1)} ${padT + ih} Z`;
  let xs = '';
  const every = values.length > 8 ? 2 : 1;
  labels.forEach((l, i) => { if (i % every === 0) xs += `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="${AXIS}">${esc(l)}</text>`; });
  const dot = pts[pts.length - 1]!;
  // one hover target per point: a wide invisible hit ring + a dot that grows
  let hovers = '';
  pts.forEach(([px, py], i) => {
    const lastPt = i === pts.length - 1;
    hovers += `<g class="ct" data-tip="${esc(labels[i] || '')} · ${esc(tickLabel(values[i]!, kind))}">`
      + `<rect x="${(px - Math.min(18, iw / Math.max(values.length, 1) / 2)).toFixed(1)}" y="${padT}" width="${Math.min(36, iw / Math.max(values.length, 1)).toFixed(1)}" height="${ih}" fill="transparent"/>`
      + `<circle class="ctdot" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${lastPt ? 3.4 : 0}" fill="${color}"><title>${esc(labels[i] || '')}: ${esc(tickLabel(values[i]!, kind))}</title></circle></g>`;
  });
  return raw(`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="xMidYMid meet">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity=".28"/><stop offset="100%" stop-color="${color}" stop-opacity=".02"/></linearGradient></defs>
    ${g}<path d="${area}" fill="url(#${gid})"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round"/>
    <circle cx="${dot[0].toFixed(1)}" cy="${dot[1].toFixed(1)}" r="3.4" fill="${color}"/>${hovers}${xs}</svg>`);
}

/** Centered conversion funnel (Lead-to-Lease pattern): symmetric bands whose
 * widths taper with the counts; label + value inside each band. */
export function funnelChart(stages: { label: string; value: number }[], opts?: { h?: number }): Raw {
  const W = 640;
  const bandH = 44, gap = 5;
  const H = opts?.h ?? stages.length * (bandH + gap) + 10;
  const max = Math.max(...stages.map((s) => s.value), 1);
  const minW = 0.22, maxW = 0.94;
  const widthFor = (v: number): number => W * (minW + (maxW - minW) * (v / max));
  const shades = [BLUE, '#4a7bef', BLUE_MID, '#a3b9f8', BLUE_SOFT];
  let out = '';
  stages.forEach((s, i) => {
    const wTop = widthFor(s.value);
    const next = stages[i + 1];
    const wBot = next ? widthFor(next.value) : wTop * 0.92;
    const yTop = 5 + i * (bandH + gap);
    const xTL = (W - wTop) / 2, xTR = xTL + wTop;
    const xBL = (W - wBot) / 2, xBR = xBL + wBot;
    const fill = shades[Math.min(i, shades.length - 1)];
    const ink = i >= 3 ? '#1b2331' : '#ffffff';
    const share = max ? Math.round((s.value / max) * 100) : 0;
    out += `<path class="ct" data-tip="${esc(s.label)} · ${s.value.toLocaleString('en-US')}${i > 0 ? ` (${share}% of top)` : ''}" d="M ${xTL.toFixed(1)} ${yTop} L ${xTR.toFixed(1)} ${yTop} L ${xBR.toFixed(1)} ${yTop + bandH} L ${xBL.toFixed(1)} ${yTop + bandH} Z" fill="${fill}"><title>${esc(s.label)}: ${s.value.toLocaleString('en-US')}</title></path>`;
    out += `<text x="${W / 2}" y="${yTop + bandH / 2 - 3}" text-anchor="middle" font-size="12" font-weight="600" fill="${ink}">${esc(s.label)}</text>`;
    out += `<text x="${W / 2}" y="${yTop + bandH / 2 + 13}" text-anchor="middle" font-size="12.5" font-weight="700" fill="${ink}">${s.value.toLocaleString('en-US')}</text>`;
  });
  return raw(`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="xMidYMid meet">${out}</svg>`);
}

/** One horizontal segmented bar + legend (Communication phone/text pattern). */
export function splitBar(parts: { label: string; value: number }[], opts?: { kind?: 'num' | 'pct' | 'usd' }): Raw {
  const W = 640, H = 64, barH = 26;
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  const colors = [BLUE_SOFT, BLUE, BLUE_MID, '#a3b9f8'];
  let x = 0, segs = '', legend = '';
  parts.forEach((p, i) => {
    const w = (p.value / total) * W;
    const pshare = Math.round((p.value / total) * 100);
    segs += `<rect class="ct" data-tip="${esc(p.label)} · ${p.value.toLocaleString('en-US')} (${pshare}%)" x="${x.toFixed(1)}" y="6" width="${Math.max(w, 1).toFixed(1)}" height="${barH}" fill="${colors[i % colors.length]}"><title>${esc(p.label)}: ${p.value.toLocaleString('en-US')}</title></rect>`;
    x += w;
  });
  let lx = 0;
  parts.forEach((p, i) => {
    legend += `<circle cx="${lx + 5}" cy="${H - 12}" r="4.5" fill="${colors[i % colors.length]}"/>`;
    const t = `${p.label} · ${tickLabel(p.value, opts?.kind || 'num')}`;
    legend += `<text x="${lx + 14}" y="${H - 8}" font-size="11.5" fill="#3c4657">${esc(t)}</text>`;
    lx += 14 + t.length * 6.4 + 18;
  });
  return raw(`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="xMidYMid meet"><rect x="0" y="6" width="${W}" height="${barH}" rx="4" fill="${GRID}"/>${segs}${legend}</svg>`);
}
