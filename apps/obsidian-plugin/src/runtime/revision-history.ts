import { decodeRevisionPayload, type DecodedRevisionPayload } from '@havemind/sync-core';
import type { RemoteEvent, SyncTransport } from '../sync/sync-runner';
import type { DurableSyncState } from './sync-state';

/**
 * Note payloads kept for reuse within a connection (P13). Merges read the
 * same few ancestors repeatedly; anything older is fetched again if needed.
 */
const MAX_CACHED_PAYLOADS = 200;

/** The accepted event log as persisted between connections (P13). */
export interface StoredRevisionHistory {
  /** The server epoch the log was read under, null when the server sends none. */
  readonly epoch: string | null;
  readonly cursor: number;
  /** Every accepted event, in order: `events[i].serverSequence === i + 1`. */
  readonly events: readonly RemoteEvent[];
}

/**
 * Where the accepted log survives a reconnect. `load` may return anything,
 * including garbage: {@link RevisionHistory} validates it and falls back to a
 * full load. `save` receives the whole log plus the cursor the store already
 * holds, so it can append only the tail.
 */
export interface RevisionHistoryStore {
  load(): Promise<unknown>;
  save(history: StoredRevisionHistory, persistedCursor: number): Promise<void>;
}

/** A revision-bound view of ancestry, reconstructed from the append-only event log.
 * Payloads are fetched lazily and verified by the connection resolver. No server
 * schema change or retained, unversioned "last common text" is needed.
 *
 * With a {@link RevisionHistoryStore}, the log read by one connection seeds the
 * next, which then pulls only what it has not seen (P13). The stored log is
 * trusted only after the server confirms it: the first pull overlaps the last
 * stored event, which must come back unchanged, under the same epoch.
 */
export class RevisionHistory {
  private readonly accepted = new Map<string, RemoteEvent>();
  private readonly ordered: RemoteEvent[] = [];
  private readonly payloads = new Map<string, DecodedRevisionPayload>();
  private cursor = 0;
  private epoch: string | null = null;
  private loaded = false;
  private loading: Promise<void> | null = null;
  private restoreAttempted = false;
  /** True while the in-memory log came from the store and is not yet confirmed. */
  private unconfirmed = false;
  private persistedCursor = 0;

  constructor(private readonly options: {
    transport: Pick<SyncTransport, 'pull'>;
    resolveRevision: (event: RemoteEvent) => Promise<DecodedRevisionPayload>;
    state: DurableSyncState;
    store?: RevisionHistoryStore;
  }) {}

  async refresh(): Promise<void> {
    if (this.loading !== null) return this.loading;
    this.loading = this.load();
    try { await this.loading; this.loaded = true; } finally { this.loading = null; }
  }

  private async load(): Promise<void> {
    if (!this.restoreAttempted) {
      this.restoreAttempted = true;
      await this.restore();
    }
    if (!this.unconfirmed) {
      await this.pullAll();
    } else {
      try {
        await this.pullAll();
      } catch (error) {
        // A restored server, a rewritten log, or simply no network: the stored
        // log is set aside and the full log read, as without a store. If that
        // fails too, the store is tried again on the next refresh.
        this.reset();
        try {
          await this.pullAll();
        } catch {
          this.reset();
          this.restoreAttempted = false;
          throw error;
        }
      }
    }
    await this.persist();
  }

  private async pullAll(): Promise<void> {
    let target: number | null = null;
    do {
      const anchor = this.unconfirmed ? this.ordered[this.cursor - 1] : undefined;
      const page = await this.options.transport.pull(anchor === undefined ? this.cursor : this.cursor - 1);
      const epoch = page.epoch ?? null;
      if (anchor !== undefined) {
        const first = page.events[0];
        if (page.cursor < this.cursor || epoch !== this.epoch || first === undefined
          || first.serverSequence !== anchor.serverSequence || !sameEvent(first, anchor)) {
          throw new Error('Stored revision history does not match the server.');
        }
        this.unconfirmed = false;
      }
      this.epoch = epoch;
      target ??= page.cursor;
      for (const event of page.events) {
        if (event.serverSequence <= this.cursor) continue;
        if (event.serverSequence !== this.cursor + 1) throw new Error('Revision history has a gap.');
        this.append(event);
      }
      if (page.events.length === 0 && this.cursor < target) throw new Error('Revision history is incomplete.');
    } while (this.cursor < target);
  }

  private append(event: RemoteEvent): void {
    this.accepted.set(event.revision.revisionId, event);
    this.ordered.push(event);
    this.cursor = event.serverSequence;
  }

  private reset(): void {
    this.accepted.clear();
    this.ordered.length = 0;
    this.cursor = 0;
    this.epoch = null;
    this.unconfirmed = false;
    this.persistedCursor = 0;
  }

  /** Seed the log from the store; anything that fails validation is ignored. */
  private async restore(): Promise<void> {
    const store = this.options.store;
    if (store === undefined) return;
    let stored: StoredRevisionHistory | null;
    try {
      stored = parseStoredHistory(await store.load());
    } catch {
      stored = null;
    }
    if (stored === null || stored.cursor === 0) return;
    for (const event of stored.events) this.append(event);
    this.epoch = stored.epoch;
    this.persistedCursor = stored.cursor;
    this.unconfirmed = true;
  }

  /** One store write per refresh that saw new events; a failure never fails sync. */
  private async persist(): Promise<void> {
    const store = this.options.store;
    if (store === undefined || this.persistedCursor === this.cursor) return;
    try {
      await store.save({ epoch: this.epoch, cursor: this.cursor, events: this.ordered }, this.persistedCursor);
      this.persistedCursor = this.cursor;
    } catch {
      // The store's contents are unknown now; rewrite it whole next time.
      this.persistedCursor = 0;
      console.warn('Havemind: could not save the revision history; the next connection reads it in full.');
    }
  }

