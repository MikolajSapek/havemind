/** The send queue the pane shows (SND-01/02, B2): its rows, Retry, Discard and Notices. */

import { Notice } from 'obsidian';

import type HavemindPlugin from '../main';
import {
  buildSendQueueStatus,
  selectNewlyQuarantined,
  type SendQueueStatusView,
} from '../runtime/send-queue-status';
import { parseFailedToQueuePath } from '../runtime/sync-state';
import {
  planQuarantineRequeueFallback,
  planRetryFromDisk,
} from '../ui/retry-plan';

import { errorMessage } from './error-message';

/** Send-queue row id prefix for a parked incoming change (B2). */
const PARKED_ROW_PREFIX = 'received:';

type Host = Pick<HavemindPlugin, 'connection' | 'syncState' | 'views'>;

export class SendQueue {
  /**
   * Quarantine revisionIds already announced with a Notice (SND-01). A Notice
   * fires only the FIRST time an item enters quarantine, never on every retry.
   */
  public notifiedQuarantineIds = new Set<string>();

  public constructor(private readonly plugin: Host) {}

  /**
   * SND-01 send-queue view for the panel, or null when disconnected (no state).
   * Reads outbox ages + quarantine straight from the persisted sync state and
   * resolves each quarantined fileId back to a vault path where one is known.
   */
  public sendQueueView(): SendQueueStatusView | null {
    const state = this.plugin.syncState;
    if (state === null) return null;
    return buildSendQueueStatus({
      outbox: state.outboxAges(),
      quarantine: [
        ...state.quarantineSnapshot(),
        // Incoming changes this device could not apply (B2) share the same rows.
        ...state.parkedSnapshot().map((item) => ({
          ...item,
          revisionId: `${PARKED_ROW_PREFIX}${item.revisionId}`,
          reason: `Could not be received: ${item.reason}`,
        })),
      ].map((item) => {
        const path = state.pathForFileId(item.fileId);
        return {
          revisionId: item.revisionId,
          fileId: item.fileId,
          reason: item.reason,
          ...(path === null ? {} : { path }),
        };
      }),
      now: Date.now(),
    });
  }

  /**
   * Retry a quarantined send. A server-rejected send (SND-01) re-enqueues its
   * stashed envelope through the outbox. A failed-to-queue row (SND-02, MAJOR 2)
   * has no envelope, it never reached the outbox, so Retry re-runs the commit
   * chain for the path against the current on-disk content; if the file has
   * since been deleted, surface a Notice and drop the stale row instead of
   * pushing a phantom empty create for a vanished file.
   */
  public async retrySend(revisionId: string): Promise<void> {
    if (revisionId.startsWith(PARKED_ROW_PREFIX)) {
      await this.retryParked(revisionId.slice(PARKED_ROW_PREFIX.length));
      return;
    }
    // Failed-to-queue synthetic row (SND-02): never had an envelope. Leave the
    // row in place on a successful re-trigger, onCommitSuccess (MAJOR 1) clears
    // it once the commit actually goes through.
    const failedPath = parseFailedToQueuePath(revisionId);
    if (failedPath !== null) {
      await this.retryFromDisk(revisionId, failedPath, { discardOnRetrigger: false });
      return;
    }
    // Server-rejected send (SND-01): re-enqueue the stashed envelope. When the
    // stash was evicted under the byte budget (MAJOR 4) the requeue is inert, so
    // fall back to re-committing the file from disk (source of truth) and drop
    // the superseded dead-letter row. FINDING 2: when the fileId no longer
    // resolves to a path there is nothing to re-commit, so surface a Notice and
    // discard the dead-letter row rather than leaving Retry a silent no-op.
    const requeued = (await this.plugin.syncState?.requeueQuarantined(revisionId)) ?? false;
    const fallback = planQuarantineRequeueFallback(
      requeued,
      this.pathForQuarantineRow(revisionId),
    );
    if (fallback.kind === 'retry-from-disk') {
      await this.retryFromDisk(revisionId, fallback.path, {
        discardOnRetrigger: true,
      });
      return;
    }
    if (fallback.kind === 'discard-dead-letter') {
      new Notice(fallback.notice);
      await this.plugin.syncState?.discardQuarantined(revisionId);
    }
    this.plugin.views.refreshOnboarding();
  }

