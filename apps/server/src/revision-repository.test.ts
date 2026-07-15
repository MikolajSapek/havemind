import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PROTOCOL_VERSION,
  blobHashSchema,
  type ProtectedRevisionHeader,
} from '@havemind/protocol';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { BlobStore } from './blob-store.js';
import { openDatabase } from './db.js';
import { runMigrations } from './migrations.js';
import {
  RevisionRepository,
  RevisionRepositoryError,
  type CommitRevisionInput,
  type RevisionRepositoryErrorCode,
} from './revision-repository.js';

const USER_A = '10000000-0000-4000-8000-000000000001';
const USER_B = '10000000-0000-4000-8000-000000000002';
const DEVICE_A = '20000000-0000-4000-8000-000000000001';
const DEVICE_B = '20000000-0000-4000-8000-000000000002';
const MEMBER_A = '30000000-0000-4000-8000-000000000001';
const MEMBER_B = '30000000-0000-4000-8000-000000000002';
const MEMBER_A_VAULT_B = '30000000-0000-4000-8000-000000000003';
const VAULT_A = '40000000-0000-4000-8000-000000000001';
const VAULT_B = '40000000-0000-4000-8000-000000000002';
const FILE_A = '50000000-0000-4000-8000-000000000001';
const FILE_B = '50000000-0000-4000-8000-000000000002';
const REVISION_1 = '60000000-0000-4000-8000-000000000001';
const REVISION_2 = '60000000-0000-4000-8000-000000000002';
const REVISION_3 = '60000000-0000-4000-8000-000000000003';
const REVISION_4 = '60000000-0000-4000-8000-000000000004';
const REVISION_5 = '60000000-0000-4000-8000-000000000005';
const SERVER_TIME = '2026-07-15T02:30:00.000Z';

const SEMANTICS = Object.freeze({
  pathNormalization: 'nfc-lowercase-v1',
  payloadFormat: 'revision-payload-v1',
  provenanceRecipe: 'source-range-v1',
  syncSemantics: 'dag-cas-v1',
} as const);

interface TestFixture {
  readonly blobStore: BlobStore;
  database: Database.Database;
  readonly databasePath: string;
  repository: RevisionRepository;
}

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

function trackDatabase(database: Database.Database): Database.Database {
  openDatabases.push(database);
  return database;
}

function seedIdentityAndVaults(database: Database.Database): void {
  const now = SERVER_TIME;
  const insertUser = database.prepare(
    `INSERT INTO users
       (id, display_name, is_instance_owner, status, created_at)
     VALUES (?, ?, ?, 'active', ?)`,
  );
  insertUser.run(USER_A, 'User A', 1, now);
  insertUser.run(USER_B, 'User B', 0, now);

  const insertDevice = database.prepare(
    `INSERT INTO devices
       (id, user_id, display_name, public_key, status, created_at, approved_at)
     VALUES (?, ?, ?, ?, 'approved', ?, ?)`,
  );
  insertDevice.run(
    DEVICE_A,
    USER_A,
    'Device A',
    Buffer.from('device-a-public-key'),
    now,
    now,
  );
  insertDevice.run(
    DEVICE_B,
    USER_B,
    'Device B',
    Buffer.from('device-b-public-key'),
    now,
    now,
  );

  const insertVault = database.prepare(
    `INSERT INTO vaults (id, display_name, created_at)
     VALUES (?, ?, ?)`,
  );
  insertVault.run(VAULT_A, 'Vault A', now);
  insertVault.run(VAULT_B, 'Vault B', now);

  const insertMembership = database.prepare(
    `INSERT INTO memberships
       (id, vault_id, user_id, role, status, created_at)
     VALUES (?, ?, ?, 'owner', 'active', ?)`,
  );
  insertMembership.run(MEMBER_A, VAULT_A, USER_A, now);
  insertMembership.run(MEMBER_B, VAULT_A, USER_B, now);
  insertMembership.run(MEMBER_A_VAULT_B, VAULT_B, USER_A, now);
}

