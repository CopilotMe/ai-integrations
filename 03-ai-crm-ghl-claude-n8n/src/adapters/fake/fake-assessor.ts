import type { GhlLead } from '../../domain/lead.js';
import { emailDomain } from '../../domain/lead.js';
import type { ClaudeAssessment } from '../../domain/qualification.js';
import type { AssessorPort, AssessResult } from '../../ports.js';

const FREE_EMAIL = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'abv.bg']);

const SIGNALS: Array<[RegExp, number]> = [
  [/\b(urgent|asap|immediately|this (?:week|month|quarter)|deadline)\b/i, 12],
  [/\b(automat\w+|integrat\w+|migrat\w+|replac\w+)\b/i, 10],
  [/\b(demo|pricing|quote|proposal|trial|contract)\b/i, 8],
  [/\b(evaluat\w+|compar\w+|shortlist|rfp)\b/i, 6],
  [/\b(student|thesis|homework|research project)\b/i, -30],
  [/\b(job|cv|resume|hiring|vacanc\w+|internship)\b/i, -35],
  [/\b(seo services|backlinks?|guest post|crypto)\b/i, -45],
];

const INDUSTRIES: Array<[RegExp, string]> = [
  [/\b(saas|software|platform|api)\b/i, 'SaaS'],
  [/\b(shop|store|ecommerce|e-commerce|retail)\b/i, 'E-commerce'],
  [/\b(bank|fintech|payment|insur\w+)\b/i, 'Financial Services'],
  [/\b(clinic|hospital|health|patient)\b/i, 'Healthcare'],
  [/\b(logistic|shipping|freight|warehouse)\b/i, 'Logistics'],
];

/**
 * Deterministic stand-in for Claude.
 *
 * It exists so the pipeline, the routing rules and the demo can be run and
 * reviewed with no API key, no network and no spend. It is not an evaluation of
 * model quality — it produces plausibly-shaped output, not accurate output.
 *
 * The one behaviour it models faithfully is *confidence*: a short or vague
 * enquiry with nothing to go on yields low confidence, which is what makes the
 * confidence gate in the routing rules observable in the demo.
 */
export class FakeAssessor implements AssessorPort {
  readonly name = 'fake';

  async assess(lead: GhlLead): Promise<AssessResult> {
    const startedAt = Date.now();
    const text = lead.inquiry;

    let score = 40;
    if (lead.company) score += 10;
    if (!FREE_EMAIL.has(emailDomain(lead.email))) score += 8;
    if (lead.employees !== undefined) score += lead.employees >= 50 ? 12 : -6;
    if (lead.budget_eur !== undefined) score += lead.budget_eur >= 10_000 ? 15 : -8;
    for (const [pattern, delta] of SIGNALS) if (pattern.test(text)) score += delta;
    score = clamp(Math.round(score), 0, 100);

    // Confidence tracks how much there was to read, not how good it looked.
    const known = [lead.company, lead.employees, lead.budget_eur, lead.lead_source].filter(
      (v) => v !== undefined && v !== '',
    ).length;
    let confidence = 0.35 + known * 0.11;
    if (text.length > 140) confidence += 0.15;
    else if (text.length < 40) confidence -= 0.12;
    if (SIGNALS.some(([p]) => p.test(text))) confidence += 0.08;
    confidence = Number(clamp(confidence, 0.05, 0.97).toFixed(2));

    const qualification = score >= 80 ? 'hot' : score >= 50 ? 'warm' : 'cold';

    const assessment: ClaudeAssessment = {
      lead_score: score,
      qualification,
      reason: buildReason(lead, score),
      next_action: qualification === 'hot' ? 'sales_call' : qualification === 'warm' ? 'nurture_sequence' : 'archive',
      confidence,
      signals: extractSignals(text),
      industry: guessIndustry(lead),
    };

    return {
      assessment,
      model: 'fake-heuristic',
      promptVersion: 'fake-1',
      inputTokens: Math.ceil(text.length / 4) + 380,
      outputTokens: 130,
      latencyMs: Date.now() - startedAt,
    };
  }
}

function extractSignals(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15 && SIGNALS.some(([p, delta]) => delta > 0 && p.test(s)))
    .slice(0, 3)
    .map((s) => (s.length > 160 ? `${s.slice(0, 157)}...` : s));
}

function guessIndustry(lead: GhlLead): string {
  const haystack = `${lead.company ?? ''} ${lead.inquiry}`;
  for (const [pattern, industry] of INDUSTRIES) if (pattern.test(haystack)) return industry;
  return 'Unknown';
}

function buildReason(lead: GhlLead, score: number): string {
  const parts: string[] = [];
  if (lead.company) parts.push(`company ${lead.company}`);
  if (lead.employees !== undefined) parts.push(`${lead.employees} employees`);
  if (lead.budget_eur !== undefined) parts.push(`stated budget EUR ${lead.budget_eur.toLocaleString('en-IE')}`);
  const summary = parts.length > 0 ? parts.join(', ') : 'little information supplied';
  const verdict = score >= 80 ? 'Strong ICP fit' : score >= 50 ? 'Partial ICP fit' : 'Weak ICP fit';
  return `${verdict}: ${summary}.`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
