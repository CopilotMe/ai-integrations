import { M } from '../metrics/registry.js';
import { CHART_SCRIPT, escapeHtml, histogramChart, lineChart, stackedBar } from './charts.js';
import type { SimulationResult } from './runner.js';

/**
 * Self-contained HTML report for a simulation run.
 *
 * No CDN, no build step, no external font — it opens from disk and survives
 * being committed to the repo. Theme-aware, and every chart ships a data table
 * beside it so nothing depends on colour being perceived.
 */
export function renderSimulationReport(result: SimulationResult): string {
  const { totals, metrics, cost, options, profile } = result;
  const seconds = result.durationVirtualMs / 1000;
  const throughput = totals.completed / Math.max(seconds, 0.001);
  const latency = metrics.histograms[M.latencyTotal];
  const queueWait = metrics.histograms[M.latencyQueueWait];
  const series = metrics.timeseries;

  const errors = Object.entries(metrics.counters)
    .filter(([name]) => name.startsWith(M.errorPrefix))
    .map(([name, value]) => ({ name: name.replace(M.errorPrefix, ''), value }))
    .sort((a, b) => b.value - a.value);
  const totalErrors = errors.reduce((sum, e) => sum + e.value, 0);

  const fmtMs = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);
  const fmtSec = (v: number) => `${(v / 1000).toFixed(1)}s`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Load simulation — ${options.leads.toLocaleString('en-US')} leads</title>
