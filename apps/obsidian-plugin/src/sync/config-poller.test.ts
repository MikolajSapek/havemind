import { describe, expect, it } from 'vitest';

import { canonicalizeMarkdown } from '@havemind/protocol';
import { decodeRevisionPayload } from '@havemind/sync-core';

import {
  VaultChangeObserver,
  type LocalFileMapping,
} from '../obsidian/vault-adapter';
import type { OutboxEnvelope } from '../runtime/sync-state';
import {
  OutboxLocalChangeRepository,
  type ProducerState,
} from './outbox-repository';
import {
  listSyncableConfigPaths,
  type ConfigAdapterListing,
  type ConfigAdapterPort,
} from './config-adapter';
import { createConfigVaultSnapshot, pollConfigOnce } from './config-poller';

const IDENTITY = {
  vaultId: '11111111-1111-4111-8111-111111111111',
  memberId: '33333333-3333-4333-8333-333333333333',
  deviceId: '44444444-4444-4444-8444-444444444444',
} as const;

async function realSha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** In-memory DataAdapter double (full paths from `list`, like Obsidian). */
class InMemoryAdapter implements ConfigAdapterPort {
  readonly files = new Map<string, string>();
  async list(dir: string): Promise<ConfigAdapterListing> {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    if (![...this.files.keys()].some((p) => p.startsWith(prefix))) {
      throw new Error(`ENOENT: ${dir}`);
    }
    const files = new Set<string>();
    const folders = new Set<string>();
    for (const p of this.files.keys()) {
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
  async readBinary(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }
  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }
  async writeBinary(): Promise<void> {}
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async mkdir(): Promise<void> {}
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
}

/**
 * A vault whose `getFiles()` returns ONLY non-`.obsidian` files — exactly what
 * real Obsidian does — while its `adapter` exposes the hidden config tree. If the
 * poller ever regressed to enumerating config via `getFiles()`, config would be
 * invisible and these assertions would fail.
 */
class HiddenConfigVault {
  readonly adapter = new InMemoryAdapter();
  getFiles(): { path: string }[] {
    return [{ path: 'Notes/a.md' }];
  }
}

class MemoryStore {
  state: ProducerState = { mappings: [], heads: {} };
  async load(): Promise<ProducerState> {
    return this.state;
  }
  async save(state: ProducerState): Promise<void> {
    this.state = state;
  }
}

function makeHarness(adapter: ConfigAdapterPort) {
  const enqueued: OutboxEnvelope[] = [];
  let rev = 0;
  let file = 0;
  let op = 0;
  const repository = new OutboxLocalChangeRepository({
    identity: IDENTITY,
    store: new MemoryStore(),
    enqueue: async (envelope) => {
      enqueued.push(envelope);
    },
    generateRevisionId: () => `00000000-0000-4000-8000-${String(++rev).padStart(12, '0')}`,
    onLocalMaterialized: async () => undefined,
    onLocalForgotten: async () => undefined,
  });
  const observer = new VaultChangeObserver({
    clock: () => 1,
    generateFileId: () => `ffffffff-0000-4000-8000-${String(++file).padStart(12, '0')}`,
    generateOperationId: () => `op-${++op}`,
    repository,
    vault: createConfigVaultSnapshot(adapter),
  });
  const poll = () =>
    pollConfigOnce({
      observer,
      listConfigPaths: () => listSyncableConfigPaths(adapter),
      listMappings: () => repository.listMappings(),
    });
  return { repository, observer, enqueued, poll };
}

function enqueuedPaths(enqueued: readonly OutboxEnvelope[]): string[] {
  return enqueued
    .map((e) => decodeRevisionPayload(Buffer.from(e.payloadBase64, 'base64').toString('utf8')).path)
    .sort();
}

describe('config poller — enumeration via adapter, not getFiles (regression #5)', () => {
  it('enqueues syncable config from adapter.list while getFiles has no config', async () => {
    const vault = new HiddenConfigVault();
    vault.adapter.files.set('.obsidian/graph.json', '{}');
    vault.adapter.files.set('.obsidian/plugins/dataview/main.js', 'x');
    vault.adapter.files.set('.obsidian/plugins/dataview/data.json', '{"s":1}');
    vault.adapter.files.set('.obsidian/plugins/havemind-sync/data.json', '{"p":1}');

    const { enqueued, poll } = makeHarness(vault.adapter);
    await poll();

    const paths = enqueuedPaths(enqueued);
    expect(paths).toContain('.obsidian/graph.json');
    expect(paths).toContain('.obsidian/plugins/dataview/main.js');
    expect(paths).not.toContain('.obsidian/plugins/dataview/data.json');
    expect(paths).not.toContain('.obsidian/plugins/havemind-sync/data.json');
    // The single getFiles() entry is a `.md` note the poller must ignore entirely.
    expect(paths).not.toContain('Notes/a.md');
    expect(paths).toHaveLength(2);
  });
});

describe('config poller — cycle guard after a remote apply (test #6)', () => {
  it('does not re-enqueue a config file that a remote apply just wrote', async () => {
    const path = '.obsidian/appearance.json';
    const raw = '{"accentColor":"#7c3aed"}';
    const canonical = canonicalizeMarkdown(raw);

    const adapter = new InMemoryAdapter();
    const { repository, enqueued, poll } = makeHarness(adapter);

    // Simulate the two effects of a remote apply of a config revision:
    //  1. the file is written to disk (via the DataAdapter), and
    //  2. the producer mapping ADOPTS the applied hash (no enqueue) — exactly what
    //     `remote-apply-coordinator` does through `adoptRemoteMapping`.
    adapter.files.set(path, canonical);
    const mapping: LocalFileMapping = {
      collisionKey: path.toLowerCase(),
      content: canonical,
      contentHash: await realSha256(canonical),
      contentKind: 'markdown',
      fileId: 'aaaaaaaa-0000-4000-8000-000000000001',
      path,
    };
    await repository.adoptRemoteMapping(mapping, '00000000-0000-4000-8000-000000000099');

    const ops = await poll();

    expect(ops).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  it('still enqueues a genuine local edit to that config file (positive control)', async () => {
    const path = '.obsidian/appearance.json';
    const canonical = canonicalizeMarkdown('{"accentColor":"#000000"}');
    const adapter = new InMemoryAdapter();
    const { repository, enqueued, poll } = makeHarness(adapter);
    adapter.files.set(path, canonical);
    await repository.adoptRemoteMapping(
      {
        collisionKey: path.toLowerCase(),
        content: canonical,
        contentHash: await realSha256(canonical),
        contentKind: 'markdown',
        fileId: 'aaaaaaaa-0000-4000-8000-000000000001',
        path,
      },
      '00000000-0000-4000-8000-000000000099',
    );

    // A later on-disk edit (the user changes the accent locally) must sync.
    adapter.files.set(path, canonicalizeMarkdown('{"accentColor":"#ffffff"}'));
    const ops = await poll();

    expect(ops).toHaveLength(1);
    expect(ops[0]?.kind).toBe('update');
    expect(enqueued).toHaveLength(1);
  });
});

describe('config poller — create/update/delete lifecycle', () => {
  it('creates, then no-ops, then tombstones a config file across ticks', async () => {
    const path = '.obsidian/snippets/x.css';
    const adapter = new InMemoryAdapter();
    const { enqueued, poll } = makeHarness(adapter);

    adapter.files.set(path, 'body{color:red}');
    const created = await poll();
    expect(created).toHaveLength(1);
    expect(created[0]?.kind).toBe('create');

    // Unchanged tick → no new revision.
    const steady = await poll();
    expect(steady).toHaveLength(0);

    // File removed from disk → tombstone via the mapping diff.
    adapter.files.delete(path);
    const deleted = await poll();
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.kind).toBe('delete');
    expect(enqueued).toHaveLength(2);
  });
});
