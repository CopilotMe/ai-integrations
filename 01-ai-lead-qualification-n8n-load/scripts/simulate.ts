/**
 * Production load simulation.
 *
 *   npm run simulate                                  # 10 leads, real time
 *   npm run simulate -- --leads 10000 --concurrency 50
 *   npm run simulate -- --help
 */
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import type { RoutingRules } from '../src/domain/routing.js';
import { createLogger } from '../src/logger.js';
import { parseArgs, USAGE } from '../src/sim/cli.js';
import { renderSimulationReport } from '../src/sim/report.js';
import { Dashboard } from '../src/sim/dashboard.js';
import { runSimulation } from '../src/sim/runner.js';
import { summarise } from '../src/sim/summary.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }

  const config = loadConfig({ ...process.env, LLM_PROVIDER: 'fake', CRM_PROVIDER: 'fake', NOTIFIER_PROVIDER: 'fake' });
  const rules: RoutingRules = {
    hotScoreThreshold: config.HOT_SCORE_THRESHOLD,
    warmScoreThreshold: config.WARM_SCORE_THRESHOLD,
    minQualifiedBudgetEur: config.MIN_QUALIFIED_BUDGET_EUR,
    highBudgetEur: config.HIGH_BUDGET_EUR,
    blockedEmailDomains: config.BLOCKED_EMAIL_DOMAINS,
  };

  const dashboard = parsed.dashboard ? new Dashboard(parsed.leads) : null;

  console.log(
    `\n  Starting: ${parsed.leads} leads · concurrency ${parsed.concurrency} · profile ${parsed.profile} · seed ${parsed.seed}` +
      `\n  Rate limiting ${parsed.rateLimit ? 'ON' : 'OFF'} · time scale ${parsed.timeScale}` +
      `${parsed.timeScale !== 1 ? ` (wall clock compressed ${Math.round(1 / parsed.timeScale)}x)` : ''}\n`,
  );

  const result = await runSimulation({
    leads: parsed.leads,
    concurrency: parsed.concurrency,
    seed: parsed.seed,
    timeScale: parsed.timeScale,
    profileName: parsed.profile,
    model: parsed.model,
    rateLimitEnabled: parsed.rateLimit,
    limits: parsed.limits,
    maxQueueDepth: parsed.maxQueueDepth,
    maxAttempts: parsed.maxAttempts,
    rules,
    llmTimeoutMs: config.LLM_TIMEOUT_MS,
    llmMaxRetries: config.LLM_MAX_RETRIES,
    logger: createLogger(parsed.logLevel, false),
    onProgress: (progress) => dashboard?.render(progress),
  });

  dashboard?.finish();
  console.log(summarise(result));

  if (parsed.json) {
    const path = resolve(root, parsed.json);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(result, null, 2), 'utf8');
    console.log(`  Result JSON  ${parsed.json}`);
  }

  if (parsed.report) {
    const path = resolve(root, parsed.report);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, renderSimulationReport(result), 'utf8');
    console.log(`  HTML report  ${parsed.report}   (open ${parsed.report})`);
  }

  console.log('');

  // A run where jobs died is a failing run, so CI can gate on it.
  if (result.totals.dead > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\n  ${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
});
