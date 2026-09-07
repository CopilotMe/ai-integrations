import OpenAI from 'openai';
import {
  CLASSIFICATION_JSON_SCHEMA,
  ClassificationSchema,
  type InboundMessage,
} from '../../core/domain/types';
import type { ClassifierPort, ClassifyResult } from '../../core/ports/index';
import { ClassifierError } from '../../lib/errors';

export const PROMPT_VERSION = 'classify-support-email@2';

/** Kept in sync with prompts/classify-support-email.md — change both together. */
const SYSTEM_PROMPT = `You triage inbound customer support email for a European SaaS company.

Read the message and return a structured classification. You are proposing an
action for a system to consider; you are not authorising it. A human may review
anything you propose.

Rules:
- Judge only what the message says. Never infer an order, an amount, or a
  prior conversation that is not in the text.
- \`confidence\` is your confidence in the *classification*, not in whether the
  action is a good idea. Missing context lowers it.
- \`evidence\` must be verbatim quotes from the message. Empty if there are none.
- Propose \`issue_refund\` only when the sender explicitly asks for money back.
  Set \`refund_amount_eur\` only if an amount is stated; otherwise null.
- Propose \`send_templated_reply\` only when a named template plainly answers the
  message, and set \`template_key\`. Otherwise propose \`create_ticket\` or
  \`escalate_to_human\`.
- Set \`needs_translation\` when the message is not in English.
- When the message is angry, threatens legal action, or mentions a regulator,
  classify intent as \`complaint\` and propose \`escalate_to_human\`.
- If you cannot tell what is being asked, say so: low confidence and
  \`escalate_to_human\` is the correct answer, not a guess.`;

export interface OpenAiClassifierOptions {
  apiKey: string;
  model: string;
  client?: OpenAI;
}

export class OpenAiClassifier implements ClassifierPort {
  readonly name = 'openai';
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(options: OpenAiClassifierOptions) {
    // maxRetries 0: retry policy lives in the pipeline, where it can be
    // observed, budgeted and tested, rather than hidden inside the SDK.
    this.client = options.client ?? new OpenAI({ apiKey: options.apiKey, maxRetries: 0 });
    this.model = options.model;
  }

  async classify(message: InboundMessage, signal?: AbortSignal): Promise<ClassifyResult> {
    const startedAt = Date.now();

    let completion: OpenAI.Chat.Completions.ChatCompletion;
    try {
      completion = await this.client.chat.completions.create(
        {
          model: this.model,
          temperature: 0.1,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: renderMessage(message) },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'support_classification',
              strict: true,
              schema: CLASSIFICATION_JSON_SCHEMA,
            },
          },
        },
        signal ? { signal } : {},
      );
    } catch (error) {
      throw translateOpenAiError(error);
    }

    const choice = completion.choices[0];
    if (choice?.finish_reason === 'length') {
      throw new ClassifierError('Model output was truncated before the JSON was complete');
    }
    const content = choice?.message?.content;
    if (!content) {
      throw new ClassifierError(`Model returned no content (finish_reason=${choice?.finish_reason ?? 'unknown'})`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (cause) {
      throw new ClassifierError('Model returned content that is not valid JSON', true, cause);
    }

    // Structured outputs make this rare, not impossible. Validating at the
    // trust boundary is not optional just because the provider promises a shape.
    const result = ClassificationSchema.safeParse(parsed);
    if (!result.success) {
      throw new ClassifierError(
        `Model output failed schema validation: ${result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        true,
        result.error,
      );
    }

    return {
      classification: result.data,
      model: this.model,
      promptVersion: PROMPT_VERSION,
      promptTokens: completion.usage?.prompt_tokens ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - startedAt,
      degraded: false,
    };
  }
}

function renderMessage(message: InboundMessage): string {
  return [
    `From: ${message.from_name ? `${message.from_name} <${message.from_email}>` : message.from_email}`,
    `To: ${message.to_email}`,
    `Subject: ${message.subject || '(no subject)'}`,
    '',
    'Body:',
    '"""',
    message.body,
    '"""',
  ].join('\n');
}

export function translateOpenAiError(error: unknown): Error {
  const status = (error as { status?: number })?.status;
  const name = (error as { name?: string })?.name;

  if (name === 'AbortError') {
    return new ClassifierError('Model call was aborted', true, error);
  }
  if (status === 429) {
    const headers = (error as { headers?: Record<string, string> })?.headers;
    const err = new ClassifierError('OpenAI rate limit exceeded', true, error);
    const retryAfter = parseRetryAfter(headers);
    if (retryAfter !== undefined) Object.assign(err, { retryAfterMs: retryAfter });
    return err;
  }
  if (typeof status === 'number' && status >= 500) {
    return new ClassifierError(`OpenAI returned ${status}`, true, error);
  }
  if (typeof status === 'number' && status >= 400) {
    // 400/401/403 will fail identically on retry — do not waste the budget.
    return new ClassifierError(`OpenAI returned ${status}`, false, error);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function parseRetryAfter(headers?: Record<string, string>): number | undefined {
  if (!headers) return undefined;
  const ms = Number(headers['retry-after-ms']);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const seconds = Number(headers['retry-after']);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}
