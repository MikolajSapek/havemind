import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { registerSyncRoutes, type SyncRoutesDeps } from '../sync/sync-routes.js';
import type { InvitationService } from './invitations.js';
import {
  registerOwnerInvitationRoutes,
  registerPreAuthOnboardingRoutes,
} from './onboarding-routes.js';
import type { AccessSession, SessionRepository } from './session-repository.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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

const BEARER_PATTERN = /^Bearer (?<token>\S+)$/u;

const DEFAULT_RATE_LIMIT: AuthRateLimitConfig = {
  maxRequests: 120,
  windowMs: 60_000,
};

/** Stable machine error codes, deliberately free of any human/account detail. */
export type AuthErrorCode =
  | 'FORBIDDEN'
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED'
  | 'UNAUTHENTICATED';

export interface AuthRateLimitConfig {
  readonly maxRequests: number;
  readonly windowMs: number;
}

export interface AuthRoutesDeps {
  readonly database: Database.Database;
  readonly sessions: SessionRepository;
  readonly now?: () => Date;
  readonly rateLimit?: AuthRateLimitConfig;
  readonly clientKey?: (request: FastifyRequest) => string;
  readonly sync?: SyncRoutesDeps;
  readonly invitations?: InvitationService;
}

declare module 'fastify' {
  interface FastifyRequest {
    authSession?: AccessSession;
  }
}

const vaultParamsSchema = z.object({
  vaultId: z.string().regex(UUID_PATTERN),
});

interface MembershipRow {
  readonly membershipId: string;
  readonly role: string;
}

interface MemberRow {
  readonly displayName: string;
  readonly role: string;
}

function sendError(
  reply: FastifyReply,
  status: number,
  code: AuthErrorCode,
): FastifyReply {
  reply.header('cache-control', 'no-store');
  reply.code(status).send({ error: { code } });
  return reply;
}

function extractBearerToken(header: string | undefined): string | null {
  if (typeof header !== 'string') {
    return null;
  }
  const match = BEARER_PATTERN.exec(header);
  return match?.groups?.token ?? null;
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

function createRateLimiter(
  config: AuthRateLimitConfig,
  now: () => Date,
  clientKey: (request: FastifyRequest) => string,
): (request: FastifyRequest, reply: FastifyReply) => void {
  const windows = new Map<string, { count: number; resetAt: number }>();

  return (request, reply): void => {
    const key = clientKey(request);
    const nowMs = now().getTime();
    const existing = windows.get(key);
    const window =
      existing === undefined || existing.resetAt <= nowMs
        ? { count: 0, resetAt: nowMs + config.windowMs }
        : existing;
    window.count += 1;
    windows.set(key, window);

    if (window.count > config.maxRequests) {
      sendError(reply, 429, 'RATE_LIMITED');
    }
  };
}

/**
 * Keys an authenticated device's requests by its own device identity rather
 * than by IP: behind Tailscale serve (`trustProxy: false`) every request
 * arrives from the loopback address, so IP-keying would put every device
 * sharing that tunnel into one global bucket and let one device's bulk
 * traffic 429 every other device. Falls back to IP for requests that carry
 * no valid session — pairing/approval endpoints never send a bearer token,
 * so they keep the IP-keyed brute-force protection unchanged.
 */
function defaultClientKey(
  sessions: SessionRepository,
): (request: FastifyRequest) => string {
  return (request) => {
    const token = extractBearerToken(request.headers.authorization);
    if (token === null) {
      return request.ip;
    }
    const session = sessions.lookupAccess(token);
    return session === null ? request.ip : `device:${session.deviceId}`;
  };
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

function loadVaultMembers(
  database: Database.Database,
  vaultId: string,
): readonly MemberRow[] {
  return database
    .prepare(
      `SELECT users.display_name AS displayName, memberships.role AS role
       FROM memberships
       INNER JOIN users ON users.id = memberships.user_id
       WHERE memberships.vault_id = ? AND memberships.status = 'active'
       ORDER BY memberships.created_at, users.display_name`,
    )
    .all(vaultId) as MemberRow[];
}

/**
 * Registers the protected surface behind a central deny-by-default guard: an
 * unauthenticated rate limiter runs first, then session authentication, then
 * per-vault authorization. Everything is encapsulated so the hooks never touch
 * public discovery/health routes.
 */
export function registerAuthRoutes(
  app: FastifyInstance,
  deps: AuthRoutesDeps,
): void {
  const now = deps.now ?? (() => new Date());
  const clientKey = deps.clientKey ?? defaultClientKey(deps.sessions);
  const rateLimit = createRateLimiter(
    deps.rateLimit ?? DEFAULT_RATE_LIMIT,
    now,
    clientKey,
  );

  const invitations = deps.invitations;
  const onboardingDeps =
    invitations === undefined
      ? undefined
      : {
          database: deps.database,
          invitations,
          sessions: deps.sessions,
          ...(deps.sync === undefined
            ? {}
            : { revisions: deps.sync.revisions }),
        };

  if (onboardingDeps !== undefined) {
    // Pre-authentication scope: rate limited so a flood is rejected before any
    // invitation lookup, but no bearer session is required — the joining device
    // has no session yet.
    void app.register(async (instance) => {
      instance.addHook('onRequest', async (request, reply) => {
        rateLimit(request, reply);
      });
      registerPreAuthOnboardingRoutes(instance, onboardingDeps);
    });
  }

  void app.register(async (instance) => {
    instance.addHook('onRequest', async (request, reply) => {
      rateLimit(request, reply);
    });

    instance.addHook('preHandler', async (request, reply) => {
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
      request.authSession = session;
      return undefined;
    });

    instance.get('/vaults/:vaultId/members', async (request, reply) => {
      const params = vaultParamsSchema.safeParse(request.params);
      if (!params.success) {
        return sendError(reply, 400, 'INVALID_REQUEST');
      }
      const session = request.authSession;
      if (session === undefined) {
        return sendError(reply, 401, 'UNAUTHENTICATED');
      }

      const membership = loadActiveMembership(
        deps.database,
        session.userId,
        params.data.vaultId,
      );
      // A missing vault and a vault the caller cannot see are indistinguishable
      // from outside, so IDOR enumeration learns nothing.
      if (membership === null) {
        return sendError(reply, 403, 'FORBIDDEN');
      }

      reply.header('cache-control', 'no-store');
      return {
        members: loadVaultMembers(deps.database, params.data.vaultId),
        role: membership.role,
        vaultId: params.data.vaultId,
      };
    });

    if (onboardingDeps !== undefined) {
      registerOwnerInvitationRoutes(instance, onboardingDeps);
    }

    if (deps.sync !== undefined) {
      registerSyncRoutes(instance, deps.sync);
    }
  });
}
