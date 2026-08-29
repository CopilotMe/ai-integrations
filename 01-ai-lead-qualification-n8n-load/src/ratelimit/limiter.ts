import type { Clock } from '../lib/clock.js';
import { TokenBucket } from './token-bucket.js';

export interface ProviderLimits {
  /** Requests per minute. */
  rpm: number;
  /** Burst size. Defaults to one second's worth of the sustained rate. */
  burst?: number;
}

export interface LimiterConfig {
  llm: ProviderLimits;
  crm: ProviderLimits;
  notifier: ProviderLimits;
}

/**
 * Default limits modelled on the published free/entry tiers of each provider.
 * Override with `--rpm-llm` etc. — the point of the simulation is to see what
 * happens as these move.
 *
 *   OpenAI     tier-1 chat completions, ~500 RPM
 *   HubSpot    100 requests / 10s on a Private App => 600 RPM
 *   Slack      incoming webhooks, ~1 message/second => 60 RPM
 */
export const DEFAULT_LIMITS: LimiterConfig = {
  llm: { rpm: 500, burst: 20 },
  crm: { rpm: 600, burst: 30 },
  notifier: { rpm: 60, burst: 5 },
};

export class LimiterRegistry {
  readonly llm: TokenBucket;
  readonly crm: TokenBucket;
  readonly notifier: TokenBucket;

  constructor(config: LimiterConfig, clock: Clock, private readonly enabled = true) {
    this.llm = bucket('llm', config.llm, clock);
    this.crm = bucket('crm', config.crm, clock);
    this.notifier = bucket('notifier', config.notifier, clock);
  }

  /**
   * Waits for capacity and returns the delay incurred.
   *
   * With limiting disabled this is a no-op, which is the interesting
   * comparison: the same run without client-side limiting hammers the provider
   * into 429s and pays for them in retries. `--no-rate-limit` shows it.
   */
  async acquire(provider: 'llm' | 'crm' | 'notifier', tokens = 1): Promise<number> {
    if (!this.enabled) return 0;
    return this[provider].acquire(tokens);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }
}

function bucket(name: string, limits: ProviderLimits, clock: Clock): TokenBucket {
  const refillPerSecond = limits.rpm / 60;
  return new TokenBucket({
    name,
    capacity: limits.burst ?? Math.max(1, Math.ceil(refillPerSecond)),
    refillPerSecond,
    clock,
  });
}
