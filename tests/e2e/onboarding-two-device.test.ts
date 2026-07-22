/**
 * F8-02 — deterministic two-device onboarding + sync end-to-end (Magda flow).
 *
 * Unlike `fault-matrix.test.ts` (which inserts the second member directly into
 * the vault and only exercises the sync loop), this test drives the FULL real
 * onboarding for the invitee against a real, opaque server:
 *
 *   owner setup + pair → owner mints invitation → invitee redeems it →
 *   invitee reaches AWAITING-APPROVAL exposing the 6-digit PIN (never offline) →
 *   owner approves with that PIN → invitee transitions to CONNECTED →
 *   invitee's real sync loop starts and its first cycle is Synced (not Offline) →
 *   invitee edits a note → POST /revisions is accepted with the approval
 *   membershipId → owner pulls and materialises it → owner edits → invitee pulls.
 *
 * Every client piece here is the production code: the onboarding controller
 * (`onboarding/controller.ts`), the refresh-token access provider, the opaque
 * `RequestUrlTransport`, the `SyncRunner`, `DurableSyncState`, the push producer
 * (`OutboxLocalChangeRepository` + `VaultChangeObserver` + `reconcileVaultState`)
 * and the vault-apply adapter. Only the transport and the vault/secret/state
 * ports are harness glue — the same seam the plugin fills with HTTP + Obsidian.
 *
 * This is the deterministic reproduction of the live 2-device pilot bugs:
 *   1. invitee stuck on "Offline — will retry" instead of the waiting-with-PIN
 *      screen / connected;
 *   2. zero revisions server-side from the invitee's device (B→A push).
 */
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../apps/server/src/app.js';
import { SessionRepository } from '../../apps/server/src/auth/session-repository.js';
import {
  createLocalOwnerSetupContext,
  OwnerSetupService,
} from '../../apps/server/src/auth/setup.js';
import { generateRefreshToken as generateServerRefreshToken } from '../../apps/server/src/auth/tokens.js';
import { InvitationService } from '../../apps/server/src/auth/invitations.js';
import { BlobStore } from '../../apps/server/src/blob-store.js';
import { parseServerConfig } from '../../apps/server/src/config.js';
import { openDatabase } from '../../apps/server/src/db.js';
import { runMigrations } from '../../apps/server/src/migrations.js';
import { RevisionRepository } from '../../apps/server/src/revision-repository.js';

import { canonicalizeMarkdown } from '@havemind/protocol';

import { TFile, TFolder } from 'obsidian';

import { createVaultFilePort } from '../../apps/obsidian-plugin/src/runtime/obsidian-adapters.js';
import { OnboardingController } from '../../apps/obsidian-plugin/src/onboarding/controller.js';
import type {
  OnboardingSecretsPort,
  OnboardingViewState,
} from '../../apps/obsidian-plugin/src/onboarding/controller.js';
import { RequestUrlOnboardingApi } from '../../apps/obsidian-plugin/src/runtime/onboarding-api.js';
import { PluginDataOnboardingStore } from '../../apps/obsidian-plugin/src/runtime/onboarding-store.js';
import { createVaultInvitation } from '../../apps/obsidian-plugin/src/runtime/create-invitation.js';
import { approveRedeemedDevice } from '../../apps/obsidian-plugin/src/runtime/approve-device.js';
import { RefreshTokenAccessProvider } from '../../apps/obsidian-plugin/src/runtime/access-token.js';
import { RequestUrlTransport, type RequestUrlFn } from '../../apps/obsidian-plugin/src/runtime/sync-transport.js';
import { DurableSyncState } from '../../apps/obsidian-plugin/src/runtime/sync-state.js';
import { VaultApplyAdapter, type VaultFilePort } from '../../apps/obsidian-plugin/src/runtime/vault-apply.js';
import {
  applyLocalMaterialization,
  forgetLocalMaterialization,
} from '../../apps/obsidian-plugin/src/runtime/local-base-lifecycle.js';
import { buildConnectionResolvers } from '../../apps/obsidian-plugin/src/runtime/connection.js';
import {
  OutboxLocalChangeRepository,
  type ProducerState,
  type ProducerStorePort,
} from '../../apps/obsidian-plugin/src/sync/outbox-repository.js';
import {
  VaultChangeObserver,
  type VaultSnapshotPort,
} from '../../apps/obsidian-plugin/src/obsidian/vault-adapter.js';
import { reconcileVaultState } from '../../apps/obsidian-plugin/src/sync/reconciliation.js';
import {
  SyncRunner,
  type SyncCycleResult,
} from '../../apps/obsidian-plugin/src/sync/sync-runner.js';

const SERVER_ORIGIN = 'https://sync.example.test';
const TEST_ENV = {
  HAVEMIND_API_BASE_URL: SERVER_ORIGIN,
  HAVEMIND_SERVER_NAME: 'Two Device Havemind',
} as const;
const DB_FILENAME = 'havemind.sqlite';
const BLOBS_DIRNAME = 'blobs';
const CONFLICT_FOLDER = 'Havemind Conflicts';

const trackedDirectories: string[] = [];

