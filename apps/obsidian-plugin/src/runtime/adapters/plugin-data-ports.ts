/**
 * Every port that reads or writes the plugin's single `data.json` blob through
 * `Plugin.loadData`/`saveData`: the durable sync-state persist port with its
 * atomic stage-then-promote save, the corrupt-blob sidecar preservers, the
 * client-instance id repository, the onboarding store's raw port, the
 * out-of-band outbox payload store, and the one-time AUD-03 hash rebase that
 * migrates the blob in place. They belong together because they all share one
 * serialising mutex and one key namespace, a write that bypassed either would
 * clobber a sibling subsystem's top-level key.
 */

import type { Plugin } from 'obsidian';

import {
  createSerializedDataPort,
  getPluginDataMutex,
} from '../plugin-data-mutex';
import type {
  OutboxPayloadStore,
  SyncStatePersistPort,
} from '../sync-state';
import type { OnboardingPersistPort } from '../onboarding-store';
import type { RevisionHistoryStore } from '../revision-history';
import { createRevisionHistoryStore } from '../revision-history-store';
import {
  IndexedDbClientStore,
  ensureClientInstanceId,
  type ClientInstanceIdRepository,
} from '../../storage/client-store';

import {
  CLIENT_INSTANCE_KEY,
  PERSIST_BAK_KEY,
  PERSIST_CORRUPT_PREFIX,
  PERSIST_KEY,
  PERSIST_PRODUCER_CORRUPT_PREFIX,
  PERSIST_STAGING_KEY,
  withCorruptSidecar,
} from './plugin-data-keys';

/**
 * Durable state persistence over `Plugin.saveData`/`loadData`. Only the
 * non-secret sync bookkeeping is stored under a dedicated key; credentials stay
 * in SecretStorage.
 */
export function createPersistPort(plugin: Plugin): SyncStatePersistPort {
  const mutex = getPluginDataMutex(plugin);
  return {
    async load() {
      return (await mutex.load())[PERSIST_KEY] ?? null;
    },
    async loadBackup() {
      return (await mutex.load())[PERSIST_BAK_KEY] ?? null;
    },
    async save(state) {
      // One write (S2): the new primary, the prior primary as the single
      // `.bak` a schema-corrupt primary recovers from, and no staging copy. A
      // separate staging write added a third copy to the same file, which a
      // torn data.json loses together with the other two. A staging key left
      // by an older version is dropped here.
      await mutex.update((base) => {
        const next = { ...base };
        const priorPrimary = next[PERSIST_KEY];
        if (priorPrimary !== undefined) next[PERSIST_BAK_KEY] = priorPrimary;
        next[PERSIST_KEY] = state;
        delete next[PERSIST_STAGING_KEY];
        return next;
      });
    },
    async preserveCorrupt(raw, timestamp) {
      // Keep the corrupt bytes under a timestamped sidecar; never clobber a
      // pre-existing corrupt sidecar at the same key.
      await mutex.update((base) =>
        withCorruptSidecar(base, PERSIST_CORRUPT_PREFIX, timestamp, raw),
      );
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
  await getPluginDataMutex(plugin).update((base) =>
    withCorruptSidecar(base, PERSIST_PRODUCER_CORRUPT_PREFIX, timestamp, raw),
  );
}

/**
 * Plugin-data load/save for the onboarding store, serialized through the shared
 * per-plugin mutex so its whole-blob save re-reads the latest on-disk snapshot
 * and only its own top-level key is written, a concurrent save to another key
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
      const value = (await getPluginDataMutex(plugin).load())[CLIENT_INSTANCE_KEY];
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
 * DurableSyncState} keeps the payload inline, sync is never broken. The client
 * instance id + the open both happen once behind a cached promise.
 */
export function createOutboxPayloadStore(plugin: Plugin): OutboxPayloadStore {
  const ensureStore = openClientStoreLazily(
    plugin,
    'Havemind: outbox payload store unavailable; payloads stay inline in data.json.',
  );
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
    async listPayloadIds() {
      const store = await ensureStore();
      return store === null ? [] : store.listPayloadIds();
    },
  };
}

/**
 * P13: the accepted revision log for one vault, kept in IndexedDB so a new
 * connection pulls only the events after the last one it knows. Keyed by vault
 * and checked against the server URL, so another vault or server never reuses
 * it. When IndexedDB is unavailable the store holds nothing and every
 * connection reads the whole log, as before.
 */
export function createPersistedRevisionHistoryStore(
  plugin: Plugin,
  scope: { readonly apiBaseUrl: string; readonly vaultId: string },
): RevisionHistoryStore {
  return createRevisionHistoryStore(
    openClientStoreLazily(
      plugin,
      'Havemind: revision history store unavailable; each connection reads the full history.',
    ),
    scope,
  );
}

/**
 * The client database, opened once on first use. CONNECT-SAFE: never throws;
 * resolves to null (after one warning) when IndexedDB cannot be opened.
 */
function openClientStoreLazily(
  plugin: Plugin,
  unavailableWarning: string,
): () => Promise<IndexedDbClientStore | null> {
  let storePromise: Promise<IndexedDbClientStore | null> | null = null;
  return () => {
    if (storePromise === null) {
      storePromise = (async () => {
        try {
          const clientInstanceId = await ensureClientInstanceId(
            createClientInstanceRepo(plugin),
          );
          const store = new IndexedDbClientStore({ clientInstanceId });
          await store.open();
          return store;
        } catch {
          console.warn(unavailableWarning);
          return null;
        }
      })();
    }
    return storePromise;
  };
}
