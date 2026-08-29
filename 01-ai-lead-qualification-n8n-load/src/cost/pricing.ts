import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const PricingFileSchema = z.object({
  as_of: z.string(),
  source: z.string(),
  usd_per_eur: z.number().positive(),
  models: z.record(
    z.string(),
    z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() }),
  ),
});

export type PricingFile = z.infer<typeof PricingFileSchema>;
export interface ModelPricing {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

const configPath = join(dirname(fileURLToPath(import.meta.url)), '../../config/pricing.json');

let cached: PricingFile | null = null;

/**
 * Prices are configuration, not code.
 *
 * They change without warning, and a number baked into a source file is a
 * number nobody updates. `config/pricing.json` carries an `as_of` date that is
 * printed on every report, so a stale figure is visible rather than silently
 * wrong.
 */
export function loadPricing(path: string = configPath): PricingFile {
  if (cached && path === configPath) return cached;
  const parsed = PricingFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (path === configPath) cached = parsed;
  return parsed;
}

export function pricingFor(model: string, pricing: PricingFile = loadPricing()): ModelPricing {
  const found = pricing.models[model];
  if (found) return found;
  const available = Object.keys(pricing.models).join(', ');
  throw new Error(`No pricing for model "${model}". Add it to config/pricing.json. Known: ${available}`);
}
