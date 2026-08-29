import { CostTracker } from '../cost/tracker.js';
import type { RoutingRules } from '../domain/routing.js';
import { VirtualClock, type Clock } from '../lib/clock.js';
import { InMemoryDeadLetter, type DeadLetterEntry } from '../lib/deadletter.js';
import { createRng, type Rng } from '../lib/random.js';
import type { Logger } from '../logger.js';
import { M, MetricsRegistry } from '../metrics/registry.js';
import { ValidationError } from '../pipeline/errors.js';
import { processLead, type ProcessDeps } from '../pipeline/process-lead.js';
import type { Job } from '../queue/job.js';
import { JobQueue } from '../queue/queue.js';
import { runWorkerPool } from '../queue/worker.js';
import { DEFAULT_LIMITS, LimiterRegistry, type LimiterConfig } from '../ratelimit/limiter.js';
import { resolveProfile, type FailureProfile } from './failure-profile.js';
import { createLeadGenerator, type LeadKind } from './generator.js';
import { SimulatedCrm, SimulatedLlm, SimulatedNotifier, type SimDeps } from './providers.js';
import { currentRng, withLeadRng } from './rng-context.js';

export interface SimulationOptions {
  leads: number;
  concurrency: number;
  seed: number;
  timeScale: number;
  profileName: string;
  model: string;
  rateLimitEnabled: boolean;
  limits: LimiterConfig;
  maxQueueDepth: number;
  maxAttempts: number;
  rules: RoutingRules;
  llmTimeoutMs: number;
  llmMaxRetries: number;
  logger: Logger;
  /** Called roughly every `sampleIntervalMs` of virtual time, for the dashboard. */
  onProgress?: (progress: SimulationProgress) => void;
  sampleIntervalMs?: number;
}

export interface SimulationProgress {
  enqueued: number;
  completed: number;
  failed: number;
  rejected: number;
  dead: number;
  retries: number;
  inFlight: number;
  queueDepth: number;
  elapsedMs: number;
  throughput: number;
  costUsd: number;
  classifications: Record<string, number>;
}

export interface SimulationResult {
  options: Omit<SimulationOptions, 'logger' | 'onProgress'>;
  profile: FailureProfile;
  startedAt: string;
  durationVirtualMs: number;
  durationRealMs: number;
  totals: {
    generated: number;
    completed: number;
    rejected: number;
    dead: number;
    retries: number;
    contacts: number;
    deals: number;
    notifications: number;
    degraded: number;
  };
  classifications: Record<string, number>;
  leadKinds: Record<string, number>;
  metrics: ReturnType<MetricsRegistry['snapshot']>;
  cost: ReturnType<CostTracker['breakdown']>;
  deadLetters: DeadLetterEntry[];
  deadJobs: Array<{ id: string; attempts: number; error: string; code: string }>;
  rateLimit: {
    enabled: boolean;
    limits: LimiterConfig;
    waits: { llm: number; crm: number; notifier: number };
  };
}

interface QueuePayload {
  kind: LeadKind;
  payload: unknown;
  /** Position in the generated sequence — seeds this lead's random stream. */
  index: number;
}

/**
 * Drives the whole simulation: generate → enqueue (with backpressure) → worker
 * pool → the real pipeline against simulated providers → metrics.
 *
 * The pipeline itself is untouched. Everything here is the harness around it,
 * which is the only way the numbers mean anything.
 */
