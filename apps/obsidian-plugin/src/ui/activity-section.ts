/**
 * The revision feed, rendered as rows.
 *
 * Extracted from `activity-view.ts` when the feed became a section of the main
 * pane as well as its own view (plans/007 Stage 0). Both surfaces call this, so
 * a change to row wording, ordering, restore or author colour lands in exactly
 * one place, two copies would drift on the first edit.
 */

import type { RevisionRecord } from '../activity/activity';
import { buildActivityViewModel } from '../runtime/activity-render';

import { formatActivityTime } from './primitives';

export const EMPTY_ACTIVITY_TEXT =
  'No activity yet. Connect to a vault to see changes as they happen.';

/** Data and actions an activity surface needs. */
export interface ActivitySectionOptions {
  readonly feed: readonly RevisionRecord[];
  readonly onRestore?: (revisionId: string) => void;
  /** Cap on rendered rows; omit for the full feed. */
  readonly limit?: number;
}

/**
 * Renders the feed into `content`. Returns the number of rows drawn, so a
 * caller can label a collapsed summary without rebuilding the model.
 */
export function renderActivityRows(
  content: HTMLElement,
  options: ActivitySectionOptions,
): number {
  const model = buildActivityViewModel(options.feed, {
    formatTimestamp: formatActivityTime,
  });
  if (model.empty) {
    const empty = content.createDiv({ text: EMPTY_ACTIVITY_TEXT });
    empty.addClass('havemind-empty');
    return 0;
  }

  const rows =
    options.limit === undefined ? model.rows : model.rows.slice(0, options.limit);

  for (const row of rows) {
    const entry = content.createDiv();
    entry.addClass('havemind-activity-row');
    // Two-line row: `author verb` headline over the vault path. The full
    // `kind · path · actor` string still lives on `row.label` for anything
    // that reads it; nothing about the data changes.
    const text = entry.createDiv();
    text.addClass('havemind-activity-main');
    text.addClass('havemind-activity-copy');
    text.createDiv({ text: row.headline }).addClass('havemind-activity-who');
    const path = text.createDiv({ text: row.pathLabel });
    path.addClass('havemind-hint');
    path.addClass('havemind-activity-path');
    // Author colour as a left accent, paired with the author name already in
    // the headline, colour is never the only signal (accessibility rule).
    entry.style.setProperty('--havemind-row-color', `var(${row.colorToken})`);
    // The trailing column owns the compact timestamp and Restore action. It is
    // deliberately a non-shrinking sibling of the wrapping text column, so a
    // long vault path can never push either control beyond the sidebar edge.
    const trail = entry.createDiv();
    trail.addClass('havemind-activity-trail');
    if (row.canRestore && options.onRestore) {
      const restore = trail.createEl('button', { text: 'Restore' });
      restore.addClass('havemind-activity-action');
      restore.onClickEvent(() => options.onRestore?.(row.revisionId));
    }
    const time = trail.createEl('span', { text: row.timeLabel });
    time.addClass('havemind-activity-time');
  }

  return model.rows.length;
}
