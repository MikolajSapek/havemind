import { describe, expect, it } from 'vitest';
import { hashBlob, hashPlaintext } from '@havemind/protocol';
import { VaultChangeObserver, type VaultSnapshotPort } from '../obsidian/vault-adapter';
import { OutboxLocalChangeRepository, type ProducerState } from '../sync/outbox-repository';
import { reconcileVaultState } from '../sync/reconciliation';
import { parseProducerStateResult } from './adapters/producer-state';

describe('metadata-only producer mappings', () => {
  it('loads legacy text and binary mappings without retaining their payloads or losing identity', () => {
    const mappings = ['markdown', 'binary'].map((contentKind) => ({
      fileId: contentKind, path: contentKind, collisionKey: contentKind,
      contentKind, contentHash: 'hash', content: 'large legacy payload',
    }));
    const parsed = parseProducerStateResult({ mappings, heads: { markdown: 'a', binary: 'b' } });
    expect(parsed.status).toBe('ok');
    expect(parsed.quarantinedMappings).toEqual([]);
    expect(parsed.state.mappings).toEqual(mappings.map((m) => ({
      fileId: m.fileId, path: m.path, collisionKey: m.collisionKey, contentKind: m.contentKind, contentHash: m.contentHash,
    })));
    expect(parseProducerStateResult(parsed.state)).toEqual(parsed);
  });

  it.each(['markdown', 'binary'] as const)('keeps %s payloads out of mappings and recognises unchanged files and offline renames', async (kind) => {
    let path = kind === 'binary' ? 'asset.png' : 'note.md';
    const originalPath = path;
    const content = 'a note\n';
    const bytes = new Uint8Array([0, 255, 13, 10]);
    const vault: VaultSnapshotPort = {
      listSyncablePaths: async () => [path], listAllPaths: async () => [path],
      exists: async (candidate) => candidate === path,
      readText: async () => content, readBinary: async () => bytes,
    };
    let stored: ProducerState = { mappings: [], heads: {} };
    let counter = 0;
    const repository = new OutboxLocalChangeRepository({
      identity: { vaultId: '00000000-0000-4000-8000-000000000001', memberId: '00000000-0000-4000-8000-000000000002', deviceId: '00000000-0000-4000-8000-000000000003' },
      store: { load: async () => stored, save: async (next) => { stored = structuredClone(next); } },
      enqueue: async () => {},
      generateRevisionId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
    });
    const observer = new VaultChangeObserver({ repository, vault, clock: () => 1,
      generateFileId: () => '00000000-0000-4000-8000-000000000004', generateOperationId: () => 'operation' });
    await observer.observeCreate(path);
    expect(stored.mappings[0]).not.toHaveProperty('content');
    expect(stored.mappings[0]?.contentHash).toBe(kind === 'binary' ? await hashBlob(bytes) : await hashPlaintext(content));
    expect(await reconcileVaultState({ repository, observer, vault })).toMatchObject({ unchanged: 1, skipped: 0, updated: 0 });
    path = `renamed-${originalPath}`;
    expect(await reconcileVaultState({ repository, observer, vault })).toMatchObject({ renamed: 1, created: 0, deleted: 0 });
    expect(stored.mappings[0]).toMatchObject({ fileId: '00000000-0000-4000-8000-000000000004', path });
    expect(stored.mappings[0]).not.toHaveProperty('content');
  });
});