export async function runSimulation(options: SimulationOptions): Promise<SimulationResult> {
  const startedAtReal = Date.now();
  const clock: Clock = new VirtualClock(options.timeScale);
  const rng: Rng = createRng(options.seed);
  const profile = resolveProfile(options.profileName);
  // Its own stream: reservoir sampling must not consume from the lead streams.
  const metrics = new MetricsRegistry(createRng(options.seed ^ 0x5eed).next);
  const cost = new CostTracker(options.model);
  const limiters = new LimiterRegistry(options.limits, clock, options.rateLimitEnabled);

  const simDeps: SimDeps = { clock, rng, metrics, limiters, profile, cost };
  const llm = new SimulatedLlm(simDeps);
  const crm = new SimulatedCrm(simDeps);
  const notifier = new SimulatedNotifier(simDeps);
  const deadLetter = new InMemoryDeadLetter();

  const pipelineDeps: ProcessDeps = {
    llm,
    crm,
    notifier,
    deadLetter,
    rules: options.rules,
    logger: options.logger,
    llmTimeoutMs: options.llmTimeoutMs,
    llmMaxRetries: options.llmMaxRetries,
    crmMaxRetries: 2,
    // Route the pipeline's internal retry backoff through the virtual clock so
    // it is compressed along with everything else.
    retryOverrides: { sleep: (ms) => clock.sleep(ms), random: () => currentRng(rng).next() },
  };

  const queue = new JobQueue<QueuePayload>({
    clock,
    maxDepth: options.maxQueueDepth,
    maxAttempts: options.maxAttempts,
  });

  const classifications: Record<string, number> = { HOT: 0, WARM: 0, COLD: 0 };
  const leadKinds: Record<string, number> = {};
  let completed = 0;
  let rejected = 0;
  let degraded = 0;
  let retries = 0;

  const progress = (): SimulationProgress => ({
    enqueued: metrics.counter(M.leadsEnqueued),
    completed,
    failed: queue.dead.length,
    rejected,
    dead: queue.dead.length,
    retries,
    inFlight: queue.running,
    queueDepth: queue.depth,
    elapsedMs: clock.now(),
    throughput: clock.now() > 0 ? (completed / clock.now()) * 1000 : 0,
    costUsd: cost.totalCostUsd,
    classifications: { ...classifications },
  });

  // Sampler: snapshots the system on an interval so the report can show the
  // shape of the run, not just its totals.
  let sampling = true;
  let lastSampleAt = 0;
  let lastCompleted = 0;
  const sampleIntervalMs = options.sampleIntervalMs ?? 500;
  const sampler = (async () => {
    while (sampling) {
      await clock.sleep(sampleIntervalMs);
      const now = clock.now();
      const windowMs = now - lastSampleAt || 1;
      metrics.recordSample({
        t: Math.round(now),
        completed,
        failed: queue.dead.length,
        inFlight: queue.running,
        queueDepth: queue.depth,
        throughput: ((completed - lastCompleted) / windowMs) * 1000,
      });
      lastSampleAt = now;
      lastCompleted = completed;
      options.onProgress?.(progress());
    }
  })();

  const workers = runWorkerPool<QueuePayload>({
    queue,
    concurrency: options.concurrency,
    clock,
    retryDelay: (attempt) => Math.min(30_000, 500 * 2 ** (attempt - 1)) * (0.5 + currentRng(rng).next() / 2),
    handle: async (job) => {
      const startedAt = clock.now();
      try {
        const result = await withLeadRng(options.seed, job.payload.index, job.attempts, () =>
          processLead(job.payload.payload, job.id, pipelineDeps),
        );
        completed++;
        classifications[result.qualification.classification] =
          (classifications[result.qualification.classification] ?? 0) + 1;
        if (result.qualification.explanation.degraded) degraded++;
        metrics.increment(M.leadsCompleted);
        metrics.increment(`${M.classificationPrefix}${result.qualification.classification}`);
        if (result.qualification.explanation.degraded) metrics.increment(M.llmDegraded);
        metrics.observe(M.latencyProcessing, clock.now() - startedAt);
        metrics.observe(M.latencyTotal, clock.now() - job.enqueuedAt);
        metrics.observe(M.latencyQueueWait, job.queueWaitMs);
      } catch (error) {
        if (error instanceof ValidationError) {
          // A malformed lead is a permanent outcome, not a job failure. Retrying
          // it would burn the whole attempt budget on a payload that cannot
          // become valid.
          rejected++;
          metrics.increment(M.leadsRejected);
          metrics.increment(`${M.errorPrefix}validation`);
          metrics.observe(M.latencyProcessing, clock.now() - startedAt);
          metrics.observe(M.latencyTotal, clock.now() - job.enqueuedAt);
          return;
        }
        throw error;
      }
    },
    onSettled: (_job, outcome) => {
      if (outcome === 'retrying') {
        retries++;
        metrics.increment(M.jobRetries);
      } else if (outcome === 'dead') {
        metrics.increment(M.leadsDead);
      }
    },
  });

  // Producer. `enqueue` blocks when the queue is full, so intake is naturally
  // paced by how fast the workers drain it.
  const generate = createLeadGenerator(rng);
  const producer = (async () => {
    for (let i = 0; i < options.leads; i++) {
      const lead = generate();
      leadKinds[lead.kind] = (leadKinds[lead.kind] ?? 0) + 1;
      await queue.enqueue({ kind: lead.kind, payload: lead.payload, index: i });
      metrics.increment(M.leadsEnqueued);
    }
    queue.close();
  })();

  await producer;
  await workers;
  sampling = false;
  await sampler;

  const durationVirtualMs = clock.now();

  return {
    options: {
      leads: options.leads,
      concurrency: options.concurrency,
      seed: options.seed,
      timeScale: options.timeScale,
      profileName: options.profileName,
      model: options.model,
      rateLimitEnabled: options.rateLimitEnabled,
      limits: options.limits,
      maxQueueDepth: options.maxQueueDepth,
      maxAttempts: options.maxAttempts,
      rules: options.rules,
      llmTimeoutMs: options.llmTimeoutMs,
      llmMaxRetries: options.llmMaxRetries,
      sampleIntervalMs,
    },
    profile,
    startedAt: new Date(startedAtReal).toISOString(),
    durationVirtualMs,
    durationRealMs: Date.now() - startedAtReal,
    totals: {
      generated: options.leads,
      completed,
      rejected,
      dead: queue.dead.length,
      retries,
      contacts: crm.contactCount,
      deals: crm.dealCount,
      notifications: notifier.sent,
      degraded,
    },
    classifications,
    leadKinds,
    metrics: metrics.snapshot(),
    cost: cost.breakdown(completed),
    deadLetters: deadLetter.entries,
    deadJobs: queue.dead.map((job: Job<QueuePayload>) => ({
      id: job.id,
      attempts: job.attempts,
      error: job.lastError?.message ?? 'unknown',
      code: job.lastError?.code ?? 'unknown',
    })),
    rateLimit: {
      enabled: options.rateLimitEnabled,
      limits: options.limits,
      waits: {
        llm: Math.round(limiters.llm.stats.totalWaitMs),
        crm: Math.round(limiters.crm.stats.totalWaitMs),
        notifier: Math.round(limiters.notifier.stats.totalWaitMs),
      },
    },
  };
}

export { DEFAULT_LIMITS };
