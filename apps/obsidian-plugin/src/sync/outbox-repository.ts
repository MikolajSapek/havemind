/**
 * The push-producer bridge: turns a detected local vault change into a durable
 * outbox revision the sync runner ships to the server.
 *
 * `VaultChangeObserver` (`obsidian/vault-adapter.ts`) detects and classifies a
 * change and hands it here as a `LocalChangeCommit`. This repository builds the
 * opaque revision envelope (`@havemind/sync-core`) and enqueues it, so the next
 * `SyncRunner` cycle POSTs it to `/vaults/:vaultId/revisions`. Without this
 * bridge the outbox is always empty and the client only ever pulls, the root
 * cause of "local edits never reach the server".
 *
 * It also owns the durable fileId↔path mapping the observer reads back (so a
 * modify resolves to an existing file rather than re-creating it) and the
 * per-file head revision used as the parent of the next revision. State lives
 * behind an injected `ProducerStorePort` so it survives an Obsidian restart.
 */

import {
  buildRevisionEnvelope,
  type RevisionEnvelopeOperation,
} from '@havemind/sync-core';

import type {
  LocalChangeCommit,
  LocalChangeKind,
  LocalChangeOperation,
  LocalChangeRepository,
  LocalFileMapping,
} from '../obsidian/vault-adapter';
import type { OutboxEnvelope } from '../runtime/sync-state';
import { KeyedMutex } from '../runtime/keyed-mutex';
import type { ProducerRecovery, ProducerRecoveryPort } from '../runtime/producer-recovery';

/**
 * Effective per-payload ceiling for a BINARY attachment (F9). A 25 MB file
 * ({@link MAX_BINARY_FILE_BYTES}) is ~33 MB once base64-encoded, plus the JSON
 * envelope (path, blobByteHash, field names); 40 MB covers that with headroom.
 * The observer already excludes over-cap files before they reach here, so this
 * ceiling is the belt-and-braces stop that keeps an oversized binary from
 * silently wedging the outbox, the same role the default markdown ceiling plays.
 */
export const MAX_BINARY_PAYLOAD_BYTES = 40 * 1024 * 1024;

/**
 * Decodes standard base64 (the form the observer stores in a binary operation's
 * `content`) back to the raw bytes `buildRevisionEnvelope` re-hashes and ships.
 */
function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Server identity a revision header must carry to be accepted (rule 3). */
export interface PushIdentity {
  readonly vaultId: string;
  readonly memberId: string;
  readonly deviceId: string;
}

/** Durable producer state: the file map plus each file's local head revision. */
export interface ProducerState {
  readonly mappings: readonly LocalFileMapping[];
  /** fileId → last locally authored revisionId (the next revision's parent). */
  readonly heads: Readonly<Record<string, string>>;
}

export interface ProducerStorePort {
  load(): Promise<ProducerState>;
  save(state: ProducerState): Promise<void>;
}

/** A file this device authored/pushed, seeded into the shared apply store. */
export interface LocalMaterialization {
  readonly fileId: string;
  readonly path: string;
  /** SHA-256 hex of the normalized note text (the apply-side base hash). */
  readonly contentHash: string;
  /**
   * The canonical markdown text (the merge ancestor to seed, MRG-01), or null for
   * a binary file, which never merges and records no base content.
   */
  readonly content: string | null;
  /** The prior path on a rename, so its stale ownership can be forgotten. */
  readonly previousPath: string | null;
}

/** A file this device deleted, so its shared ownership+base can be forgotten. */
export interface LocalForget {
  readonly fileId: string;
  readonly path: string;
}

export interface OutboxLocalChangeRepositoryOptions {
  readonly recovery?: ProducerRecoveryPort;
  readonly identity: PushIdentity;
  readonly store: ProducerStorePort;
  readonly enqueue: (envelope: OutboxEnvelope) => Promise<void>;
  readonly generateRevisionId: () => string;
  /** A history replay must not author merges on behalf of other devices. */
  readonly cancelUnsentMerge?: (revisionId: string) => Promise<void>;
  readonly hasAuthoredRevision?: (revisionId: string) => Promise<boolean>;
  /**
   * Effective per-payload byte ceiling. A change whose payload would exceed it
   * is rejected here, before enqueue, with a surfaced
   * `RevisionPayloadTooLargeError`, so an oversized note can never silently wedge
   * the outbox. Defaults to the sync-core default (the server's per-payload
   * limit).
   */
  readonly maxPayloadBytes?: number;
  /**
   * Seeds the SHARED apply-side ownership+base for a file this device authored
   * or pushed. Without this the apply store (`pathOwners`/`baseHashes`) only ever
   * learns about files RECEIVED from the peer, so a remote edit to a
   * locally-authored file finds no owner, is treated as a foreign collision, and
   * is diverted to a conflict artifact forever. Seeding it here unifies the
   * producer and apply stores onto one fileId↔path↔base truth, so a peer edit to
   * a locally-authored file updates IN PLACE (base match) and only genuine
   * divergence becomes a conflict. Called on create/update/rename commits.
   */
  readonly onLocalMaterialized?: (m: LocalMaterialization) => Promise<void>;
  /** Forgets the shared ownership+base when this device deletes a file. */
  readonly onLocalForgotten?: (m: LocalForget) => Promise<void>;
}

