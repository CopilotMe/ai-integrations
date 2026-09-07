import { FakeAssessor } from './adapters/fake/fake-assessor.js';
import { FakeCrm } from './adapters/fake/fake-crm.js';
import { ClaudeAssessor } from './adapters/claude.js';
import { GhlCrm } from './adapters/ghl.js';
import type { Config } from './config.js';
import { InMemoryIdempotencyStore } from './lib/idempotency.js';
import type { Logger } from './lib/logger.js';
import type { PipelineDeps } from './pipeline/qualify-lead.js';
import type { RoutingRules } from './policy/routing.js';
import type { AssessorPort, CrmPort } from './ports.js';

export function rulesFromConfig(c: Config): RoutingRules {
  return {
    hotScore: c.HOT_SCORE_THRESHOLD,
    warmScore: c.WARM_SCORE_THRESHOLD,
    hotConfidence: c.HOT_CONFIDENCE_THRESHOLD,
    warmConfidence: c.WARM_CONFIDENCE_THRESHOLD,
    blockedEmailDomains: c.BLOCKED_EMAIL_DOMAINS,
  };
}

function buildAssessor(c: Config): AssessorPort {
  return c.LLM_PROVIDER === 'claude'
    ? new ClaudeAssessor({
        apiKey: c.ANTHROPIC_API_KEY,
        model: c.CLAUDE_MODEL,
        refusalFallback: c.CLAUDE_REFUSAL_FALLBACK,
        fallbackModel: c.CLAUDE_FALLBACK_MODEL,
      })
    : new FakeAssessor();
}

function buildCrm(c: Config): CrmPort {
  return c.CRM_PROVIDER === 'ghl'
    ? new GhlCrm({
        accessToken: c.GHL_ACCESS_TOKEN,
        locationId: c.GHL_LOCATION_ID,
        baseUrl: c.GHL_API_BASE,
        apiVersion: c.GHL_API_VERSION,
      })
    : new FakeCrm();
}

/** Composition root: the only module that knows which concrete adapter is live. */
export function buildDeps(config: Config, logger: Logger, overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    assessor: buildAssessor(config),
    crm: buildCrm(config),
    idempotency: new InMemoryIdempotencyStore(config.IDEMPOTENCY_TTL_MINUTES * 60_000),
    rules: rulesFromConfig(config),
    logger,
    llmTimeoutMs: config.LLM_TIMEOUT_MS,
    llmMaxRetries: config.LLM_MAX_RETRIES,
    ...overrides,
  };
}
