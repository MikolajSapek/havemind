/**
 * Durable client sync state backed by Obsidian's per-plugin `saveData`/`loadData`
 * (a single non-secret JSON blob in `data.json`). It implements the runner's
 * `SyncStatePort` and additionally owns the full outbox envelopes, the set of
 * locally authored revisions (echo suppression) and any deferred remote events.
 *
 * Refresh tokens and invitation secrets never live here — those stay in
 * Obsidian SecretStorage (see `storage/secret-store.ts` and
 * `plan/05-plugin-polaczenie-i-sync.md`). Only non-secret sync bookkeeping is
 * persisted through this port, so `data.json` never carries a credential.
 *
 * The persisted blob is treated as untrusted input: a malformed or partial blob
 * degrades to a clean empty state rather than throwing, so a corrupt file can
 * never wedge startup (rule: never trust external data).
 */

import type {
  PushReceipt,
  PushRevision,
  RemoteEvent,
  SyncStatePort,
} from '../sync/sync-runner';

/** The subset of an envelope the transport needs to reconstruct a push body. */
export interface TransportEnvelope {
  readonly header: unknown;
  readonly idempotencyKey: string;
  readonly payloadBase64: string;
}

/** A full outbox entry: runner-facing identity plus the bytes to ship. */
export interface OutboxEnvelope extends TransportEnvelope {
  readonly operationId: string;
  readonly revisionId: string;
  readonly fileId: string;
  readonly contentHash: string;
}

export interface PersistedSyncState {
  readonly version: 1;
  readonly cursor: number;
  readonly outbox: readonly OutboxEnvelope[];
  readonly locallyAuthored: readonly string[];
  readonly deferred: readonly RemoteEvent[];
  /** Durable fileId↔path map for files Havemind has materialized/synced. */
  readonly pathOwners: Readonly<Record<string, string>>;
}

/** Persistence boundary; wraps `Plugin.loadData`/`Plugin.saveData` in production. */
export interface SyncStatePersistPort {
  load(): Promise<unknown>;
  save(state: PersistedSyncState): Promise<void>;
}

export interface DurableSyncStateOptions {
  readonly persist: SyncStatePersistPort;
  /** Upper bound on remembered authored ids; oldest are pruned first. */
  readonly maxLocallyAuthored?: number;
}

const DEFAULT_MAX_LOCALLY_AUTHORED = 10_000;

function emptyState(): PersistedSyncState {
  return {
    version: 1,
    cursor: 0,
    outbox: [],
    locallyAuthored: [],
    deferred: [],
    pathOwners: {},
  };
}

export class DurableSyncState implements SyncStatePort {
  private readonly persist: SyncStatePersistPort;
  private readonly maxLocallyAuthored: number;
  private cache: PersistedSyncState | null = null;

  constructor(options: DurableSyncStateOptions) {
    this.persist = options.persist;
    this.maxLocallyAuthored =
      options.maxLocallyAuthored ?? DEFAULT_MAX_LOCALLY_AUTHORED;
  }

  async loadCursor(): Promise<number> {
    return (await this.ensureLoaded()).cursor;
  }

  async saveCursor(sequence: number): Promise<void> {
    const state = await this.ensureLoaded();
    await this.mutate({ ...state, cursor: sequence });
  }

  async listOutbox(): Promise<readonly PushRevision[]> {
    const state = await this.ensureLoaded();
    return state.outbox.map((envelope) => ({
      revisionId: envelope.revisionId,
      fileId: envelope.fileId,
      contentHash: envelope.contentHash,
    }));
  }

  async recordPushReceipt(receipt: PushReceipt): Promise<void> {
    const state = await this.ensureLoaded();
    const outbox = state.outbox.filter(
      (envelope) => envelope.revisionId !== receipt.revisionId,
    );
    await this.mutate({
      ...state,
      outbox,
      locallyAuthored: this.rememberAuthored(
        state.locallyAuthored,
        receipt.revisionId,
      ),
    });
  }

  async isLocallyAuthored(revisionId: string): Promise<boolean> {
    const state = await this.ensureLoaded();
    return state.locallyAuthored.includes(revisionId);
  }

  /**
   * Synchronous owner lookup against the warmed cache. Returns the fileId that
   * owns `path`, or null if Havemind has not materialized a file there. The
   * vault adapter uses this to update already-synced files in place while
   * routing genuine collisions (a foreign file at the path) to conflicts.
   */
  fileIdAtPath(path: string): string | null {
    return this.cache?.pathOwners[path] ?? null;
  }

  async recordPathOwner(fileId: string, path: string): Promise<void> {
    const state = await this.ensureLoaded();
    await this.mutate({
      ...state,
      pathOwners: { ...state.pathOwners, [path]: fileId },
    });
  }

  async forgetPath(path: string): Promise<void> {
    const state = await this.ensureLoaded();
    if (!(path in state.pathOwners)) return;
    const pathOwners = { ...state.pathOwners };
    delete pathOwners[path];
    await this.mutate({ ...state, pathOwners });
  }

