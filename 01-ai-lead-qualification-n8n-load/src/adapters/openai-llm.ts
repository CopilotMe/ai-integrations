import OpenAI from 'openai';
import type { Lead } from '../domain/lead.js';
import {
  LLM_ASSESSMENT_JSON_SCHEMA,
  LlmAssessmentSchema,
  type LlmAssessment,
  type Qualification,
} from '../domain/qualification.js';
import { LlmContractError, LlmRateLimitError, LlmTimeoutError } from '../pipeline/errors.js';
import type { LlmPort } from '../ports/llm.js';

export interface OpenAiLlmOptions {
  apiKey: string;
  model: string;
  /** Injected in tests. */
  client?: OpenAI;
}

const SYSTEM_PROMPT = `You are a B2B lead qualification analyst for a company that sells customer
support automation software to mid-market and enterprise companies in Europe.

Assess the inbound lead and return a structured assessment.

Ideal customer profile (ICP):
- 50-2000 employees
- Has an existing support or operations team
- Budget of EUR 10,000 or more per year
- Expresses a concrete process problem, not general curiosity

Scoring guidance (0-100):
- 80-100: Clear ICP fit AND an explicit, urgent need or stated budget
- 60-79:  Good fit with some missing information
- 40-59:  Partial fit, or a real need but wrong size/timing
- 20-39:  Weak fit, exploratory, student or job-seeking enquiry
- 0-19:   Spam, vendor pitch, or an unrelated request

Rules:
- Judge only what the message and fields actually say. Do not invent budget,
  headcount or urgency that is not there.
- Missing information lowers confidence, not the score.
- \`signals\` must be short verbatim quotes from the message that justify the
  score. Return an empty array if the message contains none.
- \`estimated_value\` is the annual contract value in EUR you would forecast.
  Use the stated budget when given.
- \`suggested_classification\` is your opinion; the receiving system may override
  it with business rules.`;

const REPLY_SYSTEM_PROMPT = `You draft the first reply a salesperson sends to an inbound lead.

Constraints:
- 60-110 words. Plain text, no markdown, no subject line.
- Reference one specific detail from their message so it does not read as a
  template.
- Never invent product capabilities, pricing, customer names or availability.
- Never state or imply a delivery timeline.
- End with one concrete next step matching the assigned next action.
- Sign off as "the team" — a human will add their own name before sending.

This is a draft for a human to review and edit. It is never sent automatically.`;

/** See `prompts/qualify-lead.md` — this file and that one must stay in sync. */
export class OpenAiLlm implements LlmPort {
  readonly name = 'openai';
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(options: OpenAiLlmOptions) {
    this.client = options.client ?? new OpenAI({ apiKey: options.apiKey, maxRetries: 0 });
    this.model = options.model;
  }

  async assess(lead: Lead, signal?: AbortSignal): Promise<LlmAssessment> {
    const raw = await this.call(
      {
        model: this.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: renderLead(lead) },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'lead_assessment',
            strict: true,
            schema: LLM_ASSESSMENT_JSON_SCHEMA,
          },
        },
      },
      signal,
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new LlmContractError('Model returned content that is not valid JSON', cause);
    }

    const result = LlmAssessmentSchema.safeParse(parsed);
    if (!result.success) {
      throw new LlmContractError(
        `Model output failed schema validation: ${result.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
        result.error,
      );
    }
    return result.data;
  }

  async draftReply(lead: Lead, qualification: Qualification, signal?: AbortSignal): Promise<string> {
    const content = await this.call(
      {
        model: this.model,
        temperature: 0.6,
        messages: [
          { role: 'system', content: REPLY_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              `Lead: ${lead.name} at ${lead.company ?? 'unknown company'}`,
              `Classification: ${qualification.classification} (score ${qualification.score})`,
              `Next action: ${qualification.next_action}`,
              `Why: ${qualification.reason}`,
              '',
              'Their message:',
              '"""',
              lead.message,
              '"""',
            ].join('\n'),
          },
        ],
      },
      signal,
    );
    return content.trim();
  }

  /** Single place where provider errors become our error vocabulary. */
  private async call(
    params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    signal?: AbortSignal,
  ): Promise<string> {
    let completion: OpenAI.Chat.Completions.ChatCompletion;
    try {
      completion = await this.client.chat.completions.create(params, signal ? { signal } : {});
    } catch (error) {
      throw translateOpenAiError(error);
    }

    const choice = completion.choices[0];
    if (choice?.finish_reason === 'length') {
      throw new LlmContractError('Model output was truncated before the JSON was complete');
    }
    const content = choice?.message?.content;
    if (!content) {
      throw new LlmContractError(
        `Model returned no content (finish_reason=${choice?.finish_reason ?? 'unknown'})`,
      );
    }
    return content;
  }
}

function renderLead(lead: Lead): string {
  return [
    `Name: ${lead.name}`,
    `Email: ${lead.email}`,
    `Company: ${lead.company ?? 'not provided'}`,
    `Employees: ${lead.employees ?? 'not provided'}`,
    `Stated budget (EUR): ${lead.budget ?? 'not provided'}`,
    `Country: ${lead.country ?? 'not provided'}`,
    `Source: ${lead.source}`,
    '',
    'Message:',
    '"""',
    lead.message,
    '"""',
  ].join('\n');
}

export function translateOpenAiError(error: unknown): Error {
  const status = (error as { status?: number })?.status;
  const name = (error as { name?: string })?.name;

  if (name === 'AbortError' || (error as { code?: string })?.code === 'ETIMEDOUT') {
    return new LlmTimeoutError(0, error);
  }
  if (status === 429) {
    const headers = (error as { headers?: Record<string, string> })?.headers;
    return new LlmRateLimitError('OpenAI rate limit exceeded', parseRetryAfter(headers), error);
  }
  if (typeof status === 'number' && status >= 500) {
    return new LlmContractError(`OpenAI returned ${status}`, error);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** `Retry-After` is seconds; `retry-after-ms` is what OpenAI actually sends. */
function parseRetryAfter(headers?: Record<string, string>): number | undefined {
  if (!headers) return undefined;
  const ms = Number(headers['retry-after-ms']);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const seconds = Number(headers['retry-after']);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}
