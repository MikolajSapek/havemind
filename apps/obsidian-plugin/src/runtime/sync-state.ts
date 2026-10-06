/**
 * Durable client sync state in Obsidian's `data.json` (one non-secret JSON blob
 * via `saveData`/`loadData`): the runner's `SyncStatePort` plus the full outbox
 * envelopes, locally authored revisions (echo suppression) and parked events.
 * Secrets never live here (Obsidian SecretStorage). The blob is untrusted input:
 * a malformed one degrades to a clean empty state, so it never wedges startup.
 */

import { mappingMetadata, validRecovery, type ProducerRecovery } from './producer-recovery';
import { parseProducerStateResult } from './adapters/producer-state';

import type { ProducerState } from '../sync/outbox-repository';
import type {
  PushReceipt,
  PushRevision,
  RemoteEvent,
  SyncStatePort,
} from '../sync/sync-runner';
import { isRecord } from './is-record';

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
  /** Enqueue time (SND-01), stamped if omitted; drives the "waiting to send" signal. */
  readonly enqueuedAt?: number;
  /**
   * Arch P1: the payload BYTES live in the {@link OutboxPayloadStore}, keyed by
   * `revisionId`, and `payloadBase64` is `''` on disk: a 25 MB attachment stays
   * out of `data.json`, which is re-serialised on every cursor save. In memory
   * the bytes are rehydrated (so `peekEnvelope` stays synchronous). Absent when
   * the bytes ARE inline (legacy or fallback).
   */
  readonly payloadExternalized?: boolean;
  /** When a reconciliation backup took this copy; it is dropped 7 days later. */
  readonly backedUpAt?: number;
}

/** Out-of-band store for large outbox payloads (arch P1); best-effort, else inline. */
export interface OutboxPayloadStore {
  /** Durably store `payloadBase64` under `revisionId` (overwrite on repeat). */
  putPayload(revisionId: string, payloadBase64: string): Promise<void>;
  /** The stored payload, or `undefined` when absent (a torn/missing state). */
  getPayload(revisionId: string): Promise<string | undefined>;
  /** Remove the payload; a no-op when absent. */
  deletePayload(revisionId: string): Promise<void>;
  /** Every stored `revisionId`, so a load can drop the ones nothing refers to. */
  listPayloadIds(): Promise<readonly string[]>;
}

/** Quarantine reason: outbox payload gone from the store (arch P1, fail-closed). */
export const PAYLOAD_MISSING_REASON = 'payload-missing';

/** An outbox item paired with its enqueue time, for the send-queue view (SND-01). */
export interface OutboxAge {
  readonly revisionId: string;
  readonly enqueuedAt: number;
}

/** A dead-lettered revision: out of the outbox, kept as a durable, visible record. */
export interface QuarantinedRevision {
  readonly revisionId: string;
  readonly fileId: string;
  readonly reason: string;
  /**
   * The dead revision's own parents: a later edit is parented on these, since the
   * server never saw it. Absent on rows written before it was recorded.
   */
  readonly parentRevisionIds?: readonly string[];
}

export interface PersistedSyncState {
  /**
   * A1: the producer's files (path, fileId, local hash) and heads, in the same
   * document as the queue and the bases, so one write covers all three. Absent
   * only in a file written before 1.6.0, which the load imports once.
   */
  readonly producer?: ProducerState;
  readonly producerRecovery?: readonly ProducerRecovery[];
  /** Envelopes a recovery discarded, inline, kept {@link BACKUP_RETENTION_MS}. */
  readonly reconciliationBackups?: Readonly<Record<string, readonly OutboxEnvelope[]>>;
  readonly version: 1;
  readonly cursor: number;
  readonly outbox: readonly OutboxEnvelope[];
  readonly locallyAuthored: readonly string[];
  readonly deferred: readonly RemoteEvent[];
  readonly quarantine: readonly QuarantinedRevision[];
  /** Durable fileId↔path map for files Havemind has materialized/synced. */
  readonly pathOwners: Readonly<Record<string, string>>;
  /** fileId→last synced base hash: the overwrite guard's reference (rule 3). */
  readonly baseHashes: Readonly<Record<string, string>>;
  /**
   * fileId→text of the last synced base (what `baseHashes` hashes): the merge
   * ANCESTOR (MRG-01). The producer mapping's `content` cannot serve, since a
   * local edit overwrites it. Markdown only: a binary never merges.
   */
  readonly baseContents: Readonly<Record<string, string>>;
  /** revisionId→conflict-copy path: a re-delivery reuses its copy (MRG-02). */
  readonly conflictArtifacts: Readonly<Record<string, string>>;
  /**
   * Conflict-copy path → the fileId it holds. A copy's name carries only the
   * note's file name, so the auto-sweep could mistake a same-named note in another
   * folder for its target. Absent for older copies (left to the modal).
   */
  readonly conflictCopyFileIds?: Readonly<Record<string, string>>;
  /** revisionId→envelope of quarantined sends; Retry re-sends them (SND-01). */
  readonly quarantinedEnvelopes: Readonly<Record<string, OutboxEnvelope>>;
}

/** Persistence boundary; wraps `Plugin.loadData`/`Plugin.saveData` in production. */
export interface SyncStatePersistPort {
  /** The current primary blob (null when absent, a normal first run). */
  load(): Promise<unknown>;
  /** Previous-good backup blob (GAP-1), or null; read only for a corrupt primary. */
  loadBackup(): Promise<unknown>;
  /**
   * Atomically persist `state` as the new primary, keeping the prior primary as
   * the single `.bak` (GAP-1): a torn write must never destroy the last good blob.
   */
  save(state: PersistedSyncState): Promise<void>;
  /**
   * Preserve a corrupt raw blob under a timestamped sidecar (GAP-1); an existing
   * sidecar is never clobbered. `timestamp` is the caller's (no clock in parse).
   */
  preserveCorrupt(raw: unknown, timestamp: number): Promise<void>;
  /**
   * A1: the producer state from its pre-1.6.0 key (null when there is none),
   * read once when the sync state carries no producer yet.
   */
  loadLegacyProducer?(): Promise<ProducerState | null>;
}

export interface DurableSyncStateOptions {
  readonly persist: SyncStatePersistPort;
  /** Optional out-of-band payload store (arch P1); without it payloads stay inline. */
  readonly payloadStore?: OutboxPayloadStore;
  /** Upper bound on remembered authored ids; oldest are pruned first. */
  readonly maxLocallyAuthored?: number;
  readonly now?: () => number;
  /** Stash byte budget (MAJOR 4); default {@link QUARANTINED_ENVELOPE_BUDGET_BYTES}. */
  readonly quarantinedEnvelopeBudgetBytes?: number;
  /**
   * False in production (A2): merges take their ancestor from the revision
   * history, so `baseContents` is neither kept nor written to data.json. Defaults
   * to true for harnesses without a revision history.
   */
  readonly keepBaseContents?: boolean;
}

const DEFAULT_MAX_LOCALLY_AUTHORED = 10_000;

/**
 * Total-bytes ceiling for stashed quarantine envelopes (MAJOR 4). A stash keeps
 * the full payload so "Retry" can re-send it, but with F9 attachments up to
 * 25 MB a run of rejected sends could grow `data.json` without bound. Past the
 * budget the OLDEST stashes are evicted; the quarantine ROW stays visible and
 * its Retry re-commits from disk (the truth), so nothing is silently dropped.
 */
export const QUARANTINED_ENVELOPE_BUDGET_BYTES = 5 * 1024 * 1024;

/**
 * Prefix of the synthetic revisionId `failed-to-queue:<path>` (SND-02), so
 * repeated failures for one file coalesce into one row. Exported for the retry
 * router (MAJOR 2): re-run the commit from disk vs re-enqueue a stashed envelope.
 */
export const FAILED_TO_QUEUE_PREFIX = 'failed-to-queue:';

