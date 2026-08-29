import { AsyncLocalStorage } from 'node:async_hooks';
import { createRng, type Rng } from '../lib/random.js';

const storage = new AsyncLocalStorage<Rng>();

/**
 * Per-lead random streams.
 *
 * A single shared generator is not reproducible under concurrency: N workers
 * interleave in whatever order the event loop happens to pick, so they consume
 * the sequence in a different order on every run and "same seed, same result"
 * quietly stops being true. Each job therefore gets its own stream, derived
 * from the run seed and the job's index, and reads it through async context —
 * so a lead's latency and failures depend only on that lead, never on what the
 * other workers were doing at the time.
 *
 * The attempt number is folded into the derivation so a retry draws fresh
 * randomness; without it a job that failed once would fail identically forever.
 */
export function withLeadRng<T>(seed: number, index: number, attempt: number, fn: () => Promise<T>): Promise<T> {
  return storage.run(createRng(deriveSeed(seed, index, attempt)), fn);
}

/** The current lead's stream, or `fallback` outside any lead (the producer). */
export function currentRng(fallback: Rng): Rng {
  return storage.getStore() ?? fallback;
}

/** Cheap avalanche mix so nearby indices give unrelated streams. */
export function deriveSeed(seed: number, index: number, attempt: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (const value of [index, attempt]) {
    h = (h ^ value) >>> 0;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
  }
  return h >>> 0;
}
