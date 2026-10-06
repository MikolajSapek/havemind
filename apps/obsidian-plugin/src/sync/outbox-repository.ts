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
  FileStat,
  LocalChangeCommit,
  LocalChangeKind,
  LocalChangeOperation,
  LocalChangeRepository,
  LocalFileMapping,
} from '../obsidian/vault-adapter';
import type { OutboxEnvelope } from '../runtime/sync-state';
import { KeyedMutex } from '../runtime/keyed-mutex';
import { mappingMetadata, type ProducerRecovery, type ProducerRecoveryPort } from '../runtime/producer-recovery';

/**
 * Effective per-payload ceiling for a BINARY attachment (F9). A 25 MiB file
 * ({@link MAX_BINARY_FILE_BYTES}) is ~33.4 MiB once base64-encoded, plus the
 * JSON envelope (path, blobByteHash, field names). The observer already
 * excludes over-cap files before they reach here, so this ceiling is the
 * belt-and-braces stop that keeps an oversized binary from silently wedging
 * the outbox, the same role the default markdown ceiling plays. It equals the
 * server's DEFAULT_MAX_PAYLOAD_BYTES: anything above that would pass here and
 * be refused by the server (tests/attachment-limits.test.ts).
 */
export const MAX_BINARY_PAYLOAD_BYTES = 36 * 1024 * 1024;

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

export interface OutboxLocalChangeRepositoryOptions {
  /** The durable journal every queue write goes through with its mapping. */
  readonly recovery: ProducerRecoveryPort;
  readonly identity: PushIdentity;
  readonly store: ProducerStorePort;
  readonly generateRevisionId: () => string;
  readonly hasAuthoredRevision?: (revisionId: string) => Promise<boolean>;
  /**
   * Parents of a quarantined revision, undefined when it is not quarantined.
   * A head the server never received is walked back through these, so the
   * next edit does not name a dead parent and get refused as missing-parent.
   */
  readonly quarantinedParents?: (revisionId: string) => Promise<readonly string[] | undefined>;
  /**
   * Effective per-payload byte ceiling. A change whose payload would exceed it
   * is rejected here, before enqueue, with a surfaced
   * `RevisionPayloadTooLargeError`, so an oversized note can never silently wedge
   * the outbox. Defaults to the sync-core default (the server's per-payload
   * limit).
   */
  readonly maxPayloadBytes?: number;
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

  private async saveState(state: ProducerState): Promise<void> {
    // Metadata only: a merge caller supplies its mapping with the note text.
    await this.options.store.save({ ...state, mappings: state.mappings.map(mappingMetadata) });
  }

  /**
   * P7: records the startup scan's file stats in one save, only on mappings
   * whose hash is still the one the scan verified against the disk.
   */
  async recordStats(
    entries: readonly { fileId: string; contentHash: string; stat: FileStat }[],
  ): Promise<void> {
    await this.mutations.runExclusive('state', async () => {
      const state = await this.options.store.load();
      const byFile = new Map(entries.map((entry) => [entry.fileId, entry]));
      let changed = false;
      const mappings = state.mappings.map((mapping) => {
        const entry = byFile.get(mapping.fileId);
        if (entry === undefined || entry.contentHash !== mapping.contentHash) return mapping;
        changed = true;
        return { ...mapping, stat: entry.stat };
      });
      if (changed) await this.saveState({ ...state, mappings });
    });
  }

  async recover(): Promise<void> {
    await this.mutations.runExclusive('state', () => this.recoverLocked());
  }

