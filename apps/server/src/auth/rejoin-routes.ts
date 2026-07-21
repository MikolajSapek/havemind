import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  RejoinGrantError,
  RejoinGrantService,
} from './rejoin-grants.js';
import type { SessionRepository } from './session-repository.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const BEARER_PATTERN = /^Bearer (?<token>\S+)$/u;

/** Client-supplied identity headers are never trusted as product identity. */
const IDENTITY_HEADERS = [
  'x-actor-id',
  'x-havemind-actor-id',
  'x-havemind-user-id',
] as const;

type RejoinErrorCode =
  | 'FORBIDDEN'
  | 'GONE'
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'UNAUTHENTICATED';

export interface RejoinRoutesDeps {
  readonly database: Database.Database;
  readonly sessions: SessionRepository;
  readonly rejoin?: RejoinGrantService;
  readonly now?: () => Date;
}

const createGrantBodySchema = z
  .object({ membershipId: z.string().regex(UUID_PATTERN) })
  .strict();

const redeemBodySchema = z
  .object({
    deviceId: z.string().regex(UUID_PATTERN),
    initialRefreshTokenHash: z.string().regex(/^[0-9a-f]{64}$/u),
    membershipId: z.string().regex(UUID_PATTERN),
  })
  .strict();

interface MembershipRow {
  readonly membershipId: string;
  readonly role: string;
}

function sendError(
  reply: FastifyReply,
  status: number,
  code: RejoinErrorCode,
): FastifyReply {
  reply.header('cache-control', 'no-store');
  reply.code(status).send({ error: { code } });
  return reply;
}

function extractBearerToken(header: string | undefined): string | null {
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

function loadActiveMembership(
  database: Database.Database,
  userId: string,
  vaultId: string,
): MembershipRow | null {
  const row = database
    .prepare(
      `SELECT id AS membershipId, role
       FROM memberships
       WHERE user_id = ? AND vault_id = ? AND status = 'active'`,
    )
    .get(userId, vaultId) as MembershipRow | undefined;
  return row ?? null;
}

function loadTargetVault(
  database: Database.Database,
  membershipId: string,
): string | null {
  const row = database
    .prepare('SELECT vault_id AS vaultId FROM memberships WHERE id = ?')
    .get(membershipId) as { vaultId: string } | undefined;
  return row?.vaultId ?? null;
}

/**
 * Registers the F9 rejoin surface as a self-contained encapsulated plugin so it
 * does not touch the auth-routes module. Two endpoints:
 *
 * - `POST /owner/rejoin-grants` — owner-authenticated. Self-authenticates the
 *   bearer session (the protected-scope preHandler lives inside auth-routes and
 *   does not reach here), then requires the caller to be an active owner in the
 *   target membership's vault. Returns non-secret binding metadata only.
 * - `POST /auth/rejoin` — pre-auth. The invitee's terminal connection has no
 *   valid session, so no bearer is required; the grant is matched server-side by
 *   the (membershipId, deviceId) binding the invitee presents from its own
 *   data.json. Any failure is a flat 401 so a caller cannot distinguish cases.
 */
export function registerRejoinRoutes(
  app: FastifyInstance,
  deps: RejoinRoutesDeps,
): void {
  const now = deps.now ?? (() => new Date());
  const service =
    deps.rejoin ??
    new RejoinGrantService(deps.database, { now });

  void app.register(async (instance) => {
    instance.post('/owner/rejoin-grants', async (request, reply) => {
      const token = extractBearerToken(request.headers.authorization);
      if (token === null) {
        return sendError(reply, 401, 'UNAUTHENTICATED');
      }
      const session = deps.sessions.lookupAccess(token);
      if (session === null) {
        return sendError(reply, 401, 'UNAUTHENTICATED');
      }
      if (hasImpersonationHeader(request, session.userId)) {
        return sendError(reply, 403, 'FORBIDDEN');
      }
      const body = createGrantBodySchema.safeParse(request.body);
      if (!body.success) {
        return sendError(reply, 400, 'INVALID_REQUEST');
      }
      const vaultId = loadTargetVault(deps.database, body.data.membershipId);
      // A missing target and a target the caller cannot see are
      // indistinguishable from outside, so enumeration learns nothing.
      if (vaultId === null) {
        return sendError(reply, 403, 'FORBIDDEN');
      }
      const owner = loadActiveMembership(deps.database, session.userId, vaultId);
      if (owner === null || owner.role !== 'owner') {
        return sendError(reply, 403, 'FORBIDDEN');
      }
      try {
        const grant = service.createGrant({
          ownerMembershipId: owner.membershipId,
          targetMembershipId: body.data.membershipId,
        });
        reply.header('cache-control', 'no-store');
        return {
          boundDeviceId: grant.boundDeviceId,
          expiresAt: grant.expiresAt,
          membershipId: grant.membershipId,
          status: 'granted',
        };
      } catch (error) {
        return sendRejoinError(reply, error);
      }
    });

    instance.post('/auth/rejoin', async (request, reply) => {
      const body = redeemBodySchema.safeParse(request.body);
      if (!body.success) {
        return sendError(reply, 400, 'INVALID_REQUEST');
      }
      try {
        const result = service.redeemGrant({
          deviceId: body.data.deviceId,
          initialRefreshTokenHash: body.data.initialRefreshTokenHash,
          membershipId: body.data.membershipId,
        });
        reply.header('cache-control', 'no-store');
        return {
          deviceId: result.deviceId,
          membershipId: result.membershipId,
          refreshExpiresAt: result.refreshExpiresAt,
          status: 'rejoined',
          vaultId: result.vaultId,
        };
      } catch {
        // Any redemption failure — no grant, expired, consumed, wrong device,
        // inactive membership, malformed — is a flat 401 so a caller cannot
        // distinguish the cases (mirrors /auth/refresh and /owner/pair).
        return sendError(reply, 401, 'UNAUTHENTICATED');
      }
    });
  });
}

function sendRejoinError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof RejoinGrantError) {
    reply.header('cache-control', 'no-store');
    const code = REJOIN_CODE_BY_ERROR[error.code];
    reply.code(error.httpStatus).send({ error: { code } });
    return reply;
  }
  return sendError(reply, 500, 'INVALID_REQUEST');
}

const REJOIN_CODE_BY_ERROR: Readonly<
  Record<RejoinGrantError['code'], RejoinErrorCode>
> = {
  GRANT_NOT_FOUND: 'NOT_FOUND',
  INVALID_INPUT: 'INVALID_REQUEST',
  MEMBERSHIP_INACTIVE: 'FORBIDDEN',
  NO_BOUND_DEVICE: 'GONE',
  NOT_AUTHORIZED: 'FORBIDDEN',
  REPOSITORY_INTEGRITY: 'INVALID_REQUEST',
  WRONG_DEVICE: 'FORBIDDEN',
};
