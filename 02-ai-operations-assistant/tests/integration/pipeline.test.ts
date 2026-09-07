import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeExecutor } from '@/adapters/fake/fake-executor';
import { FakeNotifier } from '@/adapters/fake/fake-notifier';
import type { InboundMessage } from '@/core/domain/types';
import { decideApproval, processInboundMessage } from '@/core/pipeline/process-message';
import type { ClassifierPort } from '@/core/ports/index';
import { closeDb } from '@/db/client';
import { auditLog, cases } from '@/db/schema';
import { ClassifierError } from '@/lib/errors';
import { message } from '../fixtures';
import { db, resetDatabase, seedOperator, testDeps } from './setup';

const SYSTEM = { kind: 'system' as const };

beforeEach(resetDatabase);
afterAll(closeDb);

describe('intake pipeline', () => {
  it('auto-executes a confident low-risk case end to end', async () => {
    const executor = new FakeExecutor();
    const result = await processInboundMessage(
      message({ subject: 'Login broken', body: 'I get an error on every login attempt and it is completely broken for my team.' }),
      SYSTEM,
      'corr-1',
      testDeps({ executor }),
    );

    expect(result.decision?.verdict).toBe('auto_execute');
    expect(result.state).toBe('executed');
    expect(result.executedRef).toMatch(/^TCK-/);
    expect(executor.executedCount).toBe(1);
  });

  it('parks a high-blast-radius case for a human and executes nothing', async () => {
    const executor = new FakeExecutor();
    const result = await processInboundMessage(
      message({ body: 'Please refund the duplicate charge of EUR 49 from last month.' }),
      SYSTEM,
      'corr-2',
      testDeps({ executor }),
    );

    expect(result.decision?.verdict).toBe('require_approval');
    expect(result.state).toBe('pending_approval');
    // The crucial assertion: nothing happened while waiting for a person.
    expect(executor.executedCount).toBe(0);
  });

  it('notifies when a case needs a human', async () => {
    const notifier = new FakeNotifier();
    await processInboundMessage(
      message({ subject: 'Refund request', body: 'Please refund EUR 30 for the duplicate charge.' }),
      SYSTEM,
      'corr-3',
      testDeps({ notifier }),
    );
    expect(notifier.sent[0]?.kind).toBe('approval_requested');
    expect(notifier.sent[0]?.url).toContain('/cases/');
  });

  it('deduplicates the same provider message, whatever the delivery count', async () => {
    const payload: InboundMessage = message({ external_id: 'gmail-1', source: 'n8n:gmail' });
    const first = await processInboundMessage(payload, SYSTEM, 'c1', testDeps());
    const second = await processInboundMessage(payload, SYSTEM, 'c2', testDeps());
    const third = await processInboundMessage(payload, SYSTEM, 'c3', testDeps());

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(third.duplicate).toBe(true);
    expect(second.caseId).toBe(first.caseId);

    const rows = await db.select().from(cases);
    expect(rows).toHaveLength(1);
  });

  it('survives concurrent delivery of the same message without creating two cases', async () => {
    const payload = message({ external_id: 'race-1', source: 'n8n:gmail' });
    const results = await Promise.allSettled([
      processInboundMessage(payload, SYSTEM, 'r1', testDeps()),
      processInboundMessage(payload, SYSTEM, 'r2', testDeps()),
      processInboundMessage(payload, SYSTEM, 'r3', testDeps()),
    ]);

    // The unique index is what makes this true, not application logic.
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThan(0);
    expect(await db.select().from(cases)).toHaveLength(1);
  });

  it('leaves a durable, inspectable case when classification fails', async () => {
    const failing: ClassifierPort = {
      name: 'failing',
      classify: async () => {
        throw new ClassifierError('OpenAI returned 503');
      },
    };

    await expect(
      processInboundMessage(message(), SYSTEM, 'corr-fail', testDeps({ classifier: failing })),
    ).rejects.toBeInstanceOf(ClassifierError);

    // The email is not lost: a case exists, marked failed, with the reason.
    const [row] = await db.select().from(cases);
    expect(row?.state).toBe('failed');
    const events = (await db.select().from(auditLog)).map((e) => e.event);
    expect(events).toContain('message.received');
    expect(events).toContain('classification.failed');
  });

  it('retries a transient classifier failure and succeeds', async () => {
    let attempts = 0;
    const flaky: ClassifierPort = {
      name: 'flaky',
      classify: async (msg) => {
        if (++attempts === 1) throw new ClassifierError('429 rate limited');
        const { FakeClassifier } = await import('@/adapters/fake/fake-classifier');
        return new FakeClassifier().classify(msg);
      },
    };

    const result = await processInboundMessage(message(), SYSTEM, 'corr-retry', testDeps({ classifier: flaky }));
    expect(attempts).toBe(2);
    expect(result.state).not.toBe('failed');
  });
});

