/**
 * View-model helpers for the Activity surface (`plan/06-plugin-activity-and-overlay.md`).
 *
 * These stay pure so the desktop shell can render a newest-first feed without
 * the DOM. They wrap the already-tested `buildActivityFeed` from
 * `activity/activity.ts`; the append-only restore
 * itself goes through `restoreRevision`, which this module deliberately does not
 * re-implement (rule 4, a single append-only restore path).
 */

import {
  buildActivityFeed,
  type ActivityEntry,
  type ActivityKind,
  type RevisionRecord,
} from '../activity/activity';
import {
  authorColorToken,
  INITIAL_IMPORT_COLOR_TOKEN,
} from './author-colors';

export interface ActivityRowView {
  readonly revisionId: string;
  readonly fileId: string;
  /** `kind · path · author`, author is paired with the colour token below. */
  readonly label: string;
  /** `author verb`, the row's first line. `label` stays the full string. */
  readonly headline: string;
  /** Vault path, the row's second line. */
  readonly pathLabel: string;
  readonly timestamp: number;
  /** Human-readable time shown alongside each entry (author + file + time). */
  readonly timeLabel: string;
  /**
   * Deterministic, stable colour token for the entry's author (see
   * `author-colors`). Rendered as an accent paired with the author name in
   * `label`, colour is never the only signal. Initial-import fragments get the
   * reserved neutral token.
   */
  readonly colorToken: string;
  readonly canRestore: boolean;
  /** The note's name without `.md` (attachments keep their extension). */
  readonly title: string;
  /** Who did what, in words: "Hubert edited", "Both versions kept". */
  readonly meta: string;
  readonly kind: ActivityKind;
}

export interface ActivityViewModel {
  readonly empty: boolean;
  readonly rows: readonly ActivityRowView[];
}

export interface ActivityViewModelOptions {
  /**
   * Rows to keep after ordering. Omit to build the whole feed; the pane passes
   * its render cap so discarded rows are never formatted.
   */
  readonly limit?: number;
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
  // Cut to the limit BETWEEN ordering and formatting. The order has to be
  // decided over every record ("newest first" cannot be read off a prefix), but
  // formatting the ones that will never be drawn is pure waste, and the pane
  // rebuilds this on every repaint of the tab.
  const ordered = buildActivityFeed(records);
  const visible =
    options.limit === undefined ? ordered : ordered.slice(0, options.limit);
  const rows = visible.map(
    (entry): ActivityRowView => ({
      revisionId: entry.revisionId,
      fileId: entry.fileId,
      label: `${entry.kind} · ${entry.path} · ${entry.actorLabel}`,
      headline: metaLine(entry),
      pathLabel: entry.path,
      timestamp: entry.timestamp,
      timeLabel: format(entry.timestamp),
      colorToken:
        entry.actorId === null
          ? INITIAL_IMPORT_COLOR_TOKEN
          : authorColorToken(entry.actorId),
      canRestore: entry.canRestore,
      title: noteTitle(entry.path),
      meta: metaLine(entry),
      kind: entry.kind,
    }),
  );
  return { empty: rows.length === 0, rows };
}

/** An edit needs no object; the others read better with one ("created it"). */
const VERBS: Readonly<Record<ActivityKind, string>> = {
  edit: 'edited',
  create: 'created it',
  rename: 'renamed it',
  delete: 'deleted it',
  conflict: 'kept both versions',
};

function metaLine(entry: ActivityEntry): string {
  if (entry.kind === 'conflict') return 'Both versions kept';
  if (entry.actorId === null) return entry.actorLabel;
  return `${entry.actorLabel} ${VERBS[entry.kind]}`;
}

function noteTitle(path: string): string {
  const name = path.split('/').pop() ?? path;
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

const MONTHS = 'JanFebMarAprMayJunJulAugSepOctNovDec';
const twoDigits = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** "Today", "Yesterday", else "3 Oct": the Activity tab's day headers. */
export function activityDayLabel(timestamp: number, now: number = Date.now()): string {
  const at = new Date(timestamp);
  const today = new Date(now);
  const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(today) - startOfDay(at)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${at.getDate()} ${MONTHS.slice(at.getMonth() * 3, at.getMonth() * 3 + 3)}`;
}

/** Local 24-hour clock, "06:02": the time beside a row under its day header. */
export function clockLabel(timestamp: number): string {
  const at = new Date(timestamp);
  return `${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}`;
}
