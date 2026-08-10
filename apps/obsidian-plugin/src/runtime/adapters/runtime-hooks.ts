/**
 * The one-way callback surface the plugin injects into the adapters so live UI
 * panes can observe the sync loop without the adapters ever importing the UI.
 * Kept in its own leaf module because it is the contract that inverts that
 * dependency: everything below it (controller wiring, push producer, connect
 * flows) accepts these hooks, and nothing here reaches back up.
 */

import type { ActivityLogEntry } from '../activity-log';

/**
 * Client-side runtime hooks the plugin injects so live UI surfaces can observe
 * the sync loop without the adapters importing the UI. Endpoint-free: these
 * carry data the client already has.
 */
export interface RuntimeHooks {
  /**
   * Called for each genuine local change the push producer detects (a non-null
   * observe result), so the Activity view can populate and live-update. Never
   * called for a no-op or for a remote-applied write. The entry is attributed to
   * the local member; note contents are never included.
   */
  readonly onLocalActivity?: (entry: ActivityLogEntry) => void;
  /**
   * Called for each remote revision the sync runner genuinely applied to the
   * vault (`VaultApplyAdapter.applyRemote` returning 'applied' — never 'noop'
   * or 'conflict'), so the Activity view reflects the other device's edits
   * too. The entry is attributed to `{ kind: 'remote' }` (resolved to the
   * sole other roster member in the two-person pilot by `activity-log.ts`);
   * note contents are never included.
   */
  readonly onRemoteActivity?: (entry: ActivityLogEntry) => void;
  /**
   * Called once each time the apply path writes a genuinely NEW conflict copy
   * (MRG-05), so the plugin can schedule a debounced auto-repair sweep. Never
   * fired for an idempotent rewrite of an existing copy, so a sweep can never
   * be re-triggered by its own (or a retry's) copy write.
   */
  readonly onConflictWritten?: () => void;
  /**
   * Called when the send-queue (SND-01/02) changes outside a status cycle — in
   * particular when a successful commit clears a stale `failed-to-queue` row
   * (MAJOR 1) — so the panel drops the phantom failure immediately rather than
   * waiting for the next status change to refresh it.
   */
  readonly onSendQueueChanged?: () => void;
  /**
   * Called with the synthetic revisionId when commit-recovery has already shown
   * a Notice for a failed-to-queue row (MINOR 7). The plugin marks the id as
   * already-notified so the panel's own quarantine-notice check skips it, so a
   * single failed-to-queue event never fires two Notices.
   */
  readonly onFailedToQueueNotified?: (revisionId: string) => void;
}
