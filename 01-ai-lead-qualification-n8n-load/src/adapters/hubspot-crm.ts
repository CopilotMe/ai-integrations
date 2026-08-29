import type { Lead } from '../domain/lead.js';
import type { Qualification } from '../domain/qualification.js';
import { CrmError } from '../pipeline/errors.js';
import type { CreateDealInput, CrmContact, CrmDeal, CrmPort } from '../ports/crm.js';

export interface HubSpotOptions {
  accessToken: string;
  pipelineId: string;
  dealStageHot: string;
  dealStageWarm: string;
  baseUrl?: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.hubapi.com';

/**
 * HubSpot CRM v3.
 *
 * Two things drive the shape of this adapter:
 *  1. HubSpot has no upsert-by-email, so a create that collides returns 409 and
 *     we have to search and patch instead.
 *  2. Everything is retried by the caller, so every write has to be safe to
 *     repeat — hence `spesti_idempotency_key` on deals.
 */
export class HubSpotCrm implements CrmPort {
  readonly name = 'hubspot';
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: HubSpotOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  }

  async upsertContact(lead: Lead, qualification: Qualification): Promise<CrmContact> {
    const properties = {
      email: lead.email,
      firstname: lead.name.split(' ')[0] ?? lead.name,
      lastname: lead.name.split(' ').slice(1).join(' ') || undefined,
      company: lead.company,
      numemployees: lead.employees?.toString(),
      hs_lead_status: qualification.classification === 'COLD' ? 'UNQUALIFIED' : 'OPEN',
      lead_score: qualification.score.toString(),
      lead_classification: qualification.classification,
      lead_industry: qualification.industry,
      lead_reason: qualification.reason,
    };

    const created = await this.request('POST', '/crm/v3/objects/contacts', { properties });

    if (created.status === 409) {
      const existingId = await this.findContactIdByEmail(lead.email);
      if (!existingId) {
        // 409 without a findable contact means HubSpot's search index has not
        // caught up. Retryable — the caller backs off and tries again.
        throw new CrmError(`Contact ${lead.email} conflicted but was not found`, true);
      }
      await this.expectOk(
        await this.request('PATCH', `/crm/v3/objects/contacts/${existingId}`, { properties }),
        'update contact',
      );
      return { id: existingId, email: lead.email, existing: true };
    }

    const body = await this.expectOk(created, 'create contact');
    return { id: String(body.id), email: lead.email, existing: false };
  }

  async createDeal(input: CreateDealInput): Promise<CrmDeal> {
    const { lead, qualification, contactId, idempotencyKey } = input;

    const duplicate = await this.findDealByIdempotencyKey(idempotencyKey);
    if (duplicate) return { ...duplicate, existing: true };

    const name = `${lead.company ?? lead.name} — inbound (${qualification.classification})`;
    const stage =
      qualification.classification === 'HOT' ? this.options.dealStageHot : this.options.dealStageWarm;

    const response = await this.request('POST', '/crm/v3/objects/deals', {
      properties: {
        dealname: name,
        amount: qualification.estimated_value.toString(),
        pipeline: this.options.pipelineId,
        dealstage: stage,
        spesti_idempotency_key: idempotencyKey,
      },
      associations: [
        {
          to: { id: contactId },
          // 3 = deal-to-contact in HubSpot's default association type table.
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }],
        },
      ],
    });

    const body = await this.expectOk(response, 'create deal');
    return {
      id: String(body.id),
      name,
      amount: qualification.estimated_value,
      stage,
      existing: false,
    };
  }

  private async findContactIdByEmail(email: string): Promise<string | null> {
    const response = await this.request('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      limit: 1,
    });
    const body = await this.expectOk(response, 'search contacts');
    const first = (body.results as Array<{ id: string }> | undefined)?.[0];
    return first ? String(first.id) : null;
  }

  private async findDealByIdempotencyKey(
    key: string,
  ): Promise<Omit<CrmDeal, 'existing'> | null> {
    const response = await this.request('POST', '/crm/v3/objects/deals/search', {
      filterGroups: [
        { filters: [{ propertyName: 'spesti_idempotency_key', operator: 'EQ', value: key }] },
      ],
      properties: ['dealname', 'amount', 'dealstage'],
      limit: 1,
    });
    const body = await this.expectOk(response, 'search deals');
    const first = (body.results as Array<{ id: string; properties: Record<string, string> }> | undefined)?.[0];
    if (!first) return null;
    return {
      id: String(first.id),
      name: first.properties.dealname ?? '',
      amount: Number(first.properties.amount ?? 0),
      stage: first.properties.dealstage ?? '',
    };
  }

  private async request(method: string, path: string, body: unknown): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.options.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      // Network-level failure: no response at all, always worth retrying.
      throw new CrmError(`HubSpot request failed: ${method} ${path}`, true, cause);
    }
  }

  private async expectOk(response: Response, action: string): Promise<Record<string, unknown>> {
    if (response.ok) {
      return (await response.json().catch(() => ({}))) as Record<string, unknown>;
    }
    const detail = await response.text().catch(() => '');
    // 429 and 5xx are transient; 4xx means we sent something wrong and a retry
    // would send exactly the same thing again.
    const retryable = response.status === 429 || response.status >= 500;
    const error = new CrmError(
      `HubSpot failed to ${action}: ${response.status} ${detail.slice(0, 300)}`,
      retryable,
    );
    const retryAfter = Number(response.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter >= 0) {
      Object.assign(error, { retryAfterMs: retryAfter * 1000 });
    }
    throw error;
  }
}
