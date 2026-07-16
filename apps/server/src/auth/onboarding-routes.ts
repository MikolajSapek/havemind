import { randomBytes, randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { RevisionRepository } from '../revision-repository.js';
import {
  InvitationError,
  type InvitationRole,
  type InvitationService,
} from './invitations.js';
import { OwnerSetupService } from './setup.js';
import { type SessionRepository } from './session-repository.js';
import type { AccessSession } from './session-repository.js';

const OWNER_DEVICE_PUBLIC_KEY_LENGTH = 32;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const DEFAULT_BOOTSTRAP_PAGE_ITEMS = 100;

/** Pre-auth onboarding credentials travel in headers, never in query strings. */
const PENDING_CREDENTIAL_HEADER = 'x-havemind-pending-credential';
const REFRESH_TOKEN_HEADER = 'x-havemind-refresh-token';

export interface OnboardingRoutesDeps {
  readonly invitations: InvitationService;
  readonly sessions: SessionRepository;
  readonly database: Database.Database;
  readonly revisions?: Pick<RevisionRepository, 'listEvents'>;
}

/** Stable, secret-free machine error code for the onboarding surface. */
type OnboardingErrorCode =
  | 'FORBIDDEN'
  | 'GONE'
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'REDEEMED'
  | 'UNAUTHENTICATED';

const reviewBodySchema = z
  .object({ invitationToken: z.string().min(1).max(200) })
  .strict();

const redeemBodySchema = z
  .object({
    deviceLabel: z.string().min(1).max(80),
    initialRefreshToken: z.string().min(1).max(200),
    invitationToken: z.string().min(1).max(200),
    redemptionId: z.string().regex(UUID_PATTERN),
  })
  .strict();

const refreshBodySchema = z
  .object({
    refreshToken: z.string().min(1).max(200),
    rotationId: z.string().min(1).max(200),
    successorRefreshToken: z.string().min(1).max(200),
  })
  .strict();

const ownerPairBodySchema = z
  .object({
    deviceLabel: z.string().min(1).max(80),
    initialRefreshToken: z.string().min(1).max(200),
    pairingToken: z.string().min(1).max(200),
  })
  .strict();

const invitationCreateBodySchema = z
  .object({
    intendedMemberDisplayName: z.string().min(1).max(80).optional(),
    intendedRole: z.enum(['editor', 'owner']).optional(),
  })
  .strict();

const approveBodySchema = z
  .object({ verificationPhrase: z.string().min(1).max(200) })
  .strict();

const deviceParamsSchema = z.object({
  deviceId: z.string().regex(UUID_PATTERN),
});

const vaultParamsSchema = z.object({
  vaultId: z.string().regex(UUID_PATTERN),
});

const invitationVaultParamsSchema = z.object({
  invitationId: z.string().regex(UUID_PATTERN),
  vaultId: z.string().regex(UUID_PATTERN),
});

const bootstrapQuerySchema = z
  .object({ cursor: z.string().min(1).max(200).optional() })
  .strict();

interface MembershipRow {
  readonly membershipId: string;
  readonly role: string;
}

function sendError(
  reply: FastifyReply,
  status: number,
  code: OnboardingErrorCode,
): FastifyReply {
  reply.header('cache-control', 'no-store');
  reply.code(status).send({ error: { code } });
  return reply;
}

/**
 * Maps a service error to the event-table status codes (410 expired, 409
 * already redeemed, 403 not authorised, 404 unknown) without leaking human
 * detail. Any unexpected error becomes an opaque 500.
 */
function sendInvitationError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof InvitationError) {
    reply.header('cache-control', 'no-store');
    const code = ONBOARDING_CODE_BY_INVITATION[error.code];
    reply.code(error.httpStatus).send({ error: { code } });
    return reply;
  }
  return sendError(reply, 500, 'INVALID_REQUEST');
}

const ONBOARDING_CODE_BY_INVITATION: Readonly<
  Record<InvitationError['code'], OnboardingErrorCode>
> = {
  INVALID_INPUT: 'INVALID_REQUEST',
  INVALID_INVITATION: 'NOT_FOUND',
  INVITATION_ALREADY_REDEEMED: 'REDEEMED',
  INVITATION_EXPIRED: 'GONE',
  NO_PENDING_DEVICE: 'REDEEMED',
  NOT_AUTHORIZED: 'FORBIDDEN',
  PHRASE_MISMATCH: 'FORBIDDEN',
  REPOSITORY_INTEGRITY: 'INVALID_REQUEST',
};

