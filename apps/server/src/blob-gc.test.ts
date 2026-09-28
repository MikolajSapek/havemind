import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { ProtectedRevisionHeader } from '@havemind/protocol';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { sweepOrphanedBlobs } from './blob-gc.js';
import { BlobStore } from './blob-store.js';
import { RevisionRepository } from './revision-repository.js';
import {
  DEVICE_A,
  makeTempDir,
  MEMBERSHIP_A,
  openMigratedDatabase,
  releaseTestResources,
  revisionHeader,
  rowSeeder,
  USER_A,
  VAULT_A,
} from './test/fixtures/server-fixtures.js';

const START_TIME = '2026-07-18T03:00:00.000Z';

const FILE_A = '70000000-0000-4000-8000-0000000000a5';
const REVISION_1 = '70000000-0000-4000-8000-000000000001';

afterEach(releaseTestResources);

interface Fixture {
  readonly database: Database.Database;
  readonly blobStore: BlobStore;
  readonly revisions: RevisionRepository;
}

function makeFixture(): Fixture {
  const directory = makeTempDir('havemind-blob-gc-');
  const database = openMigratedDatabase(directory);

  const now = (): Date => new Date(START_TIME);
  const blobStore = new BlobStore(join(directory, 'blobs'));
  const revisions = new RevisionRepository(database, blobStore, { now });

  const { insertDevice, insertMembership, insertUser, insertVault } = rowSeeder(START_TIME);
  insertUser(database, USER_A, 'Alice');
  insertDevice(database, DEVICE_A, USER_A, 'Alice Laptop');
  insertVault(database, VAULT_A, 'Vault A');
  insertMembership(database, MEMBERSHIP_A, VAULT_A, USER_A);

  return { blobStore, database, revisions };
}

function header(): ProtectedRevisionHeader {
  const author = { deviceId: DEVICE_A, membershipId: MEMBERSHIP_A };
  return revisionHeader(VAULT_A, author, REVISION_1, FILE_A);
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

    // An orphaned blob left on disk with no referencing revision at all, the
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