function silentLogStream(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function brandedToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

type FastifyApp = ReturnType<typeof buildApp>;

interface OwnerIdentity {
  readonly accessToken: string;
  readonly deviceId: string;
  readonly membershipId: string;
  readonly vaultId: string;
}

/** A real, opaque server with the full onboarding + sync surface wired. */
class TwoDeviceServer {
  private constructor(
    readonly app: FastifyApp,
    private readonly database: ReturnType<typeof openDatabase>,
    readonly owner: OwnerIdentity,
  ) {}

  revisionCount(): number {
    return (
      this.database.prepare('SELECT COUNT(*) AS c FROM revisions').get() as {
        c: number;
      }
    ).c;
  }

  eventCount(): number {
    return (
      this.database.prepare('SELECT COUNT(*) AS c FROM vault_events').get() as {
        c: number;
      }
    ).c;
  }

  /** Revisions committed by a given membership id (B→A push provenance check). */
  revisionCountForMember(membershipId: string): number {
    return (
      this.database
        .prepare('SELECT COUNT(*) AS c FROM revisions WHERE membership_id = ?')
        .get(membershipId) as { c: number } | undefined
    )?.c ?? -1;
  }

  async close(): Promise<void> {
    await this.app.close();
    this.database.close();
  }

  static async create(): Promise<TwoDeviceServer> {
    const dataDir = mkdtempSync(join(tmpdir(), 'havemind-two-device-'));
    trackedDirectories.push(dataDir);

    const database = openDatabase(join(dataDir, DB_FILENAME));
    runMigrations(database);

    const setup = new OwnerSetupService(database);
    const init = setup.initializeOwner(createLocalOwnerSetupContext(), {
      ownerDisplayName: 'Alice',
      vaultDisplayName: 'Shared Vault',
    });

    const ownerDeviceId = randomUUID();
    const pair = setup.pairOwnerDevice({
      deviceDisplayName: 'Alice Laptop',
      deviceId: ownerDeviceId,
      initialRefreshToken: generateServerRefreshToken(),
      pairingToken: init.pairingToken,
      publicKey: Buffer.alloc(32, 0x11),
    });

    const vaultId = (
      database.prepare('SELECT id AS id FROM vaults LIMIT 1').get() as {
        id: string;
      }
    ).id;

    const sessions = new SessionRepository(database);
    const invitations = new InvitationService(database);
    const blobStore = new BlobStore(join(dataDir, BLOBS_DIRNAME));
    const revisions = new RevisionRepository(database, blobStore);
    const app = buildApp({
      auth: {
        clientKey: () => 'fixed-test-client',
        database,
        sessions,
        invitations,
        sync: { blobStore, database, revisions },
      },
      config: parseServerConfig(TEST_ENV),
      loggerStream: silentLogStream(),
    });

    const owner: OwnerIdentity = {
      accessToken: pair.accessToken,
      deviceId: ownerDeviceId,
      membershipId: init.membershipId,
      vaultId,
    };
    return new TwoDeviceServer(app, database, owner);
  }
}

/**
 * Maps a full canonical URL onto a Fastify `inject`, so every real client piece
 * (onboarding api, refresh, transport, blob fetch) speaks to the opaque server
 * exactly over the wire. Returns both parsed `json` and raw `text` (the blob
 * resolver reads `text`).
 */
function injectRequestUrl(app: FastifyApp): RequestUrlFn {
  return async (options) => {
    const url = new URL(options.url);
    const response = await app.inject({
      method: options.method as never,
      url: `${url.pathname}${url.search}`,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.body === undefined ? {} : { payload: options.body }),
    });
    const text = response.body;
    let json: unknown;
    try {
      json = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.statusCode, json, text };
  };
}

/** In-memory onboarding secrets (mirrors ObsidianOnboardingSecrets semantics). */
class MemorySecrets implements OnboardingSecretsPort {
  private readonly values = new Map<string, string>();

  private read(key: string): string | null {
    const value = this.values.get(key);
    return value === undefined || value.length === 0 ? null : value;
  }

  async getInvitationEnvelope(): Promise<string | null> {
    return this.read('invitation');
  }
  async saveInvitationEnvelope(value: string): Promise<void> {
    this.values.set('invitation', value);
  }
  async clearInvitationEnvelope(): Promise<void> {
    this.values.set('invitation', '');
  }
  async getPendingCredential(): Promise<string | null> {
    return this.read('pending');
  }
  async savePendingCredential(value: string): Promise<void> {
    this.values.set('pending', value);
  }
  async clearPendingCredential(): Promise<void> {
    this.values.set('pending', '');
  }
  async getRefreshToken(): Promise<string | null> {
    return this.read('refresh');
  }
  async saveRefreshToken(value: string): Promise<void> {
    this.values.set('refresh', value);
  }
}

/** A single in-memory JSON blob standing in for `Plugin.loadData`/`saveData`. */
function memoryPersist(): {
  load(): Promise<unknown>;
  save(data: unknown): Promise<void>;
} {
  let blob: unknown = null;
  return {
    async load() {
      return blob;
    },
    async save(data) {
      blob = data;
    },
  };
}

