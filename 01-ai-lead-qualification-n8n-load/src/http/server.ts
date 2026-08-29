import { randomUUID } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { AppError, ValidationError } from '../pipeline/errors.js';
import { processLead, type ProcessDeps } from '../pipeline/process-lead.js';
import { qualifyLead } from '../pipeline/qualify-lead.js';

export interface BuildServerOptions {
  config: Config;
  deps: ProcessDeps;
  logger: Logger;
}

export function buildServer({ config, deps, logger }: BuildServerOptions) {
  const app = Fastify({
    loggerInstance: logger,
    // n8n and most form tools send their own request id; reuse it so one id
    // traces a lead across n8n, this service, HubSpot and Slack.
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
    providers: { llm: deps.llm.name, crm: deps.crm.name, notifier: deps.notifier.name },
    rules: deps.rules,
  }));

  /** Assessment + routing decision, no side effects. This is what n8n calls. */
  app.post('/v1/qualify', async (request, reply) => {
    try {
      const { lead, qualification, suggestedReply } = await qualifyLead(request.body, deps);
      return reply.code(200).send({
        correlation_id: request.id,
        lead,
        qualification,
        suggested_reply: suggestedReply,
      });
    } catch (error) {
      return sendError(reply, error, request);
    }
  });

  /** The whole pipeline including CRM and Slack, for callers not using n8n. */
  app.post('/v1/leads', async (request, reply) => {
    try {
      const result = await processLead(request.body, request.id, deps);
      return reply.code(result.warnings.length > 0 ? 207 : 201).send(result);
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
    return reply.code(422).send({
      error: { code: error.code, message: error.message, issues: error.issues },
      correlation_id: request.id,
    });
  }

  if (error instanceof AppError) {
    // 502 tells n8n "this was not your fault, retry me"; 400 tells it "stop".
    const status = error.retryable ? 502 : 400;
    if (error.retryable) reply.header('retry-after', '5');
    return reply.code(status).send({
      error: { code: error.code, message: error.message, retryable: error.retryable },
      correlation_id: request.id,
    });
  }

  request.log.error({ err: error }, 'unhandled error');
  return reply.code(500).send({
    error: { code: 'internal_error', message: 'Unexpected error' },
    correlation_id: request.id,
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
