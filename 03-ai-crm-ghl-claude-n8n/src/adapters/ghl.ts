import type { GhlLead } from '../domain/lead.js';
import type { Decision } from '../domain/qualification.js';
import { CrmError } from '../lib/errors.js';
import type { CrmPort, CrmUpdateResult } from '../ports.js';

export interface GhlOptions {
  accessToken: string;
  locationId: string;
  baseUrl?: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
}

/** The custom fields this integration owns on the contact. */
export const GHL_FIELD_KEYS = [
  'ai_lead_score',
  'ai_qualification',
  'ai_reason',
  'ai_confidence',
  'ai_next_action',
  'ai_route',
  'ai_processed_at',
] as const;

/**
 * GoHighLevel Contacts API (LeadConnector v2).
 *
 * Two things shape this adapter:
 *  1. Custom fields are addressed by **id**, not by key, on the write path. The
 *     ids are per-location, so they are looked up once from
 *     `/locations/{id}/customFields` and cached — hardcoding them would make
 *     the integration work in exactly one sub-account.
 *  2. A tag is written alongside the fields, because GHL workflow triggers fire
 *     on tags far more reliably than on custom-field changes. The tag is what
 *     the downstream follow-up workflow actually listens to.
 */
export class GhlCrm implements CrmPort {
  readonly name = 'ghl';
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private fieldIdsByKey: Map<string, string> | null = null;

  constructor(private readonly options: GhlOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? 'https://services.leadconnectorhq.com';
    this.apiVersion = options.apiVersion ?? '2021-07-28';
  }

  async writeQualification(lead: GhlLead, decision: Decision): Promise<CrmUpdateResult> {
    const fieldIds = await this.customFieldIds();

    const values: Record<string, string> = {
      ai_lead_score: String(decision.lead_score),
      ai_qualification: decision.qualification,
      ai_reason: decision.reason.slice(0, 1000),
      ai_confidence: decision.confidence.toFixed(2),
      ai_next_action: decision.next_action,
      ai_route: decision.route,
      ai_processed_at: new Date().toISOString(),
    };

    const customFields = Object.entries(values)
      .map(([key, value]) => {
        const id = fieldIds.get(key);
        return id ? { id, field_value: value } : null;
      })
      .filter((f): f is { id: string; field_value: string } => f !== null);

    if (customFields.length === 0) {
      throw new CrmError(
        `No AI custom fields found in location ${this.options.locationId}. Create them first — see docs/ghl-setup.md.`,
        false,
      );
    }

    const response = await this.request('PUT', `/contacts/${encodeURIComponent(lead.contact_id)}`, {
      customFields,
      // The routing tag is the downstream trigger, not decoration.
      tags: [...new Set([...lead.tags, `ai-${decision.route.replace(/_/g, '-')}`])],
    });

    await this.expectOk(response, 'update contact');
    return {
      contactId: lead.contact_id,
      unchanged: false,
      fieldsWritten: customFields.map((f) => f.id),
    };
  }

  /** Looked up once per process; the ids are stable for a location. */
  private async customFieldIds(): Promise<Map<string, string>> {
    if (this.fieldIdsByKey) return this.fieldIdsByKey;

    const response = await this.request(
      'GET',
      `/locations/${encodeURIComponent(this.options.locationId)}/customFields`,
    );
    const body = await this.expectOk(response, 'list custom fields');
    const fields = (body.customFields ?? []) as Array<{ id: string; fieldKey?: string; key?: string }>;

    const map = new Map<string, string>();
    for (const field of fields) {
      // GHL returns `fieldKey` prefixed with the object type, e.g.
      // "contact.ai_lead_score". Match on the trailing segment.
      const raw = field.fieldKey ?? field.key ?? '';
      const key = raw.includes('.') ? raw.slice(raw.lastIndexOf('.') + 1) : raw;
      if ((GHL_FIELD_KEYS as readonly string[]).includes(key)) map.set(key, field.id);
    }

    this.fieldIdsByKey = map;
    return map;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.options.accessToken}`,
          version: this.apiVersion,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      // No response at all — a network fault, always worth retrying.
      throw new CrmError(`GoHighLevel request failed: ${method} ${path}`, true, cause);
    }
  }

  private async expectOk(response: Response, action: string): Promise<Record<string, unknown>> {
    if (response.ok) return (await response.json().catch(() => ({}))) as Record<string, unknown>;

    const detail = await response.text().catch(() => '');
    // 429 and 5xx are transient; a 4xx means we sent something wrong and a
    // retry would send exactly the same thing again.
    const retryable = response.status === 429 || response.status >= 500;
    const error = new CrmError(
      `GoHighLevel failed to ${action}: ${response.status} ${detail.slice(0, 300)}`,
      retryable,
    );
    const retryAfter = Number(response.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter >= 0) {
      Object.assign(error, { retryAfterMs: retryAfter * 1000 });
    }
    throw error;
  }
}
