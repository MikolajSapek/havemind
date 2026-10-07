/**
 * The revision feed, rendered as rows in the pane's Activity tab
 * (plans/007 Stage 0).
 */

import type { RevisionRecord } from '../activity/activity';
import { activityDayLabel, buildActivityViewModel, clockLabel } from '../runtime/activity-render';

import { formatActivityTime } from './primitives';

export const EMPTY_ACTIVITY_TEXT =
  'No changes since Obsidian opened.';

/** Data and actions an activity surface needs. */
/**
 * Rows drawn at once when the caller names no limit.
 *
 * The log keeps 200 entries; drawing all of them costs ~8 DOM nodes each,
 * rebuilt on every repaint. Enough to read as a log, few enough that the tab
 * stays cheap on a phone. The history is untouched: this bounds the DOM, not
 * what is kept.
 */
export const DEFAULT_ACTIVITY_ROW_LIMIT = 60;

export interface ActivitySectionOptions {
  readonly feed: readonly RevisionRecord[];
  readonly onRestore?: (revisionId: string) => void;
  /** Cap on rendered rows; omit for the full feed. */
  readonly limit?: number;
  /** "Now" for the day headers; tests pin it, the pane uses the clock. */
  readonly now?: number;
}

/**
 * Renders the feed into `content`. Returns the number of rows drawn, so a
 * caller can label a collapsed summary without rebuilding the model.
 */
export function renderActivityRows(
  content: HTMLElement,
  options: ActivitySectionOptions,
): number {
  const now = options.now ?? Date.now();
  const model = buildActivityViewModel(options.feed, {
    formatTimestamp: formatActivityTime,
    limit: options.limit ?? DEFAULT_ACTIVITY_ROW_LIMIT,
  });
  if (model.empty) {
    const empty = content.createDiv({ text: EMPTY_ACTIVITY_TEXT });
    empty.addClass('havemind-empty');
    return 0;
  }

  let day = '';
  for (const row of model.rows) {
    // Day headers instead of a date on every row: "Today", "Yesterday", "3 Oct".
    const rowDay = activityDayLabel(row.timestamp, now);
    if (rowDay !== day) {
      day = rowDay;
      content.createDiv({ text: rowDay }).addClass('havemind-activity-day');
    }
    const entry = content.createDiv();
    entry.addClass('havemind-activity-row');
    entry.addClass(`is-${row.kind}`);
    // The note's name over who did what; the full path stays on the tooltip.
    const text = entry.createDiv();
    text.addClass('havemind-activity-main');
    const title = text.createDiv({ text: row.title });
    title.addClass('havemind-activity-title');
    title.setAttribute('title', row.pathLabel);
    text.createDiv({ text: row.meta }).addClass('havemind-activity-meta');
    // Time and Restore in a non-shrinking column, so a long name can never push
    // either past the sidebar edge.
    const trail = entry.createDiv();
    trail.addClass('havemind-activity-trail');
    if (row.canRestore && options.onRestore) {
      const restore = trail.createEl('button', { text: 'Restore' });
      restore.addClass('havemind-activity-action');
      restore.onClickEvent(() => options.onRestore?.(row.revisionId));
    }
    trail.createEl('span', { text: clockLabel(row.timestamp) }).addClass('havemind-activity-time');
  }

  return model.rows.length;
}
