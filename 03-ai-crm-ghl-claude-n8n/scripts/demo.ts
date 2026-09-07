/**
 * End-to-end demo with no API key and no network.
 *
 * Runs representative GoHighLevel leads — including a redelivery and an invalid
 * payload — through the real pipeline with fake providers, and prints what the
 * CRM would have been given.
 *
 *   npm run demo
 */
import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { buildDeps, rulesFromConfig } from '../src/container.js';
import { ValidationError } from '../src/lib/errors.js';
import { createLogger } from '../src/lib/logger.js';
import { qualifyLead } from '../src/pipeline/qualify-lead.js';
import { FakeCrm } from '../src/adapters/fake/fake-crm.js';

const LEADS: Array<{ label: string; payload: Record<string, unknown> }> = [
  {
    label: 'Enterprise, budget stated, urgent',
    payload: {
      contact_id: 'ghl-c-1001',
      event_id: 'ghl-e-1001',
      event_type: 'ContactCreate',
      email: 'nina.kovacs@northwind.de',
      first_name: 'Nina',
      company: 'Northwind GmbH',
      employees: 450,
      budget_eur: 60_000,
      lead_source: 'Website form',
      inquiry:
        'We need to automate our customer support this quarter. Budget is approved at EUR 60,000 and we want to integrate with our existing stack. Please send a proposal urgently.',
    },
  },
  {
    label: 'Mid-market, real interest, few details',
    payload: {
      contact_id: 'ghl-c-1002',
      event_id: 'ghl-e-1002',
      email: 'ops@meridian.io',
      company: 'Meridian',
      employees: 120,
      inquiry: 'We are comparing a few options for automating support and would like to understand pricing.',
    },
  },
  {
    label: 'Strong words, almost nothing to go on',
    payload: {
      contact_id: 'ghl-c-1003',
      event_id: 'ghl-e-1003',
      email: 'someone@gmail.com',
      inquiry: 'need automation asap!!',
    },
  },
  {
    label: 'Job enquiry',
    payload: {
      contact_id: 'ghl-c-1004',
      event_id: 'ghl-e-1004',
      email: 'ivan.ivanov@gmail.com',
      inquiry: 'Hello, are you hiring? I am attaching my CV for any open vacancy in your support team.',
    },
  },
  {
    label: 'Competitor on the blocklist',
    payload: {
      contact_id: 'ghl-c-1005',
      event_id: 'ghl-e-1005',
      email: 'sales@competitor.com',
      company: 'Competitor',
      employees: 300,
      budget_eur: 80_000,
      inquiry: 'We would like to discuss a partnership and automate our joint support workflow this quarter.',
    },
  },
  {
    label: 'Redelivery of lead #1 (GHL retry)',
    payload: {
      contact_id: 'ghl-c-1001',
      event_id: 'ghl-e-1001',
      event_type: 'ContactCreate',
      email: 'nina.kovacs@northwind.de',
      company: 'Northwind GmbH',
      employees: 450,
      budget_eur: 60_000,
      inquiry:
        'We need to automate our customer support this quarter. Budget is approved at EUR 60,000 and we want to integrate with our existing stack. Please send a proposal urgently.',
    },
  },
  {
    label: 'ContactUpdate for lead #1 (new event id)',
    payload: {
      contact_id: 'ghl-c-1001',
      event_id: 'ghl-e-1099',
      event_type: 'ContactUpdate',
      email: 'nina.kovacs@northwind.de',
      company: 'Northwind GmbH',
      employees: 450,
      budget_eur: 60_000,
      inquiry: 'Following up on the proposal — we have signed off internally and want to start next week.',
    },
  },
  { label: 'Invalid payload (no email)', payload: { contact_id: 'ghl-c-1006', event_id: 'ghl-e-1006', inquiry: 'call me' } },
];

async function main() {
  const config = loadConfig({ ...process.env, LLM_PROVIDER: 'fake', CRM_PROVIDER: 'fake', BLOCKED_EMAIL_DOMAINS: 'competitor.com' });
  const logger = createLogger('silent', false);
  const deps = buildDeps(config, logger);
  const crm = deps.crm as FakeCrm;

  console.log('\n  GoHighLevel → Claude → deterministic routing — offline demo');
  console.log('  providers: assessor=fake  crm=fake  (no API key, no network)');
  const rules = rulesFromConfig(config);
  console.log(
    `  rules: hot ≥ ${rules.hotScore} & conf ≥ ${rules.hotConfidence} · warm ≥ ${rules.warmScore} & conf ≥ ${rules.warmConfidence}\n`,
  );

  const rows: string[][] = [];
  for (const [index, { label, payload }] of LEADS.entries()) {
    try {
      const result = await qualifyLead(payload, `demo-${index + 1}`, deps);
      const d = result.decision;
      rows.push([
        label,
        result.duplicate ? '— dup —' : d.route,
        String(d.lead_score),
        d.confidence.toFixed(2),
        d.next_action,
        d.explanation.overrode_model ? 'yes' : 'no',
        d.explanation.applied_rule,
      ]);
    } catch (error) {
      const detail =
        error instanceof ValidationError
          ? error.issues.map((i) => `${i.path}: ${i.message}`).join('; ')
          : String(error);
      rows.push([label, '✗ rejected', '—', '—', '—', '—', detail]);
    }
  }

  printTable(['Lead', 'Route', 'Score', 'Conf', 'Next action', 'Overrode model', 'Applied rule'], rows);

  console.log(`\n  CRM state: ${crm.contactCount} contacts, ${crm.totalWrites} writes`);
  console.log('  Lead #6 is a redelivery of #1 — no second classification, no second CRM write.');
  console.log('  Lead #7 is the same contact with a new event id — qualified again, one contact updated.\n');
}

function printTable(headers: string[], rows: string[][]) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => visible(r[i] ?? ''))));
  const line = (cells: string[]) =>
    `  ${cells.map((c, i) => (c ?? '') + ' '.repeat(Math.max(0, (widths[i] ?? 0) - visible(c ?? '')))).join('  ')}`;
  console.log(line(headers));
  console.log(`  ${widths.map((w) => '─'.repeat(w)).join('  ')}`);
  for (const row of rows) console.log(line(row));
}

function visible(value: string): number {
  return [...value].length;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