const OPERATION_BY_KIND: Readonly<
  Record<LocalChangeKind, RevisionEnvelopeOperation>
> = {
  create: 'create',
  update: 'update',
  rename: 'rename',
  delete: 'delete',
};

export class OutboxLocalChangeRepository implements LocalChangeRepository {
  private readonly options: OutboxLocalChangeRepositoryOptions;
  // All files share one persisted mapping document. Per-file observer locks
  // cannot prevent two different files from saving snapshots over each other.
  private readonly mutations = new KeyedMutex();
  private readonly activeApplies = new Set<string>();

  constructor(options: OutboxLocalChangeRepositoryOptions) {
    this.options = options;
  }

  async recover(): Promise<void> {
    await this.mutations.runExclusive('state', () => this.recoverLocked());
  }

  private async recoverLocked(): Promise<void> {
    for (const record of await this.options.recovery?.pendingProducerRecoveries() ?? []) {
      if (this.activeApplies.has(record.id)) continue;
      await this.options.recovery?.recoverProducerQueue(record.id);
      const current = await this.options.store.load();
      const ids = new Set(record.fileIds);
      const heads = Object.fromEntries(Object.entries(current.heads).filter(([id]) => !ids.has(id)));
      await this.options.store.save({
        mappings: [...current.mappings.filter((m) => !ids.has(m.fileId)), ...record.state.mappings],
        heads: { ...heads, ...record.state.heads },
      });
      await this.options.recovery?.completeProducerRecovery(record.id);
    }
  }

  /** Persist undo intent before adoption or enqueue. Interrupted applies are
   * rolled back before any subsequent push; original payloads remain archived. */
  async checkpointApply(fileId: string, paths: readonly string[]): Promise<(() => Promise<void>) & { complete?: () => Promise<void> }> {
    return this.mutations.runExclusive('state', async () => {
      await this.recoverLocked();
      const before = await this.options.store.load();
      const affected = new Set([fileId, ...before.mappings.filter((m) => paths.includes(m.path)).map((m) => m.fileId)]);
      const record: ProducerRecovery = {
        id: this.options.generateRevisionId(), kind: 'apply', fileIds: [...affected], discardRevisionIds: [],
        state: { mappings: before.mappings.filter((m) => affected.has(m.fileId)),
          heads: Object.fromEntries(Object.entries(before.heads).filter(([id]) => affected.has(id))) },
      };
      if (this.options.recovery !== undefined) {
        await this.options.recovery.startProducerRecovery(record);
        this.activeApplies.add(record.id);
        const rollback = async (): Promise<void> => {
          this.activeApplies.delete(record.id);
          await this.recover();
        };
        return Object.assign(rollback, { complete: async () => {
          await this.options.recovery?.completeProducerRecovery(record.id);
          this.activeApplies.delete(record.id);
        } });
      }
      // Compatibility for isolated adapters without the durable runtime port.
      return () => this.mutations.runExclusive('state', async () => {
        const current = await this.options.store.load();
        const currentHead = current.heads[fileId];
        if (currentHead !== undefined && currentHead !== before.heads[fileId]) await this.options.cancelUnsentMerge?.(currentHead);
        await this.options.store.save({
          mappings: [...current.mappings.filter((m) => !affected.has(m.fileId)), ...record.state.mappings],
          heads: { ...Object.fromEntries(Object.entries(current.heads).filter(([id]) => !affected.has(id))), ...record.state.heads },
        });
      });
    });
  }

