import type { GhlLead } from '../../domain/lead.js';
import type { Decision } from '../../domain/qualification.js';
import type { CrmPort, CrmUpdateResult } from '../../ports.js';

export interface WrittenContact {
  contactId: string;
  route: string;
  score: number;
  writes: number;
}

/** In-memory CRM that records what would have been written back. */
export class FakeCrm implements CrmPort {
  readonly name = 'fake';
  private readonly contacts = new Map<string, WrittenContact>();

  async writeQualification(lead: GhlLead, decision: Decision): Promise<CrmUpdateResult> {
    const existing = this.contacts.get(lead.contact_id);
    const unchanged = existing?.route === decision.route && existing?.score === decision.lead_score;

    this.contacts.set(lead.contact_id, {
      contactId: lead.contact_id,
      route: decision.route,
      score: decision.lead_score,
      writes: (existing?.writes ?? 0) + 1,
    });

    return {
      contactId: lead.contact_id,
      unchanged,
      fieldsWritten: ['ai_lead_score', 'ai_qualification', 'ai_reason', 'ai_confidence', 'ai_next_action', 'ai_route', 'ai_processed_at'],
    };
  }

  get(contactId: string): WrittenContact | undefined {
    return this.contacts.get(contactId);
  }

  get contactCount(): number {
    return this.contacts.size;
  }

  get totalWrites(): number {
    return [...this.contacts.values()].reduce((sum, c) => sum + c.writes, 0);
  }
}
