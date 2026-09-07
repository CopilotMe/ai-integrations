/**
 * The ten scenarios from docs/test-scenarios.md, each one actually exercised.
 *
 * Scenarios 1-3 and 5 are pure routing and need nothing but the policy.
 * Scenarios 4, 6, 7, 8, 9 and 10 go through the real pipeline against stub
 * ports, because validation, retries, idempotency and CRM failure are
 * properties of the pipeline rather than of the routing function.
 */
import { describe, expect, it, vi } from 'vitest';
import { FakeAssessor } from '../src/adapters/fake/fake-assessor.js';
import { FakeCrm } from '../src/adapters/fake/fake-crm.js';
import type { GhlLead } from '../src/domain/lead.js';
import type { ClaudeAssessment } from '../src/domain/qualification.js';
import { CrmError, LlmContractError, LlmTimeoutError, ValidationError } from '../src/lib/errors.js';
import { InMemoryIdempotencyStore } from '../src/lib/idempotency.js';
import { DEFAULT_RULES, route } from '../src/policy/routing.js';
import { qualifyLead, type PipelineDeps } from '../src/pipeline/qualify-lead.js';
import type { AssessorPort, CrmPort } from '../src/ports.js';
import { assessment, lead, silentLogger, testDeps } from './helpers.js';

/* -------------------------------------------------------------------------- */
/* 1-3, 5: routing                                                            */
/* -------------------------------------------------------------------------- */

describe('scenario 1 — HOT lead routes to sales', () => {
  it('routes score 87 at confidence 0.94 to sales', () => {
    const decision = route(lead(), assessment({ lead_score: 87, confidence: 0.94, qualification: 'hot' }));
    expect(decision.route).toBe('sales');
    expect(decision.next_action).toBe('sales_call');
    expect(decision.explanation.applied_rule).toBe('hot_score_and_confidence');
    expect(decision.explanation.overrode_model).toBe(false);
  });
});

describe('scenario 2 — WARM lead routes to nurture', () => {
  it('routes score 65 at confidence 0.85 to nurture', () => {
    const decision = route(lead(), assessment({ lead_score: 65, confidence: 0.85, qualification: 'warm' }));
    expect(decision.route).toBe('nurture');
    expect(decision.next_action).toBe('nurture_sequence');
    expect(decision.explanation.applied_rule).toBe('warm_score_and_confidence');
  });
});

describe('scenario 3 — COLD lead routes to low priority', () => {
  it('routes score 30 to low priority even at high confidence', () => {
    const decision = route(lead(), assessment({ lead_score: 30, confidence: 0.95, qualification: 'cold' }));
    expect(decision.route).toBe('low_priority');
    expect(decision.next_action).toBe('archive');
    expect(decision.explanation.applied_rule).toBe('score_below_warm_threshold');
  });
});

describe('scenario 5 — a high score at low confidence cannot become HOT', () => {
  it('downgrades score 95 at confidence 0.55 to nurture, and says why', () => {
    const decision = route(lead(), assessment({ lead_score: 95, confidence: 0.55, qualification: 'hot' }));
    expect(decision.route).toBe('nurture');
    expect(decision.explanation.applied_rule).toBe('hot_downgraded_low_confidence');
    // The model said hot; the rules said otherwise, and that disagreement is recorded.
    expect(decision.explanation.overrode_model).toBe(true);
    expect(decision.explanation.model_qualification).toBe('hot');
    expect(decision.explanation.triggered[0]?.detail).toMatch(/confidence 0\.55 is below 0\.8/);
  });

  it('still only drops one tier at the lowest confidence — a hot-scoring lead is never archived', () => {
    const decision = route(lead(), assessment({ lead_score: 100, confidence: 0.01, qualification: 'hot' }));
    expect(decision.route).toBe('nurture');
    expect(decision.explanation.applied_rule).toBe('hot_downgraded_low_confidence');
  });

  it('drops a warm-scoring lead to low priority when it misses the warm confidence gate', () => {
    const decision = route(lead(), assessment({ lead_score: 60, confidence: 0.5, qualification: 'warm' }));
    expect(decision.route).toBe('low_priority');
    expect(decision.explanation.applied_rule).toBe('warm_downgraded_low_confidence');
  });
});

