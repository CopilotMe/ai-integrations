import type { Lead } from '../../domain/lead.js';
import { isFreeEmailDomain } from '../../domain/lead.js';
import type { LlmAssessment, Qualification } from '../../domain/qualification.js';
import { heuristicBaseScore } from '../../domain/scoring.js';
import type { LlmPort } from '../../ports/llm.js';

/**
 * Deterministic stand-in for a real model.
 *
 * It exists so the pipeline, the HTTP layer, the n8n workflow and the demo can
 * all be exercised end to end with no API key and no cost. It is **not** an
 * evaluation of model quality — it produces plausibly-shaped output, not
 * accurate output.
 */
export class FakeLlm implements LlmPort {
  readonly name = 'fake';

  async assess(lead: Lead): Promise<LlmAssessment> {
    const score = Math.round(heuristicBaseScore(lead) + intentBoost(lead.message));
    const bounded = Math.max(0, Math.min(100, score));

    return {
      score: bounded,
      suggested_classification: bounded >= 75 ? 'HOT' : bounded >= 45 ? 'WARM' : 'COLD',
      industry: guessIndustry(lead),
      estimated_value: lead.budget ?? Math.max(2500, (lead.employees ?? 10) * 120),
      reason: buildReason(lead, bounded),
      signals: extractSignals(lead.message),
      confidence: lead.company && lead.budget !== undefined ? 0.82 : 0.55,
    };
  }

  async draftReply(lead: Lead, qualification: Qualification): Promise<string> {
    const firstName = lead.name.split(' ')[0] ?? lead.name;
    const step =
      qualification.next_action === 'sales_call'
        ? 'Would a 30-minute call this week work to walk through your setup?'
        : 'I can send over a short overview of how teams like yours approach this — useful?';
    return [
      `Hi ${firstName},`,
      '',
      `Thanks for reaching out${lead.company ? ` on behalf of ${lead.company}` : ''}. ${qualification.reason}`,
      step,
      '',
      'Best,',
      'the team',
    ].join('\n');
  }
}

const INTENT_PATTERNS: Array<[RegExp, number]> = [
  [/\b(urgent|asap|immediately|this (?:week|month)|deadline)\b/i, 12],
  [/\b(automat\w+|integrat\w+|migrat\w+)\b/i, 10],
  [/\b(demo|pricing|quote|proposal|trial)\b/i, 8],
  [/\b(evaluat\w+|compar\w+|shortlist)\b/i, 6],
  [/\b(student|thesis|homework|research project)\b/i, -30],
  [/\b(job|cv|resume|hiring|vacanc\w+)\b/i, -35],
];

function intentBoost(message: string): number {
  return INTENT_PATTERNS.reduce((sum, [re, delta]) => (re.test(message) ? sum + delta : sum), 0);
}

const INDUSTRY_PATTERNS: Array<[RegExp, string]> = [
  [/\b(saas|software|platform|api)\b/i, 'SaaS'],
  [/\b(shop|store|ecommerce|e-commerce|retail)\b/i, 'E-commerce'],
  [/\b(bank|fintech|payment|insur\w+)\b/i, 'Financial Services'],
  [/\b(clinic|hospital|health|patient)\b/i, 'Healthcare'],
  [/\b(logistic|shipping|freight|warehouse)\b/i, 'Logistics'],
  [/\b(school|universit|course|educat\w+)\b/i, 'Education'],
];

function guessIndustry(lead: Lead): string {
  const haystack = `${lead.company ?? ''} ${lead.message}`;
  for (const [re, industry] of INDUSTRY_PATTERNS) {
    if (re.test(haystack)) return industry;
  }
  return 'Unknown';
}

function extractSignals(message: string): string[] {
  return message
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15 && /\b(need|want|looking|automat|integrat|budget|urgent|current)\w*/i.test(s))
    .slice(0, 3)
    .map((s) => (s.length > 110 ? `${s.slice(0, 107)}...` : s));
}

function buildReason(lead: Lead, score: number): string {
  const parts: string[] = [];
  if (lead.company) parts.push(`identified company (${lead.company})`);
  if (lead.employees !== undefined) parts.push(`${lead.employees} employees`);
  if (lead.budget !== undefined) parts.push(`stated budget of €${lead.budget.toLocaleString('en-IE')}`);
  if (isFreeEmailDomain(lead.email)) parts.push('free email domain');
  const summary = parts.length > 0 ? parts.join(', ') : 'limited information provided';
  const verdict = score >= 75 ? 'Strong ICP fit' : score >= 45 ? 'Partial ICP fit' : 'Weak ICP fit';
  return `${verdict}: ${summary}.`;
}
