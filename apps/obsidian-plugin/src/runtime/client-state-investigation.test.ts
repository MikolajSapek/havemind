import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Plugin, Workspace } from 'obsidian';
import { hashPlaintext } from '@havemind/protocol';
import { OutboxLocalChangeRepository } from '../sync/outbox-repository';
import { buildSyncController } from './adapters/sync-controller';
import { startPushProducer } from './adapters/push-producer';
import { createPersistPort } from './adapters/plugin-data-ports';
import { createVaultFilePort } from './adapters/vault-file-port';
import { DurableSyncState } from './sync-state';
import { ApplyDeferredError } from './apply-deferred';

const request = vi.hoisted(() => vi.fn());
vi.mock('obsidian', async (importOriginal) => ({ ...await importOriginal<object>(), requestUrl: request }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); request.mockReset(); });

describe('client state investigation', () => {
  it('issues exactly three empty event requests per cycle through the production controller wiring', async () => {
    vi.stubGlobal('window', globalThis);
    const calls: string[] = [];
    request.mockImplementation(async ({ url }: { url: string }) => {
      calls.push(url);
      return { status: 200, text: '', json: { cursor: 0, events: [] } };
    });
    let data: unknown = {};
    const plugin = { app: { workspace: {}, vault: {} },
      loadData: async () => data, saveData: async (next: unknown) => { data = structuredClone(next); },
    } as unknown as Plugin;
    const producer = new OutboxLocalChangeRepository({ identity: { vaultId: 'vault', memberId: 'member', deviceId: 'device' },
      store: { load: async () => ({ mappings: [], heads: {} }), save: async () => {} },
      enqueue: async () => {}, generateRevisionId: () => 'unused' });
    const { controller } = buildSyncController(plugin, {
      apiBaseUrl: 'https://example.invalid', vaultId: 'vault', getAuthToken: async () => 'test-token',
      resolveRevision: async () => { throw new Error('An empty cycle must not resolve payloads.'); },
    }, () => {}, undefined, undefined, undefined, () => producer);
    try {
      // No scheduler, wake subscription, pagination or overlapping trigger.
      await controller.syncNow();
      expect(calls).toEqual(Array(3).fill('https://example.invalid/vaults/vault/events?after=0'));
      calls.length = 0;
      await controller.syncNow();
      expect(calls).toHaveLength(3);
    } finally { controller.stop(); }
  });

  it('compacts legacy data on an unchanged vault without enqueuing or losing the head', async () => {
    vi.useFakeTimers(); vi.stubGlobal('window', globalThis);
    const content = 'unchanged\n';
    const mapping = { fileId: 'file', path: 'note.md', collisionKey: 'note.md', contentHash: await hashPlaintext(content), content };
    let data: Record<string, unknown> = { pushProducer: { mappings: [mapping], heads: { file: 'head' } }, unrelated: 'preserve' };
    const vault = { getFiles: () => [{ path: 'note.md' }], getAbstractFileByPath: () => ({ path: 'note.md' }),
      read: async () => content, on: () => ({}), offref: () => {},
      adapter: { exists: async () => false, list: async () => ({ files: [], folders: [] }) } };
    const plugin = { app: { vault }, registerInterval: () => {},
      loadData: async () => structuredClone(data), saveData: async (next: Record<string, unknown>) => { data = structuredClone(next); },
    } as unknown as Plugin;
    const state = new DurableSyncState({ persist: createPersistPort(plugin) });
    const ref = { current: null as OutboxLocalChangeRepository | null };
    const handle = startPushProducer(plugin, state, { vaultId: 'vault', memberId: 'member', deviceId: 'device' }, () => {}, ref);
    try {
      await handle.initialize();
      expect(data.pushProducer).toEqual({ mappings: [{ fileId: 'file', path: 'note.md', collisionKey: 'note.md', contentHash: mapping.contentHash }], heads: { file: 'head' } });
      expect(data.unrelated).toBe('preserve');
      expect(await state.listOutbox()).toEqual([]);
    } finally { handle.dispose(); }
  });

  it('rechecks a leaf that materialises with unsaved text after the first buffer check', async () => {
    let disk = 'base\n';
    const deferred = { getViewType: () => 'markdown' };
    const editor = { getViewType: () => 'markdown', file: { path: 'note.md' },
      getMode: () => 'source', editor: { getValue: () => 'unsaved local edit\n' } };
    const leaf = { view: deferred as typeof deferred | typeof editor };
    const workspace = { iterateAllLeaves: (visit: (leaf: unknown) => void) => visit(leaf) } as Pick<Workspace, 'iterateAllLeaves'>;
    const vault = { getAbstractFileByPath: () => ({ path: 'note.md' }), read: async () => disk,
      process: async (_file: unknown, transform: (text: string) => string) => {
        leaf.view = editor;
        disk = transform(disk);
        return disk;
      } };
    const files = createVaultFilePort({ vault: vault as never, workspace,
      state: { pathForFileId: () => 'note.md' } as never });
    expect(await files.openBufferStates('file')).toEqual([]);
    await expect(files.writeByPath('note.md', 'remote\n', 'base\n')).rejects.toBeInstanceOf(ApplyDeferredError);
    expect(disk).toBe('base\n');
    expect(await files.openBufferStates('file')).toMatchObject([{ unsaved: true }]);
  });
});
