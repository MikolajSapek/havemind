/**
 * The SND-01 send-queue visibility section plus the GAP-1 recovery notice: the
 * two places the panel admits that local changes have not reached the server.
 * They sit together because both are drawn from the same durable sync state
 * immediately beneath the status indicator, and both must stay silent when there
 * is nothing wrong — a healthy queue renders no markup at all. Presentation only;
 * Retry and the two-step Discard call back into the plugin.
 */

import type { SendQueueStatusView } from '../runtime/send-queue-status';

import { armedButton } from './primitives';

/** Actions wired to each failed-send row in the send-queue section (SND-01). */
export interface SendQueueSectionActions {
  /** Re-enqueue the quarantined send through the normal outbox machinery. */
  readonly onRetry: (revisionId: string) => void;
  /** Permanently drop the quarantined send (destructive → two-step confirm). */
  readonly onDiscard: (revisionId: string) => void;
}

/**
 * Renders the SND-01 send-queue visibility section: a muted "N change(s)
 * waiting to send" line when items have been queued too long, and — when the
 * quarantine is non-empty — a distinct "N change(s) failed to send" warning with
 * one row per failed item (path + reason) offering Retry and a two-step Discard.
 * Draws nothing when both signals are absent, so a healthy queue stays silent.
 */
export function renderSendQueueSection(
  content: HTMLElement,
  view: SendQueueStatusView,
  actions: SendQueueSectionActions,
): void {
  if (view.waitingCount > 0) {
    const waiting = content.createDiv({
      text: `${view.waitingCount} change(s) waiting to send`,
    });
    waiting.addClass('havemind-send-waiting');
  }

  if (view.failed.length === 0) return;

  const header = content.createDiv({
    text: `${view.failed.length} change(s) failed to send`,
  });
  header.addClass('havemind-send-failed');

  for (const row of view.failed) {
    const item = content.createDiv({ text: '' });
    item.addClass('havemind-send-failed-row');
    item.createEl('span', { text: row.label }).addClass('havemind-send-file');
    item
      .createEl('span', { text: ` · ${row.reason}` })
      .addClass('havemind-send-reason');
    const retry = item.createEl('button', { text: 'Retry' });
    retry.addClass('havemind-send-action');
    retry.onClickEvent(() => actions.onRetry(row.revisionId));
    armedButton(
      item,
      'Discard',
      'Confirm discard',
      'mod-warning',
      () => actions.onDiscard(row.revisionId),
    );
  }
}

/**
 * Renders the "local queue needs recovery" warning (GAP-1). Shown when the
 * durable sync state could not read its persisted outbox and resumed from a
 * clean, writable empty state — the unsent revisions were preserved to a sidecar
 * for manual recovery, so the user must be told rather than left assuming the
 * queue drained silently. Renders nothing when recovery is not required.
 */
export function renderRecoveryNotice(
  content: HTMLElement,
  recoveryRequired: boolean,
): void {
  if (!recoveryRequired) return;
  const row = content.createDiv({
    text: 'Local queue needs recovery — some unsent changes could not be read and were preserved for manual recovery.',
  });
  row.addClass('havemind-send-recovery');
}
