import type { Lead } from '../domain/lead.js';
import type { LlmAssessment, Qualification } from '../domain/qualification.js';

/**
 * Everything the pipeline needs from a language model. Keeping this narrow is
 * what lets the whole system be tested without a network, and what makes
 * swapping OpenAI for another provider a one-file change.
 */
export interface LlmPort {
  readonly name: string;
  /** Assess a lead. Must either return a schema-valid assessment or throw. */
  assess(lead: Lead, signal?: AbortSignal): Promise<LlmAssessment>;
  /** Draft a reply to the lead. Best-effort: callers tolerate failure. */
  draftReply(lead: Lead, qualification: Qualification, signal?: AbortSignal): Promise<string>;
}
