import { z } from 'zod';

export const QUALIFICATIONS = ['hot', 'warm', 'cold'] as const;
export type Qualification = (typeof QUALIFICATIONS)[number];

export const NEXT_ACTIONS = ['sales_call', 'nurture_sequence', 'archive'] as const;
export type NextAction = (typeof NEXT_ACTIONS)[number];

export const ROUTES = ['sales', 'nurture', 'low_priority'] as const;
export type Route = (typeof ROUTES)[number];

/**
 * What Claude is allowed to return.
 *
 * `qualification` is the model's *opinion* and is recorded, but it does not
 * select the route — `policy/routing.ts` does that from `lead_score` and
 * `confidence`. Keeping the model's label in the payload is what makes
 * disagreement between the two measurable.
 */
export const ClaudeAssessmentSchema = z.object({
  lead_score: z.number().int().min(0).max(100),
  qualification: z.enum(QUALIFICATIONS),
  reason: z.string().trim().min(1).max(400),
  next_action: z.enum(NEXT_ACTIONS),
  confidence: z.number().min(0).max(1),
  /** Verbatim quotes from the inquiry that justify the score. */
  signals: z.array(z.string().trim().min(1).max(200)).max(5).default([]),
  industry: z.string().trim().min(1).max(60),
});

export type ClaudeAssessment = z.infer<typeof ClaudeAssessmentSchema>;

/**
 * JSON Schema for the Messages API `output_config.format`.
 *
 * Must be kept in step with the zod schema above — the API constrains
 * generation to this, and zod re-validates what comes back. Both, not either:
 * a provider honouring its own schema is not a reason to skip validation at a
 * trust boundary.
 */
export const CLAUDE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lead_score', 'qualification', 'reason', 'next_action', 'confidence', 'signals', 'industry'],
  properties: {
    lead_score: { type: 'integer', minimum: 0, maximum: 100 },
    qualification: { type: 'string', enum: [...QUALIFICATIONS] },
    reason: { type: 'string' },
    next_action: { type: 'string', enum: [...NEXT_ACTIONS] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    signals: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    industry: { type: 'string' },
  },
} as const;

export interface RoutingRule {
  rule: string;
  detail: string;
}

/** The authoritative outcome for a lead. */
export interface Decision {
  route: Route;
  qualification: Qualification;
  next_action: NextAction;
  lead_score: number;
  confidence: number;
  reason: string;
  signals: string[];
  industry: string;
  explanation: {
    /** What the model called it, which may differ from `qualification`. */
    model_qualification: Qualification;
    model_next_action: NextAction;
    applied_rule: string;
    triggered: RoutingRule[];
    /** True when the deterministic rules disagreed with the model's label. */
    overrode_model: boolean;
  };
}
