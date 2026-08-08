import { describe, expect, it } from 'vitest';

import {
  ensureConfigParentDirs,
  listSyncableConfigPaths,
  removeConfig,
  writeConfigText,
  type ConfigAdapterListing,
  type ConfigAdapterPort,
} from './config-adapter';

/**
 * In-memory DataAdapter double. `list` returns FULL vault-relative paths for the
 * immediate children of a directory, exactly like Obsidian's `DataAdapter.list`.
 */
class InMemoryAdapter implements ConfigAdapterPort {
  readonly files = new Map<string, string>();
  readonly binary = new Map<string, ArrayBuffer>();
  readonly dirs = new Set<string>();

  async list(dir: string): Promise<ConfigAdapterListing> {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    const known = new Set<string>([...this.files.keys(), ...this.binary.keys()]);
    if (!this.dirs.has(dir) && ![...known].some((p) => p.startsWith(prefix))) {
      throw new Error(`ENOENT: ${dir}`);
    }
    const files = new Set<string>();
    const folders = new Set<string>();
    for (const p of known) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) files.add(p);
      else folders.add(`${prefix}${rest.slice(0, slash)}`);
    }
    return { files: [...files], folders: [...folders] };
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return value;
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const value = this.binary.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return value;
  }

  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.binary.set(path, data);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.binary.has(path) || this.dirs.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.binary.delete(path);
  }
}

function seededAdapter(): InMemoryAdapter {
  const adapter = new InMemoryAdapter();
  adapter.files.set('.obsidian/appearance.json', '{"theme":"obsidian"}');
  adapter.files.set('.obsidian/app.json', '{}');
  adapter.files.set('.obsidian/hotkeys.json', '{}');
  adapter.files.set('.obsidian/graph.json', '{}');
  adapter.files.set('.obsidian/community-plugins.json', '["dataview"]');
  adapter.files.set('.obsidian/workspace.json', '{"main":{}}');
  adapter.files.set('.obsidian/snippets/tweaks.css', 'body{}');
  adapter.files.set('.obsidian/themes/Minimal/theme.css', '.x{}');
  adapter.files.set('.obsidian/themes/Minimal/manifest.json', '{"name":"Minimal"}');
  adapter.files.set('.obsidian/themes/Minimal/data.json', '{"licence":"x"}');
  adapter.files.set('.obsidian/plugins/dataview/main.js', 'module.exports={}');
  adapter.files.set('.obsidian/plugins/dataview/manifest.json', '{"id":"dataview"}');
  adapter.files.set('.obsidian/plugins/dataview/data.json', '{"secret":"x"}');
  adapter.files.set('.obsidian/plugins/havemind-sync/main.js', 'module.exports={}');
  adapter.files.set('.obsidian/plugins/havemind-sync/data.json', '{"pair":"secret"}');
  return adapter;
}

describe('listSyncableConfigPaths', () => {
  it('walks .obsidian recursively via adapter.list and keeps only allowlisted files', async () => {
    const paths = await listSyncableConfigPaths(seededAdapter());
    expect(paths).toEqual(
      [
        '.obsidian/app.json',
        '.obsidian/appearance.json',
        '.obsidian/graph.json',
        '.obsidian/hotkeys.json',
        '.obsidian/snippets/tweaks.css',
        '.obsidian/themes/Minimal/manifest.json',
        '.obsidian/themes/Minimal/theme.css',
      ].sort(),
    );
  });

  it('descends into foreign plugins yet mirrors NOTHING from them (audit #3 finding 2)', async () => {
    const paths = await listSyncableConfigPaths(seededAdapter());
    // Foreign plugin CODE must never mirror — it would let a peer overwrite an
    // installed plugin and get its code executed on the next reload.
    expect(paths).not.toContain('.obsidian/plugins/dataview/main.js');
    expect(paths).not.toContain('.obsidian/plugins/dataview/manifest.json');
    // Nor its secret store:
    expect(paths).not.toContain('.obsidian/plugins/dataview/data.json');
    // Machine-local and registry files never do either:
    expect(paths).not.toContain('.obsidian/workspace.json');
    expect(paths).not.toContain('.obsidian/community-plugins.json');
    // A `data.json` segment loses even inside an allowed subtree:
    expect(paths).not.toContain('.obsidian/themes/Minimal/data.json');
  });

  it('prunes our own havemind-sync plugin folder entirely', async () => {
    const paths = await listSyncableConfigPaths(seededAdapter());
    expect(paths.some((p) => p.startsWith('.obsidian/plugins/havemind-sync/'))).toBe(
      false,
    );
  });

  it('returns [] for a vault with no .obsidian directory rather than throwing', async () => {
    await expect(listSyncableConfigPaths(new InMemoryAdapter())).resolves.toEqual(
      [],
    );
  });
});

describe('config disk I/O helpers', () => {
  it('ensureConfigParentDirs creates every ancestor shallowest-first', async () => {
    const adapter = new InMemoryAdapter();
    await ensureConfigParentDirs(adapter, '.obsidian/themes/Minimal/theme.css');
    expect(adapter.dirs).toContain('.obsidian');
    expect(adapter.dirs).toContain('.obsidian/themes');
    expect(adapter.dirs).toContain('.obsidian/themes/Minimal');
    expect(adapter.dirs).not.toContain('.obsidian/themes/Minimal/theme.css');
  });

  it('writeConfigText materialises parents then writes', async () => {
    const adapter = new InMemoryAdapter();
    await writeConfigText(adapter, '.obsidian/themes/Minimal/theme.css', 'x');
    expect(adapter.files.get('.obsidian/themes/Minimal/theme.css')).toBe('x');
    expect(adapter.dirs).toContain('.obsidian/themes/Minimal');
  });

  it('removeConfig is idempotent for a missing file', async () => {
    const adapter = new InMemoryAdapter();
    await expect(
      removeConfig(adapter, '.obsidian/appearance.json'),
    ).resolves.toBeUndefined();
  });
});
