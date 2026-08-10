import type Database from 'better-sqlite3';

import { DEFAULT_VAULT_QUOTA_BYTES } from './config.js';

/**
 * Per-vault storage accounting for the attachments quota (plans/005).
 *
 * The server stays opaque: every value here derives only from `revisions.blob_size`
 * and `revisions.blob_hash`, never from payload contents. The canonical charged
 * size of a vault is the sum of `blob_size` over the DISTINCT `blob_hash` set the
 * vault references, which correctly reflects append-only history (old revisions
 * keep their blobs) while charging a content-addressed blob at most once
 * (idempotent retries and cross-file duplicates do not double-count).
 */

/**
 * Canonical storage usage of a vault: SUM(blob_size) over its DISTINCT blob_hash
 * set. Backed by the `revisions_by_blob_hash` index. This is the single source of
 * truth for both enforcement and the owner-facing usage read; there is no
 * materialised counter to drift from it.
 *
 * Grouping is by `blob_hash` alone, so a hash is charged exactly once even if it
 * is recorded with conflicting sizes. The content-addressed store makes the size
 * a function of the hash, so an honest commit cannot produce such rows; for a
 * corrupted or hand-edited row `MAX(blob_size)` wins, which fails safe by
 * over-charging rather than letting a vault quietly exceed its quota.
 */
export function computeVaultStorageBytes(
  database: Database.Database,
  vaultId: string,
): number {
  const row = database
    .prepare(
      `SELECT COALESCE(SUM(blob_size), 0) AS used
       FROM (
         SELECT blob_hash, MAX(blob_size) AS blob_size
         FROM revisions
         WHERE vault_id = ?
         GROUP BY blob_hash
       )`,
    )
    .get(vaultId) as { used: number } | undefined;
  return row?.used ?? 0;
}

/** Reads a vault's explicit per-vault quota, or `null` when it inherits the default. */
export function readVaultQuotaBytes(
  database: Database.Database,
  vaultId: string,
): number | null {
  const row = database
    .prepare(`SELECT quota_bytes AS quotaBytes FROM vaults WHERE id = ?`)
    .get(vaultId) as { quotaBytes: number | null } | undefined;
  return row?.quotaBytes ?? null;
}

/**
 * Resolves the effective quota for a vault: its explicit per-vault value when
 * set, otherwise the server-wide default (HAVEMIND_VAULT_QUOTA_BYTES).
 */
export function resolveEffectiveQuotaBytes(
  rawQuota: number | null,
  defaultQuotaBytes: number = DEFAULT_VAULT_QUOTA_BYTES,
): number {
  return rawQuota ?? defaultQuotaBytes;
}

/** Whether the vault already references this content-addressed blob (dedup check). */
export function vaultContainsBlob(
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
