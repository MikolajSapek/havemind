import {
  protectedRevisionHeaderSchema,
  type ProtectedRevisionHeader,
} from '@havemind/protocol';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { BlobStore } from '../blob-store.js';
import { readInstanceEpoch } from '../backup-restore.js';
import {
  RevisionRepositoryError,
  type RevisionRepository,
  type RevisionRepositoryErrorCode,
} from '../revision-repository.js';
import type { AccessSession } from '../auth/session-repository.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;

const DEFAULT_MAX_BATCH_SIZE = 64;
// F9 binary attachments raise this from 512 KiB to 36 MiB: a 25 MB raw file
// inflates to ~33.4 MB as base64 inside the revision payload, so 36 MiB covers
// the inflation plus JSON envelope overhead. The server still never inspects
// payload contents (see revisionInputSchema above) — only the byte ceiling
// changes.
export const DEFAULT_MAX_PAYLOAD_BYTES = 36 * 1024 * 1024;
const DEFAULT_PULL_LIMIT = 100;
const MAX_PULL_LIMIT = 1_000;

/**
 * Stable, secret-free machine error codes for the sync surface. Human text is
 * never returned to the client; only these codes cross the boundary.
 */
export type SyncErrorCode =
  | 'CONFLICT'
  | 'CURSOR_INVALID'
  | 'FORBIDDEN'
  | 'HEAD_SET_CHANGED'
  | 'INTERNAL'
  | 'INVALID_BATCH'
  | 'INVALID_REQUEST'
  | 'MISSING_PARENT'
  | 'NOT_FOUND'
  | 'REVISION_ID_REUSE'
  | 'UNAUTHENTICATED';

export interface SyncRoutesDeps {
  readonly revisions: RevisionRepository;
  readonly blobStore: Pick<BlobStore, 'put' | 'read'>;
  readonly database: Database.Database;
  readonly maxBatchSize?: number;
  readonly maxPayloadBytes?: number;
}

interface MembershipRow {
  readonly membershipId: string;
  readonly role: string;
}

/**
 * The opaque server never inspects payload contents. It accepts arbitrary
 * bytes (base64 on the wire), computes only the content-addressed digest and
 * stores them; diff/provenance/merge are exclusively the client's job.
 */
const revisionInputSchema = z
  .object({
    header: z.unknown(),
    idempotencyKey: z.string().min(1).max(200),
    payload: z.string().regex(BASE64_PATTERN),
  })
  .strict();

const pushBodySchema = z
  .object({
    revisions: z.array(revisionInputSchema).min(1),
  })
  .strict();

const vaultParamsSchema = z.object({
  vaultId: z.string().regex(UUID_PATTERN),
});

const blobParamsSchema = z.object({
  blobHash: z.string().regex(SHA256_HEX_PATTERN),
  vaultId: z.string().regex(UUID_PATTERN),
});

const pullQuerySchema = z
  .object({
    after: z.coerce.number().int().nonnegative().safe().optional(),
    epoch: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().positive().max(MAX_PULL_LIMIT).optional(),
  })
  .strict();

const HTTP_STATUS_BY_REPOSITORY_CODE: Readonly<
  Record<RevisionRepositoryErrorCode, number>
> = {
  CORRUPT_BLOB: 500,
  FILE_ALREADY_EXISTS: 409,
  FORBIDDEN: 403,
  HEAD_SET_CHANGED: 409,
  IDEMPOTENCY_KEY_REUSE: 409,
  INVALID_REQUEST: 400,
  MISSING_BLOB: 500,
  MISSING_PARENT: 422,
  NOT_FOUND: 404,
  PARENT_FILE_MISMATCH: 422,
  REPOSITORY_INTEGRITY: 500,
  REVISION_ID_REUSE: 409,
};

const SYNC_CODE_BY_REPOSITORY_CODE: Readonly<
  Record<RevisionRepositoryErrorCode, SyncErrorCode>
> = {
  CORRUPT_BLOB: 'INTERNAL',
  FILE_ALREADY_EXISTS: 'CONFLICT',
  FORBIDDEN: 'FORBIDDEN',
  HEAD_SET_CHANGED: 'HEAD_SET_CHANGED',
  IDEMPOTENCY_KEY_REUSE: 'CONFLICT',
  INVALID_REQUEST: 'INVALID_REQUEST',
  MISSING_BLOB: 'INTERNAL',
  MISSING_PARENT: 'MISSING_PARENT',
  NOT_FOUND: 'NOT_FOUND',
  PARENT_FILE_MISMATCH: 'INVALID_REQUEST',
  REPOSITORY_INTEGRITY: 'INTERNAL',
  REVISION_ID_REUSE: 'REVISION_ID_REUSE',
};

interface ParsedRevisionInput {
  readonly header: ProtectedRevisionHeader;
  readonly idempotencyKey: string;
  readonly payload: Buffer;
}

function sendSyncError(
  reply: FastifyReply,
  status: number,
  code: SyncErrorCode,
): FastifyReply {
  reply.header('cache-control', 'no-store');
  reply.code(status).send({ error: { code } });
  return reply;
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

function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
): AccessSession | null {
  const session = request.authSession;
  if (session === undefined) {
    sendSyncError(reply, 401, 'UNAUTHENTICATED');
    return null;
  }
  return session;
}

