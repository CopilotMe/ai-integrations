export interface RetryOptions {
  /** Number of *additional* attempts after the first one. */
  retries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injected in tests so retry logic runs without real timers. */
  sleep?: (ms: number) => Promise<void>;
  /** Deterministic in tests; `Math.random` in production. */
  random?: () => number;
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Exponential backoff with full jitter.
 *
 * Full jitter (rather than fixed backoff) matters here because n8n fans a batch
 * of leads out concurrently — without it, every retry from a rate-limited batch
 * lands on the provider at exactly the same moment.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const {
    retries,
    baseDelayMs = 250,
    maxDelayMs = 8000,
    sleep = defaultSleep,
    random = Math.random,
    isRetryable = () => true,
    onRetry,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === retries || !isRetryable(error)) throw error;

      const explicit = retryAfterMs(error);
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const delayMs = explicit ?? Math.round(backoff * random());

      onRetry?.(error, attempt + 1, delayMs);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

/** Honour a server-supplied Retry-After over our own backoff. */
function retryAfterMs(error: unknown): number | undefined {
  const value = (error as { retryAfterMs?: unknown })?.retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
