import { getDb } from '@/db/client';
import { getCaseDetail } from '@/db/repositories';
import { NotFoundError } from '@/lib/errors';
import { requireOperator } from '@/server/auth';
import { correlationIdFrom, fail, ok } from '@/server/http';

export const dynamic = 'force-dynamic';

/** Full case history: message, every classification, every decision, the audit trail. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlationId = correlationIdFrom(request);
  try {
    await requireOperator();
    const { id } = await context.params;
    const detail = await getCaseDetail(getDb(), id);
    if (!detail) throw new NotFoundError('Case');
    return ok({ case: detail, correlation_id: correlationId }, 200, correlationId);
  } catch (error) {
    return fail(error, correlationId);
  }
}
