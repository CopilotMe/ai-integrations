import { FakeCrm } from '../adapters/fake/fake-crm.js';
import { FakeLlm } from '../adapters/fake/fake-llm.js';
import { estimateTokens, type CostTracker } from '../cost/tracker.js';
import type { Lead } from '../domain/lead.js';
import type { LlmAssessment, Qualification } from '../domain/qualification.js';
import type { Clock } from '../lib/clock.js';
import type { Rng } from '../lib/random.js';
import { M, type MetricsRegistry } from '../metrics/registry.js';
import {
  CrmError,
  LlmContractError,
  LlmRateLimitError,
  LlmTimeoutError,
  NotifierError,
} from '../pipeline/errors.js';
import type { CreateDealInput, CrmContact, CrmDeal, CrmPort } from '../ports/crm.js';
import type { LlmPort } from '../ports/llm.js';
import type { NotificationInput, NotifierPort } from '../ports/notifier.js';
import type { LimiterRegistry } from '../ratelimit/limiter.js';
import type { FailureProfile, ProviderProfile } from './failure-profile.js';
import { currentRng } from './rng-context.js';

export interface SimDeps {
  clock: Clock;
  rng: Rng;
  metrics: MetricsRegistry;
  limiters: LimiterRegistry;
  profile: FailureProfile;
  cost: CostTracker;
}

/**
 * Simulated providers.
 *
 * These wrap the offline fakes with the parts of a real dependency that a fake
 * leaves out: latency with a realistic tail, rate limits that actually reject,
 * transient errors, and token usage to bill. The pipeline under test is
 * unmodified — it cannot tell these apart from the real adapters, which is what
 * makes the measurements meaningful.
 */
export class SimulatedLlm implements LlmPort {
  /** The current lead's stream — see `rng-context.ts`. */
  private get rng() {
    return currentRng(this.deps.rng);
  }

  readonly name = 'simulated-openai';
  private readonly inner = new FakeLlm();

  constructor(private readonly deps: SimDeps) {}

  async assess(lead: Lead, signal?: AbortSignal): Promise<LlmAssessment> {
    const promptTokens = estimateTokens(lead.message) + 420; // + system prompt
    await this.callProvider('llm', this.deps.profile.llm, M.latencyLlm, signal, () => {
      if (this.rng.chance(this.deps.profile.llm.malformedRate)) {
        this.deps.cost.record({ promptTokens, completionTokens: 40 }); // billed anyway
        this.deps.metrics.increment(`${M.errorPrefix}llm.malformed`);
        throw new LlmContractError('Model output failed schema validation: score must be <= 100');
      }
    });

    const completionTokens = this.rng.int(90, 170);
    this.deps.cost.record({ promptTokens, completionTokens });
    this.deps.metrics.increment(M.llmCalls);
    return this.inner.assess(lead);
  }

  async draftReply(lead: Lead, qualification: Qualification, signal?: AbortSignal): Promise<string> {
    const promptTokens = estimateTokens(lead.message) + 180;
    await this.callProvider('llm', this.deps.profile.llm, M.latencyLlm, signal);
    this.deps.cost.record({ promptTokens, completionTokens: this.rng.int(80, 140) });
    this.deps.metrics.increment(M.llmCalls);
    return this.inner.draftReply(lead, qualification);
  }

  /** Rate limit → latency → injected failure → caller's extra check. */
  private async callProvider(
    key: 'llm',
    profile: ProviderProfile,
    latencyMetric: string,
    signal: AbortSignal | undefined,
    extra?: () => void,
  ): Promise<void> {
    const waited = await this.deps.limiters.acquire(key);
    if (waited > 0) this.deps.metrics.observe(M.rateLimitWaitLlm, waited);

    if (this.rng.chance(profile.rateLimitRate)) {
      // A 429 is not billed, but it does cost a round trip.
      this.deps.cost.recordUnbilled();
      this.deps.metrics.increment(`${M.errorPrefix}llm.rate_limited`);
      await this.deps.clock.sleep(this.rng.int(20, 80));
      throw new LlmRateLimitError('429 Too Many Requests', this.rng.int(200, 1200));
    }

    const latency = profile.medianLatencyMs === 0 ? 0 : this.rng.logNormal(profile.medianLatencyMs, profile.latencySigma);

    if (this.rng.chance(profile.timeoutRate)) {
      // Let the pipeline's own AbortController fire rather than short-circuiting.
      this.deps.metrics.increment(`${M.errorPrefix}llm.timeout`);
      await this.waitOrAbort(latency * 8, signal);
      throw new LlmTimeoutError(0);
    }

    await this.waitOrAbort(latency, signal);
    this.deps.metrics.observe(latencyMetric, latency);

    if (this.rng.chance(profile.serverErrorRate)) {
      this.deps.cost.recordUnbilled();
      this.deps.metrics.increment(`${M.errorPrefix}llm.server_error`);
      throw new LlmContractError('OpenAI returned 503');
    }

    extra?.();
  }

