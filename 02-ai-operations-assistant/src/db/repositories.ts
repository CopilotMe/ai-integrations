import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Actor, AuditEvent, CaseState, Classification } from '../core/domain/types';
import { actorLabel } from '../core/domain/types';
import type { PolicyDecision } from '../core/policy/autonomy';
import { ConflictError } from '../lib/errors';
import type { Database } from './client';
import {
  actions,
  approvals,
  apiKeys,
  auditLog,
  cases,
  classifications,
  idempotencyKeys,
  messages,
  operators,
  policyDecisions,
  sessions,
  type CaseRow,
  type MessageRow,
} from './schema';

/* -------------------------------------------------------------------------- */
/* Audit                                                                      */
/* -------------------------------------------------------------------------- */

export interface AuditInput {
  caseId?: string | null;
  event: AuditEvent;
  actor: Actor;
  fromState?: CaseState | null;
  toState?: CaseState | null;
  detail?: Record<string, unknown>;
  correlationId?: string | null;
}

/**
 * Appends one audit row.
 *
 * Takes a `Database` rather than reading a global so it can be handed a
 * transaction — an audit entry written outside the transaction that caused it
 * can survive a rollback, which is worse than no audit entry at all.
 */
export async function appendAudit(db: Database, input: AuditInput): Promise<void> {
  await db.insert(auditLog).values({
    caseId: input.caseId ?? null,
    event: input.event,
    actorKind: input.actor.kind,
    actorId: input.actor.kind === 'system' ? null : input.actor.id,
    actorLabel: actorLabel(input.actor),
    fromState: input.fromState ?? null,
    toState: input.toState ?? null,
    detail: input.detail ?? {},
    correlationId: input.correlationId ?? null,
  });
}

export async function listAudit(
  db: Database,
  options: { caseId?: string; event?: AuditEvent; since?: Date; limit?: number } = {},
) {
  const conditions = [
    options.caseId ? eq(auditLog.caseId, options.caseId) : undefined,
    options.event ? eq(auditLog.event, options.event) : undefined,
    options.since ? gte(auditLog.createdAt, options.since) : undefined,
  ].filter(Boolean);

  return db
    .select()
    .from(auditLog)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditLog.createdAt))
    .limit(Math.min(options.limit ?? 100, 500));
}

/* -------------------------------------------------------------------------- */
/* Messages and cases                                                         */
/* -------------------------------------------------------------------------- */

export interface CreatedCase {
  case: CaseRow;
  message: MessageRow;
  /** True when this exact provider message had already been ingested. */
  duplicate: boolean;
}

/**
 * Inserts a message and opens a case for it, or returns the existing pair.
 *
 * Deduplication is delegated to the unique index on `(source, external_id)`
 * via ON CONFLICT, so two concurrent deliveries of the same webhook cannot both
 * create a case. Checking first and then inserting would leave exactly that
 * race open.
 */
export async function createCaseForMessage(
  db: Database,
  input: {
    externalId: string;
    source: string;
    fromEmail: string;
    fromName?: string | undefined;
    toEmail: string;
    subject: string;
    body: string;
    headers?: Record<string, string> | undefined;
    receivedAt?: Date | undefined;
  },
  actor: Actor,
  correlationId: string,
): Promise<CreatedCase> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(messages)
      .values({
        externalId: input.externalId,
        source: input.source,
        fromEmail: input.fromEmail,
        fromName: input.fromName ?? null,
        toEmail: input.toEmail,
        subject: input.subject,
        body: input.body,
        headers: input.headers ?? null,
        receivedAt: input.receivedAt ?? new Date(),
      })
      .onConflictDoNothing({ target: [messages.source, messages.externalId] })
      .returning();

    const message = inserted[0];

    if (!message) {
      const existing = await tx
        .select()
        .from(messages)
        .where(and(eq(messages.source, input.source), eq(messages.externalId, input.externalId)))
        .limit(1);
      const existingMessage = existing[0]!;
      const existingCase = (
        await tx.select().from(cases).where(eq(cases.messageId, existingMessage.id)).limit(1)
      )[0]!;

      await appendAudit(tx, {
        caseId: existingCase.id,
        event: 'message.duplicate_ignored',
        actor,
        detail: { source: input.source, external_id: input.externalId },
        correlationId,
      });

      return { case: existingCase, message: existingMessage, duplicate: true };
    }

    const created = (await tx.insert(cases).values({ messageId: message.id, state: 'received' }).returning())[0]!;

    await appendAudit(tx, {
      caseId: created.id,
      event: 'message.received',
      actor,
      toState: 'received',
      detail: { source: input.source, external_id: input.externalId, subject: input.subject },
      correlationId,
    });

    return { case: created, message, duplicate: false };
  });
}

