import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PROTOCOL_VERSION, type ProtectedRevisionHeader } from '@havemind/protocol';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { sweepOrphanedBlobs } from './blob-gc.js';
import { BlobStore } from './blob-store.js';
import { openDatabase } from './db.js';
import { runMigrations } from './migrations.js';
import { RevisionRepository } from './revision-repository.js';

const START_TIME = '2026-07-18T03:00:00.000Z';

const USER_A = '70000000-0000-4000-8000-0000000000a1';
const DEVICE_A = '70000000-0000-4000-8000-0000000000a2';
const VAULT_A = '70000000-0000-4000-8000-0000000000a3';
const MEMBERSHIP_A = '70000000-0000-4000-8000-0000000000a4';
const FILE_A = '70000000-0000-4000-8000-0000000000a5';
const REVISION_1 = '70000000-0000-4000-8000-000000000001';

const SEMANTICS = Object.freeze({
  pathNormalization: 'nfc-lowercase-v1',
  payloadFormat: 'revision-payload-v1',
  provenanceRecipe: 'source-range-v1',
  syncSemantics: 'dag-cas-v1',
} as const);

const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

interface Fixture {
  readonly database: Database.Database;
  readonly blobStore: BlobStore;
  readonly revisions: RevisionRepository;
}

function makeFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'havemind-blob-gc-'));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, 'havemind.sqlite'));
  databases.push(database);
  runMigrations(database);

  const now = (): Date => new Date(START_TIME);
  const blobStore = new BlobStore(join(directory, 'blobs'));
  const revisions = new RevisionRepository(database, blobStore, { now });

  database
    .prepare(
      `INSERT INTO users (id, display_name, is_instance_owner, status, created_at, revoked_at)
       VALUES (?, ?, 0, 'active', ?, NULL)`,
    )
    .run(USER_A, 'Alice', START_TIME);
  database
    .prepare(
      `INSERT INTO devices (id, user_id, display_name, public_key, status, created_at, approved_at, revoked_at)
       VALUES (?, ?, ?, ?, 'approved', ?, ?, NULL)`,
    )
    .run(DEVICE_A, USER_A, 'Alice Laptop', Buffer.alloc(32, 0x11), START_TIME, START_TIME);
  database
    .prepare(
      `INSERT INTO vaults (id, display_name, write_epoch, next_server_sequence, created_at, deleted_at)
       VALUES (?, ?, 0, 1, ?, NULL)`,
    )
    .run(VAULT_A, 'Vault A', START_TIME);
  database
    .prepare(
      `INSERT INTO memberships (id, vault_id, user_id, role, status, created_at, revoked_at)
       VALUES (?, ?, ?, 'owner', 'active', ?, NULL)`,
    )
    .run(MEMBERSHIP_A, VAULT_A, USER_A, START_TIME);

  return { blobStore, database, revisions };
}

function header(): ProtectedRevisionHeader {
  return {
    expectedDeviceId: DEVICE_A,
    expectedMemberId: MEMBERSHIP_A,
    fileId: FILE_A,
    parentRevisionIds: [],
    payloadEncoding: 'plaintext-json-v1',
    protocol: PROTOCOL_VERSION,
    revisionId: REVISION_1,
    semantics: SEMANTICS,
    vaultId: VAULT_A,
  };
}

describe('sweepOrphanedBlobs', () => {
  it('removes only blobs no committed revision references, preserving referenced blobs and their revisions', async () => {
    const fixture = makeFixture();

    const keptBytes = Buffer.from('kept-content', 'utf8');
    const keptStored = await fixture.blobStore.put(keptBytes);
    await fixture.revisions.commitRevision({
      actor: { deviceId: DEVICE_A, memberId: MEMBERSHIP_A },
      blobHash: keptStored.hash,
      header: header(),
      idempotencyKey: 'k1',
    });

    // An orphaned blob left on disk with no referencing revision at all — the
    // scenario a rejected push used to (unsafely) clean up from the request
    // hot path.
    const orphanBytes = Buffer.from('orphan-content', 'utf8');
    const orphanStored = await fixture.blobStore.put(orphanBytes);

    expect(existsSync(fixture.blobStore.pathForHash(keptStored.hash))).toBe(true);
    expect(existsSync(fixture.blobStore.pathForHash(orphanStored.hash))).toBe(true);

    const result = await sweepOrphanedBlobs(fixture.database, fixture.blobStore);

    expect(result.removed).toBe(1);
    expect(existsSync(fixture.blobStore.pathForHash(orphanStored.hash))).toBe(false);
    expect(existsSync(fixture.blobStore.pathForHash(keptStored.hash))).toBe(true);

    // The committed revision referencing the kept blob is still pullable.
    const events = fixture.revisions.listEvents(VAULT_A, 0, 100);
    expect(events.map((event) => event.revisionId)).toEqual([REVISION_1]);
    await expect(fixture.blobStore.read(keptStored.hash)).resolves.toEqual(keptBytes);
  });
});
