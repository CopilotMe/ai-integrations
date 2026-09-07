import { createHash } from 'node:crypto';
import type { Database } from '../../db/client';
import {
  appendAudit,
  claimAction,
  completeAction,
  createCaseForMessage,
  getCase,
  insertClassification,
  insertPolicyDecision,
  transitionCase,
} from '../../db/repositories';
import { ClassifierError, ConflictError, NotFoundError } from '../../lib/errors';
import type { Logger } from '../../lib/logger';
import { withRetry, withTimeout, type RetryOptions } from '../../lib/retry';
import type { Actor, CaseState, Classification, InboundMessage } from '../domain/types';
import { assertTransition } from '../domain/types';
import { evaluatePolicy, explainDecision, type PolicyConfig, type PolicyDecision } from '../policy/autonomy';
import type { ActionExecutorPort, ClassifierPort, NotifierPort } from '../ports/index';

export interface PipelineDeps {
  db: Database;
  classifier: ClassifierPort;
  executor: ActionExecutorPort;
  notifier: NotifierPort;
  policy: PolicyConfig;
  logger: Logger;
  appUrl: string;
  llmTimeoutMs: number;
  llmMaxRetries: number;
  retryOverrides?: Partial<RetryOptions>;
}

export interface IntakeResult {
  caseId: string;
  state: CaseState;
  duplicate: boolean;
  classification: Classification | null;
  decision: PolicyDecision | null;
  /** Present when the action ran without asking anyone. */
  executedRef?: string | null;
}

/**
 * The whole inbound path: receive → classify → apply policy → execute or ask.
 *
 * Ordering is deliberate. The message and case are committed *before* the model
 * is called, so a classification failure leaves a durable case someone can see
 * and retry — rather than a lost email and a 500.
 */
export async function processInboundMessage(
  message: InboundMessage,
  actor: Actor,
  correlationId: string,
  deps: PipelineDeps,
): Promise<IntakeResult> {
  const { db, logger } = deps;

  const { case: caseRow, duplicate } = await createCaseForMessage(
    db,
    {
      externalId: message.external_id,
      source: message.source,
      fromEmail: message.from_email,
      fromName: message.from_name,
      toEmail: message.to_email,
      subject: message.subject,
      body: message.body,
      headers: message.headers,
      receivedAt: message.received_at ? new Date(message.received_at) : undefined,
    },
    actor,
    correlationId,
  );

  if (duplicate) {
    logger.info({ correlationId, caseId: caseRow.id }, 'duplicate message ignored');
    return { caseId: caseRow.id, state: caseRow.state, duplicate: true, classification: null, decision: null };
  }

  return runClassificationAndPolicy(caseRow.id, caseRow.version, message, actor, correlationId, deps);
}

/**
 * Classify, apply the policy, and either execute or park for approval.
 *
 * Shared by first intake and by an operator asking for re-classification, so
 * the two paths cannot drift apart in what they decide or what they record.
 */
