/**
 * View-model helpers for the Activity surface (`plan/06-plugin-activity-i-overlay.md`).
 *
 * These stay pure so the desktop shell can render a newest-first feed and a line
 * diff without the DOM. They wrap the already-tested `buildActivityFeed` and
 * `computeRevisionDiff` from `activity/activity.ts`; the append-only restore
 * itself goes through `restoreRevision`, which this module deliberately does not
 * re-implement (rule 4 — a single append-only restore path).
 */

import {
  buildActivityFeed,
  computeRevisionDiff,
  type RevisionRecord,
} from '../activity/activity';
import {
  authorColorToken,
  INITIAL_IMPORT_COLOR_TOKEN,
} from './author-colors';

export interface ActivityRowView {
  readonly revisionId: string;
  readonly fileId: string;
  /** `kind · path · author` — author is paired with the colour token below. */
  readonly label: string;
  readonly timestamp: number;
  /** Human-readable time shown alongside each entry (author + file + time). */
  readonly timeLabel: string;
  /**
   * Deterministic, stable colour token for the entry's author (see
   * `author-colors`). Rendered as an accent paired with the author name in
   * `label` — colour is never the only signal. Initial-import fragments get the
   * reserved neutral token.
   */
  readonly colorToken: string;
  readonly canRestore: boolean;
}

export interface ActivityViewModel {
  readonly empty: boolean;
  readonly rows: readonly ActivityRowView[];
}

export interface ActivityViewModelOptions {
  /** Formats an entry timestamp for display; defaults to ISO-8601. */
  readonly formatTimestamp?: (timestamp: number) => string;
}

function defaultFormatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

export function buildActivityViewModel(
  records: readonly RevisionRecord[],
  options: ActivityViewModelOptions = {},
): ActivityViewModel {
  const format = options.formatTimestamp ?? defaultFormatTimestamp;
  const rows = buildActivityFeed(records).map(
    (entry): ActivityRowView => ({
      revisionId: entry.revisionId,
      fileId: entry.fileId,
      label: `${entry.kind} · ${entry.path} · ${entry.actorLabel}`,
      timestamp: entry.timestamp,
      timeLabel: format(entry.timestamp),
      colorToken:
        entry.actorId === null
          ? INITIAL_IMPORT_COLOR_TOKEN
          : authorColorToken(entry.actorId),
      canRestore: entry.canRestore,
    }),
  );
  return { empty: rows.length === 0, rows };
}

/** Unified-style line rows (`  context`, `- removed`, `+ added`) for the modal. */
export function formatDiffRows(
  before: string | null,
  after: string | null,
): string[] {
  return computeRevisionDiff(before, after).rows.map((row) => {
    const prefix = row.type === 'added' ? '+ ' : row.type === 'removed' ? '- ' : '  ';
    return `${prefix}${row.text}`;
  });
}
