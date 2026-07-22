import type Database from 'better-sqlite3';

/**
 * Stale-device DB cleanup (F9 backlog item).
 *
 * During the pilot the operator manually deleted stale invitations and
 * hanging pending devices with raw SQL. This module is the one-liner
 * replacement, exposed as the `cleanup-stale` CLI subcommand.
 *
 * What it removes:
 *   - invitations that are expired (`expires_at` in the past) or already
 *     consumed (`consumed_at` set) — the invitation row itself is never a
 *     foreign-key target, so deleting it is always safe.
 *   - devices stuck in `status = 'pending'` older than a threshold (default
 *     24h), *unless* another table still holds an `ON DELETE RESTRICT`
 *     reference to that device (`revisions.device_id`,
 *     `invitations.inviter_device_id`, `owner_pairings.consumed_by_device_id`)
 *     — those are skipped and reported rather than deleted, so this command
 *     can never violate a foreign-key constraint or silently orphan data.
 *
 * It never touches approved/active devices, memberships, revisions, vault
 * events, or sessions of active devices: those are only ever read (to check
 * for RESTRICT references), never written.
 */

export interface CleanupStaleOptions {
  readonly pendingOlderThanHours?: number;
  readonly dryRun?: boolean;
  readonly now?: () => Date;
}

export interface CleanupStaleResult {
  readonly invitationsRemoved: number;
  readonly pendingDevicesRemoved: number;
  readonly skippedDueToReferences: number;
}

export const DEFAULT_PENDING_OLDER_THAN_HOURS = 24;

interface IdRow {
  readonly id: string;
}

function findStaleInvitationIds(
  database: Database.Database,
  nowIso: string,
): readonly string[] {
  const rows = database
    .prepare(
      `SELECT id FROM invitations
       WHERE expires_at < ? OR consumed_at IS NOT NULL`,
    )
    .all(nowIso) as IdRow[];
  return rows.map((row) => row.id);
}

function findStalePendingDeviceIds(
  database: Database.Database,
  thresholdIso: string,
): readonly string[] {
  const rows = database
    .prepare(
      `SELECT id FROM devices
       WHERE status = 'pending' AND created_at < ?`,
    )
    .all(thresholdIso) as IdRow[];
  return rows.map((row) => row.id);
}

interface RestrictCountRow {
  readonly restrictCount: number;
}

/**
 * True if deleting this device would violate an `ON DELETE RESTRICT`
 * foreign key. Checked explicitly (rather than deleting and catching a
 * SQLite constraint error) so the CLI can report an exact skipped count.
 */
function hasRestrictingReferences(
  database: Database.Database,
  deviceId: string,
): boolean {
  const row = database
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM revisions WHERE device_id = ?) +
         (SELECT COUNT(*) FROM invitations WHERE inviter_device_id = ?) +
         (SELECT COUNT(*) FROM owner_pairings WHERE consumed_by_device_id = ?)
         AS restrictCount`,
    )
    .get(deviceId, deviceId, deviceId) as RestrictCountRow;
  return row.restrictCount > 0;
}

/**
 * Runs the stale-device cleanup sweep. Pure with respect to time: the
 * "now" and "threshold" instants are captured once at the top so a single
 * call is internally consistent, and the whole sweep (reads + deletes)
 * happens inside one SQLite transaction.
 */
export function runStaleCleanup(
  database: Database.Database,
  options: CleanupStaleOptions = {},
): CleanupStaleResult {
  const pendingOlderThanHours =
    options.pendingOlderThanHours ?? DEFAULT_PENDING_OLDER_THAN_HOURS;
  if (
    !Number.isFinite(pendingOlderThanHours) ||
    pendingOlderThanHours < 0
  ) {
    throw new RangeError(
      'pendingOlderThanHours must be a non-negative finite number.',
    );
  }
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? (() => new Date());
  const nowMs = now().getTime();
  const nowIso = new Date(nowMs).toISOString();
  const thresholdIso = new Date(
    nowMs - pendingOlderThanHours * 60 * 60 * 1000,
  ).toISOString();

  const sweep = database.transaction((): CleanupStaleResult => {
    const staleInvitationIds = findStaleInvitationIds(database, nowIso);
    const stalePendingDeviceIds = findStalePendingDeviceIds(
      database,
      thresholdIso,
    );

    let skippedDueToReferences = 0;
    const deletableDeviceIds: string[] = [];
    for (const deviceId of stalePendingDeviceIds) {
      if (hasRestrictingReferences(database, deviceId)) {
        skippedDueToReferences += 1;
      } else {
        deletableDeviceIds.push(deviceId);
      }
    }

    if (dryRun) {
      return {
        invitationsRemoved: staleInvitationIds.length,
        pendingDevicesRemoved: deletableDeviceIds.length,
        skippedDueToReferences,
      };
    }

    const deleteInvitation = database.prepare(
      'DELETE FROM invitations WHERE id = ?',
    );
    for (const invitationId of staleInvitationIds) {
      deleteInvitation.run(invitationId);
    }

    const deleteDevice = database.prepare('DELETE FROM devices WHERE id = ?');
    for (const deviceId of deletableDeviceIds) {
      deleteDevice.run(deviceId);
    }

    return {
      invitationsRemoved: staleInvitationIds.length,
      pendingDevicesRemoved: deletableDeviceIds.length,
      skippedDueToReferences,
    };
  });

  return sweep.immediate();
}

/** Formats the operator-facing summary line for the `cleanup-stale` CLI output. */
export function formatCleanupSummary(
  result: CleanupStaleResult,
  dryRun: boolean,
): string {
  const verb = dryRun ? 'would be removed' : 'removed';
  return (
    `${result.invitationsRemoved} invitation(s) ${verb}, ` +
    `${result.pendingDevicesRemoved} pending device(s) ${verb}, ` +
    `${result.skippedDueToReferences} skipped due to references.`
  );
}
