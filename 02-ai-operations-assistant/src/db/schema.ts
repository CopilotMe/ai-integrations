import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { ACTION_TYPES, AUDIT_EVENTS, CASE_STATES, INTENTS, URGENCIES } from '../core/domain/types';

/* -------------------------------------------------------------------------- */
/* Operators and machine clients                                              */
/* -------------------------------------------------------------------------- */

export const operators = pgTable(
  'operators',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    /** scrypt: `N$r$p$salt$hash`, all base64. Never a plaintext password. */
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['admin', 'agent', 'viewer'] })
      .notNull()
      .default('agent'),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('operators_email_key').on(table.email)],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** SHA-256 of the token. The token itself is shown once, at creation. */
    tokenHash: text('token_hash').notNull(),
    /** First 8 characters, so a key can be identified in a list and in logs. */
    tokenPrefix: text('token_prefix').notNull(),
    scopes: text('scopes').array().notNull().default(sql`ARRAY['intake']::text[]`),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('api_keys_token_hash_key').on(table.tokenHash)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operators.id, { onDelete: 'cascade' }),
    /** SHA-256 of the cookie value, so a leaked database row is not a live session. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_key').on(table.tokenHash),
    index('sessions_operator_idx').on(table.operatorId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Cases                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The inbound message, exactly as received.
 *
 * Never updated after insert. Everything downstream — classification, policy,
 * approval, execution — references it, so if this row changed, the audit trail
 * would be describing a message that no longer exists.
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    externalId: text('external_id').notNull(),
    source: text('source').notNull().default('unknown'),
    fromEmail: text('from_email').notNull(),
    fromName: text('from_name'),
    toEmail: text('to_email').notNull(),
    subject: text('subject').notNull().default(''),
    body: text('body').notNull(),
    headers: jsonb('headers').$type<Record<string, string>>(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Deduplication happens here, in the database, not in application code:
    // two concurrent intake requests for the same provider message must not
    // both succeed, and only a unique constraint can promise that.
    uniqueIndex('messages_source_external_id_key').on(table.source, table.externalId),
    index('messages_from_email_idx').on(table.fromEmail),
    index('messages_received_at_idx').on(table.receivedAt),
  ],
);

export const cases = pgTable(
  'cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'restrict' }),
    state: text('state', { enum: CASE_STATES }).notNull().default('received'),
    /** Points at the classification currently in force (a case can be re-classified). */
    currentClassificationId: uuid('current_classification_id'),
    assignedOperatorId: uuid('assigned_operator_id').references(() => operators.id, {
      onDelete: 'set null',
    }),
    /** Optimistic-concurrency guard: two operators cannot approve the same case. */
    version: integer('version').notNull().default(1),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('cases_message_id_key').on(table.messageId),
    index('cases_state_idx').on(table.state),
    index('cases_opened_at_idx').on(table.openedAt),
  ],
);

export const classifications = pgTable(
  'classifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    intent: text('intent', { enum: INTENTS }).notNull(),
    urgency: text('urgency', { enum: URGENCIES }).notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull(),
    summary: text('summary').notNull(),
    evidence: text('evidence').array().notNull().default(sql`ARRAY[]::text[]`),
    proposedAction: text('proposed_action', { enum: ACTION_TYPES }).notNull(),
    refundAmountEur: numeric('refund_amount_eur', { precision: 12, scale: 2 }),
    templateKey: text('template_key'),
    reasoning: text('reasoning').notNull(),
    needsTranslation: boolean('needs_translation').notNull().default(false),
    /** Which model and prompt produced this — needed to explain a bad decision later. */
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    /** True when the model was unavailable and a heuristic filled in. */
    degraded: boolean('degraded').notNull().default(false),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('classifications_case_idx').on(table.caseId)],
);

export const policyDecisions = pgTable(
  'policy_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    classificationId: uuid('classification_id')
      .notNull()
      .references(() => classifications.id, { onDelete: 'cascade' }),
    verdict: text('verdict', { enum: ['auto_execute', 'require_approval'] }).notNull(),
    action: text('action', { enum: ACTION_TYPES }).notNull(),
    blastRadius: text('blast_radius', { enum: ['none', 'low', 'medium', 'high'] }).notNull(),
    requiredConfidence: numeric('required_confidence', { precision: 4, scale: 3 }).notNull(),
    actualConfidence: numeric('actual_confidence', { precision: 4, scale: 3 }).notNull(),
    decidedBy: text('decided_by').notNull(),
    triggeredRules: jsonb('triggered_rules')
      .$type<Array<{ rule: string; detail: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** The exact policy config in force. Lets a past decision be replayed faithfully. */
    policySnapshot: jsonb('policy_snapshot').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('policy_decisions_case_idx').on(table.caseId)],
);

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operators.id, { onDelete: 'restrict' }),
    granted: boolean('granted').notNull(),
    reason: text('reason'),
    /** What the operator actually authorised — may differ from what was proposed. */
    approvedAction: text('approved_action', { enum: ACTION_TYPES }),
    approvedRefundEur: numeric('approved_refund_eur', { precision: 12, scale: 2 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('approvals_case_idx').on(table.caseId)],
);

