import { emailDomain, type GhlLead } from '../domain/lead.js';
import type { ClaudeAssessment, Decision, Qualification, Route, RoutingRule } from '../domain/qualification.js';

export interface RoutingRules {
  hotScore: number;
  warmScore: number;
  /** A route is only taken if the model is *also* confident enough for it. */
  hotConfidence: number;
  warmConfidence: number;
  blockedEmailDomains: string[];
}

export const DEFAULT_RULES: RoutingRules = {
  hotScore: 80,
  warmScore: 50,
  hotConfidence: 0.8,
  warmConfidence: 0.7,
  blockedEmailDomains: [],
};

const ROUTE_FOR: Record<Qualification, Route> = {
  hot: 'sales',
  warm: 'nurture',
  cold: 'low_priority',
};

const NEXT_ACTION_FOR: Record<Qualification, Decision['next_action']> = {
  hot: 'sales_call',
  warm: 'nurture_sequence',
  cold: 'archive',
};

/**
 * Turns an assessment into the route the CRM acts on.
 *
 * Two gates, not one. Score says *how good the lead looks*; confidence says
 * *how much the model's reading of it can be relied on*. A score of 95 at
 * confidence 0.4 is not a hot lead — it is an uncertain guess about one, and
 * booking a salesperson on it is the expensive mistake.
 *
 * The rule, in one sentence: **a lead must clear both the score and the
 * confidence gate for its tier; if it clears the score but not the confidence
 * it drops exactly one tier, never straight to archive.**
 *
 * That last clause is deliberate and is the asymmetry the whole design turns
 * on. A sales call costs a person an hour; a nurture sequence costs almost
 * nothing and keeps the lead alive; archiving is the only irreversible outcome.
 * So low confidence is allowed to block an escalation, but never to throw a
 * lead away — that decision belongs to the score alone.
 *
 * Pure and deterministic: same inputs, same route, no I/O. That is what makes
 * it exhaustively testable and explainable to the person whose pipeline it fills.
 */
export function route(lead: GhlLead, assessment: ClaudeAssessment, rules: RoutingRules = DEFAULT_RULES): Decision {
  const triggered: RoutingRule[] = [];
  const domain = emailDomain(lead.email);

  const blocked = rules.blockedEmailDomains.includes(domain);
  if (blocked) {
    triggered.push({
      rule: 'blocked_email_domain',
      detail: `${domain} is on the blocklist — never routed to sales, whatever the score.`,
    });
  }

  const { qualification, appliedRule } = classify(assessment, rules, blocked, triggered);

  return {
    route: ROUTE_FOR[qualification],
    qualification,
    next_action: NEXT_ACTION_FOR[qualification],
    lead_score: assessment.lead_score,
    confidence: assessment.confidence,
    reason: assessment.reason,
    signals: assessment.signals,
    industry: assessment.industry,
    explanation: {
      model_qualification: assessment.qualification,
      model_next_action: assessment.next_action,
      applied_rule: appliedRule,
      triggered,
      overrode_model: qualification !== assessment.qualification,
    },
  };
}

function classify(
  assessment: ClaudeAssessment,
  rules: RoutingRules,
  blocked: boolean,
  triggered: RoutingRule[],
): { qualification: Qualification; appliedRule: string } {
  if (blocked) return { qualification: 'cold', appliedRule: 'hard_stop:blocked_email_domain' };

  const { lead_score: score, confidence } = assessment;

  if (score >= rules.hotScore) {
    if (confidence >= rules.hotConfidence) {
      return { qualification: 'hot', appliedRule: 'hot_score_and_confidence' };
    }
    // Scores hot, but the model is not sure enough to spend a salesperson on
    // it. One tier down — nurture is cheap and keeps the lead alive.
    triggered.push({
      rule: 'hot_downgraded_low_confidence',
      detail: `Score ${score} clears the hot threshold, but confidence ${confidence.toFixed(2)} is below ${rules.hotConfidence} — routed to nurture instead of sales.`,
    });
    return { qualification: 'warm', appliedRule: 'hot_downgraded_low_confidence' };
  }

  if (score >= rules.warmScore) {
    if (confidence >= rules.warmConfidence) {
      return { qualification: 'warm', appliedRule: 'warm_score_and_confidence' };
    }
    triggered.push({
      rule: 'warm_downgraded_low_confidence',
      detail: `Score ${score} clears the warm threshold, but confidence ${confidence.toFixed(2)} is below ${rules.warmConfidence} — held at low priority for a human to look at.`,
    });
    return { qualification: 'cold', appliedRule: 'warm_downgraded_low_confidence' };
  }

  return { qualification: 'cold', appliedRule: 'score_below_warm_threshold' };
}

/** One sentence for the CRM note and the log. */
export function explain(decision: Decision): string {
  const base = `Score ${decision.lead_score}, confidence ${decision.confidence.toFixed(2)} → ${decision.route}.`;
  const first = decision.explanation.triggered[0];
  return first ? `${base} ${first.detail}` : base;
}
