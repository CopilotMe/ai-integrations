import { z } from 'zod';

export const CLASSIFICATIONS = ['HOT', 'WARM', 'COLD'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const NEXT_ACTIONS = ['sales_call', 'nurture_sequence', 'archive'] as const;
export type NextAction = (typeof NEXT_ACTIONS)[number];

/**
 * What we allow the model to return.
 *
 * Deliberately *not* the final decision: the model contributes an assessment
 * (score, industry, value, signals) and a non-binding opinion on the
 * classification. Routing is decided by `domain/routing.ts` so that the
 * business outcome stays deterministic, reviewable and testable.
 */
export const LlmAssessmentSchema = z.object({
  score: z.number().min(0).max(100),
  suggested_classification: z.enum(CLASSIFICATIONS),
  industry: z.string().trim().min(1).max(60),
  estimated_value: z.number().min(0).max(100_000_000),
  reason: z.string().trim().min(1).max(400),
  signals: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
  confidence: z.number().min(0).max(1),
});

export type LlmAssessment = z.infer<typeof LlmAssessmentSchema>;

/** JSON Schema handed to the OpenAI structured-output API. Kept next to the
 *  zod schema on purpose — they must be changed together. */
export const LLM_ASSESSMENT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'score',
    'suggested_classification',
    'industry',
    'estimated_value',
    'reason',
    'signals',
    'confidence',
  ],
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 100 },
    suggested_classification: { type: 'string', enum: [...CLASSIFICATIONS] },
    industry: { type: 'string' },
    estimated_value: { type: 'number', minimum: 0 },
    reason: { type: 'string' },
    signals: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

export interface ScoreAdjustment {
  rule: string;
  delta: number;
}

/** The final, authoritative decision for a lead. */
export interface Qualification {
  score: number;
  classification: Classification;
  next_action: NextAction;
  industry: string;
  estimated_value: number;
  reason: string;
  signals: string[];
  confidence: number;
  /** How the decision was reached — the audit trail. */
  explanation: {
    llm_score: number;
    llm_suggested_classification: Classification;
    adjustments: ScoreAdjustment[];
    applied_rule: string;
    /** True when the deterministic rules disagreed with the model. */
    overrode_model: boolean;
    /** True when the model was unavailable and heuristics were used instead. */
    degraded: boolean;
  };
}
