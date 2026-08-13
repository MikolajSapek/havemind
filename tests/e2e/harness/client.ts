/**
 * A single fault-harness client. It drives the *real* plugin sync stack:
 *
 *  - `VaultChangeObserver` + `reconcileVaultState` (vault-adapter,
 *    reconciliation) turn in-memory vault edits into local change operations;
 *  - `buildRevisionEnvelope` / `decodeRevisionPayload` (sync-core) build and
 *    read the opaque revision payload, so the canonical vault path travels
 *    inside the payload exactly as it does in production (the server never sees
 *    it);
 *  - `listSyncableConfigPaths` + `pollConfigOnce` (config-adapter,
 *    config-poller) discover `.obsidian/` config changes through a
 *    DataAdapter-shaped port, because Obsidian surfaces hidden files through
 *    neither `vault.getFiles()` nor a vault event;
 *  - `SyncRunner` (sync-runner) performs durable push/pull and the safe
 *    remote-apply decision.
 *
 * Only the transport and the vault/config/state ports are harness-owned glue —
 * the same seam the production plugin fills with HTTP + IndexedDB + Obsidian.
 * The transport speaks to the opaque server exactly over the wire routes, so the
 * server never computes a diff, provenance or merge on the client's behalf.
 */
import { randomUUID } from 'node:crypto';

import {
  canonicalizeMarkdown,
  isSyncableConfigPath,
  sha256Hex,
} from '@havemind/protocol';
import {
  buildRevisionEnvelope,
  decodeRevisionPayload,
  type RevisionEnvelopeOperation,
} from '@havemind/sync-core';

import {
  VaultChangeObserver,
  type LocalChangeCommit,
  type LocalChangeOperation,
  type LocalChangeRepository,
  type LocalFileMapping,
  type VaultSnapshotPort,
} from '../../../apps/obsidian-plugin/src/obsidian/vault-adapter.js';
import type { RemoteAppliedInfo } from '../../../apps/obsidian-plugin/src/runtime/activity-log.js';
import type { ConfigApplyReloader } from '../../../apps/obsidian-plugin/src/runtime/obsidian-adapters.js';
import {
  CONFIG_DIR,
  listSyncableConfigPaths,
  removeConfig,
  writeConfigText,
  type ConfigAdapterListing,
  type ConfigAdapterPort,
} from '../../../apps/obsidian-plugin/src/sync/config-adapter.js';
import { mergeConfigContent } from '../../../apps/obsidian-plugin/src/sync/config-normalize.js';
import { pollConfigOnce } from '../../../apps/obsidian-plugin/src/sync/config-poller.js';
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

const CONFLICT_DIR = 'Havemind Conflicts';

interface PushRecord {
  readonly revisionId: string;
  readonly fileId: string;
  readonly contentHash: string;
  /** Canonical text, or `null` for a delete tombstone. */
  readonly content: string | null;
  readonly operation: RevisionEnvelopeOperation;
  readonly path: string;
  readonly previousPath: string | null;
  readonly parents: readonly string[];
  readonly idempotencyKey: string;
}

/**
 * The hidden `.obsidian/` tree, reachable ONLY through this DataAdapter-shaped
 * port. Real Obsidian never returns a hidden file from `vault.getFiles()` and
 * fires no vault event when one changes, so keeping the config tree in a store
 * the vault file API cannot see is what makes the config-mirror e2e a genuine
 * pipeline test: the only way to discover a config file is the production walk
 * (`listSyncableConfigPaths`) over this port.
 */
class InMemoryConfigAdapter implements ConfigAdapterPort {
  /** Hidden files present on this device's disk, including denylisted ones. */
  readonly files = new Map<string, string>();
  /** Directories explicitly created via `mkdir` (implicit ones come from files). */
  readonly #folders = new Set<string>();

