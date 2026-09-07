import { z } from 'zod';
import { decideApproval } from '@/core/pipeline/process-message';
import { requireOperator, requireWriteRole } from '@/server/auth';
import { deps } from '@/server/container';
import { assertSameOrigin, correlationIdFrom, fail, ok, parseBody, readJson } from '@/server/http';

export const dynamic = 'force-dynamic';

const RejectSchema = z.object({
  expected_version: z.coerce.number().int().min(1),
  // Required, unlike on approve: why something was refused is the part nobody
  // can reconstruct later.
  reason: z.string().trim().min(1, 'A reason is required when rejecting').max(1000),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlationId = correlationIdFrom(request);
  try {
    await assertSameOrigin();
    const operator = await requireOperator();
    requireWriteRole(operator);

    const { id } = await context.params;
    const input = parseBody(RejectSchema, await readJson(request));

    const result = await decideApproval(
      {
        caseId: id,
        expectedVersion: input.expected_version,
        operator: { kind: 'operator', id: operator.id, email: operator.email },
        granted: false,
        reason: input.reason,
      },
      correlationId,
      deps(),
    );

    return ok({ case_id: id, state: result.state, correlation_id: correlationId }, 200, correlationId);
  } catch (error) {
    return fail(error, correlationId);
  }
}