export function failedToQueueRevisionId(path: string): string {
  return `${FAILED_TO_QUEUE_PREFIX}${path}`;
}

/**
 * The vault path a failed-to-queue revisionId encodes, or null for a real
 * (server-rejected) revision, which Retry routes through the normal requeue.
 */
export function parseFailedToQueuePath(revisionId: string): string | null {
  if (!revisionId.startsWith(FAILED_TO_QUEUE_PREFIX)) return null;
  const path = revisionId.slice(FAILED_TO_QUEUE_PREFIX.length);
  return path.length === 0 ? null : path;
}

const EMPTY_PRODUCER: ProducerState = { mappings: [], heads: {} };

/** `producer` with `record`'s files replaced by the ones it carries. */
function withProducerFiles(producer: ProducerState, record: ProducerRecovery): ProducerState {
  const ids = new Set(record.fileIds);
  return {
    mappings: [...producer.mappings.filter((m) => !ids.has(m.fileId)), ...record.state.mappings.map(mappingMetadata)],
    heads: { ...Object.fromEntries(Object.entries(producer.heads).filter(([id]) => !ids.has(id))), ...record.state.heads },
  };
}

/**
 * `state` with `record` applied forward: its files in the producer, each one's
 * owner moved to its path, a base seeded on first authorship only (a local edit
 * never advances the common ancestor, rule 3), a deleted file forgotten, and
 * the record itself gone from the journal.
 */
function rolledForward(state: PersistedSyncState, record: ProducerRecovery): PersistedSyncState {
  const pathOwners = { ...state.pathOwners };
  const baseHashes = { ...state.baseHashes };
  const baseContents = { ...state.baseContents };
  for (const fileId of record.fileIds) {
    const mapping = record.state.mappings.find((m) => m.fileId === fileId);
    for (const [path, owner] of Object.entries(pathOwners)) {
      if (owner === fileId && path !== mapping?.path) delete pathOwners[path];
    }
    if (mapping === undefined) {
      delete baseHashes[fileId];
      delete baseContents[fileId];
    } else {
      pathOwners[mapping.path] = fileId;
      baseHashes[fileId] ??= mapping.contentHash;
      if (mapping.contentKind !== 'binary' && mapping.content !== undefined && baseContents[fileId] === undefined &&
        baseHashes[fileId] === mapping.contentHash) baseContents[fileId] = mapping.content;
    }
  }
  return { ...state, pathOwners, baseHashes, baseContents,
    producer: withProducerFiles(state.producer ?? EMPTY_PRODUCER, record),
    producerRecovery: (state.producerRecovery ?? []).filter((r) => r.id !== record.id),
  };
}

/** The stored producer, or nothing when absent; unreadable degrades to empty. */
function parseProducerField(value: unknown): { producer?: ProducerState } {
  return value === undefined ? {} : { producer: parseProducerStateResult(value).state };
}

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
 * The DAG parent ids on an outbox envelope's (opaque) header. The header is
 * untrusted JSON, so a missing or malformed `parentRevisionIds` degrades to `[]`
 * (no dependency) rather than throwing and wedging the push cycle.
 */
function parentIdsFromHeader(header: unknown): readonly string[] {
  if (!isRecord(header)) return [];
  const ids = header.parentRevisionIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === 'string');
}

/**
 * Byte length a base64 string decodes to: the size the server measures against
 * its per-payload ceiling, so it drives push batching. Computed without
 * `Buffer` so it also runs in the browser-flavoured Obsidian runtime.
 */
function base64ByteLength(base64: string): number {
  const length = base64.length;
  if (length === 0) return 0;
  let padding = 0;
  if (base64.endsWith('==')) padding = 2;
  else if (base64.endsWith('=')) padding = 1;
  return Math.floor((length * 3) / 4) - padding;
}

/**
 * The synchronous accessors (`fileIdAtPath`, `baseHashFor`, `baseContentFor`,
 * `conflictArtifactPathFor`, `outboxAges`, `peekEnvelope`, the `*Snapshot`s) read
 * the WARMED cache: the runner awaits `listOutbox` before it pushes, so it is
 * warm by then, and a cold cache reports nothing.
 */
export class DurableSyncState implements SyncStatePort {
  private readonly persist: SyncStatePersistPort;
  private readonly maxLocallyAuthored: number;
  private readonly now: () => number;
  private readonly envelopeBudgetBytes: number;
  private readonly parkReasons = new Map<string, string>();
  /** Optional payload store (arch P1); without it payloads stay in `data.json`. */
  private readonly payloadStore: OutboxPayloadStore | undefined;
  private readonly keepBaseContents: boolean;
  /**
   * The outbox/stash `revisionId`s whose payload lives in the payload store (the
   * disk form strips their inline bytes). One absent keeps its bytes inline, so
   * bytes the store does not hold are never stripped.
   */
  private readonly externalized = new Set<string>();
  private cache: PersistedSyncState | null = null;
  /**
   * Set when a load could not fully recover the local queue (GAP-1, see
   * {@link hydrate}); the raw bytes are then in a sidecar. A purely OBSERVABLE
   * signal ({@link isRecoveryRequired}), never a save lock: the instance resumes
   * from a clean, writable state and rewrites the primary, so a restart never
   * re-locks. The UI can tell the user the queue needs recovery instead of
   * letting them assume it drained.
   */
  private recoveryRequired = false;
  /**
   * De-dupes concurrent cold-cache loads: otherwise the later `persist.load()`
   * re-parses the blob and clobbers a cache mutation the first caller made in
   * the meantime (an enqueued revision, an advanced cursor), a silent dropped
   * push at connect (rule 3). Callers share this one in-flight load.
   */
  private loadPromise: Promise<void> | null = null;
  /**
   * Serializes every read-modify-write section on the shared cache. On a WARM
   * cache two overlapping `ensureLoaded` + `mutate` sections capture the SAME
   * snapshot and the later one drops the earlier write. That once lost a file's
   * base CONTENT but kept its HASH, so the merge lost its ancestor and spawned a
   * SPURIOUS conflict copy (rule 3). The in-memory analogue of `PluginDataMutex`
   * (disk save only). Reads stay off the queue: `mutate` swaps the whole cache in
   * one synchronous assignment, so a read always sees a consistent snapshot.
   */
  private mutationTail: Promise<unknown> = Promise.resolve();

  constructor(options: DurableSyncStateOptions) {
    this.persist = options.persist;
    this.maxLocallyAuthored =
      options.maxLocallyAuthored ?? DEFAULT_MAX_LOCALLY_AUTHORED;
    this.now = options.now ?? (() => Date.now());
    this.envelopeBudgetBytes =
      options.quarantinedEnvelopeBudgetBytes ??
      QUARANTINED_ENVELOPE_BUDGET_BYTES;
    this.payloadStore = options.payloadStore;
    this.keepBaseContents = options.keepBaseContents ?? true;
  }

  /** `state` without base contents when they are not kept (A2). */
  private trimmed(state: PersistedSyncState): PersistedSyncState {
    return this.keepBaseContents || Object.keys(state.baseContents).length === 0
      ? state
      : { ...state, baseContents: {} };
  }

  /** Whether the last load could not fully recover the queue (GAP-1); a signal only. */
  isRecoveryRequired(): boolean {
    return this.recoveryRequired;
  }

  async pendingProducerRecoveries(): Promise<readonly ProducerRecovery[]> {
    return (await this.ensureLoaded()).producerRecovery ?? [];
  }