/**
 * Moves a case to a new state, refusing if someone else moved it first.
 *
 * The `version` check is what stops two operators approving the same case from
 * two browser tabs: the second update matches zero rows and raises rather than
 * silently overwriting the first decision.
 */
export async function transitionCase(
  db: Database,
  caseId: string,
  expectedVersion: number,
  to: CaseState,
  patch: Partial<{ currentClassificationId: string; assignedOperatorId: string | null; closedAt: Date | null }> = {},
): Promise<CaseRow> {
  const updated = await db
    .update(cases)
    .set({ state: to, ...patch })
    .where(and(eq(cases.id, caseId), eq(cases.version, expectedVersion)))
    .returning();

  const row = updated[0];
  if (!row) {
    throw new ConflictError(
      'This case was changed by someone else while you were looking at it. Reload and try again.',
    );
  }
  return row;
}

export async function getCase(db: Database, caseId: string): Promise<CaseRow | undefined> {
  return (await db.select().from(cases).where(eq(cases.id, caseId)).limit(1))[0];
}

export async function getCaseDetail(db: Database, caseId: string) {
  const row = await db.query.cases.findFirst({
    where: eq(cases.id, caseId),
    with: {
      message: true,
      classifications: { orderBy: desc(classifications.createdAt) },
      policyDecisions: { orderBy: desc(policyDecisions.createdAt) },
      approvals: { orderBy: desc(approvals.createdAt) },
      actions: { orderBy: desc(actions.startedAt) },
    },
  });
  if (!row) return undefined;

  const audit = await listAudit(db, { caseId, limit: 200 });
  return { ...row, audit: audit.reverse() };
}

