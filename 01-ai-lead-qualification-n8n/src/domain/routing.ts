import type { Lead } from './lead.js';
import type {
  Classification,
  LlmAssessment,
  NextAction,
  Qualification,
  ScoreAdjustment,
} from './qualification.js';
import {
  BLOCKED_DOMAIN_RULE,
  NEGATIVE_INTENT_RULE,
  applyAdjustments,
  scoreAdjustments,
  type ScoringRules,
} from './scoring.js';

export interface RoutingRules extends ScoringRules {
  hotScoreThreshold: number;
  warmScoreThreshold: number;
}

const NEXT_ACTION_BY_CLASSIFICATION: Record<Classification, NextAction> = {
  HOT: 'sales_call',
  WARM: 'nurture_sequence',
  COLD: 'archive',
};

/**
 * Turns a model assessment into the decision the business acts on.
 *
 * Order matters: hard overrides win over the score, and the budget floor is
 * checked before HOT is awarded — sales does not want a call booked for a lead
 * that cannot buy, however enthusiastic the message was.
 */
export function decide(
  lead: Lead,
  assessment: LlmAssessment,
  rules: RoutingRules,
  options: { degraded?: boolean } = {},
): Qualification {
  const adjustments = scoreAdjustments(lead, rules);
  const score = applyAdjustments(assessment.score, adjustments);

  const { classification, appliedRule } = classify(lead, score, adjustments, rules);

  return {
    score,
    classification,
    next_action: NEXT_ACTION_BY_CLASSIFICATION[classification],
    industry: assessment.industry,
    estimated_value: assessment.estimated_value,
    reason: assessment.reason,
    signals: assessment.signals,
    confidence: assessment.confidence,
    explanation: {
      llm_score: assessment.score,
      llm_suggested_classification: assessment.suggested_classification,
      adjustments,
      applied_rule: appliedRule,
      overrode_model: classification !== assessment.suggested_classification,
      degraded: options.degraded ?? false,
    },
  };
}

function classify(
  lead: Lead,
  score: number,
  adjustments: ScoreAdjustment[],
  rules: RoutingRules,
): { classification: Classification; appliedRule: string } {
  const hardStop = adjustments.find(
    (a) => a.rule === BLOCKED_DOMAIN_RULE || a.rule === NEGATIVE_INTENT_RULE,
  );
  if (hardStop) {
    return { classification: 'COLD', appliedRule: `hard_stop:${hardStop.rule}` };
  }

  if (score >= rules.hotScoreThreshold) {
    const budget = lead.budget ?? 0;
    // An unstated budget is not disqualifying; a stated one below the floor is.
    if (lead.budget !== undefined && budget < rules.minQualifiedBudgetEur) {
      return { classification: 'WARM', appliedRule: 'hot_downgraded_budget_floor' };
    }
    return { classification: 'HOT', appliedRule: 'score_threshold_hot' };
  }

  if (score >= rules.warmScoreThreshold) {
    return { classification: 'WARM', appliedRule: 'score_threshold_warm' };
  }

  return { classification: 'COLD', appliedRule: 'score_threshold_cold' };
}