  async startProducerRecovery(record: ProducerRecovery, replacement?: OutboxEnvelope): Promise<boolean> {
    return this.runExclusive(async () => {
      const state = await this.ensureLoaded();
      const swapped = await this.swapQueue(state, record, replacement);
      if (swapped === null) return false;
      await this.mutate({ ...swapped,
        producerRecovery: [...(state.producerRecovery ?? []), record.kind === 'apply' ? {
          ...record,
          applyState: {
            pathOwners: Object.fromEntries(Object.entries(state.pathOwners).filter(([, id]) => record.fileIds.includes(id))),
            baseHashes: Object.fromEntries(Object.entries(state.baseHashes).filter(([id]) => record.fileIds.includes(id))),
            baseContents: Object.fromEntries(Object.entries(state.baseContents).filter(([id]) => record.fileIds.includes(id))),
          },
        } : record],
      });
      return true;
    });
  }

  /**
   * A1: a local commit or head resolution in ONE write: the queue swap, the
   * producer's file and head, and the owner and base the apply side reads. It
   * needs no journal entry, since there is no second write to recover from.
   */
  async commitProducerChange(record: ProducerRecovery, replacement?: OutboxEnvelope): Promise<boolean> {
    return this.runExclusive(async () => {
      const state = await this.ensureLoaded();
      const swapped = await this.swapQueue(state, record, replacement);
      if (swapped === null) return false;
      await this.mutate(rolledForward(swapped, record));
      return true;
    });
  }

  /**
   * The queue with `record`'s discarded revisions backed up and `replacement`
   * queued, its payload in the store when there is one (arch P1). Null when the
   * swap would lose or orphan queued work.
   */
  private async swapQueue(
    state: PersistedSyncState,
    record: ProducerRecovery,
    replacement: OutboxEnvelope | undefined,
  ): Promise<PersistedSyncState | null> {
    if ((state.producerRecovery ?? []).some((r) => r.fileIds.some((id) => record.fileIds.includes(id)))) {
      throw new Error('Producer recovery must finish before another transaction.');
    }
    const ids = new Set(record.discardRevisionIds);
    const originals = state.outbox.filter((e) => ids.has(e.revisionId));
    if (originals.length !== ids.size || this.hasUncoveredChildren(state, ids)) return null;
    if (replacement !== undefined && (ids.has(replacement.revisionId) ||
      parentIdsFromHeader(replacement.header).some((id) => ids.has(id)))) return null;
    if (replacement !== undefined) {
      if (await this.safePutPayload(replacement.revisionId, replacement.payloadBase64)) {
        this.externalized.add(replacement.revisionId);
      } else {
        this.externalized.delete(replacement.revisionId);
      }
    }
    return { ...state,
      outbox: [...state.outbox.filter((e) => !ids.has(e.revisionId)), ...(replacement === undefined ? [] : [{ ...replacement, enqueuedAt: this.now() }])],
      ...(originals.length === 0 ? {} : { reconciliationBackups: { ...state.reconciliationBackups, [record.id]: this.backedUp(originals) } }),
    };
  }

  /** The producer's files and heads (A1); empty before the first commit. */
  async loadProducer(): Promise<ProducerState> {
    return (await this.ensureLoaded()).producer ?? EMPTY_PRODUCER;
  }

  async saveProducer(producer: ProducerState): Promise<void> {
    await this.runExclusive(async () => {
      const state = await this.ensureLoaded();
      await this.mutate({ ...state, producer });
    });
  }

  /**
   * A1, part of the load. Keeps the bytes of an unreadable stored producer in a
   * sidecar (GAP-3). When the loaded state has no producer, it takes the one
   * the raw primary still carries (a `.bak` or an empty state replaced a
   * corrupt primary, and right after the upgrade the `.bak` predates the
   * producer), else imports the pre-1.6.0 key once. The save that carries it
   * is the one that drops the old key.
   */
  private async settleProducer(raw: unknown): Promise<void> {
    const stored = isRecord(raw) ? raw.producer : undefined;
    const parsed = stored === undefined ? null : parseProducerStateResult(stored);
    if (parsed?.status === 'corrupt') {
      await this.persist.preserveCorrupt({ producer: stored }, this.now());
    } else if (parsed !== null && parsed.quarantinedMappings.length > 0) {
      await this.persist.preserveCorrupt({ producer: { mappings: parsed.quarantinedMappings } }, this.now());
    }
    const state = this.cache;
    if (state === null || state.producer !== undefined) return;
    const producer = parsed?.status === 'ok'
      ? parsed.state
      : this.persist.loadLegacyProducer === undefined ? undefined : (await this.persist.loadLegacyProducer()) ?? EMPTY_PRODUCER;
    if (producer === undefined) return;
    const next = { ...state, producer };
    await this.persist.save(this.toDiskForm(next));
    this.cache = next;
  }

  /** Inline copies for a reconciliation backup, stamped for the 7-day prune. */
  private backedUp(envelopes: readonly OutboxEnvelope[]): OutboxEnvelope[] {
    const backedUpAt = this.now();
    return envelopes.map((e) => ({ ...e, payloadExternalized: false, backedUpAt }));
  }

  private hasUncoveredChildren(state: PersistedSyncState, ids: ReadonlySet<string>): boolean {
    return [...state.outbox, ...Object.values(state.quarantinedEnvelopes)].some((e) =>
      !ids.has(e.revisionId) && parentIdsFromHeader(e.header).some((id) => ids.has(id)));
  }

  /**
   * Finishes an interrupted journal entry in one write and drops it: a
   * 'resolution' (only written before 1.6.0) rolls forward, an 'apply' rolls
   * the producer, owners and bases back to its snapshot and drops what it
   * queued.
   */
  async recoverProducerQueue(id: string): Promise<void> {
    await this.runExclusive(async () => {
      const state = await this.ensureLoaded();
      const record = state.producerRecovery?.find((r) => r.id === id);
      if (record === undefined) return;
      if (record.kind === 'resolution') {
        await this.mutate(rolledForward(state, record));
        return;
      }
      const ids = new Set(record.discardRevisionIds);
      if (this.hasUncoveredChildren(state, ids)) throw new Error('Recovery would orphan pending work.');
      const originals = state.outbox.filter((e) => ids.has(e.revisionId));
      const undo = record.applyState;
      const other = (fileId: string): boolean => !record.fileIds.includes(fileId);
      await this.mutate({ ...state,
        ...(undo === undefined ? {} : {
          pathOwners: { ...Object.fromEntries(Object.entries(state.pathOwners).filter(([, fileId]) => other(fileId))), ...undo.pathOwners },
          baseHashes: { ...Object.fromEntries(Object.entries(state.baseHashes).filter(([fileId]) => other(fileId))), ...undo.baseHashes },
          baseContents: { ...Object.fromEntries(Object.entries(state.baseContents).filter(([fileId]) => other(fileId))), ...undo.baseContents },
        }),
        producer: withProducerFiles(state.producer ?? EMPTY_PRODUCER, record),
        producerRecovery: (state.producerRecovery ?? []).filter((r) => r.id !== id),
        outbox: state.outbox.filter((e) => !ids.has(e.revisionId)),
        ...(originals.length === 0 ? {} : { reconciliationBackups: { ...state.reconciliationBackups,
          [id]: [...(state.reconciliationBackups?.[id] ?? []), ...this.backedUp(originals)] } }),
      });
    });
  }

  async completeProducerRecovery(id: string): Promise<void> {
    await this.runExclusive(async () => {
      const state = await this.ensureLoaded();
      await this.mutate({ ...state, producerRecovery: (state.producerRecovery ?? []).filter((r) => r.id !== id) });
    });
  }

  async enqueueAutomaticMerge(envelope: OutboxEnvelope): Promise<void> {
    await this.runExclusive(async () => {
      const state = await this.ensureLoaded();
      const record = state.producerRecovery?.find((r) => r.kind === 'apply' && r.fileIds.includes(envelope.fileId));
      if (record === undefined) throw new Error('Automatic merge requires a durable apply transaction.');
      await this.mutate({ ...state,
        outbox: [...state.outbox, { ...envelope, enqueuedAt: this.now() }],
        producerRecovery: state.producerRecovery?.map((r) => r.id === record.id
          ? { ...r, discardRevisionIds: [...r.discardRevisionIds, envelope.revisionId] } : r) ?? [],
      });
    });
  }

