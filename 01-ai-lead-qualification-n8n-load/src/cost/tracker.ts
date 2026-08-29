import { loadPricing, pricingFor, type PricingFile } from './pricing.js';

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface CostBreakdown {
  model: string;
  asOf: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
  totalCostEur: number;
  costPerLeadUsd: number;
  /** What the same workload would cost at 10,000 leads. */
  projectedAt10kUsd: number;
  projectedAt10kEur: number;
}

/**
 * Token and cost accounting.
 *
 * Counts *every* call, including the ones that failed and the retries — a cost
 * model that only counts successes will understate the bill by exactly the
 * amount that matters during an incident. A 429 costs nothing, but a call that
 * returned malformed JSON and got retried was billed twice.
 */
export class CostTracker {
  private calls = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private billedCalls = 0;

  constructor(
    private readonly model: string,
    private readonly pricing: PricingFile = loadPricing(),
  ) {
    pricingFor(model, pricing); // fail fast if the model is unpriced
  }

  /** Records a call that reached the model and was billed. */
  record(usage: TokenUsage): void {
    this.calls++;
    this.billedCalls++;
    this.promptTokens += usage.promptTokens;
    this.completionTokens += usage.completionTokens;
  }

  /** Records an attempt that was never billed — a 429, or a connection error. */
  recordUnbilled(): void {
    this.calls++;
  }

  get totalCostUsd(): number {
    const price = pricingFor(this.model, this.pricing);
    return (
      (this.promptTokens / 1_000_000) * price.input +
      (this.completionTokens / 1_000_000) * price.output
    );
  }

  breakdown(leadsProcessed: number): CostBreakdown {
    const price = pricingFor(this.model, this.pricing);
    const inputCostUsd = (this.promptTokens / 1_000_000) * price.input;
    const outputCostUsd = (this.completionTokens / 1_000_000) * price.output;
    const totalCostUsd = inputCostUsd + outputCostUsd;
    const costPerLeadUsd = leadsProcessed > 0 ? totalCostUsd / leadsProcessed : 0;

    return {
      model: this.model,
      asOf: this.pricing.as_of,
      calls: this.calls,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.promptTokens + this.completionTokens,
      inputCostUsd,
      outputCostUsd,
      totalCostUsd,
      totalCostEur: totalCostUsd / this.pricing.usd_per_eur,
      costPerLeadUsd,
      projectedAt10kUsd: costPerLeadUsd * 10_000,
      projectedAt10kEur: (costPerLeadUsd * 10_000) / this.pricing.usd_per_eur,
    };
  }

  get stats(): { calls: number; billedCalls: number; totalTokens: number } {
    return {
      calls: this.calls,
      billedCalls: this.billedCalls,
      totalTokens: this.promptTokens + this.completionTokens,
    };
  }
}

/** Rough token estimate: ~4 characters per token for English prose. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
