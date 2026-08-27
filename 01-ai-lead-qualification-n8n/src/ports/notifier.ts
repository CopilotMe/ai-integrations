import type { Lead } from '../domain/lead.js';
import type { Qualification } from '../domain/qualification.js';
import type { CrmContact, CrmDeal } from './crm.js';

export interface NotificationInput {
  lead: Lead;
  qualification: Qualification;
  contact: CrmContact | null;
  deal: CrmDeal | null;
  suggestedReply: string | null;
}

export interface NotifierPort {
  readonly name: string;
  notify(input: NotificationInput): Promise<void>;
}
