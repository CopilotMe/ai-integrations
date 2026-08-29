import { describe, expect, it } from 'vitest';
import { CostTracker, estimateTokens } from '../src/cost/tracker.js';
import { loadPricing, pricingFor } from '../src/cost/pricing.js';
import { Histogram } from '../src/metrics/histogram.js';
import { MetricsRegistry } from '../src/metrics/registry.js';
import { createRng } from '../src/lib/random.js';

describe('Histogram', () => {
  it('computes exact percentiles while under the reservoir size', () => {
    const h = new Histogram('test', 1000);
    for (let i = 1; i <= 100; i++) h.record(i);

    expect(h.count).toBe(100);
    expect(h.min).toBe(1);
    expect(h.max).toBe(100);
    expect(h.mean).toBeCloseTo(50.5, 5);
    expect(h.percentile(50)).toBeCloseTo(50.5, 1);
    expect(h.percentile(95)).toBeCloseTo(95.05, 1);
    expect(h.snapshot().sampled).toBe(false);
  });

  it('keeps count, min, max and mean exact once sampling kicks in', () => {
    const rng = createRng(7);
    const h = new Histogram('test', 50, rng.next);
    for (let i = 1; i <= 5000; i++) h.record(i);

    expect(h.count).toBe(5000);
    expect(h.min).toBe(1);
    expect(h.max).toBe(5000);
    expect(h.mean).toBeCloseTo(2500.5, 5);
    expect(h.snapshot().sampled).toBe(true);
  });

  it('estimates percentiles within a reasonable band when sampling', () => {
    const rng = createRng(11);
    const h = new Histogram('test', 2000, rng.next);
    for (let i = 1; i <= 50_000; i++) h.record(i);

    // A uniform 1..50000 has a true p50 of ~25000.
    expect(h.percentile(50)).toBeGreaterThan(21_000);
    expect(h.percentile(50)).toBeLessThan(29_000);
  });

  it('buckets samples for the report chart', () => {
    const h = new Histogram('test');
    for (const v of [1, 2, 3, 8, 9, 10]) h.record(v);

    const buckets = h.buckets(3);
    expect(buckets).toHaveLength(3);
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(6);
  });

  it('answers safely when empty', () => {
    const h = new Histogram('empty');
    expect(h.count).toBe(0);
    expect(h.percentile(95)).toBe(0);
    expect(h.buckets()).toEqual([]);
  });
});

describe('MetricsRegistry', () => {
  it('accumulates counters, gauges and observations', () => {
    const registry = new MetricsRegistry();
    registry.increment('leads.completed');
    registry.increment('leads.completed', 4);
    registry.setGauge('queue.depth', 12);
    registry.observe('latency', 100);
    registry.observe('latency', 300);

    expect(registry.counter('leads.completed')).toBe(5);
    expect(registry.gauge('queue.depth')).toBe(12);
    expect(registry.histogram('latency')?.mean).toBe(200);
    expect(registry.counter('never.touched')).toBe(0);
  });

  it('groups counters by prefix for the error breakdown', () => {
    const registry = new MetricsRegistry();
    registry.increment('error.llm.timeout', 3);
    registry.increment('error.crm.rate_limited', 7);
    registry.increment('leads.completed', 99);

    const errors = registry.countersWithPrefix('error.');
    expect(errors).toEqual([
      { name: 'error.crm.rate_limited', value: 7 },
      { name: 'error.llm.timeout', value: 3 },
    ]);
  });
});

describe('CostTracker', () => {
  it('prices input and output tokens separately', () => {
    const tracker = new CostTracker('gpt-4.1-mini');
    tracker.record({ promptTokens: 1_000_000, completionTokens: 1_000_000 });

    const price = pricingFor('gpt-4.1-mini');
    const breakdown = tracker.breakdown(1);
    expect(breakdown.inputCostUsd).toBeCloseTo(price.input, 6);
    expect(breakdown.outputCostUsd).toBeCloseTo(price.output, 6);
    expect(breakdown.totalCostUsd).toBeCloseTo(price.input + price.output, 6);
  });

  it('counts unbilled attempts as calls but not as cost', () => {
    const tracker = new CostTracker('gpt-4.1-mini');
    tracker.record({ promptTokens: 1000, completionTokens: 100 });
    tracker.recordUnbilled();
    tracker.recordUnbilled();

    expect(tracker.stats.calls).toBe(3);
    expect(tracker.stats.billedCalls).toBe(1);
    // A 429 costs a round trip, not money.
    expect(tracker.breakdown(1).totalCostUsd).toBeGreaterThan(0);
    expect(tracker.breakdown(1).promptTokens).toBe(1000);
  });

  it('projects linearly to 10,000 leads', () => {
    const tracker = new CostTracker('gpt-4.1-mini');
    for (let i = 0; i < 10; i++) tracker.record({ promptTokens: 500, completionTokens: 120 });

    const breakdown = tracker.breakdown(10);
    expect(breakdown.projectedAt10kUsd).toBeCloseTo(breakdown.costPerLeadUsd * 10_000, 8);
    expect(breakdown.totalCostEur).toBeCloseTo(breakdown.totalCostUsd / loadPricing().usd_per_eur, 8);
  });

  it('refuses a model it has no price for, rather than reporting zero', () => {
    expect(() => new CostTracker('gpt-9-imaginary')).toThrow(/No pricing for model/);
  });

  it('carries the as-of date so a stale price is visible', () => {
    expect(new CostTracker('gpt-4.1-mini').breakdown(1).asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('estimateTokens', () => {
  it('scales with text length and never returns zero', () => {
    expect(estimateTokens('')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });
});