/**
 * Detects any batch-internal cycle and returns a parents-before-children
 * ordering. Only edges whose parent is also present in the batch matter;
 * already-committed parents are immutable and cannot close a cycle.
 */
function orderBatch(
  revisions: readonly ParsedRevisionInput[],
): readonly ParsedRevisionInput[] | null {
  const byId = new Map<string, ParsedRevisionInput>();
  for (const revision of revisions) {
    if (byId.has(revision.header.revisionId)) {
      // A revision ID appearing twice in one batch is never valid.
      return null;
    }
    byId.set(revision.header.revisionId, revision);
  }

  const inDegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const id of byId.keys()) {
    inDegree.set(id, 0);
    children.set(id, []);
  }

  for (const revision of revisions) {
    const childId = revision.header.revisionId;
    for (const parentId of revision.header.parentRevisionIds) {
      if (!byId.has(parentId)) {
        continue;
      }
      children.get(parentId)?.push(childId);
      inDegree.set(childId, (inDegree.get(childId) ?? 0) + 1);
    }
  }

  const ready: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      ready.push(id);
    }
  }

  const ordered: ParsedRevisionInput[] = [];
  while (ready.length > 0) {
    const id = ready.shift() as string;
    const revision = byId.get(id);
    if (revision !== undefined) {
      ordered.push(revision);
    }
    for (const childId of children.get(id) ?? []) {
      const next = (inDegree.get(childId) ?? 0) - 1;
      inDegree.set(childId, next);
      if (next === 0) {
        ready.push(childId);
      }
    }
  }

  return ordered.length === revisions.length ? ordered : null;
}

function parseBatch(
  rawRevisions: readonly z.infer<typeof revisionInputSchema>[],
  maxPayloadBytes: number,
): ParsedRevisionInput[] | null {
  const parsed: ParsedRevisionInput[] = [];
  for (const raw of rawRevisions) {
    const header = protectedRevisionHeaderSchema.safeParse(raw.header);
    if (!header.success) {
      return null;
    }
    const payload = Buffer.from(raw.payload, 'base64');
    if (payload.byteLength > maxPayloadBytes) {
      return null;
    }
    parsed.push({
      header: header.data,
      idempotencyKey: raw.idempotencyKey,
      payload,
    });
  }
  return parsed;
}

function blobBelongsToVault(
  database: Database.Database,
  vaultId: string,
  blobHash: string,
): boolean {
  const row = database
    .prepare(
      `SELECT 1 AS present
       FROM revisions
       WHERE vault_id = ? AND blob_hash = ?
       LIMIT 1`,
    )
    .get(vaultId, blobHash) as { present: number } | undefined;
  return row !== undefined;
}

/**
 * Registers the batched push, cursor-based pull and byte-exact blob retrieval
 * routes. The caller must register this inside the deny-by-default protected
 * scope from `auth-routes`, so every request already carries an authenticated
 * `authSession`.
 */
