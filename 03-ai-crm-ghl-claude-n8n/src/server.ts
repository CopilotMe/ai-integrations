import { randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import { AppError, ValidationError } from './lib/errors.js';
import type { Logger } from './lib/logger.js';
import { qualifyLead, type PipelineDeps } from './pipeline/qualify-lead.js';

export interface BuildServerOptions {
  config: Config;
  deps: PipelineDeps;
  logger: Logger;
}

export function buildServer({ config, deps, logger }: BuildServerOptions) {
  const app = Fastify({
    loggerInstance: logger,
    // Reuse n8n's execution id when it sends one, so a single identifier traces
    // a lead across GoHighLevel, n8n, this service and Claude.
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
    bodyLimit: 256 * 1024,
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    if (request.method !== 'POST' || !request.url.startsWith('/v1/')) return;
    if (!config.WEBHOOK_SECRET) return;

    const provided = request.headers['x-webhook-secret'];
    if (typeof provided !== 'string' || !constantTimeEqual(provided, config.WEBHOOK_SECRET)) {
      return reply.code(401).send({ error: { code: 'unauthorized', message: 'Invalid webhook secret' } });
    }
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async () => ({
    status: 'ok',
    providers: { assessor: deps.assessor.name, crm: deps.crm.name },
    rules: deps.rules,
  }));

  /** What n8n posts a normalised GoHighLevel contact webhook to. */
  app.post('/v1/leads', async (request, reply) => {
    try {
      const result = await qualifyLead(request.body, request.id, deps);
      return reply.code(result.duplicate ? 200 : 201).send({
        correlation_id: request.id,
        contact_id: result.lead.contact_id,
        event_id: result.lead.event_id,
        duplicate: result.duplicate,
        decision: result.decision,
        crm: result.crm,
        usage: result.usage,
      });
    } catch (error) {
      return sendError(reply, error, request);
    }
  });

  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({ error: { code: 'not_found', message: 'No such route' } }),
  );

  return app;
}

function sendError(reply: FastifyReply, error: unknown, request: FastifyRequest) {
  if (error instanceof ValidationError) {
    return reply
      .code(422)
      .send({ error: { code: error.code, message: error.message, issues: error.issues }, correlation_id: request.id });
  }

  if (error instanceof AppError) {
    // A retryable status tells n8n "not your fault, try again"; a 4xx tells it
    // to stop, because the same payload will fail identically next time.
    if (error.retryable) reply.header('retry-after', '5');
    return reply.code(error.retryable ? 502 : error.status).send({
      error: { code: error.code, message: error.message, retryable: error.retryable },
      correlation_id: request.id,
    });
  }

  request.log.error({ err: error }, 'unhandled error');
  return reply
    .code(500)
    .send({ error: { code: 'internal_error', message: 'Unexpected error' }, correlation_id: request.id });
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
