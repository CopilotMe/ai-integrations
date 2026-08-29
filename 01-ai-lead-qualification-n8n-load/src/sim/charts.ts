/**
 * Inline SVG chart primitives for the simulation report.
 *
 * Hand-rolled rather than pulled from a library because the report must be a
 * single self-contained file with no CDN and no build step — it is opened from
 * disk, or committed and viewed on GitHub Pages.
 *
 * Conventions applied throughout, per the project's visualization rules:
 *   - 2px lines, 4px rounded bar ends anchored to the baseline
 *   - a 2px surface-coloured gap between adjacent or stacked marks
 *   - recessive grid and axes; text in ink tokens, never in a series colour
 *   - a legend whenever there is more than one series, plus direct labels
 *   - a hover layer on every plot, and a data table beside it
 *   - never two y-scales on one plot: two measures means two charts
 */

export interface Series {
  name: string;
  /** CSS custom property name, e.g. `--series-1`. */
  colorVar: string;
  points: Array<{ x: number; y: number }>;
}

const PLOT = { width: 720, height: 190, left: 52, right: 14, top: 14, bottom: 26 };

export function lineChart(options: {
  id: string;
  series: Series[];
  xLabel: string;
  yLabel: string;
  formatX: (v: number) => string;
  formatY: (v: number) => string;
}): string {
  const { id, series, formatX, formatY, yLabel } = options;
  const all = series.flatMap((s) => s.points);
  if (all.length === 0) return '<p class="empty">No samples recorded — the run finished inside one sampling interval.</p>';

  const xMin = Math.min(...all.map((p) => p.x));
  const xMax = Math.max(...all.map((p) => p.x));
  const yMax = Math.max(1, Math.max(...all.map((p) => p.y)));

  const innerW = PLOT.width - PLOT.left - PLOT.right;
  const innerH = PLOT.height - PLOT.top - PLOT.bottom;
  const sx = (x: number) => PLOT.left + (xMax === xMin ? 0 : ((x - xMin) / (xMax - xMin)) * innerW);
  const sy = (y: number) => PLOT.top + innerH - (y / yMax) * innerH;

  const ticks = niceTicks(yMax, 4);
  const grid = ticks
    .map(
      (t) =>
        `<line class="grid" x1="${PLOT.left}" y1="${sy(t).toFixed(1)}" x2="${PLOT.width - PLOT.right}" y2="${sy(t).toFixed(1)}"/>` +
        `<text class="tick" x="${PLOT.left - 8}" y="${(sy(t) + 3.5).toFixed(1)}" text-anchor="end">${formatY(t)}</text>`,
    )
    .join('');

  const paths = series
    .map((s) => {
      const d = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
      const last = s.points[s.points.length - 1]!;
      return (
        `<path class="line" d="${d}" style="stroke:var(${s.colorVar})"/>` +
        // Direct label at the series end — identity is never colour-alone.
        `<circle class="end-dot" cx="${sx(last.x).toFixed(1)}" cy="${sy(last.y).toFixed(1)}" r="4" style="fill:var(${s.colorVar})"/>`
      );
    })
    .join('');

  const xTicks = [xMin, xMin + (xMax - xMin) / 2, xMax]
    .map(
      (x) =>
        `<text class="tick" x="${sx(x).toFixed(1)}" y="${PLOT.height - 8}" text-anchor="middle">${formatX(x)}</text>`,
    )
    .join('');

  // One invisible band per sample drives the crosshair and tooltip.
  const bandWidth = innerW / Math.max(1, series[0]!.points.length);
  const bands = series[0]!.points
    .map((p, i) => {
      const payload = series
        .map((s) => `${s.name}: ${formatY(s.points[i]?.y ?? 0)}`)
        .join(' · ');
      return `<rect class="band" x="${(sx(p.x) - bandWidth / 2).toFixed(1)}" y="${PLOT.top}" width="${bandWidth.toFixed(1)}" height="${innerH}" data-x="${sx(p.x).toFixed(1)}" data-tip="${escapeAttr(`${formatX(p.x)} — ${payload}`)}"/>`;
    })
    .join('');

  const legend =
    series.length > 1
      ? `<div class="legend">${series
          .map((s) => `<span class="key"><i style="background:var(${s.colorVar})"></i>${escapeHtml(s.name)}</span>`)
          .join('')}</div>`
      : '';

  return `${legend}
<div class="plot" data-chart="${id}">
  <svg viewBox="0 0 ${PLOT.width} ${PLOT.height}" role="img" aria-label="${escapeAttr(yLabel)} over time">
    ${grid}
    <line class="axis" x1="${PLOT.left}" y1="${PLOT.top + innerH}" x2="${PLOT.width - PLOT.right}" y2="${PLOT.top + innerH}"/>
    ${paths}
    ${xTicks}
    <line class="crosshair" x1="0" y1="${PLOT.top}" x2="0" y2="${PLOT.top + innerH}" style="opacity:0"/>
    ${bands}
  </svg>
  <div class="tooltip" hidden></div>
</div>`;
}

