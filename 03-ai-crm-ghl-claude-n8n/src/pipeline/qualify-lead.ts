import { GhlLeadSchema, type GhlLead } from '../domain/lead.js';
import type { Decision } from '../domain/qualification.js';
import { ValidationError } from '../lib/errors.js';
import type { IdempotencyStore } from '../lib/idempotency.js';
import { withRetry, withTimeout, type RetryOptions } from '../lib/retry.js';
import { LlmTimeoutError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { explain, route, type RoutingRules } from '../policy/routing.js';
import type { AssessorPort, CrmPort, CrmUpdateResult } from '../ports.js';

export interface PipelineDeps {
  assessor: AssessorPort;
  crm: CrmPort;
  idempotency: IdempotencyStore;
  rules: RoutingRules;
  logger: Logger;
  llmTimeoutMs: number;
  llmMaxRetries: number;
  crmMaxRetries?: number;
  retryOverrides?: Partial<RetryOptions>;
}

export interface QualifyResult {
  lead: GhlLead;
  decision: Decision;
  crm: CrmUpdateResult | null;
  /** True when this GHL event id had already been processed. */
  duplicate: boolean;
  usage: { model: string; promptVersion: string; inputTokens: number; outputTokens: number; latencyMs: number };
}

export function parseLead(input: unknown): GhlLead {
  const result = GhlLeadSchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      'Lead payload failed validation',
      result.error.issues.map((issue) => ({ path: issue.path.join('.') || '(root)', message: issue.message })),
    );
  }
  return result.data;
}

/**
 * The whole path: validate → claim → assess → route → write back.
 *
 * Ordering matters. The idempotency claim happens *before* the model call, so
 * two concurrent deliveries of the same GoHighLevel event cannot both pay for a
 * classification, and a redelivery after a timeout cannot produce a second CRM
 * write. If anything after the claim fails in a way the sender should retry,
 * the claim is released — holding it would turn one transient fault into a lead
 * that is never qualified.
 */
export async function qualifyLead(input: unknown, correlationId: string, deps: PipelineDeps): Promise<QualifyResult> {
  const lead = parseLead(input);
  const key = `ghl-event:${lead.event_id}`;

  const claimed = await deps.idempotency.claim(key);
  if (!claimed) {
    const previous = (await deps.idempotency.get(key)) as QualifyResult | undefined;
    deps.logger.info({ correlationId, eventId: lead.event_id, contactId: lead.contact_id }, 'duplicate event ignored');
    if (previous) return { ...previous, duplicate: true };
    // Claimed but not finished: another delivery is in flight right now.
    return {
      lead,
      decision: pendingDecision(),
      crm: null,
      duplicate: true,
      usage: { model: 'none', promptVersion: 'none', inputTokens: 0, outputTokens: 0, latencyMs: 0 },
    };
  }

  try {
    const assessed = await withRetry(
      () =>
        withTimeout(
          deps.llmTimeoutMs,
          (signal) => deps.assessor.assess(lead, signal),
          () => new LlmTimeoutError(deps.llmTimeoutMs),
        ),
      {
        retries: deps.llmMaxRetries,
        isRetryable: (error) => (error as { retryable?: boolean })?.retryable === true,
        onRetry: (error, attempt, delayMs) =>
          deps.logger.warn(
            { correlationId, attempt, delayMs, err: describe(error) },
            'retrying lead assessment',
          ),
        ...deps.retryOverrides,
      },
    );

    const decision = route(lead, assessed.assessment, deps.rules);

    if (decision.explanation.overrode_model) {
      // Worth watching. A rising override rate means the prompt's idea of a hot
      // lead and the routing rules' idea have drifted apart.
      deps.logger.info(
        {
          correlationId,
          model_said: decision.explanation.model_qualification,
          rules_said: decision.qualification,
          applied_rule: decision.explanation.applied_rule,
        },
        'routing rules overrode the model label',
      );
    }

    const crm = await withRetry(() => deps.crm.writeQualification(lead, decision), {
      retries: deps.crmMaxRetries ?? 2,
      isRetryable: (error) => (error as { retryable?: boolean })?.retryable === true,
      onRetry: (error, attempt, delayMs) =>
        deps.logger.warn({ correlationId, attempt, delayMs, err: describe(error) }, 'retrying CRM write'),
      ...deps.retryOverrides,
    });

    const result: QualifyResult = {
      lead,
      decision,
      crm,
      duplicate: false,
      usage: {
        model: assessed.model,
        promptVersion: assessed.promptVersion,
        inputTokens: assessed.inputTokens,
        outputTokens: assessed.outputTokens,
        latencyMs: assessed.latencyMs,
      },
    };

    await deps.idempotency.complete(key, result);

    deps.logger.info(
      {
        correlationId,
        contactId: lead.contact_id,
        route: decision.route,
        score: decision.lead_score,
        confidence: decision.confidence,
        rule: decision.explanation.applied_rule,
      },
      explain(decision),
    );

    return result;
  } catch (error) {
    // Let the sender retry a transient failure by giving the key back.
    if ((error as { retryable?: boolean })?.retryable === true) {
      await deps.idempotency.release(key);
    }
    deps.logger.error({ correlationId, eventId: lead.event_id, err: describe(error) }, 'lead qualification failed');
    throw error;
  }
}

function pendingDecision(): Decision {
  return {
    route: 'low_priority',
    qualification: 'cold',
    next_action: 'archive',
    lead_score: 0,
    confidence: 0,
    reason: 'Another delivery of this event is still being processed.',
    signals: [],
    industry: 'Unknown',
    explanation: {
      model_qualification: 'cold',
      model_next_action: 'archive',
      applied_rule: 'duplicate_in_flight',
      triggered: [],
      overrode_model: false,
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
