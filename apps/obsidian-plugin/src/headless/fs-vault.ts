/**
 * A vault that is a folder on disk, for the headless agent client (plan 014).
 *
 * It offers the small part of Obsidian's `Vault` that the production file port
 * (`runtime/adapters/vault-file-port.ts`) calls, and the `VaultSnapshotPort`
 * the push producer reads, so the agent runs the plugin's own sync code over a
 * plain directory instead of re-implementing it. Paths are vault-relative with
 * `/` separators, as in Obsidian. A folder is an object with `children`, which
 * is how the file port tells folders from files.
 */

import { promises as fs } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import type { VaultSnapshotPort } from '../obsidian/vault-adapter';
import { CONFIG_DIR, listSyncableConfigPaths } from '../sync/config-adapter';

/** Where a remotely deleted file goes, like Obsidian's local `.trash`. */
export const TRASH_FOLDER = '.trash';

interface FsEntry {
  readonly path: string;
  readonly children?: readonly never[];
}

export interface FsVault {
  /** The `Vault`-shaped object handed to `createVaultFilePort`. */
  readonly vault: unknown;
  readonly snapshot: VaultSnapshotPort;
}

function toBuffer(data: ArrayBuffer): Uint8Array {
  return new Uint8Array(data);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Every file under `root`, vault-relative, skipping dot-folders (`.trash`, `.obsidian`). */
async function walk(root: string, folder = ''): Promise<string[]> {
  const entries = await fs.readdir(join(root, folder), { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const path = folder === '' ? entry.name : `${folder}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...(await walk(root, path)));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

/** Opens (and creates, if missing) the vault folder at `root`. */
export async function openFsVault(root: string): Promise<FsVault> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const abs = (path: string): string => {
    const full = join(root, ...path.split('/'));
    // A vault path never leaves the vault: a hostile `../` from a remote
    // revision must not reach the rest of the disk.
    const back = relative(root, full);
    if (back.startsWith('..') || back.includes(`${sep}..${sep}`)) {
      throw new Error(`Path escapes the vault: ${path}`);
    }
    return full;
  };

  const entryAt = async (path: string): Promise<FsEntry | null> => {
    try {
      const stat = await fs.stat(abs(path));
      return stat.isDirectory() ? { path, children: [] } : { path };
    } catch {
      return null;
    }
  };

  // The file port looks paths up synchronously (as Obsidian does from its
  // in-memory index), so the vault keeps the same kind of index, seeded from
  // disk here and updated on every write through this object.
  const index = new Map<string, FsEntry>();
  const remember = (path: string, folder: boolean): void => {
    index.set(path, folder ? { path, children: [] } : { path });
  };
  const seed = async (folder: string): Promise<void> => {
    for (const entry of await fs.readdir(join(root, folder), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = folder === '' ? entry.name : `${folder}/${entry.name}`;
      remember(path, entry.isDirectory());
      if (entry.isDirectory()) await seed(path);
    }
  };
  await seed('');

  const writeText = async (path: string, content: string): Promise<FsEntry> => {
    await fs.writeFile(abs(path), content, 'utf8');
    remember(path, false);
    return { path };
  };
  const writeBytes = async (path: string, data: ArrayBuffer): Promise<FsEntry> => {
    await fs.writeFile(abs(path), toBuffer(data));
    remember(path, false);
    return { path };
  };

  const vault = {
    getAbstractFileByPath: (path: string): FsEntry | null => index.get(path) ?? null,
    read: async (file: FsEntry): Promise<string> => fs.readFile(abs(file.path), 'utf8'),
    readBinary: async (file: FsEntry): Promise<ArrayBuffer> =>
      toArrayBuffer(await fs.readFile(abs(file.path))),
    create: (path: string, content: string) => writeText(path, content),
    createBinary: (path: string, data: ArrayBuffer) => writeBytes(path, data),
    modify: async (file: FsEntry, content: string): Promise<void> => {
      await writeText(file.path, content);
    },
    modifyBinary: async (file: FsEntry, data: ArrayBuffer): Promise<void> => {
      await writeBytes(file.path, data);
    },
    process: async (file: FsEntry, transform: (text: string) => string): Promise<string> => {
      const next = transform(await fs.readFile(abs(file.path), 'utf8'));
      await writeText(file.path, next);
      return next;
    },
    createFolder: async (path: string): Promise<void> => {
      await fs.mkdir(abs(path));
      remember(path, true);
    },
    trash: async (file: FsEntry): Promise<void> => {
      const target = abs(`${TRASH_FOLDER}/${file.path}`);
      await fs.mkdir(dirname(target), { recursive: true });
      await fs.rename(abs(file.path), target);
      index.delete(file.path);
    },
    // `.obsidian/` settings a person's device syncs: kept byte for byte, never
    // read by the agent.
    adapter: {
      exists: async (path: string): Promise<boolean> => (await entryAt(path)) !== null,
      read: async (path: string): Promise<string> => fs.readFile(abs(path), 'utf8'),
      readBinary: async (path: string): Promise<ArrayBuffer> => toArrayBuffer(await fs.readFile(abs(path))),
      write: async (path: string, data: string): Promise<void> => {
        await fs.mkdir(dirname(abs(path)), { recursive: true });
        await fs.writeFile(abs(path), data, 'utf8');
      },
      writeBinary: async (path: string, data: ArrayBuffer): Promise<void> => {
        await fs.mkdir(dirname(abs(path)), { recursive: true });
        await fs.writeFile(abs(path), toBuffer(data));
      },
      mkdir: async (path: string): Promise<void> => {
        await fs.mkdir(abs(path), { recursive: true });
      },
      remove: async (path: string): Promise<void> => {
        await fs.rm(abs(path), { force: true });
      },
      list: async (path: string): Promise<{ files: string[]; folders: string[] }> => {
        const entries = await fs.readdir(abs(path), { withFileTypes: true });
        const at = (name: string): string => (path === '' ? name : `${path}/${name}`);
        return {
          files: entries.filter((e) => e.isFile()).map((e) => at(e.name)),
          folders: entries.filter((e) => e.isDirectory()).map((e) => at(e.name)),
        };
      },
    },
  };

  const snapshot: VaultSnapshotPort = {
    // Notes and attachments, plus the synced `.obsidian/` settings, exactly as
    // the plugin lists them: reconciliation reads a mapped path missing from
    // this list as a local delete.
    listSyncablePaths: async () => [
      ...(await walk(root)),
      ...((await vault.adapter.exists(CONFIG_DIR)) ? await listSyncableConfigPaths(vault.adapter, CONFIG_DIR) : []),
    ],
    listAllPaths: () => walk(root),
    readText: async (path) => fs.readFile(abs(path), 'utf8'),
    readBinary: async (path) => new Uint8Array(await fs.readFile(abs(path))),
    exists: async (path) => (await entryAt(path)) !== null,
  };

  return { vault, snapshot };
}