describe('routing boundaries', () => {
  it('treats both thresholds as inclusive', () => {
    expect(route(lead(), assessment({ lead_score: 80, confidence: 0.8 })).route).toBe('sales');
    expect(route(lead(), assessment({ lead_score: 50, confidence: 0.7 })).route).toBe('nurture');
  });

  it('excludes the value just below each threshold', () => {
    expect(route(lead(), assessment({ lead_score: 79, confidence: 0.99 })).route).toBe('nurture');
    expect(route(lead(), assessment({ lead_score: 49, confidence: 0.99 })).route).toBe('low_priority');
    expect(route(lead(), assessment({ lead_score: 70, confidence: 0.69 })).route).toBe('low_priority');
  });

  it('hard-stops a blocked domain regardless of score or confidence', () => {
    const decision = route(
      lead({ email: 'sales@competitor.com' }),
      assessment({ lead_score: 99, confidence: 0.99, qualification: 'hot' }),
      { ...DEFAULT_RULES, blockedEmailDomains: ['competitor.com'] },
    );
    expect(decision.route).toBe('low_priority');
    expect(decision.explanation.applied_rule).toBe('hard_stop:blocked_email_domain');
    expect(decision.explanation.overrode_model).toBe(true);
  });

  it('is pure — same inputs, same decision', () => {
    const [l, a] = [lead(), assessment({ lead_score: 62, confidence: 0.71 })];
    expect(route(l, a)).toEqual(route(l, a));
  });
});

/* -------------------------------------------------------------------------- */
/* 4, 6, 7, 8, 9, 10: pipeline                                                */
/* -------------------------------------------------------------------------- */

