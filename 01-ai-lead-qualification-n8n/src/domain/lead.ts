import { z } from 'zod';

/**
 * The inbound lead as it arrives from a website form, an email parser, or a
 * partner API. Everything except `name`, `email` and `message` is optional —
 * real forms are always missing fields, and a missing field must never be the
 * reason a lead is dropped.
 */
export const LeadSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(120),
  // Trim and lowercase *before* validating: real forms post padded, mixed-case
  // addresses, and normalising after the check would reject them.
  email: z.string().trim().toLowerCase().pipe(z.email('must be a valid email address').max(254)),
  company: z.string().trim().max(200).optional(),
  employees: z.coerce
    .number({ error: 'employees must be a number' })
    .int('employees must be a whole number')
    .min(0, 'employees cannot be negative')
    .max(10_000_000)
    .optional(),
  /** Stated or estimated budget, in EUR. */
  budget: z.coerce
    .number({ error: 'budget must be a number' })
    .min(0, 'budget cannot be negative')
    .max(1_000_000_000, 'budget is implausibly large')
    .optional(),
  message: z.string().trim().min(1, 'message is required').max(4000),
  country: z.string().trim().max(80).optional(),
  source: z
    .enum(['website_form', 'email', 'api', 'referral', 'event', 'unknown'])
    .default('unknown'),
  submitted_at: z.iso.datetime({ offset: true }).optional(),
});

export type Lead = z.infer<typeof LeadSchema>;

/** Domain of the lead's email address, e.g. `acme.co`. */
export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'icloud.com',
  'proton.me',
  'protonmail.com',
  'abv.bg',
  'mail.bg',
]);

export function isFreeEmailDomain(email: string): boolean {
  return FREE_EMAIL_DOMAINS.has(emailDomain(email));
}

/**
 * Stable key used to de-duplicate retried webhook deliveries. n8n, HubSpot
 * forms and most marketing tools retry on timeout, so the same lead regularly
 * arrives two or three times within a few seconds.
 */
export function idempotencyKey(lead: Lead): string {
  const normalized = `${lead.email}|${lead.message.replace(/\s+/g, ' ').trim().toLowerCase()}`;
  // FNV-1a — good enough for dedupe, and keeps the module dependency-free.
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `lead_${hash.toString(16).padStart(8, '0')}`;
}
