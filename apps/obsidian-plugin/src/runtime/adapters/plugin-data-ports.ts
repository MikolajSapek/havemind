/**
 * Every port that reads or writes the plugin's single `data.json` blob through
 * `Plugin.loadData`/`saveData`: the durable sync-state persist port with its
 * atomic stage-then-promote save, the corrupt-blob sidecar preservers, the
 * client-instance id repository, the onboarding store's raw port, the
 * out-of-band outbox payload store, and the one-time AUD-03 hash rebase that
 * migrates the blob in place. They belong together because they all share one
 * serialising mutex and one key namespace — a write that bypassed either would
 * clobber a sibling subsystem's top-level key.
 */

import type { Plugin, TFile } from 'obsidian';

import { canonicalizeMarkdown, hashPlaintext } from '@havemind/protocol';

import {
  rebaseCanonicalizedHashes,
  type RebaseVaultPort,
} from '../canonicalization-rebase';
import {
  createSerializedDataPort,
  getPluginDataMutex,
} from '../plugin-data-mutex';
import type {
  OutboxPayloadStore,
  SyncStatePersistPort,
} from '../sync-state';
import type { OnboardingPersistPort } from '../onboarding-store';
import {
  IndexedDbClientStore,
  ensureClientInstanceId,
  type ClientInstanceIdRepository,
} from '../../storage/client-store';

import {
  CANONICALIZATION_REBASE_MARKER_KEY,
  CLIENT_INSTANCE_KEY,
  PERSIST_BAK_KEY,
  PERSIST_CORRUPT_PREFIX,
  PERSIST_KEY,
  PERSIST_PRODUCER_CORRUPT_PREFIX,
  PERSIST_STAGING_KEY,
  PUSH_PRODUCER_KEY,
} from './plugin-data-keys';
import { isRecord, type AppWithVault } from './shared';

/**
 * Durable state persistence over `Plugin.saveData`/`loadData`. Only the
 * non-secret sync bookkeeping is stored under a dedicated key; credentials stay
 * in SecretStorage.
 */
export function createPersistPort(plugin: Plugin): SyncStatePersistPort {
  const mutex = getPluginDataMutex(plugin);
  return {
    async load() {
      const data = await plugin.loadData();
      if (isRecord(data)) return data[PERSIST_KEY] ?? null;
      return null;
    },
    async loadBackup() {
      const data = await plugin.loadData();
      if (isRecord(data)) return data[PERSIST_BAK_KEY] ?? null;
      return null;
    },
    async save(state) {
      // Atomic save (GAP-1). Two serialized load-modify-saves, so a torn write
      // can never destroy the previous good primary, and a concurrent write to
      // another top-level key (producer, roster, onboarding, …) is never
      // clobbered (via the shared mutex):
      //   Phase 1 — stage the new blob under the staging key, leaving the
      //             primary and its `.bak` untouched.
      //   Phase 2 — promote: demote the current primary to `.bak`, install the
      //             staged blob as the new primary, and clear the staging slot.
      // If phase 2's write is torn, the disk still holds the prior primary plus
      // the staged copy, so load() keeps returning the last good primary.
      await mutex.update((base) => ({ ...base, [PERSIST_STAGING_KEY]: state }));
      await mutex.update((base) => {
        const next = { ...base };
        const priorPrimary = next[PERSIST_KEY];
        // Retain exactly one previous-good backup.
        if (priorPrimary !== undefined) next[PERSIST_BAK_KEY] = priorPrimary;
        next[PERSIST_KEY] =
          PERSIST_STAGING_KEY in next ? next[PERSIST_STAGING_KEY] : state;
        delete next[PERSIST_STAGING_KEY];
        return next;
      });
    },
    async preserveCorrupt(raw, timestamp) {
      // Keep the corrupt bytes under a timestamped sidecar; never clobber a
      // pre-existing corrupt sidecar at the same key.
      await mutex.update((base) => {
        const key = `${PERSIST_CORRUPT_PREFIX}${timestamp}`;
        if (key in base) return base;
        return { ...base, [key]: raw };
      });
    },
  };
}

