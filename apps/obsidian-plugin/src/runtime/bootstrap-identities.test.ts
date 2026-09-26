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

// A connected device restarts with every local file already mapped. Downloading
// each head's full payload to rediscover paths it already knows made a phone
// fetch the whole vault on every start and never reach the pull.
const MAPPED_ID = '00000000-0000-4000-8000-000000000010';
const REMOTE_ONLY_ID = '00000000-0000-4000-8000-000000000011';
const UNTRACKED_ID = '00000000-0000-4000-8000-000000000012';

function establishedDevice(localPaths: readonly string[]) {
  const fetched: string[] = [];
  const producerRaw: ProducerState = {
    mappings: [{ fileId: MAPPED_ID, path: 'known.md', collisionKey: 'known.md', contentHash: 'h' }],
    heads: { [MAPPED_ID]: 'rev-known' },
  };
  const state = new DurableSyncState({ persist: { load: async () => null, loadBackup: async () => null,
    preserveCorrupt: async () => undefined, save: async () => undefined } });
  const producer = new OutboxLocalChangeRepository({
    identity: { vaultId: 'vault', memberId: 'member', deviceId: 'device' },
    store: { load: async () => producerRaw, save: async () => undefined },
    recovery: state, enqueue: (envelope) => state.enqueue(envelope), generateRevisionId: () => 'unused',
  });
  const paths: Record<string, string> = { [MAPPED_ID]: 'known.md', [REMOTE_ONLY_ID]: 'new-on-pc.md', [UNTRACKED_ID]: 'local-only.md' };
  const events = [MAPPED_ID, REMOTE_ONLY_ID, UNTRACKED_ID].map((fileId, index) => ({
    serverSequence: index + 1,
    revision: { fileId, revisionId: `rev-${index}`, contentHash: `hash-${index}`, parentRevisionIds: [] },
  }));
  const history = new RevisionHistory({ state,
    transport: { pull: async (after) => ({ cursor: 3, events: after === 0 ? events : [] }) },
    resolveRevision: async (event) => {
      fetched.push(event.revision.fileId);
      return { operation: 'create', kind: 'markdown', path: paths[event.revision.fileId] as string, previousPath: null, content: 'x\n' };
    },
  });
  const vault = { exists: async (path: string) => localPaths.includes(path),
    readText: async () => 'other\n', readBinary: async () => new Uint8Array(),
    listSyncablePaths: async () => localPaths, listAllPaths: async () => localPaths };
  return { fetched, options: { state, producer, history, vault } };
}

it('downloads nothing when every local file is already mapped', async () => {
  const { fetched, options } = establishedDevice(['known.md']);
  expect(await bootstrapIdentities(options)).toEqual(new Set());
  expect(fetched).toEqual([]);
});

it('never downloads a head whose file this device already maps', async () => {
  const { fetched, options } = establishedDevice(['known.md', 'local-only.md']);
  await bootstrapIdentities(options);
  expect(fetched).not.toContain(MAPPED_ID);
});
