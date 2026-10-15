import { expect, it, vi } from 'vitest';
import { hashBlob, hashPlaintext } from '@havemind/protocol';
import { bootstrapIdentities, formatBlockedNotice, pathsNeedingResolution, pathsToScan } from './bootstrap-identities';
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
      recovery: state, generateRevisionId: () => 'unused',
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

it('adopts a matching attachment without base64-encoding it', async () => {
  // Adopting an attachment needs its hash, not a base64 copy: for a 25 MB file
  // that copy is 33 MB of string built and dropped.
  const fileId = '00000000-0000-4000-8000-000000000020';
  const bytes = new Uint8Array([0, 255, 13, 10, 7]);
  let producerRaw: ProducerState = { mappings: [], heads: {} };
  const state = new DurableSyncState({ persist: { load: async () => null, loadBackup: async () => null,
    preserveCorrupt: async () => undefined, save: async () => undefined } });
  const producer = new OutboxLocalChangeRepository({
    identity: { vaultId: 'vault', memberId: 'member', deviceId: 'device' },
    store: { load: async () => producerRaw, save: async (next) => { producerRaw = structuredClone(next); } },
    recovery: state, generateRevisionId: () => 'unused',
  });
  const history = new RevisionHistory({ state,
    transport: { pull: async (after) => ({ cursor: 1, events: after === 0 ? [
      { serverSequence: 1, revision: { fileId, revisionId: 'rev-pic', contentHash: 'envelope-hash', parentRevisionIds: [] } },
    ] : [] }) },
    resolveRevision: async () => ({ operation: 'create', kind: 'binary', path: 'pic.png', previousPath: null, content: null, binaryContent: bytes }),
  });
  const vault = { exists: async () => true, readText: async () => '', readBinary: async () => bytes,
    listSyncablePaths: async () => ['pic.png'], listAllPaths: async () => ['pic.png'] };
  const btoaSpy = vi.spyOn(globalThis, 'btoa');

  await bootstrapIdentities({ state, producer, history, vault });

  const encoded = btoaSpy.mock.calls.length;
  btoaSpy.mockRestore();
  expect(producerRaw.mappings).toMatchObject([{ fileId, path: 'pic.png', contentKind: 'binary', contentHash: await hashBlob(bytes) }]);
  expect(encoded).toBe(0);
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
    recovery: state, generateRevisionId: () => 'unused',
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

// A brand-new vault creates default config files (core-plugins.json and
// friends) before the first pull. They differ from the owner's, were held as
// "existing files that need conflict resolution", and the phone said so right
// after joining. Config is last writer wins: nothing for the user to resolve.
const CONFIG_ID = '00000000-0000-4000-8000-000000000030';
const NOTE_ID = '00000000-0000-4000-8000-000000000031';

async function freshVaultWith(local: Record<string, string>, remote: Record<string, string>) {
  let producerRaw: ProducerState = { mappings: [], heads: {} };
  const state = new DurableSyncState({ persist: { load: async () => null, loadBackup: async () => null,
    preserveCorrupt: async () => undefined, save: async () => undefined } });
  const producer = new OutboxLocalChangeRepository({
    identity: { vaultId: 'vault', memberId: 'member', deviceId: 'device' },
    store: { load: async () => producerRaw, save: async (next) => { producerRaw = structuredClone(next); } },
    recovery: state, generateRevisionId: () => 'unused',
  });
  const ids = [CONFIG_ID, NOTE_ID];
  const remotePaths = Object.keys(remote);
  const history = new RevisionHistory({ state,
    transport: { pull: async (after) => ({ cursor: remotePaths.length, events: after === 0 ? remotePaths.map((_, index) => ({
      serverSequence: index + 1,
      revision: { fileId: ids[index] as string, revisionId: `rev-${index}`, contentHash: `h-${index}`, parentRevisionIds: [] },
    })) : [] }) },
    resolveRevision: async (event) => {
      const path = remotePaths[ids.indexOf(event.revision.fileId)] as string;
      return { operation: 'create', kind: 'markdown', path, previousPath: null, content: remote[path] as string };
    },
  });
  const paths = Object.keys(local);
  const vault = { exists: async (path: string) => path in local, readText: async (path: string) => local[path] ?? '',
    readBinary: async () => new Uint8Array(), listSyncablePaths: async () => paths, listAllPaths: async () => paths };
  const blocked = await bootstrapIdentities({ state, producer, history, vault });
  return { blocked, paths, mappings: () => producerRaw.mappings };
}

it('does not ask the user to resolve a default config file the vault already has', async () => {
  const { blocked, paths, mappings } = await freshVaultWith(
    { '.obsidian/core-plugins.json': '["file-explorer"]\n' },
    { '.obsidian/core-plugins.json': '["file-explorer","graph","canvas"]\n' },
  );
  expect(pathsNeedingResolution(paths, blocked)).toEqual([]);
  // ...but it is still not uploaded: the pull replaces it with the vault's.
  expect(mappings()).toEqual([]);
  expect(blocked.has('.obsidian/core-plugins.json')).toBe(true);
});

it('still asks about a real note that differs, next to a config file', async () => {
  const { blocked, paths } = await freshVaultWith(
    { '.obsidian/core-plugins.json': '["a"]\n', 'Notes/Plan.md': 'my text\n' },
    { '.obsidian/core-plugins.json': '["b"]\n', 'Notes/Plan.md': 'their text\n' },
  );
  expect(pathsNeedingResolution(paths, blocked)).toEqual(['Notes/Plan.md']);
});

it('adopts a config file that matches once its machine-local fields are filtered', async () => {
  const { blocked, mappings } = await freshVaultWith(
    { '.obsidian/graph.json': '{"colorGroups":[],"scale":1.7}\n' },
    { '.obsidian/graph.json': '{\n  "colorGroups": []\n}\n' },
  );
  expect(blocked.size).toBe(0);
  expect(mappings()).toMatchObject([{ path: '.obsidian/graph.json' }]);
});

it('names at most three held files in the Notice, then counts the rest', () => {
  expect(formatBlockedNotice(['a.md'])).toBe('Havemind: 1 existing file(s) need conflict resolution before upload: a.md.');
  expect(formatBlockedNotice(['a.md', 'b.md', 'c.md', 'd.md', 'e.md'])).toBe(
    'Havemind: 5 existing file(s) need conflict resolution before upload: a.md, b.md, c.md and 2 more.',
  );
});

it('scans a held path again once the pull gave it a mapping, so a later confirmed pass never reads it as deleted', () => {
  const blocked = new Set(['.obsidian/core-plugins.json', 'notes/plan.md']);
  const paths = ['.obsidian/core-plugins.json', 'Notes/Plan.md', 'Notes/Other.md'];

  expect(pathsToScan(paths, blocked, new Set())).toEqual(['Notes/Other.md']);
  expect(pathsToScan(paths, blocked, new Set(['.obsidian/core-plugins.json']))).toEqual(['.obsidian/core-plugins.json', 'Notes/Other.md']);
});
