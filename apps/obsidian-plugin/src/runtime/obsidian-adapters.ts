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
import {
  SyncRunner,
  type OpenBuffer,
  type RemoteEvent,
  type SchedulerFn,
} from '../sync/sync-runner';

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

export { SyncScheduler };
