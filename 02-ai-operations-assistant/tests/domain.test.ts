import { describe, expect, it } from 'vitest';
import {
  CASE_STATES,
  IllegalTransitionError,
  InboundMessageSchema,
  TERMINAL_STATES,
  assertTransition,
  canTransition,
} from '@/core/domain/types';
import { actionIdempotencyKey } from '@/core/pipeline/process-message';
import { classification, message } from './fixtures';

describe('inbound message validation', () => {
  it('accepts a well-formed message', () => {
    const parsed = InboundMessageSchema.parse(message());
    expect(parsed.from_email).toBe('customer@acme.co');
    expect(parsed.source).toBe('test');
  });

  it('normalises email casing and padding, as real providers send them', () => {
    const parsed = InboundMessageSchema.parse(message({ from_email: '  Customer@ACME.co ' }));
    expect(parsed.from_email).toBe('customer@acme.co');
  });

  it('rejects an empty body — there is nothing to classify', () => {
    expect(() => InboundMessageSchema.parse(message({ body: '' }))).toThrow();
  });

  it('rejects a malformed sender address', () => {
    expect(() => InboundMessageSchema.parse(message({ from_email: 'not-an-email' }))).toThrow();
  });

  it('defaults source to unknown rather than failing', () => {
    const { source: _omit, ...rest } = message();
    expect(InboundMessageSchema.parse(rest).source).toBe('unknown');
  });
});

describe('case state machine', () => {
  it('allows the happy path through to executed', () => {
    expect(canTransition('received', 'classified')).toBe(true);
    expect(canTransition('classified', 'pending_approval')).toBe(true);
    expect(canTransition('pending_approval', 'approved')).toBe(true);
    expect(canTransition('approved', 'executing')).toBe(true);
    expect(canTransition('executing', 'executed')).toBe(true);
  });

  it('allows the auto-execute path, which skips approval', () => {
    expect(canTransition('classified', 'executing')).toBe(true);
  });

  it('refuses to skip classification', () => {
    expect(canTransition('received', 'executed')).toBe(false);
    expect(canTransition('received', 'approved')).toBe(false);
  });

  it('refuses to move out of a terminal state', () => {
    for (const terminal of ['executed', 'rejected'] as const) {
      for (const state of CASE_STATES) {
        expect(canTransition(terminal, state)).toBe(false);
      }
    }
  });

  it('treats executed, rejected and dead_lettered as terminal', () => {
    expect(TERMINAL_STATES).toEqual(['executed', 'rejected', 'dead_lettered']);
  });

  it('allows a failed case to be retried or dead-lettered', () => {
    expect(canTransition('failed', 'classified')).toBe(true);
    expect(canTransition('failed', 'executing')).toBe(true);
    expect(canTransition('failed', 'dead_lettered')).toBe(true);
  });

  it('throws a descriptive error naming the legal transitions', () => {
    expect(() => assertTransition('executed', 'approved')).toThrow(IllegalTransitionError);
    try {
      assertTransition('received', 'executed');
    } catch (error) {
      expect((error as Error).message).toContain('Legal from received');
    }
  });
});

describe('action idempotency key', () => {
  it('is stable for the same case, action and parameters', () => {
    const c = classification({ proposed_action: 'issue_refund', refund_amount_eur: 49 });
    expect(actionIdempotencyKey('case-1', 'issue_refund', c)).toBe(
      actionIdempotencyKey('case-1', 'issue_refund', c),
    );
  });

  it('differs across cases and across actions', () => {
    const c = classification();
    expect(actionIdempotencyKey('case-1', 'create_ticket', c)).not.toBe(
      actionIdempotencyKey('case-2', 'create_ticket', c),
    );
    expect(actionIdempotencyKey('case-1', 'create_ticket', c)).not.toBe(
      actionIdempotencyKey('case-1', 'issue_refund', c),
    );
  });

  it('differs when the refund amount differs — a changed amount is a new action, not a duplicate', () => {
    const forty = classification({ proposed_action: 'issue_refund', refund_amount_eur: 40 });
    const fifty = classification({ proposed_action: 'issue_refund', refund_amount_eur: 50 });
    expect(actionIdempotencyKey('c', 'issue_refund', forty)).not.toBe(
      actionIdempotencyKey('c', 'issue_refund', fifty),
    );
  });
});
