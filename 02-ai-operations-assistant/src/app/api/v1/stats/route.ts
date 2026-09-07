import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { countCasesByState } from '@/db/repositories';
import { classifications, policyDecisions } from '@/db/schema';
import { requireOperator } from '@/server/auth';
import { correlationIdFrom, fail, ok } from '@/server/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const correlationId = correlationIdFrom(request);
  try {
    await requireOperator();
    const db = getDb();

    const [byState, verdicts, intents, tokens] = await Promise.all([
      countCasesByState(db),
      db
        .select({ verdict: policyDecisions.verdict, count: sql<number>`count(*)::int` })
        .from(policyDecisions)
        .groupBy(policyDecisions.verdict),
      db
        .select({ intent: classifications.intent, count: sql<number>`count(*)::int` })
        .from(classifications)
        .groupBy(classifications.intent),
      db
        .select({
          prompt: sql<number>`coalesce(sum(${classifications.promptTokens}), 0)::int`,
          completion: sql<number>`coalesce(sum(${classifications.completionTokens}), 0)::int`,
          degraded: sql<number>`coalesce(sum(case when ${classifications.degraded} then 1 else 0 end), 0)::int`,
          total: sql<number>`count(*)::int`,
        })
        .from(classifications),
    ]);

    const autoExecuted = verdicts.find((v) => v.verdict === 'auto_execute')?.count ?? 0;
    const requiredApproval = verdicts.find((v) => v.verdict === 'require_approval')?.count ?? 0;
    const decided = autoExecuted + requiredApproval;

    return ok(
      {
        cases_by_state: byState,
        // The number the business actually cares about: how much of the queue
        // the assistant handles without a person.
        autonomy_rate: decided === 0 ? null : Number((autoExecuted / decided).toFixed(3)),
        auto_executed: autoExecuted,
        required_approval: requiredApproval,
        intents: Object.fromEntries(intents.map((i) => [i.intent, i.count])),
        classifications: tokens[0] ?? { prompt: 0, completion: 0, degraded: 0, total: 0 },
        correlation_id: correlationId,
      },
      200,
      correlationId,
    );
  } catch (error) {
    return fail(error, correlationId);
  }
}
