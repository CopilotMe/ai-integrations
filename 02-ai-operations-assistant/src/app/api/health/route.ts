import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { config } from '@/lib/config';
import { ok } from '@/server/http';

export const dynamic = 'force-dynamic';

/**
 * Liveness plus a real dependency check.
 *
 * A health endpoint that only proves the process is running will report green
 * through a total database outage, which is precisely when someone is looking
 * at it.
 */
export async function GET() {
  const started = Date.now();
  try {
    await getDb().execute(sql`select 1`);
  } catch (error) {
    return ok(
      {
        status: 'unhealthy',
        database: 'unreachable',
        error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      },
      503,
    );
  }

  const c = config();
  return ok({
    status: 'ok',
    database: 'ok',
    latency_ms: Date.now() - started,
    providers: { classifier: c.LLM_PROVIDER, executor: c.TICKETING_PROVIDER, notifier: c.NOTIFIER_PROVIDER },
  });
}
