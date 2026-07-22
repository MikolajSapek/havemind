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
  /**
   * Wall-clock time the entry was enqueued (SND-01). Stamped by `enqueue` when a
   * caller omits it, so producers need not supply it. Drives the "N change(s)
   * waiting to send" signal: an item queued longer than the staleness threshold
   * means sends are stuck. A legacy blob without it parses to 0 (treated as old,
   * which is correct for an item that has been sitting since before the upgrade).
   */
  readonly enqueuedAt?: number;
}

/** An outbox item paired with its enqueue time, for the send-queue view (SND-01). */
export interface OutboxAge {
  readonly revisionId: string;
  readonly enqueuedAt: number;
}

/**
 * A dead-lettered revision: one the server permanently rejected (or a single
 * push that permanently failed). It is removed from the outbox so it can never
 * block other files, and kept here as a durable, surfaced record of the failure
 * rather than silently dropped.
 */
export interface QuarantinedRevision {
  readonly revisionId: string;
  readonly fileId: string;
  readonly reason: string;
}

export interface PersistedSyncState {
  readonly version: 1;
  readonly cursor: number;
  readonly outbox: readonly OutboxEnvelope[];
  readonly locallyAuthored: readonly string[];
  readonly deferred: readonly RemoteEvent[];
  /** Durable dead-letter list of revisions the server permanently rejected. */
  readonly quarantine: readonly QuarantinedRevision[];
  /** Durable fileId↔path map for files Havemind has materialized/synced. */
  readonly pathOwners: Readonly<Record<string, string>>;
  /**
   * Durable fileId→content-hash map of the last synced base for each file: the
   * on-disk content both peers are known to share after the last successful
   * apply. The overwrite guard compares the current on-disk content against this
   * base to detect a local divergence before writing an incoming revision
   * (rule 3: zero silent overwrites).
   */
  readonly baseHashes: Readonly<Record<string, string>>;
  /**
   * Durable fileId→base CONTENT map: the exact canonical text of the last synced
   * base (the same content `baseHashes` holds the hash of). It is the ANCESTOR
   * the three-way merge (MRG-01) needs on a divergence — the last content both
   * peers agreed on. The producer mapping's `content` cannot serve this role
   * because a local edit overwrites it with the LOCAL version, so the agreed base
   * is persisted here separately. Cost: one extra copy of each synced note's
   * text; negligible for a two-person markdown vault and needs no server change
   * (the alternative — fetching the base revision blob over the transport —
   * would need the base revision id and a reconstruction pass). Only markdown
   * bases are stored; a binary file never merges, so it records no base content.
   */
  readonly baseContents: Readonly<Record<string, string>>;
  /**
   * Durable revisionId→conflict-artifact-path map. A conflict copy's readable
   * name (MRG-02) embeds a wall-clock timestamp, so a re-delivered revision would
   * otherwise mint a fresh, differently-named copy on every retry — the exact
   * conflict-cascade this guards against. Recording the path the first time a
   * revision conflicts lets a re-delivery reuse it (idempotent overwrite) instead
   * of spawning duplicates.
   */
  readonly conflictArtifacts: Readonly<Record<string, string>>;
  /**
   * Durable revisionId→full-envelope map for quarantined sends (SND-01). When a
   * push is dead-lettered its envelope is removed from the outbox; stashing it
   * here lets the "Retry" affordance re-enqueue the exact same bytes through the
   * normal outbox machinery. Cleared when the item is requeued or discarded. Not
   * a parallel store — it lives in the same persisted blob as the quarantine.
   */
  readonly quarantinedEnvelopes: Readonly<Record<string, OutboxEnvelope>>;
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
  /** Wall clock for stamping outbox enqueue times (SND-01). Defaults to Date.now. */
  readonly now?: () => number;
}

const DEFAULT_MAX_LOCALLY_AUTHORED = 10_000;

function emptyState(): PersistedSyncState {
  return {
    version: 1,
    cursor: 0,
    outbox: [],
    locallyAuthored: [],
    deferred: [],
    quarantine: [],
    pathOwners: {},
    baseHashes: {},
    baseContents: {},
    conflictArtifacts: {},
    quarantinedEnvelopes: {},
  };
}

/**
 * Byte length of the payload a base64 string decodes to. The server measures the
 * decoded payload against its per-payload ceiling, so this is the effective size
 * that drives push batching — computed without `Buffer` so it also runs in the
 * browser-flavoured Obsidian runtime.
 */
function base64ByteLength(base64: string): number {
  const length = base64.length;
  if (length === 0) return 0;
  let padding = 0;
  if (base64.endsWith('==')) padding = 2;
  else if (base64.endsWith('=')) padding = 1;
  return Math.floor((length * 3) / 4) - padding;
}

export class DurableSyncState implements SyncStatePort {
  private readonly persist: SyncStatePersistPort;
  private readonly maxLocallyAuthored: number;
  private readonly now: () => number;
  private cache: PersistedSyncState | null = null;

