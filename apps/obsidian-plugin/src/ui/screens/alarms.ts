/**
 * The two alarm sections: unresolved conflicts, and the send queue.
 *
 * Both render only when they have something to say, which is what lets a
 * healthy pane stay nearly empty (UI-02). Both are drawn ABOVE the tab strip by
 * the caller, because a tab may hide content but must never hide an alarm.
 */

import type { ConflictCopy } from '../../runtime/conflict-resolution';
import type { SendQueueStatusView } from '../../runtime/send-queue-status';
import { renderConflictSection } from '../conflict-section';
import {
  renderRecoveryNotice,
  renderSendQueueSection,
} from '../send-queue-section';

export interface ConflictsSource {
  readonly copies: readonly ConflictCopy[];
  readonly onResolve?: ((copyPath: string) => void) | undefined;
}

export function renderConflicts(content: HTMLElement, source: ConflictsSource): void {
  const { onResolve } = source;
  // An empty list draws nothing, so the section exists only while there is
  // something to resolve.
  if (source.copies.length === 0 || onResolve === undefined) return;
  renderConflictSection(content, source.copies, {
    onResolve: (copyPath) => onResolve(copyPath),
  });
}

export interface SendQueueSource {
  readonly recoveryRequired: boolean;
  readonly view: SendQueueStatusView | null;
  readonly onRetry?: ((revisionId: string) => void) | undefined;
  readonly onDiscard?: ((revisionId: string) => void) | undefined;
}

export function renderSendQueue(content: HTMLElement, source: SendQueueSource): void {
  // GAP-1: surface the recovery warning first, so it shows even when there is
  // no send-queue view (or an all-clear one) to draw beneath it.
  renderRecoveryNotice(content, source.recoveryRequired);
  const { view, onRetry, onDiscard } = source;
  if (view === null || onRetry === undefined || onDiscard === undefined) return;
  renderSendQueueSection(content, view, {
    onRetry: (revisionId) => onRetry(revisionId),
    onDiscard: (revisionId) => onDiscard(revisionId),
  });
}
