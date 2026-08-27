import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('configuration', () => {
  it('applies safe defaults with an empty environment', () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    expect(config.LLM_PROVIDER).toBe('fake');
    expect(config.PORT).toBe(3000);
    expect(config.HOT_SCORE_THRESHOLD).toBe(75);
  });

  it('refuses to boot when a selected provider is missing its credential', () => {
    expect(() => loadConfig({ LLM_PROVIDER: 'openai' } as NodeJS.ProcessEnv)).toThrow(/OPENAI_API_KEY/);
    expect(() => loadConfig({ CRM_PROVIDER: 'hubspot' } as NodeJS.ProcessEnv)).toThrow(/HUBSPOT_ACCESS_TOKEN/);
    expect(() => loadConfig({ NOTIFIER_PROVIDER: 'slack' } as NodeJS.ProcessEnv)).toThrow(/SLACK_WEBHOOK_URL/);
  });

  it('refuses thresholds that would make WARM unreachable', () => {
    expect(() =>
      loadConfig({ HOT_SCORE_THRESHOLD: '40', WARM_SCORE_THRESHOLD: '60' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/WARM_SCORE_THRESHOLD/);
  });

  it('parses comma-separated lists', () => {
    const config = loadConfig({
      BLOCKED_EMAIL_DOMAINS: 'A.com, b.io ,',
      SLACK_NOTIFY_ON: 'hot, cold',
    } as NodeJS.ProcessEnv);
    expect(config.BLOCKED_EMAIL_DOMAINS).toEqual(['a.com', 'b.io']);
    expect(config.SLACK_NOTIFY_ON).toEqual(['HOT', 'COLD']);
  });
});
