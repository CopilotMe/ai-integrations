import type { Clock } from '../lib/clock.js';
import { createJob, type Job } from './job.js';

export interface QueueOptions {
  clock: Clock;
  /** Backpressure ceiling. `enqueue` blocks once this many jobs are waiting. */
  maxDepth: number;
  maxAttempts: number;
}

/**
 * In-memory job queue with delayed retries and backpressure.
 *
 * Scope note: this is deliberately not Redis or SQS. The behaviours the
 * simulation needs to demonstrate — bounded depth, delayed re-delivery,
 * attempt limits, a dead-letter terminus — are the behaviours a real broker
 * provides, and modelling them here keeps the whole thing runnable with
 * `npm run simulate` and no infrastructure. `docs/scaling.md` covers what
 * changes when this is swapped for a real broker.
 */
export class JobQueue<T> {
  private readonly ready: Array<Job<T>> = [];
  private readonly delayed: Array<Job<T>> = [];
  private readonly producers: Array<() => void> = [];
  private readonly consumers: Array<() => void> = [];
  private sequence = 0;
  private closed = false;

  /** Jobs handed out but not yet settled. */
  private inFlight = 0;

  readonly dead: Array<Job<T>> = [];

  constructor(private readonly options: QueueOptions) {}

  get depth(): number {
    return this.ready.length + this.delayed.length;
  }

  get running(): number {
    return this.inFlight;
  }

  get isDrained(): boolean {
    return this.depth === 0 && this.inFlight === 0;
  }

  /**
   * Adds a job, waiting if the queue is already at `maxDepth`.
   *
   * Blocking the producer is the point: an unbounded queue converts a
   * throughput problem into an out-of-memory problem, and hides the fact that
   * intake is outrunning processing.
   */
  async enqueue(payload: T): Promise<Job<T>> {
    while (this.depth >= this.options.maxDepth && !this.closed) {
      await new Promise<void>((resolve) => this.producers.push(resolve));
    }
    const job = createJob(`job_${(++this.sequence).toString().padStart(6, '0')}`, payload, this.options.maxAttempts, this.options.clock.now());
    this.ready.push(job);
    this.wakeConsumer();
    return job;
  }

  /**
   * Takes the next available job, waiting for one if necessary.
   * Returns null once the queue is closed and fully drained.
   */
  async next(): Promise<Job<T> | null> {
    for (;;) {
      this.promoteDelayed();

      const job = this.ready.shift();
      if (job) {
        job.state = 'running';
        job.startedAt = this.options.clock.now();
        job.queueWaitMs += job.startedAt - job.availableAt;
        this.inFlight++;
        this.wakeProducer();
        return job;
      }

      if (this.closed && this.depth === 0) return null;

      // Nothing ready. Either wait to be woken by an enqueue, or sleep until
      // the earliest delayed job is due — whichever comes first.
      const nextDueAt = this.earliestDelayedAt();
      if (nextDueAt !== null) {
        await Promise.race([
          this.options.clock.sleep(Math.max(1, nextDueAt - this.options.clock.now())),
          new Promise<void>((resolve) => this.consumers.push(resolve)),
        ]);
      } else {
        await new Promise<void>((resolve) => this.consumers.push(resolve));
      }
    }
  }

  succeed(job: Job<T>): void {
    job.attempts++;
    job.state = 'succeeded';
    job.finishedAt = this.options.clock.now();
    this.settle();
  }

  /**
   * Records a failed attempt.
   *
   * Retryable failures with attempts left go back on the queue with a delay;
   * everything else is terminal and lands in the dead-letter list. Returns
   * what happened so the caller can count it.
   */
  fail(job: Job<T>, error: { code: string; message: string; retryable: boolean }, retryDelayMs: number): 'retrying' | 'dead' {
    job.attempts++;
    job.lastError = error;

    const exhausted = job.attempts >= job.maxAttempts;
    if (!error.retryable || exhausted) {
      job.state = 'dead';
      job.finishedAt = this.options.clock.now();
      this.dead.push(job);
      this.settle();
      return 'dead';
    }

    job.state = 'delayed';
    job.availableAt = this.options.clock.now() + retryDelayMs;
    this.delayed.push(job);
    this.settle();
    return 'retrying';
  }

  /** No more jobs will be added. Consumers drain and then stop. */
  close(): void {
    this.closed = true;
    while (this.consumers.length > 0) this.consumers.pop()!();
    while (this.producers.length > 0) this.producers.pop()!();
  }

  private settle(): void {
    this.inFlight--;
    this.wakeProducer();
    this.wakeConsumer();
  }

  private promoteDelayed(): void {
    if (this.delayed.length === 0) return;
    const now = this.options.clock.now();
    for (let i = this.delayed.length - 1; i >= 0; i--) {
      const job = this.delayed[i]!;
      if (job.availableAt <= now) {
        job.state = 'queued';
        this.delayed.splice(i, 1);
        this.ready.push(job);
      }
    }
  }

  private earliestDelayedAt(): number | null {
    if (this.delayed.length === 0) return null;
    return this.delayed.reduce((min, job) => Math.min(min, job.availableAt), Number.POSITIVE_INFINITY);
  }

  private wakeConsumer(): void {
    this.consumers.pop()?.();
  }

  private wakeProducer(): void {
    if (this.depth < this.options.maxDepth) this.producers.pop()?.();
  }
}
