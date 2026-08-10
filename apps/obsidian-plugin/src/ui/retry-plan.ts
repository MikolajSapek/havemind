/**
 * The two pure planners behind the send-queue section's Retry button: they map a
 * `retryFailedCommit` outcome, and an inert re-queue of a server-rejected row,
 * onto the Notice text plus the keep-or-discard decision the panel must apply.
 * Keeping them here — free of any plugin, vault or network handle — is what lets
 * the "never silently drop a real unsent change" rules be unit-tested directly.
 */

import type { RetryFailedCommitOutcome } from '../runtime/commit-recovery';

/** The Notice + discard a from-disk retry should apply. */
export interface RetryFromDiskEffect {
  /** User-visible message, or null when the retry is silent. */
  readonly notice: string | null;
  /** Whether the quarantine row should be discarded. */
  readonly discard: boolean;
}

/**
 * FINDING 1: map a `retryFailedCommit` outcome to its Notice + discard effect.
 * The old boolean conflated three cases; only a CONFIRMED-missing file drops the
 * row. `unavailable` (debouncer disposed) and a null/uncallable connection — the
 * common state for a durable row after a restart, before reconnect — KEEP the
 * row and tell the user to reconnect, so a real unsynced change is never lost.
 */
export function planRetryFromDisk(
  outcome: RetryFailedCommitOutcome | undefined,
  path: string,
  discardOnRetrigger: boolean,
): RetryFromDiskEffect {
  switch (outcome) {
    case 'file-missing':
      return {
        notice: `${path} no longer exists — removing it from the queue.`,
        discard: true,
      };
    case 'retriggered':
      return { notice: null, discard: discardOnRetrigger };
    default:
      return {
        notice: 'Cannot retry while disconnected — reconnect first.',
        discard: false,
      };
  }
}

/** The next step after attempting to requeue a server-rejected quarantine row. */
export type QuarantineRequeueFallback =
  | { readonly kind: 'requeued' }
  | { readonly kind: 'retry-from-disk'; readonly path: string }
  | { readonly kind: 'discard-dead-letter'; readonly notice: string };

/**
 * FINDING 2: decide the fallback when re-queuing a server-rejected row is inert
 * (its stashed envelope was evicted under the byte budget). When the row's
 * fileId still resolves to a path, re-commit from disk; when it resolves to
 * nothing there is nothing to re-commit, so surface a Notice and discard the
 * dead-letter row rather than leaving Retry a silent no-op.
 */
export function planQuarantineRequeueFallback(
  requeued: boolean,
  path: string | null,
): QuarantineRequeueFallback {
  if (requeued) return { kind: 'requeued' };
  if (path !== null) return { kind: 'retry-from-disk', path };
  return {
    kind: 'discard-dead-letter',
    notice: 'The original file for this change no longer exists — removing it.',
  };
}
