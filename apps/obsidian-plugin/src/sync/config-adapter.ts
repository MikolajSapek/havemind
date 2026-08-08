/**
 * Hidden-file (`.obsidian/`) access over the Obsidian **DataAdapter**, not the
 * Vault file API. Obsidian never surfaces `.obsidian/` through `vault.getFiles()`
 * or its `create`/`modify`/`on(...)` events, so the config mirror must enumerate,
 * read and write through `vault.adapter.*` instead. Every discovered path is
 * filtered through `isSyncableConfigPath`, an EXPLICIT APPEARANCE ALLOWLIST — so
 * third-party plugin code and state (`.obsidian/plugins/**`), the
 * enabled-plugins registry, the per-machine `workspace.json` and any unvetted
 * config file never cross the boundary (audit #3 finding 2).
 *
 * Pure over an injected {@link ConfigAdapterPort}: no Obsidian imports, so the
 * walk and the disk I/O are unit-testable against an in-memory adapter.
 */

import { isSyncableConfigPath } from '@havemind/protocol';

/** The vault's config directory. Matches the `.obsidian/` prefix the predicate keys on. */
export const CONFIG_DIR = '.obsidian';

/**
 * Our own plugin's folder — pruned from the walk entirely (its `data.json` is the
 * pairing/session secret). `isSyncableConfigPath` also denies it, so this is a
 * belt-and-suspenders optimisation, not the sole guard.
 */
const HAVEMIND_PLUGIN_DIR = '.obsidian/plugins/havemind-sync';

/** The shape `DataAdapter.list` returns: full vault-relative paths, not basenames. */
export interface ConfigAdapterListing {
  readonly files: readonly string[];
  readonly folders: readonly string[];
}

/**
 * The subset of Obsidian's `DataAdapter` the config mirror uses. Kept a narrow
 * injectable seam so tests exercise the real enumeration/read/write boundary with
 * an in-memory double.
 */
export interface ConfigAdapterPort {
  list(path: string): Promise<ConfigAdapterListing>;
  read(path: string): Promise<string>;
  readBinary(path: string): Promise<ArrayBuffer>;
  write(path: string, data: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

function isUnderHavemindPlugin(folder: string): boolean {
  return (
    folder === HAVEMIND_PLUGIN_DIR || folder.startsWith(`${HAVEMIND_PLUGIN_DIR}/`)
  );
}

/**
 * Walks `root` (`.obsidian/` by default) recursively via `adapter.list`, returning
 * every in-scope config file path (sorted). It keeps only what
 * `isSyncableConfigPath` admits — the appearance allowlist — so every file under
 * `.obsidian/plugins/` is dropped, foreign plugin code included, along with
 * `workspace.json`, `community-plugins.json` and any config file not on the
 * list. The walk still DESCENDS into `.obsidian/plugins/` (minus our own
 * `havemind-sync/` folder, pruned outright): descending and then rejecting is
 * what lets the tests prove the allowlist is doing the work, rather than an
 * enumeration blind spot. A missing/uninitialised directory yields no entries
 * rather than throwing, so a fresh vault never wedges the walk.
 */
export async function listSyncableConfigPaths(
  adapter: Pick<ConfigAdapterPort, 'list'>,
  root: string = CONFIG_DIR,
): Promise<string[]> {
  const found: string[] = [];
  const pending: string[] = [root];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const dir = pending.pop();
    if (dir === undefined || visited.has(dir)) continue;
    visited.add(dir);

    let listing: ConfigAdapterListing;
    try {
      listing = await adapter.list(dir);
    } catch {
      // A directory that does not exist yet (or is unreadable) contributes
      // nothing; enumeration of the rest of the tree continues uninterrupted.
      continue;
    }

    for (const file of listing.files) {
      if (isSyncableConfigPath(file)) found.push(file);
    }
    for (const folder of listing.folders) {
      if (isUnderHavemindPlugin(folder)) continue;
      pending.push(folder);
    }
  }

  found.sort();
  return found;
}

/**
 * Creates every ancestor directory of `path` under the config dir, shallowest
 * first, so a `write`/`writeBinary` to a not-yet-seen folder (e.g. a brand-new
 * `.obsidian/plugins/<foreign>/`) never fails. `mkdir` on an existing folder is a
 * tolerated no-op.
 */
export async function ensureConfigParentDirs(
  adapter: Pick<ConfigAdapterPort, 'mkdir'>,
  path: string,
): Promise<void> {
  const separator = path.lastIndexOf('/');
  if (separator === -1) return;
  const segments = path.slice(0, separator).split('/');
  let prefix = '';
  for (const segment of segments) {
    prefix = prefix === '' ? segment : `${prefix}/${segment}`;
    try {
      await adapter.mkdir(prefix);
    } catch {
      // Already exists (or a concurrent create won): a mkdir race is benign —
      // the subsequent write is the operation that actually matters.
    }
  }
}

/** Writes config TEXT, materialising parent dirs first. */
export async function writeConfigText(
  adapter: Pick<ConfigAdapterPort, 'write' | 'mkdir'>,
  path: string,
  content: string,
): Promise<void> {
  await ensureConfigParentDirs(adapter, path);
  await adapter.write(path, content);
}

/** Writes config BINARY bytes, materialising parent dirs first. */
export async function writeConfigBinary(
  adapter: Pick<ConfigAdapterPort, 'writeBinary' | 'mkdir'>,
  path: string,
  data: ArrayBuffer,
): Promise<void> {
  await ensureConfigParentDirs(adapter, path);
  await adapter.writeBinary(path, data);
}

/** Deletes a config file if it exists (idempotent — a missing file is a no-op). */
export async function removeConfig(
  adapter: Pick<ConfigAdapterPort, 'exists' | 'remove'>,
  path: string,
): Promise<void> {
  if (await adapter.exists(path)) await adapter.remove(path);
}