<style>
  :root {
    color-scheme: light;
    --bg: #f7f7f5; --surface-1: #fcfcfb; --line: #e3e3de;
    --text-primary: #0b0b0b; --text-secondary: #52514e; --text-muted: #86857f;
    --series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a;
    --grid: #eceae6; --good: #1baf7a; --bad: #e34948;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --bg: #131312; --surface-1: #1a1a19; --line: #33332f;
      --text-primary: #ffffff; --text-secondary: #c3c2b7; --text-muted: #8d8c84;
      --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70;
      --grid: #262622; --good: #199e70; --bad: #e66767;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #131312; --surface-1: #1a1a19; --line: #33332f;
    --text-primary: #ffffff; --text-secondary: #c3c2b7; --text-muted: #8d8c84;
    --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70;
    --grid: #262622; --good: #199e70; --bad: #e66767;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2.5rem 1.25rem 4rem; background: var(--bg); color: var(--text-primary);
    font: 15px/1.6 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 1000px; margin: 0 auto; }
  header { border-bottom: 2px solid var(--text-primary); padding-bottom: 1.25rem; margin-bottom: 1.75rem; }
  h1 { margin: 0 0 .3rem; font-size: 1.55rem; letter-spacing: -.02em; }
  h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .07em; color: var(--text-secondary);
       margin: 2.25rem 0 .85rem; font-weight: 650; }
  h3 { font-size: .95rem; margin: 1.4rem 0 .5rem; font-weight: 600; }
  .sub { color: var(--text-secondary); font-size: .88rem; }
  .chip { display: inline-block; background: var(--surface-1); border: 1px solid var(--line);
          border-radius: 5px; padding: .08rem .4rem; font-size: .78rem; margin-right: .25rem;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); gap: .7rem; }
  .tile { background: var(--surface-1); border: 1px solid var(--line); border-radius: 10px; padding: .8rem .9rem; }
  .tile .n { font-size: 1.55rem; font-weight: 650; line-height: 1.15; letter-spacing: -.02em;
             font-variant-numeric: tabular-nums; }
  .tile .k { color: var(--text-muted); font-size: .72rem; text-transform: uppercase;
             letter-spacing: .06em; margin-top: .15rem; }
  .tile .s { color: var(--text-secondary); font-size: .76rem; margin-top: .2rem; }
  .card { background: var(--surface-1); border: 1px solid var(--line); border-radius: 10px;
          padding: 1rem 1.1rem 1.1rem; margin-top: .85rem; }
  .plot { position: relative; }
  .plot svg { width: 100%; height: auto; display: block; overflow: visible; }
  .grid { stroke: var(--grid); stroke-width: 1; }
  .axis { stroke: var(--line); stroke-width: 1; }
  .tick { fill: var(--text-muted); font-size: 10px; font-family: ui-monospace, Menlo, monospace; }
  .line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .end-dot { stroke: var(--surface-1); stroke-width: 2; }
  .bar { stroke: var(--surface-1); stroke-width: 0; }
  .bar:hover { opacity: .8; }
  .band { fill: transparent; }
  .crosshair { stroke: var(--text-muted); stroke-width: 1; stroke-dasharray: 3 3; pointer-events: none; }
  .marker { stroke: var(--text-secondary); stroke-width: 1; stroke-dasharray: 2 3; }
  .marker-label { fill: var(--text-secondary); font-size: 9px; font-family: ui-monospace, Menlo, monospace; }
  .tooltip { position: absolute; top: -4px; transform: translate(-50%, -100%); background: var(--text-primary);
             color: var(--surface-1); font-size: .76rem; padding: .3rem .5rem; border-radius: 6px;
             white-space: nowrap; pointer-events: none; z-index: 2; }
  .legend { display: flex; flex-wrap: wrap; gap: .9rem; margin: .1rem 0 .6rem; font-size: .82rem;
            color: var(--text-secondary); }
  .key { display: inline-flex; align-items: center; gap: .35rem; }
  .key i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
  .key b { color: var(--text-primary); font-variant-numeric: tabular-nums; }
  .key em { font-style: normal; color: var(--text-muted); }
  .stack { display: flex; gap: 2px; height: 26px; border-radius: 6px; overflow: hidden; margin-bottom: .55rem; }
  .stack .seg { display: block; }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; }
  th { text-align: left; font-size: .7rem; text-transform: uppercase; letter-spacing: .05em;
       color: var(--text-muted); padding: .5rem .6rem; border-bottom: 1px solid var(--line); font-weight: 600; }
  td { padding: .5rem .6rem; border-bottom: 1px solid var(--line); font-variant-numeric: tabular-nums; }
  tr:last-child td { border-bottom: 0; }
  td.name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; color: var(--text-secondary); }
  details { margin-top: .7rem; }
  summary { cursor: pointer; font-size: .82rem; color: var(--text-secondary); }
  .note { color: var(--text-secondary); font-size: .84rem; margin: .5rem 0 0; }
  .empty { color: var(--text-muted); font-size: .85rem; }
  .ok { color: var(--good); } .warn { color: var(--bad); }
  footer { margin-top: 2.5rem; padding-top: 1.2rem; border-top: 1px solid var(--line);
           color: var(--text-muted); font-size: .8rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Load simulation — ${options.leads.toLocaleString('en-US')} leads</h1>
    <p class="sub">
      ${escapeHtml(result.startedAt.replace('T', ' ').slice(0, 19))} UTC ·
      <span class="chip">profile ${escapeHtml(profile.name)}</span>
      <span class="chip">concurrency ${options.concurrency}</span>
      <span class="chip">seed ${options.seed}</span>
      <span class="chip">rate limit ${options.rateLimitEnabled ? 'on' : 'off'}</span>
      <span class="chip">${options.model}</span>
    </p>
    <p class="sub" style="margin-top:.4rem">${escapeHtml(profile.description)}</p>
  </header>

  <h2>Outcome</h2>
  <div class="tiles">
    ${tile(totals.generated.toLocaleString('en-US'), 'leads in')}
    ${tile(totals.completed.toLocaleString('en-US'), 'completed', pctOf(totals.completed, totals.generated))}
    ${tile(totals.rejected.toLocaleString('en-US'), 'rejected', 'invalid payloads')}
    ${tile(totals.dead.toLocaleString('en-US'), 'dead-lettered', totals.dead === 0 ? 'none lost' : 'needs replay')}
    ${tile(totals.retries.toLocaleString('en-US'), 'job retries')}
    ${tile(`${throughput.toFixed(1)}/s`, 'throughput', `${seconds.toFixed(1)}s simulated`)}
    ${tile(latency ? fmtMs(latency.p95) : '—', 'p95 latency', latency ? `p50 ${fmtMs(latency.p50)}` : '')}
    ${tile(`$${cost.totalCostUsd.toFixed(4)}`, 'model spend', `EUR ${cost.totalCostEur.toFixed(4)}`)}
  </div>
  <p class="note">
    Every lead is accounted for:
    <strong>${totals.completed}</strong> completed +
    <strong>${totals.rejected}</strong> rejected as invalid +
    <strong>${totals.dead}</strong> dead-lettered =
    <strong>${totals.completed + totals.rejected + totals.dead}</strong> of ${totals.generated}
    ${totals.completed + totals.rejected + totals.dead === totals.generated
      ? '<span class="ok">✓ balanced</span>'
      : '<span class="warn">✗ leads unaccounted for</span>'}
  </p>

  <h2>Throughput over the run</h2>
  <div class="card">
    <h3>Leads completed per second</h3>
    ${lineChart({
      id: 'throughput',
      series: [{ name: 'throughput', colorVar: '--series-1', points: series.map((p) => ({ x: p.t, y: p.throughput })) }],
      xLabel: 'elapsed',
      yLabel: 'leads per second',
      formatX: fmtSec,
      formatY: (v) => v.toFixed(1),
    })}
    <h3>Queue depth and workers in flight</h3>
    ${lineChart({
      id: 'queue',
      series: [
        { name: 'queue depth', colorVar: '--series-1', points: series.map((p) => ({ x: p.t, y: p.queueDepth })) },
        { name: 'in flight', colorVar: '--series-2', points: series.map((p) => ({ x: p.t, y: p.inFlight })) },
      ],
      xLabel: 'elapsed',
      yLabel: 'jobs',
      formatX: fmtSec,
      formatY: (v) => String(Math.round(v)),
    })}
    <p class="note">
      Two measures, two plots — never two y-scales on one chart. Queue depth is capped at
      <code>${options.maxQueueDepth}</code> by backpressure: once it is reached the producer
      blocks rather than buffering without bound.
    </p>
    ${dataTable(
      ['elapsed', 'throughput/s', 'queue depth', 'in flight', 'completed'],
      series.slice(0, 60).map((p) => [fmtSec(p.t), p.throughput.toFixed(2), String(p.queueDepth), String(p.inFlight), String(p.completed)]),
      `Time series (${series.length} samples${series.length > 60 ? ', first 60 shown' : ''})`,
    )}
  </div>

  <h2>Latency</h2>
  <div class="card">
    ${latency
      ? histogramChart({
          id: 'latency',
          buckets: latency.buckets,
          colorVar: '--series-1',
          formatX: fmtMs,
          markers: [
            { label: 'p50', value: latency.p50 },
            { label: 'p95', value: latency.p95 },
            { label: 'p99', value: latency.p99 },
          ],
        })
      : '<p class="empty">No latency samples.</p>'}
    <div class="scroll">
      <table>
        <thead><tr><th>stage</th><th>count</th><th>p50</th><th>p95</th><th>p99</th><th>max</th></tr></thead>
        <tbody>
          ${latencyRow('end to end (enqueue → settled)', latency, fmtMs)}
          ${latencyRow('  queue wait', queueWait, fmtMs)}
          ${latencyRow('  processing', metrics.histograms[M.latencyProcessing], fmtMs)}
          ${latencyRow('model call', metrics.histograms[M.latencyLlm], fmtMs)}
          ${latencyRow('CRM call', metrics.histograms[M.latencyCrm], fmtMs)}
          ${latencyRow('Slack call', metrics.histograms[M.latencyNotifier], fmtMs)}
          ${latencyRow('  blocked by model rate limiter', metrics.histograms[M.rateLimitWaitLlm], fmtMs)}
        </tbody>
      </table>
    </div>
    ${latency?.sampled ? '<p class="note">Percentiles above p50 are estimated from a reservoir subsample; count, min, max and mean are exact.</p>' : ''}
  </div>

  <h2>Routing outcomes</h2>
  <div class="card">
    ${stackedBar([
      { name: 'HOT', value: result.classifications.HOT ?? 0, colorVar: '--series-2' },
      { name: 'WARM', value: result.classifications.WARM ?? 0, colorVar: '--series-3' },
      { name: 'COLD', value: result.classifications.COLD ?? 0, colorVar: '--series-1' },
    ])}
    <div class="scroll">
      <table>
        <thead><tr><th>metric</th><th>value</th></tr></thead>
        <tbody>
          <tr><td>CRM contacts created</td><td>${totals.contacts.toLocaleString('en-US')}</td></tr>
          <tr><td>CRM deals created</td><td>${totals.deals.toLocaleString('en-US')}</td></tr>
          <tr><td>Slack notifications sent</td><td>${totals.notifications.toLocaleString('en-US')}</td></tr>
          <tr><td>scored without AI (degraded)</td><td>${totals.degraded.toLocaleString('en-US')} ${pctOf(totals.degraded, totals.completed)}</td></tr>
          <tr><td>duplicate deliveries deduplicated</td><td>${Math.max(0, totals.completed - totals.contacts).toLocaleString('en-US')}</td></tr>
        </tbody>
      </table>
    </div>
    <p class="note">
      Contacts are fewer than completed leads because redelivered webhooks are matched by email
      and deduplicated rather than creating a second record.
    </p>
    ${dataTable(
      ['generated lead kind', 'count'],
      Object.entries(result.leadKinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, String(v)]),
      'Input mix',
    )}
  </div>

  <h2>Failures injected and handled</h2>
  <div class="card">
    ${errors.length === 0
      ? '<p class="empty">No failures injected — run with <code>--profile degraded</code> or <code>--profile outage</code>.</p>'
      : `<div class="scroll"><table>
          <thead><tr><th>failure</th><th>count</th><th>share of all failures</th></tr></thead>
          <tbody>${errors
            .map(
              (e) =>
                `<tr><td class="name">${escapeHtml(e.name)}</td><td>${e.value.toLocaleString('en-US')}</td><td>${((e.value / totalErrors) * 100).toFixed(1)}%</td></tr>`,
            )
            .join('')}</tbody></table></div>`}
    <p class="note">
      ${totalErrors.toLocaleString('en-US')} injected failures produced
      <strong>${totals.dead}</strong> permanently failed lead${totals.dead === 1 ? '' : 's'} —
      the difference is what retries, degraded-mode scoring and best-effort notification absorbed.
    </p>
    ${result.deadJobs.length > 0
      ? dataTable(
          ['job', 'attempts', 'code', 'error'],
          result.deadJobs.slice(0, 25).map((j) => [j.id, String(j.attempts), j.code, j.error.slice(0, 90)]),
          `Dead-lettered jobs (${result.deadJobs.length})`,
        )
      : ''}
  </div>

  <h2>Rate limiting</h2>
  <div class="card">
    <div class="scroll">
      <table>
        <thead><tr><th>provider</th><th>limit</th><th>calls</th><th>floor at this limit</th><th>contention</th><th>429s</th></tr></thead>
        <tbody>
          ${limiterRow('model', options.limits.llm.rpm, metrics.counters[M.llmCalls] ?? 0, result.rateLimit.waits.llm, metrics.counters[`${M.errorPrefix}llm.rate_limited`] ?? 0, seconds)}
          ${limiterRow('CRM', options.limits.crm.rpm, metrics.counters[M.crmCalls] ?? 0, result.rateLimit.waits.crm, metrics.counters[`${M.errorPrefix}crm.rate_limited`] ?? 0, seconds)}
          ${limiterRow('Slack', options.limits.notifier.rpm, metrics.counters[M.notifierCalls] ?? 0, result.rateLimit.waits.notifier, metrics.counters[`${M.errorPrefix}notifier.rate_limited`] ?? 0, seconds)}
        </tbody>
      </table>
    </div>
    <p class="note">
      Client-side limiting is <strong>${options.rateLimitEnabled ? 'ON' : 'OFF'}</strong> for this run.
      <em>Floor at this limit</em> is the shortest possible run given the call count and the ceiling —
      when it approaches 100% of the run, that provider <strong>is</strong> the bottleneck and no
      amount of extra concurrency will help. <em>Contention</em> sums waiting across concurrent
      callers, so it legitimately exceeds elapsed time; it measures pressure, not duration.
      Re-run with <code>--no-rate-limit</code> to see what the limiter is buying.
    </p>
    ${bottleneckNote(result, seconds)}
  </div>

  <h2>Cost</h2>
  <div class="card">
    <div class="tiles">
      ${tile(`$${cost.totalCostUsd.toFixed(4)}`, 'this run', `${cost.calls.toLocaleString('en-US')} calls`)}
      ${tile(`$${cost.costPerLeadUsd.toFixed(6)}`, 'per lead')}
      ${tile(`$${cost.projectedAt10kUsd.toFixed(2)}`, 'at 10,000 leads', `EUR ${cost.projectedAt10kEur.toFixed(2)}`)}
      ${tile(cost.totalTokens.toLocaleString('en-US'), 'tokens')}
    </div>
    <div class="scroll" style="margin-top:.85rem">
      <table>
        <thead><tr><th>line</th><th>tokens</th><th>USD</th></tr></thead>
        <tbody>
          <tr><td>input</td><td>${cost.promptTokens.toLocaleString('en-US')}</td><td>$${cost.inputCostUsd.toFixed(5)}</td></tr>
          <tr><td>output</td><td>${cost.completionTokens.toLocaleString('en-US')}</td><td>$${cost.outputCostUsd.toFixed(5)}</td></tr>
          <tr><td><strong>total</strong></td><td><strong>${cost.totalTokens.toLocaleString('en-US')}</strong></td><td><strong>$${cost.totalCostUsd.toFixed(5)}</strong></td></tr>
        </tbody>
      </table>
    </div>
    <p class="note">
      Prices from <code>config/pricing.json</code>, <strong>as of ${escapeHtml(cost.asOf)}</strong> — verify against
      the provider's current pricing before quoting these figures. Retries and calls that returned
      malformed output are counted: they were billed. Calls rejected with a 429 were not.
    </p>
  </div>

  <h2>Reproducing this run</h2>
  <div class="card">
    <p class="note" style="margin-top:0">Same seed and options produce an identical run:</p>
    <pre style="background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:.85rem;overflow-x:auto;font-size:.82rem"><code>npm run simulate -- --leads ${options.leads} --concurrency ${options.concurrency} --seed ${options.seed} --profile ${escapeHtml(profile.name)}${options.rateLimitEnabled ? '' : ' --no-rate-limit'}</code></pre>
    <p class="note">
      Wall clock was compressed ${options.timeScale === 1 ? '1× (real time)' : `${Math.round(1 / options.timeScale)}×`}:
      ${(result.durationRealMs / 1000).toFixed(1)}s real for ${seconds.toFixed(1)}s simulated.
      All latencies and rates reported here are in simulated time and are unaffected by that compression.
    </p>
  </div>

  <footer>
    Generated by <code>npm run simulate</code>. Providers are simulated — realistic latency
    distributions, rate limits and failure injection — running against the unmodified production
    pipeline. No API keys, no network, no spend.
  </footer>
