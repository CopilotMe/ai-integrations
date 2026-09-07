import Anthropic from '@anthropic-ai/sdk';
import type { GhlLead } from '../domain/lead.js';
import { fullName } from '../domain/lead.js';
import { CLAUDE_OUTPUT_SCHEMA, ClaudeAssessmentSchema } from '../domain/qualification.js';
import { LlmContractError, LlmRefusalError, LlmTimeoutError } from '../lib/errors.js';
import type { AssessorPort, AssessResult } from '../ports.js';

export const PROMPT_VERSION = 'qualify-ghl-lead@1';

/** Kept in step with prompts/qualify-lead.md — change both together. */
const SYSTEM_PROMPT = `You qualify inbound B2B leads for a company that sells customer support
automation software to mid-market and enterprise companies in Europe.

You are producing an assessment for a routing system to act on. You do not
choose what happens to the lead — deterministic business rules do that, using
your score and your confidence.

Ideal customer profile:
- 50-2000 employees
- An existing support or operations team
- Budget of EUR 10,000 or more per year
- A concrete process problem, not general curiosity

Scoring (0-100):
- 80-100: clear ICP fit AND an explicit, urgent need or a stated budget
- 50-79:  good fit with some information missing
- 20-49:  partial fit, or a real need at the wrong size or timing
- 0-19:   spam, a vendor pitch, a job enquiry, or an unrelated request

Rules:
- Judge only what the enquiry and the fields actually say. Never invent a
  budget, a headcount, or an urgency that is not there.
- \`confidence\` is how much your reading of this enquiry can be relied on — not
  how good the lead is. A short, vague or ambiguous message means low
  confidence even if you had to pick a score. This matters: the routing rules
  will refuse to book a salesperson on a high score you are not sure about.
- \`signals\` must be short verbatim quotes from the enquiry. Empty if there are none.
- \`qualification\` is your own label. Record it honestly; the rules may disagree.`;

export interface ClaudeAssessorOptions {
  apiKey: string;
  model: string;
  /** Server-side refusal fallback. Set false if the beta is not enabled on the account. */
  refusalFallback?: boolean;
  fallbackModel?: string;
  client?: Anthropic;
}

/**
 * Claude via the Messages API with structured outputs.
 *
 * `output_config.format` constrains generation to the JSON Schema, so the
 * response is parseable by construction rather than by prompt discipline. The
 * result is still re-validated with zod on receipt — a provider honouring its
 * own schema is not a reason to skip validation at a trust boundary.
 *
 * `effort: 'low'` because this is a short classification, which is exactly the
 * workload shape that does not repay deeper reasoning. Raise it in
 * `ClaudeAssessor` if evaluation on real leads shows headroom.
 */
