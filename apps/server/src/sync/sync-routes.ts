import {
  hashBlob,
  protectedRevisionHeaderSchema,
  type ProtectedRevisionHeader,
} from '@havemind/protocol';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { BlobStore } from '../blob-store.js';
import { readInstanceEpoch } from '../backup-restore.js';
import { DEFAULT_VAULT_QUOTA_BYTES } from '../config.js';
import {
  computeVaultStorageBytes,
  readVaultQuotaBytes,
  resolveEffectiveQuotaBytes,
  vaultContainsBlob,
} from '../quota.js';
import {
  RevisionRepositoryError,
  type RevisionRepository,
  type RevisionRepositoryErrorCode,
} from '../revision-repository.js';
import type { AccessSession } from '../auth/session-repository.js';
import { BlobByteRateLimiter, HeldWaitLimiter } from './device-throttles.js';
import type { VaultWakeRegistry } from './vault-wake-registry.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;

const DEFAULT_MAX_BATCH_SIZE = 64;
// F9 binary attachments raise this from 512 KiB to 36 MiB: a 25 MB raw file
// inflates to ~33.4 MB as base64 inside the revision payload, so 36 MiB covers
// the inflation plus JSON envelope overhead. The server still never inspects
// payload contents (see revisionInputSchema above), only the byte ceiling
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
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'REVISION_ID_REUSE'
  | 'STORAGE_UNAVAILABLE'
  | 'UNAUTHENTICATED';

export interface SyncRoutesDeps {
  readonly revisions: RevisionRepository;
  readonly blobStore: Pick<BlobStore, 'put' | 'read'>;
  readonly database: Database.Database;
  readonly maxBatchSize?: number;
  readonly maxPayloadBytes?: number;
  /**
   * Server-wide default per-vault quota, used by the optimistic pre-check for a
   * vault whose `quota_bytes` is NULL. Must match the value the repository uses.
   */
  readonly vaultQuotaBytes?: number;
  /**
   * O(1) free-bytes probe on the data-root filesystem (statfs-style), injected
   * so the disk-pressure guard is testable without filling a disk. When omitted
   * the guard is inactive (used by unit fixtures that do not exercise it).
   */
  readonly freeDiskBytes?: () => Promise<number> | number;
  /** Reject writes when free disk falls below this many bytes (S6). */
  readonly minFreeDiskBytes?: number;
  /**
   * Optional in-memory wake registry backing real-time push. When present, the
   * push route notifies it once per batch that commits at least one revision,
   * and `GET /wait` holds requests against it. When omitted, `/wait` degrades to
   * an immediate heartbeat (returns the current cursor without holding), so the
   * client's poll fallback still drives sync.
   */
  readonly wakeRegistry?: VaultWakeRegistry;
  /**
   * How long `GET /wait` holds a request before returning a cursor-unchanged
   * heartbeat, in milliseconds. MUST stay strictly below the Fastify
   * `requestTimeout` (30_000 in app.ts) so the server, never a proxy, always
   * ends the request cleanly. Injected for tests; defaults to 25_000.
   */
  readonly waitTimeoutMs?: number;
  /**
   * Injectable clock for the blob byte-rate token bucket, following the
   * `now?: () => Date` idiom used elsewhere so the refill is deterministic in
   * tests. Defaults to `() => new Date()`.
   */
  readonly now?: () => Date;
  /**
   * Max concurrently-held `/wait` long-polls per device (AUD-08b). A device
   * needs only ~1 held wait at a time; the default comfortably exceeds normal
   * use while bounding a member holding many connections at once.
   */
  readonly maxHeldWaitsPerDevice?: number;
  /** Process-wide ceiling on concurrently-held `/wait` long-polls (AUD-08b). */
  readonly maxHeldWaitsGlobal?: number;
  /**
   * Per-device blob-egress token bucket (AUD-08b). `blobBurstBytes` is the
   * full starting budget (must comfortably cover an initial vault
   * materialisation so normal sync never throttles); `blobRefillBytesPerSecond`
   * is the sustained refill.
   */
  readonly blobBurstBytes?: number;
  readonly blobRefillBytesPerSecond?: number;
}

