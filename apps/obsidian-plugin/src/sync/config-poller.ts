/**
 * Change detection for the `.obsidian/` config mirror. Obsidian emits NO vault
 * events for hidden files, so a watcher can never see a theme change or a foreign
 * plugin update, the mirror is driven by POLLING instead.
 *
 * Each tick re-walks the config tree (via `listSyncableConfigPaths`), reads
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
} from '../obsidian/vault-adapter';

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
  /**
   * Size and modification time of a config file, or null when unknown (P8).
   * With `seen`, a file unchanged since it was last observed is not read.
   */
  readonly stat?: (path: string) => Promise<{ readonly mtime: number; readonly size: number } | null>;
  /** Path to the stat key it was last observed at; owned by the caller across ticks. */
  readonly seen?: Map<string, string>;
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
    const stat = deps.seen === undefined ? null : await deps.stat?.(path);
    const key = stat == null ? null : `${stat.mtime}:${stat.size}`;
    if (key !== null && deps.seen?.get(path) === key) continue;
    const op = await deps.observer.observeModify(path);
    if (op !== null) ops.push(op);
    if (key !== null) deps.seen?.set(path, key);
  }
  // Forget files that are gone, so a recreated one is read again.
  for (const path of deps.seen?.keys() ?? []) {
    if (!configPaths.includes(path)) deps.seen?.delete(path);
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
