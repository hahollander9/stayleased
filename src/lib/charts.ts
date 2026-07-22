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
