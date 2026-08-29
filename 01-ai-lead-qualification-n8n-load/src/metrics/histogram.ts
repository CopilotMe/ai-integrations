/**
 * Latency histogram with reservoir sampling.
 *
 * Percentiles need the samples, but 10,000 leads x 4 measured stages is a lot
 * of numbers to hold to answer "what is p95". Below `reservoirSize` every
 * sample is kept and percentiles are exact; above it, Vitter's Algorithm R
 * keeps a uniform random subsample so memory stays flat and the estimate stays
 * unbiased. Count, min, max and mean are always exact — they are streamed.
 */
export class Histogram {
  private samples: number[] = [];
  private seen = 0;
  private sum = 0;
  private minValue = Number.POSITIVE_INFINITY;
  private maxValue = Number.NEGATIVE_INFINITY;
  private sorted = false;

  constructor(
    readonly name: string,
    private readonly reservoirSize = 20_000,
    private readonly random: () => number = Math.random,
  ) {}

  record(value: number): void {
    this.seen++;
    this.sum += value;
    if (value < this.minValue) this.minValue = value;
    if (value > this.maxValue) this.maxValue = value;

    if (this.samples.length < this.reservoirSize) {
      this.samples.push(value);
      this.sorted = false;
      return;
    }
    const index = Math.floor(this.random() * this.seen);
    if (index < this.reservoirSize) {
      this.samples[index] = value;
      this.sorted = false;
    }
  }

  get count(): number {
    return this.seen;
  }

  get mean(): number {
    return this.seen === 0 ? 0 : this.sum / this.seen;
  }

  get min(): number {
    return this.seen === 0 ? 0 : this.minValue;
  }

  get max(): number {
    return this.seen === 0 ? 0 : this.maxValue;
  }

  /** `p` in 0..100. Linear interpolation between neighbouring samples. */
  percentile(p: number): number {
    if (this.samples.length === 0) return 0;
    if (!this.sorted) {
      this.samples.sort((a, b) => a - b);
      this.sorted = true;
    }
    const rank = (p / 100) * (this.samples.length - 1);
    const lower = Math.floor(rank);
    const upper = Math.ceil(rank);
    if (lower === upper) return this.samples[lower]!;
    const weight = rank - lower;
    return this.samples[lower]! * (1 - weight) + this.samples[upper]! * weight;
  }

  /** Equal-width buckets between min and max, for the report's chart. */
  buckets(count = 24): Array<{ from: number; to: number; count: number }> {
    if (this.samples.length === 0) return [];
    const lo = this.min;
    const hi = this.max;
    const width = (hi - lo) / count || 1;
    const buckets = Array.from({ length: count }, (_, i) => ({
      from: lo + i * width,
      to: lo + (i + 1) * width,
      count: 0,
    }));
    for (const sample of this.samples) {
      const index = Math.min(count - 1, Math.max(0, Math.floor((sample - lo) / width)));
      buckets[index]!.count++;
    }
    return buckets;
  }

  snapshot(): HistogramSnapshot {
    return {
      name: this.name,
      count: this.count,
      min: round(this.min),
      mean: round(this.mean),
      p50: round(this.percentile(50)),
      p90: round(this.percentile(90)),
      p95: round(this.percentile(95)),
      p99: round(this.percentile(99)),
      max: round(this.max),
      /** True when percentiles are estimated from a subsample rather than exact. */
      sampled: this.seen > this.samples.length,
      buckets: this.buckets().map((b) => ({ from: round(b.from), to: round(b.to), count: b.count })),
    };
  }
}

export interface HistogramSnapshot {
  name: string;
  count: number;
  min: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  sampled: boolean;
  buckets: Array<{ from: number; to: number; count: number }>;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
