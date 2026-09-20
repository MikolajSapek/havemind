import { expect, it } from 'vitest';
import { hashPlaintext } from '@havemind/protocol';
import { bootstrapIdentities } from './bootstrap-identities';
import { RevisionHistory } from './revision-history';
import { DurableSyncState, type PersistedSyncState, type SyncStatePersistPort } from './sync-state';
import { OutboxLocalChangeRepository, type ProducerState } from '../sync/outbox-repository';

it('completes identity adoption after an interrupted shared-base write', async () => {
  let raw: unknown = null;
  let producerRaw: ProducerState = { mappings: [], heads: {} };
  let failBaseContent = true;
  const fileId = '00000000-0000-4000-8000-000000000004';
  const revisionId = '00000000-0000-4000-8000-000000000005';
  const content = 'existing text\n';
  const persist: SyncStatePersistPort = { load: async () => raw, loadBackup: async () => null,
    preserveCorrupt: async () => undefined, save: async (next) => {
      if (failBaseContent && next.baseContents[fileId] !== undefined) throw new Error('interrupted base save');
      raw = structuredClone(next);
    },
  };
  const connect = () => {
    const state = new DurableSyncState({ persist });
    const producer = new OutboxLocalChangeRepository({
      identity: { vaultId: 'vault', memberId: 'member', deviceId: 'device' },
      store: { load: async () => producerRaw, save: async (next) => { producerRaw = structuredClone(next); } },
      recovery: state, enqueue: (envelope) => state.enqueue(envelope), generateRevisionId: () => 'unused',
    });
    const history = new RevisionHistory({ state,
      transport: { pull: async (after) => ({ cursor: 1, events: after === 0 ? [
        { serverSequence: 1, revision: { fileId, revisionId, contentHash: 'envelope-hash', parentRevisionIds: [] } },
      ] : [] }) },
      resolveRevision: async () => ({ operation: 'create', kind: 'markdown', path: 'existing.md', previousPath: null, content }),
    });
    return { state, producer, history, vault: { exists: async () => true,
      readText: async () => content, readBinary: async () => new Uint8Array(),
      listSyncablePaths: async () => ['existing.md'], listAllPaths: async () => ['existing.md'] } };
  };
  await expect(bootstrapIdentities(connect())).rejects.toThrow('interrupted base save');
  failBaseContent = false;
  const reopened = connect();
  expect(await bootstrapIdentities(reopened)).toEqual(new Set());
  expect(producerRaw.heads[fileId]).toBe(revisionId);
  expect((raw as PersistedSyncState).pathOwners['existing.md']).toBe(fileId);
  expect((raw as PersistedSyncState).baseHashes[fileId]).toBe(await hashPlaintext(content));
  expect((raw as PersistedSyncState).baseContents[fileId]).toBe(content);
  expect(await reopened.state.listOutbox()).toEqual([]);
});