  async commitHeadResolution(input: {
    mapping: LocalFileMapping; expectedHead: string; pendingIds: readonly string[];
    parents: readonly string[]; existingRevisionId?: string;
  }): Promise<void> {
    await this.mutations.runExclusive('state', async () => {
      await this.recoverLocked();
      const recovery = this.options.recovery;
      if (recovery === undefined) return;
      const current = await this.options.store.load();
      if (current.heads[input.mapping.fileId] !== input.expectedHead) return;
      const revisionId = input.existingRevisionId ?? this.options.generateRevisionId();
      const built = input.existingRevisionId === undefined ? await buildRevisionEnvelope({
        identity: { ...this.options.identity, fileId: input.mapping.fileId }, revisionId,
        parentRevisionIds: input.parents, operation: 'update', path: input.mapping.path,
        content: input.mapping.content, idempotencyKey: revisionId,
      }) : undefined;
      const replacement = built === undefined ? undefined : { ...built, operationId: revisionId };
      const record: ProducerRecovery = { id: this.options.generateRevisionId(), kind: 'resolution',
        fileIds: [input.mapping.fileId], discardRevisionIds: input.pendingIds,
        state: { mappings: [input.mapping], heads: { [input.mapping.fileId]: revisionId } },
      };
      if (await recovery.startProducerRecovery(record, replacement)) await this.recoverLocked();
    });
  }

  async listMappings(): Promise<readonly LocalFileMapping[]> {
    // Replay any interrupted commit FIRST. This is the read the vault scan uses
    // to decide whether a file already has an identity, so serving it from raw
    // store state is what lets a scan mint a duplicate identity for a file
    // whose commit was interrupted after its queue entry was written.
    await this.mutations.runExclusive('state', () => this.recoverLocked());
    return (await this.options.store.load()).mappings;
  }

  /**
   * This device's current head revisionId for `fileId`, the last revision it
   * authored locally or adopted from a remote apply, or null if none is
   * known. Read by the apply side's causal apply-vs-conflict decision (rule 3)
   * to tell a fast-forward (the incoming revision descends from this head)
   * from a concurrent divergence that must never be silently overwritten.
   */
  async headFor(fileId: string): Promise<string | null> {
    const state = await this.options.store.load();
    return state.heads[fileId] ?? null;
  }

  async versionFor(fileId: string): Promise<{ revisionId: string; contentHash: string } | null> {
    const state = await this.options.store.load();
    const mapping = state.mappings.find((item) => item.fileId === fileId);
    const revisionId = state.heads[fileId];
    return mapping === undefined || revisionId === undefined ? null : {
      revisionId, contentHash: mapping.contentHash,
    };
  }

  async commitMergedChange(input: {
    readonly mapping: LocalFileMapping;
    readonly remoteRevisionId: string;
    readonly remoteParentRevisionIds: readonly string[];
  }): Promise<boolean> {
    return this.mutations.runExclusive('state', async () => {
      const state = await this.options.store.load();
      const { mapping, remoteRevisionId, remoteParentRevisionIds } = input;
      const localHead = state.heads[mapping.fileId];
      if (localHead === undefined ||
        !(await this.options.hasAuthoredRevision?.(localHead))) return false;
      // An unsent disk edit over a remote child only needs that child as parent.
      // Concurrent authored revisions require BOTH branches, not just the peer.
      const parents = remoteParentRevisionIds.includes(localHead) || localHead === remoteRevisionId
        ? [remoteRevisionId] : [localHead, remoteRevisionId];
      const revisionId = this.options.generateRevisionId();
      const built = await buildRevisionEnvelope({
        identity: { ...this.options.identity, fileId: mapping.fileId },
        revisionId,
        parentRevisionIds: parents,
        operation: 'update',
        path: mapping.path,
        content: mapping.content,
        idempotencyKey: revisionId,
        ...(this.options.maxPayloadBytes === undefined ? {} : { maxPayloadBytes: this.options.maxPayloadBytes }),
      });
      await (this.options.recovery?.enqueueAutomaticMerge.bind(this.options.recovery) ?? this.options.enqueue)({
        header: built.header,
        idempotencyKey: built.idempotencyKey,
        payloadBase64: built.payloadBase64,
        operationId: revisionId,
        revisionId,
        fileId: mapping.fileId,
        contentHash: built.contentHash,
      });
      await this.options.store.save({
        mappings: upsertMapping(state.mappings, mapping),
        heads: { ...state.heads, [mapping.fileId]: revisionId },
      });
      return true;
    });
  }

