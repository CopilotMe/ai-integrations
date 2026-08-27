import type { Lead } from '../../domain/lead.js';
import type { Qualification } from '../../domain/qualification.js';
import type { CreateDealInput, CrmContact, CrmDeal, CrmPort } from '../../ports/crm.js';

export interface FakeCrmRecord {
  contact: CrmContact;
  qualification: Qualification;
}

/**
 * In-memory CRM with the two behaviours that actually matter for correctness:
 * contacts are keyed by email (so a repeat submission updates rather than
 * duplicates), and deals are keyed by idempotency key (so a retried webhook
 * delivery does not create a second deal).
 */
export class FakeCrm implements CrmPort {
  readonly name = 'fake';
  private readonly contactsByEmail = new Map<string, CrmContact>();
  private readonly dealsByKey = new Map<string, CrmDeal>();
  private sequence = 0;

  async upsertContact(lead: Lead, _qualification: Qualification): Promise<CrmContact> {
    const existing = this.contactsByEmail.get(lead.email);
    if (existing) return { ...existing, existing: true };

    const contact: CrmContact = {
      id: `contact_${(++this.sequence).toString().padStart(4, '0')}`,
      email: lead.email,
      existing: false,
    };
    this.contactsByEmail.set(lead.email, contact);
    return contact;
  }

  async createDeal(input: CreateDealInput): Promise<CrmDeal> {
    const existing = this.dealsByKey.get(input.idempotencyKey);
    if (existing) return { ...existing, existing: true };

    const deal: CrmDeal = {
      id: `deal_${(++this.sequence).toString().padStart(4, '0')}`,
      name: `${input.lead.company ?? input.lead.name} — inbound (${input.qualification.classification})`,
      amount: input.qualification.estimated_value,
      stage: input.qualification.classification === 'HOT' ? 'appointmentscheduled' : 'qualifiedtobuy',
      existing: false,
    };
    this.dealsByKey.set(input.idempotencyKey, deal);
    return deal;
  }

  /** Test/demo helpers. */
  get contactCount(): number {
    return this.contactsByEmail.size;
  }
  get dealCount(): number {
    return this.dealsByKey.size;
  }
}
