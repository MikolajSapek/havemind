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

export interface ActivityRowView {
  readonly revisionId: string;
  readonly fileId: string;
  readonly label: string;
  readonly timestamp: number;
  readonly canRestore: boolean;
}

export interface ActivityViewModel {
  readonly empty: boolean;
  readonly rows: readonly ActivityRowView[];
}

export function buildActivityViewModel(
  records: readonly RevisionRecord[],
): ActivityViewModel {
  const rows = buildActivityFeed(records).map(
    (entry): ActivityRowView => ({
      revisionId: entry.revisionId,
      fileId: entry.fileId,
      label: `${entry.kind} · ${entry.path} · ${entry.actorLabel}`,
      timestamp: entry.timestamp,
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
