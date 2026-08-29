import { FakeCrm } from './adapters/fake/fake-crm.js';
import { FakeLlm } from './adapters/fake/fake-llm.js';
import { FakeNotifier } from './adapters/fake/fake-notifier.js';
import { HubSpotCrm } from './adapters/hubspot-crm.js';
import { OpenAiLlm } from './adapters/openai-llm.js';
import { SlackNotifier } from './adapters/slack-notifier.js';
import type { Config } from './config.js';
import type { RoutingRules } from './domain/routing.js';
import { FileDeadLetter, type DeadLetterPort } from './lib/deadletter.js';
import type { Logger } from './logger.js';
import type { CrmPort } from './ports/crm.js';
import type { LlmPort } from './ports/llm.js';
import type { NotifierPort } from './ports/notifier.js';
import type { ProcessDeps } from './pipeline/process-lead.js';

export const DEAD_LETTER_PATH = '.data/dead-letter.jsonl';

/** Composition root: the only place that knows which concrete adapter is in play. */
export function buildDeps(config: Config, logger: Logger, overrides: Partial<ProcessDeps> = {}): ProcessDeps {
  const rules: RoutingRules = {
    hotScoreThreshold: config.HOT_SCORE_THRESHOLD,
    warmScoreThreshold: config.WARM_SCORE_THRESHOLD,
    minQualifiedBudgetEur: config.MIN_QUALIFIED_BUDGET_EUR,
    highBudgetEur: config.HIGH_BUDGET_EUR,
    blockedEmailDomains: config.BLOCKED_EMAIL_DOMAINS,
  };

  return {
    llm: buildLlm(config),
    crm: buildCrm(config),
    notifier: buildNotifier(config),
    deadLetter: buildDeadLetter(),
    rules,
    logger,
    llmTimeoutMs: config.LLM_TIMEOUT_MS,
    llmMaxRetries: config.LLM_MAX_RETRIES,
    ...overrides,
  };
}

function buildLlm(config: Config): LlmPort {
  return config.LLM_PROVIDER === 'openai'
    ? new OpenAiLlm({ apiKey: config.OPENAI_API_KEY, model: config.OPENAI_MODEL })
    : new FakeLlm();
}

function buildCrm(config: Config): CrmPort {
  return config.CRM_PROVIDER === 'hubspot'
    ? new HubSpotCrm({
        accessToken: config.HUBSPOT_ACCESS_TOKEN,
        pipelineId: config.HUBSPOT_PIPELINE_ID,
        dealStageHot: config.HUBSPOT_DEAL_STAGE_HOT,
        dealStageWarm: config.HUBSPOT_DEAL_STAGE_WARM,
      })
    : new FakeCrm();
}

function buildNotifier(config: Config): NotifierPort {
  return config.NOTIFIER_PROVIDER === 'slack'
    ? new SlackNotifier({ webhookUrl: config.SLACK_WEBHOOK_URL, notifyOn: config.SLACK_NOTIFY_ON })
    : new FakeNotifier();
}

function buildDeadLetter(): DeadLetterPort {
  return new FileDeadLetter(DEAD_LETTER_PATH);
}
