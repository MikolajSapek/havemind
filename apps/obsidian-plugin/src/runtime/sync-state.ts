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
  /** The current primary blob (null when absent — a normal first run). */
  load(): Promise<unknown>;
  /**
   * The previous-good backup blob (GAP-1), or null when none exists. Read only
   * when the primary parses as present-but-corrupt, to recover from the last
   * durable snapshot before declaring recovery-required.
   */
  loadBackup(): Promise<unknown>;
  /**
   * Atomically persist `state` as the new primary while retaining the prior
   * primary as the single `.bak` (GAP-1). A torn write must never destroy the
   * previous good blob.
   */
  save(state: PersistedSyncState): Promise<void>;
  /**
   * Preserve a present-but-corrupt raw blob under a timestamped sidecar key
   * (GAP-1) so a fail-closed load never discards the bytes it could not parse.
   * A pre-existing sidecar is never clobbered. `timestamp` is supplied by the
   * caller (never read from a clock inside pure parse code).
   */
  preserveCorrupt(raw: unknown, timestamp: number): Promise<void>;
}

export interface DurableSyncStateOptions {
  readonly persist: SyncStatePersistPort;
  /** Upper bound on remembered authored ids; oldest are pruned first. */
  readonly maxLocallyAuthored?: number;
  /** Wall clock for stamping outbox enqueue times (SND-01). Defaults to Date.now. */
  readonly now?: () => number;
  /**
   * Total-bytes budget for stashed quarantine envelopes (MAJOR 4). Defaults to
   * {@link QUARANTINED_ENVELOPE_BUDGET_BYTES}; injectable so tests can trip the
   * eviction path cheaply.
   */
  readonly quarantinedEnvelopeBudgetBytes?: number;
}

const DEFAULT_MAX_LOCALLY_AUTHORED = 10_000;

/**
 * Total-bytes ceiling for stashed quarantine envelopes (MAJOR 4). A dead-letter
 * stash keeps the full push payload so "Retry" can re-send the exact bytes, but
 * with F9 binary attachments up to 25 MB a run of rejected sends could otherwise
 * grow `data.json` without bound. When the sum of stashed payload bytes exceeds
 * this budget the OLDEST stashes are evicted — the quarantine ROW stays visible,
 * and its Retry degrades to re-committing the file from disk (the on-disk
 * content is the source of truth), so nothing is silently dropped.
 */
export const QUARANTINED_ENVELOPE_BUDGET_BYTES = 5 * 1024 * 1024;

/**
 * Prefix for the synthetic revisionId a `failed-to-queue` row (SND-02) is keyed
 * by. The id is `failed-to-queue:<path>`, so repeated commit-path failures for
 * the same file coalesce into one row. Exported so the retry router (MAJOR 2)
 * can tell a failed-to-queue row (re-trigger the commit chain from disk) apart
 * from a server-rejected send (re-enqueue the stashed envelope).
 */
export const FAILED_TO_QUEUE_PREFIX = 'failed-to-queue:';

/** Builds the synthetic revisionId for a failed-to-queue row keyed by `path`. */
export function failedToQueueRevisionId(path: string): string {
  return `${FAILED_TO_QUEUE_PREFIX}${path}`;
}

/**
 * The vault path a failed-to-queue synthetic revisionId encodes, or null when
 * `revisionId` is not a failed-to-queue id (a real, server-rejected revision) or
 * carries no path. A null result routes retry through the normal requeue path.
 */
