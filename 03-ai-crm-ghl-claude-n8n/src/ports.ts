import type { GhlLead } from './domain/lead.js';
import type { ClaudeAssessment, Decision } from './domain/qualification.js';

export interface AssessResult {
  assessment: ClaudeAssessment;
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface AssessorPort {
  readonly name: string;
  assess(lead: GhlLead, signal?: AbortSignal): Promise<AssessResult>;
}

export interface CrmUpdateResult {
  contactId: string;
  /** True when the same values were already on the contact — nothing changed. */
  unchanged: boolean;
  fieldsWritten: string[];
}

export interface CrmPort {
  readonly name: string;
  writeQualification(lead: GhlLead, decision: Decision): Promise<CrmUpdateResult>;
}
