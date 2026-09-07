import type { ActionType, Classification, InboundMessage, Intent } from '../domain/types';

/**
 * How much damage an action does if it turns out to be wrong.
 *
 * This is the axis that actually matters, and it is a property of the *action*,
 * not of the model's confidence. Creating a ticket for a message that did not
 * need one wastes a minute of someone's time. Refunding a customer who did not
 * ask for a refund is money out of the door, and refunding the wrong customer
 * is money out of the door twice.
 */
export const BLAST_RADIUS = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
} as const;

export type BlastRadius = keyof typeof BLAST_RADIUS;

export const ACTION_BLAST_RADIUS: Record<ActionType, BlastRadius> = {
  no_action: 'none',
  create_ticket: 'low',
  escalate_to_human: 'low',
  send_templated_reply: 'medium', // leaves the building, in our name
  update_account: 'high',
  cancel_subscription: 'high',
  issue_refund: 'high',
};

/**
 * Confidence required to act without asking, per blast radius.
 *
 * `high` is set to 1.01 — deliberately unreachable. Refunds, cancellations and
 * account changes always go to a human in this configuration, however sure the
 * model is. That is a policy choice, not a technical limit: it is one number
 * per row, and the point of putting it here is that changing it is a visible,
 * reviewable act rather than an emergent property of a prompt.
 */
export interface AutonomyThresholds {
  none: number;
  low: number;
  medium: number;
  high: number;
}

export const DEFAULT_THRESHOLDS: AutonomyThresholds = {
  none: 0.5,
  low: 0.75,
  medium: 0.9,
  high: 1.01,
};

export interface PolicyConfig {
  thresholds: AutonomyThresholds;
  /** Refunds above this never auto-execute, whatever the thresholds say. */
  refundAutoApproveCapEur: number;
  /** Domains whose messages always reach a human. */
  vipDomains: string[];
  /** Intents that always reach a human, regardless of the proposed action. */
  alwaysReviewIntents: Intent[];
  /** Below this, we do not trust the classification enough to act on it at all. */
  minimumConfidence: number;
}

export const DEFAULT_POLICY: PolicyConfig = {
  thresholds: DEFAULT_THRESHOLDS,
  refundAutoApproveCapEur: 0,
  vipDomains: [],
  alwaysReviewIntents: ['complaint', 'cancellation'],
  minimumConfidence: 0.4,
};

export type Verdict = 'auto_execute' | 'require_approval';

export interface PolicyRule {
  rule: string;
  /** Human-readable, and shown verbatim to the operator reviewing the case. */
  detail: string;
}

export interface PolicyDecision {
  verdict: Verdict;
  action: ActionType;
  blastRadius: BlastRadius;
  requiredConfidence: number;
  actualConfidence: number;
  /** Every rule that fired. Empty when the action cleared on confidence alone. */
  triggered: PolicyRule[];
  /** The single rule that decided the outcome. */
  decidedBy: string;
}

/**
 * Decides whether the assistant may execute its proposed action, or must ask.
 *
 * Deterministic and pure: same inputs, same verdict, no I/O. That is what lets
 * it be exhaustively tested, explained to a non-engineer, and replayed against
 * a historical case to answer "would today's policy have done the same thing".
 *
 * Order is deliberate — hard stops are evaluated before the confidence check,
 * so a rule can never be argued out of by a confident model.
 */
export function evaluatePolicy(
  message: InboundMessage,
  classification: Classification,
  config: PolicyConfig = DEFAULT_POLICY,
): PolicyDecision {
  const action = classification.proposed_action;
  const blastRadius = ACTION_BLAST_RADIUS[action];
  const requiredConfidence = config.thresholds[blastRadius];
  const triggered: PolicyRule[] = [];

  const domain = emailDomain(message.from_email);

  if (config.vipDomains.includes(domain)) {
    triggered.push({
      rule: 'vip_domain',
      detail: `${domain} is a VIP account — every message is reviewed by a person.`,
    });
  }

  if (config.alwaysReviewIntents.includes(classification.intent)) {
    triggered.push({
      rule: 'always_review_intent',
      detail: `Intent "${classification.intent}" always goes to a human, whatever action is proposed.`,
    });
  }

  if (classification.confidence < config.minimumConfidence) {
    triggered.push({
      rule: 'below_minimum_confidence',
      detail: `Confidence ${classification.confidence.toFixed(2)} is below the floor of ${config.minimumConfidence} — the classification itself is not trusted.`,
    });
  }

  if (classification.needs_translation) {
    triggered.push({
      rule: 'needs_translation',
      detail: 'The message is not in a language the templates cover, so a reply cannot be sent unreviewed.',
    });
  }

  if (action === 'issue_refund') {
    const amount = classification.refund_amount_eur;
    if (amount === null) {
      triggered.push({
        rule: 'refund_without_amount',
        detail: 'A refund was proposed without an amount. Nothing is executed on an incomplete instruction.',
      });
    } else if (amount > config.refundAutoApproveCapEur) {
      triggered.push({
        rule: 'refund_above_cap',
        detail: `Refund of EUR ${amount.toLocaleString('en-IE')} exceeds the auto-approval cap of EUR ${config.refundAutoApproveCapEur.toLocaleString('en-IE')}.`,
      });
    }
  }

  if (action === 'send_templated_reply' && !classification.template_key) {
    triggered.push({
      rule: 'reply_without_template',
      detail: 'A templated reply was proposed without naming a template.',
    });
  }

  if (triggered.length > 0) {
    return {
      verdict: 'require_approval',
      action,
      blastRadius,
      requiredConfidence,
      actualConfidence: classification.confidence,
      triggered,
      decidedBy: triggered[0]!.rule,
    };
  }

  if (classification.confidence < requiredConfidence) {
    const rule: PolicyRule = {
      rule: 'below_action_threshold',
      detail:
        requiredConfidence > 1
          ? `Actions with ${blastRadius} blast radius are never executed automatically in this configuration.`
          : `Confidence ${classification.confidence.toFixed(2)} is below the ${requiredConfidence} required for a ${blastRadius}-blast-radius action.`,
    };
    return {
      verdict: 'require_approval',
      action,
      blastRadius,
      requiredConfidence,
      actualConfidence: classification.confidence,
      triggered: [rule],
      decidedBy: rule.rule,
    };
  }

  return {
    verdict: 'auto_execute',
    action,
    blastRadius,
    requiredConfidence,
    actualConfidence: classification.confidence,
    triggered: [],
    decidedBy: 'cleared_threshold',
  };
}

/** One sentence an operator can read without knowing how any of this works. */
export function explainDecision(decision: PolicyDecision): string {
  if (decision.verdict === 'auto_execute') {
    return `Executed automatically: "${decision.action}" has ${decision.blastRadius} blast radius and confidence ${decision.actualConfidence.toFixed(2)} cleared the ${decision.requiredConfidence} threshold.`;
  }
  return `Held for approval: ${decision.triggered[0]?.detail ?? 'policy required review.'}`;
}

function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}
