/**
 * A single fault-harness client. It drives the *real* plugin sync stack:
 *
 *  - `VaultChangeObserver` + `reconcileVaultState` (vault-adapter,
 *    reconciliation) turn in-memory vault edits into local change operations;
 *  - `SyncRunner` (sync-runner) performs durable push/pull and the safe
 *    remote-apply decision.
 *
 * Only the transport and the vault/state ports are harness-owned glue — the
 * same seam the production plugin fills with HTTP + IndexedDB + Obsidian. The
 * transport speaks to the opaque server exactly over the wire routes, so the
 * server never computes a diff, provenance or merge on the client's behalf.
 */
import { randomUUID } from 'node:crypto';

import { PROTOCOL_VERSION } from '@havemind/protocol';

import {
  VaultChangeObserver,
  type LocalChangeCommit,
  type LocalChangeOperation,
  type LocalChangeRepository,
  type LocalFileMapping,
  type VaultSnapshotPort,
} from '../../../apps/obsidian-plugin/src/obsidian/vault-adapter.js';
import { reconcileVaultState } from '../../../apps/obsidian-plugin/src/sync/reconciliation.js';
import {
  SyncRunner,
  type OpenBuffer,
  type PullResult,
  type PushItemResult,
  type PushReceipt,
  type PushRevision,
  type RemoteEvent,
  type SyncCycleResult,
  type SyncStatePort,
  type SyncTransport,
  type VaultApplyPort,
} from '../../../apps/obsidian-plugin/src/sync/sync-runner.js';

import type { ClientIdentity, ServerHarness } from './server.js';

const SEMANTICS = Object.freeze({
  pathNormalization: 'nfc-lowercase-v1',
  payloadFormat: 'revision-payload-v1',
  provenanceRecipe: 'source-range-v1',
  syncSemantics: 'dag-cas-v1',
} as const);

const CONFLICT_DIR = 'Havemind Conflicts';

interface PushRecord {
  readonly revisionId: string;
  readonly fileId: string;
  readonly contentHash: string;
  readonly content: string;
  readonly parents: readonly string[];
  readonly idempotencyKey: string;
}

/** In-memory vault contents shared by the snapshot port and apply port. */
class InMemoryVault implements VaultSnapshotPort {
  readonly files = new Map<string, string>();

  async listMarkdownPaths(): Promise<readonly string[]> {
    return [...this.files.keys()];
  }

  async readText(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`vault has no file at ${path}`);
    }
    return content;
  }

  async listAllPaths(): Promise<readonly string[]> {
    // The e2e harness only ever models markdown notes, so every tracked path
    // is markdown; this mirrors listMarkdownPaths for this fixture.
    return [...this.files.keys()];
  }
}

/** In-memory local-change repository; drains committed operations. */
class InMemoryChangeRepository implements LocalChangeRepository {
  readonly #mappings = new Map<string, LocalFileMapping>();
  readonly drained: LocalChangeOperation[] = [];

  async commitLocalChange(commit: LocalChangeCommit): Promise<void> {
    if (commit.removeFileId !== null) {
      for (const [key, mapping] of this.#mappings) {
        if (mapping.fileId === commit.removeFileId) {
          this.#mappings.delete(key);
        }
      }
    }
    if (commit.upsertMapping !== null) {
      // A rename changes the collision key, so drop any stale key first.
      for (const [key, mapping] of this.#mappings) {
        if (mapping.fileId === commit.upsertMapping.fileId) {
          this.#mappings.delete(key);
        }
      }
      this.#mappings.set(commit.upsertMapping.collisionKey, {
        ...commit.upsertMapping,
      });
    }
    this.drained.push(commit.operation);
  }

  async listMappings(): Promise<readonly LocalFileMapping[]> {
    return [...this.#mappings.values()];
  }

  /**
   * Registers the mapping for a remotely applied revision. Applying a remote
   * revision is not a local edit to observe — it establishes the authoritative
   * fileId↔path binding the server already owns, so it bypasses the observer
   * (which would otherwise mint a fresh, unrelated fileId).
   */
  setRemoteMapping(mapping: LocalFileMapping): void {
    for (const [key, existing] of this.#mappings) {
      if (existing.fileId === mapping.fileId) {
        this.#mappings.delete(key);
      }
    }
    this.#mappings.set(mapping.collisionKey, { ...mapping });
  }
}

