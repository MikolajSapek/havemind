import type Database from 'better-sqlite3';

import type { RevisionRepository } from './revision-repository.js';

export interface CompactHistoryResult {
  readonly compactable: boolean;
  readonly removedRevisions: number;
}

/**
 * Records that `deviceId` has already materialised the vault log through
 * `afterSequence` (the pull cursor it presented). Never regresses.
 */
export function recordDevicePullAck(
  database: Database.Database,
  deviceId: string,
  afterSequence: number,
  nowIso: string,
): void {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    return;
  }
  database
    .prepare(
      `UPDATE devices
       SET last_ack_sequence = ?, last_ack_at = ?
       WHERE id = ?
         AND (last_ack_sequence IS NULL OR last_ack_sequence < ?)`,
    )
    .run(afterSequence, nowIso, deviceId, afterSequence);
}

/**
 * How long a device may go without pulling before it stops blocking compaction.
 *
 * Without an upper bound, one device that fell behind and never came back pins
 * every superseded revision for the life of the vault: the log then only grows,
 * which is the unbounded history this whole mechanism exists to prevent. Thirty
 * days is well past any ordinary gap (a holiday, a phone left in a drawer), and
 * ageing a device out costs it nothing: a returning device materialises the
 * CURRENT heads through the snapshot pull, which never reads the superseded log.
 */
export const STALE_DEVICE_ACK_MS = 30 * 24 * 60 * 60 * 1000;

export interface CompactHistoryOptions {
  /** Wall clock for the staleness window; defaults to now. */
  readonly now?: number;
}

/**
 * Drops superseded revisions when every approved device that can see this vault
 * has already caught up to the current head.
 *
 * Two kinds of device still block: one that is behind but was seen within
 * {@link STALE_DEVICE_ACK_MS}, and one with a NULL ack. A NULL ack has no
 * timestamp to age out and is also the shape of a device approved moments ago
 * that is about to make its first pull, so it keeps failing closed.
 */
export function compactIfAllDevicesCaughtUp(
  database: Database.Database,
  revisions: Pick<
    RevisionRepository,
    'getCursor' | 'compactSupersededRevisions'
  >,
  vaultId: string,
  options?: CompactHistoryOptions,
): CompactHistoryResult {
  const head = revisions.getCursor(vaultId);
  if (head <= 0) {
    return { compactable: false, removedRevisions: 0 };
  }

  // ISO-8601 UTC sorts lexicographically, which is how `last_ack_at` is written,
  // so the cutoff compares directly in SQL without a date function.
  const staleCutoff = new Date(
    (options?.now ?? Date.now()) - STALE_DEVICE_ACK_MS,
  ).toISOString();

  const blockers = database
    .prepare(
      `SELECT COUNT(*) AS count
       FROM devices
       WHERE status = 'approved'
         AND (
           vault_id = ?
           OR (
             vault_id IS NULL
             AND user_id IN (
               SELECT user_id FROM memberships
               WHERE vault_id = ? AND status = 'active'
             )
           )
         )
         AND (
           last_ack_sequence IS NULL
           OR (
             last_ack_sequence < ?
             -- Behind, but only blocking while it is still being used. A device
             -- last seen before the cutoff has stopped pulling for good as far as
             -- the log is concerned; it rejoins through the snapshot path.
             AND (last_ack_at IS NULL OR last_ack_at >= ?)
           )
         )`,
    )
    .get(vaultId, vaultId, head, staleCutoff) as { count: number };

  if (blockers.count > 0) {
    return { compactable: false, removedRevisions: 0 };
  }

  return {
    compactable: true,
    removedRevisions: revisions.compactSupersededRevisions(vaultId),
  };
}
