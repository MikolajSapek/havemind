import type Database from 'better-sqlite3';

import type { BlobStore } from './blob-store.js';

export interface BlobSweepResult {
  readonly removed: number;
  readonly scanned: number;
}

interface BlobHashRow {
  readonly blobHash: string;
}

/**
 * Removes blob-store bytes that no committed revision, in any vault,
 * references. The blob store is content-addressed and shared globally
 * (see `blobBelongsToVault`/`blobIsReferenced` callers elsewhere), so
 * "orphaned" is a global property, not a per-vault one.
 *
 * This MUST only run when no push request can be concurrently committing a
 * revision — i.e. at server startup, before the app begins accepting
 * connections. Deleting from the request hot path is unsafe: `blobStore.put`
 * for one request and `commitRevision` for a *different* concurrent request
 * can interleave around an await, so a liveness check taken mid-request can
 * go stale before the delete executes and remove a blob a just-committed
 * revision needs. Doing the sweep only at startup, with the database and
 * blob store otherwise idle, removes that race entirely.
 */
export async function sweepOrphanedBlobs(
  database: Database.Database,
  blobStore: Pick<BlobStore, 'listHashes' | 'remove'>,
): Promise<BlobSweepResult> {
  const rows = database
    .prepare(`SELECT DISTINCT blob_hash AS blobHash FROM revisions`)
    .all() as BlobHashRow[];
  const referenced = new Set(rows.map((row) => row.blobHash));

  const hashes = await blobStore.listHashes();
  let removed = 0;
  for (const hash of hashes) {
    if (!referenced.has(hash)) {
      await blobStore.remove(hash);
      removed += 1;
    }
  }

  return { removed, scanned: hashes.length };
}