export function parseFailedToQueuePath(revisionId: string): string | null {
  if (!revisionId.startsWith(FAILED_TO_QUEUE_PREFIX)) return null;
  const path = revisionId.slice(FAILED_TO_QUEUE_PREFIX.length);
  return path.length === 0 ? null : path;
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
  private readonly envelopeBudgetBytes: number;
  private cache: PersistedSyncState | null = null;
  /**
   * Set when the primary blob was present-but-corrupt in a CORE field AND held
   * a non-empty outbox we could not parse (GAP-1), and no usable `.bak` existed.
   * While set, {@link mutate} refuses to persist: the wiped in-memory state must
   * never overwrite the on-disk blob whose queued-but-unsent revisions were
   * preserved to a sidecar. Surfaced via {@link isRecoveryRequired} so the UI can
   * tell the user "local queue needs recovery" instead of silently losing it.
   */
  private recoveryRequired = false;
  /**
   * De-dupes concurrent cold-cache loads. Without it, two callers that both find
   * a null cache each `await persist.load()`; the later resolution re-parses the
   * on-disk blob and clobbers any cache mutation the first caller made during the
   * await (an enqueued revision, an advanced cursor) — a silent dropped push at
   * connect (rule 3). All concurrent callers share this single in-flight load.
   */
  private loadPromise: Promise<void> | null = null;
  /**
   * Serializes every read-modify-write critical section against the shared
   * in-memory cache. Each mutating method reads the cache (`ensureLoaded`) and
   * writes it back (`mutate`) as a `{ ...state, field }` spread, with `await`
   * points in between. On a WARM cache `ensureLoaded` reads synchronously, so
   * two sections that overlap each capture the SAME snapshot and the later
   * `mutate` silently drops the earlier one's write — a lost update. In the
   * two-device sync loop this dropped a file's base CONTENT while keeping its
   * base HASH, which then made the three-way merge (it needs the ancestor
   * content) fail and spawn a SPURIOUS conflict copy (rule 3: zero silent
   * overwrites / data loss). This is the in-memory analogue of the data.json
   * `PluginDataMutex`, which only guards the on-disk save, not the cache RMW.
   * Chaining each section on this single tail makes it run to completion before
   * the next one reads, so no committed write is ever clobbered. Read-only
   * accessors stay off the queue: `mutate` swaps the whole cache object in one
   * synchronous assignment, so any read sees a complete, consistent snapshot.
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
  }

  /**
   * Whether the last load found a present-but-corrupt blob with an unparseable
   * non-empty outbox and no usable backup (GAP-1). While true, no mutation is
   * persisted (the corrupt blob and its sidecar copy are left intact), and the
   * UI/status should tell the user the local queue needs recovery.
   */
  isRecoveryRequired(): boolean {
    return this.recoveryRequired;
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
    return state.outbox.map((envelope) => ({
      revisionId: envelope.revisionId,
      fileId: envelope.fileId,
      contentHash: envelope.contentHash,
      payloadBytes: base64ByteLength(envelope.payloadBase64),
    }));
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
      // MAJOR 4: hold the stash under a total-bytes budget by evicting the oldest
      // stashes first. The quarantine rows they belong to are left intact, so the
      // failures stay visible and their Retry degrades to a re-commit from disk.
      const budgeted = this.evictStashesOverBudget(quarantinedEnvelopes);
      await this.mutate({
        ...state,
        outbox,
        quarantine,
        quarantinedEnvelopes: budgeted,
      });
    });
  }

  /**
   * Returns a copy of `envelopes` trimmed to the byte budget (MAJOR 4). Object
   * key order is insertion order, so iterating from the front evicts the OLDEST
   * stashes until the summed decoded payload bytes fit. A single stash larger
   * than the whole budget is evicted too — its row survives and Retry re-commits
   * from disk, which is the only recovery once the bytes are dropped.
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
   * commit-path enqueue permanently failed (e.g. a transient readText/saveData
   * failure that survived a bounded re-arm), so it never reached the outbox and
   * has no envelope to retry. It reuses the SND-01 quarantine machinery so the
   * send-queue panel surfaces it alongside server-rejected sends under the
   * distinguishable reason `failed-to-queue`, keyed by a synthetic revisionId
   * derived from the path (see {@link failedToQueueRevisionId}) so repeated
   * failures for the same file coalesce into one row rather than flooding the
   * panel. Nothing is ever silently dropped.
   *
   * Discard behaves identically to a server-rejected send, but Retry does NOT:
   * a failed-to-queue row has no stashed envelope (it never reached the outbox),
   * so `requeueQuarantined` is inert for it. Retry instead re-triggers the
   * commit chain for the path from disk (MAJOR 2, routed by the caller via
   * {@link parseFailedToQueuePath}) — the on-disk content is the source of truth.
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

  /**
   * The exact base CONTENT for a file (the merge ancestor, MRG-01), or null when
   * none is recorded. Synchronous against the warmed cache, like `baseHashFor`.
   */
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
    return this.runExclusive(async () => {
      const state = await this.ensureLoaded();
      await this.mutate({
        ...state,
        conflictArtifacts: { ...state.conflictArtifacts, [revisionId]: path },
      });
    });
  }

  async enqueue(envelope: OutboxEnvelope): Promise<void> {
    return this.runExclusive(async () => {
      const state = await this.ensureLoaded();
      // Stamp the enqueue time when the caller omitted it, so the send-queue
      // view (SND-01) can age items without producers having to supply a clock.
      const stamped: OutboxEnvelope =
        envelope.enqueuedAt === undefined
          ? { ...envelope, enqueuedAt: this.now() }
          : envelope;
      const outbox = [
        ...state.outbox.filter(
          (entry) => entry.revisionId !== envelope.revisionId,
        ),
        stamped,
      ];
      await this.mutate({ ...state, outbox });
    });
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
   * quarantine and the stash. Returns true when it re-enqueued, false when
   * nothing is stashed for `revisionId` — already requeued/discarded, or the
   * stash was evicted under the byte budget (MAJOR 4). A false return leaves the
   * quarantine row intact so the caller can degrade Retry to a re-commit from
   * disk; a double click cannot double-enqueue because the second call finds no
   * stash and returns false.
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

  /**
   * Permanently drop a quarantined send (SND-01): remove it from the quarantine
   * and forget its stashed envelope. Idempotent — dropping an unknown id is a
   * no-op.
   */
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
    });
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
    return this.runExclusive(async () => {
      const state = await this.ensureLoaded();
      await this.mutate({ ...state, deferred: [...events] });
    });
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
    if (this.loadPromise === null) {
      this.loadPromise = this.persist
        .load()
        .then((raw) => this.hydrate(raw))
        .finally(() => {
          this.loadPromise = null;
        });
    }
    await this.loadPromise;
    if (this.cache === null) this.cache = emptyState();
    return this.cache;
  }

  /**
   * Parse the loaded primary blob into the cache (GAP-1 fail-closed policy). A
   * mutation may have populated the cache while the load was in flight (e.g. an
   * enqueue that awaited this same shared promise and then wrote); never clobber
   * it — re-check `this.cache === null` before each assignment.
   *
   *  - ABSENT (null/undefined): a clean first run → empty, writable state.
   *  - OK: the parsed state (with bad outbox envelopes quarantined, not nuked).
   *  - CORRUPT (present but a core field failed): try the `.bak` first; if it is
   *    a valid present state, recover from it. Otherwise preserve the raw blob to
   *    a sidecar and, when it held a non-empty outbox at risk, enter
   *    recovery-required so no wiped state is ever persisted over it.
   */
  private async hydrate(raw: unknown): Promise<void> {
    if (this.cache !== null) return;
    const outcome = parsePersistedState(raw);
    if (outcome.status !== 'corrupt') {
      if (this.cache === null) this.cache = outcome.state;
      return;
    }

    const backup = await this.persist.loadBackup();
    if (this.cache !== null) return;
    const backupOutcome = parsePersistedState(backup);
    if (backupOutcome.status === 'ok') {
      // The last durable snapshot is intact — recover from it, but still stash
      // the corrupt primary for forensics/manual recovery.
      await this.persist.preserveCorrupt(raw, this.now());
      if (this.cache === null) this.cache = backupOutcome.state;
      return;
    }

    // No usable backup: fail closed. Preserve the bytes we could not parse, then
    // refuse to persist a replacement over them when a non-empty outbox was lost.
    await this.persist.preserveCorrupt(raw, this.now());
    if (this.cache !== null) return;
    this.cache = emptyState();
    if (outcome.corruptOutboxAtRisk) this.recoveryRequired = true;
  }

  private async mutate(next: PersistedSyncState): Promise<void> {
    this.cache = next;
    // Fail-closed (GAP-1): while recovery is required the on-disk blob still
    // holds queued-but-unsent revisions we could not parse (preserved to a
    // sidecar). Persisting the wiped in-memory state here would overwrite them —
    // the exact silent data loss this guard prevents. Reads still see `next`,
    // but nothing reaches disk until the user recovers.
    if (this.recoveryRequired) return;
    await this.persist.save(next);
  }

  /**
   * Runs a read-modify-write `section` (an `ensureLoaded` + `mutate` pair)
   * atomically with respect to every other section, by chaining them on a
   * single tail. See {@link mutationTail} for why this is required. `section`s
   * never nest (no mutating method calls another), so this cannot deadlock; the
   * tail swallows outcomes so one section's rejection never wedges the next.
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

/**
 * Prefix for the synthetic revisionId of a quarantine row minted for an outbox
 * envelope that could not be parsed but carried no usable revisionId (GAP-1). It
 * keeps the bad entry visible in the send-queue panel instead of dropping it.
 */
