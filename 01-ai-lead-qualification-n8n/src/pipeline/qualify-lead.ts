import { LeadSchema, type Lead } from '../domain/lead.js';
import type { LlmAssessment, Qualification } from '../domain/qualification.js';
import { decide, type RoutingRules } from '../domain/routing.js';
import { heuristicBaseScore } from '../domain/scoring.js';
import { withRetry, type RetryOptions } from '../lib/retry.js';
import { withTimeout } from '../lib/timeout.js';
import type { Logger } from '../logger.js';
import type { LlmPort } from '../ports/llm.js';
import { LlmTimeoutError, ValidationError } from './errors.js';

export interface QualifyDeps {
  llm: LlmPort;
  rules: RoutingRules;
  logger: Logger;
  llmTimeoutMs: number;
  llmMaxRetries: number;
  /** Escape hatch for tests: run retries without real timers. */
  retryOverrides?: Partial<RetryOptions>;
}

export interface QualifyResult {
  lead: Lead;
  qualification: Qualification;
  suggestedReply: string | null;
}

export function parseLead(input: unknown): Lead {
  const result = LeadSchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      'Lead payload failed validation',
      result.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/**
 * Validate → assess → decide → draft. No side effects, so it is safe to call
 * from n8n for a dry run, from an eval harness, or twice by accident.
 */
export async function qualifyLead(input: unknown, deps: QualifyDeps): Promise<QualifyResult> {
  const lead = parseLead(input);
  const { assessment, degraded } = await assessWithFallback(lead, deps);
  const qualification = decide(lead, assessment, deps.rules, { degraded });

  if (qualification.explanation.overrode_model) {
    // Worth watching: a rising override rate means the prompt has drifted away
    // from the business rules, or the rules have moved on without the prompt.
    deps.logger.info(
      {
        applied_rule: qualification.explanation.applied_rule,
        model_said: assessment.suggested_classification,
        rules_said: qualification.classification,
      },
      'routing rules overrode model suggestion',
    );
  }

  const suggestedReply = await draftReplyBestEffort(lead, qualification, deps);
  return { lead, qualification, suggestedReply };
}

/**
 * A lead is never lost because the model was unavailable.
 *
 * Retries cover the transient cases (429, 5xx, timeout, truncated or malformed
 * JSON). If they are all exhausted we fall back to a deterministic heuristic
 * and flag the result as degraded, so the lead still reaches a human with an
 * honest "this was not AI-scored" marker attached.
 */
async function assessWithFallback(
  lead: Lead,
  deps: QualifyDeps,
): Promise<{ assessment: LlmAssessment; degraded: boolean }> {
  try {
    const assessment = await withRetry(
      () =>
        withTimeout(
          deps.llmTimeoutMs,
          (signal) => deps.llm.assess(lead, signal),
          () => new LlmTimeoutError(deps.llmTimeoutMs),
        ),
      {
        retries: deps.llmMaxRetries,
        isRetryable: (error) => (error as { retryable?: boolean })?.retryable === true,
        onRetry: (error, attempt, delayMs) =>
          deps.logger.warn(
            { attempt, delayMs, code: (error as { code?: string })?.code, err: describe(error) },
            'retrying LLM assessment',
          ),
        ...deps.retryOverrides,
      },
    );
    return { assessment, degraded: false };
  } catch (error) {
    deps.logger.error(
      { err: describe(error), code: (error as { code?: string })?.code },
      'LLM assessment failed after retries — falling back to heuristic scoring',
    );
    return { assessment: heuristicAssessment(lead), degraded: true };
  }
}

function heuristicAssessment(lead: Lead): LlmAssessment {
  const score = heuristicBaseScore(lead);
  return {
    score,
    suggested_classification: score >= 75 ? 'HOT' : score >= 45 ? 'WARM' : 'COLD',
    industry: 'Unknown',
    estimated_value: lead.budget ?? 0,
    reason: 'Scored by fallback heuristic — the AI assessment was unavailable. Needs manual review.',
    signals: [],
    confidence: 0.2,
  };
}

/** Drafting a reply is a convenience, never a reason to fail a lead. */
async function draftReplyBestEffort(
  lead: Lead,
  qualification: Qualification,
  deps: QualifyDeps,
): Promise<string | null> {
  if (qualification.classification === 'COLD') return null;
  if (qualification.explanation.degraded) return null;

  try {
    return await withTimeout(
      deps.llmTimeoutMs,
      (signal) => deps.llm.draftReply(lead, qualification, signal),
      () => new LlmTimeoutError(deps.llmTimeoutMs),
    );
  } catch (error) {
    deps.logger.warn({ err: describe(error) }, 'reply drafting failed — continuing without a draft');
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
