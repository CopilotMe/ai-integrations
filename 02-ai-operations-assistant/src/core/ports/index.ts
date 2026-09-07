import type { ActionType, Classification, InboundMessage } from '../domain/types';

export interface ClassifyResult {
  classification: Classification;
  model: string;
  promptVersion: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  /** True when the model was unavailable and a heuristic produced this. */
  degraded: boolean;
}

export interface ClassifierPort {
  readonly name: string;
  classify(message: InboundMessage, signal?: AbortSignal): Promise<ClassifyResult>;
}

export interface ExecuteActionInput {
  caseId: string;
  action: ActionType;
  message: InboundMessage;
  classification: Classification;
  /** Same key ⇒ same side effect. Executors must honour it. */
  idempotencyKey: string;
  refundAmountEur?: number | null;
  templateKey?: string | null;
}

export interface ExecuteActionResult {
  externalRef: string | null;
  response: Record<string, unknown>;
}

/** Downstream system that actually does the thing — ticketing, billing, CRM. */
export interface ActionExecutorPort {
  readonly name: string;
  supports(action: ActionType): boolean;
  execute(input: ExecuteActionInput): Promise<ExecuteActionResult>;
}

export interface NotificationInput {
  caseId: string;
  kind: 'approval_requested' | 'action_executed' | 'action_failed';
  subject: string;
  summary: string;
  action: ActionType;
  /** Deep link into the admin UI for this case. */
  url: string;
  detail?: Record<string, unknown>;
}

export interface NotifierPort {
  readonly name: string;
  notify(input: NotificationInput): Promise<void>;
}
