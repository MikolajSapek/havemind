import { describe, expect, it } from 'vitest';
import { DurableSyncState, type SyncStatePersistPort } from '../runtime/sync-state';
import { OutboxLocalChangeRepository, type ProducerState } from '../sync/outbox-repository';
import { VaultChangeObserver } from './vault-adapter';
import { SyncRunner, type SyncTransport } from '../sync/sync-runner';

/**
 * Retry on a quarantined send whose stashed envelope was evicted re-commits the
 * file from disk. The mapping hash already matches the disk, so an ordinary
 * modify is a no-op: the row was discarded and the change never sent.
 */
describe('retrying a quarantined send whose stash was evicted', () => {
  it('re-commits the unchanged file when the retry forces it', async () => {
    let raw: unknown = null; let producerState: ProducerState = { mappings: [], heads: {} }; let n = 0;
    const persist: SyncStatePersistPort = { load: async () => raw, loadBackup: async () => null,
      preserveCorrupt: async () => {}, save: async (v) => { raw = structuredClone(v); } };
    // Small budget stands in for the 5 MiB default vs. an attachment > 5 MiB.
    const state = new DurableSyncState({ persist, quarantinedEnvelopeBudgetBytes: 8 });
    const producer = new OutboxLocalChangeRepository({
      identity: { vaultId: '00000000-0000-4000-8000-000000000001', memberId: '00000000-0000-4000-8000-000000000002', deviceId: '00000000-0000-4000-8000-000000000003' },
      recovery: state, store: { load: async () => producerState, save: async (v) => { producerState = structuredClone(v); } },
      hasAuthoredRevision: (id) => state.hasAuthoredRevision(id),
      generateRevisionId: () => `00000000-0000-4000-8000-${String(++n + 100).padStart(12, '0')}`,
    });
    const disk = new Map([['a.md', 'hello world, this is a note']]);
    const observer = new VaultChangeObserver({ clock: () => 1, generateFileId: () => '00000000-0000-4000-8000-000000000009',
      generateOperationId: () => `op-${++n}`, repository: producer,
      vault: { listSyncablePaths: async () => [...disk.keys()], readText: async (p) => disk.get(p) ?? '',
        readBinary: async () => new Uint8Array(), exists: async (p) => disk.has(p), listAllPaths: async () => [...disk.keys()] } });
    await observer.observeCreate('a.md');
    const transport: SyncTransport = {
      push: async () => { throw Object.assign(new Error('HTTP 413'), { permanent: true }); },
      pull: async () => ({ cursor: 0, events: [] }),
    };
    const runner = new SyncRunner({ transport, state, scheduler: () => undefined,
      vault: { openBuffers: async () => [], applyRemote: async () => 'applied' } });
    await runner.trigger();
    const [row] = state.quarantineSnapshot();
    if (row === undefined) throw new Error('expected a quarantined send');
    const requeued = await state.requeueQuarantined(row.revisionId);
    expect(requeued).toBe(false);

    expect(await observer.observeModify('a.md')).toBeNull();
    const forced = await observer.observeModify('a.md', { force: true });

    expect(forced).not.toBeNull();
    expect(await state.listOutbox()).toHaveLength(1);
  });
});
