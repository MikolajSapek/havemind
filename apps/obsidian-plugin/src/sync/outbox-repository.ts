/**
 * The push-producer bridge: turns a detected local vault change into a durable
 * outbox revision the sync runner ships to the server.
 *
 * `VaultChangeObserver` (`obsidian/vault-adapter.ts`) detects and classifies a
 * change and hands it here as a `LocalChangeCommit`. This repository builds the
 * opaque revision envelope (`@havemind/sync-core`) and enqueues it, so the next
 * `SyncRunner` cycle POSTs it to `/vaults/:vaultId/revisions`. Without this
 * bridge the outbox is always empty and the client only ever pulls — the root
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
  LocalChangeRepository,
  LocalFileMapping,
} from '../obsidian/vault-adapter';
import type { OutboxEnvelope } from '../runtime/sync-state';

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
  readonly identity: PushIdentity;
  readonly store: ProducerStorePort;
  readonly enqueue: (envelope: OutboxEnvelope) => Promise<void>;
  readonly generateRevisionId: () => string;
  /**
   * Effective per-payload byte ceiling. A change whose payload would exceed it
   * is rejected here — before enqueue — with a surfaced
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

  constructor(options: OutboxLocalChangeRepositoryOptions) {
    this.options = options;
  }

  async listMappings(): Promise<readonly LocalFileMapping[]> {
    return (await this.options.store.load()).mappings;
  }

  async commitLocalChange(commit: LocalChangeCommit): Promise<void> {
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
        content: operation.content,
        idempotencyKey: operation.operationId,
        ...(this.options.maxPayloadBytes === undefined
          ? {}
          : { maxPayloadBytes: this.options.maxPayloadBytes }),
      });

      await this.options.enqueue({
        header: built.header,
        idempotencyKey: built.idempotencyKey,
        payloadBase64: built.payloadBase64,
        operationId: operation.operationId,
        revisionId: built.revisionId,
        fileId: built.fileId,
        contentHash: built.contentHash,
      });

      await this.options.store.save(
        applyCommit(state, commit, {
          fileId: operation.fileId,
          revisionId,
          isDelete: kind === 'delete',
        }),
      );
      return;
    }

    // Delete of a never-pushed file: drop the local mapping without a revision.
    await this.options.store.save(
      applyCommit(state, commit, {
        fileId: operation.fileId,
        revisionId: null,
        isDelete: true,
      }),
    );
  }
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
    const upsert = commit.upsertMapping;
    next = next.filter(
      (mapping) =>
        mapping.fileId !== upsert.fileId &&
        mapping.collisionKey !== upsert.collisionKey,
    );
    next.push(upsert);
  }
  return next;
}
