/**
 * Change detection for the `.obsidian/` config mirror. Obsidian emits NO vault
 * events for hidden files, so a watcher can never see a theme change or a foreign
 * plugin update, the mirror is driven by POLLING instead.
 *
 * Each tick re-walks the config tree (via {@link listSyncableConfigPaths}), reads
 * every syncable file, and hands each path to the SAME {@link VaultChangeObserver}
 * that drives `.md` sync. The observer hashes the content and compares it to the
 * durable producer mapping (the last-known base): unchanged → no-op, changed →
 * an update revision, unseen → a create revision, all enqueued through the SAME
 * outbox pipeline. A config file that is in the mapping but no longer on disk is a
 * delete. Because the diff is BY CONTENT HASH against the mapping, a file just
 * written by a remote apply (which also adopts that hash into the mapping) hashes
 * equal and is never re-enqueued, the cycle guard.
 */

import { isSyncableConfigPath } from '@havemind/protocol';

import {
  normalizeWirePath,
  type LocalChangeOperation,
  type LocalFileMapping,
  type VaultChangeObserver,
  type VaultSnapshotPort,
} from '../obsidian/vault-adapter';
import {
  CONFIG_DIR,
  listSyncableConfigPaths,
  type ConfigAdapterPort,
} from './config-adapter';

/**
 * A {@link VaultSnapshotPort} that reads the config tree through the
 * DataAdapter. This is what lets the standard observer read a `.obsidian/` file
 * that `vault.getFiles()`/`vault.read()` cannot resolve.
 */
export function createConfigVaultSnapshot(
  adapter: ConfigAdapterPort,
  root: string = CONFIG_DIR,
): VaultSnapshotPort {
  return {
    listSyncablePaths: () => listSyncableConfigPaths(adapter, root),
    // Only syncable config is ever enumerated; there is no separate "excluded
    // attachment" notion for the config mirror, so listAllPaths mirrors it.
    listAllPaths: () => listSyncableConfigPaths(adapter, root),
    readText: (path) => adapter.read(path),
    readBinary: async (path) => new Uint8Array(await adapter.readBinary(path)),
    exists: (path) => adapter.exists(path),
  };
}

export interface ConfigPollerDeps {
  /** The SAME observer that drives `.md`, so config shares its mappings and cycle guard. */
  readonly observer: Pick<
    VaultChangeObserver,
    'observeModify' | 'observeDelete'
  >;
  /** Current syncable config paths on disk (the DataAdapter walk). */
  readonly listConfigPaths: () => Promise<readonly string[]>;
  /** The durable producer mappings, the last-known base to diff deletes against. */
  readonly listMappings: () => Promise<readonly LocalFileMapping[]>;
}

/**
 * Runs one poll tick and returns the genuine (non-no-op) change operations it
 * enqueued, created/updated config files first, then deletes. A steady-state
 * tick with no config changes returns an empty array and enqueues nothing.
 *
 * The observer itself decides create-vs-update-vs-noop from the mapping, so this
 * only has to (a) feed every current config path through `observeModify` and
 * (b) tombstone any config mapping whose path vanished from disk.
 */
export async function pollConfigOnce(
  deps: ConfigPollerDeps,
): Promise<LocalChangeOperation[]> {
  const ops: LocalChangeOperation[] = [];

  const configPaths = await deps.listConfigPaths();
  const onDisk = new Set<string>();
  for (const path of configPaths) {
    onDisk.add(normalizeWirePath(path).toLowerCase());
    const op = await deps.observer.observeModify(path);
    if (op !== null) ops.push(op);
  }

  for (const mapping of await deps.listMappings()) {
    // Only config mappings are the poller's concern, `.md` deletes are handled
    // by the vault-event watchers, never here.
    if (!isSyncableConfigPath(mapping.path)) continue;
    if (onDisk.has(mapping.collisionKey)) continue;
    const op = await deps.observer.observeDelete(mapping.path);
    if (op !== null) ops.push(op);
  }

  return ops;
}
