import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PROTOCOL_VERSION } from '@havemind/protocol';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { BlobStore } from './blob-store.js';
import { openDatabase } from './db.js';
import {
  compactIfAllDevicesCaughtUp,
  recordDevicePullAck,
} from './history-compaction.js';
import { runMigrations } from './migrations.js';
import { RevisionRepository } from './revision-repository.js';

const USER_A = '10000000-0000-4000-8000-000000000001';
const DEVICE_A = '20000000-0000-4000-8000-000000000001';
const DEVICE_B = '20000000-0000-4000-8000-000000000002';
const MEMBER_A = '30000000-0000-4000-8000-000000000001';
const VAULT_A = '40000000-0000-4000-8000-000000000001';
const FILE_A = '50000000-0000-4000-8000-000000000001';
const REVISION_1 = '60000000-0000-4000-8000-000000000001';
const REVISION_2 = '60000000-0000-4000-8000-000000000002';
const SERVER_TIME = '2026-07-15T02:30:00.000Z';

const SEMANTICS = Object.freeze({
  pathNormalization: 'nfc-lowercase-v1',
  payloadFormat: 'revision-payload-v1',
  provenanceRecipe: 'source-range-v1',
  syncSemantics: 'dag-cas-v1',
} as const);

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

afterEach(async () => {
  for (const database of openDatabases.splice(0)) {
    if (database.open) database.close();
  }
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function makeFixture(): Promise<{
  database: Database.Database;
  repository: RevisionRepository;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'havemind-compact-'));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, 'havemind.sqlite'));
  openDatabases.push(database);
  runMigrations(database);
  const blobStore = new BlobStore(join(directory, 'blobs'));
  seed(database);
  return {
    database,
    repository: new RevisionRepository(database, blobStore, {
      now: () => new Date(SERVER_TIME),
    }),
  };
}

function seed(database: Database.Database): void {
  database
    .prepare(
      `INSERT INTO users (id, display_name, is_instance_owner, status, created_at)
       VALUES (?, 'User A', 1, 'active', ?)`,
    )
    .run(USER_A, SERVER_TIME);
  database
    .prepare(
      `INSERT INTO vaults (id, display_name, write_epoch, next_server_sequence, created_at)
       VALUES (?, 'Vault', 0, 1, ?)`,
    )
    .run(VAULT_A, SERVER_TIME);
  database
    .prepare(
      `INSERT INTO memberships (id, vault_id, user_id, role, status, created_at)
       VALUES (?, ?, ?, 'owner', 'active', ?)`,
    )
    .run(MEMBER_A, VAULT_A, USER_A, SERVER_TIME);
  const insertDevice = database.prepare(
    `INSERT INTO devices
       (id, user_id, display_name, public_key, status, created_at, approved_at, vault_id)
     VALUES (?, ?, ?, ?, 'approved', ?, ?, ?)`,
  );
  insertDevice.run(
    DEVICE_A,
    USER_A,
    'Phone',
    Buffer.alloc(32, 0x11),
    SERVER_TIME,
    SERVER_TIME,
    VAULT_A,
  );
  insertDevice.run(
    DEVICE_B,
    USER_A,
    'Desktop',
    Buffer.alloc(32, 0x22),
    SERVER_TIME,
    SERVER_TIME,
    VAULT_A,
  );
}

describe('history compaction', () => {
  it('refuses to compact while any approved device has not caught up', async () => {
    const fixture = await makeFixture();
    const blobStore = new BlobStore(
      join(temporaryDirectories[temporaryDirectories.length - 1] ?? '', 'blobs'),
    );
    await commitPair(fixture.repository, blobStore);

    recordDevicePullAck(fixture.database, DEVICE_A, 2, SERVER_TIME);
    const blocked = compactIfAllDevicesCaughtUp(
      fixture.database,
      fixture.repository,
      VAULT_A,
    );
    expect(blocked).toEqual({ compactable: false, removedRevisions: 0 });
    expect(
      fixture.repository.listEvents(VAULT_A, 0, 10).map((event) => event.revisionId),
    ).toEqual([REVISION_1, REVISION_2]);
  });

  it('compacts superseded history once every device has acked the head', async () => {
    const fixture = await makeFixture();
    const blobStore = new BlobStore(
      join(temporaryDirectories[temporaryDirectories.length - 1] ?? '', 'blobs'),
    );
    await commitPair(fixture.repository, blobStore);

    recordDevicePullAck(fixture.database, DEVICE_A, 2, SERVER_TIME);
    recordDevicePullAck(fixture.database, DEVICE_B, 2, SERVER_TIME);
    const compacted = compactIfAllDevicesCaughtUp(
      fixture.database,
      fixture.repository,
      VAULT_A,
    );
    expect(compacted).toEqual({ compactable: true, removedRevisions: 1 });
    expect(
      fixture.repository.listEvents(VAULT_A, 0, 10).map((event) => event.revisionId),
    ).toEqual([REVISION_2]);
    expect(
      fixture.repository.listHeadEvents(VAULT_A, 0, 10).map((event) => event.revisionId),
    ).toEqual([REVISION_2]);
  });
});

async function commitPair(
  repository: RevisionRepository,
  blobStore: BlobStore,
): Promise<void> {
  const first = await blobStore.put(Buffer.from('v1'));
  const second = await blobStore.put(Buffer.from('v2'));
  const header = (revisionId: string, parents: readonly string[]) => ({
    expectedDeviceId: DEVICE_A,
    expectedMemberId: MEMBER_A,
    fileId: FILE_A,
    parentRevisionIds: [...parents],
    payloadEncoding: 'plaintext-json-v1' as const,
    protocol: PROTOCOL_VERSION,
    revisionId,
    semantics: SEMANTICS,
    vaultId: VAULT_A,
  });
  await repository.commitRevision({
    actor: { deviceId: DEVICE_A, memberId: MEMBER_A },
    blobHash: first.hash,
    header: header(REVISION_1, []),
    idempotencyKey: 'r1',
  });
  await repository.commitRevision({
    actor: { deviceId: DEVICE_A, memberId: MEMBER_A },
    blobHash: second.hash,
    header: header(REVISION_2, [REVISION_1]),
    idempotencyKey: 'r2',
  });
}
