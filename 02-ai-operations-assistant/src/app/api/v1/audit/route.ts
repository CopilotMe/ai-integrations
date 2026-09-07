import { AUDIT_EVENTS, type AuditEvent } from '@/core/domain/types';
import { getDb } from '@/db/client';
import { listAudit } from '@/db/repositories';
import { requireOperator } from '@/server/auth';
import { correlationIdFrom, fail, ok } from '@/server/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const correlationId = correlationIdFrom(request);
  try {
    await requireOperator();
    const url = new URL(request.url);
    const event = url.searchParams.get('event');
    const since = url.searchParams.get('since');

    const entries = await listAudit(getDb(), {
      caseId: url.searchParams.get('case_id') ?? undefined,
      event: event && AUDIT_EVENTS.includes(event as AuditEvent) ? (event as AuditEvent) : undefined,
      since: since ? new Date(since) : undefined,
      limit: Number(url.searchParams.get('limit') ?? 100),
    });

    return ok({ entries, correlation_id: correlationId }, 200, correlationId);
  } catch (error) {
    return fail(error, correlationId);
  }
}
