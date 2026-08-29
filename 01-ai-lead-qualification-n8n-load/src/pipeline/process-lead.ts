import { idempotencyKey, type Lead } from '../domain/lead.js';
import type { Qualification } from '../domain/qualification.js';
import type { DeadLetterPort } from '../lib/deadletter.js';
import { withRetry } from '../lib/retry.js';
import type { CrmContact, CrmDeal, CrmPort } from '../ports/crm.js';
import type { NotifierPort } from '../ports/notifier.js';
import { qualifyLead, type QualifyDeps } from './qualify-lead.js';

export interface ProcessDeps extends QualifyDeps {
  crm: CrmPort;
  notifier: NotifierPort;
  deadLetter: DeadLetterPort;
  crmMaxRetries?: number;
  now?: () => Date;
}

export interface ProcessResult {
  /** snake_case throughout: ProcessResult is serialised directly as the response body. */
  correlation_id: string;
  idempotency_key: string;
  lead: Lead;
  qualification: Qualification;
  suggested_reply: string | null;
  crm: { contact: CrmContact | null; deal: CrmDeal | null };
  notified: boolean;
  /** Steps that failed without failing the request. */
  warnings: string[];
}

/**
 * The full inbound-lead pipeline.
 *
 * Deliberate ordering: the CRM write is the only step allowed to fail the
 * request, because it is the only one that loses data if it is skipped. Deals
 * and Slack come after, and degrade to a warning.
 */
export async function processLead(
  input: unknown,
  correlationId: string,
  deps: ProcessDeps,
): Promise<ProcessResult> {
  const { lead, qualification, suggestedReply } = await qualifyLead(input, deps);
  const key = idempotencyKey(lead);
  const warnings: string[] = [];
  const now = deps.now ?? (() => new Date());
  const crmRetries = deps.crmMaxRetries ?? 2;

  const contact = await withRetry(() => deps.crm.upsertContact(lead, qualification), {
    retries: crmRetries,
    isRetryable: (error) => (error as { retryable?: boolean })?.retryable === true,
    onRetry: (error, attempt, delayMs) =>
      deps.logger.warn({ attempt, delayMs, err: describe(error) }, 'retrying CRM contact upsert'),
    ...deps.retryOverrides,
  }).catch(async (error) => {
    // Nothing downstream can proceed without a contact, and the lead must not
    // evaporate — park it for replay and surface the failure to the caller.
    await deps.deadLetter.record({
      at: now().toISOString(),
      correlationId,
      stage: 'crm.upsertContact',
      error: { code: (error as { code?: string })?.code, message: describe(error) },
      payload: { lead, qualification },
    });
    throw error;
  });

  let deal: CrmDeal | null = null;
  if (qualification.classification !== 'COLD') {
    try {
      deal = await withRetry(
        () => deps.crm.createDeal({ contactId: contact.id, lead, qualification, idempotencyKey: key }),
        {
          retries: crmRetries,
          isRetryable: (error) => (error as { retryable?: boolean })?.retryable === true,
          ...deps.retryOverrides,
        },
      );
    } catch (error) {
      // The contact is saved, so no data is lost. Park the deal for replay
      // rather than failing a lead that has already been recorded.
      warnings.push('deal_creation_failed');
      await deps.deadLetter.record({
        at: now().toISOString(),
        correlationId,
        stage: 'crm.createDeal',
        error: { code: (error as { code?: string })?.code, message: describe(error) },
        payload: { contactId: contact.id, lead, qualification, idempotencyKey: key },
      });
      deps.logger.error({ err: describe(error) }, 'deal creation failed — dead-lettered');
    }
  }

  let notified = false;
  try {
    await deps.notifier.notify({ lead, qualification, contact, deal, suggestedReply });
    notified = true;
  } catch (error) {
    // A missed Slack ping is an annoyance; failing the webhook over it would
    // make n8n retry the whole pipeline and duplicate the CRM work.
    warnings.push('notification_failed');
    deps.logger.warn({ err: describe(error) }, 'notification failed — lead was still processed');
  }

  deps.logger.info(
    {
      correlationId,
      classification: qualification.classification,
      score: qualification.score,
      next_action: qualification.next_action,
      contact_existing: contact.existing,
      deal_existing: deal?.existing ?? null,
      degraded: qualification.explanation.degraded,
      warnings,
    },
    'lead processed',
  );

  return {
    correlation_id: correlationId,
    idempotency_key: key,
    lead,
    qualification,
    suggested_reply: suggestedReply,
    crm: { contact, deal },
    notified,
    warnings,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