  /** The vault path a quarantine row's fileId resolves to, or null. */
  private pathForQuarantineRow(revisionId: string): string | null {
    const state = this.plugin.syncState;
    if (state === null) return null;
    const row = state
      .quarantineSnapshot()
      .find((item) => item.revisionId === revisionId);
    return row === undefined ? null : state.pathForFileId(row.fileId);
  }

  /**
   * Re-run the commit chain for `path` from disk (the MAJOR 2 recovery for a row
   * with no usable stashed envelope). FINDING 1: the retry outcome is tri-state.
   * Only a CONFIRMED-missing file drops the row; `unavailable` (debouncer
   * disposed) and a null/uncallable connection, the common state for a durable
   * row after a restart, before reconnect, keep the row and tell the user to
   * reconnect, so a real unsynced change is never silently discarded.
   * `discardOnRetrigger` drops the row immediately after a real re-trigger for a
   * superseded server-rejected row (MAJOR 4); a failed-to-queue row keeps its
   * row until the commit lands.
   */
  private async retryFromDisk(
    revisionId: string,
    path: string,
    options: { readonly discardOnRetrigger: boolean },
  ): Promise<void> {
    const outcome = this.plugin.connection?.retryFailedCommit?.(path);
    const effect = planRetryFromDisk(outcome, path, options.discardOnRetrigger);
    if (effect.notice !== null) new Notice(effect.notice);
    if (effect.discard) await this.plugin.syncState?.discardQuarantined(revisionId);
    this.plugin.views.refreshOnboardingNow();
  }

  /** Applies a parked incoming change again (B2). */
  private async retryParked(revisionId: string): Promise<void> {
    try {
      const done = (await this.plugin.connection?.retryParked?.(revisionId)) ?? false;
      if (!done) {
        new Notice('Havemind: the note is open with unsaved changes, or you are not connected. Try again later.');
      }
    } catch (error) {
      new Notice(
        `Havemind: still cannot apply this change, ${errorMessage(error)}`,
      );
    }
    this.plugin.views.refreshOnboardingNow();
  }

  /** Permanently discard a quarantined send (SND-01). */
  public async discardSend(revisionId: string): Promise<void> {
    if (revisionId.startsWith(PARKED_ROW_PREFIX)) {
      await this.plugin.syncState?.unparkRemote(revisionId.slice(PARKED_ROW_PREFIX.length));
      this.plugin.views.refreshOnboardingNow();
      return;
    }
    await this.plugin.syncState?.discardQuarantined(revisionId);
    this.plugin.views.refreshOnboardingNow();
  }

  /**
   * SND-01: emit one Notice per item the FIRST time it enters quarantine. A
   * retry that re-quarantines the same revision is silent, its id is already in
   * `notifiedQuarantineIds`. Discarding then re-quarantining a NEW revision for
   * the same file does notify, which is correct: it is a distinct failed send.
   */
  public checkQuarantineNotices(): void {
    const state = this.plugin.syncState;
    if (state === null) return;
    const quarantine = state.quarantineSnapshot().map((item) => ({
      revisionId: item.revisionId,
      fileId: item.fileId,
      reason: item.reason,
      ...(state.pathForFileId(item.fileId) === null
        ? {}
        : { path: state.pathForFileId(item.fileId) as string }),
    }));
    const { fresh, next } = selectNewlyQuarantined(
      this.notifiedQuarantineIds,
      quarantine,
    );
    this.notifiedQuarantineIds = new Set(next);
    for (const item of fresh) {
      const label = item.path ?? item.fileId;
      new Notice(
        `A change to ${label} could not be sent, see the Havemind panel.`,
      );
    }
  }
}