  /**
   * Publishes a local change so the queue entry and the producer mapping can
   * never be observed apart. The journal records the producer state this commit
   * INTENDS, alongside the envelope, in a single durable write; `recoverLocked`
   * then replays that state on the next call, before any scan can look for a
   * mapping and fail to find one.
   *
   * `kind: 'resolution'` (not `'apply'`) because there is nothing to roll back:
   * this is a new local edit, so recovery must finish it forwards rather than
   * restore a previous state.
   *
   * With no recovery port wired the old two-write path is kept, so a caller
   * that does not supply one (unit tests, the preview harness) behaves exactly
   * as before.
   */
  private async commitWithRecovery(
    envelope: OutboxEnvelope,
    next: ProducerState,
    operation: LocalChangeOperation,
  ): Promise<void> {
    const recovery = this.options.recovery;
    if (recovery === undefined) {
      await this.options.enqueue(envelope);
      await this.options.store.save(next);
      await this.seedSharedState(operation);
      return;
    }
    const record: ProducerRecovery = {
      id: this.options.generateRevisionId(),
      kind: 'resolution',
      fileIds: [operation.fileId],
      state: {
        mappings: next.mappings.filter((m) => m.fileId === operation.fileId),
        heads: Object.fromEntries(
          Object.entries(next.heads).filter(([id]) => id === operation.fileId),
        ),
      },
      discardRevisionIds: [],
    };
    // A false return means the journal refused the transaction (another one is
    // in flight for this file). Fall back to the previous behaviour rather than
    // dropping the user's edit: the change still reaches the queue.
    const started = await recovery.startProducerRecovery(record, envelope);
    if (!started) {
      await this.options.enqueue(envelope);
      await this.options.store.save(next);
      await this.seedSharedState(operation);
      return;
    }
    await this.options.store.save(next);
    await this.seedSharedState(operation);
    await recovery.completeProducerRecovery(record.id);
  }

  async commitLocalChange(commit: LocalChangeCommit): Promise<string | null> {
    return this.mutations.runExclusive('state', async () => {
      await this.recoverLocked();
      const state = await this.options.store.load();
      const { operation } = commit;
      const head = state.heads[operation.fileId];
      const kind = operation.kind;
      const envelopeOperation = resolveOperation(kind, head);

      // A delete with no server-side head has nothing to tombstone remotely.
      if (!(kind === 'delete' && head === undefined)) {
        const parentRevisionIds =
          envelopeOperation === 'create' || head === undefined ? [] : [head];
        const revisionId = this.options.generateRevisionId();
        // buildRevisionEnvelope throws RevisionPayloadTooLargeError for an
        // oversized change. It propagates out of commitLocalChange BEFORE the
        // enqueue and the store.save below, so a too-large note is surfaced to the
        // caller and never enters the outbox (no silent wedge, no state mutation).
        // A binary change (F9) is a whole-file replace over RAW bytes: the observer
        // stored those bytes as base64 in `content`, so decode them and hand the
        // codec `kind: 'binary'` + `binaryContent` (never markdown `content`, which
        // would be canonicalised). The base64 of a 25 MB file needs a raised
        // ceiling, so binary uses {@link MAX_BINARY_PAYLOAD_BYTES} rather than the
        // markdown default.
        const isBinary = operation.contentKind === 'binary';
        const built = await buildRevisionEnvelope({
          identity: {
            vaultId: this.options.identity.vaultId,
            fileId: operation.fileId,
            memberId: this.options.identity.memberId,
            deviceId: this.options.identity.deviceId,
          },
          revisionId,
          parentRevisionIds,
          operation: envelopeOperation,
          path: operation.path,
          previousPath: operation.previousPath,
          ...(isBinary
            ? {
                kind: 'binary' as const,
                content: null,
                binaryContent: decodeBase64ToBytes(operation.content ?? ''),
                maxPayloadBytes: MAX_BINARY_PAYLOAD_BYTES,
              }
            : {
                content: operation.content,
                ...(this.options.maxPayloadBytes === undefined
                  ? {}
                  : { maxPayloadBytes: this.options.maxPayloadBytes }),
              }),
          idempotencyKey: operation.operationId,
        });

        const envelope: OutboxEnvelope = {
          header: built.header,
          idempotencyKey: built.idempotencyKey,
          payloadBase64: built.payloadBase64,
          operationId: operation.operationId,
          revisionId: built.revisionId,
          fileId: built.fileId,
          contentHash: built.contentHash,
        };
        const next = applyCommit(state, commit, {
          fileId: operation.fileId,
          revisionId,
          isDelete: kind === 'delete',
        });

        // The queue entry and the identity mapping must land together. Written
        // separately, a failure between them leaves a queued revision whose
        // file has no mapping, and the next scan mints a SECOND identity for
        // the same file: the duplicate-identity failure observed in production
        // on 2026-09-19 (three blob hashes shared by seven file ids).
        //
        // `startProducerRecovery` persists the replacement envelope and the
        // journal record in one `mutate`, and `recoverLocked` replays the
        // recorded producer state before any later scan can run. So an
        // interruption either leaves nothing, or leaves an entry that replays
        // to exactly this state. There is no window in between.
        await this.commitWithRecovery(envelope, next, operation);
        // The real, server-facing revision id, never `operation.operationId`
        // (a client-only idempotency key). Callers (the Activity feed) must
        // record this id so a local push and its later remote echo collapse by
        // revisionId instead of appearing as two separate entries.
        return built.revisionId;
      }

      // Delete of a never-pushed file: drop the local mapping without a revision.
      await this.options.store.save(
        applyCommit(state, commit, {
          fileId: operation.fileId,
          revisionId: null,
          isDelete: true,
        }),
      );
      await this.seedSharedState(operation);
      return null;
    });
  }

