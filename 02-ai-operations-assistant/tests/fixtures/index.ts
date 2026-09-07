import type { Classification, InboundMessage } from '@/core/domain/types';
import { DEFAULT_POLICY, type PolicyConfig } from '@/core/policy/autonomy';

export function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    external_id: `ext-${Math.random().toString(36).slice(2, 10)}`,
    source: 'test',
    from_email: 'customer@acme.co',
    to_email: 'support@example.com',
    subject: 'Question about my invoice',
    body: 'Hello, I have a question about invoice 4471. Could you confirm the VAT treatment?',
    ...overrides,
  };
}

export function classification(overrides: Partial<Classification> = {}): Classification {
  return {
    intent: 'billing_question',
    urgency: 'normal',
    confidence: 0.95,
    summary: 'Billing question about VAT on invoice 4471',
    evidence: ['Could you confirm the VAT treatment?'],
    proposed_action: 'create_ticket',
    refund_amount_eur: null,
    template_key: null,
    reasoning: 'Clear billing question with an invoice reference.',
    needs_translation: false,
    ...overrides,
  };
}

export function policy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return { ...DEFAULT_POLICY, ...overrides };
}
