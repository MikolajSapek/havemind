/**
 * Keeping a device in regular use signed in.
 *
 * A refresh-token family was created with a fixed 30-day expiry that nothing
 * ever moved, so a device syncing every few minutes was cut off after a month
 * regardless. On the pilot desktop the family expired at 20:53 while the device
 * was mid-session: every later refresh answered 401, the panel kept showing the
 * last good cycle, the outbox grew for nineteen hours, and the only way back was
 * re-pairing by hand.
 *
 * A successful rotation is proof of use, because it requires a valid, unconsumed
 * refresh token that only the live device holds. So each rotation slides the
 * family's expiry to a full window from now. An idle device ages out on exactly
 * the same schedule as before: nothing rotates, so nothing slides.
 *
 * The window is unchanged (30 days) and so is every other boundary: a revoked
 * family, an expired one, and a family whose expiry is already further out are
 * all left alone.
 */

import type Database from 'better-sqlite3';

/** How far ahead of a rotation a family's expiry is placed. */
export const REFRESH_FAMILY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Extends an active family's expiry to `now + REFRESH_FAMILY_WINDOW_MS`.
 *
 * Guarded so it can only ever move the boundary FORWARD for a family that is
 * currently valid:
 *  - `status = 'active'` so a revoked family is never revived;
 *  - `expires_at > now` so an already-expired family stays expired (rotation
 *    checks that first, but sliding it here would silently undo the boundary);
 *  - `expires_at < next` so a longer window, or a clock that stepped backwards,
 *    is never shortened.
 *
 * Runs inside the caller's transaction and touches one row, so it adds no
 * failure mode of its own to the rotation path.
 */
export function slideFamilyExpiry(
  database: Database.Database,
  familyId: string,
  now: Date,
): void {
  const nextExpiry = new Date(now.getTime() + REFRESH_FAMILY_WINDOW_MS).toISOString();
  const nowIso = now.toISOString();
  database
    .prepare(
      `UPDATE refresh_token_families
          SET expires_at = ?
        WHERE id = ?
          AND status = 'active'
          AND expires_at > ?
          AND expires_at < ?`,
    )
    .run(nextExpiry, familyId, nowIso, nextExpiry);
}
