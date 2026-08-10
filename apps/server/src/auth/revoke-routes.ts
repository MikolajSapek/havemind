import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  createRateLimiter,
  DEFAULT_RATE_LIMIT,
  type AuthRateLimitConfig,
} from './auth-routes.js';
import {
  MembershipRevocationError,
  MembershipRevocationService,
} from './membership-revocation.js';
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

type RevokeErrorCode =
  | 'FORBIDDEN'
  | 'INTERNAL'
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'UNAUTHENTICATED';

export interface RevokeRoutesDeps {
  readonly database: Database.Database;
  readonly sessions: SessionRepository;
  readonly revocation?: MembershipRevocationService;
  readonly now?: () => Date;
  readonly rateLimit?: AuthRateLimitConfig;
}

const membershipParamsSchema = z
  .object({ membershipId: z.string().regex(UUID_PATTERN) })
  .strict();

interface MembershipRow {
  readonly membershipId: string;
  readonly role: string;
}

function sendError(
  reply: FastifyReply,
  status: number,
  code: RevokeErrorCode,
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

const REVOKE_CODE_BY_ERROR: Readonly<
  Record<MembershipRevocationError['code'], RevokeErrorCode>
> = {
  INVALID_INPUT: 'INVALID_REQUEST',
  MEMBERSHIP_NOT_FOUND: 'NOT_FOUND',
};

/**
 * Resolves a revoke-path error to its HTTP status and error code. A domain
 * {@link MembershipRevocationError} carries its own status and a 4xx code; any
 * OTHER (unexpected) error is a server fault, so it maps to a 500-flavoured
 * `INTERNAL` code — never the client-facing `INVALID_REQUEST`, which would
 * mislabel a server bug as a bad request (MINOR 10, matching sibling routes).
 */
export function resolveRevokeError(error: unknown): {
  readonly status: number;
  readonly code: RevokeErrorCode;
} {
  if (error instanceof MembershipRevocationError) {
    return { status: error.httpStatus, code: REVOKE_CODE_BY_ERROR[error.code] };
  }
  return { status: 500, code: 'INTERNAL' };
}

function sendRevokeError(reply: FastifyReply, error: unknown): FastifyReply {
  const { status, code } = resolveRevokeError(error);
  return sendError(reply, status, code);
}

/**
 * Registers the owner-only "remove member" surface as a self-contained
 * encapsulated plugin so it does not touch the auth-routes module (mirrors the
 * rejoin surface). One endpoint:
 *
 * - `POST /owner/memberships/:membershipId/revoke` — owner-authenticated. Self-
 *   authenticates the bearer session (the protected-scope preHandler lives
 *   inside auth-routes and does not reach here), then requires the caller to be
 *   an active owner in the target membership's vault. The owner may never revoke
 *   their own membership. On success the membership and every device the member
 *   owns are permanently revoked (append-only — a status change, never a delete)
 *   in one transaction, so the member's past revisions and attribution survive
 *   while their sessions are burned and they are terminally locked out.
 *
 * The route is rate limited like every sibling surface: an unauthenticated
 * attempt still costs a session lookup plus two membership queries, so the
 * limiter runs before the handler rather than after the bearer check.
 */
export function registerRevokeRoutes(
  app: FastifyInstance,
  deps: RevokeRoutesDeps,
): void {
  const now = deps.now ?? (() => new Date());
  const service =
    deps.revocation ?? new MembershipRevocationService(deps.database, { now });
  // Keyed by IP, as on the rejoin surface: the session-aware `defaultClientKey`
  // lives inside auth-routes and is deliberately not exported, so this module
  // stays decoupled from it and reuses only the limiter factory.
  const rateLimit = createRateLimiter(
    deps.rateLimit ?? DEFAULT_RATE_LIMIT,
    now,
    (request) => request.ip,
  );

  void app.register(async (instance) => {
    instance.addHook('onRequest', async (request, reply) => {
      rateLimit(request, reply);
    });

    instance.post(
      '/owner/memberships/:membershipId/revoke',
      async (request, reply) => {
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
        const params = membershipParamsSchema.safeParse(request.params);
        if (!params.success) {
          return sendError(reply, 400, 'INVALID_REQUEST');
        }
        const targetMembershipId = params.data.membershipId;
        const vaultId = loadTargetVault(deps.database, targetMembershipId);
        // A missing target and a target the caller cannot see are
        // indistinguishable from outside, so enumeration learns nothing.
        if (vaultId === null) {
          return sendError(reply, 403, 'FORBIDDEN');
        }
        const owner = loadActiveMembership(
          deps.database,
          session.userId,
          vaultId,
        );
        if (owner === null || owner.role !== 'owner') {
          return sendError(reply, 403, 'FORBIDDEN');
        }
        // The owner can never revoke their own membership: that would strip the
        // vault of its only administrator and lock everyone out irreversibly.
        if (owner.membershipId === targetMembershipId) {
          return sendError(reply, 403, 'FORBIDDEN');
        }
        try {
          const result = service.revokeMembership({
            membershipId: targetMembershipId,
          });
          reply.header('cache-control', 'no-store');
          return {
            membershipId: result.membershipId,
            status: result.status,
          };
        } catch (error) {
          return sendRevokeError(reply, error);
        }
      },
    );
  });
}
