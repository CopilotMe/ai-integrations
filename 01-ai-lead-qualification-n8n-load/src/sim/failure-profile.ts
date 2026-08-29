/**
 * How badly each dependency behaves.
 *
 * Defaults are set to "a normal Tuesday" — a real integration sees a low but
 * non-zero rate of every one of these. `--profile degraded` and
 * `--profile outage` turn them up so the pipeline's failure handling can be
 * observed doing its job rather than merely asserted in a unit test.
 */
export interface ProviderProfile {
  /** Median latency in virtual ms. */
  medianLatencyMs: number;
  /** Log-normal sigma. Higher = fatter tail. 0.5 gives p99 ~= 3.5x p50. */
  latencySigma: number;
  rateLimitRate: number;
  serverErrorRate: number;
  timeoutRate: number;
}

export interface FailureProfile {
  name: string;
  description: string;
  llm: ProviderProfile & {
    /** Schema-invalid or unparseable output despite structured outputs. */
    malformedRate: number;
  };
  crm: ProviderProfile & {
    /** Contact already exists — triggers the search-and-patch path. */
    conflictRate: number;
  };
  notifier: ProviderProfile;
}

export const PROFILES: Record<string, FailureProfile> = {
  healthy: {
    name: 'healthy',
    description: 'Everything up. Only the tail latency is interesting.',
    llm: { medianLatencyMs: 900, latencySigma: 0.45, rateLimitRate: 0, serverErrorRate: 0, timeoutRate: 0, malformedRate: 0 },
    crm: { medianLatencyMs: 180, latencySigma: 0.35, rateLimitRate: 0, serverErrorRate: 0, timeoutRate: 0, conflictRate: 0.05 },
    notifier: { medianLatencyMs: 120, latencySigma: 0.3, rateLimitRate: 0, serverErrorRate: 0, timeoutRate: 0 },
  },
  normal: {
    name: 'normal',
    description: 'A normal production day: low background error rates on every dependency.',
    llm: { medianLatencyMs: 900, latencySigma: 0.5, rateLimitRate: 0.02, serverErrorRate: 0.01, timeoutRate: 0.005, malformedRate: 0.01 },
    crm: { medianLatencyMs: 180, latencySigma: 0.4, rateLimitRate: 0.01, serverErrorRate: 0.005, timeoutRate: 0.002, conflictRate: 0.08 },
    notifier: { medianLatencyMs: 120, latencySigma: 0.35, rateLimitRate: 0.02, serverErrorRate: 0.01, timeoutRate: 0.002 },
  },
  degraded: {
    name: 'degraded',
    description: 'The model provider is struggling: slow, rate limiting hard, occasionally incoherent.',
    llm: { medianLatencyMs: 2600, latencySigma: 0.8, rateLimitRate: 0.18, serverErrorRate: 0.08, timeoutRate: 0.05, malformedRate: 0.04 },
    crm: { medianLatencyMs: 320, latencySigma: 0.5, rateLimitRate: 0.04, serverErrorRate: 0.02, timeoutRate: 0.01, conflictRate: 0.08 },
    notifier: { medianLatencyMs: 200, latencySigma: 0.4, rateLimitRate: 0.05, serverErrorRate: 0.03, timeoutRate: 0.01 },
  },
  outage: {
    name: 'outage',
    description: 'Model provider largely down. Exercises degraded-mode scoring and the dead-letter path.',
    llm: { medianLatencyMs: 5000, latencySigma: 0.9, rateLimitRate: 0.25, serverErrorRate: 0.45, timeoutRate: 0.2, malformedRate: 0.05 },
    crm: { medianLatencyMs: 600, latencySigma: 0.6, rateLimitRate: 0.1, serverErrorRate: 0.15, timeoutRate: 0.05, conflictRate: 0.08 },
    notifier: { medianLatencyMs: 300, latencySigma: 0.5, rateLimitRate: 0.1, serverErrorRate: 0.1, timeoutRate: 0.02 },
  },
};

export function resolveProfile(name: string): FailureProfile {
  const profile = PROFILES[name];
  if (!profile) {
    throw new Error(`Unknown profile "${name}". Available: ${Object.keys(PROFILES).join(', ')}`);
  }
  return profile;
}
