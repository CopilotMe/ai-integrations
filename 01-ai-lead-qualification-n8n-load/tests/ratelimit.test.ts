import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/lib/clock.js';
import { LimiterRegistry } from '../src/ratelimit/limiter.js';
import { TokenBucket } from '../src/ratelimit/token-bucket.js';

const bucket = (clock: ManualClock, capacity: number, refillPerSecond: number) =>
  new TokenBucket({ name: 'test', capacity, refillPerSecond, clock });

describe('TokenBucket', () => {
  it('allows a burst up to capacity, then refuses', () => {
    const clock = new ManualClock();
    const limiter = bucket(clock, 3, 1);

    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
  });

  it('refills at the configured rate', async () => {
    const clock = new ManualClock();
    const limiter = bucket(clock, 2, 10); // 10 per second

    limiter.tryAcquire(2);
    expect(limiter.tryAcquire()).toBe(false);

    await clock.advance(100); // 1 token's worth
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
  });

  it('never refills beyond capacity, however long it idles', async () => {
    const clock = new ManualClock();
    const limiter = bucket(clock, 5, 100);

    await clock.advance(60_000);
    expect(limiter.available).toBeCloseTo(5, 5);
  });

  it('makes a waiting caller block until a token is available', async () => {
    const clock = new ManualClock();
    const limiter = bucket(clock, 1, 2); // one token per 500ms
    limiter.tryAcquire();

    let waited: number | null = null;
    const pending = limiter.acquire().then((w) => {
      waited = w;
    });

    await clock.advance(200);
    expect(waited).toBeNull();

    await clock.advance(400);
    await pending;
    expect(waited).toBeGreaterThanOrEqual(500);
  });

  it('shapes sustained throughput to the configured rate', async () => {
    const clock = new ManualClock();
    const limiter = bucket(clock, 1, 10); // burst of 1, then 10 per second
    let acquired = 0;

    const runner = (async () => {
      for (let i = 0; i < 11; i++) {
        await limiter.acquire();
        acquired++;
      }
    })();

    // One immediate token, then one per 100ms: 11 acquisitions need ~1000ms.
    await clock.advance(500);
    expect(acquired).toBeGreaterThanOrEqual(5);
    expect(acquired).toBeLessThanOrEqual(7);

    await clock.advance(700);
    await runner;
    expect(acquired).toBe(11);
  });

  it('refuses a request larger than the bucket rather than deadlocking', async () => {
    const clock = new ManualClock();
    const limiter = bucket(clock, 2, 1);
    await expect(limiter.acquire(5)).rejects.toThrow(/capacity/);
  });
});

describe('LimiterRegistry', () => {
  it('converts rpm into a per-second refill rate', async () => {
    const clock = new ManualClock();
    const registry = new LimiterRegistry(
      { llm: { rpm: 60, burst: 1 }, crm: { rpm: 600 }, notifier: { rpm: 60 } },
      clock,
    );

    expect(registry.llm.tryAcquire()).toBe(true);
    expect(registry.llm.tryAcquire()).toBe(false);
    await clock.advance(1000); // 60 rpm = 1 per second
    expect(registry.llm.tryAcquire()).toBe(true);
  });

  it('is a no-op when limiting is disabled', async () => {
    const clock = new ManualClock();
    const registry = new LimiterRegistry(
      { llm: { rpm: 1, burst: 1 }, crm: { rpm: 1 }, notifier: { rpm: 1 } },
      clock,
      false,
    );

    // Would block for a minute if limiting were active.
    for (let i = 0; i < 50; i++) {
      expect(await registry.acquire('llm')).toBe(0);
    }
    expect(registry.isEnabled).toBe(false);
  });
});