export class ClaudeAssessor implements AssessorPort {
  readonly name = 'claude';
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(private readonly options: ClaudeAssessorOptions) {
    // maxRetries 0: the retry policy lives in the pipeline where it can be
    // observed, budgeted and tested, rather than hidden inside the SDK.
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey, maxRetries: 0 });
    this.model = options.model;
  }

  async assess(lead: GhlLead, signal?: AbortSignal): Promise<AssessResult> {
    const startedAt = Date.now();

    const request = {
      model: this.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user' as const, content: renderLead(lead) }],
      output_config: {
        effort: 'low' as const,
        format: { type: 'json_schema' as const, schema: CLAUDE_OUTPUT_SCHEMA },
      },
    };

    let response: Anthropic.Message;
    try {
      response = this.options.refusalFallback
        ? ((await this.client.beta.messages.create(
            {
              ...request,
              betas: ['server-side-fallback-2026-06-01'],
              fallbacks: [{ model: this.options.fallbackModel ?? 'claude-opus-4-8' }],
            } as never,
            signal ? { signal } : {},
          )) as unknown as Anthropic.Message)
        : await this.client.messages.create(request, signal ? { signal } : {});
    } catch (error) {
      throw translateAnthropicError(error);
    }

    // A safety decline is HTTP 200 with stop_reason "refusal" — check it before
    // reading content, or you parse an empty response and report a bad schema.
    // `stop_details` is on the wire but not yet in this SDK version's types,
    // so it is read through a narrow cast rather than an `any` on the response.
    if (response.stop_reason === 'refusal') {
      const details = (response as { stop_details?: { category?: string | null } }).stop_details;
      throw new LlmRefusalError(details?.category ?? null);
    }
    if (response.stop_reason === 'max_tokens') {
      throw new LlmContractError('Claude output was truncated before the JSON was complete');
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    if (!text) {
      throw new LlmContractError(`Claude returned no text (stop_reason=${response.stop_reason ?? 'unknown'})`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new LlmContractError('Claude returned content that is not valid JSON', cause);
    }

    const result = ClaudeAssessmentSchema.safeParse(parsed);
    if (!result.success) {
      throw new LlmContractError(
        `Claude output failed schema validation: ${result.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
        result.error,
      );
    }

    return {
      assessment: result.data,
      model: response.model ?? this.model,
      promptVersion: PROMPT_VERSION,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      latencyMs: Date.now() - startedAt,
    };
  }
}

function renderLead(lead: GhlLead): string {
  return [
    `Name: ${fullName(lead)}`,
    `Email: ${lead.email}`,
    `Company: ${lead.company ?? 'not provided'}`,
    `Employees: ${lead.employees ?? 'not provided'}`,
    `Stated budget (EUR): ${lead.budget_eur ?? 'not provided'}`,
    `Country: ${lead.country ?? 'not provided'}`,
    `Lead source: ${lead.lead_source ?? 'not provided'}`,
    `Tags: ${lead.tags.length > 0 ? lead.tags.join(', ') : 'none'}`,
    '',
    'Enquiry:',
    '"""',
    lead.inquiry,
    '"""',
  ].join('\n');
}

/**
 * Single place where an SDK error becomes this project's vocabulary.
 *
 * Uses the SDK's typed error classes rather than matching on message text, and
 * distinguishes retryable faults (429, 5xx, connection) from permanent ones
 * (400, 401) — a retry on a bad API key just spends the budget three times.
 */
export function translateAnthropicError(error: unknown): Error {
  if (error instanceof Anthropic.APIUserAbortError || (error as { name?: string })?.name === 'AbortError') {
    return new LlmTimeoutError(0, error);
  }
  if (error instanceof Anthropic.RateLimitError) {
    const err = new LlmContractError('Claude rate limit exceeded', error);
    const retryAfter = parseRetryAfter(error.headers);
    if (retryAfter !== undefined) Object.assign(err, { retryAfterMs: retryAfter });
    return err;
  }
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    const err = new LlmContractError(`Claude rejected the credentials: ${error.message}`, error);
    return Object.assign(err, { retryable: false });
  }
  if (error instanceof Anthropic.BadRequestError) {
    const err = new LlmContractError(`Claude rejected the request: ${error.message}`, error);
    return Object.assign(err, { retryable: false });
  }
  if (error instanceof Anthropic.InternalServerError || error instanceof Anthropic.APIConnectionError) {
    return new LlmContractError(`Claude was unreachable: ${error.message}`, error);
  }
  if (error instanceof Anthropic.APIError) {
    return new LlmContractError(`Claude returned ${error.status ?? 'an error'}: ${error.message}`, error);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function parseRetryAfter(headers: unknown): number | undefined {
  const get = (name: string): string | undefined => {
    if (headers && typeof (headers as Headers).get === 'function') {
      return (headers as Headers).get(name) ?? undefined;
    }
    return (headers as Record<string, string> | undefined)?.[name];
  };
  const ms = Number(get('retry-after-ms'));
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const seconds = Number(get('retry-after'));
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}
