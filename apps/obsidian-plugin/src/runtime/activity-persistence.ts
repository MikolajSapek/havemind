/**
 * Keeps the Activity feed across restarts (plan 011, 1.1), in the client
 * database's `activity` store. Never in data.json: that file is rewritten on
 * every cursor save, and 1.5.9 just stopped it from growing.
 *
 * Best effort by design. A database that will not open, or a damaged record,
 * leaves the feed working in memory exactly as before.
 */

import type { ActivityAuthor, ActivityLog, ActivityLogEntry } from './activity-log';

/** The two calls this needs from the client database. */
export interface ActivityRecords {
  getActivityRecord(key: string): Promise<unknown>;
  putActivityRecord(key: string, value: unknown): Promise<void>;
}

const KEY = 'feed';
const FORMAT = 1;
const KINDS = new Set(['create', 'edit', 'rename', 'delete', 'conflict']);

function isAuthor(value: unknown): value is ActivityAuthor {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'member') return typeof (value as { membershipId?: unknown }).membershipId === 'string';
  return kind === 'remote' || kind === 'initial-import';
}

function isEntry(value: unknown): value is ActivityLogEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.revisionId === 'string' &&
    typeof e.fileId === 'string' &&
    typeof e.path === 'string' &&
    typeof e.kind === 'string' &&
    KINDS.has(e.kind) &&
    isAuthor(e.author) &&
    typeof e.timestamp === 'number' &&
    Number.isFinite(e.timestamp) &&
    typeof e.hasContent === 'boolean'
  );
}

function storedEntries(value: unknown): ActivityLogEntry[] {
  if (typeof value !== 'object' || value === null) return [];
  const record = value as { format?: unknown; entries?: unknown };
  if (record.format !== FORMAT || !Array.isArray(record.entries)) return [];
  return record.entries.filter(isEntry);
}

/** Restores the stored feed into `log`, then saves it on every change. */
export function persistActivity(
  log: ActivityLog,
  openRecords: () => Promise<ActivityRecords | null>,
): () => void {
  let disposed = false;
  let unsubscribe = (): void => undefined;
  let warned = false;
  void (async () => {
    const records = await openRecords().catch(() => null);
    if (records === null || disposed) return;
    try {
      log.restore(storedEntries(await records.getActivityRecord(KEY)));
    } catch {
      // A record we cannot read starts a fresh feed.
    }
    if (disposed) return;
    const save = (): void => {
      records.putActivityRecord(KEY, { format: FORMAT, entries: log.snapshot() }).catch(() => {
        if (warned) return;
        warned = true;
        console.warn('Havemind: could not save the activity feed; it will reset when Obsidian restarts.');
      });
    };
    unsubscribe = log.subscribe(save);
    // Rows recorded while the store was opening are not saved yet.
    if (log.snapshot().length > 0) save();
  })();
  return () => {
    disposed = true;
    unsubscribe();
  };
}
