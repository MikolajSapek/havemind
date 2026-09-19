import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { DEFAULT_VAULT_QUOTA_BYTES } from '../config.js';
import {
  computeVaultStorageBytes,
  readVaultQuotaBytes,
  resolveEffectiveQuotaBytes,
} from '../quota.js';
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

export const DEFAULT_RATE_LIMIT: AuthRateLimitConfig = {
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
  /**
   * Returning `null` marks the request as exempt from the rate limiter
   * entirely (see {@link defaultClientKey}); returning a string keys it into
   * that bucket as usual.
   */
  readonly clientKey?: (request: FastifyRequest) => string | null;
  readonly sync?: SyncRoutesDeps;
  readonly invitations?: InvitationService;
  /**
   * Server-wide default per-vault quota reported to members alongside usage when
   * a vault has no explicit `quota_bytes`. Defaults to
   * {@link DEFAULT_VAULT_QUOTA_BYTES}; wire {@link ServerConfig.vaultQuotaBytes}.
   */
  readonly vaultQuotaBytes?: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    authSession?: AccessSession;
    /**
     * Set by the rate limiter's `clientKey` when it already resolved the
     * bearer token this request carries (see {@link defaultClientKey}), so
     * the auth `preHandler` can reuse that lookup instead of hitting
     * `lookupAccess`'s 4-table join a second time. `undefined` means no
     * lookup has happened yet for this request (custom `clientKey`, or a
     * route the limiter never ran on) and the preHandler must do its own;
     * `null` means the lookup ran and found no valid session. Set fresh on
     * every request object, so it never survives across requests.
     */
    resolvedAccessSession?: AccessSession | null;
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

/**
 * A rate limiter, plus the bookkeeping a test needs to observe its eviction
 * (AUD2-01) without reaching into the closure.
 */
export interface RateLimiter {
  (request: FastifyRequest, reply: FastifyReply): void;
  /** Number of windows currently held in memory. */
  trackedKeys: () => number;
}

/**
 * Map size below which the expired-window sweep is skipped. The pilot has two
 * devices, so the steady state is a handful of keys and sweeping them costs
 * more than it reclaims; the sweep only earns its keep once a long-lived
 * process has accumulated dead buckets from many distinct keys.
 */
const SWEEP_THRESHOLD_KEYS = 32;

export function createRateLimiter(
  config: AuthRateLimitConfig,
  now: () => Date,
  clientKey: (request: FastifyRequest) => string | null,
): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();

  /**
   * Evicts windows whose `resetAt` has passed (AUD2-01). Deliberately a lazy
   * sweep driven by request traffic rather than a `setInterval`: a timer would
   * outlive the Fastify instance that owns this limiter and keep the process
   * alive, which is exactly the listener/timer-ownership discipline the plugin
   * documents in `scheduler-hooks.ts`. Cost is amortised, it only runs once the
   * map is large enough for dead entries to matter.
   */
  const sweep = (nowMs: number): void => {
    if (windows.size < SWEEP_THRESHOLD_KEYS) {
      return;
    }
    for (const [key, window] of windows) {
      if (window.resetAt <= nowMs) {
        windows.delete(key);
      }
    }
  };

  const limiter = (request: FastifyRequest, reply: FastifyReply): void => {
    const key = clientKey(request);
    if (key === null) {
      // Exempt: an authenticated, session-verified blob GET or long-poll wait.
      // It never consumes a bucket slot, see `defaultClientKey` for why.
      return;
    }
    const nowMs = now().getTime();
    sweep(nowMs);
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
  limiter.trackedKeys = (): number => windows.size;
  return limiter;
}

/** The blob-download route, as Fastify reports it via `request.routeOptions.url`. */
const BLOB_GET_ROUTE_PATTERN = '/vaults/:vaultId/blobs/:blobHash';

/** The long-poll wake route, as Fastify reports it via `request.routeOptions.url`. */
const WAIT_ROUTE_PATTERN = '/vaults/:vaultId/wait';

/**
 * True for a `GET` on the blob-download route. Draining a large pull backlog
 * fetches one blob per applied revision (see `sync-runner.ts`), so this is
 * the only per-revision amplifier in the auth/sync surface, everything else
 * is at most one request per sync cycle.
 */
function isBlobGetRoute(request: FastifyRequest): boolean {
  return (
    request.method === 'GET' &&
    request.routeOptions?.url === BLOB_GET_ROUTE_PATTERN
  );
}

/**
 * True for a `GET` on the long-poll wake route (GAP-4). This is a held
 * request that reconnects roughly every 25s, not a mutation, and it never
 * counts against a client-controlled amplification factor the way blob GET
 * does, it is a single held connection, not one-per-revision. Excluding it
 * from the bucket the same way as blob GET stops a reconnect storm (each
 * iteration doing `/auth/refresh` + `/wait` + pull) from momentarily
 * exhausting the per-device bucket and 429ing the real-time-push long-poll.
 */
function isWaitGetRoute(request: FastifyRequest): boolean {
  return (
    request.method === 'GET' && request.routeOptions?.url === WAIT_ROUTE_PATTERN
  );
}

/**
 * Keys an authenticated device's requests by its own device identity rather
 * than by IP: behind Tailscale serve (`trustProxy: false`) every request
 * arrives from the loopback address, so IP-keying would put every device
 * sharing that tunnel into one global bucket and let one device's bulk
 * traffic 429 every other device. Falls back to IP for requests that carry
 * no valid session, pairing/approval endpoints never send a bearer token,
 * so they keep the IP-keyed brute-force protection unchanged.
 *
 * A `GET` on the blob route from a session-verified caller returns `null`
 * (rate-limit exempt) instead of a key: it is the only way to drain a large
 * (>100-revision) catch-up backlog, one blob fetch per applied revision,
 * without the per-device bucket 429ing mid-drain (AUD-08).
 *
 * Exempt from *this* limiter is not unlimited (AUD2-06). The route stays
 * bounded on two axes handled in `sync-routes.ts`: `blobBelongsToVault`
 * guards which bytes an authenticated member may read at all, and every
 * served blob is charged by byte length against a per-device egress token
 * bucket (`BlobByteRateLimiter`, AUD-08b) that answers 429 once a device
 * outruns its budget. Request-count limiting is the wrong instrument for an
 * amplifier whose cost is bytes, not requests, so the count exemption stays
 * and the byte budget is the real cap.
 *
 * A `GET` on the long-poll wake route is exempted the same way (GAP-4): it
 * is a held connection that reconnects roughly every 25s, never a mutation,
 * so it must not compete with a device's mutation traffic for the same
 * bucket slots during a reconnect storm. It too is separately bounded, by
 * the per-device/global held-wait ceiling (`HeldWaitLimiter`, AUD-08b).
 */
export function defaultClientKey(
  sessions: SessionRepository,
): (request: FastifyRequest) => string | null {
  return (request) => {
    const token = extractBearerToken(request.headers.authorization);
    if (token === null) {
      return request.ip;
    }
    const session = sessions.lookupAccess(token);
    // Stashed so the auth preHandler that runs immediately after this
    // limiter can reuse the lookup instead of repeating the 4-table join.
    request.resolvedAccessSession = session;
    if (session === null) {
      return request.ip;
    }
    if (isBlobGetRoute(request) || isWaitGetRoute(request)) {
      return null;
    }
    return `device:${session.deviceId}`;
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
    // invitation lookup, but no bearer session is required, the joining device
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
      // Reuse the rate limiter's lookup when it already resolved this
      // request's token (see `resolvedAccessSession`'s doc comment); fall
      // back to a fresh lookup for a custom `clientKey` that skips the
      // stash, or for any route the limiter hook didn't run on.
      const session =
        request.resolvedAccessSession !== undefined
          ? request.resolvedAccessSession
          : deps.sessions.lookupAccess(token);
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

      // Storage usage/quota is exposed only to an active member of this vault
      // (deny-by-default already enforced above), never leaking other vaults'
      // numbers or any payload content, it is a pure blob_size/blob_hash sum.
      reply.header('cache-control', 'no-store');
      return {
        members: loadVaultMembers(deps.database, params.data.vaultId),
        quotaBytes: resolveEffectiveQuotaBytes(
          readVaultQuotaBytes(deps.database, params.data.vaultId),
          deps.vaultQuotaBytes ?? DEFAULT_VAULT_QUOTA_BYTES,
        ),
        role: membership.role,
        storageBytes: computeVaultStorageBytes(
          deps.database,
          params.data.vaultId,
        ),
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
