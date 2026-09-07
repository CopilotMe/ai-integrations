import { z } from 'zod';

const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((v) => v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    WEBHOOK_SECRET: z.string().default(''),

    LLM_PROVIDER: z.enum(['fake', 'claude']).default('fake'),
    CRM_PROVIDER: z.enum(['fake', 'ghl']).default('fake'),

    ANTHROPIC_API_KEY: z.string().default(''),
    CLAUDE_MODEL: z.string().default('claude-opus-5'),
    LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
    LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
    CLAUDE_REFUSAL_FALLBACK: z
      .string()
      .default('true')
      .transform((v) => v.toLowerCase() !== 'false'),
    CLAUDE_FALLBACK_MODEL: z.string().default('claude-opus-4-8'),

    GHL_ACCESS_TOKEN: z.string().default(''),
    GHL_LOCATION_ID: z.string().default(''),
    GHL_API_BASE: z.string().default('https://services.leadconnectorhq.com'),
    GHL_API_VERSION: z.string().default('2021-07-28'),

    HOT_SCORE_THRESHOLD: z.coerce.number().int().min(0).max(100).default(80),
    WARM_SCORE_THRESHOLD: z.coerce.number().int().min(0).max(100).default(50),
    HOT_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
    WARM_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
    BLOCKED_EMAIL_DOMAINS: csv(''),
    IDEMPOTENCY_TTL_MINUTES: z.coerce.number().int().min(1).max(43_200).default(1440),
  })
  // Fail at boot rather than on the first real lead.
  .refine((c) => c.LLM_PROVIDER !== 'claude' || c.ANTHROPIC_API_KEY.length > 0, {
    message: 'ANTHROPIC_API_KEY is required when LLM_PROVIDER=claude',
    path: ['ANTHROPIC_API_KEY'],
  })
  .refine((c) => c.CRM_PROVIDER !== 'ghl' || c.GHL_ACCESS_TOKEN.length > 0, {
    message: 'GHL_ACCESS_TOKEN is required when CRM_PROVIDER=ghl',
    path: ['GHL_ACCESS_TOKEN'],
  })
  .refine((c) => c.CRM_PROVIDER !== 'ghl' || c.GHL_LOCATION_ID.length > 0, {
    message: 'GHL_LOCATION_ID is required when CRM_PROVIDER=ghl — custom field ids are per-location',
    path: ['GHL_LOCATION_ID'],
  })
  .refine((c) => c.WARM_SCORE_THRESHOLD < c.HOT_SCORE_THRESHOLD, {
    message: 'WARM_SCORE_THRESHOLD must be below HOT_SCORE_THRESHOLD',
    path: ['WARM_SCORE_THRESHOLD'],
  })
  .refine((c) => c.WARM_CONFIDENCE_THRESHOLD <= c.HOT_CONFIDENCE_THRESHOLD, {
    message: 'WARM_CONFIDENCE_THRESHOLD must not exceed HOT_CONFIDENCE_THRESHOLD',
    path: ['WARM_CONFIDENCE_THRESHOLD'],
  });

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${detail}`);
  }
  return result.data;
}
