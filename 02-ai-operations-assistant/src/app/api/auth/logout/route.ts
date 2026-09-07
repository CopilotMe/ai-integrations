import { endSession } from '@/server/auth';
import { assertSameOrigin, correlationIdFrom, fail, ok } from '@/server/http';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const correlationId = correlationIdFrom(request);
  try {
    await assertSameOrigin();
    await endSession();
    return ok({ ok: true }, 200, correlationId);
  } catch (error) {
    return fail(error, correlationId);
  }
}
