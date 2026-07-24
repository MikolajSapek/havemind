import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PROTOCOL_VERSION, type ProtectedRevisionHeader } from '@havemind/protocol';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { SessionRepository } from '../auth/session-repository.js';
import { generateRefreshToken } from '../auth/tokens.js';
import { BlobStore, type BlobWriteResult } from '../blob-store.js';
import { parseServerConfig } from '../config.js';
import { openDatabase } from '../db.js';
import { runMigrations } from '../migrations.js';
import { RevisionRepository } from '../revision-repository.js';

const TEST_ENV = {
  HAVEMIND_API_BASE_URL: 'https://sync.example.test/api/v1',
  HAVEMIND_SERVER_NAME: 'Test Havemind',
} as const;

const START_TIME = '2026-07-24T03:00:00.000Z';
const REFRESH_TTL_SECONDS = 24 * 60 * 60;

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

const SEMANTICS = Object.freeze({
  pathNormalization: 'nfc-lowercase-v1',
  payloadFormat: 'revision-payload-v1',
  provenanceRecipe: 'source-range-v1',
  syncSemantics: 'dag-cas-v1',
} as const);

interface Fixture {
  readonly database: Database.Database;
  readonly sessions: SessionRepository;
  readonly revisions: RevisionRepository;
  readonly blobStore: BlobStore;
  readonly accessTokenA: string;
}

const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];
const applications: Array<ReturnType<typeof buildApp>> = [];

function makeFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'havemind-quota-'));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, 'havemind.sqlite'));
  databases.push(database);
  runMigrations(database);

  const now = (): Date => new Date(START_TIME);
  const sessions = new SessionRepository(database, { now });
  const blobStore = new BlobStore(join(directory, 'blobs'));
  const revisions = new RevisionRepository(database, blobStore, { now });

  database
    .prepare(
      `INSERT INTO users (id, display_name, is_instance_owner, status, created_at, revoked_at)
       VALUES (?, 'Alice', 0, 'active', ?, NULL)`,
    )
    .run(USER_A, START_TIME);
  database
    .prepare(
      `INSERT INTO devices (id, user_id, display_name, public_key, status, created_at, approved_at, revoked_at)
       VALUES (?, ?, 'Alice Laptop', ?, 'approved', ?, ?, NULL)`,
    )
    .run(DEVICE_A, USER_A, Buffer.alloc(32, 0x11), START_TIME, START_TIME);
  database
    .prepare(
      `INSERT INTO vaults (id, display_name, write_epoch, next_server_sequence, created_at, deleted_at)
       VALUES (?, 'Vault A', 0, 1, ?, NULL)`,
    )
    .run(VAULT_A, START_TIME);
  database
    .prepare(
      `INSERT INTO memberships (id, vault_id, user_id, role, status, created_at, revoked_at)
       VALUES (?, ?, ?, 'owner', 'active', ?, NULL)`,
    )
    .run(MEMBERSHIP_A, VAULT_A, USER_A, START_TIME);

  const issue = database.transaction(() =>
    sessions.createInitialSessionInCurrentTransaction({
      deviceId: DEVICE_A,
      initialRefreshToken: generateRefreshToken(),
      refreshTokenTtlSeconds: REFRESH_TTL_SECONDS,
      userId: USER_A,
    }),
  );
  const accessTokenA = issue.immediate().accessToken;

  return { accessTokenA, blobStore, database, revisions, sessions };
}

function setVaultQuota(database: Database.Database, vaultId: string, quota: number): void {
  database.prepare(`UPDATE vaults SET quota_bytes = ? WHERE id = ?`).run(quota, vaultId);
}

function header(
  revisionId: string,
  fileId: string,
  parents: readonly string[] = [],
): ProtectedRevisionHeader {
  return {
    expectedDeviceId: DEVICE_A,
    expectedMemberId: MEMBERSHIP_A,
    fileId,
    parentRevisionIds: [...parents],
    payloadEncoding: 'plaintext-json-v1',
    protocol: PROTOCOL_VERSION,
    revisionId,
    semantics: SEMANTICS,
    vaultId: VAULT_A,
  };
}

function revisionInput(
  revisionId: string,
  fileId: string,
  idempotencyKey: string,
  content: string,
  parents: readonly string[] = [],
): { header: ProtectedRevisionHeader; idempotencyKey: string; payload: string } {
  return {
    header: header(revisionId, fileId, parents),
    idempotencyKey,
    payload: Buffer.from(content, 'utf8').toString('base64'),
  };
}

interface CreateAppOptions {
  readonly freeDiskBytes?: () => Promise<number> | number;
  readonly minFreeDiskBytes?: number;
  readonly onPut?: () => void;
}

function createApp(fixture: Fixture, options: CreateAppOptions = {}): ReturnType<typeof buildApp> {
  const config = parseServerConfig(TEST_ENV);
  const wrappedBlobStore = {
    put: async (input: Uint8Array): Promise<BlobWriteResult> => {
      options.onPut?.();
      return fixture.blobStore.put(input);
    },
    read: (hash: Parameters<BlobStore['read']>[0]): Promise<Buffer> =>
      fixture.blobStore.read(hash),
  };
  const app = buildApp({
    auth: {
      clientKey: () => 'fixed-test-client',
      database: fixture.database,
      sessions: fixture.sessions,
      sync: {
        blobStore: wrappedBlobStore,
        database: fixture.database,
        revisions: fixture.revisions,
        ...(options.freeDiskBytes === undefined
          ? {}
          : { freeDiskBytes: options.freeDiskBytes }),
        ...(options.minFreeDiskBytes === undefined
          ? {}
          : { minFreeDiskBytes: options.minFreeDiskBytes }),
      },
    },
    config,
  });
  applications.push(app);
  return app;
}

function push(
  app: ReturnType<typeof buildApp>,
  token: string,
  vaultId: string,
  revisions: ReadonlyArray<ReturnType<typeof revisionInput>>,
) {
  return app.inject({
    headers: { authorization: `Bearer ${token}` },
    method: 'POST',
    payload: { revisions },
    url: `/vaults/${vaultId}/revisions`,
  });
}

function readUsage(app: ReturnType<typeof buildApp>, token: string, vaultId: string) {
  return app.inject({
    headers: { authorization: `Bearer ${token}` },
    method: 'GET',
    url: `/vaults/${vaultId}/members`,
  });
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map(async (app) => app.close()));
  for (const database of databases.splice(0)) {
    database.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

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