  async loadCursor(): Promise<number> {
    return (await this.ensureLoaded()).cursor;
  }

  async saveCursor(sequence: number): Promise<void> {
    return this.runExclusive(async () => {
      const state = await this.ensureLoaded();
      await this.mutate({ ...state, cursor: sequence });
    });
  }

  async listOutbox(): Promise<readonly PushRevision[]> {
    const state = await this.ensureLoaded();
    return state.outbox.map((envelope) => {
      const parentRevisionIds = parentIdsFromHeader(envelope.header);
      return {
        revisionId: envelope.revisionId,
        fileId: envelope.fileId,
        contentHash: envelope.contentHash,
        payloadBytes: base64ByteLength(envelope.payloadBase64),
        // Omitted when empty, so a root create carries no dependency.
        ...(parentRevisionIds.length > 0 ? { parentRevisionIds } : {}),
      };
    });
  }

  /**
   * Two peers can independently publish byte-identical merges of the same heads.
   * The server accepts one and rejects the other with HEAD_SET_CHANGED. After
   * applying the accepted merge, discard only a redundant leaf in our queue.
   * Never claim the rejected ID was accepted, and never orphan a queued child.
   */
  async retireEquivalentMerges(event: RemoteEvent): Promise<void> {
    const remoteParents = event.revision.parentRevisionIds ?? [];
    if (remoteParents.length < 2) return;
    await this.runExclusive(async () => {
      const state = await this.ensureLoaded();
      const dependentParents = new Set([...state.outbox, ...Object.values(state.quarantinedEnvelopes)]
        .flatMap((entry) => parentIdsFromHeader(entry.header)));
      const retired = state.outbox.filter((entry) => {
        const parents = parentIdsFromHeader(entry.header);
        return entry.fileId === event.revision.fileId &&
          entry.contentHash === event.revision.contentHash &&
          parents.length >= 2 && parents.every((id) => remoteParents.includes(id)) &&
          !dependentParents.has(entry.revisionId);
      });
      if (retired.length === 0) return;
      const ids = new Set(retired.map((entry) => entry.revisionId));
      // No backup: the server holds the same text. An inline copy cost ~2x the
      // note on every later save, forever. The S1 sweep drops the stored bytes.
      await this.mutate({ ...state, outbox: state.outbox.filter((entry) => !ids.has(entry.revisionId)) });
    });
  }

  async recordPushReceipt(receipt: PushReceipt): Promise<void> {
    return this.runExclusive(async () => {
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
      // Arch P1: on the server now, so free its externalized payload (no leak).
      await this.dropPayload(receipt.revisionId);
    });
  }

