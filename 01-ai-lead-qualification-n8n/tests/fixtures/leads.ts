import type { Config } from '../../src/config.js';
import { loadConfig } from '../../src/config.js';
import type { RoutingRules } from '../../src/domain/routing.js';
import type { LlmAssessment } from '../../src/domain/qualification.js';
import { createLogger } from '../../src/logger.js';

/** A textbook HOT lead: real company, real budget, explicit need. */
export const hotLead = {
  name: 'John Smith',
  email: 'john.smith@acme.co',
  company: 'Acme Ltd',
  employees: 120,
  budget: 25_000,
  message: 'We need to automate customer support. Our current process is manual and we want to start this quarter.',
  source: 'website_form' as const,
};

/** Real interest, but too small and no budget stated. */
export const warmLead = {
  name: 'Maria Petrova',
  email: 'maria@smallshop.bg',
  company: 'SmallShop',
  employees: 8,
  message: 'We are looking at automating parts of our online store support and comparing a few options.',
  source: 'website_form' as const,
};

/** Job enquiry from a free address with no company. */
export const coldLead = {
  name: 'Ivan Ivanov',
  email: 'ivan.ivanov@gmail.com',
  message: 'Hi, are you hiring? I am sending my CV for any open vacancy.',
  source: 'email' as const,
};

export const blockedDomainLead = {
  ...hotLead,
  email: 'sales@competitor.com',
};

export const negativeIntentLead = {
  ...hotLead,
  email: 'someone@acme.co',
  message: 'Please unsubscribe me from all your communications. I am not interested.',
};

export const testRules: RoutingRules = {
  hotScoreThreshold: 75,
  warmScoreThreshold: 45,
  minQualifiedBudgetEur: 5000,
  highBudgetEur: 25_000,
  blockedEmailDomains: ['competitor.com', 'example-spam.io'],
};

export function assessment(overrides: Partial<LlmAssessment> = {}): LlmAssessment {
  return {
    score: 80,
    suggested_classification: 'HOT',
    industry: 'SaaS',
    estimated_value: 25_000,
    reason: 'Strong ICP fit and explicit automation need',
    signals: ['We need to automate customer support'],
    confidence: 0.9,
    ...overrides,
  };
}

export const silentLogger = createLogger('silent', false);

/** Retry overrides that keep tests fast and deterministic. */
export const instantRetries = { sleep: async () => {}, random: () => 1 };

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LLM_PROVIDER: 'fake',
    CRM_PROVIDER: 'fake',
    NOTIFIER_PROVIDER: 'fake',
    ...overrides,
  } as NodeJS.ProcessEnv);
}