/**
 * Preserve a present-but-corrupt PRODUCER blob under a timestamped sidecar
 * (GAP-3), mirroring `createPersistPort.preserveCorrupt`'s convention: keyed by a
 * caller-supplied timestamp and never clobbering a pre-existing sidecar at the
 * same key. Used by the producer store's load path so unparseable mapping bytes
 * are kept for recovery rather than silently discarded. Writes through the shared
 * plugin-data mutex so it never races a concurrent write to another top-level key.
 */
export async function preserveCorruptProducerState(
  plugin: Plugin,
  raw: unknown,
  timestamp: number,
): Promise<void> {
  await getPluginDataMutex(plugin).update((base) => {
    const key = `${PERSIST_PRODUCER_CORRUPT_PREFIX}${timestamp}`;
    if (key in base) return base;
    return { ...base, [key]: raw };
  });
}

/**
 * Runs the AUD-03 one-time hash rebase (PART 2) over the plugin's own data
 * blob, reading current on-disk bytes through the real Vault. Idempotent via the
 * persisted version marker; safe to call on every connect.
 */
export async function runCanonicalizationRebase(plugin: Plugin): Promise<void> {
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

/**
 * Plugin-data load/save for the onboarding store, serialized through the shared
 * per-plugin mutex so its whole-blob save re-reads the latest on-disk snapshot
 * and only its own top-level key is written — a concurrent save to another key
 * (sync state, producer, roster) is never clobbered (MAJOR).
 */
export function createRawPersistPort(plugin: Plugin): OnboardingPersistPort {
  return createSerializedDataPort(getPluginDataMutex(plugin));
}

export function createClientInstanceRepo(
  plugin: Plugin,
): ClientInstanceIdRepository {
  return {
    async readClientInstanceId() {
      const data = await plugin.loadData();
      const value = isRecord(data) ? data[CLIENT_INSTANCE_KEY] : null;
      return typeof value === 'string' ? value : null;
    },
    async writeClientInstanceId(value) {
      await getPluginDataMutex(plugin).update((base) => ({
        ...base,
        [CLIENT_INSTANCE_KEY]: value,
      }));
    },
  };
}

/**
 * Arch P1: the out-of-band outbox payload store backed by {@link
 * IndexedDbClientStore}. Large outbox payload bytes live here instead of inline
 * in `data.json` (which is re-serialised on every cursor save). CONNECT-SAFE and
 * mobile-safe: the returned adapter's construction never throws; the underlying
 * IndexedDB connection is opened lazily on first access and, if it is
 * unavailable (or any call fails), the adapter degrades so {@link
 * DurableSyncState} keeps the payload inline — sync is never broken. The client
 * instance id + the open both happen once behind a cached promise.
 */
export function createOutboxPayloadStore(plugin: Plugin): OutboxPayloadStore {
  let storePromise: Promise<IndexedDbClientStore | null> | null = null;
  const ensureStore = (): Promise<IndexedDbClientStore | null> => {
    if (storePromise === null) {
      storePromise = (async () => {
        try {
          const clientInstanceId = await ensureClientInstanceId(
            createClientInstanceRepo(plugin),
          );
          const store = new IndexedDbClientStore({ clientInstanceId });
          await store.open();
          return store;
        } catch (error) {
          console.warn(
            'Havemind: outbox payload store unavailable; payloads stay inline in data.json.',
            error,
          );
          return null;
        }
      })();
    }
    return storePromise;
  };
  return {
    async putPayload(revisionId, payloadBase64) {
      const store = await ensureStore();
      // Throw when unavailable so DurableSyncState keeps the payload inline.
      if (store === null) {
        throw new Error('Havemind: outbox payload store is unavailable.');
      }
      await store.putPayload(revisionId, payloadBase64);
    },
    async getPayload(revisionId) {
      const store = await ensureStore();
      if (store === null) return undefined;
      return store.getPayload(revisionId);
    },
    async deletePayload(revisionId) {
      const store = await ensureStore();
      if (store === null) return;
      await store.deletePayload(revisionId);
    },
  };
}