function singleHeader(value: string | string[] | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  return Array.isArray(value) ? (value[0] ?? null) : value;
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

function loadFirstActiveVault(
  database: Database.Database,
  userId: string,
): string | null {
  const row = database
    .prepare(
      `SELECT vault_id AS vaultId
       FROM memberships
       WHERE user_id = ? AND status = 'active'
       ORDER BY created_at, vault_id
       LIMIT 1`,
    )
    .get(userId) as { vaultId: string } | undefined;
  return row?.vaultId ?? null;
}

/**
 * Registers the pre-authentication onboarding routes. The caller must register
 * these inside the rate-limited (but unauthenticated) scope from auth-routes so
 * a flood is rejected with 429 before any invitation lookup runs.
 */
export function registerPreAuthOnboardingRoutes(
  instance: FastifyInstance,
  deps: OnboardingRoutesDeps,
): void {
  instance.post('/invitations/review', async (request, reply) => {
    const body = reviewBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, 'INVALID_REQUEST');
    }
    try {
      const review = deps.invitations.reviewInvitation(
        body.data.invitationToken,
      );
      reply.header('cache-control', 'no-store');
      return { ...review, version: 1 };
    } catch (error) {
      return sendInvitationError(reply, error);
    }
  });

  instance.post('/invitations/redeem', async (request, reply) => {
    const body = redeemBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, 'INVALID_REQUEST');
    }
    try {
      const result = deps.invitations.redeemInvitationForOnboarding({
        deviceLabel: body.data.deviceLabel,
        initialRefreshToken: body.data.initialRefreshToken,
        invitationToken: body.data.invitationToken,
        redemptionId: body.data.redemptionId,
      });
      reply.header('cache-control', 'no-store');
      return {
        pendingCredential: result.pendingCredential,
        pendingDeviceId: result.pendingDeviceId,
        status: 'pending',
        verificationPhrase: result.verificationPhrase,
      };
    } catch (error) {
      return sendInvitationError(reply, error);
    }
  });

  instance.get('/devices/:deviceId/approval', async (request, reply) => {
    const params = deviceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 400, 'INVALID_REQUEST');
    }
    const credential = singleHeader(request.headers[PENDING_CREDENTIAL_HEADER]);
    if (credential === null) {
      return sendError(reply, 400, 'INVALID_REQUEST');
    }
    try {
      const status = deps.invitations.getApprovalStatus(
        params.data.deviceId,
        credential,
      );
      reply.header('cache-control', 'no-store');
      return status;
    } catch (error) {
      return sendInvitationError(reply, error);
    }
  });

  instance.post('/auth/refresh', async (request, reply) => {
    const body = refreshBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, 'INVALID_REQUEST');
    }
    try {
      const rotated = deps.sessions.rotateRefresh({
        currentRefreshToken: body.data.refreshToken,
        rotationId: body.data.rotationId,
        successorRefreshToken: body.data.successorRefreshToken,
      });
      reply.header('cache-control', 'no-store');
      return {
        accessExpiresAt: rotated.accessExpiresAt,
        accessToken: rotated.accessToken,
      };
    } catch {
      // Any rotation failure — invalid, reused, revoked — is a flat 401 so a
      // caller cannot distinguish an unknown token from a burned family.
      return sendError(reply, 401, 'UNAUTHENTICATED');
    }
  });

  instance.post('/owner/pair', async (request, reply) => {
    const body = ownerPairBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, 'INVALID_REQUEST');
    }
    const service = new OwnerSetupService(deps.database);
    try {
      // The joining device has no keypair in the pilot, so a placeholder public
      // key is generated server-side (mirrors the invitee redeem flow). The
      // pairing is single-use: `pairOwnerDevice` consumes it in one transaction.
      const result = service.pairOwnerDevice({
        deviceDisplayName: body.data.deviceLabel,
        deviceId: randomUUID(),
        initialRefreshToken: body.data.initialRefreshToken,
        pairingToken: body.data.pairingToken,
        publicKey: randomBytes(OWNER_DEVICE_PUBLIC_KEY_LENGTH),
      });
      const vaultId = loadFirstActiveVault(deps.database, result.ownerUserId);
      if (vaultId === null) {
        return sendError(reply, 403, 'FORBIDDEN');
      }
      reply.header('cache-control', 'no-store');
      return {
        accessExpiresAt: result.accessExpiresAt,
        accessToken: result.accessToken,
        deviceId: result.deviceId,
        vaultId,
      };
    } catch {
      // Any pairing failure — unknown, expired, already consumed, malformed —
      // is a flat 401 so a caller cannot distinguish the cases.
      return sendError(reply, 401, 'UNAUTHENTICATED');
    }
  });

  instance.get('/bootstrap', async (request, reply) => {
    const query = bootstrapQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendError(reply, 400, 'INVALID_REQUEST');
    }
    const refreshToken = singleHeader(request.headers[REFRESH_TOKEN_HEADER]);
    if (refreshToken === null) {
      return sendError(reply, 400, 'INVALID_REQUEST');
    }
    const context = deps.sessions.lookupRefreshContext(refreshToken);
    if (context === null) {
      return sendError(reply, 401, 'UNAUTHENTICATED');
    }
    const vaultId = loadFirstActiveVault(deps.database, context.userId);
    if (vaultId === null) {
      return sendError(reply, 403, 'FORBIDDEN');
    }

    const after = parseBootstrapCursor(query.data.cursor);
    if (after === null) {
      return sendError(reply, 400, 'INVALID_REQUEST');
    }
    const events =
      deps.revisions?.listEvents(vaultId, after, DEFAULT_BOOTSTRAP_PAGE_ITEMS) ??
      [];
    const items = events.map((event) => ({
      contentHash: event.receipt.blobHash,
      fileId: event.fileId,
      revisionId: event.revisionId,
      serverSequence: event.serverSequence,
    }));
    const complete = items.length < DEFAULT_BOOTSTRAP_PAGE_ITEMS;
    const lastSequence = events.at(-1)?.serverSequence ?? after;

    reply.header('cache-control', 'no-store');
    return {
      complete,
      items,
      nextCursor: complete ? null : String(lastSequence),
      version: 1,
    };
  });
}