  async list(path: string): Promise<ConfigAdapterListing> {
    if (!this.#directoryExists(path)) {
      // Obsidian's DataAdapter rejects a directory that does not exist; the
      // production walk relies on catching that so a fresh vault never wedges.
      throw new Error(`no such config directory: ${path}`);
    }
    const prefix = `${path}/`;
    const files: string[] = [];
    const folders = new Set<string>();
    for (const candidate of [...this.files.keys(), ...this.#folders]) {
      if (!candidate.startsWith(prefix)) continue;
      const rest = candidate.slice(prefix.length);
      const separator = rest.indexOf('/');
      if (separator === -1) {
        if (this.files.has(candidate)) {
          files.push(candidate);
        } else {
          folders.add(candidate);
        }
        continue;
      }
      folders.add(`${prefix}${rest.slice(0, separator)}`);
    }
    return { files: files.sort(), folders: [...folders].sort() };
  }

  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`no such config file: ${path}`);
    }
    return content;
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const bytes = new TextEncoder().encode(await this.read(path));
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
  }

  async write(path: string, data: string): Promise<void> {
    // Like the real adapter, a write into a directory that does not exist yet
    // fails — which is exactly what makes `ensureConfigParentDirs` (production)
    // load-bearing for a brand-new `.obsidian/plugins/<foreign>/` folder.
    this.#assertParentExists(path);
    this.files.set(path, data);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    await this.write(path, new TextDecoder().decode(new Uint8Array(data)));
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.#directoryExists(path);
  }

  async mkdir(path: string): Promise<void> {
    this.#folders.add(path);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  #directoryExists(path: string): boolean {
    if (this.#folders.has(path)) return true;
    const prefix = `${path}/`;
    return [...this.files.keys()].some((file) => file.startsWith(prefix));
  }

  #assertParentExists(path: string): void {
    const separator = path.lastIndexOf('/');
    if (separator === -1) return;
    const parent = path.slice(0, separator);
    if (!this.#directoryExists(parent)) {
      throw new Error(`no such config directory: ${parent}`);
    }
  }
}

/** In-memory vault contents shared by the snapshot port and apply port. */
class InMemoryVault implements VaultSnapshotPort {
  /** The `vault.getFiles()` analogue: visible vault files, never hidden ones. */
  readonly files = new Map<string, string>();
  /** The hidden `.obsidian/` tree, reachable only through the DataAdapter port. */
  readonly config = new InMemoryConfigAdapter();

  /**
   * Writes a visible vault file. A `.obsidian/` path is REJECTED here: real
   * Obsidian cannot touch a hidden file through the Vault API, and letting one
   * into `files` would make it visible to `getFiles()` — the exact fiction that
   * would let a config-mirror test pass without the DataAdapter walk working.
   */
  setFile(path: string, content: string): void {
    if (isSyncableConfigPath(path)) {
      throw new Error(`a config path must be written through the adapter: ${path}`);
    }
    this.files.set(path, content);
  }

  async listSyncablePaths(): Promise<readonly string[]> {
    // Production parity (`obsidian-adapters.ts` snapshot.listSyncablePaths):
    // vault files from the file API PLUS the `.obsidian/` walk over the
    // DataAdapter, because `getFiles()` never returns a hidden file.
    return [
      ...this.files.keys(),
      ...(await listSyncableConfigPaths(this.config, CONFIG_DIR)),
    ];
  }

  async readText(path: string): Promise<string> {
    if (isSyncableConfigPath(path)) {
      return (await this.config.exists(path)) ? this.config.read(path) : '';
    }
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`vault has no file at ${path}`);
    }
    return content;
  }

  async readBinary(): Promise<Uint8Array> {
    // This harness only ever models markdown notes and TEXT config files; no
    // path it tracks classifies as binary, so this is never invoked for a real
    // file. Kept only to satisfy the VaultSnapshotPort interface.
    return new Uint8Array(0);
  }

  async listAllPaths(): Promise<readonly string[]> {
    // Every visible vault file. Config is deliberately excluded (production
    // parity): it is enumerated through the adapter, not `getFiles()`.
    return [...this.files.keys()];
  }

  async exists(path: string): Promise<boolean> {
    if (isSyncableConfigPath(path)) return this.config.exists(path);
    return this.files.has(path);
  }
}

/** In-memory local-change repository; drains committed operations. */
class InMemoryChangeRepository implements LocalChangeRepository {
  readonly #mappings = new Map<string, LocalFileMapping>();
  readonly drained: LocalChangeOperation[] = [];

