/**
 * Replays dead-lettered leads through the pipeline.
 *
 *   npx tsx scripts/replay.ts [path] [--dry-run]
 *
 * Entries are safe to replay: contacts are keyed by email and deals by
 * idempotency key, so a lead that partially succeeded the first time will not
 * be duplicated.
 */
import 'dotenv/config';
import { readFile, rename } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { buildDeps, DEAD_LETTER_PATH } from '../src/container.js';
import type { DeadLetterEntry } from '../src/lib/deadletter.js';
import { createLogger } from '../src/logger.js';
import { processLead } from '../src/pipeline/process-lead.js';

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const path = args.find((a) => !a.startsWith('--')) ?? DEAD_LETTER_PATH;

  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    console.log(`Nothing to replay: ${path} does not exist.`);
    return;
  }

  const entries = contents
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DeadLetterEntry);

  console.log(`Found ${entries.length} dead-lettered entr${entries.length === 1 ? 'y' : 'ies'} in ${path}`);
  if (dryRun) {
    for (const entry of entries) console.log(`  ${entry.at}  ${entry.stage}  ${entry.error.message}`);
    return;
  }

  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL, config.NODE_ENV === 'development');
  const deps = buildDeps(config, logger);

  let replayed = 0;
  let failed = 0;

  for (const entry of entries) {
    const lead = (entry.payload as { lead?: unknown }).lead;
    if (!lead) {
      console.log(`  skip ${entry.correlationId}: no lead payload`);
      continue;
    }
    try {
      const result = await processLead(lead, `replay:${entry.correlationId}`, deps);
      replayed++;
      console.log(`  ok   ${entry.correlationId} → ${result.qualification.classification}`);
    } catch (error) {
      failed++;
      console.log(`  fail ${entry.correlationId}: ${error instanceof Error ? error.message : error}`);
    }
  }

  // Failures were re-appended to the live file by the pipeline itself, so the
  // consumed file is archived rather than deleted.
  if (replayed > 0 || failed > 0) {
    const archive = `${path}.replayed-${entries.length}`;
    await rename(path, archive).catch(() => {});
    console.log(`\nReplayed ${replayed}, failed ${failed}. Archived original to ${archive}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
