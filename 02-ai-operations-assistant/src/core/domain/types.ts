import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Inbound message                                                            */
/* -------------------------------------------------------------------------- */

export const InboundMessageSchema = z.object({
  /** Provider's message id (Gmail, Postmark, IMAP UID). Used for deduplication. */
  external_id: z.string().trim().min(1).max(400),
  from_email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  from_name: z.string().trim().max(200).optional(),
  to_email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  subject: z.string().trim().max(500).default(''),
  body: z.string().trim().min(1).max(50_000),
  received_at: z.iso.datetime({ offset: true }).optional(),
  /** Where it came from — `n8n:gmail`, `postmark`, `manual`. */
  source: z.string().trim().max(60).default('unknown'),
  headers: z.record(z.string(), z.string()).optional(),
});

export type InboundMessage = z.infer<typeof InboundMessageSchema>;

/* -------------------------------------------------------------------------- */
/* What the model is allowed to say                                           */
/* -------------------------------------------------------------------------- */

export const INTENTS = [
  'billing_question',
  'refund_request',
  'technical_issue',
  'account_change',
  'cancellation',
  'complaint',
  'sales_enquiry',
  'spam',
  'other',
] as const;
export type Intent = (typeof INTENTS)[number];

export const URGENCIES = ['low', 'normal', 'high', 'critical'] as const;
export type Urgency = (typeof URGENCIES)[number];

/**
 * Actions the assistant can propose.
 *
 * This list is closed on purpose. An open-ended "what should we do" from a
 * model is not something you can write a policy against, attach a blast radius
 * to, or audit. Adding an action is a deliberate change to this file plus the
 * policy that governs it.
 */
export const ACTION_TYPES = [
  'no_action',
  'create_ticket',
  'send_templated_reply',
  'escalate_to_human',
  'issue_refund',
  'cancel_subscription',
  'update_account',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const ClassificationSchema = z.object({
  intent: z.enum(INTENTS),
  urgency: z.enum(URGENCIES),
  /** The model's own confidence in its reading of the message, 0..1. */
  confidence: z.number().min(0).max(1),
  summary: z.string().trim().min(1).max(400),
  /** Verbatim quotes justifying the classification. */
  evidence: z.array(z.string().trim().min(1).max(300)).max(6).default([]),
  proposed_action: z.enum(ACTION_TYPES),
  /** Populated only for refunds. EUR. */
  refund_amount_eur: z.number().min(0).max(1_000_000).nullable().default(null),
  /** Which reply template, when the proposed action is a templated reply. */
  template_key: z.string().trim().max(80).nullable().default(null),
  reasoning: z.string().trim().min(1).max(600),
  /** Message is not in the operator's language, or is unintelligible. */
  needs_translation: z.boolean().default(false),
});

export type Classification = z.infer<typeof ClassificationSchema>;

/** JSON Schema handed to the structured-output API. Change with the zod schema above. */
export const CLASSIFICATION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'intent',
    'urgency',
    'confidence',
    'summary',
    'evidence',
    'proposed_action',
    'refund_amount_eur',
    'template_key',
    'reasoning',
    'needs_translation',
  ],
  properties: {
    intent: { type: 'string', enum: [...INTENTS] },
    urgency: { type: 'string', enum: [...URGENCIES] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    summary: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' }, maxItems: 6 },
    proposed_action: { type: 'string', enum: [...ACTION_TYPES] },
    refund_amount_eur: { type: ['number', 'null'], minimum: 0 },
    template_key: { type: ['string', 'null'] },
    reasoning: { type: 'string' },
    needs_translation: { type: 'boolean' },
  },
} as const;

/* -------------------------------------------------------------------------- */
/* Case lifecycle                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A case is one inbound message and everything that happened to it.
 *
 * States are explicit rather than a set of booleans because the whole product
 * is "what happened to this message, and who said so" — and a boolean soup
 * cannot answer that.
 */
export const CASE_STATES = [
  'received',
  'classified',
  'pending_approval',
  'approved',
  'rejected',
  'executing',
  'executed',
  'failed',
  'dead_lettered',
] as const;
export type CaseState = (typeof CASE_STATES)[number];

/** Terminal states: nothing further happens without human intervention. */
export const TERMINAL_STATES: readonly CaseState[] = ['executed', 'rejected', 'dead_lettered'];

/**
 * Legal transitions. Anything not listed here is a bug, and
 * `assertTransition` turns it into a loud one rather than a corrupt row.
 */
const TRANSITIONS: Record<CaseState, readonly CaseState[]> = {
  received: ['classified', 'failed', 'dead_lettered'],
  classified: ['pending_approval', 'approved', 'executing', 'failed'],
  pending_approval: ['approved', 'rejected', 'dead_lettered'],
  approved: ['executing', 'failed'],
  rejected: [],
  executing: ['executed', 'failed'],
  executed: [],
  // A failure is retryable: it can be re-classified or re-executed.
  failed: ['classified', 'executing', 'dead_lettered'],
  dead_lettered: ['classified'],
};

export function canTransition(from: CaseState, to: CaseState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  readonly code = 'illegal_transition';
  constructor(
    readonly from: CaseState,
    readonly to: CaseState,
  ) {
    super(
      `Illegal case transition ${from} → ${to}. Legal from ${from}: ${
        TRANSITIONS[from].join(', ') || '(terminal)'
      }`,
    );
    this.name = 'IllegalTransitionError';
  }
}

export function assertTransition(from: CaseState, to: CaseState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/* -------------------------------------------------------------------------- */
/* Audit                                                                      */
/* -------------------------------------------------------------------------- */

export const AUDIT_EVENTS = [
  'message.received',
  'message.duplicate_ignored',
  'classification.succeeded',
  'classification.failed',
  'classification.degraded',
  'policy.evaluated',
  'approval.requested',
  'approval.granted',
  'approval.denied',
  'action.started',
  'action.succeeded',
  'action.failed',
  'case.dead_lettered',
  'case.reclassified',
  'auth.login_succeeded',
  'auth.login_failed',
] as const;
export type AuditEvent = (typeof AUDIT_EVENTS)[number];

/**
 * Who did a thing. Every audit row has one, and "the system" is a distinct
 * actor from a person — the first question anyone asks about an automated
 * decision is whether a human was involved.
 */
export type Actor =
  | { kind: 'system' }
  | { kind: 'operator'; id: string; email: string }
  | { kind: 'api_key'; id: string; name: string };

export function actorLabel(actor: Actor): string {
  switch (actor.kind) {
    case 'system':
      return 'system';
    case 'operator':
      return actor.email;
    case 'api_key':
      return `api-key:${actor.name}`;
  }
}
