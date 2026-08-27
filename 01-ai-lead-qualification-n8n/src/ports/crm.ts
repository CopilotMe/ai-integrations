import type { Lead } from '../domain/lead.js';
import type { Qualification } from '../domain/qualification.js';

export interface CrmContact {
  id: string;
  email: string;
  /** True when the contact already existed and was updated rather than created. */
  existing: boolean;
}

export interface CrmDeal {
  id: string;
  name: string;
  amount: number;
  stage: string;
  /** True when an existing deal matched the idempotency key. */
  existing: boolean;
}

export interface CreateDealInput {
  contactId: string;
  lead: Lead;
  qualification: Qualification;
  idempotencyKey: string;
}

export interface CrmPort {
  readonly name: string;
  upsertContact(lead: Lead, qualification: Qualification): Promise<CrmContact>;
  createDeal(input: CreateDealInput): Promise<CrmDeal>;
}