  async quarantineOutboxItem(revisionId: string, reason: string): Promise<void> {
    return this.runExclusive(async () => {
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
        ...(failed === undefined
          ? {}
          : { parentRevisionIds: parentIdsFromHeader(failed.header) }),
      };
      const quarantine = [
        ...state.quarantine.filter((item) => item.revisionId !== revisionId),
        entry,
      ];
      // Stash the full envelope (SND-01) so "Retry" can re-enqueue the exact
      // bytes. Only when the outbox held the item: a quarantine without an
      // envelope carries no stash and its Retry is inert.
      const quarantinedEnvelopes = { ...state.quarantinedEnvelopes };
      if (failed !== undefined) {
        quarantinedEnvelopes[revisionId] = failed;
      }
      // MAJOR 4: hold the stash under the byte budget, evicting the oldest first;
      // the quarantine rows stay, and their Retry degrades to a re-commit.
      const budgeted = this.evictStashesOverBudget(quarantinedEnvelopes);
      // Arch P1: an evicted stash no longer needs its externalized payload.
      for (const evictedId of Object.keys(quarantinedEnvelopes)) {
        if (!(evictedId in budgeted)) {
          await this.dropPayload(evictedId);
        }
      }
      await this.mutate({
        ...state,
        outbox,
        quarantine,
        quarantinedEnvelopes: budgeted,
      });
    });
  }

  /**
   * A copy of `envelopes` trimmed to the byte budget (MAJOR 4) by evicting the
   * OLDEST first (key order is insertion order); one larger than the whole budget
   * goes too, and its row survives with Retry re-committing from disk.
   */
  private evictStashesOverBudget(
    envelopes: Record<string, OutboxEnvelope>,
  ): Record<string, OutboxEnvelope> {
    const entries = Object.entries(envelopes);
    let total = entries.reduce(
      (sum, [, env]) => sum + base64ByteLength(env.payloadBase64),
      0,
    );
    if (total <= this.envelopeBudgetBytes) return envelopes;
    const trimmed = { ...envelopes };
    for (const [key, env] of entries) {
      if (total <= this.envelopeBudgetBytes) break;
      total -= base64ByteLength(env.payloadBase64);
      delete trimmed[key];
    }
    return trimmed;
  }

  /**
   * Record a durable "failed to queue" entry (SND-02): a local change whose
   * commit-path enqueue permanently failed, so it has no envelope to retry. It
   * reuses the SND-01 quarantine, keyed by a path-derived synthetic revisionId
   * (see {@link failedToQueueRevisionId}) so repeats coalesce into one row. Retry
   * differs from a rejected send: with no stashed envelope `requeueQuarantined`
   * is inert, so the caller re-triggers the commit from disk (MAJOR 2, see
   * {@link parseFailedToQueuePath}); disk is the truth.
   */
  async recordFailedToQueue(path: string): Promise<void> {
    return this.runExclusive(async () => {
      const state = await this.ensureLoaded();
      const revisionId = failedToQueueRevisionId(path);
      const entry: QuarantinedRevision = {
        revisionId,
        fileId: path,
        reason: 'failed-to-queue',
      };
      const quarantine = [
        ...state.quarantine.filter((item) => item.revisionId !== revisionId),
        entry,
      ];
      await this.mutate({ ...state, quarantine });
    });
  }

  /**
   * The parents of a quarantined revision, or undefined when `revisionId` is
   * not quarantined or its parents were never recorded (a legacy row whose
   * stash was evicted). The producer walks past a quarantined head with this.
   */
  async quarantinedParents(revisionId: string): Promise<readonly string[] | undefined> {
    const state = await this.ensureLoaded();
    const row = state.quarantine.find((item) => item.revisionId === revisionId);
    if (row === undefined) return undefined;
    if (row.parentRevisionIds !== undefined) return row.parentRevisionIds;
    const stashed = state.quarantinedEnvelopes[revisionId];
    return stashed === undefined ? undefined : parentIdsFromHeader(stashed.header);
  }

  /** Includes unsent authored revisions: tells local work from a history replay. */
  async hasAuthoredRevision(revisionId: string): Promise<boolean> {
    const state = await this.ensureLoaded();
    return state.locallyAuthored.includes(revisionId) ||
      state.outbox.some((entry) => entry.revisionId === revisionId);
  }

  async isLocallyAuthored(revisionId: string): Promise<boolean> {
    const state = await this.ensureLoaded();
    return state.locallyAuthored.includes(revisionId);
  }

  /**
   * The fileId that owns `path`, or null. Lets the vault adapter update synced
   * files in place and route a foreign file at the path to a conflict.
   */
  fileIdAtPath(path: string): string | null {
    return this.cache?.pathOwners[path] ?? null;
  }

  /**
   * Records an applied revision: `fileId` owns `path`, with base `hash` and,
   * for markdown, base `content`. One write instead of three (P1), and never a
   * half-recorded base after a crash between them.
   */
  async recordApplied(
    fileId: string,
    path: string,
    hash: string,
    content: string | null,
  ): Promise<void> {
    return this.runExclusive(async () => {
      const state = await this.ensureLoaded();
      await this.mutate({
        ...state,
        pathOwners: { ...state.pathOwners, [path]: fileId },
        baseHashes: { ...state.baseHashes, [fileId]: hash },
        ...(content === null
          ? {}
          : { baseContents: { ...state.baseContents, [fileId]: content } }),
      });
    });
  }

  async recordPathOwner(fileId: string, path: string): Promise<void> {
    return this.runExclusive(async () => {
      const state = await this.ensureLoaded();
      await this.mutate({
        ...state,
        pathOwners: { ...state.pathOwners, [path]: fileId },
      });
    });
  }

  async forgetPath(path: string): Promise<void> {
    return this.runExclusive(async () => {
      const state = await this.ensureLoaded();
      if (!(path in state.pathOwners)) return;
      const pathOwners = { ...state.pathOwners };
      delete pathOwners[path];
      await this.mutate({ ...state, pathOwners });
    });
  }

  baseHashFor(fileId: string): string | null {
    return this.cache?.baseHashes[fileId] ?? null;
  }

  async recordBaseHash(fileId: string, hash: string): Promise<void> {
    return this.runExclusive(async () => {
      const state = await this.ensureLoaded();
      await this.mutate({
        ...state,
        baseHashes: { ...state.baseHashes, [fileId]: hash },
      });
    });
  }

  async forgetBaseHash(fileId: string): Promise<void> {
    return this.runExclusive(async () => {
      const state = await this.ensureLoaded();
      if (!(fileId in state.baseHashes)) return;
      const baseHashes = { ...state.baseHashes };
      delete baseHashes[fileId];
      await this.mutate({ ...state, baseHashes });
    });
  }

  baseContentFor(fileId: string): string | null {
    return this.cache?.baseContents[fileId] ?? null;
  }

  async recordBaseContent(fileId: string, content: string): Promise<void> {
    return this.runExclusive(async () => {
      const state = await this.ensureLoaded();
      await this.mutate({
        ...state,
        baseContents: { ...state.baseContents, [fileId]: content },
      });
    });
  }

  async forgetBaseContent(fileId: string): Promise<void> {
    return this.runExclusive(async () => {
      const state = await this.ensureLoaded();
      if (!(fileId in state.baseContents)) return;
      const baseContents = { ...state.baseContents };
      delete baseContents[fileId];
      await this.mutate({ ...state, baseContents });
    });
  }

  conflictArtifactPathFor(revisionId: string): string | null {
    return this.cache?.conflictArtifacts[revisionId] ?? null;
  }

  async recordConflictArtifactPath(
    revisionId: string,
    path: string,
    fileId?: string,
  ): Promise<void> {
    return this.runExclusive(async () => {
      const state = await this.ensureLoaded();
      await this.mutate({
        ...state,
        conflictArtifacts: { ...state.conflictArtifacts, [revisionId]: path },
        ...(fileId === undefined
          ? {}
          : {
              conflictCopyFileIds: {
                ...state.conflictCopyFileIds,
                [path]: fileId,
              },
            }),
      });
    });
  }

  revisionForConflictCopy(path: string): string | null {
    for (const [revisionId, copyPath] of Object.entries(this.cache?.conflictArtifacts ?? {})) {
      if (copyPath === path) return revisionId;
    }
    return null;
  }

  fileIdForConflictCopy(path: string): string | null {
    return this.cache?.conflictCopyFileIds?.[path] ?? null;
  }

  async enqueue(envelope: OutboxEnvelope): Promise<void> {
    return this.runExclusive(async () => {
      const state = await this.ensureLoaded();
      const stamped: OutboxEnvelope =
        envelope.enqueuedAt === undefined
          ? { ...envelope, enqueuedAt: this.now() }
          : envelope;
      // Arch P1: mirror the bytes into the store before the save (so the disk form
      // strips them); on a store failure keep them inline.
      if (await this.safePutPayload(stamped.revisionId, stamped.payloadBase64)) {
        this.externalized.add(stamped.revisionId);
      } else {
        this.externalized.delete(stamped.revisionId);
      }
      const outbox = [
        ...state.outbox.filter(
          (entry) => entry.revisionId !== envelope.revisionId,
        ),
        stamped,
      ];
      await this.mutate({ ...state, outbox });
    });
  }

  /** Outbox items with enqueue time (SND-01); a missing one reads as 0, "very old". */
  outboxAges(): readonly OutboxAge[] {
    return (this.cache?.outbox ?? []).map((envelope) => ({
      revisionId: envelope.revisionId,
      enqueuedAt: envelope.enqueuedAt ?? 0,
    }));
  }

  quarantineSnapshot(): readonly QuarantinedRevision[] {
    return this.cache?.quarantine ?? [];
  }

  pathForFileId(fileId: string): string | null {
    const owners = this.cache?.pathOwners ?? {};
    for (const [path, owner] of Object.entries(owners)) {
      if (owner === fileId) return path;
    }
    return null;
  }

  /**
   * Retry a quarantined send (SND-01): re-enqueue its stashed envelope. False
   * when nothing is stashed (already requeued or discarded, or evicted under the
   * budget, MAJOR 4): the row stays so the caller can re-commit from disk, and a
   * double click cannot double-enqueue.
   */
  async requeueQuarantined(revisionId: string): Promise<boolean> {
    return this.runExclusive(async () => {
      const state = await this.ensureLoaded();
      const stashed = state.quarantinedEnvelopes[revisionId];
      if (stashed === undefined) return false;
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
      return true;
    });
  }

  /** Permanently drop a quarantined send (SND-01) and its stash. Idempotent. */
  async discardQuarantined(revisionId: string): Promise<void> {
    return this.runExclusive(async () => {
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
      // Arch P1: discarded for good, so free the payload (no leak in the store).
      await this.dropPayload(revisionId);
    });
  }

  async getEnvelope(revisionId: string): Promise<TransportEnvelope | undefined> {
    await this.ensureLoaded();
    return this.peekEnvelope(revisionId);
  }

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

  /**
   * Incoming changes this device could not apply, set aside so the rest of the
   * vault keeps syncing (B2). Persisted in the `deferred` field; the failure
   * reason is kept for this session only.
   */
  async listParkedRemote(): Promise<readonly RemoteEvent[]> {
    return (await this.ensureLoaded()).deferred;
  }

  async parkRemote(event: RemoteEvent, reason: string): Promise<void> {
    this.parkReasons.set(event.revision.revisionId, reason);
    return this.runExclusive(async () => {
      const state = await this.ensureLoaded();
      const others = state.deferred.filter(
        (item) => item.revision.revisionId !== event.revision.revisionId,
      );
      await this.mutate({ ...state, deferred: [...others, event] });
    });
  }

  async unparkRemote(revisionId: string): Promise<void> {
    this.parkReasons.delete(revisionId);
    return this.runExclusive(async () => {
      const state = await this.ensureLoaded();
      await this.mutate({
        ...state,
        deferred: state.deferred.filter((item) => item.revision.revisionId !== revisionId),
      });
    });
  }

  parkedSnapshot(): readonly { revisionId: string; fileId: string; reason: string }[] {
    return (this.cache?.deferred ?? []).map((event) => ({
      revisionId: event.revision.revisionId,
      fileId: event.revision.fileId,
      reason:
        this.parkReasons.get(event.revision.revisionId) ??
        'This device could not apply this change.',
    }));
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
    // The cache is set before the load finishes reading stored payloads. A
    // change made in that window was lost when the load swapped its own copy
    // in, so every caller waits for the whole load.
    if (this.cache !== null && this.loadPromise === null) return this.cache;
    if (this.loadPromise === null) {
      this.loadPromise = this.persist
        .load()
        .then(async (raw) => {
          const clean = await this.hydrate(raw);
          await this.settleProducer(raw);
          return clean;
        })
        // Arch P1: once the cache is settled (GAP-1 recovery included), reconcile
        // payloads with the store; part of the shared in-flight load, so every
        // concurrent caller sees a settled cache.
        .then((clean) => this.reconcilePayloads(clean))
        .finally(() => {
          this.loadPromise = null;
        });
    }
    await this.loadPromise;
    if (this.cache === null) this.cache = emptyState();
    return this.cache;
  }

  /**
   * Parse the loaded primary blob into the cache (GAP-1 fail-closed policy).
   * Never clobber a cache that a mutation populated while the load was in
   * flight: re-check `this.cache === null` before each assignment.
   *  - ABSENT: a clean first run, empty writable state.
   *  - OK: the parsed state (bad outbox envelopes quarantined, not nuked).
   *  - CORRUPT (a core field failed): recover from a valid `.bak`; without one,
   *    SALVAGE a readable outbox (keep the queue and authored ids, default the
   *    damaged fields, write the CLEANED state back, no recovery flag) or, when
   *    the queue itself is unreadable (UNRECOVERABLE), resume empty and set the
   *    recovery signal. Either way the raw blob goes to a sidecar and the
   *    primary is rewritten, so a restart never re-locks.
   * Returns true when the primary loaded as saved, so stored payloads it does not
   * refer to are orphans, not evidence for the preserved copy.
   */
  private async hydrate(raw: unknown): Promise<boolean> {
    if (this.cache !== null) return false;
    if (isRecord(raw) && !validRecoveryFields(raw)) {
      await this.persist.preserveCorrupt(raw, this.now());
      throw new Error('Invalid producer recovery journal; sync is paused with original state preserved.');
    }
    const outcome = parsePersistedState(raw);
    if (outcome.status !== 'corrupt') {
      if (this.cache === null) this.cache = this.trimmed(outcome.state);
      return true;
    }

    if (isRecord(raw) && (raw.producerRecovery !== undefined || raw.reconciliationBackups !== undefined)) {
      await this.persist.preserveCorrupt(raw, this.now());
      throw new Error('Corrupt sync state includes recovery data; original state preserved.');
    }
    const backup = await this.persist.loadBackup();
    if (this.cache !== null) return false;
    const backupOutcome = parsePersistedState(backup);
    if (backupOutcome.status === 'ok') {
      // Recover from the intact snapshot, but still stash the corrupt primary.
      await this.persist.preserveCorrupt(raw, this.now());
      if (this.cache === null) {
        this.cache = this.trimmed(backupOutcome.state);
        // `.bak` is one generation behind the primary. If the primary's outbox held
        // newer revisions, this branch still prefers the consistent backup (never
        // auto-merge: riskier) and sets the recovery signal: the queue was rewound
        // and the richer salvage sits in the sidecar, not silently lost.
        if (salvageHasOutboxEntriesMissingFrom(outcome.salvage, backupOutcome.state.outbox)) {
          this.recoveryRequired = true;
        }
      }
      return false;
    }

    // No usable backup: preserve the unparseable bytes to a sidecar, then recover
    // forward, never wedge, rewriting the primary so a restart re-reads 'ok'.
    await this.persist.preserveCorrupt(raw, this.now());
    if (this.cache !== null) return false;
    if (outcome.salvage !== null) {
      // SALVAGE: the outbox was readable (damaged fields already defaulted).
      this.cache = this.trimmed(outcome.salvage);
    } else {
      // UNRECOVERABLE queue: resume empty; the unsent revisions live on in the sidecar.
      this.cache = emptyState();
      if (outcome.outboxAtRisk) this.recoveryRequired = true;
    }
    // `externalized` is still empty here (reconcilePayloads runs later): a passthrough.
    await this.persist.save(this.toDiskForm(this.cache));
    return false;
  }

  private async mutate(next: PersistedSyncState): Promise<void> {
    // Arch P1: persist the DISK form (payloads held by the store are stripped to
    // a reference, keeping `data.json` small); the cache keeps the full payloads.
    const kept = this.trimmed(next);
    await this.persist.save(this.toDiskForm(kept));
    this.cache = kept;
  }

  /**
   * Arch P1: the on-disk projection of `state`. Envelopes whose `revisionId` is in
   * {@link externalized} (the store holds their bytes) become `payloadBase64: ''`
   * plus `payloadExternalized: true`; all others stay inline. Returns `state`
   * itself when nothing is externalized.
   */
  private toDiskForm(state: PersistedSyncState): PersistedSyncState {
    if (this.externalized.size === 0) return state;
    const strip = (env: OutboxEnvelope): OutboxEnvelope =>
      this.externalized.has(env.revisionId)
        ? { ...env, payloadBase64: '', payloadExternalized: true }
        : env;
    const quarantinedEnvelopes: Record<string, OutboxEnvelope> = {};
    for (const [key, env] of Object.entries(state.quarantinedEnvelopes)) {
      quarantinedEnvelopes[key] = strip(env);
    }
    return {
      ...state,
      outbox: state.outbox.map(strip),
      quarantinedEnvelopes,
    };
  }

  /** Fallible payload-store read: undefined on absence OR any store failure. */
  private async safeGetPayload(revisionId: string): Promise<string | undefined> {
    if (this.payloadStore === undefined) return undefined;
    try {
      return await this.payloadStore.getPayload(revisionId);
    } catch {
      return undefined;
    }
  }

  /**
   * Fallible payload-store write: true when the bytes are durably in the store
   * (so the caller marks the id externalized), false when there is no store or
   * the write threw (keep the payload inline: the mobile fallback).
   */
  private async safePutPayload(
    revisionId: string,
    payloadBase64: string,
  ): Promise<boolean> {
    if (this.payloadStore === undefined) return false;
    try {
      await this.payloadStore.putPayload(revisionId, payloadBase64);
      return true;
    } catch {
      console.warn(
        `Havemind: outbox payload for ${revisionId} could not be externalized; keeping it inline in data.json.`,
      );
      return false;
    }
  }

  /**
   * Drop a revision's externalized payload when it leaves BOTH the outbox and the
   * stash for good (receipt, discard, eviction); a no-op for an inline payload.
   * Best-effort: a failed delete only leaks bytes, so it is swallowed.
   */
  private async dropPayload(revisionId: string): Promise<void> {
    if (!this.externalized.has(revisionId)) return;
    if (this.payloadStore !== undefined) {
      try {
        await this.payloadStore.deletePayload(revisionId);
      } catch {
        /* best-effort: a failed delete leaks bytes but never corrupts state */
      }
    }
    this.externalized.delete(revisionId);
  }

  /**
   * Reconcile outbox/stash payloads with the out-of-band store after load (arch
   * P1). EXTERNALIZED envelopes: fetch and rehydrate the cache so `peekEnvelope`
   * drains the real payload; if it is missing, fail closed: an OUTBOX payload is
   * quarantined (never drained empty), a STASH payload is dropped (its row
   * already records the failure). INLINE ones (legacy or fallback) are MIGRATED
   * into the store, and a changed state is persisted at once.
   */
  private async reconcilePayloads(sweep: boolean): Promise<void> {
    const state = this.cache;
    if (state === null) return;

    // `cacheChanged`: the in-memory outbox/stash changed (rehydrated, quarantined
    // or dropped), so the cache is swapped. `persistNeeded`: the DISK blob changed
    // (a legacy payload migrated out, or an item quarantined), so re-save.
    // Rehydrating an externalized payload touches only the cache.
    let cacheChanged = false;
    let persistNeeded = false;
    const nextOutbox: OutboxEnvelope[] = [];
    const addedQuarantine: QuarantinedRevision[] = [];
    for (const env of state.outbox) {
      if (env.payloadExternalized === true) {
        const payload = await this.safeGetPayload(env.revisionId);
        if (typeof payload === 'string') {
          this.externalized.add(env.revisionId);
          nextOutbox.push({ ...env, payloadBase64: payload });
          cacheChanged = true;
        } else {
          // Torn/unresolvable: dead-letter it so it can never drain empty bytes.
          console.warn(
            `Havemind: outbox payload for ${env.revisionId} is missing from the store; quarantining it (fail-closed).`,
          );
          addedQuarantine.push({
            revisionId: env.revisionId,
            fileId: env.fileId,
            reason: PAYLOAD_MISSING_REASON,
          });
          cacheChanged = true;
          persistNeeded = true;
        }
      } else {
        nextOutbox.push(env);
        if (await this.safePutPayload(env.revisionId, env.payloadBase64)) {
          this.externalized.add(env.revisionId);
          persistNeeded = true; // migrated: disk form now strips this payload
        }
      }
    }

    const nextStash: Record<string, OutboxEnvelope> = {};
    for (const [key, env] of Object.entries(state.quarantinedEnvelopes)) {
      if (env.payloadExternalized === true) {
        const payload = await this.safeGetPayload(env.revisionId);
        if (typeof payload === 'string') {
          this.externalized.add(env.revisionId);
          nextStash[key] = { ...env, payloadBase64: payload };
          cacheChanged = true;
        } else {
          // The quarantine ROW already exists; only the retry bytes are gone.
          persistNeeded = true;
        }
      } else {
        nextStash[key] = env;
        if (await this.safePutPayload(env.revisionId, env.payloadBase64)) {
          this.externalized.add(env.revisionId);
          persistNeeded = true; // migrated
        }
      }
    }

    const backups = withoutExpiredBackups(state.reconciliationBackups, this.now());
    if (backups !== state.reconciliationBackups) {
      cacheChanged = true;
      persistNeeded = true;
    }

    const next: PersistedSyncState = {
      ...state,
      ...(backups === undefined ? {} : { reconciliationBackups: backups }),
      outbox: nextOutbox,
      quarantine: [...state.quarantine, ...addedQuarantine],
      quarantinedEnvelopes: nextStash,
    };
    if (sweep) await this.sweepPayloads(next);
    if (!cacheChanged && !persistNeeded) return;
    this.cache = next;
    if (persistNeeded) {
      await this.persist.save(this.toDiskForm(next));
    }
  }

  /**
   * S1: deletes stored payloads no queued, stashed or quarantined change refers
   * to. They are left by a stop between storing a payload and saving the queue,
   * by a failed delete, and by entries moved into a reconciliation backup, which
   * keeps its bytes inline. Best-effort: a failure leaves them for the next load.
   */
  private async sweepPayloads(state: PersistedSyncState): Promise<void> {
    if (this.payloadStore === undefined) return;
    const live = new Set([
      ...state.outbox.map((envelope) => envelope.revisionId),
      ...Object.values(state.quarantinedEnvelopes).map((envelope) => envelope.revisionId),
      ...state.quarantine.map((row) => row.revisionId),
    ]);
    try {
      for (const revisionId of await this.payloadStore.listPayloadIds()) {
        if (!live.has(revisionId)) await this.payloadStore.deletePayload(revisionId);
      }
    } catch {
      /* best-effort: the next load tries again */
    }
  }

  /**
   * Runs a read-modify-write `section` atomically w.r.t. every other section, by
   * chaining them on {@link mutationTail}. Sections never nest (no mutating
   * method calls another), so it cannot deadlock; the tail swallows outcomes so
   * one rejection never wedges the next.
   */
  private runExclusive<T>(section: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(section, section);
    this.mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** Synthetic revisionId prefix for an unparseable envelope without an id (GAP-1). */
export const CORRUPT_ENVELOPE_PREFIX = 'corrupt-envelope:';

/** Outcome of parsing the untrusted persisted blob (GAP-1 recovery policy). */
interface ParseResult {
  readonly status: 'absent' | 'ok' | 'corrupt';
  /** `emptyState()` for `absent`/`corrupt`; the parsed value for `ok`. */
  readonly state: PersistedSyncState;
  /** For `corrupt`: a SALVAGED state if the outbox was readable, else null. */
  readonly salvage: PersistedSyncState | null;
  /** For `corrupt` without salvage: an unreadable outbox may lose unsent revisions. */
  readonly outboxAtRisk: boolean;
}

/**
 * Parses an untrusted outbox array: every readable envelope is kept and each
 * unparseable one quarantined (GAP-1), so one bad entry never discards the rest.
 */
function parseOutboxEntries(outbox: readonly unknown[]): {
  readonly parsedOutbox: OutboxEnvelope[];
  readonly quarantinedBadEnvelopes: QuarantinedRevision[];
} {
  const parsedOutbox: OutboxEnvelope[] = [];
  const quarantinedBadEnvelopes: QuarantinedRevision[] = [];
  outbox.forEach((entry, index) => {
    const parsed = parseEnvelope(entry);
    if (parsed === null) {
      quarantinedBadEnvelopes.push(quarantineForCorruptEnvelope(entry, index));
    } else {
      parsedOutbox.push(parsed);
    }
  });
  if (quarantinedBadEnvelopes.length > 0) {
    console.warn(
      `Havemind: ${quarantinedBadEnvelopes.length} unparseable outbox envelope(s) were quarantined; the rest of the outbox was preserved.`,
    );
  }
  return { parsedOutbox, quarantinedBadEnvelopes };
}

function parsePersistedState(raw: unknown): ParseResult {
  if (raw === null || raw === undefined) {
    return { status: 'absent', state: emptyState(), salvage: null, outboxAtRisk: false };
  }
  const strict = strictParse(raw);
  if (strict !== null) {
    return { status: 'ok', state: strict, salvage: null, outboxAtRisk: false };
  }
  // Corrupt: a readable outbox is salvageable, an unreadable one is not (see hydrate).
  return {
    status: 'corrupt',
    state: emptyState(),
    salvage: salvageState(raw),
    outboxAtRisk: outboxAtRisk(raw),
  };
}

/** How long a reconciliation backup is kept (Jev, plan 009: 7 days, p 0.78). */
export const BACKUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The backups younger than {@link BACKUP_RETENTION_MS}, or the same object when
 * none expired. A copy with no time at all predates the stamp and is old.
 */
function withoutExpiredBackups(
  backups: PersistedSyncState['reconciliationBackups'],
  now: number,
): PersistedSyncState['reconciliationBackups'] {
  if (backups === undefined) return undefined;
  const fresh = (e: OutboxEnvelope): boolean => now - (e.backedUpAt ?? e.enqueuedAt ?? 0) < BACKUP_RETENTION_MS;
  if (Object.values(backups).every((entries) => entries.every(fresh))) return backups;
  const kept = Object.entries(backups)
    .map(([key, entries]) => [key, entries.filter(fresh)] as const)
    .filter(([, entries]) => entries.length > 0);
  return Object.fromEntries(kept);
}

function validRecoveryFields(raw: Record<string, unknown>): boolean {
  if (raw.producerRecovery !== undefined && (!Array.isArray(raw.producerRecovery) || !raw.producerRecovery.every(validRecovery))) return false;
  if (raw.reconciliationBackups !== undefined) {
    if (!isRecord(raw.reconciliationBackups)) return false;
    if (!Object.values(raw.reconciliationBackups).every((entries) => Array.isArray(entries) &&
      entries.every((entry) => parseEnvelope(entry) !== null && isRecord(entry) && entry.payloadExternalized !== true))) return false;
  }
  return true;
}

/**
 * The strict parse: the fully-parsed state, or `null` as soon as a CORE
 * container is corrupt (bad version/cursor, a non-array outbox/locallyAuthored/
 * deferred, a non-string authored id, an unparseable deferred event). Bad outbox
 * ENTRIES are quarantined, not rejected; non-core sub-fields degrade to their
 * default (MINOR 8) instead of failing the parse.
 */
function strictParse(raw: unknown): PersistedSyncState | null {
  if (isRecord(raw) && !validRecoveryFields(raw)) return null;
  if (!isRecord(raw) || raw.version !== 1) return null;

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
    return null;
  }

  if (!locallyAuthored.every((value) => typeof value === 'string')) {
    return null;
  }

  const parsedDeferred: RemoteEvent[] = [];
  for (const entry of deferred) {
    const parsed = parseRemoteEvent(entry);
    if (parsed === null) return null;
    parsedDeferred.push(parsed);
  }

  const { parsedOutbox, quarantinedBadEnvelopes } = parseOutboxEntries(outbox);

  // Non-core sub-fields degrade to their default with a warning (MINOR 8): the
  // maps are re-derivable (GAP-1), so losing them must not wipe the outbox.
  const pathOwners = parseStringMap(raw.pathOwners) ?? warnDegrade('pathOwners', {});
  const baseHashes = parseStringMap(raw.baseHashes) ?? warnDegrade('baseHashes', {});
  const baseContents =
    parseStringMap(raw.baseContents) ?? warnDegrade('baseContents', {});
  const conflictArtifacts =
    parseStringMap(raw.conflictArtifacts) ?? warnDegrade('conflictArtifacts', {});
  const quarantine = parseQuarantine(raw.quarantine) ?? warnDegrade('quarantine', []);
  const quarantinedEnvelopes =
    parseEnvelopeMap(raw.quarantinedEnvelopes) ??
    warnDegrade('quarantinedEnvelopes', {});

  return {
    version: 1,
    cursor: cursor as number,
    ...parseProducerField(raw.producer),
    ...(raw.producerRecovery === undefined ? {} : { producerRecovery: raw.producerRecovery as ProducerRecovery[] }),
    ...(raw.reconciliationBackups === undefined ? {} : { reconciliationBackups: raw.reconciliationBackups as Record<string, OutboxEnvelope[]> }),
    outbox: parsedOutbox,
    locallyAuthored: locallyAuthored as string[],
    deferred: parsedDeferred,
    // Merge the corrupt-envelope rows in so nothing is silently dropped.
    quarantine: [...quarantine, ...quarantinedBadEnvelopes],
    pathOwners,
    baseHashes,
    baseContents,
    conflictArtifacts,
    ...optionalConflictCopyFileIds(raw.conflictCopyFileIds),
    quarantinedEnvelopes,
  };
}

