import { CASE_STATES, type CaseState } from '@/core/domain/types';
import { getDb } from '@/db/client';
import { listCases } from '@/db/repositories';
import { requireOperator } from '@/server/auth';
import { correlationIdFrom, fail, ok } from '@/server/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const correlationId = correlationIdFrom(request);
  try {
    await requireOperator();
    const url = new URL(request.url);

    const requested = url.searchParams.getAll('state').filter((s): s is CaseState => CASE_STATES.includes(s as CaseState));
    const rows = await listCases(getDb(), {
      states: requested.length > 0 ? requested : undefined,
      search: url.searchParams.get('q') ?? undefined,
      limit: Number(url.searchParams.get('limit') ?? 50),
      offset: Number(url.searchParams.get('offset') ?? 0),
    });

    return ok(
      {
        cases: rows.map((row) => ({
          id: row.case.id,
          state: row.case.state,
          version: row.case.version,
          opened_at: row.case.openedAt,
          from: row.message.fromEmail,
          subject: row.message.subject,
          intent: row.classification?.intent ?? null,
          urgency: row.classification?.urgency ?? null,
          confidence: row.classification ? Number(row.classification.confidence) : null,
          proposed_action: row.classification?.proposedAction ?? null,
        })),
        correlation_id: correlationId,
      },
      200,
      correlationId,
    );
  } catch (error) {
    return fail(error, correlationId);
  }
}
