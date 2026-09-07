import { cookies, headers } from 'next/headers';
import type { Actor } from '../core/domain/types';
import { getDb } from '../db/client';
import { deleteSession, findApiKey, findSession, touchApiKey } from '../db/repositories';
import { hashToken } from '../lib/crypto';
import { ForbiddenError, UnauthorizedError } from '../lib/errors';

export const SESSION_COOKIE = 'ops_session';
export const SESSION_TTL_HOURS = 12;

export interface AuthenticatedOperator {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'agent' | 'viewer';
}

/**
 * Resolves the signed-in operator, or null.
 *
 * The cookie value is hashed before lookup, so the stored row is not itself a
 * usable credential — a database dump does not hand over live sessions.
 */
export async function currentOperator(): Promise<AuthenticatedOperator | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const found = await findSession(getDb(), hashToken(token));
  if (!found) return null;

  return {
    id: found.operator.id,
    email: found.operator.email,
    name: found.operator.name,
    role: found.operator.role,
  };
}

export async function requireOperator(): Promise<AuthenticatedOperator> {
  const operator = await currentOperator();
  if (!operator) throw new UnauthorizedError();
  return operator;
}

/** Viewers can read everything and change nothing. */
export function requireWriteRole(operator: AuthenticatedOperator): void {
  if (operator.role === 'viewer') {
    throw new ForbiddenError('Your account has read-only access.');
  }
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await deleteSession(getDb(), hashToken(token));
  jar.delete(SESSION_COOKIE);
}

/**
 * Authenticates a machine client from `Authorization: Bearer …`.
 *
 * Used by the intake endpoint, which n8n calls. Separate from operator auth on
 * purpose: a key that can post messages must not be able to approve them.
 */
export async function requireApiKey(scope: string): Promise<Extract<Actor, { kind: 'api_key' }>> {
  const headerList = await headers();
  const authorization = headerList.get('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing bearer token');
  }

  const key = await findApiKey(getDb(), hashToken(authorization.slice(7).trim()));
  if (!key) throw new UnauthorizedError('Invalid or revoked API key');
  if (!key.scopes.includes(scope)) {
    throw new ForbiddenError(`This key does not have the "${scope}" scope`);
  }

  // Fire-and-forget: last-used tracking must never fail a request.
  void touchApiKey(getDb(), key.id).catch(() => {});
  return { kind: 'api_key', id: key.id, name: key.name };
}

export function sessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    // `lax` rather than `strict`: an operator following a Slack link into the
    // review queue must arrive signed in, or the notification is useless. All
    // mutations are POSTs guarded by an origin check, which is what actually
    // stops cross-site writes.
    secure,
    path: '/',
    maxAge: SESSION_TTL_HOURS * 3600,
  };
}