/** Parses the optional copy→fileId map; unreadable degrades to absent. */
function optionalConflictCopyFileIds(
  value: unknown,
): { conflictCopyFileIds?: Record<string, string> } {
  if (value === undefined) return {};
  const parsed = parseStringMap(value);
  return parsed === null ? {} : { conflictCopyFileIds: parsed };
}

/**
 * Best-effort SALVAGE for a corrupt blob (GAP-1): KEEP the readable outbox (the
 * only irreplaceable data) and authored ids, and default every damaged
 * non-outbox field (cursor→0, deferred→[], re-derivable maps→{}). `null` only
 * when the outbox itself is unreadable (the UNRECOVERABLE case).
 */
function salvageState(raw: unknown): PersistedSyncState | null {
  if (!isRecord(raw) || !Array.isArray(raw.outbox)) return null;
  const { parsedOutbox, quarantinedBadEnvelopes } = parseOutboxEntries(raw.outbox);
  const cursor =
    Number.isSafeInteger(raw.cursor) && (raw.cursor as number) >= 0
      ? (raw.cursor as number)
      : 0;
  const locallyAuthored =
    Array.isArray(raw.locallyAuthored) &&
    raw.locallyAuthored.every((value) => typeof value === 'string')
      ? (raw.locallyAuthored as string[])
      : [];
  const quarantine = parseQuarantine(raw.quarantine) ?? [];
  return {
    version: 1,
    cursor,
    ...parseProducerField(raw.producer),
    ...(raw.producerRecovery === undefined ? {} : { producerRecovery: raw.producerRecovery as ProducerRecovery[] }),
    ...(raw.reconciliationBackups === undefined ? {} : { reconciliationBackups: raw.reconciliationBackups as Record<string, OutboxEnvelope[]> }),
    outbox: parsedOutbox,
    locallyAuthored,
    deferred: salvageDeferred(raw.deferred),
    quarantine: [...quarantine, ...quarantinedBadEnvelopes],
    pathOwners: parseStringMap(raw.pathOwners) ?? {},
    baseHashes: parseStringMap(raw.baseHashes) ?? {},
    baseContents: parseStringMap(raw.baseContents) ?? {},
    conflictArtifacts: parseStringMap(raw.conflictArtifacts) ?? {},
    ...optionalConflictCopyFileIds(raw.conflictCopyFileIds),
    quarantinedEnvelopes: parseEnvelopeMap(raw.quarantinedEnvelopes) ?? {},
  };
}

