import { FakeAssessor } from '../src/adapters/fake/fake-assessor.js';
import { FakeCrm } from '../src/adapters/fake/fake-crm.js';
import type { GhlLead } from '../src/domain/lead.js';
import type { ClaudeAssessment } from '../src/domain/qualification.js';
import { InMemoryIdempotencyStore } from '../src/lib/idempotency.js';
import { createLogger } from '../src/lib/logger.js';
import { DEFAULT_RULES } from '../src/policy/routing.js';
import type { PipelineDeps } from '../src/pipeline/qualify-lead.js';

export const silentLogger = createLogger('silent', false);

/** A plausible, complete lead. Override anything a test cares about. */
export function lead(overrides: Partial<GhlLead> = {}): GhlLead {
  return {
    contact_id: 'contact-1',
    event_id: `evt-${Math.random().toString(36).slice(2, 10)}`,
    event_type: 'ContactCreate',
    email: 'nina.kovacs@northwind.de',
    first_name: 'Nina',
    last_name: 'Kovacs',
    company: 'Northwind GmbH',
    lead_source: 'Website form',
    tags: [],
    inquiry:
      'We are evaluating support automation for our 200-person team and need to integrate it with our current stack this quarter.',
    employees: 200,
    budget_eur: 40_000,
    ...overrides,
  } as GhlLead;
}

export function assessment(overrides: Partial<ClaudeAssessment> = {}): ClaudeAssessment {
  return {
    lead_score: 70,
    qualification: 'warm',
    reason: 'Good ICP fit with some information missing.',
    next_action: 'nurture_sequence',
    confidence: 0.8,
    signals: ['need to integrate it with our current stack this quarter'],
    industry: 'SaaS',
    ...overrides,
  };
}

/** Pipeline deps wired to fakes, with retries that run without real timers. */
export function testDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    assessor: new FakeAssessor(),
    crm: new FakeCrm(),
    idempotency: new InMemoryIdempotencyStore(),
    rules: DEFAULT_RULES,
    logger: silentLogger,
    llmTimeoutMs: 5000,
    llmMaxRetries: 1,
    crmMaxRetries: 2,
    retryOverrides: { sleep: async () => {}, random: () => 1 },
    ...overrides,
  };
}
