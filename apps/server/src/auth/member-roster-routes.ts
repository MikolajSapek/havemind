/**
 * GET /members, the vault roster served from the server.
 *
 * The roster was assembled client-side from what each device happened to
 * witness: the owner recorded a member at the moment it approved that member's
 * device, a guest recorded only itself. Two people in one vault therefore saw
 * different rosters, and a guest saw a list of one. A second owner did not see
 * the members the first owner had approved either, because presence was never
 * about role, only about who was in the room at approval time.
 *
 * The server already holds the truth: `memberships` joined to `users`. This
 * route hands it back to any active member of the vault, which is the same
 * access rule `/bootstrap` applies. It is read-only and carries no endpoint,
 * token or device detail, only who is in the vault and in what role.
 */

import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import type { SessionRepository } from './session-repository.js';

const REFRESH_TOKEN_HEADER = 'x-havemind-refresh-token';

const querySchema = z.object({
  vault: z.string().uuid().optional(),
});

export interface MemberRosterRoutesDeps {
  readonly database: Database.Database;
  readonly sessions: SessionRepository;
}

interface RosterRow {
  readonly membershipId: string;
  readonly displayName: string;
  readonly role: 'owner' | 'editor';
}

type RosterErrorCode = 'FORBIDDEN' | 'INVALID_REQUEST' | 'UNAUTHENTICATED';

function sendError(
  reply: FastifyReply,
  status: number,
  code: RosterErrorCode,
): FastifyReply {
  return reply.status(status).send({ error: { code } });
}

function singleHeader(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value;
  // A repeated header is ambiguous about which token the caller meant, so it
  // is rejected rather than resolved by picking one.
  return null;
}

/** The vault the caller may read, honouring an explicit `?vault=` when given. */
function resolveVault(
  database: Database.Database,
  userId: string,
  requested: string | undefined,
): string | null {
  if (requested === undefined) {
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
  // The query string is caller-controlled, so membership is verified before the
  // vault is served: it selects among the caller's own vaults, never widens.
  const membership = database
    .prepare(
      `SELECT id FROM memberships
       WHERE user_id = ? AND vault_id = ? AND status = 'active'`,
    )
    .get(userId, requested) as { id: string } | undefined;
  return membership === undefined ? null : requested;
}

export function registerMemberRosterRoutes(
  instance: FastifyInstance,
  deps: MemberRosterRoutesDeps,
): void {
  instance.get('/members', async (request, reply) => {
    const query = querySchema.safeParse(request.query);
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

    const vaultId = resolveVault(deps.database, context.userId, query.data.vault);
    if (vaultId === null) {
      return sendError(reply, 403, 'FORBIDDEN');
    }

    // Owner first, then by join time: the order every member sees is the same,
    // so two devices never disagree about the roster's shape.
    const members = deps.database
      .prepare(
        `SELECT memberships.id AS membershipId,
                users.display_name AS displayName,
                memberships.role AS role
         FROM memberships
         JOIN users ON users.id = memberships.user_id
         WHERE memberships.vault_id = ?
           AND memberships.status = 'active'
           AND users.status = 'active'
         ORDER BY CASE memberships.role WHEN 'owner' THEN 0 ELSE 1 END,
                  memberships.created_at,
                  memberships.id`,
      )
      .all(vaultId) as RosterRow[];

    reply.header('cache-control', 'no-store');
    return { members, version: 1 };
  });
}
