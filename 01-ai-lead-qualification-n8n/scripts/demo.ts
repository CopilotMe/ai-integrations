/**
 * End-to-end demo with no API keys and no network.
 *
 * Runs the leads in `demo/leads.json` — including the ones that are supposed to
 * fail — through the real pipeline with fake providers, prints the result, and
 * writes a self-contained HTML report to `demo/report.html`.
 *
 *   npm run demo
 *
 * To change what is demonstrated, edit `demo/leads.json`. No TypeScript needed.
 */
import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeCrm } from '../src/adapters/fake/fake-crm.js';
import { FakeLlm } from '../src/adapters/fake/fake-llm.js';
import { FakeNotifier } from '../src/adapters/fake/fake-notifier.js';
import { loadConfig } from '../src/config.js';
import type { RoutingRules } from '../src/domain/routing.js';
import { InMemoryDeadLetter } from '../src/lib/deadletter.js';
import { createLogger } from '../src/logger.js';
import { ValidationError } from '../src/pipeline/errors.js';
import { processLead, type ProcessDeps } from '../src/pipeline/process-lead.js';
import { renderReport, type ReportRow } from './report.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEADS_PATH = join(root, 'demo/leads.json');
const REPORT_PATH = join(root, 'demo/report.html');

interface DemoLead {
  label: string;
  note?: string;
  payload: unknown;
}

async function main() {
  const leads = JSON.parse(await readFile(LEADS_PATH, 'utf8')) as DemoLead[];

  const config = loadConfig({
    ...process.env,
    LLM_PROVIDER: 'fake',
    CRM_PROVIDER: 'fake',
    NOTIFIER_PROVIDER: 'fake',
  });

  const crm = new FakeCrm();
  const notifier = new FakeNotifier();
  const rules: RoutingRules = {
    hotScoreThreshold: config.HOT_SCORE_THRESHOLD,
    warmScoreThreshold: config.WARM_SCORE_THRESHOLD,
    minQualifiedBudgetEur: config.MIN_QUALIFIED_BUDGET_EUR,
    highBudgetEur: config.HIGH_BUDGET_EUR,
    blockedEmailDomains: config.BLOCKED_EMAIL_DOMAINS,
  };

  const deps: ProcessDeps = {
    llm: new FakeLlm(),
    crm,
    notifier,
    deadLetter: new InMemoryDeadLetter(),
    rules,
    logger: createLogger('silent', false),
    llmTimeoutMs: config.LLM_TIMEOUT_MS,
    llmMaxRetries: config.LLM_MAX_RETRIES,
  };

  console.log('\n  AI Lead Qualification & Routing — offline demo');
  console.log('  providers: llm=fake  crm=fake  notifier=fake  (no keys, no network)\n');

  const reportRows: ReportRow[] = [];
  const tableRows: string[][] = [];

  for (const [index, lead] of leads.entries()) {
    try {
      const result = await processLead(lead.payload, `demo-${index + 1}`, deps);
      const q = result.qualification;
      reportRows.push({ label: lead.label, note: lead.note ?? '', result, rejection: null });
      tableRows.push([
        lead.label,
        `${badge(q.classification)} ${q.classification}`,
        String(q.score),
        q.next_action,
        result.crm.contact?.existing ? 'contact: existing' : 'contact: new',
        result.crm.deal ? (result.crm.deal.existing ? 'deal: existing' : 'deal: new') : 'deal: —',
        q.explanation.applied_rule,
      ]);
    } catch (error) {
      const detail =
        error instanceof ValidationError
          ? error.issues.map((i) => `${i.path}: ${i.message}`).join('; ')
          : String(error);
      reportRows.push({ label: lead.label, note: lead.note ?? '', result: null, rejection: detail });
      tableRows.push([lead.label, '✗ REJECTED', '—', '—', '—', '—', detail]);
    }
  }

  printTable(['Lead', 'Class', 'Score', 'Next action', 'Contact', 'Deal', 'Applied rule'], tableRows);

  console.log(`\n  CRM state: ${crm.contactCount} contacts, ${crm.dealCount} deals`);
  console.log(`  Slack notifications sent: ${notifier.sent.length}`);

  const html = renderReport({
    rows: reportRows,
    generatedAt: new Date(),
    providers: { llm: deps.llm.name, crm: deps.crm.name, notifier: deps.notifier.name },
    totals: { contacts: crm.contactCount, deals: crm.dealCount, notifications: notifier.sent.length },
  });
  await writeFile(REPORT_PATH, html, 'utf8');

  console.log(`\n  Report written to demo/report.html — open it with:\n    open demo/report.html`);
  console.log(`  Add or edit leads in demo/leads.json and re-run.\n`);
}

function badge(classification: string): string {
  return classification === 'HOT' ? '🔥' : classification === 'WARM' ? '🌤️ ' : '🧊';
}

function printTable(headers: string[], rows: string[][]) {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => visibleLength(row[i] ?? ''))),
  );
  const line = (cells: string[]) =>
    `  ${cells.map((cell, i) => cell + ' '.repeat(Math.max(0, (widths[i] ?? 0) - visibleLength(cell)))).join('  ')}`;

  console.log(line(headers));
  console.log(`  ${widths.map((w) => '─'.repeat(w)).join('  ')}`);
  for (const row of rows) console.log(line(row));
}

/** Emoji occupy two terminal columns but count as one or two UTF-16 units. */
function visibleLength(value: string): number {
  return [...value].reduce((sum, char) => sum + (/\p{Extended_Pictographic}/u.test(char) ? 2 : 1), 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