/**
 * A connected device's real sync runtime, assembled exactly like
 * `startSyncLoop`: durable state, opaque transport (identity-stamped), push
 * producer and vault-apply adapter — over a single in-memory vault.
 */
class DeviceRuntime {
  readonly files = new Map<string, string>();
  /** Raw bytes for binary attachments (F9) — a separate store from `files`
   * (markdown text), shared by both the push-side snapshot port and the
   * apply-side file port so a binary write on either side is visible to the
   * other. */
  readonly binaryFiles = new Map<string, Uint8Array>();
  /** Folders that exist in this device's vault. The real `createVaultFilePort`
   * materializes parent folders before a create; modelling folders here (and
   * throwing on a create into a missing folder, exactly like real Obsidian)
   * is what makes the fresh-device subfolder catch-up a genuine end-to-end
   * regression test rather than a flat-map no-op. */
  readonly folders = new Set<string>();
  /** Reflected vault mutations (path + create/modify) queued by the apply-side
   * writes, exactly as real Obsidian fires `vault.on('create'|'modify')` after
   * a `vault.create`/`vault.modify`. Drained back through the SAME
   * `VaultChangeObserver` the production plugin wires (obsidian-adapters
   * `vault.on(...)` → `observeCreate`/`observeModify`), so a remote-apply write
   * is re-observed just like on a live device. Without this the harness never
   * exercised the re-entrancy guard on the receive side. */
  private readonly reflected: Array<{ path: string; kind: 'create' | 'modify' }> = [];
  private readonly state: DurableSyncState;
  private readonly runner: SyncRunner;
  private readonly observer: VaultChangeObserver;
  private readonly producer: OutboxLocalChangeRepository;

  constructor(options: {
    readonly app: FastifyApp;
    readonly apiBaseUrl: string;
    readonly vaultId: string;
    readonly memberId: string;
    readonly deviceId: string;
    readonly getAuthToken: () => Promise<string>;
  }) {
    const requestUrl = injectRequestUrl(options.app);
    this.state = new DurableSyncState({ persist: memoryPersist() });

    const transport = new RequestUrlTransport({
      requestUrl,
      apiBaseUrl: options.apiBaseUrl,
      vaultId: options.vaultId,
      getAuthToken: options.getAuthToken,
      resolveEnvelope: (revisionId) => this.state.peekEnvelope(revisionId),
      identity: {
        vaultId: options.vaultId,
        memberId: options.memberId,
        deviceId: options.deviceId,
      },
    });

    const resolvers = buildConnectionResolvers({
      apiBaseUrl: options.apiBaseUrl,
      vaultId: options.vaultId,
      getAccessToken: options.getAuthToken,
      requestUrl,
    });

    const vault = new VaultApplyAdapter({
      files: this.buildFilePort(),
      conflictFolder: CONFLICT_FOLDER,
      resolveRevision: resolvers.resolveRevision,
      // AUD-03: base hash over the SAME canonical form the producer uses.
      hashContent: async (content) => sha256Hex(canonicalizeMarkdown(content)),
      // Bridges every remote-apply write into the push producer's own mapping
      // (the re-entrancy guard `RemoteApplyProducerSync` documents). Without
      // this, a LOCAL edit to a path this device only ever received from the
      // peer finds no producer mapping and mints a fresh, unrelated fileId —
      // exactly the scenario the binary concurrent-edit test below exercises
      // (both devices editing the SAME received attachment independently).
      producerSync: {
        onRemoteWrite: async (input) => {
          await this.producer.adoptRemoteMapping(
            {
              collisionKey: input.path.normalize('NFC').toLowerCase(),
              content: input.content,
              contentHash: input.contentHash,
              ...(input.contentKind === undefined
                ? {}
                : { contentKind: input.contentKind }),
              fileId: input.fileId,
              path: input.path,
            },
            input.revisionId,
          );
        },
        onRemoteDelete: async (input) => {
          await this.producer.forgetRemoteMapping(
            input.path.normalize('NFC').toLowerCase(),
            input.fileId,
          );
        },
        localHeadFor: (fileId) => this.producer.headFor(fileId),
      },
    });

    this.runner = new SyncRunner({
      transport,
      state: this.state,
      vault,
      scheduler: () => undefined,
      random: () => 0,
    });

    let producerBlob: ProducerState = { mappings: [], heads: {} };
    const store: ProducerStorePort = {
      async load() {
        return producerBlob;
      },
      async save(next) {
        producerBlob = next;
      },
    };
    this.producer = new OutboxLocalChangeRepository({
      identity: {
        vaultId: options.vaultId,
        memberId: options.memberId,
        deviceId: options.deviceId,
      },
      store,
      enqueue: (envelope) => this.state.enqueue(envelope),
      generateRevisionId: () => randomUUID(),
      // Seed the SHARED apply-store ownership+base for every file this device
      // authors/pushes, exactly as the production `startPushProducer` wiring
      // does (obsidian-adapters). Without it a locally-authored file's base is
      // never seeded, so a concurrent peer edit to it can't be classified —
      // the very case the divergence regression below exercises.
      onLocalMaterialized: (m) => applyLocalMaterialization(this.state, m),
      onLocalForgotten: (f) => forgetLocalMaterialization(this.state, f),
    });
    this.observer = new VaultChangeObserver({
      clock: () => 0,
      generateFileId: () => randomUUID(),
      generateOperationId: () => randomUUID(),
      repository: this.producer,
      vault: this.snapshotPort(),
    });
  }

