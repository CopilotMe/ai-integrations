import { describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../src/lib/clock.js';
import { JobQueue } from '../src/queue/queue.js';
import { runWorkerPool } from '../src/queue/worker.js';

const build = (overrides: { maxDepth?: number; maxAttempts?: number } = {}) => {
  const clock = new ManualClock();
  const queue = new JobQueue<string>({
    clock,
    maxDepth: overrides.maxDepth ?? 10,
    maxAttempts: overrides.maxAttempts ?? 3,
  });
  return { clock, queue };
};

describe('JobQueue', () => {
  it('delivers jobs in FIFO order', async () => {
    const { queue } = build();
    await queue.enqueue('a');
    await queue.enqueue('b');

    expect((await queue.next())?.payload).toBe('a');
    expect((await queue.next())?.payload).toBe('b');
  });

  it('applies backpressure once maxDepth is reached', async () => {
    const { queue } = build({ maxDepth: 2 });
    await queue.enqueue('a');
    await queue.enqueue('b');

    let third = false;
    const pending = queue.enqueue('c').then(() => {
      third = true;
    });

    await Promise.resolve();
    // The producer is blocked — this is the point of a bounded queue.
    expect(third).toBe(false);
    expect(queue.depth).toBe(2);

    const job = await queue.next();
    queue.succeed(job!);
    await pending;
    expect(third).toBe(true);
  });

  it('re-queues a retryable failure after the delay and not before', async () => {
    const { clock, queue } = build();
    await queue.enqueue('a');

    const job = await queue.next();
    const outcome = queue.fail(job!, { code: 'crm_error', message: '503', retryable: true }, 1000);

    expect(outcome).toBe('retrying');
    expect(job!.state).toBe('delayed');
    expect(job!.attempts).toBe(1);

    // Nothing is available yet, so the consumer stays parked.
    let delivered: string | null = null;
    const pending = queue.next().then((j) => {
      delivered = j?.payload ?? null;
    });

    await clock.advance(500);
    expect(delivered).toBeNull();

    await clock.advance(600);
    await pending;
    expect(delivered).toBe('a');
  });

  it('dead-letters a job once attempts are exhausted', async () => {
    const { queue } = build({ maxAttempts: 2 });
    await queue.enqueue('a');

    const first = await queue.next();
    expect(queue.fail(first!, { code: 'llm_timeout', message: 'timeout', retryable: true }, 0)).toBe('retrying');

    const second = await queue.next();
    expect(queue.fail(second!, { code: 'llm_timeout', message: 'timeout', retryable: true }, 0)).toBe('dead');

    expect(queue.dead).toHaveLength(1);
    expect(queue.dead[0]?.attempts).toBe(2);
    expect(queue.dead[0]?.lastError?.code).toBe('llm_timeout');
  });

  it('dead-letters a non-retryable failure immediately, without burning attempts', async () => {
    const { queue } = build({ maxAttempts: 5 });
    await queue.enqueue('a');

    const job = await queue.next();
    expect(queue.fail(job!, { code: 'crm_error', message: '400 bad request', retryable: false }, 0)).toBe('dead');
    expect(queue.dead[0]?.attempts).toBe(1);
  });

  it('accumulates queue wait time across retries', async () => {
    const { clock, queue } = build();
    await queue.enqueue('a');

    await clock.advance(200);
    const first = await queue.next();
    expect(first!.queueWaitMs).toBe(200);

    queue.fail(first!, { code: 'x', message: 'x', retryable: true }, 100);
    const promise = queue.next();
    await clock.advance(400);
    const second = await promise;
    // 200ms from the first wait, plus whatever it sat delayed for the retry.
    expect(second!.queueWaitMs).toBeGreaterThanOrEqual(200);
    expect(second!.attempts).toBe(1);
  });

  it('returns null to consumers once closed and drained', async () => {
    const { queue } = build();
    await queue.enqueue('a');
    queue.close();

    const job = await queue.next();
    queue.succeed(job!);
    expect(await queue.next()).toBeNull();
    expect(queue.isDrained).toBe(true);
  });
});

describe('runWorkerPool', () => {
  it('processes every job and stops when the queue closes', async () => {
    const { clock, queue } = build({ maxDepth: 100 });
    for (const value of ['a', 'b', 'c', 'd', 'e']) await queue.enqueue(value);
    queue.close();

    const handled: string[] = [];
    await runWorkerPool<string>({
      queue,
      concurrency: 3,
      clock,
      handle: async (job) => {
        handled.push(job.payload);
      },
      retryDelay: () => 0,
    });

    expect(handled.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(queue.dead).toHaveLength(0);
  });

  it('retries a failing job up to the attempt limit, then dead-letters it', async () => {
    const { clock, queue } = build({ maxDepth: 10, maxAttempts: 3 });
    await queue.enqueue('always-fails');
    queue.close();

    const outcomes: string[] = [];
    let calls = 0;

    await runWorkerPool<string>({
      queue,
      concurrency: 1,
      clock,
      handle: async () => {
        calls++;
        throw Object.assign(new Error('503'), { code: 'crm_error', retryable: true });
      },
      retryDelay: () => 0,
      onSettled: (_job, outcome) => outcomes.push(outcome),
    });

    expect(calls).toBe(3);
    expect(outcomes).toEqual(['retrying', 'retrying', 'dead']);
    expect(queue.dead).toHaveLength(1);
  });

  it('does not exceed the configured concurrency', async () => {
    const { clock, queue } = build({ maxDepth: 100 });
    for (let i = 0; i < 20; i++) await queue.enqueue(`job-${i}`);
    queue.close();

    let active = 0;
    let peak = 0;

    await runWorkerPool<string>({
      queue,
      concurrency: 4,
      clock,
      handle: async () => {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
      },
      retryDelay: () => 0,
    });

    expect(peak).toBeLessThanOrEqual(4);
  });

  it('reports each settlement exactly once', async () => {
    const { clock, queue } = build({ maxDepth: 10 });
    await queue.enqueue('ok');
    await queue.enqueue('fatal');
    queue.close();

    const onSettled = vi.fn();
    await runWorkerPool<string>({
      queue,
      concurrency: 2,
      clock,
      handle: async (job) => {
        if (job.payload === 'fatal') {
          throw Object.assign(new Error('bad payload'), { code: 'validation_error', retryable: false });
        }
      },
      retryDelay: () => 0,
      onSettled,
    });

    expect(onSettled).toHaveBeenCalledTimes(2);
    expect(onSettled.mock.calls.map((c) => c[1]).sort()).toEqual(['dead', 'succeeded']);
  });
});