export function registerSyncRoutes(
  instance: FastifyInstance,
  deps: SyncRoutesDeps,
): void {
  const maxBatchSize = deps.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
  const maxPayloadBytes = deps.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;

  instance.post('/vaults/:vaultId/revisions', async (request, reply) => {
    const params = vaultParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendSyncError(reply, 400, 'INVALID_REQUEST');
    }
    const session = requireSession(request, reply);
    if (session === null) {
      return reply;
    }

    const membership = loadActiveMembership(
      deps.database,
      session.userId,
      params.data.vaultId,
    );
    if (membership === null) {
      return sendSyncError(reply, 403, 'FORBIDDEN');
    }

    const body = pushBodySchema.safeParse(request.body);
    if (!body.success || body.data.revisions.length > maxBatchSize) {
      return sendSyncError(reply, 400, 'INVALID_REQUEST');
    }

    const parsed = parseBatch(body.data.revisions, maxPayloadBytes);
    if (parsed === null) {
      return sendSyncError(reply, 422, 'INVALID_BATCH');
    }

    for (const revision of parsed) {
      if (
        revision.header.vaultId !== params.data.vaultId ||
        revision.header.expectedMemberId !== membership.membershipId ||
        revision.header.expectedDeviceId !== session.deviceId
      ) {
        return sendSyncError(reply, 403, 'FORBIDDEN');
      }
    }

    const ordered = orderBatch(parsed);
    if (ordered === null) {
      return sendSyncError(reply, 422, 'INVALID_BATCH');
    }

    // Per-revision results: a domain failure on one revision rejects only that
    // revision (with its machine code) and never aborts the batch, so the client
    // records the accepted prefix and isolates the single failure instead of
    // re-sending the whole batch forever (append-only liveness). Request-level
    // faults (bad body, unknown vault, identity mismatch, cyclic/oversized batch)
    // are still whole-request 4xx above — only per-revision commit outcomes are
    // reported here.
    const results: Array<
      | {
          readonly receipt: unknown;
          readonly revisionId: string;
          readonly status: string;
        }
      | {
          readonly code: SyncErrorCode;
          readonly revisionId: string;
          readonly status: 'rejected';
        }
    > = [];
    for (const revision of ordered) {
      const stored = await deps.blobStore.put(revision.payload);
      try {
        const result = await deps.revisions.commitRevision({
          actor: {
            deviceId: session.deviceId,
            memberId: membership.membershipId,
          },
          blobHash: stored.hash,
          header: revision.header,
          idempotencyKey: revision.idempotencyKey,
        });
        results.push({
          receipt: result.receipt,
          revisionId: revision.header.revisionId,
          status: result.status,
        });
      } catch (error) {
        if (error instanceof RevisionRepositoryError) {
          // The blob bytes for this rejected revision are left on disk. They
          // are content-addressed and may still be referenced by another
          // concurrently-committing request for the same bytes, so deleting
          // here would race; any truly orphaned blob is instead reclaimed by
          // the startup sweep (`sweepOrphanedBlobs` in blob-gc.ts), which only
          // runs when no push can be concurrently committing.
          results.push({
            code: SYNC_CODE_BY_REPOSITORY_CODE[error.code],
            revisionId: revision.header.revisionId,
            status: 'rejected',
          });
          continue;
        }
        // An unexpected (non-domain) error is a real server fault: fail the whole
        // request so the client retries rather than dead-letters.
        return sendCommitError(reply, error);
      }
    }

    reply.header('cache-control', 'no-store');
    return { results };
  });

  instance.get('/vaults/:vaultId/events', async (request, reply) => {
    const params = vaultParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendSyncError(reply, 400, 'INVALID_REQUEST');
    }
    const session = requireSession(request, reply);
    if (session === null) {
      return reply;
    }
    const membership = loadActiveMembership(
      deps.database,
      session.userId,
      params.data.vaultId,
    );
    if (membership === null) {
      return sendSyncError(reply, 403, 'FORBIDDEN');
    }

    const query = pullQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendSyncError(reply, 400, 'INVALID_REQUEST');
    }
    const after = query.data.after ?? 0;
    const limit = query.data.limit ?? DEFAULT_PULL_LIMIT;

    // Cursors are qualified by the server epoch. After a restore the epoch is
    // rotated, so a client presenting a cursor stamped with the previous epoch
    // is forced to reconcile heads before it can mutate again.
    const epoch = readInstanceEpoch(deps.database);
    if (
      epoch !== null &&
      query.data.epoch !== undefined &&
      query.data.epoch !== epoch.serverEpoch
    ) {
      return sendSyncError(reply, 409, 'CURSOR_INVALID');
    }

    try {
      // A cursor strictly beyond the highest committed sequence is a cursor
      // "from the future": it can only exist because the client's held cursor
      // outran this vault's max sequence, e.g. after restoreInstance rotated
      // server_epoch back to an older backup whose next_server_sequence is
      // lower. The epoch guard above catches this only when the client sends
      // the epoch param; fail closed here too so a client that pulls WITHOUT
      // the epoch can never silently skip re-issued sequences.
      const cursor = deps.revisions.getCursor(params.data.vaultId);
      if (after > cursor) {
        return sendSyncError(reply, 409, 'CURSOR_INVALID');
      }
      const events = deps.revisions.listEvents(
        params.data.vaultId,
        after,
        limit,
      );
      reply.header('cache-control', 'no-store');
      return {
        cursor,
        ...(epoch === null ? {} : { epoch: epoch.serverEpoch }),
        events,
      };
    } catch (error) {
      return sendCommitError(reply, error);
    }
  });

  instance.get('/vaults/:vaultId/blobs/:blobHash', async (request, reply) => {
    const params = blobParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendSyncError(reply, 400, 'INVALID_REQUEST');
    }
    const session = requireSession(request, reply);
    if (session === null) {
      return reply;
    }
    const membership = loadActiveMembership(
      deps.database,
      session.userId,
      params.data.vaultId,
    );
    if (membership === null) {
      return sendSyncError(reply, 403, 'FORBIDDEN');
    }

    // A blob that no revision in this vault references is indistinguishable
    // from a missing blob, so cross-vault probing learns nothing.
    if (!blobBelongsToVault(deps.database, params.data.vaultId, params.data.blobHash)) {
      return sendSyncError(reply, 404, 'NOT_FOUND');
    }

    let bytes: Buffer;
    try {
      bytes = await deps.blobStore.read(params.data.blobHash as never);
    } catch {
      return sendSyncError(reply, 404, 'NOT_FOUND');
    }

    reply.header('cache-control', 'no-store');
    reply.header('content-type', 'application/octet-stream');
    reply.send(bytes);
    return reply;
  });
}

function sendCommitError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof RevisionRepositoryError) {
    const status = HTTP_STATUS_BY_REPOSITORY_CODE[error.code];
    const code = SYNC_CODE_BY_REPOSITORY_CODE[error.code];
    return sendSyncError(reply, status, code);
  }
  return sendSyncError(reply, 500, 'INTERNAL');
}
