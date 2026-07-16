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
  requestUrl,
  type Plugin,
  type TFile,
  type Vault,
} from 'obsidian';

/** The runtime App exposes a Vault; the ambient stub only models what we use. */
type AppWithVault = { vault: Vault };

import { HavemindSyncController } from './controller';
import { SyncScheduler, type SchedulerHooks } from './scheduler';
import { formatStatusBar, type StatusBarView } from './status';
import {
  DurableSyncState,
  type SyncStatePersistPort,
} from './sync-state';
import {
  RequestUrlTransport,
  type RequestUrlFn,
} from './sync-transport';
import { VaultApplyAdapter, type VaultFilePort } from './vault-apply';
import { RefreshTokenAccessProvider } from './access-token';
import { driveToConnected } from './connect-driver';
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
    return { status: response.status, json: response.json };
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
  /** Resolves a Havemind fileId to its current vault-relative path. */
  readonly pathForFileId: (fileId: string) => string | null;
}

/** Binds the runner's `VaultFilePort` to the live Vault. */
export function createVaultFilePort(options: VaultFilePortOptions): VaultFilePort {
  const { vault, pathForFileId } = options;
  return {
    openBufferStates(): readonly OpenBuffer[] {
      // Buffer divergence is resolved from the editor layer; the desktop shell
      // wires live buffers in a later slice. Until then no buffer is reported,
      // which is the safe default (clean → apply).
      return [];
    },
    async writeByFileId(fileId, content) {
      const path = pathForFileId(fileId);
      if (path === null) return;
      const existing = vault.getAbstractFileByPath(path);
      if (existing === null) {
        await vault.create(path, content);
        return;
      }
      await vault.modify(existing as TFile, content);
    },
    async writeConflictArtifact(path, content) {
      if (vault.getAbstractFileByPath(CONFLICT_FOLDER) === null) {
        await vault.createFolder(CONFLICT_FOLDER);
      }
      await vault.create(path, content);
    },
  };
}

export interface SyncConnection {
  readonly apiBaseUrl: string;
  readonly vaultId: string;
  readonly getAuthToken: () => Promise<string>;
  readonly pathForFileId: (fileId: string) => string | null;
  readonly resolveRemoteContent: (event: RemoteEvent) => Promise<string>;
  readonly serverEpoch?: () => string | null;
  readonly intervalMs?: number;
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
  onStatus: (view: StatusBarView) => void,
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
  });

  const vault = new VaultApplyAdapter({
    files: createVaultFilePort({
      vault: (plugin.app as unknown as AppWithVault).vault,
      pathForFileId: connection.pathForFileId,
    }),
    conflictFolder: CONFLICT_FOLDER,
    resolveContent: connection.resolveRemoteContent,
  });

  const runner = new SyncRunner({
    transport,
    state,
    vault,
    scheduler: createBackoffScheduler(),
  });

  const controller = new HavemindSyncController({
    runner,
    hooks: createSchedulerHooks(plugin),
    intervalMs: connection.intervalMs ?? DEFAULT_INTERVAL_MS,
    onStatus,
  });

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
}

const NOOP_HANDLE: ConnectionHandle = { stop: () => undefined };

/**
 * Resumes any stored onboarding to `connected` and, once connected, builds and
 * starts the sync controller. Called on layout-ready; if there is no in-flight
 * connection it reports `disconnected` and starts nothing (passive shell).
 */
export async function startHavemindConnection(
  plugin: Plugin,
  onStatus: (view: StatusBarView) => void,
): Promise<ConnectionHandle> {
  const { controller: onboarding } = await buildOnboardingController(plugin);

  const connectedState = await driveToConnected({
    controller: onboarding,
    sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
    pollIntervalMs: APPROVAL_POLL_INTERVAL_MS,
    maxSteps: MAX_CONNECT_STEPS,
  });

  if (!isConnectedOnboardingState(connectedState)) {
    onStatus(HAVEMIND_STATUS_DISCONNECTED);
    return NOOP_HANDLE;
  }

  const connected = connectedState as unknown as {
    apiBaseUrl: string;
    vaultId: string;
  };
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
    generateRotationId: () => globalThis.crypto.randomUUID(),
    generateSuccessorToken: generateRefreshTokenValue,
  });

  const resolvers = buildConnectionResolvers({
    apiBaseUrl: connected.apiBaseUrl,
    vaultId: connected.vaultId,
    getAccessToken: () => accessProvider.getAccessToken(),
    requestUrl: createRequestUrlFn(),
    // Remote-only files carry their path inside the opaque payload header, whose
    // decode pipeline is the documented follow-up; until it lands no remote-only
    // fileId resolves to a path and its write is skipped (rule 4, never guess).
    knownPath: () => null,
  });

  const { controller } = buildSyncController(
    plugin,
    {
      apiBaseUrl: resolvers.apiBaseUrl,
      vaultId: resolvers.vaultId,
      getAuthToken: resolvers.getAuthToken,
      pathForFileId: resolvers.pathForFileId,
      resolveRemoteContent: resolvers.resolveRemoteContent,
    },
    onStatus,
  );
  controller.start();
  return { stop: () => controller.stop() };
}

function generateRefreshTokenValue(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64url = btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
  return `hm_rt_${base64url}`;
}

export { SyncScheduler };
