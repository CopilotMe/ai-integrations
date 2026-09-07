import { z } from 'zod';
import { INTENTS } from '../core/domain/types';

const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((v) => v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    SESSION_SECRET: z.string().default(''),

    LLM_PROVIDER: z.enum(['fake', 'openai']).default('fake'),
    TICKETING_PROVIDER: z.enum(['fake', 'http']).default('fake'),
    NOTIFIER_PROVIDER: z.enum(['fake', 'slack']).default('fake'),

    OPENAI_API_KEY: z.string().default(''),
    OPENAI_MODEL: z.string().default('gpt-4.1-mini'),
    LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
    LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

    TICKETING_WEBHOOK_URL: z.string().default(''),
    SLACK_WEBHOOK_URL: z.string().default(''),
    APP_URL: z.string().default('http://localhost:3000'),

    POLICY_THRESHOLD_NONE: z.coerce.number().min(0).max(2).default(0.5),
    POLICY_THRESHOLD_LOW: z.coerce.number().min(0).max(2).default(0.75),
    POLICY_THRESHOLD_MEDIUM: z.coerce.number().min(0).max(2).default(0.9),
    POLICY_THRESHOLD_HIGH: z.coerce.number().min(0).max(2).default(1.01),
    POLICY_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.4),
    POLICY_REFUND_AUTO_CAP_EUR: z.coerce.number().min(0).default(0),
    POLICY_VIP_DOMAINS: csv(''),
    POLICY_ALWAYS_REVIEW_INTENTS: z
      .string()
      .default('complaint,cancellation')
      .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
      .pipe(z.array(z.enum(INTENTS))),
  })
  // Fail at boot, not on the first real message.
  .refine((c) => c.LLM_PROVIDER !== 'openai' || c.OPENAI_API_KEY.length > 0, {
    message: 'OPENAI_API_KEY is required when LLM_PROVIDER=openai',
    path: ['OPENAI_API_KEY'],
  })
  .refine((c) => c.NOTIFIER_PROVIDER !== 'slack' || c.SLACK_WEBHOOK_URL.length > 0, {
    message: 'SLACK_WEBHOOK_URL is required when NOTIFIER_PROVIDER=slack',
    path: ['SLACK_WEBHOOK_URL'],
  })
  .refine((c) => c.TICKETING_PROVIDER !== 'http' || c.TICKETING_WEBHOOK_URL.length > 0, {
    message: 'TICKETING_WEBHOOK_URL is required when TICKETING_PROVIDER=http',
    path: ['TICKETING_WEBHOOK_URL'],
  })
  // A weak signing secret in production means forgeable admin sessions.
  .refine((c) => c.NODE_ENV !== 'production' || c.SESSION_SECRET.length >= 32, {
    message: 'SESSION_SECRET must be at least 32 characters in production',
    path: ['SESSION_SECRET'],
  });

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${detail}`);
  }
  return result.data;
}

export function config(): Config {
  cached ??= loadConfig();
  return cached;
}

export function resetConfigCache(): void {
  cached = undefined;
}
