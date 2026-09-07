import { describe, expect, it } from 'vitest';
import { ACTION_BLAST_RADIUS, evaluatePolicy, explainDecision } from '@/core/policy/autonomy';
import { ACTION_TYPES } from '@/core/domain/types';
import { classification, message, policy } from './fixtures';

describe('blast radius', () => {
  it('assigns a radius to every action type — a new action cannot slip through unclassified', () => {
    for (const action of ACTION_TYPES) {
      expect(ACTION_BLAST_RADIUS[action]).toBeDefined();
    }
  });

  it('rates money-moving and account-changing actions as high', () => {
    expect(ACTION_BLAST_RADIUS.issue_refund).toBe('high');
    expect(ACTION_BLAST_RADIUS.cancel_subscription).toBe('high');
    expect(ACTION_BLAST_RADIUS.update_account).toBe('high');
  });

  it('rates a customer-facing reply above an internal ticket', () => {
    expect(ACTION_BLAST_RADIUS.send_templated_reply).toBe('medium');
    expect(ACTION_BLAST_RADIUS.create_ticket).toBe('low');
  });
});

describe('autonomy policy', () => {
  it('auto-executes a confident, low-blast-radius action', () => {
    const decision = evaluatePolicy(message(), classification({ confidence: 0.9 }), policy());
    expect(decision.verdict).toBe('auto_execute');
    expect(decision.decidedBy).toBe('cleared_threshold');
    expect(decision.triggered).toEqual([]);
  });

  it('holds a low-blast action whose confidence is under the threshold', () => {
    const decision = evaluatePolicy(message(), classification({ confidence: 0.7 }), policy());
    expect(decision.verdict).toBe('require_approval');
    expect(decision.decidedBy).toBe('below_action_threshold');
  });

  it('treats the threshold as inclusive', () => {
    const rules = policy();
    const at = evaluatePolicy(message(), classification({ confidence: rules.thresholds.low }), rules);
    const below = evaluatePolicy(message(), classification({ confidence: rules.thresholds.low - 0.001 }), rules);
    expect(at.verdict).toBe('auto_execute');
    expect(below.verdict).toBe('require_approval');
  });

  it('never auto-executes a refund at the default configuration, however confident', () => {
    const decision = evaluatePolicy(
      message(),
      classification({ proposed_action: 'issue_refund', refund_amount_eur: 10, confidence: 1 }),
      policy(),
    );
    expect(decision.verdict).toBe('require_approval');
    expect(decision.blastRadius).toBe('high');
  });

  it('holds a refund above the auto-approval cap', () => {
    const decision = evaluatePolicy(
      message(),
      classification({ proposed_action: 'issue_refund', refund_amount_eur: 500, confidence: 1 }),
      policy({ refundAutoApproveCapEur: 100, thresholds: { none: 0.5, low: 0.7, medium: 0.8, high: 0.9 } }),
    );
    expect(decision.verdict).toBe('require_approval');
    expect(decision.decidedBy).toBe('refund_above_cap');
  });

  it('auto-executes a refund under the cap when the configuration permits it', () => {
    const decision = evaluatePolicy(
      message(),
      classification({ proposed_action: 'issue_refund', refund_amount_eur: 20, confidence: 0.99 }),
      policy({ refundAutoApproveCapEur: 100, thresholds: { none: 0.5, low: 0.7, medium: 0.8, high: 0.9 } }),
    );
    expect(decision.verdict).toBe('auto_execute');
  });

  it('refuses a refund with no amount rather than guessing one', () => {
    const decision = evaluatePolicy(
      message(),
      classification({ proposed_action: 'issue_refund', refund_amount_eur: null, confidence: 1 }),
      policy({ refundAutoApproveCapEur: 10_000, thresholds: { none: 0.5, low: 0.7, medium: 0.8, high: 0.9 } }),
    );
    expect(decision.decidedBy).toBe('refund_without_amount');
  });

  it('holds every message from a VIP domain, whatever the action', () => {
    const decision = evaluatePolicy(
      message({ from_email: 'cfo@bigclient.com' }),
      classification({ confidence: 1, proposed_action: 'no_action' }),
      policy({ vipDomains: ['bigclient.com'] }),
    );
    expect(decision.verdict).toBe('require_approval');
    expect(decision.decidedBy).toBe('vip_domain');
  });

  it('holds always-review intents even when the action is harmless', () => {
    const decision = evaluatePolicy(
      message(),
      classification({ intent: 'complaint', proposed_action: 'create_ticket', confidence: 1 }),
      policy(),
    );
    expect(decision.decidedBy).toBe('always_review_intent');
  });

  it('holds anything below the minimum confidence floor', () => {
    const decision = evaluatePolicy(message(), classification({ confidence: 0.2 }), policy());
    expect(decision.decidedBy).toBe('below_minimum_confidence');
  });

  it('holds a message that needs translation', () => {
    const decision = evaluatePolicy(
      message(),
      classification({ needs_translation: true, confidence: 1 }),
      policy(),
    );
    expect(decision.decidedBy).toBe('needs_translation');
  });

  it('refuses a templated reply with no template named', () => {
    const decision = evaluatePolicy(
      message(),
      classification({ proposed_action: 'send_templated_reply', template_key: null, confidence: 1 }),
      policy(),
    );
    expect(decision.decidedBy).toBe('reply_without_template');
  });

  it('evaluates hard stops before the confidence check, so confidence cannot override a rule', () => {
    const decision = evaluatePolicy(
      message({ from_email: 'a@vip.com' }),
      classification({ confidence: 1.0, proposed_action: 'create_ticket' }),
      policy({ vipDomains: ['vip.com'] }),
    );
    expect(decision.decidedBy).toBe('vip_domain');
    expect(decision.decidedBy).not.toBe('below_action_threshold');
  });

  it('reports every rule that fired, not only the deciding one', () => {
    const decision = evaluatePolicy(
      message({ from_email: 'a@vip.com' }),
      classification({ intent: 'complaint', confidence: 0.1, needs_translation: true }),
      policy({ vipDomains: ['vip.com'] }),
    );
    expect(decision.triggered.map((t) => t.rule)).toEqual([
      'vip_domain',
      'always_review_intent',
      'below_minimum_confidence',
      'needs_translation',
    ]);
  });

  it('is a pure function: same inputs, same verdict', () => {
    const [m, c, p] = [message(), classification({ confidence: 0.62 }), policy()];
    expect(evaluatePolicy(m, c, p)).toEqual(evaluatePolicy(m, c, p));
  });

  it('explains itself in a sentence an operator can read', () => {
    const held = evaluatePolicy(message(), classification({ intent: 'complaint' }), policy());
    const auto = evaluatePolicy(message(), classification({ confidence: 0.99 }), policy());
    expect(explainDecision(held)).toMatch(/Held for approval/);
    expect(explainDecision(auto)).toMatch(/Executed automatically/);
  });
});