export async function runClassificationAndPolicy(
  caseId: string,
  expectedVersion: number,
  message: InboundMessage,
  actor: Actor,
  correlationId: string,
  deps: PipelineDeps,
): Promise<IntakeResult> {
  const { db, logger, policy } = deps;

  let result: Awaited<ReturnType<ClassifierPort['classify']>>;
  try {
    result = await withRetry(
      () =>
        withTimeout(
          deps.llmTimeoutMs,
          (signal) => deps.classifier.classify(message, signal),
          () => new ClassifierError(`Classification exceeded ${deps.llmTimeoutMs}ms`),
        ),
      {
        retries: deps.llmMaxRetries,
        isRetryable: (error) => (error as { retryable?: boolean })?.retryable === true,
        onRetry: (error, attempt, delayMs) =>
          logger.warn({ correlationId, caseId, attempt, delayMs, err: describe(error) }, 'retrying classification'),
        ...deps.retryOverrides,
      },
    );
  } catch (error) {
    // The model is unavailable. The case is already durable, so nothing is
    // lost — it goes to a human with the failure recorded, which is the only
    // honest outcome. Guessing an action here would be the wrong kind of
    // resilience: a wrong refund is worse than a delayed reply.
    await appendAudit(db, {
      caseId,
      event: 'classification.failed',
      actor: { kind: 'system' },
      detail: { error: describe(error), classifier: deps.classifier.name },
      correlationId,
    });
    const current = await getCase(db, caseId);
    assertTransition(current!.state, 'failed');
    await transitionCase(db, caseId, current!.version, 'failed');
    logger.error({ correlationId, caseId, err: describe(error) }, 'classification failed');
    throw error;
  }

  const classificationRow = await insertClassification(db, caseId, result.classification, {
    model: result.model,
    promptVersion: result.promptVersion,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    latencyMs: result.latencyMs,
    degraded: result.degraded,
  });

  await appendAudit(db, {
    caseId,
    event: result.degraded ? 'classification.degraded' : 'classification.succeeded',
    actor: { kind: 'system' },
    fromState: 'received',
    toState: 'classified',
    detail: {
      intent: result.classification.intent,
      urgency: result.classification.urgency,
      confidence: result.classification.confidence,
      proposed_action: result.classification.proposed_action,
      model: result.model,
      prompt_version: result.promptVersion,
      latency_ms: result.latencyMs,
    },
    correlationId,
  });

  const afterClassify = await transitionCase(db, caseId, expectedVersion, 'classified', {
    currentClassificationId: classificationRow.id,
  });

  const decision = evaluatePolicy(message, result.classification, policy);
  await insertPolicyDecision(db, caseId, classificationRow.id, decision, policy as unknown as Record<string, unknown>);
  await appendAudit(db, {
    caseId,
    event: 'policy.evaluated',
    actor: { kind: 'system' },
    detail: {
      verdict: decision.verdict,
      action: decision.action,
      blast_radius: decision.blastRadius,
      decided_by: decision.decidedBy,
      required_confidence: decision.requiredConfidence,
      actual_confidence: decision.actualConfidence,
      triggered: decision.triggered,
      explanation: explainDecision(decision),
    },
    correlationId,
  });

  if (decision.verdict === 'require_approval') {
    assertTransition('classified', 'pending_approval');
    const parked = await transitionCase(db, caseId, afterClassify.version, 'pending_approval');
    await appendAudit(db, {
      caseId,
      event: 'approval.requested',
      actor: { kind: 'system' },
      fromState: 'classified',
      toState: 'pending_approval',
      detail: { action: decision.action, reason: decision.triggered[0]?.detail ?? decision.decidedBy },
      correlationId,
    });

    await notifyBestEffort(deps, {
      caseId,
      kind: 'approval_requested',
      subject: message.subject || '(no subject)',
      summary: `${explainDecision(decision)} — ${result.classification.summary}`,
      action: decision.action,
      url: `${deps.appUrl}/cases/${caseId}`,
      detail: {
        intent: result.classification.intent,
        urgency: result.classification.urgency,
        confidence: result.classification.confidence.toFixed(2),
        from: message.from_email,
      },
    }, correlationId);

    logger.info({ correlationId, caseId, action: decision.action, rule: decision.decidedBy }, 'case parked for approval');
    return {
      caseId,
      state: parked.state,
      duplicate: false,
      classification: result.classification,
      decision,
    };
  }

  const executed = await executeAction(
    caseId,
    afterClassify.version,
    message,
    result.classification,
    decision.action,
    { kind: 'system' },
    correlationId,
    deps,
  );

  return {
    caseId,
    state: executed.state,
    duplicate: false,
    classification: result.classification,
    decision,
    executedRef: executed.externalRef,
  };
}

/* -------------------------------------------------------------------------- */
/* Approval                                                                   */
/* -------------------------------------------------------------------------- */

export interface ApprovalDecisionInput {
  caseId: string;
  expectedVersion: number;
  operator: Extract<Actor, { kind: 'operator' }>;
  granted: boolean;
  reason?: string | null;
  /** An operator may authorise something other than what was proposed. */
  overrideAction?: Classification['proposed_action'] | null;
  overrideRefundEur?: number | null;
}

/**
 * Records a human decision and, if granted, performs the action.
 *
 * `expectedVersion` is supplied by the page the operator was looking at. If the
 * case moved in the meantime — another operator, a re-classification — the
 * update matches nothing and they are told to reload rather than approving
 * something they never saw.
 */
