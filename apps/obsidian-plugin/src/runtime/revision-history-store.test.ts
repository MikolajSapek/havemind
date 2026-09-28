import { describe, expect, it } from 'vitest';

import { IndexedDbClientStore } from '../storage/client-store';
import { FakeIndexedDbFactory } from '../test/indexeddb.mock';
import type { RemoteEvent } from '../sync/sync-runner';
import { createRevisionHistoryStore, MAX_HISTORY_SEGMENTS } from './revision-history-store';

const CLIENT_ID = '8f09ae38-f78e-4cfe-9174-69f064295e02';
const API = 'https://sync.example.test';

function event(sequence: number): RemoteEvent {
  return {
    serverSequence: sequence,
    revision: { revisionId: `rev-${sequence}`, fileId: 'file', contentHash: `hash-${sequence}`, parentRevisionIds: sequence > 1 ? [`rev-${sequence - 1}`] : [] },
  };
}
function log(length: number): RemoteEvent[] {
  return Array.from({ length }, (_, index) => event(index + 1));
}

async function openRecords(indexedDb: FakeIndexedDbFactory): Promise<IndexedDbClientStore> {
  const store = new IndexedDbClientStore({ clientInstanceId: CLIENT_ID, indexedDB: indexedDb.asFactory() });
  await store.open();
  return store;
}

describe('IndexedDB revision history store (P13)', () => {
  it('round-trips the accepted log per vault across reopen', async () => {
    const indexedDb = new FakeIndexedDbFactory();
    const records = await openRecords(indexedDb);
    const store = createRevisionHistoryStore(async () => records, { apiBaseUrl: API, vaultId: 'vault-a' });
    await store.save({ epoch: 'e1', cursor: 2, events: log(2) }, 0);
    records.close();

    const reopened = await openRecords(indexedDb);
    const again = createRevisionHistoryStore(async () => reopened, { apiBaseUrl: API, vaultId: 'vault-a' });
    await expect(again.load()).resolves.toEqual({ epoch: 'e1', cursor: 2, events: log(2) });
    // Another vault, or the same vault id on another server, never sees it.
    await expect(createRevisionHistoryStore(async () => reopened, { apiBaseUrl: API, vaultId: 'vault-b' }).load()).resolves.toBeNull();
    await expect(createRevisionHistoryStore(async () => reopened, { apiBaseUrl: 'https://other.test', vaultId: 'vault-a' }).load()).resolves.toBeNull();
  });

  it('appends only the new tail and rewrites the log whole past the segment bound', async () => {
    const records = await openRecords(new FakeIndexedDbFactory());
    const written: unknown[] = [];
    const put = records.putHistoryRecord.bind(records);
    records.putHistoryRecord = async (key, value) => { written.push(value); await put(key, value); };
    const store = createRevisionHistoryStore(async () => records, { apiBaseUrl: API, vaultId: 'vault-a' });

    await store.save({ epoch: null, cursor: 1, events: log(1) }, 0);
    written.length = 0;
    await store.save({ epoch: null, cursor: 3, events: log(3) }, 1);
    expect(written).toContainEqual(expect.objectContaining({ from: 1, events: [event(2), event(3)] }));
    expect(written).not.toContainEqual(expect.objectContaining({ from: 0 }));

    for (let cursor = 4; cursor <= MAX_HISTORY_SEGMENTS + 4; cursor += 1) {
      await store.save({ epoch: null, cursor, events: log(cursor) }, cursor - 1);
    }
    const final = MAX_HISTORY_SEGMENTS + 4;
    await expect(store.load()).resolves.toEqual({ epoch: null, cursor: final, events: log(final) });
    expect(written).toContainEqual(expect.objectContaining({ from: 0 }));
  });

  it('rewrites the log whole when what it holds is not what the caller appends to', async () => {
    const records = await openRecords(new FakeIndexedDbFactory());
    const store = createRevisionHistoryStore(async () => records, { apiBaseUrl: API, vaultId: 'vault-a' });
    await store.save({ epoch: 'e1', cursor: 2, events: log(2) }, 0);
    // A different epoch, or a persisted cursor the store does not hold.
    await store.save({ epoch: 'e2', cursor: 3, events: log(3) }, 2);
    await expect(store.load()).resolves.toEqual({ epoch: 'e2', cursor: 3, events: log(3) });
    await store.save({ epoch: 'e2', cursor: 5, events: log(5) }, 4);
    await expect(store.load()).resolves.toEqual({ epoch: 'e2', cursor: 5, events: log(5) });
  });

  it('reads a torn or corrupt log as absent', async () => {
    const records = await openRecords(new FakeIndexedDbFactory());
    const store = createRevisionHistoryStore(async () => records, { apiBaseUrl: API, vaultId: 'vault-a' });
    await store.save({ epoch: null, cursor: 1, events: log(1) }, 0);
    await store.save({ epoch: null, cursor: 2, events: log(2) }, 1);
    await records.deleteHistoryRecord('revision-history|vault-a|1');
    await expect(store.load()).resolves.toBeNull();

    await records.putHistoryRecord('revision-history|vault-a', 'garbage');
    await expect(store.load()).resolves.toBeNull();
  });

  it('degrades to no history when IndexedDB is unavailable', async () => {
    const store = createRevisionHistoryStore(async () => null, { apiBaseUrl: API, vaultId: 'vault-a' });
    await expect(store.load()).resolves.toBeNull();
    await expect(store.save({ epoch: null, cursor: 1, events: log(1) }, 0)).resolves.toBeUndefined();
  });
});