/** Durable client state that must survive a client process restart. */
interface DurableClientState {
  cursor: number;
  readonly locallyAuthored: Set<string>;
  readonly outbox: Map<string, PushRecord>;
  storedEpoch: string | undefined;
  reconcileRequested: boolean;
}

export class HarnessClient {
  readonly #harness: ServerHarness;
  readonly #identity: ClientIdentity;
  readonly #vault = new InMemoryVault();
  readonly #repository = new InMemoryChangeRepository();
  readonly #observer: VaultChangeObserver;

  readonly #state: DurableClientState = {
    cursor: 0,
    locallyAuthored: new Set<string>(),
    outbox: new Map<string, PushRecord>(),
    reconcileRequested: false,
    storedEpoch: undefined,
  };

  readonly #headByFile = new Map<string, string>();
  readonly #openBuffers = new Map<string, OpenBuffer>();

  #runner: SyncRunner;
  #failNextApply = false;
  #failNextReceiptRecord = false;
  #sawEpochReconcile = false;
  #lastPushReceipts: readonly PushReceipt[] = [];

  public constructor(harness: ServerHarness, identity: ClientIdentity) {
    this.#harness = harness;
    this.#identity = identity;
    this.#observer = new VaultChangeObserver({
      clock: () => 0,
      generateFileId: () => randomUUID(),
      generateOperationId: () => randomUUID(),
      repository: this.#repository,
      vault: this.#vault,
    });
    this.#runner = this.#buildRunner();
  }

  /** Reads the current materialized content of a vault path (or undefined). */
  public read(path: string): string | undefined {
    return this.#vault.files.get(path);
  }

  /** Every path currently present in the client's vault. */
  public paths(): string[] {
    return [...this.#vault.files.keys()].sort();
  }

  /** Conflict artifacts recorded under `Havemind Conflicts/`. */
  public conflictPaths(): string[] {
    return this.paths().filter((path) => path.startsWith(`${CONFLICT_DIR}/`));
  }

  public sawEpochReconcile(): boolean {
    return this.#sawEpochReconcile;
  }

  public cursor(): number {
    return this.#state.cursor;
  }

  public outboxSize(): number {
    return this.#state.outbox.size;
  }

  /** Receipts returned by the most recent push (for idempotency assertions). */
  public lastPushReceipts(): readonly PushReceipt[] {
    return this.#lastPushReceipts;
  }

  /** Marks a file as open in the editor with its content as the synced base. */
  public async openEditor(path: string): Promise<void> {
    const mapping = await this.#mappingForPath(path);
    if (mapping === undefined) {
      throw new Error(`cannot open unknown file ${path}`);
    }
    this.#openBuffers.set(mapping.fileId, {
      baseHash: mapping.contentHash,
      currentHash: mapping.contentHash,
    });
  }

  /**
   * Applies a local edit exactly as the plugin would: write the file, then let
   * the real reconciliation pass detect the change through the observer and
   * stage a durable outbox revision.
   */
  public async edit(path: string, content: string): Promise<void> {
    const normalized = content.replace(/\r\n?/gu, '\n');
    this.#vault.files.set(path, normalized);
    this.#repository.drained.length = 0;
    await reconcileVaultState({
      observer: this.#observer,
      repository: this.#repository,
      vault: this.#vault,
    });
    for (const operation of this.#repository.drained) {
      this.#stage(operation);
    }
  }

  /** Runs sync cycles until no epoch reconciliation is pending. */
  public async sync(): Promise<SyncCycleResult> {
    let result = await this.#runner.trigger();
    while (this.#state.reconcileRequested) {
      this.#state.reconcileRequested = false;
      result = await this.#runner.trigger();
    }
    return result;
  }

  /** Rebuilds the runner over the same durable state (a client restart). */
  public restartRunner(): void {
    this.#runner = this.#buildRunner();
  }

  /** Arms a one-shot crash in the middle of applying a remote revision. */
  public failNextApply(): void {
    this.#failNextApply = true;
  }

  /** Arms a one-shot crash after the server commits but before recording it. */
  public failNextReceiptRecord(): void {
    this.#failNextReceiptRecord = true;
  }

  #stage(operation: LocalChangeOperation): void {
    if (operation.kind === 'delete') {
      const parents = this.#parentsFor(operation.fileId);
      const revisionId = randomUUID();
      this.#state.outbox.set(revisionId, {
        content: '',
        contentHash: operation.previousContentHash ?? '',
        fileId: operation.fileId,
        idempotencyKey: randomUUID(),
        parents,
        revisionId,
      });
      this.#headByFile.set(operation.fileId, revisionId);
      return;
    }

    const content = operation.content ?? '';
    const contentHash = operation.contentHash ?? '';
    const parents =
      operation.kind === 'create' ? [] : this.#parentsFor(operation.fileId);
    const revisionId = randomUUID();
    this.#state.outbox.set(revisionId, {
      content,
      contentHash,
      fileId: operation.fileId,
      idempotencyKey: randomUUID(),
      parents,
      revisionId,
    });
    this.#headByFile.set(operation.fileId, revisionId);

    const buffer = this.#openBuffers.get(operation.fileId);
    if (buffer !== undefined) {
      this.#openBuffers.set(operation.fileId, {
        baseHash: buffer.baseHash,
        currentHash: contentHash,
      });
    }
  }

  #parentsFor(fileId: string): readonly string[] {
    const head = this.#headByFile.get(fileId);
    return head === undefined ? [] : [head];
  }

  async #mappingForPath(path: string): Promise<LocalFileMapping | undefined> {
    const key = path.normalize('NFC').toLowerCase();
    const mappings = await this.#repository.listMappings();
    return mappings.find((mapping) => mapping.collisionKey === key);
  }

  #buildRunner(): SyncRunner {
    return new SyncRunner({
      random: () => 0,
      // A no-op scheduler: the harness drives cycles explicitly, so backoff
      // retries never need to fire on a real timer.
      scheduler: () => undefined,
      state: this.#statePort(),
      transport: this.#transport(),
      vault: this.#vaultPort(),
    });
  }

  #statePort(): SyncStatePort {
    const state = this.#state;
    return {
      isLocallyAuthored: async (revisionId) =>
        state.locallyAuthored.has(revisionId),
      listOutbox: async () =>
        [...state.outbox.values()].map(
          (record): PushRevision => ({
            contentHash: record.contentHash,
            fileId: record.fileId,
            revisionId: record.revisionId,
          }),
        ),
      loadCursor: async () => state.cursor,
      recordPushReceipt: async (receipt) => {
        if (this.#failNextReceiptRecord) {
          this.#failNextReceiptRecord = false;
          throw new Error('simulated crash before recording push receipt');
        }
        state.outbox.delete(receipt.revisionId);
        state.locallyAuthored.add(receipt.revisionId);
      },
      saveCursor: async (sequence) => {
        state.cursor = sequence;
      },
      quarantineOutboxItem: async (revisionId) => {
        state.outbox.delete(revisionId);
      },
    };
  }

  #transport(): SyncTransport {
    return {
      pull: async (after) => this.#pull(after),
      push: async (revisions) => this.#push(revisions),
    };
  }

  #vaultPort(): VaultApplyPort {
    return {
      applyRemote: async (event) => this.#applyRemote(event),
      openBuffers: async (fileId) => {
        const buffer = this.#openBuffers.get(fileId);
        return buffer === undefined ? [] : [buffer];
      },
      recordConflict: async (event) => this.#recordConflict(event),
    };
  }

  async #push(
    revisions: readonly PushRevision[],
  ): Promise<readonly PushItemResult[]> {
    const records = revisions.map((revision) => {
      const record = this.#state.outbox.get(revision.revisionId);
      if (record === undefined) {
        throw new Error(`outbox lost revision ${revision.revisionId}`);
      }
      return record;
    });

    const response = await this.#harness.app.inject({
      headers: { authorization: `Bearer ${this.#identity.accessToken}` },
      method: 'POST',
      payload: {
        revisions: records.map((record) => ({
          header: {
            expectedDeviceId: this.#identity.deviceId,
            expectedMemberId: this.#identity.membershipId,
            fileId: record.fileId,
            parentRevisionIds: [...record.parents],
            payloadEncoding: 'plaintext-json-v1',
            protocol: PROTOCOL_VERSION,
            revisionId: record.revisionId,
            semantics: SEMANTICS,
            vaultId: this.#identity.vaultId,
          },
          idempotencyKey: record.idempotencyKey,
          payload: Buffer.from(record.content, 'utf8').toString('base64'),
        })),
      },
      url: `/vaults/${this.#identity.vaultId}/revisions`,
    });

    if (response.statusCode !== 200) {
      throw new Error(`push failed with status ${response.statusCode}`);
    }

    const body = response.json() as {
      results: Array<{
        receipt?: { serverSequence: number };
        revisionId: string;
        status: string;
        code?: string;
      }>;
    };
    const results: PushItemResult[] = body.results.map((result) => {
      if (result.status === 'rejected' || result.receipt === undefined) {
        return { revisionId: result.revisionId, outcome: 'rejected' as const };
      }
      return {
        revisionId: result.revisionId,
        outcome: 'accepted' as const,
        receipt: {
          revisionId: result.revisionId,
          serverSequence: result.receipt.serverSequence,
        },
      };
    });
    this.#lastPushReceipts = results.flatMap((result) =>
      result.receipt === undefined ? [] : [result.receipt],
    );
    return results;
  }

  async #pull(after: number): Promise<PullResult> {
    const epochQuery =
      this.#state.storedEpoch === undefined
        ? ''
        : `&epoch=${encodeURIComponent(this.#state.storedEpoch)}`;
    const response = await this.#harness.app.inject({
      headers: { authorization: `Bearer ${this.#identity.accessToken}` },
      method: 'GET',
      url: `/vaults/${this.#identity.vaultId}/events?after=${after}${epochQuery}`,
    });

    if (response.statusCode === 409) {
      // A rotated server epoch (after a restore) invalidates our cursor. The
      // client reconciles: it forgets the stale epoch, rewinds to the start of
      // the event log and re-materializes from the durable server history.
      this.#sawEpochReconcile = true;
      this.#state.storedEpoch = undefined;
      this.#state.cursor = 0;
      this.#state.reconcileRequested = true;
      return { cursor: 0, events: [] };
    }

    if (response.statusCode !== 200) {
      throw new Error(`pull failed with status ${response.statusCode}`);
    }

    const body = response.json() as {
      cursor: number;
      epoch?: string;
      events: Array<{
        fileId: string;
        receipt: { blobHash: string };
        revisionId: string;
        serverSequence: number;
      }>;
    };
    if (body.epoch !== undefined) {
      this.#state.storedEpoch = body.epoch;
    }
    const events: RemoteEvent[] = body.events.map((event) => ({
      revision: {
        contentHash: event.receipt.blobHash,
        fileId: event.fileId,
        revisionId: event.revisionId,
      },
      serverSequence: event.serverSequence,
    }));
    return { cursor: body.cursor, events };
  }

  async #applyRemote(event: RemoteEvent): Promise<void> {
    if (this.#failNextApply) {
      this.#failNextApply = false;
      throw new Error('simulated crash during local apply');
    }
    const content = await this.#fetchBlob(event.revision.contentHash);
    const path = await this.#pathForFile(event.revision.fileId);
    this.#vault.files.set(path, content);
    // Bind the server's authoritative fileId to this path as the new synced
    // base, so a later local edit produces a child revision of exactly this
    // remote revision instead of a spurious unrelated file.
    this.#repository.setRemoteMapping({
      collisionKey: path.normalize('NFC').toLowerCase(),
      content,
      contentHash: event.revision.contentHash,
      fileId: event.revision.fileId,
      path,
    });
    this.#headByFile.set(event.revision.fileId, event.revision.revisionId);
    const buffer = this.#openBuffers.get(event.revision.fileId);
    if (buffer !== undefined) {
      this.#openBuffers.set(event.revision.fileId, {
        baseHash: event.revision.contentHash,
        currentHash: event.revision.contentHash,
      });
    }
  }

  async #recordConflict(event: RemoteEvent): Promise<void> {
    const content = await this.#fetchBlob(event.revision.contentHash);
    const conflictPath = `${CONFLICT_DIR}/${event.revision.fileId}-${event.revision.revisionId}.md`;
    this.#vault.files.set(conflictPath, content);
  }

  async #fetchBlob(blobHash: string): Promise<string> {
    const response = await this.#harness.app.inject({
      headers: { authorization: `Bearer ${this.#identity.accessToken}` },
      method: 'GET',
      url: `/vaults/${this.#identity.vaultId}/blobs/${blobHash}`,
    });
    if (response.statusCode !== 200) {
      throw new Error(`blob fetch failed with status ${response.statusCode}`);
    }
    return response.rawPayload.toString('utf8');
  }

  async #pathForFile(fileId: string): Promise<string> {
    const mappings = await this.#repository.listMappings();
    const existing = mappings.find((mapping) => mapping.fileId === fileId);
    if (existing !== undefined) {
      return existing.path;
    }
    // A never-before-seen remote file: derive a stable, deterministic path from
    // its file id. The canonical path lives in the opaque payload the pilot
    // does not decode here, so both clients simply key off the shared fileId.
    return `remote-${fileId.slice(0, 8)}.md`;
  }
}