export const actions = pgTable(
  'actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    type: text('type', { enum: ACTION_TYPES }).notNull(),
    status: text('status', { enum: ['pending', 'succeeded', 'failed'] })
      .notNull()
      .default('pending'),
    /** Stable key so a retried execution cannot produce a second side effect. */
    idempotencyKey: text('idempotency_key').notNull(),
    /** Id in the downstream system — ticket number, refund id, Slack ts. */
    externalRef: text('external_ref'),
    request: jsonb('request').$type<Record<string, unknown>>(),
    response: jsonb('response').$type<Record<string, unknown>>(),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('actions_idempotency_key_key').on(table.idempotencyKey),
    index('actions_case_idx').on(table.caseId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Audit log                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Append-only record of everything that happened, to any case, by anyone.
 *
 * No update or delete path exists in the application, and the migration revokes
 * UPDATE and DELETE on this table from the application role — an audit log the
 * application can rewrite is not an audit log.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id').references(() => cases.id, { onDelete: 'set null' }),
    event: text('event', { enum: AUDIT_EVENTS }).notNull(),
    actorKind: text('actor_kind', { enum: ['system', 'operator', 'api_key'] }).notNull(),
    actorId: text('actor_id'),
    actorLabel: text('actor_label').notNull(),
    fromState: text('from_state', { enum: CASE_STATES }),
    toState: text('to_state', { enum: CASE_STATES }),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** Ties every row produced by one request together, across services. */
    correlationId: text('correlation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_log_case_idx').on(table.caseId, table.createdAt),
    index('audit_log_event_idx').on(table.event),
    index('audit_log_created_at_idx').on(table.createdAt),
  ],
);

/* -------------------------------------------------------------------------- */
/* Idempotency                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Records the response of a completed request keyed by `Idempotency-Key`, so a
 * client that retries after a timeout gets the original answer back instead of
 * creating a second case.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text('key').primaryKey(),
    /** Hash of the request body: the same key with a different body is a client bug. */
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('idempotency_keys_expires_idx').on(table.expiresAt)],
);

/* -------------------------------------------------------------------------- */
/* Relations                                                                  */
/* -------------------------------------------------------------------------- */

export const casesRelations = relations(cases, ({ one, many }) => ({
  message: one(messages, { fields: [cases.messageId], references: [messages.id] }),
  classifications: many(classifications),
  policyDecisions: many(policyDecisions),
  approvals: many(approvals),
  actions: many(actions),
  auditEntries: many(auditLog),
}));

export const classificationsRelations = relations(classifications, ({ one }) => ({
  case: one(cases, { fields: [classifications.caseId], references: [cases.id] }),
}));

// Drizzle needs both sides of every relation declared, or the relational query
// builder cannot infer the join and fails at runtime rather than at build time.
export const policyDecisionsRelations = relations(policyDecisions, ({ one }) => ({
  case: one(cases, { fields: [policyDecisions.caseId], references: [cases.id] }),
  classification: one(classifications, {
    fields: [policyDecisions.classificationId],
    references: [classifications.id],
  }),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  case: one(cases),
}));

export const approvalsRelations = relations(approvals, ({ one }) => ({
  case: one(cases, { fields: [approvals.caseId], references: [cases.id] }),
  operator: one(operators, { fields: [approvals.operatorId], references: [operators.id] }),
}));

export const actionsRelations = relations(actions, ({ one }) => ({
  case: one(cases, { fields: [actions.caseId], references: [cases.id] }),
}));

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  case: one(cases, { fields: [auditLog.caseId], references: [cases.id] }),
}));

export type OperatorRow = typeof operators.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type CaseRow = typeof cases.$inferSelect;
export type ClassificationRow = typeof classifications.$inferSelect;
export type PolicyDecisionRow = typeof policyDecisions.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type ActionRow = typeof actions.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
