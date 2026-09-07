import { randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AppError, ValidationError } from '../lib/errors';
import { logger } from '../lib/logger';

export function correlationIdFrom(request: Request): string {
  return request.headers.get('x-request-id') ?? request.headers.get('x-correlation-id') ?? randomUUID();
}

export function ok(body: unknown, status = 200, correlationId?: string): NextResponse {
  const response = NextResponse.json(body as Record<string, unknown>, { status });
  if (correlationId) response.headers.set('x-request-id', correlationId);
  return response;
}

/** Single place where an error becomes a status code and a safe body. */
export function fail(error: unknown, correlationId: string): NextResponse {
  if (error instanceof ValidationError) {
    return ok({ error: { code: error.code, message: error.message, issues: error.issues }, correlation_id: correlationId }, 422, correlationId);
  }

  if (error instanceof AppError) {
    const response = ok(
      { error: { code: error.code, message: error.message, retryable: error.retryable }, correlation_id: correlationId },
      error.status,
      correlationId,
    );
    if (error.retryable) response.headers.set('retry-after', '5');
    return response;
  }

  // Never leak an unexpected error's message: it can contain connection
  // strings, row contents, or stack frames.
  logger().error({ correlationId, err: error instanceof Error ? error.stack : String(error) }, 'unhandled error');
  return ok({ error: { code: 'internal_error', message: 'Unexpected error' }, correlation_id: correlationId }, 500, correlationId);
}

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(
      'Request body failed validation',
      result.error.issues.map((issue) => ({ path: issue.path.join('.') || '(root)', message: issue.message })),
    );
  }
  return result.data;
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ValidationError('Request body is not valid JSON', [{ path: '(root)', message: 'expected JSON' }]);
  }
}

/**
 * Rejects cross-site state changes.
 *
 * `SameSite=Lax` already blocks cross-site POSTs from forms, but not every
 * client honours it identically and it does nothing for same-site subdomains.
 * Comparing Origin against Host is the cheap, dependency-free second lock.
 */
export async function assertSameOrigin(): Promise<void> {
  const headerList = await headers();
  const origin = headerList.get('origin');
  if (!origin) return; // non-browser client; bearer auth governs these

  const host = headerList.get('host');
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new AppError('Malformed Origin header', 'forbidden', 403);
  }
  if (originHost !== host) {
    throw new AppError('Cross-origin request rejected', 'forbidden', 403);
  }
}
