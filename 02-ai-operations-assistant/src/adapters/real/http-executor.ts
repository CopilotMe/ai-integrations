import type { ActionType } from '../../core/domain/types';
import type { ActionExecutorPort, ExecuteActionInput, ExecuteActionResult } from '../../core/ports/index';
import { ExecutionError } from '../../lib/errors';

export interface HttpExecutorOptions {
  webhookUrl: string;
  authToken?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Posts the approved action to a downstream system — in practice an n8n webhook
 * that fans out to the ticketing tool, the billing provider and the CRM.
 *
 * The idempotency key travels in a header as well as the body, because that is
 * what most downstream APIs expect, and because the whole guarantee depends on
 * the receiver honouring it.
 */
export class HttpExecutor implements ActionExecutorPort {
  readonly name = 'http';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpExecutorOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  supports(action: ActionType): boolean {
    return action !== 'no_action';
  }

  async execute(input: ExecuteActionInput): Promise<ExecuteActionResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.options.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': input.idempotencyKey,
          ...(this.options.authToken ? { authorization: `Bearer ${this.options.authToken}` } : {}),
        },
        body: JSON.stringify({
          idempotency_key: input.idempotencyKey,
          case_id: input.caseId,
          action: input.action,
          refund_amount_eur: input.refundAmountEur ?? null,
          template_key: input.templateKey ?? null,
          customer_email: input.message.from_email,
          subject: input.message.subject,
          summary: input.classification.summary,
          intent: input.classification.intent,
          urgency: input.classification.urgency,
        }),
      });
    } catch (cause) {
      throw new ExecutionError(`Downstream request failed for ${input.action}`, true, cause);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ExecutionError(
        `Downstream returned ${response.status} for ${input.action}: ${detail.slice(0, 300)}`,
        response.status === 429 || response.status >= 500,
      );
    }

    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const ref = body.external_ref ?? body.id ?? body.ref;
    return { externalRef: ref == null ? null : String(ref), response: body };
  }
}
