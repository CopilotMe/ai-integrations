import { Histogram, type HistogramSnapshot } from './histogram.js';

export interface TimeseriesPoint {
  /** Virtual milliseconds since the run started. */
  t: number;
  completed: number;
  failed: number;
  inFlight: number;
  queueDepth: number;
  /** Leads finished per second of virtual time, over this interval. */
  throughput: number;
}

/**
 * Counters, gauges and histograms for the run, plus a time series sampled by
 * the runner so the report can show how the system behaved *over* the run
 * rather than only in aggregate. A totals-only report hides the interesting
 * part: the queue draining, the limiter biting, a retry storm.
 */
export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly series: TimeseriesPoint[] = [];

  constructor(private readonly random: () => number = Math.random) {}

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  observe(name: string, value: number): void {
    let histogram = this.histograms.get(name);
    if (!histogram) {
      histogram = new Histogram(name, 20_000, this.random);
      this.histograms.set(name, histogram);
    }
    histogram.record(value);
  }

  counter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  gauge(name: string): number {
    return this.gauges.get(name) ?? 0;
  }

  histogram(name: string): Histogram | undefined {
    return this.histograms.get(name);
  }

  recordSample(point: TimeseriesPoint): void {
    this.series.push(point);
  }

  get timeseries(): readonly TimeseriesPoint[] {
    return this.series;
  }

  /** Counter names under a prefix, e.g. every `llm.error.*`. */
  countersWithPrefix(prefix: string): Array<{ name: string; value: number }> {
    return [...this.counters.entries()]
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }

  snapshot(): MetricsSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms: Object.fromEntries(
        [...this.histograms.entries()].map(([name, h]) => [name, h.snapshot()]),
      ),
      timeseries: [...this.series],
    };
  }
}

export interface MetricsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, HistogramSnapshot>;
  timeseries: TimeseriesPoint[];
}

/** Metric names, in one place so the dashboard and report cannot drift from the runner. */
export const M = {
  leadsEnqueued: 'leads.enqueued',
  leadsCompleted: 'leads.completed',
  leadsFailed: 'leads.failed',
  leadsRejected: 'leads.rejected',
  leadsDead: 'leads.dead_lettered',
  jobRetries: 'jobs.retries',
  /** Enqueue to settled — what the business actually waits. */
  latencyTotal: 'latency.end_to_end_ms',
  /** Worker pick-up to settled, excluding queue time. */
  latencyProcessing: 'latency.processing_ms',
  latencyQueueWait: 'latency.queue_wait_ms',
  latencyLlm: 'latency.llm_ms',
  latencyCrm: 'latency.crm_ms',
  latencyNotifier: 'latency.notifier_ms',
  rateLimitWaitLlm: 'ratelimit.wait.llm_ms',
  rateLimitWaitCrm: 'ratelimit.wait.crm_ms',
  llmCalls: 'llm.calls',
  llmDegraded: 'llm.degraded',
  crmCalls: 'crm.calls',
  notifierCalls: 'notifier.calls',
  errorPrefix: 'error.',
  classificationPrefix: 'classification.',
} as const;
