import { describe, expect, it, vi } from 'vitest';
import { FakeCrm } from '../src/adapters/fake/fake-crm.js';
import { HubSpotCrm } from '../src/adapters/hubspot-crm.js';
import { decide } from '../src/domain/routing.js';
import { idempotencyKey } from '../src/domain/lead.js';
import { CrmError } from '../src/pipeline/errors.js';
import { parseLead } from '../src/pipeline/qualify-lead.js';
import { assessment, hotLead, testRules } from './fixtures/leads.js';

const lead = parseLead(hotLead);
const qualification = decide(lead, assessment({ score: 85 }), testRules);

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('HubSpot adapter', () => {
  it('creates a contact and a deal for a new lead', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/deals/search')) return jsonResponse(200, { results: [] });
      if (path.endsWith('/objects/contacts')) return jsonResponse(201, { id: 501 });
      if (path.endsWith('/objects/deals')) return jsonResponse(201, { id: 901 });
      throw new Error(`unexpected call to ${path}`);
    }) as unknown as typeof fetch;

    const crm = new HubSpotCrm({
      accessToken: 't',
      pipelineId: 'default',
      dealStageHot: 'appointmentscheduled',
      dealStageWarm: 'qualifiedtobuy',
      fetchImpl,
    });

    const contact = await crm.upsertContact(lead, qualification);
    expect(contact).toMatchObject({ id: '501', existing: false });

    const deal = await crm.createDeal({
      contactId: contact.id,
      lead,
      qualification,
      idempotencyKey: idempotencyKey(lead),
    });
    expect(deal).toMatchObject({ id: '901', stage: 'appointmentscheduled', existing: false });
  });

  it('updates instead of duplicating when the contact already exists (409)', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      calls.push(`${init?.method} ${path.replace('https://api.hubapi.com', '')}`);
      if (path.endsWith('/objects/contacts')) return jsonResponse(409, { message: 'Contact already exists' });
      if (path.endsWith('/contacts/search')) return jsonResponse(200, { results: [{ id: 777 }] });
      if (path.includes('/objects/contacts/777')) return jsonResponse(200, { id: 777 });
      throw new Error(`unexpected call to ${path}`);
    }) as unknown as typeof fetch;

    const crm = new HubSpotCrm({
      accessToken: 't',
      pipelineId: 'default',
      dealStageHot: 'a',
      dealStageWarm: 'b',
      fetchImpl,
    });

    const contact = await crm.upsertContact(lead, qualification);
    expect(contact).toMatchObject({ id: '777', existing: true });
    expect(calls).toEqual([
      'POST /crm/v3/objects/contacts',
      'POST /crm/v3/objects/contacts/search',
      'PATCH /crm/v3/objects/contacts/777',
    ]);
  });

  it('returns the existing deal when the idempotency key already matches one', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/deals/search')) {
        return jsonResponse(200, {
          results: [{ id: 42, properties: { dealname: 'Acme Ltd — inbound (HOT)', amount: '25000', dealstage: 'appointmentscheduled' } }],
        });
      }
      throw new Error('must not create a second deal');
    }) as unknown as typeof fetch;

    const crm = new HubSpotCrm({
      accessToken: 't',
      pipelineId: 'default',
      dealStageHot: 'a',
      dealStageWarm: 'b',
      fetchImpl,
    });

    const deal = await crm.createDeal({
      contactId: '1',
      lead,
      qualification,
      idempotencyKey: idempotencyKey(lead),
    });
    expect(deal).toMatchObject({ id: '42', existing: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('marks 5xx and 429 as retryable and 4xx as permanent', async () => {
    const respond = (status: number, headers: Record<string, string> = {}) => {
      const fetchImpl = vi.fn(async () => jsonResponse(status, { message: 'nope' }, headers)) as unknown as typeof fetch;
      return new HubSpotCrm({
        accessToken: 't',
        pipelineId: 'default',
        dealStageHot: 'a',
        dealStageWarm: 'b',
        fetchImpl,
      });
    };

    await expect(respond(503).upsertContact(lead, qualification)).rejects.toMatchObject({
      code: 'crm_error',
      retryable: true,
    });
    await expect(respond(429, { 'retry-after': '2' }).upsertContact(lead, qualification)).rejects.toMatchObject({
      retryable: true,
      retryAfterMs: 2000,
    });
    await expect(respond(400).upsertContact(lead, qualification)).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('treats a network-level failure as retryable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    const crm = new HubSpotCrm({
      accessToken: 't',
      pipelineId: 'default',
      dealStageHot: 'a',
      dealStageWarm: 'b',
      fetchImpl,
    });

    await expect(crm.upsertContact(lead, qualification)).rejects.toBeInstanceOf(CrmError);
    await expect(crm.upsertContact(lead, qualification)).rejects.toMatchObject({ retryable: true });
  });
});

describe('fake CRM', () => {
  it('deduplicates contacts by email and deals by idempotency key', async () => {
    const crm = new FakeCrm();
    const key = idempotencyKey(lead);

    const first = await crm.upsertContact(lead, qualification);
    const second = await crm.upsertContact(lead, qualification);
    expect(first.existing).toBe(false);
    expect(second.existing).toBe(true);
    expect(crm.contactCount).toBe(1);

    await crm.createDeal({ contactId: first.id, lead, qualification, idempotencyKey: key });
    const repeat = await crm.createDeal({ contactId: first.id, lead, qualification, idempotencyKey: key });
    expect(repeat.existing).toBe(true);
    expect(crm.dealCount).toBe(1);
  });
});
