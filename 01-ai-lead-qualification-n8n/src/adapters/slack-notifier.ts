import type { Classification } from '../domain/qualification.js';
import { NotifierError } from '../pipeline/errors.js';
import type { NotificationInput, NotifierPort } from '../ports/notifier.js';

export interface SlackOptions {
  webhookUrl: string;
  notifyOn: Classification[];
  fetchImpl?: typeof fetch;
}

const EMOJI: Record<Classification, string> = { HOT: '🔥', WARM: '🌤️', COLD: '🧊' };

export class SlackNotifier implements NotifierPort {
  readonly name = 'slack';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SlackOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async notify(input: NotificationInput): Promise<void> {
    const { lead, qualification } = input;
    if (!this.options.notifyOn.includes(qualification.classification)) return;

    let response: Response;
    try {
      response = await this.fetchImpl(this.options.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blocks: buildBlocks(input) }),
      });
    } catch (cause) {
      throw new NotifierError('Slack webhook request failed', cause);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new NotifierError(`Slack webhook returned ${response.status}: ${detail.slice(0, 200)}`);
    }

    void lead;
  }
}

function buildBlocks(input: NotificationInput) {
  const { lead, qualification, contact, deal, suggestedReply } = input;
  const emoji = EMOJI[qualification.classification];

  const fields = [
    `*Company:*\n${lead.company ?? '—'}`,
    `*Score:*\n${qualification.score}/100`,
    `*Est. value:*\n€${qualification.estimated_value.toLocaleString('en-IE')}`,
    `*Next action:*\n${qualification.next_action.replace(/_/g, ' ')}`,
    `*Industry:*\n${qualification.industry}`,
    `*Headcount:*\n${lead.employees ?? '—'}`,
  ];

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${emoji} ${qualification.classification} lead — ${lead.name}` },
    },
    { type: 'section', fields: fields.map((text) => ({ type: 'mrkdwn', text })) },
    { type: 'section', text: { type: 'mrkdwn', text: `*Why:* ${qualification.reason}` } },
  ];

  if (qualification.signals.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: qualification.signals.map((s) => `> ${s}`).join('\n') },
    });
  }

  if (suggestedReply) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Suggested reply (draft — review before sending):*\n${suggestedReply}` },
    });
  }

  const context: string[] = [`\`${lead.email}\``];
  if (contact) context.push(contact.existing ? `contact ${contact.id} (updated)` : `contact ${contact.id} (new)`);
  if (deal) context.push(deal.existing ? `deal ${deal.id} (existing)` : `deal ${deal.id} (new)`);
  if (qualification.explanation.degraded) context.push('⚠️ scored without AI (degraded mode)');
  if (qualification.explanation.overrode_model) {
    context.push(`rules overrode model (${qualification.explanation.applied_rule})`);
  }

  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: context.join(' · ') }] });
  return blocks;
}
