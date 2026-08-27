import { describe, expect, it, vi } from 'vitest';
import { FakeCrm } from '../src/adapters/fake/fake-crm.js';
import { FakeLlm } from '../src/adapters/fake/fake-llm.js';
import { FakeNotifier } from '../src/adapters/fake/fake-notifier.js';
import { InMemoryDeadLetter } from '../src/lib/deadletter.js';
import { CrmError, NotifierError, ValidationError } from '../src/pipeline/errors.js';
import { processLead, type ProcessDeps } from '../src/pipeline/process-lead.js';
import type { CrmPort } from '../src/ports/crm.js';
import { coldLead, hotLead, instantRetries, silentLogger, testRules, warmLead } from './fixtures/leads.js';

function buildDeps(overrides: Partial<ProcessDeps> = {}) {
  const crm = new FakeCrm();
  const notifier = new FakeNotifier();
  const deadLetter = new InMemoryDeadLetter();
  const deps: ProcessDeps = {
    llm: new FakeLlm(),
    crm,
    notifier,
    deadLetter,
    rules: testRules,
    logger: silentLogger,
    llmTimeoutMs: 1000,
    llmMaxRetries: 1,
    retryOverrides: instantRetries,
    now: () => new Date('2026-08-27T10:00:00.000Z'),
    ...overrides,
  };
  return { deps, crm, notifier, deadLetter };
}

describe('processLead', () => {
  it('creates a contact, a deal and a notification for a HOT lead', async () => {
    const { deps, crm, notifier } = buildDeps();
    const result = await processLead(hotLead, 'corr-1', deps);

    expect(result.qualification.classification).toBe('HOT');
    expect(result.qualification.next_action).toBe('sales_call');
    expect(result.crm.contact?.existing).toBe(false);
    expect(result.crm.deal).not.toBeNull();
    expect(result.notified).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.suggested_reply).toBeTruthy();
    expect(crm.contactCount).toBe(1);
    expect(notifier.sent).toHaveLength(1);
  });

  it('creates a contact and a deal for a WARM lead', async () => {
    const { deps } = buildDeps();
    const result = await processLead(warmLead, 'corr-2', deps);
    expect(result.qualification.classification).toBe('WARM');
    expect(result.crm.deal).not.toBeNull();
  });

  it('creates a contact but no deal for a COLD lead', async () => {
    const { deps, crm } = buildDeps();
    const result = await processLead(coldLead, 'corr-3', deps);

    expect(result.qualification.classification).toBe('COLD');
    expect(result.qualification.next_action).toBe('archive');
    expect(result.crm.deal).toBeNull();
    expect(result.suggested_reply).toBeNull();
    expect(crm.dealCount).toBe(0);
  });

  it('is idempotent: a redelivered webhook does not duplicate the contact or deal', async () => {
    const { deps, crm } = buildDeps();
    const first = await processLead(hotLead, 'corr-4a', deps);
    const second = await processLead(hotLead, 'corr-4b', deps);

    expect(second.idempotency_key).toBe(first.idempotency_key);
    expect(second.crm.contact?.existing).toBe(true);
    expect(second.crm.deal?.existing).toBe(true);
    expect(crm.contactCount).toBe(1);
    expect(crm.dealCount).toBe(1);
  });

  it('rejects an invalid lead before any external call is made', async () => {
    const upsertContact = vi.fn();
    const { deps } = buildDeps({
      crm: { name: 'spy', upsertContact, createDeal: vi.fn() } as unknown as CrmPort,
    });

    await expect(processLead({ name: 'X', message: 'hi' }, 'corr-5', deps)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(upsertContact).not.toHaveBeenCalled();
  });

  it('retries a transient CRM failure and succeeds', async () => {
    const inner = new FakeCrm();
    let attempts = 0;
    const flaky: CrmPort = {
      name: 'flaky',
      upsertContact: async (lead, q) => {
        if (++attempts === 1) throw new CrmError('503 from HubSpot', true);
        return inner.upsertContact(lead, q);
      },
      createDeal: (input) => inner.createDeal(input),
    };

    const { deps, deadLetter } = buildDeps({ crm: flaky });
    const result = await processLead(hotLead, 'corr-6', deps);

    expect(attempts).toBe(2);
    expect(result.crm.contact).not.toBeNull();
    expect(deadLetter.entries).toHaveLength(0);
  });

  it('dead-letters and fails the request when the contact write is unrecoverable', async () => {
    const dead: CrmPort = {
      name: 'dead',
      upsertContact: async () => {
        throw new CrmError('503 from HubSpot', true);
      },
      createDeal: vi.fn(),
    };

    const { deps, deadLetter } = buildDeps({ crm: dead, crmMaxRetries: 1 });
    await expect(processLead(hotLead, 'corr-7', deps)).rejects.toBeInstanceOf(CrmError);

    expect(deadLetter.entries).toHaveLength(1);
    expect(deadLetter.entries[0]).toMatchObject({
      correlationId: 'corr-7',
      stage: 'crm.upsertContact',
      at: '2026-08-27T10:00:00.000Z',
    });
  });

  it('dead-letters a failed deal but still succeeds — the contact is already saved', async () => {
    const inner = new FakeCrm();
    const partial: CrmPort = {
      name: 'partial',
      upsertContact: (lead, q) => inner.upsertContact(lead, q),
      createDeal: async () => {
        throw new CrmError('deal pipeline misconfigured', false);
      },
    };

    const { deps, deadLetter } = buildDeps({ crm: partial });
    const result = await processLead(hotLead, 'corr-8', deps);

    expect(result.crm.contact).not.toBeNull();
    expect(result.crm.deal).toBeNull();
    expect(result.warnings).toContain('deal_creation_failed');
    expect(deadLetter.entries[0]?.stage).toBe('crm.createDeal');
  });

  it('does not fail the lead when Slack is down', async () => {
    const { deps } = buildDeps({
      notifier: {
        name: 'broken',
        notify: async () => {
          throw new NotifierError('Slack webhook returned 500');
        },
      },
    });

    const result = await processLead(hotLead, 'corr-9', deps);
    expect(result.notified).toBe(false);
    expect(result.warnings).toContain('notification_failed');
    expect(result.crm.contact).not.toBeNull();
  });

  it('passes the draft reply and CRM ids through to the notifier', async () => {
    const { deps, notifier } = buildDeps();
    await processLead(hotLead, 'corr-10', deps);

    const sent = notifier.sent[0];
    expect(sent?.suggestedReply).toBeTruthy();
    expect(sent?.contact?.id).toMatch(/^contact_/);
    expect(sent?.deal?.id).toMatch(/^deal_/);
  });
});