function parseBootstrapCursor(value: string | undefined): number | null {
  if (value === undefined) {
    return 0;
  }
  if (!/^\d+$/u.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Registers the owner-authenticated invitation lifecycle routes. The caller
 * must register these inside the deny-by-default protected scope so every
 * request already carries an authenticated `authSession`.
 */
export function registerOwnerInvitationRoutes(
  instance: FastifyInstance,
  deps: OnboardingRoutesDeps,
): void {
  instance.post('/vaults/:vaultId/invitations', async (request, reply) => {
    const params = vaultParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 400, 'INVALID_REQUEST');
    }
    const session = requireAuth(request, reply);
    if (session === null) {
      return reply;
    }
    const membership = loadActiveMembership(
      deps.database,
      session.userId,
      params.data.vaultId,
    );
    if (membership === null || membership.role !== 'owner') {
      return sendError(reply, 403, 'FORBIDDEN');
    }
    const body = invitationCreateBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return sendError(reply, 400, 'INVALID_REQUEST');
    }
    try {
      const created = deps.invitations.createInvitation({
        createdByMembershipId: membership.membershipId,
        inviterDeviceId: session.deviceId,
        vaultId: params.data.vaultId,
        ...(body.data.intendedRole === undefined
          ? {}
          : { intendedRole: body.data.intendedRole as InvitationRole }),
        ...(body.data.intendedMemberDisplayName === undefined
          ? {}
          : { intendedMemberDisplayName: body.data.intendedMemberDisplayName }),
      });
      reply.header('cache-control', 'no-store');
      return {
        expiresAt: created.expiresAt,
        intendedMemberDisplayName: created.intendedMemberDisplayName,
        intendedMemberId: created.intendedMemberId,
        invitationId: created.invitationId,
        invitationToken: created.invitationToken,
      };
    } catch (error) {
      return sendInvitationError(reply, error);
    }
  });

  instance.post(
    '/vaults/:vaultId/invitations/:invitationId/approve',
    async (request, reply) => {
      const params = invitationVaultParamsSchema.safeParse(request.params);
      if (!params.success) {
        return sendError(reply, 400, 'INVALID_REQUEST');
      }
      const membership = requireOwner(request, reply, deps, params.data.vaultId);
      if (membership === null) {
        return reply;
      }
      const body = approveBodySchema.safeParse(request.body);
      if (!body.success) {
        return sendError(reply, 400, 'INVALID_REQUEST');
      }
      try {
        const result = deps.invitations.approveRedeemedDevice({
          approverMembershipId: membership.membershipId,
          invitationId: params.data.invitationId,
          verificationPhrase: body.data.verificationPhrase,
        });
        reply.header('cache-control', 'no-store');
        return {
          deviceId: result.deviceId,
          membershipId: result.membershipId,
          status: 'approved',
          userId: result.userId,
        };
      } catch (error) {
        return sendInvitationError(reply, error);
      }
    },
  );

  instance.post(
    '/vaults/:vaultId/invitations/:invitationId/reject',
    async (request, reply) => {
      const params = invitationVaultParamsSchema.safeParse(request.params);
      if (!params.success) {
        return sendError(reply, 400, 'INVALID_REQUEST');
      }
      const membership = requireOwner(request, reply, deps, params.data.vaultId);
      if (membership === null) {
        return reply;
      }
      try {
        deps.invitations.rejectPendingDevice({
          approverMembershipId: membership.membershipId,
          invitationId: params.data.invitationId,
        });
        reply.header('cache-control', 'no-store');
        return { status: 'rejected' };
      } catch (error) {
        return sendInvitationError(reply, error);
      }
    },
  );
}

function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): AccessSession | null {
  const session = request.authSession;
  if (session === undefined) {
    sendError(reply, 401, 'UNAUTHENTICATED');
    return null;
  }
  return session;
}

function requireOwner(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: OnboardingRoutesDeps,
  vaultId: string,
): MembershipRow | null {
  const session = requireAuth(request, reply);
  if (session === null) {
    return null;
  }
  const membership = loadActiveMembership(deps.database, session.userId, vaultId);
  if (membership === null || membership.role !== 'owner') {
    sendError(reply, 403, 'FORBIDDEN');
    return null;
  }
  return membership;
}