  read(path: string): string | undefined {
    return this.files.get(path);
  }

  /** The current raw bytes of a binary attachment (F9), or undefined. */
  readBinary(path: string): Uint8Array | undefined {
    return this.binaryFiles.get(path);
  }

  /** Every binary path currently present (attachments plus conflict artifacts). */
  binaryPaths(): string[] {
    return [...this.binaryFiles.keys()].sort();
  }

  async outboxSize(): Promise<number> {
    return (await this.state.listOutbox()).length;
  }

  /** Runs the one-time connect reconcile for pre-existing files (like the real
   * push producer does on startup). Applied remote files are excluded. */
  async reconcileOnConnect(): Promise<void> {
    await reconcileVaultState({
      observer: this.observer,
      repository: this.producer,
      vault: this.snapshotPort(),
    });
  }

  /** A local edit, driven exactly as the real vault listeners drive it: a
   * per-path create/modify event, never a full-vault rescan (a rescan would
   * re-enqueue a note this device only materialised from the peer). */
  async edit(path: string, content: string): Promise<void> {
    const existed = this.files.has(path);
    this.files.set(path, content.replace(/\r\n?/gu, '\n'));
    if (existed) {
      await this.observer.observeModify(path);
    } else {
      await this.observer.observeCreate(path);
    }
  }

  /** A local binary-attachment edit (F9), driven exactly like `edit()`: a
   * per-path create/modify event through the same real observer, which
   * classifies the path as binary by extension (`classifyVaultPath`) and
   * reads it back through `readBinary`. */
  async editBinary(path: string, bytes: Uint8Array): Promise<void> {
    const existed = this.binaryFiles.has(path);
    this.binaryFiles.set(path, bytes);
    if (existed) {
      await this.observer.observeModify(path);
    } else {
      await this.observer.observeCreate(path);
    }
  }

  async sync(): Promise<SyncCycleResult> {
    const result = await this.runner.trigger();
    // Real Obsidian fires vault events for the writes the apply side just made;
    // the production plugin routes them back through the SAME observer
    // (obsidian-adapters `vault.on('create'|'modify')`). Replay them here so the
    // re-entrancy guard is exercised on the receive side exactly as in the field.
    await this.drainReflected();
    return result;
  }

  private async drainReflected(): Promise<void> {
    const events = this.reflected.splice(0);
    for (const event of events) {
      if (event.kind === 'create') {
        await this.observer.observeCreate(event.path);
      } else {
        await this.observer.observeModify(event.path);
      }
    }
  }

  private snapshotPort(): VaultSnapshotPort {
    const files = this.files;
    const binaryFiles = this.binaryFiles;
    return {
      async listSyncablePaths() {
        return [...files.keys(), ...binaryFiles.keys()];
      },
      async readText(path) {
        return files.get(path) ?? '';
      },
      async readBinary(path) {
        return binaryFiles.get(path) ?? new Uint8Array(0);
      },
      async listAllPaths() {
        return [...files.keys(), ...binaryFiles.keys()];
      },
      async exists(path) {
        return files.has(path) || binaryFiles.has(path);
      },
    };
  }

  private buildFilePort(): VaultFilePort {
    // Drive the REAL production port (`createVaultFilePort`) over a folder-aware
    // in-memory Obsidian Vault double, rather than a hand-rolled reimplementation
    // of the port. This exercises the actual parent-folder materialization logic
    // end-to-end and removes a divergent second implementation of the same
    // contract. The double THROWS on a create into a missing folder, exactly
    // like real Obsidian — so a fresh device catching up over a subfoldered
    // backlog is a genuine regression test for the 5-day field outage.
    const files = this.files;
    const binaryFiles = this.binaryFiles;
    const folders = this.folders;
    const assertParentFolderExists = (path: string): void => {
      const separatorIndex = path.lastIndexOf('/');
      if (separatorIndex === -1) return;
      const parent = path.slice(0, separatorIndex);
      if (!folders.has(parent)) {
        throw new Error(`Folder does not exist: ${parent}`);
      }
    };
    const fileAt = (path: string): TFile => {
      const file = new TFile();
      file.path = path;
      return file;
    };
    const vault = {
      getAbstractFileByPath(path: string): TFile | TFolder | null {
        if (folders.has(path)) {
          const folder = new TFolder();
          folder.path = path;
          return folder;
        }
        if (files.has(path) || binaryFiles.has(path)) {
          return fileAt(path);
        }
        return null;
      },
      async read(file: { path: string }): Promise<string> {
        return files.get(file.path) ?? '';
      },
      async readBinary(file: { path: string }): Promise<ArrayBuffer> {
        const bytes = binaryFiles.get(file.path) ?? new Uint8Array(0);
        return bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
      },
      create: async (path: string, content: string): Promise<{ path: string }> => {
        assertParentFolderExists(path);
        files.set(path, content);
        this.reflected.push({ path, kind: 'create' });
        return fileAt(path);
      },
      createBinary: async (
        path: string,
        data: ArrayBuffer,
      ): Promise<{ path: string }> => {
        assertParentFolderExists(path);
        binaryFiles.set(path, new Uint8Array(data));
        this.reflected.push({ path, kind: 'create' });
        return fileAt(path);
      },
      modify: async (file: { path: string }, content: string): Promise<void> => {
        files.set(file.path, content);
        this.reflected.push({ path: file.path, kind: 'modify' });
      },
      modifyBinary: async (
        file: { path: string },
        data: ArrayBuffer,
      ): Promise<void> => {
        binaryFiles.set(file.path, new Uint8Array(data));
        this.reflected.push({ path: file.path, kind: 'modify' });
      },
      async delete(file: { path: string }): Promise<void> {
        files.delete(file.path);
        binaryFiles.delete(file.path);
      },
      async createFolder(path: string): Promise<void> {
        assertParentFolderExists(path);
        folders.add(path);
      },
    };
    return createVaultFilePort({
      vault: vault as unknown as never,
      state: this.state,
    });
  }
}