</div>
<script>${CHART_SCRIPT}</script>
</body>
</html>
`;
}

function tile(value: string, label: string, sub = ''): string {
  return `<div class="tile"><div class="n">${escapeHtml(value)}</div><div class="k">${escapeHtml(label)}</div>${sub ? `<div class="s">${escapeHtml(sub)}</div>` : ''}</div>`;
}

function pctOf(value: number, total: number): string {
  if (total === 0) return '0%';
  return `${((value / total) * 100).toFixed(1)}%`;
}

function latencyRow(
  label: string,
  snapshot: { count: number; p50: number; p95: number; p99: number; max: number } | undefined,
  fmt: (v: number) => string,
): string {
  if (!snapshot) return `<tr><td>${escapeHtml(label)}</td><td colspan="5" class="name">not recorded</td></tr>`;
  return `<tr><td>${escapeHtml(label)}</td><td>${snapshot.count.toLocaleString('en-US')}</td><td>${fmt(snapshot.p50)}</td><td>${fmt(snapshot.p95)}</td><td>${fmt(snapshot.p99)}</td><td>${fmt(snapshot.max)}</td></tr>`;
}

function limiterRow(
  name: string,
  rpm: number,
  calls: number,
  waitMs: number,
  rateLimited: number,
  runSeconds: number,
): string {
  const floorSeconds = (calls / rpm) * 60;
  const share = runSeconds > 0 ? (floorSeconds / runSeconds) * 100 : 0;
  const emphasis = share > 80 ? ' class="warn"' : '';
  return `<tr><td>${escapeHtml(name)}</td><td>${rpm.toLocaleString('en-US')} rpm</td><td>${calls.toLocaleString('en-US')}</td><td${emphasis}>${floorSeconds.toFixed(0)}s (${share.toFixed(0)}%)</td><td>${(waitMs / 1000).toFixed(0)}s</td><td>${rateLimited.toLocaleString('en-US')}</td></tr>`;
}

/** Names the binding constraint outright rather than leaving it to be inferred. */
function bottleneckNote(result: SimulationResult, runSeconds: number): string {
  const counters = result.metrics.counters;
  const candidates = [
    { name: 'the model provider', rpm: result.options.limits.llm.rpm, calls: counters[M.llmCalls] ?? 0 },
    { name: 'the CRM', rpm: result.options.limits.crm.rpm, calls: counters[M.crmCalls] ?? 0 },
    { name: 'Slack', rpm: result.options.limits.notifier.rpm, calls: counters[M.notifierCalls] ?? 0 },
  ].map((c) => ({ ...c, floor: (c.calls / c.rpm) * 60 }));

  const worst = candidates.sort((a, b) => b.floor - a.floor)[0];
  if (!worst || runSeconds <= 0) return '';
  const share = (worst.floor / runSeconds) * 100;
  if (share < 60) {
    return `<p class="note">No single rate limit dominates this run — the slowest ceiling
      (${escapeHtml(worst.name)}) accounts for ${share.toFixed(0)}% of the elapsed time.</p>`;
  }
  return `<p class="note"><strong>Binding constraint: ${escapeHtml(worst.name)}.</strong>
    ${worst.calls.toLocaleString('en-US')} calls at ${worst.rpm} rpm cannot complete in under
    ${worst.floor.toFixed(0)}s, which is ${share.toFixed(0)}% of this ${runSeconds.toFixed(0)}s run.
    Adding workers will not help; the fixes are to raise that limit, batch the calls, or move
    that dependency off the critical path. See <code>docs/findings.md</code>.</p>`;
}

function dataTable(headers: string[], rows: string[][], caption: string): string {
  if (rows.length === 0) return '';
  return `<details>
    <summary>${escapeHtml(caption)} — data table</summary>
    <div class="scroll"><table>
      <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i === 0 ? ' class="name"' : ''}>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>
  </details>`;
}
