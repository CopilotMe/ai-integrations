import { M } from '../metrics/registry.js';
import type { SimulationResult } from './runner.js';

/** The end-of-run terminal summary. */
export function summarise(result: SimulationResult): string {
  const { totals, metrics, cost } = result;
  const lines: string[] = [''];

  const row = (key: string, value: string) => `  ${key.padEnd(22)}${value}`;
  const seconds = result.durationVirtualMs / 1000;

  lines.push('  ── Throughput ────────────────────────────────────────');
  lines.push(row('leads in', String(totals.generated)));
  lines.push(row('completed', `${totals.completed}  (${percent(totals.completed, totals.generated)})`));
  lines.push(row('rejected (invalid)', `${totals.rejected}  (${percent(totals.rejected, totals.generated)})`));
  lines.push(row('dead-lettered', `${totals.dead}  (${percent(totals.dead, totals.generated)})`));
  lines.push(row('job retries', String(totals.retries)));
  lines.push(row('duration', `${seconds.toFixed(1)}s simulated / ${(result.durationRealMs / 1000).toFixed(1)}s real`));
  lines.push(row('throughput', `${(totals.completed / Math.max(seconds, 0.001)).toFixed(1)} leads/s`));

  const latency = metrics.histograms[M.latencyTotal];
  const queueWait = metrics.histograms[M.latencyQueueWait];
  const processing = metrics.histograms[M.latencyProcessing];
  if (latency) {
    lines.push('');
    lines.push('  ── Latency (ms, simulated) ───────────────────────────');
    lines.push(row('end-to-end p50', latency.p50.toFixed(0)));
    lines.push(row('end-to-end p95', latency.p95.toFixed(0)));
    lines.push(row('end-to-end p99', latency.p99.toFixed(0)));
    lines.push(row('', 'end-to-end = enqueue -> settled'));
    if (queueWait) lines.push(row('  of which queue wait', `p50 ${queueWait.p50.toFixed(0)}  p95 ${queueWait.p95.toFixed(0)}`));
    if (processing) lines.push(row('  of which processing', `p50 ${processing.p50.toFixed(0)}  p95 ${processing.p95.toFixed(0)}`));
    if (latency.sampled) lines.push(row('', '(percentiles from a reservoir subsample)'));
  }

  const errors = Object.entries(metrics.counters)
    .filter(([name]) => name.startsWith(M.errorPrefix))
    .sort((a, b) => b[1] - a[1]);
  if (errors.length > 0) {
    lines.push('');
    lines.push('  ── Errors injected and handled ───────────────────────');
    for (const [name, count] of errors) {
      lines.push(row(name.replace(M.errorPrefix, ''), String(count)));
    }
  }

  lines.push('');
  lines.push('  ── Rate limiting ─────────────────────────────────────');
  lines.push(row('client-side limiter', result.rateLimit.enabled ? 'ON' : 'OFF'));
  lines.push(row('llm limit', `${result.rateLimit.limits.llm.rpm} rpm`));
  lines.push(row('contention (caller-s)', `llm ${(result.rateLimit.waits.llm / 1000).toFixed(0)}s · crm ${(result.rateLimit.waits.crm / 1000).toFixed(0)}s · slack ${(result.rateLimit.waits.notifier / 1000).toFixed(0)}s`));
  lines.push(row('', '(summed across concurrent callers, not elapsed time)'));

  const ceilings = [
    { name: 'model', rpm: result.rateLimit.limits.llm.rpm, calls: metrics.counters[M.llmCalls] ?? 0 },
    { name: 'crm', rpm: result.rateLimit.limits.crm.rpm, calls: metrics.counters[M.crmCalls] ?? 0 },
    { name: 'slack', rpm: result.rateLimit.limits.notifier.rpm, calls: metrics.counters[M.notifierCalls] ?? 0 },
  ];
  const bottleneck = ceilings
    .map((c) => ({ ...c, minSeconds: (c.calls / c.rpm) * 60 }))
    .sort((a, b) => b.minSeconds - a.minSeconds)[0];
  if (bottleneck && seconds > 0) {
    lines.push(
      row(
        'binding constraint',
        `${bottleneck.name} — ${bottleneck.calls} calls at ${bottleneck.rpm} rpm needs ${bottleneck.minSeconds.toFixed(0)}s ` +
          `(${((bottleneck.minSeconds / seconds) * 100).toFixed(0)}% of the ${seconds.toFixed(0)}s run)`,
      ),
    );
  }

  lines.push('');
  lines.push('  ── Outcomes ──────────────────────────────────────────');
  lines.push(row('HOT / WARM / COLD', `${result.classifications.HOT} / ${result.classifications.WARM} / ${result.classifications.COLD}`));
  lines.push(row('CRM contacts/deals', `${totals.contacts} / ${totals.deals}`));
  lines.push(row('slack notifications', String(totals.notifications)));
  lines.push(row('degraded (no AI)', `${totals.degraded}  (${percent(totals.degraded, totals.completed)})`));

  lines.push('');
  lines.push('  ── Cost ──────────────────────────────────────────────');
  lines.push(row('model', `${cost.model}  (prices as of ${cost.asOf})`));
  lines.push(row('model calls', `${cost.calls}  (${cost.totalTokens.toLocaleString('en-US')} tokens)`));
  lines.push(row('this run', `$${cost.totalCostUsd.toFixed(4)}  /  EUR ${cost.totalCostEur.toFixed(4)}`));
  lines.push(row('per completed lead', `$${cost.costPerLeadUsd.toFixed(6)}`));
  lines.push(row('projected at 10,000', `$${cost.projectedAt10kUsd.toFixed(2)}  /  EUR ${cost.projectedAt10kEur.toFixed(2)}`));

  lines.push('');
  return lines.join('\n');
}

function percent(value: number, total: number): string {
  if (total === 0) return '0%';
  return `${((value / total) * 100).toFixed(1)}%`;
}
