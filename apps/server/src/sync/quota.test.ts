import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { buildApp } from '../app.js';
import { SessionRepository } from '../auth/session-repository.js';
import { BlobStore, type BlobWriteResult } from '../blob-store.js';
import { RevisionRepository } from '../revision-repository.js';
import {
  createTestApp,
  definedOnly,
  makeTempDir,
  mintAccessToken,
  openMigratedDatabase,
  pushRevisions as push,
  releaseTestResources,
  revisionEntry,
  revisionHeader,
  type RevisionInput,
  rowSeeder,
  setVaultQuota,
} from '../test/fixtures/server-fixtures.js';

const START_TIME = '2026-07-24T03:00:00.000Z';

const USER_A = '80000000-0000-4000-8000-0000000000a1';
const DEVICE_A = '80000000-0000-4000-8000-0000000000a2';
const VAULT_A = '80000000-0000-4000-8000-0000000000a3';
const MEMBERSHIP_A = '80000000-0000-4000-8000-0000000000a4';
const FILE_1 = '80000000-0000-4000-8000-0000000000f1';
const FILE_2 = '80000000-0000-4000-8000-0000000000f2';
const FILE_3 = '80000000-0000-4000-8000-0000000000f3';
const REVISION_1 = '80000000-0000-4000-8000-000000000001';
const REVISION_2 = '80000000-0000-4000-8000-000000000002';
const REVISION_3 = '80000000-0000-4000-8000-000000000003';

interface Fixture {
  readonly database: Database.Database;
  readonly sessions: SessionRepository;
  readonly revisions: RevisionRepository;
  readonly blobStore: BlobStore;
  readonly accessTokenA: string;
}

function makeFixture(): Fixture {
  const directory = makeTempDir('havemind-quota-');
  const database = openMigratedDatabase(directory);

  const now = (): Date => new Date(START_TIME);
  const sessions = new SessionRepository(database, { now });
  const blobStore = new BlobStore(join(directory, 'blobs'));
  const revisions = new RevisionRepository(database, blobStore, { now });

  const { insertDevice, insertMembership, insertUser, insertVault } = rowSeeder(START_TIME);
  insertUser(database, USER_A, 'Alice');
  insertDevice(database, DEVICE_A, USER_A, 'Alice Laptop');
  insertVault(database, VAULT_A, 'Vault A');
  insertMembership(database, MEMBERSHIP_A, VAULT_A, USER_A);
  const accessTokenA = mintAccessToken(database, sessions, USER_A, DEVICE_A);

  return { accessTokenA, blobStore, database, revisions, sessions };
}

function revisionInput(
  revisionId: string,
  fileId: string,
  idempotencyKey: string,
  content: string,
  parents: readonly string[] = [],
): RevisionInput {
  const author = { deviceId: DEVICE_A, membershipId: MEMBERSHIP_A };
  return revisionEntry(
    revisionHeader(VAULT_A, author, revisionId, fileId, parents),
    idempotencyKey,
    content,
  );
}

interface CreateAppOptions {
  readonly freeDiskBytes?: () => Promise<number> | number;
  readonly minFreeDiskBytes?: number;
  readonly onPut?: () => void;
}

function createApp(fixture: Fixture, options: CreateAppOptions = {}): ReturnType<typeof buildApp> {
  const { freeDiskBytes, minFreeDiskBytes, onPut } = options;
  const wrappedBlobStore = {
    put: async (input: Uint8Array): Promise<BlobWriteResult> => {
      onPut?.();
      return fixture.blobStore.put(input);
    },
    read: (hash: Parameters<BlobStore['read']>[0]): Promise<Buffer> =>
      fixture.blobStore.read(hash),
  };
  return createTestApp({
    database: fixture.database,
    sessions: fixture.sessions,
    sync: {
      blobStore: wrappedBlobStore,
      database: fixture.database,
      revisions: fixture.revisions,
      ...definedOnly({ freeDiskBytes, minFreeDiskBytes }),
    },
  });
}

