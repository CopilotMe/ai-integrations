import type { Clock } from '../lib/clock.js';

export interface TokenBucketOptions {
  /** Maximum tokens held — the size of a burst this bucket will allow. */
  capacity: number;
  /** Sustained rate, in tokens per second of virtual time. */
  refillPerSecond: number;
  clock: Clock;
  name: string;
}

/**
 * Token bucket, the standard shape for client-side rate limiting.
 *
 * Chosen over a fixed window because real APIs allow a burst and then throttle,
 * and because a fixed window lets twice the limit through at a window boundary.
 * Capacity models the burst; `refillPerSecond` models the sustained ceiling.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;
  private waitingCount = 0;
  private totalWaitMs = 0;
  private acquired = 0;

  constructor(private readonly options: TokenBucketOptions) {
    this.tokens = options.capacity;
    this.lastRefillAt = options.clock.now();
  }

  get name(): string {
    return this.options.name;
  }

  /** Tokens currently available, for the dashboard. */
  get available(): number {
    this.refill();
    return this.tokens;
  }

  get stats(): { acquired: number; waiting: number; totalWaitMs: number } {
    return { acquired: this.acquired, waiting: this.waitingCount, totalWaitMs: this.totalWaitMs };
  }

  tryAcquire(count = 1): boolean {
    this.refill();
    if (this.tokens < count) return false;
    this.tokens -= count;
    this.acquired += count;
    return true;
  }

  /**
   * Waits until `count` tokens are available, then takes them.
   *
   * Returns how long *this caller* was held back. Note that `stats.totalWaitMs`
   * sums across concurrent callers, so with N workers queued on one bucket it
   * legitimately exceeds the run's elapsed time — it is caller-milliseconds of
   * contention, not elapsed time. Reports must label it as such.
   */
  async acquire(count = 1): Promise<number> {
    if (count > this.options.capacity) {
      throw new Error(
        `${this.options.name}: cannot acquire ${count} tokens from a bucket of capacity ${this.options.capacity}`,
      );
    }

    const startedAt = this.options.clock.now();
    this.waitingCount++;
    try {
      for (;;) {
        if (this.tryAcquire(count)) break;
        await this.options.clock.sleep(this.msUntilAvailable(count));
      }
    } finally {
      this.waitingCount--;
    }

    const waited = this.options.clock.now() - startedAt;
    this.totalWaitMs += waited;
    return waited;
  }

  private refill(): void {
    const now = this.options.clock.now();
    const elapsedMs = now - this.lastRefillAt;
    if (elapsedMs <= 0) return;
    this.tokens = Math.min(
      this.options.capacity,
      this.tokens + (elapsedMs / 1000) * this.options.refillPerSecond,
    );
    this.lastRefillAt = now;
  }

  private msUntilAvailable(count: number): number {
    const deficit = count - this.tokens;
    if (deficit <= 0) return 0;
    // A small floor keeps a busy pool from spinning on sub-millisecond waits.
    return Math.max(1, (deficit / this.options.refillPerSecond) * 1000);
  }
}