async function makeFixture(): Promise<TestFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'havemind-repository-'));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, 'havemind.sqlite');
  const database = trackDatabase(openDatabase(databasePath));
  runMigrations(database);
  seedIdentityAndVaults(database);
  const blobStore = new BlobStore(join(directory, 'blobs'));
  const repository = new RevisionRepository(database, blobStore, {
    now: () => new Date(SERVER_TIME),
  });

  return { blobStore, database, databasePath, repository };
}

afterEach(async () => {
  for (const database of openDatabases.splice(0)) {
    if (database.open) {
      database.close();
    }
  }

  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

function revisionHeader(
  revisionId: string,
  parentRevisionIds: readonly string[] = [],
  overrides: Partial<ProtectedRevisionHeader> = {},
): ProtectedRevisionHeader {
  return {
    expectedDeviceId: DEVICE_A,
    expectedMemberId: MEMBER_A,
    fileId: FILE_A,
    parentRevisionIds: [...parentRevisionIds],
    payloadEncoding: 'plaintext-json-v1',
    protocol: PROTOCOL_VERSION,
    revisionId,
    semantics: SEMANTICS,
    vaultId: VAULT_A,
    ...overrides,
  };
}

async function storedInput(
  fixture: TestFixture,
  revisionId: string,
  parentRevisionIds: readonly string[],
  idempotencyKey: string,
  content: string,
  overrides: Partial<CommitRevisionInput> = {},
): Promise<CommitRevisionInput> {
  const storedBlob = await fixture.blobStore.put(Buffer.from(content));

  return {
    actor: { deviceId: DEVICE_A, memberId: MEMBER_A },
    blobHash: storedBlob.hash,
    header: revisionHeader(revisionId, parentRevisionIds),
    idempotencyKey,
    ...overrides,
  };
}

async function expectRepositoryCode(
  action: () => Promise<unknown>,
  code: RevisionRepositoryErrorCode,
): Promise<void> {
  try {
    await action();
    throw new Error(`Expected repository error ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(RevisionRepositoryError);
    expect((error as RevisionRepositoryError).code).toBe(code);
  }
}

function expectSynchronousRepositoryCode(
  action: () => unknown,
  code: RevisionRepositoryErrorCode,
): void {
  try {
    action();
    throw new Error(`Expected repository error ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(RevisionRepositoryError);
    expect((error as RevisionRepositoryError).code).toBe(code);
  }
}

function rowCount(database: Database.Database, table: string): number {
  const allowedTables = new Set([
    'file_heads',
    'files',
    'idempotency_records',
    'revision_parents',
    'revisions',
    'vault_events',
  ]);
  if (!allowedTables.has(table)) {
    throw new Error(`Unexpected test table ${table}.`);
  }

  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
    | { count: number }
    | undefined;
  return row?.count ?? 0;
}

describe('RevisionRepository', () => {
  it('commits one receipt/event/head atomically and replays without a new cursor', async () => {
    const fixture = await makeFixture();
    const input = await storedInput(
      fixture,
      REVISION_1,
      [],
      'create-r1',
      'opaque-r1',
    );

    const accepted = await fixture.repository.commitRevision(input);

    expect(accepted).toEqual({
      receipt: {
        blobHash: input.blobHash,
        byteLength: Buffer.byteLength('opaque-r1'),
        deviceId: DEVICE_A,
        memberId: MEMBER_A,
        revisionId: REVISION_1,
        serverSequence: 1,
        serverTime: SERVER_TIME,
      },
      status: 'accepted',
    });
    expect(fixture.repository.getHeads(VAULT_A, FILE_A)).toEqual([REVISION_1]);
    expect(fixture.repository.getCursor(VAULT_A)).toBe(1);
    expect(fixture.repository.listEvents(VAULT_A, 0, 10)).toEqual([
      {
        fileId: FILE_A,
        receipt: accepted.receipt,
        revisionId: REVISION_1,
        serverSequence: 1,
        type: 'revision-accepted',
      },
    ]);

    expect(await fixture.repository.commitRevision(input)).toEqual(accepted);
    const replayWithNewKey = await fixture.repository.commitRevision({
      ...input,
      idempotencyKey: 'create-r1-second-delivery',
    });
    expect(replayWithNewKey).toEqual({ ...accepted, status: 'replayed' });
    expect(fixture.repository.getCursor(VAULT_A)).toBe(1);
    expect(rowCount(fixture.database, 'revisions')).toBe(1);
    expect(rowCount(fixture.database, 'vault_events')).toBe(1);
    expect(rowCount(fixture.database, 'idempotency_records')).toBe(2);
  });

  it('returns REVISION_ID_REUSE for different blob bytes or a changed header', async () => {
    const fixture = await makeFixture();
    const input = await storedInput(
      fixture,
      REVISION_1,
      [],
      'original',
      'original-bytes',
    );
    await fixture.repository.commitRevision(input);
    const differentBlob = await fixture.blobStore.put(Buffer.from('different-bytes'));

    await expectRepositoryCode(
      async () =>
        fixture.repository.commitRevision({
          ...input,
          blobHash: differentBlob.hash,
          idempotencyKey: 'changed-blob',
        }),
      'REVISION_ID_REUSE',
    );
    await expectRepositoryCode(
      async () =>
        fixture.repository.commitRevision({
          ...input,
          header: revisionHeader(REVISION_1, [], { fileId: FILE_B }),
          idempotencyKey: 'changed-header',
        }),
      'REVISION_ID_REUSE',
    );

    expect(fixture.repository.getCursor(VAULT_A)).toBe(1);
    expect(rowCount(fixture.database, 'revisions')).toBe(1);
  });

  it('preserves stale single-parent updates as concurrent heads', async () => {
    const fixture = await makeFixture();
    const root = await storedInput(
      fixture,
      REVISION_1,
      [],
      'r1',
      'opaque-r1',
    );
    const firstChild = await storedInput(
      fixture,
      REVISION_2,
      [REVISION_1],
      'r2',
      'opaque-r2',
    );
    const staleChild = await storedInput(
      fixture,
      REVISION_3,
      [REVISION_1],
      'r3',
      'opaque-r3',
    );

    await fixture.repository.commitRevision(root);
    await fixture.repository.commitRevision(firstChild);
    const staleReceipt = await fixture.repository.commitRevision(staleChild);

    expect(staleReceipt.receipt.serverSequence).toBe(3);
    expect(fixture.repository.getHeads(VAULT_A, FILE_A)).toEqual([
      REVISION_2,
      REVISION_3,
    ]);
    expect(
      fixture.repository
        .listEvents(VAULT_A, 0, 10)
        .map(({ serverSequence }) => serverSequence),
    ).toEqual([1, 2, 3]);
  });

  it('accepts multi-parent reconciliation only for the exact current head set', async () => {
    const fixture = await makeFixture();
    const revisions = await Promise.all([
      storedInput(fixture, REVISION_1, [], 'r1', 'opaque-r1'),
      storedInput(fixture, REVISION_2, [REVISION_1], 'r2', 'opaque-r2'),
      storedInput(fixture, REVISION_3, [REVISION_1], 'r3', 'opaque-r3'),
    ]);
    for (const revision of revisions) {
      await fixture.repository.commitRevision(revision);
    }

    const wrongHeads = await storedInput(
      fixture,
      REVISION_4,
      [REVISION_1, REVISION_2],
      'wrong-merge',
      'wrong-merge',
    );
    await expectRepositoryCode(
      async () => fixture.repository.commitRevision(wrongHeads),
      'HEAD_SET_CHANGED',
    );
    expect(fixture.repository.getCursor(VAULT_A)).toBe(3);

    const exactHeads = await storedInput(
      fixture,
      REVISION_4,
      [REVISION_2, REVISION_3],
      'exact-merge',
      'exact-merge',
    );
    const merged = await fixture.repository.commitRevision(exactHeads);
    expect(merged.receipt.serverSequence).toBe(4);
    expect(fixture.repository.getHeads(VAULT_A, FILE_A)).toEqual([REVISION_4]);

    const nowStale = await storedInput(
      fixture,
      REVISION_5,
      [REVISION_2, REVISION_3],
      'stale-merge',
      'stale-merge',
    );
    await expectRepositoryCode(
      async () => fixture.repository.commitRevision(nowStale),
      'HEAD_SET_CHANGED',
    );
    expect(fixture.repository.getCursor(VAULT_A)).toBe(4);
  });

  it('does not mutate SQLite when a referenced blob is missing or corrupt', async () => {
    const fixture = await makeFixture();
    const missing = {
      actor: { deviceId: DEVICE_A, memberId: MEMBER_A },
      blobHash: blobHashSchema.parse('0'.repeat(64)),
      header: revisionHeader(REVISION_1),
      idempotencyKey: 'missing',
    } satisfies CommitRevisionInput;

    await expectRepositoryCode(
      async () => fixture.repository.commitRevision(missing),
      'MISSING_BLOB',
    );

    const corrupt = await storedInput(
      fixture,
      REVISION_1,
      [],
      'corrupt',
      'valid-before-corruption',
    );
    await writeFile(
      fixture.blobStore.pathForHash(corrupt.blobHash),
      'corrupt-on-disk',
    );
    await expectRepositoryCode(
      async () => fixture.repository.commitRevision(corrupt),
      'CORRUPT_BLOB',
    );

    for (const table of [
      'files',
      'revisions',
      'revision_parents',
      'file_heads',
      'vault_events',
      'idempotency_records',
    ]) {
      expect(rowCount(fixture.database, table)).toBe(0);
    }
    expect(fixture.repository.getCursor(VAULT_A)).toBe(0);
  });

  it('rejects spoofed protected actor IDs and derives receipts from auth context', async () => {
    const fixture = await makeFixture();
    const spoofed = await storedInput(
      fixture,
      REVISION_1,
      [],
      'spoofed',
      'spoofed',
      {
        header: revisionHeader(REVISION_1, [], {
          expectedDeviceId: DEVICE_B,
          expectedMemberId: MEMBER_B,
        }),
      },
    );

    await expectRepositoryCode(
      async () => fixture.repository.commitRevision(spoofed),
      'FORBIDDEN',
    );
    expect(rowCount(fixture.database, 'revisions')).toBe(0);

    const legitimate = await storedInput(
      fixture,
      REVISION_1,
      [],
      'legitimate',
      JSON.stringify({ deviceId: DEVICE_B, memberId: MEMBER_B }),
    );
    const result = await fixture.repository.commitRevision(legitimate);
    expect(result.receipt).toMatchObject({
      deviceId: DEVICE_A,
      memberId: MEMBER_A,
    });
  });

  it('rejects reuse of an idempotency key for a different request', async () => {
    const fixture = await makeFixture();
    const root = await storedInput(
      fixture,
      REVISION_1,
      [],
      'shared-key',
      'root',
    );
    await fixture.repository.commitRevision(root);
    const child = await storedInput(
      fixture,
      REVISION_2,
      [REVISION_1],
      'shared-key',
      'child',
    );

    await expectRepositoryCode(
      async () => fixture.repository.commitRevision(child),
      'IDEMPOTENCY_KEY_REUSE',
    );
    expect(fixture.repository.getCursor(VAULT_A)).toBe(1);
    expect(fixture.repository.getHeads(VAULT_A, FILE_A)).toEqual([REVISION_1]);
  });

  it('rejects invalid idempotency settings, keys, and event cursors', async () => {
    const fixture = await makeFixture();
    const tooLongTtl = 366 * 24 * 60 * 60 * 1_000;
    for (const idempotencyTtlMs of [0, 1.5, tooLongTtl]) {
      expectSynchronousRepositoryCode(
        () =>
          new RevisionRepository(fixture.database, fixture.blobStore, {
            idempotencyTtlMs,
          }),
        'INVALID_REQUEST',
      );
    }

    const valid = await storedInput(
      fixture,
      REVISION_1,
      [],
      'valid-key',
      'valid-key',
    );
    for (const idempotencyKey of ['', 'x'.repeat(201), 'line\nbreak']) {
      await expectRepositoryCode(
        async () =>
          fixture.repository.commitRevision({ ...valid, idempotencyKey }),
        'INVALID_REQUEST',
      );
    }

    expectSynchronousRepositoryCode(
      () => fixture.repository.listEvents(VAULT_A, -1, 10),
      'INVALID_REQUEST',
    );
    for (const limit of [0, 1.5, 1_001]) {
      expectSynchronousRepositoryCode(
        () => fixture.repository.listEvents(VAULT_A, 0, limit),
        'INVALID_REQUEST',
      );
    }
    expectSynchronousRepositoryCode(
      () =>
        fixture.repository.getCursor(
          '40000000-0000-4000-8000-000000000099',
        ),
      'NOT_FOUND',
    );
    expect(rowCount(fixture.database, 'revisions')).toBe(0);
  });

  it('checks revoked actor state before attempting to read a blob', async () => {
    const fixture = await makeFixture();
    fixture.database
      .prepare("UPDATE devices SET status = 'revoked' WHERE id = ?")
      .run(DEVICE_A);
    const repository = new RevisionRepository(
      fixture.database,
      {
        async read(): Promise<Buffer> {
          throw new Error('Blob read must not run for a revoked actor.');
        },
      },
      { now: () => new Date(SERVER_TIME) },
    );
    const input = {
      actor: { deviceId: DEVICE_A, memberId: MEMBER_A },
      blobHash: blobHashSchema.parse('0'.repeat(64)),
      header: revisionHeader(REVISION_1),
      idempotencyKey: 'revoked-device',
    } satisfies CommitRevisionInput;

    await expectRepositoryCode(
      async () => repository.commitRevision(input),
      'FORBIDDEN',
    );
    expect(rowCount(fixture.database, 'revisions')).toBe(0);
  });

  it('rejects a second root, a missing parent, and a cross-file parent', async () => {
    const fixture = await makeFixture();
    const rootA = await storedInput(
      fixture,
      REVISION_1,
      [],
      'graph-root-a',
      'graph-root-a',
    );
    await fixture.repository.commitRevision(rootA);

    const secondRoot = await storedInput(
      fixture,
      REVISION_2,
      [],
      'second-root',
      'second-root',
    );
    await expectRepositoryCode(
      async () => fixture.repository.commitRevision(secondRoot),
      'FILE_ALREADY_EXISTS',
    );

    const missingParent = await storedInput(
      fixture,
      REVISION_2,
      ['60000000-0000-4000-8000-000000000099'],
      'missing-parent',
      'missing-parent',
    );
    await expectRepositoryCode(
      async () => fixture.repository.commitRevision(missingParent),
      'MISSING_PARENT',
    );

    const rootB = await storedInput(
      fixture,
      REVISION_4,
      [],
      'graph-root-b',
      'graph-root-b',
      {
        actor: { deviceId: DEVICE_A, memberId: MEMBER_A_VAULT_B },
        header: revisionHeader(REVISION_4, [], {
          expectedMemberId: MEMBER_A_VAULT_B,
          fileId: FILE_B,
          vaultId: VAULT_B,
        }),
      },
    );
    await fixture.repository.commitRevision(rootB);
    const crossFileParent = await storedInput(
      fixture,
      REVISION_5,
      [REVISION_4],
      'cross-file-parent',
      'cross-file-parent',
    );
    await expectRepositoryCode(
      async () => fixture.repository.commitRevision(crossFileParent),
      'PARENT_FILE_MISMATCH',
    );

    expect(fixture.repository.getCursor(VAULT_A)).toBe(1);
    expect(fixture.repository.getCursor(VAULT_B)).toBe(1);
  });

  it('fails closed when durable idempotency or event metadata is corrupt', async () => {
    const fixture = await makeFixture();
    const input = await storedInput(
      fixture,
      REVISION_1,
      [],
      'metadata',
      'metadata',
    );
    await fixture.repository.commitRevision(input);

    fixture.database
      .prepare(
        `UPDATE idempotency_records
         SET response_body = '{}'
         WHERE device_id = ? AND idempotency_key = ?`,
      )
      .run(DEVICE_A, 'metadata');
    await expectRepositoryCode(
      async () => fixture.repository.commitRevision(input),
      'REPOSITORY_INTEGRITY',
    );

    fixture.database
      .prepare("UPDATE vault_events SET event_payload = '{}' WHERE vault_id = ?")
      .run(VAULT_A);
    expectSynchronousRepositoryCode(
      () => fixture.repository.listEvents(VAULT_A, 0, 10),
      'REPOSITORY_INTEGRITY',
    );
    expect(fixture.repository.getCursor(VAULT_A)).toBe(1);
  });

  it('rolls back revision, event, heads, cursor, and idempotency on SQL failure', async () => {
    const fixture = await makeFixture();
    const input = await storedInput(
      fixture,
      REVISION_1,
      [],
      'atomic',
      'atomic',
    );
    fixture.database.exec(`
      CREATE TRIGGER fail_event_insert
      BEFORE INSERT ON vault_events
      BEGIN
        SELECT RAISE(ABORT, 'event-write-failure');
      END;
    `);

    await expect(fixture.repository.commitRevision(input)).rejects.toThrow(
      'event-write-failure',
    );
    for (const table of [
      'files',
      'revisions',
      'revision_parents',
      'file_heads',
      'vault_events',
      'idempotency_records',
    ]) {
      expect(rowCount(fixture.database, table)).toBe(0);
    }
    expect(fixture.repository.getCursor(VAULT_A)).toBe(0);

    fixture.database.exec('DROP TRIGGER fail_event_insert');
    const retried = await fixture.repository.commitRevision(input);
    expect(retried.receipt.serverSequence).toBe(1);
  });

  it('keeps per-vault sequences independent and cursor pagination gap-free', async () => {
    const fixture = await makeFixture();
    const rootA = await storedInput(
      fixture,
      REVISION_1,
      [],
      'vault-a-root',
      'vault-a-root',
    );
    const childA = await storedInput(
      fixture,
      REVISION_2,
      [REVISION_1],
      'vault-a-child',
      'vault-a-child',
    );
    const rootB = await storedInput(
      fixture,
      REVISION_3,
      [],
      'vault-b-root',
      'vault-b-root',
      {
        actor: { deviceId: DEVICE_A, memberId: MEMBER_A_VAULT_B },
        header: revisionHeader(REVISION_3, [], {
          expectedMemberId: MEMBER_A_VAULT_B,
          fileId: FILE_B,
          vaultId: VAULT_B,
        }),
      },
    );

    const receiptA1 = await fixture.repository.commitRevision(rootA);
    const receiptA2 = await fixture.repository.commitRevision(childA);
    const receiptB1 = await fixture.repository.commitRevision(rootB);

    expect(receiptA1.receipt.serverSequence).toBe(1);
    expect(receiptA2.receipt.serverSequence).toBe(2);
    expect(receiptB1.receipt.serverSequence).toBe(1);
    expect(fixture.repository.getCursor(VAULT_A)).toBe(2);
    expect(fixture.repository.getCursor(VAULT_B)).toBe(1);
    expect(fixture.repository.listEvents(VAULT_A, 0, 1)).toHaveLength(1);
    expect(
      fixture.repository
        .listEvents(VAULT_A, 1, 10)
        .map(({ serverSequence }) => serverSequence),
    ).toEqual([2]);
  });

  it('continues atomically after reopening SQLite and preserves replay receipts', async () => {
    const fixture = await makeFixture();
    const root = await storedInput(
      fixture,
      REVISION_1,
      [],
      'restart-root',
      'restart-root',
    );
    const firstResult = await fixture.repository.commitRevision(root);
    fixture.database.close();

    const reopened = trackDatabase(openDatabase(fixture.databasePath));
    runMigrations(reopened);
    fixture.database = reopened;
    fixture.repository = new RevisionRepository(reopened, fixture.blobStore, {
      now: () => new Date('2026-07-15T02:31:00.000Z'),
    });
    const child = await storedInput(
      fixture,
      REVISION_2,
      [REVISION_1],
      'restart-child',
      'restart-child',
    );

    const secondResult = await fixture.repository.commitRevision(child);
    expect(secondResult.receipt.serverSequence).toBe(2);
    expect(await fixture.repository.commitRevision(root)).toEqual(firstResult);
    expect(fixture.repository.getHeads(VAULT_A, FILE_A)).toEqual([REVISION_2]);
    expect(
      fixture.repository
        .listEvents(VAULT_A, 0, 10)
        .map(({ serverSequence }) => serverSequence),
    ).toEqual([1, 2]);
  });
});