function readUsage(app: ReturnType<typeof buildApp>, token: string, vaultId: string) {
  return app.inject({
    headers: { authorization: `Bearer ${token}` },
    method: 'GET',
    url: `/vaults/${vaultId}/members`,
  });
}

afterEach(releaseTestResources);

describe('per-vault storage quota enforcement', () => {
  it('accepts an under-quota commit and reports usage as the distinct-blob sum', async () => {
    const fixture = makeFixture();
    setVaultQuota(fixture.database, VAULT_A, 100);
    const app = createApp(fixture);

    const pushed = await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, FILE_1, 'k1', 'a'.repeat(60)),
    ]);
    expect(pushed.statusCode).toBe(200);
    expect((pushed.json() as { results: Array<{ status: string }> }).results[0]?.status).toBe(
      'accepted',
    );

    const usage = await readUsage(app, fixture.accessTokenA, VAULT_A);
    expect(usage.statusCode).toBe(200);
    const body = usage.json() as { storageBytes: number; quotaBytes: number };
    expect(body.storageBytes).toBe(60);
    expect(body.quotaBytes).toBe(100);
  });

  it('rejects an over-quota append-only overwrite with 413 and charges nothing extra', async () => {
    const fixture = makeFixture();
    setVaultQuota(fixture.database, VAULT_A, 100);
    const app = createApp(fixture);

    const first = await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, FILE_1, 'k1', 'a'.repeat(60)),
    ]);
    expect(first.statusCode).toBe(200);

    // A distinct-content revision of the same file is a new blob_hash; 60+60 > 100.
    const second = await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_2, FILE_1, 'k2', 'b'.repeat(60), [REVISION_1]),
    ]);
    expect(second.statusCode).toBe(413);
    expect(second.json()).toEqual({ error: { code: 'QUOTA_EXCEEDED' } });
    expect(second.headers['cache-control']).toBe('no-store');

    const usage = await readUsage(app, fixture.accessTokenA, VAULT_A);
    expect((usage.json() as { storageBytes: number }).storageBytes).toBe(60);
  });

  it('does not write a quota-rejected blob to disk (pre-check before put)', async () => {
    const fixture = makeFixture();
    setVaultQuota(fixture.database, VAULT_A, 10);
    let putCalls = 0;
    const app = createApp(fixture, { onPut: () => (putCalls += 1) });

    const oversized = 'x'.repeat(25 * 1024 * 1024);
    const pushed = await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, FILE_1, 'k1', oversized),
    ]);
    expect(pushed.statusCode).toBe(413);
    expect(pushed.json()).toEqual({ error: { code: 'QUOTA_EXCEEDED' } });
    expect(putCalls).toBe(0);
    expect(await fixture.blobStore.listHashes()).toHaveLength(0);
  });

  it('does not re-charge a blob already stored (content-addressed dedup)', async () => {
    const fixture = makeFixture();
    setVaultQuota(fixture.database, VAULT_A, 100);
    const app = createApp(fixture);

    const shared = 'a'.repeat(60);
    const first = await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, FILE_1, 'k1', shared),
    ]);
    expect(first.statusCode).toBe(200);

    // Identical bytes under a different file: same blob_hash, no extra charge.
    const second = await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_2, FILE_2, 'k2', shared),
    ]);
    expect(second.statusCode).toBe(200);
    expect((second.json() as { results: Array<{ status: string }> }).results[0]?.status).toBe(
      'accepted',
    );

    const usage = await readUsage(app, fixture.accessTokenA, VAULT_A);
    expect((usage.json() as { storageBytes: number }).storageBytes).toBe(60);
  });

  it('allows usage exactly at the cap and rejects the first byte over', async () => {
    const fixture = makeFixture();
    setVaultQuota(fixture.database, VAULT_A, 120);
    const app = createApp(fixture);

    expect(
      (await push(app, fixture.accessTokenA, VAULT_A, [
        revisionInput(REVISION_1, FILE_1, 'k1', 'a'.repeat(60)),
      ])).statusCode,
    ).toBe(200);
    expect(
      (await push(app, fixture.accessTokenA, VAULT_A, [
        revisionInput(REVISION_2, FILE_2, 'k2', 'b'.repeat(60)),
      ])).statusCode,
    ).toBe(200);

    const usage = await readUsage(app, fixture.accessTokenA, VAULT_A);
    expect((usage.json() as { storageBytes: number }).storageBytes).toBe(120);

    const overByOne = await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_3, FILE_3, 'k3', 'c'),
    ]);
    expect(overByOne.statusCode).toBe(413);
    expect(overByOne.json()).toEqual({ error: { code: 'QUOTA_EXCEEDED' } });
  });

  it('does not re-charge an idempotent retry of the same revision', async () => {
    const fixture = makeFixture();
    setVaultQuota(fixture.database, VAULT_A, 100);
    const app = createApp(fixture);

    const input = revisionInput(REVISION_1, FILE_1, 'k1', 'a'.repeat(60));
    const first = await push(app, fixture.accessTokenA, VAULT_A, [input]);
    expect(first.statusCode).toBe(200);
    const firstReceipt = (
      first.json() as { results: Array<{ receipt: { serverSequence: number } }> }
    ).results[0]?.receipt;

    // Identical revisionId + idempotencyKey: the original receipt is returned
    // verbatim and the counter is not incremented a second time.
    const replay = await push(app, fixture.accessTokenA, VAULT_A, [input]);
    expect(replay.statusCode).toBe(200);
    const replayReceipt = (
      replay.json() as { results: Array<{ receipt: { serverSequence: number } }> }
    ).results[0]?.receipt;
    expect(replayReceipt?.serverSequence).toBe(firstReceipt?.serverSequence);

    const usage = await readUsage(app, fixture.accessTokenA, VAULT_A);
    expect((usage.json() as { storageBytes: number }).storageBytes).toBe(60);
  });
});

