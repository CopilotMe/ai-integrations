import type { Classification, InboundMessage, Intent } from '../../core/domain/types';
import type { ClassifierPort, ClassifyResult } from '../../core/ports/index';

interface Signature {
  intent: Intent;
  patterns: RegExp[];
  urgency: Classification['urgency'];
  action: Classification['proposed_action'];
  templateKey: string | null;
  baseConfidence: number;
}

/**
 * Deterministic stand-in for the model.
 *
 * It exists so the pipeline, the API, the admin UI and the demo can be run and
 * reviewed end to end without an API key, a bill, or a network. It is a keyword
 * matcher, not an evaluation of model quality — it produces plausibly-shaped
 * output, not accurate output, and the tests that depend on it are testing the
 * system around the model rather than the model.
 */
const SIGNATURES: Signature[] = [
  {
    intent: 'refund_request',
    patterns: [/\brefund\b/i, /\bmoney back\b/i, /\breimburse/i, /\bвъзстанов/i],
    urgency: 'high',
    action: 'issue_refund',
    templateKey: null,
    baseConfidence: 0.86,
  },
  {
    intent: 'cancellation',
    patterns: [/\bcancel\b/i, /\bterminate\b/i, /\bclose my account\b/i, /\bunsubscribe\b/i],
    urgency: 'high',
    action: 'escalate_to_human',
    templateKey: null,
    baseConfidence: 0.84,
  },
  {
    intent: 'complaint',
    patterns: [/\bcomplaint\b/i, /\bunacceptable\b/i, /\bterrible\b/i, /\blawyer\b/i, /\blegal action\b/i, /\bfurious\b/i],
    urgency: 'critical',
    action: 'escalate_to_human',
    templateKey: null,
    baseConfidence: 0.88,
  },
  {
    intent: 'billing_question',
    patterns: [/\binvoice\b/i, /\bbilling\b/i, /\bcharged?\b/i, /\bpayment\b/i, /\bvat\b/i],
    urgency: 'normal',
    action: 'send_templated_reply',
    templateKey: 'billing_explainer',
    baseConfidence: 0.83,
  },
  {
    intent: 'technical_issue',
    patterns: [/\berror\b/i, /\bbroken\b/i, /\bnot work/i, /\bbug\b/i, /\bcrash/i, /\bcan'?t log ?in\b/i],
    urgency: 'high',
    action: 'create_ticket',
    templateKey: null,
    baseConfidence: 0.82,
  },
  {
    intent: 'account_change',
    patterns: [/\bchange my (email|address|plan)\b/i, /\bupdate my details\b/i, /\bseat/i],
    urgency: 'normal',
    action: 'update_account',
    templateKey: null,
    baseConfidence: 0.78,
  },
  {
    intent: 'sales_enquiry',
    patterns: [/\bpricing\b/i, /\bdemo\b/i, /\bquote\b/i, /\benterprise plan\b/i, /\btrial\b/i],
    urgency: 'normal',
    action: 'create_ticket',
    templateKey: null,
    baseConfidence: 0.8,
  },
  {
    intent: 'spam',
    patterns: [/\bseo services\b/i, /\bbacklinks?\b/i, /\bguest post\b/i, /\bcrypto\b/i, /\bwinner\b/i],
    urgency: 'low',
    action: 'no_action',
    templateKey: null,
    baseConfidence: 0.91,
  },
];

const URGENT_MARKERS = [/\burgent\b/i, /\basap\b/i, /\bimmediately\b/i, /\bstill waiting\b/i];

export class FakeClassifier implements ClassifierPort {
  readonly name = 'fake';

  async classify(message: InboundMessage): Promise<ClassifyResult> {
    const startedAt = Date.now();
    const haystack = `${message.subject}\n${message.body}`;

    const matched = SIGNATURES.map((signature) => ({
      signature,
      hits: signature.patterns.filter((p) => p.test(haystack)).length,
    }))
      .filter((m) => m.hits > 0)
      .sort((a, b) => b.hits - a.hits);

    const best = matched[0];
    const ambiguous = matched.length > 1 && matched[1]!.hits === best?.hits;

    const classification: Classification = best
      ? {
          intent: best.signature.intent,
          urgency: escalate(best.signature.urgency, haystack),
          // Competing signatures lower confidence, which is exactly when the
          // policy should be sending the case to a human.
          confidence: round(Math.min(0.97, best.signature.baseConfidence + best.hits * 0.02 - (ambiguous ? 0.25 : 0))),
          summary: summarise(message, best.signature.intent),
          evidence: extractEvidence(haystack, best.signature.patterns),
          proposed_action: best.signature.action,
          refund_amount_eur: best.signature.action === 'issue_refund' ? extractAmount(haystack) : null,
          template_key: best.signature.templateKey,
          reasoning: `Matched ${best.hits} ${best.signature.intent} signal${best.hits === 1 ? '' : 's'}${ambiguous ? '; another intent matched equally strongly, so confidence is reduced' : ''}.`,
          needs_translation: looksNonEnglish(message.body),
        }
      : {
          intent: 'other',
          urgency: 'normal',
          confidence: 0.35,
          summary: summarise(message, 'other'),
          evidence: [],
          proposed_action: 'escalate_to_human',
          refund_amount_eur: null,
          template_key: null,
          reasoning: 'No known intent signature matched, so the message is not confidently understood.',
          needs_translation: looksNonEnglish(message.body),
        };

    return {
      classification,
      model: 'fake-keyword-matcher',
      promptVersion: 'fake-1',
      promptTokens: Math.ceil(haystack.length / 4),
      completionTokens: 120,
      latencyMs: Date.now() - startedAt,
      degraded: false,
    };
  }
}

function escalate(base: Classification['urgency'], text: string): Classification['urgency'] {
  if (!URGENT_MARKERS.some((p) => p.test(text))) return base;
  const order: Classification['urgency'][] = ['low', 'normal', 'high', 'critical'];
  return order[Math.min(order.length - 1, order.indexOf(base) + 1)]!;
}

function extractAmount(text: string): number | null {
  const match = /(?:€|eur\s*)\s*([0-9]+(?:[.,][0-9]{1,2})?)/i.exec(text) ?? /([0-9]+(?:[.,][0-9]{1,2})?)\s*(?:€|eur)/i.exec(text);
  if (!match?.[1]) return null;
  const value = Number(match[1].replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

function extractEvidence(text: string, patterns: RegExp[]): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10 && patterns.some((p) => p.test(s)))
    .slice(0, 3)
    .map((s) => (s.length > 200 ? `${s.slice(0, 197)}...` : s));
}

function summarise(message: InboundMessage, intent: Intent): string {
  const subject = message.subject.trim() || message.body.slice(0, 60);
  return `${intent.replace(/_/g, ' ')} from ${message.from_email}: ${subject}`.slice(0, 400);
}

/** Crude Cyrillic check — enough to demonstrate the translation guard. */
function looksNonEnglish(body: string): boolean {
  const cyrillic = (body.match(/[Ѐ-ӿ]/g) ?? []).length;
  return cyrillic > body.length * 0.2;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