export interface ListCasesOptions {
  states?: CaseState[];
  intent?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listCases(db: Database, options: ListCasesOptions = {}) {
  const conditions = [
    options.states && options.states.length > 0 ? inArray(cases.state, options.states) : undefined,
    options.search
      ? or(
          sql`${messages.subject} ILIKE ${`%${options.search}%`}`,
          sql`${messages.fromEmail} ILIKE ${`%${options.search}%`}`,
        )
      : undefined,
    options.intent ? eq(classifications.intent, options.intent as never) : undefined,
  ].filter(Boolean);

  return db
    .select({
      case: cases,
      message: messages,
      classification: classifications,
    })
    .from(cases)
    .innerJoin(messages, eq(cases.messageId, messages.id))
    .leftJoin(classifications, eq(cases.currentClassificationId, classifications.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    // Pending approvals first: the queue exists to be worked, and anything
    // waiting on a human is the only thing that is actually blocked.
    .orderBy(sql`CASE WHEN ${cases.state} = 'pending_approval' THEN 0 ELSE 1 END`, desc(cases.openedAt))
    .limit(Math.min(options.limit ?? 50, 200))
    .offset(options.offset ?? 0);
}

export async function countCasesByState(db: Database) {
  const rows = await db
    .select({ state: cases.state, count: sql<number>`count(*)::int` })
    .from(cases)
    .groupBy(cases.state);
  return Object.fromEntries(rows.map((r) => [r.state, r.count])) as Partial<Record<CaseState, number>>;
}

/* -------------------------------------------------------------------------- */
/* Classifications, decisions, approvals, actions                             */
/* -------------------------------------------------------------------------- */

export async function insertClassification(
  db: Database,
  caseId: string,
  classification: Classification,
  meta: { model: string; promptVersion: string; promptTokens: number; completionTokens: number; latencyMs: number; degraded: boolean },
) {
  const row = (
    await db
      .insert(classifications)
      .values({
        caseId,
        intent: classification.intent,
        urgency: classification.urgency,
        confidence: classification.confidence.toFixed(3),
        summary: classification.summary,
        evidence: classification.evidence,
        proposedAction: classification.proposed_action,
        refundAmountEur: classification.refund_amount_eur?.toFixed(2) ?? null,
        templateKey: classification.template_key,
        reasoning: classification.reasoning,
        needsTranslation: classification.needs_translation,
        model: meta.model,
        promptVersion: meta.promptVersion,
        promptTokens: meta.promptTokens,
        completionTokens: meta.completionTokens,
        latencyMs: meta.latencyMs,
        degraded: meta.degraded,
      })
      .returning()
  )[0]!;
  return row;
}

export async function insertPolicyDecision(
  db: Database,
  caseId: string,
  classificationId: string,
  decision: PolicyDecision,
  policySnapshot: Record<string, unknown>,
) {
  return (
    await db
      .insert(policyDecisions)
      .values({
        caseId,
        classificationId,
        verdict: decision.verdict,
        action: decision.action,
        blastRadius: decision.blastRadius,
        requiredConfidence: decision.requiredConfidence.toFixed(3),
        actualConfidence: decision.actualConfidence.toFixed(3),
        decidedBy: decision.decidedBy,
        triggeredRules: decision.triggered,
        policySnapshot,
      })
      .returning()
  )[0]!;
}

export async function insertApproval(
  db: Database,
  input: {
    caseId: string;
    operatorId: string;
    granted: boolean;
    reason?: string | null;
    approvedAction?: string | null;
    approvedRefundEur?: number | null;
  },
) {
  return (
    await db
      .insert(approvals)
      .values({
        caseId: input.caseId,
        operatorId: input.operatorId,
        granted: input.granted,
        reason: input.reason ?? null,
        approvedAction: (input.approvedAction ?? null) as never,
        approvedRefundEur: input.approvedRefundEur?.toFixed(2) ?? null,
      })
      .returning()
  )[0]!;
}

/**
 * Claims the right to perform an action, or reports that it is already claimed.
 *
 * The unique index on `idempotency_key` is the actual guarantee: a retried
 * execution loses the insert race and is told so, rather than issuing a second
 * refund. This is the reason executions are recorded *before* the side effect,
 * not after.
 */
export async function claimAction(
  db: Database,
  input: { caseId: string; type: string; idempotencyKey: string; request: Record<string, unknown> },
): Promise<{ id: string; claimed: boolean; existingRef: string | null }> {
  const inserted = await db
    .insert(actions)
    .values({
      caseId: input.caseId,
      type: input.type as never,
      idempotencyKey: input.idempotencyKey,
      request: input.request,
      status: 'pending',
      attempts: 1,
    })
    .onConflictDoNothing({ target: actions.idempotencyKey })
    .returning();

  const row = inserted[0];
  if (row) return { id: row.id, claimed: true, existingRef: null };

  const existing = (
    await db.select().from(actions).where(eq(actions.idempotencyKey, input.idempotencyKey)).limit(1)
  )[0]!;
  return { id: existing.id, claimed: false, existingRef: existing.externalRef };
}

export async function completeAction(
  db: Database,
  actionId: string,
  result: { status: 'succeeded' | 'failed'; externalRef?: string | null; response?: Record<string, unknown>; error?: string },
) {
  await db
    .update(actions)
    .set({
      status: result.status,
      externalRef: result.externalRef ?? null,
      response: result.response ?? null,
      error: result.error ?? null,
      finishedAt: new Date(),
    })
    .where(eq(actions.id, actionId));
}

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

export async function findOperatorByEmail(db: Database, email: string) {
  return (
    await db
      .select()
      .from(operators)
      .where(and(eq(operators.email, email.toLowerCase()), isNull(operators.disabledAt)))
      .limit(1)
  )[0];
}

export async function createSession(db: Database, operatorId: string, tokenHash: string, expiresAt: Date) {
  return (await db.insert(sessions).values({ operatorId, tokenHash, expiresAt }).returning())[0]!;
}

export async function findSession(db: Database, tokenHash: string) {
  const rows = await db
    .select({ session: sessions, operator: operators })
    .from(sessions)
    .innerJoin(operators, eq(sessions.operatorId, operators.id))
    .where(and(eq(sessions.tokenHash, tokenHash), gte(sessions.expiresAt, new Date()), isNull(operators.disabledAt)))
    .limit(1);
  return rows[0];
}

export async function deleteSession(db: Database, tokenHash: string) {
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}

export async function findApiKey(db: Database, tokenHash: string) {
  return (
    await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.tokenHash, tokenHash), isNull(apiKeys.revokedAt)))
      .limit(1)
  )[0];
}

export async function touchApiKey(db: Database, id: string) {
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id));
}

/* -------------------------------------------------------------------------- */
/* Idempotency                                                                */
/* -------------------------------------------------------------------------- */

export async function findIdempotentResponse(db: Database, key: string) {
  return (
    await db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.key, key), gte(idempotencyKeys.expiresAt, new Date())))
      .limit(1)
  )[0];
}

export async function saveIdempotentResponse(
  db: Database,
  input: { key: string; requestHash: string; status: number; body: Record<string, unknown>; ttlHours?: number },
) {
  const expiresAt = new Date(Date.now() + (input.ttlHours ?? 24) * 3600_000);
  await db
    .insert(idempotencyKeys)
    .values({
      key: input.key,
      requestHash: input.requestHash,
      responseStatus: input.status,
      responseBody: input.body,
      expiresAt,
    })
    .onConflictDoNothing({ target: idempotencyKeys.key });
}

export async function purgeExpiredIdempotencyKeys(db: Database): Promise<number> {
  const deleted = await db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.expiresAt, new Date()))
    .returning({ key: idempotencyKeys.key });
  return deleted.length;
}