describe('free-disk pressure guard', () => {
  it('rejects a push with 507 when free disk is below the threshold and never calls put', async () => {
    const fixture = makeFixture();
    let putCalls = 0;
    const app = createApp(fixture, {
      freeDiskBytes: () => 1024,
      minFreeDiskBytes: 2 * 1024 * 1024 * 1024,
      onPut: () => (putCalls += 1),
    });

    const pushed = await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, FILE_1, 'k1', 'a'.repeat(60)),
    ]);
    expect(pushed.statusCode).toBe(507);
    expect(pushed.json()).toEqual({ error: { code: 'STORAGE_UNAVAILABLE' } });
    expect(pushed.headers['cache-control']).toBe('no-store');
    expect(putCalls).toBe(0);
  });

  it('fails closed with 507 when the free-disk probe throws', async () => {
    const fixture = makeFixture();
    const app = createApp(fixture, {
      freeDiskBytes: () => {
        throw new Error('statfs failed');
      },
      minFreeDiskBytes: 2 * 1024 * 1024 * 1024,
    });

    const pushed = await push(app, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, FILE_1, 'k1', 'a'.repeat(60)),
    ]);
    expect(pushed.statusCode).toBe(507);
    expect(pushed.json()).toEqual({ error: { code: 'STORAGE_UNAVAILABLE' } });
  });

  it('does not block reads when free disk is low', async () => {
    const fixture = makeFixture();
    // Commit one revision while disk is healthy.
    const seedApp = createApp(fixture);
    await push(seedApp, fixture.accessTokenA, VAULT_A, [
      revisionInput(REVISION_1, FILE_1, 'k1', 'a'.repeat(60)),
    ]);

    const lowDiskApp = createApp(fixture, {
      freeDiskBytes: () => 0,
      minFreeDiskBytes: 2 * 1024 * 1024 * 1024,
    });
    const events = await lowDiskApp.inject({
      headers: { authorization: `Bearer ${fixture.accessTokenA}` },
      method: 'GET',
      url: `/vaults/${VAULT_A}/events`,
    });
    expect(events.statusCode).toBe(200);
  });
});