export const CORRUPT_ENVELOPE_PREFIX = 'corrupt-envelope:';

/** Outcome of parsing the untrusted persisted blob (GAP-1 fail-closed policy). */
interface ParseResult {
  /**
   *  - `absent`: null/undefined blob — a normal first run (clean, writable).
   *  - `ok`: parsed successfully (bad outbox envelopes quarantined, not nuked).
   *  - `corrupt`: present but a CORE field failed — fail closed.
   */
  readonly status: 'absent' | 'ok' | 'corrupt';
  /** `emptyState()` for `absent`/`corrupt`; the parsed value for `ok`. */
  readonly state: PersistedSyncState;
  /**
   * Only meaningful for `corrupt`: the corrupt blob held a non-empty outbox we
   * could not parse, so a wiped replacement must never be persisted over it.
   */
  readonly corruptOutboxAtRisk: boolean;
}

/**
 * True when a corrupt raw blob may still hold queued-but-unsent outbox items
 * (GAP-1). An explicitly-empty array carries nothing at risk; anything else
 * present (a non-empty array, or a non-array value we cannot enumerate) is
 * treated conservatively as at risk so its bytes are never silently replaced.
 */
function corruptOutboxAtRisk(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const outbox = raw.outbox;
  if (outbox === undefined) return false;
  if (Array.isArray(outbox)) return outbox.length > 0;
  return true;
}