  private async waitOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) return this.deps.clock.sleep(ms);
    await Promise.race([
      this.deps.clock.sleep(ms),
      new Promise<never>((_resolve, reject) => {
        if (signal.aborted) return reject(new LlmTimeoutError(0));
        signal.addEventListener('abort', () => reject(new LlmTimeoutError(0)), { once: true });
      }),
    ]);
  }
}

export class SimulatedCrm implements CrmPort {
  /** The current lead's stream — see `rng-context.ts`. */
  private get rng() {
    return currentRng(this.deps.rng);
  }

  readonly name = 'simulated-hubspot';
  private readonly inner = new FakeCrm();

  constructor(private readonly deps: SimDeps) {}

  async upsertContact(lead: Lead, qualification: Qualification): Promise<CrmContact> {
    await this.call();
    // A conflict costs an extra search + patch round trip in the real adapter.
    if (this.rng.chance(this.deps.profile.crm.conflictRate)) {
      await this.deps.clock.sleep(this.rng.logNormal(this.deps.profile.crm.medianLatencyMs, 0.3));
      this.deps.metrics.increment('crm.conflict_resolved');
    }
    return this.inner.upsertContact(lead, qualification);
  }

  async createDeal(input: CreateDealInput): Promise<CrmDeal> {
    await this.call();
    return this.inner.createDeal(input);
  }

  get contactCount(): number {
    return this.inner.contactCount;
  }

  get dealCount(): number {
    return this.inner.dealCount;
  }

  private async call(): Promise<void> {
    const profile = this.deps.profile.crm;
    const waited = await this.deps.limiters.acquire('crm');
    if (waited > 0) this.deps.metrics.observe(M.rateLimitWaitCrm, waited);

    if (this.rng.chance(profile.rateLimitRate)) {
      this.deps.metrics.increment(`${M.errorPrefix}crm.rate_limited`);
      throw Object.assign(new CrmError('HubSpot returned 429', true), { retryAfterMs: this.rng.int(300, 2000) });
    }

    const latency = this.rng.logNormal(profile.medianLatencyMs, profile.latencySigma);
    if (this.rng.chance(profile.timeoutRate)) {
      this.deps.metrics.increment(`${M.errorPrefix}crm.timeout`);
      await this.deps.clock.sleep(latency * 6);
      throw new CrmError('HubSpot request timed out', true);
    }

    await this.deps.clock.sleep(latency);
    this.deps.metrics.observe(M.latencyCrm, latency);
    this.deps.metrics.increment(M.crmCalls);

    if (this.rng.chance(profile.serverErrorRate)) {
      this.deps.metrics.increment(`${M.errorPrefix}crm.server_error`);
      throw new CrmError('HubSpot failed to create contact: 503', true);
    }
  }
}

export class SimulatedNotifier implements NotifierPort {
  /** The current lead's stream — see `rng-context.ts`. */
  private get rng() {
    return currentRng(this.deps.rng);
  }

  readonly name = 'simulated-slack';
  private sentCount = 0;

  constructor(private readonly deps: SimDeps) {}

  get sent(): number {
    return this.sentCount;
  }

  async notify(_input: NotificationInput): Promise<void> {
    const profile = this.deps.profile.notifier;
    await this.deps.limiters.acquire('notifier');

    if (this.rng.chance(profile.rateLimitRate)) {
      this.deps.metrics.increment(`${M.errorPrefix}notifier.rate_limited`);
      throw new NotifierError('Slack webhook returned 429');
    }

    const latency = this.rng.logNormal(profile.medianLatencyMs, profile.latencySigma);
    await this.deps.clock.sleep(latency);
    this.deps.metrics.observe(M.latencyNotifier, latency);
    this.deps.metrics.increment(M.notifierCalls);

    if (this.rng.chance(profile.serverErrorRate)) {
      this.deps.metrics.increment(`${M.errorPrefix}notifier.server_error`);
      throw new NotifierError('Slack webhook returned 500');
    }

    this.sentCount++;
  }
}