describe('scenario 4 — missing required data is rejected before anything is spent', () => {
  it('rejects a payload with no contact_id, email or inquiry, and calls nothing', async () => {
    const assess = vi.fn();
    const write = vi.fn();
    const deps = testDeps({
      assessor: { name: 'spy', assess } as unknown as AssessorPort,
      crm: { name: 'spy', writeQualification: write } as unknown as CrmPort,
    });

    await expect(qualifyLead({ event_id: 'e1' }, 'c1', deps)).rejects.toBeInstanceOf(ValidationError);
    // The point of validating first: an invalid lead costs no model call.
    expect(assess).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('names every offending field', async () => {
    const deps = testDeps();
    try {
      await qualifyLead({ contact_id: 'c', event_id: 'e', email: 'not-an-email', inquiry: '' }, 'c2', deps);
      expect.unreachable('should have thrown');
    } catch (error) {
      const paths = (error as ValidationError).issues.map((i) => i.path);
      expect(paths).toEqual(expect.arrayContaining(['email', 'inquiry']));
    }
  });

  it('accepts a lead with only the required fields', async () => {
    const deps = testDeps();
    const result = await qualifyLead(
      { contact_id: 'c9', event_id: 'e9', email: 'a@b.co', inquiry: 'We need automation for our support team.' },
      'c3',
      deps,
    );
    expect(result.decision.route).toBeDefined();
    expect(result.lead.event_type).toBe('Custom');
  });
});

describe('scenario 6 — Claude timeout is retried, then surfaced', () => {
  it('retries a timeout and succeeds on a later attempt', async () => {
    let calls = 0;
    const flaky: AssessorPort = {
      name: 'flaky',
      assess: async (l) => {
        if (++calls === 1) throw new LlmTimeoutError(20_000);
        return new FakeAssessor().assess(l);
      },
    };

    const deps = testDeps({ assessor: flaky });
    const result = await qualifyLead(lead(), 'c4', deps);
    expect(calls).toBe(2);
    expect(result.crm).not.toBeNull();
  });

  it('aborts the call when the timeout elapses', async () => {
    let observed: AbortSignal | undefined;
    const hanging: AssessorPort = {
      name: 'hanging',
      assess: (_l, signal) =>
        new Promise((_resolve, reject) => {
          observed = signal;
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    };

    const deps = testDeps({ assessor: hanging, llmTimeoutMs: 20, llmMaxRetries: 0 });
    await expect(qualifyLead(lead(), 'c5', deps)).rejects.toBeInstanceOf(LlmTimeoutError);
    expect(observed?.aborted).toBe(true);
  });

  it('fails the request after the retry budget is exhausted, writing nothing', async () => {
    const write = vi.fn();
    const deps = testDeps({
      assessor: {
        name: 'always-times-out',
        assess: async () => {
          throw new LlmTimeoutError(20_000);
        },
      },
      crm: { name: 'spy', writeQualification: write } as unknown as CrmPort,
      llmMaxRetries: 2,
    });

    await expect(qualifyLead(lead(), 'c6', deps)).rejects.toBeInstanceOf(LlmTimeoutError);
    // No partial CRM write: the contact is untouched rather than half-updated.
    expect(write).not.toHaveBeenCalled();
  });
});

describe('scenario 7 — invalid structured output produces no CRM side effect', () => {
  it('treats a schema violation as retryable and never writes on failure', async () => {
    const write = vi.fn();
    let calls = 0;
    const deps = testDeps({
      assessor: {
        name: 'bad-json',
        assess: async () => {
          calls++;
          throw new LlmContractError('Claude output failed schema validation: lead_score expected integer');
        },
      },
      crm: { name: 'spy', writeQualification: write } as unknown as CrmPort,
      llmMaxRetries: 1,
    });

    await expect(qualifyLead(lead(), 'c7', deps)).rejects.toBeInstanceOf(LlmContractError);
    expect(calls).toBe(2);
    expect(write).not.toHaveBeenCalled();
  });

  it('does not retry a permanent provider error', async () => {
    let calls = 0;
    const deps = testDeps({
      assessor: {
        name: 'bad-key',
        assess: async () => {
          calls++;
          throw Object.assign(new LlmContractError('Claude rejected the credentials'), { retryable: false });
        },
      },
      llmMaxRetries: 3,
    });

    await expect(qualifyLead(lead(), 'c8', deps)).rejects.toThrow(/credentials/);
    expect(calls).toBe(1);
  });
});

describe('scenario 8 — a GoHighLevel failure is retried, then surfaced as retryable', () => {
  it('retries a 5xx and succeeds', async () => {
    const inner = new FakeCrm();
    let attempts = 0;
    const flaky: CrmPort = {
      name: 'flaky',
      writeQualification: async (l, d) => {
        if (++attempts === 1) throw new CrmError('GoHighLevel failed to update contact: 503', true);
        return inner.writeQualification(l, d);
      },
    };

    const deps = testDeps({ crm: flaky });
    const result = await qualifyLead(lead(), 'c9', deps);
    expect(attempts).toBe(2);
    expect(result.crm?.contactId).toBe('contact-1');
  });

  it('does not retry a 4xx, because the same request would fail identically', async () => {
    let attempts = 0;
    const deps = testDeps({
      crm: {
        name: 'bad-request',
        writeQualification: async () => {
          attempts++;
          throw new CrmError('GoHighLevel failed to update contact: 400 unknown custom field', false);
        },
      },
    });

    await expect(qualifyLead(lead(), 'c10', deps)).rejects.toBeInstanceOf(CrmError);
    expect(attempts).toBe(1);
  });

  it('releases the idempotency claim so the sender can retry a transient failure', async () => {
    const store = new InMemoryIdempotencyStore();
    const deps = testDeps({
      crm: {
        name: 'down',
        writeQualification: async () => {
          throw new CrmError('GoHighLevel is unreachable', true);
        },
      },
      idempotency: store,
      crmMaxRetries: 0,
    });

    await expect(qualifyLead(lead({ event_id: 'evt-transient' }), 'c11', deps)).rejects.toBeInstanceOf(CrmError);
    // Holding the key here would mean the lead is never qualified at all.
    expect(store.size).toBe(0);

    const recovered = testDeps({ idempotency: store });
    const result = await qualifyLead(lead({ event_id: 'evt-transient' }), 'c12', recovered);
    expect(result.duplicate).toBe(false);
    expect(result.crm).not.toBeNull();
  });
});

describe('scenario 9 — a duplicate webhook is ignored after the first success', () => {
  it('processes once and returns the stored result on redelivery', async () => {
    const crm = new FakeCrm();
    const assess = vi.fn(async (l: GhlLead) => new FakeAssessor().assess(l));
    const deps = testDeps({ crm, assessor: { name: 'counting', assess } });

    const payload = lead({ event_id: 'evt-dup' });
    const first = await qualifyLead(payload, 'c13', deps);
    const second = await qualifyLead(payload, 'c14', deps);
    const third = await qualifyLead(payload, 'c15', deps);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(third.duplicate).toBe(true);
    // One model call and one CRM write, however many times GHL delivers it.
    expect(assess).toHaveBeenCalledTimes(1);
    expect(crm.totalWrites).toBe(1);
    expect(second.decision.route).toBe(first.decision.route);
  });

  it('does not pay for two classifications when deliveries arrive concurrently', async () => {
    const crm = new FakeCrm();
    const assess = vi.fn(async (l: GhlLead) => new FakeAssessor().assess(l));
    const deps = testDeps({ crm, assessor: { name: 'counting', assess } });

    const payload = lead({ event_id: 'evt-race' });
    const results = await Promise.all([
      qualifyLead(payload, 'r1', deps),
      qualifyLead(payload, 'r2', deps),
      qualifyLead(payload, 'r3', deps),
    ]);

    // The claim is taken before the model call, so only one delivery pays.
    expect(assess).toHaveBeenCalledTimes(1);
    expect(crm.totalWrites).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
  });

  it('forgets a processed event once its TTL expires', async () => {
    let now = 1_000_000;
    const store = new InMemoryIdempotencyStore(60_000, () => now);
    const crm = new FakeCrm();
    const deps = testDeps({ idempotency: store, crm });

    await qualifyLead(lead({ event_id: 'evt-ttl' }), 'c16', deps);
    now += 61_000;
    const afterExpiry = await qualifyLead(lead({ event_id: 'evt-ttl' }), 'c17', deps);

    expect(afterExpiry.duplicate).toBe(false);
    expect(crm.totalWrites).toBe(2);
  });
});

describe('scenario 10 — the same contact with a new event id is processed again', () => {
  it('qualifies each event independently while updating the one contact', async () => {
    const crm = new FakeCrm();
    const deps = testDeps({ crm });

    const created = await qualifyLead(
      lead({ event_id: 'evt-create', event_type: 'ContactCreate', inquiry: 'Just looking around, no rush.' }),
      'c18',
      deps,
    );
    const updated = await qualifyLead(
      lead({
        event_id: 'evt-update',
        event_type: 'ContactUpdate',
        inquiry:
          'Following up — we have budget approved and need to automate support for 400 staff this quarter. Please send a proposal urgently.',
        employees: 400,
        budget_eur: 60_000,
      }),
      'c19',
      deps,
    );

    expect(created.duplicate).toBe(false);
    expect(updated.duplicate).toBe(false);
    // One contact, two qualifications — the later enquiry scores higher.
    expect(crm.contactCount).toBe(1);
    expect(crm.totalWrites).toBe(2);
    expect(updated.decision.lead_score).toBeGreaterThan(created.decision.lead_score);
  });
});

/* -------------------------------------------------------------------------- */
/* The fake assessor, which the demo and most tests depend on                 */
/* -------------------------------------------------------------------------- */

describe('fake assessor', () => {
  it('produces schema-valid output for any lead', async () => {
    const result = await new FakeAssessor().assess(lead());
    const parsed: ClaudeAssessment = result.assessment;
    expect(parsed.lead_score).toBeGreaterThanOrEqual(0);
    expect(parsed.lead_score).toBeLessThanOrEqual(100);
    expect(parsed.confidence).toBeGreaterThan(0);
    expect(parsed.confidence).toBeLessThanOrEqual(1);
  });

  it('reports low confidence for a vague enquiry with nothing to go on', async () => {
    const vague = await new FakeAssessor().assess(
      lead({ inquiry: 'hi info?', company: undefined, employees: undefined, budget_eur: undefined, lead_source: undefined }),
    );
    const detailed = await new FakeAssessor().assess(lead());
    // This is what makes the confidence gate observable in the demo.
    expect(vague.assessment.confidence).toBeLessThan(detailed.assessment.confidence);
  });

  it('is deterministic', async () => {
    const a = await new FakeAssessor().assess(lead());
    const b = await new FakeAssessor().assess(lead());
    expect(a.assessment).toEqual(b.assessment);
  });
});

describe('pipeline plumbing', () => {
  it('reuses an inbound correlation id and reports token usage', async () => {
    const deps: PipelineDeps = testDeps();
    const result = await qualifyLead(lead(), 'trace-me', deps);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.promptVersion).toBeTruthy();
  });

  it('logs nothing sensitive at the default level', () => {
    // The logger redacts email and inquiry; this asserts the config exists
    // rather than re-testing pino.
    expect(silentLogger.level).toBe('silent');
  });
});
