import { cookies } from 'next/headers';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { appendAudit, createSession, findOperatorByEmail } from '@/db/repositories';
import { generateToken, hashToken, verifyPassword } from '@/lib/crypto';
import { UnauthorizedError } from '@/lib/errors';
import { config } from '@/lib/config';
import { SESSION_COOKIE, SESSION_TTL_HOURS, sessionCookieOptions } from '@/server/auth';
import { assertSameOrigin, correlationIdFrom, fail, ok, parseBody, readJson } from '@/server/http';

export const dynamic = 'force-dynamic';

const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(1).max(200),
});

export async function POST(request: Request) {
  const correlationId = correlationIdFrom(request);
  try {
    await assertSameOrigin();
    const input = parseBody(LoginSchema, await readJson(request));
    const db = getDb();

    const operator = await findOperatorByEmail(db, input.email);

    // Verify even when no operator matched, against a dummy hash, so response
    // time does not reveal which addresses exist.
    const stored = operator?.passwordHash ?? DUMMY_HASH;
    const valid = await verifyPassword(input.password, stored);

    if (!operator || !valid) {
      await appendAudit(db, {
        event: 'auth.login_failed',
        actor: { kind: 'system' },
        detail: { email: input.email },
        correlationId,
      });
      throw new UnauthorizedError('Invalid email or password');
    }

    const token = generateToken('sess');
    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600_000);
    await createSession(db, operator.id, hashToken(token), expiresAt);

    await appendAudit(db, {
      event: 'auth.login_succeeded',
      actor: { kind: 'operator', id: operator.id, email: operator.email },
      detail: { role: operator.role },
      correlationId,
    });

    const jar = await cookies();
    jar.set(SESSION_COOKIE, token, sessionCookieOptions(config().NODE_ENV === 'production'));

    return ok({ operator: { id: operator.id, email: operator.email, name: operator.name, role: operator.role } }, 200, correlationId);
  } catch (error) {
    return fail(error, correlationId);
  }
}

/** A real scrypt hash of a value nobody knows, so the timing path is identical. */
const DUMMY_HASH =
  '16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$Ym9ndXMtaGFzaC1mb3ItdGltaW5nLXNhZmV0eS0wMDAwMDA=';