  async enqueue(envelope: OutboxEnvelope): Promise<void> {
    const state = await this.ensureLoaded();
    const outbox = [
      ...state.outbox.filter((entry) => entry.revisionId !== envelope.revisionId),
      envelope,
    ];
    await this.mutate({ ...state, outbox });
  }

  async getEnvelope(revisionId: string): Promise<TransportEnvelope | undefined> {
    await this.ensureLoaded();
    return this.peekEnvelope(revisionId);
  }

  /**
   * Synchronous lookup against the warmed cache. The runner always awaits
   * `listOutbox` (which loads the cache) before it pushes, so the transport's
   * synchronous `resolveEnvelope` finds a warm cache by the time it runs.
   */
  peekEnvelope(revisionId: string): TransportEnvelope | undefined {
    const found = this.cache?.outbox.find(
      (envelope) => envelope.revisionId === revisionId,
    );
    if (found === undefined) return undefined;
    return {
      header: found.header,
      idempotencyKey: found.idempotencyKey,
      payloadBase64: found.payloadBase64,
    };
  }

  async listDeferred(): Promise<readonly RemoteEvent[]> {
    return (await this.ensureLoaded()).deferred;
  }

  async saveDeferred(events: readonly RemoteEvent[]): Promise<void> {
    const state = await this.ensureLoaded();
    await this.mutate({ ...state, deferred: [...events] });
  }

  private rememberAuthored(
    existing: readonly string[],
    revisionId: string,
  ): readonly string[] {
    if (existing.includes(revisionId)) return existing;
    const next = [...existing, revisionId];
    return next.length > this.maxLocallyAuthored
      ? next.slice(next.length - this.maxLocallyAuthored)
      : next;
  }

  private async ensureLoaded(): Promise<PersistedSyncState> {
    if (this.cache !== null) return this.cache;
    const raw = await this.persist.load();
    this.cache = parsePersistedState(raw);
    return this.cache;
  }

  private async mutate(next: PersistedSyncState): Promise<void> {
    this.cache = next;
    await this.persist.save(next);
  }
}

function parsePersistedState(raw: unknown): PersistedSyncState {
  if (!isRecord(raw) || raw.version !== 1) return emptyState();

  const cursor = raw.cursor;
  const outbox = raw.outbox;
  const locallyAuthored = raw.locallyAuthored;
  const deferred = raw.deferred;

  if (
    !Number.isSafeInteger(cursor) ||
    (cursor as number) < 0 ||
    !Array.isArray(outbox) ||
    !Array.isArray(locallyAuthored) ||
    !Array.isArray(deferred)
  ) {
    return emptyState();
  }

  const parsedOutbox: OutboxEnvelope[] = [];
  for (const entry of outbox) {
    const parsed = parseEnvelope(entry);
    if (parsed === null) return emptyState();
    parsedOutbox.push(parsed);
  }

  if (!locallyAuthored.every((value) => typeof value === 'string')) {
    return emptyState();
  }

  const parsedDeferred: RemoteEvent[] = [];
  for (const entry of deferred) {
    const parsed = parseRemoteEvent(entry);
    if (parsed === null) return emptyState();
    parsedDeferred.push(parsed);
  }

  const pathOwners = parsePathOwners(raw.pathOwners);
  if (pathOwners === null) return emptyState();

  return {
    version: 1,
    cursor: cursor as number,
    outbox: parsedOutbox,
    locallyAuthored: locallyAuthored as string[],
    deferred: parsedDeferred,
    pathOwners,
  };
}

function parsePathOwners(
  value: unknown,
): Record<string, string> | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const owners: Record<string, string> = {};
  for (const [path, fileId] of Object.entries(value)) {
    if (typeof fileId !== 'string') return null;
    owners[path] = fileId;
  }
  return owners;
}

function parseEnvelope(value: unknown): OutboxEnvelope | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.operationId !== 'string' ||
    typeof value.revisionId !== 'string' ||
    typeof value.fileId !== 'string' ||
    typeof value.contentHash !== 'string' ||
    typeof value.idempotencyKey !== 'string' ||
    typeof value.payloadBase64 !== 'string'
  ) {
    return null;
  }
  return {
    operationId: value.operationId,
    revisionId: value.revisionId,
    fileId: value.fileId,
    contentHash: value.contentHash,
    idempotencyKey: value.idempotencyKey,
    payloadBase64: value.payloadBase64,
    header: value.header,
  };
}

function parseRemoteEvent(value: unknown): RemoteEvent | null {
  if (!isRecord(value) || !Number.isSafeInteger(value.serverSequence)) {
    return null;
  }
  const revision = value.revision;
  if (
    !isRecord(revision) ||
    typeof revision.revisionId !== 'string' ||
    typeof revision.fileId !== 'string' ||
    typeof revision.contentHash !== 'string'
  ) {
    return null;
  }
  return {
    serverSequence: value.serverSequence as number,
    revision: {
      revisionId: revision.revisionId,
      fileId: revision.fileId,
      contentHash: revision.contentHash,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
