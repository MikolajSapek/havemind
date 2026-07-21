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
  type OpenBuffer,
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

  async sync(): Promise<SyncCycleResult> {
    return this.runner.trigger();
  }

  private snapshotPort(): VaultSnapshotPort {
    const files = this.files;
    return {
      async listMarkdownPaths() {
        return [...files.keys()];
      },
      async readText(path) {
        return files.get(path) ?? '';
      },
      async listAllPaths() {
        return [...files.keys()];
      },
    };
  }

  private buildFilePort(): VaultFilePort {
    const files = this.files;
    const state = this.state;
    return {
      openBufferStates(): readonly OpenBuffer[] {
        return [];
      },
      fileIdAtPath: (path) => state.fileIdAtPath(path),
      async readByPath(path) {
        return files.get(path) ?? null;
      },
      baseHashFor: (fileId) => state.baseHashFor(fileId),
      recordBaseHash: (fileId, hash) => state.recordBaseHash(fileId, hash),
      forgetBaseHash: (fileId) => state.forgetBaseHash(fileId),
      async writeByPath(path, content) {
        files.set(path, content);
      },
      async deleteByPath(path) {
        files.delete(path);
      },
      async writeConflictArtifact(path, content) {
        files.set(path, content);
      },
      recordPathOwner: (fileId, path) => state.recordPathOwner(fileId, path),
      forgetPath: (path) => state.forgetPath(path),
    };
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
});
