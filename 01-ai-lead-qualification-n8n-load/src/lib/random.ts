/**
 * Seeded pseudo-randomness.
 *
 * A load simulation whose results move between runs cannot be used to compare
 * two configurations. Every random choice here — latency, failure injection,
 * generated lead content — comes from a seeded generator, so `--seed 42` twice
 * produces byte-identical results.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  int(minInclusive: number, maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  /** True with probability `p`. */
  chance(p: number): boolean;
  /** Log-normal sample — the shape real API latency actually has. */
  logNormal(medianMs: number, sigma: number): number;
}

/** mulberry32: small, fast, and good enough for simulation. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min)),
    pick: (items) => items[Math.floor(next() * items.length)]!,
    chance: (p) => next() < p,
    logNormal: (medianMs, sigma) => {
      // Box-Muller for the normal sample, then exponentiate. Median (not mean)
      // parameterisation, because "p50 latency" is how APIs are described.
      const u1 = Math.max(next(), Number.EPSILON);
      const u2 = next();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      return medianMs * Math.exp(sigma * z);
    },
  };

  return rng;
}
