export interface RetryOptions {
  retries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Exponential backoff with full jitter, honouring a server-supplied
 * `retryAfterMs` when the error carries one.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const {
    retries,
    baseDelayMs = 300,
    maxDelayMs = 10_000,
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

      const explicit = (error as { retryAfterMs?: unknown })?.retryAfterMs;
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const delayMs =
        typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0
          ? explicit
          : Math.round(backoff * random());

      onRetry?.(error, attempt + 1, delayMs);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

export async function withTimeout<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
  onTimeout: () => Error,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);

  try {
    return await fn(controller.signal);
  } catch (error) {
    if (timedOut) throw onTimeout();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
