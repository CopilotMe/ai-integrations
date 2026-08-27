import { z } from 'zod';
import { CLASSIFICATIONS } from './domain/qualification.js';

const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    WEBHOOK_SECRET: z.string().default(''),

    LLM_PROVIDER: z.enum(['fake', 'openai']).default('fake'),
    CRM_PROVIDER: z.enum(['fake', 'hubspot']).default('fake'),
    NOTIFIER_PROVIDER: z.enum(['fake', 'slack']).default('fake'),

    OPENAI_API_KEY: z.string().default(''),
    OPENAI_MODEL: z.string().default('gpt-4.1-mini'),
    LLM_TIMEOUT_MS: z.coerce.number().int().min(500).max(120_000).default(15_000),
    LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

    HUBSPOT_ACCESS_TOKEN: z.string().default(''),
    HUBSPOT_PIPELINE_ID: z.string().default('default'),
    HUBSPOT_DEAL_STAGE_HOT: z.string().default('appointmentscheduled'),
    HUBSPOT_DEAL_STAGE_WARM: z.string().default('qualifiedtobuy'),

    SLACK_WEBHOOK_URL: z.string().default(''),
    SLACK_NOTIFY_ON: z
      .string()
      .default('HOT,WARM')
      .transform((v) => v.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))
      .pipe(z.array(z.enum(CLASSIFICATIONS))),

    HOT_SCORE_THRESHOLD: z.coerce.number().int().min(0).max(100).default(75),
    WARM_SCORE_THRESHOLD: z.coerce.number().int().min(0).max(100).default(45),
    MIN_QUALIFIED_BUDGET_EUR: z.coerce.number().min(0).default(5000),
    HIGH_BUDGET_EUR: z.coerce.number().min(0).default(25_000),
    BLOCKED_EMAIL_DOMAINS: csv('competitor.com,example-spam.io'),
  })
  // Fail at boot rather than on the first real lead. A misconfigured
  // integration that starts cleanly and then 500s in production is worse than
  // one that refuses to start.
  .refine((c) => c.LLM_PROVIDER !== 'openai' || c.OPENAI_API_KEY.length > 0, {
    message: 'OPENAI_API_KEY is required when LLM_PROVIDER=openai',
    path: ['OPENAI_API_KEY'],
  })
  .refine((c) => c.CRM_PROVIDER !== 'hubspot' || c.HUBSPOT_ACCESS_TOKEN.length > 0, {
    message: 'HUBSPOT_ACCESS_TOKEN is required when CRM_PROVIDER=hubspot',
    path: ['HUBSPOT_ACCESS_TOKEN'],
  })
  .refine((c) => c.NOTIFIER_PROVIDER !== 'slack' || c.SLACK_WEBHOOK_URL.length > 0, {
    message: 'SLACK_WEBHOOK_URL is required when NOTIFIER_PROVIDER=slack',
    path: ['SLACK_WEBHOOK_URL'],
  })
  .refine((c) => c.WARM_SCORE_THRESHOLD < c.HOT_SCORE_THRESHOLD, {
    message: 'WARM_SCORE_THRESHOLD must be below HOT_SCORE_THRESHOLD',
    path: ['WARM_SCORE_THRESHOLD'],
  });

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${details}`);
  }
  return result.data;
}