export async function decideApproval(
  input: ApprovalDecisionInput,
  correlationId: string,
  deps: PipelineDeps,
): Promise<{ state: CaseState; externalRef?: string | null }> {
  const { db } = deps;

  const detail = await db.query.cases.findFirst({
    where: (c, { eq }) => eq(c.id, input.caseId),
    with: { message: true, classifications: { limit: 1, orderBy: (t, { desc }) => desc(t.createdAt) } },
  });
  if (!detail) throw new NotFoundError('Case');
  if (detail.state !== 'pending_approval') {
    throw new ConflictError(`Case is ${detail.state}, not awaiting approval.`);
  }

  const classificationRow = detail.classifications[0];
  if (!classificationRow) throw new ConflictError('Case has no classification to act on.');

  const { insertApproval } = await import('../../db/repositories');
  const action = input.overrideAction ?? classificationRow.proposedAction;
  const refundEur =
    input.overrideRefundEur ??
    (classificationRow.refundAmountEur === null ? null : Number(classificationRow.refundAmountEur));

  await insertApproval(db, {
    caseId: input.caseId,
    operatorId: input.operator.id,
    granted: input.granted,
    reason: input.reason ?? null,
    approvedAction: input.granted ? action : null,
    approvedRefundEur: input.granted ? refundEur : null,
  });

  if (!input.granted) {
    assertTransition('pending_approval', 'rejected');
    const rejected = await transitionCase(db, input.caseId, input.expectedVersion, 'rejected', {
      closedAt: new Date(),
    });
    await appendAudit(db, {
      caseId: input.caseId,
      event: 'approval.denied',
      actor: input.operator,
      fromState: 'pending_approval',
      toState: 'rejected',
      detail: { reason: input.reason ?? null, proposed_action: classificationRow.proposedAction },
      correlationId,
    });
    return { state: rejected.state };
  }

  assertTransition('pending_approval', 'approved');
  const approved = await transitionCase(db, input.caseId, input.expectedVersion, 'approved');
  await appendAudit(db, {
    caseId: input.caseId,
    event: 'approval.granted',
    actor: input.operator,
    fromState: 'pending_approval',
    toState: 'approved',
    detail: {
      approved_action: action,
      proposed_action: classificationRow.proposedAction,
      overridden: action !== classificationRow.proposedAction,
      refund_amount_eur: refundEur,
      reason: input.reason ?? null,
    },
    correlationId,
  });

  const classification: Classification = {
    intent: classificationRow.intent,
    urgency: classificationRow.urgency,
    confidence: Number(classificationRow.confidence),
    summary: classificationRow.summary,
    evidence: classificationRow.evidence,
    proposed_action: classificationRow.proposedAction,
    refund_amount_eur: refundEur,
    template_key: classificationRow.templateKey,
    reasoning: classificationRow.reasoning,
    needs_translation: classificationRow.needsTranslation,
  };

  const executed = await executeAction(
    input.caseId,
    approved.version,
    toInboundMessage(detail.message),
    classification,
    action,
    input.operator,
    correlationId,
    deps,
  );

  return { state: executed.state, externalRef: executed.externalRef };
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                  */
/* -------------------------------------------------------------------------- */

async function executeAction(
  caseId: string,
  expectedVersion: number,
  message: InboundMessage,
  classification: Classification,
  action: Classification['proposed_action'],
  actor: Actor,
  correlationId: string,
  deps: PipelineDeps,
): Promise<{ state: CaseState; externalRef: string | null }> {
  const { db, logger } = deps;

  if (!deps.executor.supports(action)) {
    // `no_action` is a real outcome, not a failure: spam is handled by doing
    // nothing, and that still gets recorded.
    const done = await transitionCase(db, caseId, expectedVersion, 'executing');
    const closed = await transitionCase(db, caseId, done.version, 'executed', { closedAt: new Date() });
    await appendAudit(db, {
      caseId,
      event: 'action.succeeded',
      actor,
      toState: 'executed',
      detail: { action, note: 'No side effect required for this action.' },
      correlationId,
    });
    return { state: closed.state, externalRef: null };
  }

  const executing = await transitionCase(db, caseId, expectedVersion, 'executing');
  const idempotencyKey = actionIdempotencyKey(caseId, action, classification);

  const claim = await claimAction(db, {
    caseId,
    type: action,
    idempotencyKey,
    request: {
      action,
      refund_amount_eur: classification.refund_amount_eur,
      template_key: classification.template_key,
    },
  });

  if (!claim.claimed) {
    // Somebody already ran this exact action for this case. Converging on the
    // existing result is the whole point of the key.
    await appendAudit(db, {
      caseId,
      event: 'action.succeeded',
      actor,
      detail: { action, note: 'Already executed — idempotency key matched an existing action.', external_ref: claim.existingRef },
      correlationId,
    });
    const closed = await transitionCase(db, caseId, executing.version, 'executed', { closedAt: new Date() });
    return { state: closed.state, externalRef: claim.existingRef };
  }

  await appendAudit(db, {
    caseId,
    event: 'action.started',
    actor,
    fromState: 'approved',
    toState: 'executing',
    detail: { action, idempotency_key: idempotencyKey },
    correlationId,
  });

  try {
    const outcome = await deps.executor.execute({
      caseId,
      action,
      message,
      classification,
      idempotencyKey,
      refundAmountEur: classification.refund_amount_eur,
      templateKey: classification.template_key,
    });

    await completeAction(db, claim.id, {
      status: 'succeeded',
      externalRef: outcome.externalRef,
      response: outcome.response,
    });
    const closed = await transitionCase(db, caseId, executing.version, 'executed', { closedAt: new Date() });
    await appendAudit(db, {
      caseId,
      event: 'action.succeeded',
      actor,
      fromState: 'executing',
      toState: 'executed',
      detail: { action, external_ref: outcome.externalRef },
      correlationId,
    });

    await notifyBestEffort(deps, {
      caseId,
      kind: 'action_executed',
      subject: message.subject || '(no subject)',
      summary: classification.summary,
      action,
      url: `${deps.appUrl}/cases/${caseId}`,
      detail: { external_ref: outcome.externalRef ?? '—', actor: actor.kind },
    }, correlationId);

    logger.info({ correlationId, caseId, action, ref: outcome.externalRef }, 'action executed');
    return { state: closed.state, externalRef: outcome.externalRef };
  } catch (error) {
    await completeAction(db, claim.id, { status: 'failed', error: describe(error) });
    const failed = await transitionCase(db, caseId, executing.version, 'failed');
    await appendAudit(db, {
      caseId,
      event: 'action.failed',
      actor,
      fromState: 'executing',
      toState: 'failed',
      detail: { action, error: describe(error) },
      correlationId,
    });

    await notifyBestEffort(deps, {
      caseId,
      kind: 'action_failed',
      subject: message.subject || '(no subject)',
      summary: describe(error),
      action,
      url: `${deps.appUrl}/cases/${caseId}`,
    }, correlationId);

    logger.error({ correlationId, caseId, action, err: describe(error) }, 'action execution failed');
    return { state: failed.state, externalRef: null };
  }
}

/**
 * Stable across retries, distinct across cases and actions.
 *
 * The refund amount is in the key on purpose: re-running an approved refund
 * must converge, but approving a *different* amount is a different action and
 * must not be silently swallowed as a duplicate.
 */
export function actionIdempotencyKey(
  caseId: string,
  action: string,
  classification: Pick<Classification, 'refund_amount_eur' | 'template_key'>,
): string {
  const material = [caseId, action, classification.refund_amount_eur ?? '', classification.template_key ?? ''].join('|');
  return createHash('sha256').update(material).digest('hex').slice(0, 40);
}

/** A failed notification never fails a case that is already recorded. */
async function notifyBestEffort(
  deps: PipelineDeps,
  input: Parameters<NotifierPort['notify']>[0],
  correlationId: string,
): Promise<void> {
  try {
    await deps.notifier.notify(input);
  } catch (error) {
    deps.logger.warn({ correlationId, caseId: input.caseId, err: describe(error) }, 'notification failed');
  }
}

function toInboundMessage(row: {
  externalId: string;
  source: string;
  fromEmail: string;
  fromName: string | null;
  toEmail: string;
  subject: string;
  body: string;
  headers: Record<string, string> | null;
}): InboundMessage {
  return {
    external_id: row.externalId,
    source: row.source,
    from_email: row.fromEmail,
    from_name: row.fromName ?? undefined,
    to_email: row.toEmail,
    subject: row.subject,
    body: row.body,
    headers: row.headers ?? undefined,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
