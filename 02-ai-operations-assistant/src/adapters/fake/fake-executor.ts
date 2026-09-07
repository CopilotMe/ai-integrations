import type { ActionType } from '../../core/domain/types';
import type { ActionExecutorPort, ExecuteActionInput, ExecuteActionResult } from '../../core/ports/index';

/**
 * In-memory executor.
 *
 * Honours the idempotency key the way a correct downstream integration must:
 * a repeated execution returns the original reference rather than creating a
 * second ticket or issuing a second refund.
 */
export class FakeExecutor implements ActionExecutorPort {
  readonly name = 'fake';
  private readonly byKey = new Map<string, ExecuteActionResult>();
  private sequence = 0;

  supports(action: ActionType): boolean {
    return action !== 'no_action';
  }

  async execute(input: ExecuteActionInput): Promise<ExecuteActionResult> {
    const existing = this.byKey.get(input.idempotencyKey);
    if (existing) return existing;

    const ref = `${prefixFor(input.action)}-${(++this.sequence).toString().padStart(5, '0')}`;
    const result: ExecuteActionResult = {
      externalRef: ref,
      response: {
        simulated: true,
        action: input.action,
        ref,
        ...(input.refundAmountEur != null ? { refund_amount_eur: input.refundAmountEur } : {}),
        ...(input.templateKey ? { template_key: input.templateKey } : {}),
      },
    };
    this.byKey.set(input.idempotencyKey, result);
    return result;
  }

  get executedCount(): number {
    return this.byKey.size;
  }
}

function prefixFor(action: ActionType): string {
  switch (action) {
    case 'issue_refund':
      return 'REF';
    case 'create_ticket':
      return 'TCK';
    case 'send_templated_reply':
      return 'MSG';
    case 'cancel_subscription':
      return 'CAN';
    case 'update_account':
      return 'ACC';
    case 'escalate_to_human':
      return 'ESC';
    default:
      return 'NOP';
  }
}
