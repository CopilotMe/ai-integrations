import { FakeClassifier } from '../adapters/fake/fake-classifier';
import { FakeExecutor } from '../adapters/fake/fake-executor';
import { FakeNotifier } from '../adapters/fake/fake-notifier';
import { HttpExecutor } from '../adapters/real/http-executor';
import { OpenAiClassifier } from '../adapters/real/openai-classifier';
import { SlackNotifier } from '../adapters/real/slack-notifier';
import type { PipelineDeps } from '../core/pipeline/process-message';
import type { PolicyConfig } from '../core/policy/autonomy';
import type { ActionExecutorPort, ClassifierPort, NotifierPort } from '../core/ports/index';
import { getDb } from '../db/client';
import { config, type Config } from '../lib/config';
import { logger } from '../lib/logger';

export function policyFromConfig(c: Config = config()): PolicyConfig {
  return {
    thresholds: {
      none: c.POLICY_THRESHOLD_NONE,
      low: c.POLICY_THRESHOLD_LOW,
      medium: c.POLICY_THRESHOLD_MEDIUM,
      high: c.POLICY_THRESHOLD_HIGH,
    },
    refundAutoApproveCapEur: c.POLICY_REFUND_AUTO_CAP_EUR,
    vipDomains: c.POLICY_VIP_DOMAINS,
    alwaysReviewIntents: c.POLICY_ALWAYS_REVIEW_INTENTS,
    minimumConfidence: c.POLICY_MIN_CONFIDENCE,
  };
}

function buildClassifier(c: Config): ClassifierPort {
  return c.LLM_PROVIDER === 'openai'
    ? new OpenAiClassifier({ apiKey: c.OPENAI_API_KEY, model: c.OPENAI_MODEL })
    : new FakeClassifier();
}

function buildExecutor(c: Config): ActionExecutorPort {
  return c.TICKETING_PROVIDER === 'http'
    ? new HttpExecutor({ webhookUrl: c.TICKETING_WEBHOOK_URL })
    : new FakeExecutor();
}

function buildNotifier(c: Config): NotifierPort {
  return c.NOTIFIER_PROVIDER === 'slack' ? new SlackNotifier({ webhookUrl: c.SLACK_WEBHOOK_URL }) : new FakeNotifier();
}

let cached: PipelineDeps | undefined;

/**
 * Composition root — the only module that knows which concrete adapter is live.
 *
 * Cached per process because the fake executor and notifier hold state that
 * must survive between requests in a demo, and because building an OpenAI
 * client per request is waste.
 */
export function deps(): PipelineDeps {
  if (!cached) {
    const c = config();
    cached = {
      db: getDb(),
      classifier: buildClassifier(c),
      executor: buildExecutor(c),
      notifier: buildNotifier(c),
      policy: policyFromConfig(c),
      logger: logger(),
      appUrl: c.APP_URL,
      llmTimeoutMs: c.LLM_TIMEOUT_MS,
      llmMaxRetries: c.LLM_MAX_RETRIES,
    };
  }
  return cached;
}

export function resetDeps(): void {
  cached = undefined;
}
