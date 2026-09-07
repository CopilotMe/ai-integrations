/**
 * Posts a spread of representative messages through the real pipeline.
 *
 * Deliberately includes the ones that should NOT auto-execute — that is the
 * behaviour worth demonstrating. Providers default to `fake`, so this needs no
 * API key and costs nothing.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { processInboundMessage } from '../src/core/pipeline/process-message';
import { closeDb, getDb } from '../src/db/client';
import { apiKeys } from '../src/db/schema';
import { config } from '../src/lib/config';
import { policyFromConfig } from '../src/server/container';
import { FakeClassifier } from '../src/adapters/fake/fake-classifier';
import { FakeExecutor } from '../src/adapters/fake/fake-executor';
import { FakeNotifier } from '../src/adapters/fake/fake-notifier';
import { createLoggerForScript } from './_logger';

const MESSAGES = [
  {
    label: 'Duplicate charge, refund requested',
    from_email: 'nina.kovacs@northwind.de',
    from_name: 'Nina Kovacs',
    subject: 'Charged twice for October',
    body: 'Hello, I was charged EUR 49 twice for my October subscription. Please refund the duplicate charge of EUR 49. Order reference NW-88231.',
  },
  {
    label: 'Password reset, clear technical issue',
    from_email: 'tom.baker@meridian.io',
    subject: 'Cannot log in after password reset',
    body: 'Since resetting my password yesterday I get an error on every login attempt. The page says "session expired" and reloads. This is broken for my whole team of 12.',
  },
  {
    label: 'Angry complaint threatening legal action',
    from_email: 'furious@cascade-retail.com',
    subject: 'This is completely unacceptable',
    body: 'Three weeks and nobody has replied. This is unacceptable and I am consulting a lawyer about legal action if this is not resolved immediately.',
  },
  {
    label: 'Invoice question — clean templated reply',
    from_email: 'finance@lumen-group.eu',
    subject: 'VAT on invoice 4471',
    body: 'Could you confirm whether VAT is included in invoice 4471? Our billing team needs this for the quarterly filing. Thank you.',
  },
  {
    label: 'Obvious spam',
    from_email: 'growth@seo-deals.biz',
    subject: 'Premium backlinks for your site',
    body: 'We offer premium SEO services and quality backlinks. Guaranteed first page ranking within 30 days. Reply for our rate card.',
  },
  {
    label: 'Cancellation — always reviewed by policy',
    from_email: 'ops@vertex-labs.com',
    subject: 'Cancel our subscription',
    body: 'We have decided to cancel our subscription at the end of the current billing period. Please confirm the process.',
  },
  {
    label: 'Non-English message (translation guard)',
    from_email: 'ivan@orbit.bg',
    subject: 'Проблем с фактура',
    body: 'Здравейте, имам проблем с последната фактура. Сумата не съответства на договора ни. Моля, проверете и ми отговорете.',
  },
  {
    label: 'Vague enquiry the model should not be confident about',
    from_email: 'someone@example.org',
    subject: 'question',
    body: 'hi, is it possible? thanks',
  },
];

async function main() {
  const c = config();
  const db = getDb();
  const logger = createLoggerForScript();

  const key = (await db.select().from(apiKeys).limit(1))[0];
  const actor = key
    ? ({ kind: 'api_key', id: key.id, name: key.name } as const)
    : ({ kind: 'system' } as const);

  const deps = {
    db,
    classifier: new FakeClassifier(),
    executor: new FakeExecutor(),
    notifier: new FakeNotifier(),
    policy: policyFromConfig(c),
    logger,
    appUrl: c.APP_URL,
    llmTimeoutMs: c.LLM_TIMEOUT_MS,
    llmMaxRetries: c.LLM_MAX_RETRIES,
  };

  console.log('\n  Posting demo messages through the real pipeline (providers: fake)\n');
  const rows: string[][] = [];

  for (const message of MESSAGES) {
    const result = await processInboundMessage(
      {
        external_id: `demo-${randomUUID().slice(0, 8)}`,
        source: 'demo',
        from_email: message.from_email,
        from_name: message.from_name,
        to_email: 'support@example.com',
        subject: message.subject,
        body: message.body,
      },
      actor,
      `demo-${randomUUID().slice(0, 8)}`,
      deps,
    );

    rows.push([
      message.label,
      result.decision?.verdict === 'auto_execute' ? 'auto' : 'HUMAN',
      result.classification?.intent ?? '—',
      result.classification?.confidence.toFixed(2) ?? '—',
      result.decision?.action ?? '—',
      result.decision?.blastRadius ?? '—',
      result.decision?.decidedBy ?? '—',
    ]);
  }

  printTable(['Message', 'Route', 'Intent', 'Conf', 'Action', 'Blast', 'Decided by'], rows);

  const human = rows.filter((r) => r[1] === 'HUMAN').length;
  console.log(`\n  ${rows.length - human} auto-executed · ${human} held for a human`);
  console.log('  Open http://localhost:3000 to work the queue.\n');

  await closeDb();
}

function printTable(headers: string[], rows: string[][]) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    `  ${cells.map((c, i) => (c ?? '').padEnd(widths[i] ?? 0)).join('  ')}`;
  console.log(line(headers));
  console.log(`  ${widths.map((w) => '─'.repeat(w)).join('  ')}`);
  for (const row of rows) console.log(line(row));
}

main().catch(async (error) => {
  console.error(error);
  await closeDb().catch(() => {});
  process.exit(1);
});