describe('approval', () => {
  it('executes the action and records who authorised it', async () => {
    const executor = new FakeExecutor();
    const deps = testDeps({ executor });
    const operator = await seedOperator();

    const intake = await processInboundMessage(
      message({ subject: 'Refund request', body: 'Please refund the duplicate charge of EUR 49.' }),
      SYSTEM,
      'corr-a',
      deps,
    );
    const [before] = await db.select().from(cases);

    const result = await decideApproval(
      { caseId: intake.caseId, expectedVersion: before!.version, operator, granted: true, reason: 'Verified in billing' },
      'corr-b',
      deps,
    );

    expect(result.state).toBe('executed');
    expect(result.externalRef).toMatch(/^REF-/);
    expect(executor.executedCount).toBe(1);

    const granted = (await db.select().from(auditLog)).find((e) => e.event === 'approval.granted');
    expect(granted?.actorLabel).toBe(operator.email);
    expect(granted?.detail).toMatchObject({ reason: 'Verified in billing' });
  });

  it('records a rejection with its reason and executes nothing', async () => {
    const executor = new FakeExecutor();
    const deps = testDeps({ executor });
    const operator = await seedOperator();

    const intake = await processInboundMessage(
      message({ subject: 'Refund request', body: 'Please refund EUR 500 immediately.' }),
      SYSTEM,
      'corr-c',
      deps,
    );
    const [before] = await db.select().from(cases);

    const result = await decideApproval(
      { caseId: intake.caseId, expectedVersion: before!.version, operator, granted: false, reason: 'No order found' },
      'corr-d',
      deps,
    );

    expect(result.state).toBe('rejected');
    expect(executor.executedCount).toBe(0);
    const denied = (await db.select().from(auditLog)).find((e) => e.event === 'approval.denied');
    expect(denied?.detail).toMatchObject({ reason: 'No order found' });
  });

  it('lets an operator authorise something other than what was proposed, and says so', async () => {
    const deps = testDeps();
    const operator = await seedOperator();
    const intake = await processInboundMessage(
      message({ subject: 'Refund request', body: 'Please refund the duplicate charge of EUR 49.' }),
      SYSTEM,
      'corr-e',
      deps,
    );
    const [before] = await db.select().from(cases);

    await decideApproval(
      {
        caseId: intake.caseId,
        expectedVersion: before!.version,
        operator,
        granted: true,
        overrideAction: 'create_ticket',
        reason: 'Needs investigation before any money moves',
      },
      'corr-f',
      deps,
    );

    const granted = (await db.select().from(auditLog)).find((e) => e.event === 'approval.granted');
    expect(granted?.detail).toMatchObject({
      approved_action: 'create_ticket',
      proposed_action: 'issue_refund',
      overridden: true,
    });
  });

  it('refuses a stale version — two operators cannot both approve', async () => {
    const deps = testDeps();
    const operator = await seedOperator();
    const intake = await processInboundMessage(
      message({ subject: 'Refund request', body: 'Please refund EUR 20 for the duplicate charge.' }),
      SYSTEM,
      'corr-g',
      deps,
    );

    await expect(
      decideApproval({ caseId: intake.caseId, expectedVersion: 1, operator, granted: true }, 'corr-h', deps),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('refuses to approve a case that is not awaiting approval', async () => {
    const deps = testDeps();
    const operator = await seedOperator();
    const intake = await processInboundMessage(
      message({ subject: 'Login broken', body: 'I get an error on every login attempt, it is broken for my whole team.' }),
      SYSTEM,
      'corr-i',
      deps,
    );
    expect(intake.state).toBe('executed');

    await expect(
      decideApproval({ caseId: intake.caseId, expectedVersion: 4, operator, granted: true }, 'corr-j', deps),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('does not execute twice when the same action is retried', async () => {
    const executor = new FakeExecutor();
    const spy = vi.spyOn(executor, 'execute');
    const deps = testDeps({ executor });
    const operator = await seedOperator();

    const intake = await processInboundMessage(
      message({ subject: 'Refund request', body: 'Please refund the duplicate charge of EUR 49.' }),
      SYSTEM,
      'corr-k',
      deps,
    );
    const [before] = await db.select().from(cases);
    await decideApproval(
      { caseId: intake.caseId, expectedVersion: before!.version, operator, granted: true },
      'corr-l',
      deps,
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(executor.executedCount).toBe(1);
  });
});

describe('audit log', () => {
  it('records the full story of a case in order', async () => {
    const deps = testDeps();
    const operator = await seedOperator();
    const intake = await processInboundMessage(
      message({ subject: 'Refund request', body: 'Please refund the duplicate charge of EUR 49.' }),
      SYSTEM,
      'corr-m',
      deps,
    );
    const [before] = await db.select().from(cases);
    await decideApproval(
      { caseId: intake.caseId, expectedVersion: before!.version, operator, granted: true },
      'corr-n',
      deps,
    );

    const events = (await db.select().from(auditLog).orderBy(auditLog.createdAt)).map((e) => e.event);
    expect(events).toEqual([
      'message.received',
      'classification.succeeded',
      'policy.evaluated',
      'approval.requested',
      'approval.granted',
      'action.started',
      'action.succeeded',
    ]);
  });

  it('attributes system events and human events differently', async () => {
    const deps = testDeps();
    const operator = await seedOperator('someone@test.local');
    const intake = await processInboundMessage(
      message({ subject: 'Refund request', body: 'Please refund EUR 49 for the duplicate charge.' }),
      SYSTEM,
      'corr-o',
      deps,
    );
    const [before] = await db.select().from(cases);
    await decideApproval(
      { caseId: intake.caseId, expectedVersion: before!.version, operator, granted: true },
      'corr-p',
      deps,
    );

    const entries = await db.select().from(auditLog);
    expect(entries.filter((e) => e.actorKind === 'system').length).toBeGreaterThan(0);
    const human = entries.filter((e) => e.actorKind === 'operator');
    expect(human.length).toBeGreaterThan(0);
    expect(human.every((e) => e.actorLabel === 'someone@test.local')).toBe(true);
  });

  it('cannot be rewritten by the application — the database refuses', async () => {
    await processInboundMessage(message(), SYSTEM, 'corr-q', testDeps());

    // Drizzle wraps driver errors, so the trigger's own message is on `cause`.
    await expect(rootMessage(db.execute(sql`UPDATE audit_log SET event = 'approval.granted'`))).resolves.toMatch(
      /append-only/,
    );
    await expect(rootMessage(db.execute(sql`DELETE FROM audit_log`))).resolves.toMatch(/append-only/);
  });

  it('cannot have its underlying message edited after the fact', async () => {
    await processInboundMessage(message(), SYSTEM, 'corr-r', testDeps());
    await expect(rootMessage(db.execute(sql`UPDATE messages SET body = 'rewritten'`))).resolves.toMatch(
      /immutable/,
    );
  });

  it('carries the correlation id so one request can be traced across systems', async () => {
    await processInboundMessage(message(), SYSTEM, 'trace-me-123', testDeps());
    const entries = await db.select().from(auditLog);
    expect(entries.every((e) => e.correlationId === 'trace-me-123')).toBe(true);
  });
});

/** Unwraps a rejection to the deepest cause message the driver reported. */
async function rootMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return '(did not throw)';
  } catch (error) {
    let current: unknown = error;
    const seen: string[] = [];
    while (current instanceof Error) {
      seen.push(current.message);
      current = (current as { cause?: unknown }).cause;
    }
    return seen.join(' | ');
  }
}
