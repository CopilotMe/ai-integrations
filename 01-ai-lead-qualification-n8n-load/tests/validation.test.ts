import { describe, expect, it } from 'vitest';
import { idempotencyKey } from '../src/domain/lead.js';
import { ValidationError } from '../src/pipeline/errors.js';
import { parseLead } from '../src/pipeline/qualify-lead.js';
import { hotLead } from './fixtures/leads.js';

describe('lead validation', () => {
  it('accepts a complete, valid lead', () => {
    const lead = parseLead(hotLead);
    expect(lead.email).toBe('john.smith@acme.co');
    expect(lead.budget).toBe(25_000);
    expect(lead.source).toBe('website_form');
  });

  it('rejects a lead with no email', () => {
    const { email: _omitted, ...withoutEmail } = hotLead;
    expect(() => parseLead(withoutEmail)).toThrow(ValidationError);

    try {
      parseLead(withoutEmail);
    } catch (error) {
      expect((error as ValidationError).issues.map((i) => i.path)).toContain('email');
    }
  });

  it('rejects a malformed email address', () => {
    expect(() => parseLead({ ...hotLead, email: 'not-an-email' })).toThrow(ValidationError);
  });

  it('rejects a negative budget', () => {
    try {
      parseLead({ ...hotLead, budget: -500 });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const issue = (error as ValidationError).issues.find((i) => i.path === 'budget');
      expect(issue?.message).toMatch(/cannot be negative/);
    }
  });

  it('rejects a non-numeric budget', () => {
    expect(() => parseLead({ ...hotLead, budget: 'twenty thousand' })).toThrow(ValidationError);
  });

  it('coerces a numeric budget sent as a string, as HTML forms do', () => {
    expect(parseLead({ ...hotLead, budget: '25000' }).budget).toBe(25_000);
  });

  it('normalises email casing and whitespace so dedupe works', () => {
    const lead = parseLead({ ...hotLead, email: '  John.Smith@ACME.co ' });
    expect(lead.email).toBe('john.smith@acme.co');
  });

  it('accepts a minimal lead — missing optional fields must not drop a lead', () => {
    const lead = parseLead({ name: 'A', email: 'a@b.co', message: 'Interested in a demo.' });
    expect(lead.source).toBe('unknown');
    expect(lead.budget).toBeUndefined();
  });

  it('derives a stable idempotency key from email and message', () => {
    const a = parseLead(hotLead);
    const b = parseLead({ ...hotLead, name: 'Different Name', email: 'JOHN.SMITH@acme.co' });
    expect(idempotencyKey(a)).toBe(idempotencyKey(b));
    expect(idempotencyKey(a)).not.toBe(idempotencyKey(parseLead({ ...hotLead, message: 'Other text here.' })));
  });
});