function corruptResult(raw: unknown): ParseResult {
  return {
    status: 'corrupt',
    state: emptyState(),
    corruptOutboxAtRisk: corruptOutboxAtRisk(raw),
  };
}

function parsePersistedState(raw: unknown): ParseResult {
  // A genuinely absent blob is a normal first run — a clean, writable state,
  // NOT corruption (GAP-1: distinguish null/absent from present-but-corrupt).
  if (raw === null || raw === undefined) {
    return { status: 'absent', state: emptyState(), corruptOutboxAtRisk: false };
  }
  if (!isRecord(raw) || raw.version !== 1) return corruptResult(raw);

  const cursor = raw.cursor;
  const outbox = raw.outbox;
  const locallyAuthored = raw.locallyAuthored;
  const deferred = raw.deferred;

  // Core-container corruption (a non-array outbox, a bad cursor, etc.) fails
  // closed — see hydrate(). Individual bad ENTRIES are handled below.
  if (
    !Number.isSafeInteger(cursor) ||
    (cursor as number) < 0 ||
    !Array.isArray(outbox) ||
    !Array.isArray(locallyAuthored) ||
    !Array.isArray(deferred)
  ) {
    return corruptResult(raw);
  }

  if (!locallyAuthored.every((value) => typeof value === 'string')) {
    return corruptResult(raw);
  }

  const parsedDeferred: RemoteEvent[] = [];
  for (const entry of deferred) {
    const parsed = parseRemoteEvent(entry);
    if (parsed === null) return corruptResult(raw);
    parsedDeferred.push(parsed);
  }

  // A single unparseable outbox envelope must NOT discard its parseable siblings
  // (GAP-1): keep the good ones and quarantine the bad entry so it stays visible
  // rather than nuking the whole outbox to empty.
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

  // Non-core sub-fields degrade to their default with a console.warn rather than
  // nuking the whole blob (MINOR 8, extended to pathOwners/baseHashes under
  // GAP-1: those maps are re-derivable, so losing them must not wipe the outbox).
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
    status: 'ok',
    corruptOutboxAtRisk: false,
    state: {
      version: 1,
      cursor: cursor as number,
      outbox: parsedOutbox,
      locallyAuthored: locallyAuthored as string[],
      deferred: parsedDeferred,
      // Merge the corrupt-envelope rows in so nothing is silently dropped.
      quarantine: [...quarantine, ...quarantinedBadEnvelopes],
      pathOwners,
      baseHashes,
      baseContents,
      conflictArtifacts,
      quarantinedEnvelopes,
    },
  };
}

/**
 * Build a quarantine row for an unparseable outbox envelope (GAP-1). Reuses the
 * entry's own revisionId/fileId when present; otherwise mints a synthetic id
 * from the index so the row is stable and visible.
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
 * Logs that an optional persisted sub-field was malformed and returns the
 * supplied default in its place (MINOR 8), so one bad entry degrades that field
 * alone instead of resetting the whole durable state.
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
    result.push({
      revisionId: entry.revisionId,
      fileId: entry.fileId,
      reason: entry.reason,
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
