/**
 * Platform glue: binds the real Obsidian runtime APIs to the injectable ports
 * the tested runtime adapters consume. This is the one module that talks to
 * `requestUrl`, the Vault, workspace events and `saveData` directly, so it is
 * exercised in the live pilot rather than in unit tests (excluded from the
 * coverage gate). The logic it wires up — transport, durable state, vault apply,
 * scheduler, status, controller — is all unit-tested in this folder.
 *
 * `buildSyncController` is the entry point `main.ts` calls once a vault is
 * connected. It never runs while the plugin is merely loaded-but-disconnected,
 * so the passive desktop shell keeps doing zero networking and zero scanning.
 */

import {
  Notice,
  requestUrl,
  TFile,
  TFolder,
  type EventRef,
  type Plugin,
  type TAbstractFile,
  type Vault,
} from 'obsidian';

import { canonicalizeMarkdown, hashPlaintext } from '@havemind/protocol';
import {
  RevisionPayloadTooLargeError,
  type DecodedRevisionPayload,
} from '@havemind/sync-core';

import {
  VaultChangeObserver,
  type LocalFileMapping,
  type VaultSnapshotPort,
} from '../obsidian/vault-adapter';
import { reconcileVaultState } from '../sync/reconciliation';
import {
  OutboxLocalChangeRepository,
  type ProducerState,
  type ProducerStorePort,
  type PushIdentity,
} from '../sync/outbox-repository';

/** The runtime App exposes a Vault; the ambient stub only models what we use. */
type AppWithVault = { vault: Vault };

import {
  rebaseCanonicalizedHashes,
  type RebaseVaultPort,
} from './canonicalization-rebase';
import { HavemindSyncController, type StatusListener } from './controller';
import { ModifyDebouncer } from './modify-debounce';
import { SyncScheduler, type SchedulerHooks } from './scheduler';
import { formatStatusBar } from './status';
import {
  DurableSyncState,
  type SyncStatePersistPort,
} from './sync-state';
import {
  RequestUrlTransport,
  type RequestUrlFn,
} from './sync-transport';
import {
  VaultApplyAdapter,
  type RemoteApplyProducerSync,
  type VaultFilePort,
} from './vault-apply';
import { createRemoteApplyProducerSync } from './remote-apply-coordinator';
import {
  applyLocalMaterialization,
  forgetLocalMaterialization,
} from './local-base-lifecycle';
import { RefreshTokenAccessProvider } from './access-token';
import { driveToConnected } from './connect-driver';
import {
  createVaultInvitation,
  type CreatedInvitation,
} from './create-invitation';
import {
  approveRedeemedDevice,
  type ApprovedDevice,
} from './approve-device';
import { classifyConnectInput, pairOwnerDevice } from './connect-input';
import {
  RejoinController,
  requestRejoinGrant,
  type RejoinGrantWaiting,
} from './rejoin';
import {
  buildConnectionResolvers,
  isConnectedOnboardingState,
} from './connection';
import { RequestUrlOnboardingApi } from './onboarding-api';
import { ObsidianOnboardingSecrets } from './onboarding-secrets';
import {
  PluginDataOnboardingStore,
  type OnboardingPersistPort,
} from './onboarding-store';
import {
  SyncRunner,
  type OpenBuffer,
  type RemoteEvent,
  type SchedulerFn,
} from '../sync/sync-runner';
import { OnboardingController } from '../onboarding/controller';
import {
  ensureClientInstanceId,
  type ClientInstanceIdRepository,
} from '../storage/client-store';
import {
  remoteAppliedToActivityEntry,
  type ActivityLogEntry,
  type RemoteAppliedInfo,
} from './activity-log';
import type { MemberRole } from './roster';
import type { ActivityKind } from '../activity/activity';
import type { LocalChangeKind, LocalChangeOperation } from '../obsidian/vault-adapter';

/**
 * Client-side runtime hooks the plugin injects so live UI surfaces can observe
 * the sync loop without the adapters importing the UI. Endpoint-free: these
 * carry data the client already has.
 */
export interface RuntimeHooks {
  /**
   * Called for each genuine local change the push producer detects (a non-null
   * observe result), so the Activity view can populate and live-update. Never
   * called for a no-op or for a remote-applied write. The entry is attributed to
   * the local member; note contents are never included.
   */
  readonly onLocalActivity?: (entry: ActivityLogEntry) => void;
  /**
   * Called for each remote revision the sync runner genuinely applied to the
   * vault (`VaultApplyAdapter.applyRemote` returning 'applied' — never 'noop'
   * or 'conflict'), so the Activity view reflects the other device's edits
   * too. The entry is attributed to `{ kind: 'remote' }` (resolved to the
   * sole other roster member in the two-person pilot by `activity-log.ts`);
   * note contents are never included.
   */
  readonly onRemoteActivity?: (entry: ActivityLogEntry) => void;
}

/** Maps a local-change kind onto the Activity feed's kind vocabulary. */
function toActivityKind(kind: LocalChangeKind): ActivityKind {
  return kind === 'update' ? 'edit' : kind;
}

const PERSIST_KEY = 'syncState';
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const CONFLICT_FOLDER = 'Havemind Conflicts';

/** Wraps Obsidian's `requestUrl` as the transport's `RequestUrlFn`. */
export function createRequestUrlFn(): RequestUrlFn {
  return async (options) => {
    const response = await requestUrl({
      url: options.url,
      method: options.method,
      throw: false,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.body === undefined ? {} : { body: options.body }),
    });
    // `.json` is a LAZY getter in the real Obsidian runtime that THROWS on a
    // non-JSON body (a 502/504 proxy HTML page, a Tailscale Funnel error page, an
    // empty body). Reading it eagerly here made the whole transport call reject
    // before the consumer could inspect `status`, so a permanent 4xx delivered as
    // HTML was misclassified as thrown/offline and retried forever. Expose it as a
    // guarded lazy accessor instead: the transport reads `.json` only AFTER its
    // status check passes, and a non-JSON body yields `undefined` rather than a
    // throw — so status-based classification (ensureOk / isPermanentStatus) always
    // runs. `.text` is a plain field that never throws and is forwarded eagerly.
    return {
      status: response.status,
      text: response.text,
      get json(): unknown {
        try {
          return response.json;
        } catch {
          return undefined;
        }
      },
    };
  };
}

/**
 * Durable state persistence over `Plugin.saveData`/`loadData`. Only the
 * non-secret sync bookkeeping is stored under a dedicated key; credentials stay
 * in SecretStorage.
 */
export function createPersistPort(plugin: Plugin): SyncStatePersistPort {
  return {
    async load() {
      const data = await plugin.loadData();
      if (isRecord(data)) return data[PERSIST_KEY] ?? null;
      return null;
    },
    async save(state) {
      const data = await plugin.loadData();
      const base = isRecord(data) ? data : {};
      await plugin.saveData({ ...base, [PERSIST_KEY]: state });
    },
  };
}

