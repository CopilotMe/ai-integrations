import { InboundMessageSchema } from '@/core/domain/types';
import { processInboundMessage } from '@/core/pipeline/process-message';
import { getDb } from '@/db/client';
import { findIdempotentResponse, saveIdempotentResponse } from '@/db/repositories';
import { hashRequestBody } from '@/lib/crypto';
import { AppError } from '@/lib/errors';
import { requireApiKey } from '@/server/auth';
import { deps } from '@/server/container';
import { correlationIdFrom, fail, ok, parseBody, readJson } from '@/server/http';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Intake. This is what n8n posts an inbound email to.
 *
 * Two independent layers of deduplication, because they answer different
 * questions:
 *   - `Idempotency-Key` protects against a client retrying *this request*
 *     after a timeout, and replays the original response.
 *   - the unique index on (source, external_id) protects against the same
 *     *email* arriving through two deliveries or two workflows.
 */
export async function POST(request: Request) {
  const correlationId = correlationIdFrom(request);

  try {
    const actor = await requireApiKey('intake');
    const raw = await readJson(request);
    const idempotencyKey = request.headers.get('idempotency-key');

    if (idempotencyKey) {
      const previous = await findIdempotentResponse(getDb(), idempotencyKey);
      if (previous) {
        if (previous.requestHash !== hashRequestBody(raw)) {
          throw new AppError(
            'This Idempotency-Key was already used with a different request body',
            'idempotency_key_reuse',
            409,
          );
        }
        const replay = ok(previous.responseBody, previous.responseStatus, correlationId);
        replay.headers.set('idempotent-replay', 'true');
        return replay;
      }
    }

    const message = parseBody(InboundMessageSchema, raw);
    const result = await processInboundMessage(message, actor, correlationId, deps());

    const body = {
      case_id: result.caseId,
      state: result.state,
      duplicate: result.duplicate,
      classification: result.classification,
      decision: result.decision
        ? {
            verdict: result.decision.verdict,
            action: result.decision.action,
            blast_radius: result.decision.blastRadius,
            decided_by: result.decision.decidedBy,
            triggered: result.decision.triggered,
          }
        : null,
      external_ref: result.executedRef ?? null,
      correlation_id: correlationId,
    };
    const status = result.duplicate ? 200 : 201;

    if (idempotencyKey) {
      await saveIdempotentResponse(getDb(), {
        key: idempotencyKey,
        requestHash: hashRequestBody(raw),
        status,
        body,
      });
    }

    return ok(body, status, correlationId);
  } catch (error) {
    return fail(error, correlationId);
  }
}