export function histogramChart(options: {
  id: string;
  buckets: Array<{ from: number; to: number; count: number }>;
  colorVar: string;
  formatX: (v: number) => string;
  markers?: Array<{ label: string; value: number }>;
}): string {
  const { id, buckets, colorVar, formatX, markers = [] } = options;
  if (buckets.length === 0) return '<p class="empty">No latency samples recorded.</p>';

  const innerW = PLOT.width - PLOT.left - PLOT.right;
  const innerH = PLOT.height - PLOT.top - PLOT.bottom;
  const maxCount = Math.max(1, ...buckets.map((b) => b.count));
  const lo = buckets[0]!.from;
  const hi = buckets[buckets.length - 1]!.to;
  const slot = innerW / buckets.length;
  const sy = (c: number) => PLOT.top + innerH - (c / maxCount) * innerH;

  const ticks = niceTicks(maxCount, 3);
  const grid = ticks
    .map(
      (t) =>
        `<line class="grid" x1="${PLOT.left}" y1="${sy(t).toFixed(1)}" x2="${PLOT.width - PLOT.right}" y2="${sy(t).toFixed(1)}"/>` +
        `<text class="tick" x="${PLOT.left - 8}" y="${(sy(t) + 3.5).toFixed(1)}" text-anchor="end">${t}</text>`,
    )
    .join('');

  // 2px surface gap between adjacent bars; 4px rounded top anchored to baseline.
  const bars = buckets
    .map((b) => {
      const x = PLOT.left + buckets.indexOf(b) * slot + 1;
      const w = Math.max(1, slot - 2);
      const y = sy(b.count);
      const h = PLOT.top + innerH - y;
      const tip = `${formatX(b.from)}–${formatX(b.to)}: ${b.count} lead${b.count === 1 ? '' : 's'}`;
      return `<rect class="bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="4" style="fill:var(${colorVar})" data-tip="${escapeAttr(tip)}"/>`;
    })
    .join('');

  const markerLines = markers
    .map((m) => {
      const x = PLOT.left + ((m.value - lo) / Math.max(1, hi - lo)) * innerW;
      if (x < PLOT.left || x > PLOT.width - PLOT.right) return '';
      return (
        `<line class="marker" x1="${x.toFixed(1)}" y1="${PLOT.top}" x2="${x.toFixed(1)}" y2="${PLOT.top + innerH}"/>` +
        `<text class="marker-label" x="${x.toFixed(1)}" y="${PLOT.top - 3}" text-anchor="middle">${escapeHtml(m.label)}</text>`
      );
    })
    .join('');

  const xTicks = [lo, (lo + hi) / 2, hi]
    .map((v, i) => {
      const x = PLOT.left + (i / 2) * innerW;
      const anchor = i === 0 ? 'start' : i === 2 ? 'end' : 'middle';
      return `<text class="tick" x="${x.toFixed(1)}" y="${PLOT.height - 8}" text-anchor="${anchor}">${formatX(v)}</text>`;
    })
    .join('');

  return `<div class="plot" data-chart="${id}">
  <svg viewBox="0 0 ${PLOT.width} ${PLOT.height}" role="img" aria-label="Latency distribution">
    ${grid}
    <line class="axis" x1="${PLOT.left}" y1="${PLOT.top + innerH}" x2="${PLOT.width - PLOT.right}" y2="${PLOT.top + innerH}"/>
    ${bars}
    ${markerLines}
    ${xTicks}
  </svg>
  <div class="tooltip" hidden></div>
</div>`;
}

/** Single stacked bar with direct labels — identity never rests on colour alone. */
export function stackedBar(segments: Array<{ name: string; value: number; colorVar: string }>): string {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (total === 0) return '<p class="empty">Nothing completed.</p>';

  const parts = segments
    .filter((s) => s.value > 0)
    .map((s) => {
      const share = (s.value / total) * 100;
      return `<span class="seg" style="flex-basis:${share}%;background:var(${s.colorVar})" data-tip="${escapeAttr(`${s.name}: ${s.value} (${share.toFixed(1)}%)`)}"></span>`;
    })
    .join('');

  const labels = segments
    .map(
      (s) =>
        `<span class="key"><i style="background:var(${s.colorVar})"></i>${escapeHtml(s.name)} <b>${s.value}</b> <em>${total === 0 ? 0 : ((s.value / total) * 100).toFixed(1)}%</em></span>`,
    )
    .join('');

  return `<div class="stack" data-chart="stack">${parts}</div><div class="legend">${labels}</div>`;
}

function niceTicks(max: number, count: number): number[] {
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? magnitude * 10;
  const ticks: number[] = [];
  for (let t = 0; t <= max * 1.0001; t += step) ticks.push(Math.round(t * 1000) / 1000);
  return ticks;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function escapeAttr(value: string): string {
  return escapeHtml(value);
}

/** Hover behaviour for every plot on the page. Inlined into the report. */
export const CHART_SCRIPT = `
document.querySelectorAll('.plot').forEach((plot) => {
  const tip = plot.querySelector('.tooltip');
  const crosshair = plot.querySelector('.crosshair');
  const show = (event, text) => {
    tip.textContent = text;
    tip.hidden = false;
    const box = plot.getBoundingClientRect();
    const x = event.clientX - box.left;
    tip.style.left = Math.min(Math.max(x, 8), box.width - 8) + 'px';
  };
  const hide = () => {
    tip.hidden = true;
    if (crosshair) crosshair.style.opacity = '0';
  };
  plot.querySelectorAll('[data-tip]').forEach((mark) => {
    mark.addEventListener('mouseenter', (e) => {
      show(e, mark.dataset.tip);
      if (crosshair && mark.dataset.x) {
        crosshair.setAttribute('x1', mark.dataset.x);
        crosshair.setAttribute('x2', mark.dataset.x);
        crosshair.style.opacity = '1';
      }
    });
    mark.addEventListener('mousemove', (e) => show(e, mark.dataset.tip));
  });
  plot.addEventListener('mouseleave', hide);
});
document.querySelectorAll('.stack [data-tip]').forEach((seg) => {
  seg.setAttribute('title', seg.dataset.tip);
});
`;
