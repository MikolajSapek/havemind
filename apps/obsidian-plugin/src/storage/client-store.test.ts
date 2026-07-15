import { describe, expect, it, vi } from 'vitest';

import {
  CLIENT_STORE_NAMES,
  ClientStoreError,
  IndexedDbClientStore,
  ensureClientInstanceId,
  type ClientInstanceIdRepository,
} from './client-store';
import { FakeIndexedDbFactory } from '../test/indexeddb.mock';

const CLIENT_ID = '8f09ae38-f78e-4cfe-9174-69f064295e02';

class MemoryIdentityRepository implements ClientInstanceIdRepository {
  value: string | null = null;
  writes = 0;

  async readClientInstanceId(): Promise<string | null> {
    return this.value;
  }

  async writeClientInstanceId(value: string): Promise<void> {
    this.writes += 1;
    this.value = value;
  }
}

describe('storage client identity', () => {
  it('persists one stable client_instance_id and reuses it after restart', async () => {
    const repository = new MemoryIdentityRepository();
    const generateId = vi.fn(() => CLIENT_ID);

    await expect(
      ensureClientInstanceId(repository, generateId),
    ).resolves.toBe(CLIENT_ID);
    await expect(
      ensureClientInstanceId(repository, generateId),
    ).resolves.toBe(CLIENT_ID);

    expect(repository.writes).toBe(1);
    expect(generateId).toHaveBeenCalledOnce();
  });

  it('fails closed when persisted identity is malformed', async () => {
    const repository = new MemoryIdentityRepository();
    repository.value = '../another-vault';

    await expect(ensureClientInstanceId(repository)).rejects.toMatchObject({
      code: 'invalid-client-instance-id',
    });
    expect(repository.writes).toBe(0);
  });

  it('uses secure UUID generation when creating the identity by default', async () => {
    const repository = new MemoryIdentityRepository();

    const clientInstanceId = await ensureClientInstanceId(repository);

    expect(clientInstanceId).toMatch(/^[a-f0-9-]{36}$/);
    expect(repository.value).toBe(clientInstanceId);
  });
});