  constructor(options: DurableSyncStateOptions) {
    this.persist = options.persist;
    this.maxLocallyAuthored =
      options.maxLocallyAuthored ?? DEFAULT_MAX_LOCALLY_AUTHORED;
    this.now = options.now ?? (() => Date.now());
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
      payloadBytes: base64ByteLength(envelope.payloadBase64),
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

  async quarantineOutboxItem(revisionId: string, reason: string): Promise<void> {
    const state = await this.ensureLoaded();
    const failed = state.outbox.find(
      (envelope) => envelope.revisionId === revisionId,
    );
    const outbox = state.outbox.filter(
      (envelope) => envelope.revisionId !== revisionId,
    );
    const entry: QuarantinedRevision = {
      revisionId,
      fileId: failed?.fileId ?? '',
      reason,
    };
    const quarantine = [
      ...state.quarantine.filter((item) => item.revisionId !== revisionId),
      entry,
    ];
    // Stash the full envelope (SND-01) so a later "Retry" can re-enqueue the
    // exact bytes; without it the dead-lettered payload is unrecoverable. Only
    // stashed when the outbox actually held the item — a quarantine with no
    // envelope simply carries no stash and its Retry is inert.
    const quarantinedEnvelopes = { ...state.quarantinedEnvelopes };
    if (failed !== undefined) {
      quarantinedEnvelopes[revisionId] = failed;
    }
    await this.mutate({ ...state, outbox, quarantine, quarantinedEnvelopes });
  }

  async listQuarantine(): Promise<readonly QuarantinedRevision[]> {
    return (await this.ensureLoaded()).quarantine;
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

  /**
   * Synchronous lookup of the last synced base content hash for a file against
   * the warmed cache, or null when Havemind has no recorded base yet. The vault
   * adapter uses this to detect whether the on-disk content has diverged from
   * the shared base before applying an incoming remote revision.
   */
  baseHashFor(fileId: string): string | null {
    return this.cache?.baseHashes[fileId] ?? null;
  }

  async recordBaseHash(fileId: string, hash: string): Promise<void> {
    const state = await this.ensureLoaded();
    await this.mutate({
      ...state,
      baseHashes: { ...state.baseHashes, [fileId]: hash },
    });
  }

  async forgetBaseHash(fileId: string): Promise<void> {
    const state = await this.ensureLoaded();
    if (!(fileId in state.baseHashes)) return;
    const baseHashes = { ...state.baseHashes };
    delete baseHashes[fileId];
    await this.mutate({ ...state, baseHashes });
  }

  /**
   * The exact base CONTENT for a file (the merge ancestor, MRG-01), or null when
   * none is recorded. Synchronous against the warmed cache, like `baseHashFor`.
   */
  baseContentFor(fileId: string): string | null {
    return this.cache?.baseContents[fileId] ?? null;
  }

  async recordBaseContent(fileId: string, content: string): Promise<void> {
    const state = await this.ensureLoaded();
    await this.mutate({
      ...state,
      baseContents: { ...state.baseContents, [fileId]: content },
    });
  }

  async forgetBaseContent(fileId: string): Promise<void> {
    const state = await this.ensureLoaded();
    if (!(fileId in state.baseContents)) return;
    const baseContents = { ...state.baseContents };
    delete baseContents[fileId];
    await this.mutate({ ...state, baseContents });
  }

  /**
   * The conflict-artifact path already written for `revisionId` (MRG-02
   * cascade guard), or null if this revision has not conflicted before.
   * Synchronous against the warmed cache.
   */
  conflictArtifactPathFor(revisionId: string): string | null {
    return this.cache?.conflictArtifacts[revisionId] ?? null;
  }

  async recordConflictArtifactPath(
    revisionId: string,
    path: string,
  ): Promise<void> {
    const state = await this.ensureLoaded();
    await this.mutate({
      ...state,
      conflictArtifacts: { ...state.conflictArtifacts, [revisionId]: path },
    });
  }

  async enqueue(envelope: OutboxEnvelope): Promise<void> {
    const state = await this.ensureLoaded();
    // Stamp the enqueue time when the caller omitted it, so the send-queue view
    // (SND-01) can age items without producers having to supply a clock.
    const stamped: OutboxEnvelope =
      envelope.enqueuedAt === undefined
        ? { ...envelope, enqueuedAt: this.now() }
        : envelope;
    const outbox = [
      ...state.outbox.filter((entry) => entry.revisionId !== envelope.revisionId),
      stamped,
    ];
    await this.mutate({ ...state, outbox });
  }

  /**
   * Outbox items paired with their enqueue time (SND-01), read synchronously
   * against the warm cache. A missing `enqueuedAt` (legacy blob) is reported as
   * 0 — "very old" — so a pre-upgrade item still counts as waiting. The runner
   * always warms the cache before it pushes, so the panel's synchronous read
   * finds a populated cache once connected; a cold cache reports no ages.
   */
  outboxAges(): readonly OutboxAge[] {
    return (this.cache?.outbox ?? []).map((envelope) => ({
      revisionId: envelope.revisionId,
      enqueuedAt: envelope.enqueuedAt ?? 0,
    }));
  }

  /** Synchronous quarantine snapshot against the warm cache (SND-01). */
  quarantineSnapshot(): readonly QuarantinedRevision[] {
    return this.cache?.quarantine ?? [];
  }

  /** The vault path a fileId currently owns (reverse of `fileIdAtPath`), or null. */
  pathForFileId(fileId: string): string | null {
    const owners = this.cache?.pathOwners ?? {};
    for (const [path, owner] of Object.entries(owners)) {
      if (owner === fileId) return path;
    }
    return null;
  }

  /**
   * Retry a quarantined send (SND-01): re-enqueue its stashed envelope through
   * the normal outbox machinery (fresh enqueue time), then drop it from the
   * quarantine and the stash. A no-op when nothing is stashed for `revisionId`
   * (already requeued or discarded), so a double click cannot double-enqueue.
   */
  async requeueQuarantined(revisionId: string): Promise<void> {
    const state = await this.ensureLoaded();
    const stashed = state.quarantinedEnvelopes[revisionId];
    if (stashed === undefined) return;
    const quarantinedEnvelopes = { ...state.quarantinedEnvelopes };
    delete quarantinedEnvelopes[revisionId];
    const outbox = [
      ...state.outbox.filter((entry) => entry.revisionId !== revisionId),
      { ...stashed, enqueuedAt: this.now() },
    ];
    const quarantine = state.quarantine.filter(
      (item) => item.revisionId !== revisionId,
    );
    await this.mutate({ ...state, outbox, quarantine, quarantinedEnvelopes });
  }

  /**
   * Permanently drop a quarantined send (SND-01): remove it from the quarantine
   * and forget its stashed envelope. Idempotent — dropping an unknown id is a
   * no-op.
   */
  async discardQuarantined(revisionId: string): Promise<void> {
    const state = await this.ensureLoaded();
    if (
      !state.quarantine.some((item) => item.revisionId === revisionId) &&
      state.quarantinedEnvelopes[revisionId] === undefined
    ) {
      return;
    }
    const quarantinedEnvelopes = { ...state.quarantinedEnvelopes };
    delete quarantinedEnvelopes[revisionId];
    const quarantine = state.quarantine.filter(
      (item) => item.revisionId !== revisionId,
    );
    await this.mutate({ ...state, quarantine, quarantinedEnvelopes });
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

  const baseHashes = parseStringMap(raw.baseHashes);
  if (baseHashes === null) return emptyState();

  const baseContents = parseStringMap(raw.baseContents);
  if (baseContents === null) return emptyState();

  const conflictArtifacts = parseStringMap(raw.conflictArtifacts);
  if (conflictArtifacts === null) return emptyState();

  const quarantine = parseQuarantine(raw.quarantine);
  if (quarantine === null) return emptyState();

  const quarantinedEnvelopes = parseEnvelopeMap(raw.quarantinedEnvelopes);
  if (quarantinedEnvelopes === null) return emptyState();

  return {
    version: 1,
    cursor: cursor as number,
    outbox: parsedOutbox,
    locallyAuthored: locallyAuthored as string[],
    deferred: parsedDeferred,
    quarantine,
    pathOwners,
    baseHashes,
    baseContents,
    conflictArtifacts,
    quarantinedEnvelopes,
  };
}

/** Parses an untrusted revisionId→envelope map; undefined (legacy) degrades to {}. */
function parseEnvelopeMap(
  value: unknown,
): Record<string, OutboxEnvelope> | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const result: Record<string, OutboxEnvelope> = {};
  for (const [key, entry] of Object.entries(value)) {
    const parsed = parseEnvelope(entry);
    if (parsed === null) return null;
    result[key] = parsed;
  }
  return result;
}

/** Parses an untrusted quarantine list; undefined (legacy blob) degrades to []. */
function parseQuarantine(value: unknown): QuarantinedRevision[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const result: QuarantinedRevision[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.revisionId !== 'string' ||
      typeof entry.fileId !== 'string' ||
      typeof entry.reason !== 'string'
    ) {
      return null;
    }
    result.push({
      revisionId: entry.revisionId,
      fileId: entry.fileId,
      reason: entry.reason,
    });
  }
  return result;
}

function parsePathOwners(
  value: unknown,
): Record<string, string> | null {
  return parseStringMap(value);
}

/** Parses an untrusted `Record<string, string>`; undefined degrades to empty. */
function parseStringMap(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') return null;
    result[key] = entry;
  }
  return result;
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
    // Preserve the enqueue time across a restart (SND-01); a non-number degrades
    // to "unstamped" so `outboxAges` treats it as old rather than throwing.
    ...(typeof value.enqueuedAt === 'number'
      ? { enqueuedAt: value.enqueuedAt }
      : {}),
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