/**
 * Deferred events for the salvage path, all-or-nothing: a fresh pull re-emits
 * them, so one unparseable entry resets the whole list instead of blocking.
 */
function salvageDeferred(value: unknown): RemoteEvent[] {
  if (!Array.isArray(value)) return [];
  const result: RemoteEvent[] = [];
  for (const entry of value) {
    const parsed = parseRemoteEvent(entry);
    if (parsed === null) return [];
    result.push(parsed);
  }
  return result;
}

/** See {@link ParseResult.outboxAtRisk}: the outbox exists but is not an array. */
function outboxAtRisk(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const outbox = raw.outbox;
  if (outbox === undefined || Array.isArray(outbox)) return false;
  return true;
}

/**
 * Did a corrupt primary's SALVAGE keep outbox revisions the chosen `.bak` lacks?
 * `.bak` is one generation behind, so an intact outbox may hold newer ones. Never
 * merges the two: compares revisionId sets (an id only in the salvage is an
 * at-risk delta). Cheap and never throws.
 */
function salvageHasOutboxEntriesMissingFrom(
  salvage: PersistedSyncState | null,
  backupOutbox: readonly OutboxEnvelope[],
): boolean {
  if (salvage === null || salvage.outbox.length === 0) return false;
  const backupIds = new Set(backupOutbox.map((entry) => entry.revisionId));
  return salvage.outbox.some((entry) => !backupIds.has(entry.revisionId));
}