afterEach(() => {
  for (const directory of trackedDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

/** Advances the invitee onboarding one `resume()` step at a time to connected. */
async function driveInviteeToConnected(
  controller: OnboardingController,
): Promise<OnboardingViewState> {
  let state = controller.state;
  for (let step = 0; step < 16; step += 1) {
    state = await controller.resume();
    if (state.phase === 'connected' || state.phase === 'rejected') {
      return state;
    }
  }
  return state;
}

/**
 * Runs the full real onboarding dance (invitation → redeem → approve →
 * connect) and returns two connected, real `DeviceRuntime`s sharing the same
 * opaque server — the same setup as steps 1–6 of the primary onboarding test
 * below, extracted so the binary attachment test does not have to re-drive
 * the connection handshake inline.
 */
async function connectTwoDevices(
  server: TwoDeviceServer,
): Promise<{ owner: DeviceRuntime; invitee: DeviceRuntime }> {
  const ownerRequestUrl = injectRequestUrl(server.app);

  const invitation = await createVaultInvitation({
    requestUrl: ownerRequestUrl,
    apiBaseUrl: SERVER_ORIGIN,
    serverOrigin: SERVER_ORIGIN,
    vaultId: server.owner.vaultId,
    getAccessToken: async () => server.owner.accessToken,
    intendedRole: 'editor',
    intendedMemberDisplayName: 'Magda',
  });

  const secrets = new MemorySecrets();
  const controller = new OnboardingController({
    clock: { now: () => Date.now() },
    remoteApi: new RequestUrlOnboardingApi({
      requestUrl: injectRequestUrl(server.app),
    }),
    secrets,
    store: new PluginDataOnboardingStore({ persist: memoryPersist() }),
  });

  controller.beginFromPastedEnvelope(invitation.envelope);
  await controller.loadInvitationReview();
  const pendingState = await controller.confirmInvitation('Magda device');
  if (pendingState.phase !== 'pending-approval') {
    throw new Error('invitee did not reach pending-approval');
  }

  await approveRedeemedDevice({
    requestUrl: ownerRequestUrl,
    apiBaseUrl: SERVER_ORIGIN,
    vaultId: server.owner.vaultId,
    invitationId: invitation.invitationId,
    verificationPhrase: pendingState.verificationPhrase,
    getAccessToken: async () => server.owner.accessToken,
  });

  const connected = await driveInviteeToConnected(controller);
  if (connected.phase !== 'connected') {
    throw new Error(`invitee stuck in phase ${connected.phase}`);
  }

  const inviteeAccess = new RefreshTokenAccessProvider({
    requestUrl: injectRequestUrl(server.app),
    apiBaseUrl: connected.apiBaseUrl,
    getRefreshToken: () => secrets.getRefreshToken(),
    saveRefreshToken: (value) => secrets.saveRefreshToken(value),
    generateRotationId: () => brandedToken('hm_ri_'),
    generateSuccessorToken: () => brandedToken('hm_rt_'),
  });
  const invitee = new DeviceRuntime({
    app: server.app,
    apiBaseUrl: connected.apiBaseUrl,
    vaultId: connected.vaultId,
    memberId: connected.memberId,
    deviceId: connected.deviceId,
    getAuthToken: () => inviteeAccess.getAccessToken(),
  });
  // First connected cycle establishes Synced state (mirrors the primary test).
  await invitee.sync();

  const owner = new DeviceRuntime({
    app: server.app,
    apiBaseUrl: SERVER_ORIGIN,
    vaultId: server.owner.vaultId,
    memberId: server.owner.membershipId,
    deviceId: server.owner.deviceId,
    getAuthToken: async () => server.owner.accessToken,
  });

  return { owner, invitee };
}

describe('two-device onboarding + sync (Magda) against a real opaque server', () => {
  it('invitee redeems → sees the PIN (not offline) → is approved → connects → B→A push works', async () => {
    const server = await TwoDeviceServer.create();
    try {
      const ownerRequestUrl = injectRequestUrl(server.app);

      // 1. Owner mints an invitation for "Magda".
      const invitation = await createVaultInvitation({
        requestUrl: ownerRequestUrl,
        apiBaseUrl: SERVER_ORIGIN,
        serverOrigin: SERVER_ORIGIN,
        vaultId: server.owner.vaultId,
        getAccessToken: async () => server.owner.accessToken,
        intendedRole: 'editor',
        intendedMemberDisplayName: 'Magda',
      });

      // 2. Invitee drives the REAL onboarding controller over the wire.
      const secrets = new MemorySecrets();
      const controller = new OnboardingController({
        clock: { now: () => Date.now() },
        remoteApi: new RequestUrlOnboardingApi({
          requestUrl: injectRequestUrl(server.app),
        }),
        secrets,
        store: new PluginDataOnboardingStore({ persist: memoryPersist() }),
      });

      controller.beginFromPastedEnvelope(invitation.envelope);
      await controller.loadInvitationReview();
      const pendingState = await controller.confirmInvitation('Magda device');

      // BUG 1 REPRO: the post-redeem state must expose the 6-digit PIN and be
      // the waiting-for-approval state — never offline / error.
      expect(pendingState.phase).toBe('pending-approval');
      if (pendingState.phase !== 'pending-approval') {
        throw new Error('invitee did not reach pending-approval');
      }
      expect(pendingState.verificationPhrase).toMatch(/^[0-9]{6}$/u);
      // The refresh token the sync loop will later need is durably stored now.
      expect(await secrets.getRefreshToken()).not.toBeNull();
      const pin = pendingState.verificationPhrase;

      // 3. Owner approves using the PIN the invitee read aloud.
      const approved = await approveRedeemedDevice({
        requestUrl: ownerRequestUrl,
        apiBaseUrl: SERVER_ORIGIN,
        vaultId: server.owner.vaultId,
        invitationId: invitation.invitationId,
        verificationPhrase: pin,
        getAccessToken: async () => server.owner.accessToken,
      });
      expect(approved.status).toBe('approved');
      // The active membership id is distinct from the invitee's user id.
      expect(approved.membershipId).not.toBe(server.owner.membershipId);

      // 4. Invitee transitions pending-approval → connected (never offline).
      const connected = await driveInviteeToConnected(controller);
      expect(connected.phase).toBe('connected');
      if (connected.phase !== 'connected') {
        throw new Error(`invitee stuck in phase ${connected.phase}`);
      }
      // 6bfb3fc: the connection's push member id is the approval membership id.
      expect(connected.memberId).toBe(approved.membershipId);
      expect(connected.deviceId).toBe(approved.deviceId);

      // 5. Build the invitee's REAL sync loop from the connected state, sharing
      // the same secrets the onboarding stored (this is where the live pilot
      // dropped to "Offline — will retry" with zero requests).
      const inviteeAccess = new RefreshTokenAccessProvider({
        requestUrl: injectRequestUrl(server.app),
        apiBaseUrl: connected.apiBaseUrl,
        getRefreshToken: () => secrets.getRefreshToken(),
        saveRefreshToken: (value) => secrets.saveRefreshToken(value),
        generateRotationId: () => brandedToken('hm_ri_'),
        generateSuccessorToken: () => brandedToken('hm_rt_'),
      });
      const invitee = new DeviceRuntime({
        app: server.app,
        apiBaseUrl: connected.apiBaseUrl,
        vaultId: connected.vaultId,
        memberId: connected.memberId,
        deviceId: connected.deviceId,
        getAuthToken: () => inviteeAccess.getAccessToken(),
      });

      // BUG 1 REPRO: the first connected sync cycle must be Synced, not Offline.
      const firstCycle = await invitee.sync();
      expect(firstCycle.status).toBe('synced');

      // 6. Owner runtime (already paired) with a static access token.
      const owner = new DeviceRuntime({
        app: server.app,
        apiBaseUrl: SERVER_ORIGIN,
        vaultId: server.owner.vaultId,
        memberId: server.owner.membershipId,
        deviceId: server.owner.deviceId,
        getAuthToken: async () => server.owner.accessToken,
      });

      // BUG 2 REPRO: invitee edits a note and it must reach the server.
      await invitee.edit('from-magda.md', 'hello from B\n');
      expect(await invitee.outboxSize()).toBe(1);
      const pushCycle = await invitee.sync();
      expect(pushCycle.status).toBe('synced');
      expect(await invitee.outboxSize()).toBe(0);
      expect(server.revisionCount()).toBe(1);
      expect(server.revisionCountForMember(approved.membershipId)).toBe(1);

      // 7. Owner pulls and materialises the invitee's note (B→A end to end).
      const ownerPull = await owner.sync();
      expect(ownerPull.status).toBe('synced');
      expect(owner.read('from-magda.md')).toBe('hello from B\n');

      // 8. Owner edit → invitee pulls it (A→B still works).
      await owner.edit('from-alice.md', 'hello from A\n');
      const ownerPush = await owner.sync();
      expect(ownerPush.status).toBe('synced');
      const inviteePull = await invitee.sync();
      expect(inviteePull.status).toBe('synced');
      expect(invitee.read('from-alice.md')).toBe('hello from A\n');

      expect(server.revisionCount()).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('binary attachment (.png) syncs byte-identical; a concurrent edit produces a binary conflict artifact without overwriting the live file (F9)', async () => {
    const server = await TwoDeviceServer.create();
    try {
      const { owner, invitee } = await connectTwoDevices(server);
      const path = 'assets/photo.png';

      // A PNG-shaped byte sequence deliberately including 0x00 and 0xFF (never
      // valid UTF-8 text on its own), so a byte-for-byte survival proves the
      // sync path is genuinely binary-safe (F9) rather than accidentally
      // surviving as a lucky ASCII string.
      const pngV1 = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10, 0x20,
        0x00, 0xff, 0xfe, 0x01,
      ]);

      // 1. Owner creates the PNG and syncs it to the invitee.
      await owner.editBinary(path, pngV1);
      expect((await owner.sync()).status).toBe('synced');
      expect((await invitee.sync()).status).toBe('synced');

      // BYTE-IDENTICAL assertion (F9): every byte, including 0x00 and 0xFF,
      // must survive the round trip through the opaque server unchanged.
      const materialized = invitee.readBinary(path);
      expect(materialized).toEqual(pngV1);
      expect(server.revisionCount()).toBe(1);

      // 2. Concurrent binary edit: owner and invitee each edit the SAME
      // attachment independently, neither having seen the other's edit.
      const pngOwnerV2 = new Uint8Array([...pngV1, 0x00, 0xff]);
      const pngInviteeV2 = new Uint8Array([0xff, 0x00, ...pngV1]);

      await owner.editBinary(path, pngOwnerV2);
      await invitee.editBinary(path, pngInviteeV2);

      // Owner pushes first; the server accepts it as the new head.
      expect((await owner.sync()).status).toBe('synced');
      // Invitee pushes its own concurrent edit — DAG-CAS accepts a second,
      // divergent branch at write time — and in the same cycle pulls owner's
      // edit. The on-disk file (invitee's own edit) diverges from BOTH the
      // incoming bytes and the recorded base, so the apply side must divert
      // to a conflict artifact rather than silently overwrite (rule 3); the
      // runner surfaces that as a 'conflict' cycle status, not an error.
      expect((await invitee.sync()).status).toBe('conflict');
      // A further cycle is idempotent — no new conflict, no overwrite. (No
      // new remote event remains to reapply, so this settles back to synced.)
      expect((await invitee.sync()).status).toBe('synced');
      expect(server.revisionCount()).toBe(3);

      // The live file must still be the invitee's OWN edit — never silently
      // overwritten by the peer's concurrent edit.
      expect(invitee.readBinary(path)).toEqual(pngInviteeV2);

      // A binary conflict artifact appears under `Havemind Conflicts/`,
      // keeping the original `.png` extension, and carries the peer's
      // (owner's) incoming bytes — so both edits survive.
      const conflictArtifacts = invitee
        .binaryPaths()
        .filter((candidate) => candidate.startsWith(`${CONFLICT_FOLDER}/`));
      expect(conflictArtifacts).toHaveLength(1);
      expect(conflictArtifacts[0]).toMatch(/\.png$/u);
      const [conflictPath] = conflictArtifacts;
      if (conflictPath === undefined) {
        throw new Error('expected a binary conflict artifact path');
      }
      expect(invitee.readBinary(conflictPath)).toEqual(pngOwnerV2);
    } finally {
      await server.close();
    }
  });

  it('BUG A repro: create empty note then push N successive updates — receiver materializes create AND applies every update in place, zero conflict artifacts', async () => {
    const server = await TwoDeviceServer.create();
    try {
      const { owner, invitee } = await connectTwoDevices(server);
      const path = 'Live typing.md';

      // Receiver (M, owner) is long-lived: it already authored a backlog the
      // fresh invitee caught up over (the field's 70-event catch-up + rebase).
      for (let i = 0; i < 5; i += 1) {
        await owner.edit(`Backlog ${i}.md`, `backlog ${i}\n`);
      }
      expect((await owner.sync()).status).toBe('synced');
      expect((await invitee.sync()).status).toBe('synced');

      // Writer (W, invitee) creates an EMPTY note (title only, no body), then
      // types content in bursts — each burst a separate update revision. W
      // pushes the whole burst series BEFORE M's next poll, so M pulls the
      // create + every update in ONE cycle (M polls on an interval while W
      // types) — the exact live topology.
      await invitee.edit(path, '');
      expect((await invitee.sync()).status).toBe('synced');

      const bursts = ['a', 'ab', 'abc', 'abcd', 'abcde'];
      for (const content of bursts) {
        await invitee.edit(path, content);
        expect((await invitee.sync()).status).toBe('synced');
      }

      // Receiver (M, owner) pulls the create + all updates in one batch. The
      // create materializes a 0-byte file; every update must then apply IN
      // PLACE, converging to the last version — never divert to a conflict.
      expect((await owner.sync()).status).toBe('synced');

      // Final state: content converged, ZERO conflict artifacts.
      expect(canonicalizeMarkdown(owner.read(path) ?? '')).toBe(
        canonicalizeMarkdown('abcde'),
      );
      const conflictArtifacts = [...owner.files.keys()].filter((candidate) =>
        candidate.startsWith(`${CONFLICT_FOLDER}/`),
      );
      expect(conflictArtifacts).toEqual([]);

      // The receiver must NOT have re-pushed the peer's edits as its own (the
      // re-entrancy guard): a reflected vault event that escaped dedup would
      // enqueue a spurious revision. After a final settle cycle the outbox is
      // empty and the server holds exactly the writer's 6 revisions + the
      // owner's 5-note backlog — no reflected re-push.
      expect((await owner.sync()).status).toBe('synced');
      expect(await owner.outboxSize()).toBe(0);
      expect(await invitee.outboxSize()).toBe(0);
      expect(server.revisionCount()).toBe(11);
    } finally {
      await server.close();
    }
  });

  it('a REAL concurrent divergence (receiver edited locally while the peer update was in flight) produces exactly ONE conflict artifact and never overwrites the local edit', async () => {
    const server = await TwoDeviceServer.create();
    try {
      const { owner, invitee } = await connectTwoDevices(server);
      const path = 'Shared note.md';

      // Both devices converge on a shared note authored by the invitee.
      await invitee.edit(path, 'base\n');
      expect((await invitee.sync()).status).toBe('synced');
      expect((await owner.sync()).status).toBe('synced');
      expect(canonicalizeMarkdown(owner.read(path) ?? '')).toBe(
        canonicalizeMarkdown('base\n'),
      );

      // Concurrent divergence: each device edits the SAME note independently,
      // neither having seen the other's edit. The invitee pushes first.
      await invitee.edit(path, 'invitee wins\n');
      await owner.edit(path, 'owner LOCAL edit\n');
      expect((await invitee.sync()).status).toBe('synced');

      // Owner pushes its own divergent edit (a second DAG branch) and pulls the
      // invitee's in the same cycle. The on-disk file (owner's own edit) differs
      // from BOTH the incoming content and the recorded base, so the apply side
      // must divert to a conflict artifact — never silently overwrite (rule 3).
      const cycle = await owner.sync();
      expect(cycle.status).toBe('conflict');

      // The live file keeps the owner's OWN local edit — never overwritten.
      expect(canonicalizeMarkdown(owner.read(path) ?? '')).toBe(
        canonicalizeMarkdown('owner LOCAL edit\n'),
      );
      // Exactly ONE conflict artifact carrying the peer's incoming content.
      const conflictArtifacts = [...owner.files.keys()].filter((candidate) =>
        candidate.startsWith(`${CONFLICT_FOLDER}/`),
      );
      expect(conflictArtifacts).toHaveLength(1);
      const [conflictPath] = conflictArtifacts;
      if (conflictPath === undefined) throw new Error('expected a conflict artifact');
      expect(canonicalizeMarkdown(owner.read(conflictPath) ?? '')).toBe(
        canonicalizeMarkdown('invitee wins\n'),
      );

      // A further settle cycle is idempotent — no second conflict artifact.
      await owner.sync();
      const after = [...owner.files.keys()].filter((candidate) =>
        candidate.startsWith(`${CONFLICT_FOLDER}/`),
      );
      expect(after).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('a freshly onboarded device catches up over a backlog that includes files in not-yet-existing subfolders (5-day field outage repro)', async () => {
    const server = await TwoDeviceServer.create();
    try {
      const { owner, invitee } = await connectTwoDevices(server);

      // Owner authors a backlog: a root note AND notes nested in folders the
      // freshly onboarded invitee has never seen (the exact live scenario —
      // event 5 was `Notatki/Start pilotażu.md` into a vault with no `Notatki`).
      await owner.edit('Root.md', 'root\n');
      await owner.edit('Notatki/Start pilotażu.md', 'start\n');
      await owner.edit('Projekty/Havemind/Plan.md', 'plan\n');
      expect((await owner.sync()).status).toBe('synced');

      // The fresh invitee pulls the whole backlog in one cycle. Before the fix,
      // the first subfoldered create threw (missing parent folder), that throw
      // bubbled to the pull cycle — misclassified as 'offline' — and the cursor
      // stayed pinned: 'Offline — will retry' forever. It must now materialize
      // every file, creating each missing folder first.
      const catchUp = await invitee.sync();
      expect(catchUp.status).toBe('synced');
      expect(invitee.read('Root.md')).toBe('root\n');
      expect(invitee.read('Notatki/Start pilotażu.md')).toBe('start\n');
      expect(invitee.read('Projekty/Havemind/Plan.md')).toBe('plan\n');
    } finally {
      await server.close();
    }
  });
});