const DEFAULT_WAIT_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_HELD_WAITS_PER_DEVICE = 4;
const DEFAULT_MAX_HELD_WAITS_GLOBAL = 256;
// Burst equals the default per-vault quota so a full initial materialisation of
// a max-size vault is served in one burst without ever tripping the throttle;
// the refill then bounds sustained egress well above any legitimate sync rate.
const DEFAULT_BLOB_BURST_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_BLOB_REFILL_BYTES_PER_SECOND = 64 * 1024 * 1024;

const waitQuerySchema = z
  .object({
    cursor: z.coerce.number().int().nonnegative().safe().optional(),
  })
  .strict();

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
  QUOTA_EXCEEDED: 413,
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
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
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

/**
 * True when the blob is referenced by a revision in a LIVE vault.
 *
 * AUD2-08: the join onto `vaults` carries the soft-delete filter. Push and pull
 * already fail closed on a deleted vault (`revision-repository.ts` `#getVault`
 * and `getCursor` both filter `deleted_at IS NULL`), but the blob route
 * authorises on session + membership alone, so without this a session minted
 * before the delete could still read bytes out of the vault. Folded into the
 * existing lookup rather than added as a second query: the caller already maps
 * a false result to 404, which is the right answer for a deleted vault too, and
 * keeps a deleted vault indistinguishable from a missing blob.
 */
function blobBelongsToVault(
  database: Database.Database,
  vaultId: string,
  blobHash: string,
): boolean {
  const row = database
    .prepare(
      `SELECT 1 AS present
       FROM revisions
       JOIN vaults ON vaults.id = revisions.vault_id
       WHERE revisions.vault_id = ?
         AND revisions.blob_hash = ?
         AND vaults.deleted_at IS NULL
       LIMIT 1`,
    )
    .get(vaultId, blobHash) as { present: number } | undefined;
  return row !== undefined;
}

/**
 * Optimistic per-vault quota pre-check over the ordered batch. Computes each
 * revision's content-addressed hash and charges its `blob_size` once per new
 * DISTINCT blob (already-stored blobs and repeats within the batch cost
 * nothing), returning `true` as soon as the running total would exceed the
 * vault's effective quota. Runs before any `blobStore.put`, so a payload that
 * plainly will not fit never reaches disk. This is advisory only, the
 * authoritative check is inside the commit transaction.
 */