/**
 * A quarantine row for an unparseable outbox envelope (GAP-1), so it stays
 * visible: reuses its revisionId/fileId when present, else a synthetic id.
 */
function quarantineForCorruptEnvelope(
  entry: unknown,
  index: number,
): QuarantinedRevision {
  const revisionId =
    isRecord(entry) && typeof entry.revisionId === 'string'
      ? entry.revisionId
      : `${CORRUPT_ENVELOPE_PREFIX}${index}`;
  const fileId =
    isRecord(entry) && typeof entry.fileId === 'string' ? entry.fileId : '';
  return { revisionId, fileId, reason: 'corrupt-envelope' };
}

/**
 * Warns that an optional sub-field was malformed and returns the default in its
 * place (MINOR 8): one bad entry degrades that field, not the whole state.
 */
function warnDegrade<T>(field: string, fallback: T): T {
  console.warn(
    `Havemind: persisted "${field}" was malformed and was reset to its default; other sync state was preserved.`,
  );
  return fallback;
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
    const parents = entry.parentRevisionIds;
    result.push({
      revisionId: entry.revisionId,
      fileId: entry.fileId,
      reason: entry.reason,
      ...(Array.isArray(parents) && parents.every((id) => typeof id === 'string')
        ? { parentRevisionIds: parents as string[] }
        : {}),
    });
  }
  return result;
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
    // Keep the enqueue time across a restart (SND-01); a non-number reads as
    // unstamped, i.e. old (see `outboxAges`).
    ...(typeof value.enqueuedAt === 'number'
      ? { enqueuedAt: value.enqueuedAt }
      : {}),
    // Arch P1: carry the externalized marker so load-time reconciliation knows
    // to rehydrate the payload from the store (an empty inline `payloadBase64` is
    // otherwise indistinguishable from a genuinely 0-byte payload).
    ...(value.payloadExternalized === true
      ? { payloadExternalized: true }
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