  /**
   * Mirrors a committed local change into the SHARED apply-side ownership+base
   * so a later remote edit to a locally-authored file updates in place instead
   * of forever diverting to a conflict artifact. A create/update/rename seeds the
   * owner+base (and forgets the prior path on a rename); a delete forgets both.
   */
  private async seedSharedState(operation: LocalChangeCommit['operation']): Promise<void> {
    if (operation.kind === 'delete') {
      await this.options.onLocalForgotten?.({
        fileId: operation.fileId,
        path: operation.path,
      });
      return;
    }
    if (operation.contentHash === null) return;
    await this.options.onLocalMaterialized?.({
      fileId: operation.fileId,
      path: operation.path,
      contentHash: operation.contentHash,
      // Seed the merge ancestor from the authored markdown text; a binary file
      // (base64 in `content`) never merges, so it passes null.
      content: operation.contentKind === 'binary' ? null : operation.content,
      previousPath: operation.previousPath,
    });
  }

  /**
   * Adopts, without enqueuing, the producer mapping+head for a file the apply
   * side just materialised from a remote revision. This keeps the producer's
   * fileId↔path↔content map in lockstep with the vault write, so the vault event
   * that write triggers dedupes to a no-op instead of (a) re-pushing the peer's
   * edit, (b) recording it as LOCAL activity, or (c) minting a fresh random
   * fileId for the same path (a duplicate fileId across devices).
   */
  async adoptRemoteMapping(
    mapping: LocalFileMapping,
    headRevisionId: string,
  ): Promise<void> {
    return this.mutations.runExclusive('state', async () => {
      const state = await this.options.store.load();
      const mappings = upsertMapping(state.mappings, mapping);
      await this.options.store.save({
        mappings,
        heads: { ...state.heads, [mapping.fileId]: headRevisionId },
      });
    });
  }

  /** Forgets the producer mapping+head for a file the apply side just deleted. */
  async forgetRemoteMapping(collisionKey: string, fileId: string): Promise<void> {
    return this.mutations.runExclusive('state', async () => {
      const state = await this.options.store.load();
      const mappings = state.mappings.filter(
        (mapping) =>
          mapping.collisionKey !== collisionKey && mapping.fileId !== fileId,
      );
      const heads = { ...state.heads };
      delete heads[fileId];
      await this.options.store.save({ mappings, heads });
    });
  }
}

function upsertMapping(
  mappings: readonly LocalFileMapping[],
  upsert: LocalFileMapping,
): LocalFileMapping[] {
  const next = mappings.filter(
    (mapping) =>
      mapping.fileId !== upsert.fileId &&
      mapping.collisionKey !== upsert.collisionKey,
  );
  next.push(upsert);
  return next;
}

function resolveOperation(
  kind: LocalChangeKind,
  head: string | undefined,
): RevisionEnvelopeOperation {
  const mapped = OPERATION_BY_KIND[kind];
  // An update/rename/delete without a known head cannot reference a parent, so
  // it is demoted to a root create (except delete, handled by the caller).
  if (mapped !== 'create' && mapped !== 'delete' && head === undefined) {
    return 'create';
  }
  return mapped;
}

function applyCommit(
  state: ProducerState,
  commit: LocalChangeCommit,
  head: { fileId: string; revisionId: string | null; isDelete: boolean },
): ProducerState {
  const mappings = nextMappings(state.mappings, commit);
  const heads = { ...state.heads };
  if (head.isDelete) {
    delete heads[head.fileId];
  } else if (head.revisionId !== null) {
    heads[head.fileId] = head.revisionId;
  }
  return { mappings, heads };
}

function nextMappings(
  mappings: readonly LocalFileMapping[],
  commit: LocalChangeCommit,
): readonly LocalFileMapping[] {
  let next = [...mappings];
  if (commit.removeFileId !== null) {
    next = next.filter((mapping) => mapping.fileId !== commit.removeFileId);
  }
  if (commit.upsertMapping !== null) {
    next = upsertMapping(next, commit.upsertMapping);
  }
  return next;
}
