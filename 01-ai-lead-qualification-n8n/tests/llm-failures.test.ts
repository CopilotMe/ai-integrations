import { describe, expect, it, vi } from 'vitest';
import { FakeLlm } from '../src/adapters/fake/fake-llm.js';
import { translateOpenAiError } from '../src/adapters/openai-llm.js';
import type { Lead } from '../src/domain/lead.js';
import type { LlmAssessment, Qualification } from '../src/domain/qualification.js';
import {
  LlmContractError,
  LlmRateLimitError,
  LlmTimeoutError,
} from '../src/pipeline/errors.js';
import { qualifyLead, type QualifyDeps } from '../src/pipeline/qualify-lead.js';
import type { LlmPort } from '../src/ports/llm.js';
import { assessment, hotLead, instantRetries, silentLogger, testRules } from './fixtures/leads.js';

function deps(llm: LlmPort, overrides: Partial<QualifyDeps> = {}): QualifyDeps {
  return {
    llm,
    rules: testRules,
    logger: silentLogger,
    llmTimeoutMs: 50,
    llmMaxRetries: 2,
    retryOverrides: instantRetries,
    ...overrides,
  };
}

class StubLlm implements LlmPort {
  readonly name = 'stub';
  calls = 0;
  constructor(private readonly behaviour: (call: number) => Promise<LlmAssessment>) {}
  assess(_lead: Lead): Promise<LlmAssessment> {
    return this.behaviour(++this.calls);
  }
  async draftReply(_lead: Lead, _q: Qualification): Promise<string> {
    return 'draft';
  }
}

describe('LLM failure handling', () => {
  it('retries a rate-limit error and succeeds on a later attempt', async () => {
    const llm = new StubLlm(async (call) => {
      if (call === 1) throw new LlmRateLimitError('429 from provider');
      return assessment({ score: 80 });
    });

    const result = await qualifyLead(hotLead, deps(llm));
    expect(llm.calls).toBe(2);
    expect(result.qualification.classification).toBe('HOT');
    expect(result.qualification.explanation.degraded).toBe(false);
  });

  it('honours a provider-supplied retry-after over its own backoff', async () => {
    const sleep = vi.fn(async () => {});
    const llm = new StubLlm(async (call) => {
      if (call === 1) throw new LlmRateLimitError('429', 1234);
      return assessment();
    });

    await qualifyLead(hotLead, deps(llm, { retryOverrides: { sleep, random: () => 1 } }));
    expect(sleep).toHaveBeenCalledWith(1234);
  });

  it('falls back to heuristic scoring when the model keeps timing out', async () => {
    const llm = new StubLlm(async () => {
      throw new LlmTimeoutError(50);
    });

    const result = await qualifyLead(hotLead, deps(llm));
    expect(llm.calls).toBe(3); // initial attempt + 2 retries
    expect(result.qualification.explanation.degraded).toBe(true);
    expect(result.qualification.reason).toMatch(/manual review/i);
    expect(result.qualification.score).toBeGreaterThan(0);
  });

  it('aborts a hanging call once the timeout elapses', async () => {
    let observed: AbortSignal | undefined;
    const llm: LlmPort = {
      name: 'hanging',
      assess: (_lead, signal) =>
        new Promise((_resolve, reject) => {
          observed = signal;
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      draftReply: async () => 'draft',
    };

    const result = await qualifyLead(hotLead, deps(llm, { llmTimeoutMs: 20, llmMaxRetries: 0 }));
    expect(observed?.aborted).toBe(true);
    expect(result.qualification.explanation.degraded).toBe(true);
  });

  it('falls back when the model returns output that fails schema validation', async () => {
    const llm = new StubLlm(async () => {
      throw new LlmContractError('score must be <= 100');
    });

    const result = await qualifyLead(hotLead, deps(llm));
    expect(result.qualification.explanation.degraded).toBe(true);
    // Degraded leads get no AI-written reply — a human writes it instead.
    expect(result.suggestedReply).toBeNull();
  });

  it('does not retry an error the provider marked as permanent', async () => {
    const llm = new StubLlm(async () => {
      throw Object.assign(new Error('401 invalid api key'), { retryable: false });
    });

    const result = await qualifyLead(hotLead, deps(llm));
    expect(llm.calls).toBe(1);
    expect(result.qualification.explanation.degraded).toBe(true);
  });

  it('still returns a decision when reply drafting fails', async () => {
    const llm: LlmPort = {
      name: 'reply-fails',
      assess: async () => assessment({ score: 80 }),
      draftReply: async () => {
        throw new Error('reply model unavailable');
      },
    };

    const result = await qualifyLead(hotLead, deps(llm));
    expect(result.qualification.classification).toBe('HOT');
    expect(result.suggestedReply).toBeNull();
  });

  it('skips reply drafting for COLD leads', async () => {
    const draftReply = vi.fn(async () => 'should not be called');
    const llm: LlmPort = {
      name: 'cold',
      assess: async () => assessment({ score: 10, suggested_classification: 'COLD' }),
      draftReply,
    };

    const result = await qualifyLead({ name: 'A', email: 'a@gmail.com', message: 'hi' }, deps(llm));
    expect(result.qualification.classification).toBe('COLD');
    expect(result.suggestedReply).toBeNull();
    expect(draftReply).not.toHaveBeenCalled();
  });

  it('maps provider errors onto our error vocabulary', () => {
    expect(translateOpenAiError({ status: 429, headers: { 'retry-after-ms': '2000' } }))
      .toMatchObject({ code: 'llm_rate_limited', retryAfterMs: 2000, retryable: true });
    expect(translateOpenAiError({ status: 429, headers: { 'retry-after': '3' } }))
      .toMatchObject({ retryAfterMs: 3000 });
    expect(translateOpenAiError({ status: 503 })).toBeInstanceOf(LlmContractError);
    expect(translateOpenAiError(Object.assign(new Error('x'), { name: 'AbortError' })))
      .toBeInstanceOf(LlmTimeoutError);
    // A 400 is our bug, not a transient fault — it must not be retried.
    expect((translateOpenAiError({ status: 400 }) as { retryable?: boolean }).retryable).toBeUndefined();
  });

  it('produces a schema-valid assessment from the offline fake provider', async () => {
    const result = await qualifyLead(hotLead, deps(new FakeLlm()));
    expect(result.qualification.explanation.degraded).toBe(false);
    expect(result.qualification.score).toBeGreaterThanOrEqual(0);
    expect(result.qualification.score).toBeLessThanOrEqual(100);
    expect(result.suggestedReply).toContain('John');
  });
});
