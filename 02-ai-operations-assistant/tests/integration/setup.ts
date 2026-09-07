import { sql } from 'drizzle-orm';
import { FakeClassifier } from '@/adapters/fake/fake-classifier';
import { FakeExecutor } from '@/adapters/fake/fake-executor';
import { FakeNotifier } from '@/adapters/fake/fake-notifier';
import type { PipelineDeps } from '@/core/pipeline/process-message';
import { DEFAULT_POLICY, type PolicyConfig } from '@/core/policy/autonomy';
import { getDb, type Database } from '@/db/client';
import { operators } from '@/db/schema';
import { hashPassword } from '@/lib/crypto';
import { pino } from 'pino';

process.env.DATABASE_URL ??= 'postgresql://ops:ops@localhost:5432/ai_ops';

export const db: Database = getDb();
export const silentLogger = pino({ level: 'silent' });

/**
 * Truncates everything between tests.
 *
 * `audit_log` and `messages` carry triggers that forbid UPDATE and DELETE, but
 * TRUNCATE is a different operation and is deliberately still allowed — an
 * append-only table you can never reset would make the suite unrunnable. The
 * guarantee that matters is that the *application* cannot rewrite history.
 */
export async function resetDatabase(): Promise<void> {
  await db.execute(sql`
    TRUNCATE audit_log, actions, approvals, policy_decisions, classifications,
             cases, messages, idempotency_keys, sessions, api_keys, operators
    RESTART IDENTITY CASCADE
  `);
}

export async function seedOperator(
  email = 'agent@test.local',
  role: 'admin' | 'agent' | 'viewer' = 'agent',
) {
  const row = (
    await db
      .insert(operators)
      .values({ email, name: 'Test Operator', role, passwordHash: await hashPassword('pw') })
      .returning()
  )[0]!;
  return { kind: 'operator' as const, id: row.id, email: row.email };
}

export function testDeps(overrides: Partial<PipelineDeps> = {}, policy: PolicyConfig = DEFAULT_POLICY): PipelineDeps {
  return {
    db,
    classifier: new FakeClassifier(),
    executor: new FakeExecutor(),
    notifier: new FakeNotifier(),
    policy,
    logger: silentLogger,
    appUrl: 'http://localhost:3000',
    llmTimeoutMs: 5000,
    llmMaxRetries: 1,
    retryOverrides: { sleep: async () => {}, random: () => 1 },
    ...overrides,
  };
}
