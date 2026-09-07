import type { NotificationInput, NotifierPort } from '../../core/ports/index';
import { AppError } from '../../lib/errors';

export interface SlackOptions {
  webhookUrl: string;
  fetchImpl?: typeof fetch;
}

const HEADLINE: Record<NotificationInput['kind'], string> = {
  approval_requested: '🟠 Approval needed',
  action_executed: '✅ Action executed',
  action_failed: '🔴 Action failed',
};

export class SlackNotifier implements NotifierPort {
  readonly name = 'slack';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SlackOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async notify(input: NotificationInput): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.options.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blocks: buildBlocks(input) }),
      });
    } catch (cause) {
      throw new AppError('Slack webhook request failed', 'notifier_error', 502, true, cause);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new AppError(
        `Slack webhook returned ${response.status}: ${detail.slice(0, 200)}`,
        'notifier_error',
        502,
        response.status === 429 || response.status >= 500,
      );
    }
  }
}

function buildBlocks(input: NotificationInput): unknown[] {
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: `${HEADLINE[input.kind]} — ${input.action.replace(/_/g, ' ')}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*${escapeSlack(input.subject)}*\n${escapeSlack(input.summary)}` } },
  ];

  if (input.detail && Object.keys(input.detail).length > 0) {
    blocks.push({
      type: 'section',
      fields: Object.entries(input.detail)
        .slice(0, 8)
        .map(([key, value]) => ({ type: 'mrkdwn', text: `*${escapeSlack(key)}:*\n${escapeSlack(String(value))}` })),
    });
  }

  // The approval itself happens in the admin UI, not in Slack. A Slack button
  // that mutates state needs its own signature verification and its own
  // identity model; a link keeps one authenticated path to one audit trail.
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: input.kind === 'approval_requested' ? 'Review case' : 'Open case' },
        url: input.url,
        style: input.kind === 'approval_requested' ? 'primary' : undefined,
      },
    ],
  });

  return blocks;
}

/** Slack mrkdwn treats these as control characters. */
function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, 2800);
}
