export type JobState = 'queued' | 'delayed' | 'running' | 'succeeded' | 'failed' | 'dead';

export interface Job<T> {
  id: string;
  payload: T;
  state: JobState;
  /** Completed attempts. 0 until the first run finishes. */
  attempts: number;
  maxAttempts: number;
  enqueuedAt: number;
  /** When a delayed retry becomes eligible again. */
  availableAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  lastError: { code: string; message: string; retryable: boolean } | null;
  /** Total virtual ms spent waiting in the queue across all attempts. */
  queueWaitMs: number;
}

export function createJob<T>(id: string, payload: T, maxAttempts: number, now: number): Job<T> {
  return {
    id,
    payload,
    state: 'queued',
    attempts: 0,
    maxAttempts,
    enqueuedAt: now,
    availableAt: now,
    startedAt: null,
    finishedAt: null,
    lastError: null,
    queueWaitMs: 0,
  };
}

export function describeError(error: unknown): { code: string; message: string; retryable: boolean } {
  const code = (error as { code?: string })?.code ?? 'unknown_error';
  const retryable = (error as { retryable?: boolean })?.retryable === true;
  const message = error instanceof Error ? error.message : String(error);
  return { code, message, retryable };
}
