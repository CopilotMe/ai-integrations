import { afterEach, describe, expect, it } from 'vitest';
import { FakeCrm } from '../src/adapters/fake/fake-crm.js';
import { FakeLlm } from '../src/adapters/fake/fake-llm.js';
import { FakeNotifier } from '../src/adapters/fake/fake-notifier.js';
import { InMemoryDeadLetter } from '../src/lib/deadletter.js';
import { CrmError } from '../src/pipeline/errors.js';
import type { ProcessDeps } from '../src/pipeline/process-lead.js';
import type { CrmPort } from '../src/ports/crm.js';
import { buildServer } from '../src/http/server.js';
import { coldLead, hotLead, instantRetries, silentLogger, testConfig, testRules } from './fixtures/leads.js';

const servers: Array<{ close: () => Promise<void> }> = [];

function build(overrides: Partial<ProcessDeps> = {}, env: Record<string, string> = {}) {
  const config = testConfig(env);
  const deps: ProcessDeps = {
    llm: new FakeLlm(),
    crm: new FakeCrm(),
    notifier: new FakeNotifier(),
    deadLetter: new InMemoryDeadLetter(),
    rules: testRules,
    logger: silentLogger,
    llmTimeoutMs: 1000,
    llmMaxRetries: 0,
    retryOverrides: instantRetries,
    ...overrides,
  };
  const app = buildServer({ config, deps, logger: silentLogger });
  servers.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((app) => app.close()));
});

describe('HTTP API', () => {
  it('GET /healthz reports ok', async () => {
    const response = await build().inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('GET /readyz reports the active providers and rules', async () => {
    const response = await build().inject({ method: 'GET', url: '/readyz' });
    expect(response.json().providers).toEqual({ llm: 'fake', crm: 'fake', notifier: 'fake' });
    expect(response.json().rules.hotScoreThreshold).toBe(75);
  });

  it('POST /v1/qualify returns a decision without touching the CRM', async () => {
    const crm = new FakeCrm();
    const response = await build({ crm }).inject({ method: 'POST', url: '/v1/qualify', payload: hotLead });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.qualification.classification).toBe('HOT');
    expect(body.qualification.next_action).toBe('sales_call');
    expect(body.correlation_id).toBeTruthy();
    expect(crm.contactCount).toBe(0);
  });

  it('POST /v1/leads runs the full pipeline and returns 201', async () => {
    const response = await build().inject({ method: 'POST', url: '/v1/leads', payload: hotLead });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.crm.contact.id).toBeTruthy();
    expect(body.crm.deal.id).toBeTruthy();
    expect(body.notified).toBe(true);
  });

  it('POST /v1/leads returns 207 when a non-critical step failed', async () => {
    const response = await build({
      notifier: {
        name: 'broken',
        notify: async () => {
          throw new Error('slack down');
        },
      },
    }).inject({ method: 'POST', url: '/v1/leads', payload: coldLead });

    expect(response.statusCode).toBe(207);
    expect(response.json().warnings).toContain('notification_failed');
  });

  it('returns 422 with per-field issues for an invalid payload', async () => {
    const response = await build().inject({
      method: 'POST',
      url: '/v1/leads',
      payload: { name: 'X', email: 'nope', message: '' },
    });

    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.error.code).toBe('validation_error');
    expect(body.error.issues.map((i: { path: string }) => i.path)).toEqual(
      expect.arrayContaining(['email', 'message']),
    );
  });

  it('returns a retryable 502 with Retry-After when the CRM is unavailable', async () => {
    const dead: CrmPort = {
      name: 'dead',
      upsertContact: async () => {
        throw new CrmError('503 from HubSpot', true);
      },
      createDeal: async () => {
        throw new Error('unreachable');
      },
    };

    const response = await build({ crm: dead }).inject({
      method: 'POST',
      url: '/v1/leads',
      payload: hotLead,
    });

    expect(response.statusCode).toBe(502);
    expect(response.headers['retry-after']).toBe('5');
    expect(response.json().error.retryable).toBe(true);
  });

  it('rejects a request with a wrong or missing webhook secret', async () => {
    const app = build({}, { WEBHOOK_SECRET: 'super-secret' });

    const missing = await app.inject({ method: 'POST', url: '/v1/leads', payload: hotLead });
    expect(missing.statusCode).toBe(401);

    const wrong = await app.inject({
      method: 'POST',
      url: '/v1/leads',
      payload: hotLead,
      headers: { 'x-webhook-secret': 'wrong-but-same-length' },
    });
    expect(wrong.statusCode).toBe(401);

    const correct = await app.inject({
      method: 'POST',
      url: '/v1/leads',
      payload: hotLead,
      headers: { 'x-webhook-secret': 'super-secret' },
    });
    expect(correct.statusCode).toBe(201);
  });

  it('echoes an inbound x-request-id so a lead can be traced across systems', async () => {
    const response = await build().inject({
      method: 'POST',
      url: '/v1/qualify',
      payload: hotLead,
      headers: { 'x-request-id': 'n8n-exec-4711' },
    });

    expect(response.headers['x-request-id']).toBe('n8n-exec-4711');
    expect(response.json().correlation_id).toBe('n8n-exec-4711');
  });

  it('names the correlation id identically on both endpoints', async () => {
    const app = build();
    const headers = { 'x-request-id': 'trace-me' };

    const qualify = await app.inject({ method: 'POST', url: '/v1/qualify', payload: hotLead, headers });
    const leads = await app.inject({ method: 'POST', url: '/v1/leads', payload: hotLead, headers });

    // Both responses are consumed by the same n8n expression, so the field
    // name must not differ between them.
    expect(qualify.json().correlation_id).toBe('trace-me');
    expect(leads.json().correlation_id).toBe('trace-me');
    expect(leads.json()).not.toHaveProperty('correlationId');
  });

  it('returns 404 for an unknown route', async () => {
    const response = await build().inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
  });
});