describe('IndexedDbClientStore storage', () => {
  it('creates all durable stores in a database namespaced by client_instance_id', async () => {
    const indexedDb = new FakeIndexedDbFactory();
    const first = createStore(indexedDb, CLIENT_ID);
    const second = createStore(
      indexedDb,
      '553b168a-a0f8-44cc-8ce7-235529612eb3',
    );

    await first.open();
    await second.open();

    expect(first.databaseName).toBe(`havemind-client-${CLIENT_ID}`);
    expect(second.databaseName).not.toBe(first.databaseName);
    expect([...indexedDb.getStoreNames(first.databaseName)].sort()).toEqual(
      [...CLIENT_STORE_NAMES].sort(),
    );
  });

  it('persists non-secret connection data and outbox entries across reopen', async () => {
    const indexedDb = new FakeIndexedDbFactory();
    const first = createStore(indexedDb);
    await first.open();

    await first.setConnectionValue('server-origin', 'https://sync.example.test');
    await first.enqueueOutbox({
      createdAt: 1_721_000_000_000,
      operationId: 'revision-01',
      payload: { path: 'shared/note.md' },
    });
    first.close();

    const reopened = createStore(indexedDb);
    await reopened.open();

    await expect(reopened.getConnectionValue('server-origin')).resolves.toBe(
      'https://sync.example.test',
    );
    await expect(reopened.listOutbox()).resolves.toEqual([
      {
        createdAt: 1_721_000_000_000,
        operationId: 'revision-01',
        payload: { path: 'shared/note.md' },
      },
    ]);
  });

  it('reports a blocked upgrade, closes late success, and permits an explicit retry', async () => {
    const indexedDb = new FakeIndexedDbFactory();
    indexedDb.blockNextOpen();
    const store = createStore(indexedDb);

    await expect(store.open()).rejects.toEqual(
      expect.objectContaining({ code: 'blocked-upgrade' }),
    );
    expect(store.state).toBe('blocked');

    indexedDb.releaseBlockedOpen();
    expect(indexedDb.getOpenConnectionCount()).toBe(0);

    await expect(store.open()).resolves.toBeUndefined();
    expect(store.state).toBe('ready');
  });

  it('closes immediately on versionchange and refuses operations until reopened', async () => {
    const indexedDb = new FakeIndexedDbFactory();
    const store = createStore(indexedDb);
    await store.open();

    indexedDb.triggerVersionChange(store.databaseName);

    expect(store.state).toBe('versionchange');
    await expect(store.listOutbox()).rejects.toMatchObject({
      code: 'version-changed',
    });

    await store.open();
    expect(store.state).toBe('ready');
  });

  it('fails closed on quota errors and only recovers after a committed retry', async () => {
    const indexedDb = new FakeIndexedDbFactory();
    const store = createStore(indexedDb);
    await store.open();
    const entry = {
      createdAt: 1_721_000_000_000,
      operationId: 'revision-quota',
      payload: { contentHash: 'sha256:example' },
    };
    let uploadAllowed = false;

    indexedDb.failNextWrite(
      new DOMException('The local storage quota is exhausted.', 'QuotaExceededError'),
    );
    try {
      await store.enqueueOutbox(entry);
      uploadAllowed = true;
    } catch (error) {
      expect(error).toBeInstanceOf(ClientStoreError);
      expect(error).toMatchObject({ code: 'quota-exceeded' });
    }

    expect(uploadAllowed).toBe(false);
    expect(store.state).toBe('write-failed');
    await expect(store.listOutbox()).resolves.toEqual([]);

    await store.enqueueOutbox(entry);
    expect(store.state).toBe('ready');
    await expect(store.listOutbox()).resolves.toEqual([entry]);
  });

  it('does not expose an outbox entry when quota aborts the transaction after request success', async () => {
    const indexedDb = new FakeIndexedDbFactory();
    const store = createStore(indexedDb);
    await store.open();
    indexedDb.failNextCommit(
      new DOMException('Commit quota failure.', 'QuotaExceededError'),
    );

    await expect(
      store.enqueueOutbox({
        createdAt: 1_721_000_000_000,
        operationId: 'revision-commit-quota',
        payload: { path: 'shared/commit.md' },
      }),
    ).rejects.toMatchObject({ code: 'quota-exceeded' });

    expect(store.state).toBe('write-failed');
    await expect(store.listOutbox()).resolves.toEqual([]);
  });

  it('is idempotent when already open and refuses use after close', async () => {
    const indexedDb = new FakeIndexedDbFactory();
    const store = createStore(indexedDb);

    await store.open();
    await expect(store.open()).resolves.toBeUndefined();
    store.close();

    await expect(store.listOutbox()).rejects.toMatchObject({ code: 'closed' });
    await expect(
      store.enqueueOutbox({
        createdAt: 1,
        operationId: 'closed-write',
        payload: null,
      }),
    ).rejects.toMatchObject({ code: 'closed' });
    expect(store.state).toBe('closed');

    await expect(store.open()).resolves.toBeUndefined();
    expect(store.state).toBe('ready');
  });

  it('rejects unavailable IndexedDB, unsafe keys, and invalid timestamps', async () => {
    expect(
      () => new IndexedDbClientStore({ clientInstanceId: CLIENT_ID }),
    ).toThrow(expect.objectContaining({ code: 'storage-unavailable' }));

    const store = createStore(new FakeIndexedDbFactory());
    await store.open();
    await expect(store.setConnectionValue('', 'value')).rejects.toMatchObject({
      code: 'transaction-failed',
    });
    await expect(
      store.enqueueOutbox({
        createdAt: Number.NaN,
        operationId: 'invalid-time',
        payload: null,
      }),
    ).rejects.toMatchObject({ code: 'transaction-failed' });
  });
});

function createStore(
  indexedDb: FakeIndexedDbFactory,
  clientInstanceId = CLIENT_ID,
): IndexedDbClientStore {
  return new IndexedDbClientStore({
    clientInstanceId,
    indexedDB: indexedDb.asFactory(),
  });
}
