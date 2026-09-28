/**
 * P13: the accepted revision log kept in IndexedDB between connections, so a new
 * connection pulls only the events it has not seen instead of the whole log.
 *
 * Layout, per vault, in the client database's `history` store:
 *
 *   `revision-history|<vaultId>`     meta: { format, apiBaseUrl, vaultId, epoch, cursor, segments }
 *   `revision-history|<vaultId>|<n>` segment n: { format, from, events }
 *
 * Segment n holds the events after sequence `from`, and the segments together
 * are the log from sequence 1 to `cursor`. A save appends one segment and then
 * rewrites the small meta record, so its cost is the new events, not the log.
 * The meta record is the commit point: a segment written without it is never
 * read. Past {@link MAX_HISTORY_SEGMENTS} segments, or whenever the store does
 * not hold exactly what the caller appends to, the log is rewritten as one
 * segment, with the meta record removed first so a torn rewrite reads as absent.
 *
 * Only event metadata is stored, never payloads. Anything unexpected on load
 * reads as absent; {@link RevisionHistory} then reads the log from the server.
 */

import type { RemoteEvent } from '../sync/sync-runner';
import type { RevisionHistoryStore, StoredRevisionHistory } from './revision-history';

export const MAX_HISTORY_SEGMENTS = 64;
const FORMAT = 1;
const KEY_PREFIX = 'revision-history';

/** The slice of the client database this store needs. */
export interface HistoryRecords {
  getHistoryRecord(key: string): Promise<unknown>;
  putHistoryRecord(key: string, value: unknown): Promise<void>;
  deleteHistoryRecord(key: string): Promise<void>;
}

interface Meta {
  readonly format: number;
  readonly apiBaseUrl: string;
  readonly vaultId: string;
  readonly epoch: string | null;
  readonly cursor: number;
  readonly segments: number;
}

/**
 * `openRecords` resolves to null when IndexedDB is unavailable; the store then
 * holds nothing and saves are dropped, which is today's full-load behaviour.
 */
export function createRevisionHistoryStore(
  openRecords: () => Promise<HistoryRecords | null>,
  scope: { readonly apiBaseUrl: string; readonly vaultId: string },
): RevisionHistoryStore {
  const metaKey = `${KEY_PREFIX}|${scope.vaultId}`;
  const segmentKey = (index: number): string => `${metaKey}|${index}`;

  const readMeta = async (records: HistoryRecords): Promise<Meta | null> => {
    const value = await records.getHistoryRecord(metaKey);
    if (!isRecord(value) || value.format !== FORMAT) return null;
    if (value.apiBaseUrl !== scope.apiBaseUrl || value.vaultId !== scope.vaultId) return null;
    if (value.epoch !== null && typeof value.epoch !== 'string') return null;
    if (!Number.isSafeInteger(value.cursor) || !Number.isSafeInteger(value.segments)) return null;
    return value as unknown as Meta;
  };

  const writeMeta = (records: HistoryRecords, epoch: string | null, cursor: number, segments: number): Promise<void> =>
    records.putHistoryRecord(metaKey, {
      format: FORMAT, apiBaseUrl: scope.apiBaseUrl, vaultId: scope.vaultId, epoch, cursor, segments,
    } satisfies Meta);

  return {
    async load(): Promise<StoredRevisionHistory | null> {
      const records = await openRecords();
      if (records === null) return null;
      const meta = await readMeta(records);
      if (meta === null || meta.segments < 0 || meta.segments > MAX_HISTORY_SEGMENTS) return null;
      const segments = await Promise.all(
        Array.from({ length: meta.segments }, (_, index) => records.getHistoryRecord(segmentKey(index))),
      );
      const events: RemoteEvent[] = [];
      for (const segment of segments) {
        if (!isRecord(segment) || segment.format !== FORMAT || segment.from !== events.length) return null;
        if (!Array.isArray(segment.events)) return null;
        events.push(...(segment.events as RemoteEvent[]));
      }
      // Event shapes and sequence numbers are validated by RevisionHistory.
      return events.length === meta.cursor ? { epoch: meta.epoch, cursor: meta.cursor, events } : null;
    },

    async save(history, persistedCursor): Promise<void> {
      const records = await openRecords();
      if (records === null) return;
      const meta = await readMeta(records);
      if (meta !== null && persistedCursor > 0 && meta.cursor === persistedCursor
        && meta.epoch === history.epoch && meta.segments < MAX_HISTORY_SEGMENTS) {
        await records.putHistoryRecord(segmentKey(meta.segments), {
          format: FORMAT, from: persistedCursor, events: history.events.slice(persistedCursor),
        });
        await writeMeta(records, history.epoch, history.cursor, meta.segments + 1);
        return;
      }
      await records.deleteHistoryRecord(metaKey);
      await records.putHistoryRecord(segmentKey(0), { format: FORMAT, from: 0, events: history.events.slice() });
      await writeMeta(records, history.epoch, history.cursor, 1);
      // Old segments are unreachable now; removing them only reclaims space.
      for (let index = 1; index < (meta?.segments ?? 0); index += 1) {
        await records.deleteHistoryRecord(segmentKey(index)).catch(() => undefined);
      }
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