async function precheckVaultQuota(
  database: Database.Database,
  vaultId: string,
  ordered: readonly ParsedRevisionInput[],
  defaultQuotaBytes: number,
): Promise<boolean> {
  const quota = resolveEffectiveQuotaBytes(
    readVaultQuotaBytes(database, vaultId),
    defaultQuotaBytes,
  );
  let projected = computeVaultStorageBytes(database, vaultId);
  const chargedInBatch = new Set<string>();
  for (const revision of ordered) {
    const hash = await hashBlob(revision.payload);
    if (chargedInBatch.has(hash) || vaultContainsBlob(database, vaultId, hash)) {
      continue;
    }
    projected += revision.payload.byteLength;
    if (projected > quota) {
      return true;
    }
    chargedInBatch.add(hash);
  }
  return false;
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
  const now = deps.now ?? ((): Date => new Date());

  // AUD-08b: the two rate-limiter-exempt reads (/wait, blob GET) get their own
  // bounded per-device throttles, constructed once so their in-memory state
  // persists across every request in this scope.
  const heldWaits = new HeldWaitLimiter(
    deps.maxHeldWaitsPerDevice ?? DEFAULT_MAX_HELD_WAITS_PER_DEVICE,
    deps.maxHeldWaitsGlobal ?? DEFAULT_MAX_HELD_WAITS_GLOBAL,
  );
  const blobByteRate = new BlobByteRateLimiter(
    deps.blobBurstBytes ?? DEFAULT_BLOB_BURST_BYTES,
    (deps.blobRefillBytesPerSecond ?? DEFAULT_BLOB_REFILL_BYTES_PER_SECOND) /
      1000,
    now,
  );

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

    // S6 free-disk guard: an O(1) statfs-style probe evaluated once per push,
    // before any blob is written. Below the threshold, or if the probe itself
    // fails, the whole push is rejected fail-closed with 507. Reads are never
    // gated (this hook lives only on the push route). This is the last line of
    // defence against filling the shared data-root, independent of quota.
    if (deps.freeDiskBytes !== undefined) {
      const minFreeDiskBytes = deps.minFreeDiskBytes ?? 0;
      let freeBytes: number;
      try {
        freeBytes = await deps.freeDiskBytes();
      } catch {
        return sendSyncError(reply, 507, 'STORAGE_UNAVAILABLE');
      }
      if (!Number.isFinite(freeBytes) || freeBytes < minFreeDiskBytes) {
        return sendSyncError(reply, 507, 'STORAGE_UNAVAILABLE');
      }
    }

    // S3 pre-check (optimistic, outside the commit transaction): reject a push
    // whose new blobs cannot fit the vault quota BEFORE any payload is written to
    // disk, closing the "orphaned oversized blob" DoS vector (T1/C). The
    // authoritative, TOCTOU-safe check still runs inside `commitRevision`'s
    // transaction; this pass only avoids the disk write for pushes that plainly
    // will not fit. Accounting uses only blob_hash/blob_size (opaque boundary).
    const quotaRejection = await precheckVaultQuota(
      deps.database,
      params.data.vaultId,
      ordered,
      deps.vaultQuotaBytes ?? DEFAULT_VAULT_QUOTA_BYTES,
    );
    if (quotaRejection) {
      return sendSyncError(reply, 413, 'QUOTA_EXCEEDED');
    }

    // Per-revision results: a domain failure on one revision rejects only that
    // revision (with its machine code) and never aborts the batch, so the client
    // records the accepted prefix and isolates the single failure instead of
    // re-sending the whole batch forever (append-only liveness). Request-level
    // faults (bad body, unknown vault, identity mismatch, cyclic/oversized batch)
    // are still whole-request 4xx above, only per-revision commit outcomes are
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
      try {
        const actor = {
          deviceId: session.deviceId,
          memberId: membership.membershipId,
        };
        // Validate-before-write (audit fix #7): run the authoritative reject
        // checks (MISSING_PARENT, bad graph, over-quota, id/idempotency reuse)
        // read-only, using the in-memory payload's own hash and byte length,
        // BEFORE any bytes touch the content-addressed store. A rejected commit
        // therefore never persists a blob, so a member replaying large payloads
        // with a nonexistent parent can no longer grow the shared data-root
        // without bound. Only when the request is deemed committable do we
        // persist the blob and run the authoritative, TOCTOU-safe commit.
        const blobHash = await hashBlob(revision.payload);
        await deps.revisions.assertCommittable({
          actor,
          blobHash,
          blobSize: revision.payload.byteLength,
          header: revision.header,
          idempotencyKey: revision.idempotencyKey,
        });
        const stored = await deps.blobStore.put(revision.payload);
        const result = await deps.revisions.commitRevision({
          actor,
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
        if (
          error instanceof RevisionRepositoryError &&
          error.code === 'QUOTA_EXCEEDED'
        ) {
          // Quota is a whole-request rejection, not a per-revision skip: the
          // authoritative in-transaction check tripped (e.g. a concurrent push
          // charged the last free bytes between the pre-check and this commit).
          // Fail closed with 413 so the client stops rather than dead-lettering.
          //
          // Revisions before this one may have already committed and advanced
          // the durable cursor. That accepted prefix must still wake any held
          // /wait peers now, or they'd only converge on the heartbeat instead
          // of near-real-time, the early return below would otherwise bypass
          // the notify block further down entirely. Best-effort, exactly like
          // the notify at the end of a fully-processed batch.
          if (
            deps.wakeRegistry !== undefined &&
            results.some((result) => result.status === 'accepted')
          ) {
            try {
              deps.wakeRegistry.notify(
                params.data.vaultId,
                deps.revisions.getCursor(params.data.vaultId),
              );
            } catch {
              // Wake is advisory; the poll fallback still converges the client.
            }
          }
          return sendCommitError(reply, error);
        }
        if (error instanceof RevisionRepositoryError) {
          // With validate-before-write above, a domain rejection is normally
          // raised by `assertCommittable` BEFORE any blob is written, so the
          // common case leaves nothing on disk. A blob can only linger if this
          // authoritative commit rejects AFTER the read-only pre-check passed
          // (a rare concurrent interleave, not attacker-forceable at will). We
          // must NOT delete it here: it is content-addressed and a concurrent
          // request for the same bytes may already reference it, so deleting
          // would race. Any such residual orphan is bounded by quota and
          // reclaimed by the startup sweep (`sweepOrphanedBlobs` in blob-gc.ts),
          // which only runs when no push can be concurrently committing.
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

    // Real-time push wake: if this batch durably committed at least one new
    // revision (pure replays and all-rejected batches advance nothing), wake
    // any held /wait requests for this vault EXACTLY ONCE with the final
    // cursor. Wake is strictly best-effort, a failure here must never turn a
    // successful commit into an error, so it is isolated in try/catch.
    if (
      deps.wakeRegistry !== undefined &&
      results.some((result) => result.status === 'accepted')
    ) {
      try {
        deps.wakeRegistry.notify(
          params.data.vaultId,
          deps.revisions.getCursor(params.data.vaultId),
        );
      } catch {
        // Wake is advisory; the poll fallback still converges the client.
      }
    }

    reply.header('cache-control', 'no-store');
    return { results };
  });

  instance.get('/vaults/:vaultId/wait', async (request, reply) => {
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

    const query = waitQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendSyncError(reply, 400, 'INVALID_REQUEST');
    }
    const clientCursor = query.data.cursor ?? 0;

    let current: number;
    try {
      current = deps.revisions.getCursor(params.data.vaultId);
    } catch (error) {
      return sendCommitError(reply, error);
    }

    // Fast path: the server already has newer revisions than the client holds,
    // or no registry is wired, return the current cursor without holding.
    const wakeRegistry = deps.wakeRegistry;
    if (current > clientCursor || wakeRegistry === undefined) {
      reply.header('cache-control', 'no-store');
      return { cursor: current };
    }

    // AUD-08b: cap concurrently-held long-polls per device (and globally)
    // BEFORE opening another 25 s connection. A device needs only ~1 held wait
    // at a time; refusing the excess with 429 stops a member from pinning many
    // held connections at once. The slot is released in `teardown` below, which
    // runs exactly once on resolve/timeout/abort.
    if (!heldWaits.tryAcquire(session.deviceId)) {
      return sendSyncError(reply, 429, 'RATE_LIMITED');
    }

    const waitTimeoutMs = deps.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;

    return await new Promise<{ cursor: number }>((resolve) => {
      let settled = false;

      const teardown = (): void => {
        clearTimeout(timer);
        unsubscribe();
        heldWaits.release(session.deviceId);
        request.raw.removeListener('close', onClientGone);
        request.raw.removeListener('aborted', onClientGone);
      };

      const finish = (cursor: number): void => {
        if (settled) {
          return;
        }
        settled = true;
        teardown();
        reply.header('cache-control', 'no-store');
        resolve({ cursor });
      };

      function onClientGone(): void {
        if (settled) {
          return;
        }
        settled = true;
        teardown();
        // The client is gone: take over the reply so Fastify does not try to
        // serialise a body onto a dead socket, then settle the handler promise
        // so it cannot leak.
        reply.hijack();
        resolve({ cursor: current });
      }

      const unsubscribe = wakeRegistry.subscribe(params.data.vaultId, (cursor) => {
        finish(cursor);
      });
      const timer = setTimeout(() => {
        finish(current);
      }, waitTimeoutMs);
      request.raw.on('close', onClientGone);
      request.raw.on('aborted', onClientGone);
    });
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

    // AUD-08b: charge the blob's byte length against this device's egress
    // token bucket. Over budget -> 429, so a member cannot stream unbounded
    // bytes through the rate-limiter-exempt blob route. The bucket starts full
    // and refills, so a normal catch-up drain (many blobs) is never throttled.
    if (!blobByteRate.tryConsume(session.deviceId, bytes.byteLength)) {
      return sendSyncError(reply, 429, 'RATE_LIMITED');
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
