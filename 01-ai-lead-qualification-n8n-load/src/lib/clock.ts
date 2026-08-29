/**
 * A clock whose time can run faster than the wall.
 *
 * The whole simulation is written against *virtual* milliseconds: provider
 * latency, rate-limit windows, retry backoff. `timeScale` controls how much
 * real time one virtual millisecond costs.
 *
 *   timeScale 1     — real time. 10 leads, honest wall clock.
 *   timeScale 0.02  — 50x faster. 10,000 leads in a couple of minutes.
 *
 * Because every duration in the system is virtual, **the measured results are
 * the same at any time scale**. That property is asserted in `clock.test.ts`;
 * without it, a compressed run would be a different experiment, not a faster
 * one.
 */
export interface Clock {
  /** Virtual milliseconds since the run started. */
  now(): number;
  /** Sleeps for `virtualMs` of virtual time. */
  sleep(virtualMs: number): Promise<void>;
  readonly timeScale: number;
}

export class VirtualClock implements Clock {
  private readonly startedAt = Date.now();

  constructor(readonly timeScale: number = 1) {
    if (timeScale <= 0) throw new Error('timeScale must be greater than 0');
  }

  now(): number {
    return (Date.now() - this.startedAt) / this.timeScale;
  }

  async sleep(virtualMs: number): Promise<void> {
    if (virtualMs <= 0) return;
    const realMs = virtualMs * this.timeScale;
    // setTimeout has a ~1ms floor, so heavily compressed sleeps yield to the
    // event loop instead. Virtual time is derived from real elapsed time, so
    // this stays consistent rather than drifting.
    if (realMs < 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, realMs));
  }
}

/** Lets every pending `.then` chain settle before time moves again. */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Deterministic clock for tests: time only moves when told to. */
export class ManualClock implements Clock {
  readonly timeScale = 1;
  private current = 0;
  private waiters: Array<{ at: number; resolve: () => void }> = [];

  now(): number {
    return this.current;
  }

  sleep(virtualMs: number): Promise<void> {
    if (virtualMs <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push({ at: this.current + virtualMs, resolve });
    });
  }

  /**
   * Advances time and releases anything that falls due, in chronological order.
   *
   * A woken task frequently schedules another sleep immediately (the token
   * bucket loops until it has a token), so after each wake-up the microtask
   * queue is drained to completion before looking for the next due waiter —
   * otherwise the newly-registered sleep is missed and the caller hangs.
   */
  async advance(byMs: number): Promise<void> {
    const target = this.current + byMs;
    let guard = 0;

    for (;;) {
      if (++guard > 100_000) throw new Error('ManualClock.advance did not converge');

      // Drain *before* looking. A task that has not reached its first await yet
      // has registered no sleep, and checking first would miss it entirely and
      // jump straight to the target — which is exactly the bug this replaced.
      await drainMicrotasks();

      const nextDue = this.waiters
        .filter((w) => w.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!nextDue) break;

      this.current = Math.max(this.current, nextDue.at);
      this.waiters = this.waiters.filter((w) => w !== nextDue);
      nextDue.resolve();
    }

    this.current = target;
    await drainMicrotasks();
  }
}