  async graph(fileId: string): Promise<Map<string, RemoteEvent>> {
    if (!this.loaded) await this.refresh();
    const graph = new Map([...this.accepted].filter(([, event]) => event.revision.fileId === fileId));
    for (const queued of await this.options.state.listOutbox()) {
      if (queued.fileId !== fileId || graph.has(queued.revisionId)) continue;
      graph.set(queued.revisionId, { serverSequence: 0, revision: queued });
    }
    return graph;
  }

  /** A pull can receive a revision committed after the cycle snapshot. */
  async ensureEvent(event: RemoteEvent): Promise<void> {
    if (!this.accepted.has(event.revision.revisionId)) await this.refresh();
    if (!this.accepted.has(event.revision.revisionId)) throw new Error('Incoming revision is missing from history.');
  }

  async allHeads(): Promise<RemoteEvent[]> {
    if (!this.loaded) await this.refresh();
    const parents = new Set([...this.accepted.values()].flatMap((e) => e.revision.parentRevisionIds ?? []));
    return [...this.accepted.values()].filter((e) => !parents.has(e.revision.revisionId));
  }

  async heads(fileId: string): Promise<RemoteEvent[]> {
    if (!this.loaded) await this.refresh();
    const events = [...this.accepted.values()].filter((event) => event.revision.fileId === fileId);
    const parents = new Set(events.flatMap((event) => event.revision.parentRevisionIds ?? []));
    return events.filter((event) => !parents.has(event.revision.revisionId));
  }

  async payload(event: RemoteEvent): Promise<DecodedRevisionPayload> {
    const id = event.revision.revisionId;
    const cached = this.payloads.get(id);
    if (cached !== undefined) {
      // Refresh its place so the least recently used payload is evicted first.
      this.payloads.delete(id);
      this.payloads.set(id, cached);
      return cached;
    }
    const queued = await this.options.state.getEnvelope(id);
    const payload = queued === undefined
      ? await this.options.resolveRevision(event)
      : decodeRevisionPayload(Uint8Array.from(atob(queued.payloadBase64), (char) => char.charCodeAt(0)));
    // An attachment is never merged from here and can be megabytes: keeping
    // every one fetched made memory grow for the whole connection (P13).
    if (payload.kind === 'binary') return payload;
    this.payloads.set(id, payload);
    if (this.payloads.size > MAX_CACHED_PAYLOADS) {
      const oldest = this.payloads.keys().next().value;
      if (oldest !== undefined) this.payloads.delete(oldest);
    }
    return payload;
  }
}

function sameEvent(left: RemoteEvent, right: RemoteEvent): boolean {
  const a = left.revision;
  const b = right.revision;
  return a.revisionId === b.revisionId && a.fileId === b.fileId && a.contentHash === b.contentHash
    && JSON.stringify(a.parentRevisionIds ?? []) === JSON.stringify(b.parentRevisionIds ?? []);
}

/** The stored log, or null unless it is a complete, gap-free prefix of a log. */
function parseStoredHistory(value: unknown): StoredRevisionHistory | null {
  if (!isRecord(value) || !Array.isArray(value.events) || !Number.isSafeInteger(value.cursor)) return null;
  const epoch = value.epoch;
  if (epoch !== null && typeof epoch !== 'string') return null;
  if (value.events.length !== value.cursor) return null;
  const events: RemoteEvent[] = [];
  for (const [index, raw] of value.events.entries()) {
    const event = parseStoredEvent(raw);
    if (event === null || event.serverSequence !== index + 1) return null;
    events.push(event);
  }
  return { epoch, cursor: events.length, events };
}

function parseStoredEvent(raw: unknown): RemoteEvent | null {
  if (!isRecord(raw) || !Number.isSafeInteger(raw.serverSequence) || !isRecord(raw.revision)) return null;
  const { revisionId, fileId, contentHash, parentRevisionIds, authorMembershipId } = raw.revision;
  if (typeof revisionId !== 'string' || typeof fileId !== 'string' || typeof contentHash !== 'string') return null;
  if (parentRevisionIds !== undefined
    && !(Array.isArray(parentRevisionIds) && parentRevisionIds.every((id) => typeof id === 'string'))) return null;
  if (authorMembershipId !== undefined && typeof authorMembershipId !== 'string') return null;
  return {
    serverSequence: raw.serverSequence as number,
    revision: {
      revisionId, fileId, contentHash,
      ...(parentRevisionIds === undefined ? {} : { parentRevisionIds: parentRevisionIds as string[] }),
      ...(authorMembershipId === undefined ? {} : { authorMembershipId }),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function ancestors(graph: ReadonlyMap<string, RemoteEvent>, start: string): Set<string> {
  const result = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.pop() as string;
    if (result.has(id)) continue;
    result.add(id);
    queue.push(...(graph.get(id)?.revision.parentRevisionIds ?? []));
  }
  return result;
}

/** Multiple incomparable common ancestors need a virtual merge; fail closed. */
export function commonAncestor(graph: ReadonlyMap<string, RemoteEvent>, left: string, right: string): RemoteEvent | null {
  const leftAncestors = ancestors(graph, left);
  const common = [...ancestors(graph, right)].filter((id) => leftAncestors.has(id) && graph.has(id));
  const commonSet = new Set(common);
  const superseded = new Set(common.flatMap((id) => graph.get(id)?.revision.parentRevisionIds ?? []).filter((id) => commonSet.has(id)));
  const nearest = common.filter((id) => !superseded.has(id));
  return nearest.length === 1 ? graph.get(nearest[0] as string) ?? null : null;
}
