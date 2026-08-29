import { describe, expect, it } from 'vitest';
import { createRng } from '../src/lib/random.js';
import { createLeadGenerator } from '../src/sim/generator.js';
import { parseArgs } from '../src/sim/cli.js';
import { DEFAULT_LIMITS } from '../src/ratelimit/limiter.js';
import { runSimulation } from '../src/sim/runner.js';
import { silentLogger, testRules } from './fixtures/leads.js';

const baseOptions = {
  concurrency: 4,
  seed: 42,
  timeScale: 0.001,
  profileName: 'normal',
  model: 'gpt-4.1-mini',
  rateLimitEnabled: true,
  limits: DEFAULT_LIMITS,
  maxQueueDepth: 100,
  maxAttempts: 3,
  rules: testRules,
  llmTimeoutMs: 15_000,
  llmMaxRetries: 2,
  logger: silentLogger,
};

describe('lead generator', () => {
  it('is deterministic for a given seed', () => {
    const a = Array.from({ length: 40 }, createLeadGenerator(createRng(5)));
    const b = Array.from({ length: 40 }, createLeadGenerator(createRng(5)));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('differs across seeds', () => {
    const a = Array.from({ length: 40 }, createLeadGenerator(createRng(1)));
    const b = Array.from({ length: 40 }, createLeadGenerator(createRng(2)));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('produces a mix that includes invalid payloads and duplicates', () => {
    const generate = createLeadGenerator(createRng(3));
    const kinds = new Set(Array.from({ length: 600 }, generate).map((l) => l.kind));
    expect(kinds.has('invalid')).toBe(true);
    expect(kinds.has('duplicate')).toBe(true);
    expect(kinds.has('enterprise')).toBe(true);
  });
});

describe('CLI parsing', () => {
  it('defaults to 10 leads at real time', () => {
    const options = parseArgs([]);
    if (options === 'help') throw new Error('unexpected help');
    expect(options.leads).toBe(10);
    expect(options.timeScale).toBe(1);
    expect(options.rateLimit).toBe(true);
  });

  it('compresses time automatically for large runs', () => {
    const options = parseArgs(['--leads', '10000']);
    if (options === 'help') throw new Error('unexpected help');
    expect(options.timeScale).toBeLessThan(0.02);
  });

  it('rejects an out-of-range or unparseable value instead of silently defaulting', () => {
    expect(() => parseArgs(['--concurrency', '0'])).toThrow(/between/);
    expect(() => parseArgs(['--leads', 'lots'])).toThrow(/between/);
    expect(() => parseArgs(['--leads'])).toThrow(/requires a value/);
    expect(() => parseArgs(['--profile', 'nonsense'])).toThrow(/Unknown --profile/);
  });

  it('honours --no-rate-limit and --help', () => {
    const options = parseArgs(['--no-rate-limit']);
    if (options === 'help') throw new Error('unexpected help');
    expect(options.rateLimit).toBe(false);
    expect(parseArgs(['--help'])).toBe('help');
  });
});

describe('runSimulation', () => {
  it('accounts for every lead: completed + rejected + dead == generated', async () => {
    const result = await runSimulation({ ...baseOptions, leads: 120 });
    const { totals } = result;
    expect(totals.completed + totals.rejected + totals.dead).toBe(120);
    expect(totals.completed).toBeGreaterThan(0);
  });

  it('produces identical results for the same seed', async () => {
    const a = await runSimulation({ ...baseOptions, leads: 60 });
    const b = await runSimulation({ ...baseOptions, leads: 60 });

    expect(b.totals).toEqual(a.totals);
    expect(b.classifications).toEqual(a.classifications);
    expect(b.cost.totalTokens).toBe(a.cost.totalTokens);
  });

  it('produces different results for a different seed', async () => {
    const a = await runSimulation({ ...baseOptions, leads: 60, seed: 1 });
    const b = await runSimulation({ ...baseOptions, leads: 60, seed: 999 });
    expect(b.classifications).not.toEqual(a.classifications);
  });

  it('gives the same measurements at a different time scale', async () => {
    // The whole point of the virtual clock: compressing wall time must not
    // change the experiment, only how long it takes to watch.
    const slow = await runSimulation({ ...baseOptions, leads: 40, timeScale: 0.01 });
    const fast = await runSimulation({ ...baseOptions, leads: 40, timeScale: 0.0005 });

    expect(fast.totals).toEqual(slow.totals);
    expect(fast.classifications).toEqual(slow.classifications);
    expect(fast.cost.totalCostUsd).toBeCloseTo(slow.cost.totalCostUsd, 10);
  });

  it('never exceeds the queue depth ceiling', async () => {
    const result = await runSimulation({ ...baseOptions, leads: 200, maxQueueDepth: 15, concurrency: 2 });
    const peakDepth = Math.max(...result.metrics.timeseries.map((p) => p.queueDepth), 0);
    expect(peakDepth).toBeLessThanOrEqual(15);
  });

  it('never runs more jobs at once than the configured concurrency', async () => {
    const result = await runSimulation({ ...baseOptions, leads: 150, concurrency: 6 });
    const peakInFlight = Math.max(...result.metrics.timeseries.map((p) => p.inFlight), 0);
    expect(peakInFlight).toBeLessThanOrEqual(6);
  });

  it('loses no leads even during a provider outage', async () => {
    const result = await runSimulation({ ...baseOptions, leads: 100, profileName: 'outage', concurrency: 8 });

    expect(result.totals.completed + result.totals.rejected + result.totals.dead).toBe(100);
    // Degraded-mode scoring keeps leads moving when the model is unavailable.
    expect(result.totals.degraded).toBeGreaterThan(0);
    expect(result.totals.completed).toBeGreaterThan(0);
  });

  it('records latency, cost and classifications for a healthy run', async () => {
    const result = await runSimulation({ ...baseOptions, leads: 80, profileName: 'healthy' });

    expect(result.metrics.histograms['latency.end_to_end_ms']?.count).toBeGreaterThan(0);
    expect(result.cost.totalCostUsd).toBeGreaterThan(0);
    expect(result.cost.projectedAt10kUsd).toBeGreaterThan(result.cost.totalCostUsd);
    const classified = Object.values(result.classifications).reduce((a, b) => a + b, 0);
    expect(classified).toBe(result.totals.completed);
    // A healthy profile injects nothing, so nothing should degrade.
    expect(result.totals.degraded).toBe(0);
  });

  it('deduplicates redelivered leads rather than creating a contact each time', async () => {
    const result = await runSimulation({ ...baseOptions, leads: 300, profileName: 'healthy' });
    expect(result.totals.contacts).toBeLessThan(result.totals.completed);
  });

  it('rate limiting slows the run down and removes 429s', async () => {
    const limits = { llm: { rpm: 120, burst: 5 }, crm: { rpm: 600 }, notifier: { rpm: 600 } };
    const limited = await runSimulation({ ...baseOptions, leads: 100, limits, profileName: 'healthy', rateLimitEnabled: true });
    const unlimited = await runSimulation({ ...baseOptions, leads: 100, limits, profileName: 'healthy', rateLimitEnabled: false });

    // Same work either way — the limiter buys provider-friendliness with time.
    expect(limited.totals.completed).toBe(unlimited.totals.completed);
    expect(limited.durationVirtualMs).toBeGreaterThan(unlimited.durationVirtualMs);
    expect(limited.rateLimit.waits.llm).toBeGreaterThan(0);
    expect(unlimited.rateLimit.waits.llm).toBe(0);
  });
});
