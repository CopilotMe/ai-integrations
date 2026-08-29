import type { Clock } from '../lib/clock.js';
import { describeError, type Job } from './job.js';
import type { JobQueue } from './queue.js';

export interface WorkerPoolOptions<T> {
  queue: JobQueue<T>;
  concurrency: number;
  clock: Clock;
  handle: (job: Job<T>) => Promise<void>;
  /** Backoff for a retryable failure, given the attempt number (1-based). */
  retryDelay: (attempt: number) => number;
  onSettled?: (job: Job<T>, outcome: 'succeeded' | 'retrying' | 'dead') => void;
}

/**
 * A fixed pool of workers pulling from the queue until it is closed and drained.
 *
 * Concurrency is fixed rather than adaptive on purpose: the simulation exists
 * to show what a *chosen* concurrency does to latency, rate-limit pressure and
 * cost, and an autoscaler in the middle would obscure exactly that.
 */
export async function runWorkerPool<T>(options: WorkerPoolOptions<T>): Promise<void> {
  const { queue, concurrency, handle, retryDelay, onSettled } = options;

  const worker = async (): Promise<void> => {
    for (;;) {
      const job = await queue.next();
      if (!job) return;

      try {
        await handle(job);
        queue.succeed(job);
        onSettled?.(job, 'succeeded');
      } catch (error) {
        const described = describeError(error);
        const outcome = queue.fail(job, described, retryDelay(job.attempts));
        onSettled?.(job, outcome);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}
