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
    // Nothing is deleted any more: the superseded revision is REPORTED as
    // reclaimable but its row, its ancestry and its event stay put, because the
    // commit-time parent lookup and the event log both still need them.
    expect(compacted).toEqual({
      compactable: true,
      removedRevisions: 0,
      reclaimableRevisions: 1,
    });
    expect(
      fixture.repository.listEvents(VAULT_A, 0, 10).map((event) => event.revisionId),
    ).toEqual([REVISION_1, REVISION_2]);
    // Heads are unchanged by compaction: only the current head is a head.
    expect(
      fixture.repository.listHeadEvents(VAULT_A, 0, 10).map((event) => event.revisionId),
    ).toEqual([REVISION_2]);
  });

  /**
   * Compaction must not make the ordinary (non-snapshot) log unusable.
   *
   * `vault_events.revision_id` is `ON DELETE CASCADE`, so deleting a superseded
   * revision also deletes its event row, while `next_server_sequence` is left
   * alone. The vault then advertises a cursor for sequences it can no longer
   * serve, and a client paging the log from an older cursor hits a permanent
   * hole: the runner's contiguity gate stops at the gap and the cursor never
   * advances past it, so that device stops receiving anything at all.
   */
  it('leaves the ordinary event log contiguous for a device still paging it', async () => {
    const fixture = await makeFixture();
    const blobStore = new BlobStore(
      join(temporaryDirectories[temporaryDirectories.length - 1] ?? '', 'blobs'),
    );
    await commitPair(fixture.repository, blobStore);

    recordDevicePullAck(fixture.database, DEVICE_A, 2, SERVER_TIME);
    recordDevicePullAck(fixture.database, DEVICE_B, 2, SERVER_TIME);
    compactIfAllDevicesCaughtUp(fixture.database, fixture.repository, VAULT_A);

    const cursor = fixture.repository.getCursor(VAULT_A);
    const fromZero = fixture.repository.listEvents(VAULT_A, 0, 10);
    const sequences = fromZero.map((event) => event.serverSequence);

    // A device at cursor 0 must be able to walk to the advertised head without
    // a gap; the contiguity gate refuses to skip a missing sequence.
    expect(sequences[0]).toBe(1);
    for (let index = 1; index < sequences.length; index += 1) {
      expect(sequences[index]).toBe((sequences[index - 1] ?? 0) + 1);
    }
    expect(sequences[sequences.length - 1]).toBe(cursor);
  });

  /**
   * Compaction must not delete a revision another device still names as its
   * parent. The schema declares `revision_parents.parent_revision_id` as
   * `ON DELETE RESTRICT` for exactly this reason; compaction clears that table
   * first and deletes anyway. A device whose head was superseded by a peer then
   * pushes a revision whose parent no longer exists and is rejected with
   * MISSING_PARENT forever, so its edits never leave the device.
   */
  it('keeps a superseded revision that a peer may still push onto', async () => {
    const fixture = await makeFixture();
    const blobStore = new BlobStore(
      join(temporaryDirectories[temporaryDirectories.length - 1] ?? '', 'blobs'),
    );
    await commitPair(fixture.repository, blobStore);

    recordDevicePullAck(fixture.database, DEVICE_A, 2, SERVER_TIME);
    recordDevicePullAck(fixture.database, DEVICE_B, 2, SERVER_TIME);
    compactIfAllDevicesCaughtUp(fixture.database, fixture.repository, VAULT_A);

    // DEVICE_B was still on REVISION_1 when the peer committed REVISION_2.
    // Its next edit parents on REVISION_1, which must still be resolvable.
    const third = await blobStore.put(Buffer.from('v3'));
    const commit = fixture.repository.commitRevision({
      actor: { deviceId: DEVICE_B, memberId: MEMBER_A },
      blobHash: third.hash,
      header: {
        expectedDeviceId: DEVICE_B,
        expectedMemberId: MEMBER_A,
        fileId: FILE_A,
        parentRevisionIds: [REVISION_1],
        payloadEncoding: 'plaintext-json-v1' as const,
        protocol: PROTOCOL_VERSION,
        revisionId: '60000000-0000-4000-8000-000000000003',
        semantics: SEMANTICS,
        vaultId: VAULT_A,
      },
      idempotencyKey: '70000000-0000-4000-8000-000000000003',
    });

    await expect(commit).resolves.toBeDefined();
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