/** Top-level plugin-data key recording the AUD-03 rebase version applied. */
const CANONICALIZATION_REBASE_MARKER_KEY = 'canonicalizationRebaseVersion';

/**
 * Runs the AUD-03 one-time hash rebase (PART 2) over the plugin's own data
 * blob, reading current on-disk bytes through the real Vault. Idempotent via the
 * persisted version marker; safe to call on every connect.
 */
async function runCanonicalizationRebase(plugin: Plugin): Promise<void> {
  const vaultApi = (plugin.app as unknown as AppWithVault).vault;
  const vault: RebaseVaultPort = {
    exists: (path) => vaultApi.getAbstractFileByPath(path) !== null,
    read: async (path) => {
      const file = vaultApi.getAbstractFileByPath(path);
      return file === null ? '' : vaultApi.read(file as TFile);
    },
  };
  await rebaseCanonicalizedHashes({
    data: {
      load: () => plugin.loadData(),
      save: (data) => plugin.saveData(data),
    },
    vault,
    hash: (content) => hashPlaintext(content),
    canonicalize: canonicalizeMarkdown,
    keys: {
      markerKey: CANONICALIZATION_REBASE_MARKER_KEY,
      persistKey: PERSIST_KEY,
      producerKey: PUSH_PRODUCER_KEY,
    },
  });
}

/** Startup/focus/online/interval scheduler hooks over the Obsidian runtime. */
export function createSchedulerHooks(plugin: Plugin): SchedulerHooks {
  return {
    onFocus(run) {
      plugin.registerDomEvent(window, 'focus', run);
      return () => undefined;
    },
    onOnline(run) {
      plugin.registerDomEvent(window, 'online', run);
      return () => undefined;
    },
    setInterval(run, ms) {
      const id = window.setInterval(run, ms);
      plugin.registerInterval(id);
      return () => window.clearInterval(id);
    },
  };
}

/** Backoff scheduler for the runner, wrapping `setTimeout`. */
export function createBackoffScheduler(): SchedulerFn {
  return (callback, delayMs) => {
    window.setTimeout(callback, delayMs);
  };
}

export interface VaultFilePortOptions {
  readonly vault: Vault;
  readonly state: DurableSyncState;
}

/**
 * Binds the runner's `VaultFilePort` to the live Vault, resolving ownership from
 * the SHARED apply store (`DurableSyncState.pathOwners`). That store is now
 * seeded for both files RECEIVED from the peer (on remote apply) AND files this
 * device authored/pushed (via the producer's `onLocalMaterialized` seam), so a
 * peer edit to a locally-authored file resolves to its real fileId and updates
 * in place. A path with no owner resolves to `null`: a genuinely remote-only
 * file then materializes cleanly, and any pre-existing physical content there is
 * still protected by the adapter's on-disk overwrite guard (a null base with
 * divergent content becomes a conflict, never a silent overwrite).
 */
/**
 * Ensures `folder` exists and is genuinely a folder, returning the path to
 * write under. Guards against a non-folder file occupying the reserved path
 * (e.g. a note literally named `Havemind Conflicts` with no extension):
 * `getAbstractFileByPath` returning non-null does not mean the path is a
 * folder, and skipping `createFolder` in that case would make the later
 * `vault.create` throw — a throw the sync cycle has no permanent-error
 * classification for on the pull path, so it wedges the pull loop in
 * infinite 'offline' backoff (see `writeConflictArtifact`). Falls back to a
 * sanitized sibling folder name, then to the vault root, so a single
 * occupied path can never wedge sync.
 */
async function ensureWritableConflictFolder(
  vault: Pick<Vault, 'getAbstractFileByPath' | 'createFolder'>,
  folder: string,
): Promise<string> {
  const abstract = vault.getAbstractFileByPath(folder);
  if (abstract === null) {
    await vault.createFolder(folder);
    return folder;
  }
  if (abstract instanceof TFolder) {
    return folder;
  }
  const fallback = `${folder} (files)`;
  const fallbackAbstract = vault.getAbstractFileByPath(fallback);
  if (fallbackAbstract === null) {
    await vault.createFolder(fallback);
    return fallback;
  }
  if (fallbackAbstract instanceof TFolder) {
    return fallback;
  }
  // Even the sanitized fallback is occupied by a non-folder file. Land the
  // artifact at the vault root rather than throwing.
  return '';
}

export function createVaultFilePort(options: VaultFilePortOptions): VaultFilePort {
  const { vault, state } = options;
  return {
    openBufferStates(): readonly OpenBuffer[] {
      // Buffer divergence is resolved from the editor layer; the desktop shell
      // wires live buffers in a later slice. Until then no buffer is reported,
      // which is the safe default (clean → apply).
      return [];
    },
    fileIdAtPath(path) {
      // The single shared ownership truth: a path Havemind owns (authored here or
      // received from the peer) resolves to its fileId for an in-place update; an
      // unowned path resolves to null and is guarded on disk before any write.
      return state.fileIdAtPath(path);
    },
    async readByPath(path) {
      const existing = vault.getAbstractFileByPath(path);
      if (existing === null) return null;
      // Normalise line endings the same way the push producer does, so the
      // on-disk overwrite guard compares content on equal terms.
      const raw = await vault.read(existing as TFile);
      // Canonicalise the same way the push producer and base-hash seed do
      // (AUD-03), so the on-disk overwrite guard compares content on equal
      // terms. Hash/compare-side only — the file on disk is never rewritten.
      return canonicalizeMarkdown(raw);
    },
    baseHashFor: (fileId) => state.baseHashFor(fileId),
    recordBaseHash: (fileId, hash) => state.recordBaseHash(fileId, hash),
    forgetBaseHash: (fileId) => state.forgetBaseHash(fileId),
    async writeByPath(path, content) {
      const existing = vault.getAbstractFileByPath(path);
      if (existing === null) {
        await vault.create(path, content);
        return;
      }
      await vault.modify(existing as TFile, content);
    },
    async deleteByPath(path) {
      const existing = vault.getAbstractFileByPath(path);
      if (existing !== null) {
        await vault.delete(existing);
      }
    },
    async writeConflictArtifact(path, content) {
      const separatorIndex = path.lastIndexOf('/');
      const folder = separatorIndex === -1 ? '' : path.slice(0, separatorIndex);
      const filename =
        separatorIndex === -1 ? path : path.slice(separatorIndex + 1);
      const resolvedFolder =
        folder === '' ? '' : await ensureWritableConflictFolder(vault, folder);
      const targetPath =
        resolvedFolder === '' ? filename : `${resolvedFolder}/${filename}`;
      // Idempotent (create-or-overwrite). `vault.create` throws if the path
      // already exists, and the runner saves the pull cursor only AFTER apply,
      // so a crash mid-cycle or a second delivery re-writes the same
      // `fileId-revisionId.md` artifact. A throw here would be caught by the
      // cycle as 'offline' and wedge the whole pull loop in infinite backoff.
      const existing = vault.getAbstractFileByPath(targetPath);
      if (existing === null) {
        await vault.create(targetPath, content);
        return;
      }
      await vault.modify(existing as TFile, content);
    },
    recordPathOwner: (fileId, path) => state.recordPathOwner(fileId, path),
    forgetPath: (path) => state.forgetPath(path),
  };
}


