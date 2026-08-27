import { describe, expect, it } from 'vitest';
import { decide } from '../src/domain/routing.js';
import { parseLead } from '../src/pipeline/qualify-lead.js';
import { assessment, blockedDomainLead, coldLead, hotLead, negativeIntentLead, testRules, warmLead } from './fixtures/leads.js';

describe('routing decisions', () => {
  it('routes a high-scoring lead with budget to HOT / sales_call', () => {
    const q = decide(parseLead(hotLead), assessment({ score: 82 }), testRules);
    expect(q.classification).toBe('HOT');
    expect(q.next_action).toBe('sales_call');
    expect(q.explanation.applied_rule).toBe('score_threshold_hot');
  });

  it('routes a mid-scoring lead to WARM / nurture_sequence', () => {
    const q = decide(parseLead(warmLead), assessment({ score: 55, suggested_classification: 'WARM' }), testRules);
    expect(q.classification).toBe('WARM');
    expect(q.next_action).toBe('nurture_sequence');
  });

  it('routes a low-scoring lead to COLD / archive', () => {
    const q = decide(parseLead(coldLead), assessment({ score: 15, suggested_classification: 'COLD' }), testRules);
    expect(q.classification).toBe('COLD');
    expect(q.next_action).toBe('archive');
  });

  it('treats the HOT threshold as inclusive and the value below it as WARM', () => {
    const lead = parseLead({ ...hotLead, budget: 10_000, employees: 50, message: hotLead.message });
    // Adjustments for this lead are zero, so the model score passes through.
    const atThreshold = decide(lead, assessment({ score: 75 }), testRules);
    const belowThreshold = decide(lead, assessment({ score: 74 }), testRules);
    expect(atThreshold.classification).toBe('HOT');
    expect(belowThreshold.classification).toBe('WARM');
  });

  it('downgrades HOT to WARM when a stated budget is below the floor', () => {
    const lead = parseLead({ ...hotLead, budget: 1000 });
    const q = decide(lead, assessment({ score: 95 }), testRules);
    expect(q.classification).toBe('WARM');
    expect(q.explanation.applied_rule).toBe('hot_downgraded_budget_floor');
    expect(q.explanation.overrode_model).toBe(true);
  });

  it('still allows HOT when no budget was stated at all', () => {
    const { budget: _omitted, ...noBudget } = hotLead;
    const q = decide(parseLead(noBudget), assessment({ score: 90 }), testRules);
    expect(q.classification).toBe('HOT');
  });

  it('hard-stops a blocked email domain regardless of the model score', () => {
    const q = decide(parseLead(blockedDomainLead), assessment({ score: 99 }), testRules);
    expect(q.classification).toBe('COLD');
    expect(q.next_action).toBe('archive');
    expect(q.explanation.applied_rule).toBe('hard_stop:blocked_email_domain');
    expect(q.explanation.overrode_model).toBe(true);
  });

  it('hard-stops an explicit opt-out regardless of the model score', () => {
    const q = decide(parseLead(negativeIntentLead), assessment({ score: 88 }), testRules);
    expect(q.classification).toBe('COLD');
    expect(q.explanation.applied_rule).toBe('hard_stop:negative_intent');
  });

  it('records every adjustment so a decision can be explained to sales', () => {
    const lead = parseLead({ name: 'X', email: 'x@gmail.com', message: 'hi', employees: 1 });
    const q = decide(lead, assessment({ score: 60 }), testRules);
    const rules = q.explanation.adjustments.map((a) => a.rule);
    expect(rules).toEqual(
      expect.arrayContaining(['solo_or_tiny', 'free_email_no_company', 'low_effort_message']),
    );
    expect(q.score).toBeLessThan(60);
  });

  it('clamps the final score into 0..100', () => {
    const lead = parseLead({ ...hotLead, budget: 25_000, employees: 500 });
    expect(decide(lead, assessment({ score: 100 }), testRules).score).toBe(100);
    expect(decide(parseLead(coldLead), assessment({ score: 0 }), testRules).score).toBe(0);
  });
});
