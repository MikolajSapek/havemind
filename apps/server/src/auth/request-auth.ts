import type Database from 'better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AccessSession, SessionRepository } from './session-repository.js';

/**
 * The request authentication every protected route shares: the bearer access
 * token, the refusal of client-asserted identity headers, and the active
 * membership lookups that authorise a session against a vault. Each route
 * surface keeps its own rate limiter; these helpers only run after it.
 */

const BEARER_PATTERN = /^Bearer (?<token>\S+)$/u;

/**
 * Client-supplied identity headers are never trusted as product identity; a
 * request that tries to assert an actor other than the authenticated session is
 * treated as hostile rather than silently ignored.
 */
const IDENTITY_HEADERS = [
  'x-actor-id',
  'x-havemind-actor-id',
  'x-havemind-user-id',
] as const;

export interface ActiveMembership {
  readonly membershipId: string;
  readonly role: string;
}

/** Sends the secret-free `{ error: { code } }` body every route answers with. */
export function sendErrorCode(
  reply: FastifyReply,
  status: number,
  code: string,
): FastifyReply {
  reply.header('cache-control', 'no-store');
  reply.code(status).send({ error: { code } });
  return reply;
}

export function extractBearerToken(header: string | undefined): string | null {
  if (typeof header !== 'string') {
    return null;
  }
  return BEARER_PATTERN.exec(header)?.groups?.token ?? null;
}

function hasImpersonationHeader(
  request: FastifyRequest,
  authenticatedUserId: string,
): boolean {
  return IDENTITY_HEADERS.some((name) => {
    const value = request.headers[name];
    if (value === undefined) {
      return false;
    }
    const single = Array.isArray(value) ? value.join(',') : value;
    return single !== authenticatedUserId;
  });
}

/**
 * Authenticates the request's bearer access token. Answers 401 when the token
 * is absent or not a live session, and 403 when an identity header asserts
 * anyone else; the caller then returns `reply` untouched. Reuses the session
 * the rate limiter already resolved for this request when there is one (see
 * `resolvedAccessSession`), so the 4-table lookup runs once.
 */
export function authenticateBearer(
  request: FastifyRequest,
  reply: FastifyReply,
  sessions: SessionRepository,
): AccessSession | null {
  const token = extractBearerToken(request.headers.authorization);
  if (token === null) {
    sendErrorCode(reply, 401, 'UNAUTHENTICATED');
    return null;
  }
  const session =
    request.resolvedAccessSession !== undefined
      ? request.resolvedAccessSession
      : sessions.lookupAccess(token);
  if (session === null) {
    sendErrorCode(reply, 401, 'UNAUTHENTICATED');
    return null;
  }
  if (hasImpersonationHeader(request, session.userId)) {
    sendErrorCode(reply, 403, 'FORBIDDEN');
    return null;
  }
  return session;
}

/** The session the protected scope's preHandler attached, or 401. */
export function requireAuthSession(
  request: FastifyRequest,
  reply: FastifyReply,
): AccessSession | null {
  const session = request.authSession;
  if (session === undefined) {
    sendErrorCode(reply, 401, 'UNAUTHENTICATED');
    return null;
  }
  return session;
}

export function loadActiveMembership(
  database: Database.Database,
  userId: string,
  vaultId: string,
): ActiveMembership | null {
  const row = database
    .prepare(
      `SELECT id AS membershipId, role
       FROM memberships
       WHERE user_id = ? AND vault_id = ? AND status = 'active'`,
    )
    .get(userId, vaultId) as ActiveMembership | undefined;
  return row ?? null;
}

/** The vault a membership belongs to, whatever its status, or null. */
export function loadMembershipVault(
  database: Database.Database,
  membershipId: string,
): string | null {
  const row = database
    .prepare('SELECT vault_id AS vaultId FROM memberships WHERE id = ?')
    .get(membershipId) as { vaultId: string } | undefined;
  return row?.vaultId ?? null;
}
