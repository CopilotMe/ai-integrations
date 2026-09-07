import { z } from 'zod';

/**
 * A GoHighLevel contact webhook, normalised.
 *
 * GHL sends different shapes for ContactCreate, ContactUpdate and a custom
 * webhook action, and the field names differ between them (`contact_id` vs
 * `contactId` vs `id`; `customFields` as an object or an array). n8n normalises
 * first; this schema is the contract at the service boundary, and it is
 * deliberately forgiving about *shape* and strict about *content*.
 */
export const GhlLeadSchema = z.object({
  /** GHL contact id. Everything written back is addressed by this. */
  contact_id: z.string().trim().min(1, 'contact_id is required').max(120),
  /**
   * The webhook delivery's own id. GHL fires ContactCreate *and* ContactUpdate
   * for the same contact, and retries on non-2xx — this is what makes a
   * redelivery a no-op instead of a second qualification.
   */
  event_id: z.string().trim().min(1, 'event_id is required').max(200),
  event_type: z.enum(['ContactCreate', 'ContactUpdate', 'Custom']).default('Custom'),
  location_id: z.string().trim().max(120).optional(),

  first_name: z.string().trim().max(120).optional(),
  last_name: z.string().trim().max(120).optional(),
  email: z.string().trim().toLowerCase().pipe(z.email('must be a valid email address').max(254)),
  phone: z.string().trim().max(40).optional(),
  company: z.string().trim().max(200).optional(),
  /** GHL's own attribution — `source` on the contact record. */
  lead_source: z.string().trim().max(120).optional(),
  tags: z.array(z.string().trim().max(80)).max(50).default([]),

  /** The free-text the qualification actually depends on. */
  inquiry: z.string().trim().min(1, 'inquiry is required').max(8000),

  employees: z.coerce.number().int().min(0).max(10_000_000).optional(),
  budget_eur: z.coerce.number().min(0).max(1_000_000_000).optional(),
  country: z.string().trim().max(80).optional(),
});

export type GhlLead = z.infer<typeof GhlLeadSchema>;

export function fullName(lead: GhlLead): string {
  return [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.email;
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}