  async commitLocalChange(commit: LocalChangeCommit): Promise<string | null> {
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
    // The harness's #stage() mints its own revisionId independently (it
    // models the full outbox, not just this repository seam), so this
    // return value is unused here — kept null rather than duplicating that
    // id-generation logic.
    return null;
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

  /** Drops the mapping for a remotely applied delete (the tombstone's twin). */
  forgetRemoteMapping(collisionKey: string): void {
    this.#mappings.delete(collisionKey);
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

/** Optional seams a spec can attach to one harness device. */
export interface HarnessClientOptions {
  /**
   * The production config-apply reloader
   * (`createConfigApplyReloader`), notified after every successful `.obsidian/`
   * apply — write or delete — exactly as the live `createVaultFilePort` notifies
   * it from its own `.obsidian/` branch. That port needs a real Obsidian `Vault`
   * with a DataAdapter, which this harness does not model, so the harness makes
   * the same call at the same point in its apply path; the port-side call site is
   * unit-tested in `runtime/obsidian-adapters.test.ts`. Omitted by default: a
   * client without it still writes the bytes correctly and simply cannot refresh
   * a UI, which is what every disk-state-only spec wants.
   */
  readonly configApply?: ConfigApplyReloader;
}

export class HarnessClient {
  readonly #harness: ServerHarness;
  readonly #identity: ClientIdentity;
  readonly #vault = new InMemoryVault();
  readonly #repository = new InMemoryChangeRepository();
  readonly #observer: VaultChangeObserver;
  readonly #configApply: ConfigApplyReloader | undefined;
  /** Every remote revision this device genuinely applied, in apply order. */
  readonly #appliedRemote: RemoteAppliedInfo[] = [];

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
  #offline = false;
  #lastPushReceipts: readonly PushReceipt[] = [];
  readonly #backoffDelays: number[] = [];

  public constructor(
    harness: ServerHarness,
    identity: ClientIdentity,
    options: HarnessClientOptions = {},
  ) {
    this.#harness = harness;
    this.#identity = identity;
    this.#configApply = options.configApply;
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

  /**
   * Every remote revision this device genuinely applied, in apply order, with the
   * facts DECODED from the server's relayed payload (path, operation) rather than
   * anything a test supplied. This is what the runtime feeds the Activity feed —
   * and through it the author overlay — on the apply path.
   */
  public appliedRemote(): readonly RemoteAppliedInfo[] {
    return [...this.#appliedRemote];
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
    this.#vault.setFile(path, normalized);
    await this.#drainAndStage(async () =>
      reconcileVaultState({
        observer: this.#observer,
        repository: this.#repository,
        vault: this.#vault,
      }),
    );
  }

  /**
   * Writes a hidden `.obsidian/` file the way the only actors that ever do
   * write one behave: Obsidian itself, or a foreign plugin, straight through the
   * DataAdapter and with NO vault event. That silence is precisely why the
   * mirror needs a poller, so nothing is staged until {@link pollConfig} runs.
   */
  public async writeConfig(path: string, content: string): Promise<void> {
    await writeConfigText(this.#vault.config, path, content);
  }

  /** Removes a hidden config file (an external actor deleting it). */
  public async deleteConfig(path: string): Promise<void> {
    await removeConfig(this.#vault.config, path);
  }

  /** Current content of a hidden config file on this device (or undefined). */
  public readConfig(path: string): string | undefined {
    return this.#vault.config.files.get(path);
  }

  /**
   * Every hidden config path on this device's disk — INCLUDING denylisted ones,
   * so a test can prove no secret was ever materialised here.
   */
  public configPaths(): string[] {
    return [...this.#vault.config.files.keys()].sort();
  }

  /**
   * Runs one production config poll tick (`pollConfigOnce`) over the DataAdapter
   * walk and stages every genuine change it enqueued, exactly as `edit()` stages
   * a note change. Returns the operations the tick produced (empty in steady
   * state — the content-hash cycle guard).
   */
  public async pollConfig(): Promise<readonly LocalChangeOperation[]> {
    let ops: readonly LocalChangeOperation[] = [];
    await this.#drainAndStage(async () => {
      ops = await pollConfigOnce({
        listConfigPaths: () =>
          listSyncableConfigPaths(this.#vault.config, CONFIG_DIR),
        listMappings: () => this.#repository.listMappings(),
        observer: this.#observer,
      });
    });
    return ops;
  }

  /** Drops the transport: every push/pull fails transiently (a network outage). */
  public goOffline(): void {
    this.#offline = true;
  }

  /** Restores the transport. */
  public goOnline(): void {
    this.#offline = false;
  }

  /**
   * Backoff delays the runner armed after a failed cycle. The harness scheduler
   * records them without firing (cycles are driven explicitly), so a test can
   * prove a retry WAS scheduled rather than the failure being swallowed.
   */
  public scheduledBackoffs(): readonly number[] {
    return [...this.#backoffDelays];
  }

  /** Runs a producer pass and stages every change it committed to the outbox. */
  async #drainAndStage(pass: () => Promise<void>): Promise<void> {
    this.#repository.drained.length = 0;
    await pass();
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
    if (operation.contentKind === 'binary') {
      // Every path this harness models (markdown notes and TEXT config files)
      // classifies as text; a binary revision would need the base64 payload
      // path, which belongs to `onboarding-two-device.test.ts`.
      throw new Error(
        `the fault harness models text revisions only: ${operation.path}`,
      );
    }
    const isDelete = operation.kind === 'delete';
    const revisionId = randomUUID();
    const parents =
      operation.kind === 'create' ? [] : this.#parentsFor(operation.fileId);
    const contentHash = isDelete
      ? (operation.previousContentHash ?? '')
      : (operation.contentHash ?? '');
    this.#state.outbox.set(revisionId, {
      content: isDelete ? null : (operation.content ?? ''),
      contentHash,
      fileId: operation.fileId,
      idempotencyKey: randomUUID(),
      operation: operation.kind,
      parents,
      path: operation.path,
      previousPath: operation.previousPath,
      revisionId,
    });
    this.#headByFile.set(operation.fileId, revisionId);

    if (isDelete) {
      return;
    }
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
      // The harness drives cycles explicitly, so a backoff retry never fires on
      // a real timer — but the armed delay is recorded so a test can assert that
      // a failed cycle DID schedule a retry (see `scheduledBackoffs`).
      scheduler: (_callback, delayMs) => {
        this.#backoffDelays.push(delayMs);
      },
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
    if (this.#offline) {
      // A transient transport failure (no `permanent`/`authDenied` marker), so
      // the runner reports 'offline' and arms a backoff retry.
      throw new Error('simulated transport offline');
    }
    const records = revisions.map((revision) => {
      const record = this.#state.outbox.get(revision.revisionId);
      if (record === undefined) {
        throw new Error(`outbox lost revision ${revision.revisionId}`);
      }
      return record;
    });

    // The REAL producer envelope (`@havemind/sync-core`): the protected header
    // plus an opaque payload carrying the canonical vault path. Rebuilding it
    // from the unchanged outbox record is byte-deterministic, so a re-delivery
    // after a lost receipt hits the server's idempotency replay rather than
    // committing a second revision.
    const envelopes = await Promise.all(
      records.map(async (record) =>
        buildRevisionEnvelope({
          content: record.content,
          idempotencyKey: record.idempotencyKey,
          identity: {
            deviceId: this.#identity.deviceId,
            fileId: record.fileId,
            memberId: this.#identity.membershipId,
            vaultId: this.#identity.vaultId,
          },
          operation: record.operation,
          parentRevisionIds: record.parents,
          path: record.path,
          revisionId: record.revisionId,
          ...(record.previousPath === null
            ? {}
            : { previousPath: record.previousPath }),
        }),
      ),
    );

    const response = await this.#harness.app.inject({
      headers: { authorization: `Bearer ${this.#identity.accessToken}` },
      method: 'POST',
      payload: {
        revisions: envelopes.map((envelope) => ({
          header: envelope.header,
          idempotencyKey: envelope.idempotencyKey,
          payload: envelope.payloadBase64,
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
    if (this.#offline) {
      throw new Error('simulated transport offline');
    }
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
        receipt: { blobHash: string; parentRevisionIds?: string[] };
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
        // Carry the relayed DAG parents so the runner's apply side can prove a
        // causal fast-forward exactly as production does (rule 3).
        ...(event.receipt.parentRevisionIds === undefined
          ? {}
          : { parentRevisionIds: event.receipt.parentRevisionIds }),
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
    // The canonical target path travels inside the opaque payload (the server
    // never sees it), so materialising a remote revision means DECODING it with
    // the production codec — the same thing the plugin's apply adapter does.
    const decoded = await this.#decodePayload(event);
    const collisionKey = decoded.path.normalize('NFC').toLowerCase();

    if (decoded.operation === 'delete') {
      await this.#removeLocal(decoded.path);
      this.#repository.forgetRemoteMapping(collisionKey);
      this.#headByFile.set(event.revision.fileId, event.revision.revisionId);
      this.#recordApplied(event, decoded);
      return;
    }

    const content = canonicalizeMarkdown(decoded.content ?? '');
    await this.#materialize(decoded.path, content);
    // Bind the server's authoritative fileId to this path as the new synced
    // base, so a later local edit produces a child revision of exactly this
    // remote revision instead of a spurious unrelated file. The adopted hash is
    // the CONTENT hash (what the producer computes when it re-reads the file),
    // never the payload/blob hash — otherwise the next producer pass would see a
    // mismatch and re-push the peer's own bytes back at it.
    const contentHash = await sha256Hex(content);
    this.#repository.setRemoteMapping({
      collisionKey,
      content,
      contentHash,
      fileId: event.revision.fileId,
      path: decoded.path,
    });
    this.#headByFile.set(event.revision.fileId, event.revision.revisionId);
    const buffer = this.#openBuffers.get(event.revision.fileId);
    if (buffer !== undefined) {
      this.#openBuffers.set(event.revision.fileId, {
        baseHash: contentHash,
        currentHash: contentHash,
      });
    }
    this.#recordApplied(event, decoded);
  }

  /**
   * Records a GENUINELY applied remote revision (never a conflict — those land in
   * `#recordConflict` and are not this device learning a new head for the path).
   * The runtime records the same facts at the same point, plus a wall-clock
   * timestamp and the bootstrap/live origin the production apply adapter owns.
   */
  #recordApplied(
    event: RemoteEvent,
    decoded: ReturnType<typeof decodeRevisionPayload>,
  ): void {
    this.#appliedRemote.push({
      fileId: event.revision.fileId,
      operation: decoded.operation,
      path: decoded.path,
      revisionId: event.revision.revisionId,
    });
  }

  async #recordConflict(event: RemoteEvent): Promise<void> {
    const decoded = await this.#decodePayload(event);
    const conflictPath = `${CONFLICT_DIR}/${event.revision.fileId}-${event.revision.revisionId}.md`;
    this.#vault.setFile(
      conflictPath,
      canonicalizeMarkdown(decoded.content ?? ''),
    );
  }

  /** Fetches a revision's opaque payload and decodes it (production codec). */
  async #decodePayload(
    event: RemoteEvent,
  ): Promise<ReturnType<typeof decodeRevisionPayload>> {
    const decoded = decodeRevisionPayload(
      await this.#fetchBlob(event.revision.contentHash),
    );
    if (decoded.kind === 'binary') {
      throw new Error(
        `the fault harness models text revisions only: ${decoded.path}`,
      );
    }
    return decoded;
  }

  /**
   * Writes an applied revision where the real device would: a `.obsidian/`
   * config path goes through the DataAdapter (materialising parent dirs), every
   * other path through the vault file API.
   */
  async #materialize(path: string, content: string): Promise<void> {
    if (isSyncableConfigPath(path)) {
      // MERGE, never replace — the same production call `createVaultFilePort`
      // makes from its own `.obsidian/` write branch, with the same arguments
      // (`mergeConfigContent`, real module). For `.obsidian/graph.json` the
      // incoming semantic keys are overlaid onto what is on disk, so this device
      // keeps its own graph zoom and panel folds while adopting the peer's colour
      // groups; every other config path is written verbatim. HARNESS GLUE for the
      // same reason the config-apply reloader is glue here: the live port needs an
      // Obsidian `Vault` with a DataAdapter, which this harness does not model, so
      // it calls the real function at the same point in its own apply path. The
      // port-side call site is unit-tested in `runtime/obsidian-adapters.test.ts`.
      const local = (await this.#vault.config.exists(path))
        ? await this.#vault.config.read(path)
        : null;
      await writeConfigText(
        this.#vault.config,
        path,
        mergeConfigContent(path, local, content),
      );
      // The bytes alone change nothing the user can see — Obsidian caches its
      // config in memory. Report the apply exactly as `createVaultFilePort` does
      // from its own `.obsidian/` write branch, so the batch can refresh the CSS
      // or tell the user a reload is needed.
      this.#configApply?.applied(path);
      return;
    }
    this.#vault.setFile(path, content);
  }

  /** Removes a locally materialised file, honouring the same config split. */
  async #removeLocal(path: string): Promise<void> {
    if (isSyncableConfigPath(path)) {
      await removeConfig(this.#vault.config, path);
      // A removal is the same visibility problem in reverse: a snippet the peer
      // deleted keeps styling this vault until Obsidian re-reads its CSS.
      this.#configApply?.applied(path);
      return;
    }
    this.#vault.files.delete(path);
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
}
