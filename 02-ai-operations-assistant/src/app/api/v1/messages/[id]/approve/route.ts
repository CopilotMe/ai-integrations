import { z } from 'zod';
import { ACTION_TYPES } from '@/core/domain/types';
import { decideApproval } from '@/core/pipeline/process-message';
import { requireOperator, requireWriteRole } from '@/server/auth';
import { deps } from '@/server/container';
import { assertSameOrigin, correlationIdFrom, fail, ok, parseBody, readJson } from '@/server/http';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ApproveSchema = z.object({
  /** From the page the operator was looking at — see decideApproval. */
  expected_version: z.coerce.number().int().min(1),
  reason: z.string().trim().max(1000).optional(),
  override_action: z.enum(ACTION_TYPES).optional(),
  override_refund_eur: z.coerce.number().min(0).max(1_000_000).optional(),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlationId = correlationIdFrom(request);
  try {
    await assertSameOrigin();
    const operator = await requireOperator();
    requireWriteRole(operator);

    const { id } = await context.params;
    const input = parseBody(ApproveSchema, await readJson(request));

    const result = await decideApproval(
      {
        caseId: id,
        expectedVersion: input.expected_version,
        operator: { kind: 'operator', id: operator.id, email: operator.email },
        granted: true,
        reason: input.reason ?? null,
        overrideAction: input.override_action ?? null,
        overrideRefundEur: input.override_refund_eur ?? null,
      },
      correlationId,
      deps(),
    );

    return ok({ case_id: id, state: result.state, external_ref: result.externalRef ?? null, correlation_id: correlationId }, 200, correlationId);
  } catch (error) {
    return fail(error, correlationId);
  }
}
