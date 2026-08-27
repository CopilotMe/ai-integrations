import type { Lead } from './lead.js';
import { emailDomain, isFreeEmailDomain } from './lead.js';
import type { ScoreAdjustment } from './qualification.js';

export interface ScoringRules {
  minQualifiedBudgetEur: number;
  highBudgetEur: number;
  blockedEmailDomains: string[];
}

/** Signals that the sender does not want to be sold to. */
const NEGATIVE_INTENT = [
  /\bunsubscribe\b/i,
  /\bnot interested\b/i,
  /\bstop (?:emailing|contacting)\b/i,
  /\bremove me\b/i,
];

/** Cheap, unambiguous spam markers. Anything subtler is left to the model. */
const SPAM_MARKERS = [/\bseo services\b/i, /\bguest post\b/i, /\bbacklinks?\b/i, /\bcrypto giveaway\b/i];

export const BLOCKED_DOMAIN_RULE = 'blocked_email_domain';
export const NEGATIVE_INTENT_RULE = 'negative_intent';

/**
 * Deterministic adjustments layered on top of the model's score.
 *
 * These encode facts the model should not be trusted to weigh consistently
 * across runs: contractual budget floors, the blocklist, and obvious spam.
 * Every adjustment is returned so the decision can be explained after the fact.
 */
export function scoreAdjustments(lead: Lead, rules: ScoringRules): ScoreAdjustment[] {
  const adjustments: ScoreAdjustment[] = [];
  const domain = emailDomain(lead.email);

  if (rules.blockedEmailDomains.includes(domain)) {
    adjustments.push({ rule: BLOCKED_DOMAIN_RULE, delta: -100 });
  }

  if (NEGATIVE_INTENT.some((re) => re.test(lead.message))) {
    adjustments.push({ rule: NEGATIVE_INTENT_RULE, delta: -100 });
  }

  if (SPAM_MARKERS.some((re) => re.test(lead.message))) {
    adjustments.push({ rule: 'spam_marker', delta: -40 });
  }

  if (lead.budget !== undefined && lead.budget >= rules.highBudgetEur) {
    adjustments.push({ rule: 'high_budget', delta: 10 });
  }

  if (lead.budget !== undefined && lead.budget > 0 && lead.budget < rules.minQualifiedBudgetEur) {
    adjustments.push({ rule: 'below_budget_floor', delta: -20 });
  }

  if (lead.employees !== undefined && lead.employees >= 100) {
    adjustments.push({ rule: 'enterprise_headcount', delta: 5 });
  }

  // The ICP starts at 50 employees. A stated headcount far below it is a real
  // signal; an unstated one is not, so this only fires when we were told.
  // Sized to be able to block a sales call without archiving the lead outright:
  // a small company with a genuine need still deserves a nurture sequence.
  if (lead.employees !== undefined && lead.employees < 20) {
    adjustments.push({ rule: 'below_icp_headcount', delta: -8 });
  }

  if (lead.employees !== undefined && lead.employees <= 2) {
    adjustments.push({ rule: 'solo_or_tiny', delta: -10 });
  }

  if (isFreeEmailDomain(lead.email) && !lead.company) {
    adjustments.push({ rule: 'free_email_no_company', delta: -15 });
  }

  if (lead.message.length < 25) {
    adjustments.push({ rule: 'low_effort_message', delta: -10 });
  }

  return adjustments;
}

export function applyAdjustments(baseScore: number, adjustments: ScoreAdjustment[]): number {
  const total = adjustments.reduce((sum, a) => sum + a.delta, baseScore);
  return clamp(Math.round(total), 0, 100);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Fallback used when the model is unreachable or keeps returning unusable
 * output. It is intentionally crude — its job is to keep the pipeline moving
 * and get a human to look at the lead, not to be accurate.
 */
export function heuristicBaseScore(lead: Lead): number {
  let score = 40;
  if (lead.company) score += 10;
  if (!isFreeEmailDomain(lead.email)) score += 10;
  if (lead.budget !== undefined) score += lead.budget >= 25_000 ? 15 : 5;
  if (lead.employees !== undefined) score += lead.employees >= 50 ? 10 : 0;
  if (lead.message.length > 120) score += 5;
  return clamp(score, 0, 100);
}
