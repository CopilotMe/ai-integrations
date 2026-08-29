import { DEFAULT_LIMITS, type LimiterConfig } from '../ratelimit/limiter.js';
import { PROFILES } from './failure-profile.js';

export interface CliOptions {
  leads: number;
  concurrency: number;
  seed: number;
  timeScale: number;
  profile: string;
  model: string;
  rateLimit: boolean;
  limits: LimiterConfig;
  maxQueueDepth: number;
  maxAttempts: number;
  report: string | null;
  json: string | null;
  dashboard: boolean;
  logLevel: string;
}

export const USAGE = `
  AI Lead Qualification — load simulation

  Usage
    npm run simulate -- [options]

  Options
    --leads <n>            Leads to process. Default 10. Tested to 10,000.
    --concurrency <n>      Workers pulling from the queue. Default 8.
    --seed <n>             Seed. Same seed + same options = identical run. Default 1.
    --time-scale <f>       Real seconds per virtual second. Default: auto
                           (1 up to 100 leads, then compressed to stay watchable).
                           Reported results are unaffected by this.
    --profile <name>       ${Object.keys(PROFILES).join(' | ')}. Default normal.
    --model <name>         Model to price against. Default gpt-4.1-mini.
    --no-rate-limit        Disable client-side limiting, to see what it prevents.
    --rpm-llm <n>          Model requests/minute. Default ${DEFAULT_LIMITS.llm.rpm}.
    --rpm-crm <n>          CRM requests/minute. Default ${DEFAULT_LIMITS.crm.rpm}.
    --rpm-notifier <n>     Slack requests/minute. Default ${DEFAULT_LIMITS.notifier.rpm}.
    --max-queue-depth <n>  Backpressure ceiling. Default 500.
    --max-attempts <n>     Attempts per job before dead-lettering. Default 3.
    --report <path>        HTML report. Default sim/report.html. "none" to skip.
    --json <path>          Machine-readable result. Default sim/result.json.
    --no-dashboard         Suppress the live dashboard.
    --log-level <level>    Default silent. Use warn/info to see pipeline logs.
    --help

  Examples
    npm run simulate
    npm run simulate -- --leads 1000 --concurrency 25
    npm run simulate -- --leads 10000 --concurrency 50 --profile degraded
    npm run simulate -- --leads 1000 --no-rate-limit    # compare against the run above
`;

export function parseArgs(argv: string[]): CliOptions | 'help' {
  if (argv.includes('--help') || argv.includes('-h')) return 'help';

  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`--${name} requires a value`);
    }
    return value;
  };

  const num = (name: string, fallback: number, min: number, max: number): number => {
    const raw = get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`--${name} must be a number between ${min} and ${max}, got "${raw}"`);
    }
    return value;
  };

  const leads = num('leads', 10, 1, 1_000_000);
  const profile = get('profile') ?? 'normal';
  if (!PROFILES[profile]) {
    throw new Error(`Unknown --profile "${profile}". Available: ${Object.keys(PROFILES).join(', ')}`);
  }

  const report = get('report') ?? 'sim/report.html';
  const json = get('json') ?? 'sim/result.json';

  return {
    leads,
    concurrency: num('concurrency', 8, 1, 2000),
    seed: num('seed', 1, 0, Number.MAX_SAFE_INTEGER),
    // Small runs go at wall-clock speed so the latency is felt, not just read.
    // Large ones compress, or a 10k run would take well over an hour.
    timeScale: num('time-scale', leads <= 100 ? 1 : Math.max(0.004, 100 / leads), 0.0001, 10),
    profile,
    model: get('model') ?? 'gpt-4.1-mini',
    rateLimit: !argv.includes('--no-rate-limit'),
    limits: {
      llm: { rpm: num('rpm-llm', DEFAULT_LIMITS.llm.rpm, 1, 1_000_000), burst: DEFAULT_LIMITS.llm.burst },
      crm: { rpm: num('rpm-crm', DEFAULT_LIMITS.crm.rpm, 1, 1_000_000), burst: DEFAULT_LIMITS.crm.burst },
      notifier: { rpm: num('rpm-notifier', DEFAULT_LIMITS.notifier.rpm, 1, 1_000_000), burst: DEFAULT_LIMITS.notifier.burst },
    },
    maxQueueDepth: num('max-queue-depth', 500, 1, 1_000_000),
    maxAttempts: num('max-attempts', 3, 1, 20),
    report: report === 'none' ? null : report,
    json: json === 'none' ? null : json,
    dashboard: !argv.includes('--no-dashboard'),
    logLevel: get('log-level') ?? 'silent',
  };
}
