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
 * Drops superseded revisions when every approved device that can see this vault
 * has already caught up to the current head. An approved device with a NULL
 * ack (never pulled, or a phone that has not opened the vault since this
 * column existed) blocks compaction.
 */
export function compactIfAllDevicesCaughtUp(
  database: Database.Database,
  revisions: Pick<
    RevisionRepository,
    'getCursor' | 'compactSupersededRevisions'
  >,
  vaultId: string,
): CompactHistoryResult {
  const head = revisions.getCursor(vaultId);
  if (head <= 0) {
    return { compactable: false, removedRevisions: 0 };
  }

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
         AND (last_ack_sequence IS NULL OR last_ack_sequence < ?)`,
    )
    .get(vaultId, vaultId, head) as { count: number };

  if (blockers.count > 0) {
    return { compactable: false, removedRevisions: 0 };
  }

  return {
    compactable: true,
    removedRevisions: revisions.compactSupersededRevisions(vaultId),
  };
}