  private async recoverLocked(): Promise<void> {
    // Each entry is finished, producer included, and dropped in one write.
    for (const record of await this.options.recovery.pendingProducerRecoveries()) {
      if (this.activeApplies.has(record.id)) continue;
      await this.options.recovery.recoverProducerQueue(record.id);
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
      await this.options.recovery.startProducerRecovery(record);
      this.activeApplies.add(record.id);
      const rollback = async (): Promise<void> => {
        this.activeApplies.delete(record.id);
        await this.recover();
      };
      return Object.assign(rollback, { complete: async () => {
        await this.options.recovery.completeProducerRecovery(record.id);
        this.activeApplies.delete(record.id);
      } });
    });
  }

  async commitHeadResolution(input: {
    mapping: LocalFileMapping & { content: string }; expectedHead: string; pendingIds: readonly string[];
    parents: readonly string[]; existingRevisionId?: string;
  }): Promise<void> {
    await this.mutations.runExclusive('state', async () => {
      await this.recoverLocked();
      const recovery = this.options.recovery;
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
      await recovery.commitProducerChange(record, replacement);
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
    readonly mapping: LocalFileMapping & { content: string };
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
      await this.options.recovery.enqueueAutomaticMerge({
        header: built.header,
        idempotencyKey: built.idempotencyKey,
        payloadBase64: built.payloadBase64,
        operationId: revisionId,
        revisionId,
        fileId: mapping.fileId,
        contentHash: built.contentHash,
      });
      await this.saveState({
        mappings: upsertMapping(state.mappings, mapping),
        heads: { ...state.heads, [mapping.fileId]: revisionId },
      });
      return true;
    });
  }

  /**
   * Publishes a local change in ONE write (A1): the queue entry, the producer's
   * files and heads, and the owners and bases the apply side reads. Written
   * apart, a failure between them left a queued revision whose file had no
   * mapping, and the next scan minted a second identity for it (2026-09-19:
   * seven file ids for three blobs). The record covers every file the commit
   * changes, since an upsert can displace another file on the same path.
   */
  private async commitAtomically(
    before: ProducerState,
    next: ProducerState,
    operation: LocalChangeOperation,
    envelope?: OutboxEnvelope,
  ): Promise<void> {
    const fileIds = [...new Set([operation.fileId, ...changedFiles(before, next)])];
    const ids = new Set(fileIds);
    const text = operation.contentKind === 'binary' || operation.content === null ? undefined : operation.content;
    const record: ProducerRecovery = {
      id: this.options.generateRevisionId(),
      kind: 'resolution',
      fileIds,
      state: {
        // The note text seeds the merge ancestor on first authorship.
        mappings: next.mappings.filter((m) => ids.has(m.fileId)).map((m) =>
          m.fileId === operation.fileId && text !== undefined ? { ...m, content: text } : m),
        heads: Object.fromEntries(Object.entries(next.heads).filter(([id]) => ids.has(id))),
      },
      discardRevisionIds: [],
    };
    // A refused commit retries through the observer's error recovery; the
    // user's file is still on disk.
    if (!(await this.options.recovery.commitProducerChange(record, envelope))) {
      throw new Error('Local commit recovery transaction was refused.');
    }
  }

  /**
   * The parents a new revision of a file may name: its head, or, when the head
   * was quarantined and so never reached the server, the head's own parents,
   * walked back until none of them is quarantined. A head whose parents were
   * never recorded is kept as it is.
   */
  private async liveParents(head: string | undefined): Promise<readonly string[]> {
    if (head === undefined) return [];
    const lookup = this.options.quarantinedParents;
    if (lookup === undefined) return [head];
    const live: string[] = [];
    const seen = new Set<string>();
    const pending = [head];
    while (pending.length > 0) {
      const id = pending.shift() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      const parents = await lookup(id);
      if (parents === undefined) live.push(id);
      else pending.push(...parents);
    }
    return live;
  }

  async commitLocalChange(commit: LocalChangeCommit): Promise<string | null> {
    return this.mutations.runExclusive('state', async () => {
      await this.recoverLocked();
      const state = await this.options.store.load();
      const { operation } = commit;
      const liveParents = await this.liveParents(state.heads[operation.fileId]);
      const head = liveParents.length === 0 ? undefined : liveParents[0];
      const kind = operation.kind;
      const envelopeOperation = resolveOperation(kind, head);

      // A delete with no server-side head has nothing to tombstone remotely.
      if (!(kind === 'delete' && head === undefined)) {
        const parentRevisionIds =
          envelopeOperation === 'create' || head === undefined ? [] : liveParents;
        const revisionId = this.options.generateRevisionId();
        // buildRevisionEnvelope throws RevisionPayloadTooLargeError for an
        // oversized change. It propagates out of commitLocalChange BEFORE the
        // enqueue and the store.save below, so a too-large note is surfaced to the
        // caller and never enters the outbox (no silent wedge, no state mutation).
        // A binary change (F9) is a whole-file replace over RAW bytes: the observer
        // stored those bytes as base64 in `content`, which is handed to the codec
        // as it is with `kind: 'binary'` (never markdown `content`, which would be
        // canonicalised). The base64 of a 25 MB file needs a raised ceiling, so
        // binary uses {@link MAX_BINARY_PAYLOAD_BYTES} rather than the markdown
        // default.
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
                binaryContentBase64: operation.content ?? '',
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

        await this.commitAtomically(state, next, operation, envelope);
        // The real, server-facing revision id, never `operation.operationId`
        // (a client-only idempotency key). Callers (the Activity feed) must
        // record this id so a local push and its later remote echo collapse by
        // revisionId instead of appearing as two separate entries.
        return built.revisionId;
      }

      // Delete of a never-pushed file: drop the local mapping without a revision.
      await this.commitAtomically(state, applyCommit(state, commit, {
        fileId: operation.fileId,
        revisionId: null,
        isDelete: true,
      }), operation);
      return null;
    });
  }

  /**
   * Adopts, without enqueuing, the producer mapping+head for a file the apply
   * side just materialised from a remote revision. This keeps the producer's
   * fileId↔path↔hash map in lockstep with the vault write, so the vault event
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
      await this.saveState({
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
      await this.saveState({ mappings, heads });
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

/** Every file whose mapping or head differs between two producer states. */
function changedFiles(before: ProducerState, after: ProducerState): string[] {
  const shape = (state: ProducerState) =>
    new Map(state.mappings.map((m) => [m.fileId, JSON.stringify(mappingMetadata(m))]));
  const was = shape(before);
  const now = shape(after);
  const ids = new Set([...was.keys(), ...now.keys(), ...Object.keys(before.heads), ...Object.keys(after.heads)]);
  return [...ids].filter((id) => was.get(id) !== now.get(id) || before.heads[id] !== after.heads[id]);
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