export interface SyncConnection {
  readonly apiBaseUrl: string;
  readonly vaultId: string;
  readonly getAuthToken: () => Promise<string>;
  readonly resolveRevision: (event: RemoteEvent) => Promise<DecodedRevisionPayload>;
  readonly serverEpoch?: () => string | null;
  readonly intervalMs?: number;
  /**
   * The live push identity (server membership + device) for this connection.
   * When present, the transport re-stamps it onto every outbound revision header
   * so a revision built under a prior-session identity can never ship a stale
   * actor and 403 the whole request (rule 3). Absent when no push identity is
   * known yet, in which case the producer never starts and the outbox is empty.
   */
  readonly pushIdentity?: { readonly memberId: string; readonly deviceId: string };
}

export interface BuiltSyncController {
  readonly controller: HavemindSyncController;
  readonly state: DurableSyncState;
}

/**
 * Assembles the full sync runtime for a connected vault and returns a controller
 * `main.ts` can `start()` on layout-ready and `stop()` on unload.
 */
export function buildSyncController(
  plugin: Plugin,
  connection: SyncConnection,
  onStatus: StatusListener,
  hooks?: RuntimeHooks,
  producerSync?: RemoteApplyProducerSync,
): BuiltSyncController {
  const state = new DurableSyncState({ persist: createPersistPort(plugin) });

  const transport = new RequestUrlTransport({
    requestUrl: createRequestUrlFn(),
    apiBaseUrl: connection.apiBaseUrl,
    vaultId: connection.vaultId,
    getAuthToken: connection.getAuthToken,
    resolveEnvelope: (revisionId) => state.peekEnvelope(revisionId),
    ...(connection.serverEpoch === undefined
      ? {}
      : { serverEpoch: connection.serverEpoch }),
    ...(connection.pushIdentity === undefined
      ? {}
      : {
          identity: {
            vaultId: connection.vaultId,
            memberId: connection.pushIdentity.memberId,
            deviceId: connection.pushIdentity.deviceId,
          },
        }),
  });

  const vault = new VaultApplyAdapter({
    files: createVaultFilePort({
      vault: (plugin.app as unknown as AppWithVault).vault,
      state,
    }),
    conflictFolder: CONFLICT_FOLDER,
    resolveRevision: connection.resolveRevision,
    // AUD-03: the apply-side base hash must be computed over the SAME canonical
    // content form the push producer uses (`hashPlaintext` = SHA-256 over
    // `canonicalizeMarkdown`), so a base seeded by a local push and an on-disk
    // read compare on equal terms. Never the raw token digest below.
    hashContent: (content) => hashPlaintext(content),
    // FIX 1: a genuinely applied remote revision (never 'noop'/'conflict')
    // reaches the Activity feed too, attributed to `remote` — previously only
    // the local-change wrapper ever recorded an entry, so the other device's
    // edits never showed up.
    ...(hooks?.onRemoteActivity === undefined
      ? {}
      : {
          onRemoteApplied: (info: RemoteAppliedInfo) => {
            hooks.onRemoteActivity?.(
              remoteAppliedToActivityEntry(info, Date.now()),
            );
          },
        }),
    // FIX 2 (re-entrancy): keep the push producer's mapping in lockstep with
    // apply writes so the reflected vault event is deduped, never re-pushed,
    // re-attributed, or given a fresh fileId.
    ...(producerSync === undefined ? {} : { producerSync }),
  });

  // Late-bound so the runner can report every cycle — including the retries it
  // drives itself through backoff — to the controller. Without this a recovery
  // reached only via backoff would never clear a stale offline status because
  // the controller re-observes on its own schedule only every few minutes.
  const controllerRef: { current?: HavemindSyncController } = {};

  const runner = new SyncRunner({
    transport,
    state,
    vault,
    scheduler: createBackoffScheduler(),
    onCycleComplete: (result) => controllerRef.current?.observeCycle(result),
  });

  const controller = new HavemindSyncController({
    runner,
    hooks: createSchedulerHooks(plugin),
    intervalMs: connection.intervalMs ?? DEFAULT_INTERVAL_MS,
    onStatus,
  });
  controllerRef.current = controller;

  return { controller, state };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const HAVEMIND_STATUS_DISCONNECTED = formatStatusBar({
  status: 'disconnected',
});

// ---------------------------------------------------------------------------
// Connect / live-loop assembly (F8-02b-A)
// ---------------------------------------------------------------------------

const CLIENT_INSTANCE_KEY = 'clientInstanceId';
const APPROVAL_POLL_INTERVAL_MS = 5000;
const MAX_CONNECT_STEPS = 720; // ~1h of 5s polls before giving up

/** Raw plugin-data load/save, shared by every durable non-secret store. */
function createRawPersistPort(plugin: Plugin): OnboardingPersistPort {
  return {
    load: () => plugin.loadData(),
    async save(data) {
      await plugin.saveData(data);
    },
  };
}

function createClientInstanceRepo(plugin: Plugin): ClientInstanceIdRepository {
  return {
    async readClientInstanceId() {
      const data = await plugin.loadData();
      const value = isRecord(data) ? data[CLIENT_INSTANCE_KEY] : null;
      return typeof value === 'string' ? value : null;
    },
    async writeClientInstanceId(value) {
      const data = await plugin.loadData();
      const base = isRecord(data) ? data : {};
      await plugin.saveData({ ...base, [CLIENT_INSTANCE_KEY]: value });
    },
  };
}

/** Assembles the onboarding controller from the real Obsidian-backed ports. */
export async function buildOnboardingController(
  plugin: Plugin,
): Promise<{ controller: OnboardingController; store: PluginDataOnboardingStore }> {
  const clientInstanceId = await ensureClientInstanceId(
    createClientInstanceRepo(plugin),
  );
  const secrets = new ObsidianOnboardingSecrets({
    clientInstanceId,
    secretStorage: plugin.app.secretStorage,
  });
  const store = new PluginDataOnboardingStore({
    persist: createRawPersistPort(plugin),
  });
  const controller = new OnboardingController({
    clock: { now: () => Date.now() },
    remoteApi: new RequestUrlOnboardingApi({ requestUrl: createRequestUrlFn() }),
    secrets,
    store,
  });
  return { controller, store };
}

export interface ConnectionHandle {
  stop(): void;
  /** Human-readable server name for the Connect panel (empty when disconnected). */
  readonly serverName: string;
  /**
   * The local user's own membership for the presence roster, when known. The
   * plugin records this as the persistent "self" roster entry. Absent when no
   * server membership id is known yet (e.g. a not-yet-connected shell).
   */
  readonly selfMembership?: { readonly membershipId: string; readonly role: MemberRole };
}

const NOOP_HANDLE: ConnectionHandle = { stop: () => undefined, serverName: '' };

function serverNameFromUrl(apiBaseUrl: string): string {
  try {
    return new URL(apiBaseUrl).host;
  } catch {
    return apiBaseUrl;
  }
}

/**
 * Resumes any stored onboarding to `connected` and, once connected, builds and
 * starts the sync controller. Called on layout-ready; if there is no in-flight
 * connection it reports `disconnected` and starts nothing (passive shell).
 */
const OWNER_CONNECTION_KEY = 'ownerConnection';
const OWNER_DEVICE_LABEL = 'Havemind owner device';
const INVITEE_DEVICE_LABEL = 'Havemind device';

interface StoredConnection {
  readonly apiBaseUrl: string;
  readonly vaultId: string;
  /** Server membership id for this user; required to build push headers. */
  readonly memberId?: string;
  /** Server-issued device id bound to the session; required to push. */
  readonly deviceId?: string;
}

async function readOwnerConnection(
  plugin: Plugin,
): Promise<StoredConnection | null> {
  const data = await plugin.loadData();
  const record = isRecord(data) ? data[OWNER_CONNECTION_KEY] : null;
  if (
    isRecord(record) &&
    typeof record.apiBaseUrl === 'string' &&
    typeof record.vaultId === 'string'
  ) {
    return {
      apiBaseUrl: record.apiBaseUrl,
      vaultId: record.vaultId,
      ...(typeof record.memberId === 'string'
        ? { memberId: record.memberId }
        : {}),
      ...(typeof record.deviceId === 'string'
        ? { deviceId: record.deviceId }
        : {}),
    };
  }
  return null;
}

async function writeOwnerConnection(
  plugin: Plugin,
  connection: StoredConnection,
): Promise<void> {
  const data = await plugin.loadData();
  const base = isRecord(data) ? data : {};
  await plugin.saveData({ ...base, [OWNER_CONNECTION_KEY]: connection });
}

interface ConnectedVault {
  readonly apiBaseUrl: string;
  readonly vaultId: string;
  readonly serverOrigin: string;
}

/** Resolves the connected vault from an owner pairing or invitee onboarding. */
async function resolveConnectedVault(
  plugin: Plugin,
): Promise<ConnectedVault | null> {
  const owner = await readOwnerConnection(plugin);
  if (owner !== null) {
    return {
      apiBaseUrl: owner.apiBaseUrl,
      vaultId: owner.vaultId,
      serverOrigin: owner.apiBaseUrl,
    };
  }
  const { controller: onboarding } = await buildOnboardingController(plugin);
  const state = await onboarding.resume();
  if (!isConnectedOnboardingState(state)) {
    return null;
  }
  const connected = state as unknown as ConnectedVault;
  return {
    apiBaseUrl: connected.apiBaseUrl,
    vaultId: connected.vaultId,
    serverOrigin: connected.serverOrigin,
  };
}

/** Extra wiring for a started sync loop: the local role + live UI hooks. */
interface SyncLoopExtras {
  /** The local user's role for their own roster entry. */
  readonly role?: MemberRole;
  readonly hooks?: RuntimeHooks;
}

/** Builds and starts the live sync loop for an already-connected vault. */
async function startSyncLoop(
  plugin: Plugin,
  connection: StoredConnection,
  onStatus: StatusListener,
  extras: SyncLoopExtras = {},
): Promise<ConnectionHandle> {
  const clientInstanceId = await ensureClientInstanceId(
    createClientInstanceRepo(plugin),
  );
  const secrets = new ObsidianOnboardingSecrets({
    clientInstanceId,
    secretStorage: plugin.app.secretStorage,
  });
  const accessProvider = new RefreshTokenAccessProvider({
    requestUrl: createRequestUrlFn(),
    apiBaseUrl: connection.apiBaseUrl,
    getRefreshToken: () => secrets.getRefreshToken(),
    saveRefreshToken: (value) => secrets.saveRefreshToken(value),
    generateRotationId: generateRotationIdValue,
    generateSuccessorToken: generateRefreshTokenValue,
  });
  const resolvers = buildConnectionResolvers({
    apiBaseUrl: connection.apiBaseUrl,
    vaultId: connection.vaultId,
    getAccessToken: () => accessProvider.getAccessToken(),
    requestUrl: createRequestUrlFn(),
  });
  const hasPushIdentity =
    connection.memberId !== undefined && connection.deviceId !== undefined;
  // One shared fileId↔path↔base truth: the apply adapter drives the producer's
  // mapping through this late-bound coordinator (the producer is created after
  // the controller). Until the producer exists (or when there is no push
  // identity) the coordinator is inert.
  const producerRef: { current: OutboxLocalChangeRepository | null } = {
    current: null,
  };
  const producerSync = createRemoteApplyProducerSync(() => producerRef.current);
  const { controller, state } = buildSyncController(
    plugin,
    {
      apiBaseUrl: resolvers.apiBaseUrl,
      vaultId: resolvers.vaultId,
      getAuthToken: resolvers.getAuthToken,
      resolveRevision: resolvers.resolveRevision,
      // Re-stamp the live identity onto every outbound header so a revision that
      // a prior-session producer enqueued can never ship a stale actor (rule 3).
      ...(hasPushIdentity
        ? {
            pushIdentity: {
              memberId: connection.memberId as string,
              deviceId: connection.deviceId as string,
            },
          }
        : {}),
    },
    onStatus,
    extras.hooks,
    producerSync,
  );

  // AUD-03 PART 2 — one-time migration. BEFORE the first sync cycle, rebase any
  // persisted base hashes / producer-mapping content hashes that were computed
  // under the OLD canonicalization to the NEW canonical form, so the first pull
  // does not read stale hashes and mint spurious revisions / conflict artifacts
  // for files whose bytes differ only by a trailing newline or BOM. A version
  // marker in plugin data makes this run exactly once.
  await runCanonicalizationRebase(plugin);

  controller.start();

  // The push producer detects local edits, enumerates pre-existing files and
  // enqueues revisions the runner POSTs. Without a server-issued memberId +
  // deviceId a revision header cannot be built (rule 3), so the producer only
  // starts once both are known — both the invitee flow and the owner /owner/pair
  // flow supply memberId + deviceId (connectAsOwner reads `pairing.memberId`
  // off the pairing response), so `hasPushIdentity` is true for either path.
  let disposeProducer: (() => void) | null = null;
  if (hasPushIdentity) {
    disposeProducer = startPushProducer(
      plugin,
      state,
      {
        vaultId: connection.vaultId,
        memberId: connection.memberId as string,
        deviceId: connection.deviceId as string,
      },
      () => {
        void controller.syncNow();
      },
      producerRef,
      extras.hooks,
    );
  }

  // The local member's own persistent roster entry, when the server issued a
  // membership id. Presence is connection state, so this is recorded once and
  // stays connected until an explicit teardown.
  const selfMembership =
    connection.memberId === undefined
      ? undefined
      : { membershipId: connection.memberId, role: extras.role ?? 'editor' };

  return {
    ...(selfMembership === undefined ? {} : { selfMembership }),
    // Tearing the producer's vault listeners down on stop is critical: a re-pair
    // (or reconnect) calls stop() on the previous handle before starting a new
    // one, and without this the prior-session observer stays attached and keeps
    // enqueuing revisions stamped with the OLD identity alongside the new one —
    // the exact mix of accepted (current identity) and 403-rejected (stale
    // identity) pushes. Disposing here guarantees exactly one live producer.
    stop: () => {
      controller.stop();
      disposeProducer?.();
    },
    serverName: serverNameFromUrl(connection.apiBaseUrl),
  };
}

const PUSH_PRODUCER_KEY = 'pushProducer';

/**
 * Wires local-change detection to the outbox. It registers vault create/modify/
 * rename/delete listeners, runs an initial reconciliation so files that already
 * existed before pairing are enumerated and pushed, and triggers a sync cycle
 * after each detected change. Never logs note contents.
 *
 * Returns a disposer that detaches every registered vault listener. The caller
 * (the connection handle's `stop()`) must call it on teardown/re-pair so a
 * prior-session producer never lingers and double-enqueues under a stale
 * identity — see the `stop()` comment in `startSyncLoop`.
 */
function startPushProducer(
  plugin: Plugin,
  state: DurableSyncState,
  identity: PushIdentity,
  triggerSync: () => void,
  producerRef: { current: OutboxLocalChangeRepository | null },
  hooks?: RuntimeHooks,
): () => void {
  const vault = (plugin.app as unknown as AppWithVault).vault;
  const store: ProducerStorePort = {
    async load() {
      const data = await plugin.loadData();
      const raw = isRecord(data) ? data[PUSH_PRODUCER_KEY] : null;
      return parseProducerState(raw);
    },
    async save(next) {
      const data = await plugin.loadData();
      const base = isRecord(data) ? data : {};
      await plugin.saveData({ ...base, [PUSH_PRODUCER_KEY]: next });
    },
  };

  const repository = new OutboxLocalChangeRepository({
    identity,
    store,
    enqueue: (envelope) => state.enqueue(envelope),
    generateRevisionId: () => globalThis.crypto.randomUUID(),
    // FIX 1: seed the SHARED apply store for every file this device authors or
    // pushes, so a later peer edit to a locally-authored file resolves to its
    // real fileId and updates in place instead of forever forking to a conflict
    // artifact. A rename also forgets the stale owner of the previous path.
    //
    // DATA-SAFETY (rule 3): the base is SEEDED only on first authorship and is
    // NEVER advanced by a local push — advancing it here reopened the silent-
    // overwrite window (a concurrent peer revision matching the just-authored
    // base slips past the on-disk guard). The single source of truth for that
    // rule lives in `local-base-lifecycle.ts`, shared with the integration
    // harness so a regression can't hide behind a differently-modelled test.
    onLocalMaterialized: (materialization) =>
      applyLocalMaterialization(state, materialization),
    onLocalForgotten: (forget) => forgetLocalMaterialization(state, forget),
  });
  // Bind the late-bound coordinator so the apply adapter can adopt remote
  // fileIds into this producer's mapping (FIX 2).
  producerRef.current = repository;

  const snapshot: VaultSnapshotPort = {
    async listMarkdownPaths() {
      return vault.getMarkdownFiles().map((file) => file.path);
    },
    async readText(path) {
      const file = vault.getAbstractFileByPath(path);
      return file === null ? '' : vault.read(file as TFile);
    },
    async listAllPaths() {
      // Every vault file, markdown or not. Used only by reconciliation to count
      // (never read or enqueue) the non-markdown attachments the pilot's
      // markdown-only scope excludes, so that exclusion stays visible.
      return vault.getFiles().map((file) => file.path);
    },
  };

  const observer = new VaultChangeObserver({
    clock: () => Date.now(),
    generateFileId: () => globalThis.crypto.randomUUID(),
    generateOperationId: () => globalThis.crypto.randomUUID(),
    repository,
    vault: snapshot,
  });

  const afterChange = (task: Promise<unknown>): void => {
    void task.then(
      () => triggerSync(),
      (error: unknown) => {
        // Surface an oversized note to the user instead of silently dropping it;
        // the change was never enqueued (the size guard rejected it), so nothing
        // wedges the outbox. Other change errors stay non-fatal for the loop.
        if (error instanceof RevisionPayloadTooLargeError) {
          new Notice(`Havemind: ${error.message}`);
        }
      },
    );
  };

  // Record a genuine local change (a non-null observe result) into the Activity
  // feed, attributed to the local member. A no-op observe (null) — e.g. a
  // remote-applied write that matches the synced base — is never recorded, so
  // remote edits are not mislabelled as the local user's work.
  const recordActivity = (op: LocalChangeOperation | null): void => {
    if (op === null || hooks?.onLocalActivity === undefined) return;
    hooks.onLocalActivity({
      // The real revision id the outbox repository generated and enqueued
      // (`OutboxLocalChangeRepository.commitLocalChange`'s `built.revisionId`,
      // surfaced here as `op.revisionId`) — never `op.operationId`, which is
      // only a client-side idempotency key and would break restore + the
      // local-push/remote-echo dedup in `ActivityLog`. Falls back to the
      // operationId only when no revision was created (a delete of a file
      // that was never pushed), so the entry still has a stable, unique id.
      revisionId: op.revisionId ?? op.operationId,
      fileId: op.fileId,
      path: op.path,
      kind: toActivityKind(op.kind),
      author: { kind: 'member', membershipId: identity.memberId },
      timestamp: op.observedAt,
      hasContent: op.content !== null,
    });
  };
  const observed = (task: Promise<LocalChangeOperation | null>): void => {
    afterChange(
      task.then((op) => {
        recordActivity(op);
        return op;
      }),
    );
  };
  // Folder-level events expand to zero or more per-child operations; record each
  // genuine one in the Activity feed and trigger a single sync afterwards.
  const observedMany = (task: Promise<LocalChangeOperation[]>): void => {
    afterChange(
      task.then((ops) => {
        for (const op of ops) recordActivity(op);
        return ops;
      }),
    );
  };

  // Capture the listener refs so the returned disposer can detach exactly this
  // producer's listeners on stop/re-pair (not tied to plugin unload via
  // registerEvent, which would outlive a re-pair and leak a stale-identity
  // observer). See registerVaultChangeListeners.
  // AUD-03 (settling window): a `modify` event is debounced per path so an
  // apply-then-formatter-rewrite burst hashes ONCE, after the file settles,
  // reading its final content. Create/rename/delete are ordering-sensitive and
  // fire immediately (never debounced).
  const modifyDebouncer = new ModifyDebouncer({
    onSettled: (path) => observed(observer.observeModify(path)),
  });
  const disposeListeners = registerVaultChangeListeners(vault, {
    onCreate: (path) => observed(observer.observeCreate(path)),
    onModify: (path) => modifyDebouncer.trigger(path),
    onDelete: (path) => observed(observer.observeDelete(path)),
    onRename: (oldPath, newPath) =>
      observed(observer.observeRename(oldPath, newPath)),
    onFolderRename: (oldPath, newPath) =>
      observedMany(observer.observeFolderRename(oldPath, newPath)),
    onFolderDelete: (folderPath) =>
      observedMany(observer.observeFolderDelete(folderPath)),
  });

  // Existing notes predate the change listeners, so enumerate them once on
  // connect and push any that are new or drifted, then sync. A per-file failure
  // (an oversized note) is skipped rather than aborting the whole scan; surface
  // the count so a silently un-synced file is visible to the user.
  afterChange(
    reconcileVaultState({ observer, repository, vault: snapshot }).then(
      (result) => {
        if (result.skipped > 0) {
          new Notice(
            `Havemind: ${result.skipped} file(s) could not be synced and were skipped.`,
          );
        }
        // Attachments are a deliberate MVP exclusion (markdown-only), but that
        // must never be silent: surface the count separately from the
        // per-file skip count above so the two distinct reasons aren't conflated.
        if (result.attachmentsExcluded > 0) {
          new Notice(
            `Havemind: ${result.attachmentsExcluded} attachment(s) not synced (markdown only for now).`,
          );
        }
      },
    ),
  );

  return () => {
    // Cancel any in-flight settle timers before detaching listeners so a
    // pending modify can never fire after teardown/re-pair.
    modifyDebouncer.dispose();
    disposeListeners();
  };
}

/** The four vault-change callbacks the push producer reacts to. */
export interface VaultChangeListenerHandlers {
  onCreate: (path: string) => void;
  onModify: (path: string) => void;
  onDelete: (path: string) => void;
  onRename: (oldPath: string, newPath: string) => void;
  /**
   * A folder-level rename (Obsidian or another plugin moving a whole folder).
   * Defence-in-depth against Obsidian emitting only the TFolder event: the
   * producer re-paths every child mapping under the old folder prefix so a
   * later child edit resolves to its existing fileId instead of forking.
   */
  onFolderRename: (oldFolderPath: string, newFolderPath: string) => void;
  /** A folder-level delete: every child mapping under the prefix is tombstoned. */
  onFolderDelete: (folderPath: string) => void;
}

/**
 * Registers the four vault-change listeners and returns a disposer that detaches
 * every one via `vault.offref`. Kept a small, exported, injectable seam so the
 * teardown contract (exactly the listeners we added are removed on stop) is unit
 * testable without the full Obsidian runtime. Non-`TFile` events and missing
 * paths are ignored, matching the producer's markdown-only scope.
 */
export function registerVaultChangeListeners(
  vault: Pick<Vault, 'on' | 'offref'>,
  handlers: VaultChangeListenerHandlers,
): () => void {
  const refs: EventRef[] = [
    vault.on('create', (file) => {
      if (file instanceof TFile) handlers.onCreate(file.path);
    }),
    vault.on('modify', (file) => {
      if (file instanceof TFile) handlers.onModify(file.path);
    }),
    vault.on('delete', (file) => {
      if (file instanceof TFolder) {
        handlers.onFolderDelete(file.path);
        return;
      }
      const path = (file as TAbstractFile).path;
      if (typeof path === 'string') handlers.onDelete(path);
    }),
    vault.on('rename', (file, oldPath) => {
      if (typeof oldPath !== 'string') return;
      if (file instanceof TFile) {
        handlers.onRename(oldPath, file.path);
      } else if (file instanceof TFolder) {
        handlers.onFolderRename(oldPath, file.path);
      }
    }),
  ];
  return () => {
    for (const ref of refs) vault.offref(ref);
  };
}

function parseProducerState(raw: unknown): ProducerState {
  if (!isRecord(raw) || !Array.isArray(raw.mappings) || !isRecord(raw.heads)) {
    return { mappings: [], heads: {} };
  }
  const mappings: LocalFileMapping[] = [];
  for (const entry of raw.mappings) {
    if (
      isRecord(entry) &&
      typeof entry.collisionKey === 'string' &&
      typeof entry.content === 'string' &&
      typeof entry.contentHash === 'string' &&
      typeof entry.fileId === 'string' &&
      typeof entry.path === 'string'
    ) {
      mappings.push({
        collisionKey: entry.collisionKey,
        content: entry.content,
        contentHash: entry.contentHash,
        fileId: entry.fileId,
        path: entry.path,
      });
    }
  }
  const heads: Record<string, string> = {};
  for (const [fileId, revisionId] of Object.entries(raw.heads)) {
    if (typeof revisionId === 'string') heads[fileId] = revisionId;
  }
  return { mappings, heads };
}

export async function startHavemindConnection(
  plugin: Plugin,
  onStatus: StatusListener,
  hooks?: RuntimeHooks,
): Promise<ConnectionHandle> {
  // An owner paired via /owner/pair persists a connection record and takes
  // precedence; otherwise resume any in-flight invitee onboarding.
  const owner = await readOwnerConnection(plugin);
  if (owner !== null) {
    return startSyncLoop(plugin, owner, onStatus, { role: 'owner', ...(hooks === undefined ? {} : { hooks }) });
  }

  const { controller: onboarding } = await buildOnboardingController(plugin);
  const connectedState = await driveToConnected({
    controller: onboarding,
    sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
    pollIntervalMs: APPROVAL_POLL_INTERVAL_MS,
    maxSteps: MAX_CONNECT_STEPS,
  });

  if (!isConnectedOnboardingState(connectedState)) {
    onStatus('disconnected', HAVEMIND_STATUS_DISCONNECTED);
    return NOOP_HANDLE;
  }

  const connected = connectedState as unknown as StoredConnection;
  return startSyncLoop(plugin, connected, onStatus, { role: 'editor', ...(hooks === undefined ? {} : { hooks }) });
}

export interface ConnectFromInputOptions {
  readonly report: (message: string) => void;
  readonly onStatus: StatusListener;
  /**
   * Called once the invitee is redeemed and waiting for owner approval, carrying
   * the verification phrase this device must read aloud. Lets the caller hold the
   * waiting state durably so a pane reopen resumes it (never re-redeeming a
   * single-use invitation). The phrase is a second-channel secret — never logged.
   */
  readonly onPendingApproval?: (verificationPhrase: string) => void;
  /**
   * Called when the server reports the invitation is no longer valid — the owner
   * rejected this device or the 3-attempt cap was reached. Lets the caller move
   * the guest to a clear "ask for a new invite" state instead of leaving it stuck
   * on the waiting screen (an auth rejection is never a connection loss).
   */
  readonly onInvitationRejected?: () => void;
  /** Live UI hooks (activity feed) threaded into the started sync loop. */
  readonly hooks?: RuntimeHooks;
}

/**
 * Runs the Connect flow for a pasted input: an owner pairing token (`hm_pt_…`)
 * redeems at `POST /owner/pair`; an invitation envelope (`v1.…`) runs the invitee
 * review → redeem → approval → bootstrap flow. Returns a started sync handle on
 * success, or null (with a reported message) otherwise. Secrets are never logged.
 */
export async function connectFromInput(
  plugin: Plugin,
  input: string,
  serverUrl: string,
  options: ConnectFromInputOptions,
): Promise<ConnectionHandle | null> {
  const kind = classifyConnectInput(input);
  try {
    if (kind === 'pairing') {
      return await connectAsOwner(plugin, input.trim(), serverUrl, options);
    }
    if (kind === 'envelope') {
      return await connectAsInvitee(plugin, input.trim(), options);
    }
    options.report(
      'Unrecognised input. Paste a v1.… invitation or an hm_pt_… pairing token.',
    );
    return null;
  } catch (error) {
    options.report(`Could not connect: ${describeError(error)}`);
    return null;
  }
}

async function connectAsOwner(
  plugin: Plugin,
  pairingToken: string,
  serverUrl: string,
  options: ConnectFromInputOptions,
): Promise<ConnectionHandle | null> {
  const apiBaseUrl = normalizeServerOrigin(serverUrl);
  if (apiBaseUrl === null) {
    options.report('Enter the server URL (https://…) to pair the owner device.');
    return null;
  }
  options.report('Pairing owner device…');
  // The raw refresh token never crosses the wire to /owner/pair — only its hash
  // does. The server binds the family to the hash; the client keeps the secret.
  const refreshToken = generateRefreshTokenValue();
  const pairing = await pairOwnerDevice({
    requestUrl: createRequestUrlFn(),
    apiBaseUrl,
    deviceLabel: OWNER_DEVICE_LABEL,
    initialRefreshTokenHash: await sha256Hex(refreshToken),
    pairingToken,
  });

  const clientInstanceId = await ensureClientInstanceId(
    createClientInstanceRepo(plugin),
  );
  const secrets = new ObsidianOnboardingSecrets({
    clientInstanceId,
    secretStorage: plugin.app.secretStorage,
  });
  await secrets.saveRefreshToken(refreshToken);
  const connection: StoredConnection = {
    apiBaseUrl,
    vaultId: pairing.vaultId,
    deviceId: pairing.deviceId,
    ...(pairing.memberId === undefined ? {} : { memberId: pairing.memberId }),
  };
  await writeOwnerConnection(plugin, connection);

  options.report('Connected. Syncing…');
  return startSyncLoop(plugin, connection, options.onStatus, {
    role: 'owner',
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
}

async function connectAsInvitee(
  plugin: Plugin,
  envelope: string,
  options: ConnectFromInputOptions,
): Promise<ConnectionHandle | null> {
  const { controller: onboarding } = await buildOnboardingController(plugin);
  options.report('Reviewing invitation…');
  onboarding.beginFromPastedEnvelope(envelope);
  await onboarding.loadInvitationReview();
  options.report('Redeeming invitation…');
  const pending = await onboarding.confirmInvitation(INVITEE_DEVICE_LABEL);
  if (pending.phase === 'pending-approval') {
    options.report(
      `Ask the owner to approve this phrase: ${pending.verificationPhrase}. Waiting…`,
    );
    // Surface the phrase durably so a pane reopen resumes the waiting screen.
    options.onPendingApproval?.(pending.verificationPhrase);
  }

  const state = await driveToConnected({
    controller: onboarding,
    sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
    pollIntervalMs: APPROVAL_POLL_INTERVAL_MS,
    maxSteps: MAX_CONNECT_STEPS,
  });
  if (state.phase === 'rejected') {
    // An auth rejection is an expected in-flow response, not a connection loss:
    // never flip to offline. Hand the caller a distinct terminal signal so it
    // shows "invitation no longer valid — ask for a new one" instead of a wait.
    options.report(
      'This invitation is no longer valid — ask the owner for a new one.',
    );
    options.onInvitationRejected?.();
    return null;
  }
  if (!isConnectedOnboardingState(state)) {
    options.report('Timed out waiting for approval. Try Connect again.');
    return null;
  }

  const connected = state as unknown as StoredConnection;
  options.report('Connected. Syncing…');
  return startSyncLoop(plugin, connected, options.onStatus, {
    role: 'editor',
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
}

function normalizeServerOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'unexpected error';
}

/**
 * Owner-only: mint a new invitation for the connected vault and return the
 * copyable envelope. Requires an already-connected owner session; returns null
 * if the vault is not connected. The envelope (which contains the secret) is
 * returned for display only and is never logged.
 */
export async function createInvitationForOwner(
  plugin: Plugin,
  options?: { intendedRole?: 'editor' | 'owner'; intendedMemberDisplayName?: string },
): Promise<CreatedInvitation | null> {
  // The owner may be connected via /owner/pair (an ownerConnection record) or via
  // the invitee onboarding flow (a connected onboarding state). Resolve either.
  const connected = await resolveConnectedVault(plugin);
  if (connected === null) {
    return null;
  }

  const clientInstanceId = await ensureClientInstanceId(
    createClientInstanceRepo(plugin),
  );
  const secrets = new ObsidianOnboardingSecrets({
    clientInstanceId,
    secretStorage: plugin.app.secretStorage,
  });
  const accessProvider = new RefreshTokenAccessProvider({
    requestUrl: createRequestUrlFn(),
    apiBaseUrl: connected.apiBaseUrl,
    getRefreshToken: () => secrets.getRefreshToken(),
    saveRefreshToken: (value) => secrets.saveRefreshToken(value),
    generateRotationId: generateRotationIdValue,
    generateSuccessorToken: generateRefreshTokenValue,
  });

  return createVaultInvitation({
    requestUrl: createRequestUrlFn(),
    apiBaseUrl: connected.apiBaseUrl,
    serverOrigin: connected.serverOrigin,
    vaultId: connected.vaultId,
    getAccessToken: () => accessProvider.getAccessToken(),
    ...(options?.intendedRole === undefined
      ? {}
      : { intendedRole: options.intendedRole }),
    ...(options?.intendedMemberDisplayName === undefined
      ? {}
      : { intendedMemberDisplayName: options.intendedMemberDisplayName }),
  });
}

/**
 * Owner-only: approve the device that redeemed an invitation and read out
 * `verificationPhrase`. Requires an already-connected owner session; returns
 * null if the vault is not connected. The phrase is a second-channel secret
 * and is never logged (only forwarded to the request body).
 */
export async function approvePendingDeviceForOwner(
  plugin: Plugin,
  options: { invitationId: string; verificationPhrase: string },
): Promise<ApprovedDevice | null> {
  const connected = await resolveConnectedVault(plugin);
  if (connected === null) {
    return null;
  }

  const clientInstanceId = await ensureClientInstanceId(
    createClientInstanceRepo(plugin),
  );
  const secrets = new ObsidianOnboardingSecrets({
    clientInstanceId,
    secretStorage: plugin.app.secretStorage,
  });
  const accessProvider = new RefreshTokenAccessProvider({
    requestUrl: createRequestUrlFn(),
    apiBaseUrl: connected.apiBaseUrl,
    getRefreshToken: () => secrets.getRefreshToken(),
    saveRefreshToken: (value) => secrets.saveRefreshToken(value),
    generateRotationId: generateRotationIdValue,
    generateSuccessorToken: generateRefreshTokenValue,
  });

  return approveRedeemedDevice({
    requestUrl: createRequestUrlFn(),
    apiBaseUrl: connected.apiBaseUrl,
    vaultId: connected.vaultId,
    invitationId: options.invitationId,
    verificationPhrase: options.verificationPhrase,
    getAccessToken: () => accessProvider.getAccessToken(),
  });
}

/**
 * Owner-only (F9 Rejoin): issue a rejoin grant for a known, currently-dead
 * contact. Requires an already-connected owner session (mirrors
 * `createInvitationForOwner`); returns null when the vault is not connected so
 * the caller can prompt the owner to connect first. Nothing secret is returned —
 * only the non-secret "waiting for the contact to reconnect" acknowledgement.
 */
export async function requestRejoinGrantForOwner(
  plugin: Plugin,
  options: { membershipId: string },
): Promise<RejoinGrantWaiting | null> {
  const connected = await resolveConnectedVault(plugin);
  if (connected === null) {
    return null;
  }

  const clientInstanceId = await ensureClientInstanceId(
    createClientInstanceRepo(plugin),
  );
  const secrets = new ObsidianOnboardingSecrets({
    clientInstanceId,
    secretStorage: plugin.app.secretStorage,
  });
  const accessProvider = new RefreshTokenAccessProvider({
    requestUrl: createRequestUrlFn(),
    apiBaseUrl: connected.apiBaseUrl,
    getRefreshToken: () => secrets.getRefreshToken(),
    saveRefreshToken: (value) => secrets.saveRefreshToken(value),
    generateRotationId: generateRotationIdValue,
    generateSuccessorToken: generateRefreshTokenValue,
  });

  return requestRejoinGrant({
    apiBaseUrl: connected.apiBaseUrl,
    requestUrl: createRequestUrlFn(),
    getAccessToken: () => accessProvider.getAccessToken(),
    membershipId: options.membershipId,
  });
}

/** The persisted (membershipId, deviceId, apiBaseUrl) an invitee presents on rejoin. */
interface RejoinIdentity {
  readonly apiBaseUrl: string;
  readonly deviceId: string;
  readonly membershipId: string;
}

/**
 * Reads back this device's own rejoin identity from plugin data — the same
 * (membershipId, deviceId) binding it holds from onboarding/pairing. An owner
 * device carries them in its `ownerConnection` record; an invitee carries them
 * in its connected onboarding state (`memberId` is the active membership id).
 * Returns null when neither is present (nothing to rejoin with).
 */
async function readRejoinIdentity(
  plugin: Plugin,
): Promise<RejoinIdentity | null> {
  const owner = await readOwnerConnection(plugin);
  if (
    owner !== null &&
    owner.deviceId !== undefined &&
    owner.memberId !== undefined
  ) {
    return {
      apiBaseUrl: owner.apiBaseUrl,
      deviceId: owner.deviceId,
      membershipId: owner.memberId,
    };
  }
  const { controller: onboarding } = await buildOnboardingController(plugin);
  const state = await onboarding.resume();
  if (isConnectedOnboardingState(state)) {
    const connected = state as unknown as {
      apiBaseUrl: string;
      deviceId: string;
      memberId: string;
    };
    if (
      typeof connected.deviceId === 'string' &&
      typeof connected.memberId === 'string'
    ) {
      return {
        apiBaseUrl: connected.apiBaseUrl,
        deviceId: connected.deviceId,
        membershipId: connected.memberId,
      };
    }
  }
  return null;
}

/**
 * Invitee-side (F9 Rejoin): build a `RejoinController` from this device's own
 * persisted binding after its session hit a terminal auth failure. Returns null
 * when no identity is stored (nothing to rejoin with).
 *
 * The `hashRefreshToken` port is synchronous, but the only hashing primitive
 * available in the browser-platform bundle (`crypto.subtle.digest`) is async —
 * and the build forbids `node:crypto`. So we generate ONE candidate refresh
 * token up front, hash it once here with the same SHA-256 hex helper every other
 * token uses (zero new crypto), then hand the controller stable synchronous
 * ports that always return that pre-computed pair. Reusing one candidate across
 * polls is safe: the raw token is only ever persisted and used once redemption
 * succeeds; on every unsuccessful poll only its hash is sent and never bound.
 */
export async function buildRejoinControllerForInvitee(
  plugin: Plugin,
): Promise<RejoinController | null> {
  const identity = await readRejoinIdentity(plugin);
  if (identity === null) {
    return null;
  }

  const clientInstanceId = await ensureClientInstanceId(
    createClientInstanceRepo(plugin),
  );
  const secrets = new ObsidianOnboardingSecrets({
    clientInstanceId,
    secretStorage: plugin.app.secretStorage,
  });

  const candidateToken = generateRefreshTokenValue();
  const candidateTokenHash = await sha256Hex(candidateToken);

  return new RejoinController({
    apiBaseUrl: identity.apiBaseUrl,
    requestUrl: createRequestUrlFn(),
    membershipId: identity.membershipId,
    deviceId: identity.deviceId,
    generateRefreshToken: () => candidateToken,
    hashRefreshToken: () => candidateTokenHash,
    saveRefreshToken: (token) => secrets.saveRefreshToken(token),
  });
}

function generateBrandedToken(prefix: string): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64url = btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
  return `${prefix}${base64url}`;
}

function generateRefreshTokenValue(): string {
  return generateBrandedToken('hm_rt_');
}

/**
 * A server-recognised refresh rotation id (`hm_ri_…`). The server rejects the
 * rotation unless `rotationId` parses as this branded token — a plain UUID here
 * caused `/auth/refresh` to 401 on every call (F8-02f bug A).
 */
function generateRotationIdValue(): string {
  return generateBrandedToken('hm_ri_');
}

/** SHA-256 hex of a token string, matching the server's `hashToken`. */
async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export { SyncScheduler };
